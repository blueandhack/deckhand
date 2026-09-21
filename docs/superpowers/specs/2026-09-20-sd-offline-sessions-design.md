# The SD card makes the device readable without the Mac

Design, 2026-09-20. Board 2 only (`BOARD_HAS_SD 1`).

## What this is

Two stores on the microSD card, so that a Deckhand with its Mac asleep, out of range or
simply not there shows **your sessions and their transcripts** instead of the waiting crab.

1. **The session list**, snapshotted when it changes.
2. **The transcripts**, appended as they arrive.

That split is the whole design decision and it is argued below under *Why hybrid*.

## What this is NOT, and why the obvious framings are wrong

**It is not a speed feature.** This was measured on 2026-09-20 rather than assumed, and the
measurement killed the original motivation:

- The host **already** delta-syncs a held transcript - `Scrollback: tail +5 of 5 new` sent five
  entries, not the 40KB it already had. Re-opening a session you are watching is already cheap.
- The bottleneck is not the radio. Fetch time is `~150ms + (N-1) x ~130ms ACK + bytes x 0.022ms`,
  so it is dominated by the number of CHUNKS, not bytes. Raising
  `SCROLL_WIRE_CHUNK_BLE_BYTES` from 1500 to 8000 takes a 138KB transcript from ~15s to ~5.4s.
  **That change is not part of this spec** and should land first, because it changes the numbers
  any SD argument is measured against.
- SD cannot make a COLD load fast. The bytes cross BLE once regardless.

**It is not a memory feature.** Board 2 has 8,388,608 bytes of PSRAM and the scrollback uses
304KB of it - 3.6%. Anything of the form "hold more history" is available 27x over, in memory,
today, by raising `SCROLL_TEXT_BYTES`. It does not need a card.

**What the card uniquely provides is survival across power loss.** That is the entire case, and
everything below follows from it. The remaining speed benefit is real but small: the per-BOOT
re-fetch, ~5.4s once the chunk fix lands.

## The state this replaces

`deckhand_display.ino`'s `if (!everReceived) { drawWaitingScreen(); return; }` is what a cold
boot with no Mac shows today: the waiting screen, and nothing else. There is no third state for
"never received this boot, but I have stored data", and that is the state this spec adds.

## Why hybrid, and not the two simpler options

- **Snapshot everything on change** is the simplest correct thing - a file is always whole or
  absent, no compaction, no replay. It is rejected because a 200-byte delta would rewrite up to
  300KB, which is both card churn and a stall in a single-threaded render loop.
- **Append-only for everything** is the cheapest to write and the most expensive to be right
  about: compaction, torn-write recovery and a boot replay path, for a session list that is only
  ~48KB and reorders wholesale every tick anyway.
- **Hybrid** puts each store on the policy that fits its shape. The list is small and changes
  wholesale, so it is snapshotted. Transcripts are large and genuinely append-only, and the host
  ALREADY sends them that way: `{"hist": {"id": ..., "app": 1, "items": [...]}}`. The `app: 1`
  flag is an append instruction the device already honours, so **the existing delta path IS the
  write path**, 1:1, with no new sync mechanism invented.

## The two stores

### `/dh/sessions.bin` - the list snapshot

Header, then `count` x `SessionInfo` written raw. `SessionInfo` is POD (fixed-width `char`
arrays and integers), so no serialiser exists and none is needed.

```
magic    "DHS1"          4
version  uint16          2
count    uint16          2      <= SESSION_SLOTS (20 on board 2)
entSize  uint32          4      sizeof(SessionInfo) AT WRITE TIME
syncTod  int32           4      hostSecondsSinceMidnight at the sync
syncDate char[12]                the new wire field, ASCII, NUL-padded
crc32    uint32          4      over the payload only
payload  count x entSize
```

**`entSize` is the compatibility gate and it is not optional.** `SessionInfo` has changed shape
repeatedly on this branch (`askOptDescs` is the most recent), and a struct that gained a field
would make every stored entry read misaligned - names sliced mid-string, `status` reading as
whatever `path` used to hold, and nothing at all reporting an error. A snapshot whose `entSize`
does not equal the running `sizeof(SessionInfo)` is **discarded by name**, not migrated. Firmware
changes; the card is a cache; a cache that cannot prove its shape is not a cache.

