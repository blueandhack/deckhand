#!/usr/bin/env node
// Did a change to SHARED code alter a board's binary?
//
// This replaces the "board 1 is byte-identical: flash 1382802, RAM 69236" ritual
// that guarded the whole two-board port. That check was retired the moment two
// deliberate shared-code fixes changed board 1 on purpose (the history-list blank
// and the PAIRED MACS row), and it had two weaknesses worth naming:
//
//   - It compared SIZES, not bytes, despite being called byte-identity. Two
//     different binaries of the same length pass it.
//   - The numbers lived in prose, so running the check meant remembering it.
//
// A plain hash cannot replace it, because THE BUILD IS NOT REPRODUCIBLE -
// measured, not assumed: two compiles of identical source differ in 68 of
// 1,383,200 bytes. But every differing byte is DERIVED METADATA rather than code,
// and confined to three ranges (below), so masking them yields a hash that is
// stable across rebuilds and sensitive to any real change.
//
//   node firmware/board-baseline.mjs <bin> <board>                  # print the hash
//   node firmware/board-baseline.mjs <bin> --check 1                # compare to baseline
//   node firmware/board-baseline.mjs <bin> --update 1               # re-baseline, deliberately
//   node firmware/board-baseline.mjs --selftest <binA> <binB> <board>
//
// The board number is required everywhere, because PART OF THE MASK IS
// BOARD-SPECIFIC - see MASK_BOARD.
//
// Compiling is left OUT of this script on purpose: a board build is ~5 minutes and
// the two boards must never compile concurrently (one sketch build directory - see
// CLAUDE.md), so hiding the build inside a checker would invite exactly that.
// Build first, with --output-dir, then point this at the .bin.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// DERIVED FROM MEASUREMENT, not from the IDF headers, and that distinction
// matters: the ranges were found by compiling identical source twice and diffing,
// so they describe what this toolchain actually varies. Re-derive them with
// --selftest after an arduino-cli or ESP32 core upgrade; a toolchain that varies
// something new would otherwise make every check fail and look like a real change.
//
//   0xB0..0xCF   esp_app_desc_t.app_elf_sha256 - the ELF's own digest, which moves
//                whenever anything does, including its own timestamp inputs.
//   a 5-byte cluster this script does NOT explain, at a BOARD-SPECIFIC offset
//                (MASK_BOARD). Masked because it demonstrably is not
//                source-determined; recorded as a known blind spot rather than
//                dressed up as understood.
//   last 33      the appended image SHA-256 plus its checksum byte.
//
// Note what is NOT here: esp_app_desc_t's time[16]/date[16] at 0x70..0x8F did not
// vary between builds minutes apart, so this core does not stamp them. If a future
// core does, --selftest will say so.
const MASK_COMMON = [{ from: 0xb0, to: 0xcf, why: "app_elf_sha256" }];
const MASK_TAIL_BYTES = 33; // image SHA-256 + checksum

// THE "UNEXPLAINED 5-BYTE CLUSTER" IS EXPLAINED, AND IT IS THE SKETCH'S OWN
// BUILD TIMESTAMP. It was masked for a long time as a board-specific blind spot
// at a FIXED offset - 0x13BC on board 1, 0x1D9C on board 2 - honestly labelled
// as measured-but-not-understood. Both descriptions were right about the bytes
// and wrong about the cause, and the fixed offsets were a latent trap.
//
// What it is: deckhand_display.ino prints `BUILD %s %s` with __DATE__ and
// __TIME__, so every image embeds "hh:mm:ss\0Mmm dd yyyy\0". Two compiles
// minutes apart differ only in the DIGITS that changed - which is exactly the
// "5 bytes with one matching by chance in the middle" the old note described:
// the middle byte was a colon. Measured, on two builds of identical source:
// `23:00:18` against `23:03:23`.
//
// Why it had to stop being an offset: the offset MOVES whenever the image
// layout does. Adding POWERPROBE grew the binary and shifted this string from
// 0x13BC to ~0x159A, so `--check 1` reported board 1 CHANGED at +0 bytes on a
// change that was entirely #if'd out for board 1. That is the same false
// positive board 2 once produced, from the same cause, and a fixed offset
// guarantees it recurs on the next size change.
//
// So it is LOCATED BY CONTENT now, per image, and the date is masked too: the
// old mask covered only part of the time string, so two builds on different
// DAYS would have diverged as well. Requiring exactly one match is deliberate -
// a pattern that matched nothing (or twice) would otherwise mask the wrong
// bytes silently, which is worse than failing.
// ANCHORED ON THE TRAILING "BUILD " FORMAT STRING, AND THAT IS NOT COSMETIC.
// An image contains THREE time\0date\0 pairs and only one of them varies -
// measured, on two builds of identical source:
//   0x1596   23:00:18 / 23:03:23   VARIES   the sketch's own, followed by "BUILD %s"
//   0x2D97   00:11:05 Aug 16 2026  fixed    prebuilt LittleFS "Software Info" stamp
//   0x11C0A  19:41:21 May 18 2026  fixed    prebuilt BTDM controller version stamp
// The last two are stamped when those LIBRARIES were built, so they are constant
// across our compiles; masking them would spend real sensitivity for nothing.
// Anchoring on "BUILD " selects exactly the one deckhand_display.ino creates, and
// ties the mask to the line responsible for it - so editing that line makes this
// fail loudly rather than quietly masking the wrong 20 bytes.
const BUILD_STAMP_RE = /[0-2]\d:[0-5]\d:[0-5]\d\x00[A-Z][a-z]{2} [ \d]\d \d{4}\x00BUILD /g;

