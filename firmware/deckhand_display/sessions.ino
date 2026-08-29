// Sessions tab: the row list, the detail screen, and the ask/answer screen.
// Split out of deckhand_display.ino - see pairing.ino for how the concatenated
// build works and what may not move.

bool sessionRowsLarge() { return sessionRowH >= SESSION_LARGE_MIN_H; }

// ---------- The expanded first row ----------
// THE MOST URGENT SESSION ABSORBS THE HEIGHT THE LADDER LEAVES EMPTY. With one
// session board 2 drew a 100px row and 307px of nothing; the top row of the
// urgency-sorted list now takes that space and every other row keeps exactly the
// height the ladder already gave it. The rule, the six heights it produces and the
// packed stack it is bounded by are all derived in board_es3c35p.h beside
// SESSION_EXP_MIN_H, and re-derived by sessions-geom-check.mjs.
//
// Board 1 has no surplus to give - its one-session rung is 90 of a 264px content
// area - so it returns 0 unconditionally and none of the code below is compiled
// into it.
int sessionExpandedH(int count) {
#if BOARD_USES_TFT_ESPI
  (void) count; return 0;
#else
  const int cand = sessionExpCandidateH(count);
  // THE LADDER'S LEFTOVER IS THE CEILING, NOT THE HEIGHT. §4: "if the derived
  // total lands below 410, the remainder stays OUTSIDE the card as list area
  // rather than becoming a card of air." So the card takes the smaller of what
  // the ladder can spare and what its own session actually fills, and the surplus
  // is list area - which is where it reads as the gap between cards rather than
  // as a rendering fault inside one.
  //
  // MEASURED, AND THIS IS THE DEFECT IT FIXES: the prompt block is BUDGETED four
  // lines at the cap and a real prompt often wraps to two, so 48px pooled between
  // the prompt and the bottom-anchored path rule - against a normal inter-block
  // leading of 9-19px, which reads as a hole. A session with no prompt yet - the
  // just-started case, i.e. exactly the one-session screen this card exists for -
  // pooled 142px with a title and 182 without.
  //
  // FLOWING THE PATH UP WITH THE CURSOR IS NOT THE FIX: it moves the hole to the
  // card's bottom edge and re-creates the trailing air inside the card that the
  // 288 floor was raised to remove. The anchor STAYS, and it lands on the cursor
  // by construction now that the height is the cursor's own end.
  if (cand <= 0) return 0;
  return (expCardH > 0 && expCardH < cand) ? expCardH : cand;
#endif
}
#if !BOARD_USES_TFT_ESPI
// The list area the rows divide up, in ONE expression. renderSessionsList works it
// out for the ladder and both helpers below need the same number; a second copy
// here is how the two would come to disagree about where the list ends.
int sessionListAvail(int count) {
  int hidden = sessionsTotal - count;
  return contentBottom() - SESSION_ROW_Y0 - (hidden > 0 ? SESSION_OVERFLOW_H : 0);
}
// How many prompt lines an expanded row of this height budgets. Every
// SESSION_BAND_PROMPT_STEP above the floor buys exactly one more, up to the
// field's own byte cap (see SESSION_EXP_MAX_H) - and the DRAW asks this rather
// than deciding for itself, so a card can never draw a line its height did not
// pay for.
//
// THE STEP IS THE PROMPT BLOCK, NOT SESSION_LINE_H, and that is forced rather
// than tidier: the body's prompt lines are laid out at SESSION_BAND_PROMPT_STEP
// (24), so a budget counted in 16px cells would grant a line the card has only
// 16px left for and the path row would be pushed through its own bottom border.
// It is the same arithmetic SESSION_EXP_MAX_H is derived by, run backwards -
// MAX == MIN + (PROMPT_MAX - PROMPT_MIN) * STEP - which is why the floor and the
// cap cannot drift apart.
//
// THE ARGUMENT IS THE BODY'S HEIGHT, NOT THE CARD'S - the caller passes
// rowH LESS the band - so the floor it is measured against has to have the band
// taken off it too. SESSION_EXP_MIN_H is the whole card's floor; the two roles
// that constant serves differ by exactly SESSION_BAND_H, which is why this
// is a subtraction here rather than a second constant in the header that could
// drift from the gate it has to agree with.
int sessionExpPromptLines(int bodyH) {
  int n = SESSION_EXP_PROMPT_MIN +
          (bodyH - (SESSION_EXP_MIN_H - SESSION_BAND_H)) / SESSION_BAND_PROMPT_STEP;
  if (n < SESSION_EXP_PROMPT_MIN) n = SESSION_EXP_PROMPT_MIN;
  return n > SESSION_EXP_PROMPT_MAX ? SESSION_EXP_PROMPT_MAX : n;
}
// The ladder's own grant: what the leftover allows, before the card's content caps
// it. Split out of sessionExpandedH so the two questions stay separable - "is
// there room for a band card at all", which is the SESSION_EXP_MIN_H gate and
// unchanged, and "how much of that room does this card need", which is the
// measurement below. The prompt BUDGET is taken from this number rather than from
// the final height, because it is the budget the height is then derived from.
//
// sessionRowH is the LADDER'S OWN OUTPUT for this count (renderSessionsList
// computes it before anything here can run), so the leftover is measured
// against the very number the compact rows are drawn at rather than against a
// second copy of the ladder formula that could drift from it.
int sessionExpCandidateH(int count) {
  if (count < 1) return 0;
  int leftover = sessionListAvail(count) - (count - 1) * (sessionRowH + SESSION_ROW_GAP);
  if (leftover < SESSION_EXP_MIN_H) return 0;   // the ladder already fills the column
  return leftover > SESSION_EXP_MAX_H ? SESSION_EXP_MAX_H : leftover;
}
// THE BAND CARD'S HEIGHT, MEASURED FROM WHAT IT WILL DRAW. Walks exactly the block
// stack drawSessionRow's cursor walks - name, agent/model/branch, title, a rule,
// LAST PROMPT + prompt, a rule, path, pad - taking the REAL wrapped line counts
// where the cap's derivation takes the worst case. A block the card does not draw
// costs nothing, which is the whole point: a Codex row has no title and a
// just-started session has no prompt.
//
// countWrappedLines, not a column count: it is the same helper drawWrappedText
// wraps with, so the two cannot disagree about where a line breaks. A model that
// divided the lane by TEXT_ADV would be right about Spleen's advance and wrong
// about the word-friendly break wrapLineLen prefers.
//
// CALLED ONCE PER RENDER PASS, from the top of renderSessionsList. It measures
// text, and measuring means setUIFont() - see the note on expCardH for why that
// must not happen inside an animation tick or mid-draw.
void sessionExpMeasure() {
  expCardH = 0;
  expCardPrompt = 0;
  const int cand = sessionExpCandidateH(sessionCount);
  if (cand <= 0) return;
  const int i = sessionAt(0);
  if (i < 0 || i >= sessionCount) return;
  const SessionInfo& s = sessions[i];
  // THE LANE THE DRAW WRAPS AT, not the ordinary row's. The two must be the same
  // number or this measurement and drawSessionRow disagree about where a line
  // breaks - and since the card's HEIGHT is this sum, a disagreement changes the
  // card's SIZE, not merely its text.
  const int lane = SESSION_BAND_BODY_LANE;
  char sub[36];
  buildSessionSubline(i, sub, sizeof(sub));
  int h = SESSION_BAND_H + SESSION_BAND_NAME_H;
  if (sub[0]) h += SESSION_BAND_SUB_H;
  if (s.title[0]) {
    // The BUDGET is still SESSION_EXP_TITLE_LINES - a longer title is trimmed by
    // drawWrappedText's own maxLines - but a title that fits on one line costs one
    // line, which is the same thing the draw already does by taking the returned y.
    int n = countWrappedLines(s.title, T_BODY, lane);
    if (n > SESSION_EXP_TITLE_LINES) n = SESSION_EXP_TITLE_LINES;
    h += n * SESSION_BAND_TITLE_STEP;
  }
  if (s.prompt[0]) {
    // THE BUDGET STILL COMES FROM sessionExpPromptLines(), and it is still the
    // guard it always was: the card can never draw more prompt lines than the
    // ladder's grant paid for. What changed is that a SHORTER wrap now shortens
    // the CARD instead of leaving the difference as air inside it.
    // The argument is the CANDIDATE less the band, not the final height - the
    // final height is derived from this number, so reading it back off that would
    // be circular.
    int n = countWrappedLines(s.prompt, T_BODY, lane);
    const int budget = sessionExpPromptLines(cand - SESSION_BAND_H);
    if (n > budget) n = budget;
    if (n < 1) n = 1;      // a non-empty prompt always inks at least one line
    expCardPrompt = n;
    h += SESSION_BAND_RULE_H + SESSION_BAND_LABEL_H + n * SESSION_BAND_PROMPT_STEP;
  }
  if (s.path[0]) h += SESSION_BAND_RULE_H + SESSION_BAND_PATH_H;
  h += SESSION_BAND_BOTTOM_PAD;
  // Cannot exceed the grant - every block above is one the cap is summed from and
  // the prompt is capped by the grant's own budget - but clamped rather than
  // asserted, because a card taller than its slot would overdraw the row below it.
  expCardH = h > cand ? cand : h;
}
bool sessionRowExpanded(int pos) { return pos == 0 && sessionExpandedH(sessionCount) > 0; }
// The row stack, walked in ONE place. Draw, duration, spinner tick and the touch
// hit test all read these two, which is what stops an expanded first row making
// the hit test disagree with the layout - the uniform-height assumption those four
// sites used to share independently.
int sessionRowHAt(int pos) {
  int e = sessionExpandedH(sessionCount);
  return (pos == 0 && e > 0) ? e : sessionRowH;
}
int sessionRowYAt(int pos) {
  int e = sessionExpandedH(sessionCount);
  if (e <= 0) return SESSION_ROW_Y0 + pos * (sessionRowH + SESSION_ROW_GAP);
  if (pos == 0) {
    // ONE expanded card IS the whole list, so it sits in the MIDDLE of the list
    // area rather than at the top: 212 of 410 leaves 198px - 48% of the tab -
    // hanging below it, which reads as "a card, then nothing" however much content
    // the card itself carries. Centring costs no constant and no height.
    // ONLY when it is alone. In a mixed layout the stack's top alignment IS the
    // rhythm, and pushing the first card down would open a gap above a list that
    // still ends flush at the bottom - worse than the surplus it moved.
    if (sessionCount == 1) return SESSION_ROW_Y0 + (sessionListAvail(1) - e) / 2;
    return SESSION_ROW_Y0;
  }
  return SESSION_ROW_Y0 + e + SESSION_ROW_GAP + (pos - 1) * (sessionRowH + SESSION_ROW_GAP);
}
// The display row a y lands in, or -1 for a gap or for anything past the list.
int sessionRowAtY(int sy) {
  for (int pos = 0; pos < sessionCount; pos++) {
    int y = sessionRowYAt(pos);
    if (sy >= y && sy < y + sessionRowHAt(pos)) return pos;
  }
  return -1;
}
#else
// Board 1: the list is uniform, and these expand to exactly the expressions the
// four call sites carried before the helpers existed - which is what keeps its
// binary byte-identical.
static inline bool sessionRowExpanded(int pos) { (void) pos; return false; }
static inline int sessionRowHAt(int pos) { (void) pos; return sessionRowH; }
static inline int sessionRowYAt(int pos) { return SESSION_ROW_Y0 + pos * (sessionRowH + SESSION_ROW_GAP); }
#endif
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
    uiFillRound(x, y, w, PILL_H, PILL_H / 2, color, COLOR_CARD);
    tft.setTextColor(COLOR_BG, color);
  } else if (working) {
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  } else {
    uiStrokeRound(x, y, w, PILL_H, PILL_H / 2, BORDER_CTRL, color, COLOR_CARD);
    tft.setTextColor(color, COLOR_CARD);
  }
