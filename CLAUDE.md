# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

**This file is the RULES. The detail lives in [`docs/reference/`](docs/reference/), and the
index at the bottom says which file to read before touching what.** It used to be 6,600 lines
and was loaded into context on every session, most of it narrative about features nobody was
working on. What stayed here is what causes real damage if an agent does not know it.

## What Deckhand is

A three-part system. The interesting behaviour only makes sense once you see the data flow:

```
Claude Code hooks (ANY surface: terminal, desktop app, VS Code) + statusLine (terminal only)
        |
        v
~/.claude/deckhand-statusline.mjs, ~/.claude/deckhand-session-hook.mjs   (live OUTSIDE this repo)
        |  write to
        v
~/.claude/deckhand-rate-limits.json, ~/.claude/deckhand-sessions/*.json
        |  read every 5s by                       Anthropic OAuth usage endpoint
        v                                          (polled every 5 min) |
host/index.mjs  <----------------------------------------------------- +
        |
        --(USB serial AND/OR BLE, JSON lines)-->  deckhand_display.ino
```

USB and BLE are **independent, not fallbacks**: both are normally live at once and the host
writes the same payload to whichever are connected. **"The USB link" is plural** - every
matching port is opened as its own link, so two boards can be driven at once, and the tick's
`via=` names each link (`via=usb:Deckhand-C114,usb:Deckhand-0528,ble`) because `via=usb,ble`
read identically whether that was one board on two transports or two boards on one each.
See [`docs/reference/host-runtime.md`](docs/reference/host-runtime.md).

## THERE ARE TWO BOARDS

Which one a build targets is decided by the **FQBN, never by a switch in the source**.
`board.h` is three lines: `#if defined(CONFIG_IDF_TARGET_ESP32S3)` picks `board_es3c35p.h`,
else `board_e32r28t.h`. A hand-edited `#define BOARD 2` was rejected because it produces a
binary that looks right and is wrong the first time someone forgets to flip it - and the
failure is a full firmware that boots and draws board 1's 240x320 layout onto a 320x480
panel, which reads as a layout bug rather than a build mistake.

| | board 1 (the default everywhere) | board 2 |
|---|---|---|
| `BOARD_NAME` / header | `E32R28T` / `board_e32r28t.h` | `ES3C35P` / `board_es3c35p.h` |
| SoC + panel | ESP32 + ILI9341 240x320 SPI | ESP32-S3 + ST77922 320x480 QSPI |
| draws through | real TFT_eSPI | `PanelShim` + a 300KB PSRAM shadow framebuffer |
| BLE stack | Bluedroid | NimBLE |
| touch | XPT2046 resistive, 5-point affine calibration | capacitive, inside the display IC |
| serial | CH340, `/dev/cu.usbserial-*`, 11.5KB/s ceiling | native USB CDC, `/dev/cu.usbmodem*` |
| mic / beeper | both fitted and working | both work, via the ES8311 |
| flash it | `./flash.sh` | `./flash.sh --board 2` |
| type scale | Cozette 6x13 / Terminus 10x18b / Cozette 12x26 | Spleen 8x16 / 12x24 / 32x64 |
| size today | flash 1413088, RAM 72644 | flash 1051216, RAM 72196 |

The two **flash** figures on that row are the `.ino.bin` sizes in
`firmware/board-baseline.json` and are ASSERTED against it (`node firmware/board-baseline.mjs
--doc-check`), so they cannot go stale again; the two **RAM** figures are `arduino-cli`'s own
"Global variables use N bytes" and are hand-maintained. `arduino-cli`'s "Sketch uses N" is a
slightly smaller number than the `.bin` - the same image without its trailing padding - so do
not expect the compile summary to print these.

**Everything board-specific lives in the two board headers** - pins, capability flags, and
**every layout constant**. Nothing in a shared `.ino` may hardcode a panel dimension; three
separate bugs in the board-2 port were exactly that. Any buffer sized to a panel dimension
must be sized from `BOARD_W`/`BOARD_H`.

## Building and flashing

**`./flash.sh` from the repo root is the whole procedure** - it compiles, resolves the port
(it renumbers), stops the supervised host so the port is free, uploads, and restores the host
even if the upload fails or you Ctrl-C. `--board 2` for board 2. `--no-compile` skips the
~3 minute build.

```
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" firmware/deckhand_display
```

**A compile takes about 3 minutes - longer than a default command timeout.** Budget for it;
it is not a hang.

