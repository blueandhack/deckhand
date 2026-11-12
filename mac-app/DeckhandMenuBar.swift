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
import SwiftUI
#if SPARKLE
// Only release/build-release.sh passes -D SPARKLE. mac-app/build.sh's dev build does
// not link it, so a build that drives the repo's host can never update itself over
// with a release.
import Sparkle
#endif

// PER-USER runtime dir, and this MUST match RUNTIME_DIR in host/index.mjs and the same
// derivation in claude-hooks/deckhand-session-hook.mjs. Three places now derive it
// independently and cannot import from one another; when this one was missed the app
// read a heartbeat nobody writes and reported the host as down while it was running
// perfectly, with "Open host log" opening nothing. The failure is silent in exactly the
// way the host/hook pair is: no error, just a wrong answer.
let runtimeDir = ProcessInfo.processInfo.environment["DECKHAND_TMP"]
    ?? "/tmp/deckhand-\(getuid())"
let heartbeatPath = runtimeDir + "/host-alive"
let logPath = runtimeDir + "/host.log"
// Drop a "FORGET" line here and the host clears its BLE pin (re-pairs to the
// next device connected over USB). Same trigger file the host watches for
// device commands like RECAL.
let commandTriggerPath = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/deckhand-device-command")

func hostDir() -> String {
    (Bundle.main.object(forInfoDictionaryKey: "DeckhandHostDir") as? String) ?? ""
}

// THE RELEASED APP (release/build-release.sh) carries its host INSIDE itself: its own
// Node as a helper app, index.mjs and node_modules in Resources, and a launch agent
// it registers with SMAppService. Its Info.plist has no DeckhandHostDir, and that
// absence plus the helper actually being there is what selects this mode - a dev build
// (mac-app/build.sh) always has the key, so it can never take this path by accident.
// Resolved through symlinks because the host's argv carries the launcher's realpath()
// (release/host-launch.c), and the pkill patterns below must match it exactly.
let bundlePath = URL(fileURLWithPath: Bundle.main.bundlePath).resolvingSymlinksInPath().path
let helperApp = bundlePath + "/Contents/Helpers/Deckhand Host.app"
let helperNode = helperApp + "/Contents/MacOS/Deckhand Host"
let bundledHostScript = bundlePath + "/Contents/Resources/host/index.mjs"
let bundledHooksDir = bundlePath + "/Contents/Resources/hooks"
let agentLabel = "io.github.blueandhack.deckhand.host"
let isBundled = Bundle.main.object(forInfoDictionaryKey: "DeckhandHostDir") == nil
    && FileManager.default.isExecutableFile(atPath: helperNode)
let claudeDir = (NSHomeDirectory() as NSString).appendingPathComponent(".claude")
// What the hooks run (claude-hooks/hook-command.mjs): a link to the bundled Node,
// re-pointed on every launch, so moving the app never strands a hook.
let runnerLink = claudeDir + "/deckhand-node"
func hostAgent() -> SMAppService { SMAppService.agent(plistName: agentLabel + ".plist") }
var appBuild: String { (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "" }

func hostApp() -> String { isBundled ? helperApp : hostDir() + "/DeckhandBLE.app" }
func hostScript() -> String { isBundled ? bundledHostScript : hostDir() + "/index.mjs" }
func serviceScript() -> String { hostDir() + "/deckhand-service.sh" }

// Is the host supervised by launchd? If the LaunchAgent is installed, IT owns the
// process and this app must go through it rather than around it.
//
// Going around it does not work, and the failure is confusing rather than loud: the
// agent sets KeepAlive, so a `pkill` stop is undone within about a second - the Stop
// item looks broken - and an `open` start launches a second host OUTSIDE launchd while
// launchd may spawn its own, leaving two processes contending for one serial port. The
// app's own watchdog is redundant then too, and two supervisors that cannot see each
// other will fight.
func launchdPlist() -> String {
    (NSHomeDirectory() as NSString)
        .appendingPathComponent("Library/LaunchAgents/com.deckhand.host.plist")
}
func isSupervised() -> Bool {
    // The released app's supervisor is its own agent. launchdPlist() is then the
    // REPO's agent - a second host, which setup offers to stop (legacyHostPresent).
    isBundled ? ServiceState.shared.agent == .enabled : FileManager.default.fileExists(atPath: launchdPlist())
}

/// SMAppService's `status` is a SYNCHRONOUS round trip to the system's background-
/// task daemon. Measured on this Mac with `sample`: ~35ms per refresh, on the MAIN
/// thread, every 3 seconds (the agent's status and the login item's) - and when that
/// daemon is slow, at login or under load, the whole menu freezes with it. So it is
/// read here, off the main thread, every 15s and right after anything this app does
/// to either service; everything on the main thread reads the cached answer. The
/// hooks' state rides along: it reads settings.json and compares two 45KB scripts,
/// which is cheap but is still file I/O the 3s refresh has no reason to repeat.
final class ServiceState {
    static let shared = ServiceState()
    private let queue = DispatchQueue(label: "deckhand.service-state", qos: .utility)
    private let lock = NSLock()
    private var _agent = SMAppService.Status.notRegistered
    private var _login = SMAppService.Status.notRegistered
    private var _hooks = Hooks.State.notInstalled
    private var _codexHooks = false
    private var _agHooks = false

    var agent: SMAppService.Status { lock.withLock { _agent } }
    var login: SMAppService.Status { lock.withLock { _login } }
    var hooks: Hooks.State { lock.withLock { _hooks } }
    var codexHooks: Bool { lock.withLock { _codexHooks } }
    var agHooks: Bool { lock.withLock { _agHooks } }

    /// On the calling thread. Only for launch and the --setup-do / preview modes,
    /// where nothing is drawn yet that a 35ms wait could freeze.
    func refreshNow() {
        let a = isBundled ? hostAgent().status : .notRegistered
        let l = SMAppService.mainApp.status
        let h = Hooks.state()
        let c = Hooks.codexInstalled()
        let g = Hooks.antigravityInstalled()
        lock.withLock { _agent = a; _login = l; _hooks = h; _codexHooks = c; _agHooks = g }
    }

    /// Off the main thread; `then` runs on the main thread afterwards.
    func refresh(then: (() -> Void)? = nil) {
        queue.async {
            self.refreshNow()
            if let then = then { DispatchQueue.main.async(execute: then) }
        }
    }
}

// One row of the sessions array the host already embeds in every tick line.
struct SessionRow {
    var id = "", name = "", status = "", path = "", title = "", agent = "cc"
    // Read for the row's TOOLTIP only. Both ride in every tick line already, so
    // this costs nothing on the wire - and neither fits on a menu row that is
    // already carrying name, status, agent and a title.
    var model = "", branch = ""
    // Which app the session lives in: `app` is the bundle id (NSWorkspace can
    // resolve it), `appEntry` is Claude Code's own name for the surface. Both are
    // stamped by the hook from the environment it inherits, so a Codex thread read
    // off a rollout has neither - no hook ran to observe one. A Gemini row has
    // `app` when it came from the Antigravity app's own store (the host knows
    // which store it read), and never `appEntry`.
    var app = "", appEntry = ""
    // Last activity, as the host sends it: seconds since LOCAL midnight (the
    // device's clock format). The menu turns it into "waiting · 6m".
    var actSec: Int? = nil
}

struct HostStatus {
    var running = false
    var deviceConnected = false
    // Quota as NUMBERS, where this used to keep one pre-formatted string. The
    // menu now draws a bar and a humanised reset time, and neither can be
    // recovered from "13%" after the fact.
    var pct5h: Int? = nil, reset5h: Int? = nil
    var pct7d: Int? = nil, reset7d: Int? = nil
    var cxPct: Int? = nil, cxReset: Int? = nil
    // Codex's SECOND window (`codex2=`, 7 days on a Plus plan). Its own fields
    // rather than an array, because every renderer here already names Claude's two
    // windows the same way.
    var cx2Pct: Int? = nil, cx2Reset: Int? = nil, cx2WinMin: Int? = nil
    // Gemini usage per quota GROUP (`gmq=`), each with up to two windows, read by the
    // host from the Gemini app's own local server - see docs/reference/gemini.md.
    var gemini: [GeminiGroup] = []
    var gmAgeSec: Int? = nil
    // Codex's window LENGTH in minutes, which the two Claude windows do not need
    // (300 and 10080 are fixed by the plan) and this one does: it is whatever
    // Codex's own rate_limits reported, 7d on a Plus plan and not guaranteed
    // elsewhere. Absent costs the pace tick on that row and nothing else.
    var cxWinMin: Int? = nil
    // How old the two quota readings are. The transport being fresh says nothing
    // about the NUMBERS: the OAuth poller backs off 15 minutes on a 429 and can
    // sit there for hours, so a percentage can be stale while every tick arrives
    // on time. The host computes these (it owns the cache/oauth choice) and puts
    // them on the tick line as qage=/cxage=; deriving them here from a file mtime
    // would mean two places deciding which reading is authoritative.
    var quotaAgeSec: Int? = nil
    var cxAgeSec: Int? = nil
    var sessions: [SessionRow] = []
    // The device's battery, out of its BATT line. battLeftMin is nil until the
    // device has actually measured a discharge rate - it publishes -1 for "not
    // measurable yet", which the host converts to absent rather than to zero.
    var battPct: Int? = nil
    var battState: Int? = nil     // 0 none, 1 discharging, 2 charging, 3 full
    var battLeftMin: Int? = nil
    var battAgeSec: Int? = nil
    var asking: Int { sessions.filter { $0.status == "asking" }.count }
    // How many sessions the host has in all (`sessions(N)=`), which can exceed the
    // rows it sent - the menu says "N more" rather than silently dropping them.
    var sessionsTotal = 0
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
    // This Mac's icon, as the host has ALREADY resolved it (env beats the
    // picker's file - see host/mac-emoji.mjs's resolveMacEmoji). "" means
    // neither is set. iconFromEnv says WHY: DECKHAND_MAC_EMOJI in the host's
    // environment, which this app cannot read directly (it isn't launchd, and
    // reading the plist would be a third source of truth) - so the host stamps
    // both into its heartbeat instead.
    var icon = ""
    var iconFromEnv = false
    // This Mac's NAME on the device - the text tag beside its sessions and
    // projects once a second Mac connects - as the host resolved it (see
    // host/host-tag.mjs's resolveMacTag). macTagSource says WHY: "env"
    // (DECKHAND_MAC_TAG pins it), "name" (set from this menu), "auto" (the
    // hostname's last word, which two Macs of one model share). macTagAuto is
    // what "Automatic" would give, so the dialog can say so before you pick it.
    var macTag = ""
    var macTagSource = ""
    var macTagAuto = ""
    // The wireless-pairing exchange, straight out of the heartbeat. The menu is
    // the ONLY surface for it: the device's own screen shows the other code, and
    // nothing about it is written to host.log.
    var pairing = PairInfo()
    // The Bluetooth adapter's state as noble last reported it ("poweredOn",
    // "unauthorized", "poweredOff"...), nil from a host too old to send it or before
    // noble's first report. Only the released app's setup window reads it.
    var ble: String? = nil
    // Per device, for the Settings window's Devices pane: which links each paired
    // board is on right now, and its last battery reading. The singular `device` and
    // `batt` above are what the menu has always drawn and stay as they were.
    var links: [(link: String, device: String)] = []
    var batts: [String: (pct: Int, state: Int, ageSec: Int)] = [:]
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
            s.icon = (obj["icon"] as? String) ?? ""
            s.iconFromEnv = (obj["iconFromEnv"] as? Bool) ?? false
            s.macTag = (obj["macTag"] as? String) ?? ""
            s.macTagSource = (obj["macTagSource"] as? String) ?? ""
            s.macTagAuto = (obj["macTagAuto"] as? String) ?? ""
            s.ble = obj["ble"] as? String
            for l in (obj["links"] as? [[String: Any]]) ?? [] {
                if let id = l["link"] as? String { s.links.append((id, (l["device"] as? String) ?? "")) }
            }
            for b in (obj["batts"] as? [[String: Any]]) ?? [] {
                if let d = b["device"] as? String, let pct = b["pct"] as? Int {
                    s.batts[d] = (pct, (b["state"] as? Int) ?? 0, (b["ageSec"] as? Int) ?? 999)
                }
            }
            if let b = obj["batt"] as? [String: Any] {
                s.battPct = b["pct"] as? Int
                s.battState = b["state"] as? Int
                s.battLeftMin = b["leftMin"] as? Int
                s.battAgeSec = b["ageSec"] as? Int
            }
            s.pairing = pairInfoFrom(obj["pairing"] as? [String: Any])
            if let v = obj["voice"] as? [String: Any] {
                s.voiceText = v["text"] as? String
                s.voiceReply = v["reply"] as? String
                s.voiceState = v["state"] as? String
            }
        }
    }
    // 32KB, not 8KB: a tick line now yields its whole sessions array and six
    // sessions with titles and prompts runs to a couple of KB, so the smaller
    // window held only a line or two - and a truncated oldest line is why this
    // scans from the END for one that is complete.
    if s.running, let t = tail(logPath, 32768) {
        for full in t.split(separator: "\n").reversed() where full.hasPrefix("5h=") {
            // Every field but the sessions is read from the line WITHOUT the
            // sessions JSON, so no key can be matched inside a title (tickFields).
            let line = tickFields(full)
            if let (pct, reset) = pctReset(line, "5h=") { s.pct5h = pct; s.reset5h = reset }
            if let (pct, reset) = pctReset(line, "7d=") { s.pct7d = pct; s.reset7d = reset }
            if let (pct, reset) = pctReset(line, "codex=") { s.cxPct = pct; s.cxReset = reset }
            s.cxWinMin = codexWindowMin(line)
            if let (pct, reset) = pctReset(line, "codex2=") { s.cx2Pct = pct; s.cx2Reset = reset }
            s.cx2WinMin = codexWindowMin(line, key: "codex2=")
            s.quotaAgeSec = field(line, "qage=").flatMap { Int($0) }
            s.cxAgeSec = field(line, "cxage=").flatMap { Int($0) }
            s.gemini = parseGeminiQuota(field(line, "gmq=") ?? "")
            s.gmAgeSec = field(line, "gmage=").flatMap { Int($0) }
            s.via = field(line, "via=")
            s.sessions = extractSessions(full)
            if let r = line.range(of: "sessions("), let close = line[r.upperBound...].firstIndex(of: ")") {
                s.sessionsTotal = Int(line[r.upperBound..<close]) ?? s.sessions.count
            }
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

/// "5h=13% (resets 176m)" -> (13, 176); "codex=0%/7d (resets 3845m)" -> (0, 3845).
///
/// field() above cannot do this and that is not an oversight to fix in place: it
/// stops at the first space, which is exactly why the reset time was being read
/// off the line and then discarded. The two forms differ after the percent
/// ("codex" carries its window), so the reset clause is searched for rather than
/// assumed to follow immediately.
func pctReset(_ line: Substring, _ key: String) -> (Int, Int?)? {
    guard let r = line.range(of: key) else { return nil }
    let rest = line[r.upperBound...]
    // Through Double, not Int: `Int("28.000000000000004")` is nil, and a float the
    // host once passed through verbatim hid the 5h figure from the bar AND the menu
    // with nothing saying why. The host rounds now; this keeps a regression there
    // from blanking the Mac again.
    // The "%" must be in THIS field's own token. `codex=?` has none, and searching
    // the rest of the line found codex2='s - see codexWindowMin, where that misread
    // labelled an expired 5h window "7d" on the glass (2026-11-07).
    let token = rest.prefix { !$0.isWhitespace }
    guard let pctEnd = token.firstIndex(of: "%"), let raw = Double(token[..<pctEnd]), raw.isFinite
    else { return nil }
    let pct = Int(raw.rounded())
    var reset: Int? = nil
    let after = rest[rest.index(after: pctEnd)...]
    if let rr = after.prefix(24).range(of: "(resets "),
       let close = after[rr.upperBound...].firstIndex(of: ")") {
        reset = Int(after[rr.upperBound..<close].dropLast())   // "176m" -> 176
    }
    return (pct, reset)
}

/// One of the Gemini app's quota GROUPS ("Gemini Models", "Gemini 4 Argon", "Claude
/// and GPT models"), each with up to two windows - see host/gemini-quota.mjs.
struct GeminiGroup: Equatable {
    struct Bucket: Equatable { var window: String; var pct: Int; var reset: Int? }
    var name: String
    var buckets: [Bucket]
    func bucket(_ w: String) -> Bucket? { buckets.first { $0.window == w } }
    /// The group the bar's AG column shows: the one holding the MOST-USED window
    /// among Antigravity's own Gemini groups - the same rule the host applies to the
    /// device's AGY strip (antigravityDeviceUsage), so the bar and the glass never
    /// disagree. It used to be "Gemini Models" by name, which read 0% on 2026-11-11
    /// while "Gemini 4 Argon" was 35% through its week on a Mac running Argon.
    /// A tie keeps the earlier group, which is the app's own order ("Gemini Models"
    /// first). Never the "Claude and GPT models" group: other vendors' models, and
    /// beside Claude's own column it would read as the person's Claude quota.
    static func isOwn(_ g: GeminiGroup) -> Bool {
        let n = g.name.lowercased()
        return !n.contains("claude") && !n.contains("gpt")
    }
    static func primary(_ gs: [GeminiGroup]) -> GeminiGroup? {
        var best: GeminiGroup? = nil, bestPct = -1
        for g in gs where isOwn(g) {
            let top = g.buckets.map(\.pct).max() ?? -1
            if top > bestPct { best = g; bestPct = top }
        }
        return best
    }
}

/// "5h" / "weekly" -> minutes, and "<n>h" / "<n>d" the same way the host's
/// windowMinutes reads them, so the two sides agree on any window the app adds.
func geminiWindowMinutes(_ w: String) -> Int? {
    if w == "weekly" { return WINDOW_7D_MIN }
    guard let unit = w.last, let n = Int(w.dropLast()), n > 0 else { return nil }
    return unit == "d" ? n * 1440 : (unit == "h" ? n * 60 : nil)
}

/// `gmq=Gemini_Models|5h:0:295|weekly:0:10071;Gemini_4_Argon|weekly:1:9968` -> groups,
/// in the app's order. Underscores were spaces; a reset of `?` is unknown. A
/// malformed bucket is skipped rather than read as 0% - an absent number is not a
/// measurement - and a group left with none is dropped.
func parseGeminiQuota(_ v: String) -> [GeminiGroup] {
    v.split(separator: ";").compactMap { g in
        let parts = g.split(separator: "|")
        guard let name = parts.first else { return nil }
        let buckets: [GeminiGroup.Bucket] = parts.dropFirst().compactMap { b in
            let f = b.split(separator: ":", omittingEmptySubsequences: false)
            guard f.count == 3, let pct = Int(f[1]) else { return nil }
            return .init(window: String(f[0]), pct: pct, reset: Int(f[2]))
        }
        return buckets.isEmpty ? nil : GeminiGroup(name: name.replacingOccurrences(of: "_", with: " "), buckets: buckets)
    }
}

/// Codex's window length in MINUTES, out of the `/7d` or `/5h` the host appends to
/// its percentage (`codex=44%/7d (resets 8021m)`). Whole days at a day or more,
/// whole hours below one, because those are the units the host rounds to on the
/// way out - which is fine for placing a tick in a ten-cell bar.
///
/// HOURS ARE NEW, and their absence was a live defect: the host used to print days
/// only, so Codex's 300-minute window came out as `/0d`, which this read as "no
/// window" - the Codex row drew with no pace on a Mac where the window was known.
///
/// Absent whenever the field is: the host omits it when Codex has published no
/// rate_limits at all, and the row must then draw its fill with NO tick rather
/// than assume seven days. Guessing the window would put a mark at a position
/// nothing measured, which is the one thing this whole feature must not do.
func codexWindowMin(_ line: Substring, key: String = "codex=") -> Int? {
    guard let r = line.range(of: key) else { return nil }
    // Within this field's own token, never past it: after the 5h window reset the
    // host prints `codex=?` (no "%"), and the search ran on into `codex2=62%/7d`,
    // so the expired window was labelled 7d in the bar and the tooltip. Seen live.
    let rest = line[r.upperBound...].prefix { !$0.isWhitespace }
    guard let pctEnd = rest.firstIndex(of: "%") else { return nil }
    let after = rest[rest.index(after: pctEnd)...]
    guard after.hasPrefix("/") else { return nil }
    // The digits, then exactly one unit letter. Read as a run of digits rather
    // than "up to the first d", which would happily swallow a `h` into the number.
    let body = after.dropFirst()
    let digits = body.prefix { $0.isNumber }
    guard let n = Int(digits), n > 0, let unit = body.dropFirst(digits.count).first else { return nil }
    switch unit {
    case "d": return n * 1440
    case "h": return n * 60
    default: return nil
    }
}

/// The sessions array out of `sessions(N)=[{...}]` in a tick line.
///
/// The closing bracket is found by matching depth while respecting quotes and
/// escapes, NOT by searching for the " via=" that follows it: a session's title
/// and prompt are in there verbatim, so anyone who dictates or types "via=" -
/// entirely likely in a project about two transports - would corrupt the parse.
/// Any malformed input yields an empty list; a status menu must not crash over a
/// log line.
/// Where the sessions JSON array sits on a tick line ("[" through "]"), found by
/// bracket depth with strings and escapes respected - shared by extractSessions and
/// tickFields, so the two cannot disagree about where it ends.
func sessionsArrayRange(_ line: Substring) -> ClosedRange<Substring.Index>? {
    guard let key = line.range(of: "sessions("),
          let eq = line[key.upperBound...].range(of: "=[") else { return nil }
    let start = line.index(after: eq.lowerBound)          // the '['
    var depth = 0, inStr = false, esc = false
    var i = start
    while i < line.endIndex {
        let c = line[i]
        if esc { esc = false }
        else if c == "\\" { esc = true }
        else if inStr { if c == "\"" { inStr = false } }
        else if c == "\"" { inStr = true }
        else if c == "[" || c == "{" { depth += 1 }
        else if c == "]" || c == "}" {
            depth -= 1
            if depth == 0 { return start...i }
        }
        i = line.index(after: i)
    }
    return nil
}

/// The tick line with its sessions JSON CUT OUT, for every other field. A key found
/// by plain search can otherwise match inside a session's title or prompt: a title
/// containing "codex2=62%/7d" - plausible in this very repo - read as a Codex
/// figure, and "via=" the same way. (Review finding, 2026-11-07.)
func tickFields(_ line: Substring) -> Substring {
    guard let r = sessionsArrayRange(line) else { return line }
    return Substring(String(line[..<r.lowerBound]) + String(line[line.index(after: r.upperBound)...]))
}

func extractSessions(_ line: Substring) -> [SessionRow] {
    guard let range = sessionsArrayRange(line) else { return [] }
    let start = range.lowerBound
    var depth = 0, inStr = false, esc = false, end: Substring.Index? = nil
    var i = start
    while i < line.endIndex {
        let c = line[i]
        if esc { esc = false }
        else if c == "\\" { esc = true }
        else if inStr { if c == "\"" { inStr = false } }
        else if c == "\"" { inStr = true }
        else if c == "[" || c == "{" { depth += 1 }
        else if c == "]" || c == "}" {
            depth -= 1
            if depth == 0 { end = i; break }
        }
        i = line.index(after: i)
    }
    guard let last = end,
          let data = String(line[start...last]).data(using: .utf8),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
    return arr.map { o in
        var r = SessionRow()
        r.id = o["id"] as? String ?? ""
        r.name = o["name"] as? String ?? "?"
        r.actSec = o["actSec"] as? Int
        r.status = o["status"] as? String ?? ""
        r.path = o["path"] as? String ?? ""
        r.title = o["title"] as? String ?? ""
        r.agent = o["agent"] as? String ?? "cc"
        r.model = o["model"] as? String ?? ""
        r.branch = o["branch"] as? String ?? ""
        r.app = o["app"] as? String ?? ""
        r.appEntry = o["appEntry"] as? String ?? ""
        return r
    }
}

// "usb,ble" -> "USB + Bluetooth". Both transports are normally live at once, so
// this is a list and never a single "active transport".
/// The host's `via=` in words. Since boards got per-link names it reads
/// `usb:Deckhand-C114,ble`, and this printed that raw id in the menu - so any
/// `usb:` link is USB, duplicates fold (two boards on two cables is still "USB"),
/// and the two transports join as "USB and Bluetooth".
func viaLabel(_ v: String) -> String {
    var seen: [String] = []
    for part in v.split(separator: ",") {
        let p = part.hasPrefix("usb") ? "USB" : (part.hasPrefix("ble") ? "Bluetooth" : String(part))
        if !seen.contains(p) { seen.append(p) }
    }
    return seen.joined(separator: " and ")
}

func humanMinutes(_ m: Int) -> String {
    if m < 60 { return "\(m)m" }
    let h = m / 60, mm = m % 60
    if h < 24 { return mm == 0 ? "\(h)h" : "\(h)h \(mm)m" }
    let d = h / 24, hh = h % 24
    return hh == 0 ? "\(d)d" : "\(d)d \(hh)h"
}

// Truncate for the menu; the full text is in the host log either way.
/// Trims to `n` characters ON A WORD BOUNDARY. A plain prefix cut mid-word - a
/// real session row read "...recommendations API wor" - and there is nowhere else
/// to read the rest: the host slices titles to 40 characters before either
/// surface sees them, so the Mac cannot show a fuller one even in a tooltip.
///
/// It falls back to the hard cut when the last space sits in the first half,
/// because breaking there for one long token would throw away most of what fits.
func clip(_ t: String, _ n: Int) -> String {
    guard t.count > n else { return t }
    let head = String(t.prefix(n))
    if let sp = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: sp) >= n / 2 {
        return String(head[..<sp]) + "…"
    }
    return head + "…"
}

// The host caps its session list at 6, so a deeper pool could never fill.
let MAX_SESSION_ROWS = 6
let BAR_CELLS = 10

/// The two Claude windows in MINUTES. Fixed by the plan and published nowhere:
/// the tick line carries only how much is LEFT (`5h=44% (resets 176m)`), and a
/// window length is what turns that into a POSITION. Codex's is deliberately not
/// here - it is per-plan, and the host already prints it as `codex=44%/7d`.
let WINDOW_5H_MIN = 300
let WINDOW_7D_MIN = 10080

/// HOW FAR THROUGH THE WINDOW WE ARE, as a percentage - the device's pace tick,
/// and the same arithmetic `drawPaceBar` does (`100 - resetInMin * 100 /
/// windowMin`). One function because three things now render it (the bar's arrow,
/// the menu rows' tick, the tooltip's sentence), and a pace that disagreed with
/// itself between two rows of one menu would be worse than no pace at all.
///
/// nil when it cannot be known - a missing reset (the host prints `resets ?m`
/// when its poller has never succeeded) or an unknown window - and nil has to
/// render as NOTHING rather than as "level with the clock", which is a claim.
///
/// THE READING'S AGE IS DELIBERATELY NOT SUBTRACTED, and the bound is what makes
/// that a decision rather than an oversight: `reset` was computed when the quota
/// was READ, so it is `quotaAgeSec` too large by now. The OAuth poller runs every
/// 5 minutes, so in normal operation the error is at most 5/300 = 1.7 points on
/// the 5h window and 0.05 on the 7d - both inside `PACE_DEADBAND_PCT`, i.e. too
/// small to change anything drawn. Past that the reading is STALE, and a stale
/// reading's pace is SUPPRESSED rather than corrected, because the percentage it
/// would be compared against is frozen while the clock it is compared to is not.
func pacePct(resetInMin: Int?, windowMin: Int?) -> Int? {
    guard let reset = resetInMin, let win = windowMin, win > 0 else { return nil }
    return max(0, min(100, 100 - reset * 100 / win))
}

/// AHEAD of the clock, level with it, or behind - carried by SHAPE, so nothing
/// here rests on the colour beside it.
///
/// The deadband is not a fudge factor. With an exact comparison, a percentage
/// that is sitting perfectly still (nobody working) still gets overtaken by the
/// clock, so the glyph would flip from up to down on a timer while nothing
/// whatsoever happened - in a menu bar, refreshed every 5 seconds. 5 points is
/// 15 minutes of the 5h window: wide enough to stop that, narrow enough that a
/// real burn crosses it in minutes.
///
/// Escapes, not literal characters, for every glyph this file added: a geometric
/// mark is confusable with an ASCII lookalike in source (U+2502 against a plain
/// `|`, U+2595 against U+258F) and a reviewer cannot tell them apart by eye. The
/// pre-existing full-block/light-shade pair below stays literal - it is already
/// there, and no ASCII character resembles either.
let PACE_DEADBAND_PCT = 5
func paceGlyph(pct: Int, pace: Int?) -> String {
    guard let pace else { return "" }
    if pct > pace + PACE_DEADBAND_PCT { return "\u{25B2}" }
    if pct < pace - PACE_DEADBAND_PCT { return "\u{25BC}" }
    // Neither "" nor a triangle: level with the clock is a real answer, and it
    // has to look different from "there is no pace to state", which is "" above.
    return "\u{2248}"
}

/// What that glyph MEANS, in three words - the teaching half, since a triangle
/// beside a percentage is only obvious once somebody has said which way is which.
/// One function, two framings below, so the menu row and the tooltip can differ
/// in how much CONTEXT they repeat without ever differing on the verdict.
func paceVerdict(pct: Int, pace: Int?) -> String {
    guard let pace else { return "" }
    let g = paceGlyph(pct: pct, pace: pace)
    // SHORT, and that was measured rather than chosen: "level with the clock"
    // took the 7d row's second line to 53 characters, which wrapped in the render
    // - and it wrapped onto a third line with no indent, since the indent is a
    // literal "\n      " and a soft wrap gets none. So the row read as broken
    // rather than as long. 41 characters fits the 302pt lane with room to spare.
    if g == "\u{25B2}" { return "ahead of pace" }
    if g == "\u{25BC}" { return "behind pace" }
    return "on pace"
}

/// For the STATUS ITEM's tooltip, which has no other context on screen: both
/// numbers and the verdict, because the bar beside it shows a percentage and a
/// glyph and nothing that says what either is measured against.
func paceWords(pct: Int, pace: Int?) -> String {
    guard let pace else { return "no reset time, so no pace" }
    return "\(pct)% used, \(pace)% of the window elapsed - \(paceVerdict(pct: pct, pace: pace))"
}

/// For a MENU ROW, which already prints "44% used" an inch to the left. Repeating
/// it in the line below is how a two-line row starts reading as filler, so this
/// carries only what the row does not already have: where the clock is, and the
/// verdict.
func paceNote(pct: Int, pace: Int?) -> String {
    guard let pace else { return "" }
    return "\(pace)% elapsed, \(paceVerdict(pct: pct, pace: pace))"
}

/// The colour a usage figure takes, on BOTH surfaces. Factored out of
/// `quotaTitle` when the bar started colouring its percentages, because two
/// copies of a threshold is how a menu ends up calling 95% critical while the
/// bar an inch above it still looks fine.
///
/// Staleness OUTRANKS the usage threshold - "97% used" from an hour ago is not a
/// crisis to colour red, it is a number we cannot vouch for - and these are
/// SEMANTIC system colours, which is what lets one call serve a menu row and a
/// status item that may be sitting on a light bar or a dark one.
func quotaColour(pct: Int, stale: Bool) -> NSColor {
    // SECONDARY for stale, where this was tertiary. Dimmer than a live reading is
    // the whole point - 0.498 against `.labelColor`'s 0.847 - but tertiary's 0.259
    // made the figure itself hard to read, and "we cannot vouch for this number"
    // is not the same claim as "you may not read this number". The word `stale`
    // beside it is what carries the meaning; the dimming only supports it.
    if stale { return .secondaryLabelColor }
    return pct >= 95 ? .systemRed : (pct >= 80 ? .systemOrange : .labelColor)
}

/// What a cell of the bar IS, which is what decides its colour. Three cases, not
/// two: the fill and the track are the quantity, and the tick is a mark about a
/// different quantity entirely (where the clock has got to), so it must be able
/// to differ from BOTH rather than borrowing whichever it happens to sit in.
enum BarRole { case fill, track, tick }

/// The ten-cell fill, now with the pace tick in it.
///
/// THE TICK IS INSERTED BETWEEN CELLS, NEVER WRITTEN OVER ONE, and the first
/// attempt did the opposite - which the live host caught within a minute. At 1%
/// used the fill is a single cell and the pace was 3%, so the mark landed on cell
/// 0 and replaced the only ink in the bar: `▕░░░░░░░░░`, a bar that reads as
/// nothing used. That is precisely the claim the `filled == 0` rule below exists
/// to prevent, defeated by a mark drawn on top of it - and it would have been
/// invisible in review, because the arithmetic is right and only the LOOK is
/// wrong. Inserting costs one character of width and loses no fill information at
/// any percentage.
///
/// So a bar with a pace is 11 cells and one without is 10. That asymmetry is
/// deliberate: the alternative is padding the pace-less case with a blank to keep
/// the columns flush, and a blank in the tick's own position is exactly what a
/// tick at 0% would look like.
///
/// One marker, not two. U+2502 is a thin vertical in an otherwise empty cell, so
/// it reads as a LINE between two light-shade cells and as a NOTCH cut into a run
/// of full blocks - visible in both, without needing a second glyph to say which
/// side of the fill it fell on. That is a claim about a render, so it was looked
/// at: `--menu-preview`, light and dark.
/// SPLIT AT EVERY COLOUR CHANGE, so fill, track and tick can each be drawn in
/// their own colour. Returned as RUNS rather than one string because that is the
/// only way an attributed run can colour them apart - and all three need it, for
/// two separate reasons found the same way, by looking at a render:
///
/// The TICK, first: a mark inheriting the fill's colour was a red line among red
/// blocks, findable only as the notch its own cell's background makes. It means
/// "now", which is not a status, so it takes a neutral secondary grey against a
/// fill that may be red or orange.
///
/// The TRACK, second, and this one shipped: an earlier version split at the tick
/// ALONE and handed back three pieces, each of which could carry both `█` and
/// `░`. `quotaTitle` therefore drew every cell in the usage colour, which put the
/// empty track in that colour at 25% coverage immediately beside the fill at
/// 100%. Same hue, adjacent, no boundary - the bar read as one grey smear whose
/// end could not be located, and the tick was invisible inside it. Fill and track
/// differ in INK, not in shape (that is why `▰`/`▱` were rejected), and ink alone
/// is not enough separation when both are the same colour. `--pace-check` now
/// asserts by name that no run carries both.
///
/// THE FILL IS MEASURED IN EIGHTHS OF A CELL, not whole cells. With whole cells
/// the "any usage shows ink" rule below had to round 1% up to a full cell, so 1%
/// and 4% both drew exactly what 10% draws - a bar that overstated light usage by
/// up to ten times, and the first thing a person noticed on looking at it. The
/// last, partial cell is a LEFT eighth-block (U+258F..U+2589), the same family as
/// the full block, so 1% is a hairline and 5% half a cell. Resolution is 1.25%.
let BAR_EIGHTHS = ["", "\u{258F}", "\u{258E}", "\u{258D}", "\u{258C}", "\u{258B}", "\u{258A}", "\u{2589}"]

func quotaBarRuns(_ pct: Int, pace: Int? = nil) -> [(text: String, role: BarRole)] {
    var eighths = Int((Double(pct) / 100 * Double(BAR_CELLS * 8)).rounded())
    // Any usage at all must show ink: 1% rounding to an empty bar would read as
    // "none used", which is a different claim than "barely any". One EIGHTH is
    // enough to say it; a whole cell said 10%.
    if pct > 0 && eighths == 0 { eighths = 1 }
    eighths = max(0, min(BAR_CELLS * 8, eighths))

    // FULL BLOCK against LIGHT SHADE, not ▰/▱. The geometric pair renders at 11pt
    // as a faint dashed line where filled and empty are barely distinguishable -
    // checked against a render, not assumed. These two differ in ink, not shape,
    // which is why the colours above are load-bearing rather than decorative.
    var cells: [(text: String, role: BarRole)] =
        Array(repeating: ("\u{2588}", .fill), count: eighths / 8)
    if eighths % 8 > 0 { cells.append((BAR_EIGHTHS[eighths % 8], .fill)) }
    cells += Array(repeating: ("\u{2591}", .track), count: BAR_CELLS - cells.count)

    // A BOUNDARY, not a cell: 0% goes before the first and 100% after the last,
    // which is what makes the two ends of the window reachable at all. INSERTED
    // between cells, never written over one (see above).
    if let pace {
        let at = max(0, min(BAR_CELLS, (pace * BAR_CELLS + 50) / 100))
        cells.insert(("\u{2502}", .tick), at: at)
    }
    // Coalesce adjacent cells of one role. Grouping by ROLE, never by glyph, is
    // what keeps a run from spanning the fill boundary - and the tick is its own
    // role, so it always splits whatever it lands in.
    var out: [(text: String, role: BarRole)] = []
    for c in cells {
        if let last = out.last, last.role == c.role, c.role != .tick {
            out[out.count - 1].text += c.text
        } else {
            out.append(c)
        }
    }
    return out
}

// Menu text styling.
//
// Informational rows are DISABLED, which is the right semantics - no hover, not
// keyboard-focusable - and AppKit may composite a disabled row at reduced alpha.
// So a colour here can be dimmed by the system, and every threshold it marks is
// ALSO said in words and drawn in the bar. That is the device UI's
// colour-is-never-alone rule applying to the Mac side for the same reason.
let F_BODY = NSFont.menuFont(ofSize: 0)
let F_BOLD = NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)
let F_SMALL = NSFont.menuFont(ofSize: 11)
let F_MONO = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
/// The same face and size as `F_MONO`, heavier. Used for the one figure on a
/// quota row that the row exists to report, so it wins against the label naming
/// it and the bar giving it context - where before it was the same weight as
/// both and sat downstream of the bar, so the eye crossed the noise to reach it.
///
/// SF Mono holds one advance across weights, so this cannot break the column
/// alignment the `%3d` padding buys. That is a claim about a font rather than
/// about this code, so `--pace-check` measures it instead of trusting it.
let F_MONO_BOLD = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)

