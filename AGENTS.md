# AGENTS.md

This file provides guidance to coding agents (Codex, and anything else that reads
AGENTS.md) when working with code in this repository.

**It is a verbatim copy of CLAUDE.md apart from this header. Update the two together.**
Note that the `Claude` references below are FACTUAL, not addressed at the reader: they name
Claude Code's own hook scripts, its `~/.claude/` directories, its `Claude Code-credentials`
keychain item, its `claude -p` CLI and the generated Claude spark art. Do not rename them -
a past search-and-replace over this file did, and pointed every path at a directory that does
not exist.

## Commands

Compile and flash the firmware (from the repo root; find the serial port with `ls /dev/cu.usbserial-*`):

```
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display
arduino-cli upload -p /dev/cu.usbserial-XXXX \
  --fqbn "esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app" \
  firmware/deckhand_display
```

The `FlashMode=dio,FlashFreq=80,UploadSpeed=115200` FQBN options are required for this exact
board — the default QIO flash mode causes upload failures on it. `PartitionScheme=huge_app`
(3MB app / 1MB SPIFFS instead of the default 1.2MB/1.5MB split) is required because the BLE
stack alone is ~700KB+, which pushed the default partition close to full. This project doesn't
use OTA updates or the SPIFFS partition for anything, so trading that space for a bigger app
partition is free.

Run the host script — **via `DeckhandBLE.app`, not plain `node`, if Bluetooth is wanted**:

```
cd host && npm install
open DeckhandBLE.app --args "$(pwd)/index.mjs"
```

`DeckhandBLE.app` is a minimal ad-hoc-signed app bundle whose `Contents/MacOS/Deckhand` **is a copy
of the real `node` binary** (plus `libnode.147.dylib` copied alongside it, since Homebrew's node
links that dynamically via `@rpath`), with an `Info.plist` declaring
`NSBluetoothAlwaysUsageDescription`. This exists because macOS's TCC framework kills a bare
`node` process outright (not even a permission prompt, just an immediate crash logged under
`~/Library/Logs/DiagnosticReports/`) the instant it touches CoreBluetooth without that Info.plist
key. Launching via `exec` from a wrapper shell script does **not** work — `exec` replaces the
process image, and TCC's crash report then blames plain `node`, not the wrapper, meaning the
Info.plist was never actually associated with the running process. The executable inside the
bundle has to *be* node, and it has to be launched via `open` (not by executing the binary path
directly) for TCC to recognize it as a real app capable of showing a permission prompt rather
than an unprompted denial.

**Plain `node index.mjs` does NOT work, even for USB-only.** This file used to claim the BLE half
"fails silently and USB is unaffected" — that is false on macOS 26. noble's CoreBluetooth init gets
the process **SIGABRT'd** (exit 134) a second or two after startup; the crash report says
`"namespace": "TCC"`. So there is no bare-node fallback: always launch via `DeckhandBLE.app`. For a
genuinely USB-only job (e.g. driving one command and reading the reply), write a throwaway script
that imports **only** `serialport` and never touches noble — that survives, because nothing in it
touches CoreBluetooth.

Two more traps that will cost you an hour if you don't know them:

- **`DeckhandBLE.app` breaks when Homebrew's node moves.** Symptom: `open DeckhandBLE.app` appears
  to succeed (it even returns 0) but no process survives and `/tmp/deckhand-host.log` is never
  created. The crash report under `~/Library/Logs/DiagnosticReports/Deckhand-*.ips` says
  `"namespace": "DYLD", "indicator": "Library missing"` — e.g. `libada.3.dylib` missing after
  `ada-url` moved to 4.x. Fix is the documented rebuild at the bottom of this file (re-copy `node`
  + `libnode.*.dylib` into the bundle, re-`codesign`). Check crash reports FIRST when the host
  won't start; a silently-exiting `open` looks exactly like a code bug and isn't one.
- **The CH340 only flushes its receive buffer when the host WRITES.** A listen-only serial probe
  reads **zero bytes** from a perfectly healthy device — verified: 8 seconds of boot log arrived in
  one burst the instant a single byte was sent. Any ad-hoc probe must write periodically (a bare
  `"\n"` is ignored by the device) or you will conclude the board is dead when it is fine.

Trigger on-device actions without reflashing, by writing to a file the running host script
watches and forwards over whichever transport(s) are already connected:

```
echo "RECAL" > ~/.claude/deckhand-device-command   # force touch recalibration
echo "MICTEST" > ~/.claude/deckhand-device-command # 10s mic level report (beeps, then speak)
echo "MICMON" > ~/.claude/deckhand-device-command  # live mic meter on the device (tap to exit)
echo "MICREC" > ~/.claude/deckhand-device-command  # 4s one-shot capture (mu-law, known-good)
echo "MICSTREAM" > ~/.claude/deckhand-device-command # stream until tapped (ADPCM, up to 120s)
```

The on-screen record button runs the STREAMING path (`micStream`), not `MICREC` - tap to start,
tap to stop, up to 120s. `MICREC` is the short one-shot fallback. Captures land
in `~/Deckhand-audio/capture-<ts>.txt`. Turn one into a playable WAV and measure what's in it
(de-combs the BLE interference, band-passes for speech, prints before/after SNR, refuses anything
under 98% complete, writes `<out>` and `<out>-clean.wav`):

```
node host/mic-wav.mjs [capture-or-log] [outfile] [last|loudest|<index>]
```

Decode **and transcribe locally** with whisper.cpp (see the STT note under Architecture):

```
host/mic-stt.sh            # newest capture -> SNR + transcript
```

**Find the serial port dynamically** — it renumbers (it has been both `usbserial-110` and
`usbserial-10`, and a hardcoded path fails confusingly):

```
PORT=$(ls /dev/cu.usbserial-* | head -1)
```

Do **not** open a second/new USB serial connection to send ad-hoc commands (e.g. via a one-off
`node -e` script) — opening a connection pulses the CH340's reset line and reboots the ESP32
before anything reaches it. Always go through the trigger-file mechanism above so the command
rides the connection the running host script already has open. (BLE doesn't have this problem —
only USB's CH340 auto-reset behaves this way.)

There is no test suite or linter in this repo; verification is "compile, flash, watch the
Serial Monitor / host log, and check the physical screen."

## Architecture

This is a three-part system, and the interesting behavior only makes sense once you see how
data flows across all three:

```
Claude Code hooks (ANY surface: terminal, desktop app, VS Code) + statusLine (terminal only)
        |
        v
~/.claude/deckhand-statusline.mjs, ~/.claude/deckhand-session-hook.mjs   (live outside this repo)
        |  write to
        v
~/.claude/deckhand-rate-limits.json, ~/.claude/deckhand-sessions/*.json
        |  read every 5s by                       Anthropic OAuth usage endpoint
        v                                          (polled every 5 min) |
host/index.mjs  <----------------------------------------------------- +
        |
        --(USB serial AND/OR BLE, JSON lines)-->  deckhand_display.ino
```

**USB and BLE are independent, not fallback-of-each-other.** Both are always enabled on the
device simultaneously, and `host/index.mjs` sends the same computed payload to whichever are
currently connected each tick — it's normal for both to be live at once (`via=usb,ble` in the
log). This is a deliberate change from an earlier classic-Bluetooth-SPP design: SPP let the host
just open a different serial port path with almost no code change, but turned out to be
unreliable on this Mac (macOS's classic-BT stack would silently accept writes into a connection
with no real over-the-air session — confirmed via a heartbeat that never arrived — and that
failure recurred even after a full unpair/restart/re-pair). BLE (a custom GATT service using the
Nordic UART Service UUIDs) replaced it because BLE is far more actively maintained on macOS,
since it's what nearly all modern accessories use.

On the firmware side, USB is a polled `Stream` (`pumpStream()` in `loop()`). BLE data arrives
via the RX characteristic's `onWrite()` callback, which runs on the Bluetooth stack's own task
(`BTC_TASK`), **not** loopTask — so `onWrite()` does exactly one thing: copy the bytes into a
FreeRTOS stream buffer (`bleRxStream`) that `loop()` drains. Both paths then funnel into the
same `feedChar()` / `processCompletedLine()` logic on loopTask. **Never render, beep, or touch
any driver (TFT/LEDC/ADC) from a BLE callback**: an earlier version processed lines inline in
`onWrite()` and crash-looped with `assert failed: xTaskPriorityDisinherit` (a driver mutex
locked on loopTask, released from BTC_TASK) plus `task_wdt` IDLE0 timeouts. It survived months
only because the BLE copy of each line usually found every draw-cache already updated by the
USB copy; per-second UI fields and the beeper's LEDC calls made real cross-task work common
and it finally tripped. On the host side, BLE scans by **advertised name** ("Deckhand"),
not by service UUID — the 128-bit custom UUID usually doesn't fit in the 31-byte primary BLE
advertisement alongside anything else, so a UUID-filtered scan can miss the device entirely.

**The two files under `~/.claude/` are not part of this repo but are load-bearing.** They're
registered in `~/.claude/settings.json` (`statusLine` + `hooks`) and are the *only* source for
two things `host/index.mjs` cannot get any other way:

- FALLBACK "% of plan quota used" (`deckhand-statusline.mjs`, via `rate_limits.five_hour` /
  `.seven_day` in the statusLine JSON). The statusLine only runs in *terminal* sessions (the
  desktop app and VS Code extension never invoke it), so this cache can go hours-stale. The
  PRIMARY quota source is now in `host/index.mjs` itself: it polls Anthropic's OAuth usage
  endpoint (`api.anthropic.com/api/oauth/usage`, the same data Claude Code's `/usage` screen
  shows) every 5 minutes, authenticating with the OAuth token read from the macOS Keychain
  ("Claude Code-credentials"), falling back to the statusLine cache on any failure (it
  rate-limits bursts with HTTP 429; back off, don't hammer). The host **does refresh** that
  token when it's expired/near-expiry (see the token-refresh note below) — the always-on host
  can't rely on a Claude Code surface being open to renew it.
- Per-project session status (`deckhand-session-hook.mjs`, via `SessionStart`, `UserPromptSubmit`,
  `PreToolUse` matched to `AskUserQuestion|ExitPlanMode`, `PermissionRequest`, `PostToolUse`,
  `PostToolUseFailure`, `Notification`, `Stop`, `SessionEnd`). Status is one of `working` /
  `asking` / `waiting`, keyed by `session_id`, one JSON file per session, deleted on
  `SessionEnd`. **`PermissionRequest` is the only permission-prompt signal that fires in every
  surface** — the desktop app never fires the `Notification` hook at all (verified: a desktop
  session with 650+ logged tool events and many allow/deny dialogs produced zero Notification
  events), so before `PermissionRequest` was registered, desktop permission prompts showed as
  `working` instead of `asking`. `Notification` stays registered for terminal sessions: it maps
  to `asking` only when `notification_type` is `"permission_prompt"` (confirmed via a captured
  real payload); any other Notification (idle nudges) maps to `waiting`, which can't incorrectly
  override an already-correct `waiting` status the way blindly mapping to `asking` once did.
  `PostToolUseFailure` maps to `working` so a *denied* permission clears `asking`.
- **Remote answering — WHICH EVENT WE BLOCK ON IS THE WHOLE TRICK, and it was measured, not
  reasoned.** For answerable prompts the hook publishes an `ask` object (pid, single-line-flattened
  ≤34-char title, ≤1400-char detail, ≤4 option labels of ≤32 chars) in the session file so the
  device can display it. Whether it then **waits** depends entirely on the event:
  - **`PermissionRequest` → WAIT.** Claude Code shows its dialog *while this hook runs*, so waiting
    costs the Mac nothing: the Mac dialog and the device's buttons are both live and the first
    answer wins. The hook blocks up to 90s (settings.json hook `timeout` is 100s to match) polling
    `~/.claude/deckhand-answers/<session_id>.json`.
  - **`PreToolUse` (`AskUserQuestion`/`ExitPlanMode`) → NEVER WAIT.** The *tool* draws that dialog
    and it doesn't run until the hook exits, so nothing is on screen while you wait. Publish the
    ask for display only, then exit (~30ms).

  Evidence, from 3066 real events in `~/.claude/deckhand-session-hook-debug.log` (re-derive it there
  before changing this): 310 `PermissionRequest` prompts resolved on a smooth 2–60s human-response
  curve with **no spike at the 90s timeout** — impossible unless the dialog was on screen the whole
  time. Meanwhile three `AskUserQuestion` `PreToolUse` events sat at **exactly 90.1s**, the full
  timeout, answerable nowhere but the device. That second case shipped once as the unconditional
  behavior and read as a bug ("when Claude Code asks questions, the options only show on the
  device") — the fix was to move the wait to the right event, **not** to stop waiting.

  **A question fires BOTH events**, `PreToolUse` first then `PermissionRequest` ~0ms later, and the
  `PermissionRequest` payload carries the full `questions[0]` with its real option labels (verified
  against a captured payload). So questions are answerable from the device via their
  `PermissionRequest`, with the Mac's dialog visible throughout — nothing is given up. This is why
  `buildAsk()` checks `tool_name` **before** `hook_event_name`: get that order backwards and a 4-way
  question renders as a generic "Allow AskUserQuestion?" with Allow/Deny.
  `emitDecision()` therefore switches on the **event** for the dialect and on `ask.kind` for the
  meaning: allow/deny for a `perm` or `plan`, and for a `question` a **deny whose message carries
  the chosen option** (there's no native channel for handing Claude a selected answer).
  Because the Mac usually wins the race, `waitForRemoteAnswer()` also watches the session record and
  **bails the moment its `ask` disappears** (the next event rewrote it) — 1.8s measured instead of
  holding a node process for the full 90s on every prompt.
  `remoteAnswer` (in `~/.claude/deckhand-secret`, surfaced in the heartbeat and every payload,
  toggled by the menu bar's **Answer prompts on device** → `REMOTE on|off`) is **on by default** and
  is just an off switch: off means never wait, i.e. a read-only mirror. Absent/unset reads as on.
  The device keys off the **per-prompt** `ask.answerable` stamped by the hook, *not* the live global
  flag — that's what makes flipping the toggle mid-prompt safe, and it's what marks a `PreToolUse`
  ask read-only while its `PermissionRequest` twin is answerable. For a read-only ask the device
  draws the options as a flat list under "ANSWER ON YOUR MAC" and swallows taps, so it never offers
  a control that can't work (and `visLines` reserves that caption's row, or a full-length detail
  runs into it). The host also drops `ANSWER` lines while answering is off.
  Nothing strips a display-only `ask` — the next event for that session
  (`PostToolUse`/`PostToolUseFailure` → `working`) rebuilds the record without it.
  Two hard rules: the hook waits **only** when `/tmp/deckhand-host-alive` (host heartbeat, written
  every tick) is fresh, says `connected`, **and** doesn't say `remoteAnswer:false` — otherwise every
  prompt would stall 90s for nothing — and it must never write anything to stdout **except** a
  genuine `emitDecision()`, because any stray JSON on a `PermissionRequest` hook's stdout can
  auto-allow/deny the dialog.
- **Remote-answer authentication (A + B), so only the paired Mac can decide.** (A) The device
  advertises a unique name `Deckhand-XXXX` (from its eFuse MAC) and the host, having learned that
  exact name over USB (`HELLO <name>`), pins BLE to it — no cross-connecting to another unit in
  the room. Because the longer name plus the 128-bit service UUID overflow the 31-byte BLE
  advertisement, the firmware **does not advertise the service UUID** (the host matches by name
  anyway). (B) Host and device share a 128-bit secret, pushed to the device **only over USB** via
  `PROVISION` (stored in NVS; BLE `PROVISION` is ignored — the whole point). Each forwarded `ask`
  carries a per-prompt `nonce`; the device returns `ANSWER … <hmac>` where hmac =
  HMAC-SHA256(secret, `nonce:pid:idx`)[:16] — ESP32 `mbedtls_md_hmac` on one side, Node
  `crypto.createHmac` on the other, **verified interoperable**. The host rejects answers with a
  bad/missing MAC and consumes the nonce on success (single-use, no replay). This protects the
  *decision*, not the confidentiality of the (still-unencrypted) BLE data — deliberate, since
  macOS + noble handle BLE bonding poorly.
- **Multi-pairing: one key per (Mac, device) couple.** Both sides remember several partners, each
  with its **own** key, so forgetting one revokes only that pair and a leaked key can't
  authenticate anything else. The Mac has a stable `hostId` (8 hex) that it sends on `PROVISION`
  **and in every payload**; the device uses it to pick which stored key to sign an answer with, so
  a device shared between Macs always answers the one that asked. An unknown `hostId` leaves
  `activeHost = -1` and `authHmac()` refuses to sign — the host then rejects the unsigned answer,
  which is the safe direction. Host store (`~/.claude/deckhand-secret`, mode 600) is
  `{version:2, hostId, devices:[{name,secret,label,lastSeen}], selected}`; v1 `{secret, device}`
  files migrate in place **keeping the old key**, so an existing pair survives the upgrade.
  `savePairing()` also `chmod`s every write — `writeFile`'s `mode` only applies on creation, so a
  pre-existing file would otherwise keep loose permissions. Device stores up to `MAX_HOSTS` (4)
  NVS slots (`h<i>id`/`h<i>sec`/`h<i>lb`, plus `hallow`), and migrates the legacy single
  `blesecret` into slot 0. Answer verification is **per transport**: `deviceNameFor(via)` keys off
  the BLE peer we connected to, or the USB name from `HELLO` — falling back to the selected device,
  since the `HELLO` burst is boot-only and we may have attached mid-run (a wrong guess just fails
  the HMAC).
- **Protocol versioning — `HELLO <name> v2`.** The device advertises which pairing protocol it
  speaks. Only for `v2` does the host send the new `PROVISION <hostId> <secret> <label>`; older
  firmware gets the bare `PROVISION <secret>`, which still works because the key sent *is* that
  pair's key. This gate is load-bearing: pre-v2 firmware treats everything after `PROVISION ` as
  the secret, so sending the new form to it would silently store the wrong key and break answering.
  The label may contain spaces (it's the Mac's hostname) — the device splits on the first two
  spaces only.
- **Choosing which pair is live.** Mac side: the menu bar's **Device** submenu lists every paired
  device with a checkmark on the chosen one, plus **Any device**; picking one writes
  `SELECT <name>` to the command-trigger file, and the host re-points its BLE scan (dropping the
  current link via `rescanBle()`). Device side: **SETTINGS › PAIRED MACS** lists the remembered
  Macs — tap one to restrict answering to it (`hallow`), tap again or tap **ANY MAC** to clear,
  tap the `x` to forget just that Mac. `uiListRow` takes a `rightInset` so the "ONLY" tag is
  placed clear of the `x` (they overlapped when both were right-aligned to the same edge).
- **Confirm dialog (one component, every consequential action).** RESET PAIRING, POWER OFF,
  CALIBRATE TOUCH and a host row's `x` all route through `pendingConfirm` + `drawPendingConfirm()`
  rather than firing on the tap. The dialog states the **consequence**, not just the question
  ("every paired Mac is forgotten", "deep sleep - touch the screen to wake"), CANCEL keeps the
  accent as the safe default, and the action button carries its own severity colour. It is
  **modal**: `handleSettingsTouch` handles it first and swallows every other touch including the
  pager, so a stray tap can't page away and strand it; taps in the gap between the two buttons are
  ignored rather than guessed. `drawSettingsStatic()` clears `pendingConfirm`, so a page redraw can
  never re-enter a stale dialog, and **`renderSettingsTab()` returns early while a dialog is up** —
  without that, the periodic repaint (every host tick, ~5s) painted the page's values straight over
  the dialog: it looked half-erased AND `pendingConfirm` stayed set, so touches outside the button
  row were swallowed and the UI appeared frozen.
  **`drawSettingsStatic()` resets the settings caches itself.** It repaints the chrome the
  change-only fields are drawn ON, so those caches are stale by definition; a caller that forgot
  left the values BLANK (they hadn't "changed", so `drawIfChanged` skipped them). That was the
  empty page after CANCEL and the intermittent missing text. Resetting inside the function rather
  than at each call site makes the invariant impossible to forget. **Two calibration paths deliberately skip the dialog**: the
  first-boot run (touch isn't calibrated yet, so a confirm button would be untappable) and the
  `RECAL` command from the host — that one is an explicit instruction from the Mac and is the
  escape hatch when touch is misaligned, so requiring a tap to confirm would defeat it.
- **Re-pairing controls (switching device⇄Mac).** Device side: **SETTINGS › Actions › RESET
  PAIRING** (`resetPairing()`) now wipes **every** slot (and the legacy `blesecret`, so a migration
  can't resurrect it) so the device reads "unpaired" and bonds fresh to the next Mac it's USB'd
  into; it deliberately does **not** re-`HELLO` (that would let the current Mac instantly re-pair,
  defeating a move). To drop one Mac and keep the rest, use PAIRED MACS instead. Host side: the
  menu-bar app's **Forget device** writes `FORGET <name>` (explicitly named, so it forgets the one
  shown rather than whatever is current when the host reads the file); the host intercepts it (not
  forwarded to the device) and deletes that entry *and its key*. The heartbeat carries `device`
  (who we're actually talking to), `selected`, and `devices[]`, so the menu bar renders the picker
  without ever reading the secrets file.
- **Device names are validated against `/^Deckhand-[0-9A-Fa-f]{4}$/` before they can become a
  pairing**, both on load and on every `HELLO`. During the baud experiments, corrupted `HELLO` lines
  (garbled by a mismatched rate) minted junk entries like `"Deckhand-\ufffd\ufffd\u0002v2"`, which
  burn slots in a list capped at `MAX_PAIRED_DEVICES` and would eventually push the real device out.
  Malformed entries already in the file are dropped on load, with a log line saying how many.
- **`HELLO` is re-announced in a burst for the first 15s after boot** (every 2s, in `loop()`), not
  just once in `setup()`. The single boot `HELLO` can land before the host's serial reader is ready —
  harmless normally (the host also loads the selection from `deckhand-secret`), but after a host-side
  `FORGET` the pin is empty and re-pairing *depends* on catching a fresh `HELLO`, which the one-shot
  missed. The burst is idempotent (host re-pins/re-provisions only on a change) and boot-only, so a
  device-side RESET PAIRING (no reboot) still won't silently re-pair. (`deviceNameReported` is now
  vestigial — nothing gates on it.)

- **Codex support is PULL, not push — it has no hooks, and that shapes everything.**
  Claude Code state arrives because `deckhand-session-hook.mjs` is *invoked* on every
  event. Codex offers no such mechanism, so the host reads its files instead. Verified
  against real rollouts on this machine:
  Everything comes from `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`:
  `session_meta` (cwd, `thread_source`), `turn_context` (live cwd, model), `event_msg`
  `task_started`/`task_complete`, and `token_count.rate_limits`.
  Consequences worth knowing before changing any of it:
  - **Freshness is the rollout file's MTIME. `session_index.jsonl` is NOT used, and
    that's the first thing that broke in real use.** That file exists, has one line per
    thread with an `updated_at`, and looks like exactly the right index — but Codex
    appends to a rollout LIVE and only rewrites the index later. Measured while a
    thread was actively in use: index said **26 minutes idle**, the rollout had been
    touched **1 minute** ago. Keying off the index made an open Codex session invisible
    on the device. Walking the tree is cheap (one directory per day, a couple of dozen
    files after months of use) so it runs every tick — and an early version that cached
    id→path lookups *including misses* permanently hid any thread whose rollout didn't
    exist yet at first look.
  - **Rollouts are read HEAD **and** TAIL, never whole.** `session_meta` is the FIRST
    record (cwd, `thread_source`) while status and `rate_limits` are in the LAST ones,
    and a long thread's file runs to megabytes. Two 64KB windows keep it O(1) per
    thread. A window can slice a line in half, so every line is parsed defensively.
  - **The id alone doesn't give the path** — files are named `rollout-<timestamp>-<id>`
    under a date tree, so the host walks the tree once and caches id→path (misses
    cached too, or it re-walks every 5s tick).
  - **`thread_source != "user"` is skipped.** Codex spawns subagent threads for
    auto-review and guardian; they are not something a person is waiting on, and they
    would crowd the 6-row list.
  - **A Codex row can only ever be `working` or `waiting`.** No approval event appears
    in any rollout on this machine, so there is nothing to map to `asking`. This is a
    real gap, not an oversight: the device exists to show who needs input, and for
    Codex it can only show who is busy. Codex threads also can't be answered from the
    device, since there's no channel to answer through.
  - **Usage comes from `token_count.rate_limits`, and it is ONE number.** `primary` is
    the only populated window (`window_minutes: 10080` = 7 days on a Plus plan);
    `secondary` is null but is passed through if a plan ever fills it. There is no
    endpoint to ask — unlike the Claude side's OAuth poller — so the newest
    `rate_limits` ever seen is retained across ticks and published with `cxAgeSec`, and
    the device dims it past 15 minutes for exactly the reason `quotaAgeSec` exists: a
    value read from a file that stopped being written is not a live reading.
  - Payload keys are short (`cxPct`/`cxResetMin`/`cxWin`/`cxAgeSec`, `agent:"cc"|"cx"`)
    because they ride in **every** tick and the device's line buffer is sized for asks
    carrying 1400-char details.
- **Session history is PULL, on demand, and PAGED FROM THE MAC.** Opening a session's
  detail screen and tapping the card opens a HISTORY reader. The device sends
  `HISTORY <id12> <chat|all> <page|last|item:N>` and the host replies with ONE JSON line
  whose only key is `hist`, so it can never be confused with a tick payload (the device
  bails out of the parser before any usage field is touched).
  **The device stores only the screen it is showing.** Measured on a real transcript: 2515
  entries / 584KB, of which the conversation alone is 122KB, against ~94KB of free heap
  after the BLE stack — no device-side buffer can ever hold a session's history, so a
  bigger buffer is never the answer. The Mac keeps all of it and serves one screen at a
  time, which makes history length unbounded: that same session pages to **399 screens of
  chat, 1853 of everything**, and the biggest page is **774 bytes**.
  Everything comes from Claude Code's own transcript JSONL, whose path the hook records
  per session — `user`→`you`, `assistant [text]`→`claude`, `[tool_use]`→`ran` (tool name
  plus the one interesting field, not a JSON dump), `[tool_result]`→`out` or `no` when
  `is_error`. `[thinking]` and the meta types are dropped. **A denied permission and a
  chosen option both arrive as tool_results**, which is how "what I chose" shows up
  without a separate channel.
  - **TWO LEVELS, because one length can't serve both.** The list shows 300-char previews
    so a screen holds several rows; **tapping a row fetches that entry WHOLE** (4000-char
    cap, matching the device's buffer) into its own pager. With a single cap this failed
    both ways: at 600 chars the list was sparse AND long messages were still cut — and
    worse, an entry taller than one screen was silently CLIPPED by the device with no way
    to reach the rest. That is what "I can't see the full message" was.
  - **Body tap opens the row under the finger; paging is the buttons and the scrubber.**
    Spending the body tap on "next page" was the wrong trade, because reading a whole
    message was the thing the list could not do at all.
  - **The jump bar is a proportional SCRUBBER, not one segment per page.** At 399 pages a
    segment each would be a pixel wide. Tap anywhere along the track to jump to that
    fraction; the header shows position in the whole history (`412/628`), not a page number.
  - **CHAT is the default filter.** Tool calls outnumber conversation about 2:1, so an
    unfiltered view is mostly commands. The chip toggles to ALL.
  - **The reply goes over USB when USB is up, and BLE only as a fallback — never both.**
    BLE writes go out in 20-byte chunks with a response awaited on each, so at the 30ms
    connection interval macOS negotiates even a few KB is seconds, with the tick loop
    blocked behind it. Both transports reach the same device, so USB simply wins.
  - The parsed transcript is cached per session (paging 399 screens must not re-read a
    megabyte each time) but the cache is **bounded to the 2 most recently used** — a parsed
    transcript is ~600KB of strings and this process runs for days, so an unbounded cache
    grew by another transcript for every session ever opened.
  - The device's page arena is sized to what ONE SCREEN can hold (2.4KB), not to 24
    worst-case entries (15KB) — that difference comes straight out of the heap the audio
    path needs. If the host's wrap estimate lets a page arrive slightly oversized, the
    device drops the tail rather than overrunning the arena.
  - Paginated **by entry, not by line** — splitting an entry across a page makes it
    unreadable — and it opens on the NEWEST page.
  - The reader owns the whole screen, so it has to absorb the 5s tick the same way the
    settings confirm dialog does; without that the periodic repaint paints the detail
    screen straight over it.
- **Housekeeping: the host's own files are capped, because both grew forever.** Measured:
  the log appends a ~700-byte tick line every 5s = **4.4MB/day, ~131MB/month**, and audio
  captures are never overwritten (each is timestamped) at ~100KB–1MB a take.
  `/tmp/deckhand-host.log` now rotates at 5MB keeping one previous generation (`.1`), so a
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
  worse, its persisted `deckhand-oauth-attempt.json` / `-backoff.json`, which are the
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
  read did not shrink. Codex gets a 36px single row rather than a card, because one
  percentage plus a reset countdown is all it publishes — no token count, no second
  window, nothing to plot a pace against, so a full card would be mostly empty chrome.
  It shows `--`, never `0%`, when no `rate_limits` has ever been seen; 0% is a
  measurement and "never measured" is not.

**`host/index.mjs`** polls every `POLL_INTERVAL_MS` (5000ms) for: `ccusage blocks --active`
and `ccusage weekly` (token counts), the rate-limit cache file, and the sessions directory
(pruning any session file older than `SESSION_STALE_MS`, since a closed terminal may never
fire `SessionEnd`). It assembles one JSON object and writes it to USB (if `usbPort` is set) and
BLE (if `bleCharacteristic` is set) independently every tick, and refreshes the
`/tmp/deckhand-host-alive` heartbeat (`connected` + `remoteAnswer`) that gates whether the hook
waits for a remote answer at all. The **device→host
lane** exists too: USB serial RX plus a subscription to the BLE TX characteristic's
notifications, both funneled through `handleDeviceLine()` — `ANSWER` lines become answer files
for the hook (deduped, since the device transmits on both transports simultaneously); anything
else is just logged. Session list is capped at 6, **urgency-sorted (asking > waiting >
working, then recency)** so a needs-input session can't be pushed off-screen, with
`sessionsTotal`/`hiddenAsking` telling the device what was cut. Per-session `model` comes from
tailing the session transcript (last 64KB), because most hook events — and desktop-app events
in particular — don't carry a model field. It also writes all `console.log` output directly to
`/tmp/deckhand-host.log` via its own file stream (not just relying on stdout), because
`open`-launched apps don't inherit the launching shell's stdout redirection.

**`firmware/deckhand_display/deckhand_display.ino`** parses each JSON line and renders three tabs
(USAGE, SESSIONS, SETTINGS) plus a persistent footer (clock | battery pill | "Xs ago" freshness,
three fixed-width zones that cannot grow into each other). The one rule that
matters everywhere in this file: **every field is redrawn only when its value changes**, using
fixed-width padded strings compared against a per-field cache, never a
clear-then-redraw of a large area. This exists because the very first version redrew the
entire screen every second and visibly flickered — the discipline was added specifically to
fix that, and any new UI element needs to follow the same pattern (see `drawIfChanged`,
`drawBar`, `drawCardBorder` for the established helpers) or it will reintroduce flicker.

The **SETTINGS** tab shows Bluetooth/USB connection status from the device's own perspective
(`bleConnected`, set via `BLEServerCallbacks`; USB inferred from recent RX activity since a
CH340 UART has no real "connected" signal) — this is deliberately more trustworthy than macOS's
Bluetooth settings panel, which showed "not connected" for a link that was actually live during
development. It does **not** show a "which transport is active" indicator anymore — an earlier
version did, but since both transports are normally connected at once, that line just flip-flopped
between "via USB" / "via Bluetooth" every tick and was more confusing than informative.

Other things that aren't obvious from a single file:

- The touch controller (XPT2046) is wired to a **separate SPI bus** from the TFT (see the pin
  table comment at the top of the `.ino`), so it can't use TFT_eSPI's built-in touch support —
  it needs its own `SPIClass` instance and the standalone `XPT2046_Touchscreen` library.
- Touch calibration is a **5-point least-squares AFFINE fit** (four corners + centre):
  `sx = A*rx + B*ry + C`, `sy = D*rx + E*ry + F`, solved in `fitAffine()` — both axes share one
  3x3 normal-equation matrix, so it inverts once. The old 2-point fit derived `sx` from `rx`
  alone, so it could correct scale and offset but **not skew/rotation between the panel and the
  glass**, and it had no redundancy (one sloppy tap went straight into the mapping, and it always
  reported a perfect fit because it passes through both points by construction). Verified against
  synthetic panels: a 3-degree skew leaves a 0.03px residual under the affine fit versus **16.6px**
  under the old separable one. `runCalibration()` reports the **worst residual** at the targets and
  flags a loose run, and `fitAffine` returns false on a singular (collinear/nonsense) set so a
  broken mapping is never installed — it keeps the previous one instead. Coefficients are stored
  as a real array, not separate globals: separate globals aren't guaranteed contiguous, which
  previously corrupted this data when saved as a raw byte blob via Preferences. The Preferences
  keys are **versioned** (`cal5`/`calValid5`): v1 was corrupted, v2 used the wrong axis mapping,
  and v3's 2-point bytes mean nothing to the affine model, so bumping the key forces one fresh run
  rather than silently misreading old data as coefficients.
- `TOUCH_SWAP_XY` exists because this board's touch controller axes are swapped relative to
  the display; it's already set correctly for this exact board.
- The backlight is LEDC PWM on IO21 for the brightness setting, and `ledcAttach(TFT_BL_PIN,...)`
  must run **after** `tft.init()` — TFT_eSPI's init does a plain `pinMode`/`digitalWrite(HIGH)`
  on that pin (`TFT_BL` in its `User_Setup.h`), which silently strips an earlier LEDC
  attachment; that exact bug shipped once as "brightness buttons do nothing".
- Battery: charging (TP4054, ~290mA) and USB/battery power-path switching (Q3 P-FET) are pure
  hardware — firmware only *reads* the level, via the board's 100K/100K divider from BAT+ to
  IO34 (`analogReadMilliVolts * 2`, EMA-smoothed, table-mapped to %). There is **no VBUS-sense
  pin**, so "charging vs on battery" is inferred from recent USB serial RX; a data-less wall
  charger reads as "on battery" even though the hardware is charging. IO34 is ADC1 —
  deliberately, since ADC2 is unusable while WiFi/BT is active.
- Speaker: onboard FM8002E amp, input on IO26 (LEDC square wave), shutdown on IO4 (10K pulled
  high = muted; drive LOW only while a beep plays, else the speaker hisses). Beep volume is the
  `BEEP_DUTY` constant (duty out of 255), not the amp gain. The device double-beeps when any
  session *transitions into* `asking` (detected in `handleLine` by diffing against the previous
  poll's list); test it without real prompts by dropping a fake session file:
  `echo '{"session_id":"t","cwd":"/tmp/x","status":"asking","updated_at":'$(date +%s)'000}' >
  ~/.claude/deckhand-sessions/t.json` (delete it afterwards).
- **Microphone (MAX4466 electret amp) — HOW TO WIRE IT, and IO35 is the only pin that can do
  this.** Three wires, to the board's 4-pin **Expand** connector:

  | module pad | goes to | why |
  |---|---|---|
  | `VCC` | **3.3V** — never 5V | see the 5V warning below; this is the one that can destroy the pin |
  | `GND` | GND | — |
  | `OUT` | **IO35** | the only free ADC1 channel on this board |

  **Identify the Expand pins from the header's own silkscreen, and meter the rail before you plug
  the module in.** This repo does not record the physical pin ORDER of that connector — only the
  net each wire must reach — because guessing it is how you get the failure below. Confirm which
  pin is 3.3V and which is GND with a meter first; the remaining signal pin is IO35.
  IO35 is forced, not chosen: touch took ADC1's 32/33/36/39 and the battery divider took 34,
  leaving IO35 as the only free ADC1 channel — and ADC1 is mandatory because ADC2 is dead while BT
  is active. IO35 is input-only, which an ADC pin doesn't mind. The pin needs **11dB attenuation**
  (`analogSetPinAttenuation`); the module idles at VCC/2 (~1.65V) and at the default range that
  bias sits against the ceiling and clips everything. The SPI connector is useless for this
  (IO23/19/18/22 are digital-only or ADC2).
  **Never power it from 5V** even though the module accepts 2.4–5.5V: IO35 is not 5V tolerant, and
  at a 5V supply the op-amp biases at 2.5V and swings toward 5V, past the pin's absolute maximum.
  **A miswired module hangs `setup()` and looks exactly like bricked firmware**: reverse polarity
  makes the module conduct through its ESD diodes and drag the 3.3V rail, so the chip answers
  esptool all day (download mode draws little) but the sketch dies the moment it powers the
  backlight and BLE. Zero serial output plus a chip that still reads its MAC = suspect the
  peripheral, not the code. (Absence of ROM boot text proves nothing here — TFT_CS is GPIO15,
  which straps the ROM log off.)
- **Checking the wiring: the DC bias is the whole test, and it distinguishes all three faults.**
  Tap **SETTINGS › ACTIONS › MIC TEST** on the device, or run `MICTEST` for the serial report.
  What the numbers mean:

  | reading | meaning |
  |---|---|
  | `dc` ≈ **1893** counts (~1.65V), floor ~100–150 | wired correctly |
  | `dc` near 0, `min=0`, lots of `clipped` | **OUT not connected, or no power** — the firmware says this verbatim: `pinned near 0` |
  | `dc` ≈ 1893 but floor ~35 | powered, but gain is at the bottom — see the trimmer note |
  | `dc` ≈ 1893, floor ~750 | gain too high, the amp is oscillating — see the trimmer note |
  | device won't boot at all, dark screen, esptool still works | polarity reversed; unplug the module and it boots |

  The bias proves power AND the OUT wire in one number, which is why it is printed first.
- **Mic bring-up: three commands plus an on-device button, and the reason each exists.**
  - **SETTINGS › ACTIONS › MIC TEST** — runs `micMonitor()` (the live meter below) with no host
    involved. It is the first button on that page and deliberately has **no confirm dialog**: it
    changes nothing, exits on a tap, and you run it repeatedly while turning the trimmer. Two
    non-obvious requirements: `micWaitRelease()` must run BEFORE the meter loop (the tap that
    launched it is still down, and the loop exits on a touch, so it returned instantly without
    this), and the exit needs **two consecutive** `ts.touched()` reads (the same false positive
    that once ended a 99s recording nobody touched). On exit `micRestoreUi()` falls back to the
    "waiting for host" screen when no payload has ever arrived — which is exactly the standalone
    case a mic test happens in — so the settings handler repaints explicitly in that case only.
  - `MICTEST` — one-shot level report: DC bias (proves power + the OUT wire), per-window
    peak-to-peak, clip count, and a floor/peak **ratio**. The window is **10s on purpose**. At 4s
    the talking kept landing either side of the capture and every run read as room tone; the
    per-window profile still shows exactly when sound arrived, so a miss is distinguishable from a
    deaf mic. It beeps to mark the start (`MIC_CUE_DUTY`, deliberately independent of the SOUND
    setting — here the cue *is* the test) and the verdict requires **3+ elevated windows**, because
    speech is sustained and one elevated window is a knock. Judging by overall peak-to-peak
    reported "reacted to sound" for runs that were pure hum.
  - `MICMON` — live meter on the device's own screen, because the setting you want is "highest gain
    whose floor stays low" and that can only be found by watching the floor WHILE turning the screw.
    One-shot tests cost a round trip per quarter-turn, and the trimmer silently drifted back into
    oscillation between two of them.
  - `MICREC` — records real audio and dumps it as base64 for `host/mic-wav.mjs` to turn into a WAV.
    Levels only ever say "louder than the floor"; only listening settles usability.
- **`MICREC` samples by DMA (`adc_continuous`) at 32kHz, decimated 2:1 to 16kHz.** Every part of
  that sentence is forced:
  - A busy-loop capture would starve the core's IDLE task and trip the task watchdog, and the
    obvious workaround (yield every 200ms) punches 1ms holes in the audio at 5Hz — a buzz that
    wrecks the exact judgement being made. `adc_continuous_read()` blocks on a semaphore, so the
    hardware fills buffers gap-free while the CPU is free.
  - **16kHz because that is what Whisper is trained on.** At 8kHz everything above 4kHz is gone,
    and that band is where consonants separate (s/f/th) — it costs real transcription accuracy.
  - **32kHz because the driver's MINIMUM is above the rate we want**: on this chip
    `SOC_ADC_SAMPLE_FREQ_THRES_LOW` is 20kHz, so 16kHz cannot be requested directly either.
  - `adc_continuous_deinit()` is **not optional** — battery sampling needs ADC1 back for `analogRead`.
  - **ORDER IS LOAD-BEARING: create the ADC handle BEFORE the big audio buffer.** Backwards, this
    crash-LOOPS the device, and no error check can save you. `adc_continuous_new_handle` needs
    internal DMA-capable memory; with 64KB of audio buffer already taken there isn't enough, and on
    that failure the IDF's own cleanup calls `adc_continuous_deinit()`, which frees an APB peripheral
    it never claimed and calls `abort()` — a `SW_CPU_RESET`, not a return code. The abort happens
    *inside* the call. Decoded backtrace, for the record: `abort <- adc_apb_periph_free <-
    adc_continuous_deinit <- adc_continuous_new_handle <- micRecord`. Symptom from the outside:
    "white screen, then restart", looping.
- **Audio is stored as 8-bit G.711 mu-law, and that is what makes 16kHz possible at all.**
  16kHz × 16-bit × 5s is 160KB; free heap after BLE is ~94KB, so linear PCM capped a take at **2
  seconds** — too short to reliably catch a sentence. mu-law is logarithmic, keeping fine resolution
  near zero where this quiet signal lives, and 5s costs the same 80KB that 8kHz/16-bit did. Scaled
  ×8 into mu-law's 16-bit input range on the way in (the signal peaks ~150 ADC counts, so scaling
  keeps it clear of the coarsest steps); divided back out host-side.
  - The DC bias must come off **before** encoding — mu-law is non-linear, so there is no re-centring
    it afterwards the way linear PCM allowed. Measured over the first 200ms of frames, not assumed
    to be mid-scale (the real bias is ~1893, not 2048).
  - No digital gain, so the Mac can measure true SNR; scaling for audibility happens host-side,
    after measurement, where it can't flatter the numbers.
  - The 5s request falls back to 4s/3s when the heap won't take it, and reports what it got. **~4s is
    the ceiling** on this module (ESP32-32E **N4** — 4MB flash, no PSRAM), not a preference.
- **Recording is user-terminated and shows a live meter.** Tap the floating button to start, tap
  again to stop; it also stops when the buffer fills, and the log says which (`AUDIO stopped by
  tap|buffer full`). A fixed length is the wrong default for dictation. Meter and transfer progress
  live in a **pill over the bottom of the content area, not a full-screen takeover** — this device
  exists to show session/usage state, and blanking it for the ~13s a capture takes hides the thing
  it is for. The level bar earns its place: it is the only way to know the mic is hearing you
  *before* spending 9s shipping the audio. Metering runs between DMA reads, never inside the sample
  loop (4096-byte store buffer ≈ 64ms of slack, versus ~2ms to draw).
- **`micRestoreUi()` must reset the change-only caches, and delegates to `forceFullRepaint()`.**
  Repainting chrome WITHOUT resetting them leaves every field **blank**, because `drawIfChanged`
  sees an unchanged string and skips a field whose pixels were just erased. That shipped once as
  "USAGE shows no numbers after recording" — the identical trap `drawSettingsStatic()` already
  documents. Going through `forceFullRepaint()` also means values return from data already in hand,
  with no wait for the next host tick.
- **Long recordings STREAM (`micStream()`), because buffering physically cannot reach a minute.**
  60s at 16kHz is 960KB against ~94KB of free heap, and this module has no PSRAM — that is the whole
  reason `MICREC`'s one-shot path caps at ~4s. Streaming sends while recording, so RAM stops
  mattering and the LINK becomes the constraint. The rate budget at 115200 (11.5KB/s, this CH340's
  hard ceiling — see the baud note):
  | format | rate | verdict |
  |---|---|---|
  | 16kHz mu-law + base64 (the one-shot path) | 21.3KB/s | 185% — impossible |
  | 16kHz mu-law, raw binary | 16.0KB/s | 139% — impossible |
  | **16kHz IMA ADPCM (4-bit), raw binary** | **8.0KB/s** | **70% — fits** |
  So it takes **both** 4-bit IMA ADPCM *and* raw binary framing. Dropping base64 matters as much as
  the codec: its 33% tax alone is the difference between fitting and not.
  **Verified: 120.0s captured in 120.0s elapsed — 1,920,000 samples, `dropped=0 gaps=0`** — and a
  35.5s real dictation transcribed coherently. The bonus is bigger than the duration: the transfer
  finishes **when you stop talking**, so the ~9s post-capture wait is gone.
- **Streaming wire protocol.** Text control lines, binary payload:
  ```
  AUDIO stream rate=16000 codec=ima4 chunk=1024 scale=8 dc=1894
  AUDIO bin <seq> <n>\n   followed by exactly <n> RAW bytes (no trailing newline)
  AUDIO streamend samples=.. chunks=.. dropped=.. secs=.. by=tap|cap
  ```
  Host replies `AUDIO ack <seq>` per frame. Saved as the same base64 `AUDIO begin ...` envelope
  one-shot captures use, so the decoder needs no new file format — only the `ima4` branch. The
  decoder accepts **either** `AUDIO begin` or `AUDIO stream` as the header, because that is what the
  device actually emits and relying on the host to rewrite it broke once already.
- **The host's USB reader accumulates BYTES, not a string.** `chunk.toString("utf8")` mangles every
  non-ASCII byte silently, which is fatal for binary frames. It is a two-state machine over a
  `Buffer`: line mode until an `AUDIO bin` header says how many raw bytes follow, then byte-count
  mode for exactly that many. `mic-wav.mjs` picks the newest capture by the **timestamp embedded in
  the filename**, not by `sort()` — plain sort puts every `stream-*` after every `capture-*`
  regardless of age, so an old stream would shadow a fresh capture.
- **Flow control is a credit window, and three separate bugs had to be fixed to make it work. All
  three were silent.**
  - **`Serial.write` blocking ate 20% of the audio.** A 1024-byte chunk takes ~89ms to clock out at
    115200, but the ADC's DMA buffer held only ~64ms — so it overflowed *in hardware*, mid-write.
    Symptom: a 99s stream contained only 79s of samples, with `dropped=0` (the ring never overflowed;
    the loss was upstream of it). Fixed by **`Serial.setTxBufferSize(8192)` BEFORE `Serial.begin()`**
    so writes return immediately, a 16KB `max_store_buf_size`, and bulk `Serial.write(ptr, n)` calls
    instead of per-byte.
  - **The default 256-byte RX buffer deadlocked the window.** The host keeps sending its ~1KB payload
    every 5s during a capture; at 256 bytes that overflows while the device is busy sending, and the
    discarded bytes include the ACKs. Result: 8 chunks in 18s and half the samples dropped. Fixed by
    **`Serial.setRxBufferSize(4096)`**, a window of 8, and a **500ms safety valve** that slides the
    window by one on a stall — a lost ACK must cost throughput, never wedge the stream. The host
    detects any real gap by sequence number and reports it; the device reports `dropped` when its own
    ring overflows. Between them, loss is always visible.
  - **A spurious `ts.touched()` ended a 99s take early**, logged as `by=tap` when nothing was
    touched. Stopping now needs **two consecutive** touch reads — the panel throws occasional false
    positives, and one of them shouldn't end a long dictation.
- **`MICREC` (4s, mu-law, base64) is deliberately KEPT** alongside `micStream()` as a known-good
  short path to fall back on, and it is what the `MICREC` command still runs. The floating button and
  `MICSTREAM` use the streaming path. The 120s cap (`MIC_STREAM_MAX_MS`) and tap-only stop are
  arbitrary choices, not constraints.
- **The BLE radio puts a 33.3Hz comb across the speech band, and it's cancelled in software.**
  MEASURED, on two independent captures: macOS negotiates a **30ms** connection interval
  (240 samples at 8kHz — exactly 24 × 1.25ms), and each transmit burst pulls current on the 3.3V
  rail the mic amp shares. The result is a harmonic series — 66/100/133Hz at **+20 to +30dB** over
  the local floor and still ~+21dB of tonal noise at 300–600Hz, right where the voice is. Dropping
  the link removes it entirely (voice-band tones fall ~11x), but that would stop the device being a
  display while it records, so **BLE deliberately stays connected** and `host/mic-wav.mjs` cancels
  the comb instead. It is removable *because* it's periodic: it repeats every 240 samples and speech
  doesn't. Two details are load-bearing:
  - **MEDIAN per phase, not mean.** A mean is dragged around by whatever speech lands on a given
    phase; the median ignores those outliers and converges on the interference alone.
  - **The period is found by minimising the post-cancellation residual, NOT by autocorrelation.**
    Autocorrelation is captured by whatever is loudest — here a 70Hz rumble — and returned 222
    samples when the harmonic spacing plainly said 240; the filter then did nothing (16.8 vs
    16.9dB). Residual-minimisation optimises the actual goal and lands on 240 every time. It needs
    an `N/(N-P)` correction or a P-parameter template just picks the largest period on offer.
  - Processed in **~1s blocks**: the ESP32's sample clock and the Mac's BLE clock are independent,
    so the period drifts a fraction of a sample per second and one global template smears.
  Result on a real capture: SNR 13.3dB → **27.0dB**, noise floor 7.0 → 0.9, worst voice-band tone
  from +21.5dB prominence down to +6.1dB. Nothing about this requires offline processing — the
  period is stable, so it runs streaming with ~30ms of latency.
- **Analog mic gain: the trimmer's real failure mode is oscillation, not mis-level.** `VR1` is a
  `TC33X-2-104E`, a **single-turn** (~270°) 100K pot; gain is `1 + (R7+VR1)/R5` = **23x to 123x**.
  At high gain the amp **oscillates** on long unshielded leads: the floor sat at ~750 counts p-p
  (~600mV) of low-frequency, sound-insensitive hash that buried speech. Turning the gain down
  collapsed it to ~40 — an **18x** drop, far more than the 5.3x gain range can explain, which is
  what identifies it as oscillation rather than "too much amplification". A floor at ~40 equals the
  bare-ADC noise (35 counts with the mic unplugged), i.e. too little gain to prove the mic is even
  connected; aim for **~100–150**. Direction of rotation doesn't matter — turn fully one way, note
  the floor, then fully the other; the higher floor is the high-gain end.
- **Diagnosing mic noise: use the SPECTRUM, not peak-to-peak.** This cost most of a session.
  Broadband RMS/peak-to-peak said BLE was innocent (7.2 vs 7.7) and that a real voice was
  "indistinguishable from room tone"; the per-tone analysis found a 33Hz comb at +30dB and a clean
  +10 to +12dB of voice at 200–1200Hz. A narrow tone barely moves a wideband number while being
  plainly audible, and a listener hears speech far below where an RMS ratio calls it buried. Ranking
  noise by *band* also matters: the noise was a 70Hz rumble sitting where there is almost no voice,
  so a 180Hz high-pass (cascaded **twice** — 70Hz is only ~1.4 octaves down, one section only gets
  ~16dB) plus a 3kHz low-pass is nearly free of cost to the speech.
- **Captures go to `~/Deckhand-audio/capture-<ts>.txt`, NOT through the host log.** `AUDIO d` lines
  are handled in `handleDeviceLine()` ahead of any logging, deliberately: `console.log` writes to the
  log file **and** stdout, and under `open DeckhandBLE.app` stdout has no reader — so once that pipe
  fills the write blocks, the serial reader stops draining, and the OS buffer overflows. That cost
  ~19% of a dump's lines at 460800. It also keeps a megabyte of base64 out of the log. Output lives
  under `$HOME`, not `/tmp`: macOS prunes `/tmp` and has already eaten recordings wanted for
  comparison. One summary line per capture is logged, with a completeness percentage.
- **`host/mic-wav.mjs` REFUSES a capture under 98% complete (exit 2), and `mic-stt.sh` won't
  transcribe one.** A correctness guard, not politeness: truncation leaves holes in the base64,
  misaligned mu-law decodes as loud garbage, and Whisper transcribed one such capture as a confident
  *"I don't know. I don't know."* that nobody said. A plausible fake transcript is the most dangerous
  failure mode in this pipeline. It defaults to the newest capture FILE and prints a numbered list so
  an index can be passed. (It still falls back to the host log for older inline-base64 builds. Beware
  "last" as a default there — a stale `MICREC` in the command file is replayed on host restart and
  appends silent captures *after* the one you want, which once produced a confident and wrong "the
  capsule is dead, buy an INMP441".)
- **Local speech-to-text: `host/mic-stt.sh` → whisper.cpp, genuinely fast and free.**
  `brew install whisper-cpp`; models are NOT bundled by brew — fetch from
  `huggingface.co/ggerganov/whisper.cpp` into `~/.cache/whisper.cpp/`. Runs on Metal, offline, no API
  cost, and the audio never leaves the machine — which matters for a mic on the desk all day. It
  feeds the **cleaned** wav (the raw one still carries the BLE comb; Whisper has no reason to cope
  with interference we can remove first).
- **Use `ggml-large-v3-turbo-q5_0.bin` (547MB), NOT `base.en`.** Benchmarked on real captures from
  this mic, and the gap is not subtle:
  | said | base.en (141MB) | large-v3-turbo q5_0 |
  |---|---|---|
  | "Update CLAUDE.md file" | "update, CLAUDE and D5" | **correct** |
  | a spoken first name | invented a different name entirely | within one phoneme |
  | "Can you design a system?" | "Can you see that in the system?" | **correct** |
  | 35.5s clip | 341ms | **840ms (42x realtime)** |
  Turbo's decoder is 4 layers instead of 32, so it stays far faster than realtime while being much
  more accurate. `base.en` is the second-SMALLEST model and was inventing proper nouns.
- **Vocabulary priming (`--prompt` + `--carry-initial-prompt`) is free accuracy.** Whisper has no
  idea what this project's nouns are: a real dictation of "update CLAUDE.md" came back as "update
  core code MD5". An initial prompt listing the expected terms biases the decoder at zero cost.
  `--carry-initial-prompt` re-applies it to every 30s window, which matters for long dictations -
  without it only the first window is conditioned. Priming alone did NOT fix `base.en`
  ("update, CLAUDE and D5"); priming plus turbo did. Both overridable via `WHISPER_MODEL` /
  `WHISPER_PROMPT`.
- **Parakeet is a dead end for now, despite the runtime being installed.** whisper-cpp 1.9.2 ships
  `parakeet-cli`, `parakeet-quantize`, `libparakeet.dylib` and `parakeet.h`, and `parakeet-cli`
  defaults to `ggml-parakeet-tdt-0.6b-v3.bin` — but no compatible model is published. The only GGUF
  found (`cstr/parakeet-tdt-0.6b-v3-GGUF`) fails with `invalid model data (bad magic)`: it targets a
  different runtime. Every plausible `ggml-parakeet-*` repo 404s, and brew ships no conversion
  script, so producing one means converting NVIDIA's NeMo checkpoint with torch/NeMo. Worth
  revisiting only if someone publishes a real ggml `.bin` — Parakeet TDT is a transducer, so it
  would be faster than Whisper, but turbo already solves the accuracy problem.
- **A dictation is DELIVERED TO YOU, not run for you (`DECKHAND_VOICE_DELIVERY`, default
  `clipboard`).** The transcript goes to the Mac's clipboard plus a notification naming the project
  to paste into; the device card reads COPIED - PASTE IT. `dispatch` restores the original
  behaviour below. The default flipped after the first real use, which produced all three of these
  at once: the headless run became a **second author** appending to the same conversation
  concurrently (both writing one transcript, neither able to see the other), nothing needing
  permission could finish (see below), and a mis-heard word went straight to work — "make sure
  there is no sensitive data and **some** sensitive information", inverting half the instruction.
  Handing it over costs hands-free operation and fixes all three. Note the split in the
  implementation: the **clipboard gets the text verbatim** (quotes, backslashes, newlines all
  matter for pasting) while the **notification gets a sanitised one-liner**, because that string is
  interpolated into AppleScript where a stray quote breaks or alters the script. The `clip` state
  is backward-compatible — an older device falls through to a generic "VOICE" label — so the host
  half ships on its own.
  **There is no way to inject a prompt into a running interactive session**, which is why the
  fallback is headless. Checked, not assumed: the transcript's `queue-operation` records are an
  *effect* the app writes (enqueue then dequeue), not an input, and no queue file exists under
  `~/.claude`; `--resume`/`--continue` both start a new process against a session's history; and
  `~/.claude/ide/<port>.lock` does describe a live websocket with an auth token (the port is open),
  but it belongs to the VS Code integration, is an undocumented internal protocol, and delivers to
  whichever editor holds the lock rather than the session you aimed at.
- **The headless fallback (`dispatch`): `claude -p --resume <session_id>`.** Continues the
  conversation in that session's own `cwd`, detached (a dictated task can run for minutes and must
  not block the host's poller).
  Which session? **Context picks the target**: the device stamps `target=<id12>` into the stream
  header when the recording starts from a session's detail screen, and `-` otherwise. A capture with
  no target is transcribed, logged, and NOT dispatched — a voice memo. No extra UI, no mode to get
  stuck in.
- **The dispatch deliberately runs at the DEFAULT permission mode.** A dictated instruction still has
  to clear the normal permission prompts, so a misheard command cannot quietly run a tool. This was
  verified the hard way: "update CLAUDE.md" (heard as "update core code MD5") reached the session,
  Claude worked out the intent, prepared the edit, and **stopped to ask for write permission**.
  Raising this to `acceptEdits`/`bypassPermissions` removes that safeguard and is the user's call.
- **A headless `claude -p` run does NOT appear to fire `PermissionRequest`** — so the device cannot
  approve dictated work. Measured: the hook debug log for such a run shows
  `UserPromptSubmit → PostToolUse → Stop → SessionEnd` with no `PermissionRequest`, and the session
  record carried no `ask`. Consequence: a dictated task that needs permission REPORTS BACK instead of
  completing. Safe, but it means dictation is best used for read/analysis work ("what's failing in
  the tests?") unless you raise the permission mode.
- **Absolute paths are mandatory in the host's voice path.** The host runs under
  `open DeckhandBLE.app`, which does not inherit a shell PATH, so bare `claude`/`whisper-cli`/`node`
  are unfindable. `CLAUDE_BIN`/`WHISPER_BIN`/`WHISPER_MODEL` default to absolute paths, and the
  decoder is spawned with **`process.execPath`** — the node copy inside the bundle — not `"node"`.
- **Two touch-ordering traps, both of which broke the feature in practice:**
  - **The FAB's hit test must run BEFORE the detail/ask handler.** That handler treats any unclaimed
    tap as "close this page", so a tap on the button closed the detail screen instead of recording,
    and the hold gesture never armed. "Floats above everything" has to mean it is hit-tested first,
    not merely drawn last.
  - **`micWaitRelease()` before handing the screen back.** The tap that STOPS a recording is often
    still down when `handleTouch` resumes; it gets read as a fresh press and closed the page the
    instant you stopped dictating.
- **Two-way feedback: the voice result card, and the 32-bit trap that hid it.** A dictation used to
  vanish - you could not see WHAT was transcribed (and it matters: "update CLAUDE.md" was heard as
  "update core code MD5", then later as "update the cloud.md file") nor whether Claude acted. The
  host now keeps the last exchange (`lastVoice`) and publishes it to **both** surfaces: into the
  device payload (which raises a card showing `YOU SAID` and `CLAUDE`, dismissed by any tap) and into
  the heartbeat (the menu bar shows `🎤 "..."` with a `↳` reply line). This is the only Mac-side
  visibility there is - a headless `claude -p --resume` never appears in any Claude Code window.
  - **The card is keyed off a small `seq` counter, NOT the host's `Date.now()`.** That was a real bug
    with a silent failure: `long` on ESP32 is 32-bit (max 2,147,483,647) and a JS millisecond
    timestamp is ~1.79e12, so it overflowed and the "is this a new exchange?" comparison never fired.
    The card code was correct all along and simply never triggered. `at` is still sent for the Mac,
    which has no such limit.
  - Raised only for `sent`/`done`/`memo`/`error`, never the transient `heard` (transcript-only, a
    second before dispatch) - otherwise it flickers up for nothing. A dismissed card cannot be
    resurrected by the next 5s tick because `voiceSeqShown` is remembered.
  - The transcript renders in **Cozette on a panel**, the same treatment as code and commands,
    because it is verbatim quoted text and should not read as prose.
  - Text is capped host-side (200 chars transcript, 420 reply): the device's line buffer must hold a
    whole payload and asks already claim up to 1400 chars of it.
- **Session names come from the git repo ROOT, not the cwd.** The hook rewrites `cwd` on every event
  with Claude Code's *live* working directory, so `basename(cwd)` renamed a session mid-task the
  moment anything ran `cd` into a subdirectory - "core" became "host" while working. `projectName()`
  uses `git rev-parse --show-toplevel` instead, which is stable across any `cd` inside the repo and
  is what a person means by "the project"; outside a repo it falls back to the directory name. Cached
  per cwd, because it runs for every session on every 5s tick and the answer never changes. The
  `path` field deliberately still shows the LIVE cwd - that's useful for knowing where a session is
  actually working, so only the name is pinned.
- **`claude -p` waits on stdin unless you close it**, logging `no stdin data received in 3s` and
  stalling every dictation by three seconds. The dispatch passes
  `stdio: ["ignore", "pipe", "pipe"]`.
- **One-shot `MICREC` captures are transcribed too**, landing as memos (they carry no target). Only
  streams were, originally. This also gives a way to exercise the whole voice path - transcript,
  device card, menu bar - with a 4s capture instead of a 120s stream.
- **A plain session detail screen goes back via its HEADER ROW only, not "tap anywhere".** It used to
  close on any tap, which collided head-on with a recording's "tap anywhere to stop". The `< Back`
  label was already being drawn there, so honouring it merely makes the page behave the way it
  already looked. Taps elsewhere are inert. The FAB is visible on a plain detail screen (that is how
  you aim a dictation) but hidden whenever an **ask** is pending, so it can never overlap Allow/Deny.
- **The serial link will NOT go faster than 115200 on this CH340; raising it loses data silently.**
  Tried specifically to speed up audio. Percentage of a 64000-sample capture actually arriving:
  `115200 → 100%` · `230400 → 87%` · `460800 → 81-94%` · `921600 → garbage` (3% printable, and
  host→device commands stopped arriving too). Loss begins as soon as you exceed 115200, so it is not
  a rate you can tune around, and it is invisible without the completeness check above. The ROM
  bootloader and panic handler always print at **115200** regardless, so at any other rate a crash
  dump reads as garbage — its own debugging trap. The fix for throughput is flow control
  (chunk + ACK), not a bigger number.
- **The floating record button (FAB), and why it is NOT the BOOT key.** Recording is triggered by a
  round, **unfilled** button floating over the content area. Two earlier homes were both wrong:
  - **BOOT key (GPIO0) — abandoned, and it bricked the device twice.** GPIO0 is also the serial
    bootloader strap and is driven by the USB adapter's **DTR** line, so it goes LOW after every reset
    and whenever the host merely opens the port. A tap handler therefore fired recordings by itself
    on flashing, and a strap held low past `POWER_OFF_HOLD_MS` sent the device into **deep sleep
    during boot** — which presents as bricked firmware: no serial output at ANY baud, dark screen,
    while esptool still talks to the chip happily. If that ever recurs, suspect sleep before code.
    Only the deliberate long HOLD (power off) remains on GPIO0, guarded by a 3s arming window and a
    "must have been seen HIGH" flag.
  - **Fixed slot in the tab bar — abandoned** because it cost the three tabs 42px and could still sit
    over something.
  Interaction: **TAP** records, **HOLD 700ms then DRAG** moves it, **RELEASE** drops and persists to
  NVS (`fabx`/`faby`). Acting on RELEASE is what lets one control carry both gestures — a hold is
  already recognised by the time the finger lifts.
  Visual: a **grey 2px ring with a white centre dot** - the universal record symbol,
  unmistakable at 48px, and ~90% of the button's area stays see-through. Idle is neutral
  (`COLOR_LABEL` ring, `COLOR_VALUE` dot) *on purpose*: a control that floats over content should
  recede until you look for it, and earlier revisions in `COLOR_ACCENT` competed with the accent
  already used for active tabs, badges and pill borders. Orange is kept for the **pressed** state
  only, where it marks the action actually happening. Dragging switches to a white ring **plus arrow
  stubs**, so the mode differs by SHAPE as well as tone - colour is never the only carrier of
  meaning here. Earlier iterations that were rejected: a thin ring with a tiny centre speck (read as
  a reticle - mostly dead space) and a filled mic glyph (two ideas competing at 48px).
  Three things are non-obvious and load-bearing:
  - **"Transparent" is an unfilled ring, not alpha.** The panel is written directly with no
    framebuffer and no blending, so real translucency would mean reading pixels back (slow, and
    unreliable on this ILI9341 wiring). ~15% of the button's area is painted. The 1px `COLOR_BG`
    haloes either side of the ring are what make an outline control survive over arbitrary content —
    without them it vanishes wherever button and background share a tone.
  - **The drag happens on a CLEARED content area.** Not cosmetic: with no framebuffer to read back
    there is no way to restore arbitrary content from under a moving object, so dragging over live
    content smears a trail. Clearing gives a known background (erase = one `fillCircle`), and the
    real content is restored by `forceFullRepaint()` on drop.
  - Dragging on a **resistive** panel needs help — the same reason ask-detail text pages by taps
    instead of scrolling. A **70px spike reject** (one bad sample would fling the button somewhere the
    finger never was), a 2px deadband, and `lastNonIdleMillis` refreshed during the drag so a slow
    careful move doesn't look idle to the auto-sleep timer.
  Position is clamped to the **content area**, never the tab bar or footer: a movable control that
  can park on the tabs would block tab switching outright. It hides itself (`fabVisible()`) on the
  ask/answer screen, the reader, the crab, and while asleep — a floating button overlapping an
  Allow/Deny decision is a hazard, not a cosmetic issue.
- If this mic is ever replaced, an **INMP441** (I2S) is viable and needs no analog tuning:
  `SCK`→IO18, `WS`→IO19, `SD`→IO35. IO18/19/23 are the **microSD** bus and this firmware contains
  no SD code at all, so they're free as long as the card slot is unused.
- "Power off" (hold BOOT ~1s) is ESP32 deep sleep, not a real power cut: panel DISPOFF+SLPIN,
  backlight pin latched low via `gpio_hold_en` (GPIOs float in deep sleep — and setup() must
  `gpio_hold_dis` it again after wake, before re-attaching LEDC), wake via ext0 on IO36 (the
  XPT2046's PENIRQ, which works while the ESP32 sleeps because the 3.3V rail stays up). Wake is
  deliberately **touch, not the BOOT key**: GPIO0 held low across the wake reset straps the
  chip into the serial bootloader and it looks bricked until a manual reset. The manual power-off
  and the automatic battery-idle sleep share `enterDeepSleep()`.
- Automatic deep-sleep (`AUTO_SLEEP_IDLE_MS`, 20 min): fires only when **on battery** with no
  fresh active session for the interval; touch and any fresh session reset `lastNonIdleMillis`.
  "On battery" is `!(lastRxUSBMillis fresh within 60s) && batteryPresent()` — deliberately a
  **60s** USB-quiet window, not `batteryState()==DISCHARGING` (which flips on the 10s
  `usbLinkActive` threshold and briefly reads "battery" during a slow host tick, which once
  caused spurious sleeps). Debugging note: the SESSIONS feature captures each Bash command as a
  `PermissionRequest` ask detail, so any word you `grep` for that's also in your command shows up
  inside the host log's tick JSON — match device prints by the `^[device/usb] ` line prefix, not
  a bare substring, or you'll chase phantom events.
- The sessions list's row height is computed from the session count (tall rows for 1-3
  sessions, compact for 5-6); touch hit-testing in `handleTouch` uses the same `sessionRowH`
  global, so any layout change must keep those two in sync.
- **The session DETAIL screen is laid out by a running cursor, and its extra text all
  comes from the same transcript read.** It carries name, title, status pill (with
  `for 12m - 14:31` beside it), LAST PROMPT, PATH, and then MODEL/GIT BRANCH and
  STARTED/AGENT as **paired columns** rather than a four-row ladder — the pairing is what
  buys room for the new text without a taller card. Offsets are a `cy` cursor, not the
  hand-derived `cardY + 78 / +120 / +158` constants it used to have; those had to be
  re-derived by hand whenever a field moved, which is how the screen drifted sparse.
  Where the values come from: `lastPrompt` and the title from the **same 64KB tail** as
  the model, the start time from the transcript's **birthtime** (deliberately not a new
  hook field — that would need reinstalling into `~/.claude` before it did anything),
  last-active from the record the host already has. Times ride as **seconds since local
  midnight**, never an epoch — `long` here is 32-bit and a ms epoch overflows it, the same
  trap that silently broke the voice card — with **-1 meaning "not today"**, drawn as
  "earlier" instead of a time from another day masquerading as this one.
  Three things are load-bearing, and two of them are the same silent bug:
  - **A change-only cache shorter than the string it stores stops noticing changes.**
    `drawIfChanged` compares `cacheSize` bytes, so `detailDurCache[16]` holding a 22-char
    `"for 12m - 14:31"` never compared the trailing clock — the time would have frozen
    while the duration beside it kept ticking. Same for `detailSigCache[208]` against a
    signature that now runs to ~327 chars: edits past that point would never repaint.
    Now 28 and 352. **Any new field must have its cache checked against its padded
    length.**
  - **The detail signature must include `title` and `prompt` but NOT `actSec`.** The first
    two are drawn on the static card, so omitting them means a new prompt never repaints
    the screen you are reading. `actSec` changes on every event, and a full card repaint
    per tick is exactly the flicker the discipline exists to prevent — it reaches the
    screen through `renderDetailDuration`'s own per-second cache instead.
  - **Last-active appears ONCE, beside the pill.** It was briefly also a STARTED/LAST
    ACTIVE column pair, which both said the same thing twice and created a field that
    could only update by repainting the whole card. The column pairs with AGENT instead,
    and both of those never change for a session.
- **The session TITLE is a third row line, and it comes from the transcript, not a hook.**
  Claude Code writes `{"type":"ai-title","aiTitle":...}` records into the session
  transcript (and `custom-title` if you named the session yourself) — no hook event
  carries it. `transcriptInfo()` pulls the title and the model out of the **same 64KB tail
  read**, so this costs no extra I/O per session per tick; a `custom-title` outranks an
  `ai-title`, and the newest of each wins so a retitled session updates. Verified on real
  transcripts: all four projects on this machine resolve a title, including a **28MB**
  one, so the tail window is not the practical limit it looks like. If no record lands in
  that window the row simply falls back to the two-line layout.
  The row height cap went **72 → 90** to make space. That is arithmetic, not taste: with
  `avail = 264`, 1–2 sessions land on the cap and 3 comes out at 86, so all three clear
  `SESSION_TITLE_MIN_H` (85) while 4+ stay at 63/50/41 and keep the old layout. 85 is
  itself forced — the sub-line ends at `y+60` and the pill top is `y+rowH-22`, so a
  shorter row would draw the pill over the text.
  **The title MUST be in the row's repaint signature.** Leave it out and the row keeps
  showing a stale title forever, since nothing else about the row changed — the silent
  failure this change-only redraw discipline is prone to. The signature and
  `rowSigCache` grew 96 → 160 because a 40-char title no longer fits beside the rest.
  Codex rows carry no title (nothing in a rollout was verifiable as one) and collapse
  back to two lines. Cost: **+912 bytes of RAM, ~100 bytes of flash.**
- **A long project name SHRINKS one step rather than being cut, and the lane is measured
  rather than counted.** `drawSessionRow` computes the name's available width from what
  actually sits at the top of the row — the `CLAUDE`/`CODEX` tag on tall rows, the status
  pill (`textWidth(label) + 12`) on compact ones — because those labels differ in width
  (`WORKING` is two characters wider than `READY`). It then tries the big font and falls
  back to the small one **only if the name doesn't fit**, so a long name is shown whole; a
  shrunk name is re-centred in the 26px band the big one would have filled. `fitText()`
  trims with **three ASCII dots**, since Cozette6x13 is `0x20-0x7E` only and U+2026 would
  draw as a blank box. Three things worth knowing before touching it:
  - **There is no intermediate size.** `uiTextSize()` returns 2 or 1 and Cozette is a
    bitmap font, so the only options are 12px and 6px characters — "scale the font to
    fit" is not available, which is why this is a single step.
  - **The old fixed 11/12-character cap was both too small and too big.** Measured: compact
    rows had room for 18-20 characters and were showing 11, while a tall row's 12-character
    name ran to x=192 against a `CLAUDE` tag whose left edge is x=184 — **an 8px overlap**.
    Any hardcoded character count reintroduces one or the other.
  - Costs nothing in the redraw discipline: rows repaint wholesale when their
    `name|status|sub` signature changes, so a per-row font size needs no extra cache.
    Measured cost of the whole change: **+288 bytes of flash, zero RAM**.
  The host caps the name at **22** to match what the small font can draw on a tall row
  (`SessionInfo.name` is `char[24]`); sending more would only be trimmed on arrival. Status urgency is encoded as pill
  fill (solid = asking, outline = waiting, boxless dim text = working), consistent with the
  color-never-alone rule.
- The OAuth usage endpoint rate-limits bursty callers (HTTP 429, observed after several rapid
  host restarts). The poller backs off 15 minutes on 429 (persisted to `/tmp/deckhand-oauth-backoff.json`
  across restarts, honoring Retry-After) — don't "fix" apparent staleness by polling faster.
  **Two** persisted guards keep restarts from bursting the limiter: the back-off above, and a
  last-ATTEMPT timestamp (`/tmp/deckhand-oauth-attempt.json`, written just before every network
  hit — success or failure) that `pollOauthUsage` checks to enforce a minimum `OAUTH_POLL_INTERVAL_MS`
  (5 min) between hits regardless of how many times the host restarts. The back-off alone wasn't
  enough: between a back-off expiring and the next 429, each dev reflash's startup poll hit the
  endpoint immediately (startup used to schedule off the last *success* time), which is what
  compounded into hours-long penalties. Startup now just calls `setTimeout(pollOauthUsage, 0)`
  and lets those two guards self-throttle.
- **OAuth token refresh (the host renews its own access token).** The Keychain access token lives
  ~8h; when it expires and no Claude Code surface is running to renew it (the app-only + always-on
  case), the host was left sending an expired token and getting HTTP **401** — distinct from the
  429 rate-limit, and not fixed by the guards above. `getFreshAccessToken()` now checks
  `claudeAiOauth.expiresAt` and, if within `OAUTH_REFRESH_MARGIN_MS` (5 min) of expiry, calls
  `refreshOauthToken()`: POST `grant_type=refresh_token` to `console.anthropic.com/v1/oauth/token`
  with the same public `OAUTH_CLIENT_ID` Claude Code uses, then writes the **rotated** tokens
  (access + the new refresh token + both expiries) back into the *same* keychain item in place
  (`security add-generic-password -U -a <acct> -s "Claude Code-credentials" -w <json>`), preserving
  every other field. A `pollOauthUsage` 401 on a not-just-refreshed token triggers one reactive
  refresh+retry (never a loop). This **reverses the old "never mutate the credential" rule** —
  deliberately, because it's the only way the app-only case stays live — but the safeguards are
  load-bearing: only ever exchange a **still-valid** refresh token (bail with a clear
  "sign in again" error if the refresh token is expired, so we don't hammer the token endpoint or
  imply a refresh can fix a real logout), and the rotated refresh token MUST be persisted or Claude
  Code's next refresh fails with `invalid_grant`. Verified interoperable (dry-run refresh → 200,
  persisted, usage endpoint then 200; and the live path via a force-expired token → auto-refresh).
  The host also sends `quotaAgeSec` so the USAGE cards can flag stale quota ("stale 3h" in the
  alert color) — the footer's freshness only vouches for the transport, not the data. When
  `quotaAgeSec > 900` (15 min) the big hero % is also **dimmed** to `COLOR_LABEL` (via
  `renderCard`), so a frozen value — e.g. a 5-hour % stuck at "0%" while the OAuth poller is in
  a long 429 back-off — doesn't masquerade as a live reading. `renderUsageTab` busts the
  `pctNCache` on each stale-flag flip, since `drawBigNumber` only repaints on a text change and
  a stale % often keeps the same digits.
- The needs-input beep is capped at 3 per asking-event (`beepsLeft` budget carried across
  polls). Sessions are matched across polls **by id, never by name** — two sessions on the
  same project share a name, and name-matching once made an asking session look newly-asking
  every poll (endless beeping).
- The device line buffers (`feedChar`'s 16000-char guard, the 16384-byte BLE stream buffer) are
  sized for payloads carrying `ask` objects; shrinking them silently drops whole updates. They
  were bumped from 8000/8192 when the ask caps grew (title 34, detail 1400, options 4×32,
  `askDetail[1424]`/`askTitle[36]`/`askOpts[4][34]`) so up to 6 simultaneous asks with full
  1400-char details can't overflow one JSON line. ArduinoJson v7's `JsonDocument` is elastic, so
  the parse side has no fixed capacity - the line guard and RAM (`SessionInfo`×6 plus a
  `prevSessions`×6 diff copy) are the real ceilings.
- The ask/answer screen: tapping an asking session's row opens option buttons wired to
  `sendAnswerToHost()` (which transmits on USB **and** BLE TX notify, in ≤20-byte chunks).
  Long detail text pages by tapping the text block — deliberate: drag-scrolling flickers and
  misfires on this resistive panel, discrete pages don't.
- **Code-friendly detail rendering.** The detail can be a code block, so `\n` is preserved
  end-to-end: the hook's `cleanMultiline()` (in `deckhand-session-hook.mjs`, used for the
  `detail` field only — `title`/`options` still use single-line `clean()`) keeps newlines while
  stripping tabs→spaces, ``` fences, and other control bytes; the device's ask-parse sanitize
  loop blanks control bytes **except `\n`**; and `wrapLineLen`/`countWrappedLines`/
  `drawWrappedText` treat `\n` as a hard line break. `detailLooksLikeCode(kind, detail)` (true
  for any `perm` prompt, or any detail containing a `\n`) drives the *style* in both
  `drawAskDetail` and `drawReader`: the **Cozette** bitmap font on a `COLOR_CARD` panel for
  code, the larger proportional font 2 for plain one-line prose. `isPerm`/`isPlan` still pick
  the badge label and button colors — only the text styling moved to `isCode`.
- **Cozette code font.** Code blocks render in Cozette 6x13 (`Cozette6x13.h`), an Adafruit-GFX
  bitmap font, *not* a numbered GLCD font — a hand-hinted bitmap font stays crisp at this
  panel's low DPI where a downscaled/anti-aliased vector font goes fuzzy. It's selected through
  the `FONT_CODE` sentinel (200, not a real TFT_eSPI font number): `applyContentFont()` maps it
  to `tft.setFreeFont(&Cozette6x13)` and any real number to `setTextFont()` (which also clears
  the GFX font, so the two never leak). Only `countWrappedLines`/`drawWrappedText` — i.e. the
  ask detail and full-screen reader — ever pass `FONT_CODE`; the per-second footer/USAGE fields
  stay on GLCD, so the flicker-free redraw discipline is untouched. TFT_eSPI's free-font path
  only engages when the active font is 1 **and** `gfxFont` is set (which `setFreeFont` does), and
  with `TL_DATUM` it adds the ascent so the text top lands at the given `y`. The header is
  regenerated from the upstream BDF by `firmware/deckhand_display/bdf2gfx.py` (see its docstring);
  the 668KB BDF itself is deliberately **not** committed — the ~1KB header is self-contained.
- **Screen flip (180°) for charging.** SETTINGS › DISPLAY & SOUND has two half-width toggles
  sharing the bottom row — SOUND and NORMAL/FLIPPED — because a full-width row for each doesn't
  fit (only 32px remain under it). Flipping swaps `tft.setRotation()` between `SCREEN_ROTATION`
  and `2`; both are portrait, so no layout constant moves. The catch is touch: the panel is glued
  to the glass and does **not** rotate with the image, so `getTouchPoint()` mirrors its mapped
  result (`w-1-x`, `h-1-y`) when flipped — that keeps ONE calibration valid for both orientations
  instead of forcing a recalibration on every flip. Consequently `runCalibration()` **forces the
  unflipped rotation** for its duration (crosshairs would otherwise be drawn mirrored and the
  saved `calData` would come out inverted), and every call site restores the user's choice with
  `applyScreenRotation()` afterwards. Persisted as NVS `flip`, loaded in `setup()` right after
  `loadOrRunCalibration()` (which is where `prefs.begin` happens) — so it also survives the
  deep-sleep/wake cycle, since wake re-runs `setup()`.
- **"Working" spinner — the Claude spark (the one timer-driven redraw).** A working session cycles
  8 frames of the Claude spark (`drawWorkingSpinner`), advanced by `tickWorkingSpinner()` from
  `loop()` every `ANIM_INTERVAL_MS` (120ms, ~1s per cycle). The art lives in `ClaudeSpark.h`,
  **generated** by `firmware/deckhand_display/spark2c.py`; the source frames
  (`SparkFrames.swift`) are **not** kept in the repo, so `ClaudeSpark.h` IS the art now — to change
  it, supply the frames again and run `python3 spark2c.py <frames> > ClaudeSpark.h` (the script
  takes a .swift with quoted base64, or one base64 PNG per line). The source PNGs are 60x60 RGBA that are
  pure black with 4 alpha levels, i.e. **masks**: the converter keeps only alpha, box-filters to
  32x32 and quantises to 2 bits, so the firmware tints them with the status colour at draw time
  (one copy serves any colour, and no PNG decoder is needed on-device). Cost: **2KB flash**
  (8x32x32x2bits) and only a **64-byte** line buffer — it blits one ROW at a time rather than
  composing a whole 2KB frame. `fillRect` is used rather than `pushImage` for the same byte-order reason as the crab (see the
  easter-egg note) — it takes an ordinary colour, so no `swapBytes` juggling. Further compression isn't worth it, measured: RLE saves only 8%
  (the art is too detailed for long runs), zlib 45% but needs a runtime inflate, and 1bpp halves
  it at the cost of the anti-aliased edges.
  **32x32 is a floor, not a preference**: at the old dot size (14-18px) the thin spokes turn to
  mush, and 24px is marginal — measured, not guessed. It still fits the row's indicator slot
  (spans x 12..44 with the name starting at x=48) and the tightest 38px row (y+3..y+35), so no
  text moved. Each frame is composed into `sparkBuf` and pushed as ONE `pushImage` rather than
  1024 `drawPixel` calls, and because it repaints the whole box there's no separate clear.
  This is the sole place that repaints on a timer instead of on a value change; it stays within
  the flicker-free discipline because it's one small blit, never a cleared region. Gated to the
  sessions list actually being visible (`!isAsleep && !octoActive && !showingDetail &&
  !readerActive && currentTab == TAB_SESSIONS`), and it deliberately does **not** touch
  `lastNonIdleMillis` — an animation must never look like activity to the auto-sleep timer. The
  spark is a distinct radiating shape, so working is still told apart from asking (filled square)
  and waiting (hollow ring) by **shape alone**: motion is an extra cue, never the only one.
- **Codex's "working" animation — the Codex mark, rotating (`CodexMark.h`).** A Codex
  session that is working gets its own animation next to the Claude spark, generated by
  `firmware/deckhand_display/codex2c.py` from the Codex mark SVG. Same format as the
  spark (8 frames, 32x32, **2 bits of alpha**, tinted with the status colour at draw
  time), so `drawAgentSpinner()` is one blitter over two tables and the only difference
  is which art it reads — the status colour still means status, and the **shape** is
  what says which tool. Costs another 2KB of flash.
  Three things about generating it are load-bearing:
  - **The glyphs are HOLES, not shapes.** The mark is one path with three contours and
    `fill-rule="evenodd"`: an 8-lobed blob, a chevron, and an underscore, where the
    latter two punch through. Split into separate paths they stop being holes, so the
    script draws the blob white and then paints the two glyphs **black** over a black
    background — which reproduces the holes exactly and makes luminance the mask.
  - **Only the blob rotates.** Rotating the glyphs too would spin the `>_` prompt
    upside down; leaving them upright keeps the mark readable in every frame while the
    lobes carry the motion. 8 frames x 45 degrees = one full turn, so the loop is
    seamless. 45 is not a no-op despite the 8 lobes: measured at **19.5/255** mean
    absolute luminance difference from the original, because the lobes are organic
    rather than exactly repeated. (If they ever were exact, 45 would emit 8 identical
    frames and the step would have to become 45/8.)
  - **Rasterising uses headless Google Chrome**, because this toolchain has no SVG
    rasteriser at all — no `rsvg-convert`, `inkscape`, `cairosvg`, or even Pillow. The
    script also contains its own ~40-line PNG reader (zlib inflate + unfilter) for the
    same reason. Frames render at 128px and are box-filtered 4x4 down to 32, which is
    where the anti-aliasing comes from.
  - **SVG numbers can run together with no separator** — `M8.086.457` is *two* numbers,
    and a naive `[\d.]+` swallows both and then fails to parse. The contour splitter
    scans numbers properly, and converts each later contour's relative `m` into an
    absolute `M` (a `z` returns to the contour's own start, so contour 2 opens relative
    to where contour 1 began, not to the origin).
- Easter egg: 5 taps on the footer within 4s summons **Clawd** — the real crab-walk sprite
  animation. 20 frames of 51x36 in `ClawdCrab.h`, **generated** by
  `firmware/deckhand_display/crab2c.py`; the source frames (`CrabFrames.swift`)
  are **not** kept in the repo, so `ClawdCrab.h` IS the art now — to change it, supply the frames
  again and run `python3 crab2c.py <frames> > ClawdCrab.h`. PNG alpha is composited
  against `COLOR_BG` **at build time**, then the frames are **RLE'd as (palette index, run length)
  pairs** with runs never crossing a row. That RLE *is* the draw format: `drawCrab` turns each run
  straight into one `fillRect`, so nothing is decompressed into RAM, the art is 21KB instead of
  37KB (RGB565 raw would be 73KB), and a frame costs ~527 draw calls instead of 1836 pixels.
  Palette entry 0 is `COLOR_BG` and is skipped, since the target was just cleared. Drawn into a
  `TFT_eSprite` (240x108, ~51KB, returned on exit) pushed whole — the one sanctioned full-region
  redraw, since sprites can't flicker — with a direct-draw fallback, and `octoActive` gates
  `handleLine`'s draw path while data keeps flowing.
  **Two TFT_eSPI traps caused real bugs here, both silent — use `fillRect`, not `pushImage`, when
  drawing generated art:** (1) `pushImage` takes a raw buffer whose byte order depends on the
  target's `swapBytes` flag, and **a sprite stores its pixels byte-SWAPPED internally**
  (`TFT_eSprite::drawPixel` does `color>>8 | color<<8`; `pushSprite` then pushes with
  `swapBytes=false`) — getting this wrong is what made the colours come out wrong. `fillRect`
  takes an ordinary `0xF800`-style colour and handles the internal representation itself, so it is
  correct on both a sprite and the screen with no flag juggling. (2) **`pushImage` is NOT virtual**
  — only `drawPixel`/`drawChar`/`readPixel`/`setWindow`/`pushColor` are — so through a `TFT_eSPI&`
  reference it binds to the SCREEN version and bypasses the sprite entirely; that's why the crab
  was invisible at first. `drawCrab` is **templated on the target type** so the right overload
  resolves at compile time. The old procedural art only worked because `fillRect`/`drawCircle`
  route through the virtual `drawPixel`.
- TFT_eSPI's pin/driver config lives in the *library's* `User_Setup.h`
  (`~/Documents/Arduino/libraries/TFT_eSPI/User_Setup.h`), not in this repo, since that's how
  TFT_eSPI is configured. If TFT_eSPI is ever reinstalled, that file needs to be recreated with
  this board's pin mapping (documented in the `.ino`'s header comment).
- Colors deliberately avoid a green/yellow/red scheme (the `COLOR_GOOD`/`WARN`/`BAD` constants
  use a blue/orange/reddish-purple palette instead) because a green/yellow/red scheme collapses
  under the most common colour-vision deficiency, and
  status is also conveyed by shape (`drawStatusDot`: filled circle / filled square / hollow
  ring), never by color alone.
- If Bluetooth permission ever gets stuck (the process crashes again after previously working,
  usually after iterating on `DeckhandBLE.app`'s signature), reset the cached TCC decision with
  `tccutil reset BluetoothAlways com.deckhand.ble-host` before assuming the code is broken.
- `DeckhandBLE.app` embeds a literal copy of `node` + `libnode.147.dylib`, so it's tied to whatever
  Homebrew node version was current when it was built. After `brew upgrade node`, re-copy both
  files into `host/DeckhandBLE.app/Contents/MacOS/` and re-run
  `codesign --force --deep --sign - host/DeckhandBLE.app`. The bundled files are mode 444, so
  `rm` them first — `cp` onto a read-only destination fails. This has actually bitten: node moved to
  26.7.0 (needing `libada.4.dylib`) while the bundle still referenced `libada.3.dylib`, and the app
  died at launch with a DYLD "Library missing" crash and no log file. The re-signed bundle keeps its
  Bluetooth permission (identifier `com.deckhand.ble-host` is unchanged), so no `tccutil` reset is
  needed for a straight rebuild:

  ```
  cd host && NODE=$(readlink -f $(which node))
  rm -f DeckhandBLE.app/Contents/MacOS/{Deckhand,libnode.147.dylib}
  cp "$NODE" DeckhandBLE.app/Contents/MacOS/Deckhand
  cp "$(dirname $(dirname $NODE))/lib/libnode.147.dylib" DeckhandBLE.app/Contents/MacOS/
  codesign --force --deep --sign - DeckhandBLE.app
  ```