Every FQBN option is load-bearing and two of board 2's fail SILENTLY. `PSRAM=opi` or the
307,200-byte framebuffer allocation fails and the shim halts. `CDCOnBoot=cdc` or every
`Serial.print()` from the sketch is silently swallowed while ROM boot text still arrives, so
the board looks half-alive with nothing saying why. `PartitionScheme=huge_app` is required on
both because the BLE stack alone is ~700KB. Board 1 additionally needs `FlashMode=dio` -
the default QIO causes upload failures on that exact board.

### NEVER COMPILE BOTH BOARDS CONCURRENTLY

`arduino-cli` derives its sketch build directory from the sketch PATH, so two FQBNs of the
same sketch share one cache and overwrite each other's objects. The first symptom is honest
(`fatal error: opening dependency file ... No such file or directory`); the second is not -
the next board-2 build links board 1's world and fails on undefined `TFT_eSprite` and
Bluedroid symbols, which reads exactly like `board.h` having chosen the wrong header. It has
not; the cache has. Compile one, check it, then the other. If you see TFT_eSPI or Bluedroid
symbols undefined in a board-2 link, `rm -rf ~/Library/Caches/arduino/sketches/<hash>`.

**The same cache makes `--no-compile` dangerous:** it flashes whatever is in that directory,
which is whichever board was compiled LAST, not the one named on the command line. It has
uploaded a board-1 image to board 2 (`esptool` refused it: `Unexpected chip ID ... Expected 9
but value was 0`, and that refusal is good luck rather than design). **`--no-compile` is only
safe when the last compile was for the same board.**

## BOARD 1'S BINARY IS A CONTRACT

**Not "board 1 never changes" - "board 1 never changes by ACCIDENT".** Board 1 was held
byte-identical for the whole two-board port, and that constraint was LIFTED on the
`compose-surface` branch, deliberately: the user asked for board 1 to be brought into line with
board 2, so shared-code fixes now land on both. What survives is the contract that made the
freeze useful in the first place - every movement of either binary is measured, expected, and
explained in the commit message that causes it. Verify it - do not reason about it:

```
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Today: `1d5aec7a57aee5d7...`, size 1413088 (board 2: `43e7d982c7223922...`, size 1051216).

It compares **BYTES, not sizes**, and that matters: a default argument on a shared function
once changed board 1's codegen with **no size change whatsoever** - invisible to a size
comparison. The build is not reproducible (two compiles of identical source differ in 68 of
1,383,200 bytes), so 95 bytes of toolchain-derived metadata are masked, two of the four ranges
located by CONTENT rather than offset because an offset moves whenever the image layout does.

**The baseline has a one-day shelf life and it is not maskable.** The core's `__DATE__` and the
sketch's are the same literal when both were built on the same day, so the linker pools them;
on different days there are two. That is a real 16-byte difference, so the first build after
midnight reports `CHANGED (+16) on BOTH boards with no source change`. Every line the script
prints says `core stamp pooled` or `not pooled`, and a `CHANGED` whose pooling flipped explains
itself. **Re-baselining is deliberate and cheap** (`--update 1`) - say in the commit message
why the binary was expected to move. The point was never that board 1 must never change; it is
that a change to board 1 must never be a SURPRISE.

**Check BOTH boards.** Board 2's baseline was once allowed to fall 4,112 bytes stale across 42
commits, so `--check 2` reported `CHANGED` through an entire task for reasons unrelated to that
task. A `CHANGED` you have learned to expect is a `CHANGED` you stop reading.

## Rules that cause real damage if unknown

- **THE FONTS ARE ASCII `0x20..0x7E` AND NOTHING ELSE.** An out-of-range codepoint draws
  nothing AND advances nothing - it is not a fallback glyph, it is invisible. This repo has
  paid for it at least six times: `fitText`'s ellipsis, the `CLAUDE/air` tag separator, the
  PAIRED MACS middle dot, the SETTINGS HOME chevron, `histFlatten`'s truncation marker, and
  the scrollback's gutter marks. Use three ASCII dots, never U+2026. Everything device-bound
  is transliterated to ASCII on the host (`host/to-ascii.mjs`), which is also what makes the
  character caps exact in BYTES.
- **EVERY FIELD IS REDRAWN ONLY WHEN ITS VALUE CHANGES**, using fixed-width padded strings
  compared against a per-field cache - never a clear-then-redraw of a large area. The first
  version redrew everything every second and visibly flickered. Any new UI element must follow
  it (`drawIfChanged`, `drawBar`, `drawCardBorder`) or reintroduce that flicker. **Two
  consequences bite constantly:** a cache shorter than the string it holds silently stops
  noticing changes past that point, and a field whose CHROME is repainted must have its cache
  reset or the value is left BLANK ("hasn't changed"). A colour-only change reaches no
  text-comparing cache at all and must bust it explicitly.
- **ON BOARD 2 `SCREENSHOT` CANNOT SEE THE GLASS.** It reads the shadow framebuffer - the same
  buffer the renderer just wrote - so a capture is correct by construction even when the panel
  is wrong. This defeated nine tasks of verification. Every board-2 capture vouches for the
  GEOMETRY the renderer composed and for nothing else; **`COLORTEST` is the instrument for
  colour and a person is the authority.** `SCREENSHOT` is also USB-only in practice: the rows
  go out through `Serial.printf`, so with the cable out the whole capture goes nowhere.
- **`#if` ON A C++ `const int` IS SILENTLY FALSE**, with no `-Wall` warning. Board flags must
  be `#define`. This has shipped twice (`panel_shim.cpp`'s `BOARD_PANEL_INVERT`, and
  `BOARD_USAGE_V2` mid-redesign, where every guarded arm would have taken board 1's branch on
  board 2 - the whole redesign compiling cleanly and never reaching the glass).
