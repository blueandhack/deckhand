# Deckhand case — BOARD 2 (ES3C35P, 3.5" ESP32-S3)

`deckhand_case_b2.scad`. A **sibling** of `deckhand_case.scad`, not a replacement:
board 1's case is printed and working, so it is untouched. The geometry logic here is
board 1's — columns, snap lip, stand hinge, chamfers, the coordinate system — because
it is proven. What changed is what board 2 actually changes.

```
openscad -o stl/deckhand_b2_body.stl -D 'part="body"' deckhand_case_b2.scad
# parts: body | cover | retainer | stand | coupon | section | all
```

## Print the coupon first

```
openscad -o stl/deckhand_b2_coupon.stl -D 'part="coupon"' deckhand_case_b2.scad
```

A 26 mm slice of the service edge — a few grams, a few minutes — carrying only the
things that can be wrong: two mounting columns, the board outline, the window edge,
and the USB-C cutout. Every service-edge value is now **measured** (below) rather than
guessed, but measured is not the same as fitted: printing a 60 g body to discover the
USB plug fouls the shell is the mistake this exists to prevent.

What to check, in the order that matters:

1. **Does the board drop onto the columns without forcing?** If not, the hole insets or
   `clr`/`clr_w` are wrong — not the column diameter.
2. **Does a USB-C plug seat squarely, with even gaps?** An off-centre gap is `usb_dx`;
   a plug that fouls the shell is `usb_w`/`usb_h`.
3. **Can a pen tip reach RESET, and a toothpick BOOT?** `reset_dx` / `boot_dx`, and the
   Ø9 / Ø5.5 split. Neither is finger-reachable — see below for why that is deliberate.
4. **Is the mic port over the capsule?** That checks `mic_front_x`/`mic_front_side` and
   the `win_shift` datum assumption at once, since both reference the mic end.

## What the printed coupon changed

**`clr_w` 0.0 → 0.25.** The board did not seat — short by about 0.5 mm across the width.
`clr_w` is **per side** (`in_w = board_w + 2*clr_w`), so 0.25 widens the cavity by the
0.5 that was missing: 54.50 → 55.00, and the case with it, 58.9 → 59.4 wide.

**Worth a second thought rather than a shrug, though.** Board 1 sets this to 0.0 and
suggests *"0.1–0.15 if the board won't drop in on your printer"*. 0.25 is past that, and
0.5 mm over 54.5 is **~0.9%** — large for FDM. There are two different faults that both
present as "the board doesn't fit", and they want different fixes:

| measure the printed coupon's cavity | meaning | fix |
|---|---|---|
| ~54.0 (undersized) | the printer, not the model | slicer **XY size compensation** — corrects every part you print, not just this one |
| ~54.5 (correct) but still tight | the board is wider than the drawing says | change `board_w`, and re-check `hole_ins_x` against your own board |

`clr_w = 0.25` is applied because it is what was asked for and it will fit. But if the
cavity measures 54.0, the number is compensating for the printer inside the model, where
it will silently mis-size the next design too.

## Screwing the board down

`board_screws = true` puts an **M3 pilot in each of the four columns** instead of a
locating pin — they need the same axis, so it is one or the other. The screw passes
through the board's Ø3.2 hole (M3's 3.0 major clears it) and threads straight into the
plastic.

**No captive nuts, and that is this design's existing pattern rather than a shortcut.**
The stand hinge already threads M3 into plastic, and its comment says why: *"a nut is
6.5 mm across corners, which is what forced the old 9 mm knuckle and all the bulk."*

| | |
|---|---|
| pilot | **Ø2.6** — see below; not the Ø2.5 tap-drill figure |
| depth | 4.3 mm ≈ 1.4 × M3 diameter |
| column wall around it | 2.25 mm |
| front skin left | **1.0 mm** |

**The depth is limited by the front face, not by preference.** The column alone is only
3.1 mm tall — one screw diameter, which is marginal — so the pilot continues down into
the front slab for another 1.2. What it must never do is break through: those four points
sit under the bezel, where a dimple would be visible from the front. `screw_skin = 1.0`
is the material left, and the render confirms an unbroken front face.

### Two symptoms, one printer

The board not seating and the screws not driving turned out to be **the same fault**, and
they are now corrected by one named constant rather than two fudges:

```
print_shrink = 0.5;   // measured on a DIAMETER or an opening; 0.25 per surface
```

