// Make device-bound text ASCII, so CHARACTERS and BYTES are the same unit.
//
// WHY THIS EXISTS, and it is a correctness fix rather than tidiness.
//
// feedChar() in the firmware guards `buf.length() > 16000` on an Arduino String,
// which counts BYTES. Every cap upstream of it - the hook's detail (1400), title
// (34) and option labels (32), the host's name/path/model/branch/title/prompt and
// the voice text/reply - is applied with JS `.slice(n)`, which counts UTF-16 CODE
// UNITS. A BMP character outside ASCII is one unit and up to THREE bytes, so every
// char-capped field could be 3x its stated size on the wire. Measured: six asking
// sessions of all-wide text came to 36,173 bytes against a 16,000 guard, and ONE
// session carrying a multi-byte question at the 1400-char detail cap already blows
// it at 17,893. A single question containing CJK was enough.
//
// The failure was far worse than a dropped line: the guard CLEARS THE BUFFER
// MID-LINE, so the first 16000 bytes are discarded and the REMAINDER of the same
// line accumulates into the emptied buffer. processCompletedLine() then gets a
// JSON fragment, handleLine() returns early on the parse error, and every tick
// carrying that prompt is lost - so the screen freezes at its last good state for
// as long as the prompt is pending, while both links, both heartbeats and both
// menu bars look perfectly healthy. Nothing logs why. That is the same "healthy
// process doing no useful work" shape this repo has documented three times.
//
// WHY ASCII RATHER THAN A BIGGER GUARD. Both device fonts declare 0x20..0x7E
// (Spleen8x16.h, Cozette6x13.h), and an out-of-range byte draws nothing and
// advances nothing - so today every non-ASCII byte is budget spent on an INVISIBLE
// GAP. Stripping them costs no information the device could ever have shown.
// Raising the guard would not help either: askDetail[1424], askOpts[4][34] and
// askTitle[36] are fixed and copyField truncates by BYTE, so a bigger guard just
// moves the truncation one layer down.
//
// AFTER THIS, A CHARACTER SLICE IS A BYTE SLICE. Every cap above keeps its number
// and its meaning becomes exact, which is the point: this reconciles the two units
// permanently instead of patching one cap and leaving the next one wrong.
//
// THIS FILE IS DUPLICATED, DELIBERATELY. claude-hooks/deckhand-session-hook.mjs
// carries a copy of toAscii() inline, because install.sh copies that one file into
// ~/.claude and it can therefore only ever import node builtins - an import from
// this repo would resolve here and fail on the machine that actually runs the
// hook. Same reason capBytes() there duplicates capUtf8() from voice-answer.mjs.
// host/wire-bytes-check.mjs extracts the hook's copy and runs it side by side
// with this one over a corpus, so the two cannot drift silently.

// Characters that DO have an obvious ASCII equivalent. Transliterating what
// actually appears matters more than it sounds: Claude's own output is full of
// em-dashes, curly quotes, ellipses and arrows, and blanking them all would turn
// ordinary English prose into question marks. This repo already prefers the ASCII
// forms elsewhere for the same font reason - fitText's three ASCII dots, the Mac
// tag's ASCII '/' separator.
const MAP = new Map(Object.entries({
  // quotes
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "«": '"', "»": '"', "‹": "'", "›": "'",
  // dashes and the minus sign
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
  "―": "-", "−": "-", "­": "",
  // ellipsis: three ASCII dots, exactly what fitText already draws
  "…": "...",
  // spaces of every width, plus the zero-width ones which vanish entirely
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  "　": " ", " ": " ", " ": " ",
  "​": "", "‌": "", "‍": "", "﻿": "",
  // bullets and separators
  "•": "*", "‣": "*", "●": "*", "▪": "*", "◦": "*",
  "·": "-", "‧": "-", "⁃": "-",
  // arrows: the ones a plan or a diff actually uses
  "←": "<-", "→": "->", "↔": "<->",
  "⇐": "<=", "⇒": "=>", "⇔": "<=>",
  "↑": "^", "↓": "v",
  // maths and comparison
  "×": "x", "÷": "/", "≤": "<=", "≥": ">=", "≠": "!=",
  "≈": "~", "±": "+/-", "∞": "inf",
  // marks that read as words
  "©": "(c)", "®": "(R)", "™": "(TM)", "°": "deg",
  "¼": "1/4", "½": "1/2", "¾": "3/4",
  "€": "EUR", "£": "GBP", "¥": "JPY", "¢": "c",
  // Latin letters NFD cannot decompose
  "ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
  "ø": "o", "Ø": "O", "đ": "d", "Đ": "D",
  "ł": "l", "Ł": "L", "ð": "d", "Ð": "D",
  "þ": "th", "Þ": "Th",
  // checks and crosses, common in Claude's own status lines
  "✓": "v", "✔": "v", "✗": "x", "✘": "x", "✅": "v",
  "❌": "x", "⭐": "*", "⚠": "!",
}));

const NON_ASCII = /[^\x00-\x7f]/;
const COMBINING = /\p{M}/u;

// Everything else - CJK, emoji, anything with no sensible ASCII form - becomes a
// single '?', and a RUN of them collapses to ONE. A vanished sentence is worse
// than a marked one (today it vanishes), but one '?' per character turns a CJK
// sentence into a wall of question marks that is itself unreadable.
export function toAscii(s) {
  const str = String(s ?? "");
  // Pure ASCII in, the SAME string out - not a copy, not one byte changed. This is
  // what makes the fix invisible to every payload that was already fine.
  if (!NON_ASCII.test(str)) return str;
  let out = "";
  let pending = false;                       // an unmappable run is open
  for (const ch of str.normalize("NFD")) {   // NFD first: accented Latin loses its
    if (ch.codePointAt(0) < 0x80) {          // marks rather than becoming '?'
      if (pending) { out += "?"; pending = false; }
      out += ch;
      continue;
    }
    // A combining mark is dropped silently: its base was already emitted (or
    // already '?'-ed), and marking it would put a '?' beside every accent.
    if (COMBINING.test(ch)) continue;
    const mapped = MAP.get(ch);
    if (mapped !== undefined) {
      if (pending) { out += "?"; pending = false; }
      out += mapped;                         // may be "" for a zero-width char,
      continue;                              // which must not break a run either
    }
    pending = true;
  }
  if (pending) out += "?";
  return out;
}

// Transliterate THEN cap, never the other way round. A few mappings expand - the
// ellipsis is one character in and three out - so capping first would let a field
// grow back past its cap, which is the whole defect being fixed. After this call
// s.length === Buffer.byteLength(s), so the cap is exact in both units.
export function deviceText(s, max) {
  const a = toAscii(s);
  return max == null ? a : a.slice(0, max);
}
