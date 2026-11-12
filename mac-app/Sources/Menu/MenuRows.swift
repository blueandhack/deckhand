import Cocoa

// MARK: - The dropdown's rows (redesigned 2026-11-07)
//
// HOW IT IS READ decided its shape. Someone opens this menu to answer, in order:
// is it working; how much quota is left and when does it come back; who is waiting
// on me. So it is three SECTIONS under plain headers (the connection, then Claude
// and Codex usage, then Sessions), each row is ONE line where it used to be two,
// and every row puts its answer on the left and its "when" in a right-aligned
// column - the shape of a macOS menu with shortcuts, which is the menu everyone
// already knows how to scan. The explanations that used to sit on a second line
// ("9% elapsed, behind pace") moved into each row's tooltip: they teach once, and
// a teaching line on every row was half the menu's height.
//
// Before: 4 quota windows took 8 lines, labelled `5h`/`7d`/`CX 5h`/`CX 7d`, with no
// heading saying which service a row belonged to; the connection took three rows
// and printed the raw link id (`usb:Deckhand-C114`).

/// The right-hand column's position. One value for every row so the columns line
/// up across sections; wide enough that the widest left side (a 22-character
/// project name and its agent tag) never reaches it.
let MENU_RIGHT_TAB: CGFloat = 330
let F_HEADER = NSFont.systemFont(ofSize: 11, weight: .semibold)

/// A row with an answer on the left and a right-aligned note, by a real tab stop -
/// padding with spaces cannot align a proportional font.
func menuColumns(_ left: [(String, NSFont, NSColor)], _ right: [(String, NSFont, NSColor)] = []) -> NSAttributedString {
    let out = NSMutableAttributedString(attributedString: menuTitle(left))
    if right.contains(where: { !$0.0.isEmpty }) {
        out.append(NSAttributedString(string: "\t", attributes: [.font: F_BODY]))
        out.append(menuTitle(right))
    }
    let ps = NSMutableParagraphStyle()
    ps.tabStops = [NSTextTab(textAlignment: .right, location: MENU_RIGHT_TAB)]
    out.addAttribute(.paragraphStyle, value: ps, range: NSRange(location: 0, length: out.length))
    return out
}

/// A section header: the service or the list it heads, and a note on the right.
func menuHeader(_ title: String, note: String = "") -> NSAttributedString {
    menuColumns([(title, F_HEADER, .secondaryLabelColor)], [(note, F_SMALL, .secondaryLabelColor)])
}

/// A window by its LENGTH, in words: "5-hour", "Weekly", else "3-day" / "8-hour".
/// Claude's are fixed by the plan; Codex's come off the tick line.
func windowName(_ minutes: Int?) -> String {
    guard let m = minutes, m > 0 else { return "Usage" }
    if m == 10080 { return "Weekly" }
    return m >= 1440 ? "\(m / 1440)-day" : "\(m / 60)-hour"
}

