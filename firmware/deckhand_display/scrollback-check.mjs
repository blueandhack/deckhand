// Two halves, reported separately and deliberately:
//   MIRROR     - a JS re-implementation of the wrap and the line index. Proves the
//                ALGORITHM, including cases unreachable on hardware. It would keep
//                passing with scrollback.ino deleted, so it binds nothing.
//   STRUCTURAL - reads scrollback.ino as TEXT, comments stripped, each assertion
//                bound to a FUNCTION BODY rather than to the file. A rule that a
//                neighbouring line can satisfy is not a rule (the pairWindowOpen
//                hole: replacing that body with `return true` passed 70 assertions).
import fs from "node:fs";
import path from "node:path";
import { consts, stripComments, fnBody, DIR } from "./geom-common.mjs";

const SELFTEST = process.argv.includes("--selftest");
let mirror = 0, structural = 0, fail = 0;
const FAILED = [];
function chk(cond, msg, kind) {
  if (kind === "m") mirror++; else structural++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) { fail++; FAILED.push(msg); }
}
const m = (cond, msg) => chk(cond, msg, "m");
const s = (cond, msg) => chk(cond, msg, "s");

// consts() takes a file BASENAME - it joins DIR itself - not a path already
// joined to it.
const c = consts("board_es3c35p.h");
// stripComments() takes a file NAME relative to DIR and reads it ITSELF - it is
// not a filter over content already in hand.
let INO = stripComments("scrollback.ino");
const SKETCH = stripComments("deckhand_display.ino");

// fnBody() THROWS when a signature is missing - deliberately, so an assertion can
// never run over an empty string and pass vacuously. But a SELFTEST that deletes
// code must fail BY NAME rather than crash the checker, so the throw is caught
// here, recorded as a named failure, and "" returned: the content assertions
// downstream then fail loudly too, which is several named failures and no crash.
function body(src, sig, where) {
  try {
    const b = fnBody(src, sig, where);
    if (!b.trim()) { chk(false, `structural: ${sig} has a non-empty body`, "s"); return null; }
    return b;
  } catch { chk(false, `structural: ${sig} is findable in ${where}`, "s"); return null; }
}

// EVERY NEGATIVE ASSERTION GOES THROUGH THIS, because `!/x/.test("")` is TRUE:
// a missing function would otherwise PASS the three "must not contain" checks
// while only the findability check failed. A vacuous pass standing beside a real
// failure is still a vacuous pass, and it is the exact trap geom-common's own
// comment on fnBody's throw exists to prevent.
const absent = (b, re, msg) => s(b !== null && !re.test(b), msg);
const present = (b, re, msg) => s(b !== null && re.test(b), msg);

if (SELFTEST) {
  const fault = process.env.SB_FAULT || "wrap-cap";
  if (fault === "wrap-cap") INO = INO.replace(/while \(t\[pos\]\)/, "while (t[pos] && lines < 80)");
  if (fault === "no-reap") INO = INO.replace(/reapBleLinks\(true\);/g, "");
  if (fault === "no-activity") INO = INO.replace(/lastActivityMillis = millis\(\);/g, "");
  if (fault === "seq-append") INO = INO.replace(/scrollReset\(\);\s*scrollFetchFailed = true;/, "");
  if (fault === "wide-marker") INO = INO.replace(/"\$"/, '"·"');
}

// ---------------- MIRROR: the wrap rule and the line index ----------------
// Mirrors scrollLineLen: monospace, so wrapping is exact integer arithmetic and
// needs no width call at all. Same rule as the shared wrapLineLen - hard '\n',
// word-friendly break at the last space in the lane's second half, never stall.
function lineLen(t, pos, cols) {
  let i = 0;
  while (i < cols && pos + i < t.length && t[pos + i] !== "\n") i++;
  if (t[pos + i] === "\n") return [i, true];
  if (pos + i >= t.length) return [i, false];
  for (let b = i; b > Math.floor(cols / 2); b--)
    if (t[pos + b - 1] === " ") return [b, false];
  return [i, false];
}
function wrapLines(t, cols) {
  if (!t.length) return 1;
  let pos = 0, lines = 0;
  while (pos < t.length) {
    const [n, hard] = lineLen(t, pos, cols);
    pos += n;
    if (hard && t[pos] === "\n") pos++;
    lines++;
    if (n === 0 && !hard) break;
  }
  return lines || 1;
}
const COLS = c.SCROLL_COLS;
m(wrapLines("", COLS) === 1, "mirror: an empty entry still occupies one line");
m(wrapLines("hi", COLS) === 1, "mirror: a short entry is one line");
m(wrapLines("x".repeat(COLS), COLS) === 1, "mirror: exactly COLS characters is one line");
m(wrapLines("x".repeat(COLS + 1), COLS) === 2, "mirror: COLS+1 is two lines");
m(wrapLines("a\nb", COLS) === 2, "mirror: a hard break makes two lines");
m(wrapLines("a\n\nb", COLS) === 3, "mirror: a blank line counts as a line");
// THE 80-LINE CAP IS THE WHOLE REASON THIS DOES NOT REUSE countWrappedLines:
// that helper stops at 80 and its wrapLineLen carries a char buf[64] capped at
// 60 characters, so a 4000-byte entry cannot pass through it at all.
const big = "word ".repeat(800).trim();               // 4000 chars
m(wrapLines(big, COLS) > 80, `mirror: a 4000-char entry wraps past 80 lines (${wrapLines(big, COLS)})`);
m(wrapLines("aaaa bb", 6)[0] === undefined, "mirror: the wrap returns a number, not a tuple");
// A word longer than the lane must still advance, or the fetch spins forever.
m(wrapLines("x".repeat(200), 10) === 20, "mirror: an unbreakable word breaks at the lane and never stalls");

