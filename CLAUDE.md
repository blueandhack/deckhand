# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

If you only need USB, plain `node index.mjs` still works fine — the BLE half fails silently and
USB is unaffected, since the two transports are fully independent (see Architecture).

Trigger on-device actions without reflashing, by writing to a file the running host script
watches and forwards over whichever transport(s) are already connected:

```
echo "RECAL" > ~/.claude/deckhand-device-command   # force touch recalibration
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
  ("Claude Code-credentials") — read-only, never refreshed/mutated from here, falling back to
  the statusLine cache on any failure (it rate-limits bursts with HTTP 429; back off, don't
  hammer).
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
- **Remote answering** (the device as a prompt remote) lives in the same hook. For answerable
  prompts (`PermissionRequest`, `PreToolUse` on `AskUserQuestion`/`ExitPlanMode`) the hook
  publishes an `ask` object (pid, title, ≤600-char control-char-flattened detail, ≤4 option labels) in the session
  file, then **blocks up to 90s** (settings.json hook `timeout` is 100s to match) polling `~/.claude/deckhand-answers/<session_id>.json`. A device
  tap produces that file (device → `ANSWER <id12> <pid> <idx> <hmac>` line → host verifies +
  writes it); the hook
  then emits the decision JSON for the right event dialect: `PermissionRequest` decision
  allow/deny, `ExitPlanMode` PreToolUse allow/deny, and `AskUserQuestion` a PreToolUse deny
  whose reason carries the chosen option to Claude (there's no native remote-answer channel for
  questions). On timeout it strips the `ask` and exits silently — stock dialog behavior.
  Two hard rules: the hook waits **only** when `/tmp/deckhand-host-alive` (host heartbeat, written
  every tick) is fresh and says `connected` — otherwise every prompt would stall 90s for
  nothing — and it must never write anything to stdout **except** a genuine `emitDecision()`,
  because any stray JSON on a `PermissionRequest` hook's stdout can auto-allow/deny the dialog.
- **Remote-answer authentication (A + B), so only the paired Mac can decide.** (A) The device
  advertises a unique name `Deckhand-XXXX` (from its eFuse MAC) and the host, having learned that
  exact name over USB (`HELLO <name>`), pins BLE to it — no cross-connecting to another unit in
  the room. Because the longer name plus the 128-bit service UUID overflow the 31-byte BLE
  advertisement, the firmware **does not advertise the service UUID** (the host matches by name
  anyway). (B) Host and device share a 128-bit secret in `~/.claude/deckhand-secret` (mode 600,
  host-generated, secure by default), pushed to the device **only over USB** via `PROVISION`
  (stored in NVS; BLE `PROVISION` is ignored — the whole point). Each forwarded `ask` carries a
  per-prompt `nonce`; the device returns `ANSWER … <hmac>` where hmac =
  HMAC-SHA256(secret, `nonce:pid:idx`)[:16] — ESP32 `mbedtls_md_hmac` on one side, Node
  `crypto.createHmac` on the other, **verified interoperable**. The host rejects answers with a
  bad/missing MAC and consumes the nonce on success (single-use, no replay). This protects the
  *decision*, not the confidentiality of the (still-unencrypted) BLE data — deliberate, since
  macOS + noble handle BLE bonding poorly.

**`host/index.mjs`** polls every `POLL_INTERVAL_MS` (5000ms) for: `ccusage blocks --active`
and `ccusage weekly` (token counts), the rate-limit cache file, and the sessions directory
(pruning any session file older than `SESSION_STALE_MS`, since a closed terminal may never
fire `SessionEnd`). It assembles one JSON object and writes it to USB (if `usbPort` is set) and
BLE (if `bleCharacteristic` is set) independently every tick, and refreshes the
`/tmp/deckhand-host-alive` heartbeat that gates the hook's remote-answer wait. The **device→host
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
(USAGE, SESSIONS, SETUP) plus a persistent footer (clock | battery pill | "Xs ago" freshness,
three fixed-width zones that cannot grow into each other). The one rule that
matters everywhere in this file: **every field is redrawn only when its value changes**, using
fixed-width padded strings compared against a per-field cache, never a
clear-then-redraw of a large area. This exists because the very first version redrew the
entire screen every second and visibly flickered — the discipline was added specifically to
fix that, and any new UI element needs to follow the same pattern (see `drawIfChanged`,
`drawBar`, `drawCardBorder` for the established helpers) or it will reintroduce flicker.

The **SETUP** tab shows Bluetooth/USB connection status from the device's own perspective
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
- Touch calibration data must be stored as a real array (`calData[4]`), not four separate
  global variables read/written as a raw byte blob — separate globals aren't guaranteed
  contiguous in memory, and that exact mistake previously corrupted calibration silently. The
  Preferences keys are versioned (`cal3`/`calValid3`) specifically so a firmware change that
  fixes calibration logic also forces a fresh calibration run, rather than reloading
  now-incompatible old data.
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
  global, so any layout change must keep those two in sync. Status urgency is encoded as pill
  fill (solid = asking, outline = waiting, boxless dim text = working), consistent with the
  color-never-alone rule.
- The OAuth usage endpoint rate-limits bursty callers (HTTP 429, observed after several rapid
  host restarts). The poller backs off 15 minutes on 429 (persisted to /tmp across restarts,
  honoring Retry-After) — don't "fix" apparent staleness by polling faster. The Keychain token
  read (`security find-generic-password -s "Claude Code-credentials" -w`) is read-only; never
  refresh or rewrite those credentials from here, or Claude Code itself may get logged out.
  The host also sends `quotaAgeSec` so the USAGE cards can flag stale quota ("stale 3h" in the
  alert color) — the footer's freshness only vouches for the transport, not the data.
- The needs-input beep is capped at 3 per asking-event (`beepsLeft` budget carried across
  polls). Sessions are matched across polls **by id, never by name** — two sessions on the
  same project share a name, and name-matching once made an asking session look newly-asking
  every poll (endless beeping).
- The device line buffers (`feedChar`'s 4800-char guard, the 4096-byte BLE stream buffer) are
  sized for payloads carrying `ask` objects; shrinking them silently drops whole updates.
- The ask/answer screen: tapping an asking session's row opens option buttons wired to
  `sendAnswerToHost()` (which transmits on USB **and** BLE TX notify, in ≤20-byte chunks).
  Long detail text pages by tapping the text block — deliberate: drag-scrolling flickers and
  misfires on this resistive panel, discrete pages don't.
- Easter egg: 5 taps on the footer within 4s summons **Clawd** (Claude Code's pixel mascot;
  the 17x5 grid in `CLAWD_ROWS[]` was decoded from the CLI welcome screen's half-block art,
  captured by running `claude` in a pty). It animates via a ~54KB `TFT_eSprite` pushed whole
  (the one sanctioned full-region redraw, since sprites can't flicker), degrades to slow
  direct drawing if the allocation fails, returns the RAM on exit, and suppresses normal
  rendering (`octoActive` gates `handleLine`'s draw path) while data keeps flowing.
- TFT_eSPI's pin/driver config lives in the *library's* `User_Setup.h`
  (`~/Documents/Arduino/libraries/TFT_eSPI/User_Setup.h`), not in this repo, since that's how
  TFT_eSPI is configured. If TFT_eSPI is ever reinstalled, that file needs to be recreated with
  this board's pin mapping (documented in the `.ino`'s header comment).
- Colors deliberately avoid a green/yellow/red scheme (the `COLOR_GOOD`/`WARN`/`BAD` constants
  use a blue/orange/reddish-purple palette instead) because a green/yellow/red scheme collapses under the most common colour-vision deficiency, and
  status is also conveyed by shape (`drawStatusDot`: filled circle / filled square / hollow
  ring), never by color alone.
- If Bluetooth permission ever gets stuck (the process crashes again after previously working,
  usually after iterating on `DeckhandBLE.app`'s signature), reset the cached TCC decision with
  `tccutil reset BluetoothAlways com.deckhand.ble-host` before assuming the code is broken.
- `DeckhandBLE.app` embeds a literal copy of `node` + `libnode.147.dylib`, so it's tied to whatever
  Homebrew node version was current when it was built. After `brew upgrade node`, re-copy both
  files into `host/DeckhandBLE.app/Contents/MacOS/` and re-run
  `codesign --force --deep --sign - host/DeckhandBLE.app`.
