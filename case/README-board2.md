# Deckhand case — BOARD 2 (ES3C35P, 3.5" ESP32-S3)

`deckhand_case_b2.scad`. A **sibling** of `deckhand_case.scad`, not a replacement:
board 1's case is printed and working, so it is untouched. The geometry logic here is
board 1's — columns, snap lip, stand hinge, chamfers, the coordinate system — because
it is proven. What changed is what board 2 actually changes.

```
openscad -o stl/deckhand_b2_body.stl -D 'part="body"' deckhand_case_b2.scad
# parts: body | cover | retainer | stand | coupon | section | all
```

## The cover is a touch long — twice now

Reported once as "the cover felt a touch long" (which set `gy = g + 0.1`) and again
as "a little bit tight, reduce a little for the long edge". Now `gy = g + 0.25`:
0.55 per end, 0.15 more a side, 0.30 shorter overall. Lip 102.4 in a 103.5 cavity.

**The length gets more clearance than the width on purpose.** The lip is 103 mm on
its long axis and 55 on its short one, and an FDM part bows along its LONG axis —
so whatever warp exists accumulates over nearly twice the span before it has to
enter the cavity. The end clearance is absorbing bow; the side clearance only has
to absorb tolerance.

**`print_shrink` does not enter this number**, which is what makes it a pure fit
figure: the lip is an OUTER feature and the cavity an INNER one, so both lose the
same 0.5 and the modelled clearance is what the printed pair actually has. Compare
`clr_w`, where the compensation is the whole point.

If it turns out the long SIDES bind rather than the ends — cover too wide, not too
long — `g` is the one to raise; the comment in `cover()` says so, so the next
reader does not have to work out which of the two it is.

## The pit in the wall by the mic: a board-1 feature nobody gated

Two faults stacked, and the second is the more instructive.

**It is board 1's, and it was never gated.** The pocket exists to clear the plug on
the EXTERNAL mic module's 4-pin Expand lead. Board 2's mic is on the board
(`mic_ext = false`), nothing is plugged in, so the pocket cleared nothing while
cutting 12 x 12 out of the inner face of the wall beside the microphone. The mic
channel immediately above it in the same `difference()` *is* gated on `mic_ext`;
this one was missed.

**And its depth was stale — its own comment is the evidence.** The line read
`exp_relief = 1.8; // depth into the 2.6 mm wall, leaving 0.8 mm of material`, and
that was true when written. `wall` was later slimmed 2.6 -> 2.2 and the hardcoded
1.8 did not follow, so the skin silently halved to **0.4 mm — one extrusion line**,
half of what had already failed at `snap_skin`. A comment claiming a 2.6 wall
sitting in a case whose wall is 2.2 is the whole trail. A depth *into* a wall is a
function of that wall; writing it as a literal is what let the two drift apart.
`exp_relief` is now `wall - exp_skin`, with an assert that fires if a future wall
cannot give both plug clearance and a printable skin.

Deriving it also produced **the fourth forward-reference in this file**: `wall` is
defined ~200 lines below the other `exp_*` constants, so `exp_relief = wall -
exp_skin` written beside them evaluated to `undef` and the pocket vanished for the
wrong reason. Caught by grepping the build for `WARNING` as well as `ERROR` — the
same habit that caught the third. The derivation now sits immediately after `wall`.

Verified by fault injection rather than by looking: a probe counting mesh vertices
inside the pocket's volume finds **64 with the gate removed and 0 with it in
place**. The first number is what makes the second mean anything — an earlier
version of that probe returned 0 for both, i.e. it was blind, and its "pocket is
gone" was worth nothing.

## The speaker grille, and the snap pockets that printed open

**The rectangular hole by the microphone was never a speaker port.** It is one of
four snap-catch pockets that the cover's barbs hook into, and they are meant to be
BLIND — `snap_skin` leaves wall on the outside so nothing shows. It printed open
because 0.8 mm is *exactly two extrusion lines* at a 0.4 nozzle, the width at which
a slicer either lays two perimeters or discards the feature; this one discarded it.
Now 1.1 (2.75 lines), which is over the threshold rather than sitting on it. The
ceiling is the barb, not printability: the catch shelf reaches 0.9 into a 2.2 wall,
so 1.1 leaves a 1.1 pocket — 0.2 of clearance, down from 0.5. If the cover stops
clicking home, raise `snap_win_extra`, never thin the skin back down.

