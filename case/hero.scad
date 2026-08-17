// Hero-render wrapper: the assembled case with a SOLID screen quad, for render-hero.py.
//
// Included with part="none" - the scad's documented no-op - so its own dispatch does
// not also render the default assembly on top of this one.
//
// Two deliberate differences from assembly() in deckhand_case.scad:
//
//  * The display is a real, opaque quad rather than assembly()'s `%` background
//    modifier. That modifier is right for checking clearances and wrong for a product
//    shot: it renders as a ghost, which is why the old preview_hero.png shows an empty
//    window.
//  * It is pure MAGENTA, which nothing else in the palette comes near. render-hero.py
//    finds the screen by looking for those pixels instead of re-deriving the camera
//    projection - so the composite cannot drift out of alignment when the camera, the
//    image size, or the case dimensions change. The colour never reaches the output;
//    every magenta pixel is replaced by the screenshot.
include <deckhand_case.scad>

module hero(){
  color("DimGray")     body();
  color("Tan")         translate([wall,wall,z_pcb_b]) retainer();
  color([.82,.82,.85]) translate([out_w,0,total_th]) rotate([0,180,0]) cover();
  color("SteelBlue")   stand_placed();
  // Sits at the glass plane, sized to the active area - the same expression body()
  // uses for the window cutout, so the screen cannot end up a different size or
  // place than the hole it shows through.
  color([1,0,1])
    translate([bcx + win_dx - win_w/2, bcy + win_dy - win_h/2, z_glass])
      cube([win_w, win_h, 0.4]);
}

hero();
