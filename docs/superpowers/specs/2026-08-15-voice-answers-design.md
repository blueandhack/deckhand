# Voice Answers — Design

**Status:** design, approved for planning · **Date:** 2026-08-15
**Sub-project:** 1 of 2 (voice first, then an on-screen keyboard reusing the same wire format)

## Problem

The device can answer a prompt by tapping one of up to four preset options. It cannot say anything
that isn't already a button. For an `AskUserQuestion` the useful reply is often "none of those —
do X instead", and today that means walking to the Mac.

The device already has everything needed to capture speech: a mic, streaming ADPCM capture, and
whisper.cpp on the Mac with a working transcript path. What it lacks is a way to turn a transcript
into an *answer to a pending prompt*.

## What already exists, and is reused unchanged

- **The delivery channel.** `emitDecision()` has no native way to hand Claude a chosen answer, so
  for a question it sends `{ behavior: "deny", message: carriedAnswer }` — and that message reaches
  Claude verbatim as the tool result. **For a question, free text needs no hook change at all** —
  `chose` is `answer.label || \`option ${answer.idx + 1}\``, so an answer file carrying the
  transcript as `label` flows through untouched. This holds ONLY for questions; see Scope.
- **`target=<id12>`** is already stamped into the stream header when a recording starts from a
  session's detail screen.
- **Per-prompt nonces** (`askNonces`, 8 random bytes, single-use, consumed on a successful answer)
  and the pairing HMAC.
- **The voice card** (`lastVoice`) already surfaces a transcript to both the device and the menu bar.
- **The record button** is visible on the ask screen since it moved into the tab bar.

## Scope

**Questions only** (`ask.kind === "question"`). Two exclusions, for different reasons.

**Plans are excluded because the text would be silently dropped.** Found while planning, by reading
`emitDecision()` rather than trusting this spec's earlier claim: only the `question` branch carries
free text (`{ behavior: "deny", message: carriedAnswer }`). Both plan branches send a FIXED string —
`"The user chose to keep planning (answered from the Deckhand display)."` — so a spoken answer to a
plan prompt would reach Claude with none of what was said, while the device reported success. That
is the worst failure shape available: silent, and indistinguishable from working. Supporting plans
needs a small change to `emitDecision` to use the spoken text as the reason when one is present;
that is a separate, deliberate edit to the most safety-critical file in the project (its stdout is
a decision channel), and is deferred rather than bundled in.

**Permission prompts are excluded** as a safety decision rather than an omission: a spoken answer can only be
delivered as a *deny with message*, so speaking "yes, go ahead" at a permission prompt would DENY
the tool call with that text as the reason. There is no allow-with-a-note channel. Perms keep their
Allow/Deny buttons, which are unambiguous and already work.

## The core decision: what gets signed

The device never has the transcript — the Mac does the transcription. So the device cannot sign the
text at the moment it records. Two shapes were considered:

**A — authorise up front (rejected).** Device signs the nonce when recording starts; the host
transcribes and writes whatever it got. This is signing a blank cheque: it authorises text the
human has not seen, and a mishearing reaches Claude with a valid signature on it. This project has
already had a dictation invert an instruction ("no sensitive data" → "some sensitive information"),
which is why voice output was changed to hand the transcript over rather than dispatch it.

**B — confirm after seeing it (chosen).** Three steps:

```
1. record       device -> host   audio, tagged answer=<pid>
2. transcribe   host   -> device the text, for display
3. confirm      device -> host   ANSWER <id12> <pid> TEXT <sha> <hmac>
```

The device signs a hash of **the exact text it displayed**. The signature therefore proves two
things at once: the paired device authorised this, *and* this is the text a human read. The host
verifies the hash matches the transcript it still holds before writing the answer file.

The confirmation is not bolted on beside the security model — **the confirm tap IS the
authorisation**. A mishearing cannot get through unseen, and a substituted transcript cannot be
signed.

## Wire format

Existing (unchanged, still used for option taps):

```
ANSWER <id12> <pid> <idx> <hmac>        hmac = HMAC(secret, "nonce:pid:idx")[:16]
```

New:

