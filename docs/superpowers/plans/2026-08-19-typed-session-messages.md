# Typed Messages To A READY Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a session at READY be sent a typed message from the device — detail screen → TYPE A MESSAGE → keyboard → SEND — delivered by the same mechanism a dictation aimed at a session already uses.

**Architecture:** The mic half of this path exists; this adds the keyboard half. The device signs a new `PROMPT` frame against a per-session nonce (today's nonces are keyed by an ask's pid, which a READY session has none of), the host verifies it, re-checks the session is still READY, and hands the text to the existing delivery — clipboard+notification by default, `claude -p --resume` under `DECKHAND_VOICE_DELIVERY=dispatch`. The delivery block is extracted first so the mic and keyboard cannot drift.

**Tech Stack:** ESP32/Arduino (`.ino`, TFT_eSPI, Cozette), Node 20+ ESM host, HMAC-SHA256 via mbedtls on-device and `node:crypto` on the Mac.

**Spec:** `docs/superpowers/specs/2026-08-19-typed-session-messages-design.md`

## Global Constraints

- **Delivery follows `DECKHAND_VOICE_DELIVERY`** (default `clipboard`); never a second switch.
- **READY only** — `status === "waiting"`. Enforced on BOTH sides; the device's gate is never the only gate.
- **150-byte cap**, reusing `ANSWER_TEXT_MAX_BYTES` from `host/voice-answer.mjs`. Cap **before** hashing, in BYTES, via `capUtf8`.
- **The signed label is `PROMPT`**, distinct from `TEXT` (voice answer) and `TYPED` (typed answer), so no signature crosses forms.
- **The nonce is single-use** and published **only** while a session is `waiting`.
- **Arduino: no function signature may name `SessionInfo`, `HostPairing`, `Theme`, `Usage` or `ConfirmAction`** — those types are declared below the auto-prototype insertion point. Pass `int idx` and look the session up inside.
- **Change-only redraw discipline**: new fields go through `drawIfChanged` with a cache at least as long as the padded string; a colour-only change must bust the text cache.
- **Colour is never the only carrier of meaning.**
- **`claude-hooks/deckhand-session-hook.mjs` must never write to stdout** — untouched by this plan, but do not add logging there.
- There is **no test framework**. Verification is standalone `*-check.mjs` scripts plus compile/flash/screenshot.

---

### Task 1: Testable id12 → session-id resolution

The voice path resolves the device's 12-character id with
`files.find((f) => f.endsWith(".json") && f.startsWith(target))`, which silently
takes the first of several matches. Extract it, make ambiguity an explicit
failure, and give it a check.

**Files:**
- Create: `host/session-lookup.mjs`
- Create: `host/session-lookup-check.mjs`
- Modify: `host/index.mjs` (the resolution inside `transcribeAndDispatch`, ~line 1703)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveSessionId(filenames: string[], id12: string) -> { ok: true, id: string } | { ok: false, reason: "empty" | "none" | "ambiguous" }`

- [ ] **Step 1: Write the failing check**

```js
// host/session-lookup-check.mjs
import { resolveSessionId } from "./session-lookup.mjs";

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const files = ["abc123456789-aaaa-bbbb.json", "def123456789-cccc.json", "notes.txt"];
check("exact 12-char prefix resolves", resolveSessionId(files, "abc123456789"),
      { ok: true, id: "abc123456789-aaaa-bbbb" });
check("no match is reported, not guessed", resolveSessionId(files, "999999999999"),
      { ok: false, reason: "none" });
check("empty id is rejected", resolveSessionId(files, ""), { ok: false, reason: "empty" });
// The bug this module exists for: two records sharing a prefix must NOT silently
// pick the first. 12 hex chars make this vanishingly unlikely, and "unlikely" is
// not a reason to dispatch a message into whichever session sorted first.
check("ambiguous prefix is refused",
      resolveSessionId(["abc123456789-one.json", "abc123456789-two.json"], "abc123456789"),
      { ok: false, reason: "ambiguous" });
check("non-json files are ignored", resolveSessionId(["abc123456789.txt"], "abc123456789"),
      { ok: false, reason: "none" });
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to see it fail**

