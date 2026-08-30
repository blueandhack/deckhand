// Pairing: per-Mac keys in NVS, and the HMAC that authenticates an answer.
// Split out of deckhand_display.ino. The Arduino build concatenates every .ino
// in this folder into ONE translation unit - main file first (it matches the
// folder name), then the rest alphabetically - so these still share every global
// and there are no headers. Verified before splitting: no function signature in
// this sketch names a type declared after the first function definition, which
// is what would break the auto-generated prototypes.

int findHost(const char* id) {
  if (!id || !*id) return -1;
  for (int i = 0; i < hostCount; i++) if (strcmp(hosts[i].id, id) == 0) return i;
  return -1;
}
// The key for ONE pairing slot. authHmac's implicit "whoever spoke last"
// (activeHost) is wrong as soon as two Macs are ticking - it would be right
// about half the time, and the symptom is an answer intermittently rejected
// with nothing visibly broken.
const String* secretForSlot(int slot) {
  if (slot < 0 || slot >= hostCount) return nullptr;
  if (allowedHost[0] && strcmp(hosts[slot].id, allowedHost) != 0) return nullptr;
  return &hosts[slot].secret;
}
// The key we may sign with right now: the active Mac's, unless the user has
// restricted answering to one specific Mac and this isn't it.
// DELIBERATELY KEPT WITH NO CALLERS, the way primaryLink() in audio.ino now
// is - not silently dead. Every real signing site moved to
// pairingSlotForRow(s.hostSlot) (the ROW's own Mac, not "whoever's active"),
// which is what multi-pairing needed; this is left as the pre-multi-pairing
// shape in case a genuine "sign with whatever the user currently has
// selected" need shows up again.
const String* activeSecret() { return secretForSlot(activeHost); }
bool isPaired() { return hostCount > 0; }
// A link (a Mac that is talking to us) and a pairing slot (a Mac whose key we
// hold) are different things: an unpaired Mac can send payloads, and a paired
// Mac can be absent. -1 means "we hold no key for that Mac", and authHmacFor
// then refuses to sign - the host rejects the unsigned answer, which is the
// safe direction.
int pairingSlotForLink(int link) {
  if (link < 0 || link >= MAX_LINKS || !hostLinks[link].used) return -1;
  return findHost(hostLinks[link].hostId);
}
// A row's hostSlot is only ever a valid link index (0..MAX_LINKS-1) once a
// payload carrying a real hostId has named one - see linkForHost()/isHexHostId().
// A host old enough to send no hostId at all (or, before this task, a garbled
// non-hex one) leaves it at SessionInfo's declared sentinel: hostSlot is a
// uint8_t and info.hostSlot = (uint8_t) curLink with curLink == -1 wraps to
// 255, which is deliberately >= MAX_LINKS so it can never alias a real slot.
// Falling back to activeHost here (the pre-multi-pairing behaviour authHmac()
// always used) is what keeps that host answerable at all - without it,
// pairingSlotForLink(255) always fails its bounds check, every answer signs
// as "0", and the host rejects every prompt from a Mac that never sends its
// own hostId. This cannot weaken the two-Mac case: there, hostSlot is always
// a real link index and this function is a no-op pass-through to it.
int pairingSlotForRow(int hostSlot) {
  if (hostSlot < 0 || hostSlot >= MAX_LINKS) return activeHost;
  return pairingSlotForLink(hostSlot);
}
// First 8 bytes of SHA-256, hex - the same 16-character form the host's voiceSha
// produces, so both sides hash the same way. The voice path never needed this:
// the host sent the hash of the transcript IT held. Typed text exists only on the
// device until it is sent, so the device has to hash it.
String sha256Hex16(const char* s) {
  uint8_t out[32];
  mbedtls_sha256((const unsigned char*) s, strlen(s), out, 0);  // 0 = SHA-256, not 224
  char hex[17];
  for (int i = 0; i < 8; i++) sprintf(hex + i * 2, "%02x", out[i]);
  return String(hex);
}
// HMAC-SHA256(secret, msg), first 16 hex chars. Matches the host's
// crypto.createHmac('sha256', secret).update(msg).digest('hex').slice(0,16).
// Takes an explicit pairing slot rather than reading activeHost, because
// activeHost means "whoever sent the most recent payload" - fine with one
// Mac, wrong about half the time with two. Every caller that owns a
// SessionInfo signs with pairingSlotForRow(s.hostSlot) instead.
String authHmacFor(int slot, const String& msg) {
  const String* key = secretForSlot(slot);
  if (!key || key->length() == 0) return String("");
  const String& pairingSecret = *key;
  uint8_t out[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, info, 1); // 1 = HMAC mode
  mbedtls_md_hmac_starts(&ctx, (const uint8_t*) pairingSecret.c_str(), pairingSecret.length());
  mbedtls_md_hmac_update(&ctx, (const uint8_t*) msg.c_str(), msg.length());
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
  char hex[17];
  for (int i = 0; i < 8; i++) sprintf(hex + i * 2, "%02x", out[i]);
  return String(hex);
}
// Kept for any caller that hasn't been given a slot yet (there are none left
// in this sketch, but the signature - and the "whoever's active" meaning -
// stays available rather than removed out from under a future one).
String authHmac(const String& msg) { return authHmacFor(activeHost, msg); }
// ---------- Paired-Mac slots in NVS ----------
// One slot per remembered Mac: h<i>id / h<i>sec / h<i>lb (NVS keys must stay
// under 16 chars). "hallow" is the optional "only this Mac may answer" pin.
// The legacy single-secret key "blesecret" is migrated into slot 0 on boot so
// an already-paired unit keeps working after the firmware update.
void saveHostSlot(int i) {
  char k[8];
  snprintf(k, sizeof(k), "h%did", i);  prefs.putString(k, hosts[i].id);
  snprintf(k, sizeof(k), "h%dsec", i); prefs.putString(k, hosts[i].secret);
  snprintf(k, sizeof(k), "h%dlb", i);  prefs.putString(k, hosts[i].label);
}
void saveHostCount()  { prefs.putInt("hcount", hostCount); }
void saveAllowedHost(){ prefs.putString("hallow", allowedHost); }
void loadHostPairings() {
  hostCount = constrain(prefs.getInt("hcount", 0), 0, MAX_HOSTS);
  for (int i = 0; i < hostCount; i++) {
    char k[8];
    snprintf(k, sizeof(k), "h%did", i);
    strlcpy(hosts[i].id, prefs.getString(k, "").c_str(), sizeof(hosts[i].id));
    snprintf(k, sizeof(k), "h%dsec", i); hosts[i].secret = prefs.getString(k, "");
    snprintf(k, sizeof(k), "h%dlb", i);
    strlcpy(hosts[i].label, prefs.getString(k, "").c_str(), sizeof(hosts[i].label));
  }
  // Drop any slot that didn't survive intact, so a half-written entry can't
  // masquerade as a valid pairing.
  int w = 0;
  for (int i = 0; i < hostCount; i++)
    if (hosts[i].id[0] && hosts[i].secret.length() >= 8) { if (w != i) hosts[w] = hosts[i]; w++; }
  if (w != hostCount) { hostCount = w; saveHostCount(); }

  // ---- migrate the old single-secret pairing into slot 0 ----
  if (hostCount == 0) {
    String legacy = prefs.getString("blesecret", "");
    if (legacy.length() >= 8) {
      strlcpy(hosts[0].id, "legacy", sizeof(hosts[0].id));
      strlcpy(hosts[0].label, "Mac", sizeof(hosts[0].label));
      hosts[0].secret = legacy;
      hostCount = 1;
      saveHostSlot(0);
      saveHostCount();
      Serial.println("PAIRING: migrated the previous single pairing into slot 0");
    }
  }
  strlcpy(allowedHost, prefs.getString("hallow", "").c_str(), sizeof(allowedHost));
  if (allowedHost[0] && findHost(allowedHost) < 0) { allowedHost[0] = 0; saveAllowedHost(); }
  // Assume the first slot until a payload names a hostId. Without this a host
  // old enough not to send `hostId` would leave activeHost = -1 forever and the
  // device could never sign an answer; the real hostId corrects this on the
  // first payload that carries one.
  activeHost = hostCount ? 0 : -1;
}
#if BOARD_HAS_WIRELESS_PAIR
// True only while pairCommitIfReady() is inside upsertHost(). It exists so the
// log line below can NAME which path stored the key, and it is declared here
// rather than beside the rest of the pairing state because the Arduino build
// concatenates these files into one translation unit in file order - a global
// used above its own declaration would not compile.
bool pairRadioCommit = false;
#endif
// Store (or refresh) the pairing for one Mac. Two callers now: the USB
// PROVISION path, and - on board 2 only - pairCommitIfReady() once a proof AND
// a CONFIRM on the glass have both arrived. A BLE peer still cannot add itself:
// what it can do is ask, and a person on the glass is what stores anything.
void upsertHost(const char* id, const String& secret, const char* label) {
  int i = findHost(id);
  if (i < 0) {
    // A migrated pre-multi-pairing slot is this same Mac finally identifying
    // itself - upgrade it in place rather than leaving a stale duplicate that
    // would keep triggering the upgrade HELLO.
    int legacy = findHost("legacy");
    if (legacy >= 0) i = legacy;
    else if (hostCount < MAX_HOSTS) i = hostCount++;
    else i = 0;   // full: recycle the first slot
    strlcpy(hosts[i].id, id, sizeof(hosts[i].id));
  }
  hosts[i].secret = secret;
  strlcpy(hosts[i].label, (label && *label) ? label : "Mac", sizeof(hosts[i].label));
  saveHostSlot(i);
  saveHostCount();
  activeHost = i;
  // "PROVISION:" IS THIS REPO'S ONLY MARKER THAT A KEY ARRIVED OVER THE CABLE -
  // i.e. that a person was holding the device with a USB lead in it - so a radio
  // pairing printing it would forge the audit trail for the exact property this
  // whole feature rests on. The wireless path says WIRELESS PAIR. Board 1 sees
  // only the PROVISION line below: the guard emits no code there, so this is
  // textually identical after preprocessing and its binary does not move.
#if BOARD_HAS_WIRELESS_PAIR
  if (pairRadioCommit)
    Serial.printf("WIRELESS PAIR: pairing stored for %s (%s), slot %d of %d"
                  " - no cable, and the key was never transmitted\n",
                  hosts[i].id, hosts[i].label, i + 1, hostCount);
  else
#endif
  Serial.printf("PROVISION: pairing stored for %s (%s), slot %d of %d\n",
                hosts[i].id, hosts[i].label, i + 1, hostCount);
}
void forgetHost(int i) {
  if (i < 0 || i >= hostCount) return;
  bool wasAllowed = allowedHost[0] && strcmp(hosts[i].id, allowedHost) == 0;
  for (int j = i; j < hostCount - 1; j++) hosts[j] = hosts[j + 1];
  hostCount--;
  hosts[hostCount].id[0] = 0;
  hosts[hostCount].label[0] = 0;
  hosts[hostCount].secret = "";
  saveHostSlot(hostCount);
  for (int j = 0; j < hostCount; j++) saveHostSlot(j);
  saveHostCount();
  if (wasAllowed) { allowedHost[0] = 0; saveAllowedHost(); }
  activeHost = -1;
}

