# Keyboard Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `AskUserQuestion` prompt be answered by typing on the device, via a full-screen QWERTY keyboard and a new authenticated `TYPED` wire form.

**Architecture:** The device gains a full-screen keyboard surface (`keyboard.ino`) reached from a TYPE control on the ask screen. Unlike the voice path — where the host holds the transcript and the device signs a hash of it — the host has no copy of typed text, so the device sends the text itself, base64-encoded, under an HMAC over its hash. The host decodes, validates it is printable ASCII within the cap, verifies the HMAC, re-checks the ask is still a pending question, and writes the same `idx: 0` + `label` answer file the voice path uses. The hook is not modified.

**Tech Stack:** Arduino/ESP32 (TFT_eSPI, mbedtls), Node 24 on the host side. No test framework in this repo — host crypto is covered by a runnable check script; firmware is verified by compile + flash + observation.

**Spec:** `docs/superpowers/specs/2026-08-15-keyboard-answers-design.md`

## Global Constraints

- **Questions only.** `ask.kind === "question"`; a typed answer to a plan would hit `emitDecision`'s `answer.idx === 0` branch and be silently APPROVED with the words discarded, and a permission prompt can only be denied.
- **Claude Code asks only.** `REMOTE_WAIT_MS` is `AGENT === "codex" ? 15_000 : 90_000`; 15s is not enough to type, so no TYPE control appears on a `cx` ask.
- **Cap is 150 bytes**, shared with the voice path (`VOICE_ANSWER_TEXT_MAX_BYTES`).
- **Never modify `claude-hooks/deckhand-session-hook.mjs`.** Its stdout is a decision channel; a stray byte auto-allows or auto-denies a real dialog.
- **The countdown is advisory only.** It must never gate whether an answer is sent.
- **Flicker-free redraw discipline:** fields repaint only when their value changes (`drawIfChanged` and per-field caches). A change-only cache must be at least as long as the padded string it stores, and a colour-only change needs an explicit cache bust.
- **Cozette is ASCII 0x20–0x7E only.** No `⇧`/`⌫`/`…` glyphs — they render as blanks. Key labels are `CAP`, `DEL`, `?123`, `ABC`, `SPACE`.
- **Arduino concatenates every `.ino` into one translation unit** (main file first, then alphabetical) and inserts auto-prototypes above the first function definition. No new function's *signature* may name `HostPairing`, `Theme`, `Usage`, `SessionInfo` or `ConfirmAction` — pass `int idx` instead.
- Build: `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`. Baseline at plan time: **flash 1357846, RAM 80724**.
- **Do not flash, and do not start/stop any host process.** The controller owns the serial port and the host lifecycle. Report `READY_TO_FLASH`.

---

## File Structure

| file | responsibility |
|---|---|
| `host/typed-answer.mjs` (new) | Pure crypto + validation for the `TYPED` form. No I/O, so it is testable without hardware. Imports `voiceSha` from `voice-answer.mjs` rather than redefining a second hash. |
| `host/voice-answer-check.mjs` (modify) | Gains the typed reject cases. Stays the single entry point so there is one command to run, not two. |
| `host/index.mjs` (modify) | `TYPED` branch in the ANSWER parser, `handleTypedAnswer`, the nonce's `first` field, and `ask.sec`. |
| `firmware/deckhand_display/keyboard.ino` (new) | The keyboard surface: layout tables, draw, touch, text buffer, send. |
| `firmware/deckhand_display/sessions.ino` (modify) | `askInputRows()` replacing `askVoiceRows()`, and the SPEAK\|TYPE row. |
| `firmware/deckhand_display/deckhand_display.ino` (modify) | Keyboard globals, `askSec` on `SessionInfo`, tick absorption, touch dispatch. |
| `firmware/deckhand_display/pairing.ino` (modify) | `sha256Hex16()` — the device must hash its own text, which the voice path never had to do. |

---

## Task 1: Typed-answer crypto and validation (host, pure)

**Files:**
- Create: `host/typed-answer.mjs`
- Modify: `host/voice-answer-check.mjs`

**Interfaces:**
- Consumes: `voiceSha(text)` from `./voice-answer.mjs`.
- Produces: `TYPED_TEXT_MAX_BYTES` (150), `typedAnswerHmac(secret, nonce, pid, sha16) -> string`, `decodeTypedText(b64) -> string|null`, `typedTextOk(text) -> boolean`, `verifyTypedAnswer({secret, nonce, pid, b64, mac}) -> {ok, why, text}`.

- [ ] **Step 1: Write the failing checks**

Append to `host/voice-answer-check.mjs`, immediately before the final `console.log(failed ? ...)` line:

