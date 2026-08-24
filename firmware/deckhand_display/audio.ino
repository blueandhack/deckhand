// Microphone, recording and voice UI. Split out of deckhand_display.ino:
// the Arduino build concatenates every .ino in this folder (the one matching the
// folder name FIRST, then the rest alphabetically) into one translation unit, so
// these functions still share every global and no headers are involved.
//
// What must NOT move here: anything whose SIGNATURE names a type defined after
// the first function definition in the main file (HostPairing, Theme, Usage,
// SessionInfo, ConfirmAction). Auto-generated prototypes are inserted above
// those definitions, so such a prototype would not compile. Everything below
// takes primitives or void.

// ---------- The two ANALOG LEVEL probes: board 1 only ----------
// Compiled only when BOARD_HAS_MIC, and not because the port skipped them: board
// 2 has no analog microphone. Its audio is an I2S codec, so there is no ADC1
// channel to sample, no DC bias to measure and no gain trimmer to tune - and
// giving MIC_ADC_PIN an alias pointing at an I2S data line would compile and
// produce confident nonsense, which is the failure mode this port keeps
// refusing. No stubs are needed for these two: their only callers are
// micLevelTest() and micMonitor(), which sit inside the same guard below.
// BOARD 1 ONLY. These reduce an ADC-DMA buffer, so they are meaningless on a board
// whose samples arrive from a codec over I2S - and MIC_ADC_PIN, which board 2's
// header deliberately does not define, would not even compile there.
#if BOARD_HAS_MIC && BOARD_USES_TFT_ESPI
// Noise floor at three bandwidths: raw, and smoothed over 4 and 16 samples.
// A moving average is a crude low-pass, so comparing the three says WHERE the
// noise lives - which decides the fix:
//   collapses with smoothing -> pickup is high-frequency (above the voice band),
//     curable with a cap at the ADC pin or by oversampling in software;
//   barely dents -> the noise is down in the voice band with the speech, and no
//     filter can separate them - that's a hardware/module problem.
// Worth measuring because the gain trimmer doesn't move this floor at all, so
// it isn't arriving through the amplifier's gain stage.
void micFloorProfile(int ms, int* ppRaw, int* pp4, int* pp16) {
  const uint32_t period = 1000000UL / MIC_TEST_HZ;
  int mnR = 4095, mxR = 0, mn4 = 4095, mx4 = 0, mn16 = 4095, mx16 = 0;
  int ring[16];
  for (int i = 0; i < 16; i++) ring[i] = 0;
  unsigned long idx = 0;
  unsigned long t0 = micros(), next = t0;
  while (micros() - t0 < (unsigned long) ms * 1000UL) {
    while ((long) (micros() - next) < 0) {}
    next += period;
    int v = analogRead(MIC_ADC_PIN);
    if (v < mnR) mnR = v;
    if (v > mxR) mxR = v;
    ring[idx & 15] = v;
    idx++;
    if (idx >= 16) { // ring is full, averages are meaningful
      long s4 = 0;
      for (int k = 0; k < 4; k++) s4 += ring[(idx - 1 - k) & 15];
      int a4 = (int) (s4 / 4);
      long s16 = 0;
      for (int k = 0; k < 16; k++) s16 += ring[k];
      int a16 = (int) (s16 / 16);
      if (a4 < mn4) mn4 = a4;
      if (a4 > mx4) mx4 = a4;
      if (a16 < mn16) mn16 = a16;
      if (a16 > mx16) mx16 = a16;
    }
  }
  *ppRaw = mxR - mnR;
  *pp4 = mx4 - mn4;
  *pp16 = mx16 - mn16;
}
// Peak-to-peak over one short burst, at the test's sample rate.
int micWindowPP(int ms) {
  const uint32_t period = 1000000UL / MIC_TEST_HZ;
  int wmn = 4095, wmx = 0;
  unsigned long t0 = micros(), next = t0;
  while (micros() - t0 < (unsigned long) ms * 1000UL) {
    while ((long) (micros() - next) < 0) {}
    next += period;
    int v = analogRead(MIC_ADC_PIN);
    if (v < wmn) wmn = v;
    if (v > wmx) wmx = v;
  }
  return wmx - wmn;
}
#endif  // BOARD_HAS_MIC && BOARD_USES_TFT_ESPI - the analog level probes
uint8_t muLawEncode(int32_t s) {
  const int32_t BIAS = 0x84, CLIP = 32635;
  int32_t sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  int exp = 7;
  for (int32_t mask = 0x4000; (s & mask) == 0 && exp > 0; mask >>= 1) exp--;
  int32_t mant = (s >> (exp + 3)) & 0x0F;
  return (uint8_t) ~(sign | (exp << 4) | mant);
}
void micDumpBase64(const uint8_t* data, size_t len) {
  const size_t PER_LINE = 144; // 144 bytes -> 192 base64 chars per line
  char line[200];
  for (size_t off = 0; off < len; off += PER_LINE) {
    size_t n = len - off < PER_LINE ? len - off : PER_LINE;
    int o = 0;
    for (size_t i = 0; i < n; i += 3) {
      uint32_t v = (uint32_t) data[off + i] << 16;
      if (i + 1 < n) v |= (uint32_t) data[off + i + 1] << 8;
      if (i + 2 < n) v |= data[off + i + 2];
      line[o++] = B64[(v >> 18) & 63];
      line[o++] = B64[(v >> 12) & 63];
      line[o++] = (i + 1 < n) ? B64[(v >> 6) & 63] : '=';
      line[o++] = (i + 2 < n) ? B64[v & 63] : '=';
    }
    line[o] = '\0';
    Serial.printf("AUDIO d %s\n", line);
    // The UART blocks on its own semaphore, but give the stack air anyway:
    // this is ~445 lines back to back. Same cadence drives the progress bar, so
    // the ~9s transfer isn't a dead wait with nothing on screen.
    if ((off / PER_LINE) % 16 == 0) {
      char pctTxt[12];
      snprintf(pctTxt, sizeof(pctTxt), "%d%%", (int) (off * 100 / (len ? len : 1)));
      micPillMeter((int) (off * 1000 / (len ? len : 1)), pctTxt, "sending to your Mac");
#if !BOARD_USES_TFT_ESPI
      // ~9s of base64 lines with nothing else returning to loop() in between -
      // without this the progress bar would sit at its first frame the whole
      // transfer, the exact "nothing is happening" this bar exists to prevent.
      tft.flush();
#endif
      delay(1);
    }
  }
}
const char* voiceStateLabel() {
  if (!strcmp(voiceState, "heard")) return "TRANSCRIBED";
  if (!strcmp(voiceState, "memo")) return "SAVED AS MEMO";
  if (!strcmp(voiceState, "sent")) return "SENT TO SESSION";
  // Delivery is the clipboard by default now - the host hands it to the user rather than
  // running it headlessly. (An older device just falls through to "VOICE", so the host
  // change is safe to ship on its own.)
  if (!strcmp(voiceState, "clip")) return "COPIED - PASTE IT";
  if (!strcmp(voiceState, "done")) return "CLAUDE REPLIED";
  if (!strcmp(voiceState, "error")) return "FAILED";
  // Answer-flow states: without these, "capture incomplete", "transcription
  // failed" and "nothing recognised" were invisible - the user tapped SPEAK,
  // spoke, and nothing happened at all, burning the 90s hook budget with no
  // signal to retry. "askheard" deliberately has no card (the confirm screen
  // is already about to show the text) so it isn't listed here as a raise
  // state, but it falls through to "VOICE" harmlessly if ever drawn.
  if (!strcmp(voiceState, "askerror")) return "VOICE FAILED";
  if (!strcmp(voiceState, "asksent")) return "ANSWER SENT";
  return "VOICE";
}
// THE CARD'S WHOLE COLUMN, at compile time. `avail` below clamps to 1 line when the
// arithmetic says none fit, and a clamp is exactly how this card would overdraw the
// footer band rather than fail: assert instead that a first reply line genuinely fits.
// BOARD_H rather than tft.height() because only the former is a constant expression;
// they are equal at SCREEN_ROTATION 0, the same substitution the reader's page-budget
// asserts make. Board 1: 34+22+12+90+10+12+13 = 193 of 294. Board 2: 234 of 452.
static_assert(CONTENT_Y + 22 + VOICE_LBL_STEP
                  + (VOICE_TEXT_LINES * CODE_LINE_H + 12) + 10
                  + VOICE_LBL_STEP + CODE_LINE_H
                <= (BOARD_H - FOOTER_H) - 8,
              "the voice result card no longer leaves room for one line of reply - "
              "`avail`'s clamp would draw it into the footer band instead of failing "
              "here; shrink VOICE_TEXT_LINES or the card's padding");
// The state label and "tap to dismiss" share the row at CONTENT_Y + 6, and the
// transcript block starts at CONTENT_Y + 22. Board 2 clears that EXACTLY (6 + 16 = 22),
// which is worth an assert rather than a comment: one more pixel of cell and the top
// row would be overdrawn with no other symptom than crowded text.
static_assert(6 + CODE_LINE_H <= 22,
              "the voice card's state-label row now runs into its YOU SAID block");
