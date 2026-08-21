# One device, two Macs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Deckhand device serves two Macs at once over BLE, with both Macs' sessions in a single urgency-ranked list, answers signed with and routed to the owning Mac.

**Architecture:** The device becomes a two-link BLE peripheral. Each central's writes are demultiplexed by `conn_id` into its own line accumulator, attributed to a Mac by the payload's `hostId`, and folded into per-link state. One 6-slot `SessionInfo` array holds rows from both Macs (per-host copies are impossible: 13.4KB against ~26KB free heap), re-ranked through an index. Device→host lines carry a trailing `to=<hostId>` because `notify()` broadcasts to every peer.

**Tech Stack:** Arduino ESP32 core 3.3.11 (Bluedroid `BLEDevice`/`BLEServer`), TFT_eSPI, ArduinoJson v7, Node 20+ on the host with `@abandonware/noble` and `serialport`.

**Spec:** `docs/superpowers/specs/2026-08-20-multi-host-design.md`

## Global Constraints

- **`MAX_LINKS = 2`** concurrent BLE links. The pairing store stays `MAX_HOSTS = 4` — remembering a Mac and talking to it at the same moment are different limits. Stock libs allow 3 (`CONFIG_BTDM_CTRL_BLE_MAX_CONN 3`), so 2 needs no build-config change.
- **No function signature anywhere in the sketch may name `HostPairing`, `Theme`, `Usage`, `SessionInfo`, `ConfirmAction`, or any new struct declared alongside them.** The Arduino build inserts generated prototypes above those declarations. Every helper added by this plan therefore takes and returns **int slot indices**, never a struct reference.
- **A BLE callback may only copy bytes.** No render, beep, or driver call from `onWrite`/`onConnect`/`onDisconnect` — they run on `BTC_TASK`, and touching a driver mutex locked on loopTask crash-loops with `assert failed: xTaskPriorityDisinherit`.
- **Cozette is ASCII 0x20–0x7E only.** Separators in row tags must be ASCII: use `/`, never `·`. (The spec prose writes `CC · air`; it renders as a blank box. `CC/air` is the shipping form.)
- **Every change-only cache must be at least as long as the padded string it holds**, or it silently stops noticing changes past its length. Any field this plan widens needs its cache re-checked.
- **Anything drawn on a usage card must END by `y0+101`** — `drawIfChanged` clears `fy-1 .. fy+th+1`, and the card's 2px border owns `+102..+103`.
- Firmware verification is: `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display` to compile, `./flash.sh` to flash (never a bare `arduino-cli upload` — launchd re-grabs the port within ~1s), then read `/tmp/deckhand-$(id -u)/host.log` and look at the glass. There is no test suite.
- Host scripts are run with plain `node` **only** when they never import `noble` (TCC SIGABRTs a bare node that touches CoreBluetooth). All check scripts in this plan import nothing from `index.mjs`.

---

## File Structure

| file | responsibility | change |
|---|---|---|
| `host/host-tag.mjs` | derive this Mac's ≤6-char display tag from its hostname | **create** |
| `host/host-tag-check.mjs` | check script for the above | **create** |
| `host/line-address.mjs` | `lineTargetsUs(line, myHostId)` — is this device→host line ours? | **create** |
| `host/line-address-check.mjs` | check script for the above | **create** |
| `host/index.mjs` | publish `hostTag`; drop lines addressed elsewhere before logging | modify |
| `firmware/deckhand_display/deckhand_display.ino` | link slots, RX demux, per-link state, payload attribution, MULTITEST | modify |
| `firmware/deckhand_display/sessions.ino` | 6-row merge, row tag, detail MAC field, `to=` stamping | modify |
| `firmware/deckhand_display/usage.ino` | freshest-reading pick, Mac label on cards | modify |
| `firmware/deckhand_display/pairing.ino` | `authHmac` signs with an explicit slot | modify |
| `firmware/deckhand_display/settings.ino` | STATUS page: per-link age and count | modify |
| `CLAUDE.md`, `README.md` | the multi-host model and its traps | modify |

---

### Task 1: Measure the BLE airtime ceiling (spike — no feature code)

The spec records this as unresolved and says to measure first, because a negative result changes the payload design rather than a constant. **Output is a number written into the spec, plus at most a one-constant change.**

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-multi-host-design.md` (Risk 1 → measured)
- Modify (only if the measurement supports it): `host/index.mjs:335` (`BLE_CHUNK_SIZE`)

**Interfaces:**
- Consumes: nothing.
- Produces: a decided `BLE_CHUNK_SIZE`, and a recorded per-link payload budget in bytes/5s that Task 6 honours.

- [ ] **Step 1: Log the negotiated MTU on the host**

In `startBle()`'s `discover` handler, right after `blePeripheral = peripheral;`, add a temporary line:

```js
console.log(`BLE: mtu=${peripheral.mtu ?? "unreported"} for ${name}`);
```

- [ ] **Step 2: Restart the host and read the value**

Run:
```bash
./host/deckhand-service.sh stop && ./host/deckhand-service.sh start
sleep 20 && grep -m1 "BLE: mtu=" /tmp/deckhand-$(id -u)/host.log
```
Expected: one of `mtu=<number>` (noble's `onMtu` fires on macOS) or `mtu=unreported`.

- [ ] **Step 3: Time one payload write at the current chunk size**

Wrap the write loop's caller in `sendOverBle` with a timer, temporarily:

```js
const t0 = Date.now();
// ... existing chunk loop ...
console.log(`BLE: wrote ${buf.length}B in ${Date.now() - t0}ms`);
```

Run the same restart, then:
```bash
grep -m5 "BLE: wrote" /tmp/deckhand-$(id -u)/host.log
```
Record ms per payload with **one** link up. Two links cannot be timed yet (Task 4 enables them); the single-link number times two is the conservative estimate.

- [ ] **Step 4: Decide and record**

Rules:
- `mtu` reported and ≥ 64 → set `BLE_CHUNK_SIZE = Math.max(20, mtu - 3)` computed **per peripheral after connect**, not as a module constant, and keep 20 as the fallback when `peripheral.mtu` is null.
- `mtu` unreported → leave `BLE_CHUNK_SIZE = 20` and record the per-link budget as `measured_ms_per_payload * 2 < 5000`? If that product exceeds 5000ms, Task 6 must trim the BLE-only host's payload (drop `askDetail` to 400 chars for links whose transport is BLE-only); note that requirement in the spec.

Edit the spec's Risk 1 to state the measured MTU, the measured ms/payload, and which branch was taken. Delete the two temporary log lines from Step 1 and Step 3 unless they became the permanent per-peripheral chunk sizing.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-20-multi-host-design.md host/index.mjs
git commit -m "Measure the BLE write budget before building the second link

Risk 1 in the design said measure before implementing, because an
unreported MTU changes the payload design rather than a constant."
```

---

### Task 2: Host publishes a short Mac tag

The device must not derive a display name from a hostname — the Mac knows its own, and the user may want to override it. `hostLabel` ("Yujias-MacBook-Air") is far too long for a row tag.

**Files:**
- Create: `host/host-tag.mjs`
- Create: `host/host-tag-check.mjs`
- Modify: `host/index.mjs:352` (near `hostLabel`), `host/index.mjs:2668` (the payload line)

**Interfaces:**
- Consumes: nothing.
- Produces: `macTag(hostname: string, override?: string): string` — lowercase, `[a-z0-9]` only, ≤6 chars, `""` when nothing usable. Payload gains `hostTag: string`. Task 8 renders it; Task 5 stores it.

- [ ] **Step 1: Write the failing check**

Create `host/host-tag-check.mjs`:

```js
// Run: node host/host-tag-check.mjs
// Imports nothing that touches CoreBluetooth, so plain node is safe here.
import { macTag } from "./host-tag.mjs";

let failed = 0;
const eq = (got, want, what) => {
  if (got === want) return;
  console.error(`FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  failed++;
};

// The distinguishing part of an Apple default hostname is the LAST segment:
// two Macs owned by one person differ in "Air" vs "Studio", never in "Yujias".
eq(macTag("Yujias-MacBook-Air.local"), "air", "apple laptop hostname");
eq(macTag("Yujias-Mac-Studio"), "studio", "apple desktop hostname");
eq(macTag("mac-mini.local"), "mini", "two-segment hostname");
eq(macTag("deckhand"), "deckha", "single segment is capped at 6");
eq(macTag("Bob's Mac"), "mac", "spaces split, apostrophe stripped");
eq(macTag(""), "", "no hostname yields no tag");
eq(macTag("Yujias-MacBook-Air", "studio-b"), "studio", "override wins and is capped");
eq(macTag("host", "  "), "host", "blank override falls through");
// A tag rides in EVERY payload and is drawn in a measured lane, so an
// over-long value is a layout bug rather than a cosmetic one.
eq(macTag("Yujias-Extremely-Longnamedmachine").length <= 6, true, "always <= 6");

