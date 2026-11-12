import Cocoa

/// What a cell of the bar IS, which is what decides its colour. Three cases, not
/// two: the fill and the track are the quantity, and the tick is a mark about a
/// different quantity entirely (where the clock has got to), so it must be able
/// to differ from BOTH rather than borrowing whichever it happens to sit in.
enum BarRole { case fill, track, tick }

/// The ten-cell fill, now with the pace tick in it.
///
/// THE TICK IS INSERTED BETWEEN CELLS, NEVER WRITTEN OVER ONE, and the first
/// attempt did the opposite - which the live host caught within a minute. At 1%
/// used the fill is a single cell and the pace was 3%, so the mark landed on cell
/// 0 and replaced the only ink in the bar: `▕░░░░░░░░░`, a bar that reads as
/// nothing used. That is precisely the claim the `filled == 0` rule below exists
/// to prevent, defeated by a mark drawn on top of it - and it would have been
/// invisible in review, because the arithmetic is right and only the LOOK is
/// wrong. Inserting costs one character of width and loses no fill information at
/// any percentage.
///
/// So a bar with a pace is 11 cells and one without is 10. That asymmetry is
/// deliberate: the alternative is padding the pace-less case with a blank to keep
/// the columns flush, and a blank in the tick's own position is exactly what a
/// tick at 0% would look like.
///
/// One marker, not two. U+2502 is a thin vertical in an otherwise empty cell, so
/// it reads as a LINE between two light-shade cells and as a NOTCH cut into a run
/// of full blocks - visible in both, without needing a second glyph to say which
/// side of the fill it fell on. That is a claim about a render, so it was looked
/// at: `--menu-preview`, light and dark.
/// SPLIT AT EVERY COLOUR CHANGE, so fill, track and tick can each be drawn in
/// their own colour. Returned as RUNS rather than one string because that is the
/// only way an attributed run can colour them apart - and all three need it, for
/// two separate reasons found the same way, by looking at a render:
///
/// The TICK, first: a mark inheriting the fill's colour was a red line among red
/// blocks, findable only as the notch its own cell's background makes. It means
/// "now", which is not a status, so it takes a neutral secondary grey against a
/// fill that may be red or orange.
///
/// The TRACK, second, and this one shipped: an earlier version split at the tick
/// ALONE and handed back three pieces, each of which could carry both `█` and
/// `░`. `quotaTitle` therefore drew every cell in the usage colour, which put the
/// empty track in that colour at 25% coverage immediately beside the fill at
/// 100%. Same hue, adjacent, no boundary - the bar read as one grey smear whose
/// end could not be located, and the tick was invisible inside it. Fill and track
/// differ in INK, not in shape (that is why `▰`/`▱` were rejected), and ink alone
/// is not enough separation when both are the same colour. `--pace-check` now
/// asserts by name that no run carries both.
///
/// THE FILL IS MEASURED IN EIGHTHS OF A CELL, not whole cells. With whole cells
/// the "any usage shows ink" rule below had to round 1% up to a full cell, so 1%
/// and 4% both drew exactly what 10% draws - a bar that overstated light usage by
/// up to ten times, and the first thing a person noticed on looking at it. The
/// last, partial cell is a LEFT eighth-block (U+258F..U+2589), the same family as
/// the full block, so 1% is a hairline and 5% half a cell. Resolution is 1.25%.
let BAR_EIGHTHS = ["", "\u{258F}", "\u{258E}", "\u{258D}", "\u{258C}", "\u{258B}", "\u{258A}", "\u{2589}"]

func quotaBarRuns(_ pct: Int, pace: Int? = nil) -> [(text: String, role: BarRole)] {
    var eighths = Int((Double(pct) / 100 * Double(BAR_CELLS * 8)).rounded())
    // Any usage at all must show ink: 1% rounding to an empty bar would read as
    // "none used", which is a different claim than "barely any". One EIGHTH is
    // enough to say it; a whole cell said 10%.
    if pct > 0 && eighths == 0 { eighths = 1 }
    eighths = max(0, min(BAR_CELLS * 8, eighths))

    // FULL BLOCK against LIGHT SHADE, not ▰/▱. The geometric pair renders at 11pt
    // as a faint dashed line where filled and empty are barely distinguishable -
    // checked against a render, not assumed. These two differ in ink, not shape,
    // which is why the colours above are load-bearing rather than decorative.
    var cells: [(text: String, role: BarRole)] =
        Array(repeating: ("\u{2588}", .fill), count: eighths / 8)
    if eighths % 8 > 0 { cells.append((BAR_EIGHTHS[eighths % 8], .fill)) }
    cells += Array(repeating: ("\u{2591}", .track), count: BAR_CELLS - cells.count)

    // A BOUNDARY, not a cell: 0% goes before the first and 100% after the last,
    // which is what makes the two ends of the window reachable at all. INSERTED
    // between cells, never written over one (see above).
    if let pace {
        let at = max(0, min(BAR_CELLS, (pace * BAR_CELLS + 50) / 100))
        cells.insert(("\u{2502}", .tick), at: at)
    }
    // Coalesce adjacent cells of one role. Grouping by ROLE, never by glyph, is
    // what keeps a run from spanning the fill boundary - and the tick is its own
    // role, so it always splits whatever it lands in.
    var out: [(text: String, role: BarRole)] = []
    for c in cells {
        if let last = out.last, last.role == c.role, c.role != .tick {
            out[out.count - 1].text += c.text
        } else {
            out.append(c)
        }
    }
    return out
}

