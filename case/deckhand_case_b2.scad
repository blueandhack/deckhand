// ============================================================================
// Deckhand (BOARD 2) — pocketable case for the ES3C35P 3.5" ESP32-S3 board,
// a LiPo and a small speaker.
//
// A SIBLING of deckhand_case.scad, not a replacement: board 1's case is a
// working, printed design and is left alone. The geometry logic here - columns,
// snap lip, stand hinge, chamfers, the whole coordinate system - is board 1's,
// because it is proven. What differs is what BOARD 2 actually differs in.
//
// EVERY BOARD NUMBER BELOW IS FROM THE VENDOR OUTLINE DRAWING (spec.pdf p12),
// not measured off a unit and not inherited from board 1. Board 1's file says
// "MEASURE YOURS AND EDIT" because nobody had a drawing; here there is one, and
// the values it gives are exact where board 1's were guesses:
//
//   PCB           54.50 x 101.50 x 1.60
//   hole span     47.90 (across) x 94.50 (along)  -> Ø3.2, pad R2.80, corner R3.50
//   stack-up      total 10.00 = CTP 1.00 + LCD 2.20 + glue 0.50 + PCB 1.60 + SMD 4.70
//   glass         54.50 x 83.00, CENTRED (9.25 of bezel at each end)
//   active area   48.96 x 73.44, offset 11.40 from the mic end (NOT centred)
//   mic port      3.94 from the mic-end edge, 9.82 from a long edge, ON THE FRONT
//
// THREE THINGS ARE STRUCTURALLY DIFFERENT FROM BOARD 1, and they are the reason
// this is a redesign rather than new numbers in the old file:
//
//   1. NO EXTERNAL MIC MODULE. Board 1 carries a MAX4466 on its Expand
//      connector, which costs that case a module room in the retainer, a cable
//      channel, ribs and a side port. Board 2's mic is ON THE BOARD, facing
//      FORWARD, so all of that collapses to one hole in the front bezel.
//      Gated by mic_ext rather than deleted, so board 1's geometry stays intact
//      and readable in the diff.
//   2. TWO HOLE INSETS, not one. Board 1's holes sit a uniform 3.6 in; board
//      2's are 3.30 from the long edges and 3.50 from the short ones.
//   3. RESET IS LOAD-BEARING. Board 2 cannot wake from deep sleep by touch -
//      the S3's RTC GPIO set does not reach PIN_TOUCH_INT, so RESET is the ONLY
//      way back (see CLAUDE.md). On board 1 a hard-to-reach reset was
//      survivable; here a case that buries it makes the device look bricked.
//
// FOUR VALUES ARE NOT MEASURED and are marked UNMEASURED below. They are the
// positions of things along the service edge, which no drawing in the vendor
// pack dimensions. Print the coupon (part="coupon") before the body: it is a
// few grams and it checks exactly these.
//
// Mounting (the standard way, per the weather-station example):
//   * The BODY (front) carries 4 COLUMNS. The board drops in screen-first and
//     sits on the 4 column tops, aligned to its 4 corner mounting holes, then
//     4 M3 screws pass through those holes and thread STRAIGHT INTO THE PLASTIC
//     (board_screws / screw_pilot). The screen shows through the front window.
//
//     THIS TEXT WAS INHERITED AND WAS WRONG IN BOTH DIRECTIONS. It described
//     "nuts trapped at the base of each column" - there are no nut traps here or
//     in board 1's file, and the hinge's own comment explains why nobody wants
//     them ("a nut is 6.5 mm across corners, which is what forced the old 9 mm
//     knuckle and all the bulk"). Meanwhile the geometry it sat above said the
//     opposite: "The pins fix the board laterally, so no screws or nut traps are
//     needed" - locating pins, no screws at all. A header claiming a fastening
//     the model does not have is the third instance of this exact defect in this
//     file, after the RESET/BOOT holes and the stand's own description.
//   * The battery lies on the back of the board in the cavity behind it.
//   * The BACK cover SNAPS on (barbed lip) — no screws through the back.
//
// USB-C, RESET and BOOT all exit the SAME short edge - the "service edge".
// ~60.5 x 108.5 x 21 mm (board 54.5 x 101.5).
//
// Render:  openscad -D part="body|cover|retainer|stand|coupon|section|all" ...
// ============================================================================

part = "all";

// THE RETAINER IS OPTIONAL ON BOARD 2, and turning it off buys NOTHING in size -
// which is the point of saying so here rather than letting it look like a win.
// It is an open corral that LOCATES the battery and speaker inside the cavity;
// it sits within cavity_d, so it costs a print, never a millimetre. Off means
// the pack is held by tape instead of walls. The case is exactly as thick.
use_retainer = false;

// WITH THE RETAINER OFF, SOMETHING STILL HAS TO HOLD THE PACK. These are four
// short ribs on the COVER's inner face, at the middle of each side of the
// battery's footprint - a corral that costs filament and nothing else: no extra
// part to print, and no thickness, because they occupy the batt_extra headroom
// that already exists above the pack.
//
// They work on the pack's UPPER edge rather than its whole side. The cell sits
// 9.9..19.9 above the front face and the cover's inner face is at 22.4, so a rib
// standing batt_rib_h off the cover reaches down to 22.4 - batt_rib_h; at 6 that
// is 16.4, running alongside the pack's top 3.5 mm. Anything under 2.5 would
// merely graze its top face and locate nothing.
//
// THEY DO NOT HOLD IT DOWN, only in plane. The 2.5 mm of swell headroom is also
// 2.5 mm the pack can rattle in, and a rib cannot fix that without clamping a
// lithium pouch, which is the one thing not to do. Use a ~3 mm foam pad on the
// cover's inner face instead: it takes up the slack, compresses if the cell ever
// swells, and damps shock. Tape alone is worse than either - it resists sliding,
// which is what the ribs already do, and peels under the vibration it is meant
// to stop.
batt_ribs   = true;
batt_rib_h  = 6.0;   // how far a rib stands off the cover's inner face
batt_rib_t  = 2.0;   // rib thickness
batt_rib_l  = 14.0;  // rib length along the edge it guards
batt_rib_gap = 0.6;  // clearance to the pack, per side
$fn = 72;

// ---------- Board (mm) — MEASURE YOURS AND EDIT ----------
// board_h measured 86.0 (not 87) — at 87 the cavity was ~1 mm long, so the board
// had play and the 4 columns sat ~0.5 mm off each mounting hole. EVERYTHING
// downstream (cavity, columns, window, USB-C wall, battery, retainer, cover)
// derives from these, so they all track automatically.
// MEASURED 102.0 on the actual board, against the drawing's 101.50(PCB) - so the
// drawing is not describing this unit, or not to better than ~0.5. The width is
// still the drawing's 54.5 because nobody has put calipers on it: what was
// measured there was a FIT error, which is a different thing (see print_shrink).
board_w = 54.5;  board_h = 102.0;  board_t = 1.6;   // length MEASURED, width from the drawing
// The drawing specifies SMD 4.70 for the bare components, and that is NOT the
// number to build to: the 1.25 mm JST plugs on the battery/UART/I2C/Expand
// headers stand proud of their sockets once MATED, which the outline does not
// show. 6.0 keeps board 1's allowance for exactly that. It is also almost never
// the binding term - cavity_d takes the max against the battery stack, which is
// 18.5 - so this matters only for a build with no battery.
comp_back = 6.0;    // mated JST plugs, not the 4.70 bare-component spec
batt_seat = 3.0;    // component height directly under the battery (ESP32 can)
glass_up  = 3.7;    // EXACT: CTP 1.00 + LCD 2.20 + glue 0.50. This sets how far
                    // the board sits below the front face: the 4 support shoulders are
                    // (glass_recess + glass_up) - front_th = 4.6 mm tall. Raising it
                    // pushes the PCB deeper while leaving the glass at the same
                    // glass_recess, so the window + touch chamfer stay correct.
usb_up    = 3.4;    // USB-C connector height above the PCB back
glass_recess = 1.6; // SLIMMED from board 1's 2.6 (-1.0 mm). Display sits this far below the outer front face. This also
                    // sets the board's SUPPORT SHOULDER height (= glass_recess +
                    // glass_up - front_th): with glass_up 4.2 that's a 4.6 mm shoulder.

usb_at_top = true;

// TWO insets, because board 2's hole pattern is not square to its outline:
// 47.90 across 54.50 -> (54.50-47.90)/2 = 3.30, and 94.50 along 101.50 ->
// (101.50-94.50)/2 = 3.50. Board 1 had one number for both, which would put
// every column 0.2 mm off in one axis here - inside the Ø3.2 hole's slop, but
// wrong, and it compounds with pin_d if anyone raises that toward a real fit.
hole_ins_x = 3.30;  // from the LONG edges (across the width)
// 3.4, from the measured 1.8 mm edge-of-board to edge-of-hole plus the hole's own
// 1.6 radius. The drawing implies 3.50 on a 101.5 board; this is 3.40 on a
// measured 102.0, so the two agree to 0.1 and the hole SPAN comes out 95.2 rather
// than the drawing's 94.50. Well inside the slack between a Ø3.2 board hole and a
// Ø2.9 pilot, but taken from the board rather than the paper since the board is
// what the screws go through.
hole_ins_y = 3.40;  // from the SHORT edges (along the length)
hole_ins = hole_ins_x;  // kept so any board-1 expression still reads
col_d    = 7.0;     // mounting column diameter (the shoulder the board rests on)
// PIN into the board's ~3.2 mm mounting hole (as in example/weather_station_*.stl).
// Sized generously ON PURPOSE: all 4 pins engage at once, so pin-spacing error
// eats the clearance. Over the 78.8 mm span, typical FDM/PLA error (~0.3 %) is
// ~0.24 mm and small vertical pins print ~0.15 mm oversize — a "snug" 2.9 would
// simply bind and never seat.
// At 1.3 these are ASSEMBLY GUIDES, not locators: they let the board drop
// straight in and stop it rotating, but with +/-0.88 mm of play the CAVITY WALLS
// (+/-0.5 mm) are what actually hold the board's position. Raise pin_d toward 2.6
// if you'd rather the pins do the locating and your printer is well calibrated.
pin_d    = 1.3;
pin_lead = 0.3;     // conical lead-in at the tip so the board drops on easily

