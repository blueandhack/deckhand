// Settings tab: its HOME menu and six group pages, the back band, the stepper cards
// and the confirm dialog. ONE implementation for both boards, differing only in the
// constants each board's own header declares. (It said "its four pages ... pager";
// that was this tab before the SETTINGS redesign. The chevron pager went in Task 3B
// and drawPager() itself in Task 4, with the two flags that gated it - see the note
// beside the remaining settings flag in both headers.)
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
// A GROUP CAPTION: T_META in COLOR_LABEL at CARD_X + PAD, TL_DATUM, on the page
// background rather than on a card - the treatment board_es3c35p.h describes once
// for every one of them, and the step from its datum to the control it heads is
// SET_CAP_STEP. NINE live sites go through here, and only TWO of them are
// unconditional - which is why no single sentence in shared code can list them:
//
//   both boards    Danger's CANNOT BE UNDONE, Messages' HOW MY MESSAGES LAND
//   board 2 only   Display's THEME, Sound's ALERTS and MICROPHONE, Pairing's
//                  ANSWER PROMPTS FROM and PAIRED MACS - all five on
//                  BOARD_SETTINGS_FITS_CAPTIONS - plus Device's DIAGNOSTICS on
//                  BOARD_DEVICE_DIAGNOSTICS
//   board 1 only   Device's SETUP, over CALIBRATE TOUCH, on BOARD_TOUCH_NEEDS_CAL
//
// So board 2 compiles eight of the nine and board 1 compiles three.
//
// CORRECTED, 2026-09-12 (whole-branch final review, IMPORTANT 3). The sentence that
// stood here read "All seven live sites go through here (Display's THEME, Sound's
// ALERTS and MICROPHONE, Pairing's ANSWER PROMPTS FROM and PAIRED MACS, Actions'
// SETUP and CANNOT BE UNDONE)". Kept marked rather than deleted, per this repo's
// rule about descriptions that turned out to be wrong. It was wrong three ways at
// once: it UNDERCOUNTED by two (DIAGNOSTICS and HOW MY MESSAGES LAND were never in
// the list); it named `Actions`, a group commit b5ecd6b deleted and renamed to
// Danger eleven commits before this branch's tip; and it put SETUP in that group
// when RULING 12 had put it on board 1's DEVICE page, board-1-only, which an
// unconditional sentence cannot say. It is written down because it is this branch's
// OWN signature class - ten stale-prose instances found and corrected across six
// tasks, and a write-up of the class in commands-and-checks.md - left live in the
// first fifty lines of the most-read file in the tree.
//
// Six of the seven sites that existed when this was extracted were four inline
// lines each, and four identical lines repeated that many times is how one page
// comes to draw its caption in a different colour or off a different datum with
// nothing saying which is right. It is named for what it DRAWS rather than for the
// page that first needed it - this was drawActionCaption(), on the group that
// happened to add it last.
//
// MOVED OUT OF THE BOARD-2 ARM, unchanged, because board 1's MESSAGES page needs
// the same caption and the alternative was a second copy of four lines under the
// other #if. One caption treatment across both boards is the point of the
// function; having it exist on only one of them was an accident of where the
// groups happened to be invented.
void drawGroupCaption(const char* text, int y) {
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(text, CARD_X + PAD, y);
}
// ----- The back band, and HOME (BOTH BOARDS) -----
// THE HEADING SAID "(board 2)" AND WAS TRUE FOR ONE TASK. Everything under it - the
// band, HOME's cards, the six summaries and their caches - is compiled by both
// boards since Task 3B, at each board's own geometry out of its own header, and
// since Task 4 there is no arm and no flag left to say so.
// The pager band became a BACK band of exactly the same height, which is the
// whole reason every group body below needs no new arithmetic: PAGE_TOP is
// CONTENT_Y + PAGER_H + 4 on both boards (80 on board 1, 104 on board 2) and it is
// unchanged on both. There is only one key in it, so unlike the chevron pager that
// stood here there is no 45/55 split to make - the WHOLE band is the back target
// (handleSettingsTouch), which is also what lets board 1's 34px drawn key stand: it
// is an affordance inside a 46px target, not one of two keys you have to hit.
void drawBackBand(const char* title) {
  int by = CONTENT_Y + 4, bh = PAGER_H - 8;
  uiFillRound(PAGER_BTN_X0, by, BACK_BTN_W, bh, RADIUS, COLOR_CARD, COLOR_BG);
  uiStrokeRound(PAGER_BTN_X0, by, BACK_BTN_W, bh, RADIUS, BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
  // T_HEAD, like the stepper keys' -/+ glyphs and for the same reason: a body-face
  // glyph on a key this size is a speck. BOTH BOARDS' NUMBERS, because the sentence
  // that stood here carried only board 2's ("a 16px glyph on a 46px key"): the key is
  // 52x34 here and 60x46 there, and the body face is 13px here and 16px there.
  setUIFont(T_HEAD);
  tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("<", PAGER_BTN_X0 + BACK_BTN_W / 2, by + bh / 2);
  tft.setTextColor(COLOR_VALUE, COLOR_BG);
  tft.setTextDatum(ML_DATUM);
  tft.drawString(title, PAGER_BTN_X0 + BACK_BTN_W + BACK_TITLE_DX, CONTENT_Y + PAGER_H / 2);
  tft.setTextDatum(TL_DATUM);
}
// ONE table, TWO LIVE USES ON BOTH BOARDS: the back band's title and HOME's row
// name. They must be the same word or the screen you tapped into is not the one you
// tapped on, and that now has to hold across two boards as well as across two
// surfaces. IT SAID "THREE USES" and named board 1's pager title first; the pager
// stopped being compiled in Task 3B and Task 4 deleted it, so two is the count.
// THE ONE TABLE IS THE POINT AND IT OUTLIVED THE THIRD CALLER: board 1's pager
// carried its own `titles[]` of five UPPERCASE strings until Task 3A, which was a
// second record of the group set and a second thing to forget when one is renamed.
// It was made to draw this instead, so a rename reached every surface that names a
// group. settings-geom-check.mjs parses this function for the names every lane on
// every surface is measured against.
const char* settingsGroupTitle(int g) {
  switch (g) {
    case SET_DEVICE:  return "Device";
    case SET_DISPLAY: return "Display";
    case SET_SOUND:   return "Sound";
    case SET_PAIRING: return "Pairing";
    case SET_MESSAGES: return "Messages";
    // "Danger", not "Actions": the group holds exactly the two controls that
    // destroy state now, and a name that says what a page is for is the one thing
    // standing between a finger and RESET PAIRING. Reached through the DEFAULT arm
    // rather than a case of its own, which is deliberate - an id that drifts out of
    // the SET_DEVICE..SET_DANGER run lands here rather than erroring, so the word
    // this returns is also the word a drifted row would wear. settings-geom-check
    // asserts the run is contiguous for exactly that reason.
    default:          return "Danger";
  }
}
int settingsHomeRowY(int i) { return HOME_Y0 + i * (HOME_ROW_H + HOME_GAP); }
// HOME owns the whole content area - no band above it, because the tab bar already
// says SETTINGS and a second title would be chrome repeating itself. The six cards,
// their names and the chevrons are static; the summaries are live and go through
// renderSettingsHome().
void drawSettingsHomeStatic() {
  for (int i = 0; i < SET_GROUP_COUNT; i++) {
    int y = settingsHomeRowY(i);
    uiCard(CARD_X, y, CARD_W, HOME_ROW_H);
    setUIFont(T_HEAD);
    tft.setTextColor(COLOR_VALUE, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(settingsGroupTitle(SET_DEVICE + i), CARD_X + PAD, y + HOME_NAME_DY);
    // A plain ASCII ">", because EVERY face on this device declares 0x20..0x7E and
    // nothing else - Spleen on board 2, Terminus and Cozette on board 1 - so a real
    // chevron glyph draws as nothing at all AND advances nothing. The trap this repo
    // has now paid for at least six times; the sentence here named only Spleen, which
    // stopped being the whole story when board 1 began drawing this row. It is the
    // affordance that says the row OPENS something; without it a HOME row reads as a
    // status line.
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.setTextDatum(MR_DATUM);
    tft.drawString(">", CARD_X + CARD_W - PAD, y + HOME_ROW_H / 2);
    tft.setTextDatum(TL_DATUM);
  }
}
// The six summaries, composed from the same globals each group's own page draws
// from - nothing is stored, so they cannot disagree with the page you open.
void settingsHomeSummary(int g, char* buf, size_t n, uint16_t* col) {
  *col = COLOR_LABEL;
  switch (g) {
    case SET_DEVICE: {
      bool bt = bleConnected, usb = usbLinkActive();
      const char* links = (bt && usb) ? "Both links up" : (bt || usb) ? "One link up" : "No link";
      // Colour SUPPORTS the words, it never carries the meaning: the phrase says
      // which state this is on its own, in greyscale and to a colour-blind eye.
      *col = (bt && usb) ? COLOR_GOOD : COLOR_WARN;
      char pctS[8] = "--";
      if (batteryPresent()) snprintf(pctS, sizeof(pctS), "%d%%", batteryPct());
      // THE DIE TEMPERATURE IS BOARD 2's AND THE GUARD IS THE SAME FLAG dieTempRead()
      // CARRIES IN power.ino, not a second opinion about which board this is - the
      // shape settings.ino already uses for battChargeLabel() further down. The
      // ESP32-S3's internal sensor is the whole of that facility; board 1's classic
      // ESP32 has no driver for it, so the function does not merely go unwired there,
      // it does not EXIST, and the first board-1 compile of this line failed on it.
      //
      // BOARD 1's ROW DROPS THE TERM RATHER THAN DRAWING "--", and that is this
      // function's own opening premise: the summaries are composed from the same
      // globals each group's page draws from, so HOME and the page cannot disagree.
      // Board 1's DEVICE group has no temperature on it either (BOARD_DEVICE_
      // DIAGNOSTICS is 0 there), so a summary promising one would name a fact you
      // cannot then go and read - and a permanent "--" reads as a sensor that is
      // BROKEN rather than one that is absent, which is the distinction
      // dieTempRead()'s own comment insists on from the other side.
      //
      // WHY THE WHOLE STATEMENT IS DUPLICATED HERE, against CLAUDE.md's preference
      // for guarding only the fragment that differs: the rule it states is about arms
      // that OPEN A BRACE in both directions, which leaves every brace-counting reader
      // here one `{` ahead - and neither arm below opens one (`if (...) snprintf(...);`
      // has no body).
      // THE FORCING CAUSE IS THE FORMAT-STRING LITERAL, NOT A HASH. The three spaces
      // that separate the percentage from the temperature live INSIDE "%s   %s   %s",
      // so there is no single-statement spelling that keeps them: moving the separator
      // out to the temperature's own buffer replaces one string constant in .rodata
      // with two different ones, which is a real change to the image board 2 emits -
      // it would be wrong to call it byte-identical code that merely happened to
      // hash differently. The hash is only how it was NOTICED: the single-statement
      // version was written first and board-baseline.mjs reported board 2 CHANGED by
      // -16 bytes, and board 2 is required to come out of this task byte-unchanged.
#if !BOARD_USES_TFT_ESPI
      char tempS[8] = "--";
      float dieC = 0;
      if (dieTempRead(&dieC)) snprintf(tempS, sizeof(tempS), "%d C", (int) dieC);
      snprintf(buf, n, "%s   %s   %s", links, pctS, tempS);
#else
      snprintf(buf, n, "%s   %s", links, pctS);
#endif
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
    // The one setting on this device the MAC acts on, so the summary says what
    // the Mac is being asked for rather than restating the label ("send NEXT"
    // would be the row's own name twice). It reads off msgPriority, the same
    // global the page draws from, so HOME and the page cannot disagree.
    case SET_MESSAGES:
      snprintf(buf, n, "send %s", MSG_PRI_LABELS[msgPriority < MSG_PRI_COUNT ? msgPriority : MSG_PRI_NEXT]);
      break;
    // The DANGER row names its two controls rather than describing the group. A
    // summary reading "destructive" would say only what the row's own name already
    // says; what a person wants before tapping into a page they cannot undo is
    // WHICH two things are in there. Fixed text, because both controls are always
    // present on this board - there is nothing live to read off.
    default:
      snprintf(buf, n, "reset pairing, power off");
      break;
  }
}
void renderSettingsHome() {
  for (int i = 0; i < SET_GROUP_COUNT; i++) {
    char buf[HOME_SUB_BYTES + 16];
    uint16_t col;
    settingsHomeSummary(SET_DEVICE + i, buf, sizeof(buf), &col);
    // Padded so the opaque box is a constant width and a shrinking summary cannot
    // leave the tail of a longer one behind; truncated to the cache, which is what
    // drawIfChanged compares.
    padTo(buf, sizeof(buf), HOME_SUB_CHARS);
    buf[HOME_SUB_CHARS] = '\0';
    // Only the Device row's colour ever moves; the other five are COLOR_LABEL.
    if (i == 0 && col != homeStatusColorCache) {
      homeStatusColorCache = col;
      homeSubCache[i][0] = '\0';
    }
    drawIfChanged(homeSubCache[i], HOME_SUB_BYTES, buf, CARD_X + PAD,
                  settingsHomeRowY(i) + HOME_SUB_DY, T_META, 1, col, COLOR_CARD);
  }
}
// ----- Page 0 / the DEVICE group -----
// TWO LIVE CARDS ON BOTH BOARDS, and then whatever each has room for under them:
// SIX DIAGNOSTIC LINES on board 2 (BOARD_DEVICE_DIAGNOSTICS), CALIBRATE TOUCH under
// a SETUP caption on board 1 (BOARD_TOUCH_NEEDS_CAL). Each board header's ST_*/DEV_*
// section carries its own geometry and the reasoning; what matters here is the split
// of labour. The two facts you came for - is the host talking to me, and how is the
// battery - LEAD a card each as a T_HEAD line with one dimmed detail under it. The
// eleven you read almost never are six monospace lines under a DIAGNOSTICS
// caption: they were the HOST card's four and the About page's five before this,
// ~416px of page for values nobody watches.
//
// THERE IS NO CONTROL ON THIS PAGE. POWER OFF was here for one commit of this
// branch and is on the DANGER group again; the page is read-only, so
// handleSettingsTouch has no SET_DEVICE arm at all rather than an empty one.
//
// The per-Mac rows are not here at all: they are on the Pairing group, where the
// Macs already are.
//
// Only the cards and the one caption are static; every value below is live and
// goes through renderDevicePage()'s change-only fields.
void drawDevicePageStatic() {
  uiCard(CARD_X, ST_CONN_Y, CARD_W, ST_CONN_H);
  uiCard(CARD_X, ST_PWR_Y,  CARD_W, ST_PWR_H);
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("CONNECTION", CARD_X + PAD, ST_CONN_Y + ST_CAP_DY);
  tft.drawString("POWER",      CARD_X + PAD, ST_PWR_Y  + ST_CAP_DY);
  // The captions below sit on COLOR_BG, not on a card, so they go through
  // drawGroupCaption like every other page caption rather than through the two
  // drawString calls above.
  //
  // THE TWO BOARDS CARRY DIFFERENT THINGS UNDER THE CARDS, and each is guarded on
  // the flag that names the reason rather than on "which board this is":
  // BOARD_DEVICE_DIAGNOSTICS is 0 where there is a serial console to read those
  // facts from, and BOARD_TOUCH_NEEDS_CAL is 0 where the controller is factory-
  // aligned inside the display IC, so there is no runCalibration() to reach at all
  // and RECAL is refused by name there. Only the fragment that differs is behind
  // each guard - no brace is opened in either.
#if BOARD_DEVICE_DIAGNOSTICS
  drawGroupCaption("DIAGNOSTICS", DEV_DIAG_CAP_Y);
#endif
#if BOARD_TOUCH_NEEDS_CAL
  // RULING 12: CALIBRATE TOUCH LIVES HERE, not in the DANGER group. It destroys
  // nothing - it rewrites a touch mapping and keeps the old one if the run fails -
  // so a group named for what cannot be undone is the wrong place for it, and
  // moving it out is what leaves DANGER holding exactly two destructive verbs on
  // BOTH boards. The button and its hit test are under the same one flag, so they
  // cannot come apart; board 2 declares neither DEV_CAL_CAP_Y nor DEV_CAL_Y at all.
  drawGroupCaption("SETUP", DEV_CAL_CAP_Y);
  uiButton(CARD_X, DEV_CAL_Y, CARD_W, H_BTN, "CALIBRATE TOUCH", COLOR_ACCENT);
#endif
}
#if BOARD_DEVICE_DIAGNOSTICS
// THE TWO COLUMNS OF ONE DIAGNOSTIC LINE, composed into ONE padded string: the
// left value from the lane's left edge, the right value flush to its right edge,
// and the space between them filled. One field rather than two, because both faces
// on this board are monospace - so the right column lands on an exact character
// cell without a second padded width to keep in step - and because one opaque box
// cannot leave a seam down the middle of a line the way two adjacent ones can.
//
// The RIGHT value is what loses characters if a pair ever outgrows the lane, and it
// is a clamp rather than a policy: settings-geom-check.mjs measures every pair this
// page can compose against DEV_DIAG_CHARS and requires a space between them, so
// this branch is unreachable rather than merely unlikely. It is here because a
// truncation is a wrong reading and an overrun is a crash.
void devDiagLine(char* out, size_t n, const char* left, const char* right) {
  int rl = (int) strlen(right);
  if (rl > DEV_DIAG_CHARS) rl = DEV_DIAG_CHARS;
  int at = DEV_DIAG_CHARS - rl;                 // the right column's first cell
  snprintf(out, n, "%-*.*s", at, at, left);     // left, padded AND truncated to `at`
  snprintf(out + at, n - at, "%.*s", rl, right);
}
// THE ELEVEN FACTS, as SIX lines under one caption. They were the HOST card's four
// (payload, flush, uptime, live Macs) and the About page's five (build, time,
// commit, board, BT MAC), plus the device's own name and the die temperature - two
// pages and a card, ~416px, for values nobody watches. board_es3c35p.h's
// DIAGNOSTICS note carries the pairing table and the argument for each pair; what
// matters here is that line DEV_DIAG_TEMP_LINE is the one with no right column,
// because it is the one whose COLOUR means something.
//
// EVERY LINE IS COMPOSED EACH TICK AND GOES THROUGH drawIfChanged, the fixed ones
// included. Splitting them into a static half for the build stamp and a live half
// for the uptime would save one comparison per line and cost the thing this whole
// file's redraw discipline exists to protect: a value on the static side is a value
// that goes stale silently, and "Deckhand-C114" is only fixed until the device is
// renamed.
void drawDeviceDiagnostics(int y) {
  char l[DEV_DIAG_BYTES], r[DEV_DIAG_BYTES], line[DEV_DIAG_BYTES];
  const int x = CARD_X + PAD;
  // ---- 0: how big a frame is, and how slow ----
  if (lastPayloadBytes == 0) snprintf(l, sizeof(l), "no payload yet");
  else snprintf(l, sizeof(l), "%u B per tick", (unsigned) lastPayloadBytes);
  {
    // Milliseconds to one decimal, clamped at 999.9 so the width is fixed. This
    // field PARTLY MEASURES ITS OWN REPAINT and never settles - see the note in
    // board_es3c35p.h; SHIMBENCH is still the instrument for a full-screen flush.
    uint32_t us = tft.lastFlushUs();
    unsigned long ms = us / 1000, tenth = (us % 1000) / 100;
    if (ms > 999) { ms = 999; tenth = 9; }
    snprintf(r, sizeof(r), "flush %lu.%lu ms", ms, tenth);
  }
  devDiagLine(line, sizeof(line), l, r);
  drawIfChanged(devDiagCache[0], DEV_DIAG_BYTES, line, x, y, T_META, 1,
                COLOR_VALUE, COLOR_BG);
  // ---- 1: how hot the die is, AND THE ONE FIELD ON THIS PAGE WITH A COLOUR ----
  // ALONE ON ITS LINE, which is the whole reason the band could come back: a line
  // here is ONE padded field with ONE colour, so a temperature sharing a line with
  // the flush figure would have coloured the flush figure by temperature too.
  //
  // "--" when the sensor never came up, never a plausible 0.0 - a measurement and a
  // failure must not render identically. It says SoC, never "Temp", because the
  // sensor is inside the package and cannot see the charger or the cell: the label
  // is the only place a reader learns which temperature this is. A failed read is
  // COLOR_LABEL rather than any band - "no reading" is not a temperature, and
  // colouring it good would be the same lie the 0.0 would have been.
  {
    float dieC = 0;
    uint16_t tcol = COLOR_LABEL;
    if (dieTempRead(&dieC)) {
      snprintf(l, sizeof(l), "SoC %.1f C", dieC);
      tcol = colorForDieTemp(dieC);
    } else {
      snprintf(l, sizeof(l), "SoC --");
    }
    // THE COLOUR BUSTS THE TEXT CACHE, because drawIfChanged compares TEXT ONLY.
    // The reading moves in tenths so most band crossings do change the string - but
    // 54.9 -> 55.0 is exactly one tenth and is also the crossing into COLOR_WARN, so
    // "the text happens to change too" is the reasoning that made battRowTextCache
    // correct by accident until it was not.
    if (tcol != devDiagTempColorCache) {
      devDiagTempColorCache = tcol;
      devDiagCache[DEV_DIAG_TEMP_LINE][0] = '\0';
    }
    devDiagLine(line, sizeof(line), l, "");
    // devDiagCache[DEV_DIAG_TEMP_LINE], not devDiagCache[1]: this is the one line
    // whose index a second site (the cache bust three lines up) also has to know,
    // and the header's own note says a literal here is how the temperature ends up
    // coloured on a line that has since come to hold something else.
    drawIfChanged(devDiagCache[DEV_DIAG_TEMP_LINE], DEV_DIAG_BYTES, line, x,
                  y + DEV_DIAG_STEP, T_META, 1, tcol, COLOR_BG);
  }
  // ---- 2: the radio's address, and how many Macs are on it ----
  // btMacAddress is set once in setupBLE(); empty means BLE has not come up yet, so
  // the row says "--" rather than drawing a blank cell that reads as a rendering
  // fault. The count is usedLinkCount(), the LIVE links, which is a different number
  // from the paired hostCount the Pairing group shows: this is a diagnostic, that is
  // a setting.
  snprintf(l, sizeof(l), "BT %s", btMacAddress.length() ? btMacAddress.c_str() : "--");
  {
    int live = usedLinkCount();
    if (live == 0) snprintf(r, sizeof(r), "no Macs");
    else snprintf(r, sizeof(r), "%d Mac%s", live, live == 1 ? "" : "s");
  }
  devDiagLine(line, sizeof(line), l, r);
  drawIfChanged(devDiagCache[2], DEV_DIAG_BYTES, line, x, y + 2 * DEV_DIAG_STEP, T_META, 1,
                COLOR_VALUE, COLOR_BG);
  // ---- 3: what this device calls itself, and how long it has been up ----
  snprintf(l, sizeof(l), "%s", deviceName);
  {
    unsigned long mins = millis() / 60000UL;
    if (mins > 99UL * 60 + 59) mins = 99UL * 60 + 59;
    snprintf(r, sizeof(r), "up %luh %02lum", mins / 60, mins % 60);
  }
  devDiagLine(line, sizeof(line), l, r);
  drawIfChanged(devDiagCache[3], DEV_DIAG_BYTES, line, x, y + 3 * DEV_DIAG_STEP, T_META, 1,
                COLOR_VALUE, COLOR_BG);
  // ---- 4: which board, and which build ----
  // `unknown` is the honest answer and it is a WORD rather than an empty cell: it
  // means this binary was not the one flash.sh stamped, so any SHA in NVS belongs
  // to another build. A blank here would read as a rendering fault, and this is the
  // one field a reader cannot check against anything else.
  devDiagLine(line, sizeof(line), BOARD_NAME, fwCommit[0] ? fwCommit : "unknown");
  drawIfChanged(devDiagCache[4], DEV_DIAG_BYTES, line, x, y + 4 * DEV_DIAG_STEP, T_META, 1,
                COLOR_VALUE, COLOR_BG);
  // ---- 5: when that build was made ----
  // The TIME is back beside the DATE. It was dropped when this block was four lines
  // on the grounds that it "only distinguishes two builds made on the same day" -
  // which is precisely the case a person flashing this repeatedly is in, and the
  // commit does not cover it either (a dirty tree stamps the same SHA twice).
  //
  // THIS IS THE SKETCH'S ONLY STANDALONE __TIME__ AND IT WAS MEASURED, because a
  // second varying literal outside board-baseline.mjs's mask would make `--check 2`
  // report CHANGED on every rebuild for ever - and a CHANGED you have learned to
  // expect is a CHANGED you stop reading. Two builds of IDENTICAL source, forced to
  // recompile by dropping the sketch cache so the stamps really differ:
  //   Sep 12 2026 03:33:10  raw md5 5c96d281...  masked 78210786e9bc4c8c  1063360
  //   Sep 12 2026 03:34:59  raw md5 ba52be45...  masked 78210786e9bc4c8c  1063360
  // Same masked hash, so the baseline is STABLE. The reason is that the linker
  // TAIL-MERGES this literal into BUILD_STAMP's (`__DATE__ " " __TIME__`, the one
  // the mask covers): the build time plus its NUL occurs exactly ONCE in each image,
  // at BUILD_STAMP's own tail. __DATE__ beside it is a separate literal - a prefix
  // cannot be tail-merged - but it only moves at midnight, which is the one-day
  // shelf life the baseline already documents and pays for.
  //
  // TAIL-MERGING IS THE LINKER'S CHOICE, NOT THIS SKETCH'S, which is the same thing
  // that went wrong when the mask relied on the date and time being ADJACENT
  // literals and a few NVS keys slid between them. If `--check 2` ever reports
  // CHANGED with no source change, this is the first place to look, and the fix is
  // to compose both columns from BUILD_STAMP (`sizeof(__DATE__) - 1` gives the split
  // point without emitting a literal) rather than to widen the mask - a mask hides
  // the symptom, the concatenation removes the cause.
  devDiagLine(line, sizeof(line), __DATE__, __TIME__);
  drawIfChanged(devDiagCache[5], DEV_DIAG_BYTES, line, x, y + 5 * DEV_DIAG_STEP, T_META, 1,
                COLOR_VALUE, COLOR_BG);
}
#endif  // BOARD_DEVICE_DIAGNOSTICS
void renderDevicePage() {
  char buf[40];
  const int xLeft  = CARD_X + PAD;

  // ---- CONNECTION: the verdict, then which transports and how stale ----
  bool bt = bleConnected, usb = usbLinkActive();
  // The PHRASE names the state on its own - in greyscale, and to a colour-blind
  // eye - and the colour is an accent on it. Same rule as HOME's Device summary,
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
  // `deviceName, N paired` WAS THIS CARD'S SECOND LINE and it is gone in two
  // directions, which is what let the card go 112 -> 70. The name is a fixed fact
  // and reads as one of the DIAGNOSTICS below; the paired COUNT belongs on the
  // Pairing group, beside the Macs it counts, where it is a setting rather than a
  // reading. Neither was ever about whether the host is talking to this device,
  // which is the one question this card exists to answer.

  // ---- POWER: the reading and the estimate ----
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
    // THE CHARGE ESTIMATOR IS BOARD 2's, and the guard here is the same flag it
    // carries in power.ino - not a second opinion about which board this is. It is
    // board-agnostic arithmetic that has never been verified on board 1, and
    // power.ino's own note says the scoping is "ordinary unverified work" rather
    // than something that could not work; bringing it over is a change to the
    // POWER estimator, not to the SETTINGS redesign, so it is left alone here.
    // Board 1's card therefore reads "charging" with no duration, which is the
    // same sentence the empty-label case already produces - a missing estimate,
    // never a placeholder one. Only the one statement is behind the guard.
#if !BOARD_USES_TFT_ESPI
    else if (bst == BATT_CHARGING) battChargeLabel(left, sizeof(left), battChargeMinutesToFull());
#endif
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
  // THE SoC TEMP WAS THIS CARD'S SECOND LINE and it is a DIAGNOSTICS column now.
  // It is not about power: the sensor is inside the SoC package and cannot see the
  // charger or the cell, so it sat here only because this was the page with a
  // card to put it on. What it lost in the move is its warm/hot COLOUR BAND - a
  // diagnostics line is one padded field with one colour, and colouring it by
  // temperature would colour the flush figure beside it too.

  // ---- DIAGNOSTICS: the nine facts, four lines, under the two cards ----
  // They earn their place on this board specifically because there is no serial
  // console in normal operation here: "how big and how slow is a frame, how long
  // has this been up, how many Macs are on it, and what build is this" was
  // otherwise unanswerable from the device itself. Host LIVENESS is not among them
  // - it leads the CONNECTION card above, which is where it belongs and where it
  // stopped being a fifth diagnostic among equals.
  //
  // BOARD 1 DRAWS NO BLOCK AND DECLARES NONE OF ITS CONSTANTS, which is why the
  // guard is around the DEFINITION above as well as around this call: a guarded
  // call with an unguarded body would not merely draw nothing there, it would fail
  // to compile on DEV_DIAG_Y. See BOARD_DEVICE_DIAGNOSTICS in board_e32r28t.h for
  // the reason - that board has a CH340 console and these facts are a `screen`
  // away, where this one has none in normal operation.
#if BOARD_DEVICE_DIAGNOSTICS
  drawDeviceDiagnostics(DEV_DIAG_Y);
#endif
}
// ----- Page 1: CONTROLS -----
// ----- The DISPLAY group (BOTH boards) -----
// Two steppers, three THEME segments and the flip toggle on both. A cycle button
// shows one state and hides the other two, and THEME has three - so it was never a
// uiToggle and it is not one on either board now. What DIFFERS is the framing, not
// the controls: board 2 heads the segments with a "THEME" caption and explains AUTO
// in a hint under them; board 1 has 30px across four gaps against the ~46 those two
// want, so it draws neither (BOARD_SETTINGS_FITS_CAPTIONS, arithmetic in both
// headers). Only those two lines are behind the guard.
void drawDisplayPageStatic() {
  drawStepperCard(P1_BRIGHT_Y, "BRIGHTNESS");
  drawStepperCard(P1_SLEEP_Y, "SLEEP AFTER");
  // THE CAPTION AND THE HINT ARE ONE BLOCK WITH THE SEGMENTS, which is why one
  // flag gates both: board 1's page has 30px across four gaps after the two
  // steppers, the segments and the flip toggle, and the two text parts want ~46.
  // See BOARD_SETTINGS_FITS_CAPTIONS in each header for that arithmetic. The SEGMENTS
  // are not gated - both boards draw all three options at once.
  //
  // AUTO is a CLOCK, not a sensor - every ADC1 channel on board 2 is spoken for,
  // so there is no light to measure. Saying so is the same rule that stops the
  // farewell screen promising a touch wake a board does not have.
#if BOARD_SETTINGS_FITS_CAPTIONS
  drawGroupCaption("THEME", P1_THEME_CAP_Y);
  uiHint("AUTO = light 07:00 to 19:00", P1_AUTO_HINT_Y);
#endif
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
  // not a cycle button. Board 1 HAD one (a third-width button sharing a row with the
  // flip toggle and the SOUND toggle) and no longer does: it draws these segments,
  // at its own P1_THEME_SEG_W of 69 against board 2's 96. An earlier revision of this
  // line said "the cycle button board 1 still uses", which stopped being true in the
  // same commit that made this function shared.
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
  // AUTO was the one settings control that named neither itself nor its subject.
  // Naming it in the LABEL rather than adding a caption is what makes it free, and it
  // is free on BOTH boards: 13-14 characters is 78-84px in board 1's 216px control
  // and 104-112px in board 2's 296px one, and no offset moves on either.
  if ((int) screenFlipped != flipBtnCache) {
    flipBtnCache = (int) screenFlipped;
    uiToggle(CARD_X, P1_FLIP_Y, CARD_W, H_ROW, "SCREEN FLIPPED", "SCREEN NORMAL", screenFlipped);
  }
}
// ----- The SOUND group (BOTH boards) -----
// Output and input together, because a mic test IS a sound test - and it is the one
// action you run repeatedly, since MICMON is how MIC_GAIN gets settled. Board 2 adds
// the ALERTS and MICROPHONE captions and the hint that says what a beep means; board
// 1 has 38px of slack across five gaps against the ~55 those three want, so its four
// controls stand on their own names (BOARD_SETTINGS_FITS_CAPTIONS).
void drawSoundPageStatic() {
  // The two captions and the hint are the framing, not the controls: board 1 has
  // 38px of slack across five gaps and they want ~55. See BOARD_SETTINGS_FITS_CAPTIONS.
  // What that board loses is the output/input separation MICROPHONE drew and the
  // one line saying what a beep MEANS; the four controls name themselves.
#if BOARD_SETTINGS_FITS_CAPTIONS
  drawGroupCaption("ALERTS", PS_ALERTS_Y);
  uiHint("beeps when a session needs input", PS_WHAT_HINT_Y);
#endif
  drawStepperCard(PS_VOL_Y, "VOLUME");
  uiButton(CARD_X, PS_BEEP_Y, CARD_W, PS_BTN_H, "TEST BEEP", COLOR_ACCENT);
#if BOARD_SETTINGS_FITS_CAPTIONS
  drawGroupCaption("MICROPHONE", PS_MIC_CAP_Y);
#endif
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
  // "then the DEVICE page now reads unpaired": the rebuild draws settingsPage, which
  // is the DANGER group this was tapped from - on BOTH boards now, where it used to
  // be board 1's ACTIONS page and board 2's Actions group. The page whose text
  // changes (Device's link verdict, the Macs list) is one the user has to navigate
  // back to.
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
// ----- Page 2: the pre-3A ACTIONS page (dead) / the DANGER group (both boards) -----
// ----- The DANGER group (BOTH boards) -----
// TWO buttons, in ONE captioned section, and both of them destroy state. MIC TEST
// is not here - it lives on the SOUND group, where a mic test belongs and where it
// is the one action you run repeatedly - and CALIBRATE TOUCH is not offered on this
// board at all. What that leaves is a group whose NAME is the warning.
//
// Before this the four were uiButton with `filled` false, i.e. four identically
// shaped outlined slabs differing only in stroke HUE - and this repo's rule is
// that meaning never rests on colour alone. Severity now has three carriers:
// POSITION (a captioned section that holds nothing else, and the page's own name),
// INK MASS (a solid spine, which survives greyscale and every colour-vision
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
// TWO buttons, ONE caption, and both buttons destroy state - which is what the
// group is called Danger for, on BOTH boards. POWER OFF is LAST because it is the
// more severe of the two: a reset costs you the keys, a power-off costs you the
// device until someone presses RESET (or touches the glass - see the hint's #if).
//
// CALIBRATE TOUCH IS NOT HERE, and the reason is now different on each board, which
// is exactly why both are written down. Board 2 does not offer it AT ALL: the touch
// controller is factory-aligned inside the display IC, so there is nothing to
// calibrate, runCalibration() is not compiled there and RECAL is refused by name -
// a control that cannot work is never offered, and neither is the verb behind it. Board 1 DOES offer it - on the DEVICE group, under a SETUP
// caption, guarded on BOARD_TOUCH_NEEDS_CAL - because it is not destructive: it
// rewrites a touch mapping and keeps the old one if the run fails. Either way this
// group holds exactly the two verbs that destroy state, which is what makes its name
// right on both boards. (RULING 12; see board_e32r28t.h's Device section.)
//
// THE HINT UNDER POWER OFF IS DRAWN ON BOTH BOARDS. An earlier revision of this note
// said "NO HINT UNDER POWER OFF ... Board 1 keeps the hint on its own page", which
// was true for the one commit where this function was board 2's alone and board 1
// still had its own four-button ACTIONS page. Board 1 compiles THIS function now, so
// that sentence was describing a page that no longer exists while sitting directly
// above the uiHint() call that contradicts it - the "a comment is not parsed" class
// this file has paid for eight times on this branch. Corrected rather than deleted,
// per the repo's own rule about descriptions that turned out to be wrong.
void drawDangerPageStatic() {
  drawGroupCaption("CANNOT BE UNDONE", P2_DANGER_CAP_Y);
  drawSeverityAction(P2_PAIR_Y, "RESET PAIRING", COLOR_WARN);
  drawSeverityAction(P2_PWR_Y,  "POWER OFF",     COLOR_BAD);
  // THE HINT IS THE ONLY THING THAT SAYS WHAT POWER OFF DOES BEFORE THE TAP. The
  // confirm dialog says it after, which is too late to be the affordance - the
  // decision to reach for the button has already been made by then. It sits at
  // P2_PWR_Y + P2_BTN_H + SP_3 on both boards, so it reads as a line under the
  // button rather than as page furniture, and there is air under it either way:
  // P2_AIR_BOT is 69 rows on board 1 and 174 on board 2, so nothing here is
  // anywhere near the footer on either. BOTH figures, deliberately - a single
  // number here is a number that becomes false the next time a flag moves, which
  // is what "174 rows of air" did the moment board 1 started compiling this page.
  //
  // Only the FRAGMENT that differs is behind the #if - neither arm opens a brace, so
  // the brace-counting readers every checker here uses still balance. The rule it
  // answers to is that a board which cannot wake on touch must not promise one:
  // reading "touch to wake" on a device that will not is worse than reading nothing,
  // because it turns a hardware fact into what looks like broken firmware.
  uiHint(
#if BOARD_HAS_TOUCH_SLEEP_WAKE
         "power off = deep sleep, touch to wake",
#else
         "power off = deep sleep, RESET to wake",
#endif
         P2_PWR_Y + P2_BTN_H + SP_3);
}
// ----- Page 4 / the MESSAGES group -----
// ONE IMPLEMENTATION FOR BOTH BOARDS, deliberately. Pages 2 and 3 split into
// per-board arms because their CONTENT diverged; nothing here does - the caption,
// the three rows and the hint are the same on a 240x320 panel and a 320x480 one,
// and only the four constants behind P4_CAP_Y/P4_ROW_Y/P4_ROW_STEP/P4_HINT_Y
// differ. A split would be two copies of one page and two chances to drift.
//
// THE ROWS SAY WHAT THEY MEAN, not what they are called. "NEXT" alone is not a
// setting anybody can act on; "NEXT   after this turn" is. The three phrases are
// column-aligned because both faces are monospace, and they are bounded by
// P4_LABEL_CHARS - the lane uiListRow actually leaves between its label origin
// and its tag, MEASURED in each header rather than counted here.
//
// THE HINT IS THE PRECEDENCE RULE, and it earns its line. The Mac's
// DECKHAND_INBOX_PRIORITY overrides whatever is chosen here, and without this
// line the failure is the worst kind available on a device with no error
// channel: you tap LATER, the Mac keeps sending NOW, and there is nothing
// anywhere on the glass to say why. The host says so in its own log too - the
// two surfaces exist because only one of them is in the room with you.
void drawMessagesPageStatic() {
  drawGroupCaption("HOW MY MESSAGES LAND", P4_CAP_Y);
  uiHint("the Mac can override this", P4_HINT_Y);
  // The three rows are drawn by renderMessagesPage - their look changes with
  // state, so they belong on the change-only side.
}
// The option rows. One cache for the block (see msgPriBtnCache): exactly one row
// is ever filled, so a change repaints all three and per-row caches could only
// ever move together.
void renderMessagesPage() {
  if ((int) msgPriority == msgPriBtnCache) return;
  msgPriBtnCache = (int) msgPriority;
  // Selection is FILL plus the "ON" tag plus position, never colour alone - the
  // same rule the THEME segments and every uiListRow on the Pairing page follow.
  static const char* const MSG_PRI_ROWS[MSG_PRI_COUNT] = {
    "NOW    interrupt the turn",
    "NEXT   after this turn",
    "LATER  after the queue",
  };
  for (int i = 0; i < MSG_PRI_COUNT; i++) {
    bool on = (i == (int) msgPriority);
    uiListRow(CARD_X, P4_ROW_Y + i * P4_ROW_STEP, CARD_W, H_ROW,
              MSG_PRI_ROWS[i], on, on ? "ON" : nullptr);
  }
}
// NVS, following theme's shape exactly (putUChar/getUChar with a default) and
// clamped on read for the same reason themeMode is: a corrupt or
// future-firmware byte must land on the SAFE option rather than on whatever
// happens to be at that index. NEXT is the safe one - NOW interrupts a turn.
// The key is 6 characters against NVS's 15-character cap.
void loadMsgPriority() {
  msgPriority = prefs.getUChar("msgpri", MSG_PRI_NEXT);
  if (msgPriority >= MSG_PRI_COUNT) msgPriority = MSG_PRI_NEXT;
}
void saveMsgPriority() { prefs.putUChar("msgpri", msgPriority); }
// The one place the setting CHANGES, so the one place that has to persist it,
// redraw it and tell the Mac. Three callers - the row taps and the MSGPRI
// command - and each of them forgetting one of the three is exactly the drift
// this exists to prevent.
//
// A NO-OP CHANGE RETURNS EARLY AND SAYS NOTHING, which is not tidiness: the host
// delivers every trigger-file command over BOTH transports, so a cabled board
// sees "MSGPRI now" twice within milliseconds. Without this the second copy
// repaints three rows and puts a second MSGPRI on a link with an 11.5KB/s
// ceiling, to report something that did not move.
// IS THE PAGE ACTUALLY ON THE GLASS? renderMessagesPage() draws at P4_ROW_Y
// unconditionally - it has no idea which surface is up - so this must be asked
// before it is called from anywhere but a tap. It nearly was not: the first
// version of setMsgPriority() called it outright, which meant `MSGPRI now` sent
// while the USAGE tab was showing would have painted three option rows across
// the quota cards.
bool messagesPageShowing() {
  return currentTab == TAB_SETTINGS && settingsPage == SET_MESSAGES;
}
void setMsgPriority(uint8_t v) {
  if (v >= MSG_PRI_COUNT || v == msgPriority) return;
  msgPriority = v;
  saveMsgPriority();
  // Busted whether or not it is drawn now, so the rows are right the moment the
  // page is next opened - drawSettingsStatic() would reset it anyway, and relying
  // on that would make this correct only by someone else's habit.
  msgPriBtnCache = -1;
  if (messagesPageShowing()) renderMessagesPage();
  announceMsgPriority();
}
// The hit test, SHARED, and bound to the same three constants the draw uses -
// which is what stops the band and the row it belongs to from ever disagreeing.
//
// THE GAPS BETWEEN ROWS ARE INERT, not rounded to the nearest row. The drawn row
// IS the tested band here (H_ROW on both boards, which is exactly TAP_MIN), so
// there is no widening to argue about; and the three choices mean genuinely
// different things - NOW interrupts a turn where LATER waits behind a queue - so
// a tap that lands in 8px of background must do NOTHING rather than pick one of
// the two rows it fell between. Same rule HOME's gaps and the Pairing cards
// follow, and the same reason.
void handleMessagesTouch(int sx, int sy) {
  (void) sx;   // full-width rows: the x is unconstrained, deliberately
  for (int i = 0; i < MSG_PRI_COUNT; i++) {
    int y = P4_ROW_Y + i * P4_ROW_STEP;
    if (sy >= y && sy < y + H_ROW) { setMsgPriority((uint8_t) i); return; }
  }
}

// ----- Page 3 / the PAIRING group -----
// THE LIVE MAC ROWS LAND HERE, on both boards. They used to be on the STATUS page too,
// in a second format keyed off hostLinks[] rather than off hosts[] - so the list
// that owns the destructive controls was the one list that could not say whether
// a Mac was connected, while the page with no slack carried a duplicate of it.
//
// Liveness costs NO new state and nothing new on the wire: it is the same
// hostLinks[] lookup the STATUS page's per-Mac rows did (renderMacLinkRows(),
// deleted in Task 4 with that page), matched against the row's own hosts[i].id.
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
  // THE TWO SECTION CAPTIONS ARE GATED and board 1 draws neither, which the spec's
  // own AMENDMENT predicted: this page spends 212 of that board's 222px on the ANY
  // row and four Mac rows, and the captions want 42 more. It is the same table that
  // rejected the five-group set, arriving at the same answer. See
  // BOARD_SETTINGS_FITS_CAPTIONS. What board 1 loses is "ANSWER PROMPTS FROM" over the
  // ANY row - which it never had - so the row's own "ANY MAC"/"SELECTED" pair is
  // what has to say what it does, as it always has here.
#if BOARD_SETTINGS_FITS_CAPTIONS
  drawGroupCaption("ANSWER PROMPTS FROM", P3_ANY_CAP_Y);
#endif
  // The ANY row keeps the component and the height it always had: it is a choice,
  // not a Mac, so it stays a uiListRow where the rows under it are cards.
  bool any = (allowedHost[0] == 0);
  uiListRow(CARD_X, P3_ANY_Y, CARD_W, H_ROW, "ANY MAC", any, any ? "SELECTED" : nullptr);
#if BOARD_SETTINGS_FITS_CAPTIONS
  drawGroupCaption("PAIRED MACS", P3_LIST_CAP_Y);
#endif
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
#if BOARD_TOUCH_NEEDS_CAL
    // THE WHOLE ARM IS BEHIND THE FLAG, label included, and it is the same flag the
    // draw site and the hit test carry - so the button, the tap that raises this
    // dialog and the dialog itself cannot come apart. Nothing on board 2 can set
    // pendingConfirm to CFM_RECAL: CALIBRATE TOUCH is not drawn there, handleSettingsTouch's
    // SET_DEVICE arm is guarded, and RECAL is refused by name out of UNAVAILABLE_COMMANDS[].
    //
    // THE `#else` THAT USED TO SIT INSIDE HERE drew the same dialog with the honest
    // caption "factory-aligned; there is nothing to do". It is deleted rather than
    // kept, because the control it described is gone: a dialog explaining that a
    // control does nothing describes a control that no longer exists. The note that
    // stood above it - "THE BUTTON ITSELF IS DELIBERATELY LEFT IN PLACE ... the mock
    // the user approved carries it" - was true of the mock that preceded this
    // redesign; the approved six-group mock drops CALIBRATE TOUCH on board 2.
    case CFM_RECAL:
      // THE SAME RULE AS CFM_POWER_OFF BELOW: a confirm dialog's entire job is
      // stating the consequence, so it is the last place that may describe
      // behaviour this silicon does not have. Both halves of this caption are true
      // on board 1 - runCalibration() there really does want 5 taps, and it really
      // does keep the previous affine mapping if the fit fails.
      drawConfirm("Recalibrate touch?", nullptr,
                  "5 taps; current setup kept if it fails", "CALIBRATE", COLOR_ACCENT);
      break;
#endif
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
  // FROM CONTENT_Y, not PAGE_TOP: HOME occupies the band's own rows on BOTH boards,
  // so a clear that started at PAGE_TOP would leave the group you came from wearing
  // its back band. (That sentence used to end "on board 1 the pager band is repainted
  // by drawPager() itself and clearing it first costs nothing" - true only while that
  // board had a pager, which Task 3B replaced and Task 4 deleted.) Every entry path
  // (openSettingsGroup, settingsBack, drawSettingsTab, forceFullRepaint) comes
  // through here, so this is the one clear and the navigation helpers deliberately
  // do not repeat it.
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  // HOME RETURNS EARLY AND EVERY GROUP GETS THE BAND. There is no per-board arm here
  // any more: the band and the six group bodies are ONE dispatch on both boards.
  if (settingsPage == SET_HOME) { drawSettingsHomeStatic(); return; }
  drawBackBand(settingsGroupTitle(settingsPage));
  if      (settingsPage == SET_DEVICE)  drawDevicePageStatic();
  else if (settingsPage == SET_DISPLAY) drawDisplayPageStatic();
  else if (settingsPage == SET_SOUND)   drawSoundPageStatic();
  else if (settingsPage == SET_PAIRING) drawHostsPageStatic();
  else if (settingsPage == SET_MESSAGES) drawMessagesPageStatic();
  else                                  drawDangerPageStatic();
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
  if      (settingsPage == SET_HOME)    renderSettingsHome();
  else if (settingsPage == SET_DEVICE)  renderDevicePage();
  else if (settingsPage == SET_DISPLAY) renderDisplayPage();
  else if (settingsPage == SET_SOUND)   renderSoundPage();
  // Pairing's rows carry a LIVE state line now ("connected, 3s ago"), so the page
  // is no longer static: left on the static side it would freeze at whatever age
  // was true when it was last painted, which is worse than no age at all.
  else if (settingsPage == SET_PAIRING) renderHostsPage();
  // The three option rows change with the setting, so like the THEME segments
  // they are on the change-only side; drawMessagesPageStatic draws only the
  // caption and the hint.
  else if (settingsPage == SET_MESSAGES) renderMessagesPage();
  // Danger is static
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
void resetSettingsCaches() {
  battRowTextCache[0] = '\0';
  soundBtnCache = -1; flipBtnCache = -1; themeBtnCache = -1; brightBarCache = -1;
  // A field whose CHROME is repainted must have its cache reset or the value is
  // left BLANK - drawSettingsStatic() clears the whole page area, so without this
  // the three option rows would be "unchanged" and never redrawn onto it.
  msgPriBtnCache = -1;
  battRowColorCache = 0;
  brightPctCache[0] = '\0'; sleepValCache[0] = '\0'; volValCache[0] = '\0';
  for (int i = 0; i < 6; i++) stepGlyphCache[i] = -1;
  // Same rule for the DEVICE group's two cards and four diagnostic lines and the
  // Pairing group's live rows: the static half repaints the surface all of these
  // are drawn ON, so leaving a cache set leaves that field BLANK - the value has
  // not "changed", so drawIfChanged skips a field whose pixels were just erased.
  // Resetting them HERE rather than at the call sites is what makes the invariant
  // impossible to forget.
  stVerdictCache[0] = '\0'; stVerdictColorCache = 0;
  stLinksCache[0] = '\0'; stLeftCache[0] = '\0';
  // The DIAGNOSTICS block's own caches, on the board that has one. Guarded on the
  // same flag as the block's definition and its call, because board 1 declares
  // neither devDiagCache nor DEV_DIAG_LINES - a reset left unguarded here would
  // not merely clear nothing, it would fail to compile.
#if BOARD_DEVICE_DIAGNOSTICS
  for (int i = 0; i < DEV_DIAG_LINES; i++) devDiagCache[i][0] = '\0';
  // The die temperature's COLOUR joins them, the stVerdictColorCache shape: it is
  // compared against, not drawn from, so leaving it set is not a blank field - it is
  // a band crossing that never repaints because the two agreed.
  devDiagTempColorCache = 0;
#endif
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
  // HOME's six summaries, and the Device row's colour beside them. Same rule as
  // every cache above: drawSettingsHomeStatic() repaints the cards these are drawn
  // ON, so leaving them set leaves all six rows BLANK. BOTH BOARDS reach this since
  // Task 3B - it said "On BOARD_SETTINGS_HOME only - board 1 has the six group PAGES
  // but no HOME list, so it declares neither", which was true for one task, and Task 4
  // deleted the guard that carried it along with the flag.
  for (int i = 0; i < SET_GROUP_COUNT; i++) homeSubCache[i][0] = '\0';
  homeStatusColorCache = 0;
}
// ----- NAVIGATION, and NAVIGATION ONLY -----
// ONE NAVIGATION ON BOTH BOARDS: HOME's open and back. Two flags used to stand over
// this - BOARD_SETTINGS_GROUPS for the six page BODIES and BOARD_SETTINGS_HOME for
// how you REACH them - so that board 1's content (Task 3A) and its navigation
// (Task 3B) could converge in separate commits. The `#else` here was the chevron ring
// board 1 used for exactly one task; Task 4 deleted it, both flags and every other
// arm they gated, and BOTH BINARIES CAME OUT BYTE-IDENTICAL.
// HOME -> a group, and back. Both go through drawSettingsStatic(), which clears
// from CONTENT_Y and resets every cache itself, so neither calls
// resetSettingsCaches() here - that used to be duplicated at both call sites,
// harmlessly (drawSettingsStatic() would just reset an already-reset cache),
// but a caller that repeats work drawSettingsStatic() already does on its own
// invites a reader to trust the comment over the code.
void openSettingsGroup(int g) {
  settingsPage = constrain(g, SET_DEVICE, SET_DANGER);
  drawSettingsStatic();
  renderSettingsTab();
}
void settingsBack() {
  settingsPage = SET_HOME;
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
  // Modal: while a confirm is up nothing else (the back band included) is live, so
  // a stray tap can't navigate away and leave it half-dismissed.
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
#if BOARD_TOUCH_NEEDS_CAL
        // Under the same flag as the dialog that raises it, for the same reason -
        // and here it is also a compile requirement rather than only tidiness:
        // runCalibration() is not declared at all on a board that needs no
        // calibration, so an unguarded call would not link.
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
#endif
        case CFM_RESET_PAIRING: resetPairing(); return;
        case CFM_POWER_OFF:     powerOff();     return;
        default: break;
      }
    }
    return;
  }

  // HOME first: its rows own the whole content area, band rows included, so this
  // has to run BEFORE the band branch below or the top row would read as a back tap.
  if (settingsPage == SET_HOME) {
    for (int i = 0; i < SET_GROUP_COUNT; i++) {
      int y = settingsHomeRowY(i);
      if (sy >= y && sy < y + HOME_ROW_H) { openSettingsGroup(SET_DEVICE + i); return; }
    }
    return;   // the gaps between rows are inert, not a guess at the nearest row
  }
  // The WHOLE band is the back target. Unlike the pager there is nothing else in
  // it, so there is no split to make and no dead zone to leave.
  if (sy < PAGE_TOP) { settingsBack(); return; }
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
  } else if (settingsPage == SET_MESSAGES) {
    handleMessagesTouch(sx, sy);
  } else if (settingsPage == SET_DANGER) {
    // NO MIC TEST AND NO CALIBRATE BRANCH, on EITHER board, and the two are absent
    // for different reasons - which is why both are written down rather than one
    // standing in for the other. MIC TEST is drawn on the SOUND group on both.
    // CALIBRATE TOUCH is not offered AT ALL on board 2 (there is no runCalibration()
    // compiled there, RECAL is refused by name, and a control that cannot work is
    // never offered) and IS offered on board 1 - but on the DEVICE group, under
    // BOARD_TOUCH_NEEDS_CAL, because it destroys nothing. Either way this page reserves no slot for it. An earlier revision of
    // this note said "CALIBRATE TOUCH is not offered on this board at all" full stop,
    // which stopped being true of one of the two boards the moment this arm became
    // shared.
    //
    // A `sy >= P2_MIC_Y` or `sy >= P2_CAL_Y` test left behind here would not merely
    // be dead - neither constant exists on either board now, and had either survived
    // as a stale constant it would claim taps belonging to whatever now sits in that
    // band. Removing the constants and the branches in one change is what makes the
    // two unable to disagree.
    //
    // BOTH ask first: resetting pairing wipes every key, and powering off
    // interrupts the display. The SP_3 (12px) between them is inert rather than
    // claimed by either - the same rule HOME's gaps and the Pairing cards follow,
    // and it matters most here because both rows destroy state, so a tap that lands
    // in the gap and is rounded to a neighbour is rounded to something irreversible.
    if (sy >= P2_PAIR_Y && sy < P2_PAIR_Y + P2_BTN_H) {
      pendingConfirm = CFM_RESET_PAIRING; drawPendingConfirm();
    } else if (sy >= P2_PWR_Y && sy < P2_PWR_Y + P2_BTN_H) {
      pendingConfirm = CFM_POWER_OFF;     drawPendingConfirm();
    }
#if BOARD_TOUCH_NEEDS_CAL
  // THE DEVICE GROUP CLAIMS ONE TAP, AND ONLY WHERE THE BUTTON IS DRAWN. The whole
  // ARM is behind the guard rather than just the hit test, because the alternative
  // is an empty branch on board 2 - and an empty arm on a read-only page is exactly
  // the invitation the Device block's own note refuses. It is the same guard the
  // draw site carries, so the button and its target cannot come apart; board 2
  // declares no DEV_CAL_Y at all, so this arm could not compile there even if the
  // flag were wrong.
  //
  // This is the one place in this file where a guarded fragment is not brace-
  // balanced, and it is deliberate. It used to be the SECOND such place in this
  // function - the band branch had one arm per board until Task 3B, and Task 4
  // deleted it - which is why settings-geom-check.mjs reads this function through
  // touchArm()/settingsTouchSrc() rather than through brace matching, and why it
  // still must: one unbalanced fragment is enough to make fnSrc() return "" here,
  // and an assertion bound to "" passes vacuously.
  } else if (settingsPage == SET_DEVICE) {
    // Recalibrating costs 5 taps and keeps the current mapping if it fails, so it
    // asks first - the same rule the other three confirmable actions follow.
    if (sy >= DEV_CAL_Y && sy < DEV_CAL_Y + H_BTN) {
      pendingConfirm = CFM_RECAL; drawPendingConfirm();
    }
#endif
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
  // Anything not claimed above is inert, and the one page that used to be wholly
  // inert no longer is on both boards: the DEVICE group is read-only on board 2 and
  // carries exactly one control on board 1 (CALIBRATE TOUCH, whose own tap raises a
  // modal rather than changing anything on the page). Its arm is above, behind
  // BOARD_TOUCH_NEEDS_CAL, so board 2 still claims no taps there at all.
}
void drawSettingsTab() {
  settingsPage = SET_HOME;   // always enter at HOME, never a group you last left
  resetSettingsCaches();
  drawSettingsStatic();
  renderSettingsTab();
}
