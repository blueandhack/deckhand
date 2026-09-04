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
char scrollLoadedId[16] = "";
bool scrollLoadedChat = true;

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

// Length of the line starting at `pos`, and whether it ended on a '\n'.
// MONOSPACE, so this is exact integer arithmetic with no width call at all -
// which matters twice: it runs once per entry over the whole transcript at fetch
// time, and it is what lets a JS mirror agree with it exactly. Every Spleen glyph
// in 0x20..0x7E has xOffset 0, width 8 and xAdvance 8, asserted in the header.
static int scrollLineLen(const char* t, int pos, int cols, bool* hardBreak) {
  *hardBreak = false;
  int i = 0;
  while (i < cols && t[pos + i] && t[pos + i] != '\n') i++;
  if (t[pos + i] == '\n') { *hardBreak = true; return i; }
  if (!t[pos + i]) return i;                 // the rest fits on this line
  // Word-friendly break: the last space in the lane's second half, the same rule
  // the shared wrapLineLen uses.
  for (int b = i; b > cols / 2; b--)
    if (t[pos + b - 1] == ' ') return b;
  return i;                                  // unbreakable word: never stall
}

// DELIBERATELY NOT countWrappedLines(). That helper stops at 80 lines and its
// wrapLineLen carries a `char buf[64]` capped at 60 characters, so a 4000-byte
// entry - 118 lines at 34 columns - cannot pass through it at all. Raising either
// would move board 1's binary for a board-2 feature.
int scrollWrapLines(const char* t, int cols) {
  if (!t[0]) return 1;                       // an empty entry still owns a line
  int pos = 0, lines = 0;
  while (t[pos]) {
    bool hard;
    int n = scrollLineLen(t, pos, cols, &hard);
    pos += n;
    if (hard && t[pos] == '\n') pos++;
    lines++;
    if (n == 0 && !hard) break;              // cannot happen; must not spin
  }
  return lines ? lines : 1;
}

// The `want`-th wrapped line of `t`, into `out`. O(lines) per call, so drawing
// the last line of a 118-line entry walks it - 26 lines x 118 is a few thousand
// iterations of a trivial loop per frame, which is nothing beside one flush.
bool scrollLineAt(const char* t, int cols, int want, char* out, int outSize) {
  int pos = 0, line = 0;
  while (t[pos]) {
    bool hard;
    int n = scrollLineLen(t, pos, cols, &hard);
    if (line == want) {
      int cap = n < outSize - 1 ? n : outSize - 1;
      memcpy(out, t + pos, cap);
      out[cap] = '\0';
      return true;
    }
    pos += n;
    if (hard && t[pos] == '\n') pos++;
    line++;
    if (n == 0 && !hard) break;
  }
  out[0] = '\0';
  return false;
}