// ---------- This printer's dimensional error, measured ----------
// TWO SYMPTOMS, ONE CAUSE, so it is one named number rather than a fudge factor
// hidden in each feature. From printed coupons:
//   - the board would not seat: the cavity came out ~0.5 small on a 55.0 opening
//   - a Ø2.6 screw pilot would not take a 3 mm self-tapper wanting ~2.4
// Both are internal features, and both shrink because the extruded bead sits
// INSIDE the modelled boundary. 0.5 on an opening is 0.25 per surface, and the
// same 0.25 per side turns a modelled Ø2.6 bore into ~2.1 - which is exactly the
// interference that stopped the screws. One constant explains both.
//
// THE RIGHT PLACE TO FIX THIS IS THE SLICER, not here. Every slicer has an XY
// size compensation (Cura "Horizontal Expansion", PrusaSlicer/Orca "XY size
// compensation"): set it to +0.25 and EVERY part you print comes out right,
// including other people's. Compensating in the model corrects this one design
// and silently mis-sizes the next. It lives here because it is what makes the
// case fit today - so if you set the slicer, put this back to 0.
// DEFINED HERE, ABOVE ITS FIRST USE, AND THAT IS NOT COSMETIC. It lived in the
// "Fit / structure" block 400 lines below screw_pilot, which reads it - so
// screw_pilot evaluated to UNDEFINED and the four pilots were never cut. The STLs
// built and looked right; the holes simply were not there. OpenSCAD warns
// ("Ignoring unknown variable") but does not error, and a build filter grepping
// only for ERROR: sees nothing.
//
// That is the THIRD forward-reference in this file - after mic_pcb_x0's note and
// btn_span's - and the first one to reach exported geometry. The lesson is not
// "be careful": grep the build for WARNING as well as ERROR, which is what caught
// it, and put derived values immediately after what they depend on.
print_shrink = 0.5;   // measured, on a DIAMETER or an opening

// ---------- Screwing the board down (board 2) ----------
// The pins locate the board but do not HOLD it: lift the case and the board is
// resting on four shoulders with nothing above it but the cover. With screws it
// is fixed to the body and the cover becomes a lid rather than a retainer.
//
// M3 THREADING STRAIGHT INTO THE PLASTIC, no captive nut - which is this design's
// established pattern rather than a new idea: the stand hinge already does it,
// and its comment explains why ("a nut is 6.5 mm across corners, which is what
// forced the old 9 mm knuckle and all the bulk"). ks_pilot is 2.5 for the same
// M3, so this matches it. M3's 3.0 major clears the board's Ø3.2 holes.
//
// A screw REPLACES the pin - they want the same axis - so board_screws picks one
// or the other rather than adding to it.
board_screws = true;
// 2.6, opened from 2.5 after a print where the screws would not drive - and the
// small step is the point. 2.9 was tried first and is WRONG: engagement is
// (major - hole) / (major - minor), so Ø2.9 in M3 leaves ~18% of thread, which is
// why board 1's file warns that even 2.7 was "far too loose - the threads would
// strip". That trades a screw that will not go in for one that goes in and holds
// nothing, which is the worse failure because it looks like success.
//
// The right target is not the tap-drill table at all. A TAP DRILL ASSUMES A HOLE
// THE SIZE YOU ASKED FOR AND A CUTTING TAP; this is a thread-FORMING screw in
// thermoplastic, where the usual pilot is ~0.8 x major = 2.4 for M3. FDM bores
// print undersize by roughly 0.2 (the extruder path lies inside the circle and
// the melt pulls in), so a modelled 2.6 lands near 2.4 - the number actually
// wanted. Modelling 2.4 would print ~2.2 and be the interference fit that
// stopped the screws.
//
// Board 1's file already half-knew this: "If it drives too hard, open it to 2.6
// with a drill bit" - the same fix, applied by hand after every print instead of
// once in the model.
//
// So the pilot is stated as the size the bore must MEASURE, with the printer's
// shrink added on - rather than as a modelled number someone has to keep
// re-guessing. 2.4 is the ~0.8 x major that thread-forming into thermoplastic
// wants for M3; + print_shrink lands the printed bore there.
//
// A NOTE ON HOW THIS WAS GOT WRONG TWICE. First 2.5, from an M3 tap-drill table -
// wrong reference entirely, since a tap drill assumes a CUTTING tap and a hole
// the size you asked for. Then 2.9 was tried and talked back down to 2.6 using an
// engagement calculation - which assumed the printed hole equals the modelled
// hole, ignoring the very shrinkage the same paragraph had just invoked. 2.9 was
// right; the reasoning offered for it was not, and the reasoning against it was
// worse. Engagement is now computed on the PRINTED size, where it means something:
// 2.9 modelled -> 2.4 printed -> ~111% of thread, correct for forming in plastic.
//
// Column wall at 2.9 is (7.0 - 2.9)/2 = 2.05 mm, still thick enough not to split.
screw_pilot_target = 2.4;                        // what the bore must MEASURE
screw_pilot  = screw_pilot_target + print_shrink; // 2.9 modelled on this printer
// HOW DEEP, and the constraint is the FRONT FACE. The column is only
// z_pcb_f - front_th = 3.1 mm tall, which is one M3 diameter of engagement -
// marginal. Continuing the pilot down INTO the front slab buys another 1.2,
// giving 4.3 (~1.4 diameters), which is enough for a board that sees no load
// beyond its own weight. What it must never do is break through: screw_skin is
// the material left between the pilot's bottom and the outside of the front
// face, and at 1.0 that skin is under the screen bezel where a dimple would show.
screw_lead   = 0.6;  // conical lead-in at the column top, so the screw centres itself

// THE PILOT'S DEPTH FOLLOWS THE SCREW, rather than the screw having to suit a
// hardcoded depth - which is the way round that keeps being wrong. State the
// screw you actually have and the geometry adapts; screw_skin is DERIVED from it
// further down, next to z_pcb_b, because OpenSCAD does not hoist and this needs
// the board's back plane.
//
// The screw head lands on the board's back face at z_pcb_b, so the tip reaches
// z_pcb_b - screw_len and the pilot must go at least that deep. A screw that
// bottoms out looks exactly like a hole that is too small: it stops dead partway
// and no force helps. That symptom cost one print already, when the advice given
// was "M3 x 6 or 8" against 5.9 mm of usable space.
screw_len        = 6.0;  // the screw you HAVE. Measured: 6 mm, M3 self-tapping.
screw_tip_margin = 0.2;  // clear air past the tip, so it clamps rather than bottoms
screw_skin_min   = 0.6;  // least front-face material to leave; see the assert
                    // (kept small — a big taper on a thin pin leaves a point)

// Window = the ACTIVE display area plus a hair, not the full 54.50 x 83.00
// glass, so the frame hides the black border. Derived, not chosen: LCD_AA is
// 48.96 x 73.44 and LCD_VA 49.96 x 74.44, so 50.6 x 75.0 clears the VA by ~0.3
// all round and still lands ~2 mm inside the glass.
win_w = 50.6; win_h = 75.0; win_dx = 0.0;
// THE ACTIVE AREA IS NOT CENTRED ALONG THE LENGTH, which is worth checking
// rather than assuming. The GLASS is centred - 9.25 + 83.00 + 9.25 = 101.50
// exactly - but the AA sits 11.40 from the mic end, spanning 11.40..84.84, so
// its centre is 48.12 where the board's is 50.75. Hence 2.63 toward the mic end.
//   ASSUMPTION to check on the coupon: that the drawing's 11.40 is measured from
//   the MIC end. The mic sits 3.94 from its own edge inside a 9.25 bezel, so both
//   datums are at the same end - but if the window lands ~5.3 mm out, this sign
//   is why.
win_shift = 2.63;   // + = toward the mic end (away from the service edge)
win_cham = 2.0;   // chamfer: the window's top edge flares this much wider all
                  // round (over the glass recess) so a finger can reach the edge

// MEASURED on the board: the USB-C sits at the MIDDLE of the service edge, and
// the receptacle is ~9 wide x ~4 tall. usb_dx = 0 is therefore CONFIRMED rather
// than assumed, which is why the opening goes back to board 1's proven 13 x 7
// instead of the widened 14 x 7.5 it carried while the offset was a guess: the
// extra 2 mm of slop existed only to hide an offset error that does not exist.
// 13 x 7 around a 9 x 4 receptacle is not sloppy - the margin is for the CABLE's
// moulded boot, which is much bigger than the plug tongue.
usb_w = 13.0; usb_h = 7.0; usb_dx = 0.0;   // MEASURED: centred
usb_z_off = 0.0;                 // shift the USB-C cutout toward the back (cover side).
                                 // 0 = cutout centred on the connector. It was 1.6, which
                                 // pushed the opening 1.6 mm deeper than the port, pinning
                                 // the port against the screen-side edge (it looked "high")
                                 // with all the slack below it. Negative moves it toward
                                 // the screen, positive toward the cover.
