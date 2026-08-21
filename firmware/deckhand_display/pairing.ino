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
// SessionInfo signs with pairingSlotForLink(s.hostSlot) instead.
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
// Store (or refresh) the pairing for one Mac. Called only from the USB
// PROVISION path - a BLE peer must never be able to add itself.
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