Run: `node host/session-lookup-check.mjs`
Expected: FAIL — `Cannot find module './session-lookup.mjs'`

- [ ] **Step 3: Write the module**

```js
// host/session-lookup.mjs
// The device only ever knows a session's first 12 characters - that is all the
// payload carries, and all it can send back. Resolving that to a real id is its
// own module so it can be tested: the inline version this replaced used
// `files.find(startsWith)`, which takes the FIRST of several matches, and a
// message dispatched into whichever session happened to sort first is the worst
// shape of bug available here. Ambiguity is refused instead.
export function resolveSessionId(filenames, id12) {
  if (!id12) return { ok: false, reason: "empty" };
  const ids = filenames
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((id) => id.startsWith(id12));
  if (ids.length === 0) return { ok: false, reason: "none" };
  if (ids.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, id: ids[0] };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node host/session-lookup-check.mjs`
Expected: 5 PASS, exit 0

- [ ] **Step 5: Use it in the voice path**

In `host/index.mjs`, inside `transcribeAndDispatch`, replace the `files.find(...)`
block with `resolveSessionId`, keeping the existing `cwd` read and error copy:

```js
    const files = await fs.readdir(SESSIONS_DIR);
    const found = resolveSessionId(files, target);
    if (!found.ok) {
      console.error(`Voice: ${found.reason} session for ${target} - transcript not dispatched.`);
      setVoice("error", { text, reply: `no matching session (${found.reason})` });
      return;
    }
    sessionId = found.id;
    try {
      cwd = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, `${sessionId}.json`), "utf8")).cwd || undefined;
    } catch {}
```

Add the import at the top: `import { resolveSessionId } from "./session-lookup.mjs";`

- [ ] **Step 6: Confirm the host still starts and dictation is unaffected**

Run: `node --check host/index.mjs && node host/session-lookup-check.mjs`
Expected: syntax OK, 5 PASS. Then restart the host
(`./host/deckhand-service.sh stop && ./host/deckhand-service.sh start`) and confirm
`/tmp/deckhand-$(id -u)/host.log` reaches a `5h=` tick line with no new errors.

- [ ] **Step 7: Commit**

```bash
git add host/session-lookup.mjs host/session-lookup-check.mjs host/index.mjs
git commit -m "Refuse an ambiguous session id instead of taking the first"
```

---

### Task 2: The PROMPT signature, and proof it cannot be crossed with an answer

**Files:**
- Modify: `host/typed-answer.mjs`
- Modify: `host/typed-answer-check.mjs`

**Interfaces:**
- Consumes: `ANSWER_TEXT_MAX_BYTES`, `capUtf8`, `voiceSha` from `host/voice-answer.mjs`; `typedTextOk`, `decodeTypedText` already in this file.
- Produces:
  - `promptHmac(secret: string, nonce: string, id12: string, sha16: string) -> string` (16 hex chars)
  - `verifyPrompt({ secret, nonce, id12, b64, mac }) -> { ok: true, text: string } | { ok: false, reason: string }`

- [ ] **Step 1: Write the failing checks**

Append to `host/typed-answer-check.mjs`:

```js
// ---- PROMPT form: typed text sent to a READY session ----
import { promptHmac, verifyPrompt } from "./typed-answer.mjs";
import { typedAnswerHmac } from "./typed-answer.mjs";
import { voiceSha } from "./voice-answer.mjs";

{
  const secret = "00112233445566778899aabbccddeeff";
  const nonce = "feedfacecafebeef";
  const id12 = "abc123456789";
  const text = "run the failing tests and summarise what broke";
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const good = promptHmac(secret, nonce, id12, voiceSha(text));

  check("PROMPT: a correct frame verifies",
        verifyPrompt({ secret, nonce, id12, b64, mac: good }).ok, true);
  check("PROMPT: tampered text fails",
        verifyPrompt({ secret, nonce, id12, b64: Buffer.from(text + "!", "utf8").toString("base64"), mac: good }).ok, false);
  check("PROMPT: tampered mac fails",
        verifyPrompt({ secret, nonce, id12, b64, mac: "0".repeat(16) }).ok, false);
  check("PROMPT: a nonce from another session fails",
        verifyPrompt({ secret, nonce: "0123456789abcdef", id12, b64, mac: good }).ok, false);
  check("PROMPT: another session's id fails",
        verifyPrompt({ secret, nonce, id12: "def123456789", b64, mac: good }).ok, false);
  check("PROMPT: non-ASCII text is refused before any hashing",
        verifyPrompt({ secret, nonce, id12, b64: Buffer.from("héllo", "utf8").toString("base64"), mac: good }).ok, false);
  check("PROMPT: over the cap is refused",
        verifyPrompt({ secret, nonce, id12, b64: Buffer.from("x".repeat(151), "utf8").toString("base64"), mac: good }).ok, false);

  // THE CROSS-FORM CHECK, and the reason the label is in the signed string at
  // all: a signature minted to answer a question must not be able to send a
  // message that starts work.
  const answerMac = typedAnswerHmac(secret, nonce, id12, voiceSha(text));
  check("PROMPT: a TYPED answer signature does not authenticate a PROMPT",
        verifyPrompt({ secret, nonce, id12, b64, mac: answerMac }).ok, false);
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `node host/typed-answer-check.mjs`
Expected: FAIL — `promptHmac` is not exported.

- [ ] **Step 3: Implement both functions**

In `host/typed-answer.mjs`:

```js
// The signed string carries the LABEL, so the three text-bearing forms cannot be
// interchanged: "<nonce>:<pid>:TEXT:<sha>" is a voice answer, ":TYPED:" a typed
// answer, and ":PROMPT:" a message sent to a READY session. Same key, same nonce
// shape, different meaning - and answering a question must never authenticate
// starting work.
export function promptHmac(secret, nonce, id12, sha16) {
  return crypto
    .createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${nonce}:${id12}:PROMPT:${sha16}`)
    .digest("hex")
    .slice(0, 16);
}

export function verifyPrompt({ secret, nonce, id12, b64, mac }) {
  if (!secret || !nonce || !id12 || !b64 || !mac) return { ok: false, reason: "missing field" };
  const decoded = decodeTypedText(b64);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const want = promptHmac(secret, nonce, id12, voiceSha(decoded.text));
  // timingSafeEqual needs equal lengths; a wrong-length mac is already a reject.
  if (mac.length !== want.length) return { ok: false, reason: "bad mac" };
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want)))
    return { ok: false, reason: "bad mac" };
  return { ok: true, text: decoded.text };
}
```

Confirm `crypto`, `decodeTypedText` and `voiceSha` are already imported/defined in
this module; add only what is missing.

- [ ] **Step 4: Run it to see it pass**

Run: `node host/typed-answer-check.mjs && node host/voice-answer-check.mjs`
Expected: every check PASS, exit 0 for both.

- [ ] **Step 5: Commit**

```bash
git add host/typed-answer.mjs host/typed-answer-check.mjs
git commit -m "Sign a PROMPT with its own label so no answer can authenticate one"
```

---

### Task 3: Per-session nonce, published only while READY

**Files:**
- Modify: `host/index.mjs` (nonce map beside `askNonces`/`nonceForPid` ~line 468; payload item build ~line 1351)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `nonceForSession(fullId: string) -> string` (16 hex chars, stable while the session stays READY)
  - `consumeSessionNonce(fullId: string) -> void`
  - payload field `item.pnonce`, present **only** when `item.status === "waiting"`

- [ ] **Step 1: Add the map and its accessors**

Beside `nonceForPid`, mirroring its pruning and its `seen`/`first` discipline:

```js
// Nonces for typed messages to a READY session. askNonces cannot serve this: it
// is keyed by an ask's PID, and a READY session has no pending prompt and so no
// pid. Keyed by the FULL session id (the payload's id is truncated to 12).
const promptNonces = new Map();
function nonceForSession(id) {
  let e = promptNonces.get(id);
  if (!e) {
    e = { nonce: crypto.randomBytes(8).toString("hex"), seen: Date.now() };
    promptNonces.set(id, e);
  } else {
    e.seen = Date.now();
  }
  return e.nonce;
}
// Single use: a captured frame must not be able to re-run the same instruction.
function consumeSessionNonce(id) {
  promptNonces.delete(id);
}
```

- [ ] **Step 2: Prune it wherever `askNonces` is pruned**

Find `pruneNonces()` and delete `promptNonces` entries whose `seen` is older than
the same window, so a session that stops being READY does not leave a usable
credential behind.

- [ ] **Step 3: Publish it, but only for READY**

In the payload item build (next to the `if (record.ask)` block):

```js
        // A nonce for a typed message, present ONLY while this session is READY.
        // Omitted otherwise so the device is never holding a credential for a
        // state in which it must not offer typing - the same reason ask.voice is
        // set per-prompt rather than read from a live global.
        if (item.status === "waiting") item.pnonce = nonceForSession(record.id);
```

Use whatever the record's full-id property is named at that point in the file
(the same value `transcriptById` is keyed off before truncation) — read the
surrounding lines and match it exactly.

- [ ] **Step 4: Verify by observation, not assertion**

```bash
# a READY session must carry pnonce
printf '{"session_id":"pnoncetest","cwd":"%s","status":"waiting","updated_at":%s000}\n' "$HOME" "$(date +%s)" \
  > ~/.claude/deckhand-sessions/pnoncetest.json
sleep 8
grep -a '5h=' /tmp/deckhand-$(id -u)/host.log | tail -1 | grep -o 'pnoncetest[^}]*' | head -1
# then flip it to working and confirm pnonce disappears
python3 - <<'PY'
import json, os, time
p = os.path.expanduser("~/.claude/deckhand-sessions/pnoncetest.json")
d = json.load(open(p)); d["status"] = "working"; d["updated_at"] = int(time.time() * 1000)
json.dump(d, open(p, "w"))
PY
sleep 8
grep -a '5h=' /tmp/deckhand-$(id -u)/host.log | tail -1 | grep -o 'pnoncetest[^}]*' | head -1
rm -f ~/.claude/deckhand-sessions/pnoncetest.json
```

Expected: the first line contains `"pnonce":"<16 hex>"`; the second does not.
Delete the fake session file afterwards — leaving it behind puts a phantom row on
the device for up to 20 minutes.

- [ ] **Step 5: Commit**

```bash
git add host/index.mjs
git commit -m "Issue a per-session nonce, and only while the session is READY"
```

---

### Task 4: The host's PROMPT branch

**Files:**
- Modify: `host/index.mjs` (`handleDeviceLine`, beside the existing `ANSWER` handling ~line 2204)

**Interfaces:**
- Consumes: `verifyPrompt` (Task 2), `resolveSessionId` (Task 1), `nonceForSession`/`consumeSessionNonce` (Task 3), the existing `deviceNameFor(via)`, `deviceEntry(name).secret`, `VOICE_DELIVERY`, `copyToClipboard`, `notify`, `projectName`, `setVoice`, `CLAUDE_BIN`.
- Produces: `async function handleTypedPrompt(line, via)`, plus a `PROMPT ` branch in `handleDeviceLine` that delegates to it.

- [ ] **Step 1: Add the branch**

```js
  // PROMPT <id12> <base64text> <hmac> - a typed message aimed at a READY session.
  // Distinct from ANSWER: nothing is waiting on it, there is no pid, and it is
  // signed against a per-session nonce with the PROMPT label.
  if (line.startsWith("PROMPT ")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) {
      console.error("Prompt: malformed frame - ignored.");
      return;
    }
    const [, id12, b64, mac] = parts;
    let record = null;
    try {
      const files = await fs.readdir(SESSIONS_DIR);
      const found = resolveSessionId(files, id12);
      if (!found.ok) {
        console.error(`Prompt: ${found.reason} session for ${id12} - refused.`);
        return;
      }
      record = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, `${found.id}.json`), "utf8"));
      record.id = found.id;
    } catch (err) {
      console.error(`Prompt: could not read the session record - refused (${err.message}).`);
      return;
    }
    // RE-CHECK READY HERE. The device gates the button on status too, but a gate
    // that exists only on the device is not a gate: this is the same reason
    // handleVoiceAnswer re-reads the record before writing an answer file. A
    // missing or non-waiting status must reject, never fall through.
    if (record.status !== "waiting") {
      console.error(`Prompt: ${id12} is "${record.status}", not waiting - refused.`);
      return;
    }
    const device = deviceNameFor(via);
    // deviceEntry() is how every other authenticated path resolves a key - one
    // key per (Mac, device) couple, so forgetting one revokes only that pair.
    const secret = deviceEntry(device)?.secret;
    const nonce = promptNonces.get(record.id)?.nonce;
    if (!secret || !nonce) {
      console.error(`Prompt: no ${secret ? "nonce" : "key"} for ${device || "unknown device"} - refused.`);
      return;
    }
    const v = verifyPrompt({ secret, nonce, id12, b64, mac });
    if (!v.ok) {
      console.error(`Prompt: rejected from ${device} - ${v.reason}.`);
      return;
    }
    consumeSessionNonce(record.id);
    console.log(`Prompt: accepted ${v.text.length} chars for ${id12} from ${device}.`);
    await deliverTextToSession(id12, v.text);
    return;
  }
```

Follow the file's own shape: the `TYPED` form is a one-line branch delegating to
`handleTypedAnswer(parts, via)`, so put this body in
`async function handleTypedPrompt(line, via)` and keep the branch to a
`startsWith` test plus the call. `deviceEntry(name)?.secret` is how
`handleTypedAnswer` gets its key (`expectedHmac` uses the same accessor); do not
introduce a second way to reach a pairing key.

- [ ] **Step 2: Extract the delivery so the mic and the keyboard share one path**

Pull the block in `transcribeAndDispatch` that runs *after* the text exists —
resolve, clipboard-or-dispatch, `setVoice` — into a top-level
`async function deliverTextToSession(target, text)`, and call it from both places.
Behaviour must not change for dictation: same log lines, same `setVoice` states
(`clip` / `sent` / `error`), same detached `execFile` with
`stdio: ["ignore", "pipe", "pipe"]` and the default permission mode.

- [ ] **Step 3: Verify no dictation regression**

Run: `node --check host/index.mjs`, restart the host, then trigger a one-shot
capture (`echo "MICREC" > ~/.claude/deckhand-device-command`), speak, and confirm
the log still reports the same delivery line and the device still raises its voice
card. A `PROMPT` frame cannot be tested from the Mac alone — the device is the only
thing that can sign one, so end-to-end proof lands in Task 7.

- [ ] **Step 4: Commit**

```bash
git add host/index.mjs
git commit -m "Accept a signed PROMPT, and re-check READY on the host"
```

---

### Task 5: The device learns the nonce

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`SessionInfo` ~line 668; the session parse ~line 2576)

