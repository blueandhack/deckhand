# Ask Options That Carry Their Descriptions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the device show what an option MEANS, not just its label — so a four-way `AskUserQuestion` is answerable from the glass instead of only on the Mac.

**Architecture:** Approach **B** of the mockup round: the option buttons do not change, and a `WHAT DO THEY MEAN` button opens the **existing** `drawReader()` with every option and its whole description. The work is therefore mostly on the HOST, which currently throws the descriptions away, plus one per-board storage constant and one new reader mode.

**Tech Stack:** Node (the Claude Code hook), Arduino C++ (ESP32-S3), Node ESM checkers, `arduino-cli`.

**Mockup:** `scratchpad/mock/ask.html` — four approaches at true geometry, plus the reader render that this plan implements. It is what produced the findings below.

## Global Constraints

- **THIS PIECE MOVES BOARD 1'S BINARY ON PURPOSE.** Unlike the last two pieces, `SessionInfo` is shared, so a new member touches board 1. Re-baseline with `node firmware/board-baseline.mjs <bin> --update 1` and say in the commit message WHY. Until the deliberate task that does it, `--check 1` reporting `CHANGED` in any OTHER task is still a bug to find.
- **Never compile both boards concurrently** — one shared build cache keyed on the sketch path. Board 2 first, then board 1, ~3 min each.
- **A checker must PARSE the constant it certifies, never TRANSCRIBE it.** **TWELVE vacuous assertions have been caught in this project.** Assume yours is the thirteenth until you have reverted the change and watched the checker fail BY NAME.
- **A change-only cache shorter than the string it stores silently stops noticing changes.** `askOptDesc` enters `buildDetailSignature`'s territory — re-derive, do not assume.
- **The hook must never write to stdout except a genuine `emitDecision()`** — any stray JSON on a `PermissionRequest` hook's stdout can auto-allow or auto-deny the dialog.
- Board 1 FQBN: `esp32:esp32:esp32:PartitionScheme=huge_app`
- Board 2 FQBN: `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app`
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## What the mockup round established — do not re-derive

| finding | measured |
|---|---|
| The descriptions never reach the device | the hook does `map((o) => clean(o?.label ?? o, 32))` — it takes `o.label` and **discards `o.description`** |
| "Just make the buttons taller" fails | 4 rich options + the input row leaves the question **−5px**: it does not fit at all |
| The reader already has room | 4 options with full descriptions are **20 lines of the 22** a page holds — one page, PREV/NEXT grey out |
| RAM is not the blocker it looked like | board 2 uses 63,276 of 327,680; 96-char descriptions cost **+2.3KB across six sessions**, 0.9% of free |
| The reader's line step was broken | fixed separately on `reader-line-step` — **that branch must land first**, or this feature ships on a screen that chops descenders |

**Ruling, taken from this repo's own precedent:** the per-option description size is a **per-board CONSTANT in each board header**, not an `#if` at the declaration. CLAUDE.md records why — with the size behind an `#if`, `cacheSizes()` parsed one branch and reported the same number for both boards, so board 1 carried a false reading. Board 1 gets the minimum legal size and pays ~24 bytes it does not use; that is the price of one code path the checker can see.

---

## File Structure

| file | responsibility | change |
|---|---|---|
| `claude-hooks/deckhand-session-hook.mjs` | stop discarding `o.description`; cap it | modify |
| `host/index.mjs` | pass the descriptions through in the payload | modify |
| `firmware/deckhand_display/board_es3c35p.h` | `ASK_OPT_DESC_BYTES` (real), the button's geometry | modify |
| `firmware/deckhand_display/board_e32r28t.h` | `ASK_OPT_DESC_BYTES` (minimum) — **board 1 moves; deliberate** | modify |
| `firmware/deckhand_display/deckhand_display.ino` | `SessionInfo.askOptDesc`, the parse | modify |
| `firmware/deckhand_display/sessions.ino` | the `WHAT DO THEY MEAN` button and its hit test | modify |
| `firmware/deckhand_display/reader.ino` | an options mode for `drawReader()` | modify |
| `firmware/deckhand_display/sessions-geom-check.mjs` | the button's geometry and gating | modify |

