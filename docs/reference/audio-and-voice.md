# Microphone, beeper, dictation and speech-to-text

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

- **THE WHOLE AUDIO SECTION BELOW IS BOARD 1, and board 2 does not merely lack a mic — it has a
  BETTER one with no software.** Board 2 carries an ES8311 I2S codec and a speaker amp; every
  constraint that shapes the design below (analog amp into ADC-DMA, mu-law, IMA ADPCM, chunk+ACK
  flow control, the 33.3Hz BLE comb cancellation) comes from a CH340 capped at 11.5KB/s and ~26KB
  of free heap, and board 2 has neither limit. Board 2's own capture path now EXISTS and sends
  linear PCM16 with no codec — see Two
  boards for the pins and for what a board-2 audio path would replace.
- **Microphone (MAX4466 electret amp) — HOW TO WIRE IT, and IO35 is the only pin that can do
  this.** Three wires, to the board's 4-pin **Expand** connector:

  | module pad | goes to | why |
  |---|---|---|
  | `VCC` | **3.3V** — never 5V | see the 5V warning below; this is the one that can destroy the pin |
  | `GND` | GND | — |
  | `OUT` | **IO35** | the only free ADC1 channel on this board |

  **Identify the Expand pins from the header's own silkscreen, and meter the rail before you plug
  the module in.** This repo does not record the physical pin ORDER of that connector — only the
  net each wire must reach — because guessing it is how you get the failure below. Confirm which
  pin is 3.3V and which is GND with a meter first; the remaining signal pin is IO35.
  IO35 is forced, not chosen: touch took ADC1's 32/33/36/39 and the battery divider took 34,
  leaving IO35 as the only free ADC1 channel — and ADC1 is mandatory because ADC2 is dead while BT
  is active. IO35 is input-only, which an ADC pin doesn't mind. The pin needs **11dB attenuation**
  (`analogSetPinAttenuation`); the module idles at VCC/2 (~1.65V) and at the default range that
  bias sits against the ceiling and clips everything. The SPI connector is useless for this
  (IO23/19/18/22 are digital-only or ADC2).
  **Never power it from 5V** even though the module accepts 2.4–5.5V: IO35 is not 5V tolerant, and
  at a 5V supply the op-amp biases at 2.5V and swings toward 5V, past the pin's absolute maximum.
  **A miswired module hangs `setup()` and looks exactly like bricked firmware**: reverse polarity
  makes the module conduct through its ESD diodes and drag the 3.3V rail, so the chip answers
  esptool all day (download mode draws little) but the sketch dies the moment it powers the
  backlight and BLE. Zero serial output plus a chip that still reads its MAC = suspect the
  peripheral, not the code. (Absence of ROM boot text proves nothing here — TFT_CS is GPIO15,
  which straps the ROM log off.)
- **Checking the wiring: the DC bias is the whole test, and it distinguishes all three faults.**
  Tap **SETTINGS › ACTIONS › MIC TEST** on the device, or run `MICTEST` for the serial report.
  What the numbers mean:

  | reading | meaning |
  |---|---|
  | `dc` ≈ **1893** counts (~1.65V), floor ~100–150 | wired correctly |
  | `dc` near 0, `min=0`, lots of `clipped` | **OUT not connected, or no power** — the firmware says this verbatim: `pinned near 0` |
  | `dc` ≈ 1893 but floor ~35 | powered, but gain is at the bottom — see the trimmer note |
  | `dc` ≈ 1893, floor ~750 | gain too high, the amp is oscillating — see the trimmer note |
  | device won't boot at all, dark screen, esptool still works | polarity reversed; unplug the module and it boots |

  The bias proves power AND the OUT wire in one number, which is why it is printed first.
- **Mic bring-up: three commands plus an on-device button, and the reason each exists.**
  - **SETTINGS › ACTIONS › MIC TEST** — runs `micMonitor()` (the live meter below) with no host
    involved. It is the first button on that page and deliberately has **no confirm dialog**: it
    changes nothing, exits on a tap, and you run it repeatedly while turning the trimmer. Two
    non-obvious requirements: `micWaitRelease()` must run BEFORE the meter loop (the tap that
    launched it is still down, and the loop exits on a touch, so it returned instantly without
    this), and the exit needs **two consecutive** `ts.touched()` reads (the same false positive
    that once ended a 99s recording nobody touched). On exit `micRestoreUi()` falls back to the
    "waiting for host" screen when no payload has ever arrived — which is exactly the standalone
    case a mic test happens in — so the settings handler repaints explicitly in that case only.
  - `MICTEST` — one-shot level report: DC bias (proves power + the OUT wire), per-window
    peak-to-peak, clip count, and a floor/peak **ratio**. The window is **10s on purpose**. At 4s
    the talking kept landing either side of the capture and every run read as room tone; the
    per-window profile still shows exactly when sound arrived, so a miss is distinguishable from a
    deaf mic. It beeps to mark the start (`MIC_CUE_DUTY`, deliberately independent of the SOUND
    setting — here the cue *is* the test) and the verdict requires **3+ elevated windows**, because
    speech is sustained and one elevated window is a knock. Judging by overall peak-to-peak
    reported "reacted to sound" for runs that were pure hum.
  - `MICMON` — live meter on the device's own screen, because the setting you want is "highest gain
    whose floor stays low" and that can only be found by watching the floor WHILE turning the screw.
    One-shot tests cost a round trip per quarter-turn, and the trimmer silently drifted back into
    oscillation between two of them.
  - `MICREC` — records real audio and dumps it as base64 for `host/mic-wav.mjs` to turn into a WAV.
    Levels only ever say "louder than the floor"; only listening settles usability.
- **`MICREC` samples by DMA (`adc_continuous`) at 32kHz, decimated 2:1 to 16kHz.** Every part of
  that sentence is forced:
  - A busy-loop capture would starve the core's IDLE task and trip the task watchdog, and the
    obvious workaround (yield every 200ms) punches 1ms holes in the audio at 5Hz — a buzz that
    wrecks the exact judgement being made. `adc_continuous_read()` blocks on a semaphore, so the
    hardware fills buffers gap-free while the CPU is free.
  - **16kHz because that is what Whisper is trained on.** At 8kHz everything above 4kHz is gone,
    and that band is where consonants separate (s/f/th) — it costs real transcription accuracy.
  - **32kHz because the driver's MINIMUM is above the rate we want**: on this chip
    `SOC_ADC_SAMPLE_FREQ_THRES_LOW` is 20kHz, so 16kHz cannot be requested directly either.
  - `adc_continuous_deinit()` is **not optional** — battery sampling needs ADC1 back for `analogRead`.
  - **ORDER IS LOAD-BEARING: create the ADC handle BEFORE the big audio buffer.** Backwards, this
    crash-LOOPS the device, and no error check can save you. `adc_continuous_new_handle` needs
    internal DMA-capable memory; with 64KB of audio buffer already taken there isn't enough, and on
    that failure the IDF's own cleanup calls `adc_continuous_deinit()`, which frees an APB peripheral
    it never claimed and calls `abort()` — a `SW_CPU_RESET`, not a return code. The abort happens
    *inside* the call. Decoded backtrace, for the record: `abort <- adc_apb_periph_free <-
    adc_continuous_deinit <- adc_continuous_new_handle <- micRecord`. Symptom from the outside:
    "white screen, then restart", looping.
- **Audio is stored as 8-bit G.711 mu-law, and that is what makes 16kHz possible at all.**
  16kHz × 16-bit × 5s is 160KB; free heap after BLE is ~70KB, so linear PCM capped a take at **2
  seconds** — too short to reliably catch a sentence. mu-law is logarithmic, keeping fine resolution
  near zero where this quiet signal lives, and 5s costs the same 80KB that 8kHz/16-bit did. Scaled
  ×8 into mu-law's 16-bit input range on the way in (the signal peaks ~150 ADC counts, so scaling
  keeps it clear of the coarsest steps); divided back out host-side.
  - The DC bias must come off **before** encoding — mu-law is non-linear, so there is no re-centring
    it afterwards the way linear PCM allowed. Measured over the first 200ms of frames, not assumed
    to be mid-scale (the real bias is ~1893, not 2048).
  - No digital gain, so the Mac can measure true SNR; scaling for audibility happens host-side,
    after measurement, where it can't flatter the numbers.
  - The 5s request falls back to 4s/3s/2s when the heap won't take it, and reports what it got.
    **~3s is the ceiling as measured today** on this module (ESP32-32E **N4** — 4MB flash, no
    PSRAM), not a preference. It was 4s when this was written; the heap has been eaten since by
    features that grew `SessionInfo` (askDetail alone is 1424 bytes x 6). **Re-measure rather than
    trusting this number** - trigger `MICREC` and read the `AUDIO note: only Ns fits in heap (N
    free)` line, which is the only honest source.
  - **`ESP.getFreeHeap()` is a SUM, and the capture buffer needs a CONTIGUOUS block, so the two
    disagree in the direction that matters.** Measured: a device up for hours reported **42,864
    free** and `MICREC` failed outright with `out of heap`, while a freshly booted one reported
    only **26,028 free** and allocated successfully. Fragmentation, not exhaustion. So an
    `out of heap` with a comfortable-looking free figure is not a contradiction to explain away -
    it is the expected shape after uptime, and rebooting is the fix rather than a bigger number.
- **Polling the stop-tap is NOT the same job as repainting the meter, and sharing a timer made
  stopping feel broken.** `micStream` had its `ts.touched()` check nested inside the 120ms meter
  repaint, with the two-consecutive-reads debounce on top - so a stop cost 120ms at best and 240ms
  at worst, and, far worse, a tap whose contact did not span two polls 120ms apart reset the vote
  count and did **nothing at all**. A normal tap is 80-150ms, so that happened often, and it reads
  as an unresponsive button rather than a slow one. `micMonitor` had always done it correctly (10ms,
  two votes); the streaming and one-shot paths now match it. The poll gate is **10ms, not 20**:
  the loop already turns over every ~16ms (a 1024-byte `conv_frame` at 32kHz x 2 bytes), so a 20ms
  gate would fire on every OTHER iteration and quietly cost 64ms for two votes. Two votes now cost
  ~32ms and a normal tap spans 5-9 polls. The debounce itself is unchanged - still two consecutive
  reads, which is what stops a single spurious `ts.touched()` ending a 99s take.