Internal features print undersize because the extruded bead sits *inside* the modelled
boundary. The coupon showed 0.5 mm missing across a 55 mm cavity opening — 0.25 per
surface — and the same 0.25 per side turns a modelled Ø2.6 bore into ~2.1, which is
exactly the interference that stopped the screws. `clr_w` is now `print_shrink / 2` and
the pilot is `screw_pilot_target + print_shrink`, so both follow the one measurement.

**The right place to fix this is your slicer, not this file.** Every slicer has an XY size
compensation (Cura *Horizontal Expansion*, PrusaSlicer/Orca *XY size compensation*): set
it to **+0.25** and every part you print comes out right, including other people's designs.
Compensating here fixes this one model and silently mis-sizes the next. **If you set the
slicer, put `print_shrink` back to 0.**

### The screws — use M3 × 5, self-tapping

**The depth follows the screw, not the other way round.** `screw_len = 6.0` is the screw
actually in hand; `screw_skin` is derived from it (`z_pcb_b − screw_len − screw_tip_margin`),
giving **4.6 mm of thread and 0.70 mm of front-face material**. Change `screw_len` and the
pilot follows.

A screw that bottoms out looks exactly like a hole that is too small — it stops dead
partway and no force helps. That symptom already cost one print, from advice of "M3 × 6 or
8" against 5.9 mm of usable space.

**A longer screw eats the front face**, and past ~7.6 mm it comes through the bezel. That
is an `assert`, not a comment — verified by running it:

```
$ openscad -D 'screw_len=7.0' deckhand_case_b2.scad
ERROR: Assertion '(screw_skin >= screw_skin_min)' failed: "screw_len is too long: the
pilot would leave too little front-face material..."
```

**Pilot: Ø2.9 modelled → ~2.4 printed.** 2.4 is the ~0.8 × major that thread-forming into
thermoplastic wants for M3.

This was got wrong twice, and how is worth recording. First **2.5**, from an M3 tap-drill
table — the wrong reference entirely, since a tap drill assumes a *cutting* tap and a hole
the size you asked for. Then **2.9 was tried and talked back down to 2.6** using an
engagement calculation that assumed the printed hole equals the modelled hole — ignoring
the very shrinkage the same paragraph had just invoked. 2.9 was right; the reasoning
offered for it was wrong, and the reasoning against it was worse. Engagement is now
computed on the **printed** size, where it means something: 2.9 → 2.4 → ~111% of thread,
which is correct for forming in plastic.

**Set `board_screws = false` to get the locating pins back**, which is board 1's
behaviour: they fix the board laterally and hold it against nothing.

## Every board number is from the vendor drawing

Board 1's file says *"MEASURE YOURS AND EDIT"*, because nobody had a drawing. Board 2
has one (`demo/vendor/spec.pdf` p12), so the values that were guesses there are exact
here:

| | board 1 (guessed) | board 2 (vendor) |
|---|---|---|
| PCB | 51.0 × 86.0 × 1.6 | **54.50 × 101.50 × 1.60** |
| hole span | one inset, 3.6 | **47.90 × 94.50** → 3.30 / 3.50 |
| hole / pad / corner | — | Ø3.2 · pad R2.80 · corner R3.50 |
| glass above PCB | `glass_up = 4.2` | **3.70** = CTP 1.00 + LCD 2.20 + glue 0.50 |
| parts behind PCB | `comp_back = 6.0` | 4.70 spec'd — but see below |
| glass | — | 54.50 × 83.00, **centred** (9.25 bezel each end) |
| active area | — | 48.96 × 73.44, **11.40 from the mic end** |
| mic port | (external module) | 3.94 from the mic edge, 9.82 from a long edge, **front face** |

**`comp_back` stays at 6.0, not the spec's 4.70.** The drawing gives bare component
height; the 1.25 mm JST plugs on the battery/UART/I2C/Expand headers stand proud once
**mated**, which an outline drawing does not show. It is rarely the binding term anyway —
`cavity_d` takes the max against the battery stack at 18.5 — so it matters only for a
build with no battery.

## Four things are structurally different

1. **No external microphone.** Board 1 carries a MAX4466 on its Expand connector, which
   costs that case a module room in the retainer, a cable channel, ribs and a side port.
   Board 2's mic is **on the board, facing forward**, so all of it collapses to one hole
   in the front bezel. Switched off by `mic_ext`, not deleted, so the diff against board
   1 stays readable and a board-1 build is still one flag away.