**The same threshold caught a second feature, on the mic end — and finding it exposed a
fix applied to the wrong edge.** The four snaps sit two to each SHORT edge, and the mic
end's pair was at 0.30/0.70 → 0.42/0.58 to dodge a Ø9 RESET hole. The diagnosis was
right and the edit was on the opposite end: `wall/2` is the **mic** end, because the
device stands mic-end up and model +y therefore runs toward the physical bottom, so the
service edge is `out_h - wall/2` and never moved. The same commit also took RESET from
Ø9 to Ø6.0, which cleared the lip by 1.15 mm and made the whole thing moot — which is
why nothing ever failed and the asymmetry survived unnoticed.

It cost two things on the end that did not need it. **Retention:** barbs 9.5 mm apart in
the middle of a 59.4 mm edge, leaving that edge's corners least held — and it is the end
you grip to pop the cover and the end the kickstand levers against. **Printability:** the
body pocket is 8.8 mm wide against a 7.0 mm barb, so the pits sit *closer* than the barbs
do, and at 0.42/0.58 they left a **0.704 mm** rib between them — under the same 0.8 mm
that had already been discarded once. Merged, the catch shelf still runs unbroken and
both barbs still hook, so that half was cosmetic; the retention half was not.

Both ends are 0.30/0.70 again, and now measure identically off the STLs:

| | pits (body) | wall between pits | clips (cover) | clip spacing |
|---|---|---|---|---|
| mic end | 13.42–22.22, 37.18–45.98 | 14.96 mm | 14.32–21.32, 38.08–45.08 | 23.76 mm |
| service end | 13.42–22.22, 37.18–45.98 | 14.96 mm | 14.32–21.32, 38.08–45.08 | 23.76 mm |

**Nothing constrains these positions on either short edge**, and the near miss worth
recording is that the USB-C cutout looks like it should: it spans x 23.2–36.2 on the
service wall, straddling any inboard pair — but it sits at **z 5.1–12.1** while the
pockets are at **z 16.3–18.7**, so the two never meet. Reasoning about that edge in plan
view alone says the opposite. Check z before believing it.

## Eight snaps: the long edges had nothing holding them

The four corner snaps hold the two ENDS. The two SIDES run **103 mm between them**, and
nothing pulled their mid-span down — which is exactly where a long snap lid gaps, and the
one place no end clip can reach. There are now two more on each long edge.

**At the third-points, not at 0.30/0.70.** The side is a beam already held at both ends,
so the third-points are the standard four-support spacing. It also buys clearance: at
`out_h/3` the lower pocket starts at y 31.6, and **the one obstruction on either long wall
is the Expand relief** at y 14.8–26.8 on the high-X wall. That relief tops out at z 15.9
against pockets at z 16.3 — 0.4 mm apart, *half* the 0.8 mm `snap_skin` already watched a
slicer discard — so a pocket over it would be the same defect a third time. Thirds clear
it by **4.8 mm**; 0.30/0.70 would have left 1.2. Both sides use the same y so the cover
cannot rack going in. (The mic channel and side port are on that wall too, but both are
`if (mic_ext)` and board 2 is false. The low-X wall is clear end to end.)

Measured off the STLs, all eight, each barb centred in its pocket with 0.9 mm a side:

| edge | pockets | barbs |
|---|---|---|
| mic end | x 13.42–22.22, 37.18–45.98 | 14.32–21.32, 38.08–45.08 |
| service end | x 13.42–22.22, 37.18–45.98 | 14.32–21.32, 38.08–45.08 |
| low-X side | y 31.57–40.37, 67.53–76.33 | 32.47–39.47, 68.43–75.43 |
| high-X side | y 31.57–40.37, 67.53–76.33 | 32.47–39.47, 68.43–75.43 |

The side pockets cut inward to x 5.5 / 53.9, clearing the battery (11.7–47.7) by 6.2 mm.

