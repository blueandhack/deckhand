# One device, two Macs — design

**Status:** approved for planning
**Date:** 2026-08-20

## What this adds

One Deckhand device serves **two Macs at once** over BLE, with sessions from both
in a single urgency-ranked list. A row is tagged with the Mac it lives on, an
answer is signed with that Mac's own key and reaches only that Mac, and the USAGE
tab shows whichever Mac's quota reading is freshest, saying whose it is.

Nothing about the pairing model changes: `hosts[MAX_HOSTS]` NVS slots, one key per
(Mac, device) couple, `PROVISION` over USB only. **Provisioning the second Mac
still means plugging the device into it once** — BLE `PROVISION` is ignored by
design and stays ignored.

## Why the pairing half is already done

The multi-pairing work already assumed several Macs; what it never assumed was
several Macs *at the same time*.

| piece | state |
|---|---|
| per-(Mac, device) keys in NVS, up to `MAX_HOSTS` (4) | exists (`pairing.ino`) |
| `hostId` in every payload, selecting which key signs an answer | exists |
| PAIRED MACS page, forget-one, "ONLY this Mac" (`allowedHost`) | exists |
| host-side `hostId`, `PROVISION <hostId> <secret> <label>`, `HELLO … v2` gate | exists |
| device→host answer verified per transport (`deviceNameFor(via)`) | exists |
| **two concurrent BLE links** | **new** |
| **per-connection RX demux** | **new** |
| **per-link state, merged 6-row session list** | **new** |
| **addressed device→host lines** | **new** |
| **answers signed with the SESSION's Mac, not the last Mac to speak** | **new** |

## Decisions taken

- **One merged view, not a switcher.** Sessions from both Macs share one list and
  one urgency ranking, so a blocked prompt on either Mac is visible without
  choosing a Mac first. That is the whole point of the device.
- **Two concurrent links, one 6-row pool.** Rows are ranked
  asking > waiting > working, then recency, across both Macs; a quiet Mac takes no
  rows. A fixed 3+3 split was rejected: it lets a quiet Mac's *working* session
  hide a busy Mac's fourth *asking* session, which is exactly what urgency
  ranking exists to prevent.
- **Quota is account-scoped, so it is merged rather than split.** Both Macs poll
  the same OAuth endpoint for the same account and report the same numbers. The
  tab shows the reading with the lower age and names the Mac it came from, so a
  future divergence (different accounts) shows up as a number that changes label
  rather than a silent average. Two pollers also become each other's staleness
  backup: a Mac in a 429 back-off is simply out-aged by the other.
- **Untargeted actions resolve USB → marked Mac → slot 0.** USB is unambiguous
  (one cable), and the marked-Mac mechanism already exists on PAIRED MACS. No new
  UI, and no arbitrary choice.
- **A quiet link's rows are dropped, not dimmed.** Showing an unreachable Mac's
  prompt as answerable is the worse failure, and dropping keeps the footer's
  single "Xs ago" honest.

## Link layer

### Concurrent links

Bluedroid stops advertising on connect, so today a second Mac can never attach.
`onConnect` re-calls `startAdvertising()` while
`getConnectedCount() < MAX_LINKS` (2); `bleConnected` becomes a count. A third
central is refused rather than queued.

**No build-config change is needed, and that was checked rather than assumed.**
The stock Arduino 3.3.11 esp32 libs ship `CONFIG_BTDM_CTRL_BLE_MAX_CONN 3` and
`CONFIG_BT_ACL_CONNECTIONS 4`, so two links sit inside the controller's own
ceiling. Four Macs would sit *at* it, which is part of why the concurrent count is
2 while the pairing store stays 4 — remembering a Mac and talking to it at the
same moment are different limits.

### Per-connection RX demux — the load-bearing change

Both Macs write into the **same** RX characteristic in 20-byte chunks, and
`serialBufBLE` is a single accumulator. Their chunks therefore interleave and
every payload becomes corrupt JSON.

**The failure is silent in the worst available way**: `handleLine` returns early on
a parse error, so the screen simply stops updating while both links, both
heartbeats and both menu bars look healthy — the same shape as the stalled-tick
bug the host's watchdog exists for, but on the device.

Fix: use the `onWrite(BLECharacteristic*, esp_ble_gatts_cb_param_t*)` overload
(present in the installed 3.3.11 lib, verified) to read `param->write.conn_id`,
and frame each chunk into the existing 16KB stream buffer as
`[conn_id][len16][bytes]`. `loop()` demuxes into one line accumulator per link.
The BTC_TASK rule is unchanged and still absolute: `onWrite` copies bytes and
nothing else.

