# Session Ranking — Longest-Waiting Asking First — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank `asking` sessions by how long they have been asking, not by which started most recently, so the top slot goes to the prompt that has been blocked longest.

**Architecture:** `reorderSessions()` keeps its stable insertion sort; the comparison moves into a pure `sessionSortsBefore(b, a, now)` that takes the clock as an argument. Only the rank-0 (`asking`) tie-break changes — `waiting` and `working` keep recency. A new checker, `sessions-rank-check.mjs`, parses `urgencyRank`'s mapping out of the source and exercises the ordering off-device.

**Tech Stack:** Arduino C++ (ESP32 / ESP32-S3), Node ESM checkers, `arduino-cli`.

**Spec:** [`docs/superpowers/specs/2026-08-28-sessions-redesign-board2-design.md`](../specs/2026-08-28-sessions-redesign-board2-design.md) — this plan implements **§8 only** (piece 1 of 4).

## Global Constraints

- **This is SHARED code and it moves board 1's binary on purpose.** Every other piece of the sessions redesign is board-2-only; this one is not. Re-baseline with `node firmware/board-baseline.mjs <bin> --update 1` and state in the commit message *why* the binary was expected to move.
- **Never compile both boards concurrently.** `arduino-cli` derives its build directory from the sketch path, so two FQBNs share one cache and overwrite each other's objects. Compile one after the other.
- **A checker must PARSE the constant it certifies, never TRANSCRIBE it.** A literal on the checker's side is what let `PILL_H` drift once already.
- **The test of a new assertion is not "does it pass" but "does reverting the change make it fail, and by name".**
- **Compare elapsed, never raw timestamps.** `millis()` wraps at ~49.7 days.
- Board 1 FQBN: `esp32:esp32:esp32:PartitionScheme=huge_app`
- Board 2 FQBN: `esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app`
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| file | responsibility | change |
|---|---|---|
| `firmware/deckhand_display/deckhand_display.ino` | `urgencyRank()`, `sessionSortsBefore()`, `reorderSessions()` at ~3186-3206 | modify |
| `firmware/deckhand_display/sessions-rank-check.mjs` | parses the rank mapping, mirrors the comparator, runs ordering scenarios, `--selftest` | create |

**What the checker can and cannot prove, stated up front so nobody over-trusts it:** it runs a JavaScript *mirror* of the comparator, so it proves the **algorithm** — including the wrap case, which is otherwise unreachable without waiting 49 days. It does not execute the C++. Two things close that gap: the rank mapping is parsed from the source rather than transcribed, and Task 5 verifies the real firmware on the glass with `MULTITEST`.

---

### Task 1: The checker, asserting the new ordering (fails against today's code)

**Files:**
- Create: `firmware/deckhand_display/sessions-rank-check.mjs`

**Interfaces:**
- Consumes: `firmware/deckhand_display/deckhand_display.ino` (parsed as text)
- Produces: `node firmware/deckhand_display/sessions-rank-check.mjs` — exit 0 on pass, 1 on failure; `--selftest` added in Task 4.

- [ ] **Step 1: Write the failing checker**

Create `firmware/deckhand_display/sessions-rank-check.mjs`:

```js
#!/usr/bin/env node
// Exercises reorderSessions()'s ordering without a device. Run with no arguments to
// check the shipped comparator; --selftest (see below) proves the checks can fail.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. This runs a JS MIRROR of the comparator,
// so it proves the ALGORITHM - including the millis() wrap case, which is otherwise
// unreachable without waiting 49.7 days for real. It does not execute the C++. Two
// things narrow that gap: urgencyRank's mapping is PARSED out of the sketch rather
// than transcribed here, so a rank that changes in the firmware changes here too;
// and the structural assertions below read the real source text.
import fs from "fs";
import path from "path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const SRC = fs.readFileSync(`${DIR}/deckhand_display.ino`, "utf8");

// ---------- parse, never transcribe ----------
// urgencyRank is the one piece of the key that is a table rather than arithmetic, so
// it is read out of the sketch. A rank renamed or renumbered in the firmware must
// change this checker's expectations with it, not silently disagree.
function parseUrgencyRank(src) {
  const at = src.indexOf("int urgencyRank(");
  if (at < 0) throw new Error("urgencyRank() not found - has it been renamed?");
  const body = src.slice(at, src.indexOf("\n}", at));
  const named = {};
  let stripped = body;
  for (const m of body.matchAll(/strcmp\(status,\s*"(\w+)"\)\s*==\s*0\)\s*return\s+(\d+)/g)) {
    named[m[1]] = Number(m[2]);
    stripped = stripped.replace(m[0], "");
  }
  const d = stripped.match(/return\s+(\d+)\s*;/);
  if (!d) throw new Error("urgencyRank() has no default return");
  if (Object.keys(named).length === 0) throw new Error("urgencyRank() parsed no named statuses");
  return { named, dflt: Number(d[1]) };
}
const RANKS = parseUrgencyRank(SRC);
const rankOf = (status) => (status in RANKS.named ? RANKS.named[status] : RANKS.dflt);

// ---------- the mirror ----------
const U32 = 0x100000000;
// Unsigned-wrap-safe elapsed, exactly what (now - since) does in C with unsigned long.
const elapsed = (now, since) => ((now - since) % U32 + U32) % U32;

// legacy=true reproduces the comparator this change replaces, for --selftest.
function sortsBefore(b, a, now, legacy) {
  const ra = rankOf(a.status), rb = rankOf(b.status);
  if (rb !== ra) return rb < ra;
  if (!legacy && ra === 0) return elapsed(now, b.since) > elapsed(now, a.since);
  return b.actSec > a.actSec;
}

// Mirrors reorderSessions()'s stable insertion sort, break and all.
function order(sessions, now, legacy = false) {
  const ord = sessions.map((_, i) => i);
  for (let i = 1; i < sessions.length; i++) {
    for (let j = i; j > 0; j--) {
      if (!sortsBefore(sessions[ord[j]], sessions[ord[j - 1]], now, legacy)) break;
      const t = ord[j - 1]; ord[j - 1] = ord[j]; ord[j] = t;
    }
  }
  return ord.map((i) => sessions[i].name);
}

// ---------- scenarios ----------
const S = (name, status, { since = 0, actSec = 0 } = {}) => ({ name, status, since, actSec });
let fails = [], count = 0;
function eq(label, got, want) {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fails.push(`${label}\n         got  ${g}\n         want ${w}`);
}

// The mapping itself, as parsed.
count++;
if (!(rankOf("asking") < rankOf("waiting") && rankOf("waiting") < rankOf("working")))
  fails.push(`urgencyRank must order asking < waiting < working (parsed ${JSON.stringify(RANKS)})`);

const NOW = 1_000_000;
// THE CHANGE. Two asking rows: the one waiting LONGEST leads.
eq("two asking: the longer wait leads",
   order([S("fresh", "asking", { since: NOW - 5_000 }), S("stale", "asking", { since: NOW - 1_200_000 })], NOW),
   ["stale", "fresh"]);
eq("two asking: order of arrival does not decide it",
   order([S("stale", "asking", { since: NOW - 1_200_000 }), S("fresh", "asking", { since: NOW - 5_000 })], NOW),
   ["stale", "fresh"]);

// Rank still dominates the tie-break.
eq("asking outranks waiting outranks working, whatever the times",
   order([S("w", "working", { actSec: 86_000 }), S("r", "waiting", { actSec: 86_000 }),
          S("a", "asking", { since: NOW - 1_000 })], NOW),
   ["a", "r", "w"]);

// Unchanged behaviour for the other two ranks.
eq("two waiting: most RECENT leads (unchanged)",
   order([S("old", "waiting", { actSec: 100 }), S("new", "waiting", { actSec: 900 })], NOW),
   ["new", "old"]);
eq("two working: most RECENT leads (unchanged)",
   order([S("old", "working", { actSec: 100 }), S("new", "working", { actSec: 900 })], NOW),
   ["new", "old"]);
eq("actSec -1 (not today) sorts LAST within its rank",
   order([S("yesterday", "waiting", { actSec: -1 }), S("today", "waiting", { actSec: 5 })], NOW),
   ["today", "yesterday"]);

// The wrap. Unreachable on hardware without a 49.7-day uptime.
const NEAR = U32 - 10_000;          // 10s before millis() wraps
eq("millis() wrap: a wait that spans the wrap still reads as the longer one",
   order([S("after", "asking", { since: (NEAR + 9_000) % U32 }),   // waited ~6s
          S("across", "asking", { since: NEAR - 600_000 })], 5_000),  // waited ~10m
   ["across", "after"]);

// Stability: equal keys keep arrival order, which is the host's own urgency sort.
eq("equal keys keep arrival order (stable sort)",
   order([S("first", "working", { actSec: 500 }), S("second", "working", { actSec: 500 })], NOW),
   ["first", "second"]);

// ---------- structural assertions on the real source ----------
// Text-matched deliberately, and safe to match here: unlike the panel_shim case this
// repo documents, none of these lines sits behind an #if, so nothing can delete the
// line the regex just found.
function structural(label, ok) { count++; if (!ok) fails.push(label); }
structural("sessionSortsBefore() exists and takes `now` as an argument (no clock inside)",
  /bool\s+sessionSortsBefore\s*\(\s*const\s+SessionInfo&\s*\w+\s*,\s*const\s+SessionInfo&\s*\w+\s*,\s*unsigned\s+long\s+now\s*\)/.test(SRC));
structural("reorderSessions() samples millis() exactly ONCE (a clock that advances mid-sort makes the comparator inconsistent)",
  (SRC.slice(SRC.indexOf("void reorderSessions("),
             SRC.indexOf("\n}", SRC.indexOf("void reorderSessions("))).match(/millis\(\)/g) || []).length === 1);
structural("the asking tie-break compares ELAPSED, not raw stamps (millis() wraps at ~49.7 days)",
  /now\s*-\s*\w+\.statusSinceMillis\s*\)\s*>\s*\(\s*now\s*-\s*\w+\.statusSinceMillis/.test(SRC));

// ---------- report ----------
if (fails.length) {
  console.error("");
  for (const f of fails) console.error("  FAIL " + f);
  console.error(`\n${fails.length} of ${count} assertions FAILED`);
  process.exit(1);
}
console.log(`all ${count} session-ranking assertions pass`);
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
node firmware/deckhand_display/sessions-rank-check.mjs
```