void drawVoiceCard() {
  const bool bad = !strcmp(voiceState, "error") || !strcmp(voiceState, "askerror");
  tft.fillRect(0, CONTENT_Y, tft.width(), contentBottom() - CONTENT_Y, COLOR_BG);
  setUIFont(1);
  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(bad ? COLOR_BAD : COLOR_ACCENT, COLOR_BG);
  tft.drawString(voiceStateLabel(), CARD_X, CONTENT_Y + 6);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.setTextDatum(TR_DATUM);
  tft.drawString("tap to dismiss", tft.width() - CARD_X, CONTENT_Y + 6);
  tft.setTextDatum(TL_DATUM);

  // EVERY STEP HERE IS CODE_LINE_H / VOICE_LBL_STEP, NOT THE LITERAL 13 AND 12 THIS
  // USED TO CARRY, and this card is the MOST reachable of the three sites that had the
  // Cozette literal - more reachable than the voice-confirm panel, because it needs no
  // pending ask at all. drawVoiceCard() sits OUTSIDE both of audio.ino's
  // `#if BOARD_HAS_MIC` blocks and the raise path in handleLine has no BOARD_HAS_MIC
  // guard either, so board 1 dictating - or any MICREC memo - has the host publish
  // `voice{seq,text,reply}` in the tick both boards share, and board 2 draws the card.
  // At a 13px step under a 16px cell that meant, all at once: a panel ~24px short of
  // its own text, each transcript line's opaque box eating the previous line's
  // descenders, the "YOU SAID" label losing its bottom 4 rows to the panel fill, and an
  // `avail` that over-counts the reply's lines by ~23% so the block runs into the
  // footer band. Same argument as the confirm panel's - a host-parked exchange is
  // republished to every link, and MAX_LINKS is 2 - applied to a site that does not even
  // need the ask.
  //
  // The layout, per board (label rows are TL_DATUM, so the box IS the cell):
  //          board 1 (13/12)                board 2 (16/16)
  //   YOU SAID   56..68                       68..83
  //   panel      68..157   (6*13+12 = 90)     84..191  (6*16+12 = 108)
  //   text       74..151                      90..185
  //   CLAUDE     168..180                     202..217
  //   reply      180..283  (8 lines)          218..441 (14 lines)
  //   bound      302 - 8 = 294                460 - 8 = 452
  int maxW = tft.width() - 2 * CARD_X;
  int y = CONTENT_Y + 22;
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString("YOU SAID", CARD_X, y);
  y += VOICE_LBL_STEP;
  // The code face on a panel: this is quoted text, and the code style reads as "verbatim".
  int lines = countWrappedLines(voiceText, FONT_CODE, maxW - 14);
  // THE TWO 6s ARE DELIBERATELY LITERALS WHERE EVERY OTHER NUMBER HERE IS NAMED, and
  // that is not an oversight - it is the byte-identical rule winning an argument on
  // points. Writing VOICE_TEXT_LINES in the clamp costs board 1 EIGHT BYTES of flash
  // for no behaviour change: GCC compiles `min(lines, <literal>)` with the xtensa `min`
  // instruction and `min(lines, <named const>)` as `bgei` past a pre-loaded 90, which
  // is the same computation two bytes shorter (verified by disassembling both:
  // `movi a9,6; min a10,a10,a9; addx2; addx4; addi` against `movi a6,90; bgei a10,7,+e;
  // addx2; addx4; addi`). The line STEP and the label step are a different matter - a
  // literal 13 there is a real defect on board 2, which is why they ARE named - but 6
  // is board-agnostic and correct on both, so there is nothing to buy here.
  // sessions-geom-check.mjs parses these two literals out of this file and asserts both
  // equal VOICE_TEXT_LINES, so they cannot drift from the constant the static_assert
  // above and the checker's own layout walk are built on.
  int h = (lines > 6 ? 6 : lines) * CODE_LINE_H + 12;
  uiFillRound(CARD_X - 4, y, maxW + 8, h, R_SM, COLOR_CARD, COLOR_BG);
  drawWrappedText(voiceText, CARD_X + 3, y + 6, FONT_CODE, CODE_LINE_H, maxW - 14, 0, 6,
                  COLOR_VALUE, COLOR_CARD);
  y += h + 10;

  if (voiceReply[0]) {
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    setUIFont(1);
    tft.drawString(bad ? "ERROR" : "CLAUDE", CARD_X, y);
    y += VOICE_LBL_STEP;
    int avail = (contentBottom() - 8 - y) / CODE_LINE_H;
    if (avail < 1) avail = 1;
    drawWrappedText(voiceReply, CARD_X, y, FONT_CODE, CODE_LINE_H, maxW, 0, avail,
                    bad ? COLOR_BAD : COLOR_VALUE, COLOR_BG);
  }
}
// Wait for the finger to lift before handing control back. Without this the tap
// that STOPPED a recording is still down when handleTouch resumes, gets read as a
// fresh press, and - on a session detail screen - closes the page the instant you
// stop dictating.
void micWaitRelease() {
  unsigned long t0 = millis();
  while (touchPressed() && millis() - t0 < 2000) delay(20);
  delay(60); // let the panel settle
}
// The fourth stage of the recording bar. Reuses micPillFrame, so the frame, position
// and colours are the ones that were on screen a moment earlier - the point is that
// this reads as a continuation of the same operation, not a new dialog.
//
// The progress track micPillFrame draws is used for an INDETERMINATE SWEEP rather than
// a percentage. whisper's progress is not observable, so a filling bar would be
// inventing one; a segment travelling back and forth says "working, duration unknown"
// without claiming to know more than we do. Elapsed seconds sit where the recording
// meter puts its value, and are the honest quantity - they let the user judge whether
// something is wrong.
//
// Split frame-vs-update for the same reason micPillMeter is: repainting a rounded card
// and its stroke several times a second is exactly the flicker this file's redraw
// discipline exists to prevent. The frame is painted on entry and only when the TITLE
// changes; the sweep and the counter repaint on their own.
const char* micProcTitle() {
  if ((millis() - micProcStartMs) > MIC_PROC_STALE_MS) return "NO REPLY FROM MAC";
  return micProcConfirmed ? "TRANSCRIBING" : "PROCESSING";
}
char micProcTitleShown[20] = "";

void drawMicProcessingFrame() {
  micPillFrame(micProcTitle());
  snprintf(micProcTitleShown, sizeof(micProcTitleShown), "%s", micProcTitle());
  int x = micPillX(), y = micPillY(), w = micPillW();
  setUIFont(T_META);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.setTextDatum(TC_DATUM);
  tft.drawString("TAP TO DISMISS", x + w / 2, y + MIC_PILL_H - 15);
  tft.setTextDatum(TL_DATUM);
}

void drawMicProcessingUpdate() {
  int x = micPillX(), y = micPillY(), w = micPillW();
  unsigned long el = millis() - micProcStartMs;
  bool stale = el > MIC_PROC_STALE_MS;

  // Elapsed seconds, on the title row's right - the same lane micPillMeter uses for
  // its percentage. Padded so a shrinking string cannot leave its own tail behind.
  char buf[12];
  snprintf(buf, sizeof(buf), "%lus  ", el / 1000);
  setUIFont(1);
  tft.setTextColor(stale ? COLOR_WARN : COLOR_VALUE, COLOR_CARD);
  tft.setTextDatum(TR_DATUM);
  tft.drawString(buf, x + w - SP_3, y + 6);
  tft.setTextDatum(TL_DATUM);

  // The sweep, inside the track micPillFrame already drew. Ping-pongs so it reads as
  // activity rather than as progress towards a right-hand edge.
  int bx = x + SP_3 + 2, by = y + 28, bw = w - 2 * SP_3 - 4, bh = 10;
  int segW = bw / 4;
  int span = bw - segW;
  int t = (int) ((millis() / 12) % (unsigned long) (2 * span));
  int pos = t < span ? t : (2 * span - t);
  tft.fillRect(bx, by, pos, bh, COLOR_BG);
  tft.fillRect(bx + pos, by, segW, bh, stale ? COLOR_WARN : COLOR_ACCENT);
  tft.fillRect(bx + pos + segW, by, bw - pos - segW, bh, COLOR_BG);
}

// Called from loop(): advances the sweep and the counter. Cheap and gated, so it costs
// nothing when no capture is being processed.
void tickMicProcessing() {
  if (!micProcessing || isAsleep) return;
  // Long past any plausible reply: take the bar down rather than hold the screen. The
  // failure is already in the host log, and a message nobody is standing next to is not
  // worth a permanent slab of the content area.
  if (millis() - micProcStartMs > MIC_PROC_GIVEUP_MS) { micProcessingDone(); return; }
  if (millis() - micProcLastDraw < MIC_PROC_DRAW_MS) return;
  micProcLastDraw = millis();
  // The title changes twice at most (confirmed, then stale), and only then does the
  // whole frame need repainting.
  if (strcmp(micProcTitleShown, micProcTitle()) != 0) drawMicProcessingFrame();
  drawMicProcessingUpdate();
}

void micProcessingBegin() {
  micProcessing = true;
  micProcConfirmed = false;
  micProcStartMs = millis();
  micProcLastDraw = 0;
  micProcTitleShown[0] = '\0';
  drawMicProcessingFrame();
  drawMicProcessingUpdate();
}

// Ends the processing stage and hands the screen back. One place, so every exit - a
// result arriving, a tap, or the caller giving up - leaves the same clean state.
void micProcessingDone() {
  if (!micProcessing) return;
  micProcessing = false;
  micProcConfirmed = false;
  micRestoreUi();
}

