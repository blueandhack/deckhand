# Settings redesign — the design artifact

`settings.html` + `settings.js` are a **pixel-accurate mock of board 2's settings
tab**, and they are the geometric spec the firmware is built from. Serve this
directory and open `settings.html`.

Why it is committed rather than left in a scratch directory, which is the same
reason `text-widths-board2.txt` is committed: it is the only place the redesign's
numbers exist in a form anyone can re-run.

Three properties make it worth trusting:

- **The type is the real thing.** `spleenfonts.js` is extracted from
  `Spleen8x16.h` and `Spleen12x24.h` — the headers the firmware links — by the
  script in this repo's history. The 8x16 half was cross-checked against an
  independently generated copy: **95/95 glyphs identical**. No Mac font appears
  anywhere; an earlier mock reached for Menlo and flattered the design by about
  30% more ink than the panel can put on the glass.
- **The geometry is parsed, not invented.** Every constant in `settings.js`'s `K`
  came from `board_es3c35p.h`.
- **It checks itself.** `node check.mjs` renders all ten screens headlessly and
  asserts nothing leaves the panel, no content text reaches the footer, and every
  string is inside Spleen's `0x20..0x7E` — the blank-box trap this repo has paid
  for four times.

```
node docs/design/settings-redesign/check.mjs
```

**What it does NOT prove:** nothing here has been on the glass, and board 2's
`SCREENSHOT` reads the shadow framebuffer anyway. It is arithmetic and bitmaps,
which is the right instrument for layout and the wrong one for colour.
