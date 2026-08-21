# Tagging each Mac with an emoji — design

**Status:** approved for planning
**Date:** 2026-08-21

## What this adds

Each Mac can carry a small icon, shown on the device wherever that Mac is already
identified: session rows, the USAGE cards, the Codex row, SETTINGS › STATUS and the
session detail card. Set it per Mac with `DECKHAND_MAC_EMOJI=rocket`, or from the menu
bar's **Settings › Mac icon**.

## The constraint that shapes everything

**The device cannot render an emoji character.** `Cozette6x13` declares its glyph range
as `0x20, 0x7E` — ASCII only — which is the same fact that forces `fitText`'s
three-ASCII-dot ellipsis and that made the Mac tag's separator a `/` rather than a middle
dot. An emoji codepoint draws as a blank box.

So an emoji here is **artwork, not text**, and every decision below follows from that:
the set is curated because each icon is a baked-in sprite, and the name — never the
character — is what crosses the wire.

## Decisions taken

- **Curated set of 16, in colour.** ~381 bytes per icon against 1.78MB of spare flash.
  Rejected: rasterising arbitrary emoji on the Mac and shipping pixels in the payload —
  it adds per-tick bytes to a BLE link already measured as the bottleneck, for a
  freedom nobody needs more than once per machine.
- **13x13, not 16x16, and this came out of the arithmetic rather than taste.** On a usage
  card the label row is `y0+6`..`y0+19` — thirteen pixels — because the hero number's box
  starts at `y0+20` and spans the full card interior, clearing from `y0+19`. A 16px icon
  there would collide with the hero's CLEAR BOX, which is this file's documented
  "a field's clear box, not its glyphs" failure. Matching Cozette's 13px cell height makes
  an icon occupy exactly one text line everywhere and removes the collision arithmetic on
  every surface at once. Cost: legibility at 13px, which is a real trade (see Risk 1).
- **RGB565 colour plus a separate 2-bit alpha plane**, blended against a backdrop passed
  in at draw time. Rejected: pre-compositing against a background, which is exactly what
  gives `ClawdCrab.h` its documented fringe under LIGHT — an icon here must sit on a
  usage card, a session row and the page background, in two themes, so baking one backdrop
  in guarantees a halo on the other three. Also rejected: a 1-bit mask, which is 32 bytes
  cheaper and throws away the anti-aliased edge a 13px glyph depends on.
- **The NAME crosses the wire, never the character.** `hostEmoji: "rocket"`, ASCII. The
  device maps name to sprite index from the generated table, so a multi-byte character
  would buy nothing while putting non-ASCII into line buffers and an ask sanitizer that
  are ASCII-oriented throughout.
- **An unknown or absent name falls back to the existing text tag.** That is what lets
  this ship without disturbing the path that already works.
- **Compact session rows keep the text tag.** Their sub-line is a single `drawString`, so
  an inline icon means splitting it into two draws plus a sprite — and compact rows exist
  precisely when 4-6 sessions compete for space, where an icon would cost a text lane to
  save nothing. Tall rows are where glanceability pays.
- **Env var beats the menu-bar picker**, because the plist is the provisioning path and a
  deliberately-set value must not be silently overridden by a stray click.

## Asset pipeline

`firmware/deckhand_display/emoji2c.py`, following `codex2c.py`'s established shape:

1. Render an HTML page containing the emoji character at 128px in headless Chrome
   (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, the path `codex2c.py`
   already uses — verified present, as is `/System/Library/Fonts/Apple Color Emoji.ttc`,
   so the generator needs no downloaded asset).
2. Read the PNG with the script's own inflate/unfilter reader — that code already exists
   in `codex2c.py` and is reused, because this toolchain has no SVG rasteriser and no
   Pillow.
3. Box-filter down to 13x13, quantise alpha to 2 bits.
4. Emit `MacEmoji.h`: a colour plane, an alpha plane, and the name table.

`--verify` decodes a generated header back and compares it against its source raster;
`--selftest` corrupts one byte and fails if that goes unnoticed. Same teeth-proving trick
as `bdf2gfx.py --selftest` and `palette-check.mjs --selftest`.

## Draw primitive

`drawEmoji(int id, int x, int y, uint16_t bg)` composes one row at a time into a
`uint16_t row[13]` and pushes it with `pushImage`, exactly as `drawLogo` does — including
`setSwapBytes(true)` and its restore. That is not optional: `pushImage`'s buffer byte
order depends on the target's flag, and getting it wrong is the documented reason the
crab's colours came out inverted. Per pixel it blends the icon's colour toward `bg` by the
2-bit alpha, so one copy of the art is correct on a card, on a row, and in both themes.

