import Cocoa
import SwiftUI
#if SPARKLE
import Sparkle
#endif

/// `--settings-show <pane>`: open the REAL Settings window on that pane against the
/// live host and stay up, so a capture (or a person) can look at it. Read-only in
/// the sense every diagnostic here is: dryRun keeps refresh from starting,
/// stopping or sounding anything. Panes: general menubar devices claude about.
func modeSettingsShow() {
    if let i = CommandLine.arguments.firstIndex(of: "--settings-show") {
        let name = CommandLine.arguments.count > i + 1 ? CommandLine.arguments[i + 1] : "general"
        let pane: SettingsPane = ["general": .general, "menubar": .menuBar, "devices": .devices,
                                  "claude": .claude, "about": .about][name] ?? .general
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        if CommandLine.arguments.contains("--dark") { app.appearance = NSAppearance(named: .darkAqua) }
        if CommandLine.arguments.contains("--light") { app.appearance = NSAppearance(named: .aqua) }
        final class Show: NSObject, NSApplicationDelegate {
            let pane: SettingsPane
            let d = AppDelegate()
            init(_ p: SettingsPane) { pane = p }
            func applicationDidFinishLaunching(_ n: Notification) {
                d.dryRun = true
                #if SPARKLE
                // Sparkle exists in the real app from launch; here it is created NOT
                // started, so the About pane shows its switches and nothing checks.
                if isBundled { d.updater = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil) }
                #endif
                NSApp.mainMenu = d.buildMainMenu()
                ServiceState.shared.refreshNow()
                d.showSettings(pane: pane)
                Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.d.refresh() }
            }
        }
        let shower = Show(pane)
        app.delegate = shower
        app.run()
        exit(0)
    }
}

