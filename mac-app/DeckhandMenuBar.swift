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
    let startStop = NSMenuItem(title: "", action: #selector(toggleHost), keyEquivalent: "")
    let loginItem = NSMenuItem(title: "Launch at login", action: #selector(toggleLogin), keyEquivalent: "")

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        let menu = NSMenu()
        statusLine.isEnabled = false
        quotaLine.isEnabled = false
        [statusLine, quotaLine, NSMenuItem.separator(), startStop, loginItem,
         NSMenuItem(title: "Open host log", action: #selector(openLog), keyEquivalent: ""),
         NSMenuItem.separator(),
         NSMenuItem(title: "Quit Deckhand", action: #selector(quit), keyEquivalent: "q")].forEach {
            $0.target = self
            menu.addItem($0)
        }
        statusItem.menu = menu

        refresh()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
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
        startStop.title = s.running ? "Stop syncing" : "Start syncing"
        loginItem.state = (SMAppService.mainApp.status == .enabled) ? .on : .off
    }

    func run(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        do { try p.run(); p.waitUntilExit() } catch { NSLog("Deckhand: \(path) failed: \(error)") }
    }

    @objc func toggleHost() {
        // hostScript() is unique to the node host, so pkill -f can't hit this app.
        if readStatus().running {
            run("/usr/bin/pkill", ["-f", hostScript()]) // graceful stop
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
        } else {
            // Force-clear any wedged/stale host first: `open` won't relaunch an
            // app macOS still thinks is running, so a frozen node would just get
            // re-activated instead of replaced. Then launch a fresh one.
            run("/usr/bin/pkill", ["-9", "-f", hostScript()])
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.run("/usr/bin/open", [hostApp(), "--args", hostScript()])
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.refresh() }
            }
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