function buildStampRange(buf) {
  const text = buf.toString("latin1");
  const hits = [...text.matchAll(BUILD_STAMP_RE)];
  if (hits.length !== 1) return { range: null, count: hits.length };
  // The anchor is matched but NOT masked: "BUILD " is an ordinary string literal
  // and a change to it must still be detected. Only the timestamp ahead of it is
  // toolchain-varying, so the mask stops at the date's NUL.
  const ANCHOR = "BUILD ";
  const from = hits[0].index;
  const to = from + hits[0][0].length - 1 - ANCHOR.length;
  return { range: { from, to, why: "__DATE__/__TIME__" }, count: 1 };
}

// Nothing board-specific remains: the one board-specific entry was this stamp,
// and it is found per image now. Kept as a hook because --selftest's whole job
// is telling you when a board needs one.
const MASK_BOARD = { 1: [], 2: [] };

const BASELINE = path.join(import.meta.dirname, "board-baseline.json");

function maskedHash(file, board) {
  const buf = Buffer.from(fs.readFileSync(file)); // a copy: this is mutated below
  let masked = 0;
  const stamp = buildStampRange(buf);
  if (!stamp.range) {
    console.error(
      `FAIL: expected exactly one BUILD __DATE__/__TIME__ stamp in ${path.basename(file)}, found ${stamp.count}.\n` +
      "That stamp is masked by CONTENT, so it has to be locatable. If the sketch\n" +
      "stopped printing it, drop the mask; if the format changed, fix BUILD_STAMP_RE.",
    );
    process.exit(1);
  }
  const ranges = [...MASK_COMMON, ...(MASK_BOARD[board] ?? []), stamp.range];
  for (const { from, to } of ranges) {
    if (to >= buf.length) continue;
    buf.fill(0, from, to + 1);
    masked += to - from + 1;
  }
  const tailFrom = Math.max(0, buf.length - MASK_TAIL_BYTES);
  buf.fill(0, tailFrom);
  masked += buf.length - tailFrom;
  return {
    hash: crypto.createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
    masked,
  };
}

function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  } catch {
    return {};
  }
}

const args = process.argv.slice(2);

