// The on-screen keyboard: typing an answer to a question prompt.
// Split out of deckhand_display.ino for the same reason as the other .ino files -
// the Arduino build concatenates them all into ONE translation unit (main file
// first, then alphabetically), so these still share every global and there are no
// headers. No function here names SessionInfo/Theme/Usage/HostPairing/ConfirmAction
// in its SIGNATURE, which is what would break the auto-generated prototypes.
//
// It owns the WHOLE screen - tab bar and footer included - the way the history
// reader does. That is not cosmetic: it is what makes QWERTY viable on a panel
// this narrow. THAT is what going full-screen buys, and the two numbers differ in
// BOTH dimensions rather than only in height:
//   drawn   KB_KEY_W  x (KB_ROW_H - 4)   22x37 on board 1, 30x54 on board 2
//   tested  KB_PITCH  x  KB_ROW_H        24x41 = 984, 32x58 = 1856
// The WIDTH of the tested band comes from the PITCH, not from KB_KEY_W: kbTouch()
// divides by KB_PITCH, so the 2px gap between two keys belongs to the key on its
// left and there is no dead column anywhere on the board. Keep the drawn and the
// tested numbers separate on both boards rather than collapsing them.

// EVERY KB_* GEOMETRY CONSTANT MOVED TO THE BOARD HEADERS (via board.h), because
// the whole set is derived from the panel: the key grid from the width, the text
// card's COLUMN count from CARD_W, and its LINE count from that column count.
// See the long derivation in board_es3c35p.h - board 1 is 34 columns and 5 lines,
// board 2 is 35 and 5 (it was 47 and 4, from dividing a 284px lane by Cozette's
// 6px advance after this board's face became Spleen 8x16). KB_COLS is also why
// TEXT_ADV exists: the caret and the reader both divide by that advance, and a
// literal there describes one board's font only.
// KB_MAX_BYTES is the one that stays here and stays shared:
// it is 150 on the HOST too (ANSWER_TEXT_MAX_BYTES in host/voice-answer.mjs), so
// only the columns and the resulting line count are per-board.
//
// The two derived offsets, kept here so the "meta row shares no pixel row with
// any text line" invariant is visible next to the code that draws them.
const int KB_META_Y  = KB_TEXT_Y + KB_META_DY;    // byte counter left, countdown right
const int KB_LINE0_Y = KB_TEXT_Y + KB_LINE0_DY;   // first hard-wrapped line
// The prompt strip's text row, CENTRED in its band rather than offset by a third
// literal: KB_STRIP_H is KB_LINE_PITCH + 4 on both boards, so this is 2 on both,
// and the strip's opaque text box lands strictly inside the band no matter what
// either board does to its cell height. drawString paints that box the full
// height of a line, and the strip sits directly above the text card - one row too
// low and it rubs out the card's top border.
const int KB_STRIP_TEXT_DY = (KB_STRIP_H - KB_LINE_PITCH) / 2;
const int KB_MAX_BYTES = 150;                  // must equal the host's cap

// Rows 0-2 are the letter/symbol pages; row 3 is fixed. Control characters stand
// in for the non-letter keys, because Cozette is ASCII 0x20-0x7E ONLY - there is
// no glyph for a shift arrow or a backspace, and drawing one would paint a blank
// box. They are labelled CAP and DEL instead.
#define KB_SHIFT '\x01'
#define KB_DEL   '\x02'
const char* KB_ALPHA[3] = { "qwertyuiop", "asdfghjkl", "\x01zxcvbnm\x02" };
const char* KB_SYM[3]   = { "1234567890", "-_/:;()&@#", ".,?!'\"+=\x02" };
// THE 14 CHARACTERS NO PAGE COULD REACH. 81 of the 95 printable ASCII
// codepoints were typeable; these are the rest, and five of them ($ * [ ] `)
// are ordinary in a shell command or a path, which is what this device answers
// questions about. The row lengths are 10 / 4 / 1, so rows 1 and 2 are CENTRED
// by kbRowX0() exactly as the 9-cell alpha rows already are. Matches
// docs/design/compose/compose.js's SYM2 rows exactly - that mock is the
// normative geometric spec for this split.
const char* KB_SYM2[3] = { "$%*<>[]{}|", "\\^`~", "\x02" };

// kbPage: 0 letters, 1 symbols, 2 the remaining symbols. Was a bool (kbSymbols);
// a third page needs a third state.
const char* kbRow(int r) {
  if (kbPage == 1) return KB_SYM[r];
  if (kbPage == 2) return KB_SYM2[r];
  return KB_ALPHA[r];
}
int kbRowLen(int r) { return (int) strlen(kbRow(r)); }
// Rows shorter than 10 cells are CENTRED, so the hit test and the draw must both
// derive x from the same place or a tap lands one key off at the ends.
int kbRowX0(int r) { return (tft.width() - kbRowLen(r) * KB_PITCH) / 2; }
int kbRowY(int r)  { return KB_ROWS_Y + r * KB_ROW_H; }