```js
// ---- typed answers ----------------------------------------------------------
// The typed form carries the TEXT rather than a hash of a transcript the host
// already holds, so these cover decoding and sanitising as well as the crypto.
{
  const b64of = (s) => Buffer.from(s, "utf8").toString("base64");
  const tText = "use the second approach, but keep the existing tests";
  const tB64 = b64of(tText);
  const tMac = typedAnswerHmac(secret, nonce, pid, voiceSha(tText));

  check("a valid typed answer is accepted",
    verifyTypedAnswer({ secret, nonce, pid, b64: tB64, mac: tMac }).ok);

  check("a valid typed answer returns the decoded text",
    verifyTypedAnswer({ secret, nonce, pid, b64: tB64, mac: tMac }).text === tText);

  check("tampered typed TEXT is rejected (hmac covers its hash)",
    !verifyTypedAnswer({ secret, nonce, pid, b64: b64of(tText + " and delete the repo"), mac: tMac }).ok);

  check("a wrong nonce is rejected for a typed answer",
    !verifyTypedAnswer({ secret, nonce: "ffffffffffffffff", pid, b64: tB64, mac: tMac }).ok);

  check("a wrong pid is rejected for a typed answer",
    !verifyTypedAnswer({ secret, nonce, pid: "99999", b64: tB64, mac: tMac }).ok);

  check("a wrong device secret is rejected for a typed answer",
    !verifyTypedAnswer({ secret: "f".repeat(32), nonce, pid, b64: tB64, mac: tMac }).ok);

  check("a malformed mac is rejected for a typed answer",
    !verifyTypedAnswer({ secret, nonce, pid, b64: tB64, mac: "nothex" }).ok);

  check("malformed base64 is rejected",
    !verifyTypedAnswer({ secret, nonce, pid, b64: "not!valid!base64", mac: tMac }).ok);

  // Buffer.from(.., "base64") SILENTLY IGNORES junk, so a payload with rubbish
  // in it would otherwise decode to something plausible and be signed against.
  check("base64 with ignorable junk is rejected, not silently reinterpreted",
    decodeTypedText(tB64.slice(0, -4) + "!!!!") === null);

  // The device can only produce printable ASCII; a control byte means the frame
  // did not come from our firmware, and it is headed for a hook decision message.
  {
    const bad = "hello\x07world";   // BEL as an ESCAPE: a raw control byte in
                                     // this file could be stripped in transit, and a
                                     // stripped one turns the check into a silent no-op
    check("control bytes are rejected",
      !verifyTypedAnswer({ secret, nonce, pid, b64: b64of(bad),
                           mac: typedAnswerHmac(secret, nonce, pid, voiceSha(bad)) }).ok);
  }

  check("empty text is rejected",
    !verifyTypedAnswer({ secret, nonce, pid, b64: b64of(""),
                         mac: typedAnswerHmac(secret, nonce, pid, voiceSha("")) }).ok);

  {
    const over = "x".repeat(TYPED_TEXT_MAX_BYTES + 1);
    check("text over the byte cap is rejected",
      !verifyTypedAnswer({ secret, nonce, pid, b64: b64of(over),
                           mac: typedAnswerHmac(secret, nonce, pid, voiceSha(over)) }).ok);
  }

  check("text exactly at the byte cap is accepted",
    (() => {
      const at = "y".repeat(TYPED_TEXT_MAX_BYTES);
      return verifyTypedAnswer({ secret, nonce, pid, b64: b64of(at),
                                 mac: typedAnswerHmac(secret, nonce, pid, voiceSha(at)) }).ok;
    })());

  // The two forms sign DIFFERENT strings ("...:TEXT:..." vs "...:TYPED:..."), so a
  // signature minted for one must not authenticate the other.
  check("a voice-form mac does not authenticate a typed answer",
    !verifyTypedAnswer({ secret, nonce, pid, b64: tB64,
                         mac: voiceAnswerHmac(secret, nonce, pid, voiceSha(tText)) }).ok);
}
```

Change the import line at the top of the same file from:

```js
import { voiceSha, voiceAnswerHmac, verifyVoiceAnswer, capUtf8 } from "./voice-answer.mjs";
```

to:

```js
import { voiceSha, voiceAnswerHmac, verifyVoiceAnswer, capUtf8 } from "./voice-answer.mjs";
import { TYPED_TEXT_MAX_BYTES, typedAnswerHmac, decodeTypedText, verifyTypedAnswer } from "./typed-answer.mjs";
```

And update the file's header comment, which currently claims to cover only voice:

```js
// Checks for the answer crypto - spoken AND typed. Run: node host/voice-answer-check.mjs
// Deliberately covers the REJECT cases, not just the happy path: this is the
// code that decides whether a remote answer is allowed to reach Claude.
```

- [ ] **Step 2: Run the checks to verify they fail**

Run: `node host/voice-answer-check.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `./typed-answer.mjs`.

- [ ] **Step 3: Write `host/typed-answer.mjs`**

```js
// Typed-answer crypto and validation, kept as pure functions so it can be tested
// without a device. See docs/superpowers/specs/2026-08-15-keyboard-answers-design.md.
//
// This differs from the voice path in the one way that matters: the host holds NO
// copy of typed text, so there is nothing to compare against. handleVoiceAnswer
// opens with pendingVoiceAnswers.get(pid) and re-hashes its own copy; a typed
// answer instead CARRIES the text and is trusted only because the HMAC proves it
// came from the paired device. That makes this the first place the host accepts
// device-authored text, which is why the sanitising below is not optional: the
// signature proves origin, never that the bytes are sensible.
import crypto from "node:crypto";
import { voiceSha } from "./voice-answer.mjs";

// Same cap as a spoken answer (VOICE_ANSWER_TEXT_MAX_BYTES), so one limit covers
// both and the device's fixed buffers are sized once.
export const TYPED_TEXT_MAX_BYTES = 150;

// Note the "TYPED" tag: the voice form signs "nonce:pid:TEXT:sha". Signing a
// different string for each form is what stops a signature minted for one being
// replayed as the other.
export function typedAnswerHmac(secret, nonce, pid, sha16) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${nonce}:${pid}:TYPED:${sha16}`)
    .digest("hex")
    .slice(0, 16);
}

// Printable ASCII plus space. The device's keyboard cannot emit anything else, so
// this is really a test of whether the frame came from our firmware - and the text
// ends up in a JSON answer file the hook feeds to Claude as a decision message,
// where control bytes have no business at all.
export function typedTextOk(text) {
  return (
    typeof text === "string" &&
    text.length > 0 &&
    Buffer.byteLength(text, "utf8") <= TYPED_TEXT_MAX_BYTES &&
    /^[\x20-\x7E]+$/.test(text)
  );
}

// Buffer.from(.., "base64") is LENIENT: it silently skips characters it does not
// recognise, so "abc!!!!" decodes happily to whatever "abc" meant. Re-encoding and
// comparing is what turns that into a rejection instead of a silent
// reinterpretation of a payload we are about to sign against.
export function decodeTypedText(b64) {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.toString("base64") !== b64) return null;
  if (buf.length > TYPED_TEXT_MAX_BYTES) return null;
  return buf.toString("utf8");
}

// Returns a reason as well as a verdict: a rejected answer must be logged with WHY,
// because "wrong device" and "text was altered" are a misconfiguration and an attack.
export function verifyTypedAnswer({ secret, nonce, pid, b64, mac }) {
  if (!secret || !nonce || !pid) return { ok: false, why: "missing pairing/nonce state" };
  if (typeof mac !== "string" || !/^[0-9a-f]{16}$/.test(mac)) return { ok: false, why: "malformed mac" };
  const text = decodeTypedText(b64);
  if (text === null) return { ok: false, why: "malformed base64" };
  if (!typedTextOk(text)) {
    return { ok: false, why: "text is empty, over the cap, or not printable ASCII" };
  }
  const want = typedAnswerHmac(secret, nonce, pid, voiceSha(text));
  // Equal lengths are guaranteed by the mac regex above, so this cannot throw.
  const ok = crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  return ok ? { ok: true, why: "", text } : { ok: false, why: "bad hmac" };
}
```