- **Recording is user-terminated and shows a live meter.** Tap the floating button to start, tap
  again to stop; it also stops when the buffer fills, and the log says which (`AUDIO stopped by
  tap|buffer full`). A fixed length is the wrong default for dictation. Meter and transfer progress
  live in a **pill over the bottom of the content area, not a full-screen takeover** — this device
  exists to show session/usage state, and blanking it for the ~13s a capture takes hides the thing
  it is for. The level bar earns its place: it is the only way to know the mic is hearing you
  *before* spending 9s shipping the audio. Metering runs between DMA reads, never inside the sample
  loop (4096-byte store buffer ≈ 64ms of slack, versus ~2ms to draw).
- **`prevSessions` keeps only the nine fields the diff reads, not a whole `SessionInfo`.** It used
  to be `SessionInfo[MAX_SESSIONS]` - **13,392 bytes of DRAM plus a 13KB `memcpy` every tick** - to
  compare about 92 bytes per session. `askDetail[1424]` was 8.5KB of that, copied every 5s and never
  read back once. Slimming it to `PrevSession` reclaimed **12,792 bytes** (RAM 80,988 -> 69,156),
  which is about half the free heap on this device, and the audio path's one-shot capture went
  straight from **2s to 3s** as a result - heap is the binding constraint here, not flash (which sits
  at 43% with 1.78MB spare, so shrinking the firmware buys nothing).
  **`PrevSession`'s field widths must match `SessionInfo`'s exactly.** A narrower copy would be
  silently truncated by `copyField` and could then compare EQUAL to a *different* id or askPid -
  the same class of bug as a change-only cache shorter than the string it stores. The one field that
  deliberately changes shape is `askVoiceText`, which the diff only ever tests for non-empty, so it
  becomes a single `hadVoiceText` bool rather than 204 bytes.
- **The recording bar has a FOURTH stage, because it used to vanish exactly when the wait
  began.** LISTENING/DICTATING -> SENDING -> **PROCESSING** -> result. The bar was torn down
  the instant the transfer finished, which is the moment the Mac starts the slow part -
  decode, then whisper, then up to one 5s tick before anything comes back. Three to ten
  seconds of nothing, longer on the first run while whisper loads its 547MB model, and it
  reads as "my tap did nothing". Both capture paths enter it (`micProcessingBegin()`), so the
  behaviour cannot depend on which one was used.
  - **TWO titles, because the device knows two different things.** It knows it finished
    SENDING (its chunks were ACKed) but not what the Mac did next, so it says `PROCESSING`
    on its own authority and only claims `TRANSCRIBING` once the host publishes state
    `working`. **If it never upgrades, the Mac never got the capture** - the most likely
    failure, and otherwise indistinguishable from success. `working` is deliberately NOT in
    the card-raise list: it is progress, not a result.
  - **The track carries an INDETERMINATE SWEEP, never a percentage.** whisper's progress is
    not observable, so a filling bar would be inventing one; a segment travelling back and
    forth says "working, duration unknown". Elapsed seconds sit in the lane `micPillMeter`
    uses for its percentage and are the honest quantity.
  - **Frame and update are split** for the same reason `micPillMeter` splits them: the frame
    (rounded card, stroke, dot, title) is painted on entry and only when the TITLE changes,
    while the sweep and counter repaint at 80ms. Repainting the card several times a second
    is exactly the flicker this file's discipline exists to prevent.
  - **Whoever takes the bar down OWES A REPAINT**, and forgetting it was a real defect caught
    before flashing. The bar is a 212x64 slab over the content area and the change-only
    render will not clear it. A raised result card clears the content area itself - but
    `heard` and `askheard` raise no card, so those left the bar stranded on screen.
    `barNeedsClearing` repaints only when no card is coming, since doing both is a visible
    double-draw.
  - It absorbs the 5s tick the way the voice card does (parse everything, `renderFooter()`,
    return), and any tap dismisses it. A ~45s stall relabels it `NO REPLY FROM MAC` rather
    than spinning forever - the host's own child timeout is 180s and a three-minute spinner
    would be its own bug.
- **`voice.seq` is HOST-LIFETIME, and treating it as monotonic forever broke on every host
  restart.** `let voiceSeq = 0` in the host, so it restarts at 1 when the process does. The
  device held it as a high-water mark, so after a restart it ignored every voice state until
  the new counter climbed past the old one - silently disabling the result card, and leaving
  a processing bar with nothing that could ever end it. Observed exactly that: the bar sat on
  `NO REPLY FROM MAC` because the host had been restarted out from under it. A seq going
  BACKWARDS is now read as a new host generation (`voiceSeq`/`voiceSeqShown` reset).
  Two related holes closed with it. **`voice: null` means the host holds no record of any
  exchange**, which after a restart is the literal truth - the device's parse skipped the
  whole block on null, so it received no signal at all. It now ends the bar on a null voice,
  but only after 12s, because null is ALSO briefly true for the first capture of a host's
  life (the bar goes up when the transfer ends; `working` only arrives once transcription
  starts) and clearing on sight would kill the bar in the very case it exists for. And the
  bar now GIVES UP at 35s instead of holding the screen until tapped: "no reply" is worth
  saying, and is not worth a permanent slab of the content area when nobody is standing
  next to the device.
- **`clip` was missing from the card-raise list, and that made the DEFAULT delivery silent.**
  With `DECKHAND_VOICE_DELIVERY` unset (clipboard), a dictation ends on state `clip` - and
  since only `sent`/`done`/`memo`/`error`/`askerror`/`asksent` raised the card, the device
  showed **nothing at all**: no transcript, no confirmation. `voiceStateLabel()` had carried a
  `COPIED - PASTE IT` label the whole time that the raise path could never reach, and this
  file claimed that card appeared. Same class as the `askerror`/`asksent` omission the voice
  review found: a state the host publishes and the device surfaces nowhere.
- **`micRestoreUi()` must reset the change-only caches, and delegates to `forceFullRepaint()`.**
  Repainting chrome WITHOUT resetting them leaves every field **blank**, because `drawIfChanged`
  sees an unchanged string and skips a field whose pixels were just erased. That shipped once as
  "USAGE shows no numbers after recording" — the identical trap `drawSettingsStatic()` already
  documents. Going through `forceFullRepaint()` also means values return from data already in hand,
  with no wait for the next host tick.
- **Long recordings STREAM (`micStream()`), because buffering physically cannot reach a minute.**
  60s at 16kHz is 960KB against ~70KB of free heap, and this module has no PSRAM — that is the whole
  reason `MICREC`'s one-shot path caps at ~4s. Streaming sends while recording, so RAM stops
  mattering and the LINK becomes the constraint. The rate budget at 115200 (11.5KB/s, this CH340's
  hard ceiling — see the baud note):
  | format | rate | verdict |
  |---|---|---|
  | 16kHz mu-law + base64 (the one-shot path) | 21.3KB/s | 185% — impossible |
  | 16kHz mu-law, raw binary | 16.0KB/s | 139% — impossible |
  | **16kHz IMA ADPCM (4-bit), raw binary** | **8.0KB/s** | **70% — fits** |
  So it takes **both** 4-bit IMA ADPCM *and* raw binary framing. Dropping base64 matters as much as
  the codec: its 33% tax alone is the difference between fitting and not.
  **Verified: 120.0s captured in 120.0s elapsed — 1,920,000 samples, `dropped=0 gaps=0`** — and a
  35.5s real dictation transcribed coherently. The bonus is bigger than the duration: the transfer
  finishes **when you stop talking**, so the ~9s post-capture wait is gone.
- **Streaming wire protocol.** Text control lines, binary payload:
  ```
  AUDIO stream rate=16000 codec=ima4 chunk=1024 scale=8 dc=1894
  AUDIO bin <seq> <n>\n   followed by exactly <n> RAW bytes (no trailing newline)
  AUDIO streamend samples=.. chunks=.. dropped=.. secs=.. by=tap|cap
  ```
  Host replies `AUDIO ack <seq>` per frame. Saved as the same base64 `AUDIO begin ...` envelope
  one-shot captures use, so the decoder needs no new file format — only the `ima4` branch. The
  decoder accepts **either** `AUDIO begin` or `AUDIO stream` as the header, because that is what the
  device actually emits and relying on the host to rewrite it broke once already.
- **The host's USB reader accumulates BYTES, not a string.** `chunk.toString("utf8")` mangles every
  non-ASCII byte silently, which is fatal for binary frames. It is a two-state machine over a
  `Buffer`: line mode until an `AUDIO bin` header says how many raw bytes follow, then byte-count
  mode for exactly that many. `mic-wav.mjs` picks the newest capture by the **timestamp embedded in
  the filename**, not by `sort()` — plain sort puts every `stream-*` after every `capture-*`
  regardless of age, so an old stream would shadow a fresh capture.
- **Flow control is a credit window, and three separate bugs had to be fixed to make it work. All
  three were silent.**
  - **`Serial.write` blocking ate 20% of the audio.** A 1024-byte chunk takes ~89ms to clock out at
    115200, but the ADC's DMA buffer held only ~64ms — so it overflowed *in hardware*, mid-write.
    Symptom: a 99s stream contained only 79s of samples, with `dropped=0` (the ring never overflowed;
    the loss was upstream of it). Fixed by **`Serial.setTxBufferSize(8192)` BEFORE `Serial.begin()`**
    so writes return immediately, a 16KB `max_store_buf_size`, and bulk `Serial.write(ptr, n)` calls
    instead of per-byte.
  - **The default 256-byte RX buffer deadlocked the window.** The host keeps sending its ~1KB payload
    every 5s during a capture; at 256 bytes that overflows while the device is busy sending, and the
    discarded bytes include the ACKs. Result: 8 chunks in 18s and half the samples dropped. Fixed by
    **`Serial.setRxBufferSize(4096)`**, a window of 8, and a **500ms safety valve** that slides the
    window by one on a stall — a lost ACK must cost throughput, never wedge the stream. The host
    detects any real gap by sequence number and reports it; the device reports `dropped` when its own
    ring overflows. Between them, loss is always visible.
  - **A spurious `ts.touched()` ended a 99s take early**, logged as `by=tap` when nothing was
    touched. Stopping now needs **two consecutive** touch reads — the panel throws occasional false
    positives, and one of them shouldn't end a long dictation.
