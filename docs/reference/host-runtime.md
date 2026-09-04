# The host process: reliability, OAuth and housekeeping

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](README.md). The rules an agent must not miss stay in
[`../CLAUDE.md`](../CLAUDE.md).

---

- **A `Notification` used to DELETE the prompt it was notifying about, and that made
  remote answering of a question almost impossible.** Measured: an `AskUserQuestion` fires
  `PermissionRequest` (which publishes the ask and blocks up to `REMOTE_WAIT_MS`) and then,
  **six seconds later**, a `Notification` for the same prompt - `08:21:50.768` then
  `08:21:56.781`. The hook rebuilds the session record from scratch on every event, and a
  Notification is neither `isPermEvent` nor `isPreAsk`, so it built no ask and the record
  was written **without one**. `waitForRemoteAnswer`'s own "our ask is gone, they must have
  answered on the Mac" check then fired and the hook stopped listening - six seconds in,
  not ninety.
  Everything downstream still looked healthy, which is what made it hard to find: the
  device kept displaying the prompt, still signed a valid answer, and the host still
  authenticated it and wrote the answer file. Nobody was left to read it, so the Mac's
  dialog just sat there. **The orphaned answer file on disk was the confirmation.** It also
  explains why this presented first as a keyboard bug and then as a voice bug - both
  re-read the record to confirm the prompt is still a pending question, so both were
  rejected by a guard that was telling the truth - and why tapping **Allow** always worked:
  Bash permission prompts fire no `Notification`.
  A pending ask is now **carried forward** (`carriedAsk`), and only two kinds of event may
  clear it: one that DEFINES the current prompt (`PreToolUse`/`PermissionRequest`, whose
  ask - or deliberate absence when no display is connected - is authoritative), and one
  that means the prompt is over (`PostToolUse`, `PostToolUseFailure`, `Stop`,
  `UserPromptSubmit`). Verified by replaying the captured payloads against a throwaway
  `$HOME`: the ask survives a Notification, and all four clearing events still clear it.
  **A replay test of this must assert that a heartbeat is live first** - with a stale one
  the hook publishes NO ask at all, and "never created" is indistinguishable from
  "stripped" unless the test refuses to run. That false negative cost real time.
- **An `await` that never settles kills the poll loop forever, and no `catch` can help.**
  Measured twice, hours apart, with an identical signature: the line after the final tick
  was `BLE: adapter state = poweredOff`, and the host then sent nothing again until it was
  restarted. noble's `writeAsync` does not reject when the adapter disappears mid-write -
  it simply never calls back - and `tick()`'s `setTimeout(tick, ...)` sits after every
  await, so one unsettled write means `tick()` never returns and never reschedules.
  `try/catch` catches rejections, not hangs; a `finally` would not help either, because it
  runs when a function COMPLETES and this failure never does.
  The host still looked alive throughout, which is the trap: the serial reader is
  event-driven and independent, so it kept logging `BATT` lines for five hours after the
  last tick, and a typed answer sent from the device was still received and accepted. Only
  the outbound half was gone. **On the device the symptom points the wrong way**: SETTINGS
  shows Bluetooth "connected" (the link really does re-establish) but USB "disconnected",
  because the device infers USB from bytes RECEIVED - so a host that has stopped
  transmitting reads as a USB fault.
  Three defences, in order of generality. The BLE write is raced against a 3s timeout, so
  that await always settles. **Every child process is bounded** - `ccusage` runs on every
  tick and had no timeout, `security` blocks indefinitely on a locked keychain or an auth
  prompt, and whisper/mic-wav are slow but not endless (the `git` calls already had
  timeouts and both `fetch` calls already had abort signals). And `tick()` has a
  **watchdog**: if no tick completes within `TICK_WATCHDOG_MS` it starts a new chain,
  because any await added inside `tick()` later would kill the poller the same silent way.
  The `tickGeneration` counter is what stops the cure being worse than the disease - a
  stalled tick that eventually resumes must not schedule alongside its replacement, or
  every stall would permanently double the tick rate. Proven with a promise that never
  settles: without the watchdog the loop stops dead, with it it resumes.
