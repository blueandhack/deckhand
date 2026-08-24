#!/usr/bin/env node
// Turn a MICREC dump into a playable WAV, and measure what it actually contains.
//
// The device prints its capture to the serial log as base64, so this reads the
// host log rather than needing its own serial connection - opening a second port
// would reset the ESP32 and there's nothing to gain from it.
//
//   node mic-wav.mjs [logfile] [outfile]
import fs from "node:fs";
// PRE-EXISTING BUG, fixed here because this decoder cannot run without it: the
// DECKHAND_TMP paths below use path.join and this import was never added when
// they arrived, so `node mic-wav.mjs` with no explicit outfile - the ordinary
// invocation - died with "path is not defined" before reading a single byte.
import path from "node:path";

// Default to the newest capture file the host wrote, falling back to the host log
// (older builds logged the base64 inline). A capture file is authoritative: the
// host no longer routes AUDIO through the log at all.
function newestCapture() {
  try {
    const dir = `${process.env.HOME}/Deckhand-audio`;
    // Sort by the embedded TIMESTAMP, not the filename: plain sort() puts every
    // stream-* after every capture-* regardless of age, so an old stream would
    // shadow a fresh capture.
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^(capture|stream)-\d+\.txt$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    if (files.length) return `${dir}/${files[files.length - 1]}`;
  } catch {}
  return path.join(process.env.DECKHAND_TMP || `/tmp/deckhand-${process.getuid()}`, "host.log");
}
const logPath = process.argv[2] || newestCapture(); // "" from a caller must fall back too
const outPath = process.argv[3] ??
  path.join(process.env.DECKHAND_TMP || `/tmp/deckhand-${process.getuid()}`, "mic.wav");

const lines = fs.readFileSync(logPath, "utf8").split("\n");
// Only the USB copy: the device prints via Serial, and taking both transports'
// copies would interleave duplicates into the audio.
const usb = (l) => l.replace(/^\[device\/usb\] /, "");

// The log accumulates every capture ever taken, so "the last one" is a trap:
// a stale MICREC left in the command file gets replayed when the host restarts,
// appending silent captures AFTER the one you actually care about. List them all
// and let the caller pick, defaulting to the LOUDEST (largest peak excursion),
// which is almost always the take with speech in it.
const begins = [];
for (let i = 0; i < lines.length; i++) {
  const l = usb(lines[i]);
  if (l.startsWith("AUDIO begin ") || l.startsWith("AUDIO stream ")) {
    const g = (k) => { const m = l.match(new RegExp(k + "=(-?\\d+)")); return m ? parseInt(m[1], 10) : 0; };
    begins.push({ i, line: l, swing: Math.abs(g("min")) + Math.abs(g("max")) });
  }
}
if (!begins.length) {
  console.error("No 'AUDIO begin'/'AUDIO stream' header in " + logPath + " - record first.");
  process.exit(1);
}
const want = process.argv[4]; // "last", "loudest" (default), or a 1-based index
let chosen;
if (want === "last") chosen = begins[begins.length - 1];
else if (want && /^\d+$/.test(want)) chosen = begins[parseInt(want, 10) - 1];
else chosen = begins.reduce((a, b2) => (b2.swing > a.swing ? b2 : a));
if (!chosen) {
  console.error(`No such capture; the log has ${begins.length}.`);
  process.exit(1);
}
console.log(`captures in log: ${begins.length}`);
begins.forEach((b2, k) =>
  console.log(`  [${k + 1}]${b2 === chosen ? " *" : "  "} swing=${String(b2.swing).padStart(4)}  ${b2.line.replace("AUDIO begin ", "")}`)
);
const begin = chosen.i;

const header = usb(lines[begin]);
const field = (k, d) => {
  const m = header.match(new RegExp(k + "=(-?\\d+)"));
  return m ? parseInt(m[1], 10) : d;
};
const rate = field("rate", 8000);
const claimed = field("samples", 0);