**Interfaces:**
- Consumes: payload field `pnonce` (Task 3).
- Produces: `SessionInfo.promptNonce` (`char[20]`), empty when absent.

- [ ] **Step 1: Add the field**

Beside `askNonce`, with the same width so `copyField` cannot truncate a
comparison later:

```cpp
  char promptNonce[20]; // host-issued, single-use; present only while READY
```

Do **not** add it to `PrevSession`: that struct carries only the nine fields the
tick diff reads, and this is not one of them.

- [ ] **Step 2: Parse it**

Where `askNonce` is cleared and copied, mirror it for the top-level `pnonce` key
(it is a sibling of `status`, not a member of `ask`):

```cpp
      info.promptNonce[0] = '\0';
      if (s["pnonce"].is<const char*>())
        copyField(info.promptNonce, sizeof(info.promptNonce), s["pnonce"]);
```

- [ ] **Step 3: Compile**

Run: `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
Expected: builds; RAM grows by ~120 bytes (20 × 6 slots).

- [ ] **Step 4: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "Carry the per-session nonce onto the device"
```

---

### Task 6: TYPE A MESSAGE on a plain READY detail screen

**Files:**
- Modify: `firmware/deckhand_display/sessions.ino` (`drawSessionDetail` ~line 815; the detail touch handler)