- **A death now leaves evidence, and the fatal handlers must NOT use the normal logger.**
  There were no `unhandledRejection`/`uncaughtException` handlers at all, and on modern
  Node an unhandled rejection **terminates the process** - for a status display that is the
  wrong trade, so it is logged and survived, while an uncaught exception still exits but
  records why first. Both go through `logFatalSync` with `appendFileSync`, because
  everything else writes through a STREAM whose buffer is **lost** when the process exits:
  verified with a test that writes both ways and exits immediately - the stream line
  disappears, the synchronous one survives.
- **`ccusage` is spawned as `<process.execPath> <cli.js>`, never through its `.bin`
  shebang.** That shebang is `#!/usr/bin/env node`, which needs `node` on PATH - and under
  launchd PATH is minimal, while node on this machine is **nvm-managed** under
  `~/.nvm/versions/node/<version>/bin`, on no standard path at all. The symptom was
  indirect and nearly invisible from the Mac: `env: node: No such file or directory` every
  tick, `readUsage()` throwing, no payload sent, and a device stuck on "waiting for the
  first update" while the heartbeat stayed fresh, `via=usb,ble` looked right, and the
  watchdog correctly did nothing (the loop was not stalled - it was completing, and
  failing). **Adding nvm's bin to the plist would have worked until the next `nvm install`
  and then broken the same way**, which is why the dependency was removed rather than
  satisfied. `process.execPath` is the node inside the bundle, so it always exists - the
  same reason the mic decoder is spawned that way. This is also a class the restart ledger
  cannot catch: a healthy process doing no useful work.

- **Housekeeping: the host's own files are capped, because both grew forever.** Measured:
  the log appends a ~700-byte tick line every 5s = **4.4MB/day, ~131MB/month**, and audio
  captures are never overwritten (each is timestamped) at ~100KB–1MB a take.
  `/tmp/deckhand-<uid>/host.log` now rotates at 5MB keeping one previous generation (`.1`), so a
  crash's context survives the rotation that follows it; size is tracked from what we write
  rather than `stat`ing every line, with the counter **seeded from the existing file at
  startup**. Audio captures older than 7 days are pruned, but the **newest 10 always
  survive regardless of age** — comparing an old capture against a new one is a real
  workflow here, and a long quiet spell must not wipe the lot. `latest.wav` /
  `latest-clean.wav` are left alone (mic-wav.mjs regenerates them). Pruning runs after each
  capture AND once at startup, since captures accumulate across runs.
  **The hook's debug log is capped the same way, and it is the one that grows fastest.**
  `~/.claude/deckhand-session-hook-debug.log` gets a line on EVERY event — and
  `PostToolUse` is registered with matcher `.*`, so that is one line per tool call across
  every Claude Code session on the machine, plus the **full JSON payload** of every
  `Notification` and `PermissionRequest`. One real debugging session left 3066 events in
  it. Same rule as the host (5MB, one `.1` generation) so the repo has one policy, but the
  mechanism has to differ: the hook is a **short-lived process, one invocation per event**,
  so it cannot track its own size in memory and instead `statSync`s before appending —
  a single cheap syscall next to the record read/write it already does. Concurrent
  invocations can both decide to rotate; that races harmlessly (`renameSync` is atomic, so
  the worst case is an early generation boundary) and is not worth a lock on the critical
  path of every tool call. All of it goes through the single `dlog()` writer, which
  swallows every error — a hook that threw while logging would be far worse than a missing
  line — and which must never reach stdout, since a `PermissionRequest` hook's stdout is a
  decision channel.