let b64 = "";
let ended = false;
for (let i = begin + 1; i < lines.length; i++) {
  const l = usb(lines[i]);
  if (l.startsWith("AUDIO d ")) b64 += l.slice(8).trim();
  else if (l.startsWith("AUDIO end")) {
    ended = true;
    break;
  } else if (l.startsWith("AUDIO ")) break;
}

const raw = Buffer.from(b64, "base64");
const bits = field("bits", 16);
const codec = (header.match(/codec=(\w+)/) ?? [, "pcm"])[1];
const scale = field("scale", 1);

// mu-law (G.711): 8 bits with logarithmic steps, so the device can send 16kHz in
// the same bytes 8kHz/16-bit used. Undo it here, then divide out the device-side
// scale so the numbers stay comparable with older linear captures.
function muLawDecode(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0f;
  let s = (((mant << 3) + 0x84) << exp) - 0x84;
  return sign ? -s : s;
}

// IMA ADPCM: 4 bits per sample, mirroring the encoder's predictor exactly - the
// two stay in lockstep with no side information. This is what makes a streamed
// minute fit down a 115200 line (8KB/s vs 16KB/s for mu-law).
const IMA_STEP = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,
  130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,
  876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,
  5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const IMA_INDEX = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
function imaDecode(bytes) {
  const out = new Float64Array(bytes.length * 2);
  let pred = 0, index = 0, o = 0;
  for (let i = 0; i < bytes.length; i++) {
    for (const code of [bytes[i] & 0x0f, bytes[i] >> 4]) {
      const step = IMA_STEP[index];
      let dq = step >> 3;
      if (code & 4) dq += step;
      if (code & 2) dq += step >> 1;
      if (code & 1) dq += step >> 2;
      pred += (code & 8) ? -dq : dq;
      pred = Math.max(-32768, Math.min(32767, pred));
      index = Math.max(0, Math.min(88, index + IMA_INDEX[code]));
      out[o++] = pred;
    }
  }
  return out;
}

let samples;
if (codec === "ima4") {
  samples = imaDecode(raw);
  for (let i = 0; i < samples.length; i++) samples[i] /= scale;
} else if (bits === 8 && codec === "ulaw") {
  samples = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) samples[i] = muLawDecode(raw[i]) / scale;
} else {
  const m = Math.floor(raw.length / 2);
  samples = new Float64Array(m);
  for (let i = 0; i < m; i++) samples[i] = raw.readInt16LE(i * 2);
}
const n = samples.length;
// Kept so the measurement code below can stay index-based.
const pcm = { readInt16LE: (off) => samples[off / 2] };
console.log(`header: ${header}`);
console.log(`decoded ${n} samples (expected ${claimed})${ended ? "" : "  [WARNING: no 'AUDIO end' - dump truncated]"}`);
if (n === 0) process.exit(1);
// A streamed capture reports the sample count the DEVICE encoded; the decoder
// should land on the same number. Gaps are reported by the host at capture time.
if (claimed && n < claimed * 0.98) {
  console.error(
    `\nTRUNCATED: got ${n} of ${claimed} samples (${Math.round((n / claimed) * 100)}%).` +
      `\nDo NOT trust a transcript of this - misaligned mu-law decodes as loud garbage` +
      `\nand Whisper will confidently invent words. Re-record instead.`
  );
  process.exitCode = 2;
}

