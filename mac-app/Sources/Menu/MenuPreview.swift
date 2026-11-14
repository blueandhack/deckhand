import Cocoa

/// `--menu-dump`: the real menu as indented text, including the submenu and every
/// row's hidden/disabled/checked state. A menu cannot be screenshotted without
/// opening it by hand, so without this the structure is unverifiable.
func dumpMenu(_ m: NSMenu, indent: String = "") -> String {
    var out = ""
    for it in m.items {
        var flags: [String] = []
        if it.isHidden { flags.append("hidden") }
        if it.isSeparatorItem { out += indent + "──────────" + (flags.isEmpty ? "" : "  [hidden]") + "\n"; continue }
        if !it.isEnabled { flags.append("disabled") }
        if it.state == .on { flags.append("checked") }
        if it.submenu != nil { flags.append("submenu") }
        // Tooltips are otherwise verifiable only by hovering by hand, which on a
        // menu that cannot be screenshotted means not at all.
        if let tip = it.toolTip, !tip.isEmpty {
            flags.append("tip=\"" + tip.replacingOccurrences(of: "\n", with: " / ") + "\"")
        }
        let title = (it.attributedTitle?.string ?? it.title)
            .replacingOccurrences(of: "\n", with: "\n" + indent + "   ")
        out += indent + title + (flags.isEmpty ? "" : "   [" + flags.joined(separator: " ") + "]") + "\n"
        if let sub = it.submenu { out += dumpMenu(sub, indent: indent + "    ") }
    }
    return out
}

/// What AppKit does to a DISABLED menu item's attributed title, so the preview can
/// do it too.
///
/// MEASURED, not assumed, and by two independent routes that agree: capturing a
/// real popped-up menu holding two byte-identical attributed titles that differ
/// only in `isEnabled` gave a peak-ink ratio of **0.317** over the menu backdrop,
/// and `disabledControlTextColor.alphaComponent / labelColor.alphaComponent`
/// (0.247 / 0.847) predicts **0.292**. The captured figure is the one used, being
/// the behaviour rather than a proxy for it.
///
/// The multiplier is applied to each run's ALPHA rather than blended toward a grey,
/// because that is what a composite at reduced opacity does, and because these are
/// semantic colours whose resolved value differs between the two appearances this
/// preview draws side by side.
let DISABLED_INK_RATIO: CGFloat = 0.317

func dimmedForDisabled(_ a: NSAttributedString) -> NSAttributedString {
    let out = NSMutableAttributedString(attributedString: a)
    out.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: out.length)) { v, r, _ in
        guard let c = (v as? NSColor)?.usingColorSpace(.sRGB) else { return }
        out.addAttribute(.foregroundColor,
                         value: c.withAlphaComponent(c.alphaComponent * DISABLED_INK_RATIO),
                         range: r)
    }
    return out
}

/// `--menu-preview <out.png>`: the menu's own attributed titles drawn as they will
/// render, in BOTH appearances side by side. Every colour here is semantic
/// (labelColor, secondaryLabelColor) and resolves at draw time, so light-only
/// verification would prove nothing about the dark case.
func writeMenuPreview(to path: String, _ m: NSMenu, bar: NSAttributedString? = nil) {
    // WIDE ENOUGH FOR THE RIGHT-HAND TAB STOP. At a fixed 330 the text box was 302,
    // narrower than MENU_RIGHT_TAB itself, so every right column (states, reset
    // times, header notes) wrapped onto a line of its own here and nowhere else.
    let pad: CGFloat = 14, W: CGFloat = MENU_RIGHT_TAB + pad * 2 + 4
    var rows: [(NSAttributedString?, CGFloat)] = []
    // THE BAR LABEL GOES IN FIRST, because it is now the one surface whose
    // colours cannot be checked any other way: `--menu-dump` prints `.string`
    // and drops them, and `screencapture` needs a TCC grant this process does
    // not have (the same wall `--icon-preview` was written around). Its figures
    // carry a threshold colour and a pace glyph, and "is systemOrange legible on
    // a dark bar" is a question to LOOK at. Drawn on the same two bands as the
    // menu, which approximate a light and a dark bar closely enough to answer it.
    if let bar, bar.length > 0 {
        rows.append((bar, 24))
        rows.append((nil, 11))
    }
    for it in m.items where !it.isHidden {
        if it.isSeparatorItem { rows.append((nil, 11)); continue }
        var a = it.attributedTitle ?? NSAttributedString(
            string: it.title, attributes: [.font: F_BODY, .foregroundColor: NSColor.labelColor])
        // DISABLED ROWS ARE DIMMED HERE, because AppKit dims them on the glass and
        // this preview did not - which is exactly how a shipped defect stayed
        // invisible to the only instrument that can see this surface. A bar track
        // was tuned against a full-strength render and landed at 0.076 effective
        // alpha in the real menu, fainter than the value that had been rejected
        // for being too faint. An instrument that flatters is worse than none.
        if !it.isEnabled { a = dimmedForDisabled(a) }
        let h = a.boundingRect(with: CGSize(width: W - pad * 2, height: 400),
                               options: [.usesLineFragmentOrigin]).height
        rows.append((a, max(22, h + 8)))
    }
    let H = rows.reduce(0) { $0 + $1.1 } + pad * 2
    let img = NSImage(size: CGSize(width: W * 2, height: H), flipped: true) { _ in
        for (col, name) in [(0, NSAppearance.Name.aqua), (1, .darkAqua)] {
            NSAppearance(named: name)?.performAsCurrentDrawingAppearance {
                let x0 = CGFloat(col) * W
                (col == 0 ? NSColor(white: 0.97, alpha: 1) : NSColor(white: 0.13, alpha: 1)).set()
                CGRect(x: x0, y: 0, width: W, height: H).fill()
                var y = pad
                for (a, h) in rows {
                    if let a = a {
                        a.draw(with: CGRect(x: x0 + pad, y: y + 3, width: W - pad * 2, height: h),
                               options: [.usesLineFragmentOrigin])
                    } else {
                        (col == 0 ? NSColor(white: 0.85, alpha: 1) : NSColor(white: 0.3, alpha: 1)).set()
                        CGRect(x: x0 + pad, y: y + 5, width: W - pad * 2, height: 1).fill()
                    }
                    y += h
                }
            }
        }
        return true
    }
    let png = NSBitmapImageRep(data: img.tiffRepresentation!)!
        .representation(using: .png, properties: [:])!
    try? png.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)  (left: light appearance, right: dark)")
}