Hand-derived estimate: `sizeof(SessionInfo)` is **~2,386 bytes** - dominated by `askDetail[1424]`,
`askOpts[4][34]` and board 2's `askOptDescs` at 4 x 97. That is ~48KB for 20 slots. **This figure
is derived by hand from the struct and has NOT been confirmed with a `sizeof()` on the device**;
the implementation must print it once and this line must be corrected to what it prints.

### CREDENTIALS ARE NOT PERSISTED

`SessionInfo` carries `askNonce[20]` and `promptNonce[20]`. Both are host-issued, single-use, and
HMAC'd into the answer that a tap on the detail screen sends. **Both are zeroed on write.**

This is a rule, not a precaution. The card is REMOVABLE and survives power-off, so anything
written to it leaves the device's trust boundary. The host already reasons this way about the
same values - a lean session row omits `pnonce` deliberately, "a credential rather than an
oversight: the device must never hold one for a session it cannot correctly offer the control
for." A restored row is exactly that: it cannot answer anything, because there is no host to
answer to. When the Mac returns it issues fresh nonces in the ordinary payload.

`askDetail[1424]` is NOT a credential and IS persisted - it is the question text, and it is the
most useful thing on a restored detail card.

### `/dh/tx/<id12>.txt` and `.idx` - one transcript per session, in TWO files

Keyed by the same 12-character session id the device already uses as its cross-poll match key.

**Two files, not one, and the reason is the append.** The store is a text blob plus an index
over it. In a single file those regions are contiguous, so appending to the text would move the
index and force a rewrite of the whole thing - which is the snapshot policy this store exists to
avoid. Split, each file is pure-append:

- `<id12>.txt` - the `scrollText` blob verbatim, appended to, nothing else in it.
- `<id12>.idx` - a fixed header, then `ScrollEntry[]` verbatim, appended to.

```
.idx header
magic    "DHT1"          4
version  uint16          2
entries  uint16          2      <= SCROLL_MAX_ENTRIES (4096)
textLen  uint32          4      <= SCROLL_TEXT_BYTES (262144), the .txt length
total    uint32          4      the host's entry total, for "N older not kept"
dropped  uint32          4
syncDate char[12]
crcText  uint32          4      over the .txt bytes
crcIdx   uint32          4      over the entries that follow
entries x 12 bytes             ScrollEntry[] verbatim
```

`ScrollEntry.off` is a byte offset **relative to the buffer base**, so the blob and the index
reload into a fresh `scrollText` allocation unchanged. No pointer fixups, no re-wrapping.

An append writes the `.txt` tail, then the new `ScrollEntry` records, then rewrites the header
last - which is 32 bytes at a known offset. **Header last is the ordering that makes a torn
write safe:** a crash before it leaves a header whose `entries`/`textLen` describe the PREVIOUS
good state, and the extra bytes past those lengths are ignored on load. A crash after it is a
complete write. There is no window in which the header promises data that is not there.

**Compaction** happens only when a transcript exceeds `SCROLL_TEXT_BYTES`, and reuses the policy
the PSRAM store already has: drop the oldest entries, keep the newest tail, and state the dropped
count on the glass. No new user-visible behaviour.

## EVERY FILE CARRIES LENGTH AND CRC, BECAUSE A TORN WRITE IS THE NORMAL CASE

This device has no true power-off (see `docs/reference/power-and-battery.md`) and is routinely
reset by `flash.sh` mid-run. A write interrupted by a reset is not an edge case here, it is
Tuesday. A partial file must be **detected and discarded**, never rendered: a truncated
`scrollText` with an intact index produces entries pointing past the end of the blob, which is a
read off the end of a PSRAM allocation - and the failure would present as corrupted text or a
crash, not as a named error.

## The wire: one new field

`hostSecondsSinceMidnight` is seconds since LOCAL midnight and carries no date. It is
deliberately not an epoch: "`long` on ESP32 is 32-bit and a millisecond epoch overflows it - the
bug that silently broke the voice card."

Offline, `hostNowSec()` returns -1 and the device has **no clock at all** - `RTC_DATA_ATTR` and
`gettimeofday` survive deep sleep but not a power cycle. So the device can never compute how old
a snapshot is; it can only print what it stored. That makes the right field a **preformatted
ASCII string**, not a number:

```
hostDateShort: "Fri 20 Sep"     <= 11 chars + NUL
```

Chosen over a day-number because the device would then need calendar arithmetic to render it,
and over an epoch because of the overflow above. It is transliterated by `host/to-ascii.mjs`
like everything else device-bound, so the 12-byte field is exact in BYTES.

