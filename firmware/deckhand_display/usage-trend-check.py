#!/usr/bin/env python3
"""Exercise the USAGE trend ring's and burn estimators' arithmetic without a device.

Thresholds are PARSED out of the firmware, never transcribed: a mirror that
drifts from the source must fail loudly rather than pass while the device is
wrong. Same convention as batt-trend-check.py, which this follows.
"""
import re, sys, pathlib

D = pathlib.Path(__file__).parent
HDR = (D / "board_es3c35p.h").read_text()
INO = (D / "usage.ino").read_text()

def const(name, src=HDR):
    # SCANS EVERY const DECLARATION STATEMENT, not just one built around `name` -
    # a single-name regex (`const int NAME\s*=\s*([^;]+);`) cannot see past the
    # first comma, so on a multi-declarator line ("const int CARD_X = 12,
    # CARD_W = 296;") it silently returned "12, CARD_W = 296" for CARD_X and
    # nothing at all for CARD_W - proven by running it. Splitting the whole
    # declarator list on commas is what fixes both.
    for m in re.finditer(
            r"const\s+(?:int|long|unsigned long|float)\s+([A-Za-z_0-9 ,=\-+*/()]+);", src):
        for part in m.group(1).split(","):
            if "=" not in part:
                continue
            k, v = part.split("=", 1)
            if k.strip() == name:
                return v.strip()
    sys.exit(f"FAIL: could not parse {name} out of the firmware - "
             f"the checker's parse is broken, or the constant was renamed")

def eval_const_expr(expr, src=HDR):
    """A tiny recursive-descent evaluator - numbers, identifiers (resolved via
    const_int, recursively), +, -, *, /, parens, unary minus, C's truncating
    division - mirroring evalInt() in geom-common.mjs. A second, independent
    implementation rather than a shared import: this checker is deliberately a
    Python-only verification of the same source the JS geometry checkers read,
    and a shared parser would make the two not-independent. Used so a
    constant's own DERIVATION (SIDE_CHARS's `(CARD_X + CARD_W - PAD - SIDE_X0)
    / TEXT_ADV`) can be read out of the source instead of only a bare literal
    or a bare alias, which is all const_int() handled before this."""
    pos = [0]
    def ws():
        while pos[0] < len(expr) and expr[pos[0]] == " ":
            pos[0] += 1
    def peek():
        ws()
        return expr[pos[0]] if pos[0] < len(expr) else ""
    def primary():
        ws()
        if pos[0] < len(expr) and expr[pos[0]] == "(":
            pos[0] += 1
            v = add()
            ws()
            if pos[0] >= len(expr) or expr[pos[0]] != ")":
                raise ValueError(f"expected ) in {expr!r}")
            pos[0] += 1
            return v
        if pos[0] < len(expr) and expr[pos[0]] == "-":
            pos[0] += 1
            return -primary()
        if pos[0] < len(expr) and expr[pos[0]] == "+":
            pos[0] += 1
            return primary()
        m = re.match(r"\d+", expr[pos[0]:])
        if m:
            pos[0] += len(m.group(0))
            return int(m.group(0))
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", expr[pos[0]:])
        if m:
            pos[0] += len(m.group(0))
            return const_int(m.group(0), src)
        raise ValueError(f"not a number/identifier at {expr[pos[0]:]!r} in {expr!r}")
    def mul():
        v = primary()
        while True:
            c = peek()
            if c == "*":
                pos[0] += 1
                v *= primary()
            elif c == "/":
                pos[0] += 1
                d = primary()
                if d == 0:
                    raise ValueError(f"divide by zero in {expr!r}")
                q = abs(v) // abs(d)         # C truncates toward zero, // floors
                v = q if (v < 0) == (d < 0) else -q
            else:
                return v
    def add():
        v = mul()
        while True:
            c = peek()
            if c == "+":
                pos[0] += 1
                v += mul()
            elif c == "-":
                pos[0] += 1
                v -= mul()
            else:
                return v
    v = add()
    ws()
    if pos[0] != len(expr):
        raise ValueError(f"trailing {expr[pos[0]:]!r} in {expr!r}")
    return v

def const_int(name, src=HDR):
    v = const(name, src)
    # A constant may be a literal ("2880") or a reference to another named
    # constant ("USAGE_RING_STEP_MIN", as BURN_MIN_ELAPSED is) - resolved
    # recursively rather than transcribed, so a rename of the referenced
    # constant is not a silent drift here.
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", v):
        return const_int(v, src)
    # Anything else is a genuine arithmetic expression - SIDE_CHARS is exactly
    # this shape. eval_const_expr() raises ValueError on anything it cannot
    # parse (a construct this grammar does not have), which is treated the
    # same as the two simpler cases failing: a loud exit, not a silent 0.
    try:
        return eval_const_expr(v, src)
    except ValueError as e:
        sys.exit(f"FAIL: {name} is `{v}`, which this checker cannot evaluate as an int ({e})")

SLOTS    = const_int("USAGE_RING_SLOTS")
STEP_MIN = const_int("USAGE_RING_STEP_MIN")
DROP     = const_int("USAGE_RING_DROP_PCT")
SPAN     = (SLOTS - 1) * STEP_MIN

n = fails = 0
def chk(cond, msg):
    global n, fails
    n += 1
    if not cond:
        fails += 1
        print("  FAIL " + msg)

# ---- the span is exactly 150 min, and a FULL ring's caption depends on it ---
# 30 slots span 145, and a card captioned LAST 2.5H over a 145-minute ring
# overstates it by five minutes. 31 slots span exactly 150.
chk(SPAN == 150, f"ring span (SLOTS-1)*STEP_MIN = {SPAN} min, must be exactly 150")

