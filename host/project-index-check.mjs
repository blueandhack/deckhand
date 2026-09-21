// Checks project-index without a filesystem or a running host.
//
// THE ONE RULE THIS FILE EXISTS FOR: a project directory name is a LOSSY path
// encoding and must never be decoded. "-Users-yujia-work-claude-plugins" is
// /Users/yujia/work/claude-plugins, NOT /Users/yujia/work/claude/plugins - the
// hyphen in the project's own name is indistinguishable from a separator. A
// decoder would be right for most paths and silently wrong for every hyphenated
// project and every worktree, which is the worst available failure shape.
//
// The assertion suite takes the implementation as a PARAMETER (the house shape:
// see firmware/deckhand_display/commands-check.mjs's suite(ok, over) / run(over,
// quiet)), so --selftest can run the exact same suite against a deliberately
// broken stand-in and prove each assertion can actually FAIL. The first version
// of this file's --selftest compared a standalone decoder lambda against a
// string literal - a MIRROR that never called cwdFromLines, projectLabel or
// pickTranscript at all, and would have passed with project-index.mjs deleted.
import * as realModule from "./project-index.mjs";
import fs from "node:fs";

const SELFTEST = process.argv.includes("--selftest");

// The STRUCTURAL half, added for Task 2: transcriptPathFor is what makes a
// DEAD session's transcript reachable, and the defect it guards against is a
// function that exists but only ever falls back to the live map - which reads
// as "handled" and leaves every ended session unreadable. So this reads
// index.mjs's own TEXT rather than calling anything, and is bound to
// transcriptPathFor's FUNCTION BODY specifically (never the whole file), per
// "a rule a neighbouring line can satisfy is not a rule" - a stray
// `pickTranscript(` anywhere else in the file must not make this pass.
const HOST_SRC = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
function suite(mod, check) {
  // cwd is not on line 1 - the measured file opens with a queue-operation - so a
  // reader that only looks at the head of the file finds nothing.
  const REAL = [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"queue-operation","operation":"dequeue"}',
    '{"parentUuid":null,"cwd":"/Users/yujia/work/claude-plugins","type":"user"}',
  ];
  check("cwd is found past line 1", mod.cwdFromLines(REAL), "/Users/yujia/work/claude-plugins");
  check("no cwd anywhere is null, not a guess", mod.cwdFromLines(REAL.slice(0, 2)), null);
  check("empty input is null", mod.cwdFromLines([]), null);

  // The boundary SCAN_LINES exists for: a cwd sitting AT OR PAST the scan window
  // must not be found. Derived from mod.SCAN_LINES rather than a hardcoded 40/45
  // so this fails by name if the constant changes without this test being
  // re-derived (parse, never transcribe).
  const beyond = Array.from({ length: mod.SCAN_LINES + 5 }, (_, i) =>
    i === mod.SCAN_LINES + 2 ? '{"cwd":"/should/not/be/found"}' : '{"type":"noise"}');
  check("a cwd sitting past SCAN_LINES is not found", mod.cwdFromLines(beyond), null);

  check("a hyphenated project keeps its hyphen",
    mod.projectLabel("/Users/yujia/work/claude-plugins"), "claude-plugins");
  check("a worktree keeps its own last segment",
    mod.projectLabel("/Users/yujia/projects/deckhand/.claude/worktrees/session-ranking"),
    "session-ranking");
  check("a trailing slash does not yield an empty label",
    mod.projectLabel("/Users/yujia/work/parallax/"), "parallax");
  // Edge cases nothing above exercises: no path at all, and a path with nothing
  // to strip. Pinning today's actual behaviour so a future regression fails BY
  // NAME rather than silently, not asserting these ought to behave differently.
  check("an empty string has an empty label", mod.projectLabel(""), "");
  check("a slash-less string is its own label", mod.projectLabel("deckhand"), "deckhand");

  const FILES = ["abc123456789-aaaa.jsonl", "def123456789-bbbb.jsonl", "notes.txt"];
  check("exact 12-char prefix resolves",
    mod.pickTranscript(FILES, "abc123456789"), { ok: true, file: "abc123456789-aaaa.jsonl" });
  check("a non-jsonl is never returned",
    mod.pickTranscript(["abc123456789.txt"], "abc123456789"), { ok: false, reason: "none" });
  check("no match is reported, not guessed",
    mod.pickTranscript(FILES, "999999999999"), { ok: false, reason: "none" });
  check("empty id is rejected", mod.pickTranscript(FILES, ""), { ok: false, reason: "empty" });
  // The same bug session-lookup.mjs exists for: two files sharing a prefix must
  // NOT silently pick the first. Resuming into the wrong conversation is worse
  // than refusing.
  check("ambiguous prefix is refused",
    mod.pickTranscript(["abc123456789-a.jsonl", "abc123456789-b.jsonl"], "abc123456789"),
    { ok: false, reason: "ambiguous" });
}