/// One usage window on ONE line: name, bar (with its pace tick), percentage and
/// pace glyph on the left; when it resets on the right. `pct` nil is a window with
/// no current reading (it reset since the service last reported one). Returns the
/// row and its tooltip, which carries the sentence the old second line did.
func quotaRow(_ windowMin: Int?, _ pct: Int?, _ reset: Int?, stale: Bool, name named: String? = nil) -> (NSAttributedString, String) {
    // `named`: a row labelled by its GROUP and window ("Argon 7d", "C/GPT 5h") rather
    // than by the window alone. Ten columns, so every section's bars still line up.
    let name = named ?? windowName(windowMin)
    let label = (name.padding(toLength: 10, withPad: " ", startingAt: 0), F_MONO, NSColor.secondaryLabelColor)
    guard let pct else {
        return (menuColumns([label, ("   \u{2013}", F_MONO, .secondaryLabelColor)],
                            [("no reading since it reset", F_SMALL, .secondaryLabelColor)]),
                "\(name): no current reading. This window has reset since the service last reported its usage; it updates the next time you use it.")
    }
    let colour = quotaColour(pct: pct, stale: stale)
    let pace = stale ? nil : pacePct(resetInMin: reset, windowMin: windowMin)
    let trackColour: NSColor = stale ? .quaternaryLabelColor : .tertiaryLabelColor
    // THE NUMBER LEADS, and the bar follows it (a decision the pace checks hold):
    // the figure the row reports is where the eye lands, its qualifiers sit next to
    // it, and the bar is the context after. The pace glyph is in NEUTRAL ink - it
    // reports a comparison, not a level, and in the usage colour a red ▼ beside a
    // red 96% read as part of the alarm. A blank cell holds its place when there is
    // no pace, so the bars of every row start in the same column.
    var left: [(String, NSFont, NSColor)] = [
        label,
        (String(format: "%4d%%", pct), F_MONO_BOLD, colour),
        (" " + (pace == nil ? " " : paceGlyph(pct: pct, pace: pace)) + "  ", F_MONO, .secondaryLabelColor),
    ]
    for (text, role) in quotaBarRuns(pct, pace: pace) {
        left.append((text, F_MONO, role == .fill ? colour : role == .track ? trackColour : .secondaryLabelColor))
    }
    let right = reset.map { "resets in \(humanMinutes($0))" } ?? ""
    var tip = "\(name): \(pct)% used"
    if stale { tip += " - this reading is not current, so there is no pace" }
    else if pace != nil { tip += ". " + paceNote(pct: pct, pace: pace).prefix(1).uppercased() + paceNote(pct: pct, pace: pace).dropFirst() }
    if let r = reset {
        let at = Date().addingTimeInterval(TimeInterval(r * 60))
        let f = DateFormatter()
        f.dateFormat = r < 1440 ? "HH:mm" : "EEE HH:mm"
        tip += ".\nResets in \(humanMinutes(r)), at \(f.string(from: at))."
    }
    if pct >= 95 && !stale { tip += "\nAt or near the limit." }
    return (menuColumns(left, [(right, F_SMALL, .secondaryLabelColor)]), tip)
}

/// How long ago, from the host's seconds-since-local-midnight `actSec`. Sessions
/// older than a day have aged out of the list long before this could wrap.
func sessionAge(_ actSec: Int?) -> String? {
    guard let a = actSec, a >= 0 else { return nil }
    let c = Calendar.current.dateComponents([.hour, .minute, .second], from: Date())
    let now = (c.hour ?? 0) * 3600 + (c.minute ?? 0) * 60 + (c.second ?? 0)
    let ago = (now - a + 86400) % 86400
    return ago < 60 ? "just now" : humanMinutes(ago / 60)
}

/// ONE LESS than the host's own 40-character slice, and that is the whole trick.
/// A title arriving at exactly 40 is indistinguishable from one that was cut
/// there, so `clip` at 40 saw no overflow and left the hard mid-word cut on
/// screen ("...recommendations API wor"). Clipping one character shorter makes
/// every at-the-cap title go through the word-boundary path and end in an
/// ellipsis, which says "there is more" instead of looking like a typo.
let SESSION_TITLE_SHOW = 39

/// One session: status glyph, project and (for a non-Claude agent) its name on the
/// left, the state and how long it has been in it on the right, and what it is
/// about on a second line. Shape and word, never colour alone: ■ needs you, ○
/// waiting, ● working - the device's three states, in the host's urgency order.
func sessionTitle(_ r: SessionRow) -> NSAttributedString {
    let asking = r.status == "asking"
    let glyph = asking ? "\u{25A0}" : (r.status == "waiting" ? "\u{25CB}" : "\u{25CF}")
    let agent = r.agent == "cx" ? "Codex" : (r.agent == "ag" ? "Antigravity" : "")
    let age = sessionAge(r.actSec)
    let state: String
    switch r.status {
    case "asking": state = "needs you"
    case "waiting": state = "waiting" + (age.map { " \u{00B7} \($0)" } ?? "")
    default: state = r.status
    }
    let out = NSMutableAttributedString(attributedString: menuColumns([
        ("\(glyph)  ", F_BODY, asking ? .systemOrange : .secondaryLabelColor),
        (clip(r.name, 22), asking ? F_BOLD : F_BODY, .labelColor),
        (agent.isEmpty ? "" : "  \(agent)", F_SMALL, .tertiaryLabelColor),
    ], [(state, asking ? F_BOLD : F_SMALL, asking ? .systemOrange : .secondaryLabelColor)]))
    if !r.title.isEmpty {
        out.append(menuTitle([("\n     ", F_MONO, .secondaryLabelColor),
                              (clip(r.title, SESSION_TITLE_SHOW), F_SMALL, .secondaryLabelColor)]))
    }
    return out
}