# ---- THE CAPTION ITSELF, bound to the DERIVATION rather than to the string --
# This used to be `chk("LAST 2.5H" in INO, ...)` - a literal the device wrote
# regardless of how much of the ring had actually filled, so two samples five
# minutes apart captioned as "LAST 2.5H" (a FULL ring's span) just as
# confidently as a genuinely full one. usageSpanCaption() now computes the
# caption from usageRingSpanMin(), so this mirrors THAT function and checks it
# against the ring's own SPAN - a re-derivation of either the ring size or the
# formatting moves this assertion with it, where the old string search could
# not tell a correct caption from a lucky one.
def span_caption(span_min):
    """Mirrors usage.ino's usageSpanCaption()."""
    if span_min < 1:
        return "no history"
    if span_min < 60:
        return f"LAST {span_min}M"
    hours = span_min // 60
    tenths = ((span_min % 60) * 10 + 30) // 60   # round to the nearest tenth
    if tenths >= 10:                             # carry a rounded-up .10 into the hour
        hours += 1
        tenths = 0
    return f"LAST {hours}.{tenths}H"

chk(span_caption(0) == "no history",
    "an empty or one-sample ring (span 0, usageRingSpanMin()'s own sentinel) "
    "captions as \"no history\"")
chk(span_caption(SPAN) == "LAST 2.5H",
    f"a FULL ring (span={SPAN} min) captions as LAST 2.5H - now DERIVED from "
    f"the ring's own size, not a literal that could drift from it")
# THE BUG THIS TASK FIXES: two samples one poll interval apart is a real,
# non-empty ring - and must NOT read as a full ring's 2.5 hours.
chk(span_caption(STEP_MIN) == f"LAST {STEP_MIN}M",
    f"the smallest possible non-empty span ({STEP_MIN} min - two samples one "
    f"ring step apart, the exact scenario observed on the glass) captions in "
    f"minutes, not as LAST 2.5H")
chk(span_caption(59) == "LAST 59M",
    "the widest minutes-branch caption is \"LAST 59M\" (8 chars)")
chk(span_caption(60) == "LAST 1.0H", "the hour branch starts exactly at 60 minutes")
# Every reachable span - 0 through a full ring, with slack for scheduling
# jitter pushing a poll slightly past its nominal interval - captions to at
# most 10 characters: the padLeftTo() width and the resetAt1Cache headroom
# this fix is pinned to, not merely today's two known strings.
worst_caption_len = max(len(span_caption(m)) for m in range(0, SPAN + 30))
chk(worst_caption_len <= 10,
    f"every reachable ring span (0..{SPAN + 29} min) captions to <= 10 "
    f"characters (worst {worst_caption_len}), matching renderNowCard's "
    f"`padLeftTo(buf, sizeof(buf), 10)` and resetAt1Cache[14]'s headroom")

# ---- the ring must be able to measure the window it is used for ------------
for name, win, want in [("5h session", 300, True), ("7d week", 10080, False)]:
    rise = 100.0 * SPAN / win
    chk((rise >= DROP) == want,
        f"{name}: {rise:.2f} points of movement across the ring, "
        f"{'usable' if want else 'INSIDE the integer-percent rounding'}")

# ---- the drop threshold is derived, not picked ------------------------------
# Two Macs' readings differ only in AGE, bounded by one poll interval, and in one
# interval the SHORTEST window moves 100*STEP/300 points. So a drop that small is
# explicable by a mergeUsage source switch and must NOT reset the ring; anything
# larger is a window turnover.
switch_max = 100.0 * STEP_MIN / 300
chk(DROP > switch_max,
    f"USAGE_RING_DROP_PCT {DROP} > {switch_max:.2f}, the most a source-Mac switch "
    f"can move the shortest window in one poll interval")

# =============================================================================
# The burn gate: ONE error budget derives every term.
# =============================================================================
BUDGET    = const_int("BURN_ERR_BUDGET_PCT")
MIN_PCT   = const_int("BURN_MIN_PCT")
MAX_PCT   = const_int("BURN_MAX_PCT")
MIN_ELAP  = const_int("BURN_MIN_ELAPSED")
RING_MAX  = const_int("BURN_RING_MAX_WIN")
RING_RISE = const_int("BURN_RING_MIN_RISE")
RING_MIN_SPAN = const_int("BURN_RING_MIN_SPAN")
LABEL_BYTES   = const_int("BURN_LABEL_BYTES")

# T = elapsed*(100-pct)/pct, so half a point of quantization costs a RELATIVE
# error of 50/(pct*(100-pct)) - independent of elapsed. The budget picks the range.
inside = [p for p in range(1, 100) if 50.0 / (p * (100 - p)) * 100 <= BUDGET]
chk(MIN_PCT == inside[0],
    f"BURN_MIN_PCT {MIN_PCT} == {inside[0]}, the smallest integer pct whose "
    f"quantization error is inside the {BUDGET}% budget")
chk(MAX_PCT == inside[-1],
    f"BURN_MAX_PCT {MAX_PCT} == {inside[-1]}, the largest")
chk(50.0 / ((MIN_PCT - 1) * (100 - MIN_PCT + 1)) * 100 > BUDGET,
    f"pct {MIN_PCT - 1} is OUTSIDE the budget, so the floor is not one point too low")

# The elapsed floor is one poll interval: below that the percentage the device
# holds may have been read BEFORE the window boundary.
chk(MIN_ELAP == STEP_MIN,
    f"BURN_MIN_ELAPSED {MIN_ELAP} == one poll interval ({STEP_MIN} min)")
# ... and it provably never binds, because the average only runs above RING_MAX
chk(MIN_PCT / 100.0 * RING_MAX > MIN_ELAP,
    f"the percent floor always fires first: reaching {MIN_PCT}% at the smallest "
    f"window the average serves ({RING_MAX} min) takes "
    f"{MIN_PCT / 100.0 * RING_MAX:.1f} min > {MIN_ELAP}")

