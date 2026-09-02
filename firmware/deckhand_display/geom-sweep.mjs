// FAULT-INJECTION SWEEP over the three geometry checkers - runs on the Mac, needs
// no hardware.
//
// WHY THIS EXISTS. usage-geom-check.mjs, sessions-geom-check.mjs and
// settings-geom-check.mjs were the primary evidence that board 2's re-derived
// layout is correct, because for most of that port the panel could not be seen.
// Each carries a --selftest that injects exactly ONE hand-picked fault and
// confirms an assertion fires. Three proven assertions out of roughly 180 proves
// the checkers are not INERT; it proves nothing whatever about the other ~177. A
// checker with 180 assertions of which 3 are known to work is not evidence, it is
// an untested test suite guarding the one thing nobody could look at.
//
// WHAT IT DOES. For each checker, each board and every constant that checker
// PARSES, it perturbs that constant and re-runs the whole checker. If no assertion
// fails, that constant is UNGUARDED: nothing in the checker depends on it, so it
// could be wrong by the perturbed amount and the checker would still pass. The
// output is that list, plus - for the guarded ones - the SMALLEST perturbation
// that was caught, which is the more useful number: it says how much headroom each
// constant really has before something on the glass breaks.
//
//   node geom-sweep.mjs                     sweep all three checkers, both boards
//   node geom-sweep.mjs --checker sessions             one checker, both boards
//        ^ UNSLICED, AND ON `sessions` IT OOMs - see the memory note below. The
//          slicing lives in the PARENT, so the plain sweep is fine and this
//          hand-run form runs a whole board's ~1100 injections in one process.
//          Add --board <n> --slice <i>/4 (what the parent passes) to run it by hand.
//   node geom-sweep.mjs --checker sessions --board 2    one checker, one board
//                        (plus --slice i/n is how the children the parent spawns run)
//   node geom-sweep.mjs --verbose           add the per-constant table
//
// IT EXITS 0 EVEN WHEN CONSTANTS ARE UNGUARDED, deliberately. An unguarded
// constant is a FINDING - usually a correct one, since a colour, a beep frequency
// or a purely cosmetic gap has no geometric constraint to violate - and wiring it
// to a non-zero exit would make this un-runnable in any check-everything pass
// until someone had either written 150 assertions or suppressed the list, and a
// suppressed list is how a sweep stops being read. Non-zero is reserved for the
// sweep's own internal errors: a checker that fails BEFORE any injection, an
// injection that does not land exactly once (which would mean a constant attributed
// to the wrong board), or a crash in the driver itself. Those make the numbers
// meaningless, which is a different thing from the numbers being uncomfortable.
//
// PERTURBATION SIZES ARE A RANGE, +-1, +-4, +-16, AND THAT MATTERS. A +1 on a
// constant with seven rows of deliberate slack correctly fails nothing - that is
// slack, not a gap - so a single-size sweep would report a large amount of healthy
// headroom as missing coverage. The sweep reports the smallest size that was
// caught and calls a constant unguarded only when +-16 in both directions goes
// unnoticed by all ~180 assertions.
//
// HOW A CHECKER IS RE-RUN. Its module is imported with a fresh query string, which
// re-executes its top-level code - that top level IS the checker - so no checker
// needed restructuring to be driven from here, and none of their standalone
// behaviour (output, exit codes, --selftest) is touched. console.log and
// process.exit are captured for the duration of each run, and process.argv is
// blanked so a flag passed to the SWEEP can never be read by a checker as
// --selftest. The parse-time injection seam itself lives in geom-common.mjs, which
// is where the reason it has to be parse-time rather than table-time is written
// down.
//
// ONE CHILD PROCESS PER (CHECKER, BOARD), and the reason is CODE SPACE rather than
// the heap. Every re-import is a module instance the ESM cache can never release,
// and a module instance is COMPILED CODE - on arm64 macOS V8's code range is a
// separate, much smaller region than the old-space limit, so this fails as
// `CALL_AND_RETRY_LAST Allocation failed` on a REGEXP CODE OBJECT at ~840MB of heap
// while `v8.getHeapStatistics().heap_size_limit` says 4.5GB. That is why
// `--max-old-space-size` does nothing here and was tried and reverted: raising a
// limit that is not the one being hit changes nothing. Nor is it one pathological
// injection: instrumented per run, no single run exceeded 222ms and the heap climbed
// monotonically from the first, so it is RETENTION - measured at ~0.9MB a run, which
// puts the wall at roughly 950 runs.
//
// A child per checker used to be just barely enough. Once this branch grew the
// sessions checker it stopped being, and the failure mode was the worst kind: ONE
// BOARD of that checker needs ~1100 runs (238 constants, and an unguarded one costs
// all six magnitudes), so it completed on an idle machine and died while a compile
// was running - a diagnostic whose answer depends on the weather. So the split is now
// per (checker, BOARD, SLICE), with SLICES a real ceiling on retention: ~280 runs a
// child, roughly 250MB, about a quarter of where it fails. Raise SLICES, not the
// heap. The union below already merges per (board, constant), so partial results from
// any number of children combine unchanged.
import { beginRecord, endRecord, injectHitCount, setInject, DIR } from "./geom-common.mjs";
import fs from "fs";
import { spawnSync } from "child_process";