console.log(failed ? `host-tag: ${failed} FAILED` : "host-tag: all checks passed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node host/host-tag-check.mjs`
Expected: FAIL — `Cannot find module .../host-tag.mjs`.

- [ ] **Step 3: Implement `macTag`**

Create `host/host-tag.mjs`:

```js
// The device draws this next to CC/CX on a session row, in a lane measured
// against the row's right edge - so it is capped at 6 characters HERE rather
// than trimmed on arrival. Derived on the Mac because the Mac is the only side
// that knows its own hostname, and overridable because a hostname is not always
// the name you think of the machine by.
export function macTag(hostname = "", override = "") {
  const pick = (s) => {
    const parts = String(s || "")
      .replace(/\.local$/i, "")
      .split(/[-_. ]+/)
      .filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : "";
    return last.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  };
  return pick(override) || pick(hostname);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node host/host-tag-check.mjs`
Expected: `host-tag: all checks passed`

- [ ] **Step 5: Publish it in the payload**

In `host/index.mjs`, next to the `hostLabel` definition (line ~352):

```js
import { macTag } from "./host-tag.mjs";
// ...
let hostLabel = os.hostname().replace(/\.local$/, "");
// Short display form for the device's session rows. DECKHAND_MAC_TAG overrides it.
let hostTag = macTag(hostLabel, process.env.DECKHAND_MAC_TAG || "");
```

And in the tick's payload line (~2668), add the field:

```js
const line = JSON.stringify({ ...usage, hostId, hostTag, remoteAnswer, voice: lastVoice }) + "\n";
```

- [ ] **Step 6: Verify it reaches the wire**

Run:
```bash
./host/deckhand-service.sh stop && ./host/deckhand-service.sh start
sleep 12 && grep -m1 "Auth: this Mac" /tmp/deckhand-$(id -u)/host.log
node -e 'import("./host/host-tag.mjs").then(m=>console.log(m.macTag(require("os").hostname())))'
```
Expected: the printed tag is what you want on the row (≤6 chars). If it isn't, set `DECKHAND_MAC_TAG` in the LaunchAgent plist rather than changing the derivation.

- [ ] **Step 7: Commit**

```bash
git add host/host-tag.mjs host/host-tag-check.mjs host/index.mjs
git commit -m "Publish a short tag for this Mac in every payload

The device has to say WHICH Mac a session row belongs to, and a hostname
is far too long for a row tag lane. Derived on the Mac (the only side that
knows its hostname), capped at 6 here rather than trimmed on arrival, and
overridable with DECKHAND_MAC_TAG."
```

---

### Task 3: Host drops device lines addressed to another Mac

`notify()` fans out to every connected peer, so an `ANSWER` reaches both Macs and the one lacking that nonce logs an **authentication failure** — on every answer. That trains you to ignore the one line that means something.

**Files:**
- Create: `host/line-address.mjs`
- Create: `host/line-address-check.mjs`
- Modify: `host/index.mjs:2175` (`handleDeviceLine`, first statement)

**Interfaces:**
- Consumes: `hostId` (existing module-level string in `index.mjs`).
- Produces: `lineTargetsUs(line: string, myHostId: string): boolean` — false only when the line carries a trailing `to=<hex>` naming somebody else. Task 9 makes the device stamp it.

- [ ] **Step 1: Write the failing check**

Create `host/line-address-check.mjs`:

```js
// Run: node host/line-address-check.mjs
import { lineTargetsUs } from "./line-address.mjs";

let failed = 0;
const t = (line, id, want, what) => {
  const got = lineTargetsUs(line, id);
  if (got === want) return;
  console.error(`FAIL ${what}: got ${got} want ${want} for ${JSON.stringify(line)}`);
  failed++;
};

const ME = "9f3c1a20", THEM = "44ab0071";

t("ANSWER abc123 4242 0 f00dcafef00dcafe to=9f3c1a20", ME, true, "addressed to us");
t("ANSWER abc123 4242 0 f00dcafef00dcafe to=44ab0071", ME, false, "addressed to the other Mac");
// Unaddressed is BROADCAST, not "drop": BATT and HELLO are deliberately for
// everyone, and a device on older firmware stamps nothing at all.
t("BATT mv=3854 pct=42 state=1 left=312", ME, true, "unaddressed broadcast");
t("HELLO Deckhand-1A2B v2", ME, true, "hello is for whoever is listening");
t("ANSWER abc123 4242 0 f00dcafef00dcafe", ME, true, "legacy firmware stamps nothing");
t("ANSWER abc123 4242 0 f00dcafef00dcafe to=9F3C1A20", ME, true, "hostId compare is case-insensitive");
// Only a TRAILING to= counts. A TYPED answer's base64 body is one token and can
// itself end in "to=" (padding is trailing), so the token must be anchored and
// hex - and an unparseable one must read as broadcast, never as "not ours",
// because wrongly dropping an answer strands a blocked prompt.
t("ANSWER a 1 TYPED aGVsbG8gdG8= deadbeefdeadbeef", ME, true, "base64 body is not an address");
t("ANSWER a 1 0 deadbeefdeadbeef to=", ME, true, "empty address reads as broadcast");
t("ANSWER a 1 0 deadbeefdeadbeef to=zzzz", ME, true, "non-hex address reads as broadcast");
// With no identity of our own we cannot judge, so we must not drop anything.
t("ANSWER a 1 0 deadbeefdeadbeef to=44ab0071", "", true, "no hostId yet: accept everything");

console.log(failed ? `line-address: ${failed} FAILED` : "line-address: all checks passed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node host/line-address-check.mjs`
Expected: FAIL — `Cannot find module .../line-address.mjs`.

- [ ] **Step 3: Implement it**

Create `host/line-address.mjs`:

```js
// BLECharacteristic::notify() sends to EVERY connected peer - there is no
// single-peer notify in that API - so with two Macs on one device each of them
// sees the other's answers. Without this filter the wrong Mac logs an
// authentication failure on every answer, which is the "trains you to ignore
// the line that matters" problem the duplicate-PROMPT dedup already exists for.
//
// Absence means BROADCAST, deliberately: BATT/HELLO are for everyone, and older
// firmware stamps nothing. An unparseable address also reads as broadcast -
// wrongly dropping an answer strands a blocked prompt, which is far worse than
// logging one line twice.
const ADDR = /\sto=([0-9a-fA-F]{1,16})$/;

export function lineTargetsUs(line, myHostId) {
  if (!myHostId) return true;
  const m = ADDR.exec(String(line || "").trimEnd());
  if (!m) return true;
  return m[1].toLowerCase() === String(myHostId).toLowerCase();
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node host/line-address-check.mjs`
Expected: `line-address: all checks passed`

- [ ] **Step 5: Apply it before any logging**

In `host/index.mjs`, add the import beside the other local imports, then make it the **first** statement of `handleDeviceLine` (line ~2175, above the `PROMPT` branch):

```js
async function handleDeviceLine(line, via) {
  // Before ANY logging: a line addressed to the other Mac is not ours to log,
  // authenticate, or act on.
  if (!lineTargetsUs(line, hostId)) return;
```

- [ ] **Step 6: Verify nothing regressed on one Mac**

Run:
```bash
./host/deckhand-service.sh stop && ./host/deckhand-service.sh start
sleep 70 && grep -c "BATT " /tmp/deckhand-$(id -u)/host.log
```
Expected: ≥1 — `BATT` arrives about once a minute and is unaddressed, so it must still be logged. Then tap an option on a real prompt and confirm `Remote answer: ... (auth ok)` still appears.

- [ ] **Step 7: Commit**

```bash
git add host/line-address.mjs host/line-address-check.mjs host/index.mjs
git commit -m "Drop device lines addressed to the other Mac before logging them

notify() has no single-peer form, so with two Macs each sees the other's
answers and would log an auth failure on every one. Absent or unparseable
addresses read as broadcast: wrongly dropping an answer strands a prompt."
```

---

### Task 4: Two concurrent BLE links, demultiplexed by connection

**The load-bearing task.** Without it, two Macs' 20-byte chunks interleave in one accumulator and every payload becomes corrupt JSON — and the failure is silent, because `handleLine` returns early on a parse error while both links and both menu bars look healthy.

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` — globals near line 115, `BLEServerCallbacksImpl`/`BLERxCallbacks` (~2889), `setupBLE` (~2912), `loop`'s drain (~3300)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `#define MAX_LINKS 2`
  - `int bleSlotForConn(uint16_t connId, bool create)` → slot index or -1
  - `void drainBleRx()` — called from `loop()` in place of the old inline drain
  - `int bleLinkCount()` → live link count (replaces reads of `bleConnected`; the bool stays, defined as `bleLinkCount() > 0`, so the ~20 existing call sites and the SETTINGS page keep working)

- [ ] **Step 1: Add the link slots and the frame header**

Replace the single-accumulator globals (`String serialBufBLE; unsigned long lastRxBLEMillis;` near line 118) with slots, keeping `bleConnected` and `lastRxBLEMillis` as derived values so existing call sites compile untouched:

```cpp
#define MAX_LINKS 2
// One accumulator PER CENTRAL. Both Macs write into the same RX characteristic
// in MTU-sized chunks, so their bytes interleave: sharing one accumulator makes
// every payload corrupt JSON, and the failure is silent (handleLine returns
// early on a parse error, so the screen simply stops updating while both links,
// both heartbeats and both menu bars look perfectly healthy).
//
// No function signature may name this type - the Arduino build inserts its
// generated prototypes above here - so every helper below takes an int slot.
struct BleLink {
  bool     used = false;
  uint16_t connId = 0;
  String   buf;                 // partial line for THIS central
  unsigned long lastRxMillis = 0;
};
BleLink bleLinks[MAX_LINKS];
bool bleConnected = false;         // still a bool: == (bleLinkCount() > 0)
unsigned long lastRxBLEMillis = 0; // freshest of the links, for the SETTINGS page
```

- [ ] **Step 2: Frame each chunk with its connection id**

Replace `BLERxCallbacks::onWrite` (~2904). Note the **atomicity guard**: header and payload go into the stream buffer as one unit or not at all — a partial write would desync the framing permanently, where the old unframed code merely lost bytes.

```cpp
class BLERxCallbacks : public BLECharacteristicCallbacks {
  // Runs on BTC_TASK - copy bytes and get out. Now also records WHICH central
  // sent them: conn_id goes in a 4-byte header ahead of the payload, and
  // loop() demuxes. The header and its payload must be written ATOMICALLY -
  // a partial write desyncs every frame that follows, where the old unframed
  // buffer merely dropped bytes - so a chunk that does not fit whole is
  // dropped whole. The host resends a full snapshot every 5s.
  void onWrite(BLECharacteristic* characteristic, esp_ble_gatts_cb_param_t* param) {
    String value = characteristic->getValue();
    size_t n = value.length();
    if (!bleRxStream || n == 0 || n > 0xFFFF) return;
    uint16_t conn = param ? param->write.conn_id : 0;
    if (xStreamBufferSpacesAvailable(bleRxStream) < n + 4) return;
    uint8_t hdr[4] = { (uint8_t)(conn & 0xFF), (uint8_t)(conn >> 8),
                       (uint8_t)(n & 0xFF), (uint8_t)(n >> 8) };
    xStreamBufferSend(bleRxStream, hdr, 4, 0);
    xStreamBufferSend(bleRxStream, value.c_str(), n, 0);
  }
  // Keep the one-argument form delegating, so a library version that calls it
  // instead cannot silently lose every write.
  void onWrite(BLECharacteristic* characteristic) { onWrite(characteristic, nullptr); }
};
```

- [ ] **Step 3: Add the slot helpers and the drain state machine**

Add above `setupBLE()`:

```cpp
int bleLinkCount() {
  int n = 0;
  for (int i = 0; i < MAX_LINKS; i++) if (bleLinks[i].used) n++;
  return n;
}
// Slot for a connection id. create=false is a pure lookup, so a stray write
// from a central we refused cannot claim a slot.
int bleSlotForConn(uint16_t connId, bool create) {
  for (int i = 0; i < MAX_LINKS; i++) if (bleLinks[i].used && bleLinks[i].connId == connId) return i;
  if (!create) return -1;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!bleLinks[i].used) {
      bleLinks[i].used = true;
      bleLinks[i].connId = connId;
      bleLinks[i].buf = "";
      return i;
    }
  }
  return -1;
}
void bleReleaseConn(uint16_t connId) {
  int i = bleSlotForConn(connId, false);
  if (i < 0) return;
  bleLinks[i].used = false;
  bleLinks[i].buf = "";
  bleConnected = bleLinkCount() > 0;
}
// Drains the framed stream buffer into per-link accumulators. Partial reads are
// normal (the buffer is filled by another task), so the header and the payload
// remainder are carried across calls in statics rather than assumed complete.
void drainBleRx() {
  static uint8_t hdr[4];
  static int hdrHave = 0;
  static int frameSlot = -1;
  static uint16_t frameLeft = 0;
  if (!bleRxStream) return;
  char chunk[64];
  for (;;) {
    if (frameLeft == 0) {
      size_t got = xStreamBufferReceive(bleRxStream, hdr + hdrHave, 4 - hdrHave, 0);
      if (got == 0) return;
      hdrHave += got;
      if (hdrHave < 4) return;
      hdrHave = 0;
      uint16_t conn = (uint16_t) hdr[0] | ((uint16_t) hdr[1] << 8);
      frameLeft = (uint16_t) hdr[2] | ((uint16_t) hdr[3] << 8);
      frameSlot = bleSlotForConn(conn, true);
      continue;
    }
    size_t want = frameLeft < sizeof(chunk) ? frameLeft : sizeof(chunk);
    size_t got = xStreamBufferReceive(bleRxStream, chunk, want, 0);
    if (got == 0) return;
    frameLeft -= got;
    if (frameSlot < 0) continue;   // a refused central: consume and discard
    bleLinks[frameSlot].lastRxMillis = millis();
    lastRxBLEMillis = millis();
    for (size_t i = 0; i < got; i++)
      feedChar(chunk[i], bleLinks[frameSlot].buf, &bleLinks[frameSlot].lastRxMillis, false);
  }
}
```

- [ ] **Step 4: Keep advertising after a connect, and refuse a third central**

Replace `BLEServerCallbacksImpl` (~2889). Only bookkeeping here — no drawing, no `Serial` heavy work, this is `BTC_TASK`:

```cpp
class BLEServerCallbacksImpl : public BLEServerCallbacks {
  // Bluedroid STOPS advertising on connect, which is why a second Mac could
  // never attach. Resume while a slot is free; refuse beyond MAX_LINKS rather
  // than queueing, so a third central fails visibly instead of flapping.
  void onConnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) {
    uint16_t conn = param ? param->connect.conn_id : 0;
    if (bleSlotForConn(conn, true) < 0) {
      server->disconnect(conn);
      return;
    }
    bleConnected = true;
    if (bleLinkCount() < MAX_LINKS) BLEDevice::startAdvertising();
  }
  void onDisconnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) {
    bleReleaseConn(param ? param->disconnect.conn_id : 0);
    BLEDevice::startAdvertising();
  }
  void onConnect(BLEServer* server) {}       // superseded by the param forms
  void onDisconnect(BLEServer* server) { BLEDevice::startAdvertising(); }
};
```

- [ ] **Step 5: Point `loop()` at the new drain, and fix the advertising watchdog**

In `loop()` (~3300) replace the inline drain with `drainBleRx();`, and change the 5s advertising safety net (~3434) so it re-advertises whenever a slot is free rather than only when nothing is connected:

```cpp
  drainBleRx();
```
```cpp
  if (bleLinkCount() < MAX_LINKS && millis() - lastAdvCheck > 5000) {
```

- [ ] **Step 6: Compile**

Run:
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display
```
Expected: success. A failure naming a generated prototype means a signature took `BleLink` — return to int slots.

- [ ] **Step 7: Flash and verify one link still works (regression first)**

Run:
```bash
./flash.sh
sleep 30 && tail -20 /tmp/deckhand-$(id -u)/host.log
```
Expected: `BLE: connected to Deckhand-XXXX and ready.` and ticks with `via=usb,ble`. The device's USAGE tab shows live numbers. **This proves the framing round-trips**; a demux bug shows as a frozen screen with a healthy log.

- [ ] **Step 8: Verify a SECOND central attaches and is separated**

Preferred: run the host on the second Mac (it needs its own `DeckhandBLE.app` and one USB `PROVISION` first — see Task 9's note). Without a second Mac, use a BLE explorer app on a phone (LightBlue, nRF Connect): connect to `Deckhand-XXXX` and write any bytes to the RX characteristic.

Expected: the phone/second Mac connects **while the first stays connected** (this is what fails today), the first Mac's ticks keep parsing, and junk written by the explorer does not corrupt them. Add a temporary `Serial.printf("BLE: frame conn=%u slot=%d n=%u\n", conn, frameSlot, frameLeft);` in the drain if you need to see the separation, and remove it before committing.

- [ ] **Step 9: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "Accept two BLE centrals and demultiplex their writes

Bluedroid stops advertising on connect, so a second Mac could never
attach. And both Macs write into ONE RX characteristic, so a single
accumulator interleaves their chunks into corrupt JSON - silently, since
handleLine returns early on a parse error while both links look healthy.
Each chunk now carries its conn_id in a 4-byte header, written atomically
because a partial write desyncs every following frame."
```

---

### Task 5: Per-link state, attribution, and a synthetic second host

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` — new globals after `Usage usage;` (~408), `handleLine` (~2421), `processCompletedLine` (~3129, the MULTITEST command)

**Interfaces:**
- Consumes: `bleLinkCount()` (Task 4), `hostTag` in the payload (Task 2).
- Produces:
  - `int linkForHost(const char* hostId, bool create)` → slot in `hostLinks[]`, or -1
  - `int curLink` — slot the payload being parsed belongs to (set at the top of `handleLine`)
  - `void pruneStaleLinks()` — drops a link silent for `LINK_STALE_MS`; called from `handleLine` after the parse
  - `const char* linkTag(int slot)` → its `hostTag`, or `""`
  - MULTITEST command: `MULTITEST <n>` injects a synthetic payload from host `feedfeed` / tag `test` with `n` sessions

- [ ] **Step 1: Declare per-link state**

Add immediately after the `Usage usage;` global (~408) so `Usage` is already defined, and keep every helper int-based:

```cpp
// ---------- Per-Mac link state ----------
// One device serves two Macs at once, and almost everything a payload carries
// is per-Mac: its quota reading, whether ITS hook is waiting for us, how many
// sessions it had to leave out, and its own voice sequence. SessionInfo is the
// one thing that cannot be per-Mac (2.2KB x 6 = 13.4KB against ~26KB free
// heap), which is why the session list is MERGED instead - see mergeSessions().
//
// Keyed by hostId, NOT by BLE conn_id: conn_id is renumbered by a reconnect,
// and USB carries the same Mac with no conn_id at all.
const unsigned long LINK_STALE_MS = 21000;  // ~4 missed ticks
struct HostLink {
  bool  used = false;
  char  hostId[12] = "";
  char  tag[8] = "";
  unsigned long lastPayloadMillis = 0;
  bool  remoteAnswer = true;
  int   sessionsTotal = 0;
  int   hiddenAsking = 0;
  Usage usage;
  // Host-LIFETIME counter, so it restarts at 1 when that host process does.
  // It MUST be per-link: shared as one high-water mark, two independent
  // counters would trip the "seq went backwards = new host generation" reset
  // on nearly every tick, disabling the voice card continuously rather than
  // just after a restart.
  long voiceSeq = 0;
  long voiceSeqShown = 0;
};
HostLink hostLinks[MAX_LINKS];
int curLink = -1;   // which link the payload being parsed came from
```

- [ ] **Step 2: Attribute each payload to a link**

In `handleLine` (~2427), extend the existing `hostId` block. Keep the legacy-upgrade HELLO exactly as it is; add the link resolution below it:

```cpp
  const char* hid = doc["hostId"] | "";
  // ... existing legacy-upgrade HELLO block, unchanged ...
  if (slot != activeHost) activeHost = slot;
  // Which LINK is this? Separate from activeHost (a pairing slot): a Mac can
  // be talking to us without being paired, and a paired Mac can be absent.
  curLink = linkForHost(hid, true);
  if (curLink >= 0) {
    hostLinks[curLink].lastPayloadMillis = millis();
    copyField(hostLinks[curLink].tag, sizeof(hostLinks[curLink].tag), doc["hostTag"] | "");
  }
```

Then make the per-link fields land on the link rather than on globals — `remoteAnswerEnabled` becomes the sending link's flag (the per-prompt `askAnswerable` still reads it at parse time, which is what already makes mid-prompt toggling safe):

```cpp
  remoteAnswerEnabled = doc["remoteAnswer"] | true;
  if (curLink >= 0) hostLinks[curLink].remoteAnswer = remoteAnswerEnabled;
```

Write the parsed `Usage` fields into `hostLinks[curLink].usage` instead of the global `usage`, then let Task 7 pick which link's copy the global takes. Until Task 7 lands, keep one extra line right after the usage parse so the screen keeps working:

```cpp
  if (curLink >= 0) hostLinks[curLink].usage = usage;   // Task 7 reverses this direction
```

- [ ] **Step 3: Add the link helpers**

Add beside `pruneStaleLinks`, above `handleLine`:

```cpp
int linkForHost(const char* hostId, bool create) {
  if (!hostId || !*hostId) return -1;
  for (int i = 0; i < MAX_LINKS; i++)
    if (hostLinks[i].used && strcmp(hostLinks[i].hostId, hostId) == 0) return i;
  if (!create) return -1;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) {
      hostLinks[i] = HostLink();
      hostLinks[i].used = true;
      strlcpy(hostLinks[i].hostId, hostId, sizeof(hostLinks[i].hostId));
      return i;
    }
  }
  // Full: recycle the stalest link rather than ignoring a Mac that is actually
  // talking to us. With MAX_LINKS == MAX concurrent centrals this is reachable
  // only via USB plus two BLE links, or a stale entry that has not aged out yet.
  int oldest = 0;
  for (int i = 1; i < MAX_LINKS; i++)
    if (hostLinks[i].lastPayloadMillis < hostLinks[oldest].lastPayloadMillis) oldest = i;
  hostLinks[oldest] = HostLink();
  hostLinks[oldest].used = true;
  strlcpy(hostLinks[oldest].hostId, hostId, sizeof(hostLinks[oldest].hostId));
  return oldest;
}
const char* linkTag(int slot) {
  return (slot >= 0 && slot < MAX_LINKS && hostLinks[slot].used) ? hostLinks[slot].tag : "";
}
// A Mac that has stopped sending is a Mac whose rows are now fiction: showing
// its pending prompt as answerable is worse than showing nothing, and it also
// keeps the footer's single "Xs ago" honest. Rows are DROPPED, not dimmed.
void pruneStaleLinks() {
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    if (millis() - hostLinks[i].lastPayloadMillis <= LINK_STALE_MS) continue;
    Serial.printf("LINK: %s went quiet, dropping its rows\n", hostLinks[i].hostId);
    dropSessionsForLink(i);          // defined in Task 6
    hostLinks[i].used = false;
  }
}
```

Call `pruneStaleLinks();` at the end of `handleLine`, after the session list has been rebuilt.

- [ ] **Step 4: Add the MULTITEST harness**

Two real Macs are needed to prove the demux, but the merge, the ranking, the tags and the stale-drop can all be driven from one. Same reason `KBTEST`, `TAB` and `PAGE` exist: the capture path can only record what is on the glass.

In `processCompletedLine`, beside the `KBTEST` branch:

```cpp
  } else if (buf.startsWith("MULTITEST")) {
    // Injects a payload from a SYNTHETIC second Mac, so the merge, the
    // cross-Mac ranking, the row tags and the stale-link drop are all
    // verifiable (and screenshottable) from one Mac. It cannot answer
    // anything: hostId "feedfeed" matches no pairing slot, so authHmac
    // refuses to sign - which is the safe direction and is deliberate.
    int n = buf.substring(9).toInt();
    if (n < 0) n = 0;
    if (n > MAX_SESSIONS) n = MAX_SESSIONS;
    String line = "{\"hostId\":\"feedfeed\",\"hostTag\":\"test\",\"remoteAnswer\":true,"
                  "\"fiveHourPct\":11,\"sevenDayPct\":22,\"quotaAgeSec\":1,"
                  "\"sessionsTotal\":" + String(n) + ",\"sessions\":[";
    for (int i = 0; i < n; i++) {
      if (i) line += ",";
      // One asking row first so the cross-Mac urgency merge is exercised, then
      // working rows - which is the ordering a real host sends.
      line += "{\"id\":\"fake0000000" + String(i) +
              "\",\"name\":\"testproj" + String(i) +
              "\",\"status\":\"" + (i == 0 ? "asking" : "working") +
              "\",\"agent\":\"cc\",\"model\":\"claude-opus-5\",\"path\":\"/tmp/test\"" +
              (i == 0 ? ",\"ask\":{\"pid\":\"9901\",\"kind\":\"perm\",\"title\":\"Allow Bash?\","
                        "\"detail\":\"echo synthetic\",\"options\":[\"Allow\",\"Deny\"],"
                        "\"answerable\":true,\"nonce\":\"testnonce\"}"
                      : "") +
              "}";
    }
    line += "]}";
    handleLine(line);
  }
