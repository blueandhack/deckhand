import Cocoa

// MARK: - The menu-bar item: what sits beside the boat, sized to fit
//
// WHY THIS WAS REDESIGNED (2026-11-07). It used to be one line of text -
// ` 19%▼  ·  41%▼   CX 100%  ·  62%▲ ■2 ○2 ●1` - MEASURED at 275pt with its own font. On a MacBook Pro every
// status item has to fit between the notch and the right edge (~650pt on a 14"), and
// when they do not, macOS HIDES the ones that overflow, silently. Measured on this
// Mac: the items to Deckhand's right already took ~1,220pt, so on the laptop's own
// screen a wide Deckhand item was the likeliest one to vanish. And `19%▼ · 41%▼` asked
// the reader to remember which number was which window.
//
// So the figures are STACKED: each service is a column with its 5-hour reading on top
// and its 7-day reading below, with a tiny row label - the layout system-monitor menu
// bar apps use, which halves the width and labels every number. And the item comes in
// four sizes (BarTier), chosen by the user or AUTOMATICALLY: Automatic starts smaller
// on a notched screen, steps down whenever macOS hides the item, and tries larger
// again only when the displays change or the Mac wakes (AppDelegate.checkBarFit).
//
// What each size keeps, most important last to go:
//   full     every quota column, the session counts (○ waiting / ● working), the
//            needs-input badge
//   compact  the quota columns and the badge (session counts are on the menu's rows)
//   minimal  the badge, and a quota column ONLY when it needs attention (80%+, or
//            burning faster than the clock)
//   icon     the boat alone, with a red dot on it while a session needs your answer
//
// Rules carried over from the text version, because they were right:
//  - shape carries meaning, never colour alone: ○ waits, ● works, and the badge is a
//    filled pill with a count. A zero is drawn as nothing, not as a 0;
//  - a stale reading keeps its digits (dimmed) and loses its pace mark, which is a
//    comparison against a clock that kept running while the number did not;
//  - a missing window is a DASH holding its row, never a gap - "62%" alone on the
//    top row would read as the 5-hour figure.
// One change: only ▲ (ahead of pace, the warning) is drawn in the bar. ▼ and ≈ are
// reassurance, and the menu rows and the tooltip still say them.

enum BarTier: Int, CaseIterable, Comparable {
    case icon = 0, minimal, compact, full
    static func < (a: BarTier, b: BarTier) -> Bool { a.rawValue < b.rawValue }
    var smaller: BarTier? { BarTier(rawValue: rawValue - 1) }
    var title: String {
        switch self {
        case .full: return "Full"
        case .compact: return "Compact"
        case .minimal: return "Minimal"
        case .icon: return "Icon only"
        }
    }
    var detail: String {
        switch self {
        case .full: return "Usage for every service, session counts, and the needs-input badge."
        case .compact: return "Usage and the needs-input badge."
        case .minimal: return "Only what needs you: the badge, and usage once it is high."
        case .icon: return "Just the boat. A red dot means a session is waiting for your answer."
        }
    }
}

/// The user's choice. `automatic` resolves to whichever tier fits.
enum BarSize: String, CaseIterable {
    case automatic, full, compact, minimal, icon
    var tier: BarTier? {
        switch self {
        case .automatic: return nil
        case .full: return .full
        case .compact: return .compact
        case .minimal: return .minimal
        case .icon: return .icon
        }
    }
    static var current: BarSize {
        get { BarSize(rawValue: UserDefaults.standard.string(forKey: "barSize") ?? "") ?? .automatic }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "barSize") }
    }
}

/// One figure. `pct` nil is the dash.
struct BarCell: Equatable {
    var pct: Int?
    var stale = false
    var ahead = false
    var text: String { pct.map { "\($0)%" } ?? "\u{2013}" }
    var needsAttention: Bool { !stale && ((pct ?? 0) >= 80 || ahead) }
}

/// One service's column: an optional tag ("CX"), two rows, and the rows' labels when
/// they are not already given by the Claude column beside it.
struct BarQuota: Equatable {
    var tag = ""
    var labels: [String]? = nil
    var top = BarCell()
    /// nil for a ONE-ROW column, drawn centred.
    var bottom: BarCell? = BarCell()
    /// Each row's window length, which decides its LABEL (see barModel).
    var windows: [Int?] = [WINDOW_5H_MIN, WINDOW_7D_MIN]
    var needsAttention: Bool { top.needsAttention || (bottom?.needsAttention ?? false) }
}

struct BarModel: Equatable {
    var quotas: [BarQuota] = []
    var waiting = 0
    var working = 0
    var asking = 0
    var dot = false
}