void scrollReset() {
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
  e.lines = (uint16_t) scrollWrapLines(dst, SCROLL_COLS);
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

void requestScrollback(int idx) {
  if (idx < 0 || idx >= sessionCount) return;
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
      strcmp(scrollLoadedId, sessions[idx].id) == 0) {
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
  scrollHostSlot = sessions[idx].hostSlot;
  strncpy(scrollLoadedId, sessions[idx].id, sizeof(scrollLoadedId) - 1);
  scrollLoadedId[sizeof(scrollLoadedId) - 1] = '\0';
  scrollLoadedChat = histChatOnly;
  char line[72];
  snprintf(line, sizeof(line), "HISTORY %s %s tail:%ld", sessions[idx].id,
           histChatOnly ? "chat" : "all", budget);
  // Addressed to the session's own Mac - only it holds that transcript.
  sendLineToHost(line, sessions[idx].hostSlot);
}

// Called from loop(). A stalled fetch must say so rather than leaving
// "fetching" on the glass forever.
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

// The body only. Kept separate from the chrome so a scroll frame repaints just
// this - the chrome is static between fetches.
void scrollDrawBody() {
  // Cleared from just under the RULE, not from SCROLL_TOP: the 6 rows of air
  // between them (SCROLL_TOP is HIST_RULE_Y + 6) belong to no one otherwise, so
  // they kept whatever the previous screen left there whenever the body was
  // redrawn without a full drawScrollback() first. Visible as a clipped line of
  // stale text under the header.
  tft.fillRect(0, HIST_RULE_Y + 1, tft.width(), SCROLL_BOT - HIST_RULE_Y - 1, COLOR_BG);

  if (scrollPending) {
    char b[40];
    if (usbLinkActive()) snprintf(b, sizeof(b), "-- fetching %d/%d --", scrollChunksIn, scrollChunksOf);
    else snprintf(b, sizeof(b), "-- fetching over Bluetooth --");
    scrollNote(b, (SCROLL_TOP + SCROLL_BOT) / 2 - CODE_LINE_H / 2);
    return;
  }
  if (scrollFetchFailed) {
    scrollNote("-- could not reach the Mac --", (SCROLL_TOP + SCROLL_BOT) / 2 - CODE_LINE_H / 2);
    return;
  }
  if (scrollCount == 0) {
    scrollNote("-- nothing here --", (SCROLL_TOP + SCROLL_BOT) / 2 - CODE_LINE_H / 2);
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
    if (y >= SCROLL_BOT) break;

    // Roles 2/3/4 are one line, clipped with THREE ASCII DOTS - never U+2026,
    // which is outside Spleen's range and would give a truncated line no visible
    // sign that anything was missing.
    if (e.role >= 2) {
      if (k > 0) continue;
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
      scrollLineAt(scrollTextAt(ei), SCROLL_COLS, k, buf, sizeof(buf));
    }

    setUIFont(1);
    if (k == 0) {
      tft.setTextColor(scrollMarkColor(e.role), COLOR_BG);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(scrollMark(e.role), SCROLL_GUT_X, y);
    }
    tft.setTextColor(scrollTextColor(e.role), COLOR_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(buf, SCROLL_TXT_X, y);
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
    if (y + CODE_LINE_H <= bandY0) continue;
    if (y >= bandY1) break;

    if (e.role >= 2) {
      if (k > 0) continue;
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
      scrollLineAt(scrollTextAt(ei), SCROLL_COLS, k, buf, sizeof(buf));
    }

    setUIFont(1);
    if (k == 0) {
      tft.setTextColor(scrollMarkColor(e.role), COLOR_BG);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(scrollMark(e.role), SCROLL_GUT_X, y);
    }
    tft.setTextColor(scrollTextColor(e.role), COLOR_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(buf, SCROLL_TXT_X, y);
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

  // The back key carries the CLOSE the deleted button row used to provide.
  uiStrokeRound(SCROLL_BACK_X, HIST_CHIP_Y, SCROLL_BACK_W, HIST_CHIP_H, 3,
                BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("<", SCROLL_BACK_X + SCROLL_BACK_W / 2, HIST_CHIP_Y + HIST_CHIP_H / 2);
  tft.setTextDatum(TL_DATUM);

  // Name and counter are the same 16px cell - Spleen's smallest rung - so they are
  // separated by COLOUR and POSITION, never by size, the rule the rest of the
  // device follows.
  if (detailIndex >= 0 && detailIndex < sessionCount) {
    char nm[SCROLL_NAME_COLS + 1];
    strncpy(nm, sessions[detailIndex].name, SCROLL_NAME_COLS);
    nm[SCROLL_NAME_COLS] = '\0';
    setUIFont(2);
    tft.setTextColor(COLOR_VALUE, COLOR_BG);
    tft.drawString(nm, SCROLL_NAME_X, 12);
  }
  char pos[24];
  if (scrollPending) snprintf(pos, sizeof(pos), "...");
  else if (scrollCount > 0) {
    // Which entry the top visible line belongs to, out of the whole filtered
    // history - the same claim the pager's "412/628" makes.
    int ei = scrollEntryAtLine(scrollY / CODE_LINE_H);
    snprintf(pos, sizeof(pos), "%d/%d", scrollDropped + ei + 1, scrollTotal);
  } else snprintf(pos, sizeof(pos), "0/0");
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString(pos, SCROLL_NAME_X, 30);

  const char* chip = histChatOnly ? "CHAT" : "ALL";
  int chipW = histChatOnly ? HIST_CHIP_W_CHAT : HIST_CHIP_W_ALL;
  int chipX = tft.width() - 12 - chipW;
  uiFillRound(chipX, HIST_CHIP_Y, chipW, HIST_CHIP_H, 3, COLOR_ACCENT, COLOR_BG);
  setUIFont(1);
  tft.setTextColor(COLOR_BG, COLOR_ACCENT);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(chip, chipX + chipW / 2, HIST_CHIP_CY);
  tft.setTextDatum(TL_DATUM);

  tft.drawFastHLine(0, HIST_RULE_Y, tft.width(), COLOR_LABEL);
  scrollDrawBody();
  tft.flush();
}

// A BLOCKING loop, the pattern micMonitor, micStream and runCalibration already
// use - chosen over extending handleTouch() for two reasons. handleTouch() is
// SHARED CODE and returns immediately on `touching && wasTouching` ("a finger
// still down has nothing left to do"), so putting drag state there risks board
// 1's binary for a board-2 feature. And the precedent already exists three times.
void scrollDragLoop(int sy0) {
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
    int dy = lastY - sy;                       // finger up scrolls content up
    if (dy != 0) {
      moved += dy < 0 ? -dy : dy;
      long ny = (long) scrollY + dy;
      if (ny < 0) ny = 0;
      if (ny > (long) maxY) ny = maxY;
      if ((uint32_t) ny != scrollY) {
        const int shift = (int) (ny - (long) scrollY);
        scrollY = (uint32_t) ny;
        if (shift > -viewH && shift < viewH) {
          tft.scrollRect(0, SCROLL_TOP, tft.width(), viewH, -shift);
          scrollDrawBand(shift);
        } else {
          scrollDrawBody();
        }
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
      tft.flush();
    }
  }
}

bool handleScrollTouch(int sx, int sy) {
  if (sy <= HIST_CHIP_TAP_H) {
    if (sx < SCROLL_BACK_X + SCROLL_BACK_W + 8) { exitScrollback(); return true; }
    if (sx >= tft.width() - 12 - HIST_CHIP_W_CHAT - 8) {
      histChatOnly = !histChatOnly;
      scrollY = 0;
      requestScrollback(detailIndex);   // entry counts differ per filter
      drawScrollback();
      return true;
    }
    return true;
  }
  if (sy >= SCROLL_TOP && sy < SCROLL_BOT && !scrollPending) {
    scrollTapX = sx;
    scrollDragLoop(sy);
    return true;
  }
  return true;
}

void exitScrollback() {
  scrollActive = false;
  scrollEnd();                    // 304KB of PSRAM back; only one session is ever open
  histActive = false;
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  if (showingDetail && detailIndex >= 0 && detailIndex < sessionCount) {
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
  drawScrollback();
}

#endif  // BOARD_HISTORY_SCROLL
