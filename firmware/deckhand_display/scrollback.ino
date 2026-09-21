// ---------- Scrollback: board 2's scrolling transcript ----------
// ONE #if wraps the whole file, so board 1 never sees the TEXT of any of this -
// the same reason `#if !BOARD_USES_TFT_ESPI` wraps every tft.flush() site rather
// than a runtime no-op existing. A runtime guard would move board 1's binary.
#if BOARD_HISTORY_SCROLL

struct ScrollEntry {
  uint32_t off;        // byte offset into scrollText
  uint32_t lineFirst;  // cumulative line index of this entry's first line
  uint16_t lines;      // wrapped lines, NOT counting the spacer
  uint8_t  role;       // 0 you, 1 claude, 2 ran, 3 result, 4 denied/error
  uint8_t  spacer;     // 1 if a blank line follows this entry
};                     // 12 bytes

char*        scrollText = nullptr;     // PSRAM
ScrollEntry* scrollIdx  = nullptr;     // PSRAM
int      scrollCount = 0;              // entries held
uint32_t scrollTextUsed = 0;
uint32_t scrollTotalLines = 0;
int      scrollTotal = 0;              // entries in the whole filtered history
int      scrollDropped = 0;            // withheld at the head to fit the budget
// What is currently LOADED, so a repeat request for the same thing is answered
// from PSRAM instead of re-downloading 108KB. Not merely an optimisation: the
// trigger-file path delivers a command twice, the first copy's fetch finishes in
// about two seconds, and the second copy then re-requested - only for the host's
// own duplicate-request dedup to swallow it, leaving the device sat in `pending`
// for the full 20s timeout and then reporting "could not reach the Mac" over a
// transcript it already had. Observed exactly that way.
// Live tail state. scrollNewBelow counts entries that arrived while the view was
// held away from the bottom - the ONLY thing that may not be silently discarded,
// because holding position means the reader is not looking at where they landed.
unsigned long scrollTailPolledAt = 0;
int scrollNewBelow = 0;
char scrollLoadedId[16] = "";
bool scrollLoadedChat = true;
// TRUE when the CURRENTLY OPEN transcript was reached through scrollOpenById()
// rather than openScrollback() - a PROJECTS level-2 row, whose id may not be
// (and, for the whole point of that entry point, very often is not) in
// sessions[] at all. Read by drawScrollback() (there is no
// sessions[detailIndex] to draw a title from), by exitScrollback() (there is
// no SESSIONS detail card to return to - PROJECTS level 2 is), by
// scrollRefetch() (detailIndex names the wrong session to re-ask for), and by
// the RESUME command's own guard (deckhand_display.ino) - see scrollProjLive.
bool scrollFromProjects = false;
// Set by the CALLER, IMMEDIATELY BEFORE scrollOpenById() - projOpenKey's own
// precedent (projects.ino): scrollOpenById()'s two-argument signature has no
// room for a third fact its caller already knows (PSessInfo.live, the wire's
// own bit), so the caller states it here rather than scrollOpenById() trying
// to re-derive it from nothing. DEFAULTS TRUE - "assume live" - so a caller
// that forgets to set it gets RESUME refused rather than silently offered on
// a session somebody may be driving interactively right now (the design's
// own warning: a headless run would become a SECOND, concurrent author of
// it). The safe direction for a flag nobody remembered to set.
bool scrollProjLive = true;
// The header's title when scrollFromProjects is true - sessions[detailIndex].name
// has no meaning for an id sessions[] does not hold. Sized to PSessInfo.title's
// own shape (host caps at 40, +NUL, +3 spare) - the same margin every other
// fixed buffer here keeps past its measured worst case.
char scrollProjTitle[48] = "";

const char* scrollMark(uint8_t r) {
  // ASCII ONLY. Claude Code's own markers are U+23FA and U+257C, and Spleen
  // declares 0x20..0x7E - an out-of-range codepoint draws NOTHING and advances
  // NOTHING, which is the trap this repo has paid for repeatedly (fitText's
  // ellipsis, the CLAUDE/air separator, the PAIRED MACS dot, the SETTINGS HOME
  // chevron, histFlatten's own truncation marker). Distinct SHAPES, so the
  // meaning does not rest on hue.
  switch (r) {
    case 0:  return ">";   // you
    case 1:  return "*";   // claude
    case 2:  return "$";   // ran a tool
    case 3:  return "|";   // its result
    default: return "!";   // denied / error
  }
}

uint16_t scrollMarkColor(uint8_t r) {
  switch (r) {
    case 0:  return COLOR_ACCENT;
    case 1:  return COLOR_GOOD;
    case 4:  return COLOR_BAD;
    default: return COLOR_LABEL;
  }
}
uint16_t scrollTextColor(uint8_t r) {
  return (r == 0 || r == 1) ? COLOR_VALUE : (r == 4 ? COLOR_BAD : COLOR_LABEL);
}

// ONE WALKER, DRIVEN BY BOTH THE COUNTER AND THE EXTRACTOR. The wrapped line
// count is computed once at append and never re-derived, so if these two used
// different rules the index would say one thing and the screen would draw
// another - text jumping as you scroll, with nothing to point at.
//
// It is FENCE-AWARE because code and prose wrap differently and must:
//   prose  - word-friendly break, the same rule the shared wrapLineLen uses
//   code   - HARD break at the column, because breaking a program at spaces is
//            wrong and it destroys the indentation you read code by
// MONOSPACE is what makes this exact integer arithmetic with no width call:
// every Spleen glyph in 0x20..0x7E has xOffset 0, width 8 and xAdvance 8.
//
// A ``` fence line toggles the mode and draws NOTHING - it consumes no row, so a
// three-line code block costs three rows rather than five.
#define SCROLL_F_CODE 0x1
#define SCROLL_F_CONT 0x2
#define SCROLL_F_HEAD 0x4
#define SCROLL_F_HEADEND 0x8
#define SCROLL_F_LANG 0x10

// THE WIDTH OF A LIST MARKER at the start of a source line, or 0 for a line that
// is not a list item. `* ` and `- ` are two; an ordered marker is its digits plus
// ". ". Leading spaces are counted in, so a nested item hangs to ITS OWN text
// column rather than to the outer list's.
static int scrollListHang(const char* s, int len) {
  int i = 0;
  while (i < len && s[i] == ' ') i++;
  if (i + 1 < len && (s[i] == '*' || s[i] == '-') && s[i + 1] == ' ') return i + 2;
  int d = i;
  while (d < len && s[d] >= '0' && s[d] <= '9') d++;
  if (d > i && d + 1 < len && s[d] == '.' && s[d + 1] == ' ') return d + 2;
  return 0;
}

// WHERE A SPACELESS TOKEN MAY BE BROKEN. The word-wrap scans back for a space and
// gives up past half the lane - and a path or a URL has no space in it at all, so
// it fell through to a hard cut that landed mid-word. These four are where a
// reader's eye already expects a seam, and the character STAYS on the row it ends,
// so the break reads as deliberate rather than as a dropped character.
static bool scrollBreakAfter(char c) {
  return c == '/' || c == '.' || c == '-' || c == '_';
}

