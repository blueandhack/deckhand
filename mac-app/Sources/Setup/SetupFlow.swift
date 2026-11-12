import Cocoa
import ServiceManagement

/// First run, as one window that always shows the NEXT thing to do. The step is
/// derived from the machine every second rather than remembered, so a window left
/// open while the user drags the app, or runs install.sh in a terminal, follows.
final class SetupFlow: NSObject {
    enum Step { case location, conflict, hooks, start, done }
    enum Phase: Equatable {
        case idle
        case working                    // a background job (hooks, stopping the old host)
        case prompting(Date)            // the helper is open, waiting on the Bluetooth answer
        case bleRefused
        case handingOver(Date)          // the agent is registered, waiting on its first beat
        case failed(String)
    }
    static var done: Bool {
        get { UserDefaults.standard.bool(forKey: "setupDone") }
        set { UserDefaults.standard.set(newValue, forKey: "setupDone") }
    }
    static var hooksDecided: Bool {
        get { UserDefaults.standard.bool(forKey: "hooksDecided") }
        set { UserDefaults.standard.set(newValue, forKey: "hooksDecided") }
    }

    weak var app: AppDelegate?
    var win: SetupWindow!
    var phase = Phase.idle
    var timer: Timer?
    /// --setup-preview only: render a step the machine is not in.
    var forcedStep: Step?

    init(app: AppDelegate) {
        self.app = app
        super.init()
        win = SetupWindow(target: self, primary: #selector(primary), secondary: #selector(secondary))
        win.onClose = { [weak self] in
            guard let self = self else { return }
            self.timer?.invalidate(); self.timer = nil
            // Closed mid-prompt: the helper opened for Bluetooth is running OUTSIDE
            // launchd, and nothing else would ever stop it. (Review finding.)
            if case .prompting = self.phase {
                _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
                self.phase = .idle
            }
            // Closed on the last step is the same as Done - otherwise setup reopened
            // at every launch and the hang watchdog (which waits for setup) never ran.
            if self.step() == .done { SetupFlow.done = true }
        }
    }

    func show() {
        render()
        win.show()
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        }
    }