usb_cham  = 1.5;                 // USB-C opening flares this much wider all round
usb_cham_d = 1.2;                //   at the OUTER face, over this depth (funnels the plug in)
// ---------- THE SERVICE EDGE: the four UNMEASURED values ----------
// USB-C, RESET and BOOT all leave the same short edge on board 2. No drawing in
// the vendor pack dimensions where along that edge they sit, so these are the
// only numbers here that are NOT from the outline - they are offsets from the
// edge's centreline, + toward one long edge. Defaults are deliberately
// CONSERVATIVE: each opening is oversized rather than centred on a guess, so a
// wrong offset shows as an off-centre gap instead of a plug that will not fit.
// part="coupon" prints just this edge - check it before the body.
// MEASURED: RESET one side of the USB, BOOT the other, each with about a 6 mm
// GAP from the port. Converted to a centreline offset rather than used raw -
// 6 mm centre-to-centre is geometrically impossible here (half the USB is 4.5
// and half a button is 3, so they would overlap), so the 6 is edge-to-edge:
//   4.5 (half USB) + 6 (gap) + 3 (half button) = 13.5
reset_dx = -13.5;   // MEASURED
boot_dx  =  13.5;   // MEASURED
// WHICH ONE IS ON WHICH SIDE DOES NOT AFFECT THE GEOMETRY, and that is worth
// stating because the answer is otherwise a coin flip: the board was described
// from one viewpoint and this model is referenced to the front, the same mirror
// that board 1's file records getting wrong ("reasoning from reset_dx being
// negative gave the wrong wall"). Here the two holes are symmetric about the
// centreline, so a mirror error swaps only WHICH HOLE IS WHICH - not where any
// hole is. It would make a printed label wrong, and nothing else.
// MEASURED as ~2 mm from the bottom edge to the button, converted to a CENTRE
// like every other offset here: the buttons are ~6 x 4, so 2 mm of gap plus half
// the 4 mm body puts the centre at 4. If your 2 was already to the centre, this
// is 2 mm too far in - it is the same edge-versus-centre ambiguity the 6 mm USB
// gap had, and the coupon shows it immediately.
btn_in = 4.0;
// TWO diameters, not one, and the asymmetry is the RESET argument made physical.
// The buttons measure ~6 x 4, so their actuators are ~3 - but the cover sits
// cavity_d BEHIND the board (18.5 with a battery fitted), so neither hole is
// finger-reachable at any sane diameter: they are tool holes. BOOT is a rare
// recovery action and a toothpick is fine. RESET is THE ONLY WAY BACK FROM DEEP
// SLEEP on this board, so it gets the biggest hole that still leaves a sane
// cover - enough for a pen tip, a nail at the rim, or a printed plunger later.
// See README-board2.md: this is the one place the design is knowingly awkward.
// ONE DIAMETER FOR BOTH, because the two buttons are physically identical and a
// case that treats them differently reads as a mistake rather than a decision.
//
// This replaced an asymmetry that was mine, not the hardware's: RESET was Ø9 and
// BOOT Ø5.5 on the argument that RESET is the only way back from deep sleep and
// so deserves the easier target. That does not survive the cavity being 15.5 mm
// deep - BOTH holes are ~15 mm from their button, so both are tool holes whatever
// their diameter, and 1.5 mm of extra hole buys nothing a pen tip notices. What
// it did buy was two different holes under two identical buttons.
//
// The ceiling is structural, not ergonomic: centred 4 mm from the board edge, a
// Ø9 hole leaves 0.1 mm of plate at its outer rim - a knife edge that prints
// badly and breaks. Ø6.0 leaves 1.6 mm, which is the biggest the rim will carry.
btn_d = 6.0;        // RESET and BOOT alike
// RESET IS THE ONLY WAY BACK FROM DEEP SLEEP ON THIS BOARD (the S3's RTC GPIO
// set does not reach PIN_TOUCH_INT, so no touch wake exists - CLAUDE.md). Board
// 1 could treat a stiff reset as a nuisance; here a case that makes it awkward
// makes the device look bricked.
//
// WHICH MATTERS MORE THAN IT SOUNDS, BECAUSE BOARD 1's CASE NEVER CUT THESE
// HOLES AT ALL. reset_dx, boot_dx, btn_in, btn_d and the derived btn_y are all
// declared in deckhand_case.scad and referenced by NOTHING - while that file's
// own header says "RESET/BOOT are back-face holes". Declared-but-unwired state
// whose comments claim it works is a defect this repo has paid for before. Here
// they are wired, in cover(), and the buttons are back-face because that is how
// they sit on the board: the TYPE-C exits the edge, the two tacts are on the PCB
// near it and press toward the cover.
btn_cham = 0.8;     // outward flare at the cover's outer face, so a nail can find it

// ---------- Printed plungers instead of open holes ----------
// With cover_buttons on, the cover gets a GUIDE hole and a separate printed
// button rides in it, so nothing is open to dust and RESET/BOOT stay pressable
// with the cover closed. part="buttons" prints the pair.
//
// A GUIDED PLUNGER, not a flexure pad in the cover, and the span decides that:
// the cover's inner face is 15.5 mm above the board's back, so even a short
// tactile leaves ~13 mm to cross. A thin membrane carrying a 13 mm post is a long
// lever on a small hinge - it would wobble sideways and fatigue. A stem in a
// sleeve is stiff at any length.
//
// Shape: one cylinder through a disc. The disc (flange) sits INSIDE the cover and
// is wider than the hole, so the button cannot fall out; the stem passes through
// the hole, stands btn_proud above the outer face to press, and reaches down to
// just short of the switch.
cover_buttons = true;
btn_stem_d   = 4.0;                    // the shaft
// 0.2 of clearance, halved from 0.4, which halves both motions a plunger has:
// lateral slop drops to 0.10/side and tilt from 4.6 to 2.3 degrees over the
// 5.0 mm of bearing (plate 2.0 + sleeve 3.0).
//
// NOT TIGHTER, AND THE REASON IS A SAFETY ONE RATHER THAN A PRINTING ONE. What
// returns this button is the tactile switch's own dome pushing it back out -
// roughly 1 N - so any friction in the guide has to stay well under that. A stem
// tight enough never to rattle is a stem that can STAY PRESSED, and a stuck RESET
// on this board is a device that looks bricked: it is the only way out of deep
// sleep. So the play is SHRUNK, never clamped. If a trace of rattle still annoys,
// a thin foam or silicone washer under the flange kills it without adding
// friction to the sliding surface - and there is already a foam sheet in this
// build for the battery.
btn_guide_d  = btn_stem_d + 0.2;       // hole in the cover: a sliding fit
btn_flange_d = btn_guide_d + 3.0;      // wider than the hole = captive
btn_flange_t = 1.2;
btn_proud    = 1.5;                    // how far the button stands above the cover
btn_sleeve_h = 3.0;                    // guide sleeve inside, so the stem cannot tilt
// 0.3, halved from 0.6: this IS the axial free play, so halving it halves the
// rattle. It cannot go to zero - that would rest the stem on the switch, and the
// tolerance stack (print, btn_switch_h, board seating) would sometimes make it
// press. Press travel needed is 0.3 + the switch's own ~0.25, against 1.5 of
// btn_proud available.
btn_rest_gap = 0.3;                    // tip sits this far above the switch AT REST

// UNMEASURED, and the one number that matters: how tall the tactile stands above
// the board's BACK face. Everything else here is geometry; this is the board.
//
// ERRING SHORT IS MANDATORY, NOT CAUTIOUS. Too short and the button does not
// reach - annoying, obvious, fixed by one number. Too long and the plunger rests
// ON the switch and holds it down: the device sits in permanent reset and looks
// bricked, on the one board where RESET is the only way out of deep sleep. So the
// default assumes a TALLER switch than typical SMD tactiles (1.5-1.9), because a
// taller switch means a shorter stem.
btn_switch_h = 2.5;

// ---------- Front-face microphone port (board 2 only) ----------
// The mic is ON THE BOARD, facing FORWARD, at 3.94 from the mic-end edge and
// 9.82 from a long edge (vendor drawing). It is inside the 9.25 bezel, so the
// port is a small hole in the front face - NOT the module room, cable channel,
// ribs and side port board 1 needs for its external MAX4466. That whole
// subsystem is switched off by mic_ext.
mic_ext = false;        // false = on-board front mic (board 2). true = board 1's module.
mic_front_x = 9.82;     // from a long edge (vendor)
mic_front_y = 3.94;     // from the mic-end short edge (vendor)
// WHICH long edge, as a sign rather than a baked assumption - board 1's file
// learned this the hard way for its Expand relief: "reasoning from reset_dx
// being negative gave the wrong wall", because the vendor's BACK-face photo
// mirrors left/right against this model's X, which is referenced to the FRONT.
// The cover photo (a FRONT view) puts the mic top-right, so +1 is the better
// guess - but it is a guess, and the coupon settles it in one print.
mic_front_side = 1;     // MEASURED: front face, TOP RIGHT -> +1 (high-X, mic end)
// THE TWO SOURCES DISAGREE BY ABOUT A MILLIMETRE, so the port is sized to cover
// both rather than to pick a winner. The vendor drawing dimensions 9.82 / 3.94;
// measuring by hand to a ~1 mm capsule gave 9 / 3. Both are credible - that gap
// is ordinary for eyeballing a tiny port - but a 2.2 port placed on one and
// wrong by 1 would be half-blocked. 3.0 covers the disagreement and is still a
// pressure port rather than a horn.
mic_front_d = 3.0;      // widened from 2.2 to absorb the two sources' ~1mm spread
mic_front_cham = 1.0;   // slight outward flare so it does not read as a pinhole

// ---------- Relief for the Expand-pin cable (the microphone lead) ----------
// clr_w is 0, so the board's long edges sit right against the walls. The mic plugs
// into the 4-pin "Expand" connector on the board's BACK face near one long edge,
// and the mated plug stands ~1.5 mm proud of the board edge - enough to stop the
// board seating. This is a shallow pocket in the wall's INNER face over that
// connector only; it does not go through, so the outside stays closed.
//
// Position derived from the board photo, scaled on the known 86 mm length: the
// connector sits ~18 mm in from the end OPPOSITE the USB-C.
//
// SIDE IS THE HIGH-X WALL, confirmed against the real board. Do not re-derive this
// from a photo of the board's back: that view MIRRORS left/right relative to this
// model's X axis, which is referenced to the front (screen) face. Reasoning from
// reset_dx being negative gave the wrong wall for exactly that reason.
exp_side  = 1;     // -1 = low-X wall, +1 = high-X wall
exp_from_far = 18.1; // connector centre, in from the non-USB end
exp_w     = 12.0;  // pocket width along the case length (generous for the cable)
exp_relief = 1.8;  // depth into the 2.6 mm wall, leaving 0.8 mm of material
exp_z_pad = 0.5;   // start just below the board's back plane so the edge is clear too
exp_top   = 4.0;   // wall left above the relief, so it doesn't notch the top rim
// Both wall channels get a SLOPED roof instead of a flat one. Two reasons, and the
// geometry is the same for both: closing their tops turned each ceiling into a flat
// 12 mm bridge printed face-down, which sags; and a ramp gives the mic capsule a
// lead-in so it cams itself outward into the channel instead of having to be lined up
// blind. 1.8 of depth over 2.4 of height is 37 degrees off vertical - well inside what
// prints unsupported. It cannot be much taller on the mic side: the capsule's top is at
// z 20.3 and the channel roof starts at 22.9, so the ramp has 2.6 to live in.
chan_slope = 2.4;
mic_chan_top = 4.0; // ...and the same above the mic channel. This closes the last notch
                   // in the top rim. The cost is that the capsule can no longer descend
                   // into the channel with the retainer: it has to enter from the cavity
                   // side, i.e. the module goes in pushed inboard and is then slid
                   // outboard into the channel. The room has 0.8 mm of X play, so if it
                   // will not seat, widen the room (mic_gap) or lower this to 0.   // start just below the board's back plane so the edge is clear too