#if !BOARD_USES_TFT_ESPI
  // THE LABEL'S OWN BACKGROUND BOX DESTROYED THIS PILL, and the fix is to stop it
  // painting one at all. MC_DATUM centres on the ASCENT alone (TFT_eSPI's rule,
  // which the shim reproduces deliberately), so a face with a descent is biased
  // low by descent/2: Spleen8x16 (ascent 12, descent 4) puts its 16-row opaque box
  // at +3..+18 inside an 18px pill occupying +0..+17. That erased the bottom edge
  // at +17, BOTH bottom corner arcs and most of the top ones - an outlined pill
  // rendered as roughly "( READY )" with no bottom. Board 1 has the identical 2px
  // bias and absorbs it, because a 13px box in an 18px pill has the slack; this is
  // a consequence of a taller face, NOT a shim bug, so the shim's datum handling is
  // left exactly as upstream's.
  //
  // Setting fg == bg is TFT_eSPI's own "transparent" convention (drawString skips
  // the box when the two are equal, and the shim honours it), so the label draws
  // GLYPHS ONLY and can erase nothing. Its ink then lands at +3..+14 - the labels
  // are uppercase and carry no descender - which is exactly centred in 18px. Safe
  // for every caller because both of them (a session row, the detail card) repaint
  // their whole surface immediately before drawing the pill, so there is never a
  // stale label underneath for a transparent one to show through.
  uint16_t lblFg = asking ? COLOR_BG : (working ? COLOR_LABEL : color);
  tft.setTextColor(lblFg, lblFg);
