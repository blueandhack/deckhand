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
import { consts, deadGuards, stripComments, fnBody, DIR } from "./geom-common.mjs";

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
// `let`, not `const`: the SELFTEST block's `seq-append` fault has to mutate the
// SKETCH text (the hist parser's chunk arm lives in deckhand_display.ino, not
// scrollback.ino), which is exactly what the pre-existing fault line here failed
// to do - see the note at that line.
let SKETCH = stripComments("deckhand_display.ino");

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
  if (fault === "wrap-cap") INO = INO.replace(/while \(t\[pos\]\) \{/, "while (t[pos] && drawn < 80) {");
  if (fault === "no-reap") INO = INO.replace(/reapBleLinks\(true\);/g, "");
  if (fault === "no-activity") INO = INO.replace(/lastActivityMillis = millis\(\);/g, "");
  // FIXED IN TASK 3: this line was added in Task 2, forward-provisioned for an
  // assertion that did not exist yet, and it targeted the wrong file. The
  // discontinuity handler lands in deckhand_display.ino's hist parser (Task 3
  // Step 6), not in scrollback.ino - so `INO.replace(...)` against that literal
  // pair silently matched nothing (scrollback.ino never contains
  // "scrollReset();scrollFetchFailed = true;" adjacent), and the fault was a
  // no-op. It now empties the discontinuity `if` block's own body in SKETCH,
  // which is what the seq-append name actually describes: on a gap, nothing
  // resets, nothing is flagged, and the parser falls through to append into
  // the hole instead of abandoning the fetch.
  if (fault === "seq-append")
    SKETCH = SKETCH.replace(/if \(seq != scrollNextSeq\) \{[\s\S]*?\n      \}/, "if (seq != scrollNextSeq) {\n      }");
  if (fault === "wide-marker") INO = INO.replace(/"\$"/, '"·"');
}

// ---------------- MIRROR: the wrap rule and the line index ----------------
// MIRRORS scrollWalk, WHICH IS FENCE-AWARE. The firmware wraps prose and code by
// different rules and MUST: prose takes a word-friendly break, code takes a HARD
// break at the column, because breaking a program at spaces destroys the
// indentation you read it by. A ``` fence toggles the mode and draws no row.
// The mirror was stale for one commit - it still modelled word-wrap only, i.e. a
// rule the firmware had stopped using - which is exactly the weakness this file
// already records for a mirror: it proves the ALGORITHM and binds nothing, so it
// can agree with itself while the device does something else.
function walk(t, cols) {
  const rows = [];                       // {text, code, cont, head}
  if (!t.length) return [{ text: "", code: false, cont: false, head: false }];
  let pos = 0, inCode = false;
  while (pos < t.length) {
    let eol = pos;
    while (eol < t.length && t[eol] !== "\n") eol++;
    const srcLen = eol - pos;
    if (srcLen >= 3 && t.slice(pos, pos + 3) === "```") {
      inCode = !inCode;
      pos = eol < t.length ? eol + 1 : eol;
      continue;
    }
    const head = !inCode && srcLen > 0 && t[pos] === "#";
    let off = 0;
    if (head) {
      while (off < srcLen && t[pos + off] === "#") off++;
      while (off < srcLen && t[pos + off] === " ") off++;
    }
    let q = pos + off, rem = srcLen - off, first = true;
    do {
      let n;
      if (rem <= cols) n = rem;
      else if (inCode) n = cols;
      else {
        n = cols;
        let b = n;
        while (b > Math.floor(cols / 2) && t[q + b - 1] !== " ") b--;
        if (b > Math.floor(cols / 2)) n = b;
      }
      if (n <= 0 && rem > 0) n = 1;
      rows.push({ text: t.slice(q, q + n), code: inCode, cont: !first, head });
      q += n; rem -= n; first = false;
      if (!inCode) while (rem > 0 && t[q] === " ") { q++; rem--; }
    } while (rem > 0);
    pos = eol < t.length ? eol + 1 : eol;
  }
  return rows.length ? rows : [{ text: "", code: false, cont: false, head: false }];
}
const wrapLines = (t, cols) => walk(t, cols).length;

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