# The crossover: the ring is usable only while its movement clears the rounding.
chk(RING_MAX <= 100 * SPAN / RING_RISE,
    f"BURN_RING_MAX_WIN {RING_MAX} <= {100 * SPAN / RING_RISE:.0f} min, the window "
    f"at which ring movement falls to BURN_RING_MIN_RISE")
chk(300 <= RING_MAX < 10080,
    "the 5-hour window uses the ring and the 7-day window uses the average")

# ---- notation: an estimate takes ~, never >= -------------------------------
# ">=" is reserved for the charge estimator's deliberate floor; the two make
# different promises, and a reader who cannot tell them apart has been told the
# cap will be reached later than it will.
#
# The rule is about the LABEL TEXT a person reads, not about C's >= operator -
# scanning the raw function body conflates the two and rejects a perfectly
# ordinary `if (mins >= 1440)` that never puts ">=" on the glass. Scan ONLY the
# string literals, with comments stripped first: the function's own comment
# explaining this rule quotes ">=" in prose ("Never \">=\", which is..."), and a
# literal regex over uncommented text cannot tell that quoted prose apart from a
# real snprintf() format string.
label = INO[INO.index("void usageBurnLabel"):]
label = label[:label.index("\n}")]
label_code = re.sub(r"//[^\n]*", "", label)
lits = re.findall(r'"((?:[^"\\]|\\.)*)"', label_code)
bad = [s for s in lits if ">=" in s]
chk(not bad, f"a label string says >=: {bad}" if bad
             else "no label string writes >=, which is the charge floor's notation")
chk(any("~" in s for s in lits), "a label string writes ~ for an estimate")
chk("empty now" in label and "won't run out" in label and "burn --" in label,
    "all three refusal/verdict strings are present")
for lit in lits:
    chk(all(0x20 <= ord(ch) <= 0x7E for ch in lit),
        f"every character of {lit!r} is inside Spleen's 0x20..0x7E")

# ---- the label fits the lane it is drawn in --------------------------------
# PARSED, not transcribed: a stale 15 here would stay silently correct only by
# coincidence. Proven: with CARD_HERO_W widened to 200 the real SIDE_CHARS
# becomes 6 while a transcribed 15 here would keep reporting the label as
# fitting - the mirror image of the defect this task exists to fix, where a
# 15-character label drawn TR from the unchanged right edge runs leftward
# through the hero's own box.
SIDE_CHARS = const_int("SIDE_CHARS")
# worst is DERIVED from the clamp usageBurnMinutes() applies
# (BURN_MAX_LEFT_MIN), not transcribed as a literal string - so a re-derivation
# of the clamp (a units change, a bigger ceiling) moves `worst` with it instead
# of leaving a stale string for the lane assertion below to trust.
BURN_MAX_LEFT_MIN = const_int("BURN_MAX_LEFT_MIN", INO)
def burn_label_urgent(mins):
    """Mirrors usageBurnLabel()'s widest "empty ~..." branch only - the case
    that actually sets the side lane's character budget."""
    if mins >= 1440: return f"empty ~{mins // 1440}d {(mins // 60) % 24}h"
    if mins >= 60:   return f"empty ~{mins // 60}h {mins % 60}m"
    return f"empty ~{mins}m"
worst = burn_label_urgent(BURN_MAX_LEFT_MIN)
chk(worst == "empty ~99d 23h",
    f"BURN_MAX_LEFT_MIN ({BURN_MAX_LEFT_MIN}m) still decomposes as \"99d 23h\" (got {worst!r})")
chk(len(worst) <= SIDE_CHARS,
    f"the widest burn label ({worst!r}, {len(worst)}) fits the {SIDE_CHARS}-char side lane")
chk(LABEL_BYTES > len(worst),
    "BURN_LABEL_BYTES has room for the widest label plus its NUL")

# "measuring" (BURN_WARMING's label) is far short of the worst case above, but
# it is a NEW string and this file's own rule is to check what is certified,
# not assume it - the same reason "burn --" and "won't run out" are covered by
# the SIDE_CHARS assertion in HALF 2 rather than left implicit.
chk(len("measuring") <= SIDE_CHARS,
    f"\"measuring\" ({len('measuring')} chars) fits the {SIDE_CHARS}-char side lane")
chk(LABEL_BYTES > len("measuring"),
    "BURN_LABEL_BYTES has room for \"measuring\" plus its NUL")

# =============================================================================
# HALF 1 - the arithmetic MIRROR of usageRingSample/usageRingSlope/usageBurnMinutes.
#
# Task 5 shipped the ring with 4 assertions, all constant-parsing.
# batt-trend-check.py's own ring is a full arithmetic mirror - rateX10, minsLeft,
# ramp generators, ~25 assertions - and exists precisely so the estimator's
# behaviour can be exercised without a device. This closes that gap here, for
# the ring as well as the burn estimators built on it.
#
# WHAT THIS PROVES AND WHAT IT DOES NOT - the same caveat sessions-rank-check.mjs
# states for its own mirror: this executes a Python re-implementation, so it
# proves the ALGORITHM (including the millis() wrap case, unreachable on
# hardware without 49.7 days of uptime) - it does not execute the sketch. Only
# the structural assertions in HALF 2 read usage.ino's real text.
# =============================================================================
U32 = 0x100000000
def uwrap(a):
    return a % U32

QUOTA_STALE = const_int("QUOTA_STALE_SEC")
STEP_MS = STEP_MIN * 60000
BURN_NOT_YET, BURN_EMPTY_NOW = -1, -2
# PARSED, not transcribed alongside its two siblings above - it is new, and the
# rule this whole file follows ("a checker must parse what it certifies, never
# transcribe it") applies most to the constant nobody has looked at twice yet.
BURN_WARMING = const_int("BURN_WARMING", INO)

