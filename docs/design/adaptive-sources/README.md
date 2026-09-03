# Adaptive USAGE sources — the solo-column mock

`adaptive.html` is a browser mock of board 2's USAGE tab in three states: the
duo column as it reads today (Codex row present, bordered, carrying `--`), the
shipped "grow both" solo column (Codex row hidden, NOW and WEEK grow to fill
the reclaimed 64 rows), and a rejected alternative ("all to NOW") kept as the
record of what was compared and passed over — the same reason
`docs/design/usage-redesign/usage.js` still draws its own rejected layouts A
and C.

## What this vouches for

**Geometry, and only geometry.** Every glyph on the page is the real Spleen
bitmap, extracted from the Adafruit-GFX headers the firmware actually links
(`Spleen8x16.h` / `Spleen12x24.h` / `Spleen32x64.h`), not a browser font
standing in for one. The page inlines `../usage-redesign/spleenfonts.js`
verbatim and `../usage-redesign/usage.js` up to (not including) its
`const hit =` line — everything above that line is pure painters with no DOM
access, so the "Grow both" and "Today" panels are drawn by the SAME
`leadCard` / `capRow` / `heroSide` / `codexRow` functions the shipped
`usage-redesign` mock uses, patched only by overriding `K` with the ten
`*_SOLO` values.

`check.mjs` is what makes that claim durable rather than a one-time
screenshot: it parses `board_es3c35p.h` through the geometry checkers' own
`consts()` (the same parser `usage-geom-check.mjs` binds against) and asserts
every one of the ten solo constants — `NOW_CARD_H_SOLO`, `NOW_SPARK_H_SOLO`,
`NOW_META_Y_SOLO`, `WEEK_CARD_H_SOLO`, `WEEK_NUM_Y_SOLO`, `WEEK_BURN_Y_SOLO`,
`WEEK_BAR_Y_SOLO`, `WEEK_META_Y_SOLO`, `WEEK_FABLE_Y_SOLO`,
`WEEK_FABLE_BAR_Y_SOLO` — by name against the header, plus the identity that
the solo column sums to exactly the same content area (`SP_2 + NOW_CARD_H_SOLO
+ SP_2 + WEEK_CARD_H_SOLO + SP_2 == BOARD_H - FOOTER_H - CONTENT_Y`, i.e.
414). A committed mock whose numbers can drift while it still reports
"passed" is the same class of defect as an assertion that cannot fail — this
repo has paid for that mistake three times over (the settings redesign's
`geom-common.mjs` parse-vs-transcribe rule, `usage-geom-check.mjs`'s own
solo-column identity, and `usage.js`'s WAS/K split) and this mock does not
repeat it.

The rejected "All to NOW" panel is deliberately **not** bound to the header —
nothing in `board_es3c35p.h` answers to it, since it was never shipped. It is
instead checked the opposite way: `check.mjs` asserts its three overridden
constants (`NOW_CARD_H`, `NOW_SPARK_H`, `NOW_META_Y`) actually *differ* from
the shipped "Grow both" values. A rejected-panel constant equal to the shipped
one would record nothing and is exactly how a live constant escapes the bind
— the same rule `docs/design/usage-redesign/check.mjs` applies to its own
`WAS` table.

## What this cannot vouch for

**Colour on the panel.** The theme toggle here reproduces the DARK/LIGHT
`THEMES[]` RGB565 values converted to CSS `rgb()`, which is the correct
arithmetic — but it is rendered by a browser `<canvas>`, not read off the
glass. Board 2's own `SCREENSHOT` command reads the shadow framebuffer rather
than the panel, so even a capture off real hardware cannot settle a colour
question there (see the verification trap under "Two boards" in the top-level
`CLAUDE.md`). The only instrument that can see board 2's actual colour
pipeline is `COLORTEST` plus a person looking at the device. This mock is
silent on that question by construction, and the README says so rather than
implying otherwise.

## Running the checker

```
node docs/design/adaptive-sources/check.mjs
```

It fails loudly (`FAIL  <constant>: mock says X, header says Y`) if
`adaptive.html` and `board_es3c35p.h` ever disagree, and fails just as loudly
if `adaptive.html` goes missing entirely (Step 1 of the task brief proved
this: `node docs/design/adaptive-sources/check.mjs` against a moved-aside
`adaptive.html` throws `ENOENT` and exits 1). Prove the bind has teeth by
changing any one of the ten `*_SOLO` values in `board_es3c35p.h` and
re-running — the failure names the exact constant, both numbers, and nothing
else goes red.

## Files

- `adaptive.html` — the mock. Self-contained (fonts/CSS/JS all inline except a
  Google Fonts stylesheet link), so it opens correctly from `file://` with no
  path resolution beyond itself.
- `check.mjs` — binds `adaptive.html`'s solo constants to `board_es3c35p.h`.
- `README.md` — this file.

Reused, not copied: `../usage-redesign/spleenfonts.js` and
`../usage-redesign/usage.js` are inlined into `adaptive.html` by value (the
page has to be one static file to publish and open standalone), but they are
the same bytes committed there — regenerate `adaptive.html` from those two
files plus the driver at the bottom rather than hand-editing the inlined copy
if either one changes upstream.
