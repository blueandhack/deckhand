# Type Scale — Design

**Status:** design, approved for planning · **Date:** 2026-08-14
**Sub-project:** A of the device UI restyle (font → spacing tokens → USAGE → SESSIONS → SETTINGS/overlays)

## Problem

The device UI has one text size. Measured on the current tree:

| | |
|---|---|
| Call sites rendering at Cozette 6x13 | **68** |
| Call sites rendering at Cozette 12x26 | **4** |

`T_TITLE = 2`, `T_BODY = 2`, `T_META = 1` (lines 623-625) look like a semantic scale but
`uiTextSize(f) = f == 4 ? 2 : 1` collapses all three to 6x13. The scale is fictional: only
`setUIFont(4)` — four sites, all hero percentages — renders large. Everything else, from
session names to button labels to sub-lines, is the same 6px face.

The absence is felt most in `drawSessionRow`, which already tries the big font and falls
back to the small one when a name doesn't fit (lines 2968-2976). That is a **12x26 → 6x13
cliff**: a 50% drop with nothing between, and its own comment says so — *"This is one hard
step, not a gradient."*

## What was ruled out, and why

Both alternatives were tested, not reasoned about. Recording them so they are not retried:

- **Add a Cozette size.** Cozette ships exactly two bitmap faces, `cozette.bdf` (6x13) and
  `cozette_hidpi.bdf` (12x26). The hidpi variant is a **mechanical 2× upscale** — decoded
  glyph-for-glyph against a naive doubling of 6x13 and found byte-identical for `8` and `%`.
  There is no third size and no bold BDF in the family.
- **Synthetic bold by 1px double-strike.** Requires a spare column in the cell. Measured:
  **78 of 95** printable-ASCII glyphs already reach or pass the 6px advance (`4` reaches 7).
  A double-strike would smear into the following character.

## Decision

Add **Terminus 10x18 bold** as a third rung. Terminus (4.49.1, SIL OFL — `OFL.TXT` ships in
the tarball) provides BDFs at 12/14/16/18/20/22/24/28/32 in normal and bold; `ter-u18b.bdf`
is 10x18, which sits between the existing 13 and 26.

### The scale

| Token | Id | Face | Cell | Cols @240px | Role |
|---|---|---|---|---|---|
| `T_HERO` | 4 | Cozette ×2 | 12x26 | 20 | usage percentages — unchanged |
| `T_HEAD` | **3** | **Terminus 10x18 bold** | **10x18** | **24** | the new rung: display names and headings |
| `T_BODY` | 2 | Cozette | 6x13 | 40 | wrapped prose, ask detail, reader — unchanged |
| `T_META` | 1 | Cozette | 6x13 | 40 | sub-lines, units, hints — unchanged |

`T_TITLE` **keeps its current value of 2** and is not repurposed. It is used at three sites,
and one of them is line 641 inside `uiButton` — the single shared button style. Giving
`T_TITLE` the new face would silently flip *every* button label on the device, including
Allow/Deny on the ask screen and the confirm dialogs, to a face 67% wider; labels such as
`CALIBRATE TOUCH` (90px at 6x13, 150px at 10x18) would overflow their fixed-width buttons.
Those migrations belong to the SETTINGS/overlays sub-project, where button widths get
re-derived and re-tested. Until then `T_TITLE` is documented in-code as pending migration.

The new rung is therefore introduced as a distinct token, `T_HEAD` = 3 (a font id not
currently passed anywhere), leaving every existing token's rendering untouched.

**Body and reader text stay Cozette.** They are the density-critical surfaces — paths cap at
64 chars, ask details at 1400 — and 24 columns would wreck them. The new face buys hierarchy
only where strings are short and drawn at fixed positions.

**Hero stays Cozette.** It is not the gap, and the 122→104 card pass explicitly protected
those figures.

**Bold only, not both weights.** Terminus regular at 10x18 sits too close to Cozette 6x13 in
colour to read as a distinct level. One weight halves the flash and removes a decision from
every future call site.

