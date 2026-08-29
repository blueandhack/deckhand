// The TEXTPROBE table: the strings whose measured width is the equivalence
// gate between board 1 (real TFT_eSPI) and board 2 (PanelShim's own text
// renderer).
//
// WHY THIS IS A HEADER AND NOT AN INLINE ARRAY IN THE SKETCH. The table has
// to be run by two different programs - the firmware's TEXTPROBE command and
// the standalone board-2 harness that exercises panel_shim/panel_text
// without the rest of the sketch (the full sketch does not compile for board
// 2 yet). A hand-copied second copy of the list is exactly the drift this
// whole task exists to catch: two tables differing by one string produce a
// clean-looking diff that proves nothing at all. One definition, two loops
// over it.
//
// WHY THESE STRINGS. Widths are what every lane, clear box and fitText
// ladder in the UI is computed from, so the table covers the shapes those
// computations actually see: the longest usage-card labels, the Mac/agent tag
// forms, the padded battery and clock strings whose clear box is sized from
// their width, token counts, and single characters at both extremes of the
// advance table.
//
// The SECOND block exists because the first one does not exercise the rule
// that makes textWidth different from "sum of advances". TFT_eSPI charges the
// LAST character of a string `xOffset + width` instead of `xAdvance` (see
// panel_text.cpp), and in Cozette those two differ for 20 of 95 glyphs - but
// for none of the characters the first block happens to end on, so every one
// of its widths is an exact multiple of the 6px advance and a shim that got
// the last-character rule wrong would still pass. Each string below ends on a
// glyph where the two disagree: `4`/`q`/space measure one pixel MORE than
// their advance, `!"'(),.:;>I[]`jl|` measure one or two LESS.
//
// HOW THE GATE IS RUN. `TEXTPROBE` (see deckhand_display.ino) prints one
// `WIDTH <font> <size> <width> "<string>"` line per entry per font, on BOTH
// boards:
//
//   echo "TEXTPROBE" > ~/.claude/deckhand-device-command
//   sleep 20                       # 4s is NOT enough - 136 lines, and the
//                                  # device sends on USB and BLE, so 272 arrive
//   grep -a "^\[device/usb\] WIDTH" /tmp/deckhand-$(id -u)/host.log \
//     | sed 's/.*WIDTH/WIDTH/' | sort -u > /tmp/width.txt
//
// *** THE CROSS-BOARD DIFF IS NO LONGER THE GATE, AND HAS NOT BEEN SINCE THE
// *** TYPE SCALE. Nobody chose this; the fonts moved out from under it.
//
// The diff was a valid equivalence test only while BOTH boards drew the same
// faces. They no longer do - `UI_FONTS[]` is per board: board 1 is Cozette 6x13
// and Terminus 10x18b, board 2 is Spleen 8x16/12x24/32x64. Different faces
// produce different widths BY DESIGN, so diffing them now yields 136 differences
// that say nothing about whether the shim's algorithm is right. Measured: font 1
// on "Mac  studio  120s ago" is 126 on board 1 (6px/char) and 168 on board 2
// (8px/char).
//
// It is broken a SECOND way, and this one is worse because it is silent. The
// whole point of the second string block below is the last-character rule -
// TFT_eSPI charges the final glyph `xOffset + width`, not `xAdvance`. In Cozette
// those differ for 20 of 95 glyphs, which is what gives the rule teeth. In
// SPLEEN every glyph in 0x20..0x7E has `xOffset == 0` and `width == xAdvance ==
// 8`, so the rule is a NO-OP on board 2 and those strings discriminate nothing
// there. Verified: all 136 captured widths equal a pure `advance * length`.
// A shim that got the last-character rule wrong would pass board 2's half
// unnoticed - the exact failure this table was extended to prevent.
//
// WHAT WOULD ACTUALLY CLOSE IT: build board 2 against COZETTE temporarily (the
// header is already vendored for board 1), run TEXTPROBE on both boards, and
// diff. Same face on both sides makes the comparison meaningful again, and
// Cozette's 20 divergent glyphs make the last-character rule bite. That needs
// board 1 physically attached and one throwaway board-2 build; it has not been
// done.
//
// text-widths-board2.txt is board 2's half, REFRESHED against the shipped Spleen
// registry. The copy it replaces was captured 2026-08-22, one day before Spleen
// landed on board 2, so it described a font the device had already stopped
// drawing - and it sat that way for six days while this comment claimed the
// comparison was "one command". It is still a useful record of what board 2
// measures today; it is not, on its own, the gate.
#pragma once

static const char* const TEXT_PROBE[] = {
  // Real UI strings, verbatim from the task brief.
  "SESSION - 5 HOUR WINDOW", "WEEK - 7 DAY, ALL MODELS", "CODEX  7d", "CX pro",
  "CLAUDE", "CODEX", "CLAUDE/studio", "WORKING", "NEEDS INPUT", "READY",
  "100% 4.20V ~99h", "0000000", "12:34:56", "100.00M tok", "3d 5h left",
  "Mac  studio  120s ago", "AGENT / MAC", "deckhand", "spectrum-api", "M", "W", "i", "1",
  // Last-character-rule coverage - see the header note above.
  "4", "q", "1234", "12/4", "OK.", "TOTAL:", "hi!", "I", "|", "Q1 (est)", "ALL ",
};
static const size_t TEXT_PROBE_COUNT = sizeof(TEXT_PROBE) / sizeof(TEXT_PROBE[0]);

// Every rung of the type scale: 1/2 are Cozette 6x13, 3 is Terminus 10x18
// bold, 4 is Cozette at size 2. Ids, not faces, because setUIFont() is what
// the UI itself calls and the size multiplier is part of what has to match.
static const uint8_t TEXT_PROBE_FONTS[] = { 1, 2, 3, 4 };
static const size_t TEXT_PROBE_FONT_COUNT = sizeof(TEXT_PROBE_FONTS) / sizeof(TEXT_PROBE_FONTS[0]);