Expected: **exit 1**, with at least these failures — the two `two asking` cases, the wrap case, and all three structural assertions (`sessionSortsBefore` does not exist yet). The `waiting`/`working`/`-1`/stability cases must **pass** already; if any of those fails, the mirror disagrees with today's code and the mirror is wrong — stop and fix it before going on.

- [ ] **Step 3: Commit the failing checker**

```bash
git add firmware/deckhand_display/sessions-rank-check.mjs
git commit -m "Add a session-ranking checker, currently failing

Asserts what the ranking SHOULD do: an asking row that has waited longer
outranks one that just started. Fails against today's comparator, which
ranks every tie by recency.

Carries the millis() wrap case, which cannot be reached on hardware
without a 49.7-day uptime.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Extract the comparator, behaviour unchanged

Separated from the behaviour change on purpose: it lets the board-1 baseline delta caused by *restructuring* be seen apart from the delta caused by the new *rule*. If a reviewer rejects the extraction they can still take Task 3, and vice versa.

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino:3195-3206`

**Interfaces:**
- Produces: `bool sessionSortsBefore(const SessionInfo& b, const SessionInfo& a, unsigned long now)` — true when `b` sorts before `a`. Consumed by `reorderSessions()` and asserted by Task 1's structural checks.

- [ ] **Step 1: Replace `reorderSessions()` with the extracted form**

Find this in `firmware/deckhand_display/deckhand_display.ino`:

```c
void reorderSessions() {
  for (int i = 0; i < sessionCount; i++) sessionOrder[i] = i;
  for (int i = 1; i < sessionCount; i++) {
    for (int j = i; j > 0; j--) {
      const SessionInfo& a = sessions[sessionOrder[j - 1]];
      const SessionInfo& b = sessions[sessionOrder[j]];
      int ra = urgencyRank(a.status), rb = urgencyRank(b.status);
      bool swap = (rb < ra) || (rb == ra && b.actSec > a.actSec);
      if (!swap) break;
      uint8_t t = sessionOrder[j - 1]; sessionOrder[j - 1] = sessionOrder[j]; sessionOrder[j] = t;
    }
  }
}
```