/// WHAT the bar is allowed to show, as user choices rather than as this file's
/// opinion. Every one defaults to ON and `object(forKey:) as? Bool ?? true` is
/// what makes that true of a fresh install too - `UserDefaults.bool(forKey:)`
/// returns FALSE for a key nobody has written, so reading it directly would ship
/// an app whose bar is blank until you go and switch three things on.
///
/// `onlyOffline` governs the two device-mirroring badges (usage, sessions) and
/// deliberately NOT the needs-input count: those two stand in for a screen that
/// is missing, while a prompt blocking your work is worth saying whether or not
/// the device is there to say it too.
enum BarPref: String, CaseIterable {
    case usage = "barShowUsage"
    // Its own switch, not folded into `usage`: someone who never runs Codex should
    // not have to give up Claude's figures to keep a third one out of the bar, and
    // the reverse. Defaults ON like the rest - a Mac with no Codex reading draws
    // nothing for it anyway (`cxPct` nil), so ON costs a non-Codex user no width.
    case codex = "barShowCodex"
    // Gemini's, from the Gemini app while it runs. Its own switch for the reason
    // Codex has one: someone who never uses Gemini should not give up the others.
    case gemini = "barShowGemini"
    case sessions = "barShowSessions"
    case asking = "barShowAsking"
    case onlyOffline = "barOnlyWhenOffline"

    var label: String {
        switch self {
        case .usage: return "Quota usage"
        case .codex: return "Codex usage"
        case .gemini: return "Antigravity usage"
        case .sessions: return "Waiting / working counts"
        case .asking: return "Needs-input count"
        case .onlyOffline: return "Only while no device is connected"
        }
    }
    var on: Bool { UserDefaults.standard.object(forKey: rawValue) as? Bool ?? true }
    func toggle() { UserDefaults.standard.set(!on, forKey: rawValue) }
}

/// True when a device-mirroring badge may show: switched on, and either the
/// "only while no device is connected" restriction is off or there is genuinely
/// no device. One function so usage and sessions cannot drift apart.
func barMirrorAllowed(_ pref: BarPref, _ s: HostStatus) -> Bool {
    pref.on && !(BarPref.onlyOffline.on && s.deviceConnected)
}

/// Filled when a device is actually connected, hollow when it is not - the icon
/// stands for the LINK, not for the process. It used to key off `running`, which
/// meant a host with no device on the other end drew the same solid boat as a
/// fully live one and left the difference to a tint that never reached the
/// screen (see `refresh`) - so the bar could not report the one fact it exists to
/// report. Shape is now the only carrier here, which is what the rest of this
/// file already demands of colour. Shared with --menu-dump for the same reason
/// `barCountLabel` is.
func barBoatStyle(_ s: HostStatus) -> BoatStyle { s.deviceConnected ? .solid : .outline }

// MARK: - The menu-bar item: what sits beside the boat, sized to fit
//
// WHY THIS WAS REDESIGNED (2026-11-07). It used to be one line of text -
// ` 19%▼  ·  41%▼   CX 100%  ·  62%▲ ■2 ○2 ●1` - MEASURED at 275pt with its own font. On a MacBook Pro every
// status item has to fit between the notch and the right edge (~650pt on a 14"), and
// when they do not, macOS HIDES the ones that overflow, silently. Measured on this
// Mac: the items to Deckhand's right already took ~1,220pt, so on the laptop's own
// screen a wide Deckhand item was the likeliest one to vanish. And `19%▼ · 41%▼` asked
// the reader to remember which number was which window.
//
// So the figures are STACKED: each service is a column with its 5-hour reading on top
// and its 7-day reading below, with a tiny row label - the layout system-monitor menu
// bar apps use, which halves the width and labels every number. And the item comes in
// four sizes (BarTier), chosen by the user or AUTOMATICALLY: Automatic starts smaller
// on a notched screen, steps down whenever macOS hides the item, and tries larger
// again only when the displays change or the Mac wakes (AppDelegate.checkBarFit).
//
// What each size keeps, most important last to go:
//   full     every quota column, the session counts (○ waiting / ● working), the
//            needs-input badge
//   compact  the quota columns and the badge (session counts are on the menu's rows)
//   minimal  the badge, and a quota column ONLY when it needs attention (80%+, or
//            burning faster than the clock)
//   icon     the boat alone, with a red dot on it while a session needs your answer
//
// Rules carried over from the text version, because they were right:
//  - shape carries meaning, never colour alone: ○ waits, ● works, and the badge is a
//    filled pill with a count. A zero is drawn as nothing, not as a 0;
//  - a stale reading keeps its digits (dimmed) and loses its pace mark, which is a
//    comparison against a clock that kept running while the number did not;
//  - a missing window is a DASH holding its row, never a gap - "62%" alone on the
//    top row would read as the 5-hour figure.
// One change: only ▲ (ahead of pace, the warning) is drawn in the bar. ▼ and ≈ are
// reassurance, and the menu rows and the tooltip still say them.

enum BarTier: Int, CaseIterable, Comparable {
    case icon = 0, minimal, compact, full
    static func < (a: BarTier, b: BarTier) -> Bool { a.rawValue < b.rawValue }
    var smaller: BarTier? { BarTier(rawValue: rawValue - 1) }
    var title: String {
        switch self {
        case .full: return "Full"
        case .compact: return "Compact"
        case .minimal: return "Minimal"
        case .icon: return "Icon only"
        }
    }
    var detail: String {
        switch self {
        case .full: return "Usage for every service, session counts, and the needs-input badge."
        case .compact: return "Usage and the needs-input badge."
        case .minimal: return "Only what needs you: the badge, and usage once it is high."
        case .icon: return "Just the boat. A red dot means a session is waiting for your answer."
        }
    }
}

/// The user's choice. `automatic` resolves to whichever tier fits.
enum BarSize: String, CaseIterable {
    case automatic, full, compact, minimal, icon
    var tier: BarTier? {
        switch self {
        case .automatic: return nil
        case .full: return .full
        case .compact: return .compact
        case .minimal: return .minimal
        case .icon: return .icon
        }
    }
    static var current: BarSize {
        get { BarSize(rawValue: UserDefaults.standard.string(forKey: "barSize") ?? "") ?? .automatic }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "barSize") }
    }
}

/// One figure. `pct` nil is the dash.
struct BarCell: Equatable {
    var pct: Int?
    var stale = false
    var ahead = false
    var text: String { pct.map { "\($0)%" } ?? "\u{2013}" }
    var needsAttention: Bool { !stale && ((pct ?? 0) >= 80 || ahead) }
}

/// One service's column: an optional tag ("CX"), two rows, and the rows' labels when
/// they are not already given by the Claude column beside it.
struct BarQuota: Equatable {
    var tag = ""
    var labels: [String]? = nil
    var top = BarCell()
    /// nil for a ONE-ROW column, drawn centred.
    var bottom: BarCell? = BarCell()
    /// Each row's window length, which decides its LABEL (see barModel).
    var windows: [Int?] = [WINDOW_5H_MIN, WINDOW_7D_MIN]
    var needsAttention: Bool { top.needsAttention || (bottom?.needsAttention ?? false) }
}

struct BarModel: Equatable {
    var quotas: [BarQuota] = []
    var waiting = 0
    var working = 0
    var asking = 0
    var dot = false
}

func barCell(_ pct: Int?, reset: Int?, window: Int?, stale: Bool) -> BarCell {
    guard let pct else { return BarCell() }
    let pace = stale ? nil : pacePct(resetInMin: reset, windowMin: window)
    return BarCell(pct: pct, stale: stale, ahead: paceGlyph(pct: pct, pace: pace) == "\u{25B2}")
}

/// What the bar shows at `tier`. Pure: the switches it reads are the Menu Bar
/// preferences, and the same function feeds the image, --menu-dump and the checks.
func barModel(_ s: HostStatus, tier: BarTier, previewing: Bool = false) -> BarModel {
    // `previewing`: the Settings window's size previews show what a size LOOKS
    // like, so they ignore "hide while a display is connected" - otherwise, with a
    // display plugged in, every preview was the same bare boat.
    let allowed = { (p: BarPref) in previewing ? p.on : barMirrorAllowed(p, s) }
    var m = BarModel()
    let asking = BarPref.asking.on ? s.asking : 0
    if tier == .icon { m.dot = asking > 0; return m }
    m.asking = asking

    if allowed(.usage), s.pct5h != nil || s.pct7d != nil {
        let stale = (s.quotaAgeSec ?? 0) > QUOTA_STALE_SEC
        m.quotas.append(BarQuota(tag: "",
                                 top: barCell(s.pct5h, reset: s.reset5h, window: WINDOW_5H_MIN, stale: stale),
                                 bottom: barCell(s.pct7d, reset: s.reset7d, window: WINDOW_7D_MIN, stale: stale)))
    }
    if allowed(.codex), s.cxPct != nil || s.cx2Pct != nil {
        let stale = (s.cxAgeSec ?? 0) > QUOTA_STALE_SEC
        m.quotas.append(BarQuota(
            tag: "CX",
            top: barCell(s.cxPct, reset: s.cxReset, window: s.cxWinMin, stale: stale),
            bottom: barCell(s.cx2Pct, reset: s.cx2Reset, window: s.cx2WinMin, stale: stale),
            windows: [s.cxWinMin, s.cx2WinMin]))
    }
    if allowed(.gemini), let g = GeminiGroup.primary(s.gemini) {
        // Antigravity's most-used Gemini allowance (GeminiGroup.primary), 5h over weekly
        // like the others - from its own quota summary, which names both windows, so
        // the pace is real too.
        let stale = (s.gmAgeSec ?? 0) > QUOTA_STALE_SEC
        let five = g.bucket("5h"), week = g.bucket("weekly")
        let cell = { (b: GeminiGroup.Bucket?) in
            barCell(b?.pct, reset: b?.reset, window: b.flatMap { geminiWindowMinutes($0.window) }, stale: stale) }
        if five != nil {
            // 5h over weekly; a missing weekly is a dash holding its row.
            m.quotas.append(BarQuota(tag: "AG", top: cell(five), bottom: cell(week)))
        } else if let only = week ?? g.buckets.first {
            // No 5h window: ONE row, labelled by the tooltip - not a dash in a "5h"
            // row that this group does not have. (Review finding.)
            m.quotas.append(BarQuota(tag: "AG", top: cell(only), bottom: nil, windows: [geminiWindowMinutes(only.window)]))
        }
    }
    if tier == .minimal { m.quotas = m.quotas.filter(\.needsAttention) }
    // ROW LABELS, decided once the columns are final. Claude's column always says
    // 5h/7d. Another two-row column BORROWS them - no labels of its own - only when
    // its windows ARE 5h and 7d and the Claude column is actually there; otherwise it
    // carries its own. (Minimal can drop the Claude column: found on --bar-preview,
    // where Codex was drawn with no labels at all. And a plan whose first window is
    // 7d must not sit in the row the Claude column calls "5h".)
    let claudeThere = m.quotas.contains { $0.tag.isEmpty }
    for i in m.quotas.indices where m.quotas[i].bottom != nil {
        let q = m.quotas[i]
        let label = { (w: Int?, fb: String) in codexWindowLabel(w, fallback: fb) }
        if q.tag.isEmpty { m.quotas[i].labels = ["5h", "7d"] }
        else if claudeThere && q.windows.count == 2
                    && (q.windows[0] ?? WINDOW_5H_MIN) == WINDOW_5H_MIN && (q.windows[1] ?? WINDOW_7D_MIN) == WINDOW_7D_MIN {
            m.quotas[i].labels = nil
        } else {
            m.quotas[i].labels = [label(q.windows.first ?? nil, "1"), label(q.windows.count > 1 ? q.windows[1] : nil, "2")]
        }
    }
    if tier == .full, allowed(.sessions) {
        // ○ waits, ● works - with the badge's ■ asks, the three PARTITION the list,
        // so no session is counted twice. Waiting outranks working: it is your move.
        m.waiting = s.sessions.filter { $0.status == "waiting" }.count
        m.working = s.sessions.filter { $0.status == "working" }.count
    }
    return m
}

/// The model as one line, for --menu-dump and the checks. Columns are bracketed,
/// rows separated by " / " - the text a person would read off the image.
func barText(_ m: BarModel) -> String {
    var parts: [String] = []
    for q in m.quotas {
        let cells: [(String?, BarCell)] = q.bottom.map { [(q.labels?[0], q.top), (q.labels?[1], $0)] } ?? [(nil, q.top)]
        let rows = cells.map { (l, c) in
            (l.map { "\($0) " } ?? "") + c.text + (c.ahead ? "\u{25B2}" : "")
        }
        parts.append("[" + (q.tag.isEmpty ? "" : "\(q.tag) ") + rows.joined(separator: " / ") + "]")
    }
    if m.waiting > 0 || m.working > 0 {
        parts.append("[" + [m.waiting > 0 ? "\u{25CB}\(m.waiting)" : "", m.working > 0 ? "\u{25CF}\(m.working)" : ""]
            .filter { !$0.isEmpty }.joined(separator: " / ") + "]")
    }
    if m.asking > 0 { parts.append("(\(m.asking))") }
    if m.dot { parts.append("\u{2022}") }
    return parts.joined(separator: " ")
}

let BAR_VALUE_FONT = NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .semibold)
let BAR_LABEL_FONT = NSFont.systemFont(ofSize: 7.5, weight: .medium)
let BAR_TAG_FONT = NSFont.systemFont(ofSize: 8.5, weight: .bold)
let BAR_GLYPH_FONT = NSFont.systemFont(ofSize: 6, weight: .regular)
let BAR_BADGE_FONT = NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .bold)

