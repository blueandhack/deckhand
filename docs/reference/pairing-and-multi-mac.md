# Pairing keys, wireless pairing, and two Macs at once

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](README.md). The rules an agent must not miss stay in
[`../CLAUDE.md`](../CLAUDE.md).

---

- **Remote-answer authentication (A + B), so only the paired Mac can decide.** (A) The device
  advertises a unique name `Deckhand-XXXX` (from its eFuse MAC) and the host, having learned that
  exact name over USB (`HELLO <name>`), pins BLE to it — no cross-connecting to another unit in
  the room. Because the longer name plus the 128-bit service UUID overflow the 31-byte BLE
  advertisement, the firmware **does not advertise the service UUID** (the host matches by name
  anyway). (B) Host and device share a 128-bit secret, pushed to the device **only over USB** via
  `PROVISION` (stored in NVS; BLE `PROVISION` is ignored — the whole point). Each forwarded `ask`
  carries a per-prompt `nonce`; the device returns `ANSWER … <hmac>` where hmac =
  HMAC-SHA256(secret, `nonce:pid:idx`)[:16] — ESP32 `mbedtls_md_hmac` on one side, Node
  `crypto.createHmac` on the other, **verified interoperable**. The host rejects answers with a
  bad/missing MAC and consumes the nonce on success (single-use, no replay). This protects the
  *decision*, not the confidentiality of the (still-unencrypted) BLE data — deliberate, since
  macOS + noble handle BLE bonding poorly.
- **Multi-pairing: one key per (Mac, device) couple.** Both sides remember several partners, each
  with its **own** key, so forgetting one revokes only that pair and a leaked key can't
  authenticate anything else. The Mac has a stable `hostId` (8 hex) that it sends on `PROVISION`
  **and in every payload**; the device uses it to pick which stored key to sign an answer with, so
  a device shared between Macs always answers the one that asked. An unknown `hostId` leaves
  `activeHost = -1` and `authHmac()` refuses to sign — the host then rejects the unsigned answer,
  which is the safe direction. Host store (`~/.claude/deckhand-secret`, mode 600) is
  `{version:2, hostId, devices:[{name,secret,label,lastSeen}], selected}`; v1 `{secret, device}`
  files migrate in place **keeping the old key**, so an existing pair survives the upgrade.
  `savePairing()` also `chmod`s every write — `writeFile`'s `mode` only applies on creation, so a
  pre-existing file would otherwise keep loose permissions. Device stores up to `MAX_HOSTS` (4)
  NVS slots (`h<i>id`/`h<i>sec`/`h<i>lb`, plus `hallow`), and migrates the legacy single
  `blesecret` into slot 0. Answer verification is **per transport**: `deviceNameFor(via)` keys off
  the BLE peer we connected to, or the USB name from `HELLO` — falling back to the selected device,
  since the `HELLO` burst is boot-only and we may have attached mid-run (a wrong guess just fails
  the HMAC).