class Ring:
    """Mirrors usageRingPct[]/usageRingAt[]/usageRingSample()/usageRingSlope()."""
    def __init__(self):
        self.pct = [0] * SLOTS
        self.at  = [0] * SLOTS
        self.count = 0
        self.head  = 0
        self.last  = 0
        self.was_stale = False
        self.reset_calls = 0   # instrumented: how many times reset() actually ran

    def reset(self):
        self.reset_calls += 1
        self.count = 0
        self.head  = 0
        self.last  = 0

    def sample(self, quota_age_sec, five_hour_pct, now_ms, level_bug=False):
        stale = quota_age_sec > QUOTA_STALE
        # level_bug reproduces the item-1 injection (`stale != usageRingWasStale`
        # -> `if (stale)`): reset fires on every stale TICK rather than once on
        # the EDGE into staleness. Used only by the teeth-proof below.
        if level_bug:
            if stale:
                self.was_stale = stale
                self.reset()
        else:
            if stale != self.was_stale:
                self.was_stale = stale
                if stale:
                    self.reset()
        if stale or five_hour_pct < 0:
            return
        if self.last != 0 and uwrap(now_ms - self.last) < STEP_MS:
            return
        if self.count > 0:
            prev = self.pct[(self.head + SLOTS - 1) % SLOTS]
            if five_hour_pct <= prev - DROP:
                self.reset()
        self.last = now_ms
        self.pct[self.head] = five_hour_pct
        self.at[self.head]  = now_ms
        self.head = (self.head + 1) % SLOTS
        if self.count < SLOTS:
            self.count += 1

    def slope(self):
        if self.count < 2:
            return None
        oldest = (self.head + SLOTS - self.count) % SLOTS
        newest = (self.head + SLOTS - 1) % SLOTS
        sx = sy = sxx = sxy = 0.0
        for i in range(self.count):
            idx = (oldest + i) % SLOTS
            # Cast THEN divide - the usage.ino:389 precision fix. Dividing in
            # the unsigned-long domain first would truncate every x to a whole
            # minute before the regression saw it.
            x = uwrap(self.at[idx] - self.at[oldest]) / 60000.0
            y = float(self.pct[idx])
            sx += x; sy += y; sxx += x * x; sxy += x * y
        den = self.count * sxx - sx * sx
        if den == 0:
            return None
        slope = (self.count * sxy - sx * sy) / den
        rise  = self.pct[newest] - self.pct[oldest]
        span  = uwrap(self.at[newest] - self.at[oldest]) // 60000
        return slope, rise, span

def run_selftest():
    """--selftest, same teeth-proving convention as palette-check.mjs: exit 0
    ONLY when the injected fault IS caught by the checker's own assertion,
    non-zero if the checker would be blind to it. The fault is the permanent
    in-mirror `level_bug` variant (Ring.sample's level_bug=True path, added
    for item 4's inline teeth-proof): a stale-triggered ring reset that fires
    on every stale TICK instead of once on the EDGE into staleness - the exact
    regression item 4's `mirror 4` assertion (reset_calls == 1) exists to
    catch. This reruns that scenario through the injected variant and checks
    that mirror 4's own condition would now report FAIL, rather than merely
    trusting the teeth-proof already embedded in the normal run (mirror 4
    teeth, which proves the MIRROR can tell the two apart, not that this
    checker's own --selftest flag does)."""
    print("--selftest: injecting the level_bug variant (reset on every stale "
          "tick, not on the edge into staleness) into mirror 4's scenario.")
    r = Ring()
    for i in range(3):
        r.sample(0, 50, i * STEP_MS)
    for i in range(5):
        r.sample(1000, 50, (3 + i) * STEP_MS, level_bug=True)
    print(f"  injected: reset_calls={r.reset_calls} (mirror 4 wants exactly 1)")
    if r.reset_calls != 1:
        print(f"  mirror 4's `reset_calls == 1` assertion correctly reports FAIL "
              f"under the injected fault (reset_calls={r.reset_calls}) - selftest PASSES")
        sys.exit(0)
    else:
        print("  mirror 4's `reset_calls == 1` assertion is BLIND to the injected "
              "fault (still reads 1 under it) - selftest FAILS")
        sys.exit(1)

if "--selftest" in sys.argv:
    run_selftest()

def burn_minutes(pct, reset_min, window_min, stale, ring):
    """Mirrors usageBurnMinutes()."""
    if stale or pct < 0 or reset_min < 0 or window_min <= 0:
        return BURN_NOT_YET
    if pct > MAX_PCT:
        return BURN_EMPTY_NOW
    if pct < MIN_PCT:
        return BURN_NOT_YET
    if window_min <= RING_MAX:
        # TWO refusals, not one: a ring that has not filled (or not yet
        # SPANNED enough time) WILL speak later - BURN_WARMING. A ring that
        # has filled but shows no real movement MAY NEVER resolve - that
        # stays BURN_NOT_YET. Mirrors usage.ino's usageBurnMinutes() exactly.
        s = ring.slope() if ring is not None else None
        if s is None:
            return BURN_WARMING          # count < 2
        slope, rise, span = s
        if span < RING_MIN_SPAN:
            return BURN_WARMING          # still filling
        if rise < RING_RISE or slope <= 0.0:
            return BURN_NOT_YET
        left = int((100 - pct) / slope + 0.5)
        left = min(left, BURN_MAX_LEFT_MIN)
        return BURN_EMPTY_NOW if left < 1 else left
    else:
        elapsed = window_min - reset_min
        if elapsed < MIN_ELAP:
            return BURN_NOT_YET
        left = int((100 - pct) * elapsed / pct + 0.5)
        left = min(left, BURN_MAX_LEFT_MIN)
        return BURN_EMPTY_NOW if left < 1 else left

