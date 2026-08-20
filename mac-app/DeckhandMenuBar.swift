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
func hostApp() -> String { hostDir() + "/DeckhandBLE.app" }
func hostScript() -> String { hostDir() + "/index.mjs" }
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
func isSupervised() -> Bool { FileManager.default.fileExists(atPath: launchdPlist()) }

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
    // off a rollout has neither - no hook ran to observe one.
    var app = "", appEntry = ""
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
            if let b = obj["batt"] as? [String: Any] {
                s.battPct = b["pct"] as? Int
                s.battState = b["state"] as? Int
                s.battLeftMin = b["leftMin"] as? Int
                s.battAgeSec = b["ageSec"] as? Int
            }
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
        for line in t.split(separator: "\n").reversed() where line.hasPrefix("5h=") {
            if let (pct, reset) = pctReset(line, "5h=") { s.pct5h = pct; s.reset5h = reset }
            if let (pct, reset) = pctReset(line, "7d=") { s.pct7d = pct; s.reset7d = reset }
            if let (pct, reset) = pctReset(line, "codex=") { s.cxPct = pct; s.cxReset = reset }
            s.quotaAgeSec = field(line, "qage=").flatMap { Int($0) }
            s.cxAgeSec = field(line, "cxage=").flatMap { Int($0) }
            s.via = field(line, "via=")
            s.sessions = extractSessions(line)
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
    guard let pctEnd = rest.firstIndex(of: "%"), let pct = Int(rest[..<pctEnd]) else { return nil }
    var reset: Int? = nil
    let after = rest[rest.index(after: pctEnd)...]
    if let rr = after.prefix(24).range(of: "(resets "),
       let close = after[rr.upperBound...].firstIndex(of: ")") {
        reset = Int(after[rr.upperBound..<close].dropLast())   // "176m" -> 176
    }
    return (pct, reset)
}