/// The boat and everything beside it as ONE image, laid out for a bar `height` tall.
/// Drawn by a handler, not baked: every colour is a SEMANTIC one resolved when AppKit
/// draws it, against the menu bar's own appearance, so it follows a light or dark bar
/// (and a wallpaper change) the way the old attributed title did.
func barImage(_ m: BarModel, boat: BoatStyle, colourful: Bool, height h: CGFloat) -> NSImage {
    typealias Op = (CGFloat) -> Void        // draws at x
    var ops: [(x: CGFloat, op: Op)] = []
    var x: CGFloat = 0
    let boatSize = max(14, min(18, h - 5))
    let boatImg = deckhandPaperBoatImage(size: boatSize, style: boat, colourful: colourful)
    let dot = m.dot
    ops.append((x, { x in
        let r = NSRect(x: x, y: (h - boatSize) / 2, width: boatSize, height: boatSize)
        boatImg.draw(in: r)
        if boatImg.isTemplate {
            // A template image draws black; the bar's own colour is laid over it.
            NSColor.labelColor.set()
            r.fill(using: .sourceAtop)
        }
        if dot {
            NSColor.systemRed.setFill()
            NSBezierPath(ovalIn: NSRect(x: r.maxX - 5.5, y: r.maxY - 6, width: 6, height: 6)).fill()
        }
    }))
    x += boatSize

    // Two rows: baselines placed so two lines of digits sit centred in the bar.
    let cap = BAR_VALUE_FONT.capHeight, gap: CGFloat = 2.5
    let base0 = ((h - (2 * cap + gap)) / 2).rounded()     // bottom row
    let base1 = base0 + cap + gap                          // top row
    func size(_ s: String, _ f: NSFont) -> CGFloat { (s as NSString).size(withAttributes: [.font: f]).width }
    func draw(_ s: String, _ f: NSFont, _ c: NSColor, x: CGFloat, baseline: CGFloat) {
        (s as NSString).draw(at: NSPoint(x: x, y: baseline + f.descender), withAttributes: [.font: f, .foregroundColor: c])
    }

    for q in m.quotas {
        x += 7
        if !q.tag.isEmpty {
            let w = size(q.tag, BAR_TAG_FONT), tag = q.tag
            ops.append((x, { x in draw(tag, BAR_TAG_FONT, .secondaryLabelColor, x: x, baseline: (h - BAR_TAG_FONT.capHeight) / 2) }))
            x += w + 3
        }
        if let labels = q.labels {
            let w = labels.map { size($0, BAR_LABEL_FONT) }.max() ?? 0
            ops.append((x, { x in
                draw(labels[0], BAR_LABEL_FONT, .secondaryLabelColor, x: x, baseline: base1)
                draw(labels[1], BAR_LABEL_FONT, .secondaryLabelColor, x: x, baseline: base0)
            }))
            x += w + 2.5
        }
        // Values right-aligned in their column, so 9% and 41% end at the same place.
        // A one-row column sits in the middle of the bar.
        let rows = q.bottom.map { [(q.top, base1), ($0, base0)] } ?? [(q.top, ((h - cap) / 2).rounded())]
        let widths = rows.map { size($0.0.text, BAR_VALUE_FONT) + ($0.0.ahead ? size("\u{25B2}", BAR_GLYPH_FONT) + 1 : 0) }
        let colW = widths.max() ?? 0
        ops.append((x, { x in
            for (i, (cell, base)) in rows.enumerated() {
                // SECONDARY for the dash, not tertiary: on the real dark bar a tertiary
                // dash was all but invisible, and the column read as a lone "62%" -
                // the exact misreading the dash exists to prevent. (Seen in a capture
                // of the live menu bar, 2026-11-07.)
                let colour: NSColor = cell.pct == nil ? .secondaryLabelColor : quotaColour(pct: cell.pct!, stale: cell.stale)
                var cx = x + colW - widths[i]
                draw(cell.text, BAR_VALUE_FONT, colour, x: cx, baseline: base)
                if cell.ahead {
                    cx += size(cell.text, BAR_VALUE_FONT) + 1
                    draw("\u{25B2}", BAR_GLYPH_FONT, .secondaryLabelColor, x: cx, baseline: base + 1)
                }
            }
        }))
        x += colW
    }

    if m.waiting > 0 || m.working > 0 {
        x += 7
        let rows = [(m.waiting, "\u{25CB}", base1), (m.working, "\u{25CF}", base0)].filter { $0.0 > 0 }
        // One row alone sits in the middle rather than leaving a hole above or below.
        let placed = rows.count == 1 ? [(rows[0].0, rows[0].1, (h - cap) / 2)] : rows
        let w = placed.map { size("\($0.1)\($0.0)", BAR_VALUE_FONT) }.max() ?? 0
        ops.append((x, { x in
            for (n, glyph, base) in placed { draw("\(glyph)\(n)", BAR_VALUE_FONT, .labelColor, x: x, baseline: base) }
        }))
        x += w
    }

    if m.asking > 0 {
        x += 7
        let text = "\(m.asking)"
        let tw = size(text, BAR_BADGE_FONT)
        let pillH: CGFloat = 13, pillW = max(pillH, tw + 8)
        ops.append((x, { x in
            let r = NSRect(x: x, y: ((h - pillH) / 2).rounded(), width: pillW, height: pillH)
            NSColor.systemRed.setFill()
            NSBezierPath(roundedRect: r, xRadius: pillH / 2, yRadius: pillH / 2).fill()
            draw(text, BAR_BADGE_FONT, .white, x: r.midX - tw / 2, baseline: r.minY + (pillH - BAR_BADGE_FONT.capHeight) / 2)
        }))
        x += pillW
    }

    let width = ceil(x + 1)
    let img = NSImage(size: NSSize(width: width, height: h), flipped: false) { _ in
        for (ox, op) in ops { op(ox) }
        return true
    }
    img.isTemplate = false
    img.accessibilityDescription = "Deckhand"
    return img
}

/// Where Automatic starts. A notched screen's status area is the strip between the
/// notch and the right edge, shared with every other app's items, so it starts at
/// Compact there; anywhere else at Full. Either way it steps down if macOS hides it.
func barStartTier() -> BarTier {
    NSScreen.screens.contains { $0.safeAreaInsets.top > 0 } ? .compact : .full
}

/// Every tier's width for a status - the arithmetic Automatic and the Settings
/// window both reason with, from the same renderer that draws the bar.
func barWidths(_ s: HostStatus, height: CGFloat) -> [BarTier: CGFloat] {
    Dictionary(uniqueKeysWithValues: BarTier.allCases.map {
        ($0, barImage(barModel(s, tier: $0), boat: barBoatStyle(s), colourful: colourfulIcon, height: height).size.width)
    })
}

/// What the bar's own figures MEAN, on hovering the status item - the only place
/// the arrows can be explained, since the bar has room for a glyph and not for a
/// sentence. Empty when the bar is showing no usage, so there is no tooltip
/// promising to explain something that is not on screen.
func barTooltip(_ s: HostStatus) -> String {
    var lines: [String] = []
    if barMirrorAllowed(.usage, s) { lines += barClaudeTooltip(s) }
    if barMirrorAllowed(.codex, s), s.cxPct == nil, s.cx2Pct != nil {
        lines.append("CX (Codex) \(codexWindowLabel(s.cxWinMin, fallback: "first window")): no current reading - its window has reset since Codex last reported")
    }
    if barMirrorAllowed(.codex, s), let pct = s.cxPct {
        let age = s.cxAgeSec ?? 0
        // Each reason named, for the reason given in barClaudeTooltip: a missing
        // WINDOW is a different cause from a missing reset time, and paceWords
        // alone would blame the reset time for both.
        if age > QUOTA_STALE_SEC {
            lines.append("CX (Codex): \(pct)% used, no pace: this reading is \(humanMinutes(age / 60)) old")
        } else if s.cxWinMin == nil {
            lines.append("CX (Codex): \(pct)% used, no pace: Codex published no window length")
        } else {
            lines.append("CX (Codex): " + paceWords(pct: pct, pace: pacePct(resetInMin: s.cxReset, windowMin: s.cxWinMin)))
        }
    }
    if barMirrorAllowed(.codex, s), let pct = s.cx2Pct {
        let name = "CX (Codex) \(codexWindowLabel(s.cx2WinMin, fallback: "second window"))"
        if (s.cxAgeSec ?? 0) > QUOTA_STALE_SEC {
            lines.append("\(name): \(pct)% used, no pace: this reading is \(humanMinutes((s.cxAgeSec ?? 0) / 60)) old")
        } else {
            lines.append("\(name): " + paceWords(pct: pct, pace: pacePct(resetInMin: s.cx2Reset, windowMin: s.cx2WinMin)))
        }
    }
    if let g = geminiTooltip(s) { lines.append(g) }
    return lines.joined(separator: "\n")
}

/// The bar tooltip's Gemini lines: one per window of the group the GM column shows.
func geminiTooltip(_ s: HostStatus) -> String? {
    guard barMirrorAllowed(.gemini, s), let g = GeminiGroup.primary(s.gemini) else { return nil }
    let age = s.gmAgeSec ?? 0
    return g.buckets.map { b in
        let name = "AG (Antigravity) \(b.window == "weekly" ? "7d" : b.window)"
        if age > QUOTA_STALE_SEC { return "\(name): \(b.pct)% used, no pace: this reading is \(humanMinutes(age / 60)) old" }
        return "\(name): " + paceWords(pct: b.pct, pace: pacePct(resetInMin: b.reset, windowMin: geminiWindowMinutes(b.window)))
    }.joined(separator: "\n")
}

/// "5h" / "7d" from a window length in minutes - the host's own rule (days, or
/// hours under a day) - or `fallback` when Codex published none.
func codexWindowLabel(_ win: Int?, fallback: String) -> String {
    guard let w = win, w > 0 else { return fallback }
    return w >= 1440 ? "\(w / 1440)d" : "\(w / 60)h"
}

/// The 5h and 7d lines of `barTooltip`, with their shared staleness sentence.
func barClaudeTooltip(_ s: HostStatus) -> [String] {
    let stale = (s.quotaAgeSec ?? 0) > QUOTA_STALE_SEC
    var lines: [String] = []
    for (name, pct, reset, win) in [("5h", s.pct5h, s.reset5h, WINDOW_5H_MIN),
                                    ("7d", s.pct7d, s.reset7d, WINDOW_7D_MIN)] {
        guard let pct else { continue }
        // WHY there is no pace has to be the real reason, and this got it wrong
        // first time round: `paceWords(pace: nil)` says "no reset time, so no
        // pace", which is true for a window the poller has never resolved and
        // FALSE for a stale one - the reset time is right there on the row, and
        // the actual reason is that it is two hours old. A diagnostic that
        // misattributes a suppression sends the next reader to the wrong file, so
        // staleness is stated once, below, and these lines just drop the pace.
        lines.append(stale ? "\(name): \(pct)% used"
                           : "\(name): " + paceWords(pct: pct, pace: pacePct(resetInMin: reset, windowMin: win)))
    }
    if lines.isEmpty { return [] }
    // "5h/7d" named now that a Codex line can follow this one, which would
    // otherwise read as included in "these readings".
    if stale { lines.append("No 5h/7d pace: these readings are \(humanMinutes((s.quotaAgeSec ?? 0) / 60)) old, so the clock has moved and they have not.") }
    return lines
}

/// A sound when a session STARTS needing input, and the edge is the whole point.
///
/// Keyed by session ID, never by name: two sessions on one project share a name,
/// and name-matching is exactly what once made the device beep on every poll
/// (see the beep-budget note in CLAUDE.md). Ids that stop asking are forgotten,
/// so a session that is answered and asks again is announced again.
struct AskWatcher {
    private var announced: Set<String> = []
    private var primed = false

    /// How many sessions just entered `asking`. The FIRST call only PRIMES and
    /// deliberately announces nothing: whatever is already waiting when the app
    /// launches is not news, and without this every relaunch - including the
    /// login item firing after a reboot - would sound off about a backlog you
    /// have already seen.
    mutating func step(_ asking: Set<String>) -> Int {
        defer { announced = asking }
        if !primed { primed = true; return 0 }
        return asking.subtracting(announced).count
    }
}

/// Which sound, as a name from /System/Library/Sounds. Empty string = silent, and
/// that is a real choice a user can store, which is why absent (a fresh install)
/// has to mean the DEFAULT rather than empty - the same `object(forKey:) ?? x`
/// reason `BarPref` reads its keys the way it does.
///
/// Submarine is the default because it is this project's theme and, more
/// usefully, because it does not sound like the system telling you something
/// went wrong - Basso and Sosumi read as errors, and a prompt is not an error.
let ASK_SOUNDS = ["Submarine", "Ping", "Glass", "Purr"]
let ASK_SOUND_DEFAULT = "Submarine"
var askSoundName: String {
    UserDefaults.standard.object(forKey: "askSound") as? String ?? ASK_SOUND_DEFAULT
}

/// The sixteen names, for DISPLAY ORDER ONLY - matching
/// `MAC_EMOJI_NAMES` in host/mac-emoji.mjs, which is the actual source of truth.
/// Validation and persistence to ~/.claude/deckhand-mac-emoji both already live
/// on the host side; duplicating either here would be a second place that could
/// drift from firmware/deckhand_display/MacEmoji.h. ("robot" was replaced by
/// "apple" there - at 13px robot read as a cupcake - so this list follows the
/// host's, not the original task brief's.)
let MAC_ICON_NAMES = [
    "rocket", "moon", "star", "bolt", "fire", "leaf", "wave", "anchor",
    "crab", "laptop", "desktop", "cloud", "sun", "cat", "apple", "gear",
]

/// The CHARACTER each of those names stands for, so the picker can show the
/// picture instead of only the word. Same argument `--sound-check play` already
/// makes about sounds: a name tells you nothing about what you are choosing, and
/// "wave" or "bolt" or "anchor" is a guess until you see it.
///
/// DISPLAY ONLY, and that is the whole safety story: the wire carries the NAME
/// (see `pickIcon`, which writes `EMOJI <name>`), the device draws baked ARTWORK
/// from MacEmoji.h because Cozette cannot render an emoji glyph at all, and
/// nothing here is ever sent, stored, or compared. So a wrong character in this
/// table is a wrong PICTURE in one menu - never a broken icon on the device, and
/// never a name that fails to resolve.
///
/// It is a FOURTH hand transcription of the sixteen (after MacEmoji.h,
/// host/mac-emoji.mjs and MAC_ICON_NAMES above), so `host/mac-emoji-check.mjs`
/// compares it against `ICONS` in firmware/deckhand_display/emoji2c.py - the
/// generator, i.e. the only place that says which character the art was rendered
/// FROM. Without that, a future character change (the lever emoji2c.py's
/// SIZE_OVERRIDES documents, since the names can never move) would leave this
/// menu confidently offering a picture the device no longer draws.
///
/// Escapes rather than literal characters, deliberately: every entry carries
/// U+FE0F, an INVISIBLE variation selector that forces emoji presentation - it is
/// what stops `gear`, `desktop`, `sun` and `star` rendering as flat text glyphs -
/// and an invisible character pasted into source is the kind of thing an editor
/// silently eats. Spelled out, it is reviewable and the checker can compare it.
///
/// The per-SIZE substitutions in emoji2c.py's SIZE_OVERRIDES are deliberately
/// NOT reflected here (board 2 draws `cloud` as sun-behind-rain-cloud at 16px).
/// This Mac cannot know which board it is talking to - and may be talking to
/// both - so the menu shows the character the name is named for, which is what
/// each override was chosen to keep describing.
let MAC_ICON_GLYPHS: [String: String] = [
    "rocket":  "\u{1F680}\u{FE0F}",
    "moon":    "\u{1F319}\u{FE0F}",
    "star":    "\u{2B50}\u{FE0F}",
    "bolt":    "\u{26A1}\u{FE0F}",
    "fire":    "\u{1F525}\u{FE0F}",
    "leaf":    "\u{1F343}\u{FE0F}",
    "wave":    "\u{1F30A}\u{FE0F}",
    "anchor":  "\u{2693}\u{FE0F}",
    "crab":    "\u{1F980}\u{FE0F}",
    "laptop":  "\u{1F4BB}\u{FE0F}",
    "desktop": "\u{1F5A5}\u{FE0F}",
    "cloud":   "\u{2601}\u{FE0F}",
    "sun":     "\u{2600}\u{FE0F}",
    "cat":     "\u{1F431}\u{FE0F}",
    "apple":   "\u{1F34E}\u{FE0F}",
    "gear":    "\u{2699}\u{FE0F}",
]

/// One picker row's title: the glyph, then the name it travels as. Both, never
/// one or the other - the picture is what you recognise, and the name is what
/// `DECKHAND_MAC_EMOJI` and the device's own logs speak, so hiding it would make
/// the env override and this menu look like two unrelated settings. A name with
/// no glyph in the table falls back to the bare name rather than an empty
/// column, so a missed entry reads as plain instead of as a blank row.
func iconRowTitle(_ name: String) -> String {
    guard let g = MAC_ICON_GLYPHS[name] else { return name }
    return "\(g)  \(name)"
}

/// Plays it, or does nothing if silenced or the name has gone missing. A sound
/// file that is absent must not throw or log on a 3s timer - macOS ships these,
/// but a stored name outlives the OS release that had it.
func playAskSound() {
    guard !askSoundName.isEmpty, let snd = NSSound(named: askSoundName) else { return }
    snd.play()
}

/// Monospaced DIGITS, at menu-bar text size. Not cosmetic: these percentages are
/// rewritten every few seconds, and in a proportional font each digit change
/// shifts the whole item's width, so the bar's other icons twitch sideways on a
/// timer. Monospaced digits leave only a real change of digit COUNT moving
/// anything.
let F_BAR = NSFont.monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)

func menuTitle(_ parts: [(String, NSFont, NSColor)]) -> NSAttributedString {
    let out = NSMutableAttributedString()
    for (t, f, c) in parts where !t.isEmpty {
        out.append(NSAttributedString(string: t, attributes: [.font: f, .foregroundColor: c]))
    }
    return out
}

/// Anything past this is called stale. 15 minutes, the same threshold the
/// firmware dims its hero number at (see `quotaAgeSec` in CLAUDE.md) - one number
/// so the two surfaces cannot disagree about whether a reading is live.
let QUOTA_STALE_SEC = 900


// MARK: - The dropdown's rows (redesigned 2026-11-07)
//
// HOW IT IS READ decided its shape. Someone opens this menu to answer, in order:
// is it working; how much quota is left and when does it come back; who is waiting
// on me. So it is three SECTIONS under plain headers (the connection, then Claude
// and Codex usage, then Sessions), each row is ONE line where it used to be two,
// and every row puts its answer on the left and its "when" in a right-aligned
// column - the shape of a macOS menu with shortcuts, which is the menu everyone
// already knows how to scan. The explanations that used to sit on a second line
// ("9% elapsed, behind pace") moved into each row's tooltip: they teach once, and
// a teaching line on every row was half the menu's height.
//
// Before: 4 quota windows took 8 lines, labelled `5h`/`7d`/`CX 5h`/`CX 7d`, with no
// heading saying which service a row belonged to; the connection took three rows
// and printed the raw link id (`usb:Deckhand-C114`).

/// The right-hand column's position. One value for every row so the columns line
/// up across sections; wide enough that the widest left side (a 22-character
/// project name and its agent tag) never reaches it.
let MENU_RIGHT_TAB: CGFloat = 330
let F_HEADER = NSFont.systemFont(ofSize: 11, weight: .semibold)

/// A row with an answer on the left and a right-aligned note, by a real tab stop -
/// padding with spaces cannot align a proportional font.
func menuColumns(_ left: [(String, NSFont, NSColor)], _ right: [(String, NSFont, NSColor)] = []) -> NSAttributedString {
    let out = NSMutableAttributedString(attributedString: menuTitle(left))
    if right.contains(where: { !$0.0.isEmpty }) {
        out.append(NSAttributedString(string: "\t", attributes: [.font: F_BODY]))
        out.append(menuTitle(right))
    }
    let ps = NSMutableParagraphStyle()
    ps.tabStops = [NSTextTab(textAlignment: .right, location: MENU_RIGHT_TAB)]
    out.addAttribute(.paragraphStyle, value: ps, range: NSRange(location: 0, length: out.length))
    return out
}

/// A section header: the service or the list it heads, and a note on the right.
func menuHeader(_ title: String, note: String = "") -> NSAttributedString {
    menuColumns([(title, F_HEADER, .secondaryLabelColor)], [(note, F_SMALL, .secondaryLabelColor)])
}

/// A window by its LENGTH, in words: "5-hour", "Weekly", else "3-day" / "8-hour".
/// Claude's are fixed by the plan; Codex's come off the tick line.
func windowName(_ minutes: Int?) -> String {
    guard let m = minutes, m > 0 else { return "Usage" }
    if m == 10080 { return "Weekly" }
    return m >= 1440 ? "\(m / 1440)-day" : "\(m / 60)-hour"
}

/// One usage window on ONE line: name, bar (with its pace tick), percentage and
/// pace glyph on the left; when it resets on the right. `pct` nil is a window with
/// no current reading (it reset since the service last reported one). Returns the
/// row and its tooltip, which carries the sentence the old second line did.
func quotaRow(_ windowMin: Int?, _ pct: Int?, _ reset: Int?, stale: Bool, name named: String? = nil) -> (NSAttributedString, String) {
    // `named`: a row labelled by its GROUP and window ("Argon 7d", "C/GPT 5h") rather
    // than by the window alone. Ten columns, so every section's bars still line up.
    let name = named ?? windowName(windowMin)
    let label = (name.padding(toLength: 10, withPad: " ", startingAt: 0), F_MONO, NSColor.secondaryLabelColor)
    guard let pct else {
        return (menuColumns([label, ("   \u{2013}", F_MONO, .secondaryLabelColor)],
                            [("no reading since it reset", F_SMALL, .secondaryLabelColor)]),
                "\(name): no current reading. This window has reset since the service last reported its usage; it updates the next time you use it.")
    }
    let colour = quotaColour(pct: pct, stale: stale)
    let pace = stale ? nil : pacePct(resetInMin: reset, windowMin: windowMin)
    let trackColour: NSColor = stale ? .quaternaryLabelColor : .tertiaryLabelColor
    // THE NUMBER LEADS, and the bar follows it (a decision the pace checks hold):
    // the figure the row reports is where the eye lands, its qualifiers sit next to
    // it, and the bar is the context after. The pace glyph is in NEUTRAL ink - it
    // reports a comparison, not a level, and in the usage colour a red ▼ beside a
    // red 96% read as part of the alarm. A blank cell holds its place when there is
    // no pace, so the bars of every row start in the same column.
    var left: [(String, NSFont, NSColor)] = [
        label,
        (String(format: "%4d%%", pct), F_MONO_BOLD, colour),
        (" " + (pace == nil ? " " : paceGlyph(pct: pct, pace: pace)) + "  ", F_MONO, .secondaryLabelColor),
    ]
    for (text, role) in quotaBarRuns(pct, pace: pace) {
        left.append((text, F_MONO, role == .fill ? colour : role == .track ? trackColour : .secondaryLabelColor))
    }
    let right = reset.map { "resets in \(humanMinutes($0))" } ?? ""
    var tip = "\(name): \(pct)% used"
    if stale { tip += " - this reading is not current, so there is no pace" }
    else if pace != nil { tip += ". " + paceNote(pct: pct, pace: pace).prefix(1).uppercased() + paceNote(pct: pct, pace: pace).dropFirst() }
    if let r = reset {
        let at = Date().addingTimeInterval(TimeInterval(r * 60))
        let f = DateFormatter()
        f.dateFormat = r < 1440 ? "HH:mm" : "EEE HH:mm"
        tip += ".\nResets in \(humanMinutes(r)), at \(f.string(from: at))."
    }
    if pct >= 95 && !stale { tip += "\nAt or near the limit." }
    return (menuColumns(left, [(right, F_SMALL, .secondaryLabelColor)]), tip)
}

/// How long ago, from the host's seconds-since-local-midnight `actSec`. Sessions
/// older than a day have aged out of the list long before this could wrap.
func sessionAge(_ actSec: Int?) -> String? {
    guard let a = actSec, a >= 0 else { return nil }
    let c = Calendar.current.dateComponents([.hour, .minute, .second], from: Date())
    let now = (c.hour ?? 0) * 3600 + (c.minute ?? 0) * 60 + (c.second ?? 0)
    let ago = (now - a + 86400) % 86400
    return ago < 60 ? "just now" : humanMinutes(ago / 60)
}

/// ONE LESS than the host's own 40-character slice, and that is the whole trick.
/// A title arriving at exactly 40 is indistinguishable from one that was cut
/// there, so `clip` at 40 saw no overflow and left the hard mid-word cut on
/// screen ("...recommendations API wor"). Clipping one character shorter makes
/// every at-the-cap title go through the word-boundary path and end in an
/// ellipsis, which says "there is more" instead of looking like a typo.
let SESSION_TITLE_SHOW = 39

/// One session: status glyph, project and (for a non-Claude agent) its name on the
/// left, the state and how long it has been in it on the right, and what it is
/// about on a second line. Shape and word, never colour alone: ■ needs you, ○
/// waiting, ● working - the device's three states, in the host's urgency order.
func sessionTitle(_ r: SessionRow) -> NSAttributedString {
    let asking = r.status == "asking"
    let glyph = asking ? "\u{25A0}" : (r.status == "waiting" ? "\u{25CB}" : "\u{25CF}")
    let agent = r.agent == "cx" ? "Codex" : (r.agent == "ag" ? "Antigravity" : "")
    let age = sessionAge(r.actSec)
    let state: String
    switch r.status {
    case "asking": state = "needs you"
    case "waiting": state = "waiting" + (age.map { " \u{00B7} \($0)" } ?? "")
    default: state = r.status
    }
    let out = NSMutableAttributedString(attributedString: menuColumns([
        ("\(glyph)  ", F_BODY, asking ? .systemOrange : .secondaryLabelColor),
        (clip(r.name, 22), asking ? F_BOLD : F_BODY, .labelColor),
        (agent.isEmpty ? "" : "  \(agent)", F_SMALL, .tertiaryLabelColor),
    ], [(state, asking ? F_BOLD : F_SMALL, asking ? .systemOrange : .secondaryLabelColor)]))
    if !r.title.isEmpty {
        out.append(menuTitle([("\n     ", F_MONO, .secondaryLabelColor),
                              (clip(r.title, SESSION_TITLE_SHOW), F_SMALL, .secondaryLabelColor)]))
    }
    return out
}

/// One editor window, from `~/.claude/ide/<port>.lock` - Claude Code's own record
/// of an IDE it is attached to, written per WORKSPACE (two VS Code windows on
/// different folders produce two locks sharing one pid).
struct IdeWindow { var ideName = "", folder = ""; var pid = 0 }

/// Every editor window Claude Code currently knows about. Pure file reads, no
/// spawns, so this can run on a click without a budget worry.
func ideWindows() -> [IdeWindow] {
    let dir = NSHomeDirectory() + "/.claude/ide"
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
    var out: [IdeWindow] = []
    for n in names where n.hasSuffix(".lock") {
        guard let d = FileManager.default.contents(atPath: dir + "/" + n),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
        let folders = (o["workspaceFolders"] as? [String]) ?? []
        for f in folders {
            out.append(IdeWindow(ideName: o["ideName"] as? String ?? "",
                                 folder: f, pid: o["pid"] as? Int ?? 0))
        }
    }
    return out
}

/// Where a click on a session row goes. Three tiers, because "jump to the app"
/// means genuinely different things per surface.
enum SessionTarget {
    /// An editor window: open its WORKSPACE FOLDER with that app, which brings
    /// the existing window forward.
    case workspace(app: URL, folder: String, ide: String)
    /// A terminal or the desktop app: bring the app forward and nothing more.
    case activate(NSRunningApplication)
    /// Unknown app, or the app is not running: what this menu has always done.
    case reveal(String)
    case nothing
}

/// The FOLDER matters more than it looks. A session's `path` is its live cwd, so
/// it is routinely a SUBDIRECTORY of the workspace (this repo reports
/// ".../deckhand/host"), and opening that in VS Code spawns a NEW window on the
/// subfolder instead of focusing the one already open. So the lock file's own
/// workspaceFolder is the thing to open.
///
/// It also copes with the host's `truncatePath`, which prefixes "..." past 64
/// characters. A plain suffix test does NOT recover those - measured on a crafted
/// case and it failed: the truncation can begin INSIDE the workspace folder
/// ("...ers/yujia/projects/deckhand/mac-app"), so neither string contains the
/// other. What always holds is that the kept tail starts somewhere within the
/// full cwd, and the folder is a prefix of that cwd - so some SUFFIX of the folder
/// is a PREFIX of the tail. That is what `overlaps` looks for, and only for a
/// path that really was truncated, since on a whole path it would invite false
/// matches.
func matchingIdeWindow(_ r: SessionRow) -> IdeWindow? {
    let truncated = r.path.hasPrefix("...")
    let p = truncated ? String(r.path.dropFirst(3)) : r.path
    guard !p.isEmpty else { return nil }

    func overlaps(_ folder: String) -> Bool {
        if p.hasPrefix(folder) { return true }
        guard truncated else { return false }
        // Require a decent run of shared text - a 2-character tail would match
        // almost anything, and picking the wrong window is worse than falling
        // back to activating the app.
        var tail = Substring(folder)
        while tail.count >= 6 {
            if p.hasPrefix(tail) { return true }
            tail = tail.dropFirst()
        }
        return false
    }
    // Longest folder first, so a nested workspace wins over its parent.
    for w in ideWindows().sorted(by: { $0.folder.count > $1.folder.count })
    where overlaps(w.folder) { return w }
    return nil
}

