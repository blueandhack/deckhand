# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**THERE ARE TWO BOARDS.** Which one a build targets is decided by the **FQBN**, never by a switch
in the source — `board.h` keys off `CONFIG_IDF_TARGET_ESP32S3`, which the toolchain defines for
the S3 target and not for the plain ESP32. See **Two boards** under Architecture for everything
that differs and why; this section is only how to build each.

| | board 1 (the default everywhere) | board 2 |
|---|---|---|
| `BOARD_NAME` / header | `E32R28T` / `board_e32r28t.h` | `ES3C35P` / `board_es3c35p.h` |
| SoC + panel | ESP32 + ILI9341 240x320 SPI | ESP32-S3 + ST77922 320x480 QSPI |
| draws through | real TFT_eSPI | `PanelShim` + a 300KB PSRAM shadow framebuffer |
| BLE stack | Bluedroid | NimBLE |
| touch | XPT2046 resistive, 5-point affine calibration | capacitive, inside the display IC, factory-aligned |
| serial | CH340, `/dev/cu.usbserial-*`, 11.5KB/s ceiling | native USB CDC, `/dev/cu.usbmodem*` |
| mic / beeper | both fitted and working | **both work, via the ES8311** (capture is PCM16, no codec) |
| flash it | `./flash.sh` | `./flash.sh --board 2` |
| type scale | Cozette 6x13 / Terminus 10x18b / Cozette 12x26 | Spleen 8x16 / 12x24 / 32x64, every rung native |
| body text | 6x13 = 2.31mm, 31-col detail-card lane | 8x16 = 2.47mm, 32-col detail-card lane |
| size today | flash 1386934, RAM 69804 | flash 993978, RAM 65900 |

**Board 1's binary was BYTE-IDENTICAL across the whole second-board port, and that check is now
RETIRED — replaced, not abandoned.** Two deliberate shared-code fixes moved it on purpose (the
history list going blank after reading one entry, and the PAIRED MACS row), so the constant is
gone and `firmware/board-baseline.mjs` takes its place:

```
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

It is **stronger** than what it replaces, in two ways the old check could not be:

- **It compares BYTES, not sizes.** "Byte-identical" was always implemented as "compare those two
  numbers", and two different binaries of the same length pass that.
- **It lives in a command rather than in prose**, so running it is not a thing to remember.

**A plain hash cannot do this, because the build is NOT reproducible — measured, not assumed:** two
compiles of identical source differ in **68 of 1,383,200 bytes**. Every differing byte is derived
metadata rather than code, and the mask is **95 bytes (0.0068%)** in four ranges:
`esp_app_desc_t.app_elf_sha256` (0xB0..0xCF, 32); the **sketch's** own `BUILD %s %s` timestamp (21);
the **ESP32 core's** `Compile Date/Time` timestamp (9, or 21 — see the pooling note below); and the
trailing 33-byte image SHA-256 plus checksum. Two of those four are located **by content**, not by
offset, because an offset moves whenever the image layout does.

**A board number is still required everywhere, even though `MASK_BOARD` is now EMPTY.** It used to
hold the sketch's build stamp at a fixed per-board offset (`0x13BC` on board 1, `0x1D9C` on board
2) — found the hard way, when a mask derived from board-1 binaries was applied to board 2 untested
and board 2 reported `CHANGED` at **+0 bytes**, precisely the case the old size check could never
have seen. Both stamps are found per image now, so nothing board-specific remains; the argument is
kept because `--selftest`'s whole job is telling you when a board needs one again.

`--selftest <binA> <binB> <board>` is what keeps that honest, on the same teeth-proving convention as
`palette-check.mjs`: given two builds of identical source it **must** show the raw hashes differing
and the masked hashes agreeing, and it FAILS if the mask no longer covers what the toolchain varies —
printing the uncovered runs, because re-deriving them by hand with `cmp` is exactly the step this
already failed once.
**Re-run it after an arduino-cli or ESP32 core upgrade** — a core that starts stamping something new
would otherwise make every check fail and look like a real change. (Note `time[16]`/`date[16]` at
0x70..0x8F did NOT vary between builds minutes apart, so this core does not stamp them; if a future
one does, the selftest is what says so.)

**THE SECOND `time\0date\0` PAIR IS THE ESP32 CORE'S, NOT A PREBUILT LIBRARY'S — AND THIS FILE
ASSERTED THE OPPOSITE FOR AS LONG AS THE HOLE EXISTED.** The claim below under *THE "UNEXPLAINED
5-BYTE CLUSTER"* used to say the pair at ~`0x2DA4` was a LittleFS "Software Info" stamp, **fixed**
when that library was built, and therefore not worth masking. It is
`cores/esp32/chip-debug-report.cpp:215` — `chip_report_printf("  Compile Date/Time : %s %s\n",
__DATE__, __TIME__)` — so it is fixed only for as long as `core.a` is **cached**, and it moves on
every core rebuild. Found by running the pre-fix script across one: **FAIL, uncovered runs at
`0x2DA4` and `0x2DA6..7`**, where the same script passes on any same-core pair — which is exactly
why a wrong explanation survived. It is masked now, anchored on its own trailing literal, and the
mask went **86 → 95 bytes**. Re-verified here across a real `--clean` core rebuild: raw hashes
differ, masked hashes agree, board 1 `UNCHANGED` either way.

**THE BASELINE HAS A ONE-DAY SHELF LIFE, AND IT IS NOT MASKABLE.** The core's `__DATE__` and the
sketch's are the SAME string literal whenever both were built on the same calendar day, so the
linker **pools** them — one copy, and only the time sits ahead of the core's anchor. Built on
different days there are two literals and the date sits there as well. Measured on identical source:
pooled → **1386864 / `05fb733c`**; un-pooled → **1386880 / `dbcd7ed6`**. So the first build after
midnight following a core rebuild is un-pooled against a pooled baseline and `--check` reports
**CHANGED (+16) on BOTH boards with no source change**, and it recurs at every such midnight. No
mask fixes it: the 16 bytes are a literal that either exists or does not.
**So the script SAYS WHICH STATE IT IS IN.** Every line it prints carries `core stamp pooled` or
`not pooled`, `--update` records that state in `board-baseline.json`, and a `CHANGED` whose pooling
flipped prints the explanation and tells you to rebuild the core (`arduino-cli compile --clean`)
before believing your own diff. The alternative is a check that cries wolf once a day, and this repo
already says elsewhere what happens to a check nobody reads. Both current baselines are recorded
`pooled: true` — not assumed: a pooling flip changes the hash, so today's pooled builds matching
them IS the proof. (The teeth were proven by injection: a baseline doctored to
`pooled: false, size -16` produces the `+16 bytes` line and the explanation under it.)
The same fact is why the **`size today` row above can never be reconciled to the byte** across
sessions — two honest measurements of one commit differ by 16 depending on the core's cache.

**BOTH BOARDS GET CHECKED, AND A STALE BASELINE IS INDISTINGUISHABLE FROM A REAL CHANGE.** Board
2's baseline was allowed to fall **4,112 bytes stale across 42 commits**, so `--check 2` reported
`CHANGED` through an entire task for reasons that had nothing to do with that task's code. Nothing
in the code caused it: re-baselining board 2 was in nobody's routine, and the plans of the day named
board 1 only — board 1 is the one held byte-identical, so it is the one everybody remembers. That is
the danger rather than the untidiness: a `CHANGED` you have learned to expect is a `CHANGED` you
stop reading, and the next one will be real. **Compile board 2, `--check 2`, then compile board 1,
`--check 1` — never concurrently** (one sketch build directory; see below), and re-baseline whichever
moved with the reason in the commit message.

**Re-baselining is deliberate and cheap: `--update 1` and say in the commit message WHY the binary
was expected to move.** The point was never that board 1 must never change — it is that a change to
board 1 must never be a SURPRISE. It is not ceremony: it caught a real
latent bug (moving `TOUCH_CS` into a header included before `<TFT_eSPI.h>` silently switched on
TFT_eSPI's built-in touch extension, which this board cannot use because the touch controller is
on a separate SPI bus) and it is the reason four otherwise-good refactors were declined mid-port.
If you change shared code, compile board 1 and compare those two numbers before believing you
only touched board 2.

Compile and flash the firmware (from the repo root; find the serial port with `ls /dev/cu.usbserial-*`
on board 1, `ls /dev/cu.usbmodem*` on board 2):

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

Board 2 (ESP32-S3), where **every FQBN option is load-bearing and two of them fail SILENTLY**:

```
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" firmware/deckhand_display
arduino-cli upload -p /dev/cu.usbmodemXXXX \
  --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  firmware/deckhand_display
```

- **`PSRAM=opi`** — the shadow framebuffer is a 307,200-byte
  `heap_caps_malloc(MALLOC_CAP_SPIRAM)`. Without octal PSRAM enabled in the FQBN that allocation
  simply fails, and the shim halts. This board has 8,388,608 bytes of PSRAM; the framebuffer is
  3.7% of it.
- **`CDCOnBoot=cdc`** — this one is the trap. With `USBMode=hwcdc` but `CDCOnBoot` left at its
  default, the ROM boot text and the panel driver's own `ESP_LOG` lines **still arrive** (they go
  out through the USB-Serial/JTAG console directly) while every `Serial.print()` from the sketch
  itself is **silently swallowed**. Proven side by side with a sketch containing nothing but
  `Serial.println()` in `setup()`. So the board looks half-alive: boot chatter, no firmware
  output, and nothing anywhere saying why. It is not in the demo project's own FQBN.
- **`USBMode=hwcdc` + `FlashMode=dio`** match the verified working build for this board. `dio` is
  the same reason board 1 needs it.
- **`esp32:esp32:esp32s3` (the generic S3 target) is what defines `CONFIG_IDF_TARGET_ESP32S3`**,
  which is the whole board-selection mechanism. Compile board 2's source with the plain `esp32`
  FQBN and you get board 1's header silently — that is exactly the failure a manual `#define
  BOARD 2` switch would have made routine, which is why there isn't one.

**Board 2's port does NOT renumber the way board 1's does, but it does disappear.** It enumerates
as an Espressif "USB JTAG/serial debug unit" (vendor 0x303A) at `/dev/cu.usbmodem*`, and
**enumeration proves nothing**: it has been seen resetting, enumerating and emitting zero bytes at
any baud with `esptool` unable to sync — through four `arduino-cli upload` attempts, all three
`--before` modes on both `cu.` and `tty.`, esptool's own DTR/RTS download sequence by hand, and
reads with DTR both low and asserted. **What fixed it was a power cycle** (connecting a battery),
not software. So: if board 2 is mute, power-cycle it or hold BOOT while tapping RESET before
suspecting the firmware. Note that the same symptom — resets, zero serial at any baud — is also
what a `Wire`-plus-legacy-I2C boot loop looks like (see the I2C note under Two boards), so the two
are indistinguishable from the Mac and the cheap test comes first.

Run the host script — **via `DeckhandBLE.app`, not plain `node`, if Bluetooth is wanted**:

```
cd host && npm install
./deckhand-service.sh install      # supervised by launchd - survives death and login
```

**The host is normally supervised, and that changes the flashing procedure.**
`deckhand-service.sh install` registers a `KeepAlive` LaunchAgent, so a killed or
crashed host is back within ~1s (measured: SIGKILL -> revived in 1s, both transports
up). It exists because the host has NEVER crashed - zero reports filed for the bundle -
it HANGS or exits, and nothing brought it back; one stuck BLE write left it silently
dead for five hours while its serial reader kept logging device lines, so everything
looked healthy from the Mac.

**To flash, run `./flash.sh` from the repo root - that is the whole procedure.** It
compiles, resolves the port (it renumbers), frees it, uploads, and puts the host back
the way it found it, including when the upload FAILS or you Ctrl-C - leaving the display
dead because an upload failed would be worse than the problem it solves. It handles both
a supervised host and a hand-started one. `./flash.sh --no-compile` skips the ~3min build, and
`./flash.sh --board 2` flashes board 2 — same stop-host/upload/restore-host dance, a different
FQBN and port glob. `--board` defaults to 1 so every existing habit keeps working.

**NEVER compile both boards concurrently.** Two boards make "check both at once" the obvious
move and it corrupts the build: `arduino-cli` derives its sketch build directory from the
sketch PATH, so two FQBNs of the same sketch share one cache and overwrite each other's
objects. The first symptom is honest enough - `fatal error: opening dependency file
.../esp_lcd_panel_io_3wire_spi.c.libsdetect.d: No such file or directory` - but the second is
not: the next board-2 build linked board 1's world, failing on undefined `TFT_eSprite`,
`TFT_eSPI::fillRect` and Bluedroid `esp_ble_gatts_cb_param_t` symbols, which reads exactly
like `board.h` having selected the wrong header. It has not; the cache has. Compile them one
after the other, and if you see TFT_eSPI or Bluedroid symbols undefined in a board-2 link,
`rm -rf ~/Library/Caches/arduino/sketches/<hash>` before believing anything else.

**THE OTHER FACE OF THAT ONE CACHE: `./flash.sh --board 2 --no-compile` UPLOADED A BOARD-1 IMAGE.**
`--no-compile` skips the build and flashes whatever is in the shared sketch build directory — which
is whichever board was compiled LAST, not the board named on the command line. Board 1 had been
compiled last, so board 2 got board 1's binary and `esptool` refused it: `Unexpected chip ID in
image. Expected 9 but value was 0` (9 is the ESP32-S3, 0 the plain ESP32). That refusal is the good
case, and it is good only by luck of the two boards having different SoCs — the flag's contract
("skip the ~3min build") says nothing about which board's objects are sitting there, and it will do
the same thing every time the boards are alternated. **`--no-compile` is only safe when the LAST
compile was for the same board**; otherwise drop the flag.

The hazard it hides, for when it is not used: KeepAlive re-grabs `/dev/cu.usbserial-*`
within a second of the process dying, so a bare `arduino-cli upload` fails on a busy port
and looks like a hardware fault. **Killing the process is not enough** - only
`./host/deckhand-service.sh stop`, which unloads the job, prevents the respawn.
`open DeckhandBLE.app --args "$(pwd)/index.mjs"` still works for a one-off unsupervised run.

**Whether the supervisor is earning its place is a question you can ANSWER, not argue
about.** A supervisor cannot be proven correct by reasoning - only time shows whether it
catches anything - and a restart used to leave no trace at all, since launchd keeps no
history and the host log simply resumed mid-stream. Each start now appends a line to
`~/.claude/deckhand-restarts.log`, summarised by `./host/deckhand-service.sh status`:
starts this week, longest and shortest run, and the last reason. Read it after a week -
"0 restarts, longest run 7d" means the net is unproven *and unneeded*, while a pile of
them means there is a cause still worth fixing rather than a net worth leaning on.
The load-bearing column is **"last tick", not duration**: a run that lasted 5h whose last
tick was 4h before it ended did not die, it HUNG, and the ledger flags that as `STALLED`.
It costs no per-tick I/O - the previous run's final tick is read back from the heartbeat
file, which is already written every 5s.

**BUT THE TWO COLUMNS HAVE DIFFERENT LIFETIMES, AND CONFLATING THEM MADE THE LEDGER LIE
FOR ITS FIRST 182 ENTRIES.** The duration comes from `~/.claude/deckhand-run-state.json`,
which survives everything; the last tick comes from the heartbeat in the runtime dir under
**`/tmp`, which macOS clears at boot**. The arithmetic was
`lastTick = beat?.at || prev.startedAt`, so a missing heartbeat silently became "ticked
once at startup, then hung for its entire life" - and since a reboot guarantees a missing
heartbeat, **the ledger reported a full-length hang after every reboot**. All four stalls
it ever recorded were this fallback, two of them on confirmed reboots (Aug 18 21:39 and
Aug 24 06:06, the latter reported as `previous run 0s, STALLED 6.8h` for a run that was
fine). The single metric the ledger exists to produce was the one that was wrong, and the
tell was visible in the data: a genuine progressive hang reads `previous run 3h, STALLED
20m`, so `previous run 0s` **four times out of four** was the fallback firing, not a
coincidence.
Fixed by splitting the three cases in `host/run-ledger.mjs` - a heartbeat inside the run's
life gives both numbers; a heartbeat OLDER than the run's start is positive evidence that
it never completed a tick, which IS a hang; an absent or malformed heartbeat reports the
lifetime and says `last tick unknown`, claiming no stall and counting no hang. **A
measurement that cannot say "I don't know" will always answer with the scarier option**,
which is the transferable part. Malformed reads as absent rather than coerced, deliberately:
`at: 0` would date the last tick to 1970 and report a **56-year** stall.
The arithmetic lives in its own module with no fs and no clock - the same reason `capUtf8`
does - so it can be tested:

```
node host/run-ledger-check.mjs              # 31 assertions
node host/run-ledger-check.mjs --selftest   # re-runs them against the OLD arithmetic
```

`--selftest` is the same teeth-proving convention as `palette-check.mjs`: it re-injects the
shipped-for-182-entries arithmetic and **exits 0 only when all 9 missing-heartbeat checks
FAIL against it**. That matters more than usual here, because this bug survived precisely
by being unobservable - the wrong number looked like a real measurement.
`status` now counts `last tick unknown` runs separately, and **flags any historical
`STALLED` entry that also says `previous run 0s` as UNRELIABLE** rather than rewriting the
log: the old entries are indistinguishable from genuine never-ticked hangs, and deleting
evidence to make a metric look better is worse than labelling it.

**THE WATCHDOG HAD THE SAME DISEASE, AND ITS COUNT WAS MEASURING MACOS SLEEP.** The ledger
also reports "watchdog fires", and that number reached 236 while every fire logged
`an await never settled`. It was never an await. `Date.now() - lastTickCompleted` cannot
tell **a stuck promise** from **a suspended machine** - both are wall-clock jumping forward
with no completed tick - so the watchdog answered with the alarming one.
**Measured: of the 14 stalls in the one run whose log survives, 14 matched a macOS sleep
window to within 6 seconds.** Zero were hangs. Method, because the log carries no
timestamps: tick lines' `cxage` field advances with wall-clock, so it reconstructs when
each gap happened, and `pmset -g log` supplies the sleep windows to match against. The
three ~901s stalls are macOS's scheduled maintenance sleep, which its own log names -
`Entering Sleep state due to 'Idle Sleep' ... 900 secs` - and the five inside one 66-minute
gap matched five consecutive sleep cycles to within 5s each.
The discriminator in `host/watchdog.mjs` needs **no monotonic clock**: ask whether the
watchdog's OWN interval kept running. A stuck promise leaves the event loop alive, so the
interval still fires every 5s; a suspend freezes the interval too, for as long as the
stall. That is 5s against 900s, a ~6x margin over the threshold, which is what keeps an
interval merely running late under load reading as a hang - treating lateness as sleep
would silently disable the watchdog on a busy machine, the one failure here that would
actually cost something. **Known limitation, stated rather than papered over:** a
synchronously blocked event loop also freezes the interval and reads as a suspend; nothing
in this host does that, since every heavy path is a child process.
Sleeps are counted as `suspendResumes` and reported separately (`N sleep resumes`), so
`watchdog fires` finally means hangs. Both are omitted at zero and absent from older
records, so every existing entry reads unchanged.

```
node host/watchdog-check.mjs              # 27 assertions
node host/watchdog-check.mjs --selftest   # re-runs the sleep cases against the OLD logic
```

**Two findings from that investigation that are NOT the watchdog**, recorded because each
looks like the other from the menu bar:

- **`ccusage` failed 18 times in one run** (clustered after wakes and when load average hit
  24), and **one failure used to cost the WHOLE TICK** - `readUsage()` gathered its four
  sources with `Promise.all`, so a single 20s child-process timeout rejected the lot. ccusage
  supplies only **three fields, all token counts**; the 5h/7d hero percentages, the reset
  countdowns, the Codex row, the session list and the clock come from the OAuth snapshot, the
  statusLine cache and the sessions directory, and were all fine. The tick threw them away,
  sent the device nothing and **wrote no tick line** - and since the menu bar reads the most
  recent tick line while the heartbeat (written EARLIER in the same tick) stayed fresh, the
  numbers **froze rather than vanished**, which is the documented "healthy process doing no
  useful work" class wearing a new hat.
  Fixed in `host/ccusage.mjs`: `tryCcusage` cannot reject, and `pickTokens` merges the
  reading with the last known good one **field by field** - the two ccusage calls fail
  INDEPENDENTLY, so discarding the half that worked would be the same all-or-nothing mistake
  one level down. A measured **0 is kept as a measurement** (the Codex row's `--`-not-`0%`
  rule, in the other direction), and `everMeasured` distinguishes "carried forward" from
  "never read", which is the only case where the zeros are not a carried-over value.
  Staleness is logged on the **edge**, not per tick, or a 5s loop buries the tick lines it
  sits between. **Proven by breaking it on the live host**: moving `ccusage/src/cli.js` aside
  for 22s produced `ccusage blocks --active: exited 1` (the failure MODE named, where the old
  line was a truncated argv dump with empty stderr), `Token counts are STALE - carrying the
  last reading forward.`, **5 tick lines that would previously have been 0**, percentages
  still updating, token counts held at their last values, then `Token counts are live again.`

```
node host/ccusage-check.mjs              # 22 assertions
node host/ccusage-check.mjs --selftest   # re-runs the fallback cases against the OLD path
```

- **`deckhand-service.sh status` reported the MENU BAR's pid as the host's.** Its check was
  `pgrep -f 'MacOS/Deckhand'`, which also matches `mac-app/.../MacOS/DeckhandMenuBar`, and
  `pgrep` lists the lower pid first - so the login-started menu bar shadowed the host
  entirely: `status` said `process: running (pid 1107)` while the host was **stopped**. It
  matches `DeckhandBLE.app/Contents/MacOS/Deckhand` now, a path only the host has. Same
  family as the other two defects on this page: a check that cannot tell two things apart
  reports the reassuring one.
- **What actually blanks the menu bar is the heartbeat**, not the numbers:
  `readStatus` requires it under **12 seconds** old, so sleep and restarts empty the whole
  label while a `ccusage` failure does not. Measured wake-to-first-tick: **1-2s usually,
  17s twice** - which is the brief blank you see on waking the Mac.
- **The BLE `poweredOff` hang in the notes below is real history but did NOT recur**: the
  3s `withTimeout` race added for it is in place, and the 16 `poweredOff` transitions in
  that run are a *consequence* of sleep (bluetoothd powers down), not a cause. Do not
  re-diagnose it from the adapter lines alone; that cost a full round of this investigation.

**The LaunchAgent runs the bundle's binary DIRECTLY, not through `open`, and that is
verified rather than assumed.** The warning below - that launching must go through
`open` - is about OBTAINING the Bluetooth permission prompt. Once TCC has granted it,
exec'ing `DeckhandBLE.app/Contents/MacOS/Deckhand` keeps the bundle's identity and
CoreBluetooth comes up normally (measured: the process survived and reached `BLE:
adapter state = poweredOn`, where a bare `node` is SIGABRT'd within ~2s). Going through
`open` would also give launchd nothing to supervise, since `open` returns immediately.

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
  to succeed (it even returns 0) but no process survives and `/tmp/deckhand-<uid>/host.log` is never
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
echo "COLORTEST" > ~/.claude/deckhand-device-command # BOARD 2 ONLY: six labelled colour patches
echo "SWAP 0" > ~/.claude/deckhand-device-command   # BOARD 2 ONLY: panel byte order, live
echo "INV 1"  > ~/.claude/deckhand-device-command   # BOARD 2 ONLY: display inversion, live
echo "PERF" > ~/.claude/deckhand-device-command     # BOARD 2 ONLY: flush timing breakdown
echo "TEMP" > ~/.claude/deckhand-device-command     # BOARD 2 ONLY: SoC DIE temperature (not the case)
echo "TEXTPROBE" > ~/.claude/deckhand-device-command # print the text-width table (both boards)
echo "READTEST" > ~/.claude/deckhand-device-command # BOARD 2 ONLY: open the ask reader on the first pending ask
echo "POWERPROBE bl90-awake" > ~/.claude/deckhand-device-command # measure mV/h in the CURRENT state, labelled
echo "POWERPROBE off" > ~/.claude/deckhand-device-command       # stop early and report what it has
echo "PANELSLEEP 1" > ~/.claude/deckhand-device-command # BOARD 2 ONLY: SLPIN the panel while blanked
echo "CPUSLOW 1" > ~/.claude/deckhand-device-command    # BOARD 2 ONLY: 240 -> 80MHz while blanked
echo "BLESLOW 1" > ~/.claude/deckhand-device-command    # BOARD 2 ONLY: ~200ms conn interval while blanked
echo "PULSE 1" > ~/.claude/deckhand-device-command      # BOARD 2 ONLY: the band breathes while a prompt waits - DEFAULT OFF, UNMEASURED
echo "AUDIOPROBE" > ~/.claude/deckhand-device-command # BOARD 2 ONLY: is the codec on the bus? configures nothing
echo "TONETEST" > ~/.claude/deckhand-device-command   # BOARD 2 ONLY: configure the codec and PLAY a tone
echo "TONETEST 90" > ~/.claude/deckhand-device-command # ... at a given volume, 1-100 (default 30)
echo "TONELADDER" > ~/.claude/deckhand-device-command # BOARD 2 ONLY: five rising volumes, find the audible floor
```

**The three audio commands are a LADDER OF CLAIMS, and running them out of order debugs two
questions at once.** `AUDIOPROBE` answers "is the ES8311 on the bus?" and configures nothing, so it
can never be blamed for silence. `TONETEST` configures the whole chain and plays, so silence after
it IS a fault — it dumps all 74 registers first, which is what makes "the codec is fine, look
downstream" a statement rather than a hope. `TONELADDER` exists because the volume scale is linear
in dB and therefore hopeless to guess at: volume 15 is about -77dB and volume 90 about +20dB, so it
plays five rising steps and the listener names the first one they hear. Prefer it to re-running
`TONETEST` at a guessed volume — that costs one run per guess and this costs one run total.

`COLORTEST` and `TEXTPROBE` exist for the same reason `TAB`/`PAGE`/`KBTEST`/`EMOJITEST` do: the
glass is otherwise unverifiable. `COLORTEST` in particular is the **only** instrument that can see
board 2's panel colour pipeline, because `SCREENSHOT` there reads the framebuffer rather than the
panel — see the verification trap under Two boards.

**`SWAP` and `INV` are the two runtime toggles that go with it, and using all three together is the
documented way to diagnose a colour fault** — not reasoning from what the colours look like, which
cost this repo three wrong fixes. `COLORTEST` names what each patch should be; `SWAP` flips the byte
order; `INV` flips the display inversion. Four combinations, seconds each, against one build per
guess otherwise. Neither toggle persists, deliberately: the answer belongs in the board header once
it has been SEEN.

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
before anything reaches it. (Board 2 has no CH340 and so no auto-reset, but go through the trigger
file there too: the running host owns the port either way, and one mechanism for both boards beats
an exception you have to remember.) Always go through the trigger-file mechanism above so the command
rides the connection the running host script already has open. (BLE doesn't have this problem —
only USB's CH340 auto-reset behaves this way.)

Exercise the battery time-remaining estimator's arithmetic and guards without waiting 20
minutes on a real cell (it **parses the thresholds out of `power.ino`**, so a mirror that
drifts from the firmware fails loudly instead of passing while the firmware is broken —
verified by tampering with one: exit 1):

```
python3 firmware/deckhand_display/batt-trend-check.py
```

It also covers the **CHARGING** estimator (board 2 only) — time to `pctFromMv()`'s 100%, reported
as a FLOOR because the fit is taken below the CV knee and extrapolates through it, and refused
outright above the knee where this board's lack of a current sense makes it unmeasurable. See
**SoC die temperature and time-to-full** under Two boards; the `>=` versus `~` distinction and the
two refusal codes (`chg=-1` / `chg=-2`) are both asserted there.

That same file now also covers **`POWERPROBE`**, the passive mV/h instrument, which exists so a
proposed battery saving can be RANKED instead of argued about. It measures whatever state the
device is already in and reports against a label you supply, so an A/B is "set it up, probe,
change one thing, probe again" — and it composes with savings that do not exist yet, including a
different build. Three properties are deliberate:

- **It takes its own raw ADC reads** rather than reusing the trend ring. That ring stores one
  snapshot a minute of `batteryMv`, which is an **EMA of 8** — and averaging an already low-passed
  signal does *not* buy the `sqrt(N)` that averaging independent samples does, because consecutive
  values are correlated. Reading the ADC directly is what makes the noise fall with the sample
  count, and it keeps the probe from reshaping the estimator that draws the `~5h` label.
- **It reports mV/h, not %/h.** Millivolts per hour is the raw datum; percent routes through
  `pctFromMv`'s curve, which is a MODEL of a cell nobody characterised, so comparing two builds in
  %/h would attribute that curve's shape to the hardware. Same reason the sleep report prints mV/h.
- **It states its own confidence** — the standard error of the slope — instead of inheriting the
  estimator's fixed 20-minute/25mV gate, and says `not yet significant` until `|slope|/SE` clears
  `POWERPROBE_MIN_SNR_X10`. That self-shortens when the drain is large, which is exactly the case
  worth measuring: a −88 mV/h fall at realistic bucket noise is significant in **7 minutes** (SNR
  25) where the fixed rule cannot speak for 20. A fixed span cannot do both.

**It can only run ON BATTERY, and that is a property of the measurement rather than a limitation.**
`batteryState()` returns `DISCHARGING` only while `usbLinkActive()` is false, so the cable must be
out and the report comes back over BLE — a probe that "worked" on USB would be measuring the
charger. It refuses with the cause named (`not on battery (unplug USB; state=2 mv=3866)`), because
"no output" and "impossible here" look identical from the Mac.

**Re-issuing the SAME label reports progress instead of restarting.** Checking on a running probe
by re-sending the command is the obvious thing to do, and a restart would silently discard the
minutes already collected — a measurement that reads as merely slow rather than as thrown away. It
also makes the probe immune to the host delivering one command over BOTH transports, which is what
every other command already gets (observed: one `POWERPROBE` produced four refusal lines).

**DO NOT COMPARE mV/h ACROSS SESSIONS — MEASURED, AND IT COST A WRONG CLAIM IN THIS FILE.** The
first version of this note said board 2's awake baseline was **−88 mV/h** (from 62 one-a-minute
`BATT` lines fitted offline: max residual 5.5 mV, RMS 1.8 mV, a dead straight line) and that
`POWERPROBE` disagreeing with it would mean the instrument was wrong. `POWERPROBE` then measured
**−143 ± 5.5 mV/h** (SNR 26, 13 buckets) in the nominally same state, and cross-checking the raw
per-minute `BATT` deltas over the same window gave ~−147 — so **the two independent readings of the
run agreed with each other and disagreed with the historical figure**. The instrument was not wrong;
the states were not the same. They differ in at least state-of-charge (**44% / 3794 mV** now against
**59–73% / 3887–3974 mV** then), in thermal history (this run began minutes after a charge), and
possibly in brightness, which was only ever *observed* at 90% — never known for the logged window.

**THE FIRST REAL A/B, AND IT SETTLES WHAT TO OPTIMISE ON BOARD 2.** Both legs measured minutes
apart in one session at ~44% SoC, on battery over BLE, USAGE tab, nothing else changed but the
BRIGHTNESS stepper — and each cross-checked against the raw per-minute `BATT` deltas, which is what
makes it two independent views rather than one:

| state | `POWERPROBE` | raw `BATT` deltas |
|---|---|---|
| `bl90-awake` (brightness 90, never blanks) | **−142 ± 4 mV/h** (SNR 34, n=15) | −147 mV/h |
| `bl-min` (brightness at minimum) | **−60 ± 4 mV/h** (SNR 16, n=7) | −60 mV/h |

So the backlight at 90% is **~80 mV/h, about 56% of the whole awake drain** — the dominant single
load, which is what promotes `SLEEP AFTER` and the brightness default from "probably worth it" to
measured. **The other ~60 mV/h survives with the backlight essentially off**, and that is the budget
the panel-`SLPIN` and light-sleep ideas are competing for: the panel controller is still fully
active behind a dark backlight (`enterSleep()` only zeroes the PWM), the S3 is at 240MHz, and the
ES8311 plus its ungateable amp are powered. Measure those individually before building any of them.

**A related fact found the hard way: `SCREENSHOT` is USB-ONLY IN PRACTICE.** `SHOT begin` and the
base64 rows go out through `Serial.printf`, so with the cable out the entire capture goes nowhere and
logs nothing — it does not fall back to BLE. (Which is just as well: 410KB at BLE's ~666 B/s would be
~10 minutes of radio, wrecking any power measurement it was called during.) To verify a *setting*
during an on-battery run, read the physical consequence instead — dropping the brightness rebounded
the cell **+10 mV**, which is better evidence that the load fell than a number rendered on screen.

**THE THREE BLANKED-STATE SAVINGS ARE RUNTIME TOGGLES, DEFAULTING OFF** —
`PANELSLEEP`/`CPUSLOW`/`BLESLOW`, board 2 only, applied at the next blank rather than
immediately (applying a blanked-state saving to a lit screen would measure a state the device
never sits in). They are toggles for exactly the reason `SWAP`/`INV` are: one measurement needs the
cable out and ~10 minutes on battery, so three build-and-measure cycles costs a reflash per guess
where one build plus `POWERPROBE` settles every combination in a single session. Nothing is
persisted — the answer belongs in `board_es3c35p.h` once it has been SEEN. Board 1 is excluded
deliberately: different SoC, different panel driver, auto-deep-sleep as a backstop, and no way to
measure any of it here.

**A REQUEST FLAG IS NOT A RECORD OF WHAT THE DEVICE DID, AND CONFLATING THEM STRANDED A SAVING ON
HARDWARE.** The first version gated each restore on the same flag that enables it —
`if (savePanelSleep) { tft.sleepPanel(false); ... }`. Clearing a toggle **while the device was still
blanked with that saving applied** therefore skipped the restore on the next wake: the panel stayed
in `SLPIN` behind a lit backlight and the CPU stayed at 80MHz, with nothing that would ever put
either back. Found by doing it — a toggle was cleared mid-blank to set up an A/B, and the next tap
produced a dark screen.
Fixed with three `*Applied` variables recording what is actually in force, reconciled by one
idempotent **`savingsSync()`** against `isAsleep && <flag>`. That single function serves entering
sleep, waking, AND a toggle flipped at any moment, which is the point: apply and restore being two
separate conditions that could disagree is what allowed the leak.
It also **re-syncs immediately**, so a toggle flipped while blanked takes effect at once instead of
waiting for a tap — removing the very friction that caused the bug, since an A/B otherwise needs a
physical tap between every leg. `enterSleep()` still kills the backlight FIRST and `wakeUp()` raises
it LAST over an already-woken panel; inside `savingsSync()` restores lead with the CPU (so the
panel's two 120ms sleep-out delays and the repaint are not also run at a third speed) and applies
leave it for last. Every one of those orderings is asserted in `batt-trend-check.py`, and the
`SAVINGS` line reports `applied=n/n/n asleep=n` so the state is observable rather than inferred.
Proven on the glass in the exact failing scenario: `applied=1/0/0 asleep=1` then, after clearing it
with no tap, `applied=0/0/0 asleep=1`.

**Only a TOUCH can wake this device — verified, and it matters for every measurement.** `wakeUp()`
has exactly one call site (`handleTouch` when `isAsleep`), and `autoDeepSleep()` is compiled out on
board 2, so nothing wakes it spontaneously. A blanked device stays blanked until a finger arrives,
which is what makes an unattended `POWERPROBE` run trustworthy — and it is why an unexplained
`asleep=0` mid-run means somebody touched it, not that a hidden wake path exists.

**WHAT `esp_pm` CANNOT DO HERE, MEASURED AT THE INSTRUCTION LEVEL.** Automatic light sleep and DFS
are **compiled out of the stock Arduino core**: `CONFIG_PM_ENABLE is not set`, and
`esp_pm_configure` is a three-instruction stub — `entry` / `movi a2, 0x106` / `retw.n`, i.e. it
returns `ESP_ERR_NOT_SUPPORTED` and does nothing. It LINKS, so calling it compiles cleanly, changes
nothing, and measures nothing — which would read as the idea being wrong rather than absent. Manual
`esp_light_sleep_start()`, `esp_sleep_enable_gpio_wakeup()` and `gpio_wakeup_enable()` *are* all
present (in the `dio_opi` variant board 2 links), and light sleep wakes from ANY GPIO, so the
RTC-pin constraint that blocks deep sleep on `PIN_TOUCH_INT` (47) does not apply. The open question
is `CONFIG_BT_CTRL_MODEM_SLEEP is not set`: with no controller modem sleep, stopping the CPU while a
link is live will probably drop it. That is a SPIKE, not a design — and it is why light sleep is not
in this pass.
**When checking whether an IDF feature exists, search ALL the variant archives.** A search of only
`lib/*.a` reported `esp_deep_sleep_start` as undefined — a function this firmware demonstrably
calls — because the per-flash-mode copies live in `dio_opi/`, `opi_opi/` and so on. The tell was
running the same search against a symbol known to work; without that control the conclusion would
have been confidently backwards.

**`#if` ON A MACRO THE TRANSLATION UNIT CANNOT SEE IS SILENTLY FALSE, AND IT REINTRODUCED THE VERY
BUG IT WAS SCOPING.** `panel_shim.cpp` deliberately includes no board header (see its own file
comment). The panel-wake path was first written as `#if BOARD_PANEL_INVERT` around the
post-`SLPOUT` `invertColor()` re-apply — and that macro is undefined there, so the re-apply
compiled away entirely and every wake would have returned the panel with **every colour
complemented**: precisely the fault the line exists to prevent. It now restores a `_inverted` state
the shim TRACKS, which is better than a constant anyway, because `INV 0|1` is a runtime command and
the right value on wake is whatever was in effect. Two lessons, both asserted in the checker:
`panel_shim.cpp` must branch on **no** board macro at all, and **a text-matching test cannot watch
the preprocessor delete the line it just found** — the original assertion ("the wake path mentions
`invertColor`") passed the whole time the call was being compiled out.

**THE "UNEXPLAINED 5-BYTE CLUSTER" IN THE BASELINE MASK IS EXPLAINED: IT IS THE SKETCH'S OWN BUILD
TIMESTAMP.** `deckhand_display.ino` prints `BUILD %s %s` with `__DATE__`/`__TIME__`, so every image
embeds `hh:mm:ss\0Mmm dd yyyy\0` and two compiles minutes apart differ only in the digits that
changed — which is exactly the "5 bytes with one matching by chance in the middle" the old note
described; the middle byte was a colon. Measured: `23:00:18` against `23:03:23`.
**It is now located BY CONTENT rather than at a fixed offset, and that was a live bug, not a
tidy-up.** The offset moves whenever the image layout does: adding `POWERPROBE` grew the binary and
shifted the string from `0x13BC` to `0x1596`, so `--check 1` reported **board 1 CHANGED at +0
bytes** for a change that was entirely `#if`'d out of board 1 — the same false positive board 2
once produced, from the same cause, and guaranteed to recur on the next size change. `--selftest` is
what caught it, and only once it was run on two *genuinely independent* compiles: run back to back
the build is incremental and reproducible, so the mask is never exercised and the selftest says so
rather than passing vacuously.
**The match is ANCHORED on the trailing `BUILD ` string, because an image holds THREE
`time\0date\0` pairs and only ONE OF THEM IS THE SKETCH'S**. The anchor is matched but NOT masked,
since `BUILD ` is an ordinary literal whose change must still be caught, and the date is masked
alongside the time so a build on a different DAY does not diverge either. `MASK_BOARD` is empty
because the one board-specific entry was this stamp.
**THE ACCOUNT OF THE OTHER TWO WAS WRONG, AND THE ERROR WAS LOAD-BEARING.** This paragraph said both
were prebuilt-library stamps — `00:11:05 Aug 16 2026` "from LittleFS" and `19:41:21 May 18 2026` from
the BTDM controller — **fixed** when those libraries were built, so that masking them "would spend
real sensitivity for nothing". The BTDM one is genuinely fixed. The other is the **ESP32 core's own**
`Compile Date/Time` stamp, which varies on every core rebuild, so the sensitivity that was being
protected did not exist and the hole did. It is masked now and the mask is **95 bytes**, not 86 — see
**THE SECOND `time\0date\0` PAIR** under Commands for how it was found and for the pooling
consequence that comes with it.

So an absolute mV/h is only meaningful **within one run**. Two consequences:

- **A/B by DIFFERENCE, back to back, in one session.** A common offset from SoC region or thermal
  drift cancels; a cross-session absolute carries it in full.
- **Let the cell settle, and expect the first fit to lie.** The minute after unplugging fell
  **−21 mV** on its own, and the fit walked −135.9 → −119.9 → −113.2 before turning round and
  converging up to −143. Discard anything reported inside the first few minutes: the SNR gate
  cannot catch this, because a relaxation curve is smooth and fits a line perfectly well.

**What the −88 mV/h turned out to BE, since it is the first thing anyone will re-derive:**
`SLEEP AFTER` was set to **OFF** with brightness at 90%, so the backlight never blanked — and the
straight-line fit is the evidence, because a blank at 30s idle would leave an obvious knee and a
voltage rebound. **On board 1 that setting is survivable; on board 2 it is not**, because
`AUTO_SLEEP_IDLE_MS` is compiled out there (`BOARD_HAS_TOUCH_SLEEP_WAKE 0`) so the backlight blank
is the *only* power saving left, and nothing stops it being switched off. The reasoning that
disabled auto-sleep on board 2 explicitly leans on that blank still being there. **This is an open
design gap, not a misconfigured device** — a candidate fix is to drop the OFF rung from
`SLEEP_PRESETS_MS` when `BOARD_HAS_TOUCH_SLEEP_WAKE` is 0.

Validate the DARK/LIGHT palettes (contrast plus colour-blind/greyscale separability) and prove
the checker itself has teeth:

```
node firmware/deckhand_display/palette-check.mjs
node firmware/deckhand_display/palette-check.mjs --selftest
```

**Check the MENU-BAR APP, which cannot be clicked from a script — but CAN now be screenshotted,
and that claim was wrong for a long time.** This file said `screencapture` needs a TCC grant this
process does not have, and every instrument here was built around that wall. **The grant exists
now: measured, by running it.** So `--menu-shot` captures the real menu off the glass, and the
indirect instruments below stop being the only evidence. Every claim about this surface is still
made through one of these, as commands rather than prose for the reason the board baseline is:
running them must not be a thing to remember.

```
mac-app/build.sh                                          # swiftc + ad-hoc codesign; the .app is not committed
B=mac-app/DeckhandMenuBar.app/Contents/MacOS/DeckhandMenuBar
$B --pace-check                # the pace arithmetic and the bar's colouring; prints its own count
$B --sound-check [play]        # every needs-input sound resolves, and the asking-edge script
$B --menu-dump                 # the composed bar label, tooltips, every row, checkmarks, tips
$B --legibility-check          # every row carrying a READING renders at full strength
$B --menu-shot out.png         # THE REAL MENU, off the glass - captured by window id
$B --menu-preview out.png      # the bar label AND the menu, rendered light and dark
$B --icon-preview out.png      # the boat at every size and style, 6x nearest-neighbour
$B --open-session [<id>] [go]  # what a click on each session row would do (prints; acts only on `go`)
node host/mac-emoji-check.mjs  # the four hand-transcribed icon tables agree
DECKHAND_TMP=<dir> $B --menu-dump   # drive the REAL parser with a synthetic host-alive + host.log
```

**`DECKHAND_TMP` is the seam that makes the interesting states reachable at all**, and it is how
the stale/critical/window-extreme cases were actually exercised: write a fresh `host-alive` (its
`at` must be within 12s or `readStatus` reports the host down) plus one crafted tick line into a
throwaway directory, and every parser downstream runs for real. It is the same test seam
`uninstall.sh` uses, and pointing it anywhere but a scratch directory would have the test eat the
live host's runtime state — which has happened once already, so use a scratch path.

**A rebuilt bundle is NOT the running one.** The app must be relaunched to pick it up, and the kill
has to name the menu bar rather than "Deckhand": `pkill -f 'MacOS/Deckhand'` also matches the HOST
(`DeckhandBLE.app/Contents/MacOS/Deckhand`), which is the exact collision that once had
`deckhand-service.sh status` reporting the menu bar's pid as the host's. Kill by pid, or match
`MacOS/DeckhandMenuBar`.

**Check what the HOST puts on the WIRE — the byte budget and the ask's option descriptions.** Both
parse every cap out of the hook, the host and the firmware rather than transcribing one, so a cap
that moves fails by name instead of taking the numbers with it:

```
node host/wire-bytes-check.mjs               # 255 assertions: every device-bound cap is exact in BYTES,
                                             #   the hook's inline toAscii matches host/to-ascii.mjs over
                                             #   71,738 strings, and the saturated tick line is measured
                                             #   against feedChar's guard (incl. the still-over tripwire)
node host/wire-bytes-check.mjs --selftest    # 19/19 injected faults, each printing WHICH assertion caught it
node host/ask-optdescs-check.mjs             # 38 assertions: optDescs is capped in bytes on a codepoint
                                             #   boundary, parallel to options, absent when nothing
                                             #   is described
node host/ask-optdescs-check.mjs --selftest  # 5/5 injected faults
```

Two properties are worth knowing before leaning on them. `wire-bytes-check.mjs`'s selftest names the
assertion that caught each fault, because **"caught" alone cannot tell the assertion that exists for
a fault from an unrelated crash** — and two of its faults exist only because nothing else could see
them: an ASCII-only idempotence break, and a raised `detail` cap that only the budget half catches.
And `ask-optdescs-check.mjs` keeps its budget model **untransliterated on purpose**: it is now the
BEFORE picture and the record of how big the character/byte defect was, so do not "fix" it to agree
with the other checker.
**Its count went 47 → 38 and NOTHING was removed.** `readCaps()` asserts each of its own regexes,
and it was being called twice — once at the top and again inside the behaviour suite — so nine
claims were counted twice. That is not only a vanity number: a regex that stopped matching would
have been reported as nine findings rather than one, which is the "an instrument that flatters" rule
pointing the other way. The caps are passed in now, and the behaviour suite's sandbox is torn down
in a `finally`, since the run that fails is exactly the one whose scratch directory must not survive.

**Check the LAYOUT ARITHMETIC of both boards' screens without a screen.** Three checkers parse the
constants straight out of `board_e32r28t.h` / `board_es3c35p.h` (shared parsing in
`geom-common.mjs`) and assert every derivation the headers claim — so a header that drifts from its
own comment fails loudly instead of passing while the panel is wrong:

```
node firmware/deckhand_display/usage-geom-check.mjs      # USAGE cards, hero/bar/stats/foot clear boxes, footer's three zones, Codex row
node firmware/deckhand_display/sessions-geom-check.mjs   # the row-height ladder, tall/sub/compact gates, detail card, ask option chips
node firmware/deckhand_display/settings-geom-check.mjs   # settings pages, steppers, keyboard, history reader, confirm-screen line cap
node firmware/deckhand_display/geom-sweep.mjs            # fault-injection sweep over all three (~30s, see below)
```

Each takes `--selftest`, which injects a fault and **exits 0 only when that fault IS caught** (exit
1 if the checker is blind to it) — the same teeth-proving convention as `palette-check.mjs
--selftest`. Two things to know before leaning on them:

- **They self-check their own `textWidth` first.** Each one re-implements TFT_eSPI's width rule and
  verifies 136/136 against `text-widths-board2.txt`, the widths the real panel measured, before
  asserting anything downstream of a width. A checker that quietly disagreed with the device about
  how wide `WORKING` is would be worse than none.
- **They carry a `known` list of board-1 shortfalls they TOLERATE**, and that list is honest rather
  than a silencer: the board-2 side of each entry is empty, so board 2 passes on its own merits.
  Those entries are real pre-existing board-1 defects — see `docs/board-1-known-defects.md`.
- **A checker must PARSE the constant it certifies, never TRANSCRIBE it — and this has now bitten
  twice.** First as `BODY_H = {1:13, 2:16}` hardcoded in a checker whose whole job was to measure
  text, fixed by regex-parsing `UI_FONTS[]`. Then as `const PILL_H = 18` copied into
  `sessions-geom-check.mjs` from `drawStatusPill`: **measured** by mutation, raising the pill to 22
  at its draw sites left all three checkers exiting 0 while the assertion they exist for ("the pill
  ends clear of the row's own 2px card border") was false. The height is now one named per-board
  constant (`PILL_H` in each board header) that the two `uiRound` calls, the label's `MC_DATUM`
  centre, `DETAIL_PILL_STEP` and the checker all read — four copies down to one — and the same
  mutation now fails by name on both boards. When you add a checker assertion, the test is not
  "does it pass" but **"does reverting the constant make it fail, and by name"**; a literal on the
  checker's side of that line makes the answer no.
- **The `--selftest`s are one tooth per ~60 claims, so there is a FAULT-INJECTION SWEEP over all of
  them.** `node firmware/deckhand_display/geom-sweep.mjs` perturbs every constant each checker
  parses, at ±1/±4/±16, per board, and re-runs the whole checker: a constant no assertion notices is
  reported as UNGUARDED, and a guarded one is reported with the SMALLEST perturbation that was
  caught — which is the more useful number, since it says how much real headroom each has.
  It **exits 0 even with unguarded constants**, deliberately: most of them are colours, beep
  frequencies and cosmetic gaps with no geometric constraint, and wiring that to a non-zero exit
  would make it un-runnable until someone had either written 150 assertions or suppressed the list —
  and a suppressed list stops being read. Non-zero is reserved for the sweep's own internal errors.
  Three things it has actually caught, which is why it is worth the ~30 seconds it takes: the
  waiting screen's seven `WAIT_*` offsets, read by no checker at all and wrong on board 2; the
  pager key's WIDTH, checked in one dimension only; and — the same run, once the checkers started
  measuring per board — the wordmark's 64px cell erasing the two lines under it. A fourth was
  found by *reading* rather than by the sweep and is the reason to keep widening it: the whole
  VOICE RESULT CARD was covered by nothing at all, which is how it kept a 13px line step under a
  16px cell right through a type-scale port. **Take an
  unguarded constant that this repo just ADDED or CHANGED as a gap, not as noise.**
  **SHRINKING a constant can UNGUARD it, and that is the fifth thing the sweep caught.** Board 2's
  `MSG_BTN_H` was guarded at 46 — `2 + H <= DETAIL_CARD_DY` tripped at ±4 — and taking the TYPE
  chip to 26 opened 22px of headroom under the same bound, so the sweep reported it unguarded with
  nothing about the code having got worse. The three bounds on it were all one-sided CEILINGS, so
  the chip could have been driven to 8 with every one still passing. The close is the pager key's
  own lesson in the other axis: the chip's label was checked for WIDTH and never for HEIGHT, and
  `uiButton` draws it `MC_DATUM`, so an undersized chip does not merely crop its glyphs — the
  opaque box paints `COLOR_CARD` over the chip's own stroke, the clear-box-not-glyphs hazard the
  usage cards already pay for. Asserting that box clears the stroke at both ends is a bound taken
  from the geometry rather than fitted to today's 26, and it catches the chip at 20.
  Where it stands today: **493 of 558 constant-board pairs guarded** (board 1 32/237 unguarded,
  board 2 33/321) — board 2 gained **50 constants** in the settings redesign and its unguarded count
  went DOWN, which is the standard this file sets for constants the repo just added: every one of
  them is caught at **±1 in both directions**. (`ASK_OPT_DESC_BYTES` from the option-descriptions
  work, and `READER_CODE_LINE_H` from the reader line-step fix, likewise.) Board 1's numbers are
  unchanged, which is the sweep agreeing with `board-baseline.mjs` that nothing there moved.
  Of the unguarded ones only **8 on board 1 and 10 on board 2 are read by any
  checker at all** — the other 24 and 23 are mic, beeper, crab and preset-count constants with no
  geometry to violate. **Four of board 2's ten are unguarded BY CONSTRUCTION and are not a
  gap**: `DETAIL_PAD_Y`, `DETAIL_PILL_STEP`, `DETAIL_COL_LBL_STEP` and `DETAIL_COL_VAL_STEP` are
  board 1's arm only since §7 replaced the pill and the two column pairs with the band and one
  meta line, so nothing on board 2 reads them and no perturbation can move a board-2 number. They
  are still swept because the sweep perturbs every constant the checkers PARSE, and the parse is
  shared. (`BORDER_CTRL` appearing under board 1's "read by a checker" is the same kind of
  artefact from the other end: `referenced` is a regex over the checker's source text, and the
  assertion naming it is inside an `if (b === 2)` block.) Known and accepted, so do not
  re-litigate them: `MSG_BTN_W`, `H_BTN` and `SP_2` are pre-existing; a cache-size assertion is `>=` by nature so `SESSION_ROW_SIG_LEN`
  cannot be caught by a small perturbation at all (`CODEX_LANE_CACHE` *is* now caught on both
  boards, because ONE buffer serves both Codex fields and it is asserted against the LARGER,
  `CODEX_RIGHT_CHARS`, as well as the lane); and `CFM_Y`/`CFM_H`,
  `HIST_CHIP_X`/`HIST_CHIP_TAP_W`/`HIST_JUMP_H`, `P1_TOP`/`P2_TOP`/`P2_GAP`, `KB_TEXT_Y` and
  `WAIT_CMD_H` all sit inside documented slack (board 2's page 2 has 149px of it - the checker
  reports its hint ending at 311 against a footer at 460 - and its keyboard
  break 38px) — each IS asserted, just not tightly enough for ±16 to trip it.
  **The sweep needs its own memory discipline and that is not optional.** It re-imports each
  checker once per injection, ~1400 times, and every instance is compiled code the ESM cache can
  never release, so runs are sliced across four child processes per (checker, board). Before that
  the sessions child OOM'd. **It did not fail silently** — the parent already checked the child's
  exit status, so it printed "1 checker sweep(s) hit an INTERNAL ERROR - the numbers above are
  incomplete" and exited 1. What it did lose was *coverage*: the checker that constrains every
  `SESSION_*`/`DETAIL_*`/`ASK_*` constant was absent from the union, so 88 of them appeared under
  "read by no checker" — loud about the failure, quiet about which numbers it had cost. If a future
  checker grows, raise `SLICES`; do **not** raise the heap, because the limit being hit is V8's
  CODE space and `--max-old-space-size` provably does nothing (it dies at 840MB with a 4.5GB heap
  limit).
  **THE HAND-RUN `--checker <name>` FORM IS UNSLICED, AND ON `sessions` IT STILL OOMs.** That is the
  usage line the script's own header advertises, and it dies with a V8 heap trace — because the
  slicing lives in the PARENT: a plain `geom-sweep.mjs` spawns four children per (checker, board)
  and stays well inside the bound, while `--checker sessions` runs that board's ~1100 injections in
  one process. Measured today, on both invocations, at this commit. So the coverage is **present**,
  not absent — a report that the sessions checker's constants are unswept is a report about which
  command was typed. **Run the plain sweep**; to look at one checker by hand, add
  `--board <n> --slice <i>/4` (that is exactly what the parent does) and read the four slices, or
  raise `SLICES`. This is recorded rather than fixed: it is pre-existing, and the working
  invocation is the documented one.

**Check the asking-session tie-break — longest-waiting-first, not most-recent-first — without a
device:**

```
node firmware/deckhand_display/sessions-rank-check.mjs             # 9 mirror + 3 source assertions
node firmware/deckhand_display/sessions-rank-check.mjs --selftest   # proves the checker rejects the OLD (recency) rule
```

**Be honest about what this proves and what it does not.** Most of its assertions run a JS MIRROR
of `sessionSortsBefore()` — same convention as the geometry checkers' shared-parser trick, but
weaker: it proves the ALGORITHM (including the millis()-wrap case, unreachable on hardware without
a 49.7-day uptime) and would keep passing even if the real comparator were deleted, since nothing
in it executes the sketch. Only the three STRUCTURAL assertions at the bottom — which read the
real source text rather than a mirror of it — actually bind the sketch: that
`sessionSortsBefore(b, a, now)` takes no clock of its own, that `reorderSessions()` samples
`millis()` exactly once, and that the tie-break compares `ELAPSED(b) > ELAPSED(a)` rather than the
reverse (an inverted comparison is the exact regression this whole change exists to prevent, and it
is what the operand names in that last assertion are pinned against — an unpinned `\w+`/`\w+`
version of it let an inverted comparator pass clean). This split is why the pass line reports
`9 mirror + 3 source assertions pass` rather than one undifferentiated total.

There is no test suite or linter in this repo; verification is "compile, flash, watch the
Serial Monitor / host log, and check the physical screen." **On board 2, read that last clause
literally — see the SCREENSHOT trap under Two boards, because a capture there cannot see the
glass.**

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

### Two boards

The firmware runs on two physically different devices from one source tree. Board 1 is the
original: **ESP32 + a 240x320 ILI9341 SPI panel**, real TFT_eSPI, Bluedroid BLE, an XPT2046
resistive touch panel behind a 5-point affine calibration, an analog MAX4466 mic into ADC-DMA.
Board 2 is **ESP32-S3 + a 320x480 ST77922 QSPI panel**, drawing through a shim into a PSRAM
shadow framebuffer, NimBLE, a capacitive touch controller integrated into the display IC, and an
ES8311 I2S codec whose capture path **is not written yet**.

**Board selection is derived from the compile target, never declared.** `board.h` is three lines:
`#if defined(CONFIG_IDF_TARGET_ESP32S3)` → `board_es3c35p.h`, else `board_e32r28t.h`. A
hand-edited `#define BOARD 2` was rejected because it produces a binary that looks right and is
wrong the first time someone forgets to flip it — and the failure is a full firmware that boots
and draws board 1's 240x320 layout onto a 320x480 panel, which reads as a layout bug rather than
as a build mistake.

**Everything board-specific lives in the two board headers** — pins, capability flags, and **every
layout constant**. Nothing in a shared `.ino` may hardcode a panel dimension; three separate bugs
in this port were exactly that (see the `SHOT` buffer note below).

#### The shim: TFT_eSPI cannot drive a QSPI panel

TFT_eSPI has no QSPI path for the ST77922, so board 2 draws through **`PanelShim`**
(`panel_shim.h` / `panel_shim.cpp` / `panel_text.cpp` / `panel_sprite.h`), a class that
reimplements the TFT_eSPI methods this sketch actually calls, with the same signatures and the
same semantics, over a PSRAM framebuffer.

**That was viable because the API surface is small, and the number is the reason this was a port
rather than a rewrite.** Measured, and re-derivable in one command:

```
grep -oE '\btft\.[a-zA-Z_]+' firmware/deckhand_display/*.ino | sed 's/.*tft\.//' | sort | uniq -c | sort -rn
```

**28 distinct methods across 621 call sites** today — and one of those 28 (`flush`, 26 sites) is
the shim's own addition, so the pre-existing surface was **27 methods**. Four methods account for
two-thirds of the calls (`setTextDatum` 123, `drawString` 116, `setTextColor` 101, `width` 89).
Reimplementing 27 methods against 621 unchanged call sites is a bounded job; rewriting the
renderer is not, and it would have forked every one of this file's flicker-free-redraw
invariants.

`BOARD_USES_TFT_ESPI` is the guard. It is spelled `#if !BOARD_USES_TFT_ESPI` around every one of
the 26 `tft.flush()` sites specifically so **board 1 never sees the TEXT of a call it does not
have** — a runtime no-op method would have been simpler and would have moved board 1's binary,
which is the constraint that decided it.

#### The shadow framebuffer is not a convenience — it is the only reason SCREENSHOT and sprites exist on board 2

QSPI has **no readback**. Three things this repo already does need to read pixels back:
`SCREENSHOT` (`readRect`), the crab's off-screen sprite, and the AA primitives, which blend each
pixel against **the destination** rather than against a `bg` colour passed in. None is possible
without a buffer the CPU owns. So the shim allocates **307,200 bytes** (320 x 480 x 2) in PSRAM
(8,388,608 available) and draws into that; the panel only ever sees `flush()`. That readable
destination is also why board 2's AA is *better* than board 1's — TFT_eSPI cannot read the ILI9341
back on this wiring, which is why its smooth primitives take a `bg`/`behind` colour to blend
against instead of the real pixel. `PanelShim` keeps those parameters for interface parity with the
existing call sites and ignores them where it can do better.

**`flush()` pushes the DIRTY RECTANGLE in ≤32-line strips, and both halves are load-bearing
findings from the bring-up, not tuning:**

- A single ~300KB full-frame transfer **fails to allocate an internal SPI bounce buffer**. Strips
  are what make the transfer possible at all.
- `drawBitmap`'s default `timeout_ms = 0` is **NON-BLOCKING**. Without `timeout_ms = -1` the next
  strip's `memcpy` races the DMA engine still reading the previous one — a data race whose symptom
  is intermittently torn or stale bands, not an error.

Measured: **full-screen flush ~41,000µs; a 32x32 dirty rect ~939µs — 44x.** That ratio is why this
file's change-only redraw discipline matters *more* on board 2 than on board 1, not less: on board
1 a needless repaint costs some SPI writes, here it costs 41ms of QSPI.

**`flush()` snaps the dirty rect's x OUTWARD to a multiple of 4** (`x0 &= ~3`, `x1 |= 3`). The
ST77922 driver warns per `drawBitmap` when `x_start` or width is not 4-aligned, and on a
change-only UI that is **one warning per field per tick** — the host log filled with them and real
device lines drowned. Snapping *out* can only redraw a few pixels that already hold correct
contents; snapping *in* would clip the edge column of whatever just changed. Verified exhaustively
over every in-range `(x0, x1)` pair on both panels: 0 bad cases. Y needs no alignment — the driver
constrains only the axis the QSPI transfer packs.

#### Board 2's draw performance: the AA primitives were the whole problem

**Switching to the USAGE tab took 888ms** and felt exactly as bad as that sounds. The instinct — the
flush is slow, it's a 300KB framebuffer over QSPI — was wrong, and chasing it wasted a cycle. Use
`PERF` (board-2-only) before optimising anything here; it reports the flush split into its two
halves, and `switchTab` logs its own duration.

What the numbers actually said, and what fixed them:

| | before | after | after the type scale |
|---|---|---|---|
| `switchTab` → USAGE | 888 ms | **85 ms** | 88 ms |
| `switchTab` → SESSIONS | 203 ms | **68 ms** | 73 ms |
| `switchTab` → SETTINGS | 355 ms | **77 ms** | 84 ms |
| `renderUsageTab` | — | 59 ms | 62 ms |
| `drawUsageStatic` | 504 ms | **16 ms** | 16 ms |
| full-screen flush | 45 ms | **30 ms** | 30 ms |

**The type scale cost 3-9%, and that is the whole answer to "does a 32x64 hero and a 16px body cost
too much".** Measured on the glass with `PERF` plus `TAB 0|1|2`, two passes each: USAGE 87.8/88.3,
SESSIONS 72.8/73.7, SETTINGS 84.1/84.3, `renderUsageTab` 62.1/62.5 (of which `drawUsageStatic` 16.5
and the cache reset 0.016). The **flush did not move at all** — 30.2ms, gather 8.3 + transfer 21.8 —
which is the expected shape: a flush ships the whole framebuffer regardless of what is in it, so
only the *composing* half can get slower, and it did, by the few ms that drawing roughly 2.4x the
glyph area costs. Nobody will see 5ms on a tab switch that already takes 85, so this is accepted
rather than tolerated. The SESSIONS figure moves with how many sessions are live and how tall the
expanded first card is; the other three are fixed layouts.

**`fillSmoothRoundRect` and `drawSmoothRoundRect` were 86x more expensive than they needed to be.**
Both walked the whole bounding box — 296x164 = 48,544 pixels for one card — evaluating a float SDF
with a `sqrt` and doing a read-modify-write against a framebuffer in PSRAM. The stroke paid *two*
SDF evaluations even on the interior hole it then discarded. Three cards of fill plus stroke came to
~290,000 of those.
**The geometry is integer, so only the corners have fractional coverage**: at a straight edge the SDF
distance is 0 (coverage exactly 1) and one pixel out it is 0. So both now decompose into solid
`fillRect` runs plus four blended corner boxes — **exact, not an approximation**. The general
`quadrants` path is kept and left unoptimised because it is real API surface that nothing calls.

**The strip buffer was in PSRAM**, and it is the buffer the CPU fills and DMA then reads — paying the
slow bus twice. It is 20KB against ~269KB of free internal heap, so it is now
`MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL` with a PSRAM fallback that logs (a slow display beats none).
That alone took the flush 45ms → 30ms, improving both halves. The framebuffer itself has to stay in
PSRAM at 300KB; this never did.

**Two optimisations were tried, measured, and REVERTED** — recorded because the numbers are the
useful part and re-deriving them costs an hour each:
- **QSPI 40 → 80MHz**: full-screen transfer 21842µs → 21641µs, inside the noise. Whatever bounds this
  transfer is not the clock. Left at the vendor's 40.
- **`fillRect` storing two pixels per 32-bit write**: 83,952µs → 84,792µs. PSRAM here is latency- and
  bandwidth-bound, not store-count-bound.

What remains is `renderUsageTab` at ~59ms, which is dominated by text rendering — the hero numbers at
`textsize 4`. Not chased further; the gap between 888ms and 85ms was the complaint.

#### THE VERIFICATION TRAP: on board 2, `SCREENSHOT` cannot see the glass

**This is the single most important thing on this page about board 2, and it defeated nine tasks of
verification.**

`SCREENSHOT` calls `readRect`, which on board 2 reads **the shadow framebuffer** — the same buffer
the renderer just wrote. So a capture is **correct by construction even when the panel is wrong**,
and every screenshot in this port looked perfect while the display was visibly wrong. Nobody found
it by inspection; the user found it by looking at the device and saying "the colour is bad, green?".

**THREE independent faults were behind that, on three separate axes, and it took four reports to
resolve because every wrong combination looks identically like "the colours are broken".** Written
out in full because the debugging method is the transferable part, not the values:

| axis | was | is | why it was hard |
|---|---|---|---|
| pixel format | `COLMOD` = `0x01` | `0x55` (16bpp RGB565) | `0x01` is not a format on any ST77xx part; `0x55`/`0x66`/`0x77` are 16/18/24-bit. It was **overwriting** a correct value `esp_panel` had already set from `ESP_PANEL_BOARD_LCD_COLOR_BITS`. |
| byte order | native little-endian | high byte first (`BOARD_PANEL_SWAP_BYTES 1`) | invisible to every instrument — see above |
| inversion | `0x21` in the init table | `invertColor(true)` **after** `tft.init()` | the table sends `0x21` **before** `0x11` (SLPOUT), **and sleep-out clears the inversion state** — so the table stated it correctly and never delivered it |

**That third row is the one to remember. An init sequence recovered from a binary preserves the
vendor's command ORDER as faithfully as its values, and the order can be the bug.** `0x21` sat in
the repo looking right for the entire port while doing nothing whatsoever, which is why the symptom
kept getting mis-attributed to the two axes that *were* visible in the diff.

**How it was actually resolved, after three failed guesses:** a labelled test pattern plus a runtime
toggle on each axis. Guessing from a colour name cost three reflashes; `COLORTEST` with `SWAP 0|1`
and `INV 0|1` settled it in one. **Reach for those first.** The decisive observation was
**WHITE rendering as BLACK** — no byte order and no channel permutation can produce it, only
inversion can, so that single patch separates the inversion axis from the other two. And the
clincher was the user reporting that *only the runtime* `INV 1` worked: identical setting, different
delivery, which is what pointed at SLPOUT.

Do **not** "fix" the inversion back to `0x20`/INVOFF. It was tried, on hardware: every colour came
back as its exact complement. This panel is natively inverted and requires INVON.

The signature is exact and worth memorising, because it identifies the fault and rules out its
neighbour: **blue `0x001F` byte-swaps to `0x1F00`, a dark GREEN**, and red `0xF800` to `0x00F8`, a
dark BLUE. A *byte swap* therefore rotates red→blue→green; **BGR element order** would swap red and
blue only and leave green alone. So the two are distinguishable from a single glance at three
patches.

**The general form, and it applies to any instrument this repo grows:** *an instrument that reads
the same buffer the renderer wrote proves the renderer self-consistent, not correct.* Every
"verified by SCREENSHOT" claim about board 2 carries that caveat. The only claims it does not cover
are the ones a person looked at.

**AND ON 2026-08-29 A PERSON LOOKED. `COLORTEST` was run on board 2 and all six patches matched
their labels** — the first time the caveat above has actually been discharged rather than restated.
That is not a small thing: this page's three-fault table was resolved by argument and by the
`SWAP`/`INV` toggles, and every capture taken since has been framebuffer evidence, so the panel's
colour pipeline had never been confirmed by eye end to end.

What the six patches certify, and therefore what is now known rather than believed: `COLMOD` is
`0x55` (16bpp RGB565), `BOARD_PANEL_SWAP_BYTES 1` is the right byte order, and the post-`SLPOUT`
`invertColor(true)` really is reaching the panel — that last one being the fault that sat in the
init table looking correct for the entire port while doing nothing, because sleep-out clears the
inversion state. WHITE and BLACK matching rules out inversion, which nothing else can produce; RED,
GREEN and BLUE all matching rules out both a byte swap (which rotates red->blue->green) and a BGR
element order (which trades red and blue and leaves green alone).

**This does not make every board-2 screenshot in this file trustworthy about colour.** It certifies
the PIPELINE at one moment, with the header's settings as they are today. A future change to any of
those three axes re-opens the question, and the answer is the same one command — which is the whole
reason `COLORTEST` exists rather than a reasoning chain.

**`COLORTEST` is the instrument that can see it** (board-2-only, via the command-trigger file). Six
patches, each **labelled in black with the colour it is supposed to be**, so the check is one glance
and the answer is one word: if the patch under `RED` is not red, one of the three axes above
disagrees with the board header. Pair it with `SWAP 0|1` and `INV 0|1`, which flip the byte order
and the inversion at runtime — four combinations reachable in seconds, where settling them by
reflashing costs one build per guess. Neither is persisted on purpose: the answer belongs in the
board header once someone has SEEN it, not in NVS where it would silently disagree with the header
the next reader trusts. Red/green/blue carry the rotation above; **white and black are the
control**, invariant under both faults. It is guarded to board 2 because the question cannot arise
without a framebuffer, `palette-check.mjs` already covers board 1 offline, and compiling it on
board 1 cost 692 bytes and broke the byte-identity this port held through every task.

**The byte-order half of the fix swaps in `flush()`'s strip copy, NOT in storage**, and that
placement is the design.
Native order in the framebuffer is what lets blending, the AA coverage arithmetic and `readRect`
all work in ordinary RGB565 with no unswapping anywhere — the panel's byte order stays confined to
one loop. Cost: a per-pixel loop instead of a `memcpy`, on the flush path only.
`BOARD_PANEL_SWAP_BYTES` is declared in **both** headers so the two boards answer the same
question, and flipping it is the whole fix if a future panel disagrees.

Postscript: the demo project this port's panel bring-up came from pushes its buffer with the same
call and the same native-order macro, and its own notes claim only that "bars/ramp/grid **render**"
— a rendering claim, not a colour one. It very likely had this bug too and nobody looked.

#### `readRect` also byte-swaps, and that cost three rounds of a phantom bug

`readRect()` returns pixels **byte-swapped** and `readPixel()` does not — already documented under
the screenshot note, and it *still* misled this port: `0x1084` read back against an intended
`0x8410` was called a mismatch when they are the same value. It was part of a three-round
investigation into a "REC button that only appears on the USAGE tab", which was **not a bug at
all**: the device had blanked its backlight (the `SLEEP AFTER` soft state) and `fabVisible()`
correctly withholds the button while asleep, so the SESSIONS and SETTINGS captures had simply
caught a blanked device. Board 1 behaves identically. Recorded because the evidence looked like a
tab-specific rendering fault for three rounds.

#### `textWidth` equivalence is a GATE, and `TEXTPROBE` is how it is proven

Every re-derived layout constant on board 2 rests on the shim measuring text **exactly** as
TFT_eSPI does. `TEXTPROBE` (both boards) prints one `WIDTH <font> <size> <width> "<string>"` line
per entry per font; board 1 runs real TFT_eSPI, so **its output is the reference and the check is a
diff, not a judgement**. The table and the exact procedure live in `text_probe.h`; board 2's half
is committed as `firmware/deckhand_display/text-widths-board2.txt`, so the comparison is one
command.

**THE CROSS-BOARD DIFF STOPPED BEING A VALID GATE WHEN THE TYPE SCALE LANDED, AND NOBODY
NOTICED FOR SIX DAYS.** The paragraph above describes the gate as designed; it has not been
runnable since 2026-08-23. Two independent breakages, the second silent:

- **The two boards no longer draw the same faces.** `UI_FONTS[]` is per board — board 1 is
  Cozette 6x13 / Terminus 10x18b, board 2 is Spleen 8x16/12x24/32x64 — so different widths are
  the CORRECT output and a diff yields 136 meaningless differences. Measured: font 1 on
  `"Mac  studio  120s ago"` is **126 on board 1 (6px/char) and 168 on board 2 (8px/char)**.
- **On Spleen the last-character rule is a NO-OP**, so the eleven strings appended specifically
  to give the gate teeth discriminate nothing on board 2. Every Spleen glyph in `0x20..0x7E` has
  `xOffset == 0` and `width == xAdvance == 8`; verified by capture — all 136 widths equal a pure
  `advance * length`. **A shim with the last-character rule wrong would pass board 2's half
  unnoticed**, which is the precise failure those strings were added to prevent.

**`text-widths-board2.txt` was also STALE, and that is the smaller half of the problem.** It was
committed 2026-08-22, one day before Spleen landed on board 2, so it recorded Cozette widths for a
board that had stopped drawing Cozette. It has been refreshed against the shipped registry; the
capture needs **~20s**, not the 4 the old procedure said, because 136 entries go out over both
transports.

**What still substitutes**, and it is unchanged: two independent derivations agreeing byte-for-byte
across all 136 entries (the shim's, and a re-derivation from the raw glyph tables against
`TFT_eSPI.cpp:3120-3125`). That is stronger than a hardware diff for catching an arithmetic error;
the residual risk it does not cover is that TFT_eSPI's *runtime* behaviour differs from its source.

**What would actually close the gate:** build board 2 against **Cozette** temporarily — the header
is already vendored for board 1 — then run `TEXTPROBE` on both boards and diff. Same face on both
sides makes the comparison mean something again, and Cozette's 20 divergent glyphs make the
last-character rule bite. Needs board 1 physically attached plus one throwaway board-2 build. Not
done.

**The rule the gate exists to catch:** TFT_eSPI charges the last character `xOffset + width`, not
`xAdvance`, and those differ for **20 of Cozette's 95 glyphs** (0 of Terminus's). The original probe
table's strings all ended on one of the 75 glyphs where the two agree, so every expected width was a clean multiple of 6 and
**a wrong shim would have passed the very gate that exists to catch it**. Eleven strings ending on
a divergent glyph were appended for exactly that reason — `textWidth("|") == 4`, `("4") == 7`,
`("ALL ") == 25`. If you extend that table, end at least one string on a divergent glyph.

#### Four bring-up traps, all inherited from the demo project, all of which fail silently

1. **The panel needs `esp_panel_board_custom_conf.h` AND a vendor init sequence, and without them
   the screen is simply dead.** The unit shipped with firmware built without that conf file, so
   `ESP32_Display_Panel`'s `esp_panel_board.cpp:init()` aborted with **"No default board
   configuration detected"** and neither the panel nor the backlight was ever driven — which is
   the entire reason the screen appeared broken out of the box. Separately, the library's *default*
   ST77922 init does not bring this panel up; `st77922_init_cmds.h` is the vendor sequence that
   does. Get either wrong and you get a **black screen where every call succeeds**, because a QSPI
   write into a panel that never came up returns fine. Treat both files as **artefacts, not code to
   tidy**. Touch is deliberately `0` in that conf: the ST77922 has its touch controller inside the
   display IC (I2C 0x55) and the library has no driver for it, so `st77922_touch.cpp` owns it.
2. **32-line strips** and **3. `drawBitmap(..., timeout_ms = -1)`** — both covered above; both fail
   as an allocation failure or a DMA race rather than as anything naming the panel.
4. **Legacy `driver/i2c.h` ONLY, never `Wire`.** Linking both **aborts in a global constructor
   before `main()`**, and the board then boot-loops with **zero serial output at any baud** while
   `esptool` still answers happily — indistinguishable from bricked firmware. `st77922_touch.cpp`
   is verbatim from the demo *plus* a `CONFIG_IDF_TARGET_ESP32S3` translation-unit guard, without
   which board 1 links the legacy i2c driver and inherits that same `abort()`ing constructor.
   Verified with `nm` on both real links: board 2 has legacy i2c symbols and **zero `TwoWire`**;
   board 1 has no I2C peripheral symbols at all.

#### Touch: one entry point, two very different controllers

`touch_hal.ino` is the seam. Three surfaces, not the one the plan assumed:
`getTouchPoint(int&, int&)`, **`touchPressed()`**, and a begin shim. Board 1's XPT2046 body and its
5-point affine calibration are unchanged behind `BOARD_TOUCH_NEEDS_CAL`; board 2's controller is
capacitive, inside the display IC, factory-aligned, and reports `chip_id=0x84`, `res=320x480`
(matching `BOARD_W`/`BOARD_H`), `max_points=5`.

**`touchPressed()` is backed by `read() >= 1`, NOT by the INT line, and that was measured because
guessing it would have re-created a previously-fixed bug.** The debounce sites poll at 10ms and
require **two consecutive** true reads, so the primitive must stay asserted for the whole contact.
Across four real taps: `read() >= 1` was true for **8-11 of 92 polls** while INT was low in **2, 0,
0 and 0** of those same polls — the INT line **pulses** rather than holding, so a two-consecutive
debounce on it would drop nearly every tap. That is exactly the 120ms-gate bug this repo already
documents fixing once.

The structural reason `read()` is safe needs no hold test: `REG_TOUCH_INFO` is a **state register
with no ack/clear and no FIFO anywhere in the driver**, so a held finger reads valid on every poll.
Cost is **1125µs** per call — acceptable at all five sites, with the numbers: `micStream`'s DMA
slack is 256ms against a 16ms iteration, and that loop already does a 300KB `flush()` every 120ms,
which dwarfs it. 30s idle produced zero reports, so no strength filter is needed.

#### There is NO touch wake from deep sleep on board 2, and auto-sleep is therefore DISABLED

A silicon fact, the same class as board 1's "there is no true power-off" — read out of the installed
SoC headers rather than assumed. `ext0` and `ext1` wake **only** from an RTC GPIO; the S3's RTC set
is GPIO0..21 (`SOC_RTCIO_PIN_COUNT 22` in `soc_caps.h`, and `rtc_io_channel.h` maps exactly
`RTCIO_CHANNEL_0..21`). `PIN_TOUCH_INT` is **47**, so neither can take it, and
`esp_deep_sleep_enable_gpio_wakeup()` **does not exist on this target** —
`SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP` is not defined in the S3's `soc_caps.h` at all. The one
RTC-capable pin a person can press is GPIO0, refused for the same reason board 1 refuses it: it is
the boot strap, so a wake with it held low lands the chip in the serial bootloader and the device
looks bricked.

So on board 2 deep sleep is exited by **RESET**, encoded as `BOARD_HAS_TOUCH_SLEEP_WAKE 0` with no
wake source armed, and every farewell screen says exactly that instead of promising a touch.

**The consequence: `AUTO_SLEEP_IDLE_MS` is disabled on board 2.** Auto-sleep's whole documented
purpose is saving battery on a device you will wake with a touch; remove the touch wake and it
becomes a device that turns *itself* permanently off after 20 idle minutes, and a status display
that has silently become a brick until someone walks over and presses RESET is worse than one that
never sleeps. **Manual POWER OFF stays** — that is an explicit choice behind a confirm dialog whose
existing job is to state the consequence. The backlight blank (`SLEEP AFTER`) is unaffected and
still recovers on a touch. If board 2's battery life turns out to matter, re-enabling is then a
deliberate trade with the RESET cost understood rather than a default nobody chose.

Related, and fixed here because it is board-2-only: **the farewell screens now `flush()` BEFORE
their `delay()`.** The 1200/1500ms dwell used to run before the flush, so on board 2 the goodbye
message existed in memory and appeared for zero frames while the *previous* screen sat there. This
defect exists only because the port introduced the deferred-flush model, which makes it ours rather
than pre-existing — which is why it was fixed while the eleven board-1 defects below were not.

#### NimBLE versus Bluedroid

Board 2 runs NimBLE (`BOARD_BLE_NIMBLE 1`); board 1 runs Bluedroid. The custom GATT service, the
Nordic-UART UUIDs, the advertised `Deckhand-XXXX` name, the per-Mac pairing keys and the answer
HMAC are all unchanged. **The one value that differs is the per-connection peer identity** — the
handle the RX demux keys each 20-byte chunk on when it frames it into the stream buffer as
`[conn_id][len16][bytes]`. Everything the multi-Mac section says about that demux still holds; only
where the handle comes from moved. Byte-identity on board 1 cost six builds here, and the winning
shape is load-bearing: **passing the callback POINTER into the extracted framing helper** (via a
`BleCbParam` typedef that also collapses every override to one definition) is what makes it a pure
move — a value variant costs +8 bytes, `bool` +16, a template +32, two call sites ±44. Those
numbers are in the code comments so nobody tidies it back.

**Connecting board 2 over BLE needed one OPERATIONAL step, and its absence looks exactly like a
fault.** `~/.claude/deckhand-secret` had `selected = "Deckhand-0528"` (board 1), so the host was
pinning its BLE scan to board 1's name and ignoring board 2 advertising right beside it. That is
the multi-pairing feature working precisely as designed, and it presents as a present, healthy
device being invisible. `SELECT Deckhand-C114` re-pointed it and the tick line went to
`via=usb,ble`. **When a board's BLE will not connect, check `selected` before the radio.**

#### Native USB, and what it buys

Board 2 has no CH340. It is native USB-Serial/JTAG, which removes the constraint that shapes half
of board 1's design:

- **`SCREENSHOT` is 0.4s on board 2 against ~18s on board 1** — 240x320x2 = 153,600 bytes of
  base64 through a CH340 capped at 11.5KB/s is what made board 1's capture an 18-second affair.
- There is **no CH340 auto-reset**, so board 2 does not have board 1's "opening a second serial
  connection reboots the ESP32" hazard. Use the command-trigger file anyway — the running host owns
  the port, and one mechanism for both boards is worth more than the exception.
- There is also **no DTR/RTS handshake to lean on**: enumeration proves nothing, and the recovery
  is a power cycle (see Commands).

#### What board 2 does NOT have: the MIC — and the beeper, which it now has

**`BOARD_HAS_MIC 1` and `BOARD_HAS_BEEPER 1`** — both paths now exist. **Those flags describe the
SOFTWARE, not the hardware** — this is the important distinction, and an earlier reading of it was wrong in both
directions. The hardware is real and confirmed: an **ES8311 I2S codec at I2C 0x18** (found by the
demo's own bus scan) with **MCLK 17 / BCLK 18 / DOUT 15 / LRCK 21 / DIN 16**, plus a speaker
amplifier enable on **GPIO1**. `DIN` is the capture path. So board 2 has a real mic *and* a real
speaker; what it does not have is a capture path in this firmware.

**The speaker is PROVEN to make sound, and `TONETEST` is what proves it** — it configures the
codec, dumps all 74 registers, and plays a tone at each level of the amp enable. Read the chain off
`vendor/schematic.pdf` before touching any of it, because none of it is GPIO-driven the way board
1's is: **U5 (ES8311) → `OUTP`/`OUTN` → R21/R22 4.7K → U6 (SC8002B class-D BTL amp, VDD from
+5) → `VO2`/`VO1` = `SP+`/`SP-` → JP3**, a 2-pin header (pin 2 = `SP+`, pin 1 = `SP-`). Board 1's
wiring has no counterpart here — its amp input IO26 is this module's `SPICS1` (the flash/PSRAM
bus) and its shutdown IO4 is this board's `SD_CMD` — so a speaker moved across from board 1 is on
pins that can never drive it. **JP1 is the BATTERY header and is also 2-pin**; only one of the two
makes a sound.

Four things this cost an afternoon to establish, all of which fail silently:

- **`DOUT 15`/`DIN 16` looks swapped against the schematic and is CORRECT.** The net names are from
  the CODEC's point of view: `I2S_DI` is U5 pin 9 `DSDIN`, the codec's *input*, which the ESP32 must
  drive — our DOUT — and it is on GPIO15. `I2S_DO` is U5 pin 7 `ASDOUT`, the codec's mic *output*,
  our DIN, on GPIO16. "Fixing" these to match the net names sends playback to a pin the codec never
  reads, with every register still perfect.
- **`PIN_AMP_EN` GATES NOTHING, measured rather than inferred.** A 2s tone at *each* level was
  audible. U6's `VDD` is +5 so its shutdown threshold sits near that rail, and a 3.3V GPIO high
  cannot reach it — the amp is permanently enabled. So **silence must come from
  `es8311_voice_mute()`, never from this pin**, and the amp's idle current and noise floor are
  always present (board 1's FM8002E is genuinely muted between beeps; this one cannot be). The pin
  is still driven to `AMP_EN_ENABLE_LEVEL` (LOW) so a revision that fixes the threshold plays sound
  instead of silence. Both prior claims were wrong: the demo's selftest comment
  (`digitalWrite(PIN_AMP_EN, HIGH); // enable the amplifier`) and the opposite LM4871 reading each
  predict one silent level, and neither is.
- **U6's `BYPASS` pin carries C41 = 1uF, so leaving shutdown is a HUNDREDS-of-ms ramp.** This is why
  the first `TONETEST` run was silent at both levels: a 30ms settle followed by 200ms beeps can land
  entirely inside the ramp. `TONE_SETTLE_MS` is 400 and the burst is one continuous 2000ms tone
  because of it — any future short burst has to clear the same ramp.
- **The demo project proves less about audio than it appears to.** Its selftest records
  `I2S audio | PASS | 76800/76800 bytes clocked out`, but it never configures the ES8311 at all —
  it just clocks bytes with the codec in its powered-down reset state — and its own `FINDINGS.md`
  says plainly that audibility "was not verified... The electrical path is proven; the transducer
  is not." Treat its audio PASS as an ESP32-side result only.

Espressif's `es8311_register_dump()` is vendored but deliberately **unused**: it writes to UART0's
pads rather than the USB CDC, so a healthy codec would read as a dead bus, and it `ESP_ERROR_CHECK`s
each read, so it aborts on exactly the failure it exists to report. `TONETEST` prints its own dump
over `Serial` instead.

**The BEEPER is implemented, the flag is 1, and it is CONFIRMED AUDIBLE ON HARDWARE** — the SOUND
toggle and the VOLUME stepper both beep, verified by ear at the LOW preset (codec volume 55,
~-25dB), which also confirms that rung is a real setting rather than a silent one. Note what the
verification is worth and what it is not: it proves the shared I2S path, the occupancy model and the
volume mapping on the glass, and it says nothing about the capture direction, which is still
unwritten. A beep here is synthesised samples pushed through
I2S into the ES8311 — board 1's `ledcWrite()` has no counterpart, so `startBeep()`/`updateBeep()`
have a second implementation rather than a ported one, selected on `BOARD_USES_TFT_ESPI` (the same
question: an LEDC square wave is not a thing you can send a codec). Three things about it are
load-bearing:

- **ONE shared I2S channel and codec, up in `setup()` via `audioOutBegin()` and never torn down.**
  Three callers need it — the beeper on every asking transition, `TONETEST` on demand, and the
  capture path a mic would use, which needs the *same* channel since the ES8311 records and plays
  over one peripheral. Tearing it down saves nothing: the amp cannot be gated, so its idle current
  is present regardless, and the idle state is `es8311_voice_mute()` — which is where silence
  actually comes from. `TONETEST` was refactored onto it because a **second `begin()` on the same
  port FAILS**, which would have made it a diagnostic reporting a fault it caused itself; it also
  must not delete the shared handle, or the beeper writes through a dangling pointer.
- **`updateBeep()` stays non-blocking through an OCCUPANCY MODEL.** `I2SClass::write()` blocks once
  the DMA is full and that class exposes no `availableForWrite()`, so feeding blindly stalls
  `loop()` for up to the buffer depth — **90ms**, from ESP_I2S's own `dma_desc_num=6` /
  `dma_frame_num=240`. `beepFedUntil` tracks how far ahead audio is queued and tops up only while
  that is under `BEEP_QUEUE_MAX_MS` (60), so every write lands in free space. The pattern's GAP step
  needs no writes at all, because the channel is configured `auto_clear=true`: an underrun emits
  silence rather than repeating the last buffer.
- **2100 Hz, where board 1 uses 2093 (C7).** The beep is a LOOPED buffer, so the frequency must fit
  a whole number of cycles in it or every loop boundary is a click — a 50Hz buzz over the beep. One
  buffer is 20ms at 16kHz, so any multiple of 50Hz works, and 2100 is the nearest to board 1's pitch
  at 42 cycles exactly (~6 cents sharp). LEDC needs no such constraint, having nothing to loop.

`VOL_PRESETS` therefore moved into the board headers as `VOL_PRESET_LIST`: board 1's are LEDC duty
out of 255, board 2's are **ES8311 volume out of 100**, and no literal could be right for both.
Board 2's `{55, 70, 85}` are ~13dB apart and all inside the range measured audible — **anything
under ~40 is inaudible on this hardware**, so board 1's "LOW" of 6 would be a silent setting.

**THE CAPTURE PATH EXISTS AND IS MEASURED.** The four entry points
(`micStream`/`micRecord`/`micMonitor`/`micLevelTest`) have THREE implementations behind one
signature each — board 1's ADC-DMA, board 2's codec path, and the `"no microphone on this board"`
stubs for a board with neither — split on `BOARD_USES_TFT_ESPI`, the same seam
`startBeep()`/`updateBeep()` use.

**Nothing here brings up I2S, and that is worth knowing before touching it.** `audioOutBegin()`
already did, and it enabled the **RX** channel as a side effect: `I2SClass::begin()` creates both
channels when `setPins()` was given both `dout` and `din`, which this board's was. So capture is
`readBytes()` on a channel live since boot, and a second `begin()` on that port **fails** rather
than helps — which is also why `TONETEST` had to move onto the shared context.

Measured on hardware, and these are the numbers a future reader should not have to re-derive:

| what | figure | what it settles |
|---|---|---|
| `MICTEST` | `n=180224 timeouts=0` | samples arrive; rules out dead RX / dead ADC |
| DC offset | `dcL=0` | correct for a digital path — see the verdict note below |
| slots | **L and R byte-identical** | the mono codec duplicates; capture takes ONE slot |
| ambient | `floor=69 peak=213..770 clipped=0` | a live floor with headroom |
| `MICREC` | `160000` samples, **100%** complete, 29.3 dB SNR | decodes to a playable WAV |
| `MICSTREAM` | **120.0s, 1921024 samples, `dropped=0 gaps=0`** | 3.8MB at 32KB/s, no loss |

- **`dcL=0` is why board 1's first verdict could not be reused.** On an analog ADC a dead signal
  wire reads as a pinned DC level; on I2S it reads as **perfect digital zero**, which no amount of
  gain will ever move. So `micLevelTest()`'s first check is "every sample is exactly zero", a
  condition board 1 has no counterpart for.
- **No codec at all.** 16000 x 2 bytes = **32KB/s**, comfortable on native USB CDC — where board 1's
  IMA ADPCM exists solely because 16kHz mu-law is 16KB/s against a CH340 that tops out at 11.5. That
  also removes the mu-law and ADPCM decode from Whisper's path rather than porting them.
- **MONO, left slot only**, because the two are byte-identical: half the bytes carry everything.
- **PSRAM for the buffers** — a 10s one-shot take is 320KB and the stream ring is 64KB, against
  board 1's ~3s ceiling and 16KB ring in contested internal heap.
- **`MIC_GAIN` is `ES8311_MIC_GAIN_30DB` and is NOT tuned.** The driver offers 0..42dB in 6dB steps.
  Ambient peaks at 213-770 of 32767 look low, but ambient is the wrong reference — speech sits far
  above a quiet room, and 42dB could clip a real voice. Settle it with `MICMON` while speaking, which
  is what that screen exists for; do not compute it.

**Three HOST defects fell out of running this, all the same shape** — code that was right by
accident while ADPCM was the only thing that had ever streamed, and all three fail in the direction
that produces confident nonsense rather than an error:

- **`finishAudioStream()` wrote every stream header as `bits=4 codec=ima4`** regardless of what the
  device announced, so a pcm16 stream was saved to disk CLAIMING to be ADPCM — `mic-wav.mjs` would
  then run the IMA predictor over linear PCM. That is exactly the loud-garbage-Whisper-narrates
  failure the 98% guard exists for, arriving through the file format instead of through truncation.
  It now reads `codec=` from the device's header; an unknown or absent codec keeps the ima4 numbers,
  so every pre-board-2 stream file is byte-identical.
- **The completeness estimate assumed ONE byte per sample**, true for mu-law and tighter for ADPCM.
  pcm16 is two, so a 10s capture reported **200%** — meaning a capture truncated by HALF would have
  read as a clean 100% and passed the refusal. It now reads `bits=` from the header.
- **`mic-wav.mjs` was broken outright**, pre-existing: `path.join` with no `import path`, on the line
  that runs whenever no outfile argument is given. It could only ever have worked when called with an
  explicit output path.

**The host needed NO new decode branch**, which the voice spec expected: `mic-wav.mjs`'s final
`else` already reads int16 little-endian and `bits` already defaults to 16.

**The RECORD BUTTON is hidden rather than shown dead.** `fabVisible()` returns false on
`!BOARD_HAS_MIC`, and gating it *there* rather than at the two draw sites is deliberate: it also
stops `fabHit()` claiming taps in that corner, and **drawn-but-dead and tappable-but-dead are two
different bugs**. This is the rule the read-only ask path already pays for, where the options are
drawn as a flat list under "ANSWER ON YOUR MAC" and taps are swallowed **specifically so the device
never offers a control that cannot work**. With the button hidden the tab bar reclaims its 40px slot
and the three tabs spread evenly rather than leaving an unexplained hole in the chrome. **Flipping
one flag turns it back on** when the path lands.

**SETTINGS › ACTIONS › MIC TEST WAS NEVER BROKEN, AND THE NOTE SAYING IT WAS OUTLIVED THE BUG BY A
WHOLE FEATURE.** This paragraph used to read "MIC TEST is NOT gated, and that is an open
inconsistency rather than a decision" — drawn, tappable, reaching `micMonitor()`'s stub, printing
one line to serial and painting nothing — and it pointed at an outstanding-items entry that was
never written. **It was true when it was written and stopped being true when the ES8311 capture
path landed**, which this same file documents as measured and working (`MICTEST n=180224
timeouts=0`, `MICREC` 100% complete at 29.3 dB SNR, a 120s stream with `dropped=0 gaps=0`). The
button has been fine since the moment `BOARD_HAS_MIC` flipped to 1; **what was stale was the note,
and nothing was fixed here** — the correction is to the prose. It is recorded rather than quietly
deleted for the same reason `docs/board-1-known-defects.md` keeps the one reported defect that
turned out not to be real: a described defect that does not exist costs the next reader either the
time to disprove it or a no-op "fix". Two paragraphs of this file are downstream of it and were
both wrong in the same way — `P2_MIC_Y`'s "three siblings" argument, and the claim that this was
listed below. On board 2 the button now sits on **SETTINGS › Sound** rather than Actions (see the
HOME subsection under Two boards); board 1 keeps it on Actions and its `P2_MIC_Y` chain unchanged.

Deliberately absent from board 2's header: `AUDIO_OUT_PIN`, `AUDIO_EN_PIN` and `MIC_ADC_PIN`. An
alias for a peripheral this board does not have is the "looks right and is wrong" failure the header
refuses — `PIN_AMP_EN` exists, but it gates an I2S codec, so pointing `AUDIO_OUT_PIN` at an I2S data
line would compile and lie.

**The mic path is the natural next piece of work, and it is a NEW DESIGN rather than a port**, which
is why it was not bolted onto the end of this one. Board 1's entire audio design is dictated by
constraints board 2 does not have: an analog MAX4466 into ADC-DMA, mu-law then IMA ADPCM, chunk+ACK
flow control and 33.3Hz BLE comb cancellation, all forced by a CH340 capped at 11.5KB/s and ~26KB
of free heap. Board 2 has a 16kHz/16-bit I2S codec, **8MB of PSRAM** and native USB CDC, so it can
stream **linear PCM with no codec at all** — which is also exactly what Whisper wants. That likely
removes the mu-law/ADPCM decode *and* the comb cancellation (the comb is BLE transmit current on a
rail an analog mic amp shares; a digital I2S path does not sample that rail). Everything it would
replace is under the mic and audio notes below.

#### Layout: re-derived for 320x480, never scaled — and `MAX_SESSIONS` stayed 6

**Board 2 has 2x board 1's pixels but is only ~16% wider and ~30% taller in MILLIMETRES.** Measured:
board 1 is 2.8" 240x320, so `sqrt(240²+320²)` = 400px over 71.12mm = **5.62 px/mm**; board 2 is 3.5"
320x480, so 576.9px over 88.9mm = **6.49 px/mm**. A 1.33x scale of board 1's numbers would make
every element **physically larger than it is on the smaller board** — Cozette 6x13 is
13/5.62 = **2.31mm** tall on board 1 and 13/6.49 = **2.00mm** here, and a 1.33x scale (17.3px, a
size Cozette does not have — it ships 6x13 and a mechanical 12x26 and nothing between) would make it
**2.67mm**.

**THAT ARGUMENT HELD FOR EIGHT TASKS AND THEN LOST, AND THE REASON IT LOST IS THE INTERESTING
PART.** "The faces stay put and the extra pixels become AIR and ROWS" was the rule for the whole
port, and it was correct about SCALING — a 1.33x scale really would have made everything
physically bigger than on the smaller board. But it quietly accepted the other half: at 6x13 board
2's body text is **2.00mm against board 1's 2.31mm**, i.e. a step SMALLER on the bigger screen, and
that is the same mistake in the other direction. Board 2 now has its own native type scale — Spleen
**8x16 / 12x24 / 32x64**, no rung a mechanical upscale of another — which puts body text at 2.47mm,
close to parity, while keeping a 32-character detail-card lane against board 1's 31 so the
existing character budgets carry over. The obvious next rung up, 12x24, is 3.70mm and only 21 columns: a
third of every card's text spent on making it bigger than board 1's. Full arithmetic under
**The type scale is three rungs** below. Everything else about the method is unchanged: air and
rows still absorb the surplus, the faces just are not board 1's any more.

That method reproduces board 1's own commented values as a check rather than asserting itself:
board 1's `TAP_MIN` 40 is 40/5.62 = **7.11mm**, matching that header's own `// 7.1mm`; the same
7.11mm at board 2's 6.49 px/mm is 46.1 → **`TAP_MIN` 46**, and `TAB_BAR_H` 46 follows with no
code change because `drawTabBar` already derives its label centre, underline and REC slot from it.

**`CARD_HERO_SIZE` USED TO BE THE ONE DECLARED EXCEPTION HERE, AND IT NO LONGER EXISTS ON BOARD
2.** It went x3 → x4 for exactly the reason above — at x3 the hero percentage would have been
39/6.49 = 6.0mm against 39/5.62 = 6.9mm on board 1, the one number whose entire job is being
readable across a room *shrinking* on the bigger screen. With a native registry there is no scale
factor left to name: board 2's `T_HERO` is Spleen 32x64 at size 1, 9.86mm, and the constant is gone
from `board_es3c35p.h` rather than set to 1. Board 1 keeps it, because its hero really is a
mechanical x3 of a 6x13 face. That the exception could be deleted rather than re-tuned is the
clearest single argument for the native scale.

**The headline win is the sessions ladder**, and `sessions-geom-check.mjs` prints both boards' so
you never have to take this on trust:

```
ladder  avail 264: 1:90t  2:90t  3:86t  4:63n  5:50c  6:41c     <- board 1
ladder  avail 410: 1:100t 2:100t 3:100t 4:100t 5:79s  6:65n    <- board 2
```

(`t` = the row gets its title, `s` = model/branch sub-line, `n` = name and pill only, `c` =
compact.) `constrain((avail - SESSION_AIR*(n-1)) / n, SESSION_ROW_H_MIN, cap)` is the whole rule.
So on board 2 **four sessions keep their titles** where board 1 loses them at four, the fifth keeps
its model/branch line where board 1 goes compact, and **`c` rows are unreachable at any count** —
the minimum raw rung across n=1..6 is 63, well clear of the 43 floor.

`SESSION_AIR 3` is an **upper bound forced by the ladder**, not a taste call: at 4, `TITLE_MIN_H`
becomes 105 against the 4-session row's 100 **and** `SUB_MIN_H` becomes 82 against the 5-session
row's 80, losing both wins at once. (1-3 all preserve the ladder, so 3 is a bound rather than a
unique solution.) The identities it produces are real derivations, not curve-fitting:
`SESSION_TITLE_MIN_H = 85 + 5*AIR` (100), `SESSION_SUB_MIN_H = 70 + 3*AIR` (79),
`SESSION_LARGE_MIN_H = 56 + 2*AIR` (62). The five gaps behind the 85 are top pad, name→title,
title→sub, sub→pill and bottom pad, and every derived offset **collapses to board 1's literal at
`AIR 0`** — which is the check that says this is the same layout with air in it, not a new one.

**THE LONE EXPANDED CARD IS TOP-ALIGNED, AND THAT REVERSES A DELIBERATE DECISION RECORDED HERE.**
`sessionRowYAt()` used to special-case `sessionCount == 1` and centre the card in the list area.
The argument for centring was real and is kept so nobody re-derives it as if it were new: one 212px
card in a 410px list leaves **198px — 48% of the tab — hanging below it**, which reads as "a card,
then nothing" however much content the card itself carries, and centring cost no constant and no
height. **The user looked at the device and asked for top alignment instead**, so the special case
is deleted rather than special-cased back — `SESSION_ROW_Y0` is what every other row count already
falls through to. Verified on board 2's glass: the card's border sits at y=50 = `SESSION_ROW_Y0`,
4px under the tab bar. (`SCREENSHOT` reads board 2's shadow framebuffer, so that capture vouches for
the GEOMETRY the renderer computed, not for the panel — see the verification trap under Two boards.
Position is exactly the kind of claim a framebuffer read can settle; colour is not.)
**The trailing gap is the accepted cost, and it is now BIGGER than the 198px the old comment
named**, because the card's height is content-derived (`sessionExpandedH`): a session with no title
and no prompt leaves roughly 140 rows blank *inside* the card as well as whatever is left below it.
If this is ever re-centred, it should be because someone looked again and chose that — not because
the centring argument was rediscovered without noticing it had already been overridden once.

**`MAX_SESSIONS` stayed 6, and raising it is a PROTOCOL change, not a screen change.** The device's
6 is matched by the host's own `records.slice(0, 6)` and by `sessionsTotal`/`hiddenAsking`, which
exist to tell the device what was cut. Raising the device's constant alone changes nothing; raising
both costs ~2.2KB of DRAM per row on a board where the framebuffer already owns 300KB of PSRAM and
`SessionInfo`'s `askDetail[1424]` is the thing that shrank `prevSessions` in the first place. It is
a coordinated host+device change with a RAM budget attached, so it is not something a bigger screen
gets for free.

**A WIDER CARD DOES NOT COST A KEYBOARD LINE, AND THIS FILE CLAIMED IT DID.** The claim rested on
`KB_COLS = floor((CARD_W - 12) / 6)` = 47 on board 2 and therefore `ceil(150 / 47)` = 4 lines. The
6 is **Cozette's** advance, and board 2 draws Spleen 8x16: the real derivation is
`(CARD_W - 12) / TEXT_ADV` = `(296 - 12) / 8` = 35.5 -> **35 columns**, so `ceil(150 / 35)` = **5
lines**, the same as board 1's 34 and 5. 35 is the exact maximum and it is *measured*, not divided:
every Spleen glyph advances 8 with `xOffset + width == xAdvance`, so the widest 35-column line inks
34x8 + 8 = 280px in the 284px lane with 4px to spare for any string, where 36 would need 288.
Board 1's own 34 is 1px hot by the same rule (`max(xOffset + width)` in Cozette6x13 is 7 for space,
`4` and `q`, so 33x6 + 7 = 205 against a 204px lane) - harmless, since the ink still stops 3px
inside the card.
**What 47 actually did on the glass, because the hard wrap MEASURES NOTHING:** it slices `KB_COLS`
bytes and draws them, so 47 columns painted 47x8 = 376px of text from x=18 across a 320px panel -
the tail of every long line ran off the screen - and the 4-line budget under it meant a 150-byte
answer could put text where the card does not reach at all. Nothing errored on either count. That
is the whole case for `TEXT_ADV` being a named per-board constant.

**The history reader's budget had to cross the WIRE, and this was a real functional gap the port
would otherwise have shipped.** `host/index.mjs` hardcoded `HIST_LINE_CHARS = 36` /
`HIST_PAGE_LINES` to board 1's 216px column, so board 2's re-derived **18-line/37-column** reader
could **never fill** — 16 rows of ≤36 characters into a screen with room for 18 of 37, with nothing
on either side reporting an error. (Those two figures read 23x49 for most of the port, which was the
same lane divided by Cozette's 6px advance and stepped at its 13px cell; board 2 draws Spleen 8x16,
and the wrong pair was what the device was *reporting to the Mac*.) Fixed by having the **device state its budget** as a `<cols>x<lines>`
token on the `HISTORY` request, with the host defaulting to 36/16 when the fields are absent. That
default **is** board 1's existing behaviour, so an un-upgraded device keeps working and no protocol
version bump was needed — the same backward-compatibility shape as the trailing `to=<hostId>`
address. Out-of-range values fall back to the default rather than being trusted.

**A `SHOT` stack smash, and the class of bug it represents.** Three buffers in the screenshot path
were hardcoded to board 1's row — `char line[660]`, `static uint16_t rowBuf[240]`, `static uint8_t
rowBytes[480]`. A 320px row is 640 bytes = 856 base64 characters, so the stack buffer overran by
**197 bytes** and the two statics by 320 and 160 bytes into adjacent `.bss`. **The symptom was a
silent hang**: `SHOT begin` logged, then nothing — no rows, no `SHOT end`, and not even
`finishShot()`'s own "incomplete" warning, because the frame that would have called it was already
destroyed. All three are now sized from `BOARD_W`, which is 240 on board 1 so nothing moved there.
**Any buffer sized to a panel dimension must be sized from `BOARD_W`/`BOARD_H`**, and a smashed
reporting path is why this one presented as a hang rather than as corruption.

#### SETTINGS on board 2: a HOME screen and five groups, where board 1 keeps its chevron pager

Board 1 is unchanged: four pages behind a prev/next pager. Board 2 opens SETTINGS on **HOME** —
five cards, one per group (Status, Display, Sound, Pairing, Actions), each carrying the group's
name, a **live summary of what is inside it**, and a plain ASCII `>` (Spleen declares
`0x20..0x7E`, so a real chevron glyph would draw as nothing at all — the trap this repo has now
paid for four times). Tapping a row opens that group and the pager band becomes a **back band**.
The guard is `BOARD_SETTINGS_HOME`, 1 in `board_es3c35p.h` and 0 in `board_e32r28t.h`.

**THE BAND KEEPS THE PAGER'S HEIGHT, AND THAT IS WHY THIS WAS AFFORDABLE AT ALL.** `PAGE_TOP` is
`CONTENT_Y + PAGER_H + 4` = **104 on both boards and did not move**, so every group body starts
exactly where a page body already started and **not one existing derivation had to be re-done** —
the four page bodies drop in under the new band unchanged, and the group work that followed was
about what those pages CONTAIN rather than about where they begin. The back key is the pager's own
`PAGER_BTN_W`, so the two boards' chrome stays one size; unlike the pager there is nothing else in
the band, so the WHOLE band is the back target and there is no 45/55 split to leave a dead zone in.
HOME itself has no band — the tab bar already says SETTINGS and a second title would be chrome
repeating itself — so its five rows own the whole content area, pitched to land exactly on
`contentBottom()`: `HOME_Y0 + 5*HOME_ROW_H + 4*HOME_GAP + HOME_Y0_BOT` = 54 + 350 + 48 + 8 = 460.
The checker asserts that IDENTITY rather than the number, which is what makes a row-height change
fail here instead of silently eating the bottom row.

**`settingsPage` CARRIES HOME RATHER THAN A SECOND STATE VARIABLE.** `SET_HOME` is 0 and the five
groups are 1..5, so one integer says which screen is up. Two variables tracking one screen is how a
UI comes to draw one page while hit-testing another — and this tab already has the ingredients for
that failure, since `handleSettingsTouch` dispatches on the same value `drawSettingsStatic` draws
from. It also makes the six ids an ordinal RANGE rather than a set of names, which three places
depend on and all three fail SILENTLY: `drawSettingsHomeStatic()` and the HOME hit test both walk
`SET_STATUS + i` for `i < SET_GROUP_COUNT`; `openSettingsGroup()` clamps with
`constrain(g, SET_STATUS, SET_ACTIONS)`; and **`int settingsPage = 0;` is SHARED with board 1**, so
the device boots into whichever id happens to be zero. `settingsGroupTitle()` names four cases and
returns `"Actions"` from its `default`, so an id that drifts out of the run does not error — it
draws a row labelled Actions that opens something else.

**THE TAP COST: up to three chevron presses became exactly one, and ZERO for the questions HOME's
summaries already answer.** Reaching PAIRED MACS from STATUS was three `>` presses with no way to
skip; every group is now one tap from HOME. The summaries are composed each tick from the same
globals the group's own page draws from — nothing is stored, so they cannot disagree with the page
you open — and they carry the things people actually come to SETTINGS to check: `Both links up
84% 46 C`, `90% sleep 30s AUTO`, `ON volume MED mic`, `2 Macs any may answer`. Status's summary
is the one that changes colour, and **the phrase says which state it is on its own** ("Both links
up" / "One link up" / "No link"), so the colour supports the words rather than carrying them.
**The honest cost is the adjacent case:** moving between two groups is back-then-in, two taps,
where the pager moved to a neighbouring page in one. That is the trade — a flat list of four pages
you page THROUGH, against a menu you address DIRECTLY — and it was taken knowingly.

**Two things MOVED between groups, and both were DUPLICATION rather than taste.** The per-Mac rows
left Status for Pairing, where the Macs already were: `DROW_MAC0`/`DROW_MAC1` were spending 48 of
the old DEVICE card's 200 rows re-stating, in a different format, a list the Pairing page draws in
full — and that duplication is what made Status the one settings page with no slack.
`renderMacLinkRows()` is board 1's alone now. And **MIC TEST left Actions for Sound**, because a
mic test is a sound test and it is the one action you run repeatedly rather than once; that is what
took Actions to three buttons and left room for its two captions and the air between them. So
`P2_MIC_Y` does not exist on board 2 at all — the checker asserts its ABSENCE rather than merely
not reading it, because a constant a draw site no longer uses but a hit test still does is exactly
how a page comes to claim taps for a button it does not draw.

**THE SEVERITY SPINE ON ACTIONS, and it exists because that page was breaking this file's own
rule.** All four action buttons were `uiButton(..., filled = false)` — identically shaped outlined
slabs differing only in STROKE HUE — on a device where session status gets a filled square, a
hollow ring and a distinct mark, and where `palette-check.mjs` tests the palette for greyscale and
colour-blind separability precisely so that meaning is never carried by colour alone. The action
buttons, which are the only controls on the device that destroy state, had never had that
treatment. A solid `P2_SPINE_W` (4px) bar down the left edge of each destructive button carries
severity as **ink mass**; the two captions ("SETUP", "CANNOT BE UNDONE") and the wider
`P2_SECTION_GAP` between the sections carry it as **position**; colour is then the third cue rather
than the only one. What keeps the bar off the button's corner arcs is its Y-INSET, not its width —
it runs from `R_MD` to `P2_BTN_H - R_MD`, so no width could reach an arc. **The greyscale claim is
ARGUED, not measured:** `palette-check.mjs` can test a colour pair and there is no instrument in
this repo that tests a SHAPE, and nothing in this branch has been on the glass.

**A COMMENT IS NOT PARSED, so a flag that flips under it leaves prose describing a page that no
longer compiles.** `board_es3c35p.h:1689` opened "THREE buttons, not four: `BOARD_HAS_MIC` is 0
here, so there is no MIC TEST and no slot reserved for one", and **line 18 of the same header
says `#define BOARD_HAS_MIC 1`**. The whole arithmetic chain went with the premise: `3 * 50 +
2 * 12 = 174`, the hint at 302, 148px clear below it — against a real four-button page whose hint
sat at 364 with 86px clear. Nothing could have caught it: every checker in this repo parses
`const int` declarations and macros, and a comment is neither. It is worse than a wrong number,
because it is the paragraph a reader consults BEFORE the constants, and its arithmetic was
internally consistent — the sort of wrong that survives review. The sharpest part is that an
earlier revision of that same paragraph had ALREADY been corrected once, for copying board 1's
four-button chain onto a three-button page; the flag then flipped and drifted it back, in the
opposite direction. Fixed in the first commit of this branch — and then made moot by the redesign,
which took the page to three buttons for a different reason entirely.

**Five findings from the four reviews, kept because each names a CLASS rather than an instance:**

- **THE SPINE'S ASSERTIONS CONSTRAINED CONSTANTS WHILE THEIR COMMENT CLAIMED THEY CONSTRAINED THE
  DRAW CALL.** `settings.ino` said "settings-geom-check.mjs asserts both bounds"; the reviewer did
  not argue it, they rewrote the draw site to `uiFillRound(CARD_X, y, P2_SPINE_W, P2_BTN_H, ...)` —
  spine flush to the card edge, full height, crossing both corner arcs and painting over the very
  stroke it exists to reinforce — and the checker reported **ZERO failures**. The exact defect the
  assertion was written to prevent, surviving it. Same family as "a text-matching test cannot watch
  the preprocessor delete the line it just found" (`panel_shim.cpp`'s `invertColor` re-apply). Fixed
  by PARSING `drawSeverityAction()`'s own `uiFillRound(...)` arguments out of `settings.ino`,
  brace-balanced with comments stripped, and resolving each token through an `evalInt` now EXPORTED
  from `geom-common.mjs` rather than copied — the precedent `sessions-geom-check.mjs` already set
  for the TYPE chip's hit test. The mutation now fails three assertions by name.
- **TWO VACUOUS ASSERTIONS, both the same shape: a derivation asserted against its own term.**
  `PS_SOUND_Y - PS_ALERTS_Y === SET_CAP_STEP` compared a value DERIVED as `... + SET_CAP_STEP`
  against `SET_CAP_STEP`, so it held by construction — `SET_CAP_STEP` 24 → 26 produced zero
  failures. And `floor(w/2)*2 <= w` is true for every non-negative integer. **The test is not "does
  the assertion pass" but "can it FAIL"**, and a derivation compared with its own term never can.
  Both were replaced with the constraint they were standing in for (a caption's own text box must
  clear the control it heads; a rounded end radius must fit the DRAWN bar).
- **A TRANSCRIBED CONSTANT CERTIFIED A DESTRUCTIVE CONTROL AGAINST THE OTHER BOARD'S FINGERTIP
  FLOOR.** `P3_X_W` — the "forget this Mac" hit zone — was asserted `>= 40` inside an `if (b === 2)`
  block, on the line directly after one that correctly used `c.TAP_MIN`. 40 is **board 1's**
  `TAP_MIN`; board 2's is 46, so the zone was 6px under this board's own floor while its header
  comment claimed ">= a fingertip". The number being small was not the defect — transcribing was;
  a parsed assertion would have been right on both boards without anyone noticing the difference.
- **BOARD-1 SAFETY WAS PROVEN BY DIFFING BOARD 1'S VIEW, which is stronger than the hash.** Two
  revisions of both shared `.ino` files were preprocessed at board 1's real macro values and
  diffed: byte-identical once `//` comments are stripped, at every task. That says WHY nothing
  moved rather than only that nothing did, and it would catch a re-indent of board 1's arm that
  happened to compile to the same bytes today. Two traps in doing it: **`unifdef` SILENTLY NO-OPS
  with multiple `-D` flags** (exit 0 means "output identical to input", so it reports success having
  done nothing), and **resolving `BOARD_SETTINGS_HOME` alone is not enough** — the
  `#if !BOARD_USES_TFT_ESPI` arms survive and produce a FALSE 138-line diff. All eight macros
  appearing in conditionals in those files have to be resolved. The sanity check that a resolver is
  not vacuous is that it DELETES code: `settings.ino` goes 1500 → 710 lines.
- **`geom-common.mjs`'s `consts()` regex is LINE-ORIENTED, so a `const int` split across two lines
  parses as nothing** and every constant in it comes back `undefined`. An assertion on an undefined
  constant does not fail loudly — it computes `NaN` and passes or fails meaninglessly. The task
  brief's own code was formatted that way, so six page ids would have been unparsed; caught by the
  implementer, re-verified by the reviewer across both board headers and `deckhand_display.ino`
  (no other multi-line declarations exist, so this is not a pre-existing hole). The parser is
  line-oriented and nothing announces when it silently skips a declaration.

**GUARDS, and the one gap this branch created for itself.** `settings-geom-check.mjs` went 990 →
1686 lines and prints **548 assertions** across both boards; `--selftest` now injects **two** faults
and exits 0 only when EACH is caught by the assertion that exists for it, matched by message rather
than counted — with two faults in flight a bare total cannot tell "both caught" from "one caught
twice". The second injection is `HOME_ROW_H + 1`, the smallest change there is: HOME's rows are
pitched to land exactly on `contentBottom()`, so one extra row of card height puts the fifth row 5px
under the footer while every individual row is still inside its own card and still a touch target —
nothing measuring ONE row can see it, which is the point of asserting the identity.
Two gaps the sweep found and this task closed, both in constants the branch itself had added or
moved. **`P2_HINT_Y` lost its ±16 guard as a CONSEQUENCE of levelling**: it is the last thing on the
Actions page, so unlike every other block it is pinned from one side only, and taking `P2_TOP`
16 → 12 gave the page 8 more rows of trailing air and widened its `above < below` slack from 32 to
40. It is pinned now by the STEP a `T_META` label takes from the control it is bound to —
`SET_CAP_STEP`, which is that step everywhere else in this redesign — and asserted against
`SET_CAP_STEP` rather than against `P2_HINT_GAP`, which is how `P2_HINT_Y` is derived one file over:
routing through the other constant is what makes it able to fail, and it guards `P2_HINT_GAP` for
free. (The datums differ, so it is a step-for-step equality and NOT an equal air gap — the caption's
ink stops 8 rows above the button it heads, the hint's starts 18 rows below the one it explains.
Stated at the assertion, because a reader who wants the INK equal has to move `P2_HINT_GAP` and
re-derive.) And **the six page ids plus `SET_GROUP_COUNT` were read by no checker at all** — not
geometry, which is exactly why they were missed, but load-bearing in the three silent ways above.
All nine now fail by name at ±1 in both directions.

**COST, MEASURED.** Board 2 **+1,856 bytes of flash and +296 RAM** across the whole branch
(992,122 / 65,604 → 993,978 / 65,900). **Board 1 is `UNCHANGED` at every commit** —
`0cc2e77b66fb6947...`, size 1,387,200 — which is the only reason the scoping is what it is: every
shared-code change is an `#if BOARD_SETTINGS_HOME` around text board 1 never sees.

**WHAT IS NOT VERIFIED, stated plainly. NOTHING IN THIS BRANCH HAS BEEN ON THE GLASS** — no device
was attached for any of the five tasks. The evidence is the three geometry checkers, the sweep, the
committed pixel-accurate mock (`docs/design/settings-redesign/`, `node check.mjs` = 50 checks), and
board 1's baseline; all of it is arithmetic and bitmaps, which is the right instrument for layout
and the wrong one for colour. **`SCREENSHOT` could not settle colour here even with a device
attached**, because on board 2 it reads the shadow framebuffer (see the verification trap under Two
boards); `COLORTEST` is the instrument, and the severity spine's greyscale claim needs a person
rather than either. Also unverified by execution: every touch path on HOME and in the five groups,
since the device deliberately has no remote tap.

#### Board 2's battery divider is CONFIRMED by measurement

`BOARD_BAT_MV_SCALE 2`. The LCDWIKI table for this board gives no ratio and the vendor self-test
assumes x2 as well, so this was a documented guess — and a wrong ratio makes every percentage and
the whole time-remaining estimator wrong while looking perfectly plausible. **Settled by
measurement, not argument:** the device reported `mv=3910..3929`, `pct=63..66`. A single-cell
Li-ion at 3.92V really does sit around 60-70%, and a wrong ratio would have read ~1.96V or ~7.8V —
both obviously absurd. `left=-1 span=0` alongside it is correct behaviour, not a fault: the trend
estimator needs a 20-minute window before it states anything.

#### SoC die temperature and time-to-full: BOTH are board 2 only, and each measures LESS than its name suggests

Two readings were added to board 2's **SETTINGS › STATUS** card, plus a `TEMP` command. The
arithmetic is covered by `batt-trend-check.py` (16 new assertions) and the layout by
`settings-geom-check.mjs`; **board 1's binary is byte-identical throughout**, verified with
`board-baseline.mjs --check 1`, which is the only reason the scoping below is what it is.

**THE DIE SENSOR CANNOT SEE WHAT YOUR HAND FEELS, AND THAT IS THE WHOLE CAVEAT.** The S3's sensor
is inside the package, so it reports how hot the SoC is. It cannot see the charger IC or the cell —
which are exactly what warms the case while charging. So a comfortable number here is **not**
evidence the device is cool, only that the S3 is. This is the same shape as the `SCREENSHOT`
verification trap one layer down: an instrument that measures the thing it can reach, not the thing
you asked about. The row is labelled **`SoC temp`**, never `Temp`, and the `TEMP` line says `die=`,
because the label is the only place a reader learns which temperature this is.
Measured on hardware: **46.6°C while charging with the backlight blanked**, mv=4037.

**The driver is REAL here, and checking that first is the lesson `esp_pm` already taught.**
`temperature_sensor_install` is **522 bytes** in the archive board 2 actually links (`_get_celsius`
322, `_enable` 119), against `esp_pm_configure`'s three-instruction stub. A function that links,
compiles and does nothing reads as the idea being wrong rather than absent. Board 1 is excluded
because the capability is: the plain ESP32 has no usable internal sensor, so the whole path sits
behind the `BOARD_USES_TFT_ESPI` seam and board 1 never links it.

**TIME-TO-FULL IS A FLOOR, NOT AN ESTIMATE, BECAUSE OF THE CV KNEE.** A Li-ion cell charges CC then
CV: below the knee the charger holds CURRENT and the voltage climbs steadily, and above it the
charger holds VOLTAGE and tapers the current instead. **This board has no current sense**, so in
the CV phase the one quantity still moving is the one thing that cannot be measured — and no window
length fixes that. Measured, from 76 minutes of a real charge: **3893 → 4018 mV at +90 mV/h, RMS
residual 3.5 mV, max 8.5** — dead straight, so a least-squares fit is sound *in the CC phase*.

So there are **two distinct refusals**, and collapsing them would invite waiting for a number that
is never coming:

| code | wire | meaning |
|---|---|---|
| `BATT_CHG_NOT_YET` | `chg=-1` | window too short or too flat — keep watching |
| `BATT_CHG_TOPPING` | `chg=-2` | above `BATT_CHG_KNEE_MV` — structurally unmeasurable, says `topping up` |

The knee is tested **before** the data gates, deliberately: above it the refusal is structural, so
reporting "not yet" would promise that a longer window eventually produces an answer.

**THE FIRST FIT LIES ON THE CHARGING SIDE TOO, AND IT BROKE THE `>=` CONTRACT.** Found by
cross-checking the on-glass number against an independent fit of the same `BATT` series — the
device said `>=54m` and the truth was ~65. Plugging in makes the cell voltage snap up **+64 mV in
SECONDS** (measured: 3925 → 3989), because what the divider sees is the charger's terminal voltage
arriving, not charge going into the cell. One such sample in the ring inflated the fitted slope
**143 → 183 mV/h**.

That is a **violated contract, not a rounding error**: `>=` promises *at least* that long, so an
optimistic estimate breaks the one guarantee the notation exists to make — and it fails in the
direction a reader cannot detect. **No rate or SNR gate can catch it**, because a rebound is smooth
and fits a line perfectly well; that is exactly the property the discharge side already documents
for relaxation (`-21 mV` after unplugging, "expect the first fit to lie"). This transient is
**three times larger** and arrives on the side nothing was guarding.
Only TIME distinguishes it, so `BATT_CHG_SETTLE_MS` (3 min, measured from entering CHARGING rather
than from the first sample) admits nothing to the ring until it has passed, and the 40mV fall guard
**re-settles** rather than resuming mid-transient. `batt-trend-check.py` carries the real
25-sample series as a regression: contaminated **53 min**, settled **69** — and asserts the guard
can only ever move the estimate in the SAFE direction, longer and never shorter.
**The on-glass number looked entirely plausible throughout**, which is the transferable part: this
was caught by a second independent computation, not by looking.

Four more things are load-bearing:

- **It fits mV, not percent.** The target is a VOLTAGE, and routing the slope through
  `pctFromMv()`'s curve would attribute that model's shape to the charger — the same reason
  `POWERPROBE` reports mV/h.
- **`BATT_CHG_TARGET_MV` is 4200 because that is where `pctFromMv()` actually returns 100**, not a
  guess at "full". It sits ABOVE `BATT_FULL_MV` (4180) on purpose, so `batteryState()` flips to
  `BATT_FULL` and the label disappears before the estimate could ever count down to zero. Note
  4180 is **98%** on that curve, so the pill reads "full" a couple of points early; that predates
  this and is left alone.
- **Below the knee the fit still extrapolates THROUGH the knee**, so the answer is rendered
  **`>=2h`, never `~2h`**. The discharge row's `~` means "about"; `>=` means "at least". A reader
  who cannot tell those apart has been told the charge will finish sooner than it will.
- **The 99h clamp is provably unreachable and is kept anyway.** The gate admits no slope under
  `BATT_CHG_MIN_RISE_MV` over the longest window the ring holds (29 min) = **51.7 mV/h**, and the
  largest gap to the target is 900 mV, so the worst reachable estimate is **17.4h — 5.7x inside the
  clamp**. The first version of the check tried to TRIGGER the clamp and failed; it now asserts
  unreachability as a sweep, and separately asserts the clamp is still present, because a guard
  that has been deleted cannot catch the change that would make it necessary.

**`chg=` rides the `BATT` line, and on this board that is not merely provenance.** The STATUS row is
the only other place the number appears, the backlight blanks on idle, and **only a touch can wake
board 2** — so without a field on the wire the charge estimate is unobservable from the Mac on an
unattended device, which also makes it unverifiable. It is appended rather than inserted, the same
backward-compatible shape as the trailing `to=<hostId>`.

**THREE SHARED-CODE LEAKS WERE CAUGHT BY `board-baseline.mjs`, AND TWO WERE INVISIBLE TO A SIZE
CHECK.** All three were "board-2-only" changes that were not:

1. The charge estimator itself, left unguarded in `power.ino`: **+288 bytes** of a board-2-only
   estimator compiled into board 1.
2. `char left[8]` → `left[12]` in `settings.ino`, for the longer `topping up` label: board 1
   reported **CHANGED at +0 bytes** — a pure content change a size comparison cannot see. Fixed
   with a per-board `BATT_LEFT_BYTES` (8 / 12).
3. `battRowTextCache[20]` → `[24]`, needed because **`"90% 4.10V topping up"` is exactly 20
   characters** and 20 bytes truncated it by one — the silent-cache failure this repo has paid for
   repeatedly. Fixed with a per-board `BATT_ROW_CACHE` (20 / 24). The bound is DERIVED in the
   checker, not transcribed: `topping up` only appears at or above the knee and `BATT_CHARGING`
   only holds below `BATT_FULL_MV`, so the percentage in that band is 90..97.

**Both new sizes are per-board CONSTANTS in the board headers rather than `#if`s at the
declaration**, and that was forced by the checker rather than chosen: with the size behind an
`#if`, `cacheSizes()` parsed one branch and reported **24 for both boards**, so board 1 carried a
false reading — exactly the "a checker must PARSE the constant it certifies, never TRANSCRIBE it"
rule, arriving from a new direction. All three mutations (`BATT_ROW_CACHE` → 20, `DEV_CARD_H` → 176,
`DROW_TEMP` removed) fail by name.

**Layout cost: the DEVICE card grew 176 → 200** for the new row, which came out of page 0's
TRAILING AIR rather than out of another row. `LINK_CARD_Y` is derived from `DEV_CARD_H`, so the LINK
card slid 304 → 328 on its own and the page's air went **28px → 4px** — the same margin the USAGE
tab settled on, and the checker asserts it stays above zero. **There is no room left on page 0**: a
further row has to come from somewhere else. Total cost **+4140 bytes of flash, +288 RAM** (the two
30-slot rings are 240 of that), measured against a worktree build of HEAD rather than against this
file's previous figures, which were stale.

#### Pre-existing BOARD-1 defects this port surfaced, and why none is fixed

Re-deriving a layout from first principles turned out to be an **audit of the original**. **Ten real
board-1 defects** fell out (across eleven numbered slots — one report turned out to be false), plus
one board-2-only defect that *was* fixed (the farewell flush, above). None of the ten is fixed here,
for one reason: **every fix would move board 1's binary inside a diff whose entire claim is
byte-identity**, hiding a behaviour change where nobody would look for it. They belong on their own
branch off main.

They are recorded, with arithmetic and a severity order, in
**`docs/board-1-known-defects.md`** — including the one reported defect that turned out **not** to
be real, kept as a correction rather than deleted, because a false defect costs a future maintainer
either the time to disprove it or a no-op "fix" that breaks byte-identity for nothing. The worst live one, for orientation: **the session
detail screen draws two footer strings at the same `MC_DATUM` y**, so the "answer this one on your
Mac" notice is painted out by the history hint — a message about where an action must happen,
silently erased.

#### What is NOT verified on board 2, stated plainly

- **The two-`conn_id` NimBLE demux has never run.** Same reason board 1's Bluedroid demux has never
  run: two host processes on one Mac share a single ACL connection to the peripheral, so proving it
  needs a **second radio**. It is this feature's one untested load-bearing path, on both boards.
- **The `TEXTPROBE` board-1↔board-2 diff has never been run**, because board 1 was physically
  disconnected throughout. The artifact is committed (`text-widths-board2.txt`) and the comparison
  is the one command in `text_probe.h`.
- **Board 1's on-glass touch check after the HAL extraction** was substituted by a binary-level
  comparison rather than a tap: `getTouchPoint`, `readRawTouch`, `fitAffine`, `waitForStableTouch`,
  `loadOrRunCalibration`, `applyScreenRotation` and `drawCrosshair` are instruction-and-operand
  identical, and `runCalibration` is the same size with an identical mnemonic stream. That is strong
  evidence and not a tap.
- **The SETTINGS page's ~140px of trailing air below the DEVICE card** is real and confirmed on the
  glass. It is a layout judgement nobody has made yet, not a bug.

#### Outstanding board-2 items, found by writing this documentation

None of these is fixed, and none is a port regression — they are gaps between what board 2 does and
what the rules on this page already require. Recorded here rather than in a scratch file because a
known gap nobody wrote down is indistinguishable from a bug nobody found.

- **TWO strings promise a touch wake board 2 does not have.** `settings.ino:333`'s hint reads
  `"power off = deep sleep, touch to wake"` and the POWER OFF confirm dialog at `:444` reads
  `"deep sleep - touch the screen to wake"`. On board 2 the only way back is RESET. The two farewell
  screens are already correct — they share the `WAKE_HINT` macro in `power.ino`, which is
  `#if BOARD_HAS_TOUCH_SLEEP_WAKE`-conditional for exactly this reason — so the mechanism exists and
  these two sites simply never adopted it. **The dialog one is the worse of the two**, because a
  confirm dialog's entire documented job in this repo is to state the consequence, and here it
  states the wrong one. Not fixed in this pass: `WAKE_HINT` is `"touch screen to wake"` while these
  are `"touch to wake"` / `"touch the screen to wake"`, so routing them through it changes board 1's
  rodata and breaks the byte-identity this port holds. It is a two-line fix on a board-1-inclusive
  branch.

**TWO SHARED-CODE BUGS WERE FIXED DELIBERATELY, and both are the same lesson in different
clothes.** Board 1's binary moved for each, which is why the byte-identity check is now
`board-baseline.mjs` (see Commands).

- **The history list went BLANK after reading one entry in full**, recovering only if you paged.
  State was destroyed, not a redraw missed, and the recovery is what proves which: the `hist` reply
  handler cleared `histCount`/`histArenaUsed` **before** knowing what kind of reply had arrived. An
  `item:<n>` reply carries a `full` object and **no `items` array at all** (`sendHistoryItem` sends
  exactly `{hist:{id, full}}`), so the page's rows were wiped and the items loop had nothing to
  refill them with. PREV/NEXT re-REQUESTS a page, and that reply does carry items — which is
  precisely why it presented as a repaint bug. The fix is ordering: handle the single-entry reply and
  return before touching any page state. **A parser that mutates shared state before it has
  identified the message is the bug class**, not this one instance.
- **PAIRED MACS: the live-Mac marker was INVISIBLE and two same-named Macs were indistinguishable.**
  The marker was a middle dot and both faces declare `0x20..0x7E`, so it drew as nothing on both
  boards — the third instance of the trap already documented for the `CLAUDE/air` tag separator and
  `fitText`'s three ASCII dots. And two MacBook Pros both report `...-MacBook-Pro`, the same
  collision that makes `macTag()` emit `pro` twice, which matters far more here than on a session row
  because **this page's controls are destructive and per-row**: which `x` forgets which Mac was a
  guess. A shared label now appends the first 4 hex of `hostId` — unique by construction, nothing new
  on the wire — and the **label** is what gets trimmed, never the suffix, measured with `fitText`
  because `uiListRow` draws with no width bound and `drawString` paints an opaque box that would rub
  out the card border.

**Identity is `hostId`, and it is NOT derived from a MAC address** — `crypto.randomBytes(4)`,
persisted. Two Macs with identical hostnames have different hostIds, so pairing, key selection and
answer addressing were never ambiguous; only the *display* collided. A MAC address would be strictly
worse: CoreBluetooth never exposes the local BT address and BLE uses rotating private addresses (the
same opacity that leaves `BLE_CHUNK_SIZE` hard-coded at 20 because noble reports no MTU), macOS uses
private per-network Wi-Fi addresses, six bytes of hex cannot be read in a 6-character tag lane, and
it is needless PII on the wire.

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
  ≤34-char title, ≤1400-char detail, ≤4 option labels of ≤32 chars, and — only when something is
  actually described — a parallel `optDescs` array capped at 96 BYTES each) in the session file so
  the device can display it. **Every one of those text fields is ASCII by the time it is written**;
  the caps were characters against a byte guard until that was reconciled, which is the byte-budget
  note under the device line buffers. Whether it then **waits** depends entirely on the event:
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
  **The wait is now effectively UNLIMITED for Claude Code, and configurable.**
  `~/.claude/deckhand-remote-wait` holds seconds, or `forever`/`0`/absent for the
  default; a malformed value also reads as the default, deliberately, because
  falling back to a 0ms wait would silently disable remote answering and present as
  the feature being broken rather than misconfigured. Waiting indefinitely is safe
  here for the same measured reason the 90s cap was: Claude Code's dialog is on
  screen throughout, so the wait ends the moment EITHER side answers - a device
  answer returns it, the Mac answering strips the ask and returns null, SessionEnd
  removes the file. A long wait only extends the case where nobody has answered yet.
  **"Forever" is 86340s (23h59m), NOT Infinity, and that is not hedging.** Claude
  Code kills a hook that outlives its settings.json `timeout`, and a *killed*
  `PermissionRequest` hook is an untested state - the 310-sample evidence only ever
  covers a hook that exits on its own, because the old 90s wait always finished
  inside the old 100s timeout. Infinity would guarantee hitting that untested path
  on every unanswered prompt, so the invariant is kept instead: **the hook always
  self-exits before it can be killed.** `HOOK_TIMEOUT_S` (86400) in the hook and the
  `timeout` written by `install-hooks.mjs` are a PAIR - raise the wait without
  raising the timeout and the kill comes back silently.
  **Codex stays at 15s regardless of the config, on purpose.** That measurement is
  Claude-Code-only, and Codex's spec records two unverified risks: whether an expired
  `PermissionRequest` hook falls through or resolves as a DENIAL, and whether its
  approval UI is concurrent or serialised. If serialised, an unlimited wait deadlocks
  the prompt into being answerable nowhere. The failure modes are not symmetric.
  The host mirrors the same config file for the device's countdown (`ask.sec`) and
  **omits the field entirely when the wait is unlimited**, so the device draws no
  countdown rather than a 24-hour one; reading the same file is what stops the two
  drifting when one is edited.
  Two hard rules: the hook waits **only** when `/tmp/deckhand-<uid>/host-alive` (host heartbeat, written
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
- **Two Macs at once: `MAX_LINKS` (2) concurrent BLE links against `MAX_HOSTS` (4) pairing
  slots.** Remembering a Mac and talking to it at the same moment are different limits, and it is
  the radio that sets the smaller one. Stock Arduino esp32 3.3.11 ships
  `CONFIG_BTDM_CTRL_BLE_MAX_CONN 3` and `CONFIG_BT_ACL_CONNECTIONS 4` — read out of the installed
  libs rather than assumed — so two links need **no build-config change at all**, while four Macs
  would sit exactly at the controller's ceiling. Sessions from both Macs share one urgency-ranked
  list, a row is tagged with the Mac it lives on, an answer is signed with that Mac's own key and
  addressed to it, and USAGE shows whichever Mac's reading is fresher. Nothing about the pairing
  model changed: **pairing the second Mac still means plugging the device into it once**, because
  `PROVISION` is USB-only by design and stays that way. Every trap below fails **silently**, which
  is the reason this section is as long as it is.
  - **Bluedroid STOPS advertising the instant a central connects**, so without `onConnect`
    re-calling `startAdvertising()` a second Mac can never attach — and the symptom is not an
    error anywhere, it is a second Mac whose BLE scan simply never finds a device that is sitting
    right there, connected and healthy, to the first Mac. A third central is **refused, not
    queued** (`server->disconnect(conn)`), and a refusal deliberately does *nothing* further — no
    advertise, no state touched — because `onConnect` → refuse → advertise → `onConnect` storms
    until whichever condition clears. The 5s advertising watchdog in `loop()` is what resumes
    advertising once a slot really frees, so the quiet path costs a few seconds and the loud one
    would cost the radio.
  - **Two Macs write into ONE RX characteristic, so their 20-byte chunks interleave**, and a
    single `serialBufBLE` accumulator therefore turns *every* payload into corrupt JSON. The
    failure is the worst shape available: `handleLine` returns early on a parse error, so the
    screen just stops updating while both links, both heartbeats and both menu bars look
    perfectly healthy — the device-side twin of the stalled-tick bug the host's watchdog exists
    for. `onWrite`'s two-argument overload gives `param->write.conn_id`, and each chunk is framed
    into the existing 16KB stream buffer as `[conn_id][len16][bytes]`, demuxed by `loop()` into
    one accumulator per link. **The header and its payload go in atomically** — a chunk that will
    not fit whole is dropped whole — because a partial write desyncs every frame that follows,
    where the old unframed buffer merely lost some bytes; the host resends a full snapshot every
    5s, so dropping a whole chunk costs one tick. The one-argument `onWrite` form delegates and
    **drops the frame rather than guessing `conn_id = 0`**: guessing would file a second central's
    bytes onto slot 0's accumulator, which is precisely the corruption being prevented.
  - **Releasing a BLE link slot is DEFERRED to loopTask, because `onDisconnect` runs on
    BTC_TASK.** Clearing the slot's `String` buffer there frees memory `feedChar` may be appending
    into on loopTask right now — a cross-core use-after-free, which on this chip presents as a
    crash loop or corrupted text rather than as anything naming BLE. So `onDisconnect` sets
    `releasePending` on the slot and nothing else, and `reapBleLinks()` does the teardown.
    Two orderings inside it are load-bearing: the reap clears **`buf`, then `releasePending`, then
    `used`** — publishing slot freedom LAST closes the window where the allocator could hand out a
    slot whose buffer is still being cleared — and `bleSlotForConn()` matches neither a pending
    slot nor hands it out, because Bluedroid reuses small `conn_id` values immediately after a
    disconnect and a recycled id inheriting a pending slot lands straight back in the interleaving
    bug through the lookup instead of the drain.
    `reapBleLinks()` is also called from the **long blocking loops** — `micStream` (up to 120s),
    `micMonitor`, `runCalibration` (waits on a person), the `SCREENSHOT` readback — because
    `drainBleRx()` only runs from `loop()`, and for the whole duration of one of those calls
    nothing would reap a pending slot: a refusal caused by that still-pending slot would leave the
    device un-advertised for up to two minutes with no log line saying why. **Only those blocking
    call sites pass `mayAdvertise = true`**; the ordinary path passes false, since `onDisconnect`
    plus the 5s watchdog already cover it and advertising redundantly measurably perturbs
    reconnect timing. Reconnect after a disconnect measured **53–697ms across 8–9 trials, mean
    ~294ms**. (An earlier "~55ms" figure for the same thing rested on 2–3 samples and was not a
    real baseline — do not compare against it.)
  - **`authHmac`'s implicit `activeHost` means "whoever sent the most recent payload", which once
    two Macs are ticking is wrong about half the time.** The symptom is an intermittently rejected
    answer with nothing visibly broken anywhere: you tap Allow, the prompt sits there, and the
    next attempt works. Answers sign with `pairingSlotForRow(row.hostSlot)`, falling back to
    `activeHost` **only** when `hostSlot` is not a valid link index — a payload carrying no
    `hostId` leaves `info.hostSlot = (uint8_t) -1` = 255, deliberately `>= MAX_LINKS` so it can
    never alias a real slot — which is what keeps a legacy host answerable at all. In the two-Mac
    case `hostSlot` is always a real link index and the fallback is a pass-through.
  - **`voiceSeq` is PER-LINK, and sharing it disables the voice card continuously rather than
    once.** It is a host-lifetime counter starting at 1, and the device already reads a
    *backwards* seq as a new host generation (the host-restart case documented under the voice
    card). Two independent counters against one shared high-water mark trip that reset on nearly
    every tick, so the card never raises and a processing bar has nothing that can ever end it.
  - **Sessions merge into ONE 6-row pool, because per-Mac arrays are arithmetically impossible.**
    A `SessionInfo` is ~2.2KB, so a second array is 13.4KB against ~26KB of free heap — the same
    budget the audio path's capture buffer comes out of. Each tick frees only **the sending Mac's**
    rows (wholesale replacement made the list flap between the two Macs) and admits its new ones,
    which arrive already urgency-sorted by that host. When the pool is full the eviction victim is
    the **max-rank** row and eviction requires **strictly better** urgency, so an `asking` row can
    never be evicted at all (its rank is 0, and nothing can beat it), and the first incoming row
    that fails ends the walk. Ranking is an **INDEX sort** (`sessionOrder[]`), never a value sort:
    a value sort would memmove tens of KB of `SessionInfo` every tick. The device now owns the
    cross-Mac ranking, which each host can only ever apply to its own list. A link silent for
    `LINK_STALE_MS` (21000ms, ~4 missed ticks) has its rows **DROPPED, not dimmed** — showing an
    unreachable Mac's prompt as answerable is the worse failure, and dropping is what keeps the
    footer's single "Xs ago" honest.
  - **`hostSlot` is in the row's repaint signature and the Mac tag is in the detail signature —
    for identity, not length.** Two same-named sessions on different Macs at the same display
    position share every other field, so without it the row keeps whichever Mac's tag was drawn
    first; and because `dispMacTag()` returns "" until a second Mac shows up, a `usedLinkCount()`
    flip changes the signature for free. Cache sizes, since `drawIfChanged`-style comparisons only
    look at `cacheSize` bytes and a short cache silently stops noticing changes past that point:
    `rowSigCache` is **176** against a 125-byte worst case, and `detailSigCache` is **384** against
    a field-by-field-derived **352** — the re-derivation the previous 368-against-~350 note demanded
    actually happening once the icon id was appended, so do the same again on the next field rather
    than assuming it still fits.
  - **The Mac tag's separator is an ASCII `/`, not a middle dot** (`CLAUDE/air`, `CC/air`), because
    Cozette is 0x20–0x7E only and U+00B7 draws as a blank box — the same constraint that already
    forces `fitText`'s three-dot ellipsis. The tag is built **once** into `agentTag[]` and both
    drawn and measured from that one buffer, so a wider tag drops the name a rung down the
    12x26 → 10x18 → 6x13 ladder instead of being overlapped by it. It appears only when
    `usedLinkCount() > 1`: with one Mac the row reads plain `CLAUDE`, never a dangling `/`, because
    a label that disambiguates nothing is how you *stop* noticing the second Mac arriving.
  - **USAGE takes the fresher reading PER SOURCE and names the Mac it came from.** Both Macs poll
    the same account, so the numbers agree and the only real difference between them is AGE
    (`mergeUsage()`: Claude by `quotaAgeSec`, Codex independently by `cxAgeSec`, which is already
    how the Codex row judges staleness). That also makes the two Macs each other's staleness
    backup — a Mac in a long OAuth back-off is simply out-aged by the other — and it keeps a future
    divergence (different accounts) visible as a number that changes *label* rather than a silent
    average. A negative age means "never measured" and must never win against a real reading, which
    a plain `<` comparison on -1 would let it do. **A source change moves no digits, so it must bust
    the cache itself** (`srcCache`/`cxSrcCache` → `drawUsageStatic()`) — the identical trap the
    stale-dim flip has. And `mergeUsage()` **re-runs after `pruneStaleLinks()`**, or a departed
    Mac's percentages stay on screen indefinitely with a tag naming a Mac that is gone.
  - **The Mac's short tag is derived ON THE MAC** (`macTag()` in `host/host-tag.mjs`, published as
    `hostTag`, overridable with `DECKHAND_MAC_TAG`) and **capped at 6 characters there**, not
    trimmed on arrival, because it is drawn into a lane the device measures. Two asymmetries are
    deliberate: an override is a user-supplied *tag*, so it is sanitised **whole** and never split
    on separators, while a hostname is an OS name whose distinguishing part is its **last segment**
    (`air` vs `studio` in Apple's defaults) — and that segment is taken **even when it is one
    character**, since `Mac-Studio-B` really is "b". `host/host-tag-check.mjs` pins all of it.
  - **A Mac can also carry a 13x13 ICON, and the NAME is what crosses the wire — never the
    character.** `Cozette6x13` declares `0x20, 0x7E`, the same fact that already forces `fitText`'s
    three ASCII dots and the tag's ASCII `/` separator, so an emoji cannot be a glyph on this
    device: an icon is **artwork**. `DECKHAND_MAC_EMOJI` or the menu-bar picker resolves to one of
    sixteen names on the Mac (`resolveMacEmoji` in `host/mac-emoji.mjs`), the name rides every
    payload as `hostEmoji`, and the device turns it into a sprite index with `macEmojiIndex()` (a
    linear scan over 16 entries, run once per payload). Put the CHARACTER on the wire instead and
    you are feeding multi-byte text into `feedChar`'s line buffer, an ask sanitiser that blanks
    every control byte, and a struct of fixed `char[]` fields that `copyField` truncates by BYTES —
    all of it ASCII-oriented end to end. An unknown name is dropped on the Mac (`resolveMacEmoji`
    returns "") and returns -1 on the device, and **both** fall back to the text tag rather than
    drawing nothing.
  - **THE ICON SIZE IS THE BODY FONT'S CELL HEIGHT, and it is therefore PER BOARD: 13 on board 1
    (Cozette 6x13), 16 on board 2 (Spleen 8x16).** That identity is the whole design: an icon's `y`
    **is** its neighbouring text's `TL_DATUM` y, with a 4px gap, at all six sites that draw one
    (tall session rows, the two usage cards, the Codex row, SETTINGS › STATUS, the detail card), so
    no site carries a centring term. Which is why **`drawEmoji`'s `(x, y)` is the TOP-LEFT corner**,
    deliberately unlike `blit2bpp`'s centre convention — a centre-based signature would put the same
    `- MAC_EMOJI_SIZE / 2` at all six.
    `emoji2c.py` takes `--size` (default 13, so an argument-less run still emits board 1's header
    byte for byte) and the sketch picks `MacEmoji.h` or `MacEmoji16.h` behind `BOARD_USES_TFT_ESPI`.
    **The two headers cannot both be included** — they define the same
    `MAC_EMOJI_SIZE`/`STRIDE`/`COUNT`/`NAMES` — which is correct rather than awkward: exactly one
    size is right for a given panel. `--verify` reads `MAC_EMOJI_SIZE` back out of the header it is
    handed and re-renders at THAT size, so a header can never be checked against the wrong geometry.
  - **16px COLLIDES WITH A CLEAR BOX ON BOARD 1 AND NOT ON BOARD 2, which is the reason the number
    could not simply be raised everywhere.** A usage card's label row is the tightest site on both:
    the icon spans `CARD_LABEL_Y`..`CARD_LABEL_Y + MAC_EMOJI_SIZE - 1` against a hero box that
    clears from `CARD_HERO_Y` across the full card interior. Board 1's hero starts at `y0+20`, so a
    16px icon (`+6`..`+21`) would be rubbed out by the hero's own erase on every tick the digits
    move — the same clear-box-not-glyphs arithmetic the `+88` stats row documents. Board 2's hero
    starts at `y0+24`, so 16px (`+6`..`+21`) clears it by **2 rows**. Clearance at the other five,
    all re-derived at 16px rather than assumed: `sessions.ino` tall-row tag `+9`..`+24` against a
    pill no higher than `+31` on the shortest tall row (**6 rows**); `settings.ino` Mac rows clear
    `+129`..`+146` and `+153`..`+170`, the icon inside the first (**7 rows** to the next);
    `usage.ino`'s Codex row `+8`..`+23` inside a text clear of `+7`..`+24` against a border at
    `+54` (**30 rows**); the detail card's AGENT column was the last block in a stack packed to 320
    of 326 (**board 2's detail card no longer has that column at all** — §7 put the Mac on the
    single meta line instead, where the icon's `y` IS the line's `y` by the same rule, and the
    card ends at 300 with the meta ink at `+280..+295`; board 1 keeps the column). Horizontally
    the icon is 3px wider, absorbed everywhere: the Codex lane already reserves
    four monospace spaces (32px on board 2 against `4+16+4` = 24 needed), the SETTINGS erase box
    grows to 246px from x=30 inside an interior of 305, the session row's name lane already
    subtracts `tagExtra`, and the detail column needs 96px of 126 (on board 2 the meta line
    measures the Mac cluster FIRST and `fitText`s the facts into whatever lane is left, so no
    width can collide there however long a model or branch name is).
  - **Cost: 390 bytes per icon on board 1 (338 colour + 52 alpha), 576 on board 2 (512 + 64) —
    6,240 and 9,216 for all sixteen, and the measured board-2 flash delta was +2,944 with RAM
    unchanged** (the art is `PROGMEM`). The alpha figure is where the original design spec was
    wrong: it budgeted **43** bytes, which is 13x13 = 169 two-bit samples packed as one continuous
    bitstream (42.25 bytes). `drawEmoji` unpacks each row independently at
    `alpha + py * ((n + 3) / 4)`, so the stride must be a whole number of **bytes per row** —
    `MAC_EMOJI_STRIDE`, which is 4 at both 13 and 16 pixels, the identical packing `blit2bpp`'s
    other art uses. A continuous bitstream would save 9 bytes an icon and cost a bit-offset
    multiply in the inner loop of a blitter that already works a row at a time.
  - **Colour and alpha are SEPARATE planes and the backdrop is a draw-time argument.** The same
    icon has to sit on a card fill, a session row and the page background, in **two** themes;
    baking one background in is exactly what gives `ClawdCrab.h` its documented fringe under
    LIGHT. `drawEmoji` blends per pixel against the `bg` the caller names, composing one row into a
    13-entry buffer pushed with `setSwapBytes(true)` — the same byte-order handling `drawLogo`
    needs, and for the same reason.
  - **The icon id had to enter FOUR caches, and the symptom of missing any one is a card or row
    that keeps a stale icon forever — except on the Codex row, which needs none of this.** An icon
    change moves no text, no percentage, no source link and no link count, so the change-only
    redraw discipline correctly skips a field whose pixels are now wrong. The four: the **row
    signature** (`rowSigCache`, so a row whose Mac's icon changes repaints); the **detail
    signature** (`detailSigCache`, 368 → **384** against a field-by-field-derived 352 worst case);
    the **Claude cards' usage chrome bust** (`emojiCache` beside `srcCache`/`pinCache`/`linksCache`
    → `drawUsageStatic()`, because a Claude card's label is static chrome, repainted only on that
    bust, and never redraws its icon on its own); and the **SETTINGS link row's cached string**,
    where the id rides after a `\x01` sentinel that is never drawn, because that cache compares
    TEXT and the icon is drawn separately from it. That row's erase box also reserves the icon's
    slot (4px +
    13px) whether or not the row currently has one, so an icon that disappears leaves no ghost.
    The Codex row is the exception: `renderCodexRow()` draws its icon unconditionally every tick
    rather than behind a `drawIfChanged` of its own, and the label's clear box (x 25..93) already
    covers the icon's slot (42..54) on every redraw — so a stale Codex icon self-heals with no
    cache to bust, and carrying one anyway would only buy an avoidable full-chrome repaint.
  - **The pin bar is ABOVE the icon at rows `y0+3`..`y0+5`, and it is a BAR rather than an
    underline because below the icon is `y0+20` — inside the hero number's box.** Geometry, all of
    it forced: the 2px card border owns `y0`..`y0+1`, one clear row at `+2`, bar `+3`..`+5`, icon
    `+6`..`+18`, hero box from `+19`. It exists because pinned-vs-auto used to ride the **tag's
    colour**, which a colour sprite cannot carry — so PRESENCE became the carrier instead of hue.
    It is nested inside the icon's own `if`, which makes a stripe with no icon under it
    structurally impossible rather than merely unlikely.
  - **Icons are NOT gated on `usedLinkCount() > 1`; the text tag still is.** An icon is
    personalisation — someone deliberately marked THEIR computer, and it should show with one Mac
    connected. A redundant six-character word beside a single Mac's card is noise, and a tag that
    only appears when the second Mac arrives is how you *notice* the second Mac arriving.
    **The Codex row keeps its window text alongside its icon, too** — an icon is drawn OVER a
    reserved gap in the same line rather than in place of anything, so setting one no longer makes
    the row drop the fact of what its percentage measures. It's only the Mac tag that still yields
    to the icon there, the same trade every other site makes between the two.
  - **A tall session row now identifies its Mac TWICE — icon in the corner, text tag in the
    sub-line — and that redundancy is deliberate.** Only the tag changed; the icon was added
    beside it rather than in place of it. The two cannot disagree, because both read the same
    `hostLinks` entry inside one synchronous draw, and the pairing is what makes the icon
    self-teaching on the screen you look at most: you learn which sprite means which Mac from the
    row that also spells it out.
  - **The strongest argument for this whole feature was found by accident: the derived text tag
    COLLIDES between similarly-named Macs.** `macTag()` takes the hostname's **last segment**, so
    every "…-MacBook-Pro" resolves to `pro` — and this machine's two Macs are both MacBook Pros,
    so both `used` link slots showed the tag `pro` at once. That is **not** a duplicated row: two
    slots can only coexist with different `hostId`s (a same-`hostId` payload would have matched the
    existing slot instead of allocating a second), so it is two genuinely distinct Macs that text
    alone cannot tell apart. The icon can.
  - **THREE hand-transcribed copies of the sixteen names exist, and `host/mac-emoji-check.mjs`
    compares all three** — `firmware/deckhand_display/MacEmoji.h` (generated by `emoji2c.py`, and
    canonical: the device can only draw what is in it; `MacEmoji16.h` carries the same sixteen
    names, since only the CHARACTERS may differ per size), `host/mac-emoji.mjs` (the only Mac-side
    validator), and `MAC_ICON_NAMES` in `mac-app/DeckhandMenuBar.swift` (the picker's display
    order). Divergence is silent in **both** directions, which is why this is a check and not a
    sentence asking for care: a name valid on the Mac and absent from the header resolves fine,
    crosses the wire, and shows as **no icon at all** with no error on either side, while a name in
    the header that Swift omits is simply unpickable. The check parses the file TEXT with regexes
    (two of the three cannot be imported by node) and names the file and the direction it
    disagrees in; it also compares its own parse of `mac-emoji.mjs` against the **imported** array,
    so a regex that has stopped matching fails loudly instead of passing three empty lists against
    each other. Order-only divergence fails too, and the message says plainly that it is not itself
    a display bug — the wire carries the name, never an index — only evidence that one list was
    edited without the others. `emoji2c.py --verify` covers the remaining edge, generator against
    generated header.
  - **The PICKER SHOWS THE PICTURE, and that adds a FOURTH table — of characters, not names.**
    A submenu of sixteen bare words is the same problem `--sound-check play` already fixed for
    sounds: `wave`, `bolt` and `anchor` are a guess until you see them, so each row now reads
    `🌊  wave` and the `Mac icon` parent carries the current pick's glyph, which is also the only
    way an env-set value's *picture* is visible on a row whose children are deliberately disabled.
    `MAC_ICON_GLYPHS` in `mac-app/DeckhandMenuBar.swift` is **display-only** — `pickIcon` still
    writes `EMOJI <name>`, and the device still draws baked artwork because Cozette cannot render
    an emoji glyph at all — so a wrong entry is a wrong picture in one menu, never a broken icon
    on the device. What it *can* do is offer a picture the device no longer draws, silently and
    forever, since the names are frozen and choosing a different CHARACTER is the only lever a bad
    icon has; so `mac-emoji-check.mjs` compares it against **`ICONS` in `emoji2c.py`** — the
    generator, the only place recording which character the art was rendered FROM, where
    `MacEmoji.h` holds pixels and has forgotten. Both fault injections were run: a swapped glyph
    and a dropped row each fail by name. Two details: the entries are written as `\u{...}` escapes
    because every one ends in an **invisible** U+FE0F (the variation selector that stops `gear`,
    `desktop`, `sun` and `star` rendering as flat text glyphs, and exactly the character an editor
    silently eats), and mismatches print CODEPOINTS rather than characters, or the failure reads as
    two identical emoji side by side. `SIZE_OVERRIDES` is deliberately **not** reflected here — the
    Mac cannot know which board it is talking to and may be talking to both, so the menu shows the
    base character each override was chosen to keep describing. The parser also had to anchor its
    opening bracket PAST the marker, because Swift's `[String: String]` type annotation opens one
    first and `namesFrom`'s anchoring reads the table as empty.
  - **A broken icon is fixed by giving the same NAME a different CHARACTER, and at 16px two were.**
    The names are the wire format, so they can never move; `SIZE_OVERRIDES` in `emoji2c.py` is the
    only lever, and it is keyed by SIZE because **board 1's 13px set is frozen** — its binary is
    unchanged by the per-board split and respinning its art would spend that for a judgement only a
    board 2 screen can make. Both changes were measured on all four real backdrops
    (DARK/LIGHT x BG/CARD) as **CIE Lab ΔE of the composited ink against the backdrop**, not WCAG
    contrast: contrast is a luminance ratio, and it calls a perfectly legible yellow `star` on white
    a failure at 1.9:1 while saying nothing about hue. Then looked at on the glass, which is the
    authority — a `keyboard` glyph beat both winners on every number and was rejected because at
    16px it draws as a featureless grey bar with no keys, the same way `robot` read as a cupcake.
    - `cloud` **U+2601 → U+1F326** (sun behind rain cloud). A white cloud on LIGHT is the one
      genuine INVISIBILITY in the set: ΔE90 **15.6** with **5%** of its ink clearing ΔE 20 on a
      LIGHT card. Note LIGHT's `COLOR_CARD` is pure white, so this is **every shipping surface**,
      not just the `EMOJITEST` screen the older note blamed. Apple's whole cloud family is white,
      so no cloud glyph fixes it by being darker — U+1F326 fixes it by carrying a yellow sun and
      blue rain, i.e. HUE the white body does not have. ΔE90 goes **15.6 → 53.8** on a LIGHT card
      and **12.2 → 51.0** on the LIGHT page, and the cloud is still the dominant mass.
    - `desktop` **U+1F5A5 → U+1F4FA** (television). `laptop` and `desktop` were BOTH a black screen
      over a light base — and they are exactly the two a MacBook and a Mac Studio reach for, so the
      one case the icons exist for was the one they could not serve. Measured as mean per-pixel ΔE
      **between** the two icons on the same backdrop, U+1F5A5 was the least distinct candidate
      tried on every backdrop (**20.3–22.0**, against 25.2–25.8 for the television and 29.5–36.8
      for the rejected keyboard). A television is a different OBJECT rather than a differently-lit
      screen, and it reads on all four backdrops (**86–96%** of ink clearing ΔE 20, against
      **53%** for the monitor on a DARK card, whose black screen simply disappears there). The
      picker lists NAMES only, so nothing on the Mac disagrees with the new picture.
    - **`anchor` was NOT changed, and the older note grouping it with those two is wrong at 16px.**
      It measures ΔE90 65.0 with **93%** of its ink clearing ΔE 20 on the DARK page and 90% on a
      LIGHT card. Its 13px problem was **stroke width** in thin line art, which 51% more pixels
      resolved — not a colour that needed replacing. `laptop` keeps U+1F4BB: it is the unambiguous
      picture for its own name, and the collision is fixed by moving the icon that had an
      alternative.
    - **What is NOT verified on the panel: the DARK theme at 16px.** The device was pinned to
      LIGHT, and there is **no host command that changes the theme** (nor one that dismisses
      `EMOJITEST` — see below), so the go/no-go screenshots are LIGHT-only. LIGHT is the harder
      case for `cloud` and was captured; `desktop`'s 53% → 86% gain is on DARK and rests on the
      measurement plus `--preview`, not on the glass. Tap the theme button and re-run
      `EMOJITEST` + `SCREENSHOT` to close it.
  - **`EMOJITEST [<name>]` puts all sixteen on BOTH backdrops**, for the same reason
    `TAB`/`PAGE`/`KBTEST` exist: `SCREENSHOT` can only record what is currently on the glass, and
    an alpha blend plus the `setSwapBytes` handling can only be judged where they actually have to
    work, never on a third colour picked for convenience. There is no `large` argument or any
    other second mode — an unrecognised word simply falls through to the same all-sixteen grid,
    which is also what plain `EMOJITEST` draws. **NOTHING DISMISSES IT REMOTELY, and that bites a
    headless capture session.** `emojiTestActive` is cleared only by a TAP (in `handleTouch`), while
    `switchTab` returns early with it set — so `TAB`/`PAGE` are refused, every later `SCREENSHOT`
    returns the same frozen frame (identical footer clock is the tell), and the only remote escape
    is a re-flash, which reboots the device. Verify `EMOJITEST` LAST in a capture run, or budget an
    upload to get out. Not fixed here because `handleTouch`/`switchTab` are shared code and board 1's
    binary is being held byte-identical; a `TAB` that also clears the flag would be the fix.
    It refuses while the keyboard, reader, history
    pager or a session detail screen owns the glass, the same guard `fabVisible()` already paid
    for once: `emojiTestActive` dismisses on any tap ahead of those surfaces in `handleTouch`, and
    without the refusal a tap on the grid opened over an active keyboard force-repaints the tab
    underneath while `kbActive` stays true, leaving every further tap typing invisibly.
  - **Env beats the picker, and the MENU SAYS SO rather than showing a checkmark it cannot
    honour.** With `DECKHAND_MAC_EMOJI` set to a valid name the submenu parent reads **`Mac icon
    (set by env)`**, followed by the resolved glyph, and every child is disabled — a checkmark a
    click could never move is a lie, while the glyph on the parent is the one thing that can still
    say WHICH icon won without implying a click could change it.
    The menu bar learns both facts from the **host's heartbeat** (`icon`, already fully resolved,
    and `iconFromEnv`), never by reading the plist or launchd's environment, which would be a third
    source of truth after the env var and `~/.claude/deckhand-mac-emoji`. `iconFromEnv` is computed
    by re-running the **same resolver** with the file blanked, so a typo'd env name — which
    overrides nothing, because only a valid name wins — cannot claim an override that isn't
    happening. The `EMOJI <name>` command is host-side only and never forwarded: the device learns
    the icon from `hostEmoji` in the payload, the same way `FORGET` is intercepted.
  - **A dead `macEmojiId` global was removed during this work**: it was written every tick and read
    nowhere, while its comments described a wiring that did not exist. Declared-but-unwired state
    whose comments claim it works is a defect class this repo has already paid for, so it is
    deleted rather than left for the next reader to trust.
  - **OPEN BUG, in already-merged multi-host code and NOT introduced by the icons.** After a
    synthetic `MULTITEST` link drops (`LINK_STALE_MS`, 21s), the **two Claude usage cards freeze on
    a wrong reading** — observed 0% "starts on use" and 4% / 31.93M tok — while the **Codex row
    recovers correctly** with the real Mac's icon and its genuine value. `host.log` confirms the
    real host was reporting 26–27% / 33% throughout, so the numbers on screen were never sent.
    Reproduced across separate sessions, including after two full device reboots. Consistent with
    `usageSourceLink` and `cxSourceLink` ending up pointing at different links after
    `pruneStaleLinks()` and the re-merge, i.e. the `mergeUsage()`/`pruneStaleLinks()` area in
    `deckhand_display.ino` — **not** `usage.ino`'s chrome logic, which only reads those two links.
    Repro: `MULTITEST 2`, wait past 21s for the synthetic link to age out, `SCREENSHOT` the USAGE
    tab, compare against the host log's own `5h=`/`7d=`/`codex=` fields for the same minute. Unfixed and
    undiagnosed: it predates this branch and deserves its own systematic pass rather than a
    side-quest.
  - **The host drops a device line addressed to another Mac BEFORE logging it.**
    `BLECharacteristic::notify()` iterates `getPeerDevices()` and sends per peer with **zero
    references to the server's `m_connId`** — verified in the installed library source; there is no
    single-peer notify in this API — which is *why* every device→host line carries a trailing
    `to=<hostId>`. Without the filter the other Mac logs an authentication failure on **every**
    answer, which trains you to ignore the one log line that means something (the same problem the
    duplicate-`PROMPT` dedup already exists for, but firing constantly instead of occasionally).
    Absent, empty or unparseable addresses read as **BROADCAST**, deliberately asymmetric:
    wrongly dropping an answer strands a blocked prompt, while wrongly accepting one merely logs a
    line twice. Trailing is also deliberate — the host parses with `startsWith` plus a positional
    `split`, so an un-upgraded Mac ignores the extra token instead of breaking on it. `BATT` and
    `HELLO` stay unaddressed on purpose: both Macs want the battery, and an addressed `HELLO`
    would break pairing with a Mac that does not yet know the device's name.
  - **The audio lane is addressed to the Mac on the CABLE (`primaryLink()`), NOT to the target
    session's Mac** — which looks wrong at a glance and is the only correct choice. Audio is
    USB-only by rate (~8KB/s of IMA ADPCM against this CH340's 11.5KB/s ceiling), so with Mac A on
    USB and Mac B on BLE only, stamping `to=B` on a stream opened from a Mac-B session would have
    **A's own `to=` filter drop the whole thing on arrival**: the dictation vanishes with no error
    on either Mac, because the line addressed to B never reaches B. Addressed to `primaryLink()`
    it reaches the one Mac that can physically receive it, and if that Mac does not own the target
    session its own `resolveSessionId` fails and **logs** the miss with the transcript still
    delivered as a memo — a visible failure instead of silence on both.
  - **BLE chunking and what the airtime numbers do and do not say.** noble on macOS does not
    report an MTU (`peripheral.mtu` came back `undefined` against the real device), so
    `BLE_CHUNK_SIZE` stays the module constant **20** — there is nothing negotiated to size
    against. A 779-byte payload (a normal one-session tick) dispatched in **0–1ms** over five
    consecutive ticks, but that is the time to hand chunks to CoreBluetooth, **not** over-the-air
    completion: `sendOverBle` writes `withoutResponse`, and the mac binding fires the JS write
    completion immediately after calling `-[CBPeripheral writeValue:...]`. True over-the-air
    completion is **not observable through that binding at all**, so any future payload growth has
    to be argued against the theoretical bound (~666 B/s at 20-byte chunks and the 30ms interval
    macOS negotiates), never against the 1ms figure. The worst-case device→host line is **286
    bytes** — a typed answer plus the `to=` suffix — which is 15 chunk notifies plus a standalone
    newline notify, the newline sent on its own so neither chunk loop can clip the byte the host's
    line splitter keys on.
  - **`MULTITEST <n>` injects a synthetic second Mac** (`hostId feedfeed`, tag `studio`), which is
    what makes the merge, the cross-Mac ranking, the row and card tags, the freshest-quota pick and
    the stale-link drop verifiable — and screenshottable via `SCREENSHOT` — from one Mac. Same
    precedent as `KBTEST`/`TAB`/`PAGE`, which exist because the glass is otherwise unverifiable.
    Three details are load-bearing: the tag is `studio`, a full **six** characters, i.e. the real
    worst case `macTag()` can emit, so the harness tests the width boundary rather than passing on
    a lucky fit; it carries its own `cxPct`/`cxAgeSec`, or `cxSourceLink` could never pick the
    synthetic link and the Codex row's own tag lane would go unexercised; and it **saves and
    restores `activeHost`** around the injected call, because `feedfeed` matches no pairing slot
    and would otherwise leave the device unable to sign a **real** answer until the next real tick
    restored it (~5s). It can never answer anything itself, for that same reason — no pairing slot
    matches, so `authHmac` refuses to sign, which is the safe direction.
  - **What is NOT verified, stated plainly.** **The two-`conn_id` demux has never run on
    hardware**, and it is this feature's one untested load-bearing path. Two host processes on ONE
    Mac cannot substitute for two Macs: they share a single ACL connection to the peripheral (the
    device logged exactly one `onConnect`), so proving the demux needs a **second radio**. Also
    unverified by execution: **answering by tapping `Allow` or `SEND` on the glass**, because this
    codebase deliberately has no remote trigger for either — `KBTEST` can open the keyboard and
    type but explicitly cannot SEND — so the answer path, including the 286-byte worst-case line
    above, was checked by inspection only.
  - **SUSPECTED and uninvestigated: per-reconnect listener accumulation in `host/index.mjs`.**
    During reconnect-heavy testing the host log showed `MaxListenersExceededWarning` alongside
    repeated BLE write timeouts, which *suggests* listeners accruing on the `txChar.on("data")`
    path across reconnects. It is pre-existing, it was not investigated, and nothing here diagnoses
    it — recorded so the next person to see those two symptoms together starts from a hypothesis
    instead of from scratch.
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
  **Every string is measured or wrapped against the card's text lane, and skipping that is what
  made the text look like it overlapped the dialog.** Each line used to be one centred
  `drawString` with no width given, so a note wider than the card ran past both edges - three of
  the four were, up to 228px against a 212px interior. `drawString` paints an OPAQUE background
  box, so the overflow did not merely spill: it rubbed out the card border it crossed. The note now
  goes through `drawWrappedText` bounded to `CARD_W - 2*SP_3` (192px), the emphasis line through
  `fitText`, and the title renders in `T_HEAD` where the longest ("Recalibrate touch?") is 180px
  and fits.
  The three text elements are laid out as ONE BLOCK and centred in the space above the buttons,
  rather than pinned to hand-picked offsets - so a one-line note and a two-line note both sit
  correctly, instead of one being right and the other tuned to match. Measured clearance above the
  button row is 11-27px across all four dialogs.
  **CANCEL is the FILLED button and the action is only outlined** in its severity colour: the safe
  option should be the prominent one, and a destructive choice should not also be the easiest thing
  to hit. Both pass `COLOR_CARD` as their backdrop, because they sit ON the dialog - the default
  `COLOR_BG` gave their anti-aliased edges a fringe of the page background against the card.
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

- **Codex support is PUSH via hooks, with PULL retained as a fallback.** Claude Code
  state arrives because `deckhand-session-hook.mjs` is *invoked* on every event; Codex
  now gets the identical treatment — `install.sh` registers that same hook with Codex
  CLI (0.147.0+, `--agent=codex`), so a Codex thread pushes its own status and can be
  answered from the device exactly like a Claude Code session. The host also still
  reads Codex's rollout files directly, as a fallback for installs where Codex's hooks
  trust prompt hasn't been accepted yet (or on Codex versions older than 0.147.0) — see
  below for how that pull path works and what it can't do (no NEEDS INPUT, no
  answering, and an ended thread still ages out over ~20 minutes rather than vanishing
  at once).
  Codex had no hooks mechanism at all when this integration was first written; the
  investigation below (all measured on 0.147.0, not inferred) is what established a
  hooks-based push was possible, and it's kept as the record of how that was verified:
  Codex CLI **0.147.0** ships a hooks system that closely mirrors Claude Code's -
  confirmed from the binary's embedded JSON schema and its own validation strings, not
  from docs. Config lives in `~/.codex/hooks.json` (also project-local `.codex/`, plus a
  managed dir), and the events are `pre_tool_use`, **`permission_request`**,
  `post_tool_use`, `pre_compact`, `post_compact`, `session_start`, `session_end`,
  `user_prompt_submit`, `subagent_start`, `subagent_stop`. The decision contract matches
  too (`PermissionRequestDecisionWire`, `PreToolUseHookSpecificOutputWire`, with
  `continue`/`stopReason`/`suppressOutput`/`systemMessage`), and it even reads
  `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` - deliberate compatibility with Claude Code's
  hook ecosystem.
  **VERIFIED by running it, not read off the binary.** A capture hook registered in
  `~/.codex/hooks.json` (Claude-style: keyed by PascalCase event names, `matcher` plus
  `hooks:[{type:"command",command}]`) produced these real payloads:
  ```
  {"session_id":..,"transcript_path":"..rollout-...jsonl","cwd":"/private/tmp",
   "hook_event_name":"SessionStart","model":"gpt-5.6-sol",
   "permission_mode":"bypassPermissions","source":"startup"}
  {"session_id":..,"turn_id":..,"hook_event_name":"PreToolUse","tool_name":"Bash",
   "tool_input":{"command":"echo deckhand-probe"},"tool_use_id":"exec-.."}
  ```
  The field names are **identical to Claude Code's**, down to the tool being called
  `Bash` - `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
  `tool_name`, `tool_input`, plus `turn_id`/`permission_mode`/`tool_use_id`. So
  `deckhand-session-hook.mjs` reads the right fields ALREADY; this is far closer to a
  registration exercise than a port.
  Two things that are not yet settled, and both matter before building:
  - **`PermissionRequest` IS captured, from a real interactive session:**
    ```
    {"hook_event_name":"PermissionRequest","tool_name":"Bash","permission_mode":"default",
     "tool_input":{"command":"curl -sI https://example.com | head -1",
                   "description":"Allow this read-only network request to example.com .."},
     "session_id":..,"turn_id":..,"transcript_path":..,"cwd":"/private/tmp"}
    ```
    `buildAsk()` already reads exactly `tool_name` + `tool_input.command`, so it yields
    "Allow Bash?" with the command as detail **with no changes at all**. Codex also
    supplies a `description` saying WHY approval is needed, which Claude Code does not -
    worth showing. Note the observed order: `PreToolUse` -> `PostToolUse` with an EMPTY
    `tool_response` (the sandboxed attempt failed silently) -> `PreToolUse` again ->
    `PermissionRequest`. Codex tries, gets blocked, then escalates - so a naive reading of
    PostToolUse would record a "completed" tool call that never ran.
    It cannot be captured from `codex exec`, which forces
    `permission_mode: bypassPermissions` regardless of `-c approval_policy`.
    **PROVEN end to end:** feeding that captured payload to the UNMODIFIED
    `deckhand-session-hook.mjs` (throwaway `$HOME`) produced
    `status:"asking"` with `ask:{kind:"perm",title:"Allow Bash?",detail:"curl -sI ...",
    options:["Allow","Deny"],answerable:true}` and an empty stdout.
    **The DECISION dialect is round-tripped too, against a live session.** A one-shot hook
    emitting Claude Code's exact shape -
    `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":..}}}`
    - was honoured: Codex blocked the command and fed our message back to the model as the
    tool result, which appears verbatim in its own rollout as a
    `custom_tool_call_output` ("Deckhand round-trip test: denied by the hook."), after
    which the assistant reported it could not run. So **every** piece of the answering
    path is verified end to end: event, payload, ask construction, and decision.
    **Design snag to solve first:** a Codex hook writing into
    `~/.claude/deckhand-sessions/` would DOUBLE-COUNT, because the host also pulls the
    same thread from its rollout. Either the pull skips hook-covered sessions or the two
    are merged by id.
  - **The TRUST GATE is real, and it is what makes hooks safe.** Measured A/B: two
    identical runs, hooks fired ONLY with `--dangerously-bypass-hook-trust`. An untrusted
    `hooks.json` is inert - which also means a stray one cannot run behind your back, and
    that shipping this needs a real trust step, not the bypass flag. The interactive TUI
    is where that step happens: it shows "Hooks need review / Hooks can run outside the
    sandbox after you trust them" with **Trust all and continue** / Review hooks /
    Continue without trusting, and a hook sits at "New hook - review required" (or
    "Modified since last trusted") until accepted. So installing this cannot be silent -
    the user has to agree once, per change to the hook.
  What that unlocked, and now ships: **Codex prompts can be answered from the device**,
  because the device is already agent-agnostic - it renders whatever `ask` object is in a
  session record and signs answers with the pairing key regardless of which tool asked.
  The implementation is a Codex-flavoured sibling of `deckhand-session-hook.mjs` - the
  *same file*, invoked with **`--agent=codex`**
  (`claude-hooks/install-codex-hooks.mjs` registers that command in `~/.codex/hooks.json`
  for `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop`, and
  `SessionEnd` - deliberately **not** `PreToolUse`, which on Codex fires for every tool
  call with nothing to matcher-filter it against, unlike Claude Code's
  `AskUserQuestion|ExitPlanMode` matcher). `SessionEnd` deletes the *pushed* record at
  once — but `readCodexSessions()` still admits that thread's rollout file for up to
  `SESSION_STALE_MS` (20 min) afterward, and `mergeById()` (`host/sessions-merge.mjs`)
  only lets a hook record SHADOW a pull record while both exist; once the hook record is
  gone there is nothing left to shadow, so the rollout-derived row survives as `waiting`
  until it ages out on its own. So a hook-covered Codex thread's pushed record disappears
  at once, but the thread's row on screen can still linger up to ~20 minutes on the pull
  fallback before it clears — `SessionEnd` narrows the PULL path's ghost-session window,
  it does not eliminate it.
  **The `hooks.json` key for a hook's own timeout is `timeout`, not `timeoutSec` - this
  was established by experiment, not inference, and it is exactly the kind of thing a
  future maintainer "fixes" into broken code.** Codex's `HookMetadata` struct (the
  metadata/API type) lists `timeoutSec`, and it is tempting to assume `hooks.json` takes
  the same field name. It does not: a hook made to sleep 10s under `{"timeout": 3}` was
  **killed** at 7s elapsed, while the identical hook under `{"timeoutSec": 3}` **ran to
  completion** at 14s elapsed - `timeoutSec` in `hooks.json` is silently ignored, so a
  "harmless" rename would quietly remove the 100s ceiling and let a hung hook block the
  triggering tool call indefinitely. `install-codex-hooks.mjs` and
  `codex-hooks.snippet.json` both correctly use `timeout`; keep it that way.
  Hooks are **trust-gated** (`hooks.state`) and do nothing until the user accepts Codex's
  own "Hooks need review" / "Trust all and continue" prompt, so a fresh install or an
  untrusted Codex is not silently broken: the PULL path described below still runs
  unconditionally and covers exactly that gap - an unaccepted trust prompt costs "no NEEDS
  INPUT and a 20-minute-stale end", never invisibility.
  Because push and pull both run, the same thread can arrive from both, and the host
  merges them by id (`host/sessions-merge.mjs`), hook record winning on a collision (it is
  the only one push-fresh and the only one carrying `ask`). **The merge key is truncated
  to 12 characters on both sides before comparing** - `readCodexSessions()` (the PULL
  reader) has always kept only a 12-char id, the same length the device itself keys rows
  on, while a hook record carries Codex's full UUID; comparing the raw strings would never
  match and the merge would silently do nothing, which looks exactly like the bug it
  exists to prevent.
  **The hook-expiry question is UNVERIFIED, not resolved - see Risk 2 in
  `docs/superpowers/specs/2026-08-13-codex-answering-design.md`.** Whether a
  `PermissionRequest` hook that times out falls through to Codex's own approval prompt
  (safe, like Claude Code) or resolves as a denial (unsafe, since an unanswered prompt
  would then default to blocking every command) cannot be tested non-interactively:
  `codex exec` forces `permission_mode: bypassPermissions` regardless of
  `-c approval_policy`, so `PermissionRequest` never fires outside the interactive TUI, and
  there is no scriptable way to drive that TUI through a real approval and a real timeout.
  In ordinary operation the risk is bounded regardless of the answer: the hook self-exits
  at 90s (`REMOTE_WAIT_MS`) comfortably inside the 100s `timeout` the registrar sets, so
  expiry is reachable only through a pathological overrun (a wedged device, a host that
  never comes back), not routine slowness. The spec records the exact manual experiment
  (shorten the timeout, stop the host, drive a real prompt from the interactive TUI, watch
  what happens at expiry) that would close this out; it has not been run.
  The rest of this section describes the PULL path, which now serves as the fallback for
  untrusted installs. Verified against real rollouts on this machine:
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
  - **A Codex row can now show `asking` and be answered — that was the whole point of
    building the push path above.** The PULL reader described in this bullet still can
    only ever produce `working` or `waiting` on its own: no approval event appears in any
    rollout on this machine, so there is nothing here to map to `asking`. What changed is
    that this is no longer the only source - the hook-pushed record supplies `asking` and
    wins the merge whenever Codex's hooks are trusted, so a live thread with a pending
    approval shows NEEDS INPUT and can be answered from the device exactly like a Claude
    Code session. An install where the trust prompt hasn't been accepted yet falls back to
    this PULL path alone, degrading to the old working/waiting-only behaviour rather than
    losing the thread entirely.
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
  `HISTORY <id12> <chat|all> <page|last|item:N> [<cols>x<lines>]` and the host replies with ONE JSON line
  whose only key is `hist`, so it can never be confused with a tick payload (the device
  bails out of the parser before any usage field is touched).
  **The `<cols>x<lines>` token is the DEVICE stating its own budget, and it is optional so an
  un-upgraded device keeps working.** Absent (or out of range) the host falls back to
  `HIST_LINE_CHARS = 36` / `HIST_PAGE_LINES = 16`, which *is* board 1's existing behaviour — so no
  protocol version bump was needed, the same backward-compatibility shape as the trailing
  `to=<hostId>` address. It exists because those two constants were hardcoded to board 1's 216px
  column, and a board with an 18-line/37-column reader could therefore never fill a page while
  nothing on either side reported an error.
  **The device stores only the screen it is showing.** Measured on a real transcript: 2515
  entries / 584KB, of which the conversation alone is 122KB, against ~70KB of free heap
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
    BLE writes go out in 20-byte chunks (`BLE_CHUNK_SIZE`), so at the 30ms connection
    interval macOS negotiates the theoretical ceiling is ~666 B/s and a few KB is seconds
    **on the air**. That RATE is the reason USB wins. This note used to say each chunk
    awaited a response, and that is simply false: `sendOverBle` passes noble's
    `withoutResponse` flag (`writeAsync(chunk, true)`), so the host is **not** blocked
    behind the radio — and for the same reason over-the-air completion is not observable
    through that binding at all (see the two-Mac airtime note). Do not restore the
    blocking claim; the conclusion never needed it. Both transports reach the same device.
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
  measurement and "never measured" is not.
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

**The menu-bar app must drive launchd, not go around it, and going around it fails
quietly.** `mac-app/DeckhandMenuBar.swift` used to start/stop with `pkill` + `open` and
carried its own watchdog. Once the `KeepAlive` LaunchAgent exists that is actively
wrong: a `pkill` stop is undone within ~1s (measured - pid 48211 came back as 48230),
so **Stop looks broken**; an `open` start launches a host OUTSIDE launchd while launchd
may spawn its own, giving two processes contending for one serial port; and the app's
watchdog becomes a second supervisor racing the first. It now shells out to
`deckhand-service.sh start|stop` when `~/Library/LaunchAgents/com.deckhand.host.plist`
exists, and suppresses its watchdog in that case - launchd restarts a dead host within
a second and survives reboots, which the app cannot. Unsupervised, the old path and the
watchdog both remain, because there is then nothing else doing the job.

**What the menu-bar ITEM shows: shape is the link, badges are the device's job when
the device is absent, and colour carries nothing at all.** The boat is `.solid` when a
device is actually connected and `.outline` when it is not (`barBoatStyle`) - it stands
for the LINK, not the process, which is why it no longer keys off `running`. Beside it,
left to right: quota `5h·7d`, then the live sessions BY STATUS in the host's own urgency
order - `■1` needing input, `○1` waiting on you, `●1` working. Those three PARTITION the
list the way the menu's rows do, one glyph per session, so `■1 ○1 ●1` is three sessions
and reads as three; `●` briefly meant "every live session" and was split when waiting
arrived, because a total that already contains the badge beside it invites adding them
up. The usage and session badges are the device's USAGE and SESSIONS
tabs standing in for a screen that isn't there, so by default they appear only while no
device is connected and go quiet when one is back; the needs-input badge is not gated
that way, because a prompt blocking your work is worth saying either way. Absent is
always the resting state - no badge at zero, and none at all from a stale host, since
`readStatus` only reads the log while the heartbeat is fresh.
Four things are load-bearing:
- **`contentTintColor` is `nil`, deliberately, and grey/orange tints were REMOVED
  rather than fixed.** They never reached the screen: with the host running and no
  device the bar drew a BLACK boat, not an orange one, because macOS renders a status
  item's template image in its own menu-bar colour - which over a light-ish wallpaper is
  black even in Dark Mode - and that overrode the tint. A colour that is silently
  ignored is worse than no colour. Cost, accepted: stopped and device-offline both draw
  the hollow boat, and only the menu's status line ("Stopped" vs "Running · device
  offline") tells them apart.
- **Numbers next to each other need SHAPE to separate them**, which is why the
  needs-input count gained a `■` when the session counts arrived - the same three glyphs
  the menu's rows and the device already use, now meaning exactly what they mean there.
  Each badge is omitted at zero, independently, so an absent `○` says "none waiting"
  rather than "not shown" - which only holds because the whole label is empty at rest.
- **Monospaced DIGITS (`F_BAR`), not cosmetic.** These percentages are rewritten every
  few seconds and a proportional font shifts the item's width on every digit change,
  nudging every other menu-bar icon sideways on a timer.
- **The four toggles under `Menu bar shows` read `object(forKey:) as? Bool ?? true`, not
  `bool(forKey:)`.** `UserDefaults.bool(forKey:)` returns FALSE for a key nobody has
  written, so reading it directly would ship an app whose bar is blank until three things
  are switched on by hand. `--menu-dump` prints the composed label and the submenu's
  checkmarks, which is the only way to verify any of this without eyes on the bar -
  `screencapture` needs a TCC grant the host process doesn't have.
- **Clicking a session row JUMPS TO THE APP that owns it, and which app that is comes out
  of the ENVIRONMENT rather than any search.** The hook is a child of the `claude` process,
  so it inherits `__CFBundleIdentifier` (the bundle that launched Claude Code - VS Code,
  a terminal, the desktop app; the actionable half, since NSWorkspace resolves it) and
  `CLAUDE_CODE_ENTRYPOINT` (Claude Code's own name for the surface, e.g. `claude-vscode`).
  `owningApp()` reads exactly those two, so identifying the app costs two env lookups and
  NO child processes on a file that runs for every tool call in every session on the
  machine. Verified by running the same read from a child of a live session.
  Two other routes were tried and rejected: `lsof` on the transcript finds nothing, because
  Claude Code appends and closes rather than holding an fd, so there is no pid-to-session
  mapping there; and walking the parent chain with `ps` does work (every live `claude`
  traces to its host app) but costs several spawns per lookup for an answer the environment
  already has.
  The click resolves in three tiers (`sessionTarget`), because "jump to the app" means
  different things per surface: an EDITOR session opens its workspace folder with that app,
  which brings the existing window forward; a terminal or the desktop app is merely
  ACTIVATED, since there is no way to focus one terminal tab and opening the folder would
  spawn a new window; and an unknown or not-running app REVEALS the folder in Finder as
  this menu always did. The not-running check is load-bearing - without it, clicking a
  stale row would LAUNCH an editor for a session that no longer exists in it.
  **The folder to open is the LOCK FILE's workspace, never the session's own path.** A
  session's `path` is its live cwd and is routinely a subdirectory (this repo reports
  `.../deckhand/host`), and opening that in VS Code spawns a NEW window on the subfolder
  instead of focusing the one already open. `~/.claude/ide/<port>.lock` is written per
  WORKSPACE - two windows on different folders give two locks sharing one pid - and carries
  `ideName`/`workspaceFolders`, so it is both the window picker and the source of the full
  path. That last part matters because the host's `truncatePath` prefixes `...` past 64
  characters, and **a plain suffix test does not recover those** - measured, on a crafted
  case that failed: truncation can begin INSIDE the workspace folder, so neither string
  contains the other and the match has to look for a suffix of the folder that is a prefix
  of the kept tail (with a 6-character floor, since a 2-character overlap matches almost
  anything and picking the wrong window is worse than falling back).
  Only surfaces MEASURED to be editors get the workspace treatment; `claude-vscode` is the
  one observed on this machine, JetBrains is included on the same naming pattern and is
  UNVERIFIED, and the values a terminal or the desktop app report are still unknown - no
  such session was running when this was built, and guessing them would be inventing
  behaviour. Anything unrecognised falls through to activate-only, which is safe.
  `--open-session [<id-prefix>] [go]` prints what a click would do for every session,
  resolved by the same function the click calls, and only acts when given `go` - a menu
  cannot be clicked from a script or screenshotted, so the whole path is otherwise
  unverifiable by hand. The row TOOLTIP is generated from that same resolver, so it can
  never promise Finder and then open an editor.
- **The boat is drawn in the logo's mid-blue and is therefore NOT a template, and the
  colour was measured, not chosen.** `isTemplate` is what strips colour - as a template
  macOS renders the shape in its own menu-bar colour and discards ours, which is why
  `contentTintColor` did nothing - so a colourful icon is exactly an icon that gives up
  following the system. That means it must stand on its own against BOTH bars.
  `DECK_BLUE` (#2F76B8, the midpoint of the tile gradient in `docs/logo.svg`) scores
  **3.01** against a dark bar and **4.37** against a light one, clearing Apple's 3:1
  non-text threshold on each. Every other logo colour fails one side: #1B5FA6 drops to
  2.21 on dark, #4C9BE0 to 2.72 on light, and the cream #FBF4E9 to **1.00** - invisible -
  which is what killed the obvious "cream sails, blue hull" two-tone, since half the boat
  would vanish depending on the wallpaper. Re-measure before changing it.
  `Settings › Colourful icon` (default on) returns the monochrome template, which is not a
  lesser fallback: it is the only version that follows light and dark bars, and which one a
  wallpaper favours cannot be decided from the code. Two consequences worth knowing: a
  coloured image does NOT invert to white while the menu is open and the item is
  highlighted (it sits on the highlight tint, like every other coloured menu-bar icon),
  and `--icon-preview` now renders colour rows AS-IS while still faking the system tint for
  the template rows - painting our own tint over a coloured icon would show a colour the
  bar never renders.
- **The menu is grouped by KIND: the top level is actions, `Settings ▸` holds every
  preference.** Answer-prompts, Menu bar shows, Needs-input sound and Launch at login used
  to sit in the top-level row, which had grown to three consecutive submenus and pushed
  Quit down the menu with nothing saying which items merely change a setting and which
  one stops the host. The moved items need `target = self` and explicit `isEnabled` set by
  hand - `buildMenu`'s loop only walks the top-level `items` array, and the submenu
  PARENTS have a nil action, which that loop's "an item with an action is a control" rule
  would read as informational and dim. `Settings` stays enabled with the host DOWN (a
  preferences door that only opens while a background process is alive is its own bug),
  while `Device` and `Answer prompts on device` dim with it, since neither can do anything
  without the host.
- **The quota rows say when they are STALE, and the age comes from the host rather than
  being re-derived.** `quotaAgeSec`/`cxAgeSec` are computed by the host (it owns the
  oauth-vs-cache choice) and now ride the tick LOG line as `qage=`/`cxage=`, because that
  line is the Mac's only view of the numbers - the menu could otherwise show a percentage
  frozen by a long OAuth back-off as though it were live. Past `QUOTA_STALE_SEC` (900, the
  same threshold the firmware dims its hero number at) the row dims and appends
  `· stale 3h`, and the usage note is SUPPRESSED: "97% used" from an hour ago is not a
  crisis to colour red, it is a number we cannot vouch for. Each row carries the age of
  ITS OWN source - hanging the Codex row off the Claude quota's age was a real device-side
  bug and is not repeated here. Deriving the age Mac-side from a file mtime was rejected:
  it would put the "which reading is authoritative" decision in two places.
- **THE PACE TICK CROSSED TO THE MAC, on both surfaces, because a percentage alone cannot say
  whether you are burning it faster than the clock.** That is the whole reason the device draws
  `drawPaceBar`, and it was just as true of a menu showing the same number. `pacePct` is the
  device's own arithmetic (`100 - resetInMin * 100 / windowMin`, integer division and all, so the
  two surfaces cannot round differently), and it is ONE function feeding three renderings — the
  bar label's glyph, the menu row's tick, and the tooltip's sentence — because a pace that
  disagreed with itself between two rows of one menu would be worse than no pace.
  The windows: 5h = 300 and 7d = 10080 are fixed by the plan and hardcoded, since the tick line
  publishes only how much is LEFT; **Codex's is parsed off the line** (`codex=44%/7d`, which the
  host already prints), and when it is absent that row draws its fill with **no tick** rather than
  assuming seven days — a mark at a position nothing measured is the one thing this must not do.
  - **A STALE reading keeps its digits and loses its pace, on both surfaces.** The comparison is
    against a clock that has kept running while the percentage has not, so the tick and the glyph
    are suppressed rather than corrected. The reading's own age is otherwise NOT subtracted from
    `reset`, and the bound is what makes that a decision: the OAuth poller runs every 5 minutes, so
    the error is at most 1.7 points on the 5h window and 0.05 on the 7d — both inside the deadband,
    i.e. too small to change anything drawn.
  - **`PACE_DEADBAND_PCT` (5) is not a fudge factor.** With an exact comparison, a percentage
    sitting perfectly still (nobody working) still gets overtaken by the clock, so the glyph would
    flip from ▲ to ▼ on a timer with nothing happening — in a menu bar, refreshed every 5s. 5
    points is 15 minutes of the 5h window.
  - **THE TICK IS INSERTED BETWEEN CELLS, NEVER WRITTEN OVER ONE, and the live host caught the
    first version inside a minute.** At 1% used the fill is a single cell and the pace was 3%, so
    the mark landed on cell 0 and replaced the only ink in the bar — `▕░░░░░░░░░`, which reads as
    *nothing used*, exactly the claim the "1% must always show a cell" rule exists to prevent. The
    arithmetic was right and only the LOOK was wrong, which is why it would have survived review.
    Inserting costs one character of width and loses no fill at any percentage; a bar with a pace
    is 11 cells and one without is 10, deliberately, because padding the pace-less case with a
    blank would put a blank exactly where a 0% tick goes.
  - **A DISABLED MENU ROW IS DRAWN AT ~31% OF FULL STRENGTH, WHICH MADE EVERY READING GREY — AND
    BOTH INSTRUMENTS SAID IT WAS FINE.** This is the most important entry on this page about the
    menu, because the defect was reported by a person looking at the glass after two instruments
    had passed it.
    - **The mechanism.** `buildMenu`'s rule is `it.isEnabled = it.action != nil` — an item with no
      action is information — so the quota rows were disabled. AppKit composites a disabled item's
      **attributed** title at reduced opacity, so `.labelColor` (α 0.847) lands at **0.27**, which
      *is* `.tertiaryLabelColor`. Grey. **No colour can fix it while the row is disabled**, because
      `.labelColor` is already the strongest text colour macOS has — the ceiling is grey by
      arithmetic.
    - **MEASURED TWO WAYS THAT AGREE, rather than inferred.** A throwaway probe popped a real menu
      holding two **byte-identical** attributed titles differing only in `isEnabled`; captured, the
      peak-ink ratio over the menu backdrop was **0.317**. Independently,
      `disabledControlTextColor.alpha / labelColor.alpha` = 0.247/0.847 = **0.292**. The captured
      figure is the one used, being the behaviour rather than a proxy for it.
    - **What it did to colours chosen against the preview:** the percentage 0.847 → 0.27, the `5h`
      label 0.498 → 0.145, and **the bar track 0.259 → 0.076 — fainter than the
      `.quaternaryLabelColor` (0.098) that had just been rejected for being too faint.** Every
      value in the block was crushed by 3.2x.
    - **THE ROOT CAUSE WAS THE INSTRUMENT, not the colours.** `--menu-preview` drew every row at
      full strength regardless of `isEnabled`, and `--menu-dump` prints `.string` and drops colour
      entirely — so a track was tuned on a render that could not show the thing being tuned. The
      preview now applies `DISABLED_INK_RATIO` to each run's alpha. **An instrument that flatters
      is worse than none**, and this is the second time that exact sentence has been earned here.
    - **The fix is to ENABLE the rows that carry a reading** (`q5`, `q7`, `cxLine`, `battLine`,
      `statusLine`, `deviceLine`), which is a deliberate exception to the action-implies-control
      rule. **Cost, accepted:** those rows now highlight under the cursor — **measured, not assumed**
      (a probe popped a menu of enabled nil-action rows, warped the cursor onto one and captured it
      highlighted blue; note a `CGWarpMouseCursorPosition` alone is NOT enough, since menu tracking
      updates its highlight from mouse-moved EVENTS, so one has to be posted). A click dismissing
      the menu and arrow-key navigation stopping on these rows follow from their being enabled and
      are **expected rather than measured**. That is exactly the "silently dead item" the rule
      guarded against; an unreadable reading is the worse failure. The `SESSIONS` header is
      deliberately NOT in that list: it carries no reading, and dim is what says so.
    - **`--legibility-check` names the invariant** and identifies the rows **by reference, not by
      matching their text**: a row's job is a property of what the code put in it, not of whether a
      percent sign survived into the string. Reverting the fix fails it by name, three rows at once.
    - **`--menu-shot` captures BY WINDOW ID, never by screen region**, and that is not a
      refinement. The first version guessed coordinates; the menu failed to appear once and it
      cheerfully wrote a PNG of the editor behind it — the same class of lie as the flattering
      preview. It now finds the window this process owns and **fails loudly rather than writing a
      file** if there isn't one. It also means only the menu is in the image, which matters because
      this runs on someone's desktop. Two ordering facts are load-bearing: `popUp` must be called
      from `applicationDidFinishLaunching` (called inline before `run()` the menu silently never
      appears), and the capture must be dispatched BEFORE it, because `popUp` is modal and blocks
      the main thread for exactly as long as the window exists. An 8s timer is the backstop, since
      the failure without it is a menu left open on someone's screen forever.
  - **Stale readings are `.secondaryLabelColor`, not `.tertiaryLabelColor`.** Dimmer than a live
    reading is the point (0.498 against 0.847), but tertiary's 0.259 made the figure itself hard to
    read, and "we cannot vouch for this number" is not the same claim as "you may not read this
    number". The word `stale` beside it carries the meaning; the dimming only supports it.
  - **The sub-line's pace clause is `.secondary` too.** It is the only place the ▲/▼/≈ vocabulary
    is ever spelled out — the bar label has room for the glyph and nothing else — so it is the
    row's teaching text, and at tertiary it was the faintest thing on a row it exists to explain.
  - **THE BAR IS SPLIT INTO COLOURED RUNS — `quotaBarRuns` returns `[(String, BarRole)]` — because
    FILL, TRACK AND TICK ARE THREE ROLES, AND EACH NEEDING ITS OWN COLOUR WAS LEARNED TWICE.**
    An attributed run is one colour by definition, so a run that spans two roles makes colouring
    them apart impossible; splitting is the whole mechanism.
    - **The TICK, first.** Inheriting the fill's colour made it a red line among red blocks,
      findable only as the notch its own cell's background happened to make. It means "now", which
      is not a status, so it takes a neutral secondary grey against a fill that may be red or
      orange.
    - **The TRACK, second, and this one SHIPPED for months.** The function split at the tick
      ALONE and returned `(pre, tick, post)`, each of which could carry both `█` and `░` — so
      `quotaTitle` drew every cell in the usage colour, putting the empty track in that colour at
      25% coverage immediately beside the fill at 100%. Same hue, adjacent, no boundary: the bar
      read as **one grey smear whose end could not be located**, and the tick added for the bullet
      above was invisible inside it. Fill and track differ in INK, not in shape (which is why
      `▰`/`▱` were rejected), and **ink alone is not separation when both are the same colour** —
      that is the transferable half.
    - **Three roles, three VALUES, and the ordering is load-bearing:** fill at full strength, tick
      a step down (`.secondaryLabelColor`), track a step below that (`.tertiaryLabelColor`). The
      tick must OUTRANK the track it sits in; at the track's own value it goes straight back to
      being findable only as a notch, i.e. the first bullet's defect returning through the fix for
      the second. Tried at `.secondaryLabelColor` and rejected on the render for exactly that.
    - **`.quaternaryLabelColor` was the first attempt at the track and is TOO FAINT**, because it
      compounds: a 25%-ink glyph in a ~25%-alpha colour is ~6% effective, and the bar became a
      block floating in blank space — boundary crisp, SCALE gone, and the Codex row at 0% simply
      empty. Menu rows are also disabled, which AppKit may dim further.
    - **THE TRACK STEPS DOWN WITH THE FILL RATHER THAN BEING A FIXED COLOUR**, and this one was
      caught by fault injection before it shipped: a stale reading dims its fill to
      `.tertiaryLabelColor`, so a track fixed there matches it EXACTLY and reproduces the smear on
      precisely the rows whose numbers are least trustworthy. Stale rows take a quaternary track.
  - **THE NUMBER LEADS AND THE BAR FOLLOWS IT.** The row read label → bar → number, so the one
    figure being reported sat downstream of eleven characters of texture, and the pace glyph — a
    statement ABOUT that figure — ended up detached at the right margin with the bar between them.
    It is now label → bold percentage → glyph → bar. `F_MONO_BOLD` is SF Mono semibold at
    `F_MONO`'s size; SF Mono holds one advance across weights, so the `%3d` column padding still
    aligns, and `--pace-check` MEASURES that rather than trusting it.
  - **The pace glyph is NEUTRAL on the menu row, not the usage colour**, for the same reason the
    tick is: it reports a COMPARISON, not a level. In the usage colour a red `▼` sat beside a red
    96% and read as part of the alarm, when `▼` is the *reassuring* half of the pair — the
    percentage is climbing slower than the clock. A colour that inverts the meaning of the glyph it
    paints is worse than no colour on it. The BAR LABEL still fuses glyph to figure in one colour,
    deliberately: it has no room for the words that carry the meaning here.
  - **Staleness is `.secondaryLabelColor`, NOT `.systemOrange`.** Orange is also the 80%-high
    colour, so a stale row was both the loudest ink in the block and wearing the warning colour —
    it looked like an alarm about usage on the one row whose numbers we explicitly cannot vouch
    for. Staleness is an absence of information; it is already said in words and by the dimmed
    figure beside it.
  - **The reset stays on the SUB-LINE, and that is measured rather than preferred.** With the
    number leading, the main row ends around 232px of a 316px lane, so promoting `resets in` up to
    it looks free — but the widest real case, `  resets in 5d 8h`, is 17 monospaced cells ≈ 112px
    against 84px spare. It would wrap, and a wrapped row note gets no indent, which is a defect
    this menu has already been through once.
  - **`--pace-check` asserts the colouring TWICE, because "can be coloured apart" and "IS coloured
    apart" are different claims and only the second is what you see:** that no run carries both
    inks (structural), and that the two inks came out different colours (visual). It runs over
    fresh/high/critical/stale rows, plus an exhaustive sweep of all 101x101 (pct, pace) pairs
    asserting every run is one kind of ink. Both regressions were fault-injected and each fails by
    name — a fixed-tertiary track fails on `stale`, a usage-coloured track fails on four rows.
    **The ORDER and the WEIGHT are asserted separately, and that gap was found by fault injection
    rather than by reading:** reverting the bold face and reverting the number back to sitting after
    the bar BOTH passed all the colour assertions, i.e. the two changes at the heart of the layout
    were uncovered. There are now named claims for each ("the percentage comes BEFORE the bar, not
    downstream of it"; "the percentage is drawn in the bold face", plus a second one checking the
    face is genuinely bold rather than just differently named), and each fails by name when
    reverted.
    It **prints how many assertions it ran** (53 today) rather than having the figure transcribed
    here, for the same reason the geometry checkers parse the constants they certify: a hand-copied
    total drifts the moment anyone adds a case. The sweep counts as ONE assertion — 10,201 passing
    calls would drown the figure, and the claim really is singular — but it names the first
    offending pair, because "somewhere in 10,201" is not a bug report.
- **THE BAR LABEL IS NOW COLOURED, and that does NOT contradict the "no tint, ever" rule above
  it.** The rule is about the TEMPLATE IMAGE, whose colour macOS overrides with the menu bar's own
  — which is why the boat gave up on colour. An attributed string's `foregroundColor` is honoured,
  so each usage figure takes the same threshold `quotaColour` the menu rows use (factored out of
  `quotaTitle`, because two copies of a threshold is how a menu ends up calling 95% critical while
  the bar an inch above it looks fine). They are SEMANTIC colours, so they follow a light bar and a
  dark one. **The two session counts stay monochrome on purpose**: ■ ○ ● are already separated by
  shape, and hue on top of that is decoration — where a percentage has no shape to spare, so
  colour there is an accent on a figure that already states the fact in digits.
- **Two of the three defects in that work were caught by LOOKING, not by reading**, which is why
  `--menu-preview` now renders the bar label as its own band above the menu: `--menu-dump` prints
  `.string` and drops every colour. (`screencapture` was believed unavailable to this process for
  a long time and is NOT — see `--menu-shot` above; the render still earns its place, because it
  shows both appearances side by side where a capture shows only the one the Mac is set to.) What the render caught: the overwritten cell above; the row note WRAPPING onto a third
  line with no indent (the indent is a literal `\n      `, and a soft wrap gets none), which is why
  the verdict reads `ahead of pace` and not `ahead of the clock` — 53 characters wrapped, 41 fits;
  and an unspaced separator sitting hard against the glyph before it (`96%▲·50%`), which reads as
  one number that has come apart rather than two figures.
  `--pace-check` is the repeatable half — a glance is not — and it **names the regressions rather
  than merely covering them**: reverting the tick to overwrite a cell fails three assertions
  including "1% used keeps a filled cell even with the tick on top of it". It also caught a wrong
  expectation of mine (176m of 300 is 42% elapsed, not 41 — the division truncates), which is the
  cheapest possible place to find out that the Mac and the device round differently.
- **Session titles are clipped at 39, ONE LESS than the host's own 40-character slice, and
  that off-by-one is the point.** A title arriving at exactly 40 cannot be told apart from
  one cut there, so clipping at 40 saw no overflow and left a hard mid-word cut on screen
  ("...recommendations API wor"); one character shorter sends every at-the-cap title
  through `clip`'s word-boundary path so it ends in an ellipsis that says "there is more".
  The row's tooltip carries MODEL and BRANCH - the two facts the row cannot fit and
  nothing else on the Mac shows - and deliberately not the title, which would only repeat
  the same clipped string. `--menu-dump` prints tooltips, since a menu that cannot be
  screenshotted leaves hovering by hand as the only other check.
- **The Mac plays a sound on the EDGE into `asking`, and `AskWatcher` is keyed by session
  ID for the reason the device's beep budget already documents**: two sessions on one
  project share a name, and name-matching made an asking session look newly-asking on
  every poll - here that would be a noise every 3s. Ids that stop asking are forgotten, so
  an answered session that asks again is announced again, and **the first refresh only
  PRIMES**: whatever is already asking when the app launches is not news, and without that
  every relaunch (the login item after a reboot included) would sound off about a backlog.
  One sound per refresh no matter how many arrive at once - two identical alerts a
  millisecond apart is just noise. The `Needs-input sound` submenu offers Off plus four
  system sounds, defaulting to **Submarine** (theme aside, Basso and Sosumi read as
  ERRORS, and a prompt is not an error); picking one plays it, because a name tells you
  nothing about a sound. `--sound-check [play]` verifies all of it with no prompt and no
  hardware: it resolves every candidate name (a sound dropped by a future macOS must fail
  there, not silently at 3am) and drives the watcher through launch-with-one-asking, the
  same one sitting there, a second arriving, all clear, the first asking AGAIN, and two at
  once.

**All host runtime state lives in ONE PER-USER directory, `/tmp/deckhand-<uid>/`
(`RUNTIME_DIR`), and the per-user part is load-bearing on a shared Mac.** It used to sit
at fixed `/tmp/deckhand-*` paths, which collide two ways. The second user's host cannot
write files the first user created (they land mode 644, owned by whoever got there
first) - and far worse, the second user's session HOOK read the FIRST user's heartbeat,
concluded a display was connected, and blocked up to 90s on every permission prompt
waiting for a device belonging to someone else. The directory is mode 0700, so another
account cannot even read it. Contents: `host.log` (+`.1`), `host-alive`,
`oauth-usage.json`, `oauth-backoff.json`, `oauth-attempt.json`, `mic.wav`.
**`host/index.mjs` and `claude-hooks/deckhand-session-hook.mjs` derive this path
independently and the two MUST stay identical** - they cannot import from each other,
since the hook is copied into `~/.claude`. Get it wrong and remote answering stops with
no error at all: the hook reads a heartbeat nobody writes, decides no display is
present, and simply never offers the buttons. `DECKHAND_TMP` overrides the whole
directory (used verbatim) and remains the test seam. launchd's own stdout/stderr
deliberately go to `~/Library/Logs/` instead, because launchd opens those at SPAWN time
and a missing directory would stop the job starting rather than merely lose its log.

**`host/index.mjs`** polls every `POLL_INTERVAL_MS` (5000ms) for: `ccusage blocks --active`
and `ccusage weekly` (token counts), the rate-limit cache file, and the sessions directory
(pruning any session file older than `SESSION_STALE_MS`, since a closed terminal may never
fire `SessionEnd`). It assembles one JSON object and writes it to USB (if `usbPort` is set) and
BLE (if `bleCharacteristic` is set) independently every tick, and refreshes the
`/tmp/deckhand-<uid>/host-alive` heartbeat (`connected` + `remoteAnswer`) that gates whether the hook
waits for a remote answer at all. The **device→host
lane** exists too: USB serial RX plus a subscription to the BLE TX characteristic's
notifications, both funneled through `handleDeviceLine()` — `ANSWER` lines become answer files
for the hook (deduped, since the device transmits on both transports simultaneously); anything
else is just logged. Session list is capped at 6, **urgency-sorted (asking > waiting >
working, then recency)** so a needs-input session can't be pushed off-screen, with
`sessionsTotal`/`hiddenAsking` telling the device what was cut. Per-session `model` comes from
tailing the session transcript (last 64KB), because most hook events — and desktop-app events
in particular — don't carry a model field. It also writes all `console.log` output directly to
`/tmp/deckhand-<uid>/host.log` via its own file stream (not just relying on stdout), because
`open`-launched apps don't inherit the launching shell's stdout redirection.

**The firmware is SEVERAL `.ino` files in one sketch folder, not one file.** The Arduino build
concatenates every `.ino` in the folder into a single translation unit - the one matching the
folder name FIRST, then the rest alphabetically - so they still share every global and there are
no `extern`s and no build-config changes. (The headers that DO exist - the board headers and the
board-2 panel driver - are a separate thing: they are `#include`d, not concatenated, and the panel
driver's `.cpp` files are deliberately outside this translation unit so a guard can keep board 1
from linking them. See the second table below.) `deckhand_display.ino` keeps the includes,
constants, type definitions, globals, `setup()`/`loop()`, the shared components and the touch
dispatch; the rest is grouped by what it draws:

| file | what |
|---|---|
| `deckhand_display.ino` | types, globals, components, tab bar, record button, setup/loop, protocol |
| `usage.ino` | USAGE tab, Codex row, footer |
| `sessions.ino` | session rows, detail screen, ask/answer |
| `reader.ino` | history browser and full-screen reader |
| `settings.ino` | settings: board 1's four pager pages, board 2's HOME + five groups, steppers, confirm dialog |
| `audio.ino` | mic test, MICREC, streaming capture, voice card |
| `power.ino` | backlight, battery, beeper, volume, sleep |
| `keyboard.ino` | the full-screen QWERTY, typed answers and typed messages |
| `touch_cal.ino` | raw touch, board 1's 5-point affine calibration, orientation |
| `touch_hal.ino` | the ONE touch entry point both boards go through |
| `pairing.ino` | per-Mac NVS key slots and the answer HMAC |

**Not every firmware file is a `.ino`, and the exceptions are deliberate.** The board-2 panel
driver is real C++ in `.cpp`/`.h` files precisely so it does NOT join the concatenated translation
unit — a translation-unit guard is what keeps board 1 from linking it at all, and that guard is
load-bearing (see the legacy-I2C trap under Two boards):

| file | what |
|---|---|
| `board.h` | three lines: picks the board header from `CONFIG_IDF_TARGET_ESP32S3` |
| `board_e32r28t.h` | board 1: pins, capability flags, **every layout constant** |
| `board_es3c35p.h` | board 2: the same, derived natively for 320x480 |
| `panel_shim.h` / `.cpp` | the TFT_eSPI-compatible class: framebuffer, dirty rect, `flush()`, AA primitives |
| `panel_text.cpp` | the shim's text path — `textWidth`, datums, `drawString` |
| `panel_sprite.h` | `PanelSprite`, the `TFT_eSprite` stand-in the crab needs |
| `text_probe.h` | the `TEXTPROBE` string table, and the exact diff procedure for the gate |
| `text-widths-board2.txt` | board 2's half of that gate, committed so the diff is one command |
| `st77922_touch.h` / `.cpp` | board 2's capacitive controller, verbatim from the demo + a TU guard |
| `st77922_init_cmds.h`, `esp_panel_board_custom_conf.h` | the recovered panel init sequence — artefacts, not code to tidy |
| `*-geom-check.mjs`, `geom-common.mjs` | the three LAYOUT checkers (usage/sessions/settings geometry) and their shared header parser |
| `sessions-rank-check.mjs` | checks the asking tie-break (longest-waiting-first); a JS mirror of the sort plus structural assertions on the real source — not a layout checker, so it is not one of the three above |

**The one rule that governs what may move:** Arduino inserts its auto-generated prototypes ABOVE
the first function definition, so a moved function whose SIGNATURE names a type declared after
that point would not compile. `HostPairing`, `Theme`, `Usage`, `SessionInfo` and `ConfirmAction`
are all declared after it. This was checked before splitting and **no function in the sketch names
one of those in its signature**, which is why the split was possible at all - but a future function
that takes, say, a `SessionInfo&` must either stay in the main file or have its type hoisted above
line ~150 first. The split changed the binary by 8 bytes and no behaviour.

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
- **Time remaining on battery is MEASURED, and the noise floor is the whole design problem.**
  There is no coulomb counter here, so runtime left can only come from watching the voltage
  fall - and the sleep report already records what extrapolating a small delta produces: a
  7mV drift over 3 minutes became "-133.7 mV/h", a flat cell in four hours, from noise
  multiplied by 20. So `battMinutesLeft()` (power.ino) reports **-1 until it has earned a
  number**: a 30-slot ring of one-minute samples, and nothing stated until the window spans
  **20 minutes** AND the fall exceeds **25mV**. Three things about it are load-bearing:
  - **`pctFromMv(mv)` was split out of `batteryPct()` so a STORED sample maps through the same
    curve.** The non-linearity lives in that table, so a slope taken in millivolts is not a
    slope in charge - the least-squares fit runs on percentages, not volts.
  - **A NON-NEGATIVE SLOPE MEANS UNKNOWN, NOT "BATTERY FOREVER".** When the backlight blanks
    after 30s idle the load drops and the cell voltage REBOUNDS, so a rising reading is the
    normal consequence of the screen going off. For the same reason the window deliberately
    does **not** reset when the backlight changes: spanning both blanked and lit periods is
    what makes the average reflect how the device is actually used. The ring resets only when
    the state leaves DISCHARGING or the charge rises by >40mV (a data-less wall charger reads
    as DISCHARGING - there is no VBUS-sense pin).
  - **Least squares over the whole window, not endpoint-to-endpoint.** One sample taken while
    the backlight was on sits several mV below its neighbours - more movement than the trend
    itself makes in 20 minutes.
  Shown on **SETTINGS › STATUS** as `42% 3.85V ~5h` (`~95m` under two hours), and nowhere while
  charging or unmeasured - no placeholder, because a number derived from noise is worse than
  none. The padded string is 15 chars ("100% 4.20V ~99h") = 90px in Cozette 6x13, right-aligned
  to x=214 against a "Battery" label ending at 88; `battRowTextCache` went 16 -> 20 because 15
  chars plus NUL fitted the old size EXACTLY, and a cache shorter than its string silently stops
  noticing changes.
- **The `BATT` line goes through `sendLineToHost`, NOT `Serial.printf`, and that is what makes
  the Mac able to show any of this.** Serial reaches the host only over USB, so a battery
  reading could otherwise arrive **only while charging** - exactly when time-remaining is
  meaningless. It now rides BLE too (verified: the first new-format line arrived as
  `[device/ble]`). The line carries `left=` (MINUTES, -1 = not measurable yet), plus `pcth=`
  and `span=` purely as provenance in the host log: `left=-1 span=6` is "still measuring",
  while `left=-1 span=25` says the trend was too flat or rising to state. The host turns -1
  into an **absent** `leftMin`, never 0 - "not measured" and "no time left" are different
  claims - and publishes `batt:{pct,mv,state,leftMin,ageSec}` in the heartbeat, with `ageSec`
  computed on the way out so a stale reading cannot look fresh just because the heartbeat is.
  The menu bar hides the row past 180s of age, since BATT arrives only once a minute and the
  last one starts aging the instant the link drops.
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
- **THE WHOLE AUDIO SECTION BELOW IS BOARD 1, and board 2 does not merely lack a mic — it has a
  BETTER one with no software.** Board 2 carries an ES8311 I2S codec and a speaker amp; every
  constraint that shapes the design below (analog amp into ADC-DMA, mu-law, IMA ADPCM, chunk+ACK
  flow control, the 33.3Hz BLE comb cancellation) comes from a CH340 capped at 11.5KB/s and ~26KB
  of free heap, and board 2 has neither limit. Board 2's own capture path now EXISTS and sends
  linear PCM16 with no codec — see Two
  boards for the pins and for what a board-2 audio path would replace.
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
  16kHz × 16-bit × 5s is 160KB; free heap after BLE is ~70KB, so linear PCM capped a take at **2
  seconds** — too short to reliably catch a sentence. mu-law is logarithmic, keeping fine resolution
  near zero where this quiet signal lives, and 5s costs the same 80KB that 8kHz/16-bit did. Scaled
  ×8 into mu-law's 16-bit input range on the way in (the signal peaks ~150 ADC counts, so scaling
  keeps it clear of the coarsest steps); divided back out host-side.
  - The DC bias must come off **before** encoding — mu-law is non-linear, so there is no re-centring
    it afterwards the way linear PCM allowed. Measured over the first 200ms of frames, not assumed
    to be mid-scale (the real bias is ~1893, not 2048).
  - No digital gain, so the Mac can measure true SNR; scaling for audibility happens host-side,
    after measurement, where it can't flatter the numbers.
  - The 5s request falls back to 4s/3s/2s when the heap won't take it, and reports what it got.
    **~3s is the ceiling as measured today** on this module (ESP32-32E **N4** — 4MB flash, no
    PSRAM), not a preference. It was 4s when this was written; the heap has been eaten since by
    features that grew `SessionInfo` (askDetail alone is 1424 bytes x 6). **Re-measure rather than
    trusting this number** - trigger `MICREC` and read the `AUDIO note: only Ns fits in heap (N
    free)` line, which is the only honest source.
  - **`ESP.getFreeHeap()` is a SUM, and the capture buffer needs a CONTIGUOUS block, so the two
    disagree in the direction that matters.** Measured: a device up for hours reported **42,864
    free** and `MICREC` failed outright with `out of heap`, while a freshly booted one reported
    only **26,028 free** and allocated successfully. Fragmentation, not exhaustion. So an
    `out of heap` with a comfortable-looking free figure is not a contradiction to explain away -
    it is the expected shape after uptime, and rebooting is the fix rather than a bigger number.
- **Polling the stop-tap is NOT the same job as repainting the meter, and sharing a timer made
  stopping feel broken.** `micStream` had its `ts.touched()` check nested inside the 120ms meter
  repaint, with the two-consecutive-reads debounce on top - so a stop cost 120ms at best and 240ms
  at worst, and, far worse, a tap whose contact did not span two polls 120ms apart reset the vote
  count and did **nothing at all**. A normal tap is 80-150ms, so that happened often, and it reads
  as an unresponsive button rather than a slow one. `micMonitor` had always done it correctly (10ms,
  two votes); the streaming and one-shot paths now match it. The poll gate is **10ms, not 20**:
  the loop already turns over every ~16ms (a 1024-byte `conv_frame` at 32kHz x 2 bytes), so a 20ms
  gate would fire on every OTHER iteration and quietly cost 64ms for two votes. Two votes now cost
  ~32ms and a normal tap spans 5-9 polls. The debounce itself is unchanged - still two consecutive
  reads, which is what stops a single spurious `ts.touched()` ending a 99s take.
- **Recording is user-terminated and shows a live meter.** Tap the floating button to start, tap
  again to stop; it also stops when the buffer fills, and the log says which (`AUDIO stopped by
  tap|buffer full`). A fixed length is the wrong default for dictation. Meter and transfer progress
  live in a **pill over the bottom of the content area, not a full-screen takeover** — this device
  exists to show session/usage state, and blanking it for the ~13s a capture takes hides the thing
  it is for. The level bar earns its place: it is the only way to know the mic is hearing you
  *before* spending 9s shipping the audio. Metering runs between DMA reads, never inside the sample
  loop (4096-byte store buffer ≈ 64ms of slack, versus ~2ms to draw).
- **`prevSessions` keeps only the nine fields the diff reads, not a whole `SessionInfo`.** It used
  to be `SessionInfo[MAX_SESSIONS]` - **13,392 bytes of DRAM plus a 13KB `memcpy` every tick** - to
  compare about 92 bytes per session. `askDetail[1424]` was 8.5KB of that, copied every 5s and never
  read back once. Slimming it to `PrevSession` reclaimed **12,792 bytes** (RAM 80,988 -> 69,156),
  which is about half the free heap on this device, and the audio path's one-shot capture went
  straight from **2s to 3s** as a result - heap is the binding constraint here, not flash (which sits
  at 43% with 1.78MB spare, so shrinking the firmware buys nothing).
  **`PrevSession`'s field widths must match `SessionInfo`'s exactly.** A narrower copy would be
  silently truncated by `copyField` and could then compare EQUAL to a *different* id or askPid -
  the same class of bug as a change-only cache shorter than the string it stores. The one field that
  deliberately changes shape is `askVoiceText`, which the diff only ever tests for non-empty, so it
  becomes a single `hadVoiceText` bool rather than 204 bytes.
- **The recording bar has a FOURTH stage, because it used to vanish exactly when the wait
  began.** LISTENING/DICTATING -> SENDING -> **PROCESSING** -> result. The bar was torn down
  the instant the transfer finished, which is the moment the Mac starts the slow part -
  decode, then whisper, then up to one 5s tick before anything comes back. Three to ten
  seconds of nothing, longer on the first run while whisper loads its 547MB model, and it
  reads as "my tap did nothing". Both capture paths enter it (`micProcessingBegin()`), so the
  behaviour cannot depend on which one was used.
  - **TWO titles, because the device knows two different things.** It knows it finished
    SENDING (its chunks were ACKed) but not what the Mac did next, so it says `PROCESSING`
    on its own authority and only claims `TRANSCRIBING` once the host publishes state
    `working`. **If it never upgrades, the Mac never got the capture** - the most likely
    failure, and otherwise indistinguishable from success. `working` is deliberately NOT in
    the card-raise list: it is progress, not a result.
  - **The track carries an INDETERMINATE SWEEP, never a percentage.** whisper's progress is
    not observable, so a filling bar would be inventing one; a segment travelling back and
    forth says "working, duration unknown". Elapsed seconds sit in the lane `micPillMeter`
    uses for its percentage and are the honest quantity.
  - **Frame and update are split** for the same reason `micPillMeter` splits them: the frame
    (rounded card, stroke, dot, title) is painted on entry and only when the TITLE changes,
    while the sweep and counter repaint at 80ms. Repainting the card several times a second
    is exactly the flicker this file's discipline exists to prevent.
  - **Whoever takes the bar down OWES A REPAINT**, and forgetting it was a real defect caught
    before flashing. The bar is a 212x64 slab over the content area and the change-only
    render will not clear it. A raised result card clears the content area itself - but
    `heard` and `askheard` raise no card, so those left the bar stranded on screen.
    `barNeedsClearing` repaints only when no card is coming, since doing both is a visible
    double-draw.
  - It absorbs the 5s tick the way the voice card does (parse everything, `renderFooter()`,
    return), and any tap dismisses it. A ~45s stall relabels it `NO REPLY FROM MAC` rather
    than spinning forever - the host's own child timeout is 180s and a three-minute spinner
    would be its own bug.
- **`voice.seq` is HOST-LIFETIME, and treating it as monotonic forever broke on every host
  restart.** `let voiceSeq = 0` in the host, so it restarts at 1 when the process does. The
  device held it as a high-water mark, so after a restart it ignored every voice state until
  the new counter climbed past the old one - silently disabling the result card, and leaving
  a processing bar with nothing that could ever end it. Observed exactly that: the bar sat on
  `NO REPLY FROM MAC` because the host had been restarted out from under it. A seq going
  BACKWARDS is now read as a new host generation (`voiceSeq`/`voiceSeqShown` reset).
  Two related holes closed with it. **`voice: null` means the host holds no record of any
  exchange**, which after a restart is the literal truth - the device's parse skipped the
  whole block on null, so it received no signal at all. It now ends the bar on a null voice,
  but only after 12s, because null is ALSO briefly true for the first capture of a host's
  life (the bar goes up when the transfer ends; `working` only arrives once transcription
  starts) and clearing on sight would kill the bar in the very case it exists for. And the
  bar now GIVES UP at 35s instead of holding the screen until tapped: "no reply" is worth
  saying, and is not worth a permanent slab of the content area when nobody is standing
  next to the device.
- **`clip` was missing from the card-raise list, and that made the DEFAULT delivery silent.**
  With `DECKHAND_VOICE_DELIVERY` unset (clipboard), a dictation ends on state `clip` - and
  since only `sent`/`done`/`memo`/`error`/`askerror`/`asksent` raised the card, the device
  showed **nothing at all**: no transcript, no confirmation. `voiceStateLabel()` had carried a
  `COPIED - PASTE IT` label the whole time that the raise path could never reach, and this
  file claimed that card appeared. Same class as the `askerror`/`asksent` omission the voice
  review found: a state the host publishes and the device surfaces nowhere.
- **`micRestoreUi()` must reset the change-only caches, and delegates to `forceFullRepaint()`.**
  Repainting chrome WITHOUT resetting them leaves every field **blank**, because `drawIfChanged`
  sees an unchanged string and skips a field whose pixels were just erased. That shipped once as
  "USAGE shows no numbers after recording" — the identical trap `drawSettingsStatic()` already
  documents. Going through `forceFullRepaint()` also means values return from data already in hand,
  with no wait for the next host tick.
- **Long recordings STREAM (`micStream()`), because buffering physically cannot reach a minute.**
  60s at 16kHz is 960KB against ~70KB of free heap, and this module has no PSRAM — that is the whole
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
- **Dictation has TWO prerequisites and they fail in identically-looking ways, which is
  why `host/install-voice.sh` exists.** `brew install whisper-cpp` deliberately ships no
  model, so a binary-only install turns `whisper-cli: ENOENT` into
  `failed to load model` - and either way the device just said FAILED. Found the hard
  way: on this machine BOTH were missing, and the logs held **26 whisper failures and
  zero successful transcripts** across two log generations while everything else looked
  healthy. `voiceMissing()` names which one is absent, and it is checked at **STARTUP**
  (`Voice: whisper ready.` / `Voice: DICTATION DISABLED - ...`) as well as on failure,
  because the old behaviour accepted a capture, spent the whole transfer, and only then
  failed - which presents as "dictation is broken" rather than "a dependency is
  missing". The device's error card now names the missing piece and the script to run.
  `install.sh` reports both but does NOT auto-install: the model is ~550MB and someone
  who has not fitted the mic should not download it to set up a status display.
  The installer refuses a model under 500MB rather than leaving a truncated one in
  place - whisper emits confident nonsense from a damaged file, the same hazard that
  makes `mic-wav.mjs` refuse a capture under 98% complete.
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
- **A pending QUESTION can be answered by speaking, and the confirm tap is what authorises it.**
  The device records with the ask's pid in the stream header (`answer=<pid>`), the host transcribes
  and PARKS the text rather than dispatching it, publishes it back on the ask (`voiceText`,
  `voiceSha`), and the device shows it. Tapping SEND signs
  `HMAC(secret, "nonce:pid:TEXT:<sha16>")` over a hash of **exactly the text on screen**, so one
  signature proves both that the paired device authorised the answer and that a human read those
  words. The host re-hashes the transcript it still holds and refuses a mismatch.
  Nine things are load-bearing:
  - **Questions only, and the HOST enforces that — `ask.voice` gates the BUTTON, not the write.**
    `emitDecision` carries free text for a question (`{behavior:"deny", message: carriedAnswer}`)
    but for a plan takes the `answer.idx === 0` branch — `{behavior:"allow"}` — since a voice answer
    always writes `idx: 0`; a spoken answer to a plan would therefore be silently APPROVED,
    discarding the words entirely, not merely replaced with a generic string. That is the worst
    failure shape available: indistinguishable from working. A permission prompt can only be DENIED,
    so speaking "yes, go ahead" there would deny the call with that as the reason.
    So `handleVoiceAnswer` re-reads the session record and requires `ask.kind === "question"` **and**
    a matching `ask.pid` before it writes an answer file, and the device clears `askVoiceText` for a
    non-question ask so the confirm screen cannot be raised at all. Both halves are deliberate:
    parking a transcript is **unauthenticated** (any peer on the link can send
    `AUDIO stream … answer=<pid>` against a pid of its choosing), so if the device's gate were the
    only gate, a chosen pid would reach `{behavior:"allow"}`. A read failure on the record aborts
    rather than falling through — `undefined !== "question"` must reject, not pass.
  - **The hook is NOT modified.** The answer file carries `idx: 0` with the transcript as `label`,
    and `chose = answer.label || ...` does the rest. That file's stdout is a decision channel.
  - **Cap the transcript BEFORE hashing it, and cap it in BYTES.** The device displays the capped
    string, so that is the string that must be signed; hashing first would sign text the human never
    saw. The cap has to be `capUtf8(text, VOICE_ANSWER_TEXT_MAX_BYTES)` (150, on a codepoint
    boundary) rather than a `slice()` on characters, because the device stores the answer in a fixed
    `char[204]` and `copyField` truncates by BYTES. Whisper emits curly quotes and em-dashes freely
    at 3 bytes each, so a 200-*character* transcript overflows that buffer: the device would display
    a truncated string — possibly cut mid-codepoint — while signing the host's hash of the FULL one.
    Verification passes and the host writes text nobody read, which defeats the entire point of the
    confirm step. `capUtf8` lives in `host/voice-answer.mjs` rather than inline so
    `voice-answer-check.mjs` exercises it; removing its boundary walk fails 3 of its 4 checks.
  - **If the transcript will not FIT on the confirm screen, SEND is withheld rather than offered.**
    The panel wraps to at most 8 lines and `askVoiceTooLong()` reports an overflow, which draws
    "TOO LONG - ANSWER ON YOUR MAC" and omits SEND (RE-RECORD and CANCEL stay). The touch handler
    tests the same helper, so the button's rectangle is inert too — a hidden control whose hit
    region still fires is worse than a visible one. Belt and braces in practice, not load-bearing:
    every Cozette 6x13 glyph advances 6px, and this screen's lane is `CARD_W - 8` = 208px on board
    1, whose worst case is **exactly 8 lines** — measured by searching word lengths rather than
    assumed (17-character words; 9 lines is unreachable because after 7x18 bytes only 24 remain).
    The two caps are therefore consistent **by arithmetic**, and any change to either must
    re-derive the other — a 6-line cap was what let SEND sign text scrolled off the bottom with no
    indicator that anything was missing. Board 2's wider 288px lane gives a worst case of **6**, so
    the shared cap of 8 holds looser there and did not have to move.
    **THE CONFIRM SCREEN AND THE KEYBOARD DO NOT SHARE A LANE, and this file used to say they did.**
    The confirm screen wraps against `CARD_W - 8` (`sessions.ino`, `askVoiceTooLong`); the keyboard
    hard-slices against `CARD_W - 12` (`keyboard.ino`, and board 1's own header comment always said
    `(CARD_W - 12) / 6`). **At board 1's `CARD_W` of 216 both give 34, which is exactly why the
    error survived** — they diverge at any other width, and board 2 is the first thing in this repo
    to have another width: at 296 they give **36 versus 35**. The wrong lane was written into the
    one place this file claims a budget is provable "by arithmetic", which is the worst place for
    it. If you quote a column count here, quote the file it comes from with it.
  - **20s cap on an answer recording** (`MIC_ANSWER_MAX_MS`) against 120s for a dictation. The hook
    blocks for `REMOTE_WAIT_MS` (90s) and that is the whole budget for record, transfer, transcribe,
    read and confirm. If confirmations start landing late, shorten the cap - do NOT raise
    `REMOTE_WAIT_MS`, which is matched to the settings.json hook timeout and breaks silently if
    raised alone.
  - **A transcript arriving does not change `askPid`, so `askVoiceSha` had to join
    `buildDetailSignature`.** Without it the change-only redraw never repaints and the confirm screen
    never appears at all — the feature looks implemented and does nothing. Same trap the detail
    signature already documents for `title` and `prompt`.
  - **CANCEL remembers the rejected hash, because clearing the text is not enough.** The host holds
    a parked transcript for five minutes and republishes it every tick, and `handleAskTouch` checks
    `askVoiceText[0]` BEFORE option handling while the confirm rows overlap the option rows — so
    after a CANCEL, a tap on what looked like an ordinary option button could transmit the transcript
    the user had just rejected. `askVoiceCancelSha` suppresses a republished transcript carrying that
    hash, carried across ticks by the id-matched `prevSessions` block. A genuinely new recording has
    a different hash and still displays. Device-local on purpose: a new host command would be more
    wire surface and another thing to authenticate.
  - **The cancel-suppression clears when a recording STARTS, not when `askPid` changes.** Keyed off
    `askPid` alone it was a permanent dead end: CANCEL, then say the same words again, and the
    identical transcript hashes identically and is suppressed forever for that prompt — the user
    re-records and nothing appears, with no way out but the Mac. Starting a recording is an explicit
    request to see a new transcript, so it spends the suppression; both entry points (SPEAK and
    RE-RECORD) clear it, and missing either leaves the dead end half-open.
  - **The failure states have to reach the SCREEN, or a failure is indistinguishable from nothing
    happening.** `askerror` (capture under 98% complete, whisper failed, nothing recognised) and
    `asksent` raise the voice card and have labels in `voiceStateLabel()`; without that the user
    taps SPEAK, speaks, and watches an unchanged screen burn the 90s hook budget with no signal to
    retry. `askheard` deliberately raises **no** card — it fires the instant a transcript is parked
    and the confirm screen carrying that same text is already about to draw, so a card on top of it
    is noise.
  `host/voice-answer-check.mjs` covers the reject cases (tampered text, tampered hash, wrong nonce,
  wrong pid, wrong device, malformed mac) plus `capUtf8`'s codepoint safety, and can be run without
  hardware.
- **A pending QUESTION can also be answered by TYPING it, and the wire format is not the voice
  path's format wearing a different label.** The design spec assumed a keyboard would reuse the
  voice wire format verbatim; it can't, because the voice form signs a hash of a transcript the
  HOST already holds (`handleVoiceAnswer` bails at once without a parked one), while typed text
  exists nowhere but the device until it's sent — so the frame has to carry the text itself:
  `ANSWER <id12> <pid> TYPED <base64text> <hmac>`. That difference makes this **the first place
  the host accepts device-authored text**, which is why `typedTextOk()` (`host/typed-answer.mjs`)
  is not optional ceremony: non-empty, printable ASCII only (`/^[\x20-\x7E]+$/`), ≤150 bytes
  (`ANSWER_TEXT_MAX_BYTES`, now defined once in `host/voice-answer.mjs` and re-exported so one cap
  covers both forms). The HMAC proves the bytes came from the paired device — it proves nothing
  about whether the bytes are sensible, which is what the sanitiser is actually for.
  - **`Buffer.from(.., "base64")` is lenient, so the decode re-encodes and compares.** Node
    silently drops characters it doesn't recognise rather than rejecting them — `"abc!!!!"`
    decodes to whatever `"abc"` meant — so `decodeTypedText()` re-encodes its own decode and
    rejects on any mismatch, turning silent reinterpretation into a hard failure before the bytes
    are ever hashed or signed.
  - **The two forms sign different strings — `...:TEXT:<sha>` for voice, `...:TYPED:<sha>` for
    typed — so a signature minted for one cannot authenticate the other**, even though both
    ultimately sign a 16-hex SHA-256 prefix of text. Voice never needed an on-device hasher
    because the host held the transcript to re-hash against; typed text is device-only until
    sent, so `pairing.ino`'s `sha256Hex16()` exists purely to give the device its own copy of the
    same hash the host will independently compute.
  - **TYPE is hidden on Codex asks, and it's a hardcoded coupling to a constant in another file.**
    `askTypeOffered()` (`sessions.ino`) excludes `agent == "cx"` because Codex's remote-answer
    window is 15s (`REMOTE_WAIT_MS` in `claude-hooks/deckhand-session-hook.mjs`) against 90s for
    Claude Code — not enough to type a sentence, and offering a control that can't work is exactly
    what the read-only ask path already refuses to do elsewhere. `host/index.mjs`'s own
    `HOOK_WAIT_MS = { cc: 90_000, cx: 15_000 }` mirrors that split only to drive the on-screen
    countdown (`ask.sec`) — it's commented ADVISORY ONLY, and must never be mistaken for the
    thing that actually gates the wait.
  - **The countdown is derived from `first`, not `seen`, because `seen` is kept alive on
    purpose.** `nonceForPid()`'s map entry gets `seen` refreshed on every call so the entry
    survives the 60s prune while a prompt is still pending — a countdown built on that would never
    move. `first` is stamped once at creation and never rewritten, so
    `ask.sec = HOOK_WAIT_MS[agent] - (now - first)` actually counts down. It's cosmetic: nothing
    about whether an answer is accepted is gated on `ask.sec` reaching any value.
  - **The host still re-checks `ask.kind === "question"` before writing an answer file**, the
    identical guard the voice path needed for the identical reason: `emitDecision`'s
    `answer.idx === 0` branch is `{behavior:"allow"}`, so a typed answer against a *plan* would
    silently approve it, discarding the words entirely, if the device's own `askTypeOffered()`
    gate were the only thing standing in the way.
  - **If the window closes mid-typing, the text stays and only SEND is withheld.**
    `kbWindowClosed` flips when a tick no longer finds a session whose `askPid` matches `kbPid`;
    `kbText`/`kbLen` are never cleared by that, because throwing away a sentence someone spent a
    minute composing, with no explanation, is the worst available outcome. The action row swaps
    SEND for a wrapped "WINDOW CLOSED - ANSWER ON YOUR MAC", and `sendTypedAnswerToHost()` /
    `kbTouch()` both independently refuse to fire while it's set.
  - **`sendLineToHost` used a fixed `char out[96]` copy buffer, and nothing before typed answers
    was big enough to hit it.** Every prior caller (option answers ~53 bytes, voice answers ~77,
    `HISTORY` ~48) fit; a typed answer's 200-char base64 body reaches ~259 bytes, and `snprintf`
    into 96 bytes silently truncated it **and dropped the trailing `\n` with it** — exactly the
    byte the host's BLE line-splitter keys on. The line was lost, the hook burned its full wait,
    and the truncated fragment corrupted the *next* line. USB was unaffected (`Serial.println` has
    no such cap), so it read as "typing only fails over Bluetooth" rather than a buffer bug. It
    now chunks the caller's own buffer directly in 20-byte BLE notifies and sends `\n` as its own
    final notify, so there's no fixed ceiling left to outgrow.
  - **The text card hard-wraps at exactly 34 columns — deliberately not the word-wrap
    `drawWrappedText` already uses elsewhere.** Word wrap's worst case leaves as few as 18 of 34
    columns used on a line (a 17-character word pushes the break past halfway), which could push
    150 bytes to 8-9 lines — more than the screen has room for. A fixed column count makes the
    budget provable instead: `ceil(150/34) = 5`, always. `drawWrappedText` stays untouched because
    the ask detail and history reader genuinely need word wrap.
    **34 and 5 are BOARD 1's numbers, and the lane is `CARD_W - 12`, not `- 12`'s
    lookalike `- 8`** — both expressions give 34 at 216px wide, which is exactly why the wrong one
    survived in this file for so long. Board 2 is `(296 - 12) / 8` = **35** columns and
    `ceil(150/35) = 5` — the same line count, because the wider card and the wider face cancel.
    (This paragraph used to say 47 and 4, which came from dividing board 2's lane by Cozette's 6.)
    The per-board values live in `board_*.h`; what generalises is the *method*, that a fixed column
    count makes the line budget provable where word wrap cannot.
  - **The countdown and byte counter live in a reserved meta row, because `drawString` paints an
    opaque box the full height of a text line.** A counter sharing a row with wrapped text
    silently erases that line's tail. The meta row and the five hard-wrapped text lines are laid
    out to share no pixel row — on board 1 meta at y=10 and text at 26/39/52/65/78, on board 2
    meta at 20 and text at 41/54/67/80 (four lines, not five) — found as this exact bug twice
    before landing on a row neither can encroach on. The non-overlap is the invariant; the
    y-values are per-board and derived in `board_*.h`.
  - **`fabVisible()` had to gain a `kbActive` check.** The record/mic button's hit test runs
    before the keyboard branch in `handleTouch`, and its tab-bar slot sits right where the
    keyboard's countdown corner is — a tap there started a mic capture, and on release
    `micRestoreUi()`'s repaint painted a tab bar over the still-open keyboard while `kbActive`
    stayed true, leaving every later tap typing invisibly into a screen that no longer looked like
    a keyboard.
  - **Two periodic repaints had to be absorbed, not one.** The ~5s host-driven tick (`handleLine`)
    is intercepted while `kbActive`: it re-resolves the countdown and `kbWindowClosed` from the
    fresh payload and returns, never repainting the session list underneath. A second, independent
    ~1s loop-local tick that repaints the footer/tabs directly is separately gated on `!kbActive`,
    the same way it already excludes `readerActive`/`histActive` — missing either one repaints the
    keyboard away every few seconds. `lastActivityMillis` is also refreshed on every keyboard touch
    **and** every loop tick while `kbActive`, because the 30s default backlight timeout sits well
    inside the 90s answer budget: without it, typing a normal-length answer could blank the screen
    mid-sentence and the waking tap would be swallowed rather than typed.
  - **The placeholder is the QUESTION, and the card peeks the full prompt.**
    `drawKeyboard()` fillScreen's the ask screen away, so without this you compose a reply
    to something you can no longer read. While the box is empty the ask's title sits where
    "Type your answer" used to, and **tapping the text card** pages the full detail over the
    keys — the card used to be inert (`if (sy < KB_ROWS_Y) return true;`), so the gesture
    costs nothing. It covers the keys and the action row but **never the text card**, so the
    answer stays visible while you re-read the question; each further tap pages and a tap
    past the last page closes it, so there is always a way out without hunting for a target.
    Font follows `detailLooksLikeCode`, the same choice the ask screen makes.
  - **CAP has THREE states — off, one-shot, locked — and the LABEL carries which.** It was a
    bool cleared by the next character, so an acronym or a name cost one CAP tap per letter.
    `kbShiftMode` cycles off → once → locked; only `once` clears on insert. The key reads
    `CAP` versus `CAPS`, so the state does not rest on fill colour alone. `drawKbKey` forces
    the filled look whenever `kbShiftMode > 0` rather than relying on a follow-up redraw at
    each call site — a full-board repaint used to be able to lose it.
  - **Hold DEL to repeat, and that is the ONLY held-finger path in this file.** 500ms, then
    ~8 a second. It lives in `tickKbRepeat()` called from `loop()`, NOT in `handleTouch`,
    which dispatches on press and ignores a held finger — right for every other key, where
    one press must be exactly one character. The repeat re-qualifies against the key's own
    rectangle every tick, so sliding off stops it instead of deleting on whatever is now
    under the finger, and a lift releases the pressed look. Without it, fixing a typo near
    the start of a 150-byte answer cost up to 150 taps.
  - **A caret marks the insertion point, and its position is provable rather than clamped.**
    At `KB_COLS` (34) and `KB_MAX_BYTES` (150) the furthest it can land is line 4, column
    14 — inside the `KB_TEXT_LINES` (5) the card already budgets, so there is no overflow
    case to handle.
  - **SEND is the filled button and CANCEL only outlined.** Both were filled, so there was
    no hierarchy at all — and CANCEL is the one that discards a sentence someone spent a
    minute typing. Same reasoning the confirm dialog uses when it refuses to make a
    destructive choice the easiest thing to hit.
  - **`KBTEST` exists because this screen is otherwise unverifiable without a person.** It
    opens the keyboard against the first pending ask — the same reason `TAB` and `PAGE`
    exist, since the capture path can only record what is on the glass. `KBTEST peek`,
    `KBTEST caps`, `KBTEST type <text>` and `KBTEST off` reach the states a screenshot
    otherwise cannot: caret, byte counter, live SEND, caps labels. It **cannot invent a
    prompt** (with nothing pending it does nothing) and it cannot send — that still needs a
    real tap. It always closes an open keyboard first: re-opening one already open left the
    screen untouched, and since you cannot tap TYPE while the keyboard covers the screen
    that re-entrant path is scaffolding-only, so it is made impossible rather than debugged.
    It goes through `switchTab(TAB_SESSIONS)` + `openSessionDetail(i)` the way a person
    would, because opening straight from whatever tab was showing left the sessions list
    painted under a USAGE tab bar when the keyboard closed.
  - **No cursor, backspace only.** Insertion is always append (`kbInsert`), deletion always trims
    the end (`kbBackspace`) — there is no caret position anywhere in the state. Aiming a cursor at
    hard-wrapped text on a resistive panel is a worse interaction than retyping up to 150
    characters, so the capability was never built rather than built and then hidden.
  - **Cozette is ASCII 0x20-0x7E only** — the same fact that already forces `fitText`'s
    three-ASCII-dot ellipsis — so there's no shift-arrow or backspace glyph to draw; the keys are
    sentinel bytes (`\x01`/`\x02`) labelled `CAP`/`DEL` in plain text instead.
  - **Going full-screen is what makes QWERTY viable on a 240px-wide panel at all.** On board 1 the
    drawn key is `KB_KEY_W` x (`KB_ROW_H` - 4) = 22x40, and the **tested** band is
    `KB_PITCH` x `KB_ROW_H` = **24x44 = 1056px²** against 880 in the ordinary content area. The win
    going full-screen buys is in the touch target, not in the artwork. Board 2's are 30x54 drawn and
    32x58 = 1856 tested; its key height is capped by board 1's own 1:1.82 aspect ratio rather than
    by the panel, which is the honest constraint.
    **The tested WIDTH comes from the PITCH, not from `KB_KEY_W`, because `kbTouch()` divides by
    `KB_PITCH`** — so the 2px gap between two keys belongs to the key on its left and there is no
    dead lane between keys. This file and board 1's header both said **968** (22x44), i.e. they used
    the DRAWN width for a band the code tests at the pitch. Understated in the safe direction, but
    wrong in two files, and corrected in both.
- **A READY session can be sent a typed MESSAGE, and it is the keyboard half of a path the
  mic already had.** The record button is visible on a plain detail screen so a dictation can be
  aimed at a session; **TYPE** in that screen's header row does the same with the keyboard.
  Delivery is the SAME function for both (`deliverTextToSession`) driven by the same
  `DECKHAND_VOICE_DELIVERY` - so with the default, SEND **copies the text to the Mac and
  notifies you**; it runs nothing until that is set to `dispatch`. One copy of that logic is what
  stops the two drifting, and only the log prefix differs (the `setVoice` states are identical,
  because the device's result card and the menu bar row key off those strings).
  - **READY only, and enforced on BOTH sides.** READY (`status:"waiting"`) means nobody is
    mid-turn, which is what makes this safe - the voice path already found that a headless run
    alongside an active turn becomes a second author on one conversation with neither able to see
    the other. The device gates the button, and `handleTypedPrompt` **re-reads the record and
    refuses anything that is not `waiting`**: a gate that exists only on the device is not a
    gate, the identical reason `handleVoiceAnswer` re-reads before writing an answer file.
  - **The wire form is `PROMPT <id12> <base64text> <hmac>`, signing `nonce:id12:PROMPT:sha16`.**
    The LABEL is the whole point: `TEXT` (voice answer), `TYPED` (typed answer) and `PROMPT` all
    sign a 16-hex hash of their text with the same key, so without it a signature minted to
    answer a question would authenticate one that starts work. `voice-answer-check.mjs` asserts
    both directions of that.
  - **A per-session nonce, because `askNonces` is keyed by an ask's PID and a READY session has
    none.** `promptNonces` is keyed by the FULL session id and published as `pnonce` **only while
    the session is waiting** - its absence, not the status alone, is what tells the device not to
    offer typing. Single-use: unlike an answer, there is no Mac dialog whose closing would
    invalidate a replay.
  - **`resolveSessionId` refuses an ambiguous 12-char prefix**, where the voice path used
    `files.find(startsWith)` and took the first match. A message delivered into whichever session
    sorted first is the worst failure shape available here, because it looks like success.
  - **A duplicate arrives on every send** - the device transmits on USB and BLE at once - so the
    second copy hits a consumed nonce. Without the dedup that logs as an authentication failure
    on every message, which trains you to ignore the line that matters. Observed on the first
    real send, which also proved the nonce is genuinely single-use.
  - **The button is in the HEADER ROW because there is nowhere else.** Measured: the detail card
    runs 60..284 with its content cursor reaching ~284 in the worst case (title and last prompt
    both present), and the "< Back up top - tap here for history" hint owns 285..299 against a
    `contentBottom()` of 302. A 32px control below the card would cover the card's own text or
    replace the only thing telling you the card is tappable. Its hit zone is the whole right end
    of that row - 100x28 for a 76x22 chip on board 1, 100x50 for a 76x26 one on board 2.
    **THE CHIP IS DRAWN SMALL AND HIT BIG, and sizing it to `TAP_MIN` instead was a real mistake
    board 2 shipped for a task.** It was 88x46 there - 46 because that is `TAP_MIN` - on the
    reading that the chip is the target. It is not: `handleDetailTouch` tests
    `sx >= msgBtnX() - 24` over the whole `DETAIL_HEAD_H`, so the live zone is 100x50 whatever is
    drawn, already over twice `TAP_MIN` in both dimensions. The 46 bought nothing and spent the
    header row's air on it. Same split the settings steppers already use (44px keys in a 72x56
    zone), and `sessions-geom-check.mjs` now parses the hit test's slack term out of
    `sessions.ino` rather than restating it, so a future change that RE-COUPLES the zone to the
    drawn size is what fails.
  - **Prompt mode differs from answer mode in exactly the ways the situation does:** no countdown
    (nothing is waiting, and a timer would be a lie), no peek and so no "tap here to read it"
    hint (there is no ask, and the detail screen it opened from already shows the context), a
    placeholder naming the session, and a window tracked by session id plus `msgOffered()` rather
    than by `askPid`. Leaving READY withholds SEND and **keeps the text**, saying
    `NO LONGER READY` - "answer on your Mac" would be answering a question nobody asked.
  - **`KBTEST msg [text]`** opens it against the first READY session and optionally types, for the
    same reason `TAB`/`PAGE` exist. It still **cannot SEND** - that needs a real tap, and keeping
    it that way is the point rather than an inconvenience.
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
- **The record button lives IN THE TAB BAR, in a reserved slot at the right end.** Tap to start,
  tap to stop. It is chrome, not a floating control, and that is what removes every hazard the
  floating versions kept running into. Three earlier homes were all wrong:
  - **BOOT key (GPIO0) - abandoned, and it bricked the device twice.** GPIO0 is also the serial
    bootloader strap and is driven by the USB adapter's **DTR** line, so it goes LOW after every
    reset and whenever the host merely opens the port. A tap handler therefore fired recordings by
    itself on flashing, and a strap held low past `POWER_OFF_HOLD_MS` sent the device into **deep
    sleep during boot** - which presents as bricked firmware: no serial output at ANY baud, dark
    screen, while esptool still talks to the chip happily. If that ever recurs, suspect sleep
    before code. Only the deliberate long HOLD (power off) remains on GPIO0.
  - **Floating and draggable - abandoned.** Hold 700ms, drag, release, position persisted to NVS as
    `fabx`/`faby`. On a resistive panel that needed a 70px spike reject, a 2px deadband, and a
    CLEARED content area to drag over - with no framebuffer to read back there is no way to restore
    what was under a moving object. Dropping the gesture took **1300 bytes of flash** with it. The
    `fabx`/`faby` NVS keys may still exist on devices flashed before the change; nothing reads them.
  - **Fixed, floating over the content's top-right corner - abandoned after one build.** It covered
    the 5-hour card and the first session row's pill, and on SETTINGS it landed exactly on the
    pager's "next" key (slot x 182..233 vs button x 182..229) - and since it is hit-tested before
    every other handler it swallowed the tap, so paging stopped working.
  **Cost of the tab-bar slot: the three tabs drop from 80px to 66px.** That is affordable because
  the labels are Cozette 6x13 and the longest ("SESSIONS", "SETTINGS") is 48px, so 66 still leaves
  room; the active-tab underline goes 64 -> 50. The slot is `TAB_REC_W` 40 wide, and the ring is
  **26px** (`REC_R` 13) rather than the old 48 because the bar is only 34 tall. Its tap target is
  the whole slot, which is under `TAP_MIN` in height - unavoidable, and no worse than the three
  tabs beside it, which have always been 34 tall.
  Three things are load-bearing:
  - **`fabHit()` still runs BEFORE the `showingDetail` branch.** The tab bar is drawn on the detail
    and ask screens but is inert there - `handleTouch` returns at `showingDetail` before reaching
    the tab-bar branch - so without that ordering the button would be visible and dead exactly
    where you aim a dictation at a session.
  - **Nothing calls `drawFab()` per tick any more.** The floating version was repainted last on
    every tick to survive whatever had just been drawn under it. `drawFab` now clears its slot
    first, so a per-tick call would be a clear-then-redraw every 5s - the flicker this file's
    redraw discipline exists to prevent. The bar paints it, and the bar only repaints on a tab
    switch or a full repaint.
  - **The 1px `COLOR_BG` haloes are gone.** They existed to keep an outline readable over ARBITRARY
    content; the tab bar's fill is known and flat, so the ring blends against `COLOR_CARD` instead.
  **Visual: it is drawn as a FOURTH TAB, not as a shape of its own.** Same Cozette 6x13 label
  (`REC`), same `COLOR_LABEL` / `COLOR_VALUE` pair, and the same 3px `COLOR_ACCENT` underline inset
  8px that marks a tab as active - pressed here means what active means there, so every item in the
  bar reports its state the same way. It replaced a 26px ring, which was a second visual language
  sitting inside a bar that already had one.
  The one deliberate difference is the **leading dot**: a bare `REC` among three navigation labels
  reads as a fourth destination, and the dot is the universal record mark saying this one DOES
  something rather than going somewhere. Dot and label are laid out as a single group and centred
  together (6 + 3 + 18 = 27px in the 40px slot), so the pair is optically centred instead of the
  text being centred with the dot hanging off its left.
  `fabVisible()` hides it only when asleep or when the crab owns the screen, because chrome that
  blinks in and out reads as a glitch.
- If this mic is ever replaced, an **INMP441** (I2S) is viable and needs no analog tuning:
  `SCK`→IO18, `WS`→IO19, `SD`→IO35. IO18/19/23 are the **microSD** bus and this firmware contains
  no SD code at all, so they're free as long as the card slot is unused.
- **BOARD 2 goes one step further: it cannot WAKE from deep sleep by touch either**, so auto-sleep
  is disabled there and only the manual POWER OFF remains. Same class of hardware fact as this
  bullet, different pin arithmetic — see Two boards.
- **There is NO true power-off on this board, and it is a hardware fact, not a missing feature.**
  The power path is pure hardware - the TP4054 charger and the Q3 P-FET that switches USB/battery
  have no GPIO control, and no regulator-enable or VBUS-sense line is exposed - so the MCU cannot
  cut its own supply. Deep sleep is the deepest state firmware can reach. Estimated residual draw
  is ~7mA, dominated by parts nothing in software can switch: an AMS1117-class LDO's quiescent
  (~5mA) and the CH340 (~1.5mA), against ~0.5mA for the XPT2046 that must stay powered for the
  PENIRQ wake. Sleep already removes the backlight (~100mA, ~93% of the draw). A genuine off needs
  hardware: a switch in the battery lead, or a soft-latch (P-FET held on by a GPIO, released to cut
  power). Do not go looking for a software answer to this again.
- **A wake must be a HELD touch, and this is where the battery actually goes.** ext0 fires on any
  PENIRQ edge, so a sleeve or a knock used to wake the device fully - radio up, panel out of SLPIN,
  backlight to 100%. `setup()` now brings up the touch bus FIRST (it is on its own HSPI and costs
  nothing), qualifies the wake before `setupBLE()` or `tft.init()`, and drops straight back to deep
  sleep unless the touch is held for `WAKE_HOLD_MS` (350ms). The re-sleep deliberately does NOT go
  through `enterDeepSleep()`: the panel never left SLPIN and the backlight pad is still latched low
  from the original sleep, so touching either would only undo what is already correct.
- **The device measures its own sleep drain.** `enterDeepSleep()` records battery mV and
  `esp_timer_get_time()` into RTC memory (which survives deep sleep); the next real wake prints
  `SLEEP report: <hours>, <mV> -> <mV> (<delta>, <mV/h>), spurious wakes=<n>`. mV/h is the raw
  datum on purpose - converting it to mA needs the cell's discharge curve, which we do not have.
  **Timing comes from `gettimeofday()`, NOT `esp_timer_get_time()`** - measured: an overnight run
  reported "elapsed unknown" because esp_timer does not span deep sleep on this core, which is
  exactly what the guard was added to catch. ESP-IDF advances `gettimeofday` by the RTC-measured
  sleep duration on wake, so the DELTA is right even though the absolute time is meaningless
  (nothing sets the clock). Verified over a 3-minute sleep.
  Two things stop it reporting nonsense. The EMA is **settled with 12 samples before comparing** -
  `batteryMv` resets to -1 on boot, so a single read is RAW while the pre-sleep figure was
  smoothed, and comparing the two attributes the difference between two METHODS to the battery.
  And **no rate is printed for a sleep under 30 minutes**: a 3-minute run with a 7mV delta, which
  is inside the ADC's own noise, produced "-133.7 mV/h" - a flat cell in four hours. That is noise
  multiplied by 20, and printing it invites precisely the wrong conclusion.
  There is deliberately **no "on USB" flag**. `usbLinkActive()` keys off host traffic and on wake
  `millis()` has restarted with none yet, so it was always false regardless of the cable; this
  board has no VBUS-sense pin, so the firmware genuinely cannot tell. A flag that is silently
  always-false is worse than none, because its absence reads as "not on USB". A RISING value is
  reported instead, since that can only mean it was charging.
  Spurious wakes accumulate across re-sleeps and are reported with the drain, so the guard's value
  is visible rather than assumed.
- "Power off" (hold BOOT ~1s) is ESP32 deep sleep, not a real power cut: panel DISPOFF+SLPIN,
  backlight pin latched low via `gpio_hold_en` (GPIOs float in deep sleep — and setup() must
  `gpio_hold_dis` it again after wake, before re-attaching LEDC), wake via ext0 on IO36 (the
  XPT2046's PENIRQ, which works while the ESP32 sleeps because the 3.3V rail stays up). Wake is
  deliberately **touch, not the BOOT key**: GPIO0 held low across the wake reset straps the
  chip into the serial bootloader and it looks bricked until a manual reset. The manual power-off
  and the automatic battery-idle sleep share `enterDeepSleep()`.
- **Automatic deep-sleep is DISABLED on board 2**, because that board cannot wake from deep sleep
  by touch at all — a silicon fact about the S3's RTC GPIO set, spelled out under Two boards. The
  rest of this bullet is board 1.
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
  **EVERYTHING ABOVE IS BOARD 1'S ARM NOW. On board 2 the pill, the `for 12m - 14:31`
  line and BOTH column pairs are gone — §7 of the sessions redesign heads that card
  with the same 44px status band the sessions tab's first row wears, and closes it with
  ONE dim `T_META` line.** The band carries the agent MARK, the status WORD at `T_HEAD`
  and the duration; the meta line carries `model - branch - <status-since HH:MM>` on the
  left with the Mac's icon (and, with a second Mac up, its tag) right-anchored to the
  card's text edge. `DETAIL_CARD_H` went 326 → 330 → **300** across the two tasks and
  `DETAIL_AIR` 4 → **8**. Six things about it are load-bearing:
  - **THE CARD'S CEILING IS 331 AND IT IS DERIVED, SO 350 WAS NEVER AVAILABLE.** §7 asked
    for ~350. Both the "answer this one on your Mac" line and the history hint are
    `MC_DATUM` `T_META`, and `drawString` centres on the ASCENT while painting a box
    ascent+descent tall — so the answer line at `cardY + H + 8` inks `H+98..H+113` and the
    hint at `contentBottom() - 10` inks `444..459`. They collide **at H = 331**, so 330 is
    the largest legal card. `sessions-geom-check.mjs` derives that number from the hint,
    asserts `DETAIL_CARD_H` against it rather than against a literal, and PRINTS it.
    Measuring the BASELINE instead of the box is what once put the header's own comment 3px
    low.
  - **The band costs MORE than the pill it replaces, and the meta line is what paid for
    it.** Band 44, minus the 10px top pad it replaces, minus the 28px pill block = **+6px of
    ink**, on a card that had 4px of slack — which is why task 2 could only reach 330 and
    sat exactly at the ceiling. Task 3's meta line then returned **55px** (four labels and
    four values became one line), and that surplus went where `DETAIL_AIR`'s own note has
    always said surplus should go: around the content (air 4 → 8, six boundaries widened),
    with the rest GIVEN BACK rather than held as blank card. Content ends at `+295`, two
    clear rows above the border, 30px inside the ceiling. A fixed-height card whose blocks
    are optional already looks sparse when a session has no title and no prompt, so holding
    the surplus would have shown as an empty third of the card in the common case.
  - **The band does NOT carry the wall-clock, and §7's prose asks for it.** Measured at this
    board's real geometry: `4m - 09:34` is 10 characters at `TEXT_ADV` = 80px, which leaves
    the word 144px against a `NEEDS YOUR INPUT` that inks **192** — a collision of 48. The
    band's duration lane is a fixed 3 characters (`SESSION_BAND_DUR_CHARS`) for the same
    reason, and the checker asserts that lane on THIS surface so re-adding the clock fails
    rather than merely looking cramped.
  - **`started` IS DROPPED, and that is what buys room for the Mac.** In the 260px lane at
    `TEXT_ADV` 8, `model - branch - HH:MM` is 21 characters = 168px and the Mac cluster is
    84, fitting with 8px to spare; restore `started` and the same line is 29 characters =
    232, i.e. **316 against 260**. Both halves are asserted, the second deliberately — it
    encodes WHY the field is absent, so a future reader who re-adds it fails there instead
    of shipping a clipped line.
  - **The clock is the STATUS-SINCE instant, NOT `s.actSec`, and that is the only reason it
    can be a static field.** `actSec` advances on every event while nothing else on the card
    does, so drawing it here would freeze silently between repaints, and putting it in the
    signature would repaint a 296x300 card every 5s — the two failures this screen's rules
    already name. `hostNowSec()` minus the elapsed time is stable to within the ±1s two
    independent `floor(ms/1000)` terms can disagree by, and `status` is already in the
    signature. `s.agent` had to JOIN the signature, board 2 only: the band's mark is drawn
    from it and nothing else on that card carries the agent any more.
  - **THE BAND ON THIS CARD WAS COMPLETELY STATIC, AND THE FIX IS A THIRD TICK.** Both
    existing ticks early-return on `showingDetail`, so on this screen nothing repainted the
    band AND `animPhase` never advanced — which is why it was fully dead rather than merely
    slow: the ~5s host tick does repaint the card, but the phase it draws was frozen too.
    The mark sat still two taps from an identical band that turns, so the screen read as
    broken rather than as a deliberate difference. **Found on the glass**, like everything
    else on this card. `tickDetailBandAnim()` (sessions.ino, board 2 only, called from
    `loop()` between the two existing ticks) now advances the mark, the crossfade and the
    pulse at the DETAIL card's own coordinates. It is a third tick rather than a relaxed
    gate on the other two, and that is the safety argument rather than a preference: those
    two paint at the sessions LIST's coordinates — a band at `sessionRowYAt(0)`, a shimmer
    down every row — so letting them through here would paint the list's geometry on top of
    a full-screen card. Measured afterwards: **219–235 of the mark's 1024 pixels differ
    between captures**, where before it was frozen. **That is FRAMEBUFFER evidence, not the
    panel** — board 2's `SCREENSHOT` reads the shadow buffer (see the verification trap under
    Two boards) — which is the right instrument for this particular question: what was frozen
    was the renderer's own `animPhase`, so "the composed frame now changes" IS the claim. It
    says nothing about how the mark looks on the glass, and the original report came from a
    person watching the device.
  - **`showingDetail` IS ALSO TRUE ON THE ASK SCREEN, which has no band at all.** It is set
    in one place and the ask screen is drawn through the same entry point
    (`drawSessionDetail` hands off to `drawAskDetail` on `askPid`), so a tick that trusted
    `showingDetail` would blit a 32x32 spark into the middle of an Allow/Deny screen.
    `detailBandVisible()` asks `askPid` the same way `drawSessionDetail` and
    `renderDetailDuration` already do, and refuses every other full-screen surface too —
    **the keyboard in particular runs with `showingDetail` still true**, which
    `closeKeyboard()`'s own note records. Verified: 0 differing pixels in the band's mark
    box across 25s of a live ask screen, while 71 changed elsewhere on the same frame.
  - **The card used to CLEAR `xfadeId` before painting its band, and that line is now GONE —
    the same defect wearing its own fix.** It was correct for as long as nothing advanced a
    fade here: `handleLine()` starts a fade and repaints this card in the SAME tick, before
    `loop()` reaches `tickSessionAnim()`'s clear, so the band was painted at frame 0 of a
    fade nothing would ever advance and STAYED there — "WAITING FOR YOU" and "WORKING"
    superimposed at half strength each, on a card already wearing the new status colour in
    its border. With `tickDetailBandAnim()` advancing it, clearing on every card repaint
    would abort every fade on its FIRST frame instead. `tickSessionAnim()` still clears for
    every other reason it is gated out; only the detail card is exempt. **The old
    assertion's inverse is asserted now**, and it depends on `fnSrc` stripping comments,
    because the forbidden line is quoted verbatim in the comment that replaced it.
  - **The band's duration had to stop reading `bandFillShown` and re-ask `sessionBandFill()`,
    for a reason its own comment stated.** That comment justified the record with "HERE
    nothing repaints it at all (`tickSessionAnim` and `tickWorkingSpinner` both early-return
    on `showingDetail`), so the record is exact" — which stopped being true the moment
    something did. With the band animating under it, the record is a frame old mid-fade and
    that field paints an OPAQUE box in it. It now takes the sessions tab's own trade,
    spelled out at that call site: bounded by one step of the ramp, self-healing at the next
    reconcile.
  - **The pulse is reachable on this card only for an `asking` session with NO ask object**,
    since one with an `askPid` is drawn as the ask screen, which has no band. It is written
    anyway rather than left out: the alternative is a band that breathes on one surface and
    not on the other for a state that can reach both.
  **The four §7 defects the mockup round found, recorded as FOUND-AND-RESOLVED rather than
  quietly rewritten.** §7 was the one surface never visually reviewed before its spec was
  written, and it says so; mocking it at the real geometry is what turned that caveat into
  four measured numbers. (1) The band cannot hold word + duration + wall-clock — the word
  lane is 144px against a 192px `NEEDS YOUR INPUT`, over by 48. (2) The same defect seen
  from the other end: the meta line cannot hold `started` either once the Mac is on it — the
  mockup measured 312px in a 268px lane, and the shipped assertion, taken at the card's real
  `CARD_W - 2*PAD`, is **316 in 260**. The two disagree by the 8px the mockup gave the lane, which
  is worth knowing rather than smoothing over: the mockup was right about the collision and 8px
  optimistic about its size, and the number to trust is the one the checker derives. (3) §7 absorbs the AGENT column into the band and never
  says where the MAC goes — and it cannot go in the band, where even the icon alone leaves
  the word 4px short. (4) The TYPE chip was sized to `TAP_MIN` against a tap zone it never
  provided. All four were shown measured AND rendered, and the resolutions chosen were: band
  = word + duration, meta line drops `started`, Mac on the meta line, chip 76x26. **A spec
  that reads as though it were right all along teaches nothing** — the transferable part is
  that a layout described in prose at one board's geometry produced four collisions at
  another's, and that rendering it is what found them.
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
  (`WORKING` is two characters wider than `READY`). It then walks the ladder — 12x26 →
  10x18 → 6x13 — and takes the first whose measured width fits, so a long name is shown
  whole; a shrunk name is re-centred in the 26px band the big font would have filled.
  `fitText()` trims with **three ASCII dots**, since Cozette6x13 is `0x20-0x7E` only and
  U+2026 would draw as a blank box. Three things worth knowing before touching it:
  - **The middle rung had to come from a second font family.** Cozette alone only offers
    6x13 and a mechanical 2x scale of it (12x26) — nothing in between, so "shrink one
    step" used to mean a single hard jump straight from 12px to 6px. `uiTextSize()` now
    returns a registry index rather than a raw 2-or-1 scale factor, and the type-scale
    work added Terminus 10x18 bold as the rung between them, which is why the ladder is
    three steps (12x26 → 10x18 → 6x13) rather than one.
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
  host restarts). The poller backs off 15 minutes on 429 (persisted to `<runtime dir>/oauth-backoff.json`
  across restarts, honoring Retry-After) — don't "fix" apparent staleness by polling faster.
  **Two** persisted guards keep restarts from bursting the limiter: the back-off above, and a
  last-ATTEMPT timestamp (`<runtime dir>/oauth-attempt.json`, written just before every network
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
- The device line buffers (`feedChar`'s 16000-**BYTE** guard, the 16384-byte BLE stream buffer) are
  sized for payloads carrying `ask` objects; shrinking them silently drops whole updates. They
  were bumped from 8000/8192 when the ask caps grew (title 34, detail 1400, options 4×32,
  `askDetail[1424]`/`askTitle[36]`/`askOpts[4][34]`) so up to 6 simultaneous asks with full
  1400-char details can't overflow one JSON line. ArduinoJson v7's `JsonDocument` is elastic, so
  the parse side has no fixed capacity - the line guard and RAM (`SessionInfo`×6 plus a
  `prevSessions`×6 diff copy) are the real ceilings.
  **THAT GUARD COUNTS BYTES AND EVERY CAP ABOVE IT COUNTED CHARACTERS, AND THIS FILE CALLED IT A
  "16000-char guard" FOR AS LONG AS THE MISMATCH EXISTED.** `buf.length()` on an Arduino String is
  bytes; `title` 34, `detail` 1400 and `options` 32 were all JS `.slice()`, i.e. UTF-16 code units,
  and `clean()`/`cleanMultiline()` stripped control bytes only — so everything from U+0080 up
  crossed at up to **3 bytes each**. The two units were never reconciled, and the device's own
  `askDetail[1424]`/`askOpts[4][34]` have the same disease, since `copyField` truncates by BYTE.
  **Measured, not modelled from the caps:** six asking sessions of all-wide text with **no new
  fields at all** is **37,425 bytes against a 16,000 guard — 2.3x over**. And it does not take six:
  **ONE session carrying a multi-byte question at the 1400-char cap is 17,893 bytes.** A single
  question asked in CJK does it.
  **THE FAILURE MODE IS THE IMPORTANT PART, AND IT IS NOT A DROPPED LINE.** The guard **CLEARS THE
  BUFFER MID-LINE**, so the remainder of that same line accumulates into the emptied buffer,
  `processCompletedLine()` gets a JSON fragment, `handleLine()` returns early on the parse error,
  and **every tick carrying that prompt is lost**. The screen freezes at its last good state for as
  long as the prompt is pending, while both links, both heartbeats and both menu bars look perfectly
  healthy and nothing anywhere logs why — the "healthy process doing no useful work" shape this file
  already documents three times over (the stalled tick, the `ccusage` all-or-nothing tick, the
  nvm-PATH `readUsage()` throw).
  **FIX, LAYER 1: device-bound text is ASCII on the host, so characters and bytes are ONE UNIT BY
  CONSTRUCTION.** Not a bigger guard — `askDetail[1424]` and friends are fixed too, so raising it
  only moves the truncation. The justification is that the bytes were never worth anything:
  **both fonts declare `0x20..0x7E`, and an out-of-range byte draws nothing and advances nothing**,
  so every non-ASCII byte was budget spent on an invisible glyph. Stripping them costs no
  information the device could ever have shown, and it makes every character cap exact in bytes at
  once rather than patching one and leaving the next wrong. `toAscii()` transliterates what actually
  appears — em-dashes, curly quotes, ellipses, arrows, accented Latin via NFD — and marks anything
  else with a single `?`, **collapsing a RUN to one** so a CJK sentence does not become a wall of
  them. In the hook it goes inside `clean()`/`cleanMultiline()`, the single funnel every ask field
  already takes; in the host at each device-bound cap site. **Transliterate THEN cap, never the
  reverse**: the ellipsis is one character in and three out, so capping first lets a field grow back
  past its own cap. Result: WIDE **37,425 → 14,237**, and the ASCII floor is **unchanged at
  14,237** — the two are now the same number, and that identity IS the reconciliation. **Every
  payload that was already fine is byte-identical**, verified against 267 real captured payloads.
  **FIX, LAYER 2: `host/wire-fit.mjs` — the host REFUSES to emit a line the device cannot receive.**
  It measures every tick line against `feedChar`'s own 16,000-byte guard before writing it and sheds
  until it fits: largest `ask.detail` first (the prompt survives and stays answerable, with a marker
  saying where to read it), then `optDescs`, then whole sessions off the urgency-sorted **TAIL**,
  with any `asking` row it drops counted into `hiddenAsking`. Tier 3 is what makes this **TOTAL**
  where the transliteration is merely thorough: a 200KB session still yields a sendable line, and it
  covers any future field, any hook version, and — the case no checker can reach — **a STALE hook
  still installed in `~/.claude`, emitting untransliterated text until someone runs `install.sh`**.
  Everything shed is LOGGED, because a silent truncation would be the same class of defect as the
  freeze. Both shedding loops are bounded by the session count: this runs inside the 5s tick and a
  spin there would be worse than the freeze it prevents, which a fault-injection run proved by
  hanging on an unbounded one.
  **`ask.voiceText` BYPASSED layer 1, and the obvious fix was WRONG.** It is parked by
  `handleVoiceAnswer` under `capUtf8`'s byte cap and assigned straight into the payload, so it never
  met `clean()` — and Whisper is the densest non-ASCII source in the system. The budget never
  noticed, because 150 bytes is 150 bytes either way; what it cost was the GLASS. *"Yes - let's go
  ahead... but don't touch the cache"* reached the wire at 47 chars / 55 bytes and drew as
  `Yes  lets go ahead but dont touch the cache` — **holes exactly where the punctuation was**, on
  the one screen whose entire purpose is proving a human read THESE EXACT WORDS before signing them.
  Now 49 chars / 49 bytes and drawn in full. **The fix had to be at the PARK SITE, before
  `voiceSha()`.** Transliterating in the payload builder — where `item.ask.voiceText` is assigned,
  which is the obvious place — desyncs the text the device DISPLAYS from the text that gets signed.
  **This file used to say the host would then REJECT valid answers. It would not, and the correction
  matters more than the original claim did.** `sessions.ino:2259` builds `nonce:pid:TEXT:<sha16>`
  from the `voiceSha` the host SENT — the device does not re-hash what it draws — and the host
  verifies by re-hashing its own PARKED copy, which still matches. So the answer is **ACCEPTED**:
  the human reads one string and authorises another, with a valid signature and nothing logged.
  A rejection would have been loud and self-limiting; this is a silent divergence on the one screen
  whose entire purpose is binding what was read to what was signed. That is why the send-time guard
  (`host/wire-ascii.mjs`) **suppresses** `voiceText`/`voiceSha` rather than repairing them when the
  park site has failed — a missing confirm screen is a visible, safe failure. That ordering is
  asserted, and the plausible wrong fix is one of the injected faults: moving it fails 6 assertions
  by name.
  **Found en route:** `histFlatten`'s truncation marker was **U+2026**, outside both fonts, so a
  truncated history preview showed no sign whatsoever of having been cut. Three ASCII dots now — the
  fourth instance of the trap this file already records for `fitText`'s ellipsis, the `CLAUDE/air`
  tag separator and the PAIRED MACS middle dot.
  **Worth recording as METHOD: on a finite domain, EXHAUSTIVE beats fuzz and costs under a second.**
  The drift guard between `host/to-ascii.mjs` and the hook's forced inline copy runs over **71,738
  strings** — a hand-written corpus, a seeded fuzz sweep including lone surrogates on both sides,
  every map key PARSED out of the module, every BMP code point, and an astral stride. A mutated
  `"Ø": "O"` → `"0"` was caught by the exhaustive half and **missed entirely by 5,000 fuzz
  strings**. The copy is duplicated rather than imported for the reason `capBytes()` duplicates
  `capUtf8()`: `install.sh` copies that hook alone into `~/.claude`, so it can only ever import node
  builtins.
  **A TRIPWIRE deliberately asserts that something is STILL WRONG.** With `optDescs` at its cap on
  all four options of all six sessions, the line is over the guard **even in pure ASCII** — a
  residue no transliteration can reach, because it is a CAP decision. It is far outside real traffic
  (one asking session at the cap is 3,741 bytes) and `wire-fit.mjs` now handles it at send time, but
  the assertion stays: **if it ever fits, the reasoning behind these caps must be re-derived.**
- The ask/answer screen: tapping an asking session's row opens option buttons wired to
  `sendAnswerToHost()` (which transmits on USB **and** BLE TX notify, in ≤20-byte chunks).
  Long detail text pages by tapping the text block — deliberate: drag-scrolling flickers and
  misfires on this resistive panel, discrete pages don't.
- **AN ASK'S OPTIONS CARRY THEIR DESCRIPTIONS ACROSS THE WIRE, AND BOARD 2 DRAWS THEM.**
  `AskUserQuestion` puts "what this option means, or what happens if you pick
  it" in each option's `description`, and `buildAsk()` discarded it on the very line that took
  `label` — so a four-way question reached the device as four bare labels and **the information you
  need in order to CHOOSE never left the Mac**. `ask.optDescs` is now emitted parallel to
  `ask.options`, and **only when at least one description is non-empty**, so an Allow/Deny prompt's
  payload does not grow by a byte and absence is byte-identical to the old record (asserted against
  `git show HEAD:` of the hook itself). A device that does not know the field ignores it — the same
  backward-compatible shape as the trailing `to=<hostId>` address, so no protocol version bump.
  `host/index.mjs` needed no functional change: the pass-through is the existing
  `{ ...record.ask, nonce }` spread, and a comment pins that as the invariant, since turning it into
  a named field list is the one edit that breaks this silently.
  **THE 96-BYTE CAP IS A STATED CONVENTION, MECHANICALLY ENFORCED — NOT A DERIVATION FROM THE WIRE
  BUDGET.** The convention: *a description may not cost more bytes than the LABEL it explains*, and
  a label is capped at 32 characters, so its byte ceiling is 32 x 3 = **96**. Both numbers are
  parsed out of the hook, so 97 fails by name. It is capped in BYTES on a codepoint boundary, not
  characters, because the device stores each in a fixed `char[]` and truncates by BYTE — and real
  descriptions are full of em-dashes and curly quotes at 3 bytes each (measured on a real captured
  payload, where all four options carried at least one).
  **Say plainly why it is a convention and not arithmetic: the first attempt DERIVED 64 from the
  wire budget and the derivation was wrong.** It read "64 lands at 15,923 with 77 to spare", which
  was computed off the *no-parked-voice* baseline while the row above it presented the parked-voice
  case as the worst one — at 64 with a parked transcript it is 17,093, i.e. **1,093 OVER**, not 77
  under. That number then went into a 20-line source comment. And the model was in the wrong unit
  anyway (see the byte-budget note under the line buffers): the saturated case is over the guard
  with this field **absent**, so **no value survives it, including zero** — which is exactly why the
  worst case cannot set this cap. Cutting to 64 bought nothing against the case it was cut for and
  cost real information on every question: it truncated `trade-off` to `trade-of`.
  `host/ask-optdescs-check.mjs` is the point of the fix — 47 assertions, `--selftest` catching 5/5
  injected faults — and it exists because **the first attempt's arithmetic lived in a scratchpad
  that ceased to exist, so nobody could re-run it.** A number nobody can re-derive is not a
  measurement.
  **THE DEVICE NOW STORES AND DRAWS THEM, on board 2 only, and the storage is per board for a
  reason the header spells out.** `SessionInfo` is SHARED, so the member is compiled into both
  boards whether or not a pixel of it is ever drawn — what is not shared is the COST.
  `ASK_OPT_DESC_BYTES` is **97** on board 2 (the hook's 96 plus the NUL) and **1** on board 1, the
  smallest legal array size, so every slot there can only ever hold `""`. Sizing board 1 to the real
  cap would spend `4 x 97 x MAX_SESSIONS` = **2,328 bytes of DRAM** on the board whose ~26KB of free
  heap is the binding constraint on the audio path, for text its panel does not render. It is a
  per-board CONSTANT rather than an `#if` at the declaration, and that was forced rather than
  chosen: behind an `#if` the checkers parse ONE arm and report it for BOTH boards, which is exactly
  the false reading `BATT_LEFT_BYTES` was fixed for.
  **THE DETAIL SIGNATURE TAKES A 32-BIT FNV-1a HASH OF THE DESCRIPTIONS, because verbatim is not
  tight — it is IMPOSSIBLE.** Four descriptions plus their separators are `4 x (1 + 96)` = **388
  bytes** on their own against a **384-byte** `detailSigCache`, and the rest of the signature needs
  the room too; hashing brings the worst case to **372/384**. **It is not a birthday problem**, and
  that distinction is the whole argument: `buildDetailSignature` compares against the ONE
  immediately-previous cached value, never against a population, so a missed repaint needs a
  collision with that single value — p ≈ 2⁻³² per event, not `sqrt`. The obvious cheaper shape,
  a per-slot prefix, is **strictly worse**: 12 bytes of headroom buys 3 characters a slot, and real
  descriptions SHARE prefixes (`Allow this…` / `Deny…`), so prefix-N collides at rates that are
  actually reachable.
  **ONE chip, ONE reader, TWO sections.** The ask header has exactly one top-right slot and
  `READ ALL` owned it, so the question was never where the new button goes but what the one button
  means. It now opens a reader carrying the question's own detail FIRST and then every option with
  its description, paged as a single document, and it appears when EITHER the detail overflowed or
  any description exists. The label moved with it — board 2's chip says **`READ MORE`**, because
  `READ ALL` is a promise about the DETAIL and in the new case it is a lie in the direction that
  costs information: a detail that already fits, beside a chip saying READ ALL, tells a reader there
  is nothing behind it, so the descriptions would be reachable and never found. `READ MORE` is true
  in all three states. `ASK_READ_BTN_LABEL` is a per-board macro (the shape `WAKE_HINT` already
  uses); board 1 keeps `READ ALL`.
  **Three alternatives were considered and each lost for a nameable reason**, recorded so they are
  not re-proposed: giving the new button the slot whenever descriptions exist — a long detail
  becomes unreachable exactly when the question is most complex, against this repo's rule never to
  offer a control that cannot work; **two half-width chips** — 43-45px, under `TAP_MIN` 46, with
  labels shrinking to about four characters; and moving the detail into the reader always — it costs
  the at-a-glance command preview that makes a permission prompt answerable in one tap.
  **The accepted cost is that a long detail can push the options to a later page, and the screen
  SIGNPOSTS it** rather than leaving an enabled NEXT to be inferred: one body row is reserved on
  page 1 for `WHAT THE OPTIONS MEAN - PAGE n`, naming the same heading the section opens with. That
  page number is the only new arithmetic here that actively MISLEADS when wrong — a row naming the
  wrong page sends a reader somewhere with no options on it, from which the honest conclusion is
  that there are none — so it is asserted by **WALKING THE PAGER**, not by restating the division:
  the bounds come from `drawReader`'s own parsed `pageLo`/`pageHi` and the 1-based number from the
  same expression the header's `n/m` counter uses, evaluated with C's TRUNCATING division over every
  reachable detail length at both line steps. `+1 → +2` and `+1 → +0` each fail by name.
  **BOARD 1 HELD BYTE-IDENTICAL THROUGH ALL OF IT, and the three natural shapes all moved it** —
  measured against `board-baseline.mjs --check 1`, not reasoned about: two sibling `if`s sharing one
  chip block cost **+8 bytes**; the chip factored into a function cost **+60** (not inlined); and
  nesting it inside `if (askReadOffered)` came out at **+0 bytes with DIFFERENT CONTENT** — one
  `mul16s` with its operands swapped. **That third one is the strongest evidence this repo has for
  why the retired size check had to be replaced**, because a size comparison passes it. What ships
  instead is the chip's draw written once per `#if` arm (duplication guarded by a checker assertion
  rather than trusted) and `askReadOffered` spelled as a function-like MACRO on board 1 so its
  argument cannot perturb register allocation in `handleAskTouch`.
  **The dissent is recorded rather than settled:** the reviewer would have re-baselined board 1 and
  written the natural shape, on the argument that holding byte-identity is letting a check reach
  into the shape of the source. The counter-argument is the `+0`-bytes case above — the cost of
  finding it was three builds, and it is the sort of thing that is only ever found by looking.
  **Costs, measured:** board 1 **+336 bytes of flash, +24 RAM** (the 1-byte-per-slot placeholder,
  re-baselined deliberately with the deltas in the commit message); board 2 **+384 / +2,328** for
  the storage, then **+1,248** for the section, signpost, second chip copy and `READTEST`, then
  **+112** for `READTEST`'s two refusal lines.
  **`READTEST` (board 2 only) exists for the reason `TAB`/`PAGE`/`KBTEST`/`EMOJITEST` do:** the
  reader needs a finger on the chip and `SCREENSHOT` can only record what is already on the glass.
  Both its refusals PRINT their cause (`no ask is pending`, `another full-screen surface is up`) —
  the rule `POWERPROBE`'s `not on battery (unplug USB; state=2 mv=3866)` exists for, since from the
  Mac silence and impossibility look identical.
  **WHAT IS STILL OPEN.** Board 1 draws no descriptions at all — it stores a placeholder and its
  chip still says `READ ALL`, which is honest there because there is nothing else behind it. The
  96-byte cap truncates every real description to about a third, mid-word, which is a convention's
  cost and not a bug. And the wire's own unit mismatch, above, is untouched: a question in CJK can
  still overflow `feedChar`'s guard **with this field absent entirely**. **No screenshot in this
  work vouches for the panel's colours** — board 2's `SCREENSHOT` reads the shadow framebuffer, so
  it proves the renderer self-consistent and nothing about the glass (see the verification trap
  under Two boards).
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
- **The type scale is three rungs, and `UI_FONTS[]` IS PER BOARD.** It maps a font id to
  `(face, size, cellH)`, behind the same `#if BOARD_USES_TFT_ESPI` every other board split uses:
  board 1 is `T_META`/`T_BODY` → Cozette 6x13, `T_HEAD` → Terminus 10x18 bold, `T_HERO` →
  Cozette 12x26; board 2 is **Spleen 8x16 / 12x24 / 32x64, every rung NATIVE at size 1** — no
  entry on that board is a mechanical upscale of another. The ids are the legacy TFT_eSPI numbers
  the ~72 existing call sites already pass, so the registry landed **inert** — adding a face, or a
  whole second family for a second board, cost zero changes at those sites.
  **WHY 8x16 AND NOT 12x24, WHICH IS THE COUNTER-INTUITIVE PART OF THE WHOLE CHANGE.** Board 2 has
  twice the pixels but is only 15% denser (6.489 vs 5.624 px/mm), so **the same pixel size is
  physically SMALLER there** — Cozette 6x13 is 2.31mm tall on board 1 and 2.00mm on board 2, which
  is why "just keep the fonts and spend the pixels on air" left body text a step down from board 1
  rather than equal to it. Spleen 8x16 is **2.47mm**, restoring parity, and it keeps a **32**-character
detail-card lane against board 1's 31, so every existing character-budget argument carries over
  instead of needing re-invention. 12x24 would have been 3.70mm and **21** columns — a third of the
  card's text gone to make the text bigger than board 1's.
  | | board 1 | board 2 at 6x13 | board 2 at 8x16 | board 2 at 12x24 |
  |---|---|---|---|---|
  | cell height | 2.31mm | 2.00mm | **2.47mm** | 3.70mm |
  | detail-card lane | 31 cols | 43 | **32** | 21 |
  **The lane row is `CARD_W - 2*PAD`, and it has to name WHICH lane** — an earlier version of this
  table read `34 | 42 | 32 | 21`, which is reproducible from no lane in the code: it compared board
  1's *keyboard* lane against board 2's *detail-card* one and the 42 fitted a 256px lane that exists
  nowhere. There is no single "the card lane" on either board. The four that matter, board 1 then
  board 2: detail card (`CARD_W - 2*PAD`) **31 / 32**, keyboard (`CARD_W - 12`) **34 / 35**,
  voice and confirm panels (`CARD_W - 8`) **34 / 36**, full-width ask and reader **36 / 37**.
  **`CARD_HERO_SIZE` NO LONGER EXISTS ON BOARD 2.** Board 1's hero is Cozette 6x13 pushed to
  `setTextSize(3)` — one mechanical step past its own `T_HERO` registry entry, which is already
  size 2 — so that board needs a constant naming the override. Board 2's `T_HERO` is Spleen 32x64
  at size 1, so there is no scale factor left to name and the constant is gone from
  `board_es3c35p.h` rather than set to 1. At 64px the hero is 9.86mm against board 1's 6.9mm —
  *bigger*, not merely matched, because Spleen's only rung above 12x24 is 32x64 and there is
  nothing between them to land closer.
  **`TEXT_ADV` and `CODE_LINE_H`/`HERO_LINE_H` exist because literals describe ONE board's face.**
  Every character-lane division used to be `/ 6` and every code line step a literal `13` — both
  Cozette's — and after board 2's face changed those literals went on being right-looking and
  wrong. The named per-board pair is what a lane or a stacked block derives from now, and the
  geometry checkers assert each against the parsed `UI_FONTS[]` table (`uiLineH()` is not a
  constant expression, so a board header cannot `static_assert` it itself).
  **THE FULL-SCREEN READER WAS STILL DOING IT, AND IT IS THE SAME DEFECT THIS FILE ALREADY RECORDS
  ONCE — the 13px step under a 16px cell.** `drawReader()` hardcoded `lineH = isCode ? 14 : 18`;
  the 14 is Cozette 6x13's cell plus a row of leading, i.e. **board 1's face**. Board 2 draws Spleen
  8x16, so `drawString`'s opaque box erased rows 14..15 of every code line — 2 of that face's 4
  descender rows — and since **every `perm` ask reads as code**, this clipped g/j/p/q/y in whole
  commands. The identical literal had already been fixed at the ask PREVIEW and the voice-confirm
  panel; **this site was missed, and it is the one that renders the command in full.** That is the
  transferable part: a literal fixed at two of its three sites is not fixed.
  Measured on the glass before and after by decoding the `SCREENSHOT` PNG and counting inked rows —
  an all-`g` line inked y135..143 with **144..145 BLANK**, against **145..154** after, where row 154
  is the `g`'s closing bar: **210px of ink per line that was being erased outright**. Pitch measured
  14 then 16 straight from the ink periodicity. (Board-2 framebuffer evidence, as above: it proves
  what the renderer composed, which is exactly the question here.)
  **The fix is per-board and the naive one is wrong.** `CODE_LINE_H` unconditionally would take
  board 1 from 14 to **13** — tighter than it ships, and it moves that board's binary. So
  `READER_CODE_LINE_H` is board 1 `CODE_LINE_H + 1` (14, unchanged) and board 2 `CODE_LINE_H` (16,
  the bare cell, matching the `HIST_LINE_H` the history list and full-entry pager either side of it
  already use). The prose 18 is judged and KEPT on both boards — `T_BODY`'s cell is 13 and 16, so 18
  is leading rather than a defect — and named only so the whole ternary is derived rather than half
  of it. Board 2's reader pagination goes 25 → 22 code lines, which is the correct consequence;
  nothing stated the old count, and the page budget `requestHistory()` sends the Mac is
  `HIST_LINE_H`-based and untouched.
  **The checker assertion that should have caught it was TRANSCRIBED, and was wrong in BOTH arms.**
  `settings-geom-check.mjs` modelled the two steps as `HIST_LINE_H` and `uiLineH(T_HEAD)` against a
  real 14/18 — board 1's prose arm agreed only because Terminus's cell **happens** to be 18. It now
  PARSES `drawReader()`'s own ternary and resolves each token against the board's constant table
  (a literal resolves to itself, so a revert is still measured; an unknown token throws rather than
  passing), then asserts both steps `>=` the code face's cell height taken from the parsed
  `UI_FONTS[]`. Four fault injections fail by name. Same rule as everywhere else here: **a checker
  must PARSE the constant it certifies, never TRANSCRIBE it** — this is the third time that has
  bitten.
  **Every Spleen glyph in 0x20..0x7E has `xOffset == 0` and `width == xAdvance == 8`, so
  `textWidth`'s last-character rule is a NO-OP on board 2** — a column count that divides exactly
  is exact for *any* string there. Cozette is not like that: its advance is a uniform 6 but
  `max(xOffset + width)` is **7** (space, `4`, `q`), so board 1's own 34-column lane is 1px hot for
  a line ending in one of those three (harmless — the ink stops 3px inside the card). The checkers
  assert the monospace property rather than assuming it, so a regenerated Spleen that broke it
  fails loudly instead of quietly invalidating every lane derived from `TEXT_ADV`. Two cheaper options were tested and ruled out, not argued about: Cozette's
  `cozette_hidpi.bdf` is a **byte-identical mechanical 2x upscale** (decoded glyph-for-glyph), and
  a 1px synthetic double-strike has nowhere to go because **78 of 95 glyphs already reach or pass
  the 6px advance** (`4` reaches 7). So Cozette offers exactly one size and its double, and a
  genuine middle rung has to come from another family.
  **`T_TITLE` still resolves to body on purpose.** It is used inside `uiButton`, the single shared
  button style, so pointing it at `T_HEAD` would widen EVERY button label on the device —
  Allow/Deny and the confirm dialogs included — by 67%, past widths chosen for a 6px face
  (`CALIBRATE TOUCH` is 90px at 6x13 and 150px at 10x18). It migrates with the settings/overlay
  restyle, where those widths get re-derived.
  **`drawIfChanged` derives its erase height from the registry, never a literal.** It used to
  compute `th = 13 * tft.textsize`, baking Cozette's cell height into every field's erase
  rectangle; any taller face clears part of its own box and ghosts on every update. Same class of
  silent bug as a change-only cache shorter than the string it holds.
  Session names use all three rungs: `drawSessionRow` walks 12x26 → 10x18 → 6x13 and takes the
  first whose measured width fits, so a long name shrinks a step instead of being cut. The shrunk
  name is centred in the 26px band the big font would have filled — the old hardcoded `+6` was
  exactly `(26 - 13) / 2`, so the offset is now derived and reproduces it. `fitText` returns an
  empty string when nothing fits at all, which is reachable at 10px where it was not at 6px, so
  the ladder falls through to the smallest rung rather than draw a blank name.
  Cost: **+3524 bytes of flash total, zero RAM** (`PROGMEM`) — 2850 of that is the Terminus font
  data itself (roughly what a second added face would cost), the rest is the registry table,
  tokens, and comments, plus the ladder code. Regenerate with
  `python3 bdf2gfx.py <bdf> <Name> <yAdvance> > <Name>.h`; the BDFs are **not** committed (Cozette
  667KB, Terminus 235KB) but the generated headers and both licence texts
  (`licenses/Terminus-OFL.txt`, `licenses/Cozette-MIT.txt`) are. The same recipe vendored the three
  Spleen faces for board 2's type scale (`Spleen8x16.h`/`Spleen12x24.h`/`Spleen32x64.h`, run with
  yAdvance 16/24/64) — same rule, BDFs not committed (Spleen 8x16 154KB, 12x24 217KB, 32x64
  682KB), only the generated headers and `licenses/Spleen-BSD-2-Clause.txt` are, and each was
  passed through `--verify` against its own BDF before being trusted.
  `bdf2gfx.py --verify <bdf> <header>` decodes a header and compares it glyph-for-glyph with its
  source, and `--selftest` corrupts one byte of `A` and fails if that goes unnoticed — the same
  teeth-proving trick as `palette-check.mjs --selftest`. **Both need a BDF, and the BDFs are
  deliberately uncommitted, so neither is runnable from a fresh checkout** — unlike every other
  check in this repo, which is why it is the one that exits non-zero if you run the whole list.
  Fetch the BDF first (`--selftest <bdf> <header>`); bare `--selftest` raises
  `FileNotFoundError` rather than printing usage. That check earned its place: the
  generator had only ever been run on Cozette, whose glyphs are tightly cropped, and Terminus
  declares a uniform full-cell `BBX` that exercises packing paths which had never run.
- **The BRIGHTNESS / SLEEP AFTER / VOLUME steppers put the label in the MIDDLE column, and that
  is what makes the keys fit.** The label used to sit top-left, in the same column as the left
  key, so the keys had to start below it - at `+14` in a 56px card whose 2px border owns
  `+54..+55`, which left them ending flush on that border with no padding at all. Moving the label
  above the value it names frees the whole interior height: keys are now **44px** (4px OVER
  `TAP_MIN`, not merely at it) at `+6..+49`, with 4px of air top and bottom. Label centres at
  `+15`, value at `+32`, and the bar at `+43..+48`.
  Three things worth keeping:
  - **The value renders in `T_HEAD`** (Terminus 10x18 bold), and the `+`/`-` glyphs too. At body
    size the number was the same weight as the label naming it, and a 6px glyph on a 44px key was
    a speck. This is the type scale's middle rung doing the job it was added for.
  - **Only BRIGHTNESS gets a bar.** It is the one continuous 0-100 setting, so the bar says where
    in the range you are. Sleep and volume are discrete presets whose label already says that, and
    a bar there would be decoration.
  - **The touch zones are much bigger than the keys and always were**: `stepperHit` claims the
    left third of the card for decrement and the right third for increment, over the full card
    height - roughly 72x56 each, against a 44px key. Worth knowing before "fixing" a hit test that
    is not the problem. The centred label spans x 87..153, clear of both zones, so a tap on it
    cannot step the value by accident.

- **The battery reading is coloured by level, and charging is a STATE rather than a level.**
  `colorForBattery` bands at <=10 `COLOR_BAD`, <=30 `COLOR_WARN`, else `COLOR_GOOD` - note this is
  INVERTED against the usage palette's meaning, where a HIGH percentage is the bad one.
  `colorForBatteryState` wraps it: charging returns `COLOR_ACCENT` and full returns `COLOR_GOOD`,
  because while power is coming in 8% is not a warning, and a charging device sitting there showing
  an alarm about a problem actively being solved is just noise. The glyph and the number both go
  through it, so the two can never disagree.
  **Colour is not the only carrier**, which is what keeps this inside the colour-blind rule the rest
  of the UI follows: the reading is printed as a NUMBER, the glyph carries a proportional FILL, and
  charging/full say so in words. The three bands stay legible to a deuteranope eye and in flat
  greyscale without the colour doing any work.
  **Both readings cache their COLOUR next to their text.** `drawIfChanged` compares text only, so a
  colour that flips while the string stays identical would never reach the panel - plugging in at a
  steady charge leaves the settings row reading `42% 3.85V` while its colour should go from good to
  accent. `battTextColorCache` / `battRowColorCache` bust the text cache on a flip. This is the same
  guard `renderUsageTab` needs for its stale-dimmed hero numbers, and it is easy to forget precisely
  because the common case (the number moved too) hides it.

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
  (spans x 15..46 with the name starting at x=48) and the tightest 38px row (y+3..y+35), so no
  text moved. Each frame is composed into `sparkBuf` and pushed as ONE `pushImage` rather than
  1024 `drawPixel` calls, and because it repaints the whole box there's no separate clear.
  **The spinner is a BLIT, so its rectangle must clear the row's rounded corner.** It paints a
  full 32x32 area including background pixels, and at the old centre (`SESSION_ROW_X + 20`) that
  rect started at x=12 while the corner's 2px border reaches x~12.9 on the spinner's topmost row -
  so the blit's `COLOR_CARD` background bit a notch out of the border. On LIGHT, where
  `COLOR_CARD` is white, it read as a white nick in the card's rounded corner. The centre is now
  `SESSION_DOT_CX` = `SESSION_ROW_X + 23`: the rect is x 15..46, clear of the border by 2.1px and
  2px short of the name lane at x=48.
  **`SESSION_DOT_CX` exists because TWO paths draw that indicator** - `drawSessionRow()` on a
  repaint and `tickWorkingSpinner()` every 120ms - and when the fix was applied to only one of
  them the animation happily redrew at the old x four times a second, undoing it. Any change to
  where the indicator sits has to be to that constant, never to a call site.
  This is the sole place that repaints on a timer instead of on a value change; it stays within
  the flicker-free discipline because it's one small blit, never a cleared region. Gated to the
  sessions list actually being visible (`!isAsleep && !octoActive && !showingDetail &&
  !readerActive && currentTab == TAB_SESSIONS`), and it deliberately does **not** touch
  `lastNonIdleMillis` — an animation must never look like activity to the auto-sleep timer. The
  spark is a distinct radiating shape, and motion is an extra cue, never the only one.
  **WHAT CARRIES THE NON-HUE HALF DIFFERS PER BOARD NOW, AND THIS SENTENCE USED TO CLAIM
  OTHERWISE FOR BOTH.** On **board 1** it is unchanged and literal: working is told apart from
  asking (filled square) and waiting (hollow ring) by **shape alone**. On **board 2** the agent
  mark replaced the square and the ring at every status — that was the deliberate trade §5 of the
  sessions redesign made, because the mark has to say WHICH AGENT and status already owns the
  colour — so the mark's shape now distinguishes Claude from Codex and no longer distinguishes one
  status from another. The status carrier there is the **status pill's FORM** (filled = asking,
  outlined = waiting, boxless dim text = working) on every ordinary row, and on the **expanded band
  card** — which draws no pill and no indicator at all, its border being hue — it is the **status
  WORD** from `labelForStatus`. That word is therefore load-bearing rather than decorative:
  `sessions-geom-check.mjs` asserts the three are distinct, non-empty strings, and collapsing two of
  them left every checker at zero failures before it did. The colour-never-alone rule holds on both
  boards; only the thing carrying it moved.
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
- **BOARD 2 FIRST: on that board `SCREENSHOT` reads the SHADOW FRAMEBUFFER, not the panel, so a
  capture is correct by construction even when the glass is wrong.** Everything in this bullet is
  about board 1, where `readRect` really does read the panel. Do not use a board-2 capture as
  evidence about colour — use `COLORTEST`. See the verification trap under Two boards; it cost this
  repo nine tasks of misplaced confidence. (`SCREENSHOT` is also 0.4s on board 2 against ~18s here,
  because native USB CDC replaces the CH340.)
- **The device screenshots ITSELF, and the panel really can be read back.** `SCREENSHOT` (via the
  command-trigger file) reads the framebuffer with `readRect()` and ships it as base64 RGB565;
  `finishShot()` in `host/index.mjs` rebuilds it and writes a PNG straight to `~/Deckhand-shots/`
  (zlib is in node and a PNG is four chunks, so no external encoder and no intermediate file).
  `TAB 0|1|2` and `PAGE 0..3` switch what is displayed first, because the capture path can only
  record what is currently on the glass - without them every screenshot is of whatever tab someone
  last touched. 240x320x2 = 153,600 bytes -> ~205KB of base64 -> **~18s at 115200**, measured. Nothing is blanked
  or redrawn while it runs, so the capture is exactly what was on the glass.
  Two measured facts underpin it, and the second cost a wasted capture:
  - **Readback works.** The FAB note says it is unreliable here; that is a SPEED argument about
    per-pixel reads for transparency, not a correctness one. Four known colours written and read
    back on this wiring came back bit-identical at `SPI_READ_FREQUENCY 20000000`.
  - **`readRect()` returns pixels BYTE-SWAPPED and `readPixel()` does not.** Writing `0xF800`
    yields `readPixel=0xF800` but `readRect=0x00F8` - the same internal order sprites use, and the
    same trap `pushImage` set for the crab art. The firmware un-swaps before encoding so the wire
    format is plain big-endian RGB565. The failure is nasty because it is not obviously a failure:
    the first capture was a perfectly sharp, correctly-laid-out screenshot with purple text where
    near-black belonged.
- **The standalone screen (`drawWaitingScreen()`) — what shows before the host has ever spoken.**
  The ship's-wheel mark turning, the wordmark, the device's own name, a state line, and the
  command to run on a Cozette panel. It is the first thing anyone sees, and three things about
  it are load-bearing:
  - **The old instruction was a command that RELIABLY FAILS.** It read "Run host/index.mjs on
    your Mac" — the exact thing macOS TCC SIGABRTs the moment noble touches CoreBluetooth. The
    screen now says `open DeckhandBLE.app`. Anything added here has to be a command that works
    from a fresh checkout, not the shortest way to describe the file.
  - **It only ever claims what the device can actually KNOW, and the cable is not on that list.**
    There is no VBUS-sense pin and `usbLinkActive()` keys off received bytes — which are zero
    until the host runs — so "USB connected" is unknowable here and is never stated.
    `bleConnected` and the NVS pairing store are real, and every branch derives from those:
    a live BLE link or a recent `lastRxMillis` means the host demonstrably EXISTS, so those
    branches say "waiting for the next/first update" and offer **no** command — telling someone
    to launch an app that is already running is the failure mode this replaced. The recent-RX
    branch is what makes `RECAL` and a mic test honest, since both reset `everReceived` while
    the host keeps ticking. A Mac is named only when exactly one is paired: `activeHost` is
    still -1 until a payload arrives, so with several the device genuinely cannot tell which is
    yours.
  - **`firstEver` had to start CLEARING the content area.** The tab's static chrome only paints
    its own boxes, so a 64px mark, a wordmark and a command panel survive underneath it. The old
    two lines of text sat inside card 1 and were mostly overdrawn by luck; at this size the
    residue is guaranteed.
  It lives on USAGE (`waitingScreenVisible()`), because `renderUsageTab` bails on `!everReceived`
  and that tab would otherwise be empty card outlines. SETTINGS stays reachable and useful while
  waiting — it shows the link and pairing state, which is exactly what you want when nothing is
  arriving.
- **The logo (`DeckhandLogo.h`, generated by `logo2c.py` from `docs/logo.svg`) — FOUR LAYERS, so
  the wheel can turn while the hand holding it stays put.** This is the one piece of art in the
  sketch that keeps its **own colours** rather than being tinted, because it is the project's mark
  and not a status glyph — so it deliberately does not go through `blit2bpp`. The split comes
  straight from the SVG's own paint order: `LOGO_BG` (96x96 RGB565: the tile gradient plus the arm
  and palm BEHIND the wheel), `LOGO_TILE` (2bpp rounded-rect silhouette), `LOGO_WHEEL` (2bpp x8,
  the only thing that moves) and `LOGO_FG` (2bpp, the four fingers wrapping IN FRONT of the rim).
  ~41KB of flash.
  Three implementation facts are load-bearing:
  - **Composed and pushed ONE ROW at a time** (`static uint16_t row[96]`, 192 bytes). A whole frame
    is 18KB against ~70KB of free heap after the BLE stack, and per-pixel `fillRect` is hopeless
    here because the tile is a **gradient** — runs of equal colour average 2–3px, so a frame would
    cost thousands of calls instead of 96. This is also the one place `pushImage` is used against
    the screen, so it sets `setSwapBytes(true)` (and restores it): `row[]` holds ordinary RGB565.
  - **`LOGO_BG` is generated with SQUARE corners on purpose, and `LOGO_TILE` does the shaping.**
    Baking a page colour into the art would put a hard square of the wrong shade behind the mark
    under one of DARK/LIGHT — and it is a coin flip which. Fading the corners through the tile mask
    into the live `COLOR_BG` is what makes one copy of the art correct in both themes.
  - **Not 8 pre-composited full-colour frames**, which would be 147KB against 41KB, for art on a
    screen you rarely see. The hub is punched out as a hole so the tile shows through it; the
    source paints it `#1B5FA6` against a gradient reading ~`#2F76B8` there, which across a ~3px dot
    is not a difference anyone can see, and a fifth layer for it would be.
  **The rotation step is 60/8 = 7.5°, and that is forced — do not "tidy" it to 45.** The wheel has
  EXACT 6-fold symmetry (three spokes drawn as full diameters give six arms; six grips at
  0/60/…/300), so a 60° turn is a no-op: 8 frames at 45° would neither loop seamlessly (45 does
  not divide 60) nor complete a cycle, and 8 at 60° would emit 8 identical frames. This is the
  hazard `codex2c.py` flags as hypothetical for its own mark; here it is real, because these arms
  are `use` clones rather than hand-drawn lobes. Only the WHEEL layer rotates - spinning the hand
  too would turn the arm upside down. The generator refuses to emit a static cycle,
  since a dead-still wheel on a waiting screen reads as a hung device — the one thing the
  animation exists to rule out — and it **measures motion rather than comparing frames for
  equality**, which is the difference between a guard and a decoration: a rotation that is a
  visual no-op still leaves frames differing by rasteriser sub-pixel noise, so an equality test
  can miss it. **The threshold is resolution-dependent and must be re-measured if the size or the
  art changes** — at 96x96 the real 7.5° step moves at least 0.161 mean absolute alpha (units of
  0–3) against frame 0, where at 64x64 the same step measured 0.371, so it is not a constant to
  copy around. `MIN_MOTION` is 0.05: ~3x under the signal, and above the noise. Proven by running
  it — forcing a 60° step exits 1.
  The tick is `tickWaitingWheel()` at 250ms (one turn every 2s), gated on
  `waitingScreenVisible()` and deliberately not touching `lastNonIdleMillis`.
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
- **`firmware/tft_setup/User_Setup.h` is BOARD 1 ONLY.** Board 2 does not link TFT_eSPI at all
  (`BOARD_USES_TFT_ESPI 0`), so nothing in that file affects it and copying it into the library is
  not part of a board-2 setup.
- **TFT_eSPI's pin/driver config now lives in THIS REPO at `firmware/tft_setup/User_Setup.h`**, and
  is copied into the library. TFT_eSPI reads it from a file *inside the library*, so it used to
  exist only there - which meant reinstalling or updating TFT_eSPI silently wiped the board's pin
  mapping, with no record of it anywhere in the repo. Restore a local machine with:
  `cp firmware/tft_setup/User_Setup.h ~/Documents/Arduino/libraries/TFT_eSPI/`
  The committed copy is byte-identical (comments aside) to the one that builds today, and the only
  file ever modified inside that library is this one - `User_Setup_Select.h` is stock and includes
  `User_Setup.h` by default, which is what makes the drop-in work.
- Colors deliberately avoid a green/yellow/red scheme (the `COLOR_GOOD`/`WARN`/`BAD` constants
  use a blue/orange/reddish-purple palette instead) because a green/yellow/red scheme collapses
  under the most common colour-vision deficiency, and status is never conveyed by color alone.
  **WHAT THE SECOND CARRIER IS DIFFERS PER BOARD, and this sentence named only board 1's.**
  On **board 1** it is `drawStatusDot`'s shape: filled circle = working, filled square = asking,
  hollow ring = waiting. On **board 2** that same function draws the **agent mark at every
  status** — §5 of the sessions redesign spent the indicator's shape on saying WHICH AGENT,
  because status already owns the colour — so the shape there separates Claude from Codex and no
  longer separates one status from another. The carrier is the **status pill's FORM** (filled /
  outlined / boxless dim text) on every ordinary row, and on the **expanded band card**, which
  draws no pill and no indicator at all, it is the **status WORD** from `labelForStatus`. Both
  substitutes are asserted in `sessions-geom-check.mjs` — the pill's form, and the three words
  being distinct — because each is now the only thing standing between two states. The longer
  note under the "working" spinner further down says the same thing from the animation's side.
- **The theme control has THREE modes - DARK, LIGHT and AUTO - and AUTO is a CLOCK, not a
  sensor.** This board has no light to measure: every ADC1 channel is spoken for (touch on
  32/33/36/39, battery 34, mic 35) and ADC2 is unusable while BT is up, so an LDR would need
  hardware that does not exist. AUTO therefore keys off `hostNowSec()` - LIGHT from
  `THEME_LIGHT_FROM` (07:00) to `THEME_LIGHT_TO` (19:00), DARK otherwise. That clock comes from the
  host but advances from `millis()` once a base has been set, so AUTO keeps working while the Mac
  is away or asleep. With no clock at all it resolves to **DARK** - the device boots before the
  host connects, and a full-white screen is the worse thing to guess wrong at 3am.
  `themeMode` (what the user chose) is now distinct from `themeIndex` (which palette is live); in
  AUTO the second is derived from the first. Both share the existing `"theme"` NVS key, so an
  install that stored 0 or 1 still reads back as DARK or LIGHT and only 2 is new.
  Three things are load-bearing:
  - **`tickAutoTheme()` defers while any full-screen surface is up** - the reader, history pager,
    session detail, voice card, crab, or sleep. Switching palettes forces a full repaint, and doing
    that under something the user is reading would wipe it. It re-checks every 30s, so the switch
    simply lands when they return to a tab; a threshold crossing happens twice a day and being 30s
    late costs nothing.
  - **The control is a `uiButton`, not a `uiToggle`** - three states cannot be a boolean. It cycles
    DARK -> LIGHT -> AUTO and shows the mode it is in, keeping its neighbours' convention: filled
    and accented once off the default, outlined and grey while on it.
  - **It needed its own `themeBtnCache`, and that cache MUST be reset in `resetSettingsCaches()`.**
    It used to be drawn inside the flip toggle's cache block, which worked only because the sole
    thing that changed it was a tap that forced a full repaint anyway. AUTO breaks that assumption -
    it changes the palette on a timer with no tap involved - and an unreset cache leaves the button
    BLANK after a page repaint, which is the same trap `drawSettingsStatic()` already documents.

- **DARK and LIGHT themes, switchable on-device and persisted in NVS.** The nine `COLOR_*`
  tokens (`COLOR_BG`/`CARD`/`LABEL`/`VALUE`/`ACCENT`/`GOOD`/`WARN`/`BAD`/`UNKNOWN`) are no longer
  `const` — they're plain globals rewritten from a `THEMES[]` table by `applyTheme(uint8_t)`. They
  kept their original names and stayed globals deliberately: those nine names are referenced 385
  times across this sketch, so a whole theme system costs zero changes at those call sites.
  **A theme switch MUST call `forceFullRepaint()`** — every change-only cache in this sketch keys
  on CONTENT (`drawIfChanged` on the text it's given, `drawPaceBar` on `(pct, tick)`), so a
  colour-only change is otherwise skipped entirely and the screen keeps the old palette.
  `firmware/deckhand_display/palette-check.mjs` is the authority on both palettes: it checks text
  contrast AND that the status trio (`good`/`warn`/`bad`) stays separable both for a deuteranope
  approximation and in flat greyscale, and its `--selftest` flag proves the checker has teeth by
  feeding it a deliberately broken palette it must reject. This caught a real near-miss: the first
  LIGHT candidate passed every contrast check but failed separability, with luminance gaps of only
  4%, 1%, and 5% between its three status colours — indistinguishable in greyscale despite looking
  fine in colour. DARK deliberately keeps its own sub-AA `good`-on-`card` contrast (3.38, below the
  usual 4.5 body-text threshold) because that pair is a pill fill and bar segment, not body text,
  and the palette was chosen with that trade-off in mind rather than by accident.
  `drawCrosshair()` draws in `COLOR_VALUE` rather than literal `TFT_WHITE`, because under LIGHT
  (near-white background, near-black value) a literal white crosshair would be invisible and
  touch calibration would become impossible to complete. The crab easter egg deliberately does
  NOT theme its art: `ClawdCrab.h`'s alpha is composited against black **at build time**, so its
  anti-aliased fringe can't follow a theme. Its background isn't hard-coded to DARK, though —
  `startOctopus()`/`renderOctoFrame()` clear with the **live** `COLOR_BG`, and `drawCrab()` skips
  palette index 0 (the build-time black) rather than substituting the live background — so under
  LIGHT the crab appears on the light-grey background with a dark anti-aliased fringe around it,
  not on a dark background.
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