- **Two Macs at once: `MAX_LINKS` (2) concurrent BLE links against `MAX_HOSTS` (4) pairing
  slots.** Remembering a Mac and talking to it at the same moment are different limits, and it is
  the radio that sets the smaller one. Stock Arduino esp32 3.3.11 ships
  `CONFIG_BTDM_CTRL_BLE_MAX_CONN 3` and `CONFIG_BT_ACL_CONNECTIONS 4` — read out of the installed
  libs rather than assumed — so two links need **no build-config change at all**, while four Macs
  would sit exactly at the controller's ceiling. Sessions from both Macs share one urgency-ranked
  list, a row is tagged with the Mac it lives on, an answer is signed with that Mac's own key and
  addressed to it, and USAGE shows whichever Mac's reading is fresher. Nothing about the pairing
  model changed: **pairing the second Mac still means plugging the device into it once**, because
  `PROVISION` is USB-only by design and stays that way. Every trap below fails **silently**, which
  is the reason this section is as long as it is.
  - **Bluedroid STOPS advertising the instant a central connects**, so without `onConnect`
    re-calling `startAdvertising()` a second Mac can never attach — and the symptom is not an
    error anywhere, it is a second Mac whose BLE scan simply never finds a device that is sitting
    right there, connected and healthy, to the first Mac. A third central is **refused, not
    queued** (`server->disconnect(conn)`), and a refusal deliberately does *nothing* further — no
    advertise, no state touched — because `onConnect` → refuse → advertise → `onConnect` storms
    until whichever condition clears. The 5s advertising watchdog in `loop()` is what resumes
    advertising once a slot really frees, so the quiet path costs a few seconds and the loud one
    would cost the radio.
  - **Two Macs write into ONE RX characteristic, so their 20-byte chunks interleave**, and a
    single `serialBufBLE` accumulator therefore turns *every* payload into corrupt JSON. The
    failure is the worst shape available: `handleLine` returns early on a parse error, so the
    screen just stops updating while both links, both heartbeats and both menu bars look
    perfectly healthy — the device-side twin of the stalled-tick bug the host's watchdog exists
    for. `onWrite`'s two-argument overload gives `param->write.conn_id`, and each chunk is framed
    into the existing 16KB stream buffer as `[conn_id][len16][bytes]`, demuxed by `loop()` into
    one accumulator per link. **The header and its payload go in atomically** — a chunk that will
    not fit whole is dropped whole — because a partial write desyncs every frame that follows,
    where the old unframed buffer merely lost some bytes; the host resends a full snapshot every
    5s, so dropping a whole chunk costs one tick. The one-argument `onWrite` form delegates and
    **drops the frame rather than guessing `conn_id = 0`**: guessing would file a second central's
    bytes onto slot 0's accumulator, which is precisely the corruption being prevented.
  - **Releasing a BLE link slot is DEFERRED to loopTask, because `onDisconnect` runs on
    BTC_TASK.** Clearing the slot's `String` buffer there frees memory `feedChar` may be appending
    into on loopTask right now — a cross-core use-after-free, which on this chip presents as a
    crash loop or corrupted text rather than as anything naming BLE. So `onDisconnect` sets
    `releasePending` on the slot and nothing else, and `reapBleLinks()` does the teardown.
    Two orderings inside it are load-bearing: the reap clears **`buf`, then `releasePending`, then
    `used`** — publishing slot freedom LAST closes the window where the allocator could hand out a
    slot whose buffer is still being cleared — and `bleSlotForConn()` matches neither a pending
    slot nor hands it out, because Bluedroid reuses small `conn_id` values immediately after a
    disconnect and a recycled id inheriting a pending slot lands straight back in the interleaving
    bug through the lookup instead of the drain.
    `reapBleLinks()` is also called from the **long blocking loops** — `micStream` (up to 120s),
    `micMonitor`, `runCalibration` (waits on a person), the `SCREENSHOT` readback — because
    `drainBleRx()` only runs from `loop()`, and for the whole duration of one of those calls
    nothing would reap a pending slot: a refusal caused by that still-pending slot would leave the
    device un-advertised for up to two minutes with no log line saying why. **Only those blocking
    call sites pass `mayAdvertise = true`**; the ordinary path passes false, since `onDisconnect`
    plus the 5s watchdog already cover it and advertising redundantly measurably perturbs
    reconnect timing. Reconnect after a disconnect measured **53–697ms across 8–9 trials, mean
    ~294ms**. (An earlier "~55ms" figure for the same thing rested on 2–3 samples and was not a
    real baseline — do not compare against it.)
  - **`authHmac`'s implicit `activeHost` means "whoever sent the most recent payload", which once
    two Macs are ticking is wrong about half the time.** The symptom is an intermittently rejected
    answer with nothing visibly broken anywhere: you tap Allow, the prompt sits there, and the
    next attempt works. Answers sign with `pairingSlotForRow(row.hostSlot)`, falling back to
    `activeHost` **only** when `hostSlot` is not a valid link index — a payload carrying no
    `hostId` leaves `info.hostSlot = (uint8_t) -1` = 255, deliberately `>= MAX_LINKS` so it can
    never alias a real slot — which is what keeps a legacy host answerable at all. In the two-Mac
    case `hostSlot` is always a real link index and the fallback is a pass-through.
  - **`voiceSeq` is PER-LINK, and sharing it disables the voice card continuously rather than
    once.** It is a host-lifetime counter starting at 1, and the device already reads a
    *backwards* seq as a new host generation (the host-restart case documented under the voice
    card). Two independent counters against one shared high-water mark trip that reset on nearly
    every tick, so the card never raises and a processing bar has nothing that can ever end it.
  - **Sessions merge into ONE 6-row pool, because per-Mac arrays are arithmetically impossible.**
    A `SessionInfo` is ~2.2KB, so a second array is 13.4KB against ~26KB of free heap — the same
    budget the audio path's capture buffer comes out of. Each tick frees only **the sending Mac's**
    rows (wholesale replacement made the list flap between the two Macs) and admits its new ones,
    which arrive already urgency-sorted by that host. When the pool is full the eviction victim is
    the **max-rank** row and eviction requires **strictly better** urgency, so an `asking` row can
    never be evicted at all (its rank is 0, and nothing can beat it), and the first incoming row
    that fails ends the walk. Ranking is an **INDEX sort** (`sessionOrder[]`), never a value sort:
    a value sort would memmove tens of KB of `SessionInfo` every tick. The device now owns the
    cross-Mac ranking, which each host can only ever apply to its own list. A link silent for
    `LINK_STALE_MS` (21000ms, ~4 missed ticks) has its rows **DROPPED, not dimmed** — showing an
    unreachable Mac's prompt as answerable is the worse failure, and dropping is what keeps the
    footer's single "Xs ago" honest.
  - **`hostSlot` is in the row's repaint signature and the Mac tag is in the detail signature —
    for identity, not length.** Two same-named sessions on different Macs at the same display
    position share every other field, so without it the row keeps whichever Mac's tag was drawn
    first; and because `dispMacTag()` returns "" until a second Mac shows up, a `usedLinkCount()`
    flip changes the signature for free. Cache sizes, since `drawIfChanged`-style comparisons only
    look at `cacheSize` bytes and a short cache silently stops noticing changes past that point:
    `rowSigCache` is **176** against a 125-byte worst case, and `detailSigCache` is **384** against
    a field-by-field-derived **352** — the re-derivation the previous 368-against-~350 note demanded
    actually happening once the icon id was appended, so do the same again on the next field rather
    than assuming it still fits.
  - **The Mac tag's separator is an ASCII `/`, not a middle dot** (`CLAUDE/air`, `CC/air`), because
    Cozette is 0x20–0x7E only and U+00B7 draws as a blank box — the same constraint that already
    forces `fitText`'s three-dot ellipsis. The tag is built **once** into `agentTag[]` and both
    drawn and measured from that one buffer, so a wider tag drops the name a rung down the
    12x26 → 10x18 → 6x13 ladder instead of being overlapped by it. It appears only when
    `usedLinkCount() > 1`: with one Mac the row reads plain `CLAUDE`, never a dangling `/`, because
    a label that disambiguates nothing is how you *stop* noticing the second Mac arriving.
  - **USAGE takes the fresher reading PER SOURCE and names the Mac it came from.** Both Macs poll
    the same account, so the numbers agree and the only real difference between them is AGE
    (`mergeUsage()`: Claude by `quotaAgeSec`, Codex independently by `cxAgeSec`, which is already
    how the Codex row judges staleness). That also makes the two Macs each other's staleness
    backup — a Mac in a long OAuth back-off is simply out-aged by the other — and it keeps a future
    divergence (different accounts) visible as a number that changes *label* rather than a silent
    average. A negative age means "never measured" and must never win against a real reading, which
    a plain `<` comparison on -1 would let it do. **A source change moves no digits, so it must bust
    the cache itself** (`srcCache`/`cxSrcCache` → `drawUsageStatic()`) — the identical trap the
    stale-dim flip has. And `mergeUsage()` **re-runs after `pruneStaleLinks()`**, or a departed
    Mac's percentages stay on screen indefinitely with a tag naming a Mac that is gone.
  - **The Mac's short tag is derived ON THE MAC** (`macTag()` in `host/host-tag.mjs`, published as
    `hostTag`, overridable with `DECKHAND_MAC_TAG`) and **capped at 6 characters there**, not
    trimmed on arrival, because it is drawn into a lane the device measures. Two asymmetries are
    deliberate: an override is a user-supplied *tag*, so it is sanitised **whole** and never split
    on separators, while a hostname is an OS name whose distinguishing part is its **last segment**
    (`air` vs `studio` in Apple's defaults) — and that segment is taken **even when it is one
    character**, since `Mac-Studio-B` really is "b". `host/host-tag-check.mjs` pins all of it.
  - **A Mac can also carry a 13x13 ICON, and the NAME is what crosses the wire — never the
    character.** `Cozette6x13` declares `0x20, 0x7E`, the same fact that already forces `fitText`'s
    three ASCII dots and the tag's ASCII `/` separator, so an emoji cannot be a glyph on this
    device: an icon is **artwork**. `DECKHAND_MAC_EMOJI` or the menu-bar picker resolves to one of
    sixteen names on the Mac (`resolveMacEmoji` in `host/mac-emoji.mjs`), the name rides every
    payload as `hostEmoji`, and the device turns it into a sprite index with `macEmojiIndex()` (a
    linear scan over 16 entries, run once per payload). Put the CHARACTER on the wire instead and
    you are feeding multi-byte text into `feedChar`'s line buffer, an ask sanitiser that blanks
    every control byte, and a struct of fixed `char[]` fields that `copyField` truncates by BYTES —
    all of it ASCII-oriented end to end. An unknown name is dropped on the Mac (`resolveMacEmoji`
    returns "") and returns -1 on the device, and **both** fall back to the text tag rather than
    drawing nothing.
  - **THE ICON SIZE IS THE BODY FONT'S CELL HEIGHT, and it is therefore PER BOARD: 13 on board 1
    (Cozette 6x13), 16 on board 2 (Spleen 8x16).** That identity is the whole design: an icon's `y`
    **is** its neighbouring text's `TL_DATUM` y, with a 4px gap, at all six sites that draw one
    (tall session rows, the two usage cards, the Codex row, SETTINGS › STATUS, the detail card), so
    no site carries a centring term. Which is why **`drawEmoji`'s `(x, y)` is the TOP-LEFT corner**,
    deliberately unlike `blit2bpp`'s centre convention — a centre-based signature would put the same
    `- MAC_EMOJI_SIZE / 2` at all six.
    `emoji2c.py` takes `--size` (default 13, so an argument-less run still emits board 1's header
    byte for byte) and the sketch picks `MacEmoji.h` or `MacEmoji16.h` behind `BOARD_USES_TFT_ESPI`.
    **The two headers cannot both be included** — they define the same
    `MAC_EMOJI_SIZE`/`STRIDE`/`COUNT`/`NAMES` — which is correct rather than awkward: exactly one
    size is right for a given panel. `--verify` reads `MAC_EMOJI_SIZE` back out of the header it is
    handed and re-renders at THAT size, so a header can never be checked against the wrong geometry.
  - **16px COLLIDES WITH A CLEAR BOX ON BOARD 1 AND NOT ON BOARD 2, which is the reason the number
    could not simply be raised everywhere.** A usage card's label row is the tightest site on both:
    the icon spans `CARD_LABEL_Y`..`CARD_LABEL_Y + MAC_EMOJI_SIZE - 1` against a hero box that
    clears from `CARD_HERO_Y` across the full card interior. Board 1's hero starts at `y0+20`, so a
    16px icon (`+6`..`+21`) would be rubbed out by the hero's own erase on every tick the digits
    move — the same clear-box-not-glyphs arithmetic the `+88` stats row documents. Board 2's hero
    started at `y0+24` (`CARD_HERO_Y`), so 16px (`+6`..`+21`) cleared it by 2 rows — **stale since
    the USAGE v2 redesign, where `CARD_HERO_Y` is dead on board 2** (read only inside the v1
    `#if !BOARD_USAGE_V2` `renderCard`) and the live NOW card's hero starts at `y0+26`
    (`NOW_HERO_Y`), which the icon clears by **4 rows**. Clearance at the other five,
    all re-derived at 16px rather than assumed: `sessions.ino` tall-row tag `+9`..`+24` against a
    pill no higher than `+31` on the shortest tall row (**6 rows**); `settings.ino` Mac rows clear
    `+129`..`+146` and `+153`..`+170`, the icon inside the first (**7 rows** to the next);
    `usage.ino`'s Codex row `+8`..`+23` inside a text clear of `+7`..`+24` against a border at
    `+54` (**30 rows**); the detail card's AGENT column was the last block in a stack packed to 320
    of 326 (**board 2's detail card no longer has that column at all** — §7 put the Mac on the
    single meta line instead, where the icon's `y` IS the line's `y` by the same rule, and the
    card ends at 300 with the meta ink at `+280..+295`; board 1 keeps the column). Horizontally
    the icon is 3px wider, absorbed everywhere: the Codex lane already reserves
    four monospace spaces (32px on board 2 against `4+16+4` = 24 needed), the SETTINGS erase box
    grows to 246px from x=30 inside an interior of 305, the session row's name lane already
    subtracts `tagExtra`, and the detail column needs 96px of 126 (on board 2 the meta line
    measures the Mac cluster FIRST and `fitText`s the facts into whatever lane is left, so no
    width can collide there however long a model or branch name is).
  - **Cost: 390 bytes per icon on board 1 (338 colour + 52 alpha), 576 on board 2 (512 + 64) —
    6,240 and 9,216 for all sixteen, and the measured board-2 flash delta was +2,944 with RAM
    unchanged** (the art is `PROGMEM`). The alpha figure is where the original design spec was
    wrong: it budgeted **43** bytes, which is 13x13 = 169 two-bit samples packed as one continuous
    bitstream (42.25 bytes). `drawEmoji` unpacks each row independently at
    `alpha + py * ((n + 3) / 4)`, so the stride must be a whole number of **bytes per row** —
    `MAC_EMOJI_STRIDE`, which is 4 at both 13 and 16 pixels, the identical packing `blit2bpp`'s
    other art uses. A continuous bitstream would save 9 bytes an icon and cost a bit-offset
    multiply in the inner loop of a blitter that already works a row at a time.
  - **Colour and alpha are SEPARATE planes and the backdrop is a draw-time argument.** The same
    icon has to sit on a card fill, a session row and the page background, in **two** themes;
    baking one background in is exactly what gives `ClawdCrab.h` its documented fringe under
    LIGHT. `drawEmoji` blends per pixel against the `bg` the caller names, composing one row into a
    13-entry buffer pushed with `setSwapBytes(true)` — the same byte-order handling `drawLogo`
    needs, and for the same reason.
  - **The icon id had to enter FOUR caches, and the symptom of missing any one is a card or row
    that keeps a stale icon forever — except on the Codex row, which needs none of this.** An icon
    change moves no text, no percentage, no source link and no link count, so the change-only
    redraw discipline correctly skips a field whose pixels are now wrong. The four: the **row
    signature** (`rowSigCache`, so a row whose Mac's icon changes repaints); the **detail
    signature** (`detailSigCache`, 368 → **384** against a field-by-field-derived 352 worst case);
    the **Claude cards' usage chrome bust** (`emojiCache` beside `srcCache`/`pinCache`/`linksCache`
    → `drawUsageStatic()`, because a Claude card's label is static chrome, repainted only on that
    bust, and never redraws its icon on its own); and the **SETTINGS link row's cached string**,
    where the id rides after a `\x01` sentinel that is never drawn, because that cache compares
    TEXT and the icon is drawn separately from it. That row's erase box also reserves the icon's
    slot (4px +
    13px) whether or not the row currently has one, so an icon that disappears leaves no ghost.
    The Codex row is the exception: `renderCodexRow()` draws its icon unconditionally every tick
    rather than behind a `drawIfChanged` of its own, and the label's clear box (x 25..93) already
    covers the icon's slot (42..54) on every redraw — so a stale Codex icon self-heals with no
    cache to bust, and carrying one anyway would only buy an avoidable full-chrome repaint.
  - **The pin bar is ABOVE the icon at rows `y0+3`..`y0+5`, and it is a BAR rather than an
    underline because below the icon is `y0+20` — inside the hero number's box.** Geometry, all of
    it forced: the 2px card border owns `y0`..`y0+1`, one clear row at `+2`, bar `+3`..`+5`, icon
    `+6`..`+18`, hero box from `+19`. It exists because pinned-vs-auto used to ride the **tag's
    colour**, which a colour sprite cannot carry — so PRESENCE became the carrier instead of hue.
    It is nested inside the icon's own `if`, which makes a stripe with no icon under it
    structurally impossible rather than merely unlikely.
  - **Icons are NOT gated on `usedLinkCount() > 1`; the text tag still is.** An icon is
    personalisation — someone deliberately marked THEIR computer, and it should show with one Mac
    connected. A redundant six-character word beside a single Mac's card is noise, and a tag that
    only appears when the second Mac arrives is how you *notice* the second Mac arriving.
    **The Codex row keeps its window text alongside its icon, too** — an icon is drawn OVER a
    reserved gap in the same line rather than in place of anything, so setting one no longer makes
    the row drop the fact of what its percentage measures. It's only the Mac tag that still yields
    to the icon there, the same trade every other site makes between the two.
  - **A tall session row now identifies its Mac TWICE — icon in the corner, text tag in the
    sub-line — and that redundancy is deliberate.** Only the tag changed; the icon was added
    beside it rather than in place of it. The two cannot disagree, because both read the same
    `hostLinks` entry inside one synchronous draw, and the pairing is what makes the icon
    self-teaching on the screen you look at most: you learn which sprite means which Mac from the
    row that also spells it out.
  - **The strongest argument for this whole feature was found by accident: the derived text tag
    COLLIDES between similarly-named Macs.** `macTag()` takes the hostname's **last segment**, so
    every "…-MacBook-Pro" resolves to `pro` — and this machine's two Macs are both MacBook Pros,
    so both `used` link slots showed the tag `pro` at once. That is **not** a duplicated row: two
    slots can only coexist with different `hostId`s (a same-`hostId` payload would have matched the
    existing slot instead of allocating a second), so it is two genuinely distinct Macs that text
    alone cannot tell apart. The icon can.
  - **THREE hand-transcribed copies of the sixteen names exist, and `host/mac-emoji-check.mjs`
    compares all three** — `firmware/deckhand_display/MacEmoji.h` (generated by `emoji2c.py`, and
    canonical: the device can only draw what is in it; `MacEmoji16.h` carries the same sixteen
    names, since only the CHARACTERS may differ per size), `host/mac-emoji.mjs` (the only Mac-side
    validator), and `MAC_ICON_NAMES` in `mac-app/DeckhandMenuBar.swift` (the picker's display
    order). Divergence is silent in **both** directions, which is why this is a check and not a
    sentence asking for care: a name valid on the Mac and absent from the header resolves fine,
    crosses the wire, and shows as **no icon at all** with no error on either side, while a name in
    the header that Swift omits is simply unpickable. The check parses the file TEXT with regexes
    (two of the three cannot be imported by node) and names the file and the direction it
    disagrees in; it also compares its own parse of `mac-emoji.mjs` against the **imported** array,
    so a regex that has stopped matching fails loudly instead of passing three empty lists against
    each other. Order-only divergence fails too, and the message says plainly that it is not itself
    a display bug — the wire carries the name, never an index — only evidence that one list was
    edited without the others. `emoji2c.py --verify` covers the remaining edge, generator against
    generated header.
  - **The PICKER SHOWS THE PICTURE, and that adds a FOURTH table — of characters, not names.**
    A submenu of sixteen bare words is the same problem `--sound-check play` already fixed for
    sounds: `wave`, `bolt` and `anchor` are a guess until you see them, so each row now reads
    `🌊  wave` and the `Mac icon` parent carries the current pick's glyph, which is also the only
    way an env-set value's *picture* is visible on a row whose children are deliberately disabled.
    `MAC_ICON_GLYPHS` in `mac-app/DeckhandMenuBar.swift` is **display-only** — `pickIcon` still
    writes `EMOJI <name>`, and the device still draws baked artwork because Cozette cannot render
    an emoji glyph at all — so a wrong entry is a wrong picture in one menu, never a broken icon
    on the device. What it *can* do is offer a picture the device no longer draws, silently and
    forever, since the names are frozen and choosing a different CHARACTER is the only lever a bad
    icon has; so `mac-emoji-check.mjs` compares it against **`ICONS` in `emoji2c.py`** — the
    generator, the only place recording which character the art was rendered FROM, where
    `MacEmoji.h` holds pixels and has forgotten. Both fault injections were run: a swapped glyph
    and a dropped row each fail by name. Two details: the entries are written as `\u{...}` escapes
    because every one ends in an **invisible** U+FE0F (the variation selector that stops `gear`,
    `desktop`, `sun` and `star` rendering as flat text glyphs, and exactly the character an editor
    silently eats), and mismatches print CODEPOINTS rather than characters, or the failure reads as
    two identical emoji side by side. `SIZE_OVERRIDES` is deliberately **not** reflected here — the
    Mac cannot know which board it is talking to and may be talking to both, so the menu shows the
    base character each override was chosen to keep describing. The parser also had to anchor its
    opening bracket PAST the marker, because Swift's `[String: String]` type annotation opens one
    first and `namesFrom`'s anchoring reads the table as empty.
  - **A broken icon is fixed by giving the same NAME a different CHARACTER, and at 16px two were.**
    The names are the wire format, so they can never move; `SIZE_OVERRIDES` in `emoji2c.py` is the
    only lever, and it is keyed by SIZE because **board 1's 13px set is frozen** — its binary is
    unchanged by the per-board split and respinning its art would spend that for a judgement only a
    board 2 screen can make. Both changes were measured on all four real backdrops
    (DARK/LIGHT x BG/CARD) as **CIE Lab ΔE of the composited ink against the backdrop**, not WCAG
    contrast: contrast is a luminance ratio, and it calls a perfectly legible yellow `star` on white
    a failure at 1.9:1 while saying nothing about hue. Then looked at on the glass, which is the
    authority — a `keyboard` glyph beat both winners on every number and was rejected because at
    16px it draws as a featureless grey bar with no keys, the same way `robot` read as a cupcake.
    - `cloud` **U+2601 → U+1F326** (sun behind rain cloud). A white cloud on LIGHT is the one
      genuine INVISIBILITY in the set: ΔE90 **15.6** with **5%** of its ink clearing ΔE 20 on a
      LIGHT card. Note LIGHT's `COLOR_CARD` is pure white, so this is **every shipping surface**,
      not just the `EMOJITEST` screen the older note blamed. Apple's whole cloud family is white,
      so no cloud glyph fixes it by being darker — U+1F326 fixes it by carrying a yellow sun and
      blue rain, i.e. HUE the white body does not have. ΔE90 goes **15.6 → 53.8** on a LIGHT card
      and **12.2 → 51.0** on the LIGHT page, and the cloud is still the dominant mass.
    - `desktop` **U+1F5A5 → U+1F4FA** (television). `laptop` and `desktop` were BOTH a black screen
      over a light base — and they are exactly the two a MacBook and a Mac Studio reach for, so the
      one case the icons exist for was the one they could not serve. Measured as mean per-pixel ΔE
      **between** the two icons on the same backdrop, U+1F5A5 was the least distinct candidate
      tried on every backdrop (**20.3–22.0**, against 25.2–25.8 for the television and 29.5–36.8
      for the rejected keyboard). A television is a different OBJECT rather than a differently-lit
      screen, and it reads on all four backdrops (**86–96%** of ink clearing ΔE 20, against
      **53%** for the monitor on a DARK card, whose black screen simply disappears there). The
      picker lists NAMES only, so nothing on the Mac disagrees with the new picture.
    - **`anchor` was NOT changed, and the older note grouping it with those two is wrong at 16px.**
      It measures ΔE90 65.0 with **93%** of its ink clearing ΔE 20 on the DARK page and 90% on a
      LIGHT card. Its 13px problem was **stroke width** in thin line art, which 51% more pixels
      resolved — not a colour that needed replacing. `laptop` keeps U+1F4BB: it is the unambiguous
      picture for its own name, and the collision is fixed by moving the icon that had an
      alternative.
    - **What is NOT verified on the panel: the DARK theme at 16px.** The device was pinned to
      LIGHT, and there is **no host command that changes the theme** (nor one that dismisses
      `EMOJITEST` — see below), so the go/no-go screenshots are LIGHT-only. LIGHT is the harder
      case for `cloud` and was captured; `desktop`'s 53% → 86% gain is on DARK and rests on the
      measurement plus `--preview`, not on the glass. Tap the theme button and re-run
      `EMOJITEST` + `SCREENSHOT` to close it.
  - **`EMOJITEST [<name>]` puts all sixteen on BOTH backdrops**, for the same reason
    `TAB`/`PAGE`/`KBTEST` exist: `SCREENSHOT` can only record what is currently on the glass, and
    an alpha blend plus the `setSwapBytes` handling can only be judged where they actually have to
    work, never on a third colour picked for convenience. There is no `large` argument or any
    other second mode — an unrecognised word simply falls through to the same all-sixteen grid,
    which is also what plain `EMOJITEST` draws. **NOTHING DISMISSES IT REMOTELY, and that bites a
    headless capture session.** `emojiTestActive` is cleared only by a TAP (in `handleTouch`), while
    `switchTab` returns early with it set — so `TAB`/`PAGE` are refused, every later `SCREENSHOT`
    returns the same frozen frame (identical footer clock is the tell), and the only remote escape
    is a re-flash, which reboots the device. Verify `EMOJITEST` LAST in a capture run, or budget an
    upload to get out. Not fixed here because `handleTouch`/`switchTab` are shared code and board 1's
    binary is being held byte-identical; a `TAB` that also clears the flag would be the fix.
    It refuses while the keyboard, reader, history
    pager or a session detail screen owns the glass, the same guard `fabVisible()` already paid
    for once: `emojiTestActive` dismisses on any tap ahead of those surfaces in `handleTouch`, and
    without the refusal a tap on the grid opened over an active keyboard force-repaints the tab
    underneath while `kbActive` stays true, leaving every further tap typing invisibly.
  - **Env beats the picker, and the MENU SAYS SO rather than showing a checkmark it cannot
    honour.** With `DECKHAND_MAC_EMOJI` set to a valid name the submenu parent reads **`Mac icon
    (set by env)`**, followed by the resolved glyph, and every child is disabled — a checkmark a
    click could never move is a lie, while the glyph on the parent is the one thing that can still
    say WHICH icon won without implying a click could change it.
    The menu bar learns both facts from the **host's heartbeat** (`icon`, already fully resolved,
    and `iconFromEnv`), never by reading the plist or launchd's environment, which would be a third
    source of truth after the env var and `~/.claude/deckhand-mac-emoji`. `iconFromEnv` is computed
    by re-running the **same resolver** with the file blanked, so a typo'd env name — which
    overrides nothing, because only a valid name wins — cannot claim an override that isn't
    happening. The `EMOJI <name>` command is host-side only and never forwarded: the device learns
    the icon from `hostEmoji` in the payload, the same way `FORGET` is intercepted.
  - **A dead `macEmojiId` global was removed during this work**: it was written every tick and read
    nowhere, while its comments described a wiring that did not exist. Declared-but-unwired state
    whose comments claim it works is a defect class this repo has already paid for, so it is
    deleted rather than left for the next reader to trust.
  - **OPEN BUG, in already-merged multi-host code and NOT introduced by the icons.** After a
    synthetic `MULTITEST` link drops (`LINK_STALE_MS`, 21s), the **two Claude usage cards freeze on
    a wrong reading** — observed 0% "starts on use" and 4% / 31.93M tok — while the **Codex row
    recovers correctly** with the real Mac's icon and its genuine value. `host.log` confirms the
    real host was reporting 26–27% / 33% throughout, so the numbers on screen were never sent.
    Reproduced across separate sessions, including after two full device reboots. Consistent with
    `usageSourceLink` and `cxSourceLink` ending up pointing at different links after
    `pruneStaleLinks()` and the re-merge, i.e. the `mergeUsage()`/`pruneStaleLinks()` area in
    `deckhand_display.ino` — **not** `usage.ino`'s chrome logic, which only reads those two links.
    Repro: `MULTITEST 2`, wait past 21s for the synthetic link to age out, `SCREENSHOT` the USAGE
    tab, compare against the host log's own `5h=`/`7d=`/`codex=` fields for the same minute. Unfixed and
    undiagnosed: it predates this branch and deserves its own systematic pass rather than a
    side-quest.
  - **The host drops a device line addressed to another Mac BEFORE logging it.**
    `BLECharacteristic::notify()` iterates `getPeerDevices()` and sends per peer with **zero
    references to the server's `m_connId`** — verified in the installed library source; there is no
    single-peer notify in this API — which is *why* every device→host line carries a trailing
    `to=<hostId>`. Without the filter the other Mac logs an authentication failure on **every**
    answer, which trains you to ignore the one log line that means something (the same problem the
    duplicate-`PROMPT` dedup already exists for, but firing constantly instead of occasionally).
    Absent, empty or unparseable addresses read as **BROADCAST**, deliberately asymmetric:
    wrongly dropping an answer strands a blocked prompt, while wrongly accepting one merely logs a
    line twice. Trailing is also deliberate — the host parses with `startsWith` plus a positional
    `split`, so an un-upgraded Mac ignores the extra token instead of breaking on it. `BATT` and
    `HELLO` stay unaddressed on purpose: both Macs want the battery, and an addressed `HELLO`
    would break pairing with a Mac that does not yet know the device's name.
  - **The audio lane is addressed to the Mac on the CABLE (`primaryLink()`), NOT to the target
    session's Mac** — which looks wrong at a glance and is the only correct choice. Audio is
    USB-only by rate (~8KB/s of IMA ADPCM against this CH340's 11.5KB/s ceiling), so with Mac A on
    USB and Mac B on BLE only, stamping `to=B` on a stream opened from a Mac-B session would have
    **A's own `to=` filter drop the whole thing on arrival**: the dictation vanishes with no error
    on either Mac, because the line addressed to B never reaches B. Addressed to `primaryLink()`
    it reaches the one Mac that can physically receive it, and if that Mac does not own the target
    session its own `resolveSessionId` fails and **logs** the miss with the transcript still
    delivered as a memo — a visible failure instead of silence on both.
  - **BLE chunking and what the airtime numbers do and do not say.** noble on macOS does not
    report an MTU (`peripheral.mtu` came back `undefined` against the real device), so
    the HOST cannot size against the MTU — but **the DEVICE can, and for the life of this
    project nobody asked.** `ble_att_mtu(conn_handle)` reports the negotiated value, and on
    this link it is **256**, not the 23 the 20-byte constant assumed (23 less the 3-byte ATT
    header). So every BLE write was a fraction of what the radio would carry.
    **MEASURED by forcing the host's size by hand against a real link, same ~7.8KB payload:
    20 bytes -> 2944ms (2.7 KB/s), 60 -> 1356ms (5.4), 180 -> 938ms (8.4).** A 3.1x speedup,
    with no algorithm and no decompressor — reached for before compression precisely because
    it needed neither, and it composes with compression later.
    The device now REPORTS its MTU from `loop()` (`BLEMTU link=<n> mtu=<n>`) and the host
    raises `bleChunkSize` to `mtu - 3`, clamped to the 180 measured working. It is sent from
    `loop()` and not `onConnect` because that callback runs on BTC_TASK, where this file's
    rules forbid touching drivers, and negotiation settles slightly after connect.
    **DO NOT hard-code the larger value.** A Mac that does not negotiate up leaves the MTU at
    23, and CoreBluetooth **DROPS an oversized write-without-response SILENTLY** — so the link
    does not error, it simply appears dead, and with a cable also attached the fault is
    invisible until someone unplugs. The floor stays 20 and a device reporting 23 keeps it
    there. **Headroom not taken: 253 (256 - 3) is the real ceiling and is UNTESTED**, because
    verifying it needs the cable OUT — a host->device write size cannot be exercised while USB
    is carrying the same payload.
    consecutive ticks, but that is the time to hand chunks to CoreBluetooth, **not** over-the-air
    completion: `sendOverBle` writes `withoutResponse`, and the mac binding fires the JS write
    completion immediately after calling `-[CBPeripheral writeValue:...]`. True over-the-air
    completion is **not observable through that binding at all**, so any future payload growth has
    to be argued against the theoretical bound (~666 B/s at 20-byte chunks and the 30ms interval
    macOS negotiates), never against the 1ms figure. The worst-case device→host line is **286
    bytes** — a typed answer plus the `to=` suffix — which is 15 chunk notifies plus a standalone
    newline notify, the newline sent on its own so neither chunk loop can clip the byte the host's
    line splitter keys on.
  - **`MULTITEST <n>` injects a synthetic second Mac** (`hostId feedfeed`, tag `studio`), which is
    what makes the merge, the cross-Mac ranking, the row and card tags, the freshest-quota pick and
    the stale-link drop verifiable — and screenshottable via `SCREENSHOT` — from one Mac. Same
    precedent as `KBTEST`/`TAB`/`PAGE`, which exist because the glass is otherwise unverifiable.
    Three details are load-bearing: the tag is `studio`, a full **six** characters, i.e. the real
    worst case `macTag()` can emit, so the harness tests the width boundary rather than passing on
    a lucky fit; it carries its own `cxPct`/`cxAgeSec`, or `cxSourceLink` could never pick the
    synthetic link and the Codex row's own tag lane would go unexercised; and it **saves and
    restores `activeHost`** around the injected call, because `feedfeed` matches no pairing slot
    and would otherwise leave the device unable to sign a **real** answer until the next real tick
    restored it (~5s). It can never answer anything itself, for that same reason — no pairing slot
    matches, so `authHmac` refuses to sign, which is the safe direction.
  - **What is NOT verified, stated plainly.** **The two-`conn_id` demux has never run on
    hardware**, and it is this feature's one untested load-bearing path. Two host processes on ONE
    Mac cannot substitute for two Macs: they share a single ACL connection to the peripheral (the
    device logged exactly one `onConnect`), so proving the demux needs a **second radio**. Also
    unverified by execution: **answering by tapping `Allow` or `SEND` on the glass**, because this
    codebase deliberately has no remote trigger for either — `KBTEST` can open the keyboard and
    type but explicitly cannot SEND — so the answer path, including the 286-byte worst-case line
    above, was checked by inspection only.
  - **SUSPECTED and uninvestigated: per-reconnect listener accumulation in `host/index.mjs`.**
    During reconnect-heavy testing the host log showed `MaxListenersExceededWarning` alongside
    repeated BLE write timeouts, which *suggests* listeners accruing on the `txChar.on("data")`
    path across reconnects. It is pre-existing, it was not investigated, and nothing here diagnoses
    it — recorded so the next person to see those two symptoms together starts from a hypothesis
    instead of from scratch.
- **Protocol versioning — `HELLO <name> v2`.** The device advertises which pairing protocol it
  speaks. Only for `v2` does the host send the new `PROVISION <hostId> <secret> <label>`; older
  firmware gets the bare `PROVISION <secret>`, which still works because the key sent *is* that
  pair's key. This gate is load-bearing: pre-v2 firmware treats everything after `PROVISION ` as
  the secret, so sending the new form to it would silently store the wrong key and break answering.
  The label may contain spaces (it's the Mac's hostname) — the device splits on the first two
  spaces only.
- **Choosing which pair is live.** Mac side: the menu bar's **Device** submenu lists every paired
  device with a checkmark on the chosen one, plus **Any device**; picking one writes
  `SELECT <name>` to the command-trigger file, and the host re-points its BLE scan (dropping the
  current link via `rescanBle()`). Device side: **SETTINGS › PAIRED MACS** lists the remembered
  Macs — tap one to restrict answering to it (`hallow`), tap again or tap **ANY MAC** to clear,
  tap the `x` to forget just that Mac. `uiListRow` takes a `rightInset` so the "ONLY" tag is
  placed clear of the `x` (they overlapped when both were right-aligned to the same edge).
- **Confirm dialog (one component, every consequential action).** RESET PAIRING, POWER OFF,
  CALIBRATE TOUCH and a host row's `x` all route through `pendingConfirm` + `drawPendingConfirm()`
  rather than firing on the tap. The dialog states the **consequence**, not just the question
  ("every paired Mac is forgotten", "deep sleep - touch the screen to wake"), CANCEL keeps the
  accent as the safe default, and the action button carries its own severity colour. It is
  **modal**: `handleSettingsTouch` handles it first and swallows every other touch including the
  pager, so a stray tap can't page away and strand it; taps in the gap between the two buttons are
  ignored rather than guessed. `drawSettingsStatic()` clears `pendingConfirm`, so a page redraw can
  never re-enter a stale dialog, and **`renderSettingsTab()` returns early while a dialog is up** —
  without that, the periodic repaint (every host tick, ~5s) painted the page's values straight over
  the dialog: it looked half-erased AND `pendingConfirm` stayed set, so touches outside the button
  row were swallowed and the UI appeared frozen.
  **`drawSettingsStatic()` resets the settings caches itself.** It repaints the chrome the
  change-only fields are drawn ON, so those caches are stale by definition; a caller that forgot
  left the values BLANK (they hadn't "changed", so `drawIfChanged` skipped them). That was the
  empty page after CANCEL and the intermittent missing text. Resetting inside the function rather
  than at each call site makes the invariant impossible to forget. **Two calibration paths deliberately skip the dialog**: the
  first-boot run (touch isn't calibrated yet, so a confirm button would be untappable) and the
  `RECAL` command from the host — that one is an explicit instruction from the Mac and is the
  escape hatch when touch is misaligned, so requiring a tap to confirm would defeat it.
  **Every string is measured or wrapped against the card's text lane, and skipping that is what
  made the text look like it overlapped the dialog.** Each line used to be one centred
  `drawString` with no width given, so a note wider than the card ran past both edges - three of
  the four were, up to 228px against a 212px interior. `drawString` paints an OPAQUE background
  box, so the overflow did not merely spill: it rubbed out the card border it crossed. The note now
  goes through `drawWrappedText` bounded to `CARD_W - 2*SP_3` (192px), the emphasis line through
  `fitText`, and the title renders in `T_HEAD` where the longest ("Recalibrate touch?") is 180px
  and fits.
  The three text elements are laid out as ONE BLOCK and centred in the space above the buttons,
  rather than pinned to hand-picked offsets - so a one-line note and a two-line note both sit
  correctly, instead of one being right and the other tuned to match. Measured clearance above the
  button row is 11-27px across all four dialogs.
  **CANCEL is the FILLED button and the action is only outlined** in its severity colour: the safe
  option should be the prominent one, and a destructive choice should not also be the easiest thing
  to hit. Both pass `COLOR_CARD` as their backdrop, because they sit ON the dialog - the default
  `COLOR_BG` gave their anti-aliased edges a fringe of the page background against the card.
- **Re-pairing controls (switching device⇄Mac).** Device side: **SETTINGS › Actions › RESET
  PAIRING** (`resetPairing()`) now wipes **every** slot (and the legacy `blesecret`, so a migration
  can't resurrect it) so the device reads "unpaired" and bonds fresh to the next Mac it's USB'd
  into; it deliberately does **not** re-`HELLO` (that would let the current Mac instantly re-pair,
  defeating a move). To drop one Mac and keep the rest, use PAIRED MACS instead. Host side: the
  menu-bar app's **Forget device** writes `FORGET <name>` (explicitly named, so it forgets the one
  shown rather than whatever is current when the host reads the file); the host intercepts it (not
  forwarded to the device) and deletes that entry *and its key*. The heartbeat carries `device`
  (who we're actually talking to), `selected`, and `devices[]`, so the menu bar renders the picker
  without ever reading the secrets file.
- **Device names are validated against `/^Deckhand-[0-9A-Fa-f]{4}$/` before they can become a
  pairing**, both on load and on every `HELLO`. During the baud experiments, corrupted `HELLO` lines
  (garbled by a mismatched rate) minted junk entries like `"Deckhand-\ufffd\ufffd\u0002v2"`, which
  burn slots in a list capped at `MAX_PAIRED_DEVICES` and would eventually push the real device out.
  Malformed entries already in the file are dropped on load, with a log line saying how many.
- **`HELLO` is re-announced in a burst for the first 15s after boot** (every 2s, in `loop()`), not
  just once in `setup()`. The single boot `HELLO` can land before the host's serial reader is ready —
  harmless normally (the host also loads the selection from `deckhand-secret`), but after a host-side
  `FORGET` the pin is empty and re-pairing *depends* on catching a fresh `HELLO`, which the one-shot
  missed. The burst is idempotent (host re-pins/re-provisions only on a change) and boot-only, so a
  device-side RESET PAIRING (no reboot) still won't silently re-pair. (`deviceNameReported` is now
  vestigial — nothing gates on it.)