/// The sessions array out of `sessions(N)=[{...}]` in a tick line.
///
/// The closing bracket is found by matching depth while respecting quotes and
/// escapes, NOT by searching for the " via=" that follows it: a session's title
/// and prompt are in there verbatim, so anyone who dictates or types "via=" -
/// entirely likely in a project about two transports - would corrupt the parse.
/// Any malformed input yields an empty list; a status menu must not crash over a
/// log line.
func extractSessions(_ line: Substring) -> [SessionRow] {
    guard let key = line.range(of: "sessions("),
          let eq = line[key.upperBound...].range(of: "=[") else { return [] }
    let start = line.index(after: eq.lowerBound)          // the '['
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
func viaLabel(_ v: String) -> String {
    v.split(separator: ",").map {
        $0 == "usb" ? "USB" : ($0 == "ble" ? "Bluetooth" : String($0))
    }.joined(separator: " + ")
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
func quotaBar(_ pct: Int) -> String {
    var filled = Int((Double(pct) / 100 * Double(BAR_CELLS)).rounded())
    // Any usage at all must show a cell: 1% rounding to an empty bar would read
    // as "none used", which is a different claim than "barely any".
    if pct > 0 && filled == 0 { filled = 1 }
    filled = max(0, min(BAR_CELLS, filled))
    // FULL BLOCK against LIGHT SHADE, not ▰/▱. The geometric pair renders at 11pt
    // as a faint dashed line where filled and empty are barely distinguishable -
    // checked against a render, not assumed. These two differ in ink, not shape.
    return String(repeating: "█", count: filled) + String(repeating: "░", count: BAR_CELLS - filled)
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
    case sessions = "barShowSessions"
    case asking = "barShowAsking"
    case onlyOffline = "barOnlyWhenOffline"

    var label: String {
        switch self {
        case .usage: return "Quota usage"
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

/// What sits beside the boat in the bar: a count when something is waiting on
/// you, and NOTHING otherwise - a badge that is always there stops being a
/// signal. Shared with --menu-dump on purpose: a diagnostic that recomputes the
/// answer its own way can agree with itself while the app does something else.
///
/// The FILLED SQUARE is the same glyph an asking row carries in the menu and on
/// the device, and it is not decoration here: the bar can hold three numbers, so
/// a bare count would sit next to other bare counts with nothing but order to
/// tell them apart. Shape is what separates them, which is the rule this project
/// applies to colour everywhere else.
///
/// This is the first third of the partition `barSessionLabel` completes - ■ asks,
/// ○ waits, ● works - so it must keep counting ONLY `asking`, or a session would
/// be tallied twice.
func barCountLabel(_ s: HostStatus) -> String {
    (BarPref.asking.on && s.asking > 0) ? " \u{25A0}\(s.asking)" : ""
}

/// The live sessions BY STATUS - hollow ring waiting, dot working - and ONLY
/// while no device is connected, same reasoning as `barUsageLabel`: the device's
/// SESSIONS tab is where this is normally read, so the bar stands in for it and
/// then gets out of the way.
///
/// `●` USED TO MEAN "every live session" and now means "working" alone, because
/// adding waiting to a single total would have printed overlapping numbers - a
/// `●3` that already contains the `○1` beside it invites adding them up. The
/// three badges now PARTITION the list the way the menu's own rows do (■ asks,
/// ○ waits, ● works, one glyph per session, same three shapes in the same
/// urgency order), so `■1 ○1 ●1` is three sessions and reads as three.
///
/// Order follows the host's urgency sort - asking, waiting, working - so the
/// leftmost number is always the one most likely to need you. Waiting outranks
/// working here for the same reason it does in that sort and on the device:
/// READY means nobody is mid-turn, i.e. it is your move.
///
/// A zero is drawn as NOTHING rather than as a glyph and a 0, each badge
/// independently. A quiet Mac's resting state is an empty label, and a badge
/// present in the resting state is the thing `barCountLabel` above refuses to
/// be - which also means an absent `○` says "none waiting", not "not shown".
func barSessionLabel(_ s: HostStatus) -> String {
    guard barMirrorAllowed(.sessions, s) else { return "" }
    let waiting = s.sessions.filter { $0.status == "waiting" }.count
    let working = s.sessions.filter { $0.status == "working" }.count
    return (waiting > 0 ? " \u{25CB}\(waiting)" : "") + (working > 0 ? " \u{25CF}\(working)" : "")
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

/// Usage in the BAR, and ONLY while no device is connected. The device's USAGE
/// tab is normally where these two numbers live, so with nothing on the desk to
/// draw them the bar takes the job over rather than making you open the menu -
/// and it goes quiet again the moment a device is back, because a pair of
/// percentages that is always there is chrome, not a signal. Same reasoning as
/// `barCountLabel`, applied to the other thing the device would have shown.
///
/// 5h first, then 7d, in the order the menu and the device both list them. A
/// STALE figure cannot reach the bar: `readStatus` only reads the log while the
/// heartbeat is fresh, so a stopped host leaves both nil and this empty. They
/// come off one tick line, so in practice they are both present or both absent -
/// a lone percentage is possible only if the usage source omits a window, and it
/// is shown rather than suppressed, since one real number beats none.
func barUsageLabel(_ s: HostStatus) -> String {
    guard barMirrorAllowed(.usage, s) else { return "" }
    let parts = [s.pct5h, s.pct7d].compactMap { $0 }.map { "\($0)%" }
    return parts.isEmpty ? "" : " " + parts.joined(separator: "\u{00B7}")
}

/// Everything to the right of the boat, left to right: usage, then what needs
/// you, then what is merely live. Urgency ahead of ambience, so the number that
/// might make you get up is never the one you have to hunt for.
func barTitle(_ s: HostStatus) -> String {
    barUsageLabel(s) + barCountLabel(s) + barSessionLabel(s)
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

func quotaTitle(_ label: String, _ pct: Int, _ reset: Int?, _ ageSec: Int? = nil) -> NSAttributedString {
    // A STALE reading is dimmed and says so in WORDS, both - the device dims its
    // hero % for the same reason, and the word is what carries the meaning here
    // for anyone who cannot see the dimming. Staleness outranks the usage
    // threshold: "97% used" from an hour ago is not a crisis to colour red, it is
    // a number we cannot vouch for.
    let stale = (ageSec ?? 0) > QUOTA_STALE_SEC
    let colour: NSColor = stale ? .tertiaryLabelColor
        : (pct >= 95 ? .systemRed : (pct >= 80 ? .systemOrange : .labelColor))
    let note = stale ? "" : (pct >= 95 ? "  critical" : (pct >= 80 ? "  high" : ""))
    let staleNote = stale ? "  \u{00B7} stale \(humanMinutes((ageSec ?? 0) / 60))" : ""
    return menuTitle([
        (label.padding(toLength: 6, withPad: " ", startingAt: 0), F_MONO, .secondaryLabelColor),
        (quotaBar(pct), F_MONO, colour),
        (String(format: "  %3d%% used%@", pct, note), F_MONO, colour),
        (staleNote, F_MONO, .systemOrange),
        // Indented with monospaced spaces so it sits under the bar. Padding a
        // proportional font gave a third of the intended indent.
        (reset.map { _ in "\n      " } ?? "", F_MONO, .secondaryLabelColor),
        (reset.map { "resets in \(humanMinutes($0))" } ?? "", F_SMALL, .secondaryLabelColor),
    ])
}

/// ONE LESS than the host's own 40-character slice, and that is the whole trick.
/// A title arriving at exactly 40 is indistinguishable from one that was cut
/// there, so `clip` at 40 saw no overflow and left the hard mid-word cut on
/// screen ("...recommendations API wor"). Clipping one character shorter makes
/// every at-the-cap title go through the word-boundary path and end in an
/// ellipsis, which says "there is more" instead of looking like a typo.
let SESSION_TITLE_SHOW = 39

func sessionTitle(_ r: SessionRow) -> NSAttributedString {
    // Shape and word, never colour alone: filled square asks, hollow ring waits,
    // dot works - the same three states the device draws, in the same order of
    // urgency the host already sorted them into.
    let asking = r.status == "asking"
    let glyph = asking ? "■" : (r.status == "waiting" ? "○" : "●")
    var meta = "  ·  " + (asking ? "needs input" : r.status)
    if r.agent == "cx" { meta += "  ·  Codex" }
    return menuTitle([
        ("\(glyph)  ", F_BODY, asking ? .systemOrange : .secondaryLabelColor),
        (r.name, asking ? F_BOLD : F_BODY, .labelColor),
        (meta, F_SMALL, .secondaryLabelColor),
        (r.title.isEmpty ? "" : "\n     ", F_MONO, .secondaryLabelColor),
        (r.title.isEmpty ? "" : clip(r.title, SESSION_TITLE_SHOW), F_SMALL, .secondaryLabelColor),
    ])
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

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let deviceLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let q5 = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let q7 = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let cxLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let battLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let sessionsHeader = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    // A fixed pool that is shown or hidden, never added and removed. The menu can
    // be OPEN while the 3s refresh runs, and rebuilding items under the cursor
    // makes the list jump; hiding is what the voice rows already did.
    var sessionRows: [NSMenuItem] = []
    let voiceSep = NSMenuItem.separator()
    let startStop = NSMenuItem(title: "", action: #selector(toggleHost), keyEquivalent: "")
    let deviceItem = NSMenuItem(title: "Device", action: nil, keyEquivalent: "")
    let deviceMenu = NSMenu()
    let forgetItem = NSMenuItem(title: "Forget device (re-pair over USB)", action: #selector(forgetDevice), keyEquivalent: "")
    let remoteItem = NSMenuItem(title: "Answer prompts on device", action: #selector(toggleRemoteAnswer), keyEquivalent: "")
    let voiceHeard = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let voiceReplyItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let loginItem = NSMenuItem(title: "Launch at login", action: #selector(toggleLogin), keyEquivalent: "")
    // Built ONCE from BarPref.allCases and then only re-checked, the way every
    // other row here is - see sessionRows on why nothing is added or removed
    // while the menu may be open under the cursor.
    let barItem = NSMenuItem(title: "Menu bar shows", action: nil, keyEquivalent: "")
    let barMenu = NSMenu()
    var barPrefItems: [(BarPref, NSMenuItem)] = []
    let colourItem = NSMenuItem(title: "Colourful icon", action: #selector(toggleColourfulIcon), keyEquivalent: "")
    let settingsItem = NSMenuItem(title: "Settings", action: nil, keyEquivalent: "")
    let settingsMenu = NSMenu()
    let soundItem = NSMenuItem(title: "Needs-input sound", action: nil, keyEquivalent: "")
    let soundMenu = NSMenu()
    var soundItems: [(String, NSMenuItem)] = []
    // Diffed every refresh, so it must outlive one - a local would announce
    // every asking session on every 3s tick.
    var askWatcher = AskWatcher()

    // Watchdog state. wantRunning persists the user's intent ("syncing should
    // be on") so a deliberate Stop is respected but a frozen/crashed host is
    // auto-restarted - and it survives app relaunches (login item after a
    // reboot). downSince/lastRestart debounce the restart.
    var downSince: Date?
    var lastRestart = Date.distantPast
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

    // Built in its own method, not inline above, so --menu-dump can construct the
    // real menu without starting timers or adopting host state.
    func buildMenu() -> NSMenu {
        let menu = NSMenu()
        // EXPLICIT enablement. With autoenablesItems on (the default) AppKit
        // re-enables anything that has a target and an action, which silently
        // undid the isEnabled this code sets for Forget and the Device submenu -
        // so Forget was clickable with no device paired.
        menu.autoenablesItems = false
        deviceMenu.autoenablesItems = false
        deviceItem.submenu = deviceMenu
        barMenu.autoenablesItems = false
        barItem.submenu = barMenu
        soundMenu.autoenablesItems = false
        soundItem.submenu = soundMenu
        // PREFERENCES behind one door, so the top level is actions only. These
        // four used to sit in the top-level row and it had grown to three
        // consecutive submenus, which pushed Quit down the menu and left nothing
        // saying which items merely change a setting and which one stops the host.
        //
        // Two things this needs that the top-level loop below would otherwise
        // have done: autoenablesItems off (AppKit re-enables anything with a
        // target, which is how Forget once became clickable with no device
        // paired) and an explicit target, since that loop only walks `items`. The
        // two submenu PARENTS are enabled explicitly - the loop's "an item with
        // an action is a control" rule would read their nil action as
        // informational and dim them.
        settingsMenu.autoenablesItems = false
        settingsItem.submenu = settingsMenu
        for it in [remoteItem, colourItem, barItem, soundItem, loginItem] {
            it.target = self
            it.isEnabled = true
            settingsMenu.addItem(it)
        }
        // Off FIRST, because silencing something that is currently making a noise
        // is the reason most people open this menu, and it should not be at the
        // bottom of a list of noises. Choosing a sound PLAYS it (see
        // pickAskSound) - a name is not something you can evaluate by reading.
        for name in [""] + ASK_SOUNDS {
            let it = NSMenuItem(title: name.isEmpty ? "Off" : name,
                                action: #selector(pickAskSound(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = name
            soundMenu.addItem(it)
            soundItems.append((name, it))
            if name.isEmpty { soundMenu.addItem(.separator()) }
        }
        // The two device-mirroring badges, then the restriction that governs
        // them, then - past a separator - the one that stands on its own. The
        // grouping is what says which items "only while no device is connected"
        // applies to, so it cannot be reordered without saying it another way.
        for pref in [BarPref.usage, .sessions, .onlyOffline, .asking] {
            if pref == .asking { barMenu.addItem(.separator()) }
            let it = NSMenuItem(title: pref.label, action: #selector(toggleBarPref(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = pref.rawValue
            if pref == .sessions {
                it.toolTip = "\u{25CB} waiting on you, \u{25CF} working. Sessions needing input are counted by the row below."
            }
            if pref == .onlyOffline {
                it.toolTip = "Applies to the two above. The needs-input count is unaffected."
            }
            barMenu.addItem(it)
            barPrefItems.append((pref, it))
        }

        sessionRows = (0..<MAX_SESSION_ROWS).map { _ in
            let it = NSMenuItem(title: "", action: #selector(openSessionFolder(_:)), keyEquivalent: "")
            it.isHidden = true
            return it
        }

        // Groups, separated: where the host stands / what quota is left / who is
        // waiting on you / the last dictation / what you can do / logs and quit.
        // Six actions used to run together under a single separator.
        var items: [NSMenuItem] = [statusLine, deviceLine, battLine, .separator(), q5, q7, cxLine,
                                   .separator(), sessionsHeader]
        items += sessionRows
        items += [voiceSep, voiceHeard, voiceReplyItem,
                  .separator(), startStop, deviceItem, settingsItem,
                  .separator(),
                  NSMenuItem(title: "Open host log", action: #selector(openLog), keyEquivalent: ""),
                  NSMenuItem(title: "Quit Deckhand", action: #selector(quit), keyEquivalent: "q")]
        for it in items {
            it.target = self
            // An item with no action is information; one with an action is a
            // control. Deriving the baseline from that makes a silently dead
            // item impossible, which is what explicit enablement risks.
            it.isEnabled = it.action != nil
            menu.addItem(it)
        }
        return menu
    }

    func refresh() {
        let s = readStatus()
        if let si = statusItem, let button = si.button {
            // The bar's own thickness sets the size, so this follows a
            // 24px bar or a 22px one instead of assuming either.
            let h = max(16, min(20, button.bounds.height - 4))
            button.image = deckhandPaperBoatImage(size: h, style: barBoatStyle(s))
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
            // NOTHING otherwise, because a
            // badge that is always present stops being a signal. The number is
            // the signal, not its colour, so this is plain label colour and the
            // menu carries the thresholds.
            let label = barTitle(s)
            button.attributedTitle = NSAttributedString(
                string: label, attributes: [.font: F_BAR, .foregroundColor: NSColor.labelColor])
            button.imagePosition = label.isEmpty ? .imageOnly : .imageLeading
        }
        if !s.running {
            statusLine.attributedTitle = menuTitle([("◦  ", F_BODY, .secondaryLabelColor),
                                                    ("Stopped", F_BOLD, .labelColor)])
        } else if s.deviceConnected {
            statusLine.attributedTitle = menuTitle([
                ("●  ", F_BODY, .controlAccentColor), ("Syncing", F_BOLD, .labelColor),
                (s.via.map { "  ·  \(viaLabel($0))" } ?? "", F_SMALL, .secondaryLabelColor)])
        } else {
            statusLine.attributedTitle = menuTitle([
                ("◦  ", F_BODY, .systemOrange), ("Running", F_BOLD, .labelColor),
                ("  ·  device offline", F_SMALL, .secondaryLabelColor)])
        }
        // The paired device becomes a sub-line of the status rather than its own
        // "Paired:" row - same information, one row fewer, and it reads as
        // belonging to the connection above it.
        deviceLine.attributedTitle = menuTitle([
            ("      ", F_SMALL, .secondaryLabelColor),
            (s.device ?? s.selected ?? "No device paired", F_SMALL, .secondaryLabelColor)])

        // Battery, as a second sub-line of the device it belongs to. Hidden when
        // the reading is ABSENT OR STALE: BATT arrives once a minute, and the
        // moment the link drops the last one starts aging - showing a two-hour-old
        // level as current is the failure this whole age field exists to prevent.
        if let pct = s.battPct, (s.battAgeSec ?? 999) < 180, (s.battState ?? 0) != 0 {
            var note = ""
            switch s.battState ?? 0 {
            case 2: note = "charging"
            case 3: note = "full"
            default:
                // Absent only while the device is still measuring - see
                // battMinutesLeft() in power.ino. No placeholder, because a
                // number derived from noise would be worse than none.
                if let m = s.battLeftMin {
                    note = m < 120 ? "~\(m)m left" : "~\((m + 30) / 60)h left"
                }
            }
            battLine.attributedTitle = menuTitle([
                ("      ", F_MONO, .secondaryLabelColor),
                ("\(pct)%", F_SMALL, pct <= 10 ? .systemOrange : .secondaryLabelColor),
                (note.isEmpty ? "" : "  ·  \(note)", F_SMALL, .secondaryLabelColor),
            ])
            battLine.isHidden = false
        } else {
            battLine.isHidden = true
        }

        // Each row carries the age of ITS OWN source: Codex's reading comes from a
        // rollout file the host merely re-reads, so it goes stale independently of
        // the OAuth poller. Hanging the Codex row off quotaAgeSec was a real bug
        // on the device (see the Codex row note in CLAUDE.md) and there is no
        // reason to repeat it here.
        if let pct = s.pct5h { q5.attributedTitle = quotaTitle("5h", pct, s.reset5h, s.quotaAgeSec) }
        if let pct = s.pct7d { q7.attributedTitle = quotaTitle("7d", pct, s.reset7d, s.quotaAgeSec) }
        if let pct = s.cxPct { cxLine.attributedTitle = quotaTitle("Codex", pct, s.cxReset, s.cxAgeSec) }
        q5.isHidden = s.pct5h == nil
        q7.isHidden = s.pct7d == nil
        cxLine.isHidden = s.cxPct == nil

        // Sessions keep the ORDER THE HOST SORTED THEM INTO (asking, then waiting,
        // then working, then recency). Re-sorting here would let the menu and the
        // device disagree about which session matters most.
        sessionsHeader.attributedTitle = menuTitle([("SESSIONS", F_SMALL, .tertiaryLabelColor)])
        sessionsHeader.isHidden = s.sessions.isEmpty
        for (i, row) in sessionRows.enumerated() {
            guard i < s.sessions.count else { row.isHidden = true; continue }
            let r = s.sessions[i]
            row.attributedTitle = sessionTitle(r)
            // The whole row, not just its path: the click now needs the app and the
            // entrypoint too, and a second parallel array would be one more thing
            // to keep in step with this loop.
            row.representedObject = r
            // The tooltip already said what the row DOES. What it ADDS is the two
            // facts the row cannot fit and nothing else on this Mac shows - model
            // and git branch, the same pair the device's own detail screen pairs
            // off. Deliberately NOT the title: the host slices that to 40
            // characters before either surface sees it, so a tooltip could only
            // repeat the identical clipped string. The path stays the LIVE cwd the
            // host reports, which is what the click actually reveals - the project
            // name on the row comes from the repo ROOT instead, so the two
            // legitimately differ and naming the real target matters.
            let facts = [r.model, r.branch].filter { !$0.isEmpty }.joined(separator: "  ·  ")
            // The action line comes from the SAME resolver the click uses, so the
            // tooltip cannot promise Finder and then open an editor.
            let action = "Click to " + describeTarget(sessionTarget(r))
            let tip = [facts, action].filter { !$0.isEmpty }.joined(separator: "\n\n")
            row.toolTip = tip.isEmpty ? nil : tip
            row.isEnabled = !r.path.isEmpty
            row.isHidden = false
        }
        forgetItem.title = "Forget \(s.device ?? s.selected ?? "this device")…"
        // The last dictation, which is the ONLY Mac-side trace of one - a headless
        // `claude -p --resume` appears in no Claude Code window. The transcript is
        // verbatim quoted text, so it renders monospaced for the same reason the
        // device renders it in Cozette rather than prose.
        if let t = s.voiceText, !t.isEmpty {
            let st = s.voiceState ?? ""
            let reply = (s.voiceReply?.isEmpty == false) ? s.voiceReply!
                : (st == "sent" ? "sent to session, waiting…" : st)
            voiceHeard.attributedTitle = menuTitle([("“\(clip(t, 42))”", F_MONO, .labelColor)])
            voiceReplyItem.attributedTitle = menuTitle([
                (st == "error" ? "⚠  " : "↳  ", F_SMALL, .secondaryLabelColor),
                (clip(reply, 50), F_SMALL, st == "error" ? .systemOrange : .secondaryLabelColor)])
            voiceHeard.isHidden = false
            voiceReplyItem.isHidden = reply.isEmpty
            voiceSep.isHidden = false
        } else {
            voiceHeard.isHidden = true
            voiceReplyItem.isHidden = true
            voiceSep.isHidden = true
        }
        remoteItem.isEnabled = s.running
        remoteItem.state = s.remoteAnswer ? .on : .off
        rebuildDeviceMenu(s)
        startStop.title = s.running ? "Stop Deckhand" : "Start Deckhand"
        // Naming the supervisor matters: with launchd in charge, a stop is permanent
        // until Start, whereas unsupervised the app's own watchdog may bring it back.
        startStop.toolTip = isSupervised()
            ? "Managed by launchd (starts at login, restarts if it dies)"
            : "Not supervised - install with host/deckhand-service.sh install"
        loginItem.state = (SMAppService.mainApp.status == .enabled) ? .on : .off
        // The EDGE into asking, not the state - and stepped on every refresh even
        // when silent, so switching a sound on does not then announce a backlog
        // the watcher never saw. dryRun covers --menu-dump: a diagnostic must
        // not make a noise.
        let asking = Set(s.sessions.filter { $0.status == "asking" }.map { $0.id })
        if askWatcher.step(asking) > 0 && !dryRun { playAskSound() }

        colourItem.state = colourfulIcon ? .on : .off
        colourItem.toolTip = "Off draws it in the system's own menu-bar colour, which follows light and dark bars."
        for (name, it) in soundItems { it.state = (name == askSoundName) ? .on : .off }
        for (pref, it) in barPrefItems {
            it.state = pref.on ? .on : .off
            // The restriction is meaningless with nothing left for it to
            // restrict, and a live checkbox that changes nothing is worse than a
            // dimmed one that explains itself.
            if pref == .onlyOffline { it.isEnabled = BarPref.usage.on || BarPref.sessions.on }
        }

        // Watchdog: if syncing is meant to be on but the host has been down or
        // frozen (stale heartbeat) for a sustained window, restart it. Only
        // acts when wantRunning, so a deliberate Stop is honored. The 30s
        // cooldown avoids re-restarting while a fresh host is still connecting.
        // Skipped entirely when launchd owns the host: it restarts a dead process within
        // a second and survives reboots, which is strictly better than this loop, and
        // two supervisors racing each other is worse than either alone.
        if dryRun { return }
        if wantRunning && !s.running && !isSupervised() {
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

    // Purely a Mac-side display choice - nothing is written to the command file
    // and the host is not told, because the host does not care what its own
    // numbers are rendered as.
    @objc func toggleBarPref(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let pref = BarPref(rawValue: raw) else { return }
        pref.toggle()
        refresh()
    }

    @objc func toggleColourfulIcon() {
        UserDefaults.standard.set(!colourfulIcon, forKey: "colourfulIcon")
        refresh()
    }

    // Picking a sound PLAYS it, which is the only way to judge one, and Off is
    // silent for the same reason - a preview of silence is not a thing.
    @objc func pickAskSound(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        UserDefaults.standard.set(name, forKey: "askSound")
        playAskSound()
        refresh()
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
        // Settings stays reachable with the host DOWN: launch-at-login and the
        // bar's own contents are still meaningful choices, and a preferences door
        // that only opens while a background process is alive is its own bug.
        settingsItem.isEnabled = true
        barItem.isEnabled = true
        soundItem.isEnabled = true
        // Answering can only be toggled through the host, so it dims with it -
        // the same rule deviceItem follows.
        remoteItem.isEnabled = s.running
        if s.devices.isEmpty {
            let none = NSMenuItem(title: "No devices paired yet", action: nil, keyEquivalent: "")
            none.isEnabled = false
            deviceMenu.addItem(none)
            return
        }
        let any = NSMenuItem(title: "Any device", action: #selector(selectDevice(_:)), keyEquivalent: "")
        any.target = self
        any.isEnabled = true
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
            item.isEnabled = true
            deviceMenu.addItem(item)
        }
        // Forget lives HERE, not in the top-level menu: it is a destructive
        // per-device action and this is where the devices are. It is still named
        // explicitly, so it forgets the one shown rather than whatever is current
        // when the host reads the trigger file.
        deviceMenu.addItem(.separator())
        forgetItem.isEnabled = s.running && (s.device ?? s.selected) != nil
        deviceMenu.addItem(forgetItem)
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

    /// Jump to where the session actually LIVES, falling back to the folder. It
    /// used to always reveal in Finder, which was the only thing the menu knew how
    /// to do before the hook started stamping the owning app.
    @objc func openSessionFolder(_ item: NSMenuItem) {
        guard let r = item.representedObject as? SessionRow else { return }
        performTarget(sessionTarget(r))
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

/// `--menu-preview <out.png>`: the menu's own attributed titles drawn as they will
/// render, in BOTH appearances side by side. Every colour here is semantic
/// (labelColor, secondaryLabelColor) and resolves at draw time, so light-only
/// verification would prove nothing about the dark case.
func writeMenuPreview(to path: String, _ m: NSMenu) {
    let W: CGFloat = 330, pad: CGFloat = 14
    var rows: [(NSAttributedString?, CGFloat)] = []
    for it in m.items where !it.isHidden {
        if it.isSeparatorItem { rows.append((nil, 11)); continue }
        let a = it.attributedTitle ?? NSAttributedString(
            string: it.title, attributes: [.font: F_BODY, .foregroundColor: NSColor.labelColor])
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)

// Inspection modes. Both build the REAL menu and refresh it against the live
// host, so what they show is what the bar would show - but dryRun keeps refresh
// from touching the watchdog, because a diagnostic must never start or stop
// anything.
if CommandLine.arguments.contains("--menu-dump") || CommandLine.arguments.contains("--menu-preview") {
    let d = AppDelegate()
    d.dryRun = true
    let m = d.buildMenu()
    d.refresh()
    if CommandLine.arguments.contains("--menu-dump") {
        let st = readStatus()
        let label = barTitle(st)
        print("menu bar: boat (\(barBoatStyle(st)))"
              + (label.isEmpty ? " (no label)" : " + label\"\(label)\"") + "\n")
        print(dumpMenu(m))
    }
    if let i = CommandLine.arguments.firstIndex(of: "--menu-preview"), CommandLine.arguments.count > i + 1 {
        writeMenuPreview(to: CommandLine.arguments[i + 1], m)
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

if let i = CommandLine.arguments.firstIndex(of: "--icon-preview") {
    writeIconPreview(to: CommandLine.arguments.count > i + 1
        ? CommandLine.arguments[i + 1] : "icon-preview.png")
    exit(0)
}

app.run()
