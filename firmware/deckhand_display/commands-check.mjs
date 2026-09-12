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
// THE PREPROCESSOR GUARD STACK OF EVERY LINE, as a structure rather than as text.
// geom-common's preprocess() answers "does this board see this line", which is the
// per-board question; this answers "under what condition does ANY board see it",
// which is what an exact-negation claim needs. One level per open `#if`, carrying
// the arm that is currently open (`null` for an `#else` with no condition of its
// own) and the earlier arms it must not have taken.
function guardStacks(src) {
  const lines = src.split("\n");
  const out = new Array(lines.length).fill(null);
  const stack = [];
  const snap = () => stack.map((f) => ({ cur: f.cur, prior: f.prior.slice() }));
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    let m;
    if ((m = /^#ifdef\s+(\S+)/.exec(t))) stack.push({ cur: `defined(${m[1]})`, prior: [] });
    else if ((m = /^#ifndef\s+(\S+)/.exec(t))) stack.push({ cur: `!defined(${m[1]})`, prior: [] });
    else if ((m = /^#if\s+(.+)$/.exec(t))) stack.push({ cur: m[1].trim(), prior: [] });
    else if ((m = /^#elif\s+(.+)$/.exec(t))) { const f = stack[stack.length - 1]; if (f) { if (f.cur) f.prior.push(f.cur); f.cur = m[1].trim(); } }
    else if (/^#else\b/.test(t)) { const f = stack[stack.length - 1]; if (f) { if (f.cur) f.prior.push(f.cur); f.cur = null; } }
    else if (/^#endif\b/.test(t)) stack.pop();
    else { out[i] = snap(); continue; }
  }
  return out;
}
function stackFlags(stack) {
  const out = [];
  for (const f of stack)
    for (const e of [f.cur, ...f.prior])
      if (e) for (const m of e.matchAll(/\b(BOARD_[A-Z0-9_]+)\b/g)) out.push(m[1]);
  return out;
}
// One guard expression under one hypothetical flag assignment. An identifier the
// assignment does not carry THROWS by name rather than defaulting to 0: a guard
// silently read as false makes any negation claim over it meaningless, and a
// checker that reports a meaningless claim as a pass is the defect this whole
// family of files exists to avoid.
function evalGuard(expr, assign) {
  let e = expr.replace(/defined\s*\(\s*([A-Za-z_0-9]+)\s*\)/g, (_, n) => (n in assign ? "1" : "0"));
  e = e.replace(/[A-Za-z_][A-Za-z_0-9]*/g, (n) => {
    if (n in assign) return String(assign[n]);
    throw new Error(`guard "${expr}" names ${n}, which is not a BOARD_* flag this comparison varies`);
  });
  if (!/^[\s0-9!&|()<>=+*/-]*$/.test(e)) throw new Error(`guard "${expr}" is not a plain flag expression`);
  return !!eval(e);
}
function stackHolds(stack, assign) {
  for (const f of stack) {
    if (f.cur != null && !evalGuard(f.cur, assign)) return false;
    for (const p of f.prior) if (evalGuard(p, assign)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
function suite(ok, over = {}) {
  const main = over.main != null ? over.main
             : stripComments("deckhand_display.ino");
  const hdr = {};
  for (const b of [1, 2])
    hdr[b] = over[`h${b}`] != null ? over[`h${b}`] : fs.readFileSync(`${DIR}/${HDR[b]}`, "utf8");
  const claudeMd = over.claudemd != null ? over.claudemd
                 : fs.readFileSync(`${DIR}/../../CLAUDE.md`, "utf8");

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

  // ---- (3b) THE TWO GUARDS ARE EXACT NEGATIONS ---------------------------
  // Section (3) proves the handler and the refusal do not overlap AND do not both
  // go missing ON THESE TWO BOARDS. That is weaker than the rule the table states
  // about itself - "EACH ENTRY'S GUARD IS THE EXACT NEGATION OF ITS HANDLER'S" -
  // and the gap is a real one: an entry guarded `!BOARD_TOUCH_NEEDS_CAL ||
  // BOARD_HISTORY_SCROLL` is correct on both boards today and stops being correct
  // the moment a third board sets both flags, at which point the verb is handled
  // AND refused. The table's whole promise is that "a future board that turns one
  // of those on gets the handler and loses the refusal in the same edit", and two
  // boards cannot witness that promise.
  //
  // So both guard STACKS are parsed out of the source - the conjunction of every
  // enclosing `#if`, with the earlier arms of an `#if`/`#elif`/`#else` negated -
  // and compared over EVERY assignment of the BOARD_* flags either one names, not
  // over the two the headers happen to declare. De Morgan is expected rather than
  // forbidden: `BOARD_USES_TFT_ESPI || !BOARD_HAS_WIRELESS_PAIR` is the exact
  // negation of `!BOARD_USES_TFT_ESPI && BOARD_HAS_WIRELESS_PAIR` and four live
  // entries are written that way, so this compares MEANINGS and not text.
  const guards = guardStacks(main);
  const dispAt = main.indexOf(DISPATCH_SIG);
  const dispEnd = dispAt + rawDispatch.length;
  const tabAt = main.indexOf(TABLE_SIG);
  const tabEnd = main.indexOf("\n};", tabAt);
  const lineOf = (() => {
    const nl = [];
    for (let i = 0, n = 0; i < main.length; i++) if (main[i] === "\n") nl.push(i);
    return (off) => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < off) lo = m + 1; else hi = m; } return lo; };
  })();
  // FIRST occurrence inside each region, located rather than listed: the dispatch
  // spells one verb three different ways and the table spells it once.
  const firstLine = (from, to, re) => {
    re.lastIndex = 0;
    const hay = main.slice(from, to);
    const m = re.exec(hay);
    return m ? lineOf(from + m.index) : -1;
  };
  const pairs = [];
  for (const v of [...allRefused].sort()) {
    const hLine = firstLine(dispAt, dispEnd, new RegExp(`buf\\s*(?:==|\\.startsWith\\(|\\.equalsIgnoreCase\\()\\s*"${v}\\s?"`));
    const eLine = firstLine(tabAt, tabEnd, new RegExp(`\\{\\s*"${v}"\\s*,`));
    ok(`${v}: its handler arm and its refusal entry are both located in the source (lines ${hLine + 1} / ${eLine + 1})`,
       hLine >= 0 && eLine >= 0 && guards[hLine] != null && guards[eLine] != null);
    if (hLine < 0 || eLine < 0 || !guards[hLine] || !guards[eLine]) continue;
    pairs.push([v, guards[hLine], guards[eLine]]);
  }
  // POSITIVE CONTROL. A guardStacks() that returned an empty stack for every line
  // would make every pair "true vs true" - which is not a negation, so it would
  // fail loudly rather than pass - but a stack that silently lost only the NESTED
  // levels would still reduce several entries to a true negation by accident. So
  // the parse is required to have found nesting at all.
  ok(`sanity: the guard-stack parse sees nesting (deepest stack ${Math.max(0, ...pairs.map(([, h, e]) => Math.max(h.length, e.length)))} levels)`,
     pairs.some(([, h]) => h.length >= 1) && pairs.some(([, , e]) => e.length >= 1));
  for (const [v, h, e] of pairs) {
    const names = [...new Set([...stackFlags(h), ...stackFlags(e)])].sort();
    ok(`${v}: its two guards name at least one flag between them [${names.join(", ") || "none"}]`,
       names.length >= 1 && names.length <= 12);
    if (!names.length || names.length > 12) continue;
    const bad = [];
    for (let mask = 0; mask < (1 << names.length); mask++) {
      const a = {};
      names.forEach((n, i) => { a[n] = (mask >> i) & 1; });
      let hv, ev;
      try { hv = stackHolds(h, a); ev = stackHolds(e, a); }
      catch (err) { bad.push(err.message); break; }
      if (hv === ev) bad.push(names.map((n) => `${n}=${a[n]}`).join(" ") + ` -> handler ${hv ? "live" : "absent"}, refusal ${ev ? "live" : "absent"}`);
    }
    ok(`${v}: the refusal's guard is the EXACT NEGATION of the handler's, over every assignment of the flags they name ${bad.length ? "[" + bad[0] + "]" : ""}`,
       bad.length === 0);
  }

  // ---- (3c) RECAL, BY NAME - the one verb this file knows in advance ------
  // EVERY OTHER ASSERTION HERE IS BLIND TO THE COMMAND SET, and that is the
  // property this block is a deliberate exception to, so it is worth saying why.
  // Sections (3) and (3b) only ever speak about a verb SOME board has: delete the
  // handler and the table entry together and RECAL leaves `allHandled` and
  // `allRefused` at the same time, and not one assertion above mentions it again.
  // That is precisely how this verb got into trouble in the first place - it was
  // handled on both boards with a stub behind it that printed a notice and
  // returned, so from the Mac it was indistinguishable from a calibration that had
  // run, which is the exact failure CLAUDE.md's refusal rule names.
  //
  // THE GUARD MUST NAME THE CAPABILITY, NOT THE BOARD, and on these two headers
  // BOARD_USES_TFT_ESPI would pass (3) and (3b) just as happily while saying the
  // wrong thing about why: board 1 has a 5-tap affine fit because its touch is a
  // separate resistive controller, not because it draws through real TFT_eSPI.
  {
    const hLine = firstLine(dispAt, dispEnd, /buf\s*==\s*"RECAL"/);
    const eLine = firstLine(tabAt, tabEnd, /\{\s*"RECAL"\s*,/);
    ok("RECAL: handled on board 1, where touch_cal.ino's 5-tap affine fit against the XPT2046 exists",
       state[1].handled.has("RECAL"));
    ok("RECAL: NOT handled on board 2 - a handler with a printing stub behind it answers the Mac the way a successful run would",
       !state[2].handled.has("RECAL"));
    ok('RECAL: refused BY NAME on board 2 - from the Mac, silence and "impossible here" look identical',
       state[2].refused.has("RECAL"));
    const hFlags = hLine >= 0 && guards[hLine] ? [...new Set(stackFlags(guards[hLine]))] : [];
    const eFlags = eLine >= 0 && guards[eLine] ? [...new Set(stackFlags(guards[eLine]))] : [];
    ok(`RECAL: both guards name BOARD_TOUCH_NEEDS_CAL and nothing else, so they name the CAPABILITY rather than the board [handler ${hFlags.join("+") || "none"} / refusal ${eFlags.join("+") || "none"}]`,
       hFlags.length === 1 && hFlags[0] === "BOARD_TOUCH_NEEDS_CAL" &&
       eFlags.length === 1 && eFlags[0] === "BOARD_TOUCH_NEEDS_CAL");
  }

  // ---- (3d) PAGE: ONE RANGE, DERIVED, AND NAMED IN ITS OWN REFUSAL -------
  // PAGE is not in UNAVAILABLE_COMMANDS[] - both boards have it - but its
  // out-of-range answer is the same rule this file exists for one level down. It
  // used to have none: PAGE 9 reached openSettingsGroup(), whose constrain()
  // delivered the last group, so a typo and a hit produced the same screenshot.
  //
  // AND THE BOUND IS THE THING MOST LIKELY TO GO STALE. The group set has been
  // re-cut three times on this branch (seven, five, six), and the two boards
  // numbered their pages differently until Task 3B - so both the derivation and the
  // "same range on both boards" claim are asserted here rather than trusted.
  {
    const pAt = rawDispatch.indexOf('buf.startsWith("PAGE ")');
    const pEnd = rawDispatch.indexOf("\n  } else if", pAt);
    ok("the PAGE arm is located in the dispatch chain", pAt > 0 && pEnd > pAt);
    if (pAt > 0 && pEnd > pAt) {
      const arm = rawDispatch.slice(pAt, pEnd);
      ok("PAGE's upper bound is DERIVED from SET_GROUP_COUNT, never written as a number - the group set has been re-cut three times on this branch",
         /const int pgMax\s*=\s*SET_HOME\s*\+\s*SET_GROUP_COUNT\s*;/.test(arm));
      ok("PAGE range-checks against that derived bound rather than letting openSettingsGroup()'s constrain() swallow the overflow",
         /pg\s*<\s*SET_HOME\s*\|\|\s*pg\s*>\s*pgMax/.test(arm));
      ok("PAGE's out-of-range refusal NAMES the range it checked against, and prints it from the same two terms it compared",
         /PAGE refused:[^"]*outside PAGE %d\.\.%d/.test(arm) && /\bpg,\s*SET_HOME,\s*pgMax\b/.test(arm));
      ok("PAGE refuses the wrong-tab case by name too, instead of the silent no-op it was",
         /currentTab\s*!=\s*TAB_SETTINGS/.test(arm) && /PAGE refused:[^"]*live tab/.test(arm));
      // String::toInt() answers 0 for anything it cannot parse, so a non-numeric
      // argument opened HOME and said nothing while a numeric one out of range was
      // refused - the quiet answer left on the EASIER mistake. The digits test must
      // come before the conversion, or it is testing the conversion's own default.
      const digitsAt = arm.search(/pgArg\[i\]\s*<\s*'0'/);
      const convAt = arm.search(/pgArg\.toInt\(\)/);
      ok("PAGE validates its argument is digits BEFORE converting, so \"PAGE foo\" is not read as PAGE 0",
         digitsAt > 0 && convAt > digitsAt &&
         /is not a page number - PAGE %d\.\.%d/.test(arm));
      // The contiguity the derivation rests on, enforced by the compiler rather than
      // by this comment: SET_GROUP_COUNT alone cannot see whether the ids run
      // unbroken from SET_HOME, and openSettingsGroup() clamps to SET_DANGER.
      ok("a static_assert ties SET_DANGER to SET_HOME + SET_GROUP_COUNT, so a non-contiguous group id fails the compile rather than the range check",
         /static_assert\(\s*SET_DANGER\s*==\s*SET_HOME\s*\+\s*SET_GROUP_COUNT/.test(arm));
      // THE ACCUMULATOR. Every refusal in this arm returns, and a return that does
      // not clear `buf` leaves the refused text for the next bytes to be APPENDED
      // to - one DETAIL 9 produced 63 refusal lines and ~100s of no payloads at all.
      const rets = (arm.match(/\breturn\s*;/g) || []).length;
      const clears = (arm.match(/buf\s*=\s*""\s*;/g) || []).length;
      ok(`every early return in the PAGE arm clears buf first (${clears} clears / ${rets} returns)`,
         rets > 0 && clears >= rets);
    }
    // ...and the range itself, PARSED from both headers rather than read off the
    // source above, so "one range on both boards" is a measurement.
    const ids = {};
    for (const b of [1, 2]) {
      ids[b] = {};
      for (const m of hdr[b].matchAll(/\b(SET_[A-Z_]+)\s*=\s*(\d+)/g)) ids[b][m[1]] = Number(m[2]);
      ok(`board ${b}: SET_HOME/SET_DANGER/SET_GROUP_COUNT all parse out of ${HDR[b]}`,
         ["SET_HOME", "SET_DANGER", "SET_GROUP_COUNT"].every((k) => Number.isInteger(ids[b][k])));
      ok(`board ${b}: the group ids are contiguous from SET_HOME, which is what makes SET_HOME + SET_GROUP_COUNT the last valid PAGE (${ids[b].SET_HOME} + ${ids[b].SET_GROUP_COUNT} == ${ids[b].SET_DANGER})`,
         ids[b].SET_DANGER === ids[b].SET_HOME + ids[b].SET_GROUP_COUNT);
    }
    ok(`PAGE means the same thing on both boards: 0..${ids[1].SET_HOME + ids[1].SET_GROUP_COUNT} here and 0..${ids[2].SET_HOME + ids[2].SET_GROUP_COUNT} there`,
       ids[1].SET_HOME === ids[2].SET_HOME && ids[1].SET_GROUP_COUNT === ids[2].SET_GROUP_COUNT);
    // ...AND CLAUDE.md'S COPY OF THE NUMBER, which is the one place it is a bare
    // numeral. The command table's PAGE row names SET_GROUP_COUNT for the range
    // itself, so the range cannot go stale - but it quotes today's value once, for a
    // reader who wants to know what to type without opening a header, and NOTHING
    // PARSED THAT. The group set has been re-cut three times on this branch; a
    // fourth would leave that numeral wrong with no assertion anywhere noticing,
    // which is exactly the hazard the static_assert now defends against in code.
    // board-baseline.mjs --doc-check binds four numbers in CLAUDE.md the same way
    // and for the same reason. The phrase is fixed so this can find it.
    const docM = /SET_GROUP_COUNT is (\d+) today/.exec(claudeMd);
    ok(`CLAUDE.md's command table states SET_GROUP_COUNT's value in the parseable phrase this binds to ${docM ? "" : "[phrase not found - see the PAGE row]"}`,
       docM != null);
    if (docM)
      ok(`CLAUDE.md's quoted SET_GROUP_COUNT (${docM[1]}) matches both headers (${ids[1].SET_GROUP_COUNT} / ${ids[2].SET_GROUP_COUNT})`,
         Number(docM[1]) === ids[1].SET_GROUP_COUNT && Number(docM[1]) === ids[2].SET_GROUP_COUNT);
    // And the range itself must be written as the CONSTANT, not as numbers: a row
    // reading "PAGE 0..6" would satisfy the two assertions above and still be the
    // transcription this is here to prevent.
    ok("CLAUDE.md's PAGE row names the range by its constant (PAGE 0..SET_GROUP_COUNT), not by a numeral",
       /`PAGE 0\.\.SET_GROUP_COUNT`/.test(claudeMd) && !/`PAGE 0\.\.\d/.test(claudeMd));
  }

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

  // ---- (5b) AND THE MAC MUST NOT SWALLOW THE REFUSAL ---------------------
  // 28795e3 fixed ONE instance of this: host/index.mjs's `BLEMTU ` arm returned
  // on any line starting with that prefix, which silently ate board 1's
  // "BLEMTU refused on E32R28T: ..." - correctly emitted by the device, never
  // shown, and from the Mac indistinguishable from the silence this whole table
  // exists to remove. That fix closed the instance and nothing closed the CLASS,
  // and the class was checked by a reviewer enumerating 24 verbs against the
  // handler's prefixes BY HAND. This is the assertion that keeps it true.
  //
  // The rule: a device line is logged by the general `[device/<link>]` line at the
  // end of the handler, so any earlier arm that RETURNS without logging swallows
  // whatever it matched. Every such arm's prefix is parsed out of the handler
  // itself - never listed here - and no verb's refusal line may fall into one.
  // Asserted for EVERY verb the dispatch has, not only the ones refused today: a
  // verb that gains a table entry later must not have to rediscover this.
  {
    const hostSrc = over.host != null ? over.host
      : fs.readFileSync(`${DIR}/../../host/index.mjs`, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
    const LOG = "console.log(`[device/${linkLabel(via)}] ${line}`);";
    // The GENERAL log is the one at the handler's own top level (two spaces of
    // indent); the earlier copies sit inside arms and are indented further.
    const generalAt = hostSrc.indexOf(`\n  ${LOG}`);
    ok("HOST: the general [device/...] log line is found in host/index.mjs", generalAt > 0);
    if (generalAt > 0) {
      const window = hostSrc.slice(0, generalAt);
      // Every arm before it, brace-matched from its own `if`, so a nested arm is
      // read as itself rather than as part of its parent.
      const swallow = [];
      const ARM = /if \(line\.startsWith\("([^"]+)"\)\)|if \(line === "([^"]+)"\)/g;
      for (const m of window.matchAll(ARM)) {
        const lit = m[1] || m[2];
        // BRACELESS ARMS COUNT TOO. `if (line.startsWith("TEMP")) return;` is the
        // cheapest possible way to reintroduce this and has no block at all, so a
        // brace-only parse reads it as the NEXT arm's block and misses it.
        const after = window.slice(m.index + m[0].length);
        let block;
        if (after.replace(/^\s*/, "").startsWith("{")) {
          const open = window.indexOf("{", m.index + m[0].length - 1);
          let d = 0, close = -1;
          for (let j = open; j < window.length; j++) {
            if (window[j] === "{") d++;
            else if (window[j] === "}" && --d === 0) { close = j; break; }
          }
          block = close > open ? window.slice(open, close) : "";
        } else block = after.slice(0, after.indexOf(";") + 1);
        if (/\breturn\b/.test(block) && !block.includes("[device/")) swallow.push([lit, !!m[1]]);
      }
      ok(`HOST: the handler's silently-returning arms parse (${swallow.length}) ` +
         `[${swallow.map(([l]) => JSON.stringify(l)).join(", ")}]`,
         swallow.length >= 2);
      const eaten = [];
      for (const v of [...new Set([...allHandled, ...allRefused])].sort()) {
        // The exact text refuseUnavailableCommand builds, less the board name and
        // the cause - which is all any prefix here could ever see.
        const refusal = `${v} refused on `;
        for (const [lit, isPrefix] of swallow)
          if (isPrefix ? refusal.startsWith(lit) : refusal === lit) eaten.push(`${v} <- ${lit}`);
      }
      ok(`HOST: no verb's "<VERB> refused on <board>: ..." line is swallowed by an arm that ` +
         `returns before the general device log ${eaten.length ? "[" + eaten.join(", ") + "]" : ""}`,
         eaten.length === 0);
    }
  }

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
const realHost = fs.readFileSync(`${DIR}/../../host/index.mjs`, "utf8")
  .replace(/^[ \t]*\/\/.*$/gm, "");
const realClaudeMd = fs.readFileSync(`${DIR}/../../CLAUDE.md`, "utf8");
// One arm of host/index.mjs's device-line handler, LOCATED by its own literal and
// brace-matched, with the `[device/...]` log removed from it - i.e. the shape
// 28795e3 fixed for BLEMTU, put back.
function unlogArm(src, lit) {
  const at = src.indexOf(`if (line.startsWith("${lit}"))`);
  if (at < 0) return src;
  const open = src.indexOf("{", at);
  let d = 0, close = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}" && --d === 0) { close = j; break; }
  }
  if (close < 0) return src;
  const block = src.slice(open, close);
  return src.slice(0, open) + block.replace(/\n[ \t]*console\.log\(`\[device\/[^\n]*\n/, "\n") +
         src.slice(close);
}
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
// THE `#if` LINE THAT OPENS THE BLOCK A LITERAL SITS IN, and the `#endif` that
// closes it - both LOCATED from the literal rather than quoted, for dropEntry's
// reason: a fault that transcribes the guard it edits stops injecting the next time
// the guard is reworded, and an injection that applies nothing leaves the property
// it was proving unproven while the selftest still prints a pass.
function guardSpan(src, lit) {
  const at = src.indexOf(lit);
  if (at < 0) return null;
  const g0 = src.lastIndexOf("\n#if", at);
  if (g0 < 0) return null;
  const g1 = src.indexOf("\n", g0 + 1);
  let depth = 1, i = g1, end = -1;
  while (i < src.length && depth > 0) {
    const nx = src.indexOf("\n#", i + 1);
    if (nx < 0) break;
    const line = src.slice(nx + 1, src.indexOf("\n", nx + 1));
    if (/^#if/.test(line)) depth++;
    else if (/^#endif/.test(line)) { depth--; if (!depth) end = nx; }
    i = nx;
  }
  return end < 0 ? null : { g0: g0 + 1, g1, text: src.slice(g0 + 1, g1), end, endLine: src.indexOf("\n", end + 1) };
}
function rewriteGuard(src, lit, fn) {
  const sp = guardSpan(src, lit);
  if (!sp) return src;
  return src.slice(0, sp.g0) + fn(sp.text) + src.slice(sp.g1);
}
function dropGuardedArm(src, lit) {
  const sp = guardSpan(src, lit);
  if (!sp) return src;
  return src.slice(0, sp.g0) + src.slice(sp.endLine + 1);
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
  // ---- Task 5: RECAL, and the three ways its refusal can come undone ----
  // The first two are caught by the blind cross-board sections; the third and
  // fourth exist because those sections CANNOT see them, which is what (3b) and
  // (3c) were added for.
  ["RECAL's refusal entry is deleted, so board 2 answers a calibration it cannot run with silence",
    { main: dropEntry(realMain, "RECAL") }],
  ["RECAL's handler loses its guard, so board 2 handles it again with nothing behind it",
    { main: rewriteGuard(realMain, '} else if (buf == "RECAL") {', () => "#if 1") }],
  ["RECAL's refusal is guarded on a WIDER condition than the negation of its handler's - correct on today's two boards, wrong on any board that sets both flags",
    { main: rewriteGuard(realMain, '{ "RECAL",', (g) => `${g} || BOARD_HISTORY_SCROLL`) }],
  ["RECAL disappears entirely - handler and refusal deleted together, which every section that speaks only about verbs SOME board has is blind to",
    { main: dropEntry(dropGuardedArm(realMain, '} else if (buf == "RECAL") {'), "RECAL") }],
  // ---- Task 5: PAGE's bound ----
  ["PAGE's bound is transcribed as a literal, so the next group re-cut leaves it stale",
    { main: realMain.replace("const int pgMax = SET_HOME + SET_GROUP_COUNT;", "const int pgMax = 6;") }],
  ["PAGE's out-of-range refusal stops naming the range it checked against",
    { main: realMain.replace(/PAGE refused: %d is outside PAGE %d\.\.%d[^"]*/, "PAGE refused: out of range") }],
  ["one board's group set is re-cut and the other's is not, so PAGE n means two different screens again",
    { h1: realH1.replace(/const int SET_GROUP_COUNT = 6;/, "const int SET_GROUP_COUNT = 5;") }],
  ["CLAUDE.md's quoted SET_GROUP_COUNT goes stale after a fourth re-cut of the group set",
    { claudemd: realClaudeMd.replace(/SET_GROUP_COUNT is \d+ today/, "SET_GROUP_COUNT is 7 today") }],
  ["CLAUDE.md's PAGE row goes back to transcribing the range as numbers",
    { claudemd: realClaudeMd.replace(/`PAGE 0\.\.SET_GROUP_COUNT`/, "`PAGE 0..6`") }],
  ["PAGE goes back to trusting String::toInt(), so \"PAGE foo\" silently means PAGE 0",
    { main: realMain.replace(/\n\s*if \(pgArg\[i\][^\n]*\n/, "\n") }],
  // ---- m6: the CLASS the BLEMTU fix closed only one instance of ----
  ["the Mac's BLEMTU arm goes back to returning before it logs (28795e3, reverted)",
    { host: unlogArm(realHost, "BLEMTU ") }],
  ["a new host arm swallows a verb's refusal on its way to the log",
    { host: realHost.replace("\n  console.log(`[device/${linkLabel(via)}] ${line}`);",
        '\n  if (line.startsWith("TEMP")) return;\n  console.log(`[device/${linkLabel(via)}] ${line}`);') }],
];

let caught = 0;
for (const [name, over] of faults) {
  const unchanged = (over.main == null || over.main === realMain) &&
                    (over.h1 == null || over.h1 === realH1) &&
                    (over.host == null || over.host === realHost) &&
                    (over.claudemd == null || over.claudemd === realClaudeMd);
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
