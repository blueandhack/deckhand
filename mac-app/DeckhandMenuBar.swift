// Deckhand menu-bar controller.
//
// A tiny LSUIElement (menu-bar-only) app that runs and monitors the Node host
// via the existing DeckhandBLE.app wrapper - it does NOT touch Bluetooth
// itself, so the host keeps its own proven CoreBluetooth/TCC path. Status is
// read from the host's heartbeat file and log; no IPC needed.
//
// Paths to the host come from the DeckhandHostDir Info.plist key, injected by
// build.sh at build time.

import Cocoa
import ServiceManagement

let heartbeatPath = "/tmp/deckhand-host-alive"
let logPath = "/tmp/deckhand-host.log"
// Drop a "FORGET" line here and the host clears its BLE pin (re-pairs to the
// next device connected over USB). Same trigger file the host watches for
// device commands like RECAL.
let commandTriggerPath = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/deckhand-device-command")

func hostDir() -> String {
    (Bundle.main.object(forInfoDictionaryKey: "DeckhandHostDir") as? String) ?? ""
}
func hostApp() -> String { hostDir() + "/DeckhandBLE.app" }
func hostScript() -> String { hostDir() + "/index.mjs" }

struct HostStatus {
    var running = false
    var deviceConnected = false
    var quota: String? = nil
    var via: String? = nil
    var device: String? = nil    // device we're actually talking to, e.g. "Deckhand-A37A"
    var selected: String? = nil  // the one chosen in the picker; nil = "any"
    var devices: [String] = []   // every device this Mac is paired with
    // true (default) = the device can answer prompts as well as display them,
    // racing Claude Code's own dialog rather than replacing it. false = the
    // device is a read-only mirror.
    var remoteAnswer = true
    // Last dictation, so a voice command is visible on the Mac too - a headless
    // `claude -p --resume` never appears in any Claude Code window, so without this
    // the Mac has no idea a dictation happened.
    var voiceText: String? = nil
    var voiceReply: String? = nil
    var voiceState: String? = nil
}

func tail(_ path: String, _ maxBytes: Int) -> String? {
    guard let fh = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? fh.close() }
    let end = (try? fh.seekToEnd()) ?? 0
    let start = end > UInt64(maxBytes) ? end - UInt64(maxBytes) : 0
    try? fh.seek(toOffset: start)
    guard let data = try? fh.readToEnd() else { return nil }
    return String(data: data, encoding: .utf8)
}

func readStatus() -> HostStatus {
    var s = HostStatus()
    if let attrs = try? FileManager.default.attributesOfItem(atPath: heartbeatPath),
       let m = attrs[.modificationDate] as? Date, Date().timeIntervalSince(m) < 12 {
        s.running = true
        if let data = FileManager.default.contents(atPath: heartbeatPath),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            s.deviceConnected = (obj["connected"] as? Bool) ?? false
            s.device = obj["device"] as? String
            s.selected = obj["selected"] as? String
            s.devices = (obj["devices"] as? [String]) ?? []
            s.remoteAnswer = (obj["remoteAnswer"] as? Bool) ?? true
            if let v = obj["voice"] as? [String: Any] {
                s.voiceText = v["text"] as? String
                s.voiceReply = v["reply"] as? String
                s.voiceState = v["state"] as? String
            }
        }
    }
    if s.running, let t = tail(logPath, 8192) {
        for line in t.split(separator: "\n").reversed() where line.hasPrefix("5h=") {
            if let f = field(line, "5h="), let d = field(line, "7d=") {
                s.quota = "5h \(f)   ·   7d \(d)"
            }
            s.via = field(line, "via=")
            break
        }
    }
    return s
}