// Row 3 is [?123|2/2|ABC] 2 cells, [space] 6 cells, [.] 2 cells.
const int KB_R3_PAGE_W  = 2 * KB_PITCH;
const int KB_R3_SPACE_W = 6 * KB_PITCH;
// THE GAP, AS A NAME, and it is the KEY's own gap rather than a second literal:
// KB_KEY_W is KB_PITCH - 2 on both boards, so this is that same 2 read out of the
// two header constants instead of written down again. Row 3 drew its three keys
// at the FULL cell width - KB_R3_PAGE_W, KB_R3_SPACE_W and `tft.width() - x` -
// while the letter rows draw KB_KEY_W inside a KB_PITCH cell. That was invisible
// while every key carried a 1px outline that separated flush neighbours; once the
// keys became filled tiles with no stroke, three flush tiles merged into one
// continuous bar. THE GEOMETRY NEVER CHANGED - the tile treatment removed what was
// hiding it. The TESTED band is still the full cell (kbTouch's r == 3 branch
// divides nothing and compares against KB_R3_PAGE_W / +KB_R3_SPACE_W), so the gap
// belongs to the key on its LEFT exactly as it does on the character rows and no
// column of this row is dead.
const int KB_KEY_GAP = KB_PITCH - KB_KEY_W;
// The page key's three labels, indexed by kbPage - what tapping it will switch
// TO is what it shows, same convention the two-page ?123/ABC toggle always had.
// "$%*" (not "2/2", a position indicator that breaks the preview pattern
// ?123 sets on page 0, and not "#+=", which is genuinely on page 1 but never
// on page 2 - it would preview the page you are LEAVING, not the one you are
// going TO): all three characters are on KB_SYM2 and never on KB_SYM, so
// "$%*" reads as a preview exactly the way "?123" and "ABC" already do.
// All three are real labels, not the three-ASCII-dots ellipsis: "?123" is the
// widest at 4 characters, which settings-geom-check.mjs measures against the
// 2-cell key (KB_R3_PAGE_W).
const char* KB_PAGE_LABEL[3] = { "?123", "$%*", "ABC" };

void kbKeyLabel(char c, char* out, size_t n) {
  // CAPS vs CAP is the whole distinction between locked and one-shot, in TEXT -
  // the fill says "active" for both, and colour must never be the only carrier.
  if (c == KB_SHIFT)      snprintf(out, n, kbShiftMode == 2 ? "CAPS" : "CAP");
  else if (c == KB_DEL)   snprintf(out, n, "DEL");
  else if (kbShiftMode > 0 && c >= 'a' && c <= 'z') snprintf(out, n, "%c", c - 32);
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
  // CAP draws filled whenever shift is live, so a full-board repaint cannot lose
  // that state. It used to be restored by a follow-up drawKbKey at each call
  // site, which is one more thing to remember at every future one.
  if (row[col] == KB_SHIFT && kbShiftMode > 0) pressed = true;
  uiKeyCap(x, y, KB_KEY_W, KB_ROW_H - 4, label, pressed, COLOR_BG);
}

// Row 3. Each key is DRAWN one KB_KEY_GAP narrower than its cell and the cursor
// advances by the FULL cell, so the gap lands between neighbours - the letter
// rows' drawn/tested split, applied to the row that never had it. The period key
// is inset on its right too, which is the same 2px margin the last key of a
// centred 10-cell row already leaves against the panel edge.
void drawKbRow3(int pressed /* -1 none, 0 page, 1 space, 2 dot */) {
  int y = kbRowY(3), h = KB_ROW_H - 4, x = 0;
  uiKeyCap(x, y, KB_R3_PAGE_W - KB_KEY_GAP, h, KB_PAGE_LABEL[kbPage], pressed == 0, COLOR_BG);
  x += KB_R3_PAGE_W;
  uiKeyCap(x, y, KB_R3_SPACE_W - KB_KEY_GAP, h, "SPACE", pressed == 1, COLOR_BG);
  x += KB_R3_SPACE_W;
  uiKeyCap(x, y, tft.width() - x - KB_KEY_GAP, h, ".", pressed == 2, COLOR_BG);
}

// HARD wrap, deliberately unlike drawWrappedText's word wrap - see the KB_COLS
// derivation in the board headers for why. Slices kbText into KB_COLS-column
// chunks with no regard for word boundaries and draws each on its own fixed line;
// kbLen is capped at KB_MAX_BYTES elsewhere and KB_TEXT_LINES is defined as
// ceil(KB_MAX_BYTES / KB_COLS), so this can never need more than KB_TEXT_LINES
// iterations - there is no overflow case to handle here. Both numbers are
// PER-BOARD (34/5 and 35/5) and neither may be written as a literal here.
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

const unsigned long KB_REPEAT_DELAY_MS = 500;   // hold this long before repeating
const unsigned long KB_REPEAT_EVERY_MS = 120;   // then ~8 deletions a second
// Row 3's page key is the ONE press flash with no work to time it: the character
// keys' flash lasts as long as kbInsert()'s card repaint, and SPACE / "." borrow
// that same repaint, but switching page redraws the whole board BEFORE the flash
// can be drawn (see drawKeyboard's fillScreen), so there is nothing left to hold
// it on screen. 60ms is blocking, and deliberately so - handleTouch polls at 15ms
// and this runs once per page switch, which is rare; the alternative is a
// deferred-unpress timer threaded through loop() for one key.
const unsigned long KB_FLASH_MS = 60;

// Peek geometry: it covers the KEYS and the action row, never the text card - so
// the answer you are composing stays on screen while you re-read the question.
// KB_PEEK_LINES moved to the board headers with the rest of the grid; the height
// is the panel's, which used to be a hardcoded 320.
const int KB_PEEK_Y = KB_ROWS_Y, KB_PEEK_H = BOARD_H - KB_ROWS_Y - 4;

bool kbIsMessage() { return kbMessageMode; }

bool kbHasDetail() {
  // Never in message mode: there is no ask to read, and the detail screen this was
  // opened from already shows the title, last prompt and path. Suppressing it here
  // also suppresses the strip, the "tap the prompt above to read it" hint and the
  // strip's own tap band, so no control is advertised that would do nothing.
  if (kbIsMessage()) return false;
  return kbSessionIdx >= 0 && kbSessionIdx < sessionCount
         && sessions[kbSessionIdx].askDetail[0] != '\0';
}

int kbPeekPages() {
  if (!kbHasDetail()) return 0;
  SessionInfo& sn = sessions[kbSessionIdx];
  uint8_t font = detailLooksLikeCode(sn.askKind, sn.askDetail) ? FONT_CODE : T_BODY;
  int lines = countWrappedLines(sn.askDetail, font, CARD_W - 12);
  return (lines + KB_PEEK_LINES - 1) / KB_PEEK_LINES;
}

