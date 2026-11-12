import Cocoa

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