#endif
  tft.setTextDatum(MC_DATUM);
  tft.drawString(label, x + w / 2, y + PILL_H / 2);
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
#if !BOARD_USES_TFT_ESPI
// ---------- The band's duration: ONE lane, ONE format, THREE readers ----------
// The band draws this field, the per-tick change-only update redraws it, and the
// word's lane is measured against it - so all three read these three helpers rather
// than each deriving the same number. A drift between the draw and the update is
// exactly how a clear box ends up somewhere the ink is not.
//
// The left edge is where drawIfChanged's clear box STARTS (its fx - 1), not where
// the text does, because that box is the thing the word has to stay clear of.
int bandDurLeft(int x, int w) {
  return x + w - SESSION_BAND_PAD - SESSION_BAND_DUR_CHARS * TEXT_ADV - 1;
}
int bandDurDY() { return (SESSION_BAND_H - BORDER_CARD - uiLineH(T_BODY)) / 2; }
// The agent mark's ORIGIN inside the band, as two helpers rather than an
// expression copied into its two readers - the band's own draw, and the 120ms
// tick that advances the mark in place. An animation redrawing at an origin the
// draw has since moved is exactly how the last fix to this device's row indicator
// was undone once, and that was a literal in two places too.
int bandMarkX(int x) { return x + SESSION_BAND_PAD; }
int bandMarkY(int y) { return y + (SESSION_BAND_H - BORDER_CARD - SPARK_SIZE) / 2; }
// The body's hairline rule. A 1px fillRect, never a drawString or a drawFastHLine
// on a cleared box: it sits inside a card that repaints WHOLESALE, so it owns no
// clear box of its own and cannot reach the border it runs parallel to. Bounded
// to the same text lane every block above and below it uses, so the three left
// edges line up by construction.
void drawBandRule(int x, int y, int w) { tft.fillRect(x, y, w, 1, COLOR_LABEL); }
// ONE unit, so the field is bounded at SESSION_BAND_DUR_CHARS: "59s", "59m", "23h",
// "49d" - and 49 days is the ceiling by construction, since statusSinceMillis is a
// millis() value and that wraps at 49.7. The rows below keep formatDuration's fuller
// "12h34m", which has a line to itself; this field has 24 pixels beside the word.
void bandDurText(int i, char* buf, size_t n) {
  unsigned long sec = (millis() - sessions[i].statusSinceMillis) / 1000;
  if (sec < 60) snprintf(buf, n, "%lus", sec);
  else if (sec < 3600) snprintf(buf, n, "%lum", sec / 60);
  else if (sec < 86400) snprintf(buf, n, "%luh", sec / 3600);
  else snprintf(buf, n, "%lud", sec / 86400);
  padLeftTo(buf, n, SESSION_BAND_DUR_CHARS);
}
// ---------- §6 The crossfade's two readers ----------
// Progress through the fade for THIS session, 0..255, or -1 when it is not the
// one fading (or nothing is). Every caller asks by id rather than by row, so a
// re-rank mid-fade moves the animation with the session instead of leaving it on
// whatever now sits at that display position.
int sessionXfadeT(const char* id) {
  if (!xfadeId[0] || !id || !id[0] || strcmp(xfadeId, id) != 0) return -1;
  const unsigned long e = millis() - xfadeStart;
  if (e >= SESSION_XFADE_MS) return -1;
  return (int) ((e * 255UL) / SESSION_XFADE_MS);
}
// ---------- §6 The attention pulse's ramp ----------
// The breath's strength RIGHT NOW, 0 when the pulse is off or this session is not
// the one waiting on a person. A free-running triangle over SESSION_PULSE_MS
// rather than a phase started on the asking edge: there is only ever ONE band, so
// there is nothing for a per-session phase to keep apart, and a free-running ramp
// means a crossfade INTO asking lands on a breath already in progress instead of
// jumping to zero the instant the fade ends.
//
// A TRIANGLE, NOT A SINE. Integer, no table, no float - and the eased shape would
// be invisible anyway: RGB565 gives this ramp six distinct colours (see
// SESSION_PULSE_INTERVAL_MS), so the easing has nowhere to show.
//
// millis() wraps at 49.7 days and the modulo wraps the phase with it, which puts
// one discontinuous step in the breath every 49.7 days. Recorded rather than
// guarded: the same wrap is already what bounds SESSION_BAND_DUR_CHARS at 3.
uint8_t sessionPulseA(const char* status) {
  if (!sessionPulse || strcmp(status, "asking") != 0) return 0;
  const unsigned long half = SESSION_PULSE_MS / 2;
  const unsigned long e = millis() % SESSION_PULSE_MS;
  const unsigned long up = e < half ? e : SESSION_PULSE_MS - e;
  return (uint8_t) ((unsigned long) SESSION_PULSE_MAX * up / half);
}
// The band's fill RIGHT NOW: the status colour, or the crossfade's blend while
// one is running. TWO readers, and the second is the reason this is a function.
// The band's duration is a change-only field whose drawIfChanged paints an
// OPAQUE box in this colour, and that field's cache is cleared by the very row
// repaint a status change causes - so without this it would paint a
// three-character patch of the TARGET colour onto a band still travelling
// towards it, on the first tick of every fade.
// TAKES `t` RATHER THAN READING THE CLOCK, so the band's fill and its two words
// are guaranteed to be the same instant of the fade: computing sessionXfadeT
// twice inside one draw lets millis() tick between them, and the colour would
// then be one step of 255 ahead of the ink on top of it.
// TAKES THE PULSE'S ALPHA RATHER THAN READING THE CLOCK AGAIN, for exactly the
// reason it takes `t`: the band's fill and the two words drawn on it must be one
// instant of the animation, and a second millis() read inside this call would let
// the ramp move between them.
// THE PULSE COMPOSES ON TOP OF THE CROSSFADE, never beside it - so a fade INTO
// asking arrives at a band that is already breathing, with no seam at the moment
// the fade ends.
uint16_t sessionBandFill(uint16_t col, int t, uint8_t pulseA) {
  const uint16_t base = t < 0 ? col : blend565(colorForStatus(xfadeFrom), col, (uint8_t) t);
  return pulseA ? blend565(base, COLOR_VALUE, pulseA) : base;
}
// Start a fade. Called from the prevSessions diff, which is the only place that
// knows a TRANSITION happened rather than that a value differs from a cache.
void startSessionXfade(const char* id, const char* from) {
  if (!id || !id[0]) return;      // a host that predates ids cannot be tracked
  copyField(xfadeId, sizeof(xfadeId), id);
  copyField(xfadeFrom, sizeof(xfadeFrom), from);
  xfadeStart = millis();
  lastXfadeMs = 0;                // paint the first frame on the next tick
  xfadeStartCount++;
}
// The band's status word, uppercased and fitted to the lane. ONE copy, because
// the crossfade needs the SAME treatment for the word it is leaving as for the
// one it is arriving at - a second, subtly different fit would show as the two
// words disagreeing about where they start.
// Requires T_HEAD to be the live font: fitText measures.
void bandStatusWord(const char* status, char* out, size_t n, int lane) {
  char word[24];
  snprintf(word, sizeof(word), "%s", labelForStatus(status));
  for (char* p = word; *p; p++) if (*p >= 'a' && *p <= 'z') *p -= 32;
  fitText(out, n, word, lane);
}
// ---------- The status band (the expanded card's head) ----------
// A filled rect in the status colour carrying the agent mark, the status WORD and
// the duration. Drawn as ONE unit - one rectangle, one call, which is what the
// crossfade needs - but NOT repainted as one for the duration: that field ticks
// once a second for the first minute of every status, and a full band repaint per
// tick would be a clear-then-redraw of a 292x42 region, the flicker discipline's
// one prohibition. It stays a change-only field with a FIXED lane instead
// (SESSION_BAND_DUR_CHARS), which is what keeps its clear box off the word beside
// it - the failure the compact row's duration caused once with a variable one.
//
// The word is T_HEAD (Spleen 12x24) because presence is the band's whole job; the
// duration stays T_BODY so it reads as a subordinate fact. Both are COLOR_CARD ON
// the status colour, and the mark is tinted the same way round - the inverse of
// every other site, which is why drawAgentMark takes fg/bg at all.
//
// TAKES AN INDEX, NOT A SessionInfo&, and that is forced rather than preferred:
// Arduino hoists its generated prototypes ABOVE the struct's definition, so a
// signature naming SessionInfo does not compile in this sketch. buildSessionSubline
// carries the same note for the same reason.
//
// (x, y, w) is the card's INTERIOR - inset by the 2px border - so the fill can be
// rounded at the top with the card's own corners (radius less the border) and
// square at the bottom, where the body begins. A plain fillRect here would paint
// status-coloured nubs outside the card's rounded outline.
void drawSessionBand(int x, int y, int w, int i, uint16_t col) {
  const SessionInfo& s = sessions[i];
  // The mark ANIMATES while this session is working, at rest otherwise. It was
  // hardcoded false while the band was being built and before the mark had a
  // resting pose to fall back on, which left the ONE-session working case - the
  // most common screen on this tab - completely static, where the plain row it
  // replaced had a turning spark. tickWorkingSpinner advances it in place.
  const bool working = strcmp(s.status, "working") == 0;
  const int h = SESSION_BAND_H - BORDER_CARD;   // the card's top border owns the rest
  const int r = R_MD - BORDER_CARD;
  // §6: `col` is the status colour this band is arriving AT; `fill` is what it
  // shows right now, which differs only while a crossfade is running. Every
  // colour below reads `fill`, so an ordinary repaint landing mid-fade draws the
  // frame the animation is on rather than fighting it back to the target.
  const int t = sessionXfadeT(s.id);
  const uint16_t fill = sessionBandFill(col, t, sessionPulseA(s.status));
  // §6: THE RECORD OF WHAT IS ON THE GLASS, written HERE because this is the only
  // place a band is ever painted. The pulse repaints on a change of fill, so it
  // needs to know what the last paint left behind - and a record kept by the
  // animation alone would go stale the moment an ordinary row repaint, a
  // crossfade frame or a full list rebuild painted the band instead.
  bandFillShown = fill;
  uiFillRound(x, y, w, h, r, fill, COLOR_CARD);
  tft.fillRect(x, y + r, w, h - r, fill);

  drawAgentMark(bandMarkX(x), bandMarkY(y),
                strcmp(s.agent, "cx") == 0, COLOR_CARD, fill, /*animate=*/working);

  // THE DURATION'S LANE IS A CONSTANT, NOT A MEASUREMENT, and that is the whole
  // reason it can be a change-only field: bandDurLeft() is the same number whatever
  // the value says, so the clear box it repaints on every change is fixed and
  // provably clear of the word's ink beside it (7px with the longest label - see
  // SESSION_BAND_DUR_CHARS). Measuring the current value instead would let a wide
  // duration's box grow into the word, which is the defect the compact row's
  // duration caused once, on the one card whose whole job is that word.
  char dur[8];
  bandDurText(i, dur, sizeof(dur));
  tft.setTextColor(COLOR_CARD, fill);
  tft.setTextDatum(TR_DATUM);
  setUIFont(T_BODY);
  tft.drawString(dur, x + w - SESSION_BAND_PAD, y + bandDurDY());

  // labelForStatus is lower case; drawStatusPill's labels are upper. One
  // convention on this tab, so the band matches the pill rather than inventing a
  // second one - and it is the SAME string labelForStatus already owns, so a new
  // status cannot reach the band with no word.
  const int wordX = x + SESSION_BAND_PAD + SPARK_SIZE + SESSION_BAND_MARK_GAP;
  const int lane = bandDurLeft(x, w) - wordX;
  setUIFont(T_HEAD);
  tft.setTextDatum(TL_DATUM);
  const int wordY = y + (h - uiLineH(T_HEAD)) / 2;

  // §6: BOTH WORDS ARE ON THE GLASS AT ONCE while a fade runs, each at its own
  // strength - at t = 0.5 both sit at half and are briefly illegible. That is
  // the spec as written and it was asked and answered; a midpoint swap is not
  // what this is, and "fixing" it to one is the change to not make.
  //
  // The LEAVING word draws first and OPAQUE, so it lays a clean box of the
  // band's current fill under itself; the ARRIVING word draws on top with
  // fg == bg, which is drawString's transparent form (it skips the box and inks
  // only the glyph runs). Opaque-then-transparent is what puts two overlapping
  // words on one lane at all - drawing both opaque would leave only the second.
  if (t >= 0) {
    char fromFit[24];
    bandStatusWord(xfadeFrom, fromFit, sizeof(fromFit), lane);
    const uint16_t fromInk = blend565(fill, COLOR_CARD, (uint8_t) (255 - t));
    tft.setTextColor(fromInk, fill);
    tft.drawString(fromFit, wordX, wordY);
  }
  char wordFit[24];
  bandStatusWord(s.status, wordFit, sizeof(wordFit), lane);
  const uint16_t ink = t < 0 ? COLOR_CARD : blend565(fill, COLOR_CARD, (uint8_t) t);
  tft.setTextColor(ink, t < 0 ? fill : ink);
  tft.drawString(wordFit, wordX, wordY);
}
// The band card's mark, ADVANCED IN PLACE - one 32x32 blit, not a band repaint.
// A repaint would be a clear-then-redraw of a 292x42 region eight times a second,
// which is the flicker discipline's one prohibition and ~10ms of compose+flush
// against a 33ms frame. It is called from tickWorkingSpinner rather than from
// tickSessionAnim on purpose: that is where animPhase is advanced and where the
// trailing flush already goes out, so the band's mark and every row indicator are
// the SAME frame of the same art rather than one 120ms step apart.
//
// The background is bandFillShown - the RECORD of what the band was last painted
// in, which drawSessionBand writes - not colorForStatus(). A crossfade frame or a
// pulse breath leaves the band a blended colour, and blitting the mark over the
// flat status colour would punch a 32x32 patch of the wrong shade into it.
void drawBandMark(int pos) {
  const int i = sessionAt(pos);
  drawAgentMark(bandMarkX(SESSION_ROW_X + BORDER_CARD),
                bandMarkY(sessionRowYAt(pos) + BORDER_CARD),
                strcmp(sessions[i].agent, "cx") == 0,
                COLOR_CARD, bandFillShown, /*animate=*/true);
}
// The Codex knockout, EXTRACTED so the shimmer can re-apply it after repainting
// the column. One copy of the loop rather than a second that could drift from
// the shape sessions-geom-check.mjs models - and drift is not hypothetical here:
// the gaps may only be cut from the straight section, and a copy that forgot
// that would paint outside the card exactly as a naive fill would.
void drawSpineGaps(int x, int y, int r, int h) {
  // Starts one ON run below the top arc and draws only a gap that fits WHOLE
  // inside the straight section, so no knockout is ever clipped by an arc.
  for (int yy = r + SESSION_SPINE_ON; yy + SESSION_SPINE_OFF <= h - r;
       yy += SESSION_SPINE_ON + SESSION_SPINE_OFF)
    tft.fillRect(x, y + yy, SESSION_SPINE_W, SESSION_SPINE_OFF, COLOR_CARD);
}
// ---------- The spine (the band's compact form) ----------
// SESSION_SPINE_W of status colour down the row's left edge, for every row the
// band card is not. Same vocabulary, a fraction of the cost, and it scales to any
// row height - which a 44px band cannot, since a 65px six-session row would spend
// two thirds of itself on one word.
//
// (x, y, h) is the card's INTERIOR - inset by the 2px border - exactly as
// drawSessionBand's is, and for the same reason: a plain fillRect down the left
// edge paints status-coloured nubs OUTSIDE the card's rounded outline. This one
// meets BOTH corners rather than one, so it cannot be squared off at either end.
//
// A CAPSULE CARVED STRAIGHT, not a rect and not six columns of arithmetic. The
// capsule is exactly 2r wide at the card's INTERIOR radius, so its left edge IS
// the interior's corner arc - same centre, same radius, by construction rather
// than by transcription. A plain COLOR_CARD rect then takes back everything from
// SESSION_SPINE_W rightwards, which bounds the ink at x + SESSION_SPINE_W - 1 on
// every row and leaves the ends shaped by the card's own corner.
//
// CARVING WITH A SECOND CAPSULE IS THE OBVIOUS MOVE AND IT IS WRONG. It gives a
// band of constant width that follows the corner - prettier on paper - but the
// band then travels RIGHT with the arc, and the working spinner's 32x32 blit
// paints its own COLOR_CARD background from x = SESSION_DOT_CX - SPARK_SIZE/2
// across every row it covers. Measured against the shim's own SDF: 17 spine
// pixels erased on every working row, four times a second. Cosmetic - no border
// bite, nothing outside the outline - and invisible to any assertion that models
// the spine as a rect, which is exactly how it survived a review.
//
// SESSION_SPINE_INSET is the other half of that fix, and it is VERTICAL ONLY.
// The carving rect's own left edge lands on a pixel the card's anti-aliased border
// still owns at the interior's TOP ROW, so the box starts one row further down and
// ends one row earlier. It must NOT move in x, for two independent reasons:
// the capsule's arc would stop sharing the card interior's centre, and 6px
// starting one pixel right puts the spine's LAST column on the spinner blit's
// FIRST - measured off the panel as 20 erased pixels a row, which is the same
// defect as the arc overlap, reintroduced by its own fix.
//
// CODEX IS SEGMENTED, and the gaps are knocked out of the STRAIGHT section only -
// the run between the two arcs, where the fill's left edge really is at x. Up in
// the arc it has moved right, so a knockout at x would paint outside the card: the
// same hazard as the fill, arriving through the pattern. The two ends therefore
// stay solid, which is also what stops the pattern reading as a half-segment cut
// off by the corner.
void drawSessionSpine(int x0, int y0, int h0, const char* status, bool codex) {
  const uint16_t col = colorForStatus(status);
  const int r = R_MD - BORDER_CARD;   // the card's interior corner radius
  const int x = x0;                              // no x inset - see above
  const int y = y0 + SESSION_SPINE_INSET;
  const int h = h0 - 2 * SESSION_SPINE_INSET;
  uiFillRound(x, y, 2 * r, h, r, col, COLOR_CARD);
  tft.fillRect(x + SESSION_SPINE_W, y, 2 * r - SESSION_SPINE_W, h, COLOR_CARD);
  if (codex) drawSpineGaps(x, y, r, h);
}
// ---------- §6 The spine shimmer: a light travelling a working row ----------
// It repaints the spine's SIX COLUMNS and nothing else. Not the capsule, not the
// carve, not the arcs: `x` here is the same x the fill uses and the width is
// SESSION_SPINE_W, which is exactly the bound the straight carve gives the fill
// on every row - so this cannot reach the card's rounded outline, and it cannot
// reach the working spinner's 32x32 blit at x=20 either.
//
// THE ARCS ARE LEFT ALONE, and that is the same constraint the Codex knockout
// carries rather than a simplification: between y+r and y+h-r the fill's left
// edge really is at x, but up in the arc it has moved right, so a rect at x
// there would paint outside the card. The light therefore travels the straight
// section only, which is also what stops it appearing to leak out of the ends.
//
// One fillRect PER ROW rather than a blit: at 6px wide the run is a handful of
// pixels and there is no scratch buffer, no byte-order flag and no readback -
// the same argument blit2bpp's run-length inner loop already makes.
void drawSpineShimmer(int x0, int y0, int h0, const char* status, bool codex,
                      int phase) {
  const uint16_t col = colorForStatus(status);
  const int r = R_MD - BORDER_CARD;
  const int x = x0;                              // no x inset - see drawSessionSpine
  const int y = y0 + SESSION_SPINE_INSET;
  const int h = h0 - 2 * SESSION_SPINE_INSET;
  const int span = h - 2 * r;                    // the straight section
  if (span <= 0) return;
  // The head travels a LEN-row overhang past each end, so the light enters and
  // leaves rather than being born and dying mid-spine.
  const int travel = span + 2 * SESSION_SHIMMER_LEN;
  const int head = -SESSION_SHIMMER_LEN + (travel * phase) / SESSION_SHIMMER_STEPS;
  for (int yy = 0; yy < span; yy++) {
    const int d = yy - head < 0 ? head - yy : yy - head;
    const uint8_t a = d >= SESSION_SHIMMER_LEN ? 0
                    : (uint8_t) (SESSION_SHIMMER_MAX *
                                 (SESSION_SHIMMER_LEN - d) / SESSION_SHIMMER_LEN);
    tft.fillRect(x, y + r + yy, SESSION_SPINE_W, 1,
                 a ? blend565(col, COLOR_VALUE, a) : col);
  }
  // The column was repainted solid, so a Codex row owes its gaps back. Through
  // the same helper the spine itself uses, which is the whole reason it exists.
  if (codex) drawSpineGaps(x, y, r, h);
}
// ---------- §6 The tick that drives both ----------
// GATED EXACTLY AS tickWorkingSpinner IS, and for the same reasons: an animation
// that paints while a full-screen surface is up wipes something somebody is
// reading, and one that runs on a tab nobody is looking at spends battery for
// nothing. sessions-geom-check.mjs parses BOTH gates and asserts this one is at
// least as tight, rather than trusting the two lists to be kept in step by hand.
//
// IT MUST NEVER TOUCH lastNonIdleMillis. An animation that did would read as
// activity to the sleep timer and hold the backlight on - and on board 2 the
// backlight blank is the ONLY power saving left, since auto-deep-sleep is
// compiled out here. That is ~80 of ~142 mV/h, measured.
//
// SMALL FLUSHES, NEVER ONE BIG ONE. flush() pushes the UNION of everything
// dirty, and the band (x 14..306, up top) and the spine column (x 14..19, down
// the whole list) union to nearly the entire content area - 30ms, the whole
// budget at 30fps. So the crossfade flushes its own rectangle, the pulse flushes
// that same rectangle, and the shimmer flushes nothing at all: it rides the
// working spinner's frame, which was already pushing the same strips. See the
// three blocks below.
//
// THREE ANIMATIONS, THREE DIFFERENT COST SHAPES, and the third is the reason §6
// gated it: the crossfade is ONE-SHOT (300ms per status change), the shimmer is
// continuous but MARGINALLY FREE (it rides a flush that was happening anyway),
// and the attention pulse costs a band repaint for as long as a prompt goes
// unanswered. It therefore ships behind `PULSE 0|1`, DEFAULT OFF and UNMEASURED,
// until the A/B beside `sessionPulse` in deckhand_display.ino has been run.
//
// The crossfade's LEADING flush is what makes its measurement honest as well: it
// starts from a clean dirty rect, so the number PERF reports is the band's own
// cost and not whatever else happened to be pending. It early-returns for free
// when nothing is dirty, and deliberately does not overwrite lastFlushUs then.
void tickSessionAnim() {
  if (isAsleep || octoActive || showingDetail || readerActive || histActive
      || kbActive || emojiTestActive) { xfadeId[0] = '\0'; return; }
  if (currentTab != TAB_SESSIONS || sessionCount == 0) { xfadeId[0] = '\0'; return; }

  // ---- the state crossfade: one-shot, band only ----
  // A FADE OFTEN HAS NOTHING TO PAINT, AND THAT IS ORDINARY. §6 fades the BAND,
  // and only display position 0 has one - and only while the ladder is short
  // enough to give it one at all (sessionExpandedH is 0 from four sessions up).
  // So a status change on any other row draws no frames: its spine and its pill
  // switch at once, which is what §6 asks for. PERF reports `started` beside `n`
  // for exactly this reason - two builds were spent reading `n=0` as a broken
  // trigger when the real cause was a fourth session arriving on the glass and
  // taking the band card away.
  if (xfadeId[0] && millis() - lastXfadeMs >= SESSION_XFADE_INTERVAL_MS) {
    lastXfadeMs = millis();
    // Resolved by ID every frame, never cached as a row: a status change is
    // exactly what re-ranks this list, so the row a fade started on is the one
    // most likely to have moved by its next frame.
    int pos = -1;
    for (int p = 0; p < sessionCount; p++)
      if (strcmp(sessions[sessionAt(p)].id, xfadeId) == 0) { pos = p; break; }
    // Cleared BEFORE the draw when the clock has run out, which is what makes
    // the last frame SETTLE the band at the target rather than leaving it one
    // step short of it forever - drawSessionBand asks sessionXfadeT again.
    const bool done = sessionXfadeT(xfadeId) < 0;
    if (done) xfadeId[0] = '\0';
    if (pos >= 0 && sessionRowExpanded(pos)) {
      const int i = sessionAt(pos);
      tft.flush();
      const uint32_t t0 = micros();
      drawSessionBand(SESSION_ROW_X + BORDER_CARD, sessionRowYAt(pos) + BORDER_CARD,
                      SESSION_ROW_W - 2 * BORDER_CARD, i,
                      colorForStatus(sessions[i].status));
      xfadeComposeUs = (uint32_t) (micros() - t0);
      tft.flush();
      xfadeFlushUs = tft.lastFlushUs();
      if (xfadeComposeUs + xfadeFlushUs > xfadeWorstUs)
        xfadeWorstUs = xfadeComposeUs + xfadeFlushUs;
      xfadeFrameCount++;
    }
  }

  // ---- the spine shimmer: continuous, but only on working rows ----
  // IT RIDES tickWorkingSpinner's OWN FRAME, and that is the difference between
  // an animation that costs 208us and one that costs 6.5ms. MEASURED, on this
  // panel: a flush's transfer is dominated by FIXED PER-STRIP OVERHEAD, not by
  // pixels - 1453us for a 320x32 strip, 792us for an 8x32 one - so the spine's
  // dirty rect is the worst shape this path has. It is six columns tall enough
  // to span the whole list: 8 strips, ~6.3ms, four times a second, for 2,424
  // pixels. §2's model priced it at 1.2ms because it counted pixels.
  //
  // The spinner already pushes those very strips every ANIM_INTERVAL_MS - its
  // 32x32 blits sit at x 20..46, immediately right of the spine's 14..19, on the
  // same rows - so the shimmer's strips are going out regardless and its
  // marginal transfer cost is nothing. So: paint here, do NOT flush, and let the
  // spinner's own trailing flush carry it.
  //
  // READS lastAnimMs AND DOES NOT WRITE IT. That is what makes the two exactly
  // in phase rather than merely near it: tickWorkingSpinner runs immediately
  // after this in loop(), sees the same timer still due, and flushes in the same
  // iteration. Consuming the timer here would leave the shimmer's paint waiting
  // for the NEXT frame's flush, and would stop the spinner animating at all.
  // Both properties are asserted in sessions-geom-check.mjs.
  if (millis() - lastAnimMs >= ANIM_INTERVAL_MS) {
    shimmerPhase = (uint8_t) ((shimmerPhase + 1) % SESSION_SHIMMER_STEPS);
    const uint32_t t0 = micros();
    int painted = 0;
    for (int pos = 0; pos < sessionCount; pos++) {
      // The band card has no spine - its status vocabulary is the band - and the
      // same skip tickWorkingSpinner makes, for the same reason.
      if (sessionRowExpanded(pos)) continue;
      const int i = sessionAt(pos);
      if (strcmp(sessions[i].status, "working") != 0) continue;
      drawSpineShimmer(SESSION_ROW_X + BORDER_CARD, sessionRowYAt(pos) + BORDER_CARD,
                       sessionRowHAt(pos) - 2 * BORDER_CARD, sessions[i].status,
                       strcmp(sessions[i].agent, "cx") == 0, shimmerPhase);
      painted++;
    }
    if (painted) {
      shimComposeUs = (uint32_t) (micros() - t0);
      if (shimComposeUs > shimWorstUs) shimWorstUs = shimComposeUs;
      shimFrameCount++;
    }
  }

  // ---- §6 the attention pulse: continuous while a prompt waits, DEFAULT OFF ----
  // THE ONLY ANIMATION HERE THAT COSTS CURRENT INDEFINITELY, which is why §6 gates
  // it on a POWERPROBE A/B and why it ships behind `PULSE 0|1` with the toggle off.
  // The procedure is committed beside `sessionPulse` in deckhand_display.ino.
  //
  // IT REPAINTS ON A CHANGE OF COLOUR, NOT ON A TIMER - this file's change-only
  // redraw discipline applied to an animation, and it is not a micro-optimisation.
  // RGB565 gives the asking colour's ramp 16 distinct colours on DARK and 6 on
  // LIGHT at SESSION_PULSE_MAX (computed from the parsed palette in
  // sessions-geom-check.mjs), so a band repainted every sample would push an
  // IDENTICAL 292x42 region for 42 to 62 of the breath's 72 samples - at ~10ms of
  // compose and flush each, on the one animation whose cost is being weighed
  // against a battery. Sampling at SESSION_PULSE_INTERVAL_MS and painting only on
  // a change costs 30 repaints a breath at worst and 10 at best, and PERF reports
  // the count so that claim is READ rather than believed - as a rate, from two
  // reads, since `n` is cumulative since boot.
  //
  // THE COMPARISON IS AGAINST bandFillShown, WHICH drawSessionBand WRITES. That is
  // the difference between a record and a request, and this repo has already paid
  // for conflating the two once (savingsSync). A crossfade frame, an ordinary row
  // repaint and a full list rebuild all paint the band too, all at the pulse's
  // current alpha, and all through that one function - so the record cannot drift
  // from the panel and this needs no invalidation hook anywhere.
  //
  // THE CROSSFADE OWNS THE BAND WHILE IT RUNS. It repaints at ~30fps at the
  // pulse's own alpha already, so a second repaint in the same frame would double
  // its measured cost to change nothing. One owner at a time; the pulse resumes on
  // the frame after the fade settles.
  //
  // TURNING THE TOGGLE OFF NEEDS NO RESTORE PATH, and that is structural rather
  // than lucky: sessionPulseA returns 0, the computed fill becomes the flat status
  // colour, that differs from what is on the glass, and the same reconcile paints
  // it. Apply and restore being ONE condition is exactly what savingsSync had to
  // be rewritten into after they were two.
  if (millis() - lastPulseMs >= SESSION_PULSE_INTERVAL_MS) {
    lastPulseMs = millis();
    int pos = -1;
    for (int p = 0; p < sessionCount; p++)
      if (sessionRowExpanded(p)) { pos = p; break; }
    // With no band on screen there is nothing to settle and bandFillShown is left
    // alone: the ladder change that took the band away repainted the whole list,
    // and the one that brings it back will paint it through drawSessionBand.
    if (pos >= 0) {
      const int i = sessionAt(pos);
      const uint16_t col = colorForStatus(sessions[i].status);
      if (sessionXfadeT(sessions[i].id) < 0) {
        const uint16_t want = sessionBandFill(col, -1, sessionPulseA(sessions[i].status));
        if (want != bandFillShown) {
          // Its own rectangle, exactly as the crossfade flushes its own, and for
          // the first of the same two reasons: the band's dirty rect must not
          // union with the spine column, which would take the flush to nearly the
          // whole content area.
          //
          // THE SECOND REASON DOES NOT SURVIVE HERE, AND SAYING SO IS THE POINT.
          // The crossfade's leading flush also makes its PERF number its own cost
          // rather than the backlog's. This block runs AFTER the shimmer's, so
          // with any row working this flush pushes the spine strips the shimmer
          // has just painted, and pulseFlushUs is a CEILING on the pulse's flush
          // rather than the pulse's flush. Two consequences, both recorded in the
          // A/B procedure: the shimmer stops riding the spinner's frame alone
          // while the pulse is on - real cost, which the drain measurement
          // attributes correctly because turning the pulse on genuinely causes
          // it - and the A/B must hold the number of WORKING rows identical
          // across its two legs, or the difference it measures is that instead.
          // Reordering the two blocks would not fix it, only move it onto the
          // shimmer, whose whole design is that it flushes nothing at all.
          tft.flush();
          const uint32_t t0 = micros();
          drawSessionBand(SESSION_ROW_X + BORDER_CARD, sessionRowYAt(pos) + BORDER_CARD,
                          SESSION_ROW_W - 2 * BORDER_CARD, i, col);
          pulseComposeUs = (uint32_t) (micros() - t0);
          tft.flush();
          pulseFlushUs = tft.lastFlushUs();
          if (pulseComposeUs + pulseFlushUs > pulseWorstUs)
            pulseWorstUs = pulseComposeUs + pulseFlushUs;
          pulseFrameCount++;
        }
      }
    }
  }
}
#endif
// pos is the DISPLAY POSITION (what the row's on-screen y comes from); the
// underlying array index - which may differ once two Macs are merged and
// reordered - is resolved through sessionAt(pos) and used for every read of
// session data.
void drawSessionRow(int pos) {
  // Through the row-stack helpers, never from sessionRowH and pos directly: the
  // first row can be TALLER than the rest, and the duration, the spinner tick and
  // the touch hit test read the same two functions. On board 1 both inline to the
  // expressions this function used to carry.
  const bool expanded = sessionRowExpanded(pos);
  int rowH = sessionRowHAt(pos);
  bool large = rowH >= SESSION_LARGE_MIN_H;
  int y = sessionRowYAt(pos);
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
#if !BOARD_USES_TFT_ESPI
  // ---- THE STATUS BAND (band card only) ----
  // Drawn FIRST, because the body below starts where it ends: the name block's
  // top IS SESSION_BAND_H, and every block after it is a cursor step. The band is
  // the card's whole status vocabulary - it carries the mark, the word and the
  // duration - which is why the row's own indicator, its corner agent tag and its
  // bottom pill are all skipped below rather than drawn a second time 44px away.
  //
  // IT USED TO BE A SHIFT (`bandOff`) APPLIED TO THE ORDINARY ROW'S BODY, and
  // that is what made this card two thirds air: the row layout it shifted is
  // sized for a 100px rung, so a 336px card drew 231px of content and 105px of
  // nothing. The body is now the block stack SESSION_EXP_MAX_H is summed FROM,
  // which is what makes that sum a description of the card rather than of a
  // number in the header.
  if (expanded)
    drawSessionBand(SESSION_ROW_X + BORDER_CARD, y + BORDER_CARD,
                    SESSION_ROW_W - 2 * BORDER_CARD, i, color);
  else
    // ---- THE SPINE (every other row) ----
    // The same status colour in the compact vocabulary, drawn on the card's
    // interior so it meets the border rather than crossing it. Everything else on
    // the row is UNCHANGED: the indicator, the tag and the pill all still draw,
    // because the spine is a second carrier and never the only one. It clears the
    // 32x32 spinner blit's left edge (SESSION_DOT_CX - 16) by a pixel, so the name
    // lane needs no widening.
    drawSessionSpine(SESSION_ROW_X + BORDER_CARD, y + BORDER_CARD,
                     rowH - 2 * BORDER_CARD, s.status, strcmp(s.agent, "cx") == 0);
#endif

  // SESSION_DOT_CX/DY, not literals, and BOTH halves are constraints rather than
  // taste - the derivations live in the board header (x) and beside the shared
  // offsets in deckhand_display.ino (y). The working spinner is a 32x32 BLIT: it
  // paints a full rectangle, background pixels included, so its left edge has to
  // clear the row's rounded corner. Board 1 shipped it 3px too far left once and
  // the blit's COLOR_CARD background bit a notch out of the border - white, and
  // plainly visible, under the LIGHT theme. The dot and square states move with
  // it so the indicator never jumps sideways when a session changes status.
  int dotCy = large ? y + SESSION_DOT_DY : y + rowH / 2;
#if !BOARD_USES_TFT_ESPI
  if (!expanded)   // the band carries this card's mark; see the band note above
#endif
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
  // An expanded row is a title row by construction (its packed stack budgets the
  // name band and the title's two lines), so it takes the same raised name top and
  // the same tighter pill offset. On board 1 `expanded` is a compile-time false and
  // this is the expression it always was.
  bool showTitle = (large && rowH >= SESSION_TITLE_MIN_H && s.title[0]) || expanded;

  int nameX = SESSION_ROW_X + SESSION_NAME_DX;
#if !BOARD_USES_TFT_ESPI
  // SESSION_NAME_DX's 40px are the 32x32 row-indicator blit's clearance, and the
  // band card draws no indicator - its mark is up in the band - so on that card
  // they reserve space for nothing and push every body line 24px right of the
  // band it hangs under. The body starts at the band's own content left edge
  // instead; see SESSION_BAND_BODY_X. Board 1's expression is untouched.
  if (expanded) nameX = SESSION_BAND_BODY_X;
#endif
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
#if !BOARD_USES_TFT_ESPI
  // Nothing shares the band card's name row - the corner tag and the Mac icon are
  // skipped there, because the band carries the agent mark and the sub-line
  // spells the Mac out - so reserving their width would shrink a name lane
  // against a blocker that is not drawn.
  // The right edge is the band's too, so the name's lane is exactly the band's
  // content box - one inset, SESSION_BAND_PAD, on both sides of both.
  if (expanded) laneRight = SESSION_BAND_BODY_X + SESSION_BAND_BODY_LANE;
#endif
  int laneW = laneRight - nameX - 6; // 6px so the name never kisses the tag/pill

  // Three rungs, largest first - board 1's Cozette 12x26 -> Terminus 10x18 ->
  // Cozette 6x13, board 2's Spleen 32x64 -> 12x24 -> 8x16 - taking the first whose
  // measured width fits the lane, so a long project name is shown WHOLE rather
  // than cut short. Before T_HEAD existed this was a single hero->body cliff.
  //
  // TWO tests, not one, and the height half is why the ladder starts where it
  // does. A rung whose CELL is taller than the row's name band cannot be drawn
  // there at all however well it fits the lane - board 2's T_HERO is 64px against
  // a 24px band - so SESSION_NAME_TOP_RUNG names the tallest admissible rung per
  // board (0 = T_HERO on board 1, 1 = T_HEAD on board 2) and the width walk starts
  // from it. Skipping by height at RUNTIME instead would cost board 1 flash it
  // cannot spend (its binary is held byte-identical), so the invariant - the top
  // rung fits the band, and is the tallest that does - is asserted in
  // sessions-geom-check.mjs against the parsed font table instead.
  // Compact rows start at the bottom rung, exactly as they always have: a hero or
  // head cell does not fit a row under SESSION_LARGE_MIN_H.
  static const uint8_t NAME_RUNGS[] = { T_HERO, T_HEAD, T_BODY };
  const int NAME_RUNG_N = (int) (sizeof(NAME_RUNGS) / sizeof(NAME_RUNGS[0]));
  char nameBuf[28]; // host caps the name at 22, plus "..." and a NUL
  uint8_t nameFont = T_BODY;
  for (int r = large ? SESSION_NAME_TOP_RUNG : NAME_RUNG_N - 1; r < NAME_RUNG_N; r++) {
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
  // A shrunk name is centred in the band the top rung would have filled, so it
  // doesn't hang off the top of the row with a gap under it. Board 1's old
  // hardcoded +6 was exactly this: (26 - 13) / 2. SESSION_NAME_H, not
  // uiLineH(T_HERO): on board 2 the band is the HEAD rung's 24px and the hero's
  // 64 would make every offset here negative. A title row starts 2px higher to
  // buy the third line its space.
  int nameTop = y + (showTitle ? SESSION_NAME_Y_T : SESSION_NAME_Y);
  int nameOffset = large ? (SESSION_NAME_H - uiLineH(nameFont)) / 2 : 0;
#if !BOARD_USES_TFT_ESPI
  // The band card's name is the FIRST block of the body stack, not the ordinary
  // row's name offset pushed down: it sits directly under the band and is centred
  // in SESSION_BAND_NAME_H, the block SESSION_EXP_MAX_H counts.
  if (expanded) {
    nameTop = y + SESSION_BAND_H;
    nameOffset = (SESSION_BAND_NAME_H - uiLineH(nameFont)) / 2;
  }
#endif
  tft.drawString(nameBuf, nameX, nameTop + nameOffset);

  // 36, not 26: buildSessionSubline's "who" can now be "CC/studio" (9 chars) instead of
  // just "CC", and "CC/studio opus-5 (main)" runs to 23 - still comfortably inside 36.
  char sub[36];
  buildSessionSubline(i, sub, sizeof(sub));
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);

  if (large) {
#if !BOARD_USES_TFT_ESPI
    // ---- THE EXPANDED FIRST ROW ----
    // A RUNNING CURSOR OVER THE BLOCK STACK SESSION_EXP_MAX_H IS SUMMED FROM:
    // name, agent/model/branch, title, a rule, LAST PROMPT + prompt, a rule,
    // path. Every step below is one of the eight SESSION_BAND_* constants, which
    // is what makes the cap a description of this card rather than a number that
    // merely sits beside it - and it is why the checker PARSES these steps.
    //
    // A CURSOR, not fixed offsets, for the same reason the detail card stopped
    // using them: a Codex row carries no title and a fresh session no prompt, so
    // a fixed stack would leave a hole in the middle of the card. Whatever a
    // missing block does not spend moves the blocks below it UP.
    //
    // THE PATH AND ITS RULE ARE BOTTOM-ANCHORED, which is the other half of the
    // same argument. Run off the cursor they would end wherever the content
    // happened to stop, and a Codex card - 40px lighter, having no title - would
    // put all 40 of them below the last thing on the card: a blank tail, which is
    // exactly the shape this pass exists to remove. Anchored, the card ALWAYS
    // ends on its path, and any surplus pools as air around the prompt block
    // where it reads as padding. At the cap with full content the two meet
    // exactly - cursor 292, anchor 292 - so this is one layout, not two.
    //
    // The card still repaints WHOLESALE - no drawIfChanged is introduced on a row
    // - which is why no clear box here can reach a row border.
    if (expanded) {
      // The band's own content lane, shared with sessionExpMeasure(); every block
      // below starts at nameX, which is that lane's left edge.
      const int lane = SESSION_BAND_BODY_LANE;
      int cy = nameTop + SESSION_BAND_NAME_H;
      if (sub[0]) {
        setUIFont(T_META);
        tft.setTextColor(COLOR_LABEL, COLOR_CARD);
        char subFit[36];
        fitText(subFit, sizeof(subFit), sub, lane);
        tft.drawString(subFit, nameX, cy);
        cy += SESSION_BAND_SUB_H;
      }
      if (s.title[0]) {
        // WRAPPED, not fitText: title[44] holds 43 characters = 344px against a
        // 264px lane, so the one thing this card has room to do properly is show
        // the whole title. Two lines hold 66.
        // The RETURNED y, not the budgeted line count: drawWrappedText hands back
        // the row below its last drawn line at SESSION_BAND_TITLE_STEP, so a
        // title that happens to fit on one line does not leave a 20px hole above
        // the block beneath it. The BUDGET is still what the cap is derived from,
        // so the checker's full-length table remains the worst case.
        cy = drawWrappedText(s.title, nameX, cy, T_BODY, SESSION_BAND_TITLE_STEP,
                             lane, 0, SESSION_EXP_TITLE_LINES, COLOR_VALUE, COLOR_CARD);
      }
      if (s.prompt[0]) {
        // The rule INTRODUCES the prompt block, so it is drawn with it: a rule
        // under a card that then says nothing is a line to nowhere.
        drawBandRule(nameX, cy + (SESSION_BAND_RULE_H - 1) / 2, lane);
        cy += SESSION_BAND_RULE_H;
        setUIFont(T_META);
        tft.setTextColor(COLOR_LABEL, COLOR_CARD);
        tft.drawString("LAST PROMPT", nameX, cy);
        cy += SESSION_BAND_LABEL_H;
        // THE COUNT THIS CARD'S HEIGHT WAS DERIVED FROM, not one re-derived here.
        // sessionExpMeasure() takes sessionExpPromptLines()'s budget - the same
        // guard, against the ladder's grant - and caps it by what the prompt
        // really wraps to, then makes the card exactly that tall. Re-deriving it
        // from rowH would be circular now that rowH IS the content's height: a
        // card missing its title is shorter, so the budget read back off it comes
        // out SMALLER than the lines the height already paid for, and the card
        // opens a hole where it had already spent the pixels.
        drawWrappedText(s.prompt, nameX, cy, T_BODY, SESSION_BAND_PROMPT_STEP, lane, 0,
                        expCardPrompt, COLOR_VALUE, COLOR_CARD);
      }
      if (s.path[0]) {
        // ONE line through fitText rather than wrapped: the path is the least
        // important thing on the card and a second line would come out of the
        // prompt's budget. Its tail is trimmed with "..." - the detail screen is
        // where a long path is wrapped and readable whole.
        const int pathTop = y + rowH - SESSION_BAND_BOTTOM_PAD - SESSION_BAND_PATH_H;
        drawBandRule(nameX, pathTop - SESSION_BAND_RULE_H + (SESSION_BAND_RULE_H - 1) / 2,
                     lane);
        setUIFont(T_META);
        tft.setTextColor(COLOR_LABEL, COLOR_CARD);
        char pathFit[72];
        fitText(pathFit, sizeof(pathFit), s.path, lane);
        tft.drawString(pathFit, nameX, pathTop);
      }
      setUIFont(T_META);
      tft.setTextColor(COLOR_LABEL, COLOR_CARD);
    } else
#endif
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
      tft.drawString(titleBuf, nameX, y + SESSION_TITLE_Y);
      tft.setTextColor(COLOR_LABEL, COLOR_CARD); // restore for the sub-line below
      // Bound to SESSION_SUB_LANE_W, the sub-line's own lane from the name's left
      // edge to the row's right - a long branch name plus a Mac tag could otherwise
      // run past the row. 30 characters on BOTH boards, as it happens: 184px at
      // Cozette's 6px advance and 244px at Spleen's 8px, against a
      // buildSessionSubline that can emit 35 - so the worst case is trimmed with
      // "..." on either panel.
      if (sub[0]) {
        char subFit[36];
        fitText(subFit, sizeof(subFit), sub, SESSION_SUB_LANE_W);
        tft.drawString(subFit, nameX, y + SESSION_SUB_Y);
      }
    } else if (rowH >= SESSION_SUB_MIN_H && sub[0]) {
      char subFit[36];
      fitText(subFit, sizeof(subFit), sub, SESSION_SUB_LANE_W);
      tft.drawString(subFit, nameX, y + SESSION_SUB2_Y);
    }
    // Tall rows keep the top-right corner free (their pill sits at the bottom), so
    // the agent gets its full name there - and it still shows in the
    // SESSION_LARGE_MIN_H..SESSION_SUB_MIN_H band, where the sub-line above is
    // suppressed to clear the pill. Drawn from the SAME agentTag buffer the name
    // lane was measured against above.
#if !BOARD_USES_TFT_ESPI
    // Not indented, deliberately: board 1's source text is then unchanged by this
    // guard, and its binary cannot move. Same idiom as the `} else` above.
    if (!expanded) {
#endif
    const int tagRight = SESSION_ROW_X + SESSION_ROW_W - 12;
    tft.setTextDatum(TR_DATUM);
    if (rowEmoji >= 0) {
      // SESSION_TAG_Y for both: the icon's y IS the text's y, because MAC_EMOJI_SIZE
      // is the body cell height on either board (13 / 16). Board 2: icon rows +9..+24
      // against a tag line inking the same rows, and the pill below starts no higher
      // than +31 on the shortest tall row (SESSION_LARGE_MIN_H 56 - SESSION_PILL_UP
      // 25) - 6 rows clear. Horizontally the icon owns x 280..295 and the tag is
      // right-aligned at 276; the name lane already subtracts tagExtra for both.
      drawEmoji(rowEmoji, tagRight - MAC_EMOJI_SIZE, y + SESSION_TAG_Y, COLOR_CARD);
      tft.drawString(agentTag, tagRight - MAC_EMOJI_SIZE - 4, y + SESSION_TAG_Y);
    } else {
      tft.drawString(agentTag, tagRight, y + SESSION_TAG_Y);
    }
    tft.setTextDatum(TL_DATUM);
    const char* label = working ? "WORKING" : (strcmp(s.status, "asking") == 0 ? "NEEDS INPUT" : "READY");
    // BOTTOM-anchored, which is what lets the ladder hand a row any surplus height
    // without moving anything above. SESSION_PILL_UP_T is 2px tighter than
    // SESSION_PILL_UP because a title row has a third line of text to clear: on
    // board 1 the sub-line ends at y+59 against a pill top of y+rowH-22, which is
    // what makes 85 the packed minimum.
    drawStatusPill(nameX, y + rowH - (showTitle ? SESSION_PILL_UP_T : SESSION_PILL_UP),
                   label, s.status, false);
#if !BOARD_USES_TFT_ESPI
    }
#endif
  } else {
    // NOT SESSION_SUB_LANE_W, the lane the tall-row sites use: on a compact row the
    // duration ("10s"/"4m") is drawn at this SAME y (SESSION_SUBC_Y - see the
    // drawIfChanged call for rowDurCache below, which reads the same constant),
    // and drawIfChanged clears a box around it on EVERY tick,
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
      int subMaxW = durBoxLeft - nameX - 4; // 4px so it never kisses that box
      char subFit[36];
      fitText(subFit, sizeof(subFit), sub, subMaxW);
      tft.drawString(subFit, nameX, y + SESSION_SUBC_Y);
    }
    const char* label = working ? "WORKING" : (strcmp(s.status, "asking") == 0 ? "INPUT" : "READY");
    drawStatusPill(SESSION_ROW_X + SESSION_ROW_W - 16, y + SESSION_PILLC_Y, label, s.status, true);
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
      // The overflow strip ("+N more") takes the bottom SESSION_OVERFLOW_H when present.
      int avail = contentBottom() - SESSION_ROW_Y0 -
                  (hiddenCount > 0 ? SESSION_OVERFLOW_H : 0);
      // Rows stretch to fill the list and only compress once it fills up. The floor and
      // the ceiling are the board's, because the ladder this produces is arithmetic on
      // its own content area rather than a preference - board 1 (avail 264, cap 90) gives
      // 1-3 sessions a title line and board 2 (avail 410, cap 100) gives four, with the
      // full ladder written out in each board header beside SESSION_ROW_H_MAX.
      sessionRowH = constrain((avail - SESSION_ROW_GAP * (sessionCount - 1)) / sessionCount,
                              SESSION_ROW_H_MIN, SESSION_ROW_H_MAX);
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
#if !BOARD_USES_TFT_ESPI
  // THE BAND CARD'S HEIGHT IS ITS CONTENT'S, SO IT MOVES WITHOUT THE COUNT MOVING,
  // and that makes it a LAYOUT change the row signatures alone cannot carry: a new
  // prompt wrapping to one line instead of two shortens the card by 24px and slides
  // every row below it up. Row 0's signature does change (the prompt is in it), so
  // it would repaint at its new height - but the rows under it would not, leaving
  // them drawn at their old y with the tail of the old card still on the glass.
  // So the height gets the same wholesale rebuild the session COUNT gets, keyed the
  // same way, one cache each.
  //
  // MEASURED HERE, once, before anything reads the geometry: sessionRowH is final
  // by this point (the block above sets it, and it is unchanged when the count is),
  // and measuring text leaves the global font wherever countWrappedLines left it -
  // harmless at the top of a render, wrong inside a 120ms animation tick.
  //
  // On a count change this can clear a second time in the same pass. That is two
  // fillRects into the shadow framebuffer before any row is drawn, not two visible
  // paints - the flush is deferred - and the alternative is a flag threaded through
  // the shared block above, which board 1's binary cannot afford.
  sessionExpMeasure();
  const int expNow = sessionExpandedH(sessionCount);
  if (expNow != expHCache) {
    expHCache = expNow;
    tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
    for (int i = 0; i < MAX_SESSIONS; i++) rowSigCache[i][0] = '\0';
    overflowCache[0] = '\0';
  }