// THE PROMPT STRIP: one line of the ask, above the text card, that never leaves.
//
// WHAT IT FIXES. Re-reading the question meant opening the peek, and the peek
// covers the keys AND routes every tap on the board to its own pager - so the
// question and the keyboard could not be on the glass at the same time, and the
// only way out was to tap past the last page. The card showed the question too,
// but only with an empty buffer: the first keystroke replaced it with your own
// text. One line of it lives up here now instead, for the whole session.
//
// It is ONE LINE and it stops at the first '\n' RATHER THAN RUNNING THROUGH IT.
// askDetail keeps its newlines (deckhand_display.ino scrubs every other control
// byte and spares '\n' for drawWrappedText), and the fonts carry ASCII 0x20..0x7E
// and nothing else: a '\n' handed to drawString paints nothing AND advances
// nothing, so the second line would be drawn hard against the end of the first
// with no separator - and textWidth would measure the break as zero, so the
// truncation would be measured wrong as well as drawn wrong.
//
// The MORE tag's lane is reserved WHETHER OR NOT the tag is drawn, so the point
// the text truncates at does not jump about as the tag comes and goes; "there is
// more" is then exactly "the detail did not fit in that lane", plus the newline
// case above.
const char* KB_STRIP_MORE = "MORE";

void drawKbStrip() {
  // PAINTED UNCONDITIONALLY, not through a change-only cache, and that is
  // deliberate. Its value cannot change while it is up - the ask is pinned by pid
  // for the life of the keyboard - so a cache would buy nothing and would be one
  // more thing to reset when drawKeyboard() fillScreens over the strip, which is
  // exactly how drawSettingsStatic() and micRestoreUi() left fields BLANK. It is
  // called from drawKeyboard() and from the ONE transition that can invalidate it
  // (the ask going away, in the 5s tick), never per keystroke: drawKbText()
  // repaints the CARD only, from KB_TEXT_Y down, so nothing about typing touches
  // these rows and nothing here caches across the two.
  tft.fillRect(CARD_X, KB_STRIP_Y, CARD_W, KB_STRIP_H, COLOR_BG);
  // Same gate as the peek and as the card's hint, so no control is advertised
  // that would do nothing: with no ask to read there is no text here and
  // kbTouch's strip branch has no target.
  if (!kbHasDetail()) return;
  SessionInfo& sn = sessions[kbSessionIdx];
  const int y = KB_STRIP_Y + KB_STRIP_TEXT_DY;
  // setUIFont BEFORE every measurement: textWidth and fitText both measure the
  // LIVE font, and measuring in one and drawing in another is the bug fitText's
  // own signature is shaped to prevent.
  setUIFont(T_META);
  const int tagW = tft.textWidth(KB_STRIP_MORE) + 6;   // + the 6px gap it keeps
  char buf[KB_COLS + 8];
  int n = 0;
  while (sn.askDetail[n] && sn.askDetail[n] != '\n' && n < (int) sizeof(buf) - 1) n++;
  memcpy(buf, sn.askDetail, n);
  buf[n] = '\0';
  bool more = sn.askDetail[n] != '\0';       // a newline, or a longer detail, follows
  char line[KB_COLS + 8];
  setUIFont(T_BODY);
  fitText(line, sizeof(line), buf, CARD_W - 12 - tagW);   // three ASCII dots, never U+2026
  if ((int) strlen(line) != n) more = true;   // ...or it had to be cut to fit
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(line, CARD_X + 6, y);
  if (more) {
    setUIFont(T_META);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.setTextDatum(TR_DATUM);
    tft.drawString(KB_STRIP_MORE, CARD_X + CARD_W - 6, y);
    tft.setTextDatum(TL_DATUM);
  }
}

// The prompt, over the keys. Paged by tapping, because an ask detail runs to 1400
// characters against KB_PEEK_LINES of them (11 on board 1 since the strip shortened
// the overlay, 15 on board 2) - the same reason the ask screen itself pages.
//
// IT IS NO LONGER THE ONLY WAY TO RE-READ THE QUESTION. drawKbStrip() keeps one
// line of the ask above the card at all times, so the peek is now the LONG read
// rather than the only read - which is what makes it acceptable that, while it is
// up, kbTouch routes every tap to its pager.
void drawKbPeek() {
  if (kbSessionIdx < 0 || kbSessionIdx >= sessionCount) return;
  SessionInfo& sn = sessions[kbSessionIdx];
  uiFillRound(CARD_X, KB_PEEK_Y, CARD_W, KB_PEEK_H, 6, COLOR_CARD, COLOR_BG);
  int pages = kbPeekPages();

  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("PROMPT", CARD_X + 6, KB_PEEK_Y + KB_PEEK_LBL_DY);
  char nav[20];
  if (pages > 1) snprintf(nav, sizeof(nav), "%d/%d  tap", kbPeekPage + 1, pages);
  else           snprintf(nav, sizeof(nav), "tap to close");
  tft.setTextDatum(TR_DATUM);
  tft.drawString(nav, CARD_X + CARD_W - 6, KB_PEEK_Y + KB_PEEK_LBL_DY);
  tft.setTextDatum(TL_DATUM);

  char title[KB_COLS + 1];
  fitText(title, sizeof(title), sn.askTitle, CARD_W - 12);
  setUIFont(T_META);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.drawString(title, CARD_X + 6, KB_PEEK_Y + KB_PEEK_TITLE_DY);

  // Same font choice the ask screen makes, so a command still reads as a command.
  uint8_t font = detailLooksLikeCode(sn.askKind, sn.askDetail) ? FONT_CODE : T_BODY;
  // The three offsets and the line height are BOARD constants, not the literals
  // 8 / 22 / 40 / 13 they used to be: drawString paints an opaque box one full cell
  // tall, so at board 2's 16px cell a title at +22 starts inside the "PROMPT"
  // label's own box and erases its last row. See KB_PEEK_*_DY in the board headers.
  drawWrappedText(sn.askDetail, CARD_X + 6, KB_PEEK_Y + KB_PEEK_TEXT_DY, font,
                  KB_LINE_PITCH, CARD_W - 12,
                  kbPeekPage * KB_PEEK_LINES, KB_PEEK_LINES, COLOR_VALUE, COLOR_CARD);
}