USB keeps its own accumulator and is simply a third lane.

### Attribution is by payload, not by connection

`conn_id` separates the *streams*; **which Mac** a line came from stays
`doc["hostId"]`, as today. That keeps USB and BLE identical and survives a
reconnect renumbering `conn_id`. Link state is keyed by `hostId` and freed on
disconnect.

### Addressed device→host lines

`BLECharacteristic::notify()` fans out to every connected peer (verified in the
library source: it loops `getPeerDevices()` and calls
`esp_ble_gatts_send_indicate` per peer — there is no single-peer notify in this
API). So an `ANSWER` reaches both Macs, and the Mac that lacks that nonce logs an
**authentication failure**. That is the "trains you to ignore the line that
matters" problem the duplicate-`PROMPT` dedup already exists for, and it would fire
on every answer rather than occasionally.

Every device→host line therefore carries a trailing `to=<hostId>`, and a host drops
a non-matching line **before logging it**. Trailing is deliberate: the host parses
with `startsWith` plus a positional `split`, so an extra token is ignored by an
un-upgraded Mac instead of breaking it.

| line | goes to |
|---|---|
| `ANSWER`, `PROMPT`, `HISTORY` | the session's owning Mac |
| voice/audio frames and their ACK lane | the target session's Mac; untargeted → primary |
| `SHOT`, mic-test output | the Mac that asked for it |
| `BATT`, `HELLO` | broadcast, unaddressed — both menu bars want the battery |

Addressing the audio lane matters beyond tidiness: broadcast frames double the
airtime on the link that is already the bottleneck.

## Device state

### Per-link state

`HostLink links[2]`: `hostId`, label, `lastRxMillis`, `remoteAnswer`,
`sessionsTotal`, `hiddenAsking`, its `Usage` block, its own `voiceSeq`. A few
hundred bytes each. The thing that cannot be duplicated is `SessionInfo`
(~2.2KB × 6 = 13.4KB against ~26KB free heap), and it is not duplicated.

**`voiceSeq` must be per-link or the voice card breaks immediately.** It is a
host-lifetime counter starting at 1, and the device already treats a *backwards*
seq as a new host generation. Two independent counters against one high-water mark
would trip that reset on nearly every tick — the same bug already documented for
the host-restart case, but continuous instead of occasional.

`remoteAnswerEnabled` becomes per-link. Nothing downstream changes: the per-prompt
`askAnswerable` is stamped from the sending link at parse time, which is already
how mid-prompt toggling is made safe.

### Merging into one 6-slot array

`SessionInfo` gains a `hostSlot` byte, and so does `PrevSession` — the tick diff
must match on *(host, id)*, and `PrevSession`'s field widths are already required
to mirror `SessionInfo`'s exactly.

On a payload from host H:

1. free the rows owned by H;
2. walk H's incoming list (already urgency-sorted by that host) into free rows;
   when full, overwrite the **globally** least-urgent row only if the incoming row
   beats it — the incoming list being sorted means the first failure ends the walk;
3. re-rank all rows through a `uint8_t order[6]` index, **not** by moving 2.2KB
   structs.

Display position stays the index, so `rowSigCache` and the detail screen's
id-anchoring keep working. `sessionsTotal` / `hiddenAsking` become sums across
links, so the "+N more" strip counts both Macs. The device now owns the cross-host
ranking that each host can only ever apply to its own list.

A link that sends nothing for ~4 ticks has its rows removed, mirroring the host's
own `SESSION_STALE_MS` pruning. The footer shows the freshest age; per-link ages
live on SETTINGS › STATUS.

### Which Mac a row belongs to is text, never colour

The rule the CC/CX tag already follows. The Mac's short label joins that tag:
`CC · air` in the sub-line, `CLAUDE · air` top-right on tall rows. This costs
nothing in the layout because `drawSessionRow` **measures** the name lane against
the tag's left edge, so a wider tag drops the name one rung down the
12x26 → 10x18 → 6x13 ladder rather than overlapping it. The detail screen gains a
MAC field in its column pairs.

### USAGE

Per-link quota is kept so a divergence stays detectable; the tab renders the
reading with the lower `quotaAgeSec` (the Codex row independently, by `cxAgeSec`,
as it already does). The source Mac's label is right-aligned in the card's **label
row at `+6`** — deliberately not the `+88` bottom row, whose clear box already had
to be moved off the card border, and nothing new may end past `+101`.

