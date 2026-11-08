// What a Deckhand hook command looks like, and how to recognise one we wrote.
// Shared by install-hooks.mjs and install-codex-hooks.mjs, because the rule that
// decides "this entry is Deckhand's" is the rule --remove depends on, and two
// copies of it is exactly how an uninstall leaves a dead hook behind (the note at
// the top of install-hooks.mjs).
//
// TWO FORMS EXIST, and both must be recognised forever:
//   node /Users/me/.claude/deckhand-session-hook.mjs            (install.sh, from source)
//   "/Users/me/.claude/deckhand-node" "/Users/me/.claude/deckhand-session-hook.mjs"
//                                                                (the released app)
// The released app cannot assume a `node` on PATH - Claude Code's own installer no
// longer needs one - so it points the hooks at its bundled Node through a symlink
// it keeps current (~/.claude/deckhand-node). Ownership is therefore decided by the
// SCRIPT the command runs, never by the whole string: matching the exact string is
// what made the old installers add a second hook beside an entry written by the
// other form, instead of replacing it.

/// `--node <path>` from argv, or null for the classic bare `node`.
export function runnerFromArgv(argv) {
  const i = argv.indexOf("--node");
  if (i === -1) return null;
  const p = argv[i + 1];
  if (!p || p.startsWith("--")) throw new Error("--node needs a path");
  return p;
}

// Double quotes, because Claude Code and Codex run the command through a shell and
// a home directory may contain a space. A path that would need escaping INSIDE
// double quotes is refused rather than escaped: none should ever reach here, and
// getting shell escaping subtly wrong in a command that runs on every event is a
// worse failure than a clear refusal at install time.
function quote(p) {
  if (/["$`\\]/.test(p)) throw new Error(`refusing to quote a path containing " $ \` or \\: ${p}`);
  return `"${p}"`;
}

/// The command string for `script` (an absolute path), run by `runner`.
/// With no runner it is EXACTLY the historical form, byte for byte, so an
/// install.sh install keeps matching what install.sh has always written.
export function hookCommand(runner, script, extraArgs = "") {
  const base = runner ? `${quote(runner)} ${quote(script)}` : `node ${script}`;
  return extraArgs ? `${base} ${extraArgs}` : base;
}

/// True when `command` runs the Deckhand script named `scriptName` (a basename such
/// as "deckhand-session-hook.mjs"), in either form, with or without trailing args.
/// The name must be a whole path component: "my-deckhand-session-hook.mjs" is not ours.
export function isDeckhandCommand(command, scriptName) {
  if (typeof command !== "string") return false;
  const name = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s/"])${name}"?(\\s|$)`).test(command);
}

/// Bring one event's hook groups to exactly ONE Deckhand entry running `command`.
/// Every other hook is left where it is. Returns true when anything changed.
///  - an entry of ours in another form (or with another timeout) is rewritten IN
///    PLACE, so its position among your hooks does not move;
///  - any further entries of ours are removed (two would run the hook twice);
///  - a group left empty BY THAT REMOVAL is dropped, never one that was empty before;
///  - if there was none, a new group is appended with `extra` (its matcher).
export function normalizeEvent(groups, scriptName, command, timeout, extra) {
  let changed = false;
  let found = false;
  const out = [];
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) { out.push(g); continue; } // a shape we do not own
    const kept = [];
    let groupChanged = false;
    for (const h of g.hooks) {
      if (!isDeckhandCommand(h?.command, scriptName)) { kept.push(h); continue; }
      if (found) { groupChanged = true; continue; }
      found = true;
      if (h.command !== command || h.timeout !== timeout) {
        kept.push({ ...h, command, timeout });
        groupChanged = true;
      } else {
        kept.push(h);
      }
    }
    if (groupChanged) changed = true;
    if (kept.length === 0 && g.hooks.length > 0) continue; // emptied by OUR removal
    out.push(groupChanged ? { ...g, hooks: kept } : g);
  }
  if (!found) {
    out.push({ ...extra, hooks: [{ type: "command", command, timeout }] });
    changed = true;
  }
  groups.splice(0, groups.length, ...out);
  return changed;
}

/// Remove every Deckhand entry for `scriptName` from one event's groups, dropping
/// groups that held only ours. Returns how many groups lost an entry.
export function removeFromEvent(groups, scriptName) {
  let removed = 0;
  const out = [];
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) { out.push(g); continue; }
    const hooks = g.hooks.filter((h) => !isDeckhandCommand(h?.command, scriptName));
    if (hooks.length !== g.hooks.length) removed++;
    if (hooks.length) out.push(hooks.length === g.hooks.length ? g : { ...g, hooks });
  }
  groups.splice(0, groups.length, ...out);
  return removed;
}