// Hold DEL to repeat. Re-qualified against the key's OWN rectangle every tick, so
// sliding a finger off stops it rather than deleting on whatever is under the
// finger now - and a lift releases the key's pressed state.
void tickKbRepeat() {
  if (kbRepeatRow < 0) return;
  int sx, sy;
  bool onKey = false;
  if (getTouchPoint(sx, sy) && sy >= KB_ROWS_Y) {
    int r = (sy - KB_ROWS_Y) / KB_ROW_H;
    if (r == kbRepeatRow && sx >= kbRowX0(r))
      onKey = ((sx - kbRowX0(r)) / KB_PITCH) == kbRepeatCol;
  }
  if (!onKey) {
    int r = kbRepeatRow, c = kbRepeatCol;
    kbRepeatRow = kbRepeatCol = -1;
    drawKbKey(r, c, false);
    return;
  }
  if (millis() < kbRepeatNext) return;
  kbRepeatNext = millis() + KB_REPEAT_EVERY_MS;
  if (kbLen == 0) return;              // nothing left to delete; hold is harmless
  kbBackspace();
  drawKbKey(kbRepeatRow, kbRepeatCol, true);   // stays pressed while repeating
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

  // No countdown in message mode: nothing is waiting on this, so there is no window
  // to run out, and a timer implying otherwise would be a lie.
  int sec = (!kbIsMessage() && kbSessionIdx >= 0 && kbSessionIdx < sessionCount)
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
    // THE QUESTION, not "Type your answer". drawKeyboard() fillScreen's the ask
    // screen away, so without this you are composing a reply to something you can
    // no longer see. It gives way to your text on the first keystroke, which is
    // why the peek below exists for the rest of the time.
    const char* title = (kbSessionIdx >= 0 && kbSessionIdx < sessionCount)
                          ? sessions[kbSessionIdx].askTitle : "";
    char line[KB_COLS + 1];
    if (kbIsMessage()) {
      // Names the session being written TO. There is no question here, and "Type
      // your answer" would be answering nothing.
      char label[48];
      snprintf(label, sizeof(label), "Message %s",
               (kbSessionIdx >= 0 && kbSessionIdx < sessionCount)
                 ? sessions[kbSessionIdx].name : "session");
      fitText(line, sizeof(line), label, CARD_W - 12);
    } else if (title[0]) {
      fitText(line, sizeof(line), title, CARD_W - 12);
    } else {
      snprintf(line, sizeof(line), "Type your answer");
    }
    setUIFont(T_BODY);
    tft.setTextColor((title[0] || kbIsMessage()) ? COLOR_VALUE : COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(line, CARD_X + 6, KB_LINE0_Y);
    if (kbHasDetail()) {
      // NAMES THE STRIP, not this card. It said "tap here to read it" while a tap
      // on the card was what opened the peek; kbTouch's card branch is the caret
      // now (with an empty buffer there is nothing to place, so the tap does
      // nothing at all), and the strip above carries the peek. A hint that points
      // at a control that has moved is worse than none: it teaches the one
      // gesture that no longer works.
      setUIFont(T_META);
      tft.setTextColor(COLOR_LABEL, COLOR_CARD);
      tft.drawString("tap the prompt above to read it", CARD_X + 6,
                     KB_LINE0_Y + KB_LINE_PITCH);
    }
  } else {
    drawKbHardWrapped();
    // Caret: a block at the insertion point, so the card reads as focused and it
    // is obvious where the next character lands. kbCaret == -1 means "pinned to
    // the end" (the state after openKeyboard and after every append typed with
    // no tap yet), so it draws at kbLen exactly as before; once a tap in the card
    // has set it, it draws there instead. Either way its position is PROVABLE
    // rather than clamped: it is always <= kbLen <= KB_MAX_BYTES, so the furthest
    // it can ever reach is line KB_MAX_BYTES / KB_COLS, column KB_MAX_BYTES %
    // KB_COLS, and KB_TEXT_LINES is ceil(KB_MAX_BYTES / KB_COLS) - so the line
    // index is always inside the budget by construction, on any KB_COLS. The two
    // boards land on line 4 col 14 and line 4 col 10 at that furthest point;
    // settings-geom-check.mjs asserts it per board.
    // Its x step and its own size come from TEXT_ADV and KB_LINE_PITCH rather than
    // the literals 6 and 11 they used to be - a caret 6px wide stepping 6px at a
    // time under an 8px face lands under the wrong character and is thinner than
    // the glyph it marks. 6/11 on board 1, 8/14 here.
    int off = kbCaret < 0 ? kbLen : kbCaret;
    int cl = off / KB_COLS, cc = off % KB_COLS;
    if (cl < KB_TEXT_LINES)
      tft.fillRect(CARD_X + 6 + cc * TEXT_ADV, KB_LINE0_Y + cl * KB_LINE_PITCH + 1,
                   TEXT_ADV, KB_LINE_PITCH - 2, COLOR_ACCENT);
  }
  tft.setTextDatum(TL_DATUM);
}

