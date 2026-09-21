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

// ---------- Level 2: one project's sessions ----------
// projLevel/projOpenKey/PSessInfo/psess[]/psessCount/psessTotal are DEFINED
// here for real and merely `extern`-declared in deckhand_display.ino, the
// same split ProjInfo/projects[]/projectCount use and for the identical
// reason (handleLine()'s `projsess` absorption needs the type and the
// storage before this file's own text is concatenated in).
int projLevel = 0;
char projOpenKey[64] = "";

PSessInfo psess[PSESS_SLOTS];
int psessCount = 0;
int psessTotal = 0;
// Has a `projsess` reply EVER arrived for the CURRENTLY OPEN key? Reset to
// false the moment a NEW key is opened (projOpenLevel1()) - projectsEverReceived's
// own shape, scoped to "for THIS project" rather than "ever, for any
// project", because level 1 stays open across many different level-2 visits
// and each one starts with nothing to show for the NEW key even though the
// OLD key's data (still sitting in psess[] until the reply overwrites it)
// would otherwise make this look answered already.
bool psessEverReceived = false;

// Level 2's own fetch-timeout state, INDEPENDENT of level 1's
// projectsPending/projectsFetchFailed/projectsFetchStart - not a
// duplication of the MECHANISM (see checkFetchTimeout() and
// tickProjectsFetch() below, both shared with level 1 verbatim), but a
// second copy of the STATE is unavoidable: switchTab()'s own background
// PROJECTS refresh and a level-2 open can be genuinely in flight AT THE
// SAME TIME (the brief's own verification sequence does exactly this -
// "TAB 2 then PROJOPEN 0" - and the two are not the same request answered
// twice, so sharing one pending flag between them would have the second
// one silently swallowed by the first's own busy guard for as long as the
// first is still in flight).
bool psessPending = false;
unsigned long psessFetchStart = 0;
bool psessFetchFailed = false;

// projLevel PAINTED, not projLevel wanted - projScrollCache's own "last
// actually painted" shape (this file's own header note on why a
// position-only change needs an explicit bust), extended from a scroll
// offset to the level itself. A level change repaints COMPLETELY DIFFERENT
// content into the same content area, so nothing about EITHER level's own
// per-row caches has any business surviving the switch - see
// renderProjectsTab()'s own use of this below.
int projLevelPainted = -1;

// Per-DISPLAY-POSITION signature cache, "title|turns|tod|live" (or
// "MORE|shown|total" for the one honesty row past the real sessions - see
// drawPSessRow()'s own note). PSESS_SLOTS + 1, not PSESS_SLOTS: position
// PSESS_SLOTS itself is that honesty row's own slot when psessCount has
// filled every real slot AND there is still more beyond it, so the array
// must hold one MORE position than there are session slots or that exact
// case indexes off the end of it.
//
// 80 bytes: the host caps title at 40 (so up to 43 with room for an
// ellipsis plus NUL, PSessInfo.title's own size), turns and tod each print
// at most a handful of digits, and the separators and the live flag cost
// four more - comfortably inside 80 with margin, projRowSigCache's own
// "margin is the right side to err on" reasoning (CLAUDE.md: a cache
// shorter than the string it holds silently stops noticing changes past
// that point).
char psessRowSigCache[PSESS_SLOTS + 1][80];
char psessMsgCache[32] = "";
char psessMsg2Cache[16] = "";
// projRowCountCache's own three-sub-states-of-"nothing to draw" shape,
// reusing PROJ_STATE_PENDING/FAILED/EMPTY rather than declaring a second,
// identically-shaped trio - these are level-agnostic BUCKET NAMES, not
// level-1-specific values, and level 2's own tri-state logic
// (renderPSessLevel()) needs exactly the same three buckets for exactly
// the same reason.
int psessRowCountCache = -1;
// Scroll offset, in content pixels, always a multiple of PSESS_STEP -
// projScroll's own shape, see psessScrollTo() (the one place it is
// written).
int psessScroll = 0;
int psessScrollCache = -1;

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

