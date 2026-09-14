# Speech fills the draft

> Design spec. Approved from the interactive bench on 2026-09-13. **Nothing below is
> measured on hardware yet**; every number quoted is parsed from a board header or from
> `host/`, and the list of things nobody has measured is at the end rather than implied.

Voice and typing are two parallel screens today. A spoken answer ends at a confirm screen
that offers SEND, RE-RECORD and CANCEL and no way to change one character; a typed answer
goes to the compose surface, where the draft is editable, chips paste real tokens and
recents come back. This folds the first into the second.

## Why, in one example

Ask a question whose answer is a filename and Whisper will not spell it. A real transcript
of `board_es3c35p.h` comes back as *"the es three c thirty five p header"*. On the confirm
screen the only moves are RE-RECORD and give up. On the panel, the ask's own chips already
carry `board_es3c35p.h` as a one-tap insert, so the fix is CLR, tap the chip, SEND.

The same argument applies to dictation, where it has already cost something real: the
reference file records a mis-heard *"make sure there is no sensitive data and **some**
sensitive information"* going to work with half the instruction inverted.

## The shape

**One draft, two ways to fill it.** `kbText` / `kbLen` / `kbCaret` belong to the compose
surface and are the only place answer text lives. Speech is an *insert* into that draft,
exactly as a chip is.

```
SPEAK (ask screen) ---> compose panel, recording ---> transcript INSERTED at the caret
REPLY (ask screen) ---> compose panel, empty draft
SPK   (draft line) ---> record again, INSERT again
                              |
                   edit / chip / CLR / speak again
                              |
                              v
                  SEND  -->  ANSWER <id12> <pid> TYPED <b64> <hmac>
```

### Decisions taken here, with their reasons

1. **SPEAK lives on the draft line, beside `CLR`, and NOT on keyboard row 3.**
   The draft line is already the single entry in the `EXCEPTIONS` sub-floor list - 21px
   tall on board 1 against a `TAP_MIN` of 40, sub-floor in height with a full-width tested
   zone - so a second key beside `CLR` is *the same* named exception rather than a new one.
   Row 3 was rejected: it is `[?123 | 2 cells][SPACE | 6][. | 2]` = exactly 10 cells and
   closes on `BOARD_W`, so SPK there costs SPACE a cell. The panel is one `BACK` tap away
   from the keys, which is a cheaper price than shrinking the most-used key on the board.
   A fourth action column was rejected on arithmetic: `fracs {1,1,1,2}` gives 38px columns
   against a 40px floor.

2. **The transcript is INSERTED AT THE CARET, never a replacement.**
   Insert is the operation the surface already has, and it is what makes "speak a sentence,
   then tap a chip for the path" work. Replacing would silently destroy typed text, which is
   the worst available outcome for a control whose whole purpose is that you can fix things.
   It is capped the same way every insert is, at `KB_MAX_BYTES` 150, and a capture that
   would overflow inserts what fits and says so rather than failing whole.

3. **A spoken answer is device-authored text and goes out over the TYPED frame.**
   `ANSWER <id12> <pid> TYPED <base64text> <hmac>`, signed `nonce:pid:TYPED:<sha16>`. The
   voice-only `nonce:pid:TEXT:<sha16>` form, `handleVoiceAnswer` and the host's parked
   transcript store are **deleted**, not left beside it - two wire forms for one act is how
   the `askVoiceCancelSha` dead end happened. `typedTextOk()` (printable ASCII, <=150 bytes)
   now gates transcripts, which is a real tightening: see Consequences.