// THE TESTED BANDS, written by drawKbActions() and read by kbTouch(). Two
// functions computing `halfW` inline is exactly the disagreement kbRowX0()'s
// comment warns about; uiActionRow() is now the single place either one gets a
// column from, and these are where the answer is kept. Zero-width until the row
// has been drawn once, which kbTouch() treats as "no control here" rather than
// as column 0.
const int KB_ACT_COLS = 2;
int kbActX[KB_ACT_COLS] = {0, 0}, kbActW[KB_ACT_COLS] = {0, 0};

void drawKbActions() {
  // OUTLINED, where both buttons used to be filled and so had no hierarchy.
  // SEND is what you came here to do, and the left key is the one that throws
  // away a sentence you spent a minute typing - the same reasoning the confirm
  // dialog uses when it refuses to make a destructive choice the easiest thing
  // to hit. Now it is not the same SIZE either: fracs {1, 2} gives SEND twice
  // the width, where the two used to be equal halves 8px apart.
  // LABEL AND COLOUR, never colour alone (kbKeyLabel's CAPS/CAP comment states
  // the rule): with a draft to lose the left key says DISCARD in COLOR_WARN,
  // and with an empty buffer it is CANCEL and destroys nothing.
  const bool draft = kbLen > 0;
  const char* labels[KB_ACT_COLS] = { draft ? "DISCARD" : "CANCEL",
                                      kbWindowClosed ? nullptr : "SEND" };
  // An empty answer would reach Claude as a blank deny message, which reads as
  // a refusal with no reason. Offer SEND only when there is something to send.
  const uint16_t tints[KB_ACT_COLS] = { draft ? COLOR_WARN : COLOR_ACCENT,
                                        draft ? COLOR_GOOD : COLOR_LABEL };
  const uint8_t fills[KB_ACT_COLS] = { 0, (uint8_t)(draft ? 1 : 0) };
  const uint8_t fracs[KB_ACT_COLS] = {1, 2};
  uiActionRow(KB_ACT_Y, KB_ACT_H, KB_ACT_DRAWN, KB_ACT_DY, labels, tints, fills,
              fracs, KB_ACT_COLS, kbActX, kbActW);
  if (kbWindowClosed) {
    // The prompt expired or was answered on the Mac. The text STAYS - throwing
    // away a sentence someone spent a minute on, with no explanation, is the
    // worst outcome available here - but SEND is withheld because it cannot work.
    // The message is 34 characters (204px on board 1, 272 here) and its lane is
    // SEND's OWN COLUMN, taken from what uiActionRow() just returned rather than
    // re-derived: a single MC_DATUM line here used to run off the screen edge AND
    // rub out CANCEL's right half with its own opaque background box. Wrapped to
    // the lane instead, same rule CLAUDE.md states for the confirm dialog's card
    // text. It was halfW - 104px on board 1, 144 here - and is now the wider
    // SEND column: 139 and 192, less the 4px inset on each side.
    const int laneX = kbActX[1], laneW = kbActW[1];
    // Clear first: SEND (a full uiButton fill) or an earlier draw of this same
    // message may have left pixels here that the new wrapped text won't cover -
    // it's narrower than the lane at every line. The clear is the full BAND,
    // not the drawn button: uiActionRow only ever inks the button, so anything
    // left in the 7px above or below it would survive a smaller clear.
    tft.fillRect(laneX, KB_ACT_Y, laneW, KB_ACT_H, COLOR_BG);
    // In message mode the prompt did not expire - the SESSION stopped being READY,
    // and "answer on your Mac" would be answering a question nobody asked.
    const char* why = kbIsMessage() ? "NO LONGER READY" : "WINDOW CLOSED - ANSWER ON YOUR MAC";
    // MEASURED, not hardcoded. This was `const int lines = 3;` beside a comment
    // telling the next person to re-measure when the string changed - exactly the
    // instruction that gets missed, and there are two strings now. RE-MEASURED
    // for the wider lane and the shorter box: 2 lines on both boards, which is
    // 26px in board 1's KB_ACT_DRAWN 26 and 32px in board 2's 32 - exactly full,
    // and settings-geom-check.mjs asserts that against KB_ACT_DRAWN per board.
    int lines = countWrappedLines(why, T_META, laneW - 8);
    // Centred in the DRAWN box, not the band: the message stands where the SEND
    // button it replaces stood, so the row keeps one baseline.
    int y = KB_ACT_Y + KB_ACT_DY + (KB_ACT_DRAWN - lines * KB_LINE_PITCH) / 2;
    drawWrappedText(why, laneX + 4, y, T_META, KB_LINE_PITCH, laneW - 8, 0, lines,
                    COLOR_WARN, COLOR_BG);
  }
}

void drawKeyboard() {
  tft.fillScreen(COLOR_BG);
  // BEFORE the peek's early return: the peek covers the keys from KB_ROWS_Y down
  // and never the card or the strip, so the question stays legible above it and
  // the strip does not have to be redrawn when the peek closes.
  drawKbStrip();
  drawKbText();
  if (kbPeekPage >= 0) {
    drawKbPeek();   // the peek owns the keys' area
#if !BOARD_USES_TFT_ESPI
    tft.flush();
#endif
    return;
  }
  for (int r = 0; r < 3; r++)
    for (int c = 0; c < kbRowLen(r); c++) drawKbKey(r, c, false);
  drawKbRow3(-1);
  drawKbActions();
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}

void openKeyboard(int idx) {
  kbActive = true;
  kbSessionIdx = idx;
  kbLen = 0;
  kbText[0] = '\0';
  kbCaret = -1;                 // pinned to the end until a tap in the card moves it
  kbShiftMode = 0;
  kbPage = 0;
  // Cleared here so an ANSWER can never inherit message mode from an earlier open.
  kbMessageMode = false;
  kbSessionId[0] = '\0';
  kbPeekPage = -1;
  kbRepeatRow = kbRepeatCol = -1;
  kbWindowClosed = false;
  copyField(kbPid, sizeof(kbPid), sessions[idx].askPid);
  kbHostSlot = sessions[idx].hostSlot;
  drawKeyboard();
}