- [ ] **Step 4: Run the checks to verify they pass**

Run: `node host/voice-answer-check.mjs`
Expected: PASS — every check `ok`, exit 0, and the count includes the 14 new typed checks on top of the existing 15.

- [ ] **Step 5: Prove the checks have teeth**

A checker that cannot fail is not a checker. Temporarily weaken `typedTextOk` by deleting the `/^[\x20-\x7E]+$/` clause, re-run, and confirm "control bytes are rejected" FAILS. Then restore it and re-run to confirm all pass. Record both outputs in your report.

- [ ] **Step 6: Commit**

```bash
git add host/typed-answer.mjs host/voice-answer-check.mjs
git commit -m "Add typed-answer crypto, which cannot reuse the voice path

The voice form signs a hash of a transcript the HOST holds and re-hashes its own
copy to verify. A typed answer has no host-side copy, so it carries the text and
is trusted only because the HMAC proves the paired device sent it. That makes
this the first place the host accepts device-authored text, so the text is also
sanitised: printable ASCII, non-empty, within the 150-byte cap.

The two forms sign different strings (TEXT vs TYPED) so a signature minted for
one cannot authenticate the other, and base64 is re-encoded and compared because
Buffer.from is lenient enough to silently ignore junk in a payload."
```

---

## Task 2: Accept TYPED answers, and publish the countdown (host)

**Files:**
- Modify: `host/index.mjs`

**Interfaces:**
- Consumes: `verifyTypedAnswer`, `TYPED_TEXT_MAX_BYTES` from `./typed-answer.mjs`.
- Produces: wire form `ANSWER <id12> <pid> TYPED <base64text> <hmac>` accepted; `ask.sec` (integer seconds remaining) published on every ask.

- [ ] **Step 1: Import the new module**

Find the existing line:

```js
import { voiceSha, verifyVoiceAnswer, capUtf8 } from "./voice-answer.mjs";
```

Add immediately after it:

```js
import { verifyTypedAnswer } from "./typed-answer.mjs";
```

- [ ] **Step 2: Record when a prompt was FIRST seen**

In `nonceForPid`, change the creation branch so the entry carries a first-seen stamp:

```js
function nonceForPid(pid) {
  let e = askNonces.get(pid);
  if (!e) {
    // `first` is set ONCE and never rewritten. `seen` cannot serve this purpose:
    // it is refreshed on every tick below so the entry survives pruning, so a
    // countdown derived from it would sit at the full budget forever.
    e = { nonce: crypto.randomBytes(8).toString("hex"), seen: Date.now(), first: Date.now() };
    askNonces.set(pid, e);
  } else {
    e.seen = Date.now();
  }
  return e.nonce;
}
```

- [ ] **Step 3: Publish seconds-remaining on the ask**

Add this constant next to the other timing constants near the top of the file:

```js
// Mirrors REMOTE_WAIT_MS in claude-hooks/deckhand-session-hook.mjs, per agent.
// ADVISORY ONLY - it drives the keyboard's countdown and nothing else. If the
// hook's value ever changes and this is missed, the countdown is wrong and no
// decision is affected. It must never gate whether an answer is sent.
const HOOK_WAIT_MS = { cc: 90_000, cx: 15_000 };
```

Then in the payload builder, inside the existing `if (record.ask) { ... }` block, after the `item.ask.voice = ...` line:

```js
        // Seconds left before the hook stops waiting, for the keyboard countdown.
        const ne = askNonces.get(record.ask.pid);
        if (ne) {
          const budget = HOOK_WAIT_MS[item.agent] ?? HOOK_WAIT_MS.cc;
          item.ask.sec = Math.max(0, Math.round((budget - (Date.now() - ne.first)) / 1000));
        }
```

- [ ] **Step 4: Route the TYPED form**

In the ANSWER parser, find:

```js
  if (parts[3] === "TEXT") {
    await handleVoiceAnswer(parts, via);
    return;
  }
```

Add immediately after it:

```js
  // Typed form: ANSWER <id12> <pid> TYPED <base64text> <hmac>. Like TEXT this is
  // checked before the option form, so the two parsers never see each other's shape.
  if (parts[3] === "TYPED") {
    await handleTypedAnswer(parts, via);
    return;
  }
```

- [ ] **Step 5: Implement `handleTypedAnswer`**

Add immediately after the closing brace of `handleVoiceAnswer`:

```js
// The typed sibling of handleVoiceAnswer. Same shape, one real difference: there is
// no parked transcript to look up, because the text arrives in the frame. Every
// other guard is deliberately identical - especially the ask.kind re-check, which
// is what stops a chosen pid reaching emitDecision's {behavior:"allow"} plan branch.
async function handleTypedAnswer(parts, via) {
  const [, id12, pid, , b64, mac] = parts;
  const entry = askNonces.get(pid);
  const from = deviceNameFor(via);
  const dev = from ? deviceEntry(from) : null;

  const v = verifyTypedAnswer({ secret: dev?.secret, nonce: entry?.nonce, pid, b64, mac });
  if (!v.ok) {
    // Loud on purpose: "text is empty, over the cap, or not printable ASCII" and
    // "bad hmac" are a foreign peer, not an ordinary rejection.
    console.error(
      `Typed answer REJECTED (${v.why}) for prompt ${pid} via ${via}` +
        `${from ? ` from ${from}` : " (unknown device)"} - ignoring.`
    );
    return;
  }
  const text = v.text;
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    let file = null;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      if (f.slice(0, 12) === id12) { file = f; break; }
    }
    if (!file) {
      console.error(`Typed answer: no session matching ${id12} - ignoring.`);
      return;
    }
    const sessionId = path.basename(file, ".json");
    let rec = null;
    try {
      rec = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, file), "utf8"));
    } catch (err) {
      console.error(`Typed answer: could not read session record for ${sessionId}: ${err.message}`);
      return;
    }
    if (rec?.ask?.kind !== "question" || rec?.ask?.pid !== pid) {
      console.error(`Typed answer REJECTED (not a pending question) for prompt ${pid} - ignoring.`);
      return;
    }
    // The nonce is single-use: consuming it here is what makes a replay fail.
    askNonces.delete(pid);
    await fs.mkdir(ANSWERS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(ANSWERS_DIR, `${sessionId}.json`),
      JSON.stringify({ pid, idx: 0, label: text, typed: true, written_at: Date.now() })
    );
    console.log(`Typed answer accepted for ${sessionId} (pid ${pid}): "${text}"`);
    setVoice("asksent", { text, reply: "sent to Claude" });
  } catch (err) {
    console.error(`Typed answer: could not write answer file: ${err.message}`);
  }
}
```