Replace it with:

```c
// Does b sort BEFORE a? Pure by construction - no globals, and the clock arrives as
// an argument rather than being read inside. Two reasons, both load-bearing: one
// sort must see ONE instant (a clock advancing between comparisons makes the
// comparator inconsistent with itself), and a comparator with no clock in it can be
// exercised off-device, which is the only way the millis() wrap case is ever tested.
// Same reason run-ledger.mjs and capUtf8 are their own units.
bool sessionSortsBefore(const SessionInfo& b, const SessionInfo& a, unsigned long now) {
  (void) now;  // used by the asking tie-break, added next
  int ra = urgencyRank(a.status), rb = urgencyRank(b.status);
  if (rb != ra) return rb < ra;
  return b.actSec > a.actSec;
}
void reorderSessions() {
  const unsigned long now = millis();  // ONCE per sort, never per comparison
  for (int i = 0; i < sessionCount; i++) sessionOrder[i] = i;
  for (int i = 1; i < sessionCount; i++) {
    for (int j = i; j > 0; j--) {
      if (!sessionSortsBefore(sessions[sessionOrder[j]], sessions[sessionOrder[j - 1]], now)) break;
      uint8_t t = sessionOrder[j - 1]; sessionOrder[j - 1] = sessionOrder[j]; sessionOrder[j] = t;
    }
  }
}
```

- [ ] **Step 2: Compile board 2 and confirm it builds**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2 firmware/deckhand_display
```

Expected: compiles clean.

- [ ] **Step 3: Compile board 1 and record the refactor's cost**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: `CHANGED`. **Write the reported byte delta into the commit message.** If it reports `+0 bytes` that is still a real change — the baseline compares bytes, not sizes, which is exactly why it replaced a size check.

- [ ] **Step 4: Run the checker — the same failures, no more**

```bash
node firmware/deckhand_display/sessions-rank-check.mjs
```

Expected: still exit 1, but **two of the three structural assertions now pass** (`sessionSortsBefore` exists; `millis()` sampled once). The two `two asking` cases, the wrap case and the ELAPSED structural assertion still fail. Any *new* failure among the `waiting`/`working`/stability cases means the extraction changed behaviour — revert and redo.

- [ ] **Step 5: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "Extract sessionSortsBefore() - no behaviour change

Pure comparator taking the clock as an argument, so one sort sees one
instant and the ordering can be exercised off-device. reorderSessions()
now samples millis() once instead of not at all.

Board 1's binary moves by <N> bytes for the restructuring alone; the
behaviour change is the next commit, so the two deltas stay separable.
Re-baselined at the end of this branch, not here.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rank asking by how long it has waited

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` (`sessionSortsBefore` from Task 2)

**Interfaces:**
- Consumes: `sessionSortsBefore(b, a, now)` from Task 2; `SessionInfo::statusSinceMillis` (already exists, `deckhand_display.ino:896`, carried across polls by `(hostSlot, id)` match at `:3519`).

- [ ] **Step 1: Change the rank-0 tie-break**

In `sessionSortsBefore`, replace:

```c
  (void) now;  // used by the asking tie-break, added next
  int ra = urgencyRank(a.status), rb = urgencyRank(b.status);
  if (rb != ra) return rb < ra;
  return b.actSec > a.actSec;
```

with:

```c
  int ra = urgencyRank(a.status), rb = urgencyRank(b.status);
  if (rb != ra) return rb < ra;
  // ASKING ranks by how LONG it has waited, not by which arrived last. A prompt
  // unanswered for 20 minutes must outrank one that started 5 seconds ago, or the
  // most prominent row on the device is given to the least urgent thing in it.
  // Only rank 0 changes: for a WORKING row "most recent" means alive, and the
  // oldest is the stale one, so recency stays right for the other two.
  //
  // ELAPSED, not the raw stamp. millis() wraps at ~49.7 days, and (now - since) is
  // wrap-safe under unsigned arithmetic where (a.since > b.since) silently inverts
  // across the wrap. The same idiom formatDuration() already uses.
  if (ra == 0) return (now - b.statusSinceMillis) > (now - a.statusSinceMillis);
  return b.actSec > a.actSec;
```

