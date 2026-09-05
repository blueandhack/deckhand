// THE REPLY PANEL - the compose surface's first screen, and the one that exists
// because most answers are not prose.
//
// WHY THERE IS A PANEL AT ALL. Every key on both boards misses this repo's own
// fingertip floor IN WIDTH and cannot be made to clear it: KB_PITCH is 4.27mm on
// board 1 and 4.93mm here against a 7.1mm floor, and floor(BOARD_W / TAP_MIN) is
// 6 columns on both boards where QWERTY needs 10. No ten-column layout clears it.
// So the sharpened keyboard makes the sub-floor key HIT better, and THIS screen is
// what stops asking: a reply is one tap on a TAP_MIN band, a token the question
// already printed is one tap, and the keyboard is a sheet behind TYPE... for the
// case that really is prose.
//
// THE FOUR CONTROL KINDS ARE DISTINGUISHED BY FORM, NEVER BY COLOUR - CLAUDE.md
// rules colour-alone out in as many words, and an earlier draft of this design
// separated them by stroke TINT alone:
//
//   send      filled COLOR_GOOD, label CENTRED           - the colour SEND owns
//   insert    COLOR_CARD fill, NO STROKE, LEFT, "+ "     - a flag is literal text
//   reuse     COLOR_CARD fill, COLOR_LABEL stroke, LEFT  - a recall is not an action
//   navigate  COLOR_CARD fill, COLOR_ACCENT stroke, C    - the shape ?123 already has
//
// Fill, stroke and ALIGNMENT all differ, so the panel still reads with the palette
// flattened. What does NOT differ is the typeface, and that is worth stating rather
// than claiming otherwise: the design says "FONT_CODE" for the insert kind, and on
// both boards the code face IS the body face (T_BODY is Cozette 6x13 on board 1 and
// Spleen 8x16 here - one uniform-advance mono face per board), so there is no second
// typeface to spend. docs/design/compose/compose.js draws all four kinds at its font
// 2 for the same reason.
//
// THE COLUMN. Every band is TAP_MIN and every drawn button is KB_ACT_DRAWN, centred
// by KB_ACT_DY - Task 3's three numbers, reused rather than re-derived - and
// ADJACENT BANDS ARE CONTIGUOUS: the visual gap comes from the inset, so the 4px
// strip between two reply buttons where a tap used to do nothing is gone. The board
// headers carry the vertical terms (COMPOSE_TOP / COMPOSE_PROMPT_H / COMPOSE_GAP /
// COMPOSE_LEGEND_H / COMPOSE_DRAFT_H) with the whole budget written out beside them;
// settings-geom-check.mjs walks it, and docs/design/compose/ is the picture.
//
// ONE TRANSLATION UNIT, AND THIS FILE IS THIRD. The build concatenates
// deckhand_display.ino first, then the rest alphabetically - audio.ino, THIS FILE,
// keyboard.ino, ... - so everything keyboard.ino declares (KB_KEY_GAP, kbActX,
// KB_ACT_COLS) is NOT visible here as a name, even though the two files end up in
// one unit. KB_MAX_BYTES and kbText are NOT in that set: they live in
// deckhand_display.ino, beside each other, and this file names them both. Functions are fine (the builder generates a prototype for every one of
// them); plain globals and const ints are not. Where this file needs one of those it
// re-derives it from the HEADER constants both files share, and says so at the site.