---

### Task 1: The host stops throwing the descriptions away

Deliberately first and separable: it is observable in the host log with no firmware at all, and an un-upgraded device ignores the new field.

**Files:** Modify `claude-hooks/deckhand-session-hook.mjs`, `host/index.mjs`

**Interfaces:** Produces `ask.optDescs` — an array of up to 4 strings, each capped, parallel to `ask.options`. Absent when no option carries a description.

- [ ] **Step 1: Send the descriptions**

In the hook, the line that discards them is:

```js
const opts = (q.options ?? []).slice(0, 4).map((o) => clean(o?.label ?? o, 32));
```

Keep it, and add a parallel array built from `o?.description`. Cap each with the same `clean()` the labels use, at the byte budget Task 2 settles — start from **96**. Emit `optDescs` only when at least one is non-empty, so an Allow/Deny prompt's payload does not grow at all.

**Backward compatibility is free and must be preserved:** a device that does not know the field ignores it, exactly as the trailing `to=<hostId>` address and the `<cols>x<lines>` history budget already do. No protocol version bump.

- [ ] **Step 2: Prove it with a captured payload, not by reading**

The repo's own technique: feed a captured `PermissionRequest` payload to the hook against a throwaway `$HOME` and inspect the session record it writes. A real `AskUserQuestion` fires `PreToolUse` then `PermissionRequest`, and it is the **`PermissionRequest`** that carries `questions[0]` with real option labels — and descriptions. Assert the record now contains them.

**The hook must print NOTHING to stdout but a genuine decision.** Verify stdout is empty in the non-decision case; a stray line there can auto-answer a real dialog.

- [ ] **Step 3: Measure the wire cost**

A tick's payload is ~779 bytes for one session today; the device's line buffer guard is 16000 and `askDetail` alone is capped at 1400. Compute the worst case — 6 asking sessions × 4 descriptions × the cap — and confirm it clears the guard with room. **If it does not, the cap is what moves, not the guard.** Report the number.

- [ ] **Step 4: Commit**

---

### Task 2: Device storage, and the deliberate board-1 move

**Files:** Modify both board headers, `deckhand_display.ino`

- [ ] **Step 1: Add the per-board size constant**

`ASK_OPT_DESC_BYTES` in each header — board 2 the real cap + 1, board 1 the minimum legal size (a zero-length array is not legal C++). Comment the derivation in each, and say plainly in board 1's that it is a placeholder for a feature that board does not draw.

- [ ] **Step 2: Add the member and the parse**

`char askOptDesc[4][ASK_OPT_DESC_BYTES];` beside `askOpts`. Parse `optDescs` in the ask block; absent means empty, which must render as "no description" rather than an empty reader page.

- [ ] **Step 3: Re-derive the signature**

`askOptDesc` changes what a repaint must notice. Re-derive `detailSigCache` field by field against the real `snprintf` — it was 359/363 against a 384 declaration after the last piece, so there is headroom, but **prove it rather than spending it blind**.

