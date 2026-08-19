// Checks resolveSessionId without hardware or a running host.
import { resolveSessionId } from "./session-lookup.mjs";

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

const files = ["abc123456789-aaaa-bbbb.json", "def123456789-cccc.json", "notes.txt"];
check("exact 12-char prefix resolves", resolveSessionId(files, "abc123456789"), {
  ok: true,
  id: "abc123456789-aaaa-bbbb",
});
check("no match is reported, not guessed", resolveSessionId(files, "999999999999"), {
  ok: false,
  reason: "none",
});
check("empty id is rejected", resolveSessionId(files, ""), { ok: false, reason: "empty" });
// The bug this module exists for: two records sharing a prefix must NOT silently
// pick the first. 12 hex chars make a collision vanishingly unlikely, and
// "unlikely" is not a reason to send a message into whichever session sorted first.
check(
  "ambiguous prefix is refused",
  resolveSessionId(["abc123456789-one.json", "abc123456789-two.json"], "abc123456789"),
  { ok: false, reason: "ambiguous" }
);
check("non-json files are ignored", resolveSessionId(["abc123456789.txt"], "abc123456789"), {
  ok: false,
  reason: "none",
});
process.exit(fail ? 1 : 0);
