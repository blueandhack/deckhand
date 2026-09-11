#!/usr/bin/env python3
"""Exercise the battery time-remaining estimator's arithmetic and its guards.

    python3 batt-trend-check.py

THIS IS A MIRROR OF power.ino's battPctPerHourX10()/battMinutesLeft(), and a
mirror that drifts from its original is worse than no mirror at all - it passes
while the firmware is broken. So the thresholds are not copied here: they are
PARSED OUT OF power.ino at run time and compared against the values this file
assumes, and a mismatch fails loudly. Change power.ino and this either still
agrees or tells you it does not.

It exists because the real thing cannot be observed quickly: the estimator
deliberately reports nothing until it has watched a cell for 20 minutes, and
plugging the device in to flash it resets the window. The cases below cover the
three refusals that matter - too short, too flat, and the voltage REBOUND that
happens when the backlight blanks and the load drops.
"""
import re, pathlib, sys

# --- drift guard: the thresholds must match the firmware's ---
POWER = pathlib.Path(__file__).with_name("power.ino").read_text()
def firmware_const(name):
    m = re.search(rf"{name}\s*=\s*(\d+)", POWER)
    if not m:
        sys.exit(f"FAIL: {name} not found in power.ino - was it renamed?")
    return int(m.group(1))

# THE BOARD HEADERS, because BATT_FULL_MV now lives in them - one threshold for
# two different analogue front ends was wrong, and this checker has to follow the
# constant to where it went rather than keep a literal of its own.
B1H = pathlib.Path(__file__).with_name("board_e32r28t.h").read_text()
B2H = pathlib.Path(__file__).with_name("board_es3c35p.h").read_text()


def board_const(src, name, where):
    m = re.search(rf"#define\s+{name}\s+(\d+)", src)
    if not m:
        sys.exit(f"FAIL: {name} not found in {where} - was it renamed, or un-split?")
    return int(m.group(1))


MIN_SPAN_MS = firmware_const("BATT_TREND_MIN_SPAN_MS")
MIN_DROP_MV = firmware_const("BATT_TREND_MIN_DROP_MV")
MIN_RATE = firmware_const("BATT_TREND_MIN_PCT_PER_H_X10")
SLOTS = firmware_const("BATT_TREND_SLOTS")
print(f"  thresholds read from power.ino: span={MIN_SPAN_MS // 60000}min "
      f"drop={MIN_DROP_MV}mV rate>={MIN_RATE / 10}%/h slots={SLOTS}")

mvT = [3300,3500,3600,3700,3800,3900,4000,4100,4200]
pcT = [0,8,15,28,45,62,78,90,100]
def pctFromMv(mv):
    if mv <= mvT[0]: return 0
    if mv >= mvT[-1]: return 100
    for i in range(1,9):
        if mv < mvT[i]:
            return pcT[i-1] + (pcT[i]-pcT[i-1])*(mv-mvT[i-1])//(mvT[i]-mvT[i-1])
    return 100
def rateX10(samples):                      # [(ms, mv)] oldest first
    if len(samples) < 3: return -1
    if samples[-1][0]-samples[0][0] < MIN_SPAN_MS: return -1
    if samples[0][1]-samples[-1][1] < MIN_DROP_MV: return -1
    n=sx=sy=sxy=sxx=0.0
    for ms,mv in samples:
        x=(ms-samples[0][0])/3600000.0; y=float(pctFromMv(mv))
        n+=1; sx+=x; sy+=y; sxy+=x*y; sxx+=x*x
    den=n*sxx-sx*sx
    if den<=0: return -1
    slope=(n*sxy-sx*sy)/den
    r=int(-slope*10+0.5)
    return -1 if r < MIN_RATE else r
def minsLeft(samples, mvNow):
    r=rateX10(samples)
    if r<0: return -1
    p=pctFromMv(mvNow)
    if p<=0: return 0
    return min(int(p*600/r), 99*60)

def ramp(mins, dropMv, start=3900, jitter=None):
    out=[]
    for i in range(mins+1):
        mv=start-dropMv*i//mins
        if jitter: mv += jitter[i%len(jitter)]
        out.append((i*60000, mv))
    return out

def hm(m): return "not measurable" if m<0 else f"{m//60}h{m%60:02d}m"