/// Only surfaces MEASURED to be editors get the workspace treatment. The value
/// observed on this machine is "claude-vscode"; JetBrains is included on the same
/// naming pattern but is UNVERIFIED, and anything else - a terminal, the desktop
/// app - falls through to activate-only deliberately. There is no way to focus a
/// particular terminal tab, and opening the folder there would spawn a new window,
/// which is worse than doing the unsurprising thing.
func isEditorEntry(_ entry: String) -> Bool {
    entry.contains("vscode") || entry.contains("jetbrains")
}

func sessionTarget(_ r: SessionRow) -> SessionTarget {
    guard !r.app.isEmpty else { return r.path.isEmpty ? .nothing : .reveal(r.path) }
    // NOT RUNNING means fall back rather than LAUNCH. Clicking a stale row should
    // never boot an editor for a session that no longer exists in it.
    guard let running = NSRunningApplication
        .runningApplications(withBundleIdentifier: r.app).first else {
        return r.path.isEmpty ? .nothing : .reveal(r.path)
    }
    if isEditorEntry(r.appEntry), let w = matchingIdeWindow(r),
       let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: r.app) {
        return .workspace(app: url, folder: w.folder, ide: w.ideName)
    }
    return .activate(running)
}

/// One line saying what a click will do, for `--open-session` and the row tooltip.
/// Shared so the diagnostic cannot describe one thing while the click does another.
func describeTarget(_ t: SessionTarget) -> String {
    switch t {
    case .workspace(_, let folder, let ide): return "open \(folder) in \(ide.isEmpty ? "the editor" : ide)"
    case .activate(let app): return "activate \(app.localizedName ?? app.bundleIdentifier ?? "the app")"
    case .reveal(let path): return "reveal \(path) in Finder"
    case .nothing: return "nothing (no app and no path)"
    }
}

func performTarget(_ t: SessionTarget) {
    switch t {
    case .workspace(let app, let folder, _):
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        NSWorkspace.shared.open([URL(fileURLWithPath: folder)],
                                withApplicationAt: app, configuration: cfg)
    case .activate(let app):
        app.activate(options: [.activateAllWindows])
    case .reveal(let path):
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    case .nothing:
        break
    }
}

// ---------------------------------------------------------------------------
// WIRELESS PAIRING: the Mac's menu-bar half.
//
// THE USER TYPES NOTHING, AND THAT IS A CORRECTION RATHER THAN A SIMPLIFICATION.
// An earlier design had the device show a code and the user type it in HERE, with
// the Mac proving agreement by HMAC. It was broken: that proof derives from the
// ECDH shared secret alone, so any peer completing the exchange computes a valid
// one WITHOUT EVER SEEING THE CODE. What commits a key is the CONFIRM tap on the
// device's own glass, bound to the peer that did the exchange - so this dialog's
// only job is to put THIS MAC's derived code where a person can compare it with
// the device's screen. There is no text field here, and there must never be one.
// See docs/superpowers/specs/2026-08-30-wireless-pairing.md.
//
// THE COMPARISON IS THE SECURITY PROPERTY, so legibility is a security cost and
// not a cosmetic one: a racing attacker and a man-in-the-middle both fail ONLY
// because a person reads two six-digit numbers and decides they differ. Hence the
// big monospaced face, and hence the digits are drawn EXACTLY as the device draws
// them - ungrouped, no separators, no "482 913" (settings.ino draws
// `pairCodeDigits` in one T_HERO drawString). Two strings that are the same number
// but a different SHAPE are two strings a tired person compares wrongly.
let PAIR_CODE_DIGITS = 6
// A floor on the dialog's face, asserted rather than described: at F_MONO's 11pt
// this is a comparison made with a magnifying glass.
let PAIR_CODE_FONT_PT: CGFloat = 44
// Kerning only - it never inserts a character, so the string stays the six digits
// the device shows while the glyphs stop touching.
let PAIR_CODE_KERN: CGFloat = 6
// Room for a plausible roomful. The host's own scan list is unbounded; a menu is
// not, and rows past this are simply not shown (the status row states the count).
let MAX_PAIR_ROWS = 8

struct PairDevice: Equatable { var name = ""; var rssi = 0 }

/// The `pairing` block of the host's heartbeat, verbatim. `code` is the code THIS
/// MAC derived; it is not a secret from the local user (they are about to read the
/// same six digits off the device) and it never goes on the wire in either
/// direction - it exists on two screens and nowhere else.
struct PairInfo: Equatable {
    // Whether the HOST speaks this protocol at all: the block is absent from the
    // heartbeat of any host predating the feature. Without it the row would be
    // live against a host that forwards PAIRSCAN to the device as an unknown line
    // and does nothing else - a control that cannot work, which is the thing this
    // repo refuses to draw on the glass and should not draw here either.
    var supported = false
    // idle | scanning | awaiting-code | verifying | done | failed
    var state = "idle"
    var devices: [PairDevice] = []
    var name = "", label = "", code = "", error = ""
    var sec = 0
}

func pairInfoFrom(_ obj: [String: Any]?) -> PairInfo {
    var p = PairInfo()
    guard let obj else { return p }
    p.supported = true
    p.state = (obj["state"] as? String) ?? "idle"
    p.name = (obj["name"] as? String) ?? ""
    p.label = (obj["label"] as? String) ?? ""
    p.code = (obj["code"] as? String) ?? ""
    p.error = (obj["error"] as? String) ?? ""
    p.sec = (obj["sec"] as? Int) ?? 0
    for d in (obj["devices"] as? [[String: Any]]) ?? [] {
        guard let n = d["name"] as? String, !n.isEmpty else { continue }
        p.devices.append(PairDevice(name: n, rssi: (d["rssi"] as? Int) ?? 0))
    }
    return p
}

/// `awaiting-code` IS NOT ENOUGH TO SHOW A CODE, and this is the one detail that
/// would have shipped an empty dialog. `pairStart()` sets that state the moment it
/// begins connecting - deliberately, because the user's job from then on is to
/// watch for two codes - and `code` stays "" until the device answers with its
/// public key, which can be seconds later or never. So the dialog waits for six
/// actual digits, not for the state.
func pairCodeReady(_ p: PairInfo) -> Bool {
    p.state == "awaiting-code" && p.code.count == PAIR_CODE_DIGITS
        && p.code.allSatisfy { $0.isASCII && $0.isNumber }
}

/// What the menu should DO about the state it just read. Pure, so `--pair-check`
/// can drive the whole state machine without a host, a device or a click.
enum PairAction: Equatable {
    case none
    case compare(code: String, device: String, label: String)
    case done(device: String)
    case failed(device: String, reason: String)
}

/// What has already been put in front of the user, so nothing is shown twice. It
/// is an argument rather than a global for the same reason `AskWatcher` is a
/// struct: a decision that depends on history is only testable if the history is.
struct PairSeen: Equatable { var code = ""; var outcome = "" }

/// The transition. Two rules are load-bearing:
///
///  - `idle`/`scanning`/`awaiting-code` CLEAR the outcome token, which is what
///    makes a REPEAT reportable. Two identical failures in a row (same device,
///    same cause) produce identical tokens, so without a clear on the way past,
///    the second one would be silently swallowed - and a pairing that fails
///    silently is indistinguishable from a pairing that is merely slow, which is
///    the whole complaint this feature's refusals are written to avoid.
///  - `verifying` keeps both: it sits between the user clicking Match and the
///    device's own CONFIRM tap, and re-raising the dialog there would ask a
///    question that has already been answered.
func pairNext(_ p: PairInfo, _ seen: PairSeen) -> (action: PairAction, seen: PairSeen) {
    var next = seen
    switch p.state {
    case "idle", "scanning":
        return (.none, PairSeen())
    case "awaiting-code":
        next.outcome = ""
        guard pairCodeReady(p), p.code != seen.code else { return (.none, next) }
        next.code = p.code
        return (.compare(code: p.code, device: p.name, label: p.label), next)
    case "verifying":
        // The code token is spent the moment the state leaves `awaiting-code`,
        // and that is not tidiness: SIX DIGITS COLLIDE ONCE IN A MILLION, so a
        // second exchange that happens to derive the code the last one did would
        // otherwise be swallowed by the dedupe - no dialog at all, which presents
        // as pairing being broken. The state machine never returns to
        // `awaiting-code` from here (pairState only moves forwards), so nothing
        // is re-raised by clearing it.
        next.code = ""
        return (.none, next)
    case "done":
        next.code = ""
        let token = "done:\(p.name)"
        guard token != seen.outcome else { return (.none, next) }
        next.outcome = token
        return (.done(device: p.name), next)
    case "failed":
        next.code = ""
        let token = "failed:\(p.name):\(p.error)"
        guard token != seen.outcome else { return (.none, next) }
        next.outcome = token
        return (.failed(device: p.name, reason: p.error), next)
    default:
        return (.none, next)
    }
}

/// WHETHER AN ACTION IS WORTH INTERRUPTING FOR, which is a different question
/// from whether it is new. The host's pairing block OUTLIVES THIS APP: a `done` or
/// `failed` sitting in the heartbeat from an hour ago is not news, and raising it
/// would open a window over whatever the person was doing at login - the login
/// item makes that the common case, not a corner one.
///
/// An exchange still IN FLIGHT is news even on the first tick: it has a
/// 120-second deadline running under it and nowhere else to be shown.
func pairWorthRaising(_ action: PairAction, firstTick: Bool) -> Bool {
    switch action {
    case .none: return false
    case .compare: return true
    case .done, .failed: return !firstTick
    }
}

/// The one row inside the submenu that says where the exchange stands. It carries
/// a READING, so it is enabled (see `--legibility-check`): a disabled row is drawn
/// at ~31% of full strength, and "Failed: bluetooth is poweredOff" in grey is a
/// cause nobody reads.
func pairStatusText(_ s: HostStatus) -> String {
    let p = s.pairing
    if !s.running { return "The host is not running" }
    if !p.supported { return "This host is too old for wireless pairing" }
    let who = p.name.isEmpty ? "the device" : p.name
    switch p.state {
    case "scanning":
        return "Scanning for nearby devices\u{2026}"
    case "awaiting-code":
        // The two halves of one state, told apart the way the dialog tells them
        // apart - by whether there are digits yet.
        return pairCodeReady(p)
            ? "Compare the code with \(who)\(p.sec > 0 ? "  ·  \(p.sec)s left" : "")"
            : "Waiting for \(who) to answer\(p.sec > 0 ? "  ·  \(p.sec)s left" : "")"
    case "verifying":
        return "Now tap CONFIRM on \(who)\(p.sec > 0 ? "  ·  \(p.sec)s left" : "")"
    case "done":
        return "Paired with \(who)"
    case "failed":
        return "Failed: \(p.error.isEmpty ? PAIR_NO_REASON : p.error)"
    default:
        if p.devices.isEmpty { return "No devices found yet - open this to scan" }
        return "\(p.devices.count) device\(p.devices.count == 1 ? "" : "s") found - pick one"
    }
}

func pairDeviceRowTitle(_ d: PairDevice) -> String { "\(d.name)  ·  \(d.rssi) dBm" }


/// What a failure with NO cause says. One phrase, shared by the menu's row and the
/// window's body: both have to say something, or they render "Failed: " and read
/// as a truncated message rather than a missing one - and two spellings of one
/// fact drift.
let PAIR_NO_REASON = "no reason given"
/// Devices are only pickable when a new exchange could actually START. Offering a
/// row that the host would refuse ("an exchange is already running") is exactly
/// the control-that-cannot-work this repo refuses to draw on the device.
func pairCanStart(_ s: HostStatus) -> Bool {
    s.running && s.pairing.supported && (s.pairing.state == "idle" || s.pairing.state == "done" || s.pairing.state == "failed")
}

/// True while an exchange is live, i.e. while Cancel means something and a scan
/// would be refused.
func pairInFlight(_ s: HostStatus) -> Bool {
    s.running && s.pairing.supported && (s.pairing.state == "awaiting-code" || s.pairing.state == "verifying")
}

// ---------------------------------------------------------------------------
// THE PAIRING WINDOW.
//
// THE SURFACE IS A WINDOW BECAUSE AN NSMenu CANNOT HOLD A MULTI-STEP FLOW, and
// that is a structural fact rather than a preference: AppKit dismisses a menu on
// every item action, so each step of pairing cost a trip back to the menu bar.
// Measured on the submenu this replaces: open the bar, hover Pair (which fires a
// 5s PAIRSCAN), click Scan -> THE MENU CLOSES, open the bar again, hover, click a
// device -> THE MENU CLOSES AGAIN, then wait up to one refresh for a modal, answer
// it, dismiss a second modal, tap CONFIRM on the glass, dismiss a third. Two to
// three visits to the menu bar and three stacked NSAlerts for one 30-second task,
// with the 120-second deadline visible only by reopening the menu and hovering.
//
// So: ONE window that owns the whole exchange - the scan list refreshing in
// place, the comparison, the countdown, and the outcome - and NOT ONE MODAL. It
// re-renders from the host's heartbeat on a ticker of its own (PAIR_TICK_SEC),
// because the six digits arriving up to 3s after the device sent them reads as the
// device being slow.
//
// WHAT DID NOT CHANGE IS THE SECURITY PROPERTY, and none of it may: the user types
// nothing, the digits are drawn exactly as the device draws them, both answers are
// explicit words, and NEITHER ANSWER IS THE RETURN KEY'S. See the note above
// PAIR_CODE_DIGITS, and docs/superpowers/specs/2026-08-30-wireless-pairing.md.

/// While the window is open the heartbeat is read every second instead of every
/// three. THE CODE'S LATENCY IS THE REASON: `code` appears in one tick and the
/// person is standing at the device waiting for it, so a 3s read spends a tenth of
/// the 120s window doing nothing visible. It runs only while the window is up.
let PAIR_TICK_SEC: TimeInterval = 1

/// Which of the seven screens the window is showing. Derived, never stored - the
/// host's `state` plus `PairLocal` decide it, so there is no second state machine
/// here to drift from the host's.
enum PairPhase: String, Equatable {
    case unavailable   // no host, or a host that predates the feature
    case browse        // idle or scanning: the list, and Scan
    case connecting    // PAIRSTART sent, the device has not answered with its key yet
    case compare       // six digits are in and unanswered - THE screen this feature exists for
    case confirming    // the proof is sent; the device owes a CONFIRM tap
    case cancelling    // this Mac asked for the exchange to be dropped
    case done
    case failed
}

/// A button's JOB, carried as a tag so one selector serves every phase. The raw
/// values are AppKit tags and must stay distinct; `.none` is 0 so an untagged
/// button can never be mistaken for a live one.
enum PairButtonRole: Int, Equatable {
    case none = 0, match, decline, cancel, close
}

/// Title, job, and key equivalent together, because on this surface the KEY IS
/// PART OF THE MEANING: "They match" must not be reachable by a stray Return.
struct PairButtonSpec: Equatable {
    var title: String
    var role: PairButtonRole
    var key: String = ""
}

/// The half of the window's state that the HOST does not publish: what this Mac
/// has already answered, and whether it has asked to cancel.
///
/// It exists only to bridge the ~1s between a click here and the host republishing
/// what it did about it. Without it the comparison re-renders with two LIVE
/// buttons over a question already answered, and Cancel leaves the exchange
/// looking untouched for a tick - both of which invite a second click that the
/// host would refuse.
struct PairLocal: Equatable {
    var answered = ""     // the six digits this Mac said "They match" to
    var cancelling = false
}

/// THE LOCAL HALF MUST EXPIRE ON ITS OWN, or it becomes a second state machine.
/// Pure, so `--pair-check` drives it: an answer belongs to the CODE it answered
/// (a new exchange with new digits clears it), and any terminal or pre-exchange
/// state clears the lot.
func pairLocalNext(_ p: PairInfo, _ local: PairLocal) -> PairLocal {
    switch p.state {
    case "awaiting-code", "verifying":
        var l = local
        if !l.answered.isEmpty && l.answered != p.code { l.answered = "" }
        return l
    default:
        return PairLocal()
    }
}

/// EVERYTHING THE WINDOW SHOWS, as data. The window itself only paints this, so
/// `--pair-check` can assert what a person would see in every state without a
/// host, a device, a radio or a click - the same reason `pairNext` is pure.
struct PairWindowModel: Equatable {
    var phase: PairPhase = .browse
    var title = ""
    var detail = ""
    var footer = ""
    var code = ""
    var devices: [PairDevice] = []
    var showsList = false
    var rowsEnabled = false
    var scanTitle = "Scan for devices"
    var scanEnabled = false
    var scanShown = false
    var busy = false
    /// Floating only while an exchange is live. The comparison is made by looking
    /// AWAY from the Mac, at the device, so the window must not be lost behind a
    /// browser in the two seconds that takes; a window left open at rest has no
    /// business sitting above everything.
    var floats = false
    var primary: PairButtonSpec?
    var secondary: PairButtonSpec?
}

func pairWindowModel(_ s: HostStatus, _ local: PairLocal = PairLocal()) -> PairWindowModel {
    var m = PairWindowModel()
    let p = s.pairing
    m.devices = Array(p.devices.prefix(MAX_PAIR_ROWS))
    let close = PairButtonSpec(title: "Close", role: .close, key: "\r")

    // THE WINDOW IS REACHABLE IN BOTH OF THESE, which the dimmed submenu row it
    // replaces was not: a control that is merely grey states nothing, and from the
    // Mac "it did not work" and "it is not possible here" look identical.
    guard s.running else {
        m.phase = .unavailable
        m.title = "The host is not running"
        m.detail = "Pairing is the host's half of the exchange - it owns the Bluetooth radio, so "
            + "with it stopped there is nothing here for this window to drive.\n\n"
            + "Choose Start Deckhand in the menu, then try again."
        m.primary = close
        return m
    }
    guard p.supported else {
        m.phase = .unavailable
        m.title = "This host is too old for wireless pairing"
        m.detail = "Its heartbeat carries no pairing block at all, which is how a host says it "
            + "speaks this protocol. Anything offered here would be forwarded to the device as an "
            + "unknown line and do nothing.\n\n"
            + "Update the host and restart it. Until then a device is paired over USB."
        m.primary = close
        return m
    }

    let who = p.name.isEmpty ? "the device" : p.name
    let cancel = PairButtonSpec(title: "Cancel pairing", role: .cancel, key: "\u{1b}")
    // The deadline is the DEVICE's 120-second window, and it is the one fact that
    // decides whether to hurry. It was previously visible only by reopening the
    // menu and hovering the submenu.
    let left = p.sec > 0 ? "\(p.sec)s left" : ""
    let closing = "Closing this window cancels the exchange."
    let flightFooter = left.isEmpty ? closing : "\(left)  \u{00B7}  \(closing)"

    // TWO ROUTES INTO ONE SCREEN: the host has republished `verifying`, or it has
    // not yet and this Mac knows it answered. Rendering the comparison again in
    // that gap would put two live buttons over a question already answered.
    let answeredHere = p.state == "awaiting-code" && pairCodeReady(p) && p.code == local.answered
    let state = answeredHere ? "verifying" : p.state

    if local.cancelling && (state == "awaiting-code" || state == "verifying") {
        m.phase = .cancelling
        m.title = "Cancelling\u{2026}"
        m.detail = "The host has been asked to drop the exchange with \(who). Nothing was stored, "
            + "and nothing will be.\n\nThe list comes back as soon as the link is closed."
        m.busy = true
        m.floats = true
        m.footer = left
        return m
    }

    switch state {
    case "awaiting-code" where pairCodeReady(p):
        m.phase = .compare
        m.code = p.code
        m.title = "Does \(who) show this code?"
        m.detail = "This Mac derived the code below from its exchange with \(who)"
            + (p.label.isEmpty ? "" : " (\(p.label))")
            + ". The device's screen shows its own.\n\n"
            + "If the two are identical, choose \u{201C}They match\u{201D} - then tap CONFIRM on the "
            + "device itself to store the key. If they differ, something else answered: choose "
            + "\u{201C}They don\u{2019}t match\u{201D} and nothing is stored."
        // The order puts the denial on the LEFT, where Cancel lives, so the hand
        // that reaches for the safe answer finds it where it always is.
        m.secondary = PairButtonSpec(title: "They don\u{2019}t match", role: .decline, key: "\u{1b}")
        // NOT THE RETURN KEY'S, and this is the single input the whole design
        // rests on: a stray Return must never assert "I compared two numbers".
        // Escape still declines, because refusing has to stay the cheap option.
        m.primary = PairButtonSpec(title: "They match", role: .match, key: "")
        m.footer = flightFooter
        m.floats = true
    case "awaiting-code":
        // `pairStart()` sets this state the moment it begins connecting, so the
        // STATE arrives before the digits do - the trap that would otherwise show
        // an empty comparison. See pairCodeReady().
        m.phase = .connecting
        m.title = "Waiting for \(who) to answer"
        m.detail = "The Mac has connected and sent its half of the exchange. The six digits appear "
            + "here the moment the device answers with its own - which needs \(who)'s "
            + "Settings \u{203A} Pairing screen open and waiting."
        m.busy = true
        m.floats = true
        m.secondary = cancel
        m.footer = flightFooter
    case "verifying":
        m.phase = .confirming
        m.title = "Now tap CONFIRM on \(who)"
        m.detail = "The Mac has sent its proof. NOTHING IS STORED until someone standing at the "
            + "device taps CONFIRM on its screen - that tap is what replaces plugging it in, and "
            + "it is what commits the key at both ends.\n\n"
            + "It expires with the device's 120-second pairing window."
        m.busy = true
        m.floats = true
        m.secondary = cancel
        m.footer = flightFooter
    case "done":
        m.phase = .done
        m.title = "Paired with \(who)"
        m.detail = "Both ends derived the same key from the exchange - it was never transmitted. "
            + "This Mac can now answer that device's prompts, and the pairing is listed under "
            + "Devices in this app's Settings window."
        m.primary = close
        m.showsList = true
        m.rowsEnabled = pairCanStart(s)
        m.scanShown = true
        m.scanTitle = "Pair another device"
        m.scanEnabled = pairCanStart(s)
    case "failed":
        m.phase = .failed
        m.title = "Pairing with \(who) failed"
        // THE CAUSE IS THE HOST'S OWN WORDS, always named and never invented here
        // - the rule POWERPROBE's "not on battery (unplug USB; state=2 mv=3866)"
        // refusal exists for.
        m.detail = (p.error.isEmpty ? "The host gave \(PAIR_NO_REASON)." : p.error)
            + "\n\nNothing was stored. Open Settings \u{203A} Pairing on the device, tap PAIR NEW MAC, "
            + "and pick it below - the sightings are still good, so a retry costs one click."
        m.primary = close
        m.showsList = true
        m.rowsEnabled = pairCanStart(s)
        m.scanShown = true
        m.scanTitle = "Scan again"
        m.scanEnabled = pairCanStart(s)
    case "scanning":
        m.phase = .browse
        m.title = "Scanning for nearby devices\u{2026}"
        m.detail = "Anything advertising as a Deckhand appears below as it is heard, strongest "
            + "signal first. The scan takes a few seconds."
        m.busy = true
        m.showsList = true
        m.rowsEnabled = false      // the host refuses PAIRSTART while its radio is scanning
        m.scanShown = true
        m.scanEnabled = false
    default:
        m.phase = .browse
        m.showsList = true
        m.rowsEnabled = pairCanStart(s)
        m.scanShown = true
        m.scanEnabled = pairCanStart(s)
        if p.devices.isEmpty {
            m.title = "No devices found yet"
            m.detail = "Nothing nearby advertised as a Deckhand. Check the device is powered on "
                + "and in range, then choose Scan again.\n\n"
                + "Before picking one: open Settings \u{203A} Pairing on it and tap PAIR NEW MAC. The "
                + "exchange needs that screen open at the other end, and it lasts 120 seconds."
        } else {
            m.title = "\(p.devices.count) device\(p.devices.count == 1 ? "" : "s") found \u{2013} pick one"
            m.detail = "First open Settings \u{203A} Pairing on the device you want and tap PAIR NEW MAC: "
                + "the exchange needs that screen open at the other end, and it lasts 120 seconds. "
                + "Then choose it below.\n\n"
                + "Strongest signal first, so -52 dBm is nearer than -77 dBm."
        }
    }

    // The menu's own list was capped at MAX_PAIR_ROWS and simply stopped; a window
    // can at least say what it is not showing.
    let hidden = p.devices.count - m.devices.count
    if m.showsList && hidden > 0 {
        let note = "\(hidden) further device\(hidden == 1 ? "" : "s") heard but not shown."
        m.footer = m.footer.isEmpty ? note : "\(m.footer)  \u{00B7}  \(note)"
    }
    return m
}

