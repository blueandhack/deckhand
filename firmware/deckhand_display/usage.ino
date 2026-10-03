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
#if BOARD_USAGE_V2
  // The NOW/WEEK cards' own fields - drawUsageStatic() repaints the chrome
  // these are drawn ON, so a cache left out of this reset leaves its field
  // BLANK after any full repaint (tab switch, theme change, returning from
  // settings): "unchanged" per drawIfChanged, though its pixels were just
  // erased. That shipped once as "USAGE shows no numbers after recording".
  burn1Cache[0] = '\0';
  burn2Cache[0] = '\0';
  spark1Cache = 0;
  fableBarCache = -2;
#endif
}
// Which link (Mac) supplied the SELECTED account's figures - see mergeUsage().
// -1 means that account has no usable reading for that source.
int usageSourceLink = -1;
int cxSourceLink = -1;

// ---------- Accounts ----------
// The two Macs this device serves may be signed into DIFFERENT Claude accounts, and
// then their quotas are two numbers, not one number measured twice. The host names
// the account (`acct`, an opaque hash); two links are one account only when BOTH name
// one and the names agree. A link with no `acct` is its own account: merging two Macs
// on a guess would show one account's quota under the other's name, which is the
// defect this exists to remove. Two OLD hosts on one account therefore show as two
// accounts until updated - visible and harmless, unlike a silent mix.
bool linksShareAccount(int a, int b) {
  if (a == b) return true;
  const char* x = hostLinks[a].acct;
  const char* y = hostLinks[b].acct;
  return x[0] && y[0] && strcmp(x, y) == 0;
}
// The account's identity as one string. '@' + hostId for an acct-less link: '@' is
// not a hex digit, so it can never equal a real acct (MULTITEST's hostId "feedfeed"
// is valid hex and would otherwise collide with an acct of the same spelling).
void accountKeyFor(int link, char* out, size_t n) {
  if (hostLinks[link].acct[0]) strlcpy(out, hostLinks[link].acct, n);
  else snprintf(out, n, "@%s", hostLinks[link].hostId);
}

int   usageAcctCount = 0;
int   usageAcctFirstLink[MAX_LINKS];   // lowest-slot link of each account, slot order
Usage usageAcct[MAX_LINKS];            // each account's own merged reading
int   usageAcctSrc[MAX_LINKS];         // ...and the links that supplied it
int   usageAcctCxSrc[MAX_LINKS];
int   usageAcctSelIdx = -1;            // index into the above; -1 = no account
// The selected account BY IDENTITY, not by index: a slot is reused when a link drops
// and another Mac connects, and an index would silently follow whoever landed there.
// "" = no account yet (or the selected one's Macs all stopped talking): mergeUsage()
// shows account 0 and LATCHES its key here in the same call. A reboot lands on "".
char  usageAcctSel[14] = "";           // '@' + an 11-char hostId + NUL fits in 13

// ANY Claude reading - a percentage OR a token count. A Mac whose OAuth poll has never
// succeeded (or is in a 429 back-off) still sends its locally counted tokens with null
// percentages, and the cards then show "--" beside real token totals. Counting only the
// percentages here would drop that Mac from the account list and blank its tokens too.
// A token-only reading carries quotaAgeSec -1, so it can never out-age a real one.
static bool usageHasClaude(const Usage& u) {
  return u.fiveHourPct >= 0 || u.sevenDayPct >= 0 ||
         u.sessionTokens > 0 || u.weekAllTokens > 0 || u.weekFableTokens > 0;
}
// Is any Mac still TALKING TO US on account `key`, reading or not? What keeps a
// selection alive through a tick with no reading - see mergeUsage().
static bool usageAccountKeyLive(const char* key) {
  char k[14];
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    accountKeyFor(i, k, sizeof(k));
    if (strcmp(k, key) == 0) return true;
  }
  return false;
}

// Freshest reading per source WITHIN account a. Claude by quotaAgeSec, Codex
// independently by cxAgeSec. A negative age means "never measured" and must never win
// against a real reading, which a plain comparison on -1 would let it do.
static void mergeAccount(int a) {
  int rep = usageAcctFirstLink[a], best = -1, bestCx = -1;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used || !linksShareAccount(rep, i)) continue;
    const Usage& u = hostLinks[i].usage;
    if (usageHasClaude(u)) {
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
  Usage m;   // defaults are the "no reading" sentinels
  if (best >= 0) {
    const Usage& u = hostLinks[best].usage;
    m.fiveHourPct = u.fiveHourPct;      m.fiveHourResetInMin = u.fiveHourResetInMin;
    m.sevenDayPct = u.sevenDayPct;      m.sevenDayResetInMin = u.sevenDayResetInMin;
    m.sessionTokens = u.sessionTokens;  m.weekAllTokens = u.weekAllTokens;
    m.weekFableTokens = u.weekFableTokens; m.weekFablePct = u.weekFablePct;
    m.quotaAgeSec = u.quotaAgeSec;
  }
  // NO CROSS-ACCOUNT FALLBACK for Codex. The old pin borrowed another Mac's Codex
  // reading when the pinned Mac had none; with two accounts that puts one person's
  // Codex under the other account's header. An account with no Codex hides the row.
  if (bestCx >= 0) {
    const Usage& u = hostLinks[bestCx].usage;
    m.cxPct = u.cxPct;  m.cxResetInMin = u.cxResetInMin;
    m.cxWindowMin = u.cxWindowMin;  m.cxAgeSec = u.cxAgeSec;
  }
  usageAcct[a] = m;
  usageAcctSrc[a] = best;
  usageAcctCxSrc[a] = bestCx;
}

void mergeUsage() {
  // Distinct accounts, in slot order, among links with ANY reading - a Mac that has
  // measured nothing yet would only add an empty page to the tap cycle.
  usageAcctCount = 0;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    const Usage& u = hostLinks[i].usage;
    if (!usageHasClaude(u) && u.cxPct < 0) continue;
    bool seen = false;
    for (int a = 0; a < usageAcctCount; a++)
      if (linksShareAccount(usageAcctFirstLink[a], i)) { seen = true; break; }
    if (!seen) usageAcctFirstLink[usageAcctCount++] = i;
  }
  for (int a = 0; a < usageAcctCount; a++) mergeAccount(a);

  // The selection, by key. A selected account that is not in the list DISPLAYS the
  // first in the SAME call - holding it would keep a departed Mac's frozen numbers on
  // screen. But the KEY is forgotten only when no Mac on that account is talking to us
  // any more (the old pin's rule: cleared when its Mac stops talking). One tick with
  // no reading - the first tick after a host restart - must not snap the page back to
  // account 0 for good; the account reappears selected when its reading returns.
  int sel = usageAcctCount > 0 ? 0 : -1;
  if (usageAcctSel[0]) {
    int found = -1;
    char k[14];
    for (int a = 0; a < usageAcctCount; a++) {
      accountKeyFor(usageAcctFirstLink[a], k, sizeof(k));
      if (strcmp(k, usageAcctSel) == 0) { found = a; break; }
    }
    if (found >= 0) sel = found;
    else if (!usageAccountKeyLive(usageAcctSel)) usageAcctSel[0] = '\0';
  }
  // THE LATCH. With no key (nobody has tapped, or the key was just forgotten above)
  // the page shows account 0 - whichever Mac holds the lower SLOT. Slots are not
  // identities: the two Macs swap them (seen twice on glass, 2026-10-03), and an
  // unlatched page then silently became the OTHER account's - the original defect,
  // only slower. So the account on screen becomes the selection, by key, the moment
  // it is shown; from then on the ordinary by-key rules above hold it.
  if (!usageAcctSel[0] && sel >= 0)
    accountKeyFor(usageAcctFirstLink[sel], usageAcctSel, sizeof(usageAcctSel));
  usageAcctSelIdx = sel;

  // No Mac at all: leave `usage` alone. A host with no hostId drives it directly
  // (see the parse), and the no-host screen owns this state. THIS GUARD MUST STAY
  // usedLinkCount(), NOT usageAcctCount or sel: Macs still talking with no reading
  // between them is NOT "no Mac" - the parse no longer writes the global for a link,
  // so returning here then would leave a departed account's numbers up for good.
  if (usedLinkCount() == 0) { usageSourceLink = cxSourceLink = -1; return; }
  Usage none;
  const Usage& m = sel >= 0 ? usageAcct[sel] : none;
  usageSourceLink = sel >= 0 ? usageAcctSrc[sel] : -1;
  cxSourceLink    = sel >= 0 ? usageAcctCxSrc[sel] : -1;
  // Whole-struct copy, so a source that vanished CLEARS its figures rather than
  // leaving the last-parsed payload's numbers on screen.
  usage = m;
}

