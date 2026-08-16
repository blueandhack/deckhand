// The on-screen keyboard: typing an answer to a question prompt.
// Split out of deckhand_display.ino for the same reason as the other .ino files -
// the Arduino build concatenates them all into ONE translation unit (main file
// first, then alphabetically), so these still share every global and there are no
// headers. No function here names SessionInfo/Theme/Usage/HostPairing/ConfirmAction
// in its SIGNATURE, which is what would break the auto-generated prototypes.
//
// It owns the WHOLE screen - tab bar and footer included - the way the history
// reader does. That is not cosmetic: it is what makes QWERTY viable on a 240px
// panel. The drawn key is 22x40 (KB_ROW_H - 4) either way - what going
// full-screen buys is the TOUCH target, which is the whole 22x44 row (kbTouch
// tests the full row band, not just the drawn rect): 968px2 against 880 in the
// content area, where the row itself would have to shrink with it.

const int KB_PITCH  = 24;      // 10 * 24 = 240, exactly the panel width
const int KB_KEY_W  = 22;      // 2px of the pitch is the gap
const int KB_ROW_H  = 44;      // 4px over TAP_MIN (40), not merely at it
// Text card layout, fixed round 2: HARD-wrapped at exactly KB_COLS (34) columns,
// not drawWrappedText's word wrap. Word wrap can leave as few as 18 of 34
// columns used on a line (a 17-char word pushes the break back past the
// half-way point), so 150 bytes could need up to 8 lines by that algorithm -
// more than this screen has room for. Slicing at a fixed column count makes the
// budget PROVABLE instead: ceil(150/34) = 5 lines, always. Breaking a word
// mid-character is fine on a field being actively composed (the security
// property here is "the human typed it and watched it appear", which a hard
// wrap satisfies exactly) - it would NOT be fine in the reader or the ask
// detail screen, which is why drawWrappedText itself is untouched and this
// keyboard gets its own small draw instead.
// The byte counter and the countdown both used to sit ON a text row (top-right
// over line 1, bottom-right over line 6 in the since-reverted 6-line design),
// and each one's opaque drawString box silently erased whatever text shared its
// row - found twice, fixed once: both now live in a RESERVED meta row that no
// text line ever reaches, so there is no shared row left to erase.
// 4 (top) + 88 (text, 4..92) + 4 (gap) + 176 (4 rows * 44, 96..272) + 4 (gap)
// + 44 (actions, 276..320) = 320 exactly.
const int KB_TEXT_Y = 4,   KB_TEXT_H = 88;
const int KB_COLS = 34;                        // (CARD_W - 12) / 6, Cozette's uniform advance
const int KB_TEXT_LINES = 5;                   // ceil(KB_MAX_BYTES / KB_COLS)
const int KB_META_Y  = KB_TEXT_Y + 6;          // 10: byte counter left, countdown right
const int KB_LINE0_Y = KB_TEXT_Y + 22;         // 26: first hard-wrapped line
const int KB_LINE_PITCH = 13;                  // line 5 at 78, ends ~90 - 2px inside the card
const int KB_ROWS_Y = 96;                      // 4 rows * 44 = 176, ends at 272
const int KB_ACT_Y  = 276, KB_ACT_H = 44;      // ends at 320, 0px spare
const int KB_MAX_BYTES = 150;                  // must equal the host's cap

// Rows 0-2 are the letter/symbol pages; row 3 is fixed. Control characters stand
// in for the non-letter keys, because Cozette is ASCII 0x20-0x7E ONLY - there is
// no glyph for a shift arrow or a backspace, and drawing one would paint a blank
// box. They are labelled CAP and DEL instead.
#define KB_SHIFT '\x01'
#define KB_DEL   '\x02'
const char* KB_ALPHA[3] = { "qwertyuiop", "asdfghjkl", "\x01zxcvbnm\x02" };
const char* KB_SYM[3]   = { "1234567890", "-_/:;()&@#", ".,?!'\"+=\x02" };

const char* kbRow(int r) { return kbSymbols ? KB_SYM[r] : KB_ALPHA[r]; }
int kbRowLen(int r) { return (int) strlen(kbRow(r)); }
// Rows shorter than 10 cells are CENTRED, so the hit test and the draw must both
// derive x from the same place or a tap lands one key off at the ends.
int kbRowX0(int r) { return (tft.width() - kbRowLen(r) * KB_PITCH) / 2; }
int kbRowY(int r)  { return KB_ROWS_Y + r * KB_ROW_H; }

// Row 3 is [?123|ABC] 2 cells, [space] 6 cells, [.] 2 cells.
const int KB_R3_PAGE_W  = 2 * KB_PITCH;
const int KB_R3_SPACE_W = 6 * KB_PITCH;

void kbKeyLabel(char c, char* out, size_t n) {
  if (c == KB_SHIFT)      snprintf(out, n, "CAP");
  else if (c == KB_DEL)   snprintf(out, n, "DEL");
  else if (kbShift && c >= 'a' && c <= 'z') snprintf(out, n, "%c", c - 32);
  else                    snprintf(out, n, "%c", c);
}