// ---------------------------------------------------------------------------
// State. All of it is read by deckhand_display.ino's handleTouch and by
// keyboard.ino's drawKeyboard/closeCompose/kbInsert, which is why the first two
// carry an `extern` in the main file - a function gets a generated prototype from
// anywhere in the sketch, a global does not.
// ---------------------------------------------------------------------------
// WHICH SCREEN OF THE COMPOSE SURFACE IS UP - COMPOSE_SCREEN_PANEL (0, the root)
// or COMPOSE_SCREEN_KEYS (1, the sheet behind TYPE...). composeActive says the
// surface is up; this says which screen. The two were once a flag named for the
// KEYBOARD, meaning "the keyboard is up", plus a second bool meaning "no, the
// panel is" - TWO NAMES FOR ONE STATE, and exactly how a screen and its touch
// router end up disagreeing. That is the silent bug closeCompose()'s own comment
// records. The old names are deliberately not written here: a checker asserts
// neither survives anywhere in these three files, and a comment naming one would
// pass or fail that assertion for a reason that has nothing to do with the code.
//
// ONLY handleTouch READS THIS DIRECTLY, because it is the one place that has to
// decide which screen a tap belongs to. Every other seam asks composeOnPanel()
// or composeOnKeys(), so the surface-is-up half of the question can never be
// forgotten at one of them.
uint8_t composeScreen = COMPOSE_SCREEN_PANEL;
bool composeOnPanel() { return composeActive && composeScreen == COMPOSE_SCREEN_PANEL; }
bool composeOnKeys()  { return composeActive && composeScreen == COMPOSE_SCREEN_KEYS; }
// The token row pages rather than counting: the row fits two chips on both boards
// and the host ships up to four, so an "N>" label that only counted would leave
// half of them unreachable.
int composeChipPage = 0;
// A one-tap send has no undo, so what the panel does afterwards is show a receipt
// and collapse the action row to DONE - nothing that looks like SEND is left on the
// glass to press again.
bool composeSent = false;
// THE WHOLE DRAFT FITS. This was askOpts[4][34]'s width plus a NUL, sized when
// the only thing that reached it was a one-tap option label - and then SEND on
// this row started leaving a receipt too, which can be the full 150-byte draft.
// A copyField into 36 bytes would have cut it at 35 with no marker, so the
// receipt would have SILENTLY disagreed with what went to Claude. The 115 extra
// bytes are DRAM, once, not per session. KB_MAX_BYTES + 1 rather than 151: the
// literal is how the two drift when the cap moves.
char composeSentText[KB_MAX_BYTES + 1] = "";
// True while composeInsertChip is spooling a token in, so the draft line repaints
// ONCE at the end instead of once per byte. A 38-byte path would otherwise repaint
// that line 38 times on a panel that draws straight to the glass.
bool composeBatching = false;
// The action row's TESTED zones, written by drawComposeActions and read by
// composeTouch - the same contract kbActX/kbActW have with drawKbActions and
// kbTouch, and for the same reason: two functions computing one column width
// inline is how a hit test and a draw disagree.
const int COMPOSE_ACT_MAX = 3;
int composeActX[COMPOSE_ACT_MAX] = {0, 0, 0}, composeActW[COMPOSE_ACT_MAX] = {0, 0, 0};
// How many columns the row was last DRAWN with. The row only changes shape when it
// collapses to DONE, so the band is cleared then and never on a keystroke - a clear
// on every repaint is the flicker this repo's whole change-only discipline exists
// to avoid, and no clear at all would leave the three-column row under the one.
int composeActDrawn = 0;

// ---------------------------------------------------------------------------
// The lane's three columns. The cell is CARD_W / 3 and THE GAP BELONGS TO THE
// BUTTON ON ITS LEFT, exactly as KB_PITCH relates to KB_KEY_W; the remainder lands
// on the last column so the row closes on the lane exactly - 72 + 72 + 72 = 216 on
// board 1, 98 + 98 + 100 = 296 here.
// ---------------------------------------------------------------------------
const int COMPOSE_COLS = 3;
// The horizontal half of the drawn/tested split, and it is THE KEY'S OWN GAP rather
// than a new number: keyboard.ino spells the same expression KB_KEY_GAP, which this
// file cannot see (it is concatenated later), so the two header constants are read
// again here rather than a 2 being written down.
const int COMPOSE_KEY_GAP = KB_PITCH - KB_KEY_W;      // 2 on both boards
int composeCellW() { return CARD_W / COMPOSE_COLS; }
int composeColX(int c) { return CARD_X + c * composeCellW(); }
int composeColW(int c) {
  return c == COMPOSE_COLS - 1 ? CARD_W - (COMPOSE_COLS - 1) * composeCellW() : composeCellW();
}

// ---------------------------------------------------------------------------
// The vertical column, as functions rather than as constants, so the hit test and
// the draw read ONE source. Each band's top is the previous band's top plus its
// height; the action band is anchored at KB_ACT_Y, which both screens share.
// ---------------------------------------------------------------------------
// The prompt card holds n wrapped lines of the question under a label row, and n is
// DERIVED BACK OUT of the card's own height rather than carried as a second
// constant: 5 + KB_LINE_PITCH + 4 + n * KB_LINE_PITCH + 4 is what the headers say
// COMPOSE_PROMPT_H is, so n is 2 on board 1 and 3 here, and it cannot disagree with
// the card it is drawn into.
const int COMPOSE_PROMPT_LINES = (COMPOSE_PROMPT_H - 5 - KB_LINE_PITCH - 4 - 4) / KB_LINE_PITCH;
const int COMPOSE_REPLY_BANDS = 2;
int composePromptY()  { return COMPOSE_TOP; }
int composeLegend1Y() { return composePromptY() + COMPOSE_PROMPT_H + COMPOSE_GAP; }
int composeReplyY()   { return composeLegend1Y() + COMPOSE_LEGEND_H; }
int composeLegend2Y() { return composeReplyY() + COMPOSE_REPLY_BANDS * TAP_MIN; }
int composeTokenY()   { return composeLegend2Y() + COMPOSE_LEGEND_H; }
int composeDraftY()   { return composeTokenY() + TAP_MIN; }
int composeLegend3Y() { return composeDraftY() + COMPOSE_DRAFT_H; }
int composeRecentY()  { return composeLegend3Y() + COMPOSE_LEGEND_H; }
// RECENTS FIT ONLY WHERE THERE IS A WHOLE BAND LEFT FOR THEM, and that is asked of
// the geometry rather than of the board number: board 1 has 31px between the last
// legend and the action row and board 2 has 110, so this is false there and true
// here. ONE row, not two: the ring holds four and a row is three columns, so a
// second row could never hold more than one entry - the 64px that leaves on board 2
// is the residual the spec names as the first thing to spend if paging annoys.
bool composeRecentsFit() { return KB_ACT_Y - composeRecentY() >= TAP_MIN; }