// Value after `key` up to the next space (or end of line). Log tick lines
// look like: "5h=44% (resets ...) 7d=5% (...) ... via=usb,ble".
func field(_ line: Substring, _ key: String) -> String? {
    guard let r = line.range(of: key) else { return nil }
    let rest = line[r.upperBound...]
    if let sp = rest.firstIndex(of: " ") { return String(rest[..<sp]) }
    return String(rest)
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let quotaLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let pairedLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let startStop = NSMenuItem(title: "", action: #selector(toggleHost), keyEquivalent: "")
    let deviceItem = NSMenuItem(title: "Device", action: nil, keyEquivalent: "")
    let deviceMenu = NSMenu()
    let forgetItem = NSMenuItem(title: "Forget device (re-pair over USB)", action: #selector(forgetDevice), keyEquivalent: "")
    let remoteItem = NSMenuItem(title: "Answer prompts on device", action: #selector(toggleRemoteAnswer), keyEquivalent: "")
    let voiceHeard = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let voiceReplyItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let loginItem = NSMenuItem(title: "Launch at login", action: #selector(toggleLogin), keyEquivalent: "")

    // Watchdog state. wantRunning persists the user's intent ("syncing should
    // be on") so a deliberate Stop is respected but a frozen/crashed host is
    // auto-restarted - and it survives app relaunches (login item after a
    // reboot). downSince/lastRestart debounce the restart.
    var downSince: Date?
    var lastRestart = Date.distantPast
    var wantRunning: Bool {
        get { UserDefaults.standard.bool(forKey: "wantRunning") }
        set { UserDefaults.standard.set(newValue, forKey: "wantRunning") }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        let menu = NSMenu()
        statusLine.isEnabled = false
        quotaLine.isEnabled = false
        pairedLine.isEnabled = false
        deviceItem.submenu = deviceMenu
        voiceHeard.isEnabled = false
        voiceReplyItem.isEnabled = false
        [statusLine, quotaLine, pairedLine, voiceHeard, voiceReplyItem,
         NSMenuItem.separator(), startStop, deviceItem, forgetItem, remoteItem, loginItem,
         NSMenuItem(title: "Open host log", action: #selector(openLog), keyEquivalent: ""),
         NSMenuItem.separator(),
         NSMenuItem(title: "Quit Deckhand", action: #selector(quit), keyEquivalent: "q")].forEach {
            $0.target = self
            menu.addItem($0)
        }
        statusItem.menu = menu

        refresh()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }

        // Adopt the current state: if the host is already syncing, keep it
        // alive from now on. If syncing was meant to be on but the host is
        // down (e.g. after a reboot via the login item), start it.
        if readStatus().running { wantRunning = true }
        if wantRunning && !readStatus().running {
            lastRestart = Date()
            startHost()
        }
    }

    func refresh() {
        let s = readStatus()
        if let button = statusItem.button {
            let symbol = s.running ? "sailboat.fill" : "sailboat"
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Deckhand")
            button.image?.isTemplate = true
            button.contentTintColor = !s.running ? NSColor.systemGray
                : (s.deviceConnected ? nil : NSColor.systemOrange)
        }
        if !s.running {
            statusLine.title = "◦  Stopped"
        } else if s.deviceConnected {
            statusLine.title = "●  Syncing" + (s.via.map { "  ·  \($0)" } ?? "")
        } else {
            statusLine.title = "◦  Running  ·  device offline"
        }
        quotaLine.title = s.quota ?? "quota: —"
        quotaLine.isHidden = s.quota == nil
        pairedLine.title = s.device.map { "Paired: \($0)" } ?? "No device paired"
        forgetItem.isEnabled = s.running && s.device != nil
        // Truncate for the menu; the full text is in the host log either way.
        func clip(_ t: String, _ n: Int) -> String { t.count > n ? String(t.prefix(n)) + "…" : t }
        if let t = s.voiceText, !t.isEmpty {
            voiceHeard.title = "🎤  \u{201C}\(clip(t, 48))\u{201D}"
            voiceHeard.isHidden = false
            let st = s.voiceState ?? ""
            if let r = s.voiceReply, !r.isEmpty {
                voiceReplyItem.title = (st == "error" ? "⚠︎  " : "↳  ") + clip(r, 56)
                voiceReplyItem.isHidden = false
            } else {
                voiceReplyItem.title = st == "sent" ? "↳  sent to session, waiting…" : "↳  \(st)"
                voiceReplyItem.isHidden = st.isEmpty
            }
        } else {
            voiceHeard.isHidden = true
            voiceReplyItem.isHidden = true
        }
        remoteItem.isEnabled = s.running
        remoteItem.state = s.remoteAnswer ? .on : .off
        rebuildDeviceMenu(s)
        startStop.title = s.running ? "Stop syncing" : "Start syncing"
        loginItem.state = (SMAppService.mainApp.status == .enabled) ? .on : .off

        // Watchdog: if syncing is meant to be on but the host has been down or
        // frozen (stale heartbeat) for a sustained window, restart it. Only
        // acts when wantRunning, so a deliberate Stop is honored. The 30s
        // cooldown avoids re-restarting while a fresh host is still connecting.
        if wantRunning && !s.running {
            if downSince == nil { downSince = Date() }
            else if Date().timeIntervalSince(downSince!) > 20,
                    Date().timeIntervalSince(lastRestart) > 30 {
                NSLog("Deckhand watchdog: host down, restarting")
                lastRestart = Date()
                downSince = nil
                startHost()
            }
        } else {
            downSince = nil
        }
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
        run("/usr/bin/pkill", ["-9", "-f", hostScript()])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.run("/usr/bin/open", [hostApp(), "--args", hostScript()])
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.refresh() }
        }
    }

    func stopHost() {
        run("/usr/bin/pkill", ["-f", hostScript()]) // graceful
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
    }

    @objc func toggleHost() {
        if readStatus().running {
            wantRunning = false
            downSince = nil
            stopHost()
        } else {
            wantRunning = true
            lastRestart = Date() // don't let the watchdog also fire right now
            downSince = nil
            startHost()
        }
    }

    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            let a = NSAlert()
            a.messageText = "Couldn't change the login item"
            a.informativeText = "\(error.localizedDescription)\n\nAd-hoc-signed apps sometimes can't self-register; moving Deckhand to /Applications usually fixes it."
            a.runModal()
        }
        refresh()
    }

    // The Device submenu: every paired device, a checkmark on the chosen one,
    // plus "Any device" to let the host take whichever it finds. Rebuilt on each
    // refresh so newly paired units appear without restarting the app.
    func rebuildDeviceMenu(_ s: HostStatus) {
        deviceMenu.removeAllItems()
        deviceItem.isEnabled = s.running
        if s.devices.isEmpty {
            let none = NSMenuItem(title: "No devices paired yet", action: nil, keyEquivalent: "")
            none.isEnabled = false
            deviceMenu.addItem(none)
            return
        }
        let any = NSMenuItem(title: "Any device", action: #selector(selectDevice(_:)), keyEquivalent: "")
        any.target = self
        any.representedObject = ""            // "" = auto
        any.state = (s.selected == nil) ? .on : .off
        deviceMenu.addItem(any)
        deviceMenu.addItem(NSMenuItem.separator())
        for name in s.devices {
            // Mark the one we're actually connected to, which may differ from
            // the choice while it's out of range.
            let live = (name == s.device && s.deviceConnected)
            let item = NSMenuItem(title: live ? "\(name)  ·  connected" : name,
                                  action: #selector(selectDevice(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = name
            item.state = (name == s.selected) ? .on : .off
            deviceMenu.addItem(item)
        }
    }

    // Switching is instant and harmless (the host just re-points its BLE scan),
    // so no confirmation - unlike Forget, which destroys a key.
    @objc func selectDevice(_ sender: NSMenuItem) {
        let name = (sender.representedObject as? String) ?? ""
        try? "SELECT \(name)".write(toFile: commandTriggerPath, atomically: true, encoding: .utf8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
    }

    // On (the default) the device can answer prompts as well as show them, and
    // that costs the Mac nothing - Claude Code's dialog stays on screen the whole
    // time, so the two surfaces race and the first answer wins. No confirmation
    // needed in either direction; off simply makes the device read-only.
    @objc func toggleRemoteAnswer() {
        let s = readStatus()
        try? "REMOTE \(s.remoteAnswer ? "off" : "on")"
            .write(toFile: commandTriggerPath, atomically: true, encoding: .utf8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
    }

    // Drop this pairing and its key. The device keeps its own copy until a new
    // Mac re-provisions it, so this is reversible by plugging it back in.
    @objc func forgetDevice() {
        let s = readStatus()
        let target = s.device ?? s.selected
        let a = NSAlert()
        a.messageText = target.map { "Forget \($0)?" } ?? "Forget the paired device?"
        a.informativeText = "This Mac drops that device's pairing key. It re-pairs automatically the next time you connect it over USB; your other paired devices are unaffected.\n\nTo clear the device's own side too, use its \"Reset pairing\" button (Settings › Actions), or forget just this Mac from Settings › Paired Macs."
        a.addButton(withTitle: "Forget")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        // Name it explicitly so we forget the one shown, not whatever is current
        // by the time the host reads the trigger file.
        try? "FORGET \(target ?? "")".trimmingCharacters(in: .whitespaces)
            .write(toFile: commandTriggerPath, atomically: true, encoding: .utf8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
    }

    @objc func openLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
