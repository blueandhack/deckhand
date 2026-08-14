#!/usr/bin/env node
// Back up and restore the Deckhand state that lives OUTSIDE this repo.
//
//   node claude-hooks/deckhand-backup.mjs backup            # snapshot to ~/Deckhand-backups
//   node claude-hooks/deckhand-backup.mjs list
//   node claude-hooks/deckhand-backup.mjs status            # drift: installed vs repo vs backup
//   node claude-hooks/deckhand-backup.mjs restore latest    # or restore <dir>
//   node claude-hooks/deckhand-backup.mjs restore latest --dry-run
//
// Why this exists: the hook and statusLine are registered in ~/.claude/settings.json and
// are the ONLY source for per-session status and the fallback quota - the device goes
// blank without them - and ~/.claude/deckhand-secret holds the pairing keys, so losing it
// means re-pairing every device by USB. None of that is in git, and install-hooks.mjs can
// only write the files it ships: it cannot recover your settings.json or your keys.
//
// Restore is REVERSIBLE: it snapshots whatever is currently installed into a
// `pre-restore-<ts>` backup before overwriting anything, so a wrong restore is one more
// restore away from being undone.
//
// The backup contains SECRETS (deckhand-secret). It is written to ~/Deckhand-backups with
// the directory at mode 700 and that file at 600, and deliberately NOT into the repo,
// which is tracked by git and could be pushed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

// --home exists so the whole cycle can be exercised against a throwaway tree instead of
// the real ~/.claude - a restore tool you cannot test is not one you should trust.
const HOME = flag("home", os.homedir());
const BACKUP_ROOT = flag("dir", path.join(HOME, "Deckhand-backups"));
const REPO = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname));

// What matters, and why. Caches are deliberately absent - deckhand-sessions/,
// deckhand-answers/ and the debug log all regenerate themselves - with ONE exception
// noted on deckhand-rate-limits.json below.
//
// The /tmp/deckhand-* host state is also deliberately absent: it is OAuth throttle
// files plus a log, all of which regenerate, macOS prunes /tmp anyway, and it lives
// outside $HOME - which would break the --home flag that makes this tool testable
// against a throwaway tree. Losing it costs one 5-minute poll of blank quota.
const FILES = [
  { rel: ".claude/deckhand-session-hook.mjs", need: true,  repo: "deckhand-session-hook.mjs",
    why: "per-session status + remote answering; the device shows nothing without it" },
  { rel: ".claude/deckhand-statusline.mjs",   need: false, repo: "deckhand-statusline.mjs",
    why: "fallback quota source (terminal sessions only)" },
  { rel: ".claude/settings.json",             need: true,  repo: null,
    why: "registers the hook + statusLine; yours, not ours - never in git" },
  { rel: ".claude/deckhand-secret",           need: false, repo: null, secret: true,
    why: "device pairing keys; losing it means re-pairing over USB" },
  { rel: ".claude/deckhand-rate-limits.json", need: false, repo: null,
    why: "fallback quota cache - regenerates, but only in a TERMINAL session, so on a desktop-app-only machine it can be the newest reading there is" },
  { rel: ".codex/hooks.json",                 need: false, repo: null,
    why: "Codex hook registration; without it Codex threads are read-only on the device" },
  { rel: ".codex/config.toml",                need: false, repo: null,
    why: "Codex settings (model, notify, trusted projects)" },
];

