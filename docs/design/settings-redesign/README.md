# Settings redesign — the design artifact

`settings.html` + `settings.js` are a **pixel-accurate mock of board 2's settings
tab**, and they are the geometric spec the firmware is built from. Serve this
directory and open `settings.html`.

Why it is committed rather than left in a scratch directory, which is the same
reason `text-widths-board2.txt` is committed: it is the only place the redesign's
numbers exist in a form anyone can re-run.

**It is an AS-SHIPPED picture now, not a proposal.** It draws three columns:

- **what ships** — HOME and all six groups (Device, Display, Sound, Pairing,
  Messages, Danger), plus the Macs page at its worst case of four filled slots.
- **the seven-group design**, which this mock drew until the amendment of
  2026-09-12 replaced it, once board 1's Macs page turned out to spend 216 of its
  222px and RESET PAIRING had nowhere to go. Kept and marked rather than deleted,
  per this repo's rule about descriptions that turned out to be wrong; only the
  three screens the amendment actually moved are drawn, because Display, Sound and
  Pairing were identical in both.
- **what shipped before the branch** — the four-page chevron pager.

Four properties make it worth trusting:

- **The type is the real thing.** `spleenfonts.js` is extracted from
  `Spleen8x16.h` and `Spleen12x24.h` — the headers the firmware links — by the
  script in this repo's history. The 8x16 half was cross-checked against an
  independently generated copy: **95/95 glyphs identical**. No Mac font appears
  anywhere; an earlier mock reached for Menlo and flattered the design by about
  30% more ink than the panel can put on the glass.
- **The geometry is parsed, not invented.** Every constant in `settings.js`'s `K`
  is asserted by name against `board_es3c35p.h`, through the geometry checkers'
  own `consts()`. The two before pictures live in `WAS`, deliberately unbound —
  with the rule that every entry there must actually DIFFER from what ships, so a
  live constant cannot be parked in it to escape the bind. The seven-group
  entries carry a `G7_` prefix and the checker **resolves that prefix before
  applying the rule** rather than exempting them from it: a marker that bought an
  entry its way out would be the escape hatch the rule exists to close.
- **The NAMES are parsed too.** HOME's six row names are asserted against
  `settingsGroupTitle()`'s own body and its count against `SET_GROUP_COUNT`, and
  each summary against `HOME_SUB_CHARS` — so a group renamed in the firmware, or a
  summary that outgrows the lane the device pads to, fails here rather than on the
  glass.
- **It checks itself.** `node check.mjs` renders all fifteen screens headlessly and
  asserts nothing leaves the panel, no content text reaches the footer, and every
  string is inside Spleen's `0x20..0x7E` — the blank-box trap this repo has paid
  for six times.

```
node docs/design/settings-redesign/check.mjs
```

**Proven by injection, 2026-09-12** (change the header, run the checker, revert):

| injected in the firmware | what the mock says |
|---|---|
| `HOME_ROW_H` 58 → 59 | 1 failure, `K.HOME_ROW_H is 58, the firmware says 59` |
| `SET_CAP_STEP` 24 → 25 | **14** failures by name, the whole derivation chain — `P1_THEME_Y`, `PS_*`, `P2_PAIR_Y`, `P2_PWR_Y`, `P4_ROW_Y`, `P4_HINT_Y` |
| `settingsGroupTitle()`'s `default` → `"Peril"` | `HOME row 5 is "Danger", settingsGroupTitle() says "Peril"` |

**What it does NOT prove:** nothing here has been on the glass, and board 2's
`SCREENSHOT` reads the shadow framebuffer anyway. It is arithmetic and bitmaps,
which is the right instrument for layout and the wrong one for colour. The full
unverified list is at the foot of `settings.html` and in
`docs/reference/settings-tab.md`.