2. **Two hole insets, not one.** 47.90 across 54.50 gives 3.30; 94.50 along 101.50 gives
   3.50. A single number puts every column 0.2 mm out in one axis — inside the Ø3.2
   hole's slop, but wrong, and it compounds if anyone raises `pin_d` toward a real fit.
3. **The window is off-centre, and that is correct.** The *glass* is centred
   (9.25 + 83.00 + 9.25 = 101.50 exactly) but the *active area* is not: it sits 11.40
   from the mic end, so its centre is 48.12 where the board's is 50.75. Hence
   `win_shift = 2.63` toward the mic end. The window then spans 10.62..85.62 and brackets
   the AA (11.40..84.84) with 0.78 mm each side. A centred window would crop the display
   at one end and show 6 mm of black border at the other.
4. **RESET is load-bearing.** Board 2 **cannot wake from deep sleep by touch** — the S3's
   RTC GPIO set does not reach `PIN_TOUCH_INT`, so RESET is the only way back (see
   CLAUDE.md). A case that buries it makes the device look bricked.

   **Which matters more than it sounds, because board 1's case never cut these holes at
   all.** `reset_dx`, `boot_dx`, `btn_in`, `btn_d` and the derived `btn_y` are all
   declared in `deckhand_case.scad` and referenced by **nothing** — while that file's own
   header says *"RESET/BOOT are back-face holes"*. Declared-but-unwired state whose
   comments claim it works is a defect class this repo has paid for before. Here they are
   wired, in `cover()`.

## The service edge — now measured, not guessed

All four are measured off the board. What they changed:

| parameter | was (guess) | now | from |
|---|---|---|---|
| `usb_dx` | 0.0 | **0.0** | confirmed: USB-C is centred on the edge |
| `reset_dx` | −12.0 | **−13.5** | derived, below |
| `boot_dx` | +12.0 | **+13.5** | derived, below |
| `mic_front_side` | +1 | **+1** | confirmed: front face, top right |

**The 6 mm is edge-to-edge, not centre-to-centre**, and it has to be: half the USB is
4.5 and half a button is 3, so a 6 mm centre spacing would have them overlapping. So
`4.5 + 6 + 3 = 13.5` from the centreline.

