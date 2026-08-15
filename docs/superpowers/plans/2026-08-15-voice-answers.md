# Voice Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pending `AskUserQuestion` be answered by speaking to the device, with the spoken text shown and confirmed before it is authorised.

**Architecture:** The device records with the ask's pid in the stream header. The host transcribes and publishes the text back on the ask object instead of dispatching it. The device displays it and, on a confirm tap, signs a hash of exactly that text. The host verifies the hash against the transcript it still holds, then writes the answer file with the transcript as `label` — which the hook already carries to Claude verbatim.

**Tech Stack:** ESP32/Arduino (C++, several `.ino` files in one sketch folder), Node (host, `host/index.mjs`), whisper.cpp, HMAC-SHA256 (`mbedtls_md_hmac` on device, `node:crypto` on host).

**Spec:** `docs/superpowers/specs/2026-08-15-voice-answers-design.md`

## Global Constraints

- **Questions only.** `ask.kind === "question"`. Plans and permission prompts must NOT offer the SPEAK control. A spoken answer to a plan is silently discarded by `emitDecision` (both plan branches send a fixed string); a spoken answer to a permission prompt can only be delivered as a DENY.
- **The confirm tap IS the authorisation.** The device signs `HMAC(secret, "nonce:pid:TEXT:<sha16>")[:16]` over a hash of the exact text it displayed. Never sign at record time.
- **The host must verify, in this order:** HMAC valid → `sha16` matches the transcript it holds for that pid → nonce not yet consumed. Any failure logs and drops.
- **Answer recordings cap at 20s** (`MIC_ANSWER_MAX_MS`), against `MIC_STREAM_MAX_MS` of 120000 for a normal dictation. The whole exchange must fit inside the hook's `REMOTE_WAIT_MS` of 90s.
- **Transcript cap is 200 chars** (`VOICE_TEXT_MAX`), and the sha is over the **capped** string — the text displayed and the text hashed must be byte-identical.
- **`claude-hooks/deckhand-session-hook.mjs` must NOT be modified.** Its stdout is a decision channel; a stray byte auto-allows or auto-denies. The existing `chose = answer.label || ...` already carries free text for a question.
- The firmware is several `.ino` files concatenated into ONE translation unit. A function whose **signature** names `HostPairing`, `Theme`, `Usage`, `SessionInfo` or `ConfirmAction` must live in `deckhand_display.ino` (generated prototypes are inserted above those declarations).
- **No `delay()` in `loop()`**, and no clear-then-redraw of a large area — every field redraws only when its value changes (`drawIfChanged`).
- Build: `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
- Flash: `PORT=$(ls /dev/cu.usbserial-* | head -1)` then `arduino-cli upload -p "$PORT" --fqbn "esp32:esp32:esp32:UploadSpeed=115200,FlashMode=dio,FlashFreq=80,PartitionScheme=huge_app" firmware/deckhand_display`
- **Never open a second serial connection.** Use `~/.claude/deckhand-device-command`. The host must be stopped before flashing and restarted after (`open host/DeckhandBLE.app --args "$PWD/host/index.mjs"`), then verified to be a singleton with `pgrep -f 'MacOS/Deckhand' | wc -l`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `host/voice-answer.mjs` | **New.** Pure functions: hash a transcript, build/verify the answer HMAC. No I/O, so it is unit-testable without hardware. | create |
| `host/voice-answer-check.mjs` | **New.** Runnable checks over the above, including the tamper and replay cases. | create |
| `host/index.mjs` | Route an `answer=` capture to transcription-for-answer, hold the pending text, publish it on the ask, accept the `TEXT` answer form | modify |
| `firmware/deckhand_display/audio.ino` | `micStream` carries `answer=<pid>` and caps at 20s | modify |
| `firmware/deckhand_display/sessions.ino` | SPEAK control, confirm screen, signed send | modify |
| `firmware/deckhand_display/deckhand_display.ino` | Parse `voiceText`/`voiceSha` onto the ask; `micAnswerPid` state | modify |
| `CLAUDE.md` / `AGENTS.md` | Document the flow and its traps | modify |

---

### Task 1: Host — the crypto, as pure functions with real tests

This is the security-critical part and the only piece testable without hardware. It is first so everything after it builds on something proven.

**Files:**
- Create: `host/voice-answer.mjs`
- Create: `host/voice-answer-check.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `voiceSha(text) -> string` — sha256 hex, first 16 chars
  - `voiceAnswerHmac(secret, nonce, pid, sha16) -> string` — HMAC-SHA256 hex, first 16 chars, over `` `${nonce}:${pid}:TEXT:${sha16}` ``
  - `verifyVoiceAnswer({ secret, nonce, pid, sha16, mac, text }) -> { ok: boolean, why: string }`

- [ ] **Step 1: Write the failing checks**

Create `host/voice-answer-check.mjs`:

```js
#!/usr/bin/env node
// Checks for the voice-answer crypto. Run: node host/voice-answer-check.mjs
// Deliberately covers the REJECT cases, not just the happy path: this is the
// code that decides whether a spoken answer is allowed to reach Claude.
import { voiceSha, voiceAnswerHmac, verifyVoiceAnswer } from "./voice-answer.mjs";

let failed = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}`); failed++; }
};

const secret = "0123456789abcdef0123456789abcdef";
const nonce = "a1b2c3d4e5f60718";
const pid = "54321";
const text = "use the second approach, but keep the existing tests";
const sha = voiceSha(text);
const mac = voiceAnswerHmac(secret, nonce, pid, sha);

check("a valid answer is accepted",
  verifyVoiceAnswer({ secret, nonce, pid, sha16: sha, mac, text }).ok);

check("tampered TEXT is rejected (sha no longer matches)",
  !verifyVoiceAnswer({ secret, nonce, pid, sha16: sha, mac, text: text + " and delete the repo" }).ok);

check("a tampered SHA is rejected (hmac no longer matches)",
  !verifyVoiceAnswer({ secret, nonce, pid, sha16: voiceSha("something else"), mac, text }).ok);

check("a wrong nonce is rejected",
  !verifyVoiceAnswer({ secret, nonce: "ffffffffffffffff", pid, sha16: sha, mac, text }).ok);

check("a wrong pid is rejected",
  !verifyVoiceAnswer({ secret, nonce, pid: "99999", sha16: sha, mac, text }).ok);

check("a different device's secret is rejected",
  !verifyVoiceAnswer({ secret: "ffffffffffffffffffffffffffffffff", nonce, pid, sha16: sha, mac, text }).ok);

check("a missing mac is rejected",
  !verifyVoiceAnswer({ secret, nonce, pid, sha16: sha, mac: "", text }).ok);

check("a mac of the wrong length is rejected without throwing",
  !verifyVoiceAnswer({ secret, nonce, pid, sha16: sha, mac: "abc", text }).ok);

check("the sha is over the EXACT string (trailing space matters)",
  voiceSha(text) !== voiceSha(text + " "));

check("hmac is 16 hex chars", /^[0-9a-f]{16}$/.test(mac));
check("sha is 16 hex chars", /^[0-9a-f]{16}$/.test(sha));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/yujia/projects/deckhand && node host/voice-answer-check.mjs
```

Expected: FAIL — `Cannot find module './voice-answer.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `host/voice-answer.mjs`:

```js
// Voice-answer crypto, kept as pure functions so it can be tested without a
// device. The device signs a hash of the text it DISPLAYED, so one signature
// proves two things: the paired device authorised this, and this is the text a
// human actually read. See docs/superpowers/specs/2026-08-15-voice-answers-design.md.
import crypto from "node:crypto";

// 16 hex chars is 64 bits. This is an integrity check against a transcript
// being swapped between display and confirmation - not a password - and it
// travels in a line the device also HMACs, so a collision would have to survive
// both.
export function voiceSha(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

export function voiceAnswerHmac(secret, nonce, pid, sha16) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${nonce}:${pid}:TEXT:${sha16}`)
    .digest("hex")
    .slice(0, 16);
}

// Returns a reason as well as a verdict: a rejected answer must be logged with
// WHY, because the difference between "wrong device" and "text was altered" is
// the difference between a misconfiguration and an attack.
export function verifyVoiceAnswer({ secret, nonce, pid, sha16, mac, text }) {
  if (!secret || !nonce || !pid) return { ok: false, why: "missing pairing/nonce state" };
  if (typeof mac !== "string" || !/^[0-9a-f]{16}$/.test(mac)) return { ok: false, why: "malformed mac" };
  if (typeof sha16 !== "string" || !/^[0-9a-f]{16}$/.test(sha16)) return { ok: false, why: "malformed sha" };

  // The text must hash to what was signed. This is what stops a transcript
  // being altered between the device showing it and the answer being written.
  if (voiceSha(text) !== sha16) return { ok: false, why: "text does not match the signed hash" };

  const want = voiceAnswerHmac(secret, nonce, pid, sha16);
  // Equal lengths are guaranteed by the regex above, so timingSafeEqual cannot throw.
  const ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  return ok ? { ok: true, why: "" } : { ok: false, why: "bad hmac" };
}
```

- [ ] **Step 4: Run the checks**

```bash
cd /Users/yujia/projects/deckhand && node host/voice-answer-check.mjs
```

Expected: every line `ok`, then `all checks passed`, exit 0.

- [ ] **Step 5: Prove the checks have teeth**

A checker that cannot fail is not a check. Break it deliberately and confirm it notices:

```bash
cd /Users/yujia/projects/deckhand
cp host/voice-answer.mjs /tmp/va-backup.mjs
# make verification always succeed
sed -i '' 's/return ok ? { ok: true, why: "" } : { ok: false, why: "bad hmac" };/return { ok: true, why: "" };/' host/voice-answer.mjs
node host/voice-answer-check.mjs; echo "exit=$?"
cp /tmp/va-backup.mjs host/voice-answer.mjs
node host/voice-answer-check.mjs > /dev/null && echo "restored and passing"
```

Expected: the tampered version FAILS several checks and exits 1; the restored version passes.

- [ ] **Step 6: Commit**

```bash
git add host/voice-answer.mjs host/voice-answer-check.mjs
git commit -m "Add voice-answer crypto as pure, tested functions

