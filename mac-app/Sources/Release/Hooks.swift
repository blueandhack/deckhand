import Cocoa

/// The Claude Code / Codex hooks, installed with the BUNDLED Node through runnerLink.
/// The installers are the repo's own (claude-hooks/), so the rules about what is ours
/// and what is yours are exactly install.sh's - see hook-command.mjs.
enum Hooks {
    static let scripts = ["deckhand-session-hook.mjs", "deckhand-statusline.mjs", "deckhand-antigravity-hook.mjs"]
    /// The person's choice for Codex's hooks, REMEMBERED - default on, as before. It
    /// has to be a stored choice and not just a removal: install() runs again after
    /// every update and on Reinstall, and used to add Codex's hooks back whenever
    /// ~/.codex exists, so removing them by hand lasted until the next update.
    static var codexWanted: Bool {
        get { UserDefaults.standard.object(forKey: "codexHooks") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "codexHooks") }
    }

    /// Add or take out ONLY Codex's hooks, and remember the choice. Backs up first,
    /// like every other change to the user's files. nil on success.
    static func setCodex(_ on: Bool) -> String? {
        lock.lock(); defer { lock.unlock() }
        codexWanted = on
        guard codexPresent else { return nil }
        _ = node("deckhand-backup.mjs", ["backup"])
        if on { try? pointRunner() }
        let r = node("install-codex-hooks.mjs", on ? ["--node", runnerLink] : ["--remove"])
        return r.status == 0 ? nil : r.out
    }

    static var codexPresent: Bool {
        FileManager.default.fileExists(atPath: (NSHomeDirectory() as NSString).appendingPathComponent(".codex"))
    }

    /// The same remembered choice for Antigravity's hook, default on, for the same
    /// reason as Codex's: install() reruns after every update.
    static var antigravityWanted: Bool {
        get { UserDefaults.standard.object(forKey: "antigravityHooks") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "antigravityHooks") }
    }
    /// ~/.gemini is where every Antigravity surface (the CLI, the app, the IDE) keeps
    /// its data and where its global hooks.json lives.
    static var antigravityPresent: Bool {
        FileManager.default.fileExists(atPath: (NSHomeDirectory() as NSString).appendingPathComponent(".gemini"))
    }
    /// Add or take out ONLY Antigravity's hook, and remember the choice. nil on success.
    static func setAntigravity(_ on: Bool) -> String? {
        lock.lock(); defer { lock.unlock() }
        antigravityWanted = on
        guard antigravityPresent else { return nil }
        _ = node("deckhand-backup.mjs", ["backup"])
        if on { try? pointRunner() }
        let r = node("install-antigravity-hooks.mjs", on ? ["--node", runnerLink] : ["--remove"])
        return r.status == 0 ? nil : r.out
    }
    /// Deckhand's hook is in ~/.gemini/config/hooks.json.
    static func antigravityInstalled() -> Bool {
        let f = (NSHomeDirectory() as NSString).appendingPathComponent(".gemini/config/hooks.json")
        return (try? String(contentsOfFile: f, encoding: .utf8))?.contains("deckhand-antigravity-hook.mjs") ?? false
    }
    /// The user agreed once. Updates then re-copy without asking again; Remove clears it.
    static var consented: Bool {
        get { UserDefaults.standard.bool(forKey: "hooksConsented") }
        set { UserDefaults.standard.set(newValue, forKey: "hooksConsented") }
    }

    static func node(_ script: String, _ args: [String]) -> (status: Int32, out: String) {
        runCapture(helperNode, [bundledHooksDir + "/" + script] + args)
    }

    static func pointRunner() throws {
        let fm = FileManager.default
        try fm.createDirectory(atPath: claudeDir, withIntermediateDirectories: true)
        if (try? fm.destinationOfSymbolicLink(atPath: runnerLink)) == helperNode { return }
        try? fm.removeItem(atPath: runnerLink)
        try fm.createSymbolicLink(atPath: runnerLink, withDestinationPath: helperNode)
    }

    /// nil on success, otherwise what went wrong in words. Backs up FIRST, and a
    /// failed backup stops it - install.sh's rule, because the copy below replaces two
    /// files the settings.json backup does not cover.
    /// install() and remove() run one at a time. The launch-time refresh runs on a
    /// background queue and Settings › Reinstall can land at the same moment; two
    /// installers reading the same settings.json and both writing would lose one.
    static let lock = NSLock()

    static func install() -> String? {
        lock.lock(); defer { lock.unlock() }
        do { try pointRunner() } catch { return "Could not create \(runnerLink): \(error.localizedDescription)" }
        let b = node("deckhand-backup.mjs", ["backup"])
        if b.status != 0 { return "The backup failed, so nothing was changed.\n\n\(b.out)" }
        let fm = FileManager.default
        for f in scripts {
            // Copied beside, then RENAMED over the old one: rename is atomic, so a hook
            // firing mid-update runs the old script or the new one, never a missing
            // file. (Delete-then-copy left a window with neither.)
            let dst = claudeDir + "/" + f, tmp = dst + ".deckhand-new"
            try? fm.removeItem(atPath: tmp)
            do {
                try fm.copyItem(atPath: bundledHooksDir + "/" + f, toPath: tmp)
                guard rename(tmp, dst) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            } catch {
                try? fm.removeItem(atPath: tmp)
                return "Could not copy \(f) into ~/.claude: \(error.localizedDescription)"
            }
        }
        let r = node("install-hooks.mjs", ["--node", runnerLink])
        if r.status != 0 { return "Installing the Claude Code hooks failed.\n\n\(r.out)" }
        if codexPresent && codexWanted {
            let c = node("install-codex-hooks.mjs", ["--node", runnerLink])
            if c.status != 0 { return "The Claude Code hooks are installed, but the Codex hooks failed.\n\n\(c.out)" }
        }
        if antigravityPresent && antigravityWanted {
            let a = node("install-antigravity-hooks.mjs", ["--node", runnerLink])
            if a.status != 0 { return "The Claude Code hooks are installed, but the Antigravity hook failed.\n\n\(a.out)" }
        }
        consented = true
        UserDefaults.standard.set(appBuild, forKey: "hooksBuild")
        return nil
    }

    /// Takes out exactly what install() put in, either form (hook-command.mjs), and
    /// leaves every other hook and the user's own statusLine alone.
    static func remove() -> String? {
        lock.lock(); defer { lock.unlock() }
        _ = node("deckhand-backup.mjs", ["backup"])
        var problems: [String] = []
        let r = node("install-hooks.mjs", ["--remove"])
        if r.status != 0 { problems.append(r.out) }
        if codexPresent {
            let c = node("install-codex-hooks.mjs", ["--remove"])
            if c.status != 0 { problems.append(c.out) }
        }
        if antigravityPresent {
            let a = node("install-antigravity-hooks.mjs", ["--remove"])
            if a.status != 0 { problems.append(a.out) }
        }
        // ONLY when the hooks are actually out of settings.json. If --remove failed (a
        // settings.json that is not valid JSON, say), the entries still name these
        // files, and deleting them would make every Claude Code event run a command
        // that cannot start - the failure install-hooks.mjs's own header warns about.
        guard problems.isEmpty else {
            return "Nothing was deleted: the hooks are still registered, so their scripts stay.\n\n" + problems.joined(separator: "\n")
        }
        for f in scripts + ["deckhand-node"] { try? FileManager.default.removeItem(atPath: claudeDir + "/" + f) }
        consented = false
        return nil
    }

    /// At every launch: keep the link pointing at THIS copy of the app, and after an
    /// update bring the scripts up to the new build. Silent, and only ever after the
    /// user said yes once.
    static func afterLaunch() {
        guard consented else { return }
        if UserDefaults.standard.string(forKey: "hooksBuild") != appBuild {
            if let err = install() { NSLog("Deckhand: hook refresh after update failed: \(err)") }
        } else {
            try? pointRunner()
        }
    }

    enum State { case installed, notInstalled, fromSource, needsRepair }

    static func state() -> State {
        let fm = FileManager.default
        guard let text = try? String(contentsOfFile: claudeDir + "/settings.json", encoding: .utf8),
              text.contains("deckhand-session-hook.mjs") else { return .notInstalled }
        // install.sh's bare-`node` form: works, but on whichever node is on PATH.
        if !text.contains("deckhand-node") { return .fromSource }
        // A dev build has no bundled Node of its own to compare the link against,
        // so the released app's hooks are simply "installed" from here - they are
        // not this build's to repair. (Found by looking at the window: it said
        // "Need repair" about a perfectly working install.)
        if !isBundled { return .installed }
        let linkOK = (try? fm.destinationOfSymbolicLink(atPath: runnerLink)) == helperNode
        let scriptsOK = scripts.allSatisfy {
            fm.contentsEqual(atPath: claudeDir + "/" + $0, andPath: bundledHooksDir + "/" + $0)
        }
        return linkOK && scriptsOK ? .installed : .needsRepair
    }

    /// Deckhand's hook is in ~/.codex/hooks.json, in either form.
    static func codexInstalled() -> Bool {
        let f = (NSHomeDirectory() as NSString).appendingPathComponent(".codex/hooks.json")
        return (try? String(contentsOfFile: f, encoding: .utf8))?.contains("deckhand-session-hook.mjs") ?? false
    }

    /// The statusLine is set only if there is none; say which, before asking.
    static func foreignStatusLine() -> Bool {
        guard let data = FileManager.default.contents(atPath: claudeDir + "/settings.json"),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sl = obj["statusLine"] as? [String: Any],
              let cmd = sl["command"] as? String else { return false }
        return !cmd.contains("deckhand-statusline.mjs")
    }
}
