# Sessions manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach all 132 conversations from the device, and stop sessions vanishing in silence.

**Architecture:** The host gains one load-bearing capability first — resolving any session id to its `.jsonl` independently of the live list — because every screen after that is a UI on top of it. Then a fourth tab carries two levels (projects, then a project's sessions), and tapping a session opens the EXISTING scrollback rather than a new reader. SESSIONS itself changes last and least: a ghost row and a floating count line, no change to the row shape or the ranking.

**Tech Stack:** Node (host, ESM, no deps), Arduino C++ (ESP32 / ESP32-S3), `arduino-cli`, offline Node checkers (`commands-check.mjs`, `*-geom-check.mjs`, `board-baseline.mjs`).

**Spec:** [`docs/superpowers/specs/2026-09-20-sessions-manager-design.md`](../specs/2026-09-20-sessions-manager-design.md)

## Global Constraints

- **There is no test suite.** The cycle is: add the assertion to a checker, run it and watch it **FAIL BY NAME**, make the change, run it and watch it pass. An assertion that cannot fail is a defect.
- **A checker must PARSE the constant it certifies, never TRANSCRIBE it.** A literal on the checker's side means reverting the constant does not fail.
- **Bind assertions to a FUNCTION BODY, not a file** (`fnBody()` from `geom-common.mjs`). A rule a neighbouring line can satisfy is not a rule.
- **Every checker takes `--selftest`**, which injects a fault and exits 0 only when that fault IS caught.
- **NEVER DECODE A PROJECT DIRECTORY NAME INTO A PATH.** The encoding is lossy: `-Users-yujia-work-claude-plugins` is `/Users/yujia/work/claude-plugins`, not `.../claude/plugins`, and `--claude-worktrees-` is `/.claude/worktrees/`. The real path is the `cwd` field inside the `.jsonl` (line 3 of the file measured 2026-09-20). Treat the directory name as an OPAQUE KEY only.
- **Fonts are ASCII `0x20..0x7E` only.** Out-of-range draws nothing AND advances nothing. Three ASCII dots, never `U+2026`. Everything device-bound goes through `host/to-ascii.mjs`.
- **Every field redraws only when its value changes** (`drawIfChanged`, `drawBar`). A cache shorter than its string silently stops noticing; a field whose chrome is repainted must have its cache reset; **a colour-only change busts no text cache and must be busted explicitly.**
- **`#if` on a C++ `const int` is silently false.** Board flags must be `#define`.
- **`.ino` files are ONE translation unit**, concatenated with the folder-named one first then the rest alphabetically. A function whose signature names a late-declared type will not compile; a global defined in a later file needs an `extern` in `deckhand_display.ino`.
- **`processCompletedLine` takes `buf` by REFERENCE.** A handler that returns early without setting `buf = ""` refuses the same text for ever.
- **The host delivers every command over BOTH transports**, so a cabled device receives it twice. Every handler must tolerate that, and every refusal must NAME ITS CAUSE.
- **Never compile both boards concurrently.** `arduino-cli` derives its build directory from the sketch path. `--no-compile` flashes whichever board was compiled LAST.
- **A compile takes about 3 minutes.** Budget for it; it is not a hang.
- **Put only the fragment that differs behind an `#if`.** Arms duplicating a whole statement break every brace-counting checker here.
- **Board baselines:** `node firmware/board-baseline.mjs --doc-check` must pass at every commit, and every binary movement is measured and explained in the commit message.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

**Parsed values this plan derives from** (re-parse; do not trust these if the headers have moved):

| | board 1 (`board_e32r28t.h`) | board 2 (`board_es3c35p.h`) |
|---|---|---|
| `BOARD_W` / `BOARD_H` | 240 / 320 | 320 / 480 |
| `TAB_BAR_H` / `FOOTER_H` | 34 / — | 46 / 20 |
| `CONTENT_Y` / `contentBottom()` | 34 / 302 | 46 / 460 |
| `SESSION_ROW_X` / `SESSION_ROW_W` | — | 12 / 296 |
| `SESSION_RAIL_X` / `SESSION_RAIL_W` | — | 310 / 6 |
| `SESSION_SCROLL_ROW_H` / `SESSION_SCROLL_STEP` | — | 79 / 82 |
| `SESSION_OVERFLOW_H` | — | 19 |
| `SESSION_SLOTS` | 6 | 20 |
| `T_HEAD` cell / advance | 18 / 10 | 24 / 12 |
| `T_BODY` = `T_META` cell / advance | 13 / 6 | 16 / 8 |
| tab label font | `setUIFont(1)` = `T_META` | `setUIFont(1)` = `T_META` |
| tab slot at 4 tabs | 60px (label 48) | 80px (label 64) |
| `TAB_COUNT` today | 3 | 3 |

**Measured counts, 2026-09-20** (context, not constants): 1 live session, 22 transcripts in this project, 132 across 16 projects.

---

### Task 1: Host — the project index, pure and testable

The load-bearing piece. Pure functions over injected data, exactly as `host/session-lookup.mjs` is, so it needs no filesystem to test.

**Files:**
- Create: `host/project-index.mjs`
- Create: `host/project-index-check.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `cwdFromLines(lines: string[]): string | null` — the `cwd` from the first JSONL lines, or null.
  - `projectLabel(cwd: string): string` — the last path segment.
  - `pickTranscript(files: string[], id12: string): {ok:true,file:string} | {ok:false,reason:"empty"|"none"|"ambiguous"}`

- [ ] **Step 1: Write the failing checker**

Create `host/project-index-check.mjs`:

```js
// Checks project-index without a filesystem or a running host.
//
// THE ONE RULE THIS FILE EXISTS FOR: a project directory name is a LOSSY path
// encoding and must never be decoded. "-Users-yujia-work-claude-plugins" is
// /Users/yujia/work/claude-plugins, NOT /Users/yujia/work/claude/plugins - the
// hyphen in the project's own name is indistinguishable from a separator. A
// decoder would be right for most paths and silently wrong for every hyphenated
// project and every worktree, which is the worst available failure shape.
import { cwdFromLines, projectLabel, pickTranscript } from "./project-index.mjs";

const SELFTEST = process.argv.includes("--selftest");
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}` +
    (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

// cwd is not on line 1 - the measured file opens with a queue-operation - so a
// reader that only looks at the head of the file finds nothing.
const REAL = [
  '{"type":"queue-operation","operation":"enqueue"}',
  '{"type":"queue-operation","operation":"dequeue"}',
  '{"parentUuid":null,"cwd":"/Users/yujia/work/claude-plugins","type":"user"}',
];
check("cwd is found past line 1", cwdFromLines(REAL), "/Users/yujia/work/claude-plugins");
check("no cwd anywhere is null, not a guess", cwdFromLines(REAL.slice(0, 2)), null);
check("empty input is null", cwdFromLines([]), null);
check("a hyphenated project keeps its hyphen",
  projectLabel("/Users/yujia/work/claude-plugins"), "claude-plugins");
check("a worktree keeps its own last segment",
  projectLabel("/Users/yujia/projects/deckhand/.claude/worktrees/session-ranking"),
  "session-ranking");
check("a trailing slash does not yield an empty label",
  projectLabel("/Users/yujia/work/parallax/"), "parallax");

const FILES = ["abc123456789-aaaa.jsonl", "def123456789-bbbb.jsonl", "notes.txt"];
check("exact 12-char prefix resolves",
  pickTranscript(FILES, "abc123456789"), { ok: true, file: "abc123456789-aaaa.jsonl" });
check("a non-jsonl is never returned",
  pickTranscript(["abc123456789.txt"], "abc123456789"), { ok: false, reason: "none" });
check("no match is reported, not guessed",
  pickTranscript(FILES, "999999999999"), { ok: false, reason: "none" });
check("empty id is rejected", pickTranscript(FILES, ""), { ok: false, reason: "empty" });
// The same bug session-lookup.mjs exists for: two files sharing a prefix must
// NOT silently pick the first. Resuming into the wrong conversation is worse
// than refusing.
check("ambiguous prefix is refused",
  pickTranscript(["abc123456789-a.jsonl", "abc123456789-b.jsonl"], "abc123456789"),
  { ok: false, reason: "ambiguous" });

if (SELFTEST) {
  // Prove the teeth: the decoder fault this file exists to prevent.
  const naive = (dir) => "/" + dir.replace(/^-/, "").split("-").join("/");
  const caught = naive("-Users-yujia-work-claude-plugins") !== "/Users/yujia/work/claude-plugins";
  console.log(caught
    ? "  caught  a naive dirname decoder disagrees with the file's own cwd"
    : "  MISSED  a naive dirname decoder was not caught");
  if (!caught) fail++;
}
console.log(`\n${fail} failure(s)`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail by name**

Run: `node host/project-index-check.mjs`
Expected: FAIL — `Cannot find module './project-index.mjs'`

- [ ] **Step 3: Write the module**

Create `host/project-index.mjs`:

```js
// The project side of ~/.claude/projects/, as PURE functions over injected data.
// Nothing here touches the filesystem; index.mjs does the readdir and hands the
// results in, which is what makes it testable with no hardware and no Mac state.
//
// SCAN_LINES is 40 because the cwd is not on line 1 - the measured file opens
// with two queue-operation records and carries cwd on line 3 - and reading the
// whole file to find one field would turn a 16-project listing into 132 full
// file reads.
export const SCAN_LINES = 40;

