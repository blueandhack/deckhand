# Commands, instruments and checkers

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

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
| size today | flash 1404382, RAM 71972 | flash 1042674, RAM 71524 |

**Those two figures are `arduino-cli`'s own `Sketch uses` / `Global variables` lines, NOT the
`.bin` file's size, and the distinction has to be stated or the two records read as
contradicting each other.** The `.bin` is larger by fixed image structure - a 24-byte image
header, 8 bytes per segment header, the trailing 33-byte SHA-256 plus checksum, and 16-byte
segment padding. **Measured on four builds today: +266, +266, +266 and +270** - so it is
*nearly* constant but not exactly, because the alignment padding rounds. Consequence worth
knowing: a delta taken from `.bin` sizes can differ from the same delta taken from
`Sketch uses` by a few bytes (it did here, +2352 against +2356 on board 2), and
`board-baseline.mjs` reports the `.bin` number. Board 1's `.bin` today is **1404656** and
board 2's is **1042944**, which are the baseline figures below.

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
echo "PAIRVECTOR" > ~/.claude/deckhand-device-command # BOARD 2 ONLY: the pairing crypto against a pinned RFC 7748 vector
```

**The three audio commands are a LADDER OF CLAIMS, and running them out of order debugs two
questions at once.** `AUDIOPROBE` answers "is the ES8311 on the bus?" and configures nothing, so it
can never be blamed for silence. `TONETEST` configures the whole chain and plays, so silence after
it IS a fault — it dumps all 74 registers first, which is what makes "the codec is fine, look
downstream" a statement rather than a hope. `TONELADDER` exists because the volume scale is linear
in dB and therefore hopeless to guess at: volume 15 is about -77dB and volume 90 about +20dB, so it
plays five rising steps and the listener names the first one they hear. Prefer it to re-running
`TONETEST` at a guessed volume — that costs one run per guess and this costs one run total.

## A verb this board does not have is REFUSED BY NAME, from one table

**Board 1 used to answer roughly twenty of the commands above with SILENCE, and nothing noticed
for the whole board-2 port.** Measured on the live hardware with both boards attached, one
`TEMP` produced four lines from board 2 (USB and BLE both deliver it, and most handlers have no
duplicate guard) and *nothing at all* from board 1 - because those handlers sit inside
`#if !BOARD_USES_TFT_ESPI`, so the line fell through the entire `if/else if` chain into the
JSON-payload branch, which discards what it cannot parse. From the Mac that is indistinguishable
from a wedged board, which is exactly what CLAUDE.md's "every refusal must name its cause" rule
exists to prevent.

`UNAVAILABLE_COMMANDS[]` in `deckhand_display.ino` is one `{verb, cause}` table, walked once at
the END of the dispatch chain (so it can never shadow a real handler), with **each entry's `#if`
the exact NEGATION of its handler's** - `#if BOARD_USES_TFT_ESPI` against the handler's
`#if !BOARD_USES_TFT_ESPI`, `#if BOARD_USES_TFT_ESPI || !BOARD_HISTORY_SCROLL` against
`#if !BOARD_USES_TFT_ESPI && BOARD_HISTORY_SCROLL`, and so on. Where the handler's guard names a
CAPABILITY rather than a board, so does the entry, because a future board could turn that flag on
and would then gain the handler and lose the refusal in one edit. Today board 1 refuses **24**
verbs and board 2 refuses none.

Three details that are load-bearing rather than stylistic:

- **The array is terminated by a `{ nullptr, nullptr }` entry and walked to it**, not counted with
  `sizeof`. Every block in it is `#if`'d, so on board 2 all of them vanish - and `X arr[] = {}` is
  not legal C++. The terminator is what makes an all-guarded table compile, and walking to it is
  what stops a count and an array disagreeing.
- **A verb is matched WHOLE** (end of line, or a space), because the chain itself uses all three of
  `buf == "X"`, `buf.startsWith("X")` and `buf.startsWith("X ")` and one table has to cover them.
- **The refusal arm does not `return`.** `buf` is `processCompletedLine`'s own accumulator, passed
  by reference, and a refusal that returns before the tail's `buf = ""` leaves the refused text in
  the buffer for the next line to be APPENDED to - which still matches the same verb and refuses
  again for ever. One `DETAIL 9` produced 63 refusal lines that way and ~100 seconds in which the
  device parsed no payloads at all (fixed in `924cecc`).

Refusals go out through `sendLineToHost`, not `Serial.println`, because a refusal is most wanted
when someone is driving over BLE with the cable out - and they are deduped on a 2s window per verb,
the way `KBTEST`'s already is, because the host delivers every trigger-file line to every live
transport.

**`node firmware/deckhand_display/commands-check.mjs`** is what keeps it honest, and it is a new
file rather than an extension of an existing checker because none of them owns the dispatch chain -
a command inventory folded into `usage-geom-check` is a parse nobody would look under. It PARSES
three things and transcribes none: every `buf ==` / `startsWith` / `equalsIgnoreCase` verb in
`processCompletedLine()` with its preprocessor guard stack, every table entry with ITS stack, and
every `#define BOARD_*` out of both headers. Then it EVALUATES those guards per board with a real
boolean evaluator - an identifier no header defines THROWS rather than reading as 0, which is the
`const int` trap - and asserts that a verb reachable on either board is, on the other, either
handled or refused by name. It also refuses a dead entry (a verb the board both handles and
refuses), a cause short enough to be a paraphrase of its own guard, a non-ASCII cause, a prefix
match, a `sizeof` walk, a `return` in the refusal arm and a `Serial.println` refusal.
`--selftest` injects 8 faults and **catches 8/8**; deleting the `TEMP` entry fails by name with
`TEMP: handled on board 2 and NOT on board 1, so board 1 refuses it by name`.

**`SCROLLPERF`'s guard is `BOARD_HISTORY_SCROLL` ALONE where its four neighbours read
`!BOARD_USES_TFT_ESPI && BOARD_HISTORY_SCROLL` - checked, and it is deliberate.** `SCROLLPERF`'s
is the honest one: its body touches only `scrollActive`, `scrollY`, `scrollMaxY()`,
`scrollDrawBody()` and `CODE_LINE_H`, every one declared inside `scrollback.ino`'s single
`#if BOARD_HISTORY_SCROLL`, and nothing in it depends on the board. The neighbours' extra term is
redundant rather than wrong (no board declares `BOARD_HISTORY_SCROLL 1` with
`BOARD_USES_TFT_ESPI 1`) and was left alone, since narrowing four working guards would move a
binary for no behaviour.

## `EMOJITEST off` - the escape a stateful instrument must have

`emojiTestActive` gates **both** `handleLine()`'s payload absorption and `loop()`'s 1s tick, and
`TAB` used to paint over the grid without clearing it. The device then kept drawing, LOOKED ALIVE,
and its footer never moved again while no payload reached it - and the only recovery measured was
a re-flash. An agent hit this by accident while testing an unrelated refusal.

`EMOJITEST off` is now the escape, shaped as an `off` ARGUMENT rather than a separate verb
(`EMOJITEST` already takes an icon name, so a second verb would be a second name for one surface,
and `off` is what `KBTEST`/`KBPROBE`/`KBBUBBLE` already answer to) but taking `SCROLLCLOSE`'s other
half: **both outcomes are named**, so "closed" and "there was nothing open" never look the same
from the Mac. It sits AFTER the `pairPanelActive` guard, so it cannot repaint over the pairing
panel; the two flags can never both be true, because `EMOJITEST` refuses to open while the panel is
up. `switchTab()` now clears the flag as well, ABOVE its same-tab early return - `TAB 0` while the
grid is up over tab 0 is the case an operator reaches for first, and returning early would clear
nothing.