static int scrollWalk(const char* t, int cols, int want,
                      char* out, int outSize, uint8_t* flags, int* indent, bool* found) {
  if (found) *found = false;
  if (!t[0]) {                                  // an empty entry still owns a row
    if (want == 0 && out && outSize > 0) { out[0] = '\0'; if (flags) *flags = 0; if (indent) *indent = 0; if (found) *found = true; }
    return 1;
  }
  int pos = 0, drawn = 0;
  bool inCode = false;
  while (t[pos]) {
    int eol = pos;
    while (t[eol] && t[eol] != '\n') eol++;
    const int srcLen = eol - pos;

    // A fence toggles the mode. It draws NOTHING unless it is an OPENING fence
    // that names a language, in which case that name is one dim row above the
    // block. A bare fence costs exactly what it costs today.
    if (srcLen >= 3 && t[pos] == '`' && t[pos + 1] == '`' && t[pos + 2] == '`') {
      const bool opening = !inCode;
      inCode = !inCode;
      int ln = srcLen - 3;
      if (ln > cols) ln = cols;
      if (opening && ln > 0) {
        if (drawn == want) {
          if (out && outSize > 0) {
            int cap = ln < outSize - 1 ? ln : outSize - 1;
            memcpy(out, t + pos + 3, cap);
            out[cap] = '\0';
          }
          if (flags) *flags = SCROLL_F_CODE | SCROLL_F_LANG;
          if (indent) *indent = 0;
          if (found) *found = true;
          return drawn + 1;
        }
        drawn++;
      }
      pos = t[eol] ? eol + 1 : eol;
      continue;
    }

    // A heading keeps its text and loses its markers - the device styles it
    // rather than the Mac, so the wire stays self-describing.
    const bool head = !inCode && srcLen > 0 && t[pos] == '#';
    int off = 0;
    if (head) {
      while (off < srcLen && t[pos + off] == '#') off++;
      while (off < srcLen && t[pos + off] == ' ') off++;
    }

    int q = pos + off, rem = srcLen - off;
    bool first = true;
    // THE HANGING INDENT, decided ONCE per source line and applied to every row
    // after the first. Code hangs to its own leading whitespace plus one, so a
    // wrapped row cannot be read as a real line at that depth. A list item hangs
    // to its marker's width, so a wrapped bullet's second row does not start at
    // the same column as its `*` - the cap below applies to both arms.
    int hang = 0;
    if (inCode) {
      int lead = 0;
      while (lead < srcLen && t[pos + lead] == ' ') lead++;
      hang = lead + 1;
    } else {
      hang = scrollListHang(t + pos, srcLen);
    }
    if (hang > SCROLL_HANG_MAX) hang = SCROLL_HANG_MAX;
    do {
      const int room = cols - (first ? 0 : hang);
      int n;
      if (rem <= room) n = rem;
      else if (inCode) n = room;                // HARD
      else {
        n = room;
        int b = n;
        while (b > room / 2 && t[q + b - 1] != ' ') b--;
        if (b > room / 2) n = b;                // word-friendly
        else {
          // NO SPACE IN THE LANE AT ALL. Rather than hard-cut mid-word, look for
          // a seam - and only then give up.
          int c2 = room;
          while (c2 > room / 2 && !scrollBreakAfter(t[q + c2 - 1])) c2--;
          if (c2 > room / 2) n = c2;
        }
      }
      if (n <= 0 && rem > 0) n = 1;             // never stall
      if (drawn == want) {
        if (out && outSize > 0) {
          int cap = n < outSize - 1 ? n : outSize - 1;
          memcpy(out, t + q, cap);
          out[cap] = '\0';
        }
        // THE LAST ROW OF THIS SOURCE LINE, decided from what is left AFTER this
        // row takes its share - the only point at which the answer is knowable.
        const bool last = (rem - n) <= 0;
        if (flags) *flags = (inCode ? SCROLL_F_CODE : 0)
                          | (first ? 0 : SCROLL_F_CONT)
                          | (head ? SCROLL_F_HEAD : 0)
                          | ((head && last) ? SCROLL_F_HEADEND : 0);
        if (indent) *indent = first ? 0 : hang;
        if (found) *found = true;
        return drawn + 1;                       // caller only reads this when counting
      }
      drawn++;
      q += n; rem -= n; first = false;
      if (!inCode) while (rem > 0 && t[q] == ' ') { q++; rem--; }
    } while (rem > 0);

    pos = t[eol] ? eol + 1 : eol;
  }
  return drawn ? drawn : 1;
}

// DELIBERATELY NOT countWrappedLines(). That helper stops at 80 lines and its
// wrapLineLen carries a `char buf[64]` capped at 60 characters, so a 4000-byte
// entry - well over a hundred lines here - cannot pass through it at all.
// Raising either would move board 1's binary for a board-2 feature.
int scrollWrapLines(const char* t, int cols) {
  return scrollWalk(t, cols, -1, nullptr, 0, nullptr, nullptr, nullptr);
}

// The `want`-th DRAWN line of `t`, with what kind of line it is. O(lines) per
// call, so drawing the last line of a long entry walks it - a few thousand
// iterations of a trivial loop per frame, nothing beside one flush.
bool scrollLineAt(const char* t, int cols, int want, char* out, int outSize,
                  uint8_t* flags, int* indent) {
  bool found = false;
  scrollWalk(t, cols, want, out, outSize, flags, indent, &found);
  if (!found && out && outSize > 0) out[0] = '\0';
  return found;
}

void scrollReset() {
  scrollNewBelow = 0;
  // scrollLoadedId is deliberately NOT cleared here: reset runs at the START of
  // each chunked fetch (seq 0) for the session we are loading, and clearing it
  // would make the "already held" check above unable to see its own load. It is
  // cleared by scrollEnd(), which is where the store genuinely stops existing.
  scrollCount = 0;
  scrollTextUsed = 0;
  scrollTotalLines = 0;
  scrollTotal = 0;
  scrollDropped = 0;
}

bool scrollBegin() {
  if (scrollText && scrollIdx) { scrollReset(); return true; }
  scrollText = (char*) heap_caps_malloc(SCROLL_TEXT_BYTES, MALLOC_CAP_SPIRAM);
  scrollIdx  = (ScrollEntry*) heap_caps_malloc(
      (size_t) SCROLL_MAX_ENTRIES * sizeof(ScrollEntry), MALLOC_CAP_SPIRAM);
  if (!scrollText || !scrollIdx) {
    // Report the cause. From the Mac a failed allocation and a failed fetch look
    // identical, which is the class POWERPROBE's `not on battery` refusal exists for.
    sendLineToHost("SCROLL allocfail");
    scrollEnd();
    return false;
  }
  scrollReset();
  return true;
}

void scrollEnd() {
  scrollLoadedId[0] = '\0';        // the store is gone; it holds nothing
  if (scrollText) { heap_caps_free(scrollText); scrollText = nullptr; }
  if (scrollIdx)  { heap_caps_free(scrollIdx);  scrollIdx  = nullptr; }
  scrollReset();
}

const char* scrollTextAt(int i) { return scrollText + scrollIdx[i].off; }

bool scrollAppend(uint8_t role, const char* t) {
  if (!scrollText || !scrollIdx) return false;
  if (scrollCount >= SCROLL_MAX_ENTRIES) return false;
  int len = strlen(t);
  if (scrollTextUsed + (uint32_t) len + 1 > (uint32_t) SCROLL_TEXT_BYTES) return false;

  ScrollEntry& e = scrollIdx[scrollCount];
  e.off = scrollTextUsed;
  char* dst = scrollText + scrollTextUsed;
  // Blank every control byte EXCEPT '\n', the same sanitiser the ask detail uses,
  // so a code block keeps its structure if the host ever stops flattening.
  for (int k = 0; k < len; k++)
    dst[k] = ((uint8_t) t[k] < 0x20 && t[k] != '\n') ? ' ' : t[k];
  dst[len] = '\0';
  scrollTextUsed += (uint32_t) len + 1;

  e.role = role;
  // A TOOL ROW IS CLIPPED TO ONE LINE, SO IT RESERVES ONE LINE. Both draw paths
  // paint only row 0 for role >= 2 (`if (k > 0) continue;`), but this reserved the
  // entry's FULL wrapped height, so every row after the first was reserved by the
  // index and drawn by nobody - blank. Invisible under CHAT, which excludes these
  // roles at the fetch level; under ALL it was most of the screen. Measured over a
  // real 4656-entry transcript: 92658 of 124912 reserved rows blank, 74.2%, with
  // one `out` entry reserving 204 rows to draw one - 7.6 screens of black.
  e.lines = (role >= 2) ? 1 : (uint16_t) scrollWrapLines(dst, SCROLL_COLS);
  e.spacer = 0;                              // the last entry has no trailing blank
  if (scrollCount == 0) {
    e.lineFirst = 0;
  } else {
    ScrollEntry& p = scrollIdx[scrollCount - 1];
    // The PREVIOUS entry's spacer is decided here, before this entry's lineFirst
    // is computed from it - which is what makes a streaming append correct.
    p.spacer = (p.role == 2 && role == 3) ? 0 : 1;
    e.lineFirst = p.lineFirst + p.lines + p.spacer;
  }
  scrollCount++;
  scrollTotalLines = e.lineFirst + e.lines;
  return true;
}

