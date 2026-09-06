# Talking to a session (speech-to-text)

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## Talking to a session (speech-to-text)

With the microphone fitted you can dictate to a session: open its detail screen,
tap **`• REC`** in the tab bar, speak, tap again to stop. Up to 120 seconds.
(To *answer a pending question* by voice instead, see
[Answering a question by speaking](#answering-a-question-by-speaking) — that path
shows you the transcript and waits for a confirming tap before anything is sent.)

While the Mac works on it, the recording bar stays up showing **PROCESSING** with
elapsed seconds and a moving indicator, then **TRANSCRIBING** once the Mac confirms
it has started. If it never reaches TRANSCRIBING, the capture never arrived. Any tap
dismisses it, and it says so rather than spinning if nothing comes back.

**Transcription is local and free.** The host decodes the capture and runs
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) on Metal —
`ggml-large-v3-turbo-q5_0` transcribes ~40x faster than realtime. Nothing is
uploaded, there is no API cost, and **the audio never leaves the machine**, which
matters for a microphone sitting on a desk all day. A vocabulary prompt primes the
decoder with this project's nouns, because without it "update CLAUDE.md" came back
as "update core code MD5".

**What happens to the transcript: it is posted straight into the live session**, so it
turns up in the conversation you aimed at, attributed to a peer session rather than to
your own typing. If that cannot be confirmed — an older Claude Code, a session that has
since exited, or a write that could not be verified in the session's transcript — it
falls back to **your clipboard plus a notification** naming the project to paste into,
and the host log says which happened and why. The device card reads `COPIED - PASTE IT`
in that case.

`DECKHAND_VOICE_DELIVERY=clipboard` forces the clipboard hand-off every time; it was the
default until 2026-09-05, when the per-session messaging socket that makes direct
delivery possible was found (see
[`docs/reference/audio-and-voice.md`](../reference/audio-and-voice.md)).

The clipboard was deliberate. The original version ran it for you
(`claude -p --resume <session>`), and the first real use produced three problems at
once: the headless run became a **second author** appending to the same conversation
concurrently, nothing needing permission could finish (a headless run doesn't raise
permission prompts, so it can't be approved from the device either), and a mis-heard
word went straight to work — "make sure there is no sensitive data and **some**
sensitive information" inverted half the instruction. Handing it over costs
hands-free operation and fixes all three: it arrives as an ordinary message, in one
voice, with permissions behaving normally, and you get to read it first.

Set `DECKHAND_VOICE_DELIVERY=dispatch` if you want the old headless behaviour.
Recording from a *tab* rather than a session's detail screen keeps the transcript as
a memo and delivers nothing.

To decode and transcribe a capture by hand:

```
host/mic-stt.sh              # newest capture -> SNR + transcript
node host/mic-wav.mjs        # just the WAV, plus before/after noise figures
```

Both refuse a capture under 98% complete: truncation makes the audio decode as
garbage, which Whisper will happily transcribe into confident words nobody said.