**Interfaces:**
- Consumes: `SessionInfo.status`, `SessionInfo.promptNonce`, `uiButton`, `contentBottom()`, `CARD_X`, `CARD_W`.
- Produces:
  - `bool msgOffered(int idx)` — true when this session may be typed to
  - `int msgButtonY()` — the button's top edge, used by BOTH the draw and the hit test

- [ ] **Step 1: Add the two helpers**

```cpp
// A READY session can be sent a typed message. Gated on the NONCE as well as the
// status: without one the host would refuse the frame anyway, so offering the
// button would be advertising a control that cannot work - the same rule the
// read-only ask path follows when it draws options as a flat list instead.
bool msgOffered(int idx) {
  if (idx < 0 || idx >= sessionCount) return false;
  const SessionInfo& s = sessions[idx];
  return strcmp(s.status, "waiting") == 0 && s.promptNonce[0] && !s.askTitle[0];
}
// One source for the geometry, so the button and its hit test cannot drift - the
// same reason askInputRows() is shared between askOptionsTop() and the draw.
int msgButtonY() { return contentBottom() - ASK_OPT_H; }
```

- [ ] **Step 2: Draw it**

At the end of `drawSessionDetail(idx)`, in the band an ask's option stack would
occupy (empty on a plain detail screen):

