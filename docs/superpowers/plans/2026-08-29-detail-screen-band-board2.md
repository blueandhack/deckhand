# Detail Screen — Band Head — Board 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give board 2's session **detail** screen the same status band the sessions tab now has, replacing the pill, the duration line and the `AGENT` column with one head — and shrink the oversized TYPE chip.

**Architecture:** The band, the mark and the content-derived card height all exist and are reviewed (piece 3). This piece reuses `drawSessionBand()` and the `SESSION_BAND_*` block constants on a second surface, replaces the detail card's column pairs with one dim meta line, and moves the Mac identity onto that line. Board 2 only; board 1's detail screen is untouched.

**Tech Stack:** Arduino C++ (ESP32-S3), `PanelShim`, Node ESM checkers, `arduino-cli`.

**Spec:** [`docs/superpowers/specs/2026-08-28-sessions-redesign-board2-design.md`](../specs/2026-08-28-sessions-redesign-board2-design.md) — **§7 only** (piece 4 of 4). Pieces 1 and 3 are merged (`a3a3dba`); piece 2 (§9) remains.

**Mockup:** `scratchpad/mock/detail.html`, served with `python3 -m http.server 8777`. Drawn at true geometry from `board_es3c35p.h`. It is what produced FINDING 4 and the three decisions below.

## Global Constraints

- **BOARD 1'S BINARY MUST NOT MOVE.** `node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1` must report **UNCHANGED**. A `CHANGED` is a bug to find, never a re-baseline. Everything here sits behind `#if !BOARD_USES_TFT_ESPI` or in `board_es3c35p.h`; `board_e32r28t.h` must stay untouched.
- **Never compile both boards concurrently** — one shared build cache keyed on the sketch path. Board 2 first, then board 1, ~3 min each. A first board-2 build must NOT use `--no-compile`.
- **The detail card repaints WHOLESALE, not per field** — so unlike the usage cards, no clear box can reach its border. That is why `detailSigCache` matters instead: a signature shorter than what it stores silently stops noticing changes.
- **A checker must PARSE the constant or draw site it certifies, never TRANSCRIBE it.** **Seven vacuous assertions were caught during piece 3.** Assume yours is the eighth until you have reverted the change and watched the checker fail BY NAME.
- **Colour is never the only carrier.** The band card on the sessions tab has no pill; its only non-hue carrier is the status WORD, and `sessions-geom-check.mjs` asserts the three words are distinct. The same applies here.
- Board 1 FQBN: `esp32:esp32:esp32:PartitionScheme=huge_app`
- Board 2 FQBN: `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app`
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Decisions already taken from the mockup round — do NOT re-open

§7 as written does not fit. Four defects were found by mocking it at true geometry; three are settled, and the settlement is binding.

| # | defect | measured | decision |
|---|---|---|---|
| 1 | the band cannot hold word + duration + wall-clock | word lane 144px against a 192px `NEEDS YOUR INPUT` — **collides by 48** | band carries **word + duration only** |
| 3 | the wall-clock does not fit the meta line either | `opus-5 · main · started 09:07` + Mac = 312px in a 268px lane — **over by 44** | meta line **drops `started`**: `opus-5 · main · 09:34` |
| 4 | §7 absorbs the `AGENT` column and never says where the **Mac** goes | it cannot go in the band — even the icon alone leaves the word **4px short** | **Mac icon + tag on the meta line**, 248px of 268 |
| — | the TYPE chip is oversized | 88×46, but the tap zone is `sx >= msgBtnX() - 24` over `DETAIL_HEAD_H` = **124×50 regardless** | chip **76×26**, centred; tap zone unchanged |

**Decision 4 is what decided decision 3.** Only the shortened meta line has room for the Mac, so "which computer?" is answerable in exactly one arrangement. Do not restore `started 09:07`.

**The 46px chip height bought no tappability**, because the hit test never read the chip's size. This is the same draw-small/hit-big split board 1's own chip (76×22 in a 100×28 zone) and the settings steppers (44px keys in 72×56 zones) already use.

---

## File Structure

| file | responsibility | change |
|---|---|---|
| `firmware/deckhand_display/board_es3c35p.h` | `DETAIL_CARD_H`, `MSG_BTN_W/H`, the meta-line constants | modify |
| `firmware/deckhand_display/board_e32r28t.h` | **untouched** — board 1 keeps its pill-and-columns detail screen | none |
| `firmware/deckhand_display/sessions.ino` | `drawDetailScreen`'s card: band head, body cursor, meta line | modify |
| `firmware/deckhand_display/settings-geom-check.mjs` | owns the detail screen's assertions today | modify |