The device signs a hash of the text it displayed, so one signature proves both
that the paired device authorised the answer and that this is the text a human
read. Kept free of I/O so it can be tested without hardware, and the checks
cover the reject cases - tampered text, tampered hash, wrong nonce, wrong pid,
wrong device, malformed mac - because this is the code that decides whether a
spoken answer reaches Claude."
```

---

### Task 2: Host — route an `answer=` capture to transcription-for-answer

**Files:**
- Modify: `host/index.mjs`

**Interfaces:**
- Consumes: `voiceSha` from `host/voice-answer.mjs`.
- Produces:
  - `pendingVoiceAnswers` — `Map<pid, { text, sha, at }>`
  - `transcribeForAnswer(captureFile, pid)` — async, stores the pending answer and calls `setVoice`
  - The ask object published to the device gains `voiceText` and `voiceSha` when a pending answer exists for that pid.

- [ ] **Step 1: Import the helpers and add the pending store**

Near the other imports in `host/index.mjs`:

```js
import { voiceSha, verifyVoiceAnswer } from "./voice-answer.mjs";
```

Next to `const askNonces = new Map();`:

```js
// A transcript waiting for the human to confirm it on the device. Keyed by the
// ask's pid, so a second dictation for the same prompt simply replaces the
// first. Pruned with the nonces - once a prompt is gone, so is any text for it.
const pendingVoiceAnswers = new Map(); // pid -> { text, sha, at }
```

- [ ] **Step 2: Parse `answer=` from the stream header**

Find the `AUDIO stream ` branch in `handleDeviceLine` (it currently reads `const tm = line.match(/target=(\S+)/);`). Add alongside it:

```js
        const am = line.match(/answer=(\S+)/);
        audioStream = {
          header: line,
          target: tm ? tm[1] : "-",
          answerPid: am && am[1] !== "-" ? am[1] : "",
          chunks: [], expectSeq: 0, gaps: 0, started: Date.now(),
        };
```

Keep every other field exactly as it is; only `answerPid` is added.

- [ ] **Step 3: Branch in `finishAudioStream`**

Replace the dispatch line at the end of `finishAudioStream`:

```js
  transcribeAndDispatch(file, st.target).catch((e) => console.error("Voice:", e.message));
```

with:

```js
  // An answer capture never dispatches: its text has to be confirmed on the
  // device before it is allowed to become a decision.
  if (st.answerPid) {
    transcribeForAnswer(file, st.answerPid).catch((e) => console.error("Voice answer:", e.message));
  } else {
    transcribeAndDispatch(file, st.target).catch((e) => console.error("Voice:", e.message));
  }
```

- [ ] **Step 4: Add `transcribeForAnswer`**

Immediately after `transcribeAndDispatch`, add:

```js
// Same decode-and-transcribe as a dictation, but the result is PARKED for
// confirmation rather than delivered. Nothing here writes an answer file - the
// device has to sign the text first.
async function transcribeForAnswer(captureFile, pid) {
  const wav = path.join(AUDIO_DIR, "latest.wav");
  const clean = path.join(AUDIO_DIR, "latest-clean.wav");
  try {
    await execFileAsync(process.execPath, [path.join(__dirname, "mic-wav.mjs"), captureFile, wav]);
  } catch (err) {
    // mic-wav.mjs refuses a capture under 98% complete, because a truncated one
    // transcribes as confident nonsense - exactly what must not become an answer.
    console.error(`Voice answer: decode failed (truncated capture?): ${err.message.split("\n")[0]}`);
    setVoice("askerror", { reply: "capture incomplete - record again" });
    return;
  }
  let text = "";
  try {
    const args = ["-m", WHISPER_MODEL, "-f", clean, "-nt"];
    if (WHISPER_PROMPT) args.push("--prompt", WHISPER_PROMPT, "--carry-initial-prompt");
    const { stdout } = await execFileAsync(WHISPER_BIN, args, { maxBuffer: 4 * 1024 * 1024 });
    text = stdout.replace(/\s+/g, " ").trim();
  } catch (err) {
    console.error(`Voice answer: whisper failed: ${err.message.split("\n")[0]}`);
    setVoice("askerror", { reply: "transcription failed" });
    return;
  }
  if (!text) {
    setVoice("askerror", { reply: "nothing recognised - record again" });
    return;
  }
  // Cap FIRST, then hash: the device displays the capped string, so that is the
  // string that must be signed. Hashing before capping would sign text the human
  // never saw.
  text = text.slice(0, VOICE_TEXT_MAX);
  pendingVoiceAnswers.set(pid, { text, sha: voiceSha(text), at: Date.now() });
  console.log(`Voice answer: pid=${pid} transcript = "${text}"`);
  setVoice("askheard", { text });
}
```

- [ ] **Step 5: Publish the pending text on the ask**

Find where the ask is attached to a session in the payload:

```js
      if (record.ask) item.ask = { ...record.ask, nonce: nonceForPid(record.ask.pid) };