// The entry whose line range contains `line`. O(log n), so a frame never
// re-wraps from the top of the transcript.
int scrollEntryAtLine(uint32_t line) {
  int lo = 0, hi = scrollCount - 1, best = 0;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (scrollIdx[mid].lineFirst <= line) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

bool scrollActive = false;        // the transcript owns the screen
bool scrollPending = false;       // a fetch is in flight
bool scrollFetchFailed = false;
int  scrollNextSeq = 0;
int  scrollChunksOf = 1;
int  scrollChunksIn = 0;
unsigned long scrollFetchStart = 0;
// The link the fetch was requested on. The ACK is addressed to it rather than
// broadcast: a stray ack reaching the other Mac would be a line it never awaited.
uint8_t scrollHostSlot = 0;
uint32_t scrollY = 0;             // pixel scroll offset from the top of the transcript
int scrollTapX = 0;                // sx carried from PRESS to release, for the rail tap

// THE SHARED CORE of every scrollback fetch - requestScrollback() (a
// sessions[] index, addressed to that session's OWN Mac) and scrollOpenById()
// (any id, BROADCAST - see that function's own note on why) each build one
// call to this rather than duplicating the busy guard, the "already held in
// PSRAM" cache check and the wire line itself. `broadcast` selects
// sendLineToHost's one- vs two-argument form; `hostSlot` is read only when it
// is false.
void scrollFetch(const char* id, uint8_t hostSlot, bool broadcast) {
  // A SECOND REQUEST WHILE ONE IS IN FLIGHT IS A NO-OP, and this is not a
  // nicety: the host delivers every trigger-file command over BOTH transports,
  // so one SCROLLFETCH reaches loop() twice. Two fetches then interleave chunks
  // through ONE scrollNextSeq, the second chunk 0 fails the continuity check,
  // and the fetch is abandoned - observed on hardware exactly that way
  // (`SCROLL: seq 0, expected 1`). Same defect POWERPROBE already documents,
  // and the same answer: re-issuing reports progress rather than restarting.
  if (scrollPending) {
    // Via sendLineToHost, NOT Serial.printf: with the cable out Serial reaches
    // NOTHING, and a BLE-only session is exactly when a refusal needs to be
    // visible. Same reason BATT goes through this helper.
    char m[80];
    snprintf(m, sizeof(m), "SCROLL busy chunks=%d/%d ms=%lu",
             scrollChunksIn, scrollChunksOf, millis() - scrollFetchStart);
    sendLineToHost(m);
    return;
  }
  // Already held: answer from PSRAM. The filter is part of the identity because
  // CHAT and ALL are different entry sets, so a toggle must genuinely re-fetch.
  if (scrollCount > 0 && histChatOnly == scrollLoadedChat &&
      strcmp(scrollLoadedId, id) == 0) {
    char m[64];
    snprintf(m, sizeof(m), "SCROLL held entries=%d", scrollCount);
    sendLineToHost(m);
    scrollPending = false;
    scrollFetchFailed = false;
    return;
  }
  if (!scrollBegin()) { scrollFetchFailed = true; return; }
  // BLE genuinely cannot have the whole thing: 122KB at ~666 B/s is over three
  // minutes. It gets a bounded tail and the wait is STATED, not hidden.
  const long budget = usbLinkActive() ? SCROLL_TAIL_BYTES_USB : SCROLL_TAIL_BYTES_BLE;
  scrollPending = true;
  scrollFetchFailed = false;
  scrollNextSeq = 0;
  scrollChunksIn = 0;
  scrollChunksOf = 1;
  scrollFetchStart = millis();
  scrollHostSlot = hostSlot;
  strncpy(scrollLoadedId, id, sizeof(scrollLoadedId) - 1);
  scrollLoadedId[sizeof(scrollLoadedId) - 1] = '\0';
  scrollLoadedChat = histChatOnly;
  char line[72];
  snprintf(line, sizeof(line), "HISTORY %s %s tail:%ld", id,
           histChatOnly ? "chat" : "all", budget);
  if (broadcast) sendLineToHost(line);
  else sendLineToHost(line, hostSlot);   // addressed to the session's own Mac
}

void requestScrollback(int idx) {
  if (idx < 0 || idx >= sessionCount) return;
  scrollFetch(sessions[idx].id, sessions[idx].hostSlot, false);
}

// THE RETRY/RE-FETCH THIS SCREEN'S OWN TWO CALLERS SHARE (the dead-end tap and
// the CHAT/ALL filter toggle, both in handleScrollTouch()) - requestScrollback
// (detailIndex) is WRONG here whenever scrollFromProjects is true: detailIndex
// names whichever session SESSIONS' own detail card is behind, which has no
// relationship to a PROJECTS-opened id and can even be -1 (no card open at
// all). scrollLoadedId is what THIS screen is actually showing, however it got
// opened, so it is what "re-fetch the same thing" has to mean here.
//
// AND THAT CLAIM IS NOW TRUE. It was written when only ONE caller used this:
// the dead-end tap ran its own inlined copy of the same two lines, because it
// has to call scrollEnd() first (to drop an empty store so the fetch
// re-allocates) and scrollEnd() CLEARS scrollLoadedId - so a no-argument
// refetch called afterwards would broadcast for "" and fetch nothing. A comment
// claiming a shared predicate that was not shared is worse than the duplication
// it describes (this branch's own finding, one file over), so the id became an
// ARGUMENT: the tap passes the copy it snapshotted before scrollEnd(), the
// filter toggle passes what is loaded now, and there is exactly one statement
// of "which id, addressed how".
void scrollRefetch(const char* id) {
  if (scrollFromProjects) scrollFetch(id, 0, true);
  else requestScrollback(detailIndex);
}
// An OVERLOAD, not a default argument: a default argument on a shared function
// has silently changed board 1's codegen here before, with no size change to
// notice it by (CLAUDE.md, the baseline's own story). This file is board 2 only,
// so the risk is theoretical - the habit is not.
void scrollRefetch() { scrollRefetch(scrollLoadedId); }

// Called from loop(). A stalled fetch must say so rather than leaving
// "fetching" on the glass forever.
#if BOARD_BLE_NIMBLE
// REPORTS THE NEGOTIATED ATT MTU ONCE PER LINK, so the host can size its writes
// to what the radio will actually carry. The host cannot learn this itself -
// noble reports no MTU on macOS (re-measured: `peripheral.mtu` is undefined) -
// and it has therefore always written 20-byte packets, the pre-negotiation floor
// of 23 less the 3-byte ATT header. Measured on this link with the host's chunk
// size forced by hand: 20 bytes gives 2.7 KB/s, 60 gives 5.4, and 180 gives
// 8.4 - a 3.1x difference that was being left on the table.
//
// Sent from loop() rather than onConnect: that callback runs on BTC_TASK, where
// this file's own rules forbid touching drivers, and negotiation finishes a
// little after connect, so a loop-based report catches the settled value.
uint16_t scrollMtuSent[MAX_LINKS] = {0};

void tickBleMtu() {
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!bleLinks[i].used) { scrollMtuSent[i] = 0; continue; }
    uint16_t m = ble_att_mtu(bleLinks[i].connId);
    // 0 while negotiation is still in flight; 23 is the floor and worth
    // reporting too, because it tells the host to STAY at 20 rather than guess.
    if (m == 0 || m == scrollMtuSent[i]) continue;
    scrollMtuSent[i] = m;
    char line[48];
    snprintf(line, sizeof(line), "BLEMTU link=%d mtu=%u", i, (unsigned) m);
    sendLineToHost(line);
  }
}
#endif

// ONE spelling of "is the view at the newest", read by the tail append AND by the
// indicator - a follow rule and a badge that disagreed about the bottom would
// show "3 new below" while sitting on them.
bool scrollAtBottom() {
  const uint32_t maxY = scrollMaxY();
  return scrollY + (uint32_t) SCROLL_AT_BOTTOM_PX >= maxY;
}

// Asks for anything newer than what we hold, while the transcript is open. Not
// while a fetch is in flight, not after one failed, and not on an empty store -
// in each of those the initial fetch owns the state and a tail request would
// interleave with it through the same parser.
void tickScrollTail() {
  if (!scrollActive || scrollPending || scrollFetchFailed || scrollCount == 0) return;
  // OUT OF SCOPE FOR A PROJECTS-OPENED TRANSCRIPT: detailIndex names
  // whichever session SESSIONS' own detail card is behind, not the id this
  // screen is actually showing, and sessions[detailIndex] is the wrong (or,
  // with no card open, an out-of-range) read for it. A PROJECTS-opened
  // transcript simply does not live-tail today - see this task's own report.
  if (scrollFromProjects) return;
  if (detailIndex < 0 || detailIndex >= sessionCount) return;
  if (millis() - scrollTailPolledAt < (unsigned long) SCROLL_TAIL_POLL_MS) return;
  scrollTailPolledAt = millis();
  char line[80];
  // The global index of the next entry we do NOT have: the host withheld
  // scrollDropped at the head, so our own count is not the index.
  snprintf(line, sizeof(line), "HISTORY %s %s since:%d", sessions[detailIndex].id,
           histChatOnly ? "chat" : "all", scrollDropped + scrollCount);
  sendLineToHost(line, scrollHostSlot);
}

void tickScrollFetch() {
  if (!scrollPending) return;
  const unsigned long cap = usbLinkActive() ? SCROLL_FETCH_TIMEOUT_MS : SCROLL_FETCH_TIMEOUT_BLE_MS;
  if (millis() - scrollFetchStart < cap) return;
  char m[80];
  snprintf(m, sizeof(m), "SCROLL timeout ms=%lu chunks=%d/%d",
           millis() - scrollFetchStart, scrollChunksIn, scrollChunksOf);
  sendLineToHost(m);
  scrollPending = false;
  scrollFetchFailed = true;
  if (scrollActive) drawScrollback();
}

// IS THIS SCREEN A DEAD END? A failed or empty fetch leaves nothing to scroll,
// so the body has no drag to offer and a tap on it did NOTHING - the screen said
// "could not reach the Mac" and sat there, with the only way out a 46px key in
// the corner that nothing pointed at. Reported as the device being "stuck on
// something", which it was, from the only point of view that counts.
// ONE predicate, read by the draw site and the hit test both: a control drawn
// under one condition and hit-tested under another is this codebase's classic
// defect, and pairConfirmable() is the precedent for spelling it once.
bool scrollDeadEnd() {
  return !scrollPending && (scrollFetchFailed || scrollCount == 0);
}

uint32_t scrollMaxY() {
  uint32_t total = (scrollTotalLines + SCROLL_HEAD_LINES) * CODE_LINE_H;
  uint32_t view  = (uint32_t) SCROLL_LINES * CODE_LINE_H;
  return total > view ? total - view : 0;
}