/// THE WINDOW ITSELF, built by a factory so `--pair-check` can inspect the real
/// controls after a real `render()` rather than a description of them. A model
/// that agrees with itself proves nothing: the assertions that matter run the
/// model THROUGH this and then read the buttons back.
///
/// Nothing here decides anything. Every title, every enablement and every key
/// equivalent comes from the model, and the device rows are a FIXED POOL shown or
/// hidden - the same discipline the menu's rows follow, and for a sharper reason
/// here: this list is re-rendered every second under a pointer that may be resting
/// on a row, and rows that are added and removed move under it.
final class PairWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let titleField = NSTextField(labelWithString: "")
    let detailField = NSTextField(wrappingLabelWithString: "")
    let codeField = NSTextField(labelWithString: "")
    let footerField = NSTextField(wrappingLabelWithString: "")
    let spinner = NSProgressIndicator()
    let scanButton: NSButton
    let primaryButton: NSButton
    let secondaryButton: NSButton
    var rows: [NSButton] = []
    let stack = NSStackView()
    let listStack = NSStackView()
    let buttonRow = NSStackView()
    /// Assigned in init. `isDisplayedWhenStopped = false` stops a spinner DRAWING,
    /// not occupying layout, so an idle browse screen indented Scan by the width of
    /// a spinner that was not there.
    private var busyRow = NSStackView()
    private(set) var model = PairWindowModel()
    /// Set by the delegate; the window has no opinion about what closing MEANS.
    var onClose: (() -> Void)?

    init(target: AnyObject?) {
        scanButton = NSButton(title: "Scan for devices", target: target,
                              action: #selector(AppDelegate.pairScan))
        primaryButton = NSButton(title: "", target: target, action: #selector(AppDelegate.pairButton(_:)))
        secondaryButton = NSButton(title: "", target: target, action: #selector(AppDelegate.pairButton(_:)))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: PAIR_WIN_W, height: 260),
                          styleMask: [.titled, .closable],
                          backing: .buffered, defer: false)
        super.init()
        window.title = "Pair a new device"
        // The app is an .accessory, so nothing else keeps this object alive and
        // AppKit's default would free the window on the first close.
        window.isReleasedWhenClosed = false
        window.delegate = self

        titleField.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        detailField.font = F_BODY
        detailField.textColor = .secondaryLabelColor
        detailField.preferredMaxLayoutWidth = PAIR_WIN_W - 2 * PAIR_WIN_PAD
        footerField.font = F_SMALL
        footerField.textColor = .tertiaryLabelColor
        footerField.preferredMaxLayoutWidth = PAIR_WIN_W - 2 * PAIR_WIN_PAD
        codeField.alignment = .center
        // `.center` centres within the FIELD, and a leading-aligned stack sizes a
        // label to its own text - so without a width the alignment had nothing to
        // act on and the digits sat hard left under the prose. Measured on the
        // first capture.
        codeField.translatesAutoresizingMaskIntoConstraints = false
        codeField.widthAnchor.constraint(equalToConstant: PAIR_WIN_W - 2 * PAIR_WIN_PAD).isActive = true
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        for b in [scanButton, primaryButton, secondaryButton] { b.bezelStyle = .rounded }
        scanButton.target = target

        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 4
        rows = (0..<MAX_PAIR_ROWS).map { i in
            let b = NSButton(title: "", target: target, action: #selector(AppDelegate.pairRow(_:)))
            b.bezelStyle = .rounded
            b.alignment = .left
            // The INDEX, not the name: the handler reads the device out of the
            // model it just rendered, so a row can never start an exchange with a
            // device that has since dropped off the list.
            b.tag = i
            b.isHidden = true
            b.translatesAutoresizingMaskIntoConstraints = false
            b.widthAnchor.constraint(equalToConstant: PAIR_WIN_W - 2 * PAIR_WIN_PAD).isActive = true
            listStack.addArrangedSubview(b)
            return b
        }

        let busyRow = NSStackView(views: [spinner, scanButton])
        busyRow.orientation = .horizontal
        busyRow.spacing = 8
        self.busyRow = busyRow

        buttonRow.orientation = .horizontal
        buttonRow.spacing = 10
        buttonRow.addArrangedSubview(NSView())      // pushes the pair to the right
        buttonRow.addArrangedSubview(secondaryButton)
        buttonRow.addArrangedSubview(primaryButton)
        buttonRow.translatesAutoresizingMaskIntoConstraints = false

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: PAIR_WIN_PAD, left: PAIR_WIN_PAD,
                                        bottom: PAIR_WIN_PAD, right: PAIR_WIN_PAD)
        for v in [titleField, detailField, codeField, listStack, busyRow, footerField, buttonRow] {
            stack.addArrangedSubview(v)
        }
        buttonRow.widthAnchor.constraint(equalToConstant: PAIR_WIN_W - 2 * PAIR_WIN_PAD).isActive = true
        window.contentView = stack
    }

    func windowWillClose(_ n: Notification) { onClose?() }

    /// Paint the model. Called every PAIR_TICK_SEC while the window is up, so it
    /// must be idempotent and must not disturb anything the pointer is on.
    func render(_ m: PairWindowModel) {
        model = m
        titleField.stringValue = m.title
        detailField.stringValue = m.detail
        footerField.stringValue = m.footer
        footerField.isHidden = m.footer.isEmpty

        // THE DIGITS, drawn EXACTLY as settings.ino draws them: ungrouped, no
        // separators, and spaced by KERNING - which inserts no character, so the
        // string stays the six the device shows. Two renderings of one number are
        // two things to compare wrongly.
        codeField.isHidden = m.code.isEmpty
        if !m.code.isEmpty {
            // THE PARAGRAPH STYLE IS WHAT CENTRES IT, not the field's `alignment`:
            // an attributed string with no style of its own defaults to natural
            // alignment and OVERRIDES the property, which left the digits hard
            // against the left margin under centred-looking prose. Measured on a
            // capture, after the width constraint alone changed nothing.
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            let a = NSMutableAttributedString(string: m.code, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: PAIR_CODE_FONT_PT, weight: .semibold),
                .foregroundColor: NSColor.labelColor,
                .paragraphStyle: para,
            ])
            // KERNING IS A TRAILING ADVANCE, so applying it to the last digit too
            // pads the string on the right and pushes a "centred" line left of
            // centre by PAIR_CODE_KERN. Visible on the capture. Six digits still
            // get five gaps either way - no character is inserted or lost.
            a.addAttribute(.kern, value: PAIR_CODE_KERN,
                           range: NSRange(location: 0, length: max(0, m.code.count - 1)))
            codeField.attributedStringValue = a
        }

        listStack.isHidden = !m.showsList
        for (i, b) in rows.enumerated() {
            guard i < m.devices.count else { b.isHidden = true; continue }
            b.isHidden = false
            b.attributedTitle = pairRowTitle(m.devices[i])
            b.isEnabled = m.rowsEnabled
        }
        scanButton.isHidden = !m.scanShown
        scanButton.title = m.scanTitle
        scanButton.isEnabled = m.scanEnabled
        spinner.isHidden = !m.busy
        if m.busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        busyRow.isHidden = !m.scanShown && !m.busy

        apply(m.primary, to: primaryButton)
        apply(m.secondary, to: secondaryButton)
        buttonRow.isHidden = m.primary == nil && m.secondary == nil

        window.level = m.floats ? .floating : .normal
        fit()
    }

    private func apply(_ spec: PairButtonSpec?, to button: NSButton) {
        guard let spec else {
            button.isHidden = true
            // A hidden button must not keep a key equivalent: Escape would still
            // fire it, which is how an invisible control answers for someone.
            button.keyEquivalent = ""
            button.tag = PairButtonRole.none.rawValue
            return
        }
        button.isHidden = false
        button.title = spec.title
        button.tag = spec.role.rawValue
        button.keyEquivalent = spec.key
    }

    /// Grow DOWNWARD. AppKit resizes a window about its bottom-left corner, so a
    /// screen that needs more room would otherwise walk the title bar up the
    /// display on every phase change.
    private func fit() {
        stack.layoutSubtreeIfNeeded()
        let h = stack.fittingSize.height
        var f = window.frame
        let top = f.maxY
        f.size = window.frameRect(forContentRect: NSRect(x: 0, y: 0, width: PAIR_WIN_W, height: h)).size
        f.origin.y = top - f.size.height
        window.setFrame(f, display: true)
    }

    func show(activate: Bool) {
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        // An .accessory app has no Dock tile and is never frontmost on its own, so
        // without this the window opens BEHIND whatever the person was reading.
        if activate { NSApp.activate(ignoringOtherApps: true) }
    }
}

let PAIR_WIN_W: CGFloat = 430
let PAIR_WIN_PAD: CGFloat = 20

/// A device row's title. The name and the signal, left-aligned so the list reads
/// as a list; `pairDeviceRowTitle` is the wording, shared with the menu's tooltip
/// so there is one spelling of a sighting in this app.
func pairRowTitle(_ d: PairDevice) -> NSAttributedString {
    let para = NSMutableParagraphStyle()
    para.alignment = .left
    return NSAttributedString(string: pairDeviceRowTitle(d), attributes: [
        .font: F_BODY, .foregroundColor: NSColor.labelColor, .paragraphStyle: para,
    ])
}

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
    // Wireless pairing. ONE ROW, and it opens a window rather than a submenu - see
    // the note above PAIR_TICK_SEC for why a menu cannot hold this flow. It is
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
        if !s.running {
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
        startStop.title = s.running ? "Stop Deckhand" : "Start Deckhand"
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
        if settingsWindow == nil { settingsWindow = SettingsWindowController(app: self) }
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

// ---------------------------------------------------------------------------
// The menu-bar icon: an origami paper boat.
//
// Deliberately NOT the project's ship's wheel. The wheel is the mark - it is on
// the device's waiting screen, in the README hero and in the app bundle icon -
// and a mark carries identity, where a menu-bar glyph has to survive at 16px in
// one flat colour next to two dozen other glyphs. The boat is built for that
// job only, which is why it lives here and nowhere else in the repo.
//
// Coordinates are in a 100-wide boat space, y up, and the shape is three
// polygons: two sail triangles meeting at a vertical crease, and a trapezoid
// hull. THE CREASE IS THE WHOLE POINT - a single filled triangle over a hull
// reads as a generic sailboat, and the gap down the middle is what says folded
// paper. It is a proportion of the width rather than a fixed pixel, so it
// survives every size and both display scales.
let BOAT_W: CGFloat = 100
let BOAT_APEX_Y: CGFloat = 42        // top of the sails
let BOAT_SAIL_Y: CGFloat = -2        // sail feet, sitting on the flat gunwale
let BOAT_SAIL_HALF: CGFloat = 34
let BOAT_CREASE_HALF: CGFloat = 3.5  // half the fold gap
// THE UPTURNED TIPS ARE WHAT MAKE IT PAPER. A flat-topped trapezoid hull under
// two triangles renders as an ordinary sailboat - that was the first attempt,
// and it did. An origami boat's prow and stern rise ABOVE the gunwale, so the
// top edge is: tip, down to a flat gunwale under the sails, back up to the
// other tip.
let BOAT_TIP_Y: CGFloat = 8
let BOAT_TIP_HALF: CGFloat = 50
let BOAT_HULL_BOT_Y: CGFloat = -34
let BOAT_HULL_BOT_HALF: CGFloat = 28
// The gunwale is FLAT exactly where the sails land, so hull and sails touch
// without overlapping. That is not cosmetic: with no overlap the same three
// polygons stroke cleanly for the outline state, where an overlapping hull
// would draw the sails' feet as lines across its own interior.
let BOAT_MID_Y: CGFloat = (BOAT_APEX_Y + BOAT_HULL_BOT_Y) / 2

// Only two states ship, and `barBoatStyle` picks between them on whether a
// device is connected. A hull-only variant was tried for "stopped" and
// rejected: without the sails it reads as a bowl, not a boat.
enum BoatStyle { case solid, outline }

/// The boat's own colour, from the project logo's tile gradient (`docs/logo.svg`,
/// the midpoint of #4C9BE0 -> #12508F). It is the ONLY logo colour that survives
/// both menu bars, and that was measured rather than picked: against a dark bar
/// (#2A2A2A) and a light one (#F5F5F5) it scores **3.01 and 4.37**, so it clears
/// Apple's 3:1 non-text threshold on each. The alternatives all fail one side -
/// the deep blue #1B5FA6 drops to 2.21 on dark, the light #4C9BE0 to 2.72 on
/// light, and the cream #FBF4E9 to **1.00**, i.e. invisible, which is what killed
/// the obvious "cream sails, blue hull" two-tone: half the boat would disappear
/// depending on the wallpaper. Re-measure before changing this.
let DECK_BLUE = NSColor(srgbRed: 0x2F / 255.0, green: 0x76 / 255.0, blue: 0xB8 / 255.0, alpha: 1)

/// Colour is a CHOICE, defaulting to on. The monochrome template version is not
/// a lesser fallback - it is the only one that follows the system, so on a light
/// bar it is arguably the better icon, and which one a given wallpaper favours
/// cannot be decided from here (the black-boat episode in CLAUDE.md is exactly
/// that lesson). Same `object(forKey:) ?? true` reading as `BarPref`, for the
/// same reason: `bool(forKey:)` would ship this switched off.
var colourfulIcon: Bool { UserDefaults.standard.object(forKey: "colourfulIcon") as? Bool ?? true }

func deckhandPaperBoatImage(size: CGFloat, style: BoatStyle, colourful: Bool? = nil) -> NSImage {
    let colour = colourful ?? colourfulIcon
    let img = NSImage(size: CGSize(width: size, height: size), flipped: false) { _ in
        // Black for the template path: a template image is used as a MASK, so
        // what is drawn only has to be opaque - the colour is thrown away.
        (colour ? DECK_BLUE : NSColor.black).set()
        // Width-bound: the boat is wider than it is tall, so the horizontal
        // extent is what has to fit. 1px of inset keeps the hull corners off
        // the bar's edge.
        let k = (size - 2) / BOAT_W
        let cx = size / 2, cy = size / 2
        func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: cx + x * k, y: cy + (y - BOAT_MID_Y) * k)
        }
        func poly(_ pts: [CGPoint]) -> NSBezierPath {
            let p = NSBezierPath()
            p.move(to: pts[0])
            for q in pts.dropFirst() { p.line(to: q) }
            p.close()
            return p
        }

        let sailL = poly([P(-BOAT_SAIL_HALF, BOAT_SAIL_Y), P(-BOAT_CREASE_HALF, BOAT_SAIL_Y),
                          P(-BOAT_CREASE_HALF, BOAT_APEX_Y)])
        let sailR = poly([P(BOAT_SAIL_HALF, BOAT_SAIL_Y), P(BOAT_CREASE_HALF, BOAT_SAIL_Y),
                          P(BOAT_CREASE_HALF, BOAT_APEX_Y)])
        let hull = poly([P(-BOAT_TIP_HALF, BOAT_TIP_Y), P(-BOAT_SAIL_HALF, BOAT_SAIL_Y),
                         P(BOAT_SAIL_HALF, BOAT_SAIL_Y), P(BOAT_TIP_HALF, BOAT_TIP_Y),
                         P(BOAT_HULL_BOT_HALF, BOAT_HULL_BOT_Y),
                         P(-BOAT_HULL_BOT_HALF, BOAT_HULL_BOT_Y)])

        switch style {
        case .solid:
            sailL.fill(); sailR.fill(); hull.fill()
        case .outline:
            for p in [sailL, sailR, hull] {
                p.lineWidth = max(1, (size - 2) * 0.07)
                // Miter with a LOW LIMIT, which is neither of the two obvious
                // choices. A plain miter shoots a spike past the silhouette at
                // the sail apex and both hull tips - it read as a damaged shape.
                // Round fixes that but rounds the tips into soft lumps, and
                // folded paper is crisp. A miter limit bevels only the joins
                // sharp enough to spike and leaves the rest pointed.
                p.lineJoinStyle = .miter
                p.miterLimit = 2
                p.stroke()
            }
        }
        return true
    }
    // TEMPLATE IS WHAT STRIPS COLOUR, so a colourful icon is precisely an icon
    // that stops being one: as a template, macOS renders the shape in its own
    // menu-bar colour and ignores everything we chose (that is why setting
    // contentTintColor did nothing - see the note in `refresh`). The trade is
    // real and goes both ways: a template follows the system and can never clash
    // with a wallpaper, while a coloured one holds its own colour and therefore
    // has to be legible against BOTH bars on its own merits, which is what
    // DECK_BLUE was measured for. A coloured image also does not invert to white
    // while the menu is open and the item is highlighted; it sits on the
    // highlight tint instead, the way every other coloured menu-bar icon does.
    img.isTemplate = !colour
    return img
}

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
    let W: CGFloat = 330, pad: CGFloat = 14
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

// MARK: - The released app: its host, its hooks, its setup, its uninstall
//
// Everything below runs only when isBundled. The dev build compiles it and never
// reaches it, which keeps one source file and one set of renderers for both.

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

extension AppDelegate {
    func startBundledHost() {
        let svc = hostAgent()
        switch svc.status {
        case .enabled:
            // Loaded but not answering: KeepAlive restarts a process that EXITS, not
            // one that hangs, so a stale heartbeat gets a kill-and-restart.
            run("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(agentLabel)"])
        case .requiresApproval:
            let a = NSAlert()
            a.messageText = "Deckhand is turned off in Login Items"
            a.informativeText = "macOS will not run Deckhand's background host until it is allowed again in System Settings \u{203A} General \u{203A} Login Items."
            a.addButton(withTitle: "Open Login Items")
            a.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            if a.runModal() == .alertFirstButtonReturn { SMAppService.openSystemSettingsLoginItems() }
        default:
            // Clear a stray host first (setup's Bluetooth-prompt one, if its window
            // was closed), or the agent's host would fight it for the port and BLE.
            _ = runCapture("/usr/bin/pkill", ["-f", bundledHostScript])
            do { try svc.register() } catch {
                let a = NSAlert()
                a.messageText = "Couldn't start Deckhand's background host"
                a.informativeText = error.localizedDescription
                NSApp.activate(ignoringOtherApps: true)
                a.runModal()
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

let SETUP_W: CGFloat = 470
let SETUP_PAD: CGFloat = 22

/// What the setup window shows. Built by SetupFlow.model(), rendered by SetupWindow,
/// which decides nothing - the PairWindow discipline.
struct SetupModel {
    var title = ""
    var detail = ""
    var steps: [(String, Int)] = []   // 0 to do, 1 now, 2 done, 3 skipped
    var primary = ""                  // "" hides the button
    var secondary = ""
    var busy = false
}

final class SetupWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let titleField = NSTextField(labelWithString: "")
    let stepsField = NSTextField(labelWithString: "")
    let detailField = NSTextField(wrappingLabelWithString: "")
    let spinner = NSProgressIndicator()
    let primaryButton: NSButton
    let secondaryButton: NSButton
    var onClose: (() -> Void)?

    init(target: AnyObject, primary: Selector, secondary: Selector) {
        primaryButton = NSButton(title: "", target: target, action: primary)
        secondaryButton = NSButton(title: "", target: target, action: secondary)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: SETUP_W, height: 300),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Set up Deckhand"
        window.isReleasedWhenClosed = false
        window.delegate = self

        titleField.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        stepsField.font = F_SMALL
        stepsField.textColor = .secondaryLabelColor
        detailField.font = F_BODY
        detailField.textColor = .labelColor
        detailField.preferredMaxLayoutWidth = SETUP_W - 2 * SETUP_PAD
        detailField.isSelectable = true
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        primaryButton.bezelStyle = .rounded
        primaryButton.keyEquivalent = "\r"
        secondaryButton.bezelStyle = .rounded

        let buttons = NSStackView(views: [spinner, NSView(), secondaryButton, primaryButton])
        buttons.orientation = .horizontal
        buttons.spacing = 10
        let stack = NSStackView(views: [titleField, stepsField, detailField, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: SETUP_PAD, left: SETUP_PAD, bottom: SETUP_PAD, right: SETUP_PAD)
        stack.setCustomSpacing(8, after: titleField)
        stack.translatesAutoresizingMaskIntoConstraints = false
        buttons.translatesAutoresizingMaskIntoConstraints = false
        buttons.widthAnchor.constraint(equalToConstant: SETUP_W - 2 * SETUP_PAD).isActive = true
        window.contentView = stack
        stack.widthAnchor.constraint(equalToConstant: SETUP_W).isActive = true
    }

    func render(_ m: SetupModel) {
        titleField.stringValue = m.title
        let marks = ["\u{25CB}", "\u{25B8}", "\u{2713}", "\u{2013}"]
        stepsField.stringValue = m.steps.map { "\(marks[$0.1]) \($0.0)" }.joined(separator: "     ")
        detailField.stringValue = m.detail
        primaryButton.title = m.primary
        primaryButton.isHidden = m.primary.isEmpty
        primaryButton.isEnabled = !m.busy
        secondaryButton.title = m.secondary
        secondaryButton.isHidden = m.secondary.isEmpty
        secondaryButton.isEnabled = !m.busy
        if m.busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        window.layoutIfNeeded()
        if let v = window.contentView { window.setContentSize(v.fittingSize) }
    }

    func show() {
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ n: Notification) { onClose?() }
}

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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)

// Inspection modes. Both build the REAL menu and refresh it against the live
// host, so what they show is what the bar would show - but dryRun keeps refresh
// from touching the watchdog, because a diagnostic must never start or stop
// anything.
/// `--legibility-check`: every row that carries a READING renders at full strength.
///
/// This exists because a real defect shipped and NEITHER instrument could see it.
/// AppKit composites a DISABLED menu item's attributed title at a fraction of
/// full strength - MEASURED at 0.317 by capturing a real menu containing two
/// byte-identical attributed titles differing only in `isEnabled`, and predicted
/// independently by `disabledControlTextColor.alpha / labelColor.alpha` = 0.292.
/// So a disabled row's `.labelColor` percentage lands at 0.847 x 0.317 = 0.27,
/// which IS `.tertiaryLabelColor`: grey, and no colour choice can beat it, since
/// `.labelColor` is already the strongest text colour there is.
///
/// `--menu-dump` prints `.string` and drops colour entirely, and `--menu-preview`
/// drew every row at full strength regardless of `isEnabled` - so the menu looked
/// correct in both while the glass showed grey. The preview now applies the same
/// multiplier, and this check names the invariant so it cannot regress quietly.
///
/// The rows are named by REFERENCE, not matched by their text: a row's job is a
/// property of what the code put in it, not of whether a percent sign survived
/// into the string.
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
// MARK: - The Settings window
//
// HOW PEOPLE USE THIS, which is what decided its shape. The menu is opened many
// times a day to LOOK (is it syncing, how much quota is left, who is waiting) and
// almost never to CHANGE anything; the settings are changed a handful of times,
// mostly in the first week. So the menu is for looking and the three things
// people actually do from it (start or stop, pair, open Settings), and every
// preference lives here, grouped by the question someone arrives with:
//   General     - is it running, does it start at login, what happens when a
//                 session needs me (answer from the device, the sound)
//   Menu Bar    - what sits beside the boat, with a live preview of it
//   Devices     - which displays this Mac knows, which one Bluetooth follows,
//                 forget one, pair one; and what this Mac is called on them
//   Claude Code - are the hooks in, repair or remove them
//   About       - version, updates, the log, setup again, uninstall
// A window can say what a switch DOES under the switch, which a submenu row
// cannot, and that is most of why this exists: half the old rows needed a tooltip
// to be understood, and tooltips are found by accident.
//
// The window decides nothing and writes nothing itself: every control calls the
// AppDelegate function that does exactly what the old menu item did (same trigger
// file line, same UserDefaults key), and the window re-reads the same heartbeat
// snapshot the menu draws from on every refresh.

enum SettingsPane: Int, CaseIterable {
    case general, menuBar, devices, claude, about
    var title: String {
        switch self {
        case .general: return "General"
        case .menuBar: return "Menu Bar"
        case .devices: return "Devices"
        case .claude: return "Claude Code"
        case .about: return "About"
        }
    }
    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .menuBar: return "menubar.rectangle"
        case .devices: return "rectangle.portrait.on.rectangle.portrait"
        case .claude: return "terminal"
        case .about: return "info.circle"
        }
    }
}

final class SettingsModel: ObservableObject {
    weak var app: AppDelegate?
    @Published var s = HostStatus()
    @Published var agent = SMAppService.Status.notRegistered
    @Published var login = false
    @Published var hooks = Hooks.State.notInstalled
    @Published var codexHooks = false
    @Published var agHooks = false
    @Published var busy = false
    @Published var nameDraft = ""
    /// True while the name field has focus, so the 3s refresh does not overwrite
    /// what someone is typing with the name the host still has.
    var nameEditing = false
    // Mirrors of the Mac-side preferences, re-read on every pull so a change made
    // anywhere (another window, `defaults write`) shows here too.
    @Published var prefs: [BarPref: Bool] = [:]
    @Published var sound = ""
    @Published var colourful = true
    // The bar's size: the choice, what Automatic resolved to, and why.
    @Published var barSize = BarSize.automatic
    @Published var barTier = BarTier.full
    @Published var barFitNote = ""
    @Published var barHidden = false

    func pull(_ s: HostStatus, bar: NSStatusBarButton?) {
        self.s = s
        if !nameEditing { nameDraft = s.macTagSource == "name" ? s.macTag : "" }
        prefs = Dictionary(uniqueKeysWithValues: BarPref.allCases.map { ($0, $0.on) })
        sound = askSoundName
        colourful = colourfulIcon
        barSize = BarSize.current
        if let app = app {
            barTier = app.barTier
            barFitNote = app.barFitNote
            barHidden = app.barHidden
        }
    }

    func pullServices() {
        let st = ServiceState.shared
        agent = st.agent
        login = st.login == .enabled
        hooks = st.hooks
        codexHooks = st.codexHooks
        agHooks = st.agHooks
    }

    /// The transports one device is on right now, in words.
    func linkText(_ device: String) -> String? {
        let kinds = Set(s.links.filter { $0.device == device }.map { $0.link.hasPrefix("usb") ? "USB" : "Bluetooth" })
        if kinds.isEmpty { return nil }
        return kinds.sorted(by: >).joined(separator: " and ")   // "USB and Bluetooth"
    }

    func batteryText(_ device: String) -> String? {
        guard let b = s.batts[device], b.ageSec < 180, b.state != 0 else { return nil }
        switch b.state {
        case 2: return "\(b.pct)%, charging"
        case 3: return "\(b.pct)%, full"
        default: return "\(b.pct)%"
        }
    }
}

/// A Toggle whose label is a title with a sentence under it - what the old menu
/// rows had to put in a tooltip.
struct DescribedToggle: View {
    let title: String
    let detail: String
    let isOn: Binding<Bool>
    var body: some View {
        Toggle(isOn: isOn) {
            Text(title)
            Text(detail)
        }
    }
}

struct GeneralPane: View {
    @ObservedObject var m: SettingsModel

    var statusColor: Color {
        !m.s.running ? .secondary : (m.s.deviceConnected ? .green : .orange)
    }
    var statusTitle: String {
        if !m.s.running { return "Stopped" }
        if m.s.deviceConnected, let d = m.s.device { return "Syncing with \(d)" }
        return "Running, no display connected"
    }
    var statusDetail: String {
        if !m.s.running { return "The display is not being updated." }
        if m.s.deviceConnected, let d = m.s.device {
            return m.linkText(d).map { "Connected over \($0)." } ?? "Connected."
        }
        return "Plug a Deckhand in over USB, or turn one on that is paired over Bluetooth."
    }

