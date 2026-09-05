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
import { DIR, fnBody, stripComments } from "./geom-common.mjs";

const SELFTEST = process.argv.includes("--selftest");
const HDR = { 1: "board_e32r28t.h", 2: "board_es3c35p.h" };

// ---------------------------------------------------------------------------
// A BOOLEAN EVALUATOR OVER THE BOARD FLAGS. `#if` on a C++ `const int` is silently
// FALSE with no -Wall warning - it has shipped twice in this repo - so an unknown
// identifier THROWS here rather than defaulting to 0. A guard this file cannot
// resolve must fail loudly; a guard it silently reads as false would quietly
// exempt every verb under it from the whole inventory.
function evalGuard(expr, flags) {
  const src = expr.replace(/\/\/.*$/, "").trim();
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  function primary() {
    ws();
    if (src[i] === "(") { i++; const v = or(); ws(); if (src[i] !== ")") throw new Error(`expected ) in "${expr}"`); i++; return v; }
    if (src[i] === "!") { i++; return !primary(); }
    const m = /^[A-Za-z_][A-Za-z_0-9]*|^\d+/.exec(src.slice(i));
    if (!m) throw new Error(`cannot parse "${expr}" at ${i}`);
    i += m[0].length;
    if (/^\d+$/.test(m[0])) return Number(m[0]) !== 0;
    if (!(m[0] in flags)) throw new Error(`"${expr}" names ${m[0]}, which no board header #defines`);
    return flags[m[0]] !== 0;
  }
  function and() { let v = primary(); for (;;) { ws(); if (src.startsWith("&&", i)) { i += 2; const r = primary(); v = v && r; } else return v; } }
  function or()  { let v = and();     for (;;) { ws(); if (src.startsWith("||", i)) { i += 2; const r = and();     v = v || r; } else return v; } }
  const out = or(); ws();
  if (i !== src.length) throw new Error(`trailing junk in "${expr}"`);
  return out;
}

