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
// ----- Page 0: STATUS -----
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
  tft.fillRect(xRight - 100, y, 100, 16, COLOR_CARD);
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
    char left[8] = "";
    if (bst == BATT_DISCHARGING) battLeftLabel(left, sizeof(left), battMinutesLeft());
    snprintf(buf, sizeof(buf), "%d%% %d.%02dV%s%s", pct, batteryMv / 1000,
             (batteryMv % 1000) / 10, left[0] ? " " : "", left);
  }
  // 15 = "100% 4.20V ~99h", the widest this can be, and the only number here that
  // is not per-board: it is the width of the DATA. In Cozette 6x13 it is 90px,
  // right-aligned to CARD_X + CARD_W - PAD, against a "Battery" label ending at
  // CARD_X + PAD + 20 + textWidth("Battery") - which leaves 36px of clearance on
  // board 1 and 108 on board 2. Widening the format past 15 eats board 1's 36
  // first; settings-geom-check.mjs asserts both.
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
  drawIfChanged(battRowTextCache, sizeof(battRowTextCache), buf, CARD_X + CARD_W - PAD,
                DEV_CARD_Y + DROW_BATT + 4, 1, 1, rowCol, COLOR_CARD, TR_DATUM);
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
    // The erase box always reserves the icon's slot (4px gap + 13px) whether or
    // not this row currently has one: an icon that disappears must not leave a
    // ghost, and one that appears must not draw over stale pixels left behind
    // by the plain-text layout.
    int eraseW = tft.textWidth(buf2) + 4 + MAC_EMOJI_SIZE + 2;
    tft.fillRect(textX - 1, y - 1, eraseW, th + 2, COLOR_CARD);
    if (rowEmoji >= 0) {
      // "Mac", then the icon 4px later, then the rest of the row shifted right
      // by the icon's slot - the same 4px gap, and the same y as the text
      // (both are 13px, so no centring arithmetic is needed), that every other
      // icon-beside-text surface in this sketch uses.
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
// ----- Page 1: CONTROLS -----
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
  // A full-width row for each wouldn't fit (only 32px left under this one), and
  // all three are booleans so they read naturally side by side. State is shown by
  // fill AND by the label text, never colour alone.
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
  // Brief confirmation, then rebuild the settings tab (STATUS now reads
  // "unpaired"). delay() is fine here - matches the calibrate/power-off flows.
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("Pairing reset", tft.width() / 2, tft.height() / 2 - 14);
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString("plug into a Mac over USB to re-pair", tft.width() / 2, tft.height() / 2 + 12);
  tft.setTextDatum(TL_DATUM);
  delay(1600);
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}
// ----- Page 2: ACTIONS -----
void drawActionsPageStatic() {
  // Four buttons, one component, escalating intent: accent = safe,
  // warn = changes pairing, bad = powers the device down. MIC TEST leads because
  // it is the only one you might run repeatedly (it is how you set the trimmer).
  uiButton(CARD_X, P2_MIC_Y,  CARD_W, P2_BTN_H, "MIC TEST",        COLOR_ACCENT);
  uiButton(CARD_X, P2_CAL_Y,  CARD_W, P2_BTN_H, "CALIBRATE TOUCH", COLOR_ACCENT);
  uiButton(CARD_X, P2_PAIR_Y, CARD_W, P2_BTN_H, "RESET PAIRING",   COLOR_WARN);
  uiButton(CARD_X, P2_PWR_Y,  CARD_W, P2_BTN_H, "POWER OFF",       COLOR_BAD);
  uiHint("power off = deep sleep, touch to wake", P2_PWR_Y + P2_BTN_H + SP_3);
}
// ----- Page 3: paired Macs -----
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
    char row[40];
    snprintf(row, sizeof(row), "%s%s", live ? "\xB7 " : "  ",
             hosts[i].label[0] ? hosts[i].label : hosts[i].id);
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
      drawConfirm("Recalibrate touch?", nullptr,
                  "5 taps; current setup kept if it fails", "CALIBRATE", COLOR_ACCENT);
      break;
    case CFM_RESET_PAIRING:
      drawConfirm("Reset all pairing?", nullptr,
                  "every paired Mac is forgotten", "RESET", COLOR_WARN);
      break;
    case CFM_POWER_OFF:
      drawConfirm("Power off?", nullptr,
                  "deep sleep - touch the screen to wake", "POWER OFF", COLOR_BAD);
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
  tft.fillRect(0, PAGE_TOP, tft.width(), contentBottom() - PAGE_TOP, COLOR_BG);
  drawPager();
  if (settingsPage == 0) drawStatusPageStatic();
  else if (settingsPage == 1) drawControlsPageStatic();
  else if (settingsPage == 2) drawActionsPageStatic();
  else drawHostsPageStatic();
}
void renderSettingsTab() {
  if (pendingConfirm != CFM_NONE) return;  // a modal owns the page area
  if (settingsPage == 0) renderStatusPage();
  else if (settingsPage == 1) renderControlsPage();
  // page 2 is static
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
void resetSettingsCaches() {
  btDotCache = -1; usbDotCache = -1; battRowCache = -1; battRowTextCache[0] = '\0';
  soundBtnCache = -1; flipBtnCache = -1; themeBtnCache = -1; brightBarCache = -1;
  battRowColorCache = 0;
  brightPctCache[0] = '\0'; sleepValCache[0] = '\0'; volValCache[0] = '\0';
  for (int i = 0; i < 6; i++) stepGlyphCache[i] = -1;
  // Without this a page repaint (e.g. PAGE away and back) leaves both Mac
  // rows BLANK - drawSettingsStatic() clears the chrome they're drawn on but
  // drawIfChanged sees an unchanged cached string and skips redrawing it.
  for (int i = 0; i < MAX_LINKS; i++) macRowCache[i][0] = '\0';
}
void gotoSettingsPage(int p) {
  settingsPage = (p + SETTINGS_PAGES) % SETTINGS_PAGES;
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}
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

  // Pager band. The hit zones are deliberately much wider than the drawn keys
  // (left/right 45% each, with a 10% dead band around the title) so a tap that
  // lands near a key still counts - on a resistive panel, aiming at a 52px key
  // with a fingertip is optimistic.
  if (sy < PAGE_TOP) {
    if (sx < tft.width() * 45 / 100) gotoSettingsPage(settingsPage - 1);
    else if (sx > tft.width() * 55 / 100) gotoSettingsPage(settingsPage + 1);
    return;
  }
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
  // page 0 is read-only
}
void drawSettingsTab() {
  settingsPage = 0; // always enter on the STATUS page
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}
