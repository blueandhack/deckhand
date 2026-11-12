import Cocoa
import ServiceManagement

/// `--host stop|start|status`: the released app's background host, from a script.
/// flash.sh needs the USB port free for the upload, and the host is a launchd agent
/// with KeepAlive - a pkill is undone within seconds - so this goes through the same
/// SMAppService unregister/register the menu's Stop and Start use, the supported way
/// to stop and start it. Exits non-zero when the agent did not end up as asked.
func modeHost() {
    if let i = CommandLine.arguments.firstIndex(of: "--host"), CommandLine.arguments.count > i + 1 {
        guard isBundled else { print("--host: not the released app (no bundled host here)"); exit(2) }
        let svc = hostAgent()
        let hostRunning = { runCapture("/usr/bin/pgrep", ["-f", bundledHostScript]).status == 0 }
        switch CommandLine.arguments[i + 1] {
        case "stop":
            try? svc.unregister()
            _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
            for _ in 0..<40 where hostRunning() { usleep(250_000) }
            let ok = svc.status != .enabled && !hostRunning()
            print(ok ? "host stopped" : "host NOT stopped (agent \(svc.status.rawValue), process \(hostRunning() ? "still running" : "gone"))")
            exit(ok ? 0 : 1)
        case "start":
            _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
            do { try svc.register() } catch { print("host NOT started: \(error.localizedDescription)"); exit(1) }
            for _ in 0..<40 where !hostRunning() { usleep(250_000) }
            print(hostRunning() ? "host started" : "host registered but not running yet (agent \(svc.status.rawValue))")
            exit(svc.status == .enabled ? 0 : 1)
        case "status":
            print("agent \(svc.status == .enabled ? "enabled" : "not enabled (\(svc.status.rawValue))"), process \(hostRunning() ? "running" : "not running")")
            exit(0)
        default:
            print("--host: stop, start or status"); exit(2)
        }
    }
}

/// `--setup-do <conflict|hooks|skip-hooks|start|done>`: run ONE setup step's action,
/// the very function its button calls, from a terminal. A running Deckhand's setup
/// window shares these UserDefaults and re-derives its step every second, so it
/// follows along - which is how a first run is tested end to end on a Mac where
/// nothing may click the window. Prints what the step left behind and exits non-zero
/// on failure. Released app only: in a dev build there is no bundled host to set up.
func modeSetupDo() {
    if let i = CommandLine.arguments.firstIndex(of: "--setup-do"), CommandLine.arguments.count > i + 1 {
        guard isBundled else { print("--setup-do: not the released app (no bundled host here)"); exit(2) }
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        // Held strongly: SetupFlow's reference is weak, so a temporary AppDelegate was
        // gone at once and `start` never recorded wantRunning. (Review finding.)
        let owner = AppDelegate()
        owner.dryRun = true
        let flow = SetupFlow(app: owner)
        func finish(_ ok: Bool, _ msg: String) -> Never { print(msg); exit(ok ? 0 : 1) }
        switch CommandLine.arguments[i + 1] {
        case "conflict":
            stopLegacyHost()
            finish(!legacyHostPresent(), "legacy host present after stop: \(legacyHostPresent())")
        case "hooks":
            if let err = Hooks.install() { finish(false, "hooks: \(err)") }
            SetupFlow.hooksDecided = true
            finish(Hooks.state() == .installed, "hooks state: \(Hooks.state())")
        case "skip-hooks":
            SetupFlow.hooksDecided = true
            finish(true, "hooks skipped")
        case "start":
            flow.beginStart()
            let deadline = Date().addingTimeInterval(200)
            var last = ""
            while Date() < deadline {
                RunLoop.main.run(until: Date().addingTimeInterval(1))
                flow.tick()
                let now = "\(flow.phase)"
                if now != last { print("phase: \(now)  ble=\(readStatus().ble ?? "-")"); last = now }
                if flow.phase == .bleRefused { flow.handOver() }
                if case .failed(let why) = flow.phase { finish(false, "start failed: \(why)") }
                if flow.phase == .idle && hostAgent().status == .enabled { break }
            }
            if hostAgent().status == .enabled { owner.wantRunning = true }
            finish(hostAgent().status == .enabled && readStatus().running,
                   "agent=\(hostAgent().status.rawValue) running=\(readStatus().running) ble=\(readStatus().ble ?? "-")")
        case "done":
            SetupFlow.done = true
            finish(true, "setup marked done")
        default:
            finish(false, "--setup-do: unknown step")
        }
    }
}

/// `--sound-check [play]`: proves the needs-input sound without waiting for a real
/// prompt. It resolves every candidate name (a sound that has left the OS must
/// fail HERE, not silently at 3am) and drives `AskWatcher` through the sequence
/// that matters - launching with one already asking, the same one sitting there,
/// a second arriving, everything clearing, the first asking AGAIN, and two at
/// once. `play` also plays each sound, since a name tells you nothing about it.
/// `--open-session [<id-prefix>] [go]`: what a click on each session row would do,
/// resolved by the SAME `sessionTarget` the click calls. A menu cannot be clicked
/// from a script and cannot be screenshotted, so without this the whole three-tier
/// path is unverifiable except by hand. It prints by default and only acts when
/// given `go`, because a diagnostic that yanks windows around while you read its
/// output is its own problem.
func modeOpenSession() {
    if CommandLine.arguments.contains("--open-session") {
        let args = CommandLine.arguments
        let go = args.contains("go")
        let i = args.firstIndex(of: "--open-session")!
        let want = args.count > i + 1 && args[i + 1] != "go" ? args[i + 1] : ""
        let sessions = readStatus().sessions
        if sessions.isEmpty { print("no sessions") }
        for r in sessions where want.isEmpty || r.id.hasPrefix(want) {
            let t = sessionTarget(r)
            print("\(r.id)  \(r.name)")
            print("    app=\(r.app.isEmpty ? "<none>" : r.app) entry=\(r.appEntry.isEmpty ? "<none>" : r.appEntry)")
            print("    path=\(r.path)")
            print("    click -> \(describeTarget(t))")
            if go { performTarget(t); print("    (performed)") }
        }
        exit(0)
    }
}