func barCell(_ pct: Int?, reset: Int?, window: Int?, stale: Bool) -> BarCell {
    guard let pct else { return BarCell() }
    let pace = stale ? nil : pacePct(resetInMin: reset, windowMin: window)
    return BarCell(pct: pct, stale: stale, ahead: paceGlyph(pct: pct, pace: pace) == "\u{25B2}")
}

/// What the bar shows at `tier`. Pure: the switches it reads are the Menu Bar
/// preferences, and the same function feeds the image, --menu-dump and the checks.
func barModel(_ s: HostStatus, tier: BarTier, previewing: Bool = false) -> BarModel {
    // `previewing`: the Settings window's size previews show what a size LOOKS
    // like, so they ignore "hide while a display is connected" - otherwise, with a
    // display plugged in, every preview was the same bare boat.
    let allowed = { (p: BarPref) in previewing ? p.on : barMirrorAllowed(p, s) }
    var m = BarModel()
    let asking = BarPref.asking.on ? s.asking : 0
    if tier == .icon { m.dot = asking > 0; return m }
    m.asking = asking

    if allowed(.usage), s.pct5h != nil || s.pct7d != nil {
        let stale = (s.quotaAgeSec ?? 0) > QUOTA_STALE_SEC
        m.quotas.append(BarQuota(tag: "",
                                 top: barCell(s.pct5h, reset: s.reset5h, window: WINDOW_5H_MIN, stale: stale),
                                 bottom: barCell(s.pct7d, reset: s.reset7d, window: WINDOW_7D_MIN, stale: stale)))
    }
    if allowed(.codex), s.cxPct != nil || s.cx2Pct != nil {
        let stale = (s.cxAgeSec ?? 0) > QUOTA_STALE_SEC
        m.quotas.append(BarQuota(
            tag: "CX",
            top: barCell(s.cxPct, reset: s.cxReset, window: s.cxWinMin, stale: stale),
            bottom: barCell(s.cx2Pct, reset: s.cx2Reset, window: s.cx2WinMin, stale: stale),
            windows: [s.cxWinMin, s.cx2WinMin]))
    }
    if allowed(.gemini), let g = GeminiGroup.primary(s.gemini) {
        // Antigravity's most-used Gemini allowance (GeminiGroup.primary), 5h over weekly
        // like the others - from its own quota summary, which names both windows, so
        // the pace is real too.
        let stale = (s.gmAgeSec ?? 0) > QUOTA_STALE_SEC
        let five = g.bucket("5h"), week = g.bucket("weekly")
        let cell = { (b: GeminiGroup.Bucket?) in
            barCell(b?.pct, reset: b?.reset, window: b.flatMap { geminiWindowMinutes($0.window) }, stale: stale) }
        if five != nil {
            // 5h over weekly; a missing weekly is a dash holding its row.
            m.quotas.append(BarQuota(tag: "AG", top: cell(five), bottom: cell(week)))
        } else if let only = week ?? g.buckets.first {
            // No 5h window: ONE row, labelled by the tooltip - not a dash in a "5h"
            // row that this group does not have. (Review finding.)
            m.quotas.append(BarQuota(tag: "AG", top: cell(only), bottom: nil, windows: [geminiWindowMinutes(only.window)]))
        }
    }
    if tier == .minimal { m.quotas = m.quotas.filter(\.needsAttention) }
    // ROW LABELS, decided once the columns are final. Claude's column always says
    // 5h/7d. Another two-row column BORROWS them - no labels of its own - only when
    // its windows ARE 5h and 7d and the Claude column is actually there; otherwise it
    // carries its own. (Minimal can drop the Claude column: found on --bar-preview,
    // where Codex was drawn with no labels at all. And a plan whose first window is
    // 7d must not sit in the row the Claude column calls "5h".)
    let claudeThere = m.quotas.contains { $0.tag.isEmpty }
    for i in m.quotas.indices where m.quotas[i].bottom != nil {
        let q = m.quotas[i]
        let label = { (w: Int?, fb: String) in codexWindowLabel(w, fallback: fb) }
        if q.tag.isEmpty { m.quotas[i].labels = ["5h", "7d"] }
        else if claudeThere && q.windows.count == 2
                    && (q.windows[0] ?? WINDOW_5H_MIN) == WINDOW_5H_MIN && (q.windows[1] ?? WINDOW_7D_MIN) == WINDOW_7D_MIN {
            m.quotas[i].labels = nil
        } else {
            m.quotas[i].labels = [label(q.windows.first ?? nil, "1"), label(q.windows.count > 1 ? q.windows[1] : nil, "2")]
        }
    }
    if tier == .full, allowed(.sessions) {
        // ○ waits, ● works - with the badge's ■ asks, the three PARTITION the list,
        // so no session is counted twice. Waiting outranks working: it is your move.
        m.waiting = s.sessions.filter { $0.status == "waiting" }.count
        m.working = s.sessions.filter { $0.status == "working" }.count
    }
    return m
}

