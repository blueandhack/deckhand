// ============================================================================
// Deckhand — pocketable case for the ESP32-2432S028 ("CYD") 2.8" board,
// a 3000 mAh LiPo and a small speaker.
//
// Mounting (the standard way, per the weather-station example):
//   * The BODY (front) carries 4 COLUMNS that rise to the board's back plane.
//     The board drops in screen-first, sits on the 4 column tops (aligned to
//     its 4 corner mounting holes) and is bolted down with 4 M3 screws — the
//     screws pass through the board holes and thread into nuts trapped at the
//     base of each column. The screen shows through the front window.
//   * The battery lies on the back of the board in the cavity behind it.
//   * The BACK cover SNAPS on (barbed lip) — no screws through the back.
//
// USB-C exits the TOP edge. RESET/BOOT are back-face holes. Rounded, soft
// edges. ~57 x 93 x 21 mm (board 51 x 87).
//
// Render:  openscad -D part="body|cover|section|all" ...
// ============================================================================

part = "all";
$fn = 72;

// ---------- Board (mm) — MEASURE YOURS AND EDIT ----------
// board_h measured 86.0 (not 87) — at 87 the cavity was ~1 mm long, so the board
// had play and the 4 columns sat ~0.5 mm off each mounting hole. EVERYTHING
// downstream (cavity, columns, window, USB-C wall, battery, retainer, cover)
// derives from these, so they all track automatically.
board_w = 51.0;  board_h = 86.0;  board_t = 1.6;
comp_back = 6.0;    // tallest parts on the PCB back (edge JST connectors)
batt_seat = 3.0;    // component height directly under the battery (ESP32 can)
glass_up  = 4.2;    // display glass/frame proud of the PCB front. This sets how far
                    // the board sits below the front face: the 4 support shoulders are
                    // (glass_recess + glass_up) - front_th = 4.6 mm tall. Raising it
                    // pushes the PCB deeper while leaving the glass at the same
                    // glass_recess, so the window + touch chamfer stay correct.
usb_up    = 3.4;    // USB-C connector height above the PCB back
glass_recess = 2.6; // display sits this far below the outer front face. This also
                    // sets the board's SUPPORT SHOULDER height (= glass_recess +
                    // glass_up - front_th): with glass_up 4.2 that's a 4.6 mm shoulder.

usb_at_top = true;

hole_ins = 3.6;     // inset of the 4 corner mounting holes from the board edges
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
                    // (kept small — a big taper on a thin pin leaves a point)

// Window = the ACTIVE display area (~44 x 58), not the full 50 x 69 glass, so
// the frame hides the black glass border. win_shift > 0 moves it AWAY from the
// USB-C end (the active area sits a few mm off-centre, away from USB-C).
win_w = 44.0; win_h = 58.0; win_dx = 0.0; win_shift = 3.0;
win_cham = 2.0;   // chamfer: the window's top edge flares this much wider all
                  // round (over the glass recess) so a finger can reach the edge

usb_w = 13.0; usb_h = 7.0; usb_dx = 0.0;   // roomy enough for the cable's overmold/handle
usb_z_off = 0.0;                 // shift the USB-C cutout toward the back (cover side).
                                 // 0 = cutout centred on the connector. It was 1.6, which
                                 // pushed the opening 1.6 mm deeper than the port, pinning
                                 // the port against the screen-side edge (it looked "high")
                                 // with all the slack below it. Negative moves it toward
                                 // the screen, positive toward the cover.
usb_cham  = 1.5;                 // USB-C opening flares this much wider all round
usb_cham_d = 1.2;                //   at the OUTER face, over this depth (funnels the plug in)
reset_dx = -12.0; boot_dx = 12.0; btn_in = 8.0; btn_d = 4.5;

// Battery is pushed toward the USB-C end, leaving a clear strip at the far end
// for the speaker (both sit BEHIND the board; the columns are in FRONT of it).
batt_w = 36.0; batt_h = 68.0; batt_t = 10.0; batt_dy = 14.0;
batt_extra = 5.5;   // headroom above the pack (it bulges + sits on components); also margin so
                    // the cover closes. This is the knob that sets TOTAL THICKNESS: raising the
                    // support shoulder pushes the board deeper, so trim the same amount here to
                    // keep the case the same depth (shoulder 4.1 -> 4.6 was paid for out of this).
