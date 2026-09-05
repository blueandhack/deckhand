# The host process: reliability, OAuth and housekeeping

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

- **THE HOST DRIVES EVERY BOARD ON THE DESK, NOT THE FIRST ONE.** `findUsbPort()` used
  `.find()` and returned the first port `SerialPort.list()` matched. That was invisible for
  as long as there was one board; with two cabled it drove whichever the OS enumerated
  first - board 2's `/dev/tty.usbmodem1101` - and board 1 sat on `/dev/tty.usbserial-10`
  announcing `HELLO Deckhand-0528 v2` every two seconds to a host that never answered.
  **Nothing in the log said so.** The tick line read `via=usb,ble`, which is what one board
  on two transports looks like and what two boards on one each would have looked like; the
  measurement that settled it was a `SCREENSHOT` returning exactly ONE 320x480 capture, and
  `[device/usb]` and `[device/ble]` reporting the identical `BATT mv=4162 pct=96`.
  Every matching port is now opened and run as its own **link**, and the scan repeats every
  `RECONNECT_INTERVAL_MS`, so a board plugged in later is picked up without a restart.
  `SERIAL_PORT` still RESTRICTS the host to exactly one port, and the candidate list is
  logged on the edge (`USB: 2 candidate port(s): ... - every one of them is opened as its
  own link`), because "which ports did you find and which did you choose" was the first
  question and nothing in the log answered it.
- **A LINK IS THE UNIT OF IDENTITY, and its id comes from the PORT PATH** (`usb:usbserial-10`),
  not from the device name. The name is learned from `HELLO` and sometimes never arrives,
  while a dedupe key, a reply route and a capture buffer all need an identity from the first
  byte. The name, once known, is what the log shows (`[device/usb:Deckhand-0528]`) and what
  an answer's HMAC is verified against. The tick's `via=` lists the links by name:
  `via=usb:Deckhand-C114,usb:Deckhand-0528,ble`.
- **`deviceNameFor()` REFUSES TO GUESS once a second board is attached.** With one link it
  still falls back to the selected device, which is how a host that attached mid-run has
  always worked. With two, an unnamed link resolves to `""`: the old fallback would have
  attributed one board's `ANSWER` to the other, and although the HMAC then fails closed, the
  refusal would name the wrong subject - the defect class this repo keeps paying for.
- **AN UNNAMED LINK CANNOT ANSWER, so the name is MADE to arrive.** `HELLO` is a boot-only
  15-second burst, and the firmware's own comment explains why that was always enough:
  *"Opening the USB port resets the ESP32, so this boot-time line reliably reaches a host
  that connects at any time."* That is true of board 1's CH340 only when the modem lines are
  actually driven, and node opens the port without driving them. **Measured:** board 1
  cabled and sending `BATT` for minutes while never once saying who it was. A link with no
  name after 6s now gets ONE reset pulse - RTS asserted drives EN low, released it boots,
  and DTR is held false throughout because asserting it drives GPIO0 low and that is the
  BOOTLOADER, not a reboot. Loudly logged. **Measured:** both boards named themselves
  within two seconds of the pulse, and forcing the grace to 0.3s on board 1 alone reproduced
  it end to end (`has not said HELLO in 0.3s ... Pulsing RTS` -> `usb:usbserial-10 is
  Deckhand-0528`). `DECKHAND_NO_USB_RESET=1` disables it for anyone who would rather have an
  anonymous link than a reboot; `DECKHAND_HELLO_GRACE_MS` exists to exercise the path.
- **THE PULSE IS FOR BOARD 1 ONLY, gated on the CH340's vendor id.** It first shipped
  ungated, and the comment claiming it could not power-cycle a board forever was wrong on
  board 2. `{dtr:false, rts:true}` is ALSO esptool's USB-Serial-JTAG reset sequence, which
  board 2's controller implements in hardware under `USBMode=hwcdc`; board 2's serial port
  **is** the SoC, so the reset DROPS the USB device, the port closes, the close handler
  splices the link out and `link.pulsed` dies with the link object. "Once per link" therefore
  bounded nothing there, and a watchdog restart or a relaunch against a board that had been
  up for hours would have rebooted it six seconds later, discarding an open answer window, a
  fetched scrollback or an in-flight capture. Two changes: the gate is `usbIsCh340(link)`,
  reading the `vendorId` `SerialPort.list()` gives before any `HELLO` (`1a86` CH340 =
  board 1, `303a` Espressif native USB = board 2), falling back to the path shape only when
  `SERIAL_PORT` named a port that is not currently enumerated and there is no vendorId to
  read; and the once-only record is `usbPulsedPaths`, keyed on the PORT PATH and living
  OUTSIDE the link object, so a close/reopen cannot turn "once" into a loop. Both refusals
  name their cause in the log. **NOT verified against a live restarted host** - proved by
  `multi-device-check.mjs`, which executes the real `scanUsbPorts`/`openUsbLink`/
  `armHelloPulse` against a stub `SerialPort`.
- **A HUNG OPEN NO LONGER PINS ITS PORT.** `usbOpening` is what stops the 3s re-scan
  double-opening a path; `openUsbLink` is called un-awaited, and a port that emitted neither
  `open` nor `error` used to leave its path in that set for the life of the process - that
  board dark, with nothing in the log but a stuck `USB: connecting to`. The wait is now a
  `Promise.race` against `USB_OPEN_TIMEOUT_MS` (10s, `DECKHAND_USB_OPEN_TIMEOUT_MS`
  overrides it to exercise the path), the path is released on every exit, and the un-awaited
  call has a `.catch()` that releases it too. Every one of those refusals says the path was
  released and the next scan will retry it.