// Battery is pushed toward the USB-C end, leaving a clear strip at the far end
// for the speaker (both sit BEHIND the board; the columns are in FRONT of it).
// MEASURED: 37 x 68.5 x 10. Plan fit is easy - 37 x 68.5 in a 54.5 x 102.5
// cavity. The 10 is still the single biggest term in the case's thickness (it is
// 41% of 24.4), so if this case ever needs to be thinner, that is the number to
// change: see the table in README-board2.md. It is a coincidence, and a
// convenient one, that this matches board 1's pack exactly.
batt_w = 37.0; batt_h = 68.5; batt_t = 10.0;
// DERIVED so the pack stays centred if it ever changes, rather than a literal
// that would quietly go off-centre the next time batt_h moves. (board_h - batt_h)
// / 2 puts it on the board's own centreline, and the board is centred in the
// cavity, so this centres it in both.
batt_dy = (board_h - batt_h) / 2;
// CENTRED, because the reason it was not is gone. Board 1 shifts the pack 5 mm
// off-centre "to clear the microphone, which now lives against that wall beside
// its Expand-pin connector" - that is the external MAX4466 module, and board 2
// has no such module (mic_ext = false), so there is nothing on that wall to
// clear. Another board-1 inheritance whose justification evaporated with the
// mic subsystem, like the retainer and the hinge end before it.
//
// Centring also spreads the margin evenly: 37 mm of pack in a 54.5 cavity leaves
// 8.75 each side, where the inherited offset left 3.75 on one and 13.75 on the
// other. The tight side was the one nearer the long-edge JSTs.
batt_dx = 0.0;
// SLIMMED 5.5 -> 2.5 (-3.0 mm), and deliberately NOT to the ~1.0 that would save
// another 1.5. This is headroom above a LITHIUM POUCH, which swells in service -
// a cover pressed against a swelling cell is a hazard, not a tight fit. 2.5 is
// the thinnest number that still leaves the pack somewhere to go. If you want
// the last 1.5 mm, get it from a thinner CELL, not from this.
batt_extra = 2.5;   // headroom above the pack (it bulges + sits on components); also margin so
                    // the cover closes. This is the knob that sets TOTAL THICKNESS: raising the
                    // support shoulder pushes the board deeper, so trim the same amount here to
                    // keep the case the same depth (shoulder 4.1 -> 4.6 was paid for out of this).
// Speaker pocket: in the strip at the end opposite USB-C, centred. It's on an
// 85 mm lead so it can go anywhere that's clear on YOUR board — tweak spk_cx/cy.
spk_w = 17.0; spk_h = 10.0; spk_t = 4.0;

// ---------- Microphone (MAX4466 module, carried by the RETAINER) ----------
// Stands VERTICALLY against the high-X wall - the same wall its cable plugs into -
// with the electret firing sideways through a port in that wall. Held in slots in
// the retainer, so the mic goes in with the insert rather than being fixed to the
// cover.
//
// The capsule stops at the wall's INNER face and does not nest into it. That is
// forced by assembly order: the retainer drops straight down into the body, so
// anything protruding into a side wall would collide on the way in. The 2.6 mm
// wall becomes a short acoustic channel instead, which an electret is perfectly
// happy with.
//
// Sizes measured off the module, with the header pins trimmed and leads soldered
// direct (~2.8 mm of joints under the board).
// PCB length (board only - the 4-pin header is NOT included; it stands outside the
// room's open end). Estimated at 16 from the photos of the real module against the
// printed room; the earlier 20.8 came from a module with the pins trimmed and read
// long. THIS is the number to correct if the room is still the wrong length - nothing
// else needs touching, because the capsule end is anchored (see mic_y1).
mic_l   = 16.0;
mic_w   = 13.8;   // PCB width  -> stands up the cavity (Z). Must clear the cover
                  // lip, which claims the top 4 mm of cavity depth at the perimeter.
// Board thickness the SLOT has to swallow - measured at ~3 mm, not the bare 1.6 mm
// FR4: the trimmed pins and solder on its back face are part of what goes in the slot.
// This drives the whole X chain, so widening it moves the module inboard by the same
// amount and eats into the battery clearance (1.0 mm left at the pad end, was 2.4).
mic_t   = 3.0;
// Extra allowance for solder proud of mic_t, AT THE PAD END ONLY - that is the only
// place there is any, and the room's inner wall is set back past it everywhere.
mic_under = 2.8;
mic_can_d = 10.0;
mic_can_h = 5.4;  // capsule height -> here it is a HORIZONTAL reach toward the wall
// Capsule centre, in from the PCB's far (high-Y) end. The PADS therefore face the
// LOW-Y end, i.e. back toward the Expand connector, making the cable run as short
// as this layout allows.
mic_can_from_end = 6.5;
mic_gap  = 0.4;   // clearance between the module and the room's walls, all round.
                  // The module SITS in the room - it is not gripped by it, exactly like
                  // the speaker in its pocket. An earlier revision pinched the board
                  // between a bump and a wall and had to be forced in.
mic_rib  = 1.8;   // slot wall thickness
mic_port_d = 5.0; // sound port through the side wall
// PCB low-Y end, retainer-local. Placed near the USB-C end: the board's Expand-side
// long edge carries no JST connectors for the first ~36 mm in from that end, so this
// is the only stretch of that edge with nothing to foul. 57 and not higher - the
// retainer's top end cap spans Y 82.5..87 at full width, and the capsule would
// otherwise sit on it.
// The board's FAR (capsule) end is the anchor, not its near end. The sound port is
// drilled on the capsule's axis, so if the length knob moved that end, every change to
// mic_l would walk the port off the capsule. Anchoring here means mic_l only opens or
// closes the pin end of the room.
mic_y1 = 77.8;
mic_y0 = mic_y1 - mic_l;
// Vertical channel in the side wall over the mic, 1.8 mm deep - the same trick as
// the Expand-pin relief. It buys 1.8 mm of clearance from the battery AND, because
// it runs full height to the back opening, the capsule can drop straight down into
// it. A blind pocket could not be assembled: the retainer goes in vertically.
mic_relief = 1.8;
mic_can_gap = 0.3; // air between the capsule's face and the channel floor. Without it
                   // the can bottoms dead on the wall, and any tolerance the wrong way
                   // pushes the whole module inboard, out of the slot.
// NO slot floor: the module rests directly on the board's back face, the same way
// the battery and the speaker do. Raise this if it won't sit flat - solder blobs at
// the board's bottom edge, or a component on the PCB underneath, are the two things
// that would stop it.
mic_floor  = 0.0;
// Nothing on the mic mount rises above retainer_h - same rule as everything else on
// the insert. An earlier version stood 17.6 so a lip could hook over the board's top
// edge; it wasn't needed. The board must rise ~10 mm to leave the room, and the cover
// sits well above its top edge, so the COVER is the backstop.
mic_pad_len = 7.0; // length of the module's pad/solder end. Used only by the preview
                   // ghost now: the room's inner wall is set back past mic_under for its
                   // whole length, so nothing has to step round the joints any more.
// Closed top, open bottom: what used to be a floor under the board is now a plate
// over it. The module loads from BELOW and the board's own back face closes the
// bottom, exactly like the battery corral and the speaker pocket.
// NOTHING here rises above retainer_h. The consequence is that the board POKES
// THROUGH the plate: it stands 13.8 tall on the PCB and the plate caps at 11.7, so
// the plate has a slot for it. Over the board's own length the plate is therefore
// only a pair of flanges on the wall tops - it earns its keep at the FAR END, past
// the board, where it crosses the slot uninterrupted. That crossing is the tie
// between the two walls, and the outer wall's only route back to the rest of the
// insert.
mic_roof_t = 1.6;   // plate thickness; its top face IS retainer_h
mic_win_pad = 0.6;  // clearance round the capsule's window in the outer wall
// The pin end of the room is left WIDE OPEN - no end wall, no plate over it. The module
// still has its 4-pin header, which stands ~7mm off the board edge in the board's own
// plane, and it is rigid: a closed end there is exactly what stopped the module going
// in. (The dimensions above were taken from a module with the pins TRIMMED and leads
// soldered direct; they are not, so the header needs somewhere to go.) The opening is
// the room's full section, so a DuPont shell on the pins clears it too.
mic_pin_open = true;
spk_cx = 0;      // speaker centre, X offset from board centre (+right)
spk_cy = 7.0;    // speaker centre, distance in from the far (non-USB) edge
retainer_h = 11.7; // retainer wall height (just corrals the pack; well under the cavity)
// Speaker-wire grooves: channels cut at board level through the retainer on
// BOTH sides, so the speaker lead runs flush from the pocket to the board's
// connector — whichever side it's on — instead of being pinched over the walls.
wire_w = 3.4; wire_h = 2.8;

// ---------- Fold-out kickstand (on the back cover) ----------
// BARREL HINGE. The cover carries two low BOSSES on the hinge line; the leaf is a
// tapered BLADE whose full-width rounded NOSE runs across them, notched to clear
// each boss — so the blade wraps the boss on BOTH sides (no side play) and the
// whole hinge line reads as ONE continuous barrel instead of mismatched lumps.
//
// Every part of the hinge is the same ks_barrel diameter, and the axis sits at
// exactly ks_barrel/2, so the nose is tangent to the cover: the blade folds
// FLUSH and sweeps out without ever touching the cover.
//
// One M3 cap screw per side threads straight into its boss (the plastic takes the
// thread) and clamps the blade — that sets the friction. No captive nut: a nut is
// 6.5 mm across corners, which is what forced the old 9 mm knuckle and all the
// bulk. Dropping it halves the barrel.
ks_open    = 0;    // preview deploy angle (0 = folded flat)
ks_gap     = 34;   // pivot spacing (centre-to-centre)
// Back to 15, near the edge - the collision that pushed this to 26 is gone now
// that the hinge is at the other END. A stand wants its pivot close to the edge
// it leans from; 26 was 11 mm of leverage given up to avoid a hole that is no
// longer anywhere near it.
ks_lug_from = 15;  // pivot distance in from the MIC (top) end
ks_barrel  = 8.2;  // barrel diameter — shared by the cover bosses AND the blade nose.
                   // Sized so the screw head can be BURIED in the blade's outer face
                   // with a 1.2 mm rim; at 7.0 the rim was 0.6 mm and would crack.
ks_boss_w  = 5.0;  // boss width along the axle
ks_ear_w   = 5.5;  // blade width outboard of each boss (holds the counterbore)
ks_head_d  = 5.8;  // M3 socket-cap head (5.5) + clearance
ks_head_h  = 3.2;  // head height (3.0) + a little, so it sits just below flush
ks_hgap    = 0.4;  // clearance between a boss face and the blade
ks_pilot   = 2.5;  // pilot hole in the boss — the M3 screw cuts its own thread.
                   // 2.5 is the standard M3 tap drill: ~92% thread engagement.
                   // (2.7 was far too loose — only ~55%, the threads would strip.)
                   // Boss wall is 2.25 mm here, thick enough not to split.
                   // If it drives too hard, open it to 2.6 with a drill bit.
ks_leaf_th = 3.0;  // blade thickness at the tip (it tapers from ks_barrel at the nose)

