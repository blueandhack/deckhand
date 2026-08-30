// Wireless pairing: the derivations, both sides of which must agree BYTE FOR
// BYTE with firmware/deckhand_display/pairing.ino or pairing fails in a way
// that looks like a UI bug five screens later.
//
// Pure functions, no I/O and no clock - the same reason capUtf8 and
// run-ledger.mjs live in their own modules: so they can be tested without a
// device, and so the one place that decides these bytes is the one place a
// checker reads.
//
// THE DERIVATIONS, pinned here and mirrored in pairing.ino:
//
//   shared = X25519(priv, peerPub)                 32 bytes, raw little-endian
//                                                  per RFC 7748
//   salt   = pubA || pubB                          64 bytes; A is ALWAYS the
//                                                  Mac's (initiator's) key
//   code   = HKDF-SHA256(ikm=shared, salt, info="deckhand-sas/1", len=4)
//            read as uint32 BIG-endian, % 1000000, zero-padded to 6 characters
//   key    = HKDF-SHA256(ikm=shared, salt, info="deckhand-key/1", len=16)
//   proof  = HMAC-SHA256(key, "deckhand-pairok/1"), first 16 bytes, lower hex
//
// THE SALT ORDER IS LOAD-BEARING AND IS NOT SYMMETRIC. Both ends compute
// pubA || pubB with A fixed by ROLE, not by "mine then theirs" - so the Mac
// concatenates its own key first and the device concatenates the PEER's key
// first. Swap it on one side and both sides still "work": each derives a
// self-consistent code and key, they simply differ, and the failure surfaces
// as a code the user types that is never accepted. pair-crypto-check.mjs
// asserts the swap produces a DIFFERENT key for exactly that reason.
//
// The "/1" suffixes are version markers. A future change to any derivation
// bumps them, so an old device and a new Mac fail cleanly at the code-compare
// step instead of silently deriving different keys and blaming the user.
import crypto from "node:crypto";

export const SAS_INFO = "deckhand-sas/1";
export const KEY_INFO = "deckhand-key/1";
export const PROOF_MSG = "deckhand-pairok/1";

export const PUB_BYTES = 32;
export const PRIV_BYTES = 32;
export const SHARED_BYTES = 32;
export const KEY_BYTES = 16;
export const PROOF_HEX_CHARS = 32;   // 16 bytes
export const CODE_DIGITS = 6;
export const CODE_MODULUS = 1000000; // 10 ** CODE_DIGITS

// Raw 32-byte X25519 keys are not something node's crypto imports directly, so
// they are wrapped in the fixed DER envelopes RFC 8410 defines. Both prefixes
// are constant for X25519 (OID 1.3.101.110) and 32-byte keys, which is why
// they can be literals rather than a DER encoder.
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function asBuf(v, n, what) {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v, typeof v === "string" ? "hex" : undefined);
  if (b.length !== n) throw new Error(`${what} must be ${n} bytes, got ${b.length}`);
  return b;
}

export function privateKeyObject(priv) {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, asBuf(priv, PRIV_BYTES, "private key")]),
    format: "der",
    type: "pkcs8",
  });
}

export function publicKeyObject(pub) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, asBuf(pub, PUB_BYTES, "public key")]),
    format: "der",
    type: "spki",
  });
}

// The raw 32-byte x coordinate out of a KeyObject. node refuses
// createPublicKey() on something that is ALREADY a public key ("Invalid key
// object type public, expected private"), so the type is tested rather than
// converted unconditionally - measured, not anticipated: the unconditional
// version worked for publicFromPrivate and threw inside generateKeypair.
function rawPublic(keyObject) {
  const pub = keyObject.type === "private" ? crypto.createPublicKey(keyObject) : keyObject;
  return Buffer.from(pub.export({ format: "jwk" }).x, "base64url");
}

// The Mac's ephemeral keypair for one pairing exchange. Ephemeral is the whole
// point: it is generated when the user picks a device and is discarded when the
// exchange ends, so there is no long-lived private key to steal and no forward
// secrecy to lose.
export function generateKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const priv = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  return { priv, pub: rawPublic(publicKey) };
}

export function publicFromPrivate(priv) {
  return rawPublic(privateKeyObject(priv));
}

// X25519. Raw little-endian 32 bytes in and out, per RFC 7748 - which is what
// node produces natively and what the device has to be made to agree with.
export function deriveShared(priv, peerPub) {
  return crypto.diffieHellman({
    privateKey: privateKeyObject(priv),
    publicKey: publicKeyObject(peerPub),
  });
}

// A is ALWAYS the initiator's (the Mac's) key. See the header note.
export function pairSalt(pubA, pubB) {
  return Buffer.concat([asBuf(pubA, PUB_BYTES, "pubA"), asBuf(pubB, PUB_BYTES, "pubB")]);
}

function hkdf(shared, salt, info, len) {
  // hkdfSync returns an ArrayBuffer, NOT a Buffer - Buffer.from on the raw
  // return would otherwise produce a one-element array of the object.
  return Buffer.from(crypto.hkdfSync("sha256", asBuf(shared, SHARED_BYTES, "shared"), salt, info, len));
}

// The six digits the user reads off the device's screen and types into the Mac.
// Read BIG-endian and taken modulo 10^6: the modulo is what makes it six
// digits, and the zero padding is what stops a value under 100000 rendering as
// five - a five-character code beside a six-character box reads as a bug, and
// a comparison against an unpadded string would reject a valid code.
export function deriveCode(shared, pubA, pubB) {
  const out = hkdf(shared, pairSalt(pubA, pubB), SAS_INFO, 4);
  return String(out.readUInt32BE(0) % CODE_MODULUS).padStart(CODE_DIGITS, "0");
}

// The 128-bit pairing secret. NEVER transmitted by either side - both ends
// derive it from the exchange, which is the entire security argument for
// replacing the cable.
export function deriveKey(shared, pubA, pubB) {
  return hkdf(shared, pairSalt(pubA, pubB), KEY_INFO, KEY_BYTES);
}

// What the Mac sends to prove it derived the same key, without sending the key.
// Forging it is a 128-bit problem; guessing the code is a 10^6 one, which is
// why the device is never sent a guess at the code.
export function pairProof(key) {
  return crypto
    .createHmac("sha256", asBuf(key, KEY_BYTES, "key"))
    .update(PROOF_MSG, "utf8")
    .digest("hex")
    .slice(0, PROOF_HEX_CHARS);
}

// Constant-time comparison for everything secret-derived. A byte-at-a-time
// `===` on a proof leaks how many leading bytes were right, which turns a
// 128-bit forgery into 16 one-byte searches; on the code it leaks the digits.
// Length is compared first and in the clear, deliberately: the length of both
// of these is fixed and public, so it carries nothing.
function ctEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function proofMatches(got, want) {
  return ctEqualStrings(got, want);
}

// The typed code against the one the Mac derived. This comparison happens
// ENTIRELY on the Mac - the device never receives a guess - so a typo costs no
// device interaction and there is no online guessing attack against the device.
export function codeMatches(typed, want) {
  return ctEqualStrings(typed, want);
}