A host too old to send it leaves the field empty, and the offline band then reads
`OFFLINE - LAST SYNC 14:32` without a date rather than inventing one.

## Boot, and the third state

```
setup()
  -> mount SD (BOARD_HAS_SD only)
  -> read /dh/sessions.bin, validate magic/version/entSize/crc
  -> valid   : restore into sessions[], offlineMode = true, SESSIONS tab
     invalid : discard by name, waiting screen as today
     no card : waiting screen as today
```

`everReceived` keeps its current meaning. `offlineMode` is a separate flag, and the first real
payload clears it, replaces the list wholesale and repaints. A restored list is never merged
with a live one - merging two lists whose statuses are from different eras is how a stale row
survives into a live screen.

`statusSinceMillis`, `beepsLeft` and `nextBeepMillis` are **not restored**. The first is device
`millis()`, which restarts at 0, so a stored value is meaningless rather than merely stale. The
other two are an alert budget for an event that is over.

## What offline mode is allowed to claim

Decided with the user, 2026-09-20. A restored row keeps its status TEXT but loses every signal
that reads as a call to action:

- **Dots forced to `COLOR_UNKNOWN`.** The status colours mean "now"; grey is the theme's own
  "no data / stale" token and already means that on the USAGE tab.
- **No pulse, no crossfade, no shimmer, no beeps.** These animate *attention*. A session that
  was asking three days ago is not asking.
- **`urgencyRank` frozen to stored order.** The live comparator promotes `asking` to the top and
  ranks it by longest-waiting. Offline, that would give the most prominent row on the device to
  the least current thing on it. Stored order is what the Mac last believed; it is not a claim
  about now.
- **A band above the list**: `OFFLINE - LAST SYNC <date> <time>`, using `COLOR_UNKNOWN`.
- **Status text is prefixed**, e.g. `was: asking`, so a row read in isolation - a photograph, a
  glance from across the room - still cannot be mistaken for live.

The band costs vertical space, which on a 5-row scrolling list is a real price. It is paid
because the alternative is a screen that lies.

## Writes: never on the tick

| what | when |
|---|---|
| `sessions.bin` | only when the tick DIFF says the list changed - never per poll |
| `<id>.txt/.idx` | on fetch-complete, and on each `app: 1` delta |
| compaction | only when a transcript passes `SCROLL_TEXT_BYTES` |

Single-threaded, no second FreeRTOS task. The codebase is deliberately single-threaded and
`SD_MMC` sharing the bus alongside the QSPI panel and the ES8311 is not a thread-safety question
this spec wants to open. Both write moments above are already non-animating points in the loop.

### MEASURED, 2026-09-20, by `SDPERF` on this card

This was the main open risk in the first draft of this spec and it is now settled. Source buffer
in PSRAM, because that is where `scrollText` lives and a DRAM-sourced write would flatter a path
the real code never takes.

| operation | bytes | ms | rate |
|---|---|---|---|
| write | 2048 | 9 | 227 KB/s |
| write | 49152 | 23 | 2137 KB/s |
| write | 262144 | 66 | 3971 KB/s |
| read | 2048 | 2 | 1024 KB/s |
| read | 49152 | 9 | 5461 KB/s |
| read | 262144 | 40 | 6553 KB/s |
| append 2048 to a 262144-byte file | - | 9 | - |
| open + close, no payload | - | 5 | - |

**THE APPEND COSTS 9ms, THE SAME AS A FRESH 2KB WRITE AND 7.3x LESS THAN THE 66ms REWRITE IT
REPLACES.** That is the number the hybrid policy stands on: had an append to a 256KB file cost
what a rewrite costs, approach C would have collapsed back into approach A, which this spec
rejects. It does not.

Subtracting the 5ms open/close floor gives the data rates: ~2.7 MB/s at 48KB and ~4.3 MB/s at
256KB for writes, ~6.6 MB/s for reads. A read's open is cheaper than a write's, which has to
update FAT metadata.

**No chunking across ticks is required, and this spec no longer provides for it.** The worst
case in the design - a full 262144-byte transcript flush - is 66ms, at fetch-complete, which is
already a non-animating moment. Boot restore is 9ms for the list plus 40ms per transcript, all
before the first paint.

Caveats on these figures, stated rather than implied: n=1 per size; `millis()` has 1ms
resolution so the 9ms and 5ms readings carry about +/-11%; and the card was nearly empty, so
these are best-case FAT allocation. None of that changes the conclusion, because the margin
against a 5s tick is three orders of magnitude.

