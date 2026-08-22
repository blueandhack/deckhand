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

  int maxW = tft.width() - 2 * CARD_X;
  int y = CONTENT_Y + 22;
  tft.setTextColor(COLOR_LABEL, COLOR_BG);
  tft.drawString("YOU SAID", CARD_X, y);
  y += 12;
  // Cozette on a panel: this is quoted text, and the code style reads as "verbatim".
  int lines = countWrappedLines(voiceText, FONT_CODE, maxW - 14);
  int h = (lines > 6 ? 6 : lines) * 13 + 12;
  uiFillRound(CARD_X - 4, y, maxW + 8, h, R_SM, COLOR_CARD, COLOR_BG);
  drawWrappedText(voiceText, CARD_X + 3, y + 6, FONT_CODE, 13, maxW - 14, 0, 6,
                  COLOR_VALUE, COLOR_CARD);
  y += h + 10;

  if (voiceReply[0]) {
    tft.setTextColor(COLOR_LABEL, COLOR_BG);
    setUIFont(1);
    tft.drawString(bad ? "ERROR" : "CLAUDE", CARD_X, y);
    y += 12;
    int avail = (contentBottom() - 8 - y) / 13;
    if (avail < 1) avail = 1;
    drawWrappedText(voiceReply, CARD_X, y, FONT_CODE, 13, maxW, 0, avail,
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