4. **The transcript reaches the device on the EXISTING `voice` object, keyed by `voice.seq`
   and addressed by `voice.pid`.**
   `ask.voiceText` / `ask.voiceSha` are removed from the ask object. The host publishes the
   transcript as `voice.state = "askheard"` with `voice.text` **and `voice.pid`**, and the
   device inserts it once, when it sees a `seq` it has not applied. This reuses machinery that
   already works, including the host-generation reset when `seq` goes BACKWARDS after a host
   restart.
   **The seq guard is load-bearing:** the payload is republished every ~5s and delivered over
   BOTH transports, so an insert keyed on anything but a sequence number would paste the same
   sentence repeatedly. `voiceSeqApplied` is that guard and is device-local.
   **`voice.pid` is equally load-bearing, and for a different reason.** `voice` is ONE object
   per host while asks are per session, so a transcript carries no session of its own. The
   device inserts only when `voice.pid` matches the ask the compose surface was opened for.
   Without it, a transcript captured against one pending ask would paste into a draft being
   composed for another - and with several sessions waiting, that is not a rare case. A
   transcript whose pid matches nothing on screen is DROPPED and says so on the serial log,
   rather than inserting somewhere plausible.

5. **`MIC_ANSWER_MAX_MS` stays at 20s, and the reason is a correction.**
   The obvious objection to putting an edit inside the answer window is that the window is
   90s. **It is not, and `docs/reference/audio-and-voice.md` is stale on this point.**
   `readRemoteWaitMs()` (`claude-hooks/deckhand-session-hook.mjs:121`) reads
   `~/.claude/deckhand-remote-wait`, and with that file ABSENT - which it is on this machine -
   returns `REMOTE_WAIT_CAP_MS`, `(HOOK_TIMEOUT_S - 60) * 1000` = **23h59m**. The default for
   Claude Code is *forever*, capped only so the hook self-exits before Claude Code kills it.
   So there is no reading clock to race for `cc`, and 20s of speech (~60 words) is already far
   more than a typical answer. The reference file is corrected in place as part of this work.
   **Codex is the exception and is unchanged:** `AGENT === "codex"` returns a hard `15_000`
   before the config is even consulted, which is why the Codex exclusion below still stands.

6. **Dictation to a session gets the same treatment, as a SECOND STAGE.** Stage 1 is ask
   answers and is self-contained. Stage 2 adds `DECKHAND_VOICE_DELIVERY=draft` (a new mode,
   made the default) which routes a dictation into the compose surface's message mode rather
   than posting it into the live session. `inbox`, `clipboard` and `dispatch` stay as escape
   hatches. Staged because Stage 2 depends on device-side session targeting that Stage 1 does
   not need, and shipping half of Stage 2 would be worse than shipping none.

## Five implementation constraints, four found by reading and one by tracing

These are the reason the change is bigger than "move a transcript". Each was found before a
line was written, and each would have been a silent failure.

1. **`handleLine()` RETURNS EARLY WHILE `composeActive`, before the voice block runs.**
   `deckhand_display.ino:5057` intercepts the ~5s tick while the compose surface is up (it
   re-resolves the countdown and returns, so the session list underneath is never repainted)
   - and the entire voice parse lives at `:5117-5209`, *after* it. So with the surface up the
   device currently never reads `voice` at all: no transcript, no `working` upgrade, no
   result. **The transcript can only arrive on the very screen that is deaf to it.** The early
   return must keep absorbing the repaint while still parsing voice. This is the single
   change without which nothing else in this design functions.

2. **The recording pill would land on top of the panel's own controls.**
   `micPillY()` is `contentBottom() - MIC_PILL_H - 8` - board 1 y230..294, board 2 y388..452 -
   which covers the draft line's last rows, the recents legend and the whole action row. The
   pill is 64px and the token band is 40/46, so the band cannot simply host the pill. The
   recorder therefore draws into the token band as its own thing while `composeActive`, and
   the pill stays what it is for a dictation from the tab bar.

3. **`micRestoreUi()` destroys the compose surface.** It falls through to
   `forceFullRepaint()`, which paints a TAB. Called after every capture, that would end a
   spoken answer by throwing away the draft it just filled. It needs a `composeActive` arm
   that repaints the surface instead - and that arm is also what closes the pre-existing hole
   where a serial `MICSTREAM` over the keyboard ends, 35s later, with a tab painted over a
   still-`composeActive` device and every tap going to invisible controls.

