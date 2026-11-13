import Cocoa
import ServiceManagement

extension AppDelegate {
    func startBundledHost() {
        let svc = hostAgent()
        switch svc.status {
        case .enabled:
            // Loaded but not answering: KeepAlive restarts a process that EXITS, not
            // one that hangs, so a stale heartbeat gets a kill-and-restart.
            run("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(agentLabel)"])
        case .requiresApproval:
            // Start may run off the main thread (beginHostAction); an alert may not.
            DispatchQueue.main.async {
                let a = NSAlert()
                a.messageText = "Deckhand is turned off in Login Items"
                a.informativeText = "macOS will not run Deckhand's background host until it is allowed again in System Settings \u{203A} General \u{203A} Login Items."
                a.addButton(withTitle: "Open Login Items")
                a.addButton(withTitle: "Cancel")
                NSApp.activate(ignoringOtherApps: true)
                if a.runModal() == .alertFirstButtonReturn { SMAppService.openSystemSettingsLoginItems() }
            }
        default:
            // Clear a stray host first (setup's Bluetooth-prompt one, if its window
            // was closed), or the agent's host would fight it for the port and BLE.
            _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
            do { try svc.register() } catch {
                let text = error.localizedDescription
                DispatchQueue.main.async {
                    let a = NSAlert()
                    a.messageText = "Couldn't start Deckhand's background host"
                    a.informativeText = text
                    NSApp.activate(ignoringOtherApps: true)
                    a.runModal()
                }
            }
        }
        ServiceState.shared.refresh()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.refresh() }
    }

    /// A first install (or a switch from install.sh's form) goes through the setup
    /// window's consent screen: it writes to ~/.claude/settings.json, which is the
    /// user's. A repair of what they already agreed to does not ask again.
    func installHooks() {
        if !Hooks.consented || ServiceState.shared.hooks == .fromSource {
            presentSetup(forceHooks: true)
            return
        }
        settingsWindow?.model.busy = true
        DispatchQueue.global(qos: .userInitiated).async {
            let err = Hooks.install()
            ServiceState.shared.refreshNow()
            DispatchQueue.main.async { [weak self] in
                self?.settingsWindow?.model.busy = false
                if let err = err { self?.alert("Couldn't install the hooks", err) }
                self?.settingsWindow?.model.pullServices()
                self?.refresh()
            }
        }
    }

    func setAntigravityHooks(_ on: Bool) {
        settingsWindow?.model.busy = true
        DispatchQueue.global(qos: .userInitiated).async {
            let err = Hooks.setAntigravity(on)
            ServiceState.shared.refreshNow()
            DispatchQueue.main.async { [weak self] in
                self?.settingsWindow?.model.busy = false
                if let err = err { self?.alert(on ? "Couldn't add the Antigravity hook" : "Couldn't remove the Antigravity hook", err) }
                self?.settingsWindow?.model.pullServices()
            }
        }
    }

    func setCodexHooks(_ on: Bool) {
        settingsWindow?.model.busy = true
        DispatchQueue.global(qos: .userInitiated).async {
            let err = Hooks.setCodex(on)
            ServiceState.shared.refreshNow()
            DispatchQueue.main.async { [weak self] in
                self?.settingsWindow?.model.busy = false
                if let err = err { self?.alert(on ? "Couldn't add the Codex hooks" : "Couldn't remove the Codex hooks", err) }
                self?.settingsWindow?.model.pullServices()
            }
        }
    }

    func removeHooks() {
        let a = NSAlert()
        a.messageText = "Remove Deckhand's Claude Code hooks?"
        a.informativeText = "Deckhand's entries come out of ~/.claude/settings.json\(Hooks.codexPresent ? " and ~/.codex/hooks.json" : ""), and its two scripts and Node link out of ~/.claude. Your own hooks and status line are left as they are, and a backup is taken first (~/Deckhand-backups).\n\nThe display stops showing sessions until they are installed again."
        a.addButton(withTitle: "Remove")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        settingsWindow?.model.busy = true
        DispatchQueue.global(qos: .userInitiated).async {
            let err = Hooks.remove()
            ServiceState.shared.refreshNow()
            DispatchQueue.main.async { [weak self] in
                self?.settingsWindow?.model.busy = false
                if let err = err { self?.alert("Some hooks could not be removed", err) }
                self?.settingsWindow?.model.pullServices()
                self?.refresh()
            }
        }
    }

    func alert(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    @objc func openSetup() { presentSetup(forceHooks: false) }

    func presentSetup(forceHooks: Bool) {
        if setup == nil { setup = SetupFlow(app: self) }
        if forceHooks { SetupFlow.hooksDecided = false }
        setup?.show()
    }

    @objc func checkForUpdates() {
        #if SPARKLE
        updater?.checkForUpdates(nil)
        #endif
    }

    /// The app's uninstall.sh: the same list, removed in the same order, and the same
    /// things KEPT - the pairing keys, ~/Deckhand-backups and ~/Deckhand-audio are
    /// the user's data, and a reinstall that has to re-pair every device over USB is
    /// a worse outcome than a few kilobytes left behind.
    @objc func uninstallDeckhand() {
        let a = NSAlert()
        a.messageText = "Uninstall Deckhand?"
        a.informativeText = """
            This stops Deckhand's background host, removes its hooks from Claude Code\(Hooks.codexPresent ? " and Codex" : ""), \
            deletes its session state in ~/.claude, and moves Deckhand to the Trash. A backup is taken first.

            Kept: your pairing keys (~/.claude/deckhand-secret), ~/Deckhand-backups and ~/Deckhand-audio. \
            Restart Claude Code afterwards so it stops running the hook.
            """
        a.addButton(withTitle: "Uninstall")
        a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }

        wantRunning = false
        // The slow part (stopping the agent, several Node runs for the hooks) off the
        // main thread, so the menu bar does not freeze while it happens.
        DispatchQueue.global(qos: .userInitiated).async {
            try? hostAgent().unregister()
            _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
            let err = Hooks.remove()
            DispatchQueue.main.async { [weak self] in self?.finishUninstall(hooksError: err) }
        }
    }

    /// STOPS SHORT of the Trash when the hooks could not be removed: they would
    /// still run `~/.claude/deckhand-node`, a link into this app, and a hook whose
    /// runner is in the Trash fails on every Claude Code event once it is emptied.
    /// The host is already stopped; fixing settings.json and uninstalling again
    /// finishes the job.
    func finishUninstall(hooksError err: String?) {
        if let err = err {
            alert("Uninstall stopped before removing Deckhand",
                  "Deckhand's background host is stopped, but its hooks could not be taken out of Claude Code's settings, so the app was left in place for them.\n\n\(err)")
            ServiceState.shared.refresh { [weak self] in self?.refresh() }
            return
        }
        let fm = FileManager.default
        for f in ["deckhand-sessions", "deckhand-answers", "deckhand-device-command",
                  "deckhand-session-hook-debug.log", "deckhand-session-hook-debug.log.1"] {
            try? fm.removeItem(atPath: claudeDir + "/" + f)
        }
        for f in ["host-alive", "host.log", "host.log.1", "oauth-usage.json", "oauth-backoff.json",
                  "oauth-attempt.json", "mic.wav"] {
            try? fm.removeItem(atPath: runtimeDir + "/" + f)
        }
        try? SMAppService.mainApp.unregister()
        if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id) }
        NSWorkspace.shared.recycle([URL(fileURLWithPath: bundlePath)]) { _, _ in NSApp.terminate(nil) }
    }
}
