# USAGE per Claude account - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each Claude account gets its own USAGE figures, bars, sparkline and burn, never mixed. A tap (or `USAGEACCT <n>`) switches which account is shown.

**Architecture:** The host publishes `acct` (an 8-hex SHA-256 prefix of `oauthAccount.accountUuid`) and an optional `acctTag`. The device groups `hostLinks[]` into accounts (equal non-empty `acct`, else one account per link), merges freshest-wins only WITHIN an account, and shows the selected account. Board 2's trend ring becomes one ring per account.

**Tech Stack:** Arduino C++ (ESP32 / ESP32-S3, one concatenated translation unit of `.ino` files), Node ESM host, offline checkers in Node and Python.

**Spec:** `docs/superpowers/specs/2026-10-03-usage-per-account-design.md` - read it first.

**Worktree:** `/Users/yujia/projects/deckhand-usage-per-account`, branch `usage-per-account`. All paths below are relative to it. The main checkout has the user's unrelated uncommitted work - never touch `/Users/yujia/projects/deckhand`.

## Global Constraints

- **Read `CLAUDE.md` in the worktree before any firmware edit.** Its rules are binding. The ones that bite here: fonts are ASCII `0x20..0x7E` only; every field redraws only when its value changes, through a cache; board flags are `#define`, never `const int`, because `#if` on a const is silently false; the `.ino` files are one translation unit, concatenated `deckhand_display.ino` first and then the rest alphabetically; `processCompletedLine` takes `buf` by reference, so every early `return` in a handler sets `buf = ""` first; every refusal names its cause.
- **NO COMMITS.** `CLAUDE.md`: "Commit or push only when asked." At the end of each task the controller runs `git add -A` (staging only) after review, so the next task's diff is `git diff`.
- **Never compile both boards concurrently** (they share one arduino-cli cache). A compile takes about 3 minutes, so use `timeout: 600000`. Never use `./flash.sh --no-compile` unless the last compile was the same board.
- **Never open a serial connection to the device.** Drive it only by writing a line to `~/.claude/deckhand-device-command`.
- The raw `accountUuid`, the email and the display name never leave the Mac. Only the 8-hex hash and an explicit user-set `DECKHAND_ACCOUNT_TAG` cross the wire.
- A link with no `acct` is its own account and is never merged with another link.
- Checkers PARSE what they certify, never transcribe it. Every new checker has `--selftest`, which injects a fault into the real source text and exits 0 only when that fault is caught. Mirror results and structural results are reported separately.

## Review Focus

1. **Two old hosts on the same account** (no `acct` from either): they must show as two accounts, each with its own figures, and never merge into one. Pinned in Task 2's mirror test `no-acct links never merge`.
2. **The selected account's Mac drops off** (link pruned after 21s): selection falls back to account 0 in the SAME tick, and no figure from the departed Mac stays on screen. Pinned in Task 2's mirror test `selected account leaves -> falls back` and in Task 6's freeze acceptance.
3. **Slot reuse:** a Mac disconnects and a different Mac lands in the same slot. Selection is by key, so it must not silently follow the slot. Pinned in Task 2's mirror test `selection follows key, not slot`.
4. **The Codex row under a two-account view:** account B has no Codex reading and account A does. Showing B must hide the Codex row, not show A's. Pinned in Task 2's structural assertion `no cross-account Codex fallback` and its mirror test.
5. **Double delivery of `USAGEACCT 1`** (cabled board gets it twice): the second copy re-selects the same account, which is a no-op, and must not toggle back. Pinned by Task 3's use of an absolute index, plus its on-glass check in Task 6.

---

### Task 1: Host publishes `acct` and `acctTag`

**Files:**
- Create: `host/account-id.mjs`
- Create: `host/account-id-check.mjs`
- Modify: `host/index.mjs`, in four places: near line 551 (`hostTag`), a new periodic refresh beside `pollOauthUsage` (~line 1036), the payload at ~line 5899, and the tick log line at ~line 5936

**Interfaces:**
- Produces: `export function accountKey(claudeJson: object|null|undefined): string` returns 8 lowercase hex chars or `""`. The payload gains `acct` (only when non-empty) and `acctTag` (only when `DECKHAND_ACCOUNT_TAG` is set). The tick log gains `acct=<key|?>`.

- [ ] **Step 1: Write the failing checker** `host/account-id-check.mjs`:

```js
// Run: node host/account-id-check.mjs [--selftest]
// Imports nothing that touches CoreBluetooth, so plain node is safe here.
import fs from "fs";
import { accountKey } from "./account-id.mjs";

const SELFTEST = process.argv.includes("--selftest");
const UUID = "3f1c9a2e-7b44-4c1d-9e0a-5d2b8f6a1c33";

function run(fn) {
  let failed = 0;
  const eq = (got, want, what) => {
    if (got === want) return;
    if (!SELFTEST) console.error(`FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    failed++;
  };
  const k = fn({ oauthAccount: { accountUuid: UUID, emailAddress: "a@b.c" } });
  eq(/^[0-9a-f]{8}$/.test(k), true, "8 lowercase hex chars");
  eq(fn({ oauthAccount: { accountUuid: UUID } }), k, "deterministic");
  eq(fn({ oauthAccount: { accountUuid: UUID.toUpperCase() } }) === k, false,
     "the UUID is hashed as-is, so a case change is a different input (no silent normalising)");
  eq(fn({ oauthAccount: { accountUuid: "other" } }) === k, false, "different accounts differ");
  eq(fn(null), "", "null file");
  eq(fn({}), "", "no oauthAccount");
  eq(fn({ oauthAccount: {} }), "", "no accountUuid");
  eq(fn({ oauthAccount: { accountUuid: "" } }), "", "empty accountUuid");
  eq(fn({ oauthAccount: { accountUuid: 42 } }), "", "non-string accountUuid");
  // NO PLAINTEXT LEAK: no 4+ char run of the UUID's own hex may appear verbatim.
  // A hash prefix shares short runs by chance; 8 contiguous chars would mean a slice.
  const hex = UUID.replace(/-/g, "");
  let leak = false;
  for (let i = 0; i + 8 <= hex.length; i++) if (k.includes(hex.slice(i, i + 8))) leak = true;
  eq(leak, false, "no 8-char slice of the raw UUID");
  return failed;
}

