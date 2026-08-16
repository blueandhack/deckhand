# Keyboard Answers — Design

**Status:** design, awaiting review · **Date:** 2026-08-15
**Sub-project:** 2 of 2 (voice shipped first; this is the deferred keyboard)
**Predecessor:** `docs/superpowers/specs/2026-08-15-voice-answers-design.md`

## Problem

A question can be answered by tapping one of up to four options, or by speaking. Speaking is not
always available: an office, a meeting, a sleeping house, or simply no microphone fitted. Typing
is the fallback that needs no hardware beyond the panel already there.

## The predecessor spec was wrong about the cost, and that is the main finding

It said the keyboard "reuses this wire format and this confirm step verbatim — the only difference
is where the text comes from." That is false, and reading `handleVoiceAnswer` is what shows it.

The voice path signs `sha16` of a transcript **the host is holding**: `handleVoiceAnswer` starts
with `pendingVoiceAnswers.get(pid)` and bails with "no pending transcript" when there isn't one,
then re-hashes its own copy and compares. A typed answer has no host-side copy at all, so it would
be rejected before any signature was examined.

So this needs a **new wire form that carries the text**, authenticated rather than compared. That
is a protocol change in the security-critical path, not a UI addition, which is why this is a spec
rather than a chat design.

## Scope

**Questions only** (`ask.kind === "question"`), for exactly the reasons the voice spec records:
`emitDecision` carries free text only for a question; a typed answer to a plan would take the
`answer.idx === 0` branch and be silently APPROVED with the words discarded, and a permission
prompt can only ever be denied. The host re-checks the kind before writing an answer file, the
same guard the voice review added.

**Claude Code asks only.** `REMOTE_WAIT_MS` is `AGENT === "codex" ? 15_000 : 90_000` — a Codex
prompt stays answerable for **15 seconds**, which is not enough to type a sentence. The device
already carries `agent` (`cc`/`cx`) per session, so TYPE is simply not offered on a `cx` ask. This
is the same rule the read-only ask already follows: never draw a control that cannot work. It is a
coupling to a constant in another file, so it is written down here — if Codex's hook timeout is
ever raised, this gate is what has to change with it.

## What is reused unchanged

- The per-prompt nonce (`askNonces`, single-use, consumed on success) and the pairing HMAC.
- `ask.answerable`, and the whole mirror-mode path — with answering off, no TYPE control appears.
- The host's `ask.kind === "question"` + matching-pid gate before any answer file is written.
- The answer file's shape: `idx: 0` with the text as `label`, which `chose = answer.label || …`
  turns into the tool result. **The hook is not modified.**
- `VOICE_ANSWER_TEXT_MAX_BYTES` (150) as the cap, so typed and spoken answers share one limit.

## Wire format

Existing (unchanged):

```
ANSWER <id12> <pid> <idx> <hmac>          hmac = HMAC(secret, "nonce:pid:idx")[:16]
ANSWER <id12> <pid> TEXT <sha16> <hmac>   hmac = HMAC(secret, "nonce:pid:TEXT:<sha16>")[:16]
```

New:

```
ANSWER <id12> <pid> TYPED <base64text> <hmac>
hmac = HMAC(secret, "nonce:pid:TYPED:<sha16>")[:16]   sha16 = sha256(text)[:16]
```

**Base64 because the parse is space-delimited** and the text contains spaces. 150 bytes encodes to
200 characters, well inside the line buffers. `TYPED` occupies the slot an option index would and
is not a valid integer, so an older host's `Number.isInteger` guard refuses it rather than
misreading it — the same property `TEXT` was chosen for.

The signature covers the **hash** rather than the base64, so the device and host agree on the
signed bytes without depending on base64 padding or case.

## Host verification, in order

1. A secret and an unconsumed nonce exist for this pid (this is also the replay check — consuming
   a nonce deletes its entry).
2. `mac` is well-formed; the base64 decodes.
3. **The decoded text is printable ASCII plus space, and at most `VOICE_ANSWER_TEXT_MAX_BYTES`.**
   The device can only produce that, but the host must not infer that a peer *is* our device from
   the frame merely looking right. The text ends up in a JSON answer file that the hook feeds to
   Claude as a decision message; control bytes have no business there.
4. The HMAC matches.
5. The session record still shows `ask.kind === "question"` with this pid.

Any failure logs loudly and drops, as today. Reject reasons must distinguish the tamper case (bad
HMAC) from the ordinary ones, the way `verifyVoiceAnswer` already does.

**This is the first time the host accepts device-authored text.** That is safe for the same reason
an option tap is: the HMAC proves it came from the paired device, and the device is trusted to
decide this prompt. What it is *not* is a reason to relax step 3 — the authentication proves
origin, not that the bytes are sensible.

## Device UI

**Entry.** SPEAK and TYPE share one half-width row, the way SOUND and NORMAL/FLIPPED already share
the settings page's bottom row, so `askOptionsTop()`'s row count does not grow and the options keep
their space. Where voice is unavailable (no `ask.voice`), TYPE takes the full width. The existing
`askVoiceRows()` becomes `askInputRows()` and stays shared between the draw and the hit test —
that sharing is what stops the buttons and their targets drifting apart.

**The keyboard owns the whole screen**, tab bar and footer included, the way the history reader
does. This is not cosmetic: it is what makes QWERTY viable on a 240px panel. Keys become 22x46px
(1012px² of target) instead of 22x40 within the content area.