// ---- measure: RMS of the quietest 100ms vs the loudest, i.e. noise vs signal ----
const win = Math.max(1, Math.floor(rate / 10));
let quiet = Infinity, loud = 0, peak = 0;
for (let w = 0; w + win <= n; w += win) {
  let sum = 0;
  for (let i = w; i < w + win; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  const rms = Math.sqrt(sum / win);
  if (rms < quiet) quiet = rms;
  if (rms > loud) loud = rms;
}
const snrDb = quiet > 0 ? 20 * Math.log10(loud / quiet) : 0;
console.log(`quietest 100ms RMS: ${quiet.toFixed(1)}   loudest: ${loud.toFixed(1)}   peak: ${peak}`);
console.log(`=> signal-to-noise: ${snrDb.toFixed(1)} dB   (speech needs ~15-20dB to transcribe well)`);

// ---- de-rumble: the noise and the voice are in different bands ----
// Measured on a real capture: the noise floor is dominated by a ~70Hz rumble
// (0-100Hz band ~35k, single bin 85k) while the speech lives at 200-1200Hz with
// +10 to +12dB of headroom over the noise there. Above 2kHz this mic contributes
// nothing. So a band-pass keeps every part of the signal that carries voice and
// throws away the part that's almost pure noise.
//
// Two cascaded high-passes, not one: 70Hz is only ~1.4 octaves below the 180Hz
// corner, and a single 2nd-order section only gets ~16dB down there. Cascading
// doubles that to ~32dB, which is what actually removes the rumble rather than
// merely trimming it.
function biquad(x, b0, b1, b2, a0, a1, a2) {
  const out = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}
function highpass(x, f0, fs, q = 0.707) {
  const w = (2 * Math.PI * f0) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  return biquad(x, (1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
}
function lowpass(x, f0, fs, q = 0.707) {
  const w = (2 * Math.PI * f0) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  return biquad(x, (1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
}

// ---- de-comb: cancel the BLE radio's periodic interference ----
// The dominant "electric noise" is the BLE link, not the mic. macOS negotiates a
// ~30ms connection interval and every transmit burst pulls current on the 3.3V
// rail the mic amp shares, producing a 33.3Hz harmonic comb right across the
// speech band (measured: 66/100/133Hz at +20-30dB over the local floor, and
// ~11x more voice-band tonal energy than with the link dropped).
//
// It is removable precisely BECAUSE it is periodic: it repeats every ~240 samples
// while speech does not. So estimate one period of the interference and subtract
// it everywhere. Notching the harmonics individually would need ~85 notches
// across the voice band; this needs none.
//
// Two details that make it work rather than half-work:
//  - MEDIAN per phase, not mean. A mean is dragged around by whatever speech
//    happens to land on a given phase; the median ignores those outliers and
//    converges on the interference alone.
//  - Processed in ~1s blocks. The ESP32's sample clock and the Mac's BLE clock
//    are independent, so the period drifts a fraction of a sample per second;
//    over a 4s capture that smears a single global template.
// Pick the period by directly minimising what's left after cancellation, rather
// than by autocorrelation. Autocorrelation gets captured by whatever is loudest -
// here the 70Hz rumble - and returned 222 samples when the harmonic spacing
// plainly said 240. Scoring candidates on the residual optimises the thing we
// actually want, so the loudest component can't hijack it.
//
// The (N/(N-P)) term corrects for a P-parameter template always fitting N points
// better as P grows; without it this just chooses the largest period on offer.
function periodResidual(x, from, to, P) {
  const sum = new Float64Array(P);
  const cnt = new Int32Array(P);
  for (let i = from; i < to; i++) { const p = (i - from) % P; sum[p] += x[i]; cnt[p]++; }
  for (let p = 0; p < P; p++) if (cnt[p]) sum[p] /= cnt[p];
  let e = 0;
  for (let i = from; i < to; i++) { const d = x[i] - sum[(i - from) % P]; e += d * d; }
  const N = to - from;
  return (e / N) * (N / (N - P));
}

function estimatePeriod(x, lo, hi) {
  // Estimate on the QUIETEST stretch: speech would otherwise dominate the score.
  const seg = Math.min(x.length, Math.round(rate * 1.5));
  let from = 0, bestE = Infinity;
  for (let s = 0; s + seg <= x.length; s += Math.round(rate / 4)) {
    let e = 0;
    for (let i = s; i < s + seg; i++) e += x[i] * x[i];
    if (e < bestE) { bestE = e; from = s; }
  }
  let best = lo, bestScore = Infinity;
  for (let P = lo; P <= hi; P++) {
    const r = periodResidual(x, from, from + seg, P);
    if (r < bestScore) { bestScore = r; best = P; }
  }
  return best;
}

function removeComb(x, period, blockLen) {
  const out = new Float64Array(x.length);
  for (let b = 0; b < x.length; b += blockLen) {
    const end = Math.min(x.length, b + blockLen);
    const buckets = Array.from({ length: period }, () => []);
    for (let i = b; i < end; i++) buckets[(i - b) % period].push(x[i]);
    const tmpl = buckets.map((v) => {
      if (!v.length) return 0;
      v.sort((p, q) => p - q);
      return v[v.length >> 1];
    });
    for (let i = b; i < end; i++) out[i] = x[i] - tmpl[(i - b) % period];
  }
  return out;
}

let sig = new Float64Array(n);
for (let i = 0; i < n; i++) sig[i] = pcm.readInt16LE(i * 2);

// Search 12.5-62.5ms (16-80Hz). Speech pitch is 85-250Hz (32-94 samples), well
// below this window, so a voice can't be mistaken for the interference.
const period = estimatePeriod(sig, Math.round(rate * 0.0125), Math.round(rate * 0.0625));
console.log(`interference period: ${period} samples = ${(rate / period).toFixed(1)} Hz  (${((period / rate) * 1000).toFixed(1)} ms)`);

let clean = removeComb(sig, period, Math.round(rate)); // ~1s blocks
clean = highpass(highpass(clean, 180, rate), 180, rate);
clean = lowpass(clean, 3000, rate);

function measure(arr) {
  let q = Infinity, l = 0, pk = 0;
  for (let w = 0; w + win <= arr.length; w += win) {
    let s = 0;
    for (let i = w; i < w + win; i++) { s += arr[i] * arr[i]; if (Math.abs(arr[i]) > pk) pk = Math.abs(arr[i]); }
    const r = Math.sqrt(s / win);
    if (r < q) q = r;
    if (r > l) l = r;
  }
  return { q, l, pk, db: q > 0 ? 20 * Math.log10(l / q) : 0 };
}
const mRaw = measure(sig), mCln = measure(clean);
console.log(`raw      : quiet ${mRaw.q.toFixed(1)}  loud ${mRaw.l.toFixed(1)}  => ${mRaw.db.toFixed(1)} dB`);
console.log(`filtered : quiet ${mCln.q.toFixed(1)}  loud ${mCln.l.toFixed(1)}  => ${mCln.db.toFixed(1)} dB   (180Hz HP x2 + 3kHz LP)`);

// ---- write the WAV, normalised so it's actually audible ----
// The device deliberately sends raw ADC counts with no gain, so a quiet signal
// would be inaudible at unity. Scaling here is lossless in the sense that it
// happens after measurement, so it can't flatter the numbers above.
function writeWav(file, arr, pk) {
  // Normalise for audibility. Done AFTER measurement, so it can never flatter
  // the dB figures above - and the filtered take gets more usable gain simply
  // because the rumble was eating the headroom.
  const gain = pk > 0 ? Math.min(30000 / pk, 400) : 1;
  const out = Buffer.alloc(arr.length * 2);
  for (let i = 0; i < arr.length; i++) {
    const v = Math.round(arr[i] * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  const wav = Buffer.alloc(44 + out.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + out.length, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(out.length, 40);
  out.copy(wav, 44);
  fs.writeFileSync(file, wav);
  console.log(`wrote ${file}  (${(arr.length / rate).toFixed(2)}s, ${rate}Hz mono, gain x${gain.toFixed(1)})`);
}

writeWav(outPath, sig, mRaw.pk);
writeWav(outPath.replace(/\.wav$/, "-clean.wav"), clean, mCln.pk);
