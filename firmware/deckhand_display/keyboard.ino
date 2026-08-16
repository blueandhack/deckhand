// The on-screen keyboard: typing an answer to a question prompt.
// Split out of deckhand_display.ino for the same reason as the other .ino files -
// the Arduino build concatenates them all into ONE translation unit (main file
// first, then alphabetically), so these still share every global and there are no
// headers. No function here names SessionInfo/Theme/Usage/HostPairing/ConfirmAction
// in its SIGNATURE, which is what would break the auto-generated prototypes.
//
// It owns the WHOLE screen - tab bar and footer included - the way the history
// reader does. That is not cosmetic: it is what makes QWERTY viable on a 240px
// panel. Inside the content area the keys would be 22x40; full-screen they are
// 22x46, which is 1012px2 of target instead of 880.

const int KB_PITCH  = 24;      // 10 * 24 = 240, exactly the panel width
const int KB_KEY_W  = 22;      // 2px of the pitch is the gap
const int KB_ROW_H  = 46;
const int KB_TEXT_Y = 4,   KB_TEXT_H = 60;
const int KB_ROWS_Y = 68;                      // 4 rows * 46 = 184, ends at 252
const int KB_ACT_Y  = 256, KB_ACT_H = 44;      // ends at 300, 20px spare
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

// The typed text, plus the countdown. Repainted wholesale (it is one small card)
// rather than through drawIfChanged - the text changes on every keystroke, so a
// change-only cache would buy nothing and would need to be as long as the buffer.
void drawKbText() {
  uiFillRound(CARD_X, KB_TEXT_Y, CARD_W, KB_TEXT_H, 6, COLOR_CARD, COLOR_BG);
  if (kbLen == 0) {
    setUIFont(T_BODY);
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("Type your answer", CARD_X + 6, KB_TEXT_Y + 8);
  } else {
    drawWrappedText(kbText, CARD_X + 6, KB_TEXT_Y + 6, FONT_CODE, 13,
                    CARD_W - 12, 0, 3, COLOR_VALUE, COLOR_CARD);
  }
  // Countdown, top-right. Amber under 20s. Advisory only - it never decides
  // whether SEND works, so a wrong value costs nothing but a wrong impression.
  int sec = (kbSessionIdx >= 0 && kbSessionIdx < sessionCount)
              ? sessions[kbSessionIdx].askSec : -1;
  if (sec >= 0) {
    char buf[12];
    snprintf(buf, sizeof(buf), "%ds", sec);
    setUIFont(T_META);
    tft.setTextColor(sec < 20 ? COLOR_WARN : COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TR_DATUM);
    tft.drawString(buf, CARD_X + CARD_W - 6, KB_TEXT_Y + 6);
  }
  // The byte counter turns amber at the cap, so a key that stops inserting has a
  // visible reason rather than looking like a dropped press.
  char cnt[16];
  snprintf(cnt, sizeof(cnt), "%d/%d", kbLen, KB_MAX_BYTES);
  setUIFont(T_META);
  tft.setTextColor(kbLen >= KB_MAX_BYTES ? COLOR_WARN : COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(BR_DATUM);
  tft.drawString(cnt, CARD_X + CARD_W - 6, KB_TEXT_Y + KB_TEXT_H - 4);
  tft.setTextDatum(TL_DATUM);
}

void drawKbActions() {
  int halfW = (tft.width() - CARD_X * 2 - 8) / 2;
  uiButton(CARD_X, KB_ACT_Y, halfW, KB_ACT_H, "CANCEL", COLOR_ACCENT, true, COLOR_BG);
  if (kbWindowClosed) {
    // The prompt expired or was answered on the Mac. The text STAYS - throwing
    // away a sentence someone spent a minute on, with no explanation, is the
    // worst outcome available here - but SEND is withheld because it cannot work.
    setUIFont(T_META);
    tft.setTextColor(COLOR_WARN, COLOR_BG);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("WINDOW CLOSED - ANSWER ON YOUR MAC",
                   CARD_X + halfW + 8 + halfW / 2, KB_ACT_Y + KB_ACT_H / 2);
    tft.setTextDatum(TL_DATUM);
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
