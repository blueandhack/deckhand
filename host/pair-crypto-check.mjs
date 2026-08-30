#!/usr/bin/env node
// Checks for the wireless-pairing crypto.
//
//   node host/pair-crypto-check.mjs              # the assertions
//   node host/pair-crypto-check.mjs --selftest   # proves each one can FAIL
//
// The point of this file is that the Mac and the device must derive
// BYTE-IDENTICAL values. A mismatch does not error anywhere: both ends stay
// self-consistent, the code the device shows is simply never the one the Mac
// derived, and it presents as "pairing is broken" with nothing in any log.
//
// Two kinds of assertion, and the difference matters:
//
//  - The PINNED VECTOR is the interop contract. It is deliberately built from
//    RFC 7748 section 6.1's own keys (clamped - see below), so its shared
//    secret is a value published by the IETF rather than one this repo made
//    up. The device runs the same vector under PAIRVECTOR and the two outputs
//    are compared by eye once, on hardware; after that this file is what keeps
//    the Mac's half from drifting.
//  - The SOURCE assertions read firmware/deckhand_display/pairing.ino as text
//    and check that the device's derivation still SAYS the same thing - the
//    info strings, the salt order, the modulus, the padding, the constant-time
//    compare. They cannot execute the sketch, so they are weaker than the
//    hardware run and stronger than nothing: they catch the edit, not the
//    toolchain.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as real from "./pair-crypto.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAIRING_INO = path.join(REPO, "firmware", "deckhand_display", "pairing.ino");

// ---------------------------------------------------------------------------
// THE PINNED VECTOR
//
// RFC 7748 section 6.1's Alice and Bob, with one deliberate change: both
// private keys are stored CLAMPED (low 3 bits of byte 0 cleared, top bit of
// byte 31 cleared, bit 6 of byte 31 set). X25519 clamps internally, so
// clamping first cannot change the result - and the public keys and shared
// secret below are byte-for-byte the RFC's, which is the proof that it did
// not. It has to be done here because mbedtls REFUSES an unclamped scalar
// (mbedtls_ecp_check_privkey rejects it outright for Montgomery curves), where
// node accepts either. Pinning the clamped form is what lets both sides load
// the SAME 32 bytes.
//
// A is the Mac (the initiator), B is the device. The device holds privB and
// receives pubA, so on the device the salt is peerPub || ownPub.
// ---------------------------------------------------------------------------
const V = {
  privA: "70076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c6a",
  pubA: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  privB: "58ab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e06b",
  pubB: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  // RFC 7748 section 6.1's published shared secret, unchanged.
  shared: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
  code: "602173",
  key: "6b721a4808075c644d3c803d7a14a256",
  proof: "74158bd76355725596025d6bdd508417",
};

// A SECOND vector whose only job is the leading zeros. 001472 has two of them,
// so a code that is not zero-padded renders as "1472" - four characters in a
// six-character box - and a comparison against the unpadded string would
// reject a code the user typed correctly. privB here is
// clamp(SHA-256("deckhand-pair-zero-303")), found by search; it is pinned
// rather than re-searched so the checker has no clock and no loop that could
// silently stop finding one.
const Z = {
  privB: "1077033da8d6db6d9bbc46c1a3e4f1b96db0c223eab98c752953ea87e1beae55",
  pubB: "eb6123a20a9b9704be7d3f56e7985937c48781fca9f6cfa06b8e8168e09f5c44",
  shared: "ef8041a0517c799a056434b235c38c79288ed72e17475025eeca15163628c23f",
  code: "001472",
  key: "4f76890a49d5a1f7113a52f2c13228c5",
};

const hex = (b) => Buffer.from(b).toString("hex");
const B = (h) => Buffer.from(h, "hex");