void micRestoreUi() {
  if (!everReceived) { // nothing to show yet - back to the standalone screen
    drawWaitingScreen();
    return;
  }
  forceFullRepaint();
}
int micPillX() { return 14; }
int micPillW() { return tft.width() - 28; }
int micPillY() { return contentBottom() - MIC_PILL_H - 8; }
void micPillFrame(const char* title) {
  int x = micPillX(), y = micPillY(), w = micPillW();
  uiFillRound(x, y, w, MIC_PILL_H, R_MD, COLOR_CARD, COLOR_BG);
  uiStrokeRound(x, y, w, MIC_PILL_H, R_MD, BORDER_CTRL, COLOR_ACCENT, COLOR_BG);
  // A filled dot beside the title marks "live" by shape, the same way the status
  // pills on the sessions list do.
  tft.fillSmoothCircle(x + SP_3 + 3, y + 13, 4, COLOR_ACCENT, COLOR_CARD);
  setUIFont(1);
  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(COLOR_ACCENT, COLOR_CARD);
  tft.drawString(title, x + SP_3 + 12, y + 9);
  // Draw the meter's TRACK once, here, so the per-frame update only has to paint
  // the bar itself - repainting a rounded track 8x a second would flicker.
  int bx = x + SP_3, by = y + 26, bw = w - 2 * SP_3, bh = 14;
  uiFillRound(bx, by, bw, bh, R_SM, COLOR_BG, COLOR_CARD);
  uiStrokeRound(bx, by, bw, bh, R_SM, BORDER_CTRL, COLOR_LABEL, COLOR_CARD);
}
// level 0..1000. `right` is the elapsed/percentage readout, `hint` the caption.
void micPillMeter(int level1000, const char* right, const char* hint) {
  int x = micPillX(), y = micPillY(), w = micPillW();
  // Elapsed time in the bigger font and in white: it's the number you actually
  // watch while talking, so it earns the visual weight.
  setUIFont(2);
  tft.setTextDatum(TR_DATUM);
  tft.setTextColor(COLOR_VALUE, COLOR_CARD);
  char pad[16];
  snprintf(pad, sizeof(pad), "%-8s", right); // fixed width: no clear-then-redraw
  tft.drawString(pad, x + w - SP_3, y + 6);

  int bx = x + SP_3 + 2, by = y + 28, bw = w - 2 * SP_3 - 4, bh = 10;
  int fill = constrain(level1000, 0, 1000) * bw / 1000;
  tft.fillRect(bx, by, fill, bh, COLOR_GOOD);
  tft.fillRect(bx + fill, by, bw - fill, bh, COLOR_BG);

  setUIFont(1);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(COLOR_LABEL, COLOR_CARD);
  tft.drawString(hint, x + w / 2, y + MIC_PILL_H - 11);
  tft.setTextDatum(TL_DATUM);
}
// Standard IMA ADPCM: 4 bits per sample, and the encoder tracks the same
// predictor the decoder will, so the two stay in lockstep with no side channel.
uint8_t imaEncode(int sample, int* pred, int* index) {
  int step = IMA_STEP[*index];
  int diff = sample - *pred;
  int code = 0;
  if (diff < 0) { code = 8; diff = -diff; }
  int t = step;
  if (diff >= t) { code |= 4; diff -= t; }
  t >>= 1;
  if (diff >= t) { code |= 2; diff -= t; }
  t >>= 1;
  if (diff >= t) { code |= 1; }
  int dq = step >> 3;
  if (code & 4) dq += step;
  if (code & 2) dq += step >> 1;
  if (code & 1) dq += step >> 2;
  *pred += (code & 8) ? -dq : dq;
  *pred = constrain(*pred, -32768, 32767);
  *index = constrain(*index + IMA_INDEX[code], 0, 88);
  return (uint8_t) (code & 0x0F);
}
// DELIBERATELY KEPT WITH NO CALLERS, the way authHmac() is - not silently
// dead. This existed solely to pick which Mac an AUDIO line's now-reverted
// `to=` address should name (see the AUDIO stream call site, which no
// longer calls this); audio rides Serial.printf, never BLE, so it always
// reaches exactly one Mac by construction and addressing it could only ever
// cause harm, never prevent a broadcast. Left in place - correct, exercised
// by nothing - in case a future genuine need for "which Mac is on the USB
// cable right now" shows up; usbHostId/curLineFromUsb in the main sketch
// exist only to feed it and share this same status.
int primaryLink() {
  bool usbUp = usbLinkActive();
  for (int i = 0; i < MAX_LINKS; i++)
    if (hostLinks[i].used && usbUp && strcmp(hostLinks[i].hostId, usbHostId) == 0) return i;
  if (usbHostId[0]) {
    int i = linkForHost(usbHostId, false);
    if (i >= 0) return i;
  }
  if (allowedHost[0]) { int i = linkForHost(allowedHost, false); if (i >= 0) return i; }
  for (int i = 0; i < MAX_LINKS; i++) if (hostLinks[i].used) return i;
  return -1;
}
// ---------- THE ANALOG CAPTURE PATH: BOARD 1 ONLY ----------
// Everything from here to the end of this file needs the analog mic, so it is
// guarded for the reason given above - plus a mechanical one that would bite even
// if a mic were wired to board 2: the DMA frame struct differs per chip.
// adc_digi_output_data_t carries a `type1` member on the ESP32 and ONLY a `type2`
// on the S3 (checked in the installed hal/adc_types.h, which selects per
// CONFIG_IDF_TARGET_*), so the sample unpacking below is board-1 shaped down to
// the field name, as is the hardcoded ADC_CHANNEL_7 for IO35.
//
// The four entry points get no-op stubs at the bottom rather than having their
// callers removed, because those callers are UI: the record slot in the tab bar,
// SETTINGS > MIC TEST, and the MICTEST/MICMON/MICREC/MICSTREAM commands.
// Deleting them would move layout Task 8 derived and rewrite the settings page;
// a stub keeps board 2's screen exactly as designed and puts the whole gap in
// one place.
#if BOARD_HAS_MIC && BOARD_USES_TFT_ESPI
void micStream() {
  // ADC driver FIRST, before any large allocation - see the allocation-order note
  // in micRecord(): getting this backwards turns an out-of-memory into abort().
  adc_continuous_handle_t adc = NULL;
  adc_continuous_handle_cfg_t hcfg = {};
  // Deeper than the one-shot path: ~256ms of slack, so any single stall in the
  // send path can't cost samples.
  hcfg.max_store_buf_size = 16384;
  hcfg.conv_frame_size = 1024;
  if (adc_continuous_new_handle(&hcfg, &adc) != ESP_OK) {
    Serial.printf("AUDIO error: adc handle failed (%u free)\n", (unsigned) ESP.getFreeHeap());
    return;
  }
  adc_digi_pattern_config_t pat = {};
  pat.atten = ADC_ATTEN_DB_12;
  pat.channel = ADC_CHANNEL_7;
  pat.unit = ADC_UNIT_1;
  pat.bit_width = 12;
  adc_continuous_config_t ccfg = {};
  ccfg.pattern_num = 1;
  ccfg.adc_pattern = &pat;
  ccfg.sample_freq_hz = MIC_REC_RATE_OUT * MIC_REC_OVERSAMPLE;
  ccfg.conv_mode = ADC_CONV_SINGLE_UNIT_1;
  ccfg.format = ADC_DIGI_OUTPUT_FORMAT_TYPE1;
  if (adc_continuous_config(adc, &ccfg) != ESP_OK) {
    Serial.println("AUDIO error: adc config failed");
    adc_continuous_deinit(adc);
    return;
  }
  uint8_t* ring = (uint8_t*) malloc(MIC_STREAM_RING);
  if (!ring) {
    Serial.println("AUDIO error: no heap for ring");
    adc_continuous_deinit(adc);
    return;
  }

  digitalWrite(AUDIO_EN_PIN, LOW);
  ledcWrite(AUDIO_OUT_PIN, MIC_CUE_DUTY);
  delay(140);
  ledcWrite(AUDIO_OUT_PIN, 0);
  digitalWrite(AUDIO_EN_PIN, HIGH);
  delay(250);
  micPillFrame(showingDetail ? "DICTATING" : "LISTENING");

  adc_continuous_start(adc);
  uint8_t frame[1024]; // matches conv_frame_size
  int dc = 0;
  {   // bias before encoding: ADPCM is differential, a DC offset just wastes range
    long sum = 0; int c = 0;
    unsigned long t0 = millis();
    while (millis() - t0 < 200) {
      uint32_t len = 0;
      if (adc_continuous_read(adc, frame, sizeof(frame), &len, 100) != ESP_OK) continue;
      for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= len; i += SOC_ADC_DIGI_RESULT_BYTES) {
        sum += ((adc_digi_output_data_t*) &frame[i])->type1.data; c++;
      }
    }
    dc = c ? (int) (sum / c) : 2048;
  }

  // Which session is this dictation FOR? Whatever detail screen you started from.
  // "-" means no target: the capture is transcribed and logged, nothing is sent.
  // Re-resolved by id (resolveDetailIndex(), the same helper renderSessionsTab
  // and the touch handlers use) rather than trusting whatever detailIndex
  // already held: dropSessionsForLink() can compact the sessions array between
  // the FAB press and this point (a 5s tick landing while voiceCardActive or
  // micProcessing is up), so a stale index could aim this dictation at
  // whatever session slid into that slot instead of the one actually opened.
  const char* target = "-";
  if (showingDetail) {
    detailIndex = resolveDetailIndex();
    if (detailIndex >= 0 && detailIndex < sessionCount) target = sessions[detailIndex].id;
  }
  // Deliberately UNADDRESSED, reverting an earlier ruling that this should
  // carry `to=primaryLink()`. That ruling was wrong: this line rides
  // Serial.printf, never BLE (audio is USB-only by RATE - 16kHz IMA ADPCM is
  // ~8KB/s against this CH340's 11.5KB/s ceiling, and raising the baud loses
  // data - see the baud note), so it physically reaches exactly one Mac by
  // construction and an address can never prevent a BLE broadcast that was
  // never happening. Its only reachable effect was harm: if primaryLink()
  // resolved to a Mac that is NOT the one on the cable (its link aged out,
  // usbHostId unset, or allowedHost pinned to the other Mac), the cable
  // Mac's own lineTargetsUs filter would drop this header before logging it
  // - audioStream never opens, no AUDIO ack is ever written, and the device
  // streams for up to 120s on its stall valve while the capture is lost
  // with no line in either log. Broadcast has no such failure mode.
  Serial.printf("AUDIO stream rate=%d codec=ima4 chunk=%d scale=8 dc=%d target=%s answer=%s\n",
                MIC_REC_RATE_OUT, MIC_STREAM_CHUNK, dc, target,
                micAnswerPid[0] ? micAnswerPid : "-");

  int pred = 0, index = 0;          // ADPCM state
  int head = 0, tail = 0, ringUsed = 0;
  bool nibbleHigh = false;
  uint8_t partial = 0;
  uint32_t seqSent = 0, seqAcked = 0, samples = 0, dropped = 0;
  uint32_t acc = 0; int accN = 0;
  int lvlMin = 32767, lvlMax = -32768;
  // Touch is polled on its OWN cadence, NOT inside the meter repaint. micMonitor
  // has always done it this way (10ms, two votes); micStream had the poll nested
  // in the 120ms UI block, so a stop needed two positives 120ms apart - 240ms at
  // worst - and, far worse, a tap whose contact did not span two of those polls
  // reset stopVotes to 0 and did nothing at all. A normal tap is 80-150ms, so
  // that happened often, which is what made stopping feel unresponsive.
  // 10, not 20: the loop already turns over every ~16ms (a 1024-byte
  // conv_frame at 32kHz x 2 bytes), so a 20ms gate would fire on every OTHER
  // iteration and quietly cost 64ms for two votes. At 10 the gate never delays
  // a poll, it only bounds it if this loop ever spins faster. Two votes ~32ms.
  const unsigned long STOP_POLL_MS = 10;
  unsigned long start = millis(), lastUi = 0, lastStopPoll = 0;
  bool stoppedByUser = false;
  int stopVotes = 0;
  unsigned long windowBlockedAt = 0;
  String inLine;

  // 20s for an answer, 120s for a dictation - see MIC_ANSWER_MAX_MS.
  const unsigned long cap = micAnswerPid[0] ? MIC_ANSWER_MAX_MS : MIC_STREAM_MAX_MS;
  while (millis() - start < cap) {
    uint32_t len = 0;
    if (adc_continuous_read(adc, frame, sizeof(frame), &len, 100) == ESP_OK) {
      for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= len; i += SOC_ADC_DIGI_RESULT_BYTES) {
        acc += ((adc_digi_output_data_t*) &frame[i])->type1.data;
        if (++accN < MIC_REC_OVERSAMPLE) continue;
        int v = (int) (acc / MIC_REC_OVERSAMPLE) - dc;
        acc = 0; accN = 0;
        if (v < lvlMin) lvlMin = v;
        if (v > lvlMax) lvlMax = v;
        uint8_t code = imaEncode(v * 8, &pred, &index);
        samples++;
        if (!nibbleHigh) { partial = code; nibbleHigh = true; continue; }
        uint8_t byteOut = (uint8_t) (partial | (code << 4));
        nibbleHigh = false;
        if (ringUsed < MIC_STREAM_RING) {
          ring[head] = byteOut;
          head = (head + 1) % MIC_STREAM_RING;
          ringUsed++;
        } else {
          dropped++;   // host fell behind for a full second; reported at the end
        }
      }
    }

    // Drain acks. Anything else the host sends is discarded for the duration -
    // one missed payload tick is a fair price for not corrupting the stream.
    while (Serial.available()) {
      char ch = (char) Serial.read();
      if (ch == '\n') {
        if (inLine.startsWith("AUDIO ack ")) seqAcked = (uint32_t) inLine.substring(10).toInt();
        inLine = "";
      } else if (inLine.length() < 40) {
        inLine += ch;
      }
    }

    // Send while the window allows. Windowing is the flow control: without it a
    // host stall silently overflows the OS buffer, which is exactly how a
    // truncated capture once transcribed as words nobody said.
    //
    // Safety valve: if the window has been shut for a while, assume an ACK was
    // lost and slide it by one. A dropped ack must cost throughput, never wedge
    // the stream - and the host detects and reports any real gap anyway.
    if (ringUsed >= MIC_STREAM_CHUNK && (seqSent - seqAcked) >= (uint32_t) MIC_STREAM_WINDOW) {
      if (!windowBlockedAt) windowBlockedAt = millis();
      else if (millis() - windowBlockedAt > 500) { seqAcked++; windowBlockedAt = 0; }
    } else {
      windowBlockedAt = 0;
    }
    while (ringUsed >= MIC_STREAM_CHUNK && (seqSent - seqAcked) < (uint32_t) MIC_STREAM_WINDOW) {
      Serial.printf("AUDIO bin %lu %d\n", (unsigned long) seqSent, MIC_STREAM_CHUNK);
      // One or two bulk writes, never per-byte: 1024 separate calls is pure
      // overhead, and the ring may wrap mid-chunk.
      int first = MIC_STREAM_CHUNK;
      if (tail + first > MIC_STREAM_RING) first = MIC_STREAM_RING - tail;
      Serial.write(ring + tail, first);
      if (first < MIC_STREAM_CHUNK) Serial.write(ring, MIC_STREAM_CHUNK - first);
      tail = (tail + MIC_STREAM_CHUNK) % MIC_STREAM_RING;
      ringUsed -= MIC_STREAM_CHUNK;
      seqSent++;
    }

    // Stop check, on its own fast cadence. Still TWO consecutive reads: a
    // resistive panel throws occasional false positives, and one of them ended a
    // 99s take early, reported as "by=tap" when nothing had been touched. At
    // 20ms apart that debounce costs ~40ms instead of 240ms, and a normal tap
    // spans several polls rather than risking a gap between two.
    // The 400ms grace stops the finger lifting off the START tap ending it.
    if (millis() - lastStopPoll >= STOP_POLL_MS) {
      lastStopPoll = millis();
      // Same cadence as the touch poll it rides alongside: drainBleRx() (and
      // therefore this reap) is only ever called from loop(), so this ~120s
      // capture would otherwise starve a queued disconnect for its whole
      // duration - see reapBleLinks()'s own comment. Safe here for the same
      // reason the touch poll is: this loop runs entirely on loopTask.
      // true: loop()'s watchdog can't reach here, so this IS the recovery.
      reapBleLinks(true);
      if (millis() - start > 400 && touchPressed()) {
        if (++stopVotes >= 2) { stoppedByUser = true; break; }
      } else {
        stopVotes = 0;
      }
    }

    if (millis() - lastUi >= 120) {
      lastUi = millis();
      int pp = (lvlMax > lvlMin) ? lvlMax - lvlMin : 0;
      lvlMin = 32767; lvlMax = -32768;
      char t[16];
      unsigned long el = millis() - start;
      snprintf(t, sizeof(t), "%lu:%02lu", el / 60000, (el / 1000) % 60);
      micPillMeter(pp * 1000 / 600, t, "TAP ANYWHERE TO STOP");
#if !BOARD_USES_TFT_ESPI
      // This capture can run up to MIC_STREAM_MAX_MS (120s) without ever
      // returning to loop(), so its own end-of-iteration flush is the only
      // thing that gets the meter onto the glass at all.
      tft.flush();
#endif
    }
  }

  adc_continuous_stop(adc);
  adc_continuous_deinit(adc);   // battery sampling needs ADC1 back

  // Flush the tail, ignoring the window: recording has stopped, so there is
  // nothing left to fall behind.
  if (nibbleHigh && ringUsed < MIC_STREAM_RING) {
    ring[head] = partial; head = (head + 1) % MIC_STREAM_RING; ringUsed++;
  }
  micPillFrame("SENDING");
  while (ringUsed > 0) {
    int n = ringUsed < MIC_STREAM_CHUNK ? ringUsed : MIC_STREAM_CHUNK;
    Serial.printf("AUDIO bin %lu %d\n", (unsigned long) seqSent, n);
    int first = n;
    if (tail + first > MIC_STREAM_RING) first = MIC_STREAM_RING - tail;
    Serial.write(ring + tail, first);
    if (first < n) Serial.write(ring, n - first);
    tail = (tail + n) % MIC_STREAM_RING;
    ringUsed -= n;
    seqSent++;
    delay(2);
  }
  Serial.printf("AUDIO streamend samples=%lu chunks=%lu dropped=%lu secs=%.1f by=%s\n",
                (unsigned long) samples, (unsigned long) seqSent, (unsigned long) dropped,
                (millis() - start) / 1000.0, stoppedByUser ? "tap" : "cap");
  free(ring);
  micWaitRelease();
  // Straight into the processing stage rather than restoring the UI: the transfer is
  // done but the Mac's work has only just started, and that gap is what used to look
  // like nothing happening.
  micProcessingBegin();
}
void micRecord() {
  // ORDER IS LOAD-BEARING: the DMA driver is created BEFORE the big audio buffer.
  // Doing it the other way round crash-LOOPS the device. adc_continuous_new_handle
  // needs internal DMA-capable memory, and with 64KB of audio buffer already taken
  // there wasn't enough; on that failure the IDF's own cleanup path calls
  // adc_continuous_deinit(), which frees an APB peripheral it never claimed and
  // calls abort() - a SW_CPU_RESET, not an error return. So checking the return
  // code cannot save you: the abort happens *inside* the call. The only defence is
  // to allocate the driver while the heap is still full.
  // Decoded backtrace of that crash, for the record:
  //   abort <- adc_apb_periph_free <- adc_continuous_deinit
  //         <- adc_continuous_new_handle <- micRecord
  adc_continuous_handle_t adc = NULL;
  adc_continuous_handle_cfg_t hcfg = {};
  // Modest buffers, for the same reason: 4096 store / 512 frame is still ~64ms of
  // slack at 32kHz, far more than the ~2ms the on-screen meter costs per update.
  hcfg.max_store_buf_size = 4096;
  hcfg.conv_frame_size = 512; // must be a multiple of SOC_ADC_DIGI_RESULT_BYTES
  if (adc_continuous_new_handle(&hcfg, &adc) != ESP_OK) {
    Serial.printf("AUDIO error: adc_continuous_new_handle failed (%u free)\n",
                  (unsigned) ESP.getFreeHeap());
    return;
  }

  // One mu-law byte per sample, centred on the measured DC bias and with NO
  // digital gain: the Mac needs to see what the ADC actually saw so it can
  // measure true SNR. Scaling for audibility happens host-side, after measuring.
  // BLE leaves a fair bit less heap than the link-time figure suggests, so take
  // the longest window that actually fits instead of assuming 5s is available.
  int secs = MIC_REC_SECONDS;
  uint8_t* pcm = NULL;
  while (secs >= MIC_REC_MIN_SECONDS) {
    pcm = (uint8_t*) malloc((size_t) MIC_REC_RATE_OUT * secs);
    if (pcm) break;
    secs--;
  }
  if (!pcm) {
    Serial.printf("AUDIO error: out of heap (%u free)\n", (unsigned) ESP.getFreeHeap());
    adc_continuous_deinit(adc);
    return;
  }
  const size_t nOut = (size_t) MIC_REC_RATE_OUT * secs;
  if (secs != MIC_REC_SECONDS)
    Serial.printf("AUDIO note: only %ds fits in heap (%u free)\n", secs, (unsigned) ESP.getFreeHeap());
  adc_digi_pattern_config_t pat = {};
  pat.atten = ADC_ATTEN_DB_12;      // same ~0-3.1V range the level tests use
  pat.channel = ADC_CHANNEL_7;      // IO35 is ADC1_CH7
  pat.unit = ADC_UNIT_1;            // ADC2 has no DMA and dies with BT anyway
  pat.bit_width = 12;
  adc_continuous_config_t ccfg = {};
  ccfg.pattern_num = 1;
  ccfg.adc_pattern = &pat;
  ccfg.sample_freq_hz = MIC_REC_RATE_OUT * MIC_REC_OVERSAMPLE;
  ccfg.conv_mode = ADC_CONV_SINGLE_UNIT_1;
  ccfg.format = ADC_DIGI_OUTPUT_FORMAT_TYPE1;
  if (adc_continuous_config(adc, &ccfg) != ESP_OK) {
    Serial.println("AUDIO error: adc_continuous_config failed");
    adc_continuous_deinit(adc);
    free(pcm);
    return;
  }

  // NOTE: BLE deliberately stays connected. Its ~30ms connection interval does
  // modulate the shared 3.3V rail and put a 33.3Hz harmonic comb across the
  // speech band, but dropping the link during a capture would make the device
  // stop being a display while it records. That interference is strictly
  // periodic, which is exactly what makes it removable in software - see the
  // synchronous-median subtraction in host/mic-wav.mjs.

  // Cue, then mute the amp before recording so it can't hiss into the capture.
  digitalWrite(AUDIO_EN_PIN, LOW);
  ledcWrite(AUDIO_OUT_PIN, MIC_CUE_DUTY);
  delay(140);
  ledcWrite(AUDIO_OUT_PIN, 0);
  digitalWrite(AUDIO_EN_PIN, HIGH);
  delay(250);
  micPillFrame("LISTENING");
  Serial.printf("AUDIO recording up to %ds at %dHz - SPEAK NOW\n", secs, MIC_REC_RATE_OUT);

  adc_continuous_start(adc);
  uint8_t frame[512]; // matches conv_frame_size
  size_t got = 0;
  uint32_t acc = 0;
  int accN = 0;
  int mn = 32767, mx = -32768;
  // mu-law is non-linear, so the DC bias has to come off BEFORE encoding - there
  // is no re-centring it afterwards the way linear PCM allowed. Measured up
  // front over the first frames rather than assuming mid-scale, since the real
  // bias sits around 1893, not 2048.
  int dc = 0;
  {
    long s = 0;
    int c = 0;
    unsigned long t0 = millis();
    while (millis() - t0 < 200) {
      uint32_t len = 0;
      if (adc_continuous_read(adc, frame, sizeof(frame), &len, 100) != ESP_OK) continue;
      for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= len; i += SOC_ADC_DIGI_RESULT_BYTES) {
        s += ((adc_digi_output_data_t*) &frame[i])->type1.data;
        c++;
      }
    }
    dc = c ? (int) (s / c) : 2048;
  }

  // The user decides how long to talk: recording runs until they tap again, or
  // until the buffer is full (that cap is heap-bound - see MIC_REC_SECONDS).
  // A fixed length is the wrong default for dictation; "stop when I'm done" is.
  unsigned long deadline = millis() + (unsigned long) secs * 1000UL + 3000UL;
  unsigned long recStart = millis(), lastUi = 0, lastStopPoll = 0;
  const unsigned long STOP_POLL_MS = 10;   // see micStream: poll != repaint
  int lvlMin = 32767, lvlMax = -32768;
  int stopVotes = 0;
  bool stoppedByUser = false;
  while (got < nOut && millis() < deadline) {
    uint32_t len = 0;
    if (adc_continuous_read(adc, frame, sizeof(frame), &len, 200) != ESP_OK) continue;
    // Meter + stop check between DMA reads, never inside the sample loop: the
    // hardware keeps filling buffers while we draw (8KB of slack ~ 128ms), so this
    // costs no audio.
    // Stop check on its own cadence, and now with the same two-vote debounce the
    // streaming path uses - a single read here could be ended by the same panel
    // false positive.  400ms grace so the finger lifting off the START tap
    // cannot stop it instantly.
    if (millis() - lastStopPoll >= STOP_POLL_MS) {
      lastStopPoll = millis();
      // See the identical call in micStream() - same reasoning, smaller
      // window (this path is heap-capped to a few seconds rather than 120s),
      // added anyway since it costs nothing and shares the exact pattern.
      // true: same reason as micStream()'s call - this is a blocking path.
      reapBleLinks(true);
      if (millis() - recStart > 400 && touchPressed()) {
        if (++stopVotes >= 2) { stoppedByUser = true; break; }
      } else {
        stopVotes = 0;
      }
    }
    if (millis() - lastUi >= 120) {
      lastUi = millis();
      int pp = (lvlMax > lvlMin) ? lvlMax - lvlMin : 0;
      lvlMin = 32767; lvlMax = -32768;
      char t[16];
      unsigned long el = millis() - recStart;
      snprintf(t, sizeof(t), "%lu.%lus / %ds", el / 1000, (el % 1000) / 100, secs);
      micPillMeter(pp * 1000 / 600, t, "TAP ANYWHERE TO STOP");
#if !BOARD_USES_TFT_ESPI
      // Same reason as micStream()'s flush: this loop is heap-capped to a
      // few seconds rather than 120s, but it still never returns to loop()
      // while recording, so nothing else will ever push this meter update.
      tft.flush();
#endif
    }
    for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= len && got < nOut;
         i += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t* p = (adc_digi_output_data_t*) &frame[i];
      acc += p->type1.data;
      if (++accN == MIC_REC_OVERSAMPLE) {
        int v = (int) (acc / MIC_REC_OVERSAMPLE) - dc;
        if (v < lvlMin) lvlMin = v;
        if (v > lvlMax) lvlMax = v;
        // x8 into mu-law's 16-bit input range: this signal peaks around 150 ADC
        // counts, so scaling up keeps it well clear of mu-law's coarsest steps
        // while staying far from the +-32635 clip point.
        pcm[got++] = muLawEncode((int32_t) v * 8);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        acc = 0;
        accN = 0;
      }
    }
  }
  adc_continuous_stop(adc);
  adc_continuous_deinit(adc); // MUST release it: analogRead (battery) needs ADC1 back

  if (got == 0) {
    Serial.println("AUDIO error: no samples captured");
    free(pcm);
    return;
  }

  Serial.printf("AUDIO stopped by %s after %.1fs\n", stoppedByUser ? "tap" : "buffer full",
                (millis() - recStart) / 1000.0);
  Serial.printf("AUDIO begin rate=%d bits=8 codec=%s scale=8 samples=%u dc=%d min=%d max=%d\n",
                MIC_REC_RATE_OUT, MIC_REC_CODEC, (unsigned) got, dc, mn, mx);
  micPillFrame("SENDING");
  micDumpBase64(pcm, got);
  Serial.println("AUDIO end");
  free(pcm);
  micWaitRelease();
  // Same hand-off as the streaming path: the transfer is finished, the Mac's work is
  // not. The one-shot path gets the identical bar so the two behave the same - "I
  // finished recording and nothing happened" should not depend on which capture path
  // happened to be used.
  micProcessingBegin();
}
// Live level meter for tuning the gain trimmer, because doing it through
// one-shot tests means a full round trip per quarter-turn - and the setting we
// actually want (highest gain whose floor stays low) can only be found by
// watching the floor WHILE turning the screw. Runs on the device's own screen
// since that's where your hands already are. Tap to exit; times out on its own.
void micMonitor() {
  analogReadResolution(12);
  analogSetPinAttenuation(MIC_ADC_PIN, ADC_11db);

  tft.fillScreen(COLOR_BG);
  setUIFont(2);
  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(COLOR_ACCENT, COLOR_BG);
  tft.drawString("MIC LEVEL", 12, 10);
  setUIFont(1);
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString("turn the trimmer - keep the bar low", 12, 34);
  tft.drawString("QUIET is good. tap screen to exit", 12, 48);

  // The tap that STARTED this - from SETTINGS > MIC TEST - is usually still down,
  // and the loop below exits on a touch, so without this it would return instantly.
  // Harmless on the MICMON command path: nothing is touching, so it returns at once.
  micWaitRelease();

  const int BAR_X = 12, BAR_W = 216, BAR_Y = 150, BAR_H = 34;
  const int FULL = 1200; // pp mapped to the full bar
  int peak = 0;
  int touchRuns = 0;     // this panel throws false positives; see the exit below
  unsigned long start = millis(), lastPeakDrop = millis();
  char last[16] = "";

  while (millis() - start < 180000UL) {
    // Up to 180s blocking loopTask, entirely outside drainBleRx() - see
    // reapBleLinks()'s own comment for why this matters and why it's safe
    // to call from here (this loop runs on loopTask, same as drainBleRx()).
    // true: this loop is exactly the thing the loop() watchdog can't reach.
    reapBleLinks(true);
    int pp = micWindowPP(80);
    if (pp > peak) peak = pp;
    // Bleed the peak-hold down so it follows you back after a loud moment.
    if (millis() - lastPeakDrop > 400) { peak = peak * 4 / 5; lastPeakDrop = millis(); }

    uint16_t c = pp < 120 ? COLOR_GOOD : (pp < 400 ? COLOR_WARN : COLOR_BAD);
    int w = pp >= FULL ? BAR_W : pp * BAR_W / FULL;
    int pw = peak >= FULL ? BAR_W : peak * BAR_W / FULL;

    tft.fillRect(BAR_X, BAR_Y, w, BAR_H, c);
    tft.fillRect(BAR_X + w, BAR_Y, BAR_W - w, BAR_H, COLOR_CARD);
    if (pw > w) tft.fillRect(BAR_X + pw, BAR_Y, 2, BAR_H, COLOR_VALUE); // peak hold
    tft.drawRect(BAR_X - 1, BAR_Y - 1, BAR_W + 2, BAR_H + 2, COLOR_LABEL);

    // Numeric readout, redrawn only when it changes (flicker-free discipline).
    char now[16];
    snprintf(now, sizeof(now), "%4d  ", pp);
    if (strcmp(now, last) != 0) {
      setUIFont(4);
      tft.setTextColor(c, COLOR_BG);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(now, 12, 96);
      strncpy(last, now, sizeof(last));
    }
    // A quiet floor is the whole goal, so name the target explicitly.
    setUIFont(1);
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    tft.drawString("target: under 120 when silent", 12, BAR_Y + BAR_H + 10);

#if !BOARD_USES_TFT_ESPI
    // Up to 180s blocking, entirely outside loop() - without this the bar
    // and readout drawn above would never leave the shadow framebuffer, and
    // the one thing this screen exists for (watching the floor WHILE turning
    // the trimmer) would show a frozen first frame instead.
    tft.flush();
#endif

    // TWO consecutive reads to exit - the same false-positive this panel produced
    // when a single read ended a 99s recording that nobody had touched. Being
    // kicked out mid-adjustment is the whole thing you are trying to avoid here.
    touchRuns = touchPressed() ? touchRuns + 1 : 0;
    if (touchRuns >= 2) break;
    delay(10);
  }

  micWaitRelease();
  micRestoreUi();
  Serial.println("MIC monitor exited");
}
void micLevelTest() {
  analogReadResolution(12);
  analogSetPinAttenuation(MIC_ADC_PIN, ADC_11db);

  // How much of the noise floor is ELECTRICAL rather than sound? The backlight
  // is a 5kHz LEDC PWM on IO21 sharing the 3.3V rail the mic amp runs from, and
  // it's the loudest switching source on the board. If the floor collapses with
  // it off, the fix is supply filtering, not the gain trimmer - and turning the
  // gain down (the obvious move when something clips) would actually make the
  // signal-to-noise WORSE, because this pickup doesn't scale with mic gain.
  int litPP = micWindowPP(200);
  ledcWrite(TFT_BL_PIN, 0);
  delay(80);
  int darkPP = micWindowPP(200);
  ledcWrite(TFT_BL_PIN, brightnessPct * 255 / 100); // restore the user's setting
  int ppR, pp4, pp16;
  micFloorProfile(400, &ppR, &pp4, &pp16);
  Serial.printf("MIC floor: bl-on=%d bl-off=%d | raw=%d avg4=%d avg16=%d\n",
                litPP, darkPP, ppR, pp4, pp16);

  // Cue the start out loud. Without it you're guessing when the 4s window
  // opens - the host's command file is polled, so it lands up to a second
  // after you hit enter, and several test runs recorded nothing but room tone
  // simply because the talking happened too late. Beeps regardless of the
  // SOUND setting: here the cue IS the test, not a notification.
  digitalWrite(AUDIO_EN_PIN, LOW);      // un-mute the amp
  ledcWrite(AUDIO_OUT_PIN, MIC_CUE_DUTY);
  delay(140);
  ledcWrite(AUDIO_OUT_PIN, 0);
  digitalWrite(AUDIO_EN_PIN, HIGH);     // mute again BEFORE sampling, or the
  delay(350);                           // amp hisses straight into the mic
  Serial.printf("MIC test: %d ms @ %d Hz on IO%d - SPEAK NOW\n",
                MIC_TEST_MS, MIC_TEST_HZ, MIC_ADC_PIN);

  const uint32_t period = 1000000UL / MIC_TEST_HZ;
  const int windows = MIC_TEST_MS / MIC_WIN_MS;
  int winPP[MIC_TEST_MS / MIC_WIN_MS];
  uint32_t n = 0, clipped = 0;
  int mn = 4095, mx = 0;
  double sum = 0;
  String pps = "";

  for (int w = 0; w < windows; w++) {
    int wmn = 4095, wmx = 0;
    unsigned long t0 = micros(), next = t0;
    while (micros() - t0 < (unsigned long) MIC_WIN_MS * 1000UL) {
      while ((long) (micros() - next) < 0) {} // pace to the target rate
      next += period;
      int v = analogRead(MIC_ADC_PIN);
      if (v <= 0 || v >= 4095) clipped++;
      if (v < wmn) wmn = v;
      if (v > wmx) wmx = v;
      sum += v;
      n++;
    }
    if (wmn < mn) mn = wmn;
    if (wmx > mx) mx = wmx;
    winPP[w] = wmx - wmn;
    pps += String(winPP[w]);
    pps += ' ';
    // Hand the CPU back between windows. Spinning for the whole 4s would starve
    // this core's IDLE task and trip the task watchdog - the same failure mode
    // the BLE-callback rule exists to avoid.
    delay(1);
    // Once per ~200ms window (10s / MIC_WIN_MS windows total) rather than per
    // sample - the per-sample loop above paces to microsecond timing and must
    // stay untouched. See reapBleLinks()'s own comment; safe here for the same
    // reason it's safe in the loops above - this runs on loopTask throughout.
    // true: a blocking path, same as the other mic loops.
    reapBleLinks(true);
  }

  int dc = n ? (int) (sum / n) : 0;
  // The quietest window is the noise floor; the loudest is whatever the room
  // (or you) put in. Their RATIO is what separates signal from noise, and it's
  // the whole point of measuring per-window instead of over the run: constant
  // hum fills every window equally (~1.1x), while speech is bursty (3x+).
  // Judging by overall peak-to-peak alone can't tell those apart, and reported
  // "reacted to sound" for runs that were pure room tone.
  int floorPP = 4095, peakPP = 0;
  for (int w = 0; w < windows; w++) {
    if (winPP[w] < floorPP) floorPP = winPP[w];
    if (winPP[w] > peakPP) peakPP = winPP[w];
  }
  int ratioX10 = floorPP > 0 ? (peakPP * 10) / floorPP : 0;
  // Speech is SUSTAINED - "hello hello" lights several consecutive 200ms
  // windows. A single elevated window is a knock, a click, or the module being
  // nudged. Requiring 3 stops one transient from reading as a voice, which the
  // bare peak/floor ratio did on a run where nobody spoke at all.
  int elevated = 0;
  for (int w = 0; w < windows; w++) if (winPP[w] > floorPP + floorPP / 2) elevated++;

  Serial.printf("MIC pp/window: %s\n", pps.c_str());
  Serial.printf("MIC done n=%lu dc=%d (%d mV) min=%d max=%d floor=%d peak=%d ratio=%d.%dx loud=%d/%d clipped=%lu\n",
                (unsigned long) n, dc, (int) analogReadMilliVolts(MIC_ADC_PIN),
                mn, mx, floorPP, peakPP, ratioX10 / 10, ratioX10 % 10,
                elevated, windows, (unsigned long) clipped);
  if (dc < 200)
    Serial.println("MIC verdict: pinned near 0 - OUT not connected, or the module has no power");
  else if (dc > 3900)
    Serial.println("MIC verdict: pinned high - OUT may be on 3.3V; check the connector order");
  else if (peakPP < 20)
    Serial.println("MIC verdict: biased correctly but dead quiet - turn the gain trimmer up");
  else if (clipped > n / 200)
    Serial.printf("MIC verdict: HEARD YOU, but clipping (%lu samples at the rails) - turn the gain down\n",
                  (unsigned long) clipped);
  else if (elevated >= 3 && ratioX10 >= 20)
    Serial.printf("MIC verdict: HEARD YOU - %d of %d windows well above the floor (sustained sound)\n",
                  elevated, windows);
  else if (elevated >= 1)
    Serial.printf("MIC verdict: ONE transient only (%d window) - a knock or a nudge, not a voice\n",
                  elevated);
  else
    Serial.println("MIC verdict: noise floor only (flat) - nothing heard");
}
#elif BOARD_HAS_MIC
// ---------- BOARD 2: capture through the ES8311 ----------
// THREE cases share these four signatures, not two: board 1's ADC-DMA above, this
// codec path, and the no-mic stubs below for a board that genuinely has neither.
// Splitting on BOARD_USES_TFT_ESPI rather than a capture-kind flag is the same
// question asked once - board 1 has MIC_ADC_PIN and an analog amp, board 2 has an
// ES8311 - and it is the split startBeep()/updateBeep() already use.
//
// NOTHING HERE BRINGS UP I2S. audioOutBegin() already did, and it enabled the RX
// channel as a side effect worth knowing about: I2SClass::begin() creates both
// channels when setPins() was given both dout and din, which this board's was
// (GPIO15 and GPIO16). So capture is readBytes() on a channel that has been live
// since boot, and a second begin() would FAIL rather than help.
void micStream()    { Serial.println("AUDIO: board 2 streaming capture not implemented yet"); }
void micRecord()    { Serial.println("AUDIO: board 2 one-shot capture not implemented yet"); }
void micMonitor()   { Serial.println("MIC: board 2 live meter not implemented yet"); }
void micLevelTest() { Serial.println("MIC: board 2 level probe not implemented yet"); }

