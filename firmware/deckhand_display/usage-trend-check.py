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
    m = re.search(r"const\s+(?:int|long|unsigned long|float)\s+" + name + r"\s*=\s*([^;]+);", src)
    if not m:
        sys.exit(f"FAIL: could not parse {name} out of the firmware - "
                 f"the checker's parse is broken, or the constant was renamed")
    return m.group(1).strip()

def const_int(name, src=HDR):
    v = const(name, src)
    m = re.fullmatch(r"-?\d+", v)
    if not m:
        sys.exit(f"FAIL: {name} is `{v}`, which this checker cannot evaluate as an int")
    return int(v)

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

# ---- the span is exactly 150 min, and the caption depends on it -------------
# 30 slots span 145, and a card captioned LAST 2.5H over a 145-minute ring
# overstates it by five minutes. 31 slots span exactly 150.
# (The LAST 2.5H caption assertion itself belongs to Task 7, which writes the
# spark that satisfies it - see CONTROLLER RULING in the task-5 brief.)
chk(SPAN == 150, f"ring span (SLOTS-1)*STEP_MIN = {SPAN} min, must be exactly 150")

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

print(f"{n - fails}/{n} assertions pass" if not fails else f"{fails} of {n} FAILED")
sys.exit(1 if fails else 0)