# ---- item 1: least squares over an exact linear series gives the exact slope
r1 = Ring()
for i in range(SLOTS):
    r1.sample(0, 10 + i, i * STEP_MS)
s1 = r1.slope()
chk(s1 is not None and abs(s1[0] - 0.2) < 1e-9,
    f"mirror 1: least squares over an exact linear series gives the exact slope (got {s1})")

# ---- item 2: one outlier - LS stays closer to the trend than endpoint-to-endpoint
r2 = Ring()
for i in range(SLOTS):
    r2.sample(0, 10 + i if i < SLOTS - 1 else 90, i * STEP_MS)
ls_slope, rise2, span2 = r2.slope()
endpoint_slope = rise2 / span2
true_slope = 0.2
chk(abs(ls_slope - true_slope) < abs(endpoint_slope - true_slope),
    f"mirror 2: one endpoint outlier - least squares (err {abs(ls_slope - true_slope):.3f}) "
    f"stays closer to the trend than endpoint-to-endpoint (err {abs(endpoint_slope - true_slope):.3f}) - "
    f"that is WHY least squares was chosen")

# ---- item 3: reset on drop, both directions
r3 = Ring()
for i in range(5):
    r3.sample(0, 50, i * STEP_MS)
r3.sample(0, 50 - DROP, 5 * STEP_MS)
chk(r3.count == 1,
    f"mirror 3a: a fall of USAGE_RING_DROP_PCT ({DROP}) clears the ring (count={r3.count}, want 1)")

r4 = Ring()
for i in range(5):
    r4.sample(0, 50, i * STEP_MS)
r4.sample(0, 50 - (DROP - 1), 5 * STEP_MS)
chk(r4.count == 6,
    f"mirror 3b: a fall of one less ({DROP - 1}) does NOT clear the ring (count={r4.count}, want 6)")

# ---- item 4: the staleness reset is an EDGE, not a LEVEL
r5 = Ring()
for i in range(3):
    r5.sample(0, 50, i * STEP_MS)
for i in range(5):
    r5.sample(1000, 50, (3 + i) * STEP_MS)   # 5 consecutive stale ticks
chk(r5.reset_calls == 1,
    f"mirror 4: staying stale for 5 consecutive ticks clears the ring ONCE, not 5 "
    f"(reset_calls={r5.reset_calls})")
# TEETH, proven inside the mirror itself (no file needed - this class is pure
# Python): the same 5 stale ticks against a LEVEL variant reset 5 times, not
# once, proving the ==1 assertion above is not vacuous. The REAL source's teeth
# are proven separately by injecting into usage.ino - see the report.
r5b = Ring()
for i in range(3):
    r5b.sample(0, 50, i * STEP_MS)
for i in range(5):
    r5b.sample(1000, 50, (3 + i) * STEP_MS, level_bug=True)
chk(r5b.reset_calls == 5,
    f"mirror 4 teeth: a LEVEL implementation resets on every stale tick "
    f"(reset_calls={r5b.reset_calls}, want 5) - proving the ==1 assertion above can fail")

# ---- item 5: ring wrap - more than SLOTS samples keeps only the newest N
r6 = Ring()
for i in range(SLOTS + 5):
    r6.sample(0, i % 100, i * STEP_MS)
oldest6 = (r6.head + SLOTS - r6.count) % SLOTS
chk(r6.count == SLOTS and r6.pct[oldest6] == 5,
    f"mirror 5: {SLOTS + 5} samples into a {SLOTS}-slot ring keeps only the newest {SLOTS} "
    f"(count={r6.count}, oldest pct={r6.pct[oldest6]}, want 5)")

# ---- item 6: millis() wrap - now - last is unsigned, a sample straddling the
# 32-bit boundary must still fire. Unreachable on hardware without 49.7 days.
r7 = Ring()
r7.last = uwrap(U32 - 100000)
r7.at[0] = r7.last
r7.pct[0] = 50
r7.head = 1
r7.count = 1
now7 = 250000 - 1   # a small value AFTER the 32-bit wrap
r7.sample(0, 55, now7)
chk(r7.count == 2,
    f"mirror 6: a sample straddling the millis() 32-bit wrap still fires (count={r7.count}, want 2)")

# ---- item 7: cadence gate - samples closer than USAGE_RING_STEP_MS are refused.
# Base timestamp is deliberately NOT 0: usageRingLast == 0 is the sentinel for
# "no sample yet" in both the real code and this mirror, so a first sample AT
# millis()==0 would bypass the gate on the very next call - a real property of
# the sentinel, not a mirror bug, and not what this test is about.
r8 = Ring()
r8.sample(0, 50, 1000)
r8.sample(0, 51, 1000 + STEP_MS - 1)
chk(r8.count == 1,
    f"mirror 7a: a sample closer than USAGE_RING_STEP_MS is refused (count={r8.count}, want 1)")
r8.sample(0, 51, 1000 + STEP_MS)
chk(r8.count == 2,
    f"mirror 7b: a sample exactly USAGE_RING_STEP_MS later is admitted (count={r8.count}, want 2)")

# ---- item 8: estimator selection - ring at/below BURN_RING_MAX_WIN, average above
r9 = Ring()
for i in range(SLOTS):
    r9.sample(0, 10 + i, i * STEP_MS)     # slope 0.2, newest pct 40
ring_left = burn_minutes(40, 0, RING_MAX, False, r9)
avg_left  = burn_minutes(40, 0, RING_MAX + 1, False, r9)
chk(ring_left > 0 and avg_left > 0 and ring_left != avg_left,
    f"mirror 8: at the boundary the ring path ({ring_left}m) and the average path just above it "
    f"({avg_left}m) disagree, proving the selection actually switches")

# ---- item 9: every gate refusal, one assertion each
r10 = Ring()
for i in range(SLOTS):
    r10.sample(0, 10 + i, i * STEP_MS)   # a valid, healthy ring
