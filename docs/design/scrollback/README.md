# Scrollback mock

The visual and interaction mock for board 2's session history redesigned as a scrolling
transcript. Open `scrollback.html` in a browser; the right-hand panel is genuinely draggable.

Both device panels render at **1x real geometry** — 320x480, an exact 8px advance standing in
for Spleen 8x16, and the live `THEMES[]` palette. Toggles cover the light palette, the ALL
filter, filled user blocks, and the smooth-versus-quantised scroll question.

**Authority:** `docs/superpowers/specs/2026-09-03-scrollback-transcript-design.md`. Where the
mock and the spec disagree, the spec wins — it is arithmetic checked against the board header,
and the mock is a picture. Two known deliberate differences:

- The mock draws **25 lines** with a 12px bottom margin; the spec tightens that to the 4px the
  USAGE column already uses, giving **26**.
- The mock's `pushImage`-clipped partial lines are simulated by CSS overflow, which cannot
  represent the real frame cost.

**Bound to the header:** `node check.mjs` asserts every constant this page shares with
`board_es3c35p.h`, parsed from both sides. The two deliberate differences above live in a
separate `WAS` table which is asserted to genuinely differ from what ships, so a live
constant cannot be parked there to escape the bind.