4. **The `MIC*` serial verbs have no full-screen-surface guard.** `SCROLLOPEN`, `SCROLLPERF`,
   `EMOJITEST` and `TAB` each refuse by name on `composeActive`; `MICSTREAM`, `MICREC`,
   `MICMON` and `MICTEST` do not. That is pre-existing, and this design makes it worse by
   making the compose surface a voice surface. They gain a refusal that names its cause, and
   `commands-check.mjs` covers them.

5. **THE PROCESSING BAR COVERS THE PANEL'S OWN CONTROLS, AND `handleTouch` DISPATCHES
   UNDERNEATH IT.** Found by tracing rather than by a checker, after the rest was written.
   `handleTouch`'s `composeActive` branch returns before the `micProcessing` arm that
   normally dismisses the bar, so with the bar up over the panel a tap goes straight into
   `composeTouch` - and `micPillY()` is `contentBottom() - MIC_PILL_H - 8`, board 1 y230..294
   against an action band at 280..319. **A tap at y285 hits SEND or DISCARD with the bar drawn
   on top of them.** Invisible controls taking taps is the exact class `fabVisible()`'s own
   `composeActive` check was already paid for once. Fixed by giving the bar the tap inside that
   branch, which is what every other screen already does with it.

**One pre-existing defect is fixed in passing because it is squarely in this path:** the two
boards disagree about the recording title for the same action. Board 1 asks
`showingDetail ? "DICTATING" : "LISTENING"` (`audio.ino:736`) and board 2 asks
`micAnswerPid[0] ? "LISTENING" : "DICTATING"` (`audio.ino:1466`) - so an ask-screen answer
reads DICTATING on one board and LISTENING on the other. `micAnswerPid[0]` is the correct
question on both; nothing bound it, which is why it survived.

## What the panel looks like

The column is unchanged - no band moves, and the contiguity walk keeps its current output.
Only the draft line's interior changes:

| | board 1 | board 2 |
|---|---|---|
| draft line band | `212..232`, 21px | `273..296`, 24px |
| `CLR` key | `x = CARD_X + CARD_W - TAP_MIN` = 188 | 262 |
| **`SPK` key (new)** | `x = clrX - TAP_MIN` = 148 | 216 |
| text lane before | `CARD_W - 12 - TAP_MIN` = 164px = **27 chars** | 238px = **29 chars** |
| text lane after | `composeDraftLaneW()` = 124px = **20 chars** | 192px = **24 chars** |

**Seven characters of visible draft on board 1 is the price** (five on board 2), and it is the
reason option A was not free. The character counts in an earlier draft of this spec said 16 and
12; that was wrong and is corrected here - it assumed `T_BODY` advanced 10px on board 1, and it
advances **6**. The pixel figures were right throughout. Measured by the checker, which parses
`composeDraftLaneW()` rather than restating it. The full draft is always readable one `TYPE...` tap away, where the card wraps to
`KB_TEXT_LINES` 5 lines at `KB_COLS` 34/35.

While a capture runs, **the token band and its legend become the recorder** (board 1
`172..211`, board 2 `227..272`). The reply bands above stay live, so an option is still one
tap away from a recording you have changed your mind about. The recorder carries a level bar
while LISTENING and an **indeterminate sweep** while TRANSCRIBING - never a percentage,
because Whisper's progress is not observable and a filling bar would be inventing one.

## What comes out

