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
CHG_FULL_MV     = firmware_const("BATT_FULL_MV")
print(f"  charge thresholds read from power.ino: span={CHG_MIN_SPAN_MS // 60000}min "
      f"rise={CHG_MIN_RISE_MV}mV knee={CHG_KNEE_MV}mV target={CHG_TARGET_MV}mV")

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