// ---------- Fit / structure ----------
clr      = 0.5;     // board-to-wall clearance along the LENGTH (Y, USB↔far end)
// FROM A PRINTED COUPON, which is the only reason this number is trustworthy:
// the board did not seat, short by about 0.5 mm across the width. clr_w is
// PER SIDE (in_w = board_w + 2*clr_w), so 0.25 widens the cavity by the 0.5 that
// was missing. If the 0.5 meant 0.5 PER SIDE, this is the one character to
// change - but 0.25 is the reading that matches "0.5 mm of error" measured
// across the whole board.
//
// Board 1 sets this to 0.0 and suggests "0.1-0.15 if the board won't drop in on
// your printer". 0.25 is past that, which is worth a second thought rather than
// a shrug: 0.5 mm over 54.5 is ~0.9% and large for FDM. See README-board2.md -
// if the printed cavity itself measures 54.0 rather than 54.5, the fix belongs
// in the slicer's XY compensation, where it corrects every part, not here where
// it corrects one.
// Board 1 runs a zero-nominal fit here and it is the right nominal: the board
// should sit against the walls. The 0.25 is not clearance, it is HALF of
// print_shrink - the compensation that makes the printed cavity land on nominal.
// Derived rather than typed, so it follows if print_shrink is ever re-measured
// or zeroed after setting slicer compensation.
clr_w    = print_shrink / 2;   // compensation, not clearance: see print_shrink
wall     = 2.2;     // SLIMMED from 2.6: -0.8 mm on BOTH footprint axes. Not lower -
                    // the snap barbs and the cover lip are cut into this wall, and
                    // below ~2 they stop holding.
front_th = 2.2;     // front face thickness
cover_th = 2.0;     // back cover plate
lip_h    = 4.0;     // cover lip depth — shared by cover() and the retainer risers
oc_r     = 7.0;
soft_r   = 1.6;

// ---------- M3 ----------
m3_clear = 3.4; m3_nut_af = 5.6; m3_nut_th = 2.6;

// ---------- Depth (front outer face z=0, +z toward back) ----------
z_glass    = glass_recess;
z_pcb_f    = z_glass + glass_up;
z_pcb_b    = z_pcb_f + board_t;             // column tops / board back
// Derived HERE and not with the other screw parameters, because it needs z_pcb_b
// and OpenSCAD does not hoist - a forward reference yields a silent undef, which
// this file has been bitten by before (see mic_pcb_x0's note).
screw_skin = z_pcb_b - screw_len - screw_tip_margin;
// A LONGER SCREW EATS THE FRONT FACE, and past a point it comes through the
// bezel. That must be loud rather than discovered on the glass, so it is an
// assert: at screw_len 6.0 the skin is 0.7, and 7.6 would reach zero.
assert(screw_skin >= screw_skin_min,
       str("screw_len is too long: the pilot would leave too little front-face ",
           "material. Use a shorter screw, or lower screw_skin_min deliberately."));
cavity_d   = max(comp_back, batt_seat + batt_t + batt_extra);
z_floor    = z_pcb_b + cavity_d;            // inner face of the back cover
// Plunger stem, derived: the clear span from the cover's inner face down to the
// top of the switch, less the rest gap.
//
// PLACED AFTER z_floor, AND THAT COST A BUILD. It first sat next to z_pcb_b -
// above z_floor's own definition - so it read undef and every part failed the
// assert below. OpenSCAD does not hoist, and this file already carries two notes
// saying so (mic_pcb_x0, screw_skin); writing a third one directly above the
// mistake did not prevent it. The assert did.
btn_span     = z_floor - z_pcb_b - btn_switch_h;
btn_stem_len = btn_span - btn_rest_gap;
assert(btn_stem_len > 0, "btn_switch_h is taller than the cavity: no room for a plunger.");
assert(btn_proud > btn_rest_gap + 0.4,
       "btn_proud is too small: pressing the button flush would not reach the switch.");
body_d     = z_floor;                        // body runs front face .. back opening
total_th   = body_d + cover_th;

// ---------- Plan geometry ----------
// The LENGTH takes print_shrink as a whole, where the width takes it halved -
// and that asymmetry is not a mistake, it is the two axes wanting different
// NOMINALS. The width's nominal is zero (board 1's fit: the board sits against
// the walls), so clr_w is pure compensation and is print_shrink/2 PER SIDE. The
// length's nominal is a real 0.5 per side, so it needs clr AND the compensation
// on top - print_shrink added once, because print_shrink is a whole-opening
// figure, not a per-side one.
//
// Without this the length quietly ran at HALF its stated clearance: modelled
// 103.0 printed as 102.5 against a 102.0 board, i.e. 0.25 a side while clr said
// 0.5. It read as correct because clr was in the expression - the shrink was
// eating it downstream. Zeroing print_shrink after setting slicer XY
// compensation now leaves BOTH axes on their nominal, which is the whole point
// of routing the compensation through one named constant.
in_w = board_w + 2*clr_w;  in_h = board_h + 2*clr + print_shrink;

// The ONE definition of where the mic module sits across the case: retainer-local X of
// the PCB's inner face. Both the slot and the preview ghost derive from it - they were
// separate expressions once, and drifting them apart is a silent misfit. It lives HERE,
// not up with the other mic_* params, because it needs in_w: OpenSCAD does not hoist,
// so referencing a variable defined further down the file yields a silent `undef` (it
// put the whole module at the origin and every clearance probe read as a collision).
//   joints 41.3..44.1 | PCB 44.1..47.1 | capsule 47.1..52.5 | channel floor 52.8
mic_pcb_x0 = in_w + mic_relief - mic_can_gap - mic_can_h - mic_t;
out_w = in_w + 2*wall;   out_h = in_h + 2*wall;
bx0 = wall + clr_w;  by0 = wall + clr;
bcx = bx0 + board_w/2;  bcy = by0 + board_h/2;

function holes() = [
  [bx0+hole_ins_x,           by0+hole_ins_y],
  [bx0+board_w-hole_ins_x,   by0+hole_ins_y],
  [bx0+hole_ins_x,           by0+board_h-hole_ins_y],
  [bx0+board_w-hole_ins_x,   by0+board_h-hole_ins_y],
];

usb_wall_y = usb_at_top ? out_h - wall/2 : wall/2;
btn_y      = usb_at_top ? by0 + board_h - btn_in : by0 + btn_in;
win_dy     = usb_at_top ? -win_shift : win_shift;   // + win_shift => away from the USB-C end
batt_y0    = usb_at_top ? by0 + batt_dy : by0 + board_h - batt_dy - batt_h;
// speaker centre, at the end OPPOSITE the USB-C edge
spk_px     = bcx + spk_cx;
spk_py     = usb_at_top ? by0 + spk_cy : by0 + board_h - spk_cy;
// USB-C cutout centre in Z (the connector sits toward the back of the board)
usb_z      = z_pcb_b + usb_up/2 + usb_z_off;
usb_outer_y = usb_at_top ? out_h : 0;      // outer face of the USB-C end wall
usb_in      = usb_at_top ? -1 : 1;         // direction pointing into the case

// kickstand: pivot near the USB-C (top) end so the leaf swings down the back
// THE HINGE GOES AT THE END OPPOSITE THE USB, which is the reverse of board 1's
// rule and is set by how the device STANDS: mic end up, service edge (USB, RESET,
// BOOT) down on the desk. So the pivot is at the TOP and the blade swings down
// and back to prop it, while the buttons and the cable stay at the bottom where
// a hand reaches them.
//
// This also DISSOLVES the lug/button collision rather than dodging it. An earlier
// pass here moved ks_lug_from 15 -> 26 to slide the lugs off the RESET hole, with
// arithmetic to prove the clearance - correct arithmetic solving the wrong
// problem, because both features were at the same end only because the hinge was
// at the wrong one. With the hinge at the top there is nothing to clear: the
// pivot returns to 15 (near the edge, where a stand wants its leverage) and the
// blade's tip lands at y 79.1 against buttons at 94.4 - 15 mm clear.
ks_lug_y   = usb_at_top ? ks_lug_from : out_h - ks_lug_from;
// Inverted with ks_lug_y above: the leaf now extends from the top pivot toward
// the USB end. Flipping one without the other points the blade off the case.
ks_dir     = usb_at_top ? 1 : -1;          // leaf extends toward the service edge
// Axis height = half the barrel, so the nose is TANGENT to the cover: the blade
// folds flush and clears the cover through the whole swing. Both sides derive
// from this one value, so the bores cannot drift apart (they did once, when the
// knuckle grew for a nut while the lug stayed hard-coded — the hinge wouldn't mate).
ks_bz      = ks_barrel/2;                  // axis height in the stand's own frame
ks_axle_z  = -ks_bz;                       // axis height outside the cover's outer face
ks_nose_hw = ks_gap/2 + ks_boss_w/2 + ks_hgap + ks_ear_w;   // blade nose half-width
ks_leaf_l  = out_h*0.60;

// ---------- helpers ----------
module rrect(w,h,r){ offset(r) offset(-r) square([w,h]); }
module rrect_c(w,h,r=2){ translate([-w/2,-h/2]) rrect(w,h,r); }
module soft_box(w,h,d,r,er){
  hull(){
    translate([0,0,er])       linear_extrude(d-2*er) rrect(w,h,r);
    translate([er,er,0])      linear_extrude(0.01)   rrect(w-2*er,h-2*er,max(r-er,0.5));
    translate([er,er,d-0.01]) linear_extrude(0.01)   rrect(w-2*er,h-2*er,max(r-er,0.5));
  }
}

// Snap-catch windows: the cover's barbs (7.0 wide x 0.9 tall shelf) hook into
// four windows in the body walls. They're horizontal holes in a vertical wall,
// so the top edge prints as a short bridge that SAGS — the printed opening comes
// out smaller than drawn and pinches the barb. snap_win_extra opens the window up
// all round to absorb that. Raise it if the cover still won't click home.
snap_win_extra = 0.4;
// ...and they are BLIND: snap_skin of wall is left on the OUTER face, so nothing shows
// from outside. They used to cut clean through, which put two visible holes in each end
// wall with the barb rattling around inside them. The barb's catch shelf reaches 0.9 mm
// into the wall's thickness, so it still hooks the pocket's bottom edge exactly as
// before - only the daylight is gone. The pocket's top edge is the same short bridge it
// always was, now with a skin above it. Set this to 0 to go back to open windows.
snap_skin = 0.8;

// snap positions: two barbs on each long side
// THE SERVICE-EDGE SNAPS MOVED INBOARD, 0.30/0.70 -> 0.42/0.58, because the
// button holes landed on top of them. At btn_in 4 the Ø9 RESET hole spans x
// 11.4..20.4 and the barb at 0.30 spans 14.2..21.2 - the hole would have eaten
// most of a snap, on the end that also just lost lip material to those same
// holes. 0.42/0.58 puts them at 24.7 and 34.2, inside the clear 20.4..38.5 gap
// between the two holes, barbs spanning 21.2..28.2 and 30.7..37.7.
// The MIC-end pair stays at 0.30/0.70: nothing is cut there, and spreading them
// wide is better retention where it is free.
function snaps() = [ [out_w*0.42, wall/2], [out_w*0.58, wall/2],
                     [out_w*0.30, out_h-wall/2], [out_w*0.70, out_h-wall/2] ];

