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
    // The wireless-pairing exchange, straight out of the heartbeat. The menu is
    // the ONLY surface for it: the device's own screen shows the other code, and
    // nothing about it is written to host.log.
    var pairing = PairInfo()
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
        for line in t.split(separator: "\n").reversed() where line.hasPrefix("5h=") {
            if let (pct, reset) = pctReset(line, "5h=") { s.pct5h = pct; s.reset5h = reset }
            if let (pct, reset) = pctReset(line, "7d=") { s.pct7d = pct; s.reset7d = reset }
            if let (pct, reset) = pctReset(line, "codex=") { s.cxPct = pct; s.cxReset = reset }
            s.cxWinMin = codexWindowMin(line)
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

/// Codex's window length in MINUTES, out of the `/7d` the host appends to its
/// percentage (`codex=44%/7d (resets 8021m)`). Days, because that is the unit the
/// host rounds to on the way out (`Math.round(usage.cxWin / 1440)`), so nothing
/// finer than a day is recoverable here - which is fine for placing a tick in a
/// ten-cell bar.
///
/// Absent whenever the field is: the host omits it when Codex has published no
/// rate_limits at all, and the row must then draw its fill with NO tick rather
/// than assume seven days. Guessing the window would put a mark at a position
/// nothing measured, which is the one thing this whole feature must not do.
func codexWindowMin(_ line: Substring) -> Int? {
    guard let r = line.range(of: "codex=") else { return nil }
    let rest = line[r.upperBound...]
    guard let pctEnd = rest.firstIndex(of: "%") else { return nil }
    let after = rest[rest.index(after: pctEnd)...]
    guard after.hasPrefix("/"), let dEnd = after.firstIndex(of: "d"),
          let days = Int(after[after.index(after: after.startIndex)..<dEnd]), days > 0
    else { return nil }
    return days * 1440
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
func quotaBarRuns(_ pct: Int, pace: Int? = nil) -> [(text: String, role: BarRole)] {
    var filled = Int((Double(pct) / 100 * Double(BAR_CELLS)).rounded())
    // Any usage at all must show a cell: 1% rounding to an empty bar would read
    // as "none used", which is a different claim than "barely any".
    if pct > 0 && filled == 0 { filled = 1 }
    filled = max(0, min(BAR_CELLS, filled))

    // FULL BLOCK against LIGHT SHADE, not ▰/▱. The geometric pair renders at 11pt
    // as a faint dashed line where filled and empty are barely distinguishable -
    // checked against a render, not assumed. These two differ in ink, not shape,
    // which is why the colours above are load-bearing rather than decorative.
    func run(_ n: Int, _ role: BarRole) -> [(text: String, role: BarRole)] {
        n > 0 ? [(String(repeating: role == .fill ? "\u{2588}" : "\u{2591}", count: n), role)] : []
    }
    guard let pace else { return run(filled, .fill) + run(BAR_CELLS - filled, .track) }

    // A BOUNDARY, not a cell: 0% goes before the first and 100% after the last,
    // which is what makes the two ends of the window reachable at all.
    let at = max(0, min(BAR_CELLS, (pace * BAR_CELLS + 50) / 100))
    let tick = [(text: "\u{2502}", role: BarRole.tick)]
    // The tick can land inside the fill or inside the track, so each side is
    // emitted as up-to-two runs and the empty ones drop out. Splitting this way
    // rather than slicing a pre-joined string is what keeps a run from spanning
    // the fill boundary at all, instead of relying on nobody re-joining them.
    return run(min(at, filled), .fill) + run(max(0, at - filled), .track) + tick
         + run(max(0, filled - at), .fill) + run(BAR_CELLS - max(at, filled), .track)
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
/// 5h first, then 7d, in the order the menu and the device both list them. Each
/// figure carries its own PACE GLYPH and its own COLOUR, which is what makes this
/// the USAGE tab standing in for a missing screen rather than two bare numbers:
/// the device draws a pace bar because a percentage alone cannot say whether you
/// are burning it faster than the clock, and that is just as true here.
///
/// Both are per-FIGURE and never shared: the 5h window can be ahead of its clock
/// while the 7d window is far behind its own, which is the normal state of
/// affairs on a busy afternoon, and one glyph for the pair would have to pick a
/// side.
///
/// A stale reading keeps its DIGITS and loses its GLYPH. The digits still say the
/// last thing we know; the pace does not survive, because it is a comparison
/// against a clock that has kept running while the percentage has not - see
/// `pacePct`. The dimming says so without a word, which the bar has no room for,
/// and the menu row directly below spells out "stale 3h".
///
/// A dropped figure leaves no gap: the separator only appears between two figures
/// that both exist, since a leading or trailing "·" reads as something missing
/// rather than as something absent.
func barUsageParts(_ s: HostStatus) -> [(String, NSFont, NSColor)] {
    guard barMirrorAllowed(.usage, s) else { return [] }
    let stale = (s.quotaAgeSec ?? 0) > QUOTA_STALE_SEC
    var out: [(String, NSFont, NSColor)] = []
    for (pct, reset, win) in [(s.pct5h, s.reset5h, WINDOW_5H_MIN), (s.pct7d, s.reset7d, WINDOW_7D_MIN)] {
        guard let pct else { continue }
        let pace = stale ? nil : pacePct(resetInMin: reset, windowMin: win)
        // The separator is SPACED, and secondary rather than tertiary. Both came
        // out of looking at it: a tertiary dot was effectively gone at menu-bar
        // size, and an unspaced one sat hard against the pace glyph before it
        // ("96%▲·50%"), which reads as one number that has come apart rather than
        // as two figures. Three characters against nine is a real cost in a bar
        // shared with every other app's icons, and it buys the only thing keeping
        // two independent windows legible as two.
        out.append((out.isEmpty ? " " : "  \u{00B7}  ", F_BAR, .secondaryLabelColor))
        out.append(("\(pct)%" + paceGlyph(pct: pct, pace: pace), F_BAR, quotaColour(pct: pct, stale: stale)))
    }
    return out
}

/// What the bar's own figures MEAN, on hovering the status item - the only place
/// the arrows can be explained, since the bar has room for a glyph and not for a
/// sentence. Empty when the bar is showing no usage, so there is no tooltip
/// promising to explain something that is not on screen.
func barTooltip(_ s: HostStatus) -> String {
    guard barMirrorAllowed(.usage, s) else { return "" }
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
    if lines.isEmpty { return "" }
    if stale { lines.append("No pace: these readings are \(humanMinutes((s.quotaAgeSec ?? 0) / 60)) old, so the clock has moved and they have not.") }
    return lines.joined(separator: "\n")
}

/// Everything to the right of the boat, left to right: usage, then what needs
/// you, then what is merely live. Urgency ahead of ambience, so the number that
/// might make you get up is never the one you have to hunt for.
///
/// ATTRIBUTED, where this returned a plain String until the usage figures started
/// carrying a threshold colour. The two counts stay monochrome deliberately: ■ ○ ●
/// are already separated by SHAPE, and hue on top of that would be decoration -
/// while a percentage has no shape to spare, so colour there is the accent on a
/// figure that already states the fact in digits.
func barTitle(_ s: HostStatus) -> NSAttributedString {
    menuTitle(barUsageParts(s) + [
        (barCountLabel(s), F_BAR, .labelColor),
        (barSessionLabel(s), F_BAR, .labelColor),
    ])
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

func quotaTitle(_ label: String, _ pct: Int, _ reset: Int?, _ ageSec: Int? = nil,
                windowMin: Int? = nil) -> NSAttributedString {
    // A STALE reading is dimmed and says so in WORDS, both - the device dims its
    // hero % for the same reason, and the word is what carries the meaning here
    // for anyone who cannot see the dimming. Staleness outranks the usage
    // threshold: "97% used" from an hour ago is not a crisis to colour red, it is
    // a number we cannot vouch for. The threshold itself lives in `quotaColour`
    // now, because the bar's figures take the same one.
    let stale = (ageSec ?? 0) > QUOTA_STALE_SEC
    let colour = quotaColour(pct: pct, stale: stale)
    let note = stale ? "" : (pct >= 95 ? "  critical" : (pct >= 80 ? "  high" : ""))
    let staleNote = stale ? "  \u{00B7} stale \(humanMinutes((ageSec ?? 0) / 60))" : ""
    // The pace tick, suppressed for a stale reading exactly as the bar's arrow is
    // (see `pacePct`) - a mark showing where the clock has got to, drawn into a
    // fill that stopped being updated hours ago, invents a comparison.
    let pace = stale ? nil : pacePct(resetInMin: reset, windowMin: windowMin)
    // THE NUMBER LEADS, and the bar follows it. The row used to read label, bar,
    // number - so the one figure being reported sat downstream of eleven
    // characters of texture, and the pace glyph, which is a statement ABOUT that
    // figure, ended up detached at the right margin with the bar between them.
    // Number first puts the payload where the eye lands and puts its qualifiers
    // next to it; the bar is context and reads perfectly well as the thing after.
    var parts: [(String, NSFont, NSColor)] = [
        (label.padding(toLength: 6, withPad: " ", startingAt: 0), F_MONO, .secondaryLabelColor),
        (String(format: "%3d%% used", pct), F_MONO_BOLD, colour),
        (note, F_MONO, colour),
        // Two spaces, because "4% used▼" reads as a typo - the glyph is a
        // separate statement about a different quantity, not a suffix on this one.
        //
        // NEUTRAL, not the usage colour, for the same reason the tick is: it
        // reports a COMPARISON, not a level. In the usage colour a red ▼ sat
        // beside a red 96% and read as part of the alarm, when ▼ is the
        // reassuring half of the pair - it says the percentage is climbing slower
        // than the clock. A colour that inverts the meaning of the glyph it
        // paints is worse than no colour on it.
        (pace == nil ? "" : "  " + paceGlyph(pct: pct, pace: pace), F_MONO, .secondaryLabelColor),
        ("   ", F_MONO, .secondaryLabelColor),
    ]
    // THREE ROLES, THREE VALUES, and the ordering between them is the whole point:
    // fill at full strength, tick a step down, track a step below that. That is
    // what makes the tick OUTRANK the track it sits in - at the same value as the
    // track it goes back to being findable only as the notch its own cell makes,
    // which is the defect the tick's own split was introduced to fix.
    //
    // The track has to be dimmer THAN THE FILL, which is not the same as being a
    // fixed colour: a stale reading dims its fill to tertiary, so a fixed tertiary
    // track would match it exactly and reproduce the smear on precisely the rows
    // whose numbers are least trustworthy. So it steps down with it.
    let trackColour: NSColor = stale ? .quaternaryLabelColor : .tertiaryLabelColor
    for (text, role) in quotaBarRuns(pct, pace: pace) {
        parts.append((text, F_MONO, role == .fill ? colour
                                 : role == .track ? trackColour
                                 : .secondaryLabelColor))
    }
    return menuTitle(parts + [
        // NOT systemOrange, which is also the 80%-high colour - so a stale row was
        // the loudest ink in the whole block AND wearing the warning colour, i.e.
        // it looked like an alarm about usage on the one row whose numbers we
        // explicitly cannot vouch for. Staleness is an absence of information, and
        // it is already said in words and by the dimmed figure beside it.
        (staleNote, F_MONO, .secondaryLabelColor),
        // THE RESET STAYS DOWN HERE, and that was measured rather than preferred.
        // With the number leading, the main row now ends around 232px of a 316px
        // lane (`--menu-preview`), so promoting `resets in` up to it looks free -
        // but the widest real case is "  resets in 5d 8h", 17 monospaced cells
        // ≈ 112px against 84px spare. It would wrap, and a wrapped row note gets
        // no indent, which is a defect this menu has already been through once.
        //
        // Indented with monospaced spaces so it sits under the bar. Padding a
        // proportional font gave a third of the intended indent.
        (reset.map { _ in "\n      " } ?? "", F_MONO, .secondaryLabelColor),
        (reset.map { "resets in \(humanMinutes($0))" } ?? "", F_SMALL, .secondaryLabelColor),
        // What the tick is, spelled out, on the row that has room for it. The
        // menu bar can only afford the glyph, so this is where the vocabulary the
        // two surfaces share actually gets taught.
        // SECONDARY, not tertiary. This clause is the only place the ▲/▼/≈
        // vocabulary is ever spelled out - the bar label has room for the glyph
        // and nothing else - so it is the row's teaching text, and at 0.259 it
        // was the faintest thing on a row it is supposed to explain.
        (pace == nil ? "" : "  \u{00B7}  \(paceNote(pct: pct, pace: pace))", F_SMALL, .secondaryLabelColor),
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
        return "Failed: \(p.error.isEmpty ? "no reason given" : p.error)"
    default:
        if p.devices.isEmpty { return "No devices found yet - choose Scan" }
        return "\(p.devices.count) device\(p.devices.count == 1 ? "" : "s") found - pick one"
    }
}

func pairDeviceRowTitle(_ d: PairDevice) -> String { "\(d.name)  ·  \(d.rssi) dBm" }

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

/// THE DIALOG, built by a factory so `--pair-check` can inspect the real thing
/// rather than a description of it. Everything a person needs in order to answer
/// correctly has to be IN it: which device is asking, this Mac's own six digits,
/// and the fact that the device must show the SAME ones.
func pairCompareAlert(code: String, device: String, label: String) -> NSAlert {
    let a = NSAlert()
    a.messageText = device.isEmpty ? "Does the device show this code?" : "Does \(device) show this code?"
    a.informativeText =
        "This Mac derived the code below from its exchange with \(device.isEmpty ? "the device" : device)"
        + (label.isEmpty ? "" : " (\(label))")
        + ". The device's screen shows its own.\n\n"
        + "If the two are identical, choose \u{201C}They match\u{201D} - then tap CONFIRM on the device "
        + "itself to store the key. If they differ, something else answered: choose "
        + "\u{201C}They don\u{2019}t match\u{201D} and nothing is stored."
    let field = NSTextField(labelWithString: code)
    field.attributedStringValue = NSAttributedString(string: code, attributes: [
        // SF Mono, not `monospacedDigitSystemFont`: that one is the system face
        // with tabular figures, which lines the digits up but is not a fixed-pitch
        // face - and this is the same family (F_MONO) every other reading in this
        // menu is drawn in, against a device face that is a fixed 8x16 cell.
        .font: NSFont.monospacedSystemFont(ofSize: PAIR_CODE_FONT_PT, weight: .semibold),
        // SEMANTIC, so it is legible in both appearances - the same rule every
        // other colour in this file follows.
        .foregroundColor: NSColor.labelColor,
        .kern: PAIR_CODE_KERN,
    ])
    field.alignment = .center
    field.sizeToFit()
    field.frame = NSRect(x: 0, y: 0, width: max(260, field.frame.width), height: field.frame.height)
    a.accessoryView = field
    a.addButton(withTitle: "They match")
    a.addButton(withTitle: "They don\u{2019}t match")
    // NEITHER ANSWER IS THE RETURN KEY'S. AppKit makes the first button the
    // default, so a stray Return would assert "I compared two numbers" without
    // anyone having looked - which is the one input this whole design rests on.
    // Escape still declines, because refusing must stay the cheap option.
    a.buttons[0].keyEquivalent = ""
    a.buttons[1].keyEquivalent = "\u{1b}"
    return a
}

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
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
    // Wireless pairing. Same "built once, only re-titled" discipline as the icon
    // and sound pickers: the menu can be OPEN while the 3s refresh runs, and
    // adding or removing rows under the cursor makes the list jump.
    let pairItem = NSMenuItem(title: "Pair new device\u{2026}", action: nil, keyEquivalent: "")
    let pairMenu = NSMenu()
    let pairStatusItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    var pairRows: [NSMenuItem] = []
    let pairScanItem = NSMenuItem(title: "Scan for devices", action: #selector(pairScan), keyEquivalent: "")
    let pairCancelItem = NSMenuItem(title: "Cancel pairing", action: #selector(pairCancel), keyEquivalent: "")
    // What has already been put in front of the user. Outlives a refresh for the
    // same reason askWatcher does - a decision about what is NEW cannot be made
    // from a local.
    var pairSeen = PairSeen()
    // NSAlert.runModal spins the run loop, so the 3s timer fires again INSIDE it
    // and refresh() re-enters. Without this a second identical dialog stacks on
    // top of the first every three seconds.
    var pairAlertOpen = false
    let soundItem = NSMenuItem(title: "Needs-input sound", action: nil, keyEquivalent: "")
    let soundMenu = NSMenu()
    var soundItems: [(String, NSMenuItem)] = []
    // Title is set per-refresh (rebuildIconMenu) since it changes to "(set by
    // env)" - it starts at the plain form so --menu-dump has something sane
    // before the first refresh runs.
    let iconItem = NSMenuItem(title: "Mac icon", action: nil, keyEquivalent: "")
    let iconMenu = NSMenu()
    var iconItems: [(String, NSMenuItem)] = []
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
        iconMenu.autoenablesItems = false
        iconItem.submenu = iconMenu
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
        pairMenu.autoenablesItems = false
        pairItem.submenu = pairMenu
        // Opening this submenu STARTS A SCAN, because "look for devices" is the
        // only thing anyone opens it to do and a menu that needs a second click
        // before it can list anything is a menu that looks broken. The delegate
        // is what makes that possible at all: a submenu PARENT's own action never
        // fires - clicking it just opens the submenu. Guarded in pairScan() so
        // hovering past it during an exchange cannot disturb one.
        pairMenu.delegate = self
        // A fixed pool, hidden rather than removed (see sessionRows).
        pairRows = (0..<MAX_PAIR_ROWS).map { _ in
            let it = NSMenuItem(title: "", action: #selector(pairStart(_:)), keyEquivalent: "")
            it.target = self
            it.isHidden = true
            pairMenu.addItem(it)
            return it
        }
        pairMenu.addItem(.separator())
        // The status row carries a READING (which device, how long is left, why it
        // failed), so it is ENABLED - see --legibility-check and the ~31% note in
        // buildMenu below. It has no action, which is the exception that rule
        // documents rather than a control that does nothing.
        pairStatusItem.target = self
        pairStatusItem.isEnabled = true
        pairMenu.addItem(pairStatusItem)
        for it in [pairScanItem, pairCancelItem] {
            it.target = self
            it.isEnabled = true
            pairMenu.addItem(it)
        }
        for it in [remoteItem, colourItem, barItem, soundItem, iconItem, pairItem, loginItem] {
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
        // Sixteen fixed rows, checked/enabled per refresh (rebuildIconMenu) -
        // same "built once, only re-checked" shape as soundItems above, since
        // the set of names never changes, only which one is checked and
        // whether they're editable at all.
        for name in MAC_ICON_NAMES {
            let it = NSMenuItem(title: iconRowTitle(name), action: #selector(pickIcon(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = name
            iconMenu.addItem(it)
            iconItems.append((name, it))
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
        for it in [q5, q7, cxLine, battLine, statusLine, deviceLine] { it.isEnabled = true }
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
            let label = barTitle(s)
            button.attributedTitle = label
            button.imagePosition = label.length == 0 ? .imageOnly : .imageLeading
            // The arrows are the one thing in the bar that needs a word, and this
            // is the only surface that can give them one.
            button.toolTip = barTooltip(s).isEmpty ? nil : barTooltip(s)
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
        // The window each percentage belongs to, which is what turns "resets in
        // 176m" into a POSITION. Codex's comes off the tick line (`codex=44%/7d`)
        // because it is per-plan; a missing one costs the tick and nothing else.
        if let pct = s.pct5h { q5.attributedTitle = quotaTitle("5h", pct, s.reset5h, s.quotaAgeSec, windowMin: WINDOW_5H_MIN) }
        if let pct = s.pct7d { q7.attributedTitle = quotaTitle("7d", pct, s.reset7d, s.quotaAgeSec, windowMin: WINDOW_7D_MIN) }
        if let pct = s.cxPct { cxLine.attributedTitle = quotaTitle("Codex", pct, s.cxReset, s.cxAgeSec, windowMin: s.cxWinMin) }
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
        rebuildIconMenu(s)
        rebuildPairMenu(s)
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
        // AFTER the dryRun guard, deliberately: --menu-dump and --menu-preview
        // build the real menu and refresh it, and a diagnostic that pops a modal
        // dialog on someone's desktop is the same class of problem as one that
        // makes a noise.
        runPairAlerts(s)
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

    // WHICH of the sixteen is live. One function because two things now render
    // it - the checkmark and the parent row's glyph - and a picker whose tick
    // and whose picture disagreed would be worse than either alone.
    //
    // The host has already resolved env-vs-file (resolveMacEmoji, env wins), so
    // s.icon IS the live value regardless of which source it came from - no
    // separate branch needed for the env case here. That reading is only fresh
    // while the host is actually running (readStatus only fills it inside its
    // "running" branch); with the host down, fall back to what was last picked
    // from this menu, so the checkmark survives a relaunch instead of going
    // blank.
    func iconRowCurrent(_ s: HostStatus) -> String {
        s.running ? s.icon : (UserDefaults.standard.string(forKey: "macIcon") ?? "")
    }

    // The Mac-icon submenu: sixteen fixed rows, one checkmarked. Rebuilt every
    // refresh (not just built once, unlike a static preference row) because
    // BOTH the checkmark and whether the rows are editable at all come from the
    // host's heartbeat, which can change out from under this app - a picker
    // showing changeable checkmarks while DECKHAND_MAC_EMOJI is set would be
    // lying about what a click can do.
    func rebuildIconMenu(_ s: HostStatus) {
        let current = iconRowCurrent(s)
        // The parent carries the CURRENT glyph, so the setting is legible without
        // opening the submenu at all - and it is the one row that can show which
        // of the sixteen an env-set value resolved to without implying a click
        // could change it. Nothing when none is set, rather than a placeholder:
        // no icon is a real state (the device falls back to the text tag).
        let glyph = MAC_ICON_GLYPHS[current].map { "  \($0)" } ?? ""
        iconItem.title = (s.iconFromEnv ? "Mac icon (set by env)" : "Mac icon") + glyph
        for (name, item) in iconItems {
            item.state = (!current.isEmpty && name == current) ? .on : .off
            // Only the CHILDREN are disabled - the parent stays clickable so
            // the (now-inert) list can still be opened and read, the same way
            // Settings itself stays reachable with the host down.
            item.isEnabled = !s.iconFromEnv
        }
    }

    // Writes EMOJI <name> to the trigger file - the same mechanism SELECT and
    // FORGET already use - and stores it in UserDefaults so the checkmark is
    // right immediately and survives a relaunch even before the host's own
    // heartbeat catches up. Validating the name and persisting it to
    // ~/.claude/deckhand-mac-emoji both already happen on the host
    // (host/mac-emoji.mjs) and are deliberately NOT repeated here.
    @objc func pickIcon(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        UserDefaults.standard.set(name, forKey: "macIcon")
        try? "EMOJI \(name)".write(toFile: commandTriggerPath, atomically: true, encoding: .utf8)
        refresh()
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

    // ---- wireless pairing --------------------------------------------------

    /// Every pairing verb goes out through the same trigger file `SELECT`,
    /// `FORGET` and `EMOJI` already use. The host intercepts all four; none is
    /// forwarded to the device.
    func pairSend(_ command: String) {
        try? command.write(toFile: commandTriggerPath, atomically: true, encoding: .utf8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
    }

    /// The submenu's rows, re-titled per refresh. Nothing is added or removed:
    /// the pool is fixed and rows past the sighting count are hidden.
    func rebuildPairMenu(_ s: HostStatus) {
        // Enabled only while the host is running, for the reason the Device
        // submenu beside it already dims: with no host there is nothing to write
        // a command TO, and the trigger file would simply sit there until one
        // started and then run a scan nobody asked for.
        pairItem.isEnabled = s.running && s.pairing.supported
        let devices = s.pairing.devices.prefix(MAX_PAIR_ROWS)
        for (i, it) in pairRows.enumerated() {
            guard i < devices.count else { it.isHidden = true; continue }
            let d = devices[devices.startIndex + i]
            it.isHidden = false
            it.title = pairDeviceRowTitle(d)
            it.representedObject = d.name
            // A row that the host would refuse is dimmed rather than drawn live -
            // the same "never offer a control that cannot work" rule the device's
            // read-only ask path pays for.
            it.isEnabled = pairCanStart(s)
        }
        pairStatusItem.attributedTitle = menuTitle([(pairStatusText(s), F_SMALL, .secondaryLabelColor)])
        pairScanItem.title = s.pairing.devices.isEmpty ? "Scan for devices" : "Scan again"
        pairScanItem.isEnabled = pairCanStart(s) && s.pairing.state != "scanning"
        pairCancelItem.isEnabled = pairInFlight(s)
    }

    /// Opening the submenu scans, so the list is there by the time the pointer
    /// reaches it. Guarded rather than unconditional: during an exchange the host
    /// would refuse a PAIRSCAN anyway, and writing one would clobber whatever
    /// command is sitting in the trigger file.
    func menuWillOpen(_ menu: NSMenu) {
        guard menu === pairMenu, !dryRun else { return }
        let s = readStatus()
        guard pairCanStart(s), s.pairing.state != "scanning" else { return }
        pairSend("PAIRSCAN")
    }

    @objc func pairScan() { pairSend("PAIRSCAN") }

    /// Picking a device names it explicitly, the way SELECT and FORGET do, so the
    /// host starts the exchange with the row that was clicked rather than with
    /// whatever is topmost by the time it reads the file.
    @objc func pairStart(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String, !name.isEmpty else { return }
        pairSend("PAIRSTART \(name)")
    }

    @objc func pairCancel() { pairSend("PAIRCANCEL") }

    /// THE COMPARISON, and the two reports that follow it.
    ///
    /// Everything about WHAT to do is decided by `pairNext`, which is pure and
    /// driven end to end by `--pair-check`; this function is only the modal part,
    /// which a script can never click.
    func runPairAlerts(_ s: HostStatus) {
        guard !pairAlertOpen else { return }
        let (action, seen) = pairNext(s.pairing, pairSeen)
        pairSeen = seen
        guard action != .none else { return }
        pairAlertOpen = true
        defer { pairAlertOpen = false }
        switch action {
        case .compare(let code, let device, let label):
            let matched = pairCompareAlert(code: code, device: device, label: label).runModal()
                == .alertFirstButtonReturn
            // NOTHING IS COMMITTED BY EITHER BUTTON. Match sends the proof, which
            // only tells the device that the peer it did the ECDH with is the one
            // that answered; the key is stored when a finger touches CONFIRM on
            // the glass. That is the presence proof the cable used to be.
            pairSend(matched ? "PAIRCONFIRM" : "PAIRCANCEL")
            if matched {
                let a = NSAlert()
                a.messageText = "Now tap CONFIRM on \(device.isEmpty ? "the device" : device)"
                a.informativeText = "The Mac has sent its proof. Nothing is stored until someone standing at the device taps CONFIRM on its screen - that tap is what replaces plugging it in.\n\nIt expires with the device's 120-second pairing window."
                a.runModal()
            }
        case .done(let device):
            let a = NSAlert()
            a.messageText = "Paired with \(device.isEmpty ? "the device" : device)"
            a.informativeText = "Both ends derived the same key from the exchange - it was never transmitted. This Mac can now answer that device's prompts, and the pairing shows up under Device."
            a.runModal()
        case .failed(let device, let reason):
            let a = NSAlert()
            a.alertStyle = .warning
            a.messageText = "Pairing with \(device.isEmpty ? "the device" : device) failed"
            // THE CAUSE IS NAMED, always. From the Mac, "it did not work" and "it
            // is not possible here" look identical - the rule POWERPROBE's
            // "not on battery (unplug USB; state=2 mv=3866)" refusal exists for.
            a.informativeText = (reason.isEmpty ? "The host gave no reason." : reason)
                + "\n\nNothing was stored. Open the device's Settings › Pairing, tap PAIR NEW MAC, and try again."
            a.runModal()
        case .none:
            break
        }
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
    // was set on it. The pairing status row lives inside `Pair new device…`, which
    // dims with the host, so with the host down this check FAILED for a row that
    // cannot be opened at all. An instrument that fails for the wrong reason is
    // worse than none, and this file has earned that sentence twice already.
    for (name, it, reachable) in [("5h", d.q5, { true }), ("7d", d.q7, { true }),
                                  ("Codex", d.cxLine, { true }), ("battery", d.battLine, { true }),
                                  // Carries WHY a pairing failed, and a cause
                                  // rendered in grey is a cause nobody reads.
                                  ("pairing status", d.pairStatusItem, { d.pairItem.isEnabled })]
                                 as [(String, NSMenuItem, () -> Bool)] {
        guard !it.isHidden, reachable() else { continue }
        if it.isEnabled { print("  \(name): full strength"); continue }
        print("FAIL \(name) is DISABLED, so AppKit draws its reading at ~31% - grey, unreadable")
        failed += 1
    }
    print(failed == 0 ? "legibility: every reading renders at full strength"
                      : "legibility: \(failed) row(s) FAILED")
    exit(failed == 0 ? 0 : 1)
}

if CommandLine.arguments.contains("--menu-dump") || CommandLine.arguments.contains("--menu-preview") {
    let d = AppDelegate()
    d.dryRun = true
    let m = d.buildMenu()
    d.refresh()
    if CommandLine.arguments.contains("--menu-dump") {
        let st = readStatus()
        // `.string` drops the colours, which is what a text dump can carry. The
        // pace GLYPHS survive, and they are the half that changes meaning - a
        // dump that showed neither could not tell a live 96%▲ from a stale one,
        // so the tooltip's own sentence is printed under it.
        let label = barTitle(st).string
        print("menu bar: boat (\(barBoatStyle(st)))"
              + (label.isEmpty ? " (no label)" : " + label\"\(label)\""))
        let tip = barTooltip(st)
        print(tip.isEmpty ? "" : tip.split(separator: "\n").map { "  tooltip: \($0)" }.joined(separator: "\n") + "\n")
        print(dumpMenu(m))
    }
    if let i = CommandLine.arguments.firstIndex(of: "--menu-preview"), CommandLine.arguments.count > i + 1 {
        writeMenuPreview(to: CommandLine.arguments[i + 1], m, bar: barTitle(readStatus()))
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
    eq(barely.filter { $0.role == .fill }.map(\.text).joined().contains("\u{2588}"), true,
       "1% used keeps a filled cell even with the tick on top of it")
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
                let want = r.role == .fill ? "\u{2588}" : "\u{2591}"
                if r.text.contains(where: { String($0) != want }), mixedAt.isEmpty {
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
    let row = quotaTitle("5h", 44, 30, 1, windowMin: WINDOW_5H_MIN)
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
        let t = quotaTitle(name, pct, 30, age, windowMin: WINDOW_5H_MIN)
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

    // Staleness suppresses the pace on BOTH surfaces, because the percentage has
    // stopped moving while the clock has not.
    var st = HostStatus()
    st.running = true; st.pct5h = 96; st.reset5h = 30; st.quotaAgeSec = 1
    eq(barUsageParts(st).map(\.0).joined().contains("\u{25B2}"), true, "a fresh reading gets its glyph")
    st.quotaAgeSec = QUOTA_STALE_SEC + 1
    eq(barUsageParts(st).map(\.0).joined().contains("\u{25B2}"), false, "a stale reading loses it")
    eq(quotaBarRuns(96, pace: pacePct(resetInMin: 30, windowMin: WINDOW_5H_MIN))
        .contains { $0.role == .tick }, true,
       "and the tick is what the row loses with it")

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
    ok(pairStatusText(noReason).contains("no reason given"), "an empty error still says so")

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

    // ---- THE DIALOG ITSELF, inspected rather than described -----------------
    let a = pairCompareAlert(code: "001472", device: "Deckhand-C114", label: "studio")
    let field = a.accessoryView as? NSTextField
    ok(field != nil, "the code is shown in the dialog's accessory view")
    if let field {
        // THE USER TYPES NOTHING. An editable field here would be the broken
        // first design walking back in: the HMAC proof derives from the shared
        // secret, so a typed code proves nothing to the device.
        ok(!field.isEditable, "the code field is NOT editable - there is nothing to type here")
        // Drawn EXACTLY as settings.ino draws it: ungrouped, no separators. Two
        // renderings of one number are two things to compare wrongly.
        eq(field.stringValue, "001472", "the six digits are shown verbatim, ungrouped and unpadded")
        let f = field.attributedStringValue.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        ok(f != nil, "the code has a font of its own")
        if let f {
            ok(f.pointSize >= 32,
               "the code is big enough to read across a desk (got \(f.pointSize)pt) - "
               + "a comparison nobody can make is a comparison nobody makes")
            ok(f.isFixedPitch || f.fontDescriptor.postscriptName?.contains("Mono") == true,
               "and monospaced, so digit N lines up with digit N on the device")
        }
        let kern = field.attributedStringValue.attribute(.kern, at: 0, effectiveRange: nil) as? CGFloat
        ok((kern ?? 0) > 0, "the digits are spaced apart by KERNING, which inserts no character")
    }
    eq(a.buttons.count, 2, "two answers: they match, or they do not")
    eq(a.buttons[0].title, "They match", "and the first says so in words, not Yes/OK")
    ok(a.buttons[1].title.contains("don"), "the second is an explicit denial, not Cancel")
    // NEITHER IS THE RETURN KEY'S. AppKit defaults the first button, and a stray
    // Return would assert that two numbers were compared by someone who never
    // looked - the single input this design rests on.
    eq(a.buttons[0].keyEquivalent, "", "Return does not answer for the user")
    eq(a.buttons[1].keyEquivalent, "\u{1b}", "Escape declines, so refusing stays the cheap option")
    ok(a.messageText.contains("Deckhand-C114"), "the dialog names the device it is asking about")
    ok(a.informativeText.contains("studio"), "and the label that device is showing beside its own code")
    ok(a.informativeText.contains("CONFIRM"),
       "and says the device's own tap is what stores the key - the Mac's button commits nothing")
    let anon = pairCompareAlert(code: "482913", device: "", label: "")
    ok(!anon.messageText.contains("()"), "an unnamed device does not leave empty brackets on screen")

    print(failed == 0 ? "pair: all \(ran) checks passed" : "pair: \(failed) of \(ran) FAILED")
    exit(failed == 0 ? 0 : 1)
}

/// `--pair-shot <out.png> [code] [device]`: THE REAL COMPARISON DIALOG, off the
/// glass, captured by window id.
///
/// `--pair-check` can assert that the face is monospaced and 44pt; it cannot say
/// whether six digits at that size, in that dialog, beside that wording, are
/// actually easy to compare with a device across a desk. That judgement needs a
/// person and therefore a picture - and this dialog is otherwise reachable only
/// by running a real exchange with a real device.
///
/// Same two orderings `--menu-shot` documents and for the same reasons: the
/// capture is dispatched BEFORE runModal (which blocks the main thread for
/// exactly as long as the window exists), and it captures the window this process
/// OWNS rather than a guessed screen region - a guessed region cheerfully writes a
/// PNG of whatever was behind a dialog that never appeared.
if let i = CommandLine.arguments.firstIndex(of: "--pair-shot") {
    let args = CommandLine.arguments
    let path = args.count > i + 1 ? args[i + 1] : "pair-shot.png"
    let code = args.count > i + 2 ? args[i + 2] : "001472"
    let device = args.count > i + 3 ? args[i + 3] : "Deckhand-C114"
    // FORCED, because a capture can only show the appearance the Mac is set to
    // and this dialog has to be legible in both - the same gap --menu-preview
    // exists to close for the menu. Omitted, it follows the system.
    let forced: NSAppearance? = args.contains("light") ? NSAppearance(named: .aqua)
        : args.contains("dark") ? NSAppearance(named: .darkAqua) : nil
    final class Shot: NSObject, NSApplicationDelegate {
        let path: String, code: String, device: String, forced: NSAppearance?
        init(_ p: String, _ c: String, _ d: String, _ ap: NSAppearance?) {
            path = p; code = c; device = d; forced = ap
        }
        func applicationDidFinishLaunching(_ n: Notification) {
            NSApp.setActivationPolicy(.accessory)
            let a = pairCompareAlert(code: code, device: device, label: "studio")
            if let forced { a.window.appearance = forced }
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.2) {
                let mine = ProcessInfo.processInfo.processIdentifier
                let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
                            as? [[String: Any]]) ?? []
                let win = list.first { ($0[kCGWindowOwnerPID as String] as? Int32) == mine
                                       && ((($0[kCGWindowBounds as String] as? [String: Any])?["Height"]
                                            as? Double) ?? 0) > 60 }
                guard let id = win?[kCGWindowNumber as String] as? Int else {
                    print("pair-shot FAILED: this process owns no on-screen window, so the dialog never appeared - NOT writing \(self.path)")
                    exit(1)
                }
                let cap = Process()
                cap.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                cap.arguments = ["-x", "-o", "-l", String(id), "-t", "png", self.path]
                try? cap.run()
                cap.waitUntilExit()
                let ok = FileManager.default.fileExists(atPath: self.path)
                print(ok ? "wrote \(self.path)  (the real compare dialog, off the glass)"
                         : "pair-shot FAILED: screencapture wrote nothing for window \(id)")
                DispatchQueue.main.async { NSApp.abortModal(); exit(ok ? 0 : 1) }
            }
            // The backstop --menu-shot needed for the same reason: without it a
            // failure above leaves a modal dialog sitting on someone's desktop.
            Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in
                print("pair-shot FAILED: timed out with the dialog still up")
                NSApp.abortModal()
                exit(1)
            }
            _ = a.runModal()
        }
    }
    let shot = Shot(path, code, device, forced)
    app.delegate = shot
    app.run()
}

if let i = CommandLine.arguments.firstIndex(of: "--icon-preview") {
    writeIconPreview(to: CommandLine.arguments.count > i + 1
        ? CommandLine.arguments[i + 1] : "icon-preview.png")
    exit(0)
}

app.run()