**Note for the implementer:** copy the session-file lookup loop from `handleVoiceAnswer` verbatim if it differs from the sketch above — read that function first and match how it maps `id12` to a file, rather than assuming the 12-character slice. The rest of the function is as written.

- [ ] **Step 6: Verify**

Run: `node --check host/index.mjs`
Expected: clean, no output.

Run: `node host/voice-answer-check.mjs`
Expected: all checks pass (this task changes no crypto, so this is a regression guard).

Confirm by reading that `handleVoiceAnswer` still exists unmodified and the option-answer path (`parts[3]` numeric) is untouched.

- [ ] **Step 7: Commit**

```bash
git add host/index.mjs
git commit -m "Accept typed answers, and publish how long the prompt has left

handleTypedAnswer mirrors handleVoiceAnswer, including the ask.kind re-check that
stops a chosen pid reaching emitDecision's allow branch. The one real difference
is that there is no parked transcript to look up: the text arrives in the frame
and is trusted because the HMAC proves the paired device sent it.

The ask now carries seconds-remaining so the keyboard can show a countdown, which
typing needs and a 20s recording did not. It comes from a new first-seen stamp on
the nonce entry, because 'seen' is refreshed every tick to keep the entry alive
and a countdown built on it would never decrease."
```

---

## Task 3: The keyboard surface (device)

**Files:**
- Create: `firmware/deckhand_display/keyboard.ino`
- Modify: `firmware/deckhand_display/deckhand_display.ino`, `firmware/deckhand_display/sessions.ino`

**Interfaces:**
- Consumes: `uiButton`, `uiFillRound`, `setUIFont`, `fitText`, `drawWrappedText`, `contentBottom()`, `CARD_X`, `CARD_W`, `COLOR_*`, `T_BODY`/`T_HEAD`/`FONT_CODE`, `copyField`.
- Produces: `bool kbActive`, `void openKeyboard(int idx)`, `void drawKeyboard()`, `bool kbTouch(int sx, int sy)`, `void closeKeyboard()`, `int askInputRows(int idx)`, `bool askTypeOffered(int idx)`.

- [ ] **Step 1: Add the keyboard globals and `askSec`**

In `deckhand_display.ino`, add to the `SessionInfo` struct immediately after `char askVoiceCancelSha[20];`:

```c
  // Seconds the hook will still wait, published by the host. Advisory: it drives
  // the keyboard's countdown only, and -1 means the host did not send one.
  int askSec;
```

In the ask-parsing block (where `askVoiceText`/`askVoiceSha` are copied), add:

```c
      info.askSec = a["sec"] | -1;
```

And in the same block's reset path (where `info.askVoiceText[0] = '\0';` sets defaults for an ask-less session), add `info.askSec = -1;`.

Add these globals next to the other screen-state flags (near `bool readerActive`):

```c
// ---- Keyboard state ----
// One keyboard at a time, so this is global rather than per-session: it is a
// surface, not a property of a row. kbPid pins it to the prompt it was opened
// for, so a payload that rewrites the session list cannot redirect a typed answer.
bool kbActive = false;
char kbText[151];              // 150 bytes + NUL, matching the host's cap exactly
int  kbLen = 0;
char kbPid[24] = "";
bool kbShift = false;          // one-shot, cleared by the next character
bool kbSymbols = false;        // ?123 page
bool kbWindowClosed = false;   // the ask vanished while typing - keep the text
```

- [ ] **Step 2: Write `keyboard.ino`**