- **`MICREC` (4s, mu-law, base64) is deliberately KEPT** alongside `micStream()` as a known-good
  short path to fall back on, and it is what the `MICREC` command still runs. The floating button and
  `MICSTREAM` use the streaming path. The 120s cap (`MIC_STREAM_MAX_MS`) and tap-only stop are
  arbitrary choices, not constraints.
- **The BLE radio puts a 33.3Hz comb across the speech band, and it's cancelled in software.**
  MEASURED, on two independent captures: macOS negotiates a **30ms** connection interval
  (240 samples at 8kHz — exactly 24 × 1.25ms), and each transmit burst pulls current on the 3.3V
  rail the mic amp shares. The result is a harmonic series — 66/100/133Hz at **+20 to +30dB** over
  the local floor and still ~+21dB of tonal noise at 300–600Hz, right where the voice is. Dropping
  the link removes it entirely (voice-band tones fall ~11x), but that would stop the device being a
  display while it records, so **BLE deliberately stays connected** and `host/mic-wav.mjs` cancels
  the comb instead. It is removable *because* it's periodic: it repeats every 240 samples and speech
  doesn't. Two details are load-bearing:
  - **MEDIAN per phase, not mean.** A mean is dragged around by whatever speech lands on a given
    phase; the median ignores those outliers and converges on the interference alone.
  - **The period is found by minimising the post-cancellation residual, NOT by autocorrelation.**
    Autocorrelation is captured by whatever is loudest — here a 70Hz rumble — and returned 222
    samples when the harmonic spacing plainly said 240; the filter then did nothing (16.8 vs
    16.9dB). Residual-minimisation optimises the actual goal and lands on 240 every time. It needs
    an `N/(N-P)` correction or a P-parameter template just picks the largest period on offer.
  - Processed in **~1s blocks**: the ESP32's sample clock and the Mac's BLE clock are independent,
    so the period drifts a fraction of a sample per second and one global template smears.
  Result on a real capture: SNR 13.3dB → **27.0dB**, noise floor 7.0 → 0.9, worst voice-band tone
  from +21.5dB prominence down to +6.1dB. Nothing about this requires offline processing — the
  period is stable, so it runs streaming with ~30ms of latency.
- **Analog mic gain: the trimmer's real failure mode is oscillation, not mis-level.** `VR1` is a
  `TC33X-2-104E`, a **single-turn** (~270°) 100K pot; gain is `1 + (R7+VR1)/R5` = **23x to 123x**.
  At high gain the amp **oscillates** on long unshielded leads: the floor sat at ~750 counts p-p
  (~600mV) of low-frequency, sound-insensitive hash that buried speech. Turning the gain down
  collapsed it to ~40 — an **18x** drop, far more than the 5.3x gain range can explain, which is
  what identifies it as oscillation rather than "too much amplification". A floor at ~40 equals the
  bare-ADC noise (35 counts with the mic unplugged), i.e. too little gain to prove the mic is even
  connected; aim for **~100–150**. Direction of rotation doesn't matter — turn fully one way, note
  the floor, then fully the other; the higher floor is the high-gain end.
- **Diagnosing mic noise: use the SPECTRUM, not peak-to-peak.** This cost most of a session.
  Broadband RMS/peak-to-peak said BLE was innocent (7.2 vs 7.7) and that a real voice was
  "indistinguishable from room tone"; the per-tone analysis found a 33Hz comb at +30dB and a clean
  +10 to +12dB of voice at 200–1200Hz. A narrow tone barely moves a wideband number while being
  plainly audible, and a listener hears speech far below where an RMS ratio calls it buried. Ranking
  noise by *band* also matters: the noise was a 70Hz rumble sitting where there is almost no voice,
  so a 180Hz high-pass (cascaded **twice** — 70Hz is only ~1.4 octaves down, one section only gets
  ~16dB) plus a 3kHz low-pass is nearly free of cost to the speech.
- **Captures go to `~/Deckhand-audio/capture-<ts>.txt`, NOT through the host log.** `AUDIO d` lines
  are handled in `handleDeviceLine()` ahead of any logging, deliberately: `console.log` writes to the
  log file **and** stdout, and under `open DeckhandBLE.app` stdout has no reader — so once that pipe
  fills the write blocks, the serial reader stops draining, and the OS buffer overflows. That cost
  ~19% of a dump's lines at 460800. It also keeps a megabyte of base64 out of the log. Output lives
  under `$HOME`, not `/tmp`: macOS prunes `/tmp` and has already eaten recordings wanted for
  comparison. One summary line per capture is logged, with a completeness percentage.
