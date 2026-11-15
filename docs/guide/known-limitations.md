# Known limitations

> Moved out of README.md on 2026-11-14 to keep it short. Index: [`docs/README.md`](../README.md).
> The board 2 entries were out of date when they moved; they are corrected in place below, with
> the old text kept and marked, rather than deleted.

---

- **~5s delay**: the host polls every `POLL_INTERVAL_MS` (5000ms in
  `host/index.mjs`), plus whatever its `git` subprocess calls take.
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
  equivalent. Answering is authenticated (see [Security](security.md));
  a device that hasn't been USB-provisioned with the pairing secret can't
  approve anything until you connect it via USB once.
- **Antigravity is view-only.** Its sessions and usage reach the device, but its hook never
  answers anything, so prompts there are answered on the Mac.
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
- **Touch calibration** (board 1) is a 5-point least-squares *affine* fit (four corners
  plus the centre), so it corrects skew and rotation between the panel and the
  glass, not just scale and offset. It reports the worst residual at the
  targets and refuses to install a mapping from a nonsense set of taps, keeping
  the previous one instead. If it ever
  feels wrong after a firmware change, tap CALIBRATE on the SETTINGS tab, or
  send `RECAL` via the trigger file
  (`echo "RECAL" > ~/.claude/deckhand-device-command`) — never by opening a
  new USB connection, which resets the board via the CH340's RTS line.
- **`TOUCH_SWAP_XY`** in the `.ino` exists because board 1's touch
  controller has swapped axes relative to the display; it's already set
  correctly for this exact board, but is there as an escape hatch if a
  differently-wired unit needs it flipped back.
- **BLE scan is name-based, not UUID-based**: our 128-bit service UUID
  usually doesn't fit in the 31-byte primary BLE advertisement alongside
  anything else, so the host scans for all devices and matches by the
  advertised name "Deckhand" instead of filtering by service UUID.
- **`DeckhandBLE.app` (source installs only) is tied to the current Homebrew node install**: it
  contains a literal copy of `node` and `libnode.147.dylib`. If you
  `brew upgrade node`, re-copy both files into
  `host/DeckhandBLE.app/Contents/MacOS/` and re-run
  `codesign --force --deep --sign - host/DeckhandBLE.app`, or the bundled
  copy will just be stale (not broken, but won't get upgrades/fixes).
  The released `Deckhand.app` carries its own Node and is not affected.
- **If Bluetooth permission ever gets stuck** (macOS crashes the process
  again after previously working), reset the cached TCC decision with
  `tccutil reset BluetoothAlways com.deckhand.ble-host` and relaunch via
  `open` so it prompts again.

## Board 2 specifically

- **Audio works now** (corrected 2026-11-14). Board 2's ES8311 codec drives both the
  needs-input beep, confirmed audible on hardware, and a microphone capture path that sends plain
  16-bit PCM. Details: [`docs/reference/audio-and-voice.md`](../reference/audio-and-voice.md).
  *Superseded text, kept for the record:* "No audio yet. Board 2 has a real microphone and
  speaker on board (an ES8311 I2S codec), but the firmware has no capture path for them, so the
  record button is hidden rather than shown as a control that does nothing, and the needs-input
  beep is silent. [...] Two rough edges that follow from it and are not fixed yet: SETTINGS →
  ACTIONS → MIC TEST is still offered and does nothing visible when tapped, and the POWER OFF
  hint and confirm dialog still say "touch to wake" when on this board only RESET wakes it."
- **Touch cannot wake it from deep sleep, so it powers itself off after two hours, not twenty
  minutes** (corrected 2026-11-14). Deep sleep on the ESP32-S3 can only be woken by an
  RTC-capable GPIO (0–21), and board 2's touch interrupt is on GPIO47, so only **RESET** wakes
  it. On battery, off USB and idle for `AUTO_POWEROFF_MS` (two hours) it powers off; on USB it
  stays up. The screen still blanks on the `SLEEP AFTER` timer and comes back on a touch. Why the
  decision changed: [`docs/reference/power-and-battery.md`](../reference/power-and-battery.md).
  *Superseded text, kept for the record:* "No auto-sleep, and that is the chip's fault rather
  than a missing feature. [...] the 20-minute auto-sleep is therefore switched off."
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
  nobody has decided what belongs there yet. *Not re-checked 2026-11-14:* SETTINGS has since
  become a group menu (see the screenshot in the README), so this may no longer apply.

## Screenshots: how the capture works (board 1)

The device can photograph itself — no camera, no mockup:

```
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```

`TAB` and `PAGE` switch what is on screen first, so every tab can be captured without
standing at the device — the capture path can only ever record what is currently on the glass.

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