```c
// The on-screen keyboard: typing an answer to a question prompt.
// Split out of deckhand_display.ino for the same reason as the other .ino files -
// the Arduino build concatenates them all into ONE translation unit (main file
// first, then alphabetically), so these still share every global and there are no
// headers. No function here names SessionInfo/Theme/Usage/HostPairing/ConfirmAction
// in its SIGNATURE, which is what would break the auto-generated prototypes.
//
// It owns the WHOLE screen - tab bar and footer included - the way the history
// reader does. That is not cosmetic: it is what makes QWERTY viable on a 240px
// panel. Inside the content area the keys would be 22x40; full-screen they are
// 22x46, which is 1012px2 of target instead of 880.

const int KB_PITCH  = 24;      // 10 * 24 = 240, exactly the panel width
const int KB_KEY_W  = 22;      // 2px of the pitch is the gap
const int KB_ROW_H  = 46;
const int KB_TEXT_Y = 4,   KB_TEXT_H = 60;
const int KB_ROWS_Y = 68;                      // 4 rows * 46 = 184, ends at 252
const int KB_ACT_Y  = 256, KB_ACT_H = 44;      // ends at 300, 20px spare
const int KB_MAX_BYTES = 150;                  // must equal the host's cap

// Rows 0-2 are the letter/symbol pages; row 3 is fixed. Control characters stand
// in for the non-letter keys, because Cozette is ASCII 0x20-0x7E ONLY - there is
// no glyph for a shift arrow or a backspace, and drawing one would paint a blank
// box. They are labelled CAP and DEL instead.
#define KB_SHIFT '\x01'
#define KB_DEL   '\x02'
const char* KB_ALPHA[3] = { "qwertyuiop", "asdfghjkl", "\x01zxcvbnm\x02" };
const char* KB_SYM[3]   = { "1234567890", "-_/:;()&@#", ".,?!'\"+=\x02" };

const char* kbRow(int r) { return kbSymbols ? KB_SYM[r] : KB_ALPHA[r]; }
int kbRowLen(int r) { return (int) strlen(kbRow(r)); }
// Rows shorter than 10 cells are CENTRED, so the hit test and the draw must both
// derive x from the same place or a tap lands one key off at the ends.
int kbRowX0(int r) { return (tft.width() - kbRowLen(r) * KB_PITCH) / 2; }
int kbRowY(int r)  { return KB_ROWS_Y + r * KB_ROW_H; }

// Row 3 is [?123|ABC] 2 cells, [space] 6 cells, [.] 2 cells.
const int KB_R3_PAGE_W  = 2 * KB_PITCH;
const int KB_R3_SPACE_W = 6 * KB_PITCH;

void kbKeyLabel(char c, char* out, size_t n) {
  if (c == KB_SHIFT)      snprintf(out, n, "CAP");
  else if (c == KB_DEL)   snprintf(out, n, "DEL");
  else if (kbShift && c >= 'a' && c <= 'z') snprintf(out, n, "%c", c - 32);
  else                    snprintf(out, n, "%c", c);
}

// One key. Drawn on demand so a press can invert just this key rather than the
// whole board - on a panel with no haptics that flash is the only confirmation a
// press registered, and skipping it reads as a dropped keystroke.
void drawKbKey(int r, int col, bool pressed) {
  const char* row = kbRow(r);
  if (col < 0 || col >= kbRowLen(r)) return;
  char label[8];
  kbKeyLabel(row[col], label, sizeof(label));
  int x = kbRowX0(r) + col * KB_PITCH, y = kbRowY(r);
  uiButton(x, y, KB_KEY_W, KB_ROW_H - 4, label, COLOR_ACCENT, pressed, COLOR_BG);
}

void drawKbRow3(int pressed /* -1 none, 0 page, 1 space, 2 dot */) {
  int y = kbRowY(3), h = KB_ROW_H - 4, x = 0;
  uiButton(x, y, KB_R3_PAGE_W, h, kbSymbols ? "ABC" : "?123",
           COLOR_ACCENT, pressed == 0, COLOR_BG);
  x += KB_R3_PAGE_W;
  uiButton(x, y, KB_R3_SPACE_W, h, "SPACE", COLOR_ACCENT, pressed == 1, COLOR_BG);
  x += KB_R3_SPACE_W;
  uiButton(x, y, tft.width() - x, h, ".", COLOR_ACCENT, pressed == 2, COLOR_BG);
}

// The typed text, plus the countdown. Repainted wholesale (it is one small card)
// rather than through drawIfChanged - the text changes on every keystroke, so a
// change-only cache would buy nothing and would need to be as long as the buffer.
void drawKbText() {
  uiFillRound(CARD_X, KB_TEXT_Y, CARD_W, KB_TEXT_H, 6, COLOR_CARD, COLOR_BG);
  if (kbLen == 0) {
    setUIFont(T_BODY);
    tft.setTextColor(COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("Type your answer", CARD_X + 6, KB_TEXT_Y + 8);
  } else {
    drawWrappedText(kbText, CARD_X + 6, KB_TEXT_Y + 6, FONT_CODE, 13,
                    CARD_W - 12, 0, 3, COLOR_VALUE, COLOR_CARD);
  }
  // Countdown, top-right. Amber under 20s. Advisory only - it never decides
  // whether SEND works, so a wrong value costs nothing but a wrong impression.
  int sec = (kbSessionIdx >= 0 && kbSessionIdx < sessionCount)
              ? sessions[kbSessionIdx].askSec : -1;
  if (sec >= 0) {
    char buf[12];
    snprintf(buf, sizeof(buf), "%ds", sec);
    setUIFont(T_META);
    tft.setTextColor(sec < 20 ? COLOR_WARN : COLOR_LABEL, COLOR_CARD);
    tft.setTextDatum(TR_DATUM);
    tft.drawString(buf, CARD_X + CARD_W - 6, KB_TEXT_Y + 6);
  }
  // The byte counter turns amber at the cap, so a key that stops inserting has a
  // visible reason rather than looking like a dropped press.
  char cnt[16];
  snprintf(cnt, sizeof(cnt), "%d/%d", kbLen, KB_MAX_BYTES);
  setUIFont(T_META);
  tft.setTextColor(kbLen >= KB_MAX_BYTES ? COLOR_WARN : COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(BR_DATUM);
  tft.drawString(cnt, CARD_X + CARD_W - 6, KB_TEXT_Y + KB_TEXT_H - 4);
  tft.setTextDatum(TL_DATUM);
}

void drawKbActions() {
  int halfW = (tft.width() - CARD_X * 2 - 8) / 2;
  uiButton(CARD_X, KB_ACT_Y, halfW, KB_ACT_H, "CANCEL", COLOR_ACCENT, true, COLOR_BG);
  if (kbWindowClosed) {
    // The prompt expired or was answered on the Mac. The text STAYS - throwing
    // away a sentence someone spent a minute on, with no explanation, is the
    // worst outcome available here - but SEND is withheld because it cannot work.
    setUIFont(T_META);
    tft.setTextColor(COLOR_WARN, COLOR_BG);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("WINDOW CLOSED - ANSWER ON YOUR MAC",
                   CARD_X + halfW + 8 + halfW / 2, KB_ACT_Y + KB_ACT_H / 2);
    tft.setTextDatum(TL_DATUM);
  } else {
    // An empty answer would reach Claude as a blank deny message, which reads as
    // a refusal with no reason. Offer SEND only when there is something to send.
    uiButton(CARD_X + halfW + 8, KB_ACT_Y, halfW, KB_ACT_H, "SEND",
             kbLen > 0 ? COLOR_GOOD : COLOR_LABEL, kbLen > 0, COLOR_BG);
  }
}

void drawKeyboard() {
  tft.fillScreen(COLOR_BG);
  drawKbText();
  for (int r = 0; r < 3; r++)
    for (int c = 0; c < kbRowLen(r); c++) drawKbKey(r, c, false);
  drawKbRow3(-1);
  drawKbActions();
}

void openKeyboard(int idx) {
  kbActive = true;
  kbSessionIdx = idx;
  kbLen = 0;
  kbText[0] = '\0';
  kbShift = false;
  kbSymbols = false;
  kbWindowClosed = false;
  copyField(kbPid, sizeof(kbPid), sessions[idx].askPid);
  drawKeyboard();
}

void closeKeyboard() {
  kbActive = false;
  kbSessionIdx = -1;
  kbPid[0] = '\0';
  forceFullRepaint();   // returns values from data already in hand, no tick wait
}

void kbInsert(char c) {
  if (kbLen >= KB_MAX_BYTES) { drawKbText(); return; }  // repaint so the counter shows why
  if (kbShift && c >= 'a' && c <= 'z') c -= 32;
  kbText[kbLen++] = c;
  kbText[kbLen] = '\0';
  if (kbShift) {
    kbShift = false;
    // The whole letter page re-labels when shift clears, so repaint rows 0-2.
    for (int r = 0; r < 3; r++)
      for (int col = 0; col < kbRowLen(r); col++) drawKbKey(r, col, false);
  }
  drawKbText();
  drawKbActions();      // SEND becomes live on the first character
}

void kbBackspace() {
  if (kbLen == 0) return;
  kbText[--kbLen] = '\0';
  drawKbText();
  drawKbActions();      // SEND goes inert again at zero
}

// Returns true when the tap was consumed. Touch is dispatched on PRESS and a held
// finger is ignored by handleTouch, so one press is exactly one character with no
// extra debounce needed here.
bool kbTouch(int sx, int sy) {
  if (sy >= KB_ACT_Y && sy < KB_ACT_Y + KB_ACT_H) {
    int halfW = (tft.width() - CARD_X * 2 - 8) / 2;
    if (sx < CARD_X + halfW) { closeKeyboard(); return true; }
    if (!kbWindowClosed && kbLen > 0 && sx >= CARD_X + halfW + 8) {
      sendTypedAnswerToHost();   // Task 4 - a no-op stub until then
      return true;
    }
    return true;                 // swallow taps in the gap rather than guessing
  }
  if (sy < KB_ROWS_Y) return true;             // the text card is not a control
  int r = (sy - KB_ROWS_Y) / KB_ROW_H;
  if (r < 0 || r > 3) return true;
  if (r == 3) {
    if (sx < KB_R3_PAGE_W) {
      kbSymbols = !kbSymbols;
      kbShift = false;
      drawKeyboard();
    } else if (sx < KB_R3_PAGE_W + KB_R3_SPACE_W) {
      kbInsert(' ');
    } else {
      kbInsert('.');
    }
    return true;
  }
  int col = (sx - kbRowX0(r)) / KB_PITCH;
  if (col < 0 || col >= kbRowLen(r)) return true;   // the centred rows' margins
  char c = kbRow(r)[col];
  drawKbKey(r, col, true);       // flash: the only confirmation a press landed
  if (c == KB_SHIFT) {
    kbShift = !kbShift;
    for (int rr = 0; rr < 3; rr++)
      for (int cc = 0; cc < kbRowLen(rr); cc++) drawKbKey(rr, cc, false);
    drawKbKey(r, col, kbShift);
    return true;
  }
  if (c == KB_DEL) { kbBackspace(); drawKbKey(r, col, false); return true; }
  kbInsert(c);
  drawKbKey(r, col, false);
  return true;
}
```

