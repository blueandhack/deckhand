import Cocoa

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