#endif
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
    char sig[SESSION_ROW_SIG_LEN];
    snprintf(sig, sizeof(sig), "%s|%s|%s|%s|%s|%d", sessions[i].name, sessions[i].status, sub,
             sessions[i].title, dispMacTag(sessions[i].hostSlot), emojiIdForLink(sessions[i].hostSlot));
#if !BOARD_USES_TFT_ESPI
    // The expanded row draws the LAST PROMPT and the PATH, so both belong in its
    // signature - a row repaints only when this string changes, and a field drawn
    // but not signed is exactly the staleness the title itself shipped once.
    // Appended ONLY for the row that is actually expanded: signing them for every
    // row would repaint a compact row whenever its prompt changed, and a wholesale
    // repaint of pixels that did not change is the flicker this discipline exists
    // to prevent. SESSION_ROW_SIG_LEN is 304 here for exactly these two fields.
    if (sessionRowExpanded(pos)) {
      size_t used = strlen(sig);
      if (used + 2 < sizeof(sig))
        snprintf(sig + used, sizeof(sig) - used, "|%s|%s", sessions[i].prompt, sessions[i].path);
    }
#endif
    if (strncmp(sig, rowSigCache[pos], sizeof(rowSigCache[pos])) != 0) {
      strncpy(rowSigCache[pos], sig, sizeof(rowSigCache[pos]) - 1);
      rowSigCache[pos][sizeof(rowSigCache[pos]) - 1] = '\0';
      drawSessionRow(pos); // resolves i = sessionAt(pos) itself, for the row's own y
      rowDurCache[pos][0] = '\0'; // row was repainted, duration must redraw too
    }
    char dur[8];
    formatDuration(sessions[i].statusSinceMillis, dur, sizeof(dur));
