// PROJECTS tab: level 1, the scrolling list of Claude Code projects. Split
// out of deckhand_display.ino - see pairing.ino for how the concatenated
// build works and what may not move. ProjInfo/projects[]/projectCount are
// declared (as `extern`) in deckhand_display.ino, ahead of handleLine()'s
// `projs` absorption, and DEFINED here for real - see that file's own note
// on why the split runs that direction.
//
// BOARD 2 ONLY. Out of scope for board 1 by design
// (docs/superpowers/specs/2026-09-20-sessions-manager-design.md, "Out of
// scope: Board 1") - the tab arithmetic works there (TAB 2 switches cleanly
// to an empty content area), the content behind it does not. ONE #if wraps
// everything this file defines except the two dispatch functions at the
// bottom, which every call site in deckhand_display.ino reaches
// unconditionally and which therefore need a real (if empty) body on both
// boards - the same shape scrollback.ino's own header documents, and the
// same reason: board 1 never sees the TEXT of any of this, so it needs no
// PROJ_* constant from a header it does not have.
#if BOARD_HAS_PROJECTS

ProjInfo projects[PROJ_SLOTS];
int projectCount = 0;
// Set the moment a PROJFETCH goes out, cleared the moment a `projs` reply
// lands (handleLine(), deckhand_display.ino) - the same shape scrollPending
// carries for the transcript fetch, and for the identical reason: the host
// delivers every trigger-file command over BOTH transports, so a cabled
// board's own PROJFETCH (from switchTab() opening the tab, or from the
// Mac's own PROJFETCH probe) can arrive twice within milliseconds.
bool projectsPending = false;
// Has a `projs` reply EVER arrived this boot? Distinct from projectCount == 0
// (a real, empty inventory) and from projectsPending (a fetch in flight) -
// this is what tells renderProjectsTab() to show "Loading..." rather than
// "No projects found" the very first time the tab opens.
bool projectsEverReceived = false;
unsigned long projectsFetchStart = 0;
// SET BY tickProjectsFetch() ON TIMEOUT, CLEARED BY requestProjects() ON A
// FRESH SEND - scrollFetchFailed's own shape (scrollback.ino), for the
// identical reason: a lost reply must become a NAMED failure the person can
// act on, not an unbounded wait. Mutually exclusive with projectsPending in
// practice (one tick sets this and clears that in the same breath), but they
// are not merged into one tri-state on purpose - a third caller reading
// "not pending" would otherwise have to ask separately whether that means
// "succeeded" or "never tried", and this way it never has to.
bool projectsFetchFailed = false;

// Scroll offset, in content pixels, always a multiple of PROJ_STEP - see
// projScrollTo(), the one place it is written.
int projScroll = 0;
// What was last actually PAINTED, so a scroll step (which moves every row's
// y without changing any row's own name|count|tod|live) still busts every
// row's cache - the same shape sessionScrollCache is, for the identical
// reason: a position-only change reaches no text-comparing cache at all.
int projScrollCache = -1;
// THREE SUB-STATES OF "NO ROWS TO DRAW", named so a transition between them
// gets the same wholesale-clear-and-bust treatment a genuine row-count
// change gets. Merging them into one bucket (an earlier version of this file
// did) is exactly the trap CLAUDE.md names for a colour- or shape-only
// change: drawIfChanged's own box-clear is sized to the NEW text, and
// "-- could not reach the Mac --\ntap to retry" (two lines) shrinking to
// "Loading projects..." (one line) on a retry would leave the second line's
// old, wider ink standing - a ghost nothing ever wipes, because neither
// message's own per-field cache saw itself as the thing that changed.
const int PROJ_STATE_PENDING = -2;
const int PROJ_STATE_FAILED  = -3;
const int PROJ_STATE_EMPTY   = -4;
// The layout state last painted: -1 (never rendered), one of the three
// states above, or the project count the rows were drawn for. Any change to
// this value means the content area needs a wholesale clear before anything
// is redrawn into it - see renderProjectsTab()'s own note.
int projRowCountCache = -1;
// Per-DISPLAY-POSITION signature cache, "name|count|tod|live" - see
// drawProjectRow()'s own note on why `live` belongs here despite never
// being drawn as text. 48 bytes: the host caps name at 22 (so up to 23 with
// its NUL), count and tod each print at most a handful of digits, and the
// separators and the live flag cost four more - comfortably inside 48 with
// margin, and margin is the right side to err on (CLAUDE.md: a cache
// shorter than the string it holds silently stops noticing changes past
// that point).
char projRowSigCache[PROJ_SLOTS][48];
// The loading/failed/empty message's own two lines. Sized to their real
// worst cases ("-- could not reach the Mac --" is 30 characters, "tap to
// retry" 12) with margin, per this file's own rule above - see
// PROJ_STATE_PENDING's comment for why a shared, generic-length cache would
// not be enough on its own to keep the second line from ghosting on a
// shrink; the explicit bust on a projRowCountCache transition is what
// actually prevents that, these caches are reset there too.
char projMsgCache[32] = "";
char projMsg2Cache[16] = "";