// ============================================================================
// BODY (front) — window, walls, 4 columns, snap catches
// ============================================================================
module body_core(){
  difference(){
    // outer shell, open at the back
    soft_box(out_w,out_h,body_d,oc_r,soft_r);
    // interior cavity from the front-face-inner back to the opening
    translate([wall,wall,front_th]) linear_extrude(body_d) rrect(in_w,in_h,max(oc_r-wall,2));
    // display window — the active area is a true rectangle (right-angle corners).
    // Its top edge is CHAMFERED (flared outward over the glass recess): without
    // it the finger meets a vertical lip and can't reach the screen's edge.
    translate([bcx+win_dx, bcy+win_dy, 0]){
      // straight opening at the active-area size, through the whole face
      translate([-win_w/2,-win_h/2,-0.01]) linear_extrude(front_th+0.02) square([win_w,win_h]);
      // chamfer: outer face is win_cham wider all round, tapering to the active
      // area at the glass plane, so a fingertip slides down onto the screen edge
      hull(){
        translate([-(win_w+2*win_cham)/2, -(win_h+2*win_cham)/2, -0.01])
          linear_extrude(0.02) square([win_w+2*win_cham, win_h+2*win_cham]);
        translate([-win_w/2, -win_h/2, glass_recess])
          linear_extrude(0.02) square([win_w, win_h]);
      }
    }
    // USB-C in the end wall
    translate([bcx+usb_dx, usb_wall_y, usb_z])
      rotate([90,0,0]) linear_extrude(wall*3,center=true) rrect_c(usb_w,usb_h,usb_h/2.2);
    // USB-C chamfer: funnel the OUTER opening so the cable's overmold seats and
    // the plug guides in (matches the display-window chamfer)
    hull(){
      translate([bcx+usb_dx, usb_outer_y-usb_in*0.01, usb_z]) rotate([90,0,0])
        linear_extrude(0.02) rrect_c(usb_w+2*usb_cham, usb_h+2*usb_cham, (usb_h+2*usb_cham)/2.2);
      translate([bcx+usb_dx, usb_outer_y+usb_in*usb_cham_d, usb_z]) rotate([90,0,0])
        linear_extrude(0.02) rrect_c(usb_w, usb_h, usb_h/2.2);
    }
    // Microphone: a vertical channel in the high-X wall, then a small port through the
    // 0.8 mm left outboard of it.
    // BOARD 2's front mic port: straight through the front face at the vendor
    // coordinates, with a shallow outward flare. Placed off bx0/by0 like every
    // other board-referenced feature, so it tracks the board rather than the
    // shell - if clr/clr_w change, the port stays over the capsule.
    if (!mic_ext) {
      // THE MIC END IS THE END AWAY FROM USB-C, which is what the vendor's own
      // front photo shows (mic top-right, Type-C on the bottom edge). Tied to
      // usb_at_top like win_dy and btn_y rather than hardcoded, so flipping the
      // service edge moves the port with it instead of stranding it. Getting
      // this backwards puts the port over the far bezel - 93 mm from the
      // capsule - and the first build reads as a dead microphone.
      let (mx = mic_front_side > 0 ? bx0 + board_w - mic_front_x
                                   : bx0 + mic_front_x,
           my = usb_at_top ? by0 + mic_front_y
                           : by0 + board_h - mic_front_y) {
        translate([mx, my, -0.01])
          cylinder(d = mic_front_d, h = front_th + 0.02);
        // flare at the OUTER face only, so the wall keeps its thickness inboard
        translate([mx, my, -0.01])
          cylinder(d1 = mic_front_d + 2*mic_front_cham, d2 = mic_front_d,
                   h = mic_front_cham + 0.01);
      }
    }

    // BOARD 1 ONLY - the external module's cable channel and side port. Gated
    // rather than deleted so the diff against board 1 stays readable.
    if (mic_ext)
    // The channel stops mic_chan_top below the rim, so it leaves no notch in the top
    // edge. That is a deliberate trade: the capsule stands 1.5 mm proud of the cavity
    // wall, so with the channel closed at the top it can no longer ride down inside it
    // as the retainer is lowered - the module has to go in pushed inboard and then be
    // slid outboard into the channel. Set mic_chan_top to 0 to get the drop-in back.
    // What the channel does NOT need is the module's whole length - only the CAPSULE reaches past
    // the wall; the PCB clears it by 3.9 mm. Narrowing the channel to the capsule's own
    // span shrinks the visible notch from mic_l+2 to mic_can_d+2.
    let (cy  = wall + mic_y0 + mic_l - mic_can_from_end,
         cz  = z_pcb_b + mic_floor + mic_w/2)
      union(){
        let (ch_top = z_floor + 0.01 - mic_chan_top,
             ch_y0  = cy - mic_can_d/2 - 1.0,
             ch_w   = mic_can_d + 2.0){
          translate([out_w - wall, ch_y0, z_pcb_b - 0.5])
            cube([mic_relief, ch_w, (ch_top - chan_slope) - (z_pcb_b - 0.5)]);
          // sloped roof: full depth at the bottom of the ramp, flush with the wall's
          // inner face at the top, so there is no flat ceiling to bridge
          translate([out_w - wall, ch_y0 + ch_w, ch_top - chan_slope])
            rotate([90, 0, 0]) linear_extrude(ch_w)
              polygon([[0, 0], [mic_relief, 0], [0, chan_slope]]);
        }
        translate([out_w - wall + mic_relief - 0.01, cy, cz]) rotate([0, 90, 0])
          cylinder(d = mic_port_d, h = wall - mic_relief + 0.02);
      }
    // Expand-pin cable relief - see exp_* above. Cut from just under the board's back
    // plane, but it STOPS exp_top below the rim rather than running out through it. It
    // used to break the rim, which left a visible notch in the top edge of the wall.
    // Nothing has to descend into this one: the plug sits at board level (z 8.4..16.4,
    // far below), and it is pushed onto the header by hand, not lowered down a channel.
    // The mic channel below is the one that genuinely cannot be closed.
    let (exp_y = usb_at_top ? by0 + exp_from_far : by0 + board_h - exp_from_far,
         exp_x = exp_side < 0 ? wall - exp_relief : out_w - wall)
      let (ex_top = z_floor - exp_top, ex_y0 = exp_y - exp_w/2){
        translate([exp_x, ex_y0, z_pcb_b - exp_z_pad])
          cube([exp_relief, exp_w, (ex_top - chan_slope) - (z_pcb_b - exp_z_pad)]);
        // The taper always runs to zero at the wall's INNER face, which is the high-X
        // side of the cut on the +X wall and the low-X side on the -X wall.
        translate([exp_x, ex_y0 + exp_w, ex_top - chan_slope])
          rotate([90, 0, 0]) linear_extrude(exp_w)
            polygon(exp_side < 0 ? [[0, 0], [exp_relief, 0], [exp_relief, chan_slope]]
                                 : [[0, 0], [exp_relief, 0], [0, chan_slope]]);
      }
    // snap-catch windows in the walls (the cover barbs hook into these)
    // enlarged symmetrically about the original centre, so the catch position
    // (and therefore how the cover seats) is unchanged — only the opening grows
    // Cut from just inside the OUTER face (leaving snap_skin) inward past the wall,
    // rather than straight through it.
    for(s=snaps()) translate([s[0],s[1],body_d-3.2]) rotate([0,0, s[1]<out_h/2?0:180])
      translate([-4-snap_win_extra, -wall/2 + snap_skin, -snap_win_extra])
        cube([8+2*snap_win_extra, wall*2, 1.6+2*snap_win_extra]);
  }
  // 4 mounting posts, same idea as example/weather_station_*.stl: a col_d
  // cylinder rising to the board's FRONT face (the board rests on this
  // shoulder), topped by a pin_d LOCATING PIN that passes up through the
  // board's mounting hole and finishes flush with its back. The pins fix the
  // board laterally, so no screws or nut traps are needed.
  // NB: the shoulder tops out at z_pcb_f, NOT z_pcb_b — at z_pcb_b the column
  // filled the board's own thickness and pushed it board_t deeper than the rest
  // of the model assumed (which also ate cavity depth).
  for(c=holes()){
    translate([c[0],c[1],front_th-0.01]) cylinder(d=col_d, h=z_pcb_f-front_th+0.01);
    // The locating pin, ONLY when not screwing: a screw needs this same axis.
    if (!board_screws) translate([c[0],c[1],z_pcb_f-0.01]){
      cylinder(d=pin_d, h=board_t-pin_lead+0.01);                                  // locating land
      translate([0,0,board_t-pin_lead])
        cylinder(d1=pin_d, d2=pin_d-2*pin_lead, h=pin_lead+0.01);                  // lead-in taper
    }
  }
  // NB: no battery/speaker walls here — those live in the separate retainer
  // (part="retainer"), so the body has nothing floating and prints support-free.
}

