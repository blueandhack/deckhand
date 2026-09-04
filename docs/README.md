# Deckhand documentation

Everything is **plain Markdown in this repository**, on purpose. It is versioned with the code
it describes, readable by any person or agent with a checkout, and needs no network. A GitHub
wiki was considered and rejected for exactly those reasons: a wiki is a *separate* git repo, so
an agent working in this checkout cannot read it, and it drifts from the code the moment
either moves.

## Where to start

**If you are an AI agent working on this code, read [`../CLAUDE.md`](../CLAUDE.md) first.** It
is short and it is the rules — the things that cause real damage if you do not know them — and
it ends with a table saying which file below to read before touching what. Do not read all of
`reference/`; read the one file for the thing you are changing.

**If you are a person**, [`guide/`](guide/) is for you and [`reference/`](reference/) probably
is not.

### `guide/` — for people

| file | what |
|---|---|
| [overview.md](guide/overview.md) | what each of the three tabs shows, in full |
| [hardware.md](guide/hardware.md) | the two boards, wiring, the case, what to buy |
| [install-and-uninstall.md](guide/install-and-uninstall.md) | setup in detail, and backing all of it out |
| [controls.md](guide/controls.md) | what every tap does |
| [answering.md](guide/answering.md) | answering permission prompts and questions from the device |
| [voice.md](guide/voice.md) | dictation and speech-to-text |
| [codex.md](guide/codex.md) | Codex threads in the same list |
| [security.md](guide/security.md) | what the remote can and cannot do, and how it is authenticated |
| [menu-bar.md](guide/menu-bar.md) | the optional Mac menu-bar app |
| [how-it-works.md](guide/how-it-works.md) | the data flow, and why the host runs inside an app bundle |

### `reference/` — for whoever is changing the code

Fifteen files, one per area. Each was extracted **verbatim** from the single 6,600-line
CLAUDE.md this replaced, so the measurements and the reasoning are intact.

| file | what |
|---|---|
| [boards.md](reference/boards.md) | the two boards, the panel shim, the shadow framebuffer, bring-up traps, touch, sleep |
| [commands-and-checks.md](reference/commands-and-checks.md) | every instrument and checker, the binary baseline, the fault-injection sweep |
| [settings-tab.md](reference/settings-tab.md) | board 2's HOME screen and five groups |
| [usage-tab.md](reference/usage-tab.md) | NOW / WEEK / CODEX, the trend ring, the burn estimators, the adaptive column |
| [sessions-and-asks.md](reference/sessions-and-asks.md) | session rows, the detail screen, asks, the on-device keyboard |
| [scrollback.md](reference/scrollback.md) | board 2's scrolling transcript |
| [power-and-battery.md](reference/power-and-battery.md) | the divider, time-remaining, charging, SoC temperature |
| [audio-and-voice.md](reference/audio-and-voice.md) | mic wiring and capture, the beeper, dictation, whisper.cpp |
| [pairing-and-multi-mac.md](reference/pairing-and-multi-mac.md) | per-Mac keys, wireless pairing, two Macs at once |
| [hooks-and-answering.md](reference/hooks-and-answering.md) | the hook scripts, the `ask` object, which event blocks |
| [codex-and-history.md](reference/codex-and-history.md) | Codex push and pull, the paged history reader |
| [host-runtime.md](reference/host-runtime.md) | `host/index.mjs`: the watchdog, OAuth refresh, log rotation |
| [menu-bar.md](reference/menu-bar.md) | `DeckhandMenuBar.swift` and its own checkers |
| [ui-details.md](reference/ui-details.md) | the type scale, generated art, themes, the waiting screen |
| [board-1-known-state.md](reference/board-1-known-state.md) | board-1 defects, unverified claims, open items |

### `superpowers/` and `design/`

[`superpowers/specs/`](superpowers/specs/) holds design specs and
[`superpowers/plans/`](superpowers/plans/) the implementation plans that argued from them —
dated, and kept as the record of *why* a thing is shaped the way it is.
[`design/`](design/) holds committed pixel-accurate mocks, each with a `check.mjs` that
**parses the board header** so the mock cannot silently drift from what ships.

## How to keep this correct

These are the rules the content itself was written under. They are the reason it is worth
reading, so keep to them.

1. **State what was MEASURED and what was not.** Nearly every number here came off real
   hardware at a specific commit. Do not paraphrase one, do not round one, and do not "tidy"
   one. If you change the behaviour, change the number and say what you measured.
2. **Write down what is NOT verified.** Most reference files end with an explicit
   "what is not verified" list. That list is the most valuable part for the next reader, and
   an empty one is almost always a lie.
3. **Correct in place; do not delete.** An entry that turned out to be wrong is kept and
   marked as a correction, because a described defect that no longer exists costs the next
   reader either the time to disprove it or a no-op "fix". Several entries here exist only as
   the record of a claim that was false.
4. **A doc is not a substitute for a check.** Where a rule can be asserted in code it should
   be, and the doc should name the checker. Prose cannot be run, and this repo has been bitten
   by comments that described behaviour the code had stopped having.
5. **Update `CLAUDE.md`'s index when you add a file here**, or an agent will never find it.
   `CLAUDE.md` is auto-loaded; nothing in `docs/` is.