if (SELFTEST) {
  // THE FAULT: a key that is just the UUID's first 8 hex chars, which passes every
  // shape test and leaks the identity. The checker must catch it by name.
  const leaky = (j) => (j?.oauthAccount?.accountUuid || "").replace(/-/g, "").slice(0, 8);
  const caught = run(leaky) > 0;
  // ...and the structural half: index.mjs must publish accountKey's output, never the raw field.
  const src = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const faulted = src.replace(/accountKey\(/g, "(j)=>j?.oauthAccount?.accountUuid;(");
  const structCaught = !structuralOk(faulted);
  console.log(caught && structCaught ? "account-id --selftest: faults caught - PASS"
                                     : "account-id --selftest: a fault went UNCAUGHT - FAIL");
  process.exit(caught && structCaught ? 0 : 1);
}

function structuralOk(src) {
  // Published from accountKey(), and the raw field is never put on the wire or in the log.
  return /accountKey\(/.test(src) && !/accountUuid\s*[,}]/.test(src.replace(/\/\/.*$/gm, ""));
}

const mirrorFailed = run(accountKey);
const src = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const structFailed = structuralOk(src) ? 0 : 1;
if (structFailed) console.error("FAIL structural: index.mjs must publish accountKey() output and never accountUuid itself");
console.log(`account-id: mirror ${mirrorFailed ? "FAILED" : "ok"}, structural ${structFailed ? "FAILED" : "ok"}`);
process.exit(mirrorFailed || structFailed ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail.** `node host/account-id-check.mjs` should fail with `Cannot find module ... account-id.mjs`.

- [ ] **Step 3: Implement** `host/account-id.mjs`:

```js
// The account a Mac's quota belongs to, as a short opaque key. Two Macs signed into
// the SAME Claude account publish the same key, which is how the device knows their
// readings are one quota measured twice rather than two quotas. HASHED, never the
// raw id: the BLE link is unencrypted, and the device only needs equality.
import { createHash } from "crypto";

export function accountKey(claudeJson) {
  const id = claudeJson?.oauthAccount?.accountUuid;
  if (typeof id !== "string" || !id) return "";
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}
```

- [ ] **Step 4: Wire it into `host/index.mjs`.**
  - Import `accountKey` beside `macTag`.
  - Beside `hostTag` (~line 551), add:
    ```js
    // Which Claude account this Mac polls - see host/account-id.mjs. Refreshed at the
    // OAuth cadence, not per tick: ~/.claude.json can run to megabytes.
    let acctKey = "";
    // A person's own name for the account ("work"), sanitised and capped exactly like
    // a DECKHAND_MAC_TAG override. Unset = the device names the account by its Mac.
    const acctTag = process.env.DECKHAND_ACCOUNT_TAG ? macTag("", process.env.DECKHAND_ACCOUNT_TAG) : "";
    async function refreshAccountKey() {
      try {
        acctKey = accountKey(JSON.parse(await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8")));
      } catch { acctKey = ""; }
    }
    ```
    First check that `macTag("", override)` returns the sanitised override (see `host/host-tag.mjs` and `host-tag-check.mjs`'s `"studio-b"` case). If an empty hostname short-circuits, pass `"x"` as the hostname.
  - Where `pollOauthUsage()` is first scheduled at startup, also run `refreshAccountKey()` once and then `setInterval(refreshAccountKey, OAUTH_POLL_INTERVAL_MS)`. It does its own scheduling, independent of the OAuth back-off, which can return early for 15 minutes.
  - Payload (~line 5899): after `hostTag`, add `...(acctKey ? { acct: acctKey } : {}), ...(acctTag ? { acctTag } : {}),`.
  - Tick log (~line 5936): after the `src=${usage.quotaSource} ` term, add `` `acct=${acctKey || "?"} ` +``. `mac-app/DeckhandMenuBar.swift` parses by key (`field(line, "qage=")`), so a new key is safe. Confirm no existing key ends in `acct=`.

- [ ] **Step 5: Run the checks.** All of these must pass:
  - `node host/account-id-check.mjs`
  - `node host/account-id-check.mjs --selftest`
  - `node host/host-tag-check.mjs`
  - `node host/wire-bytes-check.mjs`
  - `node --check host/index.mjs`
  - `node -e 'import("./host/account-id.mjs").then(m=>{const j=JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.claude.json","utf8"));console.log(m.accountKey(j))})'`, which prints this Mac's real 8-hex key.

  If `wire-bytes-check` budgets the payload size, the two optional fields must fit its budget. Read it, and update its parsed inputs rather than a literal.

- [ ] **Step 6: Stop for review.** Report the diff (`git diff`) and the outputs. Do not commit.

---

### Task 2: Device groups links into accounts (both boards)

**Files:**
- Modify: `firmware/deckhand_display/deckhand_display.ino`: `HostLink` (~line 871) gains two fields; the hostTag parse (~line 5085) parses them; the usage parse (~lines 5558-5571) writes the link, not the global
- Modify: `firmware/deckhand_display/usage.ino`: lines ~51-153 (`usageSourceLink`, `usagePinHostId`, `mergeUsage()`, `usageCyclePin()`)
- Modify: `firmware/deckhand_display/deckhand_display.ino` ~line 4707-4722 (the USAGE tap)
- Create: `firmware/deckhand_display/usage-account-check.mjs`

**Interfaces:**
- Consumes: payload fields `acct`, `acctTag` (Task 1).
- Produces, for Tasks 3 and 4: `HostLink.acct[12]`, `HostLink.acctTag[8]`, `int usageAcctCount`, `int usageAcctSelIdx` (-1 when none), `int usageAcctFirstLink[MAX_LINKS]`, `Usage usageAcct[MAX_LINKS]` (each account's merged reading), `char usageAcctSel[14]`, `void accountKeyFor(int link, char* out, size_t n)`, `bool linksShareAccount(int a, int b)`, `bool usageCycleAccount()`, `bool usageSelectAccount(int idx)`. `usageSourceLink`/`cxSourceLink` keep their meaning: the links supplying the SELECTED account's figures.

- [ ] **Step 1: Write the failing checker** `usage-account-check.mjs`. Follow `commands-check.mjs`'s conventions: import `fnBody`, `stripComments` from `./geom-common.mjs` (read that file for the exact signatures), take `--selftest`, and report the mirror and structural halves separately.
  - **Mirror:** a JS re-implementation of the grouping, selection and freshest-wins rules below, run against these cases:
    - same acct on 2 links merges, and the fresher age wins;
    - a negative age never beats a real one;
    - no-acct links never merge (Review Focus 1);
    - different acct gives 2 accounts;
    - selection follows key, not slot (Review Focus 3);
    - selected account leaves -> falls back to 0 (Review Focus 2);
    - account B with no Codex gives cxSource = -1 even when account A has Codex (Review Focus 4);
    - fewer than 2 accounts makes cycle return false.
  - **Structural**, bound to `fnBody(src, "void mergeUsage(")` and `fnBody(src, "bool usageCycleAccount(")`:
    - (a) `mergeUsage` calls `linksShareAccount(` inside its freshest loop;
    - (b) `mergeUsage` contains no `usagePinHostId`, and `usagePinHostId` appears nowhere in the stripped source;
    - (c) the Codex selection is inside the same `linksShareAccount` guard as the Claude one. Assert that no `bestCx = ` assignment in `mergeAccount` happens outside a block guarded by `linksShareAccount`. The simplest form: `mergeAccount`'s body has exactly one loop, and that loop's first statement is the `linksShareAccount` `continue`;
    - (d) `mergeUsage` clears the Claude fields when there is no Claude source (`usage.fiveHourPct = -1` reached on the `best < 0` path);
    - (e) the payload parse in `deckhand_display.ino` assigns `hostLinks[curLink].usage` from a local, and does not write `usage.fiveHourPct =` directly. Bind this to the block between `doc["fiveHourPct"]` and `mergeUsage();`.
  - **`--selftest`** applies each of these edits to the real source text and requires each one to be caught by name:
    1. delete the `linksShareAccount` guard;
    2. restore a Codex fallback `if (bestCx < 0) bestCx = best;`;
    3. delete the clear-on-no-source.

- [ ] **Step 2: Run it.** `node firmware/deckhand_display/usage-account-check.mjs` must FAIL, with the structural assertions failing by name.

- [ ] **Step 3: Add the HostLink fields** after `emoji[12]`:

```cpp
  // Which Claude account this Mac's quota belongs to: the host's 8-hex hash of its
  // accountUuid ("acct"), "" from a host too old to send one. Two links are ONE
  // account only when both are non-empty and equal - see linksShareAccount().
  char  acct[12] = "";
  // The person's own name for that account (DECKHAND_ACCOUNT_TAG), "" = unnamed.
  char  acctTag[8] = "";
```

Parse beside `hostTag`/`hostEmoji` (~line 5086):

```cpp
    copyField(hostLinks[curLink].acct, sizeof(hostLinks[curLink].acct), doc["acct"] | "");
    copyField(hostLinks[curLink].acctTag, sizeof(hostLinks[curLink].acctTag), doc["acctTag"] | "");
```

- [ ] **Step 4: The parse writes the LINK, not the global** (~lines 5558-5571). Replace each `usage.X = ...` with `u.X = ...` on a local `Usage u;`, then:

```cpp
  // Park this Mac's own reading in its link and derive the global `usage` from the
  // SELECTED account only - see mergeUsage(). Writing the global here first is what
  // let a tick with no source leave the last-parsed payload on screen. A host with no
  // hostId (curLink < 0) predates multi-Mac and has no link to park in, so it still
  // drives the global directly.
  if (curLink >= 0) hostLinks[curLink].usage = u;
  else usage = u;
  mergeUsage();
```

Before changing anything here, **diagnose the open freeze bug** (`docs/reference/pairing-and-multi-mac.md`, "OPEN BUG") with superpowers:systematic-debugging. Read `pruneStaleLinks()` and confirm or rule out this suspect: `mergeUsage()` only overwrites `usage` when `best >= 0`. Record what you find, since Task 5 writes it into that doc entry. If the cause is something else, fix that too and say so.

- [ ] **Step 5: Replace `usagePinHostId`/`mergeUsage()`/`usageCyclePin()`** in `usage.ino` (lines ~51-153) with:

```cpp
// Which link (Mac) supplied the SELECTED account's figures - see mergeUsage().
// -1 means that account has no usable reading for that source.
int usageSourceLink = -1;
int cxSourceLink = -1;

// ---------- Accounts ----------
// The two Macs this device serves may be signed into DIFFERENT Claude accounts, and
// then their quotas are two numbers, not one number measured twice. The host names
// the account (`acct`, an opaque hash); two links are one account only when BOTH name
// one and the names agree. A link with no `acct` is its own account: merging two Macs
// on a guess would show one account's quota under the other's name, which is the
// defect this exists to remove. Two OLD hosts on one account therefore show as two
// accounts until updated - visible and harmless, unlike a silent mix.
bool linksShareAccount(int a, int b) {
  if (a == b) return true;
  const char* x = hostLinks[a].acct;
  const char* y = hostLinks[b].acct;
  return x[0] && y[0] && strcmp(x, y) == 0;
}
// The account's identity as one string. '@' + hostId for an acct-less link: '@' is
// not a hex digit, so it can never equal a real acct (MULTITEST's hostId "feedfeed"
// is valid hex and would otherwise collide with an acct of the same spelling).
void accountKeyFor(int link, char* out, size_t n) {
  if (hostLinks[link].acct[0]) strlcpy(out, hostLinks[link].acct, n);
  else snprintf(out, n, "@%s", hostLinks[link].hostId);
}

int   usageAcctCount = 0;
int   usageAcctFirstLink[MAX_LINKS];   // lowest-slot link of each account, slot order
Usage usageAcct[MAX_LINKS];            // each account's own merged reading
int   usageAcctSrc[MAX_LINKS];         // ...and the links that supplied it
int   usageAcctCxSrc[MAX_LINKS];
int   usageAcctSelIdx = -1;            // index into the above; -1 = no account
// The selected account BY IDENTITY, not by index: a slot is reused when a link drops
// and another Mac connects, and an index would silently follow whoever landed there.
// "" = the first account, which is also what a reboot lands on.
char  usageAcctSel[14] = "";           // '@' + an 11-char hostId + NUL fits in 13

static bool usageHasClaude(const Usage& u) { return u.fiveHourPct >= 0 || u.sevenDayPct >= 0; }

// Freshest reading per source WITHIN account a. Claude by quotaAgeSec, Codex
// independently by cxAgeSec. A negative age means "never measured" and must never win
// against a real reading, which a plain comparison on -1 would let it do.
static void mergeAccount(int a) {
  int rep = usageAcctFirstLink[a], best = -1, bestCx = -1;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used || !linksShareAccount(rep, i)) continue;
    const Usage& u = hostLinks[i].usage;
    if (usageHasClaude(u)) {
      if (best < 0 || (u.quotaAgeSec >= 0 &&
          (hostLinks[best].usage.quotaAgeSec < 0 ||
           u.quotaAgeSec < hostLinks[best].usage.quotaAgeSec))) best = i;
    }
    if (u.cxPct >= 0) {
      if (bestCx < 0 || (u.cxAgeSec >= 0 &&
          (hostLinks[bestCx].usage.cxAgeSec < 0 ||
           u.cxAgeSec < hostLinks[bestCx].usage.cxAgeSec))) bestCx = i;
    }
  }
  Usage m;   // defaults are the "no reading" sentinels
  if (best >= 0) {
    const Usage& u = hostLinks[best].usage;
    m.fiveHourPct = u.fiveHourPct;      m.fiveHourResetInMin = u.fiveHourResetInMin;
    m.sevenDayPct = u.sevenDayPct;      m.sevenDayResetInMin = u.sevenDayResetInMin;
    m.sessionTokens = u.sessionTokens;  m.weekAllTokens = u.weekAllTokens;
    m.weekFableTokens = u.weekFableTokens; m.weekFablePct = u.weekFablePct;
    m.quotaAgeSec = u.quotaAgeSec;
  }
  // NO CROSS-ACCOUNT FALLBACK for Codex. The old pin borrowed another Mac's Codex
  // reading when the pinned Mac had none; with two accounts that puts one person's
  // Codex under the other account's header. An account with no Codex hides the row.
  if (bestCx >= 0) {
    const Usage& u = hostLinks[bestCx].usage;
    m.cxPct = u.cxPct;  m.cxResetInMin = u.cxResetInMin;
    m.cxWindowMin = u.cxWindowMin;  m.cxAgeSec = u.cxAgeSec;
  }
  usageAcct[a] = m;
  usageAcctSrc[a] = best;
  usageAcctCxSrc[a] = bestCx;
}

void mergeUsage() {
  // Distinct accounts, in slot order, among links with ANY reading - a Mac that has
  // measured nothing yet would only add an empty page to the tap cycle.
  usageAcctCount = 0;
  for (int i = 0; i < MAX_LINKS; i++) {
    if (!hostLinks[i].used) continue;
    const Usage& u = hostLinks[i].usage;
    if (!usageHasClaude(u) && u.cxPct < 0) continue;
    bool seen = false;
    for (int a = 0; a < usageAcctCount; a++)
      if (linksShareAccount(usageAcctFirstLink[a], i)) { seen = true; break; }
    if (!seen) usageAcctFirstLink[usageAcctCount++] = i;
  }
  for (int a = 0; a < usageAcctCount; a++) mergeAccount(a);

  // The selection, by key. A selected account that has gone falls back to the first
  // in the SAME call - leaving it would hold a departed Mac's frozen numbers on screen.
  int sel = usageAcctCount > 0 ? 0 : -1;
  if (usageAcctSel[0]) {
    int found = -1;
    char k[14];
    for (int a = 0; a < usageAcctCount; a++) {
      accountKeyFor(usageAcctFirstLink[a], k, sizeof(k));
      if (strcmp(k, usageAcctSel) == 0) { found = a; break; }
    }
    if (found >= 0) sel = found; else usageAcctSel[0] = '\0';
  }
  usageAcctSelIdx = sel;

  // No Mac at all: leave `usage` alone. A host with no hostId drives it directly
  // (see the parse), and the no-host screen owns this state.
  if (usedLinkCount() == 0) { usageSourceLink = cxSourceLink = -1; return; }
  Usage none;
  const Usage& m = sel >= 0 ? usageAcct[sel] : none;
  usageSourceLink = sel >= 0 ? usageAcctSrc[sel] : -1;
  cxSourceLink    = sel >= 0 ? usageAcctCxSrc[sel] : -1;
  // Whole-struct copy, so a source that vanished CLEARS its figures rather than
  // leaving the last-parsed payload's numbers on screen.
  usage = m;
}

// Tap the content area to show the NEXT account's own figures. Returns true only
// when the page actually moved, so the caller repaints nothing otherwise. Inert below
// two accounts - two Macs on one account are one page, as they should be.
bool usageCycleAccount() {
  if (usageAcctCount < 2) return false;
  return usageSelectAccount((usageAcctSelIdx + 1) % usageAcctCount);
}
// Select account idx by key. Idempotent, so USAGEACCT's double delivery is harmless.
// Returns false only for an out-of-range idx.
bool usageSelectAccount(int idx) {
  if (idx < 0 || idx >= usageAcctCount) return false;
  accountKeyFor(usageAcctFirstLink[idx], usageAcctSel, sizeof(usageAcctSel));
  return true;
}
```

Check before keeping this: `Usage` has default member initialisers (it does: `int fiveHourPct = -1;` etc.), so `Usage m;` and `Usage none;` start as "no reading". Check that `usedLinkCount()` is declared before `usage.ino` in concatenation order; it is a `deckhand_display.ino` function, and that file comes first. Check that `linkForHost` is still used elsewhere before deleting anything around it. Do not delete it.

- [ ] **Step 6: The tap handler** (~deckhand_display.ino:4707). Rename the call to `usageCycleAccount()`. Rewrite the comment: a tap pages between ACCOUNTS, it is inert below two, and the repaint still goes through `renderUsageTab()`'s own bust.

- [ ] **Step 7: Fix every other `usagePinHostId` reference** (`grep -n usagePinHostId firmware/deckhand_display/*.ino`): the chrome at usage.ino ~213/225 and the bust at ~1104/1140. Make the minimal edit that compiles and change no drawing yet; Task 3 owns the chrome. For now `pinNow` becomes `0` and the `if (usagePinHostId[0])` bar draw is deleted.

- [ ] **Step 8: Run the checks.** `node firmware/deckhand_display/usage-account-check.mjs` and `--selftest` both pass. Also run every firmware checker in `CLAUDE.md`'s "Verification discipline" block. A pre-existing checker that asserted the pin (grep the checkers for `usagePinHostId`/`usageCyclePin`) must be updated to assert the account rule instead, never deleted outright.

- [ ] **Step 9: Compile board 1, then board 2, sequentially.** Use `--output-dir /tmp/b1` and `/tmp/b2`, the FQBNs from `CLAUDE.md`, and `timeout: 600000`. Both must compile with no new warnings. Do not baseline yet.

- [ ] **Step 10: Stop for review.** Report the diff, the checker outputs, both compile summaries, and the freeze-bug diagnosis (cause, evidence, what fixed it).

---

### Task 3: The glass, and the `USAGEACCT` verb (both boards)

**Files:**
- Modify: `firmware/deckhand_display/usage.ino`: `drawCardChrome` (~line 164-230), the bust (~line 1100-1160), the callers of `linkTag(usageSourceLink)` at ~1221-1225, and `renderCodexRow`'s tag (~line 928)
- Modify: `board_e32r28t.h`, `board_es3c35p.h`: add `#define BOARD_USAGE_ACCT_INDEX`, remove `CARD_PIN_BAR_Y`
- Modify: `usage-geom-check.mjs`, `docs/design/adaptive-sources/adaptive.html`, `docs/design/usage-redesign/usage.js`: drop `CARD_PIN_BAR_Y`, add the N/M fit proof
- Modify: `deckhand_display.ino`: the `USAGEACCT` handler, beside `TAB ` (~line 7432); `MULTITEST`'s payload (~line 9106)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: `const char* usageAcctLabel()` (the selected account's label), and the device verb `USAGEACCT <n>`.

- [ ] **Step 1: Write the failing assertions.**
  - In `usage-geom-check.mjs`, on every board whose header has `BOARD_USAGE_ACCT_INDEX 1`, assert that the widest Claude-card label, plus a gap, plus the widest account indicator, fits inside `CARD_X + PAD .. CARD_X + CARD_W - PAD` at that board's `T_META` advance. Parse the labels from the `drawCardChrome(` call sites. The widest indicator is the 6-char tag cap plus `" 2/2"`, or the icon (`MAC_EMOJI_SIZE`) plus a gap plus `"2/2"`. On board 1, assert the flag is `0`.
  - In `usage-account-check.mjs`, add these structural checks:
    - `drawCardChrome` gates the label on `usageAcctCount > 1`, not `usedLinkCount() > 1`;
    - the bust tuple contains an account term (`usageAcctSelIdx` or `usageAcctCount`) on BOTH arms of its `#if BOARD_USAGE_V2`;
    - `renderCodexRow` takes its tag from `cxSourceLink`, which is now per-account.
  - Add selftest faults for each: revert the gate, and drop the account term from one arm.
  - Run both checkers and see them FAIL.

- [ ] **Step 2: Add the board flags.** In `board_es3c35p.h`: `#define BOARD_USAGE_ACCT_INDEX 1` if Step 1's arithmetic says it fits, else `0` with a comment quoting the overflow in pixels. In `board_e32r28t.h`: `#define BOARD_USAGE_ACCT_INDEX 0`, with a comment citing the x=154/170 collision `usage.ino` already records. Use `#define`, never `const int` (`CLAUDE.md`).

- [ ] **Step 3: The label.** In `usage.ino`:

```cpp
// The SELECTED account's name: the person's own DECKHAND_ACCOUNT_TAG when its Mac
// published one, else the source Mac's tag - with one Mac per account (today's
// MAX_LINKS) the Mac IS the account, so its tag already says which one.
const char* usageAcctLabel() {
  int src = usageSourceLink >= 0 ? usageSourceLink
          : (usageAcctSelIdx >= 0 ? usageAcctFirstLink[usageAcctSelIdx] : -1);
  if (src < 0) return "";
  return hostLinks[src].acctTag[0] ? hostLinks[src].acctTag : linkTag(src);
}
```

In `drawCardChrome`:
- Replace the `usedLinkCount() > 1` gate with `usageAcctCount > 1`.
- When the source link has an `acctTag`, draw the text label even if the Mac has an icon. The person named the account, and the name is what tells two accounts apart.
- Always draw in `COLOR_LABEL`, since there is no pinned/auto distinction left.
- Delete the pin bar.
- Under `#if BOARD_USAGE_ACCT_INDEX`, draw `"%d/%d"` (`usageAcctSelIdx + 1`, `usageAcctCount`) immediately left of the label or icon, TR-aligned, only when `usageAcctCount > 1`.

The call sites at ~1221-1225 pass `usageAcctLabel()` instead of `linkTag(usageSourceLink)`. The ASCII-only font rule applies to everything drawn.

- [ ] **Step 4: The bust.** In both arms (~1100-1160):
  - Replace `pinCache`/`pinNow` with `acctCache`/`acctNow`, where `acctNow = usageAcctSelIdx * 8 + usageAcctCount`. That one int changes on a switch and on an account arriving or leaving.
  - Replace `linksNow = usedLinkCount()` with `usageAcctCount`, because the label is now gated on accounts. Keep `linksCache` only if something else still reads `usedLinkCount()` on this card.
  - Rewrite the "PIN state belongs in this bust" comment for accounts.

- [ ] **Step 5: Remove `CARD_PIN_BAR_Y`** from both headers, `usage-geom-check.mjs`, and the two design mocks. Then run `node docs/design/*/check.mjs`; each must pass.

- [ ] **Step 6: The verb.** Add this beside `TAB ` in `processCompletedLine`:

```cpp
  } else if (buf.startsWith("USAGEACCT")) {
    // SELECTS WHICH CLAUDE ACCOUNT THE USAGE TAB SHOWS, so a capture can see an
    // account other than the first - nothing on the Mac can tap the card. An
    // ABSOLUTE index, never "next": the host delivers every command over both
    // transports, and a relative step would toggle there and back on a cabled board.
    // Idempotent, so it is not deduped.
    String arg = buf.length() > 9 ? buf.substring(9) : String("");
    arg.trim();
    bool surfaceUp = composeActive || readerActive || histActive;
#if BOARD_HISTORY_SCROLL
    surfaceUp = surfaceUp || scrollActive;
#endif
    if (surfaceUp) {
      Serial.println("USAGEACCT refused: a full-screen surface is up (the USAGE cards are "
                     "underneath it)");
      buf = "";
      return;
    }
    if (currentTab != TAB_USAGE) {
      Serial.println("USAGEACCT refused: USAGE is not the live tab (send TAB 0 first)");
      buf = "";
      return;
    }
    bool numeric = arg.length() > 0;
    for (unsigned int i = 0; i < arg.length(); i++)
      if (arg[i] < '0' || arg[i] > '9') numeric = false;
    if (!numeric || !usageSelectAccount(arg.toInt())) {
      if (usageAcctCount == 0)
        Serial.printf("USAGEACCT refused: \"%s\" - there are no accounts with a reading yet\n",
                      arg.c_str());
      else
        Serial.printf("USAGEACCT refused: \"%s\" is not an account index (0..%d)\n",
                      arg.c_str(), usageAcctCount - 1);
      buf = "";
      return;
    }
    mergeUsage();
    renderUsageTab();
    Serial.printf("USAGEACCT %d/%d key=%s label=%s src=%d\n", usageAcctSelIdx,
                  usageAcctCount, usageAcctSel, usageAcctLabel(), usageSourceLink);
```

Check that `TAB_USAGE` is the enum name (grep `enum Tab`). Check that `emojiTestActive`/`pairPanelActive`/`octoActive` are refused by whatever `TAB ` refuses under, and mirror exactly that set. Check that the handler's position in the chain does not let an earlier `startsWith` swallow `USAGEACCT`: no earlier verb is a prefix of it, since `USAGE` is not a verb today. `commands-check.mjs`'s section (9) rule is that a diagnostic's first token must never prefix-match a verb the host dispatches on. `USAGEACCT` does not (host prefixes: ANSWER, AUDIO, BATT, BLEMTU, D, EMOJI, FOCUS, FORGET, HELLO, HISTORY, MSGPRI, PAIR*, PROJSESS, PROMPT, REMOTE, RESUME, SCROLLACK, SELECT, SHOT). **But `D` is a host prefix**: run the checker, don't assume.

- [ ] **Step 7: MULTITEST.** In its payload string, after `"hostTag":"studio",`, insert `"acct":"feedacct",`. The value is invalid hex on purpose: it can never equal a real host's hash, so the synthetic Mac is always a second account. Update its comment to say so.

- [ ] **Step 8: Add a `CLAUDE.md` row for `USAGEACCT`** in the worktree's command table, in that table's style. Mention that it is absolute, idempotent, on both boards, and what it refuses by name.

- [ ] **Step 9: Run the checks.** `usage-geom-check.mjs`, `usage-account-check.mjs` (and `--selftest`), and `commands-check.mjs` (and `--selftest`) all pass, and so does every other checker in `CLAUDE.md`. Compile board 1, then board 2, sequentially.

- [ ] **Step 10: Stop for review.** Report the diff, the outputs, and the fit arithmetic for `BOARD_USAGE_ACCT_INDEX` on board 2.

---

### Task 4: Board 2 keeps one trend ring per account

**Files:**
- Modify: `firmware/deckhand_display/usage.ino`: the ring at ~lines 384-640 (`usageRing*`, sparkline, slope, span, caption, burn, the sparkline hash at ~503-520) and ~line 732
- Modify: `firmware/deckhand_display/deckhand_display.ino` ~line 9539 (the `usageRingSample()` caller)
- Modify: `firmware/deckhand_display/usage-trend-check.py`

**Interfaces:**
- Consumes: `usageAcctCount`, `usageAcctFirstLink[]`, `usageAcct[]`, `usageAcctSelIdx`, `accountKeyFor()` (Task 2).
- Produces: `struct UsageRing`, `UsageRing usageRings[MAX_LINKS]`, `void usageRingsSampleAll()`, `const UsageRing& usageRingSelected()`.

- [ ] **Step 1: Extend `usage-trend-check.py` first.**
  - Add a mirror of two accounts sampled in alternation: account A ramps 10->40 and B stays at 70. Assert that A's slope is positive and that B's ring never contains a value from A.
  - Add structural checks:
    - `usageRingSample(` takes a `UsageRing&` and a `const Usage&`, and its body does not read the global `usage.`;
    - `usageRingsSampleAll()` loops `usageAcctCount` and samples `usageAcct[a]`;
    - the slope, span, sparkline and burn readers read `usageRingSelected()`, and no bare `usageRingPct[` remains anywhere.
  - Add a `--selftest` fault: make `usageRingsSampleAll()` sample `usage` (the selected account's figures) into every ring. The check "B's ring never contains A's value" must catch it by name.
  - Update the existing structural regexes that name `usageRingPct`/`usageRingCount`/... to the struct fields. Keep their intent and do not weaken any of them.
  - Run it and see it FAIL.

- [ ] **Step 2: The struct.** Replace the six globals:

```cpp
// ONE RING PER ACCOUNT. A ring holds one quota's history; with two accounts on two
// Macs a single ring interleaved two series, and USAGE_RING_DROP_PCT - derived for
// two readings of ONE quota differing only in age - then either cleared it on every
// swap or read the swing as a burst. Owned by account key; see usageRingFor().
struct UsageRing {
  char          owner[14] = "";
  uint8_t       pct[USAGE_RING_SLOTS];
  unsigned long at[USAGE_RING_SLOTS];
  int           count = 0;
  int           head  = 0;
  unsigned long last  = 0;
  bool          wasStale = false;
};
UsageRing usageRings[MAX_LINKS];

void usageRingReset(UsageRing& r) { r.count = 0; r.head = 0; r.last = 0; }

// The ring owned by `key`, claiming a free one, else one whose owner is no longer
// among the live accounts. A reused ring is ALWAYS reset: another account's history
// is not this one's. nullptr only if every ring is owned by a live account, which
// cannot happen while usageAcctCount <= MAX_LINKS.
UsageRing* usageRingFor(const char* key) {
  for (int i = 0; i < MAX_LINKS; i++)
    if (strcmp(usageRings[i].owner, key) == 0) return &usageRings[i];
  for (int i = 0; i < MAX_LINKS; i++) {
    bool live = false;
    char k[14];
    for (int a = 0; a < usageAcctCount && !live; a++) {
      accountKeyFor(usageAcctFirstLink[a], k, sizeof(k));
      live = strcmp(k, usageRings[i].owner) == 0;
    }
    if (!usageRings[i].owner[0] || !live) {
      strlcpy(usageRings[i].owner, key, sizeof(usageRings[i].owner));
      usageRingReset(usageRings[i]);
      usageRings[i].wasStale = false;
      return &usageRings[i];
    }
  }
  return nullptr;
}

const UsageRing& usageRingSelected() {
  static UsageRing empty;   // count 0: every reader already refuses below two samples
  if (usageAcctSelIdx < 0) return empty;
  char k[14];
  accountKeyFor(usageAcctFirstLink[usageAcctSelIdx], k, sizeof(k));
  for (int i = 0; i < MAX_LINKS; i++)
    if (strcmp(usageRings[i].owner, k) == 0) return usageRings[i];
  return empty;
}
```

- [ ] **Step 3: The sampler** becomes `void usageRingSample(UsageRing& r, const Usage& u)`. Its body is the old one with `usage.` replaced by `u.` and each `usageRing*` global replaced by `r.*`. Add:

```cpp
// Every account, every call - not just the one on screen - so switching shows real
// history at once instead of an empty ring that takes 10 minutes to say anything.
void usageRingsSampleAll() {
  for (int a = 0; a < usageAcctCount; a++) {
    char k[14];
    accountKeyFor(usageAcctFirstLink[a], k, sizeof(k));
    UsageRing* r = usageRingFor(k);
    if (r) usageRingSample(*r, usageAcct[a]);
  }
}
```

The caller at deckhand_display.ino ~9539 calls `usageRingsSampleAll()`. Keep its rate-limit comment accurate: the limit is now per ring, through `r.last`. Rewrite the "deliberately does NOT reset on a mergeUsage source-Mac switch" comment. It is still true within one account, and it now says that different accounts never share a ring.

- [ ] **Step 4: The readers.** `usageRingSlope`, `usageRingSpanMin`, the sparkline draw and the hash (~503-520, ~618-640, ~732) read through `const UsageRing& r = usageRingSelected();` and its fields. The sparkline/burn caches are reset in `resetUsageCaches()`, which runs inside `drawUsageStatic()`, and Task 3's bust fires on a switch. Confirm that an account switch with identical percentages still repaints the sparkline: with a ring hash cache, a different ring's contents change the hash.

- [ ] **Step 5: Run the checks.** `python3 firmware/deckhand_display/usage-trend-check.py`, its `--selftest`, `usage-account-check.mjs`, and every checker in `CLAUDE.md`. Then compile board 2. Board 1 must be unaffected by this task: everything is inside `#if BOARD_USAGE_V2`. Prove it by compiling board 1 and comparing `/tmp/b1/*.bin`'s sha256 against Task 3's board-1 build.

- [ ] **Step 6: Stop for review.** Report the diff, the outputs, and the board-2 RAM delta ("Global variables use N bytes" before and after).

---

### Task 5: Baselines, numbers and docs

**Files:**
- Modify: `firmware/board-baseline.json` (via the script), `CLAUDE.md`, `docs/reference/usage-tab.md`, `docs/reference/pairing-and-multi-mac.md`

- [ ] **Step 1: Run the full verification block** from `CLAUDE.md`, every line, including `geom-sweep.mjs` (~110s) and each checker's `--selftest` where it exists. Every line must pass. Record the outputs.

- [ ] **Step 2: Compile and re-baseline each board, one at a time.** Compile board 1 to `/tmp/b1`, then `node firmware/board-baseline.mjs /tmp/b1/deckhand_display.ino.bin --check 1`, which should report `CHANGED`. Read the size delta, then run `--update 1`. Repeat for board 2 to `/tmp/b2`. Then run `node firmware/board-baseline.mjs --doc-check`, which must fail until the next step and pass after it.

- [ ] **Step 3: Update `CLAUDE.md`.**
  - Update the hashes and sizes the doc-check binds; `--update` rewrites them, so verify.
  - Hand-update both RAM figures from the compile summaries.
  - Add a dated sentence to the board-2 RAM narrative explaining the delta: the per-account `Usage` array, the two `HostLink` fields x `MAX_LINKS`, and the ring struct x `MAX_LINKS`.
  - Add a sentence saying board 1 moved too, and why: multi-Mac is shared code. The rule is that a change to board 1 is measured and explained, never a surprise.

- [ ] **Step 4: Correct the reference docs in place.** Keep the old text and mark it; do not delete.
  - `pairing-and-multi-mac.md`: the "Both Macs poll the same account" bullet is marked as wrong for different accounts, and the account rule follows it with its evidence. The "OPEN BUG" entry is updated with Task 2's diagnosis and the outcome of Task 6's acceptance run.
  - `usage-tab.md`: the `USAGE_RING_DROP_PCT` bullet and the ring section say the ring is per account. List what is measured, and what is not (board 2 on glass).

- [ ] **Step 5: Stop for review.** Report the diff and the full verification output.

---

### Task 6: On glass, board 1 (controller runs this; it needs the live device)

The live host runs from the MAIN checkout and is not updated by this branch, so the real Mac publishes no `acct`. That is fine: it is its own account. MULTITEST adds `feedacct` as the second.

- [ ] **Step 1: Flash board 1.** Run `./flash.sh` from the worktree (it compiles board 1, stops and restores the supervised host). Afterwards confirm `BUILD` in `/tmp/deckhand-$(id -u)/host.log` names this build and `via=` shows the board.
- [ ] **Step 2: One account.** Send `TAB 0`, then `SCREENSHOT`. The header must look as it did before this change, with no label. Compare `5h=`/`7d=` from the same minute's tick line.
- [ ] **Step 3: Two accounts.** Send `MULTITEST 2`, then `TAB 0`, then `USAGEACCT 0`, then `SCREENSHOT`, then `USAGEACCT 1`, then `SCREENSHOT`, then `USAGEACCT 0`, then `SCREENSHOT`. The device must print `USAGEACCT 1/2 ...` and `USAGEACCT 0/2 ...` (check host.log). Account 1 reads 11%/22% with label `studio`. Account 0 matches the host log, with the real Mac's tag. Look at all three PNGs in `~/Deckhand-shots/`.
- [ ] **Step 4: Refusals.** `USAGEACCT 5` refuses quoting `0..1`. `USAGEACCT x` refuses by name. Each command's double delivery produces two identical lines and no toggle.
- [ ] **Step 5: The freeze acceptance.** With account 1 selected, wait more than 21s for the synthetic link to age out, then `SCREENSHOT`. The cards must show the REAL Mac's figures, matching the host log's `5h=`/`7d=` for that minute, with no label. Record the result in the OPEN BUG entry.
- [ ] **Step 6: Report.** What is measured on glass (board 1), and what is not (board 2's ring on glass, and real cross-account with the new host on both Macs, which needs merge and deploy).