#if !BOARD_USES_TFT_ESPI
    // The band card's duration lives IN THE BAND, and it is an ordinary change-only
    // field there: same padded fixed-width string, same per-field cache, same one
    // small clear box - only the lane, the face and the colours differ, because it
    // sits on the status colour rather than on the card. Repainting the whole band
    // for it would be a clear-then-redraw of a 292x42 region once a SECOND for the
    // first minute of every status (formatDuration counts seconds under a minute),
    // which is what this file's redraw discipline exists to prevent.
    if (sessionRowExpanded(pos)) {
      char bdur[8];
      bandDurText(i, bdur, sizeof(bdur));
      drawIfChanged(rowDurCache[pos], sizeof(rowDurCache[pos]), bdur,
                    SESSION_ROW_X + SESSION_ROW_W - BORDER_CARD - SESSION_BAND_PAD,
                    sessionRowYAt(pos) + BORDER_CARD + bandDurDY(), T_BODY, 1,
                    COLOR_CARD,
                    sessionBandFill(colorForStatus(sessions[i].status),
                                    sessionXfadeT(sessions[i].id),
                                    // ASKS THE RAMP AGAIN rather than reading
                                    // bandFillShown, so this opaque box can sit up
                                    // to ONE ramp step from the band under it - the
                                    // same mismatch class sessionBandFill was
                                    // introduced to prevent for the crossfade, at a
                                    // scale that does not matter. It is bounded by
                                    // one step of a ramp whose whole travel is a
                                    // highlight, it lasts until the pulse's next
                                    // reconcile (at most SESSION_PULSE_INTERVAL_MS),
                                    // and it self-heals because that reconcile
                                    // repaints the band and this field with it.
                                    // Reading bandFillShown instead would be wrong
                                    // in the other direction: it is what was painted
                                    // LAST, which during a crossfade is a frame old.
                                    sessionPulseA(sessions[i].status)), TR_DATUM);
      continue;
    }