/// `--dmg-background <out-prefix> <label>`: the release DMG's window background, drawn
/// by the app itself so its menu-bar picture is the REAL boat and the REAL two-row bar
/// (barImage), not a drawing of them. Writes <out-prefix>.png (660x420) and
/// <out-prefix>@2x.png; build-release.sh joins them into one Retina TIFF. `label` is
/// the version line in the corner ("0.1.0 alpha"). The layout is bound to the DMG
/// step's icon positions: app at (170,150), Applications at (490,150), icon size 112.
func modeDmgBackground() {
    if let i = CommandLine.arguments.firstIndex(of: "--dmg-background"), CommandLine.arguments.count > i + 2 {
        let prefix = CommandLine.arguments[i + 1], label = CommandLine.arguments[i + 2]
        // LAID OUT in a 660x420 window, DRAWN on a larger canvas. Finder draws the
        // picture from the top-left corner and never scales it, and it makes the window
        // bigger than asked when the person's own Finder shows a tab bar or other chrome
        // (measured: 660 asked, 681 shown) - so past 660x420 the gradient simply
        // continues instead of a white strip. Every position below is in the 660x420
        // layout, from the top-left, matching the icon positions build-release.sh sets.
        let LW: CGFloat = 660
        let W: CGFloat = 800, H: CGFloat = 560
        let ink = NSColor(srgbRed: 0.11, green: 0.17, blue: 0.24, alpha: 1)
        let soft = NSColor(srgbRed: 0.30, green: 0.37, blue: 0.45, alpha: 1)
        let blue = NSColor(srgbRed: 0x2F / 255.0, green: 0x76 / 255.0, blue: 0xB8 / 255.0, alpha: 1)   // DECK_BLUE
        // A believable bar for the menu-bar picture: both services, both windows.
        var ex = HostStatus()
        ex.running = true; ex.deviceConnected = true
        ex.pct5h = 23; ex.reset5h = 200; ex.pct7d = 41; ex.reset7d = 6000; ex.quotaAgeSec = 1
        ex.cxPct = 12; ex.cxReset = 250; ex.cxWinMin = 300; ex.cx2Pct = 35; ex.cx2Reset = 7000; ex.cx2WinMin = 10080; ex.cxAgeSec = 1
        func text(_ t: String, _ f: NSFont, _ c: NSColor, centerX: CGFloat, top: CGFloat) {
            let a: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: c]
            let sz = (t as NSString).size(withAttributes: a)
            (t as NSString).draw(at: NSPoint(x: centerX - sz.width / 2, y: H - top - sz.height), withAttributes: a)
        }
        for scale in [1, 2] {
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W) * scale, pixelsHigh: Int(H) * scale,
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                       colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            rep.size = NSSize(width: W, height: H)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
                // Paper to a faint blue: the logo's cream and its blue, quietly.
                NSGradient(colors: [NSColor(srgbRed: 0.985, green: 0.965, blue: 0.93, alpha: 1),
                                    NSColor(srgbRed: 0.93, green: 0.955, blue: 0.985, alpha: 1)])!
                    .draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: -90)
                // Corner: the name and what this build is.
                let boat = deckhandPaperBoatImage(size: 18, style: .solid, colourful: true)
                boat.draw(in: NSRect(x: 26, y: H - 22 - 18, width: 18, height: 18))
                let nameAttr: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: ink]
                ("Deckhand" as NSString).draw(at: NSPoint(x: 50, y: H - 22 - 18), withAttributes: nameAttr)
                let tagAttr: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: soft]
                let tagSize = (label as NSString).size(withAttributes: tagAttr)
                let tagRect = NSRect(x: LW - 26 - tagSize.width - 16, y: H - 22 - 20, width: tagSize.width + 16, height: 20)
                NSColor(white: 1, alpha: 0.75).setFill()
                NSBezierPath(roundedRect: tagRect, xRadius: 10, yRadius: 10).fill()
                NSColor(srgbRed: 0.80, green: 0.84, blue: 0.89, alpha: 1).setStroke()
                NSBezierPath(roundedRect: tagRect.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10).stroke()
                (label as NSString).draw(at: NSPoint(x: tagRect.minX + 8, y: tagRect.minY + (20 - tagSize.height) / 2), withAttributes: tagAttr)
                // The arrow, between the two icons (centres 170 and 490, at 150 from the top).
                let y = H - 150
                let arrow = NSBezierPath()
                arrow.move(to: NSPoint(x: 262, y: y)); arrow.line(to: NSPoint(x: 392, y: y))
                arrow.lineWidth = 5; arrow.lineCapStyle = .round
                blue.withAlphaComponent(0.85).setStroke(); arrow.stroke()
                let head = NSBezierPath()
                head.move(to: NSPoint(x: 380, y: y + 14)); head.line(to: NSPoint(x: 400, y: y)); head.line(to: NSPoint(x: 380, y: y - 14))
                head.lineWidth = 5; head.lineCapStyle = .round; head.lineJoinStyle = .round; head.stroke()
                text("Drag Deckhand into Applications", NSFont.systemFont(ofSize: 17, weight: .semibold), ink, centerX: LW / 2, top: 262)
                // Where it goes after that: the menu bar - shown, not described.
                let bar = barImage(barModel(ex, tier: .full, previewing: true), boat: .solid, colourful: true, height: 24)
                let stripW = bar.size.width + 120, stripRect = NSRect(x: (LW - stripW) / 2, y: H - 334, width: stripW, height: 30)
                NSColor(srgbRed: 0.13, green: 0.15, blue: 0.19, alpha: 1).setFill()
                NSBezierPath(roundedRect: stripRect, xRadius: 8, yRadius: 8).fill()
                NSAppearance(named: .darkAqua)!.performAsCurrentDrawingAppearance {
                    bar.draw(in: NSRect(x: stripRect.minX + 60, y: stripRect.minY + 3, width: bar.size.width, height: bar.size.height))
                }
                text("Then open it from Applications. It lives in your menu bar.", NSFont.systemFont(ofSize: 12.5), soft, centerX: LW / 2, top: 344)
            }
            NSGraphicsContext.restoreGraphicsState()
            let out = scale == 1 ? "\(prefix).png" : "\(prefix)@2x.png"
            try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
            print(out)
        }
        exit(0)
    }
}