- **THE `.ino` FILES ARE ONE TRANSLATION UNIT, CONCATENATED** - the one matching the folder
  name first, then the rest alphabetically. So they share every global and need no `extern`s
  *in that order*. Two consequences: a function whose SIGNATURE names a type declared after
  Arduino's generated prototypes (`HostPairing`, `Theme`, `Usage`, `SessionInfo`,
  `ConfirmAction`) will not compile, and a global defined in a later file (e.g.
  `scrollback.ino`) needs an `extern` in `deckhand_display.ino`. Includes a signature depends
  on must go at the TOP of `deckhand_display.ino`.
- **NEVER OPEN A SECOND SERIAL CONNECTION.** On board 1 it pulses the CH340's reset line and
  reboots the ESP32 before anything arrives. Use the trigger file below on both boards - the
  running host owns the port either way, and one mechanism beats an exception to remember.
- **THE HOST MUST RUN VIA `DeckhandBLE.app`.** macOS TCC SIGABRTs a bare `node` the instant it
  touches CoreBluetooth - not a permission prompt, an immediate crash. There is no bare-node
  fallback even for USB-only work.
- **`#if` ARMS THAT DUPLICATE A WHOLE STATEMENT ARE HOSTILE TO EVERY CHECKER HERE.** An `#if`/
  `#else` that opens a brace in both arms leaves any brace-counting tool seeing one more `{`
  than `}`. That broke an unrelated PAIRING assertion, which then reported a defect that did
  not exist. Put only the fragment that differs behind the guard.

## Verification discipline

There is no test suite or linter. Verification is "compile, flash, watch the log, and check
the physical screen" - plus a large set of offline checkers.

```
# firmware geometry and arithmetic
node firmware/deckhand_display/{usage,sessions,settings}-geom-check.mjs
node firmware/deckhand_display/{sessions-rank,scrollback,palette}-check.mjs
node firmware/deckhand_display/commands-check.mjs      # every verb handled or refused BY NAME, both boards
python3 firmware/deckhand_display/{usage-trend,batt-trend}-check.py
node firmware/deckhand_display/geom-sweep.mjs          # fault-injection sweep, ~110s
# the wire and the Mac
node host/{wire-bytes,ask-optdescs,pair-crypto,pair-exchange,voice-answer}-check.mjs
node host/session-inbox-check.mjs                       # the inbox frame, over a stand-in socket
node host/{host-tag,mac-emoji,run-ledger,watchdog,ccusage}-check.mjs
node firmware/board-baseline.mjs --doc-check           # the quote above vs the JSON
node host/multi-device-check.mjs                        # two boards on two cables at once
node claude-hooks/answer-status-check.mjs
node docs/design/*/check.mjs                            # committed mocks, bound to the headers
```

Most take `--selftest`, which injects a fault and **exits 0 only when that fault IS caught**.
Four rules govern all of them, and each was learned by paying for it:

- **A checker must PARSE the constant it certifies, never TRANSCRIBE it.** A literal on the
  checker's side means reverting the constant does not fail. This has bitten at least four
  times.
- **AN ASSERTION THAT CANNOT FAIL IS A DEFECT.** The test is not "does it pass" but **"does
  reverting the constant make it FAIL, and by name"**. A derivation compared against its own
  term always holds; `X >= Y` where `X` is declared `= Y` always holds; `!/re/.test("")` is
  true, so a negative assertion over a missing function passes vacuously.
- **A RULE A NEIGHBOURING LINE CAN SATISFY IS NOT A RULE.** Bind an assertion to a FUNCTION
  BODY, not to the file. Replacing `pairWindowOpen()`'s body with `return true` - deleting the
  entire presence guarantee - once passed all 70 assertions because a copy of the expression
  lived next door.