// One dim centred line, for every state that is not a transcript. Each names its
// own cause: from the Mac "there is no more history" and "I cannot fetch the rest
// here" look identical, which is the class POWERPROBE's refusal exists for.
static void scrollNote(const char* s, int y) {
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(s, tft.width() / 2, y + CODE_LINE_H / 2);
  tft.setTextDatum(TL_DATUM);
}

// THE COUNTER IS THE HEADER'S ONLY DYNAMIC FIELD, and nothing redrew it while
// scrolling: the drag loop paints the body and the rail, and drawScrollback()
// only runs when the surface opens. So it sat at whatever the first frame said -
// observed reading 123/559 while parked at line 9900 of 10234. Change-only, with
// its own cache, so a frame that does not move the entry index costs nothing.
char scrollPosCache[24] = "";

void scrollDrawCounter() {
  char cpos[24];
  if (scrollPending) snprintf(cpos, sizeof(cpos), "...");
  else if (scrollCount > 0) {
    // THE LAST VISIBLE ENTRY, NOT THE FIRST. Reporting the entry at the TOP of
    // the screen meant that scrolling to the very bottom still stopped short of
    // the total - the top of the last screen is 27 lines back, so it could only
    // reach the max if the final message happened to be taller than the whole
    // view. Reported as "scrolled to the bottom but the number did not reach the
    // max", which was exactly right. The last visible entry reads as progress
    // instead, reaches the total at the bottom, and matches the rail beside it.
    uint32_t line = scrollY / CODE_LINE_H + (uint32_t) (SCROLL_LINES - 1);
    // The head note occupies line 0 of the scroll space, so the transcript's own
    // lines start at SCROLL_HEAD_LINES - the same offset the row loop applies.
    uint32_t tline = line > (uint32_t) SCROLL_HEAD_LINES ? line - SCROLL_HEAD_LINES : 0;
    if (tline >= scrollTotalLines && scrollTotalLines) tline = scrollTotalLines - 1;
    snprintf(cpos, sizeof(cpos), "%d/%d", scrollDropped + scrollEntryAtLine(tline) + 1, scrollTotal);
  } else snprintf(cpos, sizeof(cpos), "-");
  if (strcmp(cpos, scrollPosCache) == 0) return;
  strncpy(scrollPosCache, cpos, sizeof(scrollPosCache) - 1);
  scrollPosCache[sizeof(scrollPosCache) - 1] = '\0';
  // Padded, so a shorter string cannot leave the previous one's tail behind -
  // the change-only discipline's standard hazard.
  char padded[24];
  // 14 wide: "msg 999/9999" is 12 and "no messages" is 11, both inside the
  // 22-column name lane, and padding is what stops a shorter string leaving the
  // previous one's tail behind.
  // SCROLL_POS_CHARS wide and RIGHT-aligned in its own fixed box, so the digits
  // grow leftward into the box rather than pushing the name about.
  snprintf(padded, sizeof(padded), "%*s", SCROLL_POS_CHARS, cpos);
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(padded, SCROLL_POS_X, SCROLL_HDR_TEXT_Y);
}

