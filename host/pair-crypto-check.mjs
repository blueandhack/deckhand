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
// Task 2 put the pairing WINDOW in pairing.ino but its close sites in the two
// files that own the events - a tab switch and the two sleeps. An assertion
// that only read pairing.ino could not tell "closes on sleep" from "has a
// function that would close on sleep if anyone called it", which is the same
// hole the constant-time assertion below already fell into once.
const MAIN_INO = path.join(REPO, "firmware", "deckhand_display", "deckhand_display.ino");
const POWER_INO = path.join(REPO, "firmware", "deckhand_display", "power.ino");
// sessions.ino owns the fifth full-screen-surface refusal list (detailBandVisible).
const SESSIONS_INO = path.join(REPO, "firmware", "deckhand_display", "sessions.ino");

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
// Brace-matched body of a function, so an assertion about "what pairDeriveAll
// wipes" cannot be satisfied by a zeroize call sitting in a different function.
function fnBody(text, name) {
  const m = new RegExp(`\\b${name}\\s*\\([^;{]*\\)\\s*\\{`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length - 1, depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(i, j + 1);
  }
  return null;
}

// `over` lets --selftest run this suite against MUTATED copies of the three
// files without writing to the tree; an absent key reads the real file.
function sourceSuite(ok, over) {
  const o = over || {};
  const src = o.pairing != null ? o.pairing : fs.readFileSync(PAIRING_INO, "utf8");
  const strip = (t) => t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const mainCode = strip(o.main != null ? o.main : fs.readFileSync(MAIN_INO, "utf8"));
  const powerCode = strip(o.power != null ? o.power : fs.readFileSync(POWER_INO, "utf8"));
  const sessionsCode = strip(o.sessions != null ? o.sessions : fs.readFileSync(SESSIONS_INO, "utf8"));
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
  // These two used to read real.SAS_INFO etc - HOST constants - while being
  // named "on the device too". They asserted nothing about the device and the
  // suite's claim about which half proves what was false for both. They parse
  // the device's own macros now, so the name and the evidence agree.
  const devStr = (name) => {
    const m = code.match(new RegExp(`#define\\s+${name}\\s+"([^"]*)"`));
    return m ? m[1] : null;
  };
  const devSas = devStr("PAIR_SAS_INFO");
  const devKey = devStr("PAIR_KEY_INFO");
  const devProof = devStr("PAIR_PROOF_MSG");
  ok("SOURCE: the DEVICE's two info strings are different macros",
    devSas != null && devKey != null && devSas !== devKey);
  ok("SOURCE: every info string carries the /1 version marker in pairing.ino",
    [devSas, devKey, devProof].every((v) => typeof v === "string" && v.endsWith("/1")));

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

  // -------------------------------------------------------------------------
  // CONSTANT TIME. THE ASSERTION THAT USED TO STAND HERE WAS VACUOUS, AND
  // REPLACING IT IS THE WHOLE POINT OF THIS SECTION.
  //
  // It read: /pairCtEq\s*\(/.test(code) && !/memcmp\([^)]*proof/i.test(code).
  // The first half was satisfied by the function's own DEFINITION - pairCtEq
  // had zero call sites, so nothing was being compared in constant time at
  // all - and the second half looked for one literal spelling next to one
  // literal identifier, so it caught neither strcmp, nor ==, nor any buffer
  // not named "proof". Both of the reviewer's injections (a pairVerifyProof
  // using strcmp, and one using memcmp) passed it clean.
  //
  // Three assertions replace it, and they need each other: a CALL SITE (so
  // the function is used, not merely present), a BAN on every byte-compare
  // function inside the pairing block (so a second, unsafe path cannot be
  // added beside the safe one), and a ban on == / != against any
  // secret-bearing identifier. The call-site assertion alone would be
  // satisfiable by any one caller while a later verification path used strcmp;
  // the ban is what closes that.
  // -------------------------------------------------------------------------
  // The block ALONE, never the file: strcmp is legitimate elsewhere in
  // pairing.ino (the host-slot lookup compares public hostIds), so a
  // file-wide rule would have to be weakened until it caught nothing.
  // ANCHORED ON THE CRYPTO SECTION'S OWN #if, not on the first one in the file.
  // upsertHost() now carries a small BOARD_HAS_WIRELESS_PAIR guard of its own
  // (the audit-marker fix below), and taking the first #if would drag findHost /
  // forgetHost into "the block" - whose strcmp on a PUBLIC hostId would then trip
  // the byte-compare ban, i.e. a correct line failing a rule that does not apply
  // to it. That is how a checker teaches people to ignore it.
  const blockStart = code.lastIndexOf("#if BOARD_HAS_WIRELESS_PAIR",
                                      code.indexOf("#define PAIR_SAS_INFO"));
  const block = blockStart < 0 ? "" : code.slice(blockStart, code.lastIndexOf("#endif"));
  ok("SOURCE: the wireless-pairing block is found and non-empty", block.length > 500);

  const ctDefs = (block.match(/\bbool\s+pairCtEq\s*\(/g) || []).length;
  const ctAll = (block.match(/(^|[^\w])pairCtEq\s*\(/g) || []).length;
  ok("SOURCE: pairCtEq is CALLED, not merely defined (the old assertion's hole)",
    ctDefs === 1 && ctAll - ctDefs >= 1);

  const CMP_FNS = /\b(memcmp|bcmp|strcmp|strncmp|strcasecmp|strncasecmp|strcoll)\s*\(/g;
  const cmpHits = block.match(CMP_FNS) || [];
  ok("SOURCE: no byte-compare function appears anywhere in the pairing block",
    cmpHits.length === 0);

  // Matched by IDENTIFIER rather than by one spelling, so it binds whatever a
  // future secret is called. Operand-level on purpose: a whole-line match
  // would fire on mbedtls_md_hmac_starts(&ctx, key, ...) == 0, which is a
  // return code.
  const SECRET = /(proof|code|key|secret|shared|sas|hmac|digest|nonce|salt)/i;
  const eqHits = [];
  for (const m of block.matchAll(/([A-Za-z_]\w*)\s*(?:==|!=)|(?:==|!=)\s*([A-Za-z_]\w*)/g)) {
    const id = m[1] || m[2];
    if (id && SECRET.test(id)) eqHits.push(m[0].trim());
  }
  ok(`SOURCE: nothing secret-bearing is compared with == or != ${eqHits.length ? "[" + eqHits.join(", ") + "]" : ""}`,
    eqHits.length === 0);
  ok("SOURCE: the constant-time compare accumulates with OR rather than returning early",
    /diff\s*\|=/.test(code));

  // -------------------------------------------------------------------------
  // ZEROIZATION. pairDeriveAll is the function the real 128-bit pairing secret
  // will be derived in, into a stack frame the UI reuses immediately, so every
  // secret buffer it declares must be wiped on EVERY exit path - which is why
  // it is single-exit. The list is PARSED from the declaration rather than
  // transcribed, so a buffer added later is covered by default: anything not
  // named pub* has to be zeroized or this fails.
  // -------------------------------------------------------------------------
  const dvBody = fnBody(block, "pairDeriveAll");
  ok("SOURCE: pairDeriveAll's body is found", dvBody != null && dvBody.length > 200);
  const declared = [];
  for (const m of (dvBody || "").matchAll(/\buint8_t\s+([^;]+);/g)) {
    for (const part of m[1].split(",")) {
      const id = part.trim().match(/^([A-Za-z_]\w*)\s*\[/);
      if (id) declared.push(id[1]);
    }
  }
  const secretBufs = declared.filter((n) => !/^pub/i.test(n));
  ok(`SOURCE: pairDeriveAll declares secret buffers to wipe [${secretBufs.join(", ")}]`,
    secretBufs.length >= 4);
  for (const n of secretBufs) {
    ok(`SOURCE: pairDeriveAll zeroizes ${n}`,
      new RegExp(`mbedtls_platform_zeroize\\(\\s*${n}\\b`).test(dvBody || ""));
  }
  ok("SOURCE: it is mbedtls_platform_zeroize, not a memset a compiler may delete",
    !/memset\s*\(\s*(shared|salt|key)\b/.test(dvBody || ""));
  ok("SOURCE: pairDeriveAll is single-exit, so a later early return cannot skip the wipe",
    (dvBody || "").includes("goto done") && /\bdone:/.test(dvBody || "") &&
    ((dvBody || "").match(/\breturn\s+/g) || []).length === 1);

  // pairVectorReport's own secrets, named because they are not all buffers of
  // one declaration: the vector's shared secret and key, both EPHEMERAL
  // PRIVATE keys, and the two shared secrets of the live round trip.
  const vrBody = fnBody(block, "pairVectorReport");
  for (const n of ["shared", "key", "p1", "p2", "s1", "s2"]) {
    ok(`SOURCE: pairVectorReport zeroizes ${n}`,
      new RegExp(`mbedtls_platform_zeroize\\(\\s*${n}\\b`).test(vrBody || ""));
  }


  // =========================================================================
  // TASK 2: THE WINDOW, THE HANDLERS AND THE STORAGE.
  //
  // Everything above this point guards ARITHMETIC. These guard the code that is
  // reached by bytes off the radio, so the properties they pin are the ones a
  // reviewer would otherwise have to re-derive by reading: that both fields are
  // validated before either is used, that a full store is refused before any key
  // exists, that the proof is compared in constant time, that the window really
  // does die on a tab switch and on sleep, and that no secret ever reaches a
  // Serial.print or the wire.
  // =========================================================================
  const b1 = fs.readFileSync(path.join(REPO, "firmware", "deckhand_display", "board_e32r28t.h"), "utf8");
  const b2 = fs.readFileSync(path.join(REPO, "firmware", "deckhand_display", "board_es3c35p.h"), "utf8");

  // ---- a tiny constant resolver, so a SIZE can be asserted against a NAME ----
  // Buffer sizes here are macros and expressions (PAIR_KEY_BYTES * 2 + 1), and a
  // checker that transcribed 33 would be the exact defect this repo has paid for
  // three times. Values come from the sketch's own #defines and board 2's own
  // const ints; anything that will not resolve returns null and fails loudly
  // rather than passing as NaN.
  const consts = {};
  for (const m of code.matchAll(/#define\s+([A-Za-z_]\w*)\s+(\d+)/g)) consts[m[1]] = Number(m[2]);
  for (const m of b2.matchAll(/^const int\s+([A-Za-z_]\w*)\s*=\s*(\d+);/gm)) consts[m[1]] = Number(m[2]);
  const resolve = (expr) => {
    if (expr == null) return null;
    const sub = String(expr).replace(/[A-Za-z_]\w*/g, (id) =>
      consts[id] != null ? String(consts[id]) : "?");
    if (!/^[0-9+\-*/() ]+$/.test(sub)) return null;
    try { const v = Function(`"use strict";return (${sub});`)(); return Number.isFinite(v) ? v : null; }
    catch { return null; }
  };
  // Every array declared in the block, by name -> its declared size expression.
  const arrSize = {};
  for (const m of block.matchAll(/\b(?:uint8_t|char)\s+([^;()]+);/g)) {
    for (const part of m[1].split(",")) {
      // Everything from an initialiser on is not part of the declarator:
      // `char pairProofWant[33] = "";` is the shape half these fields have, and
      // a parse that skipped them silently resolved their size to undefined -
      // which is not a failed assertion, it is an assertion that never ran.
      const d = part.split("=")[0].trim().match(/^([A-Za-z_]\w*)\s*\[\s*([^\]]+?)\s*\]$/);
      if (d) arrSize[d[1]] = d[2].trim();
    }
  }

  const reqBody = fnBody(block, "handlePairReq") || "";
  const okBody = fnBody(block, "handlePairOk") || "";
  const cancelBody = fnBody(block, "handlePairCancel") || "";
  const wipeBody = fnBody(block, "pairWipe") || "";
  const closeBody = fnBody(block, "pairClose") || "";
  const hexBody = fnBody(block, "pairHexToBytes") || "";
  const replyBody = fnBody(block, "pairReply") || "";
  const winBody = fnBody(block, "pairWindowOpen") || "";
  const commitBody = fnBody(block, "pairCommitIfReady") || "";
  const confirmBody = fnBody(block, "pairConfirm") || "";
  const confirmableBody = fnBody(block, "pairConfirmable") || "";
  const labelBody = fnBody(block, "pairSanitiseLabel") || "";
  // The storage entry point, named once: every assertion about "what stores a
  // key" reads this rather than repeating the spelling.
  const upsertName = "upsertHost";
  ok("WINDOW: all three handlers plus pairWipe/pairClose/pairReply are found",
    [reqBody, okBody, cancelBody, wipeBody, closeBody, hexBody, replyBody]
      .every((b) => b.length > 40));
  ok("COMMIT: pairConfirmable, pairCommitIfReady and pairConfirm are all found",
    [commitBody, confirmBody, confirmableBody].every((b) => b.length > 20));

  // The length check the security review deferred here: every device-side entry
  // point takes uint8_t[32], which decays to a pointer and can check nothing, so
  // the hex parser is the only place a short string can be refused.
  ok("WINDOW: pairHexToBytes refuses a string of the wrong length before parsing",
    /if\s*\(\s*strlen\([^)]*\)\s*!=[^)]*\)\s*return false;/.test(hexBody));
  ok("WINDOW: it also refuses a non-hex character rather than parsing a prefix",
    /pairHexNibble/.test(hexBody) && /return false/.test(hexBody));

  // THE PARSER ENFORCES *A* LENGTH; THE CALL SITE CHOOSES *WHICH*, AND ONLY THE
  // CALL SITE KNOWS HOW BIG THE DESTINATION IS. pairHexToBytes(pubHex.c_str(),
  // 31, pubA) satisfies every assertion above it - the string really is 62
  // characters and every one of them really is hex - and leaves pubA[31] holding
  // whatever the stack held before, which then flows into the derivation. So the
  // requested length is asserted against the DECLARED SIZE of the buffer it
  // writes into, both resolved rather than transcribed.
  const hexCalls = [...block.matchAll(
    /pairHexToBytes\s*\(\s*[^,]+,\s*([^,]+),\s*([A-Za-z_]\w*)\s*\)/g)];
  ok("WINDOW: pairHexToBytes is actually called", hexCalls.length >= 1);
  const badLen = [];
  for (const c of hexCalls) {
    const want = resolve(c[1]);
    const have = resolve(arrSize[c[2]]);
    if (want == null || have == null || want !== have)
      badLen.push(`${c[2]}: asks ${c[1].trim()} into [${arrSize[c[2]]}]`);
  }
  ok(`WINDOW: every pairHexToBytes call asks for exactly its destination's size ${badLen.length ? "[" + badLen.join(", ") + "]" : ""}`,
    badLen.length === 0);
  ok("WINDOW: the peer PUBLIC KEY is parsed as 32 bytes",
    hexCalls.some((c) => resolve(c[1]) === 32 && /pub/i.test(c[2])));

  // The same rule on the other fixed-length thing off the radio: the proof is
  // compared over its whole 32 hex characters - its buffer's size less the NUL -
  // and the length refused before the compare is that same number, so the two
  // cannot drift apart.
  const ctCall = /pairCtEq\s*\(\s*[^,]+,\s*(pair[A-Za-z0-9_]*)\s*,\s*([0-9A-Za-z_]+)\s*\)/.exec(okBody);
  const lenCheck = /\.length\(\)\s*!=\s*(\d+)/.exec(okBody);
  ok("WINDOW: the proof compare covers its whole buffer less the terminator",
    ctCall != null && resolve(ctCall[2]) != null &&
    resolve(ctCall[2]) === resolve(arrSize[ctCall[1]]) - 1);
  ok("WINDOW: the length refused before that compare is the same number",
    ctCall != null && lenCheck != null && Number(lenCheck[1]) === resolve(ctCall[2]));

  // Order, not mere presence: a validation that runs after the derivation has
  // already spent the attacker's bytes.
  const before = (body, a, b) => {
    const ia = body.indexOf(a), ib = body.indexOf(b);
    return ia >= 0 && ib >= 0 && ia < ib;
  };
  ok("WINDOW: PAIRREQ validates the hostId BEFORE it derives anything",
    before(reqBody, "pairHostIdOk", "pairDeriveAll"));
  ok("WINDOW: PAIRREQ validates the peer public key BEFORE it derives anything",
    before(reqBody, "pairHexToBytes", "pairDeriveAll"));
  // "before generating any key" is the brief's own wording, and esp_fill_random
  // is the first byte of key material that exists.
  ok("WINDOW: a FULL pairing store is refused before any key material exists",
    before(reqBody, "pairHasRoomFor", "esp_fill_random") && /"full"/.test(reqBody));
  ok("WINDOW: the store is re-checked at COMMIT too, so upsertHost can never recycle a slot",
    /pairHasRoomFor/.test(commitBody) && /"full"/.test(commitBody));
  ok("WINDOW: the label is sanitised rather than stored as it arrived",
    /pairSanitiseLabel/.test(reqBody));
  ok("WINDOW: a second PAIRREQ wipes the pending exchange before storing a new one",
    before(reqBody, "pairWipe", "esp_fill_random"));

  // The one comparison in this whole task that a timing attack can reach.
  ok("WINDOW: PAIROK compares the proof with pairCtEq", /pairCtEq\s*\(/.test(okBody));

  // =========================================================================
  // THE COMMIT GATE - the single most important assertion in this feature.
  //
  // The first design committed on a valid proof ALONE, and that was broken:
  // proof = HMAC(key, "deckhand-pairok/1") where key derives from the ECDH
  // shared secret and nothing else, so ANY peer that completes the exchange can
  // compute it WITHOUT EVER SEEING THE DISPLAYED CODE. A racing attacker
  // answers the window the instant the user taps PAIR NEW MAC and is stored in
  // milliseconds; the code was decorative from the device's point of view.
  //
  // What holds the whole design up now is that BOTH a valid proof AND a CONFIRM
  // on the glass are required, in either order - so that is what is asserted,
  // by PARSING the guard's operands rather than by matching a spelling.
  // =========================================================================
  const gate = /if\s*\(\s*!\s*([A-Za-z_]\w*)\s*\|\|\s*!\s*([A-Za-z_]\w*)\s*\)\s*return\s*;/.exec(commitBody);
  const gateOperands = gate ? [gate[1], gate[2]].sort().join(" + ") : "(no guard found)";
  ok(`COMMIT: the store is gated on BOTH the proof and the on-glass confirm [${gateOperands}]`,
    gateOperands === "pairConfirmed + pairProofOk");
  ok("COMMIT: that gate runs BEFORE anything is stored",
    gate != null && commitBody.indexOf(upsertName) > 0 &&
    commitBody.indexOf(gate[0]) < commitBody.indexOf(upsertName));
  ok("COMMIT: a valid proof alone stores nothing and answers no PAIRDONE",
    !new RegExp(`\\b${upsertName}\\s*\\(`).test(okBody) && !/PAIRDONE/.test(okBody) &&
    /pairProofOk\s*=\s*true/.test(okBody));
  const stores = (block.match(new RegExp(`(^|[^\\w])${upsertName}\\s*\\(`, "g")) || []).length;
  const storesInCommit = (commitBody.match(new RegExp(`(^|[^\\w])${upsertName}\\s*\\(`, "g")) || []).length;
  ok("COMMIT: pairCommitIfReady is the ONLY thing in the pairing block that stores a key",
    stores === 1 && storesInCommit === 1);
  ok("COMMIT: both halves lead to the commit, so whichever lands second is the one that stores",
    /pairCommitIfReady\s*\(\s*\)/.test(okBody) && /pairCommitIfReady\s*\(\s*\)/.test(confirmBody));

  // pairConfirm() must be inert with nothing pending: there is nothing to
  // confirm before a PAIRREQ has arrived and a code is on the screen, and a flag
  // set early is a flag still set when the NEXT peer's request lands.
  ok("COMMIT: pairConfirm refuses before it sets the flag when nothing is pending",
    /if\s*\(\s*!\s*pairConfirmable\s*\(\s*\)\s*\)\s*\{[^}]*return;[^}]*\}/.test(confirmBody) &&
    confirmBody.indexOf("pairConfirmable") < confirmBody.indexOf("pairConfirmed = true"));
  // ONE predicate, read by the commit path and (in task 3) by the button's draw
  // site and its hit test. This codebase's classic defect is a control drawn
  // under one condition and hit-tested under another, so a second spelling of
  // the condition is the thing to forbid - not merely to avoid.
  ok("COMMIT: 'is there anything to confirm' is ONE predicate, not two that could disagree",
    /pairWindowOpen\s*\(\s*\)\s*&&\s*pairPending/.test(confirmableBody) &&
    ![confirmBody, commitBody].some((b) => /pairPending|pairWindowOpen/.test(b)));

  // Both commit halves must die with the exchange they belonged to, or a confirm
  // aimed at one peer commits the next one's key. PARSED from the declarations,
  // like the char/uint8_t fields below, so a flag added later is covered.
  const pairFlags = [];
  for (const m of block.matchAll(/^\s*bool\s+(pair[A-Za-z0-9_]*)\s*=/gm))
    if (!pairFlags.includes(m[1])) pairFlags.push(m[1]);
  ok(`COMMIT: the exchange's flags are found [${pairFlags.join(", ")}]`, pairFlags.length >= 3);
  for (const f of pairFlags)
    ok(`COMMIT: pairWipe clears ${f}`, new RegExp(`${f}\\s*=\\s*false`).test(wipeBody));

  // The derived key's temporary String was `upsertHost(id, String(pairKeyHex),
  // label)` - a heap copy of the 128-bit key dropped at the end of the
  // statement, and free() does not clear. Named, then wiped while the pointer is
  // still ours.
  const keyStr = /String\s+([A-Za-z_]\w*)\s*\(\s*pairKeyHex\s*\)/.exec(commitBody);
  ok("COMMIT: the key's String copy is named rather than a temporary", keyStr != null);
  ok("COMMIT: and it is zeroized before it goes out of scope and is freed",
    keyStr != null &&
    new RegExp(`mbedtls_platform_zeroize\\(\\s*\\(void\\*\\)\\s*${keyStr[1]}\\.c_str\\(\\)`).test(commitBody));

  // ---- the audit trail ----
  // "PROVISION:" is this repo's ONLY marker that a key arrived over the CABLE,
  // i.e. that a person was holding the device with a USB lead in it. A radio
  // pairing printing it forges that, in the exact property this feature rests on.
  const upBody = fnBody(code, upsertName) || "";
  ok("AUDIT: the wireless commit logs its OWN marker, not the cable's PROVISION:",
    /pairRadioCommit/.test(upBody) && /WIRELESS PAIR/.test(upBody) &&
    upBody.indexOf("WIRELESS PAIR") < upBody.indexOf("PROVISION:"));
  ok("AUDIT: that marker is behind BOARD_HAS_WIRELESS_PAIR, so board 1's arm is unchanged",
    /#if BOARD_HAS_WIRELESS_PAIR[\s\S]*WIRELESS PAIR[\s\S]*#endif[\s\S]*PROVISION:/.test(upBody));
  ok("AUDIT: the radio path is what raises the flag, around the store itself",
    /pairRadioCommit\s*=\s*true/.test(commitBody) && /pairRadioCommit\s*=\s*false/.test(commitBody) &&
    commitBody.indexOf("pairRadioCommit = true") < commitBody.indexOf(upsertName));

  // ---- two smaller rules over attacker-supplied text ----
  // The hostId becomes an NVS key and findHost() compares it with strcmp, while
  // pairHostIdOk accepts A-F as well as a-f: without normalising, C532AB01 and
  // c532ab01 are two of the four slots for one Mac.
  ok("WINDOW: the hostId is normalised to lowercase before it is used as a key",
    /\.toLowerCase\s*\(\s*\)/.test(reqBody) &&
    before(reqBody, "pairHostIdOk", "toLowerCase") &&
    before(reqBody, "toLowerCase", "pairHasRoomFor"));
  // The label writer's terminator: `w + 1 < outSize` is correct and is one
  // character from `w < outSize`, which puts the NUL one past the end.
  ok("WINDOW: the label writer reserves the terminator's byte by name",
    /\bcap\s*=\s*outSize\s*-\s*1\b/.test(labelBody) && /w\s*<\s*cap\b/.test(labelBody) &&
    !/w\s*(\+\s*\d+\s*)?<\s*outSize\b/.test(labelBody));
  ok("WINDOW: ... refuses a zero-sized buffer, which is what makes outSize - 1 safe",
    /outSize\s*==\s*0\s*\)\s*return/.test(labelBody));
  ok("WINDOW: ... and always NUL-terminates", /out\[w\]\s*=\s*0;/.test(labelBody));

  // Refusing with a LOGGED, NAMED reason: from the Mac, "not in pairing mode"
  // and "not there" look identical, which is the rule POWERPROBE's refusal
  // exists for.
  for (const [n, b] of [["PAIRREQ", reqBody], ["PAIROK", okBody], ["PAIRCANCEL", cancelBody]]) {
    ok(`WINDOW: ${n} refuses when the window is closed, and says so`,
      /pairWindowOpen\s*\(\s*\)/.test(b) && /pairFail\s*\(/.test(b));
  }

  // PARSED, not transcribed: the fields are read out of their own declarations,
  // so a field added later is covered by default rather than by memory.
  const pairFields = [];
  for (const m of block.matchAll(/^\s*(?:char|uint8_t)\s+(pair[A-Za-z0-9_]*)\s*\[/gm)) {
    if (!pairFields.includes(m[1])) pairFields.push(m[1]);
  }
  ok(`WINDOW: the pending exchange's fields are found [${pairFields.join(", ")}]`,
    pairFields.length >= 6);
  for (const f of pairFields) {
    ok(`WINDOW: pairWipe zeroizes ${f}`,
      new RegExp(`mbedtls_platform_zeroize\\(\\s*${f}\\b`).test(wipeBody));
  }
  ok("WINDOW: pairClose WIPES rather than merely marking the window shut",
    /pairWipe\s*\(\s*\)/.test(closeBody) && /pairWindowUntil\s*=\s*0/.test(closeBody));
  ok("WINDOW: pairClose names the reason in the log",
    /Serial\.printf/.test(closeBody) && /why/.test(closeBody));
  // BOUND TO pairWindowOpen'S OWN BODY, not to the file. The old assertion ran
  // the regex over the whole block, and pairTick() carries a copy of the same
  // expression - so REPLACING pairWindowOpen's body with `return true;`, i.e.
  // deleting the entire presence guarantee this feature rests on, passed every
  // assertion here. Same shape as the "pairCtEq is defined but never called"
  // hole one section up, and the same fix: bind the claim to the function that
  // has to make it.
  ok("WINDOW: pairWindowOpen itself tests the deadline, as a SIGNED difference",
    /\(long\)\s*\(\s*millis\(\)\s*-\s*pairWindowUntil\s*\)\s*<\s*0/.test(winBody) &&
    /pairWindowUntil\s*!=\s*0/.test(winBody));
  ok("WINDOW: pairTick's own timeout uses the same signed comparison",
    /\(long\)\s*\(\s*millis\(\)\s*-\s*pairWindowUntil\s*\)/.test(fnBody(block, "pairTick") || ""));

  // The trailing address every device->host line already uses, so the OTHER
  // paired Mac drops these instead of logging a failure it had no part in.
  ok("WINDOW: pairReply appends the trailing to=<hostId> address",
    /\bto=%s/.test(replyBody) && /snprintf/.test(replyBody));
  ok("WINDOW: PAIRDONE goes out addressed",
    /"PAIRDONE %s"/.test(commitBody) && /pairReply/.test(commitBody));
  ok("WINDOW: every PAIRFAIL goes out addressed through the same helper",
    /"PAIRFAIL %s"/.test(fnBody(block, "pairFail") || "") &&
    /pairReply/.test(fnBody(block, "pairFail") || ""));

  // THE SECRET IS NEVER TRANSMITTED - the Critical constraint, as a rule over
  // the source rather than a promise. One debugging printf would put the
  // 128-bit key on the very link this design exists to keep it off, and the six
  // digits on the wire would let a Mac skip the human the window exists for.
  const SECRET_FIELDS = ["pairKeyHex", "pairProofWant", "pairPriv", "pairCodeDigits"];
  const OUTBOUND = /Serial\.print|sendLineToHost|snprintf|sprintf/;
  const leaks = [];
  for (const line of block.split("\n")) {
    if (SECRET_FIELDS.some((f) => line.includes(f)) && OUTBOUND.test(line)) leaks.push(line.trim());
  }
  ok(`WINDOW: no secret-bearing field reaches Serial or the wire ${leaks.length ? "[" + leaks.join(" | ") + "]" : ""}`,
    leaks.length === 0);

  // The close SITES, in the files that own the events. A window that outlives
  // the screen showing its code is the one state that weakens the presence
  // guarantee the whole design rests on.
  ok("WINDOW: switchTab closes the window",
    /pairClose\s*\(/.test(fnBody(mainCode, "switchTab") || ""));
  ok("WINDOW: loop() ticks the timeout",
    /pairTick\s*\(\s*\)/.test(fnBody(mainCode, "loop") || ""));
  ok("WINDOW: the backlight blank closes the window",
    /pairClose\s*\(/.test(fnBody(powerCode, "enterSleep") || ""));
  ok("WINDOW: deep sleep closes the window",
    /pairClose\s*\(/.test(fnBody(powerCode, "enterDeepSleep") || ""));
  ok("WINDOW: the three wire verbs are dispatched",
    /"PAIRREQ /.test(mainCode) && /"PAIROK /.test(mainCode) && /"PAIRCANCEL"/.test(mainCode));
  ok("WINDOW: every close site and the dispatch sit behind BOARD_HAS_WIRELESS_PAIR",
    (mainCode.match(/#if BOARD_HAS_WIRELESS_PAIR/g) || []).length >= 3 &&
    (powerCode.match(/#if BOARD_HAS_WIRELESS_PAIR/g) || []).length >= 2);

  // =========================================================================
  // THE TAP IS BOUND TO THE PAINT, NOT ONLY TO THE PREDICATE.
  //
  // pairConfirmable() being ONE predicate (asserted above) makes the draw site and
  // the hit test agree about WHETHER there is anything to confirm. It says nothing
  // about WHEN the glass caught up - and that is the binding the whole design rests
  // on, because the user is confirming THE CODE THEY COMPARED. handlePairReq sets
  // pairPending, which makes CONFIRM live at once; PAIRREQ arrives through
  // processCompletedLine(), never handleLine(), so the panel's absorb does not fire
  // and nothing repainted until tickPairPanel()'s 500ms tick. For up to half a
  // second CONFIRM was tappable while the screen still read "waiting for a Mac".
  //
  // A text checker cannot watch a pixel, so what is asserted is the ORDER, as
  // ADJACENCY: the paint is the statement IMMEDIATELY after the flag, with nothing -
  // least of all a return - able to come between. Shortening the tick would not
  // satisfy this, deliberately: "usually fast enough" is not the guarantee.
  const reqStmts = reqBody
    .split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const iFlag = reqStmts.indexOf("pairPending = true;");
  ok("CONFIRM: handlePairReq raises pairPending, which is what makes CONFIRM live",
    iFlag >= 0);
  ok("CONFIRM: the panel is repainted in the SAME statement immediately after it, so the " +
     "code is on the glass before CONFIRM can be tapped",
    iFlag >= 0 && /^renderPairPanel\s*\(\s*\)\s*;/.test(reqStmts[iFlag + 1] || ""));
  ok("CONFIRM: ... and handlePairReq cannot return between the two",
    iFlag >= 0 && !/\breturn\b/.test(reqStmts[iFlag + 1] || ""));

  // =========================================================================
  // THE PANEL IS A FULL-SCREEN SURFACE, AND EVERY REFUSAL LIST HAS TO KNOW IT.
  //
  // It was in NONE of the five. Two of those lists gate commands reachable from an
  // UNAUTHENTICATED radio (EMOJITEST, READTEST), so either one painted over the
  // panel WITHOUT calling pairClose(): the window stays open and CONFIRM stays
  // tappable under a screen that shows neither. The lists live in shared functions,
  // so each term sits inside its own #if BOARD_HAS_WIRELESS_PAIR - which is also
  // why they cannot be asserted as one condition and are named one at a time.
  const guards = [
    ["tickAutoTheme", fnBody(mainCode, "tickAutoTheme"), "a palette switch would repaint over the code"],
    ["tickWorkingSpinner", fnBody(mainCode, "tickWorkingSpinner"), "a spark would blit onto the panel"],
    ["tickSessionAnim", fnBody(sessionsCode, "tickSessionAnim"), "a shimmer would run down the rows under it"],
    ["detailBandVisible", fnBody(sessionsCode, "detailBandVisible"), "the band would animate over it"],
  ];
  for (const [name, body, why] of guards)
    ok(`SURFACE: ${name} refuses while the pairing panel owns the glass (${why})`,
      body != null && /\bpairPanelActive\b/.test(body));
  // The two radio-reachable ones are in processCompletedLine's dispatch rather than
  // in a function of their own, so they are read as the refusal each one prints.
  // SCOPED TO EACH COMMAND'S OWN BRANCH, never a fixed look-back: with a 900-char
  // window READTEST's term sat inside EMOJITEST's, so deleting EMOJITEST's guard
  // left its assertion satisfied by its neighbour's - a rule that can be met by a
  // nearby line is not a rule, which is the hole the pairCtEq assertion already
  // taught this file once.
  for (const cmd of ["READTEST", "EMOJITEST"]) {
    const from = mainCode.indexOf(`buf.startsWith("${cmd}")`);
    const to = mainCode.indexOf(`"${cmd} refused: another full-screen surface is up"`);
    ok(`SURFACE: ${cmd} refuses while the pairing panel owns the glass`,
      from > 0 && to > from && /\bpairPanelActive\b/.test(mainCode.slice(from, to)));
  }
  // A window closed while the panel is left up is the two disagreeing: the new tab
  // is painted over it, while handleTouch still routes every tap to pairPanelTouch.
  ok("SURFACE: switchTab takes the PANEL down with the window, not just the window",
    /pairPanelActive\s*=\s*false/.test(fnBody(mainCode, "switchTab") || ""));

  ok("SOURCE: the whole path is behind BOARD_HAS_WIRELESS_PAIR",
    /#if\s+BOARD_HAS_WIRELESS_PAIR/.test(code));

  // Board 1 must gain the flag and nothing else - the flag alone emits no code.
  ok("SOURCE: board 1 declares BOARD_HAS_WIRELESS_PAIR 0",
    /^#define BOARD_HAS_WIRELESS_PAIR\s+0\b/m.test(b1));
  ok("SOURCE: board 2 declares BOARD_HAS_WIRELESS_PAIR 1",
    /^#define BOARD_HAS_WIRELESS_PAIR\s+1\b/m.test(b2));
  // PARSED out of the board header rather than transcribed here, the rule the
  // geometry checkers pay for repeatedly. Board 1 must NOT declare it: an alias
  // for a window that board never opens is a name that looks right and means
  // nothing, which is exactly what board_es3c35p.h's own comment refuses.
  const winM = b2.match(/^const int PAIR_WINDOW_MS\s*=\s*(\d+);/m);
  ok("WINDOW: board 2 declares PAIR_WINDOW_MS and it is 120s",
    winM != null && Number(winM[1]) === 120000);
  ok("WINDOW: board 1 declares none of the pairing-window constants",
    !/PAIR_WINDOW_MS|PAIR_LABEL_BYTES|PAIR_HOSTID_CHARS/.test(b1));
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

  // -------------------------------------------------------------------------
  // SOURCE FAULTS. The module faults above mutate the Mac's half; these mutate
  // a COPY of pairing.ino in memory and re-run the source suite against it, so
  // the assertions that guard the device are proven the same way. The first
  // two are verbatim the injections a reviewer used to show that the old
  // "compared in constant time" assertion caught nothing.
  // -------------------------------------------------------------------------
  const CT_ANCHOR = "bool pairCtEq(const char* a";
  const realSrc = fs.readFileSync(PAIRING_INO, "utf8");
  const realMain = fs.readFileSync(MAIN_INO, "utf8");
  const realPower = fs.readFileSync(POWER_INO, "utf8");
  const realSessions = fs.readFileSync(SESSIONS_INO, "utf8");
  const inject = (fn) => ({ pairing: realSrc.replace(CT_ANCHOR, `${fn}\n${CT_ANCHOR}`) });
  const P = (from, to) => ({ pairing: realSrc.replace(from, to) });
  const sourceFaults = [
    ["a proof compare using strcmp is added beside pairCtEq (reviewer's injection 1)",
      inject("bool pairVerifyProof(const char* got, const char* want) { return strcmp(got, want) == 0; }")],
    ["a proof compare using memcmp is added beside pairCtEq (reviewer's injection 2)",
      inject("bool pairVerifyProof(const uint8_t* got, const uint8_t* want) { return memcmp(got, want, 16) == 0; }")],
    ["a key compare using == is added (no compare FUNCTION, so only the operand rule sees it)",
      inject("bool pairKeyEq(const uint8_t* key, const uint8_t* want) { return key == want; }")],
    // BOTH call sites, because task 2 added one: with only the PAIRVECTOR site
    // removed the "pairCtEq is CALLED" assertion would still pass, and a fault
    // a checker no longer notices is worse than a fault it never covered.
    ["every pairCtEq call site is removed, leaving the definition standing",
      P("pairCtEq((const char*) s1, (const char*) s2, 32)", "true").pairing
        .replace("!pairCtEq(got.c_str(), pairProofWant, 32)", "false")],
    ["one zeroize is dropped from pairDeriveAll",
      P("  mbedtls_platform_zeroize(key, sizeof(key));\n", "")],
    ["the device's two HKDF info strings collapse to one",
      P('#define PAIR_KEY_INFO   "deckhand-key/1"',
        '#define PAIR_KEY_INFO   "deckhand-sas/1"')],

    // ---- Task 2: the window, the handlers and the storage ----
    ["the hex parser stops enforcing the length (the uint8_t[32] hole)",
      P("  if (strlen(s) != nBytes * 2) return false;\n", "")],
    ["PAIRREQ stops validating the hostId before using it",
      P('  if (!pairHostIdOk(id.c_str())) { pairFail("badhost", NULL); return; }\n', "")],
    ["a FULL pairing store is only noticed AFTER the keypair is generated",
      P('  if (!pairHasRoomFor(id.c_str())) { pairFail("full", id.c_str()); return; }\n\n  pairWipe();',
        "  pairWipe();")],
    ["PAIROK compares the proof with strcmp instead of pairCtEq",
      P("!pairCtEq(got.c_str(), pairProofWant, 32)", "strcmp(got.c_str(), pairProofWant) != 0")],
    ["one field is dropped from pairWipe",
      P("  mbedtls_platform_zeroize(pairKeyHex, sizeof(pairKeyHex));\n", "")],
    ["pairClose marks the window shut without wiping the exchange",
      P("  pairWipe();\n  if (wasOpen) Serial.printf", "  if (wasOpen) Serial.printf")],
    ["PAIRDONE/PAIRFAIL stop carrying the to=<hostId> address",
      P('snprintf(out, sizeof(out), "%s to=%s", line, hostId);',
        "strlcpy(out, line, sizeof(out));")],
    ["a debugging printf puts the derived 128-bit key on the wire",
      P('  Serial.printf("PAIR: -> PAIRFAIL %s\\n", reason);',
        '  Serial.printf("PAIR: -> PAIRFAIL %s key=%s\\n", reason, pairKeyHex);')],
    ["PAIROK stops refusing a closed window",
      P('  if (!pairWindowOpen()) { pairFail("closed", NULL); return; }\n  if (!pairPending)',
        "  if (!pairPending)")],
    ["a tab switch no longer closes the window",
      { main: realMain.replace('  pairClose("tab switch");\n', "") }],
    ["loop() stops ticking the 120s timeout",
      { main: realMain.replace("  pairTick();", "  //pairTick();") }],
    ["the backlight blank no longer closes the window",
      { power: realPower.replace('  pairClose("screen blanked");\n', "") }],
    ["deep sleep no longer closes the window",
      { power: realPower.replace('  pairClose("powering off");\n', "") }],

    // ---- the fix round: the commit gate, and the rules around it ----
    // THIS IS THE ONE THAT MATTERS. The shipped design committed on a valid
    // proof alone, which any peer completing the ECDH can produce without ever
    // having seen the code - so deleting the confirm half of the gate IS the
    // flaw, and it has to fail by name rather than by something noticing later.
    ["the commit runs on a valid proof ALONE (the flaw this redesign exists for)",
      P("  if (!pairProofOk || !pairConfirmed) return;", "  if (!pairProofOk) return;")],
    ["PAIROK stores the key itself the moment the proof verifies",
      P("  pairProofOk = true;",
        "  pairProofOk = true;\n  upsertHost(pairHostId, String(pairKeyHex), pairLabel);")],
    ["pairConfirm sets the confirm flag with no request pending",
      P('  if (!pairConfirmable()) {\n    Serial.println("PAIR: CONFIRM ignored - no request is pending");\n    return;\n  }\n', "")],
    ["pairWipe stops clearing the confirm flag, so a tap outlives its own exchange",
      P("  pairConfirmed = false;\n", "")],
    // The reviewer's own measurement: replacing this body with `return true;`
    // deletes the entire presence guarantee and passed all 70 assertions,
    // because pairTick carries a copy of the same expression.
    ["pairWindowOpen's body becomes `return true;` (the presence guarantee, deleted)",
      P("  return pairWindowUntil != 0 && (long) (millis() - pairWindowUntil) < 0;",
        "  return true;")],
    ["the hex parser's CALL SITE asks for 31 bytes into a 32-byte buffer",
      P("pairHexToBytes(pubHex.c_str(), 32, pubA)", "pairHexToBytes(pubHex.c_str(), 31, pubA)")],
    ["the proof compare's length is one short of the 32 hex characters",
      P("pairCtEq(got.c_str(), pairProofWant, 32)", "pairCtEq(got.c_str(), pairProofWant, 31)")],
    ["the label writer stops reserving the terminator's byte",
      P("&& w < cap; p++", "&& w < outSize; p++")],
    ["the hostId is stored as it arrived, so C532AB01 and c532ab01 take two slots",
      P("  id.toLowerCase();\n", "")],
    ["the derived key's String copy goes back to being an unwiped temporary",
      P([
        "  String secret(pairKeyHex);",
        "  pairRadioCommit = true;",
        "  upsertHost(id, secret, label);",
        "  pairRadioCommit = false;",
        "  mbedtls_platform_zeroize((void*) secret.c_str(), secret.length());",
      ].join("\n"), "  upsertHost(id, String(pairKeyHex), label);")],
    // ---- this fix round: the tap was bound to the PREDICATE, not to the PAINT ----
    // THE ONE THAT MATTERS HERE. Reverting the reconcile leaves CONFIRM tappable for
    // up to tickPairPanel()'s 500ms while the glass still reads "waiting for a Mac" -
    // a tap that commits a code nobody could have compared, which is the whole
    // property the CONFIRM button exists to carry.
    ["the panel is no longer repainted when PAIRREQ makes CONFIRM live (the 500ms hole)",
      P("  renderPairPanel();   // no-op unless the pairing panel owns the glass\n", "")],
    // The plausible WRONG fix, named so it fails too: making the tick quicker shrinks
    // the window instead of removing it, and the guarantee is the order.
    ["the reconcile is moved AFTER the PAIRPUB reply instead of beside the flag",
      P("  renderPairPanel();   // no-op unless the pairing panel owns the glass\n\n  char hexbuf[65], line[80];",
        "  char hexbuf[65], line[80];")
        .pairing.replace("  sendLineToHost(line);",
                         "  sendLineToHost(line);\n  renderPairPanel();")],
    // ---- and the panel as a full-screen surface ----
    ["EMOJITEST paints over the pairing panel and leaves CONFIRM live underneath",
      { main: realMain.replace(
          "    if (pairPanelActive) {\n      Serial.println(\"EMOJITEST refused: another full-screen surface is up\");\n      return;\n    }\n#endif\n", "") }],
    ["READTEST does the same",
      { main: realMain.replace(
          "    if (pairPanelActive) {\n      Serial.println(\"READTEST refused: another full-screen surface is up\");\n      return;\n    }\n#endif\n", "") }],
    ["a tab switch shuts the window but leaves the panel up, so taps still reach CONFIRM",
      { main: realMain.replace("  pairPanelActive = false;\n#endif\n#if !BOARD_USES_TFT_ESPI", "#endif\n#if !BOARD_USES_TFT_ESPI") }],
    ["the session shimmer runs down the rows underneath the pairing panel",
      { sessions: realSessions.replace("  if (pairPanelActive) { xfadeId[0] = '\\0'; return; }\n#endif\n", "") }],
    ["the working spinner blits over the pairing panel",
      { main: realMain.replace("  if (pairPanelActive) return;\n#endif\n  if (isAsleep || octoActive || showingDetail", "  if (isAsleep || octoActive || showingDetail") }],
    ["AUTO theme repaints the whole screen over a code being compared",
      { main: realMain.replace(
          "  if (pairPanelActive) return;\n#endif\n  if (isAsleep || octoActive || readerActive",
          "  if (isAsleep || octoActive || readerActive") }],
    ["the detail band animates over the pairing panel",
      { sessions: realSessions.replace("  if (pairPanelActive) return false;\n#endif\n", "") }],

    ["a radio pairing logs PROVISION:, forging the cable's own audit marker",
      P('Serial.printf("WIRELESS PAIR: pairing stored for %s (%s), slot %d of %d"',
        'Serial.printf("PROVISION: pairing stored for %s (%s), slot %d of %d"')],
  ];

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
  let srcCaught = 0;
  for (const [name, mut] of sourceFaults) {
    // A fault whose anchor has MOVED applies nothing and would then be reported
    // as caught by whatever else happens to fail - so an unapplied injection is
    // named as a miss rather than counted.
    const over = typeof mut === "string" ? { pairing: mut } : mut;
    const unchanged =
      (over.pairing == null || over.pairing === realSrc) &&
      (over.main == null || over.main === realMain) &&
      (over.power == null || over.power === realPower) &&
      (over.sessions == null || over.sessions === realSessions);
    if (unchanged) {
      console.log(`  MISSED  ${name}  <- the injection did not apply (anchor moved)`);
      continue;
    }
    const fails = [];
    const okf = (n, cond) => { if (!cond) fails.push(n); };
    try { sourceSuite(okf, over); } catch (e) { fails.push(`THREW: ${e.message}`); }
    if (fails.length) {
      srcCaught++;
      console.log(`  caught  ${name}`);
      console.log(`            by: ${fails[0]}${fails.length > 1 ? ` (+${fails.length - 1} more)` : ""}`);
    } else {
      console.log(`  MISSED  ${name}  <- no assertion notices this`);
    }
  }

  const all = caught === faults.length && srcCaught === sourceFaults.length;
  console.log(`\nselftest: ${caught}/${faults.length} module faults caught, ` +
              `${srcCaught}/${sourceFaults.length} source faults caught`);
  process.exit(all ? 0 : 1);
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