- [ ] **Step 4: Compile board 2, then board 1 — and RE-BASELINE board 1**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1    # CHANGED, expected
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --update 1
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1    # UNCHANGED
```

Record board 1's byte delta AND its RAM delta in the commit message, with the reason. This is the one task in this plan permitted to move it.

- [ ] **Step 5: Re-run the mask selftest**

A real source change is exactly when the baseline mask should be re-proven. Compile twice into different directories so the builds are genuinely independent, then:

```bash
node firmware/board-baseline.mjs --selftest /tmp/b1a/deckhand_display.ino.bin /tmp/b1b/deckhand_display.ino.bin 1
```

Raw hashes must differ, masked hashes agree. If it reports uncovered runs, fix the mask before trusting any `--check`.

- [ ] **Step 6: Commit**

---

### Task 3: The button and the reader mode

**Files:** Modify `sessions.ino`, `reader.ino`, `board_es3c35p.h`, `sessions-geom-check.mjs`

**Interfaces:** Consumes `askOptDesc`; produces a reader mode flag the draw and the touch handler BOTH read, so they cannot disagree about which screen is up.

- [ ] **Step 1: The button**

Top-right of the ask header, the slot `READ ALL` already uses (`ASK_READ_BTN_X` 218, `ASK_READ_BTN_W` 90, `ASK_READ_BTN_H` 46). **Two buttons cannot share one slot** — settle what happens when a question has BOTH a long detail (READ ALL) and descriptions, and say which wins or how they share. That is a real design question the mockup did not answer; do not paper over it.

**Gate it on descriptions actually existing.** With no description the button must not draw AND must not claim taps — this repo's rule, paid for once already: "drawn-but-dead and tappable-but-dead are two different bugs".

- [ ] **Step 2: The reader mode**

`drawReader()` already paints a header, a rule, wrapped text and a `< PREV / CLOSE / NEXT >` bar. Add a mode that composes its body from the options rather than from `askDetail`. **Reuse the pagination**; do not fork it.

Use `READER_CODE_LINE_H` — the constant the `reader-line-step` branch introduces. **That branch must be merged first**; if it is not, stop and say so rather than re-introducing a 14px step under a 16px cell.

- [ ] **Step 3: Assertions with teeth**

At minimum: the button's tap zone clears `TAP_MIN` in both axes; the button is not drawn when no description exists; the options body's line step is >= the face's cell height (the bug this screen just had); and the two-buttons-in-one-slot resolution from Step 1 is asserted rather than left to care. Prove each by mutation and report the messages.

- [ ] **Step 4: Flash and verify on the glass**

A real four-option question is the case. Drive one, open the ask screen, tap the button, capture the reader. Confirm all four options and their whole descriptions are legible and that descenders are intact — the reader's own bug was chopping them until the branch above.
**Board-2 caveat:** `SCREENSHOT` reads the shadow framebuffer, so it proves the renderer self-consistent, not the panel's colours.

- [ ] **Step 5: Commit**

---

### Task 4: Verification and documentation

- [ ] **Step 1: Every checker, both selftests, the sweep**

- [ ] **Step 2: Board 1 `--check 1` UNCHANGED against the NEW baseline**

- [ ] **Step 3: Document it**

CLAUDE.md gains: that option descriptions now cross the wire and where they are capped; that the ask screen has a second reader mode; the board-1 re-baseline and its reason; and the updated flash/RAM for both boards. Record the mockup round's four findings as found-and-resolved — including that "taller buttons" was measured at **−5px** and rejected, so nobody proposes it again.

- [ ] **Step 4: Commit**

---

## Self-Review

**Coverage.** The host discard → Task 1. Storage and the board-1 move → Task 2. The button and the reader → Task 3. Verification and docs → Task 4.

**Placeholder scan.** None. The one number left open — the description cap — is stated as "start from 96" with Task 1 Step 3 measuring whether the wire tolerates it; that is a measurement, not a TBD.

**Type consistency.** `ask.optDescs` (host) → `askOptDesc[4][ASK_OPT_DESC_BYTES]` (device) is the only new interface, named in Tasks 1 and 2 and consumed in Task 3.

**Two weaknesses, stated rather than hidden.** (1) **The two-buttons-one-slot problem is unresolved** — Task 3 Step 1 names it and requires an answer rather than pretending READ ALL and the new button can coexist. (2) **This plan depends on `reader-line-step` landing first.** If it does not, Task 3 builds on a screen that chops descenders, and Step 2 says to stop rather than work around it.