```

Replace with:

```js
      if (record.ask) {
        item.ask = { ...record.ask, nonce: nonceForPid(record.ask.pid) };
        // Only questions can be answered by voice: emitDecision carries free
        // text for a question and discards it for a plan, and a spoken answer to
        // a permission prompt could only ever be a DENY.
        item.ask.voice = record.ask.kind === "question";
        const pend = pendingVoiceAnswers.get(record.ask.pid);
        if (pend) {
          item.ask.voiceText = pend.text;
          item.ask.voiceSha = pend.sha;
        }
      }
```

- [ ] **Step 6: Prune pending answers with the nonces**

In `pruneNonces()`, add the same sweep so a finished prompt does not leave a transcript behind:

```js
  for (const [pid, e] of pendingVoiceAnswers) {
    if (Date.now() - e.at > 5 * 60_000) pendingVoiceAnswers.delete(pid);
  }
```

- [ ] **Step 7: Verify it parses and the payload shape is right**

```bash
cd /Users/yujia/projects/deckhand
node --check host/index.mjs && echo "parses"
node -e '
const m = "AUDIO stream rate=16000 codec=ima4 chunk=1024 scale=8 dc=1894 target=abc123 answer=54321";
console.log("  target:", (m.match(/target=(\S+)/)||[])[1]);
console.log("  answer:", (m.match(/answer=(\S+)/)||[])[1]);
const n = "AUDIO stream rate=16000 codec=ima4 chunk=1024 scale=8 dc=1894 target=- answer=-";
const am = n.match(/answer=(\S+)/);
console.log("  a plain dictation yields answerPid:", JSON.stringify(am && am[1] !== "-" ? am[1] : ""));
'
```

Expected: `parses`, `target: abc123`, `answer: 54321`, and an empty `answerPid` for the `-` case.

- [ ] **Step 8: Commit**

```bash
git add host/index.mjs
git commit -m "Route an answer= capture to transcription-for-confirmation

A capture tagged with an ask's pid is transcribed and PARKED rather than
dispatched: its text has to be confirmed on the device before it can become a
decision. The transcript is capped before it is hashed, because the device
displays the capped string and that is the string that must be signed - hashing
first would sign text the human never saw.

The ask published to the device gains voice/voiceText/voiceSha, with voice true
only for a question: emitDecision carries free text for a question and discards
it for a plan."
```

---

### Task 3: Host — accept the `TEXT` answer form

**Files:**
- Modify: `host/index.mjs`

**Interfaces:**
- Consumes: `verifyVoiceAnswer` (Task 1), `pendingVoiceAnswers` (Task 2).
- Produces: an answer file `{ pid, idx: 0, label: <transcript>, voice: true, written_at }`.

- [ ] **Step 1: Branch the ANSWER parser**

In `handleDeviceLine`, the ANSWER handling currently starts:

```js
  const parts = line.trim().split(/\s+/); // ANSWER <id12> <pid> <idx> <hmac>
  if (parts.length < 4) return;
  const [, id12, pid, idxStr, mac] = parts;
  const idx = parseInt(idxStr, 10);
  if (!Number.isInteger(idx) || idx < 0) return;
```

Insert a voice branch immediately before that, so the option path is untouched:

```js
  const parts = line.trim().split(/\s+/);
  // Voice form: ANSWER <id12> <pid> TEXT <sha16> <hmac>. Checked before the
  // option form so the two parsers never see each other's shape.
  if (parts[3] === "TEXT") {
    await handleVoiceAnswer(parts, via);
    return;
  }