/// `--bar-preview <out.png>`: every SIZE of the menu-bar item for one busy example
/// (both services, both windows, sessions waiting and working, two asking), drawn by
/// the real renderer on a light bar and a dark bar at 2x, with each width printed. The
/// bar can only be judged by looking at it, and the real one shows one size at a time.
func modeBarPreview() {
    if let i = CommandLine.arguments.firstIndex(of: "--bar-preview"), CommandLine.arguments.count > i + 1 {
        var s = HostStatus()
        s.running = true; s.pct5h = 19; s.reset5h = 200; s.pct7d = 41; s.reset7d = 2900; s.quotaAgeSec = 1
        s.cxPct = 100; s.cxReset = 12; s.cxWinMin = 300; s.cx2Pct = 62; s.cx2Reset = 8400; s.cx2WinMin = 10080; s.cxAgeSec = 5
        s.gemini = parseGeminiQuota("Gemini_Models|5h:23:180|weekly:9:9000;Gemini_4_Argon|weekly:3:9956"); s.gmAgeSec = 20
        s.sessions = [SessionRow(id: "a", status: "waiting"), SessionRow(id: "b", status: "waiting"), SessionRow(id: "c", status: "working"),
                      SessionRow(id: "d", status: "asking"), SessionRow(id: "e", status: "asking")]
        let h = NSStatusBar.system.thickness, scale: CGFloat = 2, pad: CGFloat = 10, rowH = h + 8
        let tiers = BarTier.allCases.reversed()
        let width: CGFloat = 2 * (190 + pad * 2)
        let img = NSImage(size: NSSize(width: width, height: CGFloat(tiers.count) * rowH + pad))
        img.lockFocus()
        for (col, dark) in [false, true].enumerated() {
            let ap = NSAppearance(named: dark ? .darkAqua : .aqua)!
            ap.performAsCurrentDrawingAppearance {
                let x0 = CGFloat(col) * width / 2
                (dark ? NSColor(white: 0.16, alpha: 1) : NSColor(white: 0.93, alpha: 1)).setFill()
                NSRect(x: x0, y: 0, width: width / 2, height: img.size.height).fill()
                for (row, t) in tiers.enumerated() {
                    let bar = barImage(barModel(s, tier: t), boat: .solid, colourful: true, height: h)
                    let y = img.size.height - pad - CGFloat(row + 1) * rowH + 4
                    bar.draw(at: NSPoint(x: x0 + pad, y: y), from: .zero, operation: .sourceOver, fraction: 1)
                    if col == 0 { print(String(format: "%-9@ %4.0fpt  %@", t.title as NSString, bar.size.width, barText(barModel(s, tier: t)) as NSString)) }
                }
            }
        }
        img.unlockFocus()
        let out = NSImage(size: NSSize(width: img.size.width * scale, height: img.size.height * scale))
        out.lockFocus(); NSGraphicsContext.current?.imageInterpolation = .none
        img.draw(in: NSRect(origin: .zero, size: out.size)); out.unlockFocus()
        try? NSBitmapImageRep(data: out.tiffRepresentation!)!.representation(using: .png, properties: [:])!
            .write(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]))
        exit(0)
    }
}

