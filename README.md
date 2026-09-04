<p align="center"><img src="docs/logo.svg" width="120" alt="Deckhand logo"></p>

# Deckhand

<p align="center">
  <img src="docs/device-hero.png" width="270"
       alt="The 3D-printed case, front on, running the real firmware: the SESSIONS tab showing one working Claude Code session">
  <br>
  <em>The printable case from <code>case/</code>, with a real capture on its screen &mdash;
  rendered from the OpenSCAD model, not a mockup (<code>case/render-hero.py</code>).</em>
</p>

<p align="center">
  <img src="docs/screenshot-usage.png" width="200"
       alt="USAGE tab: a 5-hour window card at 9%, a 7-day card at 22%, a Codex row, and the footer">
  <img src="docs/screenshot-sessions.png" width="200"
       alt="SESSIONS tab: one working session showing the animated Claude spark, project name, title, model and branch">
  <img src="docs/screenshot-settings.png" width="200"
       alt="SETTINGS tab: brightness, sleep and volume steppers, and the sound, orientation and theme toggles">
  <img src="docs/screenshot-waiting.png" width="200"
       alt="Standalone screen before the host connects: the Deckhand logo with its wheel turning, the wordmark, the device name, the paired Mac by name, and the command to run">
  <br>
  <em>USAGE, SESSIONS, SETTINGS, and the standalone screen before the host connects -
  real captures read back off the panel, not mockups.
  <code>echo SCREENSHOT &gt; ~/.claude/deckhand-device-command</code> writes a PNG to
  <code>~/Deckhand-shots/</code>.</em>
</p>