// Speaker pocket: in the strip at the end opposite USB-C, centred. It's on an
// 85 mm lead so it can go anywhere that's clear on YOUR board — tweak spk_cx/cy.
spk_w = 17.0; spk_h = 10.0; spk_t = 4.0;
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
ks_lug_from = 15;  // pivot distance in from the USB-C (top) end
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
clr_w    = 0.0;     // board-to-wall clearance on the LEFT/RIGHT (X). Snug: the
                    // board measured 51 wide in a 52 cavity (1 mm loose), so
                    // this drops the sides to a zero-nominal fit. Bump to
                    // 0.1–0.15 if the board won't drop in on your printer.
wall     = 2.6;
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
cavity_d   = max(comp_back, batt_seat + batt_t + batt_extra);
z_floor    = z_pcb_b + cavity_d;            // inner face of the back cover
body_d     = z_floor;                        // body runs front face .. back opening
total_th   = body_d + cover_th;

// ---------- Plan geometry ----------
in_w = board_w + 2*clr_w;  in_h = board_h + 2*clr;
out_w = in_w + 2*wall;   out_h = in_h + 2*wall;
bx0 = wall + clr_w;  by0 = wall + clr;
bcx = bx0 + board_w/2;  bcy = by0 + board_h/2;

function holes() = [
  [bx0+hole_ins,         by0+hole_ins],
  [bx0+board_w-hole_ins, by0+hole_ins],
  [bx0+hole_ins,         by0+board_h-hole_ins],
  [bx0+board_w-hole_ins, by0+board_h-hole_ins],
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
ks_lug_y   = usb_at_top ? out_h - ks_lug_from : ks_lug_from;
ks_dir     = usb_at_top ? -1 : 1;          // leaf extends toward the far end
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

// snap positions: two barbs on each long side
function snaps() = [ [out_w*0.30, wall/2], [out_w*0.70, wall/2],
                     [out_w*0.30, out_h-wall/2], [out_w*0.70, out_h-wall/2] ];

// ============================================================================
// BODY (front) — window, walls, 4 columns, snap catches
// ============================================================================
module body(){
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
    // snap-catch windows in the walls (the cover barbs hook into these)
    // enlarged symmetrically about the original centre, so the catch position
    // (and therefore how the cover seats) is unchanged — only the opening grows
    for(s=snaps()) translate([s[0],s[1],body_d-3.2]) rotate([0,0, s[1]<out_h/2?0:180])
      translate([-4-snap_win_extra, -wall, -snap_win_extra])
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
    translate([c[0],c[1],z_pcb_f-0.01]){
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
module retainer(){
  t = 1.8;  h = retainer_h;  cap_h = 5.0;  fit = 0.6;
  r_cav = max(oc_r-wall, 2);                // the body cavity's corner radius (must match body())
  bx = (in_w-batt_w)/2;  by = batt_y0 - wall;
  bl = min(batt_h, in_h - by - 1.2);
  cyb = by;  cyt = by + bl;                 // corral bottom (speaker end) / top (USB-C end)
  spx = spk_px - wall;  spy = spk_py - wall;

  // Everything is TRIMMED to the body cavity's ROUNDED profile (inset by `fit`),
  // so the end caps get corner radii matching the body instead of square
  // corners — square corners jam on the cavity's radii and stop it seating.
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

module assembly(){
  color("DimGray") body();
  color("Tan") translate([wall,wall,z_pcb_b]) retainer();
  color([.82,.82,.85]) translate([out_w,0,total_th]) rotate([0,180,0]) cover();  // flipped onto the back
  color("SteelBlue") stand_placed();
  %translate([bx0,by0,z_glass]) cube([board_w,board_h,glass_up+board_t]);       // board+display
  %translate([wall+(in_w-batt_w)/2,batt_y0,z_pcb_b+batt_seat]) cube([batt_w,batt_h,batt_t]);
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
else if (part=="retainer") retainer();
else if (part=="section")  section();
else                      assembly();