**No new file.** The detail screen's draw already lives in `sessions.ino`, and `drawSessionBand()` is right there.

---

### Task 1: The TYPE chip, and the constants (smallest, independent, ships alone)

Deliberately first and deliberately separable: it is the one change a reviewer could take while rejecting the rest.

**Files:** Modify `board_es3c35p.h`, `settings-geom-check.mjs`

**Interfaces:** Produces `MSG_BTN_W = 76`, `MSG_BTN_H = 26` — consumed by `drawDetailScreen` and the header hit test, both unchanged.

- [ ] **Step 1: Change the chip's size**

In `board_es3c35p.h`, replace `const int MSG_BTN_W = 88, MSG_BTN_H = 46;` with:

```c
// 76x26, board 1's own proportions at board 2's scale. It WAS 88x46 because 46 is
// TAP_MIN - but the chip is not what gets tapped: handleDetailTouch tests
// `sx >= msgBtnX() - 24` over the whole DETAIL_HEAD_H, so the live zone is 124x50
// whatever is drawn, already 2.7x TAP_MIN in width. The 46 bought nothing and cost
// the header row all its air. Same draw-small/hit-big split board 1's chip
// (76x22 in a 100x28 zone) and the settings steppers (44px keys in 72x56) use.
const int MSG_BTN_W = 76, MSG_BTN_H = 26;
```

- [ ] **Step 2: Centre it in the row**

`msgBtnY()` returns `CONTENT_Y + 2`, which was right when the chip filled the row. Change it to centre: `CONTENT_Y + (DETAIL_HEAD_H - MSG_BTN_H) / 2`. Keep `msgBtnX()` as it is — the hit test is written against it and must not move.

- [ ] **Step 3: Assert the split the change depends on**

Add to `settings-geom-check.mjs`, board 2 only. Parse the hit test's own expression rather than restating 24:

```js
// The chip may shrink ONLY because the tap zone does not come from it. If a future
// change couples them, this is what says so.
if (b === 2) {
  const src = read("sessions.ino");
  const m = src.match(/sx\s*>=\s*msgBtnX\(\)\s*-\s*(\d+)/);
  ok("the TYPE chip's hit test is anchored on msgBtnX() with a slack term", !!m);
  const slack = m ? +m[1] : 0;
  const zoneW = c.MSG_BTN_W + slack;            // msgBtnX() = CARD_X + CARD_W - W, zone runs to the right edge
  ok(`the TYPE tap zone is at least TAP_MIN wide (${zoneW} >= ${c.TAP_MIN})`, zoneW >= c.TAP_MIN);
  ok(`the TYPE tap zone is at least TAP_MIN tall (${c.DETAIL_HEAD_H} >= ${c.TAP_MIN})`,
     c.DETAIL_HEAD_H >= c.TAP_MIN);
  ok("the drawn chip fits inside the header row with air",
     c.MSG_BTN_H < c.DETAIL_HEAD_H);
}
```

- [ ] **Step 4: Prove the tooth**

```bash
sed -i '' 's/MSG_BTN_W = 76, MSG_BTN_H = 26/MSG_BTN_W = 76, MSG_BTN_H = 60/' firmware/deckhand_display/board_es3c35p.h
node firmware/deckhand_display/settings-geom-check.mjs      # must FAIL by name on the air assertion
sed -i '' 's/MSG_BTN_W = 76, MSG_BTN_H = 60/MSG_BTN_W = 76, MSG_BTN_H = 26/' firmware/deckhand_display/board_es3c35p.h
```

Report the exact message. If it passes, the assertion is transcribing rather than reading the constant.

- [ ] **Step 5: Compile both, board 1 UNCHANGED, commit**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