[github.com/blueandhack/deckhand](https://github.com/blueandhack/deckhand) &middot; MIT

A little desk display and remote for Claude Code — the crew member who keeps lookout and
relays your orders. It shows live plan usage and per-project session status, beeps when a
session needs you, and shows permission prompts, questions and plan approvals so you can read
*and answer* them from across the room — tapping an option, or **speaking** the answer if a
microphone is fitted — without taking the dialog away from your Mac. **Codex threads appear in
the same list** and can be answered the same way once Codex's hooks trust prompt is accepted.

Three tabs: **USAGE** (5-hour and 7-day plan quota, with a pace tick showing whether you are
burning it faster than the clock, plus a Codex row), **SESSIONS** (one row per project, ranked
by how much it needs you, with the full transcript readable on the device), and **SETTINGS**
(brightness, sleep, sound, theme, orientation, paired Macs).

**It runs on two different boards from one source tree** — an ESP32 + 240x320 panel, and an
ESP32-S3 + 320x480 panel — chosen by the build target, never by a switch in the source.

## Documentation

This README is deliberately short. The detail lives in two places, split by who is reading:

| you are | start here |
|---|---|
| **a person** setting this up or building the hardware | [`docs/guide/`](docs/guide/) — [overview](docs/guide/overview.md), [hardware](docs/guide/hardware.md), [setup](docs/guide/install-and-uninstall.md), [controls](docs/guide/controls.md), [answering](docs/guide/answering.md), [voice](docs/guide/voice.md), [security](docs/guide/security.md), [menu bar](docs/guide/menu-bar.md), [how it works](docs/guide/how-it-works.md), [Codex](docs/guide/codex.md) |
| **an AI agent** working on the code | [`CLAUDE.md`](CLAUDE.md) first — it is the rules, and it says which [`docs/reference/`](docs/reference/) file to read before touching what |

## Quick start (macOS)

You need: a Mac with [Node.js](https://nodejs.org) (`brew install node`),
[arduino-cli](https://arduino.github.io/arduino-cli/), Claude Code, and one of the
[two supported boards](docs/guide/hardware.md).

```
git clone git@github.com:blueandhack/deckhand.git && cd deckhand
./install.sh
```

`install.sh` snapshots any existing Deckhand state to `~/Deckhand-backups`,
copies the Claude Code hook scripts into `~/.claude/`, registers them in
`settings.json` (backing yours up and merging - it won't clobber existing
hooks), runs `npm install`, and builds `DeckhandBLE.app` from your own Node.
Then two manual steps it prints for you: flash the firmware, and start the
host. **Restart Claude Code afterwards** so it picks up the new hooks. The
detailed walk-through is under [Setup](docs/guide/install-and-uninstall.md) below.

## Screenshots

The device can photograph itself — no camera, no mockup:

```
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```

`TAB 0|1|2` and `PAGE 0..3` switch what is on screen first, so every tab can be
captured without standing at the device — the capture path can only ever record
what is currently on the glass.

It reads the panel back over SPI and ships it as base64 RGB565; the host rebuilds
it and writes a PNG to `~/Deckhand-shots/`. 240x320 is 153,600 bytes, so it takes
about 18 seconds at 115200. Nothing is blanked or redrawn while it runs, so what
lands on the Mac is exactly what was on the glass when the command arrived.

Two things this depends on, both measured rather than assumed:

- **The panel really can be read back.** The FAB note elsewhere says readback is
  unreliable here, which is a *speed* argument about per-pixel reads for
  transparency, not a correctness one. Four known colours written and read back on
  this wiring came back bit-identical at `SPI_READ_FREQUENCY 20000000`, and
  `readRect()` pulls a whole row per transaction.
- **`readRect()` returns pixels BYTE-SWAPPED**, where `readPixel()` does not:
  writing `0xF800` gives `readPixel=0xF800` but `readRect=0x00F8`. That is the same
  internal order sprites use, and the same trap the crab art hit with `pushImage`.
  The firmware undoes it before encoding, so the wire format is plain big-endian
  RGB565 and the decoder needs no endianness guess. Getting this wrong is not
  subtle but it is not obviously wrong either — the first capture looked like a
  perfectly good screenshot with purple text.

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

## Known limitations

- **~5s delay**: the host polls every `POLL_INTERVAL_MS` (5000ms in
  `host/index.mjs`), plus whatever `ccusage`/`git` subprocess calls take.
  The footer's "Xs ago" makes this visible rather than hiding it. A
  permission prompt answered within a second or two may come and go
  between polls — the device is for prompts you *haven't* noticed.
- **The quota endpoint is undocumented** (it's what `/usage` uses); if it
  ever changes shape the host just falls back to the statusLine cache. It
  also rate-limits bursts — the host polls every 5 min and backs off 15
  min on HTTP 429. If the Mac goes weeks with no Claude Code use at all,
  the Keychain token can expire; opening any Claude Code surface once
  refreshes it.
- **Remote answering has a 90s window** per prompt (the hook can't wait
  forever), shows up to 1400 characters of detail (tap READ ALL for a
  full-screen reader with prev/next), and doesn't support multi-select
  questions. Question answers reach Claude as a "user already answered: X"
  hook message rather than a native picker selection — functionally
  equivalent. Answering is authenticated (see [Security](docs/guide/security.md));
  a device that hasn't been USB-provisioned with the pairing secret can't
  approve anything until you connect it via USB once.
- **Stale quota is flagged, not hidden**: if the quota numbers are older
  than 15 minutes (endpoint outage + stale cache), the USAGE cards show
  "stale 3h" in the alert color where the reset time normally sits.
- **Battery % is a voltage estimate** (no coulomb counter): it dips a few
  percent under heavy load and reads optimistic while charging. Charge
  state relies on USB *data* being present — a wall charger with no data
  shows "on battery" while silently charging fine.
- **"Off" is deep sleep**, a few mA, not a hard power cut — the CH340 and
  regulator stay powered. For true zero draw, unplug the battery. Because
  there's no VBUS-sense pin, "on USB power" is inferred from recent USB data,
  so a *data-less* wall charger counts as "on battery" for the 20-minute
  auto-sleep — plugged into your Mac (data flowing) it never auto-sleeps.
- **Touch calibration** is a 5-point least-squares *affine* fit (four corners
  plus the centre), so it corrects skew and rotation between the panel and the
  glass, not just scale and offset. It reports the worst residual at the
  targets and refuses to install a mapping from a nonsense set of taps, keeping
  the previous one instead. If it ever
  feels wrong after a firmware change, tap CALIBRATE on the SETTINGS tab, or
  send `RECAL` via the trigger file
  (`echo "RECAL" > ~/.claude/deckhand-device-command`) — never by opening a
  new USB connection, which resets the board via the CH340's RTS line.
- **`TOUCH_SWAP_XY`** in the `.ino` exists because this board's touch
  controller has swapped axes relative to the display; it's already set
  correctly for this exact board, but is there as an escape hatch if a
  differently-wired unit needs it flipped back.
- **BLE scan is name-based, not UUID-based**: our 128-bit service UUID
  usually doesn't fit in the 31-byte primary BLE advertisement alongside
  anything else, so the host scans for all devices and matches by the
  advertised name "Deckhand" instead of filtering by service UUID.
- **`DeckhandBLE.app` is tied to the current Homebrew node install**: it
  contains a literal copy of `node` and `libnode.147.dylib`. If you
  `brew upgrade node`, re-copy both files into
  `host/DeckhandBLE.app/Contents/MacOS/` and re-run
  `codesign --force --deep --sign - host/DeckhandBLE.app`, or the bundled
  copy will just be stale (not broken, but won't get upgrades/fixes).
- **If Bluetooth permission ever gets stuck** (macOS crashes the process
  again after previously working), reset the cached TCC decision with
  `tccutil reset BluetoothAlways com.deckhand.ble-host` and relaunch via
  `open` so it prompts again.

### Board 2 specifically

- **No audio yet.** Board 2 has a real microphone and speaker on board (an ES8311 I2S codec), but
  the firmware has no capture path for them, so the record button is **hidden** rather than shown as
  a control that does nothing, and the needs-input beep is silent. Everything text-based works —
  including answering prompts by **typing** on the device's keyboard. This is the obvious next piece
  of work, and board 2's mic should end up *better* than board 1's: enough bandwidth and memory to
  send plain 16-bit PCM, which is what the speech-to-text wants anyway.
  Two rough edges that follow from it and are not fixed yet: **SETTINGS → ACTIONS → MIC TEST is
  still offered** and does nothing visible when tapped, and the **POWER OFF** hint and confirm
  dialog still say "touch to wake" when on this board only RESET wakes it.
- **No auto-sleep, and that is the chip's fault rather than a missing feature.** Deep sleep on the
  ESP32-S3 can only be woken by an RTC-capable GPIO (0–21), and board 2's touch interrupt is on
  GPIO47. So a sleeping board 2 could only be revived by pressing RESET — which would turn a status
  display into a brick until you walked over to it — and the 20-minute auto-sleep is therefore
  switched off. The screen still blanks on the `SLEEP AFTER` timer and still comes back on a touch,
  and the manual **POWER OFF** button still works (its confirm dialog says RESET, not "touch to
  wake").
- **BLE won't connect after you swap boards until you pick the new one.** The host pins its BLE
  scan to the selected device, so a `selected` left pointing at your other board makes a
  present, healthy device invisible. Fix it from the menu bar's **Device** submenu, or
  `echo "SELECT Deckhand-XXXX" > ~/.claude/deckhand-device-command`. USB is unaffected.
- **Screenshots cannot verify colour on board 2.** `SCREENSHOT` there reads the shadow framebuffer
  rather than the panel, so a capture is right by construction even when the glass is wrong — a real
  byte-order bug survived the entire port that way. Use `COLORTEST`
  (`echo "COLORTEST" > ~/.claude/deckhand-device-command`), which draws six patches each labelled
  with the colour it is supposed to be, and check it with your eyes.
- **The SETTINGS page has about 140px of empty space** below the DEVICE card. Real, cosmetic, and
  nobody has decided what belongs there yet.

---

*Rumor has it something small and orange lives beneath the footer.*