// Cap the backup directory. Repeated installs, uninstalls and restores each drop a
// snapshot in here, so without this it grows forever - the same problem the host log
// and the hook's debug log both had. Same SHAPE as the audio-capture prune in
// host/index.mjs, so the repo has one policy: the newest KEEP_MIN always survive
// regardless of age, and only what is older than KEEP_DAYS is removed. The count floor
// matters because a snapshot is the only copy of your keys and settings.json - a long
// quiet spell must not leave you with none.
// pre-restore-* snapshots age out on the same terms; they are an undo for a bad
// restore, not an archive.
const KEEP_MIN = 10;
const KEEP_DAYS = 30;
function prune() {
  const all = backups(); // oldest first (names are timestamped, sorted ascending)
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  const removed = [];
  // Everything except the newest KEEP_MIN is a candidate; age decides from there.
  for (const dir of all.slice(0, Math.max(0, all.length - KEEP_MIN))) {
    let at;
    try {
      at = fs.statSync(path.join(dir, "manifest.json")).mtimeMs;
    } catch {
      continue; // unreadable - leave it alone rather than guess
    }
    if (at >= cutoff) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(path.basename(dir));
    } catch {
      /* leave it */
    }
  }
  // Reported, never silent: a cap that hides what it dropped reads as "kept everything".
  if (removed.length)
    console.log(`Pruned ${removed.length} backup(s) older than ${KEEP_DAYS}d: ${removed.join(", ")}`);
}

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
const abs = (rel) => path.join(HOME, rel);
const human = (n) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}K`);

function snapshot(label) {
  // MILLISECONDS, not seconds, and then a uniqueness loop on top. Seconds alone was a
  // silent data-loss bug: two snapshots in the same second produce the same directory
  // name, and mkdirSync({recursive:true}) does NOT throw on an existing path - so the
  // second snapshot wrote INTO the first, overwriting its files while leaving behind any
  // the second didn't have. The result claimed to be one point in time and wasn't, and
  // the manifest only described the later half. Back-to-back calls are ordinary (install
  // then uninstall, or any script chaining them), so this has to be impossible, not
  // unlikely. Fixed width, so names still sort chronologically.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  let dir = path.join(BACKUP_ROOT, `${label}-${stamp}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(BACKUP_ROOT, `${label}-${stamp}-${n}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const manifest = { created: new Date().toISOString(), home: HOME, files: [] };
  for (const f of FILES) {
    const src = abs(f.rel);
    if (!fs.existsSync(src)) {
      if (f.need) console.warn(`  ! missing (expected): ${f.rel}`);
      manifest.files.push({ rel: f.rel, present: false });
      continue;
    }
    const dst = path.join(dir, f.rel.replace(/\//g, "__"));
    fs.copyFileSync(src, dst);
    const mode = fs.statSync(src).mode & 0o777;
    fs.chmodSync(dst, f.secret ? 0o600 : mode);
    manifest.files.push({ rel: f.rel, present: true, bytes: fs.statSync(src).size, sha: sha(src), mode });
    console.log(`  saved ${f.rel}  ${human(fs.statSync(src).size)}${f.secret ? "  (secret, mode 600)" : ""}`);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return dir;
}

function backups() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs
    .readdirSync(BACKUP_ROOT)
    .filter((n) => fs.existsSync(path.join(BACKUP_ROOT, n, "manifest.json")))
    .sort()
    .map((n) => path.join(BACKUP_ROOT, n));
}

function main() {
 if (cmd === "backup") {
  console.log(`Backing up Deckhand's external state (home: ${HOME})`);
  const dir = snapshot("backup");
  prune();
  console.log(`\nDone: ${dir}`);
  console.log("Contains pairing secrets - keep it as private as you'd keep an SSH key.");
} else if (cmd === "list") {
  const all = backups();
  if (!all.length) return console.log(`No backups in ${BACKUP_ROOT}`);
  for (const d of all) {
    const m = JSON.parse(fs.readFileSync(path.join(d, "manifest.json"), "utf8"));
    const n = m.files.filter((f) => f.present).length;
    const secret = m.files.some((f) => f.present && f.rel.endsWith("deckhand-secret"));
    console.log(`${path.basename(d)}  ${n} file(s)${secret ? ", incl. pairing keys" : ""}  ${m.created}`);
  }
} else if (cmd === "status") {
  console.log(`installed vs repo vs newest backup (home: ${HOME})\n`);
  const newest = backups().at(-1);
  for (const f of FILES) {
    const src = abs(f.rel);
    const live = fs.existsSync(src) ? sha(src) : null;
    let repo = null;
    if (f.repo && fs.existsSync(path.join(REPO, f.repo))) repo = sha(path.join(REPO, f.repo));
    let back = null;
    if (newest) {
      const p = path.join(newest, f.rel.replace(/\//g, "__"));
      if (fs.existsSync(p)) back = sha(p);
    }
    const mark = (a, b) => (a === null || b === null ? "  -  " : a === b ? " same" : " DIFF");
    console.log(
      `${f.rel.padEnd(38)} ${live ? live : "MISSING".padEnd(12)}` +
        `  repo:${mark(live, repo)}  backup:${mark(live, back)}`
    );
    if (!live && f.need) console.log(`    ^ REQUIRED and absent - ${f.why}`);
  }
  if (!newest) console.log(`\nNo backup yet: run \`backup\`.`);
} else if (cmd === "restore") {
  const which = args[1];
  if (!which) return console.error("restore needs a backup dir, or `latest`.");
  const dir = which === "latest" ? backups().at(-1) : path.resolve(which);
  if (!dir || !fs.existsSync(path.join(dir, "manifest.json")))
    return console.error(`Not a backup: ${which}`);
  const dry = has("dry-run");
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  console.log(`Restoring ${path.basename(dir)} (taken ${m.created})${dry ? "  [dry run]" : ""}\n`);
  if (!dry) {
    console.log("First, snapshotting what is installed now so this is undoable:");
    const pre = snapshot("pre-restore");
    // Deliberately NO prune() here. Pruning during a restore can delete the directory
    // being restored FROM - it runs before the copy loop below, and an old snapshot
    // outside the newest KEEP_MIN is exactly what you reach for in a recovery - after
    // which the copy loop finds nothing and silently restores nothing. Deleting backups
    // in the middle of a recovery is the wrong instinct anyway; only `backup` prunes.
    console.log(`  -> ${pre}\n`);
  }
  for (const f of FILES) {
    const src = path.join(dir, f.rel.replace(/\//g, "__"));
    if (!fs.existsSync(src)) continue;
    const dst = abs(f.rel);
    const same = fs.existsSync(dst) && sha(dst) === sha(src);
    const rec = m.files.find((x) => x.rel === f.rel);
    console.log(`  ${same ? "unchanged" : dry ? "would write" : "restored  "}  ${f.rel}`);
    if (same || dry) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, f.secret ? 0o600 : (rec?.mode ?? 0o644));
  }
  console.log(
    dry
      ? "\nNothing written. Drop --dry-run to apply."
      : "\nDone. Restart the Claude Code app/CLI so it re-reads settings.json and the hook."
  );
 } else {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 26).join("\n").replace(/^\/\/ ?/gm, ""));
 }
}

main();
