// DEVICE-COMMAND INVENTORY CHECKER - runs on the Mac, needs no hardware.
//
//   node commands-check.mjs             check both boards
//   node commands-check.mjs --selftest  prove it has teeth
//
// WHY THIS EXISTS, AND WHY IT IS ITS OWN FILE. CLAUDE.md states the rule: "Every
// refusal must NAME ITS CAUSE: from the Mac, silence and 'impossible here' look
// identical." Board 1 broke it wholesale and nothing noticed for the whole length
// of the board-2 port, because roughly twenty verbs sit inside
// `#if !BOARD_USES_TFT_ESPI` (or behind a capability flag) and on board 1 the line
// fell through the entire if/else-if chain into the JSON-payload branch, which
// discards it in silence. Measured with both boards attached: one `TEMP` produced
// four lines from board 2 and NOTHING from board 1.
//
// It is a NEW checker rather than an extension of an existing one because none of
// them owns this. The three *-geom-check.mjs files parse layout constants, the
// *-rank/scrollback/palette ones parse a single algorithm, and pair-crypto-check.mjs
// parses the dispatch chain only where pairing touches it. A command inventory
// folded into a file called "usage-geom-check" is a parse nobody would look under,
// and this one needs a --selftest of its own anyway.
//
// WHAT IT ACTUALLY CHECKS. Both sides are PARSED, never transcribed:
//   1. every `buf == "X"` / `buf.startsWith("X")` / `buf.equalsIgnoreCase("X")` in
//      processCompletedLine(), with the preprocessor guard stack it sits under;
//   2. every entry of UNAVAILABLE_COMMANDS[], with ITS guard stack;
//   3. every `#define BOARD_*` value out of both board headers.
// Then it EVALUATES those guards per board - a real boolean evaluator over the
// headers' own numbers, not a text comparison - and asserts that a verb reachable on
// either board is, on the other, either HANDLED or EXPLICITLY REFUSED. Nothing here
// knows the name of a single command in advance, so adding a board-2-only verb
// without a refusal fails by that verb's name.
import fs from "fs";
import { DIR, fnBody, stripComments, preprocess, deadGuards } from "./geom-common.mjs";

const SELFTEST = process.argv.includes("--selftest");
const HDR = { 1: "board_e32r28t.h", 2: "board_es3c35p.h" };