```

- [ ] **Step 5: Compile and flash**

Run:
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display && ./flash.sh --no-compile
```
Expected: compiles; the device comes back with live numbers from the real Mac.

- [ ] **Step 6: Observe the bug this task sets up and Task 6 fixes**

Run:
```bash
echo "MULTITEST 2" > ~/.claude/deckhand-device-command
```
Expected **now** (merge not yet implemented): the sessions list flips to the two synthetic rows, and the real Mac's next tick (≤5s) replaces them again — visible flapping. That is the wholesale-replace behaviour Task 6 removes; confirm you can see it, because it is the before-picture for Task 6's verification.

Also confirm the link bookkeeping is real:
```bash
grep -m2 "LINK: feedfeed went quiet" /tmp/deckhand-$(id -u)/host.log
```
Expected: appears ~21s after the injection, since nothing refreshes the synthetic link.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "Track per-Mac link state, keyed by hostId

Everything a payload carries except the session list is per-Mac: its
quota, whether ITS hook is waiting, what it left out, and its own voice
sequence - which MUST be per-link, because two host-lifetime counters
against one high-water mark trip the 'seq went backwards' reset on nearly
every tick. Adds MULTITEST so the merge is verifiable from one Mac."
```

---

### Task 6: Merge both Macs' sessions into the 6-row pool

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `SessionInfo` (~630), `PrevSession` (~713), the session parse loop (~2558)
- Modify: `firmware/deckhand_display/sessions.ino` — `renderSessionsList` and `drawSessionRow` iterate through the order index

**Interfaces:**
- Consumes: `curLink`, `hostLinks[]`, `linkTag()` (Task 5).
- Produces:
  - `SessionInfo.hostSlot` / `PrevSession.hostSlot` (`uint8_t`, 0xFF = none)
  - `uint8_t sessionOrder[MAX_SESSIONS]` — display position → array index
  - `int sessionAt(int displayPos)` → array index, or -1
  - `int urgencyRank(const char* status)` → 0 asking, 1 waiting, 2 working
  - `void dropSessionsForLink(int slot)`
  - `void reorderSessions()`

- [ ] **Step 1: Add ownership to the row and the diff**

In `SessionInfo` (after `agent`):

```cpp
  // Which Mac this row lives on: an index into hostLinks[], 0xFF = unknown.
  // The tick diff matches on (hostSlot, id), so PrevSession carries it too -
  // its field widths must mirror this struct exactly or copyField truncates a
  // comparison into a false match.
  uint8_t hostSlot;
