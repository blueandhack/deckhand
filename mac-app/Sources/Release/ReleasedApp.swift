import Cocoa
import ServiceManagement

// MARK: - The released app: its host, its hooks, its setup, its uninstall
//
// Everything in Release/ and Setup/ runs only when isBundled. The dev build compiles
// it and never reaches it, which keeps one set of sources and one set of renderers
// for both.

/// Running from the DMG, or from the read-only copy Gatekeeper makes of an app that
/// was opened where it was downloaded. The hooks would point INTO that path, and the
/// agent's program with them, and both vanish when the disk image is ejected.
func runningFromTemporaryLocation() -> Bool {
    bundlePath.contains("/AppTranslocation/") || bundlePath.hasPrefix("/Volumes/")
}

/// A host from a source checkout (install.sh's agent, or DeckhandBLE.app opened by the
/// dev menu app). Two hosts fight over the serial port and over BLE, and they share
/// one heartbeat path, so this menu could not even tell which one it was reading.
func legacyHostPresent() -> Bool {
    FileManager.default.fileExists(atPath: launchdPlist())
        || runCapture("/usr/bin/pgrep", ["-f", "DeckhandBLE.app"]).status == 0
        || legacyMenuAppRunning()
}

/// The repo-built menu app (com.deckhand.menubar). Quitting it is not enough on its
/// own: it is usually a LOGIN ITEM, so it came back at the next login as a second
/// boat in the menu bar - and one app cannot remove another's login item, so setup
/// opens Login Items for the person to do it (stopLegacyHost).
func legacyMenuAppRunning() -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: "com.deckhand.menubar").isEmpty
}

/// Stop the checkout's host for good, without deleting anything: unload its agent,
/// MOVE its plist into ~/Deckhand-backups (so it does not return at login), quit the
/// dev menu app and clear its "keep the host running" intent, since its watchdog
/// would otherwise open DeckhandBLE.app again within a minute.
func stopLegacyHost() {
    _ = runCapture("/bin/launchctl", ["bootout", "gui/\(getuid())/com.deckhand.host"])
    let fm = FileManager.default
    if fm.fileExists(atPath: launchdPlist()) {
        let dir = (NSHomeDirectory() as NSString).appendingPathComponent("Deckhand-backups")
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let stamp = Int(Date().timeIntervalSince1970)
        try? fm.moveItem(atPath: launchdPlist(), toPath: "\(dir)/com.deckhand.host.plist-\(stamp)")
    }
    UserDefaults(suiteName: "com.deckhand.menubar")?.set(false, forKey: "wantRunning")
    let menuApp = legacyMenuAppRunning()
    for a in NSRunningApplication.runningApplications(withBundleIdentifier: "com.deckhand.menubar") { a.terminate() }
    _ = runCapture("/usr/bin/pkill", ["-f", "DeckhandBLE.app"])
    if menuApp { DispatchQueue.main.async { SMAppService.openSystemSettingsLoginItems() } }
}

/// Run a tool to completion and keep what it said - the installers' output is what
/// an error alert quotes, so "it failed" never arrives without its reason.
@discardableResult
func runCapture(_ path: String, _ args: [String]) -> (status: Int32, out: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, error.localizedDescription) }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

/// One line into the host's own log, so "why did the host restart at 3am" is
/// answered where anyone would look. Appended whole (one write of one line), the
/// same way the host appends, so the two cannot interleave mid-line.
func noteInHostLog(_ text: String) {
    let f = ISO8601DateFormatter()
    let line = "\(f.string(from: Date())) \(text)\n"
    if let h = FileHandle(forWritingAtPath: logPath) {
        h.seekToEndOfFile()
        h.write(line.data(using: .utf8)!)
        try? h.close()
    }
    NSLog("Deckhand: %@", text)
}

/// When the heartbeat was last written. readStatus() only says "under 12s old", which
/// cannot tell a host that just started from one that was killed 3 seconds ago.
func heartbeatDate() -> Date? {
    (try? FileManager.default.attributesOfItem(atPath: heartbeatPath))?[.modificationDate] as? Date
}
