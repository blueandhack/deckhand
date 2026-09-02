// USAGE tab: the two Claude cards, the Codex row, and the footer.
// Split out of deckhand_display.ino - see pairing.ino for how the concatenated
// build works and what may not move.

uint16_t colorForPct(int pct) {
  if (pct < 0) return COLOR_UNKNOWN;
  if (pct >= 90) return COLOR_BAD;
  if (pct >= 70) return COLOR_WARN;
  return COLOR_GOOD;
}
String formatTokens(unsigned long tokens) {
  char buf[24];
  if (tokens >= 1000000UL) {
    snprintf(buf, sizeof(buf), "%.2fM tok", tokens / 1000000.0);
  } else if (tokens >= 1000UL) {
    snprintf(buf, sizeof(buf), "%.1fK tok", tokens / 1000.0);
  } else {
    snprintf(buf, sizeof(buf), "%lu tok", tokens);
  }
  return String(buf);
}
String formatResetIn(long minutes) {
  if (minutes < 0) return String("no data yet");
  unsigned long m = (unsigned long) minutes;
  if (m >= 1440) {
    return String((int)(m / 1440)) + "d " + String((int)((m / 60) % 24)) + "h left";
  } else if (m >= 60) {
    return String((int)(m / 60)) + "h " + String((int)(m % 60)) + "m left";
  }
  return String((int)m) + "m left";
}
void resetUsageCaches() {
  pct1Cache[0] = '\0'; left1Cache[0] = '\0'; right1Cache[0] = '\0'; fable1Cache[0] = '\0';
  resetAt1Cache[0] = '\0'; bar1Cache = -2; border1Cache = -1;
  pct2Cache[0] = '\0'; left2Cache[0] = '\0'; right2Cache[0] = '\0'; fable2Cache[0] = '\0';
  resetAt2Cache[0] = '\0'; bar2Cache = -2; border2Cache = -1;
  cxPctCache[0] = '\0'; cxRightCache[0] = '\0'; cxBorderCache = -1;
  cxBarCache = -1; cxStaleCache = -1;
}
// Which link (Mac) supplied the figures currently on screen - see mergeUsage().
// -1 means no link has a usable reading yet.
int usageSourceLink = -1;
int cxSourceLink = -1;
// Which Mac the tab is PINNED to, by hostId rather than slot index - a slot is
// reused when a link drops and reconnects, and pinning "slot 0" would then
// silently follow whoever landed there. Empty = AUTO, meaning freshest-wins,
// which is the resting state and what a reboot lands on: a page choice is not
// worth an NVS write, and AUTO is the right default anyway.
char usagePinHostId[12] = "";
// Both Macs poll the same account, so the quota is the same number twice - the
// useful difference between them is AGE. Take the fresher reading per source
// (Claude by quotaAgeSec, Codex independently by cxAgeSec, which is already how
// the Codex row's staleness is judged), and remember which Mac it came from so
// the card can say. Two pollers therefore back each other up: a Mac in a long
// OAuth back-off is simply out-aged by the other.
//
// A negative age means "never measured", which must never win against a real
// reading - and must not read as fresher than one, which is what a plain
// comparison on -1 would do.
void mergeUsage() {
  int best = -1, bestCx = -1;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    const Usage& u = hostLinks[i].usage;
    if (u.fiveHourPct >= 0 || u.sevenDayPct >= 0) {
      if (best < 0 || (u.quotaAgeSec >= 0 &&
          (hostLinks[best].usage.quotaAgeSec < 0 ||
           u.quotaAgeSec < hostLinks[best].usage.quotaAgeSec))) best = i;
    }
    if (u.cxPct >= 0) {
      if (bestCx < 0 || (u.cxAgeSec >= 0 &&
          (hostLinks[bestCx].usage.cxAgeSec < 0 ||
           u.cxAgeSec < hostLinks[bestCx].usage.cxAgeSec))) bestCx = i;
    }
  }
  // A pin overrides freshest-wins, PER SOURCE and with a fallback: pinning a
  // Mac that has no Codex reading must not blank the Codex row, so each source
  // keeps the freshest it found when the pinned Mac has nothing for it. The pin
  // is DROPPED the moment its Mac stops talking to us, for the same reason a
  // quiet link's session rows are dropped rather than dimmed - otherwise the
  // tab sits on a departed Mac's frozen numbers and looks live.
  if (usagePinHostId[0]) {
    int pin = linkForHost(usagePinHostId, false);
    if (pin < 0) {
      usagePinHostId[0] = '\0';
    } else {
      const Usage& p = hostLinks[pin].usage;
      if (p.fiveHourPct >= 0 || p.sevenDayPct >= 0) best = pin;
      if (p.cxPct >= 0) bestCx = pin;
    }
  }
  usageSourceLink = best;
  cxSourceLink = bestCx;
  if (best >= 0) {
    const Usage& u = hostLinks[best].usage;
    usage.fiveHourPct = u.fiveHourPct;      usage.fiveHourResetInMin = u.fiveHourResetInMin;
    usage.sevenDayPct = u.sevenDayPct;      usage.sevenDayResetInMin = u.sevenDayResetInMin;
    usage.sessionTokens = u.sessionTokens;  usage.weekAllTokens = u.weekAllTokens;
    usage.weekFableTokens = u.weekFableTokens; usage.weekFablePct = u.weekFablePct;
    usage.quotaAgeSec = u.quotaAgeSec;
  }
  if (bestCx >= 0) {
    const Usage& u = hostLinks[bestCx].usage;
    usage.cxPct = u.cxPct;  usage.cxResetInMin = u.cxResetInMin;
    usage.cxWindowMin = u.cxWindowMin;  usage.cxAgeSec = u.cxAgeSec;
  }
}
// Tap the content area to read the OTHER Mac's own figures. Returns true only
// when the page actually moved, so the caller repaints nothing otherwise.
// Cycles in slot order over links that have SOME reading, wrapping, and does
// nothing at all with fewer than two - so on an ordinary single-Mac setup a tap
// on this tab stays as inert as it was before this existed.
bool usageCyclePin() {
  int live[MAX_LINKS], n = 0;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    const Usage& u = hostLinks[i].usage;
    if (u.fiveHourPct >= 0 || u.sevenDayPct >= 0 || u.cxPct >= 0) live[n++] = i;
  }
  if (n < 2) return false;
  // N+1 states, not N: each live link, then AUTO (freshest-wins), then round
  // again. The auto step is not a nicety - without it every tap set a pin and
  // NOTHING ever cleared one except the pinned Mac disappearing, so after a
  // single tap you were stuck pinned forever and the indicator was permanently
  // lit. An indicator that can never turn off distinguishes nothing.
  //
  // AUTO is represented as index n (one past the last link), so the whole cycle
  // is one modular step and there is no special case to forget.
  int cur = n; // no pin = AUTO = the last slot in the cycle
  if (usagePinHostId[0]) {
    int pinned = linkForHost(usagePinHostId, false);
    for (int i = 0; i < n; i++) if (live[i] == pinned) { cur = i; break; }
  }
  int next = (cur + 1) % (n + 1);
  if (next == n) {
    usagePinHostId[0] = '\0'; // back to freshest-wins
  } else {
    strlcpy(usagePinHostId, hostLinks[live[next]].hostId, sizeof(usagePinHostId));
  }
  return true;
}
void drawCardChrome(int y0, const char* label, const char* tag) {
  uiCard(CARD_X, y0, CARD_W, CARD_H, COLOR_CARD);  // border added by caller when active
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(label, CARD_X + PAD, y0 + CARD_LABEL_Y);  // usage cards have their own inset
  // Which Mac's reading this is. Only drawn with two Macs actually TALKING TO
  // US right now: with one Mac it is noise, and a label that appears and
  // disappears is how you notice the second Mac arriving. Gated on used
  // hostLinks[] entries, not transport count - USB and BLE are routinely the
  // SAME Mac (the ordinary state of this device is one Mac reachable both
  // ways at once: via=usb,ble to one Mac), so bleLinkCount() +
  // (usbLinkActive()?1:0) would read 2 with nothing to disambiguate. Right-
  // aligned in the SAME row as the label, because every other row on this
  // card is spoken for (the foot row's clear box already had to move off the
  // border, and nothing on a card may end past CARD_H - 3 - each board's
  // header states where every band's clear box lands).
  const int tagRight = CARD_X + CARD_W - PAD;
  int cardEmoji = emojiIdForLink(usageSourceLink);
  if (cardEmoji >= 0) {
    // Icon shown whenever one is SET, unlike the text tag below: the tag is
    // hidden with one Mac because a redundant 6-character word is noise, but
    // an icon is personalisation rather than disambiguation - the user asked
    // to tag THEIR computer, and it should show regardless of link count.
    // Same convention the session rows already use.
    drawEmoji(cardEmoji, tagRight - MAC_EMOJI_SIZE, y0 + CARD_LABEL_Y, COLOR_CARD);
    // Pinned-vs-auto, previously carried by the tag's colour, which a colour
    // sprite cannot carry. A bar, not an underline: it sits ABOVE the glyph,
    // inside the interior (the 2px border owns y0..y0+1, the label row starts
    // at y0+CARD_LABEL_Y) - below the icon lands inside the hero number's own
    // clear box at y0+CARD_HERO_Y. THE TIGHTEST SITE FOR THE ICON, on both
    // boards: it spans CARD_LABEL_Y .. CARD_LABEL_Y + MAC_EMOJI_SIZE - 1, i.e.
    // +6..+18 against board 1's hero at +20 (1 row clear) and +6..+21 against
    // board 2's at +24 (2 rows clear). The bar is MAC_EMOJI_SIZE wide so it
    // tracks the glyph it marks.
    //
    // COLOR_LABEL, not COLOR_ACCENT, and that was a real complaint rather than
    // taste: in accent this read as a red-orange stripe over the icon and the
    // first question it drew from a user was "why is there a red underline?" -
    // an indicator whose meaning has to be asked about has already failed.
    // COLOR_LABEL is a palette token, so applyTheme() follows the theme for
    // free, AND it is the exact colour of the label text in this same row, so
    // the mark reads as chrome rather than an alarm. PRESENCE is the carrier -
    // which only carries information because the tap cycle can return to auto
    // (see usageCyclePin); a bar that can never turn off signals nothing.
    if (usagePinHostId[0]) {
      tft.fillRect(tagRight - MAC_EMOJI_SIZE, y0 + CARD_PIN_BAR_Y, MAC_EMOJI_SIZE, 3, COLOR_LABEL);
    }
  } else if (tag && *tag && usedLinkCount() > 1) {
    // Accent = PINNED, grey = AUTO (freshest wins), the same convention the
    // settings controls use: accented once off the default. It is carried by
    // COLOUR because there is no width to carry it in text - every other row on
    // this card spans the full interior (hero, pace bar and stats all take
    // CARD_W - 2*PAD), and against a 144px label ("WEEK - 7 DAY, ALL MODELS")
    // a "1/2" beside a 6-char tag would start at x=154 and collide at 170.
    // Colour is not the only carrier: the tag TEXT changes on every tap, which
    // is what actually tells you the page moved.
    tft.setTextColor(usagePinHostId[0] ? COLOR_ACCENT : COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TR_DATUM);
    tft.drawString(tag, tagRight, y0 + CARD_LABEL_Y);
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  }
}
void drawFooterChrome() {
  tft.drawFastHLine(0, contentBottom(), tft.width(), COLOR_LABEL);
  // Clear the whole band, not just the divider. Everything else down here is painted by
  // drawIfChanged, which fills only each field's own glyph box - so without this the gaps
  // between the clock, battery and freshness zones keep whatever colour they had, which a
  // theme switch makes glaringly visible and nothing in normal operation ever repairs.
  tft.fillRect(0, contentBottom() + 1, tft.width(), FOOTER_H - 1, COLOR_BG);
  // Every full-screen rebuild goes through here, so stale footer caches
  // (which would otherwise skip redrawing an erased field) reset with it.
  clockCache[0] = '\0';
  updatedCache[0] = '\0';
  battTextCache[0] = '\0';
  battGlyphCache = -1;
}
// Battery runs the pct scale the opposite way from quota: low = bad.
// Level colour. Note this is INVERTED against the usage palette's meaning: there
// a high percentage is the bad one, here a low percentage is.
uint16_t colorForBattery(int pct) {
  if (pct <= 10) return COLOR_BAD;
  if (pct <= 30) return COLOR_WARN;
  return COLOR_GOOD;
}
// What the pill actually paints. CHARGING IS A STATE, NOT A LEVEL: while power
// is coming in, 8% is not a warning, so it takes the accent instead of the level
// colour - otherwise a charging device sat there showing an alarm about a
// problem that is actively being solved.
//
// Colour is never the only carrier here. The reading is printed as a NUMBER, the
// glyph carries a proportional FILL, and charging/full say so in words - so the
// three bands stay legible to a colour-blind eye and in flat greyscale, which is
// the same rule drawStatusDot follows with its shapes.
uint16_t colorForBatteryState(int pct, BattState st) {
  if (st == BATT_CHARGING) return COLOR_ACCENT;
  if (st == BATT_FULL) return COLOR_GOOD;
  return colorForBattery(pct);
}
// 20x9 battery outline with proportional fill. Fill level (not just color)
// carries the state, so it stays readable without relying on colour.
void drawBatteryGlyph(int x, int y, int pct, int state) {
  tft.fillRect(x, y, 21, 9, COLOR_BG);
  if (state == (int) BATT_NONE) return;
  uint16_t c = colorForBatteryState(pct, (BattState) state);
  tft.drawRect(x, y, 18, 9, c);
  tft.fillRect(x + 18, y + 2, 2, 5, c);
  int fill = 14 * pct / 100;
  if (fill > 0) tft.fillRect(x + 2, y + 2, fill, 5, c);
}
// Footer layout, all font 1 (Cozette 6x13, 6px/char). Three fixed-width padded
// zones so none can grow into its neighbour:
//   clock, left-pinned at x=10 | battery glyph + reading, CENTRED |
//   freshness, right-pinned at tft.width() - 10
// Only the middle zone needs board constants: the outer two follow tft.width()
// already. Board 1 (240 wide): clock 10..58, glyph 88..108, text 113..137,
// freshness 164..230. Board 2 (320 wide): clock 10..58, glyph 135..155, text
// 160..184, freshness 244..310. See FOOTER_BATT_X in the board header for how
// the centre is derived.
void renderFooter() {
  char buf[24];
  int y = contentBottom() + 4;

  long nowSec = hostNowSec();
  if (nowSec >= 0) {
    snprintf(buf, sizeof(buf), "%02ld:%02ld:%02ld", nowSec / 3600, (nowSec / 60) % 60, nowSec % 60);
  } else {
    snprintf(buf, sizeof(buf), "--:--:--");
  }
  padTo(buf, sizeof(buf), 8);
  drawIfChanged(clockCache, sizeof(clockCache), buf, 10, y, 1, 1, COLOR_LABEL, COLOR_BG);

  // Battery pill, centered. The glyph redraws on 5%-bucket or state changes
  // only, so EMA jitter in the ADC reading doesn't make it shimmer.
  BattState bst = batteryState();
  int pct = batteryPresent() ? batteryPct() : -1;
  int glyphCode = (pct < 0 ? 0 : pct / 5) * 10 + (int) bst;
  if (glyphCode != battGlyphCache) {
    battGlyphCache = glyphCode;
    drawBatteryGlyph(FOOTER_BATT_X, y, pct, (int) bst);
  }
  if (bst == BATT_NONE) buf[0] = '\0';
  else if (bst == BATT_CHARGING) snprintf(buf, sizeof(buf), "chg");
  else if (bst == BATT_FULL) snprintf(buf, sizeof(buf), "full");
  else snprintf(buf, sizeof(buf), "%d%%", pct);
  padTo(buf, sizeof(buf), 4);
  // The number now reads at the same level colour as the glyph beside it, so the
  // two cannot disagree. Bust the text cache when only the colour moved.
  uint16_t battCol = (bst == BATT_NONE) ? COLOR_LABEL : colorForBatteryState(pct, bst);
  if (battCol != battTextColorCache) {
    battTextColorCache = battCol;
    battTextCache[0] = '\0';
  }
  drawIfChanged(battTextCache, sizeof(battTextCache), buf, FOOTER_BATT_TEXT_X, y, 1, 1,
                battCol, COLOR_BG);

  // Freshness, right-aligned and compact ("12s ago", not "updated 12s ago",
  // so it can't reach the battery zone even at its widest). Left-padded:
  // trailing spaces would land past the right edge, leading spaces are what
  // blank a previously-longer value.
  bool fresh = everReceived && (millis() - lastRxMillis) < 30000;
  unsigned long agoSec = everReceived ? (millis() - lastRxMillis) / 1000 : 0;
  if (!everReceived) {
    snprintf(buf, sizeof(buf), "no data");
  } else if (fresh) {
    snprintf(buf, sizeof(buf), "%lus ago", agoSec);
  } else if (agoSec < 600) {
    snprintf(buf, sizeof(buf), "stale %lus", agoSec);
  } else {
    snprintf(buf, sizeof(buf), "stale %lum", agoSec / 60);
  }
  padLeftTo(buf, sizeof(buf), 11);
  drawIfChanged(updatedCache, sizeof(updatedCache), buf, tft.width() - 10, y, 1, 1,
                fresh ? COLOR_LABEL : COLOR_BAD, COLOR_BG, TR_DATUM);
#if !BOARD_USES_TFT_ESPI
  // Flushing here (rather than only at the end of loop()) keeps this footer's
  // own small dirty rect from being unioned with whatever the tab render
  // that runs in the same tick just touched - the footer sits at the very
  // bottom of the panel and a tab body can span the top/middle, so that
  // union was close to a full-screen flush every second.
  tft.flush();
#endif
}
// Codex's row. One line, because Codex publishes one number: a percentage of its
// primary window and when that window resets. No token count, no second window, and
// nothing to plot a pace against - so a full card would be mostly empty chrome.
// Dimmed on stale data for the same reason the hero numbers are: this figure comes
// out of a rollout file, and a file that stopped being written keeps its last value
// forever.
void renderCodexRow() {
  // Sized by the lane it has to hold, not a literal. padTo() pads to
  // CODEX_LANE_CHARS but stops at `len + 1 < bufSize`, so a buffer one byte too
  // small UNDER-PADS instead of failing - the leftover pixels of a
  // previously-longer value simply survive, which reads as stale text rather
  // than as a bug. (It is padLeftTo() that refuses outright on an oversized
  // width; do not attribute its guard to this one.) A 23-character lane on
  // board 2 in a char[24] would fit with zero headroom - the same
  // margin-of-nothing that makes a short change-only cache this file's oldest
  // silent bug. Same constant the caches use, so the three cannot drift.
  char buf[CODEX_LANE_CACHE];
  bool have = usage.cxPct >= 0;
  bool stale = usage.cxAgeSec > 900;
  uint16_t color = have ? colorForPct(usage.cxPct) : COLOR_UNKNOWN;
  drawCardBorder(&cxBorderCache, CARD_X, CODEX_Y, CARD_W, CODEX_H, color);

  // Left lane: the agent's name and its window, so this can never be mistaken for
  // one of the Claude figures above.
  //
  // With two Macs live and no icon set for this one, the window gives way to the
  // Mac tag instead of sharing the lane with it: this row has no free line the
  // way a Claude card's +6 row is (its one line is already busy at +8). The
  // window is fixed and rarely worth more than the source once there is a
  // source to disambiguate. An icon is a different trade, though - it's drawn
  // OVER a reserved gap in the same line rather than replacing anything, so
  // once one is set the window no longer gives way (see showCxIcon below): the
  // row keeps its window text and gains the icon, and it's only the tag that
  // still yields, exactly as the Claude cards' own icon-vs-tag chrome does.
  //
  // "CX " rather than "CODEX  " - the label's usable lane is bounded by ITS
  // NEIGHBOUR, not by anything of its own, so the bound is DERIVED (it lives in
  // the board header as CODEX_LANE_CHARS) and is not a magic number. Nothing
  // truncates the label - the device draws every character it is given - the
  // right field's clear box simply erases whatever the label left under it, and
  // that clear runs EVERY tick, always after the left field has drawn in full.
  // The lane is therefore (the right field's clear-box left edge - the label's
  // x) / the face's own advance, four numbers that ALL move with CARD_W and PAD:
  //
  //   board 1 (CARD_W 216, PAD 14): right field at 214, its OWN worst case (18
  //     chars - see the right-lane comment below) = 108px, spans 106..214,
  //     clears from 105; label at 26; (105 - 26) / 6 = 13.17 -> 13
  //   board 2 (CARD_W 296, PAD 18): right field at 290, 18 chars at Spleen8x16's
  //     8px = 144px, spans 146..290, clears from 145; label at 30;
  //     (145 - 30) / 8 = 14.375 -> 14
  //
  // NOTE THE ADVANCE IS PER BOARD - 6px on board 1's Cozette, 8px on board 2's
  // Spleen8x16. Counting characters instead of measuring the advance was a
  // real bug here once (board 2 read 23 against a true ceiling of 12): the
  // advance is a property of the face, so derive from the face, not from a
  // literal 6.
  //
  // THE LANE ITSELF MOVED, from 11/12 to 13/14, when the wall-clock suffix
  // below was dropped. CODEX_RIGHT_CHARS - the right field's pad width - used
  // to be treated as this field's ceiling, but padLeftTo() only ever PADS a
  // short string up; it returns early and does NOT truncate one already
  // longer than the pad width. With the clock, real content ran to ~24
  // characters against a pad width of 20, so the field routinely drew WIDER
  // than the old 11/12 derivation assumed, and its clear box ate the label's
  // own tail. CODEX_RIGHT_CHARS is 18 now - equal to this field's real worst
  // case with no clock - so it is a genuine ceiling again rather than a floor
  // being mistaken for one (usage-geom-check.mjs asserts that relationship,
  // not just today's two numbers).
  //
  // Board 1's OLD ceiling (11) was confirmed on-device both with a real tag
  // ("CODEX  studio" -> "CODEX  stud" on screen, the "io" erased) and a plain
  // diagnostic literal with no lowercase or spaces at all ("ABCDEFGHIJKLM" ->
  // "ABCDEFGHIJK", cut at the identical 11th character) - proof it is
  // positional, not a content or font issue. IT ALSO MOVES if the right field's
  // pad width (CODEX_RIGHT_CHARS, 18) ever changes; re-derive, do not copy a
  // number forward.
  // What the branches below actually emit: "CX " + a 6-char tag (the macTag()
  // cap) is 9 characters, comfortably inside both boards' ceilings (13 and
  // 14). The tag-versus-window trade (see showCxTag below) is kept IDENTICAL
  // on both boards regardless: a roomier lane was never a reason for the two
  // panels to render different text.
  const char* cxTag = linkTag(cxSourceLink);
  bool showCxTag = cxTag && *cxTag && usedLinkCount() > 1;
  // Icon shown whenever one is set, same reasoning as the Claude cards' chrome:
  // personalisation, not disambiguation, so it isn't gated on a second Mac.
  int cxEmoji = emojiIdForLink(cxSourceLink);
  bool showCxIcon = cxEmoji >= 0;
  if (showCxIcon) {
    // Same window text as the no-tag branch below, just with "CX" in place of
    // "CODEX" and 4 spaces reserved after it instead of 2 - room for the icon
    // plus its gaps (4px on each side), measured at each board's own monospace
    // advance: 24px of gap against 4+13+4 = 21 needed on board 1 (3px spare),
    // and 32px against 4+16+4 = 24 on board 2 (8px spare). So the window text
    // can never collide with the icon drawn into that gap below.
    long d = usage.cxWindowMin / 1440;
    if (usage.cxWindowMin <= 0) snprintf(buf, sizeof(buf), "CX");
    else if (d >= 1) snprintf(buf, sizeof(buf), "CX    %ldd", d);
    else snprintf(buf, sizeof(buf), "CX    %ldh", usage.cxWindowMin / 60);
  } else if (showCxTag) {
    snprintf(buf, sizeof(buf), "CX %s", cxTag);
  } else if (usage.cxWindowMin > 0) {
    long d = usage.cxWindowMin / 1440;
    if (d >= 1) snprintf(buf, sizeof(buf), "CODEX  %ldd", d);
    else snprintf(buf, sizeof(buf), "CODEX  %ldh", usage.cxWindowMin / 60);
  } else {
    snprintf(buf, sizeof(buf), "CODEX");
  }
  padTo(buf, sizeof(buf), CODEX_LANE_CHARS);
  drawIfChanged(cxPctCache, CODEX_LANE_CACHE, buf, CARD_X + PAD, CODEX_Y + CODEX_TEXT_Y, 2, 1,
                COLOR_LABEL, COLOR_CARD);
  if (showCxIcon) {
    // "CX" + 4px gap + the icon, from the label's x, at each board's own
    // advance: 12+4+13 = 29px ending at 55 on board 1, and 16+4+16 = 36px
    // ending at 66 on board 2 - well clear of the right field's clear box
    // either way (105 and 145, see the right-lane derivation below).
    // Vertically the icon shares CODEX_TEXT_Y with
    // the row's text, whose own clear box is 2 rows taller than the icon on
    // both boards. See the long derivation above.
    setUIFont(2);
    drawEmoji(cxEmoji, CARD_X + PAD + tft.textWidth("CX") + 4, CODEX_Y + CODEX_TEXT_Y, COLOR_CARD);
  }

  // Right lane: the percentage and the reset countdown - two facts, not three.
  // "--" when the host has never seen a rate_limits record, which is what an
  // unused Codex install looks like - deliberately NOT 0%, which would read
  // as a measurement.
  //
  // THE WALL-CLOCK SUFFIX IS GONE, and the countdown beside it already says the
  // same thing in relative terms. That is not a cosmetic trim: this field's clear
  // box is what bounds the LABEL's lane (see CODEX_LANE_CHARS in the board
  // header), and padLeftTo() cannot cap it - it returns early on an over-long
  // string rather than truncating - so the field's own worst case IS the bound.
  // With the clock, that worst case ran to ~24 characters (docs/board-1-known-
  // defects.md used to record #12 for exactly this: content that outgrew its
  // own pad width). Without it, the longest this field ever prints is
  // "100%  23h 59m left" - 18 characters - safely under CODEX_RIGHT_CHARS (18
  // itself now, see the header), so padLeftTo() always successfully pads and
  // the field's rendered width is a fixed 18 characters, not a moving target.
  if (!have) {
    snprintf(buf, sizeof(buf), "--");
  } else if (usage.cxResetInMin >= 0) {
    snprintf(buf, sizeof(buf), "%d%%  %s", usage.cxPct,
             formatResetIn(usage.cxResetInMin).c_str());
  } else {
    snprintf(buf, sizeof(buf), "%d%%", usage.cxPct);
  }
  padLeftTo(buf, sizeof(buf), CODEX_RIGHT_CHARS);
  drawIfChanged(cxRightCache, CODEX_LANE_CACHE, buf, CARD_X + CARD_W - PAD, CODEX_Y + CODEX_TEXT_Y, 2, 1,
                stale ? COLOR_LABEL : (have ? COLOR_VALUE : COLOR_LABEL), COLOR_CARD, TR_DATUM);

  // Pace bar, with the same tick the Claude cards carry: fill ahead of the marker means
  // quota is going faster than time. tickPct -1 when either input is missing, which
  // drawPaceBar already renders as "no tick" - no special case needed here.
  // The bar dims WITH the number when the reading is stale; a bright bar beside a dimmed
  // percentage would read as live data. drawPaceBar caches on (pct, tick) only, so the
  // colour change alone would not repaint - renderUsageTab busts cxBarCache on the flip.
  int tickPct = (have && usage.cxResetInMin >= 0 && usage.cxWindowMin > 0)
                    ? (int) (100 - usage.cxResetInMin * 100 / usage.cxWindowMin)
                    : -1;
  drawPaceBar(&cxBarCache, CARD_X + PAD, CODEX_Y + CODEX_BAR_Y, CARD_W - 2 * PAD, BAR_H,
              have ? usage.cxPct : 0, tickPct, stale ? COLOR_LABEL : color);
}
void renderUsageTab() {
  if (!everReceived) return;
  // When staleness flips, bust the hero-number caches so their dim/normal
  // color actually repaints - drawBigNumber only redraws on a text change,
  // and a stale % often keeps the same digits (e.g. a frozen "0%").
  int stale = usage.quotaAgeSec > 900 ? 1 : 0;
  if (stale != quotaStaleCache) {
    quotaStaleCache = stale;
    pct1Cache[0] = '\0';
    pct2Cache[0] = '\0';
  }
  // Codex's row dims on ITS OWN age, so it gets its own flip. This used to hang off the
  // Claude flag above, which was wrong in both directions: Codex going stale while the
  // OAuth poller stayed fresh left the row bright, and a Claude flip repainted a Codex
  // row whose state had not changed. The bar must be busted too - drawPaceBar keys its
  // cache on (pct, tick) alone, so a dim-only change would never repaint.
  int cxStale = usage.cxAgeSec > 900 ? 1 : 0;
  if (cxStale != cxStaleCache) {
    cxStaleCache = cxStale;
    cxRightCache[0] = '\0';
    cxPctCache[0] = '\0';
    cxBarCache = -1;
    cxBorderCache = -1;
  }
  // A source change moves no percentage, so nothing else would repaint - the
  // same trap the stale-dim flip above has, where the digits stay identical.
  // The PIN state belongs in this bust too: pinning the Mac that freshest-wins
  // had already chosen moves no source and no digit, but it does flip the tag
  // from grey to accent, and nothing else would repaint it.
  // The LINK COUNT belongs here too, and its absence was a real bug: the tag is
  // drawn only when usedLinkCount() > 1, but the tag lives on the card CHROME,
  // which repaints on a source or pin change and nothing else. So a second Mac
  // arriving after the chrome was last painted left both Claude cards untagged
  // while the Codex row (a different draw call, rendered per tick) showed its
  // tag - observed exactly that way on hardware, with two real Macs connected.
  // The Claude cards' icon id joins the bust too: an icon change (set,
  // cleared, or the source Mac swapping to one with a different icon) moves
  // no percentage, no source link and no link count, so nothing else here
  // would repaint it - and the label's own drawIfChanged clears only its own
  // text box, never the icon beside it. Watch this on the second Mac's link
  // ageing out: without it, a stale icon would sit there after the tag has
  // reverted to text.
  //
  // The Codex row's icon does NOT need this: renderCodexRow() draws it
  // unconditionally every tick (it isn't behind a drawIfChanged of its own),
  // and the label's drawIfChanged clear box (x 25..93) already covers the
  // icon's slot (42..54) on every redraw - so a stale Codex icon self-heals
  // without a bust term, and carrying one here would only cost an avoidable
  // full-chrome repaint on every icon-only change in a file whose whole
  // discipline is flicker avoidance.
  static int srcCache = -2, cxSrcCache = -2, pinCache = -1, linksCache = -1,
             emojiCache = -3;
  int pinNow = usagePinHostId[0] ? 1 : 0;
  int linksNow = usedLinkCount();
  int emojiNow = emojiIdForLink(usageSourceLink);
  if (srcCache != usageSourceLink || cxSrcCache != cxSourceLink ||
      pinCache != pinNow || linksCache != linksNow ||
      emojiCache != emojiNow) {
    srcCache = usageSourceLink;
    cxSrcCache = cxSourceLink;
    pinCache = pinNow;
    linksCache = linksNow;
    emojiCache = emojiNow;
    drawUsageStatic();   // repaints chrome; resetUsageCaches() runs inside it
  }
  renderCard(CARD1_Y, usage.fiveHourPct, usage.sessionTokens, usage.fiveHourResetInMin,
             5 * 60, pct1Cache, left1Cache, right1Cache, fable1Cache, resetAt1Cache,
             &bar1Cache, &border1Cache);
  renderCard(CARD2_Y, usage.sevenDayPct, usage.weekAllTokens, usage.sevenDayResetInMin,
             7 * 24 * 60, pct2Cache, left2Cache, right2Cache, fable2Cache, resetAt2Cache,
             &bar2Cache, &border2Cache, usage.weekFableTokens, usage.weekFablePct);
  renderCodexRow();
#if !BOARD_USES_TFT_ESPI
  tft.flush();
#endif
}
void drawUsageStatic() {
  // This chrome is what the change-only fields below are drawn ON, so a
  // repaint that skips resetting their caches leaves every value BLANK
  // ("hasn't changed" per drawIfChanged, even though its pixels were just
  // erased) - the exact "USAGE shows no numbers after recording" bug. Reset
  // here, once, so no call site can forget it.
  resetUsageCaches();
  // Both Claude cards (5h and 7d) are merged from the SAME link in
  // mergeUsage(), so they always carry the same source tag.
  drawCardChrome(CARD1_Y, "SESSION - 5 HOUR WINDOW", linkTag(usageSourceLink));
  drawCardChrome(CARD2_Y, "WEEK - 7 DAY, ALL MODELS", linkTag(usageSourceLink));
  uiCard(CARD_X, CODEX_Y, CARD_W, CODEX_H, COLOR_CARD);
}