| removed | because |
|---|---|
| `askVoiceText[204]` x `MAX_SESSIONS` | the transcript lives in `kbText`. **1,584 bytes of DRAM back, measured** by compiling both boards (73,492 -> 71,908 and 73,348 -> 71,764) - more than the ~1,224 estimated here, which counted only `askVoiceText` and not the two sha fields in both structs. It matters on the board where a contiguous heap block is what caps a capture. |
| `askVoiceSha`, `askVoiceCancelSha`, `hadVoiceText` | all three police a transcript the device cannot change. The cancel-suppression dead end - re-speak the same words, hash identically, stay invisible forever - goes with them. |
| `askVoiceTooLong()` and the 8-line wrap budget | a property of a screen that no longer exists. The draft's 150-byte cap is the only cap left. |
| the confirm screen in `sessions.ino` | replaced by the panel. |
| `handleVoiceAnswer` + the parked transcript store | the host stops holding text for five minutes and republishing it. |
| the `nonce:pid:TEXT:<sha16>` signing form | one wire form for one act. |
| the `askheard` raise-no-card special case | it existed only because a card would have covered the confirm screen arriving underneath it. |
| `wire-ascii.mjs`'s `UNSAFE_TO_REPAIR` entry for `voiceText`/`voiceSha` | it suppresses rather than repairs a non-ASCII transcript, because the device signed a sha the host computed and a repaired string would be read but not signed. With the device hashing its own draft, a repair is no longer unsafe - and the field it guards no longer exists on the ask object. |
| `voiceConfirmGone` and its `closeSessionDetail()` call | it exists only to tear down the confirm screen when the Mac answers first. The panel already handles a vanishing ask. |
| `ASK_VOICE_MAX_LINES` and the `static_assert` under it | both describe the confirm panel's height against its own SEND button. `geom-sweep.mjs` loses a perturbation target, which is a real cost and is why it is named here rather than dropped quietly. |

`capUtf8` and `ANSWER_TEXT_MAX_BYTES` **stay** - the host still caps a transcript on a
codepoint boundary before it is ever sent to a device with a fixed buffer.

## Consequences, stated rather than discovered later

- **There is no reading clock for Claude Code, and the claim that there is was wrong.**
  This design was drafted believing `REMOTE_WAIT_MS` was 90s and that an edit had to fit
  inside it. Measured instead: with no `~/.claude/deckhand-remote-wait` (the state of this
  machine), the hook waits `REMOTE_WAIT_CAP_MS` = 23h59m. The consequence survives only for
  **Codex**, whose 15s is hard-coded ahead of the config read - and Codex is already excluded
  from answering here for exactly that reason. Kept rather than deleted, because a reader who
  re-derives the concern from the stale reference file would reach the same wrong place.
- **The host stops proving the words are Whisper's.** Today one HMAC proves both *a paired
  device authorised this* and *a human read exactly these words*. Afterwards only the first.
  That is the point of an editable draft, not a regression - and the second claim was always
  thin, since SEND is one tap and reading is not enforceable.
- **Whisper's punctuation must now pass `typedTextOk()`.** Printable ASCII only, and Whisper
  emits curly quotes and em-dashes freely at 3 bytes each. `host/to-ascii.mjs` stops being
  about legibility and becomes load-bearing for acceptance: a transcript that reaches the
  device with a smart quote intact is a *rejected answer*, not merely an ugly one.
- **Codex is still out.** `askTypeOffered()` hides TYPE on `agent == "cx"` because that
  window is 15s, not 90. Voice-to-answer inherits the same refusal. Nothing short of changing
  the Codex hook's wait fixes it, and that is not in scope.

## Verification

New and changed checkers, each of which must FAIL when the constant it certifies is reverted:

- `host/voice-answer-check.mjs` - rewritten. The TEXT-form reject cases go; what stays is
  `capUtf8`'s codepoint safety and the TYPED form's reject cases (tampered text, tampered
  hash, wrong nonce, wrong pid, wrong device, malformed mac).
- **`firmware/deckhand_display/settings-geom-check.mjs` - and it is that file, not
  `sessions-geom-check.mjs`.** The compose surface's entire geometry block lives in the
  settings checker (`:4791-5347`); the sessions checker contains *no* assertion about the
  panel at all. Getting this wrong would have meant editing a file that constrains nothing.
- `docs/design/compose/check.mjs` + `docs/design/compose/compose.js` - the mock must DRAW the
  new key, and three of its assertions are hard stops: the sub-floor control list is the
  literal `want = ["CLR"]` (`:805`), the `EXCEPTIONS` entry covering CLR is **label-scoped**
  so a second key inherits no cover, and two controls in one band may not have overlapping
  tested rects.