const RE_CWD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export function cwdFromLines(lines) {
  for (const line of lines.slice(0, SCAN_LINES)) {
    const m = RE_CWD.exec(line);
    if (m) return m[1];
  }
  return null;
}

// The last path segment, and NOTHING derived from the directory name. See the
// checker's header for why decoding the directory name is forbidden.
export function projectLabel(cwd) {
  const parts = String(cwd).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function pickTranscript(files, id12) {
  if (!id12) return { ok: false, reason: "empty" };
  const hits = files.filter((f) => f.endsWith(".jsonl") && f.startsWith(id12));
  if (hits.length === 0) return { ok: false, reason: "none" };
  if (hits.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, file: hits[0] };
}
```

- [ ] **Step 4: Run the checker and its selftest**

Run: `node host/project-index-check.mjs && node host/project-index-check.mjs --selftest`
Expected: both PASS, `0 failure(s)`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add host/project-index.mjs host/project-index-check.mjs
git commit -m "The project index refuses to decode a directory name

A project directory name is a lossy path encoding: -Users-yujia-work-claude-plugins
is /Users/yujia/work/claude-plugins, not .../claude/plugins. A decoder is right for
most paths and silently wrong for every hyphenated project and every worktree. The
cwd inside the .jsonl is the only honest source, and it is not on line 1.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Host — any session id resolves, not just live ones

The gap: `transcriptById` is populated only from the live ranked list, and `resolveSessionId` searches `deckhand-sessions/*.json` — precisely the set `SessionEnd` deletes. Until this is closed, a dead session cannot be read.

**Files:**
- Modify: `host/index.mjs` — the transcript lookup used by the `HISTORY` / scrollback path
- Modify: `host/project-index-check.mjs` — add the structural assertion

**Interfaces:**
- Consumes: `pickTranscript`, `cwdFromLines`, `SCAN_LINES` from Task 1.
- Produces: `async function transcriptPathFor(id12): Promise<string|null>` in `host/index.mjs` — returns an absolute `.jsonl` path for ANY session id, live or dead, else null.

- [ ] **Step 1: Add the failing structural assertion**

Append to `host/project-index-check.mjs`, before the `SELFTEST` block. This is the STRUCTURAL half — it reads the real source text, because a mirror proves the algorithm and binds nothing:

```js
import fs from "fs";
const HOST = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const body = (name) => {
  const at = HOST.indexOf(`function ${name}(`);
  if (at < 0) return "";
  return HOST.slice(at, HOST.indexOf("\n}", at));
};
check("transcriptPathFor exists", body("transcriptPathFor").length > 0, true);
// Bound to the FUNCTION BODY: a fallback that only consults the live map would
// leave every dead session unreadable, which is the whole defect.
check("transcriptPathFor consults the project index, not only the live map",
  /pickTranscript\(/.test(body("transcriptPathFor")), true);
```

- [ ] **Step 2: Run it and watch it fail by name**

Run: `node host/project-index-check.mjs`
Expected: FAIL — `transcriptPathFor exists ... got false want true`

- [ ] **Step 3: Implement**

In `host/index.mjs`, beside the other session helpers:

```js
// ANY session id, live or dead. transcriptById only ever held the live ranked
// list, so an ended session - which is 131 of 132 of them, because the hook
// deletes the record on SessionEnd - was unreachable. The live map stays as the
// fast path; the project scan is the fallback, and it is only ever walked for a
// row the user actually tapped.
async function transcriptPathFor(id12) {
  const live = transcriptById.get(id12);
  if (live) return live;
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch { return null; }
  for (const d of dirs) {
    let files = [];
    try { files = await fsp.readdir(path.join(PROJECTS_DIR, d)); } catch { continue; }
    const hit = pickTranscript(files, id12);
    if (hit.ok) return path.join(PROJECTS_DIR, d, hit.file);
  }
  return null;
}
```

Add `const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");` beside `SESSIONS_DIR`, and the import from Task 1.

Then route the scrollback's lookup through it — replace the direct `transcriptById.get(id)` read in the `HISTORY`/scrollback request handler with `await transcriptPathFor(id)`.

- [ ] **Step 4: Verify**

Run: `node host/project-index-check.mjs && node host/project-index-check.mjs --selftest`
Expected: PASS.

Then live, with a dead session's 12-char id taken from `ls ~/.claude/projects/*/ | head`:

Run: `./host/deckhand-service.sh stop && ./host/deckhand-service.sh start`
(**`restart` is NOT a subcommand** — it prints usage and exits 1, and a `|| start` fallback is a no-op on a running process. This cost a whole invalid measurement on 2026-09-20.)

Expected in `/tmp/deckhand-launchd.out`: a `Scrollback: <id> ... via ...` line for a session that is not in the live list.

- [ ] **Step 5: Commit**

```bash
git add host/index.mjs host/project-index-check.mjs
git commit -m "A dead session's transcript becomes reachable

transcriptById was built solely from the live ranked list and resolveSessionId
searches deckhand-sessions/*.json - precisely the set SessionEnd deletes. So the
131 of 132 conversations that had ended were unreadable by construction. The live
map stays the fast path; the project scan is the fallback, walked only for a row
somebody tapped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Host — the two replies and the tick counters

**Files:**
- Modify: `host/index.mjs` — `PROJECTS` and `PROJSESS <key>` request handling, and two tick fields
- Modify: `host/project-index-check.mjs` — payload-shape assertions

**Interfaces:**
- Consumes: `transcriptPathFor`, `cwdFromLines`, `projectLabel`, `SCAN_LINES`.
- Produces on the wire:
  - `{"projs":{"items":[{"k":"<dirname>","n":"<label,22 chars>","c":<count>,"t":<secsSinceMidnight|-1>}]}}`
  - `{"projsess":{"k":"<dirname>","items":[{"id":"<12>","t":"<title,40>","n":<turns>,"w":<secs|-1>,"live":0|1}]}}`
  - tick gains `projectCount` and `sessionTotal` (integers).

- [ ] **Step 1: Add the failing assertions**

```js
check("the projects reply is built by its own function",
  /function buildProjectsReply/.test(HOST), true);
// ON DEMAND, NOT ON THE TICK. 132 sessions at ~150 bytes is ~20KB per 5s poll
// against a link measured at 6.6 KB/s - three seconds of radio every five, for a
// screen that is usually closed. Bound to the tick builder's body so a future
// edit that folds the inventory in fails here.
check("the tick payload does not carry the project inventory",
  !/buildProjectsReply|projsess/.test(body("buildTickPayload")), true);
check("project labels are ASCII-capped for the device",
  /deviceText\(/.test(body("buildProjectsReply")), true);
```

- [ ] **Step 2: Run and watch it fail**

Run: `node host/project-index-check.mjs`
Expected: FAIL — `the projects reply is built by its own function ... got false`

- [ ] **Step 3: Implement**

```js
// readdir + stat ONLY - no file reads - so 16 projects costs nothing. The name
// comes from the cwd inside ONE jsonl per project, never from decoding the
// directory name (see project-index.mjs).
async function buildProjectsReply() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch { return { projs: { items: [] } }; }
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d);
    let files = [];
    try { files = (await fsp.readdir(full)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    if (!files.length) continue;
    let newest = 0;
    for (const f of files) {
      try { newest = Math.max(newest, (await fsp.stat(path.join(full, f))).mtimeMs); } catch {}
    }
    const label = projectLabel(await cwdForProject(full, files)) || d;
    out.push({ k: d, n: deviceText(label, 22), c: files.length, t: secondsSinceMidnight(newest) });
  }
  out.sort((a, b) => b.c - a.c);
  return { projs: { items: out } };
}
```

`cwdForProject` reads `SCAN_LINES` lines of the newest `.jsonl` and passes them to `cwdFromLines`, caching by directory (the cwd of a project never changes).

`buildProjSessReply(key)` reads each `.jsonl`'s tail via the existing `transcriptInfo()` for its title and turn count, marks `live: 1` when the id is in the current list, sorts newest first, and caps at 60 with the true total stated.

Add to the tick payload object: `projectCount: <dirs with jsonl>`, `sessionTotal: <sum of c>`. Both are integers and together are ~20 bytes.

- [ ] **Step 4: Verify**

Run: `node host/project-index-check.mjs && node host/project-index-check.mjs --selftest && node host/wire-bytes-check.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add host/index.mjs host/project-index-check.mjs
git commit -m "The host can describe every project and its sessions, on demand

readdir plus stat for the project list - no file reads, so 16 projects costs
nothing - and JSONL tails only for the one project somebody opened. Deliberately
NOT on the tick: 132 sessions per 5s poll is ~20KB against a link measured at
6.6 KB/s, three seconds of radio every five for a screen usually closed. The
checker binds that to the tick builder's own body.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Device — the fourth tab, and a binding so its range cannot go stale

`TAB_COUNT` 3 → 4 and `PROJECTS` joins the enum between SESSIONS and SETTINGS. **`TAB 2` therefore stops meaning SETTINGS and starts meaning PROJECTS.** That is safe in code — every site uses `TAB_SETTINGS` symbolically and the `PAGE` refusal already prints `(int) TAB_SETTINGS`, so its own message self-updates — but CLAUDE.md's `TAB 0..2` is **unbound prose** today (`commands-check.mjs` asserts nothing about it), so this task adds the binding as well as the change.

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `enum Tab`, `TAB_COUNT`, `drawTabBar()`'s `labels[]`, the `TAB` verb's refusal text
- Modify: `CLAUDE.md` — the `TAB 0..2` row
- Modify: `firmware/deckhand_display/commands-check.mjs` — the new range assertion

**Interfaces:**
- Consumes: nothing.
- Produces: `TAB_PROJECTS` (enum value 2), `TAB_COUNT` = 4, and `renderProjectsTab()` / `handleProjectsTouch(int,int)` as empty stubs Task 5 fills.

- [ ] **Step 1: Add the failing assertion to `commands-check.mjs`**

```js
// CLAUDE.md's TAB range was UNBOUND PROSE until this existed - the PAGE row got
// its binding after going stale, and this is the same shape one verb over.
// Parsed from the firmware, never transcribed here.
{
  const m = /enum Tab \{([^}]*)\}/.exec(SRC);
  const n = m ? m[1].split(",").length : 0;
  const doc = /`TAB 0\.\.(\d+)`/.exec(claudeMd);
  assert(`CLAUDE.md's TAB range matches enum Tab (${n} tabs)`,
    !!doc && Number(doc[1]) === n - 1,
    `CLAUDE.md says TAB 0..${doc ? doc[1] : "?"}, enum Tab has ${n}`);
}
```

Add the matching `--selftest` fault: rewrite the doc string to `TAB 0..9` and assert it is caught.

- [ ] **Step 2: Run and watch it fail by name**

Run: `node firmware/deckhand_display/commands-check.mjs`
Expected: PASS today (3 tabs, `TAB 0..2`) — then it must FAIL the moment Step 3 lands, which is the point. Run `--selftest` now and confirm the injected `TAB 0..9` fault IS caught.

- [ ] **Step 3: Make the change**

```c
enum Tab { TAB_USAGE = 0, TAB_SESSIONS = 1, TAB_PROJECTS = 2, TAB_SETTINGS = 3 };
const int TAB_COUNT = 4;
```

In `drawTabBar()`: `const char* labels[TAB_COUNT] = {"USAGE", "SESSIONS", "PROJECTS", "SETTINGS"};`

Nothing else in the bar changes — `tabW = tabsW() / TAB_COUNT` and the `tabW - 16` underline both derive.

Update CLAUDE.md's row to `TAB 0..3`, and note in it that `2` is now PROJECTS.

- [ ] **Step 4: Verify**

```
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/commands-check.mjs --selftest
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=dio,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app" --output-dir /tmp/b2 firmware/deckhand_display
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --check 2
```
Then board 1 **separately** (never concurrently), and `--check 1`.

Both will report `CHANGED`, and unlike `SDPROBE`'s rodata-only movement this one moves `.flash.text`. Confirm with:
`xtensa-esp32-elf-size -A /tmp/b1/deckhand_display.ino.elf | grep -E "flash.text|rodata"`

Flash board 2 and `SCREENSHOT`: four tabs, labels not clipped, underline under the active one.

- [ ] **Step 5: Commit**

```bash
node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --update 1
node firmware/board-baseline.mjs /tmp/b2/deckhand_display.ino.bin --update 2
git add -A && git commit -m "A fourth tab, and its range stops being unbound prose

TAB_COUNT 3 -> 4. The arithmetic was checked before this was proposed: tab labels
draw with setUIFont(1) = T_META, the SMALL font, so PROJECTS is 64px in an 80px
slot on board 2 and 48px in 60px on board 1.

TAB 2 now means PROJECTS, not SETTINGS. Safe in code - every site uses
TAB_SETTINGS symbolically and PAGE's refusal prints (int) TAB_SETTINGS so its own
text self-updates - but CLAUDE.md's 'TAB 0..2' was unbound prose that nothing
checked, so commands-check now parses enum Tab and fails by name if the two
disagree. Same shape the PAGE row got after IT went stale.

Both binaries moved, and this one moves .flash.text, not just the refusal strings.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Device — PROJECTS level 1, the project list

**Files:**
- Create: `firmware/deckhand_display/projects.ino`
- Create: `firmware/deckhand_display/projects-geom-check.mjs`
- Modify: `firmware/deckhand_display/board_es3c35p.h` — the `PROJ_*` block
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `externs`, payload absorption for `projs`, `PROJFETCH` verb, `UNAVAILABLE_COMMANDS` entry

**Interfaces:**
- Consumes: the `projs` payload from Task 3.
- Produces: `ProjInfo { char key[64]; char name[24]; uint16_t count; long tod; }`, `projects[PROJ_SLOTS]`, `projectCount`, `renderProjectsTab()`, `handleProjectsTouch(int,int)`.

Constants for `board_es3c35p.h`, derived not chosen:

```c
#define PROJ_SLOTS 24          // >= the 16 measured, with headroom
const int PROJ_ROW_H   = 46;   // >= TAP_MIN, and T_BODY(16) + 2*15 padding
const int PROJ_ROW_GAP = 3;    // matches SESSION_ROW_GAP
const int PROJ_ROW_X   = SESSION_ROW_X;   // 12 - one left edge on this board
const int PROJ_ROW_W   = SESSION_ROW_W;   // 296
const int PROJ_ROW_Y0  = CONTENT_Y + 4;   // 50, matches SESSION_ROW_Y0
const int PROJ_STEP    = PROJ_ROW_H + PROJ_ROW_GAP;            // 49
const int PROJ_AVAIL   = BOARD_H - FOOTER_H - PROJ_ROW_Y0;     // 410
const int PROJ_ROWS    = (PROJ_AVAIL + PROJ_ROW_GAP) / PROJ_STEP;  // 8
```

- [ ] **Step 1: Write the failing geometry checker**

Create `projects-geom-check.mjs` on the pattern of `sessions-geom-check.mjs`: parse the `PROJ_*` constants out of the header with `geom-common.mjs`, then assert — each one able to fail:

```js
assert("the last project row fits above the footer",
  PROJ_ROW_Y0 + PROJ_ROWS * PROJ_STEP - PROJ_ROW_GAP <= BOARD_H - FOOTER_H,
  `${PROJ_ROW_Y0 + PROJ_ROWS * PROJ_STEP - PROJ_ROW_GAP} > ${BOARD_H - FOOTER_H}`);
assert("a project row is at least a fingertip", PROJ_ROW_H >= TAP_MIN, `${PROJ_ROW_H} < ${TAP_MIN}`);
assert("the name lane cannot overrun the count and time",
  PROJ_NAME_CHARS * T_BODY_ADV + PROJ_META_W <= PROJ_ROW_W - 2 * PROJ_PAD, "name lane overruns");
assert("PROJ_SLOTS covers what the host may send", PROJ_SLOTS >= 16, `${PROJ_SLOTS} < 16`);
```

`--selftest` injects `PROJ_ROW_H = 60` (last row overruns the footer) and `PROJ_ROW_H = 30` (below `TAP_MIN`), and exits 0 only when both are caught BY NAME.

- [ ] **Step 2: Run and watch it fail**

Run: `node firmware/deckhand_display/projects-geom-check.mjs`
Expected: FAIL — the `PROJ_*` constants do not exist yet.

- [ ] **Step 3: Implement**

Add the constants; write `projects.ino` with `drawProjectRow()` on the `drawIfChanged` discipline and a `projRowSigCache[]` keyed by display position, whose signature is `name|count|tod|live` — **every field that is drawn must be in the signature**, which is the rule the session row's title and Mac tag were both added under after shipping stale.

`PROJFETCH` requests the list; `UNAVAILABLE_COMMANDS[]` gets its board-1 refusal under the exact negation of the handler's guard.

- [ ] **Step 4: Verify**

```
node firmware/deckhand_display/projects-geom-check.mjs
node firmware/deckhand_display/projects-geom-check.mjs --selftest
node firmware/deckhand_display/commands-check.mjs
node firmware/deckhand_display/geom-sweep.mjs      # ~110s
```
Compile board 2, flash, `TAB 2`, `SCREENSHOT`. **Look at the capture** — on board 2 a screenshot vouches for the geometry the renderer composed and nothing else, so confirm the real glass too.

- [ ] **Step 5: Commit** (message states both binaries' movement and why)

---

### Task 6: Device — PROJECTS level 2, a project's sessions

**Files:**
- Modify: `firmware/deckhand_display/projects.ino` — the second level and its back affordance
- Modify: `firmware/deckhand_display/board_es3c35p.h` — `PSESS_*` constants
- Modify: `firmware/deckhand_display/projects-geom-check.mjs`
- Modify: `firmware/deckhand_display/deckhand_display.ino` — `projsess` absorption, `PROJOPEN <n>` verb

**Interfaces:**
- Consumes: the `projsess` payload from Task 3.
- Produces: `PSessInfo { char id[16]; char title[44]; uint16_t turns; long tod; uint8_t live; }`, `projLevel` (0 = projects, 1 = sessions), `projOpenKey[64]`.

Row height 56 (title 16 + gap 10 + meta 16 + 2×7 padding), giving `(410 + 3) / 59 = 7` rows.

- [ ] **Step 1** Add the level-2 assertions to the geometry checker (last row above the footer; title lane ≥ 24 characters; `PSESS_ROW_H >= TAP_MIN`), each with a `--selftest` fault.
- [ ] **Step 2** Run; expect FAIL by name.
- [ ] **Step 3** Implement the level, the back affordance, and `PROJOPEN <n>` — refusing BY NAME on a non-numeric argument, out of range (quoting the range), and PROJECTS not being the live tab.
- [ ] **Step 4** Run both checkers plus `commands-check`, compile, flash, `TAB 2` then `PROJOPEN 0`, `SCREENSHOT`.
- [ ] **Step 5** Commit.

---

### Task 7: Device — a dead session opens in the existing scrollback, and RESUME

The payoff: no new reader. `requestScrollback()` already fetches, wraps, indexes and renders; this task only points it at an id that is not in `sessions[]`.

**Files:**
- Modify: `firmware/deckhand_display/projects.ino` — tap handler on a level-2 row
- Modify: `firmware/deckhand_display/scrollback.ino` — accept an id directly rather than only a `sessions[]` index
- Modify: `host/index.mjs` — the `RESUME` path

**Interfaces:**
- Consumes: `transcriptPathFor` (Task 2), `PSessInfo` (Task 6).
- Produces: `scrollOpenById(const char* id12, const char* title)`.

- [ ] **Step 1** Assert in `scrollback-check.mjs` that `scrollOpenById` exists and that `scrollLoadedId` is set from its argument, not from `sessions[detailIndex].id` — bound to the function body.
- [ ] **Step 2** Run; expect FAIL by name.
- [ ] **Step 3** Implement. **`RESUME` must state what it does**: the host runs `claude -p --resume <id> <text>`, a HEADLESS turn — it does not open a session on the Mac. The screen says so; the spec requires it.
- [ ] **Step 4** Flash, open a real dead session from PROJECTS, read it on the glass, and confirm the log shows a `Scrollback:` line for an id absent from the live list.
- [ ] **Step 5** Commit.

---

### Task 8: Device — SESSIONS stops letting rows vanish

Last and least: no change to the row shape, the ranking or the colours.

**Files:**
- Modify: `claude-hooks/deckhand-session-hook.mjs:648` — mark ended instead of deleting
- Modify: `host/index.mjs` — retire an ended record after the grace period
- Modify: `firmware/deckhand_display/sessions.ino` — the ghost row and the floating count line
- Modify: `firmware/deckhand_display/sessions-geom-check.mjs`

**Interfaces:**
- Consumes: `projectCount` / `sessionTotal` from Task 3.
- Produces: nothing later tasks use.

- [ ] **Step 1: Add the failing assertions**

```js
// The count line FLOATS under the last row - that is what makes it free. At a
// fixed y it would cost a row permanently and a 5-row list cannot spare one.
assert("the count line is positioned from the last row, not a constant",
  /countLineY\s*\(/.test(fnBody(SRC, "renderSessionsTab")), "count line uses a fixed y");
assert("a ghost row's dot is COLOR_UNKNOWN", /COLOR_UNKNOWN/.test(fnBody(SRC, "drawSessionRow")),
  "ghost row does not force the unknown colour");
// THE TRAP: the dot colour is NOT in the row signature, so an ended row whose
// status text still compared equal would keep its live colour. Same rule that
// put the title and the Mac tag in this signature, both after shipping stale.
assert("ended-ness is IN the row signature",
  /ended/.test(fnBody(SRC, "renderSessionsTab").match(/snprintf\(sig[^;]*;/)?.[0] ?? ""),
  "a colour-only change would not repaint the row");
```

- [ ] **Step 2** Run; expect three FAILs by name.
- [ ] **Step 3** Implement: the hook writes `status:"ended"` and leaves the file; the host retires it after the grace period; `drawSessionRow` draws a dashed border and `ended Nm ago` for it; `countLineY()` returns the y below the last drawn row, and the line is drawn only when `sessionTotal > sessionCount`.
- [ ] **Step 4** Run `sessions-geom-check.mjs` and its `--selftest`, `geom-sweep.mjs`, compile both boards, flash, end a session and watch the row go dashed rather than vanish, then `SCREENSHOT`.
- [ ] **Step 5** Commit.

---

## Self-Review

**Spec coverage.** Fourth tab → Task 4. PROJECTS level 1 → Task 5. Level 2 → Task 6. Reading via the existing scrollback → Task 7. RESUME-is-headless → Task 7. Ghost row and count line → Task 8. The `transcriptById` gap → Task 2. On-demand-not-on-the-tick → Task 3. Board 1 refusals → Tasks 5 and 6. The `projects=16 sessions=132` tick field → Task 3, consumed in Task 8.

**Not covered, deliberately:** the spec's risk 1 (a project with 500 sessions) is handled only by Task 3's cap-at-60-and-state-the-total. A pager for level 2 is not in this plan; if a project passes 60 sessions before that lands, the list states the truth and stops, which is honest but not complete.

**Type consistency.** `pickTranscript` / `cwdFromLines` / `projectLabel` (Task 1) are used under those exact names in Tasks 2 and 3. `transcriptPathFor` (Task 2) is used in Task 7. `ProjInfo` / `PSessInfo` field names match between Tasks 5, 6 and 7. `TAB_PROJECTS` (Task 4) is used in Tasks 5 and 6.

**Placeholders:** none. Every code step carries the code; every verification step carries the exact command and the expected result.
