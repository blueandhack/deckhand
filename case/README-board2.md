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
and the USB-C cutout. **Four values in this design are not measured** (below), and all
four are checkable on this one part. Printing a 60 g body to discover the USB plug is
2 mm off-centre is the mistake it exists to prevent.

What to check, in the order that matters:

1. **Does the board drop onto the columns without forcing?** If not, the hole insets or
   `clr`/`clr_w` are wrong — not the column diameter.
2. **Does a USB-C plug seat squarely, with even gaps?** An off-centre gap is `usb_dx`;
   a plug that fouls the shell is `usb_w`/`usb_h`.
3. **Can a fingernail reach RESET and BOOT?** `reset_dx` / `boot_dx`.
4. **Is the mic port over the capsule?** That checks `mic_front_x`/`mic_front_side` and
   the `win_shift` datum assumption at once, since both reference the mic end.

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

## The four unmeasured values

No drawing in the vendor pack dimensions where things sit **along** the service edge, so
these are the only numbers here that are not from the outline. Defaults are deliberately
**conservative**: each opening is oversized rather than centred on a guess, so a wrong
offset shows as an off-centre gap instead of a part that will not assemble.

| parameter | default | what it is |
|---|---|---|
| `usb_dx` | 0.0 | USB-C centre, from the edge's centreline |
| `reset_dx` | −12.0 | RESET centre, same datum |
| `boot_dx` | +12.0 | BOOT centre, same datum |
| `mic_front_side` | +1 | which long edge the mic's 9.82 is measured from |

`mic_front_side` is a **sign, not a baked assumption**, for a reason board 1's file
records in its own words: the vendor's back-face photo *mirrors* left/right against this
model's X, which is referenced to the front — *"reasoning from `reset_dx` being negative
gave the wrong wall"*. The front cover photo puts the mic top-right, so `+1` is the
better guess; it is still a guess.

Also unresolved by choice: **the microSD slot is not opened**. This firmware contains no
SD code at all, so a slot opening is a dust path for a feature nothing uses. Open it when
something reads a card.

## What is NOT verified

**Nothing here has been printed.** Every part renders in OpenSCAD with no errors and the
front face was checked visually (window asymmetry correct, one mic port in the top bezel
right of centre, matching the vendor photo), but geometry that renders is not geometry
that fits. The coupon is the cheapest way to close that gap, and it is why it exists.