#else
// ---------- No microphone on this board ----------
// One line each, on the serial link the operator is already reading, because the
// alternative failure is silence: tap the record slot, watch nothing happen, and
// nothing distinguishes "no mic" from "the capture broke". micRestoreUi() is
// deliberately NOT called - none of these ever painted anything, so there is
// nothing to restore and a repaint would flash the tab for no reason.
void micStream()    { Serial.println("AUDIO: no microphone on this board"); }
void micRecord()    { Serial.println("AUDIO: no microphone on this board"); }
void micMonitor()   { Serial.println("MIC: no microphone on this board"); }
void micLevelTest() { Serial.println("MIC: no microphone on this board"); }
#endif  // BOARD_HAS_MIC - the three capture paths

// ---------------------------------------------------------------------------
// TONETEST: board 2's output path, end to end, as ONE experiment
// ---------------------------------------------------------------------------
// Board 2 has never made a sound, and until now that proved nothing: three
// separate things could each account for it on their own - BOARD_HAS_BEEPER is 0,
// the ES8311 was never configured, and PIN_AMP_EN was never driven. AUDIOPROBE
// removed the hardware from suspicion (codec@0x18 ACKs). This removes the
// firmware from it, by actually driving the chain: I2S clocks -> ES8311 DAC ->
// amplifier -> speaker.
//
// THE ONE THING IT CANNOT REASON ITS WAY TO IS THE AMP-ENABLE POLARITY. The pin
// currently reads HIGH, and that number is worthless: nothing has ever
// configured GPIO1 as an output, so HIGH is a pull-up or a float and says
// nothing about what the part wants. Board 1's amp is muted-when-high (10K
// pull-up, driven low to play) but this is a different part on a different
// board, so board 1's answer does not transfer. Both levels are therefore TRIED,
// in one run, each announced before it plays - the operator's ear is the
// instrument and the serial log is the label on it.
//
// The two trials sound DELIBERATELY DIFFERENT - trial A is one long tone, trial
// B is two short beeps - because the operator may well be listening to the
// speaker rather than watching a serial log, and "I heard two short beeps" is an
// answer they can give without having read anything. A pair of identical tones
// would need the log to disambiguate, which puts the burden in the wrong place.
//
// Deliberately NOT wired into the beeper: BOARD_HAS_BEEPER stays 0 and nothing
// in the needs-input path calls this. It is a diagnostic that proves the output
// path exists; turning that into a beeper is later work with its own concerns
// (latency, a persistent I2S channel, the volume setting).
#if !BOARD_USES_TFT_ESPI