```cpp
  if (msgOffered(idx))
    uiButton(CARD_X, msgButtonY(), CARD_W, ASK_OPT_H, "TYPE A MESSAGE",
             COLOR_ACCENT, false, COLOR_BG);
```

Outlined, not filled: it starts something, and the filled treatment is reserved
for the primary action on the screen you land on next (SEND).

- [ ] **Step 3: Hit-test it**

In the detail-screen touch path — **after** the FAB check (which must stay first)
and before the "any other tap is inert" fallthrough:

```cpp
    if (msgOffered(detailIndex) && sy >= msgButtonY() && sy < msgButtonY() + ASK_OPT_H) {
      openKeyboardForMessage(detailIndex);
      return;
    }
```

- [ ] **Step 4: Add the detail signature field**

`buildDetailSignature` must include whether the button is showing, or a session
that becomes READY while you are looking at it will never grow one. Append
`msgOffered(idx) ? "M" : "-"` to the signature string and confirm
`detailSigCache` is still longer than the result.

- [ ] **Step 5: Compile, flash, screenshot**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display
./flash.sh --no-compile
printf '{"session_id":"msgdemo","cwd":"%s","status":"waiting","updated_at":%s000}\n' "$HOME/projects/deckhand" "$(date +%s)" \
  > ~/.claude/deckhand-sessions/msgdemo.json
```

Then open that session's detail screen and capture it
(`echo "SCREENSHOT" > ~/.claude/deckhand-device-command`). Expected: the button
appears on the READY row's detail screen and **not** on a WORKING one. Remove
`msgdemo.json` afterwards.

- [ ] **Step 6: Commit**

```bash
git add firmware/deckhand_display/sessions.ino
git commit -m "Offer TYPE A MESSAGE on a plain READY detail screen"
```

---

### Task 7: Keyboard prompt mode, and the signed send

**Files:**
- Modify: `firmware/deckhand_display/keyboard.ino`
- Modify: `firmware/deckhand_display/deckhand_display.ino` (keyboard globals; the `kbActive` tick absorber ~line 2708; `KBTEST`)

**Interfaces:**
- Consumes: `msgOffered(int)` (Task 6), `SessionInfo.promptNonce` (Task 5), `sha256Hex16`, `authHmac`, `kbBase64`, `sendLineToHost`.
- Produces:
  - `void openKeyboardForMessage(int idx)`
  - `bool kbIsMessage()` — true while the keyboard is in prompt mode
  - `void sendPromptToHost()`
  - `KBTEST msg` opens prompt mode against the first READY session

- [ ] **Step 1: Add the mode and pin the session by id**

New globals beside the existing keyboard state:

```cpp
// Prompt mode: the keyboard is composing a MESSAGE to a READY session rather than
// an answer to a pending ask. Nothing is waiting on it, so there is no countdown
// and no ask to peek - and it pins the session ID, because there is no askPid.
bool kbMessageMode = false;
char kbSessionId[16] = "";
```

```cpp
bool kbIsMessage() { return kbMessageMode; }