// ============================================================================
// WIRELESS PAIRING: the derivations. BOARD 2 ONLY.
//
// Board 1 compiles none of this - BOARD_HAS_WIRELESS_PAIR is 0 there and the
// flag alone emits no code, which is what keeps that board's binary where it
// is. PROVISION over USB is unchanged on both boards and remains the ONLY
// pairing path on board 1.
//
// What this replaces and why it is not a relaxation: the cable's security value
// is proof that a person was HOLDING the device, not the wire itself. Here that
// proof is a tap on the glass, and the 128-bit pairing secret is NEVER
// transmitted - both ends derive it from an ephemeral X25519 exchange. See
// docs/superpowers/specs/2026-08-30-wireless-pairing.md.
//
// EVERY VALUE BELOW MUST MATCH host/pair-crypto.mjs BYTE FOR BYTE. A mismatch
// errors nowhere: both ends stay self-consistent, the code on the screen simply
// is not the code the Mac derived, and it presents as a UI bug. PAIRVECTOR is
// the instrument that turns that into a measurement.
// ============================================================================
#if BOARD_HAS_WIRELESS_PAIR
// The mbedtls and esp_random includes this block needs live at the top of
// deckhand_display.ino, under the same flag - see the note there for why.

// The two HKDF info strings and the proof message. The trailing "/1" is a
// VERSION MARKER, not decoration: a future change to any derivation bumps it,
// so an old device and a new Mac fail cleanly at the code-compare step instead
// of silently deriving different keys and blaming the user. The two info
// strings must differ, or the code and the key are the same bytes.
#define PAIR_SAS_INFO   "deckhand-sas/1"
#define PAIR_KEY_INFO   "deckhand-key/1"
#define PAIR_PROOF_MSG  "deckhand-pairok/1"
#define PAIR_CODE_MODULUS 1000000UL   // 10^PAIR_CODE_DIGITS
#define PAIR_CODE_DIGITS  6
#define PAIR_KEY_BYTES    16          // 128-bit pairing secret

// mbedtls wants an RNG for the scalar-multiplication blinding. esp_fill_random
// is the hardware RNG the rest of this firmware already trusts.
int pairRng(void* ctx, unsigned char* out, size_t len) {
  (void) ctx;
  esp_fill_random(out, len);
  return 0;
}