- **A MIRROR PROVES THE ALGORITHM AND BINDS NOTHING.** A JS re-implementation keeps passing
  with the real code deleted, so checkers report their mirror and structural halves
  separately, and only the structural half reads the firmware's own text.

**And prefer looking at the glass.** On the scrollback alone, four defects were found by
reading a screenshot while all eight checkers were green - and a fifth was a diagnostic whose
own side effect was the thing being reported. **An instrument that cannot observe the thing it
is pointed at is worse than none.**

## Driving the device without reflashing

Write a line to `~/.claude/deckhand-device-command`; the running host forwards it over
whichever transports are live. **The host delivers each command over BOTH transports, so a
cabled device receives it twice** - every handler must tolerate that, and several have had to
learn it (`POWERPROBE` produced four refusal lines; a duplicated scrollback fetch corrupted
itself). **Every refusal must NAME ITS CAUSE**: from the Mac, silence and "impossible here"
look identical. **A verb this board does not have is refused from one table**
(`UNAVAILABLE_COMMANDS[]` in `deckhand_display.ino`), walked at the end of the dispatch
chain, each entry guarded by the exact negation of its handler's guard;
`commands-check.mjs` evaluates both against the two headers and fails by verb name if
one is neither handled nor refused.

| command | what it does |
|---|---|
| `RECAL` / `MICTEST` / `MICMON` / `MICREC` / `MICSTREAM` | touch calibration; mic level, live meter, one-shot and streaming capture |
| `TAB 0..2` / `PAGE 0..3` / `KBTEST` / `EMOJITEST` / `EMOJITEST off` / `READTEST` | put a surface on the glass, since a capture can only record what is already there. **`EMOJITEST off` is the escape** - the flag gates payload absorption AND the tick, and without it a `TAB` painted over the grid left a board that looked alive with a frozen footer, recoverable only by reflashing. `TAB` now clears the grid and REFUSES over a reader/transcript rather than stranding its flag |
| `DETAIL <n>` / `COMPOSE` | the session detail card, and the reply panel over it. `COMPOSE type <text>` types, `COMPOSE chip <n>` taps a token (an insert is NOT idempotent, so the duplicate delivery is dropped BY NAME), `COMPOSE page` pages the tokens, `COMPOSE sent` draws the receipt state and SENDS NOTHING |
| `THEME dark\|light` | which palette is live, so "confirm this reads in both themes" stops needing a person at the device. NOT persisted - a reboot restores the stored setting |
| `DETAIL [n]` | opens session `n`'s detail card WITHOUT the keyboard - the only route to that screen from the Mac (`KBTEST msg` opens the keyboard over it). Refuses by name on no sessions, an out-of-range `n`, or another full-screen surface |
| `KBPROBE` / `KBPROBE off` | per keystroke: the key the press ARMED, the key the lift COMMITTED, the pixel delta. Measures where fingers land versus where they lift; says NOTHING about whether the text was right |
| `KBBUBBLE [r c]` / `KBBUBBLE off` | draws the magnified key bubble so a capture can see it - it otherwise exists only while a finger is down. Arms, never commits; declines DEL, which commits on press |
| `SCREENSHOT` | PNG to `~/Deckhand-shots/` (0.4s on board 2, ~18s on board 1) |
| `COLORTEST` / `SWAP 0\|1` / `INV 0\|1` | board 2: the only instruments that can see the panel's colour pipeline |
| `PERF` / `TEMP` / `TEXTPROBE` | flush timing; SoC DIE temperature; the text-width table |
| `POWERPROBE <label>` | mV/h in the current state; **battery only**, refuses on USB with the cause |
| `AUDIOPROBE` / `TONETEST [vol]` / `TONELADDER` | a ladder of claims: on the bus / configured and playing / find the audible floor |
| `SCROLLFETCH` / `SCROLLOPEN` / `SCROLLTO [line]` / `SCROLLPERF [top\|code\|line]` / `SCROLLCLOSE` | board 2 transcript: fetch without drawing, open, park, measure, close |
| `BLEMTU` | board 2: the negotiated ATT MTU per link |
| `WHOAMI` | re-emits the boot `HELLO <name> v2` line on demand, over USB. Both boards. The host sends it to an anonymous link before considering a reset - `HELLO` is a boot-only burst, so a host that attached to an already-running board otherwise had to REBOOT it to learn its name |
| `MULTITEST <n>` / `PAIRVECTOR` | inject a synthetic second Mac; check the pairing crypto against RFC 7748 |