// Runs the suite against `mod`, collecting pass/fail rather than exiting, so
// --selftest can run it twice (real module, then a broken stand-in) in one
// process. `quiet` suppresses PASS lines during the selftest runs - only the
// fault-injection summary at the bottom needs to be legible there.
function run(mod, quiet) {
  const failures = [];
  let pass = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; if (!quiet) console.log(`  PASS  ${name}`); }
    else {
      failures.push(name);
      if (!quiet) console.log(`  FAIL  ${name}` +
        `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
    }
  };
  try { suite(mod, check); }
  catch (e) { failures.push(`THREW: ${e.message}`); if (!quiet) console.log(`  FAIL  THREW: ${e.message}`); }
  return { pass, failures };
}

// The structural suite, over index.mjs's own source text rather than a module's
// exports - a different KIND of assertion from `suite` above, so it gets its own
// runner (`runHost`) and its own fault set below, following the house pattern in
// firmware/deckhand_display/commands-check.mjs (`over.main` supplies substitute
// source text; `run(over, quiet)` runs the same suite against it).
function suiteHost(check, hostSrc) {
  const body = (name) => {
    const at = hostSrc.indexOf(`function ${name}(`);
    if (at < 0) return "";
    return hostSrc.slice(at, hostSrc.indexOf("\n}", at));
  };
  check("transcriptPathFor exists", body("transcriptPathFor").length > 0, true);
  // Bound to the FUNCTION BODY: a fallback that only consults the live map would
  // leave every dead session unreadable, which is the whole defect.
  check("transcriptPathFor consults the project index, not only the live map",
    /pickTranscript\(/.test(body("transcriptPathFor")), true);
}

function runHost(hostSrc, quiet) {
  const failures = [];
  let pass = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) { pass++; if (!quiet) console.log(`  PASS  ${name}`); }
    else {
      failures.push(name);
      if (!quiet) console.log(`  FAIL  ${name}` +
        `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
    }
  };
  try { suiteHost(check, hostSrc); }
  catch (e) { failures.push(`THREW: ${e.message}`); if (!quiet) console.log(`  FAIL  THREW: ${e.message}`); }
  return { pass, failures };
}

if (!SELFTEST) {
  const r = run(realModule, false);
  const rh = runHost(HOST_SRC, false);
  const total = r.failures.length + rh.failures.length;
  console.log(`\n${total} failure(s)`);
  process.exit(total ? 1 : 0);
}

// --- teeth. Each fault is a broken STAND-IN for one exported function, built by
// spreading the real module and overriding just that export, so the suite calls
// the real module for everything it is not specifically testing here.
const faults = [
  // The exact fault this file exists to prevent: projectLabel derives its answer
  // by decoding the last path segment as though it were a directory-encoded
  // name (splitting on "-"), so a hyphenated project loses its own hyphen -
  // "claude-plugins" becomes "plugins".
  ["projectLabel decodes the last segment as a directory name instead of taking it whole",
    {
      ...realModule,
      projectLabel: (cwd) => {
        const parts = String(cwd).split("/").filter(Boolean);
        const last = parts.length ? parts[parts.length - 1] : "";
        return last.split("-").pop();
      },
    }],
  // Only catchable because of the SCAN_LINES boundary test above (FINDING 2): a
  // cwdFromLines that ignores the bound and scans the whole array agrees with
  // the real one on every OTHER assertion here, so without that boundary test
  // this stand-in would pass the suite undetected.
  ["cwdFromLines ignores SCAN_LINES and scans the whole array",
    {
      ...realModule,
      cwdFromLines: (lines) => {
        const RE_CWD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;
        for (const line of lines) {
          const m = RE_CWD.exec(line);
          if (m) return m[1];
        }
        return null;
      },
    }],
];

let caught = 0;
for (const [name, mod] of faults) {
  const r = run(mod, true);
  if (r.failures.length) {
    caught++;
    console.log(`  caught  ${name}`);
    console.log(`            by: ${r.failures[0]}` +
      (r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : ""));
  } else {
    console.log(`  MISSED  ${name}  <- no assertion notices this`);
  }
}

// Host structural faults: substitute SOURCE TEXT lacking the pattern each
// assertion certifies, so --selftest proves those assertions can fail too, not
// just the behavioural ones above.
const hostFaults = [
  ["transcriptPathFor is deleted outright",
    HOST_SRC.replace(
      /async function transcriptPathFor\(id12\) \{[\s\S]*?\n\}\n/,
      ""
    )],
  // transcriptPathFor still exists but was rewritten to only ever answer from
  // the live map - the exact regression this task exists to prevent: every
  // dead session goes back to being unreachable, while the function still
  // "handles" the id and nothing crashes.
  ["transcriptPathFor exists but never consults the project index (live-map only)",
    (() => {
      const at = HOST_SRC.indexOf("function transcriptPathFor(");
      const end = HOST_SRC.indexOf("\n}", at);
      const body = HOST_SRC.slice(at, end);
      const stripped = body.replace(/pickTranscript\(/g, "liveMapOnlyLookup(");
      return HOST_SRC.slice(0, at) + stripped + HOST_SRC.slice(end);
    })()],
];

let hostCaught = 0;
for (const [name, hostSrc] of hostFaults) {
  const r = runHost(hostSrc, true);
  if (r.failures.length) {
    hostCaught++;
    console.log(`  caught  ${name}`);
    console.log(`            by: ${r.failures[0]}` +
      (r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : ""));
  } else {
    console.log(`  MISSED  ${name}  <- no assertion notices this`);
  }
}

const totalFaults = faults.length + hostFaults.length;
const totalCaught = caught + hostCaught;
console.log(`\nselftest: ${totalCaught}/${totalFaults} faults caught`);
process.exit(totalCaught === totalFaults ? 0 : 1);
