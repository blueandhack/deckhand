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
sys.exit(1 if fails else 0)