**The same class of trap in the neighbours, all of them checked:**

| flag | absorbs the tick? | remotely reachable? | escape |
|---|---|---|---|
| `emojiTestActive` | yes | yes (`EMOJITEST`) | **fixed** - `EMOJITEST off`, and `TAB` clears it |
| `histActive` / `readerActive` | yes | board 2 only (`READTEST`) | `READTEST off`; on board 1 only a finger can raise it |
| `scrollActive` | yes | yes (`SCROLLOPEN`) | `SCROLLCLOSE` |
| `kbActive` | yes | yes (`KBTEST`) | `KBTEST off` |
| `octoActive` | yes | no (touch only) | self-clears after 30s |
| `voiceCardActive` | no | no (a host payload raises it) | the next voice state |
| `isAsleep` | n/a - `SLEEP` is a power-off | yes (`SLEEP`) | **none, by design**: a held touch wakes it |

Two refusals came out of that sweep, both real and both the same defect one surface along:

- **`TAB` is refused while `kbActive`/`readerActive`/`histActive`/`scrollActive`.** `switchTab()`
  paints the tab and clears nobody's flag, so `TAB` over an open reader or transcript left the flag
  set and the tick absorbed - EMOJITEST's freeze exactly. Those three are refused rather than
  cleared because each has an exit function that repaints the screen `switchTab` is about to
  repaint again, which is an ordering question rather than a one-liner, and each already has a way
  out. `pairPanelActive` is deliberately NOT in the list: `switchTab()` takes the panel down AND
  closes the window, so `TAB` is a correct escape from it.
- **`PAGE` is refused while any full-screen surface is up, the pairing panel included.** `PAGE` was
  the FIFTH refusal list that did not know the panel is a full-screen surface (the four found
  earlier are recorded below): both its callees only act while `currentTab == TAB_SETTINGS`, and
  the pairing panel is reached FROM settings - so `PAGE` could repaint over a code somebody was
  comparing while `pairPanelActive` stayed true and `CONFIRM` stayed tappable underneath.

## `KBPROBE` and `KBBUBBLE` - the keyboard's touch model

A character on the keyboard's three letter rows commits **on the LIFT, not on the press**: a press
arms a candidate and draws a magnified bubble one key row clear of the finger, the held path
re-targets as the finger slides, and the release commits. Row 3, the action row, the card, the
strip, the peek and `DEL` all keep press-commit, because every one of those targets already clears
the ~7.1mm fingertip floor - and `DEL` specifically must delete immediately on a tap and repeat on
a hold.

**`KBPROBE` ships with that change because "release-commit cuts mis-hits" is a CLAIM, not a fact.**
It prints one line per keystroke:

```
KBPROBE #7 armed=r1c3 "e" lift=r1c4 "r" at=(120,180)->(127,177) d=(7,-3) dist=8 retarget=1
```

and `KBPROBE off` prints the totals, `N keystrokes, M re-targeted between press and lift (X%)`.
Closing the keyboard stops it and reports the same totals rather than throwing them away.

**What it measures and what it does not.** It measures where fingers LAND versus where they LIFT.
It says nothing about whether the resulting text was CORRECT: a re-target only means the finger
moved onto a different key, not that the second key was the intended one. A correction rate near
zero would mean release-commit is buying nothing measurable, and the spec's fallback (six columns,
two taps per character) is what should come next. **The "release point" is the LAST SAMPLED point,
not the release proper** - `getTouchPoint()` returns false on the lift, so at a 15ms poll the
reported point is the finger's position up to 15ms before it left. That caps the precision of
every number the probe prints.

**`KBBUBBLE` exists because the bubble is drawn only while a finger is down, so no capture can ever
record it** - the same argument `TAB`/`PAGE`/`KBTEST`/`EMOJITEST`/`READTEST` each already won.
`KBBUBBLE [r c]` (default `1 3`, the key the committed mock draws pressed) arms that key through
the SAME `kbSetArm()` a real press uses, so a screenshot records the shipping code path rather than
a mock of it. It **never commits** - only `handleTouch`'s release path calls `kbRelease()` - and
`KBBUBBLE off`, or the next real press anywhere, clears it. It **declines `DEL` by name**, because
`DEL` commits on press and is never armed: a bubble over it would be a capture of a state this
keyboard cannot reach.

Both refuse with a NAMED cause off the keyboard (`kbActive=0`, or the peek covering the keys), and
both are idempotent against the host delivering every trigger-file command over **both** transports:
a second copy within 2s changes nothing and prints nothing, while a genuine repeat later says
`already running` / `already drawn`. Getting that wrong is what made one `POWERPROBE` print four
refusal lines - and `KBBUBBLE off` reproduced it exactly once during this work (the first copy
cleared and said `cleared`, the second found nothing armed and refused), which is why the dedupe
window covers every line these two print rather than only their refusals.

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
$B --pair-check                # the wireless-pairing menu and its dialog; prints its own count
$B --pair-shot out.png [code] [device] [light|dark]   # THE REAL compare dialog, off the glass
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
node host/wire-bytes-check.mjs               # 305 assertions: every device-bound cap is exact in BYTES,
                                             #   the hook's inline toAscii matches host/to-ascii.mjs over
                                             #   71,738 strings, and the saturated tick line is measured
                                             #   against feedChar's guard (incl. the still-over tripwire)
node host/wire-bytes-check.mjs --selftest    # 36/36 injected faults, each printing WHICH assertion caught it
node host/ask-optdescs-check.mjs             # 40 assertions: optDescs is capped in bytes on a codepoint
                                             #   boundary, parallel to options, absent when nothing
                                             #   is described
node host/ask-optdescs-check.mjs --selftest  # 5/5 injected faults
node host/session-inbox-check.mjs             # 94 assertions: the messaging-socket frame, the bytes that
                                              #   actually reach the socket, the confirm-don't-trust rule,
                                              #   the host's fallback wiring, and the hook publishing the
                                              #   socket + token (driven as a real child process)
