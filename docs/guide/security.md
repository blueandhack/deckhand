# Security of the remote

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## Security of the remote

Because the device can approve tool calls, the answer channel is
authenticated so that **only your paired Mac can make a decision** — a
stranger in Bluetooth range can't approve your prompts.

- **Unique name.** Each board advertises `Deckhand-XXXX` (from its MAC), so
  several units in one room don't collide, and your host connects only to
  the specific device it learned about over USB.
- **Signed answers.** The host and device share a 128-bit secret, generated
  by the host and pushed to the device **once over the trusted USB cable**
  (never over BLE). Every answer carries an HMAC over a per-prompt nonce the
  host issues, so a device that doesn't hold the secret can't forge an
  approval, and answers can't be replayed. Forged/unauthenticated answers
  are logged and dropped. The SETTINGS tab shows `paired` (secret provisioned)
  or `unpaired`.
- **One-time USB step.** Provisioning happens automatically whenever the
  device is on USB (which it is while flashing). A device that has only ever
  seen BLE can't be trusted to answer until you connect it via USB once.
- **Scope:** this protects the *decision* (integrity), not the
  confidentiality of the display data — the BLE link itself is unencrypted,
  so an eavesdropper in range could still read your session list and the
  prompt text. If that matters, use USB for the sensitive sessions. Full
  link encryption would need BLE bonding, which macOS + noble supports
  poorly (the reason this uses application-layer auth instead).

The secret lives in `~/.claude/deckhand-secret` (mode 600, machine-local,
never committed). Delete it to re-pair; the host regenerates one and
re-provisions over USB.

**Switching pairs.** To move the device to a **different Mac**, just plug it
into that Mac over USB with the host running — it re-pairs automatically (the
device announces its name, the new Mac provisions its own secret). To point a
Mac at a **different device**, connect the new device over USB. Two explicit
controls make switching clean:

- **Device › SETTINGS › ACTIONS › RESET PAIRING** wipes the device's stored
  secret so it reads `unpaired` and bonds fresh to the next Mac. Use it before
  handing the device to someone else.
- **Menu-bar app › Device › Forget device** drops the Mac's Bluetooth pin (it shows the
  paired device name too), so the Mac re-pairs to whatever device you next
  connect over USB.

Either way, re-pairing always needs a **USB connection once** — Bluetooth alone
can't provision (that's the security boundary).

**Two Macs at once.** One device can serve **two** Macs simultaneously over
Bluetooth, with sessions from both in the one urgency-ranked list. Setting up
the second Mac:

1. Install the host on the second Mac (`cd host && npm install`, then
   `./deckhand-service.sh install`) exactly as on the first.
2. **Connect the device to it over USB once, with the host running.** This is
   the whole pairing step — the Mac generates its own secret and pushes it with
   `PROVISION`, which is USB-only by design (BLE `PROVISION` is ignored, and
   that is the security boundary). The device stores it in its own slot, so the
   first Mac's key is untouched.
3. Unplug. Both Macs now hold their own key and talk to the device over BLE at
   the same time — each answers only its own prompts, and each signs with its
   own key.

The device remembers up to **4** Macs (`MAX_HOSTS`) but talks to **2** at a
time (`MAX_LINKS`) — a deliberate choice made well inside the Bluetooth
controller's own ceiling of **3** concurrent BLE connections
(`CONFIG_BTDM_CTRL_BLE_MAX_CONN`), not the controller's limit itself. A third
Mac trying to connect is refused, not queued.

While two Macs are connected, each session row and the detail screen carry a
short tag saying which Mac the session lives on (`CLAUDE/air`, `CC/studio`),
and the USAGE cards name the Mac whose quota reading they are showing. That tag
is derived from the Mac's hostname — its last segment, lowercased, capped at 6
characters — so `Yujias-MacBook-Air.local` becomes `air`. Set
`DECKHAND_MAC_TAG` in the host's environment to name a Mac yourself (it is
sanitised and capped to the same 6 characters, and is taken whole rather than
split on separators). With only one Mac connected the tag is omitted entirely,
since it would disambiguate nothing.

**Giving a Mac its own icon.** Each Mac can also carry a small 13x13 colour
icon, which the device draws on tall session rows, both USAGE cards, the Codex
row, SETTINGS › STATUS and the session detail card. Unlike the text tag, the
icon shows even with **one** Mac connected — a tag that disambiguates nothing is
noise, but an icon is yours.

Two ways to set it:

- **The menu-bar app**: Settings › **Mac icon**, and pick one. It takes effect on
  the device within a tick (~5s).
- **The environment**, which is the provisioning path — put it in the host's
  LaunchAgent plist so it survives reinstalls:

  ```xml
  <key>EnvironmentVariables</key>
  <dict>
    <key>DECKHAND_MAC_EMOJI</key>
    <string>rocket</string>
  </dict>
  ```

  (`launchctl unload`/`load` the job, or `./host/deckhand-service.sh stop` then
  `start`, for it to be read.)

The sixteen valid names:

```
rocket  moon     star     bolt
fire    leaf     wave     anchor
crab    laptop   desktop  cloud
sun     cat      apple    gear
```

**`DECKHAND_MAC_EMOJI` wins over the picker.** With a valid name in the
environment the menu's submenu reads *Mac icon (set by env)* and its entries are
disabled, rather than offering a checkmark that a click could not move. Unset it
if you want to choose from the menu again.

An **unknown name** (a typo, or a name from a newer host than the device's
firmware) sets no icon at all: the Mac drops it, and the device falls back to the
text tag described above. Nothing errors, so if an icon simply never appears,
check the spelling against the list first. `laptop` and `desktop` are the two
that are hard to tell apart at this size — they differ mainly in brightness — so
if both your Macs are computers, pick two shapes instead.