/// The model as one line, for --menu-dump and the checks. Columns are bracketed,
/// rows separated by " / " - the text a person would read off the image.
func barText(_ m: BarModel) -> String {
    var parts: [String] = []
    for q in m.quotas {
        let cells: [(String?, BarCell)] = q.bottom.map { [(q.labels?[0], q.top), (q.labels?[1], $0)] } ?? [(nil, q.top)]
        let rows = cells.map { (l, c) in
            (l.map { "\($0) " } ?? "") + c.text + (c.ahead ? "\u{25B2}" : "")
        }
        parts.append("[" + (q.tag.isEmpty ? "" : "\(q.tag) ") + rows.joined(separator: " / ") + "]")
    }
    if m.waiting > 0 || m.working > 0 {
        parts.append("[" + [m.waiting > 0 ? "\u{25CB}\(m.waiting)" : "", m.working > 0 ? "\u{25CF}\(m.working)" : ""]
            .filter { !$0.isEmpty }.joined(separator: " / ") + "]")
    }
    if m.asking > 0 { parts.append("(\(m.asking))") }
    if m.dot { parts.append("\u{2022}") }
    return parts.joined(separator: " ")
}

let BAR_VALUE_FONT = NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .semibold)
let BAR_LABEL_FONT = NSFont.systemFont(ofSize: 7.5, weight: .medium)
let BAR_TAG_FONT = NSFont.systemFont(ofSize: 8.5, weight: .bold)
let BAR_GLYPH_FONT = NSFont.systemFont(ofSize: 6, weight: .regular)
let BAR_BADGE_FONT = NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .bold)