/// `--setup-preview <dir>`: the released app's setup window, EVERY state, as PNGs.
/// The states are reached by clicking through a first run that registers a launch
/// agent and writes ~/.claude, so they cannot be looked at any other way without
/// doing exactly that. Renders the real SetupWindow from the real model(); only the
/// step and phase are forced. Starts, stops and writes nothing but the PNGs.
func modeSetupPreview() {
    if let i = CommandLine.arguments.firstIndex(of: "--setup-preview"),
       CommandLine.arguments.count > i + 1 {
        let dir = CommandLine.arguments[i + 1]
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        // --dark renders the dark appearance; light by default.
        let dark = CommandLine.arguments.contains("--dark")
        app.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        NSAppearance.current = app.appearance
        let owner = AppDelegate()
        let flow = SetupFlow(app: owner)
        flow.win.window.appearance = app.appearance
        let cases: [(String, SetupFlow.Step, SetupFlow.Phase)] = [
            ("1-location", .location, .idle), ("2-conflict", .conflict, .idle), ("3-hooks", .hooks, .idle),
            ("4-start", .start, .idle), ("5-prompting", .start, .prompting(Date())),
            ("6-ble-refused", .start, .bleRefused), ("7-handing-over", .done, .handingOver(Date())),
            ("8-done", .done, .idle), ("9-failed", .hooks, .failed("Installing the Claude Code hooks failed.\n\nerror: example output from the installer"))]
        for (name, st, ph) in cases {
            flow.forcedStep = st
            flow.phase = ph
            flow.render()
            // Laid out and drawn into the window's own backing first: cacheDisplay on a
            // never-displayed view returned a blank white PNG for every state.
            flow.win.window.contentView?.layoutSubtreeIfNeeded()
            flow.win.window.display()
            guard let v = flow.win.window.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
            v.cacheDisplay(in: v.bounds, to: rep)
            // The content view has no fill of its own - the WINDOW paints it - so the
            // bare capture is text on transparency, which in dark mode is white on
            // nothing. Composite it onto the window colour, in the appearance asked for.
            let img = NSImage(size: v.bounds.size)
            img.lockFocus()
            NSColor.windowBackgroundColor.setFill()
            NSRect(origin: .zero, size: v.bounds.size).fill()
            rep.draw(in: NSRect(origin: .zero, size: v.bounds.size))
            img.unlockFocus()
            let out = (dir as NSString).appendingPathComponent("setup-\(name).png")
            if let tiff = img.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff) {
                try? bmp.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
            }
            print("\(out)  \(Int(v.bounds.width))x\(Int(v.bounds.height))")
        }
        exit(0)
    }
}

