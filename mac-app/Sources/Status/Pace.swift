import Cocoa

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
