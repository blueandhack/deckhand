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
  int chipW = histChatOnly ? 40 : 32;
  uiFillRound(10, 4, chipW, 17, 3, COLOR_ACCENT, COLOR_BG);
  setUIFont(1);
  tft.setTextColor(COLOR_BG, COLOR_ACCENT);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(chip, 10 + chipW / 2, 13);
  tft.setTextDatum(TL_DATUM);
  setUIFont(1);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  char hdr[40];
  snprintf(hdr, sizeof(hdr), "%s", s.name);
  tft.drawString(hdr, 10 + chipW + 8, 8);
  // Position in the WHOLE history, not just the page number - with hundreds of pages,
  // "412/628 entries" is what tells you where you are.
  char pg[20];
  if (histPending) snprintf(pg, sizeof(pg), "...");
  else if (histTotal > 0) snprintf(pg, sizeof(pg), "%d/%d", histFrom + 1, histTotal);
  else snprintf(pg, sizeof(pg), "%d/%d", histPage + 1, histPages);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(pg, tft.width() - 12, 8);
  tft.setTextDatum(TL_DATUM);
  tft.drawFastHLine(0, 22, tft.width(), COLOR_LABEL);

  if (histPending || histCount == 0) {
    setUIFont(2);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(histPending ? "Asking the Mac..." : "Nothing here", tft.width() / 2, 130);
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
    tft.fillRect(trackX, HIST_JUMP_Y, trackW, HIST_JUMP_H, COLOR_CARD);
    tft.drawRect(trackX, HIST_JUMP_Y, trackW, HIST_JUMP_H, COLOR_LABEL);
    int knobW = trackW / histPages;
    if (knobW < 6) knobW = 6;
    int kx = trackX + (long) (trackW - knobW) * histPage / (histPages - 1);
    tft.fillRect(kx, HIST_JUMP_Y + 1, knobW, HIST_JUMP_H - 2, COLOR_ACCENT);
  }

  struct { int x, w; const char* label; bool enabled; } btns[3] = {
    {8, 70, "< PREV", histPage > 0},
    {86, 68, "CLOSE", true},
    {162, 70, "NEXT >", histPage < histPages - 1},
  };
  for (int i = 0; i < 3; i++) {
    uint16_t c = btns[i].enabled ? COLOR_ACCENT : COLOR_LABEL;
    uiFillRound(btns[i].x, READER_CTRL_Y, btns[i].w, 42, R_MD, COLOR_CARD, COLOR_BG);
    uiStrokeRound(btns[i].x, READER_CTRL_Y, btns[i].w, 42, R_MD, BORDER_CTRL, c, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(c, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(btns[i].label, btns[i].x + btns[i].w / 2, READER_CTRL_Y + 21);
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
  int textTop = 30;
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
  tft.drawString(histRoleLabel(histFullRole), 12, 8);
  char pg[12];
  snprintf(pg, sizeof(pg), "%d/%d", histFullPage + 1, pages);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(pg, tft.width() - 12, 8);
  tft.setTextDatum(TL_DATUM);
  tft.drawFastHLine(0, 22, tft.width(), COLOR_LABEL);

  drawWrappedText(histFull, 12, textTop, FONT_CODE, HIST_LINE_H, maxW,
                  histFullPage * visLines, visLines, COLOR_VALUE, COLOR_BG);

  struct { int x, w; const char* label; bool enabled; } btns[3] = {
    {8, 70, "< PREV", histFullPage > 0},
    {86, 68, "BACK", true},
    {162, 70, "NEXT >", histFullPage < pages - 1},
  };
  for (int i = 0; i < 3; i++) {
    uint16_t c = btns[i].enabled ? COLOR_ACCENT : COLOR_LABEL;
    uiFillRound(btns[i].x, READER_CTRL_Y, btns[i].w, 42, R_MD, COLOR_CARD, COLOR_BG);
    uiStrokeRound(btns[i].x, READER_CTRL_Y, btns[i].w, 42, R_MD, BORDER_CTRL, c, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(c, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(btns[i].label, btns[i].x + btns[i].w / 2, READER_CTRL_Y + 21);
    tft.setTextDatum(TL_DATUM);
  }
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
void requestHistory(int idx, const char* want) {
  if (idx < 0 || idx >= sessionCount) return;
  histPending = true;
  char line[48];
  snprintf(line, sizeof(line), "HISTORY %s %s %s", sessions[idx].id,
           histChatOnly ? "chat" : "all", want);
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
  if (sy <= 24 && sx < 76) {             // the filter chip
    histChatOnly = !histChatOnly;
    histCount = 0;
    requestHistory(detailIndex, "last"); // page counts differ per filter: start at newest
    drawHistory();
    return true;
  }
  if (sy >= READER_CTRL_Y) {
    if (sx < 78) histGoto(histPage - 1);
    else if (sx < 156) exitHistory();
    else histGoto(histPage + 1);
    return true;
  }
  if (sy >= HIST_JUMP_Y && sy < HIST_JUMP_Y + HIST_JUMP_H && histPages > 1) {
    int trackX = 12, trackW = tft.width() - 24;
    long f = (long) (sx - trackX) * (histPages - 1) / (trackW > 1 ? trackW - 1 : 1);
    histGoto((int) f);
    return true;
  }
  // A tap in the body OPENS the row under the finger, in full. Paging is the buttons and
  // the scrubber - which is the right split, because reading a whole message was the thing
  // the list could not do.
  if (sy > 22 && histCount > 0 && !histPending) {
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
    if (sx < 78) { if (histFullPage > 0) { histFullPage--; drawHistFull(); } }
    else if (sx < 156) { histFullActive = false; drawHistory(); }
    else { histFullPage++; drawHistFull(); }
    return true;
  }
  if (sy > 22) { histFullPage++; drawHistFull(); }   // tap to page, like the ask reader
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
  int textTop = 30;
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
  tft.drawString(hdr, 12, 8);
  char pg[10];
  snprintf(pg, sizeof(pg), "%d/%d", readerPage + 1, pages);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(pg, tft.width() - 12, 8);
  tft.setTextDatum(TL_DATUM);
  tft.drawFastHLine(0, 22, tft.width(), COLOR_LABEL);

  drawWrappedText(s.askDetail, 12, textTop, dFont, lineH, maxW,
                  readerPage * visLines, visLines, COLOR_VALUE, COLOR_BG);

  // Control bar: disabled ends grey out (same affordance as the steppers).
  struct { int x, w; const char* label; bool enabled; } btns[3] = {
    {8, 70, "< PREV", readerPage > 0},
    {86, 68, "CLOSE", true},
    {162, 70, "NEXT >", readerPage < pages - 1},
  };
  for (int i = 0; i < 3; i++) {
    uint16_t c = btns[i].enabled ? COLOR_ACCENT : COLOR_LABEL;
    uiFillRound(btns[i].x, READER_CTRL_Y, btns[i].w, 42, R_MD, COLOR_CARD, COLOR_BG);
    uiStrokeRound(btns[i].x, READER_CTRL_Y, btns[i].w, 42, R_MD, BORDER_CTRL, c, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(c, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString(btns[i].label, btns[i].x + btns[i].w / 2, READER_CTRL_Y + 21);
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
    if (sx < 82) {
      if (readerPage > 0) {
        readerPage--;
        drawReader();
      }
    } else if (sx < 158) {
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