node host/session-inbox-check.mjs --selftest  # 32/32 injected faults, each naming the assertion that caught it
```

`session-inbox-check.mjs` is worth a paragraph, because the channel it guards **cannot report its own
failure**. A message posted to a session's messaging socket in the wrong frame shape is accepted, the
write returns success, and the message is discarded — measured twice. So the checker has to do two
things a normal one does not. It **parses the frame out of `inboxFrames`' body** (each
`JSON.stringify(...)` argument evaluated in an isolated scope with sentinel `token`/`text`), keeping
no literal copy of the shape, so the revert to the discarded `{"type":"message","text":...}` fails by
name rather than passing. And it **catches the bytes on a real Unix domain socket** and compares them
against the module's own `inboxWireBytes` — the frame half proves only the *declaration*, and a
review found that `writeFrames` could send anything at all with every assertion still green. The
stand-in server also plays the app's part, appending an enqueue only when the bytes match, so a
wrong writer fails twice. Its `--selftest`'s first two faults are exactly those two mistakes.

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

**Check the MULTI-DEVICE path — two boards on two cables at once.** `findUsbPort()` used `.find()`
and returned the first matching port for a year; nothing noticed, because there was only ever one
board on the desk. With two plugged in the host drove whichever the OS enumerated first and left the
other announcing HELLO to nobody, **and the log said `via=usb,ble` either way** — which reads
identically whether that is one board on two transports or two boards on one each. Every assertion
in this checker is aimed at a failure of that shape: silent, and invisible in the one line a human
reads.

```
node host/multi-device-check.mjs             # 42 behaviour + 14 structural assertions
node host/multi-device-check.mjs --selftest  # 32/32 injected faults, each naming the assertion that caught it
```

It **slices the real functions out of `host/index.mjs` and executes them** — `listUsbCandidates`,
the whole link registry (`sendToLink`/`liveLinks`/`broadcastToDevices`/`replyLinkFor`/`linkLabel`),
`deviceNameFor`/`senderKey`, the answer and prompt dedupe, the battery store and `handleDeviceLine`'s
own `BATT` arm — with two fake boards and a fake BLE peer around them. There is no re-implementation
to keep passing after the real code is deleted. Three of its assertions are worth knowing:

- **The port scan is run in BOTH enumeration orders.** A `.find()` regression still returns board 1
  when board 1 happens to be listed first, so a single-order test would pass on a lucky machine.
- **The fan-out is counted per link AND per device.** Three links must mean three writes, never four
  — and no *device* may receive more than the two copies a cabled BLE device has always had (which
  is what `KBTEST`, `KBPROBE`, `KBBUBBLE` and `POWERPROBE` dedupe against on the device).
- **The dedupe is proved on the reachable defect, not just the mechanism.** Two boards cannot in
  fact emit the same `ANSWER` line — each signs with its own key — so "a different board sending the
  same line is not a duplicate" is the mechanism test. The INCIDENT is interleaving: with one
  last-writer-wins slot, board 1 answering between board 2's two transport copies moves the slot off
  board 2's line, and board 2's own second copy is then no longer seen as a duplicate. It is
  rejected downstream (the nonce is single-use) and reads in the log as an authentication failure on
  a perfectly good answer — the exact noise the guard exists to stop. Both are asserted. The
  prompt-map assertion establishes its own precondition rather than clearing the map first:
  clearing made it pass with the two maps SHARED, and the selftest caught exactly that vacuity.

Its **structural half is reported separately** and reads the BODY of the function it names, because
running the code cannot see a module-level capture buffer creeping back in: nothing in the behaviour
half takes a screenshot, so `let shotCapture` at file scope would pass all 38 and then interleave two
boards' rows into one PNG whose row count still adds up.

**Check the WIRELESS-PAIRING CRYPTO, and know which half a checker can prove.** Board 2 can pair a
Mac without the cable (`BOARD_HAS_WIRELESS_PAIR`, 1 there and **0 on board 1**, where `PROVISION`
over USB stays the only path): an ephemeral X25519 exchange plus a 6-digit code derived from the
shared secret, so the 128-bit pairing key is **never transmitted** - both ends derive it. See
`docs/superpowers/specs/2026-08-30-wireless-pairing.md`.

```
node host/pair-crypto-check.mjs              # the Mac's module, then pairing.ino read as TEXT
node host/pair-crypto-check.mjs --selftest   # module + SOURCE fault injections, each naming its assertion
node host/pair-exchange-check.mjs            # the HOST's state machine, sliced out of index.mjs and driven
node host/pair-exchange-check.mjs --selftest # the two faults a whole-branch review injected, each named
echo "PAIRVECTOR" > ~/.claude/deckhand-device-command   # the DEVICE's half, on hardware
```

**THE STATE MACHINE HAD ZERO COVERAGE AND A REVIEW PROVED IT BY INJECTION, WHICH IS THE ONLY WAY
THAT GAP WAS EVER GOING TO BE VISIBLE.** `pair-crypto-check.mjs` reads only the FIRMWARE sources and
`--pair-check` drives Swift against synthetic JSON, so nothing exercised the Mac's exchange at all —
and two deletions in `host/index.mjs` left **all 18 checkers and every selftest green**:
`pairReplyIsOurs -> return true` (the per-exchange stamping that stops a late reply from an
abandoned exchange poisoning the next one) and `pairEnd`'s `b.fill(0)` loop (priv/shared/key left
live). Those are precisely the two defects the fix rounds of this branch were written to close, so
they are the two `--selftest` re-injects.
`pair-exchange-check.mjs` **SLICES the pairing region out of `index.mjs` by source text** and drives
the real functions with noble-shaped stubs; a JS mirror would keep passing with the state machine
deleted, which is the weakness this file already records in `sessions-rank-check.mjs`'s mirror half.
The simulated device runs the SAME pinned derivations, so "the two codes agree" is an agreement
rather than an echo. It prints its own assertion count — do not transcribe it here.
**THE VACUITY TRAP IS WHAT ITS FIRST NINE ASSERTIONS ARE FOR.** The throwaway harness this grew from
reported a clean pass while starting no exchange at all: its prelude was missing the BLE UUID
constants, so discovery quietly found no characteristics. They are PARSED out of `index.mjs` now,
every slice asserts it still contains a token only the real code has, and the suite proves an
exchange opened, sent a real `PAIRREQ` and derived a code the device independently agrees with
before anything downstream is worth reading. Timers are owned by the test — `pairArm`'s shortest
fuse is 15s against a 120s window, so a real clock makes the timeout and scan-finish paths
untestable.
**`deviceNameFor(via)` HAD NO `"pair"` CASE**, so an `ANSWER`/`PROMPT` arriving on the
unauthenticated pairing link was attributed to `usbDeviceName || selectedDevice`. It fails CLOSED
either way — the HMAC is checked against that other Mac's key, which the peer does not have — but
the refusal named the wrong subject, and a log line that misnames its subject is the class this repo
keeps paying for. It returns `""` now (no paired device, which is exactly true until `PAIRDONE`) and
`senderDescription()` gives the four refusal sites a clause that tells the two facts apart: a device
we could not identify, against a link that cannot have an identity yet.

**A MISMATCH BETWEEN THE TWO SIDES ERRORS NOWHERE, which is the entire reason `PAIRVECTOR`
exists.** The device derives with mbedtls and the Mac with node's `crypto`; if they disagree about a
byte order, a salt order or an HKDF info string, both ends stay perfectly self-consistent - the six
digits on the glass are simply not the six the Mac computed, and it presents as a UI bug several
screens from the cause. So the device runs a FIXED private key against a FIXED peer public key and
prints every derived value, which makes the comparison a **diff** rather than a judgement. Same
argument `TEXTPROBE`, `AUDIOPROBE` and `COLORTEST` already won.

**The vector is RFC 7748 section 6.1's own Alice and Bob**, so the shared secret it prints is a
value published by the IETF rather than one this repo invented - a match proves the X25519 itself,
not merely that two of our own implementations agree with each other. Both private keys are stored
**clamped**, and that is forced rather than tidy: node's X25519 clamps internally and accepts any 32
bytes, while `mbedtls_ecp_check_privkey` **refuses** an unclamped Montgomery scalar outright. Since
clamping is part of X25519 and is idempotent, pinning the clamped form cannot change the answer -
and the published public keys and shared secret coming back unchanged is the proof that it did not.

**THE mbedtls BYTE-ORDER HAZARD IS SETTLED BY MEASUREMENT, AND THE ANSWER IS "NO REVERSAL".** An
mbedtls EC point is an MPI, whose natural serialisation is BIG-endian, so it was an open question
whether `mbedtls_ecp_point_read_binary`/`_write_binary` hand back the raw little-endian 32 bytes RFC
7748 and node use. Run on a real board 2 at mbedtls 3.6.6, every value matched the host first time -
`shared=4a5d9d5b...161742`, i.e. the RFC's own - so that library **special-cases Montgomery curves
and does the little-endian conversion itself**, at all three boundaries (peer public in, own public
out, shared secret out). Nothing in `pairing.ino` reverses anything. If a future mbedtls changes
that, `PAIRVECTOR`'s shared secret stops matching the RFC's published value and the fix is one
reversal - which is what the command is for.

**A SECOND VECTOR EXISTS ONLY FOR LEADING ZEROS** (`001472`). The code is four HKDF bytes read
big-endian, `% 1000000`, zero-padded to six - and the padding is not cosmetic: an unpadded `1472` in
a six-character box reads as a bug, and a comparison against the unpadded string would reject a code
the user typed correctly. One pinned example that happened to start with a non-zero digit would
never notice, so the checker also sweeps 400 random exchanges for six digits every time.

**Be honest about what each half proves.** The crypto assertions run the Mac's real module (the
checker prints its own split - run it for today's two numbers rather than reading one here). The
SOURCE assertions read `pairing.ino` as **text** (comments stripped, the `panel_shim.cpp`
`invertColor` trap) and check the device still SAYS the same thing - the info strings, the salt
order, the modulus parsed from its own macro, the big-endian read, the constant-time compare. They
cannot execute the sketch, so they catch an EDIT and never a toolchain; only the hardware run
catches the toolchain. **The salt order is the one that fails silently in both directions**:
`salt = pubA || pubB` with A **always** the Mac's key, so the Mac concatenates its own key first and
the device concatenates the PEER's first. Swap it on one side and each end derives a good key - they
just differ.

**Constant-time comparison, not `memcmp`, for the proof and the code.** `memcmp`/`strcmp` return on
the first differing byte, which leaks how many leading bytes were right and turns forging a 128-bit
proof into sixteen one-byte searches. `pairCtEq` accumulates with `|=` and always runs to the end;
the host uses `crypto.timingSafeEqual`. Length is compared in the clear on purpose - both values
have a fixed, public length, so it carries nothing.

**AND THE ASSERTION THAT SAID SO WAS SATISFIED BY A FUNCTION NOTHING CALLED.** The sentence above
was stated here as fact for a whole task while the checker's proof of it was
`/pairCtEq\s*\(/.test(code) && !/memcmp\([^)]*proof/i.test(code)` - and **`pairCtEq` had ZERO call
sites**, so the first half was satisfied by its own DEFINITION and nothing on the device was being
compared in constant time at all. The negative half looked for one literal spelling beside one
literal identifier, so it caught neither `strcmp`, nor `==`, nor any buffer not named `proof`.
**Measured by a reviewer, not argued**: adding `bool pairVerifyProof(const char* got, const char*
want){ return strcmp(got, want) == 0; }`, and separately a `memcmp` twin, both left the checker
reporting a clean pass. This is the one assertion guarding the exact mistake the answering path can
make, so it was the worst place in the repo for a vacuous one.
Three assertions replace it and they need each other: `pairCtEq` must have a **call site** (counted
as total matches minus its one definition); **no byte-compare function may appear anywhere in the
`#if BOARD_HAS_WIRELESS_PAIR` block** - scoped to the block, because `strcmp` is legitimate
elsewhere in `pairing.ino` for public hostIds, and a file-wide ban would have to be weakened until
it caught nothing; and **no `==`/`!=` against a secret-bearing identifier**, matched on the OPERAND
(`/(proof|code|key|secret|shared|sas|hmac|digest|nonce|salt)/i`) rather than a spelling, because a
whole-line match would fire on `mbedtls_md_hmac_starts(&ctx, key, ...) == 0`, which is a return
code. The call site is real rather than manufactured: `pairVectorReport`'s fresh round trip compares
two shared secrets and was itself doing it with `memcmp`, seventy lines under the comment forbidding
exactly that.
**Both of the reviewer's injections are now permanent selftest faults**, along with the call site
being deleted, a dropped zeroize, an `==` on a key, and the two info macros collapsing - because a
source assertion that has never been shown to fail is the thing this whole entry is about.

**EVERY SECRET BUFFER IS ZEROIZED ON EVERY EXIT PATH, AND THAT IS WHY `pairDeriveAll` IS
SINGLE-EXIT.** It was five bare `return false`s leaving the shared secret, the salt and the 128-bit
key live in a stack frame the UI reuses microseconds later. Survivable while the only caller is
`PAIRVECTOR` with a published test vector; **not** survivable once it is called with the real key,
which is the next task. One `goto done:` is what makes the wipe unmissable - an early return added
later has to walk past it - and `mbedtls_platform_zeroize` is used rather than `memset` because a
`memset` whose result is never read again is exactly what a compiler may delete, and a dying stack
frame is that case by definition. `pubB` is deliberately NOT wiped: it is the device's public key.
The checker PARSES the buffer list out of the declaration rather than transcribing it, so anything
added later that is not named `pub*` fails until it is wiped too.

**CARRY-FORWARD, MEASURED HERE AND NOT IMPLEMENTED HERE: node THROWS on all four classic low-order
X25519 points** (all-zero, one, and both order-8 points) with `ERR_OSSL_FAILED_DURING_DERIVATION`,
so the Mac fails closed against a contributory-behaviour attack and never derives an attacker-known
shared secret. **The task that first passes a radio-supplied public key must CATCH that throw**: an
uncaught rejection inside the poll loop is this file's documented "an await that never settles kills
the poll loop forever" class arriving by a different door - the host looks alive, the serial reader
keeps logging, and nothing ticks. The DEVICE side is unverified: whether `mbedtls_ecp_mul` refuses a
low-order Montgomery point or returns the all-zero secret has not been measured. Recorded at
`pairX25519` so it is read by whoever calls it next.

**THE WINDOW IS THE PRESENCE GUARANTEE, NOT THE CRYPTO, WHICH IS WHY IT DIES IN FOUR PLACES.**
The cable's security value was proof that a person was HOLDING the device; here that proof is a tap
that opens a **120s** window (`PAIR_WINDOW_MS` in `board_es3c35p.h`), and every handler refuses with
a **logged, named** reason while it is shut - the rule `POWERPROBE`'s `not on battery` refusal
exists for, since from the Mac "not in pairing mode" and "not there" look identical. So a window
left open by someone who wandered off is the one state that would make this weaker than the cable,
and `pairClose()` is called from a **tab switch**, from the **backlight blank**, from **deep sleep**
and from the **timeout in `loop()`**. It WIPES rather than marking the window shut: the ephemeral
private key, the derived 128-bit key, the proof and the six digits all go through
`mbedtls_platform_zeroize`, and the field list a checker asserts against is PARSED out of the
declarations, so a field added later is covered by default.

**THE LENGTH CHECK HAD TO LAND IN THE HEX PARSER, and that is the finding the task-1 security
review deferred rather than a tidy-up.** `pairX25519`/`pairDeriveAll` take `uint8_t[32]`
parameters, which decay to pointers and can enforce nothing, so a short `pubA` would leave the tail
of the destination holding whatever the stack held before. `pairHexToBytes(s, nBytes, out)` refuses
the whole string unless `strlen(s) == nBytes * 2` and every character is hex - and `PAIRREQ`
validates BOTH the hostId (exactly 8 hex) and the key **before either is used**, which is asserted
as an ORDER (`pairHostIdOk` and `pairHexToBytes` before `pairDeriveAll`) rather than as presence.

**A VALID PROOF ALONE USED TO STORE A KEY, AND THAT WAS THE WHOLE DESIGN BEING BROKEN RATHER THAN A
HARDENING OPPORTUNITY.** `handlePairOk` committed on a verified proof - and the proof is
`HMAC(key, "deckhand-pairok/1")` where the key derives from the **ECDH shared secret and nothing
else**, so ANY peer that completes the exchange computes it **without ever seeing the displayed
code**. A racing attacker answers the window the instant the user taps PAIR NEW MAC, sends a valid
proof, and is stored in milliseconds. The six digits defended the user's *Mac* against a
man-in-the-middle and gave the *device* nothing: it never received evidence that a human had read
anything. "The device is never sent a guess at the code" was true and irrelevant.

**What commits now is Bluetooth's Numeric Comparison: BOTH a valid proof AND a CONFIRM on this
glass, in either order.** `handlePairOk` sets `pairProofOk` and waits - no store, no `PAIRDONE`;
`pairConfirm()` (Task 3's button, deliberately with no call site yet) sets `pairConfirmed`; and
`pairCommitIfReady()` is the **only** thing in the block that reaches `upsertHost`, which the
checker asserts by counting rather than by reading. The proof is kept as defence in depth - it says
the peer that sent it is the peer that did the ECDH, which the human comparison alone cannot
establish - never as sufficient. A bad proof still fails and closes the window, unchanged.
**`pairConfirmable()` is ONE predicate** (`pairWindowOpen() && pairPending`) read by the commit path
and, next task, by the button's draw site AND its hit test: this codebase's classic defect is a
control drawn under one condition and hit-tested under another, so the checker forbids a second
spelling of the condition inside either function rather than merely avoiding one.
**The gate is bound by an assertion that PARSES the guard's operands**, and reverting it to
`if (!pairProofOk) return;` fails by name - which is the point, because the previous round shipped
three assertions that could not fail at all.

**AND THE ASSERTION ON THE WINDOW ITSELF WAS ONE OF THEM.** `pairWindowOpen()`'s BODY is the
presence guarantee, and the signed-difference assertion ran over the whole block - where `pairTick`
carries a copy of the same expression - so **replacing that body with `return true;`, deleting the
guarantee outright, passed all 70 assertions**. It is bound to the function's own body now (the
`fnBody` helper the zeroize assertions already used), with `pairTick`'s copy asserted separately,
and that exact injection is a permanent selftest fault. Same shape as the `pairCtEq`-defined-but-
never-called hole: **a rule that can be satisfied by a neighbouring line is not a rule.**

**THE HEX PARSER'S LENGTH WAS ENFORCED AND ITS CALL SITE WAS NOT.**
`pairHexToBytes(pubHex.c_str(), 31, pubA)` satisfies every assertion about the parser - the string
really is 62 characters and every one of them really is hex - and leaves `pubA[31]` holding stack
garbage that flows into the derivation, which is precisely the "wrong length by one" the parser
exists to prevent. Every call site's requested length is now asserted against the **declared size of
the buffer it writes into**, both RESOLVED (through the sketch's `#define`s and board 2's `const
int`s) rather than transcribed; the same rule pins the proof compare to `pairProofWant`'s size less
its NUL, and pins the length refused before that compare to the same number.

**`PROVISION:` IS THE ONLY MARKER IN THIS REPO THAT A KEY ARRIVED OVER THE CABLE**, i.e. that a
person was holding the device with a lead in it - and `upsertHost()` printed it on the radio path
too, forging the audit trail for the exact property this feature rests on. The wireless commit says
`WIRELESS PAIR:` instead. **The previous round's stated reason for leaving it - that fixing it would
move board 1's binary - was false, and verifying that took one build**: the `#if
BOARD_HAS_WIRELESS_PAIR` arm emits nothing on board 1, so its `PROVISION` line is textually
identical after preprocessing and `--check 1` reports `UNCHANGED`.

**Three smaller rules over attacker-supplied text, all now asserted:** the hostId is **lowercased at
parse** (`pairHostIdOk` accepts `A-F`, `findHost` compares with `strcmp`, so `C532AB01` and
`c532ab01` would take two of the four slots for one Mac and both would answer); the derived key's
`String(pairKeyHex)` **temporary is named and zeroized before it is freed** (`free()` does not
clear, so a 128-bit key sat in reusable heap with nothing left pointing at it); and the label
writer's `w + 1 < outSize` - **correct, and one character from `w < outSize`, which puts the NUL one
past the end** - is now a named `cap = outSize - 1` the checker binds, since correct-but-unasserted
is what this file keeps paying for.

**`MAX_HOSTS` IS 4 AND FULL IS FULL - CHECKED TWICE, AND THE SECOND CHECK IS THE INTERESTING ONE.**
`PAIRREQ` answers `PAIRFAIL full` **before `esp_fill_random` runs**, so no key material exists for a
Mac that cannot be stored. It is re-checked at COMMIT (in `pairCommitIfReady`), because
`upsertHost()`'s own
full-behaviour is to **RECYCLE SLOT 0** - correct for a deliberate USB `PROVISION`, and a silent
destruction of a key the user still wanted if a USB `PROVISION` fills the last slot while a radio
window is open. Task 3 makes the first path unreachable from the UI; never rely on a UI to enforce
a storage limit.

**The derived key is stored as its 32-character lowercase HEX**, which is the form the USB
`PROVISION` path already stores and the form `authHmacFor()` keys the answer HMAC with (it hashes
the ASCII of the secret, not 16 raw bytes) - so a wirelessly paired Mac answers prompts through
exactly the same code path, with no second format anywhere. `upsertHost()` performs `saveHostSlot()`
and `saveHostCount()` itself; calling them again would be a second NVS write of identical bytes.

**`PAIRDONE`/`PAIRFAIL` carry the trailing `to=<hostId>`, built HERE rather than by
`sendLineToHost(line, link)`** - that overload addresses by LINK index, and a Mac that is pairing
has not necessarily sent a tick payload yet, so it may own no `hostLinks` slot and would silently
come out as a broadcast. The hostId is the thing we actually know. `PAIRPUB` is deliberately
unaddressed, per the spec's own wire table.

**A second `PAIRREQ` REPLACES the pending one** (a lost first attempt must be recoverable without
walking back to the device) and **the displayed code changes with it**, which the person standing in
front of the glass sees.

**THE SECRET REACHES NO `Serial.print` AND NO `sendLineToHost`, AND THAT IS A RULE OVER THE SOURCE
RATHER THAN A PROMISE.** `pair-crypto-check.mjs` scans every line of the pairing block and fails if
one naming `pairKeyHex`, `pairProofWant`, `pairPriv` or `pairCodeDigits` also names an outbound
call - one debugging printf would put the 128-bit key on the very link this design exists to keep it
off. The six digits are on the GLASS for the same reason: a copy on the wire is a copy a Mac could
use to skip the human, which is the whole thing that makes this equal to the cable.

**THE PANEL, AND WHY `PAIR NEW MAC` SITS IN THE LIST'S NEXT FREE ROW SLOT.** The obvious placement -
a button above the Macs on SETTINGS > Pairing - does not fit, and the arithmetic said so before
anyone drew it: that group's four rows run 218/278/338/398 and end at 449 against a footer at 460,
i.e. **10px of slack**, where a button above the list needs `H_ROW` + a gap = **58**. So it is drawn
at `p3RowY(hostCount)`, the next free row. It fits for 0..3 Macs, and at `MAX_HOSTS` there is no
room on the screen **and** no free NVS slot - so **its ABSENCE encodes "full" exactly**, with no
second state, no extra string and no refusal path to get wrong. The two limits turn out to be the
same limit, and the checker walks every slot 0..3 clearing the footer and slot 4 not clearing it, so
that argument is pinned to the geometry rather than left in a comment. (`PAIRREQ`'s own
`PAIRFAIL full` is KEPT as defence in depth - a fourth Mac can still arrive over USB while a window
is open - and never relied on: never let a UI enforce a storage limit.)

**The panel owns everything above the footer, the tab bar included** - chrome drawn but dead is the
bug `fabVisible()` is gated in one place to avoid - and leaves the footer LIVE, so the clock, the
battery and the "Xs ago" freshness keep running through a 120s wait: whether the Mac is still
talking is exactly what you want to know while waiting for its request. It reads `PAIR NEW MAC` /
`waiting for a Mac` / `pick this device on your Mac` until a request lands, then
`does your Mac show this?` over the six digits at `T_HERO` with the requesting Mac's label under
them. That label is **attacker-controlled text**: sanitised and capped at parse, and `fitText`'d
again here, because `drawString` paints an opaque box and a name wider than the panel would rub out
its neighbours. The countdown is the one change-only field, ticked by `tickPairPanel()` from
`loop()` at 500ms rather than by `renderSettingsTab()`, which returns early while the panel is up
for the same reason the confirm dialog does.
**CANCEL is the FILLED button and CONFIRM only outlined**, the hierarchy every confirm dialog here
uses: the tap that stores a 128-bit key must not also be the easiest thing to hit. And **CANCEL
keeps a FIXED slot rather than centring itself while it is alone** - a button that moves when a
request arrives is a button you tap by accident at the exact moment the screen changed under your
finger.

**THE TAP WAS BOUND TO THE PREDICATE AND NOT TO THE PAINT, WHICH IS THE TRANSFERABLE FORM OF THIS
BUG.** `pairConfirmVisible()` really was `pairConfirmable()` and nothing else, read by the draw site
AND the hit test, so the structural rule this codebase keeps paying for was met. What lagged was the
REPAINT: `handlePairReq()` set `pairPending` and repainted nothing, and `PAIRREQ` arrives through
`processCompletedLine` rather than `handleLine`, so the panel only caught up on the 500ms tick - and
inside that window a person could tap CONFIRM against a screen not yet showing the code they
compared, which is the whole property. It is reconciled inside `handlePairReq()` in the same
statement now, asserted, and the selftest also catches the **plausible wrong fix** of moving the
reconcile after `PAIRPUB`. Two doors closed with it: `pairPanelActive` joined all five full-screen
refusal lists, so an unauthenticated radio `EMOJITEST`/`READTEST` can no longer paint over an open
pairing window, and `switchTab` clears it.
**The overlap was closed IN SPACE, not in time.** At `hostCount == 3` the PAIR NEW MAC row
(398..443) overlapped CONFIRM's old rect (386..435) at the same x, so the ordinary human
double-tap - the second tap ~200ms after the one that opened the panel - landed exactly on CONFIRM.
`PAIR_BTN_BOTTOM` 24 -> 62 lifts the button row clear, spending 38px the header already declares
surplus. **An arming DELAY was considered and rejected**: it would be a second spelling of "is there
anything to confirm", and `pairConfirmable()` being ONE predicate is itself an asserted rule - the
fix that adds a second source of truth is the one this codebase keeps paying for.

**A CHAIN OF RELATIVE IDENTITIES IS INVISIBLE TO THIS SWEEP, AND THAT IS A FACT ABOUT THE SWEEP
RATHER THAN THE ASSERTIONS.** The panel's six offsets were first written as `y == prev + cell + air`
throughout, which looks exactly like the standard this file sets - and `geom-sweep.mjs` injects at
PARSE time, so perturbing a gap moves every block below it and every identity still holds.
MEASURED, not reasoned: `PAIR_TOP_AIR`, `PAIR_AIR_STATE`, `PAIR_AIR_CODE`, `PAIR_AIR_LABEL` and
`PAIR_BTN_BOTTOM` were ALL unguarded at ±16, the last of them under an assertion written for it, and
`PAIR_TITLE_Y === PAIR_TOP_AIR` was vacuous outright. Closed with a **CLOSING TERM**: `PAIR_AIR_LEFT`
names the surplus and the stack is asserted to land exactly on a button row anchored from the OTHER
end (`BOARD_H - FOOTER_H - PAIR_BTN_BOTTOM - H_BTN`), which is the `HOME_Y0_BOT` shape - non-circular
because `PAIR_BTN_Y` derives from an independent path and `PAIR_AIR_LEFT` is read by no draw site. A
second binding asserts the surplus stays IN `PAIR_AIR_LEFT`, which catches a sum-preserving
redistribution the landing identity provably cannot see. After it, every pairing coordinate is
caught at **±1 in both directions**. `drawPairResult()` also **flushes before it delays**, the
defect the farewell screens already fixed once on this shadow-buffered board.

**BOARD 2'S WHOLE-BRANCH COST: +29,104 bytes of flash and +328 RAM** (993,814 / 65,900 ->
**1,022,918 / 66,228**), of which **+23,380 flash / +112 RAM is mbedtls arriving in the link** and
everything the feature itself adds is the remaining **+5,724 / +216**. Broken out, in the order it
landed: the crypto and the pinned vectors +23,380 / +112; the window and the wire handlers +3,080 /
+144; the commit gate +560 / +8; the panel and the button +2,084 / +64. The Mac's half costs board 2
nothing - it is `host/index.mjs` and `DeckhandMenuBar.swift`. **Board 1 is `UNCHANGED`** at
**1,386,934 / 69,804**, `0cc2e77b66fb6947...`, verified with `board-baseline.mjs --check 1` at every
commit: every line of this sits behind `#if BOARD_HAS_WIRELESS_PAIR`, including the three close
sites in shared code, and board 1's header gains exactly one line that emits no code.
The breakdown was RECONCILED rather than transcribed - two contemporaneous records of the
commit-gate figure disagreed by 270 bytes, so `1d2f170` was rebuilt into a scratch sketch path and
came back **1,020,834 / 66,164**, which settles the panel's share at +2,084 / +64 and makes the four
lines sum exactly to the measured total. Compile an OLD commit somewhere other than
`firmware/deckhand_display`: `arduino-cli` keys its cache on the sketch PATH, so a rebuild in place
would evict the objects the current baseline was just taken from.

**THE CRYPTO COMMIT'S +112 RAM IS NOT THE PINNED VECTORS, WHICH IS WHAT THE FIRST REPORT OF IT
SAID.** Those are
file-scope `const uint8_t[32]` arrays: they land in `.flash.rodata`/DROM, and `.dram0.data` did not
move by a single byte across the change - which is the positive evidence, not an argument. The whole
+112 is `.dram0.bss`, and every byte of it is named, read out of the map file rather than guessed:
**92 + 4** for `op_sem_buf$1` and `op_complete_sem` in `esp_bignum.c.obj` (the static FreeRTOS
semaphore the S3's hardware bignum accelerator completes its operations on), **4** for
`s_crypto_mpi_lock` in `esp_crypto_lock.c.obj` (the mutex serialising that peripheral), and **12**
for `mul_count`/`dbl_count`/`add_count` in `ecp.c.obj` (mbedtls's own ECP operation counters). None
of it is ours; all of it arrives because `ecp.c` links at all. Measured by building the parent commit
into a second output directory and diffing `size -A` and the `.bss` symbols - the two 32-byte vectors
would have been 64 bytes and the number is 112, so the arithmetic never worked either. **Board 1 is
`UNCHANGED`** - its header gains exactly one line, `#define BOARD_HAS_WIRELESS_PAIR 0`, which emits
no code, and everything else sits behind `#if BOARD_HAS_WIRELESS_PAIR`. **The mbedtls includes had
to go at the TOP of `deckhand_display.ino` under that same flag, not beside the code**: the Arduino
build inserts its generated prototypes above the sketch's first function definition, so a signature
naming `mbedtls_ecp_group` is unknown to its own prototype and the build fails at the definition
with "does not name a type". Measured - that is the error this first produced - and it is the same
rule the `BleCbParam` typedef already records.

**THE MAC'S HALF OF WIRELESS PAIRING IS A MENU AND A DIALOG, AND NEITHER CAN BE CLICKED FROM A
SCRIPT.** `Settings > Pair new device...` writes `PAIRSCAN`, lists the heartbeat's `pairing.devices`
as rows, and `PAIRSTART <name>` on a pick; when the host publishes a derived code the app raises an
`NSAlert` showing **this Mac's own six digits** and asking whether the device shows the same, with
Match -> `PAIRCONFIRM` and Don't match -> `PAIRCANCEL`. Five things are load-bearing:

- **THERE IS NO TEXT FIELD, AND THERE MUST NEVER BE ONE.** The typed-code design was broken (see the
  spec): the proof derives from the shared secret, so any peer that completes the ECDH computes a
  valid one without ever seeing the code. `--pair-check` asserts the accessory view is
  **not editable**, and putting an editable field back fails by name.
- **THE COMPARISON IS THE SECURITY PROPERTY, so legibility is a security cost.** The digits are
  drawn at `PAIR_CODE_FONT_PT` (44) in SF Mono, and **ungrouped** - exactly as `settings.ino` draws
  `pairCodeDigits` in one `T_HERO` `drawString`. Rendering `482 913` against a device showing
  `482913` is two shapes for one number, i.e. two things to compare wrongly; the checker asserts the
  field's string IS the code. `--pair-shot` captures the real dialog (by window id, and it can
  FORCE an appearance, since a capture otherwise shows only the one the Mac is set to).
- **`awaiting-code` IS NOT ENOUGH TO SHOW A CODE.** `pairStart()` sets that state the moment it
  begins connecting - `code` stays `""` until the device answers - so the dialog waits for six
  actual digits. Asserted with a SEEDED prior code, because from an empty `seen` the guard is masked
  by the empty code equalling the empty token it is compared against: the assertion passed under the
  fault until it was seeded, which is the vacuous-assertion trap this file keeps paying for.
- **The code token is spent when the state leaves `awaiting-code`, and the outcome token when it
  passes through `awaiting-code`.** Six digits collide once in a million, so a second exchange
  deriving the last one's code would otherwise raise nothing at all; and `PAIRSTART` is accepted
  straight out of `failed`, so retrying a device whose window is shut fails twice with a
  byte-identical cause and the second report is the one that would go missing.
- **A host predating this feature publishes no `pairing` block, and the row DIMS rather than
  writing a `PAIRSCAN` that host forwards to the device as an unknown line.** Same rule as the
  device's read-only ask path: never offer a control that cannot work.

**And `--legibility-check` had to learn what "reachable" means.** MEASURED: `NSMenuItem.isEnabled`'s
GETTER reflects the parent chain, so every row inside a submenu whose parent is disabled reports
`false` whatever was set on it - which made the check FAIL, with the host down, for a row nobody can
open. An instrument that fails for the wrong reason is worse than none, so that row is skipped when
its parent is dimmed and checked whenever it is not (proven both ways: disabling it with the host up
fails by name).

**What is NOT verified: no real exchange has run through this menu.** The supervised host is the
main checkout's, where pairing does not exist (`grep -c PAIRSCAN` is 0), so every state was driven
through `DECKHAND_TMP` with a synthetic `host-alive` - the documented seam - and the dialog was
captured but never answered against a device. The click paths (`PAIRSCAN`/`PAIRSTART`/`PAIRCONFIRM`/
`PAIRCANCEL` reaching the host) are structural, not executed.

**THE HOST'S SCAN HOLDS NOBLE'S OWN PERIPHERAL HANDLE, WHICH IS ONLY AS GOOD AS THE ADVERTISEMENT IT
CAME FROM.** `PAIRSCAN` runs a 5s scan into a `name -> {rssi, peripheral, at}` map; `PAIRSTART`
takes the handle straight to `connectAsync`, so a **stale sighting is REFUSED BY NAME** past
`PAIR_SCAN_FRESH_MS` rather than connected to, and the reason names the age. The device already on
the live link is exempt, because that is not a remembered handle at all - it is the connection in
use. **Scanning must not disturb the live link**, and that was tested rather than asserted: against
both real boards, `PAIRSCAN` listed `Deckhand-0528` at -44 dBm and `Deckhand-C114` at -63 with the
live link surviving, and a `PAIRSTART` aimed at board 1 - a second peripheral that cannot answer -
opened its own link, timed out at 15s naming the cause, disconnected itself, and left C114 at
`via=usb,ble`.

**A LATE REPLY FROM AN ABANDONED EXCHANGE POISONED THE NEXT ONE, WITH NO ATTACKER INVOLVED, AND IT
WAS REACHABLE FROM THIS FEATURE'S OWN HARDWARE TEST.** `handlePairPub` bound to whatever
`pairExchange` happened to be current - no peripheral id, no generation token, and `via` dropped at
the call site. So: exchange 1 times out at 15s, the user retries, and the first device's slow reply
lands in exchange 2, sets `ex.code` from the WRONG peer, after which `if (ex.code) return;` swallows
the real reply. A dead exchange while the log says "answered - compare the six digits", failing safe
and giving the user no hint which is which. Every reply is stamped with the exchange's generation
and peripheral id now and dropped by name.
**And the PAIRING link had no `disconnect` listener** where the main BLE path has had one since the
start: a peripheral that went away after `PAIRPUB` left `pairExchange` non-null with `priv`/`shared`
/`key` **un-zeroed** and the heartbeat publishing `awaiting-code`, the six digits and a counting
`sec` for the rest of the 120s - a dead exchange the menu bar draws as a live pairing. Bounded by
the timer, so not this file's "await that never settles" class, but "every failure closes the
exchange" ought to be satisfied by NOTICING the failure rather than by outliving it.
**Known and watched, not fixed:** `PAIRFAIL` is BROADCAST by the device, so a neighbouring Mac's
refusal could in principle end our exchange. It fails safe - nothing is stored - and is named here
rather than papered over; worth re-checking once two Macs are really paired.

**HOW TO PAIR A SECOND MAC WIRELESSLY - THE TWO TAPS, AND WHAT EACH SCREEN SHOWS.** Board 2 only.
Nothing is stored until step 5, and the device tap there is the whole presence proof.

1. **On the DEVICE, tap `PAIR NEW MAC`** (SETTINGS > Pairing, the row directly under the Macs
   already paired). If it is not there, all four slots are full - forget one first. This is the
   first of the two taps and it opens a **120-second** window; the panel takes the screen and reads
   `waiting for a Mac` / `pick this device on your Mac`, with CANCEL on the right and a countdown.
2. **On the MAC: menu bar > Settings > `Pair new device...`.** It writes `PAIRSCAN`; ~5s later the
   submenu lists what it heard, strongest first, as `Deckhand-XXXX (-44 dBm)`. Pick the one whose
   name matches the device - it is on SETTINGS > Status and on the boot waiting screen.
3. **The exchange runs on its own.** The Mac sends `PAIRREQ`, the device answers `PAIRPUB`, and both
   ends derive the same key and the same six digits. The device's panel changes to
   `does your Mac show this?` with the digits at 32x64 and the requesting Mac's name under them; the
   Mac raises a dialog with ITS own six digits at 44pt SF Mono. Neither code was transmitted.
4. **COMPARE THE TWO SIX-DIGIT CODES.** This is the security property, not a formality. They are
   drawn UNGROUPED on both sides on purpose, so `482913` is one shape in both places.
5. **If they match: click `They match` on the Mac, then tap `CONFIRM` on the device.** Either order
   works and BOTH are required - the Mac's click only sends the proof, and the device stores nothing
   until a finger on its glass says so. The Mac then tells you so as well
   (`Now tap CONFIRM on ...`). The device shows `PAIRED WITH <name>` and drops back to the Pairing
   list with the new Mac in it; the key is in NVS in the same 32-hex form `PROVISION` writes, so
   that Mac answers prompts through the identical path with no second format anywhere.
6. **If they DIFFER, tap `CANCEL` on the device** (or `They don't match` on the Mac) and start
   again. A mismatch is the one signal that something other than your Mac answered the window.

**WHAT IS NOT VERIFIED IN THIS FEATURE, STATED PLAINLY - AND IT INCLUDES THE MAIN EVENT.**

- **NO COMPLETE END-TO-END PAIRING HAS EVER RUN.** The refusing half is verified on hardware over
  BOTH transports with the cause named (`PAIRFAIL closed` on the wire, `PAIR: -> PAIRFAIL closed` in
  the log), and `PAIRVECTOR` matches RFC 7748 on the shipped firmware. The **accepting** half -
  `PAIRPUB` -> derive -> a code on both screens -> `PAIROK` -> CONFIRM -> `PAIRDONE` -> a key in NVS
  - has not. It needs **two physical taps** (PAIR NEW MAC, then CONFIRM) and **this codebase
  deliberately provides no remote trigger for either**: a `PAIROPEN` command would make the device
  something a Mac can put into pairing mode, which is the exact property the feature exists to
  refuse, and a remote CONFIRM would delete the presence proof outright. That is the right trade and
  its cost is that the accepting paths - including `badproof`, `badhost`, `badkey`, `full` and the
  120s expiry - are covered structurally, not by execution.
- **The supervised host runs the MAIN checkout's `host/index.mjs`, where `PAIRSCAN` does not exist**
  (`grep -c PAIRSCAN` is 0 in the running file). So the menu bar's click paths cannot reach a host
  that knows the verb until this branch merges, and every menu state was driven through
  `DECKHAND_TMP`. Task 4's own hardware results ARE real - that run stopped the supervised host and
  ran the worktree's host through `DeckhandBLE.app` - but nothing since has, and end-to-end testing
  needs either that or a merge.
- **The device's behaviour on a LOW-ORDER X25519 point is unmeasured.** Node THROWS on all four
  classic ones, so the Mac fails closed; whether `mbedtls_ecp_mul` refuses them or hands back the
  all-zero shared secret **has not been checked**. It is recorded at `pairX25519` rather than
  assumed either way.
- **No screenshot here vouches for COLOUR.** Board 2's `SCREENSHOT` reads the shadow framebuffer, so
  the on-glass evidence for the PAIR NEW MAC button (its accent stroke measured off the PNG at rows
  278 and 323 = exactly `p3RowY(1)` and `+H_ROW-1`) is a claim about the geometry the renderer
  composed. **The pairing PANEL itself has never been on the glass at all** - it opens from one
  thing only, and that is the point.

**Check the LAYOUT ARITHMETIC of both boards' screens without a screen.** Three checkers parse the
constants straight out of `board_e32r28t.h` / `board_es3c35p.h` (shared parsing in
`geom-common.mjs`) and assert every derivation the headers claim — so a header that drifts from its
own comment fails loudly instead of passing while the panel is wrong:

```
node firmware/deckhand_display/usage-geom-check.mjs      # USAGE cards, hero/bar/stats/foot clear boxes, footer's three zones, Codex row
node firmware/deckhand_display/sessions-geom-check.mjs   # the row-height ladder, tall/sub/compact gates, detail card, ask option chips
node firmware/deckhand_display/settings-geom-check.mjs   # settings pages, steppers, keyboard, history reader, confirm-screen line cap
node firmware/deckhand_display/geom-sweep.mjs            # fault-injection sweep over all three (~110s, see below)
python3 firmware/deckhand_display/usage-trend-check.py   # the USAGE ring/burn arithmetic these three do NOT bind - see below
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
  **IT TAKES ~110 SECONDS, NOT ~30 — AND A 33-MINUTE RUN WAS REPORTED ONCE AND DOES NOT
  REPRODUCE.** Measured on the wireless-pairing branch with nothing else running: `real 111.84 /
  user 128.44 / sys 13.61`, exit 0, all three checkers, both boards, 582 constant-board pairs. The
  ~30s figure predates the sessions checker reaching 1444 assertions and the settings checker 617,
  so it is stale in the honest direction and is corrected here. It is recorded because a task on
  this same branch **killed the sweep at 33 minutes** on its sessions child and carried that
  forward as a suspected 66x regression in a repo-level instrument. **It is not one**: re-run alone
  it is under two minutes at the same commit range. What that run actually hit was NOT established
  — the run was killed rather than diagnosed, so there is no evidence to point at, and the only
  honest statement is that the sweep is affordable today and the earlier figure is unexplained
  rather than explained away. The plausible candidate, offered as a hypothesis and not a
  measurement, is contention: the sweep is four children per checker-board, so anything else heavy
  on the machine (an `arduino-cli` build takes minutes) multiplies straight through it. **Time it
  when you run it**, and treat a wildly different number as a question about the machine before it
  is a question about the sweep.
  Three things it has actually caught, which is why it is worth the ~110 seconds it takes: the
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
  Where it stands today: **514 of 582 constant-board pairs guarded** (board 1 32/237 unguarded,
  board 2 36/345) — board 2 gained **50 constants** in the settings redesign and its unguarded count
  went DOWN, which is the standard this file sets for constants the repo just added: every one of
  them is caught at **±1 in both directions**. (`ASK_OPT_DESC_BYTES` from the option-descriptions
  work, and `READER_CODE_LINE_H` from the reader line-step fix, likewise.) Board 1's numbers are
  unchanged, which is the sweep agreeing with `board-baseline.mjs` that nothing there moved.
  **Wireless pairing then added 25 more to board 2 and only THREE of them are unguarded, all
  three because they measure TIME or FORMAT rather than pixels**: `PAIR_WINDOW_MS` (120000) and
  `PAIR_RESULT_MS` are durations, where ±16 milliseconds has no geometric consequence a checker
  could notice, and `PAIR_HOSTID_CHARS` (8) is a wire format read by no geometry assertion. Every
  PAIR_* constant that IS a coordinate or a gap is caught at **±1 in both directions** — which it
  was not when the panel first landed, and the story of how it got there is under **the pairing
  panel** below: a chain of relative identities is invisible to an injector that perturbs one term
  and lets the rest follow.
  Of the unguarded ones only **8 on board 1 and 12 on board 2 are read by any
  checker at all** — the other 24 and 24 are mic, beeper, crab, pairing-duration and
  preset-count constants with no geometry to violate. **Four of board 2's entries in THAT list are unguarded BY CONSTRUCTION
  and are not a gap** (as are the two `PAIR_*_MS` durations above): `DETAIL_PAD_Y`, `DETAIL_PILL_STEP`,
  `DETAIL_COL_LBL_STEP` and `DETAIL_COL_VAL_STEP` are
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
  `HIST_CHIP_X`/`HIST_CHIP_TAP_W`/`HIST_JUMP_H`, `P1_TOP`/`P2_TOP`/`P2_GAP` and
  `WAIT_CMD_H` all sit inside documented slack (board 2's page 2 has 149px of it - the checker
  reports its hint ending at 311 against a footer at 460) — each IS asserted, just not tightly
  enough for ±16 to trip it. **`KB_TEXT_Y` was on that list and is not exempt any more**, and
  the number quoted beside it went stale too: the "keyboard break" was 38px before the prompt
  strip took 22 of them, and is 16 today (`KB_ROWS_Y` 170 less `KB_TEXT_Y` 34 + `KB_TEXT_H`
  120). Measured 2026-09-05 by perturbing the constant by ±16 in both headers:
  `settings-geom-check.mjs` fails on all four, so the entry is corrected in place rather than
  quietly deleted.
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
node firmware/deckhand_display/scrollback-check.mjs                # BOARD 2's transcript: the line-index MIRROR plus structural assertions over the firmware
node firmware/deckhand_display/scrollback-check.mjs --selftest     # SB_FAULT=wrap-cap|wide-marker|seq-append|no-reap|no-activity, one per claim
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