// 16 kHz because it is what every later voice feature on this board will use
// (Whisper's training rate - see the board-1 mic notes), so the clock numbers
// proved here are the ones that get reused rather than a convenient one-off.
#define TONE_SAMPLE_HZ   16000
// TONE_FRAMES must hold a whole number of periods of every tone frequency used,
// so the loop can repeat the buffer with no phase discontinuity - a click at
// every buffer boundary is exactly the artefact that would make a working path
// sound broken. 320 frames is 20ms, which is 20 cycles of 1 kHz and 8 of 400 Hz.
#define TONE_FRAMES       320
// About -4 dBFS. This was 6000 (-15 dBFS) at volume 60, which with the codec's
// own -19 dB put the tone ~34 dB below full scale - a defensible choice for
// "nobody knows the amp's gain yet" that turned out to be the wrong risk to
// hedge. The failure this test exists to distinguish is SILENCE, and a quiet
// tone and a dead path are the same observation. Loud is the diagnostic.
#define TONE_AMPLITUDE    20000
// ES8311 volume register, 0..100 - the DEFAULT only; `TONETEST <0-100>` overrides
// it at runtime. This was 90 on the argument that loud is the diagnostic, since a
// quiet tone and a dead path are the same observation. That argument is sound for
// a FIRST run and wrong as a standing default: this command gets run in a house
// with people asleep in it, and a diagnostic nobody dares trigger is worse than a
// quiet one. The epistemics moved into the log instead of the amplitude - every
// run prints the volume it used and says outright that silence at a low volume
// proves nothing. 30 is audible in a quiet room at arm's length.
#define TONE_VOLUME       30
// THE VOLUME SCALE IS LINEAR IN dB, WHICH MAKES IT USELESS TO GUESS ON. The
// ES8311's register 0x32 is 0.5dB per LSB with 0xBF = 0dB, and
// es8311_voice_volume_set maps 0..100 onto the full 0..255 range - so volume 15
// is register 0x26, about -77dB, i.e. ~97dB below the volume-90 tone that was
// plainly audible. Two runs were spent discovering that by ear. TONELADDER
// exists so the audible floor is found in ONE run instead: a single pitch at
// rising volumes, and the listener reports the first step they hear.
//
// The steps are 10 apart, which is 25.6 register counts or ~12.8dB - coarse
// enough that a step is unmistakably louder than the one before rather than
// arguably so, which is what "the first one I heard" has to mean to be usable.
#define TONE_LADDER_STEPS  5
#define TONE_LADDER_FIRST 35
#define TONE_LADDER_GAP   10
// Shorter than TONE_BURST_MS because the amp's turn-on ramp is paid ONCE, before
// the first step - the amp stays enabled across the whole ladder, so no later
// step is at risk of landing inside it.
#define TONE_LADDER_MS   1200