```bash
git commit -m "The TYPE chip was sized for a tap zone it never provided

88x46 because 46 is TAP_MIN - but handleDetailTouch tests sx >= msgBtnX()
- 24 over the whole DETAIL_HEAD_H, so the zone is 124x50 whatever is
drawn. The height bought no tappability and cost the header row its air.
Now 76x26, board 1's proportions at board 2's scale, centred.

The checker asserts the split by PARSING the hit test's own slack term,
so coupling them again fails by name.

Board 1 unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The band heads the detail card

**Files:** Modify `sessions.ino`, `board_es3c35p.h`, `settings-geom-check.mjs`

**Interfaces:** Consumes `drawSessionBand(x, y, w, i, col)` — **takes an INDEX, not a `SessionInfo&`** (Arduino hoists auto-prototypes above `struct SessionInfo`); `SESSION_BAND_H` (44) and the `SESSION_BAND_*` block constants.

- [ ] **Step 1: Grow the card and head it with the band**

`DETAIL_CARD_H` goes 326 → **350** (§7: "the card grows into the trailing area"). Derive the new value against the hint rather than typing 350: the hint is centred at `contentBottom() - 10`, so the card may reach that line's top. Put the derivation in the header comment the way `SESSION_EXP_MAX_H`'s is.

Then in `drawDetailScreen`, call `drawSessionBand()` at the card's top and start the body cursor at `cardY + SESSION_BAND_H`. **Remove the status pill and the `for 12m - 14:31` duration line** — the band carries both.

**The band carries word + duration ONLY.** Not the wall-clock: `4m · 09:34` is 80px, leaving the word 144 against a 192px `NEEDS YOUR INPUT`. That is decision 1 and it is settled.

- [ ] **Step 2: Assert the band's contents fit across, on THIS surface too**

`sessions-geom-check.mjs` already asserts this for the sessions tab. The detail card is the same width, so the same arithmetic holds — but assert it here rather than assuming, because this is where §7 tried to add a third field:

```js
// The band's word lane on the DETAIL card. Identical width to the sessions tab's,
// which is the point: adding the wall-clock here is what §7 asked for and what
// collides by 48. Asserted so a future edit cannot quietly re-add it.
const inner = c.CARD_W - 2 * c.BORDER_CARD;
const lane = inner - c.SESSION_BAND_PAD - sparkSize() - c.SESSION_BAND_MARK_GAP
             - c.SESSION_BAND_PAD - c.SESSION_BAND_DUR_CHARS * c.TEXT_ADV;
const longest = "NEEDS YOUR INPUT".length * advanceB(2, T_HEAD);
ok(`the detail band's word lane (${lane}px) holds the longest status word (${longest}px)`,
   lane >= longest);
```

- [ ] **Step 3: Compile, flash, and LOOK — all three states**

```bash
./flash.sh --board 2
echo "TAB 1" > ~/.claude/deckhand-device-command   # then tap into a session, or use KBTEST's path
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```

Capture a **READY**, a **WORKING** and an **asking** detail screen. Confirm the band reads correctly in each and the pill is gone. **Board-2 caveat: `SCREENSHOT` reads the shadow framebuffer, so it proves the renderer self-consistent, not the panel's colours.**

- [ ] **Step 4: Board 1 UNCHANGED, then commit**

---

### Task 3: The meta line, and the Mac

This is the task the mockup round exists for. It is separated from Task 2 because the band is defensible on its own, and this is the part that drops a field.

**Files:** Modify `sessions.ino`, `board_es3c35p.h`, `settings-geom-check.mjs`

- [ ] **Step 1: Replace the column pairs with one meta line**

Delete the `MODEL`/`GIT BRANCH` and `STARTED`/`AGENT` label/value column pairs. Draw instead a single dim line at `T_META`:

```
opus-5 · main · 09:34   [Mac icon]  pro
```

- `09:34` is the **status-since wall-clock**, i.e. what the pill's `for 12m - 14:31` used to carry beside it.
- **`started` is dropped.** That is decision 3, and it is what buys room for the Mac. Do not restore it.
- The Mac icon is **UNGATED** — it shows whenever one is set, because it is personalisation, exactly as every other icon site does. The **text tag** stays gated on `dispMacTag()` being non-empty, i.e. on a second Mac actually being connected. That asymmetry is pre-existing; preserve it.
- Separator is a middle dot **only if it renders** — Spleen declares `0x20..0x7E`, so **U+00B7 draws as a blank box**. Use the ASCII forms the rest of the UI uses. This trap has bitten this repo three times (the Mac tag's `/`, `fitText`'s three dots, and my own mockup).

- [ ] **Step 2: Assert the line fits WITH the Mac**

```js
// FINDING 4: this line is the only place the Mac can live, and it fits only because
// `started` was dropped. Assert the whole cluster, not just the text.
const lane = c.CARD_W - 2 * c.DETAIL_PAD;
const meta = "opus-5 · main · 09:34".length * c.TEXT_ADV;
const mac  = 4 + macEmojiSize() + 4 + c.MAC_TAG_MAX * c.TEXT_ADV;
ok(`the meta line plus the Mac (${meta + mac}px) fits its lane (${lane}px)`, meta + mac <= lane);
// and that restoring `started` would NOT fit - the assertion that keeps the decision
ok("restoring `started` would overflow, which is why it was dropped",
   "opus-5 · main · started 09:07".length * c.TEXT_ADV + mac > lane);