```

- [ ] **Step 2: Add `handleVoiceAnswer`**

Add above `handleDeviceLine`:

```js
// A confirmed spoken answer. The device signs a hash of the text it DISPLAYED,
// so verifying here proves both that the paired device authorised it and that
// the text is the one a human read.
async function handleVoiceAnswer(parts, via) {
  const [, id12, pid, , sha16, mac] = parts;
  const entry = askNonces.get(pid);
  const from = deviceNameFor(via);
  const dev = from ? pairedDevices.find((d) => d.name === from) : null;
  const pend = pendingVoiceAnswers.get(pid);

  if (!pend) {
    console.error(`Voice answer: no pending transcript for prompt ${pid} - ignoring.`);
    return;
  }
  const v = verifyVoiceAnswer({
    secret: dev?.secret, nonce: entry?.nonce, pid, sha16, mac, text: pend.text,
  });
  if (!v.ok) {
    // Loud on purpose: "text does not match the signed hash" is the tamper case
    // and must not look like an ordinary rejection.
    console.error(
      `Voice answer REJECTED (${v.why}) for prompt ${pid} via ${via}` +
        `${from ? ` from ${from}` : " (unknown device)"} - ignoring.`
    );
    return;
  }
  askNonces.delete(pid);          // single-use, as with an option answer
  pendingVoiceAnswers.delete(pid);

  try {
    const files = await fs.readdir(SESSIONS_DIR);
    const file = files.find((f) => f.endsWith(".json") && f.startsWith(id12));
    if (!file) {
      console.error(`Voice answer: no session matching ${id12}`);
      return;
    }
    const sessionId = path.basename(file, ".json");
    await fs.mkdir(ANSWERS_DIR, { recursive: true });
    // idx 0 and the transcript as `label`: emitDecision builds its message from
    // `answer.label || \`option ${idx+1}\``, so the spoken text flows through the
    // existing question path untouched. The hook is NOT modified.
    await fs.writeFile(
      path.join(ANSWERS_DIR, `${sessionId}.json`),
      JSON.stringify({ pid, idx: 0, label: pend.text, voice: true, written_at: Date.now() })
    );
    console.log(`Voice answer accepted for ${sessionId} (pid ${pid}): "${pend.text}"`);
    setVoice("asksent", { text: pend.text, reply: "sent to Claude" });
  } catch (err) {
    console.error(`Voice answer: could not write answer file: ${err.message}`);
  }
}
```

- [ ] **Step 3: Verify the parser split, and that an option answer is unaffected**

```bash
cd /Users/yujia/projects/deckhand
node --check host/index.mjs && echo "parses"
node -e '
const split = (l) => l.trim().split(/\s+/);
const opt = split("ANSWER d0faf000-48e 12345 2 abcdef0123456789");
const voi = split("ANSWER d0faf000-48e 12345 TEXT a1b2c3d4e5f60718 abcdef0123456789");
console.log("  option form routed to voice?", opt[3] === "TEXT");
console.log("  voice  form routed to voice?", voi[3] === "TEXT");
'
```

Expected: option `false`, voice `true`.

- [ ] **Step 4: End-to-end check of the crypto against the host helpers**

```bash
cd /Users/yujia/projects/deckhand
node -e '
import("./host/voice-answer.mjs").then(({ voiceSha, voiceAnswerHmac, verifyVoiceAnswer }) => {
  const secret="0123456789abcdef0123456789abcdef", nonce="a1b2c3d4e5f60718", pid="12345";
  const text="use the second approach";
  const sha=voiceSha(text), mac=voiceAnswerHmac(secret,nonce,pid,sha);
  const line=`ANSWER d0faf000-48e ${pid} TEXT ${sha} ${mac}`;
  const p=line.split(/\s+/);
  console.log("  line:", line);
  console.log("  accepted:", verifyVoiceAnswer({secret,nonce,pid,sha16:p[4],mac:p[5],text}).ok);
  console.log("  with altered text:", verifyVoiceAnswer({secret,nonce,pid,sha16:p[4],mac:p[5],text:text+"!"}).ok);
});
'
```

Expected: `accepted: true`, `with altered text: false`.

- [ ] **Step 5: Commit**

```bash
git add host/index.mjs
git commit -m "Accept the TEXT answer form, verified against the held transcript

The voice form is routed before the option parser so the two never see each
other's shape, and an un-upgraded host still rejects it outright (TEXT is not an
integer, so parseInt gives NaN).

The answer file carries idx 0 with the transcript as label, because emitDecision
builds its message from answer.label - the spoken text flows through the
existing question path with no change to the hook, whose stdout is a decision
channel.

A sha mismatch is logged as its own reason: the difference between a wrong
device and altered text is the difference between a misconfiguration and an
attack."
```

---

### Task 4: Firmware — SPEAK on the ask screen, tagged and capped

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino`
- Modify: `firmware/deckhand_display/audio.ino`
- Modify: `firmware/deckhand_display/sessions.ino`

**Interfaces:**
- Consumes: the host publishes `ask.voice` (bool), `ask.voiceText`, `ask.voiceSha`.
- Produces:
  - `char micAnswerPid[24]` — set before a recording started from an ask, `""` otherwise
  - `SessionInfo` gains `bool askVoice; char askVoiceText[204]; char askVoiceSha[20];`
  - `const unsigned long MIC_ANSWER_MAX_MS = 20000UL;`

- [ ] **Step 1: Add the state and the cap**

In `deckhand_display.ino`, next to `MIC_STREAM_MAX_MS`:

```c
// An ANSWER recording is capped far shorter than a dictation. The hook blocks
// for REMOTE_WAIT_MS (90s) and that is the whole budget for record + transfer +
// transcribe + read + confirm; 20s of speech is far more than an answer needs.
const unsigned long MIC_ANSWER_MAX_MS = 20000UL;
char micAnswerPid[24] = "";   // non-empty => this capture answers that prompt
```

In the `SessionInfo` struct, add:

```c
  bool askVoice;              // this ask may be answered by voice (question only)
  char askVoiceText[204];     // transcript awaiting confirmation ("" = none)
  char askVoiceSha[20];       // hash of exactly the text above
```

- [ ] **Step 2: Parse the new ask fields**

In `handleLine`, where the ask object is read onto a `SessionInfo`, add alongside the existing fields:

```c
      s.askVoice = a["voice"] | false;
      strncpy(s.askVoiceText, a["voiceText"] | "", sizeof(s.askVoiceText) - 1);
      s.askVoiceText[sizeof(s.askVoiceText) - 1] = '\0';
      strncpy(s.askVoiceSha, a["voiceSha"] | "", sizeof(s.askVoiceSha) - 1);
      s.askVoiceSha[sizeof(s.askVoiceSha) - 1] = '\0';
      // Control bytes would corrupt the line we later HMAC, and the sha must be
      // over exactly what is displayed.
      for (char* p = s.askVoiceText; *p; p++) if ((uint8_t) *p < 0x20) *p = ' ';
```

- [ ] **Step 3: Carry the pid in the stream header and honour the cap**

In `audio.ino`, the header currently reads:

```c
  Serial.printf("AUDIO stream rate=%d codec=ima4 chunk=%d scale=8 dc=%d target=%s\n",
```

Extend it to carry the answer pid, and use the shorter cap when one is set. Change the header line to:

```c
  Serial.printf("AUDIO stream rate=%d codec=ima4 chunk=%d scale=8 dc=%d target=%s answer=%s\n",
```

adding `micAnswerPid[0] ? micAnswerPid : "-"` as the final argument, and replace the loop bound:

```c
  while (millis() - start < MIC_STREAM_MAX_MS) {
```

with:

```c
  // 20s for an answer, 120s for a dictation - see MIC_ANSWER_MAX_MS.
  const unsigned long cap = micAnswerPid[0] ? MIC_ANSWER_MAX_MS : MIC_STREAM_MAX_MS;
  while (millis() - start < cap) {
```

- [ ] **Step 4: Add the SPEAK control to the ask screen**

In `sessions.ino`'s `drawAskDetail`, after the option buttons are drawn, add:

```c
  // Voice is offered only where free text is actually delivered: a question.
  // A plan's answer text is discarded by the hook and a permission prompt can
  // only be denied, so neither gets this control.
  if (s.askVoice && s.askAnswerable && !s.askVoiceText[0]) {
    uiButton(CARD_X, ASK_SPEAK_Y, CARD_W, H_BTN, "SPEAK YOUR ANSWER", COLOR_ACCENT);
  }
```

with, near the other ask layout constants:

```c
const int ASK_SPEAK_Y = CONTENT_Y + 250;   // under the option buttons
```

- [ ] **Step 5: Start an answer recording on tap**

In `handleAskTouch`, before the option hit-testing:

```c
  if (s.askVoice && s.askAnswerable && !s.askVoiceText[0] &&
      sy >= ASK_SPEAK_Y && sy < ASK_SPEAK_Y + H_BTN) {
    strncpy(micAnswerPid, s.askPid, sizeof(micAnswerPid) - 1);
    micAnswerPid[sizeof(micAnswerPid) - 1] = '\0';
    micStream();                 // capped at 20s because micAnswerPid is set
    micAnswerPid[0] = '\0';      // one capture only; never leaks into a dictation
    return true;
  }
```

- [ ] **Step 6: Compile**

```bash
cd /Users/yujia/projects/deckhand
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display 2>&1 | grep -E 'Sketch uses|Global variables|error'
```

Expected: compiles. RAM grows by roughly `6 sessions x 224 bytes` ≈ 1.3KB for the new `SessionInfo` fields.

- [ ] **Step 7: Flash and confirm the header carries the pid**

Stop the host, flash, restart the host (see Global Constraints), then trigger a question prompt and tap SPEAK. In `/tmp/deckhand-host.log`:

```bash
grep 'AUDIO stream' /tmp/deckhand-host.log | tail -1
```

Expected: the line ends `target=<id12> answer=<pid>` with a real pid, not `-`.

- [ ] **Step 8: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino firmware/deckhand_display/audio.ino firmware/deckhand_display/sessions.ino
git commit -m "Offer SPEAK on a question ask, tagged with the pid and capped at 20s

The control appears only for a question that is answerable - a plan's spoken
text is discarded by the hook and a permission prompt could only be denied, so
neither offers it.