**`SCROLLPERF` and `SCROLLTO` are separate on purpose.** `SCROLLPERF` times twenty frames of
each of two render paths, which sweeps the view top-to-bottom twice - reported twice as the
page scrolling by itself, because positioning the view for a screenshot was only possible
through the measuring command.

## Read this before touching that

| working on | read first |
|---|---|
| anything on board 2's panel, the shim, bring-up, touch, sleep | [`docs/reference/boards.md`](docs/reference/boards.md) |
| a checker, a baseline, an instrument, `geom-sweep` | [`docs/reference/commands-and-checks.md`](docs/reference/commands-and-checks.md) |
| the SETTINGS tab | [`docs/reference/settings-tab.md`](docs/reference/settings-tab.md) |
| the USAGE tab, quota, burn estimators | [`docs/reference/usage-tab.md`](docs/reference/usage-tab.md) |
| session rows, the detail card, asks, the keyboard | [`docs/reference/sessions-and-asks.md`](docs/reference/sessions-and-asks.md) |
| the scrolling transcript | [`docs/reference/scrollback.md`](docs/reference/scrollback.md) |
| battery, charging, temperature | [`docs/reference/power-and-battery.md`](docs/reference/power-and-battery.md) |
| mic, beeper, dictation, whisper | [`docs/reference/audio-and-voice.md`](docs/reference/audio-and-voice.md) |
| pairing, keys, two Macs at once | [`docs/reference/pairing-and-multi-mac.md`](docs/reference/pairing-and-multi-mac.md) |
| hooks, remote answering, the `ask` object | [`docs/reference/hooks-and-answering.md`](docs/reference/hooks-and-answering.md) |
| Codex, the paged history reader | [`docs/reference/codex-and-history.md`](docs/reference/codex-and-history.md) |
| `host/index.mjs`, OAuth, the watchdog, logs | [`docs/reference/host-runtime.md`](docs/reference/host-runtime.md) |
| the menu-bar app | [`docs/reference/menu-bar.md`](docs/reference/menu-bar.md) |
| fonts, generated art, themes, the waiting screen | [`docs/reference/ui-details.md`](docs/reference/ui-details.md) |
| board 1's known defects and what is unverified | [`docs/reference/board-1-known-state.md`](docs/reference/board-1-known-state.md) |

Human-facing setup and hardware notes are in [`README.md`](README.md). Design specs and plans
are under [`docs/superpowers/`](docs/superpowers/); committed pixel-accurate mocks, each bound
to the board header, are under [`docs/design/`](docs/design/).

## Firmware file map

| file | what |
|---|---|
| `deckhand_display.ino` | types, globals, components, tab bar, setup/loop, protocol |
| `usage.ino` / `sessions.ino` / `settings.ino` | the three tabs |
| `compose.ino` | the reply panel - the compose surface's other screen, over the keyboard's own draft |
| `reader.ino` | board 1's paged history reader; board-2 arms delegate to `scrollback.ino` |
| `scrollback.ino` | BOARD 2 ONLY, one `#if`: the PSRAM transcript, wrap, line index, renderer, drag |
| `audio.ino` / `power.ino` / `keyboard.ino` / `pairing.ino` | mic and beeper; battery and sleep; the QWERTY; NVS keys and the answer HMAC |
| `touch_cal.ino` / `touch_hal.ino` | board 1's affine calibration; the ONE touch entry point both boards use |
| `board.h`, `board_e32r28t.h`, `board_es3c35p.h` | board selection and every layout constant |
| `panel_shim.{h,cpp}`, `panel_text.cpp`, `panel_sprite.h` | board 2's TFT_eSPI-compatible renderer |
| `st77922_*`, `esp_panel_board_custom_conf.h` | the recovered panel init - artefacts, not code to tidy |

**`firmware/tft_setup/User_Setup.h` is BOARD 1 ONLY** and must be copied into the TFT_eSPI
library (`cp firmware/tft_setup/User_Setup.h ~/Documents/Arduino/libraries/TFT_eSPI/`), because
that library reads it from inside itself - so reinstalling TFT_eSPI silently wipes the pin map.

## Working notes

- **Commit or push only when asked.** Board 1's baseline must be `UNCHANGED` at every commit
  unless the message says why it moved.
- **State what is measured and what is not.** Every claim in `docs/reference/` carries its
  evidence, and "not verified" is written down rather than left implied. Keep that.
- **Correct in place rather than deleting.** A described defect that no longer exists costs the
  next reader either the time to disprove it or a no-op "fix" - so entries that turned out to
  be wrong are kept and marked, not removed.
