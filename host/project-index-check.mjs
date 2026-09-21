// Checks project-index without a filesystem or a running host.
//
// THE ONE RULE THIS FILE EXISTS FOR: a project directory name is a LOSSY path
// encoding and must never be decoded. "-Users-yujia-work-claude-plugins" is
// /Users/yujia/work/claude-plugins, NOT /Users/yujia/work/claude/plugins - the
// hyphen in the project's own name is indistinguishable from a separator. A
// decoder would be right for most paths and silently wrong for every hyphenated
// project and every worktree, which is the worst available failure shape.
import { cwdFromLines, projectLabel, pickTranscript } from "./project-index.mjs";

const SELFTEST = process.argv.includes("--selftest");
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}` +
    (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

// cwd is not on line 1 - the measured file opens with a queue-operation - so a
// reader that only looks at the head of the file finds nothing.
const REAL = [
  '{"type":"queue-operation","operation":"enqueue"}',
  '{"type":"queue-operation","operation":"dequeue"}',
  '{"parentUuid":null,"cwd":"/Users/yujia/work/claude-plugins","type":"user"}',
];
check("cwd is found past line 1", cwdFromLines(REAL), "/Users/yujia/work/claude-plugins");
check("no cwd anywhere is null, not a guess", cwdFromLines(REAL.slice(0, 2)), null);
check("empty input is null", cwdFromLines([]), null);
check("a hyphenated project keeps its hyphen",
  projectLabel("/Users/yujia/work/claude-plugins"), "claude-plugins");
check("a worktree keeps its own last segment",
  projectLabel("/Users/yujia/projects/deckhand/.claude/worktrees/session-ranking"),
  "session-ranking");
check("a trailing slash does not yield an empty label",
  projectLabel("/Users/yujia/work/parallax/"), "parallax");

const FILES = ["abc123456789-aaaa.jsonl", "def123456789-bbbb.jsonl", "notes.txt"];
check("exact 12-char prefix resolves",
  pickTranscript(FILES, "abc123456789"), { ok: true, file: "abc123456789-aaaa.jsonl" });
check("a non-jsonl is never returned",
  pickTranscript(["abc123456789.txt"], "abc123456789"), { ok: false, reason: "none" });
check("no match is reported, not guessed",
  pickTranscript(FILES, "999999999999"), { ok: false, reason: "none" });
check("empty id is rejected", pickTranscript(FILES, ""), { ok: false, reason: "empty" });
// The same bug session-lookup.mjs exists for: two files sharing a prefix must
// NOT silently pick the first. Resuming into the wrong conversation is worse
// than refusing.
check("ambiguous prefix is refused",
  pickTranscript(["abc123456789-a.jsonl", "abc123456789-b.jsonl"], "abc123456789"),
  { ok: false, reason: "ambiguous" });

if (SELFTEST) {
  // Prove the teeth: the decoder fault this file exists to prevent.
  const naive = (dir) => "/" + dir.replace(/^-/, "").split("-").join("/");
  const caught = naive("-Users-yujia-work-claude-plugins") !== "/Users/yujia/work/claude-plugins";
  console.log(caught
    ? "  caught  a naive dirname decoder disagrees with the file's own cwd"
    : "  MISSED  a naive dirname decoder was not caught");
  if (!caught) fail++;
}
console.log(`\n${fail} failure(s)`);
process.exit(fail ? 1 : 0);
