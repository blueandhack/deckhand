# The bits of Deckhand that live outside this repo

Two files under `~/.claude/` are **load-bearing but not part of the firmware or the host
script**, and one more holds your device keys:

| file | what breaks without it |
|---|---|
| `~/.claude/deckhand-session-hook.mjs` | per-session status and remote answering — the SESSIONS list goes empty |
| `~/.claude/deckhand-statusline.mjs` | the fallback quota source (terminal sessions only) |
| `~/.claude/settings.json` | registers both of the above; **yours**, so it is never in git |
| `~/.claude/deckhand-secret` | device pairing keys — losing it means re-pairing every device over USB |
| `~/.codex/config.toml` | Codex settings (model, notify, trusted projects) |

`install-hooks.mjs` can only write the two files it ships. It cannot recover your
`settings.json` or your keys — which is what `deckhand-backup.mjs` is for.

## Install (first time, or on a new Mac)

```
cp claude-hooks/deckhand-session-hook.mjs claude-hooks/deckhand-statusline.mjs ~/.claude/
node claude-hooks/install-hooks.mjs
```

The installer merges Deckhand's `statusLine` + hook entries into `settings.json`, keeps
everything already there, backs the file up first, and is safe to re-run.

## Back up / restore

```
node claude-hooks/deckhand-backup.mjs backup           # snapshot -> ~/Deckhand-backups
node claude-hooks/deckhand-backup.mjs list
node claude-hooks/deckhand-backup.mjs status           # drift: installed vs repo vs backup
node claude-hooks/deckhand-backup.mjs restore latest --dry-run
node claude-hooks/deckhand-backup.mjs restore latest
```

Three things worth knowing:

- **Restore is reversible.** It snapshots whatever is installed *now* into a
  `pre-restore-<ts>` backup before it overwrites anything, so a wrong restore is one more
  restore away from being undone. `--dry-run` prints the plan and writes nothing.
- **The backup contains secrets.** `deckhand-secret` holds the pairing keys, so the backup
  root is mode `700` and that file `600`. It is written to `~/Deckhand-backups`, deliberately
  **not** into the repo — this repo is tracked by git and could be pushed.
- **`status` is the one to run occasionally.** The installed hook is a *copy*, not a symlink,
  so it silently drifts from the repo version. `status` compares installed vs repo vs newest
  backup and names anything required that is missing.

`--home <dir>` points the whole tool at a throwaway tree, which is how the backup → destroy
→ restore cycle is tested without touching your real `~/.claude`.

After a restore, restart the Claude Code app/CLI so it re-reads `settings.json` and the hook.