// Tap the content area to show the NEXT account's own figures. Returns true only
// when the page actually moved, so the caller repaints nothing otherwise. Inert below
// two accounts - two Macs on one account are one page, as they should be.
bool usageCycleAccount() {
  if (usageAcctCount < 2) return false;
  return usageSelectAccount((usageAcctSelIdx + 1) % usageAcctCount);
}
// Select account idx by key. Idempotent, so USAGEACCT's double delivery is harmless.
// Returns false only for an out-of-range idx.
bool usageSelectAccount(int idx) {
  if (idx < 0 || idx >= usageAcctCount) return false;
  accountKeyFor(usageAcctFirstLink[idx], usageAcctSel, sizeof(usageAcctSel));
  return true;
}
// The link whose name the card header shows for the SELECTED account: the Claude
// source, or - when the account has only a Codex reading, so usageSourceLink is -1 -
// its first link, so the header still says whose page this is. -1 = no account.
static int usageAcctLabelLink() {
  return usageSourceLink >= 0 ? usageSourceLink
       : (usageAcctSelIdx >= 0 ? usageAcctFirstLink[usageAcctSelIdx] : -1);
}
// The SELECTED account's name: the person's own DECKHAND_ACCOUNT_TAG when its Mac
// published one, else the source Mac's tag - with one Mac per account (today's
// MAX_LINKS) the Mac IS the account, so its tag already says which one. ASCII by
// construction: both pass through the host's macTag(), which transliterates.
const char* usageAcctLabel() {
  int src = usageAcctLabelLink();
  if (src < 0) return "";
  return hostLinks[src].acctTag[0] ? hostLinks[src].acctTag : linkTag(src);
}
// Did the person NAME the selected account? A name beats the Mac's icon in the card
// header, because the name is what tells two accounts apart and an icon names a Mac.
bool usageAcctNamed() {
  int src = usageAcctLabelLink();
  return src >= 0 && hostLinks[src].acctTag[0];
}
// THE SIGNATURE ITSELF IS #if'd, NOT DEFAULTED - and that is deliberate,
// proven by injection. A 4th `h` argument defaulting to CARD_H moved board
// 1's binary (+0 bytes, masked hash CHANGED) even though CARD_H was the only
// value board 1 ever passed: turning a compile-time constant baked into the
// function body into a runtime-passed parameter is a real codegen change,
// not a no-op, regardless of what value ends up in it. So board 1's arm is
// the ORIGINAL 3-argument text, byte-for-byte, and only board 2 - whose two
// v2 cards are different heights (NOW_CARD_H/WEEK_CARD_H, not one CARD_H) -
// takes an explicit height.
#if BOARD_USAGE_V2
void drawCardChrome(int y0, const char* label, const char* tag, int h) {
  uiCard(CARD_X, y0, CARD_W, h, COLOR_CARD);  // border added by caller when active
#else
void drawCardChrome(int y0, const char* label, const char* tag) {
  uiCard(CARD_X, y0, CARD_W, CARD_H, COLOR_CARD);  // border added by caller when active
#endif
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(label, CARD_X + PAD, y0 + CARD_LABEL_Y);  // usage cards have their own inset
  // WHICH ACCOUNT this page is. Only drawn with more than one Claude ACCOUNT
  // present (usageAcctCount, see mergeUsage()) - not with more than one Mac: two
  // Macs signed into ONE account are one page, and naming a Mac there tells the
  // reader nothing they can act on. With one account it is noise, and a label
  // that appears and disappears is how you notice the second account arriving.
  // usageAcctCount already counts accounts among USED hostLinks[] entries, never
  // transports - USB and BLE are routinely the SAME Mac (via=usb,ble to one Mac).
  // Right-aligned in the SAME row as the label, because every other row on this
  // card is spoken for (the foot row's clear box already had to move off the
  // border, and nothing on a card may end past CARD_H - 3 - each board's
  // header states where every band's clear box lands).
  //
  // A NAMED account (the person's DECKHAND_ACCOUNT_TAG) shows its NAME even when
  // the Mac has an icon: the person named the account, and the name is what tells
  // two accounts apart, where an icon names a computer. Unnamed, the label is the
  // source Mac's tag (usageAcctLabel()), and an icon still wins over it as before.
  const int tagRight = CARD_X + CARD_W - PAD;
  // The icon reads the SAME link the label does (usageAcctLabelLink()): with an
  // account whose only reading is Codex, usageSourceLink is -1 while the label
  // falls back to the account's first link, and the two must not disagree.
  int cardEmoji = emojiIdForLink(usageAcctLabelLink());
  bool named = usageAcctCount > 1 && usageAcctNamed();
  bool showIcon = cardEmoji >= 0 && !named;
  bool showText = tag && *tag && usageAcctCount > 1;
  if (showIcon) {
    // Icon shown whenever one is SET (and the account was not named), unlike the
    // text tag below: the tag is hidden with one account because a redundant
    // 6-character word is noise, but an icon is personalisation rather than
    // disambiguation - the user asked to tag THEIR computer, and it should show
    // regardless of account count. Same convention the session rows already use.
    drawEmoji(cardEmoji, tagRight - MAC_EMOJI_SIZE, y0 + CARD_LABEL_Y, COLOR_CARD);
    // THE TIGHTEST SITE FOR THE ICON, on both boards: it spans CARD_LABEL_Y ..
    // CARD_LABEL_Y + MAC_EMOJI_SIZE - 1, i.e. +6..+18 against board 1's hero at +20
    // (CARD_HERO_Y, 1 row clear) and +6..+21 against board 2's LIVE hero at +26
    // (NOW_HERO_Y, 4 rows clear). The pin bar that used to sit above it went with the
    // pin: the tap now pages ACCOUNTS (usageCycleAccount()), and which account is
    // shown is the card header's job, not a mark's.
  } else if (showText) {
    // Grey, always: the accent used to mean PINNED, and there is no pin any more -
    // the tap pages accounts. The label TEXT changes when the page moves to another
    // account, which is what tells you the page moved.
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TR_DATUM);
    tft.drawString(tag, tagRight, y0 + CARD_LABEL_Y);
    tft.setTextDatum(TL_DATUM);
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  }
  // NO "N/M" INDICATOR, on either board, and no draw code for one. It would sit
  // immediately left of the label or icon, and it fits on neither board beside the
  // widest card label (BOARD_USAGE_ACCT_INDEX 0 in both headers, each quoting its
  // overflow, re-derived by usage-geom-check.mjs from the parsed labels, HostLink's
  // tag buffers and the face). So the changing label above is the only carrier.
  // The draw is deliberately NOT written behind the flag: an arm no board compiles
  // is code nothing has ever built (commands-check.mjs's section (8) rejects one),
  // and a flag flipped to 1 over it would also need it to be right. Flipping the
  // flag therefore stops the build here instead of silently drawing nothing.
#if BOARD_USAGE_ACCT_INDEX
#error "BOARD_USAGE_ACCT_INDEX 1: write the N/M draw in drawCardChrome() first - none exists, because no board fitted it"
#endif
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
// ONE PREDICATE, READ EVERYWHERE - the layout accessors, renderUsageTab and
// drawUsageStatic all ask this and nothing re-derives it. A control drawn under
// one condition and hit-tested under another is this codebase's classic defect;
// there is no hit test on this tab, but a second spelling would still let the
// chrome and the fields disagree about which column they are in.
//
// Deliberately NOT keyed on QUOTA_STALE_SEC. That threshold (900s) means "we
// cannot vouch for this number" and already dims the row. This is the stronger
// claim that nobody is RUNNING the tool, and a full window of silence is what
// earns it.
//
// SHARED, not board 2's. It used to sit inside #if BOARD_USAGE_V2, so board 1
// could not see it and drew a CODEX card reading "CODEX  --" for ever on a Mac
// that has never run Codex - 44px of chrome and a dash, permanently, saying
// nothing. It reads three fields (cxPct, cxAgeSec, cxWindowMin) and one header
// constant, and all four exist on both boards: the fields are plain members of
// the shared Usage struct in deckhand_display.ino, parsed unconditionally out of
// every payload, and CODEX_HIDE_FALLBACK_MIN is now declared in both headers.
//
// WHAT THE TWO BOARDS DO WITH THE ANSWER STILL DIFFERS, and deliberately so.
// Board 2 (BOARD_USAGE_V2) grows its other two cards into the freed space through
// a _SOLO constant for every y that moves. Board 1 has a fixed three-card column
// and simply LEAVES THE 44px EMPTY - the same thing its SESSIONS tab already does
// when one session leaves the rest of the tab blank. Porting the ladder is a much
// larger change and would move every constant this file's checker derives.
bool usageCodexShown() {
  if (usage.cxPct < 0) return false;       // never measured
  if (usage.cxAgeSec < 0) return false;    // ditto, by the age's own sentinel
  long win = usage.cxWindowMin > 0 ? usage.cxWindowMin : CODEX_HIDE_FALLBACK_MIN;
  return usage.cxAgeSec <= win * 60;
}

#if BOARD_USAGE_V2
// ---------- The USAGE trend ring ----------
// Modelled on battTrend* in power.ino: a fixed ring of one-per-interval samples,
// least-squares fitted, refusing to speak until it has earned a number. ONE ring
// serves both the sparkline and the burn rate, which is what makes it worth its
// DRAM - and it samples the 5-hour percentage only, because the week's burn uses
// no history at all (see usageBurnMinutes).
//
// ONE RING PER ACCOUNT. A ring holds one quota's history; with two accounts on two
// Macs a single ring interleaved two series, and USAGE_RING_DROP_PCT - derived for
// two readings of ONE quota differing only in age - then either cleared it on every
// swap or read the swing as a burst. Owned by account key; see usageRingFor().
struct UsageRing {
  char          owner[14] = "";   // an account key, accountKeyFor()'s 14 bytes
  uint8_t       pct[USAGE_RING_SLOTS];
  unsigned long at[USAGE_RING_SLOTS];
  int           count = 0;
  int           head  = 0;
  unsigned long last  = 0;
  bool          wasStale = false;
};
UsageRing usageRings[MAX_LINKS];

// Declared here rather than left to Arduino's generated prototypes, which land
// above the sketch's first function - long before this struct - so a signature
// naming UsageRing would not compile there (the same reason usageHasClaude() and
// sessionSortsBefore() are forward-declared). A declaration that exists is what
// stops the generator emitting its own.
void usageRingReset(UsageRing& r);
UsageRing* usageRingFor(const char* key);
const UsageRing& usageRingSelected();
void usageRingSample(UsageRing& r, const Usage& u);

void usageRingReset(UsageRing& r) { r.count = 0; r.head = 0; r.last = 0; }

// The ring owned by `key`; else a FREE ring; else one whose owner no Mac is talking
// to us on any more. TWO PASSES, free first, and the second asks
// usageAccountKeyLive() - "is any linked Mac on that account" - NOT "is it among
// usageAcctCount's accounts with a reading this tick". A linked Mac with no reading
// (the first tick after a host restart, a 429 back-off) is still that account, the
// selection deliberately stays on it (see mergeUsage()), and taking its ring would
// wipe the history it returns to - while a free ring sat unused further along.
// A reused ring is ALWAYS reset: another account's history is not this one's.
// nullptr is unreachable: MAX_LINKS links carry at most MAX_LINKS live keys and
// `key` is one of them, so at most MAX_LINKS - 1 rings belong to OTHER live keys.
UsageRing* usageRingFor(const char* key) {
  for (int i = 0; i < MAX_LINKS; i++)
    if (strcmp(usageRings[i].owner, key) == 0) return &usageRings[i];
  int pick = -1;
  for (int i = 0; i < MAX_LINKS && pick < 0; i++)
    if (!usageRings[i].owner[0]) pick = i;
  for (int i = 0; i < MAX_LINKS && pick < 0; i++)
    if (!usageAccountKeyLive(usageRings[i].owner)) pick = i;
  if (pick < 0) return nullptr;
  strlcpy(usageRings[pick].owner, key, sizeof(usageRings[pick].owner));
  usageRingReset(usageRings[pick]);
  usageRings[pick].wasStale = false;
  return &usageRings[pick];
}

// The SELECTED account's ring - what every reader below draws or fits. Looked up by
// key, never claimed: only the sampler claims rings, so a reader can never hand an
// account a ring (or reset one) as a side effect of drawing it.
const UsageRing& usageRingSelected() {
  static UsageRing empty;   // count 0: every reader already refuses below two samples
  if (usageAcctSelIdx < 0) return empty;
  char k[14];
  accountKeyFor(usageAcctFirstLink[usageAcctSelIdx], k, sizeof(k));
  for (int i = 0; i < MAX_LINKS; i++)
    if (strcmp(usageRings[i].owner, k) == 0) return usageRings[i];
  return empty;
}

void usageRingSample(UsageRing& r, const Usage& u) {
  bool stale = u.quotaAgeSec > QUOTA_STALE_SEC;
  // A staleness EDGE clears, never the level. The clock keeps running while the
  // number does not, so samples either side of the gap are not one series - but
  // testing the level would clear the ring on every one of the 5s ticks it spends
  // stale, which is the ring it is trying to fill.
  if (stale != r.wasStale) {
    r.wasStale = stale;
    if (stale) usageRingReset(r);
  }
  if (stale || u.fiveHourPct < 0) return;

  // The rate limit is PER RING, through r.last: each account's ring takes one
  // sample per USAGE_RING_STEP_MS on its own clock.
  unsigned long now = millis();
  if (r.last != 0 && now - r.last < USAGE_RING_STEP_MS) return;

  // A GAP clears, for the staleness edge's own reason: samples either side of it
  // are not one series. An account is sampled only while it has a reading, so a
  // Mac asleep overnight freezes its ring - not stale (its link was pruned, so no
  // edge), and back in a NEW 5-hour window that may sit only a few points higher
  // (2% last night, 5% this morning), which the drop test below cannot see. Without
  // this the fit spans two windows and the caption claims "LAST 10.2H". The bound
  // is USAGE_RING_GAP_SEC (= QUOTA_STALE_SEC, three ring steps) - see its header
  // comment for why a normal step can never trip it.
  if (r.count > 0 && now - r.last > (unsigned long) USAGE_RING_GAP_SEC * 1000UL) usageRingReset(r);

  // A DROP means the window turned over. Within ONE account this deliberately does
  // NOT reset when mergeAccount() switches source Mac: two Macs on one account poll
  // the same quota, so their readings are the same measurement at different ages,
  // and clearing 2.5 hours of history because a link aged out would throw away good
  // data. The threshold is what separates the two - see USAGE_RING_DROP_PCT's
  // derivation. DIFFERENT accounts never share a ring (usageRingsSampleAll() feeds
  // each its own usageAcct[a]), so a cross-account swing never reaches this test.
  if (r.count > 0) {
    int prev = (int) r.pct[(r.head + USAGE_RING_SLOTS - 1) % USAGE_RING_SLOTS];
    if (u.fiveHourPct <= prev - USAGE_RING_DROP_PCT) usageRingReset(r);
  }

  r.last = now;
  r.pct[r.head] = (uint8_t) u.fiveHourPct;
  r.at[r.head]  = now;
  r.head = (r.head + 1) % USAGE_RING_SLOTS;
  if (r.count < USAGE_RING_SLOTS) r.count++;
}

// Every account, every call - not just the one on screen - so switching shows real
// history at once instead of an empty ring that takes 10 minutes to say anything.
void usageRingsSampleAll() {
  for (int a = 0; a < usageAcctCount; a++) {
    char k[14];
    accountKeyFor(usageAcctFirstLink[a], k, sizeof(k));
    UsageRing* r = usageRingFor(k);
    if (r) usageRingSample(*r, usageAcct[a]);
  }
}

// Least squares over the whole ring, never endpoint-to-endpoint - the same reason
// battMinutesLeft gives: one sample taken at an odd moment sits well off the
// trend, and two endpoints give it full weight. x comes from the stored
// timestamps rather than the slot index, because a missed poll leaves a real gap.
bool usageRingSlope(float* slopeOut, int* riseOut, long* spanMinOut) {
  const UsageRing& r = usageRingSelected();
  if (r.count < 2) return false;
  int oldest = (r.head + USAGE_RING_SLOTS - r.count) % USAGE_RING_SLOTS;
  int newest = (r.head + USAGE_RING_SLOTS - 1) % USAGE_RING_SLOTS;
  double sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (int i = 0; i < r.count; i++) {
    int idx = (oldest + i) % USAGE_RING_SLOTS;
    // Cast THEN divide, as battPctPerHourX10 does. Dividing in the unsigned-long
    // domain first truncates every x to a whole minute before the regression sees
    // it - self-consistent, but it quietly throws away precision the fit is there
    // to use, and a mirror written against it would enshrine the truncation.
    double x = ((double) (r.at[idx] - r.at[oldest])) / 60000.0;
    double y = (double) r.pct[idx];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  double den = (double) r.count * sxx - sx * sx;
  if (den == 0) return false;
  *slopeOut   = (float) (((double) r.count * sxy - sx * sy) / den);
  *riseOut    = (int) r.pct[newest] - (int) r.pct[oldest];
  *spanMinOut = (long) ((r.at[newest] - r.at[oldest]) / 60000UL);
  return true;
}

// The ring's ACTUAL span in minutes, for the sparkline's caption - 0 when there
// is nothing to caption yet (fewer than two samples). Mirrors battTrendSpanMin()
// in power.ino exactly, down to the count<2 guard: both answer "how much history
// does this ring actually hold", and a caption built from anything else would be
// claiming a full ring's span at partial fill - which is the bug this exists to
// fix (two samples five minutes apart is not "LAST 2.5H"). Deliberately separate
// from usageRingSlope(), which also computes a span but only as a byproduct of a
// slope fit that needs a healthy den and returns nothing at all through a false
// return - the caption needs a number even while the burn estimator is still
// refusing one.
int usageRingSpanMin() {
  const UsageRing& r = usageRingSelected();
  if (r.count < 2) return 0;
  int oldest = (r.head + USAGE_RING_SLOTS - r.count) % USAGE_RING_SLOTS;
  int newest = (r.head + USAGE_RING_SLOTS - 1) % USAGE_RING_SLOTS;
  return (int) ((r.at[newest] - r.at[oldest]) / 60000UL);
}

// The sparkline's caption, DERIVED from the span the ring actually holds rather
// than assumed from a full one. Below one ring step there is nothing to caption
// (usageRingSpanMin() returns 0 exactly when the ring holds fewer than two
// samples); below an hour the span reads in whole minutes ("LAST 59M", the
// widest of that branch); at or above an hour it reads in tenths of an hour, the
// same "LAST 2.5H" text a full 150-minute ring produces - but computed now, so a
// change to USAGE_RING_SLOTS/USAGE_RING_STEP_MIN moves the caption with it
// instead of leaving a literal to drift out of truth. Widest overall output is
// "no history" (10 chars); see usage-trend-check.py's exhaustive width sweep.
void usageSpanCaption(char* out, size_t n, int spanMin) {
  if (spanMin < 1) { snprintf(out, n, "no history"); return; }
  if (spanMin < 60) { snprintf(out, n, "LAST %dM", spanMin); return; }
  int hours  = spanMin / 60;
  int tenths = ((spanMin % 60) * 10 + 30) / 60;   // round to the nearest tenth
  if (tenths >= 10) { hours++; tenths = 0; }       // carry a rounded-up .10 into the hour
  snprintf(out, n, "LAST %d.%dH", hours, tenths);
}

// FNV-1a 32-bit over the samples, for the sparkline's change-only cache. It is
// compared against the ONE previous value and never against a population, so a
// missed repaint needs a collision with that single value - 2^-32 per event, not
// a birthday problem. Same hash and same argument buildDetailSignature already
// uses for optDescs.
//
// Over the SELECTED account's ring, so switching to an account whose ring holds
// different samples changes the hash on its own. A switch between two rings with
// IDENTICAL contents leaves it equal - and needs nothing, because the pixels would
// be identical too; the switch also repaints the chrome regardless (renderUsageTab's
// acctNow bust -> drawUsageStatic() -> resetUsageCaches() zeroes spark1Cache).
uint32_t usageRingHash() {
  const UsageRing& r = usageRingSelected();
  uint32_t h = 2166136261UL;
  h = (h ^ (uint32_t) r.count) * 16777619UL;
  for (int i = 0; i < r.count; i++) {
    int idx = (r.head + USAGE_RING_SLOTS - r.count + i) % USAGE_RING_SLOTS;
    h = (h ^ r.pct[idx]) * 16777619UL;
  }
  return h;
}

// Negative returns are NAMED, the same convention the charge estimator's
// BATT_CHG_NOT_YET / BATT_CHG_TOPPING use: a bare -1 at a call site says nothing
// about which of two very different refusals happened. BURN_WARMING is a third
// one, for the same reason the charge estimator needed two rather than one:
// "the ring is still filling and WILL speak" and "the trend is too flat or
// negative to ever state" read as the same "burn --" on the glass, and a user
// cannot tell "wait" from "nothing to say" without a distinct code. It fires
// only from the ring path (the selected ring's count < 2, or a real but too-short span) -
// the average path's refusals are unchanged, because BURN_MIN_ELAPSED is a
// data-validity floor, not a "still filling" state.
const long BURN_NOT_YET   = -1;   // may never resolve - flat or falling trend
const long BURN_EMPTY_NOW = -2;   // the cap is already reached
const long BURN_WARMING   = -3;   // the ring is still filling - ask again later

// CLAMPED for the same reason power.ino's charge estimator clamps at 99 hours:
// this is a DISPLAY, not a claim. At BURN_MIN_PCT (3) over the full 7-day window
// the unclamped average reaches ~226 days - "empty ~226d 23h" is 15 characters,
// filling SIDE_CHARS (15) exactly with zero headroom, the same landmine the
// resetAt1Cache pre-flight audit found. The ring-slope branch can reach
// arbitrarily large numbers too, as slope approaches zero. 143940 = 99*1440 +
// 23*60: the largest value that still decomposes as "99d 23h" - one day short
// of the day count growing a third digit - so the widest label this clamp can
// ever produce is "empty ~99d 23h", 14 characters, matching BURN_LABEL_BYTES's
// own comment. usage-trend-check.py derives its `worst` string from this
// constant rather than transcribing it, so a re-derivation here moves both.
const long BURN_MAX_LEFT_MIN = 143940;

long usageBurnMinutes(int pct, long resetMin, long windowMin, bool stale) {
  // A STALE READING DRIVES NO ESTIMATE. The clock has kept running while the
  // number has not, so any slope through it measures the gap rather than the burn.
  if (stale || pct < 0 || resetMin < 0 || windowMin <= 0) return BURN_NOT_YET;
  if (pct > BURN_MAX_PCT) return BURN_EMPTY_NOW;
  if (pct < BURN_MIN_PCT) return BURN_NOT_YET;

  if (windowMin <= BURN_RING_MAX_WIN) {
    // SHORT WINDOW: the ring slope. It sees a burst in the last ten minutes,
    // which an average over the whole window cannot.
    //
    // TWO DIFFERENT REFUSALS, so the card can say which one is happening. A
    // ring with under two samples, or one that has not yet SPANNED enough
    // time, WILL speak once it fills - that is BURN_WARMING, and it fires for
    // at least BURN_RING_MIN_SPAN minutes after every window reset (measured:
    // 30+ minutes, more at light usage). A ring that has filled but shows no
    // real movement (flat or falling) MAY NEVER resolve, which stays
    // BURN_NOT_YET - conflating the two used to read as "burn --" for both,
    // indistinguishable from the glass.
    float slope; int rise; long span;
    if (!usageRingSlope(&slope, &rise, &span)) return BURN_WARMING;   // count < 2
    if (span < BURN_RING_MIN_SPAN) return BURN_WARMING;               // still filling
    if (rise < BURN_RING_MIN_RISE || slope <= 0.0f) return BURN_NOT_YET;
    // CLAMP THE FLOAT BEFORE THE CAST, not after: for slope < ~4.7e-8 %/min
    // the quotient exceeds LONG_MAX and (long) of an out-of-range float is
    // undefined behaviour, not a defined saturate. A UB result that happens
    // to land negative would fall through `left > BURN_MAX_LEFT_MIN` and hit
    // `left < 1` -> BURN_EMPTY_NOW, i.e. the card would read "empty now" for
    // a glacial burn - inverted and alarming. Not reachable through the
    // `rise >= 3` / `span >= 30` gate above with 31 integer-percent samples,
    // and the Python mirror is arbitrary-precision so it cannot see this by
    // construction - caught only by reading the cast, not by running it.
    float leftF = ((float) (100 - pct)) / slope + 0.5f;
    if (leftF > (float) BURN_MAX_LEFT_MIN) leftF = (float) BURN_MAX_LEFT_MIN;
    long left = (long) leftF;
    if (left > BURN_MAX_LEFT_MIN) left = BURN_MAX_LEFT_MIN;
    return left < 1 ? BURN_EMPTY_NOW : left;
  }

  // LONG WINDOW: the average. The ring is blind here - a 7-day window moves 1.49
  // points across a 150-minute span, inside the integer-percent rounding.
  long elapsed = windowMin - resetMin;
  if (elapsed < BURN_MIN_ELAPSED) return BURN_NOT_YET;
  long left = (long) ((((double) (100 - pct)) * (double) elapsed) / (double) pct + 0.5);
  if (left > BURN_MAX_LEFT_MIN) left = BURN_MAX_LEFT_MIN;
  return left < 1 ? BURN_EMPTY_NOW : left;
}

// True when the cap is reached BEFORE the window resets - which is the only case
// worth colouring, because it is the only one that costs the user anything.
bool usageBurnUrgent(long mins, long resetMin) {
  return mins > 0 && resetMin >= 0 && mins < resetMin;
}

void usageBurnLabel(char* out, size_t n, long mins, long resetMin) {
  if (mins == BURN_EMPTY_NOW) { snprintf(out, n, "empty now"); return; }
  // BURN_WARMING is checked BEFORE the bare `mins < 0` catch-all, or it would
  // read as the same "burn --" the may-never-resolve case gets - the exact
  // ambiguity this code exists to remove.
  if (mins == BURN_WARMING)   { snprintf(out, n, "measuring"); return; }
  if (mins < 0)               { snprintf(out, n, "burn --");   return; }
  if (!usageBurnUrgent(mins, resetMin)) { snprintf(out, n, "won't run out"); return; }
  // "~" MEANS ABOUT. Never ">=", which is reserved for the charge estimator's
  // deliberate floor - the two notations make different promises, and a reader who
  // cannot tell them apart has been told the cap arrives later than it will.
  if (mins >= 1440)    snprintf(out, n, "empty ~%ldd %ldh", mins / 1440, (mins / 60) % 24);
  else if (mins >= 60) snprintf(out, n, "empty ~%ldh %ldm", mins / 60, mins % 60);
  else                 snprintf(out, n, "empty ~%ldm", mins);
}

// The sparkline. CAPS PLUS CONNECTORS, not columns: a bar chart sitting directly
// under the pace bar reads as a second pace bar, and caps alone read as a dashed
// rule. One cap and one connector per sample is two fillRects a column.
//
// SCALE IS 0..100, so it agrees with the bar above it. Auto-scaling to the
// series' own min and max reads better and lies by omission - a quota sitting
// still with integer-percent noise would draw a dramatic mountain.
void drawUsageSpark(uint32_t* cache, int x, int y, int w, int h, uint16_t fg, uint16_t bg) {
  uint32_t sig = usageRingHash();
  // THE TINT IS PART OF THE SIGNATURE, not just the samples. A stale flip or a
  // colorForPct band crossing changes fg while the ring content is unchanged, and
  // the early return below would then keep a bright spark beside a dimmed hero for
  // up to USAGE_RING_STEP_MIN minutes. Same trap CLAUDE.md records for
  // drawPaceBar's (pct, tick)-blind key and for battTextColorCache.
  sig = (sig ^ (uint32_t) fg) * 16777619UL;
  if (sig == *cache) return;          // or this repaints 260x32 every 5s tick
  *cache = sig;
  tft.fillRect(x - 1, y - 1, w + 2, h + 2, bg);
  tft.drawFastHLine(x, y + h - 1, w, COLOR_LABEL);
  const UsageRing& r = usageRingSelected();   // the SELECTED account's history
  if (r.count < 2) return;            // baseline only; the caption says "no history"
  int cw = w / USAGE_RING_SLOTS;
  int oldest = (r.head + USAGE_RING_SLOTS - r.count) % USAGE_RING_SLOTS;
  int prevCy = -1;
  for (int i = 0; i < r.count; i++) {
    int v  = (int) r.pct[(oldest + i) % USAGE_RING_SLOTS];
    int cy = y + h - 3 - ((h - 5) * v) / 100;
    bool last = (i == r.count - 1);
    if (prevCy >= 0 && prevCy != cy) {
      int a0 = prevCy < cy ? prevCy : cy;
      int a1 = prevCy < cy ? cy : prevCy;
      tft.fillRect(x + i * cw - 1, a0, 2, a1 - a0 + 2, fg);
    }
    tft.fillRect(x + i * cw, cy, cw - 1, last ? 4 : 2, last ? COLOR_VALUE : fg);
    prevCy = cy;
  }
}

#if BOARD_USAGE_V2

// THE LAYOUT, DERIVED FROM THE ONE PREDICATE at every read. No cached copy:
// two variables tracking one layout is how a UI comes to draw one column while
// its chrome is in the other, and this tab already has the ingredients (the
// fields and the chrome are painted by different functions on different ticks).
// The cost is a handful of comparisons per render, against a 41ms full flush.
int nowCardH()      { return usageCodexShown() ? NOW_CARD_H      : NOW_CARD_H_SOLO; }
int nowSparkH()     { return usageCodexShown() ? NOW_SPARK_H     : NOW_SPARK_H_SOLO; }
int nowMetaY()      { return usageCodexShown() ? NOW_META_Y      : NOW_META_Y_SOLO; }
int weekCardH()     { return usageCodexShown() ? WEEK_CARD_H     : WEEK_CARD_H_SOLO; }
int weekNumY()      { return usageCodexShown() ? WEEK_NUM_Y      : WEEK_NUM_Y_SOLO; }
int weekBurnY()     { return usageCodexShown() ? WEEK_BURN_Y     : WEEK_BURN_Y_SOLO; }
int weekBarY()      { return usageCodexShown() ? WEEK_BAR_Y      : WEEK_BAR_Y_SOLO; }
int weekMetaY()     { return usageCodexShown() ? WEEK_META_Y     : WEEK_META_Y_SOLO; }
int weekFableY()    { return usageCodexShown() ? WEEK_FABLE_Y    : WEEK_FABLE_Y_SOLO; }
int weekFableBarY() { return usageCodexShown() ? WEEK_FABLE_BAR_Y: WEEK_FABLE_BAR_Y_SOLO; }
// SP_2 IS visible here - it is declared in deckhand_display.ino, which the
// board header cannot see (hence the header's own literal 8 in CARD2_Y/CODEX_Y)
// but this file can, being concatenated after it. So the gap is named at the
// only two sites that can name it.
int weekCardY()     { return CARD1_Y + nowCardH() + SP_2; }
int codexRowY()     { return weekCardY() + weekCardH() + SP_2; }
#endif

// The 5-hour card, v2: the 64px hero keeps CARD_HERO_W's box, and the 132px it
// no longer spends on an empty clear now holds two facts a bare percentage only
// implies - the burn verdict and the reset countdown - plus a pace bar, a
// sparkline of the last 2.5h, and a meta row (session tokens / staleness or the
// spark's own caption).
void renderNowCard() {
  char buf[BURN_LABEL_BYTES + 8];
  const int y0 = CARD1_Y;
  bool stale = usage.quotaAgeSec > QUOTA_STALE_SEC;
  uint16_t color = colorForPct(usage.fiveHourPct);
  drawCardBorder(&border1Cache, CARD_X, y0, CARD_W, nowCardH(), color);

  if (usage.fiveHourPct >= 0) snprintf(buf, sizeof(buf), "%d%%", usage.fiveHourPct);
  else snprintf(buf, sizeof(buf), "--");
  // CARD_HERO_W, NOT THE FULL LANE. drawBigNumber clears the box it is given, and
  // the two fact lines below live in what the full lane would erase.
  drawBigNumber(pct1Cache, 8, buf, CARD_X + PAD, y0 + NOW_HERO_Y,
                CARD_HERO_W, CARD_HERO_H,
                stale ? COLOR_LABEL : COLOR_VALUE, COLOR_CARD);

  long mins = usageBurnMinutes(usage.fiveHourPct, usage.fiveHourResetInMin, 5 * 60, stale);
  usageBurnLabel(buf, BURN_LABEL_BYTES, mins, usage.fiveHourResetInMin);
  padLeftTo(buf, sizeof(buf), SIDE_CHARS);
  drawIfChanged(burn1Cache, sizeof(burn1Cache), buf, CARD_X + CARD_W - PAD,
                y0 + NOW_SIDE_Y, 1, 1,
                usageBurnUrgent(mins, usage.fiveHourResetInMin)
                  ? (usage.fiveHourPct >= 90 ? COLOR_BAD : COLOR_WARN) : COLOR_LABEL,
                COLOR_CARD, TR_DATUM);

  // formatResetIn(-1) already returns "no data yet" - no ternary needed.
  snprintf(buf, sizeof(buf), "%s", formatResetIn(usage.fiveHourResetInMin).c_str());
  padLeftTo(buf, sizeof(buf), SIDE_CHARS);
  drawIfChanged(left1Cache, sizeof(left1Cache), buf, CARD_X + CARD_W - PAD,
                y0 + NOW_SIDE_Y + NOW_SIDE_STEP, 1, 1, COLOR_LABEL, COLOR_CARD, TR_DATUM);

  int tickPct = usage.fiveHourResetInMin >= 0
                  ? (int) (100 - usage.fiveHourResetInMin * 100 / (5 * 60)) : -1;
  // stale-aware colour, not bare `color`: a bright bar beside a dimmed hero
  // and spark would read as live data - the same reasoning the Codex row's
  // bar already documents, and busted in the stale flip above (drawPaceBar
  // caches on (pct, tick) alone, so a colour-only change would not repaint).
  drawPaceBar(&bar1Cache, CARD_X + PAD, y0 + NOW_BAR_Y, CARD_W - 2 * PAD, BAR_H,
              usage.fiveHourPct, tickPct, stale ? COLOR_LABEL : color);

  drawUsageSpark(&spark1Cache, CARD_X + PAD, y0 + NOW_SPARK_Y, CARD_W - 2 * PAD,
                 nowSparkH(), stale ? COLOR_LABEL : color, COLOR_CARD);

  snprintf(buf, sizeof(buf), "%s",
           usage.sessionTokens > 0 ? formatTokens(usage.sessionTokens).c_str() : "");
  padTo(buf, sizeof(buf), 12);
  drawIfChanged(right1Cache, sizeof(right1Cache), buf, CARD_X + PAD, y0 + nowMetaY(),
                2, 1, COLOR_LABEL, COLOR_CARD);

  if (stale) {
    long m = usage.quotaAgeSec / 60;
    if (m < 60) snprintf(buf, sizeof(buf), "stale %ldm", m);
    else        snprintf(buf, sizeof(buf), "stale %ldh", m / 60);
  } else {
    // DERIVED FROM THE RING'S ACTUAL SPAN, not assumed from a full one - a
    // partial ring (e.g. two samples five minutes apart) must not read "LAST
    // 2.5H", which is the span of a FULL ring. See usageRingSpanMin()/
    // usageSpanCaption() above.
    usageSpanCaption(buf, sizeof(buf), usageRingSpanMin());
  }
  // padLeftTo to 10, the longest value this field can hold ("no history"; the
  // others are "LAST 2.5H"/"LAST 59M" and staleTxt's 9). That is all the
  // padding has to do - blank a previously-longer value - and it leaves
  // resetAt1Cache[14] three bytes of headroom. Padding to 13 fills that cache
  // EXACTLY, which is correct today and silently truncates the first time
  // anyone widens this field.
  padLeftTo(buf, sizeof(buf), 10);
  drawIfChanged(resetAt1Cache, sizeof(resetAt1Cache), buf, CARD_X + CARD_W - PAD,
                y0 + nowMetaY(), 1, 1, stale ? COLOR_BAD : COLOR_LABEL, COLOR_CARD, TR_DATUM);
}

// The 7-day card, v2: SECONDARY, so a T_HEAD (24px) number rather than a 64px
// hero - that size contrast against NOW's hero IS the hierarchy this whole
// redesign exists for. Fable moves INTO this card and gains a real labelled
// bar: it is the SAME 7-day window rather than a separate thing, and it is the
// SCARCER cap, which v1 rendered as an 8px crumb in a shared foot row with no
// bar and no colour.
void renderWeekCard() {
  char buf[BURN_LABEL_BYTES + 8];
  const int y0 = weekCardY();
  const long WIN = 7L * 24 * 60;
  bool stale = usage.quotaAgeSec > QUOTA_STALE_SEC;
  uint16_t color = colorForPct(usage.sevenDayPct);
  drawCardBorder(&border2Cache, CARD_X, y0, CARD_W, weekCardH(), color);

  // T_HEAD, not T_HERO. The week is background rather than the thing that stops
  // you working, and the size contrast against NOW's 64px IS the hierarchy.
  if (usage.sevenDayPct >= 0) snprintf(buf, sizeof(buf), "%d%%", usage.sevenDayPct);
  else snprintf(buf, sizeof(buf), "--");
  padTo(buf, sizeof(buf), 4);
  drawIfChanged(pct2Cache, sizeof(pct2Cache), buf, CARD_X + PAD, y0 + weekNumY(),
                3, 1, stale ? COLOR_LABEL : COLOR_VALUE, COLOR_CARD);

  // THE AVERAGE, NOT THE RING: at a 7-day window the ring moves 1.49 points
  // across its span, inside the integer-percent rounding. usageBurnMinutes picks
  // it on windowMin, so passing WIN here is what selects the estimator.
  long mins = usageBurnMinutes(usage.sevenDayPct, usage.sevenDayResetInMin, WIN, stale);
  usageBurnLabel(buf, BURN_LABEL_BYTES, mins, usage.sevenDayResetInMin);
  padLeftTo(buf, sizeof(buf), SIDE_CHARS);
  drawIfChanged(burn2Cache, sizeof(burn2Cache), buf, CARD_X + CARD_W - PAD,
                y0 + weekBurnY(), 1, 1,
                usageBurnUrgent(mins, usage.sevenDayResetInMin)
                  ? (usage.sevenDayPct >= 90 ? COLOR_BAD : COLOR_WARN) : COLOR_LABEL,
                COLOR_CARD, TR_DATUM);

  int tickPct = usage.sevenDayResetInMin >= 0
                  ? (int) (100 - usage.sevenDayResetInMin * 100 / WIN) : -1;
  // Same stale-aware colour as NOW's bar above, for the same reason: the ALL
  // bar sits directly over the Fable bar below it, which already dims - a
  // bright ALL bar over a dimmed Fable bar was the inconsistency this fixes.
  drawPaceBar(&bar2Cache, CARD_X + PAD, y0 + weekBarY(), CARD_W - 2 * PAD, BAR_H,
              usage.sevenDayPct, tickPct, stale ? COLOR_LABEL : color);

  snprintf(buf, sizeof(buf), "%s",
           usage.weekAllTokens > 0 ? formatTokens(usage.weekAllTokens).c_str() : "");
  padTo(buf, sizeof(buf), 12);
  drawIfChanged(left2Cache, sizeof(left2Cache), buf, CARD_X + PAD, y0 + weekMetaY(),
                2, 1, COLOR_LABEL, COLOR_CARD);

  if (stale) {
    long m = usage.quotaAgeSec / 60;
    if (m < 60) snprintf(buf, sizeof(buf), "stale %ldm", m);
    else        snprintf(buf, sizeof(buf), "stale %ldh", m / 60);
  } else {
    snprintf(buf, sizeof(buf), "%s", usage.sevenDayResetInMin >= 0
               ? formatResetIn(usage.sevenDayResetInMin).c_str() : "no data yet");
  }
  padLeftTo(buf, sizeof(buf), 12);
  drawIfChanged(right2Cache, sizeof(right2Cache), buf, CARD_X + CARD_W - PAD,
                y0 + weekMetaY(), 2, 1, stale ? COLOR_BAD : COLOR_LABEL, COLOR_CARD, TR_DATUM);

  // FABLE, IN THIS CARD, because Fable IS the same 7-day window rather than a
  // separate thing - and it is the SCARCER cap, which v1 rendered as an 8px
  // crumb in a shared foot row with no bar at all. Its tick is the 7-day tick.
  if (usage.weekFablePct >= 0) snprintf(buf, sizeof(buf), "FABLE  %d%%", usage.weekFablePct);
  else snprintf(buf, sizeof(buf), "FABLE  --");
  padTo(buf, sizeof(buf), 10);
  drawIfChanged(fable1Cache, sizeof(fable1Cache), buf, CARD_X + PAD, y0 + weekFableY(),
                2, 1, COLOR_LABEL, COLOR_CARD);

  snprintf(buf, sizeof(buf), "%s",
           usage.weekFableTokens > 0 ? formatTokens(usage.weekFableTokens).c_str() : "");
  padLeftTo(buf, sizeof(buf), 12);
  drawIfChanged(fable2Cache, sizeof(fable2Cache), buf, CARD_X + CARD_W - PAD,
                y0 + weekFableY(), 2, 1, COLOR_LABEL, COLOR_CARD, TR_DATUM);

  drawPaceBar(&fableBarCache, CARD_X + PAD, y0 + weekFableBarY(), CARD_W - 2 * PAD, BAR_H,
              usage.weekFablePct < 0 ? 0 : usage.weekFablePct, tickPct,
              usage.weekFablePct < 0 ? COLOR_UNKNOWN
                                     : (stale ? COLOR_LABEL : colorForPct(usage.weekFablePct)));
}
#endif  // BOARD_USAGE_V2

// Codex's row. One line, because Codex publishes one number: a percentage of its
// primary window and when that window resets. No token count, no second window, and
// nothing to plot a pace against - so a full card would be mostly empty chrome.
// Dimmed on stale data for the same reason the hero numbers are: this figure comes
// out of a rollout file, and a file that stopped being written keeps its last value
// forever.
void renderCodexRow() {
  // Nothing to draw, and nothing to CLEAR either - on BOTH boards, by two different
  // routes. Board 2's layout flip repaints the whole content area; board 1's flip
  // clears this row's own rect and busts the four caches that cover it (see
  // renderUsageTab's bust). Either way the row's old pixels are gone before this
  // returns, so an early return here can never strand them.
  if (!usageCodexShown()) return;
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
  // NOT the same question the early return above asks. That predicate is
  // "is the ROW on screen at all" (usageCodexShown(), board 2 only); this is
  // "is there a READING to print" (-- versus a percentage), which board 1
  // still needs on every tick, having no predicate of its own. They agree
  // only because both test cxPct < 0 - do not fold `have` into the return
  // above or delete its two branches as "always true now": that compiles,
  // is internally consistent, and silently breaks board 1's --/percentage
  // switch (and its byte-identity) while every assertion here stays green.
  bool have = usage.cxPct >= 0;
  bool stale = usage.cxAgeSec > 900;
  uint16_t color = have ? colorForPct(usage.cxPct) : COLOR_UNKNOWN;
#if BOARD_USAGE_V2
  drawCardBorder(&cxBorderCache, CARD_X, codexRowY(), CARD_W, CODEX_H, color);
#else
  drawCardBorder(&cxBorderCache, CARD_X, CODEX_Y, CARD_W, CODEX_H, color);
#endif

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
#if BOARD_USAGE_V2
  drawIfChanged(cxPctCache, CODEX_LANE_CACHE, buf, CARD_X + PAD, codexRowY() + CODEX_TEXT_Y, 2, 1,
                COLOR_LABEL, COLOR_CARD);
#else
  drawIfChanged(cxPctCache, CODEX_LANE_CACHE, buf, CARD_X + PAD, CODEX_Y + CODEX_TEXT_Y, 2, 1,
                COLOR_LABEL, COLOR_CARD);
#endif
  if (showCxIcon) {
    // "CX" + 4px gap + the icon, from the label's x, at each board's own
    // advance: 12+4+13 = 29px ending at 55 on board 1, and 16+4+16 = 36px
    // ending at 66 on board 2 - well clear of the right field's clear box
    // either way (105 and 145, see the right-lane derivation below).
    // Vertically the icon shares CODEX_TEXT_Y with
    // the row's text, whose own clear box is 2 rows taller than the icon on
    // both boards. See the long derivation above.
    setUIFont(2);
#if BOARD_USAGE_V2
    drawEmoji(cxEmoji, CARD_X + PAD + tft.textWidth("CX") + 4, codexRowY() + CODEX_TEXT_Y, COLOR_CARD);
#else
    drawEmoji(cxEmoji, CARD_X + PAD + tft.textWidth("CX") + 4, CODEX_Y + CODEX_TEXT_Y, COLOR_CARD);
#endif
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
#if BOARD_USAGE_V2
  drawIfChanged(cxRightCache, CODEX_LANE_CACHE, buf, CARD_X + CARD_W - PAD, codexRowY() + CODEX_TEXT_Y, 2, 1,
                stale ? COLOR_LABEL : (have ? COLOR_VALUE : COLOR_LABEL), COLOR_CARD, TR_DATUM);
#else
  drawIfChanged(cxRightCache, CODEX_LANE_CACHE, buf, CARD_X + CARD_W - PAD, CODEX_Y + CODEX_TEXT_Y, 2, 1,
                stale ? COLOR_LABEL : (have ? COLOR_VALUE : COLOR_LABEL), COLOR_CARD, TR_DATUM);
#endif

  // Pace bar, with the same tick the Claude cards carry: fill ahead of the marker means
  // quota is going faster than time. tickPct -1 when either input is missing, which
  // drawPaceBar already renders as "no tick" - no special case needed here.
  // The bar dims WITH the number when the reading is stale; a bright bar beside a dimmed
  // percentage would read as live data. drawPaceBar caches on (pct, tick) only, so the
  // colour change alone would not repaint - renderUsageTab busts cxBarCache on the flip.
  int tickPct = (have && usage.cxResetInMin >= 0 && usage.cxWindowMin > 0)
                    ? (int) (100 - usage.cxResetInMin * 100 / usage.cxWindowMin)
                    : -1;
#if BOARD_USAGE_V2
  drawPaceBar(&cxBarCache, CARD_X + PAD, codexRowY() + CODEX_BAR_Y, CARD_W - 2 * PAD, BAR_H,
              have ? usage.cxPct : 0, tickPct, stale ? COLOR_LABEL : color);
#else
  drawPaceBar(&cxBarCache, CARD_X + PAD, CODEX_Y + CODEX_BAR_Y, CARD_W - 2 * PAD, BAR_H,
              have ? usage.cxPct : 0, tickPct, stale ? COLOR_LABEL : color);
#endif
}
void renderUsageTab() {
  if (!everReceived) return;
  // When staleness flips, bust the hero-number caches so their dim/normal
  // color actually repaints - drawBigNumber only redraws on a text change,
  // and a stale % often keeps the same digits (e.g. a frozen "0%").
#if BOARD_USAGE_V2
  // ONE SPELLING OF ONE THRESHOLD. The colour the v2 fields take is decided by
  // QUOTA_STALE_SEC in renderNowCard/renderWeekCard. If this bust fired on a
  // different value, the window between the two would leave bar1Cache, bar2Cache
  // and fableBarCache holding a wrong hue INDEFINITELY - all three key on
  // (pct, tick) and cannot self-heal. Board 1 keeps the literal below, so its
  // binary cannot move.
  int stale = usage.quotaAgeSec > QUOTA_STALE_SEC ? 1 : 0;
#else
  int stale = usage.quotaAgeSec > 900 ? 1 : 0;
#endif
  if (stale != quotaStaleCache) {
    quotaStaleCache = stale;
    pct1Cache[0] = '\0';
    pct2Cache[0] = '\0';
#if BOARD_USAGE_V2
    // Every v2 field dims with the card, and FOUR of them would never repaint
    // on their own: drawPaceBar keys its cache on (pct, tick) alone and
    // drawUsageSpark on the ring's content hash, so a colour-only change
    // moves neither. This is the same bust cxBarCache already needs below,
    // for the same reason.
    burn1Cache[0] = '\0';
    burn2Cache[0] = '\0';
    spark1Cache = 0;
    bar1Cache = -2;
    bar2Cache = -2;
    fableBarCache = -2;
#endif
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
  //
  // THE ACCOUNT belongs in this bust too (acctNow = usageAcctSelIdx * 8 +
  // usageAcctCount). An account switch can change values without changing the
  // text any cache compares against, and the header's account label lives on
  // the card CHROME, which repaints through this bust and nothing else. The
  // selection moving and an account arriving or leaving each change that one
  // int - and the COUNT is what gates the label (usageAcctCount > 1), so a
  // second account arriving after the chrome was last painted would otherwise
  // leave both Claude cards unlabelled. That exact shape was a real bug once
  // with the old Mac-count gate: a second Mac arrived, the Codex row (a
  // different draw call, rendered per tick) showed its tag and both Claude
  // cards did not - observed on hardware, with two real Macs connected. The
  // packing is collision-free because a count never exceeds MAX_LINKS (2) < 8,
  // and usage-account-check.mjs asserts that from the parsed MAX_LINKS. It
  // replaces both the old PIN term (no pin any more) and the old usedLinkCount()
  // term (nothing on this chrome reads the Mac count now - the count it is
  // gated on is inside acctNow).
  //
  // THE LABEL ITSELF, and whether it is a NAME, belong here as well (labelNow =
  // '1'/'0' for usageAcctNamed() + usageAcctLabel()). acctTag and tag are
  // overwritten by every payload, and a host restarted with a new or cleared
  // DECKHAND_ACCOUNT_TAG (or a renamed Mac) that is back inside LINK_STALE_MS keeps
  // its slot - so the source, the account term and the icon id are all unchanged,
  // and without this the header kept the old name, or kept the ICON where the new
  // name now replaces it, until some unrelated repaint. Ordinary on board 2, whose
  // native USB CDC does not reset when the host restarts. A STRING cache, not a
  // hash: exact, and sized from HostLink's own tag buffer so it can never be the
  // cache-shorter-than-its-string trap (the static_assert holds acctTag to it).
  // The Claude cards' icon id joins the bust too: an icon change (set,
  // cleared, or the source Mac swapping to one with a different icon) moves
  // no percentage, no source link and no account term, so nothing else here
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
  static_assert(sizeof(HostLink::acctTag) <= sizeof(HostLink::tag),
                "labelCache is sized from HostLink::tag; acctTag must fit it too");
#if BOARD_USAGE_V2
  static int srcCache = -2, cxSrcCache = -2, acctCache = -1,
             emojiCache = -3, codexShownCache = -1;
  static char labelCache[1 + sizeof(HostLink::tag)] = "";
  int acctNow = usageAcctSelIdx * 8 + usageAcctCount;
  char labelNow[sizeof(labelCache)];
  snprintf(labelNow, sizeof(labelNow), "%c%s", usageAcctNamed() ? '1' : '0', usageAcctLabel());
  int emojiNow = emojiIdForLink(usageAcctLabelLink());
  int codexShownNow = usageCodexShown() ? 1 : 0;
  if (srcCache != usageSourceLink || cxSrcCache != cxSourceLink ||
      acctCache != acctNow || strcmp(labelCache, labelNow) != 0 ||
      emojiCache != emojiNow || codexShownCache != codexShownNow) {
    // THE LAYOUT MOVES THE CARD BORDERS, so this is the one bust term that
    // needs more than a chrome repaint. Without the clear, NOW growing past
    // where WEEK used to start leaves a band of the old card behind, and the
    // fields then draw at the new offsets inside the old boxes - the settings
    // branch's "a live field drew a control into chrome that did not exist",
    // arriving through geometry instead of a count.
    // NOTE: if the layout flips while a DIFFERENT tab is showing,
    // switchTab(TAB_USAGE) already clears the content area and calls
    // drawUsageStatic() fresh for the new layout - and this bust then fires
    // on its own stale codexShownCache and clears/paints the identical
    // column a second time. Invisible today, because switchTab's own clear
    // already ran first, but it is exactly the double-draw the USAGE tap
    // handler in deckhand_display.ino explicitly refuses to create by
    // routing through this bust rather than calling drawUsageStatic()
    // directly. Worth fixing alongside that handler if this bust is ever
    // reworked, not on its own.
    if (codexShownCache != codexShownNow && codexShownCache != -1)
      tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
    srcCache = usageSourceLink;
    cxSrcCache = cxSourceLink;
    acctCache = acctNow;
    strlcpy(labelCache, labelNow, sizeof(labelCache));
    emojiCache = emojiNow;
    codexShownCache = codexShownNow;
    drawUsageStatic();   // repaints chrome; resetUsageCaches() runs inside it
  }
#else
  static int srcCache = -2, cxSrcCache = -2, acctCache = -1,
             emojiCache = -3, codexShownCache = -1;
  static char labelCache[1 + sizeof(HostLink::tag)] = "";
  int acctNow = usageAcctSelIdx * 8 + usageAcctCount;
  char labelNow[sizeof(labelCache)];
  snprintf(labelNow, sizeof(labelNow), "%c%s", usageAcctNamed() ? '1' : '0', usageAcctLabel());
  int emojiNow = emojiIdForLink(usageAcctLabelLink());
  int codexShownNow = usageCodexShown() ? 1 : 0;
  if (srcCache != usageSourceLink || cxSrcCache != cxSourceLink ||
      acctCache != acctNow || strcmp(labelCache, labelNow) != 0 ||
      emojiCache != emojiNow) {
    srcCache = usageSourceLink;
    cxSrcCache = cxSourceLink;
    acctCache = acctNow;
    strlcpy(labelCache, labelNow, sizeof(labelCache));
    emojiCache = emojiNow;
    drawUsageStatic();   // repaints chrome; resetUsageCaches() runs inside it
  }
  // THE CODEX ROW APPEARING OR DISAPPEARING, handled on its OWN flip and NOT by
  // folding codexShownNow into the chrome bust above. Board 2 can afford to route
  // its flip through drawUsageStatic() because the layout MOVES - its other two
  // cards grow into the freed space, so every border has to be repainted anyway.
  // Nothing moves here: CARD1_Y and CARD2_Y are fixed, and this board draws STRAIGHT
  // TO THE GLASS, so clearing and repainting two untouched cards is a visible flash
  // of the whole tab for a row that changed 44px. So this clears exactly the row's
  // own rect and repaints exactly its own chrome.
  //
  // THE FOUR CACHES ARE BUSTED BECAUSE THE PIXELS UNDER THEM WERE JUST ERASED, and
  // this is the trap this repo pays for most often - a field whose CHROME is
  // repainted but whose cache is not reset is left BLANK, because drawIfChanged
  // reads "hasn't changed" from a cache describing pixels that no longer exist.
  // Each one covers part of the rect cleared below and each would otherwise skip:
  //   cxPctCache    the left lane's text, compared as a STRING - "CODEX  7d" before
  //                 the hide equals "CODEX  7d" after the show, so it would not redraw
  //   cxRightCache  the right lane, the same way (and it is the one that held "--")
  //   cxBorderCache drawCardBorder caches the border COLOUR as an int; an unchanged
  //                 colour skips the stroke, leaving a card with no outline
  //   cxBarCache    drawPaceBar keys on (pct, tick) only, so an unchanged reading
  //                 skips the bar entirely
  // cxStaleCache is deliberately NOT busted: it is not a picture of any pixels, it
  // is the dim-state edge detector that drives the four above, and clearing it would
  // only cost one redundant repaint on the next tick.
  if (codexShownCache != codexShownNow) {
    if (codexShownCache != -1) {
      tft.fillRect(CARD_X, CODEX_Y, CARD_W, CODEX_H, COLOR_BG);
      cxPctCache[0] = '\0';
      cxRightCache[0] = '\0';
      cxBorderCache = -1;
      cxBarCache = -1;
      if (codexShownNow) uiCard(CARD_X, CODEX_Y, CARD_W, CODEX_H, COLOR_CARD);
    }
    codexShownCache = codexShownNow;
  }
#endif
#if BOARD_USAGE_V2
  renderNowCard();
  renderWeekCard();
#else
  renderCard(CARD1_Y, usage.fiveHourPct, usage.sessionTokens, usage.fiveHourResetInMin,
             5 * 60, pct1Cache, left1Cache, right1Cache, fable1Cache, resetAt1Cache,
             &bar1Cache, &border1Cache);
  renderCard(CARD2_Y, usage.sevenDayPct, usage.weekAllTokens, usage.sevenDayResetInMin,
             7 * 24 * 60, pct2Cache, left2Cache, right2Cache, fable2Cache, resetAt2Cache,
             &bar2Cache, &border2Cache, usage.weekFableTokens, usage.weekFablePct);
#endif
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
  // mergeUsage(), so they always carry the same account label.
#if BOARD_USAGE_V2
  // v2 labels and heights, matched to renderNowCard/renderWeekCard's own
  // NOW_CARD_H/WEEK_CARD_H - the same heights CARD1_Y/CARD2_Y/CODEX_Y in the
  // board header now derive from. "NOW", not "SESSION", because this card is
  // the one that stops you working - the semantic hierarchy this redesign is
  // for (docs/design/usage-redesign/usage.js's selected layout B).
  drawCardChrome(CARD1_Y, "NOW - 5 HOUR WINDOW", usageAcctLabel(), nowCardH());
  drawCardChrome(weekCardY(), "WEEK - 7 DAY, ALL MODELS", usageAcctLabel(), weekCardH());
#else
  drawCardChrome(CARD1_Y, "SESSION - 5 HOUR WINDOW", usageAcctLabel());
  drawCardChrome(CARD2_Y, "WEEK - 7 DAY, ALL MODELS", usageAcctLabel());
#endif
  // ONE gated call, with only the Y behind the guard - board 2's row moves with the
  // layout, board 1's is fixed at CODEX_Y. Board 1 used to paint this card
  // unconditionally, which is what left "CODEX  --" on the glass for ever.
#if BOARD_USAGE_V2
  const int cxY = codexRowY();
#else
  const int cxY = CODEX_Y;
#endif
  if (usageCodexShown()) uiCard(CARD_X, cxY, CARD_W, CODEX_H, COLOR_CARD);
}