// RFC 7748's clamping, applied to the private scalar BEFORE it is used.
// It is not optional here the way it is on the Mac: node's X25519 clamps
// internally and accepts any 32 bytes, while mbedtls_ecp_check_privkey REFUSES
// an unclamped Montgomery scalar outright - so an unclamped key is not a
// different answer here, it is an error. Clamping is idempotent and is part of
// X25519 itself, so clamping first cannot change what either side computes;
// pinning the CLAMPED form is what lets both sides load the same 32 bytes.
void pairClamp(uint8_t d[32]) {
  d[0] &= 248;
  d[31] &= 127;
  d[31] |= 64;
}

// X25519. Both buffers are RAW LITTLE-ENDIAN 32 bytes - RFC 7748's encoding,
// which is what node's crypto produces and consumes natively.
//
// BYTE ORDER, MEASURED ON HARDWARE RATHER THAN ASSUMED. mbedtls stores a
// Curve25519 point's coordinate as an MPI, whose natural serialisation is
// BIG-endian, so it was an open question whether these two calls hand back the
// bytes node expects or their reverse. Settled by running PAIRVECTOR on a real
// board 2 against host/pair-crypto-check.mjs's pinned RFC 7748 vector:
// mbedtls 3.6.6's mbedtls_ecp_point_read_binary and _write_binary SPECIAL-CASE
// Montgomery curves and do the little-endian conversion THEMSELVES, so no
// reversal is needed at any of the three boundaries (peer public in, own public
// out, shared secret out) and none is done. If a future mbedtls changes that,
// PAIRVECTOR's shared secret stops matching RFC 7748's published value and the
// fix is to reverse here - which is the whole reason that command exists.
bool pairMul(const uint8_t scalar[32], const mbedtls_ecp_point* P, uint8_t out[32],
             mbedtls_ecp_group* grp) {
  mbedtls_mpi d;
  mbedtls_ecp_point R;
  mbedtls_mpi_init(&d);
  mbedtls_ecp_point_init(&R);
  bool ok = false;
  size_t olen = 0;
  // The scalar is little-endian on the wire; the MPI is a number.
  if (mbedtls_mpi_read_binary_le(&d, scalar, 32) == 0 &&
      mbedtls_ecp_mul(grp, &R, &d, P, pairRng, NULL) == 0 &&
      mbedtls_ecp_point_write_binary(grp, &R, MBEDTLS_ECP_PF_UNCOMPRESSED,
                                     &olen, out, 32) == 0 &&
      olen == 32) {
    ok = true;
  }
  mbedtls_ecp_point_free(&R);
  mbedtls_mpi_free(&d);
  return ok;
}

// out = X25519(priv, peerPub)
//
// CARRY-FORWARD FOR TASK 2, NOT IMPLEMENTED HERE: a peer public key is
// ATTACKER-SUPPLIED the moment this is called with anything but the pinned
// vector, and the classic contributory-behaviour attack sends a LOW-ORDER
// point (all-zero, one, or either of the two order-8 points) so the shared
// secret is forced to a value the attacker knows.
//
// The MAC FAILS CLOSED, measured rather than assumed: node's
// crypto.diffieHellman THROWS on all four of them
// (ERR_OSSL_FAILED_DURING_DERIVATION), so no all-zero secret is ever derived
// on that side. WHAT THAT MEANS FOR TASK 2 IS THAT IT MUST CATCH THE THROW.
// An uncaught one inside the poll loop is this repo's documented "an await
// that never settles kills the poll loop forever" class arriving through a
// rejection instead of a hang - the host looks alive, the serial reader keeps
// logging, and nothing ticks.
//
// THE DEVICE SIDE IS UNVERIFIED. Whether mbedtls_ecp_mul refuses a low-order
// Montgomery point or happily returns the all-zero secret has not been
// measured here, and a device that accepts one while the Mac refuses is a
// pairing that simply never completes rather than one that is broken open -
// but it should be settled, not guessed, before this function is called with
// a key that came off the radio.
bool pairX25519(const uint8_t priv[32], const uint8_t peerPub[32], uint8_t out[32]) {
  mbedtls_ecp_group grp;
  mbedtls_ecp_point Q;
  mbedtls_ecp_group_init(&grp);
  mbedtls_ecp_point_init(&Q);
  bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_CURVE25519) == 0 &&
            mbedtls_ecp_point_read_binary(&grp, &Q, peerPub, 32) == 0 &&
            pairMul(priv, &Q, out, &grp);
  mbedtls_ecp_point_free(&Q);
  mbedtls_ecp_group_free(&grp);
  return ok;
}

// out = X25519(priv, basepoint) - this device's public key for one exchange.
bool pairPublicFromPrivate(const uint8_t priv[32], uint8_t out[32]) {
  mbedtls_ecp_group grp;
  mbedtls_ecp_group_init(&grp);
  bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_CURVE25519) == 0 &&
            pairMul(priv, &grp.G, out, &grp);
  mbedtls_ecp_group_free(&grp);
  return ok;
}

// A fresh EPHEMERAL keypair. Ephemeral is the point: it exists for the length
// of one pairing window and is discarded, so there is no long-lived private key
// on this device to steal.
bool pairGenKeypair(uint8_t priv[32], uint8_t pub[32]) {
  esp_fill_random(priv, 32);
  pairClamp(priv);
  return pairPublicFromPrivate(priv, pub);
}

// salt = pubA || pubB, where A is ALWAYS the Mac's (the initiator's) key.
//
// THE ORDER IS FIXED BY ROLE, NOT BY "mine then theirs", AND THAT ASYMMETRY IS
// THE WHOLE POINT. The Mac concatenates its own key first; this device, which
// is always B, concatenates the PEER's key first. Swap it on one side and
// nothing errors - each end derives a perfectly good code and key, they simply
// differ - so the symptom is a code the user types that is never accepted.
void pairSalt(const uint8_t pubA[32], const uint8_t pubB[32], uint8_t salt[64]) {
  memcpy(salt, pubA, 32);
  memcpy(salt + 32, pubB, 32);
}

bool pairHkdf(const uint8_t* shared, const uint8_t* salt, const char* info,
              uint8_t* out, unsigned int outLen) {
  const mbedtls_md_info_t* md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!md) return false;
  return mbedtls_hkdf(md, salt, 64, shared, 32,
                      (const unsigned char*) info, strlen(info), out, outLen) == 0;
}

