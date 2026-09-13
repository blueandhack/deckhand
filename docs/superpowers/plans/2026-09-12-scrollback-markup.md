# Scrollback Markup (Option B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make code, lists and links readable in board 2's scrolling transcript, by stopping the Mac from discarding markup it already has and teaching the renderer the shape it is already almost carrying.

**Architecture:** Two phases. The host phase changes `histBlockText` only and cannot move either binary. The firmware phase threads one out-param through `scrollWalk`, then adds six treatments, every one of which lands in **both** `scrollDrawBody` and `scrollDrawBand`. A structural assertion that the two draw loops are textually identical is installed **before** any draw change, so it guards every task after it.

**Tech Stack:** Node (host, `host/index.mjs`), Arduino C++ (`firmware/deckhand_display/scrollback.ino`, `board_es3c35p.h`), the repo's offline checkers (`scrollback-check.mjs`, `geom-sweep.mjs`, `board-baseline.mjs`).

**Spec:** [`docs/superpowers/specs/2026-09-12-scrollback-markup-design.md`](../specs/2026-09-12-scrollback-markup-design.md)

## Global Constraints

- **THE FONTS ARE ASCII `0x20..0x7E` AND NOTHING ELSE.** An out-of-range codepoint draws nothing AND advances nothing. Three ASCII dots, never U+2026.
- **BOARD 1 MUST BE `UNCHANGED` AT EVERY COMMIT.** Everything here is inside `#if BOARD_HISTORY_SCROLL` (which wraps `scrollback.ino` lines 5-1039 whole) or in a host arm board 1 does not call. Verify, do not reason: `node firmware/board-baseline.mjs --check 1`.
- **NEVER COMPILE BOTH BOARDS CONCURRENTLY.** One cache is keyed on the sketch path. Compile one, check it, then the other.
- **A compile takes ~3 minutes.** Budget for it; it is not a hang.
- **EVERY CHANGE LANDS IN BOTH DRAW PATHS.** `scrollDrawBody` and `scrollDrawBand` must stay pixel-for-pixel equal.
- **A checker must PARSE the constant it certifies, never TRANSCRIBE it.** Use `consts("board_es3c35p.h")` from `geom-common.mjs`.
- **AN ASSERTION THAT CANNOT FAIL IS A DEFECT.** Every new assertion gets a `--selftest` fault, and the selftest must exit 0 only when the fault IS caught.
- **A RULE A NEIGHBOURING LINE CAN SATISFY IS NOT A RULE.** Bind assertions to a FUNCTION BODY, not to the file.
- **`#if` ON A C++ `const int` IS SILENTLY FALSE.** Board flags must be `#define`. (No new board flags here, but do not introduce one.)
- **How a `--selftest` fault is added.** Faults mutate the already-read source in the `if (SELFTEST)` blocks near the top of `scrollback-check.mjs` -- `INO = INO.replace(...)` for firmware, `HOSTSRC = HOSTSRC.replace(...)` for the host -- keyed on `process.env.SB_FAULT`. Then add an entry to the `WANT` table at the bottom mapping the fault name to a regex matching the assertion message that must fail. Run one as `SB_FAULT=<name> node firmware/deckhand_display/scrollback-check.mjs --selftest`; it exits 0 only when that fault IS caught.
- **`INO` and `HOSTSRC` ARE COMMENT-STRIPPED, and that is load-bearing.** Bind assertions to them, never to a fresh read -- a raw read lets a regex be satisfied by a comment describing the rule instead of the code obeying it.
- **Commit only what the task names, by path.** This working tree has had uncommitted work from other sessions in it. Never `git add -A`.
- **Deviation from the spec, recorded rather than left silent:** the spec says "two commits". This plan produces one commit per task. The property the spec protects -- no host change and firmware change in the same commit, so each baseline claim is one sentence -- is preserved.

## File Structure

| file | responsibility | tasks |
|---|---|---|
| `host/index.mjs` | `histBlockText`: markdown to the `block` string the wire carries | 1, 2, 3 |
| `firmware/deckhand_display/board_es3c35p.h` | every board-2 layout constant | 6, 10 |
| `firmware/deckhand_display/scrollback.ino` | `scrollWalk` (wrap + classify), `scrollDrawBody`, `scrollDrawBand` | 4-12 |
| `firmware/deckhand_display/scrollback-check.mjs` | the `walk()` mirror + structural assertions + `--selftest` | 1-12 |
| `docs/reference/scrollback.md` | the durable record | 13 |
| `docs/design/scrollback-markup/` | the committed mock, bound to the header | 13 |

---

## PHASE 1 - THE MAC STOPS DISCARDING IT

### Task 1: Keep the fence info string

**Files:**
- Modify: `host/index.mjs` (`histBlockText`, the fence line)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the `block` string may now carry a language on an OPENING fence. Closing fences stay bare. Task 12 reads this.

**Why this needs no version bump:** `scrollWalk`'s fence test reads only the first three backticks and ignores the rest, so a board running today's firmware drops the language rather than printing it.

- [ ] **Step 1: Write the failing assertion**

In `scrollback-check.mjs`, after the existing mirror block, add a host-side section. Read the host's own text and bind to the function body:

```js
// ---- the Mac's side: what histBlockText is allowed to discard ----
// HOSTSRC already exists in this file and is COMMENT-STRIPPED. Do not read
// host/index.mjs a second time: a raw read lets a regex be satisfied by a
// comment, which is this repo's "a rule a neighbouring line can satisfy" trap.
const hbt = /function histBlockText\([\s\S]*?\n}\n/.exec(HOSTSRC);
s(hbt != null, "structural: histBlockText is findable");
const hbtBody = hbt ? hbt[0] : "";
s(/out\.push\("```"\s*\+\s*\w+\)/.test(hbtBody),
  "structural: an OPENING fence keeps its info string - the device cannot label a block " +
  "with a language the Mac threw away");
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL, naming `an OPENING fence keeps its info string`.

- [ ] **Step 3: Implement**