**THE SIDE BARBS ENGAGE DEEPER THAN THE END ONES, AND THAT IS A CONSEQUENCE OF THE LIP
CLEARANCE RATHER THAN A CHOICE.** The side lip runs `g` = 0.30 and the ends `gy` = 0.55,
so the side lip sits 0.25 mm closer to the wall and its barb reaches 0.25 mm further into
the pocket: **1.00 mm into a 1.10 mm pocket, 0.10 mm spare**, against 0.75/0.35 at the
ends. Positive, and deeper engagement is *wanted* on the edge that was gapping — but it is
thinner than the 0.2 mm the `snap_skin` note called comfortable, so if the sides bind
before the cover seats, raise `g` (which also loosens the side fit) or shorten the barb's
1.3 mm catch shelf. Do not thin `snap_skin`.

**Costs, accepted rather than overlooked.** Insertion force roughly doubles; the cover must
now be pressed **straight down** rather than hooked at one end and rotated in; and it is
harder to open. If it stops clicking home the knob is `snap_win_extra`, never `snap_skin`.

**`snaps()` carries an ANGLE now**, which is what made this a two-line change rather than a
second copy of the barb. Both loops used to derive rotation from `s[1] < out_h/2 ? 0 : 180`
— which cannot express an edge running along Y at all — and the cover went further,
*recomputing* its y from that same test and ignoring the one in the list. Now `(x, y)` is a
point on the wall centreline and the angle rotates into the barb's own frame, where local
−Y always points out of the case; everything downstream was already written in that frame.
The cover then steps inward by `wall/2 +` the lip clearance **for that axis** — a single
constant there would put every side barb 0.25 mm off its lip.

**The real port is a hex grille in the back cover**, and the cover is not a
preference — it is the only place the speaker fits. There is 3.1 mm between the
front slab and the board's front face against a ~4 mm speaker, 13.0 mm behind the
board, and the board would block a front port regardless.

Two numbers carry the whole design:

- **`spk_grille_d` is MODELLED, and carries `print_shrink`.** Model the Ø1.5 you
  want and it prints at Ø1.0; model Ø1.2 and it prints at Ø0.7 and closes into a
  solid patch. Modelling Ø2.0 is what yields 1.5. This is the trap that ruins most
  printed grilles.
- **The pitch is set by what the SLICER sees, not by open area.** At pitch 2.8 the
  wall between two modelled Ø2.0 holes is 0.8 — the identical two-line knife-edge
  that had just opened the snap pockets. 3.0 leaves 1.0 (2.5 lines). It costs 18
  holes and ~21% open instead of 22 and 26%, and being certain the holes stay
  separate is worth more than five points of open area.

The patch is the speaker's own 15 × 10 footprint, so double-sided tape seals right
around it and no hole shorts the front of the cone to the back. Its three
clearances — button guide sleeves either side, battery rib inboard, cover lip
outboard — are `assert`ed from the same constants the cover draws with, not
eyeballed off a render.

## The board is 102.0 long, not the drawing's 101.5

Measured with calipers on the actual board. The width was measured at the same time
and **does** match the drawing at 54.5, which is what makes this useful rather than
just a correction: the two together separate the board from the printer.

- The **width** fit error was the printer. The board is the size the drawing says, so
  a cavity that came out 0.5 small was the cavity shrinking. `print_shrink = 0.5`
  is right, and so is the Ø2.9 screw pilot derived from it (which prints ~2.4, about
  111% thread engagement for M3 — at 2.9 as printed it would be 18% and would strip).
- The **length** was the drawing being wrong about this unit. 102.0 against a stated
  101.50(PCB), i.e. outside any plausible ±0.2.

Had the width also measured 55.0, the opposite conclusion would have followed —
board oversize in both axes, printer innocent, and every shrink compensation
including the screw pilot would have had to come out. One caliper reading decided
between two models that differ by whether the screws hold.

`hole_ins_y` went to 3.40 with it: 1.8 mm from the board edge to the hole's edge,
plus the hole's own 1.6 radius. That agrees with the drawing's implied 3.50 to
within 0.1, so the two independent measurements corroborate each other.