// THE ONE PLACE THE TIMEOUT ARITHMETIC AND ITS REPORT LIVE, shared by BOTH
// PROJECTS levels rather than copied for level 2 - CLAUDE.md, on this exact
// task: "reuse the existing mechanism rather than duplicating it... if you
// find yourself writing the same condition twice, extract it, because a
// comment claiming a shared predicate that was not shared was a finding on
// this very file one round ago." `pending` is taken by REFERENCE so this
// function is the one and only place either level's own pending flag is
// cleared on a timeout; the CALLER still owns setting its own *FetchFailed
// flag and repainting, because those two differ per level in a way this
// helper has no business reaching into (see tickProjectsFetch() below,
// which is what actually ties a level's identity to its own flags).
//
// THE FIRST LINE IS THE WHOLE COST GUARANTEE for whichever level calls
// this with nothing outstanding: tickScrollFetch()'s own guarantee, mirrored
// rather than reinvented, extended to cover two independent callers instead
// of one.
bool checkFetchTimeout(bool& pending, unsigned long start, const char* label) {
  if (!pending) return false;
  const unsigned long cap = usbLinkActive() ? PROJ_FETCH_TIMEOUT_MS : PROJ_FETCH_TIMEOUT_BLE_MS;
  if (millis() - start < cap) return false;
  // sendLineToHost, NOT Serial.printf - tickScrollFetch()'s own choice, and
  // for the same reason: with the cable out, Serial reaches nothing, and a
  // BLE-only session is EXACTLY when this report needs to be visible - it is
  // the transport most likely to have lost the reply in the first place.
  char m[80];
  snprintf(m, sizeof(m), "%s timeout ms=%lu", label, millis() - start);
  sendLineToHost(m);
  pending = false;
  return true;
}