// Everything one side of an exchange needs, from its own private key and the
// Mac's public key. THE DEVICE IS ALWAYS B: privB is ours, pubA is theirs.
//
// outCode is 7 bytes (6 digits and a NUL), outProof 33 (32 hex and a NUL).
// Any output pointer may be NULL if that value is not wanted.
//
// EVERY SECRET BUFFER IS ZEROIZED ON EVERY EXIT PATH, WHICH IS WHY THIS IS
// SINGLE-EXIT. It was five bare `return false`s, each leaving the shared
// secret, the salt and the 128-bit key live in a stack frame the UI reuses
// microseconds later - survivable today, where the only caller is PAIRVECTOR
// with a published test vector, and NOT survivable once this is the function
// the real pairing calls with the real key. A goto to one `done:` is what makes
// the wipe unmissable: an early return added later has to walk past it.
//
// mbedtls_platform_zeroize, never memset: a memset whose result is never read
// again is precisely what a compiler may delete, and a dying stack frame is
// that case by definition. pubB is NOT wiped - it is this device's PUBLIC key
// and is about to be handed to the caller.
bool pairDeriveAll(const uint8_t privB[32], const uint8_t pubA[32],
                   uint8_t outPubB[32], uint8_t outShared[32],
                   char* outCode, uint8_t* outKey, char* outProof) {
  uint8_t pubB[32], shared[32], salt[64], key[PAIR_KEY_BYTES], c[4];
  uint32_t n;
  bool ok = false;

  if (!pairPublicFromPrivate(privB, pubB)) goto done;
  if (!pairX25519(privB, pubA, shared)) goto done;
  pairSalt(pubA, pubB, salt);

  // The six digits the user reads off the glass. Four bytes read BIG-endian,
  // taken modulo 10^6, and ZERO-PADDED to six characters - the padding is not
  // cosmetic: an unpadded 1472 in a six-character box reads as a bug, and a
  // comparison against the unpadded string would reject a code typed correctly.
  if (!pairHkdf(shared, salt, PAIR_SAS_INFO, c, sizeof(c))) goto done;
  n = ((uint32_t) c[0] << 24) | ((uint32_t) c[1] << 16) |
      ((uint32_t) c[2] << 8) | (uint32_t) c[3];
  if (outCode) snprintf(outCode, PAIR_CODE_DIGITS + 1, "%06lu",
                        (unsigned long) (n % PAIR_CODE_MODULUS));

  // The 128-bit pairing secret. NEVER transmitted by either side.
  if (!pairHkdf(shared, salt, PAIR_KEY_INFO, key, sizeof(key))) goto done;

  if (outPubB) memcpy(outPubB, pubB, 32);
  if (outShared) memcpy(outShared, shared, 32);
  if (outKey) memcpy(outKey, key, sizeof(key));
  if (outProof && !pairProofHex(key, outProof)) goto done;
  ok = true;

done:
  mbedtls_platform_zeroize(shared, sizeof(shared));
  mbedtls_platform_zeroize(salt, sizeof(salt));
  mbedtls_platform_zeroize(key, sizeof(key));
  // c is four bytes of HKDF output over the shared secret - the code's own
  // material, so it is a secret even though the six digits it becomes are
  // shown on the glass.
  mbedtls_platform_zeroize(c, sizeof(c));
  return ok;
}

// proof = HMAC-SHA256(key, "deckhand-pairok/1"), first 16 bytes, lower hex.
// It is what the Mac sends to prove it derived the same key WITHOUT sending the
// key. Forging it is a 128-bit problem, where guessing the six digits would be
// a 10^6 one - which is why the device is never sent a guess at the code.
// outProof must have room for 33 bytes.
bool pairProofHex(const uint8_t* key, char* outProof) {
  const mbedtls_md_info_t* md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!md) return false;
  uint8_t out[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  bool ok = mbedtls_md_setup(&ctx, md, 1) == 0 &&   // 1 = HMAC mode
            mbedtls_md_hmac_starts(&ctx, key, PAIR_KEY_BYTES) == 0 &&
            mbedtls_md_hmac_update(&ctx, (const unsigned char*) PAIR_PROOF_MSG,
                                   strlen(PAIR_PROOF_MSG)) == 0 &&
            mbedtls_md_hmac_finish(&ctx, out) == 0;
  mbedtls_md_free(&ctx);
  if (!ok) return false;
  for (int i = 0; i < 16; i++) sprintf(outProof + i * 2, "%02x", out[i]);
  outProof[32] = 0;
  return true;
}

// Constant-time string compare, for anything derived from a secret.
// strcmp/memcmp return on the first differing byte, which leaks HOW MANY
// leading bytes were right - and that turns forging a 128-bit proof into
// sixteen one-byte searches. The loop accumulates every difference with |= and
// always runs to the end. The LENGTH is compared in the clear on purpose: both
// of the things this compares have a fixed, public length, so it carries
// nothing.
bool pairCtEq(const char* a, const char* b, unsigned int len) {
  if (!a || !b) return false;
  uint8_t diff = 0;
  for (unsigned int i = 0; i < len; i++) diff |= (uint8_t) a[i] ^ (uint8_t) b[i];
  return diff == 0;
}

// ---------------------------------------------------------------------------
// PAIRVECTOR - the instrument that makes interop a MEASUREMENT.
//
// It exists for the reason TEXTPROBE, AUDIOPROBE and COLORTEST do: without it
// the first real pairing attempt is the test, and a byte-order disagreement
// between mbedtls and node is indistinguishable from a UI bug. It runs a FIXED
// private key against a FIXED peer public key and prints every derived value,
// so the comparison against host/pair-crypto-check.mjs is a diff rather than a
// judgement.
//
// The vector is RFC 7748 section 6.1's own Alice and Bob, stored CLAMPED (see
// pairClamp). That means the shared secret it prints is a value published by
// the IETF, not one this repo invented - so a match proves the X25519 itself,
// not merely that two of our own implementations agree with each other.
// ---------------------------------------------------------------------------
const uint8_t PAIR_VEC_PRIV_B[32] = {
  0x58, 0xab, 0x08, 0x7e, 0x62, 0x4a, 0x8a, 0x4b, 0x79, 0xe1, 0x7f, 0x8b, 0x83, 0x80, 0x0e, 0xe6,
  0x6f, 0x3b, 0xb1, 0x29, 0x26, 0x18, 0xb6, 0xfd, 0x1c, 0x2f, 0x8b, 0x27, 0xff, 0x88, 0xe0, 0x6b };
const uint8_t PAIR_VEC_PUB_A[32] = {
  0x85, 0x20, 0xf0, 0x09, 0x89, 0x30, 0xa7, 0x54, 0x74, 0x8b, 0x7d, 0xdc, 0xb4, 0x3e, 0xf7, 0x5a,
  0x0d, 0xbf, 0x3a, 0x0d, 0x26, 0x38, 0x1a, 0xf4, 0xeb, 0xa4, 0xa9, 0x8e, 0xaa, 0x9b, 0x4e, 0x6a };