Add `int kbSessionIdx = -1;` to the globals in Step 1 (it is referenced above).

- [ ] **Step 3: Add a temporary stub so Task 3 compiles standalone**

Task 4 implements `sendTypedAnswerToHost()`. Add this stub at the bottom of `keyboard.ino` now, and DELETE it in Task 4:

```c
// STUB - replaced in Task 4. Present only so this task compiles and the keyboard
// can be exercised (type, backspace, shift, page, cancel) before send exists.
void sendTypedAnswerToHost() {}
```

- [ ] **Step 4: Offer the TYPE control on the ask screen**

In `sessions.ino`, replace `askVoiceRows` with:

```c
// True when this ask may be answered by TYPING. Questions only, for the same
// reason voice is: emitDecision discards a plan's text and a permission prompt
// can only be denied. Codex is excluded because REMOTE_WAIT_MS is 15s there
// against 90s for Claude Code - not enough to type a sentence - and offering a
// control that cannot work is exactly what the read-only ask path refuses to do.
bool askTypeOffered(int idx) {
  const SessionInfo& s = sessions[idx];
  return s.askAnswerable && strcmp(s.askKind, "question") == 0 &&
         strcmp(s.agent, "cx") != 0 && !s.askVoiceText[0];
}
// 1 when this ask offers an input row (SPEAK and/or TYPE), 0 otherwise. Used by
// BOTH askOptionsTop() and the draw, so the buttons and their hit tests can never
// disagree about how many rows are in the stack - which is exactly how a fixed
// offset would drift. SPEAK and TYPE SHARE one row (half-width each, the way
// SOUND and NORMAL/FLIPPED share the settings page's bottom row) so adding typing
// costs the options no space at all.
int askInputRows(int idx) {
  const SessionInfo& s = sessions[idx];
  bool speak = s.askVoice && s.askAnswerable && !s.askVoiceText[0];
  return (speak || askTypeOffered(idx)) ? 1 : 0;
}
```

Replace every `askVoiceRows(` call site with `askInputRows(` — there are two, in `askOptionsTop()` and in `handleAskTouch`.

Replace the SPEAK draw block with:

```c
  if (askInputRows(idx)) {
    const SessionInfo& s = sessions[idx];
    bool speak = s.askVoice && s.askAnswerable && !s.askVoiceText[0];
    bool type  = askTypeOffered(idx);
    int y = contentBottom() - ASK_OPT_H;
    if (speak && type) {
      int halfW = (CARD_W - 8) / 2;
      uiButton(CARD_X, y, halfW, ASK_OPT_H, "SPEAK", COLOR_ACCENT);
      uiButton(CARD_X + halfW + 8, y, halfW, ASK_OPT_H, "TYPE", COLOR_ACCENT);
    } else if (speak) {
      uiButton(CARD_X, y, CARD_W, ASK_OPT_H, "SPEAK YOUR ANSWER", COLOR_ACCENT);
    } else {
      uiButton(CARD_X, y, CARD_W, ASK_OPT_H, "TYPE YOUR ANSWER", COLOR_ACCENT);
    }
  }
```

And in `handleAskTouch`, replace the SPEAK branch with:

```c
  if (askInputRows(detailIndex) && sy >= contentBottom() - ASK_OPT_H) {
    bool speak = s.askVoice && s.askAnswerable && !s.askVoiceText[0];
    bool type  = askTypeOffered(detailIndex);
    // Same split as the draw, derived the same way, so the halves cannot drift.
    bool wantType = type && (!speak || sx >= CARD_X + (CARD_W - 8) / 2 + 8);
    if (wantType) { openKeyboard(detailIndex); return true; }
    if (!speak) return true;                 // the gap between the two buttons
    s.askVoiceCancelSha[0] = '\0';
    copyField(micAnswerPid, sizeof(micAnswerPid), s.askPid);
    micStream();
    micAnswerPid[0] = '\0';
    return true;
  }
```

- [ ] **Step 5: Route touch and absorb the tick**

In `deckhand_display.ino`'s `handleTouch`, add this as the FIRST branch after the record button's hit test and BEFORE the `showingDetail` branch:

```c
  // The keyboard owns the whole screen, so it is tested before every other
  // surface and consumes every tap - the same way the reader does.
  if (kbActive) { kbTouch(sx, sy); lastActivityMillis = millis(); return; }
```

In `handleLine`, alongside the existing `if (readerActive) { ... }` tick-absorption block, add:

```c
  if (kbActive) {
    // The keyboard owns the screen; absorb the tick so the periodic repaint does
    // not paint the session list over what someone is typing - the same trap the
    // reader and the settings confirm dialog already document. The countdown and
    // the window-closed state are refreshed from the new payload, nothing else.
    int idx = -1;
    for (int i = 0; i < sessionCount; i++)
      if (strcmp(sessions[i].askPid, kbPid) == 0) { idx = i; break; }
    kbSessionIdx = idx;
    bool gone = (idx < 0);
    if (gone != kbWindowClosed) { kbWindowClosed = gone; drawKbActions(); }
    drawKbText();          // countdown ticks down
    return;
  }
```

Add `kbActive` to the guards that suppress other timer-driven drawing, matching how `readerActive` is used — in `tickWorkingSpinner`'s gate, `tickAutoTheme`'s deferral, and `waitingScreenVisible()`.

- [ ] **Step 6: Compile**

Run: `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
Expected: success. Report flash/RAM against the baseline (1357846 / 80724).

Verify by reading, and state each in your report:
- Every band fits: text card 4..64, keys 68..252 (4 x 46), actions 256..300, screen 320.
- `kbRowX0` is used by BOTH `drawKbKey` and `kbTouch`, so a centred row's hit test matches its draw.
- No function in `keyboard.ino` names `SessionInfo` (or the other four late-declared types) in its signature.

- [ ] **Step 7: Commit**

```bash
git add firmware/deckhand_display/keyboard.ino firmware/deckhand_display/deckhand_display.ino firmware/deckhand_display/sessions.ino
git commit -m "Add the on-screen keyboard, reached from a TYPE control on an ask

SPEAK and TYPE share one half-width row, the way the settings page's bottom row
already does, so askOptionsTop's row count does not grow and the options keep
their space. TYPE is offered for any answerable question ask, including on a
device with no microphone fitted - it is the first remote-answer path needing no
hardware beyond the panel.

The keyboard owns the whole screen, tab bar included, the way the history reader
does. That is what makes QWERTY viable at 240px: keys are 22x46 rather than the
22x40 they would be inside the content area. Labels are CAP and DEL rather than
arrow glyphs because Cozette is ASCII 0x20-0x7E only and a missing glyph paints a
blank box.

Send is a stub in this commit; the surface is otherwise complete."
```

---

## Task 4: Sign and send a typed answer (device)

**Files:**
- Modify: `firmware/deckhand_display/keyboard.ino`, `firmware/deckhand_display/pairing.ino`

**Interfaces:**
- Consumes: `authHmac(const String&)`, `sendLineToHost(const char*)`, `B64[]`, `kbText`, `kbLen`, `kbPid`.
- Produces: `String sha256Hex16(const char*)`, `void sendTypedAnswerToHost()`.

- [ ] **Step 1: Add the hash helper**

The voice path never needed this — the host supplied `askVoiceSha`. A typed answer must hash its own text. Add to `pairing.ino`, immediately above `authHmac`:

```c
// First 8 bytes of SHA-256, hex - the same 16-character form the host's voiceSha
// produces, so both sides hash the same way. The voice path never needed this:
// the host sent the hash of the transcript IT held. Typed text exists only on the
// device until it is sent, so the device has to hash it.
String sha256Hex16(const char* s) {
  uint8_t out[32];
  mbedtls_sha256((const unsigned char*) s, strlen(s), out, 0);  // 0 = SHA-256, not 224
  char hex[17];
  for (int i = 0; i < 8; i++) sprintf(hex + i * 2, "%02x", out[i]);
  return String(hex);
}
```

Add `#include <mbedtls/sha256.h>` next to the existing `#include <mbedtls/md.h>` in `deckhand_display.ino`.

- [ ] **Step 2: Replace the stub with the real send**

Delete the `void sendTypedAnswerToHost() {}` stub from `keyboard.ino` and add:

```c
// Base64 of the typed text. Reuses the B64 table the screenshot dumper already
// defines rather than pulling in mbedtls, keeping the wire format readable in a
// host log by hand. 150 bytes -> 200 characters, well inside the line buffers.
void kbBase64(char* out, size_t outSize) {
  int o = 0;
  for (int i = 0; i < kbLen && o + 4 < (int) outSize; i += 3) {
    uint32_t v = (uint32_t) (uint8_t) kbText[i] << 16;
    if (i + 1 < kbLen) v |= (uint32_t) (uint8_t) kbText[i + 1] << 8;
    if (i + 2 < kbLen) v |= (uint8_t) kbText[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = (i + 1 < kbLen) ? B64[(v >> 6) & 63] : '=';
    out[o++] = (i + 2 < kbLen) ? B64[v & 63] : '=';
  }
  out[o] = '\0';
}

void sendTypedAnswerToHost() {
  if (kbLen == 0 || kbWindowClosed) return;
  int idx = kbSessionIdx;
  if (idx < 0 || idx >= sessionCount) return;
  // Sign the HASH of the text, not the base64: the two sides then agree on the
  // signed bytes without depending on padding or case in the encoding.
  String sha = sha256Hex16(kbText);
  String payload = String(sessions[idx].askNonce) + ":" + kbPid + ":TYPED:" + sha;
  String mac = authHmac(payload);
  // "0" when unprovisioned, matching sendAnswerToHost and sendVoiceAnswerToHost.
  // Deliberately NOT a silent return: the host logs the rejection, so an unpaired
  // device shows up as a refused answer rather than a SEND that quietly does nothing.
  if (mac.length() == 0) mac = "0";
  char b64[204];
  kbBase64(b64, sizeof(b64));
  char line[280];
  snprintf(line, sizeof(line), "ANSWER %s %s TYPED %s %s",
           sessions[idx].id, kbPid, b64, mac.c_str());
  sendLineToHost(line);
  closeKeyboard();
}
```

