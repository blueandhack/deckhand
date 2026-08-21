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
void drawCardChrome(int y0, const char* label, const char* tag) {
  uiCard(CARD_X, y0, CARD_W, CARD_H, COLOR_CARD);  // border added by caller when active
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(label, CARD_X + PAD, y0 + 6);   // usage cards have their own inset
  // Which Mac's reading this is. Only drawn with two Macs actually TALKING TO
  // US right now: with one Mac it is noise, and a label that appears and
  // disappears is how you notice the second Mac arriving. Gated on used
  // hostLinks[] entries, not transport count - USB and BLE are routinely the
  // SAME Mac (the ordinary state of this device is one Mac reachable both
  // ways at once: via=usb,ble to one Mac), so bleLinkCount() +
  // (usbLinkActive()?1:0) would read 2 with nothing to disambiguate. Right-
  // aligned in the SAME row as the label, because every other row on this
  // card is spoken for (the +88 row's clear box already had to move off the
  // border, and nothing here may end past +101).
  if (tag && *tag && usedLinkCount() > 1) {
    tft.setTextDatum(TR_DATUM);
    tft.drawString(tag, CARD_X + CARD_W - PAD, y0 + 6);
    tft.setTextDatum(TL_DATUM);
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
// Footer layout, all font 1 (6px/char monospace), 240px wide:
//   clock 10..58 | battery glyph 88..109 + text 113..137 | freshness ..230
// Each zone is fixed-width padded so none can grow into its neighbor.
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
    drawBatteryGlyph(88, y, pct, (int) bst);
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
  drawIfChanged(battTextCache, sizeof(battTextCache), buf, 113, y, 1, 1,
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
}
// Codex's row. One line, because Codex publishes one number: a percentage of its
// primary window and when that window resets. No token count, no second window, and
// nothing to plot a pace against - so a full card would be mostly empty chrome.
// Dimmed on stale data for the same reason the hero numbers are: this figure comes
// out of a rollout file, and a file that stopped being written keeps its last value
// forever.
void renderCodexRow() {
  char buf[24];
  bool have = usage.cxPct >= 0;
  bool stale = usage.cxAgeSec > 900;
  uint16_t color = have ? colorForPct(usage.cxPct) : COLOR_UNKNOWN;
  drawCardBorder(&cxBorderCache, CARD_X, CODEX_Y, CARD_W, CODEX_H, color);

  // Left lane: the agent's name and its window, so this can never be mistaken for
  // one of the Claude figures above.
  //
  // With two Macs live, the window gives way to the Mac tag instead of sharing
  // the lane with it: this row has no free line the way a Claude card's +6 row
  // is (its one line is already busy at +8). The window is fixed and rarely
  // worth more than the source once there is a source to disambiguate.
  //
  // "CX " rather than "CODEX  " - the label's usable lane is bounded by ITS
  // NEIGHBOUR, not by anything of its own, and the bound is DERIVED, not a
  // magic 11. The right field draws at CARD_X + CARD_W - PAD = 214 with
  // TR_DATUM, padded to 20 characters = 120px in Cozette 6x13 - so it spans
  // x 94..214, and drawIfChanged() clears fx-1 (93) before drawing it. That
  // clear runs EVERY time the right field redraws, which is every tick, so
  // it always lands after the left field has already drawn in full. Nothing
  // truncates the label - TFT_eSPI draws every character it's given - the
  // right field's neighbour simply erases whatever the label left in x
  // 93..214 a moment later. So the label's safe width is (93 - 26) / 6 =
  // 11.17 -> 11 characters at x = CARD_X + PAD (26), confirmed on-device
  // both with a real tag ("CODEX  studio" -> "CODEX  stud" on screen, the
  // "io" erased) and a plain diagnostic literal with no lowercase or spaces
  // at all ("ABCDEFGHIJKLM" -> "ABCDEFGHIJK", cut at the identical 11th
  // character) - proof it's positional, not a content or font issue. THIS
  // CEILING MOVES if the right field's pad width (currently 20) ever
  // changes - re-derive it, don't copy 11 forward. "CX " + a 6-char tag
  // (the macTag() cap) is 9 characters, two clear of today's 11 either way;
  // "CODEX  " + the same tag would have been 13.
  const char* cxTag = linkTag(cxSourceLink);
  bool showCxTag = cxTag && *cxTag && usedLinkCount() > 1;
  if (showCxTag) {
    snprintf(buf, sizeof(buf), "CX %s", cxTag);
  } else if (usage.cxWindowMin > 0) {
    long d = usage.cxWindowMin / 1440;
    if (d >= 1) snprintf(buf, sizeof(buf), "CODEX  %ldd", d);
    else snprintf(buf, sizeof(buf), "CODEX  %ldh", usage.cxWindowMin / 60);
  } else {
    snprintf(buf, sizeof(buf), "CODEX");
  }
  padTo(buf, sizeof(buf), 11);
  drawIfChanged(cxPctCache, 24, buf, CARD_X + PAD, CODEX_Y + 8, 2, 1,
                COLOR_LABEL, COLOR_CARD);

  // Right lane: the percentage, the reset countdown, and (usually) the wall-clock time
  // it resets at - the same three facts the Claude cards give, so the row can be read
  // the same way. "--" when the host has never seen a rate_limits record, which is what
  // an unused Codex install looks like - deliberately NOT 0%, which would read as a
  // measurement.
  //
  // The wall-clock suffix is DROPPED whenever the left lane is showing the tag instead
  // of the window (showCxTag, above). "CX <tag>" tops out at 9 characters, so this isn't
  // load-bearing against the truncation ceiling the way an earlier "CODEX  <tag>" design
  // was - it's a second, cheap margin against the right lane's OWN worst case ("NN%  Xd
  // Yh left  HH:MM", up to 23 chars) ever reaching left past the tag, which pre-existed
  // this task at the window-text width too and is unlikely but not provably impossible.
  // The clock is the least useful of the three facts here anyway - the countdown already
  // says the same thing in relative terms - so dropping it costs nothing to gain a margin.
  if (!have) {
    snprintf(buf, sizeof(buf), "--");
  } else if (usage.cxResetInMin >= 0) {
    long nowSec = hostNowSec();
    // Same arithmetic renderCard uses for its "at 14:32", including the same guard: with
    // no host clock yet there is nothing to add the countdown to, so print the countdown
    // alone rather than a time computed from zero.
    if (nowSec >= 0 && !showCxTag) {
      long atSec = (nowSec + usage.cxResetInMin * 60) % 86400;
      snprintf(buf, sizeof(buf), "%d%%  %s  %02ld:%02ld", usage.cxPct,
               formatResetIn(usage.cxResetInMin).c_str(), atSec / 3600, (atSec / 60) % 60);
    } else {
      snprintf(buf, sizeof(buf), "%d%%  %s", usage.cxPct,
               formatResetIn(usage.cxResetInMin).c_str());
    }
  } else {
    snprintf(buf, sizeof(buf), "%d%%", usage.cxPct);
  }
  padLeftTo(buf, sizeof(buf), 20);
  drawIfChanged(cxRightCache, 24, buf, CARD_X + CARD_W - PAD, CODEX_Y + 8, 2, 1,
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
  drawPaceBar(&cxBarCache, CARD_X + PAD, CODEX_Y + 26, CARD_W - 2 * PAD, BAR_H,
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
  static int srcCache = -2, cxSrcCache = -2;
  if (srcCache != usageSourceLink || cxSrcCache != cxSourceLink) {
    srcCache = usageSourceLink;
    cxSrcCache = cxSourceLink;
    drawUsageStatic();   // repaints chrome; resetUsageCaches() runs inside it
  }
  renderCard(CARD1_Y, usage.fiveHourPct, usage.sessionTokens, usage.fiveHourResetInMin,
             5 * 60, pct1Cache, left1Cache, right1Cache, fable1Cache, resetAt1Cache,
             &bar1Cache, &border1Cache);
  renderCard(CARD2_Y, usage.sevenDayPct, usage.weekAllTokens, usage.sevenDayResetInMin,
             7 * 24 * 60, pct2Cache, left2Cache, right2Cache, fable2Cache, resetAt2Cache,
             &bar2Cache, &border2Cache, usage.weekFableTokens, usage.weekFablePct);
  renderCodexRow();
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