- [ ] **Step 2: Run the checker — everything passes**

```bash
node firmware/deckhand_display/sessions-rank-check.mjs
```

Expected: `all N session-ranking assertions pass`, exit 0.

- [ ] **Step 3: Compile both boards, one after the other**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" \
  --output-dir /tmp/b2 firmware/deckhand_display
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: both compile; board 1 reports `CHANGED`. Record the delta.

- [ ] **Step 4: Commit**

```bash
git add firmware/deckhand_display/deckhand_display.ino
git commit -m "Rank asking sessions by how long they have waited

A prompt unanswered for 20 minutes used to lose the top row to one that
started asking 5 seconds ago, because every tie ranked by recency. Only
rank 0 changes; waiting and working keep recency, where 'most recent'
correctly means alive.

Compares elapsed rather than raw stamps: millis() wraps at ~49.7 days and
a raw comparison inverts across the wrap. sessions-rank-check.mjs covers
that case, which needs a 49.7-day uptime to reach on hardware.

Known limitation: statusSinceMillis is device-side, so a reboot or a
dropped-and-returned link resets it and a long-waiting prompt reads as
new. That is the existing limitation of the 'for 12m' field, and the sort
agreeing with the number on the row is worth more than absolute truth.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `--selftest`, so the checker has provable teeth

**Files:**
- Modify: `firmware/deckhand_display/sessions-rank-check.mjs`

- [ ] **Step 1: Add the selftest ahead of the report block**

Insert immediately before the `// ---------- report ----------` line:

```js
// ---------- selftest ----------
// The same teeth-proving convention as palette-check.mjs --selftest: re-run the
// ordering scenarios against the comparator this change REPLACED, and exit 0 only
// when the longest-waiting cases FAIL against it. A checker that passes against
// both the old and the new rule is not testing the rule.
if (process.argv.includes("--selftest")) {
  const legacyCases = [
    ["two asking: the longer wait leads",
      () => order([S("fresh", "asking", { since: NOW - 5_000 }),
                   S("stale", "asking", { since: NOW - 1_200_000 })], NOW, true),
      ["stale", "fresh"]],
    ["two asking: order of arrival does not decide it",
      () => order([S("stale", "asking", { since: NOW - 1_200_000 }),
                   S("fresh", "asking", { since: NOW - 5_000 })], NOW, true),
      ["stale", "fresh"]],
    ["millis() wrap: a wait that spans the wrap still reads as the longer one",
      () => order([S("after", "asking", { since: (NEAR + 9_000) % U32 }),
                   S("across", "asking", { since: NEAR - 600_000 })], 5_000, true),
      ["across", "after"]],
  ];
  const blind = legacyCases.filter(([, run, want]) =>
    JSON.stringify(run()) === JSON.stringify(want));
  if (blind.length) {
    console.error("");
    for (const [label] of blind)
      console.error("  SELFTEST FAILED: this case passes against the OLD comparator too - " + label);
    console.error(`\n${blind.length} of ${legacyCases.length} cases cannot tell the two rules apart.`);
    process.exit(1);
  }
  console.log(`selftest ok - all ${legacyCases.length} cases reject the old recency-ranked comparator`);
  process.exit(0);
}
```

- [ ] **Step 2: Run the selftest**

```bash
node firmware/deckhand_display/sessions-rank-check.mjs --selftest
```

Expected: `selftest ok - all 3 cases reject the old recency-ranked comparator`, exit 0.

- [ ] **Step 3: Prove the selftest itself has teeth**

Temporarily change the first legacy case's `true` argument to `false` (making it run the *new* comparator, which should pass and therefore be reported as blind):

```bash
# after the edit
node firmware/deckhand_display/sessions-rank-check.mjs --selftest
```

Expected: **exit 1**, reporting `this case passes against the OLD comparator too`. Then revert the edit and re-run — back to exit 0.

- [ ] **Step 4: Confirm the normal run still passes**

