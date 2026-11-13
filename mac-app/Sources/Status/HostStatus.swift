import Cocoa

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
    /// The process that wrote the heartbeat. A Restart is finished when this
    /// changes - "running" alone cannot tell the new host from the old one.
    var pid: Int? = nil
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
            s.pid = obj["pid"] as? Int
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