/// `--menu-shot <out.png>`: THE REAL MENU, captured off the glass.
///
/// CLAUDE.md said for a long time that this surface "cannot be screenshotted -
/// `screencapture` needs a TCC grant this process does not have", and every other
/// instrument here was built around that wall. The grant exists now, so the wall
/// is gone, and the two defects that hid behind it (a disabled row's dimming, and
/// a bar track tuned against a full-strength render) are exactly the kind only a
/// real capture settles.
///
/// The trick is that `popUp` is MODAL and blocks this process, so it cannot
/// capture itself: a child `screencapture` is spawned FIRST and fires while the
/// parent sits in menu tracking. Menu tracking still runs the run loop, so the
/// timer that dismisses the menu afterwards does fire - without it the process
/// would hang holding a menu open over the user's screen.
func modeMenuShot() {
    if let i = CommandLine.arguments.firstIndex(of: "--menu-shot"),
       CommandLine.arguments.count > i + 1 {
        let path = CommandLine.arguments[i + 1]
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        // POPPED FROM applicationDidFinishLaunching, not inline before `run()`. Called
        // inline the menu silently never appears - the capture comes back showing
        // whatever was behind it, which reads as "the capture is broken" rather than
        // "the menu was never shown". AppKit needs its loop up first.
        final class Shot: NSObject, NSApplicationDelegate {
            let path: String
            init(_ p: String) { path = p }
            func applicationDidFinishLaunching(_ n: Notification) {
                let d = AppDelegate()
                d.dryRun = true
                let m = d.buildMenu()
                d.refresh()
                // CAPTURED BY WINDOW ID, NOT BY SCREEN REGION, and that is not a
                // refinement - a region capture CANNOT TELL whether the menu was
                // actually there. The first version guessed coordinates, the menu
                // failed to appear once, and it cheerfully wrote a PNG of the editor
                // behind it. An instrument that silently captures the wrong thing is
                // the same failure as the preview that drew disabled rows at full
                // strength: it answers confidently about something it never saw.
                //
                // So: find the window this process owns, capture THAT, and if there
                // isn't one, fail loudly instead of writing a file. It also means only
                // the menu is ever in the image - this runs on someone's desktop, and
                // a screen grab would sweep in every other window they have open.
                //
                // The lookup runs on a BACKGROUND queue because `popUp` blocks the main
                // thread for the whole life of the menu, which is exactly when the
                // window exists.
                DispatchQueue.global().async {
                    Thread.sleep(forTimeInterval: 1.2)
                    let mine = (CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)
                                as? [[String: Any]] ?? []).filter {
                        ($0[kCGWindowOwnerPID as String] as? pid_t) == getpid()
                    }
                    // The menu is the largest window we own; there is no other
                    // candidate, but sorting by area beats trusting the list's order.
                    let best = mine.max { l, r in
                        func area(_ w: [String: Any]) -> CGFloat {
                            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return 0 }
                            return (b["Width"] ?? 0) * (b["Height"] ?? 0)
                        }
                        return area(l) < area(r)
                    }
                    guard let id = best?[kCGWindowNumber as String] as? Int else {
                        print("menu-shot FAILED: this process owns no on-screen window, so the menu never appeared - NOT writing \(self.path)")
                        exit(1)
                    }
                    let cap = Process()
                    cap.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                    cap.arguments = ["-x", "-o", "-l", String(id), "-t", "png", self.path]
                    try? cap.run()
                    cap.waitUntilExit()
                    let ok = FileManager.default.fileExists(atPath: self.path)
                    print(ok ? "wrote \(self.path)  (the real menu window, off the glass)"
                             : "menu-shot FAILED: screencapture wrote nothing for window \(id)")
                    // Back to the main thread to dismiss, because the menu must not be
                    // left sitting open over the user's screen if anything above threw.
                    DispatchQueue.main.async { m.cancelTracking(); exit(ok ? 0 : 1) }
                }
                // A BACKSTOP, in case the capture path never reaches its own exit: the
                // failure mode without it is a menu held open on someone's desktop
                // forever, which is worse than a missing screenshot.
                Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in
                    print("menu-shot FAILED: timed out with the menu still up")
                    m.cancelTracking()
                    exit(1)
                }
                // MODAL - this blocks until something above cancels tracking, which is
                // the whole reason the capture had to be dispatched before it. Menu
                // tracking still runs the run loop, so the timer and the async hop back
                // both fire.
                let h = NSScreen.main?.frame.height ?? 900
                m.popUp(positioning: nil, at: NSPoint(x: 40, y: h - 30), in: nil)
            }
        }
        let shot = Shot(path)
        app.delegate = shot
        app.run()
    }
}

func modeMenuDump() {
    if CommandLine.arguments.contains("--menu-dump") || CommandLine.arguments.contains("--menu-preview") {
        let d = AppDelegate()
        d.dryRun = true
        // The real app reads these at launch; a dump that skipped it described the
        // agent as "not running in the background" while it was.
        ServiceState.shared.refreshNow()
        let m = d.buildMenu()
        d.refresh()
        if CommandLine.arguments.contains("--menu-dump") {
            let st = readStatus()
            // `.string` drops the colours, which is what a text dump can carry. The
            // pace GLYPHS survive, and they are the half that changes meaning - a
            // dump that showed neither could not tell a live 96%▲ from a stale one,
            // so the tooltip's own sentence is printed under it.
            // Every size, with its WIDTH from the same renderer the bar uses - the number
            // Automatic is deciding about - and which one is in use.
            let label = barText(barModel(st, tier: d.barTier))
            print("menu bar: boat (\(barBoatStyle(st))), size \(BarSize.current.rawValue) -> \(d.barTier.title)"
                  + (label.isEmpty ? " (nothing beside it)" : ": \(label)"))
            let widths = barWidths(st, height: NSStatusBar.system.thickness)
            for t in BarTier.allCases.reversed() {
                print(String(format: "  %@ %-9@ %4.0fpt  %@", t == d.barTier ? ">" : " ", t.title as NSString,
                             widths[t] ?? 0, barText(barModel(st, tier: t)) as NSString))
            }
            let tip = barTooltip(st)
            print(tip.isEmpty ? "" : tip.split(separator: "\n").map { "  tooltip: \($0)" }.joined(separator: "\n") + "\n")
            print(dumpMenu(m))
        }
        if let i = CommandLine.arguments.firstIndex(of: "--menu-preview"), CommandLine.arguments.count > i + 1 {
            let st = readStatus()
            let att = NSTextAttachment()
            att.image = barImage(barModel(st, tier: d.barTier), boat: barBoatStyle(st), colourful: colourfulIcon,
                                 height: NSStatusBar.system.thickness)
            writeMenuPreview(to: CommandLine.arguments[i + 1], m, bar: NSAttributedString(attachment: att))
        }
        exit(0)
    }
}

