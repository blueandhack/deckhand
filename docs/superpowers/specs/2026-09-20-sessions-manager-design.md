# Nothing disappears silently: the sessions manager

Design, 2026-09-20. Board 2 first; board 1 refuses by name.

## The complaint, and the number behind it

"I want to get disappeared sessions." Counted on this Mac the same day:

| | count |
|---|---|
| sessions the device can see | **1** |
| transcripts in this one project | 22 |
| **transcripts across all projects** | **132** |

**131 of 132 conversations are unreachable from the device.** They are not lost - every one is a
`.jsonl` in `~/.claude/projects/` - they are simply not addressable from the glass.

## Three causes, and only one of them matters

1. **The session ENDED.** `claude-hooks/deckhand-session-hook.mjs` does
   `fs.rmSync(filePath, { force: true })` on `SessionEnd`. The record is deleted the instant the
   session ends. **This is essentially all 131.** The transcript is untouched.
2. **It went stale.** `SESSION_STALE_MS` is 20 minutes; the host skips older files. The record
   still exists.
3. **It did not fit.** `SESSION_ROW_CAP` is 20.

Cause 1 dominates so completely that the other two are rounding errors, and it points at the
real defect below.

## THE DEFECT IS NOT THAT HISTORY IS UNREACHABLE. IT IS THAT A SESSION VANISHES IN SILENCE.

A manager alone does not fix this. You close a session, the row is gone on the next 5-second
tick, and nothing on the device ever says where it went or that it still exists. Building an
archive and leaving that untouched would answer the question the user asked and not the one
they have.

So this design is two things, and the second is the one that changes the daily experience:

1. A **PROJECTS tab** that reaches all 132.
2. **SESSIONS never letting a row disappear without saying so.**

## Part 1: SESSIONS, redesigned

Two changes, both small, neither touching the row itself.

**A fourth tab.** `TAB_COUNT` goes from 3 to 4. The arithmetic was checked before this was
proposed, because "the tab bar is full" was the assumption that nearly sent this to a
full-screen surface instead:

| | slot at 3 tabs | slot at 4 | label width | margin each side |
|---|---|---|---|---|
| board 1 | 80px | 60px | 48px | 6px |
| board 2 | 106px | 80px | 64px | 8px |

Tab labels are drawn with `setUIFont(1)`, which is `T_META` - Cozette 6x13 on board 1, Spleen
8x16 on board 2 - **the SMALL font, not the head font.** "PROJECTS", "SESSIONS" and "SETTINGS"
are all 8 characters, so they cost 48px and 64px respectively and fit on both boards with
margin. The active underline is `tabW - 16`, so 44px and 64px, which still reads.

SETTINGS already proves two-level navigation inside a tab (`PAGE 0` is its HOME menu,
`1..SET_GROUP_COUNT` its groups), so PROJECTS -> a project's sessions needs no new surface type.

**The ghost row and the count line.** A session that ends does not vanish on the next tick. It
stays for a grace period as a DASHED row - `COLOR_UNKNOWN` dot, `ended 4m ago` where the status
was - and then retires. Below the last row, a count line: `129 more in PROJECTS >`, tappable,
switching tabs.

**The count line floats under the last row rather than sitting at a fixed y**, and that is what
makes it free. With five live sessions the list is full, you are busy, and the line is off the
bottom where it belongs. With one live session - which is the normal case, measured above - there
is a screen of empty space and the line is prominent in it. A fixed position would have cost a
row permanently, and a 5-row list cannot spare one.

Nothing else about SESSIONS changes: same row shape, same urgency ranking, same colours, same
signatures.

## Part 2: PROJECTS

Two levels, matching what the SETTINGS tab already does.

**Level 1 - projects.** Name, session count, last activity. Built from `readdir` + `stat` on
`~/.claude/projects/` with **no file reads at all**, so 16 projects costs nothing on the Mac.
The directory name IS the path (`-Users-yujia-projects-deckhand`), so no index is needed. Live
projects (one whose session is in the current list) are drawn in `COLOR_VALUE`, the rest in
`COLOR_LABEL`.

**Level 2 - a project's sessions.** Title, age, turn count, and a `LIVE` / `ended` tag. Titles
come from reading each `.jsonl`'s tail, which is what `transcriptInfo()` already does - **on
demand, when the level opens, cached**, never on the tick.

**Level 3 is not new.** Tapping a session opens the EXISTING scrollback surface. Wrap, line
index, drag, markup, the CHAT/ALL filter and the whole `scrollback.ino` renderer already work;
this design adds no reader.

## The one real gap in the host