// ---------------------------------------------------------------------------
// The suite runs against an INJECTED implementation so --selftest can break one
// function at a time and see which assertion notices. Every assertion is named,
// because "something failed" cannot tell the assertion that exists for a fault
// from an unrelated crash.
// ---------------------------------------------------------------------------
function suite(m, ok) {
  // ---- the pinned vector, both roles ----
  const privA = B(V.privA), privB = B(V.privB), pubA = B(V.pubA), pubB = B(V.pubB);

  ok("VECTOR: pubA is X25519(privA, basepoint)", hex(m.publicFromPrivate(privA)) === V.pubA);
  ok("VECTOR: pubB is X25519(privB, basepoint)", hex(m.publicFromPrivate(privB)) === V.pubB);

  const sharedA = m.deriveShared(privA, pubB);
  const sharedB = m.deriveShared(privB, pubA);
  ok("VECTOR: the Mac's shared secret is RFC 7748 section 6.1's", hex(sharedA) === V.shared);
  ok("VECTOR: the device's shared secret is the same 32 bytes", hex(sharedB) === V.shared);

  ok("VECTOR: code", m.deriveCode(sharedA, pubA, pubB) === V.code);
  ok("VECTOR: key", hex(m.deriveKey(sharedA, pubA, pubB)) === V.key);
  ok("VECTOR: proof", m.pairProof(m.deriveKey(sharedA, pubA, pubB)) === V.proof);

  // The device computes the SAME code and key from its own side of the
  // exchange - which is the whole claim, and it is not implied by the shared
  // secret matching, because the salt is built from a fixed role order rather
  // than from "mine then theirs".
  ok("VECTOR: the device derives the same code from peerPub || ownPub",
    m.deriveCode(sharedB, pubA, pubB) === V.code);
  ok("VECTOR: the device derives the same key",
    hex(m.deriveKey(sharedB, pubA, pubB)) === V.key);

  // ---- fresh keypairs agree in both directions ----
  {
    const a = m.generateKeypair();
    const b = m.generateKeypair();
    const sa = m.deriveShared(a.priv, b.pub);
    const sb = m.deriveShared(b.priv, a.pub);
    ok("FRESH: two independent keypairs derive the same shared secret", hex(sa) === hex(sb));
    ok("FRESH: the shared secret is 32 bytes", sa.length === 32);
    ok("FRESH: both ends derive the same key from it",
      hex(m.deriveKey(sa, a.pub, b.pub)) === hex(m.deriveKey(sb, a.pub, b.pub)));
    ok("FRESH: both ends derive the same code from it",
      m.deriveCode(sa, a.pub, b.pub) === m.deriveCode(sb, a.pub, b.pub));
    ok("FRESH: a generated public key really is its private key's",
      hex(m.publicFromPrivate(a.priv)) === hex(a.pub));
    ok("FRESH: two keypairs are not the same keypair", hex(a.priv) !== hex(b.priv));
  }

  // ---- the salt ORDER is load-bearing ----
  // This is the failure that looks like nothing is wrong: swap the order on ONE
  // side and both ends still derive a perfectly good key, they just differ.
  ok("SALT: pubA || pubB and pubB || pubA give different keys",
    hex(m.deriveKey(sharedA, pubA, pubB)) !== hex(m.deriveKey(sharedA, pubB, pubA)));
  ok("SALT: pubA || pubB and pubB || pubA give different codes",
    m.deriveCode(sharedA, pubA, pubB) !== m.deriveCode(sharedA, pubB, pubA));
  ok("SALT: the salt really is the two keys concatenated in that order",
    hex(m.pairSalt(pubA, pubB)) === V.pubA + V.pubB);

  // ---- a one-bit change ANYWHERE changes the code ----
  // Each of the three inputs is flipped separately, because a derivation that
  // silently ignored one of them would still pass a test that only flips the
  // others - and ignoring the salt is exactly what a man-in-the-middle needs.
  {
    const flip = (buf, byte, bit) => {
      const c = Buffer.from(buf);
      c[byte] ^= 1 << bit;
      return c;
    };
    const base = m.deriveCode(sharedA, pubA, pubB);
    ok("BIT: one bit of the shared secret changes the code",
      m.deriveCode(flip(sharedA, 0, 0), pubA, pubB) !== base);
    ok("BIT: one bit of the LAST byte of the shared secret changes the code",
      m.deriveCode(flip(sharedA, 31, 7), pubA, pubB) !== base);
    ok("BIT: one bit of pubA changes the code",
      m.deriveCode(sharedA, flip(pubA, 5, 3), pubB) !== base);
    ok("BIT: one bit of pubB changes the code",
      m.deriveCode(sharedA, pubA, flip(pubB, 30, 1)) !== base);
    const baseKey = hex(m.deriveKey(sharedA, pubA, pubB));
    ok("BIT: one bit of pubB changes the key",
      hex(m.deriveKey(sharedA, pubA, flip(pubB, 30, 1))) !== baseKey);
  }

  // ---- the code is ALWAYS six characters, leading zeros included ----
  {
    const zPrivB = B(Z.privB), zPubB = B(Z.pubB);
    ok("ZERO: the leading-zero vector's public key is its private key's",
      hex(m.publicFromPrivate(zPrivB)) === Z.pubB);
    const zs = m.deriveShared(privA, zPubB);
    ok("ZERO: the leading-zero vector's shared secret", hex(zs) === Z.shared);
    const zc = m.deriveCode(zs, pubA, zPubB);
    ok("ZERO: a code with two leading zeros renders as 001472", zc === Z.code);
    ok("ZERO: it is still exactly 6 characters", zc.length === 6);
    ok("ZERO: the leading-zero vector's key", hex(m.deriveKey(zs, pubA, zPubB)) === Z.key);

    // A sweep, because one pinned example proves the padding fires once and not
    // that it always does. 400 real exchanges is enough to hit the length
    // classes without a clock; every one of them must be six digits.
    let allSix = true, sawDigitsOnly = true;
    for (let i = 0; i < 400; i++) {
      const kp = m.generateKeypair();
      const c = m.deriveCode(m.deriveShared(privA, kp.pub), pubA, kp.pub);
      if (c.length !== 6) allSix = false;
      if (!/^[0-9]{6}$/.test(c)) sawDigitsOnly = false;
    }
    ok("ZERO: 400 random exchanges all produce a 6-character code", allSix);
    ok("ZERO: 400 random exchanges all produce six DIGITS", sawDigitsOnly);
  }

  // ---- the proof rejects a wrong key ----
  {
    const key = m.deriveKey(sharedA, pubA, pubB);
    const proof = m.pairProof(key);
    const wrongKey = Buffer.from(key); wrongKey[0] ^= 1;
    ok("PROOF: the right key's proof matches", m.proofMatches(proof, V.proof));
    ok("PROOF: a one-bit-different key produces a different proof",
      m.pairProof(wrongKey) !== proof);
    ok("PROOF: a proof from the wrong key is REJECTED",
      !m.proofMatches(m.pairProof(wrongKey), proof));
    ok("PROOF: an empty proof is rejected rather than treated as a match",
      !m.proofMatches("", proof));
    ok("PROOF: a truncated proof is rejected without throwing",
      !m.proofMatches(proof.slice(0, 16), proof));
    ok("PROOF: it is 32 lowercase hex characters", /^[0-9a-f]{32}$/.test(proof));
    ok("PROOF: a key of the wrong length is refused, not silently padded",
      (() => { try { m.pairProof(Buffer.alloc(8)); return false; } catch { return true; } })());
  }

  // ---- the typed code is compared the same way ----
  {
    ok("CODE: the right code matches", m.codeMatches(V.code, V.code));
    ok("CODE: a one-digit-different code is rejected", !m.codeMatches("602174", V.code));
    ok("CODE: an unpadded code is rejected rather than accidentally accepted",
      !m.codeMatches("1472", Z.code));
    ok("CODE: an empty entry is rejected", !m.codeMatches("", V.code));
  }
}