// The SECOND vector's private key, whose only job is a code with LEADING ZEROS
// (001472). A code that is not zero-padded renders as four characters in a
// six-character box, and one pinned example that happens to start with a
// non-zero digit would never notice.
const uint8_t PAIR_VEC_ZERO_PRIV_B[32] = {
  0x10, 0x77, 0x03, 0x3d, 0xa8, 0xd6, 0xdb, 0x6d, 0x9b, 0xbc, 0x46, 0xc1, 0xa3, 0xe4, 0xf1, 0xb9,
  0x6d, 0xb0, 0xc2, 0x23, 0xea, 0xb9, 0x8c, 0x75, 0x29, 0x53, 0xea, 0x87, 0xe1, 0xbe, 0xae, 0x55 };

void pairHexInto(const uint8_t* b, unsigned int n, char* out) {
  for (unsigned int i = 0; i < n; i++) sprintf(out + i * 2, "%02x", b[i]);
  out[n * 2] = 0;
}

void pairVectorReport() {
  uint8_t pubB[32], shared[32], key[PAIR_KEY_BYTES];
  char code[PAIR_CODE_DIGITS + 1], proof[33];
  char line[160], hexbuf[65];

  if (!pairDeriveAll(PAIR_VEC_PRIV_B, PAIR_VEC_PUB_A, pubB, shared, code, key, proof)) {
    // Named cause rather than silence: from the Mac, "no output" and
    // "the curve is not compiled in" look identical. The wipe happens on this
    // path too: a failed derivation can still have left half a shared secret
    // in the buffer, and "it errored" is not "it wrote nothing".
    mbedtls_platform_zeroize(shared, sizeof(shared));
    mbedtls_platform_zeroize(key, sizeof(key));
    sendLineToHost("PAIRVECTOR FAILED: the X25519/HKDF path returned an error");
    return;
  }
  pairHexInto(pubB, 32, hexbuf);
  snprintf(line, sizeof(line), "PAIRVECTOR pubB=%s", hexbuf);   sendLineToHost(line);
  pairHexInto(shared, 32, hexbuf);
  snprintf(line, sizeof(line), "PAIRVECTOR shared=%s", hexbuf); sendLineToHost(line);
  pairHexInto(key, PAIR_KEY_BYTES, hexbuf);
  snprintf(line, sizeof(line), "PAIRVECTOR code=%s key=%s", code, hexbuf); sendLineToHost(line);
  snprintf(line, sizeof(line), "PAIRVECTOR proof=%s", proof);   sendLineToHost(line);

  // The leading-zero vector: only its code and key are interesting.
  if (pairDeriveAll(PAIR_VEC_ZERO_PRIV_B, PAIR_VEC_PUB_A, NULL, NULL, code, key, NULL)) {
    pairHexInto(key, PAIR_KEY_BYTES, hexbuf);
    snprintf(line, sizeof(line), "PAIRVECTOR zero code=%s key=%s", code, hexbuf);
    sendLineToHost(line);
  } else {
    sendLineToHost("PAIRVECTOR zero FAILED");
  }

  // A live round trip on top of the pinned one. It exercises esp_fill_random
  // and the public-key path, and it proves the ECDH is symmetric ON THIS CHIP -
  // which the fixed vector alone cannot say, since it only ever multiplies in
  // one direction.
  uint8_t p1[32], q1[32], p2[32], q2[32], s1[32], s2[32];
  // pairCtEq, not memcmp, and it is not ceremony here: these are two shared
  // secrets, and the rule seventy lines above forbids exactly the compare this
  // line used to be. It is also the ONE call site that stops the checker's
  // "compared in constant time" assertion being satisfied by a function that
  // nothing calls - which is what it was.
  bool fresh = pairGenKeypair(p1, q1) && pairGenKeypair(p2, q2) &&
               pairX25519(p1, q2, s1) && pairX25519(p2, q1, s2) &&
               pairCtEq((const char*) s1, (const char*) s2, 32);
  snprintf(line, sizeof(line), "PAIRVECTOR fresh=%s (a generated keypair agrees both ways)",
           fresh ? "ok" : "FAIL");
  sendLineToHost(line);

  // Everything secret this frame touched, gone before the UI reuses the stack:
  // the pinned vector's shared secret and key, both ephemeral PRIVATE keys, and
  // the two shared secrets from the live round trip. hexbuf and line held the
  // key in hex - published here, since this vector is the RFC's, but the
  // habit is the point and the next caller's key will not be.
  mbedtls_platform_zeroize(shared, sizeof(shared));
  mbedtls_platform_zeroize(key, sizeof(key));
  mbedtls_platform_zeroize(p1, sizeof(p1));
  mbedtls_platform_zeroize(p2, sizeof(p2));
  mbedtls_platform_zeroize(s1, sizeof(s1));
  mbedtls_platform_zeroize(s2, sizeof(s2));
  mbedtls_platform_zeroize(hexbuf, sizeof(hexbuf));
  mbedtls_platform_zeroize(line, sizeof(line));
}

// ===========================================================================
// THE PAIRING WINDOW, THE WIRE HANDLERS AND THE STORAGE. BOARD 2 ONLY.
//
// Everything above this line is arithmetic that could be run against a pinned
// test vector. Everything below it is reached by BYTES OFF THE RADIO, and the
// difference is the whole reason the validation sits where it does.
//
// THE PRESENCE GUARANTEE IS THE WINDOW, NOT THE CRYPTO. The cable's security
// value was proof that a person was HOLDING the device; here that proof is a
// tap on the glass which opens a 120s window, and NOTHING below will pair while
// that window is shut - nor while it is open, until a SECOND tap confirms that
// the six digits on this screen match the six on the Mac's. A valid proof is
// half of a commit and never all of it: see pairProofOk. So a window left open by someone who wandered off is the
// one state that weakens the whole design - which is why pairClose() is called
// from a tab switch, from the screen blanking, from deep sleep and from the
// timeout, and why it WIPES rather than merely marking the window shut.
//
// THE SECRET IS NEVER TRANSMITTED. Only two public keys and a proof cross the
// wire. pairKeyHex, pairProofWant, pairPriv and pairCodeDigits appear in no
// Serial.print and no sendLineToHost anywhere below - host/pair-crypto-check.mjs
// asserts that as a rule over the source text rather than as a promise, because
// a single debugging printf would put the 128-bit key on the very link the
// design exists to keep it off. The six digits are on the GLASS deliberately:
// putting them on the wire would let a Mac skip the human, which is the one
// thing that makes this equal to the cable.
// ===========================================================================