- **`host/mic-wav.mjs` REFUSES a capture under 98% complete (exit 2), and `mic-stt.sh` won't
  transcribe one.** A correctness guard, not politeness: truncation leaves holes in the base64,
  misaligned mu-law decodes as loud garbage, and Whisper transcribed one such capture as a confident
  *"I don't know. I don't know."* that nobody said. A plausible fake transcript is the most dangerous
  failure mode in this pipeline. It defaults to the newest capture FILE and prints a numbered list so
  an index can be passed. (It still falls back to the host log for older inline-base64 builds. Beware
  "last" as a default there — a stale `MICREC` in the command file is replayed on host restart and
  appends silent captures *after* the one you want, which once produced a confident and wrong "the
  capsule is dead, buy an INMP441".)
- **Local speech-to-text: `host/mic-stt.sh` → whisper.cpp, genuinely fast and free.**
  `brew install whisper-cpp`; models are NOT bundled by brew — fetch from
  `huggingface.co/ggerganov/whisper.cpp` into `~/.cache/whisper.cpp/`. Runs on Metal, offline, no API
  cost, and the audio never leaves the machine — which matters for a mic on the desk all day. It
  feeds the **cleaned** wav (the raw one still carries the BLE comb; Whisper has no reason to cope
  with interference we can remove first).
- **Dictation has TWO prerequisites and they fail in identically-looking ways, which is
  why `host/install-voice.sh` exists.** `brew install whisper-cpp` deliberately ships no
  model, so a binary-only install turns `whisper-cli: ENOENT` into
  `failed to load model` - and either way the device just said FAILED. Found the hard
  way: on this machine BOTH were missing, and the logs held **26 whisper failures and
  zero successful transcripts** across two log generations while everything else looked
  healthy. `voiceMissing()` names which one is absent, and it is checked at **STARTUP**
  (`Voice: whisper ready.` / `Voice: DICTATION DISABLED - ...`) as well as on failure,
  because the old behaviour accepted a capture, spent the whole transfer, and only then
  failed - which presents as "dictation is broken" rather than "a dependency is
  missing". The device's error card now names the missing piece and the script to run.
  `install.sh` reports both but does NOT auto-install: the model is ~550MB and someone
  who has not fitted the mic should not download it to set up a status display.
  The installer refuses a model under 500MB rather than leaving a truncated one in
  place - whisper emits confident nonsense from a damaged file, the same hazard that
  makes `mic-wav.mjs` refuse a capture under 98% complete.
- **Use `ggml-large-v3-turbo-q5_0.bin` (547MB), NOT `base.en`.** Benchmarked on real captures from
  this mic, and the gap is not subtle:
  | said | base.en (141MB) | large-v3-turbo q5_0 |
  |---|---|---|
  | "Update CLAUDE.md file" | "update, CLAUDE and D5" | **correct** |
  | a spoken first name | invented a different name entirely | within one phoneme |
  | "Can you design a system?" | "Can you see that in the system?" | **correct** |
  | 35.5s clip | 341ms | **840ms (42x realtime)** |
  Turbo's decoder is 4 layers instead of 32, so it stays far faster than realtime while being much
  more accurate. `base.en` is the second-SMALLEST model and was inventing proper nouns.
- **Vocabulary priming (`--prompt` + `--carry-initial-prompt`) is free accuracy.** Whisper has no
  idea what this project's nouns are: a real dictation of "update CLAUDE.md" came back as "update
  core code MD5". An initial prompt listing the expected terms biases the decoder at zero cost.
  `--carry-initial-prompt` re-applies it to every 30s window, which matters for long dictations -
  without it only the first window is conditioned. Priming alone did NOT fix `base.en`
  ("update, CLAUDE and D5"); priming plus turbo did. Both overridable via `WHISPER_MODEL` /
  `WHISPER_PROMPT`.
- **Parakeet is a dead end for now, despite the runtime being installed.** whisper-cpp 1.9.2 ships
  `parakeet-cli`, `parakeet-quantize`, `libparakeet.dylib` and `parakeet.h`, and `parakeet-cli`
  defaults to `ggml-parakeet-tdt-0.6b-v3.bin` — but no compatible model is published. The only GGUF
  found (`cstr/parakeet-tdt-0.6b-v3-GGUF`) fails with `invalid model data (bad magic)`: it targets a
  different runtime. Every plausible `ggml-parakeet-*` repo 404s, and brew ships no conversion
  script, so producing one means converting NVIDIA's NeMo checkpoint with torch/NeMo. Worth
  revisiting only if someone publishes a real ggml `.bin` — Parakeet TDT is a transducer, so it
  would be faster than Whisper, but turbo already solves the accuracy problem.
- **A dictation or typed message is POSTED INTO THE LIVE SESSION (`DECKHAND_VOICE_DELIVERY`,
  default `inbox`, since 2026-09-05).** The host writes it to that session's own Unix domain
  messaging socket and it lands in the running conversation — see the correction below, and
  `host/session-inbox.mjs`. `clipboard` forces the previous behaviour and is the escape hatch;
  `dispatch` restores the original headless behaviour below. **Every failure falls back to the
  clipboard and names its cause in the log** — there are four (no socket on the session record, a
  socket whose session exited, a failed write, and a write that succeeded and delivered nothing),
  and unannounced they would all look like the clipboard being the design.
- **The clipboard hand-off, which was the default from the day `dispatch` was demoted until
  2026-09-05.** The transcript goes to the Mac's clipboard plus a notification naming the project
  to paste into; the device card reads COPIED - PASTE IT. Still exactly what
  `DECKHAND_VOICE_DELIVERY=clipboard` does, and still the fallback. It displaced `dispatch` after
  the first real use, which produced all three of these
  at once: the headless run became a **second author** appending to the same conversation
  concurrently (both writing one transcript, neither able to see the other), nothing needing
  permission could finish (see below), and a mis-heard word went straight to work — "make sure
  there is no sensitive data and **some** sensitive information", inverting half the instruction.
  Handing it over costs hands-free operation and fixes all three. Note the split in the
  implementation: the **clipboard gets the text verbatim** (quotes, backslashes, newlines all
  matter for pasting) while the **notification gets a sanitised one-liner**, because that string is
  interpolated into AppleScript where a stray quote breaks or alters the script. The `clip` state
  is backward-compatible — an older device falls through to a generic "VOICE" label — so the host
  half ships on its own.
  ~~**There is no way to inject a prompt into a running interactive session**, which is why the
  fallback is headless. Checked, not assumed: the transcript's `queue-operation` records are an
  *effect* the app writes (enqueue then dequeue), not an input, and no queue file exists under
  `~/.claude`; `--resume`/`--continue` both start a new process against a session's history; and
  `~/.claude/ide/<port>.lock` does describe a live websocket with an auth token (the port is open),
  but it belongs to the VS Code integration, is an undocumented internal protocol, and delivers to
  whichever editor holds the lock rather than the session you aimed at.~~
  **CORRECTED 2026-09-05 — this is now FALSE.** Kept above rather than deleted, because every one
  of those four findings is still individually true and re-checking them would cost the next
  reader the same afternoon. What the investigation missed is a fifth channel it never looked at:
  Claude Code exports **`CLAUDE_CODE_MESSAGING_SOCKET`** (`/tmp/cc-socks/<pid>.sock`) and
  **`CLAUDE_CODE_MESSAGING_TOKEN`** (32 hex) into every process it spawns, hooks included, and
  anything that can read that pair may post into the live conversation. Note where the old
  reasoning went wrong: `queue-operation`/`enqueue` was read as *only* an effect, and it is —
  but it is the effect of exactly this input, which makes it the confirmation signal rather than
  a dead end.
  - **Reading the environment from a hook is the whole mechanism.** There is no registry, no CLI
    subcommand, and no derivation from a session id; the number in the path is the Claude Code
    process's own pid, but nothing relies on that.
    `claude-hooks/deckhand-session-hook.mjs` publishes both fields as `inbox` on the session
    record, and `host/index.mjs` consumes them there. The token never reaches the device — the
    device payload is built field by field and does not include it.
  - **Ancestry does not matter, which is why the Deckhand host can do this at all.** Measured: a
    `launchd`-parented process with `ppid=1` and no relationship to the session posted into it
    successfully. That is exactly the shape the host has, running as `DeckhandBLE.app`.
  - **The message arrives attributed to a peer session**, not as your own typing — the transcript
    renders it as "Another Claude session sent a message: ...". Inherent to the mechanism.
  - **THE WIRE FORMAT IS UNDOCUMENTED AND GETTING IT WRONG IS SILENT.** Two newline-terminated
    JSON lines on one connection: `{"type":"auth","token":"..."}` then
    `{"type":"user","message":{"role":"user","content":"..."}}`. The first guess,
    `{"type":"message","text":...}`, is wrong — and the socket **accepted it, reported a
    successful write, and discarded the message**. Re-measured 2026-09-05 on a live session: the
    bad frame's write callback returned no error and the transcript gained no `enqueue`. There is
    no ack and no error line, so **a successful write is never proof of delivery**: the host
    confirms by watching the target's own transcript for a `queue-operation`/`enqueue` whose
    `content` carries the text, from an offset taken *before* the write, and treats an
    unconfirmed send as a failure. `host/session-inbox-check.mjs` binds the frame shape to the
    code that builds it, so a revert to the discarded shape fails by name.
  - **UNVERIFIED, and the one thing worth watching: confirmation has only ever been observed on a
    BUSY session, while a real device tap can only ever target a WAITING one.** The indirect
    evidence is reassuring but is not the case that matters: of 2,826 `queue-operation` enqueues on
    disk, 1,785 carry no `content` at all (locally typed, dequeued in the same millisecond) and 238
    content-carrying ones were dequeued in under 50 ms — so `content` does not appear to be
    conditional on queue delay. If that inference is wrong, every device tap would log NOT
    delivered, fall back to the clipboard, **and have actually delivered** — a duplicate turn plus
    a false log line. So the unconfirmed refusal carries its own diagnosis: the offset it scanned
    from, how much the transcript grew, how many enqueues it saw and how many carried content.
    `enqueues=0` means it never arrived (suspect the frame or the token); `enqueues>0` with
    `withContent=0` means it probably arrived and the confirmation rule cannot see it. **One real
    device tap settles this**, and the log line is built so that tap is conclusive on its own.
  - **Limits, from the documented behaviour of the channel:** ~1M characters per message, a burst
    cap, at most 50 queued messages, and the connection is closed if a complete line does not
    arrive within 30 seconds. Deckhand's own cap is 150 bytes, so only the last applies — the
    host opens the socket only once it has the text, writes both lines, and closes.
- **A pending QUESTION can be answered by speaking, and the confirm tap is what authorises it.**
  The device records with the ask's pid in the stream header (`answer=<pid>`), the host transcribes
  and PARKS the text rather than dispatching it, publishes it back on the ask (`voiceText`,
  `voiceSha`), and the device shows it. Tapping SEND signs
  `HMAC(secret, "nonce:pid:TEXT:<sha16>")` over a hash of **exactly the text on screen**, so one
  signature proves both that the paired device authorised the answer and that a human read those
  words. The host re-hashes the transcript it still holds and refuses a mismatch.
  Nine things are load-bearing:
  - **Questions only, and the HOST enforces that — `ask.voice` gates the BUTTON, not the write.**
    `emitDecision` carries free text for a question (`{behavior:"deny", message: carriedAnswer}`)
    but for a plan takes the `answer.idx === 0` branch — `{behavior:"allow"}` — since a voice answer
    always writes `idx: 0`; a spoken answer to a plan would therefore be silently APPROVED,
    discarding the words entirely, not merely replaced with a generic string. That is the worst
    failure shape available: indistinguishable from working. A permission prompt can only be DENIED,
    so speaking "yes, go ahead" there would deny the call with that as the reason.
    So `handleVoiceAnswer` re-reads the session record and requires `ask.kind === "question"` **and**
    a matching `ask.pid` before it writes an answer file, and the device clears `askVoiceText` for a
    non-question ask so the confirm screen cannot be raised at all. Both halves are deliberate:
    parking a transcript is **unauthenticated** (any peer on the link can send
    `AUDIO stream … answer=<pid>` against a pid of its choosing), so if the device's gate were the
    only gate, a chosen pid would reach `{behavior:"allow"}`. A read failure on the record aborts
    rather than falling through — `undefined !== "question"` must reject, not pass.
  - **The hook is NOT modified.** The answer file carries `idx: 0` with the transcript as `label`,
    and `chose = answer.label || ...` does the rest. That file's stdout is a decision channel.
  - **Cap the transcript BEFORE hashing it, and cap it in BYTES.** The device displays the capped
    string, so that is the string that must be signed; hashing first would sign text the human never
    saw. The cap has to be `capUtf8(text, VOICE_ANSWER_TEXT_MAX_BYTES)` (150, on a codepoint
    boundary) rather than a `slice()` on characters, because the device stores the answer in a fixed
    `char[204]` and `copyField` truncates by BYTES. Whisper emits curly quotes and em-dashes freely
    at 3 bytes each, so a 200-*character* transcript overflows that buffer: the device would display
    a truncated string — possibly cut mid-codepoint — while signing the host's hash of the FULL one.
    Verification passes and the host writes text nobody read, which defeats the entire point of the
    confirm step. `capUtf8` lives in `host/voice-answer.mjs` rather than inline so
    `voice-answer-check.mjs` exercises it; removing its boundary walk fails 3 of its 4 checks.
  - **If the transcript will not FIT on the confirm screen, SEND is withheld rather than offered.**
    The panel wraps to at most 8 lines and `askVoiceTooLong()` reports an overflow, which draws
    "TOO LONG - ANSWER ON YOUR MAC" and omits SEND (RE-RECORD and CANCEL stay). The touch handler
    tests the same helper, so the button's rectangle is inert too — a hidden control whose hit
    region still fires is worse than a visible one. Belt and braces in practice, not load-bearing:
    every Cozette 6x13 glyph advances 6px, and this screen's lane is `CARD_W - 8` = 208px on board
    1, whose worst case is **exactly 8 lines** — measured by searching word lengths rather than
    assumed (17-character words; 9 lines is unreachable because after 7x18 bytes only 24 remain).
    The two caps are therefore consistent **by arithmetic**, and any change to either must
    re-derive the other — a 6-line cap was what let SEND sign text scrolled off the bottom with no
    indicator that anything was missing. Board 2's wider 288px lane gives a worst case of **6**, so
    the shared cap of 8 holds looser there and did not have to move.
    **THE CONFIRM SCREEN AND THE KEYBOARD DO NOT SHARE A LANE, and this file used to say they did.**
    The confirm screen wraps against `CARD_W - 8` (`sessions.ino`, `askVoiceTooLong`); the keyboard
    hard-slices against `CARD_W - 12` (`keyboard.ino`, and board 1's own header comment always said
    `(CARD_W - 12) / 6`). **At board 1's `CARD_W` of 216 both give 34, which is exactly why the
    error survived** — they diverge at any other width, and board 2 is the first thing in this repo
    to have another width: at 296 they give **36 versus 35**. The wrong lane was written into the
    one place this file claims a budget is provable "by arithmetic", which is the worst place for
    it. If you quote a column count here, quote the file it comes from with it.
  - **20s cap on an answer recording** (`MIC_ANSWER_MAX_MS`) against 120s for a dictation. The hook
    blocks for `REMOTE_WAIT_MS` (90s) and that is the whole budget for record, transfer, transcribe,
    read and confirm. If confirmations start landing late, shorten the cap - do NOT raise
    `REMOTE_WAIT_MS`, which is matched to the settings.json hook timeout and breaks silently if
    raised alone.
  - **A transcript arriving does not change `askPid`, so `askVoiceSha` had to join
    `buildDetailSignature`.** Without it the change-only redraw never repaints and the confirm screen
    never appears at all — the feature looks implemented and does nothing. Same trap the detail
    signature already documents for `title` and `prompt`.
  - **CANCEL remembers the rejected hash, because clearing the text is not enough.** The host holds
    a parked transcript for five minutes and republishes it every tick, and `handleAskTouch` checks
    `askVoiceText[0]` BEFORE option handling while the confirm rows overlap the option rows — so
    after a CANCEL, a tap on what looked like an ordinary option button could transmit the transcript
    the user had just rejected. `askVoiceCancelSha` suppresses a republished transcript carrying that
    hash, carried across ticks by the id-matched `prevSessions` block. A genuinely new recording has
    a different hash and still displays. Device-local on purpose: a new host command would be more
    wire surface and another thing to authenticate.
  - **The cancel-suppression clears when a recording STARTS, not when `askPid` changes.** Keyed off
    `askPid` alone it was a permanent dead end: CANCEL, then say the same words again, and the
    identical transcript hashes identically and is suppressed forever for that prompt — the user
    re-records and nothing appears, with no way out but the Mac. Starting a recording is an explicit
    request to see a new transcript, so it spends the suppression; both entry points (SPEAK and
    RE-RECORD) clear it, and missing either leaves the dead end half-open.
  - **The failure states have to reach the SCREEN, or a failure is indistinguishable from nothing
    happening.** `askerror` (capture under 98% complete, whisper failed, nothing recognised) and
    `asksent` raise the voice card and have labels in `voiceStateLabel()`; without that the user
    taps SPEAK, speaks, and watches an unchanged screen burn the 90s hook budget with no signal to
    retry. `askheard` deliberately raises **no** card — it fires the instant a transcript is parked
    and the confirm screen carrying that same text is already about to draw, so a card on top of it
    is noise.
  `host/voice-answer-check.mjs` covers the reject cases (tampered text, tampered hash, wrong nonce,
  wrong pid, wrong device, malformed mac) plus `capUtf8`'s codepoint safety, and can be run without
  hardware.
- **A pending QUESTION can also be answered by TYPING it, and the wire format is not the voice
  path's format wearing a different label.** The design spec assumed a keyboard would reuse the
  voice wire format verbatim; it can't, because the voice form signs a hash of a transcript the
  HOST already holds (`handleVoiceAnswer` bails at once without a parked one), while typed text
  exists nowhere but the device until it's sent — so the frame has to carry the text itself:
  `ANSWER <id12> <pid> TYPED <base64text> <hmac>`. That difference makes this **the first place
  the host accepts device-authored text**, which is why `typedTextOk()` (`host/typed-answer.mjs`)
  is not optional ceremony: non-empty, printable ASCII only (`/^[\x20-\x7E]+$/`), ≤150 bytes
  (`ANSWER_TEXT_MAX_BYTES`, now defined once in `host/voice-answer.mjs` and re-exported so one cap
  covers both forms). The HMAC proves the bytes came from the paired device — it proves nothing
  about whether the bytes are sensible, which is what the sanitiser is actually for.
  - **`Buffer.from(.., "base64")` is lenient, so the decode re-encodes and compares.** Node
    silently drops characters it doesn't recognise rather than rejecting them — `"abc!!!!"`
    decodes to whatever `"abc"` meant — so `decodeTypedText()` re-encodes its own decode and
    rejects on any mismatch, turning silent reinterpretation into a hard failure before the bytes
    are ever hashed or signed.
  - **The two forms sign different strings — `...:TEXT:<sha>` for voice, `...:TYPED:<sha>` for
    typed — so a signature minted for one cannot authenticate the other**, even though both
    ultimately sign a 16-hex SHA-256 prefix of text. Voice never needed an on-device hasher
    because the host held the transcript to re-hash against; typed text is device-only until
    sent, so `pairing.ino`'s `sha256Hex16()` exists purely to give the device its own copy of the
    same hash the host will independently compute.
  - **TYPE is hidden on Codex asks, and it's a hardcoded coupling to a constant in another file.**
    `askTypeOffered()` (`sessions.ino`) excludes `agent == "cx"` because Codex's remote-answer
    window is 15s (`REMOTE_WAIT_MS` in `claude-hooks/deckhand-session-hook.mjs`) against 90s for
    Claude Code — not enough to type a sentence, and offering a control that can't work is exactly
    what the read-only ask path already refuses to do elsewhere. `host/index.mjs`'s own
    `HOOK_WAIT_MS = { cc: 90_000, cx: 15_000 }` mirrors that split only to drive the on-screen
    countdown (`ask.sec`) — it's commented ADVISORY ONLY, and must never be mistaken for the
    thing that actually gates the wait.
  - **The countdown is derived from `first`, not `seen`, because `seen` is kept alive on
    purpose.** `nonceForPid()`'s map entry gets `seen` refreshed on every call so the entry
    survives the 60s prune while a prompt is still pending — a countdown built on that would never
    move. `first` is stamped once at creation and never rewritten, so
    `ask.sec = HOOK_WAIT_MS[agent] - (now - first)` actually counts down. It's cosmetic: nothing
    about whether an answer is accepted is gated on `ask.sec` reaching any value.
  - **The host still re-checks `ask.kind === "question"` before writing an answer file**, the
    identical guard the voice path needed for the identical reason: `emitDecision`'s
    `answer.idx === 0` branch is `{behavior:"allow"}`, so a typed answer against a *plan* would
    silently approve it, discarding the words entirely, if the device's own `askTypeOffered()`
    gate were the only thing standing in the way.
  - **If the window closes mid-typing, the text stays and only SEND is withheld.**
    `kbWindowClosed` flips when a tick no longer finds a session whose `askPid` matches `kbPid`;
    `kbText`/`kbLen` are never cleared by that, because throwing away a sentence someone spent a
    minute composing, with no explanation, is the worst available outcome. The action row swaps
    SEND for a wrapped "WINDOW CLOSED - ANSWER ON YOUR MAC", and `sendTypedAnswerToHost()` /
    `kbTouch()` both independently refuse to fire while it's set.
  - **`sendLineToHost` used a fixed `char out[96]` copy buffer, and nothing before typed answers
    was big enough to hit it.** Every prior caller (option answers ~53 bytes, voice answers ~77,
    `HISTORY` ~48) fit; a typed answer's 200-char base64 body reaches ~259 bytes, and `snprintf`
    into 96 bytes silently truncated it **and dropped the trailing `\n` with it** — exactly the
    byte the host's BLE line-splitter keys on. The line was lost, the hook burned its full wait,
    and the truncated fragment corrupted the *next* line. USB was unaffected (`Serial.println` has
    no such cap), so it read as "typing only fails over Bluetooth" rather than a buffer bug. It
    now chunks the caller's own buffer directly in 20-byte BLE notifies and sends `\n` as its own
    final notify, so there's no fixed ceiling left to outgrow.
  - **The text card hard-wraps at exactly 34 columns — deliberately not the word-wrap
    `drawWrappedText` already uses elsewhere.** Word wrap's worst case leaves as few as 18 of 34
    columns used on a line (a 17-character word pushes the break past halfway), which could push
    150 bytes to 8-9 lines — more than the screen has room for. A fixed column count makes the
    budget provable instead: `ceil(150/34) = 5`, always. `drawWrappedText` stays untouched because
    the ask detail and history reader genuinely need word wrap.
    **34 and 5 are BOARD 1's numbers, and the lane is `CARD_W - 12`, not `- 12`'s
    lookalike `- 8`** — both expressions give 34 at 216px wide, which is exactly why the wrong one
    survived in this file for so long. Board 2 is `(296 - 12) / 8` = **35** columns and
    `ceil(150/35) = 5` — the same line count, because the wider card and the wider face cancel.
    (This paragraph used to say 47 and 4, which came from dividing board 2's lane by Cozette's 6.)
    The per-board values live in `board_*.h`; what generalises is the *method*, that a fixed column
    count makes the line budget provable where word wrap cannot.
  - **The countdown and byte counter live in a reserved meta row, because `drawString` paints an
    opaque box the full height of a text line.** A counter sharing a row with wrapped text
    silently erases that line's tail. The meta row and the five hard-wrapped text lines are laid
    out to share no pixel row — on board 1 meta at y=10 and text at 26/39/52/65/78, on board 2
    meta at 20 and text at 41/54/67/80 (four lines, not five) — found as this exact bug twice
    before landing on a row neither can encroach on. The non-overlap is the invariant; the
    y-values are per-board and derived in `board_*.h`.
  - **`fabVisible()` had to gain a `composeActive` check.** The record/mic button's hit test runs
    before the keyboard branch in `handleTouch`, and its tab-bar slot sits right where the
    keyboard's countdown corner is — a tap there started a mic capture, and on release
    `micRestoreUi()`'s repaint painted a tab bar over the still-open keyboard while `composeActive`
    stayed true, leaving every later tap typing invisibly into a screen that no longer looked like
    a keyboard.
  - **Two periodic repaints had to be absorbed, not one.** The ~5s host-driven tick (`handleLine`)
    is intercepted while `composeActive`: it re-resolves the countdown and `kbWindowClosed` from the
    fresh payload and returns, never repainting the session list underneath. A second, independent
    ~1s loop-local tick that repaints the footer/tabs directly is separately gated on `!composeActive`,
    the same way it already excludes `readerActive`/`histActive` — missing either one repaints the
    keyboard away every few seconds. `lastActivityMillis` is also refreshed on every keyboard touch
    **and** every loop tick while `composeActive`, because the 30s default backlight timeout sits well
    inside the 90s answer budget: without it, typing a normal-length answer could blank the screen
    mid-sentence and the waking tap would be swallowed rather than typed.
  - **THE KEYBOARD IS NOW ONE SCREEN OF A TWO-SCREEN COMPOSE SURFACE, and everything below
    describes the KEY SCREEN only.** `kbActive` is `composeActive` and means "the compose
    surface is up"; `composeScreen` says which screen. The other screen is the REPLY PANEL,
    reached from the ask screen's `REPLY` button, and it - not the keyboard - is the root: the
    keyboard is the sheet behind the panel's own `TYPE...`, and its left key is `BACK`, not
    DISCARD. **The surface, the four control kinds, the chips, the recents ring, the send split
    and what none of it verifies are in
    [`sessions-and-asks.md`](sessions-and-asks.md#the-compose-surface).** This file keeps the key
    screen's own history because that reasoning is still what the screen rests on; where a
    sentence below has been overtaken it is MARKED, not deleted.
  - **The placeholder is the QUESTION, and a PERSISTENT STRIP keeps one line of it.**
    `drawKeyboard()` fillScreen's the ask screen away, so without this you compose a reply
    to something you can no longer read. While the box is empty the ask's title sits where
    "Type your answer" used to.
    **THIS CONTROL HAS MOVED TWICE AND THE ROUTE IT DESCRIBES NO LONGER EXISTS**, so the
    history is recorded rather than the paragraph rewritten as if it had always been this
    way. The card was inert first (`if (sy < KB_ROWS_Y) return true;`); then **tapping the
    text card** paged the full detail over the keys, which was free because the card was
    doing nothing; then Task 5 of the compose plan gave that tap to the **caret** for
    `kbLen > 0` and left the peek only on the empty-buffer arm — which put the question
    out of reach again in exactly the state you are in while typing. **Since Task 6 the card's
    tap is the caret in every state and the peek is not reachable from it at all.** One
    `fitText`-truncated line of the ask now lives above the card permanently
    (`drawKbStrip`, `KB_STRIP_Y`/`KB_STRIP_H`, with a right-aligned `MORE` when there is
    more), and **a tap on the strip** opens the paged peek — a band of `KB_TEXT_Y`, which is
    24px on board 1 and 34 on board 2, both deliberately under `TAP_MIN` because the
    vertical column closes exactly on `BOARD_H` with nothing left to grow it with.
    The peek still covers the keys and the action row but **never the text card or the
    strip**, so the answer *and* the question stay visible while it is up; each further tap
    pages and a tap past the last page closes it, so there is always a way out without
    hunting for a target. Font follows `detailLooksLikeCode`, the same choice the ask screen
    makes. The strip carries no change-only cache and is repainted only by `drawKeyboard()`
    and by the one transition that can invalidate it — the ask going away, which clears it
    rather than leaving a question under a tap that would silently do nothing.
  - **CAP has THREE states — off, one-shot, locked — and the LABEL carries which.** It was a
    bool cleared by the next character, so an acronym or a name cost one CAP tap per letter.
    `kbShiftMode` cycles off → once → locked; only `once` clears on insert. The key reads
    `CAP` versus `CAPS`, so the state does not rest on fill colour alone. `drawKbKey` forces
    the filled look whenever `kbShiftMode > 0` rather than relying on a follow-up redraw at
    each call site — a full-board repaint used to be able to lose it.
  - **Hold DEL to repeat, and that is the ONLY held-finger path in this file.** 500ms, then
    ~8 a second. It lives in `tickKbRepeat()` called from `loop()`, NOT in `handleTouch`,
    which dispatches on press and ignores a held finger — right for every other key, where
    one press must be exactly one character. The repeat re-qualifies against the key's own
    rectangle every tick, so sliding off stops it instead of deleting on whatever is now
    under the finger, and a lift releases the pressed look. Without it, fixing a typo near
    the start of a 150-byte answer cost up to 150 taps.
  - **A caret marks the insertion point, and its position is provable rather than clamped.**
    At `KB_COLS` (34) and `KB_MAX_BYTES` (150) the furthest it can land is line 4, column
    14 — inside the `KB_TEXT_LINES` (5) the card already budgets, so there is no overflow
    case to handle.
  - **SEND is the filled button and CANCEL only outlined.** Both were filled, so there was
    no hierarchy at all — and CANCEL is the one that discards a sentence someone spent a
    minute typing. Same reasoning the confirm dialog uses when it refuses to make a
    destructive choice the easiest thing to hit.
    **SUPERSEDED IN PART, and the reasoning above is kept because it is why the current shape is
    right: on the ANSWER path the left key is no longer CANCEL at all, it is `BACK`** — the
    destructive control is off the key screen entirely, which is the same argument taken one step
    further. `kbTouch` and `drawKbActions` both ask `composeHasPanel()`, so the key cannot say BACK
    and close the surface. **It is still `DISCARD`/`CANCEL` in MESSAGE mode**, where a READY session
    has no ask and therefore no panel behind the keyboard, so the keyboard IS the root and the key
    does what it says. `composeHasPanel()` is `!kbIsMessage()` — derived from the surface's own
    state, not a third flag. The row also has three columns now at proportions `{1,1,2}` (`SEND` is
    half the lane, twice the destructive control), with a DRAWN height of `KB_ACT_DRAWN` inside a
    TESTED band of `KB_ACT_H` = `TAP_MIN`.
  - **`KBTEST` exists because this screen is otherwise unverifiable without a person.** It
    opens the keyboard against the first pending ask — the same reason `TAB` and `PAGE`
    exist, since the capture path can only record what is on the glass. `KBTEST peek`,
    `KBTEST caps`, `KBTEST type <text>` and `KBTEST off` reach the states a screenshot
    otherwise cannot: caret, byte counter, live SEND, caps labels. It **cannot invent a
    prompt** (with nothing pending it does nothing) and it cannot send — that still needs a
    real tap. It always closes an open keyboard first: re-opening one already open left the
    screen untouched, and since you cannot tap REPLY while the compose surface covers the screen
    that re-entrant path is scaffolding-only, so it is made impossible rather than debugged.
    **`KBTEST` now opens the KEY screen specifically** (`openComposeKeys`), because the surface has
    two and the opener takes the screen as an ARGUMENT rather than leaving a flag for the caller to
    set. `COMPOSE` opens the panel; `COMPOSE keys`/`COMPOSE back` move between them and print the
    draft after the move. **And `KBTEST` with nothing pending is no longer SILENT** — it names both
    causes (`no ask is pending`, `no session is READY`) and dedupes the host's double delivery,
    which is the rule the whole refusal table exists for.
    It goes through `switchTab(TAB_SESSIONS)` + `openSessionDetail(i)` the way a person
    would, because opening straight from whatever tab was showing left the sessions list
    painted under a USAGE tab bar when the keyboard closed.
  - **No cursor, backspace only — TRUE UNTIL TASK 5 OF THE COMPOSE PLAN, AND NO LONGER.**
    The reasoning stands as the reason it was not built for a long time: insertion was always
    append (`kbInsert`), deletion always trimmed the end (`kbBackspace`), there was no caret
    position anywhere in the state, and aiming a cursor at hard-wrapped text on a resistive
    panel is a worse interaction than retyping up to 150 characters. What changed is that a
    typo forty characters back cost forty re-taps of DEL **plus** retyping the tail, which is
    worse still. `kbCaret` now exists (`-1` means "pinned to the end", the state after
    `openKeyboard` and until you tap the card); `kbInsert`/`kbBackspace` splice at it with
    `memmove`; and a tap on the text card computes the exact inverse of `drawKbText`'s
    line/column division, clamping each intermediate **before** combining them so a tap below
    the last line or right of the last column lands **on** the text rather than past it.
    `settings-geom-check.mjs` binds those four clamps to `kbTouch`'s own body and proves the
    unclamped reach genuinely overshoots on each board's geometry, so they are load-bearing
    rather than defensive. The resistive-panel objection is still real; it is answered by the
    clamps and by the caret being a `TEXT_ADV`-wide block you can see, not by it going away.
  - **Cozette is ASCII 0x20-0x7E only** — the same fact that already forces `fitText`'s
    three-ASCII-dot ellipsis — so there's no shift-arrow or backspace glyph to draw; the keys are
    sentinel bytes (`\x01`/`\x02`) labelled `CAP`/`DEL` in plain text instead.
  - **Going full-screen is what makes QWERTY viable on a 240px-wide panel at all.** On board 1 the
    drawn key is `KB_KEY_W` x (`KB_ROW_H` - 4) = 22x37, and the **tested** band is
    `KB_PITCH` x `KB_ROW_H` = **24x41 = 984px²** against 880 in the ordinary content area. The win
    going full-screen buys is in the touch target, not in the artwork. (Those were 22x40 and
    24x44 = 1056px² until the persistent prompt strip took 3px off board 1's `KB_ROW_H`; the
    TESTED band still clears `TAP_MIN` 40, by 1 rather than by 4, and the drawn key is
    deliberately under it in both dimensions — it always was in width.) Board 2's are 30x54 drawn
    and 32x58 = 1856 tested; its key height is capped by the 1:1.82 aspect of board 1's key **as it
    was when that cap was set** rather than by the panel, which is the honest constraint — board
    1's own key is 1:1.68 now, and the cap is deliberately not re-derived from it.
    **The tested WIDTH comes from the PITCH, not from `KB_KEY_W`, because `kbTouch()` divides by
    `KB_PITCH`** — so the 2px gap between two keys belongs to the key on its left and there is no
    dead lane between keys. This file and board 1's header both said **968** (22x44), i.e. they used
    the DRAWN width for a band the code tests at the pitch. Understated in the safe direction, but
    wrong in two files, and corrected in both.
- **A READY session can be sent a typed MESSAGE, and it is the keyboard half of a path the
  mic already had.** The record button is visible on a plain detail screen so a dictation can be
  aimed at a session; **TYPE** in that screen's header row does the same with the keyboard.
  **That `TYPE` chip is still called TYPE and is still right** — a READY session has no ask, so no
  reply panel is built for it and the button really does open the keyboard. **The ASK screen's
  button is a different one and it says `REPLY` now**, because since the compose surface landed it
  opens the panel rather than a keyboard; see
  [`sessions-and-asks.md`](sessions-and-asks.md#the-compose-surface).
  Delivery is the SAME function for both (`deliverTextToSession`) driven by the same
  `DECKHAND_VOICE_DELIVERY` - so with the default, SEND **copies the text to the Mac and
  notifies you**; it runs nothing until that is set to `dispatch`. One copy of that logic is what
  stops the two drifting, and only the log prefix differs (the `setVoice` states are identical,
  because the device's result card and the menu bar row key off those strings).
  - **READY only, and enforced on BOTH sides.** READY (`status:"waiting"`) means nobody is
    mid-turn, which is what makes this safe - the voice path already found that a headless run
    alongside an active turn becomes a second author on one conversation with neither able to see
    the other. The device gates the button, and `handleTypedPrompt` **re-reads the record and
    refuses anything that is not `waiting`**: a gate that exists only on the device is not a
    gate, the identical reason `handleVoiceAnswer` re-reads before writing an answer file.
  - **The wire form is `PROMPT <id12> <base64text> <hmac>`, signing `nonce:id12:PROMPT:sha16`.**
    The LABEL is the whole point: `TEXT` (voice answer), `TYPED` (typed answer) and `PROMPT` all
    sign a 16-hex hash of their text with the same key, so without it a signature minted to
    answer a question would authenticate one that starts work. `voice-answer-check.mjs` asserts
    both directions of that.
  - **A per-session nonce, because `askNonces` is keyed by an ask's PID and a READY session has
    none.** `promptNonces` is keyed by the FULL session id and published as `pnonce` **only while
    the session is waiting** - its absence, not the status alone, is what tells the device not to
    offer typing. Single-use: unlike an answer, there is no Mac dialog whose closing would
    invalidate a replay.
  - **`resolveSessionId` refuses an ambiguous 12-char prefix**, where the voice path used
    `files.find(startsWith)` and took the first match. A message delivered into whichever session
    sorted first is the worst failure shape available here, because it looks like success.
  - **A duplicate arrives on every send** - the device transmits on USB and BLE at once - so the
    second copy hits a consumed nonce. Without the dedup that logs as an authentication failure
    on every message, which trains you to ignore the line that matters. Observed on the first
    real send, which also proved the nonce is genuinely single-use.
  - **The button is in the HEADER ROW because there is nowhere else.** Measured: the detail card
    runs 60..284 with its content cursor reaching ~284 in the worst case (title and last prompt
    both present), and the "< Back up top - tap here for history" hint owns 285..299 against a
    `contentBottom()` of 302. A 32px control below the card would cover the card's own text or
    replace the only thing telling you the card is tappable. Its hit zone is the whole right end
    of that row - 100x28 for a 76x22 chip on board 1, 100x50 for a 76x26 one on board 2.
    **THE CHIP IS DRAWN SMALL AND HIT BIG, and sizing it to `TAP_MIN` instead was a real mistake
    board 2 shipped for a task.** It was 88x46 there - 46 because that is `TAP_MIN` - on the
    reading that the chip is the target. It is not: `handleDetailTouch` tests
    `sx >= msgBtnX() - 24` over the whole `DETAIL_HEAD_H`, so the live zone is 100x50 whatever is
    drawn, already over twice `TAP_MIN` in both dimensions. The 46 bought nothing and spent the
    header row's air on it. Same split the settings steppers already use (44px keys in a 72x56
    zone), and `sessions-geom-check.mjs` now parses the hit test's slack term out of
    `sessions.ino` rather than restating it, so a future change that RE-COUPLES the zone to the
    drawn size is what fails.
  - **Prompt mode differs from answer mode in exactly the ways the situation does:** no countdown
    (nothing is waiting, and a timer would be a lie), no peek — and so no prompt strip, no
    strip tap band and no hint pointing at either (there is no ask, and the detail screen it
    opened from already shows the context; `kbHasDetail()` returns false in message mode and
    gates all three from one place). That hint read "tap here to read it" while the card's own
    tap opened the peek; since Task 6 it reads **"tap the prompt above to read it"**, because
    a hint that names a control which has moved teaches the one gesture that no longer works.
    Also a placeholder naming the session, and a window tracked by session id plus
    `msgOffered()` rather than by `askPid`. Leaving READY withholds SEND and **keeps the text**, saying
    `NO LONGER READY` - "answer on your Mac" would be answering a question nobody asked.
  - **`KBTEST msg [text]`** opens it against the first READY session and optionally types, for the
    same reason `TAB`/`PAGE` exist. It still **cannot SEND** - that needs a real tap, and keeping
    it that way is the point rather than an inconvenience.
- **The headless fallback (`dispatch`): `claude -p --resume <session_id>`.** Continues the
  conversation in that session's own `cwd`, detached (a dictated task can run for minutes and must
  not block the host's poller).
  Which session? **Context picks the target**: the device stamps `target=<id12>` into the stream
  header when the recording starts from a session's detail screen, and `-` otherwise. A capture with
  no target is transcribed, logged, and NOT dispatched — a voice memo. No extra UI, no mode to get
  stuck in.
- **The dispatch deliberately runs at the DEFAULT permission mode.** A dictated instruction still has
  to clear the normal permission prompts, so a misheard command cannot quietly run a tool. This was
  verified the hard way: "update CLAUDE.md" (heard as "update core code MD5") reached the session,
  Claude worked out the intent, prepared the edit, and **stopped to ask for write permission**.
  Raising this to `acceptEdits`/`bypassPermissions` removes that safeguard and is the user's call.
- **A headless `claude -p` run does NOT appear to fire `PermissionRequest`** — so the device cannot
  approve dictated work. Measured: the hook debug log for such a run shows
  `UserPromptSubmit → PostToolUse → Stop → SessionEnd` with no `PermissionRequest`, and the session
  record carried no `ask`. Consequence: a dictated task that needs permission REPORTS BACK instead of
  completing. Safe, but it means dictation is best used for read/analysis work ("what's failing in
  the tests?") unless you raise the permission mode.
- **Absolute paths are mandatory in the host's voice path.** The host runs under
  `open DeckhandBLE.app`, which does not inherit a shell PATH, so bare `claude`/`whisper-cli`/`node`
  are unfindable. `CLAUDE_BIN`/`WHISPER_BIN`/`WHISPER_MODEL` default to absolute paths, and the
  decoder is spawned with **`process.execPath`** — the node copy inside the bundle — not `"node"`.
- **Two touch-ordering traps, both of which broke the feature in practice:**
  - **The FAB's hit test must run BEFORE the detail/ask handler.** That handler treats any unclaimed
    tap as "close this page", so a tap on the button closed the detail screen instead of recording,
    and the hold gesture never armed. "Floats above everything" has to mean it is hit-tested first,
    not merely drawn last.
  - **`micWaitRelease()` before handing the screen back.** The tap that STOPS a recording is often
    still down when `handleTouch` resumes; it gets read as a fresh press and closed the page the
    instant you stopped dictating.
- **Two-way feedback: the voice result card, and the 32-bit trap that hid it.** A dictation used to
  vanish - you could not see WHAT was transcribed (and it matters: "update CLAUDE.md" was heard as
  "update core code MD5", then later as "update the cloud.md file") nor whether Claude acted. The
  host now keeps the last exchange (`lastVoice`) and publishes it to **both** surfaces: into the
  device payload (which raises a card showing `YOU SAID` and `CLAUDE`, dismissed by any tap) and into
  the heartbeat (the menu bar shows `🎤 "..."` with a `↳` reply line). This is the only Mac-side
  visibility there is - a headless `claude -p --resume` never appears in any Claude Code window.
  - **The card is keyed off a small `seq` counter, NOT the host's `Date.now()`.** That was a real bug
    with a silent failure: `long` on ESP32 is 32-bit (max 2,147,483,647) and a JS millisecond
    timestamp is ~1.79e12, so it overflowed and the "is this a new exchange?" comparison never fired.
    The card code was correct all along and simply never triggered. `at` is still sent for the Mac,
    which has no such limit.
  - Raised only for `sent`/`done`/`memo`/`error`, never the transient `heard` (transcript-only, a
    second before dispatch) - otherwise it flickers up for nothing. A dismissed card cannot be
    resurrected by the next 5s tick because `voiceSeqShown` is remembered.
  - The transcript renders in **Cozette on a panel**, the same treatment as code and commands,
    because it is verbatim quoted text and should not read as prose.
  - Text is capped host-side (200 chars transcript, 420 reply): the device's line buffer must hold a
    whole payload and asks already claim up to 1400 chars of it.
- **Session names come from the git repo ROOT, not the cwd.** The hook rewrites `cwd` on every event
  with Claude Code's *live* working directory, so `basename(cwd)` renamed a session mid-task the
  moment anything ran `cd` into a subdirectory - "core" became "host" while working. `projectName()`
  uses `git rev-parse --show-toplevel` instead, which is stable across any `cd` inside the repo and
  is what a person means by "the project"; outside a repo it falls back to the directory name. Cached
  per cwd, because it runs for every session on every 5s tick and the answer never changes. The
  `path` field deliberately still shows the LIVE cwd - that's useful for knowing where a session is
  actually working, so only the name is pinned.
- **`claude -p` waits on stdin unless you close it**, logging `no stdin data received in 3s` and
  stalling every dictation by three seconds. The dispatch passes
  `stdio: ["ignore", "pipe", "pipe"]`.
- **One-shot `MICREC` captures are transcribed too**, landing as memos (they carry no target). Only
  streams were, originally. This also gives a way to exercise the whole voice path - transcript,
  device card, menu bar - with a 4s capture instead of a 120s stream.
- **A plain session detail screen goes back via its HEADER ROW only, not "tap anywhere".** It used to
  close on any tap, which collided head-on with a recording's "tap anywhere to stop". The `< Back`
  label was already being drawn there, so honouring it merely makes the page behave the way it
  already looked. Taps elsewhere are inert. The FAB is visible on a plain detail screen (that is how
  you aim a dictation) but hidden whenever an **ask** is pending, so it can never overlap Allow/Deny.
- **The serial link will NOT go faster than 115200 on this CH340; raising it loses data silently.**
  Tried specifically to speed up audio. Percentage of a 64000-sample capture actually arriving:
  `115200 → 100%` · `230400 → 87%` · `460800 → 81-94%` · `921600 → garbage` (3% printable, and
  host→device commands stopped arriving too). Loss begins as soon as you exceed 115200, so it is not
  a rate you can tune around, and it is invisible without the completeness check above. The ROM
  bootloader and panic handler always print at **115200** regardless, so at any other rate a crash
  dump reads as garbage — its own debugging trap. The fix for throughput is flow control
  (chunk + ACK), not a bigger number.
- **The record button lives IN THE TAB BAR, in a reserved slot at the right end.** Tap to start,
  tap to stop. It is chrome, not a floating control, and that is what removes every hazard the
  floating versions kept running into. Three earlier homes were all wrong:
  - **BOOT key (GPIO0) - abandoned, and it bricked the device twice.** GPIO0 is also the serial
    bootloader strap and is driven by the USB adapter's **DTR** line, so it goes LOW after every
    reset and whenever the host merely opens the port. A tap handler therefore fired recordings by
    itself on flashing, and a strap held low past `POWER_OFF_HOLD_MS` sent the device into **deep
    sleep during boot** - which presents as bricked firmware: no serial output at ANY baud, dark
    screen, while esptool still talks to the chip happily. If that ever recurs, suspect sleep
    before code. Only the deliberate long HOLD (power off) remains on GPIO0.
  - **Floating and draggable - abandoned.** Hold 700ms, drag, release, position persisted to NVS as
    `fabx`/`faby`. On a resistive panel that needed a 70px spike reject, a 2px deadband, and a
    CLEARED content area to drag over - with no framebuffer to read back there is no way to restore
    what was under a moving object. Dropping the gesture took **1300 bytes of flash** with it. The
    `fabx`/`faby` NVS keys may still exist on devices flashed before the change; nothing reads them.
  - **Fixed, floating over the content's top-right corner - abandoned after one build.** It covered
    the 5-hour card and the first session row's pill, and on SETTINGS it landed exactly on the
    pager's "next" key (slot x 182..233 vs button x 182..229) - and since it is hit-tested before
    every other handler it swallowed the tap, so paging stopped working.
  **Cost of the tab-bar slot: the three tabs drop from 80px to 66px.** That is affordable because
  the labels are Cozette 6x13 and the longest ("SESSIONS", "SETTINGS") is 48px, so 66 still leaves
  room; the active-tab underline goes 64 -> 50. The slot is `TAB_REC_W` 40 wide, and the ring is
  **26px** (`REC_R` 13) rather than the old 48 because the bar is only 34 tall. Its tap target is
  the whole slot, which is under `TAP_MIN` in height - unavoidable, and no worse than the three
  tabs beside it, which have always been 34 tall.
  Three things are load-bearing:
  - **`fabHit()` still runs BEFORE the `showingDetail` branch.** The tab bar is drawn on the detail
    and ask screens but is inert there - `handleTouch` returns at `showingDetail` before reaching
    the tab-bar branch - so without that ordering the button would be visible and dead exactly
    where you aim a dictation at a session.
  - **Nothing calls `drawFab()` per tick any more.** The floating version was repainted last on
    every tick to survive whatever had just been drawn under it. `drawFab` now clears its slot
    first, so a per-tick call would be a clear-then-redraw every 5s - the flicker this file's
    redraw discipline exists to prevent. The bar paints it, and the bar only repaints on a tab
    switch or a full repaint.
  - **The 1px `COLOR_BG` haloes are gone.** They existed to keep an outline readable over ARBITRARY
    content; the tab bar's fill is known and flat, so the ring blends against `COLOR_CARD` instead.
  **Visual: it is drawn as a FOURTH TAB, not as a shape of its own.** Same Cozette 6x13 label
  (`REC`), same `COLOR_LABEL` / `COLOR_VALUE` pair, and the same 3px `COLOR_ACCENT` underline inset
  8px that marks a tab as active - pressed here means what active means there, so every item in the
  bar reports its state the same way. It replaced a 26px ring, which was a second visual language
  sitting inside a bar that already had one.
  The one deliberate difference is the **leading dot**: a bare `REC` among three navigation labels
  reads as a fourth destination, and the dot is the universal record mark saying this one DOES
  something rather than going somewhere. Dot and label are laid out as a single group and centred
  together (6 + 3 + 18 = 27px in the 40px slot), so the pair is optically centred instead of the
  text being centred with the dot hanging off its left.
  `fabVisible()` hides it only when asleep or when the crab owns the screen, because chrome that
  blinks in and out reads as a glitch.
- If this mic is ever replaced, an **INMP441** (I2S) is viable and needs no analog tuning:
  `SCK`→IO18, `WS`→IO19, `SD`→IO35. IO18/19/23 are the **microSD** bus and this firmware contains
  no SD code at all, so they're free as long as the card slot is unused.
- **BOARD 2 goes one step further: it cannot WAKE from deep sleep by touch either**, so auto-sleep
  is disabled there and only the manual POWER OFF remains. Same class of hardware fact as this
  bullet, different pin arithmetic — see Two boards.
- **There is NO true power-off on this board, and it is a hardware fact, not a missing feature.**
  The power path is pure hardware - the TP4054 charger and the Q3 P-FET that switches USB/battery
  have no GPIO control, and no regulator-enable or VBUS-sense line is exposed - so the MCU cannot
  cut its own supply. Deep sleep is the deepest state firmware can reach. Estimated residual draw
  is ~7mA, dominated by parts nothing in software can switch: an AMS1117-class LDO's quiescent
  (~5mA) and the CH340 (~1.5mA), against ~0.5mA for the XPT2046 that must stay powered for the
  PENIRQ wake. Sleep already removes the backlight (~100mA, ~93% of the draw). A genuine off needs
  hardware: a switch in the battery lead, or a soft-latch (P-FET held on by a GPIO, released to cut
  power). Do not go looking for a software answer to this again.
- **A wake must be a HELD touch, and this is where the battery actually goes.** ext0 fires on any
  PENIRQ edge, so a sleeve or a knock used to wake the device fully - radio up, panel out of SLPIN,
  backlight to 100%. `setup()` now brings up the touch bus FIRST (it is on its own HSPI and costs
  nothing), qualifies the wake before `setupBLE()` or `tft.init()`, and drops straight back to deep
  sleep unless the touch is held for `WAKE_HOLD_MS` (350ms). The re-sleep deliberately does NOT go
  through `enterDeepSleep()`: the panel never left SLPIN and the backlight pad is still latched low
  from the original sleep, so touching either would only undo what is already correct.
- **The device measures its own sleep drain.** `enterDeepSleep()` records battery mV and
  `esp_timer_get_time()` into RTC memory (which survives deep sleep); the next real wake prints
  `SLEEP report: <hours>, <mV> -> <mV> (<delta>, <mV/h>), spurious wakes=<n>`. mV/h is the raw
  datum on purpose - converting it to mA needs the cell's discharge curve, which we do not have.
  **Timing comes from `gettimeofday()`, NOT `esp_timer_get_time()`** - measured: an overnight run
  reported "elapsed unknown" because esp_timer does not span deep sleep on this core, which is
  exactly what the guard was added to catch. ESP-IDF advances `gettimeofday` by the RTC-measured
  sleep duration on wake, so the DELTA is right even though the absolute time is meaningless
  (nothing sets the clock). Verified over a 3-minute sleep.
  Two things stop it reporting nonsense. The EMA is **settled with 12 samples before comparing** -
  `batteryMv` resets to -1 on boot, so a single read is RAW while the pre-sleep figure was
  smoothed, and comparing the two attributes the difference between two METHODS to the battery.
  And **no rate is printed for a sleep under 30 minutes**: a 3-minute run with a 7mV delta, which
  is inside the ADC's own noise, produced "-133.7 mV/h" - a flat cell in four hours. That is noise
  multiplied by 20, and printing it invites precisely the wrong conclusion.
  There is deliberately **no "on USB" flag**. `usbLinkActive()` keys off host traffic and on wake
  `millis()` has restarted with none yet, so it was always false regardless of the cable; this
  board has no VBUS-sense pin, so the firmware genuinely cannot tell. A flag that is silently
  always-false is worse than none, because its absence reads as "not on USB". A RISING value is
  reported instead, since that can only mean it was charging.
  Spurious wakes accumulate across re-sleeps and are reported with the drain, so the guard's value
  is visible rather than assumed.
- "Power off" (hold BOOT ~1s) is ESP32 deep sleep, not a real power cut: panel DISPOFF+SLPIN,
  backlight pin latched low via `gpio_hold_en` (GPIOs float in deep sleep — and setup() must
  `gpio_hold_dis` it again after wake, before re-attaching LEDC), wake via ext0 on IO36 (the
  XPT2046's PENIRQ, which works while the ESP32 sleeps because the 3.3V rail stays up). Wake is
  deliberately **touch, not the BOOT key**: GPIO0 held low across the wake reset straps the
  chip into the serial bootloader and it looks bricked until a manual reset. The manual power-off
  and the automatic battery-idle sleep share `enterDeepSleep()`.
- **Automatic deep-sleep is DISABLED on board 2**, because that board cannot wake from deep sleep
  by touch at all — a silicon fact about the S3's RTC GPIO set, spelled out under Two boards. The
  rest of this bullet is board 1.
- Automatic deep-sleep (`AUTO_SLEEP_IDLE_MS`, 20 min): fires only when **on battery** with no
  fresh active session for the interval; touch and any fresh session reset `lastNonIdleMillis`.
  "On battery" is `!(lastRxUSBMillis fresh within 60s) && batteryPresent()` — deliberately a
  **60s** USB-quiet window, not `batteryState()==DISCHARGING` (which flips on the 10s
  `usbLinkActive` threshold and briefly reads "battery" during a slow host tick, which once
  caused spurious sleeps). Debugging note: the SESSIONS feature captures each Bash command as a
  `PermissionRequest` ask detail, so any word you `grep` for that's also in your command shows up
  inside the host log's tick JSON — match device prints by the `^[device/usb] ` line prefix, not
  a bare substring, or you'll chase phantom events.
- The sessions list's row height is computed from the session count (tall rows for 1-3
  sessions, compact for 5-6); touch hit-testing in `handleTouch` uses the same `sessionRowH`
  global, so any layout change must keep those two in sync.