// The index: lineFirst accumulates lines PLUS the spacer, and a result tucks
// against its own call with no spacer - the pair reads as one unit.
function buildIndex(entries, cols) {
  const idx = [];
  for (let i = 0; i < entries.length; i++) {
    const e = { role: entries[i].r, lines: wrapLines(entries[i].t, cols), spacer: 0 };
    if (i === 0) e.lineFirst = 0;
    else {
      const p = idx[i - 1];
      p.spacer = (p.role === 2 && e.role === 3) ? 0 : 1;
      e.lineFirst = p.lineFirst + p.lines + p.spacer;
    }
    idx.push(e);
  }
  return idx;
}
function entryAtLine(idx, line) {
  let lo = 0, hi = idx.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx[mid].lineFirst <= line) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
const EV = [{ r: 0, t: "one" }, { r: 2, t: "ran" }, { r: 3, t: "out" }, { r: 1, t: "two" }];
const IX = buildIndex(EV, COLS);
m(IX[0].spacer === 1, "mirror: an ordinary entry is followed by a blank line");
m(IX[1].spacer === 0, "mirror: a result tucks against its own call with no spacer");
m(IX[2].spacer === 1, "mirror: the entry after a result gets its blank back");
m(IX[3].spacer === 0, "mirror: the last entry has no trailing blank");
m(IX.map(e => e.lineFirst).join(",") === "0,2,3,5", "mirror: lineFirst accumulates lines plus spacers");
// EXHAUSTIVE over every reachable line, because the binary search is the one
// thing a frame calls every time and an off-by-one there shows as text jumping.
const totalLines = IX[IX.length - 1].lineFirst + IX[IX.length - 1].lines;
let bad = null;
for (let L = 0; L < totalLines; L++) {
  const i = entryAtLine(IX, L);
  const inRange = L >= IX[i].lineFirst && L < IX[i].lineFirst + IX[i].lines + IX[i].spacer;
  if (!inRange && bad === null) bad = L;
}
m(bad === null, `mirror: the binary search lands in range for every line${bad === null ? "" : ` (first bad: ${bad})`}`);

// ---------------- STRUCTURAL: bound to scrollback.ino's own function bodies ----------------
const wrapBody = body(INO, "int scrollWrapLines(const char* t, int cols)", "scrollback.ino");
absent(wrapBody, /\b80\b/,
  "structural: scrollWrapLines carries NO line cap - a 4000-byte entry is 118 lines");
absent(wrapBody, /countWrappedLines|wrapLineLen/,
  "structural: scrollWrapLines does not reuse the 80-line-capped shared helpers");
absent(wrapBody, /textWidth/,
  "structural: the wrap is integer arithmetic, not a per-character width call");

const appendBody = body(INO, "bool scrollAppend(uint8_t role, const char* t)", "scrollback.ino");
present(appendBody, /SCROLL_TEXT_BYTES/,
  "structural: scrollAppend bounds itself against SCROLL_TEXT_BYTES");
present(appendBody, /SCROLL_MAX_ENTRIES/,
  "structural: scrollAppend bounds itself against SCROLL_MAX_ENTRIES");
present(appendBody, /p\.role == 2 && role == 3/,
  "structural: the result-after-ran spacer rule is in scrollAppend, by operand");

// The whole feature must be inside ONE #if, so board 1 never sees the TEXT of it.
s(/^\s*#if BOARD_HISTORY_SCROLL/m.test(INO), "structural: scrollback.ino opens with #if BOARD_HISTORY_SCROLL");
const guards = (INO.match(/#if BOARD_HISTORY_SCROLL/g) || []).length;
s(guards === 1, `structural: exactly ONE guard opens the file, not per-function (${guards})`);

// A #define, never a const int: #if on a C++ const int is silently false.
for (const h of ["board_es3c35p.h", "board_e32r28t.h"]) {
  const raw = fs.readFileSync(path.join(DIR, h), "utf8");
  s(/#define BOARD_HISTORY_SCROLL [01]/.test(raw),
    `structural: ${h} declares BOARD_HISTORY_SCROLL as a #define`);
  s(!/const int BOARD_HISTORY_SCROLL/.test(raw),
    `structural: ${h} does NOT declare it as a const int`);
}

// Every gutter marker is ASCII. Spleen declares 0x20..0x7E; anything else draws
// nothing AND advances nothing, the trap this repo has paid for repeatedly.
const markBody = body(INO, "const char* scrollMark(uint8_t r)", "scrollback.ino");
s(markBody !== null, "structural: scrollMark is findable");
if (markBody) {
  const lits = [...markBody.matchAll(/"([^"]*)"/g)].map(x => x[1]);
  s(lits.length >= 5, `structural: scrollMark returns at least five markers (${lits.length})`);
  const wide = lits.filter(l => [...l].some(ch => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) > 0x7e));
  s(wide.length === 0,
    `structural: every gutter marker is ASCII 0x20..0x7E${wide.length ? ` - offending: ${JSON.stringify(wide)}` : ""}`);
  s(new Set(lits).size === lits.length, "structural: the markers are distinct shapes, one per role");
}

console.log(`\n${mirror} mirror + ${structural} structural assertions, ${fail} failures`);
if (SELFTEST) {
  const WANT = {
    "wrap-cap":    /scrollWrapLines carries NO line cap/,
    "wide-marker": /every gutter marker is ASCII/,
  }[process.env.SB_FAULT || "wrap-cap"];
  const hit = FAILED.find(x => WANT.test(x));
  if (!hit) { console.log(`SELFTEST FAILED: fault ${process.env.SB_FAULT || "wrap-cap"} was not caught`); process.exit(1); }
  console.log(`selftest ok - caught by: ${hit}`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all scrollback store assertions pass");