// Called from loop() - tickScrollFetch()'s own shape (scrollback.ino),
// mirrored rather than reinvented. A lost reply is a NORMAL event on BLE,
// not an exotic one, and left unhandled it is an UNRECOVERABLE state
// reachable by a single dropped packet: *Pending stays true forever, so
// every later request for that level logs "busy" and fetches nothing - the
// screen is stuck on "Loading..." until the board reboots, with nothing
// anywhere saying why. This is what breaks that, for BOTH levels: level 1's
// own PROJECTS fetch, and level 2's own PROJSESS fetch - two independent
// pending/failed/start trios (projects.ino's own header note on why they
// cannot share ONE set of flags), but ONE tick, ONE helper, and the SAME
// PROJ_FETCH_TIMEOUT_MS/_BLE_MS allowance for both, because both are
// single-chunk fetches of the same measured order of magnitude (the
// design's own projection: ~175ms for 16 projects, ~200ms for one
// project's 22 sessions).
void tickProjectsFetch() {
  if (checkFetchTimeout(projectsPending, projectsFetchStart, "PROJECTS")) {
    projectsFetchFailed = true;
    if (currentTab == TAB_PROJECTS) renderProjectsTab();
  }
  if (checkFetchTimeout(psessPending, psessFetchStart, "PROJSESS")) {
    psessFetchFailed = true;
    if (currentTab == TAB_PROJECTS) renderProjectsTab();
  }
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

// LEVEL 2'S OWN INSTANCE OF THE SAME PREDICATE, over its own independent
// pending/failed pair - projFetchFailed()'s reasoning above applies verbatim,
// substituting "one project's sessions" for "the project list" throughout.
bool psessDeadEnd() {
  return psessFetchFailed && !psessPending;
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

// WHICH DISPLAY POSITION IS UNDER THIS y, OR -1 - sessionRowAtY()'s own
// question, answered by plain division rather than a per-row walk because
// every row on this level is the same height (this file's own header note:
// no ladder, no band card, one height for every position).
int projRowAtY(int sy) {
  if (sy < PROJ_ROW_Y0) return -1;
  const int rel = sy - PROJ_ROW_Y0 + projScroll;
  const int pos = rel / PROJ_STEP;
  if (pos < 0 || pos >= projectCount) return -1;
  if (rel - pos * PROJ_STEP >= PROJ_ROW_H) return -1; // the gap between rows
  if (!projRowVisible(pos)) return -1;
  return pos;
}

// OPENS LEVEL 2 ON PROJECT `pos` (a display-order index into projects[]) -
// the ONE place either a level-1 row tap or the PROJOPEN command (both in
// deckhand_display.ino) enters level 2, so the two can never drift into
// two different ideas of what "opening a project" resets.
//
// projOpenKey IS SET HERE, BEFORE requestProjSessions() is called, NOT
// inside that function - deliberately, so the key on screen is always
// accurate to what the level is DISPLAYING even on the rare tick where
// requestProjSessions() finds its own fetch slot busy (a level-1
// background refresh from switchTab() still in flight - the brief's own
// verification sequence, "TAB 2 then PROJOPEN 0", can land close enough
// together to hit this) and defers rather than sending immediately. The
// JSON absorption in deckhand_display.ino's handleLine() compares an
// incoming `projsess` reply's own key against THIS value, so it has to be
// right the instant the level opens, not only once the wire request
// actually goes out.
void projOpenLevel1(int pos) {
  strncpy(projOpenKey, projects[pos].key, sizeof(projOpenKey) - 1);
  projOpenKey[sizeof(projOpenKey) - 1] = '\0';
  psessEverReceived = false;
  psessCount = 0;
  psessTotal = 0;
  psessScroll = 0;
  projLevel = 1;
  requestProjSessions(projOpenKey);
  renderProjectsTab();
}

// RETURNS TO LEVEL 0 WITHOUT RE-FETCHING - the task's own requirement. The
// project list already sitting in projects[] (from whichever PROJECTS
// fetch last filled it - the tab-open, or a background refresh) is still
// good: nothing about backing OUT of a project changes what projects exist,
// so re-asking the Mac for the exact same answer it already gave would
// just be latency with no new information. Contrast switchTab()'s own
// TAB_PROJECTS arm, which DOES re-fetch every time, because leaving the
// tab and coming back is a different gesture with no such guarantee (the
// list could genuinely be stale by then).
void projBack() {
  projLevel = 0;
  renderProjectsTab();
}

void requestProjSessions(const char* key) {
  // A SECOND REQUEST WHILE ONE IS IN FLIGHT IS A NO-OP THAT REPORTS
  // PROGRESS, not a second fetch - requestProjects()'s own shape, for the
  // identical reason: the host delivers every trigger-file command (and
  // PROJOPEN, deckhand_display.ino) over BOTH transports, so a cabled board
  // can run this twice within milliseconds. psessPending is its OWN flag,
  // independent of level 1's projectsPending - see this file's header note
  // on why the two levels cannot share one fetch slot.
  if (psessPending) {
    char m[96];
    snprintf(m, sizeof(m), "PROJSESS %s busy ms=%lu", key, millis() - psessFetchStart);
    sendLineToHost(m);
    return;
  }
  psessPending = true;
  psessFetchFailed = false;
  psessFetchStart = millis();
  char m[80];
  snprintf(m, sizeof(m), "PROJSESS %s", key);
  sendLineToHost(m);
}

// ---------- Level 2 scrolling - projScroll*'s own shape at a second list,
// over psessListLen() (real sessions plus, when there is more than fits,
// ONE extra position for the honesty row drawPSessRow() draws in its
// place) rather than psessCount alone. ----------
// THE ONE PLACE psessCount AND psessTotal ARE COMPARED to decide whether
// there is anything past the last row this device actually stored -
// pulled out to one name so drawPSessRow(), the scroll math below, and
// renderPSessLevel() cannot drift into disagreeing about which position is
// the honesty row and which are real sessions.
bool psessHasMore() { return psessTotal > psessCount; }
int psessListLen() { return psessCount + (psessHasMore() ? 1 : 0); }

bool psessScrollActive() { return psessListLen() > PSESS_ROWS; }

bool psessRowVisible(int pos) {
  if (!psessScrollActive()) return true;
  const int top = psessScroll / PSESS_STEP;
  return pos >= top && pos < top + PSESS_ROWS;
}

int psessScrollContentH() { return psessListLen() * PSESS_STEP - PSESS_ROW_GAP; }

int psessScrollMax() {
  const int over = psessScrollContentH() - PSESS_SCROLL_VIEW_H;
  if (over <= 0) return 0;
  return ((over + PSESS_STEP - 1) / PSESS_STEP) * PSESS_STEP;
}

void psessScrollTo(int px) {
  int step = (px + PSESS_STEP / 2) / PSESS_STEP;
  if (step < 0) step = 0;
  int v = step * PSESS_STEP;
  const int mx = psessScrollMax();
  if (v > mx) v = mx;
  psessScroll = v;
}

int psessRowAtY(int sy) {
  if (sy < PSESS_ROW_Y0) return -1;
  const int rel = sy - PSESS_ROW_Y0 + psessScroll;
  const int pos = rel / PSESS_STEP;
  if (pos < 0 || pos >= psessListLen()) return -1;
  if (rel - pos * PSESS_STEP >= PSESS_ROW_H) return -1;
  if (!psessRowVisible(pos)) return -1;
  return pos;
}

// WHOLESALE REPAINT OF ONE ROW - drawProjectRow()'s own split, gated by the
// caller's signature check. TWO LINES, not one (board_es3c35p.h's own
// derivation of PSESS_ROW_H): a title line, trimmed with fitText() against
// the row's REAL pixel budget (not merely the checker's promised 24-
// character minimum - this board's Spleen face fits closer to 34 at this
// row's own width), and a meta line carrying the turn count, the age, and
// the LIVE/ended tag - "Title, age, turn count, and a LIVE / ended tag"
// (docs/superpowers/specs/2026-09-20-sessions-manager-design.md, "Level 2").
void drawPSessRow(int pos) {
  const int y = PSESS_ROW_Y0 + pos * PSESS_STEP - psessScroll;

  uiFillRound(PSESS_ROW_X, y, PSESS_ROW_W, PSESS_ROW_H, R_MD, COLOR_CARD, COLOR_BG);
  uiStrokeRound(PSESS_ROW_X, y, PSESS_ROW_W, PSESS_ROW_H, R_MD, BORDER_CARD, COLOR_LABEL, COLOR_BG);

  setUIFont(T_BODY);
  const int lh = uiLineH(T_BODY);
  // CENTRED AS A PAIR, from PSESS_ROW_H/PSESS_LINE_GAP directly rather than
  // a literal 7 - board_es3c35p.h's own derivation (56 = 16 + 10 + 16 +
  // 2*7) stated as arithmetic here rather than transcribed, so a change to
  // the body face's line height or PSESS_LINE_GAP keeps both lines
  // centred instead of silently drifting off the "2x7 padding" the header
  // promises.
  const int topY = y + (PSESS_ROW_H - 2 * lh - PSESS_LINE_GAP) / 2;
  const int metaY = topY + lh + PSESS_LINE_GAP;

  // THE HONESTY ROW - "a capped list that shows the capped number as the
  // total is a silent lie" (this task's own brief). PSESS_ROWS*PSESS_STEP
  // already lands EXACTLY on the footer with zero slack (board_es3c35p.h),
  // so there is no fixed line anywhere on this screen with room to spare
  // for a floating count the way SESSIONS' own ghost-row design sketches
  // one; this joins the SAME scrollable rhythm every real row uses instead,
  // reachable by scrolling past the last session exactly where a person
  // looking for more would already be looking.
  if (pos == psessCount) {
    const int more = psessTotal - psessCount;
    char line1[40];
    snprintf(line1, sizeof(line1), "%d more session%s", more, more == 1 ? "" : "s");
    char line2[24];
    snprintf(line2, sizeof(line2), "showing %d of %d", psessCount, psessTotal);
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TC_DATUM);
    tft.drawString(line1, PSESS_ROW_X + PSESS_ROW_W / 2, topY);
    tft.drawString(line2, PSESS_ROW_X + PSESS_ROW_W / 2, metaY);
    tft.setTextDatum(TL_DATUM);
    return;
  }

  const PSessInfo& s = psess[pos];
  const uint16_t titleColor = s.live ? COLOR_VALUE : COLOR_LABEL;

  char titleBuf[sizeof(s.title) + 4]; // fitText()'s own worst case: the full stored title plus "..."
  fitText(titleBuf, sizeof(titleBuf), s.title, PSESS_ROW_W - 2 * PSESS_PAD);
  tft.setTextColor(titleColor, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(titleBuf, PSESS_ROW_X + PSESS_PAD, topY);

  // Clamped to four digits for DISPLAY ONLY - PSessInfo.turns itself is
  // untouched - drawProjectRow()'s own "clamp what's shown, not what's
  // stored" rule, applied to a field with a wider realistic range (a turn
  // count, not a transcript count).
  char timeStr[8];
  formatProjTime(s.tod, timeStr, sizeof(timeStr));
  unsigned dispTurns = s.turns > 9999 ? 9999 : s.turns;
  char meta[16];
  snprintf(meta, sizeof(meta), "%ut %s", dispTurns, timeStr);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(meta, PSESS_ROW_X + PSESS_PAD, metaY);

  // LIVE/ended - drawProjectRow()'s own live/COLOR_VALUE convention,
  // reused rather than invented: unlike level 1's projectIsLive() (a
  // device-side forward-encoding heuristic, imprecise at the edges - see
  // its own note), this `live` bit comes straight off the wire from the
  // host's own liveIds check, so it is exact.
  const char* tag = s.live ? "LIVE" : "ended";
  tft.setTextColor(s.live ? COLOR_VALUE : COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(tag, PSESS_ROW_X + PSESS_ROW_W - PSESS_PAD, metaY);
  tft.setTextDatum(TL_DATUM);
}

#endif  // BOARD_HAS_PROJECTS

#if BOARD_HAS_PROJECTS
// LEVEL 0 (the project list) - renderProjectsTab()'s ENTIRE body until this
// task, unchanged below except for its own name: the level dispatch and the
// level-transition clear now live in renderProjectsTab() itself, so this
// function only ever runs its own content, exactly as it did before level
// 2 existed.
void renderProjLevel0() {
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
}

// LEVEL 1 (one project's own sessions) - renderProjLevel0()'s own tri-state
// shape, over psess*/PSESS_* instead of projects*/PROJ_*, and psessDeadEnd()
// where level 0 reads projFetchFailed(). The one real difference:
// psessListLen() (real sessions plus, when capped, the one honesty row) is
// what the "how many positions to draw" and "did the count change" logic
// below reads, never psessCount alone - see drawPSessRow()'s own note on
// why that extra position exists at all.
void renderPSessLevel() {
  if (!psessEverReceived || psessCount == 0) {
    const int state = psessPending  ? PROJ_STATE_PENDING
                     : psessDeadEnd() ? PROJ_STATE_FAILED
                                      : PROJ_STATE_EMPTY;
    if (psessRowCountCache != state) {
      tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
      for (int i = 0; i <= PSESS_SLOTS; i++) psessRowSigCache[i][0] = '\0';
      psessRowCountCache = state;
      psessMsgCache[0] = '\0';
      psessMsg2Cache[0] = '\0';
    }
    const char* msg = state == PROJ_STATE_PENDING ? "Loading sessions..."
                     : state == PROJ_STATE_FAILED  ? "-- could not reach the Mac --"
                                                    : "No sessions found";
    const char* msg2 = state == PROJ_STATE_FAILED ? "tap to retry" : "";
    setUIFont(T_BODY);
    const int msgY1 = CONTENT_Y + 40;
    drawIfChanged(psessMsgCache, sizeof(psessMsgCache), msg, tft.width() / 2, msgY1,
                  T_BODY, 1, COLOR_LABEL, COLOR_BG, TC_DATUM);
    if (msg2[0]) {
      drawIfChanged(psessMsg2Cache, sizeof(psessMsg2Cache), msg2, tft.width() / 2,
                    msgY1 + uiLineH(T_BODY) + 8, T_BODY, 1, COLOR_LABEL, COLOR_BG, TC_DATUM);
    }
  } else {
    if (psessScrollActive()) psessScrollTo(psessScroll); else psessScroll = 0;
    if (psessRowCountCache != psessCount) {
      psessRowCountCache = psessCount;
      tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
      for (int i = 0; i <= PSESS_SLOTS; i++) psessRowSigCache[i][0] = '\0';
    }
    if (psessScroll != psessScrollCache) {
      psessScrollCache = psessScroll;
      tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
      for (int i = 0; i <= PSESS_SLOTS; i++) psessRowSigCache[i][0] = '\0';
    }
    for (int pos = 0; pos < psessListLen(); pos++) {
      if (!psessRowVisible(pos)) continue;
      char sig[80];
      if (pos == psessCount) {
        // THE HONESTY ROW'S OWN SIGNATURE - psessCount and psessTotal are
        // the only two things it draws, so they are the only two things
        // that need to bust it. Both only ever change together with a
        // fresh reply, which already busts every cache via the
        // psessRowCountCache check above - this still gives it a real
        // signature, per CLAUDE.md's "every field you draw must be in the
        // row's signature", rather than relying solely on that wholesale
        // bust to keep it correct.
        snprintf(sig, sizeof(sig), "MORE|%d|%d", psessCount, psessTotal);
      } else {
        const PSessInfo& s = psess[pos];
        // EVERY FIELD DRAWN MUST BE IN THIS SIGNATURE - title, turns and
        // tod are drawn directly; `live` is not itself drawn as text but
        // its VALUE is (the title's colour AND the tag's own text/colour),
        // and a colour-only change reaches no text-comparing cache at all
        // (CLAUDE.md) unless it is signed explicitly - drawProjectRow()'s
        // own rule, restated here because `live` is a REAL wire bit at
        // this level rather than a device-side heuristic.
        snprintf(sig, sizeof(sig), "%s|%u|%ld|%d", s.title, (unsigned) s.turns, s.tod, s.live);
      }
      if (strncmp(sig, psessRowSigCache[pos], sizeof(psessRowSigCache[pos])) != 0) {
        strncpy(psessRowSigCache[pos], sig, sizeof(psessRowSigCache[pos]) - 1);
        psessRowSigCache[pos][sizeof(psessRowSigCache[pos]) - 1] = '\0';
        drawPSessRow(pos);
      }
    }
  }
}
#endif  // BOARD_HAS_PROJECTS

// The two functions every dispatch site in deckhand_display.ino already
// calls unconditionally (switchTab(), forceFullRepaint(), stopOctopus(),
// handleTouch(), the once-a-second tick) - see that file's own note on why
// the `#if` sits INSIDE each body rather than around the whole function.
void renderProjectsTab() {
#if BOARD_HAS_PROJECTS
  // LEVEL TRANSITIONS GET THE SAME WHOLESALE-CLEAR-AND-BUST TREATMENT the
  // tri-state loading/failed/empty sentinel gets inside EACH level's own
  // render function, for the identical CLAUDE.md reason: a level change
  // repaints COMPLETELY DIFFERENT content into the same content area, and
  // no per-row cache from the OTHER level has any business surviving the
  // switch - a psess row's cache slot 3 and a proj row's cache slot 3
  // describe unrelated things. projLevelPainted is what was last actually
  // PAINTED (never rendered = -1) - projScrollCache's own "last painted,
  // not last requested" shape, extended from a scroll position to the
  // level itself.
  if (projLevelPainted != projLevel) {
    tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
    projLevelPainted = projLevel;
    projRowCountCache = -1;
    for (int i = 0; i < PROJ_SLOTS; i++) projRowSigCache[i][0] = '\0';
    projMsgCache[0] = '\0';
    projMsg2Cache[0] = '\0';
    projScrollCache = -1;
    psessRowCountCache = -1;
    for (int i = 0; i <= PSESS_SLOTS; i++) psessRowSigCache[i][0] = '\0';
    psessMsgCache[0] = '\0';
    psessMsg2Cache[0] = '\0';
    psessScrollCache = -1;
  }
  if (projLevel == 1) renderPSessLevel(); else renderProjLevel0();
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
#endif  // BOARD_HAS_PROJECTS
}

void handleProjectsTouch(int sx, int sy) {
#if BOARD_HAS_PROJECTS
  if (projLevel == 1) { handlePSessTouch(sx, sy); return; }
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

  // A TAP OPENS LEVEL 2 - projRowAtY() answers "which row, if any" the same
  // way sessionRowAtY() does for SESSIONS; -1 (a gap, or below the last
  // row) is ignored rather than guessed. projOpenLevel1() is the ONE place
  // this and PROJOPEN (deckhand_display.ino) both enter level 2, so the two
  // routes can never drift into two different ideas of what "opening a
  // project" resets.
  int pos = projRowAtY(sy);
  if (pos >= 0) projOpenLevel1(pos);
#else
  (void) sx; (void) sy;
#endif  // BOARD_HAS_PROJECTS
}

#if BOARD_HAS_PROJECTS
// LEVEL 1's own touch handler - handleProjectsTouch()'s level-0 shape,
// mirrored over psess*/PSESS_*. The one thing it does NOT need of its own:
// a "back" affordance - that lives in deckhand_display.ino's handleTouch()
// (tapping the PROJECTS tab a second time), the same "same tab is still
// back" idiom the SESSIONS detail card already uses, so nothing INSIDE the
// content area needs to reserve a control for it.
void handlePSessTouch(int sx, int sy) {
  (void) sx;
  if (!psessEverReceived || psessCount == 0) {
    if (psessDeadEnd()) {
      requestProjSessions(projOpenKey);
      renderProjectsTab();
    }
    return;
  }
  if (sy < PSESS_ROW_Y0) return;

  if (psessScrollActive()) {
    const int scroll0 = psessScroll;
    int moved = 0;
    int lastY = sy;
    bool dragged = false;
    while (true) {
      reapBleLinks(true);
      lastActivityMillis = millis();
      int nx, ny;
      if (!getTouchPoint(nx, ny)) break; // released
      (void) nx;
      moved += ny > lastY ? ny - lastY : lastY - ny;
      lastY = ny;
      if (moved > PSESS_DRAG_TAP_PX) dragged = true;
      psessScrollTo(scroll0 - (ny - sy));
      renderProjectsTab();
      delay(15);
    }
    if (dragged) return;
  }

  // A TAP OPENS LEVEL 3 - this session's own transcript, in the EXISTING
  // scrollback surface (scrollback.ino's scrollOpenById()), the whole point
  // of this task ("no new reader"). psessRowAtY() answers "which row, if
  // any" the same way projRowAtY()/sessionRowAtY() do for their own lists;
  // -1 (a gap) and the honesty row past the last real session (pos ==
  // psessCount, "N more sessions" - drawPSessRow()'s own note) both do
  // nothing, the identical reason a tap on SESSIONS' own overflow row is
  // inert: there is no session at that position to open.
  int pos = psessRowAtY(sy);
  if (pos >= 0 && pos < psessCount) {
    // scrollProjLive SET FIRST, BEFORE scrollOpenById() - that function's
    // own two-argument signature has no room for the wire's `live` bit, and
    // scrollOpenById()'s own header explains why the caller states it here
    // rather than scrollOpenById() trying to re-derive it. RESUME's guard
    // (deckhand_display.ino) reads it to refuse a headless turn against a
    // session someone may be driving interactively right now.
    scrollProjLive = psess[pos].live != 0;
    scrollOpenById(psess[pos].id, psess[pos].title);
  }
}
#endif  // BOARD_HAS_PROJECTS