void requestProjects() {
  // A SECOND REQUEST WHILE ONE IS IN FLIGHT IS A NO-OP THAT REPORTS PROGRESS,
  // not a second fetch - the exact shape requestScrollback() uses, for the
  // exact reason recorded there: two fetches racing through one sequencing
  // mechanism corrupt each other. This fetch has no sequencing at all (it is
  // a single-chunk, no-argument request - the design's own wire section
  // measured it at ~175ms for 16 projects, comfortably inside one chunk), so
  // the failure mode here is milder than SCROLL's interleaved chunks would
  // be, but "milder" is not "none": two in-flight PROJECTS requests would
  // still be two replies landing back to back, each one wholesale-replacing
  // `projects[]` and repainting the tab, for no reason a person could see.
  if (projectsPending) {
    char m[64];
    snprintf(m, sizeof(m), "PROJECTS busy ms=%lu", millis() - projectsFetchStart);
    sendLineToHost(m);
    return;
  }
  projectsPending = true;
  // CLEARED ON EVERY FRESH SEND, not just on success - scrollFetchFailed's
  // own reset in requestScrollback(). Without this, a retry after a timeout
  // would set projectsPending back to true while projectsFetchFailed stayed
  // true too, and the two would briefly (correctly, since pending is
  // checked first) agree on what to SHOW but disagree about what actually
  // HAPPENED - state worth not leaving to sort itself out.
  projectsFetchFailed = false;
  projectsFetchStart = millis();
  // BROADCAST (link -1), not addressed to one Mac: unlike a session's
  // transcript, the project inventory is not owned by whichever Mac is
  // "active" - it is the same ~/.claude/projects/ tree regardless of which
  // paired Mac answers. Whichever Mac replies first wins the render; a
  // second Mac's reply lands as an ordinary re-fetch (wholesale replace) a
  // moment later.
  sendLineToHost("PROJECTS");
}

// Called from loop() - tickScrollFetch()'s own shape (scrollback.ino),
// mirrored rather than reinvented. A lost reply is a NORMAL event on BLE,
// not an exotic one, and left unhandled it is an UNRECOVERABLE state
// reachable by a single dropped packet: projectsPending stays true forever,
// so every later PROJFETCH and every later tab-open logs "busy" and fetches
// nothing - the tab is stuck on "Loading projects..." until the board
// reboots, with nothing anywhere saying why. This is what breaks that.
//
// THE FIRST LINE IS THE WHOLE COST GUARANTEE: no fetch outstanding, nothing
// below it ever runs. tickScrollFetch() states the identical guarantee for
// the identical reason.
void tickProjectsFetch() {
  if (!projectsPending) return;
  const unsigned long cap = usbLinkActive() ? PROJ_FETCH_TIMEOUT_MS : PROJ_FETCH_TIMEOUT_BLE_MS;
  if (millis() - projectsFetchStart < cap) return;
  // sendLineToHost, NOT Serial.printf - tickScrollFetch()'s own choice, and
  // for the same reason: with the cable out, Serial reaches nothing, and a
  // BLE-only session is EXACTLY when this report needs to be visible - it is
  // the transport most likely to have lost the reply in the first place.
  char m[64];
  snprintf(m, sizeof(m), "PROJECTS timeout ms=%lu", millis() - projectsFetchStart);
  sendLineToHost(m);
  projectsPending = false;
  projectsFetchFailed = true;
  if (currentTab == TAB_PROJECTS) renderProjectsTab();
}