The length change also uncovered a live defect. `in_h` was `board_h + 2*clr`, with no
`print_shrink` term, so the printed cavity ran at **half** the clearance `clr`
claimed — and against the real 102.0 board that came to **zero**. It read as correct
because `clr` was right there in the expression; the shrink was eating it one step
downstream. Both axes now carry the compensation explicitly, so setting slicer XY
compensation and zeroing `print_shrink` leaves each on its own nominal.


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

## Printed buttons instead of open holes

`cover_buttons = true` (default). The cover's holes shrink to a **sliding fit** on a stem
and a separate printed plunger rides in each, so nothing is open to dust and RESET/BOOT
stay pressable with the cover closed.

```
openscad -o stl/deckhand_b2_buttons.stl -D 'part="buttons"' deckhand_case_b2.scad
```

**A guided plunger, not a flexure pad in the cover — the span decides that.** The cover's
inner face sits 13.0 mm above the board's back, so even a short tactile leaves ~10.5 mm
to cross. A thin membrane carrying a 10 mm post is a long lever on a small hinge: it would
wobble sideways and fatigue. A stem in a sleeve is stiff at any length. (It was 15.5/13
before `batt_extra` went to 0 — a shorter span only makes the plunger the easier call.)

Shape is one cylinder through a disc. The **flange sits inside** the cover and is wider
than the hole, so the button cannot fall out; the board underneath stops it falling in.
A **guide sleeve** on the cover's inner face triples the bearing length — 2.0 mm of plate
alone would let a 4 mm stem cock over.

**To fit:** drop each button in **from the inside**, stem first through its guide hole,
before the cover goes on. Nothing to glue, nothing to align.

**To print:** stand it on the button top. The flange's underside is a 45° cone so the
whole part self-supports — no supports needed, though a brim helps, since it's ~22 mm tall
on a 4 mm footprint.

### Stopping the buttons rattling

A plunger has two motions, and they need different answers.

| motion | before | now |
|---|---|---|
| lateral slop / tilt | 0.20 mm per side, 4.6° | **0.10 mm per side, 2.3°** (`btn_guide_d` clearance 0.4 → 0.2) |
| axial free play | 0.6 mm | **0.3 mm** (`btn_rest_gap` 0.6 → 0.3) |

**The play is shrunk, never clamped, and that is a safety choice rather than a printing
one.** What returns this button is the tactile switch's own dome pushing it back out —
roughly 1 N — so friction in the guide must stay well under that. A stem tight enough
never to rattle is a stem that can **stay pressed**, and a stuck RESET on this board is a
device that looks bricked: it is the only way out of deep sleep.

`btn_rest_gap` can't go to zero either — that rests the stem on the switch, and the
tolerance stack (print, `btn_switch_h`, board seating) would sometimes press it.

**If a trace of rattle still annoys you, put a thin foam or silicone washer under the
flange.** It kills the play without adding friction to the sliding surface, and there's
already a foam sheet in this build for the battery.

### `btn_switch_h` is the one number still guessed — and it errs short on purpose

Everything else here is geometry; this is the board. **Too short and the button doesn't
reach** — annoying, obvious, one number to fix. **Too long and the plunger rests *on* the
switch and holds it down**: the device sits in permanent reset and looks bricked, on the
one board where RESET is the only way out of deep sleep.

So the default assumes **2.5 mm**, taller than a typical SMD tactile (1.5–1.9), because a
taller assumption makes a *shorter* stem. Measure the switch's height above the board's
back face and set it; the stem follows.

## A build that succeeded and lost the screw holes

Worth knowing, because it will happen again to whoever edits this file. `print_shrink`
was defined 400 lines *below* `screw_pilot`, which reads it. **OpenSCAD does not hoist**,
so `screw_pilot` evaluated to `undefined` and **the four pilots were never cut** — the
STLs built, rendered, and looked entirely right.

OpenSCAD reports this as a `WARNING` ("Ignoring unknown variable"), not an error, so a
build check grepping only for `ERROR:` sees a clean run. **Grep for `WARNING` too** — that
is what caught it, and the confirmation was crude but decisive: the body STL went
1156 KB → 1230 KB once the holes were actually being subtracted.

It is the third forward-reference in this file, after `mic_pcb_x0` and `btn_span`, and the
first to reach exported geometry. Derived values now sit immediately after what they
depend on.

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

## The battery is 46% of the thickness

