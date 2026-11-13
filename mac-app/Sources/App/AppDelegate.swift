import Cocoa
import ServiceManagement
import SwiftUI
#if SPARKLE
import Sparkle
#endif

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let deviceLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let q5 = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let q7 = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let cxLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let cx2Line = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    // Section headers (disabled: they are chrome, and dim is what says so), the
    // separator under usage that hides with it, and the "N more" row.
    // REAL section headers (macOS 14), so VoiceOver announces them as headers; each
    // keeps an attributed title for its right-hand note. Measured: one built this
    // way draws exactly like the system's own - dim is the platform's header style.
    let claudeHeader = NSMenuItem.sectionHeader(title: "Claude")
    let codexHeader = NSMenuItem.sectionHeader(title: "Codex")
    let geminiHeader = NSMenuItem.sectionHeader(title: "Antigravity")
    // One row per Gemini quota WINDOW (a group has up to two), a fixed pool shown or hidden like the
    // session rows (never added or removed while the menu may be open).
    let geminiRows = (0..<6).map { _ in NSMenuItem(title: "", action: nil, keyEquivalent: "") }
    let usageSep = NSMenuItem.separator()
    let moreSessions = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let voiceHeader = NSMenuItem.sectionHeader(title: "Last dictation")
    let sessionsHeader = NSMenuItem.sectionHeader(title: "Sessions")
    // A fixed pool that is shown or hidden, never added and removed. The menu can
    // be OPEN while the 3s refresh runs, and rebuilding items under the cursor
    // makes the list jump; hiding is what the voice rows already did.
    var sessionRows: [NSMenuItem] = []
    let voiceSep = NSMenuItem.separator()
    let startStop = NSMenuItem(title: "", action: #selector(toggleHost), keyEquivalent: "")
    let voiceHeard = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let voiceReplyItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    // EVERY PREFERENCE LIVES IN THE SETTINGS WINDOW (SettingsWindowController). The
    // menu used to carry them as a Settings submenu that had grown to eleven rows and
    // five nested submenus - a Mac icon picker sixteen rows long, a device picker, a
    // sound list, five bar toggles, the hooks - and a submenu is the wrong control
    // for all of it: no room to say what a switch does, a mis-click closes it, and a
    // name field needs an alert. The menu is now status, then the three things people
    // do from it: start or stop, pair, and open Settings.
    let settingsWindowItem = NSMenuItem(title: "Settings\u{2026}", action: #selector(openSettings), keyEquivalent: ",")
    var settingsWindow: SettingsWindowController?
    /// The pane Settings showed when it was last closed (SettingsWindowController.windowWillClose).
    var lastSettingsPane = 0
    // Wireless pairing. ONE ROW, and it opens a window rather than a submenu - see
    // the note above PAIR_TICK_SEC (Pairing/PairWindow.swift) for why a menu cannot hold this flow. It is
    // never dimmed: with no host, or against a host too old to pair, the WINDOW
    // says so in words, which a grey row cannot.
    let pairItem = NSMenuItem(title: "Pair New Device\u{2026}", action: #selector(openPairWindow), keyEquivalent: "")
    var pairWindow: PairWindow?
    // The window's own state: what this Mac has answered, and whether it has asked
    // to cancel. Expired by pairLocalNext() rather than by hand.
    var pairLocal = PairLocal()
    // Runs only while the window is up, at PAIR_TICK_SEC instead of the menu's 3s.
    var pairTicker: Timer?
    // What has already been put in front of the user. Outlives a refresh for the
    // same reason askWatcher does - a decision about what is NEW cannot be made
    // from a local. It no longer gates a modal; it gates BRINGING THE WINDOW
    // FORWARD, which is the same question ("is this new?") about a gentler act.
    var pairSeen = PairSeen()
    // False until the first refresh has looked at the pairing block once. See
    // pairWorthRaising.
    var pairPrimed = false
    // Diffed every refresh, so it must outlive one - a local would announce
    // every asking session on every 3s tick.
    var askWatcher = AskWatcher()
    // The released app only (isBundled). Added to the menu in buildMenu() only in
    // that mode, so a dev build's menu - and --menu-dump - is exactly what it was.
    let updateItem = NSMenuItem(title: "Check for Updates\u{2026}", action: #selector(checkForUpdates), keyEquivalent: "")
    var setup: SetupFlow?
    #if SPARKLE
    var updater: SPUStandardUpdaterController?
    #endif

    // Watchdog state. wantRunning persists the user's intent ("syncing should
    // be on") so a deliberate Stop is respected but a frozen/crashed host is
    // auto-restarted - and it survives app relaunches (login item after a
    // reboot). downSince/lastRestart debounce the restart.
    var downSince: Date?
    var lastRestart = Date.distantPast
    // A Start/Stop/Restart in flight, and what the last one came to (HostAction.swift).
    var hostAction: HostAction?
    var hostActionNote: HostActionNote?
    var hostActionTimer: Timer?
    /// launchd refused a restart (no such job); see watchdog.
    var watchdogGaveUp = false
    // --menu-dump / --menu-preview build the real menu and refresh it. Neither may
    // start or stop anything, so the watchdog is skipped outright rather than
    // relied on to be a no-op on a single call.
    var dryRun = false
    var wantRunning: Bool {
        get { UserDefaults.standard.bool(forKey: "wantRunning") }
        set { UserDefaults.standard.set(newValue, forKey: "wantRunning") }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        statusItem.menu = buildMenu()
        statusItem.menu?.delegate = self
        NSApp.mainMenu = buildMainMenu()

        // Once here, on purpose, before anything is drawn - then only ever off the
        // main thread (see ServiceState).
        ServiceState.shared.refreshNow()
        refresh()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in self?.resetBarFit() }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification,
                                                          object: nil, queue: .main) { [weak self] _ in self?.resetBarFit() }
        // A different app in front may have a different size (fitByApp).
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { [weak self] _ in self?.refresh() }
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            ServiceState.shared.refresh {
                if let w = self?.settingsWindow, w.window.isVisible { w.model.pullServices() }
            }
        }

        // Adopt the current state: if the host is already syncing, keep it
        // alive from now on. If syncing was meant to be on but the host is
        // down (e.g. after a reboot via the login item), start it.
        if isBundled { bundledLaunch() }
        if readStatus().running { wantRunning = true }
        // The released app starts nothing before its setup has run once: hooks are
        // installed only with consent, and the agent is registered by setup.
        if wantRunning && !readStatus().running && (!isBundled || SetupFlow.done) {
            lastRestart = Date()
            startHost()
        }
    }

    /// An accessory app has no menu bar of its own, but the KEY EQUIVALENTS of one
    /// are how a window's text field gets Cmd-V and Cmd-A and how Cmd-W closes it -
    /// with no main menu, pasting a name into Settings silently does nothing. Never
    /// shown (the app is never frontmost in the menu-bar sense), only used.
    func buildMainMenu() -> NSMenu {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) {
            let host = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            host.submenu = m
            main.addItem(host)
        }
        let settings = NSMenuItem(title: "Settings\u{2026}", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        sub("Deckhand", [settings, .separator(),
                         NSMenuItem(title: "Quit Deckhand", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")])
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        sub("Edit", [NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"), redo, .separator(),
                     NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
                     NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
                     NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
                     NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")])
        sub("Window", [NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")])
        return main
    }

    /// MIGRATION from the menu app built out of the repo. That app's bundle id was
    /// com.deckhand.menubar, so its preferences live in a different defaults domain
    /// and the released app started from scratch - found on this Mac, where the old
    /// app had the monochrome icon chosen and the released one came up colourful.
    /// Copied ONCE (a key marks it done), and only keys this app has never set, so a
    /// choice made here is never overwritten by an old one. `wantRunning` is NOT
    /// copied: setup decides whether the bundled host runs.
    func importLegacyPrefs() {
        let d = UserDefaults.standard
        guard !d.bool(forKey: "importedLegacyPrefs") else { return }
        d.set(true, forKey: "importedLegacyPrefs")
        guard let old = UserDefaults(suiteName: "com.deckhand.menubar") else { return }
        let keys = BarPref.allCases.map(\.rawValue) + ["colourfulIcon", "askSound", "macIcon"]
        var copied: [String] = []
        for k in keys where d.object(forKey: k) == nil {
            if let v = old.object(forKey: k) { d.set(v, forKey: k); copied.append(k) }
        }
        if !copied.isEmpty { NSLog("Deckhand: imported preferences from the old menu app: %@", copied.joined(separator: ", ")) }
    }

    /// Everything the released app does at launch that a dev build must not.
    func bundledLaunch() {
        importLegacyPrefs()
        #if SPARKLE
        // Sparkle's standard flow: it asks on the SECOND launch whether to check
        // automatically, and the menu's Check for Updates works from the first.
        updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        #endif
        // A new build (a Sparkle update, or a new download dragged over the old):
        // re-copy the hook scripts if the user agreed to them once, and restart the
        // host so it runs the code that is now in the bundle rather than the old
        // process left running out of the replaced one.
        DispatchQueue.global(qos: .utility).async { Hooks.afterLaunch() }
        let d = UserDefaults.standard
        if d.string(forKey: "hostBuild") != appBuild {
            // Off the main thread: both the status and kickstart are calls into
            // system daemons that can be slow at login, when this mostly runs.
            DispatchQueue.global(qos: .utility).async {
                if hostAgent().status == .enabled {
                    _ = runCapture("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(agentLabel)"])
                }
            }
            d.set(appBuild, forKey: "hostBuild")
        }
        if !SetupFlow.done || legacyHostPresent() || runningFromTemporaryLocation() { openSetup() }
    }

    // Built in its own method, not inline above, so --menu-dump can construct the
    // real menu without starting timers or adopting host state.
    func buildMenu() -> NSMenu {
        let menu = NSMenu()
        // EXPLICIT enablement. With autoenablesItems on (the default) AppKit
        // re-enables anything that has a target and an action, which silently
        // undid the isEnabled this code sets - so a control meant to be dimmed was
        // clickable.
        menu.autoenablesItems = false

        sessionRows = (0..<MAX_SESSION_ROWS).map { _ in
            let it = NSMenuItem(title: "", action: #selector(openSessionFolder(_:)), keyEquivalent: "")
            it.isHidden = true
            return it
        }

        // Groups, separated: where the host stands / what quota is left / who is
        // waiting on you / the last dictation / what you can do / the app itself.
        var items: [NSMenuItem] = [statusLine, deviceLine, .separator(),
                                   claudeHeader, q5, q7, codexHeader, cxLine, cx2Line, geminiHeader]
        items += geminiRows
        items += [usageSep,
                                   sessionsHeader]
        items += sessionRows
        items += [moreSessions, voiceSep, voiceHeader, voiceHeard, voiceReplyItem,
                  .separator(), startStop, pairItem, settingsWindowItem,
                  .separator()]
        // Released app only: Sparkle's item sits with Quit, where Mac apps put it.
        if isBundled { items.append(updateItem) }
        items.append(NSMenuItem(title: "Quit Deckhand", action: #selector(quit), keyEquivalent: "q"))
        for it in items {
            it.target = self
            // An item with no action is information; one with an action is a
            // control. Deriving the baseline from that makes a silently dead
            // item impossible, which is what explicit enablement risks.
            it.isEnabled = it.action != nil
            menu.addItem(it)
        }
        // EXCEPT THE ROWS THAT CARRY A READING, and this is the one place the rule
        // above had to give way. AppKit composites a DISABLED item's attributed
        // title at ~0.317 of full strength (measured off a real captured menu -
        // see `--legibility-check`), so `.labelColor` lands at 0.27, which IS
        // tertiary grey. A percentage nobody can read defeats the whole row, and
        // no colour fixes it: `.labelColor` is already the strongest text colour
        // macOS has, so the ceiling while disabled is grey by arithmetic.
        //
        // The cost is that these rows now highlight under the cursor and a click
        // dismisses the menu, which is the "silently dead item" the rule was
        // guarding against - accepted deliberately, because an unreadable reading
        // is a worse failure than a row that does nothing when clicked. The
        // SESSIONS header is deliberately NOT in this list: it is chrome, it
        // carries no reading, and dim is what says so.
        for it in [q5, q7, cxLine, cx2Line, statusLine, deviceLine] + geminiRows { it.isEnabled = true }
        // No icons on the actions: tried, and this macOS draws no item images in a
        // menu at all (a plain test menu with SF Symbols showed none).
        return menu
    }

    func refresh() {
        let s = readStatus()
        if let si = statusItem, let button = si.button {
            // The bar's own thickness sets the size, so this follows a
            // 24px bar or a 22px one instead of assuming either.
            // NO TINT, EVER - nil, deliberately, where this used to set grey for
            // stopped and orange for running-with-no-device. Those two colours
            // were not reaching the screen: with the host running and no device
            // the bar drew a BLACK boat, not an orange one, because macOS renders
            // a status item's template image in its own menu-bar colour - which
            // over a light-ish wallpaper is black even in Dark Mode - and that
            // overrode the tint. A colour that is silently ignored is worse than
            // no colour, so the icon now follows the system the way every other
            // menu-bar glyph does: white on a dark bar, black on a light one.
            // Cost, accepted: stopped and device-offline both draw the hollow
            // boat and are no longer told apart in the BAR. The menu's own status
            // line still separates them in words ("Stopped" versus "Running -
            // device offline"), which is where this file already puts the meaning
            // that colour is not allowed to carry alone.
            button.contentTintColor = nil
            // Beside the boat: usage and the live-session count while no device
            // is connected, and a needs-input count whenever there is one -
            // NOTHING otherwise, because a badge that is always present stops
            // being a signal.
            //
            // The usage figures now carry a pace glyph and the menu's own
            // threshold colour (see `barUsageParts`), where this was one flat
            // `labelColor` for the whole label. That is NOT the tint the comment
            // above refuses: an attributed string's foregroundColor is honoured,
            // it is the TEMPLATE IMAGE whose colour macOS overrides with its own -
            // which is why the boat gives up on colour and the text does not. The
            // colours are semantic (`systemRed`/`systemOrange`/`tertiaryLabel`),
            // so they follow a light bar and a dark one; and the digits and the
            // glyph both still state the fact without them.
            // The boat and everything beside it are ONE image now, laid out by
            // size (BarTier) - see barImage for why the text title went.
            applyBar(s, button: button)
            // The arrows are the one thing in the bar that needs a word, and this
            // is the only surface that can give them one.
            button.toolTip = barTooltip(s).isEmpty ? nil : barTooltip(s)
        }
        // ---- the connection: what, and how ----
        let device = s.device ?? s.selected
        if let a = hostAction {
            statusLine.attributedTitle = menuTitle([("\u{25CC}  ", F_BODY, .secondaryLabelColor),
                                                    (a.kind.progressTitle, F_BOLD, .labelColor)])
            deviceLine.attributedTitle = menuTitle([("      " + a.kind.progressDetail, F_SMALL, .secondaryLabelColor)])
        } else if let n = currentHostActionNote, n.failed {
            statusLine.attributedTitle = menuTitle([("\u{26A0}  ", F_BODY, .systemOrange),
                                                    (s.running ? "Deckhand is running" : "Deckhand is stopped", F_BOLD, .labelColor)])
            deviceLine.attributedTitle = menuTitle([("      " + n.text, F_SMALL, .systemOrange)])
        } else if !s.running {
            statusLine.attributedTitle = menuTitle([("\u{25E6}  ", F_BODY, .secondaryLabelColor),
                                                    ("Deckhand is stopped", F_BOLD, .labelColor)])
            deviceLine.attributedTitle = menuTitle([("      The display is not being updated.", F_SMALL, .secondaryLabelColor)])
        } else if s.deviceConnected {
            statusLine.attributedTitle = menuTitle([("\u{25CF}  ", F_BODY, .controlAccentColor),
                                                    ("Syncing with \(device ?? "your display")", F_BOLD, .labelColor)])
            // How it is connected, then its battery - one line, where it was three.
            var detail = [s.via.map { "Over " + viaLabel($0) } ?? "Connected"]
            if let pct = s.battPct, (s.battAgeSec ?? 999) < 180, (s.battState ?? 0) != 0 {
                switch s.battState ?? 0 {
                case 2: detail.append("battery \(pct)%, charging")
                case 3: detail.append("battery full")
                default:
                    // Hours left only once the device has measured a trend - see
                    // battMinutesLeft() in power.ino; a guess from noise would be worse.
                    let left = s.battLeftMin.map { $0 < 120 ? ", ~\($0)m left" : ", ~\(($0 + 30) / 60)h left" } ?? ""
                    detail.append("battery \(pct)%\(left)")
                }
            }
            let low = (s.battPct ?? 100) <= 10 && (s.battState ?? 0) == 1
            deviceLine.attributedTitle = menuTitle([("      " + detail.joined(separator: "  \u{00B7}  "), F_SMALL,
                                                     low ? .systemOrange : .secondaryLabelColor)])
        } else {
            statusLine.attributedTitle = menuTitle([("\u{25E6}  ", F_BODY, .systemOrange),
                                                    ("Waiting for a display", F_BOLD, .labelColor)])
            deviceLine.attributedTitle = menuTitle([("      " + (device.map { "Plug in \($0) over USB, or turn it on." }
                                                                 ?? "Plug a Deckhand in over USB to pair it."),
                                                     F_SMALL, .secondaryLabelColor)])
        }

        // ---- usage: a section per service, one line per window ----
        let cStale = (s.quotaAgeSec ?? 0) > QUOTA_STALE_SEC
        let xStale = (s.cxAgeSec ?? 0) > QUOTA_STALE_SEC
        // A header says when its readings are OLD, once for the section, instead of
        // "· stale 35m" on every row under it.
        let ageNote = { (stale: Bool, age: Int?) in stale ? "updated \(humanMinutes((age ?? 0) / 60)) ago" : "" }
        let claudeOn = s.pct5h != nil || s.pct7d != nil
        let codexOn = s.cxPct != nil || s.cx2Pct != nil
        claudeHeader.attributedTitle = menuHeader("Claude", note: ageNote(cStale, s.quotaAgeSec))
        codexHeader.attributedTitle = menuHeader("Codex", note: ageNote(xStale, s.cxAgeSec))
        for (item, win, pct, reset, stale, shown) in [
            (q5, WINDOW_5H_MIN, s.pct5h, s.reset5h, cStale, claudeOn),
            (q7, WINDOW_7D_MIN, s.pct7d, s.reset7d, cStale, claudeOn),
            (cxLine, s.cxWinMin ?? WINDOW_5H_MIN, s.cxPct, s.cxReset, xStale, codexOn),
            (cx2Line, s.cx2WinMin ?? WINDOW_7D_MIN, s.cx2Pct, s.cx2Reset, xStale, codexOn && s.cx2Pct != nil),
        ] as [(NSMenuItem, Int, Int?, Int?, Bool, Bool)] {
            // A window with no reading keeps its row (a dash) while the service has
            // another reading - the menu's version of the bar's dash.
            item.isHidden = !shown
            if shown { (item.attributedTitle, item.toolTip) = quotaRow(win, pct, reset, stale: stale) }
        }
        claudeHeader.isHidden = !claudeOn
        codexHeader.isHidden = !codexOn
        // Gemini: its own models always, the other vendors' models the app offers
        // only once they have been used - five rows of 0% would be noise.
        let gStale = (s.gmAgeSec ?? 0) > QUOTA_STALE_SEC
        // The general Gemini allowance as "5-hour" / "Weekly", like Claude's; then
        // the separate ones, named: Argon always (it is Gemini's own), the Claude and
        // GPT models the app also offers only once used - zeros there are noise.
        var gRows: [(label: String?, group: String, b: GeminiGroup.Bucket)] = []
        let primary = GeminiGroup.primary(s.gemini)
        for g in s.gemini {
            let isPrimary = g.name == primary?.name
            let isOwn = GeminiGroup.isOwn(g)
            guard isPrimary || isOwn || g.buckets.contains(where: { $0.pct > 0 }) else { continue }
            // "C/GPT", never "Claude": inside this section a row called "Claude 5h" read
            // as your own Claude quota. (Review finding.) The general group is "Gemini",
            // not prefix(5)'s "Gemin" - it is labelled now that Argon can be the primary.
            // The primary row stays unlabelled ("5-hour"/"Weekly") ONLY when it is the
            // general group; any other primary names itself, or a bare "Weekly 35%" would
            // not say it is Argon's week.
            let n = g.name.lowercased()
            let name = n.contains("argon") ? "Argon" : (n.contains("claude") ? "C/GPT"
                       : (n == "gemini models" ? "Gemini" : String(g.name.prefix(6))))
            let short: String? = isPrimary && n == "gemini models" ? nil : name
            for b in g.buckets {
                let w = b.window == "weekly" ? "7d" : b.window
                gRows.append((short.map { "\($0) \(w)" }, g.name, b))
            }
        }
        geminiHeader.attributedTitle = menuHeader("Antigravity", note: ageNote(gStale, s.gmAgeSec))
        geminiHeader.isHidden = gRows.isEmpty
        for (i, item) in geminiRows.enumerated() {
            guard i < gRows.count else { item.isHidden = true; continue }
            let r = gRows[i]
            let win = geminiWindowMinutes(r.b.window)
            let title = quotaRow(win, r.b.pct, r.b.reset, stale: gStale, name: r.label).0
            // The tooltip names the GROUP and the WINDOW ("Gemini 4 Argon, weekly"),
            // never the row's short label.
            let tip = quotaRow(win, r.b.pct, r.b.reset, stale: gStale).1
            let sentence = "\(r.group), " + tip.prefix(1).lowercased() + tip.dropFirst() + "\nRead from Antigravity: the app while it runs, otherwise the agy CLI."
            item.attributedTitle = title
            item.toolTip = sentence
            item.isHidden = false
        }
        usageSep.isHidden = !(claudeOn || codexOn || !gRows.isEmpty)

        // ---- sessions ----
        // The header COUNTS by state, so "is anyone waiting on me" is answered
        // before reading a single row.
        let byState = { (st: String) in s.sessions.filter { $0.status == st }.count }
        let counts = [(byState("asking"), "need you"), (byState("waiting"), "waiting"), (byState("working"), "working")]
            .filter { $0.0 > 0 }.map { "\($0.0) \($0.0 == 1 && $0.1 == "need you" ? "needs you" : $0.1)" }
        sessionsHeader.attributedTitle = menuHeader("Sessions", note: s.sessions.isEmpty ? "none right now" : counts.joined(separator: "  \u{00B7}  "))
        sessionsHeader.isHidden = false
        for (i, row) in sessionRows.enumerated() {
            guard i < s.sessions.count else { row.isHidden = true; continue }
            let r = s.sessions[i]
            row.attributedTitle = sessionTitle(r)
            // The whole row, not just its path: the click needs the app and the
            // entrypoint too, and a parallel array would be one more thing to keep
            // in step with this loop.
            row.representedObject = r
            // The tooltip adds the two facts the row cannot fit - model and branch -
            // and says exactly what the click will do, from the same resolver the
            // click uses, so it cannot promise Finder and then open an editor.
            let facts = [r.model, r.branch].filter { !$0.isEmpty }.joined(separator: "  \u{00B7}  ")
            let action = "Click to " + describeTarget(sessionTarget(r))
            let tip = [facts, action].filter { !$0.isEmpty }.joined(separator: "\n\n")
            row.toolTip = tip.isEmpty ? nil : tip
            row.isEnabled = !r.path.isEmpty
            row.isHidden = false
        }
        let more = max(0, s.sessionsTotal - min(s.sessions.count, sessionRows.count))
        moreSessions.attributedTitle = menuTitle([("      \(more) more", F_SMALL, .secondaryLabelColor)])
        moreSessions.isHidden = more == 0

        // ---- the last dictation: the only Mac-side trace of one, since a headless
        // `claude -p --resume` appears in no Claude Code window ----
        if let t = s.voiceText, !t.isEmpty {
            let st = s.voiceState ?? ""
            let reply = (s.voiceReply?.isEmpty == false) ? s.voiceReply!
                : (st == "sent" ? "sent to the session, waiting\u{2026}" : st)
            voiceHeader.attributedTitle = menuHeader("Last dictation")
            voiceHeard.attributedTitle = menuTitle([("\u{201C}\(clip(t, 42))\u{201D}", F_MONO, .labelColor)])
            voiceReplyItem.attributedTitle = menuTitle([
                (st == "error" ? "\u{26A0}  " : "\u{21B3}  ", F_SMALL, .secondaryLabelColor),
                (clip(reply, 50), F_SMALL, st == "error" ? .systemOrange : .secondaryLabelColor)])
            voiceHeader.isHidden = false
            voiceHeard.isHidden = false
            voiceReplyItem.isHidden = reply.isEmpty
            voiceSep.isHidden = false
        } else {
            voiceHeader.isHidden = true
            voiceHeard.isHidden = true
            voiceReplyItem.isHidden = true
            voiceSep.isHidden = true
        }
        rebuildPairRow(s)
        startStop.title = hostAction?.kind.progressTitle ?? (s.running ? "Stop Deckhand" : "Start Deckhand")
        startStop.isEnabled = hostAction == nil
        // Naming the supervisor matters: with launchd in charge, a stop is permanent
        // until Start, whereas unsupervised the app's own watchdog may bring it back.
        startStop.toolTip = hostSupervisionText()
        // The EDGE into asking, not the state - and stepped on every refresh even
        // when silent, so switching a sound on does not then announce a backlog
        // the watcher never saw. dryRun covers --menu-dump: a diagnostic must
        // not make a noise.
        let asking = Set(s.sessions.filter { $0.status == "asking" }.map { $0.id })
        if askWatcher.step(asking) > 0 && !dryRun { playAskSound() }
        // The window reads the same snapshot, and only while it is ON SCREEN: the
        // controller is kept after a close (so it reopens where it was), and a
        // hidden SwiftUI tree re-rendered every 3s is work nobody sees.
        if let w = settingsWindow, w.window.isVisible { w.model.pull(s, bar: statusItem?.button) }

        if dryRun { return }
        // AFTER the dryRun guard, deliberately: --menu-dump and --menu-preview
        // build the real menu and refresh it, and a diagnostic that pops a modal
        // dialog on someone's desktop is the same class of problem as one that
        // makes a noise.
        pairTick(s)
        watchdog(s)
    }

    /// Who keeps the host alive, in one sentence - the Start/Stop tooltip and the
    /// Settings window's General pane say the same thing.
    func hostSupervisionText() -> String {
        if isBundled {
            switch ServiceState.shared.agent {
            case .enabled: return "Runs in the background: starts at login, restarts if it stops or hangs."
            case .requiresApproval: return "Turned off in System Settings \u{203A} General \u{203A} Login Items."
            default: return "Not running in the background."
            }
        }
        return isSupervised()
            ? "Managed by launchd: starts at login, restarts if it stops or hangs."
            : "Not supervised - install with host/deckhand-service.sh install."
    }

    /// THE WATCHDOG: syncing is meant to be on, and the heartbeat has been stale
    /// for a sustained window. Only acts when wantRunning, so a deliberate Stop is
    /// honoured; the cooldown keeps it from re-restarting a host still connecting.
    ///
    /// It now covers a SUPERVISED host too, because launchd's KeepAlive restarts a
    /// process that EXITS and never one that HANGS. Measured on the released app:
    /// a host frozen with SIGSTOP sat there with a 47s-old heartbeat, the menu said
    /// "Stopped", and nothing would ever have recovered it - the old watchdog was
    /// switched off whenever launchd was in charge, on the reasoning that launchd
    /// was strictly better, which is only true of crashes. Supervised, the restart
    /// goes THROUGH launchd (`kickstart -k`), so there is still one supervisor and
    /// this is just its missing hang detector. The wait is longer than the
    /// unsupervised one because launchd brings a crashed host back by itself
    /// within a second or two, and this must not race that.
    func watchdog(_ s: HostStatus) {
        if s.running { watchdogGaveUp = false }
        let supervised = isSupervised()
        guard wantRunning, !s.running, !(isBundled && !SetupFlow.done),
              !(isBundled && !supervised) else { downSince = nil; return }
        guard let since = downSince else { downSince = Date(); return }
        let wait: TimeInterval = supervised ? 30 : 20
        let cooldown: TimeInterval = supervised ? 60 : 30
        guard Date().timeIntervalSince(since) > wait, Date().timeIntervalSince(lastRestart) > cooldown else { return }
        lastRestart = Date()
        downSince = nil
        if supervised {
            guard !watchdogGaveUp else { return }
            let label = isBundled ? agentLabel : "com.deckhand.host"
            // The log says what HAPPENED, not what was attempted. A repo agent stopped
            // from a terminal (`deckhand-service.sh stop`: booted out, plist kept)
            // still counts as supervised, and kickstart then fails with "Could not
            // find service" - which used to be logged as a restart every 90s forever.
            // One line saying so, then nothing until the host is seen running again.
            // (Review finding.)
            DispatchQueue.global(qos: .utility).async { [weak self] in
                let r = runCapture("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(label)"])
                DispatchQueue.main.async {
                    if r.status == 0 {
                        noteInHostLog("menu-bar watchdog: no heartbeat for \(Int(wait))s - restarted the host (launchctl kickstart -k \(label))")
                    } else {
                        noteInHostLog("menu-bar watchdog: no heartbeat for \(Int(wait))s, but launchd could not restart \(label) (\(r.out.trimmingCharacters(in: .whitespacesAndNewlines))). Stopped from a terminal? Not retrying until the host is running again.")
                        self?.watchdogGaveUp = true
                    }
                }
            }
        } else {
            NSLog("Deckhand watchdog: host down, restarting")
            startHost()
        }
    }

    // ---- the bar item's size (BarTier) -------------------------------------

    /// The largest size known to fit on the current displays, for Automatic.
    var fitTier: BarTier = barStartTier()
    /// What the button is showing, so an unchanged bar is not re-set every 3s.
    var barShown: (model: BarModel, style: BoatStyle, colourful: Bool, height: CGFloat)?
    var barHiddenSince: Date?
    /// macOS is hiding the item even at the size in use - nothing smaller to try.
    var barHidden = false
    var barFitNote = ""

    /// Sizes stepped down to WHILE A GIVEN APP WAS FRONTMOST. On a notched Mac the
    /// frontmost app's own menus share the bar, so an app with long menus (Xcode,
    /// Office) can push status items off it - and a single size for everything
    /// ratcheted down in such an app and never came back. (Review finding.) Each app
    /// remembers its own; every other app keeps `fitTier`.
    var fitByApp: [String: BarTier] = [:]
    func frontApp() -> String { NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "" }

    var barTier: BarTier { BarSize.current.tier ?? fitByApp[frontApp()] ?? fitTier }

    func applyBar(_ s: HostStatus, button: NSStatusBarButton) {
        let h = NSStatusBar.system.thickness
        let m = barModel(s, tier: barTier)
        let style = barBoatStyle(s)
        if let shown = barShown, shown.model == m, shown.style == style,
           shown.colourful == colourfulIcon, shown.height == h {
            checkBarFit()
            return
        }
        button.image = barImage(m, boat: style, colourful: colourfulIcon, height: h)
        button.title = ""
        button.imagePosition = .imageOnly
        barShown = (m, style, colourfulIcon, h)
        // A new width is when macOS decides again whether the item fits.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.checkBarFit() }
    }

    /// AUTOMATIC'S ONE SIGNAL, and it was measured rather than assumed. An item macOS
    /// has no room for keeps its window, but the window is parked OFF-SCREEN (y = -30)
    /// and its `screen` is nil - while `occlusionState` still claims it is visible,
    /// so occlusion cannot be used. (Probed with items of 60 to 5,000pt on this Mac.)
    /// Other apps' items cannot be measured at all on this macOS - the whole bar is
    /// one MenuBarAgent window - so "am I hidden" is the only question answerable.
    /// Hidden for a second (not a single frame of a display change) steps Automatic
    /// down one size; a chosen size that does not fit is reported in Settings.
    /// Skipped while the menu bar itself is hidden (a full-screen app), when every
    /// item is off-screen and none of it means anything.
    func checkBarFit() {
        guard !dryRun, let win = statusItem?.button?.window, NSMenu.menuBarVisible() else { return }
        // `screen == nil` ALONE: a display arranged below the main one has negative y,
        // so a coordinate test would call a visible item hidden there. (Review finding;
        // the off-screen parking measured with screen == nil every time.)
        let hidden = win.screen == nil
        guard hidden else { barHiddenSince = nil; barHidden = false; return }
        guard let since = barHiddenSince else {
            barHiddenSince = Date()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.checkBarFit() }
            return
        }
        guard Date().timeIntervalSince(since) >= 1 else { return }
        barHiddenSince = nil
        if BarSize.current == .automatic, let smaller = barTier.smaller {
            let app = NSWorkspace.shared.frontmostApplication
            let name = app?.localizedName ?? "the frontmost app"
            barFitNote = "\(barTier.title) did not fit in the menu bar while \(name) was in front, so Deckhand uses \(smaller.title) there."
            NSLog("Deckhand: %@", barFitNote)
            fitByApp[app?.bundleIdentifier ?? ""] = smaller
            barShown = nil
            refresh()
        } else {
            barHidden = true
        }
    }

    /// The space in the menu bar is a property of the DISPLAYS, so it is worth asking
    /// again only when they change - a display plugged in, the lid opened, the Mac
    /// waking. Retrying on a timer would make the item flicker out and back.
    func resetBarFit() {
        fitTier = barStartTier()
        fitByApp = [:]
        barFitNote = ""
        barHidden = false
        barShown = nil
        refresh()
    }

    func setBarSize(_ size: BarSize) {
        BarSize.current = size
        resetBarFit()
    }

    func run(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        do { try p.run(); p.waitUntilExit() } catch { NSLog("Deckhand: \(path) failed: \(error)") }
    }

    // Force-clear any wedged/stale host first (`open` won't relaunch an app
    // macOS still thinks is running, so a frozen node would just get
    // re-activated), then launch a fresh one.
    func startHost() {
        if isBundled { startBundledHost(); return }
        if isSupervised() {
            // `bootstrap` via the service script, so the agent is loaded and KeepAlive
            // takes over from here. No pkill: there is nothing to force-clear, and
            // killing first would just race the supervisor.
            run("/bin/bash", [serviceScript(), "start"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.refresh() }
            return
        }
        // Unsupervised: force-clear any wedged host first, because `open` will not
        // relaunch an app macOS still believes is running - a frozen node would simply
        // be re-activated.
        run("/usr/bin/pkill", ["-9", "-f", hostScript()])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.run("/usr/bin/open", [hostApp(), "--args", hostScript()])
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.refresh() }
        }
    }

    func stopHost() {
        if isBundled {
            // unregister() unloads the job, which is the only real stop under
            // KeepAlive - the same meaning as deckhand-service.sh stop. Start
            // registers it again.
            do { try hostAgent().unregister() } catch { NSLog("Deckhand: unregister failed: \(error)") }
            // And any host OUTSIDE the agent - the one setup opens for the Bluetooth
            // prompt, if its window was closed mid-prompt. unregister() cannot see it,
            // and a Stop that leaves a host running is no stop. (Review finding.)
            _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
            ServiceState.shared.refresh()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refresh() }
            return
        }
        if isSupervised() {
            // `bootout` UNLOADS the job, which is the only thing that actually stops it.
            // A plain kill is reversed by KeepAlive within a second.
            run("/bin/bash", [serviceScript(), "stop"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refresh() }
            return
        }
        run("/usr/bin/pkill", ["-f", hostScript()]) // graceful
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
    }

    @objc func toggleHost() {
        // One at a time: a second click while the first is still landing would
        // otherwise reverse it (Stop, then Start against the old heartbeat).
        guard hostAction == nil else { return }
        if readStatus().running {
            wantRunning = false
            downSince = nil
            beginHostAction(.stopping) { [weak self] in self?.stopHost() }
        } else {
            wantRunning = true
            lastRestart = Date() // don't let the watchdog also fire right now
            downSince = nil
            beginHostAction(.starting) { [weak self] in self?.startHost() }
        }
    }

    // ---- what the Settings window does -------------------------------------
    //
    // One function per setting, each doing EXACTLY what its menu item used to do
    // (the same trigger-file line, the same UserDefaults key), so moving a control
    // from a submenu into a window changed where it is and nothing about what it
    // means. The window never writes either store itself.

    /// Write one line to the host's trigger file, then re-read twice: once at once,
    /// so the window shows the choice before the host has acted, and once after the
    /// host has had a tick to make it true.
    func sendCommand(_ line: String) {
        try? line.write(toFile: commandTriggerPath, atomically: true, encoding: .utf8)
        refresh()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.refresh() }
    }

    // Purely a Mac-side display choice - nothing is written to the command file
    // and the host is not told, because the host does not care what its own
    // numbers are rendered as.
    func setBarPref(_ pref: BarPref, _ on: Bool) {
        UserDefaults.standard.set(on, forKey: pref.rawValue)
        refresh()
    }

    func setColourfulIcon(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: "colourfulIcon")
        refresh()
    }

    // Picking a sound PLAYS it, which is the only way to judge one, and Off is
    // silent for the same reason - a preview of silence is not a thing.
    func setAskSound(_ name: String) {
        UserDefaults.standard.set(name, forKey: "askSound")
        playAskSound()
        refresh()
    }

    func setLaunchAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            alert("Couldn't change the login item",
                  "\(error.localizedDescription)\n\nMoving Deckhand to the Applications folder usually fixes it.")
        }
        // pullServices() too, like every other setter here: without it the switch
        // read the stale `login` until the 15s timer, so it snapped back after a
        // click and looked like it had not taken (measured 2026-11-11: four
        // register() calls in one second from one person turning it on).
        ServiceState.shared.refresh { [weak self] in
            self?.settingsWindow?.model.pullServices()
            self?.refresh()
        }
    }

    // On (the default) the device can answer prompts as well as show them, and
    // that costs the Mac nothing - Claude Code's dialog stays on screen the whole
    // time, so the two surfaces race and the first answer wins. No confirmation
    // needed in either direction; off simply makes the device read-only.
    func setRemoteAnswer(_ on: Bool) { sendCommand("REMOTE \(on ? "on" : "off")") }

    // Switching is instant and harmless (the host just re-points its BLE scan),
    // so no confirmation - unlike Forget, which destroys a key. "" = any device.
    func selectDevice(_ name: String) { sendCommand("SELECT \(name)") }

    /// WHICH of the sixteen is live. The host has already resolved env-vs-file
    /// (resolveMacEmoji, env wins), so s.icon IS the live value whichever source
    /// it came from. That reading is only fresh while the host is running; with it
    /// down, fall back to what was last picked here, so the choice survives a
    /// relaunch instead of going blank.
    func currentIcon(_ s: HostStatus) -> String {
        s.running ? s.icon : (UserDefaults.standard.string(forKey: "macIcon") ?? "")
    }

    // Writes EMOJI <name> - the mechanism SELECT and FORGET use - and stores it in
    // UserDefaults so the choice is right immediately and survives a relaunch even
    // before the host's heartbeat catches up. Validating the name and persisting it
    // to ~/.claude/deckhand-mac-emoji both happen on the host (host/mac-emoji.mjs)
    // and are deliberately NOT repeated here.
    func setIcon(_ name: String) {
        UserDefaults.standard.set(name, forKey: "macIcon")
        sendCommand("EMOJI \(name)")
    }

    // MACTAG <name>; a bare MACTAG returns to the automatic name. The host
    // sanitises (letters and digits, lowercase, 6 at most - the device's fonts are
    // ASCII and the tag lane is measured for six) and persists it to
    // ~/.claude/deckhand-mac-tag; none of that is repeated here, so the two can
    // never disagree.
    func setMacName(_ name: String) {
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        sendCommand(typed.isEmpty ? "MACTAG" : "MACTAG \(typed)")
    }

    // Drop this pairing and its key. The device keeps its own copy until a new
    // Mac re-provisions it, so this is reversible by plugging it back in. Named
    // explicitly, so it forgets the one the person clicked, not whatever is
    // current by the time the host reads the trigger file.
    func forgetDevice(_ name: String) {
        let a = NSAlert()
        a.messageText = "Forget \(name)?"
        a.informativeText = "This Mac drops that device's pairing key. It re-pairs automatically the next time you connect it over USB; your other paired devices are unaffected.\n\nTo clear the device's own side too, use its \"Reset pairing\" button (Settings \u{203A} Actions), or forget just this Mac from Settings \u{203A} Paired Macs."
        a.addButton(withTitle: "Forget")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        sendCommand("FORGET \(name)")
    }

    @objc func openSettings() { showSettings(pane: nil) }

    // ---- keeping Settings in front across a trip to the status menu ----------
    //
    // Opening the status menu takes focus from the app, and macOS used to drop the
    // Settings window behind every other window when it did (user report). So: if
    // Settings was the window in front when the menu opened (key, or key until a
    // moment ago - the click on the menu takes key first), it is brought back when
    // the menu closes. If it was merely open behind another app, it is left there:
    // glancing at the menu must not drag a window over whatever you were doing.
    // A menu action that opens a window (Pair New Device) runs AFTER this, so that
    // window still ends up on top.
    private static var settingsFrontAtMenuOpen = false
    func menuWillOpen(_ menu: NSMenu) {
        guard let w = settingsWindow, w.window.isVisible else { AppDelegate.settingsFrontAtMenuOpen = false; return }
        AppDelegate.settingsFrontAtMenuOpen = w.window.isKeyWindow || Date().timeIntervalSince(w.resignedKeyAt) < 1.0
    }
    func menuDidClose(_ menu: NSMenu) {
        guard AppDelegate.settingsFrontAtMenuOpen, let w = settingsWindow, w.window.isVisible else { return }
        AppDelegate.settingsFrontAtMenuOpen = false
        NSApp.activate(ignoringOtherApps: true)
        w.window.makeKeyAndOrderFront(nil)
    }

    func showSettings(pane: SettingsPane?) {
        if settingsWindow == nil {
            settingsWindow = SettingsWindowController(app: self)
            // A fresh controller after a close: put back the pane that was showing.
            if pane == nil { settingsWindow?.tabs.selectedTabViewItemIndex = lastSettingsPane }
        }
        settingsWindow?.model.pull(readStatus(), bar: statusItem?.button)
        ServiceState.shared.refresh { [weak self] in
            self?.settingsWindow?.model.pullServices()
        }
        settingsWindow?.show(pane: pane)
    }

    /// Jump to where the session actually LIVES, falling back to the folder. It
    /// used to always reveal in Finder, which was the only thing the menu knew how
    /// to do before the hook started stamping the owning app.
    @objc func openSessionFolder(_ item: NSMenuItem) {
        guard let r = item.representedObject as? SessionRow else { return }
        performTarget(sessionTarget(r))
    }

    // ---- wireless pairing --------------------------------------------------

    /// The one pairing row in the menu. It is never disabled - `openPairWindow`
    /// works in every state, and the window explains the ones it cannot act in.
    /// The title carries the live state so the menu still ANSWERS "is something
    /// pairing right now?" without opening anything.
    func rebuildPairRow(_ s: HostStatus) {
        pairItem.isEnabled = true
        pairItem.title = pairInFlight(s)
            ? "Pairing with \(s.pairing.name.isEmpty ? "a device" : s.pairing.name)\u{2026}"
            : "Pair New Device\u{2026}"
        // One wording for a sighting and for a state, shared with the window.
        pairItem.toolTip = pairStatusText(s)
    }

    /// Build it once and keep it: an .accessory app has nothing else holding the
    /// window alive, and re-creating it would drop the scroll position, the key
    /// view and the frame every time the phase changed.
    func pairWindowEnsured() -> PairWindow {
        if let w = pairWindow { return w }
        let w = PairWindow(target: self)
        w.onClose = { [weak self] in self?.pairWindowClosed() }
        pairWindow = w
        return w
    }

    func pairRender(_ s: HostStatus) {
        pairWindow?.render(pairWindowModel(s, pairLocal))
    }

    /// OPENING THE WINDOW STARTS A SCAN, for the reason the submenu did: looking
    /// for devices is the only thing anyone opens it to do, and a surface that
    /// needs a second click before it can list anything looks broken. Guarded, so
    /// arriving here during an exchange (the window can be re-raised by
    /// `pairTick`) cannot disturb one.
    @objc func openPairWindow() {
        let s = readStatus()
        let w = pairWindowEnsured()
        pairLocal = pairLocalNext(s.pairing, pairLocal)
        w.render(pairWindowModel(s, pairLocal))
        w.show(activate: true)
        startPairTicker()
        if pairCanStart(s) && s.pairing.state != "scanning" && !dryRun { pairSend("PAIRSCAN") }
    }

    /// While the window is up the heartbeat is read every second. Nothing else
    /// changes - `refresh()` is the same function the 3s timer calls, and it is
    /// idempotent; this only shortens the wait for the six digits.
    func startPairTicker() {
        guard pairTicker == nil, !dryRun else { return }
        pairTicker = Timer.scheduledTimer(withTimeInterval: PAIR_TICK_SEC, repeats: true) {
            [weak self] _ in self?.refresh()
        }
    }

    /// AN EXCHANGE MUST NEVER BE LEFT RUNNING WITH NO SURFACE. Closing the window
    /// mid-exchange therefore cancels it rather than hiding it - the window says
    /// so in its footer while that is true, so it is a stated consequence and not
    /// a surprise. Nothing was stored either way; the cost of being wrong is one
    /// more click on Scan.
    func pairWindowClosed() {
        pairTicker?.invalidate()
        pairTicker = nil
        let s = readStatus()
        if pairInFlight(s) && !dryRun { pairSend("PAIRCANCEL") }
        pairLocal = PairLocal()
    }

    /// The window's own re-render, plus the one thing that still needs an EDGE:
    /// whether to bring it in front of the person. `pairNext` decides that, and it
    /// decides it exactly as it decided whether to raise a modal - including the
    /// rule that two identical failures in a row are both reported, because a
    /// second attempt that says nothing is indistinguishable from a slow one.
    func pairTick(_ s: HostStatus) {
        pairLocal = pairLocalNext(s.pairing, pairLocal)
        let (action, seen) = pairNext(s.pairing, pairSeen)
        pairSeen = seen
        if let w = pairWindow, w.window.isVisible { w.render(pairWindowModel(s, pairLocal)) }
        // A scan or a sighting is not worth interrupting for; a comparison, a
        // success and a failure are - and a comparison has a 120-second deadline
        // running under it. Except on the very first tick, where a terminal state
        // is left over from before this app started: see pairWorthRaising.
        let first = !pairPrimed
        pairPrimed = true
        guard pairWorthRaising(action, firstTick: first) else { return }
        let w = pairWindowEnsured()
        w.render(pairWindowModel(s, pairLocal))
        w.show(activate: true)
        startPairTicker()
    }

    /// Every pairing verb goes out through the same trigger file `SELECT`,
    /// `FORGET` and `EMOJI` already use. The host intercepts all four; none is
    /// forwarded to the device.
    func pairSend(_ command: String) {
        try? command.write(toFile: commandTriggerPath, atomically: true, encoding: .utf8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
    }

    @objc func pairScan() {
        pairLocal = PairLocal()
        pairSend("PAIRSCAN")
    }

    /// Picking a device names it explicitly, the way SELECT and FORGET do, so the
    /// host starts the exchange with the row that was CLICKED rather than with
    /// whatever is topmost by the time it reads the file - and the name comes out
    /// of the model the window last rendered, so a row can never start an exchange
    /// with a sighting that has since dropped off the list.
    @objc func pairRow(_ sender: NSButton) {
        guard let m = pairWindow?.model, sender.tag >= 0, sender.tag < m.devices.count else { return }
        let name = m.devices[sender.tag].name
        guard !name.isEmpty else { return }
        pairLocal = PairLocal()
        pairSend("PAIRSTART \(name)")
    }

    /// One selector for every phase's pair of buttons; the ROLE is the tag the
    /// model put there. Each arm updates `pairLocal` BEFORE sending, because the
    /// host republishes on its own clock and the window re-renders in the gap -
    /// leaving two live buttons over a question already answered.
    @objc func pairButton(_ sender: NSButton) {
        switch PairButtonRole(rawValue: sender.tag) ?? .none {
        case .match:
            // NOTHING IS COMMITTED BY THIS BUTTON. It sends the proof, which only
            // tells the device that the peer it did the ECDH with is the one that
            // answered; the key is stored when a finger touches CONFIRM on the
            // glass. That tap is the presence proof the cable used to be.
            pairLocal.answered = pairWindow?.model.code ?? ""
            pairSend("PAIRCONFIRM")
        case .decline, .cancel:
            pairLocal = PairLocal(answered: "", cancelling: true)
            pairSend("PAIRCANCEL")
        case .close:
            pairWindow?.window.performClose(nil)
            return
        case .none:
            return
        }
        pairRender(readStatus())
    }

    @objc func openLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    @objc func quit() { NSApp.terminate(nil) }
}