### Measured cost

| Header | Bitmap | Glyph table | Total |
|---|---|---|---|
| `Cozette6x13.h` (in tree) | 424 B | 665 B | 1089 B |
| `Terminus10x18b.h` (new) | 2185 B | 665 B | **2850 B** |

95 glyphs, `0x20`-`0x7E`. Against ~1.85 MB of free flash. RAM cost is zero (`PROGMEM`).

Terminus glyphs are emitted as full 10x18 cells (its BDF declares a uniform `BBX`), where
Cozette's are tightly cropped — hence 5× the bitmap bytes for 1.9× the area. This also means
TFT_eSPI's per-glyph loop runs 180 bits instead of 40. Acceptable: `T_HEAD` renders short,
change-only strings, never wrapped body text.

## Mechanism

### 1. Font registry

Replace the `f == 4 ? 2 : 1` special case (line 133) with a table:

```c
struct UiFont { const GFXfont* gfx; uint8_t size; uint8_t cellH; };
// Indexed by font id. Entry 0 is unused and aliases body so an out-of-range
// id degrades to readable text rather than a null GFXfont dereference.
static const UiFont UI_FONTS[] = {
  /* 0 unused */ { &Cozette6x13,    1, 13 },
  /* 1 T_META */ { &Cozette6x13,    1, 13 },
  /* 2 T_BODY */ { &Cozette6x13,    1, 13 },
  /* 3 T_HEAD */ { &Terminus10x18b, 1, 18 },
  /* 4 T_HERO */ { &Cozette6x13,    2, 26 },
};
```

`cellH` is the **rendered** height, size already applied. `FONT_CODE` (200) resolves to entry
2 before lookup, keeping its value and its meaning as the "this is a code block" styling
marker. Any id outside `0..4` also resolves to entry 2.

**Every existing id keeps its current face**, so the registry lands inert:

| Call site passes | Resolves to | Renders | Changed? |
|---|---|---|---|
| `1` / `T_META` | entry 1 | Cozette 6x13 | no |
| `2` / `T_BODY` / `T_TITLE` | entry 2 | Cozette 6x13 | no |
| `4` | entry 4 | Cozette 12x26 | no |
| `FONT_CODE` (200) | entry 2 + code-panel styling | Cozette 6x13 | no |
| `T_HEAD` (3) | entry 3 | **Terminus 10x18 bold** | new |

All 72 existing call sites render byte-identically after this change. `T_HEAD` appears only
where deliberately opted in, so no screen can regress by accident. This is the property that
makes the sub-project safe to land ahead of the restyle work that consumes it.

### 2. `drawIfChanged` erase geometry — the load-bearing fix

Line 2144 reads:

```c
int th = 13 * tft.textsize;
```

The Cozette cell height is baked into every field's erase rectangle. A `T_HEAD` field would
clear 13px of an 18px box and **ghost on every update**. It becomes font-derived via
`uiLineH(font)`.

`drawIfChanged` carries a separate `size` parameter that can override the font's own size
(`if (size > 1) tft.setTextSize(size);`). The erase height must account for that override, or
the two disagree and the bug returns in a narrower form.

### 3. `uiLineH`

`uiLineH(f)` (line 134) becomes a registry lookup. It currently has **zero call sites** — it is
declared and never used — so this is free; `drawIfChanged` becomes its first consumer.

**The `lineH` argument of `drawWrappedText` is deliberately left alone.** It looks like a
duplicate of the cell height but is not: it is a *leading* parameter, and the call sites pass
distinct, intentional values — `11` for the detail screen's prompt and path (**tighter** than
the 13px cell), `13` for code blocks, `17` for the ask title (**looser**), and the computed
`dLineH` / `HIST_LINE_H` elsewhere. Replacing them with `uiLineH(font)` would retighten the ask
title and loosen the detail screen, changing two layouts this sub-project has no business
touching. Leading stays a caller's choice, independent of cell height.

### 4. `setUIFont`

Selects family and size from the table instead of hard-coding `&Cozette6x13`.