// Walk a block of source, maintaining the #if stack, and hand every line to `visit`
// together with the stack that is open AT that line. One implementation, used for
// both the dispatch chain and the table, so the two can never be read by different
// rules.
function walkGuarded(text, visit) {
  const stack = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^#if\b/.test(t)) { stack.push(t.replace(/^#if\s*/, "")); continue; }
    if (/^#ifdef\b/.test(t)) { stack.push(`defined_${t.split(/\s+/)[1]}`); continue; }
    if (/^#ifndef\b/.test(t)) { stack.push(`!defined_${t.split(/\s+/)[1]}`); continue; }
    if (/^#else\b/.test(t)) { if (stack.length) stack[stack.length - 1] = `!(${stack[stack.length - 1]})`; continue; }
    if (/^#endif\b/.test(t)) { stack.pop(); continue; }
    visit(line, stack.slice());
  }
  if (stack.length) throw new Error(`unbalanced #if in the block being walked: [${stack.join(", ")}]`);
}

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

  // ---- (1) the dispatch chain -------------------------------------------
  const dispatch = fnBody(main,
    "void processCompletedLine(String& buf, unsigned long* lastRxTimestamp, bool fromUsb) {",
    "deckhand_display.ino");
  // All three spellings the chain actually uses, and ALL matches per line - the
  // savings toggles are three startsWith() calls ORed on ONE line, so a
  // first-match-per-line parse would silently drop CPUSLOW and BLESLOW.
  const VERB_RE = /buf\s*(?:==|\.startsWith\(|\.equalsIgnoreCase\()\s*"([A-Z][A-Z0-9]*)\s?"/g;
  const handled = {};   // verb -> guard stack
  walkGuarded(dispatch, (line, stack) => {
    for (const m of line.matchAll(VERB_RE)) {
      const v = m[1];
      // A verb spelled twice (TONETEST is both `==` and `startsWith("TONETEST ")`)
      // keeps the SHALLOWER guard - it is reachable if any spelling is.
      if (!(v in handled) || stack.length < handled[v].length) handled[v] = stack;
    }
  });
  ok(`the dispatch chain parses to a real inventory (${Object.keys(handled).length} verbs)`,
     Object.keys(handled).length >= 30);
  // POSITIVE CONTROL for the guard walk: the parse must SEE guards, or every verb
  // would read as unguarded and the whole cross-board comparison would pass
  // vacuously with an empty refusal table.
  const guardedVerbs = Object.entries(handled).filter(([, g]) => g.length > 0);
  ok(`sanity: the walk DOES attach guards (${guardedVerbs.length} of ${Object.keys(handled).length} verbs sit under one)`,
     guardedVerbs.length >= 10);

  // ---- (2) the refusal table --------------------------------------------
  const tAt = main.indexOf("static const UnavailableCommand UNAVAILABLE_COMMANDS[] = {");
  ok("UNAVAILABLE_COMMANDS[] is declared in deckhand_display.ino", tAt >= 0);
  if (tAt < 0) return;
  const tEnd = main.indexOf("\n};", tAt);
  ok("found the end of UNAVAILABLE_COMMANDS[]", tEnd > tAt);
  if (tEnd < 0) return;
  const table = main.slice(tAt, tEnd);
  const refused = {};   // verb -> { guards, cause }
  walkGuarded(table.slice(table.indexOf("\n")), (line, stack) => {
    const m = /\{\s*"([A-Z][A-Z0-9]*)"\s*,/.exec(line);
    if (m) refused[m[1]] = { guards: stack, at: line };
  });
  // The cause is the rest of the entry, up to the closing `},` - C concatenates the
  // adjacent literals, so reading only the first would judge a one-line stub the
  // same as a real explanation.
  for (const v of Object.keys(refused)) {
    const from = table.indexOf(`{ "${v}",`);
    const to = table.indexOf('" },', from);
    refused[v].cause = to > from
      ? [...table.slice(from, to + 1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].slice(1).map((m) => m[1]).join("")
      : "";
  }
  ok(`the refusal table parses (${Object.keys(refused).length} entries)`,
     Object.keys(refused).length >= 1 || flags[1].BOARD_USES_TFT_ESPI === 0);

  // ---- (3) the cross-board inventory ------------------------------------
  const on = (b, stack) => stack.every((g) => evalGuard(g, flags[b]));
  const state = {};
  for (const b of [1, 2]) {
    state[b] = { handled: new Set(), refused: new Set() };
    for (const [v, g] of Object.entries(handled)) if (on(b, g)) state[b].handled.add(v);
    for (const [v, r] of Object.entries(refused)) if (on(b, r.guards)) state[b].refused.add(v);
  }
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
  for (const v of Object.keys(refused))
    ok(`${v}: the refusal names a verb the dispatch chain really has`, v in handled);

  // ---- (4) the causes ----------------------------------------------------
  for (const v of Object.keys(refused).sort()) {
    const c = refused[v].cause;
    // "PERF is board 2 only" tells a reader nothing they cannot already see. The
    // floor is length because there is no way to assert usefulness, but a stub
    // short enough to be a paraphrase of the guard fails it.
    ok(`${v}: its cause is specific enough to act on (${c.length} chars)`, c.length >= 60);
    // THE FONTS ARE ASCII 0x20..0x7E AND NOTHING ELSE. These lines go over the wire
    // rather than to the glass, so the font range does not bound them - but the host
    // transliterates everything device-bound, so a non-ASCII byte here could only
    // ever arrive mangled, and asserting it costs nothing.
    ok(`${v}: its cause is pure ASCII`, /^[\x20-\x7E]*$/.test(c));
  }

  // ---- (5) the table is REACHED, and reached in the right place ----------
  // Bound to processCompletedLine's OWN body, not to the file: a call sitting in
  // some other function would satisfy a file-wide search and refuse nothing.
  const armRe = /\}\s*else if \(refuseUnavailableCommand\(buf\)\) \{([\s\S]*?)\n  \} else \{/;
  const arm = dispatch.match(armRe);
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
const faults = [
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
