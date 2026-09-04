# What Deckhand shows, tab by tab

> The long-form overview that used to open README.md, kept because shortening the
> README should not mean losing it. Index: [`docs/README.md`](../README.md).

---

A little desk display and remote for Claude Code — the crew member who keeps
lookout and relays your orders. Built on an ELEGOO 2.8" ESP32 touchscreen
module, with optional battery and speaker. It shows live plan usage and
per-project session status, beeps when a session needs you, and shows permission
prompts, questions, and plan approvals so you can read *and* answer them from
across the room — tapping an option, or **speaking** the answer to a question if
the microphone is fitted — without taking the dialog away from your Mac. **Codex threads
appear in the same list** and, once Codex's own hooks trust prompt is accepted,
can be answered the same way; installs where that hasn't happened yet fall back
to a read-only view (see [Codex support](#codex-support)). Three tabs:

- **USAGE** — real plan-quota percentage for the current 5-hour session
  window and the current 7-day (weekly, all models) window. Each card has a
  reset countdown plus the wall-clock reset time ("at 14:32"), token counts,
  and a **pace tick** on the bar: a small white marker at the fraction of
  the window that has elapsed, so fill ahead of the tick = burning quota
  faster than time is passing. The weekly card also shows Fable's own
  weekly cap ("Fable: 9%"). Under the two cards, a single **CODEX** row
  carries Codex's own quota percentage, its reset countdown and wall-clock
  reset time, and **its own pace bar with the same pace tick** — Codex
  publishes enough (a reset time and a window length) to work out how much
  of the window has elapsed, so it reads exactly like the cards above it.
  It stays a row rather than a card because it has no token count and no
  second window, which would leave a card half empty. It reads `--`, never
  `0%`, until a rate-limit record has actually been seen: 0% is a
  measurement, and "never measured" is not.
- **SESSIONS** — which Claude Code and Codex projects are currently running
  on this Mac and whether each needs you. Rows stretch to fill the screen when
  you're monitoring only a few projects. Status is a pill whose weight
  matches urgency: solid **NEEDS INPUT** (permission prompt, question, or
  plan approval — Claude is blocked on you), outlined **READY** (turn
  finished), boxless dim **WORKING** (no attention needed). A project name too
  long for the big font **shrinks one step so you see it whole** rather than
  being cut off (up to 22 characters), and the space it has is measured against
  whatever else is on that row, not assumed. With **1-3 sessions on screen** the
  rows are tall enough to also carry the **session title** — Claude Code's own
  generated title, or one you set yourself, which takes precedence ("Refactor
  task modal logic", "Build Docker image version fetcher"). With 4 or more there
  isn't room and the title is dropped rather than squeezed. Codex rows don't show
  one. Each row shows
  model + git branch and a live "in this state for 3m" duration, and is
  tagged `CC` or `CX` (spelled `CLAUDE` / `CODEX` on tall rows) so the two
  tools are told apart by text rather than by colour or an icon. Both go
  into one list and one urgency ranking, so a mixed set sorts by how much it
  needs you rather than by which tool it came from. With more
  sessions than fit, the six most urgent are shown and a "+N more" strip
  admits to the rest (a hidden needs-input session is called out loudly).
  Tap a row for a detail screen showing the project, its title, the status
  with both how long ("for 12m") and when ("14:31"), **the last thing you
  asked it**, the path, and model / branch / start time / agent in paired
  columns — and **if the session is waiting on a prompt, that screen is an
  answer screen** instead: see below.
- **SETTINGS** — paginated (tap the `‹` / `›` pager), four pages:
  **STATUS** (Bluetooth/USB connection state — more trustworthy than macOS's
  Bluetooth panel — plus battery % / voltage and the device's pairing state),
  **DISPLAY & SOUND** (brightness, sleep-timeout, and speaker **volume**
  LOW/MED/HIGH steppers, plus sound on/off, NORMAL/FLIPPED screen-rotation, and a
  DARK / LIGHT / **AUTO** theme button sharing the bottom row), **ACTIONS** (MIC
  TEST, CALIBRATE TOUCH, RESET PAIRING, and POWER OFF in the alert color), and
  **PAIRED MACS** (every Mac the device remembers — tap one to restrict
  answering to it, tap the `x` to forget just that one). Every consequential
  action routes through a confirm dialog that states the consequence, not just
  the question. AUTO is a **clock**, not a light sensor — this board has no ADC
  channel left to put one on — so it runs LIGHT from 07:00 to 19:00 and DARK
  otherwise, keeping time from `millis()` when the Mac is away, and resolving to
  DARK when it has no clock at all (a full-white screen is the worse thing to
  guess wrong at 3am). Both themes are validated for text contrast and for
  colour-blind / greyscale separability of the status colours — consistent
  with status never being carried by colour alone elsewhere in the UI — and
  the choice persists across reboots.

A persistent footer on every tab shows a live clock, a battery pill
(fill level + `chg`/`full`/`%`), and "Xs ago" data freshness, so the
inherent polling delay is always visible rather than hidden. The battery reading
is coloured by level, but charging is treated as a *state* rather than a level —
8% while plugged in is not a warning, so it reads in the accent colour instead of
the alert one. The number, the glyph's fill and the words `chg`/`full` all say it
independently, so nothing there depends on seeing colour.

The device **double-beeps whenever a session transitions into "needs
input"** — the point of the whole build: you find out a session is blocked
on you without checking windows. It beeps at most 3 times per prompt (one
alert + two reminders 30s apart), then stays quiet even if the prompt sits
unanswered. Toggle sound with SOUND on the SETTINGS tab.