const CHECKERS = {
  usage: "usage-geom-check.mjs",
  sessions: "sessions-geom-check.mjs",
  settings: "settings-geom-check.mjs",
};
// Ascending magnitude, both signs. The sweep stops at the first magnitude that is
// caught, so the common case costs 1-2 runs and only a genuinely unguarded
// constant costs all six.
// Overridable, because "unguarded at +-16" and "unconstrained at any size" are
// different findings and the second one is the one worth acting on: a constant with
// 60px of genuine slack (board 2's page 2 has 154) is correctly caught by nothing at
// 16 and caught at 64, while one that no assertion mentions is never caught at all.
// The default stays 1/4/16 so the headline numbers mean the same thing run to run.
const MAGNITUDES = (() => {
  const i = process.argv.indexOf("--magnitudes");
  if (i < 0) return [1, 4, 16];
  return process.argv[i + 1].split(",").map(Number).filter(n => n > 0).sort((a, b) => a - b);
})();
const VERBOSE = process.argv.includes("--verbose");
// How many child processes each (checker, board) is split across - a ceiling on
// runs-per-process, see the note at the top of this file.
//
// 4 -> 8 BECAUSE 4 STOPPED BEING ENOUGH, AND IT FAILED IN THE WAY THE NOTE ABOVE
// PREDICTS RATHER THAN IN A NEW WAY. At 4, three of the four sessions/board-2
// children OOM'd on a REGEXP CODE OBJECT at ~1070MB, the sweep printed its own
// "3 checker sweep(s) hit an INTERNAL ERROR" line and exited 1 - loud about the
// failure, and quiet about the cost, which was that the ONE surviving slice's 94
// constants were all that reached the union: every SESSION_*/DETAIL_*/ASK_*
// constant then appeared under "read by no checker", because the checker that
// constrains them was absent. That is the documented shape, one branch later.
// Board 2 parses 376 constants against board 1's 237, so a quarter-slice there is
// ~94 constants and an unguarded one costs all six magnitudes; 8 puts it back to
// ~47, well inside the wall. RAISE THIS, NEVER THE HEAP - the limit is V8's CODE
// space and --max-old-space-size provably does nothing (measured: death at 840MB
// against a 4.5GB heap limit).
const SLICES = 8;

// ---- running one checker, once ----
class Exited extends Error { }
let runSeq = 0;
async function runChecker(file) {
  const out = [];
  const realLog = console.log, realErr = console.error;
  const realExit = process.exit, realArgv = process.argv;
  console.log = (...a) => out.push(a.map(String).join(" "));
  console.error = (...a) => out.push(a.map(String).join(" "));
  process.exit = (code) => { const e = new Exited(); e.code = code | 0; throw e; };
  process.argv = realArgv.slice(0, 2);
  let crash = null;
  try { await import(`./${file}?sweep=${++runSeq}`); }
  catch (e) { if (!(e instanceof Exited)) crash = e; }
  finally {
    console.log = realLog; console.error = realErr;
    process.exit = realExit; process.argv = realArgv;
  }
  return {
    fails: out.filter(l => l.startsWith(" FAIL ")),
    knowns: out.filter(l => l.startsWith(" known ")),
    out, crash,
  };
}

