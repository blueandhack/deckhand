# The two boards, the panel shim, and board-2 bring-up

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

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