/// The boat and everything beside it as ONE image, laid out for a bar `height` tall.
/// Drawn by a handler, not baked: every colour is a SEMANTIC one resolved when AppKit
/// draws it, against the menu bar's own appearance, so it follows a light or dark bar
/// (and a wallpaper change) the way the old attributed title did.
func barImage(_ m: BarModel, boat: BoatStyle, colourful: Bool, height h: CGFloat) -> NSImage {
    typealias Op = (CGFloat) -> Void        // draws at x
    var ops: [(x: CGFloat, op: Op)] = []
    var x: CGFloat = 0
    let boatSize = max(14, min(18, h - 5))
    let boatImg = deckhandPaperBoatImage(size: boatSize, style: boat, colourful: colourful)
    let dot = m.dot
    ops.append((x, { x in
        let r = NSRect(x: x, y: (h - boatSize) / 2, width: boatSize, height: boatSize)
        boatImg.draw(in: r)
        if boatImg.isTemplate {
            // A template image draws black; the bar's own colour is laid over it.
            NSColor.labelColor.set()
            r.fill(using: .sourceAtop)
        }
        if dot {
            NSColor.systemRed.setFill()
            NSBezierPath(ovalIn: NSRect(x: r.maxX - 5.5, y: r.maxY - 6, width: 6, height: 6)).fill()
        }
    }))
    x += boatSize

    // Two rows: baselines placed so two lines of digits sit centred in the bar.
    let cap = BAR_VALUE_FONT.capHeight, gap: CGFloat = 2.5
    let base0 = ((h - (2 * cap + gap)) / 2).rounded()     // bottom row
    let base1 = base0 + cap + gap                          // top row
    func size(_ s: String, _ f: NSFont) -> CGFloat { (s as NSString).size(withAttributes: [.font: f]).width }
    func draw(_ s: String, _ f: NSFont, _ c: NSColor, x: CGFloat, baseline: CGFloat) {
        (s as NSString).draw(at: NSPoint(x: x, y: baseline + f.descender), withAttributes: [.font: f, .foregroundColor: c])
    }

    for q in m.quotas {
        x += 7
        if !q.tag.isEmpty {
            let w = size(q.tag, BAR_TAG_FONT), tag = q.tag
            ops.append((x, { x in draw(tag, BAR_TAG_FONT, .secondaryLabelColor, x: x, baseline: (h - BAR_TAG_FONT.capHeight) / 2) }))
            x += w + 3
        }
        if let labels = q.labels {
            let w = labels.map { size($0, BAR_LABEL_FONT) }.max() ?? 0
            ops.append((x, { x in
                draw(labels[0], BAR_LABEL_FONT, .secondaryLabelColor, x: x, baseline: base1)
                draw(labels[1], BAR_LABEL_FONT, .secondaryLabelColor, x: x, baseline: base0)
            }))
            x += w + 2.5
        }
        // Values right-aligned in their column, so 9% and 41% end at the same place.
        // A one-row column sits in the middle of the bar.
        let rows = q.bottom.map { [(q.top, base1), ($0, base0)] } ?? [(q.top, ((h - cap) / 2).rounded())]
        let widths = rows.map { size($0.0.text, BAR_VALUE_FONT) + ($0.0.ahead ? size("\u{25B2}", BAR_GLYPH_FONT) + 1 : 0) }
        let colW = widths.max() ?? 0
        ops.append((x, { x in
            for (i, (cell, base)) in rows.enumerated() {
                // SECONDARY for the dash, not tertiary: on the real dark bar a tertiary
                // dash was all but invisible, and the column read as a lone "62%" -
                // the exact misreading the dash exists to prevent. (Seen in a capture
                // of the live menu bar, 2026-11-07.)
                let colour: NSColor = cell.pct == nil ? .secondaryLabelColor : quotaColour(pct: cell.pct!, stale: cell.stale)
                var cx = x + colW - widths[i]
                draw(cell.text, BAR_VALUE_FONT, colour, x: cx, baseline: base)
                if cell.ahead {
                    cx += size(cell.text, BAR_VALUE_FONT) + 1
                    draw("\u{25B2}", BAR_GLYPH_FONT, .secondaryLabelColor, x: cx, baseline: base + 1)
                }
            }
        }))
        x += colW
    }

    if m.waiting > 0 || m.working > 0 {
        x += 7
        let rows = [(m.waiting, "\u{25CB}", base1), (m.working, "\u{25CF}", base0)].filter { $0.0 > 0 }
        // One row alone sits in the middle rather than leaving a hole above or below.
        let placed = rows.count == 1 ? [(rows[0].0, rows[0].1, (h - cap) / 2)] : rows
        let w = placed.map { size("\($0.1)\($0.0)", BAR_VALUE_FONT) }.max() ?? 0
        ops.append((x, { x in
            for (n, glyph, base) in placed { draw("\(glyph)\(n)", BAR_VALUE_FONT, .labelColor, x: x, baseline: base) }
        }))
        x += w
    }

    if m.asking > 0 {
        x += 7
        let text = "\(m.asking)"
        let tw = size(text, BAR_BADGE_FONT)
        let pillH: CGFloat = 13, pillW = max(pillH, tw + 8)
        ops.append((x, { x in
            let r = NSRect(x: x, y: ((h - pillH) / 2).rounded(), width: pillW, height: pillH)
            NSColor.systemRed.setFill()
            NSBezierPath(roundedRect: r, xRadius: pillH / 2, yRadius: pillH / 2).fill()
            draw(text, BAR_BADGE_FONT, .white, x: r.midX - tw / 2, baseline: r.minY + (pillH - BAR_BADGE_FONT.capHeight) / 2)
        }))
        x += pillW
    }

    let width = ceil(x + 1)
    let img = NSImage(size: NSSize(width: width, height: h), flipped: false) { _ in
        for (ox, op) in ops { op(ox) }
        return true
    }
    img.isTemplate = false
    img.accessibilityDescription = "Deckhand"
    return img
}

/// Where Automatic starts. A notched screen's status area is the strip between the
/// notch and the right edge, shared with every other app's items, so it starts at
/// Compact there; anywhere else at Full. Either way it steps down if macOS hides it.
func barStartTier() -> BarTier {
    NSScreen.screens.contains { $0.safeAreaInsets.top > 0 } ? .compact : .full
}

/// Every tier's width for a status - the arithmetic Automatic and the Settings
/// window both reason with, from the same renderer that draws the bar.
func barWidths(_ s: HostStatus, height: CGFloat) -> [BarTier: CGFloat] {
    Dictionary(uniqueKeysWithValues: BarTier.allCases.map {
        ($0, barImage(barModel(s, tier: $0), boat: barBoatStyle(s), colourful: colourfulIcon, height: height).size.width)
    })
}