// The pending exchange, as plain globals rather than a struct: the Arduino build
// inserts its generated prototypes ABOVE the sketch's first function definition,
// so a type declared here could never appear in a signature anyway (the rule
// HostPairing/SessionInfo already live under), and a struct nothing may name
// buys nothing over named fields.
unsigned long pairWindowUntil = 0;                 // millis deadline; 0 = closed
bool pairPending = false;                          // a PAIRREQ was answered; awaiting PAIROK
// THE TWO HALVES OF A COMMIT, AND NEITHER ALONE STORES ANYTHING.
//
// The first design committed on a valid proof alone, and that was BROKEN: the
// proof is HMAC(key, "deckhand-pairok/1") where the key derives from the ECDH
// shared secret and nothing else, so ANY peer that completes the exchange can
// compute it WITHOUT EVER SEEING THE DISPLAYED CODE. An attacker in range
// answers the window the instant the user taps PAIR NEW MAC, sends a valid
// proof, and is stored in milliseconds. The code defended the user's MAC
// against a man-in-the-middle and gave this device nothing.
//
// What commits now is Numeric Comparison: both screens show the code, the user
// compares them, and a tap on THIS glass - bound to this pending peer - is the
// second half. The proof is kept as defence in depth (it says the peer that
// sent it is the peer that did the ECDH, which the human comparison alone
// cannot establish), never as sufficient on its own.
bool pairProofOk = false;                          // a valid PAIROK arrived
bool pairConfirmed = false;                        // CONFIRM was tapped on the glass
char pairHostId[12] = "";                          // the requesting Mac's hostId, 8 hex
char pairLabel[PAIR_LABEL_BYTES] = "";             // its label, ASCII-sanitised and capped
char pairCodeDigits[PAIR_CODE_DIGITS + 1] = "";    // the six digits Task 3 draws - GLASS ONLY
uint8_t pairPriv[32];                              // our ephemeral private key - SECRET
char pairKeyHex[PAIR_KEY_BYTES * 2 + 1] = "";      // the derived 128-bit key, hex - SECRET
char pairProofWant[33] = "";                       // the proof we expect back - SECRET-DERIVED

// HOW THE LAST EXCHANGE ENDED, for the screen that was watching it. The panel
// cannot work this out from outside: pairClose() wipes the exchange, so by the
// time the UI notices the window has shut, the hostId, the label and the reason
// are all gone - and "it stopped" is exactly the shape this file already refuses
// on the wire, where a timeout and a device that went away look identical.
//
// It is a plain uint8_t rather than one of the fields above BECAUSE it must
// SURVIVE pairWipe(): every one of those is destroyed with the exchange, which is
// the whole point of them, and a verdict destroyed with the exchange is a verdict
// nobody can read. pairOpen() clears it instead - a new window is the one moment
// the previous verdict stops being the answer.
//
// FIRST WRITER WINS (pairSetResult). A commit ends with pairClose("paired"), and a
// close that overwrote the verdict would report every success as whatever the
// close was for.
#define PAIR_RES_NONE      0
#define PAIR_RES_OK        1
#define PAIR_RES_BADPROOF  2
#define PAIR_RES_FULL      3
#define PAIR_RES_TIMEOUT   4
#define PAIR_RES_CANCELLED 5
uint8_t pairResult = PAIR_RES_NONE;
void pairSetResult(uint8_t r) { if (pairResult == PAIR_RES_NONE) pairResult = r; }

// millis() wraps, so the deadline is compared as a SIGNED difference rather than
// with `millis() < pairWindowUntil` - which is wrong for the ~49.7 days after a
// wrap and right for the 49.7 days before it, i.e. a bug that cannot be found by
// testing. 0 means closed, and pairOpen() refuses to leave it at 0.
bool pairWindowOpen() {
  return pairWindowUntil != 0 && (long) (millis() - pairWindowUntil) < 0;
}

// EVERY FIELD, key material zeroized rather than assigned. mbedtls_platform_zeroize
// and not memset for the reason pairDeriveAll already records: a memset whose
// result is never read again is exactly what a compiler may delete. The hostId
// and the label are not secret and are wiped anyway, because "clears every
// field" is a rule that survives someone adding a field and "clears the secret
// ones" is a rule that needs re-deciding each time.
void pairWipe() {
  mbedtls_platform_zeroize(pairPriv, sizeof(pairPriv));
  mbedtls_platform_zeroize(pairKeyHex, sizeof(pairKeyHex));
  mbedtls_platform_zeroize(pairProofWant, sizeof(pairProofWant));
  mbedtls_platform_zeroize(pairCodeDigits, sizeof(pairCodeDigits));
  mbedtls_platform_zeroize(pairHostId, sizeof(pairHostId));
  mbedtls_platform_zeroize(pairLabel, sizeof(pairLabel));
  pairPending = false;
  // Both commit halves die with the exchange they belonged to. A confirm that
  // outlived its own PAIRREQ would commit the NEXT peer's key on a tap the user
  // aimed at the previous one - which is the whole class this redesign exists
  // to close, arriving through stale state instead of through a missing check.
  pairProofOk = false;
  pairConfirmed = false;
}

// Shuts the window AND destroys the exchange. It sends nothing: a caller that
// owes the Mac a PAIRFAIL sends it BEFORE closing, while the hostId is still
// here to address it to. Logging the reason is not decoration - from the Mac,
// a window that timed out and a device that stopped answering look identical.
void pairClose(const char* why) {
  bool wasOpen = pairWindowUntil != 0 || pairPending;
  pairWindowUntil = 0;
  pairWipe();
  if (wasOpen) Serial.printf("PAIR: window closed (%s)\n", why ? why : "no reason given");
}

// TASK 3's ENTRY POINT, deliberately with no call site yet - the same shape
// activeSecret() and primaryLink() already have in this repo, and said out loud
// rather than left for a reader to wonder about. Nothing can pair until the
// PAIR NEW MAC button exists, which is exactly the intended state.
void pairOpen() {
  pairWipe();
  // The one moment the previous verdict stops being the answer - see pairResult.
  pairResult = PAIR_RES_NONE;
  pairWindowUntil = millis() + (unsigned long) PAIR_WINDOW_MS;
  if (pairWindowUntil == 0) pairWindowUntil = 1;   // 0 is the CLOSED sentinel
  Serial.printf("PAIR: window open for %lds\n", (long) (PAIR_WINDOW_MS / 1000));
}

// PAIRDONE and PAIRFAIL carry the trailing to=<hostId> every device->host line
// already uses, so the OTHER paired Mac drops them before logging instead of
// recording a failure it had no part in - the noise that trains you to ignore
// the one log line that means something.
//
// The suffix is built here rather than by sendLineToHost(line, link), which
// addresses by LINK index: a Mac that is pairing has not necessarily sent a tick
// payload yet, so it may own no hostLinks slot at all and would silently come
// out as a broadcast. The hostId is the thing we actually know.
void pairReply(const char* line, const char* hostId) {
  char out[96];
  if (hostId && *hostId) snprintf(out, sizeof(out), "%s to=%s", line, hostId);
  else strlcpy(out, line, sizeof(out));
  sendLineToHost(out);
}