```

The second assertion is the unusual one and it is deliberate: it encodes *why* the field is absent, so a future reader who re-adds it fails immediately rather than shipping a clipped line.

- [ ] **Step 3: Re-derive `detailSigCache`**

§7: *"`detailSigCache` (384, against a derived 358 worst case) must be re-derived if any field is added; removing fields only loosens it."* This task **removes** fields (the columns) and **adds** one (the Mac on the meta line). Re-derive field by field — do not assume 384 still fits — and assert the derived worst case against the constant the way `sessions-geom-check.mjs` does for `rowSigCache`. A signature cache shorter than what it stores silently stops noticing changes.

- [ ] **Step 4: Flash and verify with TWO Macs**

The Mac tag only appears with a second Mac connected, so a single-Mac capture cannot show it. Use `MULTITEST 2` to inject a synthetic second Mac, then capture. Confirm: icon present, tag present, nothing clipped at the right edge.

- [ ] **Step 5: Board 1 UNCHANGED, then commit**

---

### Task 4: Verification and the sweep

- [ ] **Step 1: Every checker, plus the sweep**

```bash
for c in sessions-geom-check usage-geom-check settings-geom-check palette-check sessions-rank-check textwidth-check; do
  node firmware/deckhand_display/$c.mjs || echo "FAILED: $c"; done
node firmware/deckhand_display/settings-geom-check.mjs --selftest
node firmware/deckhand_display/geom-sweep.mjs
python3 firmware/deckhand_display/batt-trend-check.py
```

**Every constant this plan ADDED that the sweep reports UNGUARDED is a gap, not noise.** Do not curve-fit a bound to make one green — piece 3 refused that for `SESSION_SHIMMER_MAX` and was right; the honest close came later from a perceptual bound.

- [ ] **Step 2: Final board-1 check**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1   # UNCHANGED
```

- [ ] **Step 3: Update CLAUDE.md and the spec**

Record what shipped, and **record §7's four defects as found-and-resolved rather than deleting them** — a spec that reads as though it were right all along teaches nothing. Note in §7 that the mockup round found them.

- [ ] **Step 4: Commit**

---

## Self-Review

**Spec coverage (§7).** Band heads the card → Task 2. Body cursor and the single meta line → Task 3. Card 326 → 350 → Task 2 Step 1. `detailSigCache` re-derivation → Task 3 Step 3. The pill, duration line and AGENT column removed → Tasks 2 and 3. **Deviations from §7, all deliberate and measured:** the band does NOT carry the wall-clock (collides by 48), the meta line drops `started` (needed for the Mac), and the Mac moves to the meta line (§7 never said where it goes). The TYPE chip is not in §7 at all — it is an improvement found while mocking, and Task 1 is separable for that reason.

**Placeholder scan.** None. Every value is measured or derived; the one number left to the implementer (`DETAIL_CARD_H`) has its derivation stated rather than a literal.

**Type consistency.** `drawSessionBand(x, y, w, i, col)` takes an index, matching piece 3's shipped signature — the plan says so explicitly because the obvious reading is a reference. `SESSION_BAND_*` names match `board_es3c35p.h`. `msgBtnX()`/`msgBtnY()` keep their names; only the latter's body changes.

**One weakness, stated rather than hidden.** Tasks 2–3 are verified by `SCREENSHOT`, which on board 2 reads the shadow framebuffer — so it proves the renderer self-consistent, not the panel correct. The band's *colours* are the one thing a capture cannot vouch for; if they look wrong on the glass, reach for `COLORTEST`/`SWAP`/`INV` before believing the capture. And **board 2 was unplugged when this plan was written**, so every number here comes from the header rather than from the device.