    var body: some View {
        Form {
            Section {
                HStack(alignment: .center, spacing: 12) {
                    Circle().fill(statusColor).frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(statusTitle).font(.headline)
                        Text(statusDetail).font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if m.s.running { Button("Restart") { m.app?.restartHost() } }
                    Button(m.s.running ? "Stop" : "Start") { m.app?.toggleHost() }
                }
                .padding(.vertical, 2)
            } header: {
                Text("Deckhand")
            } footer: {
                HStack {
                    Text(m.app?.hostSupervisionText() ?? "")
                    Spacer()
                    Button("Open Host Log") { m.app?.openLog() }.buttonStyle(.link)
                }
                .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                DescribedToggle(
                    title: "Open Deckhand at login",
                    detail: isBundled
                        ? "Keeps this menu-bar icon after a restart. The background host starts at login either way."
                        : "Keeps this menu-bar icon after a restart.",
                    isOn: Binding(get: { m.login }, set: { m.app?.setLaunchAtLogin($0) }))
            }

            Section("When a session needs you") {
                DescribedToggle(
                    title: "Answer prompts on the display",
                    detail: m.s.running
                        ? "Approve or deny from the device. Claude Code's own dialog stays open, and whichever answers first wins."
                        : "Available while Deckhand is running.",
                    isOn: Binding(get: { m.s.remoteAnswer }, set: { m.app?.setRemoteAnswer($0) }))
                    .disabled(!m.s.running)
                Picker("Sound", selection: Binding(get: { m.sound }, set: { m.app?.setAskSound($0) })) {
                    Text("None").tag("")
                    Divider()
                    ForEach(ASK_SOUNDS, id: \.self) { Text($0).tag($0) }
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct MenuBarPane: View {
    @ObservedObject var m: SettingsModel

    func toggle(_ p: BarPref) -> Binding<Bool> {
        Binding(get: { m.prefs[p] ?? p.on }, set: { m.app?.setBarPref(p, $0) })
    }
    var mirrorsOn: Bool { (m.prefs[.usage] ?? true) || (m.prefs[.codex] ?? true) || (m.prefs[.gemini] ?? true) || (m.prefs[.sessions] ?? true) }
    func preview(_ tier: BarTier) -> NSImage {
        barImage(barModel(m.s, tier: tier, previewing: true), boat: barBoatStyle(m.s), colourful: m.colourful, height: NSStatusBar.system.thickness)
    }
    var hiddenNote: String? {
        if (m.prefs[.onlyOffline] ?? true) && m.s.deviceConnected && mirrorsOn {
            return "Usage and session counts are hidden right now because \(m.s.device ?? "a display") is connected and shows them."
        }
        return nil
    }
    var sizeFooter: String {
        if m.barHidden {
            return "macOS has no room for Deckhand's icon at this size. Choose a smaller one, or hold \u{2318} and drag Deckhand's icon further right in the menu bar."
        }
        if let note = hiddenNote { return note + " The previews show them anyway." }
        if m.barSize == .automatic {
            return m.barFitNote.isEmpty
                ? "Automatic is showing \(m.barTier.title). It steps down if macOS runs out of room in the menu bar, and tries again when your displays change."
                : m.barFitNote
        }
        return hiddenNote ?? "Hover over the icon in the menu bar for every figure spelled out."
    }

    /// One size: a radio mark, what it keeps, and what it looks like right now.
    func sizeRow(_ size: BarSize) -> some View {
        let selected = m.barSize == size
        let tier = size.tier ?? m.barTier
        return Button { m.app?.setBarSize(size) } label: {
            HStack(spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(size == .automatic ? "Automatic" : tier.title)
                    Text(size == .automatic ? "Fits itself to the space in the menu bar." : tier.detail)
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Image(nsImage: preview(tier))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color(nsColor: .windowBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color(nsColor: .separatorColor)))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    var body: some View {
        Form {
            Section {
                ForEach(BarSize.allCases, id: \.self) { sizeRow($0) }
            } header: {
                Text("Size")
            } footer: {
                Text(sizeFooter).font(.caption).foregroundStyle(m.barHidden ? Color.orange : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section("Beside the icon") {
                DescribedToggle(title: "Claude usage", detail: "5-hour figure on top, 7-day below. \u{25B2} means you are using it faster than the clock.", isOn: toggle(.usage))
                DescribedToggle(title: "Codex usage", detail: "Only on a Mac where Codex reports a quota.", isOn: toggle(.codex))
                DescribedToggle(title: "Antigravity usage", detail: "AG: Antigravity's most-used Gemini limit, from the Antigravity app while it runs, otherwise from the agy CLI.", isOn: toggle(.gemini))
                DescribedToggle(title: "Session counts", detail: "\u{25CB} waiting on you, \u{25CF} working.", isOn: toggle(.sessions))
                DescribedToggle(title: "Needs-input count", detail: "\u{25A0} and how many sessions are waiting for your answer.", isOn: toggle(.asking))
            }

            Section {
                DescribedToggle(title: "Hide usage and session counts while a display is connected",
                                detail: "The display already shows them. The needs-input count stays.", isOn: toggle(.onlyOffline))
                    .disabled(!mirrorsOn)
                DescribedToggle(title: "Colourful icon", detail: "Off follows the menu bar's own colour, light or dark.",
                                isOn: Binding(get: { m.colourful }, set: { m.app?.setColourfulIcon($0) }))
            }
        }
        .formStyle(.grouped)
    }
}

struct DevicesPane: View {
    @ObservedObject var m: SettingsModel
    @FocusState private var nameFocused: Bool

    var nameLocked: Bool { m.s.macTagSource == "env" }

    var body: some View {
        Form {
            Section {
                if m.s.devices.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("No displays yet")
                        Text("Connect a Deckhand over USB and it pairs by itself. To add one over Bluetooth only, use Pair New Device.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
                ForEach(m.s.devices, id: \.self) { name in
                    let link = m.linkText(name)
                    HStack(spacing: 10) {
                        Image(systemName: link != nil ? "rectangle.portrait.fill" : "rectangle.portrait")
                            .foregroundStyle(link != nil ? Color.accentColor : Color.secondary)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(name)
                            Text([link.map { "Connected over \($0)" } ?? "Not connected", m.batteryText(name)]
                                    .compactMap { $0 }.joined(separator: "  \u{00B7}  "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Forget\u{2026}") { m.app?.forgetDevice(name) }
                            .disabled(!m.s.running)
                    }
                }
            } header: {
                Text("Paired displays")
            } footer: {
                HStack {
                    Spacer()
                    Button("Pair New Device\u{2026}") { m.app?.openPairWindow() }
                }
            }

            if m.s.devices.count > 1 {
                Section {
                    Picker("Bluetooth connects to", selection: Binding(get: { m.s.selected ?? "" }, set: { m.app?.selectDevice($0) })) {
                        Text("Any paired display").tag("")
                        Divider()
                        ForEach(m.s.devices, id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(!m.s.running)
                } footer: {
                    Text("USB always connects whichever display is plugged in.").font(.caption).foregroundStyle(.secondary)
                }
            }

            Section {
                LabeledContent("Name") {
                    HStack {
                        TextField("", text: $m.nameDraft, prompt: Text(m.s.macTagAuto.isEmpty ? "automatic" : m.s.macTagAuto))
                            .frame(width: 110)
                            .multilineTextAlignment(.trailing)
                            .focused($nameFocused)
                            .onSubmit { m.app?.setMacName(m.nameDraft); nameFocused = false }
                        Button("Save") { m.app?.setMacName(m.nameDraft); nameFocused = false }
                            .disabled(m.nameDraft == (m.s.macTagSource == "name" ? m.s.macTag : ""))
                    }
                }
                .disabled(nameLocked || !m.s.running)
                .onChange(of: nameFocused) { _, f in m.nameEditing = f }

                LabeledContent("Icon") {
                    let current = m.app?.currentIcon(m.s) ?? ""
                    LazyVGrid(columns: Array(repeating: GridItem(.fixed(30), spacing: 4), count: 8), spacing: 4) {
                        ForEach(MAC_ICON_NAMES, id: \.self) { name in
                            Button { m.app?.setIcon(name) } label: {
                                Text(MAC_ICON_GLYPHS[name] ?? "?").font(.system(size: 17))
                                    .frame(width: 30, height: 28)
                                    .background(RoundedRectangle(cornerRadius: 6)
                                        .fill(name == current ? Color.accentColor.opacity(0.25) : Color.clear))
                                    .overlay(RoundedRectangle(cornerRadius: 6)
                                        .stroke(name == current ? Color.accentColor : Color.clear, lineWidth: 1.5))
                            }
                            .buttonStyle(.plain)
                            .help(name)
                        }
                    }
                }
                .disabled(m.s.iconFromEnv)
            } header: {
                Text("This Mac on the display")
            } footer: {
                Text(nameLocked || m.s.iconFromEnv
                     ? "Set by DECKHAND_MAC_TAG / DECKHAND_MAC_EMOJI in the host's environment, so it cannot be changed here."
                     : "Shown beside this Mac's sessions when more than one Mac uses the same display. Up to 6 letters or digits; leave it empty for the automatic name.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct ClaudePane: View {
    @ObservedObject var m: SettingsModel

    var state: (symbol: String, color: Color, title: String, detail: String) {
        switch m.hooks {
        case .installed:
            return ("checkmark.circle.fill", .green, "Installed",
                    isBundled ? "Claude Code reports every session to Deckhand, running on Deckhand's own Node."
                              : "Claude Code reports every session to Deckhand, through the released app's Node.")
        case .notInstalled:
            return ("exclamationmark.circle.fill", .orange, "Not installed",
                    "Sessions will not appear on the display or in the menu until the hooks are installed.")
        case .fromSource:
            return ("info.circle.fill", .blue, "Installed by install.sh",
                    isBundled ? "They run on the node on your PATH. Switching moves them to Deckhand's own Node, which keeps working through Homebrew upgrades."
                              : "They run on the node on your PATH, as install.sh set them up.")
        case .needsRepair:
            return ("exclamationmark.triangle.fill", .orange, "Need repair",
                    "The scripts in ~/.claude or the link to Deckhand's Node do not match this copy of Deckhand.")
        }
    }
    var installTitle: String {
        switch m.hooks {
        case .installed: return "Reinstall"
        case .notInstalled: return "Install\u{2026}"
        case .fromSource: return "Switch to Deckhand's Node\u{2026}"
        case .needsRepair: return "Repair"
        }
    }

    var body: some View {
        Form {
            Section {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: state.symbol).foregroundStyle(state.color).font(.title2)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(state.title).font(.headline)
                        Text(state.detail).font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                }
                .padding(.vertical, 2)
                if isBundled {
                    HStack {
                        if m.busy { ProgressView().controlSize(.small) }
                        Spacer()
                        Button("Remove\u{2026}") { m.app?.removeHooks() }
                            .disabled(m.busy || m.hooks == .notInstalled)
                        Button(installTitle) { m.app?.installHooks() }
                            .disabled(m.busy)
                    }
                }
                if isBundled && Hooks.codexPresent && m.hooks != .notInstalled {
                    DescribedToggle(
                        title: "Codex hooks",
                        detail: "Shows when a Codex session is waiting for your approval, and lets the display answer it. Without them Codex sessions still appear, as working or waiting.",
                        isOn: Binding(get: { m.codexHooks }, set: { m.app?.setCodexHooks($0) }))
                        .disabled(m.busy)
                } else {
                    LabeledContent("Codex", value: m.codexHooks ? "Hooks installed" : (Hooks.codexPresent ? "No hooks" : "Not on this Mac"))
                }
                if isBundled && Hooks.antigravityPresent && m.hooks != .notInstalled {
                    DescribedToggle(
                        title: "Antigravity hook",
                        detail: "Adds the model and the latest prompt to Antigravity sessions. It never answers or holds up a tool call: Antigravity has no hook while its approval prompt is up, so those prompts are answered in Antigravity. Without it, sessions still appear, as working or waiting.",
                        isOn: Binding(get: { m.agHooks }, set: { m.app?.setAntigravityHooks($0) }))
                        .disabled(m.busy)
                } else {
                    LabeledContent("Antigravity", value: m.agHooks ? "Hook installed" : (Hooks.antigravityPresent ? "No hook" : "Not on this Mac"))
                }
            } header: {
                Text("Hooks")
            } footer: {
                Text(isBundled
                     ? "Deckhand learns what each session is doing (working, waiting, asking for permission) from hooks in ~/.claude/settings.json. Your own hooks and status line are never changed, and a backup goes to ~/Deckhand-backups before every change."
                     : "This build drives the host in your checkout, where install.sh manages the hooks.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct AboutPane: View {
    @ObservedObject var m: SettingsModel
    var version: String {
        let i = Bundle.main.infoDictionary ?? [:]
        let v = (i["CFBundleShortVersionString"] as? String) ?? "?"
        let b = (i["CFBundleVersion"] as? String) ?? "?"
        let c = (i["DeckhandCommit"] as? String).map { ", \($0)" } ?? ""
        // A pre-release says so beside its version (build-release.sh --channel).
        let ch = (i["DeckhandChannel"] as? String).flatMap { $0.isEmpty ? nil : " \($0)" } ?? ""
        return "Version \(v)\(ch) (\(b)\(c))"
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Deckhand").font(.title2.weight(.semibold))
                        Text(version).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Spacer()
                }
                .padding(.vertical, 4)
            }

            if let app = m.app, app.updatesAvailable {
                Section("Updates") {
                    Toggle("Check for updates automatically", isOn: Binding(
                        get: { app.autoCheckUpdates }, set: { app.autoCheckUpdates = $0; m.objectWillChange.send() }))
                    Toggle("Download and install updates automatically", isOn: Binding(
                        get: { app.autoInstallUpdates }, set: { app.autoInstallUpdates = $0; m.objectWillChange.send() }))
                        .disabled(!app.autoCheckUpdates)
                    HStack {
                        Spacer()
                        Button("Check Now") { app.checkForUpdates() }
                    }
                }
            }

            Section("Troubleshooting") {
                LabeledContent("Host log") { Button("Open") { m.app?.openLog() } }
                if isBundled {
                    LabeledContent("First-run setup") { Button("Run Again\u{2026}") { m.app?.openSetup() } }
                    LabeledContent("Remove Deckhand from this Mac") {
                        Button("Uninstall\u{2026}", role: .destructive) { m.app?.uninstallDeckhand() }
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

/// Clears the first responder on every tab switch. SwiftUI otherwise hands the
/// keyboard to the first text field it finds, so opening Devices put a blinking
/// cursor in the Mac-name field - and a field holding focus is one the 3s refresh
/// stops updating (SettingsModel.nameEditing).
final class SettingsTabs: NSTabViewController {
    override func tabView(_ tabView: NSTabView, didSelect item: NSTabViewItem?) {
        super.tabView(tabView, didSelect: item)
        DispatchQueue.main.async { [weak self] in self?.view.window?.makeFirstResponder(nil) }
    }
}

final class SettingsWindowController: NSObject, NSWindowDelegate {
    let model = SettingsModel()
    let window: NSWindow
    let tabs = SettingsTabs()

    init(app: AppDelegate) {
        model.app = app
        tabs.tabStyle = .toolbar
        for pane in SettingsPane.allCases {
            let root: AnyView
            switch pane {
            case .general: root = AnyView(GeneralPane(m: model))
            case .menuBar: root = AnyView(MenuBarPane(m: model))
            case .devices: root = AnyView(DevicesPane(m: model))
            case .claude: root = AnyView(ClaudePane(m: model))
            case .about: root = AnyView(AboutPane(m: model))
            }
            // ONE size for every pane, so switching tabs does not make the window
            // jump; a pane taller than this scrolls inside its Form.
            let host = NSHostingController(rootView: root.frame(width: SETTINGS_W, height: SETTINGS_H))
            host.title = pane.title
            let item = NSTabViewItem(viewController: host)
            item.label = pane.title
            item.image = NSImage(systemSymbolName: pane.symbol, accessibilityDescription: pane.title)
            tabs.addTabViewItem(item)
        }
        window = NSWindow(contentViewController: tabs)
        window.styleMask = [.titled, .closable]
        window.toolbarStyle = .preference
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: SETTINGS_W, height: SETTINGS_H))
        super.init()
        window.delegate = self
        model.pullServices()
    }

    /// When the window last stopped being the key window - so opening the status
    /// menu (which takes focus away first) can tell "Settings was in front a moment
    /// ago" from "Settings is open somewhere behind the app you are using".
    var resignedKeyAt = Date.distantPast
    func windowDidResignKey(_ n: Notification) { resignedKeyAt = Date() }

    /// WHILE THE WINDOW IS OPEN, DECKHAND IS A REGULAR APP: a Dock icon, a place in
    /// Cmd-Tab, and its window ordered like any other app's. As an .accessory app the
    /// window was filed BEHIND every other app's the moment it lost focus - which
    /// opening the status menu does - and an accessory app has no Dock icon or
    /// Cmd-Tab entry to get it back by. (User report, 2026-11-08.) Closing the window
    /// returns the app to the menu bar only.
    func windowWillClose(_ n: Notification) {
        DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
    }

    func show(pane: SettingsPane?) {
        if let p = pane { tabs.selectedTabViewItemIndex = p.rawValue }
        if !window.isVisible { window.center() }
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        // An .accessory app is never frontmost on its own; without this the window
        // opens behind whatever the person was reading.
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { [weak self] in self?.window.makeFirstResponder(nil) }
    }
}

let SETTINGS_W: CGFloat = 540
let SETTINGS_H: CGFloat = 560

extension AppDelegate {
    /// Restart in place. Supervised, through launchd (`kickstart -k`), so there is
    /// still exactly one supervisor; unsupervised, the old force-clear-and-open.
    func restartHost() {
        wantRunning = true
        lastRestart = Date()
        downSince = nil
        if isSupervised() {
            let label = isBundled ? agentLabel : "com.deckhand.host"
            DispatchQueue.global(qos: .userInitiated).async {
                _ = runCapture("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(label)"])
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.refresh() }
            }
        } else {
            startHost()
        }
    }

    /// Sparkle's own two switches, exposed rather than mirrored, so the window and
    /// Sparkle's second-launch question can never disagree.
    var updatesAvailable: Bool {
        #if SPARKLE
        return updater != nil
        #else
        return false
        #endif
    }
    var autoCheckUpdates: Bool {
        get {
            #if SPARKLE
            return updater?.updater.automaticallyChecksForUpdates ?? false
            #else
            return false
            #endif
        }
        set {
            #if SPARKLE
            updater?.updater.automaticallyChecksForUpdates = newValue
            #endif
        }
    }
    var autoInstallUpdates: Bool {
        get {
            #if SPARKLE
            return updater?.updater.automaticallyDownloadsUpdates ?? false
            #else
            return false
            #endif
        }
        set {
            #if SPARKLE
            updater?.updater.automaticallyDownloadsUpdates = newValue
            #endif
        }
    }
}

/// `--settings-show <pane>`: open the REAL Settings window on that pane against the
/// live host and stay up, so a capture (or a person) can look at it. Read-only in
/// the sense every diagnostic here is: dryRun keeps refresh from starting,
/// stopping or sounding anything. Panes: general menubar devices claude about.
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

/// `--dmg-background <out-prefix> <label>`: the release DMG's window background, drawn
/// by the app itself so its menu-bar picture is the REAL boat and the REAL two-row bar
/// (barImage), not a drawing of them. Writes <out-prefix>.png (660x420) and
/// <out-prefix>@2x.png; build-release.sh joins them into one Retina TIFF. `label` is
/// the version line in the corner ("0.1.0 alpha"). The layout is bound to the DMG
/// step's icon positions: app at (170,150), Applications at (490,150), icon size 112.
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

/// `--bar-preview <out.png>`: every SIZE of the menu-bar item for one busy example
/// (both services, both windows, sessions waiting and working, two asking), drawn by
/// the real renderer on a light bar and a dark bar at 2x, with each width printed. The
/// bar can only be judged by looking at it, and the real one shows one size at a time.
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

/// `--host stop|start|status`: the released app's background host, from a script.
/// flash.sh needs the USB port free for the upload, and the host is a launchd agent
/// with KeepAlive - a pkill is undone within seconds - so this goes through the same
/// SMAppService unregister/register the menu's Stop and Start use, the supported way
/// to stop and start it. Exits non-zero when the agent did not end up as asked.
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

/// `--setup-do <conflict|hooks|skip-hooks|start|done>`: run ONE setup step's action,
/// the very function its button calls, from a terminal. A running Deckhand's setup
/// window shares these UserDefaults and re-derives its step every second, so it
/// follows along - which is how a first run is tested end to end on a Mac where
/// nothing may click the window. Prints what the step left behind and exits non-zero
/// on failure. Released app only: in a dev build there is no bundled host to set up.
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

/// `--setup-preview <dir>`: the released app's setup window, EVERY state, as PNGs.
/// The states are reached by clicking through a first run that registers a launch
/// agent and writes ~/.claude, so they cannot be looked at any other way without
/// doing exactly that. Renders the real SetupWindow from the real model(); only the
/// step and phase are forced. Starts, stops and writes nothing but the PNGs.
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

if CommandLine.arguments.contains("--legibility-check") {
    let d = AppDelegate()
    d.dryRun = true
    _ = d.buildMenu()
    d.refresh()
    var failed = 0
    // The third element is "is this row REACHABLE", and it is not padding.
    // MEASURED: NSMenuItem.isEnabled's GETTER reflects the parent chain - every
    // item inside a submenu whose parent item is disabled reports false, whatever
    // was set on it. The pairing status row used to live inside `Pair new device…`,
    // which dimmed with the host, so with the host down this check FAILED for a
    // row that could not be opened at all. An instrument that fails for the wrong
    // reason is worse than none, and this file has earned that sentence twice
    // already. That row is gone - the pairing reading is now the window's, and is
    // checked below where AppKit's ~31% does not apply to it.
    for (name, it, reachable) in [("5h", d.q5, { true }), ("7d", d.q7, { true }),
                                  ("Codex", d.cxLine, { true }), ("Codex 2nd window", d.cx2Line, { true }),
                                  ("connection detail", d.deviceLine, { true })]
                                 as [(String, NSMenuItem, () -> Bool)] {
        guard !it.isHidden, reachable() else { continue }
        if it.isEnabled { print("  \(name): full strength"); continue }
        print("FAIL \(name) is DISABLED, so AppKit draws its reading at ~31% - grey, unreadable")
        failed += 1
    }
    // THE PAIRING CAUSE MOVED OFF THE MENU, so the ~31% rule no longer reaches it -
    // but the reason that rule exists does: "Failed: bluetooth is poweredOff" in
    // grey is a cause nobody reads. In the window it is an NSTextField, whose ink
    // is whatever colour it was given, so the assertion is on the colour: the
    // reading must be drawn in one of the two FULL-strength semantic colours and
    // never in tertiary or disabled ink.
    let cause = "bluetooth is poweredOff"
    var fh = HostStatus()
    fh.running = true
    fh.pairing = PairInfo(supported: true, state: "failed", name: "Deckhand-C114", error: cause)
    let pw = PairWindow(target: nil)
    pw.render(pairWindowModel(fh, PairLocal()))
    for (name, field, want) in [("pairing headline", pw.titleField, [NSColor.labelColor]),
                                ("pairing cause", pw.detailField,
                                 [NSColor.labelColor, NSColor.secondaryLabelColor])] {
        if field.isHidden {
            print("FAIL \(name) is HIDDEN, so the reading is not on screen at all")
            failed += 1
        } else if !want.contains(where: { $0 == field.textColor }) {
            print("FAIL \(name) is drawn in \(field.textColor?.description ?? "no colour") - "
                  + "a reading must be full-strength ink, not tertiary or disabled")
            failed += 1
        } else {
            print("  \(name): full strength")
        }
    }
    if !pw.detailField.stringValue.contains(cause) {
        print("FAIL the pairing window does not carry the host's cause at all")
        failed += 1
    }
    print(failed == 0 ? "legibility: every reading renders at full strength"
                      : "legibility: \(failed) row(s) FAILED")
    exit(failed == 0 ? 0 : 1)
}

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

if CommandLine.arguments.contains("--sound-check") {
    let play = CommandLine.arguments.contains("play")
    print("sound: chosen=\(askSoundName.isEmpty ? "Off" : askSoundName)")
    for n in ASK_SOUNDS {
        let snd = NSSound(named: n)
        print("  \(n.padding(toLength: 10, withPad: " ", startingAt: 0)) \(snd == nil ? "MISSING" : "ok")")
        if play, let snd { snd.play(); usleep(1_200_000) }
    }
    var w = AskWatcher()
    let script: [(String, Set<String>)] = [
        ("launch, 'a' already asking", ["a"]), ("'a' still asking", ["a"]),
        ("'b' also asks", ["a", "b"]), ("both answered", []),
        ("'a' asks again", ["a"]), ("'c' and 'd' together", ["c", "d"]),
    ]
    for (what, ids) in script {
        print(String(format: "  %-28s -> %d sound(s)", (what as NSString).utf8String!, w.step(ids)))
    }
    exit(0)
}

/// `--pace-check`: the pace arithmetic, without a host, a device or a render.
///
/// It exists because two of the three defects in this feature were in ARITHMETIC
/// that looked right - a tick written over the only filled cell of a 1% bar, and
/// a boundary that would have indexed off the end of the array at 96% - and both
/// were caught by looking at real output rather than by reading the code. A
/// glance is not repeatable; this is.
///
/// The regression cases are named, not just covered, so a later edit that
/// reintroduces one fails with the reason attached rather than with a number.
if CommandLine.arguments.contains("--pace-check") {
    var failed = 0
    // COUNTED AND PRINTED, because CLAUDE.md used to hand-transcribe the total and
    // a transcribed number drifts the moment anyone adds a case - the same reason
    // the geometry checkers parse the constants they certify instead of copying
    // them. Two of these loops sweep, so the figure is not countable by eye.
    var ran = 0
    func eq<T: Equatable>(_ got: T, _ want: T, _ what: String) {
        ran += 1
        if got == want { return }
        print("FAIL \(what): got \(got) want \(want)")
        failed += 1
    }

    // Where the clock is. Missing inputs must yield nil - NOT 0, which would draw
    // a tick at the start of the window and claim it had just begun.
    eq(pacePct(resetInMin: nil, windowMin: WINDOW_5H_MIN), nil, "no reset means no pace")
    eq(pacePct(resetInMin: 30, windowMin: nil), nil, "no window means no pace")
    eq(pacePct(resetInMin: 30, windowMin: 0), nil, "a zero window cannot be divided by")
    eq(pacePct(resetInMin: 0, windowMin: WINDOW_5H_MIN), 100, "a window with 0m left is fully elapsed")
    eq(pacePct(resetInMin: WINDOW_5H_MIN, windowMin: WINDOW_5H_MIN), 0, "a full window has not started")
    // 42, not 41: the division truncates (17600/300 = 58 remaining), which is the
    // device's own integer arithmetic and therefore the number to match. Written
    // as 41 first time round and this check is what said so.
    eq(pacePct(resetInMin: 176, windowMin: WINDOW_5H_MIN), 42, "176m of 300 left is 42% elapsed")
    eq(pacePct(resetInMin: 5040, windowMin: WINDOW_7D_MIN), 50, "half the 7d window")
    // A reset LONGER than its window is nonsense the host could still print; it
    // must clamp rather than produce a negative position.
    eq(pacePct(resetInMin: 99999, windowMin: WINDOW_5H_MIN), 0, "an over-long reset clamps to 0")

    // The verdict, and the deadband's two edges - which are where a flapping
    // glyph would come from.
    eq(paceGlyph(pct: 50, pace: nil), "", "no pace draws NOTHING, never a verdict")
    eq(paceGlyph(pct: 50, pace: 50), "\u{2248}", "equal is level")
    eq(paceGlyph(pct: 55, pace: 50), "\u{2248}", "exactly at the deadband is still level")
    eq(paceGlyph(pct: 45, pace: 50), "\u{2248}", "and on the other side too")
    eq(paceGlyph(pct: 56, pace: 50), "\u{25B2}", "one past the deadband is ahead")
    eq(paceGlyph(pct: 44, pace: 50), "\u{25BC}", "one under is behind")

    // The bar. These read the RUNS now rather than a (pre, tick, post) triple, so
    // each one says which side of the tick it means via these three helpers -
    // every claim the triple made is still made, and the fill/track colouring the
    // triple could not express is now assertable too.
    func width(_ runs: [(text: String, role: BarRole)]) -> Int {
        runs.reduce(0) { $0 + $1.text.count }
    }
    func before(_ runs: [(text: String, role: BarRole)]) -> String {
        runs.prefix(while: { $0.role != .tick }).map(\.text).joined()
    }
    func after(_ runs: [(text: String, role: BarRole)]) -> String {
        runs.drop(while: { $0.role != .tick }).dropFirst().map(\.text).joined()
    }

    // Cell COUNT first: a tick is inserted, so it costs a character and never a
    // cell of fill.
    let plain = quotaBarRuns(44)
    eq(width(plain), BAR_CELLS, "no pace, ten cells")
    eq(plain.contains { $0.role == .tick }, false, "no pace, no tick")
    let ticked = quotaBarRuns(44, pace: 41)
    eq(width(ticked), BAR_CELLS + 1, "a tick adds a cell, never replaces one")
    // THE REGRESSION, by name: the tick used to overwrite the cell it landed on,
    // so a 1%-used bar whose clock had barely started lost its only ink and read
    // as nothing used - the exact claim the filled-at-least-one rule exists to
    // stop. Assert the INK, not the arithmetic that produced it.
    let barely = quotaBarRuns(1, pace: 4)
    eq(barely.filter { $0.role == .fill }.map(\.text).joined().isEmpty, false,
       "1% used keeps its fill ink even with the tick on top of it")
    // THE OVERSTATEMENT, by name: whole cells rounded 1% up to a full cell, so 1%
    // and 4% drew exactly what 10% draws. The fill is in eighths now - assert the
    // GLYPH each one gets, which is what a person actually sees.
    func fillInk(_ p: Int) -> String {
        quotaBarRuns(p).filter { $0.role == .fill }.map(\.text).joined()
    }
    eq(fillInk(1), "\u{258F}", "1% is a one-eighth hairline, not a whole cell")
    eq(fillInk(4), "\u{258D}", "4% is three eighths of a cell")
    eq(fillInk(5), "\u{258C}", "5% is half a cell")
    eq(fillInk(10), "\u{2588}", "10% is exactly one whole cell")
    eq(fillInk(0), "", "0% draws no fill at all")
    eq(fillInk(1) != fillInk(10), true, "1% and 10% no longer draw the same bar")
    eq(width(quotaBarRuns(37)), BAR_CELLS, "a partial cell is still one cell wide")
    // And the other one: a boundary at 100% is BAR_CELLS, one past the last
    // index, which an array write would have trapped on.
    let full = quotaBarRuns(100, pace: 100)
    eq(after(full), "", "a fully elapsed window puts the tick after the last cell")
    eq(before(full).count, BAR_CELLS, "and leaves all ten cells before it")
    let fresh = quotaBarRuns(0, pace: 0)
    eq(before(fresh), "", "an unstarted window puts the tick before the first cell")
    eq(before(quotaBarRuns(96, pace: 90)).count, 9, "90% of ten cells is the ninth boundary")
    // Every run is one kind of ink, at every fill/pace combination there is - the
    // property `quotaTitle`'s colouring rests on. Checked exhaustively rather than
    // at a few points, because the fill boundary and the tick move independently
    // and it is their ORDER that decides how many runs there are.
    // ONE assertion for the whole sweep, not one per pair: 10,201 passing `eq`
    // calls would drown the count this check now prints, and the CLAIM really is
    // singular - every run is one kind of ink, everywhere. The first offending
    // pair is named, because "somewhere in 10,201" is not a bug report.
    var mixedAt = ""
    for pct in 0...100 {
        for pace in 0...100 {
            for r in quotaBarRuns(pct, pace: pace) where r.role != .tick {
                // A fill run is full blocks, optionally ENDED by one eighth-block:
                // the partial cell is fill ink, but only ever at the fill's edge.
                var body = Array(r.text).map(String.init)
                if r.role == .fill, let l = body.last, BAR_EIGHTHS.dropFirst().contains(l) {
                    body.removeLast()
                }
                let want = r.role == .fill ? "\u{2588}" : "\u{2591}"
                if body.contains(where: { $0 != want }), mixedAt.isEmpty {
                    mixedAt = "pct \(pct) pace \(pace) run \"\(r.text)\" as \(r.role)"
                }
            }
        }
    }
    eq(mixedAt, "", "every run is one kind of ink, over all 101x101 (pct, pace) pairs")

    // THE ORDER AND THE WEIGHT, which the colour assertions above do not touch -
    // proven by reverting each and watching all 49 still pass. Both are the actual
    // point of the row's layout, so both get a named claim: the figure the row
    // exists to report comes BEFORE the texture that gives it context, and it is
    // the heaviest thing on the line so the eye lands on it rather than on the
    // label naming it or the bar beside it.
    let row = quotaRow(WINDOW_5H_MIN, 44, 30, stale: false).0
    let rowStr = row.string as NSString
    let pctAt = rowStr.range(of: "44%").location
    let barAt = rowStr.range(of: "\u{2588}").location
    eq(pctAt != NSNotFound && barAt != NSNotFound, true, "the row has both a percentage and a bar")
    eq(pctAt < barAt, true, "the percentage comes BEFORE the bar, not downstream of it")
    var pctFont: NSFont? = nil
    row.enumerateAttribute(.font, in: NSRange(location: pctAt, length: 3)) { f, _, _ in
        pctFont = f as? NSFont
    }
    eq(pctFont?.fontName, F_MONO_BOLD.fontName, "the percentage is drawn in the bold face")
    eq(pctFont?.fontDescriptor.symbolicTraits.contains(.bold), true,
       "and that face is actually bold, not merely a different name for the regular one")

    // NOT about this code: SF Mono is claimed to hold one advance across weights,
    // which is what lets the bold percentage sit in a column padded by `%3d`
    // without shifting the bar beside it. A font that stopped doing so would
    // misalign every quota row, so it is measured here rather than assumed.
    eq(F_MONO_BOLD.pointSize, F_MONO.pointSize, "the bold figure is the same size as the row around it")
    eq(("0123456789% used" as NSString).size(withAttributes: [.font: F_MONO_BOLD]).width.rounded(),
       ("0123456789% used" as NSString).size(withAttributes: [.font: F_MONO]).width.rounded(),
       "bold and regular mono advance identically, or the columns break")

    // THE SMEAR, by name. Fill and track differ only in INK, not in shape, so
    // they are legible against each other only if they are drawn in different
    // COLOURS - and the version that shipped split at the pace tick, which is not the
    // fill boundary, so a single run could carry both. It did: `quotaTitle` drew
    // every cell in the usage colour, making the empty track that colour at 25%
    // coverage immediately beside the fill at 100%, and the bar read as one grey
    // smear with no readable end. Assert the ATTRIBUTED OUTPUT rather than the
    // strings, because the defect was never in the arithmetic - the cells were
    // always right and only their colouring was wrong, which is exactly the shape
    // of bug that survives a reading of the code.
    //
    // Asserted TWICE, because "can be coloured apart" and "is coloured apart" are
    // different claims and only the second one is what you see: first that no run
    // carries both inks (the structural half - a run is one colour by definition,
    // so a mixed run makes the rest impossible), then that the two inks actually
    // came out different colours (the visual half).
    //
    // The STALE case is in this list on purpose. It is the one that nearly
    // shipped: staleness dims the fill to tertiary, and a track fixed at tertiary
    // would have matched it exactly - the same smear, reappearing on exactly the
    // rows whose numbers we already cannot vouch for.
    for (name, pct, age) in [("mid", 44, 1), ("barely", 1, 1), ("nearly", 96, 1),
                             ("high", 85, 1), ("critical", 97, 1),
                             ("stale", 44, QUOTA_STALE_SEC + 1)] {
        let t = quotaRow(WINDOW_5H_MIN, pct, 30, stale: age > QUOTA_STALE_SEC).0
        let str = t.string as NSString
        var inkColour: [String: Set<String>] = ["\u{2588}": [], "\u{2591}": []]
        t.enumerateAttributes(in: NSRange(location: 0, length: t.length)) { attrs, r, _ in
            let run = str.substring(with: r)
            let c = (attrs[.foregroundColor] as? NSColor).map { "\($0)" } ?? "none"
            for ink in ["\u{2588}", "\u{2591}"] where run.contains(ink) {
                inkColour[ink]?.insert(c)
                eq(run.contains(ink == "\u{2588}" ? "\u{2591}" : "\u{2588}"), false,
                   "\(name): no run carries both fill and track ink, or they cannot be coloured apart")
            }
        }
        // Only meaningful where the bar actually has both - a 100% bar has no
        // track and a 0% one no fill, and asserting over an empty set would pass
        // for the wrong reason.
        if let f = inkColour["\u{2588}"], let k = inkColour["\u{2591}"], !f.isEmpty, !k.isEmpty {
            eq(f.isDisjoint(with: k), true,
               "\(name): the track is drawn in a DIFFERENT colour from the fill, or the bar is one smear")
        }
    }

    // Codex's window, off the host's own tick line. A missing one must be nil, so
    // the row draws no tick rather than assuming seven days.
    let withWin: Substring = "5h=1% (resets 1m) codex=44%/7d (resets 8021m) via=usb"
    let noWin: Substring = "5h=1% (resets 1m) codex=44% (resets 8021m) via=usb"
    let unknown: Substring = "5h=1% (resets 1m) codex=?% via=usb"
    eq(codexWindowMin(withWin), 10080, "codex=44%/7d is seven days of minutes")
    eq(codexWindowMin(noWin), nil, "no /Nd means no window")
    eq(codexWindowMin(unknown), nil, "an unmeasured codex has no window")
    // The live defect: a 300-minute window printed as `/0d` and read as absent.
    eq(codexWindowMin("codex=17%/5h (resets 273m) via=none"), 300, "codex=17%/5h is five hours of minutes")
    eq(codexWindowMin("codex=17%/0d (resets 273m) via=none"), nil, "an old host's /0d is still no window, not zero")
    eq(codexWindowMin("codex=17%/5x (resets 273m)"), nil, "an unknown unit is no window")
    eq(pctReset("codex=17%/5h (resets 273m)", "codex=")?.1, 273, "an hours window keeps its reset")

    // A float percentage must still parse - it once blanked the 5h figure.
    let floaty: Substring = "5h=28.000000000000004% (resets 0m) 7d=3% (resets 5174m) via=ble"
    eq(pctReset(floaty, "5h=")?.0, 28, "5h=28.000000000000004% reads as 28")
    eq(pctReset(floaty, "5h=")?.1, 0, "and keeps its reset")
    eq(pctReset(unknown, "5h=")?.0, 1, "a whole percent still reads")
    eq(pctReset("5h=?% (resets ?m)", "5h=")?.0, nil, "an unknown 5h is nil, not zero")

    // Staleness suppresses the pace on BOTH surfaces, because the percentage has
    // stopped moving while the clock has not.
    // THE BAR (barModel / barText, which the image and --menu-dump both read). These
    // read the real Menu Bar switches, so they run only with the usage switches on.
    // (The offline-only switch cannot bite: a fresh HostStatus has no device.)
    let barFull = { (s: HostStatus) in barText(barModel(s, tier: .full)) }
    var st = HostStatus()
    st.running = true; st.pct5h = 96; st.reset5h = 30; st.quotaAgeSec = 1
    if BarPref.usage.on {
        eq(barFull(st).contains("5h 96%\u{25B2}"), true, "a fresh reading ahead of the clock gets its \u{25B2}")
        st.quotaAgeSec = QUOTA_STALE_SEC + 1
        eq(barFull(st).contains("\u{25B2}"), false, "a stale reading loses it")
        eq(barFull(st).contains("96%"), true, "but keeps its digits")
        st.pct5h = 10; st.quotaAgeSec = 1
        eq(barFull(st).contains("\u{25BC}") || barFull(st).contains("\u{2248}"), false, "only the warning is drawn: no \u{25BC} or \u{2248} in the bar")
        st.pct5h = 96
    }
    eq(quotaBarRuns(96, pace: pacePct(resetInMin: 30, windowMin: WINDOW_5H_MIN))
        .contains { $0.role == .tick }, true,
       "and the tick is what the row loses with it")

    if BarPref.usage.on && BarPref.codex.on {
        var cx = HostStatus()
        cx.running = true; cx.pct5h = 13; cx.reset5h = 200; cx.quotaAgeSec = 1
        cx.cxPct = 96; cx.cxReset = 30; cx.cxWinMin = 300; cx.cxAgeSec = 1
        let fresh = barFull(cx)
        eq(fresh.contains("[CX 96%\u{25B2}"), true, "Codex is its own column, tagged CX, with its own pace")
        eq(fresh.hasPrefix("[5h 13%"), true, "Claude's column comes first")
        cx.quotaAgeSec = QUOTA_STALE_SEC + 1
        eq(barFull(cx).contains("CX 96%\u{25B2}"), true, "a stale CLAUDE reading does not take Codex's pace with it")
        cx.quotaAgeSec = 1; cx.cxAgeSec = QUOTA_STALE_SEC + 1
        eq(barFull(cx).contains("CX 96%") && !barFull(cx).contains("CX 96%\u{25B2}"), true, "a stale Codex reading keeps digits, loses pace")
        cx.cxAgeSec = 1; cx.cxWinMin = nil
        eq(barFull(cx).contains("96%\u{25B2}"), false, "no window, no pace mark - never an assumed one")
        eq(barTooltip(cx).contains("Codex published no window length"), true, "and the tooltip names that cause")
        cx.pct5h = nil
        eq(barFull(cx).hasPrefix("[CX "), true, "Codex alone is the first column")
        cx.cxPct = nil; cx.pct5h = 13
        eq(barFull(cx).contains("CX"), false, "no Codex reading, no CX column")

        // Codex's SECOND window (codex2=). Parsed off the real tick-line shape the
        // host prints, and stacked under the first the way Claude's 7d sits under 5h.
        let tick: Substring = "5h=15% (resets 57m) 7d=41% (resets 2916m) qage=3 cxage=9 codex=100%/5h (resets 15m) codex2=62%/7d (resets 8000m) sessions(0)=[]"
        eq(pctReset(tick, "codex=")?.0, 100, "codex= still parses with codex2= beside it")
        eq(pctReset(tick, "codex2=")?.0, 62, "codex2= parses")
        eq(codexWindowMin(tick), 300, "the first window is 5h")
        eq(codexWindowMin(tick, key: "codex2="), 10080, "the second is 7d, read off its own key")
        // The live misread: after the 5h reset the host prints `codex=?`, and the
        // window search ran on into codex2's "62%/7d".
        let reset: Substring = "qage=3 cxage=9 codex=? codex2=62%/7d (resets 8399m) sessions(0)=[]"
        eq(codexWindowMin(reset), nil, "an expired codex= has no window - it must not borrow codex2's 7d")
        eq(pctReset(reset, "codex=")?.0, nil, "and no percentage")
        eq(pctReset(reset, "codex2=")?.0, 62, "while codex2= still reads")
        // A session TITLE that looks like a field must not be read as one.
        let titled: Substring = #"5h=10% (resets 30m) codex=40%/5h (resets 60m) sessions(1)=[{"id":"a","name":"x","status":"working","title":"codex2=62%/7d via=usb"}] via=ble"#
        eq(pctReset(tickFields(titled), "codex2=")?.0, nil, "codex2= inside a session title is not a Codex figure")
        eq(field(tickFields(titled), "via="), "ble", "and via= is the real one, not the title's")
        eq(extractSessions(titled).first?.title, "codex2=62%/7d via=usb", "while the session still has its title")
        cx.pct7d = 41; cx.reset7d = 2916
        cx.cxPct = 100; cx.cxReset = 15; cx.cxWinMin = 300
        cx.cx2Pct = 62; cx.cx2Reset = 8000; cx.cx2WinMin = 10080
        eq(barFull(cx).contains("[CX 100%"), true, "both Codex windows show")
        eq(barFull(cx).contains("/ 62%"), true, "the 7d under the 5h, sharing Claude's row labels")
        // A plan whose FIRST window is 7d must not sit in the row Claude calls 5h.
        cx.cxWinMin = 10080; cx.cx2Pct = nil; cx.cx2WinMin = nil
        eq(barFull(cx).contains("[CX 7d 100%"), true, "Codex windows that differ from Claude's carry their own labels")
        cx.cxWinMin = 300; cx.cx2Pct = 62; cx.cx2WinMin = 10080
        // THE DISAPPEARANCE: the 5h window resets, the host drops its percentage
        // (windowExpired), and Codex used to vanish with a valid 7d reading in hand.
        cx.cxPct = nil
        eq(barFull(cx).contains("[CX \u{2013} / 62%"), true, "an expired 5h window holds its row with a dash; Codex stays")
        eq(barTooltip(cx).contains("no current reading"), true, "and the tooltip says why there is a dash")
        cx.cx2Pct = nil
        eq(barFull(cx).contains("CX"), false, "with neither window, no CX column at all")

        // THE SIZES. Each keeps less, in the order the BarTier comment gives, and
        // each is no wider than the one above it - measured off the real renderer.
        var busy = cx
        busy.cxPct = 100; busy.cx2Pct = 62; busy.pct5h = 13; busy.pct7d = 41
        busy.sessions = [SessionRow(id: "a", name: "a", status: "waiting"), SessionRow(id: "b", name: "b", status: "working"),
                         SessionRow(id: "c", name: "c", status: "asking"), SessionRow(id: "d", name: "d", status: "asking")]
        if BarPref.sessions.on && BarPref.asking.on {
            eq(barText(barModel(busy, tier: .full)).contains("[\u{25CB}1 / \u{25CF}1]"), true, "Full has the session counts")
            eq(barText(barModel(busy, tier: .compact)).contains("\u{25CB}"), false, "Compact drops them")
            eq(barText(barModel(busy, tier: .compact)).hasSuffix("(2)"), true, "Compact keeps the needs-input badge")
            let mini = barText(barModel(busy, tier: .minimal))
            eq(mini.hasPrefix("[CX ") && mini.contains("100%") && !mini.contains("13%"), true, "Minimal keeps only the column that needs attention")
            eq(barModel(busy, tier: .icon), BarModel(dot: true), "Icon only is the boat, with a dot for the waiting answer")
            let w = barWidths(busy, height: 22)
            eq(w[.full]! > w[.compact]! && w[.compact]! > w[.minimal]! && w[.minimal]! > w[.icon]!, true,
               "each size is narrower than the one above it (\(BarTier.allCases.reversed().map { Int(w[$0]!) }))")
            // 275pt is the OLD one-line text bar for this same content, measured with
            // its own font before it was removed. Full must stay well under it.
            eq(w[.full]! < 165, true, "Full fits in 165pt with every column present (\(Int(w[.full]!))pt; the text bar measured 275)")
            eq(barText(barModel(busy, tier: .minimal)).contains("[CX 5h 100%"), true, "Minimal's lone Codex column labels its own rows")
        } else {
            print("note: size checks skipped - Session counts or Needs-input count is switched off")
        }
    } else {
        print("note: Codex bar checks skipped - Claude usage or Codex usage is switched off")
    }

    // GEMINI (gmq=): quota GROUPS off the tick line; the bar's GM column is the general
    // "Gemini Models" group, 5h over weekly with a real pace, like Claude and Codex.
    let gmLine: Substring = "5h=10% (resets 30m) qage=1 cxage=1 gmq=Gemini_Models|5h:85:120|weekly:9:9000;Claude_and_GPT_models|5h:0:120|weekly:0:9000;Gemini_4_Argon|weekly:3:9956 gmage=20 sessions(0)=[]"
    let gq = parseGeminiQuota(field(tickFields(gmLine), "gmq=") ?? "")
    eq(gq.map(\.name), ["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"], "gmq= parses every group, underscores back to spaces")
    eq(gq[0].buckets.map(\.window), ["5h", "weekly"], "with its windows")
    eq(gq[2].buckets.map(\.pct), [3], "Argon has its weekly one only")
    eq(parseGeminiQuota("Bad|5h:x:1;Ok|5h:3:4").map(\.name), ["Ok"], "a malformed bucket is skipped (and its empty group), never read as 0%")
    eq(GeminiGroup.primary(gq)?.name, "Gemini Models", "the bar's group is the most-used Antigravity group (85% here)")
    eq(GeminiGroup.primary(parseGeminiQuota("Gemini_Models|5h:0:300|weekly:0:5287;Claude_and_GPT_models|5h:0:300|weekly:0:10080;Gemini_4_Argon|weekly:35:4381"))?.name,
       "Gemini 4 Argon", "MEASURED 2026-11-11: Gemini Models at 0%, Argon 35% through its week - the bar shows Argon")
    eq(GeminiGroup.primary(parseGeminiQuota("Gemini_Models|5h:0:1;Gemini_4_Argon|weekly:0:1"))?.name, "Gemini Models",
       "a tie keeps the app's own order, general group first")
    eq(GeminiGroup.primary(parseGeminiQuota("Claude_and_GPT_models|5h:99:1;Gemini_Renamed|5h:1:1"))?.name, "Gemini Renamed",
       "never the Claude/GPT group, however used it is")
    eq(GeminiGroup.primary(parseGeminiQuota("Claude_and_GPT_models|5h:9:1")) == nil, true, "and with no Gemini group, nothing")
    eq(geminiWindowMinutes("3d"), 4320, "an unforeseen 3d window reads the way the host reads it")
    if BarPref.gemini.on {
        var g = HostStatus()
        g.running = true; g.gemini = gq; g.gmAgeSec = 20
        let txt = barText(barModel(g, tier: .full))
        eq(txt.contains("[AG 5h 85%"), true, "AG is 5h over weekly, labelled when no Claude column is beside it (\(txt))")
        eq(txt.contains("/ 7d 9%"), true, "with the weekly figure below")
        g.pct5h = 10; g.pct7d = 20; g.quotaAgeSec = 1
        eq(barText(barModel(g, tier: .full)).contains("[AG 85%"), true, "and borrows Claude's 5h/7d labels when it is there")
        eq(barText(barModel(g, tier: .full)).contains("[AG 85%\u{25B2}"), true, "85% with 60% of 5h gone is ahead of the clock: a real pace")
        eq(barText(barModel(g, tier: .minimal)).contains("[AG 5h 85%"), true, "85% needs attention, so Minimal keeps it - with its own labels")
        g.gemini = parseGeminiQuota("Gemini_Models|5h:2:120|weekly:9:9000")
        eq(barText(barModel(g, tier: .minimal)).contains("AG"), false, "2% does not, so Minimal drops it")
        eq(barTooltip(g).contains("AG (Antigravity) 5h:"), true, "the tooltip names the window")
        g.gemini = parseGeminiQuota("Gemini_Models|weekly:7:9000")
        eq(barModel(g, tier: .full).quotas.first { $0.tag == "AG" }?.bottom == nil, true,
           "a group with only a weekly window is ONE row, not a dash in a 5h row it does not have")
        g.gemini = []
        eq(barText(barModel(g, tier: .full)).contains("AG"), false, "no reading (the app is closed), no AG column")
    } else {
        print("note: Antigravity bar checks skipped - Antigravity usage is switched off")
    }

    print(failed == 0 ? "pace: all \(ran) checks passed" : "pace: \(failed) of \(ran) FAILED")
    exit(failed == 0 ? 0 : 1)
}

/// `--pair-check`: the whole wireless-pairing surface, without a host, a device,
/// a radio or a click.
///
/// It exists for the reason `--pace-check` and `--sound-check` do: A MENU CANNOT
/// BE CLICKED FROM A SCRIPT, and an NSAlert even less so, so every claim about
/// this surface is otherwise unverifiable except by standing in front of it. The
/// state machine (`pairNext`), the parse (`pairInfoFrom`, the real
/// JSONSerialization path the heartbeat takes) and the dialog ITSELF (built by the
/// same factory the click uses, then inspected) are all driven here.
///
/// It prints WHAT THE MENU WOULD SHOW at each step as well as asserting, because
/// the assertions cannot see wording and a person reading the transcript can.
if CommandLine.arguments.contains("--pair-check") {
    var failed = 0
    // COUNTED AND PRINTED, never transcribed into CLAUDE.md - the same rule the
    // geometry checkers follow for the constants they certify.
    var ran = 0
    func eq<T: Equatable>(_ got: T, _ want: T, _ what: String) {
        ran += 1
        if got == want { return }
        print("FAIL \(what): got \(got) want \(want)")
        failed += 1
    }
    func ok(_ cond: Bool, _ what: String) { eq(cond, true, what) }

    // ---- the parse, through the real JSON path the heartbeat takes ----------
    func parse(_ json: String) -> PairInfo {
        let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        return pairInfoFrom((obj ?? [:])?["pairing"] as? [String: Any])
    }
    eq(parse("{}"), PairInfo(), "a heartbeat with no pairing block reads as idle, not as a crash")
    ok(!parse("{}").supported, "and as a host that cannot pair at all - the block is how it says it can")
    ok(parse("{\"pairing\":{\"state\":\"idle\"}}").supported, "an empty-but-present block IS support")
    eq(parse("{\"pairing\":{\"state\":\"scanning\",\"devices\":[{\"name\":\"Deckhand-C114\",\"rssi\":-52},{\"name\":\"Deckhand-0528\",\"rssi\":-77}],\"name\":\"\",\"label\":\"\",\"code\":\"\",\"error\":\"\",\"sec\":0}}").devices,
       [PairDevice(name: "Deckhand-C114", rssi: -52), PairDevice(name: "Deckhand-0528", rssi: -77)],
       "the scan list survives the parse in the host's own order")
    eq(parse("{\"pairing\":{\"state\":\"awaiting-code\",\"devices\":[],\"name\":\"Deckhand-C114\",\"label\":\"studio\",\"code\":\"001472\",\"error\":\"\",\"sec\":97}}").code,
       "001472", "a leading-zero code survives as a STRING - 1472 is not the same six digits")

    // ---- what counts as a code ---------------------------------------------
    // The trap this exists for: pairStart() sets `awaiting-code` the moment it
    // starts connecting, so the STATE arrives before the digits do.
    var p = PairInfo(state: "awaiting-code", name: "Deckhand-C114", code: "")
    ok(!pairCodeReady(p), "awaiting-code with no digits yet is NOT a code to show")
    p.code = "0014"
    ok(!pairCodeReady(p), "four digits is not six")
    p.code = "00147a"
    ok(!pairCodeReady(p), "six characters is not six DIGITS")
    p.code = "001472"
    ok(pairCodeReady(p), "six digits, and only then")
    eq(PAIR_CODE_DIGITS, 6, "six is what pairing.ino derives and what the panel draws")

    // ---- the state machine, driven end to end ------------------------------
    // idle -> scanning -> awaiting-code (no digits) -> awaiting-code (digits)
    //      -> verifying -> done, and each failure.
    var seen = PairSeen()
    func step(_ p: PairInfo, _ what: String) -> PairAction {
        let (a, s) = pairNext(p, seen)
        seen = s
        var st = HostStatus(); st.running = true; st.pairing = p; st.pairing.supported = true
        print(String(format: "  %-34s %-12s %@", (what as NSString).utf8String!,
                     (p.state as NSString).utf8String!, pairStatusText(st)))
        if case .none = a {} else { print("        -> dialog: \(a)") }
        return a
    }
    eq(step(PairInfo(), "nothing happening"), .none, "idle raises nothing")
    eq(step(PairInfo(state: "scanning"), "PAIRSCAN"), .none, "a scan raises nothing")
    eq(step(PairInfo(state: "scanning", devices: [PairDevice(name: "Deckhand-C114", rssi: -52)]),
            "a device answers the scan"), .none, "a sighting raises nothing")
    eq(step(PairInfo(state: "awaiting-code", name: "Deckhand-C114", label: "studio", sec: 119),
            "PAIRSTART, connecting"), .none,
       "the state alone must NOT raise the dialog - the digits are not in yet")
    let arrived = PairInfo(state: "awaiting-code", name: "Deckhand-C114", label: "studio",
                           code: "482913", sec: 97)
    eq(step(arrived, "PAIRPUB - the code arrives"),
       .compare(code: "482913", device: "Deckhand-C114", label: "studio"),
       "the digits are what raises the comparison")
    eq(step(arrived, "the same tick again"), .none,
       "and it is raised ONCE - a modal re-opening every 3s is unusable")
    eq(step(PairInfo(state: "verifying", name: "Deckhand-C114", code: "482913", sec: 90),
            "Match clicked, proof sent"), .none,
       "verifying re-asks nothing: the question has been answered and the device now owes a tap")
    eq(step(PairInfo(state: "done", name: "Deckhand-C114"), "CONFIRM tapped on the glass"),
       .done(device: "Deckhand-C114"), "done is reported")
    eq(step(PairInfo(state: "done", name: "Deckhand-C114"), "still done next tick"), .none,
       "and reported once")

    // Every failure the host can publish, each naming its own cause. These strings
    // are the host's (pairEnd/pairStart set pairError); the menu never invents one.
    for reason in ["bluetooth is poweredOff",
                   "the device never answered with its public key (is its pairing window open?)",
                   "the device's public key was rejected",
                   "nobody said whether the codes matched",
                   "the device never confirmed - its CONFIRM button has to be tapped inside the 120s window",
                   "refused: full",
                   "refused: badproof",
                   "Deckhand-C114 was last seen too long ago"] {
        seen = PairSeen()
        let a = step(PairInfo(state: "failed", name: "Deckhand-C114", error: reason), "failed")
        eq(a, .failed(device: "Deckhand-C114", reason: reason), "the failure names its cause")
        var st = HostStatus(); st.running = true
        st.pairing = PairInfo(supported: true, state: "failed", error: reason)
        ok(pairStatusText(st).contains(reason), "and the menu row carries it too, not just the dialog")
    }
    // A failure with no reason must still SAY something - the host logs one in
    // every path, but an empty string here would render "Failed: " and read as a
    // truncated message rather than as a missing one.
    var noReason = HostStatus(); noReason.running = true
    noReason.pairing = PairInfo(supported: true, state: "failed", name: "Deckhand-C114")
    ok(pairStatusText(noReason).contains(PAIR_NO_REASON), "an empty error still says so")

    // THE REPEAT CASE, which is why the outcome token is cleared on the way past
    // idle/scanning/awaiting-code: two identical failures in a row must both be
    // reported, or the second is indistinguishable from a pairing that is merely
    // slow.
    seen = PairSeen()
    let sameFail = PairInfo(state: "failed", name: "Deckhand-C114", error: "bluetooth is poweredOff")
    _ = pairNext(sameFail, seen).action
    seen = pairNext(sameFail, seen).seen
    eq(pairNext(sameFail, seen).action, .none, "an unchanged failure is not re-reported on the next tick")
    seen = pairNext(PairInfo(state: "scanning"), seen).seen
    eq(pairNext(sameFail, seen).action, .failed(device: "Deckhand-C114", reason: "bluetooth is poweredOff"),
       "but the SAME failure after another attempt is reported again")
    // AND ON THE PATH THAT SKIPS THE SCAN, which is the reachable one: PAIRSTART
    // is accepted straight out of `failed`, so retrying a device whose window is
    // shut fails twice with a byte-identical cause. The second report is the one
    // that would go missing, and a second attempt that says nothing at all is
    // exactly the "silence and impossibility look identical" failure every refusal
    // in this feature is worded to avoid.
    seen = PairSeen()
    seen = pairNext(sameFail, seen).seen
    seen = pairNext(PairInfo(state: "awaiting-code", name: "Deckhand-C114", sec: 119), seen).seen
    eq(pairNext(sameFail, seen).action, .failed(device: "Deckhand-C114", reason: "bluetooth is poweredOff"),
       "a retry straight out of failed re-reports an identical failure")
    // The same rule for a code, on the path that does NOT pass through idle:
    // PAIRSTART is accepted straight out of `done`, so a second pairing whose six
    // digits happen to equal the last one's (one chance in a million) must still
    // raise its dialog rather than be swallowed by the dedupe.
    seen = PairSeen()
    seen = pairNext(arrived, seen).seen
    seen = pairNext(PairInfo(state: "done", name: "Deckhand-C114"), seen).seen
    eq(pairNext(arrived, seen).action, .compare(code: "482913", device: "Deckhand-C114", label: "studio"),
       "a fresh exchange re-raises the comparison even if the digits repeat")
    // AND THE STATE ALONE STILL RAISES NOTHING WITH A PRIOR CODE IN HAND. The
    // sequence assertion above cannot see this on its own: it starts from an empty
    // `seen`, where a missing pairCodeReady() is masked by the code simply
    // equalling the empty token it is compared against. Seeded, the guard is the
    // only thing left standing between a second PAIRSTART and a dialog showing no
    // digits at all.
    eq(pairNext(PairInfo(state: "awaiting-code", name: "Deckhand-0528"), PairSeen(code: "482913")).action,
       .none, "a new exchange that has not answered yet raises nothing - never an EMPTY dialog")

    // ---- what the rows offer -----------------------------------------------
    var st = HostStatus()
    st.pairing = PairInfo(supported: true, state: "idle",
                          devices: [PairDevice(name: "Deckhand-C114", rssi: -52)])
    ok(!pairCanStart(st), "with the host down, nothing is pickable")
    ok(pairStatusText(st).contains("host is not running"), "and the row says why")
    st.running = true
    st.pairing.supported = false
    ok(!pairCanStart(st), "against a host that predates the feature, nothing is pickable either")
    ok(!pairInFlight(st), "and nothing is in flight there, whatever a stale state field says")
    ok(pairStatusText(st).contains("too old"), "and the row says THAT, rather than offering a scan")
    st.pairing.supported = true
    ok(pairCanStart(st), "idle with a sighting is pickable")
    for s in ["scanning", "awaiting-code", "verifying"] {
        st.pairing.state = s
        ok(!pairCanStart(st), "\(s): a second exchange the host would refuse is not offered")
    }
    st.pairing.state = "verifying"
    ok(pairInFlight(st), "verifying: Cancel is live")
    st.pairing.state = "awaiting-code"
    ok(pairInFlight(st), "awaiting-code: Cancel is live")
    st.pairing.state = "idle"
    ok(!pairInFlight(st), "idle: Cancel is not")
    for s in ["done", "failed"] {
        st.pairing.state = s
        ok(pairCanStart(st), "\(s): a finished exchange lets the next one start without a restart")
    }
    eq(pairDeviceRowTitle(PairDevice(name: "Deckhand-C114", rssi: -52)), "Deckhand-C114  ·  -52 dBm",
       "a row names the device and how strong it is")

    // ---- THE WINDOW'S MODEL: what a person would see, in every state --------
    // The window replaced three stacked NSAlerts and a submenu, so everything the
    // alerts used to be asserted on is asserted here - and then AGAIN through the
    // real controls below, because a model that agrees with itself binds nothing.
    func model(_ state: String, code: String = "", name: String = "Deckhand-C114",
               label: String = "", error: String = "", sec: Int = 0, devices: [PairDevice] = [],
               running: Bool = true, supported: Bool = true,
               local: PairLocal = PairLocal()) -> PairWindowModel {
        var h = HostStatus()
        h.running = running
        h.pairing = PairInfo(supported: supported, state: state, devices: devices,
                             name: name, label: label, code: code, error: error, sec: sec)
        return pairWindowModel(h, local)
    }

    // The two states the old submenu could only DIM. A grey row states nothing,
    // and from the Mac "it did not work" and "it is not possible here" look the
    // same - so the window opens in both and names the cause.
    let noHost = model("idle", running: false)
    eq(noHost.phase, .unavailable, "with the host down the window still opens, and says so")
    ok(noHost.title.contains("not running"), "and names that as the cause")
    ok(noHost.detail.contains("Start Deckhand"), "and says what to do about it")
    ok(!noHost.rowsEnabled && !noHost.scanEnabled, "with nothing to send a command to, nothing is live")
    let oldHost = model("idle", supported: false)
    eq(oldHost.phase, .unavailable, "against a host predating the feature, likewise")
    ok(oldHost.title.contains("too old"), "and THAT is the cause it names, not a failed scan")

    eq(model("scanning").phase, .browse, "a scan is the browse screen")
    ok(model("scanning").busy, "with the spinner running, since a scan has no other sign of life")
    ok(!model("scanning").rowsEnabled,
       "and no row is live: the host refuses PAIRSTART while its own radio is scanning")
    ok(!model("scanning").scanEnabled, "nor a second scan")
    let found = model("idle", devices: [PairDevice(name: "Deckhand-C114", rssi: -52),
                                        PairDevice(name: "Deckhand-0528", rssi: -77)])
    eq(found.phase, .browse, "idle with sightings is the browse screen")
    ok(found.rowsEnabled && found.scanEnabled, "and both the rows and Scan are live")
    ok(found.title.contains("2 devices"), "the headline counts them")
    ok(found.detail.contains("PAIR NEW MAC"),
       "and says what has to be open at the OTHER end before a row will work")
    ok(model("idle").title.contains("No devices found"), "an empty list says so rather than sitting blank")
    ok(model("idle").detail.contains("Scan again"), "and points at the control that fixes it")

    // THE TRAP THE OLD DIALOG PAID FOR: pairStart() sets `awaiting-code` the
    // moment it starts connecting, so the STATE arrives before the digits.
    let connecting = model("awaiting-code", sec: 119)
    eq(connecting.phase, .connecting, "awaiting-code with no digits is NOT the comparison")
    eq(connecting.code, "", "and shows no code at all - never an EMPTY comparison")
    ok(connecting.secondary?.role == .cancel, "it offers Cancel, which is the only useful act there")
    ok(connecting.footer.contains("119s"), "and the deadline, which the menu could only show on hover")

    let compare = model("awaiting-code", code: "001472", label: "studio", sec: 97)
    eq(compare.phase, .compare, "six digits are what raises the comparison")
    eq(compare.code, "001472", "shown verbatim - a leading zero is part of the number")
    ok(compare.title.contains("Deckhand-C114"), "it names the device it is asking about")
    ok(compare.detail.contains("studio"), "and the label that device shows beside its own code")
    ok(compare.detail.contains("CONFIRM"),
       "and says the device's own tap stores the key - this window commits nothing")
    ok(!compare.showsList, "the list is gone: there is one question on screen and it is this one")
    ok(compare.footer.contains("97s"), "the 120s deadline is ON the screen making the decision")
    eq(compare.primary?.title, "They match", "the answer is a word, not OK")
    eq(compare.secondary?.title, "They don\u{2019}t match", "and so is the denial, not Cancel")
    // NEITHER ANSWER IS THE RETURN KEY'S - the single input this design rests on.
    eq(compare.primary?.key, "", "Return does not answer for the user")
    eq(compare.secondary?.key, "\u{1b}", "Escape declines, so refusing stays the cheap option")
    ok(compare.floats, "and it floats, because the comparison is made by looking AWAY from the Mac")
    ok(!model("idle").floats, "a window at rest does not sit above everything")
    ok(pairWindowModel(HostStatus(), PairLocal()).floats == false,
       "nor does one with no host behind it")

    // The ~1s between clicking They match and the host republishing `verifying`.
    let answered = model("awaiting-code", code: "001472", sec: 96, local: PairLocal(answered: "001472"))
    eq(answered.phase, .confirming,
       "an answered comparison is NOT re-offered while the host catches up")
    ok(answered.primary == nil,
       "so there is no second chance to answer a question already answered")
    eq(answered.secondary?.role, .cancel, "only Cancel remains live there")
    eq(model("verifying", sec: 90).phase, .confirming, "and the host's own verifying is the same screen")
    ok(model("verifying").detail.contains("NOTHING IS STORED"),
       "which says what is still outstanding: a finger on the device's glass")

    let cancelling = model("verifying", sec: 88, local: PairLocal(cancelling: true))
    eq(cancelling.phase, .cancelling, "Cancel takes effect on screen before the host confirms it")
    ok(cancelling.primary == nil && cancelling.secondary == nil,
       "with nothing left to click - a second PAIRCANCEL is a command the host would refuse")
    eq(model("idle", local: PairLocal(cancelling: true)).phase, .browse,
       "and the flag means nothing once the exchange is actually over")

    let done = model("done")
    eq(done.phase, .done, "done is its own screen, not a modal over the last one")
    ok(done.title.contains("Paired with Deckhand-C114"), "naming what it paired with")
    ok(done.showsList && done.scanEnabled, "and the next pairing costs no reopening")
    eq(done.scanTitle, "Pair another device", "which is what the button then says")

    for reason in ["bluetooth is poweredOff", "refused: full", "refused: badproof"] {
        let f = model("failed", error: reason)
        eq(f.phase, .failed, "a failure is a screen too")
        ok(f.detail.contains(reason), "carrying the host's OWN cause, never an invented one")
        ok(f.rowsEnabled, "with the sightings still live, so a retry is one click")
    }
    ok(model("failed", error: "").detail.contains(PAIR_NO_REASON),
       "an empty error still says something rather than rendering a truncated sentence")
    ok(pairStatusText(noReason).contains(PAIR_NO_REASON),
       "in the SAME words the menu's tooltip uses - one phrase, two surfaces, no drift")

    // An unnamed device must not leave punctuation with nothing in it.
    let anon = model("awaiting-code", code: "482913", name: "")
    ok(!anon.title.contains("()") && !anon.title.contains("  "),
       "an unnamed device does not leave empty brackets or a double space on screen")
    ok(anon.title.contains("the device"), "it says \u{201C}the device\u{201D} instead")
    ok(!model("awaiting-code", code: "001472", label: "").detail.contains("()"),
       "and an unlabelled one leaves none either")

    // The cap the menu could only hit in silence.
    let many = model("idle", devices: (0..<(MAX_PAIR_ROWS + 3)).map {
        PairDevice(name: "Deckhand-\($0)", rssi: -40 - $0)
    })
    eq(many.devices.count, MAX_PAIR_ROWS, "the list is capped")
    ok(many.footer.contains("3 further devices"), "and SAYS what it is not showing")

    // ---- what is worth opening a window over -------------------------------
    // The login item makes "the app starts while the heartbeat still says done"
    // the COMMON case, so this is not a corner.
    ok(!pairWorthRaising(.done(device: "Deckhand-C114"), firstTick: true),
       "a `done` left over from before launch does not open a window over someone's work")
    ok(!pairWorthRaising(.failed(device: "Deckhand-C114", reason: "refused: full"), firstTick: true),
       "nor does a stale failure")
    ok(pairWorthRaising(.done(device: "Deckhand-C114"), firstTick: false),
       "but a `done` that HAPPENS while the app is up is reported")
    ok(pairWorthRaising(.failed(device: "Deckhand-C114", reason: "refused: full"), firstTick: false),
       "and so is a failure")
    // The exception, and it is the important one: an exchange in flight at launch
    // has a running deadline and nowhere else to be shown.
    ok(pairWorthRaising(.compare(code: "482913", device: "Deckhand-C114", label: ""), firstTick: true),
       "a LIVE comparison is raised even on the first tick - its 120s window is already running")
    ok(!pairWorthRaising(.none, firstTick: false), "and a scan is never worth interrupting for")

    // ---- the local half expires on its own ---------------------------------
    eq(pairLocalNext(PairInfo(state: "idle"), PairLocal(answered: "001472", cancelling: true)),
       PairLocal(), "idle clears everything this Mac was remembering")
    for s in ["scanning", "done", "failed"] {
        eq(pairLocalNext(PairInfo(state: s), PairLocal(answered: "001472", cancelling: true)),
           PairLocal(), "\(s) clears it too - the exchange it belonged to is over")
    }
    eq(pairLocalNext(PairInfo(state: "awaiting-code", code: "001472"), PairLocal(answered: "001472")),
       PairLocal(answered: "001472"), "an answer survives while its own exchange does")
    eq(pairLocalNext(PairInfo(state: "awaiting-code", code: "482913"), PairLocal(answered: "001472")),
       PairLocal(), "but NOT into an exchange with different digits - it answered the other one")

    // ---- THE REAL WINDOW, rendered and then read back ----------------------
    // Everything above is a model, and a model is a mirror: it would keep passing
    // with render() deleted. These read the actual controls after the actual
    // render, which is the only half that binds the window to the decisions.
    let w = PairWindow(target: nil)
    w.render(compare)
    ok(!w.codeField.isHidden, "the rendered window shows the code")
    // THE USER TYPES NOTHING. An editable field here would be the broken first
    // design walking back in: the HMAC proof derives from the shared secret, so a
    // typed code proves nothing to the device.
    ok(!w.codeField.isEditable, "the code field is NOT editable - there is nothing to type here")
    eq(w.codeField.stringValue, "001472", "the six digits are drawn verbatim, ungrouped and unpadded")
    let f = w.codeField.attributedStringValue.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
    ok(f != nil, "the code has a font of its own")
    if let f {
        ok(f.pointSize >= 32,
           "the code is big enough to read across a desk (got \(f.pointSize)pt) - "
           + "a comparison nobody can make is a comparison nobody makes")
        ok(f.isFixedPitch || f.fontDescriptor.postscriptName?.contains("Mono") == true,
           "and monospaced, so digit N lines up with digit N on the device")
    }
    let kern = w.codeField.attributedStringValue.attribute(.kern, at: 0, effectiveRange: nil) as? CGFloat
    ok((kern ?? 0) > 0, "the digits are spaced apart by KERNING, which inserts no character")
    // ...and NOT on the last one, where it is a trailing advance that pads the
    // string on the right and shoves a centred line off centre. Caught on a
    // capture; asserted here so the capture is not the only thing that can.
    let tail = w.codeField.attributedStringValue.attribute(.kern, at: 5, effectiveRange: nil) as? CGFloat
    eq(tail ?? 0, 0, "the LAST digit carries no kern - it would pad the line and break the centring")
    let para = w.codeField.attributedStringValue
        .attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
    eq(para?.alignment, .center, "the digits are centred, as the device centres its own")
    eq(w.titleField.stringValue, compare.title, "the headline is the model's")
    eq(w.primaryButton.title, "They match", "and so are the two answers")
    eq(w.secondaryButton.title, "They don\u{2019}t match", "in words, not OK/Cancel")
    eq(w.primaryButton.keyEquivalent, "", "Return does not answer for the user - IN THE REAL BUTTON")
    eq(w.secondaryButton.keyEquivalent, "\u{1b}", "and Escape declines, in the real one too")
    eq(w.primaryButton.tag, PairButtonRole.match.rawValue, "the button carries its JOB as its tag")
    eq(w.secondaryButton.tag, PairButtonRole.decline.rawValue, "each of them")
    ok(w.listStack.isHidden, "and the device list is off screen while the question is up")
    eq(w.window.level, .floating, "the window floats while an exchange is live")

    // A hidden button must surrender its key equivalent, or Escape still fires an
    // invisible control - which is a control answering for someone.
    w.render(done)
    ok(w.secondaryButton.isHidden, "the done screen has no second button")
    eq(w.secondaryButton.keyEquivalent, "",
       "and the hidden one keeps NO key - Escape must not fire a control nobody can see")
    eq(w.primaryButton.tag, PairButtonRole.close.rawValue, "its one button closes")
    ok(w.codeField.isHidden, "the code is gone once there is nothing to compare")
    eq(w.window.level, .normal, "and the window stops floating over everything")

    w.render(found)
    eq(w.rows.filter { !$0.isHidden }.count, 2, "two sightings render two rows")
    eq(w.rows.count, MAX_PAIR_ROWS, "out of a FIXED pool - a list re-rendered every second under a "
       + "pointer must not add and remove rows")
    ok(w.rows[0].attributedTitle.string.contains("Deckhand-C114"), "each naming its device")
    ok(w.rows[0].attributedTitle.string.contains("-52 dBm"), "and how strong it is")
    ok(w.rows[0].isEnabled, "and live, because this is a state the host would accept")
    eq(w.rows[0].tag, 0, "a row carries its INDEX, so it starts the exchange that was clicked")
    eq(w.rows[1].tag, 1, "each of them")
    w.render(model("scanning", devices: found.devices))
    ok(!w.rows[0].isEnabled, "and dead while the host is scanning, rather than offering a refusal")

    print(failed == 0 ? "pair: all \(ran) checks passed" : "pair: \(failed) of \(ran) FAILED")
    exit(failed == 0 ? 0 : 1)
}

/// A synthetic host state for each screen the pairing window can show, so
/// `--pair-shot` can photograph one without a host, a device or a radio. Named
/// rather than hand-built at the call site: the phase names are what a person
/// types, and this is the only place they map to a heartbeat.
func pairDemoStatus(_ phase: String) -> (HostStatus, PairLocal) {
    var h = HostStatus()
    h.running = true
    var p = PairInfo(supported: true, state: "idle")
    var local = PairLocal()
    let found = [PairDevice(name: "Deckhand-C114", rssi: -52),
                 PairDevice(name: "Deckhand-0528", rssi: -77)]
    switch phase {
    case "scanning":   p.state = "scanning"; p.devices = found
    case "empty":      p.state = "idle"
    case "connecting": p.state = "awaiting-code"; p.name = "Deckhand-C114"; p.sec = 119
    case "confirming": p.state = "verifying"; p.name = "Deckhand-C114"; p.sec = 90
    case "cancelling": p.state = "verifying"; p.name = "Deckhand-C114"; p.sec = 88
                       local.cancelling = true
    case "done":       p.state = "done"; p.name = "Deckhand-C114"; p.devices = found
    case "failed":     p.state = "failed"; p.name = "Deckhand-C114"; p.devices = found
                       p.error = "the device never confirmed - its CONFIRM button has to be tapped inside the 120s window"
    case "nohost":     h.running = false
    case "browse":     p.state = "idle"; p.devices = found
    default:           // "compare", and anything unrecognised: the screen this feature exists for
        p.state = "awaiting-code"; p.name = "Deckhand-C114"; p.label = "studio"
        p.code = "001472"; p.sec = 97
    }
    h.pairing = p
    return (h, local)
}

/// `--pair-shot <out.png> [phase] [light|dark]`: THE REAL PAIRING WINDOW, off the
/// glass, captured by window id.
///
/// `--pair-check` can assert that the face is monospaced and 44pt; it cannot say
/// whether six digits at that size, in that window, beside that wording, are
/// actually easy to compare with a device across a desk - nor whether the browse
/// screen reads as a list. That judgement needs a person and therefore a picture,
/// and these screens are otherwise reachable only by running a real exchange with
/// a real device.
///
/// Phases: compare (the default), browse, empty, scanning, connecting, confirming,
/// cancelling, done, failed, nohost.
///
/// Same two orderings `--menu-shot` documents and for the same reasons: the
/// capture is dispatched AFTER the window is on screen, and it captures the window
/// this process OWNS rather than a guessed screen region - a guessed region
/// cheerfully writes a PNG of whatever was behind a window that never appeared.
if let i = CommandLine.arguments.firstIndex(of: "--pair-shot") {
    let args = CommandLine.arguments
    let path = args.count > i + 1 ? args[i + 1] : "pair-shot.png"
    let phase = args.count > i + 2 && !["light", "dark"].contains(args[i + 2]) ? args[i + 2] : "compare"
    // FORCED, because a capture can only show the appearance the Mac is set to
    // and this window has to be legible in both - the same gap --menu-preview
    // exists to close for the menu. Omitted, it follows the system.
    let forced: NSAppearance? = args.contains("light") ? NSAppearance(named: .aqua)
        : args.contains("dark") ? NSAppearance(named: .darkAqua) : nil
    final class Shot: NSObject, NSApplicationDelegate {
        let path: String, phase: String, forced: NSAppearance?
        var win: PairWindow?
        init(_ p: String, _ ph: String, _ ap: NSAppearance?) { path = p; phase = ph; forced = ap }
        func applicationDidFinishLaunching(_ n: Notification) {
            NSApp.setActivationPolicy(.accessory)
            let w = PairWindow(target: nil)
            // The capture must not be able to trigger the close path's PAIRCANCEL.
            w.onClose = nil
            win = w
            if let forced { w.window.appearance = forced }
            let (status, local) = pairDemoStatus(phase)
            w.render(pairWindowModel(status, local))
            w.show(activate: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                let mine = ProcessInfo.processInfo.processIdentifier
                let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
                            as? [[String: Any]]) ?? []
                let found = list.first { ($0[kCGWindowOwnerPID as String] as? Int32) == mine
                                         && ((($0[kCGWindowBounds as String] as? [String: Any])?["Height"]
                                              as? Double) ?? 0) > 60 }
                guard let id = found?[kCGWindowNumber as String] as? Int else {
                    print("pair-shot FAILED: this process owns no on-screen window, so the window never appeared - NOT writing \(self.path)")
                    exit(1)
                }
                let cap = Process()
                cap.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                cap.arguments = ["-x", "-o", "-l", String(id), "-t", "png", self.path]
                try? cap.run()
                cap.waitUntilExit()
                let ok = FileManager.default.fileExists(atPath: self.path)
                print(ok ? "wrote \(self.path)  (the real pairing window, \(self.phase), off the glass)"
                         : "pair-shot FAILED: screencapture wrote nothing for window \(id)")
                exit(ok ? 0 : 1)
            }
            // The backstop --menu-shot needed for the same reason: without it a
            // failure above leaves a window sitting on someone's desktop.
            Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in
                print("pair-shot FAILED: timed out with the window still up")
                exit(1)
            }
        }
    }
    let shot = Shot(path, phase, forced)
    app.delegate = shot
    app.run()
}

if let i = CommandLine.arguments.firstIndex(of: "--icon-preview") {
    writeIconPreview(to: CommandLine.arguments.count > i + 1
        ? CommandLine.arguments[i + 1] : "icon-preview.png")
    exit(0)
}

app.run()