void pairFail(const char* reason, const char* hostId) {
  char line[64];
  snprintf(line, sizeof(line), "PAIRFAIL %s", reason);
  pairReply(line, hostId);
  Serial.printf("PAIR: -> PAIRFAIL %s\n", reason);
}

// The timeout, from loop(). It says so on the WIRE as well as in the log when an
// exchange was actually pending: the Mac is sitting on a dialog waiting for a
// proof to be accepted, and silence there is indistinguishable from a device
// that has gone away.
void pairTick() {
  if (pairWindowUntil == 0) return;
  if ((long) (millis() - pairWindowUntil) < 0) return;
  if (pairPending) pairFail("timeout", pairHostId);
  pairSetResult(PAIR_RES_TIMEOUT);
  pairClose("timed out");
}

int pairHexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// THE LENGTH CHECK LIVES HERE, AND THAT PLACEMENT IS THE FINDING THE SECURITY
// REVIEW DEFERRED TO THIS TASK. Every device-side entry point above takes
// uint8_t[32] parameters, which decay to pointers: they CANNOT check a length,
// and a short hex string would leave the tail of the destination buffer holding
// whatever the stack held before. So the one place that turns attacker-supplied
// text into those 32 bytes is the one place that can enforce it, and it refuses
// the whole string rather than parsing a prefix.
bool pairHexToBytes(const char* s, unsigned int nBytes, uint8_t* out) {
  if (!s || !out) return false;
  if (strlen(s) != nBytes * 2) return false;
  for (unsigned int i = 0; i < nBytes; i++) {
    int hi = pairHexNibble(s[i * 2]);
    int lo = pairHexNibble(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t) ((hi << 4) | lo);
  }
  return true;
}

// EXACTLY 8 hex characters. isHexHostId() alone accepts any length, which is
// right where it is used (a link's id, already length-capped by copyField) and
// wrong here, where this string becomes the NVS key a pairing is stored under.
bool pairHostIdOk(const char* id) {
  return id && strlen(id) == (unsigned int) PAIR_HOSTID_CHARS && isHexHostId(id);
}

// ASCII 0x20..0x7E and capped, because both faces on this device declare exactly
// that range and an out-of-range byte draws nothing while still costing budget -
// the rule the whole wire already follows. It is attacker-controlled text shown
// beside the code, and it is DISPLAY-ONLY: nothing keys off it.
//
// THE TERMINATOR'S BYTE IS RESERVED ONCE, BY NAME. The bound was written inline
// as `w + 1 < outSize`, which is correct - and correct is not the same as
// GUARDED: it is one character from `w < outSize`, which puts the closing NUL at
// out[outSize], one past the end of an attacker-sized string's destination, and
// no assertion anywhere would have noticed. `cap` states the reservation once,
// where the checker can bind it, and the outSize == 0 return above is what makes
// outSize - 1 safe.
void pairSanitiseLabel(const char* in, char* out, unsigned int outSize) {
  if (!out || outSize == 0) return;
  const unsigned int cap = outSize - 1;   // room for out[w] = 0, always
  unsigned int w = 0;
  for (const char* p = in; in && *p && w < cap; p++) {
    char c = *p;
    if (c >= 0x20 && c <= 0x7E) out[w++] = c;
  }
  out[w] = 0;
  if (w == 0) strlcpy(out, "Mac", outSize);
}

// A free slot, or the slot this Mac already occupies (re-pairing a known Mac
// replaces its key in place and is never "full").
//
// FULL IS FULL, and it is checked BEFORE any key is generated. upsertHost()'s
// own behaviour when the store is full is to RECYCLE SLOT 0 - correct for a
// deliberate USB PROVISION, and a silent destruction of a key the user still
// wanted if a radio peer could reach it.
bool pairHasRoomFor(const char* hostId) {
  return findHost(hostId) >= 0 || hostCount < MAX_HOSTS;
}

// ONE PREDICATE, READ BY EVERYTHING THAT NEEDS THE ANSWER.
//
// "Is there anything to confirm?" is asked by the commit path here, and will be
// asked again by Task 3's CONFIRM button - once to decide whether to DRAW it and
// once to decide whether a tap on it does anything. This codebase's classic
// defect is a control drawn under one condition and hit-tested under another
// (fabVisible() is gated in one place for exactly that reason: drawn-but-dead
// and tappable-but-dead are two different bugs), so there is one function and
// no second spelling of the condition anywhere.
bool pairConfirmable() {
  return pairWindowOpen() && pairPending;
}

// THE COMMIT, AND IT NEEDS BOTH HALVES IN EITHER ORDER.
//
// Called from handlePairOk() when the proof lands and from pairConfirm() when
// the glass is tapped, so whichever arrives SECOND is the one that stores. A
// valid proof alone must never reach upsertHost() - see the note on pairProofOk
// for why that was the flaw rather than a hardening opportunity - and this is
// the ONLY place in the block that calls upsertHost, which the checker asserts
// rather than trusts.
void pairCommitIfReady() {
  if (!pairConfirmable()) return;
  if (!pairProofOk || !pairConfirmed) return;

  // Re-checked at COMMIT, not only at PAIRREQ: a USB PROVISION can fill the last
  // slot while this window is open, and upsertHost() would then recycle slot 0 -
  // silently destroying a key the user still wanted.
  if (!pairHasRoomFor(pairHostId)) {
    pairFail("full", pairHostId);
    pairSetResult(PAIR_RES_FULL);
    pairClose("no free slot at commit");
    return;
  }

  char id[12], label[PAIR_LABEL_BYTES];
  strlcpy(id, pairHostId, sizeof(id));
  strlcpy(label, pairLabel, sizeof(label));
  // The key is stored as its 32-character lowercase hex, which is the form the
  // USB PROVISION path already stores and the form authHmacFor() keys the answer
  // HMAC with (it hashes the ASCII of the secret, not 16 raw bytes) - so a
  // wirelessly paired Mac answers prompts through exactly the same code path.
  // upsertHost() performs saveHostSlot() and saveHostCount() itself; calling
  // them again here would be a second NVS write of identical bytes.
  //
  // THE TEMPORARY String IS WIPED BEFORE IT IS FREED. `upsertHost(id,
  // String(pairKeyHex), label)` builds a heap copy of the 128-bit key and drops
  // it on the floor at the end of the statement - free() does not clear, so the
  // key sat in reusable heap with nothing left pointing at it to wipe. Named,
  // then zeroized while the pointer is still ours. (hosts[i].secret keeps its
  // own copy, deliberately: that IS the stored pairing.)
  String secret(pairKeyHex);
  pairRadioCommit = true;
  upsertHost(id, secret, label);
  pairRadioCommit = false;
  mbedtls_platform_zeroize((void*) secret.c_str(), secret.length());

  pairSetResult(PAIR_RES_OK);
  pairClose("paired");

  char line[48];
  snprintf(line, sizeof(line), "PAIRDONE %s", id);
  pairReply(line, id);
  Serial.printf("PAIR: %s paired over the radio; the key was never transmitted\n", id);
}