**Three blind spots found while mapping, which this work closes rather than inherits.** Each
is a place the existing checkers would stay green through a real mistake:

- `settings-geom-check.mjs:4862` measures `clrW = CARD_X + CARD_W - composeClrX()`. Move CLR
  left to make room and that number *grows* and still passes, while now silently measuring a
  zone containing both keys. It is the only width claim about the line.
- **Nothing anywhere asserts the draft line's text lane.** The firmware computes
  `CARD_W - 12 - TAP_MIN` inside `drawComposeDraft`; the mock computes its own `dlLane`; no
  checker compares them. The lane is exactly what this design trades away (16 -> 12 chars on
  board 1), so it gets a real assertion, parsed from the firmware's own expression.
- `settings-geom-check.mjs:5189` is the only assertion that parses `drawComposeDraft`'s body,
  and it asserts the band clear alone - nothing counts the controls that function draws.
- A new `host/voice-draft-check.mjs` binding the once-only insert rule: a repeated `voice.seq`
  must not insert twice, and a `seq` going backwards must reset the generation.

**What cannot be verified here:** board 1 is not attached to this Mac, so nothing in this
change has been seen on its glass. Board 2 is attached, but its `SCREENSHOT` reads the shadow
framebuffer, so a capture vouches for GEOMETRY and for nothing the panel's colour pipeline
did with it.

## Not verified, and named as such

- **That editing a transcript is faster than re-recording it.** The whole design rests on it.
  Nobody has timed either.
- **That most answers are short enough for a 150-byte draft.** Already the compose surface's
  own unverified premise; the host has the history and has still not been asked.
- **That a 12-character draft window is enough to know what you said.** Arithmetic only.
- **That release-commit cuts keyboard mis-hits.** `KBPROBE` still reads 0 keystrokes, and this
  design leans harder on the keyboard than the last one did.

---

## Implementation status, 2026-09-13

**Stage 1 (answering an ask by voice) is BUILT on branch `voice-draft`. Stage 2 (dictation
into a reviewable draft) is NOT, and is deliberately not half-built.**

What landed, and what verifies it:

| | evidence |
|---|---|
| both boards compile | board 1 `1420592` / `751c9bd2f4372711`, board 2 `1066192` / `02b60a69afb533b8` - baselines re-recorded, `--doc-check` green |
| **1,504 bytes of DRAM freed** | measured: board 1 `73,492 -> 71,988`, board 2 `73,348 -> 71,844`. (It was 1,584 before the review fixes added `composeVoiceMsg[48]` and two statics - the failure message is worth 80 bytes.) |
| the 35 offline checkers | all pass |
| `settings-geom-check.mjs` | assertions for SPK, the draft lane and all three transcript-ownership tests; **32/32 selftest faults caught** |
| `sessions-geom-check.mjs` | confirm-panel assertions removed, signature budget re-derived, 10/10 faults caught |
| `docs/design/compose` | mock draws SPK; `3689/3689` assertions (was 3656); selftest passes |
| `host/voice-answer-check.mjs` | TEXT-form block removed, **`--selftest` ADDED where there was none, 5/5 caught** |
| `host/wire-bytes-check.mjs` | park-site assertions replaced by four binding the new invariant, 42/42 faults caught |
| `geom-sweep.mjs` | exit 0, 686/778 constant-board pairs guarded |

**NOT VERIFIED ON HARDWARE, and this is the honest gap.** Board 1 is not attached to this
Mac, so **nothing in this change has been seen on its glass** - and board 1 is the board whose
draft lane loses seven characters. Board 2 is attached, but its `SCREENSHOT` reads the shadow
framebuffer, so a capture from it would vouch for geometry and for nothing the panel's colour
pipeline did. **No finger has touched SPK, no transcript has actually been inserted into a
draft, and the once-only seq guard has never run against a real double delivery.** Everything
above is compile-time and checker evidence.

### The first three things to do at the device

1. Raise a real question, tap `SPEAK`, and watch a transcript land in the draft. That single
   gesture exercises the `handleLine` early-return fix, `composeAbsorbVoice`, the pid match and
   `micRestoreUi`'s new arm at once.
