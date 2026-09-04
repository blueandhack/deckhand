# How it works, and why an app bundle

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## How it works

```
Claude Code hooks (any surface: terminal, desktop app, VS Code)
    |
    `-- hooks: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest,
        PostToolUse, PostToolUseFailure, Notification, Stop, SessionEnd
            -> ~/.claude/deckhand-session-hook.mjs -> ~/.claude/deckhand-sessions/<id>.json
               (for answerable prompts: publishes the question, then waits up
                to 90s for ~/.claude/deckhand-answers/<id>.json before falling
                back to the normal dialog)

host/index.mjs (device tick every 5s)
    - Anthropic OAuth usage endpoint (every 5 min)  -> real 5h/7d/Fable quota %
      (falls back to ~/.claude/deckhand-rate-limits.json, written by the
      statusLine hook, if the endpoint is unreachable)
    - ccusage blocks --active / weekly              -> token counts
    - ~/.claude/deckhand-sessions/*.json                -> per-project status + asks
    - writes /tmp/deckhand-<uid>/host-alive heartbeat (gates the hook's remote wait)
    -> JSON line over USB serial AND/OR BLE - both independent, always
       attempted; sends to whichever are currently connected
    <- "ANSWER <id> <prompt> <option>" lines from the device (USB rx or BLE
       notifications) -> ~/.claude/deckhand-answers/<id>.json for the hook

deckhand_display.ino (ESP32 or ESP32-S3 - one firmware, two boards)
    - parses each JSON line, redraws only the fields that changed
    - beeps (max 3x) when a session newly needs input          [board 1 only]
    - touchscreen for tabs/detail/answering; BOOT key for power off
    - board 2 draws into a PSRAM framebuffer and flushes dirty rectangles
```

**Quota numbers** come primarily from the same endpoint Claude Code's own
`/usage` screen uses, authenticated with the OAuth token Claude Code stores in
the macOS Keychain. This works with zero Claude sessions open and reflects
account-wide usage from every surface. The statusLine cache is kept as a
fallback since the endpoint is undocumented.

The host **does refresh that token** when it's expired or near expiry, writing
the rotated tokens back into the same Keychain item in place. That's necessary
rather than optional: the access token lives ~8h, and an always-on host can't
rely on a Claude Code surface being open to renew it — without this it just
sat there getting HTTP 401s. It only ever exchanges a still-valid refresh
token, and persists the rotated one (skipping that would break Claude Code's
own next refresh with `invalid_grant`). If the refresh is genuinely rejected
it says so and asks you to sign in again, rather than hammering the endpoint.

**Session status** works in every surface. The needs-input state is driven
by the `PermissionRequest` hook (fires when an allow/deny dialog appears)
plus `PreToolUse` for questions/plan approvals; the desktop app never
fires the `Notification` hook, which is why the older Notification-based
detection missed desktop permission prompts entirely.

## Setup

`./install.sh` does steps 3–5 for you; they're spelled out here for
reference and for the firmware, which is always hands-on.

1. **Prepare TFT_eSPI** — **board 1 only**; board 2 does not use TFT_eSPI at all. Copy this
   board's pin config into the library:
   ```
   cp firmware/tft_setup/User_Setup.h "$(arduino-cli config get directories.user)/libraries/TFT_eSPI/User_Setup.h"
   ```
   You also need the `esp32:esp32` core and the `TFT_eSPI`, `ArduinoJson`,
   and `XPT2046_Touchscreen` libraries (`Preferences` / `BLEDevice` /
   `BLEServer` / `BLEUtils` / `BLE2902` ship with the esp32 core). For **board 2** you need the
   same core plus `ArduinoJson` and **`ESP32_Display_Panel`** — and no `User_Setup.h`. BLE needs no
   extra library either way: the esp32 core's own `BLEDevice`/`BLEServer` headers are backed by
   Bluedroid on board 1 and by NimBLE on the S3, which the firmware handles.
2. **Flash the firmware** (from this directory):
   ```
   ./flash.sh                 # compile + upload BOARD 1 (the default)
   ./flash.sh --board 2       # compile + upload board 2
   ./flash.sh --no-compile    # upload the last build, skipping the ~3min compile
   ```
   One command on purpose. **Which board you are building for is decided entirely by that flag** —
   there is no switch to flip in the source, because a build that looks right and is wrong when
   someone forgets to flip it is worse than a longer command. It resolves the serial port (it renumbers between
   plug-ins), frees it, uploads, and puts the host back afterwards — including
   when the upload fails or you Ctrl-C, because leaving your display dead
   because a flash went wrong would be worse than the problem it solves. If the
   host is supervised (step 6) it stops the service properly rather than killing
   the process, which matters: `KeepAlive` re-grabs the port within a second of
   the process dying, so a bare `arduino-cli upload` fails on a busy port and
   looks like a hardware fault.
   `PartitionScheme=huge_app` gives the app partition 3MB instead of the
   default 1.2MB — needed because the Bluetooth stack alone is ~700KB+;
   this project doesn't use OTA or SPIFFS, so the tradeoff is free. On
   **first boot** the screen prompts for a one-time touch calibration —
   touch the five crosshairs (four corners and the centre); it's saved to
   flash and survives reflashing. **Board 2 skips that step**: its touch panel is capacitive and
   factory-aligned, so there is nothing to calibrate.

   **If board 2 goes mute — resets, enumerates, and emits nothing at any baud while `esptool`
   cannot sync — power-cycle it before suspecting the firmware.** Unplug it, or plug/unplug a
   battery, or hold **BOOT** while tapping **RESET** to force download mode. This has happened, and
   nothing software-side got it back: not four upload attempts, not all three `--before` modes on
   both `cu.` and `tty.`, not esptool's own DTR/RTS sequence by hand. **Enumeration proves
   nothing** on this board — it can appear as a healthy "USB JTAG/serial debug unit" and still be
   unreachable.
3. **Register the Claude Code hooks** — these feed per-session status (and
   the statusLine quota fallback). Without them the SESSIONS tab stays empty
   and remote answering is off.
   ```
   cp claude-hooks/deckhand-*.mjs ~/.claude/
   node claude-hooks/install-hooks.mjs   # backs up + merges into settings.json
   ```
   Then **restart Claude Code** so it reloads `settings.json`.
4. **Install host dependencies**: `cd host && npm install`.
5. **Build and run the host — via `DeckhandBLE.app`, not plain `node`, if you
   want Bluetooth**:
   ```
   host/build-app.sh            # builds the bundle from your node (one-time)
   open host/DeckhandBLE.app --args "$(pwd)/host/index.mjs"
   ```
   Launch it by hand **this once**: only a real app launch can raise the
   Bluetooth permission prompt. After you have clicked Allow, step 6 takes over.
   The bundle is required, not optional, for BLE — see
   [Why an app bundle?](#why-an-app-bundle) below. Click **Allow** the first
   time macOS asks for Bluetooth, and **Always Allow** if the Keychain asks
   about reading the Claude Code credential (that's the quota polling).
   No manual Bluetooth pairing is needed — the host scans for a device named
   "Deckhand" and connects directly.

   **Launch via the bundle even if you only want USB.** Plain
   `node host/index.mjs` does *not* work on current macOS: noble's
   CoreBluetooth init gets the process `SIGABRT`'d (exit 134) a second or two
   after startup, with the crash report blaming `TCC` — so there is no
   bare-node fallback, and USB doesn't survive it either. For a genuinely
   USB-only one-off job, write a throwaway script that imports **only**
   `serialport` and never touches noble; that survives, because nothing in it
   reaches CoreBluetooth.
6. **Let it run itself** — recommended, and what `install.sh` sets up for you:
   ```
   ./host/deckhand-service.sh install    # launchd, restarts on death, starts at login
   ./host/deckhand-service.sh status     # running? how often has it restarted?
   ```
   See [Keeping it running](#keeping-it-running).

### Keeping it running

The host is supervised by a launchd agent, because the failure it guards against
is one you cannot see. It has never crashed — it *hangs*, and when it does, its
serial reader keeps working, so device→Mac traffic still flows and everything
looks healthy while the display quietly goes stale. One stuck Bluetooth write
left it dead for five hours that way. With supervision, a death costs about a
second.

Two layers sit under that. Inside the host, a watchdog restarts the poll loop if
no tick completes for 30 seconds — because an `await` that never settles (rather
than failing) stops the loop permanently, and no amount of error handling catches
a hang. And every child process it spawns is bounded by a timeout, so a wedged
`ccusage` or a locked Keychain can't be the thing that stops it.

**Whether any of that is earning its keep is a question you can answer**, which
matters, because a safety net you can't see working is easy to trust wrongly.
Every start appends a line to `~/.claude/deckhand-restarts.log`, summarised by:

```
./host/deckhand-service.sh status
  starts total: 4    in the last 7 days: 1
  longest run: 41.2h    shortest: 12m
  last: … start #4 | previous run 41.2h, watchdog fires 0, ended: SIGTERM
```

Read it after a week. **"0 restarts, longest run 7d" means the net is unproven
*and unneeded*** — a perfectly good answer. A pile of restarts names what keeps
failing, which is a cause worth fixing rather than a net worth leaning on. The
column that matters is *last tick*, not duration: a run that lasted 5h whose last
tick was 4h before it ended didn't die, it **hung**, and those are marked
`STALLED`.

Runtime state lives in `/tmp/deckhand-<uid>/` — the log, the heartbeat, and the
quota throttle files — one directory per user, mode `0700`. That's per-user
because it has to be: on a shared Mac the second user's hook would otherwise read
the *first* user's heartbeat, decide a display was connected, and stall every
permission prompt for 90 seconds waiting for a device that isn't theirs.

To stop it, or to take the port back for something else:

```
./host/deckhand-service.sh stop     # and it stays stopped
./host/deckhand-service.sh start
./host/deckhand-service.sh uninstall
```

### Speech-to-text (only if you fitted the microphone)

```
./host/install-voice.sh
```

Idempotent, and it resumes a part-downloaded model rather than starting again. It
installs whisper.cpp and fetches the model — **two separate prerequisites**, which is
the whole reason this is a script. Brew deliberately ships no model, so installing
only the binary swaps `whisper-cli: ENOENT` for a nearly identical
`failed to load model`, and that reads like the install not having worked.

`install.sh` checks for both and tells you if they are missing; the host also says so
at startup (`Voice: DICTATION DISABLED - ...`) rather than accepting a recording,
spending the transfer, and only then failing. If you would rather do it by hand:

```
brew install whisper-cpp
mkdir -p ~/.cache/whisper.cpp && cd ~/.cache/whisper.cpp
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```
 Use
`large-v3-turbo-q5_0` (547MB) rather than `base.en` (141MB) — benchmarked on real
captures from this microphone, `base.en` turned "Update CLAUDE.md file" into
"update, CLAUDE and D5" and invented proper nouns, while turbo got it right and
still ran at ~40x realtime. Override with `WHISPER_MODEL` / `WHISPER_PROMPT`.

## Why an app bundle?

On macOS, a bare `node` process is **killed outright** — no permission
prompt, just an instant crash — the moment it touches Bluetooth, because it
has no `Info.plist` declaring `NSBluetoothAlwaysUsageDescription`.
`DeckhandBLE.app` is a minimal wrapper whose executable *is* a copy of your
`node` (plus any `libnode.*.dylib` it links), with an `Info.plist` that
declares the Bluetooth usage string — so macOS shows a normal permission
dialog instead of crashing. `host/build-app.sh` assembles it from your own
node, which is why the built bundle isn't committed to git (it's ~200MB and
machine-specific).

**Does the signature expire? Do I need to re-sign every 7 days?** No. The
bundle is **ad-hoc signed** (`codesign --sign -`), and ad-hoc signatures do
**not** expire — there is no clock on them. (The 7-day expiry you may be
thinking of applies to *free Apple Developer provisioning profiles* for
sideloaded **iOS** apps — a completely different mechanism that doesn't apply
here.) You only re-run `build-app.sh` when the bundle's contents actually
change: after `brew upgrade node` (to refresh the embedded copy), or if you
edit the plist. Nothing needs doing on a schedule.

Two things *do* invalidate a bundle and need a rebuild/re-sign, for
completeness: editing any file *inside* `DeckhandBLE.app` by hand (breaks the
seal), and — if you download the repo as a zip rather than `git clone` — the
macOS quarantine flag, cleared with
`xattr -dr com.apple.quarantine host/DeckhandBLE.app`.
