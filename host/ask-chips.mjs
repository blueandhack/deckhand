// host/ask-chips.mjs — lift the tokens worth tapping out of an ask, on the Mac.
//
// WHY THIS RUNS ON THE MAC, NOT THE DEVICE. Most answers to a Claude Code
// prompt are "yes", "no", "go ahead", or a token that was ALREADY PRINTED in
// the question — a path, a flag, a filename. The hardest thing to type on
// this device is exactly such a token: a path costs a page switch for every
// `/`, and a capital costs a shift. The host already parses the ask into its
// title and detail and already transliterates it to ASCII (host/to-ascii.mjs)
// before anything is sent, so it is the natural place to also pull out the
// handful of tokens someone is likely to want back verbatim. The ESP32 only
// ever draws buttons; it never re-derives what they say.
//
// WHY THIS IS NOT IN claude-hooks/deckhand-session-hook.mjs. That file is
// installed to ~/.claude/deckhand-session-hook.mjs (outside this repo) by
// install-hooks.mjs, and a change to it needs a reinstall before it takes
// effect anywhere. Keeping extraction here, in host/, means it ships the
// moment the host restarts — no separate install step, and it can be tested
// by importing it directly, with no child process and no reinstall.
//
// THIS MODULE IS PURE. No filesystem, no network, no globals beyond the
// built-in Buffer (used only to count UTF-8 bytes, not to touch the
// filesystem). It does not call toAscii() itself — see the note above
// askChips() for why the caller must, and why that order is load-bearing.
//
// THE FOUR RULES, IN ORDER (docs/superpowers/specs/2026-09-04-compose-surface-
// design.md, "The token chips: host, wire, firmware"):
//   1. backticked spans
//   2. tokens beginning `--`, or `-` followed by a letter (flags)
//   3. whitespace-free tokens containing `/` (paths)
//   4. quoted spans
// Then: dedupe, preserving first-appearance order; drop anything over
// CHIP_BYTES; cap at CHIP_MAX.
//
// "First appearance" is POSITIONAL — where the match starts in the original
// text — not which rule found it first. A token that two rules would both
// capture (say, a flag that also sits inside backticks) is asserted to
// appear once, at whichever of those positions comes first in the string.
// When two candidates start at the exact same offset (a rule-2 token whose
// stripped core begins exactly where a rule-4 quoted span's content begins),
// the four rules ARE applied in their stated order as the tiebreak, because
// that is the only remaining thing to break the tie with.

// Matches Task 9's firmware buffer: `char askChips[CHIP_MAX][CHIP_BYTES + 1]`
// (askOpts[4][34] already reserves one NUL past its 32-char cap; this mirrors
// that shape so the two fields do not need separate rules).
export const CHIP_MAX = 4;
export const CHIP_BYTES = 32;

// Spans: captured whole, including whatever punctuation lives inside them,
// because the point of a backtick or a quote is that the AUTHOR already
// delimited "this is one token" — splitting it further would throw that
// signal away.
const BACKTICK_RE = /`([^`]+)`/g;
const DQUOTE_RE = /"([^"]+)"/g;
const SQUOTE_RE = /'([^']+)'/g;

// Punctuation a SENTENCE wraps around a token with ("Use -f or --force?" —
// the `?` belongs to the sentence, not the flag). Deliberately excludes `-`
// and `/`: those are the two characters rules 2 and 3 key off, so stripping
// them would erase the very shape being matched.
const LEAD_STRIP = /^[`"'?,.;:!()[\]{}<>]+/;
const TRAIL_STRIP = /[`"'?,.;:!()[\]{}<>]+$/;

// `--force`, `--fqbn`, `-f`, `-sI` — a letter must follow the dash(es), which
// is what excludes a bare `--` (a shell's "end of flags" marker, not a flag
// itself: "npm test -- --watch" must not chip the lone `--`) and a bare `-`
// or `-1` (a negative number / stdin marker, not a flag).
const FLAG_RE = /^(?:--[A-Za-z][\w=-]*|-[A-Za-z][\w=-]*)$/;

// Rule 1 and rule 4: whole spans between a delimiter pair, captured with
// their start offset (the delimiter's own position — a constant, harmless
// offset from the content, since spans are never compared for position
// against another span at the exact same start).
function collectSpans(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) out.push({ value: m[1], pos: m.index });
  }
  return out;
}

// Rules 2 and 3: every whitespace-delimited token, its wrapping punctuation
// stripped, tested for the flag or path shape. `pos` is the offset of the
// STRIPPED core within the original text, not of the raw token — so a token
// like `,--force` (comma-glued) positions its chip at the `-`, not the comma.
function collectTokenMatches(text, testFn) {
  const out = [];
  const TOK_RE = /\S+/g;
  let m;
  while ((m = TOK_RE.exec(text))) {
    const raw = m[0];
    const lead = raw.match(LEAD_STRIP)?.[0].length ?? 0;
    const trail = raw.match(TRAIL_STRIP)?.[0].length ?? 0;
    const core = raw.slice(lead, raw.length - trail);
    if (core && testFn(core)) out.push({ value: core, pos: m.index + lead });
  }
  return out;
}

// Extract at most CHIP_MAX tappable tokens from `detail`, an ASK's detail
// text — a permission command, an AskUserQuestion body, a plan.
//
// MUST BE CALLED AFTER toAscii(), not before: `askChips(toAscii(detail), opts)`,
// never `toAscii(askChips(detail, opts))`. A chip capped at CHIP_BYTES before
// transliteration could have its byte count change under the cap — a
// multi-byte character transliterating to a shorter or longer ASCII run — so
// the cap would not be a byte cap at all. host/wire-bytes-check.mjs already
// enforces exactly this ordering for the voice path, composing
// `capUtf8(toAscii(text), ...)` so the transliteration is the innermost call;
// host/ask-chips-check.mjs asserts the same ordering for this module's own
// call sites, by the same shape.
//
// `opts` is the ask's existing option labels (e.g. `["Allow", "Deny"]`), if
// any. A chip that exactly (case-insensitively) restates a button already on
// the screen is redundant — the button already answers in one tap — so those
// are dropped rather than spent one of the four slots on a duplicate.
export function askChips(detail, opts = []) {
  const text = String(detail ?? "");
  const skip = new Set((opts ?? []).map((o) => String(o ?? "").trim().toLowerCase()));

  // Order of concatenation matters only as the tiebreak for two candidates
  // that start at the exact same position; the real ordering is the pos sort
  // just below.
  const candidates = [
    ...collectSpans(BACKTICK_RE, text),                       // rule 1
    ...collectTokenMatches(text, (t) => FLAG_RE.test(t)),      // rule 2
    ...collectTokenMatches(text, (t) => t.includes("/")),      // rule 3
    ...collectSpans(DQUOTE_RE, text),                          // rule 4
    ...collectSpans(SQUOTE_RE, text),                          // rule 4
  ];
  candidates.sort((a, b) => a.pos - b.pos);

  const seen = new Set();
  const chips = [];
  for (const { value } of candidates) {
    if (seen.has(value)) continue;
    seen.add(value);
    if (skip.has(value.toLowerCase())) continue;
    if (Buffer.byteLength(value, "utf8") > CHIP_BYTES) continue;
    chips.push(value);
    if (chips.length >= CHIP_MAX) break;
  }
  return chips;
}