void openKeyboardForMessage(int idx) {
  openKeyboard(idx);          // resets text, shift, peek and repeat state
  kbMessageMode = true;
  kbPid[0] = '\0';            // no pending prompt to pin to
  copyField(kbSessionId, sizeof(kbSessionId), sessions[idx].id);
  drawKeyboard();             // repaint: the placeholder and meta row now differ
}
```

`openKeyboard` must set `kbMessageMode = false` so an answer can never inherit the
mode, and `closeKeyboard` must clear both new globals.

- [ ] **Step 2: Placeholder, no countdown, no peek**

In `drawKbText`, the countdown is drawn only when `!kbIsMessage()`. The empty-box
placeholder becomes the session's name:

```cpp
    if (kbIsMessage()) {
      char line[KB_COLS + 1];
      char label[40];
      snprintf(label, sizeof(label), "Message %s",
               (kbSessionIdx >= 0 && kbSessionIdx < sessionCount) ? sessions[kbSessionIdx].name : "session");
      fitText(line, sizeof(line), label, CARD_W - 12);
      /* draw `line` at KB_LINE0_Y in COLOR_VALUE, exactly as the ask title is */
    }
```

Make `kbHasDetail()` return false in message mode, which suppresses both the
"tap here to read it" hint and the peek — no control is advertised that does
nothing, and the detail screen you came from already shows the context.

- [ ] **Step 3: Track the window by session id in message mode**

The `kbActive` tick absorber matches `sessions[i].askPid` against `kbPid`. In
message mode match `sessions[i].id` against `kbSessionId` **and** require
`msgOffered(i)`, so leaving READY withholds SEND exactly the way an expired ask
does — keeping the typed text and explaining why:

```cpp
    if (kbActive) {
      int idx = -1;
      for (int i = 0; i < sessionCount; i++) {
        bool hit = kbIsMessage() ? (strcmp(sessions[i].id, kbSessionId) == 0 && msgOffered(i))
                                 : (strcmp(sessions[i].askPid, kbPid) == 0);
        if (hit) { idx = i; break; }
      }
      /* ...unchanged from here: kbSessionIdx = idx; gone/kbWindowClosed; drawKbText(); return; */
    }
```

The withheld-SEND copy in `drawKbActions` reads `WINDOW CLOSED - ANSWER ON YOUR
MAC` for an ask; in message mode it must read `NO LONGER READY` instead. Re-measure
the wrapped line count for the new string at the same lane width and update the
`lines` constant beside it — that comment says to.

- [ ] **Step 4: Send it**

```cpp
void sendPromptToHost() {
  if (kbLen == 0 || kbWindowClosed || !kbIsMessage()) return;
  int idx = kbSessionIdx;
  if (idx < 0 || idx >= sessionCount) return;
  // Sign the HASH of exactly the bytes on screen, with the PROMPT label - so this
  // signature cannot answer a question and an answer's cannot send a message.
  String sha = sha256Hex16(kbText);
  String mac = authHmac(String(sessions[idx].promptNonce) + ":" + kbSessionId + ":PROMPT:" + sha);
  if (mac.length() == 0) mac = "0";   // unprovisioned: let the host log a refusal
  char b64[204];
  kbBase64(b64, sizeof(b64));
  char line[280];
  snprintf(line, sizeof(line), "PROMPT %s %s %s", kbSessionId, b64, mac.c_str());
  sendLineToHost(line);
  closeKeyboard();
}
```

Route SEND to it in `kbTouch`: `if (kbIsMessage()) sendPromptToHost(); else sendTypedAnswerToHost();`

- [ ] **Step 5: Extend KBTEST**

Add a `msg` argument that finds the first session with `msgOffered(i)` and calls
`switchTab(TAB_SESSIONS)`, `openSessionDetail(i)`, `openKeyboardForMessage(i)`.
`KBTEST type <text>` must keep working on top of it, so the caret, counter and live
SEND can be captured in message mode too.

- [ ] **Step 6: Compile, flash, and capture the three screens**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display
./flash.sh --no-compile
printf '{"session_id":"msgdemo","cwd":"%s","status":"waiting","updated_at":%s000}\n' "$HOME/projects/deckhand" "$(date +%s)" \
  > ~/.claude/deckhand-sessions/msgdemo.json
sleep 8
C=~/.claude/deckhand-device-command
echo "KBTEST msg" > $C; sleep 4; echo "SCREENSHOT" > $C            # placeholder, no countdown
sleep 25
echo "KBTEST msg" > $C; sleep 3
echo "KBTEST type check the test suite" > $C; sleep 4; echo "SCREENSHOT" > $C   # caret + live SEND
```

