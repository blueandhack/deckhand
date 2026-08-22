// Readers: the paged history browser and the full-screen text reader.
// Split out of deckhand_display.ino - see pairing.ino for how the concatenated
// build works and what may not move.

const char* histTextAt(int i) { return &histArena[histOff[i]]; }
const char* histRoleLabel(uint8_t r) {
  switch (r) {
    case 0: return "YOU";
    case 1: return "CLAUDE";
    case 2: return "RAN";
    case 3: return "RESULT";
    default: return "DENIED / ERROR";
  }
}
// Colour follows the palette's roles, but the LABEL is what actually carries the
// meaning - same rule as the status shapes: colour is never the only carrier of meaning.
uint16_t histRoleColor(uint8_t r) {
  switch (r) {
    case 0: return COLOR_ACCENT;
    case 1: return COLOR_GOOD;
    case 4: return COLOR_BAD;
    default: return COLOR_LABEL;
  }
}
// ---------- History reader ----------
// Paginated by ITEM, not by line: an entry is a label plus its wrapped text, and
// splitting one across a page boundary makes it unreadable. An item taller than a whole
// page gets its own page and is clipped rather than lost.
void drawHistory() {
  if (detailIndex < 0 || detailIndex >= sessionCount) return;
  const SessionInfo& s = sessions[detailIndex];
  if (histPage >= histPages) histPage = histPages - 1;
  if (histPage < 0) histPage = 0;

  tft.fillScreen(COLOR_BG);
  // Filter chip, tappable: CHAT (conversation only) <-> ALL (plus commands and results).
  const char* chip = histChatOnly ? "CHAT" : "ALL";
  int chipW = histChatOnly ? HIST_CHIP_W_CHAT : HIST_CHIP_W_ALL;
  uiFillRound(HIST_CHIP_X, HIST_CHIP_Y, chipW, HIST_CHIP_H, 3, COLOR_ACCENT, COLOR_BG);
  setUIFont(1);
  tft.setTextColor(COLOR_BG, COLOR_ACCENT);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(chip, HIST_CHIP_X + chipW / 2, HIST_CHIP_CY);
  tft.setTextDatum(TL_DATUM);
  setUIFont(1);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  char hdr[40];
  snprintf(hdr, sizeof(hdr), "%s", s.name);
  tft.drawString(hdr, HIST_CHIP_X + chipW + 8, HIST_HDR_TEXT_Y);
  // Position in the WHOLE history, not just the page number - with hundreds of pages,
  // "412/628 entries" is what tells you where you are.
  char pg[20];
  if (histPending) snprintf(pg, sizeof(pg), "...");
  else if (histTotal > 0) snprintf(pg, sizeof(pg), "%d/%d", histFrom + 1, histTotal);
  else snprintf(pg, sizeof(pg), "%d/%d", histPage + 1, histPages);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(pg, tft.width() - 12, HIST_HDR_TEXT_Y);
  tft.setTextDatum(TL_DATUM);
  tft.drawFastHLine(0, HIST_RULE_Y, tft.width(), COLOR_LABEL);

  if (histPending || histCount == 0) {
    setUIFont(2);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(histPending ? "Asking the Mac..." : "Nothing here", tft.width() / 2, HIST_EMPTY_CY);
    tft.setTextDatum(TL_DATUM);
  } else {
    int y = HIST_TOP;
    for (int i = 0; i < histCount; i++) {
      histRowY[i] = y;
      if (y + HIST_LINE_H > HIST_JUMP_Y - 4) break;
      setUIFont(1);
      tft.setTextColor(histRoleColor(histRole[i]), COLOR_BG);
      tft.drawString(histRoleLabel(histRole[i]), 12, y);
      y += HIST_LINE_H;
      int room = (HIST_JUMP_Y - 4 - y) / HIST_LINE_H;
      if (room <= 0) break;
      int drew = drawWrappedText(histTextAt(i), 12, y, FONT_CODE, HIST_LINE_H,
                                 tft.width() - 24, 0, room, COLOR_VALUE, COLOR_BG);
      y += drew * HIST_LINE_H + 3;
      histRowY[i + 1] = y;
    }
  }

  // SCRUBBER, not one segment per page: a session can run to hundreds of pages, and a
  // segment each would be a pixel wide. Tap anywhere along it to jump to that fraction of
  // the history; the knob shows where you are and roughly how much there is.
  if (histPages > 1) {
    int trackX = 12, trackW = tft.width() - 24;
    // HIST_JUMP_Y is the top of the TAP band; the drawn track is centred in it.
    // The two are equal on board 1 (so this term is zero and its drawing is
    // unchanged) and differ on board 2, where the band is TAP_MIN while the track
    // stays a track - a full-width 46px filled rect reads as a box, and a 16px
    // one is not a target. See HIST_JUMP_TAP_H in the board headers.
    int trackY = HIST_JUMP_Y + (HIST_JUMP_TAP_H - HIST_JUMP_H) / 2;
    tft.fillRect(trackX, trackY, trackW, HIST_JUMP_H, COLOR_CARD);
    tft.drawRect(trackX, trackY, trackW, HIST_JUMP_H, COLOR_LABEL);
    int knobW = trackW / histPages;
    if (knobW < 6) knobW = 6;
    int kx = trackX + (long) (trackW - knobW) * histPage / (histPages - 1);
    tft.fillRect(kx, trackY + 1, knobW, HIST_JUMP_H - 2, COLOR_ACCENT);
  }

  struct { int x, w; const char* label; bool enabled; } btns[3] = {
    {READER_BTN_L_X, READER_BTN_L_W, "< PREV", histPage > 0},
    {READER_BTN_M_X, READER_BTN_M_W, "CLOSE", true},
    {READER_BTN_R_X, READER_BTN_R_W, "NEXT >", histPage < histPages - 1},
  };
  // Disabled ends grey out (same affordance as the steppers). The label's y comes
  // from READER_BTN_H, not a baked-in half of 42, or a taller chip on a bigger
  // panel would draw its text near the top.
  for (int i = 0; i < 3; i++) {
    uint16_t c = btns[i].enabled ? COLOR_ACCENT : COLOR_LABEL;
    uiFillRound(btns[i].x, READER_CTRL_Y, btns[i].w, READER_BTN_H, R_MD, COLOR_CARD, COLOR_BG);
    uiStrokeRound(btns[i].x, READER_CTRL_Y, btns[i].w, READER_BTN_H, R_MD, BORDER_CTRL, c, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(c, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(btns[i].label, btns[i].x + btns[i].w / 2, READER_CTRL_Y + READER_BTN_H / 2);
    tft.setTextDatum(TL_DATUM);
  }
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
// `HISTORY <id> <chat|all> <page|last>`. Every page turn is a round trip - instant over
// USB, and it is what keeps the device from having to hold the whole transcript.
// Full-entry pager. Same shape as the ask reader: page by tapping, PREV/CLOSE/NEXT below.
void drawHistFull() {
  int maxW = tft.width() - 24;
  int textTop = READER_TEXT_TOP;
  int visLines = (READER_CTRL_Y - 8 - textTop) / HIST_LINE_H;
  setUIFont(FONT_CODE);
  int totalLines = countWrappedLines(histFull, FONT_CODE, maxW);
  int pages = (totalLines + visLines - 1) / visLines;
  if (pages < 1) pages = 1;
  if (histFullPage >= pages) histFullPage = pages - 1;
  if (histFullPage < 0) histFullPage = 0;

  tft.fillScreen(COLOR_BG);
  setUIFont(1);
  tft.setTextColor(histRoleColor(histFullRole), COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(histRoleLabel(histFullRole), 12, HIST_HDR_TEXT_Y);
  char pg[12];
  snprintf(pg, sizeof(pg), "%d/%d", histFullPage + 1, pages);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(pg, tft.width() - 12, HIST_HDR_TEXT_Y);
  tft.setTextDatum(TL_DATUM);
  tft.drawFastHLine(0, HIST_RULE_Y, tft.width(), COLOR_LABEL);

  drawWrappedText(histFull, 12, textTop, FONT_CODE, HIST_LINE_H, maxW,
                  histFullPage * visLines, visLines, COLOR_VALUE, COLOR_BG);

  struct { int x, w; const char* label; bool enabled; } btns[3] = {
    {READER_BTN_L_X, READER_BTN_L_W, "< PREV", histFullPage > 0},
    {READER_BTN_M_X, READER_BTN_M_W, "BACK", true},
    {READER_BTN_R_X, READER_BTN_R_W, "NEXT >", histFullPage < pages - 1},
  };
  // Disabled ends grey out (same affordance as the steppers). The label's y comes
  // from READER_BTN_H, not a baked-in half of 42, or a taller chip on a bigger
  // panel would draw its text near the top.
  for (int i = 0; i < 3; i++) {
    uint16_t c = btns[i].enabled ? COLOR_ACCENT : COLOR_LABEL;
    uiFillRound(btns[i].x, READER_CTRL_Y, btns[i].w, READER_BTN_H, R_MD, COLOR_CARD, COLOR_BG);
    uiStrokeRound(btns[i].x, READER_CTRL_Y, btns[i].w, READER_BTN_H, R_MD, BORDER_CTRL, c, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(c, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(btns[i].label, btns[i].x + btns[i].w / 2, READER_CTRL_Y + READER_BTN_H / 2);
    tft.setTextDatum(TL_DATUM);
  }
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
// THE DEVICE TELLS THE HOST HOW BIG ITS READER IS, as a trailing `<cols>x<lines>`
// token, because the host cannot know it and used to assume. host/index.mjs
// paginated against a hardcoded 36 chars / 14 lines - board 1's 216px column and
// 16-row list - so on board 2's 296px column and 23-row list every page would have
// arrived about half full with NOTHING on either side reporting an error: the
// bigger reader would simply have looked like it held less history than board 1's.
//
// Both numbers come off the SAME expressions the drawing code uses, one screen up
// in drawHistory(), rather than from new constants that could drift from it:
//   cols  - the text lane is `tft.width() - 24` and every Cozette 6x13 glyph
//           advances 6px, the identical arithmetic KB_COLS uses.
//   lines - the list runs from HIST_TOP to the scrubber's tap band (HIST_JUMP_Y),
//           stopping 4px clear of it, in HIST_LINE_H rows - the exact bound the
//           row loop breaks on.
// The host applies its own slack on top (its estimate is ceil(len/cols), looser
// than real word wrap), so the slack deliberately does NOT live here.
//
// TRAILING, so it is backward-compatible both ways - the same shape the
// `to=<hostId>` address already uses. An old host destructures three positional
// tokens and ignores a fourth; a new host defaults to 36x16 when the token is
// absent.
//
// BOARD 1 DELIBERATELY DOES NOT SEND IT, and takes a static_assert instead. The
// host's default IS board 1's geometry, so sending it would change nothing on the
// wire - but it WOULD change board 1's binary, which this port has held
// byte-identical through nine tasks. The assert is the better trade anyway: it
// pins the two numbers at COMPILE time, so a future change to board 1's reader
// geometry fails the build instead of silently disagreeing with a default in
// another repo. BOARD_W rather than tft.width() because only the former is a
// constant expression; they are equal at SCREEN_ROTATION 0.
#if BOARD_USES_TFT_ESPI
static_assert((BOARD_W - 24) / 6 == 36,
              "board 1's reader column count no longer matches HIST_LINE_CHARS in "
              "host/index.mjs - either send the budget from this board too, or "
              "update the host's default");
static_assert((HIST_JUMP_Y - 4 - HIST_TOP) / HIST_LINE_H == 16,
              "board 1's reader line count no longer matches HIST_PAGE_LINES in "
              "host/index.mjs - see the note above");
#endif
void requestHistory(int idx, const char* want) {
  if (idx < 0 || idx >= sessionCount) return;
  histPending = true;
#if BOARD_USES_TFT_ESPI
  char line[48];
  snprintf(line, sizeof(line), "HISTORY %s %s %s", sessions[idx].id,
           histChatOnly ? "chat" : "all", want);
#else
  const int cols  = (tft.width() - 24) / 6;
  const int lines = (HIST_JUMP_Y - 4 - HIST_TOP) / HIST_LINE_H;
  char line[64];
  snprintf(line, sizeof(line), "HISTORY %s %s %s %dx%d", sessions[idx].id,
           histChatOnly ? "chat" : "all", want, cols, lines);
#endif
  // Addressed to the session's own Mac - only it holds that transcript, and
  // an unaddressed request would also reach the other Mac, which has no such
  // session and would have nothing useful to reply with anyway.
  sendLineToHost(line, sessions[idx].hostSlot);
}
void openHistory(int idx) {
  if (idx < 0 || idx >= sessionCount) return;
  histActive = true;
  histCount = 0;
  histPages = 1;
  histPage = 0;
  strncpy(histId, sessions[idx].id, sizeof(histId) - 1);
  histId[sizeof(histId) - 1] = '\0';
  requestHistory(idx, "last");   // newest screen first - that is what you came for
  drawHistory();
}
void exitHistory() {
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
}
// Tap map: control bar, then the jump bar, then the body (body = next page, wrapping,
// which is how you skim without reaching for the buttons).
// Every navigation is a request; the host owns the pagination, so the device never has to
// know how long the history is.
void histGoto(int page) {
  if (page < 0) page = 0;
  if (page > histPages - 1) page = histPages - 1;
  if (page == histPage && !histPending) return;
  histPage = page;
  requestHistory(detailIndex, String(page).c_str());
  drawHistory();   // shows "Asking the Mac..." until the page lands
}
bool handleHistoryTouch(int sx, int sy) {
  if (sy <= HIST_CHIP_TAP_H && sx < HIST_CHIP_TAP_W) {   // the filter chip
    histChatOnly = !histChatOnly;
    histCount = 0;
    requestHistory(detailIndex, "last"); // page counts differ per filter: start at newest
    drawHistory();
    return true;
  }
  if (sy >= READER_CTRL_Y) {
    if (sx < HIST_TAP_1) histGoto(histPage - 1);
    else if (sx < HIST_TAP_2) exitHistory();
    else histGoto(histPage + 1);
    return true;
  }
  // The TAP band, not the drawn track - see HIST_JUMP_TAP_H.
  if (sy >= HIST_JUMP_Y && sy < HIST_JUMP_Y + HIST_JUMP_TAP_H && histPages > 1) {
    int trackX = 12, trackW = tft.width() - 24;
    long f = (long) (sx - trackX) * (histPages - 1) / (trackW > 1 ? trackW - 1 : 1);
    histGoto((int) f);
    return true;
  }
  // A tap in the body OPENS the row under the finger, in full. Paging is the buttons and
  // the scrubber - which is the right split, because reading a whole message was the thing
  // the list could not do.
  if (sy > HIST_RULE_Y && histCount > 0 && !histPending) {
    for (int i = 0; i < histCount; i++) {
      if (sy >= histRowY[i] && sy < histRowY[i + 1]) {
        char want[24];
        snprintf(want, sizeof(want), "item:%d", histFrom + i);
        histFull[0] = '\0';
        histFullRole = histRole[i];
        histFullPage = 0;
        histFullActive = true;
        histPending = true;
        requestHistory(detailIndex, want);
        drawHistFull();
        return true;
      }
    }
  }
  return true;
}
bool handleHistFullTouch(int sx, int sy) {
  if (sy >= READER_CTRL_Y) {
    if (sx < HIST_TAP_1) { if (histFullPage > 0) { histFullPage--; drawHistFull(); } }
    else if (sx < HIST_TAP_2) { histFullActive = false; drawHistory(); }
    else { histFullPage++; drawHistFull(); }
    return true;
  }
  if (sy > HIST_RULE_Y) { histFullPage++; drawHistFull(); }   // tap to page, like the ask reader
  return true;
}
void drawReader() {
  if (detailIndex < 0 || detailIndex >= sessionCount) return;
  SessionInfo& s = sessions[detailIndex];
  bool isPerm = strcmp(s.askKind, "perm") == 0;
  bool isPlan = strcmp(s.askKind, "plan") == 0;
  bool isCode = detailLooksLikeCode(s.askKind, s.askDetail);

  uint8_t dFont = isCode ? FONT_CODE : 2;
  int lineH = isCode ? 14 : 18;
  int maxW = tft.width() - 24;
  int textTop = READER_TEXT_TOP;
  int visLines = (READER_CTRL_Y - 8 - textTop) / lineH;
  setUIFont(dFont);
  int totalLines = countWrappedLines(s.askDetail, dFont, maxW);
  int pages = (totalLines + visLines - 1) / visLines;
  if (pages < 1) pages = 1;
  if (readerPage >= pages) readerPage = pages - 1;
  if (readerPage < 0) readerPage = 0;

  tft.fillScreen(COLOR_BG);
  setUIFont(1);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  char hdr[44];
  snprintf(hdr, sizeof(hdr), "%s - %s", s.name, isPerm ? "COMMAND" : (isPlan ? "PLAN" : "QUESTION"));
  tft.drawString(hdr, 12, HIST_HDR_TEXT_Y);
  char pg[10];
  snprintf(pg, sizeof(pg), "%d/%d", readerPage + 1, pages);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(pg, tft.width() - 12, HIST_HDR_TEXT_Y);
  tft.setTextDatum(TL_DATUM);
  tft.drawFastHLine(0, HIST_RULE_Y, tft.width(), COLOR_LABEL);

  drawWrappedText(s.askDetail, 12, textTop, dFont, lineH, maxW,
                  readerPage * visLines, visLines, COLOR_VALUE, COLOR_BG);

  // Control bar: disabled ends grey out (same affordance as the steppers).
  struct { int x, w; const char* label; bool enabled; } btns[3] = {
    {READER_BTN_L_X, READER_BTN_L_W, "< PREV", readerPage > 0},
    {READER_BTN_M_X, READER_BTN_M_W, "CLOSE", true},
    {READER_BTN_R_X, READER_BTN_R_W, "NEXT >", readerPage < pages - 1},
  };
  // Disabled ends grey out (same affordance as the steppers). The label's y comes
  // from READER_BTN_H, not a baked-in half of 42, or a taller chip on a bigger
  // panel would draw its text near the top.
  for (int i = 0; i < 3; i++) {
    uint16_t c = btns[i].enabled ? COLOR_ACCENT : COLOR_LABEL;
    uiFillRound(btns[i].x, READER_CTRL_Y, btns[i].w, READER_BTN_H, R_MD, COLOR_CARD, COLOR_BG);
    uiStrokeRound(btns[i].x, READER_CTRL_Y, btns[i].w, READER_BTN_H, R_MD, BORDER_CTRL, c, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(c, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(btns[i].label, btns[i].x + btns[i].w / 2, READER_CTRL_Y + READER_BTN_H / 2);
    tft.setTextDatum(TL_DATUM);
  }
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
// Back to the ask screen (reader covered the tab bar and footer too).
void exitReader() {
  readerActive = false;
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  if (showingDetail && detailIndex >= 0 && detailIndex < sessionCount) {
    drawSessionDetail(detailIndex);
    buildDetailSignature(detailIndex, detailSigCache, sizeof(detailSigCache));
  }
  renderFooter();
}
// The ask vanished (answered elsewhere / timed out) while reading: land on
// the sessions list rather than a dead ask screen.
void exitReaderToList() {
  readerActive = false;
  showingDetail = false;
  detailIndex = -1;
  tft.fillScreen(COLOR_BG);
  drawTabBar();
  drawFooterChrome();
  drawSessionsAll();
  renderFooter();
}
void handleReaderTouch(int sx, int sy) {
  if (sy >= READER_CTRL_Y) {
    if (sx < READER_TAP_1) {
      if (readerPage > 0) {
        readerPage--;
        drawReader();
      }
    } else if (sx < READER_TAP_2) {
      exitReader();
    } else {
      readerPage++;
      drawReader(); // clamps at the last page
    }
    return;
  }
  // Tapping the text itself advances too - the natural ebook gesture - but
  // the buttons remain the visible, discoverable path.
  readerPage++;
  drawReader();
}