// ---- sweeping one checker ----
async function sweep(key, onlyBoard, slice) {
  const file = CHECKERS[key];
  const src = fs.readFileSync(`${DIR}/${file}`, "utf8");
  // The universe of constants comes from the checker's own parse, recorded as it
  // runs, rather than from a list here - a list would drift the moment a checker
  // started parsing one more file, and it would drift SILENTLY, which is the
  // failure mode this whole tool exists to close.
  beginRecord();
  const base = await runChecker(file);
  const seen = endRecord();
  if (base.crash) {
    console.log(`INTERNAL ERROR: ${file} crashed before any injection:\n${base.crash.stack}`);
    return null;
  }
  // A CHECKER MAY LEGITIMATELY BE FAILING ALREADY, and refusing to run in that case
  // was wrong: usage-geom-check.mjs now reports a real, unfixed board-2 defect (its
  // waiting screen's logo and wordmark overlap by 4px), and a sweep that stops
  // working the moment a checker finds something is a sweep nobody can use when it
  // matters most. So the baseline's failures are recorded as a SIGNATURE and an
  // injection counts as caught when the signature CHANGES - which also covers the
  // case where a perturbation silences a standing failure rather than adding one.
  // Comparing text rather than counting is what makes that work, since every message
  // carries the numbers it compared.
  const sig = (r) => r.fails.slice().sort().join("\n");
  const baseSig = sig(base);
  if (base.fails.length) {
    console.log(`NOTE: ${file} reports ${base.fails.length} failure(s) with no fault injected - ` +
                `real findings, not sweep artefacts. An injection counts as caught when it CHANGES this set:`);
    for (const f of base.fails) console.log(`  ${f}`);
  }
  // The baseline's KNOWN lines are kept as TEXT, not as a count. A perturbation
  // that turns a passing assertion into a KNOWN-tolerated one is invisible to a
  // count (board 1 already has some at baseline) but not to the text, because
  // every message carries the numbers it compared - and that case matters: it
  // means an assertion DID fire and a documented board-1 allowance absorbed it,
  // which is not the same finding as nothing noticing at all.
  const baseKnown = new Set(base.knowns);

  const boards = {};
  let internal = 0;
  for (const tag of seen) {
    const [b, name] = [+tag.slice(0, tag.indexOf(":")), tag.slice(tag.indexOf(":") + 1)];
    // The BASELINE run still parses both boards - it has to, that is the checker -
    // so the filter is on which board's constants this child PERTURBS.
    if (onlyBoard && b !== onlyBoard) continue;
    (boards[b] ||= []).push(name);
  }
  const result = { key, file, boards: {} };
  for (const b of Object.keys(boards).map(Number).sort()) {
    const rows = [];
    // Sliced by index MODULO n rather than by contiguous range, so every child gets a
    // mix of guarded (2 runs) and unguarded (6 runs) constants. A contiguous range
    // would put the whole SESSION_* block - almost all of it unguarded in the usage
    // and settings checkers - into one child, and defeat the bound this exists for.
    for (const [i, name] of boards[b].entries()) {
      if (slice && i % slice.n !== slice.i) continue;
      const row = { name, caught: 0, dirs: "", crash: false, masked: false,
                    // Referenced-by-the-checker is not a verdict, it is a triage
                    // aid: an unguarded constant the checker never even mentions
                    // is trivially unguarded, while one it reads and still does
                    // not constrain is where a missing assertion hides.
                    referenced: new RegExp(`\\b${name}\\b`).test(src) };
      outer:
      for (const mag of MAGNITUDES) {
        for (const delta of [mag, -mag]) {
          setInject({ board: b, name, delta });
          const r = await runChecker(file);
          const hits = injectHitCount();
          setInject(null);
          if (hits !== 1) {
            console.log(`INTERNAL ERROR: injecting ${name} on board ${b} landed ${hits} times (expected 1)`);
            internal++;
            break outer;
          }
          if (r.crash) { row.crash = true; row.caught = mag; row.dirs += delta > 0 ? "+" : "-"; }
          else if (sig(r) !== baseSig) { row.caught = mag; row.dirs += delta > 0 ? "+" : "-"; }
          else if (r.knowns.some(l => !baseKnown.has(l))) row.masked = true;
        }
        if (row.caught) break;
      }
      rows.push(row);
    }
    result.boards[b] = rows;
  }
  result.internal = internal;
  return result;
}

