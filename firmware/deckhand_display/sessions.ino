// Sessions tab: the row list, the detail screen, and the ask/answer screen.
// Split out of deckhand_display.ino - see pairing.ino for how the concatenated
// build works and what may not move.

bool sessionRowsLarge() { return sessionRowH >= 56; }
void drawChevron(int rightX, int cy, uint16_t color = COLOR_LABEL) {
  tft.fillTriangle(rightX - 8, cy - 5, rightX - 8, cy + 5, rightX - 2, cy, color);
}
// How long a session has been in its current status. Minutes granularity
// past the first minute keeps the field from churning; seconds early on
// make a fresh status change visibly "new".
void formatDuration(unsigned long sinceMillis, char* buf, size_t n) {
  unsigned long sec = (millis() - sinceMillis) / 1000;
  if (sec < 60) snprintf(buf, n, "%lus", sec);
  else if (sec < 3600) snprintf(buf, n, "%lum", sec / 60);
  else snprintf(buf, n, "%luh%02lum", sec / 3600, (sec / 60) % 60);
}
// "sonnet-5 (main)" - model with the redundant "claude-" prefix stripped,
// branch in parens. Either half may be missing. Takes an index rather than
// a SessionInfo& because Arduino's auto-generated prototypes land before
// the struct definition (same reason enum Tab is declared so early).
void buildSessionSubline(int i, char* out, size_t n) {
  const SessionInfo& s = sessions[i];
  const char* model = s.model;
  if (strncmp(model, "claude-", 7) == 0) model += 7;
  // Which agent, spelled out, on every row. The list mixes Claude Code and Codex,
  // and 3 characters of model text is a fair price for never having to guess. It is
  // deliberately TEXT and not a colour or an icon: it has to survive a model rename
  // and stay readable for a colourblind user, same rule as the status shapes.
  const char* tag = strcmp(s.agent, "cx") == 0 ? "CX" : "CC";
  // Which MAC, on the same principle as which AGENT: text, never a colour or
  // an icon - it has to survive a rename and stay readable for a colourblind
  // user. "/" and not a middle dot - Cozette is ASCII 0x20-0x7E only, and
  // U+00B7 would draw as a blank box. dispMacTag() already returns "" unless
  // a second Mac is actually talking to us, so "who" collapses to the plain
  // CC/CX tag in the ordinary single-Mac case, unchanged from before.
  char who[12];
  const char* mac = dispMacTag(s.hostSlot);
  if (*mac) snprintf(who, sizeof(who), "%s/%s", tag, mac);
  else      snprintf(who, sizeof(who), "%s", tag);
  if (model[0] && s.branch[0]) snprintf(out, n, "%s %s (%s)", who, model, s.branch);
  else if (model[0]) snprintf(out, n, "%s %s", who, model);
  else if (s.branch[0]) snprintf(out, n, "%s (%s)", who, s.branch);
  else snprintf(out, n, "%s", who);
}
// Status pill: visual weight matches urgency. "asking" = solid filled pill
// (the loudest element on the tab - Claude is blocked on you), "waiting" =
// outlined pill (turn done, ready when you are), "working" = plain dim text
// with no box - a healthy busy session shouldn't compete for attention.
// Fill/outline/none is a luminance-and-shape code, readable under any color
// vision; hue is reinforcement only.
void drawStatusPill(int xEdge, int y, const char* label, const char* status, bool rightAlign) {
  bool working = strcmp(status, "working") == 0;
  bool asking = strcmp(status, "asking") == 0;
  uint16_t color = colorForStatus(status);
  setUIFont(2);
  int w = tft.textWidth(label) + 12;
  int x = rightAlign ? xEdge - w : xEdge;
  if (asking) {
    // Pills sit on a row/card surface, never on the page background.
    uiFillRound(x, y, w, 18, 9, color, COLOR_CARD);
    tft.setTextColor(COLOR_BG, color);
  } else if (working) {
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  } else {
    uiStrokeRound(x, y, w, 18, 9, BORDER_CTRL, color, COLOR_CARD);
    tft.setTextColor(color, COLOR_CARD);
  }
  tft.setTextDatum(MC_DATUM);
  tft.drawString(label, x + w / 2, y + 9);
  tft.setTextDatum(TL_DATUM);
}
// Fit `src` into maxW pixels at the CURRENTLY SET font/size, trimming with "..." when
// it cannot fit whole. The caller must setUIFont() first, because textWidth() measures
// the active font - measuring in one size and drawing in another is the bug this
// signature is shaped to prevent.
//
// Three ASCII dots, not a real ellipsis: Cozette6x13 carries printable ASCII
// 0x20-0x7E only, so U+2026 would render as a blank box.
void fitText(char* out, size_t outSize, const char* src, int maxW) {
  snprintf(out, outSize, "%s", src);
  if (tft.textWidth(out) <= maxW) return;
  // Longest prefix whose text-plus-dots still fits. Walked down a character at a time
  // rather than divided by an assumed character width: that assumption is exactly what
  // made the old fixed 11/12-char cap wrong for a proportionally-measured lane.
  for (int n = (int) strlen(src) - 1; n >= 0; n--) {
    char probe[40];
    snprintf(probe, sizeof(probe), "%.*s...", n, src);
    if (tft.textWidth(probe) <= maxW) {
      snprintf(out, outSize, "%s", probe);
      return;
    }
  }
  out[0] = '\0'; // nothing fits at all
}
// pos is the DISPLAY POSITION (what the row's on-screen y comes from); the
// underlying array index - which may differ once two Macs are merged and
// reordered - is resolved through sessionAt(pos) and used for every read of
// session data.
void drawSessionRow(int pos) {
  int rowH = sessionRowH;
  bool large = sessionRowsLarge();
  int y = SESSION_ROW_Y0 + pos * (rowH + SESSION_ROW_GAP);
  int i = sessionAt(pos);
  const SessionInfo& s = sessions[i];
  bool working = strcmp(s.status, "working") == 0;
  uint16_t color = colorForStatus(s.status);

  uiFillRound(SESSION_ROW_X, y, SESSION_ROW_W, rowH, R_MD, COLOR_CARD, COLOR_BG);
  // Working rows get a quiet grey border; colored borders are reserved for
  // the two states that want the user's eyes.
  uint16_t border = working ? COLOR_LABEL : color;
  // One even 2px ring; two nested outlines leave holes where their arcs collide.
  uiStrokeRound(SESSION_ROW_X, y, SESSION_ROW_W, rowH, R_MD, BORDER_CARD, border, COLOR_BG);

  // +23, not +20. The working spinner is a 32x32 BLIT - it paints a full
  // rectangle, background pixels included - so its left edge must clear the
  // row's rounded corner. At +20 the rect started at x=12 while the corner's 2px
  // border reaches x~12.9 on the spinner's topmost row, so the blit's COLOR_CARD
  // background erased a bite out of the border. On LIGHT, where COLOR_CARD is
  // white, that read as a white notch in the card's rounded corner.
  // At +23 the rect is x 15..46: 2.1px clear of the border, and 2px short of the
  // name lane at x=48. The dot and square states move with it so the indicator
  // never jumps sideways when a session changes status.
  int dotCy = large ? y + 19 : y + rowH / 2;
  drawStatusDot(SESSION_DOT_CX, dotCy, large ? 9 : 7, s.status, COLOR_CARD,
                strcmp(s.agent, "cx") == 0);

  // ---- Name: MEASURE the lane, then shrink one step rather than truncate ----
  // The lane's right bound is whatever else sits at the top of the row: the
  // CLAUDE/CODEX tag on tall rows, the status pill on compact ones. Both labels vary in
  // width ("WORKING" is 2 characters wider than "READY", "CODEX" one narrower than
  // "CLAUDE"), so the bound is computed from the real text. The old code assumed a flat
  // 11/12 characters, which was far too conservative on compact rows - they had room for
  // about 19 and were throwing half of it away.
  // Does this row carry a title line? Decided BEFORE the name is drawn, because it
  // shifts the name up to make room.
  bool showTitle = large && rowH >= SESSION_TITLE_MIN_H && s.title[0];

  const int nameX = SESSION_ROW_X + 40;
  // Built ONCE, then both DRAWN (below) and MEASURED (laneRight, right here) from this
  // same buffer - a tag measured from one string and drawn from another is exactly the
  // 8px overlap the measured lane was written to fix. Mac tag on the same principle as
  // the CC/CX one: text, never colour or an icon, "/" not a middle dot (Cozette is ASCII
  // 0x20-0x7E only), and dispMacTag() gates on a second Mac actually being present so
  // the ordinary single-Mac case is unchanged.
  char agentTag[24];
  int rowEmoji = emojiIdForLink(s.hostSlot);
  {
    const char* base = strcmp(s.agent, "cx") == 0 ? "CODEX" : "CLAUDE";
    const char* mac = dispMacTag(s.hostSlot);
    // With an icon, the agent word stays TEXT (that rule is explicit: which agent must
    // survive a model rename and be readable to a colourblind user) and the icon
    // replaces the Mac's text. Without one, nothing changes.
    if (rowEmoji >= 0)   snprintf(agentTag, sizeof(agentTag), "%s", base);
    else if (*mac)       snprintf(agentTag, sizeof(agentTag), "%s/%s", base, mac);
    else                 snprintf(agentTag, sizeof(agentTag), "%s", base);
  }
  const char* pillLbl =
      working ? "WORKING" : (strcmp(s.status, "asking") == 0 ? "INPUT" : "READY");
  setUIFont(1); // both blockers render at size 1, so measure them there
  // 4px gap plus the icon, when there is one - the same rule everywhere.
  const int tagExtra = rowEmoji >= 0 ? 4 + MAC_EMOJI_SIZE : 0;
  int laneRight = large
      ? SESSION_ROW_X + SESSION_ROW_W - 12 - tft.textWidth(agentTag) - tagExtra
      : SESSION_ROW_X + SESSION_ROW_W - 16 - (tft.textWidth(pillLbl) + 12); // pill = text + 12
  int laneW = laneRight - nameX - 6; // 6px so the name never kisses the tag/pill

  // Three rungs, largest first: 12x26 -> 10x18 -> 6x13, taking the first whose
  // measured width fits the lane, so a long project name is shown WHOLE rather
  // than cut short. Before T_HEAD existed this was a single 26->13 cliff.
  // Compact rows start at the bottom rung, exactly as they always have: 26px
  // does not fit a 41-63px row.
  static const uint8_t NAME_RUNGS[] = { T_HERO, T_HEAD, T_BODY };
  char nameBuf[28]; // host caps the name at 22, plus "..." and a NUL
  uint8_t nameFont = T_BODY;
  for (int r = large ? 0 : 2; r < 3; r++) {
    nameFont = NAME_RUNGS[r];
    setUIFont(nameFont);
    if (tft.textWidth(s.name) <= laneW) break;
  }
  fitText(nameBuf, sizeof(nameBuf), s.name, laneW);
  if (nameBuf[0] == '\0' && nameFont != T_BODY) {
    // fitText gives up entirely when not even one character plus "..." fits.
    // That is reachable at 10px in a narrow lane where it never was at 6px, so
    // fall to the smallest rung rather than render a blank name.
    nameFont = T_BODY;
    setUIFont(nameFont);
    fitText(nameBuf, sizeof(nameBuf), s.name, laneW);
  }
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  // A shrunk name is centred in the 26px band the big font would have filled, so
  // it doesn't hang off the top of the row with a gap under it. The old hardcoded
  // +6 was exactly this: (26 - 13) / 2. A title row starts 2px higher to buy the
  // third line its space.
  int nameTop = y + (showTitle ? 4 : 6);
  int nameOffset = large ? (uiLineH(T_HERO) - uiLineH(nameFont)) / 2 : 0;
  tft.drawString(nameBuf, nameX, nameTop + nameOffset);

  // 36, not 26: buildSessionSubline's "who" can now be "CC/studio" (9 chars) instead of
  // just "CC", and "CC/studio opus-5 (main)" runs to 23 - still comfortably inside 36.
  char sub[36];
  buildSessionSubline(i, sub, sizeof(sub));
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);

  if (large) {
    // Tall row: name line, optional title line, optional model/branch line, then a
    // status line with the pill on the left and the live duration on the right.
    if (showTitle) {
      // What the session is ABOUT, one step brighter than the model/branch line beneath
      // it: more important than the metadata, less than the project name above.
      // The lane runs to the row's right edge - nothing shares this y.
      char titleBuf[48];
      setUIFont(2);
      fitText(titleBuf, sizeof(titleBuf), s.title,
              SESSION_ROW_X + SESSION_ROW_W - 12 - nameX);
      tft.setTextColor(COLOR_VALUE, COLOR_CARD);
      tft.drawString(titleBuf, nameX, y + 32);
      tft.setTextColor(COLOR_LABEL, COLOR_CARD); // restore for the sub-line below
      // Bound to the sub-line's own lane (x=48 to the row's right edge, 184px = 30
      // characters at Cozette's 6px advance) - a long branch name plus a Mac tag could
      // otherwise run past the row.
      if (sub[0]) {
        char subFit[36];
        fitText(subFit, sizeof(subFit), sub, 184);
        tft.drawString(subFit, nameX, y + 47);
      }
    } else if (rowH >= 70 && sub[0]) {
      char subFit[36];
      fitText(subFit, sizeof(subFit), sub, 184);
      tft.drawString(subFit, SESSION_ROW_X + 40, y + 34);
    }
    // Tall rows keep the top-right corner free (their pill sits at the bottom), so
    // the agent gets its full name there - and it still shows on the 56..69px rows
    // where the sub-line above is suppressed to clear the pill. Drawn from the SAME
    // agentTag buffer the name lane was measured against above.
    const int tagRight = SESSION_ROW_X + SESSION_ROW_W - 12;
    tft.setTextDatum(TR_DATUM);
    if (rowEmoji >= 0) {
      // y + 8 for both: the icon's y is the text's y, because both are 13px.
      drawEmoji(rowEmoji, tagRight - MAC_EMOJI_SIZE, y + 8, COLOR_CARD);
      tft.drawString(agentTag, tagRight - MAC_EMOJI_SIZE - 4, y + 8);
    } else {
      tft.drawString(agentTag, tagRight, y + 8);
    }
    tft.setTextDatum(TL_DATUM);
    const char* label = working ? "WORKING" : (strcmp(s.status, "asking") == 0 ? "NEEDS INPUT" : "READY");
    // 22 rather than 24 on a title row: the sub-line now ends at y+60, and the extra 2px
    // is what keeps the pill clear of it at the 86px height three sessions produce.
    drawStatusPill(SESSION_ROW_X + 40, y + rowH - (showTitle ? 22 : 24), label, s.status, false);
  } else {
    // NOT the 184px lane the tall-row sites use: on a compact row the duration
    // ("10s"/"4m") is drawn at this SAME y (y+25 - see the drawIfChanged call for
    // rowDurCache below), and drawIfChanged clears a box around it on EVERY tick,
    // independent of whether this row is due to repaint. Before the Mac tag, the
    // sub-line ("CC opus-5 (main)") never reached that box; "CC/studio opus-5
    // (multi-host)" does, and the duration's periodic clear was found eating its
    // tail live on the device - "CC/mac opus-5 (multi-" with the rest gone and no
    // "..." (fitText never truncated it; something drawn AFTER it did). The
    // duration is right-aligned to x=SESSION_ROW_X+SESSION_ROW_W-16 and padded to
    // 7 characters, so its clear box's left edge is measured (not hardcoded, in
    // case the font or padding ever changes) rather than assumed.
    if (sub[0]) {
      int durBoxLeft = SESSION_ROW_X + SESSION_ROW_W - 16 - tft.textWidth("0000000") - 1;
      int subMaxW = durBoxLeft - (SESSION_ROW_X + 40) - 4; // 4px so it never kisses that box
      char subFit[36];
      fitText(subFit, sizeof(subFit), sub, subMaxW);
      tft.drawString(subFit, SESSION_ROW_X + 40, y + 25);
    }
    const char* label = working ? "WORKING" : (strcmp(s.status, "asking") == 0 ? "INPUT" : "READY");
    drawStatusPill(SESSION_ROW_X + SESSION_ROW_W - 16, y + 4, label, s.status, true);
  }

  // Accent chevron on asking rows: the tap doesn't just show detail there,
  // it opens the answer screen.
  drawChevron(SESSION_ROW_X + SESSION_ROW_W, y + rowH / 2,
              strcmp(s.status, "asking") == 0 ? COLOR_ACCENT : COLOR_LABEL);
}
void renderSessionsList() {
  int hiddenCount = sessionsTotal - sessionCount;
  if (hiddenCount < 0) hiddenCount = 0;
  int layoutCode = sessionCount * 2 + (hiddenCount > 0 ? 1 : 0);
  if (layoutCode != rowCountCache) {
    rowCountCache = layoutCode;
    if (sessionCount > 0) {
      // The overflow strip ("+N more") takes the bottom 16px when present.
      int avail = contentBottom() - SESSION_ROW_Y0 - (hiddenCount > 0 ? 16 : 0);
      // Cap raised 72 -> 90 so a row can carry a THIRD line (the session title) without
      // pushing the model/branch line out. Measured against the real content area
      // (avail = 264): 1-2 sessions land on the 90 cap and 3 comes out at 86, all of
      // which clear SESSION_TITLE_MIN_H; 4+ are unchanged at 63/50/41 and keep today's
      // two-line layout.
      sessionRowH = constrain(
          (avail - SESSION_ROW_GAP * (sessionCount - 1)) / sessionCount, 38, 90);
    }
    tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
    for (int i = 0; i < MAX_SESSIONS; i++) rowSigCache[i][0] = '\0';
    overflowCache[0] = '\0';
    if (sessionCount == 0) {
      int cy = (CONTENT_Y + contentBottom()) / 2 - 20;
      drawSparkle(tft.width() / 2, cy, 10, COLOR_LABEL);
      setUIFont(2);
      tft.setTextColor(COLOR_LABEL, COLOR_BG);
      tft.setTextDatum(MC_DATUM);
      tft.drawString("No active Claude Code sessions", tft.width() / 2, cy + 30);
      tft.setTextDatum(TL_DATUM);
    }
  }
  for (int pos = 0; pos < sessionCount; pos++) {
    int i = sessionAt(pos);
    // rowSigCache is keyed by DISPLAY POSITION, which is what it has always
    // been - so pass pos where the cache is indexed and i where the row's data
    // is read.
    char sub[36];
    buildSessionSubline(i, sub, sizeof(sub));
    // The TITLE belongs in this signature. Leave it out and a row keeps showing the old
    // title forever, because nothing else about the row changed - the exact silent
    // staleness the change-only redraw discipline is prone to. 160 because a 40-char
    // title no longer fits alongside the rest in 96.
    //
    // The Mac TAG belongs here too, and for a sharper reason than staleness: two
    // sessions with an identical name|status|sub|title at the same display position on
    // DIFFERENT Macs would compare equal and never repaint at all, so the row would go
    // on showing whichever Mac's tag was drawn first rather than the one it now actually
    // belongs to. dispMacTag() (not a bare hostSlot int) is what's compared, because
    // that's the value actually drawn - it's also what makes a usedLinkCount() flip
    // (second Mac connects/drops) repaint every row: dispMacTag() changes for every
    // session at once even though no session's own data did. 176 because the tag adds
    // up to 7 chars plus a separator - see the rowSigCache declaration.
    // The icon id belongs here too, for the same staleness reason as the tag: a row
    // whose Mac's icon changes (or appears/disappears) has none of its other fields
    // change, so without this it would keep drawing the old icon (or the old text
    // tag) forever.
    char sig[176];
    snprintf(sig, sizeof(sig), "%s|%s|%s|%s|%s|%d", sessions[i].name, sessions[i].status, sub,
             sessions[i].title, dispMacTag(sessions[i].hostSlot), emojiIdForLink(sessions[i].hostSlot));
    if (strncmp(sig, rowSigCache[pos], sizeof(rowSigCache[pos])) != 0) {
      strncpy(rowSigCache[pos], sig, sizeof(rowSigCache[pos]) - 1);
      rowSigCache[pos][sizeof(rowSigCache[pos]) - 1] = '\0';
      drawSessionRow(pos); // resolves i = sessionAt(pos) itself, for the row's own y
      rowDurCache[pos][0] = '\0'; // row was repainted, duration must redraw too
    }
    char dur[8];
    formatDuration(sessions[i].statusSinceMillis, dur, sizeof(dur));
    padLeftTo(dur, sizeof(dur), 7);
    int y = SESSION_ROW_Y0 + pos * (sessionRowH + SESSION_ROW_GAP);
    int durY = sessionRowsLarge() ? y + sessionRowH - 19 : y + 25;
    drawIfChanged(rowDurCache[pos], sizeof(rowDurCache[pos]), dur,
                  SESSION_ROW_X + SESSION_ROW_W - 16, durY, 1, 1,
                  COLOR_LABEL, COLOR_CARD, TR_DATUM);
  }

  // Truncation must never be silent: say how many sessions didn't fit, and
  // shout if any of them needs input (only possible with 7+ asking at once,
  // since the host sorts asking sessions to the top).
  if (hiddenCount > 0) {
    char buf[32];
    if (hiddenAskingCount > 0) {
      snprintf(buf, sizeof(buf), "+%d more, %d NEED INPUT", hiddenCount, hiddenAskingCount);
    } else {
      snprintf(buf, sizeof(buf), "+%d more session%s", hiddenCount, hiddenCount == 1 ? "" : "s");
    }
    padTo(buf, sizeof(buf), 26);
    drawIfChanged(overflowCache, sizeof(overflowCache), buf, SESSION_ROW_X + 2,
                  contentBottom() - 12, 1, 1,
                  hiddenAskingCount > 0 ? COLOR_BAD : COLOR_LABEL, COLOR_BG);
  }
}
void drawSessionsAll() {
  rowCountCache = -1;
  renderSessionsList();
}
// Current array index of the session under the detail view, found by its
// stable id, or -1 if it's no longer in the list.
int resolveDetailIndex() {
  if (!detailId[0]) return -1;
  for (int i = 0; i < sessionCount; i++)
    if (strcmp(sessions[i].id, detailId) == 0) return i;
  return -1;
}
void renderSessionsTab() {
  if (showingDetail) {
    detailIndex = resolveDetailIndex(); // re-anchor after any reorder
    if (detailIndex >= 0 && detailIndex < sessionCount) {
      // A remote answer was accepted (the ask vanished from the feed):
      // the job here is done, return to the list automatically.
      if (answeredPid[0] && !sessions[detailIndex].askPid[0]) {
        answeredPid[0] = '\0';
        answeredIdx = -1;
        answeredHostSlot = -1;
        closeSessionDetail();
        return;
      }
      // Sized to match detailSigCache, not a smaller guess: a local scratch
      // buffer shorter than the signature it builds truncates silently, the
      // same trap detailDurCache/detailSigCache themselves already document -
      // and buildDetailSignature's own worst case (title 43 + prompt 103 +
      // the rest) already runs close to 208.
      char sig[sizeof(detailSigCache)];
      buildDetailSignature(detailIndex, sig, sizeof(sig));
      if (strncmp(sig, detailSigCache, sizeof(detailSigCache)) != 0) {
        strncpy(detailSigCache, sig, sizeof(detailSigCache) - 1);
        detailSigCache[sizeof(detailSigCache) - 1] = '\0';
        drawSessionDetail(detailIndex);
      }
      renderDetailDuration();
    } else {
      // The session under the detail view ended - fall back to the list
      // instead of leaving a stale snapshot on screen.
      closeSessionDetail();
    }
    return;
  }
  renderSessionsList();
}
// ---------- Session detail screen ----------
void buildDetailSignature(int idx, char* out, size_t outSize) {
  // title and prompt MUST be here: they are drawn on the static card, so leaving them out
  // means sending a new prompt never repaints the screen you are looking at.
  // actSec deliberately is NOT: it changes on every event, and a full card repaint per
  // tick is exactly the flicker this discipline exists to prevent. It reaches the screen
  // through renderDetailDuration's own per-second cache instead.
  // askVoiceSha MUST be here too, and for the identical reason as title/prompt: a
  // transcript arriving is the ONLY thing that changes when a voice confirm screen
  // is meant to appear (askPid stays the same prompt throughout), so leaving it out
  // means the confirm screen would never actually draw. The hash, not the up-to-204
  // char text it stands for, because it changes if and only if the text does and
  // costs 20 bytes instead of 204 in this signature.
  snprintf(out, outSize, "%s|%s|%s|%s|%s|%s|%d|%s|%s|%ld|%s", sessions[idx].name,
           sessions[idx].status, sessions[idx].path, sessions[idx].model,
           sessions[idx].branch, sessions[idx].askPid, answeredPid[0] ? answeredIdx : -1,
           sessions[idx].title, sessions[idx].prompt, sessions[idx].startSec,
           sessions[idx].askVoiceSha);
  // Whether the TYPE chip is showing MUST be in the signature: a session going
  // READY while you are looking at it changes nothing else on this card, so without
  // this the chip would not appear until something else happened to repaint.
  size_t used = strlen(out);
  if (used + 3 < outSize) snprintf(out + used, outSize - used, "|%c", msgOffered(idx) ? 'M' : '-');
  // The Mac tag MUST be here too, for the identical reason: two sessions can share
  // every other field on this card while living on different Macs, and a
  // usedLinkCount() flip (a second Mac connecting or dropping) changes nothing else
  // about a session already open on screen - dispMacTag() itself is what changes, since
  // its output for the same hostSlot depends on that count. Appended the same way the
  // TYPE-chip flag was, rather than folded into the big snprintf above, to avoid
  // touching that call's field count.
  used = strlen(out);
  if (used + 9 < outSize)
    snprintf(out + used, outSize - used, "|%s", dispMacTag(sessions[idx].hostSlot));
  // The icon id, for the identical reason the tag joined this signature: an
  // icon appearing/disappearing/changing on this session's link changes
  // nothing else the signature above already tracks, so without this the
  // card would keep showing a stale (or missing) icon forever.
  used = strlen(out);
  if (used + 5 < outSize)
    snprintf(out + used, outSize - used, "|%d", emojiIdForLink(sessions[idx].hostSlot));
}
// Index-based (not SessionInfo&) for the same Arduino auto-prototype reason
// as buildSessionSubline.
// True when this ask may be answered by TYPING. Questions only, for the same
// reason voice is: emitDecision discards a plan's text and a permission prompt
// can only be denied. Codex is excluded because REMOTE_WAIT_MS is 15s there
// against 90s for Claude Code - not enough to type a sentence - and offering a
// control that cannot work is exactly what the read-only ask path refuses to do.
bool askTypeOffered(int idx) {
  const SessionInfo& s = sessions[idx];
  return s.askAnswerable && strcmp(s.askKind, "question") == 0 &&
         strcmp(s.agent, "cx") != 0 && !s.askVoiceText[0];
}
// 1 when this ask offers an input row (SPEAK and/or TYPE), 0 otherwise. Used by
// BOTH askOptionsTop() and the draw, so the buttons and their hit tests can never
// disagree about how many rows are in the stack - which is exactly how a fixed
// offset would drift. SPEAK and TYPE SHARE one row (half-width each, the way
// SOUND and NORMAL/FLIPPED share the settings page's bottom row) so adding typing
// costs the options no space at all.
int askInputRows(int idx) {
  const SessionInfo& s = sessions[idx];
  bool speak = s.askVoice && s.askAnswerable && !s.askVoiceText[0];
  return (speak || askTypeOffered(idx)) ? 1 : 0;
}
// ---- TYPE A MESSAGE, on a plain READY detail screen ----
//
// IN THE HEADER ROW, and that is forced rather than chosen. A full-width button
// below the card was the obvious place and there is no such band: the card runs
// 60..284 with its content cursor reaching ~284 in the worst case (title and last
// prompt both present), and the "< Back up top - tap here for history" hint owns
// 285..299 against a contentBottom() of 302. A 32px control below the card would
// therefore either cover the card's own text or replace the only thing that tells
// you the card is tappable. The header row is 26px of otherwise empty space right
// of "< Back", which costs neither.
//
// Gated on the NONCE as well as the status: the host omits pnonce unless the
// session is waiting, and without one the host refuses the frame - so offering the
// button would advertise a control that cannot work, which is exactly what the
// read-only ask path refuses to do when it draws options as a flat list instead.
const int MSG_BTN_W = 76, MSG_BTN_H = 22;
int msgBtnX() { return CARD_X + CARD_W - MSG_BTN_W; }
int msgBtnY() { return CONTENT_Y + 2; }            // 36..58, clear of the card at 60
bool msgOffered(int idx) {
  if (idx < 0 || idx >= sessionCount) return false;
  const SessionInfo& s = sessions[idx];
  return !s.askPid[0] && strcmp(s.status, "waiting") == 0 && s.promptNonce[0];
}