// ---------------------------------------------------------------------------
// ONE CONTROL, four kinds. `cellW` is the TESTED cell; the drawn button is one
// COMPOSE_KEY_GAP narrower and KB_ACT_DRAWN tall, centred in the band by KB_ACT_DY.
// ---------------------------------------------------------------------------
#define COMPOSE_SEND     0
#define COMPOSE_INSERT   1
#define COMPOSE_REUSE    2
#define COMPOSE_NAVIGATE 3
void drawComposeControl(uint8_t kind, int cx, int bandY, int cellW, const char* label) {
  const int w = cellW - COMPOSE_KEY_GAP, h = KB_ACT_DRAWN, y = bandY + KB_ACT_DY;
  const uint16_t fill = kind == COMPOSE_SEND ? COLOR_GOOD : COLOR_CARD;
  uiFillRound(cx, y, w, h, R_MD, fill, COLOR_BG);
  // The stroke is what separates reuse from insert with the palette flattened, so
  // only ONE kind is unstroked and it is the one whose label carries a literal "+ ".
  if (kind == COMPOSE_REUSE)         uiStrokeRound(cx, y, w, h, R_MD, BORDER_CTRL, COLOR_LABEL, COLOR_BG);
  else if (kind == COMPOSE_NAVIGATE) uiStrokeRound(cx, y, w, h, R_MD, BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
  setUIFont(T_BODY);
  tft.setTextColor(kind == COMPOSE_SEND ? COLOR_BG : COLOR_VALUE, fill);
  char shown[52];
  const bool left = (kind == COMPOSE_INSERT || kind == COMPOSE_REUSE);
  // fitText measures the LIVE font, so setUIFont above it is not optional. The
  // inset is 4px a side on a left-aligned control (the label starts at +4) and 2px
  // a side on a centred one, which is what the mock's own fit() lanes are.
  fitText(shown, sizeof(shown), label, left ? w - 8 : w - 4);
  if (left) {
    tft.setTextDatum(ML_DATUM);
    tft.drawString(shown, cx + 4, y + h / 2);
  } else {
    tft.setTextDatum(MC_DATUM);
    tft.drawString(shown, cx + w / 2, y + h / 2);
  }
  tft.setTextDatum(TL_DATUM);
}

// A legend row: the sentence that says what the band under it DOES. T_META,
// COLOR_LABEL, one cell centred in COMPOSE_LEGEND_H.
void drawComposeLegend(int bandY, const char* text) {
  setUIFont(T_META);
  char shown[48];
  fitText(shown, sizeof(shown), text, CARD_W - 12);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(shown, CARD_X + 6, bandY + (COMPOSE_LEGEND_H - uiLineH(T_META)) / 2);
}

// ---------------------------------------------------------------------------
// The prompt card: who asked, what they asked, and a PEEK tag for the rest of it.
// The whole card is one tap target and it is far over TAP_MIN, so nothing here is
// excepted from the floor.
// ---------------------------------------------------------------------------
void drawComposePrompt(int idx) {
  const int y = composePromptY();
  uiFillRound(CARD_X, y, CARD_W, COMPOSE_PROMPT_H, R_MD, COLOR_CARD, COLOR_BG);
  char name[24];
  copyField(name, sizeof(name), sessions[idx].name);
  for (char* p = name; *p; p++) if (*p >= 'a' && *p <= 'z') *p -= 32;
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  char shown[40];
  // The label lane stops short of the PEEK tag rather than running under it.
  const int tagW = tft.textWidth("PEEK") + 6;
  fitText(shown, sizeof(shown), name, CARD_W - 12 - tagW);
  tft.drawString(shown, CARD_X + 6, y + 5);
  // PEEK is only true where there is a detail to peek AT; without one the tap still
  // does nothing, so the tag would be a control that lies.
  if (kbHasDetail()) {
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.setTextDatum(TR_DATUM);
    tft.drawString("PEEK", CARD_X + CARD_W - 6, y + 5);
    tft.setTextDatum(TL_DATUM);
  }
  drawWrappedText(sessions[idx].askTitle, CARD_X + 6, y + 5 + KB_LINE_PITCH + 4,
                  T_BODY, KB_LINE_PITCH, CARD_W - 12, 0, COMPOSE_PROMPT_LINES,
                  COLOR_VALUE, COLOR_CARD);
}

// ---------------------------------------------------------------------------
// The reply buttons: the ask's own options, three to a band, answered in ONE TAP.
// ---------------------------------------------------------------------------
void drawComposeReplies(int idx) {
  const int n = sessions[idx].askOptCount;
  for (int i = 0; i < COMPOSE_REPLY_BANDS; i++) {
    const int bandY = composeReplyY() + i * TAP_MIN;
    for (int c = 0; c < COMPOSE_COLS; c++) {
      const int k = i * COMPOSE_COLS + c;
      if (k >= n) continue;
      drawComposeControl(COMPOSE_SEND, composeColX(c), bandY, composeColW(c),
                         sessions[idx].askOpts[k]);
    }
  }
}

// ---------------------------------------------------------------------------
// THE TOKEN CHIPS. The label may be truncated; THE VALUE NEVER IS - see
// composeInsertChip. Two chips a row with the pager's lane reserved as column 2
// BEFORE the chips are laid out, so a wide chip can never run underneath it.
// ---------------------------------------------------------------------------
const int COMPOSE_CHIPS_PER_PAGE = COMPOSE_COLS - 1;    // the third column is the pager's
int composeChipPages(int idx) {
  const int n = sessions[idx].askChipCount;
  return n <= 0 ? 0 : (n + COMPOSE_CHIPS_PER_PAGE - 1) / COMPOSE_CHIPS_PER_PAGE;
}
// One chip. fitText lives HERE and in no other function on this path: this is the
// only place a token is shortened, and it is shortened for DRAWING alone.
void drawComposeChip(int col, int bandY, const char* value) {
  char label[52];
  snprintf(label, sizeof(label), "+ %s", value);
  drawComposeControl(COMPOSE_INSERT, composeColX(col), bandY, composeColW(col), label);
}
void drawComposeTokens(int idx) {
  const int bandY = composeTokenY();
  const int n = sessions[idx].askChipCount, pages = composeChipPages(idx);
  if (composeChipPage >= pages) composeChipPage = 0;
  tft.fillRect(CARD_X, bandY, CARD_W, TAP_MIN, COLOR_BG);
  for (int c = 0; c < COMPOSE_CHIPS_PER_PAGE; c++) {
    const int k = composeChipPage * COMPOSE_CHIPS_PER_PAGE + c;
    if (k >= n) break;
    drawComposeChip(c, bandY, sessions[idx].askChips[k]);
  }
  // The pager is a REAL control and not a count. Drawn only when there is a second
  // page to reach: a "1/1>" that cannot move is a control that does nothing, which
  // is worse than an empty cell.
  if (pages > 1) {
    char lbl[10];
    snprintf(lbl, sizeof(lbl), "%d/%d>", composeChipPage + 1, pages);
    drawComposeControl(COMPOSE_NAVIGATE, composeColX(COMPOSE_COLS - 1), bandY,
                       composeColW(COMPOSE_COLS - 1), lbl);
  }
}

// ---------------------------------------------------------------------------
// THE DRAFT LINE. Repainted WHOLESALE on every keystroke, exactly as drawKbText()
// already is, rather than through a change-only cache: this string changes per
// character, and a cache shorter than the string it holds silently stops noticing
// changes past that point - this codebase's oldest bug. In the sent state it is a
// receipt instead, and CLR goes with the draft it would have cleared.
//
// CLR IS THE ONLY CONTROL ON THIS SCREEN UNDER TAP_MIN, and only in HEIGHT: the
// line is one text cell plus its air, so it cannot be TAP_MIN tall without a band
// board 1 does not have. It is the right control to spend that on - a miss costs
// one more tap and loses nothing, because the draft is still on the glass and still
// editable character by character. It is TAP_MIN WIDE, so it is short in one axis.
// ---------------------------------------------------------------------------
int composeClrX() { return CARD_X + CARD_W - TAP_MIN; }
void drawComposeDraft() {
  const int y = composeDraftY();
  tft.fillRect(CARD_X, y, CARD_W, COMPOSE_DRAFT_H, COLOR_BG);
  setUIFont(T_BODY);
  char shown[64];   // fitText bounds by WIDTH, so this only has to beat the widest lane
  if (composeSent) {
    // Sized from the cap, not from the option labels that used to be all this
    // held: "SENT: " plus a full-length draft plus the NUL.
    char line[KB_MAX_BYTES + 8];
    snprintf(line, sizeof(line), "SENT: %s", composeSentText);
    fitText(shown, sizeof(shown), line, CARD_W - 12);
    tft.setTextColor(COLOR_GOOD, COLOR_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(shown, CARD_X + 6, y + 4);
    return;
  }
  fitText(shown, sizeof(shown), kbLen > 0 ? kbText : "(empty)", CARD_W - 12 - TAP_MIN);
  tft.setTextColor(kbLen > 0 ? COLOR_VALUE : COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(shown, CARD_X + 6, y + 4);
  // The KEY's radius, not the card's: this is a key-sized control on a tight line.
  const int cw = TAP_MIN - COMPOSE_KEY_GAP, ch = COMPOSE_DRAFT_H - 2;
  uiFillRound(composeClrX(), y, cw, ch, KB_KEY_R, COLOR_CARD, COLOR_BG);
  uiStrokeRound(composeClrX(), y, cw, ch, KB_KEY_R, BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
  setUIFont(T_META);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("CLR", composeClrX() + cw / 2, y + ch / 2);
  tft.setTextDatum(TL_DATUM);
}

// ---------------------------------------------------------------------------
// RECENTS. The row exists only where the column has a band for it, and where it
// does NOT the panel SAYS SO on the glass rather than leaving a gap the reader has
// to interpret - the same rule the device commands follow, arriving at a row that
// is absent instead of at a refusal that is silent.
//
// THE RING ITSELF IS TASK 12 OF THIS PLAN. Until it lands the count is 0 and the
// legend names that as the cause too, so this band is never three blank cells with
// no explanation.
// ---------------------------------------------------------------------------
uint8_t composeRecentCount = 0;
void drawComposeRecents() {
  if (!composeRecentsFit()) {
    drawComposeLegend(composeLegend3Y(), "RECENTS: NO ROOM ON THIS PANEL");
    return;
  }
  drawComposeLegend(composeLegend3Y(), composeRecentCount ? "RECENT - TAP TO REPLACE THE DRAFT"
                                                          : "RECENT - NOTHING SENT YET");
}

// ---------------------------------------------------------------------------
// THE ACTION BAND, at exactly the KB_ACT_Y the keyboard's is - derived rather than
// arranged, since both columns are fixed above it and both close on BOARD_H, so the
// two screens cannot disagree about where SEND lives.
//
// FRACS ARE PROPORTIONS, NOT CELLS: {1,1,2} puts SEND at half the lane and the
// other two at a quarter each, so SEND is EXACTLY twice DISCARD with a third
// control still on the row. TYPE... is the only bridge from this panel to free
// text, and an earlier draft of this design parked it on the draft line - the one
// sub-floor band on the screen - after reading the lane as three cells. That made
// the design's own 20% case the hardest thing on the screen to hit.
// ---------------------------------------------------------------------------
void drawComposeActions() {
  const bool draft = kbLen > 0;
  const int n = composeSent ? 1 : 3;
  // Cleared only when the row CHANGES SHAPE (three controls collapsing to DONE).
  // uiButton fills its whole rect, so a same-shape repaint covers its own pixels
  // and a clear would only add a flash on the board that draws straight to glass.
  if (composeActDrawn != n) tft.fillRect(CARD_X, KB_ACT_Y, CARD_W, KB_ACT_H, COLOR_BG);
  if (composeSent) {
    const char* labels[1] = { "DONE" };
    const uint16_t tints[1] = { COLOR_ACCENT };
    const uint8_t fills[1] = { 0 };
    const uint8_t fracs[1] = { 1 };
    uiActionRow(KB_ACT_Y, KB_ACT_H, KB_ACT_DRAWN, KB_ACT_DY, labels, tints, fills,
                fracs, 1, composeActX, composeActW);
    composeActW[1] = composeActW[2] = 0;    // "no control here", the way kbTouch reads it
  } else {
    // LABEL AND COLOUR, never colour alone: with a draft to lose the left key says
    // DISCARD in COLOR_WARN, and with nothing to lose it is CLOSE and destroys
    // nothing. SEND says CLOSED when the window has gone - the label carries the
    // cause, because a control that is merely dim says only "no".
    const char* labels[3] = { draft ? "DISCARD" : "CLOSE", "TYPE...",
                              kbWindowClosed ? "CLOSED" : "SEND" };
    const uint16_t tints[3] = { draft ? COLOR_WARN : COLOR_ACCENT, COLOR_ACCENT,
                                (draft && !kbWindowClosed) ? COLOR_GOOD : COLOR_LABEL };
    const uint8_t fills[3] = { 0, 0, (uint8_t)((draft && !kbWindowClosed) ? 1 : 0) };
    const uint8_t fracs[3] = { 1, 1, 2 };
    uiActionRow(KB_ACT_Y, KB_ACT_H, KB_ACT_DRAWN, KB_ACT_DY, labels, tints, fills,
                fracs, 3, composeActX, composeActW);
  }
  composeActDrawn = n;
}

// ---------------------------------------------------------------------------
// THE ASK WENT AWAY UNDER THE PANEL. kbSessionIdx goes to -1 the moment the 5s
// tick cannot find the prompt this surface was opened for - it expired, or it
// was answered on the Mac - and from then on there is no sessions[] row to draw
// a prompt card, a reply button or a token from.
//
// WHAT THIS REPLACES IS THE DEFECT, not a blank area: the panel used to keep the
// dead ask's option buttons on the glass, filled COLOR_GOOD and looking exactly
// as live as they had a second earlier, while a tap on one did nothing at all.
// A control that is still advertised after it stopped working is the same class
// of lie as a refusal with no cause, so the buttons come OFF and the card SAYS
// WHY. The draft is untouched and the action row still carries CLOSE/DISCARD,
// because throwing away a sentence someone spent a minute on is the worst
// outcome available here - the rule drawKbActions already states for the
// keyboard's side of the same transition.
// ---------------------------------------------------------------------------
void drawComposeGone() {
  const int y = composePromptY();
  uiFillRound(CARD_X, y, CARD_W, COMPOSE_PROMPT_H, R_MD, COLOR_CARD, COLOR_BG);
  setUIFont(T_META);
  tft.setTextColor(COLOR_WARN, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  // In message mode nothing expired - the SESSION stopped being READY - so
  // "answer on your Mac" would be answering a question nobody asked. Same
  // distinction drawKbActions draws, and the same two causes.
  tft.drawString(kbIsMessage() ? "SESSION NO LONGER READY" : "THIS PROMPT HAS CLOSED",
                 CARD_X + 6, y + 5);
  drawWrappedText(kbIsMessage() ? "Nothing is waiting on this. Your draft is still here."
                                : "Answered or expired. Your draft is still here.",
                  CARD_X + 6, y + 5 + KB_LINE_PITCH + 4, T_BODY, KB_LINE_PITCH,
                  CARD_W - 12, 0, COMPOSE_PROMPT_LINES, COLOR_VALUE, COLOR_CARD);
  drawComposeLegend(composeLegend1Y(), "REPLY: NO ASK, NO OPTIONS");
  drawComposeLegend(composeLegend2Y(), "INSERT: NO ASK, NO TOKENS");
}

// The whole panel. Called from drawKeyboard(), which is the ONE screen-painting
// entry point the compose surface has - openCompose()'s last act, and where BACK
// and TYPE... arrive too.
void drawCompose() {
  const int idx = kbSessionIdx;
  tft.fillScreen(COLOR_BG);
  // NO EARLY RETURN ON A MISSING SESSION. It used to return here having drawn
  // NOTHING, which meant that once the ask went away every repaint of this
  // screen - the peek closing, a keystroke, the window-closed transition - left
  // whatever was already on the glass. The three bands that need sessions[idx]
  // are the three inside this branch; everything below it is the surface's own.
  if (idx >= 0 && idx < sessionCount) {
    drawComposePrompt(idx);
    drawComposeLegend(composeLegend1Y(), sessions[idx].askOptCount ? "REPLY - ONE TAP SENDS"
                                                                  : "REPLY: THIS ASK OFFERS NO OPTIONS");
    drawComposeReplies(idx);
    drawComposeLegend(composeLegend2Y(), sessions[idx].askChipCount ? "INSERT AT THE CARET"
                                                                   : "INSERT: NO TOKENS IN THIS ASK");
    drawComposeTokens(idx);
  } else {
    drawComposeGone();
  }
  drawComposeDraft();
  drawComposeRecents();
  composeActDrawn = 0;          // the fillScreen took the row's pixels with it
  drawComposeActions();
  // The peek owns the lower half of the panel when it is up, exactly as it owns the
  // keys on the other screen. Drawn LAST so it sits over what it covers.
  if (kbPeekPage >= 0) drawKbPeek();
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}

// THE WINDOW-CLOSED TRANSITION, the panel's half. The 5s tick owns the flag;
// this owns what the panel does about it, so the tick does not have to know that
// three of the panel's bands are drawn out of a sessions[] row that has just
// gone. One full repaint on a transition that happens once per ask - not per
// tick, and not per keystroke - which is the same trade the keyboard's side of
// this transition already makes when it clears and rewraps its action band.
void composeWindowClosed() {
  // The peek reads the ask's DETAIL, so with no ask there is nothing to page.
  // Left up it would be an overlay drawKbPeek() declines to paint over a screen
  // whose pager still swallows every tap - a modal with nothing in it.
  if (!kbHasDetail()) kbPeekPage = -1;
  drawCompose();
}

// ---------------------------------------------------------------------------
// MOVING BETWEEN THE TWO SCREENS. Both are a screen change and NOTHING ELSE:
// neither touches kbText, kbLen or kbCaret. That shared draft is the whole
// reason the two screens compose rather than coexist - a chip tapped on the
// panel is editable on the keyboard, and a sentence typed on the keyboard is on
// the panel's draft line when you come back. Clearing it in either direction
// would make TYPE... a destructive control that says nothing about it.
//
// Both repaint through drawKeyboard(), the surface's ONE screen-painting entry
// point, which routes on composeScreen - so the flag is set before the call and
// there is no second place that decides what a screen looks like.
// ---------------------------------------------------------------------------
void composeOpenKeyboard() {
  composeScreen = COMPOSE_SCREEN_KEYS;
  drawKeyboard();
}
// IS THERE A PANEL BEHIND THE KEYBOARD? Asked of the surface's own state rather
// than remembered in a third flag: the reply panel is drawn out of an ASK - its
// options, its tokens, its prompt - and a message to a READY session has no ask
// at all, so for a message the surface is one screen and the keyboard is its
// root. That is the one case where the keyboard's left key is still the way OUT
// rather than the way BACK, and it says so on its own label.
bool composeHasPanel() { return !kbIsMessage(); }
void composeBackToPanel() {
  if (!composeHasPanel()) {
    // Unreachable from the glass (drawKbActions draws no BACK without a panel),
    // and it names its cause anyway: a silent no-op here would look exactly like
    // a dropped press on the one screen where a press is hardest to land.
    Serial.println("COMPOSE: BACK refused: this is a message to a READY session, which has no reply panel behind it");
    return;
  }
  composeScreen = COMPOSE_SCREEN_PANEL;
  drawKeyboard();
}

// Called by kbInsert/kbBackspace instead of the keyboard's own two repaints when
// the panel is the screen that is up. The draft line and the action row are the
// only two things on this screen a keystroke can change.
void composeAfterEdit() {
  if (composeBatching) return;
  drawComposeDraft();
  drawComposeActions();
}

// ---------------------------------------------------------------------------
// INSERTING A TOKEN. THE WHOLE VALUE GOES IN - there is no fitText on this path,
// and that is the point: truncating what is INSERTED would quietly send Claude a
// path that does not exist, which is worse than any drawing defect. Only the LABEL
// is shortened, in drawComposeChip, and only for the glass.
//
// One kbInsert per byte, so the caret splice and the KB_MAX_BYTES cap stay in
// exactly one place; the batch flag holds the draft line's repaint until the whole
// token is in.
// ---------------------------------------------------------------------------
void composeInsertChip(const char* value) {
  composeBatching = true;
  for (const char* p = value; *p; p++) kbInsert(*p);
  composeBatching = false;
  composeAfterEdit();
}

// ---------------------------------------------------------------------------
// TOUCH. Press-commit on every band: each of these targets clears TAP_MIN, so
// nothing here arms-and-commits the way a 4.3mm key has to.
// ---------------------------------------------------------------------------
// The tapped column, with the gap belonging to the button on its LEFT and the last
// column taking the remainder - the same rule kbTouch applies to KB_PITCH, so no
// strip inside the lane is dead.
int composeColAt(int sx) {
  if (sx < CARD_X || sx >= CARD_X + CARD_W) return -1;
  int c = (sx - CARD_X) / composeCellW();
  if (c > COMPOSE_COLS - 1) c = COMPOSE_COLS - 1;   // the remainder is the last column's
  return c;
}
bool composeTouch(int sx, int sy) {
  const int idx = kbSessionIdx;
  // THE ACTION BAND AND THE PEEK ARE TESTED BEFORE idx, AND THAT IS A FIX, NOT A
  // TIDY. This function used to open `if (idx < 0) return true;` over the WHOLE
  // body, and kbSessionIdx goes to -1 the moment the ask this panel was opened
  // for disappears (the 5s tick's window-closed transition sets it). So every tap
  // on the panel was swallowed from that instant - CLOSE included - and the only
  // ways off the screen were the trigger file and the power button. Walking the
  // exit paths by hand is what found it; no checker did, and the brief said it
  // would be that way. Everything that reads sessions[idx] still asks first, and
  // says so when it declines.
  //
  // While peeking, EVERY tap is the pager - including one on a control the overlay
  // covers. Past the last page it closes, so there is always a way out. Same
  // contract kbTouch's own peek branch has.
  if (kbPeekPage >= 0) {
    kbPeekPage++;
    if (kbPeekPage >= kbPeekPages()) kbPeekPage = -1;
    drawCompose();
    return true;
  }
  // THE ACTION BAND. sy is tested against KB_ACT_H (the band) and NOT against
  // KB_ACT_DRAWN: the 7px of air above and below the button belong to the control,
  // which is the whole point of the split. sx is tested against the columns
  // drawComposeActions() stored.
  if (sy >= KB_ACT_Y && sy < KB_ACT_Y + KB_ACT_H) {
    for (int i = 0; i < COMPOSE_ACT_MAX; i++) {
      if (composeActW[i] <= 0) continue;
      if (sx < composeActX[i] || sx >= composeActX[i] + composeActW[i]) continue;
      if (composeSent) { closeCompose(); return true; }         // DONE
      if (i == 0) { closeCompose(); return true; }              // CLOSE / DISCARD
      if (i == 1) { composeOpenKeyboard(); return true; }       // TYPE...
      if (kbWindowClosed) {                                     // SEND, but it cannot
        Serial.println("COMPOSE: SEND refused: the prompt's window has closed - answer on your Mac");
        return true;
      }
      if (kbLen == 0) {
        Serial.println("COMPOSE: SEND refused: the draft is empty - a blank answer reads as a refusal with no reason");
        return true;
      }
      // STAYS ON THE SURFACE AND SHOWS THE RECEIPT, which is what the one-tap
      // reply path has always done. These two used to end in closeCompose()
      // themselves, so a draft built out of chips and sent from THIS row dropped
      // the whole surface while an option tapped two bands up left "SENT: ..."
      // and a collapsed DONE - one screen, two answers to "what happened". They
      // now report whether the line actually went out (an unresolved session or
      // an empty buffer returns false and sends nothing), and the caller decides
      // what the screen does about it: here a receipt, on the keyboard a close.
      const bool sent = kbIsMessage() ? sendPromptToHost() : sendTypedAnswerToHost();
      if (sent) composeShowSentState(kbText);
      else Serial.println("COMPOSE: SEND refused: the session this draft was typed for is gone");
      return true;
    }
    return true;               // the margins outside the lane
  }
  // FROM HERE DOWN, EVERY BAND BUT THE DRAFT LINE READS sessions[idx]. Asked once,
  // here, rather than at the top of the function where it also swallowed the way
  // out - and every arm that declines NAMES which of the two causes it was, since
  // "this ask has no detail" and "this ask no longer exists" are different facts
  // and only one of them is about the ask you were looking at.
  const bool haveAsk = idx >= 0 && idx < sessionCount;
  // THE PROMPT CARD, and its band is the top margin plus the card plus the gap
  // under it - everything above the first legend, the same "the air belongs to the
  // control" split the action row has.
  if (sy < composeLegend1Y()) {
    if (!haveAsk)          Serial.println("COMPOSE: PEEK refused: the ask this panel was opened for is gone - the card says so, and your draft is still on the glass");
    else if (kbHasDetail()) { kbPeekPage = 0; drawCompose(); }
    else Serial.println("COMPOSE: PEEK refused: this ask has no detail beyond its title");
    return true;
  }
  // THE REPLY BANDS. One tap sends, and it is the ask's own option index that goes
  // out - the same signed answer the detail card's option buttons send.
  if (sy >= composeReplyY() && sy < composeLegend2Y()) {
    if (!haveAsk) {
      Serial.println("COMPOSE: reply refused: the ask this panel was opened for is gone - its options went with it");
      return true;
    }
    const int band = (sy - composeReplyY()) / TAP_MIN;
    const int col = composeColAt(sx);
    if (col < 0) return true;
    const int k = band * COMPOSE_COLS + col;
    if (k >= sessions[idx].askOptCount) return true;
    composeSendOption(idx, k);
    return true;
  }
  // THE TOKEN BAND: two chips and the pager.
  if (sy >= composeTokenY() && sy < composeDraftY()) {
    if (!haveAsk) {
      Serial.println("COMPOSE: insert refused: the ask this panel was opened for is gone - its tokens went with it");
      return true;
    }
    const int col = composeColAt(sx);
    if (col < 0) return true;
    if (col == COMPOSE_COLS - 1) {
      const int pages = composeChipPages(idx);
      if (pages > 1) {
        composeChipPage = (composeChipPage + 1) % pages;
        drawComposeTokens(idx);
      }
      return true;
    }
    const int k = composeChipPage * COMPOSE_CHIPS_PER_PAGE + col;
    if (k < sessions[idx].askChipCount) composeInsertChip(sessions[idx].askChips[k]);
    return true;
  }
  // THE DRAFT LINE: CLR alone, and only while there is a draft to clear.
  if (sy >= composeDraftY() && sy < composeLegend3Y()) {
    if (!composeSent && sx >= composeClrX() && kbLen > 0) {
      kbLen = 0;
      kbText[0] = '\0';
      kbCaret = -1;            // back to the pin, not to a stated 0 that means the same
      composeAfterEdit();
    }
    return true;
  }
  return true;                 // a legend or the residual: swallowed, never dispatched
}

// One tap, one answer. Mirrors handleAskTouch's option branch rather than
// reimplementing it: the same single-answer guard, the same answeredPid bookkeeping
// and the same signed line, because a second route that answers differently is a
// second thing to keep right.
void composeSendOption(int idx, int k) {
  // THE WINDOW FIRST. Once it has closed there is nothing on the other end to
  // answer, and this used to fall through to sendAnswerToHost() - which returns
  // early on its own, so the tap did nothing AND said nothing. The buttons are
  // off the glass by then (drawComposeGone), so this is the belt to that brace:
  // a repaint that has not happened yet must not turn into a silent send.
  if (kbWindowClosed) {
    Serial.println("COMPOSE: refused: the prompt's window has closed - answer on your Mac");
    return;
  }
  if (composeSent) {
    Serial.println("COMPOSE: refused: this prompt has already been answered from this panel");
    return;
  }
  if (!sessions[idx].askAnswerable) {
    Serial.println("COMPOSE: refused: this ask is mirrored, not answerable here - the Mac's dialog owns the decision");
    return;
  }
  const bool already = answeredPid[0] &&
                       strncmp(answeredPid, sessions[idx].askPid, sizeof(answeredPid)) == 0 &&
                       (uint8_t) answeredHostSlot == sessions[idx].hostSlot;
  if (already) {
    Serial.println("COMPOSE: refused: this prompt was already answered");
    return;
  }
  copyField(answeredPid, sizeof(answeredPid), sessions[idx].askPid);
  answeredHostSlot = sessions[idx].hostSlot;
  answeredIdx = k;
  sendAnswerToHost(idx, k);
  composeSent = true;
  copyField(composeSentText, sizeof(composeSentText), sessions[idx].askOpts[k]);
  drawComposeDraft();
  drawComposeActions();
}

// THE SENT STATE, WITHOUT SENDING - the COMPOSE command's capture aid, and the
// only caller outside this file. It lives here rather than being three assignments
// at the command site so composeSentText's SIZE stays in one place: an
// `extern char composeSentText[]` at the call site is an incomplete type, and
// spelling the bound again there is exactly the drift a checker would have to
// catch later.
void composeShowSentState(const char* text) {
  composeSent = true;
  copyField(composeSentText, sizeof(composeSentText), text);
  drawCompose();
}

// THE PANEL'S OWN RESETS, called from openComposeOn() in keyboard.ino - which is
// where EVERY reset for this surface lives, in one function, because a surface
// with two screens and two openers is a surface with two lists of things to
// remember. This is here rather than there only because these four globals are
// defined in this file, and it is called from nowhere else.
void composeResetPanel() {
  composeSent = false;
  composeSentText[0] = '\0';
  composeChipPage = 0;
  composeActDrawn = 0;
}
