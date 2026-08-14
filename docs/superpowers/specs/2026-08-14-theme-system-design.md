# Theme system: dark and light, with validated palettes

**Status:** design, approved for planning · **Date:** 2026-08-14

## Problem

The device has one hard-coded look. Nine `const uint16_t COLOR_*` globals define it, and
there is no way to change them without reflashing. A display that sits on a desk all day
should suit the room it is in — a black panel is right in a dim room and wrong in a bright
one.

## Goals

- Two themes, DARK (today's look, unchanged) and LIGHT, switchable on the device and
  remembered across reboot and deep-sleep/wake.
- Every shipped palette validated for text contrast and for status-colour separability,
  rather than chosen by eye.
- No regression in the flicker-free redraw discipline.

## Non-goals (all deliberately cut during design)

- **No user-editable colour tokens.** A resistive 240x320 panel is a poor colour picker,
  RGB565 bands visibly, and an arbitrary palette cannot be validated before use. Built-in
  themes can.
- **No host involvement.** No wire format, no `THEME` command, nothing in the payload.
- **No extra themes.** Two, not four. Editor palettes (Nord, Solarized) and characterful
  ones (Phosphor, Paper) were considered and dropped: the "geek" quality this device has
  comes from its typography and layout — a hand-hinted bitmap font, hairline cards,
  monospace figures — not from how many palettes it ships.
- **No restyle.** Spacing, hierarchy and chrome stay exactly as they are. Doing both at
  once would confound "the light theme looks wrong" with "the new spacing looks wrong".

## Approach

**Mutable globals plus a palette table.** Drop `const` from the nine `COLOR_*` globals,
add a `static const Theme THEMES[2]`, and have `applyTheme(i)` copy a row into them.

The point of this approach is what it does *not* touch: those nine names are referenced
**385 times** across the sketch, and not one of those call sites changes. Two alternatives
were considered and rejected — a struct with `#define COLOR_BG (theme.bg)` (same zero-touch
property, but adds a layer of indirection to every read for tidiness alone), and a palette
array with index constants (`pal[PAL_BG]`, which would require editing all 385 sites or
reintroducing the macros anyway).

## The palettes

Values are RGB565. DARK is exactly today's palette, restated as data.

| token | DARK | | LIGHT | |
|---|---|---|---|---|
| bg | `0x0000` | `#000000` | `0xEF5C` | `#efebe6` |
| card | `0x18C4` | `#191821` | `0xFFFF` | `#ffffff` |
| label | `0x8410` | `#848284` | `0x62CA` | `#635952` |
| value | `0xFFFF` | `#ffffff` | `0x18C3` | `#191819` |
| accent | `0xFD20` | `#ffa600` | `0xB240` | `#b54900` |
| good | `0x0396` | `#0071b5` | `0x12F4` | `#105da5` |
| warn | `0xE4E0` | `#e69e00` | `0xB3A0` | `#b57500` |
| bad | `0xCBD4` | `#ce79a5` | `0x6887` | `#6b103a` |
| unknown | `0x7BEF` | `#7b7d7b` | `0x8C30` | `#8c8684` |

**The surfaces invert.** In DARK the card *lifts off* black; in LIGHT the background is a
warm grey and the card is white, which is the same figure/ground relationship the other way
up. LIGHT's accent and status hues are darkened, because the DARK values were chosen
against black and lose contrast on white.

## Validation, and what it found

A script computes WCAG contrast for every text-on-surface pair, and separability for the
three status colours under a deuteranope approximation and in greyscale. It lives in the
repo so the numbers are reproducible rather than asserted.

Results:

| | DARK | LIGHT |
|---|---|---|
| worst text contrast | 3.38 (good on card, AA-large) | 3.80 (warn on card, AA-large) |
| status luminance gaps | 26% / 14% / 12% | 12% / 7% / 19% |
| deuteranope distances | 223 / 148 / 109 | 172 / 107 / 125 |

Two findings worth recording:

1. **The first LIGHT candidate failed the separability check** even though its contrast was
   better than DARK's. Its three status colours sat at nearly the same lightness —
   luminance gaps of 4% / 1% / 5% — so in greyscale they were nearly one colour. Retuning
   spread them deliberately (warn lightest, bad darkest) to reach 12 / 7 / 19%. This is the
   check earning its place: contrast alone would have passed a palette that fails the
   repo's colour rule.
2. **DARK's worst pair is `good` on `card` at 3.38**, below AA for body text. That is
   pre-existing and out of scope — changing it would alter the current look, which this
   change explicitly does not do. Recorded so it is a known quantity, not a discovery.

Neither theme relies on colour alone: status is also encoded by shape (filled circle /
filled square / hollow ring, and solid / outlined / boxless pills). That property is
independent of the palette and is unchanged.

## Switching, control and persistence

`applyTheme(i)` writes the globals then calls `forceFullRepaint()`. That helper already
exists and already resets the change-only caches — which is exactly what a colour-only
change needs, because `drawIfChanged` and `drawPaceBar` cache on *content* (text, or
`(pct, tick)`), so without a cache reset a repaint with new colours would be skipped
entirely.

The control is a third toggle on the DISPLAY & SOUND page's bottom row, which currently
holds `SOUND` and `FLIPPED` as two half-width toggles. Three third-width toggles fit:
`(216 - 16) / 3 = 66px` each, against a longest label (`FLIPPED`) of 42px at Cozette's 6px
advance. No new page and no geometry growth.

Persisted as NVS key `theme`, loaded in `setup()` beside `loadScreenFlip()` — the same
place and pattern as the existing screen-flip preference, which also has to survive the
deep-sleep/wake cycle because wake re-runs `setup()`.

## The crab

`ClawdCrab.h` has its PNG alpha **composited against black at build time**, so its
anti-aliased edges carry black fringes that cannot follow a theme. It is not regenerated
and not composited at runtime — but its background is not hard-coded to DARK either:
`startOctopus()` and `renderOctoFrame()` clear with the **live** `COLOR_BG`, and `drawCrab()`
skips palette index 0 (the build-time black, on the assumption the target was just cleared
to match) rather than substituting the live background colour. Under DARK those two blacks
coincide and the edges look seamless; under LIGHT they don't, so the crab appears on the
light-grey background with a dark anti-aliased fringe around it (the sprite is drawn at
3x scale, so that fringe reads as a few pixels of dark rim). The Claude spark and Codex mark
need no such treatment — they are 2-bit alpha masks tinted with the status colour at draw
time, so they follow the theme for free.

## Risks

1. **A colour-only change that does not repaint.** The failure mode is silent and this
   codebase is prone to it: every change-only cache keys on content. `forceFullRepaint()`
   is the mitigation and it must be called on every theme switch, including the one during
   `setup()` if the stored theme is not the default.
2. **Anything that hard-codes a colour rather than using a token** will not follow the
   theme. The FAB's 1px `COLOR_BG` haloes and `drawPaceBar`'s trough already use the token
   and are fine. The sweep found exactly one real instance, and it matters:
   **`drawCrosshair()` draws in literal `TFT_WHITE`** (two `drawFast*Line` calls). Touch
   calibration clears to `COLOR_BG` and then draws those crosshairs, so under LIGHT they
   would be **white on near-white — invisible**, leaving the user unable to complete a
   calibration they cannot see. `runCalibration()` already forces the unflipped rotation
   for its duration but does not force a theme. Fix: draw the crosshair in `COLOR_VALUE`,
   which is near-black under LIGHT and white under DARK, i.e. correct in both by
   construction. This is a required part of the change, not a follow-up.
   The only other literals are the two token definitions themselves (`COLOR_BG =
   TFT_BLACK`, `COLOR_VALUE = TFT_WHITE`), which become table data.
3. **LIGHT has never been seen on this panel.** Contrast maths is not the same as a
   transmissive LCD at an angle in daylight. The first flash may show that the warm grey
   reads dirty or the hairlines vanish; the palette is data in one table, so tuning is
   cheap.

## Testing

- The palette script is the automated part: it runs standalone and fails loudly if a
  future palette regresses contrast or separability.
- Everything else is this repo's usual method — compile against a baseline for flash and
  RAM deltas, flash, and look at both themes on the hardware, checking each of the three
  tabs, the ask screen, the history reader and the settings pages.
- One specific check on the panel: switch themes while the SESSIONS list is populated, to
  confirm the full repaint really does clear every cached field rather than leaving a
  stale-coloured value behind.