```
host -> device   (in the tick payload, on the ask object)
  voiceText : the transcript, capped at 200 chars
  voiceSha  : sha256(voiceText) hex, first 16 chars

device -> host
  ANSWER <id12> <pid> TEXT <sha16> <hmac>
  hmac = HMAC(secret, "nonce:pid:TEXT:<sha16>")[:16]
```

`TEXT` occupies the slot an option index would, and is not a valid integer, so an old host parsing
`parseInt` gets `NaN` and rejects it — the existing `Number.isInteger` guard already refuses it
rather than misinterpreting. The device sends only the hash, never the text: the host already holds
the transcript, and echoing it back would add a second copy to authenticate for no benefit.

The host verifies, in order: the HMAC; that `sha16` matches the transcript it holds for that pid;
that the nonce has not been consumed. Any failure logs and drops, as today.

## Budgets, and why they bind

The `PermissionRequest` hook blocks for at most `REMOTE_WAIT_MS` (90s, with settings.json's hook
timeout at 100s to match), and **that is the entire window** for record + transfer + transcribe +
read + confirm.

- **Answer recordings cap at 20s**, against `MIC_STREAM_MAX_MS` of 120s for a normal dictation.
  20s of speech is far more than an answer needs, and it leaves ~70s for the rest.
- Transfer is ~8KB/s over USB (ADPCM, measured), so 20s of audio is ~2.5s of transfer.
- whisper large-v3-turbo runs at ~42x realtime (measured), so ~0.5s.
- The remaining budget is displayed on the confirm screen, counting down, so a slow read is a
  visible choice rather than a silent expiry.

## Failure modes, each with a defined behaviour

| | |
|---|---|
| The Mac answers first (common — `waitForRemoteAnswer` bails when the ask disappears) | The ask vanishes from the payload; the device closes the confirm screen and shows "answered on your Mac" |
| The 90s window expires mid-confirm | The host has already stopped waiting. The device shows "too late — answer on your Mac"; the answer file is not written |
| Transcript is empty or whisper fails | The confirm screen shows the failure and offers RE-RECORD; nothing is signed or sent |
| Capture is under 98% complete | Refused before transcription, as `mic-wav.mjs` already does — a truncated capture transcribes as confident nonsense |
| `sha16` does not match | Host logs and drops. This is the tamper case and must be loud, not silent |

## Device UI

The ask screen gains a **SPEAK** control alongside the option buttons, shown only for a `question`
ask that is `answerable` — not for plans or permission prompts, per Scope. Recording uses the existing pill and level meter.

After transcription the confirm screen is the existing voice card plus three buttons:

- **SEND** — signs `nonce:pid:TEXT:<sha16>` and transmits
- **RE-RECORD** — discards and returns to recording
- **CANCEL** — returns to the option buttons, prompt untouched

The transcript renders in Cozette on a panel, the same treatment quoted text already gets.

## What is NOT in this sub-project

The on-screen keyboard. It reuses this wire format and this confirm step verbatim — the only
difference is where the text comes from — so it is additive rather than a second design. It is
deferred because a 240px-wide resistive panel gives ~24px keys against a 40px `TAP_MIN`, and typing
more than a few words on it will be unpleasant; voice is the input this hardware is good at.

## Verification

- **Host-side, automated:** the HMAC and sha16 checks are pure functions over strings — a small
  node script feeds valid, tampered-text, wrong-nonce, replayed and wrong-device cases and asserts
  accept/reject. This is the security-critical part and is the one piece that can be tested without
  hardware.
- **On the device:** speak an answer to a real `AskUserQuestion`, confirm the text is what was said,
  send, and check the answer reaches Claude as the tool result.
- **The race:** start a dictation, answer on the Mac before confirming, and check the device says
  "answered on your Mac" rather than hanging or sending.
- **The refusal:** a deliberately truncated capture must be refused rather than transcribed.

## Risks

- **The 90s window is not generous.** If real use shows confirmations landing late, the answer is
  to shorten the recording cap, not to raise `REMOTE_WAIT_MS` — that timeout is matched to the
  settings.json hook timeout, and raising one without the other silently breaks the wait.
- **Whisper mishearing remains possible.** The confirm step makes it visible rather than
  impossible; the user reads the text before it is authorised.