// --selftest proves the MASK, which is the only part of this that could silently
// rot. Same teeth-proving convention as palette-check.mjs and the geometry
// checkers: it must FAIL if handed two binaries the mask cannot reconcile, so a
// stale mask is loud rather than invisible.
if (args[0] === "--selftest") {
  const [a, b] = [args[1], args[2]];
  const sboard = args[3] ?? "";
  if (!a || !b || !/^[12]$/.test(sboard)) {
    console.error("usage: --selftest <binA> <binB> <board>   (two builds of IDENTICAL source)");
    console.error("The board matters: part of the mask is board-specific - see MASK_BOARD.");
    process.exit(2);
  }
  const ra = maskedHash(a, sboard), rb = maskedHash(b, sboard);
  const rawA = crypto.createHash("sha256").update(fs.readFileSync(a)).digest("hex");
  const rawB = crypto.createHash("sha256").update(fs.readFileSync(b)).digest("hex");
  console.log(`raw    A ${rawA.slice(0, 16)}  B ${rawB.slice(0, 16)}  ${rawA === rawB ? "SAME" : "differ"}`);
  console.log(`masked A ${ra.hash.slice(0, 16)}  B ${rb.hash.slice(0, 16)}  ${ra.hash === rb.hash ? "SAME" : "DIFFER"}`);
  console.log(`sizes  A ${ra.size}  B ${rb.size}   masked ${ra.masked} bytes (${(ra.masked / ra.size * 100).toFixed(4)}%)`);
  if (ra.size !== rb.size) {
    console.error("\nFAIL: sizes differ, so these are not two builds of identical source.");
    process.exit(1);
  }
  if (rawA === rawB) {
    console.log("\nNote: the raw hashes already match, so this toolchain built reproducibly");
    console.log("here and the mask was not exercised. Not a failure - but this run proves");
    console.log("nothing about the mask. Rebuild to get two genuinely separate compiles.");
    process.exit(0);
  }
  if (ra.hash !== rb.hash) {
    console.error("\nFAIL: the mask does NOT cover everything this toolchain varies.");
    // The runs are PRINTED rather than left as an exercise: re-deriving them by
    // hand with cmp and awk is exactly the step this failed on the first time.
    const A = fs.readFileSync(a), B = fs.readFileSync(b);
    const runs = [];
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      if (A[i] === B[i]) continue;
      if (runs.length && i === runs[runs.length - 1][1] + 1) runs[runs.length - 1][1] = i;
      else runs.push([i, i]);
    }
    // The build stamp is located per image, so it has to be added here too -
    // otherwise the coverage report calls the one range it definitely DOES mask
    // "NOT COVERED" and sends the next reader chasing a mask that is fine.
    const stampA = buildStampRange(Buffer.from(A)).range;
    const covered = [...MASK_COMMON, ...(MASK_BOARD[sboard] ?? [])];
    if (stampA) covered.push(stampA);
    const tailFrom = A.length - MASK_TAIL_BYTES;
    console.error("\nRaw differing runs (0-based), and whether the mask covers each:");
    for (const [from, to] of runs) {
      const ok = from >= tailFrom || covered.some((c) => from >= c.from && to <= c.to);
      console.error(`  0x${from.toString(16).toUpperCase()}..0x${to.toString(16).toUpperCase()}` +
                    `  (${to - from + 1} bytes)  ${ok ? "covered" : "*** NOT COVERED ***"}`);
    }
    console.error(`\nAdd the uncovered runs to MASK_BOARD[${sboard}] and re-run.`);
    process.exit(1);
  }
  console.log("\nPASS: raw hashes differ, masked hashes agree - the mask covers exactly");
  console.log("the build's nondeterminism and nothing more.");
  process.exit(0);
}

const bin = args.find((a) => !a.startsWith("--"));
if (!bin) {
  console.error("usage: board-baseline.mjs <path-to.ino.bin> [--check <board>] [--update <board>]");
  console.error("       board-baseline.mjs --selftest <binA> <binB>");
  process.exit(2);
}
const flag = args.find((a) => a === "--check" || a === "--update");
const board = flag ? args[args.indexOf(flag) + 1] : args[args.indexOf(bin) + 1];
if (!board || !/^[12]$/.test(board)) {
  console.error("a board number (1 or 2) is required - part of the mask is board-specific.");
  console.error("  board-baseline.mjs <bin> <board>            # print the hash");
  console.error("  board-baseline.mjs <bin> --check|--update <board>");
  process.exit(2);
}
const r = maskedHash(bin, board);

if (!flag) {
  console.log(`${r.hash}  size=${r.size}  (masked ${r.masked} bytes, board ${board})`);
  process.exit(0);
}

const base = readBaseline();
if (flag === "--update") {
  base[`board${board}`] = { hash: r.hash, size: r.size, updated: new Date().toISOString() };
  fs.writeFileSync(BASELINE, JSON.stringify(base, null, 2) + "\n");
  console.log(`baseline for board ${board} set to ${r.hash.slice(0, 16)}... size=${r.size}`);
  console.log("Commit this, and say in the message WHY the binary was expected to move.");
  process.exit(0);
}

const want = base[`board${board}`];
if (!want) {
  console.error(`No baseline recorded for board ${board}. Set one with --update ${board}.`);
  process.exit(2);
}
if (want.hash === r.hash) {
  console.log(`board ${board} UNCHANGED  ${r.hash.slice(0, 16)}...  size=${r.size}`);
  process.exit(0);
}
console.error(`board ${board} CHANGED`);
console.error(`  baseline ${want.hash.slice(0, 16)}...  size=${want.size}`);
console.error(`  built    ${r.hash.slice(0, 16)}...  size=${r.size}  (${r.size - want.size >= 0 ? "+" : ""}${r.size - want.size} bytes)`);
console.error("");
console.error("If that was intended, re-baseline with --update and say why in the commit.");
console.error("If it was not, the change you thought was board-specific was not.");
process.exit(1);