int askOptionsTop(int idx) {
  return contentBottom() -
         (sessions[idx].askOptCount + askInputRows(idx)) * (ASK_OPT_H + ASK_OPT_GAP);
}
// The confirm screen (SEND / RE-RECORD / CANCEL) draws no option buttons - it
// returns early out of drawAskDetail - so its two rows anchor to the bottom of
// the content area rather than to a fixed offset, the same reason
// askOptionsTop() does.
inline int askVoiceRedoY() { return contentBottom() - H_BTN; }
inline int askVoiceSendY() { return askVoiceRedoY() - H_BTN - SP_2; }
// True when the transcript doesn't fit within the confirm screen's line cap -
// the belt-and-braces case the host's 150-byte cap is meant to prevent, but
// that must never be the ONLY thing standing between a person and signing
// text they can't fully see. Shared by the draw and the touch handler so they
// can never disagree about whether SEND is actually offered.
bool askVoiceTooLong(int idx) {
  return countWrappedLines(sessions[idx].askVoiceText, FONT_CODE, CARD_W - 8) > 8;
}
// The answer screen: question title, paged detail text, and one big button
// per option. Tapping an option sends the answer to the host, which hands
// it to the (waiting) session hook to decide the real prompt.
void drawAskDetail(int idx) {
  SessionInfo& s = sessions[idx];
  // hostSlot too, not just the pid - PIDs are per-machine, and matching on
  // askPid alone would show THIS row as already-answered the moment a
  // same-numbered pid on the OTHER Mac was, see answeredHostSlot's comment.
  bool answered = answeredPid[0] && strncmp(answeredPid, s.askPid, sizeof(answeredPid)) == 0 &&
                  (uint8_t) answeredHostSlot == s.hostSlot;
  bool isPerm = strcmp(s.askKind, "perm") == 0;
  bool isPlan = strcmp(s.askKind, "plan") == 0;

  // A transcript is waiting: the screen becomes a confirmation, because the
  // confirm tap IS the authorisation - it signs a hash of exactly this text.
  // This has to run BEFORE the "< Back"/badge header below rather than after
  // it (the header row's text and this screen's own "YOU SAID" label share
  // the same font and the same top-left corner, so stacking under it would
  // overlap rather than read as two lines) - drawSessionDetail already
  // cleared the content area before calling us, same as every other early
  // return in this function.
  if (s.askVoiceText[0]) {
    setUIFont(T_META);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("YOU SAID", CARD_X, CONTENT_Y + 6);
    // Cozette on a panel: this is verbatim quoted text, the same treatment code
    // and commands already get. Cap raised 6 -> 8: at CARD_W-8=208px, Cozette6x13
    // (6px/char) fits 34 chars/line, and the host now caps an answer transcript
    // at 150 UTF-8 bytes (VOICE_ANSWER_TEXT_MAX_BYTES), which needs at most ~5
    // lines even with word-wrap losses - 8 leaves real headroom, and the panel
    // (8*13+12=116px tall) still clears askVoiceSendY() by 34px.
    int lines = countWrappedLines(s.askVoiceText, FONT_CODE, CARD_W - 8);
    if (lines > 8) lines = 8;
    uiFillRound(CARD_X - 4, CONTENT_Y + 22, CARD_W + 8, lines * 13 + 12, R_SM, COLOR_CARD, COLOR_BG);
    drawWrappedText(s.askVoiceText, CARD_X, CONTENT_Y + 28, FONT_CODE, 13, CARD_W - 8,
                    0, lines, COLOR_VALUE, COLOR_CARD);
    // Belt-and-braces: the host's byte cap is meant to guarantee this always
    // fits, but that guarantee must not be the only gate. If it somehow
    // doesn't, never offer SEND for text the user cannot fully see -
    // RE-RECORD and CANCEL still work.
    if (askVoiceTooLong(idx)) {
      tft.setTextColor(COLOR_BAD, COLOR_BG);
      setUIFont(T_META);
      tft.setTextDatum(MC_DATUM);
      tft.drawString("TOO LONG - ANSWER ON YOUR MAC", tft.width() / 2,
                      askVoiceSendY() + H_BTN / 2);
      tft.setTextDatum(TL_DATUM);
    } else {
      uiButton(CARD_X, askVoiceSendY(), CARD_W, H_BTN, "SEND", COLOR_ACCENT, true);
    }
    uiButton(CARD_X, askVoiceRedoY(), (CARD_W - SP_2) / 2, H_BTN, "RE-RECORD", COLOR_LABEL);
    uiButton(CARD_X + (CARD_W + SP_2) / 2, askVoiceRedoY(), (CARD_W - SP_2) / 2, H_BTN,
             "CANCEL", COLOR_LABEL);
    return;
  }

  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  setUIFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("< Back", CARD_X, CONTENT_Y + 4);
  // (READ ALL button lands top-right of this row, drawn below once the
  // overflow question is settled - far away from the decision buttons.)

  // What kind of decision this is, at a glance; session name on the right.
  const char* badge = isPerm ? "PERMISSION REQUEST" : (isPlan ? "PLAN APPROVAL" : "QUESTION");
  setUIFont(1);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.drawString(badge, CARD_X, CONTENT_Y + 27);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(s.name, tft.width() - CARD_X, CONTENT_Y + 27);
  tft.setTextDatum(TL_DATUM);

  // Symmetric text margins: CARD_X on both sides.
  int maxW = tft.width() - 2 * CARD_X;

  // Title (up to 2 lines, font 2, measured wrap).
  int y = drawWrappedText(s.askTitle, CARD_X, CONTENT_Y + 39, 2, 17, maxW, 0, 2,
                          COLOR_VALUE, COLOR_BG);

  // Detail text, styled by content: anything with code - a command, or a
  // question/plan that contains a newline - reads as a code block (monospace
  // font on a card panel, line breaks preserved). Plain single-line prose
  // reads in the bigger proportional font. When it overflows, the READ ALL
  // button (top-right, clear of the decision buttons) opens the reader.
  bool isCode = detailLooksLikeCode(s.askKind, s.askDetail);
  int optTop = askOptionsTop(idx);
  int textTop = y + 4;

  uint8_t dFont = isCode ? FONT_CODE : 2;
  int dLineH = isCode ? 13 : 17;
  int pad = isCode ? 7 : 0;
  int textW = maxW - 2 * pad;
  uint16_t textBg = isCode ? COLOR_CARD : COLOR_BG;

  // Mirror mode adds an "ANSWER ON YOUR MAC" caption above the option list, so
  // the text block has to give up that row - otherwise a detail long enough to
  // fill every visible line runs into it.
  int hintH = s.askAnswerable ? 0 : 14;
  int visLines = (optTop - 8 - hintH - textTop - 2 * pad) / dLineH;
  if (visLines < 1) visLines = 1;
  int totalLines = countWrappedLines(s.askDetail, dFont, textW);
  askOverflow = totalLines > visLines;
  int shown = askOverflow ? visLines : totalLines;
  if (shown < 1) shown = 1;

  if (isCode) {
    uiFillRound(CARD_X - 4, textTop, maxW + 8, shown * dLineH + 2 * pad, R_SM, COLOR_CARD, COLOR_BG);
  }
  drawWrappedText(s.askDetail, CARD_X + pad, textTop + pad, dFont, dLineH, textW,
                  0, visLines, COLOR_VALUE, textBg);

  if (askOverflow) {
    // Cut marker at the preview's edge...
    setUIFont(1);
    tft.setTextColor(COLOR_LABEL, textBg);
    tft.setTextDatum(TR_DATUM);
    tft.drawString("...", tft.width() - CARD_X - pad, textTop + pad + (shown - 1) * dLineH);
    tft.setTextDatum(TL_DATUM);
    // ...and the READ ALL button up in the header row.
    uiFillRound(ASK_READ_BTN_X, CONTENT_Y + 1, ASK_READ_BTN_W, 24, R_SM, COLOR_CARD, COLOR_BG);
    uiStrokeRound(ASK_READ_BTN_X, CONTENT_Y + 1, ASK_READ_BTN_W, 24, R_SM, BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("READ ALL", ASK_READ_BTN_X + ASK_READ_BTN_W / 2, CONTENT_Y + 13);
    tft.setTextDatum(TL_DATUM);
  }

  // MIRROR mode: the Mac owns this decision, so the options are shown as a
  // read-only list - flat rows, no button chrome, no fill - and the row above
  // says where to answer. Drawing them as buttons here would be a lie: the tap
  // handler ignores them, and the Mac's dialog is already waiting for a click.
  if (!s.askAnswerable) {
    setUIFont(1);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("ANSWER ON YOUR MAC", CARD_X, optTop - hintH + 2);
    for (int k = 0; k < s.askOptCount; k++) {
      int by = optTop + k * (ASK_OPT_H + ASK_OPT_GAP);
      // A dim leading bar marks each choice by SHAPE, so the list still reads
      // as a set of options without borrowing the tappable look.
      tft.fillRect(CARD_X, by + ASK_OPT_H / 2 - 1, 8, 2, COLOR_LABEL);
      setUIFont(2);
      tft.setTextColor(COLOR_VALUE, COLOR_BG);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(s.askOpts[k], CARD_X + 16, by + ASK_OPT_H / 2 - 8);
    }
    return;
  }

  // Option buttons, colored by meaning (labels carry it too - color is
  // reinforcement, per the colorblind-safe rule): Allow/Approve blue,
  // Deny in the alert color, neutral question options in accent.
  for (int k = 0; k < s.askOptCount; k++) {
    int by = optTop + k * (ASK_OPT_H + ASK_OPT_GAP);
    bool chosen = answered && k == answeredIdx;
    uint16_t oc = COLOR_ACCENT;
    if ((isPerm || isPlan) && k == 0) oc = COLOR_GOOD;
    else if (isPerm && k == 1) oc = COLOR_BAD;
    uint16_t fill = chosen ? oc : COLOR_CARD;
    uiFillRound(CARD_X, by, CARD_W, ASK_OPT_H, 8, fill, COLOR_BG);
    uiStrokeRound(CARD_X, by, CARD_W, ASK_OPT_H, 8, BORDER_CTRL,
                  answered && !chosen ? COLOR_LABEL : oc, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(chosen ? COLOR_BG : (answered ? COLOR_LABEL : oc), fill);
    tft.setTextDatum(MC_DATUM);
    char label[44]; // room for a 32-char option label + " - sent"
    snprintf(label, sizeof(label), chosen ? "%s - sent" : "%s", s.askOpts[k]);
    tft.drawString(label, tft.width() / 2, by + ASK_OPT_H / 2);
    tft.setTextDatum(TL_DATUM);
  }

  // Voice/type are offered only where free text is actually delivered: a
  // question. A plan's answer text is discarded by the hook and a permission
  // prompt can only be denied, so neither gets this control. It is one more
  // row in the same bottom-anchored stack as the option buttons (askOptionsTop
  // already reserved the room for it via askInputRows), so it can never
  // overlap them regardless of askOptCount.
  if (askInputRows(idx)) {
    const SessionInfo& s = sessions[idx];
    bool speak = s.askVoice && s.askAnswerable && !s.askVoiceText[0];
    bool type  = askTypeOffered(idx);
    int y = contentBottom() - ASK_OPT_H;
    if (speak && type) {
      int halfW = (CARD_W - 8) / 2;
      uiButton(CARD_X, y, halfW, ASK_OPT_H, "SPEAK", COLOR_ACCENT);
      uiButton(CARD_X + halfW + 8, y, halfW, ASK_OPT_H, "TYPE", COLOR_ACCENT);
    } else if (speak) {
      uiButton(CARD_X, y, CARD_W, ASK_OPT_H, "SPEAK YOUR ANSWER", COLOR_ACCENT);
    } else {
      uiButton(CARD_X, y, CARD_W, ASK_OPT_H, "TYPE YOUR ANSWER", COLOR_ACCENT);
    }
  }
}
// Sends `len` bytes over BLE TX in <=20-byte notifies with a breath between
// them. Factored out of sendLineToHost so it can chunk the caller's line and
// the `to=` address suffix as two separate calls, with no fixed intermediate
// buffer for either to outgrow - see the note on sendLineToHost below for why
// a fixed buffer here is exactly the mistake to avoid repeating.
void bleNotifyChunks(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i += 20) {
    size_t n = len - i > 20 ? 20 : len - i;
    bleTxChar->setValue((uint8_t*) (data + i), n);
    bleTxChar->notify();
    delay(12); // give the stack breathing room between notifies
  }
}
// Device -> host, over whichever transports are up. The host maps the short
// id back to the full session and writes the answer file for the hook.
// Both device->host lines go out this way: USB and BLE at once, BLE in <=20-byte
// notifies with a breath between them. Factored out of sendAnswerToHost when the history
// request became a second caller.
//
// `link` = the Mac this line is FOR, or -1 to broadcast. Broadcast is right
// for BATT and HELLO (both menu bars want the battery, and HELLO is how a Mac
// discovers the device at all) and wrong for everything carrying a decision:
// BLECharacteristic::notify() has no single-peer form - it walks every
// connected central and calls esp_ble_gatts_send_indicate per peer, with no
// reference to which connection asked - so an unaddressed ANSWER reaches the
// OTHER Mac too, and it logs an authentication failure on every answer. That
// trains you to ignore the one log line that actually means something.
//
// Chunks `line` and the `to=` suffix DIRECTLY, each in its own buffer sized
// only for what it holds, rather than copying both into one fixed local
// buffer first. A fixed copy buffer here used to be sized 96 (fine for every
// caller at the time: option answers ~53 bytes, voice answers ~77, HISTORY
// ~48), but sendTypedAnswerToHost's ANSWER line carries a full 200-char
// base64 body and can reach ~259 bytes - snprintf into a 96-byte buffer
// silently truncated it AND dropped the trailing '\n' with it, so
// host/index.mjs's BLE line-splitter (which keys on that exact byte) never
// saw a complete line: the answer was lost, the truncated fragment stuck
// around and corrupted the NEXT line, and USB was unaffected (Serial.println
// has no such limit) - so it looked like "typing only fails over Bluetooth",
// and only for longer answers. Chunking the caller's own buffer (and a small
// fixed buffer for the address suffix alone, which can never exceed
// " to=" + a 12-char hostId) removes the ceiling entirely instead of
// re-deriving a bigger number for the next caller to outgrow.
void sendLineToHost(const char* line, int link) {
  const char* to = (link >= 0 && link < MAX_LINKS && hostLinks[link].used)
                     ? hostLinks[link].hostId : "";
  char suffix[20];   // " to=" + up to 12 hostId chars (incl. NUL)
  int sn = *to ? snprintf(suffix, sizeof(suffix), " to=%s", to) : 0;

  Serial.print(line);
  if (sn > 0) Serial.print(suffix);
  Serial.println();

  if (bleConnected && bleTxChar) {
    bleNotifyChunks((const uint8_t*) line, strlen(line));
    if (sn > 0) bleNotifyChunks((const uint8_t*) suffix, (size_t) sn);
    // The newline is what host/index.mjs's bleLineBuf splits on - sent as its
    // own notify so it can never be clipped by either chunk loop above,
    // whatever length `line` or the suffix turn out to be.
    uint8_t nl = '\n';
    bleTxChar->setValue(&nl, 1);
    bleTxChar->notify();
    delay(12);
  }
}
void sendLineToHost(const char* line) { sendLineToHost(line, -1); }
void sendAnswerToHost(int idx, int optIdx) {
  SessionInfo& s = sessions[idx];
  // HMAC over "nonce:pid:idx" proves this answer came from the paired device
  // and pins it to this one prompt (the nonce is single-use host-side). "0"
  // when unprovisioned - the host rejects that in secure mode.
  // Signed with the ROW's Mac (pairingSlotForRow(s.hostSlot)), never
  // activeHost: with two Macs ticking every 5s, "whoever spoke last" is
  // right about half the time, and the wrong half looks like nothing more
  // than an answer that silently didn't take. pairingSlotForRow (not
  // pairingSlotForLink) is what still answers a legacy host that sends no
  // hostId at all - see its comment in pairing.ino.
  char msg[40];
  snprintf(msg, sizeof(msg), "%s:%s:%d", s.askNonce, s.askPid, optIdx);
  String mac = authHmacFor(pairingSlotForRow(s.hostSlot), String(msg));
  if (mac.length() == 0) mac = "0";
  char line[80];
  snprintf(line, sizeof(line), "ANSWER %s %s %d %s", s.id, s.askPid, optIdx, mac.c_str());
  sendLineToHost(line, s.hostSlot);
}
// Signs a hash of the text the screen is SHOWING, not the audio and not an
// index. That single signature carries both facts the host needs: the paired
// device authorised this, and this is the text a human read.
void sendVoiceAnswerToHost(int idx) {
  const SessionInfo& s = sessions[idx];
  if (!s.askVoiceSha[0]) return;
  String payload = String(s.askNonce) + ":" + s.askPid + ":TEXT:" + s.askVoiceSha;
  String mac = authHmacFor(pairingSlotForRow(s.hostSlot), payload);
  // "0" when unprovisioned, matching sendAnswerToHost. Deliberately NOT a silent
  // return: the host logs the rejection, so an unpaired device shows up as a
  // refused answer in the log rather than a SEND button that quietly does
  // nothing.
  if (mac.length() == 0) mac = "0";
  char line[160];
  snprintf(line, sizeof(line), "ANSWER %s %s TEXT %s %s",
           s.id, s.askPid, s.askVoiceSha, mac.c_str());
  sendLineToHost(line, s.hostSlot);
}
// Touch on the detail screen when an ask is showing. Returns true if the
// tap was consumed (option chosen or page flipped); false = treat as back.
bool handleAskTouch(int sx, int sy) {
  if (detailIndex < 0 || detailIndex >= sessionCount) return false;
  SessionInfo& s = sessions[detailIndex];
  // The confirm screen (a transcript pending approval) is modal: it is checked
  // before anything else in this function, and swallows every tap that isn't
  // one of its own three buttons so a stray tap can never fall through to the
  // option buttons underneath and send a DIFFERENT answer.
  if (s.askVoiceText[0]) {
    if (sy >= askVoiceSendY() && sy < askVoiceSendY() + H_BTN) {
      // No SEND button is drawn in the "too long" belt-and-braces case (see
      // drawAskDetail) - mirror that here so a tap in the same rectangle can
      // never sign text the screen didn't actually offer to send.
      if (!askVoiceTooLong(detailIndex)) sendVoiceAnswerToHost(detailIndex);
      return true;
    }
    if (sy >= askVoiceRedoY() && sy < askVoiceRedoY() + H_BTN) {
      if (sx < CARD_X + CARD_W / 2) {          // RE-RECORD
        // Starting a fresh recording is an explicit request to see a new
        // transcript, so any earlier CANCEL suppression for this prompt is
        // spent - otherwise saying the same words again would hash identically
        // and be silently swallowed forever (handleLine suppresses a republish
        // matching this sha).
        s.askVoiceCancelSha[0] = '\0';
        copyField(micAnswerPid, sizeof(micAnswerPid), s.askPid);
        micStream();                 // capped at 20s because micAnswerPid is set
        micAnswerPid[0] = '\0';      // one capture only; never leaks into a dictation
      } else {                                  // CANCEL
        // Remember the rejected hash: the host parks this transcript for up
        // to 5 minutes and keeps republishing it every tick regardless of
        // what we do here, so clearing askVoiceText alone would only last
        // until the next tick silently repopulates it - and a tap on what
        // then looks like a normal option button underneath would send the
        // very answer just rejected. handleLine suppresses any republish
        // carrying this sha; a genuinely new recording gets a different one.
        copyField(s.askVoiceCancelSha, sizeof(s.askVoiceCancelSha), s.askVoiceSha);
        s.askVoiceText[0] = '\0';               // back to the option buttons
        drawAskDetail(detailIndex);
      }
      return true;
    }
    return true;   // modal: swallow everything else (including "< Back")
  }
  if (!s.askPid[0]) {
    // Plain detail screen: ONLY the header's "< Back" goes back. This used to be
    // "tap anywhere", which collided head-on with a recording's "tap anywhere to
    // stop" - ending a dictation also closed the page out from under you. The
    // "< Back" label was already being drawn here, so this simply makes the page
    // behave the way it already looked.
    if (sy < CONTENT_Y + 28) {
      // The whole right end of the header row, not only the drawn 76x22 chip -
      // 100x28 of target, the same trade the tab bar's slots already make.
      // Everything else in this row is still back.
      if (msgOffered(detailIndex) && sx >= msgBtnX() - 24) {
        openKeyboardForMessage(detailIndex);
        return true;
      }
      return false; // header row = back
    }
    // Body opens the HISTORY reader. It used to be inert, which left the most useful
    // thing about a finished session - what it actually did - unreachable from the
    // device. The FAB is hit-tested before this, so dictation still wins its own area.
    openHistory(detailIndex);
    return true;
  }

  int optTop = askOptionsTop(detailIndex);
  // SPEAK/TYPE occupy the same row at the bottom of the stack - test it before
  // the option hit-testing below, at the same y the draw used, so the two can
  // never disagree about where the button is.
  if (askInputRows(detailIndex) && sy >= contentBottom() - ASK_OPT_H) {
    bool speak = s.askVoice && s.askAnswerable && !s.askVoiceText[0];
    bool type  = askTypeOffered(detailIndex);
    int gapX0 = CARD_X + (CARD_W - 8) / 2;   // SPEAK's right edge when both buttons show
    int gapX1 = gapX0 + 8;                    // TYPE's left edge
    // Same split as the draw, derived the same way, so the halves cannot drift.
    bool wantType = type && (!speak || sx >= gapX1);
    if (wantType) { openKeyboard(detailIndex); return true; }
    // The 8px gap between the two half-width buttons only exists when BOTH
    // are drawn side by side. This used to be `if (!speak) return true;`,
    // which is dead code for that gap: it only fires when SPEAK isn't
    // offered at all, i.e. exactly the case with no gap to protect (the row
    // is either all-TYPE, caught by wantType above, or all-SPEAK, with
    // nothing here to hit). A tap actually landing in the gap fell through
    // to the SPEAK branch below and started an unwanted 20s recording.
    if (speak && type && sx >= gapX0 && sx < gapX1) return true;
    if (!speak) return true;                 // nothing offered here at all
    // Same reasoning as RE-RECORD above: this is the path a CANCEL actually
    // returns to (it reverts to the option buttons, SPEAK row included), so a
    // suppression from an earlier CANCEL on this prompt must not survive a
    // fresh recording started here.
    s.askVoiceCancelSha[0] = '\0';
    copyField(micAnswerPid, sizeof(micAnswerPid), s.askPid);
    micStream();                 // capped at 20s because micAnswerPid is set
    micAnswerPid[0] = '\0';      // one capture only; never leaks into a dictation
    return true;
  }
  if (sy >= optTop) {
    // Mirror mode: the options are a read-only list. Swallow the tap (so it
    // can't fall through to "back") but never send an answer - the Mac's
    // dialog is the one waiting for a decision.
    if (!s.askAnswerable) return true;
    int k = (sy - optTop) / (ASK_OPT_H + ASK_OPT_GAP);
    if (k >= 0 && k < s.askOptCount) {
      bool already = answeredPid[0] && strncmp(answeredPid, s.askPid, sizeof(answeredPid)) == 0 &&
                      (uint8_t) answeredHostSlot == s.hostSlot;
      if (!already) {
        copyField(answeredPid, sizeof(answeredPid), s.askPid);
        answeredHostSlot = s.hostSlot;
        answeredIdx = k;
        sendAnswerToHost(detailIndex, k);
        drawSessionDetail(detailIndex);
        buildDetailSignature(detailIndex, detailSigCache, sizeof(detailSigCache));
      }
    }
    return true;
  }
  // Header row: READ ALL on the right (when overflowing), back on the left.
  if (sy < CONTENT_Y + 28) {
    if (askOverflow && sx >= ASK_READ_BTN_X - 6) {
      readerActive = true;
      readerPage = 0;
      drawReader();
      return true;
    }
    return false; // "< Back" side of the header
  }
  // Everything between header and options (badge, title, text preview) is
  // deliberately inert - no hidden actions near the decision buttons.
  return true;
}
// Label used inside the status pill on the detail screen.
const char* pillLabel(const char* status) {
  if (strcmp(status, "working") == 0) return "WORKING";
  if (strcmp(status, "asking") == 0) return "NEEDS INPUT";
  return "READY";
}
// A column value, clipped to its own width. The two-column pairs need this rather than
// drawDetailValue, which assumes the full card width.
void drawColValue(int x, int y, const char* value, int w) {
  setUIFont(2);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  char buf[32];
  snprintf(buf, sizeof(buf), "%s", value[0] ? value : "-");
  if (tft.textWidth(buf) > w) {
    int dots = tft.textWidth("..");
    while (strlen(buf) > 2 && tft.textWidth(buf) > w - dots) buf[strlen(buf) - 1] = '\0';
    strncat(buf, "..", sizeof(buf) - strlen(buf) - 1);
  }
  tft.drawString(buf, x, y);
}
// Seconds-since-local-midnight -> "14:31". -1 means the host said "not today", which is
// printed as "earlier" rather than a time from another day masquerading as this one.
void formatClock(long sec, char* buf, size_t n) {
  if (sec < 0) snprintf(buf, n, "earlier");
  else snprintf(buf, n, "%02ld:%02ld", (sec / 3600) % 24, (sec / 60) % 60);
}
void drawDetailValue(int y, const char* value, uint8_t fnt) {
  setUIFont(fnt);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  char buf[40];
  snprintf(buf, sizeof(buf), "%s", value[0] ? value : "-");
  int maxW = CARD_W - 2 * PAD;
  int dotsW = tft.textWidth("..");
  if (tft.textWidth(buf) > maxW) {
    while (strlen(buf) > 2 && tft.textWidth(buf) > maxW - dotsW) buf[strlen(buf) - 1] = '\0';
    strncat(buf, "..", sizeof(buf) - strlen(buf) - 1);
  }
  tft.drawString(buf, CARD_X + PAD, y);
}
void drawSessionDetail(int idx) {
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  if (idx < 0 || idx >= sessionCount) return;
  if (sessions[idx].askPid[0]) {
    drawAskDetail(idx);
    return;
  }

  SessionInfo& s = sessions[idx];
  const char* status = s.status;
  uint16_t color = colorForStatus(status);
  const int cardY = DETAIL_CARD_Y;
  const int maxW = CARD_W - 2 * PAD;

  setUIFont(2);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.setTextDatum(TL_DATUM);
  tft.drawString("< Back", CARD_X, CONTENT_Y + 4);
  // Outlined, not filled: it opens a screen whose own primary action is SEND, and
  // the filled treatment belongs to that one.
  if (msgOffered(idx))
    uiButton(msgBtnX(), msgBtnY(), MSG_BTN_W, MSG_BTN_H, "TYPE", COLOR_ACCENT, false, COLOR_BG);

  uiFillRound(CARD_X, cardY, CARD_W, DETAIL_CARD_H, RADIUS, COLOR_CARD, COLOR_BG);
  uiStrokeRound(CARD_X, cardY, CARD_W, DETAIL_CARD_H, RADIUS, BORDER_CARD, color, COLOR_BG);

  // Laid out with a running cursor rather than the hand-derived offsets this screen used
  // to carry (cardY + 78 / +120 / +158). Those had to be re-derived by hand every time a
  // field moved, which is how the screen ended up sparse in the first place.
  int cy = cardY + 6;
  const int LX = CARD_X + PAD;              // label/value left edge
  const int RX = CARD_X + CARD_W / 2 + 2;   // right column, for the paired short fields
  const int colW = CARD_W / 2 - PAD - 4;

  // Project name - large, clipped to the card in the big font.
  char nameBuf[26];
  snprintf(nameBuf, sizeof(nameBuf), "%s", s.name);
  setUIFont(4);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  while (strlen(nameBuf) > 1 && tft.textWidth(nameBuf) > maxW) nameBuf[strlen(nameBuf) - 1] = '\0';
  tft.drawString(nameBuf, LX, cy);
  cy += 26;

  // What the session is about, straight under its name - the same title the list row
  // shows, which was previously nowhere on this screen.
  if (s.title[0]) {
    char titleBuf[48];
    setUIFont(2);
    fitText(titleBuf, sizeof(titleBuf), s.title, maxW);
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.drawString(titleBuf, LX, cy);
    cy += 15;
  }

  // Status pill; renderDetailDuration draws "for 12m - 14:31" to its right.
  detailPillY = cy;
  drawStatusPill(LX, cy, pillLabel(status), status, false);
  detailDurCache[0] = '\0'; // force the duration to redraw after this repaint
  cy += 24;

  tft.drawFastHLine(LX, cy, maxW, COLOR_LABEL);
  cy += 7;

  // LAST PROMPT - the most useful text on the screen: what you actually asked.
  if (s.prompt[0]) {
    setUIFont(1);
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
    tft.drawString("LAST PROMPT", LX, cy);
    cy += 13;
    drawWrappedText(s.prompt, LX, cy, 1, 11, maxW, 0, 2, COLOR_VALUE, COLOR_CARD);
    cy += 24;
    tft.drawFastHLine(LX, cy, maxW, COLOR_LABEL);
    cy += 7;
  }

  // PATH - wrapped, since paths are long and the tail is the informative end.
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.drawString("PATH", LX, cy);
  cy += 13;
  drawWrappedText(s.path[0] ? s.path : "-", LX, cy, 1, 11, maxW, 0, 2, COLOR_VALUE, COLOR_CARD);
  cy += 24;

  // The four short fields pair into two columns instead of a four-row ladder. That is
  // what buys the room for the title and the prompt above without a taller card.
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.drawString("MODEL", LX, cy);
  tft.drawString("GIT BRANCH", RX, cy);
  cy += 12;
  drawColValue(LX, cy, s.model, colW);
  drawColValue(RX, cy, s.branch, colW);
  cy += 18;

  // STARTED pairs with the agent, NOT with "last active" - that already sits beside the
  // pill above as part of "for 12m - 14:31". Repeating it here would both say the same
  // thing twice and create a field that goes stale, since a value on the static card can
  // only update by repainting the whole card. Both of these never change for a session.
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.drawString("STARTED", LX, cy);
  // Which Mac rides BESIDE the agent, not in a row of its own below it: even today's
  // four short fields leave only ~8px of slack in the worst case (title AND prompt both
  // present) before the card's own bottom border, and a fifth label+value row needs
  // ~25px more - it would run past the card. Gated on usedLinkCount() > 1 via
  // dispMacTag(), the identical reason drawCardChrome() gates the USAGE tab's tag: a
  // real Mac's tag is never empty, so without the gate this would show permanently,
  // disambiguating nothing with one Mac.
  const char* mac = dispMacTag(s.hostSlot);
  tft.drawString(mac[0] ? "AGENT / MAC" : "AGENT", RX, cy);
  cy += 12;
  char t1[10];
  formatClock(s.startSec, t1, sizeof(t1));
  drawColValue(LX, cy, t1, colW);
  // The short CC/CX form, not the spelled-out "Claude Code"/"Codex", is what leaves
  // room for the tag in this 90px column: "Claude Code / studio" (21 chars, 126px) does
  // not fit and drawColValue's own truncation would eat the TAIL first, dropping the
  // Mac tag itself rather than the agent name. "CC/studio" (9 chars, 54px) fits with
  // room to spare. Unchanged ("Claude Code"/"Codex") when there's nothing to disambiguate.
  char agentCol[24];
  // The icon rides between the agent tag and the Mac text - this and SETTINGS
  // are the two screens that show an icon ALONGSIDE its text, which is what
  // makes the icon-only treatment safe everywhere else. Gated on mac[0], same
  // as the label above: with one Mac there's nothing to disambiguate, and an
  // icon appearing only when a second Mac exists (i.e. it's actually needed)
  // matches this row's existing rule rather than a new one.
  int agentEmoji = mac[0] ? emojiIdForLink(s.hostSlot) : -1;
  if (agentEmoji >= 0) {
    // Pieces, not one drawColValue() call - that helper only clips a single
    // string, and there's real headroom to spare here without needing to:
    // measured worst case is "CC" (12px) + 4px gap + the 13px icon + 4px gap +
    // dispMacTag()'s own 7-char cap (42px) = 75px, against this 90px column
    // (CARD_W/2 - PAD - 4).
    // NO slash here: "/" is the no-icon form's separator between the agent
    // tag and the Mac text ("CC/pro"), carried over unchanged below. With an
    // icon sitting between them, a leading slash on the Mac text read as
    // something missing ("CC [icon] /pro") rather than the plain "CC [icon]
    // pro" the brief's own acceptance text calls for - same bare 4px-gap
    // spacing the SETTINGS row uses between its icon and its tag/age text.
    const char* tag = strcmp(s.agent, "cx") == 0 ? "CX" : "CC";
    setUIFont(2);
    tft.setTextColor(COLOR_VALUE, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    tft.drawString(tag, RX, cy);
    int iconX = RX + tft.textWidth(tag) + 4;
    // y == cy for both: the icon's y is the text's y, because both are 13px -
    // the same vertical rule the SETTINGS row and every other icon site uses.
    drawEmoji(agentEmoji, iconX, cy, COLOR_CARD);
    snprintf(agentCol, sizeof(agentCol), "%s", mac);
    tft.drawString(agentCol, iconX + MAC_EMOJI_SIZE + 4, cy);
  } else if (mac[0]) {
    snprintf(agentCol, sizeof(agentCol), "%s/%s",
             strcmp(s.agent, "cx") == 0 ? "CX" : "CC", mac);
    drawColValue(RX, cy, agentCol, colW);
  } else {
    snprintf(agentCol, sizeof(agentCol), "%s",
             strcmp(s.agent, "cx") == 0 ? "Codex" : "Claude Code");
    drawColValue(RX, cy, agentCol, colW);
  }

  // Asking but no answerable prompt attached (fired while disconnected, or the
  // window closed) - say so instead of leaving "needs input" unexplained.
  if (strcmp(status, "asking") == 0) {
    setUIFont(1);
    tft.setTextColor(COLOR_WARN, COLOR_BG);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("answer this one on your Mac", tft.width() / 2, cardY + DETAIL_CARD_H + 8);
    tft.setTextDatum(TL_DATUM);
  }

  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(MC_DATUM);
  // Says what the screen actually does. It read "tap anywhere to go back", which stopped
  // being true when back moved to the header row only, and is doubly wrong now the body
  // opens the history reader.
  tft.drawString("< Back up top  -  tap here for history", tft.width() / 2,
                 contentBottom() - 10);
  tft.setTextDatum(TL_DATUM);
}
// The "for Xm" duration ticks on its own cache (right of the status pill) so
// it can update every second without repainting the whole card.
void renderDetailDuration() {
  if (detailIndex < 0 || detailIndex >= sessionCount) return;
  if (sessions[detailIndex].askPid[0]) return; // ask screen has its own layout
  const SessionInfo& s = sessions[detailIndex];
  char dur[10], clk[10], buf[26];
  formatDuration(s.statusSinceMillis, dur, sizeof(dur));
  formatClock(s.actSec, clk, sizeof(clk));
  // How long in this state AND when it last happened. The duration alone can't tell a
  // session that went quiet a minute ago from one idle since this morning.
  if (s.actSec >= 0) snprintf(buf, sizeof(buf), "for %s - %s", dur, clk);
  else snprintf(buf, sizeof(buf), "for %s", dur);
  padLeftTo(buf, sizeof(buf), 22);
  // Follows the pill's actual y, which the variable layout decides.
  drawIfChanged(detailDurCache, sizeof(detailDurCache), buf, CARD_X + CARD_W - PAD,
                detailPillY + 4, 1, 1, COLOR_LABEL, COLOR_CARD, TR_DATUM);
}