2. Watch it for three ticks afterwards. **The sentence must appear exactly once** - the payload
   is republished every ~5s over both transports, and `voiceSeqApplied` is the only thing
   standing between that and the same words pasted in repeatedly.
3. `MICSTREAM` from the trigger file with the compose surface up: it must now refuse by name.


## An adversarial review ran over the finished diff, and found nine real defects

Worth recording as a list, because six of the nine were **introduced by this work** and three
were pre-existing things it made reachable. None was visible to the 35 green checkers.

| | found |
|---|---|
| **`askerror` became invisible** | The voice card's raise is gated `!composeActive`, and SPEAK now *always* raises the surface - so the one path that can produce an answer capture could no longer report a failure. Tap SPEAK, say nothing intelligible, and the bar vanished with the draft unchanged: identical glass to "whisper is not installed" and to "the cable fell out". This is the exact failure the *previous* design had explicitly fixed. Now shown in the panel's own legend, in the host's words. |
| **A stale transcript could be pasted minutes later** | `voiceSeqApplied` only advanced while the surface was up, and the host republishes `voice` every tick for its whole life without ever clearing it. Abandon a capture, reopen the panel on the same ask, and the next tick pasted the old transcript into a draft being typed by hand. The main block now consumes the mark too. |
| **The separator was measured at the wrong end** | `kbText[kbLen - 1]` while `kbInsert` splices at `kbCaret`. Put the caret mid-draft, speak, and the space landed there while the real join got none. |
| **Two of my new assertions could not fail** | `laneW + 6 <= spkX - CARD_X + CARD_X` - the terms cancel - and `laneCols >= 12` over a fully determined value, whose message *transcribed* numbers the checker computed nowhere. Both replaced with falsifiable claims. |
| **My `--selftest` tested nothing** | Its five "faults" were restatements of assertions in the same file; deleting every `check()` still printed `5/5 caught`. And `process.exit` ignored `failed`, so a red checker exited 0. Now five real source mutations against imported copies, and the exit code consults both. |
| **A confirm-panel assertion survived in `settings-geom-check.mjs`** | Asserting an "8-line cap" whose constant had been deleted - a bare literal nothing could revert. |
| **The signature-budget comment went internally inconsistent** | Only the first line of a chain of running totals was updated; every figure below it was out by 21, and the "live numbers" it quoted were stale by 20. |
| **`composeInsertChip` could paint the panel over the keyboard** | `composeAfterEdit()` had no `composeOnPanel()` guard - harmless while only `kbInsert` called it (which guards), reachable once a transcript could arrive on either screen. |
| **The SPK band swallowed taps in silence** | When the key is not drawn the band still consumed the tap with no message, in a function where every other decline names its cause. It also narrowed the draft lane for a key that was not there. |

### The residual hole is now CLOSED, and the shape of the fix is the interesting part

The review left one defect named rather than fixed: `composeAbsorbVoice` matched a transcript
to a draft on **pid alone**, and pids are per-machine, so two Macs can raise the same one.

**The obvious guard could not be used.** `handleLine`'s own session match forty lines earlier
requires `hostSlot == kbHostSlot` for exactly this reason - but audio leaves the device over
`Serial`, to whichever Mac holds the **cable**, regardless of which host owns the ask. So a
transcript legitimately arrives on a link that is not the draft's host whenever you are cabled
to A and composing for B. Requiring `curLink == kbHostSlot` would have broken the ordinary
two-Mac case in order to close a rare one.

**So the test is AMBIGUITY, not identity.** `composeAbsorbVoice` walks `sessions[]` and counts
how many visible asks carry the incoming pid. One is unambiguous and inserts - the cabled
cross-host case still works. More than one and the device cannot know which was spoken for, so
it **refuses and says so**, which is the only outcome that is never wrong. Bounded by
`MAX_SESSIONS`, on a path that already blocked for seconds inside `micStream`.