// IS THE FAILED STATE ON THE GLASS RIGHT NOW, THE ONE A TAP CAN RETRY?
// scrollDeadEnd()'s own shape (scrollback.ino) - "ONE predicate, read by the
// draw site and the hit test both: a control drawn under one condition and
// hit-tested under another is this codebase's classic defect" - extracted
// here for the identical reason, after a review caught the two sites
// spelling the same two-variable condition independently: they agreed
// today, and a comment claiming they were already "the same predicate"
// when no such function existed was worse than the duplication it
// described, because the next edit to either copy would have had nothing
// forcing the other to follow.
//
// NARROWER THAN scrollDeadEnd() ON PURPOSE - not a full port of its shape.
// scrollDeadEnd() also treats a genuinely EMPTY transcript (scrollCount ==
// 0) as a dead end, because there is nothing else that screen could offer
// instead of a retry. PROJ_STATE_EMPTY ("No projects found") is not a
// failure to recover from - it is an accurate report - so a tap there does
// nothing rather than re-fetching an inventory that was already answered
// correctly. Only PROJ_STATE_FAILED is retriable, which is exactly what
// this predicate says and nothing more.
bool projFetchFailed() {
  return projectsFetchFailed && !projectsPending;
}

// ---------- Scrolling (board 2's only shape at this level - see the header
// note on board_es3c35p.h's PROJ_* block) ----------
bool projScrollActive() { return projectCount > PROJ_ROWS; }

// IS THIS DISPLAY POSITION ON THE GLASS? There is no third answer, for the
// identical reason sessionRowVisible() states one: rows sit at multiples of
// PROJ_STEP and so does the scroll offset (projScrollTo() snaps it), so a
// row is either wholly inside the window or wholly outside it - never
// partial, on a board whose only clip is the screen edge.
bool projRowVisible(int pos) {
  if (!projScrollActive()) return true;
  const int top = projScroll / PROJ_STEP;
  return pos >= top && pos < top + PROJ_ROWS;
}

int projScrollContentH() { return projectCount * PROJ_STEP - PROJ_ROW_GAP; }

// THE LARGEST LEGAL OFFSET, ROUNDED UP to a whole step - sessionScrollMax()'s
// own reasoning, unchanged: rounding down would make the last project
// unreachable whenever the content height is not an exact multiple of the
// step, and rounding up costs a few pixels of background below the last row
// instead, which is the cheap direction.
int projScrollMax() {
  const int over = projScrollContentH() - PROJ_SCROLL_VIEW_H;
  if (over <= 0) return 0;
  return ((over + PROJ_STEP - 1) / PROJ_STEP) * PROJ_STEP;
}

// THE ONE PLACE projScroll IS EVER WRITTEN - sessionScrollTo()'s own shape,
// so the "always a multiple of PROJ_STEP" invariant holds by construction
// rather than by every caller remembering it.
void projScrollTo(int px) {
  int step = (px + PROJ_STEP / 2) / PROJ_STEP;
  if (step < 0) step = 0;
  int v = step * PROJ_STEP;
  const int mx = projScrollMax();
  if (v > mx) v = mx;
  projScroll = v;
}

// "14:32" for a moment that WAS today, "old" (never an ellipsis - the fonts
// are ASCII 0x20..0x7E and nothing else) for one that was not - the same
// -1-means-not-today convention host/project-replies.mjs's
// secondsSinceMidnight() and every other on-device clock field share.
void formatProjTime(long tod, char* buf, size_t n) {
  if (tod < 0) { snprintf(buf, n, "old"); return; }
  snprintf(buf, n, "%02ld:%02ld", (tod / 3600) % 24, (tod / 60) % 60);
}

