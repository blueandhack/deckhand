# Typed messages to a READY session — design

**Status:** approved for planning
**Date:** 2026-08-19

## What this adds

A session sitting at **READY** (`status: "waiting"`) can be sent a typed message
from the device: open its detail screen, tap **TYPE A MESSAGE**, type on the
existing QWERTY keyboard, tap SEND.

## What it is not

**There is no way to inject a prompt into a live interactive Claude Code
session.** That was established by investigation, not assumption (see CLAUDE.md:
the transcript's `queue-operation` records are an effect the app writes, not an
input; no queue file exists under `~/.claude`; `--resume`/`--continue` start a new
process against a session's history; the `~/.claude/ide/<port>.lock` websocket
belongs to the VS Code integration and delivers to whichever editor holds the
lock). So "send to the session" resolves to one of the two deliveries the host
already implements, and nothing here changes that constraint.

## Why this is small

The mic half of this path already exists. The record button is visible on a plain
session detail screen precisely so a dictation can be aimed at a session; the host
transcribes it, stamps `target=<id12>`, and delivers it per
`DECKHAND_VOICE_DELIVERY`. This feature is the **keyboard half of the same path**:

| piece | state |
|---|---|
| on-screen QWERTY, 150-byte cap, hard wrap, caret, caps, DEL repeat | exists (`keyboard.ino`) |
| strict text sanitiser (`typedTextOk`, `decodeTypedText`) | exists (`host/typed-answer.mjs`) |
| clipboard + notification delivery | exists (`copyToClipboard`) |
| dispatch delivery (`claude -p --resume <id> <text>`) | exists |
| result surfaced on the device card and the menu bar (`lastVoice`) | exists |
| **authenticated frame carrying text against a SESSION rather than an ask** | **new** |
| **per-session nonce** | **new** |
| **entry point on a plain READY detail screen** | **new** |
| **keyboard in "prompt" mode rather than "answer" mode** | **new** |

## Decisions taken

- **Delivery follows `DECKHAND_VOICE_DELIVERY`** — one switch for the mic and the
  keyboard, so the two cannot drift. Default (`clipboard`) means SEND copies the
  text to the Mac and posts a notification naming the project; `dispatch` runs it
  headlessly. This is stated plainly in the UI copy and the README because with
  the default, **SEND does not run anything** — it hands you text to paste.
- **READY only.** READY means nobody is mid-turn, which is what makes this safe;
  the voice path already found that a headless run alongside an active turn
  becomes a second author on one conversation, with neither able to see the other.
- **150-byte cap, unchanged.** `ANSWER_TEXT_MAX_BYTES` is already shared by the
  voice and typed answer forms, and the keyboard's 5-line card budget is derived
  from it (`ceil(150 / 34) = 5`). Raising it for prompts would require a taller
  card and a re-derived line budget for no clear gain — a typed instruction that
  matters ("run the failing tests and summarise what broke", 47 bytes) fits.

## Wire protocol

```
PROMPT <id12> <base64text> <hmac>
```

`hmac = HMAC-SHA256(secret, "<nonce>:<id12>:PROMPT:<sha16>")[:16]`, where
`sha16 = SHA-256(text)[:16]` over the **capped** bytes the device displayed.

Three properties, each mirroring an existing one for the same reason:

- **`PROMPT` is a distinct label from `TEXT` (voice answer) and `TYPED` (typed
  answer)**, so a signature minted for one form cannot authenticate another —
  the same separation those two already keep from each other.
- **The hash covers exactly the bytes on screen.** Cap before hashing, in BYTES,
  via `capUtf8` — hashing first would sign text the human never saw.
- **The nonce is single-use**, consumed on success, so a captured frame cannot
  re-run the same instruction later.

### Per-session nonce

`askNonces` is keyed by an ask's pid; a READY session has no pid. A parallel
`promptNonces` map keyed by the **full** session id, published as `pnonce` on each
session object in the payload **only while that session's status is `waiting`** —
absent otherwise, so the device is never holding a credential for a state where it
must not type. Same 60s-idle pruning as `askNonces`, with `seen` refreshed per tick
so a nonce survives while the session stays READY.