```

In `PrevSession`, beside `id`:

```cpp
  uint8_t hostSlot;
```

and copy it in the snapshot loop (~2545): `dst.hostSlot = src.hostSlot;`

- [ ] **Step 2: Replace wholesale replacement with a per-link merge**

The parse loop currently does `sessionCount = 0;` and rebuilds everything, which with two Macs makes the list flap between them every tick. Replace that single line with a free-this-link pass, and bound the fill by urgency.

Before the loop:

```cpp
  // Free only the rows belonging to the Mac that just spoke. The other Mac's
  // rows must survive its silence between ticks - wholesale replacement is
  // what made the list flap between the two.
  int keep = 0;
  for (int i = 0; i < sessionCount; i++) {
    if (sessions[i].hostSlot == (uint8_t) curLink) continue;
    if (keep != i) sessions[keep] = sessions[i];
    keep++;
  }
  sessionCount = keep;
```

Inside the loop, replace `if (sessionCount >= MAX_SESSIONS) break;` with an urgency-aware admission. The incoming list is already urgency-sorted by that host, so the first rejection ends the walk:

```cpp
      int dst = sessionCount;
      if (dst >= MAX_SESSIONS) {
        // Full: evict the globally least-urgent row, but ONLY if this incoming
        // row beats it. The incoming list is sorted, so once one fails every
        // later one fails too.
        int worst = -1, worstRank = -1;
        for (int i = 0; i < MAX_SESSIONS; i++) {
          int r = urgencyRank(sessions[i].status);
          if (r > worstRank) { worstRank = r; worst = i; }
        }
        if (worst < 0 || urgencyRank(s["status"] | "waiting") >= worstRank) break;
        dst = worst;
      } else {
        sessionCount++;
      }
      SessionInfo& info = sessions[dst];
      info.hostSlot = (uint8_t) curLink;