`transcriptById` is populated only from the live ranked list (`host/index.mjs`, in the tick
builder and in the lean-row loop). An ended session's transcript is therefore **unreachable**:
`resolveSessionId` searches `deckhand-sessions/*.json`, which is precisely the set
`SessionEnd` deletes.

So the host needs one new capability: resolve a session id to its `.jsonl` via
`~/.claude/projects/`, independently of the live list. Once that exists the entire reading path
is reuse. This is the smallest load-bearing change in the design and it should be built first,
because everything else is a UI on top of it.

## The wire

Request/response when a level opens, like the scrollback - **never on the tick**. Pushing the
inventory in the 5-second payload was considered and rejected on measured numbers: 132 sessions
at ~150 bytes is ~20KB per poll against a link measured at 6.6 KB/s, which is three seconds of
radio every five seconds for a screen that is usually closed.

Projected against the fetch model measured on 2026-09-20
(`~150ms + (N-1) x ~130ms ACK + bytes x 0.022ms`):

| fetch | payload | chunks | projected |
|---|---|---|---|
| project list (16) | ~1.1KB | 1 | ~175ms |
| one project's sessions (22) | ~2KB | 1 | ~200ms |

**Both are single-chunk**, which means they skip the per-chunk ACK round-trip entirely - the
discontinuity measured this session, where a one-chunk fetch came back in 208ms against 1358ms
for the same bytes in eight chunks. Sub-250ms is not a hope here, it is the model's output.

One field joins the tick, because it is 20 bytes and it is what makes the count line honest:
`projects=16 sessions=132`.

## RESUME MEANS A HEADLESS TURN, AND THE UI MUST NOT IMPLY OTHERWISE

The host already runs `execFile(CLAUDE_BIN, ["-p", "--resume", sessionId, text])` for dictated
answers. Resuming from the device sends a prompt into a finished session and a reply comes back;
the hook then republishes the record, so the session reappears in the live list.

**It does not open an interactive session on the Mac.** There is no terminal for the device to
open, and pretending otherwise is the sort of gap that is discovered after shipping. The button
says RESUME and the screen states what that does.

Read and resume are the ONLY actions. Decided with the user, 2026-09-20: no archive, no delete.
Deleting would unlink the only copy of a conversation, irreversibly, from a fingertip, with no
undo anywhere in the system - so the whole class is designed out rather than guarded. A
consequence worth stating: the device cannot mutate the Mac's filesystem at all here, which
makes the entire feature safe to use one-handed without looking.

## Out of scope

- **Board 1.** It has no scrolling list (`SESSION_SLOTS 6`), so 16 projects in 6 rows needs its
  own paging answer, and that should not block the feature. It refuses the new verbs by name
  from `UNAVAILABLE_COMMANDS[]`, the same as every other board-2-first feature on this branch.
  Note the tab arithmetic above DOES work there, so this is a scope choice, not a constraint.
- **SD.** Nothing here needs the card: all 132 are on the Mac. The offline spec
  (`2026-09-20-sd-offline-sessions-design.md`) becomes a cache behind these screens once they
  exist, which is why it was resequenced to follow this.
- Starting a NEW session from the device, and the project picker for it.
- Archive and delete, per above.

## Risks

1. **Enumeration grows without bound.** 132 today. The project list stays cheap (`stat` only),
   but a project with 500 sessions is 500 tail reads and a list that cannot be paged. Needs a cap
   and an honest "showing N of M" from the first version, not after it bites.
2. **The tab bar is shared code**, so this moves BOTH binaries - and unlike `SDPROBE`'s
   rodata-only +704, this one changes `.flash.text`. Expected; to be measured and explained.
3. **`TAB 0..2` becomes `TAB 0..3`.** `commands-check.mjs` parses that range out of CLAUDE.md
   and fails by name if the prose drifts, so the doc and the firmware cannot disagree silently.
4. **The ghost row needs a retirement rule.** Too short and it does not help; too long and the
   live list fills with the dead. Unmeasured; start at a few minutes and see.

## What is measured and what is not

Measured, 2026-09-20:

- 1 live session, 22 transcripts in this project, 132 across all projects.
- `SessionEnd` deletes the record (read from the hook, line 648).
- Tab-label font is `setUIFont(1)` = `T_META`, and the four-tab arithmetic above.
- The BLE fetch model the wire projections use, from 13 samples.

NOT measured:

- The projected fetch times. They are the model's output for payloads nobody has sent yet.
- Mac-side cost of reading 22 JSONL tails, and how it scales at 500.
- Whether a ghost row confuses more than it helps. It is a judgement, and it is the part of this
  design most likely to be wrong.