// ---------------------------------------------------------------------------
function suite(ok, over = {}) {
  const main = over.main != null ? over.main
             : stripComments("deckhand_display.ino");
  const hdr = {};
  for (const b of [1, 2])
    hdr[b] = over[`h${b}`] != null ? over[`h${b}`] : fs.readFileSync(`${DIR}/${HDR[b]}`, "utf8");

  // ---- the flags, out of each header ------------------------------------
  // NUMERIC #defines only: BOARD_NAME is a string and BOARD_W/BOARD_H are sizes,
  // but the guards only ever name 0/1 capability flags and an unknown name throws
  // above, so a flag that stopped being a #define is caught by that throw as well
  // as by the assertion below.
  const flags = {};
  for (const b of [1, 2]) {
    flags[b] = {};
    for (const m of hdr[b].matchAll(/^\s*#define\s+(BOARD_[A-Z0-9_]+)\s+(-?\d+)\s*(?:\/\/.*)?$/gm))
      flags[b][m[1]] = Number(m[2]);
    ok(`board ${b}: parsed ${Object.keys(flags[b]).length} numeric BOARD_* #defines`,
       Object.keys(flags[b]).length >= 5);
    // THE const int TRAP, on the flags this file's own guards depend on. `#if` on a
    // C++ const int evaluates an undefined identifier as 0 - silently, no warning -
    // so every guarded arm takes the wrong branch while this checker, which would
    // parse the const int just as happily, reports green.
    const bad = [...hdr[b].matchAll(/^\s*const\s+int\s+(BOARD_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
    ok(`board ${b}: no BOARD_* capability flag is a const int (${bad.join(", ") || "none"})`,
       bad.length === 0);
  }

  // ---- (0) the source EACH BOARD'S COMPILER would see ---------------------
  // One preprocessor, geom-common's, rather than a second thinner copy: the copy
  // that used to live here did not handle `#elif`, so an `#elif` arm inherited its
  // `#if`'s condition and an `#if BOARD_USES_TFT_ESPI / #elif BOARD_HAS_BEEPER`
  // pair attributed the second arm's verbs to the WRONG BOARD - a green run
  // reachable with an inverted refusal table. deckhand_display.ino has one such
  // pair today. strictUnknown makes an identifier no header #defines THROW by
  // name, which is what the removed evaluator did and what an inventory needs: a
  // guard read as "unknown" keeps both arms live and silently exempts every verb
  // under it from the whole cross-board comparison.
  const seen = {};
  for (const b of [1, 2]) {
    try { seen[b] = preprocess(main, flags[b], { strictUnknown: true }); }
    catch (e) {
      seen[b] = null;
      ok(`board ${b}: every #if in deckhand_display.ino resolves against that board's own flags (${e.message})`, false);
    }
  }
  ok("both boards' sources preprocess against their own headers", seen[1] != null && seen[2] != null);
  if (!seen[1] || !seen[2]) return;

  const DISPATCH_SIG = "void processCompletedLine(String& buf, unsigned long* lastRxTimestamp, bool fromUsb) {";
  // All three spellings the chain actually uses, and ALL matches per line - the
  // savings toggles are three startsWith() calls ORed on ONE line, so a
  // first-match-per-line parse would silently drop CPUSLOW and BLESLOW.
  const VERB_RE = /buf\s*(?:==|\.startsWith\(|\.equalsIgnoreCase\()\s*"([A-Z][A-Z0-9]*)\s?"/g;

  // ---- (1) the dispatch chain, per board ---------------------------------
  const state = {};
  for (const b of [1, 2]) {
    const dispatch = fnBody(seen[b], DISPATCH_SIG, `deckhand_display.ino (board ${b})`);
    state[b] = {
      handled: new Set([...dispatch.matchAll(VERB_RE)].map((m) => m[1])),
      refused: new Set(),
      causes: {},
    };
  }
  const allHandled = new Set([...state[1].handled, ...state[2].handled]);
  ok(`the dispatch chain parses to a real inventory (${allHandled.size} verbs across both boards)`,
     allHandled.size >= 30);
  // POSITIVE CONTROL for the preprocessing: the two boards must NOT see the same
  // chain. If they did - a preprocessor that dropped nothing, a flags parse that
  // came back empty - every verb would read as handled on both and the entire
  // cross-board comparison below would pass vacuously with an empty refusal table.
  const onlyOne = [...allHandled].filter((v) => state[1].handled.has(v) !== state[2].handled.has(v));
  ok(`sanity: the preprocessor DOES cut - ${onlyOne.length} verbs exist on exactly one board`,
     onlyOne.length >= 10);

  // ---- (1b) HANDLED MUST MEAN REACHABLE ----------------------------------
  // The scrape above finds a verb inside `} else if (false && (buf == "POWERPROBE"
  // || ...)) {` exactly as happily as inside a live arm - and that verb then reads
  // as handled on both boards while every line of it falls through into the
  // JSON-payload branch and is discarded in silence, which is the precise failure
  // this whole file exists to prevent. 135/135 passed with it.
  //
  // So every dispatch CONDITION that names a verb is parsed whole (paren-matched,
  // so a multi-line condition is not torn in half) and must reduce to a pure
  // disjunction of buf comparisons: each term rewritten to T, the remainder must be
  // `T` or `T||T||...`. `false && (T||T)` does not reduce, and neither does any
  // other extra term bolted onto a verb's own guard.
  const rawDispatch = fnBody(main, DISPATCH_SIG, "deckhand_display.ino");
  const conds = [];
  for (let i = rawDispatch.indexOf("if ("); i >= 0; i = rawDispatch.indexOf("if (", i + 1)) {
    let d = 0, j = i + 3;
    for (; j < rawDispatch.length; j++) {
      if (rawDispatch[j] === "(") d++;
      else if (rawDispatch[j] === ")" && --d === 0) break;
    }
    if (d !== 0) continue;
    const c = rawDispatch.slice(i + 4, j);
    VERB_RE.lastIndex = 0;
    if (VERB_RE.test(c)) conds.push(c);
  }
  ok(`sanity: the dispatch's verb conditions are located (${conds.length})`, conds.length >= 25);
  // The whole TERM, closing paren included: VERB_RE deliberately stops at the
  // literal (it is a scraper), so normalising with it would leave a stray ")" in
  // every startsWith term and no condition would ever reduce.
  const TERM_RE = /buf\s*(?:==\s*"[A-Z][A-Z0-9]*\s?"|\.(?:startsWith|equalsIgnoreCase)\(\s*"[A-Z][A-Z0-9]*\s?"\s*\))/g;
  const impure = conds
    .map((c) => c.replace(TERM_RE, "T").replace(/\s+/g, ""))
    .filter((c) => !/^T(\|\|T)*$/.test(c));
  ok(`every verb's condition is a plain disjunction of buf comparisons, so "handled" means REACHABLE ${impure.length ? "[" + impure.join(" ; ") + "]" : ""}`,
     impure.length === 0);
  // The same rule for the arms' BODIES and for the whole table, where the
  // condition trick does not apply: a literal dead-code guard anywhere in the
  // dispatch is either debug residue or a disabled behaviour, and both must be
  // visible rather than green.
  const dead = deadGuards(rawDispatch);
  ok(`no literal dead-code guard (if (0), false &&, || true) sits in the dispatch chain ${dead.length ? "[" + dead.join(", ") + "]" : ""}`,
     dead.length === 0);

  // ---- (2) the refusal table, per board ----------------------------------
  // Located in EACH BOARD'S preprocessed text, not in `main`: preprocess blanks a
  // dropped line to "", so line numbers survive and character offsets do not.
  const TABLE_SIG = "static const UnavailableCommand UNAVAILABLE_COMMANDS[] = {";
  ok("UNAVAILABLE_COMMANDS[] is declared in deckhand_display.ino", main.indexOf(TABLE_SIG) >= 0);
  if (main.indexOf(TABLE_SIG) < 0) return;
  for (const b of [1, 2]) {
    const tAt = seen[b].indexOf(TABLE_SIG);
    const tEnd = seen[b].indexOf("\n};", tAt);
    ok(`board ${b}: found both ends of UNAVAILABLE_COMMANDS[]`, tAt >= 0 && tEnd > tAt);
    if (tAt < 0 || tEnd < 0) continue;
    const table = seen[b].slice(tAt, tEnd);
    for (const m of table.matchAll(/\{\s*"([A-Z][A-Z0-9]*)"\s*,/g)) {
      const v = m[1];
      state[b].refused.add(v);
      // The cause is the rest of the entry, up to the closing `" },` - C
      // concatenates the adjacent literals, so reading only the first would judge
      // a one-line stub the same as a real explanation.
      const to = table.indexOf('" },', m.index);
      state[b].causes[v] = to > m.index
        ? [...table.slice(m.index, to + 1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].slice(1).map((x) => x[1]).join("")
        : "";
    }
  }
  const allRefused = new Set([...state[1].refused, ...state[2].refused]);
  ok(`the refusal table parses (${allRefused.size} entries across both boards)`,
     allRefused.size >= 1 || flags[1].BOARD_USES_TFT_ESPI === 0);

  // ---- (3) the cross-board inventory ------------------------------------
  for (const [a, z] of [[2, 1], [1, 2]]) {
    for (const v of [...state[a].handled].sort()) {
      if (state[z].handled.has(v)) continue;
      ok(`${v}: handled on board ${a} and NOT on board ${z}, so board ${z} refuses it by name`,
         state[z].refused.has(v));
    }
  }
  // A refusal for a verb the board DOES handle is dead code that also lies: the
  // handler runs first, so the entry can never fire and its cause is never true.
  for (const b of [1, 2])
    for (const v of [...state[b].refused].sort())
      ok(`${v}: board ${b} refuses it, and does not also handle it (a dead entry is a lie)`,
         !state[b].handled.has(v));
  // ... and a refusal for a verb NO board has is an entry describing nothing.
  for (const v of [...allRefused].sort())
    ok(`${v}: the refusal names a verb the dispatch chain really has`, allHandled.has(v));

  // ---- (4) the causes ----------------------------------------------------
  const causeOf = {};
  for (const b of [1, 2]) for (const v of [...state[b].refused].sort()) {
    const c = state[b].causes[v];
    // "PERF is board 2 only" tells a reader nothing they cannot already see. The
    // floor is length because there is no way to assert usefulness, but a stub
    // short enough to be a paraphrase of the guard fails it.
    ok(`${v}: its cause is specific enough to act on (${c.length} chars)`, c.length >= 60);
    // LENGTH ALONE IS PADDABLE, and a reviewer measured it: "PERF is board 2 only."
    // repeated three times plus "no." clears 60 characters and says nothing. Two
    // cheap shape rules close the two ways to pad. First, no sentence may repeat
    // inside one cause.
    const sentences = c.split(/(?<=\.)\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 8);
    const dupe = sentences.length !== new Set(sentences).size;
    ok(`${v}: its cause does not pad itself by repeating a sentence`, !dupe);
    // Second, a cause has to say something about THIS board's own hardware or point
    // at what to use instead - a paraphrase of the guard ("X is board 2 only") has
    // neither. Every real entry names a part, a flag, a pin, a file or an
    // alternative command; the vocabulary is deliberately wide because the rule is
    // "not a restatement of the #if", not "use these words".
    ok(`${v}: its cause explains the board, not just the guard`,
       /\b(BOARD_[A-Z0-9_]+|PIN_[A-Z0-9_]+|ES8311|ILI9341|ST77922|ESP32|PSRAM|I2C|I2S|ADC|GPIO|framebuffer|codec|beeper|sensor|driver|panel|node |\.ino|\.h\b|\.mjs)/.test(c) ||
       /\b(instead|use |run |is on|works here|available)\b/i.test(c));
    causeOf[v] = c;
  }
  // A cause may DELEGATE - CPUSLOW and BLESLOW both say "see PANELSLEEP", which is
  // an honest pointer rather than a template - but the entry it points at has to
  // exist, or the Mac is told to read something that is not there.
  const xrefBad = [];
  for (const [v, c] of Object.entries(causeOf)) {
    const m = /\bsee ([A-Z][A-Z0-9]{2,})\b/.exec(c);
    if (m && !allRefused.has(m[1]) && !allHandled.has(m[1])) xrefBad.push(`${v} -> ${m[1]}`);
  }
  ok(`every "see X" in a cause names a command that really exists ${xrefBad.length ? "[" + xrefBad.join(", ") + "]" : ""}`,
     xrefBad.length === 0);
  // Two entries with the SAME cause, neither of which delegates, means at least one
  // of them is not about its own verb; the table is a set of explanations, not a
  // template with the verb swapped out.
  const byCause = {};
  for (const [v, c] of Object.entries(causeOf))
    if (!/\bsee [A-Z][A-Z0-9]{2,}\b/.test(c)) (byCause[c] = byCause[c] || []).push(v);
  const shared = Object.values(byCause).filter((g) => g.length > 1).map((g) => g.join("/"));
  ok(`every refusal cause is written for its own verb ${shared.length ? "[shared: " + shared.join(", ") + "]" : ""}`,
     shared.length === 0);
  for (const [v, c] of Object.entries(causeOf))
    // THE FONTS ARE ASCII 0x20..0x7E AND NOTHING ELSE. These lines go over the wire
    // rather than to the glass, so the font range does not bound them - but the host
    // transliterates everything device-bound, so a non-ASCII byte here could only
    // ever arrive mangled, and asserting it costs nothing.
    ok(`${v}: its cause is pure ASCII`, /^[\x20-\x7E]*$/.test(c));

  // ---- (5) the table is REACHED, and reached in the right place ----------
  // Bound to processCompletedLine's OWN body, not to the file: a call sitting in
  // some other function would satisfy a file-wide search and refuse nothing.
  const armRe = /\}\s*else if \(refuseUnavailableCommand\(buf\)\) \{([\s\S]*?)\n  \} else \{/;
  const arm = rawDispatch.match(armRe);
  ok("processCompletedLine walks the table in the LAST arm before the payload branch",
     !!arm);
  if (arm) {
    // A refusal that returns without clearing `buf` re-parses the same text against
    // every subsequent line for ever - one DETAIL 9 produced 63 refusal lines and
    // ~100s in which the device parsed no payloads at all. This arm falls through to
    // the tail's own `buf = ""` instead, so it must contain no return at all.
    ok("the refusal arm does not return early, so it falls through to the tail's buf clear",
       !/\breturn\b/.test(arm[1]) || /buf\s*=\s*""\s*;[\s\S]*\breturn\b/.test(arm[1]));
  }
  const walker = fnBody(main, "bool refuseUnavailableCommand(const String& line) {",
                        "deckhand_display.ino");
  // WHOLE VERB, NOT A PREFIX. The chain uses `buf == "X"`, `startsWith("X")` and
  // `startsWith("X ")`, so one table has to cover all three - and a bare prefix
  // match would make a future SCROLLTOP be answered as SCROLLTO.
  ok("the walker matches a whole verb (end of line, or a space), never a prefix",
     /after\s*!=\s*'\\0'\s*&&\s*after\s*!=\s*' '/.test(walker));
  // The walk stops on the null verb rather than a sizeof() count, which is what lets
  // every entry be #if'd away on a board that needs none (an empty array will not
  // compile) without the count and the array ever disagreeing.
  ok("the walk terminates on the table's null verb, not on a sizeof() count",
     /u->verb\s*!=\s*nullptr/.test(walker) && !/sizeof\(UNAVAILABLE_COMMANDS\)/.test(walker));
  ok("the refusal is sent with sendLineToHost, so it reaches a Mac with the cable out",
     /sendLineToHost\(/.test(walker));
  ok("the walker prints the entry's OWN cause, not a generic line",
     /u->cause/.test(walker));

  // ---- (6) THE WALKER'S BODY, not its text -------------------------------
  // Everything above binds what the walker SAYS. A reviewer measured what that
  // leaves open: `return false;` as its first statement restores board 1's
  // answer-with-silence defect - the entire reason this file was written - and all
  // 135 assertions still passed, including the closing line "every device command
  // is either handled or refused BY NAME on both boards". Every regex above is
  // still satisfied by the untouched lines below the early return.
  //
  // So the walker's EXITS are enumerated the way pair-crypto-check enumerates
  // pairCtEq's: the loop must come before any return, there must be exactly two,
  // and they must be the `true` that follows a match and the final `false`. An
  // early return of either polarity changes that list.
  const wReturns = [...walker.matchAll(/\breturn\b([^;]*);/g)];
  const wFor = walker.indexOf("for (");
  ok(`the walker's only exits are `+"`true`"+` after a match and a final `+"`false`"+` [${wReturns.map((m) => m[1].trim()).join(" | ")}]`,
     wReturns.length === 2 && wReturns[0][1].trim() === "true" && wReturns[1][1].trim() === "false");
  ok("the table walk is the walker's FIRST statement, so nothing returns ahead of it",
     wFor >= 0 && wReturns.length > 0 && wFor < wReturns[0].index);
  // ...and the same dead-code rule as the dispatch: `if (0) { ... }` around the
  // send leaves every one of the assertions above matching.
  const wDead = deadGuards(walker);
  ok(`no literal dead-code guard sits in the walker ${wDead.length ? "[" + wDead.join(", ") + "]" : ""}`,
     wDead.length === 0);

  // THE WHOLE CAUSE REACHES THE MAC. The table's causes are asserted at length in
  // section (4), and a walker that ships `String(u->cause).substring(0, 3)` passes
  // every one of them: the cause in the array is still 200 characters, and what
  // goes over the wire is "it ". So the line the walker builds is parsed - the
  // cause must be its final, whole term - and no truncating call may appear.
  const outExpr = /\bString\s+\w+\s*=([^;]*);/.exec(walker);
  ok(`the refusal line is built by concatenation and ends with the entry's whole cause [${outExpr ? outExpr[1].trim() : "not found"}]`,
     outExpr != null && /\+\s*u->cause\s*$/.test(outExpr[1].trim()));
  ok("nothing in the walker truncates what it sends",
     !/\.substring\(|\bstrncpy\b|\bstrlcpy\b|\.remove\(|\bsnprintf\b/.test(walker));
  // The refusal has to be identifiable from the Mac: silence and "impossible here"
  // look identical, and so do "refused" and "refused, but by which board, for what".
  ok("the refusal line names the verb and the board it was refused on",
     outExpr != null && /u->verb/.test(outExpr[1]) && /BOARD_NAME/.test(outExpr[1]));
}

// ---------------------------------------------------------------------------
function run(over, quiet) {
  const failures = [];
  let pass = 0;
  const ok = (name, cond) => {
    if (cond) { pass++; if (!quiet) console.log(`  ok    ${name}`); }
    else { failures.push(name); if (!quiet) console.log(` FAIL   ${name}`); }
  };
  try { suite(ok, over); } catch (e) { failures.push(`THREW: ${e.message}`); if (!quiet) console.log(` FAIL   THREW: ${e.message}`); }
  return { pass, failures };
}

if (!SELFTEST) {
  const r = run({}, false);
  console.log(`\n${r.pass + r.failures.length} assertions, ${r.failures.length} failures`);
  if (r.failures.length) process.exit(1);
  console.log("every device command is either handled or refused BY NAME on both boards");
  process.exit(0);
}

// --- teeth. Each fault is an EDIT to the real source; an edit that changes
// nothing is reported as a MISS rather than counted, because a fault whose anchor
// has moved applies nothing and would then be credited to whatever else fails.
const realMain = stripComments("deckhand_display.ino");
const realH1 = fs.readFileSync(`${DIR}/${HDR[1]}`, "utf8");
// Located by PARSING - the entry for one verb, brace to brace - so these survive an
// edit to the text they remove. Both of the pair-crypto checker's own EMOJITEST and
// READTEST faults broke by transcribing the block they deleted.
function dropEntry(src, verb) {
  const from = src.indexOf(`{ "${verb}",`);
  if (from < 0) return src;
  const to = src.indexOf('" },', from);
  if (to < 0) return src;
  return src.slice(0, from) + src.slice(to + 4);
}
// The walker's body, LOCATED and rewritten. Same reason as dropEntry: a fault that
// transcribes the lines it replaces stops injecting the next time they are edited,
// and an injection that applies nothing leaves the property it was proving unproven
// while the selftest still prints a pass.
function patchWalker(src, fn) {
  const sig = "bool refuseUnavailableCommand(const String& line) {";
  const i = src.indexOf(sig);
  if (i < 0) return src;
  const z = src.indexOf("\n}\n", i);
  if (z < 0) return src;
  return src.slice(0, i) + fn(src.slice(i, z)) + src.slice(z);
}
// One verb's dispatch condition, found from its own literal and paren-matched, then
// buried under a `false &&`. Located rather than quoted so it survives an edit to
// the condition it weakens.
function weakenCondition(src, verb) {
  const i = src.indexOf(`buf == "${verb}"`) >= 0 ? src.indexOf(`buf == "${verb}"`)
                                                 : src.indexOf(`"${verb}"`);
  if (i < 0) return src;
  const s0 = src.lastIndexOf("if (", i);
  if (s0 < 0) return src;
  let d = 0, j = s0 + 3;
  for (; j < src.length; j++) {
    if (src[j] === "(") d++;
    else if (src[j] === ")" && --d === 0) break;
  }
  if (d !== 0) return src;
  return `${src.slice(0, s0 + 4)}false && (${src.slice(s0 + 4, j)})${src.slice(j)}`;
}
const faults = [
  // ---- M1: the walker's BODY. This is the one the whole file exists for: an
  // early `return false;` restores board 1's answer-with-silence and left all 135
  // of the previous assertions green.
  ["refuseUnavailableCommand returns false before it walks anything (silence, restored)",
    { main: patchWalker(realMain, (b) => b.replace("{", "{\n  return false;")) }],
  ["a dead-code guard skips the send, so a matched verb is answered with silence",
    { main: patchWalker(realMain, (b) => b.replace(/\bfor \(/, "if (0) return false;\n  for (")) }],
  // ---- #2: the cause is TRUNCATED on the way out, while the table still holds it
  ["the walker ships the first three characters of the cause",
    { main: patchWalker(realMain, (b) => b.replace(/\+\s*u->cause/, "+ String(u->cause).substring(0, 3)")) }],
  // ---- M4: "handled" scraped from an unreachable arm
  ["a verb's arm is buried under `false &&`, so it is scraped as handled and reached never",
    { main: weakenCondition(realMain, "POWERPROBE") }],
  // ---- M3: #elif. The old walkGuarded pushed nothing for an #elif, so this arm
  // inherited `#if 0` and the verb was invisible on BOTH boards - 135/135, count
  // unchanged, no assertion mentioning it at all.
  ["a board-2-only verb hides in an #elif arm whose #if is false on both boards",
    { main: realMain.replace("  } else if (refuseUnavailableCommand(buf)) {",
        '#if 0\n#elif BOARD_BLE_NIMBLE\n  } else if (buf == "ELIFTEST") {\n    sendLineToHost("x");\n#endif\n  } else if (refuseUnavailableCommand(buf)) {') }],
  // ---- #6: a cause padded to clear the 60-character floor and say nothing
  ["a cause is padded to length by repeating itself",
    (() => {
      const from = realMain.indexOf('{ "PERF",');
      const to = realMain.indexOf('" },', from);
      return { main: realMain.slice(0, from) +
        '{ "PERF", "PERF is board 2 only. PERF is board 2 only. PERF is board 2 only. no." },' +
        realMain.slice(to + 4) };
    })()],
  ["a cause delegates to an entry that does not exist",
    (() => {
      const from = realMain.indexOf('{ "CPUSLOW",');
      const to = realMain.indexOf('" },', from);
      return { main: realMain.slice(0, from) +
        '{ "CPUSLOW", "see PANELSNOOZE: savingsSync()\'s body is behind !BOARD_USES_TFT_ESPI, so there is nothing on this board for the toggle to apply." },' +
        realMain.slice(to + 4) };
    })()],
  ["one refusal entry is deleted (TEMP), so board 1 answers it with silence again",
    { main: dropEntry(realMain, "TEMP") }],
  ["the whole table is bypassed - the dispatch stops walking it",
    { main: realMain.replace("} else if (refuseUnavailableCommand(buf)) {",
                             "} else if (false && refuseUnavailableCommand(buf)) {") }],
  ["a cause is replaced by a paraphrase of its own guard",
    (() => {
      const from = realMain.indexOf('{ "PERF",');
      const to = realMain.indexOf('" },', from);
      return { main: realMain.slice(0, from) + '{ "PERF", "board 2 only." },' + realMain.slice(to + 4) };
    })()],
  ["the walker degrades to a PREFIX match, so SCROLLTO would answer for SCROLLTOP",
    { main: realMain.replace("if (after != '\\0' && after != ' ') continue;", "") }],
  ["the walk counts entries with sizeof() instead of stopping on the null verb",
    { main: realMain.replace("u->verb != nullptr",
                             "u < UNAVAILABLE_COMMANDS + sizeof(UNAVAILABLE_COMMANDS) / sizeof(UNAVAILABLE_COMMANDS[0])") }],
  ["the refusal arm returns without clearing buf (the 63-refusal-lines defect)",
    { main: realMain.replace("} else if (refuseUnavailableCommand(buf)) {",
                             "} else if (refuseUnavailableCommand(buf)) {\n    return;") }],
  ["a board flag becomes a const int, so every #if on it is silently false",
    { h1: realH1.replace("#define BOARD_HISTORY_SCROLL 0", "const int BOARD_HISTORY_SCROLL = 0;") }],
  ["the refusal is printed to Serial, so a cable-less BLE session sees nothing",
    { main: realMain.replace("      sendLineToHost(out.c_str());", "      Serial.println(out);") }],
];

let caught = 0;
for (const [name, over] of faults) {
  const unchanged = (over.main == null || over.main === realMain) &&
                    (over.h1 == null || over.h1 === realH1);
  if (unchanged) { console.log(`  MISSED  ${name}  <- the injection did not apply (anchor moved)`); continue; }
  const r = run(over, true);
  if (r.failures.length) {
    caught++;
    console.log(`  caught  ${name}`);
    console.log(`            by: ${r.failures[0]}${r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : ""}`);
  } else console.log(`  MISSED  ${name}  <- no assertion notices this`);
}
console.log(`\nselftest: ${caught}/${faults.length} faults caught`);
process.exit(caught === faults.length ? 0 : 1);