Expected: `Message deckhand` as the placeholder, a byte counter with **no**
countdown beside it, no "tap here to read it" hint, and SEND filled once text
exists.

- [ ] **Step 7: End-to-end — the only proof the signature interoperates**

With `msgdemo.json` still in place, type a short message on the device by hand and
tap SEND. Expected in `/tmp/deckhand-$(id -u)/host.log`:

```
Prompt: accepted <n> chars for msgdemo from Deckhand-XXXX
Voice: copied to the clipboard for deckhand (msgdemo...) - paste it there
```

and the text on the Mac's clipboard (`pbpaste`). Then verify the two refusals:
flip `msgdemo.json` to `"status":"working"` and confirm a send is refused with
`is "working", not waiting`; and send twice without an intervening tick to confirm
the second is refused for a missing nonce. Remove `msgdemo.json` afterwards.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/keyboard.ino firmware/deckhand_display/deckhand_display.ino
git commit -m "Type a message to a READY session and sign it"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `AGENTS.md`

- [ ] **Step 1: CLAUDE.md**

Add to the typed-answer section, in that file's voice — what was measured and what
is load-bearing, not a feature tour. Cover: there is no injection into a live
session so this is clipboard-or-headless-resume and the default hands you text to
paste; READY only and **why** (no concurrent author); the host re-checks status
because a device-only gate is not a gate; the `PROMPT` label's role in keeping the
three text forms apart; the per-session nonce and why `askNonces` could not serve;
and that `resolveSessionId` refuses ambiguity where the old inline lookup took the
first match.

- [ ] **Step 2: README.md**

Two or three sentences in the remote-answering area: what the button does, and
plainly that with the default delivery SEND copies to your Mac rather than running
anything, with the env var named.

- [ ] **Step 3: Re-sync AGENTS.md**

```bash
python3 -c "
h=open('CLAUDE.md').read(); a=open('AGENTS.md').read()
open('AGENTS.md','w').write(a[:a.index('## Commands')]+h[h.index('## Commands'):])"
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md AGENTS.md
git commit -m "Document typed messages to a READY session"
```

---

## Self-review

**Spec coverage:** delivery via `DECKHAND_VOICE_DELIVERY` → Task 4 Step 2; READY-only on both sides → Tasks 6 (device) and 4 (host); 150-byte cap reused → Task 2 (checks assert 151 fails); `PROMPT` label distinct → Task 2 cross-form check; per-session nonce published only while waiting → Task 3; single-use → Task 4 (`consumeSessionNonce`) and Task 7 Step 7; entry point → Task 6; prompt mode with no countdown and no peek → Task 7 Steps 2–3; text kept when the window closes → Task 7 Step 3; result card → free via `setVoice` in the shared delivery; id12 exact-match → Task 1; verification screens and host checks → Tasks 6–7; risks documented → Task 8.

**Placeholders:** none — every code step carries the code, and the two "match the
real name in this file" instructions name the exact function to read
(`deviceNameFor`/`secretFor` in the `TYPED` branch, the record's id property beside
`transcriptById`).

**Type consistency:** `resolveSessionId` returns `{ok, id}`/`{ok, reason}` in Tasks
1 and 4; `verifyPrompt` returns `{ok, text}`/`{ok, reason}` in Tasks 2 and 4;
`promptNonce`/`pnonce` naming is consistent across Tasks 3, 5 and 7;
`msgOffered(int)`/`msgButtonY()` are used in Tasks 6 and 7 with the same
signatures; no function signature names a late-declared type.