- **Install/uninstall/restore, and the two silent bugs found while building it.**
  `install.sh` **snapshots before it copies** — its `cp` replaces the two hook scripts
  outright, so without that a re-run destroys local edits to them; `install-hooks.mjs`
  backs up `settings.json` but cannot back up files it is merely handed. That guard is
  **conditional on purpose**: if the scripts are already installed and the snapshot fails,
  it ABORTS (proceeding would destroy the only copy); with nothing installed it warns and
  continues, because refusing to install over a backup hiccup is just obstructive.
  `uninstall.sh` un-registers **surgically** rather than restoring the pre-install
  `settings.json` — you may have added hooks since — and that removal lives in
  `install-hooks.mjs --remove` so it shares the `HOOK`/`STATUSLINE` command strings with
  the code that wrote them. Duplicating those constants in a second file is exactly how an
  uninstall leaves a dead hook behind, and a dead hook means every event spawns a node
  process that errors. It keeps the pairing keys unless `--purge` (losing them means
  re-pairing every device over USB), and never touches the repo or `~/Deckhand-backups`.
  Two bugs the cycle test caught, both silent:
  - **Snapshot names were second-resolution, and `mkdirSync({recursive:true}) does not
    throw` on an existing path.** Two snapshots in the same second therefore wrote into
    ONE directory - the second overwriting the first's files while leaving behind any it
    didn't have - producing a snapshot that claimed to be one point in time and wasn't,
    with a manifest describing only the later half. Now millisecond-stamped plus a
    uniqueness loop. Back-to-back snapshots are ordinary (install then uninstall), so this
    had to be impossible rather than unlikely.
  - **`prune()` must never run on the restore path.** It ran before the copy loop, and an
    old snapshot outside the newest `KEEP_MIN` is exactly what you reach for in a
    recovery - so restoring one could delete the directory being restored FROM, after
    which the copy loop found nothing and silently restored nothing. Only `backup` prunes.
  `claude-hooks/test-install-cycle.sh` exercises the whole cycle against a throwaway
  `$HOME` (bash reads `$HOME`, node's `os.homedir()` returns it), which is the only way to
  test scripts that mutate the `~/.claude` every session on the machine shares.
  **`$HOME` is not enough on its own, and that bit us.** The host's runtime state lives at
  ABSOLUTE `/tmp/deckhand-*` paths, so it escapes the sandbox: running the test deleted the
  LIVE host's log (leaving it writing into an unlinked inode - confirmed with `lsof`) and,
  worse, its persisted `oauth-attempt.json` / `oauth-backoff.json`, which are the
  guards that stop a restart bursting the usage endpoint into a 429. `uninstall.sh` now
  reads `DECKHAND_TMP` (defaulting to `/tmp`) purely as a test seam, and the test asserts
  that sentinels at the REAL paths survive - the assertion whose absence let this through.
  Any future cleanup added there must go through `$DECK_TMP`, never a literal `/tmp`.
- **Mixing the two on screen: text, never colour or an icon.** Sessions from both tools
  go into the SAME list and the same urgency ranking, so a mixed set sorts by how much
  it needs you rather than by which tool it came from. Each row is tagged `CC`/`CX` in
  its sub-line (and spelled `CLAUDE`/`CODEX` top-right on tall rows, where the sub-line
  is suppressed under 70px to clear the status pill). Same rule as the status shapes:
  colour is never the only carrier of meaning here, and a tag also has to survive a model rename.
- **The USAGE tab had to give up 18px per card to fit Codex.** The two Claude cards were
  122 tall and, with the gaps, filled the content area exactly — there was no room
  anywhere. They are now 104: only the padding around the hero number tightened (its
  offsets moved 20/78/92/107 → 20/62/74/89), so the 39px Cozette figures you actually
  read did not shrink. Codex gets a **44px** row rather than a full card, because it
  publishes one percentage and a reset time — no token count and no second window, so a
  card's other two lines would be empty chrome.
  It shows `--`, never `0%`, when no `rate_limits` has ever been seen; 0% is a
  measurement and "never measured" is not. **CORRECTION: on board 2 that state is no
  longer reachable at all.** The adaptive column (see "USAGE on board 2: the column
  adapts to whether Codex is even here", above) hides the whole row once Codex has gone
  quiet for a full window — and "never measured" is silence since forever, so it is the
  first thing the predicate catches. `renderCodexRow()`'s `bool have = usage.cxPct >= 0;`
  and its `"--"` branch are unchanged and still execute — this sentence is still literally
  true of the function — but on board 2 nothing calls it into view while `have` is false,
  because `usageCodexShown()` already returned false and the row was never drawn this tick.
  **Board 1 is the row's live path to `--` now**: it has no predicate, no solo column and
  no hide, so a Codex that has never reported still shows a permanent `--` row there,
  exactly as this bullet always described.
- **Codex DOES get a pace bar, and the note above used to say it couldn't.** The claim was
  "nothing to plot a pace against" — wrong: `resets_at` plus `window_minutes` give the
  elapsed fraction, so the tick is the identical calculation the Claude cards use
  (`100 - resetInMin * 100 / windowMin`), and `drawPaceBar` already renders `tickPct < 0`
  as "no tick" for the case where either input is missing. The row now carries a
  full-height `BAR_H` bar plus the wall-clock reset time, so all three figures on the tab
  read the same way.
  **The 10px it needed came from the GAPS, not the cards** (10/8/6 → 6/4/4, cards
  unchanged at 104). Shrinking them to 98 was the obvious move and is wrong: a card's
  content ends at `y0+102` (label +6, hero +20..60, bar +62..72, stats +74, reset line
  +89..102), so 98 clips the reset line by 4px — and the hero figures are the one thing
  the 122→104 pass explicitly protected.
  **The column must NOT end flush on `contentBottom()`, and it used to.** 6+104+4+104+4+46
  spent all 268px of the content area, so the Codex row's bottom edge landed exactly on
  302 and sat against the footer with no gap — the two read as one joined block. The four
  gaps are now a uniform **4/4/4/4**: two px came off the top gap (`CARD1_Y` 40→38,
  `CARD2_Y` 148→146, `CODEX_Y` 256→254) and two off the row itself (`CODEX_H` 46→44), so
  the column ends at 298 with 4px of air below it. The row keeps its slack — content
  reaches `+39` (the pace bar clears from `y-4` for 18 rows) inside 44, leaving the 2px
  border at `+42..+43` clear of it. Any future addition here has to come out of the same
  268px; there is no spare.
  **A field's CLEAR box can rub out the card border, and it did.** `drawIfChanged`
  clears its own box first — `fillRect(fx-1, fy-1, tw+2, th+2)` — so the shared bottom
  row (Fable on the left, reset-time/staleness on the right) drawn at `y0+89` cleared
  rows `+88..+102` in a 104-tall card whose 2px border owns `+102..+103`. The TEXT
  overlapped nothing; the CLEAR rubbed out the border's inner row along exactly the
  width of those two strings, which reads as a gap in the outline beneath them. The row
  moved to `+88` (clear ends `+101`). So: **anything drawn on a usage card must end by
  `+101`**, and the same arithmetic applies to any surface with a 2px border — check the
  clear box, not the glyphs. Audited at the time: the Codex row is fine (content reaches
  `+39` inside 44), and session rows and the detail card repaint wholesale rather than
  per-field, so no clear box can reach their borders.
  Two details are load-bearing: the text sits at `+8` and the bar at `+26` because
  `drawPaceBar` clears from `y-4` to cover its tick overhang, which at `+11`/`+26` would
  have shaved the text's bottom row; and the row's stale dimming keys off **`cxAgeSec`,
  Codex's own reading age**, not the Claude quota's `quotaAgeSec`. It used to hang off the
  latter, which was wrong both ways — Codex going stale while the OAuth poller stayed
  fresh left the row bright, and a Claude flip repainted a row that hadn't changed. The
  bar has to be busted on that flip too, since `drawPaceBar` caches on `(pct, tick)` alone
  and would never repaint a colour-only change.