#endif
    padLeftTo(dur, sizeof(dur), 7);
    // Through the same two helpers the draw uses, so the duration cannot land on a
    // row whose height the layout has moved.
    int y = sessionRowYAt(pos);
    int rowH = sessionRowHAt(pos);
    int durY = rowH >= SESSION_LARGE_MIN_H ? y + rowH - SESSION_DUR_UP
                                           : y + SESSION_SUBC_Y;
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
    // contentBottom() - SESSION_OVERFLOW_H + 4, not a literal -12: the strip's own
    // reserved band already tracks the face (16px on board 1, 19 on board 2), and
    // -12 would have put a 16px line plus drawIfChanged's 1px margins into the
    // footer's first drawn row. Board 1's 16 - 4 = 12 reproduces its own offset
    // exactly, so both boards keep the same single row of overhang into the
    // footer's padding.
    drawIfChanged(overflowCache, sizeof(overflowCache), buf, SESSION_ROW_X + 2,
                  contentBottom() - SESSION_OVERFLOW_H + 4, 1, 1,
                  hiddenAskingCount > 0 ? COLOR_BAD : COLOR_LABEL, COLOR_BG);
  }
#if !BOARD_USES_TFT_ESPI
  // This is the leaf that actually draws session rows, reached from both
  // renderSessionsTab() (the once-per-second tick) and drawSessionsAll()
  // (a full repaint) - flushing here, rather than only at the end of
  // loop(), keeps this call's own dirty rect from being unioned with
  // whatever renderFooter()/renderSettingsTab() draw in the same tick.
  tft.flush();
#endif
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
#if !BOARD_USES_TFT_ESPI
      // drawSessionDetail()/renderDetailDuration() are the only draws on
      // this path, and closeSessionDetail() (the other branch below)
      // already flushes on its own via drawSessionsAll() -> renderSessionsList().
      tft.flush();
#endif
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
#if !BOARD_USES_TFT_ESPI
  // §7: THE AGENT, board 2 only - and it is here because the BAND is. That card is
  // headed by drawSessionBand(), whose MARK (the Claude spark or the Codex mark) is
  // chosen from s.agent and is nothing else on this screen; the AGENT column that
  // used to spell it out in text is gone. So agent is now the only input to a
  // prominent element of this card that the signature could not see.
  //
  // BOARD 1 IS DELIBERATELY EXCLUDED, not overlooked. Its card still draws the agent
  // as text in its AGENT column and has the identical latent gap - but the gap has
  // never been a live bug on either board (a session's agent is fixed for the life of
  // its id, and detailIndex is re-anchored from detailId every render), and this
  // branch is held byte-identical. It is board 2's band that promotes the field from
  // "cannot change" to "drives the loudest thing on the card".
  used = strlen(out);
  if (used + 6 < outSize)
    snprintf(out + used, outSize - used, "|%s", sessions[idx].agent);
#endif
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
// MSG_BTN_W/H live in the board headers: 76x22 on board 1, 76x26 on board 2 -
// board 1's own proportions held at board 2's scale, not TAP_MIN. Neither board
// sizes the chip to the touch floor, because the LIVE tap zone doesn't come from
// it - see the `sx >= msgBtnX() - 24` test below, over the whole header row. So
// the chip's height no longer has to fill the row; on board 2, where it just
// shrank, msgBtnY() centres it in DETAIL_HEAD_H instead of sitting a fixed 2px
// into it. Board 1 keeps the literal `+ 2` behind its own #if - (28-22)/2 is 3,
// not 2, so the "centre" formula is not this board's existing position and
// switching it over would move a binary this port holds byte-identical.
int msgBtnX() { return CARD_X + CARD_W - MSG_BTN_W; }
int msgBtnY() {
#if BOARD_USES_TFT_ESPI
  return CONTENT_Y + 2;
#else
  return CONTENT_Y + (DETAIL_HEAD_H - MSG_BTN_H) / 2;
#endif
}
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
//
// ASK_VOICE_MAX_LINES lives in deckhand_display.ino, not here - see the note there.
// BOARD_H rather than tft.height() because only the former is a constant
// expression; they are equal at SCREEN_ROTATION 0, the same substitution the
// reader's page-budget asserts make.
static_assert(CONTENT_Y + 22 + ASK_VOICE_MAX_LINES * CODE_LINE_H + 12
                  < (BOARD_H - FOOTER_H) - H_BTN - H_BTN - SP_2,
              "the voice-answer confirm panel now overlaps its own SEND button - "
              "either lower ASK_VOICE_MAX_LINES or the panel will sign text the "
              "user cannot see");
