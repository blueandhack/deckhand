import Cocoa

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
// PAIR_CODE_DIGITS (PairingState.swift), and docs/superpowers/specs/2026-08-30-wireless-pairing.md.

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