// Compose a MESSAGE to a READY session rather than an answer to a pending ask.
// Goes through openKeyboard first so every reset lives in one place, then switches
// the mode and repaints - the placeholder and the meta row both differ.
void openKeyboardForMessage(int idx) {
  if (idx < 0 || idx >= sessionCount) return;
  openKeyboard(idx);
  kbMessageMode = true;
  kbPid[0] = '\0';                 // there is no pending prompt to pin to
  copyField(kbSessionId, sizeof(kbSessionId), sessions[idx].id);
  drawKeyboard();
}

void closeKeyboard() {
  kbActive = false;
  kbMessageMode = false;
  kbSessionId[0] = '\0';
  kbPeekPage = -1;
  kbRepeatRow = kbRepeatCol = -1;
  int idx = kbSessionIdx;
  kbSessionIdx = -1;
  kbPid[0] = '\0';
  kbHostSlot = -1;
  // drawKeyboard() fillScreen's the WHOLE panel - tab bar and footer included -
  // so closing it has to put both back, the same shape exitReader()/
  // exitReaderToList() already use: fillScreen, then drawTabBar() (which also
  // redraws the REC slot - see its own comment) and drawFooterChrome() (which
  // resets the footer's change-only caches, battGlyphCache/battTextCache
  // included) BEFORE any content, with renderFooter() LAST so it repaints from
  // freshly-reset caches rather than drawIfChanged seeing an "unchanged"
  // string against pixels drawFooterChrome() just erased. Skipping this left
  // the tab labels black, the footer divider gone and the battery blank until
  // the next tab switch or theme change - the same trap drawSettingsStatic()
  // and micRestoreUi() already document.
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  // Return to whatever the keyboard was opened FROM - the ask/detail screen if
  // the prompt is still live, else the sessions list - rather than always
  // repainting the list via forceFullRepaint(). That used to leave
  // showingDetail TRUE (this function never touched it) while the glass showed
  // the list, so handleTouch kept routing every subsequent tap into
  // handleAskTouch against a screen that no longer matched it: a tap on a
  // lower session row read as "sy >= optTop" and silently answered Claude with
  // whatever option happened to sit at that y, and a tap in the bottom band
  // started an unwanted mic capture. Nothing repaints that state away on its
  // own - buildDetailSignature never changes on a cancel - so it was
  // permanent, not a 5s window. drawSessionDetail()/buildDetailSignature()
  // mirror what openSessionDetail() does, so showingDetail, detailIndex and
  // detailId all agree with what's back on screen; SEND (sendTypedAnswerToHost)
  // ends up here too, so it gets the same consistent repaint rather than
  // relying on a later "asksent" voice card to paper over the mismatch.
  if (!kbWindowClosed && showingDetail && idx >= 0 && idx < sessionCount) {
    detailIndex = idx;
    copyField(detailId, sizeof(detailId), sessions[idx].id);
    drawSessionDetail(idx);
    buildDetailSignature(idx, detailSigCache, sizeof(detailSigCache));
  } else {
    closeSessionDetail();   // ask is gone or window closed: nothing to return to
  }
  renderFooter();
}

// Both of these act AT kbCaret, splicing rather than appending, so a correction
// forty characters back no longer costs forty re-taps of DEL plus forty re-taps
// to retype the tail. kbCaret == -1 ("pinned to the end") is handled by pointing
// pos at kbLen, which reproduces the old append-only/trim-only behaviour exactly
// - and it STAYS -1 afterwards, rather than becoming a stated offset that happens
// to equal kbLen, so the pin survives every keystroke until a tap ends it.

void kbInsert(char c) {
  if (kbLen >= KB_MAX_BYTES) { drawKbText(); return; }  // repaint so the counter shows why
  if (kbShiftMode > 0 && c >= 'a' && c <= 'z') c -= 32;
  int pos = kbCaret < 0 ? kbLen : kbCaret;
  // Shift [pos..kbLen] (the NUL included) up by one byte to open a gap at pos.
  // kbLen < KB_MAX_BYTES (150) was just checked, so kbLen+1 <= 150 stays inside
  // kbText[151].
  memmove(kbText + pos + 1, kbText + pos, kbLen - pos + 1);
  kbText[pos] = c;
  kbLen++;
  if (kbCaret >= 0) kbCaret++;  // moves right past what it just placed
  if (kbShiftMode == 1) {          // one-shot clears; locked stays
    kbShiftMode = 0;
    // The whole letter page re-labels when shift clears, so repaint rows 0-2.
    for (int r = 0; r < 3; r++)
      for (int col = 0; col < kbRowLen(r); col++) drawKbKey(r, col, false);
  }
  drawKbText();
  drawKbActions();      // SEND becomes live on the first character
}

void kbBackspace() {
  if (kbLen == 0) return;
  int pos = kbCaret < 0 ? kbLen : kbCaret;
  if (pos == 0) return;    // nothing left of the caret - a no-op, not a trim off the end
  // Shift [pos..kbLen] (the NUL included) down by one byte to close the gap at pos-1.
  memmove(kbText + pos - 1, kbText + pos, kbLen - pos + 1);
  kbLen--;
  if (kbCaret >= 0) kbCaret--;  // moves left with the byte it just deleted
  drawKbText();
  drawKbActions();      // SEND goes inert again at zero
}