bool askVoiceTooLong(int idx) {
  return countWrappedLines(sessions[idx].askVoiceText, FONT_CODE, CARD_W - 8) >
         ASK_VOICE_MAX_LINES;
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
    // The code face on a panel: this is verbatim quoted text, the same treatment
    // code and commands already get. The host caps an answer transcript at 150
    // UTF-8 bytes (VOICE_ANSWER_TEXT_MAX_BYTES), which needs at most ~5 lines
    // even with word-wrap losses, so the cap of 8 is real headroom on both boards.
    //
    // THE LINE STEP IS CODE_LINE_H, NOT A LITERAL 13, and the literal was a
    // live defect rather than dead code. It was left alone as "board 2 has no mic",
    // but neither this draw nor the ask parse it reads is guarded by BOARD_HAS_MIC:
    // askVoiceText comes from a transcript the HOST parks and republishes in every
    // tick, and MAX_LINKS is 2 - so board 1 could speak an answer and board 2 would
    // draw the reply at a 13px pitch under a 16px cell, each line's opaque box
    // eating the previous line's bottom 3 rows, with the panel 24px short of its
    // own text. Unexercised is not unreachable.
    //   board 1  lane CARD_W-8 = 208px / 6 = 34 cols, panel 8*13+12 = 116 tall,
    //            56..172 against a SEND at 206  -> 34px clear
    //   board 2  lane CARD_W-8 = 288px / 8 = 36 cols, panel 8*16+12 = 140 tall,
    //            68..208 against a SEND at 352  -> 144px clear
    int lines = countWrappedLines(s.askVoiceText, FONT_CODE, CARD_W - 8);
    if (lines > ASK_VOICE_MAX_LINES) lines = ASK_VOICE_MAX_LINES;
    uiFillRound(CARD_X - 4, CONTENT_Y + 22, CARD_W + 8, lines * CODE_LINE_H + 12, R_SM,
                COLOR_CARD, COLOR_BG);
    drawWrappedText(s.askVoiceText, CARD_X, CONTENT_Y + 28, FONT_CODE, CODE_LINE_H, CARD_W - 8,
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
  tft.drawString("< Back", CARD_X, CONTENT_Y + DETAIL_BACK_Y);
  // (READ ALL button lands top-right of this row, drawn below once the
  // overflow question is settled - far away from the decision buttons.)

  // What kind of decision this is, at a glance; session name on the right.
  const char* badge = isPerm ? "PERMISSION REQUEST" : (isPlan ? "PLAN APPROVAL" : "QUESTION");
  setUIFont(1);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.drawString(badge, CARD_X, CONTENT_Y + ASK_BADGE_Y);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(s.name, tft.width() - CARD_X, CONTENT_Y + ASK_BADGE_Y);
  tft.setTextDatum(TL_DATUM);

  // Symmetric text margins: CARD_X on both sides.
  int maxW = tft.width() - 2 * CARD_X;

  // Title (up to 2 lines, font 2, measured wrap).
  //
  // THE 17 IS THE SAME LITERAL AS THE PROSE-DETAIL STEP BELOW, AND THE SAME TRADE - it
  // is stated here rather than derived, because a derivation would move board 1. It is
  // not a cell height on either board: on board 1 it is Cozette's 13 plus 4 of leading,
  // and on board 2 it is 1px OVER Spleen 8x16's 16. A step over the cell cannot
  // overlap - which is the whole difference from the CODE_LINE_H sites, where a 13px
  // step under a 16px cell had each line's opaque box eating the line above - so the
  // cost here is tight leading on a two-line title, not clipped descenders.
  // The honest derivation is uiLineH(2) + 4, which is 17 on board 1 and 20 on board 2;
  // that is a change to make with the rest of this screen's vertical rhythm (the title
  // block feeds `textTop`, which feeds `visLines` and the READ ALL overflow decision),
  // not as a side effect of a correctness fix, and board 1's binary is held
  // byte-identical. sessions-geom-check.mjs measures the title block at this literal,
  // so the clearance below it is checked at what the panel actually draws.
  int y = drawWrappedText(s.askTitle, CARD_X, CONTENT_Y + ASK_TITLE_Y, 2, 17, maxW, 0, 2,
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
  // CODE_LINE_H, not a literal 13, and this one is not merely unexercised - EVERY
  // `perm` ask reads as code (detailLooksLikeCode is true for all of them), so on
  // board 2 the preview was drawing 16px cells at a 13px step: each line's opaque
  // box erased rows 13..15 of the line above it, which is exactly where Spleen's
  // descenders live (ascent 12, descent 4). A command containing g/j/p/q/y showed
  // those letters chopped. Found while fixing the identical literal in the
  // voice-confirm panel below - same function, same face, same mistake.
  //
  // The PROSE step stays a literal 17 on both boards. It is not a cell height: on
  // board 1 it is Cozette's 13 plus 4 of leading, and on board 2 it is 1px over
  // Spleen's 16 - tight leading, but a step OVER the cell, so nothing overlaps.
  // Board 1's binary is held byte-identical, so deriving it (uiLineH(2) + 4 = 20
  // here) is a change to make with the rest of the ask screen's rhythm rather than
  // as a side effect of a correctness fix.
  int dLineH = isCode ? CODE_LINE_H : 17;
  int pad = isCode ? 7 : 0;
  int textW = maxW - 2 * pad;
  uint16_t textBg = isCode ? COLOR_CARD : COLOR_BG;

  // Mirror mode adds an "ANSWER ON YOUR MAC" caption above the option list, so
  // the text block has to give up that row - otherwise a detail long enough to
  // fill every visible line runs into it.
  //
  // THE 14 IS A LITERAL ON BOTH BOARDS, deliberately, and it is the same trade as
  // the 17 above: this is a RESERVED BAND, not a cell height, and deriving it would
  // move a board. The caption is drawn TL_DATUM at `optTop - hintH + 2`, so its ink
  // runs optTop-12 .. optTop-12+cell-1: optTop-12..optTop on board 1 (13px cell)
  // and optTop-12..optTop+3 on board 2 (16px). Overshooting optTop is harmless
  // because a mirror-mode option row draws no chrome at all - just a dim bar and a
  // label at `by + ASK_OPT_H / 2 - 8` - so the ink it has to clear is the LABEL's,
  // not the row's top edge. Measured clearance from the caption's last ink row to
  // the first option's first ink row: 7px on board 1 (label at optTop+8) and 11px
  // on board 2 (ASK_OPT_H 46, label at optTop+15). The honest derivation is
  // uiLineH(1) + 1, which is 14 here and 17 there; taking it would shrink board 2's
  // `visLines` budget and so change which details show READ ALL, which belongs with
  // the rest of this screen's vertical rhythm rather than inside a correctness fix -
  // and board 1's binary is held byte-identical besides.
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
    uiFillRound(ASK_READ_BTN_X, CONTENT_Y + 1, ASK_READ_BTN_W, ASK_READ_BTN_H, R_SM,
                COLOR_CARD, COLOR_BG);
    uiStrokeRound(ASK_READ_BTN_X, CONTENT_Y + 1, ASK_READ_BTN_W, ASK_READ_BTN_H, R_SM,
                  BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
    setUIFont(2);
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.setTextDatum(MC_DATUM);
    // Centred in the chip's own height, not at a fixed +13: board 2's chip is
    // TAP_MIN tall and the label would otherwise sit up against its top edge.
    tft.drawString("READ ALL", ASK_READ_BTN_X + ASK_READ_BTN_W / 2,
                   CONTENT_Y + 1 + ASK_READ_BTN_H / 2);
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
// BLECharacteristic::notify() has no single-peer form ON EITHER BACKEND - and
// that is what the `to=` address rests on, so it was re-checked rather than
// carried over. Bluedroid walks getPeerDevices() and calls
// esp_ble_gatts_send_indicate per peer with no reference to the server's
// m_connId; NimBLE walks its own m_subscribedVec and calls
// ble_gatts_notify_custom(conn_handle, ...) per subscriber. Same shape, same
// consequence: an unaddressed ANSWER reaches the OTHER Mac too, and it logs an
// authentication failure on every answer. That trains you to ignore the one log
// line that actually means something.
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
    if (sy < CONTENT_Y + DETAIL_HEAD_H) {
      // The whole right end of the header row, not only the drawn chip - the extra
      // 24px to its left is the same trade the tab bar's slots already make. On
      // board 1 that makes a 100x28 target out of a 76x22 chip; on board 2 the chip
      // is already 88x46, so this is slop rather than the target.
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
  if (sy < CONTENT_Y + DETAIL_HEAD_H) {
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
  tft.drawString("< Back", CARD_X, CONTENT_Y + DETAIL_BACK_Y);
  // Outlined, not filled: it opens a screen whose own primary action is SEND, and
  // the filled treatment belongs to that one.
  if (msgOffered(idx))
    uiButton(msgBtnX(), msgBtnY(), MSG_BTN_W, MSG_BTN_H, "TYPE", COLOR_ACCENT, false, COLOR_BG);

  uiFillRound(CARD_X, cardY, CARD_W, DETAIL_CARD_H, RADIUS, COLOR_CARD, COLOR_BG);
  uiStrokeRound(CARD_X, cardY, CARD_W, DETAIL_CARD_H, RADIUS, BORDER_CARD, color, COLOR_BG);

#if !BOARD_USES_TFT_ESPI
  // ---- §7 THE BAND HEADS THE CARD ----
  // The same component the sessions tab's first row wears, on the same card
  // interior, carrying the same three things: the agent mark, the status WORD and
  // the duration. So the status pill and the "for 12m - 14:31" line below it are
  // both GONE from board 2's arm - the band says both, 44px higher and at T_HEAD
  // instead of a 18px pill, and drawing them twice on one card is exactly the
  // "says the same thing twice" the STARTED/AGENT pairing was written to avoid.
  //
  // IT DOES NOT CARRY THE WALL-CLOCK, and §7's prose asks for it. Measured at this
  // board's true geometry: "4m - 09:34" is 10 characters at TEXT_ADV = 80px, which
  // leaves the word 144px against a "NEEDS YOUR INPUT" that inks 192. It collides
  // by 48. Three resolutions were rendered side by side and this is the one that
  // was chosen; the band's fixed 3-character duration lane is the other half of it
  // (SESSION_BAND_DUR_CHARS). Adding the clock back here is the change to not make,
  // and sessions-geom-check.mjs asserts the lane on THIS surface so it fails rather
  // than merely looking cramped.
  //
  // §6'S CROSSFADE BELONGS TO THE LIST, AND WITHOUT THIS LINE IT FREEZES HERE.
  // tickSessionAnim() clears xfadeId the moment any full-screen surface takes the
  // glass - this card is one of them - and it is the ONLY thing that advances a
  // fade. But handleLine() starts the fade and repaints this card in the SAME
  // tick, before loop() reaches that clear: the band was therefore painted at
  // frame 0 of a fade nothing would ever advance, and STAYED there, with the
  // leaving and arriving words overlapping at half strength each. Seen on the
  // glass - "WAITING FOR YOU" and "WORKING" superimposed and both illegible, on a
  // card already wearing the new status colour in its border. Cleared here with
  // exactly the meaning tickSessionAnim's own guard gives it: there is no fade on
  // this screen, so the band paints the settled colour.
  xfadeId[0] = '\0';
  // The card INTERIOR, inset by its own 2px border, is what drawSessionBand takes -
  // identical to the sessions tab's call site, so the band's top corners are the
  // card's own and its fill never paints outside the outline.
  drawSessionBand(CARD_X + BORDER_CARD, cardY + BORDER_CARD,
                  CARD_W - 2 * BORDER_CARD, idx, color);
  // The band drew the duration once; renderDetailDuration owns it from here, and a
  // wholesale card repaint is exactly when its per-field cache is stale by
  // definition. Same clear board 1 does beside its pill, for the same reason.
  detailDurCache[0] = '\0';
#endif

  // Laid out with a running cursor rather than the hand-derived offsets this screen used
  // to carry (cardY + 78 / +120 / +158). Those had to be re-derived by hand every time a
  // field moved, which is how the screen ended up sparse in the first place.
  //
  // EVERY ADVANCE BELOW IS A NAMED, DERIVED STEP (DETAIL_*_STEP in
  // deckhand_display.ino), not a literal - and that is not tidying. The literals
  // this carried were board 1's: 26 for the name, 13 for a label, 11 for a wrapped
  // line. Board 2 draws a 24px name band and 16px lines, so those numbers laid its
  // ink out on Cozette's spacing - the title's box landing inside the name's, the
  // name itself drawn at a 64px rung that swallowed the pill as well. Each step is
  // now DETAIL_NAME_H / DETAIL_LINE_H / DETAIL_TEXT_LINE_H plus DETAIL_AIR, and
  // every one of them equals the literal it replaced on board 1.
  // The two label->value pairs are deliberately NOT given air: a label and the
  // value it names read as one block.
#if BOARD_USES_TFT_ESPI
  int cy = cardY + DETAIL_PAD_Y;
#else
  // The body starts where the band ENDS, exactly as the sessions tab's band card
  // does (`nameTop = y + SESSION_BAND_H`) - the band replaces the card's own top
  // pad rather than sitting above it. No air is added here and none is available:
  // DETAIL_CARD_H is at its ceiling (see the derivation in board_es3c35p.h), and
  // the name's opaque box is COLOR_CARD, so the ~4 blank rows at the top of a
  // Spleen 12x24 cell are the visual gap under the band.
  int cy = cardY + SESSION_BAND_H;
#endif
  const int LX = CARD_X + PAD;              // label/value left edge
#if BOARD_USES_TFT_ESPI
  const int RX = CARD_X + CARD_W / 2 + 2;   // right column, for the paired short fields
  const int colW = CARD_W / 2 - PAD - 4;
#endif

  // Project name - large, clipped to the card in the big font.
  // DETAIL_NAME_FONT, not a literal 4: on board 2 rung 4 is Spleen 32x64, whose
  // 64-row opaque box swallowed the title and the pill below it (the arithmetic is
  // in board_es3c35p.h beside DETAIL_NAME_H). The step is that rung's own cell,
  // so the two can never disagree.
  char nameBuf[26];
  snprintf(nameBuf, sizeof(nameBuf), "%s", s.name);
  setUIFont(DETAIL_NAME_FONT);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  while (strlen(nameBuf) > 1 && tft.textWidth(nameBuf) > maxW) nameBuf[strlen(nameBuf) - 1] = '\0';
  tft.drawString(nameBuf, LX, cy);
  cy += DETAIL_NAME_STEP;

  // What the session is about, straight under its name - the same title the list row
  // shows, which was previously nowhere on this screen.
  if (s.title[0]) {
    char titleBuf[48];
    setUIFont(2);
    fitText(titleBuf, sizeof(titleBuf), s.title, maxW);
    tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
    tft.drawString(titleBuf, LX, cy);
    cy += DETAIL_TITLE_STEP;
  }

#if BOARD_USES_TFT_ESPI
  // Status pill; renderDetailDuration draws "for 12m - 14:31" to its right.
  detailPillY = cy;
  drawStatusPill(LX, cy, pillLabel(status), status, false);
  detailDurCache[0] = '\0'; // force the duration to redraw after this repaint
  cy += DETAIL_PILL_STEP;
#endif

  tft.drawFastHLine(LX, cy, maxW, COLOR_LABEL);
  cy += DETAIL_RULE_STEP;

  // LAST PROMPT - the most useful text on the screen: what you actually asked.
  if (s.prompt[0]) {
    setUIFont(1);
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
    tft.drawString("LAST PROMPT", LX, cy);
    cy += DETAIL_LBL_STEP;
    drawWrappedText(s.prompt, LX, cy, T_META, DETAIL_TEXT_LINE_H, maxW, 0,
                    DETAIL_PROMPT_LINES, COLOR_VALUE, COLOR_CARD);
    cy += detailTextStep(DETAIL_PROMPT_LINES);
    tft.drawFastHLine(LX, cy, maxW, COLOR_LABEL);
    cy += DETAIL_RULE_STEP;
  }

  // PATH - wrapped, since paths are long and the tail is the informative end.
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.drawString("PATH", LX, cy);
  cy += DETAIL_LBL_STEP;
  drawWrappedText(s.path[0] ? s.path : "-", LX, cy, T_META, DETAIL_TEXT_LINE_H, maxW, 0,
                  DETAIL_PATH_LINES, COLOR_VALUE, COLOR_CARD);
  cy += detailTextStep(DETAIL_PATH_LINES);

#if BOARD_USES_TFT_ESPI
  // The four short fields pair into two columns instead of a four-row ladder. That is
  // what buys the room for the title and the prompt above without a taller card.
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.drawString("MODEL", LX, cy);
  tft.drawString("GIT BRANCH", RX, cy);
  cy += DETAIL_COL_LBL_STEP;
  drawColValue(LX, cy, s.model, colW);
  drawColValue(RX, cy, s.branch, colW);
  cy += DETAIL_COL_VAL_STEP;

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
  cy += DETAIL_COL_LBL_STEP;
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
  // makes the icon-only treatment safe everywhere else. UNGATED, per the same
  // rule every other icon site follows: an icon shows whenever one is set,
  // regardless of how many Macs are connected - it's personalisation, not
  // disambiguation. Only the TEXT tag above (`mac`, and "AGENT / MAC" vs
  // "AGENT") stays gated on mac[0]/usedLinkCount() > 1, since a lone Mac's
  // own name really is redundant noise the icon isn't.
  int agentEmoji = emojiIdForLink(s.hostSlot);
  if (agentEmoji >= 0) {
    // Pieces, not one drawColValue() call - that helper only clips a single
    // string, and there's real headroom to spare here without needing to:
    // measured worst case is "CC" + 4px gap + the icon + 4px gap + dispMacTag()'s
    // own 7-char cap, at each board's own advance: 12 + 4 + 13 + 4 + 42 = 75px
    // against board 1's 90px column, and 16 + 4 + 16 + 4 + 56 = 96px against board
    // 2's 126px one (CARD_W/2 - PAD - 4).
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
    // y == cy for both: the icon's y IS the text's y, because MAC_EMOJI_SIZE is the
    // board's body cell height - the same vertical rule the SETTINGS row and every
    // other icon site uses, and the reason nothing here centres anything.
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
#else
  // ---- §7 THE META LINE, AND WHERE THE MAC LIVES ----
  // The two label+value column pairs are GONE. MODEL / GIT BRANCH and
  // STARTED / AGENT spent four labels, four values and 71px of card on three
  // short facts and a Mac tag. One dim T_META line carries the facts that are
  // still worth carrying, and the Mac rides at the right end of it. The AGENT
  // half needs no text at all here: the band at the top of this card draws the
  // agent's MARK, which is what that column existed to say.
  //
  // `started` IS DROPPED, AND THAT IS WHAT BUYS ROOM FOR THE MAC. Measured at
  // this board's real lane (CARD_W - 2*PAD = 260) and advance (TEXT_ADV = 8): a
  // representative "model - branch - HH:MM" is 21 characters = 168px, and the Mac
  // cluster is DETAIL_META_GAP + MAC_EMOJI_SIZE + 4 + a 7-character tag = 84, so
  // the pair fits with 8px to spare. Restore `started` and the same line is 29
  // characters = 232px, i.e. 316 against 260 - over by 56, with nowhere for the
  // Mac to go. sessions-geom-check.mjs asserts BOTH halves, and the second one
  // deliberately: it encodes WHY the field is absent, so a future reader who
  // re-adds it fails there rather than shipping a clipped line.
  //
  // NO MIDDLE DOT. Spleen declares 0x20..0x7E exactly as Cozette does, so U+00B7
  // draws as a blank box - the same fact that already forces the Mac tag's ASCII
  // "/" separator and fitText's three ASCII dots. " - " is the separator this UI
  // already uses to put two facts on one line ("for 12m - 14:31").
  //
  // THE CLOCK IS THE STATUS-SINCE INSTANT, NOT s.actSec, AND THAT IS WHAT LETS IT
  // BE A STATIC FIELD. actSec advances on every event while nothing else on this
  // card changes, so drawing it here would freeze at whatever it read when the
  // card last repainted - the silent-staleness class every cache on this screen
  // exists for - while putting actSec in the signature instead would repaint the
  // whole card every tick, which is the flicker the discipline exists to prevent.
  // Board 1 escapes that by ticking "for 12m - 14:31" out of renderDetailDuration;
  // here the band already owns the ticking half. The status-since instant is
  // hostNowSec() minus the elapsed time, and BOTH advance from millis() at the
  // same rate - so their difference is exactly constant between repaints, and
  // `status` is already in the signature, so a status change repaints and
  // recomputes it.
  long nowSec = hostNowSec();
  long elapsed = (long)((millis() - s.statusSinceMillis) / 1000);
  // No clock yet, or a status older than a day, reads "earlier" rather than a time
  // from another day masquerading as this one - formatClock's own -1 convention.
  long sinceSec = -1;
  if (nowSec >= 0 && elapsed < 86400L) {
    sinceSec = (nowSec - elapsed) % 86400L;
    if (sinceSec < 0) sinceSec += 86400L;
  }
  char clk[10];
  formatClock(sinceSec, clk, sizeof(clk));
  // The redundant "claude-" prefix stripped, exactly as buildSessionSubline does -
  // one fact spelled the same way on both surfaces.
  const char* metaModel = s.model[0] ? s.model : "-";
  if (strncmp(metaModel, "claude-", 7) == 0) metaModel += 7;
  char metaBuf[80];
  if (s.branch[0]) snprintf(metaBuf, sizeof(metaBuf), "%s - %s - %s", metaModel, s.branch, clk);
  else             snprintf(metaBuf, sizeof(metaBuf), "%s - %s", metaModel, clk);
  // THE MAC CLUSTER IS MEASURED AND RIGHT-ANCHORED FIRST, and the meta text is then
  // clipped to whatever lane is left - so the two can never collide however long a
  // model or branch name is (model[24] and branch[24] together already overflow the
  // lane on their own). fitText, not a character count: the clip has to be measured.
  //
  // THE ICON IS UNGATED AND THE TEXT TAG IS NOT, and that asymmetry is the rule
  // every icon site in this sketch follows. An icon shows whenever one is set,
  // because it is personalisation; dispMacTag() returns "" until a second Mac is
  // actually connected, because a lone Mac's own name disambiguates nothing. Same
  // split the AGENT / MAC column this replaces already carried, including the
  // absence of a "/" when an icon sits between the two - here there is no agent
  // text for it to separate at all.
  const char* mac = dispMacTag(s.hostSlot);
  int macEmoji = emojiIdForLink(s.hostSlot);
  setUIFont(1);
  int macW = macEmoji >= 0 ? MAC_EMOJI_SIZE : 0;
  if (mac[0]) macW += (macW ? 4 : 0) + tft.textWidth(mac);
  int metaLane = maxW - (macW ? macW + DETAIL_META_GAP : 0);
  char metaFit[80];
  fitText(metaFit, sizeof(metaFit), metaBuf, metaLane);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(metaFit, LX, cy);
  if (macW) {
    int mx = CARD_X + CARD_W - PAD - macW;
    if (macEmoji >= 0) {
      // y == cy for both: the icon's y IS the text's y, because MAC_EMOJI_SIZE is
      // this board's body cell height - the same vertical rule the SETTINGS row and
      // every other icon site uses, and the reason nothing here centres anything.
      drawEmoji(macEmoji, mx, cy, COLOR_CARD);
      mx += MAC_EMOJI_SIZE + 4;
    }
    if (mac[0]) tft.drawString(mac, mx, cy);
  }
#endif

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
// The duration ticks on its own cache so it can update every second without
// repainting the whole card. WHERE it lands is per board and it is two different
// fields: board 1 draws "for 12m - 14:31" right of the status pill; board 2 has
// neither, and updates the band's own 3-character duration lane instead.
void renderDetailDuration() {
  if (detailIndex < 0 || detailIndex >= sessionCount) return;
  if (sessions[detailIndex].askPid[0]) return; // ask screen has its own layout
#if !BOARD_USES_TFT_ESPI
  // §7: the duration lives IN THE BAND on this board, and it is the SAME
  // change-only field the sessions tab's band card ticks - same bandDurText(),
  // same fixed SESSION_BAND_DUR_CHARS lane, same TR_DATUM origin, only the card's
  // x/y differ. Repainting the band for it would be a clear-then-redraw of a
  // 292x42 region once a second for the first minute of every status, which is
  // what this file's redraw discipline exists to prevent.
  //
  // THE BACKGROUND IS bandFillShown - THE RECORD OF WHAT WAS PAINTED - where the
  // sessions tab deliberately re-asks sessionBandFill() instead. The difference is
  // real rather than stylistic: on the tab a crossfade or a pulse repaints the band
  // between ticks, so the record is a frame old; HERE nothing repaints it at all
  // (tickSessionAnim and tickWorkingSpinner both early-return on showingDetail), so
  // the record is exact and re-asking a free-running ramp would paint an opaque box
  // in a colour the band underneath it has never been.
  {
    char bdur[8];
    bandDurText(detailIndex, bdur, sizeof(bdur));
    drawIfChanged(detailDurCache, sizeof(detailDurCache), bdur,
                  CARD_X + CARD_W - BORDER_CARD - SESSION_BAND_PAD,
                  DETAIL_CARD_Y + BORDER_CARD + bandDurDY(), T_BODY, 1,
                  COLOR_CARD, bandFillShown, TR_DATUM);
  }
  return;
#else
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
#endif
}
