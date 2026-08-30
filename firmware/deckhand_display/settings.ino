// Settings tab: its four pages, the stepper cards, pager and confirm dialog.
// Split out of deckhand_display.ino - see pairing.ino for how the concatenated
// build works and what may not move.

int stepBtnY(int cardY) { return cardY + STEP_BTN_TOP; }
// Filled dot when connected, hollow ring when not.
void drawConnDot(int cx, int cy, int r, bool connected, uint16_t bg) {
  tft.fillRect(cx - r - 1, cy - r - 1, r * 2 + 2, r * 2 + 2, bg);
  if (connected) {
    tft.fillSmoothCircle(cx, cy, r, COLOR_GOOD, COLOR_CARD);
  } else {
    uiRing(cx, cy, r, 2, COLOR_UNKNOWN, COLOR_CARD);
  }
}
void drawStepperCard(int y0, const char* label) {
  uiCard(CARD_X, y0, CARD_W, STEPPER_CARD_H);
  // Label sits in the middle column, directly above the value it names, rather
  // than in the top-left corner where it collided with the left key.
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(label, tft.width() / 2, y0 + STEP_LABEL_CY);
  tft.setTextDatum(TL_DATUM);
  int btnY = stepBtnY(y0);
  int rightBtnX = CARD_X + CARD_W - PAD - STEP_BTN_SIZE;
  uiFillRound(CARD_X + PAD, btnY, STEP_BTN_SIZE, STEP_BTN_SIZE, R_SM, COLOR_BG, COLOR_CARD);
  uiFillRound(rightBtnX, btnY, STEP_BTN_SIZE, STEP_BTN_SIZE, R_SM, COLOR_BG, COLOR_CARD);
  // Borders + -/+ glyphs drawn by drawStepGlyph (they grey out at range ends).
}
// -/+ glyph plus button border, greyed out at the range end.
void drawStepGlyph(int cacheIdx, int x, int btnY, const char* glyph, bool enabled) {
  if (stepGlyphCache[cacheIdx] == (int) enabled) return;
  stepGlyphCache[cacheIdx] = (int) enabled;
  uint16_t c = enabled ? COLOR_ACCENT : COLOR_LABEL;
  uiStrokeRound(x, btnY, STEP_BTN_SIZE, STEP_BTN_SIZE, 6, BORDER_CTRL, c, COLOR_BG);
  // T_HEAD, not body: a 6px glyph on a 44px key was a speck. This is the type
  // scale's middle rung doing the job it was added for.
  setUIFont(T_HEAD);
  tft.setTextColor(c, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(glyph, x + STEP_BTN_SIZE / 2, btnY + STEP_BTN_SIZE / 2);
  tft.setTextDatum(TL_DATUM);
}
#if !BOARD_SETTINGS_HOME
// The pager band: < chevron, page title + dots, > chevron.
void drawPager() {
  tft.fillRect(0, CONTENT_Y, tft.width(), PAGER_H + 4, COLOR_BG);
  const char* titles[SETTINGS_PAGES] = {"STATUS", "DISPLAY & SOUND", "ACTIONS", "PAIRED MACS"};
  int cy = CONTENT_Y + PAGER_H / 2;
  // Draw the prev/next targets as actual BUTTONS. A bare "<" glyph gave no clue
  // how big the tappable area was, so people aimed at the glyph itself and
  // missed; an outlined key reads as "press here" and matches the real hit zone.
  int by = CONTENT_Y + 4, bh = PAGER_H - 8;
  for (int side = 0; side < 2; side++) {
    int bx = side == 0 ? PAGER_BTN_X0 : tft.width() - PAGER_BTN_X0 - PAGER_BTN_W;
    uiFillRound(bx, by, PAGER_BTN_W, bh, RADIUS, COLOR_CARD, COLOR_BG);
    uiStrokeRound(bx, by, PAGER_BTN_W, bh, RADIUS, BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(side == 0 ? "<" : ">", bx + PAGER_BTN_W / 2, cy);
  }
  setUIFont(1);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(titles[settingsPage], tft.width() / 2, cy - 5);
  int spacing = 12, startX = tft.width() / 2 - (SETTINGS_PAGES - 1) * spacing / 2;
  for (int i = 0; i < SETTINGS_PAGES; i++) {
    if (i == settingsPage) tft.fillSmoothCircle(startX + i * spacing, cy + 8, 3, COLOR_ACCENT, COLOR_BG);
    else tft.drawSmoothCircle(startX + i * spacing, cy + 8, 3, COLOR_LABEL, COLOR_BG);
  }
  tft.setTextDatum(TL_DATUM);
}
#else
// ----- The back band, and HOME (board 2) -----
// The pager band becomes a BACK band of exactly the same height, which is the
// whole reason every group body below needs no new arithmetic: PAGE_TOP is
// unchanged. There is only one key in it, so unlike drawPager() there is no
// 45/55 split to make - the WHOLE band is the back target (handleSettingsTouch).
void drawBackBand(const char* title) {
  int by = CONTENT_Y + 4, bh = PAGER_H - 8;
  uiFillRound(PAGER_BTN_X0, by, BACK_BTN_W, bh, RADIUS, COLOR_CARD, COLOR_BG);
  uiStrokeRound(PAGER_BTN_X0, by, BACK_BTN_W, bh, RADIUS, BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
  // T_HEAD, like the stepper keys' -/+ glyphs and for the same reason: a 16px
  // glyph on a 46px key is a speck.
  setUIFont(T_HEAD);
  tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("<", PAGER_BTN_X0 + BACK_BTN_W / 2, by + bh / 2);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(ML_DATUM);
  tft.drawString(title, PAGER_BTN_X0 + BACK_BTN_W + BACK_TITLE_DX, CONTENT_Y + PAGER_H / 2);
  tft.setTextDatum(TL_DATUM);
}
// A GROUP CAPTION: T_META in COLOR_LABEL at CARD_X + PAD, TL_DATUM, on the page
// background rather than on a card - the treatment board_es3c35p.h describes once
// for every one of them, and the step from its datum to the control it heads is
// SET_CAP_STEP. All seven live sites go through here (Display's THEME, Sound's
// ALERTS and MICROPHONE, Pairing's ANSWER PROMPTS FROM and PAIRED MACS, Actions'
// SETUP and CANNOT BE UNDONE); six of them were four inline lines each, and four
// identical lines repeated seven times is how one page comes to draw its caption
// in a different colour or off a different datum with nothing saying which is
// right. It is named for what it DRAWS rather than for the page that first needed
// it - this was drawActionCaption(), on the group that happened to add it last.
void drawGroupCaption(const char* text, int y) {
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(text, CARD_X + PAD, y);
}
// ONE table, two uses: the back band's title and HOME's row name. They must be the
// same word or the screen you tapped into is not the one you tapped on.
const char* settingsGroupTitle(int g) {
  switch (g) {
    case SET_STATUS:  return "Status";
    case SET_DISPLAY: return "Display";
    case SET_SOUND:   return "Sound";
    case SET_PAIRING: return "Pairing";
    default:          return "Actions";
  }
}
int settingsHomeRowY(int i) { return HOME_Y0 + i * (HOME_ROW_H + HOME_GAP); }
// HOME owns the whole content area - no band above it, because the tab bar already
// says SETTINGS and a second title would be chrome repeating itself. The five cards,
// their names and the chevrons are static; the summaries are live and go through
// renderSettingsHome().
void drawSettingsHomeStatic() {
  for (int i = 0; i < SET_GROUP_COUNT; i++) {
    int y = settingsHomeRowY(i);
    uiCard(CARD_X, y, CARD_W, HOME_ROW_H);
    setUIFont(T_HEAD);
    tft.setTextColor(COLOR_VALUE, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(settingsGroupTitle(SET_STATUS + i), CARD_X + PAD, y + HOME_NAME_DY);
    // A plain ASCII ">", because Spleen declares 0x20..0x7E and a chevron glyph
    // would draw as nothing at all - the trap this repo has now paid for four
    // times. It is the affordance that says the row OPENS something; without it a
    // HOME row reads as a status line.
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.setTextDatum(MR_DATUM);
    tft.drawString(">", CARD_X + CARD_W - PAD, y + HOME_ROW_H / 2);
    tft.setTextDatum(TL_DATUM);
  }
}
// The five summaries, composed from the same globals each group's own page draws
// from - nothing is stored, so they cannot disagree with the page you open.
void settingsHomeSummary(int g, char* buf, size_t n, uint16_t* col) {
  *col = COLOR_LABEL;
  switch (g) {
    case SET_STATUS: {
      bool bt = bleConnected, usb = usbLinkActive();
      const char* links = (bt && usb) ? "Both links up" : (bt || usb) ? "One link up" : "No link";
      // Colour SUPPORTS the words, it never carries the meaning: the phrase says
      // which state this is on its own, in greyscale and to a colour-blind eye.
      *col = (bt && usb) ? COLOR_GOOD : COLOR_WARN;
      char pctS[8] = "--";
      if (batteryPresent()) snprintf(pctS, sizeof(pctS), "%d%%", batteryPct());
      char tempS[8] = "--";
      float dieC = 0;
      if (dieTempRead(&dieC)) snprintf(tempS, sizeof(tempS), "%d C", (int) dieC);
      snprintf(buf, n, "%s   %s   %s", links, pctS, tempS);
      break;
    }
    case SET_DISPLAY: {
      char sleepS[16];
      formatSleepValue(sleepS, sizeof(sleepS));
      const char* th = themeMode == THEME_MODE_DARK  ? "DARK"
                     : themeMode == THEME_MODE_LIGHT ? "LIGHT" : "AUTO";
      snprintf(buf, n, "%d%%   sleep %s   %s", brightnessPct, sleepS, th);
      break;
    }
    case SET_SOUND:
      snprintf(buf, n, "%s   volume %s   mic", beepEnabled ? "ON" : "OFF", VOL_LABELS[volPresetIdx]);
      break;
    case SET_PAIRING:
      snprintf(buf, n, "%d Mac%s   %s", hostCount, hostCount == 1 ? "" : "s",
               allowedHost[0] ? "one may answer" : "any may answer");
      break;
    default:
      snprintf(buf, n, "calibrate, pairing, power");
      break;
  }
}
void renderSettingsHome() {
  for (int i = 0; i < SET_GROUP_COUNT; i++) {
    char buf[HOME_SUB_BYTES + 16];
    uint16_t col;
    settingsHomeSummary(SET_STATUS + i, buf, sizeof(buf), &col);
    // Padded so the opaque box is a constant width and a shrinking summary cannot
    // leave the tail of a longer one behind; truncated to the cache, which is what
    // drawIfChanged compares.
    padTo(buf, sizeof(buf), HOME_SUB_CHARS);
    buf[HOME_SUB_CHARS] = '\0';
    // Only the Status row's colour ever moves; the other four are COLOR_LABEL.
    if (i == 0 && col != homeStatusColorCache) {
      homeStatusColorCache = col;
      homeSubCache[i][0] = '\0';
    }
    drawIfChanged(homeSubCache[i], HOME_SUB_BYTES, buf, CARD_X + PAD,
                  settingsHomeRowY(i) + HOME_SUB_DY, T_META, 1, col, COLOR_CARD);
  }
}
#endif
// ----- Page 0 / the STATUS group -----
#if BOARD_SETTINGS_HOME
// THREE CARDS (board 2). board_es3c35p.h's ST_* section carries the geometry and
// the reasoning; what matters here is the split of labour. The two facts you came
// for - is the host talking to me, and how is the battery - LEAD their card as a
// T_HEAD line with their detail dimmed under them, and the four diagnostics that
// used to be a card of their own collapse into two columns at the foot. The
// per-Mac rows are not here at all any more: they are on the Pairing group, where
// the Macs already are.
//
// Only the cards and their captions are static; every value below is live and
// goes through renderStatusPage()'s change-only fields.
void drawStatusPageStatic() {
  uiCard(CARD_X, ST_CONN_Y, CARD_W, ST_CONN_H);
  uiCard(CARD_X, ST_PWR_Y,  CARD_W, ST_PWR_H);
  uiCard(CARD_X, ST_HOST_Y, CARD_W, ST_HOST_H);
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("CONNECTION", CARD_X + PAD, ST_CONN_Y + ST_CAP_DY);
  tft.drawString("POWER",      CARD_X + PAD, ST_PWR_Y  + ST_CAP_DY);
  tft.drawString("HOST",       CARD_X + PAD, ST_HOST_Y + ST_CAP_DY);
}
void renderStatusPage() {
  char buf[40];
  const int xLeft  = CARD_X + PAD;
  const int xRight = CARD_X + CARD_W - PAD;

  // ---- CONNECTION: the verdict, then which transports and how stale ----
  bool bt = bleConnected, usb = usbLinkActive();
  // The PHRASE names the state on its own - in greyscale, and to a colour-blind
  // eye - and the colour is an accent on it. Same rule as HOME's Status summary,
  // which this line is the long form of.
  const char* verdict = (bt && usb) ? "Both links up"
                      : bt          ? "Bluetooth only"
                      : usb         ? "USB only"
                                    : "No host";
  uint16_t vcol = (bt && usb) ? COLOR_GOOD : COLOR_WARN;
  snprintf(buf, sizeof(buf), "%s", verdict);
  padTo(buf, sizeof(buf), ST_VERDICT_CHARS);
  // THE COLOUR IS CACHED BESIDE THE TEXT AND BUSTS IT, and here that is not a
  // theoretical guard: the verdict describes the LINKS while the colour describes
  // whether both are up, so "Bluetooth only" holds its string across every flip it
  // can make - and drawIfChanged compares text only.
  if (vcol != stVerdictColorCache) { stVerdictColorCache = vcol; stVerdictCache[0] = '\0'; }
  drawIfChanged(stVerdictCache, sizeof(stVerdictCache), buf, xLeft,
                ST_CONN_Y + ST_BIG_DY, T_HEAD, 1, vcol, COLOR_CARD);
  {
    const char* links = (bt && usb) ? "USB and Bluetooth"
                      : bt          ? "Bluetooth"
                      : usb         ? "USB"
                                    : "nothing connected";
    // The age is the same fact the footer's "Xs ago" reports, capped at 9999s so
    // the padded width cannot grow past what ST_LINE_CHARS was derived for. Before
    // the first line arrives it says "waiting" rather than "0s ago": 0 is a
    // measurement and "never measured" is not, the rule the Codex row follows.
    // With NEITHER link up there is no age worth stating, so the phrase stands
    // alone - "nothing connected, 12s ago" would read as a claim about 12s ago.
    if (!bt && !usb) snprintf(buf, sizeof(buf), "%s", links);
    else if (!everReceived) snprintf(buf, sizeof(buf), "%s, waiting", links);
    else {
      unsigned long age = (millis() - lastRxMillis) / 1000;
      if (age > 9999) age = 9999;
      snprintf(buf, sizeof(buf), "%s, %lus ago", links, age);
    }
    padTo(buf, sizeof(buf), ST_LINE_CHARS);
    drawIfChanged(stLinksCache, sizeof(stLinksCache), buf, xLeft,
                  ST_CONN_Y + ST_L1_DY, T_BODY, 1, COLOR_LABEL, COLOR_CARD);
  }
  // Who this device IS, and how many Macs it will answer. Both change only on a
  // pairing event, but they are drawn through the same change-only field as
  // everything else here rather than being painted with the card: a value on the
  // static side is a value that goes stale silently.
  if (hostCount == 0)      snprintf(buf, sizeof(buf), "%s, unpaired", deviceName);
  else if (hostCount == 1) snprintf(buf, sizeof(buf), "%s, 1 paired", deviceName);
  else                     snprintf(buf, sizeof(buf), "%s, %d paired", deviceName, hostCount);
  padTo(buf, sizeof(buf), ST_LINE_CHARS);
  drawIfChanged(stIdCache, sizeof(stIdCache), buf, xLeft,
                ST_CONN_Y + ST_L2_DY, T_BODY, 1, COLOR_LABEL, COLOR_CARD);

  // ---- POWER: the reading, the estimate, the die temp ----
  BattState bst = batteryState();
  int pct = batteryPresent() ? batteryPct() : -1;
  if (bst == BATT_NONE) snprintf(buf, sizeof(buf), "no battery");
  else snprintf(buf, sizeof(buf), "%d%%  %d.%02dV", pct, batteryMv / 1000, (batteryMv % 1000) / 10);
  padTo(buf, sizeof(buf), ST_BIG_CHARS);
  // Same level colour as the footer pill - the two show the same reading, so they
  // must not disagree about how healthy it is - and cache-busted on a flip,
  // because plugging in changes the colour while "42%  3.85V" stays identical.
  uint16_t rowCol = (bst == BATT_NONE) ? COLOR_LABEL : colorForBatteryState(pct, bst);
  if (rowCol != battRowColorCache) { battRowColorCache = rowCol; battRowTextCache[0] = '\0'; }
  drawIfChanged(battRowTextCache, sizeof(battRowTextCache), buf, xLeft,
                ST_PWR_Y + ST_BIG_DY, T_HEAD, 1, rowCol, COLOR_CARD);
  {
    // THE LABEL IS DRAWN VERBATIM, and the sentence is built AROUND it rather than
    // translating it. battLeftLabel() renders "~" (about) and battChargeLabel()
    // ">=" (at LEAST - the fit is taken below the CV knee and extrapolates through
    // it, so the figure is a floor). Rendering either as the other, or as prose
    // that flattens the two into one word, tells the reader the charge will finish
    // sooner than it will. An empty label means "not measurable yet", which is a
    // different claim from a number and gets a different sentence, never a
    // placeholder duration.
    char left[BATT_LEFT_BYTES] = "";
    if (bst == BATT_DISCHARGING) battLeftLabel(left, sizeof(left), battMinutesLeft());
    else if (bst == BATT_CHARGING) battChargeLabel(left, sizeof(left), battChargeMinutesToFull());
    if (bst == BATT_NONE)                 snprintf(buf, sizeof(buf), "no battery fitted");
    else if (bst == BATT_FULL)            snprintf(buf, sizeof(buf), "battery full");
    else if (bst == BATT_CHARGING) {
      // "topping up" is battChargeLabel()'s refusal above the knee, not a
      // duration, so it cannot take the "to full" tail a ">=" figure does.
      if (left[0] == '>')      snprintf(buf, sizeof(buf), "charging, %s to full", left);
      else if (left[0])        snprintf(buf, sizeof(buf), "charging, %s", left);
      else                     snprintf(buf, sizeof(buf), "charging");
    }
    else if (left[0])                     snprintf(buf, sizeof(buf), "%s left on battery", left);
    else                                  snprintf(buf, sizeof(buf), "on battery");
    padTo(buf, sizeof(buf), ST_LINE_CHARS);
    drawIfChanged(stLeftCache, sizeof(stLeftCache), buf, xLeft,
                  ST_PWR_Y + ST_L1_DY, T_BODY, 1, COLOR_LABEL, COLOR_CARD);
  }
  {
    // "--" when the sensor never came up, never a plausible 0.0 - a measurement and
    // a failure must not render identically. It says SoC, never "Temp", because the
    // sensor is inside the package and cannot see the charger or the cell: the
    // label is the only place a reader learns which temperature this is.
    float dieC = 0;
    uint16_t tcol;
    if (dieTempRead(&dieC)) {
      snprintf(buf, sizeof(buf), "SoC %.1f C", dieC);
      tcol = colorForDieTemp(dieC);
    } else {
      snprintf(buf, sizeof(buf), "SoC --");
      tcol = COLOR_LABEL;
    }
    padTo(buf, sizeof(buf), ST_LINE_CHARS);
    // Cached colour beside the text, the guard battRowColorCache documents:
    // crossing a band while the digits stay identical would never repaint.
    if (tcol != tempRowColorCache) { tempRowColorCache = tcol; tempRowTextCache[0] = '\0'; }
    drawIfChanged(tempRowTextCache, sizeof(tempRowTextCache), buf, xLeft,
                  ST_PWR_Y + ST_L2_DY, T_BODY, 1, tcol, COLOR_CARD);
  }

  // ---- HOST: four diagnostics, two columns ----
  // They earn their place on this board specifically because there is no serial
  // console in normal operation here: "how big and how slow is a frame, how long
  // has this been up, and how many Macs are on it" was otherwise unanswerable from
  // the device itself. Host LIVENESS is not among them - it leads the CONNECTION
  // card above, which is where it belongs and where it stopped being a fifth
  // diagnostic among equals.
  if (lastPayloadBytes == 0) snprintf(buf, sizeof(buf), "no payload yet");
  else snprintf(buf, sizeof(buf), "%u B per tick", (unsigned) lastPayloadBytes);
  padTo(buf, sizeof(buf), ST_HOST_L_CHARS);
  drawIfChanged(stPayloadCache, sizeof(stPayloadCache), buf, xLeft,
                ST_HOST_Y + ST_HOST_R1_DY, T_BODY, 1, COLOR_VALUE, COLOR_CARD);
  {
    // Milliseconds to one decimal, clamped at 999.9 so the padded width is fixed.
    uint32_t us = tft.lastFlushUs();
    unsigned long ms = us / 1000, tenth = (us % 1000) / 100;
    if (ms > 999) { ms = 999; tenth = 9; }
    snprintf(buf, sizeof(buf), "flush %lu.%lu ms", ms, tenth);
  }
  padTo(buf, sizeof(buf), ST_HOST_L_CHARS);
  drawIfChanged(stFlushCache, sizeof(stFlushCache), buf, xLeft,
                ST_HOST_Y + ST_HOST_R2_DY, T_BODY, 1, COLOR_VALUE, COLOR_CARD);
  {
    unsigned long mins = millis() / 60000UL;
    if (mins > 99UL * 60 + 59) mins = 99UL * 60 + 59;
    snprintf(buf, sizeof(buf), "up %luh %02lum", mins / 60, mins % 60);
  }
  padLeftTo(buf, sizeof(buf), ST_HOST_R_CHARS);
  drawIfChanged(stUptimeCache, sizeof(stUptimeCache), buf, xRight,
                ST_HOST_Y + ST_HOST_R1_DY, T_BODY, 1, COLOR_VALUE, COLOR_CARD, TR_DATUM);
  {
    int live = usedLinkCount();
    if (live == 0) snprintf(buf, sizeof(buf), "no Macs");
    else snprintf(buf, sizeof(buf), "%d Mac%s", live, live == 1 ? "" : "s");
  }
  padLeftTo(buf, sizeof(buf), ST_HOST_R_CHARS);
  drawIfChanged(stMacsCache, sizeof(stMacsCache), buf, xRight,
                ST_HOST_Y + ST_HOST_R2_DY, T_BODY, 1, COLOR_VALUE, COLOR_CARD, TR_DATUM);
}
#else
// BOARD 1's STATUS page, unchanged: the DEVICE card, its connection rows and the
// two per-Mac link rows. Everything below this line is the text that was always
// here, so a comment inside it that mentions board 2 is describing the constant it
// names rather than this page - board 2 does not compile any of it.
void drawStatusPageStatic() {
  char buf[36];
  uiCard(CARD_X, DEV_CARD_Y, CARD_W, DEV_CARD_H);
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("DEVICE", CARD_X + PAD, DEV_CARD_Y + 6);
  setUIFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.drawString("Bluetooth", CARD_X + PAD + 20, DEV_CARD_Y + DROW_BT);
  tft.drawString("USB", CARD_X + PAD + 20, DEV_CARD_Y + DROW_USB);
  tft.drawString("Battery", CARD_X + PAD + 20, DEV_CARD_Y + DROW_BATT);
  if (hostCount == 0) snprintf(buf, sizeof(buf), "%s  unpaired", deviceName);
  else if (hostCount == 1) snprintf(buf, sizeof(buf), "%s  paired", deviceName);
  else snprintf(buf, sizeof(buf), "%s  paired x%d", deviceName, hostCount);
  setUIFont(1);
  tft.setTextColor(isPaired() ? COLOR_GOOD : COLOR_WARN, COLOR_CARD);
  tft.drawString(buf, CARD_X + PAD, DEV_CARD_Y + DROW_ID);
}
// One connection row: dot left, right-aligned status text.
void drawConnRow(int rowOff, bool connected) {
  int y = DEV_CARD_Y + rowOff;
  drawConnDot(CARD_X + PAD + 6, y + 8, 6, connected, COLOR_CARD);
  int xRight = CARD_X + CARD_W - PAD;
  // CONN_TEXT_W/H, not a literal 100x16: the box has to cover the widest string
  // this row can draw ("Not connected") AT THIS BOARD'S OWN ADVANCE. At 6px that
  // is 78 of 100 with room to spare; at 8px it is 104 of 100, so the left edge of
  // the "N" survived a change to "Connected" as a 4px ghost - too small to read as
  // a stale value, which is what makes it worth a named constant.
  tft.fillRect(xRight - CONN_TEXT_W, y, CONN_TEXT_W, CONN_TEXT_H, COLOR_CARD);
  setUIFont(2);
  tft.setTextColor(connected ? COLOR_GOOD : COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(connected ? "Connected" : "Not connected", xRight, y);
  tft.setTextDatum(TL_DATUM);
}
void renderStatusPage() {
  char buf[36];
  bool btConnected = bleConnected;
  if ((btConnected ? 1 : 0) != btDotCache) { btDotCache = btConnected ? 1 : 0; drawConnRow(DROW_BT, btConnected); }
  bool usbConnected = usbLinkActive();
  if ((usbConnected ? 1 : 0) != usbDotCache) { usbDotCache = usbConnected ? 1 : 0; drawConnRow(DROW_USB, usbConnected); }
  BattState bst = batteryState();
  int pct = batteryPresent() ? batteryPct() : -1;
  int battHealthy = (bst == BATT_CHARGING || bst == BATT_FULL || pct > 20) ? 1 : 0;
  if (battHealthy != battRowCache) {
    battRowCache = battHealthy;
    drawConnDot(CARD_X + PAD + 6, DEV_CARD_Y + DROW_BATT + 8, 6, battHealthy, COLOR_CARD);
  }
  if (bst == BATT_NONE) snprintf(buf, sizeof(buf), "not found");
  else {
    // Runtime left is appended only once it has actually been MEASURED - see
    // battMinutesLeft(). While charging there is nothing to state, and for the
    // first ~20 minutes off USB the trend is still inside the ADC's noise, so the
    // row reads exactly as it always did rather than showing a placeholder.
    // BATT_LEFT_BYTES, per board: 8 on board 1, whose widest is the discharge
    // "~119m", and 12 on board 2, which also draws "topping up" (10 + NUL). A shared
    // literal 12 here moved board 1's binary at +0 bytes - caught by
    // board-baseline.mjs, invisible to any size check.
    char left[BATT_LEFT_BYTES] = "";
    if (bst == BATT_DISCHARGING) battLeftLabel(left, sizeof(left), battMinutesLeft());
    snprintf(buf, sizeof(buf), "%d%% %d.%02dV%s%s", pct, batteryMv / 1000,
             (batteryMv % 1000) / 10, left[0] ? " " : "", left);
  }
  // 15 = "100% 4.20V ~99h", the widest this can be, and the only number here that
  // is not per-board: it is the width of the DATA. It is 90px in Cozette 6x13 and
  // 120px in Spleen 8x16, right-aligned to CARD_X + CARD_W - PAD, against a
  // "Battery" label ending at CARD_X + PAD + 20 + textWidth("Battery") - which
  // leaves 36px of clearance on board 1 and 64 on board 2 (the 108 an earlier
  // revision claimed was board 2's lane measured at board 1's advance). Widening
  // the format past 15 eats board 1's 36 first; settings-geom-check.mjs asserts
  // both.
  padLeftTo(buf, sizeof(buf), 15);
  // Same level colour as the footer pill - the two show the same reading, so
  // they must not disagree about how healthy it is. Cache-busted on a colour
  // flip: plugging in changes the colour while "42% 3.85V" stays identical, and
  // a text-only compare would never repaint it.
  uint16_t rowCol = (bst == BATT_NONE) ? COLOR_LABEL : colorForBatteryState(pct, bst);
  if (rowCol != battRowColorCache) {
    battRowColorCache = rowCol;
    battRowTextCache[0] = '\0';
  }
  // DROW_BATT_VAL_DY, not a literal 4: at board 1's 13px line a 4px stagger
  // between the "Battery" label and the reading beside it is invisible and ships
  // unchanged; at 16px it reads as two halves of one row failing to line up, so
  // board 2 sets it to 0 and draws them on the same baseline.
  drawIfChanged(battRowTextCache, sizeof(battRowTextCache), buf, CARD_X + CARD_W - PAD,
                DEV_CARD_Y + DROW_BATT + DROW_BATT_VAL_DY, 1, 1, rowCol, COLOR_CARD, TR_DATUM);
  renderMacLinkRows();
}
// Per-Mac, because the footer can only carry ONE "Xs ago" and it shows the
// freshest link - which would otherwise let a silent second Mac look live.
// Two fixed row SLOTS (DROW_MAC0/DROW_MAC1), filled by however many links
// are actually used, compacted to the top - so with only one Mac connected
// its row always lands in slot 0, never leaving an empty slot 0 above it.
void renderMacLinkRows() {
  int used[MAX_LINKS], usedN = 0;
  for (int i = 0; i < MAX_LINKS; i++) if (hostLinks[i].used) used[usedN++] = i;
  for (int row = 0; row < MAX_LINKS; row++) {
    char who[12] = "";
    unsigned long age = 0;
    int rowEmoji = -1;
    bool present = row < usedN;
    if (present) {
      HostLink& hl = hostLinks[used[row]];
      age = (millis() - hl.lastPayloadMillis) / 1000;
      snprintf(who, sizeof(who), "%s", hl.tag[0] ? hl.tag : hl.hostId);
      rowEmoji = emojiIdForLink(used[row]);
    }
    char buf2[32] = "";
    if (present) snprintf(buf2, sizeof(buf2), "Mac  %s  %lus ago", who, age);
    // Pad even the blank (unused) case to the SAME fixed width - see the
    // macRowCache comment for why that's what makes a row actually erase
    // when its Mac drops off, rather than just stop updating.
    padTo(buf2, sizeof(buf2), MAC_ROW_W);
    // The icon id rides after a \x01 sentinel PURELY so a changed icon busts
    // this row's cache below - it is never drawn (the pieces drawn further
    // down are "Mac", the icon, and "<who>  <age>s ago", never this string).
    // Without it, the row would keep showing a stale icon forever, since the
    // visible text is identical when only the icon changes. This can't go
    // through drawIfChanged() the way every other field here does, because
    // that helper draws exactly the string it's given - passing it this
    // sentinel-and-id-carrying string would print the sentinel and the digit.
    char sig[40];
    snprintf(sig, sizeof(sig), "%s\x01%d", buf2, rowEmoji);
    int y = DEV_CARD_Y + (row == 0 ? DROW_MAC0 : DROW_MAC1);
    int textX = CARD_X + PAD;
    if (strncmp(macRowCache[row], sig, sizeof(macRowCache[row])) == 0) continue;
    strncpy(macRowCache[row], sig, sizeof(macRowCache[row]) - 1);
    macRowCache[row][sizeof(macRowCache[row]) - 1] = '\0';
    setUIFont(T_META);
    tft.setTextColor(COLOR_VALUE, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    int th = uiLineH(T_META);
    // The erase box always reserves the icon's slot (4px gap + MAC_EMOJI_SIZE)
    // whether or not this row currently has one: an icon that disappears must not leave a
    // ghost, and one that appears must not draw over stale pixels left behind
    // by the plain-text layout.
    int eraseW = tft.textWidth(buf2) + 4 + MAC_EMOJI_SIZE + 2;
    tft.fillRect(textX - 1, y - 1, eraseW, th + 2, COLOR_CARD);
    if (rowEmoji >= 0) {
      // "Mac", then the icon 4px later, then the rest of the row shifted right
      // by the icon's slot - the same 4px gap, and the same y as the text (the
      // icon IS the body cell height on either board, so no centring arithmetic
      // is needed), that every other icon-beside-text surface in this sketch uses.
      // Width, at each board's own advance: MAC_ROW_W (28) chars + 4 + the icon +
      // 2 is 187px from x=26 on board 1 (interior to 226) and 246px from x=30 on
      // board 2 (interior to 305). Height: the row's clear box is uiLineH(T_META)
      // + 2, which the icon sits inside by construction - board 2's rows clear
      // +129..+146 and +153..+170, so the icon's 16 rows leave 7 rows between them.
      tft.drawString("Mac", textX, y);
      int iconX = textX + tft.textWidth("Mac") + 4;
      drawEmoji(rowEmoji, iconX, y, COLOR_CARD);
      char rest[32];
      snprintf(rest, sizeof(rest), "%s  %lus ago", who, age);
      tft.drawString(rest, iconX + MAC_EMOJI_SIZE + 4, y);
    } else {
      tft.drawString(buf2, textX, y);
    }
  }
}
#endif
// ----- Page 1: CONTROLS -----
#if !BOARD_SETTINGS_HOME
void drawControlsPageStatic() {
  drawStepperCard(P1_BRIGHT_Y, "BRIGHTNESS");
  drawStepperCard(P1_SLEEP_Y, "SLEEP AFTER");
  drawStepperCard(P1_VOL_Y, "VOLUME");
  // SOUND toggle drawn by renderControlsPage (look changes with state).
}
void renderControlsPage() {
  char buf[16];
  const int rightBtnX = CARD_X + CARD_W - PAD - STEP_BTN_SIZE;
  const int cx = tft.width() / 2;
  // Values render in T_HEAD (Terminus 10x18 bold), the type scale's middle rung:
  // the number is what you are actually reading here, and at body size it was the
  // same weight as the label naming it.
  snprintf(buf, sizeof(buf), "%d%%", brightnessPct);
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(brightPctCache, sizeof(brightPctCache), buf, cx, P1_BRIGHT_Y + STEP_VALUE_CY,
                T_HEAD, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  // Only BRIGHTNESS gets a bar. It is the one continuous 0-100 setting, so the
  // bar says where in the range you are; sleep and volume are discrete presets
  // where the label already says that, and a bar would be decoration.
  drawBar(&brightBarCache, CARD_X + PAD + STEP_BTN_SIZE + STEP_BAR_GAP,
          P1_BRIGHT_Y + STEP_BAR_Y,
          CARD_W - 2 * (PAD + STEP_BTN_SIZE + STEP_BAR_GAP), STEP_BAR_H,
          brightnessPct, COLOR_ACCENT);
  drawStepGlyph(0, CARD_X + PAD, stepBtnY(P1_BRIGHT_Y), "-", brightnessPct > BRIGHTNESS_MIN);
  drawStepGlyph(1, rightBtnX, stepBtnY(P1_BRIGHT_Y), "+", brightnessPct < 100);

  formatSleepValue(buf, sizeof(buf));
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(sleepValCache, sizeof(sleepValCache), buf, cx, P1_SLEEP_Y + STEP_VALUE_CY,
                T_HEAD, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  drawStepGlyph(2, CARD_X + PAD, stepBtnY(P1_SLEEP_Y), "-", sleepPresetIdx > 0);
  drawStepGlyph(3, rightBtnX, stepBtnY(P1_SLEEP_Y), "+", sleepPresetIdx < SLEEP_PRESETS_COUNT - 1);

  snprintf(buf, sizeof(buf), "%s", VOL_LABELS[volPresetIdx]);
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(volValCache, sizeof(volValCache), buf, cx, P1_VOL_Y + STEP_VALUE_CY,
                T_HEAD, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  drawStepGlyph(4, CARD_X + PAD, stepBtnY(P1_VOL_Y), "-", volPresetIdx > 0);
  drawStepGlyph(5, rightBtnX, stepBtnY(P1_VOL_Y), "+", volPresetIdx < VOL_PRESETS_COUNT - 1);

  // Three toggles sharing the bottom row: SOUND, the screen flip, and the theme.
  // A full-width row for each wouldn't fit (board 1 has only 32px left under this
  // one; board 2 has 22), and all three are booleans so they read naturally side
  // by side. State is shown by fill AND by the label text, never colour alone.
  // Their WIDTH is measured, not counted: P1_THIRD_W is 66 on board 1 and 93 on
  // board 2, against a widest label ("FLIPPED") of 42px and 56px respectively -
  // see each board header's own derivation.
  if ((int) beepEnabled != soundBtnCache) {
    soundBtnCache = (int) beepEnabled;
    uiToggle(CARD_X, P1_SOUND_Y, P1_THIRD_W, P1_SOUND_H, "SOUND", "MUTED", beepEnabled);
  }
  if ((int) screenFlipped != flipBtnCache) {
    flipBtnCache = (int) screenFlipped;
    uiToggle(P1_FLIP_X, P1_SOUND_Y, P1_THIRD_W, P1_SOUND_H, "FLIPPED", "NORMAL", screenFlipped);
  }
  // The theme control has THREE states, so it cannot be a uiToggle - it cycles
  // DARK -> LIGHT -> AUTO and shows the mode it is in. It also needs its OWN
  // cache: it used to be drawn inside the flip toggle's block, so it repainted
  // only when the FLIP state changed, and got away with it because the only
  // thing that altered it was a tap that forced a full repaint anyway. AUTO
  // breaks that - it changes the palette on a timer, with no tap involved.
  if ((int) themeMode != themeBtnCache) {
    themeBtnCache = (int) themeMode;
    const char* lbl = themeMode == THEME_MODE_DARK  ? "DARK"
                    : themeMode == THEME_MODE_LIGHT ? "LIGHT" : "AUTO";
    // Same convention as its neighbours: filled and accented once it is off the
    // default, outlined and grey while it is on it.
    uiButton(P1_THEME_X, P1_SOUND_Y, P1_THIRD_W, P1_SOUND_H, lbl,
             themeMode == THEME_MODE_DARK ? COLOR_LABEL : COLOR_ACCENT,
             themeMode != THEME_MODE_DARK);
  }
}
#else
// ----- The DISPLAY group (board 2) -----
// Two steppers, then the THEME block: a caption, three segments, and the hint that
// says what AUTO actually means. A cycle button shows one state and hides the other
// two, and THEME has three - so it was never a uiToggle and it is not one here.
void drawDisplayPageStatic() {
  drawStepperCard(P1_BRIGHT_Y, "BRIGHTNESS");
  drawStepperCard(P1_SLEEP_Y, "SLEEP AFTER");
  drawGroupCaption("THEME", P1_THEME_CAP_Y);
  // AUTO is a CLOCK, not a sensor - every ADC1 channel on this board is spoken for,
  // so there is no light to measure. Saying so is the same rule that stops the
  // farewell screen promising a touch wake this board does not have.
  uiHint("AUTO = light 07:00 to 19:00", P1_AUTO_HINT_Y);
  // The segments and the flip toggle are drawn by renderDisplayPage - their look
  // changes with state, so they belong on the change-only side.
}
void renderDisplayPage() {
  char buf[16];
  const int rightBtnX = CARD_X + CARD_W - PAD - STEP_BTN_SIZE;
  const int cx = tft.width() / 2;
  snprintf(buf, sizeof(buf), "%d%%", brightnessPct);
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(brightPctCache, sizeof(brightPctCache), buf, cx, P1_BRIGHT_Y + STEP_VALUE_CY,
                T_HEAD, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  // Only BRIGHTNESS gets a bar - it is the one continuous 0-100 setting, so the bar
  // says where in the range you are. VOLUME is three named presets and now lives on
  // the SOUND group, where it correctly has none.
  drawBar(&brightBarCache, CARD_X + PAD + STEP_BTN_SIZE + STEP_BAR_GAP,
          P1_BRIGHT_Y + STEP_BAR_Y,
          CARD_W - 2 * (PAD + STEP_BTN_SIZE + STEP_BAR_GAP), STEP_BAR_H,
          brightnessPct, COLOR_ACCENT);
  drawStepGlyph(0, CARD_X + PAD, stepBtnY(P1_BRIGHT_Y), "-", brightnessPct > BRIGHTNESS_MIN);
  drawStepGlyph(1, rightBtnX, stepBtnY(P1_BRIGHT_Y), "+", brightnessPct < 100);

  formatSleepValue(buf, sizeof(buf));
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(sleepValCache, sizeof(sleepValCache), buf, cx, P1_SLEEP_Y + STEP_VALUE_CY,
                T_HEAD, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  drawStepGlyph(2, CARD_X + PAD, stepBtnY(P1_SLEEP_Y), "-", sleepPresetIdx > 0);
  drawStepGlyph(3, rightBtnX, stepBtnY(P1_SLEEP_Y), "+", sleepPresetIdx < SLEEP_PRESETS_COUNT - 1);

  // Three segments, one filled. Selection is fill AND position, never colour alone,
  // and all three options are on screen at once - which is the whole reason this is
  // not the cycle button board 1 still uses.
  if ((int) themeMode != themeBtnCache) {
    themeBtnCache = (int) themeMode;
    static const char* THEME_SEG[THEME_MODE_COUNT] = {"DARK", "LIGHT", "AUTO"};
    for (int i = 0; i < THEME_MODE_COUNT; i++) {
      bool on = (i == themeMode);
      uiButton(CARD_X + i * (P1_THEME_SEG_W + P1_THEME_GAP), P1_THEME_Y,
               P1_THEME_SEG_W, H_ROW, THEME_SEG[i],
               on ? COLOR_ACCENT : COLOR_LABEL, on);
    }
  }
  // THE LABEL NAMES ITS SUBJECT, because this control has no caption over it and
  // nothing else on the group says what is being flipped. Every other control here
  // is introduced by something: the two steppers carry their own card labels, the
  // segments sit under "THEME", and the SOUND group's toggle next door already
  // reads "SOUND ON"/"SOUND OFF". A bare "NORMAL" under an unrelated hint about
  // AUTO was the one board-2 settings control that named neither itself nor its
  // subject. Naming it in the LABEL rather than adding a caption is what makes it
  // free: 13-14 characters is 104-112px in a 296px control, and no offset moves.
  if ((int) screenFlipped != flipBtnCache) {
    flipBtnCache = (int) screenFlipped;
    uiToggle(CARD_X, P1_FLIP_Y, CARD_W, H_ROW, "SCREEN FLIPPED", "SCREEN NORMAL", screenFlipped);
  }
}
// ----- The SOUND group (board 2) -----
// Output and input together, because a mic test IS a sound test - and it is the one
// action you run repeatedly, since MICMON is how MIC_GAIN gets settled.
void drawSoundPageStatic() {
  drawGroupCaption("ALERTS", PS_ALERTS_Y);
  uiHint("beeps when a session needs input", PS_WHAT_HINT_Y);
  drawStepperCard(PS_VOL_Y, "VOLUME");
  uiButton(CARD_X, PS_BEEP_Y, CARD_W, PS_BTN_H, "TEST BEEP", COLOR_ACCENT);
  drawGroupCaption("MICROPHONE", PS_MIC_CAP_Y);
  uiButton(CARD_X, PS_MIC_Y, CARD_W, PS_BTN_H, "MIC TEST", COLOR_ACCENT);
  // The SOUND toggle is drawn by renderSoundPage - its look changes with state.
}
void renderSoundPage() {
  char buf[16];
  const int rightBtnX = CARD_X + CARD_W - PAD - STEP_BTN_SIZE;
  if ((int) beepEnabled != soundBtnCache) {
    soundBtnCache = (int) beepEnabled;
    uiToggle(CARD_X, PS_SOUND_Y, CARD_W, H_ROW, "SOUND ON", "SOUND OFF", beepEnabled);
  }
  snprintf(buf, sizeof(buf), "%s", VOL_LABELS[volPresetIdx]);
  padTo(buf, sizeof(buf), 5);
  drawIfChanged(volValCache, sizeof(volValCache), buf, tft.width() / 2, PS_VOL_Y + STEP_VALUE_CY,
                T_HEAD, 1, COLOR_VALUE, COLOR_CARD, MC_DATUM);
  // Glyph cache slots 4/5 are still VOLUME's - the six slots are per CONTROL, and
  // the volume stepper only changed which page it is drawn on.
  drawStepGlyph(4, CARD_X + PAD, stepBtnY(PS_VOL_Y), "-", volPresetIdx > 0);
  drawStepGlyph(5, rightBtnX, stepBtnY(PS_VOL_Y), "+", volPresetIdx < VOL_PRESETS_COUNT - 1);
}
#endif
// Wipe EVERY remembered Mac so the device is fully unpaired and ready to bond
// fresh. The next Mac it's plugged into over USB will PROVISION a new key (see
// the HELLO/PROVISION handshake). Deliberately does NOT re-announce HELLO here -
// that would let the currently-connected Mac immediately re-pair, defeating the
// point when you're about to move the device. To drop just one Mac and keep the
// rest, use SETTINGS > PAIRED MACS instead.
void resetPairing() {
  for (int i = 0; i < MAX_HOSTS; i++) {
    hosts[i].id[0] = 0; hosts[i].label[0] = 0; hosts[i].secret = "";
    saveHostSlot(i);
  }
  hostCount = 0;
  activeHost = -1;
  allowedHost[0] = 0;
  saveHostCount();
  saveAllowedHost();
  prefs.remove("blesecret"); // legacy key, so a migration can't resurrect it
  deviceNameReported = false;
  Serial.println("PAIRING: reset by user (device is now unpaired)");
  // Brief confirmation, then rebuild whatever settings surface raised this. NOT
  // "then STATUS now reads unpaired": the rebuild draws settingsPage, which is the
  // ACTIONS page (board 1) or the Actions group (board 2) that this was tapped
  // from - the page whose text changes is one the user has to navigate back to.
  // delay() is fine here - matches the calibrate/power-off flows.
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("Pairing reset", tft.width() / 2, tft.height() / 2 - 14);
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString("plug into a Mac over USB to re-pair", tft.width() / 2, tft.height() / 2 + 12);
  tft.setTextDatum(TL_DATUM);
#if !BOARD_USES_TFT_ESPI
  // FLUSH BEFORE THE DWELL. The comment above claims parity with the
  // calibrate/power-off flows and this was the one of the three that did not
  // have it: on a shadow-buffered board the 1600ms was spent displaying the
  // CONFIRM DIALOG this screen replaced, so "Pairing reset" reached the glass
  // for zero frames. Nothing could see it either - readRect reads the same
  // framebuffer, drawBitmap reports success, and the geometry checkers read
  // constants, so an unflushed region is invisible to every instrument this
  // repo has. Found by a whole-branch review reading the three flows against
  // each other, which is the only thing that could have.
  tft.flush();
#endif
  delay(1600);
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}
// ----- Page 2: ACTIONS -----
#if BOARD_SETTINGS_HOME
// ----- The ACTIONS group (board 2) -----
// THREE buttons, in TWO captioned sections. MIC TEST is not here - it lives on the
// SOUND group, where a mic test belongs and where it is the one action you run
// repeatedly. What that buys is the room to say WHICH of these is safe.
//
// Before this the four were uiButton with `filled` false, i.e. four identically
// shaped outlined slabs differing only in stroke HUE - and this repo's rule is
// that meaning never rests on colour alone. Severity now has three carriers:
// POSITION (a captioned section of its own, separated by P2_SECTION_GAP), INK
// MASS (a solid spine, which survives greyscale and every colour-vision
// deficiency), and hue last.
// The spine sits BORDER_CTRL inside the button's own left edge and runs from R_MD
// to P2_BTN_H - R_MD, so it can never cross the rounded corner and paint over the
// stroke it exists to reinforce - settings-geom-check.mjs asserts both bounds. Its
// ends are rounded at P2_SPINE_W / 2 so it reads as a deliberate mark rather than
// as a clipped edge, and its backdrop is COLOR_CARD because it is drawn ON the
// button's interior fill, not on the page.
void drawSeverityAction(int y, const char* label, uint16_t tint) {
  uiButton(CARD_X, y, CARD_W, P2_BTN_H, label, tint);
  uiFillRound(CARD_X + BORDER_CTRL, y + R_MD, P2_SPINE_W, P2_BTN_H - 2 * R_MD,
              P2_SPINE_W / 2, tint, COLOR_CARD);
}
void drawActionsPageStatic() {
  drawGroupCaption("SETUP", P2_SETUP_CAP_Y);
  uiButton(CARD_X, P2_CAL_Y, CARD_W, P2_BTN_H, "CALIBRATE TOUCH", COLOR_ACCENT);
  drawGroupCaption("CANNOT BE UNDONE", P2_DANGER_CAP_Y);
  drawSeverityAction(P2_PAIR_Y, "RESET PAIRING", COLOR_WARN);
  drawSeverityAction(P2_PWR_Y,  "POWER OFF",     COLOR_BAD);
  // The hint has to match what the chip can actually do, the same rule the
  // farewell screens and the standalone screen already follow: a board that
  // cannot wake on touch must not promise one, because that reads as broken
  // firmware where the truth reads as a device that told you.
#if BOARD_HAS_TOUCH_SLEEP_WAKE
  uiHint("power off = deep sleep, touch to wake", P2_HINT_Y);
#else
  uiHint("power off = deep sleep, RESET to wake", P2_HINT_Y);
#endif
}
#else
void drawActionsPageStatic() {
  // Four buttons, one component, escalating intent: accent = safe,
  // warn = changes pairing, bad = powers the device down. MIC TEST leads because
  // it is the only one you might run repeatedly (it is how you set the trimmer).
#if BOARD_HAS_MIC
  uiButton(CARD_X, P2_MIC_Y,  CARD_W, P2_BTN_H, "MIC TEST",        COLOR_ACCENT);
#endif
  uiButton(CARD_X, P2_CAL_Y,  CARD_W, P2_BTN_H, "CALIBRATE TOUCH", COLOR_ACCENT);
  uiButton(CARD_X, P2_PAIR_Y, CARD_W, P2_BTN_H, "RESET PAIRING",   COLOR_WARN);
  uiButton(CARD_X, P2_PWR_Y,  CARD_W, P2_BTN_H, "POWER OFF",       COLOR_BAD);
  // The hint has to match what the chip can actually do, the same rule the
  // farewell screens and the standalone screen already follow: a board that
  // cannot wake on touch must not promise one, because that reads as broken
  // firmware where the truth reads as a device that told you.
#if BOARD_HAS_TOUCH_SLEEP_WAKE
  uiHint("power off = deep sleep, touch to wake", P2_PWR_Y + P2_BTN_H + SP_3);
#else
  uiHint("power off = deep sleep, RESET to wake", P2_PWR_Y + P2_BTN_H + SP_3);
#endif
}
#endif
// ----- Page 3 / the PAIRING group -----
#if BOARD_SETTINGS_HOME
// THE LIVE MAC ROWS LAND HERE (board 2). They used to be on the STATUS page too,
// in a second format keyed off hostLinks[] rather than off hosts[] - so the list
// that owns the destructive controls was the one list that could not say whether
// a Mac was connected, while the page with no slack carried a duplicate of it.
//
// Liveness costs NO new state and nothing new on the wire: it is the same
// hostLinks[] lookup renderMacLinkRows() has always done, matched against the
// row's own hosts[i].id.
//
// The slot is returned whether or not it is `used`, because pruneStaleLinks()
// clears the FLAG and leaves the slot - so a Mac that has gone quiet this boot can
// still be dated. One that has no slot at all cannot be, and the row says so
// rather than inventing an age: there is no persisted lastSeen anywhere (a
// HostPairing is id, label and secret), and a fabricated "2d ago" would be the
// same failure as a Codex row printing 0% for "never measured".
int hostLinkSlotFor(const char* id) {
  for (int i = 0; i < MAX_LINKS; i++)
    if (hostLinks[i].hostId[0] && strcmp(hostLinks[i].hostId, id) == 0) return i;
  return -1;
}
int p3RowY(int i) { return P3_LIST_Y + i * P3_ROW_STEP; }
#if BOARD_HAS_WIRELESS_PAIR
// ============================================================================
// THE WIRELESS-PAIRING PANEL. BOARD 2 ONLY.
//
// CONFIRM ON THIS GLASS IS THE SECURITY PROPERTY, not a nicety. The first design
// committed on the Mac's HMAC proof alone, and that was broken: the proof derives
// from the ECDH shared secret and nothing else, so any peer that completes the
// exchange computes it WITHOUT EVER SEEING THE CODE - a racing attacker was stored
// in milliseconds. What commits now is Bluetooth's Numeric Comparison: the same
// six digits on two screens, a person comparing them, and a tap HERE naming this
// peer. So this button is the presence proof the cable used to be, and every rule
// below follows from that rather than from taste.
//
// See docs/superpowers/specs/2026-08-30-wireless-pairing.md and the block at the
// bottom of pairing.ino.
// ============================================================================
// The panel's own caches live here rather than beside the other settings caches in
// deckhand_display.ino, because PAIR_CODE_DIGITS is a #define in pairing.ino and
// this file is the first one concatenated after it that can see it. They are still
// reset by resetSettingsCaches(), like every other cache on this tab.
char pairLeftCache[PAIR_LEFT_BYTES] = "";
// The signature the panel repaints wholesale on: the six digits and the label. The
// CODE never changes within one exchange - a new PAIRREQ derives a new one, and the
// person in front of the glass is meant to SEE that - so the code is drawn once per
// request and the countdown beside it is the only change-only field. Repainting a
// 64px hero number once a second would be the flicker this file's whole redraw
// discipline exists to prevent.
char pairPanelSig[PAIR_CODE_DIGITS + PAIR_LABEL_BYTES + 2] = "";
// THE PANEL'S OWN SNAPSHOT OF THE LABEL, taken as it draws it. pairClose() wipes
// pairLabel with the rest of the exchange - correctly, that is what pairWipe() is
// for - so the result screen would otherwise have nothing to name. Taking it from
// what was DRAWN also means "PAIRED WITH <label>" is exactly the label the person
// was looking at when they compared the code, rather than a re-read of state that
// has since moved.
char pairPanelLabel[PAIR_LABEL_BYTES] = "";

// Is the panel showing a code that could be confirmed? ONE PREDICATE, pairing.ino's
// own, read by the draw site AND by the hit test - never two conditions that could
// disagree. This codebase's classic defect is a control drawn under one condition
// and hit-tested under another, and here that defect would commit a pairing key
// nobody approved: a CONFIRM tappable while invisible is the one bug on this screen
// that cannot be seen.
bool pairConfirmVisible() { return pairConfirmable(); }

// CANCEL always; CONFIRM only beside it, in the left half, once there is something
// to confirm. CANCEL keeps a FIXED slot rather than centring itself when it is
// alone: a button that moves when a request arrives is a button you can tap by
// accident at the exact moment the screen changed under your finger.
int pairCancelX() { return CARD_X + CARD_W - PAIR_BTN_W; }
int pairConfirmX() { return CARD_X; }

// The panel owns everything ABOVE the footer - the tab bar included, since chrome
// drawn but dead is the bug fabVisible() is gated in one place to avoid - and
// leaves the footer itself live, so the clock, the battery and the "Xs ago"
// freshness keep running through a 120s wait. Whether the Mac is still talking is
// exactly what you want to know while waiting for its request.
void drawPairPanelStatic() {
  tft.fillRect(0, 0, tft.width(), contentBottom(), COLOR_BG);
  const int cx = tft.width() / 2;
  setUIFont(T_HEAD);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(TC_DATUM);
  tft.drawString("PAIR NEW MAC", cx, PAIR_TITLE_Y);

  const bool haveCode = pairConfirmVisible();
  setUIFont(T_BODY);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString(haveCode ? "does your Mac show this?" : "waiting for a Mac", cx, PAIR_STATE_Y);

  if (haveCode) {
    // THE CODE IS ON THE GLASS AND NOWHERE ELSE. It is never sent, never logged and
    // never on the wire: a copy the Mac could read is a copy that skips the human,
    // and the human is what makes this equal to the cable.
    setUIFont(T_HERO);
    tft.setTextColor(COLOR_ACCENT, COLOR_BG);
    tft.drawString(pairCodeDigits, cx, PAIR_CODE_Y);
    // Attacker-controlled text, already ASCII-sanitised and capped by
    // pairSanitiseLabel - and fitText'd here as well, because drawString paints an
    // opaque box and a name wider than the panel would rub out its neighbours.
    strlcpy(pairPanelLabel, pairLabel, sizeof(pairPanelLabel));
    char shown[PAIR_LABEL_BYTES];
    fitText(shown, sizeof(shown), pairPanelLabel, CARD_W);
    setUIFont(T_BODY);
    tft.setTextColor(COLOR_VALUE, COLOR_BG);
    tft.drawString(shown, cx, PAIR_LABEL_Y);
  } else {
    setUIFont(T_BODY);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.drawString("pick this device on your Mac", cx, PAIR_LABEL_Y);
  }
  tft.setTextDatum(TL_DATUM);

  // CANCEL is the FILLED button and CONFIRM only outlined, the same hierarchy every
  // confirm dialog on this device uses: the safe option is the prominent one, and
  // the consequential one - here, the tap that stores a 128-bit key - must not also
  // be the easiest thing to hit.
  uiButton(pairCancelX(), PAIR_BTN_Y, PAIR_BTN_W, H_BTN, "CANCEL", COLOR_ACCENT, true);
  if (haveCode)
    uiButton(pairConfirmX(), PAIR_BTN_Y, PAIR_BTN_W, H_BTN, "CONFIRM", COLOR_GOOD, false);

  // The countdown's cache belongs to the panel that was just painted, so it is
  // dropped HERE rather than by the caller - the rule drawSettingsStatic() already
  // follows: this function repaints the pixels that field is drawn on, so its cache
  // is stale by definition afterwards, and a caller that forgot would leave the
  // countdown blank until the second it happened to change.
  pairLeftCache[0] = '\0';
  snprintf(pairPanelSig, sizeof(pairPanelSig), "%s|%s", pairCodeDigits, pairLabel);
}

// The verdict, and it FLUSHES BEFORE IT DELAYS. On a shadow-buffered board the
// message otherwise exists in memory for zero frames while the previous screen sits
// on the glass - the defect the farewell screens already fixed once.
void drawPairResult() {
  const char* head = "PAIRING FAILED";
  const char* sub  = "cancelled";
  uint16_t tint = COLOR_BAD;
  switch (pairResult) {
    case PAIR_RES_OK:        head = "PAIRED WITH";  sub = pairPanelLabel; tint = COLOR_GOOD; break;
    case PAIR_RES_BADPROOF:  sub = "code did not match"; break;
    case PAIR_RES_FULL:      sub = "no free slots";      break;
    case PAIR_RES_TIMEOUT:   sub = "timed out";          break;
    // PAIR_RES_CANCELLED and PAIR_RES_NONE both read "cancelled": NONE is what a
    // close from somewhere else looks like (the CANCEL button itself, or one of the
    // three safety closes), and inventing a cause for it would be worse than naming
    // the one thing that is certainly true - nothing was stored.
    default: break;
  }
  tft.fillRect(0, 0, tft.width(), contentBottom(), COLOR_BG);
  const int cx = tft.width() / 2;
  setUIFont(T_HEAD);
  tft.setTextColor(tint, COLOR_BG);
  tft.setTextDatum(TC_DATUM);
  tft.drawString(head, cx, PAIR_RESULT_Y);
  char shown[PAIR_LABEL_BYTES + 4];
  fitText(shown, sizeof(shown), sub, CARD_W);
  setUIFont(T_BODY);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.drawString(shown, cx, PAIR_RESULT_SUB_Y);
  tft.setTextDatum(TL_DATUM);
  tft.flush();          // BEFORE the dwell, never after it
  delay(PAIR_RESULT_MS);
}

// Leaves the panel and lands back on the Pairing group. It shuts the window as
// well: walking away from this screen must not leave the device armed, which is the
// one state that would make this weaker than the cable it replaces.
void closePairPanel() {
  pairPanelActive = false;
  pairClose("pairing panel closed");
  drawSettingsTab();
}

void openPairPanel() {
  pairOpen();
  pairPanelActive = true;
  pairPanelSig[0] = '\0';
  pairPanelLabel[0] = '\0';
  drawPairPanelStatic();
}

// The panel's whole tick: called from loop() twice a second and from handleLine()'s
// absorb, and change-only in both, so calling it more often costs nothing.
void renderPairPanel() {
  if (!pairPanelActive) return;
  // WHATEVER SHUT THE WINDOW, the panel ends here - a commit, a bad proof, the
  // Mac's own cancel, the 120s timeout, or one of the three safety closes. It is
  // done from this side rather than inside pairClose() because a successful commit
  // closes the window ITSELF, and a close that also tore the screen down would show
  // the verdict for zero frames.
  if (!pairWindowOpen()) {
    drawPairResult();
    closePairPanel();
    return;
  }
  // A new PAIRREQ replaces the pending one and derives a NEW code, so the whole
  // panel repaints rather than the digits being edited under the label.
  char sig[sizeof(pairPanelSig)];
  snprintf(sig, sizeof(sig), "%s|%s", pairCodeDigits, pairLabel);
  if (strncmp(sig, pairPanelSig, sizeof(sig)) != 0) { drawPairPanelStatic(); return; }

  char buf[PAIR_LEFT_BYTES + 4];
  long ms = (long) (pairWindowUntil - millis());
  if (ms < 0) ms = 0;
  // %3ld, NOT padTo(): this field is CENTRED, so trailing spaces would slide the
  // ink half a character left every time the count dropped below 100 and again
  // below 10. A leading-space numeric field keeps the string 9 characters wide AND
  // the "s left" in the same place, which is what makes a once-a-second update look
  // like a counter rather than a twitch.
  snprintf(buf, sizeof(buf), "%3lds left", (long) ((ms + 999) / 1000));
  drawIfChanged(pairLeftCache, sizeof(pairLeftCache), buf,
                tft.width() / 2, PAIR_LEFT_Y, T_BODY, 1, COLOR_LABEL, COLOR_BG, TC_DATUM);
}

// The panel's own clock, from loop(). It is NOT hung off the settings tab's 1s
// tick: that one is gated on everReceived, and the device most likely to be sitting
// on this screen is a fresh one no Mac has ever ticked. 500ms rather than 1000 so a
// once-a-second counter cannot appear to skip a second on a slow loop, and the
// field is change-only, so the extra call paints nothing.
void tickPairPanel() {
  if (!pairPanelActive) return;
  static unsigned long last = 0;
  if (millis() - last < 500) return;
  last = millis();
  renderPairPanel();
}

// Every tap on this surface is consumed, the way the reader's is: the tab bar under
// it is covered, so a tap that fell through would act on chrome the user cannot see.
void pairPanelTouch(int sx, int sy) {
  if (sy < PAIR_BTN_Y || sy >= PAIR_BTN_Y + H_BTN) return;
  if (sx >= pairCancelX() && sx < pairCancelX() + PAIR_BTN_W) { closePairPanel(); return; }
  // THE SAME PREDICATE THE DRAW SITE READ. Gating the hit test on anything else -
  // even on something that happens to agree today - is how a control becomes
  // tappable while invisible, and the thing this one does is store a pairing key.
  if (pairConfirmVisible() &&
      sx >= pairConfirmX() && sx < pairConfirmX() + PAIR_BTN_W) {
    pairConfirm();
    // pairConfirm() commits when the proof has already landed, which closes the
    // window - so ask the panel to reconcile immediately rather than waiting up to
    // half a second for the next tick to notice.
    renderPairPanel();
  }
}
#endif  // BOARD_HAS_WIRELESS_PAIR
void drawHostsPageStatic() {
  tft.fillRect(0, PAGE_TOP, tft.width(), contentBottom() - PAGE_TOP, COLOR_BG);
  drawGroupCaption("ANSWER PROMPTS FROM", P3_ANY_CAP_Y);
  // The ANY row keeps the component and the height it always had: it is a choice,
  // not a Mac, so it stays a uiListRow where the rows under it are cards.
  bool any = (allowedHost[0] == 0);
  uiListRow(CARD_X, P3_ANY_Y, CARD_W, H_ROW, "ANY MAC", any, any ? "SELECTED" : nullptr);
  drawGroupCaption("PAIRED MACS", P3_LIST_CAP_Y);
  // THE LIVE CACHES ARE DROPPED HERE, before the early return rather than after the
  // loop, for the reason drawSettingsStatic() resets caches inside itself: this
  // function repaints the cards those fields are drawn ON, so they are stale by
  // definition afterwards - and unlike every other page here it is also called
  // DIRECTLY from handleSettingsTouch (three sites), where there is no
  // drawSettingsStatic() upstream to have reset them. Above the return, so
  // forgetting the LAST Mac cannot leave a row's state behind for the next one to
  // inherit.
  for (int i = 0; i < MAX_HOSTS; i++) { p3SubCache[i][0] = '\0'; p3LiveCache[i] = -1; }
  // THE COUNT THIS PAINT IS FOR, recorded here rather than by the caller for the
  // same reason the two caches above are: renderHostsPage() compares against it
  // every tick and repaints this chrome when it moves, so the record has to be
  // made wherever the chrome is actually drawn. Above the early return, so the
  // no-Macs hint counts as a paint too.
  p3CountCache = hostCount;
#if BOARD_HAS_WIRELESS_PAIR
  // PAIR NEW MAC TAKES THE LIST'S NEXT FREE SLOT, and its ABSENCE at MAX_HOSTS is
  // how this page says "full" - the same limit twice over, since the slot with no
  // room on the screen is also the slot with no room in NVS. No confirm dialog: it
  // destroys nothing and it is undone by walking away.
  if (hostCount < MAX_HOSTS)
    uiButton(CARD_X, p3RowY(hostCount), CARD_W, H_ROW, "PAIR NEW MAC", COLOR_ACCENT, false);
  if (hostCount == 0) {
    // One slot LOWER than board 1's hint, because the button is standing where that
    // hint used to be - and the sentence changed with it, since the cable is no
    // longer the only way in.
    uiHint("or connect one over USB", P3_EMPTY_HINT_Y);
    return;
  }
#else
  if (hostCount == 0) {
    uiHint("No Mac paired yet - connect one over USB", P3_LIST_Y + P3_ROW_H / 2);
    return;
  }
#endif
  for (int i = 0; i < hostCount; i++) {
    int y = p3RowY(i);
    bool only = allowedHost[0] && strcmp(hosts[i].id, allowedHost) == 0;
    // Selection is the card's BORDER plus the "ONLY" tag - two carriers, never hue
    // alone. The card keeps its own COLOR_CARD surface rather than filling with the
    // accent the way uiListRow does, because the row carries a second line and a
    // live dot whose colours were chosen against that surface.
    uiCard(CARD_X, y, CARD_W, P3_ROW_H, only ? COLOR_ACCENT : COLOR_LABEL);
    // TWO MACS WITH THE SAME HOSTNAME ARE THE ORDINARY CASE, not a corner: a pair
    // of MacBook Pros both report "...-MacBook-Pro", the same collision that makes
    // macTag() render both as `pro`. Two identical rows here are worse than
    // cosmetic, because this page's controls are destructive and per-row - which
    // `x` forgets which Mac, and which one ONLY pins, becomes a guess. So when a
    // label is shared, the row carries the first 4 hex of the hostId: unique by
    // construction and needing nothing new on the wire.
    bool dupLabel = false;
    for (int j = 0; j < hostCount && !dupLabel; j++)
      if (j != i && hosts[i].label[0] && hosts[j].label[0] &&
          strcmp(hosts[j].label, hosts[i].label) == 0) dupLabel = true;
    char idtag[8] = "";
    if (dupLabel) snprintf(idtag, sizeof(idtag), " #%.4s", hosts[i].id);
    // THE LABEL IS WHAT GETS TRIMMED, NEVER THE SUFFIX - it is the only thing
    // telling two same-named Macs apart. Measured rather than counted, because
    // drawString paints an opaque box: an over-long name would rub out the ONLY
    // tag beside it and then the card border past that.
    setUIFont(T_BODY);
    const int nameX = CARD_X + PAD + P3_ROW_TEXT_DX;
    const int tagX  = CARD_X + CARD_W - (P3_X_W + SP_2);
    const int lane  = tagX - nameX - tft.textWidth(idtag)
                      - (only ? tft.textWidth("ONLY") + SP_2 : 0);
    char name[24];
    fitText(name, sizeof(name), hosts[i].label[0] ? hosts[i].label : hosts[i].id, lane);
    char row[40];
    snprintf(row, sizeof(row), "%s%s", name, idtag);
    tft.setTextColor(COLOR_VALUE, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(row, nameX, y + P3_ROW_NAME_DY);
    if (only) {
      // Right-anchored to the same inset uiListRow's rightInset reserved, so the
      // tag still cannot land on top of the "x".
      setUIFont(T_META);
      tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
      tft.setTextDatum(TR_DATUM);
      tft.drawString("ONLY", tagX, y + P3_ROW_NAME_DY);
    }
    // Trailing destructive affordance, inside the row's own surface and centred in
    // the P3_X_W zone that hit-tests it - drawn from the same constant, so the
    // glyph and its tap target cannot drift apart.
    setUIFont(T_HEAD);
    tft.setTextColor(COLOR_BAD, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("x", CARD_X + CARD_W - P3_X_W / 2, y + P3_ROW_H / 2);
    tft.setTextDatum(TL_DATUM);
  }
  // Painted here rather than left to the next tick: a caller that forgot would show
  // every state line and dot blank until that Mac's state happened to change.
  renderHostsPage();
}
// The one live part of the page: whether each remembered Mac is talking right now,
// and how long ago it last did. Runs on the same ~5s tick as every other group.
void renderHostsPage() {
  char buf[32];
  // A MAC CAN PAIR WHILE THIS GROUP IS OPEN, and nothing on that path repaints:
  // upsertHost() writes NVS and returns. Without this the loop below would draw a
  // dot and a state line at p3RowY(hostCount - 1) onto bare page background - no
  // card, no name, no "x" - while handleSettingsTouch's own `i < hostCount` walk
  // already claims that band, so its right end raises CFM_FORGET_HOST. A row you
  // cannot see that forgets a Mac when tapped. drawHostsPageStatic() sets
  // p3CountCache itself and then calls back here, so this recurses exactly once
  // and the nested call falls straight through to the fields.
  if (hostCount != p3CountCache) { drawHostsPageStatic(); return; }
  for (int i = 0; i < hostCount; i++) {
    int y = p3RowY(i);
    int slot = hostLinkSlotFor(hosts[i].id);
    int live = (slot >= 0 && hostLinks[slot].used) ? 1 : 0;
    if (live != p3LiveCache[i]) {
      p3LiveCache[i] = live;
      // Filled dot when connected, hollow ring when not - the same shape pair the
      // DEVICE card's connection rows use, so liveness never rests on hue.
      drawConnDot(CARD_X + PAD + P3_ROW_DOT_R,
                  y + P3_ROW_NAME_DY + uiLineH(T_BODY) / 2,
                  P3_ROW_DOT_R, live, COLOR_CARD);
      // The state line's COLOUR is a function of `live`, and drawIfChanged compares
      // text only - so the flag busts the text cache rather than merely redrawing
      // the dot. Today the two cannot disagree (a live row's line starts
      // "connected," and an idle one's does not), but relying on "the text happens
      // to change as well" is what made battRowTextCache correct by accident.
      p3SubCache[i][0] = '\0';
    }
    if (slot < 0) {
      // No link slot at all: nothing on this device knows when this Mac was last
      // here. Say that, rather than dating it from something else.
      snprintf(buf, sizeof(buf), "not seen since boot");
    } else {
      unsigned long secs = (millis() - hostLinks[slot].lastPayloadMillis) / 1000;
      if (live) {
        if (secs > 9999) secs = 9999;      // capped so the padded width cannot grow
        snprintf(buf, sizeof(buf), "connected, %lus ago", secs);
      } else if (secs < 60) {
        // Under a minute idle still reads in SECONDS, the same unit the live rows
        // use - "last seen 0m ago" beside a row ticking in seconds reads as a
        // stopped clock rather than as "just now".
        snprintf(buf, sizeof(buf), "last seen %lus ago", secs);
      } else {
        unsigned long mins = secs / 60;
        if (mins > 999) mins = 999;
        snprintf(buf, sizeof(buf), "last seen %lum ago", mins);
      }
    }
    padTo(buf, sizeof(buf), P3_SUB_CHARS);
    drawIfChanged(p3SubCache[i], sizeof(p3SubCache[i]), buf,
                  CARD_X + PAD + P3_ROW_TEXT_DX, y + P3_ROW_SUB_DY,
                  T_BODY, 1, live ? COLOR_GOOD : COLOR_LABEL, COLOR_CARD);
  }
}
#else
// Status is never colour-alone: the chosen
// Mac gets a filled pill and an "ONLY" tag, the connected one a bullet.
void drawHostsPageStatic() {
  tft.fillRect(0, PAGE_TOP, tft.width(), contentBottom() - PAGE_TOP, COLOR_BG);

  // Row 0 is ANY MAC, then one row per remembered Mac - all the same component
  // and the same H_ROW height, so the list has one rhythm. Selection is shown
  // by fill AND by the "ONLY"/"(selected)" text, never by colour alone.
  bool any = (allowedHost[0] == 0);
  uiListRow(CARD_X, P3_ANY_Y, CARD_W, H_ROW, "ANY MAC", any, any ? "SELECTED" : nullptr);

  if (hostCount == 0) {
    uiHint("No Mac paired yet - connect one over USB", P3_LIST_Y + H_ROW / 2);
    return;
  }

  for (int i = 0; i < hostCount; i++) {
    int y = P3_LIST_Y + i * (H_ROW + SP_1);
    bool only = allowedHost[0] && strcmp(hosts[i].id, allowedHost) == 0;
    bool live = (i == activeHost);
    // TWO MACS WITH THE SAME HOSTNAME ARE THE ORDINARY CASE, not a corner: a pair
    // of MacBook Pros both report "...-MacBook-Pro", the same collision that makes
    // macTag() render both as `pro` and the reason the Mac icons exist. Two
    // identical rows here are worse than cosmetic, because this page's controls
    // are destructive and per-row - which `x` forgets which Mac, and which one
    // ONLY pins, becomes a guess. So when a label is shared, the row carries the
    // first 4 hex of the hostId: unique by construction (a random 32-bit value)
    // and needing nothing new on the wire.
    bool dupLabel = false;
    for (int j = 0; j < hostCount && !dupLabel; j++)
      if (j != i && hosts[i].label[0] && hosts[j].label[0] &&
          strcmp(hosts[j].label, hosts[i].label) == 0) dupLabel = true;
    char idtag[8] = "";
    if (dupLabel) snprintf(idtag, sizeof(idtag), " #%.4s", hosts[i].id);

    // "* " marks the Mac currently talking, and it is ASCII for the reason this
    // codebase keeps re-learning: it used to be a MIDDLE DOT, and both fonts
    // declare 0x20..0x7E - so the one affordance distinguishing the live Mac drew
    // as NOTHING on either board. Same trap as the tag separator and fitText's
    // three-dot ellipsis. Both branches are 2 characters and both faces are
    // monospace, so the labels stay column-aligned either way.
    const char* mark = live ? "* " : "  ";
    // THE LABEL IS WHAT GETS TRIMMED, NEVER THE SUFFIX. The suffix is the only
    // thing telling two same-named Macs apart, so appending it and letting either
    // snprintf clip the tail or the row overflow would drop exactly the
    // disambiguator. Measured rather than counted, because uiListRow draws with
    // NO width bound and drawString paints an opaque box - an over-long row would
    // rub out the card border it crossed.
    setUIFont(T_BODY);   // the font uiListRow measures and draws this in
    const int lane = CARD_W - SP_3 - (P3_X_W + SP_2)
                     - tft.textWidth(mark) - tft.textWidth(idtag);
    char name[24];
    fitText(name, sizeof(name), hosts[i].label[0] ? hosts[i].label : hosts[i].id, lane);
    char row[40];
    snprintf(row, sizeof(row), "%s%s%s", mark, name, idtag);
    // reserve the "x" zone so the ONLY tag sits clear of it
    uiListRow(CARD_X, y, CARD_W, H_ROW, row, only, only ? "ONLY" : nullptr, P3_X_W + SP_2);
    // Trailing destructive affordance, inside the row's own surface.
    setUIFont(T_TITLE);
    tft.setTextColor(COLOR_BAD, only ? COLOR_ACCENT : COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("x", CARD_X + CARD_W - P3_X_W / 2, y + H_ROW / 2);
    tft.setTextDatum(TL_DATUM);
  }
}
#endif
// One dialog for every confirmable action. `emph` is the thing being acted on
// (drawn in the accent colour), `note` says what will actually happen - the
// point of the dialog is that the consequence is stated, not just re-asked.
void drawConfirm(const char* title, const char* emph, const char* note,
                 const char* yesLabel, uint16_t yesColor) {
  tft.fillRect(0, PAGE_TOP, tft.width(), contentBottom() - PAGE_TOP, COLOR_BG);
  uiCard(CARD_X, CFM_Y, CARD_W, CFM_H, yesColor);

  // EVERY STRING IS MEASURED OR WRAPPED AGAINST THIS LANE. The old dialog drew
  // each line with one centred drawString and no width at all, so a note wider
  // than the card - three of the four were, up to 228px against a 212px
  // interior - ran past both edges. Worse than spilling: drawString paints an
  // OPAQUE background box, so the overflow rubbed out the card border it
  // crossed, which is what made the text look like it was overlapping the
  // dialog rather than sitting in it.
  const int lane  = CARD_W - 2 * SP_3;
  const int laneX = CARD_X + SP_3;
  const int top   = CFM_Y + BORDER_CARD;
  const int avail = CFM_BTN_Y - top;          // room above the button row

  char emphBuf[40];
  if (emph) { setUIFont(T_BODY); fitText(emphBuf, sizeof(emphBuf), emph, lane); }
  const int noteLines = countWrappedLines(note, T_META, lane) > 1 ? 2 : 1;

  // Laid out as one block and centred in the space above the buttons, rather
  // than pinned to hand-picked offsets - so a one-line note and a two-line note
  // both sit right, instead of one of them being correct and the other tuned.
  const int blockH = uiLineH(T_HEAD)
                   + (emph ? SP_2 - 2 + uiLineH(T_BODY) : 0)
                   + SP_2 + noteLines * uiLineH(T_META);
  int cy = top + (avail - blockH) / 2;

  setUIFont(T_HEAD);                          // the question, in the title rung
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(title, tft.width() / 2, cy + uiLineH(T_HEAD) / 2);
  cy += uiLineH(T_HEAD);
  if (emph) {
    cy += SP_2 - 2;
    setUIFont(T_BODY);
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.drawString(emphBuf, tft.width() / 2, cy + uiLineH(T_BODY) / 2);
    cy += uiLineH(T_BODY);
  }
  tft.setTextDatum(TL_DATUM);
  cy += SP_2;
  drawWrappedText(note, laneX, cy, T_META, uiLineH(T_META), lane, 0, noteLines,
                  COLOR_LABEL, COLOR_CARD);

  // The SAFE option is the prominent one: CANCEL is filled, the action is only
  // outlined in its severity colour. A destructive choice should not also be the
  // easiest thing to hit. Both pass COLOR_CARD as their backdrop - they sit ON
  // the dialog, and defaulting to COLOR_BG gave their anti-aliased edges a
  // fringe of the page background against the card.
  uiButton(CFM_NO_X,  CFM_BTN_Y, CFM_BTN_W, H_BTN, "CANCEL", COLOR_ACCENT, true, COLOR_CARD);
  uiButton(CFM_YES_X, CFM_BTN_Y, CFM_BTN_W, H_BTN, yesLabel, yesColor, false, COLOR_CARD);
}
void drawPendingConfirm() {
  switch (pendingConfirm) {
    case CFM_FORGET_HOST:
      if (pendingArg < 0 || pendingArg >= hostCount) { pendingConfirm = CFM_NONE; return; }
      drawConfirm("Forget this Mac?",
                  hosts[pendingArg].label[0] ? hosts[pendingArg].label : hosts[pendingArg].id,
                  "its key is deleted; re-pairs over USB", "FORGET", COLOR_BAD);
      break;
    case CFM_RECAL:
      // THE SAME RULE AS CFM_POWER_OFF BELOW, and for the same reason: a confirm
      // dialog's entire job is stating the consequence, so it is the last place
      // that may describe behaviour this silicon does not have. On a board whose
      // touch controller lives inside the display IC, runCalibration() is a stub
      // that prints and returns - there is no 5-tap run and no previous mapping to
      // keep, so both halves of board 1's note are false here.
      //
      // THE BUTTON ITSELF IS DELIBERATELY LEFT IN PLACE. Whether this board should
      // offer CALIBRATE TOUCH at all is a real question under this repo's own
      // "never offer a control that cannot work" rule - but the mock the user
      // approved carries it, so that call is theirs. What is fixed here is only
      // the dialog telling them something untrue about it.
#if BOARD_TOUCH_NEEDS_CAL
      drawConfirm("Recalibrate touch?", nullptr,
                  "5 taps; current setup kept if it fails", "CALIBRATE", COLOR_ACCENT);
#else
      drawConfirm("Recalibrate touch?", nullptr,
                  "factory-aligned; there is nothing to do", "CALIBRATE", COLOR_ACCENT);
#endif
      break;
    case CFM_RESET_PAIRING:
      drawConfirm("Reset all pairing?", nullptr,
                  "every paired Mac is forgotten", "RESET", COLOR_WARN);
      break;
    case CFM_POWER_OFF:
      // A confirm dialog's entire job is stating the consequence, so this is the
      // last place that may describe a wake this silicon cannot perform.
#if BOARD_HAS_TOUCH_SLEEP_WAKE
      drawConfirm("Power off?", nullptr,
                  "deep sleep - touch the screen to wake", "POWER OFF", COLOR_BAD);
#else
      drawConfirm("Power off?", nullptr,
                  "deep sleep - press RESET to wake", "POWER OFF", COLOR_BAD);
#endif
      break;
    default: break;
  }
}
// ----- Dispatch -----
void drawSettingsStatic() {
  pendingConfirm = CFM_NONE;   // a page redraw always dismisses a stale dialog
  // This repaints the chrome the dynamic fields are drawn ON, so their
  // change-only caches are stale by definition - reset here rather than at each
  // call site, because a caller that forgot left the values BLANK (they hadn't
  // "changed", so drawIfChanged skipped them). That was the empty page after
  // CANCEL, and the occasional missing text elsewhere.
  resetSettingsCaches();
  // Clear the page BODY too. Only the hosts page used to clear its own area;
  // STATUS/CONTROLS/ACTIONS painted their cards on top of whatever was already
  // there, so after a confirm dialog its card survived in every gap between
  // them (three visible bands on the ACTIONS page). Callers that already clear
  // just do it twice - harmless - and no caller can forget any more.
#if BOARD_SETTINGS_HOME
  // FROM CONTENT_Y, not PAGE_TOP: HOME occupies the band's own rows, so a clear
  // that started at PAGE_TOP would leave the group you came from wearing its back
  // band. Every entry path (openSettingsGroup, settingsBack, drawSettingsTab,
  // forceFullRepaint) comes through here, so this is the one clear and the two
  // navigation helpers deliberately do not repeat it.
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  if (settingsPage == SET_HOME) { drawSettingsHomeStatic(); return; }
  drawBackBand(settingsGroupTitle(settingsPage));
  if      (settingsPage == SET_STATUS)  drawStatusPageStatic();
  else if (settingsPage == SET_DISPLAY) drawDisplayPageStatic();
  else if (settingsPage == SET_SOUND)   drawSoundPageStatic();
  else if (settingsPage == SET_PAIRING) drawHostsPageStatic();
  else                                  drawActionsPageStatic();
#else
  tft.fillRect(0, PAGE_TOP, tft.width(), contentBottom() - PAGE_TOP, COLOR_BG);
  drawPager();
  if (settingsPage == 0) drawStatusPageStatic();
  else if (settingsPage == 1) drawControlsPageStatic();
  else if (settingsPage == 2) drawActionsPageStatic();
  else drawHostsPageStatic();
#endif
}
void renderSettingsTab() {
#if BOARD_HAS_WIRELESS_PAIR
  // The pairing panel owns everything above the footer, so this periodic repaint
  // must not run - the same absorb the confirm dialog gets one line down, and the
  // one the reader and the history pager get in handleLine(). The panel's own
  // countdown is driven by tickPairPanel() from loop() rather than from here: this
  // call is gated on everReceived, and a device that has never had a payload is
  // exactly the fresh, unpaired one most likely to be sitting on this screen.
  if (pairPanelActive) return;
#endif
  if (pendingConfirm != CFM_NONE) return;  // a modal owns the page area
#if BOARD_SETTINGS_HOME
  if      (settingsPage == SET_HOME)    renderSettingsHome();
  else if (settingsPage == SET_STATUS)  renderStatusPage();
  else if (settingsPage == SET_DISPLAY) renderDisplayPage();
  else if (settingsPage == SET_SOUND)   renderSoundPage();
  // Pairing's rows carry a LIVE state line now ("connected, 3s ago"), so the page
  // is no longer static: left on the static side it would freeze at whatever age
  // was true when it was last painted, which is worse than no age at all.
  else if (settingsPage == SET_PAIRING) renderHostsPage();
  // Actions is static
#else
  if (settingsPage == 0) renderStatusPage();
  else if (settingsPage == 1) renderControlsPage();
  // page 2 is static
#endif
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
void resetSettingsCaches() {
#if !BOARD_SETTINGS_HOME
  // BOARD 1's DEVICE card only - its two connection dots and its one-line battery
  // reading. Board 2's STATUS group has neither, so declaring and resetting them
  // there was state nothing can ever read; same treatment macRowCache below has.
  // The line is left WHOLE rather than split around the one cache both boards keep,
  // so board 1's resolved view of this file is character-identical to what it was.
  btDotCache = -1; usbDotCache = -1; battRowCache = -1; battRowTextCache[0] = '\0';
#else
  battRowTextCache[0] = '\0';
#endif
  soundBtnCache = -1; flipBtnCache = -1; themeBtnCache = -1; brightBarCache = -1;
  battRowColorCache = 0;
#if BOARD_SETTINGS_HOME
  // The SoC temp row's pair. Resetting these HERE rather than at the call sites is
  // what makes the invariant impossible to forget: drawStatusPageStatic() repaints
  // the chrome these are drawn on, so they are stale by definition afterwards, and
  // a caller that forgot left the row BLANK - the value had not "changed", so
  // drawIfChanged skipped a field whose pixels had just been erased.
  tempRowTextCache[0] = '\0';
  tempRowColorCache = 0;
#endif
  brightPctCache[0] = '\0'; sleepValCache[0] = '\0'; volValCache[0] = '\0';
  for (int i = 0; i < 6; i++) stepGlyphCache[i] = -1;
#if !BOARD_SETTINGS_HOME
  // Without this a page repaint (e.g. PAGE away and back) leaves both Mac
  // rows BLANK - drawSettingsStatic() clears the chrome they're drawn on but
  // drawIfChanged sees an unchanged cached string and skips redrawing it.
  for (int i = 0; i < MAX_LINKS; i++) macRowCache[i][0] = '\0';
#endif
#if BOARD_SETTINGS_HOME
  // Same rule for the STATUS group's three cards and the Pairing group's live
  // rows: the static half repaints the surface all of these are drawn ON, so
  // leaving a cache set leaves that field BLANK - the value has not "changed", so
  // drawIfChanged skips a field whose pixels were just erased.
  stVerdictCache[0] = '\0'; stVerdictColorCache = 0;
  stLinksCache[0] = '\0'; stIdCache[0] = '\0'; stLeftCache[0] = '\0';
  stPayloadCache[0] = '\0'; stFlushCache[0] = '\0';
  stUptimeCache[0] = '\0'; stMacsCache[0] = '\0';
  for (int i = 0; i < MAX_HOSTS; i++) { p3SubCache[i][0] = '\0'; p3LiveCache[i] = -1; }
  // The row COUNT joins them: this runs from drawSettingsStatic() before the page
  // chrome is repainted, so "how many rows are drawn" is stale here in exactly the
  // way the two caches above are. drawHostsPageStatic() records the real count on
  // the way past.
  p3CountCache = -1;
#if BOARD_HAS_WIRELESS_PAIR
  // The pairing panel's two, for the same reason - drawPairPanelStatic() drops the
  // countdown's cache itself as well, since it is also reached from openPairPanel()
  // where there is no drawSettingsStatic() upstream to have run this.
  pairLeftCache[0] = '\0';
  pairPanelSig[0] = '\0';
#endif
  // HOME's five summaries, and the Status row's colour beside them. Same rule as
  // every cache above: drawSettingsHomeStatic() repaints the cards these are drawn
  // ON, so leaving them set leaves all five rows BLANK.
  for (int i = 0; i < SET_GROUP_COUNT; i++) homeSubCache[i][0] = '\0';
  homeStatusColorCache = 0;
#endif
}
#if BOARD_SETTINGS_HOME
// HOME -> a group, and back. Both go through drawSettingsStatic(), which clears
// from CONTENT_Y and resets every cache itself, so neither calls
// resetSettingsCaches() here - that used to be duplicated at both call sites,
// harmlessly (drawSettingsStatic() would just reset an already-reset cache),
// but a caller that repeats work drawSettingsStatic() already does on its own
// invites a reader to trust the comment over the code.
void openSettingsGroup(int g) {
  settingsPage = constrain(g, SET_STATUS, SET_ACTIONS);
  drawSettingsStatic();
  renderSettingsTab();
}
void settingsBack() {
  settingsPage = SET_HOME;
  drawSettingsStatic();
  renderSettingsTab();
}
#else
void gotoSettingsPage(int p) {
  settingsPage = (p + SETTINGS_PAGES) % SETTINGS_PAGES;
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}
#endif
// Left/right third of a stepper card counts as -/+ (resistive touch is
// imprecise; nothing else on the card to mis-trigger).
bool stepperHit(int sx, int sy, int cardY, int* dir) {
  if (sy < cardY || sy >= cardY + STEPPER_CARD_H) return false;
  if (sx < CARD_X + CARD_W / 3) { *dir = -1; return true; }
  if (sx >= CARD_X + CARD_W * 2 / 3) { *dir = +1; return true; }
  return false;
}
void handleSettingsTouch(int sx, int sy) {
  // Modal: while a confirm is up nothing else (including the pager) is live, so
  // a stray tap can't page away and leave it half-dismissed.
  if (pendingConfirm != CFM_NONE) {
    if (sy >= CFM_BTN_Y && sy < CFM_BTN_Y + H_BTN) {
      bool yes = (sx >= CFM_YES_X && sx < CFM_YES_X + CFM_BTN_W);
      bool no  = (sx >= CFM_NO_X  && sx < CFM_NO_X  + CFM_BTN_W);
      if (!yes && !no) return;                       // the gap between them: ignore
      ConfirmAction act = pendingConfirm;
      pendingConfirm = CFM_NONE;
      if (!yes) { drawSettingsStatic(); renderSettingsTab(); return; }
      switch (act) {
        case CFM_FORGET_HOST:
          Serial.printf("PAIRING: forgot %s (confirmed)\n", hosts[pendingArg].id);
          forgetHost(pendingArg);
          drawHostsPageStatic();
          return;
        case CFM_RECAL:
          runCalibration();
          applyScreenRotation();   // calibration runs unflipped - restore the choice
          everReceived = false;
          tft.fillScreen(COLOR_BG);
          drawTabBar();
          drawFooterChrome();
          resetSettingsCaches();
          drawSettingsStatic();
          renderSettingsTab();
          return;
        case CFM_RESET_PAIRING: resetPairing(); return;
        case CFM_POWER_OFF:     powerOff();     return;
        default: break;
      }
    }
    return;
  }

#if BOARD_SETTINGS_HOME
  // HOME first: its rows own the whole content area, band rows included, so this
  // has to run BEFORE the band branch below or the top row would read as a back tap.
  if (settingsPage == SET_HOME) {
    for (int i = 0; i < SET_GROUP_COUNT; i++) {
      int y = settingsHomeRowY(i);
      if (sy >= y && sy < y + HOME_ROW_H) { openSettingsGroup(SET_STATUS + i); return; }
    }
    return;   // the gaps between rows are inert, not a guess at the nearest row
  }
  // The WHOLE band is the back target. Unlike the pager there is nothing else in
  // it, so there is no split to make and no dead zone to leave.
  if (sy < PAGE_TOP) { settingsBack(); return; }
#else
  // Pager band. The hit zones are deliberately much wider than the drawn keys
  // (left/right 45% each, with a 10% dead band around the title) so a tap that
  // lands near a key still counts - on a resistive panel, aiming at a 52px key
  // with a fingertip is optimistic.
  if (sy < PAGE_TOP) {
    if (sx < tft.width() * 45 / 100) gotoSettingsPage(settingsPage - 1);
    else if (sx > tft.width() * 55 / 100) gotoSettingsPage(settingsPage + 1);
    return;
  }
#endif
#if BOARD_SETTINGS_HOME
  if (settingsPage == SET_DISPLAY) {
    int dir;
    if (stepperHit(sx, sy, P1_BRIGHT_Y, &dir)) {
      setBacklight(brightnessPct + dir * BRIGHTNESS_STEP);
      saveBrightness();
      renderDisplayPage();
    } else if (stepperHit(sx, sy, P1_SLEEP_Y, &dir)) {
      int idx = constrain(sleepPresetIdx + dir, 0, SLEEP_PRESETS_COUNT - 1);
      if (idx != sleepPresetIdx) { sleepPresetIdx = idx; applySleepPreset(); saveSleepTimeout(); renderDisplayPage(); }
    } else if (sy >= P1_THEME_Y && sy < P1_THEME_Y + H_ROW && sx >= CARD_X) {
      // The 4px gap between two segments belongs to the one on its LEFT, the same
      // pitch rule the keyboard uses - so there is no dead lane between them.
      int seg = (sx - CARD_X) / (P1_THEME_SEG_W + P1_THEME_GAP);
      if (seg >= 0 && seg < THEME_MODE_COUNT && seg != themeMode) {
        themeMode = seg;
        prefs.putUChar("theme", themeMode);
        applyTheme(themeIndexForMode(themeMode));
        // Mandatory, not cosmetic: every change-only cache in this sketch keys on
        // content, so without a full repaint the screen keeps the old palette until
        // something else happens to change a value.
        forceFullRepaint();
      }
    } else if (sy >= P1_FLIP_Y && sy < P1_FLIP_Y + H_ROW) {
      // Flip 180 so the USB-C port can face the other way while charging.
      screenFlipped = !screenFlipped;
      saveScreenFlip();
      applyScreenRotation();
      // Everything on screen was drawn for the old orientation, so repaint the
      // whole frame - and drop every cache first, or the change-only redraw
      // discipline would skip fields whose text happens to be unchanged.
      everReceived = false;
      tft.fillScreen(COLOR_BG);
      drawTabBar();
      drawFooterChrome();   // also clears the footer caches
      resetSettingsCaches();
      resetUsageCaches();   // the other tabs repaint via switchTab()
      drawSettingsStatic();
      renderSettingsTab();
    }
  } else if (settingsPage == SET_SOUND) {
    int dir;
    if (sy >= PS_SOUND_Y && sy < PS_SOUND_Y + H_ROW) {
      beepEnabled = !beepEnabled;
      saveBeepEnabled();
      if (beepEnabled) startBeep(); // confirmation doubles as a speaker test
      renderSoundPage();
    } else if (stepperHit(sx, sy, PS_VOL_Y, &dir)) {
      int idx = constrain(volPresetIdx + dir, 0, VOL_PRESETS_COUNT - 1);
      if (idx != volPresetIdx) {
        volPresetIdx = idx; applyVolume(); saveVolume(); renderSoundPage();
        if (beepEnabled) startBeep(); // test the new level
      }
    } else if (sy >= PS_BEEP_Y && sy < PS_BEEP_Y + PS_BTN_H) {
      // UNCONDITIONAL, and deliberately not gated on beepEnabled: it is a TEST, so
      // it has to sound with SOUND off - the same reasoning that keeps MIC_CUE_DUTY
      // independent of the SOUND setting. A test button that silently does nothing
      // is indistinguishable from a dead speaker, which is the fault it exists to
      // rule out.
      startBeep();
    } else if (sy >= PS_MIC_Y && sy < PS_MIC_Y + PS_BTN_H) {
      // MIC TEST runs straight away - NO confirm dialog. The meter changes nothing
      // and exits on a tap; the dialog is reserved for consequential actions, and
      // putting one here would just be a tap in the way of the thing you are doing
      // repeatedly while turning the trimmer.
      micMonitor();
      // micRestoreUi() falls back to the "waiting for host" screen when no payload
      // has ever arrived - which is exactly the standalone case you would be running
      // a mic test in, so put SETTINGS back explicitly.
      if (!everReceived) forceFullRepaint();
    }
  } else if (settingsPage == SET_ACTIONS) {
    // NO MIC TEST BRANCH: the button is drawn on the SOUND group now, and this
    // page reserves no slot for it. A `sy >= P2_MIC_Y` test left behind here would
    // not merely be dead - P2_MIC_Y does not exist on this board at all, and had
    // it survived as a stale constant it would claim taps belonging to whatever
    // now sits in that band. Removing the constant and the branch in one change is
    // what makes the two unable to disagree.
    //
    // All three ask first: recalibrating costs 5 taps, resetting pairing wipes
    // every key, and powering off interrupts the display. The gap between
    // CALIBRATE and the destructive pair is inert rather than claimed by either -
    // the same rule HOME's gaps and the Pairing cards follow, and it matters most
    // here because the two rows below it destroy state.
    if (sy >= P2_CAL_Y && sy < P2_CAL_Y + P2_BTN_H) {
      pendingConfirm = CFM_RECAL;         drawPendingConfirm();
    } else if (sy >= P2_PAIR_Y && sy < P2_PAIR_Y + P2_BTN_H) {
      pendingConfirm = CFM_RESET_PAIRING; drawPendingConfirm();
    } else if (sy >= P2_PWR_Y && sy < P2_PWR_Y + P2_BTN_H) {
      pendingConfirm = CFM_POWER_OFF;     drawPendingConfirm();
    }
  } else if (settingsPage == SET_PAIRING) {
    // ANY row: drop the restriction so every remembered Mac may answer
    if (sy >= P3_ANY_Y && sy < P3_ANY_Y + H_ROW) {
      if (allowedHost[0]) { allowedHost[0] = 0; saveAllowedHost(); drawHostsPageStatic(); }
      return;
    }
    // The rows are cards at P3_ROW_STEP now, and the 8px between two of them is
    // inert rather than being claimed by either - the same rule HOME's gaps follow,
    // and it matters more here because the row it would guess at owns a destructive
    // control.
#if BOARD_HAS_WIRELESS_PAIR
    // The free slot, hit-tested from the SAME expression that draws it and under the
    // same hostCount < MAX_HOSTS condition - at MAX_HOSTS there is no button and no
    // band claiming taps, which is the whole "absence encodes full" argument.
    if (hostCount < MAX_HOSTS &&
        sy >= p3RowY(hostCount) && sy < p3RowY(hostCount) + H_ROW) {
      openPairPanel();
      return;
    }
#endif
    for (int i = 0; i < hostCount; i++) {
      int y = p3RowY(i);
      if (sy < y || sy >= y + P3_ROW_H) continue;
      if (sx >= CARD_X + CARD_W - P3_X_W) {
        pendingConfirm = CFM_FORGET_HOST; // the x zone: ask before destroying the key
        pendingArg = i;
        drawPendingConfirm();
        return;
      } else if (allowedHost[0] && strcmp(hosts[i].id, allowedHost) == 0) {
        allowedHost[0] = 0; saveAllowedHost();          // tap again = back to ANY
      } else {
        strlcpy(allowedHost, hosts[i].id, sizeof(allowedHost));
        saveAllowedHost();                              // only this Mac may answer
      }
      drawHostsPageStatic();
      return;
    }
  }
#else
  if (settingsPage == 1) {
    int dir;
    if (stepperHit(sx, sy, P1_BRIGHT_Y, &dir)) {
      setBacklight(brightnessPct + dir * BRIGHTNESS_STEP);
      saveBrightness();
      renderControlsPage();
    } else if (stepperHit(sx, sy, P1_SLEEP_Y, &dir)) {
      int idx = constrain(sleepPresetIdx + dir, 0, SLEEP_PRESETS_COUNT - 1);
      if (idx != sleepPresetIdx) { sleepPresetIdx = idx; applySleepPreset(); saveSleepTimeout(); renderControlsPage(); }
    } else if (stepperHit(sx, sy, P1_VOL_Y, &dir)) {
      int idx = constrain(volPresetIdx + dir, 0, VOL_PRESETS_COUNT - 1);
      if (idx != volPresetIdx) {
        volPresetIdx = idx; applyVolume(); saveVolume(); renderControlsPage();
        if (beepEnabled) startBeep(); // test the new level
      }
    } else if (sy >= P1_SOUND_Y && sy < P1_SOUND_Y + P1_SOUND_H && sx < P1_FLIP_X) {
      beepEnabled = !beepEnabled;
      saveBeepEnabled();
      if (beepEnabled) startBeep(); // confirmation doubles as a speaker test
      renderControlsPage();
    } else if (sy >= P1_SOUND_Y && sy < P1_SOUND_Y + P1_SOUND_H && sx < P1_THEME_X) {
      // Flip 180 so the USB-C port can face the other way while charging.
      screenFlipped = !screenFlipped;
      saveScreenFlip();
      applyScreenRotation();
      // Everything on screen was drawn for the old orientation, so repaint the
      // whole frame - and drop every cache first, or the change-only redraw
      // discipline would skip fields whose text happens to be unchanged.
      everReceived = false;
      tft.fillScreen(COLOR_BG);
      drawTabBar();
      drawFooterChrome();   // also clears the footer caches
      resetSettingsCaches();
      resetUsageCaches();   // the other tabs repaint via switchTab()
      drawSettingsStatic();
      renderSettingsTab();
    } else if (sy >= P1_SOUND_Y && sy < P1_SOUND_Y + P1_SOUND_H && sx >= P1_THEME_X) {
      themeMode = (themeMode + 1) % THEME_MODE_COUNT;
      prefs.putUChar("theme", themeMode);
      applyTheme(themeIndexForMode(themeMode));
      // Mandatory, not cosmetic: every change-only cache in this sketch keys on content,
      // so without a full repaint the screen keeps the old palette until something else
      // happens to change a value.
      forceFullRepaint();
    }
  } else if (settingsPage == 2) {
    // MIC TEST runs straight away - NO confirm dialog. The meter changes nothing
    // and exits on a tap; the dialog is reserved for consequential actions, and
    // putting one here would just be a tap in the way of the thing you are doing
    // repeatedly while turning the trimmer.
#if BOARD_HAS_MIC
    if (sy >= P2_MIC_Y && sy < P2_MIC_Y + P2_BTN_H) {
      micMonitor();
      // micRestoreUi() falls back to the "waiting for host" screen when no payload
      // has ever arrived - which is exactly the standalone case you'd be running a
      // mic test in, so put SETTINGS back explicitly. Skipped otherwise, because
      // micMonitor already repainted and a second full repaint would flash.
      if (!everReceived) forceFullRepaint();
    }
    // The other three ask first: recalibrating costs 5 taps, resetting pairing
    // wipes every key, and powering off interrupts the display.
    else if (sy >= P2_CAL_Y && sy < P2_CAL_Y + P2_BTN_H) {
#else
    // No MIC TEST branch at all on this board, so the chain opens on CALIBRATE.
    // The button is not drawn and P2_CAL_Y has moved up into the slot it would
    // have used, so a `sy >= P2_MIC_Y` test here would claim taps belonging to
    // whatever now sits there.
    if (sy >= P2_CAL_Y && sy < P2_CAL_Y + P2_BTN_H) {
#endif
      pendingConfirm = CFM_RECAL;         drawPendingConfirm();
    } else if (sy >= P2_PAIR_Y && sy < P2_PAIR_Y + P2_BTN_H) {
      pendingConfirm = CFM_RESET_PAIRING; drawPendingConfirm();
    } else if (sy >= P2_PWR_Y && sy < P2_PWR_Y + P2_BTN_H) {
      pendingConfirm = CFM_POWER_OFF;     drawPendingConfirm();
    }
  } else if (settingsPage == 3) {
    // ANY row: drop the restriction so every remembered Mac may answer
    if (sy >= P3_ANY_Y && sy < P3_ANY_Y + H_ROW) {
      if (allowedHost[0]) { allowedHost[0] = 0; saveAllowedHost(); drawHostsPageStatic(); }
      return;
    }
    for (int i = 0; i < hostCount; i++) {
      int y = P3_LIST_Y + i * (H_ROW + SP_1);
      if (sy < y || sy >= y + H_ROW) continue;
      if (sx >= CARD_X + CARD_W - P3_X_W) {
        pendingConfirm = CFM_FORGET_HOST; // the x zone: ask before destroying the key
        pendingArg = i;
        drawPendingConfirm();
        return;
      } else if (allowedHost[0] && strcmp(hosts[i].id, allowedHost) == 0) {
        allowedHost[0] = 0; saveAllowedHost();          // tap again = back to ANY
      } else {
        strlcpy(allowedHost, hosts[i].id, sizeof(allowedHost));
        saveAllowedHost();                              // only this Mac may answer
      }
      drawHostsPageStatic();
      return;
    }
  }
#endif
  // Anything not claimed above is inert. That is BOTH boards' STATUS surface -
  // board 1's page 0 and board 2's Status group are read-only, and neither has a
  // control on it - so this is not the board-1-only statement it used to be.
}
void drawSettingsTab() {
#if BOARD_SETTINGS_HOME
  settingsPage = SET_HOME;   // always enter at HOME, never a group you last left
#else
  settingsPage = 0; // always enter on the STATUS page
#endif
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}