micAnswerPid both tags the stream header and selects the shorter cap: the hook
blocks for 90s and that is the entire budget for record, transfer, transcribe,
read and confirm. It is cleared immediately after the capture so it can never
leak into an ordinary dictation."
```

---

### Task 5: Firmware — the confirm screen and the signed send

**Files:**
- Modify: `firmware/deckhand_display/sessions.ino`

**Interfaces:**
- Consumes: `s.askVoiceText`, `s.askVoiceSha`, `s.askPid`, `s.askNonce`, `authHmac()`, `sendLineToHost()`.
- Produces: nothing consumed later.

- [ ] **Step 1: Draw the confirm screen**

In `drawAskDetail`, before the option buttons, add an early branch:

```c
  // A transcript is waiting: the screen becomes a confirmation, because the
  // confirm tap IS the authorisation - it signs a hash of exactly this text.
  if (s.askVoiceText[0]) {
    setUIFont(T_META);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("YOU SAID", CARD_X, CONTENT_Y + 6);
    // Cozette on a panel: this is verbatim quoted text, the same treatment code
    // and commands already get.
    int lines = countWrappedLines(s.askVoiceText, FONT_CODE, CARD_W - 8);
    if (lines > 6) lines = 6;
    uiFillRound(CARD_X - 4, CONTENT_Y + 22, CARD_W + 8, lines * 13 + 12, R_SM, COLOR_CARD, COLOR_BG);
    drawWrappedText(s.askVoiceText, CARD_X, CONTENT_Y + 28, FONT_CODE, 13, CARD_W - 8,
                    0, lines, COLOR_VALUE, COLOR_CARD);
    uiButton(CARD_X, ASK_VOICE_SEND_Y, CARD_W, H_BTN, "SEND", COLOR_ACCENT, true);
    uiButton(CARD_X, ASK_VOICE_REDO_Y, (CARD_W - SP_2) / 2, H_BTN, "RE-RECORD", COLOR_LABEL);
    uiButton(CARD_X + (CARD_W + SP_2) / 2, ASK_VOICE_REDO_Y, (CARD_W - SP_2) / 2, H_BTN,
             "CANCEL", COLOR_LABEL);
    return;
  }
```

with, near `ASK_SPEAK_Y`:

```c
const int ASK_VOICE_SEND_Y = CONTENT_Y + 190;
const int ASK_VOICE_REDO_Y = ASK_VOICE_SEND_Y + H_BTN + SP_2;
```

- [ ] **Step 2: Handle its taps**

At the top of `handleAskTouch`:

```c
  if (s.askVoiceText[0]) {
    if (sy >= ASK_VOICE_SEND_Y && sy < ASK_VOICE_SEND_Y + H_BTN) {
      sendVoiceAnswerToHost(idx);
      return true;
    }
    if (sy >= ASK_VOICE_REDO_Y && sy < ASK_VOICE_REDO_Y + H_BTN) {
      if (sx < CARD_X + CARD_W / 2) {          // RE-RECORD
        strncpy(micAnswerPid, s.askPid, sizeof(micAnswerPid) - 1);
        micAnswerPid[sizeof(micAnswerPid) - 1] = '\0';
        micStream();
        micAnswerPid[0] = '\0';
      } else {                                  // CANCEL
        s.askVoiceText[0] = '\0';               // back to the option buttons
        drawAskDetail(idx);
      }
      return true;
    }
    return true;   // the confirm screen is modal: swallow every other tap
  }
```

- [ ] **Step 3: Add the signed send**

Next to `sendAnswerToHost`:

```c
// Signs a hash of the text the screen is SHOWING, not the audio and not an
// index. That single signature carries both facts the host needs: the paired
// device authorised this, and this is the text a human read.
void sendVoiceAnswerToHost(int idx) {
  const SessionInfo& s = sessions[idx];
  if (!s.askVoiceSha[0]) return;
  String payload = String(s.askNonce) + ":" + s.askPid + ":TEXT:" + s.askVoiceSha;
  String mac = authHmac(payload);
  // "0" when unprovisioned, matching sendAnswerToHost. Deliberately NOT a silent
  // return: the host logs the rejection, so an unpaired device shows up as a
  // refused answer in the log rather than a SEND button that quietly does
  // nothing.
  if (mac.length() == 0) mac = "0";
  char line[160];
  snprintf(line, sizeof(line), "ANSWER %s %s TEXT %s %s",
           s.id, s.askPid, s.askVoiceSha, mac.c_str());
  sendLineToHost(line);
}
```

- [ ] **Step 4: Handle the ask vanishing mid-confirm**

The Mac usually wins the race. In `handleLine`, where a session's ask is cleared because the payload no longer carries one, the confirm screen must not be left up. Where `showingDetail` is refreshed, add:

```c
      // The prompt was answered elsewhere (usually on the Mac, which is the
      // common case - the hook bails as soon as the ask disappears). Close the
      // confirm screen rather than leaving a SEND button that can do nothing.
      if (showingDetail && detailIndex == i && !sessions[i].askPid[0] &&
          sessions[i].askVoiceText[0]) {
        sessions[i].askVoiceText[0] = '\0';
        closeSessionDetail();
      }
```

- [ ] **Step 5: Compile and flash**

```bash
cd /Users/yujia/projects/deckhand
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display 2>&1 | grep -E 'Sketch uses|error'
```

Then stop the host, flash, restart the host, and confirm a singleton (see Global Constraints).

- [ ] **Step 6: Test the whole path against a real prompt**

Trigger an `AskUserQuestion` from a Claude Code session, then on the device:

1. Open the session, tap **SPEAK YOUR ANSWER**, say something distinctive.
2. Confirm the transcript shown is what you said.
3. Tap **SEND**.

Check the host log:

```bash
grep -E 'Voice answer' /tmp/deckhand-host.log | tail -3
```

Expected: `Voice answer: pid=... transcript = "..."` then `Voice answer accepted for <session>`.

Then check Claude received it — the tool result should quote the spoken text.

- [ ] **Step 7: Test the reject path**

Confirm a tampered answer is refused. With a pending transcript on screen, send a hand-made line with a wrong hash:

```bash
grep 'Voice answer REJECTED' /tmp/deckhand-host.log | tail -2
```

There should be no rejections from normal use. To force one, temporarily change one character of `askVoiceSha` in the firmware's send, reflash, and confirm the host logs `Voice answer REJECTED (bad hmac)` and writes no answer file — then revert.

- [ ] **Step 8: Test the race**

Start a dictation for a prompt, and answer that prompt on the Mac before tapping SEND. Expected: the device closes the confirm screen by itself rather than leaving a dead SEND button.

- [ ] **Step 9: Commit**

```bash
git add firmware/deckhand_display/sessions.ino
git commit -m "Confirm a spoken answer on the device, and sign what was shown

