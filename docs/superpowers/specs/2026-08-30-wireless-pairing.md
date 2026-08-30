# Wireless pairing — design spec

**Status:** design agreed, not built. Board 2 only.

## The problem

Pairing a Mac to a device requires plugging it in. `PROVISION` is USB-only and
`pairing.ino:148` says why: *"a BLE peer must never be able to add itself."* BLE here is
unencrypted — macOS plus noble handle bonding poorly, so the repo deliberately never leaned on it —
and the 128-bit pairing secret is sent verbatim in that command. Over the air, anyone listening
copies it and can then sign answers as that Mac.

So a second Mac cannot pair without the cable, and a device already deployed somewhere awkward
cannot be paired at all without retrieving it.

## What the cable actually provides, and what may therefore replace it

**The cable's security value is proof of physical presence, not the wire.** Someone had to be
holding the device. Any mechanism that also proves presence, and never puts the secret on the air,
is an equally strong replacement rather than a relaxation. That is the whole argument for this
feature and every decision below follows from it.

Two properties must survive:

1. **The secret is never transmitted.** Not encrypted-in-transit, not obfuscated — never sent.
2. **A person must physically act on the device** before it will pair with anything.

## The design: ephemeral X25519, with the code COMPARED on both screens

This is Bluetooth's Numeric Comparison association model, not an invention.

**A FIRST VERSION OF THIS SPEC WAS BROKEN AND IS RECORDED HERE RATHER THAN QUIETLY REPLACED**, because
the mistake is the instructive part. It had the device display a code, the user type it into the Mac,
and the Mac prove agreement with an HMAC. The flaw: **that proof is computable by any peer that
completes the ECDH**, since it derives from the shared secret alone. So an attacker in range could
answer the open window, compute a valid proof **without ever seeing the code**, and be stored — in
milliseconds, before the user could look at the screen. The displayed code defended the user's *Mac*
against a man-in-the-middle, and gave the *device* nothing: it never received evidence that any human
had read the code at all. The claim "the device never receives a guess at the code" was true and
irrelevant.

The fix is that **a human act on the glass, bound to this specific peer, is what commits the key.**

```
DEVICE                                             MAC
  |                                                 |
  |  user taps SETTINGS > Pairing > PAIR NEW MAC    |
  |  -> pairing window opens, 120s                  |
  |                                                 |  user picks the device from a scan list
  |         <---- PAIRREQ <hostId> <pubA> <label>   |
  |  generate keypair (b, B)                        |
  |  shared = X25519(b, A)                          |
  |  code   = HKDF(shared, "deckhand-sas/1") 6 dig  |
  |  key    = HKDF(shared, "deckhand-key/1") 16 B   |
  |  DISPLAY code + label + CONFIRM / CANCEL        |
  |         PAIRPUB <pubB> ---->                    |
  |                                                 |  shared, code', key' derived identically
  |                                                 |  DISPLAY code' + Match / Don't match
  |                                                 |
  |   the user reads BOTH screens and compares the two codes
  |                                                 |
  |         <---- PAIROK <HMAC(key', "pairok")>     |  (user clicked Match)
  |  verify proof with pairCtEq -> proofOk = true   |
  |                                                 |
  |  user taps CONFIRM on the glass -> confirmed    |
  |                                                 |
  |  COMMIT only when proofOk AND confirmed         |
  |  store key in the NVS slot for hostId           |
  |         PAIRDONE ---->                          |  store key in deckhand-secret
```

The two conditions may arrive in either order; neither alone commits anything.

### Why this is sound

- **Passive eavesdropper** sees two public keys and nothing else. The code is on two screens, never on
  the wire. Recovering the shared secret from the public keys is the ECDH problem.
- **A racing attacker** — the attack that killed the first design — now fails. It can complete the
  exchange and send a valid proof, but the device displays **its** code, the user's Mac displays a
  different one, the codes do not match, and the user taps CANCEL. Nothing is stored.
- **Active man-in-the-middle** must run two exchanges, which produce two different shared secrets and
  therefore two different codes. Same outcome: the screens disagree and the user cancels.
- **Nothing commits without a tap on the glass** naming the peer it commits. That is the presence
  proof, and unlike the first design it is bound to *which* peer rather than merely to *some* pairing
  having happened.
- The HMAC proof is kept as defence in depth: it tells the device that the peer which sent it is the
  same peer that did the ECDH, which the human comparison alone does not establish.

### Deliberate properties

- **`PROVISION` over USB is unchanged and stays.** This is an addition. A cable still works, and it
  remains the only path on board 1.
- **BLE `PROVISION` is still ignored.** The rule that a raw secret may never arrive over the radio
  is untouched — the new path never sends one.