- **`battByDevice` IS PRUNED AND BOUNDED.** Nothing used to delete from it, and an unnamed
  link keys on its port path - which renumbers - so every path a board had ever enumerated
  under left a permanent entry and the heartbeat's `batts` array republished every dead one
  every 5 seconds. A link's reading is now dropped in its `close` handler (keyed BEFORE the
  splice, because `deviceNameFor()` answers out of `usbLinks`) unless the same device is
  still reachable on another link - the ordinary cabled-and-BLE case. `MAX_BATT_DEVICES` (8)
  bounds it on top, oldest evicted first, because a port that renumbers mid-run leaves a key
  no close handler will ever name again.
- **THE HISTORY DEDUPE KEY IS NOT `senderKey()`.** `senderKey()` falls back to the LINK ID
  for an unnamed link, which is right for an `ANSWER` and wrong here: `deviceNameFor()`
  returns `""` for an unnamed USB link whenever a second USB link exists, so ONE device that
  is cabled and on BLE presented as TWO senders, the dedupe did not fire, and the `since:`
  reply was appended twice - every new message in the reader doubled. `scrollSenderKey()`
  therefore collapses every sender into one `(unattributable)` bucket for as long as ANY usb
  link is anonymous (which is exactly the pre-multi-device behaviour, for exactly the window
  in which it was the correct one) and returns to per-sender keying once every link has a
  name. The cost is the mirror image and deliberately the cheaper one: two boards asking for
  the same session, filter and range inside `SCROLL_REQ_DEDUP_MS` while one of them is
  anonymous, and the second is answered with silence for that request rather than with a
  corrupted transcript - and that drop is now LOGGED with its cause and its key, where it
  used to be a bare `return`.
- **FAN-OUT IS ONE COPY PER LINK - not per device times transports.** A cabled board 2 has
  always received the tick and every trigger-file command twice (its cable and its BLE link),
  which is why `KBTEST`, `KBPROBE`, `KBBUBBLE` and `POWERPROBE` dedupe on the device. Board 1
  adds one LINK, so it gets one copy and **no device receives more than it did before**.
  Suppressing the BLE copy for a board that is also cabled was considered and rejected: it
  would make delivery depend on the host having learned that link's name, which it sometimes
  never does. The command log now names its targets
  (`Sending command to 3 link(s) [usb:Deckhand-C114, usb:Deckhand-0528, ble]: SCREENSHOT`),
  because from the Mac a board that missed a command and a board that refused one look
  identical.
- **A REPLY GOES BACK TO THE BOARD THAT ASKED.** History and scrollback replies used to go to
  "the USB port"; with two boards that answered board 1's request down board 2's cable. They
  now go to the link the request arrived on, with one exception that PRESERVES an existing
  optimisation rather than adding a rule: a request that came over BLE from a device that is
  also cabled is answered over **that device's** cable, because BLE writes go out in 20-byte
  packets with a response awaited on each and the tick loop blocks behind them. Same device,
  faster pipe - never a different device. The chunk budgets, the ACK waiter key and the
  fetch generation are all per link too, so one board's fetch can no longer supersede the
  other's.
- **THE ANSWER AND PROMPT DEDUPES KEY ON THE SENDER, NOT THE LINE.** This is the subtlest
  correctness risk in the multi-device change, because the failure is a wrong answer reaching
  Claude. A device transmits every answer on both of its transports at once, so one device's
  two copies must still collapse - what these guards have always done. Keyed on the LINE
  alone, they would also collapse two DIFFERENT boards answering the same prompt with the
  same option index, which is entirely ordinary: the second board's answer would vanish with
  nothing saying so. The key is now `deviceNameFor(via) || via`, so an unnamed link is still
  its own sender rather than joining a shared bucket.
- **SHOT AND AUDIO CAPTURE BUFFERS ARE PER LINK.** One `SCREENSHOT` fans out to every board
  and their rows come back concurrently on separate ports; a single `shotCapture` would have
  appended both into one buffer and written one PNG that is neither board - and `finishShot`'s
  row-count guard could not have caught it, because the row counts add up. The PNG filename
  now carries the device (`shot-...-Deckhand-0528.png`); the timestamp alone was never a
  distinguisher, since board 2 finishes a capture in 0.4s and board 1 in ~18s but "rarely in
  the same second" is not a filename rule.
- **BATTERY IS STORED PER DEVICE.** A single `lastBatt` meant two boards overwrote each other
  every few seconds and the heartbeat showed whichever spoke last - one board at 96% and the
  other at 100% alternating under one label, which is worse than showing nothing. The
  heartbeat still publishes ONE `batt` (that is what the menu bar draws) but it is chosen by
  `batteryForHeartbeat()`, carries the `device` it came from, and every device's reading is
  beside it in `batts`. `links` lists what the host is actually driving.
- **BLE IS STILL EXACTLY ONE PEER.** Making it multi-peer was deliberately left out of this
  change. A second board therefore reaches the host over its cable only, which is enough for
  a cabled board and is why `via=` shows two USB links and one BLE. `lastVoice` is likewise
  still global, so a dictation started on one board is mirrored on the other - cosmetic, and
  unfixed.
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