- [ ] **Step 3: Compile**

Run: `arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" firmware/deckhand_display`
Expected: success. Report flash/RAM.

- [ ] **Step 4: Prove the two sides agree, without hardware**

The device and host must compute the same HMAC. Write a throwaway node script (do not commit it) that reproduces the device's payload string and compares:

```bash
node -e '
const { typedAnswerHmac } = await import("./host/typed-answer.mjs");
const { voiceSha } = await import("./host/voice-answer.mjs");
const secret = "0123456789abcdef0123456789abcdef", nonce = "a1b2c3d4e5f60718", pid = "54321";
const text = "use the second approach";
console.log("payload:", `${nonce}:${pid}:TYPED:${voiceSha(text)}`);
console.log("mac:    ", typedAnswerHmac(secret, nonce, pid, voiceSha(text)));
console.log("b64:    ", Buffer.from(text,"utf8").toString("base64"));
' --input-type=module
```

Confirm by reading `sendTypedAnswerToHost` that the device builds the identical payload string (`nonce:pid:TYPED:sha16`), and that `kbBase64` produces the same base64 for the same input (check the padding branches by hand for a length that is not a multiple of 3). Record the payload and mac in your report — this is the interop check the voice path documents as "verified interoperable", and it is the one thing a compile cannot catch.

- [ ] **Step 5: Commit**

```bash
git add firmware/deckhand_display/keyboard.ino firmware/deckhand_display/pairing.ino firmware/deckhand_display/deckhand_display.ino
git commit -m "Sign and send a typed answer

The device hashes its own text here, which the voice path never had to do - there
the host supplied the hash of the transcript it was holding. Typed text exists
only on the device until it is sent, so sha256Hex16 produces the same 16-character
form the host's voiceSha does.

The signature covers the hash rather than the base64, so both sides agree on the
signed bytes without depending on padding or case in the encoding. An unprovisioned
device sends '0' rather than returning silently, matching the other two answer
paths: the host logs a refused answer, instead of SEND appearing to do nothing."
```

---

## Task 5: Document it

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`

- [ ] **Step 1: Add the CLAUDE.md section**

Add a bullet immediately after the voice-answers bullet (the one beginning "**A pending QUESTION can be answered by speaking**"), covering — each as a "why", not a "what":

- The typed form carries the TEXT while the voice form carries a hash of something the host holds, and `handleVoiceAnswer` bails without a parked transcript — so the voice spec's claim that a keyboard would reuse the wire format verbatim was wrong.
- This is the first place the host accepts device-authored text, so it sanitises: printable ASCII, non-empty, within 150 bytes. The HMAC proves origin, never that the bytes are sensible.
- The two forms sign different strings (`TEXT` vs `TYPED`) so a signature for one cannot authenticate the other.
- `Buffer.from(.., "base64")` is lenient and silently ignores junk, so the decode re-encodes and compares.
- TYPE is hidden on Codex asks because `REMOTE_WAIT_MS` is 15s there against 90s — and that is a coupling to a constant in another file.
- The countdown cannot come from the nonce's `seen`, which is refreshed every tick to keep the entry alive; it needs `first`. The countdown is advisory and must never gate a send.
- If the window closes mid-typing the text STAYS on screen with SEND withheld.
- Cozette is ASCII 0x20–0x7E only, so the keys are labelled `CAP`/`DEL`, not arrow glyphs.
- The keyboard owns the whole screen because that is what makes QWERTY viable at 240px (22×46 keys instead of 22×40).
- Backspace only, no cursor: a deliberate limit, since aiming a caret at wrapped text on a resistive panel is worse than retyping ≤150 characters.

- [ ] **Step 2: Add the README section**

Under "Answering prompts from the device", after "Answering a question by speaking", add "### Or by typing" covering: where TYPE appears, that it needs no microphone, the full-screen QWERTY with `CAP`/`DEL`/`?123`, the 150-character cap and countdown, that the window closing keeps your text, and that it is questions-only and not offered for Codex threads (with the 15s reason).

- [ ] **Step 3: Regenerate AGENTS.md and verify**

```bash
cd /Users/yujia/projects/deckhand
{ head -n 11 AGENTS.md; tail -n +4 CLAUDE.md; } > AGENTS.md.new && mv AGENTS.md.new AGENTS.md
diff <(tail -n +4 CLAUDE.md) <(tail -n +12 AGENTS.md) && echo "in sync"
```

Expected: `in sync`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "Document typed answers and what they cost that voice did not"
```

---

## Self-Review

**Spec coverage.** Wire format → Task 2 Step 4 + Task 4 Step 2. Host verification steps 1–5 → Task 1 (`verifyTypedAnswer`) and Task 2 (`handleTypedAnswer`'s ask.kind gate and nonce consumption). Entry point / shared row → Task 3 Step 4. Full-screen surface and key grid → Task 3 Step 2. Countdown and `first` → Task 2 Steps 2–3, drawn in Task 3. Window-closed retention → Task 3 Steps 2 and 5. Questions-only and Codex exclusion → Task 3 Step 4 (`askTypeOffered`). Cap behaviour → `kbInsert` plus the amber counter. Verification section → Task 1 Steps 4–5, Task 4 Step 4, and the on-device list below.

**Deviation from the spec, recorded deliberately:** the spec's mockup drew `⇧` and `⌫`. Cozette is ASCII 0x20–0x7E only — those glyphs paint blank boxes — so the keys are labelled `CAP` and `DEL`. Same fact that makes `fitText` trim with three ASCII dots.

**Not covered by any task, and deliberately so:** the four on-device checks in the spec's Verification section (type and send a real answer, the Mac-wins race, the cap, and no TYPE on a Codex ask) need hardware and a live prompt. They are the controller's to run after flashing, not an implementer's.