```bash
node firmware/deckhand_display/sessions-rank-check.mjs
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add firmware/deckhand_display/sessions-rank-check.mjs
git commit -m "sessions-rank-check: --selftest proves the checker has teeth

Re-runs the longest-waiting cases against the recency comparator this
change replaced, and exits 0 only when every one of them FAILS. Same
convention as palette-check.mjs --selftest: a checker that passes against
both the old and the new rule is not testing the rule.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Verify on the glass, then re-baseline board 1

**Files:**
- Modify: `firmware/board-baseline.json` (written by `--update 1`)

- [ ] **Step 1: Flash board 2**

```bash
./flash.sh --board 2
```

Expected: the host is stopped, the upload succeeds, the host is restored. If the board is mute, power-cycle it before suspecting the firmware.

- [ ] **Step 2: Exercise the ranking with the synthetic-Mac harness**

`MULTITEST` injects a second Mac's sessions, which is how a mixed list is reachable from one Mac.

```bash
echo "TAB 1" > ~/.claude/deckhand-device-command
echo "MULTITEST 2" > ~/.claude/deckhand-device-command
```

Then capture what is on the glass (USB only — the base64 rows go out over `Serial.printf`):

```bash
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
ls -t ~/Deckhand-shots/ | head -1
```

Expected: the asking row is at the top of the list. **This does not yet prove the new rule** — it proves rank still dominates. The rule needs two asking rows, which the next step arranges.

- [ ] **Step 3: Verify the actual change with two real prompts**

Create two sessions that both go to `asking`, several minutes apart — the simplest way is two terminals each running a command that needs permission, started ~5 minutes apart. Then:

```bash
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```

Expected: **the session that has been asking longest is the top row**, and its `for Nm` duration is the larger of the two. Before this change it would have been the newer one.

If two real prompts are impractical, record that this step was not run rather than claiming it was — the checker covers the arithmetic, and this is the only step that covers the firmware.

- [ ] **Step 4: Re-baseline board 1**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" \
  --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --update 1
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: `--update` writes the new baseline; the following `--check 1` reports unchanged.

- [ ] **Step 5: Re-run the selftest that guards the mask**

An `arduino-cli` or core upgrade is not involved here, but the mask must still cover what the toolchain varies after a real source change. Compile twice into different directories so the builds are genuinely independent:

```bash
rm -rf /tmp/b1a /tmp/b1b
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1a firmware/deckhand_display
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1b firmware/deckhand_display
node firmware/board-baseline.mjs --selftest /tmp/b1a/deckhand_display.ino.bin /tmp/b1b/deckhand_display.ino.bin 1
```

Expected: raw hashes differ, masked hashes agree. If it reports uncovered runs, the build stamp moved — fix the mask before trusting any `--check`.

- [ ] **Step 6: Commit the new baseline**

```bash
git add firmware/board-baseline.json
git commit -m "Re-baseline board 1: the session ranking changed on purpose

reorderSessions() now ranks asking rows by how long they have waited
rather than by recency, and the comparator moved into a pure
sessionSortsBefore(). Both are shared code, so board 1's binary moves -
expected, not a surprise, which is the whole point of the baseline.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§8):** the new key → Task 3; elapsed-not-raw → Task 3 Step 1 plus a structural assertion in Task 1; `now` sampled once → Task 2 plus a structural assertion; pure `sessionSortsBefore` taking `now` → Task 2; the known `statusSinceMillis` limitation → recorded in Task 3's commit message; board-1 re-baseline with a stated reason → Task 5. No §8 requirement is unimplemented.

**Placeholder scan:** one intentional `<N>` remains, in Task 2 Step 5's commit message, because the byte delta cannot be known until Step 3 runs and Step 3 says to record it.

**Type consistency:** `sessionSortsBefore(const SessionInfo& b, const SessionInfo& a, unsigned long now)` is defined once in Task 2 and used unchanged in Task 3 and in Task 1's structural regex. `order(sessions, now, legacy)`, `sortsBefore`, `S()` and `elapsed()` are defined in Task 1 and reused in Task 4 without renaming. `statusSinceMillis` matches the field at `deckhand_display.ino:896`.

**One weakness, stated rather than hidden:** Task 1's mirror could drift from the C++ — nothing executes both. The rank mapping is parsed to narrow that, the structural assertions read the real source, and Task 5 Step 3 is the only step that exercises the shipped firmware. If Step 3 is skipped, say so; do not report the change as verified on hardware.