# The refusals are the point, so they are ASSERTED rather than eyeballed.
fails = 0
for name, ss, now, want in [
    ("normal drain reports a rate", ramp(30, 60), 3840, True),
    ("one minute short of the span", ramp(19, 60), 3840, False),
    ("fall inside the ADC's noise", ramp(30, 12), 3888, False),
    ("rebound when the backlight blanks",
     [(i * 60000, 3880 + 40 * i // 30) for i in range(31)], 3920, False),
    ("sag jitter must not change the answer", ramp(30, 60, jitter=[0, -6, 0, 6, -6, 6]), 3840, True),
]:
    got = rateX10(ss) > 0
    ok = got == want
    fails += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
# Least squares must absorb the sag rather than merely survive it.
clean, sagged = rateX10(ramp(30, 60)), rateX10(ramp(30, 60, jitter=[0, -6, 0, 6, -6, 6]))
ok = clean == sagged
fails += 0 if ok else 1
print(f"  {'PASS' if ok else 'FAIL'}  sagged window gives the same rate as a clean one "
      f"({clean / 10}%/h vs {sagged / 10}%/h)")


# --------------------------------------------------------------------------
# TIME TO FULL WHILE CHARGING, and the CV knee is the whole design problem.
#
# Same mirror discipline as the discharge estimator above: every threshold is
# PARSED out of power.ino, so a mirror that drifts fails loudly instead of
# passing while the firmware is wrong.
#
# WHY THIS CANNOT SIMPLY EXTRAPOLATE. A Li-ion cell charges CC then CV: below the
# knee the voltage climbs steadily, and above it the charger HOLDS the voltage and
# tapers the current instead. This board has no current sense, so in the CV phase
# there is no observable that predicts completion at all - the one quantity that is
# still moving is the one thing we cannot measure. Measured on real hardware for
# reference: 76 minutes of a genuine charge ran 3893 -> 4018 mV at +90 mV/h on a
# dead-straight line (RMS residual 3.5 mV, max 8.5), i.e. the CC phase really is
# linear and the fit is sound THERE.
#
# Two consequences, both asserted below:
#   - above BATT_CHG_KNEE_MV the estimator refuses with a distinct code (-2,
#     "topping up") rather than a number, and the knee outranks the span/rise gate
#     because being above it is a structural refusal, not a not-yet-enough-data one
#   - below the knee the extrapolation still CROSSES the knee, so the answer is a
#     FLOOR and is rendered ">=", never "~". The discharge row's "~" means "about";
#     these are different claims and must not share a glyph.
CHG_MIN_SPAN_MS = firmware_const("BATT_CHG_MIN_SPAN_MS")
CHG_MIN_RISE_MV = firmware_const("BATT_CHG_MIN_RISE_MV")
CHG_KNEE_MV     = firmware_const("BATT_CHG_KNEE_MV")
CHG_TARGET_MV   = firmware_const("BATT_CHG_TARGET_MV")
# BOARD 2's, because every charge-estimator invariant below is board 2's: the
# whole estimator is behind !BOARD_USES_TFT_ESPI.
CHG_FULL_MV     = board_const(B2H, "BOARD_BATT_FULL_MV", "board_es3c35p.h")
FULL_MV_B1      = board_const(B1H, "BOARD_BATT_FULL_MV", "board_e32r28t.h")
print(f"  charge thresholds read from power.ino: span={CHG_MIN_SPAN_MS // 60000}min "
      f"rise={CHG_MIN_RISE_MV}mV knee={CHG_KNEE_MV}mV target={CHG_TARGET_MV}mV")
print(f"  BATT_FULL_MV is PER-BOARD: board 1 {FULL_MV_B1}mV, board 2 {CHG_FULL_MV}mV")

CHG_SETTLE_MS = firmware_const("BATT_CHG_SETTLE_MS")
CHG_NOT_YET, CHG_TOPPING = -1, -2

# THE SETTLE GUARD, and it exists because the FIRST FIT LIES - measured on hardware,
# not anticipated. Plugging in makes the cell voltage snap up +64 mV in SECONDS
# (3925 -> 3989 observed): that is the charger's terminal voltage appearing across
# the divider, not charge going in. One such sample in the ring inflated the slope
# 143 -> 183 mV/h and turned a true ~65 min into a reported 54.
#
# THAT IS A VIOLATED CONTRACT, NOT A ROUNDING ERROR. The label is rendered ">=",
# which promises AT LEAST that long, so an optimistic estimate breaks the one
# guarantee the notation exists to make - and it breaks it in the direction a reader
# cannot detect. The discharge side documents the same trap in reverse (-21 mV of
# relaxation after unplugging); this transient is three times larger.
#
# A rate gate cannot catch it: the rebound is smooth and fits a line perfectly well.
# Only TIME can, so samples inside BATT_CHG_SETTLE_MS of entering CHARGING are not
# admitted to the ring at all.
def chgRing(series, start_ms=0):
    """Mirror of battChargeSample()'s admission rule: [(ms, mv)] -> the ring."""
    return [(ms, mv) for ms, mv in series if ms - start_ms >= CHG_SETTLE_MS]

def chgMinsToFull(samples, mvNow):        # [(ms, mv)] oldest first
    # The knee is checked FIRST: above it the refusal is structural, so more data
    # cannot change the answer and reporting "not yet" would invite waiting for it.
    if mvNow >= CHG_KNEE_MV: return CHG_TOPPING
    if len(samples) < 3: return CHG_NOT_YET
    if samples[-1][0] - samples[0][0] < CHG_MIN_SPAN_MS: return CHG_NOT_YET
    if samples[-1][1] - samples[0][1] < CHG_MIN_RISE_MV: return CHG_NOT_YET
    n = sx = sy = sxy = sxx = 0.0
    for ms, mv in samples:
        x = (ms - samples[0][0]) / 3600000.0; y = float(mv)
        n += 1; sx += x; sy += y; sxy += x * y; sxx += x * x
    den = n * sxx - sx * sx
    if den <= 0: return CHG_NOT_YET
    slope = (n * sxy - sx * sy) / den          # mV/h, positive while filling
    if slope <= 0: return CHG_NOT_YET
    if mvNow >= CHG_TARGET_MV: return 0
    mins = int((CHG_TARGET_MV - mvNow) * 60.0 / slope + 0.5)
    return min(mins, 99 * 60)

def chgRamp(mins, riseMv, start=3900):
    return [(i * 60000, start + riseMv * i // mins) for i in range(mins + 1)]

# --- the target and the knee must sit where the rest of the firmware puts them ---
for name, cond in [
    # THE FULL THRESHOLD IS PER-BOARD NOW. The two boards read ~60mV apart at the
    # top of a charge through nominally identical x2 dividers - board 1 settles at
    # 4221..4226 and reports FULL routinely, board 2 tops out at 4162..4170 and has
    # reported it ZERO times - so one shared literal cannot be right for both. A
    # literal creeping back into power.ino would silently re-merge them, and
    # nothing else in this file would notice.
    ("power.ino DERIVES BATT_FULL_MV from the board macro rather than a literal",
     re.search(r"BATT_FULL_MV\s*=\s*BOARD_BATT_FULL_MV", POWER) is not None
     and re.search(r"BATT_FULL_MV\s*=\s*\d", POWER) is None),
    ("board 1's FULL threshold sits above the charge knee", FULL_MV_B1 > CHG_KNEE_MV),
    ("board 1's FULL threshold is at or below the 100% point",
     FULL_MV_B1 <= CHG_TARGET_MV),
    ("board 2's FULL threshold sits above the charge knee", CHG_FULL_MV > CHG_KNEE_MV),
    ("board 2's FULL threshold is at or below the 100% point",
     CHG_FULL_MV <= CHG_TARGET_MV),
    ("BATT_CHG_TARGET_MV is the mv at which pctFromMv() actually reads 100%",
     pctFromMv(CHG_TARGET_MV) == 100 and pctFromMv(CHG_TARGET_MV - 1) < 100),
    ("the knee sits below the target, so the refusal band is non-empty",
     CHG_KNEE_MV < CHG_TARGET_MV),
    ("the target is at or above the FULL threshold, so the estimate cannot read 0 "
     "while the state is still CHARGING", CHG_TARGET_MV >= CHG_FULL_MV),
    ("the knee sits below the FULL threshold, so 'topping up' is reached before full",
     CHG_KNEE_MV < CHG_FULL_MV),
]:
    fails += 0 if cond else 1
    print(f"  {'PASS' if cond else 'FAIL'}  {name}")

# --- the refusals, which are the point ---
for name, ss, now, want in [
    ("a normal CC-phase charge reports a floor", chgRamp(30, 60), 3960, "num"),
    ("one minute short of the span is refused", chgRamp(19, 60), 3960, CHG_NOT_YET),
    ("a rise inside the ADC's noise is refused", chgRamp(30, 12), 3912, CHG_NOT_YET),
    ("above the CV knee it says topping up, not a number",
     chgRamp(30, 60, start=4070), CHG_KNEE_MV + 20, CHG_TOPPING),
    ("the knee outranks the gate: too little data ABOVE it still reads topping up",
     chgRamp(5, 5, start=4110), CHG_KNEE_MV + 20, CHG_TOPPING),
    ("a FALLING window while nominally charging is refused, never negative time",
     [(i * 60000, 3960 - 2 * i) for i in range(31)], 3900, CHG_NOT_YET),
]:
    got = chgMinsToFull(ss, now)
    ok = (got > 0) if want == "num" else (got == want)
    fails += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}"
          + ("" if ok else f"  (got {got})"))

# --- the real 76-minute hardware run, so this is not only synthetic ---
real = chgMinsToFull(chgRamp(76, 125, start=3893), 4018)
ok = real == CHG_TOPPING or real > 60
fails += 0 if ok else 1
print(f"  {'PASS' if ok else 'FAIL'}  the measured 3893->4018 mV run over 76 min "
      f"yields a floor of {real} min at +90 mV/h (linear, and therefore optimistic)")

# THE 99h CLAMP IS A BACKSTOP AND IS PROVABLY UNREACHABLE TODAY, which is worth
# asserting rather than assuming: the first version of this check tried to TRIGGER
# the clamp and failed, because the gate makes it impossible. The rise gate admits
# nothing slower than BATT_CHG_MIN_RISE_MV over the longest window the ring can
# hold (SLOTS-1 minutes), and the largest gap to the target is from a nearly-flat
# cell, so the worst estimate the arithmetic can ever return is ~17h against a 99h
# clamp. Asserted as a SWEEP over the admissible space rather than one case, so a
# future change to the ring size or either threshold that made the clamp live
# fails here instead of silently starting to truncate a real reading.
slowest = CHG_MIN_RISE_MV / ((SLOTS - 1) / 60.0)          # mV/h
worst = 0
for mvNow in range(3300, CHG_KNEE_MV):
    worst = max(worst, (CHG_TARGET_MV - mvNow) * 60.0 / slowest)
ok = worst < 99 * 60
fails += 0 if ok else 1
print(f"  {'PASS' if ok else 'FAIL'}  the 99h clamp is an unreachable backstop: the gate admits "
      f"no slope under {slowest:.1f} mV/h, so the worst estimate is {worst / 60:.1f}h "
      f"({99 * 60 / worst:.1f}x inside the clamp)")
# ...and the clamp is still PRESENT, since the sweep above only proves it is not
# currently load-bearing. A guard that has been deleted cannot catch the change
# that would make it necessary.
m_clamp = re.search(r"int battChargeMinutesToFull\(.*?\n\}", POWER, re.S)
ok = m_clamp is not None and "99L * 60L" in m_clamp.group(0)
fails += 0 if ok else 1
print(f"  {'PASS' if ok else 'FAIL'}  battChargeMinutesToFull() still carries the 99h clamp "
      f"as a backstop for a future change to the gate")

# --- the settle guard, including the REAL hardware case it was found by ---
for name, cond in [
    ("the settle window is long enough to clear a plug-in rebound (>=2 min)",
     CHG_SETTLE_MS >= 120000),
    ("the settle window is short enough not to dominate the span gate",
     CHG_SETTLE_MS < CHG_MIN_SPAN_MS),
]:
    fails += 0 if cond else 1
    print(f"  {'PASS' if cond else 'FAIL'}  {name}")

# Samples inside the settle window must not reach the ring at all.
raw = [(i * 60000, 3925 if i == 0 else 3989 + 2 * (i - 1)) for i in range(30)]
ring = chgRing(raw)
ok = all(mv != 3925 for _, mv in ring) and len(ring) < len(raw)
fails += 0 if ok else 1
print(f"  {'PASS' if ok else 'FAIL'}  the plug-in rebound sample is not admitted to the ring "
      f"({len(raw)} raw -> {len(ring)} admitted)")

# THE REGRESSION, from the real run: with the rebound the device said 54 min when the
# truth was ~65. Rebuilt here from the measured series, the settled ring must land
# near 65 and must NOT reproduce the optimistic 54.
real_mv = [3989, 3994, 3999, 4003, 4007, 4007, 4010, 4011, 4013, 4016, 4016, 4019, 4024,
           4026, 4028, 4031, 4034, 4035, 4039, 4041, 4039, 4042, 4044, 4046, 4047]
contaminated = [(0, 3925)] + [((i + 1) * 60000, mv) for i, mv in enumerate(real_mv)]
bad = chgMinsToFull(contaminated, 4047)                 # what shipped
good = chgMinsToFull(chgRing(contaminated), 4047)       # what the guard gives
# The truth, computed independently: a least-squares fit over the settled samples
# only. 65 min was the figure derived by hand from this same series during the
# investigation; the tolerance covers the few samples added since.
ok = good > bad and abs(good - 65) <= 15
fails += 0 if ok else 1
print(f"  {'PASS' if ok else 'FAIL'}  the measured rebound case: contaminated={bad} min "
      f"(optimistic, breaks the >= floor), settled={good} min (true ~65)")

# The direction is the whole point: the guard must never make the estimate SHORTER.
ok = good >= bad
fails += 0 if ok else 1
print(f"  {'PASS' if ok else 'FAIL'}  the settle guard moves the estimate in the SAFE direction "
      f"(longer, never shorter): {bad} -> {good}")

# --- the RENDERING claim: a floor must not borrow the discharge row's "~" ---
m = re.search(r"void battChargeLabel\(.*?\n\}", POWER, re.S)
if not m:
    fails += 1
    print("  FAIL  battChargeLabel() not found in power.ino")
else:
    body = m.group(0)
    for name, cond in [
        ('battChargeLabel() renders the floor with ">=", not the discharge row\'s "~"',
         ">=" in body and '"~' not in body),
        ('battChargeLabel() says "topping up" above the knee rather than a number',
         "topping" in body),
        ("battChargeLabel() renders a not-yet-measurable estimate as NOTHING, never 0m",
         re.search(r"out\[0\]\s*=\s*'\\0'", body) is not None),
    ]:
        fails += 0 if cond else 1
        print(f"  {'PASS' if cond else 'FAIL'}  {name}")
# --------------------------------------------------------------------------
# POWERPROBE: the passive mV/h instrument.
#
# Same mirror discipline as above - every threshold is PARSED out of power.ino,
# never transcribed - and for the same reason: this one exists to decide whether
# a proposed battery saving is real, so a mirror that silently disagreed with the
# firmware would rank optimisations by the wrong numbers.
#
# Two things make it a different measurement from the estimator above rather
# than the same one in new units:
#   - It reports mV/h. The estimator reports %/h, which routes through
#     pctFromMv's curve; that curve is a MODEL, and baking its error into a
#     hardware A/B would attribute the model's shape to the hardware.
#   - It states its own CONFIDENCE (the standard error of the slope) instead of
#     inheriting a fixed 20-minute / 25mV gate. That is what lets it answer in
#     ~7 minutes when the drain is large, which is exactly the case worth
#     measuring - and keeps it silent when the fall really is noise.
PROBE_BUCKET_MS = firmware_const("POWERPROBE_BUCKET_MS")
PROBE_MIN_BUCKETS = firmware_const("POWERPROBE_MIN_BUCKETS")
PROBE_MIN_SNR_X10 = firmware_const("POWERPROBE_MIN_SNR_X10")
PROBE_MAX_BUCKETS = firmware_const("POWERPROBE_MAX_BUCKETS")
print(f"  probe thresholds read from power.ino: bucket={PROBE_BUCKET_MS // 1000}s "
      f"min={PROBE_MIN_BUCKETS} buckets snr>={PROBE_MIN_SNR_X10 / 10} max={PROBE_MAX_BUCKETS}")


def probeFit(bk):
    """[(ms, mv)] oldest first -> (slope mV/h, standard error) or None."""
    n = len(bk)
    if n < PROBE_MIN_BUCKETS or n < 3:
        return None
    t0 = bk[0][0]
    xs = [(ms - t0) / 3600000.0 for ms, _ in bk]
    ys = [float(mv) for _, mv in bk]
    sx = sum(xs); sy = sum(ys)
    sxx = sum(x * x for x in xs); sxy = sum(x * y for x, y in zip(xs, ys))
    den = n * sxx - sx * sx
    if den <= 0:
        return None
    slope = (n * sxy - sx * sy) / den
    icept = (sy - slope * sx) / n
    sse = sum((y - (icept + slope * x)) ** 2 for x, y in zip(xs, ys))
    cxx = sxx - sx * sx / n            # centred Sxx
    if cxx <= 0:
        return None
    se = (sse / (n - 2) / cxx) ** 0.5
    return slope, se


def probeVerdict(bk):
    """The reported rate in mV/h, or None while it cannot be honestly stated."""
    f = probeFit(bk)
    if f is None:
        return None
    slope, se = f
    if slope >= 0:                     # rising or flat is not a drain
        return None
    if se <= 0:                        # a perfectly linear fall is maximally certain
        return slope
    return slope if (-slope / se) >= PROBE_MIN_SNR_X10 / 10.0 else None


def noise_seq(n, amp, seed=12345):
    """Deterministic pseudo-noise: a test that cannot be re-run is not a test."""
    out = []; s = seed
    for _ in range(n):
        s = (1103515245 * s + 12345) & 0x7FFFFFFF
        out.append(((s >> 16) % 2001 - 1000) / 1000.0 * amp)
    return out


def pbuckets(count, mv_per_h, start=3900.0, noise=0.0, seed=1):
    ns = noise_seq(count, noise, seed) if noise else [0.0] * count
    return [(i * PROBE_BUCKET_MS,
             start + mv_per_h * (i * PROBE_BUCKET_MS / 3600000.0) + ns[i])
            for i in range(count)]


def check(name, ok):
    global fails
    fails += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")


# --- it must recover the rate, in mV/h, from a clean fall ---
f = probeFit(pbuckets(20, -88.0))
check("clean fall recovers -88.0 mV/h",
      f is not None and abs(f[0] + 88.0) < 0.01)

# --- the three refusals ---
check("a flat window is refused however long", probeVerdict(pbuckets(20, 0.0, noise=2.0)) is None)
check("a RISING window is refused, not reported as a gain",
      probeVerdict(pbuckets(20, 50.0)) is None)
check(f"fewer than {PROBE_MIN_BUCKETS} buckets is refused",
      probeVerdict(pbuckets(PROBE_MIN_BUCKETS - 1, -88.0)) is None)
check("a real drain buried in noise is refused",
      probeVerdict(pbuckets(7, -88.0, noise=60.0)) is None)

# --- the standard error has to MEAN something, or the gate is decoration ---
lo = probeFit(pbuckets(20, -88.0, noise=1.0))
hi = probeFit(pbuckets(20, -88.0, noise=4.0))
check("noisier data reports a larger standard error",
      lo is not None and hi is not None and hi[1] > lo[1] * 2)

# --- THE POINT OF THE WHOLE INSTRUMENT: it answers sooner than the fixed rule.
# Same 7-minute window, realistic bucket noise. The estimator above cannot speak
# for 20 minutes by construction; this must, or there was no reason to build it.
short = pbuckets(7, -88.0, noise=0.5)
old_rule = rateX10([(ms, int(mv)) for ms, mv in short])
new_rule = probeVerdict(short)
check("a 7-minute window is significant where the fixed 20-minute rule refuses",
      new_rule is not None and old_rule < 0)
if new_rule is not None:
    print(f"        -> {new_rule:.1f} mV/h from 7 buckets "
          f"(SNR {-new_rule / probeFit(short)[1]:.0f})")

# --- RE-ISSUING THE SAME LABEL MUST NOT DESTROY THE WINDOW ---
# Found on hardware: the host sends a command to every connected transport, so
# one POWERPROBE arrived over USB and BLE and powerProbeStart() ran twice. That
# is harmless while it refuses, but the same shape bites for real when someone
# re-runs the command to see how a probe is doing - the obvious thing to do -
# and a naive restart silently throws away the minutes already collected and
# reports nothing about having done so.
def probeStartAction(active, cur_label, new_label):
    if not active:
        return "start"
    return "progress" if cur_label == new_label else "restart"


# The three cases below specify the intent, but a mirror cannot FAIL on firmware
# that never implemented it - so the firmware is read directly too. Structural
# rather than behavioural, and it earns its place by catching the one thing that
# actually happens: someone deleting the guard as redundant.
m = re.search(r"void powerProbeStart\(.*?\n\}", POWER, re.S)
if not m:
    sys.exit("FAIL: powerProbeStart not found in power.ino - was it renamed?")
check("powerProbeStart compares the incoming label against the running one",
      "strcmp(probeLabel" in m.group(0))

check("a first probe starts", probeStartAction(False, "", "bl90") == "start")
check("re-issuing the SAME label reports progress instead of resetting",
      probeStartAction(True, "bl90", "bl90") == "progress")
check("a different label supersedes the running probe",
      probeStartAction(True, "bl90", "bl-off") == "restart")

# --------------------------------------------------------------------------
# THE THREE BLANKED-STATE POWER SAVINGS (board 2), structurally.
#
# Every one of these fails SILENTLY if it is wrong, which is the only reason
# they are asserted from source rather than left to a reflash:
#   - forget the inversion re-apply after SLPOUT and every colour on the panel
#     comes back complemented. This repo already lost a whole port to that
#     exact ordering fact, so it is the first thing checked.
#   - get the enterSleep/wakeUp ORDER wrong and the failure is cosmetic but
#     permanent: a panel blanking while still lit, or a backlight coming up
#     over a panel that has not finished waking.
#   - ship a toggle defaulting ON and the "before" leg of every future A/B is
#     silently already optimised, which poisons the measurement rather than
#     breaking it.
SHIM = pathlib.Path(__file__).with_name("panel_shim.cpp").read_text()
# The toggles are DECLARED in the main sketch, not power.ino - the Arduino build
# concatenates that file first and its command dispatch needs them in scope, so
# this checker has to look where the build forces them to live.
MAIN = pathlib.Path(__file__).with_name("deckhand_display.ino").read_text()


def fnbody(src, sig):
    m = re.search(re.escape(sig) + r".*?\n\}", src, re.S)
    return m.group(0) if m else None


def before(body, first, second):
    """True iff both appear and `first` precedes `second`. Crash-safe on purpose:
    a missing symbol must read as FAIL, not as a traceback - a checker that dies
    tells you strictly less than one that reports."""
    if not body or first not in body or second not in body:
        return False
    return body.index(first) < body.index(second)


def strip_comments(src):
    """Code only. A prose mention is not a call, and conflating them cost a false
    FAIL here: enterDeepSleep()'s comment EXPLAINS why it does not call
    sleepPanel(), and a plain text search found that explanation."""
    if not src:
        return src
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return "\n".join(re.sub(r"//.*$", "", ln) for ln in src.splitlines())


def after_last(body, last, anchor):
    if not body or last not in body or anchor not in body:
        return False
    return body.rindex(last) > body.index(anchor)


for tog in ("savePanelSleep", "saveCpuSlow", "saveBleSlow"):
    check(f"{tog} defaults to OFF, so an A/B's baseline is unoptimised",
          re.search(rf"bool\s+{tog}\s*=\s*false", MAIN) is not None)

sp = fnbody(SHIM, "bool PanelShim::sleepPanel(")
check("the shim exposes sleepPanel()", sp is not None)
check("waking the panel RE-APPLIES inversion (SLPOUT clears it)",
      sp is not None and "invertColor" in sp)
# THE ASSERTION ABOVE IS NOT ENOUGH ON ITS OWN, MEASURED THE HARD WAY: it passed
# while the re-apply sat behind `#if BOARD_PANEL_INVERT`, a macro this file
# cannot see (panel_shim.cpp deliberately includes no board header - see its own
# file comment). `#if` on an undefined macro is silently zero, so the call was
# compiled out and every wake would have complemented the panel. A text search
# cannot watch the preprocessor delete the line it just found, so the constraint
# is asserted directly instead: this translation unit must not branch on a board
# macro at all.
board_ifs = [ln for ln in SHIM.splitlines()
             if ln.strip().startswith("#if") and "BOARD_" in ln]
check("panel_shim.cpp branches on NO board macro (it cannot see them)",
      not board_ifs)
check("the inversion restored on wake is the TRACKED state, not a constant",
      sp is not None and "invertColor(_inverted)" in sp)
check("sleepPanel sends SLPIN (0x10) and SLPOUT (0x11)",
      sp is not None and "0x10" in sp and "0x11" in sp)

# THE RESTORE MUST KEY OFF WHAT WAS APPLIED, NEVER OFF THE REQUEST FLAG.
# Found on hardware, the expensive way. wakeUp() was written as
#   if (savePanelSleep) { tft.sleepPanel(false); ... }
# so clearing a toggle WHILE THE DEVICE WAS STILL BLANKED stranded whatever that
# toggle had already applied: the next wake skipped the restore, leaving the
# panel in SLPIN behind a lit backlight and the CPU pinned at 80MHz with nothing
# that would ever put either back. A flag says what you WANT; it is not a record
# of what the device DID, and using one for both is what let a saving leak.
sy = fnbody(POWER, "void savingsSync()")
check("savingsSync() exists and owns apply/restore in one place", sy is not None)
for applied in ("panelSleptApplied", "cpuSlowApplied", "bleSlowApplied"):
    check(f"{applied} tracks what was actually applied",
          re.search(rf"bool\s+{applied}\s*=\s*false", MAIN) is not None)
check("the panel restore is gated on panelSleptApplied, not savePanelSleep",
      sy is not None and "panelSleptApplied && !wantPanel" in sy)
check("savingsSync restores the CPU before the panel, and applies in reverse",
      before(sy, "cpuSlowApplied && !wantCpu", "panelSleptApplied && !wantPanel")
      and before(sy, "wantPanel && !panelSleptApplied", "wantCpu && !cpuSlowApplied"))
# A toggle flipped while already blanked must take effect NOW, or an A/B needs a
# physical tap between every leg - which is how the stranding above happened.
disp = fnbody(MAIN, 'buf.startsWith("PANELSLEEP ")')
check("the toggle command re-syncs immediately, so no tap is needed mid-blank",
      disp is not None and "savingsSync()" in disp)

es = fnbody(POWER, "void enterSleep()")
check("enterSleep kills the backlight BEFORE applying any saving",
      before(es, "ledcWrite", "savingsSync"))

wu = fnbody(POWER, "void wakeUp()")
# The CPU-before-panel ordering is asserted inside savingsSync above; here the
# invariant is that the restore happens before the screen is lit at all.
check("wakeUp restores savings BEFORE raising the backlight",
      before(wu, "savingsSync", "ledcWrite"))

# --------------------------------------------------------------------------
# THE FOURTH SAVING: YIELDING loop() WHILE BLANKED.
#
# Different in kind from the three above, and the difference is why it has no
# *Applied twin. Those change hardware state that must later be put back; this
# one changes nothing at all. loop() reads the flag each iteration and either
# yields or does not, so there is no state that can be left stranded and nothing
# for savingsSync() to reconcile. Inventing a twin would invent a leak.
#
# What it fixes is that the Arduino loop task never blocks on its own, so the
# FreeRTOS idle task on that core never runs and the CPU never reaches WAITI: a
# 100% duty core at 240MHz evaluating a loop body whose every branch is gated
# off by !isAsleep. A BUSY-WAIT WOULD SAVE NOTHING, which is the one substitution
# that would look right and measure zero - hence the assertion below that the
# yield is specifically a blocking delay().
B2 = B2H   # already read at the top, for BOARD_BATT_FULL_MV


def arm(src, needle):
    """The dispatch ARM starting at `needle`, not the whole function.

    fnbody() would run to the end of processCompletedLine(), so any assertion
    about this arm could be satisfied by an unrelated arm hundreds of lines
    later - the "a rule a neighbouring line can satisfy is not a rule" trap.
    """
    i = src.find(needle)
    if i < 0:
        return None
    j = src.find("\n  } else if", i)
    return src[i:j] if j > 0 else src[i:]


# PARSED out of the header, never transcribed: a literal here would keep passing
# after the #define was reverted, which is the failure mode this repo has paid
# for at least four times.
m = re.search(r"#define\s+BLANKED_LOOP_IDLE_MS\s+(\d+)", B2)
check("BLANKED_LOOP_IDLE_MS is a #define in board 2's header", m is not None)
idle_ms = int(m.group(1)) if m else -1
# A #define rather than a const int, and NOT decoration: `#if` on a C++ const
# int is silently false with no warning, and this repo has shipped that twice.
check("the blanked yield is at least one FreeRTOS tick, or the task never blocks",
      idle_ms >= 1)
check("...and short enough that a POLLED tap is not missed (<= 100ms)",
      1 <= idle_ms <= 100)

lp = fnbody(MAIN, "void loop()")
check("loop() is locatable", lp is not None)
check("loop() yields while blanked, gated on BOTH isAsleep and the toggle",
      lp is not None and re.search(r"isAsleep\s*&&\s*saveLoopIdle", lp) is not None)
check("the yield BLOCKS the task (delay), so the idle task can reach WAITI",
      lp is not None and re.search(
          r"isAsleep\s*&&\s*saveLoopIdle\s*\)\s*delay\s*\(\s*BLANKED_LOOP_IDLE_MS", lp)
      is not None)
check("saveLoopIdle defaults to OFF, so an A/B's baseline is unoptimised",
      re.search(r"bool\s+saveLoopIdle\s*=\s*false", MAIN) is not None)
check("saveLoopIdle has NO *Applied twin - it changes no state to restore",
      re.search(r"bool\s+loopIdleApplied", MAIN) is None)
check("savingsSync() leaves saveLoopIdle alone (there is nothing to reconcile)",
      sy is not None and "saveLoopIdle" not in sy)

# THE TRAILING `else` WAS A REAL TRAP, not a hypothetical one: while BLESLOW was
# the last verb in the condition, `else saveBleSlow = on` was correct - and
# adding LOOPIDLE to that condition would have routed it into the same else,
# setting the wrong flag and reporting bleSlow=1 for a LOOPIDLE the caller asked
# for. Both halves are asserted because either one alone permits the bug.
tog = arm(MAIN, 'buf.startsWith("PANELSLEEP ")')
check("the toggle arm is locatable", tog is not None)
check("BLESLOW is matched BY NAME, so LOOPIDLE cannot fall into its else",
      tog is not None and 'buf.startsWith("BLESLOW")' in tog)
check("LOOPIDLE reaches its OWN flag from the dispatch",
      tog is not None and "saveLoopIdle = on" in tog)
# ONE emitter, shared by the setter and the read-only query, so the two cannot
# report different things. Asserted on the emitter, not the arm, because that is
# where the format now lives.
sl = fnbody(POWER, "void sendSavingsLine()")
check("sendSavingsLine() exists", sl is not None)
for fld in ("panelSleep=%d", "cpuSlow=%d", "bleSlow=%d", "loopIdle=%d", "lightIdle=%d",
            "asleep=%d"):
    check(f"the SAVINGS line reports {fld.split('=')[0]}",
          sl is not None and fld in sl)
check("the toggle arm DELEGATES to the emitter rather than formatting its own",
      tog is not None and "sendSavingsLine()" in tog and "snprintf" not in strip_comments(tog))

# THE READ-ONLY QUERY, AND ITS ABSENCE COST A REAL SETTING. With no way to see
# the state without setting one, `LIGHTIDLE 0` got used to read the line - and
# silently wrote OFF to NVS for the one toggle that persists.
q = arm(MAIN, 'buf == "SAVINGS"')
check("a read-only SAVINGS query exists", q is not None)
check("...and it reports through the shared emitter",
      q is not None and "sendSavingsLine()" in q)
# The whole point: it must not WRITE anything.
qc = strip_comments(q) if q else None
check("...and it sets NOTHING - no flag, no NVS write",
      qc is not None and "= on" not in qc and "saveLightIdleSetting" not in qc
      and "savingsSync" not in qc)

# --------------------------------------------------------------------------
# LIGHTSLEEP: an EXPERIMENT, and the assertions are about it STAYING one.
#
# The stock core cannot do automatic light sleep at all (CONFIG_PM_ENABLE unset,
# so esp_pm_configure() is a stub, and CONFIG_FREERTOS_USE_TICKLESS_IDLE is its
# absent prerequisite), so this is a manual esp_light_sleep_start() that powers
# the radio down under a controller with no modem sleep. The BLE link is
# expected to die across it - which is exactly why the properties below matter.
ls = arm(MAIN, 'buf == "LIGHTSLEEP"')
check("the LIGHTSLEEP arm is locatable", ls is not None)

for name, lo, hi in (("LIGHTSLEEP_MIN_S", 1, 600), ("LIGHTSLEEP_MAX_S", 600, 86400)):
    m = re.search(rf"{name}\s*=\s*(\d+)", MAIN)
    check(f"{name} is declared in the sketch", m is not None)
    check(f"{name} is a sane bound", m is not None and lo <= int(m.group(1)) <= hi)

# THE ANSWER MUST SURVIVE THE LINK IT WAS MEASURING. The radio is the only way
# off this board with the cable out, and this command deliberately stops it - so
# a result that were only SENT could be destroyed by the very thing under test.
# BOUND TO THE WRITE, not to the name. The first version of this assertion said
# `"lightSleepReport" in ls` and PASSED with the retention removed, because the
# `report` branch below still mentions the buffer - a rule the neighbouring line
# satisfied. Caught by mutating the snprintf target, which is the only reason it
# is written this way.
check("the result is RETAINED in the buffer, not only sent",
      ls is not None and "snprintf(lightSleepReport, sizeof(lightSleepReport)," in ls)
check("...and is re-readable later with `LIGHTSLEEP report`",
      ls is not None and 'arg == "report"' in ls)
check("the retained buffer exists as a global the dispatch can see",
      re.search(r"char\s+lightSleepReport\s*\[", MAIN) is not None)

# AN EXPERIMENT MUST NOT CHANGE HOW THE DEVICE BEHAVES AFTER IT. A wake source
# left armed is a behaviour change wearing a test's clothes.
check("the timer wake is DISARMED after the run",
      ls is not None and "esp_sleep_disable_wakeup_source" in ls)
check("the GPIO wake is DISARMED after the run",
      ls is not None and "gpio_wakeup_disable" in ls)

# Both ends of the comparison must be the same METHOD, or the difference between
# a raw sample and an EMA of 8 is charged to the cell.
check("the EMA is settled on BOTH sides of the sleep (two settle loops)",
      ls is not None and ls.count("for (int i = 0; i < 12; i++) sampleBattery();") == 2)

# It refuses on USB BY NAME - the same rule POWERPROBE's refusal exists for, and
# here it is doubly required: light sleep takes down the CDC link itself.
check("LIGHTSLEEP refuses on USB, naming the cause",
      ls is not None and "usbLinkActive()" in ls and "LIGHTSLEEP refused: on USB" in ls)
check("a sleep too short to rate prints NO rate",
      ls is not None and "LIGHTSLEEP_MIN_RATE_H" in ls and "too short to rate" in ls)

# THE SCOPING DECISION, ASSERTED so it is not quietly widened: this must not
# deinit the BLE stack. Doing so would strand bleLinks[], releasePending,
# hostLinks[] and the server/characteristic pointers all at once.
check("LIGHTSLEEP does NOT deinit the BLE stack",
      ls is not None and "BLEDevice::deinit" not in ls)
check("...but it does re-assert advertising on wake",
      ls is not None and "BLEDevice::startAdvertising()" in ls)

# --------------------------------------------------------------------------
# LIGHTIDLE: light sleep while blanked, and POWER OFF's two board-2 additions.
li = fnbody(POWER, "void enterLightIdle()")
check("enterLightIdle() exists", li is not None)
check("saveLightIdle defaults to OFF",
      re.search(r"bool\s+saveLightIdle\s*=\s*false", MAIN) is not None)

# THE CABLE IS THE ESCAPE HATCH, and it is the only one. This setting PERSISTS
# and it suppresses the radio, so without this gate a device that failed to
# re-advertise after a sleep would be unreachable across reboots too. Asserted
# as three separate terms because dropping any one of them reopens that door.
lp = fnbody(MAIN, "void loop()")
check("light sleep is gated on isAsleep",
      lp is not None and re.search(r"isAsleep\s*&&\s*saveLightIdle", lp) is not None)
check("light sleep is INERT on USB - the escape hatch for a persisted setting",
      lp is not None and re.search(r"saveLightIdle\s*&&\s*!usbLinkActive\(\)", lp) is not None)
# else-if, not a second if: enterLightIdle() returns only after a wake, so a
# following delay() would run at exactly the wrong moment.
check("the LOOPIDLE yield is an ELSE of the light sleep, never both",
      lp is not None and re.search(r"enterLightIdle\(\);\s*\n\s*else if", lp) is not None)

# GPIO wake, not ext0/ext1 - the whole reason this board uses light sleep at all.
check("the wake source is GPIO, which is what ext0/ext1 cannot do from pin 47",
      li is not None and "esp_sleep_enable_gpio_wakeup" in li
      and "ext0" not in li and "ext1" not in li)
# LEVEL not EDGE: an edge arriving during setup would be missed and the first
# tap ignored.
check("the touch wake is LEVEL-triggered, so a tap cannot be missed",
      li is not None and "GPIO_INTR_LOW_LEVEL" in li)
check("the wake source is DISARMED after waking",
      li is not None and "gpio_wakeup_disable" in li)
check("it re-advertises on wake - the radio died with the CPU",
      li is not None and "BLEDevice::startAdvertising()" in li)
check("LIGHTIDLE is PERSISTED, unlike the measurement toggles",
      re.search(r'prefs\.putBool\("lightIdle"', POWER) is not None
      and re.search(r'prefs\.getBool\("lightIdle"', POWER) is not None)

ed = fnbody(POWER, "void enterDeepSleep()")
check("enterDeepSleep() exists", ed is not None)
# CODE ONLY for all of these: the block carries a long comment that NAMES every
# symbol below while explaining it, so a plain text search would pass on prose.
edc = strip_comments(ed) if ed else None
# THIS REVERSES AN EARLIER DECISION, deliberately. The field measurement is
# -5.6 mV/h over 23 hours "off" (~17%/day), board 1 loses almost nothing in the
# same state, and the difference is that board 1's writecommand(0x28/0x10) is
# REAL while PanelShim::writecommand() ignores its argument - so board 2's panel
# controller ran flat out through every power-off.
# EVERY STEP IS NOW OPTIONAL, and the assertions must say so rather than keep
# their old names. Two changes shipped unconditionally this week on reasoning
# alone and neither moved the number, so the teardown became a runtime bitmask
# with DEFAULT 0 - the original behaviour, kept as the baseline to compare
# against. An assertion still claiming "POWER OFF sleeps the panel" would be
# describing a step that is off by default.
# THE DEFAULT MOVED, AND SO DOES THIS ASSERTION. It used to require 0 - correct
# while every step was a guess, since a saving defaulting ON silently optimises
# the "before" leg of the next A/B. That expired when the combination was
# MEASURED at -3.6 mV/h against -5.6 for the original teardown, so the default is
# now the measured combination and this asserts THAT, by name, rather than a
# literal that would pass for any value.
# THE DEFAULT MUST CARRY ALL THREE MEASURED BITS, asserted one at a time rather
# than as one exact expression: hygiene bits were added to the default later, and
# an exact match would have had to be rewritten for each - which is how an
# assertion quietly becomes a transcription of whatever the code currently says.
_dflt = re.search(r"uint32_t\s+pwrOffMode\s*=([^;]*);", MAIN)
check("the teardown default is an expression of named bits, not a literal",
      _dflt is not None and "PWROFF_" in _dflt.group(1)
      and not re.search(r"=\s*0x?[0-9A-Fa-f]+\s*$", _dflt.group(1).strip()))
for nm in ("PWROFF_PANEL_SLEEP", "PWROFF_IC_RESET", "PWROFF_CODEC_DOWN"):
    check(f"the default keeps the MEASURED bit {nm}",
          _dflt is not None and nm in _dflt.group(1))
# The one step the evidence is AGAINST must stay out of the default - it was
# never in the combination that was measured.
check("QSPI_ISOLATE is NOT in the default - it was not in the tested combination",
      _dflt is not None and "PWROFF_QSPI_ISOLATE" not in _dflt.group(1))
bits = {}
for nm in ("PWROFF_PANEL_SLEEP", "PWROFF_IC_RESET", "PWROFF_CODEC_DOWN",
           "PWROFF_QSPI_ISOLATE", "PWROFF_LED_LOW", "PWROFF_RTC_OFF"):
    m = re.search(rf"#define\s+{nm}\s+(0x[0-9A-Fa-f]+|\d+)", MAIN)
    check(f"{nm} is defined", m is not None)
    if m:
        bits[nm] = int(m.group(1), 0)
check("every teardown bit is a distinct single bit",
      len(bits) == 6 and len(set(bits.values())) == 6
      and all(v and not (v & (v - 1)) for v in bits.values()))
for nm in bits:
    check(f"the {nm} step is GATED on its own bit",
          edc is not None and f"pwrOffMode & {nm}" in edc)

# THE RECORD IS THE POINT. Without it, a power-off and a light sleep are
# indistinguishable from the Mac - which is exactly what made two days of
# measurement unattributable.
check("the cell is recorded BEFORE any teardown step runs",
      edc is not None and before(edc, 'prefs.putUShort("poMv"', "pwrOffMode &"))
check("the mode is recorded alongside it, so a result names its own combination",
      edc is not None and 'prefs.putUInt("poMode"' in edc)
# sleepPanel() has five return-false paths and the first version DISCARDED the
# result, so a step that never ran looked exactly like one that did nothing.
check("sleepPanel()'s RETURN is captured, never discarded",
      edc is not None and re.search(r'putUChar\("poPs",\s*tft\.sleepPanel\(true\)', edc)
      is not None)
# GPIO48 is outside the RTC set (0..21), so it takes a hold, not an isolate.
check("the display-IC reset is HELD through sleep (48 is not an RTC GPIO)",
      edc is not None and "PIN_TOUCH_RST" in edc and "gpio_hold_en" in edc)
check("the reset is driven ACTIVE LOW, as the header says the pin is",
      edc is not None and re.search(r"digitalWrite\(PIN_TOUCH_RST,\s*LOW\)", edc) is not None)

# ---- the two hygiene steps, which are NOT claimed as savings --------------
# GPIO40 is outside the RTC set (0..21) so it takes a hold, not an isolate - the
# same distinction the backlight on 41 already turns on.
check("the RGB LED's data line is driven LOW and HELD",
      edc is not None and "PIN_RGB_LED" in edc
      and re.search(r"digitalWrite\(PIN_RGB_LED,\s*LOW\)", edc) is not None
      and "gpio_hold_en" in edc)
# ONE domain, and asserting the other two would be asserting a compile error:
# esp_sleep_pd_domain_t's entries are behind SOC_PM_SUPPORT_*_PD, and the S3
# defines only SOC_PM_SUPPORT_RTC_PERIPH_PD. Naming the two it lacks is how this
# was found - they did not compile.
check("ESP_PD_DOMAIN_RTC_PERIPH is powered down - nothing here survives the reset",
      edc is not None and "ESP_PD_DOMAIN_RTC_PERIPH" in edc)
check("the two domains this silicon cannot gate are NOT named",
      edc is not None and "RTC_SLOW_MEM" not in edc and "RTC_FAST_MEM" not in edc)

# ---- AUTO POWER-OFF, and the interaction that would have silently killed it -
m = re.search(r"#define\s+AUTO_POWEROFF_MS\s+\(([^)]*)\)", B2H)
check("AUTO_POWEROFF_MS is a #define in board 2's header", m is not None)
_ms = None
if m:
    try: _ms = eval(m.group(1).replace("UL", ""))
    except Exception: _ms = None
check("AUTO_POWEROFF_MS is hours, not minutes - the brick case is the objection",
      _ms is not None and 30*60*1000 <= _ms <= 12*60*60*1000)
# AUTO_SLEEP_IDLE_MS lives in the SKETCH, not power.ino, and is an expression
# rather than a literal - firmware_const() reads power.ino and exited by name
# here, which is the parse discipline working rather than a nuisance.
_m1 = re.search(r"AUTO_SLEEP_IDLE_MS\s*=\s*([^;]+);", MAIN)
_b1 = None
if _m1:
    try: _b1 = eval(_m1.group(1).replace("UL", ""))
    except Exception: _b1 = None
check("board 1's AUTO_SLEEP_IDLE_MS parses, so the comparison below is real",
      _b1 is not None)
check("it is LONGER than board 1's touch-wakeable auto-sleep, which can afford to be brief",
      _ms is not None and _b1 is not None and _ms > _b1)

lp2 = fnbody(MAIN, "void loop()")
check("loop() reaches autoPowerOff() on board 2",
      lp2 is not None and "autoPowerOff()" in lp2)
# BOUND TO THE CONDITION THAT GUARDS THE CALL, not to loop(). The first version
# searched the whole body and PASSED with every gate deleted, because BOARD 1's
# arm a few lines up contains the same terms - the "a rule a neighbouring line
# can satisfy is not a rule" trap, reproduced in the assertion written to
# prevent it. Caught by mutating the gate away and watching it pass.
# Sliced, not regexed: the condition contains its own call parentheses
# (batteryPresent(), millis()) and a paren-counting regex got that wrong twice.
# Take the text between the `if (` that precedes the call and the call itself.
def _guard_of(body, call):
    if not body or call not in body:
        return None
    i = body.index(call)
    j = body.rfind("if (", 0, i)
    return None if j < 0 else type("M", (), {"group": lambda self, n: body[j:i]})()
_apo = _guard_of(strip_comments(lp2), "autoPowerOff();")
check("the autoPowerOff() call site has a guard at all", _apo is not None)
# The same three gates board 1 uses. A missing one is the difference between
# "idle on battery" and "powers off while you are using it on the cable".
for g in ("!onUsbPower", "batteryPresent()", "AUTO_POWEROFF_MS"):
    check(f"the auto power-off's OWN condition is gated on {g}",
          _apo is not None and g in _apo.group(1))

# THE ONE THAT WOULD HAVE FAILED SILENTLY: light sleep stops loop(), so without a
# timer armed for the deadline the auto power-off can NEVER fire - the two
# features cancelling out with no symptom but the drain.
check("enterLightIdle arms a timer for the AUTO_POWEROFF_MS deadline",
      li is not None and "esp_sleep_enable_timer_wakeup" in li
      and "AUTO_POWEROFF_MS" in li)
check("...and disarms it again, so the wake source cannot outlive the state",
      li is not None and "esp_sleep_disable_wakeup_source" in li)

# The deliberate asymmetry with board 1's autoDeepSleep(), which DOES light the
# panel to show a farewell. At two hours there is nobody to read one.
ap = fnbody(POWER, "void autoPowerOff()")
check("autoPowerOff() exists", ap is not None)
check("autoPowerOff() lights NO farewell - two hours in, it would be spending the "
      "very thing it is saving",
      ap is not None and "ledcWrite" not in ap and "drawString" not in ap)

# A LITERAL FALLBACK HERE SILENTLY DISCARDS THE COMPILED DEFAULT. `getUInt(key,
# 0)` means a fresh NVS loads 0 no matter what the source says, so the default
# above becomes decoration. It shipped that way once and the device reported 0x7
# against a source that said 0x37.
lm = fnbody(POWER, "void loadPwrOffMode()")
check("loadPwrOffMode falls back to the COMPILED default, not a literal",
      lm is not None and re.search(r'getUInt\("pwroffMode",\s*pwrOffMode\)', lm) is not None)

lr = fnbody(POWER, "void loadPwrOffRecord()")
check("loadPwrOffRecord() exists", lr is not None)
check("...and CLEARS the record, so it cannot re-report a stale outage for ever",
      lr is not None and 'prefs.remove("poMv")' in lr)

# The read-only form, and the lesson that produced it.
pm = arm(MAIN, 'buf == "PWROFFMODE"')
check("a bare PWROFFMODE reports", pm is not None)
# EVERY bit must appear in the report. A mode with a bit you cannot see is a
# setting you cannot verify, which is how LIGHTIDLE's value got clobbered.
for _b in ("panelSleep", "icReset", "codecDown", "qspiIsolate", "ledLow", "rtcOff"):
    check(f"the PWROFFMODE report shows {_b}", pm is not None and f"{_b}=%d" in pm)
check("...and writes NOTHING unless an argument was given",
      pm is not None and re.search(r"if\s*\(arg\.length\(\)\)\s*\{[^}]*savePwrOffMode", pm)
      is not None)

# --------------------------------------------------------------------------
# THE SESSION-GATED IDLE LADDER: lit -> dim -> blank.
#
# The point is that this device is a STATUS display, so it should stay readable
# while something actually wants you and power down when nothing does. The gate
# is therefore session state, not just touch idleness: any session `working` or
# `asking` holds the screen lit indefinitely.
#
# STALE DATA MUST NOT HOLD IT. A vanished host would otherwise pin the screen on
# forever showing sessions that may have finished hours ago - the same
# distinction lastNonIdleMillis already makes for board 1's deep sleep.
DIM_PCT = firmware_const("SCREEN_DIM_PCT")
print(f"  ladder constants read from power.ino: dim={DIM_PCT}% of the set brightness")


def screenIdleStage(idle_ms, dim_ms):
    """0 = lit, 1 = dim, 2 = blank. dim_ms == 0 is the OFF preset: never either."""
    if dim_ms == 0:
        return 0
    if idle_ms >= dim_ms * 2:
        return 2
    if idle_ms >= dim_ms:
        return 1
    return 0


def attentionNeeded(statuses, fresh=True):
    if not fresh:
        return False
    return any(s in ("working", "asking") for s in statuses)


M5, M10 = 5 * 60000, 10 * 60000
check("lit before the dim delay", screenIdleStage(M5 - 1, M5) == 0)
check("dims at exactly the dim delay", screenIdleStage(M5, M5) == 1)
check("still dim one ms before twice the delay", screenIdleStage(M10 - 1, M5) == 1)
check("blanks at exactly twice the delay", screenIdleStage(M10, M5) == 2)
check("SLEEP AFTER=OFF never dims and never blanks",
      screenIdleStage(99 * 3600000, 0) == 0)

check("no sessions at all lets the ladder run", attentionNeeded([]) is False)
check("all-READY lets the ladder run", attentionNeeded(["waiting", "waiting"]) is False)
check("one WORKING session holds the screen lit", attentionNeeded(["waiting", "working"]) is True)
check("one ASKING session holds the screen lit", attentionNeeded(["asking"]) is True)
check("a STALE host does not hold the screen lit",
      attentionNeeded(["working", "asking"], fresh=False) is False)

# --- the firmware has to actually be wired this way ---
st = fnbody(POWER, "int screenIdleStage(")
check("screenIdleStage() exists in the firmware", st is not None)
an = fnbody(POWER, "bool attentionNeeded()")
check("attentionNeeded() checks BOTH working and asking",
      an is not None and '"working"' in an and '"asking"' in an)
check("attentionNeeded() refuses to count a stale host",
      an is not None and "everReceived" in an)
check("waking clears the dim state, so a wake is full brightness",
      before(fnbody(POWER, "void wakeUp()"), "isDimmed = false", "ledcWrite"))
check("the loop drives the ladder", "tickScreenIdle()" in MAIN)
# A tap while DIMMED must restore brightness and still act - the screen is
# readable when dim, so swallowing that tap (as the blanked case deliberately
# does) would be gratuitous.
ht = fnbody(MAIN, "void handleTouch()")
check("a tap while dimmed is handled BEFORE the swallow-the-tap sleep branch",
      before(ht, "isDimmed", "if (isAsleep)"))

# --- the ring must not silently keep more than the firmware's array holds ---
check(f"a window longer than {PROBE_MAX_BUCKETS} buckets still fits the ring",
      len(pbuckets(PROBE_MAX_BUCKETS, -88.0)[-PROBE_MAX_BUCKETS:]) == PROBE_MAX_BUCKETS)

sys.exit(1 if fails else 0)