chk(burn_minutes(MIN_PCT - 1, 0, 300, False, r10) == BURN_NOT_YET,
    f"mirror 9a: pct < BURN_MIN_PCT ({MIN_PCT}) refuses")
chk(burn_minutes(MAX_PCT + 1, 0, 300, False, r10) == BURN_EMPTY_NOW,
    f"mirror 9b: pct > BURN_MAX_PCT ({MAX_PCT}) reports empty now")
chk(burn_minutes(50, 10080 - (MIN_ELAP - 1), 10080, False, None) == BURN_NOT_YET,
    f"mirror 9c: elapsed < BURN_MIN_ELAPSED ({MIN_ELAP}) refuses on the long window")

# mirror 9d used to expect BURN_NOT_YET here - this scenario (a real ring that
# simply hasn't spanned enough time yet) is exactly the "WILL speak later"
# case BURN_WARMING exists to name separately from "may never resolve".
r11 = Ring()
r11.sample(0, 40, 0)
r11.sample(0, 43, STEP_MS)               # span = 5 min < BURN_RING_MIN_SPAN (30)
chk(burn_minutes(43, 0, 300, False, r11) == BURN_WARMING,
    f"mirror 9d: span < BURN_RING_MIN_SPAN ({RING_MIN_SPAN}) is STILL FILLING "
    f"- BURN_WARMING, not BURN_NOT_YET, because it will resolve once the ring "
    f"spans enough time")

# A ring with fewer than two samples at all - the most common real case, hit
# on every 5-hour window reset - is the other WARMING path.
r11b = Ring()
chk(burn_minutes(50, 0, 300, False, r11b) == BURN_WARMING,
    "mirror 9d2: a ring with zero samples (count < 2, usageRingSlope() itself "
    "returns false) is BURN_WARMING, not BURN_NOT_YET")
chk(burn_minutes(50, 0, 300, False, None) == BURN_WARMING,
    "mirror 9d3: no ring at all behaves the same as an empty one - BURN_WARMING")

# mirror 9e is the PAIRED case that proves the distinction is real, not just a
# renamed constant: a ring that HAS filled (span clears BURN_RING_MIN_SPAN)
# but shows no real movement MAY NEVER resolve, and stays BURN_NOT_YET.
r12 = Ring()
for i in range(10):
    r12.sample(0, 40, i * STEP_MS)       # flat: rise = 0 < BURN_RING_MIN_RISE
chk(r12.slope()[2] >= RING_MIN_SPAN,
    f"mirror 9e precondition: r12's span ({r12.slope()[2]} min) clears "
    f"BURN_RING_MIN_SPAN ({RING_MIN_SPAN}) - this case must be a FLAT ring, "
    f"not a still-filling one, or it would not be distinguishing anything")
chk(burn_minutes(40, 0, 300, False, r12) == BURN_NOT_YET,
    f"mirror 9e: a FULLY-SPANNED but flat ring (rise < BURN_RING_MIN_RISE "
    f"{RING_RISE}) is BURN_NOT_YET - it may never resolve, unlike r11/r11b's "
    f"still-filling BURN_WARMING above")

r13 = Ring()
for i in range(SLOTS):
    r13.sample(0, 60 - i, i * STEP_MS)   # falling percentage -> slope <= 0
chk(burn_minutes(30, 0, 300, False, r13) == BURN_NOT_YET,
    "mirror 9f: slope <= 0 refuses (a falling percentage must never report a negative burn)")

chk(burn_minutes(50, 0, 300, True, r10) == BURN_NOT_YET,
    "mirror 9g: a stale reading refuses regardless of everything else")

# ---- item 10: all THREE refusal codes are pairwise distinguishable ---------
# Was "BURN_EMPTY_NOW vs BURN_NOT_YET" only, from before BURN_WARMING existed.
chk(burn_minutes(MAX_PCT + 1, 0, 300, False, None) == BURN_EMPTY_NOW and
    burn_minutes(MIN_PCT - 1, 0, 300, False, None) == BURN_NOT_YET and
    burn_minutes(50, 0, 300, False, None) == BURN_WARMING and
    len({BURN_EMPTY_NOW, BURN_NOT_YET, BURN_WARMING}) == 3,
    "mirror 10: BURN_EMPTY_NOW, BURN_NOT_YET and BURN_WARMING are pairwise "
    "distinguishable - a caller checking `< 0` alone cannot tell 'the cap is "
    "reached', 'this trend may never resolve' and 'ask again shortly' apart, "
    "which is what put 'burn --' on the glass for all three")

# ---- item 11: the long-window estimate is CLAMPED, not left to grow into a
# day count the side lane cannot hold. At BURN_MIN_PCT over the full 7-day
# window the unclamped average is ~226 days.
uncrampled = (100 - MIN_PCT) * 10080 / MIN_PCT / 1440
avg_clamped = burn_minutes(MIN_PCT, 0, 10080, False, None)
chk(avg_clamped == BURN_MAX_LEFT_MIN,
    f"mirror 11a: an average-branch estimate that would reach ~{uncrampled:.0f}d "
    f"clamps to BURN_MAX_LEFT_MIN ({BURN_MAX_LEFT_MIN}m = 99d 23h), got {avg_clamped}")
# The ring-slope branch can reach arbitrarily large numbers too, as slope
# approaches (but does not reach) zero - a valid, positive, tiny slope, built
# from a real integer-percentage staircase (rise EXACTLY BURN_RING_MIN_RISE,
# so the "rise < RING_RISE" gate is cleared and not tripped) spread over a
# synthetic ~13.9-day span (not a realistic OAuth-poll cadence, just large
# enough that (100-pct)/slope clears BURN_MAX_LEFT_MIN before the clamp, and
# still safely inside the ~49.7-day millis() wrap this repo documents).
r14 = Ring()
STEP_LARGE_MS = 40_000_000
for i in range(SLOTS):
    pct = 40 + (i * RING_RISE) // (SLOTS - 1)
    r14.sample(0, pct, i * STEP_LARGE_MS)