func modeIconPreview() {
    if let i = CommandLine.arguments.firstIndex(of: "--icon-preview") {
        writeIconPreview(to: CommandLine.arguments.count > i + 1
            ? CommandLine.arguments[i + 1] : "icon-preview.png")
        exit(0)
    }
}

/// --host-action-preview <dir> [--dark]: the General pane and the status menu in each
/// state Start/Stop/Restart can put them in (HostAction.swift), rendered from the real
/// GeneralPane and the real menu with only the action and its note forced. Those states
/// otherwise exist only for the seconds after a real click - which stops or restarts
/// the host - so this is the way to look at them. Starts, stops and writes nothing but
/// the PNGs and a text dump of each menu.
func modeHostActionPreview() {
    guard let i = CommandLine.arguments.firstIndex(of: "--host-action-preview"),
          CommandLine.arguments.count > i + 1 else { return }
    let dir = CommandLine.arguments[i + 1]
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let dark = CommandLine.arguments.contains("--dark")
    app.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    NSAppearance.current = app.appearance
    let d = AppDelegate()
    d.dryRun = true
    ServiceState.shared.refreshNow()
    let menu = d.buildMenu()
    let model = SettingsModel()
    model.app = d
    let now = Date()
    let pid = readStatus().pid
    let cases: [(String, HostAction?, HostActionNote?)] = [
        ("0-idle", nil, nil),
        ("1-stopping", HostAction(kind: .stopping, since: now, fromPid: pid), nil),
        ("2-restarting", HostAction(kind: .restarting, since: now, fromPid: pid), nil),
        ("3-starting", HostAction(kind: .starting, since: now, fromPid: nil), nil),
        ("4-restarted", nil, HostActionNote(text: HostActionKind.restarting.doneText, failed: false, until: now.addingTimeInterval(60))),
        ("5-stop-failed", nil, HostActionNote(text: HostActionKind.stopping.failedText, failed: true, until: now.addingTimeInterval(60))),
    ]
    for (name, action, note) in cases {
        d.hostAction = action
        d.hostActionNote = note
        d.refresh()
        model.pull(readStatus(), bar: nil)
        let host = NSHostingView(rootView: GeneralPane(m: model).frame(width: SETTINGS_W, height: 230))
        host.appearance = app.appearance
        host.frame = NSRect(x: 0, y: 0, width: SETTINGS_W, height: 230)
        let win = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        win.appearance = app.appearance
        win.contentView = host
        host.layoutSubtreeIfNeeded()
        win.display()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { continue }
        host.cacheDisplay(in: host.bounds, to: rep)
        let img = NSImage(size: host.bounds.size)
        img.lockFocus()
        NSColor.windowBackgroundColor.setFill()
        NSRect(origin: .zero, size: host.bounds.size).fill()
        rep.draw(in: NSRect(origin: .zero, size: host.bounds.size))
        img.unlockFocus()
        let out = (dir as NSString).appendingPathComponent("host-action-\(name).png")
        if let tiff = img.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff) {
            try? bmp.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
        }
        print("== \(name): \(out)")
        // The status menu's first lines and its Start/Stop item, as text.
        for item in menu.items where !item.isHidden && (item === d.startStop || item === d.statusLine || item === d.deviceLine) {
            print("   menu: \(item.attributedTitle?.string ?? item.title)\(item.isEnabled ? "" : "  [disabled]")")
        }
    }
    exit(0)
}
