import Cocoa

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
func modePairCheck() {
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
func modePairShot() {
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
}