ring_clamped = burn_minutes(41, 0, RING_MAX, False, r14)
chk(ring_clamped == BURN_MAX_LEFT_MIN,
    f"mirror 11b: a ring-slope estimate from a near-zero positive slope also "
    f"clamps to BURN_MAX_LEFT_MIN, got {ring_clamped}")

# ---- the precision fix: a series whose sample times are NOT whole-minute
# multiples. usage.ino:389 used to divide in the unsigned-long domain BEFORE
# casting to double, truncating every x to a whole minute before the regression
# saw it. This mirror casts THEN divides (matching the fix and
# battPctPerHourX10's own pattern), so a non-whole-minute series is exactly the
# case that distinguishes them - they agree on any whole-minute series.
r_prec = Ring()
r_prec.sample(0, 10, 0)
r_prec.sample(0, 13, 90000)   # 1.5 minutes later - NOT a whole-minute multiple
precise_slope = r_prec.slope()[0]
truncated_slope = 3.0 / float(90000 // 60000)   # what the pre-fix line 389 gave: floor(1.5) = 1
chk(abs(precise_slope - 2.0) < 1e-9,
    f"mirror precision: a 90s-spaced 2-point series gives the exact slope 2.0 pct/min (got {precise_slope})")
chk(abs(truncated_slope - 3.0) < 1e-9 and abs(precise_slope - truncated_slope) > 0.9,
    f"mirror precision: the OLD truncating arithmetic would have given {truncated_slope} pct/min instead "
    f"of {precise_slope} - the case usage.ino:389's fix exists for, and the case a mirror written "
    f"against the truncating version would have enshrined")

MIRROR_COUNT = n

# =============================================================================
# HALF 2 - STRUCTURAL assertions on the real source, comments stripped.
#
# "A mirror alone is not enough and the repo says so": sessions-rank-check.mjs
# records that its own mirror "would keep passing even if the real comparator
# were deleted, since nothing in it executes the sketch." These read usage.ino's
# actual text instead, so an edit to the real function - not merely to this
# checker's model of it - is what these can catch.
# =============================================================================
def strip_comments(s):
    return re.sub(r"//[^\n]*", "", s)

def func_body(name_with_open_paren, src):
    """Brace-balanced extraction of a function body, starting from its own
    definition text (not a forward declaration or a call site)."""
    start = src.index(name_with_open_paren)
    brace = src.index("{", start)
    depth = 0
    i = brace
    while True:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[brace:i + 1]
        i += 1

# 1. usageRingSample tests the staleness flag for INEQUALITY, not merely truth -
# the edge-vs-level distinction from mirror item 4, bound to the actual code.
body1 = strip_comments(func_body("void usageRingSample()", INO))
chk(re.search(r"if\s*\(\s*stale\s*!=\s*usageRingWasStale\s*\)", body1) is not None,
    "structural 1: usageRingSample() tests `stale != usageRingWasStale` (an EDGE), "
    "not `if (stale)` (a LEVEL)")

# 2. usageRingSlope takes x from the stored TIMESTAMPS, not the slot index - a
# missed poll leaves a real gap, and indexing would silently mis-fit it.
body2 = strip_comments(func_body("bool usageRingSlope(", INO))
chk(re.search(r"double\s+x\s*=.*usageRingAt\[idx\]\s*-\s*usageRingAt\[oldest\]", body2) is not None,
    "structural 2: usageRingSlope() derives x from usageRingAt[idx] (the stored "
    "timestamp), not from the loop index")
chk(re.search(r"double\s+x\s*=\s*\(double\)\s*i\s*;", body2) is None,
    "structural 2b: x is not merely the slot index i")

# 3. usageBurnMinutes selects its estimator on windowMin against BURN_RING_MAX_WIN.
body3 = strip_comments(func_body("long usageBurnMinutes(", INO))
chk(re.search(r"if\s*\(\s*windowMin\s*<=\s*BURN_RING_MAX_WIN\s*\)", body3) is not None,
    "structural 3: usageBurnMinutes() selects its estimator on "
    "`windowMin <= BURN_RING_MAX_WIN`, not on resetMin or anything else")

# 4. usageBurnLabel writes ~ and NEVER >= - the two notations make different
# promises and >= is reserved for the charge estimator's floor. This is a claim
# about the label TEXT, so only the string literals are scanned - the function's
# own `if (mins >= 1440)` comparisons are C, not notation, and a raw-body scan
# would reject them for a reason that has nothing to do with what a person reads.
body4 = strip_comments(func_body("void usageBurnLabel(", INO))
lits4 = re.findall(r'"((?:[^"\\]|\\.)*)"', body4)
chk(any("~" in s for s in lits4), "structural 4a: usageBurnLabel() writes ~ for an estimate")
bad4 = [s for s in lits4 if ">=" in s]
chk(not bad4,
    f"structural 4b: usageBurnLabel() never writes >= in a label string, reserved "
    f"for the charge floor (found {bad4})")
chk("measuring" in lits4,
    "structural 4c: usageBurnLabel() renders BURN_WARMING as \"measuring\", "
    "distinct from BURN_NOT_YET's \"burn --\"")
# 4d. ORDER matters: BURN_WARMING must be tested BEFORE the generic `mins < 0`
# catch-all that produces "burn --", or the specific check is dead code and
# every negative value - WARMING included - reads as the ambiguous fallback
# this whole fix exists to remove.
warm_check = re.search(r"mins\s*==\s*BURN_WARMING", body4)
generic_check = re.search(r"mins\s*<\s*0", body4)
chk(warm_check is not None and generic_check is not None
    and warm_check.start() < generic_check.start(),
    "structural 4d: usageBurnLabel() checks `mins == BURN_WARMING` BEFORE the "
    "generic `mins < 0` catch-all - reversed, BURN_WARMING would always print "
    "\"burn --\" instead of \"measuring\"")

# 5. usageRingReset() is reached from BOTH reset paths inside usageRingSample -
# the drop and the staleness edge - counted rather than eyeballed.
reset_calls_in_sample = len(re.findall(r"\busageRingReset\s*\(\s*\)", body1))
chk(reset_calls_in_sample == 2,
    f"structural 5: usageRingReset() is called from both reset paths inside "
    f"usageRingSample() (found {reset_calls_in_sample} call sites, want 2: the "
    f"staleness edge and the drop)")

# 6. usageBurnMinutes() CLAMPS its estimate in BOTH branches against
# BURN_MAX_LEFT_MIN - not merely in the mirror above, which would keep passing
# even if the real clamp were deleted. Counted by the GUARD (`if (left >
# BURN_MAX_LEFT_MIN)`), one per branch, NOT by raw token mentions: a single
# `if (left > BURN_MAX_LEFT_MIN) left = BURN_MAX_LEFT_MIN;` statement names
# the constant TWICE on its own, which is exactly what let a first version of
# this assertion pass with only ONE branch actually clamped - caught by
# running the intended fault (deleting the ring-slope branch's clamp) and
# finding it did not fail.
clamp_sites = len(re.findall(r"if\s*\(\s*left\s*>\s*BURN_MAX_LEFT_MIN\s*\)", body3))
chk(clamp_sites == 2,
    f"structural 6: usageBurnMinutes() clamps against BURN_MAX_LEFT_MIN in "
    f"both the ring-slope and the average branch (found {clamp_sites} `if "
    f"(left > BURN_MAX_LEFT_MIN)` guard(s), want exactly 2)")

# 7. usageBurnMinutes() distinguishes "still filling" (BURN_WARMING) from "may
# never resolve" (BURN_NOT_YET) in the ring branch - the fix this task exists
# for. Counted by the GUARD, not by raw token mentions, for the same reason
# structural 6 counts `if (left > ...)` rather than occurrences of the name:
# a single return statement can name a constant once while a sloppier one
# could name it twice, so counting sites (not mentions) is what actually
# proves there are two distinct refusal POINTS.
warming_sites = len(re.findall(r"return\s+BURN_WARMING\s*;", body3))
chk(warming_sites == 2,
    f"structural 7a: usageBurnMinutes() returns BURN_WARMING from exactly two "
    f"sites in the ring branch - `!usageRingSlope(...)` (count < 2) and "
    f"`span < BURN_RING_MIN_SPAN` (still filling) (found {warming_sites}, want 2)")
chk(re.search(
        r"rise\s*<\s*BURN_RING_MIN_RISE\s*\|\|\s*slope\s*<=\s*0\.0f\s*\)\s*return\s+BURN_NOT_YET\s*;",
        body3) is not None,
    "structural 7b: usageBurnMinutes() still returns BURN_NOT_YET for a flat "
    "or falling ring (rise < BURN_RING_MIN_RISE or slope <= 0) - the "
    "may-never-resolve case, kept distinct from BURN_WARMING's still-filling one")
# The two WARMING returns must come BEFORE the NOT_YET one in source order, or
# a still-filling ring would never reach the code that is supposed to name it.
warming_positions = [m.start() for m in re.finditer(r"return\s+BURN_WARMING\s*;", body3)]
not_yet_in_ring_branch = re.search(
    r"rise\s*<\s*BURN_RING_MIN_RISE\s*\|\|\s*slope\s*<=\s*0\.0f\s*\)\s*return\s+BURN_NOT_YET\s*;",
    body3)
chk(len(warming_positions) == 2 and not_yet_in_ring_branch is not None
    and all(p < not_yet_in_ring_branch.start() for p in warming_positions),
    "structural 7c: both BURN_WARMING returns precede the ring branch's "
    "BURN_NOT_YET return in source order")

# 8. The sparkline's caption is COMPUTED from the ring's own span, not a
# literal - the exact thing this task fixes. Bound to renderNowCard()'s real
# source rather than only to the mirror above, which would keep passing even
# if renderNowCard() still wrote a bare "LAST 2.5H" (or "no history") itself.
body_now = strip_comments(func_body("void renderNowCard()", INO))
chk("usageSpanCaption(" in body_now and "usageRingSpanMin()" in body_now,
    "structural 8a: renderNowCard() computes its caption via "
    "usageSpanCaption(buf, sizeof(buf), usageRingSpanMin())")
chk('"LAST 2.5H"' not in body_now,
    "structural 8b: renderNowCard() no longer writes a bare \"LAST 2.5H\" "
    "literal - the caption is computed, so the string cannot appear as a "
    "literal in the render function's own code")
# usageRingSpanMin() itself must return 0 for a not-yet-fillable ring - the
# same shape battTrendSpanMin() (power.ino) uses, so a caption built on it can
# never claim history that was never sampled.
body_span = strip_comments(func_body("int usageRingSpanMin()", INO))
chk(re.search(r"usageRingCount\s*<\s*2", body_span) is not None
    and re.search(r"return\s+0\s*;", body_span) is not None,
    "structural 8c: usageRingSpanMin() returns 0 when usageRingCount < 2, "
    "mirroring battTrendSpanMin()'s own guard")

STRUCTURAL_COUNT = n - MIRROR_COUNT

if fails:
    print(f"\n{fails} of {n} assertions FAILED ({MIRROR_COUNT} mirror + {STRUCTURAL_COUNT} structural)")
    sys.exit(1)
print(f"{n} assertions pass ({MIRROR_COUNT} mirror + {STRUCTURAL_COUNT} structural)")
sys.exit(0)
