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

**This mock is NOT yet bound to `board_es3c35p.h`.** Every other committed mock here parses the
constants it shares with the header, so it cannot silently drift while still reporting a clean
pass. That bind (`check.mjs`) is the implementation plan's first task and cannot be written
before the `SCROLL_*` constants exist. Until then, treat the numbers in the spec as the
authority and the numbers in this page as illustration.