/// What the bar's own figures MEAN, on hovering the status item - the only place
/// the arrows can be explained, since the bar has room for a glyph and not for a
/// sentence. Empty when the bar is showing no usage, so there is no tooltip
/// promising to explain something that is not on screen.
func barTooltip(_ s: HostStatus) -> String {
    var lines: [String] = []
    if barMirrorAllowed(.usage, s) { lines += barClaudeTooltip(s) }
    if barMirrorAllowed(.codex, s), s.cxPct == nil, s.cx2Pct != nil {
        lines.append("CX (Codex) \(codexWindowLabel(s.cxWinMin, fallback: "first window")): no current reading - its window has reset since Codex last reported")
    }
    if barMirrorAllowed(.codex, s), let pct = s.cxPct {
        let age = s.cxAgeSec ?? 0
        // Each reason named, for the reason given in barClaudeTooltip: a missing
        // WINDOW is a different cause from a missing reset time, and paceWords
        // alone would blame the reset time for both.
        if age > QUOTA_STALE_SEC {
            lines.append("CX (Codex): \(pct)% used, no pace: this reading is \(humanMinutes(age / 60)) old")
        } else if s.cxWinMin == nil {
            lines.append("CX (Codex): \(pct)% used, no pace: Codex published no window length")
        } else {
            lines.append("CX (Codex): " + paceWords(pct: pct, pace: pacePct(resetInMin: s.cxReset, windowMin: s.cxWinMin)))
        }
    }
    if barMirrorAllowed(.codex, s), let pct = s.cx2Pct {
        let name = "CX (Codex) \(codexWindowLabel(s.cx2WinMin, fallback: "second window"))"
        if (s.cxAgeSec ?? 0) > QUOTA_STALE_SEC {
            lines.append("\(name): \(pct)% used, no pace: this reading is \(humanMinutes((s.cxAgeSec ?? 0) / 60)) old")
        } else {
            lines.append("\(name): " + paceWords(pct: pct, pace: pacePct(resetInMin: s.cx2Reset, windowMin: s.cx2WinMin)))
        }
    }
    if let g = geminiTooltip(s) { lines.append(g) }
    return lines.joined(separator: "\n")
}

/// The bar tooltip's Gemini lines: one per window of the group the GM column shows.
func geminiTooltip(_ s: HostStatus) -> String? {
    guard barMirrorAllowed(.gemini, s), let g = GeminiGroup.primary(s.gemini) else { return nil }
    let age = s.gmAgeSec ?? 0
    return g.buckets.map { b in
        let name = "AG (Antigravity) \(b.window == "weekly" ? "7d" : b.window)"
        if age > QUOTA_STALE_SEC { return "\(name): \(b.pct)% used, no pace: this reading is \(humanMinutes(age / 60)) old" }
        return "\(name): " + paceWords(pct: b.pct, pace: pacePct(resetInMin: b.reset, windowMin: geminiWindowMinutes(b.window)))
    }.joined(separator: "\n")
}

/// "5h" / "7d" from a window length in minutes - the host's own rule (days, or
/// hours under a day) - or `fallback` when Codex published none.
func codexWindowLabel(_ win: Int?, fallback: String) -> String {
    guard let w = win, w > 0 else { return fallback }
    return w >= 1440 ? "\(w / 1440)d" : "\(w / 60)h"
}

/// The 5h and 7d lines of `barTooltip`, with their shared staleness sentence.
func barClaudeTooltip(_ s: HostStatus) -> [String] {
    let stale = (s.quotaAgeSec ?? 0) > QUOTA_STALE_SEC
    var lines: [String] = []
    for (name, pct, reset, win) in [("5h", s.pct5h, s.reset5h, WINDOW_5H_MIN),
                                    ("7d", s.pct7d, s.reset7d, WINDOW_7D_MIN)] {
        guard let pct else { continue }
        // WHY there is no pace has to be the real reason, and this got it wrong
        // first time round: `paceWords(pace: nil)` says "no reset time, so no
        // pace", which is true for a window the poller has never resolved and
        // FALSE for a stale one - the reset time is right there on the row, and
        // the actual reason is that it is two hours old. A diagnostic that
        // misattributes a suppression sends the next reader to the wrong file, so
        // staleness is stated once, below, and these lines just drop the pace.
        lines.append(stale ? "\(name): \(pct)% used"
                           : "\(name): " + paceWords(pct: pct, pace: pacePct(resetInMin: reset, windowMin: win)))
    }
    if lines.isEmpty { return [] }
    // "5h/7d" named now that a Codex line can follow this one, which would
    // otherwise read as included in "these readings".
    if stale { lines.append("No 5h/7d pace: these readings are \(humanMinutes((s.quotaAgeSec ?? 0) / 60)) old, so the clock has moved and they have not.") }
    return lines
}