// Guard rails for the runtime argument. 100 is the codec's own maximum, and the
// floor is 1 rather than 0 because `TONETEST 0` would configure the whole chain
// correctly and then play nothing, which is indistinguishable from the fault this
// command exists to detect.
#define TONE_VOLUME_MIN    1
#define TONE_VOLUME_MAX  100

// THE AMP'S TURN-ON RAMP IS THE REASON THE FIRST RUN OF THIS TEST PROVED
// NOTHING. U6 is an SC8002B, an LM4871-class part, and its BYPASS pin carries
// C41 = 1uF: coming out of shutdown, that node has to charge to VDD/2 through
// the internal divider before the output is anything but a ramp. That is
// hundreds of milliseconds, not tens. The first version settled 30ms and then
// played 200ms beeps on the LOW trial, so the entire measurement could have
// happened inside the ramp. Both numbers below are set from that, and the tone
// is one continuous burst rather than beeps for the same reason.
#define TONE_SETTLE_MS     400
#define TONE_BURST_MS     2000

// The two trials are told apart by PITCH, not by pattern or by the log. Whoever
// is listening should not have to watch a serial console to know which polarity
// they just heard, and "one long tone versus two short ones" stopped being
// available the moment both trials had to be long. Both divide 16 kHz exactly
// and both fit a whole number of cycles in TONE_FRAMES (20 and 8), so the
// buffer still loops without a click at the seam.
#define TONE_HZ_LOW_TRIAL  1000
#define TONE_HZ_HIGH_TRIAL  400

// MCLK IS ESTABLISHED FROM THE ARDUINO CORE'S OWN SOURCE, NOT ASSUMED, and the
// codec has to be told the same number or es8311_sample_frequency_config()
// cannot find a divider set and returns ESP_ERR_INVALID_ARG - a classic silent
// failure, because every register write around it succeeds.
// Where the 256 comes from: ESP_I2S.cpp (core 3.3.11) #undefs the IDF's
// I2S_STD_CLK_DEFAULT_CONFIG for SOC_I2S_HW_VERSION_2 - which the S3 is - and
// redefines it with `.mclk_multiple = I2S_MCLK_MULTIPLE_256` hardcoded, and
// I2SClass::begin() offers no way to override it. i2s_types.h documents that
// enum as literally "MCLK = sample_rate * 256". So 16000 * 256 = 4096000, which
// IS a row in the driver's coeff_div[] table ({4096000, 16000, ...}).
// A SUBTLETY WORTH KEEPING: the PLL cannot necessarily hit 4.096 MHz exactly,
// and it does not need to. The codec is a SLAVE - it derives its internal rates
// from the RATIO of the clocks it is handed, and that ratio is exactly 256 by
// construction whatever the PLL rounds to. So this number is right even if a
// scope reads 4.0959 MHz.
#define TONE_MCLK_HZ     (TONE_SAMPLE_HZ * 256)

// Bytes in one buffer half: TONE_FRAMES stereo frames of int16.
#define TONE_HALF_BYTES  ((size_t) TONE_FRAMES * 2 * sizeof(int16_t))

// The codec's register file, read back over the bus we just configured it on.
// THIS IS THE INSTRUMENT THAT SEPARATES "a register is wrong" FROM "the bus is
// dead", so it has to be the one measurement in here that cannot itself fail
// quietly - which is exactly why it does not call the driver's own
// es8311_register_dump(). That one prints with newlib printf(), and on this board
// stdio goes to UART0's GPIO43/44 pads: the sdkconfig sets
// CONFIG_ESP_CONSOLE_UART_DEFAULT and lists USB Serial/JTAG only as the
// SECONDARY console, which catches ets_printf/ESP_LOG and not stdio. The Mac
// reads the USB CDC, so every line of it would land nowhere and a perfectly
// healthy codec would read as a dead bus. It also wraps each read in
// ESP_ERROR_CHECK(), which abort()s on the single failure a dump exists to
// report. Serial.printf() is the only output on this board that is known to
// arrive, so the dump is rewritten around it.
//
// Reads go through the same legacy i2c_master_write_read_device() the driver
// uses, on the port touch already installed - no second master, which is the
// conflict this board aborts on. A failed read prints "--": all dashes is a dead
// bus, one dash is one bad register, and the difference is the whole point.
static void toneDumpCodecRegs() {
  for (int base = 0; base < 0x4A; base += 8) {
    char line[64];
    int n = snprintf(line, sizeof(line), "TONETEST reg %02X:", base);
    for (int r = base; r < base + 8 && r < 0x4A; r++) {
      uint8_t reg = (uint8_t) r, val = 0;
      const bool ok = i2c_master_write_read_device(I2C_NUM_0, ES8311_ADDRESS_0,
                                                  &reg, 1, &val, 1,
                                                  pdMS_TO_TICKS(100)) == ESP_OK;
      n += snprintf(line + n, sizeof(line) - n, ok ? " %02X" : " --", val);
    }
    Serial.println(line);
  }
}