```

(Replace the existing `SessionInfo& info = sessions[sessionCount];` line; every `copyField` below it is unchanged.)

- [ ] **Step 3: Sum the per-link overflow counters**

The existing `sessionsTotal` / `hiddenAskingCount` assignments become per-link, then summed, so the "+N more" strip counts both Macs:

```cpp
  if (curLink >= 0) {
    hostLinks[curLink].sessionsTotal = doc["sessionsTotal"] | 0;
    hostLinks[curLink].hiddenAsking = doc["hiddenAsking"] | 0;
  }
  sessionsTotal = 0;
  hiddenAskingCount = 0;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    sessionsTotal += hostLinks[i].sessionsTotal;
    hiddenAskingCount += hostLinks[i].hiddenAsking;
  }
```

- [ ] **Step 4: Rank across Macs through an index, not by moving structs**

Add near the merge helpers:

```cpp
uint8_t sessionOrder[MAX_SESSIONS];
int urgencyRank(const char* status) {
  if (strcmp(status, "asking") == 0) return 0;
  if (strcmp(status, "waiting") == 0) return 1;
  return 2;
}
int sessionAt(int displayPos) {
  if (displayPos < 0 || displayPos >= sessionCount) return -1;
  return sessionOrder[displayPos];
}
// Each host only ever ranks its OWN list, so with two Macs the cross-host
// ranking has to happen here. An index sort, deliberately: a SessionInfo is
// 2.2KB and a value sort would memmove tens of KB every tick.
void reorderSessions() {
  for (int i = 0; i < sessionCount; i++) sessionOrder[i] = i;
  for (int i = 1; i < sessionCount; i++) {
    for (int j = i; j > 0; j--) {
      const SessionInfo& a = sessions[sessionOrder[j - 1]];
      const SessionInfo& b = sessions[sessionOrder[j]];
      int ra = urgencyRank(a.status), rb = urgencyRank(b.status);
      bool swap = (rb < ra) || (rb == ra && b.actSec > a.actSec);
      if (!swap) break;
      uint8_t t = sessionOrder[j - 1]; sessionOrder[j - 1] = sessionOrder[j]; sessionOrder[j] = t;
    }
  }
}
void dropSessionsForLink(int slot) {
  int keep = 0;
  for (int i = 0; i < sessionCount; i++) {
    if (sessions[i].hostSlot == (uint8_t) slot) continue;
    if (keep != i) sessions[keep] = sessions[i];
    keep++;
  }
  sessionCount = keep;
  reorderSessions();
}
```

Call `reorderSessions();` at the end of the parse, immediately before the existing `renderSessionsList()`/repaint path, and again inside `pruneStaleLinks` via `dropSessionsForLink`.

- [ ] **Step 5: Render and hit-test through the index**

In `sessions.ino`, every loop that walks `sessions[i]` for the LIST must go through `sessionAt(pos)`. In `renderSessionsList`, change `for (int i = 0; i < sessionCount; i++)` to:

```cpp
  for (int pos = 0; pos < sessionCount; pos++) {
    int i = sessionAt(pos);
    // rowSigCache is keyed by DISPLAY POSITION, which is what it has always
    // been - so pass pos where the cache is indexed and i where the row's data
    // is read.
```

In `deckhand_display.ino`'s touch dispatch (~2413), `openSessionDetail(row)` must take the display row through the index: `openSessionDetail(sessionAt(row));`. `openSessionDetail` itself already anchors by `detailId`, so nothing else changes.

- [ ] **Step 6: Compile, flash, and verify the merge**

Run:
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display && ./flash.sh --no-compile
sleep 25
echo "MULTITEST 2" > ~/.claude/deckhand-device-command
```
Expected, on the glass: the two synthetic rows **and** the real Mac's rows are present together, and they stay together across several 5s ticks — no flapping. The synthetic `asking` row sorts above the real Mac's `working` rows.

Then:
```bash
echo "TAB 1" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
sleep 25 && ls -t ~/Deckhand-shots | head -1
```
Expected: a PNG showing the mixed list. Open it and confirm the ordering.

Then confirm the drop:
```bash
sleep 25 && grep -m1 "LINK: feedfeed went quiet" /tmp/deckhand-$(id -u)/host.log
```
Expected: the log line, and the synthetic rows disappear from the screen while the real Mac's rows stay.

- [ ] **Step 7: Verify the single-Mac case did not regress**

With no MULTITEST injected, watch for 30s: row count, ordering and the "+N more" strip must match what the host logs as `sessions(N)=`. Run:
```bash
grep -m3 "sessions(" /tmp/deckhand-$(id -u)/host.log | tail -1
```
Expected: the device shows the same set. A row that vanishes here means the free-this-link pass is matching the wrong `hostSlot`.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino firmware/deckhand_display/sessions.ino
git commit -m "Merge both Macs' sessions into the one 6-row pool

A payload used to replace the whole list, so two Macs ticking made it flap
between them. Each tick now frees only the sending Mac's rows and admits
its new ones by urgency, evicting the globally least-urgent row only when
the incoming one beats it. Ranking is an index sort: a SessionInfo is
2.2KB and per-Mac arrays are impossible at 13.4KB against ~26KB of heap."
```

---

### Task 7: USAGE takes the freshest reading and says whose

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` — the usage parse (~2510-2537)
- Modify: `firmware/deckhand_display/usage.ino` — `drawCardChrome`, `renderUsageTab`, `resetUsageCaches`

**Interfaces:**
- Consumes: `hostLinks[].usage`, `linkTag()` (Task 5).
- Produces:
  - `void mergeUsage()` — writes the freshest per-source reading into the global `usage`
  - `int usageSourceLink` / `int cxSourceLink` — which link the shown Claude / Codex figures came from
  - `drawCardChrome(int y0, const char* label, const char* tag)` — third parameter is the Mac tag, `""` for none

- [ ] **Step 1: Park each link's reading, then merge**

In `handleLine`, keep the existing parse but write it into the link and derive the global from all links. Replace the temporary line added in Task 5 Step 2 with a real merge:

```cpp
  if (curLink >= 0) hostLinks[curLink].usage = usage;
  mergeUsage();
```

- [ ] **Step 2: Implement the merge**

Add to `usage.ino`:

```cpp
int usageSourceLink = -1;
int cxSourceLink = -1;
// Both Macs poll the same account, so the quota is the same number twice - the
// useful difference between them is AGE. Take the fresher reading per source
// (Claude by quotaAgeSec, Codex independently by cxAgeSec, which is already how
// the Codex row's staleness is judged), and remember which Mac it came from so
// the card can say. Two pollers therefore back each other up: a Mac in a long
// OAuth back-off is simply out-aged by the other.
//
// A negative age means "never measured", which must never win against a real
// reading - and must not read as fresher than one, which is what a plain
// comparison on -1 would do.
void mergeUsage() {
  int best = -1, bestCx = -1;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    const Usage& u = hostLinks[i].usage;
    if (u.fiveHourPct >= 0 || u.sevenDayPct >= 0) {
      if (best < 0 || (u.quotaAgeSec >= 0 &&
          (hostLinks[best].usage.quotaAgeSec < 0 ||
           u.quotaAgeSec < hostLinks[best].usage.quotaAgeSec))) best = i;
    }
    if (u.cxPct >= 0) {
      if (bestCx < 0 || (u.cxAgeSec >= 0 &&
          (hostLinks[bestCx].usage.cxAgeSec < 0 ||
           u.cxAgeSec < hostLinks[bestCx].usage.cxAgeSec))) bestCx = i;
    }
  }
  usageSourceLink = best;
  cxSourceLink = bestCx;
  if (best >= 0) {
    const Usage& u = hostLinks[best].usage;
    usage.fiveHourPct = u.fiveHourPct;      usage.fiveHourResetInMin = u.fiveHourResetInMin;
    usage.sevenDayPct = u.sevenDayPct;      usage.sevenDayResetInMin = u.sevenDayResetInMin;
    usage.sessionTokens = u.sessionTokens;  usage.weekAllTokens = u.weekAllTokens;
    usage.weekFableTokens = u.weekFableTokens; usage.weekFablePct = u.weekFablePct;
    usage.quotaAgeSec = u.quotaAgeSec;
  }
  if (bestCx >= 0) {
    const Usage& u = hostLinks[bestCx].usage;
    usage.cxPct = u.cxPct;  usage.cxResetInMin = u.cxResetInMin;
    usage.cxWindowMin = u.cxWindowMin;  usage.cxAgeSec = u.cxAgeSec;
  }
}
```

- [ ] **Step 3: Show the source Mac in the card's label row**

The label row at `y0 + 6` is the only free lane: the `+88` bottom row's clear box already had to be moved off the border, and nothing may end past `+101`. Extend `drawCardChrome`:

```cpp
void drawCardChrome(int y0, const char* label, const char* tag) {
  uiCard(CARD_X, y0, CARD_W, CARD_H, COLOR_CARD);  // border added by caller when active
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(label, CARD_X + PAD, y0 + 6);   // usage cards have their own inset
  // Which Mac's reading this is. Only drawn with two links up: with one Mac it
  // is noise, and a label that appears and disappears is how you notice the
  // second Mac arriving. Right-aligned in the SAME row as the label, because
  // every other row on this card is spoken for.
  if (tag && *tag && bleLinkCount() + (usbLinkActive() ? 1 : 0) > 1) {
    tft.setTextDatum(TR_DATUM);
    tft.drawString(tag, CARD_X + CARD_W - PAD, y0 + 6);
    tft.setTextDatum(TL_DATUM);
  }
}
```

Update both call sites in `renderUsageTab` to pass `linkTag(usageSourceLink)`, and the Codex row's own label draw to pass `linkTag(cxSourceLink)`.

- [ ] **Step 4: Bust the caches when the source changes**

`drawCardChrome` is chrome, so it only repaints on a full redraw — but the *tag* changes when the fresher Mac changes, with no other value moving. Add to `renderUsageTab`, beside the existing stale-flip cache busting:

```cpp
  // A source change moves no percentage, so nothing else would repaint - the
  // same trap the stale-dim flip has, where the digits stay identical.
  static int srcCache = -2, cxSrcCache = -2;
  if (srcCache != usageSourceLink || cxSrcCache != cxSourceLink) {
    srcCache = usageSourceLink;
    cxSrcCache = cxSourceLink;
    drawUsageStatic();   // repaints chrome; resetUsageCaches() runs inside it
  }
```

If `drawUsageStatic()` does not already reset the field caches, add `resetUsageCaches();` to it — repainting the chrome those fields are drawn ON is exactly the case `drawSettingsStatic()` documents, where forgetting leaves every value blank.

- [ ] **Step 5: Compile, flash, verify**

Run:
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display && ./flash.sh --no-compile
sleep 25
echo "MULTITEST 1" > ~/.claude/deckhand-device-command
echo "TAB 0" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
sleep 25 && ls -t ~/Deckhand-shots | head -1
```
Expected in the PNG: the real Mac's percentages (its `quotaAgeSec` is ~seconds; the synthetic payload claims `quotaAgeSec: 1`, so **whichever is fresher wins** — check the tag matches the numbers shown, i.e. `test` with 11%/22%, or your Mac's tag with the real figures). No text crosses the card border.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino firmware/deckhand_display/usage.ino
git commit -m "USAGE shows the freshest quota reading and says which Mac it is from

Both Macs poll the same account, so the two readings agree and the useful
difference is AGE - which also makes them each other's staleness backup.
The tag goes in the label row: the +88 row's clear box already had to move
off the border, and nothing on a card may end past +101."
```

---

### Task 8: Session rows and the detail screen say which Mac

**Files:**
- Modify: `firmware/deckhand_display/sessions.ino` — `buildSessionSubline` (~22), `drawSessionRow` (~112-195), `rowSigCache` users, the detail card (~947)
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `rowSigCache` width (~734), `detailSigCache` width (~750)

**Interfaces:**
- Consumes: `SessionInfo.hostSlot`, `linkTag()`.
- Produces: no new API; the row tag becomes `CC/air` and the tall-row tag `CLAUDE/air`.

- [ ] **Step 1: Widen the sub-line buffer and add the Mac**

`char sub[26]` cannot hold a Mac tag on top of `CC opus-5 (main)`. Both declarations (`sessions.ino:167` and `:243`) go to 36, and `buildSessionSubline` gains the tag. **ASCII separator only** — Cozette is 0x20–0x7E, so `·` would draw as a blank box:

```cpp
void buildSessionSubline(int i, char* out, size_t n) {
  const SessionInfo& s = sessions[i];
  const char* model = s.model;
  if (strncmp(model, "claude-", 7) == 0) model += 7;
  const char* tag = strcmp(s.agent, "cx") == 0 ? "CX" : "CC";
  // Which MAC, on the same principle as which AGENT: text, never a colour or
  // an icon. "/" and not a middle dot - Cozette is ASCII 0x20-0x7E only.
  char who[12];
  const char* mac = linkTag(s.hostSlot);
  if (*mac) snprintf(who, sizeof(who), "%s/%s", tag, mac);
  else      snprintf(who, sizeof(who), "%s", tag);
  if (model[0] && s.branch[0]) snprintf(out, n, "%s %s (%s)", who, model, s.branch);
  else if (model[0]) snprintf(out, n, "%s %s", who, model);
  else if (s.branch[0]) snprintf(out, n, "%s (%s)", who, s.branch);
  else snprintf(out, n, "%s", who);
}
```

The sub-line lane runs x=48 to the row's right edge (`SESSION_ROW_X + SESSION_ROW_W` = 232), i.e. 184px = 30 characters at Cozette's 6px advance. `CC/studio opus-5 (main)` is 23. Bound it anyway, since a long branch could exceed the lane:

```cpp
    if (sub[0]) tft.drawString(fitText(sub, 184, 2), SESSION_ROW_X + 40, y + 25);
```
(apply at both draw sites; check `fitText`'s exact signature in `deckhand_display.ino` and match it).

- [ ] **Step 2: Put the Mac in the tall-row tag, and measure the lane against it**

In `drawSessionRow`, the tag is both drawn and used to bound the name lane, so it must be built **once** and both uses must read that buffer — otherwise the name overlaps it, which is exactly the 8px overlap the measured lane replaced:

```cpp
  char agentTag[24];
  {
    const char* base = strcmp(s.agent, "cx") == 0 ? "CODEX" : "CLAUDE";
    const char* mac = linkTag(s.hostSlot);
    if (*mac) snprintf(agentTag, sizeof(agentTag), "%s/%s", base, mac);
    else      snprintf(agentTag, sizeof(agentTag), "%s", base);
  }
```

Replace the `const char* agentTag = ...` line with the above, and the later draw (~193) with `tft.drawString(agentTag, SESSION_ROW_X + SESSION_ROW_W - 12, y + 8);`. `laneRight` already measures `tft.textWidth(agentTag)`, so a wider tag simply drops the name one rung down the 12x26 → 10x18 → 6x13 ladder.

- [ ] **Step 3: Put the Mac in the row's repaint signature**

A row that changes Mac (or gains a tag when the second Mac arrives) changes nothing else, so without this it keeps a stale tag forever — the standard failure of this change-only discipline. In `renderSessionsList`'s signature build, add the tag, and widen the cache from 160 to 176 in `deckhand_display.ino:734` (a 40-char title plus the rest already reached ~160; the Mac tag adds up to 8 plus a separator, and a cache shorter than its string silently stops noticing changes):

```cpp
    snprintf(sig, sizeof(sig), "%s|%s|%s|%s", s.name, s.status, sub, linkTag(s.hostSlot));
```
(keep whatever fields the existing signature has; append the tag.)

- [ ] **Step 4: Add MAC to the detail card**

In the detail card's column pairs (~947), the AGENT column gains the Mac beside it. Follow the existing `drawColValue` pattern:

```cpp
  drawColValue(RX, cy, strcmp(s.agent, "cx") == 0 ? "Codex" : "Claude Code", colW);
  // ... and in the next pair row, with its own label:
  drawColLabel(LX, cy, "MAC");
  drawColValue(LX, cy, linkTag(s.hostSlot)[0] ? linkTag(s.hostSlot) : "-", colW);
```

Widen `detailSigCache` from 352 to 368 and append the tag to the detail signature — same reason as Step 3, and the existing comment there already explains that a signature longer than its cache silently stops repainting.

- [ ] **Step 5: Compile, flash, verify on the glass**

Run:
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display && ./flash.sh --no-compile
sleep 25
echo "MULTITEST 3" > ~/.claude/deckhand-device-command
echo "TAB 1" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
sleep 25 && ls -t ~/Deckhand-shots | head -1
```
Expected in the PNG: every row carries `CC/<tag>`; on tall rows the top-right reads `CLAUDE/<tag>`; no name touches or overlaps the tag; no blank boxes anywhere (a blank box means a non-ASCII separator crept in).

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/sessions.ino firmware/deckhand_display/deckhand_display.ino
git commit -m "Say which Mac each session row lives on

Text, never colour or an icon - the same rule the CC/CX tag follows, and
an ASCII '/' because Cozette is 0x20-0x7E only. The tag is built once and
both drawn and measured from that buffer, so the name lane shrinks a rung
instead of overlapping it, and it joins both repaint signatures (with
their caches widened) or a row would keep a stale tag forever."
```

---

### Task 9: Answers are signed with, and addressed to, the owning Mac

**Files:**
- Modify: `firmware/deckhand_display/pairing.ino` — `activeSecret`, `authHmac`
- Modify: `firmware/deckhand_display/sessions.ino` — `sendLineToHost`, `sendAnswerToHost`, `sendVoiceAnswerToHost`
- Modify: `firmware/deckhand_display/keyboard.ino:537,559` and `reader.ino:165` — pass the owning link
- Modify: `firmware/deckhand_display/deckhand_display.ino:3373` — the `BATT` line stays broadcast

**Interfaces:**
- Consumes: `SessionInfo.hostSlot`, `hostLinks[].hostId`, `lineTargetsUs` on the host (Task 3).
- Produces:
  - `int pairingSlotForLink(int link)` → pairing slot in `hosts[]` for that link's hostId, or -1
  - `String authHmacFor(int pairingSlot, const String& msg)` — `authHmac(msg)` keeps its signature and delegates with `activeHost`, so no existing caller changes
  - `void sendLineToHost(const char* line, int link)` — stamps `to=<hostId>`; the one-argument form stays and broadcasts

- [ ] **Step 1: Sign with an explicit slot**

In `pairing.ino`:

```cpp
// The key for ONE pairing slot. authHmac's implicit "whoever spoke last"
// (activeHost) is wrong as soon as two Macs are ticking - it would be right
// about half the time, and the symptom is an answer intermittently rejected
// with nothing visibly broken.
const String* secretForSlot(int slot) {
  if (slot < 0 || slot >= hostCount) return nullptr;
  if (allowedHost[0] && strcmp(hosts[slot].id, allowedHost) != 0) return nullptr;
  return &hosts[slot].secret;
}
const String* activeSecret() { return secretForSlot(activeHost); }
```

Then split `authHmac` so the body takes a slot:

```cpp
String authHmacFor(int slot, const String& msg) {
  const String* key = secretForSlot(slot);
  if (!key || key->length() == 0) return String("");
  const String& pairingSecret = *key;
  // ... existing mbedtls body, unchanged ...
}
String authHmac(const String& msg) { return authHmacFor(activeHost, msg); }
```

- [ ] **Step 2: Map a link to its pairing slot**

Add to `pairing.ino`:

```cpp
// A link (a Mac that is talking to us) and a pairing slot (a Mac whose key we
// hold) are different things: an unpaired Mac can send payloads, and a paired
// Mac can be absent. -1 means "we hold no key for that Mac", and authHmacFor
// then refuses to sign - the host rejects the unsigned answer, which is the
// safe direction.
int pairingSlotForLink(int link) {
  if (link < 0 || link >= MAX_LINKS || !hostLinks[link].used) return -1;
  return findHost(hostLinks[link].hostId);
}
```

- [ ] **Step 3: Stamp the target on the line**

In `sessions.ino`, give `sendLineToHost` an optional target. `notify()` reaches both Macs, so the address is what stops the other one logging an authentication failure on every answer:

```cpp
// `link` = the Mac this line is FOR, or -1 to broadcast. Broadcast is right for
// BATT and HELLO (both menu bars want the battery) and wrong for everything
// carrying a decision: notify() has no single-peer form, so an unaddressed
// ANSWER reaches the other Mac too and it logs an auth failure - which trains
// you to ignore the line that matters.
void sendLineToHost(const char* line, int link) {
  char out[320];
  const char* to = (link >= 0 && link < MAX_LINKS && hostLinks[link].used)
                     ? hostLinks[link].hostId : "";
  if (*to) snprintf(out, sizeof(out), "%s to=%s", line, to);
  else     snprintf(out, sizeof(out), "%s", line);
  // ... existing body, chunking `out` instead of `line` ...
}
void sendLineToHost(const char* line) { sendLineToHost(line, -1); }
```

**Read the existing comment above `sendLineToHost` before touching it**: a fixed 96-byte copy buffer here once truncated a typed answer and dropped its trailing newline, which read as "typing only fails over Bluetooth". A typed answer's line reaches ~259 bytes and `to=` adds ~12, hence 320 — and if any future caller can exceed that, chunk in two passes rather than re-deriving the number.

- [ ] **Step 4: Route every session-bound line**

- `sendAnswerToHost(int idx, int optIdx)`: sign with the row's Mac and address it there.

```cpp
void sendAnswerToHost(int idx, int optIdx) {
  SessionInfo& s = sessions[idx];
  char msg[40];
  snprintf(msg, sizeof(msg), "%s:%s:%d", s.askNonce, s.askPid, optIdx);
  String mac = authHmacFor(pairingSlotForLink(s.hostSlot), String(msg));
  if (mac.length() == 0) mac = "0";
  char line[80];
  snprintf(line, sizeof(line), "ANSWER %s %s %d %s", s.id, s.askPid, optIdx, mac.c_str());
  sendLineToHost(line, s.hostSlot);
}
```

- `sendVoiceAnswerToHost(int idx)`: same two changes (`authHmacFor(pairingSlotForLink(s.hostSlot), payload)`, `sendLineToHost(line, s.hostSlot)`).
- `keyboard.ino:537` (typed answer) and `:559` (typed prompt): same two changes, taking `hostSlot` from the session the keyboard was opened against.
- `reader.ino:165` (`HISTORY`): address it to the session's Mac — only that Mac can serve the transcript.
- `deckhand_display.ino:3373` (`BATT`): leave it as the one-argument broadcast form, and say so in the comment.
- Audio: the stream header and its frames go to the target session's Mac, or the **primary** when there is no target. Add beside the audio send path:

```cpp
// USB is unambiguous (one cable), so a plugged-in Mac owns anything with no
// session to aim at; then the Mac pinned on PAIRED MACS; then the first slot.
int primaryLink() {
  for (int i = 0; i < MAX_LINKS; i++)
    if (hostLinks[i].used && usbLinkActive() && strcmp(hostLinks[i].hostId, usbHostId) == 0) return i;
  if (allowedHost[0]) { int i = linkForHost(allowedHost, false); if (i >= 0) return i; }
  for (int i = 0; i < MAX_LINKS; i++) if (hostLinks[i].used) return i;
  return -1;
}
```
(`usbHostId` is a new `char[12]` set in `handleLine` when `fromUsb`, alongside `curLink`.)

- [ ] **Step 5: Compile and flash**

Run:
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display && ./flash.sh --no-compile
```
Expected: compiles clean.

- [ ] **Step 6: Verify a real answer still authenticates**

Trigger a real permission prompt on the Mac (any command needing approval), tap **Allow** on the device, then:
```bash
grep -m1 "Remote answer:" /tmp/deckhand-$(id -u)/host.log
```
Expected: `Remote answer: <id> prompt <pid> -> [0] Allow (auth ok)` — and **no** `REJECTED` line. A rejection here means the pairing slot lookup returned -1: check `grep "PROVISION" /tmp/deckhand-$(id -u)/host.log`.

- [ ] **Step 7: Verify the address is on the wire and honoured**

Run:
```bash
grep -m1 "ANSWER .* to=" /tmp/deckhand-$(id -u)/host.log
```
Expected: the logged device line carries `to=<this Mac's hostId>`. Then confirm the negative case with a wrong address — temporarily send from the device against the synthetic host (`MULTITEST 1`, tap Allow on the synthetic row) and check that the host logs **nothing at all** for it, rather than an auth failure. That is `lineTargetsUs` doing its job.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/pairing.ino firmware/deckhand_display/sessions.ino \
        firmware/deckhand_display/keyboard.ino firmware/deckhand_display/reader.ino \
        firmware/deckhand_display/deckhand_display.ino
git commit -m "Sign an answer with the session's Mac, and address it there

authHmac's implicit activeHost means 'whoever sent the most recent
payload', which with two Macs ticking is wrong about half the time - and
the symptom is an intermittently rejected answer with nothing visibly
broken. Lines now carry to=<hostId> as well, because notify() has no
single-peer form; BATT and HELLO stay deliberately broadcast."
```

---

### Task 10: SETTINGS › STATUS shows both links

**Files:**
- Modify: `firmware/deckhand_display/settings.ino` — the STATUS page rows

**Interfaces:**
- Consumes: `hostLinks[]`, `bleLinkCount()`, `LINK_STALE_MS`.
- Produces: no new API.

- [ ] **Step 1: Replace the single Bluetooth row with a per-link view**

The existing Bluetooth/USB rows state the device's own view of the transport. With two Macs the useful fact is per-Mac: who is talking, and how long ago. Add below them, one row per used link:

```cpp
  // Per-Mac, because the footer can only carry ONE "Xs ago" and it shows the
  // freshest link - which would otherwise let a silent second Mac look live.
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    unsigned long age = (millis() - hostLinks[i].lastPayloadMillis) / 1000;
    char v[24];
    snprintf(v, sizeof(v), "%s %lus ago",
             hostLinks[i].tag[0] ? hostLinks[i].tag : hostLinks[i].hostId, age);
    drawSettingRow(y, "Mac", v);   // match the existing row helper's name/signature
    y += SETTINGS_ROW_H;
  }
```

Match the file's existing row helper and its cache discipline: if the neighbouring rows use a `drawIfChanged` cache, give these one **at least as long as the padded string** (`"studio 120s ago"` is 15 chars, so ≥20), and reset it in `resetSettingsCaches()` — `drawSettingsStatic()` resets the caches for exactly this reason, and a cache that is not reset leaves the row blank after a page repaint.

- [ ] **Step 2: Compile, flash, screenshot**

Run:
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display && ./flash.sh --no-compile
sleep 25
echo "MULTITEST 1" > ~/.claude/deckhand-device-command
echo "TAB 2" > ~/.claude/deckhand-device-command
echo "PAGE 0" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
sleep 25 && ls -t ~/Deckhand-shots | head -1
```
Expected in the PNG: two `Mac` rows — your real Mac with a small age, and `test` with a growing one. Confirm the ages advance across two screenshots and that no row is blank after paging away and back (`PAGE 1` then `PAGE 0`).

- [ ] **Step 3: Commit**

```bash
git add firmware/deckhand_display/settings.ino
git commit -m "SETTINGS shows each Mac's own last-payload age

The footer carries one 'Xs ago' and it shows the freshest link, which
would let a silent second Mac look live. Each link's own age lives here."
```

---

### Task 11: Document the multi-host model

`CLAUDE.md` is where this project's traps live, and every one of them in this feature is a silent failure. This task is the record.

**Files:**
- Modify: `CLAUDE.md` — a new bullet in the Architecture section, beside the multi-pairing bullet
- Modify: `README.md` — the user-facing "pair a second Mac" steps

**Interfaces:**
- Consumes: everything above.
- Produces: nothing executable.

- [ ] **Step 1: Write the CLAUDE.md section**

Add after the multi-pairing bullet ("**Multi-pairing: one key per (Mac, device) couple.**"). It must state, in this file's voice — the fact, then why, then what breaks if you undo it:

- **Two Macs at once, `MAX_LINKS 2` against `MAX_HOSTS 4`** — remembering a Mac and talking to one are different limits; stock libs allow 3 (`CONFIG_BTDM_CTRL_BLE_MAX_CONN`), which is why 2 needs no build-config change and 4 would sit at the ceiling.
- **Bluedroid stops advertising on connect**, so `onConnect` must re-advertise or a second Mac can never attach; a third central is refused, not queued.
- **One RX characteristic, two writers: the chunks interleave.** Framed with `conn_id` and demuxed on loopTask. Header+payload go in atomically because a partial write desyncs every following frame, where the old unframed buffer merely dropped bytes. The failure without this is silent: `handleLine` returns early on a parse error, so the screen freezes while both links, both heartbeats and both menu bars look healthy.
- **`notify()` has no single-peer form** — it loops every peer — so device→host lines carry `to=<hostId>`; absent or unparseable reads as broadcast, because wrongly dropping an answer strands a blocked prompt while logging one twice is merely noise. `BATT`/`HELLO` are deliberately unaddressed.
- **`authHmac`'s implicit `activeHost` is "whoever spoke last"** and is wrong about half the time once two Macs tick; answers sign with the row's `hostSlot`. Symptom if reverted: intermittently rejected answers with nothing visibly broken.
- **`voiceSeq` is per-link** — two host-lifetime counters against one high-water mark trip the "seq went backwards = new host generation" reset on nearly every tick, disabling the voice card continuously rather than once per restart.
- **Sessions merge into ONE 6-row pool** — per-Mac arrays are impossible (2.2KB × 6 = 13.4KB against ~26KB free heap). Each tick frees only the sending Mac's rows; ranking is an index sort, not a value sort. A quiet link's rows are dropped after `LINK_STALE_MS`, not dimmed.
- **The Mac tag is ASCII `/`, not a middle dot** — Cozette is 0x20–0x7E, and the row tag is built once so the name lane is measured against the same string that gets drawn.
- **USAGE takes the fresher reading and names its source**, and a source change repaints the chrome because no percentage moves with it — the same trap as the stale-dim flip.
- **`MULTITEST <n>`** injects a synthetic second Mac so the merge, ranking, tags and stale-drop are verifiable from one Mac; it can never answer anything, because `hostId feedfeed` matches no pairing slot.
- Record whatever Task 1 measured about MTU and per-link airtime, since that is the number a future change to the payload has to respect.

- [ ] **Step 2: Write the README steps**

Under the pairing instructions, add: install the host on the second Mac, connect the device to it **over USB once** so `PROVISION` can run (BLE `PROVISION` is ignored by design), then unplug — both Macs then hold their own key and can talk to the device over BLE at the same time. Note `DECKHAND_MAC_TAG` for naming a Mac on the device's rows.

- [ ] **Step 3: Verify the claims against the code**

Run:
```bash
grep -n "MAX_LINKS\|LINK_STALE_MS\|to=" firmware/deckhand_display/*.ino | head -20
node host/host-tag-check.mjs && node host/line-address-check.mjs
```
Expected: the constants named in the docs exist with the values written down, and both check scripts pass. A doc naming a constant that no longer exists is worse than no doc.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document the two-Mac model and its silent failure modes

Every trap in this feature fails silently - interleaved writes freeze the
screen while everything looks healthy, an unaddressed answer trains you to
ignore auth failures, and a shared voiceSeq disables the voice card
continuously. That is what this file is for."
```

---

## Self-Review

**Spec coverage:**

| spec section | task |
|---|---|
| Concurrent links, advertising, no build-config change | 4 |
| Per-connection RX demux | 4 |
| Attribution by payload `hostId` | 5 |
| Addressed device→host lines | 3 (host filter), 9 (device stamp) |
| Per-link state, `voiceSeq` | 5 |
| Merge into one 6-slot array, `order[]`, sums | 6 |
| Quiet link drops its rows | 5 (prune) + 6 (`dropSessionsForLink`) |
| Row / detail Mac tag | 8 |
| USAGE freshest reading + label | 7 |
| Answer routing, per-slot signing | 9 |
| Primary Mac for untargeted actions | 9 |
| Mac side: `to=` filter only | 3 |
| `MULTITEST` verification harness | 5 |
| Second real Mac on USB; two real centrals | 4 (step 8), 9 (step 6) |
| Risk 1: BLE airtime / MTU | 1 |
| Risk 2: link slot reuse | 4 (`bleReleaseConn`), 5 (`linkForHost` recycles stalest) |
| Risk 3: third central refused, logged | 4 |
| SETTINGS per-link age | 10 |
| Documentation | 11 |

**Corrections made against the spec while planning:**
- The spec's `CC · air` uses a middle dot, which Cozette (ASCII 0x20–0x7E) cannot draw. The shipping form is `CC/air`; recorded in Global Constraints and Task 8.
- The spec did not say where the Mac's short display name comes from. It is derived **on the Mac** (`macTag`, Task 2) and published as `hostTag`, rather than the device guessing from a hostname it stores for pairing.

**Type consistency:** `bleSlotForConn`/`bleReleaseConn`/`bleLinkCount`/`drainBleRx` (Task 4), `linkForHost`/`linkTag`/`pruneStaleLinks`/`curLink` (Task 5), `urgencyRank`/`sessionAt`/`reorderSessions`/`dropSessionsForLink`/`sessionOrder` (Task 6), `mergeUsage`/`usageSourceLink`/`cxSourceLink`/`drawCardChrome(y0,label,tag)` (Task 7), `secretForSlot`/`authHmacFor`/`pairingSlotForLink`/`sendLineToHost(line,link)`/`primaryLink`/`usbHostId` (Task 9) are used under exactly these names where they are consumed. Every one takes or returns an int slot or a `const char*`, never a struct declared after the auto-prototype point.