// Menu text styling.
//
// Informational rows are DISABLED, which is the right semantics - no hover, not
// keyboard-focusable - and AppKit may composite a disabled row at reduced alpha.
// So a colour here can be dimmed by the system, and every threshold it marks is
// ALSO said in words and drawn in the bar. That is the device UI's
// colour-is-never-alone rule applying to the Mac side for the same reason.
let F_BODY = NSFont.menuFont(ofSize: 0)
let F_BOLD = NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)
let F_SMALL = NSFont.menuFont(ofSize: 11)
let F_MONO = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
/// The same face and size as `F_MONO`, heavier. Used for the one figure on a
/// quota row that the row exists to report, so it wins against the label naming
/// it and the bar giving it context - where before it was the same weight as
/// both and sat downstream of the bar, so the eye crossed the noise to reach it.
///
/// SF Mono holds one advance across weights, so this cannot break the column
/// alignment the `%3d` padding buys. That is a claim about a font rather than
/// about this code, so `--pace-check` measures it instead of trusting it.
let F_MONO_BOLD = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)

/// WHAT the bar is allowed to show, as user choices rather than as this file's
/// opinion. Every one defaults to ON and `object(forKey:) as? Bool ?? true` is
/// what makes that true of a fresh install too - `UserDefaults.bool(forKey:)`
/// returns FALSE for a key nobody has written, so reading it directly would ship
/// an app whose bar is blank until you go and switch three things on.
///
/// `onlyOffline` governs the two device-mirroring badges (usage, sessions) and
/// deliberately NOT the needs-input count: those two stand in for a screen that
/// is missing, while a prompt blocking your work is worth saying whether or not
/// the device is there to say it too.
enum BarPref: String, CaseIterable {
    case usage = "barShowUsage"
    // Its own switch, not folded into `usage`: someone who never runs Codex should
    // not have to give up Claude's figures to keep a third one out of the bar, and
    // the reverse. Defaults ON like the rest - a Mac with no Codex reading draws
    // nothing for it anyway (`cxPct` nil), so ON costs a non-Codex user no width.
    case codex = "barShowCodex"
    // Gemini's, from the Gemini app while it runs. Its own switch for the reason
    // Codex has one: someone who never uses Gemini should not give up the others.
    case gemini = "barShowGemini"
    case sessions = "barShowSessions"
    case asking = "barShowAsking"
    case onlyOffline = "barOnlyWhenOffline"

    var label: String {
        switch self {
        case .usage: return "Quota usage"
        case .codex: return "Codex usage"
        case .gemini: return "Antigravity usage"
        case .sessions: return "Waiting / working counts"
        case .asking: return "Needs-input count"
        case .onlyOffline: return "Only while no device is connected"
        }
    }
    var on: Bool { UserDefaults.standard.object(forKey: rawValue) as? Bool ?? true }
    func toggle() { UserDefaults.standard.set(!on, forKey: rawValue) }
}

/// True when a device-mirroring badge may show: switched on, and either the
/// "only while no device is connected" restriction is off or there is genuinely
/// no device. One function so usage and sessions cannot drift apart.
func barMirrorAllowed(_ pref: BarPref, _ s: HostStatus) -> Bool {
    pref.on && !(BarPref.onlyOffline.on && s.deviceConnected)
}

/// Filled when a device is actually connected, hollow when it is not - the icon
/// stands for the LINK, not for the process. It used to key off `running`, which
/// meant a host with no device on the other end drew the same solid boat as a
/// fully live one and left the difference to a tint that never reached the
/// screen (see `refresh`) - so the bar could not report the one fact it exists to
/// report. Shape is now the only carrier here, which is what the rest of this
/// file already demands of colour. Shared with --menu-dump for the same reason
/// `barCountLabel` is.
func barBoatStyle(_ s: HostStatus) -> BoatStyle { s.deviceConnected ? .solid : .outline }