Device cost: `char promptNonce[17]` on `SessionInfo` (~102 bytes of DRAM across the
6 slots) plus the same field on `PrevSession` **only if** the diff reads it — it
does not, so it stays off `PrevSession`.

## Host-side gate (not optional)

`handleDeviceLine` gains a `PROMPT ` branch that, in order:

1. Parses the three fields; a malformed frame is rejected and logged.
2. `decodeTypedText` — the existing strict decode: re-encodes its own base64 and
   rejects any mismatch (Node's decoder silently drops characters it does not
   recognise), then requires non-empty printable ASCII within the byte cap. The
   HMAC proves the bytes came from the paired device; it proves nothing about
   whether they are sensible, which is what the sanitiser is for.
3. Resolves `<id12>` against the host's own session records to the **full**
   session id, exact-match on the stored id's first 12 characters.
4. **Re-checks that the session's status is `waiting`.** The device's own gate must
   not be the only gate — the identical reason `handleVoiceAnswer` re-reads the
   record before writing an answer file. A missing record or any other status
   aborts rather than falling through.
5. Verifies the HMAC with the key for `deviceNameFor(via)` and that session's
   nonce, then consumes the nonce.
6. Delivers per `VOICE_DELIVERY`, and publishes the exchange on `lastVoice` so the
   device's result card and the menu bar's dictation row show it with no new
   surface.

## Device side

**Entry point.** On a plain detail screen (no ask pending) whose status is
`waiting`, a full-width **TYPE A MESSAGE** button occupies the band where an ask's
option stack would sit — currently empty on such a screen. It is drawn and
hit-tested from one helper so the button and its target cannot disagree, the way
`askInputRows()` already guarantees for SPEAK/TYPE.

**Keyboard mode.** `openKeyboard` gains a mode. In prompt mode:

- `kbPid` is empty; the keyboard pins the session **id** instead, and the tick
  absorber matches on that id rather than `askPid`.
- The empty-box placeholder reads `Message <name>` rather than a question, since
  there is no question — and the peek is **not** offered, because the detail
  screen you came from already shows the title, last prompt and path. No hint
  line is drawn, so no control is advertised that does nothing.
- **No countdown.** There is no 90s hook window here; nothing is waiting on this.
  The meta row shows the byte counter alone.
- If the session leaves the list or leaves READY, SEND is withheld the way
  `kbWindowClosed` already does for an expired ask — **the text is kept**, and the
  action row explains why. Discarding a typed sentence with no explanation is the
  worst outcome available, and that rule already exists here.

**Feedback.** SEND closes back to the detail screen; the existing voice result
card raises when the host publishes the exchange (`clip` is already in the
card-raise list, so the default delivery is not silent).

## Verification

Every device screen is reachable without a person at the glass via the existing
`KBTEST` scaffolding, extended with a mode that targets a READY session. Screens
to capture: the TYPE A MESSAGE button on a READY detail screen, the keyboard in
prompt mode (placeholder, no countdown, no peek hint), and the withheld-SEND state
after the session leaves READY.

Host-side, `host/typed-answer-check.mjs` gains cases for the new form: a tampered
text, a tampered hash, a nonce from a different session, a frame against a
non-READY session, and a signature minted with the `TYPED` label (which must not
authenticate a `PROMPT`). These run without hardware, like the existing checks.

## Risks

1. **`dispatch` remains a second author.** Sending to READY narrows the window —
   nobody is mid-turn — but the interactive app is not told that a headless turn
   happened. Unverified whether the app picks up the appended history on its next
   turn. The default delivery avoids this entirely.
2. **A dispatched run that needs permission halts.** Measured previously: a
   headless `claude -p` fires no `PermissionRequest`, so such a run reports back
   instead of completing. Read/analysis instructions are the good use.
3. **id12 truncation.** 12 hex characters make a collision negligible, but the
   lookup must be an exact prefix match against stored records rather than a
   `startsWith` scan that could match two.
