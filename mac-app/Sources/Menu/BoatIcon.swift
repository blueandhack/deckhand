import Cocoa

// ---------------------------------------------------------------------------
// The menu-bar icon: an origami paper boat.
//
// Deliberately NOT the project's ship's wheel. The wheel is the mark - it is on
// the device's waiting screen, in the README hero and in the app bundle icon -
// and a mark carries identity, where a menu-bar glyph has to survive at 16px in
// one flat colour next to two dozen other glyphs. The boat is built for that
// job only, which is why it lives here and nowhere else in the repo.
//
// Coordinates are in a 100-wide boat space, y up, and the shape is three
// polygons: two sail triangles meeting at a vertical crease, and a trapezoid
// hull. THE CREASE IS THE WHOLE POINT - a single filled triangle over a hull
// reads as a generic sailboat, and the gap down the middle is what says folded
// paper. It is a proportion of the width rather than a fixed pixel, so it
// survives every size and both display scales.
let BOAT_W: CGFloat = 100
let BOAT_APEX_Y: CGFloat = 42        // top of the sails
let BOAT_SAIL_Y: CGFloat = -2        // sail feet, sitting on the flat gunwale
let BOAT_SAIL_HALF: CGFloat = 34
let BOAT_CREASE_HALF: CGFloat = 3.5  // half the fold gap
// THE UPTURNED TIPS ARE WHAT MAKE IT PAPER. A flat-topped trapezoid hull under
// two triangles renders as an ordinary sailboat - that was the first attempt,
// and it did. An origami boat's prow and stern rise ABOVE the gunwale, so the
// top edge is: tip, down to a flat gunwale under the sails, back up to the
// other tip.
let BOAT_TIP_Y: CGFloat = 8
let BOAT_TIP_HALF: CGFloat = 50
let BOAT_HULL_BOT_Y: CGFloat = -34
let BOAT_HULL_BOT_HALF: CGFloat = 28
// The gunwale is FLAT exactly where the sails land, so hull and sails touch
// without overlapping. That is not cosmetic: with no overlap the same three
// polygons stroke cleanly for the outline state, where an overlapping hull
// would draw the sails' feet as lines across its own interior.
let BOAT_MID_Y: CGFloat = (BOAT_APEX_Y + BOAT_HULL_BOT_Y) / 2

// Only two states ship, and `barBoatStyle` picks between them on whether a
// device is connected. A hull-only variant was tried for "stopped" and
// rejected: without the sails it reads as a bowl, not a boat.
enum BoatStyle { case solid, outline }

/// The boat's own colour, from the project logo's tile gradient (`docs/logo.svg`,
/// the midpoint of #4C9BE0 -> #12508F). It is the ONLY logo colour that survives
/// both menu bars, and that was measured rather than picked: against a dark bar
/// (#2A2A2A) and a light one (#F5F5F5) it scores **3.01 and 4.37**, so it clears
/// Apple's 3:1 non-text threshold on each. The alternatives all fail one side -
/// the deep blue #1B5FA6 drops to 2.21 on dark, the light #4C9BE0 to 2.72 on
/// light, and the cream #FBF4E9 to **1.00**, i.e. invisible, which is what killed
/// the obvious "cream sails, blue hull" two-tone: half the boat would disappear
/// depending on the wallpaper. Re-measure before changing this.
let DECK_BLUE = NSColor(srgbRed: 0x2F / 255.0, green: 0x76 / 255.0, blue: 0xB8 / 255.0, alpha: 1)

/// Colour is a CHOICE, defaulting to on. The monochrome template version is not
/// a lesser fallback - it is the only one that follows the system, so on a light
/// bar it is arguably the better icon, and which one a given wallpaper favours
/// cannot be decided from here (the black-boat episode in CLAUDE.md is exactly
/// that lesson). Same `object(forKey:) ?? true` reading as `BarPref`, for the
/// same reason: `bool(forKey:)` would ship this switched off.
var colourfulIcon: Bool { UserDefaults.standard.object(forKey: "colourfulIcon") as? Bool ?? true }

func deckhandPaperBoatImage(size: CGFloat, style: BoatStyle, colourful: Bool? = nil) -> NSImage {
    let colour = colourful ?? colourfulIcon
    let img = NSImage(size: CGSize(width: size, height: size), flipped: false) { _ in
        // Black for the template path: a template image is used as a MASK, so
        // what is drawn only has to be opaque - the colour is thrown away.
        (colour ? DECK_BLUE : NSColor.black).set()
        // Width-bound: the boat is wider than it is tall, so the horizontal
        // extent is what has to fit. 1px of inset keeps the hull corners off
        // the bar's edge.
        let k = (size - 2) / BOAT_W
        let cx = size / 2, cy = size / 2
        func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: cx + x * k, y: cy + (y - BOAT_MID_Y) * k)
        }
        func poly(_ pts: [CGPoint]) -> NSBezierPath {
            let p = NSBezierPath()
            p.move(to: pts[0])
            for q in pts.dropFirst() { p.line(to: q) }
            p.close()
            return p
        }

        let sailL = poly([P(-BOAT_SAIL_HALF, BOAT_SAIL_Y), P(-BOAT_CREASE_HALF, BOAT_SAIL_Y),
                          P(-BOAT_CREASE_HALF, BOAT_APEX_Y)])
        let sailR = poly([P(BOAT_SAIL_HALF, BOAT_SAIL_Y), P(BOAT_CREASE_HALF, BOAT_SAIL_Y),
                          P(BOAT_CREASE_HALF, BOAT_APEX_Y)])
        let hull = poly([P(-BOAT_TIP_HALF, BOAT_TIP_Y), P(-BOAT_SAIL_HALF, BOAT_SAIL_Y),
                         P(BOAT_SAIL_HALF, BOAT_SAIL_Y), P(BOAT_TIP_HALF, BOAT_TIP_Y),
                         P(BOAT_HULL_BOT_HALF, BOAT_HULL_BOT_Y),
                         P(-BOAT_HULL_BOT_HALF, BOAT_HULL_BOT_Y)])

        switch style {
        case .solid:
            sailL.fill(); sailR.fill(); hull.fill()
        case .outline:
            for p in [sailL, sailR, hull] {
                p.lineWidth = max(1, (size - 2) * 0.07)
                // Miter with a LOW LIMIT, which is neither of the two obvious
                // choices. A plain miter shoots a spike past the silhouette at
                // the sail apex and both hull tips - it read as a damaged shape.
                // Round fixes that but rounds the tips into soft lumps, and
                // folded paper is crisp. A miter limit bevels only the joins
                // sharp enough to spike and leaves the rest pointed.
                p.lineJoinStyle = .miter
                p.miterLimit = 2
                p.stroke()
            }
        }
        return true
    }
    // TEMPLATE IS WHAT STRIPS COLOUR, so a colourful icon is precisely an icon
    // that stops being one: as a template, macOS renders the shape in its own
    // menu-bar colour and ignores everything we chose (that is why setting
    // contentTintColor did nothing - see the note in `refresh`). The trade is
    // real and goes both ways: a template follows the system and can never clash
    // with a wallpaper, while a coloured one holds its own colour and therefore
    // has to be legible against BOTH bars on its own merits, which is what
    // DECK_BLUE was measured for. A coloured image also does not invert to white
    // while the menu is open and the item is highlighted; it sits on the
    // highlight tint instead, the way every other coloured menu-bar icon does.
    img.isTemplate = !colour
    return img
}