// TASK 3's CONFIRM BUTTON CALLS THIS, and it has no call site yet - the same
// shape pairOpen() has, and said out loud rather than left for a reader to
// wonder about. Nothing can pair until that button exists, which is the
// intended state.
//
// INERT WITHOUT A PENDING REQUEST: there is nothing to confirm before a PAIRREQ
// has arrived and a code is on the screen, and a flag set early would be a flag
// still set when the NEXT peer's request lands.
void pairConfirm() {
  if (!pairConfirmable()) {
    Serial.println("PAIR: CONFIRM ignored - no request is pending");
    return;
  }
  pairConfirmed = true;
  Serial.println("PAIR: confirmed on the glass");
  pairCommitIfReady();
}

// PAIRREQ <hostId:8hex> <pubA:64hex> <label...>
//
// A SECOND PAIRREQ WHILE ONE IS PENDING REPLACES IT. A first attempt whose
// PAIRPUB was lost must be recoverable without the user walking back to the
// device, and the displayed code CHANGES with the replacement - which the person
// standing in front of it sees, and which is what stops a replacement being a
// way to have someone read out a code for an exchange they are not looking at.
void handlePairReq(const String& rest) {
  if (!pairWindowOpen()) { pairFail("closed", NULL); return; }

  String body = rest;
  body.trim();
  int sp1 = body.indexOf(' ');
  if (sp1 < 0) { pairFail("badreq", NULL); return; }
  String id = body.substring(0, sp1);
  String tail = body.substring(sp1 + 1);
  tail.trim();
  int sp2 = tail.indexOf(' ');
  String pubHex = sp2 < 0 ? tail : tail.substring(0, sp2);
  String rawLabel = sp2 < 0 ? String("") : tail.substring(sp2 + 1);

  // BOTH VALIDATED BEFORE EITHER IS USED - see pairHexToBytes.
  if (!pairHostIdOk(id.c_str())) { pairFail("badhost", NULL); return; }
  // NORMALISED TO LOWERCASE THE MOMENT IT PARSES, because this string becomes
  // the NVS key a pairing is stored under and findHost() compares it with
  // strcmp. pairHostIdOk accepts A-F as well as a-f (isHexHostId does), so
  // "C532AB01" and "c532ab01" are the same Mac and would take TWO of the four
  // slots - and the second would answer prompts the first was allowed to,
  // while the PAIRED MACS page showed one Mac twice. The Mac itself sends
  // lowercase, so nothing here changes in practice; what changes is that
  // nothing else has to.
  id.toLowerCase();
  uint8_t pubA[32];
  if (!pairHexToBytes(pubHex.c_str(), 32, pubA)) { pairFail("badkey", id.c_str()); return; }

  // Before a single byte of key material exists.
  if (!pairHasRoomFor(id.c_str())) { pairFail("full", id.c_str()); return; }

  pairWipe();   // whatever was pending is gone before anything new is stored

  uint8_t pubB[32], derivedKey[PAIR_KEY_BYTES];
  esp_fill_random(pairPriv, sizeof(pairPriv));
  pairClamp(pairPriv);
  bool derived = pairDeriveAll(pairPriv, pubA, pubB, NULL,
                               pairCodeDigits, derivedKey, pairProofWant);
  if (derived) pairHexInto(derivedKey, PAIR_KEY_BYTES, pairKeyHex);
  mbedtls_platform_zeroize(derivedKey, sizeof(derivedKey));
  if (!derived) {
    pairWipe();
    pairFail("derive", id.c_str());
    return;
  }

  strlcpy(pairHostId, id.c_str(), sizeof(pairHostId));
  pairSanitiseLabel(rawLabel.c_str(), pairLabel, sizeof(pairLabel));
  pairPending = true;

  char hexbuf[65], line[80];
  pairHexInto(pubB, 32, hexbuf);
  snprintf(line, sizeof(line), "PAIRPUB %s", hexbuf);
  sendLineToHost(line);
  // The hostId and the label, never the code: the code's whole job is to be
  // read off the GLASS by a person, and a copy on the wire is a copy a Mac
  // could use to skip them.
  Serial.printf("PAIR: request from %s (%s); code is on the glass\n", pairHostId, pairLabel);
}

// PAIROK <hmac:32hex>
//
// The proof is HMAC-SHA256(key, "deckhand-pairok/1")[:16] - what the Mac sends
// to show it derived the same key WITHOUT sending the key.
//
// IT DOES NOT STORE ANYTHING, AND THAT IS THE CORRECTION AT THE HEART OF THIS
// DESIGN. A valid proof proves only that the sender completed the ECDH, which
// EVERY peer that answers the open window can do - the key derives from the
// shared secret and nothing else, so the proof is computable without ever
// having seen the six digits. A racing attacker therefore had a valid proof in
// milliseconds. So this sets a flag and waits: the code on the two screens, and
// a CONFIRM on this glass, are what commit.
void handlePairOk(const String& rest) {
  if (!pairWindowOpen()) { pairFail("closed", NULL); return; }
  if (!pairPending) { pairFail("noreq", NULL); return; }

  String got = rest;
  got.trim();
  // Length in the clear, deliberately: it is fixed and public, so it carries
  // nothing. The COMPARE below is the part that must not return early.
  if (got.length() != 32) {
    pairFail("badproof", pairHostId);
    pairSetResult(PAIR_RES_BADPROOF);
    pairClose("the proof was the wrong length");
    return;
  }
  // pairCtEq, never strcmp/memcmp/==: those return on the first differing byte,
  // which leaks how many leading bytes were right and turns a 128-bit forgery
  // into sixteen one-byte searches.
  if (!pairCtEq(got.c_str(), pairProofWant, 32)) {
    pairFail("badproof", pairHostId);
    pairSetResult(PAIR_RES_BADPROOF);
    pairClose("the proof did not match");
    return;
  }
  pairProofOk = true;
  // No reply yet: PAIRDONE means STORED, and nothing is stored until a person
  // has compared the two codes and tapped CONFIRM. Saying so in the log is what
  // stops "the Mac sent a good proof and nothing happened" reading as a fault.
  Serial.println("PAIR: proof accepted - waiting for CONFIRM on the glass");
  pairCommitIfReady();   // commits only if the tap already happened
}

// PAIRCANCEL - the Mac's dialog was dismissed.
void handlePairCancel() {
  if (!pairWindowOpen()) { pairFail("closed", NULL); return; }
  char id[12];
  strlcpy(id, pairHostId, sizeof(id));
  pairSetResult(PAIR_RES_CANCELLED);
  pairClose("cancelled by the Mac");
  pairFail("cancelled", id[0] ? id : NULL);
}

#endif  // BOARD_HAS_WIRELESS_PAIR