/// `--icon-preview <out.png>`: every style at every size, on light and dark
/// bands, each at native size and again at 6x nearest-neighbour. "Does a folded
/// crease survive at 16px?" is a question to LOOK at, not to reason about - the
/// firmware learned the same deciding the spark needed 32x32.
func writeIconPreview(to path: String) {
    let sizes: [CGFloat] = [16, 18, 22, 36]
    let styles: [BoatStyle] = [.solid, .outline]
    let zoom: CGFloat = 6, pad: CGFloat = 8
    let colW = sizes.map { $0 * zoom + pad }.reduce(0, +) + pad
    let rowH = sizes.map { $0 * zoom }.max()! + pad * 2
    // Every combination of style and colour mode, because the two now interact -
    // a coloured icon and a template one are not the same picture at all.
    let modes: [Bool] = [true, false]
    let rows = styles.count * modes.count * 2
    let sheet = NSImage(size: CGSize(width: colW, height: rowH * CGFloat(rows)), flipped: false) { _ in
        for row in 0..<rows {
            let style = styles[row / (2 * modes.count)]
            let colourful = modes[(row / 2) % modes.count]
            let dark = row % 2 == 1
            // AppKit's origin is bottom-left, so row 0 must be drawn at the TOP
            // or the sheet contradicts the caption it prints.
            let y0 = CGFloat(rows - 1 - row) * rowH
            (dark ? NSColor(white: 0.16, alpha: 1) : NSColor(white: 0.96, alpha: 1)).set()
            CGRect(x: 0, y: y0, width: colW, height: rowH).fill()
            var x = pad
            for sz in sizes {
                let icon = deckhandPaperBoatImage(size: sz, style: style, colourful: colourful)
                // A COLOURED icon is drawn as-is - that is the whole point of the
                // sheet, and painting our own tint over it would show a colour
                // the bar will never render. Only the TEMPLATE row is tinted
                // here, standing in for what macOS does to a mask.
                let tint = colourful ? icon : NSImage(size: icon.size, flipped: false) { r in
                    (dark ? NSColor.white : NSColor.black).set()
                    r.fill()
                    icon.draw(in: r, from: .zero, operation: .destinationIn, fraction: 1)
                    return true
                }
                NSGraphicsContext.current?.imageInterpolation = .none
                tint.draw(in: CGRect(x: x, y: y0 + pad, width: sz * zoom, height: sz * zoom))
                NSGraphicsContext.current?.imageInterpolation = .default
                tint.draw(in: CGRect(x: x, y: y0 + rowH - pad - sz, width: sz, height: sz))
                x += sz * zoom + pad
            }
        }
        return true
    }
    let png = NSBitmapImageRep(data: sheet.tiffRepresentation!)!
        .representation(using: .png, properties: [:])!
    try? png.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
    print("rows top->bottom: " + styles.flatMap { st in modes.flatMap { m in
        ["light", "dark"].map { "\(st == .solid ? "solid" : "outline")/\(m ? "colour" : "template")/\($0)" } } }
        .joined(separator: ", "))
    print("sizes left->right: \(sizes.map { Int($0) })")
}