## Answer routing

`authHmac()` takes the host slot explicitly, resolved from the row's `hostSlot`.
Today it uses `activeHost` = "whoever sent the most recent payload", which with two
Macs ticking is wrong roughly half the time; the symptom would be intermittently
rejected answers with nothing obviously broken. `allowedHost` keeps its meaning: it
refuses to sign for anyone but the marked Mac.

The host still re-checks `ask.kind === "question"` before writing an answer file,
and still re-reads the record before a typed prompt. Nothing here relaxes a
host-side gate; a device-side gate has never been the gate.

## Mac side

Almost untouched. Each host keeps its own independent view — no cross-Mac
coordination, no shared files, no menu-bar change. It gains:

- the `to=<hostId>` filter, applied before logging;
- tolerance for its writes being interleaved with another central's (nothing to do:
  the demux is device-side).

## Verification

There is no test suite; verification is compile, flash, watch the log, look at the
glass. Coverage plan:

- **`MULTITEST`** — a device command injecting a synthetic second host's payload,
  following the `KBTEST` / `TAB` / `PAGE` precedent that exists precisely because
  the glass is otherwise unverifiable. Covers the merge, cross-Mac urgency
  ranking, row tags, the freshest-quota pick and the stale-link drop, and it is
  screenshottable via `SCREENSHOT`.
- **A second real Mac on USB with its own `hostId`** — covers attribution, answer
  routing and per-slot signing without involving BLE at all.
- **Two real BLE centrals** — the only thing that can prove the demux. Two host
  processes on *one* Mac both connecting to the same peripheral is **unverified**
  as a substitute and must not be assumed to be one.

## Risks, unresolved

1. **BLE airtime — measured, single link (Task 1).** `peripheral.mtu` came back
   `undefined` after connect against this Mac's real device (`Deckhand-0528`):
   `BLE: mtu=unreported for Deckhand-0528`. That confirms the suspicion above —
   noble's mac binding does not emit `onMtu` — so the decided rule applies:
   `BLE_CHUNK_SIZE` stays the module constant `20`; there is no negotiated MTU to
   chunk against and no per-peripheral sizing to add.
   A live payload write at that chunk size (779B, the size of a normal one-session
   tick) resolved in 0-1ms end to end, five ticks running:
   `BLE: wrote 779B in 1ms` / `...in 0ms` / `...in 1ms` / `...in 1ms` / `...in 1ms`.
   That number is the local dispatch time through noble's mac binding, not a
   measurement of over-the-air completion — `sendOverBle` writes *without
   response* (`writeAsync(chunk, true)`), and the binding's
   `write:...withoutResponse:` path (`ble_manager.mm`) fires the JS `Write`
   completion event immediately after calling `-[CBPeripheral writeValue:
   forCharacteristic:type:]`, with no wait for
   `peripheralIsReadyToSendWriteWithoutResponse` or a radio ack; only a
   `withResponse` write waits for `didWriteValueForCharacteristic`. So this
   measures how fast the host can hand chunks to CoreBluetooth, not how fast they
   cross the air.
   Even reading it that conservatively, one link's per-payload budget
   (`measured_ms_per_payload * 2` ≈ 2ms) is nowhere near the 5000ms tick, and the
   theoretical bound already in this risk (~666 B/s at 20B chunks / 30ms interval,
   ⇒ ~1.2s for a 779B payload, ~2.3s doubled for two links) also clears 5000ms with
   room to spare. **Branch taken: mtu unreported → `BLE_CHUNK_SIZE` stays `20`; the
   per-link budget does not exceed 5000ms, so Task 6's BLE-only-host detail trim
   (askDetail capped to 400 chars) is NOT required by this measurement.**
   Unresolved by this task, on purpose: two *concurrent* real BLE centrals sharing
   one radio (Task 4 builds the second link) — this run only establishes the
   single-link number the theoretical math above already assumed, doubled as the
   brief instructs. Re-measure once a second link exists rather than trusting the
   ×2 estimate as final.
2. **Link slot reuse.** A Mac reconnecting with a fresh `conn_id` while the old
   link lingers. State is keyed by `hostId` and freed on disconnect, but stale-slot
   behaviour needs watching on real reconnects, including after device sleep.
3. **A third central is refused**, not queued. Deliberate, and worth a log line so
   it does not present as a flaky link.