// Returns true when the tap was consumed. Touch is dispatched on PRESS and a held
// finger is ignored by handleTouch, so one press is exactly one character with no
// extra debounce needed here.
bool kbTouch(int sx, int sy) {
  // While peeking, EVERY tap is the pager - including one on the keys, which are
  // covered by it. Past the last page it closes, so there is always a way out
  // without hunting for a target.
  if (kbPeekPage >= 0) {
    kbPeekPage++;
    if (kbPeekPage >= kbPeekPages()) kbPeekPage = -1;
    drawKeyboard();
    return true;
  }
  // THE ACTION BAND. sy is tested against KB_ACT_H (the band, TAP_MIN) and NOT
  // against KB_ACT_DRAWN: the drawn button is 26/32px of that band and the 7px
  // of air above and below it belong to the control, which is the whole point of
  // the split. sx is tested against the columns drawKbActions() stored, so the
  // hit test cannot disagree with the draw - it used to recompute halfW here,
  // inline, a second time. Each column already SWALLOWS the 8px gap to its
  // right, so the strip between the two buttons lands on the left one instead of
  // being dead, and the last column closes on the lane.
  if (sy >= KB_ACT_Y && sy < KB_ACT_Y + KB_ACT_H) {
    for (int i = 0; i < KB_ACT_COLS; i++) {
      if (kbActW[i] <= 0) continue;            // the row has not been drawn yet
      if (sx < kbActX[i] || sx >= kbActX[i] + kbActW[i]) continue;
      if (i == 0) { closeKeyboard(); return true; }
      if (!kbWindowClosed && kbLen > 0) {
        if (kbIsMessage()) sendPromptToHost();
        else sendTypedAnswerToHost();
      }
      return true;               // SEND's column with nothing to send: swallow
    }
    return true;                 // the margins outside the lane, likewise
  }
  // THE PROMPT STRIP, tested BEFORE the card's branch below, which is "anything
  // else above the keys" and would otherwise swallow these rows. Its band is every
  // row from the top of the panel to the card's top edge - KB_TEXT_Y, so 24px on
  // board 1 and 34 on board 2. That is MORE than the 17/20 the strip draws (the
  // top margin above it and the gap below it belong to the control, the same
  // drawn/tested split the keys and the action row have) and still UNDER TAP_MIN,
  // which is stated rather than glossed: the column closes exactly on BOARD_H
  // with no spare row on board 1, so there is nothing to grow it with. What it
  // replaces was not bigger - it was a tap on the card that only worked with an
  // empty buffer, and after Task 5 not even then.
  if (sy < KB_TEXT_Y) {
    if (kbHasDetail()) { kbPeekPage = 0; drawKeyboard(); }
    return true;
  }
  // The text card. A tap PLACES THE CARET: the card is showing your answer, not
  // the question, so a tap on it is about the answer.
  //
  // THE HISTORY, because it has been wrong twice in two different ways and the
  // second one is this task's. The card was inert to begin with, which is what
  // made the question unreachable once you had typed a character; a tap on it was
  // then made to open the peek, which fixed that; Task 5 gave the tap to the
  // caret for kbLen > 0 and left the peek on the kbLen == 0 branch - and that
  // brought the same defect back in the same shape, because kbLen > 0 is exactly
  // when you are typing. This task closes it for good by moving the peek to the
  // strip above, which is reachable in EVERY state rather than in one of them.
  if (sy < KB_ROWS_Y) {
    // Still guarded on kbLen > 0: with an empty buffer there is no character to
    // place a caret on, so the tap is swallowed rather than setting kbCaret to a
    // stated 0 that means the same as the -1 pin it would replace.
    if (kbLen > 0) {
      // The exact inverse of drawKbText's division. Clamp each intermediate
      // BEFORE combining them into a byte offset: a tap below the last line
      // or right of the last column must not carry that overshoot into the
      // product, or it could land past kbLen instead of AT it.
      int line = (sy - KB_LINE0_Y) / KB_LINE_PITCH;
      if (line < 0) line = 0;
      if (line >= KB_TEXT_LINES) line = KB_TEXT_LINES - 1;
      int col = (sx - CARD_X - 6) / TEXT_ADV;
      if (col < 0) col = 0;
      if (col >= KB_COLS) col = KB_COLS - 1;
      int off = line * KB_COLS + col;
      if (off > kbLen) off = kbLen;    // past the last character: land ON it
      // No `if (off < 0) off = 0;` here: line and col are both clamped to
      // [0, KB_TEXT_LINES-1] / [0, KB_COLS-1] above, so their product plus a
      // non-negative col is already >= 0 by construction - that guard could
      // never fire and was dead code sitting in shipping firmware.
      kbCaret = off;
      drawKbText();
    }
    return true;
  }
  int r = (sy - KB_ROWS_Y) / KB_ROW_H;
  if (r < 0 || r > 3) return true;
  if (r == 3) {
    // ROW 3 KEEPS PRESS-COMMIT (all three targets clear TAP_MIN in both axes),
    // but it now FLASHES. drawKbRow3 has always taken a pressed index and this
    // branch never passed one: the page key repainted the board and SPACE / "."
    // repainted the card, so two of the three gave no confirmation at all - and
    // on a panel with no haptics that flash is the only confirmation a press
    // registered, which is what drawKbKey's own comment says.
    int k = sx < KB_R3_PAGE_W ? 0 : (sx < KB_R3_PAGE_W + KB_R3_SPACE_W ? 1 : 2);
    if (k == 0) {
      kbPage = (kbPage + 1) % 3;
      kbShiftMode = 0;
      // The flash goes AFTER the repaint, not before it: drawKeyboard()
      // fillScreen's the panel, so a pressed row drawn first is wiped within
      // microseconds and is never seen. It is drawn on the NEW page label,
      // which is also the thing the tap changed.
      drawKeyboard();
      drawKbRow3(k);
      delay(KB_FLASH_MS);
      drawKbRow3(-1);
    } else {
      // SPACE and "." need no delay: kbInsert() repaints the text card and the
      // action row between the two draws, which is the same work that times the
      // character keys' flash.
      // Two literal calls rather than one ternary: settings-geom-check.mjs's
      // ASCII reachability sweep PARSES the characters row 3 emits out of this
      // function (they exist in no KB_*[3] table - row 3 is data inline in the
      // touch handler), so folding them into an expression would leave SPACE
      // reachable on the glass and unprovable from the source.
      drawKbRow3(k);
      if (k == 1) kbInsert(' ');
      else        kbInsert('.');
      drawKbRow3(-1);
    }
    return true;
  }
  // Integer division truncates toward zero, so on a centred row (x0 > 0) a tap
  // in the left margin (sx < x0) would otherwise divide a small NEGATIVE
  // number and land on col 0 instead of going negative - e.g. x0=12 on the
  // 9-cell rows meant x 0..11 pressed "a"/CAP. The right margin never had this
  // problem: it lands past kbRowLen(r) as expected. Reject the left margin
  // explicitly rather than relying on the division to do it.
  if (sx < kbRowX0(r)) return true;
  int col = (sx - kbRowX0(r)) / KB_PITCH;
  if (col < 0 || col >= kbRowLen(r)) return true;   // the right margin
  char c = kbRow(r)[col];
  drawKbKey(r, col, true);       // flash: the only confirmation a press landed
  if (c == KB_SHIFT) {
    kbShiftMode = (kbShiftMode + 1) % 3;   // off -> once -> locked -> off
    for (int rr = 0; rr < 3; rr++)
      for (int cc = 0; cc < kbRowLen(rr); cc++) drawKbKey(rr, cc, false);
    return true;
  }
  if (c == KB_DEL) {
    kbBackspace();
    // Arm the repeat and leave the key drawn PRESSED - tickKbRepeat releases it
    // when the finger lifts or slides off, so a quick tap looks the same as
    // before while a hold keeps deleting.
    kbRepeatRow = r;
    kbRepeatCol = col;
    kbRepeatNext = millis() + KB_REPEAT_DELAY_MS;
    return true;
  }
  kbInsert(c);
  drawKbKey(r, col, false);
  return true;
}

