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

**The picture is now BEHIND what ships, in three named ways** — the `WAS` table
records each with its reason and asserts it genuinely differs, so a live constant
cannot be parked there to escape the bind:

- the header was **two rows of 54px**; it is one row of **42** now, which bought
  the 27th line of text
- the body therefore starts 16px higher and shows **27** lines, not 25
- the mock predates code-block panels, heading accents and the `+` continuation
  marker entirely

Everything still shared is bound. Treat the spec and the board header as the
authority and this page as the design's origin rather than its current state.

**Bound to the header:** `node check.mjs` asserts every constant this page shares with
`board_es3c35p.h`, parsed from both sides. The two deliberate differences above live in a
separate `WAS` table which is asserted to genuinely differ from what ships, so a live
constant cannot be parked there to escape the bind.
