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
// HOW THE GATE IS RUN, AND WHAT IS STILL OUTSTANDING. `TEXTPROBE` (see
// deckhand_display.ino) prints one `WIDTH <font> <size> <width> "<string>"`
// line per entry per font, on BOTH boards. Board 1 runs real TFT_eSPI, so its
// output is the reference and the check is a diff, not a judgement:
//
//   echo "TEXTPROBE" > ~/.claude/deckhand-device-command
//   sleep 4
//   grep -a "^\[device/usb\] WIDTH" /tmp/deckhand-$(id -u)/host.log \
//     | sed 's/.*WIDTH/WIDTH/' | sort -u > /tmp/width-board1.txt
//   diff /tmp/width-board1.txt firmware/deckhand_display/text-widths-board2.txt
//
// text-widths-board2.txt is board 2's half, captured in exactly that format so
// the comparison is that one command. Board 1 was physically disconnected when
// it was taken, so THE DIFF HAS NOT BEEN RUN: board 2's numbers were checked
// against an independent transcription of TFT_eSPI's textWidth() instead, which
// is evidence but not the gate. Run the diff before deriving any layout number
// from these widths.
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