// ---- reporting ----
//
// A per-checker "unguarded" list is mostly noise on its own, and it took a first
// run to see why: all three checkers parse the WHOLE board header, so the usage
// checker legitimately does not constrain SESSION_* or KB_* and reports 108 of
// its 136 constants as unguarded. Those are covered by a sibling checker. So the
// per-checker section reports only the constants a checker READS and still does
// not constrain - which is where a missing assertion actually hides - and the
// verdict that matters, "no checker anywhere catches this", is the union below.
function report(r) {
  console.log(`\n=== ${r.file} ===`);
  for (const b of Object.keys(r.boards)) {
    const rows = r.boards[b];
    const guarded = rows.filter(x => x.caught);
    const un = rows.filter(x => !x.caught);
    const hist = MAGNITUDES.map(m => `|${m}| ${guarded.filter(x => x.caught === m).length}`).join("  ");
    const oneSided = guarded.filter(x => x.dirs.length === 1);
    const crashes = guarded.filter(x => x.crash);
    const masked = un.filter(x => x.masked);
    const ref = un.filter(x => x.referenced), noref = un.filter(x => !x.referenced);
    console.log(`board ${b}: swept ${rows.length}, guarded ${guarded.length} ` +
                `(${Math.round(100 * guarded.length / rows.length)}%), unguarded ${un.length} ` +
                `(${noref.length} of those this checker parses but never reads - a sibling's territory)`);
    console.log(`  smallest caught:  ${hist}   one direction only: ${oneSided.length}` +
                (crashes.length ? `   caught only as a CRASH: ${crashes.map(x => x.name).join(", ")}` : ""));
    if (masked.length)
      console.log(`  an assertion FIRED and a KNOWN allowance absorbed it: ${masked.map(x => x.name).join(", ")}`);
    if (ref.length) console.log(`  UNGUARDED though this checker reads it (${ref.length}): ${ref.map(x => x.name).join(" ")}`);
    if (VERBOSE)
      for (const x of rows)
        console.log(`    ${x.name.padEnd(24)} ${x.caught ? `caught at |${x.caught}| ${x.dirs}` : "UNGUARDED"}` +
                    `${x.crash ? " (crash)" : ""}${x.masked ? " (known-absorbed)" : ""}${x.referenced ? "" : " [not read here]"}`);
  }
}

// ---- the parent: one child per checker, then the combined summary ----
const arg = process.argv.indexOf("--checker");
if (arg >= 0) {
  const key = process.argv[arg + 1];
  if (!CHECKERS[key]) { console.log(`unknown checker "${key}"`); process.exit(1); }
  const bArg = process.argv.indexOf("--board");
  const sArg = process.argv.indexOf("--slice");
  const slice = sArg >= 0
    ? { i: +process.argv[sArg + 1].split("/")[0], n: +process.argv[sArg + 1].split("/")[1] }
    : null;
  const r = await sweep(key, bArg >= 0 ? +process.argv[bArg + 1] : 0, slice);
  if (!r) process.exit(1);
  // A SLICE reports nothing on its own - the parent merges the slices and reports the
  // whole board, because "guarded 18 of 60" for a quarter of one board is not a fact
  // about anything. A hand-run --checker (optionally --board) still reports normally.
  if (!slice) report(r);
  console.log(`SWEEP-JSON ${JSON.stringify(r)}`);
  process.exit(r.internal ? 1 : 0);
}