## Failure is always named

The rule this repo runs on - "from the Mac, silence and 'impossible here' look identical" -
applies to the card as much as to a verb. Every one of these degrades to EXACTLY today's
behaviour and says which:

| condition | behaviour |
|---|---|
| no card seated | offline restore skipped, waiting screen, `SDSTAT` says so |
| mount fails | ditto, naming the width/begin failure as `SDPROBE` does |
| bad magic / version / crc | file discarded BY NAME, not migrated, not partially read |
| `entSize` mismatch | discarded by name, quoting both sizes |
| card pulled mid-run | writes stop, reads fall back to PSRAM, state named once - not per tick |
| card full | oldest transcripts pruned; the count is stated |

## Commands, and the checker that enforces them

New verbs, board 2 only, each refused BY NAME on board 1 from `UNAVAILABLE_COMMANDS[]` under the
exact negation of its handler's guard (`!BOARD_HAS_SD`), exactly as `SDPROBE` does:

- `SDSTAT` - mounted? free space? how many snapshots, how many transcripts, last sync date.
- `SDSYNC` - force a write now, for testing the path without waiting for a natural trigger.
- `SDWIPE` - delete the stores. **Behind `ConfirmAction`** (`CFM_SD_WIPE`), because it destroys
  the only offline copy.
- `SDPERF` - time a list write and a transcript write, per the performance risk above.

`commands-check.mjs` parses both sides and fails by verb name if any is neither handled nor
refused, so forgetting one is not possible in silence.

## Shipping order

1. **Transcript persistence** (`/dh/tx/*`). No honesty problem to solve, immediately useful,
   and it proves the write path under real power cuts before anything depends on it.
2. **The wire's `hostDateShort`**, host and device.
3. **The list snapshot and offline mode.** Needs both of the above.

## Out of scope, deliberately

- `SCREENSHOT` / `MICREC` to the card. Its own spec; it shares only the mount.
- Raising `SCROLL_WIRE_CHUNK_BLE_BYTES`. Should land BEFORE this and changes its numbers.
- The stale `~666 B/s` figure, quoted in ten places, and the wrong `~384 KB/s` USB figure.
- Board 1. `BOARD_HAS_SD 0`, its slot is SPI-wired, and it refuses every verb here by name.
- Starting or resuming sessions from the device, and the PROJECTS tab. Separate work; neither
  needs the card.

## Risks

1. ~~**The write stall.**~~ **RETIRED 2026-09-20 by measurement** - see *Writes: never on the
   tick*. It was the highest risk here because its failure mode is a visibly janky UI that reads
   as a rendering bug; the worst case is 66ms at a non-animating moment, so it is not a risk.
   Kept rather than deleted because the next reader will otherwise ask the same question.
2. **`sizeof(SessionInfo)` drift.** Mitigated by `entSize`, which turns a silent misparse into a
   named discard - but it means a struct change invalidates every stored snapshot. That is the
   correct trade and should surprise nobody who reads this.
3. **Both binaries move.** The tab/UI work touches shared code. Expected, and to be explained in
   the commit the way `SDPROBE`'s +704 bytes of `.flash.rodata` was.
4. **A card carrying `askDetail` leaves the device.** Question text is not a credential, but it
   is the content of your prompts sitting on removable media. Worth knowing; not worth encrypting
   on an ESP32 whose key would sit in the same flash.

## What is measured and what is not

Measured, 2026-09-20, on this hardware:

- The slot works at 4-bit SDMMC: `SDPROBE ok width=4 type=SDHC size=14911MB`.
- The FATFS + SDMMC stack costs 76,304 bytes of flash and 480 bytes of RAM. Already paid.
- BLE transcript fetch: ~6.6 KB/s at the shipped 1500-byte chunk cap (10 samples).
- The host already delta-syncs held transcripts.
- SD write and read latency for every size this design uses, and the append - full table under
  *Writes: never on the tick*. `SDPERF` is the instrument and it is committed, so any later
  claim about these costs can be re-checked rather than argued.

NOT measured, and named as such:

- `sizeof(SessionInfo)` (estimated 2,386 by hand). `SDPERF` does not print it; the
  implementation must.
- Whether a torn write during a real power cut is caught by the CRC in practice, as opposed to
  in principle. The implementation should cause one deliberately and confirm the discard.
- Write cost on a FULL or fragmented card. Every figure above was taken on a nearly empty
  14911MB card, which is best-case FAT allocation.