What it still does not cover, stated: an ask that is **not in `sessions[]`** cannot be counted -
but it also cannot be confused with anything on the glass, so there is nothing on screen for the
transcript to land in wrongly.

**All three ownership tests are now bound** to `composeAbsorbVoice`'s own body in
`settings-geom-check.mjs` - the seq gate, the pid match and the ambiguity walk - each with its
own source fault. Deleting any one of them fails by name (`source faults: 32/32 caught`).

### Two more defects found while closing it

- **`wire-bytes-check.mjs` had a silently degraded fault.** One selftest entry's second
  replacement targeted `item.ask.voiceText = pend.text;` - a line this branch deleted - so it
  became a no-op and the fault collapsed into a duplicate of the one above it. Forty-two faults
  that were really forty-one. Replaced with a distinct fault against `voice.pid`.
- **An assertion caught the right fault for the wrong reason.** `voiceXlateBeforePublish`
  anchored on `setVoice("askheard", { text, pid })` including its argument list, so removing the
  pid made its `indexOf` return -1 and *it* failed rather than `voiceCarriesPid`. A checker
  reporting the wrong cause is a checker that will mislead the next reader; it now anchors on
  the call alone.

## Three agents read the finished work, and the message half was the half nothing bound

A workflow audit against the mock, a hunt for blocking-draw defects, and a second adversarial
review ran over the branch. Between them they found sixteen things. **The pattern is one
sentence: the ANSWER path was bound and the MESSAGE path was not.** `grep -rn msgheard` over
every `.mjs` in the tree returned one line - the host's own `setVoice` - so four independent
failures of the message half were all silent at once, and every one of them was reachable from
the SPEAK chip the user actually taps.

### The four silent message failures

- **The transcript was addressed by the wrong global.** Both `micStream` arms built the capture
  header's `target` from `showingDetail`/`detailIndex` - the DETAIL SCREEN's state, which has no
  relation to the draft the words have to come back to. It agreed only because SPEAK happens to
  be tapped on a detail screen. Opened any other way the header carried `target=-`, the host
  published `memo`, and `composeAbsorbVoice` consumed the sequence number and inserted nothing.
  Twenty seconds of speech, no text, no refusal. It is `kbSessionId` now - the draft's own - the
  way the answer path has always used `kbPid`.
- **Two host returns published nothing at all.** `transcribeAndDispatch`'s decode-failure catch
  and its `if (!text)` both returned with no `setVoice`, where the answer path's twins set
  `askerror`. The device cannot tell "nothing was published" from "still in flight": the bar sat
  on PROCESSING until `MIC_PROC_GIVEUP_MS` and then said NO REPLY FROM MAC, which is a lie about
  *where* it failed. Both publish `msgerror` now.
- **The failure legend was drawn on a screen a message never reaches.** `composeVoiceMsg` was
  written by `composeAbsorbVoice` and read in exactly one place - `drawCompose()`'s INSERT
  legend, which is on the PANEL. A message has no panel. So every message failure composed its
  sentence and drew it nowhere. It now takes the countdown's end of the keyboard's meta row, and
  the countdown is the right thing to displace: it is advisory and never decides whether SEND
  works, while this is the only report a failed capture gets.
- **`composeVoiceMsg` outlived what it explained, twice over.** Its own comment claimed it was
  "cleared by the next capture or the next edit" and nothing cleared it on an edit or at
  `openComposeOn`, the function whose header says every reset lives in it. So a whisper failure
  from session A was still in the legend when the panel opened for an unrelated ask on session B
  - and worse, the repaint guard's third term was `composeVoiceMsg[0]`, so a standing message
  made **every** new `voice.seq` from **any** host repaint the whole surface mid-keystroke. The
  guard was defeated by its own term, three lines under the comment explaining why it exists.
  Cleared on edit and at open; the guard now asks whether the legend CHANGED.

### And the states are addressed now, which is what admitting plain `error` was papering over

