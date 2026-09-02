# USAGE tab v2 — the design artifact

`usage.html` + `usage.js` are a **pixel-accurate mock of board 2's redesigned USAGE
tab**, and they are the geometric spec `board_es3c35p.h`'s v2 section was built from.
Serve this directory and open `usage.html`.

Why it is committed rather than left as a scratch artifact, for the same reason
`text-widths-board2.txt` and `docs/design/settings-redesign/` are committed: it is
the only place the redesign's numbers exist in a form anyone can re-run.

Four layouts are drawn, in one column each: **Today**, the pre-branch baseline
(`WAS` below); **A**, **B** and **C**, three options that were compared before one
was picked. **B — "Now / Week / Codex" — is what `board_es3c35p.h` actually
derives.** A and C are kept as the record of what was rejected and why (see each
layout's own `blurb` in `usage.js`); nothing in the header answers to their numbers,
and `check.mjs` does not bind them.

Three properties make it worth trusting:

- **The type is the real thing.** `spleenfonts.js` is extracted from `Spleen8x16.h`,
  `Spleen12x24.h` and `Spleen32x64.h` — the headers the firmware links — by
  `gfx-extract.mjs`, committed alongside it rather than only its output. The 8x16
  and 12x24 halves were re-extracted live and cross-checked against the copy
  already committed under `settings-redesign/`: **190/190 glyphs identical**. No
  Mac font appears anywhere. **No known-good third-party copy of Spleen32x64
  exists**, so that face rests on the same reader having been proven correct on the
  other two, plus a sanity check that every glyph a hero actually draws (`0-9`, `%`,
  `-`, space) is present and every row fits its declared 32px width.
- **The geometry is parsed, not invented.** Every constant in `usage.js`'s `K` came
  from `board_es3c35p.h`, bound name-for-name through the geometry checkers' own
  `consts()` — the same parser `usage-geom-check.mjs` and its two siblings certify
  against. `MAC_EMOJI_SIZE` is the one exception `consts()` cannot see (it lives in
  an *art* header, `MacEmoji16.h`, not a board header), so `check.mjs` reads it
  directly by regex, the same way `sessions-geom-check.mjs` already does per board.
- **It checks itself.** `node check.mjs` runs the SAME assertions the in-browser
  checker makes (`runChecks` in `usage.js` — one shared implementation, not two)
  headlessly, across every state and both themes, and asserts: every string is
  inside Spleen's `0x20..0x7E`; the declared column sums to exactly
  `K.CONTENT_ROWS` (414) and the drawn card/gap sequence reproduces it; no later
  field's clear box erases an earlier field's ink, **per glyph** (a space carries no
  ink and cannot be erased — this is what lets the Codex row's Mac icon sit inside a
  run of reserved spaces without registering as a collision); and nothing crosses
  the tab bar or the footer divider.

```
node docs/design/usage-redesign/check.mjs
```

## The K / WAS split

`check.mjs` binds every entry of `K` to the header. Two constants are
**deliberately excluded and live in `WAS` instead**: `CODEX_LANE_CHARS` (12) and
`CODEX_RIGHT_CHARS` (20). Those are the pre-fix values Task 1 corrected to 14/18 —
the **Today** panel is a before picture of what shipped pre-branch, and a before
picture that tracked the header would stop being a before picture the moment the
header moved. `check.mjs` asserts every `WAS` entry actually **differs** from what
the header ships now, so a live constant cannot be parked there to escape the bind.
`CARD_H` (164) and `CODEX_H` (56) are NOT in `WAS` — they are still live in the
header (the v1 card heights the Today panel legitimately still draws) and stay in
`K`.

## Painter architecture — op-list, no canvas required

`class P` in `usage.js` never touches a canvas directly. `_f()` and every other
draw primitive push onto `this.ops` (a plain array of `["r",...]` / `["t",...]` /
`["hero",...]` / `["bar",...]` / `["spark",...]` / `["icon",...]` tuples); `paint(ctx)`
is a **replay**, called only by the browser. That is the same seam
`settings.js` already has.

The picture assertions do not even read `ops`, though — they read `p.fields` and
`p.cards`, metadata `_reg()` builds alongside the ops (per-field position, per-glyph
ink boxes, which card a field belongs to). That metadata never touched a canvas
either, in the original exploration artifact or here, which is what makes
`node check.mjs` — with `document.getContext` stubbed to return `null` — run the
identical check the browser's own "It checks itself" panel runs.

## What this does not prove

- **Nothing here has been on the glass.** This is arithmetic and bitmaps — the
  right instrument for layout, the wrong one for colour.
- **No screenshot could settle colour either.** Board 2's `SCREENSHOT` reads the
  shadow framebuffer, so it proves the renderer self-consistent and nothing about
  the panel. `COLORTEST` is the instrument; a person is the authority.
- **The Mac icon is a stand-in.** Real art is 16x16 from `MacEmoji16.h`; the wave
  drawn here is generated in `usage.js`, occupies the correct slot at the correct
  size, and nothing more.
- **Corner arcs are canvas, not Bresenham.** The device composes rounded rects from
  `fillRect` runs plus blended corner boxes; corner pixels here are cosmetic and no
  layout claim rests on them.
- **Burn rate is a single-sample extrapolation**, gated (`--` until it has earned a
  number) the same way `battMinutesLeft()` refuses to speak early — see the burn
  estimator comments in `usage.js` for the two-estimator derivation (ring slope for
  short windows, window average for long ones, crossing over at 2 days).
- **A and C are not what shipped.** Their internal geometry is unbound and is shown
  only as the record of what was compared against B before B was picked.