**RE-MEASURED on the actual pack: 36 × 66 × 10 mm.** This file said 37 × 68.5 × 10 for
the whole port — inherited from board 1's pack, which it was assumed to match and does
not. Reported from a printed case as *"it can not hold battery, loose"*, and the pocket
being 1.0 mm wide and 2.5 mm long bigger than the cell is the reason: `batt_rib_gap`'s
0.6 mm per side was sitting on top of 1.25 mm per side of pack that was not there.
Fixing the nominal is what takes the slack out — the gap is untouched, and is still the
next knob if it needs more. Plan fit is still easy: 36 × 66 in a 55 × 103 cavity.

**`batt_extra` also went 2.5 → 0**, which is the other half of the same rattle and a
deliberate trade — see *Holding the battery without the retainer* below. It is what
takes the case from 24.4 mm to 21.9.

| | |
|---|---|
| front stack (recess + glass + PCB) | 6.9 |
| cavity (`batt_seat` 3.0 + cell 10 + swell headroom 0) | 13.0 |
| cover | 2.0 |
| **total** | **21.9 mm** |

Case structure is 11.9 mm of that. Every case parameter has already been trimmed as far
as it safely goes, and that work plus the swell headroom bought 6.5 mm — so **if this
ever needs to be thinner, the cell is the lever**, not the case:

| cell thickness | case |
|---|---|
| 10 mm (yours) | 21.9 |
| 6 mm | 17.9 |
| 5 mm | 16.9 |
| 4 mm | 15.9 |

Below 3 mm nothing improves: `comp_back` — the mated JST plugs standing off the back of
the board — becomes the floor at **14.9 mm**, and going under *that* means not plugging
anything in. (That crossover used to sit at ~4.5 mm and 14.1; with the swell headroom
gone the cell has to get thinner before `comp_back` takes over, and the floor itself is
unchanged plastic — it just no longer has 2.5 mm of air stacked on it.)

## Holding the battery without the retainer

The pack sits 9.9–19.9 above the front face and, since `batt_extra` went to 0, the
cover's inner face is at 19.9 too — flush with the pack's top — so it has **~0.6 mm of
slop around it and none above it**. Tape alone is the obvious answer and the weakest one:
it resists sliding, then peels under exactly the vibration it was meant to stop.

Instead the corral moved **onto the cover** — four short ribs at the middle of each side
of the battery's footprint (`batt_ribs`, on by default). They cost filament and nothing
else: no extra part to print, and no thickness, because they stand alongside the pack
rather than under it. They engage the pack's **upper edge**, not its whole side: a rib
standing 6 mm off the cover reaches down to 13.9, running alongside the pack's top
6.0 mm. That is up from 3.5 mm at the old 22.4 floor — closing the swell gap lengthened
the engagement for free, because the ribs are measured off the cover and the cover moved
toward the pack.

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

**They hold it in plane only — the cover now does the rest, and THAT IS WHY THE FOAM PAD
IS NO LONGER OPTIONAL.** At `batt_extra` 2.5 the pack had 2.5 mm to move toward the cover
and nothing stopping it, and the answer was already "fit a ~3 mm foam pad", i.e. fill the
gap with something compressible. At 0 the cover's inner face *is* the pack's top face, so
that pad has become the swell allowance rather than an anti-rattle nicety: a lithium
pouch swells in service, and a rigid cover bearing on a swelling cell is a hazard, not a
tight fit. Foam takes up the slack, compresses if the cell ever swells, and damps shock.
Ribs for sliding, foam for rattle and swell — what the retainer was doing, minus the part.

**If you fit no pad, put `batt_extra` back to 2.5.** That is the whole undo; every
downstream number (`cavity_d`, `z_floor`, `total_th`, the plunger stem) re-derives, and
the case returns to 24.4 mm.

`use_retainer = true` still brings the original corral back if you'd rather print it.

## Two things the measurements forced

**Both button holes are Ø6.0 — the same, because the buttons are the same.** An earlier
pass made RESET Ø9 and BOOT Ø5.5, on the argument that RESET is the only way back from
deep sleep and deserves the easier target. That was my asymmetry, not the hardware's, and
it does not survive the cavity being 13.0 mm deep: **both** holes are ~12.5 mm from their
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