Costs ~6.1KB flash for 16 icons, zero RAM (`PROGMEM` art, a 26-byte stack row buffer).

## Surfaces

| surface | today | with an icon | measured clearance |
|---|---|---|---|
| Session row, tall | `CLAUDE/studio` right-aligned at x=220, 78px | `CLAUDE` + gap + icon = 56px | name lane GAINS 22px, so long names hold a bigger font rung more often |
| Codex row | `CX pro`, 36px inside an 11-char lane from x=26 | `CX` + gap + icon = 32px, ends x=58 | 35px clear of the neighbour's clear box at x=93 |
| Usage cards | text tag right-aligned at x=214 | icon at 198..214, label row | label ends at 164, so 34px clear |
| SETTINGS › STATUS | `Mac  pro  0s ago` | `Mac  <icon> pro  0s ago` | 20px row pitch |
| Session detail | `AGENT / MAC` -> `CC/pro` | `CC <icon> pro` | within the existing column |
| Session row, compact | `CC/pro opus-5 (main)` | unchanged, by decision above | — |

**The pin marker.** On usage cards, pinned-versus-auto currently rides the tag's COLOUR,
which a colour sprite cannot carry. It becomes a 3px accent underline in this device's
existing vocabulary (the tab bar's active-tab underline), drawn ABOVE the icon at `y0+5`
rather than below it — below would land at `y0+20`, inside the hero number's box. The
carrier is the mark's presence, not a hue, so the colour-never-alone rule still holds.
Confirm against the card border on the glass; the arithmetic alone is not proof.

## Caches and signatures

Every one of these surfaces caches on TEXT, and an icon change moves no text. This is the
trap that has already sprung three times in this area (a stale Mac tag, a missing tag, a
frozen source label), so each is explicit:

- the row signature gains the icon id (`rowSigCache` 176 against a 122-byte worst case —
  room)
- the detail signature gains it, and **`detailSigCache` must grow**: it is 368 against a
  349-byte worst case, 19 bytes of headroom, already flagged in the code as needing
  re-derivation on the next field added
- the usage chrome bust gains it, beside source, pin and link count
- the SETTINGS Mac row's cached string gains it, or the row silently keeps a stale icon

## Configuration

- `DECKHAND_MAC_EMOJI=<name>` — wins.
- Menu bar: **Settings › Mac icon ▸**, a checkmark on the current one. Picking writes
  `EMOJI <name>` to the command-trigger file; the host **intercepts** it rather than
  forwarding it to the device (the way `FORGET` is already handled) and persists it to
  `~/.claude/deckhand-mac-emoji`, a one-value file mirroring `deckhand-remote-wait`.
- **With the env var set, the submenu's items are disabled and its parent reads
  `Mac icon (set by env)`.** Two sources of truth need a visible rule, not only a
  documented one: checkmarks that cannot be changed would be a lie.
- `host/mac-emoji.mjs` owns the name table and `resolveMacEmoji({env, file})`, so the list
  of valid names exists in exactly one place on the Mac side.

Proposed set: `rocket, moon, star, bolt, fire, leaf, wave, anchor, crab, laptop, desktop,
cloud, sun, cat, robot, gear`.

## Verification

There is no test suite; the executable checks are the check scripts, and the rest is
compile, flash, and look at the glass.

- `host/mac-emoji-check.mjs` — pure, plain `node` (imports nothing reaching CoreBluetooth):
  valid names, unknown rejected, env-beats-file precedence, case and whitespace, empty.
- `emoji2c.py --verify` / `--selftest` as above.
- `EMOJITEST <name>` on the device, so every icon reaches the glass without a person —
  the reason `KBTEST`, `TAB` and `PAGE` exist.
- `MULTITEST` supplies a second Mac, so two different icons can be seen at once.
- Screenshots on **both themes**: the alpha blend must be right against a card and a row
  backdrop in DARK and LIGHT, which is exactly where a baked-in background shows itself.

## Risks, unresolved

1. **13px legibility is a go/no-go that reasoning cannot settle.** The first screenshot
   decides whether this idea is worth having at all. If the icons read as mush, the
   fallbacks are a smaller set of simpler shapes, or 2-bit monochrome silhouettes tinted
   at draw time like the spark and the Codex mark.
2. **Two config sources can disagree.** Precedence plus the disabled submenu makes the
   rule visible; it does not remove the second source.
3. **Apple Color Emoji is a system font**, so regenerating on a future macOS may shift the
   art. Not a correctness problem, but worth knowing so a later diff is not mysterious.