// ---------------------------------------------------------------------------
// THE SHARED OUTPUT PATH. One I2S channel and one codec handle, brought up once
// in setup() and never torn down, because three callers need them and each one
// paying its own ~74-register init is the wrong shape: the beeper fires on every
// asking transition (I2C traffic per beep, and tens of ms of it), TONETEST runs
// on demand, and the capture path in the voice spec needs the SAME I2S channel -
// the ES8311 does record and play over one peripheral in STD mode.
//
// Held permanently rather than reference-counted because there is nothing to
// save: the SC8002B cannot be shut down from a 3.3V GPIO (see the board header),
// so its idle current and noise floor are present whether or not this is up.
// Silence comes from es8311_voice_mute(), which is exactly what the idle state
// here is.
//
// A function-local static, not a file-scope object: this file is concatenated
// into one translation unit with the rest of the sketch, and a global I2SClass
// would run its constructor before setup() in an order nothing here controls -
// the same class of hazard as the legacy-I2C-versus-Wire abort this board has
// already paid for once.
static I2SClass& audioI2s() { static I2SClass inst; return inst; }
static es8311_handle_t audioCodec = NULL;
static bool audioOutReady = false;
// One period of the beep tone, looped. int16 stereo, so 2 samples per frame.
static int16_t beepTone[BEEP_TONE_FRAMES * 2];

// Brought up from setup(). Returns false and LOGS WHY on any failure, leaving
// audioOutReady false so every caller degrades to silence rather than to a
// crash - a status display that boots is worth more than one that insists on a
// beeper. Must run AFTER the I2C bus exists, since the codec shares the port
// touch installed; asserted rather than assumed, because a silent failure here
// would present as "the beep does not work" a long way from its cause.
bool audioOutBegin() {
  if (audioOutReady) return true;

  // I2S FIRST so MCLK is running before the codec computes its dividers off it -
  // the order Espressif's own i2s_es8311 example uses.
  I2SClass& i2s = audioI2s();
  i2s.setPins(PIN_I2S_BCLK, PIN_I2S_LRCK, PIN_I2S_DOUT, PIN_I2S_DIN, PIN_I2S_MCLK);
  if (!i2s.begin(I2S_MODE_STD, TONE_SAMPLE_HZ, I2S_DATA_BIT_WIDTH_16BIT,
                 I2S_SLOT_MODE_STEREO)) {
    Serial.printf("AUDIO OUT: I2SClass::begin() failed - bclk=%d lrck=%d dout=%d "
                  "din=%d mclk=%d. No beeper this boot.\n", PIN_I2S_BCLK,
                  PIN_I2S_LRCK, PIN_I2S_DOUT, PIN_I2S_DIN, PIN_I2S_MCLK);
    return false;
  }

  audioCodec = es8311_create(I2C_NUM_0, ES8311_ADDRESS_0);
  if (audioCodec == NULL) {
    Serial.println("AUDIO OUT: es8311_create() returned NULL (out of heap). "
                   "No beeper this boot.");
    i2s.end();
    return false;
  }
  const es8311_clock_config_t clk = {
    .mclk_inverted = false, .sclk_inverted = false,
    .mclk_from_mclk_pin = true, .mclk_frequency = TONE_MCLK_HZ,
    .sample_frequency = TONE_SAMPLE_HZ,
  };
  esp_err_t e = es8311_init(audioCodec, &clk, ES8311_RESOLUTION_16,
                            ES8311_RESOLUTION_16);
  if (e != ESP_OK) {
    Serial.printf("AUDIO OUT: es8311_init() = %s (0x%x). No beeper this boot.\n",
                  esp_err_to_name(e), e);
    es8311_delete(audioCodec);
    audioCodec = NULL;
    i2s.end();
    return false;
  }
  es8311_sample_frequency_config(audioCodec, TONE_MCLK_HZ, TONE_SAMPLE_HZ);
  es8311_voice_mute(audioCodec, true);   // the idle state IS muted

#if BOARD_HAS_MIC
  // CAPTURE, configured here because es8311_init() already set up both directions
  // and these two calls only select WHICH input and how much gain. digital_mic is
  // false and that is a schematic reading rather than a default: the capsule is
  // analog into MIC1P/MIC1N with no clock line - see the note in the board header.
  // Both return codes are reported, because a mic that was never configured
  // records digital silence, which is indistinguishable from a dead capsule.
  const esp_err_t me = es8311_microphone_config(audioCodec, false);
  const esp_err_t ge = es8311_microphone_gain_set(audioCodec, MIC_GAIN);
  Serial.printf("AUDIO IN: analog mic configured (%s), gain set (%s).\n",
                esp_err_to_name(me), esp_err_to_name(ge));
#endif

  // sinf rather than a square wave: a square's harmonics run past the codec's
  // reconstruction filter, and its ringing would be part of every beep.
  for (int i = 0; i < BEEP_TONE_FRAMES; i++) {
    const int16_t v = (int16_t) (TONE_AMPLITUDE *
                                 sinf(2.0f * PI * BEEP_TONE_HZ * i / TONE_SAMPLE_HZ));
    beepTone[i * 2]     = v;
    beepTone[i * 2 + 1] = v;
  }

  // The amp cannot be gated, so this is set once and left - see the board header.
  pinMode(PIN_AMP_EN, OUTPUT);
  digitalWrite(PIN_AMP_EN, AMP_EN_ENABLE_LEVEL);

  audioOutReady = true;
  Serial.printf("AUDIO OUT: ES8311 up at %d Hz, MCLK %d Hz, beep tone %d Hz "
                "(%d frames = %dms), muted until something plays.\n",
                TONE_SAMPLE_HZ, TONE_MCLK_HZ, BEEP_TONE_HZ, BEEP_TONE_FRAMES,
                BEEP_TONE_FRAMES * 1000 / TONE_SAMPLE_HZ);
  return true;
}

// One 20ms buffer of tone into the DMA. Callers keep their own model of how much
// is queued (see startBeep/updateBeep) because I2SClass offers no way to ask.
static void audioFeedBeepChunk() {
  audioI2s().write((const uint8_t*) beepTone, sizeof(beepTone));
}

// One register, for callers that need to state what a write actually landed.
// Returns -1 on a failed read so the caller can print "??" rather than a zero
// that would read as a real value.
static int toneReadCodecReg(uint8_t reg) {
  uint8_t val = 0;
  if (i2c_master_write_read_device(I2C_NUM_0, ES8311_ADDRESS_0, &reg, 1, &val, 1,
                                   pdMS_TO_TICKS(100)) != ESP_OK) return -1;
  return val;
}

// One burst. `buf` is the two-half allocation from toneTest(): the period table
// then an equal run of zeros.
//
// The trailing silence is not cosmetic. I2SClass::write() returns once the DMA
// has ACCEPTED the bytes, NOT once they have been clocked out, so flipping the
// amp pin straight after the last write would play the tail of trial A under
// trial B's polarity - corrupting the one measurement this whole function exists
// to make. Five zero-buffers (~100ms) push the tone through the DMA, and the
// delay lets the last of it actually leave.
static size_t tonePlayBurst(I2SClass& i2s, const int16_t* buf, int ms) {
  const int16_t* quiet = buf + TONE_FRAMES * 2;
  const int reps = (ms * TONE_SAMPLE_HZ / 1000) / TONE_FRAMES;
  // Accumulated and returned because a write() that accepts FEWER bytes than it
  // was given - or none - is otherwise indistinguishable from a working path
  // feeding a dead speaker, which is the exact ambiguity this run has to end.
  size_t wrote = 0;
  for (int i = 0; i < reps; i++) {
    // Same reason the mic loops, calibration and the SCREENSHOT readback do it:
    // this is a blocking path loop() cannot reach, so nothing else would reap a
    // pending BLE slot for its duration and a refusal would leave the device
    // un-advertised with no log line saying why. Runs on loopTask throughout,
    // which is what makes it safe here as everywhere else. One reap per buffer is
    // ~20ms apart - cheaper than the SCREENSHOT loop's ~56ms.
    // TONETEST blocks for only ~3.6s, so the exposure is small rather than the
    // two minutes micStream() risks - the call is here for CONSISTENCY with a
    // rule this codebase states without exception, not because 3.6s is alarming.
    reapBleLinks(true);
    wrote += i2s.write((const uint8_t*) buf, TONE_HALF_BYTES);
  }
  for (int i = 0; i < 5; i++) i2s.write((const uint8_t*) quiet, TONE_HALF_BYTES);
  delay(80);
  return wrote;
}