The confirm screen signs a hash of the text it is DISPLAYING - not the audio and
not an index - so one signature tells the host both that the paired device
authorised this and that a human read these exact words. A mishearing cannot
reach Claude unseen.

The screen is modal, and it closes itself when the ask disappears: the Mac
usually wins the race, and a SEND button that can no longer do anything is worse
than no button."
```

---

### Task 6: Document the flow and its traps

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md` (generated — never hand-edited)

- [ ] **Step 1: Add the bullet to CLAUDE.md**

Insert after the existing `**A dictation is DELIVERED TO YOU...**` bullet, matching the file's dense, reason-first style:

```markdown
- **A pending QUESTION can be answered by speaking, and the confirm tap is what authorises it.**
  The device records with the ask's pid in the stream header (`answer=<pid>`), the host transcribes
  and PARKS the text rather than dispatching it, publishes it back on the ask (`voiceText`,
  `voiceSha`), and the device shows it. Tapping SEND signs
  `HMAC(secret, "nonce:pid:TEXT:<sha16>")` over a hash of **exactly the text on screen**, so one
  signature proves both that the paired device authorised the answer and that a human read those
  words. The host re-hashes the transcript it still holds and refuses a mismatch.
  Four things are load-bearing:
  - **Questions only.** `emitDecision` carries free text for a question
    (`{behavior:"deny", message: carriedAnswer}`) and DISCARDS it for a plan, where both branches
    send a fixed "keep planning" string - a spoken answer to a plan would reach Claude with none of
    what was said while the device reported success. A permission prompt can only be DENIED, so
    speaking "yes, go ahead" there would deny the call with that as the reason.
  - **The hook is NOT modified.** The answer file carries `idx: 0` with the transcript as `label`,
    and `chose = answer.label || ...` does the rest. That file's stdout is a decision channel.
  - **Cap the transcript BEFORE hashing it.** The device displays the capped string, so that is the
    string that must be signed; hashing first would sign text the human never saw.
  - **20s cap on an answer recording** (`MIC_ANSWER_MAX_MS`) against 120s for a dictation. The hook
    blocks for `REMOTE_WAIT_MS` (90s) and that is the whole budget for record, transfer, transcribe,
    read and confirm. If confirmations start landing late, shorten the cap - do NOT raise
    `REMOTE_WAIT_MS`, which is matched to the settings.json hook timeout and breaks silently if
    raised alone.
  `host/voice-answer-check.mjs` covers the reject cases (tampered text, tampered hash, wrong nonce,
  wrong pid, wrong device, malformed mac) and can be run without hardware.
```

- [ ] **Step 2: Regenerate AGENTS.md and prove it matches**

```bash
cd /Users/yujia/projects/deckhand
{ head -n 11 AGENTS.md; tail -n +4 CLAUDE.md; } > AGENTS.md.new && mv AGENTS.md.new AGENTS.md
diff <(tail -n +12 AGENTS.md) <(tail -n +4 CLAUDE.md) && echo "IN SYNC"
```

Expected: `IN SYNC`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "Document voice answers and the four traps in the path"
```

---

## Verification Summary

| Layer | Check | Where |
|---|---|---|
| Crypto | valid / tampered text / tampered hash / wrong nonce / wrong pid / wrong device / malformed mac | Task 1 Step 4 |
| Crypto | the checker itself can fail | Task 1 Step 5 |
| Host | stream header parses `answer=`, `-` means none | Task 2 Step 7 |
| Host | the option parser is untouched by the voice branch | Task 3 Step 3 |
| Build | compiles; RAM grows ~1.3KB | Task 4 Step 6 |
| Device | header carries a real pid | Task 4 Step 7 |
| End to end | speak, confirm, send, Claude receives the words | Task 5 Step 6 |
| Reject | a bad hash writes no answer file | Task 5 Step 7 |
| Race | the Mac answering first closes the confirm screen | Task 5 Step 8 |
| Docs | `AGENTS.md` in sync | Task 6 Step 2 |

## Rollback

Tasks 1-3 are host-side and inert until the firmware sends a `TEXT` answer — an un-upgraded device simply never produces one. Backing out the feature means reverting Tasks 4-5; the host will then hold a pending transcript that nothing confirms, and prune it after five minutes.