**Which button is on which side does not affect the geometry.** The board was described
from one viewpoint and this model is referenced to the front — the same mirror board 1's
file records getting wrong (*"reasoning from `reset_dx` being negative gave the wrong
wall"*). Here the two holes are symmetric about the centreline, so a mirror error swaps
only *which hole is which*, never where a hole is. It would make a printed label wrong,
and nothing else.

**The USB opening went back to board 1's 13 × 7** from the widened 14 × 7.5 it carried
while the offset was a guess. The receptacle measures ~9 × 4; the extra 2 mm of slop
existed only to hide an offset error that turned out not to exist. 13 × 7 is not sloppy —
the margin is for the cable's moulded boot, which is far bigger than the plug tongue.

**The mic port grew from Ø2.2 to Ø3.0**, because the two sources disagree by about a
millimetre: the drawing dimensions 9.82 / 3.94, hand measurement gave 9 / 3. Both are
credible for a ~1 mm port, but a Ø2.2 hole placed on one and wrong by 1 mm would be
half-blocked. Ø3.0 covers the disagreement and is still a pressure port, not a horn.

## The battery is 41% of the thickness

Measured: **37 × 68.5 × 10 mm**. Plan fit is easy — 37 × 68.5 in a 54.5 × 102.5 cavity.

| | |
|---|---|
| front stack (recess + glass + PCB) | 6.9 |
| cavity (`batt_seat` 3.0 + cell 10 + swell headroom 2.5) | 15.5 |
| cover | 2.0 |
| **total** | **24.4 mm** |

Case structure is 14.4 mm of that. Every case parameter has already been trimmed as far
as it safely goes, and that work bought 4 mm — so **if this ever needs to be thinner, the
cell is the lever**, not the case:

| cell thickness | case |
|---|---|
| 10 mm (yours) | 24.4 |
| 6 mm | 20.4 |
| 5 mm | 19.4 |
| 4 mm | 18.4 |

Below ~4.5 mm nothing improves: `comp_back` — the mated JST plugs standing off the back
of the board — becomes the floor at **14.1 mm**, and going under *that* means not
plugging anything in.

## Holding the battery without the retainer

The pack sits 9.9–19.9 above the front face and the cover's inner face is at 22.4, so it
has **~0.6 mm of slop around it and 2.5 mm above it**. Tape alone is the obvious answer
and the weakest one: it resists sliding, then peels under exactly the vibration it was
meant to stop.

Instead the corral moved **onto the cover** — four short ribs at the middle of each side
of the battery's footprint (`batt_ribs`, on by default). They cost filament and nothing
else: no extra part to print, and no thickness, because they stand in the `batt_extra`
headroom that already exists. They engage the pack's **upper edge**, not its whole side:
a rib standing 6 mm off the cover reaches down to 16.4, running alongside the pack's top
3.5 mm. Anything under 2.5 mm would merely graze its top face and locate nothing.

They're positioned off the same expression the preview ghost and the retainer use, so all
three agree by construction rather than by three transcriptions of the same arithmetic.

**The pack is now centred, because the reason it wasn't is gone.** Board 1 shifts it 5 mm
off-centre — its own comment says *"to clear the microphone, which now lives against that
wall beside its Expand-pin connector"*, meaning the external MAX4466 module. Board 2 has
no such module, so nothing is on that wall to clear: another board-1 inheritance whose
justification evaporated with the mic subsystem, like the retainer and the hinge end
before it. Centring also evens the margin — 8.75 mm each side, where the inherited offset
left 3.75 on one and 13.75 on the other, and the tight side was the one nearer the
long-edge JSTs. `batt_dy` is now **derived** (`(board_h - batt_h) / 2`) rather than a
literal, so the pack stays centred if the cell ever changes.

**They hold it in plane only — use a ~3 mm foam pad for the rest.** The 2.5 mm of swell
headroom is also 2.5 mm the pack can rattle in, and no rib fixes that without clamping a
lithium pouch, which is the one thing not to do. Foam on the cover's inner face takes up
the slack, still compresses if the cell ever swells, and damps shock. That combination —
ribs for sliding, foam for rattle — is what the retainer was doing, minus the part.

`use_retainer = true` still brings the original corral back if you'd rather print it.

## Two things the measurements forced

**Both button holes are Ø6.0 — the same, because the buttons are the same.** An earlier
pass made RESET Ø9 and BOOT Ø5.5, on the argument that RESET is the only way back from
deep sleep and deserves the easier target. That was my asymmetry, not the hardware's, and
it does not survive the cavity being 15.5 mm deep: **both** holes are ~15 mm from their
button, so both are tool holes whatever their diameter, and 1.5 mm of extra hole buys
nothing a pen tip notices. What it did buy was two different holes under two identical
buttons — which reads as a mistake rather than a decision, and would invite someone later
to "fix" it or wonder what they had missed.

The ceiling on Ø6.0 is structural, not ergonomic: centred 4 mm from the board edge, a Ø9
hole leaves **0.1 mm** of plate at its outer rim — a knife edge that prints badly and
breaks. Ø6.0 leaves 1.6 mm, which is the most the rim will carry.
**The kickstand hinge is at the MIC end, which is the reverse of board 1's rule.** It
is set by how the device *stands*: mic end up, service edge (USB, RESET, BOOT) down on
the desk. So the pivot is at the **top** and the blade swings down and back to prop it,
while the cable and both buttons stay at the **bottom** where a hand reaches them. The
blade's tip lands at y 79.1 against buttons at 94.4 — 15 mm clear.

**This replaced a fix that was solving the wrong problem, and the mistake is worth
recording.** Wiring up the buttons collided with the hinge lugs, so an earlier pass moved
`ks_lug_from` 15 → 26 to slide the lugs off the RESET hole, complete with a clearance
table proving 6.3 mm. The arithmetic was right and the change was wrong: both features
were at the same end *only because the hinge was at the wrong one*. Moving it to the
correct end dissolves the collision entirely and hands back the 11 mm of leverage that
pushing the pivot inboard had given up — a stand wants its pivot near the edge it leans
from. Correct arithmetic is not the same as the correct problem.

`ks_lug_y` and `ks_dir` must flip **together**: the first puts the pivot at the top, the
second points the blade at the service edge. Flipping one alone aims the blade off the
case.

## What is NOT verified

**Nothing here has been printed.** Every part renders in OpenSCAD with no errors and the
front face was checked visually (window asymmetry correct, one mic port in the top bezel
right of centre, matching the vendor photo), but geometry that renders is not geometry
that fits. The coupon is the cheapest way to close that gap, and it is why it exists.
