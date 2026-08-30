# Wireless Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pair a Mac to board 2 over BLE without a cable, by ephemeral X25519 plus a 6-digit code derived from the shared secret — with the pairing secret never transmitted.

**Architecture:** The device opens a 120s pairing window only when a person taps PAIR NEW MAC. A Mac sends its ephemeral public key; the device replies with its own, derives the shared secret, and displays a code derived from it. The user types that code into the menu bar, which verifies it against its own derivation locally and then proves agreement to the device with an HMAC. Only then does either side store a key.

**Tech Stack:** ESP32-S3 + mbedtls (X25519, HKDF, HMAC-SHA256), node `crypto`, Swift menu bar, NimBLE.

**Spec:** `docs/superpowers/specs/2026-08-30-wireless-pairing.md` — read it before Task 1. Every security property below is argued there.

## Global Constraints

- **BOARD 1'S BINARY MUST NOT MOVE.** Board 1 gains exactly one line, `#define BOARD_HAS_WIRELESS_PAIR 0`, which emits no code. Everything else is inside `#if BOARD_HAS_WIRELESS_PAIR`. After every task: compile board 1 and run `node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1` — it must say `UNCHANGED`. Verify it a second way by resolving board 1's view of the changed files at all nine board macros and diffing; `unifdef` **silently no-ops with multiple `-D` flags**, so run it once per macro or write your own resolver, and resolving one macro leaves other arms in the view and yields a FALSE diff.
- **NEVER compile both boards concurrently** — one shared sketch build directory; they overwrite each other's objects. Board 2, check, then board 1, check.
- **THE PAIRING SECRET IS NEVER TRANSMITTED.** Not in any form, not once. If a task finds itself putting a key or shared secret on the wire, it has misread the design — stop and re-read the spec.
- **`PROVISION` over USB is unchanged**, and BLE `PROVISION` stays ignored. This is an addition.
- **Nothing pairs unless a person tapped PAIR NEW MAC.** Every wire handler this plan adds must refuse when the window is closed, and must say why on serial — from the Mac, silence and impossibility look identical.
- **Every panel string is ASCII `0x20..0x7E`.** Spleen declares nothing else.
- **Every layout constant lives in a board header**, on ONE line (`geom-common.mjs`'s parser regex has no `\n` in its class and silently yields `undefined` for a split declaration).
- **A checker must PARSE what it certifies and must be able to FAIL.** The test is not "does it pass" but "does perturbing the constant make it FAIL, and by name". Three defects of this kind were caught on the previous branch: two vacuous (a derivation asserted against its own term) and one transcribed (one board's constant hardcoded inside the other board's block).
- Board 2 today: flash **993814**, RAM **65900**. Report the delta each task.

---

### Task 1: The crypto, both sides, and a pinned vector that proves they agree

**THIS IS THE TASK THE WHOLE FEATURE RESTS ON.** Device and Mac must derive byte-identical values or pairing fails in a way that looks like a UI bug.

**THE KNOWN HAZARD, stated up front so it is designed for rather than discovered:** mbedtls represents Curve25519 points internally in a different byte order from the raw little-endian 32-byte X25519 encoding that RFC 7748 and node's `crypto` use. `mbedtls_ecp_point_write_binary` on Curve25519 does **not** necessarily give you the bytes node expects. **Do not assume either way — settle it with the vector test in Step 4 and reverse the buffer if that is what the measurement says.** This is the single most likely source of a silent interop failure.

**Files:**
- Create: `host/pair-crypto.mjs`, `host/pair-crypto-check.mjs`
- Modify: `firmware/deckhand_display/pairing.ino`, `firmware/deckhand_display/board_es3c35p.h`, `firmware/deckhand_display/board_e32r28t.h` (ONE line)

**Interfaces produced:** `deriveShared(privA, pubB)`, `deriveCode(shared, pubA, pubB)`, `deriveKey(shared, pubA, pubB)`, `pairProof(key)` on the host; `pairDeriveAll()` and `PAIRVECTOR` on the device.

- [ ] **Step 1: pin the derivations exactly, in one place, on both sides**

```
shared = X25519(priv, peerPub)                              32 bytes, raw LE per RFC 7748
salt   = pubA || pubB                                       64 bytes; A is ALWAYS the Mac's
                                                            (initiator's) key. Order is fixed and
                                                            asserted - swapping it silently breaks
                                                            interop while both sides still "work".
code   = HKDF-SHA256(ikm=shared, salt, info="deckhand-sas/1", len=4)
         -> read as uint32 big-endian, % 1000000, zero-padded to 6 characters
key    = HKDF-SHA256(ikm=shared, salt, info="deckhand-key/1", len=16)
proof  = HMAC-SHA256(key, "deckhand-pairok/1"), first 16 bytes, lowercase hex
```

The `/1` suffixes are a version marker: a future change to any derivation bumps them so an old
device and a new Mac fail cleanly instead of deriving different keys and blaming the user.

- [ ] **Step 2: the host module** — `host/pair-crypto.mjs`, pure functions, no I/O and no clock, for
the same reason `capUtf8` and `run-ledger.mjs` live in their own modules: so they can be tested.
Use `crypto.generateKeyPairSync("x25519")`, `crypto.diffieHellman`, `crypto.hkdfSync` (note it
returns an **ArrayBuffer**, not a Buffer — wrap it), `crypto.createHmac`.

- [ ] **Step 3: the device side** — in `pairing.ino` behind `#if BOARD_HAS_WIRELESS_PAIR`, using
`mbedtls_ecdh_*` with `MBEDTLS_ECP_DP_CURVE25519`, `mbedtls_hkdf` and the `mbedtls_md_hmac` this
file already uses for answer signing. Random comes from `esp_fill_random`.

- [ ] **Step 4: `PAIRVECTOR` — the instrument that makes interop a measurement**

A board-2-only command (via the trigger file) that runs a **fixed** private key against a **fixed**
peer public key and prints the shared secret, code, key and proof as hex. It exists for the reason
`TEXTPROBE`, `AUDIOPROBE` and `COLORTEST` do: without it, the first real pairing attempt is the
test, and a byte-order mismatch is indistinguishable from a UI bug.

`host/pair-crypto-check.mjs` pins the SAME vector and asserts the host's own derivation matches the
expected constants. **Run `PAIRVECTOR` on hardware and paste its output into your report**; if it
disagrees with the host, fix the byte order until it agrees, then record which way round it went and
why in a comment. A future toolchain change that alters any derivation then fails loudly.

- [ ] **Step 5: assertions.** `pair-crypto-check.mjs` must cover: the pinned vector; that two fresh
keypairs agree in both directions; that the salt order is load-bearing (swap it, get a different
key); that a one-bit change anywhere gives a different code; that the code is always exactly 6
characters including leading zeros (test a vector that produces one); and that `proof` rejects a
wrong key. Add `--selftest` injecting a fault each assertion must catch.

- [ ] **Step 6: verify and commit.** Both compiles, both baselines, board 1 `UNCHANGED`.

---

### Task 2: The device's pairing window, wire handlers and storage

**Files:** `firmware/deckhand_display/pairing.ino`, `deckhand_display.ino`, `board_es3c35p.h`

- [ ] **Step 1: the window.** `pairWindowUntil` (millis deadline), `pairPeer` (the pending
exchange: hostId, label, pubA, our keypair, derived code/key). `pairOpen()` starts a 120s window;
`pairClose(reason)` clears **every** field including the private key and the derived secret —
zeroing them, not merely marking the window shut.

- [ ] **Step 2: the handlers**, all refusing with a logged reason when the window is closed:
  - `PAIRREQ <hostId:8hex> <pubA:64hex> <label...>` — validate the hostId is 8 hex and pubA is 64
    hex **before** using either. Sanitise the label to ASCII and cap it. Generate a keypair, derive,
    store as pending, reply `PAIRPUB <pubB:64hex>`. A second `PAIRREQ` while one is pending REPLACES
    it (a lost first attempt must be recoverable) and the displayed code changes with it.
  - `PAIROK <hmac:32hex>` — recompute the proof from the pending key and compare in **constant
    time**. On match: `upsertHost(hostId, key, label)`, `saveHostSlot`, `saveHostCount`, reply
    `PAIRDONE <hostId>`, close the window. On mismatch: reply `PAIRFAIL badproof`, close the window.
  - `PAIRCANCEL` — close, reply `PAIRFAIL cancelled`.
- [ ] **Step 3: `PAIRDONE`/`PAIRFAIL` carry the trailing `to=<hostId>`** every device→host line
already uses, so the other paired Mac drops them instead of logging an auth failure.
- [ ] **Step 4:** the window closes on tab switch, on sleep, and on timeout — a device left pairing
because someone wandered off is the one state that weakens the presence guarantee.
- [ ] **Step 5:** `MAX_HOSTS` is 4 and full is full. When there is no free slot, `PAIRREQ` is refused
with `PAIRFAIL full` **before** any key is generated, and the device says so on its own screen —
silently evicting a remembered Mac to make room would destroy a key the user still wanted.
- [ ] **Step 6:** verify, both baselines, commit.

---

### Task 3: The device's pairing screen

**Files:** `firmware/deckhand_display/settings.ino`, `board_es3c35p.h`, `settings-geom-check.mjs`

- [ ] **Step 1:** a `PAIR NEW MAC` button on the Pairing group, above `ANSWER PROMPTS FROM`. It is
`uiButton` in `COLOR_ACCENT`; it does **not** need a confirm dialog (it destroys nothing) but it
must be refused with an on-screen reason when all `MAX_HOSTS` slots are full.
- [ ] **Step 2:** a full-screen pairing panel, owning the glass the way the reader does: the code in
`T_HERO` (Spleen 32x64, so 6 digits is 192px in a 320px panel — centre it and assert the fit), the
requesting Mac's label under it once a `PAIRREQ` arrives, a `Ns left` countdown, and CANCEL. Before
any request arrives it reads `waiting for a Mac` with no code, because there is nothing to show yet.
- [ ] **Step 3:** it must absorb the ~5s host tick the way the confirm dialog and reader do — parse,
`renderFooter()`, return — or the periodic repaint paints the settings page over it.
- [ ] **Step 4:** the countdown is a change-only field on its own cache, not a full repaint per
second. The code never changes within one exchange, so it is drawn once per `PAIRREQ`.
- [ ] **Step 5:** result screens — `PAIRED WITH <label>` on success, and a named failure otherwise
(`code did not match`, `no free slots`, `timed out`, `cancelled`), each dwelling ~1500ms and
**flushing BEFORE the delay** (on a shadow-buffered board the message otherwise exists for zero
frames — a defect this repo has already fixed once in the farewell screens).
- [ ] **Step 6:** assertions — the code's width at `T_HERO` fits the panel; the panel's blocks share
no pixel row; the countdown's cache is at least as long as its longest string plus NUL. Prove teeth.
- [ ] **Step 7:** verify, both baselines, commit.

---

### Task 4: The host — scan, exchange, store, report

**Files:** `host/index.mjs`

- [ ] **Step 1: commands** (intercepted host-side, like `SELECT`/`FORGET`, never forwarded):
`PAIRSCAN` (5s scan, collect every `Deckhand-XXXX` advertiser with RSSI), `PAIRSTART <name>`,
`PAIRCODE <6 digits>`, `PAIRCANCEL`.
- [ ] **Step 2: scanning must not disturb the live link.** The host normally pins its scan to
`selectedDevice`. A pairing scan lists everything, so it must not leave the scan filter or the
current connection changed when it finishes — restore whatever was there, including on failure and
on timeout. Losing the working link because someone opened a pairing menu would be worse than the
feature is worth.
- [ ] **Step 3: the exchange.** Connect to the chosen peripheral, subscribe, send `PAIRREQ` with a
fresh ephemeral keypair, await `PAIRPUB`, derive. Hold the pending exchange in memory only — **the
private key and shared secret are never written to disk**, and both are zeroed when the exchange
ends however it ends.
- [ ] **Step 4: `PAIRCODE`.** Compare the typed digits against the host's own derived code, in
constant time. Mismatch → report `code did not match` to the menu bar and **do not touch the
device**; the user may retype. Match → send `PAIROK <proof>`, await `PAIRDONE`, then write the new
entry to `deckhand-secret` via the existing `savePairing()` (which `chmod`s every write, because
`writeFile`'s `mode` only applies on creation).
- [ ] **Step 5: state in the heartbeat** — `pairing: {state, devices[], name, label, error, sec}`
where state is one of `idle|scanning|awaiting-code|verifying|done|failed`. The menu bar renders from
this and never reads the secrets file, exactly as it already does for `devices`/`selected`.
- [ ] **Step 6: every failure path names its cause** and every one closes the exchange. A pairing
that silently stops is the worst outcome here.
- [ ] **Step 7:** `node host/pair-crypto-check.mjs` and every other host checker still pass. Commit.

---

### Task 5: The menu bar

**Files:** `mac-app/DeckhandMenuBar.swift`, `mac-app/build.sh` if needed

- [ ] **Step 1:** `Pair new device…` under `Settings ▸`, enabled only when the host is running (it
cannot do anything otherwise, and this menu already dims `Device` for that reason).
- [ ] **Step 2:** it writes `PAIRSCAN`, then renders the heartbeat's `pairing.devices` as a submenu
of `Deckhand-XXXX` entries. Picking one writes `PAIRSTART <name>`.
- [ ] **Step 3:** when the heartbeat reports `awaiting-code`, show an `NSAlert` with an accessory
`NSTextField` for six digits, the device's name in the message, and Pair / Cancel. Pair writes
`PAIRCODE <digits>`; Cancel writes `PAIRCANCEL`. Reject non-digits and wrong lengths in the dialog
rather than round-tripping them.
- [ ] **Step 4:** report `done` and `failed` states, the failure naming its cause.
- [ ] **Step 5: `--pair-check`**, in the same family as `--pace-check`/`--sound-check`: drive the
state machine through idle → scanning → awaiting-code → done, and through each failure, printing
what the menu would show at each step. **A menu cannot be clicked from a script**, which is why
every other claim about this surface is made through one of these. Print the assertion count.
- [ ] **Step 6:** rebuild via `mac-app/build.sh`; remember a rebuilt bundle is **not** the running
one and the kill must match `MacOS/DeckhandMenuBar`, since `pkill -f 'MacOS/Deckhand'` also matches
the host. Commit.

---

### Task 6: End-to-end verification and the documentation

- [ ] **Step 1: pair for real, on hardware.** Flash board 2, tap PAIR NEW MAC, pair this Mac
wirelessly, and then **prove the key works** by answering a real prompt from the device — an HMAC
verified by the host is the only end-to-end proof that the derived key is the same one both sides
hold. Paste the host log lines. If board 2 is not attached, say so plainly and mark this UNVERIFIED
rather than implying it was done.
- [ ] **Step 2:** re-run `PAIRVECTOR` on the final firmware and confirm it still matches the pinned
host vector.
- [ ] **Step 3:** every checker and `--selftest`, `geom-sweep.mjs`, both compiles, both baselines.
Board 1 `UNCHANGED`; report board 2's delta against 993814 / 65900.
- [ ] **Step 4: CLAUDE.md.** A new subsection under the pairing notes covering: what the cable
actually provided (presence, not the wire) and why this is an equal replacement rather than a
relaxation; the exchange; why the device never receives a guess at the code; that `PROVISION` is
unchanged and BLE `PROVISION` is still ignored; the byte-order finding from Task 1 with which way
round it went; and `PAIRVECTOR` in the command list. State plainly what is not verified.
- [ ] **Step 5:** commit.
