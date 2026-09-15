// Board 2's hero-render wrapper - hero.scad's twin, one `include` apart.
//
// It is a separate file rather than a flag because `include` takes a literal path:
// the case file cannot be chosen by a -D variable, so "which case" has to be picked
// by which wrapper OpenSCAD is handed. render-hero.py's --board does exactly that.
//
// Everything else - part="none" so the include's own dispatch stays a no-op, the
// opaque MAGENTA screen quad that render-hero.py locates by colour, the placements
// copied from assembly() - is hero.scad's, and the two assembly() modules those come
// from are line-for-line identical apart from b2's `if (mic_ext)` guard. Keep them
// in step; a difference here shows up as a product shot of a case nobody can print.
include <deckhand_case_b2.scad>

module hero(){
  color("DimGray")     body();
  color("Tan")         translate([wall,wall,z_pcb_b]) retainer();
  color([.82,.82,.85]) translate([out_w,0,total_th]) rotate([0,180,0]) cover();
  color("SteelBlue")   stand_placed();
  // The window cutout's own expression, so the screen cannot be a different size or
  // place than the hole it shows through.
  color([1,0,1])
    translate([bcx + win_dx - win_w/2, bcy + win_dy - win_h/2, z_glass])
      cube([win_w, win_h, 0.4]);
}

hero();