void toneTest(int volume, bool ladder) {
  // The command dispatch cannot do this itself - it is compiled BEFORE this file
  // (deckhand_display.ino first, then the rest alphabetically), so none of these
  // constants is in scope there. Negative means "caller had no opinion", which is
  // how a plain TONETEST asks for the default; anything else is clamped into the
  // codec's real range so a typo yields a known loudness rather than silence.
  if (volume < 0) volume = TONE_VOLUME;
  if (volume < TONE_VOLUME_MIN) volume = TONE_VOLUME_MIN;
  if (volume > TONE_VOLUME_MAX) volume = TONE_VOLUME_MAX;
  // In ladder mode the volume argument is meaningless - the ladder sets its own
  // per step - so it is reported as such rather than printed as if it applied.
  if (ladder) volume = TONE_LADDER_FIRST;
  Serial.println("TONETEST ---------------------------------------------------------");
  Serial.printf("TONETEST driving %d Hz then %d Hz at %d Hz/16-bit stereo, MCLK "
                "%d Hz (ESP_I2S hardcodes mclk_multiple=256; see the note in "
                "audio.ino), codec volume %d/100, amplitude %d/32767, %dms settle, "
                "%dms per tone.\n",
                TONE_HZ_LOW_TRIAL, TONE_HZ_HIGH_TRIAL, TONE_SAMPLE_HZ, TONE_MCLK_HZ,
                volume, TONE_AMPLITUDE, TONE_SETTLE_MS, TONE_BURST_MS);

  // USES THE SHARED CONTEXT rather than standing up its own. It used to create a
  // local I2SClass and its own codec handle, which was right when it was the only
  // thing here that made a sound; with audioOutBegin() holding the I2S channel
  // permanently for the beeper, a second begin() on the same port FAILS - so this
  // would have become a diagnostic reporting a fault it caused itself. Every
  // failure path it used to carry now lives in audioOutBegin(), logged once at
  // boot rather than once per run.
  if (!audioOutReady) {
    Serial.println("TONETEST FAILED: the shared audio path never came up - look for "
                   "the AUDIO OUT line from boot, which names the call that failed. "
                   "Nothing was played.");
    return;
  }
  es8311_handle_t codec = audioCodec;
  Serial.println("TONETEST using the shared I2S channel and codec brought up at boot.");

  // Declared here now: the clock/init calls that used to introduce `e` moved into
  // audioOutBegin(), so this is the first error code the function handles.
  int volSet = -1;
  const esp_err_t e = es8311_voice_volume_set(codec, volume, &volSet);
  Serial.printf("TONETEST volume set. volume_set=%d (%s)\n", volSet,
                esp_err_to_name(e));
  // All dashes means nothing read back at all, so the fault is the bus; a
  // plausible spread means the codec took the configuration and anything still
  // wrong is downstream of it. Not the driver's es8311_register_dump() - see
  // toneDumpCodecRegs() above for why that one's output never reaches the Mac.
  toneDumpCodecRegs();

  // Start muted, so the pin flips below happen in silence and each trial's tone
  // begins only after its own announcement has been printed.
  es8311_voice_mute(codec, true);

  // Two halves in ONE allocation: the period table, then an equal run of zeros
  // for tonePlayBurst()'s drain. ON THE HEAP, not `static`, and that is the
  // point - as file-scope statics these two buffers cost 2560 bytes of .bss
  // permanently (measured: board 2's globals went 58684 -> 61276) for a
  // diagnostic that runs for three seconds when a person asks. Heap is the
  // binding constraint on the audio path this is scaffolding for, so a
  // once-a-day command must not hold any.
  int16_t* buf = (int16_t*) calloc(TONE_FRAMES * 2 * 2, sizeof(int16_t));
  if (buf == NULL) {
    Serial.println("TONETEST FAILED: out of heap for the 2560-byte tone buffer. "
                   "Nothing was played.");
    return;   // the codec handle is shared and outlives this call - see above
  }
  // The second half stays as calloc left it: silence. The first half is filled
  // per trial, because each trial now carries its own pitch.

  pinMode(PIN_AMP_EN, OUTPUT);

  // LOW FIRST, because it is the likelier of the two to be the working one and a
  // listener's attention is at its best on the first sound. R26 is a 10K pull-up
  // from VCC3V3 to U6's SHUTDOWN pin, so the board's resting state is whatever
  // HIGH means - and on an LM4871-class part, which the SC8002B is, SHUTDOWN is
  // ACTIVE HIGH. That makes the resting state "shut down" and LOW the enabled
  // one. The demo project's selftest drives it HIGH with the comment "enable the
  // amplifier", which is the opposite; nothing in that project ever verified a
  // sound, so its comment is an assumption and this ordering is a prediction.
  // Both are still tried - the prediction picks the ORDER, never the coverage.
  if (ladder) {
    // ONE pitch, rising volume, amp enabled once. The steps are told apart by
    // COUNT rather than by pitch: they are meant to be compared against each
    // other, and changing two variables at once would make "the third one" mean
    // nothing. Counting five beeps is something a listener can do without
    // watching a log, which is the whole point of the exercise.
    for (int i = 0; i < TONE_FRAMES; i++) {
      const int16_t v = (int16_t) (TONE_AMPLITUDE *
                                   sinf(2.0f * PI * TONE_HZ_LOW_TRIAL * i / TONE_SAMPLE_HZ));
      buf[i * 2]     = v;
      buf[i * 2 + 1] = v;
    }
    digitalWrite(PIN_AMP_EN, AMP_EN_ENABLE_LEVEL);
    es8311_voice_mute(codec, false);
    delay(TONE_SETTLE_MS);            // the ramp, paid once for the whole ladder
    Serial.printf("TONETEST ladder: %d steps of %dms at %d Hz, volume %d then +%d "
                  "each. COUNT THE BEEPS and report the FIRST one you hear.\n",
                  TONE_LADDER_STEPS, TONE_LADDER_MS, TONE_HZ_LOW_TRIAL,
                  TONE_LADDER_FIRST, TONE_LADDER_GAP);
    for (int step = 0; step < TONE_LADDER_STEPS; step++) {
      const int vol = TONE_LADDER_FIRST + step * TONE_LADDER_GAP;
      int volSetBack = -1;
      const esp_err_t ve = es8311_voice_volume_set(codec, vol, &volSetBack);
      // READ REGISTER 0x32 BACK rather than believing the out-parameter. That
      // parameter is NOT the register - es8311.h says "Volume that was set. Same
      // as volume, unless volume is outside of <0, 100>" - and printing it as one
      // put "register 0x4B (~-58.0 dB)" in the log for a step that was actually
      // at register 0xBF, about 0dB. A diagnostic that misreports the quantity it
      // exists to report is worse than one that prints nothing, because the wrong
      // number gets used to pick the next guess. dB stays approximate: 0.5dB/LSB
      // with 0xBF = 0dB is a reading of the datasheet, not a measurement here.
      const int reg = toneReadCodecReg(0x32);
      if (reg < 0) {
        Serial.printf("TONETEST ladder step %d of %d >>> volume %d/100, register "
                      "read FAILED. LISTEN NOW.\n", step + 1, TONE_LADDER_STEPS, vol);
      } else {
        Serial.printf("TONETEST ladder step %d of %d >>> volume %d/100 -> register "
                      "0x%02X (~%+.1f dB)%s. LISTEN NOW.\n",
                      step + 1, TONE_LADDER_STEPS, vol, reg, (reg - 0xBF) * 0.5f,
                      ve == ESP_OK ? "" : "  <<< VOLUME SET FAILED");
      }
      tonePlayBurst(audioI2s(), buf, TONE_LADDER_MS);
      delay(700);                     // a clear gap so the steps stay countable
    }
    es8311_voice_mute(codec, true);
    Serial.printf("TONETEST ladder done. >>> WHICH STEP DID YOU FIRST HEAR? Step N "
                  "means the floor is volume %d + (N-1)*%d. Nothing at all means "
                  "even 0 dB is inaudible, which points at the transducer or the "
                  "JP3 connection rather than at the codec - every register above "
                  "read back correct.\n", TONE_LADDER_FIRST, TONE_LADDER_GAP);
  } else {
  const int levels[2]  = { LOW, HIGH };
  const char* names[2] = { "LOW", "HIGH" };
  const int freqs[2]   = { TONE_HZ_LOW_TRIAL, TONE_HZ_HIGH_TRIAL };
  for (int t = 0; t < 2; t++) {
    // sinf rather than a square wave: a square's harmonics reach past the
    // codec's reconstruction filter, so filter ringing could pass for a tone.
    for (int i = 0; i < TONE_FRAMES; i++) {
      const int16_t v = (int16_t) (TONE_AMPLITUDE *
                                   sinf(2.0f * PI * freqs[t] * i / TONE_SAMPLE_HZ));
      buf[i * 2]     = v;   // left
      buf[i * 2 + 1] = v;   // right
    }
    Serial.printf("TONETEST trial %c of 2 >>> amp enable GPIO%d = %s <<< "
                  "ONE CONTINUOUS %dms TONE AT %d Hz (%s pitch). LISTEN NOW.\n",
                  'A' + t, PIN_AMP_EN, names[t], TONE_BURST_MS, freqs[t],
                  t == 0 ? "the HIGHER" : "the LOWER");
    digitalWrite(PIN_AMP_EN, levels[t]);
    es8311_voice_mute(codec, false);
    delay(TONE_SETTLE_MS);           // the amp's turn-on ramp, not a formality
    const size_t wrote = tonePlayBurst(audioI2s(), buf, TONE_BURST_MS);
    es8311_voice_mute(codec, true);
    // The expected figure is printed beside the actual one so a short write is
    // read off the line rather than worked out from the sample rate.
    const size_t want = (size_t) (TONE_BURST_MS * TONE_SAMPLE_HZ / 1000)
                        / TONE_FRAMES * TONE_HALF_BYTES;
    Serial.printf("TONETEST trial %c done (amp enable was %s). I2S accepted "
                  "%u of %u bytes%s.\n", 'A' + t, names[t], (unsigned) wrote,
                  (unsigned) want,
                  wrote == want ? "" : "  <<< SHORT WRITE - the tone never "
                                       "fully reached the codec");
    if (t == 0) delay(1500);          // an unmistakable gap between the two
  }
  }

  // Teardown. The codec is muted, and i2s's destructor stops the clocks on
  // return. THE QUIET COMES FROM THAT MUTE, not from the pin: this used to
  // restore INPUT on the grounds that it was "the state the board booted in and
  // was silent in", which this test then disproved - both levels are audible, so
  // no level of this pin is quiet and the boot state was only silent because
  // nothing was driving the codec. The pin is left at the level that means
  // enabled, which is what every other caller will want.
  digitalWrite(PIN_AMP_EN, AMP_EN_ENABLE_LEVEL);
  free(buf);
  // NOT es8311_delete(): this function does not own the handle any more, and
  // deleting the shared one would leave the beeper writing through a freed
  // pointer for the rest of the boot. It does owe the VOLUME back, though - this
  // run moved a setting the beeper reads, and leaving TONETEST's loudness behind
  // would silently redefine what the VOLUME stepper's three presets mean.
  applyVolume();
  es8311_voice_mute(codec, true);
  Serial.printf("TONETEST done. Amp enable left DRIVEN %s (the level that means "
                "enabled), codec muted, I2S stopped. The quiet comes from the codec "
                "mute - no level of this pin is silent on this board revision.\n",
                AMP_EN_ENABLE_LEVEL == LOW ? "LOW" : "HIGH");
  // Phrased as the question the listener can actually answer. The trials are
  // told apart by PITCH, so this line must be too - it described "one long tone"
  // versus "two short beeps" for one run after the trials stopped differing that
  // way, which is a diagnostic instructing you to look for the wrong evidence.
  Serial.println("TONETEST >>> WHICH DID YOU HEAR? The HIGHER 1000 Hz tone (first) = "
                 "amp enable is ACTIVE LOW, i.e. LOW enables. The LOWER 400 Hz tone "
                 "(second) = ACTIVE HIGH. Both = the pin gates nothing and the amp is "
                 "always on. Neither = the fault is upstream of the amp; check the "
                 "register dump above.");
  // The default volume is deliberately quiet, so NEITHER is no longer strong
  // evidence on its own - which has to be said here rather than assumed, because
  // this is the line someone reads before concluding the hardware is broken.
  if (volume < 60) {
    Serial.printf("TONETEST note: volume was %d/100, which is QUIET ON PURPOSE. Hearing "
                  "nothing at this level is NOT evidence of a fault - re-run as "
                  "'TONETEST 90' before concluding anything from silence.\n", volume);
  }
  Serial.println("TONETEST ---------------------------------------------------------");
}

#endif  // !BOARD_USES_TFT_ESPI - the codec tone test
// NO BOARD-1 STUB, and its absence is the point. The no-mic stubs above exist
// because micStream()/micRecord() are called from SHARED code (the record slot's
// touch handler) that has no board guard around it, so board 1 needs a definition
// to link against. toneTest() has exactly one caller - the TONETEST command,
// which sits inside deckhand_display.ino's own !BOARD_USES_TFT_ESPI block - so
// board 1 never names it. A stub would be a function plus a string literal added
// to a binary that is held BYTE-IDENTICAL on purpose, and -ffunction-sections
// gc-sections is not a guarantee anyone should be leaning on for that.