`askerror` carried no pid and `msgerror` did not exist, so the device had to admit plain `error`
as a stand-in for a message failure. `error` is the dictation path's state: unaddressed, and
republished by every host on every 5s tick for ever. Cabled to Mac A and composing for Mac B,
B's next payload drew VOICE: over a draft that was fine and **took A's in-flight capture's bar
down with it** - `micProcessing` is one global while the sequence mark is per-link, so any host's
first payload after the surface opens is "new". Both failure states are addressed now (pid,
session), the teardown is gated on the exchange being one this surface can address, and plain
`error` is refused by name.

### Two defects the boards hid in their own way

- **Board 2's `micRecord` metering loop never flushed.** The opening frame did; the ~83 updates
  inside a ten-second blocking loop did not, so the glass held LISTENING, a dead meter and 0%
  for the whole take. `SCREENSHOT` could not see it either - it reads the same shadow buffer the
  renderer wrote - so it was correct by construction while the panel was wrong.
- **Arming the stop on a release made a stuck panel unstoppable.** Fixing "the capture dies 20ms
  in" introduced its mirror: if `touchPressed()` never reads false, the stop never arms, and
  board 1's stream loop discards host input for the duration so the Mac cannot end it either.
  `MIC_STOP_STUCK_MS` (15s) is the backstop, chosen so a deliberate hold still records.

### The SNR floor was measuring the wrong file, and reported "undefined" as "zero"

`mic-wav.mjs` prints two figures. The host parsed the **raw** one, taken before the de-rumble
pass; Whisper reads the **filtered** file, whose own figure sits on the next line with +10 to
+12dB more headroom. So the 8dB floor refused takes whose filtered signal was fine, with about
5dB of margin against real speech. Worse, `quiet === 0` - one 100ms window of digital silence,
which board 2's I2S produces before the ES8311 settles - printed `0.0 dB` and a capture with 900
RMS of speech in it was thrown away as "nothing was said loudly enough". The mirror case proved
neither was considered: a capture shorter than one window printed `-Infinity dB`, which the
regex did not match, and was waved through. Both print `n/a` now, and `n/a` refuses nothing.

### What binds all of this

- `settings-geom-check.mjs` gained the message half of `composeAbsorbVoice`'s ownership tests -
  the session match, both addressed failure states, the refusal of plain `error`, the bar's
  ownership gate, and the repaint-on-CHANGE guard.
- `sessions-geom-check.mjs` gained the recording pill, which **nothing in the tree bound**:
  `grep -l 'micPill\|MIC_PILL' **/*.mjs` returned nothing before this. Four bands in 64px, three
  derived from a per-board font cell, plus every footer string and every title measured against
  the lane the elapsed readout leaves. It found board 2's title sharing its first row with the
  meter track - survived only because `micPillFrame` draws the title first - and the comment
  recording those bands turned out to carry board 1's numbers while reading as both boards'.
- The stop and flush rules were **rebound to the block they are about.** The first versions
  counted `stopArmed = true;` across the whole file and asserted the ABSENCE of a 400ms regex
  over it - three armings anywhere satisfied a claim about three loops, and a negative regex
  passes for any rewording. The flush rule asked whether the FUNCTION contained one, which is
  exactly why `micRecord`'s frozen meter went green. Both are per-loop now.
- The dead-arm rule **moved to `commands-check.mjs` and stopped being about spelling.** The
  first version was scoped to `audio.ino` and to `BOARD_USES_TFT_ESPI`; the flags are fully
  correlated, so it would have missed `reader.ino`'s two (nested under `BOARD_HISTORY_SCROLL`)
  and `touch_cal.ino`'s (under `BOARD_TOUCH_NEEDS_CAL`). It now evaluates every line's whole
  guard stack against both headers and reports what no board compiles. Two dead flushes in
  `reader.ino` were deleted; three deliberate third-case stubs are allowlisted by name.
- `board-1-known-state.md`'s sessions row is **parsed**, not transcribed. It went stale within a
  day of being taken - 9 entries and 10 tolerations against a real 8 and 9 - which is the third
  time a cell in that table has drifted. Both figures are bound, with a fault each.
