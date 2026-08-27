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