// One key. Drawn on demand so a press can invert just this key rather than the
// whole board - on a panel with no haptics that flash is the only confirmation a
// press registered, and skipping it reads as a dropped keystroke.
void drawKbKey(int r, int col, bool pressed) {
  const char* row = kbRow(r);
  if (col < 0 || col >= kbRowLen(r)) return;
  char label[8];
  kbKeyLabel(row[col], label, sizeof(label));
  int x = kbRowX0(r) + col * KB_PITCH, y = kbRowY(r);
  uiButton(x, y, KB_KEY_W, KB_ROW_H - 4, label, COLOR_ACCENT, pressed, COLOR_BG);
}

void drawKbRow3(int pressed /* -1 none, 0 page, 1 space, 2 dot */) {
  int y = kbRowY(3), h = KB_ROW_H - 4, x = 0;
  uiButton(x, y, KB_R3_PAGE_W, h, kbSymbols ? "ABC" : "?123",
           COLOR_ACCENT, pressed == 0, COLOR_BG);
  x += KB_R3_PAGE_W;
  uiButton(x, y, KB_R3_SPACE_W, h, "SPACE", COLOR_ACCENT, pressed == 1, COLOR_BG);
  x += KB_R3_SPACE_W;
  uiButton(x, y, tft.width() - x, h, ".", COLOR_ACCENT, pressed == 2, COLOR_BG);
}

// HARD wrap, deliberately unlike drawWrappedText's word wrap - see the header
// comment on KB_COLS for why. Slices kbText into KB_COLS-column chunks with no
// regard for word boundaries and draws each on its own fixed line; kbLen is
// capped at KB_MAX_BYTES (150) elsewhere, so this can never need more than
// KB_TEXT_LINES (5) iterations - there is no overflow case to handle here.
void drawKbHardWrapped() {
  setUIFont(FONT_CODE);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  int pos = 0;
  for (int i = 0; i < KB_TEXT_LINES && pos < kbLen; i++) {
    int n = kbLen - pos < KB_COLS ? kbLen - pos : KB_COLS;
    char line[KB_COLS + 1];
    memcpy(line, kbText + pos, n);
    line[n] = '\0';
    tft.drawString(line, CARD_X + 6, KB_LINE0_Y + i * KB_LINE_PITCH);
    pos += n;
  }
}