// Base64 of the typed text. Reuses the B64 table the screenshot dumper already
// defines rather than pulling in mbedtls, keeping the wire format readable in a
// host log by hand. 150 bytes -> 200 characters, well inside the line buffers.
void kbBase64(char* out, size_t outSize) {
  int o = 0;
  for (int i = 0; i < kbLen && o + 4 < (int) outSize; i += 3) {
    uint32_t v = (uint32_t) (uint8_t) kbText[i] << 16;
    if (i + 1 < kbLen) v |= (uint32_t) (uint8_t) kbText[i + 1] << 8;
    if (i + 2 < kbLen) v |= (uint8_t) kbText[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = (i + 1 < kbLen) ? B64[(v >> 6) & 63] : '=';
    out[o++] = (i + 2 < kbLen) ? B64[v & 63] : '=';
  }
  out[o] = '\0';
}

// A typed message to a READY session. Signs the PROMPT label so this can never
// authenticate as an answer, over a hash of exactly the bytes on screen.
void sendPromptToHost() {
  if (kbLen == 0 || kbWindowClosed || !kbIsMessage()) return;
  int idx = kbSessionIdx;
  if (idx < 0 || idx >= sessionCount) return;
  String sha = sha256Hex16(kbText);
  // Signed with the session's OWN Mac, not activeHost - a message typed while
  // a second Mac happens to have ticked most recently must still be signed
  // (and delivered) to the Mac that actually owns this READY session.
  String mac = authHmacFor(pairingSlotForRow(sessions[idx].hostSlot),
                            String(sessions[idx].promptNonce) + ":" + kbSessionId + ":PROMPT:" + sha);
  // "0" when unprovisioned, matching every other send: the host then logs a
  // refusal, so an unpaired device reads as a rejected message rather than a SEND
  // that quietly did nothing.
  if (mac.length() == 0) mac = "0";
  char b64[204];
  kbBase64(b64, sizeof(b64));
  char line[280];
  snprintf(line, sizeof(line), "PROMPT %s %s %s", kbSessionId, b64, mac.c_str());
  sendLineToHost(line, sessions[idx].hostSlot);
  closeKeyboard();
}

void sendTypedAnswerToHost() {
  if (kbLen == 0 || kbWindowClosed) return;
  int idx = kbSessionIdx;
  if (idx < 0 || idx >= sessionCount) return;
  // Sign the HASH of the text, not the base64: the two sides then agree on the
  // signed bytes without depending on padding or case in the encoding.
  String sha = sha256Hex16(kbText);
  String payload = String(sessions[idx].askNonce) + ":" + kbPid + ":TYPED:" + sha;
  // Signed with the session's OWN Mac (pairingSlotForRow(s.hostSlot)), for
  // the same reason sendAnswerToHost is: activeHost is "whoever ticked most
  // recently", which is wrong about half the time with two Macs live.
  // pairingSlotForRow (not pairingSlotForLink) is what keeps a legacy host -
  // one old enough to send no hostId at all - answerable, by falling back to
  // activeHost exactly the way the pre-multi-pairing authHmac() always did.
  String mac = authHmacFor(pairingSlotForRow(sessions[idx].hostSlot), payload);
  // "0" when unprovisioned, matching sendAnswerToHost and sendVoiceAnswerToHost.
  // Deliberately NOT a silent return: the host logs the rejection, so an unpaired
  // device shows up as a refused answer rather than a SEND that quietly does nothing.
  if (mac.length() == 0) mac = "0";
  char b64[204];
  kbBase64(b64, sizeof(b64));
  char line[280];
  snprintf(line, sizeof(line), "ANSWER %s %s TYPED %s %s",
           sessions[idx].id, kbPid, b64, mac.c_str());
  sendLineToHost(line, sessions[idx].hostSlot);
  closeKeyboard();
}
