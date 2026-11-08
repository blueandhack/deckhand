#!/usr/bin/env node
// Checks the two hook forms: `node <script>` (install.sh) and "<runner>" "<script>"
// (the released app, whose runner is its bundled Node). Throwaway HOME; the real
// ~/.claude and ~/.codex are never touched.
//
//   node claude-hooks/hook-runner-check.mjs              - assert every claim
//   node claude-hooks/hook-runner-check.mjs --selftest   - prove the migration cases
//       have teeth: re-run them with hook-command.mjs's ownership rule put back to
//       the OLD exact-string match, and require every one of them to FAIL
//
// WHY THIS EXISTS. The installers used to decide "this hook is ours" by comparing
// the whole command string. That was fine while there was one form. With two, an
// exact match cannot see the other form, so moving from install.sh to the app would
// have ADDED a second Deckhand hook to every event (each Claude Code event then runs
// the hook twice, and a PermissionRequest answered from the device twice), and an
// uninstall from either side would have left the other side's hooks behind, each
// spawning a process that errors once the script is gone.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELFTEST = process.argv.includes("--selftest");
const FILES = ["install-hooks.mjs", "install-codex-hooks.mjs", "hook-command.mjs"];

// Where the installers run from: the real directory, or (selftest) a copy whose
// ownership rule is the pre-fix exact match.
function scriptsDir() {
  if (!SELFTEST) return HERE;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-hookself-"));
  for (const f of FILES) fs.copyFileSync(path.join(HERE, f), path.join(d, f));
  const p = path.join(d, "hook-command.mjs");
  const src = fs.readFileSync(p, "utf8");
  const body = /export function isDeckhandCommand\(command, scriptName\) \{[\s\S]*?\n\}/;
  if (!body.test(src)) throw new Error("selftest: isDeckhandCommand not found - the checker no longer matches the code");
  // The old rule: ours only if it is EXACTLY the command this run would write.
  fs.writeFileSync(p, src.replace(body,
    `export function isDeckhandCommand(command, scriptName) {\n` +
    `  const r = runnerFromArgv(process.argv);\n` +
    `  return command === hookCommand(r, path.join(process.env.HOME, ".claude", scriptName)) ||\n` +
    `    command === hookCommand(r, path.join(process.env.HOME, ".claude", scriptName), "--agent=codex");\n}`)
    .replace(/^/, `import path from "node:path";\n`));
  return d;
}
const DIR = scriptsDir();

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "deckhand-hookrun-"));
  fs.mkdirSync(path.join(h, ".claude"));
  return h;
}
const run = (h, script, args = []) =>
  execFileSync(process.execPath, [path.join(DIR, script), ...args], { env: { ...process.env, HOME: h }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const ours = (cmd) => typeof cmd === "string" && /(^|[\s/"])deckhand-session-hook\.mjs"?(\s|$)/.test(cmd);
const oursPerEvent = (hooks) => Object.fromEntries(Object.entries(hooks ?? {}).map(([e, gs]) =>
  [e, gs.flatMap((g) => g.hooks ?? []).filter((x) => ours(x.command)).length]));
const backups = (dir, base) => fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`)).length;

// ---- Claude Code: install.sh form, then the app's form ----
{
  const h = home();
  const S = path.join(h, ".claude", "settings.json");
  const R = path.join(h, ".claude", "deckhand-node");
  const ORIG = '{\n  "theme": "dark"\n}\n';
  fs.writeFileSync(S, ORIG);
  run(h, "install-hooks.mjs");
  run(h, "install-hooks.mjs", ["--node", R]);
  const s = read(S);
  const counts = oursPerEvent(s.hooks);
  check("migration: exactly ONE Deckhand hook per event (9 events)",
    Object.keys(counts).length === 9 && Object.values(counts).every((n) => n === 1), JSON.stringify(counts));
  check("migration: every Deckhand hook now runs the bundled runner",
    Object.values(s.hooks).flat().flatMap((g) => g.hooks).filter((x) => ours(x.command))
      .every((x) => x.command.startsWith(`"${R}" `)));
  check("migration: the statusLine moved to the runner too", s.statusLine?.command?.startsWith(`"${R}" `), s.statusLine?.command);

  const before = backups(path.join(h, ".claude"), "settings.json");
  const text = fs.readFileSync(S, "utf8");
  run(h, "install-hooks.mjs", ["--node", R]);
  check("a no-op re-run writes nothing and takes no backup",
    fs.readFileSync(S, "utf8") === text && backups(path.join(h, ".claude"), "settings.json") === before);

  run(h, "install-hooks.mjs", ["--remove"]);
  check("--remove after the app's install restores the file byte for byte", fs.readFileSync(S, "utf8") === ORIG);
}

// ---- Both forms present at once (a botched mix) collapse to one, in place ----
{
  const h = home();
  const S = path.join(h, ".claude", "settings.json");
  const R = path.join(h, ".claude", "deckhand-node");
  const script = path.join(h, ".claude", "deckhand-session-hook.mjs");
  const mine = { type: "command", command: "node /my/own/hook.mjs" };
  fs.writeFileSync(S, JSON.stringify({
    hooks: { Stop: [
      { hooks: [mine, { type: "command", command: `node ${script}`, timeout: 86400 }] },
      { hooks: [{ type: "command", command: `"${R}" "${script}"`, timeout: 86400 }] },
    ] },
  }, null, 2));
  run(h, "install-hooks.mjs", ["--node", R]);
  const stop = read(S).hooks.Stop;
  check("duplicates of ours collapse to one", stop.flatMap((g) => g.hooks).filter((x) => ours(x.command)).length === 1,
    JSON.stringify(stop));
  check("your hook keeps its place, first in the first group", stop[0].hooks[0].command === mine.command);
  check("ours is rewritten where it stood, beside yours", stop[0].hooks[1]?.command === `"${R}" "${script}"`);
}

// ---- Someone else's statusLine and a look-alike script are never ours ----
{
  const h = home();
  const S = path.join(h, ".claude", "settings.json");
  const R = path.join(h, ".claude", "deckhand-node");
  const theirs = { type: "command", command: "node /x/my-deckhand-statusline.mjs" };
  const lookalike = { type: "command", command: "node /x/my-deckhand-session-hook.mjs" };
  fs.writeFileSync(S, JSON.stringify({ statusLine: theirs, hooks: { Stop: [{ hooks: [lookalike] }] } }, null, 2));
  run(h, "install-hooks.mjs", ["--node", R]);
  let s = read(S);
  check("another tool's statusLine is left alone by install", s.statusLine.command === theirs.command);
  check("a look-alike script name is not mistaken for ours", s.hooks.Stop[0].hooks[0].command === lookalike.command
    && s.hooks.Stop.flatMap((g) => g.hooks).length === 2);
  run(h, "install-hooks.mjs", ["--remove"]);
  s = read(S);
  check("and both survive --remove", s.statusLine.command === theirs.command
    && JSON.stringify(s.hooks?.Stop) === JSON.stringify([{ hooks: [lookalike] }]));
}

// ---- Codex: the same migration, keeping --agent=codex ----
{
  const h = home();
  fs.mkdirSync(path.join(h, ".codex"));
  const HK = path.join(h, ".codex", "hooks.json");
  const R = path.join(h, ".claude", "deckhand-node");
  run(h, "install-codex-hooks.mjs");
  run(h, "install-codex-hooks.mjs", ["--node", R]);
  const c = read(HK);
  const counts = oursPerEvent(c.hooks);
  check("codex migration: exactly ONE Deckhand hook per event (6 events)",
    Object.keys(counts).length === 6 && Object.values(counts).every((n) => n === 1), JSON.stringify(counts));
  check("codex migration: runner form and --agent=codex both kept",
    Object.values(c.hooks).flat().flatMap((g) => g.hooks).every((x) => x.command.startsWith(`"${R}" `) && x.command.endsWith(" --agent=codex")));
  run(h, "install-codex-hooks.mjs", ["--remove"]);
  check("codex --remove leaves no Deckhand hook", !fs.readFileSync(HK, "utf8").includes("deckhand-session-hook"));
}

// ---- A runner path a shell would need escaped is refused, not mangled ----
{
  const h = home();
  let refused = false;
  try { run(h, "install-hooks.mjs", ["--node", '/tmp/a"b/node']); } catch { refused = true; }
  check("a runner path containing a double quote is refused", refused);
}

// The cases the OLD exact-string rule gets wrong. --selftest requires each to FAIL.
const MIGRATION = [
  "migration: exactly ONE Deckhand hook per event (9 events)",
  "duplicates of ours collapse to one",
  "ours is rewritten where it stood, beside yours",
  "codex migration: exactly ONE Deckhand hook per event (6 events)",
];

if (SELFTEST) {
  let bad = 0;
  for (const name of MIGRATION) {
    const r = results.find((x) => x.name === name);
    const caught = r && !r.ok;
    console.log(`  ${caught ? "ok   " : "FAIL "} the old exact-match rule is caught by: ${name}`);
    if (!caught) bad++;
  }
  console.log(bad ? `selftest: ${bad} case(s) have NO TEETH` : `selftest: all ${MIGRATION.length} migration cases catch the old rule`);
  process.exit(bad ? 1 : 0);
}

let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `  (${r.detail})`}`);
  if (!r.ok) failed++;
}
console.log(`== ${results.length - failed} passed, ${failed} failed ==`);
process.exit(failed ? 1 : 0);
