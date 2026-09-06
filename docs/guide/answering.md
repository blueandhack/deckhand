# Answering prompts from the device

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## Answering prompts from the device

When a session needs input, tapping its row opens a screen showing exactly
what's being asked:

- **Permission prompts** — "Allow Bash?" plus the actual command text ->
  Allow / Deny.
- **Questions (AskUserQuestion)** — the question and up to four options.
- **Plan approvals** — a plan summary -> Approve / Keep planning.

**Both surfaces are live at once, and the first answer wins.** The prompt appears
in Claude Code exactly as normal *and* on the device with working buttons — click
it on the Mac or tap it on the device, whichever is closer. Nothing is delayed
and nothing is hidden: answer on the Mac and the device just stops offering it.

**How long does a prompt stay answerable from the device? By default, until you
answer it — on either surface.** There's no countdown to beat: the Mac's dialog and
the device's buttons are both live from the first second, it's a race, and whichever
you use first wins. Answer on the Mac and the device just stops offering it.

If you want a deadline instead, put a number of seconds in
`~/.claude/deckhand-remote-wait`:

```
echo 90 > ~/.claude/deckhand-remote-wait     # the old behaviour: 90s, then Mac only
echo forever > ~/.claude/deckhand-remote-wait # the default (same as no file)
```

When a deadline is set, the device shows a countdown on the typing screen and stops
offering buttons when it lapses — the Mac's dialog is untouched and still waiting, so
you finish there. Nothing is ever auto-decided by the deadline passing.

Two caveats. **"Forever" is really 24 hours**, because Claude Code kills a hook that
outlives its `timeout` in `settings.json`, and the hook is written to always bow out
first rather than be killed — the two numbers are a pair, so if you raise the wait past
a day you must raise that `timeout` too. And **Codex keeps a 15-second wait regardless**:
unlike Claude Code, it has never been measured whether its approval UI is shown
*concurrently* with the hook or waits behind it, and if it waits, a long timeout would
stall or deadlock every Codex prompt. That's also why typing isn't offered on Codex asks.

A session sitting at **READY** can also be sent a typed message: open its detail
screen and tap **TYPE** in the header. Be clear about what SEND does — with the
default delivery it **posts the text into that live session**, where it arrives
attributed to a peer session rather than to your own typing; if delivery cannot be
confirmed it falls back to copying the text to your Mac with a notification to paste
it, and the host log names the reason. (Until 2026-09-05 the clipboard was the only
option, "because there is no way to inject a prompt into a live interactive session" —
that turned out to be false; see
[`docs/reference/audio-and-voice.md`](../reference/audio-and-voice.md).)
`DECKHAND_VOICE_DELIVERY=clipboard` forces the clipboard hand-off. Set
`DECKHAND_VOICE_DELIVERY=dispatch` and it instead runs `claude -p --resume` in that
session's directory, which is a second author on that conversation and halts on
anything needing permission. The same switch governs dictation, so the mic and the
keyboard always behave alike.

On the typed-answer keyboard, the empty text box shows the **question you are
answering** (the keyboard takes the whole screen, so the prompt is otherwise off
it), and **tapping the text box** pages the full prompt over the keys while
leaving your answer visible. **CAP** cycles off → one-shot → locked (`CAPS`), and
**holding DEL** repeats after half a second.

Turn off **Settings › Answer prompts on device** in the menu bar to make the device a
read-only mirror instead — it still shows every prompt (handy for reading a long
command from across the room), under an "ANSWER ON YOUR MAC" heading.

Anything with code — a command, or a question/plan that contains line breaks —
renders as a code block in the **Cozette** bitmap font (crisp at this panel's
resolution), with its indentation and line breaks preserved; plain single-line
prose renders in a larger proportional font.
(Tabs become spaces and ``` fences are stripped, but real newlines survive all
the way to the screen.) If the detail is long, a **READ ALL** button
(top-right, well clear of the decision buttons) opens a full-screen reader with
prev/next paging. Tapping an option fills it solid ("Allow — sent") and the
screen returns to the list once Claude moves on. If a session shows NEEDS INPUT
but its prompt isn't answerable here (it fired while the display was
disconnected, or the answer window has closed), the detail screen says "Answer
this one on your Mac".

How it works underneath: the session hook publishes the prompt details into a
per-session file, which the host forwards to the device, and then waits (up to 90
seconds) for an answer. Your tap travels over USB/BLE to the host, which verifies
it and writes an answer file; the hook wakes and emits a real hook decision
(allow/deny/approve, or the chosen option). The reason this doesn't delay or hide
anything on the Mac is *which* hook event it waits on — Claude Code shows its
permission dialog concurrently with that event, so waiting is a race rather than
an interception. If the Mac answers first the hook notices within a second and
gets out of the way. It only waits at all when a display is actually connected
(it checks a heartbeat the host refreshes every tick), so with the device
unplugged prompts behave exactly as stock, and an unanswered prompt just falls
through to the normal dialog with no side effects.

### Answering a question by speaking

The useful reply to an `AskUserQuestion` is often "none of those — do X instead",
and that isn't a button. With the microphone fitted, a question ask gains a
**SPEAK** control: tap it, say the answer, tap to stop. The Mac transcribes it
locally and sends the text back, the device **shows you what it heard**, and
**SEND / RE-RECORD / CANCEL** decide what happens to it. Nothing is sent until
you tap SEND.

**The confirm tap is the authorisation, not an extra step bolted on beside it.**
The device can't transcribe — the Mac does that — so instead of signing a blank
cheque when recording starts, it signs a hash of *the exact text it displayed*.
That one signature proves two things at once: your paired device authorised this,
and a human read these words. A mishearing can't get through unseen, and a
substituted transcript can't be signed. It matters: a dictation on this project
once turned "make sure there is no sensitive data" into "…and **some** sensitive
information", inverting half the instruction.

Recordings cap at 20 seconds here (against 120 for a dictation), because the
whole exchange — record, transfer, transcribe, read, confirm — has to fit inside
the 90 seconds the hook will wait. If the transcript is too long to fit on one
screen, the device says so and **withholds SEND** rather than offering to sign
text you can't see. Questions only: a permission prompt can only be *denied*, so
speaking "yes, go ahead" at one would deny the command with that as its reason,
and a spoken answer to a plan approval would be silently approved with the words
discarded. Those keep their buttons.

### Or by typing

If speaking isn't an option — no microphone fitted, or you'd rather not talk —
a question ask also offers **TYPE** next to SPEAK. TYPE runs full-width only
when the host hasn't marked the ask as voice-answerable at all (an older host
predating the SPEAK feature); the device has no way to detect whether a
microphone is actually wired up, so it can't be the thing deciding this - it's
purely a property of what the host sent. It opens a full-screen QWERTY
keyboard, with `CAP` and `DEL` in place of shift/backspace glyphs (Cozette,
the on-device font, doesn't have those two characters — it's ASCII only).
Text is capped at 150 characters, with a running byte counter and a countdown
of the seconds left to answer, both shown above the text you're typing.

If the countdown runs out or the prompt is answered on the Mac while you're
still typing, the keyboard doesn't throw your text away: it stays on screen
with SEND withheld and a note that the window closed, so at worst you have to
retype it, rather than losing it silently mid-sentence.

TYPE is questions-only, for the same reason SPEAK is: a permission prompt can
only be denied, and a plan approval would silently discard the text and
approve. It's also not offered on Codex threads — Codex's answer window is
only 15 seconds (against 90 for Claude Code), which isn't enough time to type
a reply, so the button simply doesn't appear there rather than offering
something that can't finish in time.
