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

const SELFTEST = process.argv.includes("--selftest");

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

if (!SELFTEST) {
  const r = run(realModule, false);
  console.log(`\n${r.failures.length} failure(s)`);
  process.exit(r.failures.length ? 1 : 0);
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
console.log(`\nselftest: ${caught}/${faults.length} faults caught`);
process.exit(caught === faults.length ? 0 : 1);