    /// The two facts step() needs that cost a process or a daemon call (pgrep for an
    /// old host, the agent's status). Read off the main thread by tick() and cached,
    /// so a once-a-second render never blocks on them. (Review finding.)
    var factLegacy = legacyHostPresent()
    var factAgentEnabled = hostAgent().status == .enabled
    private var factsInFlight = false
    func refreshFacts() {
        guard !factsInFlight else { return }
        factsInFlight = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let legacy = legacyHostPresent(), enabled = hostAgent().status == .enabled
            DispatchQueue.main.async {
                self?.factLegacy = legacy
                self?.factAgentEnabled = enabled
                self?.factsInFlight = false
                self?.render()
            }
        }
    }

    func step() -> Step {
        if let f = forcedStep { return f }
        if runningFromTemporaryLocation() { return .location }
        if factLegacy { return .conflict }
        if !SetupFlow.hooksDecided { return .hooks }
        if !factAgentEnabled { return .start }
        return .done
    }

    func tick() {
        refreshFacts()
        let s = readStatus()
        let beat = heartbeatDate()
        switch phase {
        case .prompting(let since):
            // A beat from BEFORE the helper was opened is the last host's, and so is
            // its `ble`. Only a fresh one answers the question.
            if let b = beat, b > since, let ble = s.ble {
                if ble == "unauthorized" { phase = .bleRefused }
                else if ble == "poweredOn" || ble == "poweredOff" { handOver() }
            } else if Date().timeIntervalSince(since) > 120 {
                _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
                phase = .failed("The host did not report back within two minutes. The host log (Settings \u{203A} About \u{203A} Host log) says why; then try again.")
            }
        case .handingOver(let since):
            if let b = beat, b > since.addingTimeInterval(1) {
                phase = .idle
                app?.wantRunning = true
                app?.refresh()
            } else if Date().timeIntervalSince(since) > 60 {
                phase = .failed("The background host was registered but has not started. The host log (Settings \u{203A} About \u{203A} Host log) says why.")
            }
        default: break
        }
        render()
    }

    func model() -> SetupModel {
        var m = SetupModel()
        let st = step()
        let order: [Step] = [.location, .hooks, .start]
        let names = ["In Applications", "Claude Code hooks", "Background host"]
        let rank: (Step) -> Int = { [.location: 0, .conflict: 1, .hooks: 1, .start: 2, .done: 3][$0]! }
        m.steps = order.enumerated().map { i, sname in
            let r = rank(st)
            if i == 1 && r > 1 && !Hooks.consented { return (names[i], 3) }
            return (names[i], i < r ? 2 : (i == r ? 1 : 0))
        }
        _ = order

        if case .failed(let why) = phase {
            m.title = "Something went wrong"
            m.detail = why
            m.primary = "Try Again"
            m.secondary = "Close"
            return m
        }
        switch st {
        case .location:
            m.title = "Move Deckhand to Applications first"
            m.detail = bundlePath.hasPrefix("/Volumes/")
                ? "Deckhand is running from its disk image. Its hooks and background host would point into the image and stop working when it is ejected.\n\nQuit, drag Deckhand into the Applications folder, and open it from there."
                // A translocated path does not say where the original is: opening
                // from the DMG lands here too (measured), not in the /Volumes case.
                : "macOS is running Deckhand from a temporary read-only copy, because it was opened from the disk image or the Downloads folder. Its hooks would point at that copy, which macOS removes.\n\nQuit, drag Deckhand into the Applications folder in Finder, and open it from there."
            m.primary = "Quit"
        case .conflict:
            m.title = "Deckhand is already running from a source checkout"
            m.detail = "A host started from the repo (install.sh, or the menu app built by mac-app/build.sh) is running or set to start at login. Two hosts would fight over the USB port and Bluetooth.\n\nStop it will unload com.deckhand.host, move its plist into ~/Deckhand-backups so it does not come back at login, and quit the old menu app. If that app opens at login, Login Items opens next so you can remove it there. The checkout itself is not touched, and deckhand-service.sh install puts it back."
            m.primary = "Stop It"
            m.secondary = "Quit"
        case .hooks:
            let st = Hooks.state()
            m.title = st == .fromSource ? "Switch the hooks to Deckhand's own Node" : "Connect Claude Code"
            var lines = [
                "Deckhand learns what your sessions are doing from Claude Code hooks. To set them up it will:",
                "\u{2022} back up ~/.claude\(Hooks.codexPresent ? " and ~/.codex" : "") into ~/Deckhand-backups",
                "\u{2022} copy deckhand-session-hook.mjs and deckhand-statusline.mjs into ~/.claude, with a link to Deckhand's own Node beside them",
                "\u{2022} add one hook to nine events in ~/.claude/settings.json\(st == .fromSource ? ", replacing the ones install.sh added" : "")",
                Hooks.foreignStatusLine()
                    ? "\u{2022} leave your status line as it is (the quota then comes from the usage endpoint alone)"
                    : "\u{2022} set the status line, which is how Claude Code reports your quota",
            ]
            if Hooks.codexPresent && Hooks.codexWanted { lines.append("\u{2022} add hooks to ~/.codex/hooks.json; Codex asks you to trust them the next time it starts (Settings \u{203A} Claude Code can turn these off)") }
            lines.append("\nEverything else in those files stays as it is. Remove in Deckhand's Settings \u{203A} Claude Code takes them out again.")
            m.detail = lines.joined(separator: "\n")
            m.primary = "Install Hooks"
            m.secondary = "Not Now"
        case .start:
            switch phase {
            case .prompting:
                m.title = "Allow Bluetooth"
                m.detail = "macOS is asking whether \u{201C}Deckhand Host\u{201D} may use Bluetooth. Allow it so the display can connect without a cable.\n\nIf no question appeared, Bluetooth was already decided; this continues on its own."
                m.busy = true
            case .bleRefused:
                m.title = "Bluetooth was not allowed"
                m.detail = "Deckhand will work over USB only. To use Bluetooth later, turn on Deckhand Host in System Settings \u{203A} Privacy & Security \u{203A} Bluetooth, then Stop and Start Deckhand from the menu."
                m.primary = "Continue with USB Only"
                m.secondary = "Open Bluetooth Settings"
            default:
                m.title = "Start Deckhand"
                m.detail = "Deckhand's host runs in the background, so the display keeps updating with this menu closed. It starts at login and restarts if it stops; the menu's Stop Deckhand turns it off until you start it again.\n\nmacOS will ask once whether it may use Bluetooth."
                m.primary = "Start"
                m.busy = phase == .working
            }
        case .done:
            if case .handingOver = phase {
                m.title = "Starting\u{2026}"
                m.detail = "Handing the host to macOS so it starts at login."
                m.busy = true
                return m
            }
            m.title = "Deckhand is running"
            var d = "Plug your Deckhand display in over USB and it connects on its own. For Bluetooth, choose Pair New Device\u{2026} in the menu.\n\nDeckhand lives in the menu bar; there is no window to come back to."
            if readStatus().ble == "unauthorized" { d += "\n\nBluetooth is not allowed, so only USB will connect." }
            if !Hooks.consented { d += "\n\nThe Claude Code hooks are not installed, so the display will not show sessions. Install them in Deckhand's Settings \u{203A} Claude Code." }
            m.detail = d
            m.primary = "Done"
        }
        return m
    }

    func render() { win.render(model()) }

    @objc func primary() {
        if case .failed = phase { phase = .idle; render(); return }
        switch step() {
        case .location: NSApp.terminate(nil)
        case .conflict:
            background { stopLegacyHost() }
        case .hooks:
            background {
                if let err = Hooks.install() { return err }
                SetupFlow.hooksDecided = true
                return nil
            }
        case .start:
            if phase == .bleRefused { handOver() } else { beginStart() }
        case .done:
            // handOver() is the only other place the menu becomes a login item, and
            // step() skips it when the host agent is ALREADY enabled (a reinstall
            // that kept the agent, or `Deckhand --host start` from flash.sh). The
            // host then started at login and the menu did not. First run only:
            // SetupFlow.done keeps this from overriding a later "off".
            if isBundled, ServiceState.shared.login == .notRegistered {
                try? SMAppService.mainApp.register()
                ServiceState.shared.refresh()
            }
            SetupFlow.done = true
            win.window.close()
        }
    }

    @objc func secondary() {
        if case .failed = phase { win.window.close(); return }
        switch step() {
        case .conflict: NSApp.terminate(nil)
        case .hooks:
            SetupFlow.hooksDecided = true
            render()
        case .start where phase == .bleRefused:
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth")!)
        default: break
        }
    }

    /// Off the main thread, with the window showing it is busy; an error string ends
    /// in .failed so it is read, not lost.
    func background(_ job: @escaping () -> String?) {
        phase = .working
        render()
        DispatchQueue.global(qos: .userInitiated).async {
            let err = job()
            DispatchQueue.main.async { [weak self] in
                self?.phase = err.map { .failed($0) } ?? .idle
                self?.app?.refresh()
                self?.render()
                // The step that job finished must not linger for up to a second
                // on cached facts.
                self?.refreshFacts()
            }
        }
    }
    func background(_ job: @escaping () -> Void) { background { job(); return nil } }

    /// BLUETOOTH IS ASKED FOR BY OPENING THE HELPER, the way install.sh asks for it
    /// with DeckhandBLE.app: an app opened by the user gets a normal TCC prompt. The
    /// permission belongs to the helper's identity, so the agent - which execs the
    /// very same signed binary - inherits it. Whether a launchd-started process
    /// could raise the prompt by itself is not verified, so it is not relied on.
    func beginStart() {
        _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
        let since = Date()
        phase = .prompting(since)
        render()
        _ = runCapture("/usr/bin/open", ["-n", "-g", helperApp, "--args", bundledHostScript])
    }

    /// The opened helper has answered the Bluetooth question. Stop it and hand the
    /// host to launchd, which from here on starts it at login and restarts it.
    func handOver() {
        _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
        phase = .handingOver(Date())
        render()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self else { return }
            do { try hostAgent().register() } catch {
                if hostAgent().status == .requiresApproval {
                    SMAppService.openSystemSettingsLoginItems()
                    self.phase = .failed("macOS needs you to allow Deckhand in System Settings \u{203A} General \u{203A} Login Items. Turn it on there, then try again.")
                } else {
                    self.phase = .failed("Could not register the background host: \(error.localizedDescription)")
                }
                self.render()
                return
            }
            // The menu itself at login too: it is how anyone sees the host is up.
            try? SMAppService.mainApp.register()
            self.phase = .handingOver(Date())
            self.render()
        }
    }
}
