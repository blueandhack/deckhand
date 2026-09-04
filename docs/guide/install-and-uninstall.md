# Setup, uninstall and restore

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## Backing out (uninstall and restore)

```
./uninstall.sh --dry-run      # print exactly what would happen, change nothing
./uninstall.sh                # confirm, then remove
./uninstall.sh --purge        # ...and forget the device pairing keys too
```

It takes a snapshot before it removes anything, so the uninstall itself is
undoable, and it **un-registers surgically** — it deletes only the entries whose
command is Deckhand's, so any hooks or settings you added since installing
survive. What it deliberately keeps: your **pairing keys** (unless `--purge`,
since losing them means re-pairing every device over USB), `~/Deckhand-backups`,
`~/Deckhand-audio`, and this repo's build artifacts. It prints the command for
those last ones rather than reaching into your working tree.

State that lives outside the repo — the two hook scripts, your `settings.json`,
the pairing keys, and `~/.codex/config.toml` — is managed separately:

```
node claude-hooks/deckhand-backup.mjs backup            # snapshot -> ~/Deckhand-backups
node claude-hooks/deckhand-backup.mjs status            # drift: installed vs repo vs backup
node claude-hooks/deckhand-backup.mjs restore latest --dry-run
node claude-hooks/deckhand-backup.mjs restore latest
```

Snapshots go to `~/Deckhand-backups` (directory `700`, the key file `600`) and
**never into the repo**, which is tracked by git and could be pushed. A restore
snapshots what's currently installed first, so a wrong restore is one more
restore away from being undone. The directory is capped the way audio captures
are — the newest 10 always survive, anything older than 30 days is pruned, and
what got removed is printed rather than dropped silently.

Because these scripts mutate `~/.claude`, which every Claude Code session on the
machine shares, they have a real test: `claude-hooks/test-install-cycle.sh` runs
the whole install → uninstall → restore cycle against a throwaway `$HOME`.

## Project layout

```
firmware/deckhand_display/*.ino           Arduino sketch, several files, one build
firmware/deckhand_display/board.h         picks the board from the compile target
firmware/deckhand_display/board_*.h       per-board pins, capabilities and EVERY layout constant
firmware/deckhand_display/panel_*.{h,cpp} board 2's TFT_eSPI-compatible shim + framebuffer
firmware/deckhand_display/st77922_*       board 2's panel init sequence and touch controller
firmware/deckhand_display/*-geom-check.mjs  layout arithmetic checkers, both boards, no hardware
firmware/tft_setup/User_Setup.h           TFT_eSPI pin config - BOARD 1 ONLY
docs/board-1-known-defects.md             board-1 bugs the second-board port surfaced
host/index.mjs                            Node script (runs on your Mac)
host/typed-answer.mjs, voice-answer.mjs   answer crypto, pure + testable
host/build-app.sh                         builds DeckhandBLE.app from your node
host/DeckhandBLE.plist                    Info.plist template for that app
host/deckhand-service.sh                  launchd supervision (install/stop/status)
flash.sh                                  compile + flash, handles the serial port
claude-hooks/                             the ~/.claude hook scripts + installer
install.sh                                one-command setup
```

Runtime state, per user:

```
/tmp/deckhand-<uid>/host.log              the host's log (rotates at 5MB, keeps .1)
/tmp/deckhand-<uid>/host-alive            heartbeat; gates the hook's remote wait
~/.claude/deckhand-restarts.log           one line per host start (see Keeping it running)
~/Library/Logs/deckhand-launchd.{out,err} whatever dies before the host's own logger
```

The Claude Code hook scripts ship in `claude-hooks/` but *run* from
`~/.claude/` (hooks are configured per-user, not per-project); `install.sh`
puts them there. At runtime they use these per-user paths:

```
~/.claude/deckhand-statusline.mjs        statusLine hook -> ~/.claude/deckhand-rate-limits.json
~/.claude/deckhand-session-hook.mjs      session hooks   -> ~/.claude/deckhand-sessions/*.json
~/.claude/settings.json                  registers both of the above
```
