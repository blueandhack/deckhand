import Cocoa

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
func modeLegibilityCheck() {
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
}

func modeSoundCheck() {
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
func modePaceCheck() {
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
}