// ============================================================================
// RETAINER (separate insert) — corrals the battery + speaker
// ============================================================================
// Drops into the cavity behind the board. The battery corral is OPEN top and
// bottom (no floor) so the pack nestles straight down onto the board's low
// centre components — it does NOT ride up on the tall edge JST connectors (the
// old solid-floor version bridged those and sat proud, jamming the cover).
//
// It's located by two full-width END CAPS that reach the body's TOP, BOTTOM and
// SIDE walls in the header-free end strips — a loose drop-in fit (no fiddly
// press-fit), yet it can't slide. The caps are flat panels: big first layer =
// strong bed adhesion, and they tie the thin corral walls rigid. They're short
// (cap_h) and sit well below the cover's lip, so the cover needs no notches and
// closes cleanly over the whole insert. Prints flat, no support.
// Microphone ROOM: a walled pocket the module sits in, open at the bottom and capped
// by a plate at the top - the same construction as the speaker pocket, and for the same
// reason. The module is not gripped by anything: it drops into the room, rests on the
// board's back face, and the plate's slot locates its top. Everything caps at
// retainer_h.
//   local X: joints 41.3..44.1 | PCB 44.1..47.1 | capsule 47.1..52.5 | channel floor 52.8
//   local Z: board 0..13.8 | capsule 1.9..11.9
// The room is sized to the module's WHOLE footprint, joints included - that is what lets
// the inner wall run straight for the full length instead of stepping round the solder.
// Two details are still forced:
//  - The outer wall carries a WINDOW for the capsule, which overhangs the board's outer
//    face by 5.4mm across the middle 10mm of its length. Its top edge bridges like any
//    printed doorway.
//  - The board POKES THROUGH the plate: it stands 13.8 tall and the cap is 11.7, so the
//    plate is slotted. The slot is what locates the board across the room.
module mic_slot(x_join){
  t    = mic_rib;
  ix0  = mic_pcb_x0 - mic_under - mic_gap;      // room interior, inner face
  ix1  = mic_pcb_x0 + mic_t + mic_gap;          // room interior, outer face
  iy0  = mic_y0 - mic_gap;
  iy1  = mic_y0 + mic_l + mic_gap;
  h    = retainer_h;
  can_y = mic_y0 + mic_l - mic_can_from_end;
  difference(){
    union(){
      // the ring of walls. Its inner wall overlaps the battery corral, which is both
      // how the room is tied in and why it needs no separate gusset.
      linear_extrude(h) difference(){
        translate([ix0 - t, iy0 - t]) square([ix1 - ix0 + 2*t, iy1 - iy0 + 2*t]);
        translate([ix0, iy0])         square([ix1 - ix0, iy1 - iy0]);
      }
      translate([ix0 - t, iy0 - t, h - mic_roof_t])
        cube([ix1 - ix0 + 2*t, iy1 - iy0 + 2*t, mic_roof_t]);
    }
    // the board's slot through the plate - this is what holds it upright. Cut only
    // over the board's OWN length, so the end walls keep their full tops.
    translate([mic_pcb_x0 - mic_gap/2, mic_y0 - 0.2, h - mic_roof_t - 0.01])
      cube([mic_t + mic_gap, mic_l + 0.4, mic_roof_t + 0.02]);
    // the capsule's window through the outer wall
    translate([ix1 - 0.5, can_y - mic_can_d/2 - mic_win_pad,
               mic_w/2 - mic_can_d/2 - mic_win_pad])
      cube([t + 1.0, mic_can_d + 2*mic_win_pad, mic_can_d + 2*mic_win_pad]);
    // the pin end: take away the whole end wall AND the plate above it, so the header
    // (and a DuPont shell on it) passes straight out. The plate is still carried by the
    // two side walls, and the room is still tied in through the inner wall's root.
    // Cut all the way to the board's own low-Y edge, not just to the room's interior:
    // stopping at iy0 left a 0.19mm sliver of the PLATE spanning the mouth, which is
    // invisible in a render and blocks the board outright.
    if (mic_pin_open)
      translate([ix0 - t - 1, iy0 - t - 1, -1])
        cube([(ix1 + t) - (ix0 - t) + 2, (mic_y0 + 0.01) - (iy0 - t - 1), h + 2]);
  }
}

module retainer(){
  t = 1.8;  h = retainer_h;  cap_h = 5.0;  fit = 0.6;
  r_cav = max(oc_r-wall, 2);                // the body cavity's corner radius (must match body())
  bx = (in_w-batt_w)/2 - batt_dx;  by = batt_y0 - wall;
  bl = min(batt_h, in_h - by - 1.2);
  cyb = by;  cyt = by + bl;                 // corral bottom (speaker end) / top (USB-C end)
  spx = spk_px - wall;  spy = spk_py - wall;

  // Everything is TRIMMED to the body cavity's ROUNDED profile (inset by `fit`),
  // so the end caps get corner radii matching the body instead of square
  // corners — square corners jam on the cavity's radii and stop it seating.
  // The mic slot is added OUTSIDE that trim: it's a `linear_extrude(h+1)`, i.e. a
  // hard cap at z=12.7, which silently shortened the tines and made any slot height
  // over 11.1 mm a fiction. The slot needs no rounded-profile trim anyway - at this
  // Y the cavity wall is straight, and the tines span local X 44.0..49.4, inside the
  // 50.4 limit.
  union(){
  // -0.4 so it OVERLAPS the corral wall rather than touching it: a coincident face is
  // a zero-thickness join, and the union came out as two separate shells.
  if (mic_ext) mic_slot(x_join = bx + batt_w + t - 0.4);
  difference(){
    intersection(){
      union(){
        // battery corral — closed ring, OPEN top & bottom (pack nestles onto the board)
        linear_extrude(h) difference(){
          translate([bx-t, by-t]) square([batt_w+2*t, bl+2*t]);
          translate([bx, by])     square([batt_w, bl]);
        }
        // TOP end cap — fills the USB-C-end strip, reaches the top + both side walls
        linear_extrude(cap_h) translate([0, cyt]) square([in_w, in_h-cyt]);
        // BOTTOM end cap — reaches the far + both side walls; OPEN under the
        // speaker (hole cut through) so it also rests directly on the board
        linear_extrude(cap_h) difference(){
          square([in_w, cyb-t]);
          translate([spx-spk_w/2, spy-spk_h/2]) square([spk_w, spk_h]);
        }
        // speaker pocket walls
        linear_extrude(h) difference(){
          translate([spx-spk_w/2-t, spy-spk_h/2-t]) square([spk_w+2*t, spk_h+2*t]);
          translate([spx-spk_w/2, spy-spk_h/2])     square([spk_w, spk_h]);
        }
        // END WALLS — rise from each end cap to the SAME height as the battery
        // corral wall (h), so nothing on the retainer stands proud. They ride
        // against the body walls over that full height, which stops the insert
        // tilting. They were once taller, reaching into the cover lip's
        // footprint, but that propped the cover open so its barbs never seated.
        // Split either side of centre to clear the USB-C connector at that end.
        for(seg = [[fit, 17-fit], [35, in_w-fit-35]])          // [x start, width]
          for(yy = [fit, in_h-fit-t])                          // both ends
            linear_extrude(h) translate([seg[0], yy]) square([seg[1], t]);
      }
      linear_extrude(h+1) offset(-fit) rrect(in_w, in_h, r_cav);
    }
    // SPEAKER-WIRE GROOVES on BOTH sides (board-level channel; leaves
    // cap_h - wire_h of cap bridging over it). Leg 1: out of the pocket to the
    // side; leg 2: along the side up to the clear gap beside the corral, where
    // the wire routes freely.
    for(gx = [3.0, in_w-3.0]){
      translate([min(spx,gx), spy-wire_w/2, -0.2])
        cube([abs(spx-gx), wire_w, wire_h+0.2]);
      translate([gx-wire_w/2, spy-wire_w/2, -0.2])
        cube([wire_w, (by+1)-(spy-wire_w/2), wire_h+0.2]);
    }
  }
  }
}

// ============================================================================
// COVER (back) — snaps on, retains the battery
// ============================================================================
module cover(){
  lip_in = wall - 1.0;                 // lip that slides into the body opening (lip_h is global)
  g  = 0.3;                            // lip clearance on the SIDES (width) — kept snug
  gy = g + 0.1;                        // lip clearance on the ENDS (length): 0.1/end extra
                                       // = 0.2 mm shorter, since the cover felt a touch long
  difference(){
    union(){
      // plate
      translate([wall-0.1,wall-0.1,0]) soft_box(in_w+0.2,in_h+0.2,cover_th,max(oc_r-wall,2),soft_r*0.5);
      // Guide sleeves for the printed buttons. The plate alone is 2.0 mm of
      // bearing for a 4 mm stem, which would let the button cock over; the
      // sleeve triples that. Inboard of the lip, so it does not foul it.
      if (cover_buttons)
        for (dx = [reset_dx, boot_dx])
          translate([bcx + dx, btn_y, cover_th - 0.01])
            difference(){
              cylinder(d = btn_guide_d + 2.0, h = btn_sleeve_h + 0.01);
              translate([0,0,-0.1]) cylinder(d = btn_guide_d, h = btn_sleeve_h + 0.3);
            }

      // Battery corral - see batt_ribs. Positioned off the SAME expression the
      // preview ghost and the retainer use, so all three agree by construction
      // rather than by three transcriptions of the same arithmetic.
      if (batt_ribs) {
        bxr = wall + (in_w - batt_w)/2 - batt_dx;   // pack's low-X edge
        byr = batt_y0;                              // pack's low-Y edge
        cxr = bxr + batt_w/2;  cyr = byr + batt_h/2;
        for (r = [
              // [x, y, sizeX, sizeY] - one rib at the middle of each side
              [bxr - batt_rib_gap - batt_rib_t, cyr - batt_rib_l/2, batt_rib_t, batt_rib_l],
              [bxr + batt_w + batt_rib_gap,     cyr - batt_rib_l/2, batt_rib_t, batt_rib_l],
              [cxr - batt_rib_l/2, byr - batt_rib_gap - batt_rib_t, batt_rib_l, batt_rib_t],
              [cxr - batt_rib_l/2, byr + batt_h + batt_rib_gap,     batt_rib_l, batt_rib_t],
            ])
          translate([r[0], r[1], cover_th - 0.01])
            cube([r[2], r[3], batt_rib_h + 0.01]);
      }
      // inner lip (straight wall; looser in the length direction via gy)
      translate([wall+g,wall+gy,cover_th-0.01])
        linear_extrude(lip_h) difference(){ rrect(in_w-2*g,in_h-2*gy,3);
                                            offset(-lip_in) rrect(in_w-2*g,in_h-2*gy,3); }
      // snap barbs — a wedge ROOTED into the lip's outer face (not floating): a
      // catch shelf that protrudes into the wall window, ramping up to flush at
      // the tip so it cams in with light thumb pressure on insertion
      for(s=snaps()) translate([s[0], s[1]<out_h/2 ? wall+gy : out_h-wall-gy, cover_th+lip_h])
        rotate([0,0,s[1]<out_h/2?0:180])
          translate([-3.5,0,0]) hull(){
            translate([0, -1.3, -1.6]) cube([7, 0.7, 0.9]);   // catch shelf: protrudes 1.3 mm into the
                                                              // wall window (was 1.0 — it let go too easily)
            translate([1,  0.0, -2.4]) cube([5, 1.0, 2.4]);   // solid root, embedded 1 mm into the lip
          }
      // kickstand hinge lugs on the OUTER face (z<0); each stand knuckle sits
      // just outboard of one of these and one M3 screw + nut per side is the pivot.
      // Built as a PEDESTAL (hull from the axle down into the cover plate): the
      // axle now stands ks_bz off the face, so a bare cylinder would float clear
      // of the cover instead of being attached to it.
      // Each boss is a rounded pad: a barrel at the axis blended down into the
      // plate. The base of the hull is a flat BLOCK that stops exactly at the
      // plate's inner face, so nothing punches through into the battery cavity.
      for(s=[-1,1]) translate([out_w/2+s*ks_gap/2, ks_lug_y, 0]) hull(){
        translate([0,0,ks_axle_z]) rotate([0,90,0]) cylinder(d=ks_barrel, h=ks_boss_w, center=true);
        translate([-ks_boss_w/2, -ks_barrel/2, 0]) cube([ks_boss_w, ks_barrel, cover_th]);
      }
    }
    // ---- RESET and BOOT, through the cover ----
    // Referenced to the BOARD (bx0/bcx, btn_y), not to the shell, so they track
    // the board if any clearance changes. z spans the whole plate plus slack.
    // CUT THROUGH THE LIP AS WELL AS THE PLATE, and that is forced by the 4 mm
    // offset rather than chosen. At btn_in 8 the holes sat well inboard; at 4
    // they land under the cover's lip ring, and a hole through the plate alone
    // would be BLOCKED by the lip standing over it - a hole you can see through
    // from outside and cannot push anything into. Height therefore spans plate +
    // lip. The cost is real: the lip's bottom run loses material at two places,
    // so that end holds slightly less. It is bought back by moving the snaps
    // (see snaps()), which is where the retention actually lives.
    // With cover_buttons the hole shrinks to a SLIDING FIT on the stem and a
    // printed plunger fills it; without, it stays the open Ø6 tool hole.
    for (dx = [reset_dx, boot_dx])
      translate([bcx + dx, btn_y, -0.01]) {
        d = cover_buttons ? btn_guide_d : btn_d;
        cylinder(d = d, h = cover_th + lip_h + btn_sleeve_h + 0.02);
        cylinder(d1 = d + 2*btn_cham, d2 = d, h = btn_cham + 0.01);
      }
    // pilot hole in each boss — the M3 screw threads straight into the plastic
    for(s=[-1,1]) translate([out_w/2+s*ks_gap/2, ks_lug_y, ks_axle_z])
      rotate([0,90,0]) cylinder(d=ks_pilot, h=ks_boss_w+2, center=true);
  }
}