// ---------------------------------------------------------------------------
// SOURCE assertions - the device half, read as text.
//
// These bind the SKETCH rather than a mirror of it. They cannot run it, so what
// they catch is an EDIT that changes a derivation; what only the hardware run
// can catch is the toolchain disagreeing (the byte order the whole PAIRVECTOR
// command exists for). Both are needed, and saying which is which is the point.
// ---------------------------------------------------------------------------
function sourceSuite(ok) {
  const src = fs.readFileSync(PAIRING_INO, "utf8");
  // Comments are stripped so a derivation QUOTED in a comment cannot satisfy an
  // assertion about the code - the trap panel_shim.cpp's invertColor note
  // records, where a text match passed while the line was compiled out.
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  ok("SOURCE: the device uses the same SAS info string",
    code.includes(`"${real.SAS_INFO}"`));
  ok("SOURCE: the device uses the same KEY info string",
    code.includes(`"${real.KEY_INFO}"`));
  ok("SOURCE: the device uses the same proof message",
    code.includes(`"${real.PROOF_MSG}"`));
  ok("SOURCE: the two info strings are DIFFERENT on the device too",
    real.SAS_INFO !== real.KEY_INFO);
  ok("SOURCE: every info string carries the /1 version marker",
    [real.SAS_INFO, real.KEY_INFO, real.PROOF_MSG].every((s) => s.endsWith("/1")));

  // The salt, on the device, is peerPub (the Mac's, A) then ownPub (B). Written
  // out as the two memcpys so the ORDER is what is asserted, not the fact that
  // a salt exists.
  const saltA = code.match(/memcpy\(salt,\s*pubA,\s*32\)/);
  const saltB = code.match(/memcpy\(salt \+ 32,\s*pubB,\s*32\)/);
  ok("SOURCE: the device's salt starts with the MAC's key (pubA at offset 0)", saltA != null);
  ok("SOURCE: the device's salt ends with its OWN key (pubB at offset 32)", saltB != null);
  ok("SOURCE: pubA is copied before pubB in the source order too",
    saltA != null && saltB != null && saltA.index < saltB.index);

  // PARSED, not transcribed: the sketch spells the modulus as a macro, so the
  // assertion has to read the macro's VALUE and then check the expression uses
  // it. Matching the literal 1000000 in the expression would have failed
  // against correct code, which is how a checker teaches people to ignore it.
  const modM = code.match(/#define PAIR_CODE_MODULUS\s+(\d+)/);
  ok("SOURCE: PAIR_CODE_MODULUS is defined", modM != null);
  ok("SOURCE: the device's modulus is 1000000, the same as the Mac's",
    modM != null && Number(modM[1]) === real.CODE_MODULUS);
  ok("SOURCE: the code is actually taken modulo it",
    /%\s*PAIR_CODE_MODULUS/.test(code));
  ok("SOURCE: the code is formatted as six zero-padded digits",
    /"%06lu"|"%06u"|"%06\w*"/.test(code));
  ok("SOURCE: the code's four bytes are read BIG-endian",
    /\(\(uint32_t\)\s*c\[0\]\s*<<\s*24\)/.test(code));

  ok("SOURCE: the proof is compared in constant time, never with memcmp",
    /pairCtEq\s*\(/.test(code) && !/memcmp\([^)]*proof/i.test(code));
  ok("SOURCE: the constant-time compare accumulates with OR rather than returning early",
    /diff\s*\|=/.test(code));

  ok("SOURCE: the whole path is behind BOARD_HAS_WIRELESS_PAIR",
    /#if\s+BOARD_HAS_WIRELESS_PAIR/.test(code));

  // Board 1 must gain the flag and nothing else - the flag alone emits no code.
  const b1 = fs.readFileSync(path.join(REPO, "firmware", "deckhand_display", "board_e32r28t.h"), "utf8");
  const b2 = fs.readFileSync(path.join(REPO, "firmware", "deckhand_display", "board_es3c35p.h"), "utf8");
  ok("SOURCE: board 1 declares BOARD_HAS_WIRELESS_PAIR 0",
    /^#define BOARD_HAS_WIRELESS_PAIR\s+0\b/m.test(b1));
  ok("SOURCE: board 2 declares BOARD_HAS_WIRELESS_PAIR 1",
    /^#define BOARD_HAS_WIRELESS_PAIR\s+1\b/m.test(b2));
}

// ---------------------------------------------------------------------------
function run(m, quiet) {
  const failures = [];
  let pass = 0;
  const ok = (name, cond) => {
    if (cond) { pass++; if (!quiet) console.log(`  ok    ${name}`); }
    else { failures.push(name); if (!quiet) console.log(`  FAIL  ${name}`); }
  };
  try { suite(m, ok); } catch (e) { failures.push(`THREW: ${e.message}`); }
  return { pass, failures };
}

// ---------------------------------------------------------------------------
// --selftest: the teeth-proving convention this repo uses everywhere. Each fault
// is a real, plausible mistake, and the run exits 0 only when EVERY one is
// caught - naming the assertion that caught it, because a fault caught by an
// unrelated crash is not a covered fault.
// ---------------------------------------------------------------------------
function selftest() {
  const wrap = (over) => ({ ...real, ...over });
  const faults = [
    ["the shared secret comes back BYTE-REVERSED (the mbedtls hazard)",
      wrap({ deriveShared: (p, q) => Buffer.from(real.deriveShared(p, q)).reverse() })],
    ["the code's four bytes are read little-endian",
      wrap({ deriveCode: (s, a, b) => {
        const salt = real.pairSalt(a, b);
        const out = Buffer.from(crypto.hkdfSync("sha256", s, salt, real.SAS_INFO, 4));
        return String(out.readUInt32LE(0) % real.CODE_MODULUS).padStart(6, "0");
      } })],
    ["the code is not zero-padded",
      wrap({ deriveCode: (s, a, b) => String(Number(real.deriveCode(s, a, b))) })],
    // The salt swapped INSIDE the derivations, not merely on the exported
    // pairSalt: overriding the export alone leaves deriveCode/deriveKey calling
    // the module's own copy, so it would model nothing. This is the failure
    // that looks like nothing is wrong - each end derives a good code and key,
    // they simply differ - so it must be the pinned vector that catches it.
    ["the salt is built peer-first inside the derivations",
      wrap({
        deriveCode: (s2, a, b) => {
          const out = Buffer.from(crypto.hkdfSync("sha256", s2, real.pairSalt(b, a), real.SAS_INFO, 4));
          return String(out.readUInt32BE(0) % real.CODE_MODULUS).padStart(6, "0");
        },
        deriveKey: (s2, a, b) => Buffer.from(
          crypto.hkdfSync("sha256", s2, real.pairSalt(b, a), real.KEY_INFO, 16)),
      })],
    ["the exported pairSalt disagrees with the derivations it documents",
      wrap({ pairSalt: (a, b) => real.pairSalt(b, a) })],
    ["the salt is dropped from the code derivation",
      wrap({ deriveCode: (s) => {
        const out = Buffer.from(crypto.hkdfSync("sha256", s, Buffer.alloc(0), real.SAS_INFO, 4));
        return String(out.readUInt32BE(0) % real.CODE_MODULUS).padStart(6, "0");
      } })],
    ["the key derivation reuses the SAS info string (the /1 markers collapse)",
      wrap({ deriveKey: (s, a, b) => Buffer.from(
        crypto.hkdfSync("sha256", s, real.pairSalt(a, b), real.SAS_INFO, 16)) })],
    ["the proof signs a different message",
      wrap({ pairProof: (k) => crypto.createHmac("sha256", k).update("pairok").digest("hex").slice(0, 32) })],
    ["proofMatches accepts anything",
      wrap({ proofMatches: () => true })],
    ["codeMatches compares only the first digit",
      wrap({ codeMatches: (a, b) => a[0] === b[0] })],
    ["the code modulus is 10^5, so five-digit codes escape",
      wrap({ deriveCode: (s, a, b) => {
        const out = Buffer.from(crypto.hkdfSync("sha256", s, real.pairSalt(a, b), real.SAS_INFO, 4));
        return String(out.readUInt32BE(0) % 100000).padStart(6, "0");
      } })],
    ["publicFromPrivate returns the private key",
      wrap({ publicFromPrivate: (p) => Buffer.from(p) })],
    ["generateKeypair returns a fixed keypair",
      (() => { const kp = real.generateKeypair(); return wrap({ generateKeypair: () => kp }); })()],
  ];

  const base = run(real, true);
  if (base.failures.length) {
    console.log("selftest ABORTED: the suite does not pass against the real module");
    base.failures.forEach((f) => console.log(`  FAIL  ${f}`));
    process.exit(1);
  }

  let caught = 0;
  for (const [name, impl] of faults) {
    const r = run(impl, true);
    if (r.failures.length) {
      caught++;
      console.log(`  caught  ${name}`);
      console.log(`            by: ${r.failures[0]}${r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : ""}`);
    } else {
      console.log(`  MISSED  ${name}  <- no assertion notices this`);
    }
  }
  console.log(`\nselftest: ${caught}/${faults.length} injected faults caught`);
  process.exit(caught === faults.length ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const { pass, failures } = run(real, false);
  let srcPass = 0;
  const srcFail = [];
  const ok = (name, cond) => {
    if (cond) { srcPass++; console.log(`  ok    ${name}`); }
    else { srcFail.push(name); console.log(`  FAIL  ${name}`); }
  };
  sourceSuite(ok);
  const total = failures.length + srcFail.length;
  // A THREW entry never reached an ok() call, so it would otherwise be counted
  // and never named.
  failures.filter((f) => f.startsWith("THREW")).forEach((f) => console.log(`  FAIL  ${f}`));
  console.log(total
    ? `\n${total} check(s) FAILED`
    : `\n${pass} crypto + ${srcPass} source assertions pass`);
  process.exit(total ? 1 : 0);
}