// The typed text, plus the countdown. Repainted wholesale (it is one small card)
// rather than through drawIfChanged - the text changes on every keystroke, so a
// change-only cache would buy nothing and would need to be as long as the buffer.
void drawKbText() {
  uiFillRound(CARD_X, KB_TEXT_Y, CARD_W, KB_TEXT_H, 6, COLOR_CARD, COLOR_BG);
  // Meta row: byte counter left, countdown right, both anchored to KB_META_Y -
  // a row no text line ever occupies (see the header comment). The byte counter
  // turns amber at the cap, so a key that stops inserting has a visible reason
  // rather than looking like a dropped press. The countdown is amber under 20s;
  // it is advisory only and never decides whether SEND works.
  char cnt[16];
  snprintf(cnt, sizeof(cnt), "%d/%d", kbLen, KB_MAX_BYTES);
  setUIFont(T_META);
  tft.setTextColor(kbLen >= KB_MAX_BYTES ? COLOR_WARN : COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(cnt, CARD_X + 6, KB_META_Y);

  int sec = (kbSessionIdx >= 0 && kbSessionIdx < sessionCount)
              ? sessions[kbSessionIdx].askSec : -1;
  if (sec >= 0) {
    char buf[12];
    snprintf(buf, sizeof(buf), "%ds", sec);
    setUIFont(T_META);
    tft.setTextColor(sec < 20 ? COLOR_WARN : COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TR_DATUM);
    tft.drawString(buf, CARD_X + CARD_W - 6, KB_META_Y);
  }

  if (kbLen == 0) {
    setUIFont(T_BODY);
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("Type your answer", CARD_X + 6, KB_LINE0_Y);
  } else {
    drawKbHardWrapped();
  }
  tft.setTextDatum(TL_DATUM);
}

void drawKbActions() {
  int halfW = (tft.width() - CARD_X * 2 - 8) / 2;
  uiButton(CARD_X, KB_ACT_Y, halfW, KB_ACT_H, "CANCEL", COLOR_ACCENT, true, COLOR_BG);
  if (kbWindowClosed) {
    // The prompt expired or was answered on the Mac. The text STAYS - throwing
    // away a sentence someone spent a minute on, with no explanation, is the
    // worst outcome available here - but SEND is withheld because it cannot work.
    // The message is 34 Cozette chars (204px) but its lane - right of CANCEL,
    // clear of the 8px gap - is only halfW (104px) wide: a single MC_DATUM
    // line here used to run off the screen edge AND rub out CANCEL's right
    // half with its own opaque background box. Wrapped to the lane instead,
    // same rule CLAUDE.md states for the confirm dialog's card text. Measured
    // (see the task report): wraps to exactly 3 lines at this width, well
    // inside KB_ACT_H's 44px with room to spare.
    int laneX = CARD_X + halfW + 8, laneW = CARD_W - halfW - 8;
    // Clear first: SEND (a full uiButton fill) or an earlier draw of this same
    // message may have left pixels here that the new wrapped text won't cover -
    // it's narrower than the lane at every line.
    tft.fillRect(laneX, KB_ACT_Y, laneW, KB_ACT_H, COLOR_BG);
    const int lines = 3;   // measured at laneW - 8; re-measure if the string changes
    int y = KB_ACT_Y + (KB_ACT_H - lines * 13) / 2;
    drawWrappedText("WINDOW CLOSED - ANSWER ON YOUR MAC", laneX + 4, y,
                    T_META, 13, laneW - 8, 0, lines, COLOR_WARN, COLOR_BG);
  } else {
    // An empty answer would reach Claude as a blank deny message, which reads as
    // a refusal with no reason. Offer SEND only when there is something to send.
    uiButton(CARD_X + halfW + 8, KB_ACT_Y, halfW, KB_ACT_H, "SEND",
             kbLen > 0 ? COLOR_GOOD : COLOR_LABEL, kbLen > 0, COLOR_BG);
  }
}

void drawKeyboard() {
  tft.fillScreen(COLOR_BG);
  drawKbText();
  for (int r = 0; r < 3; r++)
    for (int c = 0; c < kbRowLen(r); c++) drawKbKey(r, c, false);
  drawKbRow3(-1);
  drawKbActions();
}

void openKeyboard(int idx) {
  kbActive = true;
  kbSessionIdx = idx;
  kbLen = 0;
  kbText[0] = '\0';
  kbShift = false;
  kbSymbols = false;
  kbWindowClosed = false;
  copyField(kbPid, sizeof(kbPid), sessions[idx].askPid);
  drawKeyboard();
}

void closeKeyboard() {
  kbActive = false;
  kbSessionIdx = -1;
  kbPid[0] = '\0';
  forceFullRepaint();   // returns values from data already in hand, no tick wait
}

void kbInsert(char c) {
  if (kbLen >= KB_MAX_BYTES) { drawKbText(); return; }  // repaint so the counter shows why
  if (kbShift && c >= 'a' && c <= 'z') c -= 32;
  kbText[kbLen++] = c;
  kbText[kbLen] = '\0';
  if (kbShift) {
    kbShift = false;
    // The whole letter page re-labels when shift clears, so repaint rows 0-2.
    for (int r = 0; r < 3; r++)
      for (int col = 0; col < kbRowLen(r); col++) drawKbKey(r, col, false);
  }
  drawKbText();
  drawKbActions();      // SEND becomes live on the first character
}

void kbBackspace() {
  if (kbLen == 0) return;
  kbText[--kbLen] = '\0';
  drawKbText();
  drawKbActions();      // SEND goes inert again at zero
}

// Returns true when the tap was consumed. Touch is dispatched on PRESS and a held
// finger is ignored by handleTouch, so one press is exactly one character with no
// extra debounce needed here.
bool kbTouch(int sx, int sy) {
  if (sy >= KB_ACT_Y && sy < KB_ACT_Y + KB_ACT_H) {
    int halfW = (tft.width() - CARD_X * 2 - 8) / 2;
    if (sx < CARD_X + halfW) { closeKeyboard(); return true; }
    if (!kbWindowClosed && kbLen > 0 && sx >= CARD_X + halfW + 8) {
      sendTypedAnswerToHost();   // Task 4 - a no-op stub until then
      return true;
    }
    return true;                 // swallow taps in the gap rather than guessing
  }
  if (sy < KB_ROWS_Y) return true;             // the text card is not a control
  int r = (sy - KB_ROWS_Y) / KB_ROW_H;
  if (r < 0 || r > 3) return true;
  if (r == 3) {
    if (sx < KB_R3_PAGE_W) {
      kbSymbols = !kbSymbols;
      kbShift = false;
      drawKeyboard();
    } else if (sx < KB_R3_PAGE_W + KB_R3_SPACE_W) {
      kbInsert(' ');
    } else {
      kbInsert('.');
    }
    return true;
  }
  int col = (sx - kbRowX0(r)) / KB_PITCH;
  if (col < 0 || col >= kbRowLen(r)) return true;   // the centred rows' margins
  char c = kbRow(r)[col];
  drawKbKey(r, col, true);       // flash: the only confirmation a press landed
  if (c == KB_SHIFT) {
    kbShift = !kbShift;
    for (int rr = 0; rr < 3; rr++)
      for (int cc = 0; cc < kbRowLen(rr); cc++) drawKbKey(rr, cc, false);
    drawKbKey(r, col, kbShift);
    return true;
  }
  if (c == KB_DEL) { kbBackspace(); drawKbKey(r, col, false); return true; }
  kbInsert(c);
  drawKbKey(r, col, false);
  return true;
}

// STUB - replaced in Task 4. Present only so this task compiles and the keyboard
// can be exercised (type, backspace, shift, page, cancel) before send exists.
void sendTypedAnswerToHost() {}