### 5. `bdf2gfx.py` attribution

The generator hard-codes its output header:

```
// Cozette 6x13 - Adafruit_GFX font, printable ASCII 0x20-0x7E only.
// Generated from cozette.bdf by bdf2gfx.py. (c) Ines, OFL/MIT.
```

Generating Terminus through it would ship Terminus glyphs under Ines's copyright. This is a
licensing defect, not cosmetics. The generator reads `COPYRIGHT`, `FAMILY_NAME` and
`PIXEL_SIZE` from the BDF's own `STARTPROPERTIES` block and emits those.

### 6. The one adoption: `drawSessionRow`

The 12x26 → 6x13 fallback (lines 2968-2977) becomes a three-rung ladder:

**12x26 → 10x18 → 6x13**, taking the first rung whose `tft.textWidth(s.name)` fits `laneW`.

Vertical centring generalises. Line 2984 currently hard-codes a `+6` offset for the shrunk
name, centring 13px text in the 26px band the big font would have filled. That `6` is exactly
`(26 − 13) / 2`, so the ladder uses:

```c
int nameOffset = (26 - UI_FONTS[rung].cellH) / 2;   // 26->0, 18->4, 13->6
```

which reproduces today's value at the 13px rung.

`fitText` (line 2905) needs **no change** — it measures with `tft.textWidth()` rather than an
assumed character width, so it adapts to whichever face is active. (That generality was added
when the fixed 11/12-character cap proved wrong; it pays off here.)

`nameBuf[28]` is unchanged: the host caps names at 22 characters, plus `...` and a NUL.

### Out of scope

USAGE, SETTINGS, the session detail screen, the ask screen, the reader and the history pager
keep their legacy font IDs and migrate in sub-projects C/D/E, each of which needs its own
hit-testing review. This sub-project ships the registry, the font, the four fixes and the one
adoption — nothing else.

## Verification

### Automated (host-side)

`bdf2gfx.py --verify <bdf> <header>` decodes the generated header's packed bitstream back to
glyph rasters and compares them **glyph-for-glyph** against the source BDF: bitmap, advance,
`xOffset`, `yOffset`, and the font's `yAdvance`.

This matters specifically because `bdf2gfx.py` has only ever been run on one font. Terminus's
uniform full-cell `BBX` and `yOffset -15` exercise packing paths that Cozette's tightly-cropped
glyphs never did.

Following the `palette-check.mjs --selftest` precedent, `--selftest` flips one bitmap byte and
**fails if the checker still passes**, proving the checker has teeth.

### Compile-time

Record flash and RAM delta. Expected ≈ +2.85 KB flash, ~0 RAM.

### On hardware

| # | Check | Catches |
|---|---|---|
| 1 | A Terminus title beside its Cozette sub-line in one row | baseline drift between faces — Terminus carries three blank rows at the top of its cell with `yOffset -15`, where Cozette is cropped; TFT_eSPI's free-font path adds the ascent under `TL_DATUM`, so alignment between the two is unproven by reading alone |
| 2 | A session whose name or status changes while visible | ghosting from the `th = 13` erase fix |
| 3 | Short, medium and very long names | the ladder picks the right rung and centres it in the 26px band |
| 4 | Both DARK and LIGHT | Terminus rendered on card fill in both palettes |
| 5 | 1, 3 and 6 sessions | the 90px row cap and `SESSION_TITLE_MIN_H` (85) still clear the status pill |

### Named failure mode

`fitText` writes an empty string when nothing fits at all. At 10x18 in a narrow lane that is
reachable where it was not at 6x13. The ladder must fall through to the next smaller rung on
an empty result rather than render a blank name.

## Rollback

The registry is inert by construction. Backing out means deleting the single `drawSessionRow`
adoption; the font, registry and the four fixes can stay without changing a pixel.

## Dependencies

Hardware check 4 requires the DARK/LIGHT theme system (branch `theme-system`, 4 commits,
currently unmerged), so this sub-project builds on that branch.