In `host/index.mjs`, inside `histBlockText`, replace the single fence line (it currently tests `/^\s*```/`, flips `inFence`, and pushes a bare fence) with:

```js
    // THE INFO STRING SURVIVES THE OPENING FENCE. It was normalised away here, so
    // the device could not label a block with a language it never received. No
    // version bump: scrollWalk's fence test reads the first three backticks and
    // ignores the rest, so a board on older firmware drops the language rather
    // than printing it. The CLOSING fence stays bare - a language on it means
    // nothing and would only be a second thing to keep in step.
    const fence = /^\s*```(\S*)/.exec(t);
    if (fence) {
      const lang = inFence
        ? ""
        : toAscii(fence[1]).replace(/[^A-Za-z0-9+#_.-]/g, "").slice(0, 12);
      inFence = !inFence;
      out.push("```" + lang);
      continue;
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 5: Prove the assertion can fail**

Add the fault beside the others in the `if (SELFTEST)` host block, and a `WANT` entry for it:

```js
  if (hf === "no-lang")
    HOSTSRC = HOSTSRC.replace(/out\.push\("```" \+ lang\)/, 'out.push("```")');
```

```js
    "no-lang": /an OPENING fence keeps its info string/,
```

Run: `SB_FAULT=no-lang node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: exit 0, `selftest ok - caught by:` naming the info-string assertion.

- [ ] **Step 6: Commit**

```bash
git add host/index.mjs firmware/deckhand_display/scrollback-check.mjs
git commit -m "Keep the fence language the Mac was throwing away"
```

---

### Task 2: Restore inline spans with their backticks

**Files:**
- Modify: `host/index.mjs` (`histBlockText`, the span restore)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `hbtBody` from Task 1.
- Produces: an inline code span reaches the device with its backticks.

**The backtick is the only marker that carries meaning here without a bold face.** It is ASCII, inside Spleen's range, and one column each side.

- [ ] **Step 1: Write the failing assertion**

```js
s(/spans\[\+i\]\s*\+\s*"`"/.test(hbtBody) || /"`"\s*\+\s*spans\[\+i\]/.test(hbtBody),
  "structural: an inline code span is restored WITH its backticks - there is no bold " +
  "face on this board, so stripping them leaves nothing in their place");
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL, naming `an inline code span is restored WITH its backticks`.

- [ ] **Step 3: Implement**

In `host/index.mjs`, replace the span-restore line (it currently maps the sentinel back to `spans[+i]`) with:

```js
      // THE BACKTICKS COME BACK. They were dropped here, which left an inline span
      // indistinguishable from prose on a board that has no bold face to put in
      // their place. They are ASCII, inside Spleen's range, one column each side.
      t = t.replace(/(\d+)/g, (_, i) => "`" + spans[+i] + "`");
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS.

- [ ] **Step 5: Prove the assertion can fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: exit 0, fault CAUGHT.

- [ ] **Step 6: Commit**

```bash
git add host/index.mjs firmware/deckhand_display/scrollback-check.mjs
git commit -m "Give inline code its backticks back - nothing else marks it here"
```

---

### Task 3: Collapse links, elide long URLs

**Files:**
- Modify: `host/index.mjs` (`histBlockText`, inside the `if (!inFence)` arm)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `hbtBody`, `HOSTSRC`.
- Produces: `SCROLL_LINK_MARK`, `histShortUrl(u)`. Link markdown becomes its text plus the mark; a bare URL over 28 characters becomes `host/.../tail` plus the mark.

**THE MARK IS DOING WORK.** Collapsing a link otherwise destroys the fact that a target existed, silently -- and from the Mac, silence and "there was never a link here" are indistinguishable. It says "there was a URL here". It cannot be followed; that is Option D.

- [ ] **Step 1: Write the failing assertions**

```js
s(/SCROLL_LINK_MARK/.test(hbtBody),
  "structural: link markdown is collapsed inside histBlockText - [text](url) whole spends " +
  "two of 27 rows on brackets and a path");
s(/function histShortUrl\(/.test(HOSTSRC),
  "structural: a bare URL is shortened by its own named function - the device's word-wrap " +
  "gives up on a spaceless token and hard-cuts it mid-path");
const mark = /const SCROLL_LINK_MARK = "(.)"/.exec(HOSTSRC);
s(mark != null && mark[1].charCodeAt(0) >= 0x20 && mark[1].charCodeAt(0) <= 0x7e,
  "structural: the link mark is inside Spleen's 0x20..0x7E - an out-of-range mark draws " +
  "nothing AND advances nothing");
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL on all three, by name.

- [ ] **Step 3: Implement**

In `host/index.mjs`, above `histBlockText`:

```js
// A LINK THAT CANNOT BE FOLLOWED STILL HAS TO SAY IT EXISTED. Collapsing
// `[text](url)` to `text` destroys that fact silently, and from the Mac silence
// and "there was never a link here" are indistinguishable. One ASCII character,
// inside Spleen's range, is the whole cost. Tapping it is Option D.
const SCROLL_LINK_MARK = "~";
// A bare URL has no space in it, so the device's word-wrap gives up and hard-cuts
// it mid-token at column 34. Shortened here instead: the host and the tail are
// what identify it, and the middle never survived the lane anyway.
function histShortUrl(u) {
  const b = u.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (b.length <= 28) return b;
  const p = b.split("/");
  if (p.length < 3) return b.slice(0, 25) + "...";
  return p[0] + "/.../" + p[p.length - 1];
}
```

Then inside `histBlockText`, in the `if (!inFence)` arm, immediately **after** the span-protection replace and **before** the `**` stripping:

```js
      // AFTER the spans are protected, so a URL inside a code span is left exactly
      // as written, and BEFORE the emphasis strip, so an asterisk inside a URL is
      // not read as a marker.
      t = t.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, txt) => txt + SCROLL_LINK_MARK);
      t = t.replace(/https?:\/\/[^\s)\]]+/g, (u) => histShortUrl(u) + SCROLL_LINK_MARK);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS.

- [ ] **Step 5: Prove they can fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: exit 0, all three faults CAUGHT.

- [ ] **Step 6: Watch it on the wire**

The host is supervised and reloads on change. With a board cabled:

```bash
echo "SCROLLFETCH" > ~/.claude/deckhand-device-command
sleep 3
grep "Scrollback:" /tmp/deckhand-$(id -u)/host.log | tail -2
```

Expected: a fetch completes with `0 dropped`. `SCROLLFETCH` draws nothing, so silence here is a WIRE fault and can never be blamed on the renderer.

- [ ] **Step 7: Commit**

```bash
git add host/index.mjs firmware/deckhand_display/scrollback-check.mjs
git commit -m "Collapse link markdown and elide bare URLs, keeping the fact a target existed"
```

---

## PHASE 2 - THE RENDERER LEARNS SHAPE

### Task 4: Thread the indent out-param (no behaviour change)

**Files:**
- Modify: `firmware/deckhand_display/scrollback.ino:84` (`scrollWalk`), `:152` (`scrollWrapLines`), `:159` (`scrollLineAt`), and the three `scrollLineAt` call sites at `:583`, `:749`, `:862`
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `bool scrollLineAt(const char* t, int cols, int want, char* out, int outSize, uint8_t* flags, int* indent)` and `static int scrollWalk(const char* t, int cols, int want, char* out, int outSize, uint8_t* flags, int* indent, bool* found)`. `*indent` is the column the row's text starts at, relative to `SCROLL_TXT_X`. Tasks 6-12 all rely on these exact names.

**This task deliberately changes no pixels.** It is the scaffolding, landed alone so that the task which does change pixels has a one-line diff to argue about. `*indent` is written as `0` everywhere here.

**No default argument.** A default argument on a shared function once changed board 1's codegen with no size change at all. This function is board-2-only, but the habit is the rule here.

- [ ] **Step 1: Write the failing assertion**

```js
// INO already exists in this file and is COMMENT-STRIPPED - use it rather than
// reading scrollback.ino again, or a comment can satisfy an assertion.
const walkFn = /static int scrollWalk\([\s\S]*?\n}\n/.exec(INO);
s(walkFn != null, "structural: scrollWalk is findable");
s(/int\* indent/.test(walkFn ? walkFn[0] : ""),
  "structural: scrollWalk reports the column its row starts at - a renderer that cannot " +
  "ask cannot draw a hanging indent");
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL, naming `scrollWalk reports the column its row starts at`.

- [ ] **Step 3: Implement**

Change the two signatures:

```c
static int scrollWalk(const char* t, int cols, int want,
                      char* out, int outSize, uint8_t* flags, int* indent, bool* found) {
```

```c
bool scrollLineAt(const char* t, int cols, int want, char* out, int outSize,
                  uint8_t* flags, int* indent) {
  bool found = false;
  scrollWalk(t, cols, want, out, outSize, flags, indent, &found);
  if (!found && out && outSize > 0) out[0] = '\0';
  return found;
}
```

Inside `scrollWalk`, at the empty-entry early return and at the `drawn == want` return, write `if (indent) *indent = 0;` beside the existing `if (flags) ...` line.

`scrollWrapLines` passes `nullptr`:

```c
int scrollWrapLines(const char* t, int cols) {
  return scrollWalk(t, cols, -1, nullptr, 0, nullptr, nullptr, nullptr);
}
```

At the two draw call sites (`:583`, `:749`), declare `int li = 0;` beside the existing `uint8_t lf = 0;` and pass it:

```c
      scrollLineAt(scrollTextAt(ei), SCROLL_COLS, k, buf, sizeof(buf), &lf, &li);
```

At `:862` in `scrollFindCode`, declare `int fi = 0;` beside `uint8_t f = 0;` and pass it:

```c
      if (scrollLineAt(scrollTextAt(i), SCROLL_COLS, k, tmp, sizeof(tmp), &f, &fi) &&
          (f & SCROLL_F_CODE))
```

- [ ] **Step 4: Compile and check both baselines**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
```

Expected: board 2 `CHANGED` by a small amount (the extra parameter). Read the `core stamp pooled` line -- a `CHANGED (+16)` whose pooling flipped is the midnight artefact, not this task.

Then, **not concurrently**:

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: board 1 `UNCHANGED`.

- [ ] **Step 5: Run the checkers**

Run: `node firmware/deckhand_display/scrollback-check.mjs && node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: PASS, then exit 0.

- [ ] **Step 6: Commit**

```bash
node firmware/board-baseline.mjs --update 2
git add firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -m "Thread the row's start column through scrollWalk, drawing nothing new yet"
```

The message must say board 2 moved and why: an added parameter on a function called from four sites.

---

### Task 5: Bind the two draw paths to each other

**Files:**
- Modify: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `INO`.
- Produces: an assertion that fails by name if a later task edits one draw loop and not the other.

**THIS TASK EXISTS BECAUSE FIXING ONLY `scrollDrawBody` HAS ALREADY BROKEN THIS SURFACE ONCE** -- the top-edge clipping defect, which silently ended the pixel-for-pixel equivalence a checksum harness had just proved over 30 steps in both directions. Installed now, before any draw change, so it guards Tasks 6-13 rather than being the thing that discovers the damage afterwards.

- [ ] **Step 1: Write the assertion**

```js
// THE TWO DRAW PATHS ARE ONE PATH WRITTEN TWICE, and the second is the one that
// gets forgotten. Compare the per-row DRAWING region of each - from the isCode
// decision to the drawString of the row's text - with whitespace collapsed, so a
// reflow is allowed and a behaviour change is not.
function drawRegion(fnName) {
  const fn = new RegExp("void " + fnName + "\\([\\s\\S]*?\\n}\\n").exec(INO);
  if (!fn) return null;
  const r = /const bool isCode[\s\S]*?drawString\(buf,[^;]*;/.exec(fn[0]);
  return r ? r[0].replace(/\s+/g, " ").trim() : null;
}
const regBody = drawRegion("scrollDrawBody");
const regBand = drawRegion("scrollDrawBand");
s(regBody != null, "structural: scrollDrawBody's row-drawing region is findable");
s(regBand != null, "structural: scrollDrawBand's row-drawing region is findable");
s(regBody != null && regBody === regBand,
  "structural: the two draw paths draw a row IDENTICALLY - fixing only scrollDrawBody " +
  "has already broken this surface's pixel-for-pixel equivalence once");
```

- [ ] **Step 2: Run it against today's code**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS. The two regions are identical today. **If it fails, stop and report** -- that means they have already diverged, which is a finding, not a plan step.

- [ ] **Step 3: Prove it can fail**

Add a `--selftest` fault that edits one region only -- for example, replacing `COLOR_LABEL` with `COLOR_ACCENT` inside `scrollDrawBand`'s region -- and assert the equivalence check reports it.

Run: `node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: exit 0, the new fault CAUGHT.

- [ ] **Step 4: Commit**

```bash
git add firmware/deckhand_display/scrollback-check.mjs
git commit -m "Bind the two scrollback draw paths to each other before touching either"
```

No firmware file changed, so neither binary can have moved. Say so in the message.

---

### Task 6: Code keeps its indentation on wrap

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h` (new constant), `firmware/deckhand_display/scrollback.ino` (`scrollWalk`, both draw loops)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `int* indent` from Task 4; the equivalence assertion from Task 5.
- Produces: `SCROLL_HANG_MAX` in the header; `*indent` non-zero on wrapped code rows.

- [ ] **Step 1: Write the failing assertions**

```js
s(c.SCROLL_HANG_MAX !== undefined, "structural: the hanging-indent cap is a named constant");
s(c.SCROLL_HANG_MAX > 0 && c.SCROLL_HANG_MAX < c.SCROLL_COLS / 2,
  `structural: SCROLL_HANG_MAX (${c.SCROLL_HANG_MAX}) leaves over half the lane for text - ` +
  "past that the wrap itself becomes the unreadable thing");
const walkBody = walkFn ? walkFn[0] : "";
s(/hang = lead \+ 1;/.test(walkBody),
  "structural: a wrapped code row hangs to its source line's own indent plus one");
s(/if \(hang > SCROLL_HANG_MAX\) hang = SCROLL_HANG_MAX;/.test(walkBody),
  "structural: the hang is capped by the named constant, not by a literal");
s(/drawString\(buf, SCROLL_TXT_X \+ li \* TEXT_ADV, y\)/.test(INO),
  "structural: the renderer DRAWS at the column scrollWalk reported - a hang that is " +
  "computed and not drawn changes line counts and nothing else");
```

Extend the JS `walk()` mirror to model the hang (each row gains an `ind`), and add:

```js
m(walk("```\n  int b = n;\n```", 10)[1].ind === 3,
  "mirror: a wrapped code row hangs to its own indent + 1");
m(walk("```\n" + " ".repeat(40) + "x".repeat(40) + "\n```", COLS)[1].ind === c.SCROLL_HANG_MAX,
  "mirror: a deeply indented line is capped at SCROLL_HANG_MAX");
```

- [ ] **Step 2: Run to make sure they fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL by name on each.

- [ ] **Step 3: Add the constant**

In `board_es3c35p.h`, beside the other `SCROLL_*` constants:

```c
// THE HANGING INDENT'S CEILING. A wrapped code row restarts under its own source
// indent so it cannot be misread as a real line at that depth - but a line nested
// six levels deep would leave ten columns for text, and at that point the wrap is
// the unreadable thing rather than the fix. Deep code keeps 12 columns of shape
// and loses the rest, which is the honest trade at 34 columns.
const int SCROLL_HANG_MAX = 12;
```

- [ ] **Step 4: Implement the hang in `scrollWalk`**

Replace the `int q = pos + off, rem = srcLen - off; bool first = true;` preamble and the `do` loop's width decision with:

```c
    int q = pos + off, rem = srcLen - off;
    bool first = true;
    // THE HANGING INDENT, decided ONCE per source line and applied to every row
    // after the first. Code hangs to its own leading whitespace plus one, so a
    // wrapped row cannot be read as a real line at that depth.
    int hang = 0;
    if (inCode) {
      int lead = 0;
      while (lead < srcLen && t[pos + lead] == ' ') lead++;
      hang = lead + 1;
    }
    if (hang > SCROLL_HANG_MAX) hang = SCROLL_HANG_MAX;
    do {
      const int room = cols - (first ? 0 : hang);
      int n;
      if (rem <= room) n = rem;
      else if (inCode) n = room;                // HARD
      else {
        n = room;
        int b = n;
        while (b > room / 2 && t[q + b - 1] != ' ') b--;
        if (b > room / 2) n = b;                // word-friendly, else fall back
      }
      if (n <= 0 && rem > 0) n = 1;             // never stall
      if (drawn == want) {
        if (out && outSize > 0) {
          int cap = n < outSize - 1 ? n : outSize - 1;
          memcpy(out, t + q, cap);
          out[cap] = '\0';
        }
        if (flags) *flags = (inCode ? SCROLL_F_CODE : 0)
                          | (first ? 0 : SCROLL_F_CONT)
                          | (head ? SCROLL_F_HEAD : 0);
        if (indent) *indent = first ? 0 : hang;
        if (found) *found = true;
        return drawn + 1;
      }
      drawn++;
      q += n; rem -= n; first = false;
      if (!inCode) while (rem > 0 && t[q] == ' ') { q++; rem--; }
    } while (rem > 0);
```

- [ ] **Step 5: Draw at the reported column, in BOTH paths**

In `scrollDrawBody` **and** `scrollDrawBand`, change the final text draw from `tft.drawString(buf, SCROLL_TXT_X, y);` to:

```c
    tft.drawString(buf, SCROLL_TXT_X + li * TEXT_ADV, y);
```

- [ ] **Step 6: Run the checkers**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS, including Task 5's equivalence assertion.

Run: `node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: exit 0.

- [ ] **Step 7: Compile, flash, and LOOK**

```bash
./flash.sh --board 2
echo "SCROLLOPEN" > ~/.claude/deckhand-device-command
sleep 2
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```

Open the capture from `~/Deckhand-shots/` and read it. Expected: a wrapped code line's continuation starts under its source indent, carrying a `+` in the gutter. **Every board-2 capture vouches for the GEOMETRY the renderer composed and for nothing else.**

- [ ] **Step 8: Commit**

```bash
node firmware/board-baseline.mjs --update 2
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -m "A wrapped code row restarts under its own indent"
```

---

### Task 7: A tool row must not inherit the previous row's flags

**Files:**
- Modify: `firmware/deckhand_display/scrollback.ino` (both draw loops)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `lf` / `li` from Task 4.
- Produces: nothing new; a latent defect closed.

**A PRE-EXISTING DEFECT, FOUND WHILE MAPPING THE DRAW PATHS FOR THIS WORK.** `uint8_t lf = 0;` is declared *outside* the row loop, and the `if (e.role >= 2)` branch -- the one-line clipped tool rows -- never resets it. So a `$ ran` or `| result` row drawn immediately after a code row inherits `SCROLL_F_CODE` and is painted on `COLOR_CARD`. The sequence is common: a Claude message ending in a code block, then the tool call it describes. **Task 10's edge bar would put a grey bar beside that tool line**, which is how a latent defect becomes a reported one. Fix it before the bar exists, not after.

- [ ] **Step 1: Write the failing assertion**

```js
const flat = INO.replace(/\s+/g, " ");
const toolArms = flat.match(/if \(e\.role >= 2\) \{ if \(k > 0\) continue; lf = 0; li = 0;/g);
s(toolArms != null && toolArms.length === 2,
  "structural: BOTH draw paths' one-line tool arms CLEAR the flags - lf is declared " +
  "outside the row loop, so without this a $ or | row after a code row inherits " +
  "SCROLL_F_CODE and its card ground");
```

- [ ] **Step 2: Run to make sure it fails**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL, naming `BOTH draw paths' one-line tool arms CLEAR the flags`.

- [ ] **Step 3: Implement in BOTH paths**

In `scrollDrawBody` and `scrollDrawBand`, at the top of the `if (e.role >= 2)` branch, immediately after `if (k > 0) continue;`:

```c
    if (e.role >= 2) {
      if (k > 0) continue;
      // `lf` AND `li` ARE DECLARED OUTSIDE THIS LOOP, so a row that does not set
      // them keeps the PREVIOUS row's. A tool row after a code row was inheriting
      // SCROLL_F_CODE and being painted on the card ground - reachable whenever a
      // message ends in a code block and the next entry is the call it describes.
      lf = 0;
      li = 0;
```

- [ ] **Step 4: Run the checkers**

Run: `node firmware/deckhand_display/scrollback-check.mjs && node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: PASS, then exit 0. Task 5's equivalence assertion passes only if you edited both loops.

- [ ] **Step 5: Compile and check both baselines**

As Task 4, Step 4. Board 1 `UNCHANGED`, board 2 `CHANGED`.

- [ ] **Step 6: Commit**

```bash
node firmware/board-baseline.mjs --update 2
git add firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -m "A tool row was inheriting the code row above it, and the edge bar would have shown it"
```

---

### Task 8: Bullets hang to their content column

**Files:**
- Modify: `firmware/deckhand_display/scrollback.ino` (new `scrollListHang` helper, `scrollWalk`)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: the `hang` variable from Task 6.
- Produces: `static int scrollListHang(const char* s, int len)` -- the marker's width, or 0.

- [ ] **Step 1: Write the failing assertions**

```js
s(/static int scrollListHang\(/.test(INO),
  "structural: the list marker's width is measured by its own named function");
s(/hang = scrollListHang\(t \+ pos, srcLen\);/.test(walkBody),
  "structural: a prose line's hang comes from its list marker");
m(walk("* one two three four five", 12)[1].ind === 2,
  "mirror: a wrapped bullet hangs to its text column, not to its marker");
m(walk("12. one two three four five", 12)[1].ind === 4,
  "mirror: an ordered marker's width includes its digits and its dot");
m(walk("plain prose that wraps here", 12)[1].ind === 0,
  "mirror: prose that is not a list does not hang - wrapping is simply how prose reads");
```

- [ ] **Step 2: Run to make sure they fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL by name.

- [ ] **Step 3: Implement**

Above `scrollWalk` in `scrollback.ino`:

```c
// THE WIDTH OF A LIST MARKER at the start of a source line, or 0 for a line that
// is not a list item. `* ` and `- ` are two; an ordered marker is its digits plus
// ". ". Leading spaces are counted in, so a nested item hangs to ITS OWN text
// column rather than to the outer list's.
static int scrollListHang(const char* s, int len) {
  int i = 0;
  while (i < len && s[i] == ' ') i++;
  if (i + 1 < len && (s[i] == '*' || s[i] == '-') && s[i + 1] == ' ') return i + 2;
  int d = i;
  while (d < len && s[d] >= '0' && s[d] <= '9') d++;
  if (d > i && d + 1 < len && s[d] == '.' && s[d + 1] == ' ') return d + 2;
  return 0;
}
```

In `scrollWalk`, extend Task 6's hang decision:

```c
    int hang = 0;
    if (inCode) {
      int lead = 0;
      while (lead < srcLen && t[pos + lead] == ' ') lead++;
      hang = lead + 1;
    } else {
      hang = scrollListHang(t + pos, srcLen);
    }
    if (hang > SCROLL_HANG_MAX) hang = SCROLL_HANG_MAX;
```

Mirror the same rule in the JS `walk()`.

- [ ] **Step 4: Run the checkers**

Run: `node firmware/deckhand_display/scrollback-check.mjs && node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: PASS, then exit 0.

- [ ] **Step 5: Compile and check both baselines**

As Task 4, Step 4.

- [ ] **Step 6: Commit**

```bash
node firmware/board-baseline.mjs --update 2
git add firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -m "A wrapped list item hangs to its text, so two items stop looking like one"
```

---

### Task 9: A spaceless token breaks at a seam

**Files:**
- Modify: `firmware/deckhand_display/scrollback.ino` (new `scrollBreakAfter` predicate, `scrollWalk`'s prose branch)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: the `room` variable from Task 6.
- Produces: `static bool scrollBreakAfter(char c)`.

**THE WORD-WRAP GIVES UP ON A TOKEN WITH NO SPACE IN IT.** Its rule is "scan back for a space, but not past half the lane", and a file path or a URL has no space at all -- so it falls through to a hard cut that lands mid-word. Task 3 shortened URLs on the Mac, which is most of this problem; a long repository path is what is left, and the Mac cannot shorten that without losing what identifies it. Four characters are where a reader's eye already expects a seam.

- [ ] **Step 1: Write the failing assertions**

```js
s(/static bool scrollBreakAfter\(char c\)/.test(INO),
  "structural: the extra break points are their own named predicate, not four literals " +
  "inlined in the wrap");
s(/scrollBreakAfter\(t\[q \+ c2 - 1\]\)/.test(walkBody),
  "structural: prose that found no space falls back to a seam BEFORE hard-cutting");
m(walk("docs/reference/scrollback.md", 20)[0].text === "docs/reference/",
  "mirror: a spaceless path breaks after the last separator inside the lane");
m(walk("x".repeat(30), 10).length === 3,
  "mirror: a token with no space and no seam still hard-cuts, and never stalls");
```

- [ ] **Step 2: Run to make sure they fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL by name on each.

- [ ] **Step 3: Implement**

Above `scrollWalk` in `scrollback.ino`:

```c
// WHERE A SPACELESS TOKEN MAY BE BROKEN. The word-wrap scans back for a space and
// gives up past half the lane - and a path or a URL has no space in it at all, so
// it fell through to a hard cut that landed mid-word. These four are where a
// reader's eye already expects a seam, and the character STAYS on the row it ends,
// so the break reads as deliberate rather than as a dropped character.
static bool scrollBreakAfter(char c) {
  return c == '/' || c == '.' || c == '-' || c == '_';
}
```

In `scrollWalk`'s prose branch, extend the fallback from Task 6:

```c
      else {
        n = room;
        int b = n;
        while (b > room / 2 && t[q + b - 1] != ' ') b--;
        if (b > room / 2) n = b;                // word-friendly
        else {
          // NO SPACE IN THE LANE AT ALL. Rather than hard-cut mid-word, look for
          // a seam - and only then give up.
          int c2 = room;
          while (c2 > room / 2 && !scrollBreakAfter(t[q + c2 - 1])) c2--;
          if (c2 > room / 2) n = c2;
        }
      }
```

Mirror the same fallback in the JS `walk()`.

- [ ] **Step 4: Run the checkers**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: PASS.

- [ ] **Step 5: Prove they can fail**

Add the fault beside the others in the `if (SELFTEST)` block, and a `WANT` entry for it:

```js
  if (fault === "no-seam")
    INO = INO.replace(/if \(c2 > room \/ 2\) n = c2;/, "");
```

```js
    "no-seam": /falls back to a seam BEFORE hard-cutting/,
```

Run: `SB_FAULT=no-seam node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: exit 0, `selftest ok - caught by:` naming the seam assertion.

- [ ] **Step 6: Compile and check both baselines**

As Task 4, Step 4.

- [ ] **Step 7: Commit**

```bash
node firmware/board-baseline.mjs --update 2
git add firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -m "Break a spaceless path at a seam instead of mid-word"
```

---

### Task 10: The block's own edge

**Files:**
- Modify: `firmware/deckhand_display/board_es3c35p.h`, `firmware/deckhand_display/scrollback.ino` (both draw loops)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `SCROLL_F_CODE`.
- Produces: `SCROLL_CODE_EDGE_X`, `SCROLL_CODE_EDGE_W` in the header.

**COLOR_LABEL, NOT COLOR_ACCENT.** The bar's job is structural -- "these rows are one block" -- not to attract the eye. Accent already carries five jobs on this surface (heading text, rail knob, new-below badge, back key border, filter chip fill) and a sixth dilutes all of them. **No top/bottom flags:** a block is always separated from what surrounds it by a blank or prose row, so the bar breaks by itself. Two flags and their selftest faults were designed and deleted -- do not re-add them believing they were overlooked.

- [ ] **Step 1: Write the failing assertions**

```js
s(c.SCROLL_CODE_EDGE_X !== undefined && c.SCROLL_CODE_EDGE_W !== undefined,
  "structural: the code block's edge bar is two named constants");
s(c.SCROLL_CODE_EDGE_X >= c.SCROLL_GUT_X + c.TEXT_ADV &&
  c.SCROLL_CODE_EDGE_X + c.SCROLL_CODE_EDGE_W <= c.SCROLL_TXT_X,
  `structural: the edge bar (${c.SCROLL_CODE_EDGE_X}..` +
  `${c.SCROLL_CODE_EDGE_X + c.SCROLL_CODE_EDGE_W}) sits between the gutter mark's cell and ` +
  "the text column, touching neither");
const bars = INO.match(
  /fillRect\(SCROLL_CODE_EDGE_X, y, SCROLL_CODE_EDGE_W, CODE_LINE_H, COLOR_LABEL\)/g);
s(bars != null && bars.length === 2,
  "structural: BOTH draw paths draw the edge bar, and it is COLOR_LABEL - structure, not " +
  "emphasis; accent already carries five jobs on this surface");
```

- [ ] **Step 2: Run to make sure they fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL by name.

- [ ] **Step 3: Add the constants**

In `board_es3c35p.h`:

```c
// THE CODE BLOCK'S EDGE. A per-row COLOR_CARD fill says "this row is code" and
// cannot say where a block starts or ends - a one-line block reads as a
// highlighted prose line. Two pixels between the gutter mark's cell and the text
// column, touching neither: the `+` continuation mark still needs its 8px cell at
// SCROLL_GUT_X, and the text still starts at SCROLL_TXT_X.
const int SCROLL_CODE_EDGE_X = 20;
const int SCROLL_CODE_EDGE_W = 2;
```

- [ ] **Step 4: Implement in BOTH paths**

In `scrollDrawBody` and `scrollDrawBand`, replace the single-statement `if (isCode)` fill with:

```c
    if (isCode) {
      tft.fillRect(SCROLL_GUT_X, y, SCROLL_RAIL_X - SCROLL_RAIL_AIR - SCROLL_GUT_X,
                   CODE_LINE_H, COLOR_CARD);
      // THE BLOCK'S OWN EDGE, which a per-row fill cannot be. COLOR_LABEL because
      // this is structure and accent already carries five jobs here. No top or
      // bottom flag is needed: a block is always separated from what surrounds it
      // by a blank or a prose row, so the bar breaks by itself.
      tft.fillRect(SCROLL_CODE_EDGE_X, y, SCROLL_CODE_EDGE_W, CODE_LINE_H, COLOR_LABEL);
    }
```

- [ ] **Step 5: Run the checkers**

Run: `node firmware/deckhand_display/scrollback-check.mjs && node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: PASS, then exit 0. Task 5's equivalence assertion catches a one-path edit.

- [ ] **Step 6: Run `geom-sweep`, because two constants just appeared**

Run: `node firmware/deckhand_display/geom-sweep.mjs` (~110s)
Expected: the two new constants are GUARDED by the assertion in Step 1. If the sweep reports them unguarded, the assertion is not binding them -- fix the assertion, not the sweep.

- [ ] **Step 7: Compile, flash, LOOK**

```bash
./flash.sh --board 2
echo "SCROLLOPEN" > ~/.claude/deckhand-device-command
sleep 2
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```

Read the capture. Expected: one continuous bar down the left of each block, breaking between blocks, and **no bar beside a `$` or `|` tool row** (Task 7).

- [ ] **Step 8: Commit**

```bash
node firmware/board-baseline.mjs --update 2
git add firmware/deckhand_display/board_es3c35p.h firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -m "Give a code block edges a per-row fill cannot draw"
```

---

### Task 11: A heading gets a rule, under its last row only

**Files:**
- Modify: `firmware/deckhand_display/scrollback.ino` (flag, `scrollWalk`, both draw loops), `firmware/deckhand_display/scrollback-check.mjs` (extend `drawRegion`)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: `SCROLL_F_HEAD`.
- Produces: `#define SCROLL_F_HEADEND 0x8`.

**Under the LAST row only.** A wrapped two-row heading with a rule between its rows reads as two headings. **`COLOR_LABEL`, under accent text:** a rule is structure, the heading already spends accent on its text, and orange under orange reads as one thicker heading.

- [ ] **Step 1: Write the failing assertions**

```js
s(/#define SCROLL_F_HEADEND 0x8/.test(INO),
  "structural: the heading's last row has its own flag");
s(/\(head && last\) \? SCROLL_F_HEADEND : 0/.test(walkBody),
  "structural: SCROLL_F_HEADEND is set on the LAST row of a heading, by operand - a rule " +
  "between a wrapped heading's two rows reads as two headings");
const rules = INO.match(/lf & SCROLL_F_HEADEND\)[\s\S]{0,120}?CODE_LINE_H - 2/g);
s(rules != null && rules.length === 2,
  "structural: BOTH draw paths draw the rule under the row carrying SCROLL_F_HEADEND");
m(walk("## a heading long enough to wrap here", 12).filter((r) => r.headEnd).length === 1,
  "mirror: exactly one row of a wrapped heading is its last");
```

- [ ] **Step 2: Run to make sure they fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL by name.

- [ ] **Step 3: Implement**

Beside the other flags in `scrollback.ino`:

```c
#define SCROLL_F_HEADEND 0x8
```

In `scrollWalk`'s `drawn == want` return, compute `last` before the flags and add the arm:

```c
      if (drawn == want) {
        if (out && outSize > 0) {
          int cap = n < outSize - 1 ? n : outSize - 1;
          memcpy(out, t + q, cap);
          out[cap] = '\0';
        }
        // THE LAST ROW OF THIS SOURCE LINE, decided from what is left AFTER this
        // row takes its share - the only point at which the answer is knowable.
        const bool last = (rem - n) <= 0;
        if (flags) *flags = (inCode ? SCROLL_F_CODE : 0)
                          | (first ? 0 : SCROLL_F_CONT)
                          | (head ? SCROLL_F_HEAD : 0)
                          | ((head && last) ? SCROLL_F_HEADEND : 0);
        if (indent) *indent = first ? 0 : hang;
        if (found) *found = true;
        return drawn + 1;
      }
```

In **both** draw loops, after the `drawString(buf, ...)` line:

```c
    // THE HEADING'S RULE, under its LAST row only - a rule between a wrapped
    // heading's two rows reads as two headings. COLOR_LABEL under accent text: a
    // rule is structure, and orange under orange reads as one thicker heading.
    if (lf & SCROLL_F_HEADEND)
      tft.fillRect(SCROLL_TXT_X, y + CODE_LINE_H - 2,
                   SCROLL_RAIL_X - SCROLL_RAIL_AIR - SCROLL_TXT_X, 1, COLOR_LABEL);
```

Mirror `headEnd` in the JS `walk()`.

**Then extend Task 5's `drawRegion`.** Its inner regex currently ends at `drawString(buf, ...)`. Change it to end at the `SCROLL_F_HEADEND` fillRect, so the new line falls inside the compared region in both paths:

```js
  const r = /const bool isCode[\s\S]*?SCROLL_F_HEADEND\)[\s\S]*?COLOR_LABEL\);/.exec(fn[0]);
```

- [ ] **Step 4: Run the checkers**

Run: `node firmware/deckhand_display/scrollback-check.mjs && node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: PASS, then exit 0.

- [ ] **Step 5: Compile and check both baselines**

As Task 4, Step 4.

- [ ] **Step 6: Commit**

```bash
node firmware/board-baseline.mjs --update 2
git add firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -m "A heading gets a rule under its last row, so it survives a greyscale capture"
```

---

### Task 12: The language label row

**Files:**
- Modify: `firmware/deckhand_display/scrollback.ino` (flag, `scrollWalk`'s fence arm, both draw loops)
- Test: `firmware/deckhand_display/scrollback-check.mjs`

**Interfaces:**
- Consumes: Task 1's info string on the wire.
- Produces: `#define SCROLL_F_LANG 0x10`.

**This is the most droppable item in the design** -- it costs one row out of 27 per block, and it can be removed later without touching anything else. It is written down as such rather than defended.

- [ ] **Step 1: Write the failing assertions**

```js
s(/#define SCROLL_F_LANG 0x10/.test(INO), "structural: a language row has its own flag");
s(/const bool opening = !inCode;/.test(walkBody),
  "structural: the language row is emitted on the OPENING fence only - a closing fence " +
  "still draws nothing");
const dims = INO.match(/lf & SCROLL_F_LANG\) \? COLOR_LABEL/g);
s(dims != null && dims.length === 2,
  "structural: BOTH draw paths draw a language row dim - it labels the block, it is not " +
  "part of it");
m(walk("```cpp\nint x;\n```", COLS).length === 2,
  "mirror: a fence that names a language costs ONE row; the block below is unchanged");
m(walk("```\nint x;\n```", COLS).length === 1,
  "mirror: a fence that names nothing still costs nothing");
m(walk("```cpp\nint x;\n```", COLS)[0].lang === true,
  "mirror: the language row is flagged as one");
```

- [ ] **Step 2: Run to make sure they fail**

Run: `node firmware/deckhand_display/scrollback-check.mjs`
Expected: FAIL by name.

- [ ] **Step 3: Implement**

Beside the other flags:

```c
#define SCROLL_F_LANG 0x10
```

Replace `scrollWalk`'s fence arm:

```c
    // A fence toggles the mode. It draws NOTHING unless it is an OPENING fence
    // that names a language, in which case that name is one dim row above the
    // block. A bare fence costs exactly what it costs today.
    if (srcLen >= 3 && t[pos] == '`' && t[pos + 1] == '`' && t[pos + 2] == '`') {
      const bool opening = !inCode;
      inCode = !inCode;
      int ln = srcLen - 3;
      if (ln > cols) ln = cols;
      if (opening && ln > 0) {
        if (drawn == want) {
          if (out && outSize > 0) {
            int cap = ln < outSize - 1 ? ln : outSize - 1;
            memcpy(out, t + pos + 3, cap);
            out[cap] = '\0';
          }
          if (flags) *flags = SCROLL_F_CODE | SCROLL_F_LANG;
          if (indent) *indent = 0;
          if (found) *found = true;
          return drawn + 1;
        }
        drawn++;
      }
      pos = t[eol] ? eol + 1 : eol;
      continue;
    }
```

In **both** draw loops, replace the text-colour decision:

```c
    // A heading takes the accent so sections are findable while scrolling; its
    // own # markers were stripped by the walker. A LANGUAGE ROW is dim: it labels
    // the block, it is not part of it.
    const uint16_t fg = (lf & SCROLL_F_HEAD) ? COLOR_ACCENT
                      : (lf & SCROLL_F_LANG) ? COLOR_LABEL
                      : scrollTextColor(e.role);
    tft.setTextColor(fg, bg);
```

Mirror `lang` in the JS `walk()`.

- [ ] **Step 4: Run the checkers**

Run: `node firmware/deckhand_display/scrollback-check.mjs && node firmware/deckhand_display/scrollback-check.mjs --selftest`
Expected: PASS, then exit 0.

- [ ] **Step 5: Compile, flash, and LOOK at a real block**

```bash
./flash.sh --board 2
echo "SCROLLOPEN" > ~/.claude/deckhand-device-command
sleep 2
echo "SCROLLTO" > ~/.claude/deckhand-device-command
echo "SCREENSHOT" > ~/.claude/deckhand-device-command
```

**Use `SCROLLTO` to position the view, never `SCROLLPERF`.** `SCROLLPERF` times twenty frames of each of two render paths, which sweeps the view top to bottom twice and has twice been reported as the page scrolling by itself.

Read the capture. Expected: a dim language row above the block, on the card ground, with the edge bar running past it.

- [ ] **Step 6: Commit**

```bash
node firmware/board-baseline.mjs --update 2
git add firmware/deckhand_display/scrollback.ino firmware/deckhand_display/scrollback-check.mjs firmware/board-baseline.json
git commit -m "Label a code block with the language the Mac now sends"
```

---

### Task 13: Measure it, record it, and commit the mock

**Files:**
- Modify: `docs/reference/scrollback.md`
- Create: `docs/design/scrollback-markup/markup.html`, `docs/design/scrollback-markup/check.mjs`, `docs/design/scrollback-markup/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the durable record.

- [ ] **Step 1: Run the full checker set**

```bash
node firmware/deckhand_display/scrollback-check.mjs
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/geom-sweep.mjs
node firmware/board-baseline.mjs --doc-check
node docs/design/scrollback/check.mjs
node host/multi-device-check.mjs
```

Expected: all pass. Record any that do not, with their output.

- [ ] **Step 2: Measure the row cost on real content**

With a real session's transcript loaded, count the rows one representative Claude turn now costs against what it cost before. **The mock's figures are predictions; these are measurements, and the measurements are what goes in the doc.**

- [ ] **Step 3: Write the reference section**

Add a section to `docs/reference/scrollback.md` covering: the six findings and which task closed each; the two host changes and why no version bump was needed; `SCROLL_HANG_MAX` and `SCROLL_CODE_EDGE_X/W` with their reasons; the argument for keeping `+` alongside the indent; the no-top/bottom-flags decision; the tool-row flag-inheritance defect and that it predated this work; and a **WHAT IS NOT VERIFIED** list stating plainly that no claim covers COLOUR, that `COLORTEST` is the instrument and a person is the authority, and that no finger has touched any of it.

- [ ] **Step 4: Commit the chosen rendering as a bound mock**

Adapt the comparison mock to the shipped rendering only, and write `check.mjs` in the shape of `docs/design/scrollback/check.mjs`: parse the mock's `var` geometry and bind it to `board_es3c35p.h` through `consts()`. **A committed design artifact whose numbers can drift while it still reports "all passed" is the same class of defect as an assertion that cannot fail.**

Run: `node docs/design/scrollback-markup/check.mjs`
Expected: all bindings pass.

- [ ] **Step 5: Final baselines**

```bash
arduino-cli compile --fqbn "esp32:esp32:esp32:PartitionScheme=huge_app" --output-dir /tmp/b1 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1
```

Expected: board 1 `UNCHANGED`. If it is not, stop -- nothing in this plan should have reached it.

- [ ] **Step 6: Commit**

```bash
git add docs/reference/scrollback.md docs/design/scrollback-markup/
git commit -m "Record what the markup treatment changed, and bind its mock to the header"
```

---

## Definition of done

- [ ] Every checker in Task 13 Step 1 passes, and `--selftest` exits 0 for `scrollback-check.mjs`.
- [ ] Board 1 is `UNCHANGED` at every commit.
- [ ] Board 2's baseline was re-taken at each firmware commit, with the message saying why it moved.
- [ ] A capture shows: indented code continuations carrying `+`, an edge bar per block that breaks between blocks and is absent beside tool rows, a dim language row, a rule under the last row of a heading, hanging bullets, collapsed links with their mark, and a long path broken after a separator rather than mid-word.
- [ ] The reference doc states what is measured and what is not.