// ============================================================================
// PREVIEW + SECTION
// ============================================================================
// ---- Fold-out kickstand blade (its own small print, pivots on the cover) ----
// A tapered BLADE: full-width rounded nose at the hinge (ks_barrel thick),
// sweeping down to ks_leaf_th at the tip. Notches in the nose straddle the cover's
// two bosses, so the blade grips each boss on both sides. One M3 cap screw per
// side threads into its boss and clamps the blade — that's the friction.
// PRINT-FRIENDLY: prints flat, blade-down, no support. The hull gives a single
// FLAT underside on the bed (the nose is tangent to that plane, not below it),
// the taper is all shallow overhang, and the bore is a TEARDROP so its top is a
// self-supporting point instead of a ceiling that sags into strings.
module stand(){
  R    = ks_bz;                             // nose radius = axis height
  hw   = ks_nose_hw;                        // nose half-width
  bore = m3_clear + 0.3;
  difference(){
    // one hull: rounded nose -> thin tip. Flat bottom at z=0 across the whole part.
    hull(){
      translate([0,0,R]) rotate([0,90,0]) cylinder(d=ks_barrel, h=2*hw, center=true);
      linear_extrude(ks_leaf_th) translate([0,-(ks_leaf_l-6)]) rrect_c(2*hw-12, 12, 5);
    }
    // notches straddling each cover boss (clearance on both faces)
    for(s=[-1,1]) translate([s*ks_gap/2, 0, R])
      translate([-(ks_boss_w/2+ks_hgap), -(R+2.5), -(R+2.5)])
        cube([ks_boss_w+2*ks_hgap, 2*(R+2.5), 2*(R+2.5)]);
    // TEARDROP axle bore through the nose
    translate([0,0,R]) hull(){
      rotate([0,90,0]) cylinder(d=bore, h=2*hw+2, center=true, $fn=36);
      translate([0,0,bore*0.7]) rotate([0,90,0]) cylinder(d=0.6, h=2*hw+2, center=true);
    }
    // COUNTERBORE in each outer face, so the screw head sits below flush and is
    // hidden — no head standing proud of the hinge
    for(s=[-1,1]) translate([s*(hw+0.01), 0, R]) rotate([0,-s*90,0])
      cylinder(d=ks_head_d, h=ks_head_h+0.01, $fn=36);
    // Finger pull (vertical hole -> clean, no overhang). Depth is taken from the
    // BARREL, not the tip thickness: the blade is a wedge, so at the hole's
    // nose-side edge it is thicker than ks_leaf_th and a ks_leaf_th-deep cut left
    // a thin membrane capping part of the hole. Over-cutting costs nothing here.
    translate([0,-(ks_leaf_l-9),-2]) cylinder(d=13, h=ks_barrel + 6);
  }
}
// place the folded/deployed leaf onto the cover's lugs (for preview). The inner
// translate drops the stand's bore onto the rotation axis (bore is at z=bz now).
module stand_placed(){
  translate([out_w/2, ks_lug_y, total_th + (-ks_axle_z)])   // at the lug axle, outside the back
    rotate([ks_dir>0 ? ks_open : -ks_open, 0, 0]) rotate([0,0, ks_dir>0?180:0])
      translate([0,0,-ks_bz]) stand();
}

// The MAX4466 module as fitted, for preview only: PCB on edge in the retainer's
// slot, capsule reaching into the side wall's channel, pads facing the low-Y end
// (toward the Expand connector).
module mic_module(){
  x0 = wall + mic_pcb_x0;
  z0 = z_pcb_b + mic_floor;
  translate([x0, wall + mic_y0, z0]) cube([mic_t, mic_l, mic_w]);
  translate([x0 - mic_under, wall + mic_y0, z0]) cube([mic_under, mic_pad_len - 1.0, 4.0]); // pins/solder
  translate([x0 + mic_t, wall + mic_y0 + mic_l - mic_can_from_end, z0 + mic_w/2])
    rotate([0,90,0]) cylinder(d = mic_can_d, h = mic_can_h);
}

// The screw pilots are subtracted from the WHOLE body, not from the columns, and
// that is why body_core exists. body() adds its mounting posts AFTER its own
// difference() block, as siblings - so a pilot cut inside that block would miss
// the columns, and one cut against a column alone would leave the front slab
// beneath it solid. Wrapping is the smaller change: the geometry above is
// untouched and this adds one subtraction over all of it.
module body(){
  difference(){
    body_core();
    if (board_screws)
      for (c = holes()) {
        translate([c[0], c[1], screw_skin])
          cylinder(d = screw_pilot, h = z_pcb_f - screw_skin + 0.01);
        // Lead-in at the column top. A thread-forming screw entering a blind hole
        // wants to walk before it bites, and it is being started through a board
        // hole 1.6 mm above, i.e. blind to the operator. The cone gives the tip
        // somewhere to centre itself.
        translate([c[0], c[1], z_pcb_f - screw_lead])
          cylinder(d1 = screw_pilot, d2 = screw_pilot + 2*screw_lead,
                   h = screw_lead + 0.01);
      }
  }
}

// ============================================================================
// PRINTED BUTTONS — part="buttons"
// ============================================================================
// One cylinder through a disc, x2. Printed STANDING ON THE BUTTON TOP, which is
// why the flange's underside is chamfered: at 45 degrees it self-supports, so the
// whole part prints with no supports at all. A brim helps - it is 18 mm tall on a
// 4 mm footprint.
//
// TO FIT: drop each button into the cover FROM THE INSIDE, stem first through its
// guide hole, before the cover goes on. The flange is wider than the hole, so it
// cannot fall out; the board underneath stops it falling in. Nothing to glue and
// nothing to align.
module button(){
  cham = (btn_flange_d - btn_stem_d) / 2;   // 45 degrees, so it self-supports
  rotate([180,0,0]) {                        // button top on the bed
    cylinder(d = btn_stem_d, h = btn_proud + cover_th + btn_sleeve_h);
    translate([0, 0, btn_proud + cover_th + btn_sleeve_h]) {
      cylinder(d1 = btn_stem_d, d2 = btn_flange_d, h = cham);      // self-supporting cone
      translate([0,0,cham]) cylinder(d = btn_flange_d, h = btn_flange_t);
      translate([0,0,cham + btn_flange_t]) cylinder(d = btn_stem_d, h = btn_stem_len);
    }
  }
}
module buttons(){
  for (i = [0,1]) translate([i * (btn_flange_d + 4), 0, 0]) button();
}

// ============================================================================
// FIT-TEST COUPON — print this BEFORE the body.
// ============================================================================
// It carries only the things that can be wrong: the four column positions (the
// two-axis hole inset), the board's outline in the cavity, the glass window's
// edge, and the service edge with its three UNMEASURED openings. Everything
// else - stand, snaps, battery pocket, cover - is omitted, so it is a few grams
// and a few minutes instead of a whole body.
//
// What to check, in the order that matters:
//   1. Does the board DROP ONTO the four columns without forcing? If not, the
//      hole insets or clr/clr_w are wrong - not the columns' diameter.
//   2. Does a USB-C plug seat squarely, with even gaps? An off-centre gap means
//      usb_dx; a plug that fouls the shell means usb_w/usb_h.
//   3. Can a fingernail reach RESET and BOOT? Those are reset_dx/boot_dx.
//   4. Is the mic port over the capsule? That checks mic_front_x/y AND the
//      win_shift datum assumption at the same time, since both are referenced
//      to the mic end.
coupon_keep = 26;   // how much of the case length to keep, from the service edge
module coupon(){
  intersection(){
    body();
    translate([-1, usb_at_top ? out_h - coupon_keep : -1, -1])
      cube([out_w + 2, coupon_keep + 1, total_th + 2]);
  }
}

module assembly(){
  color("DimGray") body();
  color("Tan") translate([wall,wall,z_pcb_b]) retainer();
  color([.82,.82,.85]) translate([out_w,0,total_th]) rotate([0,180,0]) cover();  // flipped onto the back
  color("SteelBlue") stand_placed();
  %translate([bx0,by0,z_glass]) cube([board_w,board_h,glass_up+board_t]);       // board+display
  %translate([wall+(in_w-batt_w)/2-batt_dx,batt_y0,z_pcb_b+batt_seat]) cube([batt_w,batt_h,batt_t]);
  if (mic_ext) color("DarkSlateGray") mic_module();
  color("SeaGreen") translate([spk_px-spk_w/2, spk_py-spk_h/2, z_pcb_b]) cube([spk_w,spk_h,spk_t]);
}
module section(){
  difference(){
    assembly();
    translate([bcx,-1,-1]) cube([out_w,out_h+2,total_th+2]);
  }
}

if      (part=="body")     body();
else if (part=="cover")    translate([0,0,cover_th]) rotate([180,0,0]) cover();
else if (part=="stand")    stand();
else if (part=="retainer") { if (use_retainer) retainer(); }
else if (part=="buttons")  buttons();
else if (part=="coupon")   coupon();
else if (part=="section")  section();
// A deliberate no-op, for `include`-based clearance probes: `include` re-runs this
// dispatch, so without it every probe silently unioned the whole assembly in and
// reported a collision no matter what was being tested.
else if (part=="none")     { }
else                      assembly();