m(walk("```\nabc\n```", COLS).length === 1, "mirror: a fence draws no row of its own");
m(walk("```\nabc\n```", COLS)[0].code === true, "mirror: a line inside a fence is code");
m(walk("## Title", COLS)[0].head === true, "mirror: a leading # marks a heading");
m(walk("## Title", COLS)[0].text === "Title", "mirror: the heading's markers are stripped");
{
  // code HARD-wraps: the first row is exactly COLS characters even though the
  // text has spaces to break on, which is the whole difference from prose.
  const codeRow = walk("```\n" + "a".repeat(5) + " " + "b".repeat(COLS) + "\n```", COLS);
  m(codeRow[0].text.length === COLS, "mirror: code hard-wraps at the column, ignoring spaces");
  m(codeRow[1].cont === true, "mirror: a wrapped code row is marked as a continuation");
  // The space must sit in the lane's SECOND HALF: wrapLineLen only searches back
  // as far as cols/2 and otherwise hard-breaks, so a space at column 5 is
  // correctly ignored. My first version of this test put it there and the
  // assertion failed - the test was wrong, not the wrap.
  const proseRow = walk("a".repeat(COLS - 6) + " " + "b".repeat(COLS), COLS);
  m(proseRow[0].text.length === COLS - 5,
    `mirror: prose breaks at a space in the lane's second half (${proseRow[0].text.length})`);
  const proseHard = walk("a".repeat(5) + " " + "b".repeat(COLS), COLS);
  m(proseHard[0].text.length === COLS,
    "mirror: prose hard-breaks when the only space is before cols/2 - never stalls");
}

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
// BOUND TO scrollWalk, NOT scrollWrapLines. The wrap moved into a shared walker
// and scrollWrapLines became a one-line delegate - so these three assertions
// were briefly VACUOUS, guarding a body with no loop in it, and the wrap-cap
// selftest went BLIND at the same moment. The rule they exist for lives wherever
// the loop is.
const wrapBody = body(INO, "static int scrollWalk(const char* t, int cols, int want,", "scrollback.ino");
// And ONE rule, not two: the counter must delegate to the same walker the
// renderer drives, or the index says one thing and the screen draws another.
const wlBody = body(INO, "int scrollWrapLines(const char* t, int cols)", "scrollback.ino");
present(wlBody, /scrollWalk\(/,
  "structural: scrollWrapLines delegates to the walker rather than wrapping itself");
const laBody = body(INO, "bool scrollLineAt(const char* t, int cols, int want, char* out, int outSize, uint8_t* flags)", "scrollback.ino");
present(laBody, /scrollWalk\(/,
  "structural: scrollLineAt drives the SAME walker, so both agree by construction");
// The walker must be fence-aware, or code and prose wrap by one rule and the
// hard break that keeps indentation readable is gone.
present(wrapBody, /inCode/,
  "structural: the walker tracks fenced code, so code hard-wraps and prose does not");
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

// ---------------- STRUCTURAL: the wire (Task 3) ----------------

// THE CHUNK BUDGET IS ASSERTED AGAINST feedChar's GUARD, PARSED - not transcribed.
// That guard does not DROP an over-long line, it CLEARS THE BUFFER mid-line, so
// the remainder accumulates into an emptied buffer, the parse fails, and every
// tick carrying it is lost while both links look healthy.
// ANCHORED on `buf = ""`, not merely on `buf.length() >`: the sketch has an
// earlier, unrelated `buf.length() > 11 ? buf.substring(11) : ...` (the command
// dispatcher), and a bare `buf.length()\s*>\s*(\d+)` match finds THAT one first
// and captures 11 - which would compare SCROLL_WIRE_CHUNK_BYTES against 11
// instead of 16000. Only the real guard clears the buffer.
const gm = SKETCH.match(/buf\.length\(\)\s*>=?\s*(\d+)\)\s*buf\s*=\s*""/);
s(gm != null, "structural: feedChar's line guard is still findable in the sketch");
if (gm) {
  s(c.SCROLL_WIRE_CHUNK_BYTES < +gm[1],
    `structural: the chunk budget (${c.SCROLL_WIRE_CHUNK_BYTES}) is under feedChar's guard (${gm[1]})`);
  // One entry must always fit ALONE: 4000 chars of pure newlines escape to 8000.
  const worst = 2 * 4000 + 400;
  s(worst <= c.SCROLL_WIRE_CHUNK_BYTES,
    `structural: a worst-case single entry (${worst}B fully escaped) fits one chunk`);
}

// THE RX RING IS A SECOND, LOWER CEILING THAN feedChar's LINE GUARD, and nothing
// asserted it until a chunk over ~4KB was measured producing ZERO device-side
// output - a silent JSON parse failure, twice. `Serial.setRxBufferSize()` is
// SHARED, UNGUARDED code sized for board 1's audio flow control, and its own
// comment records that an overflowing ring DISCARDS bytes. So the budget is
// bounded by the SMALLER of the two, and the ring is parsed rather than
// transcribed because raising it is a shared-code change someone might make.
// The BOARD 2 arm specifically: the sketch now has two calls, and matching the
// first would compare the budget against board 1's 4096 and fail for the wrong
// reason. Anchored on the guard so a future reorder cannot silently pick the
// other arm.
const rxArm = SKETCH.match(/#if BOARD_HISTORY_SCROLL\s*\n\s*Serial\.setRxBufferSize\((\d+)\)/);
const rx = rxArm;
s(rx != null, "structural: the shared Serial RX buffer size is still findable");
if (rx) s(c.SCROLL_WIRE_CHUNK_BYTES < +rx[1],
  `structural: the chunk budget (${c.SCROLL_WIRE_CHUNK_BYTES}) fits the shared RX ring (${rx[1]})`);

// The HOST measures the budget on the SERIALISED line, never on raw text length.
let HOSTSRC = stripComments("../../host/index.mjs");
if (SELFTEST) {
  const hf = process.env.SB_FAULT || "";
  // The multi-device shape of the fault: the parameter list moved. The parse
  // still SUCCEEDS, so the run must report that one fact and nothing else.
  if (hf === "host-sig")
    HOSTSRC = HOSTSRC.replace(/async function sendScrollback\([^)]*\)/, "async function sendScrollback(req)");
  // And the harder half: the function is gone entirely. Before this, that was
  // six failures; it must now be ONE, and it must be the parse that names it.
  if (hf === "host-nosig")
    HOSTSRC = HOSTSRC.replace(/async function sendScrollback\(/, "async function sendScrollbackRenamed(");
  // THE ACK GATE, disabled two ways. Both leave `waitForScrollAck` spelled out in
  // the body, which is all the old assertion ever asked for - and the host then
  // writes every chunk back to back, overflowing the device's RX ring on BLE.
  if (hf === "host-noack")
    HOSTSRC = HOSTSRC.replace(/if \(i \+ 1 < groups\.length\) \{/, "if (false && i + 1 < groups.length) {");
  // The quieter one: the ACK is still awaited, and its answer is thrown away.
  if (hf === "host-dropack")
    HOSTSRC = HOSTSRC.replace(/const\s+(\w+)\s*=\s*(await waitForScrollAck\()/, "$2");
}

// A CHECKER MUST PARSE THE CONSTANT IT CERTIFIES, NEVER TRANSCRIBE IT - and this
// file broke that rule for one commit, in the way the rule exists to prevent. The
// signature was written out here as `(id, filter, maxBytes)`; the multi-device
// work gave sendScrollback a fourth `link` parameter (a reply must go back to the
// board that ASKED, not to "the USB port"); indexOf() then found nothing, body()
// reported ONE honest "is findable" failure - and the five content assertions
// underneath it, which take a null body, each reported a SECOND failure of their
// own. Six red lines, five of them describing behaviour that was entirely intact,
// none of them naming the actual event: the host's signature moved.
//
// So the signature is now PARSED out of index.mjs. `sendScrollback\(` cannot match
// `sendScrollbackSince(`, which is the neighbouring function and appears FIRST in
// the file. The parse is asserted BY NAME before anything reads a body, and every
// assertion that depends on it is gated on it - because the mirror image of
// `!/re/.test("")` passing vacuously is a parse failure cascading into five
// unrelated-looking ones, and both hide the thing that actually happened.
const sbSigM = /async function sendScrollback\(([^)]*)\)/.exec(HOSTSRC);
s(sbSigM != null,
  "structural: sendScrollback's signature is PARSED out of host/index.mjs, not transcribed - " +
  "a transcribed one goes stale on the next parameter and takes five healthy assertions with it");
const sbBody = sbSigM ? body(HOSTSRC, sbSigM[0], "host/index.mjs") : null;
if (sbSigM)
  s(/\bid\b/.test(sbSigM[1]) && /\bfilter\b/.test(sbSigM[1]),
    `structural: sendScrollback still takes the request it is named for (parsed "${sbSigM[1]}")`);
// THE BLE BUDGET IS A SEPARATE, MUCH SMALLER NUMBER, and the reason is not a
// buffer: nothing flow-controls the radio, so a chunk is a BURST the device must
// survive. 800 is the size of the ordinary tick payload, which crosses this link
// every 5s reliably. Asserted to be well under the USB budget so a future edit
// cannot quietly raise it back to a size that gets dropped.
const bleChunk = HOSTSRC.match(/const SCROLL_WIRE_CHUNK_BLE_BYTES = (\d+);/);
s(bleChunk != null, "structural: the host's BLE chunk budget is still findable");
if (bleChunk) {
  s(+bleChunk[1] === c.SCROLL_WIRE_CHUNK_BLE_BYTES,
    "structural: the host's BLE chunk budget equals the board header's");
  // THE REAL BOUND IS NOT A MAGIC SIZE - IT IS THAT A BIG CHUNK NEEDS PACING.
  // Bisected on hardware: unpaced, ~850 bytes never arrived and ~316 did, so
  // anything past ~400 is outside what CoreBluetooth's un-flow-controlled queue
  // absorbs in one burst. A larger chunk is fine, but ONLY paced - so the
  // assertion ties the two together rather than capping the size on its own,
  // which is what an earlier `<= 1000` did and it simply went stale when the
  // measurement said 1500 was reachable.
  const pace = HOSTSRC.match(/const BLE_SCROLL_PACE_MS = (\d+);/);
  s(pace != null, "structural: the BLE pacing gap is still findable");
  if (pace) s(c.SCROLL_WIRE_CHUNK_BLE_BYTES <= 400 || +pace[1] > 0,
    `structural: a BLE chunk over the unpaced-safe size (${c.SCROLL_WIRE_CHUNK_BLE_BYTES}) is PACED (${pace[1]}ms)`);
  s(c.SCROLL_WIRE_CHUNK_BLE_BYTES < c.SCROLL_WIRE_CHUNK_BYTES,
    "structural: the BLE chunk is smaller than the USB one");
}
// A BLE fetch must therefore be MULTI-chunk, or the ACK handshake - which only
// runs between chunks - never engages and there is no flow control at all. That
// is exactly how the first version failed: 8192 bytes fitted ONE 12000-byte
// chunk, so nothing was acked and 377 packets went out in a burst.
s(c.SCROLL_TAIL_BYTES_BLE > c.SCROLL_WIRE_CHUNK_BLE_BYTES,
  "structural: a BLE tail spans several chunks, so the ACK handshake engages");

// The host mirrors the constant; a drift means the host builds chunks the device
// cannot receive, which is exactly the failure above with nothing logging it.
const hostChunk = HOSTSRC.match(/const SCROLL_WIRE_CHUNK_BYTES = (\d+);/);
s(hostChunk != null, "structural: the host's chunk budget is still findable");
if (hostChunk) s(+hostChunk[1] === c.SCROLL_WIRE_CHUNK_BYTES,
  "structural: the host's chunk budget equals the board header's");

// The handshake itself: the host must WAIT rather than writing back to back.
// Reads the SAME body the parse above produced: a second body() call over a
// second transcribed signature was how one stale literal produced two failures.
if (sbSigM) present(sbBody, /waitForScrollAck/,
  "structural: the host awaits a per-chunk ACK instead of writing back to back");
// present() IS A TEXT MATCH, and a reviewer measured what that leaves open:
// `if (false && i + 1 < groups.length)` around the await leaves it satisfied while
// the host writes every chunk back to back with no flow control at all - which
// overflows the device's RX ring on BLE, the exact failure the handshake was added
// for. Comments are already stripped from HOSTSRC; a literal dead-code guard is the
// other way to disable a line while leaving it spelled out, and this function has
// none today.
if (sbSigM) {
  const dg = deadGuards(sbBody || "");
  s(dg.length === 0,
    dg.length ? `structural: sendScrollback carries a dead-code guard [${dg.join(", ")}] - ` +
                `the ACK it disables is still spelled out above it`
              : "structural: sendScrollback carries no dead-code guard, so the lines it " +
                "contains are the lines it runs");
  // ...and the ACK's ANSWER is acted on. Awaiting a result nobody reads is the same
  // burst by a quieter route: the timeout must ABANDON the fetch, so the device's
  // own SCROLL_FETCH_TIMEOUT names it on the glass rather than a silent short read.
  const ackVar = /const\s+(\w+)\s*=\s*await\s+waitForScrollAck\(/.exec(sbBody || "");
  s(ackVar != null,
    "structural: the per-chunk ACK's result is bound to a name, not awaited and dropped");
  s(ackVar != null &&
    new RegExp(`if\\s*\\(\\s*!${ackVar[1]}\\s*\\)[\\s\\S]{0,240}?\\breturn\\b`).test(sbBody || ""),
    "structural: and a missing ACK RETURNS out of the fetch rather than pressing on into " +
    "a ring the host already knows is full");
}
s(/line\.startsWith\("SCROLLACK "\)/.test(HOSTSRC),
  "structural: the host resolves the device's SCROLLACK");
s(/SCROLLACK %d/.test(SKETCH),
  "structural: the device sends SCROLLACK for each chunk it drains");

if (sbSigM) {
  present(sbBody, /JSON\.stringify/, "structural: the host builds the chunk envelope with JSON.stringify");
  present(sbBody, /byteLength/,
    "structural: the host measures the chunk on the SERIALISED line, in BYTES");
  present(sbBody, /SCROLL_WIRE_CHUNK_BYTES|CHUNK_BYTES/,
    "structural: the host bounds each chunk by the named budget");
}

// A seq discontinuity CLEARS rather than assembling a transcript with a hole.
// 1700, not 1400: the real block (comments stripped) runs to ~1530 chars - the
// discontinuity branch, the item loop and the completion tail all sit inside
// it, and 1400 cut the match off before reaching the arm's own closing brace.
// BRACE-MATCHED, not length-capped. The first version matched up to 1400 chars,
// was raised to 1700 when the real block outgrew it, and broke AGAIN the moment
// the SCROLLACK handshake was added - a cap on a block that is expected to grow
// is a guard that fails for the wrong reason, and it reported "the chunk arm is
// not findable" when the arm was right there.
function braceBlock(src, openSig) {
  const a = src.indexOf(openSig);
  if (a < 0) return null;
  let i = src.indexOf("{", a), depth = 0;
  if (i < 0) return null;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(a, j + 1); }
  }
  return null;
}
const parseArmSrc = braceBlock(SKETCH, 'if (!hist["seq"].isNull())');
const parseArm = parseArmSrc ? [parseArmSrc] : null;
s(parseArm != null, "structural: the chunk arm of the hist parser is findable");
const parseArmBody = parseArm ? parseArm[0] : null;
present(parseArmBody, /scrollReset\(\)/,
  "structural: a seq discontinuity clears the arena (scrollReset)");
present(parseArmBody, /scrollFetchFailed/,
  "structural: a seq discontinuity flags scrollFetchFailed rather than appending into a hole");
present(parseArmBody, /seq != scrollNextSeq/,
  "structural: the discontinuity is tested on seq against the expected next, by operand");

// The request picks its budget by TRANSPORT - BLE cannot have the whole thing.
const reqBody = body(INO, "void requestScrollback(int idx)", "scrollback.ino");
present(reqBody, /usbLinkActive\(\)/, "structural: the fetch budget is chosen by transport, not fixed");
present(reqBody, /SCROLL_TAIL_BYTES_USB/, "structural: the USB tail budget is a named constant");
present(reqBody, /SCROLL_TAIL_BYTES_BLE/, "structural: the BLE tail budget is a named constant");

// ---------------- STRUCTURAL: touch (Task 5) ----------------

// THE SCROLLBACK MUST NOT HIT-TEST OR CLEAR AGAINST THE PAGED READER'S HEADER.
// Its own header is SCROLL_HDR_H (42) where HIST_RULE_Y is 54 and
// HIST_CHIP_TAP_H is 52, and pointing at the wrong one is silent: a tap band
// 10px too tall makes the top of the body dead for dragging, and a clear
// anchored 12px too low leaves a strip holding the previous screen. Both
// happened, in the same change, along with the bottom clip - so the rule is now
// that these two constants appear NOWHERE in the drag loop or the draw paths.
for (const [fn, sig] of [["scrollDrawBody", "void scrollDrawBody()"],
                         ["scrollDrawBand", "void scrollDrawBand(int shift)"],
                         ["handleScrollTouch", "bool handleScrollTouch(int sx, int sy)"]]) {
  const b = body(INO, sig, "scrollback.ino");
  absent(b, /HIST_RULE_Y|HIST_CHIP_TAP_H/,
    `structural: ${fn} bounds itself on SCROLL_*, not the paged reader's header`);
}
// And every drawn line must fit WHOLLY inside the body, or its descenders paint
// into the bottom air that nothing clears.
for (const [fn, sig] of [["scrollDrawBody", "void scrollDrawBody()"],
                         ["scrollDrawBand", "void scrollDrawBand(int shift)"]]) {
  const b = body(INO, sig, "scrollback.ino");
  present(b, /y \+ CODE_LINE_H > SCROLL_BOT/,
    `structural: ${fn} clips the bottom edge, not just the top`);
  present(b, /y < SCROLL_TOP/, `structural: ${fn} clips the top edge`);
}

// THE LIVE TAIL'S POLICY, bound because its HELD branch has never executed on
// hardware: new chat entries only appear when a turn completes, so every
// observed append so far was the FOLLOWING case. These assertions are what
// stands in for that, and each names the property rather than the code shape.
const tailArm = braceBlock(SKETCH, 'if (!hist["app"].isNull())');
s(tailArm != null, "structural: the live tail's append arm is findable");
if (tailArm) {
  // Captured BEFORE the append, or "was I at the bottom" is unanswerable: the
  // append changes scrollMaxY(), so testing afterwards always reads false.
  const i = tailArm.indexOf("scrollAtBottom()"), j = tailArm.indexOf("scrollAppend(");
  s(i >= 0 && j >= 0 && i < j,
    "structural: the tail decides at-bottom BEFORE appending, not after");
  s(/if \(wasAtBottom\)/.test(tailArm),
    "structural: the tail follows only when it was at the bottom, by operand");
  s(/scrollNewBelow \+= added/.test(tailArm),
    "structural: held away from the bottom, the tail COUNTS instead of moving");
  absent(tailArm, /scrollReset\(\)/,
    "structural: an append never resets the store the reader is looking at");
  absent(tailArm, /scrollNextSeq/,
    "structural: an append does not touch the chunked fetch's sequence state");
}
// ONE spelling of "at the bottom", read by the follow rule AND the badge - two
// spellings could disagree and show "3 new below" while sitting on them.
const abBody = body(INO, "bool scrollAtBottom()", "scrollback.ino");
present(abBody, /SCROLL_AT_BOTTOM_PX/,
  "structural: at-bottom uses a named tolerance, not equality with maxY");
const bodyFn = body(INO, "void scrollDrawBody()", "scrollback.ino");
present(bodyFn, /scrollNewBelow > 0 && !scrollAtBottom\(\)/,
  "structural: the new-below badge reads the same predicate the follow rule does");

// THE DRAG LOOP'S OBLIGATIONS. It blocks loop(), the pattern micMonitor,
// micStream and runCalibration already use - so it inherits their duties, and
// each has a named failure if it is missing.
const dragBody = fnBody(INO, "void scrollDragLoop(int sy0)", "scrollback.ino");
s(dragBody !== null, "structural: scrollDragLoop is findable");
s(/reapBleLinks\(true\)/.test(dragBody),
  "structural: the drag loop reaps BLE links - drainBleRx only runs from loop()");
s(/lastActivityMillis = millis\(\)/.test(dragBody),
  "structural: the drag loop refreshes lastActivityMillis, or the backlight blanks mid-drag");
s(/getTouchPoint/.test(dragBody),
  "structural: the drag loop polls getTouchPoint rather than touchPressed alone");

// ONE predicate for "is this a tap", read by the loop and by the hit test - the
// classic defect here is a control drawn under one condition and hit-tested under
// another, so a second spelling is forbidden rather than merely avoided.
const touchBody = fnBody(INO, "bool handleScrollTouch(int sx, int sy)", "scrollback.ino");
s(touchBody !== null, "structural: handleScrollTouch is findable");
s(/SCROLL_TAP_SLOP_PX/.test(dragBody || ""),
  "structural: the tap/drag threshold is the named constant, in the loop that measures it");
// BOUND TO dragBody, NOT touchBody - a tap cannot be told from a drag until
// release, so the rail-zone decision has to be made post-release with the
// coordinates the PRESS carried (scrollTapX, sy0), inside the loop that
// already owns that logic. Binding this to handleScrollTouch's own body
// would be checking the wrong function for a constant that cannot correctly
// live there: handleScrollTouch only ever sees the touch that STARTED the
// drag, never whether it turned into one.
s(/SCROLL_RAIL_TAP_X/.test(dragBody),
  "structural: the rail's tap zone is the named constant");

// Closing must restore the surface underneath, and clear the PSRAM.
const exitBody = fnBody(INO, "void exitScrollback()", "scrollback.ino");
s(/scrollEnd\(\)/.test(exitBody),
  "structural: exiting frees the PSRAM store rather than holding 304KB forever");
s(/scrollActive = false/.test(exitBody),
  "structural: exiting clears scrollActive");

console.log(`\n${mirror} mirror + ${structural} structural assertions, ${fail} failures`);
if (SELFTEST) {
  const WANT = {
    "wrap-cap":    /scrollWrapLines carries NO line cap/,
    "wide-marker": /every gutter marker is ASCII/,
    "seq-append":  /flags scrollFetchFailed rather than appending into a hole/,
    "no-reap":     /the drag loop reaps BLE links/,
    "no-activity": /the drag loop refreshes lastActivityMillis/,
    // The rule this file broke: a TRANSCRIBED signature. The fault renames
    // sendScrollback's parameters the way the multi-device work added `link`,
    // and the run must report exactly that - a PARSE failure, by name - rather
    // than six red lines about an ACK handshake that never moved.
    "host-sig":    /still takes the request it is named for/,
    "host-nosig":  /signature is PARSED out of host\/index\.mjs/,
    "host-noack":   /carries a dead-code guard/,
    "host-dropack": /result is bound to a name, not awaited and dropped/,
  }[process.env.SB_FAULT || "wrap-cap"];
  const hit = FAILED.find(x => WANT.test(x));
  if (!hit) { console.log(`SELFTEST FAILED: fault ${process.env.SB_FAULT || "wrap-cap"} was not caught`); process.exit(1); }
  console.log(`selftest ok - caught by: ${hit}`);
  process.exit(0);
}
if (fail) process.exit(1);
console.log("all scrollback store assertions pass");