- **The device displays the requesting Mac's LABEL beside the code.** An attacker who wins the race
  to the open window can DoS it, but the user sees a name they do not recognise and cancels. The
  label is attacker-controlled text: it is sanitised to ASCII `0x20..0x7E` and capped like every
  other field that crosses this wire, and it is display-only — nothing keys off it.
- **One exchange at a time; the window is 120s; any completed or failed exchange closes it.** A
  fresh `PAIRREQ` during an open window replaces the pending one (so a lost first attempt is
  recoverable) but the code changes with it, which the user sees.
- **The window closes on tab switch, sleep, or CANCEL.** A device left in pairing mode because
  someone wandered off is the one state that would weaken the presence guarantee.

### Rejected alternatives, so they are not re-proposed

- **Sending the secret over BLE with the user confirming on the device.** Confirmation does not
  help: a passive listener has already copied the secret by the time anyone confirms.
- **A static code printed in the firmware or derived from the MAC.** Anyone who reads the source
  or sees the device name knows it. A per-exchange code derived from the shared secret is the point.
- **SPAKE2 or another PAKE.** Correct for a device with no display, where the code must be
  pre-shared and typed on both ends. This device HAS a display, which makes plain ECDH plus a
  derived code simpler and equally strong.
- **Trusting BLE bonding.** The reason this repo runs its own HMAC scheme in the first place.

## Interoperability is the risk that must be tested, not argued

The device derives with `mbedtls` and the Mac with node `crypto`. Both must produce **byte-identical**
shared secrets, codes and keys, or pairing fails in a way that looks like a UI bug. There is
precedent for exactly this claim being tested rather than assumed — the answer HMAC is recorded as
"ESP32 `mbedtls_md_hmac` on one side, Node `crypto.createHmac` on the other, **verified
interoperable**".

Both sides are available, confirmed by reading the installed toolchain rather than assuming:
`CONFIG_MBEDTLS_ECP_DP_CURVE25519_ENABLED 1`, `CONFIG_MBEDTLS_ECDH_C 1` and `CONFIG_MBEDTLS_HKDF_C 1`
are set in `esp32s3-libs/3.3.11/dio_opi/include/sdkconfig.h`, the variant board 2 links; node has
X25519 via `crypto.diffieHellman` and `crypto.hkdfSync`.

**A fixed test vector must be pinned on both sides** — a known private key pair, its expected shared
secret, code and key — so a future toolchain change that alters any derivation fails loudly instead
of silently breaking pairing.

## Wire format

Device-bound, so ASCII only and inside `feedChar`'s byte guard. Public keys are 32 raw bytes sent
as 64 hex characters.

```
PAIRREQ <hostId:8hex> <pubA:64hex> <label...>     Mac -> device   (~90 + label)
PAIRPUB <pubB:64hex>                              device -> Mac   (72)
PAIROK  <hmac:32hex>                              Mac -> device   (40)   "the user clicked Match"
PAIRDONE <hostId:8hex>                            device -> Mac   (18)   sent only after CONFIRM
PAIRFAIL <reason>                                 device -> Mac
PAIRCANCEL                                        Mac -> device   (11)   the Mac walked away
```

`PAIRCANCEL` ships on both sides and is the Mac's half of the same courtesy `PAIRFAIL` is the
device's: without it a Mac that cancels leaves the device holding its window open, showing six
digits for a Mac that has gone away, until the 120s expires. It carries no argument and no address
(`buf == "PAIRCANCEL"`) — there is nothing to say beyond the fact — and outside an open window the
device answers `PAIRFAIL closed` rather than acting on it, the same refusal-with-a-reason shape
`PAIRREQ` gets. The 11 bytes are the line and its newline.

`PAIRDONE`/`PAIRFAIL` carry the trailing `to=<hostId>` address every device->host line already uses.
`PAIRREQ` is accepted **only** over BLE-or-USB while the window is open; at every other moment it is
ignored with a logged reason, the same shape as `POWERPROBE`'s "not on battery" refusal — from the
Mac, silence and impossibility look identical.

## User-visible flow

**Device:** SETTINGS → Pairing → `PAIR NEW MAC` → a full-screen pairing panel showing the 6-digit
code in `T_HERO`, the requesting Mac's label once one arrives, a countdown, and **CONFIRM / CANCEL**.
CONFIRM is inert until a request has actually arrived — there is nothing to confirm before that.

**Mac:** menu bar → `Pair new device…` → a scan list of nearby `Deckhand-XXXX` → pick one → a dialog
showing **its own derived code** and asking whether the device shows the same, with Match / Don't
match → success or a named failure. The user compares; nothing is typed.

## What this does not do

- It does not encrypt the BLE link. Payload confidentiality is unchanged and still absent by
  design; this protects the *decision*, exactly as the existing HMAC does.
- It does not replace `SELECT` — which device the host talks to is a separate choice from which
  devices it knows.
- It does not touch board 1.