// IS THIS PROJECT LIVE - does any session in the CURRENT list belong to it?
// Answered by FORWARD-ENCODING a live session's own cwd (SessionInfo.path)
// into the same hyphen form Claude Code itself produced when it named the
// project's directory, and comparing that against the project's opaque
// `key` - never the other way around. host/project-replies.mjs's own header
// is explicit about why: "-Users-yujia-work-claude-plugins" is
// /Users/yujia/work/claude-plugins, not .../claude/plugins - a hyphen in a
// project's own name is indistinguishable from the path separator, so a key
// can only be read FORWARD, never decoded. Encoding a real path forward has
// no such ambiguity: every '/' becomes '-', unconditionally, because that
// is exactly the transform that produced the key in the first place.
//
// IMPRECISE AT THE EDGES, AND SAID SO RATHER THAN LEFT IMPLIED (CLAUDE.md,
// "state what is measured and what is not"). SessionInfo.path is the host's
// LIVE cwd for that session - host/index.mjs rewrites it on every event -
// while a project's key is fixed by whichever cwd Claude Code held when
// that session's transcript file was first created; the two can differ for
// a session that `cd`s within its own project. host/index.mjs also
// truncates a long path to its last 64 characters ("..." + the tail), which
// this comparison cannot match at all - checked for and skipped below.
// Nothing on the wire ties a live session to a project any more precisely
// than this today; a session whose path was truncated, or that has wandered
// from where it started, simply does not mark its project live, which is
// the safe direction - a MISSED live mark costs a colour, a false one would
// claim a project is open when it is not.
bool projectIsLive(int i) {
  const char* k = projects[i].key;
  for (int j = 0; j < sessionCount; j++) {
    const char* p = sessions[j].path;
    if (!p[0] || p[0] == '.') continue; // empty, or the "..." truncation marker
    size_t pi = 0, ki = 0;
    bool match = true;
    while (p[pi] || k[ki]) {
      if (!p[pi] || !k[ki]) { match = false; break; }
      char pc = p[pi] == '/' ? '-' : p[pi];
      if (pc != k[ki]) { match = false; break; }
      pi++; ki++;
    }
    if (match) return true;
  }
  return false;
}