const all = [];
let bad = 0;
for (const key of Object.keys(CHECKERS)) {
  const merged = { key, file: CHECKERS[key], boards: {}, internal: 0 };
  for (const board of [1, 2]) for (let i = 0; i < SLICES; i++) {
    const p = spawnSync(process.execPath, [new URL(import.meta.url).pathname, "--checker", key,
                                           "--board", String(board),
                                           "--slice", `${i}/${SLICES}`,
                                           "--magnitudes", MAGNITUDES.join(","),
                                           ...(VERBOSE ? ["--verbose"] : [])],
                        { encoding: "utf8", maxBuffer: 1 << 26 });
    const lines = (p.stdout || "").split("\n");
    for (const l of lines) {
      if (l.startsWith("SWEEP-JSON ")) {
        const r = JSON.parse(l.slice(11));
        for (const b of Object.keys(r.boards)) (merged.boards[b] ||= []).push(...r.boards[b]);
        merged.internal += r.internal;
        continue;
      }
      // A slice prints no report of its own, but it DOES print the baseline's
      // standing failures and any INTERNAL ERROR - once per slice, since every
      // slice runs the baseline. Only the first slice's copy is passed through, or
      // the same real finding is repeated eight times and reads as eight findings.
      if (l.length && board === 1 && i === 0) console.log(l);
    }
    if (p.stderr) process.stderr.write(p.stderr);
    if (p.status !== 0) bad++;
  }
  report(merged);
  all.push(merged);
}

// The union: one row per (board, constant), merged across every checker that
// parses it. This is the map the task asked for - which numbers are load-bearing
// somewhere, and which could be wrong in any amount and no checker would say so.
console.log(`\n=== union across ${all.length} checkers ===`);
const U = {};                       // board -> name -> merged row
for (const r of all)
  for (const b of Object.keys(r.boards))
    for (const x of r.boards[b]) {
      const u = ((U[b] ||= {})[x.name] ||= { caught: 0, by: [], reads: [], masked: [] });
      if (x.caught && (!u.caught || x.caught < u.caught)) u.caught = x.caught;
      if (x.caught) u.by.push(r.key);
      if (x.referenced) u.reads.push(r.key);
      if (x.masked) u.masked.push(r.key);
    }
let swept = 0, guarded = 0;
const headline = [];
for (const b of Object.keys(U)) {
  const names = Object.keys(U[b]);
  const un = names.filter(n => !U[b][n].caught);
  const g = names.length - un.length;
  swept += names.length; guarded += g;
  const hist = MAGNITUDES.map(m => `|${m}| ${names.filter(n => U[b][n].caught === m).length}`).join("  ");
  console.log(`board ${b}: ${names.length} constants, ${g} guarded by at least one checker (${hist}), ${un.length} unguarded`);
  const read = un.filter(n => U[b][n].reads.length), never = un.filter(n => !U[b][n].reads.length);
  const mask = un.filter(n => U[b][n].masked.length);
  if (mask.length) console.log(`  KNOWN-absorbed (an assertion fires, a documented board-${b} allowance tolerates it): ` +
                               mask.map(n => `${n} [${U[b][n].masked.join("/")}]`).join(", "));
  console.log(`  UNGUARDED and read by a checker (${read.length}): ` +
              (read.map(n => `${n} [${U[b][n].reads.join("/")}]`).join(", ") || "none"));
  console.log(`  unguarded, read by no checker (${never.length}): ${never.join(" ") || "none"}`);
  headline.push(`board ${b} ${un.length}/${names.length} unguarded`);
}
console.log(`\n=== sweep summary ===`);
console.log(`${swept} constant-board pairs swept across ${all.length} checkers and ` +
            `${MAGNITUDES.map(m => `+-${m}`).join("/")} perturbations: ${guarded} guarded, ${swept - guarded} unguarded (${headline.join(", ")})`);
if (bad) { console.log(`\n${bad} checker sweep(s) hit an INTERNAL ERROR - the numbers above are incomplete`); process.exit(1); }
console.log("sweep complete - unguarded constants are findings, not failures (see this file's header)");