// The body only. Kept separate from the chrome so a scroll frame repaints just
// this - the chrome is static between fetches.
void scrollDrawBody() {
  // Cleared from just under the RULE, not from SCROLL_TOP: the 6 rows of air
  // between the rule and SCROLL_TOP belong to no one otherwise, so
  // they kept whatever the previous screen left there whenever the body was
  // redrawn without a full drawScrollback() first. Visible as a clipped line of
  // stale text under the header.
  // FROM THE SCROLLBACK'S OWN RULE. This anchored on HIST_RULE_Y - the PAGED
  // reader's 54 - which stopped bounding this header when it collapsed to one
  // 42px row, leaving rows 44..54 uncleared and holding the previous screen.
  tft.fillRect(0, SCROLL_HDR_H + 1, tft.width(), SCROLL_BOT - SCROLL_HDR_H - 1, COLOR_BG);

  // PROGRESSIVE. While a fetch is still running, draw what has ALREADY arrived
  // rather than a placeholder - the store is appended chunk by chunk, so the
  // transcript fills in as it lands and the wait stops being a blank screen.
  // Only an empty store gets the note, because then there is genuinely nothing
  // to show. This is most of what makes a multi-second fetch feel different: the
  // bytes were always arriving, they just were not being drawn.
  // NOTHING IS DRAWN UNTIL THE FETCH COMPLETES, and that reverses a change made
  // an hour earlier. Drawing progressively seemed the obvious way to make a
  // multi-second wait feel shorter - but the store grows with each of ~26 chunks,
  // so pinning to the newest re-pinned 26 times and the view JUMPED FORWARD on
  // every one. On the glass that reads as the page scrolling by itself, which is
  // worse than waiting: you cannot read moving text, and the thing you want is
  // simply the newest message. So the store fills silently and the transcript
  // appears once, already at the bottom.
  // The note carries the chunk count on BOTH transports now. It said only
  // "fetching over Bluetooth" there, from before the ACK handshake existed -
  // with acks, scrollChunksIn/Of are known on the radio too, and a wait with a
  // number on it is a different wait.
  if (scrollPending) {
    char b[40];
    snprintf(b, sizeof(b), "-- fetching %d/%d --", scrollChunksIn, scrollChunksOf);
    scrollNote(b, (SCROLL_TOP + SCROLL_BOT) / 2 - CODE_LINE_H / 2);
    return;
  }
  if (scrollDeadEnd()) {
    // The way out is NAMED. Both lines are ASCII and inside SCROLL_COLS: the
    // longest is 29 characters against 34.
    const int cy = (SCROLL_TOP + SCROLL_BOT) / 2 - CODE_LINE_H;
    scrollNote(scrollFetchFailed ? "-- could not reach the Mac --" : "-- nothing here --", cy);
    scrollNote("tap to retry,  < to go back", cy + CODE_LINE_H * 2);
    return;
  }

  const uint32_t y0 = scrollY;
  const int firstLine = (int) (y0 / CODE_LINE_H);
  const int subPx = (int) (y0 % CODE_LINE_H);

  // THE HEAD NOTE IS LINE 0 OF THE SCROLL SPACE, not something drawn on top at
  // SCROLL_TOP. Drawn on top it collided with the transcript's own first line,
  // which lands at exactly the same y when scrollY is 0 - the note was painted
  // and then immediately overwritten within the same call. As a real line it
  // scrolls away under the finger like everything else, which is also what
  // Claude Code's own scrollback does with its top-of-history marker.

  char buf[SCROLL_COLS + 2];
  uint8_t lf = 0;
  int li = 0;
  int ei = scrollEntryAtLine((uint32_t) (firstLine > 0 ? firstLine - SCROLL_HEAD_LINES : 0));
  for (int row = 0; row <= SCROLL_LINES; row++) {
    const int line = firstLine + row;
    if (line < 0 || (uint32_t) line >= scrollTotalLines + SCROLL_HEAD_LINES) break;
    const int y0row = SCROLL_TOP + row * CODE_LINE_H - subPx;
    // LINE 0 IS THE HEAD NOTE. One spelling, read by both draw paths, so the two
    // can never disagree about whether the top of the transcript says anything.
    if (line == 0) {
      if (y0row >= SCROLL_TOP && y0row < SCROLL_BOT) {
        if (scrollDropped > 0) {
          // NAME THE RIGHT CAUSE. "need USB" is only true when the BLE budget is
          // what cut them; on USB the limit is the store, and 102 entries were
          // dropped on a cabled fetch - so the first version of this line said
          // "need USB" while the cable was plugged in, which is simply false.
          // Caught by reading a screenshot of the top of history.
          char hb[44];
          snprintf(hb, sizeof(hb), "-- %d older %s --", scrollDropped,
                   usbLinkActive() ? "not kept" : "need USB");
          scrollNote(hb, y0row);
        } else {
          scrollNote("-- start of history --", y0row);
        }
      }
      continue;
    }
    const int tline = line - SCROLL_HEAD_LINES;
    // Advance to the entry owning this line. The index makes this a walk of at
    // most one entry per row rather than a search per row.
    while (ei + 1 < scrollCount && scrollIdx[ei + 1].lineFirst <= (uint32_t) tline) ei++;
    const ScrollEntry& e = scrollIdx[ei];
    const int k = tline - (int) e.lineFirst;
    if (k >= e.lines) continue;                      // the spacer: draw nothing

    const int y = SCROLL_TOP + row * CODE_LINE_H - subPx;
    // The bottom edge is clipped at the CALL SITE. pushImage clips a negative y
    // correctly by offsetting its source pointer, but drawString clips only to
    // the SCREEN, so without this a line at the edge spills into the bottom air.
    // THE TOP EDGE, and it was missed while the bottom one was commented as
    // handled. A partial first line starts at SCROLL_TOP - subPx, up to 15 rows
    // ABOVE the list, and drawString clips only to the SCREEN - so it painted
    // over the header and the rule. Seen as a clipped line of text under the
    // name. A line is drawn only when it starts inside the list; the cost is a
    // sliver of background at the top mid-drag, which reads as the transcript
    // sliding under the header rather than as text cut in half over it.
    if (y < SCROLL_TOP) continue;
    // THE BOTTOM EDGE, CLIPPED THE SAME WAY THE TOP ALREADY IS. A break on
    // `y >= SCROLL_BOT` lets a line STARTING at 475 paint down to 490, and
    // drawString clips only to the SCREEN - so it painted into the 4px bottom
    // air, which no clear here ever wipes. Reported as an afterimage along the
    // bottom, and it accumulated because every drag frame added more. A line is
    // now drawn only if it fits WHOLLY inside the body.
    if (y + CODE_LINE_H > SCROLL_BOT) break;


    // Roles 2/3/4 are one line, clipped with THREE ASCII DOTS - never U+2026,
    // which is outside Spleen's range and would give a truncated line no visible
    // sign that anything was missing.
    if (e.role >= 2) {
      if (k > 0) continue;
      // `lf` AND `li` ARE DECLARED OUTSIDE THIS LOOP, so a row that does not set
      // them keeps the PREVIOUS row's. A tool row after a code row was inheriting
      // SCROLL_F_CODE and being painted on the card ground - reachable whenever a
      // message ends in a code block and the next entry is the call it describes.
      lf = 0;
      li = 0;
      const char* t = scrollTextAt(ei);
      int n = strlen(t);
      if (n > SCROLL_COLS) {
        memcpy(buf, t, SCROLL_COLS - 3);
        buf[SCROLL_COLS - 3] = '\0';
        strcat(buf, "...");
      } else {
        strncpy(buf, t, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';
      }
    } else {
      scrollLineAt(scrollTextAt(ei), SCROLL_COLS, k, buf, sizeof(buf), &lf, &li);
    }

    // CODE SITS ON A PANEL, the treatment ask details already give code - and it
    // is painted BEFORE the text, because drawString's own background is opaque
    // and would cut a hole in a panel drawn after it. Full-lane rather than
    // text-width: a ragged right edge would not read as a block.
    const bool isCode = (lf & SCROLL_F_CODE) != 0;
    const uint16_t bg = isCode ? COLOR_CARD : COLOR_BG;
    if (isCode) {
      tft.fillRect(SCROLL_GUT_X, y, SCROLL_RAIL_X - SCROLL_RAIL_AIR - SCROLL_GUT_X,
                   CODE_LINE_H, COLOR_CARD);
      // THE BLOCK'S OWN EDGE, which a per-row fill cannot be. COLOR_LABEL because
      // this is structure and accent already carries five jobs here. No top or
      // bottom flag is needed: a block is always separated from what surrounds it
      // by a blank or a prose row, so the bar breaks by itself.
      tft.fillRect(SCROLL_CODE_EDGE_X, y, SCROLL_CODE_EDGE_W, CODE_LINE_H, COLOR_LABEL);
    }

    setUIFont(1);
    if (k == 0) {
      tft.setTextColor(scrollMarkColor(e.role), bg);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(scrollMark(e.role), SCROLL_GUT_X, y);
    } else if (isCode && (lf & SCROLL_F_CONT)) {
      // A WRAPPED CODE LINE IS MARKED, or it reads as a real line and misleads
      // about indentation - which is most of how code is read. Prose
      // continuations get none: wrapping is simply how prose reads.
      tft.setTextColor(COLOR_LABEL, COLOR_CARD);
      tft.setTextDatum(TL_DATUM);
      tft.drawString("+", SCROLL_GUT_X, y);
    }
    // A heading takes the accent so sections are findable while scrolling; its
    // own # markers were stripped by the walker. A LANGUAGE ROW is dim: it labels
    // the block, it is not part of it.
    const uint16_t fg = (lf & SCROLL_F_HEAD) ? COLOR_ACCENT
                      : (lf & SCROLL_F_LANG) ? COLOR_LABEL
                      : scrollTextColor(e.role);
    tft.setTextColor(fg, bg);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(buf, SCROLL_TXT_X + li * TEXT_ADV, y);
    // THE HEADING'S RULE, under its LAST row only - a rule between a wrapped
    // heading's two rows reads as two headings. COLOR_LABEL under accent text: a
    // rule is structure, and orange under orange reads as one thicker heading.
    if (lf & SCROLL_F_HEADEND)
      tft.fillRect(SCROLL_TXT_X, y + CODE_LINE_H - 2,
                   SCROLL_RAIL_X - SCROLL_RAIL_AIR - SCROLL_TXT_X, 1, COLOR_LABEL);
  }

  // NEW-BELOW BADGE, over the bottom row and only while the view is held away
  // from the newest. It costs no layout because it is an overlay, it obscures one
  // line only while there is something to say, and it disappears the moment the
  // reader reaches the bottom - which is also when scrollNewBelow is cleared.
  if (scrollNewBelow > 0 && !scrollAtBottom()) {
    const int by = SCROLL_BOT - CODE_LINE_H;
    tft.fillRect(SCROLL_GUT_X, by, SCROLL_RAIL_X - SCROLL_RAIL_AIR - SCROLL_GUT_X,
                 CODE_LINE_H, COLOR_BG);
    char b[32];
    snprintf(b, sizeof(b), "-- %d new below --", scrollNewBelow);
    setUIFont(1);
    tft.setTextColor(COLOR_ACCENT, COLOR_BG);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(b, (SCROLL_GUT_X + SCROLL_RAIL_X - SCROLL_RAIL_AIR) / 2, by + CODE_LINE_H / 2);
    tft.setTextDatum(TL_DATUM);
  }

  // THE RAIL, drawn only when there is more than a screenful - so a three-message
  // session shows none. It replaces a 46px scrubber band with 4px of ink, and it
  // is the only thing that answers "how much is above me" continuously.
  const uint32_t maxY = scrollMaxY();
  if (maxY > 0) {
    const int h = SCROLL_BOT - SCROLL_TOP;
    tft.fillRect(SCROLL_RAIL_X, SCROLL_TOP, SCROLL_RAIL_W, h, COLOR_CARD);
    int kh = (int) ((long) h * h / (long) (scrollTotalLines * CODE_LINE_H));
    if (kh < 24) kh = 24;
    int ky = SCROLL_TOP + (int) ((long) (h - kh) * y0 / maxY);
    tft.fillRect(SCROLL_RAIL_X, ky, SCROLL_RAIL_W, kh, COLOR_ACCENT);
  }
}

// Draws only the band of rows a scrollRect() shift newly exposed, plus the
// rail - which the shift moved and which cannot be shifted correctly in
// place, being one 4px-wide position indicator rather than per-line content.
// `shift` is scrollY's own delta (positive = scrolled further into the
// document, i.e. content moved UP), the same sign scrollDrawBody's caller
// would pass to scrollRect as -dy.
//
// THE SAME PER-LINE LOOP scrollDrawBody() ALREADY USES, bounded to the
// exposed band rather than the whole body - deliberately reusing its exact
// structure (same entry walk, same spacer/role/truncation handling, same
// head-note-at-the-very-top case) rather than re-deriving a tighter row
// range from the band's pixel bounds. The cheap per-row bookkeeping
// (advancing `ei`) still runs for every row, same as scrollDrawBody; only
// the expensive part - the drawString calls - is skipped for rows outside
// the band, which is where the whole saving comes from.
void scrollDrawBand(int shift) {
  if (shift == 0) return;
  const int n = shift > 0 ? shift : -shift;
  const int bandY0 = shift > 0 ? (SCROLL_BOT - n) : SCROLL_TOP;
  const int bandY1 = shift > 0 ? SCROLL_BOT       : (SCROLL_TOP + n);
  tft.fillRect(0, bandY0, tft.width(), bandY1 - bandY0, COLOR_BG);

  // scrollDrawBody() covers these three states with a centred note across
  // the WHOLE body - a shift never happens without a loaded transcript to
  // drag through, but the check is kept so a banded redraw can never leave
  // stale text under a note it did not draw.
  if (scrollPending || scrollFetchFailed || scrollCount == 0) return;

  const uint32_t y0 = scrollY;
  const int firstLine = (int) (y0 / CODE_LINE_H);
  const int subPx = (int) (y0 % CODE_LINE_H);

  // The head note is line 0 of the scroll space; the shared row loop below
  // draws it, so there is ONE spelling of it rather than a copy per path.

  char buf[SCROLL_COLS + 2];
  uint8_t lf = 0;
  int li = 0;
  int ei = scrollEntryAtLine((uint32_t) (firstLine > 0 ? firstLine - SCROLL_HEAD_LINES : 0));
  for (int row = 0; row <= SCROLL_LINES; row++) {
    const int line = firstLine + row;
    if (line < 0 || (uint32_t) line >= scrollTotalLines + SCROLL_HEAD_LINES) break;
    const int y0row = SCROLL_TOP + row * CODE_LINE_H - subPx;
    // LINE 0 IS THE HEAD NOTE. One spelling, read by both draw paths, so the two
    // can never disagree about whether the top of the transcript says anything.
    if (line == 0) {
      if (y0row >= SCROLL_TOP && y0row < SCROLL_BOT) {
        if (scrollDropped > 0) {
          // NAME THE RIGHT CAUSE. "need USB" is only true when the BLE budget is
          // what cut them; on USB the limit is the store, and 102 entries were
          // dropped on a cabled fetch - so the first version of this line said
          // "need USB" while the cable was plugged in, which is simply false.
          // Caught by reading a screenshot of the top of history.
          char hb[44];
          snprintf(hb, sizeof(hb), "-- %d older %s --", scrollDropped,
                   usbLinkActive() ? "not kept" : "need USB");
          scrollNote(hb, y0row);
        } else {
          scrollNote("-- start of history --", y0row);
        }
      }
      continue;
    }
    const int tline = line - SCROLL_HEAD_LINES;
    while (ei + 1 < scrollCount && scrollIdx[ei + 1].lineFirst <= (uint32_t) tline) ei++;
    const ScrollEntry& e = scrollIdx[ei];
    const int k = tline - (int) e.lineFirst;
    if (k >= e.lines) continue;                      // the spacer: draw nothing

    const int y = SCROLL_TOP + row * CODE_LINE_H - subPx;
    // Bounded to the EXPOSED BAND rather than [SCROLL_TOP, SCROLL_BOT) - the
    // only difference from scrollDrawBody's identical loop.
    // TWO SEPARATE TESTS, and conflating them is what made the body path and this
    // one disagree. The BAND test says "is this line in the region the shift
    // exposed" - a line straddling bandY0 when scrolling DOWN must still be
    // drawn, because its lower half is in that region while its upper half was
    // moved there correctly by the memmove. The HEADER test is the same one the
    // body path uses and must be identical to it, or the two paths render
    // different pixels and the equivalence a checksum harness proved is gone.
    if (y < SCROLL_TOP) continue;
    // THE BOTTOM EDGE, CLIPPED THE SAME WAY THE TOP ALREADY IS. A break on
    // `y >= SCROLL_BOT` lets a line STARTING at 475 paint down to 490, and
    // drawString clips only to the SCREEN - so it painted into the 4px bottom
    // air, which no clear here ever wipes. Reported as an afterimage along the
    // bottom, and it accumulated because every drag frame added more. A line is
    // now drawn only if it fits WHOLLY inside the body.
    if (y + CODE_LINE_H > SCROLL_BOT) break;
    if (y + CODE_LINE_H <= bandY0) continue;
    if (y >= bandY1) break;

    if (e.role >= 2) {
      if (k > 0) continue;
      // `lf` AND `li` ARE DECLARED OUTSIDE THIS LOOP, so a row that does not set
      // them keeps the PREVIOUS row's. A tool row after a code row was inheriting
      // SCROLL_F_CODE and being painted on the card ground - reachable whenever a
      // message ends in a code block and the next entry is the call it describes.
      lf = 0;
      li = 0;
      const char* t = scrollTextAt(ei);
      int tn = strlen(t);
      if (tn > SCROLL_COLS) {
        memcpy(buf, t, SCROLL_COLS - 3);
        buf[SCROLL_COLS - 3] = '\0';
        strcat(buf, "...");
      } else {
        strncpy(buf, t, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';
      }
    } else {
      scrollLineAt(scrollTextAt(ei), SCROLL_COLS, k, buf, sizeof(buf), &lf, &li);
    }

    // CODE SITS ON A PANEL, the treatment ask details already give code - and it
    // is painted BEFORE the text, because drawString's own background is opaque
    // and would cut a hole in a panel drawn after it. Full-lane rather than
    // text-width: a ragged right edge would not read as a block.
    const bool isCode = (lf & SCROLL_F_CODE) != 0;
    const uint16_t bg = isCode ? COLOR_CARD : COLOR_BG;
    if (isCode) {
      tft.fillRect(SCROLL_GUT_X, y, SCROLL_RAIL_X - SCROLL_RAIL_AIR - SCROLL_GUT_X,
                   CODE_LINE_H, COLOR_CARD);
      // THE BLOCK'S OWN EDGE, which a per-row fill cannot be. COLOR_LABEL because
      // this is structure and accent already carries five jobs here. No top or
      // bottom flag is needed: a block is always separated from what surrounds it
      // by a blank or a prose row, so the bar breaks by itself.
      tft.fillRect(SCROLL_CODE_EDGE_X, y, SCROLL_CODE_EDGE_W, CODE_LINE_H, COLOR_LABEL);
    }

    setUIFont(1);
    if (k == 0) {
      tft.setTextColor(scrollMarkColor(e.role), bg);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(scrollMark(e.role), SCROLL_GUT_X, y);
    } else if (isCode && (lf & SCROLL_F_CONT)) {
      // A WRAPPED CODE LINE IS MARKED, or it reads as a real line and misleads
      // about indentation - which is most of how code is read. Prose
      // continuations get none: wrapping is simply how prose reads.
      tft.setTextColor(COLOR_LABEL, COLOR_CARD);
      tft.setTextDatum(TL_DATUM);
      tft.drawString("+", SCROLL_GUT_X, y);
    }
    // A heading takes the accent so sections are findable while scrolling; its
    // own # markers were stripped by the walker. A LANGUAGE ROW is dim: it labels
    // the block, it is not part of it.
    const uint16_t fg = (lf & SCROLL_F_HEAD) ? COLOR_ACCENT
                      : (lf & SCROLL_F_LANG) ? COLOR_LABEL
                      : scrollTextColor(e.role);
    tft.setTextColor(fg, bg);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(buf, SCROLL_TXT_X + li * TEXT_ADV, y);
    // THE HEADING'S RULE, under its LAST row only - a rule between a wrapped
    // heading's two rows reads as two headings. COLOR_LABEL under accent text: a
    // rule is structure, and orange under orange reads as one thicker heading.
    if (lf & SCROLL_F_HEADEND)
      tft.fillRect(SCROLL_TXT_X, y + CODE_LINE_H - 2,
                   SCROLL_RAIL_X - SCROLL_RAIL_AIR - SCROLL_TXT_X, 1, COLOR_LABEL);
  }

  // The rail, repainted WHOLE - the shift moved the viewport's fraction of
  // the document, so the thumb's position changed with it, and it is one
  // indicator, not per-line content a row-bounded loop could partially redraw.
  const uint32_t maxY = scrollMaxY();
  if (maxY > 0) {
    const int h = SCROLL_BOT - SCROLL_TOP;
    tft.fillRect(SCROLL_RAIL_X, SCROLL_TOP, SCROLL_RAIL_W, h, COLOR_CARD);
    int kh = (int) ((long) h * h / (long) (scrollTotalLines * CODE_LINE_H));
    if (kh < 24) kh = 24;
    int ky = SCROLL_TOP + (int) ((long) (h - kh) * y0 / maxY);
    tft.fillRect(SCROLL_RAIL_X, ky, SCROLL_RAIL_W, kh, COLOR_ACCENT);
  }
}

void drawScrollback() {
  tft.fillScreen(COLOR_BG);

  // ONE ROW, 42px, so the body gets 27 lines instead of 26. The controls are
  // DRAWN 38px inside a 42px tap band - drawn-small/hit-big, the split the
  // settings steppers and the TYPE chip already use.
  uiStrokeRound(SCROLL_BACK_X, SCROLL_CTRL_Y, SCROLL_BACK_W, SCROLL_CTRL_H, 3,
                BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("<", SCROLL_BACK_X + SCROLL_BACK_W / 2, SCROLL_CTRL_Y + SCROLL_CTRL_H / 2);
  tft.setTextDatum(TL_DATUM);

  const char* chip = histChatOnly ? "CHAT" : "ALL";
  int chipW = histChatOnly ? HIST_CHIP_W_CHAT : HIST_CHIP_W_ALL;
  int chipX = tft.width() - 12 - chipW;
  uiFillRound(chipX, SCROLL_CTRL_Y, chipW, SCROLL_CTRL_H, 3, COLOR_ACCENT, COLOR_BG);
  setUIFont(1);
  tft.setTextColor(COLOR_BG, COLOR_ACCENT);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(chip, chipX + chipW / 2, SCROLL_CTRL_Y + SCROLL_CTRL_H / 2);
  tft.setTextDatum(TL_DATUM);

  // The counter's box is FIXED and right-aligned, and the name is fitText'd into
  // what is left - the same order the detail card's meta line uses, and the
  // reason is the same: a change-only field that MOVES cannot be cached, so the
  // fixed-width one is measured first and the flexible one takes the remainder.
  // scrollProjTitle WHEN THIS CAME FROM PROJECTS - sessions[detailIndex].name
  // has no meaning for an id sessions[] does not hold, and detailIndex itself
  // can be stale or -1 here (scrollFromProjects's own header note).
  if (scrollFromProjects || (detailIndex >= 0 && detailIndex < sessionCount)) {
    const int nameW = SCROLL_POS_X - 8 - SCROLL_NAME_X;
    char nm[SCROLL_NAME_COLS + 6];
    // setUIFont BEFORE fitText: it measures with tft.textWidth, so the font has
    // to be the one the string will actually be drawn in.
    setUIFont(1);
    fitText(nm, sizeof(nm), scrollFromProjects ? scrollProjTitle : sessions[detailIndex].name, nameW);
    tft.setTextColor(COLOR_VALUE, COLOR_BG);
    tft.drawString(nm, SCROLL_NAME_X, SCROLL_HDR_TEXT_Y);
  }

  // ONE spelling of the counter, shared with the drag loop's per-frame update.
  scrollPosCache[0] = '\0';        // header just repainted, so force a draw
  scrollDrawCounter();

  tft.drawFastHLine(0, SCROLL_HDR_H, tft.width(), COLOR_LABEL);
  scrollDrawBody();
  tft.flush();
}

// A BLOCKING loop, the pattern micMonitor, micStream and (on board 1)
// runCalibration already use - chosen over extending handleTouch() for two
// reasons. The runCalibration half of that precedent is BOARD 1'S: this file is
// board 2 only and no runCalibration() is compiled here, so the pattern is cited
// from the shared files rather than from anything this board can call. handleTouch() is
// SHARED CODE and returns immediately on `touching && wasTouching` ("a finger
// still down has nothing left to do"), so putting drag state there risks board
// 1's binary for a board-2 feature. And the precedent already exists three times.
// The first drawn line that is CODE, or -1. Walks the index rather than the
// text, so it is O(entries) plus one wrap per entry, and it exists so a fenced
// block can actually be LOOKED at - 13 of 512 messages in a real transcript
// carry one, so blind sampling finds prose almost every time.
long scrollFindCode() {
  char tmp[SCROLL_COLS + 2];
  uint8_t f = 0;
  int fi = 0;
  for (int i = 0; i < scrollCount; i++) {
    const ScrollEntry& e = scrollIdx[i];
    for (int k = 0; k < e.lines; k++) {
      if (scrollLineAt(scrollTextAt(i), SCROLL_COLS, k, tmp, sizeof(tmp), &f, &fi) && (f & SCROLL_F_CODE))
        return (long) e.lineFirst + k + SCROLL_HEAD_LINES;
    }
  }
  return -1;
}

void scrollDragLoop(int sy0) {
  // Decided ONCE from where the press landed, not re-tested per poll: a scrub
  // that changed mode because the finger drifted out of a 20px column would be
  // unusable, and the gesture's meaning should not depend on where it ends up.
  const bool onRail = scrollTapX >= SCROLL_RAIL_TAP_X;
  int lastY = sy0;
  int moved = 0;
  const uint32_t maxY = scrollMaxY();
  // Task 7's scrollRect()+scrollDrawBand() path is MEASURED faster than a full
  // recompose (60ms vs 73.7ms), and it is exactly this loop's own shape: a
  // small per-frame shift while a finger drags. scrollDrawBody() stays the
  // fallback for a shift at least a viewport tall - scrollRect saves nothing
  // there and the band would be the whole body anyway.
  const int viewH = SCROLL_BOT - SCROLL_TOP;
  while (true) {
    // drainBleRx() only runs from loop(), so for the whole drag nothing else
    // would reap a pending BLE slot - leaving the device un-advertised with no
    // log line saying why. Every existing blocking loop does this.
    reapBleLinks(true);
    // The 30s backlight blank sits well inside a drag's life, and the waking tap
    // would be swallowed rather than scrolling. The keyboard needed exactly this.
    lastActivityMillis = millis();

    int sx, sy;
    if (!getTouchPoint(sx, sy)) break;         // released: the drag is over

    // A DRAG THAT STARTED ON THE RAIL SCRUBS ABSOLUTELY, rather than moving the
    // content by the finger's delta. That is what makes 581 messages navigable:
    // dragging the body traverses one screen per gesture, so crossing a long
    // transcript took dozens, and the rail crosses all of it in one. The rail was
    // tap-only before - a jump with no way to hunt - and 4px wide, which is why
    // it read as there being no scroll bar at all.
    if (onRail && maxY > 0) {
      const int usable = (SCROLL_BOT - SCROLL_TOP) - 1;
      long f = (long) (sy - SCROLL_TOP) * (long) maxY / (usable > 0 ? usable : 1);
      uint32_t ny = (uint32_t) (f < 0 ? 0 : (f > (long) maxY ? (long) maxY : f));
      if (ny != scrollY) {
        scrollY = ny;
        if (scrollAtBottom()) scrollNewBelow = 0;   // arrived: nothing is below
        scrollDrawBody();
        scrollDrawCounter();
        tft.flush();
      }
      moved += SCROLL_TAP_SLOP_PX;             // never mistaken for a tap
      delay(15);
      continue;
    }

    int dy = lastY - sy;                       // finger up scrolls content up
    if (dy != 0) {
      moved += dy < 0 ? -dy : dy;
      long ny = (long) scrollY + dy;
      if (ny < 0) ny = 0;
      if (ny > (long) maxY) ny = maxY;
      if ((uint32_t) ny != scrollY) {
        const int shift = (int) (ny - (long) scrollY);
        scrollY = (uint32_t) ny;
        if (scrollAtBottom()) scrollNewBelow = 0;   // arrived: nothing is below
        if (shift > -viewH && shift < viewH) {
          tft.scrollRect(0, SCROLL_TOP, tft.width(), viewH, -shift);
          scrollDrawBand(shift);
        } else {
          scrollDrawBody();
        }
        scrollDrawCounter();
        tft.flush();
      }
      lastY = sy;
    }
    // 15ms, matching handleTouch()'s own rate. getTouchPoint costs 1125us, so
    // that is 7.5% of the interval, on a bus the TFT does not share.
    delay(15);
  }
  // A TAP IS A DRAG THAT MOVED LESS THAN THIS. Without a named threshold "tap the
  // rail" and "drag anywhere" are not separable, because every tap moves a pixel
  // or two on a capacitive panel.
  if (moved < SCROLL_TAP_SLOP_PX && sy0 >= SCROLL_TOP && sy0 < SCROLL_BOT) {
    // Only the rail's zone does anything on a tap; the body deliberately has no
    // tap action at all, which is why there is no tap/drag ambiguity to resolve.
    // The coordinates are the ones the PRESS carried (scrollTapX, sy0) - reading
    // getTouchPoint here would return false, the finger having just left.
    if (scrollTapX >= SCROLL_RAIL_TAP_X && maxY > 0) {
      long f = (long) (sy0 - SCROLL_TOP) * (long) maxY / (SCROLL_BOT - SCROLL_TOP - 1);
      scrollY = (uint32_t) (f < 0 ? 0 : (f > (long) maxY ? (long) maxY : f));
      scrollDrawBody();
      scrollDrawCounter();
      tft.flush();
    }
  }
}

bool handleScrollTouch(int sx, int sy) {
  // SCROLL_TAP_H, NOT the paged reader's HIST_CHIP_TAP_H. That is 52 and this
  // header is 42, so the band reached 10px INTO the text - the top of the body
  // was dead for dragging and tapped the header's controls instead. Third
  // instance of the same drift in one change: the clear anchor, the bottom clip
  // and this, all still pointing at the layout the scrollback stopped sharing.
  if (sy < SCROLL_TAP_H) {
    if (sx < SCROLL_BACK_X + SCROLL_BACK_W + 8) { exitScrollback(); return true; }
    if (sx >= tft.width() - 12 - HIST_CHIP_W_CHAT - 8) {
      histChatOnly = !histChatOnly;
      scrollY = 0;
      scrollRefetch();   // entry counts differ per filter
      drawScrollback();
      return true;
    }
    return true;
  }
  if (sy >= SCROLL_TOP && sy < SCROLL_BOT && !scrollPending) {
    // The SAME predicate the note above is drawn from. With nothing to scroll a
    // drag has nothing to do, so the body's tap becomes the retry - which is not
    // a second meaning for the gesture so much as the only one available here.
    if (scrollDeadEnd()) {
      scrollFetchFailed = false;
      // SNAPSHOT BEFORE scrollEnd(): that call clears scrollLoadedId itself
      // ("the store is gone; it holds nothing" - its own comment), so
      // scrollRefetch()'s broadcast arm would otherwise read the id AFTER it
      // has already been wiped to "" and re-fetch nothing.
      char savedId[16];
      strncpy(savedId, scrollLoadedId, sizeof(savedId) - 1);
      savedId[sizeof(savedId) - 1] = '\0';
      scrollEnd();                 // drop the empty store so the fetch re-allocates
      // THROUGH scrollRefetch(), not a second copy of its body - it takes the
      // id precisely so this caller can hand it the pre-scrollEnd() snapshot.
      // scrollFromProjects is untouched by scrollEnd(), so the shared function
      // still reads the right one; the local `wasFromProjects` this used to
      // keep was only ever needed by the inlined copy.
      scrollRefetch(savedId);
      drawScrollback();
      return true;
    }
    scrollTapX = sx;
    scrollDragLoop(sy);
    return true;
  }
  return true;
}

void exitScrollback() {
  scrollActive = false;
  // READ, THEN CLEARED, BEFORE scrollEnd() (which touches neither, but the
  // order is stated because scrollEnd() DOES clear scrollLoadedId, and a
  // future edit moving this flag's own clear next to that one should not
  // silently start reading it after it is already gone).
  const bool wasFromProjects = scrollFromProjects;
  scrollFromProjects = false;
  scrollEnd();                    // 304KB of PSRAM back; only one session is ever open
  histActive = false;
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  if (wasFromProjects) {
    // BACK TO PROJECTS LEVEL 2, NOT SESSIONS - this transcript was opened
    // from a psess row, and detailIndex (SESSIONS' own "which card is open")
    // has no relationship to it and can even be -1. projLevel is untouched by
    // any of this (level 2 is still "open" the whole time the transcript was
    // on top of it), so returning to it needs no re-fetch - only a repaint.
    // projLevelPainted FORCED STALE: the fillScreen above just wiped the
    // pixels renderProjectsTab()'s own row-signature caches still believe are
    // on the glass, and without this its level-2 branch would see "nothing
    // changed" and redraw NOTHING - a wholesale-clear-and-bust case
    // (CLAUDE.md, the same shape switchTab()'s own tab-change clear needs),
    // reusing renderProjectsTab()'s EXISTING level-transition bust rather
    // than duplicating it.
    projLevelPainted = -1;
    renderProjectsTab();
  } else if (showingDetail && detailIndex >= 0 && detailIndex < sessionCount) {
    drawSessionDetail(detailIndex);
    buildDetailSignature(detailIndex, detailSigCache, sizeof(detailSigCache));
  } else {
    drawSessionsAll();
  }
  renderFooter();
  tft.flush();
}

// The real entry point now - reached from openHistory()'s board-2 arm (a session
// row tap) as well as from SCROLLPERF, which is why it stayed this minimal: the
// drag/tap machinery lives in scrollDragLoop()/handleScrollTouch(), not here.
void openScrollback(int idx) {
  if (idx < 0 || idx >= sessionCount) return;
  // DEFENSIVE, belt and braces (projFetchFailed()'s own reasoning: it costs
  // nothing): exitScrollback() always clears this on the way out, but a path
  // that opens straight through here (SCROLLPERF, SCROLLOPEN) rather than via
  // exitScrollback first must not inherit a stale TRUE left by a PROJECTS open
  // that never got a chance to close cleanly.
  scrollFromProjects = false;
  scrollActive = true;
  // histActive TOO, and this is not redundancy. Roughly ten guard lists in shared
  // code already name histActive as "the history surface owns the glass", and
  // setting it makes this surface join every one of them for free rather than
  // needing a #if per site. It is semantically right - this IS the history
  // surface on this board - and it was found the hard way: SCROLLPERF opens
  // through here rather than through openHistory, so histActive stayed false and
  // detailBandVisible() cheerfully blitted the detail card's 32x32 agent mark
  // over the middle of the transcript. Visible in a screenshot as a starburst
  // sitting in the text.
  histActive = true;
  scrollY = 0;
  requestScrollback(idx);
  // LAND AT THE NEWEST EVEN WHEN THE FETCH DID NOT RUN. requestScrollback
  // answers locally when the transcript is already held in PSRAM, and that path
  // has no completion callback to place the view - so a second open showed the
  // OLDEST message instead of the latest. Deciding where to land is the opener's
  // job, not the fetch's, which is why it is here and not in both branches.
  if (!scrollPending) scrollY = scrollMaxY();
  drawScrollback();
}

// OPENS THIS SAME SURFACE FOR AN ID THAT MAY NOT BE IN sessions[] AT ALL - a
// PROJECTS level-2 row (projects.ino's handlePSessTouch(), or the PSESSOPEN
// trigger-file command, deckhand_display.ino), live or long ended. This is
// the whole point of Task 7: no new reader. requestScrollback()/openScrollback()
// stay exactly as they were, addressed by a sessions[] INDEX to that session's
// own Mac; this is their sibling, addressed by an ID DIRECTLY, broadcast,
// because a PROJECTS-opened id may belong to any paired Mac's own
// ~/.claude/projects/ tree and may not be live at all - there is no hostSlot
// on file for it the way there is for a sessions[] row.
//
// scrollLoadedId IS SET FROM id12 - THE ARGUMENT - NEVER FROM
// sessions[detailIndex].id, and this function's own body is where that has to
// be checked: detailIndex names whichever session SESSIONS' own detail card
// is behind, which has NO relationship to which project row was tapped (the
// two can disagree - a PROJECTS open can happen with an unrelated, or no,
// detail card behind it) - reading through it here would silently show the
// WRONG transcript. scrollback-check.mjs binds this to THIS function's own
// body and fails BY NAME if a later edit routes the id through sessions[] or
// detailIndex instead of its own id12 parameter.
void scrollOpenById(const char* id12, const char* title) {
  scrollFromProjects = true;
  strncpy(scrollProjTitle, title, sizeof(scrollProjTitle) - 1);
  scrollProjTitle[sizeof(scrollProjTitle) - 1] = '\0';
  scrollActive = true;
  histActive = true;             // openScrollback()'s own note on why this joins too
  scrollY = 0;
  scrollFetch(id12, 0, true);    // broadcast - see this function's own header note
  // LAND AT THE NEWEST EVEN WHEN THE FETCH DID NOT RUN - openScrollback()'s
  // own reasoning, verbatim: scrollFetch() answers locally when the
  // transcript is already held in PSRAM, and that path has no completion
  // callback to place the view.
  if (!scrollPending) scrollY = scrollMaxY();
  drawScrollback();
}

// ---------- RESUME: a SIGNED headless turn ----------
// Base64 of an arbitrary buffer. kbBase64() (keyboard.ino) does exactly this
// over kbText and nothing else - it reads kbLen/kbText directly - and the
// keyboard has no part in a RESUME typed from the Mac, so this is the same
// three-bytes-to-four loop over a caller's own buffer rather than a second
// global's. Lives in THIS file, which is board 2 only: board 1 has no RESUME
// and must not carry the code for one.
void resumeBase64(const char* src, int len, char* out, size_t outSize) {
  int o = 0;
  for (int i = 0; i < len && o + 4 < (int) outSize; i += 3) {
    uint32_t v = (uint32_t) (uint8_t) src[i] << 16;
    if (i + 1 < len) v |= (uint32_t) (uint8_t) src[i + 1] << 8;
    if (i + 2 < len) v |= (uint8_t) src[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = (i + 1 < len) ? B64[(v >> 6) & 63] : '=';
    out[o++] = (i + 2 < len) ? B64[v & 63] : '=';
  }
  out[o] = '\0';
}

// SENDS ONE SIGNED FRAME PER LIVE LINK, each with that Mac's OWN nonce and
// signed with that Mac's OWN key, addressed to it. Returns how many went out.
//
// WHY NOT ONE BROADCAST LINE, which is what the unsigned version sent: a
// signature is over ONE secret. The device cannot know which paired Mac's disk
// holds a PROJECTS-opened transcript (scrollOpenById()'s own reasoning - a
// project inventory is not owned by whichever Mac ticked last), so the unsigned
// line went to everyone and only the Mac that HAD the transcript acted. Signing
// keeps exactly that property by sending each Mac its own frame: the one that
// holds the session verifies and runs, the others verify and find no transcript
// (host/index.mjs's transcriptPathFor refuses by name), and no Mac is ever
// handed a signature it cannot check. sendPromptToHost()'s "sign with the
// session's OWN Mac" rule, applied where the session's Mac is not yet known.
//
// EVERY SKIPPED LINK SAYS WHY. From the Mac, a link that was skipped and a link
// that was never there are indistinguishable, which is the rule this whole
// command surface is built on.
int sendResumeSigned(const char* id12, const char* text) {
  const int len = (int) strlen(text);
  String sha = sha256Hex16(text);
  char b64[204];                       // 150 bytes -> 200 chars + NUL
  resumeBase64(text, len, b64, sizeof(b64));
  int sent = 0;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    if (hostLinks[i].resumeNonce[0] == '\0') {
      Serial.printf("RESUME: link %d (%s) has published no rnonce yet - not sending to it "
                    "(its host predates signed RESUME, or no tick has arrived from it)\n",
                    i, hostLinks[i].hostId);
      continue;
    }
    const int slot = pairingSlotForLink(i);
    String mac = authHmacFor(slot, String(hostLinks[i].resumeNonce) + ":" + id12 + ":RESUME:" + sha);
    if (mac.length() == 0) {
      Serial.printf("RESUME: no pairing key for link %d (%s) - not sending to it; an unsigned "
                    "resume is refused by the host rather than run\n", i, hostLinks[i].hostId);
      continue;
    }
    char line[280];
    snprintf(line, sizeof(line), "RESUME %s %s %s", id12, b64, mac.c_str());
    sendLineToHost(line, i);
    sent++;
  }
  return sent;
}

#endif  // BOARD_HISTORY_SCROLL