// WHOLESALE REPAINT OF ONE ROW, gated by its caller's signature check - the
// same split drawSessionRow() and its own caller use. Nothing here needs a
// per-field drawIfChanged of its own: unlike a session, nothing on a project
// row ticks on its own between polls (no live duration, no working
// animation), so the row's SIGNATURE (name|count|tod|live) already covers
// every pixel this function paints - the rule the session row's title and
// Mac tag were both added under after shipping stale once each.
void drawProjectRow(int pos) {
  const int y = PROJ_ROW_Y0 + pos * PROJ_STEP - projScroll;
  const ProjInfo& p = projects[pos];
  const bool live = projectIsLive(pos);
  const uint16_t nameColor = live ? COLOR_VALUE : COLOR_LABEL;

  uiFillRound(PROJ_ROW_X, y, PROJ_ROW_W, PROJ_ROW_H, R_MD, COLOR_CARD, COLOR_BG);
  uiStrokeRound(PROJ_ROW_X, y, PROJ_ROW_W, PROJ_ROW_H, R_MD, BORDER_CARD, COLOR_LABEL, COLOR_BG);

  setUIFont(T_BODY);
  const int textY = y + (PROJ_ROW_H - uiLineH(T_BODY)) / 2;

  // THE META FIELD'S OWN FIXED BUDGET (PROJ_META_W), NOT A LIVE MEASUREMENT,
  // is what the name lane trims against below - unlike SESSION_SUB_LANE_W's
  // "lanes are measured, never counted" rule, which exists because that
  // row's OTHER blocker (the agent tag) genuinely varies in width call to
  // call. This field's format ("<count>x <time>") does not vary nearly as
  // much, so PROJ_META_W's own worst case ("999x 23:59", derived in
  // board_es3c35p.h) is the bound, and `meta` below is clamped to fit it
  // rather than measured to size it. Clamped to three digits for DISPLAY
  // ONLY - ProjInfo.count itself is untouched - and a real project's session
  // count has never been observed anywhere near that (16 projects, the most
  // populous under 200 transcripts, measured 2026-09-20).
  char timeStr[8];
  formatProjTime(p.tod, timeStr, sizeof(timeStr));
  unsigned dispCount = p.count > 999 ? 999 : p.count;
  char meta[16];
  snprintf(meta, sizeof(meta), "%ux %s", dispCount, timeStr);

  char nameBuf[PROJ_NAME_CHARS + 4]; // host caps at 22; +4 for "..." and a NUL
  fitText(nameBuf, sizeof(nameBuf), p.name, PROJ_ROW_W - 2 * PROJ_PAD - PROJ_META_W);

  tft.setTextColor(nameColor, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(nameBuf, PROJ_ROW_X + PROJ_PAD, textY);

  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(meta, PROJ_ROW_X + PROJ_ROW_W - PROJ_PAD, textY);
  tft.setTextDatum(TL_DATUM);
}

#endif  // BOARD_HAS_PROJECTS

// The two functions every dispatch site in deckhand_display.ino already
// calls unconditionally (switchTab(), forceFullRepaint(), stopOctopus(),
// handleTouch(), the once-a-second tick) - see that file's own note on why
// the `#if` sits INSIDE each body rather than around the whole function.
void renderProjectsTab() {
#if BOARD_HAS_PROJECTS
  // NOT SESSIONSCROLL'S SHAPE for the loading/failed/empty message: this is
  // a STRUCTURAL state (is there a list to draw at all), so it gets the same
  // wholesale-clear-and-bust treatment a session count change gets, keyed by
  // one of PROJ_STATE_PENDING/FAILED/EMPTY - three, not one, and that split
  // is what actually matters here: an earlier version of this file merged
  // them into a single sentinel, which meant retrying after a timeout
  // (failed's two lines -> pending's one) triggered NO clear at all, since
  // both states shared the same bucket - and drawIfChanged's own box-clear
  // is sized to the NEW, narrower text, so the failed message's second line
  // ("tap to retry") would still be standing where "Loading projects..."
  // had nothing to say about it. Re-entering the SAME state on a later call
  // (the once-a-second tick, while still pending) must NOT re-clear - that
  // would flicker the same text every second - and drawIfChanged below is
  // what keeps that call nearly free once the state itself has settled.
  if (!projectsEverReceived || projectCount == 0) {
    // projFetchFailed() rather than the raw `projectsFetchFailed` flag - the
    // SAME predicate handleProjectsTouch() reads below, so a tap is offered
    // exactly when, and only when, this branch drew a state it can retry.
    const int state = projectsPending  ? PROJ_STATE_PENDING
                     : projFetchFailed() ? PROJ_STATE_FAILED
                                          : PROJ_STATE_EMPTY;
    if (projRowCountCache != state) {
      tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
      for (int i = 0; i < PROJ_SLOTS; i++) projRowSigCache[i][0] = '\0';
      projRowCountCache = state;
      projMsgCache[0] = '\0';
      projMsg2Cache[0] = '\0';
    }
    // ASCII ONLY - three ASCII dots/hyphens, never U+2026 or an em dash: an
    // out-of-range codepoint draws NOTHING AND ADVANCES NOTHING on this
    // board's fonts, which is invisible rather than merely wrong-looking.
    // "--" either side of the failure text matches scrollback.ino's own
    // dead-end vocabulary (scrollNote's "-- could not reach the Mac --"),
    // reused rather than invented, so the device says the same thing about
    // the same failure everywhere it can happen.
    const char* msg = state == PROJ_STATE_PENDING ? "Loading projects..."
                     : state == PROJ_STATE_FAILED  ? "-- could not reach the Mac --"
                                                    : "No projects found";
    const char* msg2 = state == PROJ_STATE_FAILED ? "tap to retry" : "";
    setUIFont(T_BODY);
    const int msgY1 = CONTENT_Y + 40;
    drawIfChanged(projMsgCache, sizeof(projMsgCache), msg, tft.width() / 2, msgY1,
                  T_BODY, 1, COLOR_LABEL, COLOR_BG, TC_DATUM);
    // Only drawn (and only ever compared) when there IS a second line - the
    // clear above already blanked it for every OTHER state, and comparing
    // an empty string against an empty cache would never fire drawIfChanged
    // anyway, so this guard is for clarity, not correctness.
    if (msg2[0]) {
      drawIfChanged(projMsg2Cache, sizeof(projMsg2Cache), msg2, tft.width() / 2,
                    msgY1 + uiLineH(T_BODY) + 8, T_BODY, 1, COLOR_LABEL, COLOR_BG, TC_DATUM);
    }
  } else {
    // A SCROLL-CAPABLE COUNT CHANGE (or the count changing at all) GETS THE
    // SAME WHOLESALE TREATMENT sessions.ino's rowCountCache/sessionScrollCache
    // both get, for the identical reason stated there: a row that MOVES
    // without its own name|count|tod|live changing reaches no text-comparing
    // cache at all, and CLAUDE.md is explicit that a colour- or
    // position-only change must be busted explicitly rather than trusted to
    // show up in a field comparison.
    if (projScrollActive()) projScrollTo(projScroll); else projScroll = 0;
    if (projRowCountCache != projectCount) {
      projRowCountCache = projectCount;
      tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
      for (int i = 0; i < PROJ_SLOTS; i++) projRowSigCache[i][0] = '\0';
    }
    if (projScroll != projScrollCache) {
      projScrollCache = projScroll;
      tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
      for (int i = 0; i < PROJ_SLOTS; i++) projRowSigCache[i][0] = '\0';
    }
    for (int pos = 0; pos < projectCount; pos++) {
      if (!projRowVisible(pos)) continue;
      const ProjInfo& p = projects[pos];
      // EVERY FIELD DRAWN MUST BE IN THIS SIGNATURE - name, count and tod are
      // drawn directly; `live` is not itself drawn but its VALUE is (the
      // name's colour), and a colour-only change reaches no text-comparing
      // cache at all (CLAUDE.md) unless it is signed explicitly, which is
      // exactly why it is a term here rather than an afterthought.
      char sig[48];
      snprintf(sig, sizeof(sig), "%s|%u|%ld|%d", p.name, (unsigned) p.count, p.tod,
               projectIsLive(pos) ? 1 : 0);
      if (strncmp(sig, projRowSigCache[pos], sizeof(projRowSigCache[pos])) != 0) {
        strncpy(projRowSigCache[pos], sig, sizeof(projRowSigCache[pos]) - 1);
        projRowSigCache[pos][sizeof(projRowSigCache[pos]) - 1] = '\0';
        drawProjectRow(pos);
      }
    }
  }
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
#endif  // BOARD_HAS_PROJECTS
}

void handleProjectsTouch(int sx, int sy) {
#if BOARD_HAS_PROJECTS
  // Nothing to touch before the first reply, or with a genuinely empty
  // inventory - EXCEPT the failed state's own escape: a tap anywhere retries,
  // since the screen has nothing else on it to hit-test against.
  // projFetchFailed() is CALLED here, not re-derived - the actual shared
  // function renderProjectsTab() reads to choose that same state, so a
  // retry is offered exactly when, and only when, the glass says one is
  // (scrollDeadEnd()'s own precedent: "one predicate, read by the draw site
  // and the hit test both"). Its own `!projectsPending` term is what makes
  // a tap during the brief window between a fresh send and the pending flag
  // settling a no-op here rather than a second request - though
  // requestProjects()'s own busy-guard would catch that anyway, belt and
  // braces costs nothing.
  if (!projectsEverReceived || projectCount == 0) {
    if (projFetchFailed()) {
      requestProjects();
      renderProjectsTab(); // immediate feedback - "Loading..." without a 1s wait for the next tick
    }
    return;
  }
  if (sy < PROJ_ROW_Y0) return;

  if (projScrollActive()) {
    // A PRESS IN A SCROLLING LIST IS A DRAG UNTIL IT PROVES OTHERWISE -
    // sessionDragLoop()'s own shape, blocking here until the finger lifts,
    // because a drag has already done its work by the time it releases and
    // there is nothing left for the caller's own hit test to do with it. No
    // rail on this level (the brief's own constant list names none, and a
    // 24-project ceiling reached by direct dragging is a smaller ask than
    // the 20-row session list already made without one at launch).
    const int scroll0 = projScroll;
    int moved = 0;
    int lastY = sy;
    bool dragged = false;
    while (true) {
      // drainBleRx() only runs from loop(); nothing else would reap a
      // pending BLE slot for the whole life of this blocking loop otherwise.
      reapBleLinks(true);
      lastActivityMillis = millis();
      int nx, ny;
      if (!getTouchPoint(nx, ny)) break; // released
      (void) nx; // no rail on this level, so only the vertical delta matters
      moved += ny > lastY ? ny - lastY : lastY - ny;
      lastY = ny;
      if (moved > PROJ_DRAG_TAP_PX) dragged = true;
      // Computed from the gesture's ORIGIN, not accumulated per frame -
      // sessionDragLoop()'s own reasoning: accumulating would drift, because
      // every frame's delta is re-snapped to a step and the roundings would
      // compound.
      projScrollTo(scroll0 - (ny - sy));
      renderProjectsTab(); // notices the offset moved, busts every row, flushes
      delay(15); // matches handleTouch()'s own poll rate
    }
    if (dragged) return;
  }

  // A TAP: level 2 (a project's own sessions, PROJOPEN) is not built yet -
  // it is a later task's interface, not this one's - so a tap on a row does
  // nothing here rather than guessing at a wire verb that does not exist.
#else
  (void) sx; (void) sy;
#endif  // BOARD_HAS_PROJECTS
}