```
 y   4..64    typed text, Cozette on a card, wrapped, with the countdown top-right
 y  68..252   four key rows, 46px each
 y 256..300   CANCEL | SEND
```

Key grid: 24px pitch, 22px keys.

```
row 1   q w e r t y u i o p            10 cells
row 2    a s d f g h j k l              9 cells, centred
row 3   ⇧ z x c v b n m ⌫              9 cells, centred
row 4   [?123]  [   space   ]  [.]     2 + 6 + 2 cells
```

`?123` swaps to a second page (digits on row 1, punctuation on rows 2-3, `ABC` to come back). `⇧`
is **one-shot**, not a lock — an answer rarely needs more than a leading capital, and a lock is a
mode with no indicator on a screen this size.

**Backspace only; no cursor movement.** Placing a caret on a resistive panel is fiddly and would
need its own hit-testing over wrapped text; for a ≤150-character answer, retyping past a mistake is
faster than aiming at it. This is a deliberate limit, not an omission.

**A pressed key inverts while the finger is down**, repainting only that key. On a resistive panel
with no haptics that is the only confirmation a press registered, and getting it wrong reads as a
dropped keystroke.

**No separate confirm screen.** Voice has one because a machine produced the words and a human must
verify them; here the human typed them and watched each appear. SEND is the confirmation. Adding a
second one would be ceremony, and it would spend budget (below) that typing needs.

## The 90-second budget, and the two failure modes it creates

The hook blocks for `REMOTE_WAIT_MS` and that is the whole window. A 20-second recording cannot
exhaust it; typing plausibly can.

- **A countdown** rides on the ask, shown top-right of the text card, amber under 20s. The host
  computes it from when it FIRST saw this pid plus the wait budget — which needs a **new `first`
  field on the nonce entry**, set once at creation. `seen` cannot be used and this is not a
  detail: `nonceForPid` refreshes `seen` on every tick (`e.seen = Date.now()`) so that the entry
  survives pruning, so a countdown derived from it would sit at the full budget forever and never
  decrease. `first` is set in the same `if (!e)` branch that mints the nonce and is never
  written again. **This
  duplicates the hook's 90_000 in the host**, which the repo generally treats as a hazard — it is
  accepted here only because the value is *advisory*: if it drifts, the countdown is wrong and
  nothing else is. It must never gate whether an answer is sent.
- **If the window closes mid-typing the text STAYS ON SCREEN**, under "THE WINDOW CLOSED — ANSWER
  ON YOUR MAC", with SEND withheld. Today an ask vanishing from the payload closes the screen, which
  would silently discard everything typed. Losing a sentence someone spent 60 seconds on, with no
  explanation, is the worst outcome available here.

## Failure modes

| | |
|---|---|
| The Mac answers first | The ask disappears; the screen keeps the text and says to answer on the Mac |
| The window expires mid-typing | As above — SEND withheld, text retained |
| Empty text | SEND is inert; there is nothing to send and a blank deny message would confuse Claude |
| Text exceeds 150 bytes | Keys stop inserting at the cap and the counter turns amber; nothing is silently truncated |
| Bad/missing HMAC | Host logs and drops, loudly, distinguishing tamper from an ordinary reject |
| Non-printable bytes | Host rejects — the device cannot produce them, so this is a foreign peer |

## Verification

- **Host-side, automated**, extending `host/voice-answer-check.mjs`: valid typed answer accepted;
  tampered text, tampered hash, wrong nonce, wrong pid, wrong device, malformed base64,
  over-length, and control-byte payloads all rejected. This is the security-critical half and needs
  no hardware.
- **On the device:** type an answer to a real `AskUserQuestion`, send, and confirm it reaches Claude
  as the tool result.
- **The race:** start typing, answer on the Mac, and confirm the text is retained with SEND
  withheld rather than the screen vanishing.
- **The cap:** hold a key past 150 bytes and confirm insertion stops rather than truncating.
- **Codex:** confirm no TYPE control appears on a `cx` ask.

## Risks

- **The countdown's duplicated constant** (above). Advisory only, and named here so a future change
  to `REMOTE_WAIT_MS` has a chance of finding it.
- **Typing on a resistive panel at 22px will not be pleasant**, and no layout choice fixes that —
  the panel is 240px wide. This is a fallback for when speaking is not an option, not a better
  input method than voice.
- **The device becomes a text source the host must sanitise.** Step 3 above is the whole mitigation
  and must not be softened on the grounds that the HMAC already passed.

## As built

The shipped layout differs from the mock above in three ways; noted here rather than editing the
mock, which was the actual proposal at the time.

- **Bands are `4..92` / `96..272` (rows 44px each) / `276..320`**, not `4..64` / `68..252` (46px) /
  `256..300`. The text card grew 60px → 88px to fit a reserved meta row (byte counter and countdown)
  that doesn't share a line with any wrapped text — see `keyboard.ino`'s header comment for why
  that row had to be carved out on its own.
- **Drawn keys are 22x40 with a 22x44 touch band**, not 22x46. `KB_ROW_H` is 44 (4px over `TAP_MIN`),
  and the drawn key is `KB_ROW_H - 4`; the touch test still covers the full 44px row.
- **The glyphs are `CAP`/`DEL`, not `⇧`/`⌫`.** Cozette, the on-device font, is ASCII 0x20–0x7E only —
  there is no glyph for a shift arrow or a backspace, and drawing one would paint a blank box.
