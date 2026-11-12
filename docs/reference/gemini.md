# Antigravity: sessions, hooks and usage

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

This is Google's **Antigravity** stack: the Gemini desktop app (`/Applications/Gemini.app`),
the Antigravity app and IDE, and the `agy` CLI. Google retired Gemini CLI on 2026-06-18 in
favour of Antigravity CLI (developers.googleblog.com, "transitioning Gemini CLI to Antigravity
CLI"); nothing here ever read Gemini CLI (`~/.gemini/tmp`), so there was nothing to remove.
Everything user-facing says **Antigravity** since 2026-11-11 (menu `AG` column, `AGY` on the
device); the files keep their `gemini-*` names.

**Corrected 2026-11-11, kept for the record:** this page used to say Antigravity had "no hook"
and that both halves were "MENU-BAR ONLY" because the firmware drew every non-`cx` agent as
CLAUDE. Both stopped being true that day: Antigravity CLI has hooks (below), and the firmware
knows a third agent, `ag` (`agentKind()`, `AGY`, `AgyMark.h`), so Antigravity sessions and
usage now reach the device. Every read still degrades to "no reading", never a wrong one.

## Hooks (`claude-hooks/deckhand-antigravity-hook.mjs`)

Registered by `install-antigravity-hooks.mjs` under ONE key, `deckhand`, in
`~/.gemini/config/hooks.json` - Antigravity's hooks file maps a hook NAME to its events
(https://antigravity.google/docs/hooks/), so nobody else's entries are read or rewritten. The
released app installs it with the Claude Code hooks (Settings > Hooks > **Antigravity hook**,
remembered like Codex's switch); `--remove` takes it out.

MEASURED 2026-11-11 against agy 1.5.6, by registering capture hooks in a throwaway workspace
(`<ws>/.agents/hooks.json`) and running real turns, headless and through a pseudo-terminal:

- **The payload is richer than the docs say.** Every event carries `hookEventName` and `cwd`
  (the docs say neither is passed), plus `conversationId`, `workspacePaths`, `modelName`,
  `lastUserInput`, `transcriptPath`, `artifactDirectoryPath`; the hook also inherits
  `ANTIGRAVITY_CONVERSATION_ID`. Its working directory is `<ws>/.agents`.
- **A `PreToolUse` hook GATES THE TOOL, so Deckhand never registers one.** `{}` on stdout was
  read as a missing decision and DENIED the call ("tool call denied by pre-tool hook"); exit 1
  FAILED it ("JSON hook ... failed: exit status 1"); empty stdout and `{"decision":"allow"}`
  both fell through to Antigravity's own policy. The four events Deckhand does register -
  `SessionStart`, `PreInvocation`, `PostToolUse`, `Stop` - were run with the hook crashing,
  printing nothing, and pointing at a Node that does not exist: the turn completed correctly
  every time. The commands still end `2>/dev/null; true`. `antigravity-hook-check.mjs`
  asserts the event list against the installer's own `EVENTS`, and its selftest proves the
  `PreToolUse` assertion can fail.
- **There is no hook while the approval prompt is up, so there is no "asking" and no
  answering.** Driven through a pty to Antigravity's real prompt ("Requesting permission
  for: echo deckhand-probe / Run this command?" with four options): `PreToolUse` had fired,
  `PostToolUse` had not, the conversation index said `RUNNING` with `not_fully_idle=1`, and the
  transcript's last step said `DONE` - the pending tool step is not written until it resolves.
  `PreToolUse` runs BEFORE the prompt appears, so a hook waiting there would hold the Mac with
  nothing on screen - the exact failure hooks-and-answering.md records for `AskUserQuestion`.
  The user chose live status only (2026-11-11). Antigravity prompts are answered in Antigravity.
- **`Stop` with `fullyIdle: false` is not the end.** A turn whose background work is still
  running stops with `fullyIdle=false`, and then NO event fires when that work finishes:
  `Stop` at 04:45:20, `not_fully_idle` cleared in the index at 04:45:54, nothing in between.
  So the host merges the two sources FIELD BY FIELD (`mergeAntigravity`, sessions-merge.mjs):
  the index's live status and later timestamp win, and the hook supplies only what the index
  lacks - the model, the latest prompt, the transcript path. A hook record winning outright
  (Codex's rule) would have said "working" for the whole 20-minute stale window.
- **What the hook adds, honestly:** not speed - the host reads hook records and the index on
  the same 5s tick. It adds the model (the index has none), the latest prompt (the device's
  detail card shows it) and the folder per turn.

**No messages, no history.** An Antigravity row never gets a `pnonce` (`msgDeliverable()`):
nothing can post into a running `agy` session, and a headless `agy --conversation` turn would
be a second author of it; a message aimed at one is refused BY NAME on arrival. Its transcript
is never registered for the history reader (a different format), the device's card does not
offer history (`historyOffered()`), and `SCROLLOPEN` refuses BY NAME - measured: without that,
the broadcast request went unanswered and the reader sat on "fetching 0/1".

## Sessions: the conversation index (`host/gemini-sessions.mjs`)

Each store is a directory under `~/.gemini` holding `conversation_summaries.db`, a SQLite
table (`conversation_summaries`) Antigravity keeps one row per conversation in:

| store dir | written by | a click on the row |
|---|---|---|
| `antigravity` | the Gemini / Antigravity app | activates `com.google.antigravity` |
| `antigravity-ide` | the Antigravity IDE | activates `com.google.antigravity-ide` |
| `antigravity-cli` | `agy` in a terminal | reveals the folder (no app is recorded) |

Columns used: `conversation_id`, `title`, `workspace_uris` (a JSON list of `file://` URIs; the
first is the session's folder), `status`, `not_fully_idle`, `last_modified_time`,
`app_data_dir`. The database is opened **read-only** every 5s tick (SQLite may still create
`-shm`/`-wal` beside it when the app is closed, as `agy` itself does).

MEASURED 2026-10-31 against agy 1.4.8, and re-observed 2026-11-07 with the Gemini app:

- **The row is live.** `status` `CASCADE_RUN_STATUS_RUNNING` with `not_fully_idle = 1` while
  a turn runs, `..._IDLE` with `0` about 3s after - so no per-conversation file has to be
  statted. Working = RUNNING, BUSY or CANCELING, or `not_fully_idle = 1`; else waiting. In a
  real Gemini-app turn (2026-11-07, 22:43:48) the host listed the conversation within seconds
  and showed it working for 13 ticks, then waiting.
- **A brand-new row's first sample** carries the zero time `0001-01-01 ...`; it is skipped for
  that one tick rather than aged out as year 1.
- **A store can hold a COPY of another store's conversation** (the CLI's index listed the
  app's with an empty status). `app_data_dir` names the OWNING store, so only owned rows are
  read, which is also the dedupe.
- **There is no "asking".** `CASCADE_RUN_STATUS` has IDLE, RUNNING, BUSY, CANCELING and
  UNSPECIFIED and nothing for a pending approval, so a conversation waiting on a permission
  prompt most likely reads as working. Never claim a prompt we cannot see.
- Rows older than `SESSION_STALE_MS` (20 minutes) are dropped, like every other agent's.

Antigravity rows join the device's list and the menu's alike, ranked by the same urgency rule,
sent as agent `ag` (`AGY` on the glass, `Antigravity` in the menu). `host/gemini-sessions-check.mjs`
holds the parsing, the field-by-field merge and the no-message/no-history rules; until
2026-11-11 it held the opposite "menu yes, device no" rule.

## Usage: the app's local server, or the CLI's `/usage` (`host/gemini-quota.mjs`)

**Two sources since 2026-11-11, best first.** An Antigravity app's local server (below) when
one is running - ~35ms, asked once a minute. Otherwise `agy -p /usage --output-format json`,
asked at most every 5 minutes: MEASURED on agy 1.5.6, it returns the same groups and windows
with **no model turn** (`num_turns: 0`, every token count 0), ~3.6s wall and ~0.3s CPU, and
leaves no conversation behind (the CLI's `brain/` count unchanged). Its JSON's `response` is the
human TABLE as a string; the breakdown is under `command.data`, in snake_case
(`remaining_fraction`, `reset_time`, `name`) - `summarizeQuota()` reads both spellings. agy lives
in `~/.local/bin`, which is not on launchd's PATH, so `agyCandidates()` tries it first. Before
this, usage was invisible with only a terminal `agy` - no app, no hub, no figure.

**The device's one figure, and the bar's column, are the MOST-USED Gemini window**
(`antigravityDeviceUsage`, and `GeminiGroup.primary` in the app), never "Gemini Models" by
name: on 2026-11-11 that group read 0% on both windows while "Gemini 4 Argon" was 35% through its
week, on a Mac whose sessions run `gemini-4-argon-medium`. The "Claude and GPT models" group is
never chosen (other vendors' models; beside Claude's column it reads as the person's own quota).
A tie goes to the shorter window.

Gemini writes no usage figure to disk: its CLI logs say `quota_manager.go: doRefreshQuota`
and never the numbers. The figures come from the app's own local server.

### Finding the server

The app runs `agy --hub --hub-port=<n> --use_host_auth ...` and writes a descriptor:

```
~/.gemini/<store>/daemon/hub_<port>.json
{ "pid": 41115, "httpPort": 56716, "httpsPort": 56718, "lsVersion": "2.28.2", "csrfToken": "<36 chars>" }
```

A descriptor outlives a crashed hub, so its `pid` is checked with signal 0 (sends nothing,
asks "is it alive"). Several live hubs (the Gemini app and the Antigravity IDE, say): the
newest descriptor by mtime is asked first, the next if it fails.

### The call

```
POST http://127.0.0.1:<httpPort>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
Content-Type: application/json
Connect-Protocol-Version: 1
X-Codeium-Csrf-Token: <csrfToken>

{"metadata": {"ideName": "antigravity", "extensionName": "antigravity", "locale": "en"}}
```

Connect-protocol JSON over plain HTTP on loopback, ~35ms. Answer (lsVersion 2.28.2, a Google
AI Pro account, 2026-11-08):

```
{ "response": {
    "groups": [
      { "displayName": "Gemini Models",
        "description": "Models within this group: Gemini Flash, Gemini Pro",
        "buckets": [
          { "bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 1, "resetTime": "2026-11-15T06:43:29Z", ... },
          { "bucketId": "gemini-5h",     "window": "5h",     "remainingFraction": 1, "resetTime": "2026-11-08T11:43:29Z", ... } ] },
      { "displayName": "Claude and GPT models", "buckets": [ ...weekly..., ...5h... ] },
      { "displayName": "Gemini 4 Argon",
        "description": "For paid Pro plans, Argon quota is separate. ...",
        "buckets": [ { "bucketId": "gemini-argon-wtu-weekly", "window": "weekly", "remainingFraction": 0.999072, ... } ] } ],
    "description": "Within each group, models share a weekly limit and a 5-hour limit. ..." } }
```

So: GROUPS, each with up to two windows (`5h`, `weekly`), `remainingFraction` 1 = untouched.
Used % is `round((1 - remainingFraction) * 100)`, clamped to 0..100; a bucket without a number
is skipped (absent is not 0%), and a group left empty is dropped.

### Why not `GetUserStatus`

The same server's `GetUserStatus` (what Antigravity's quota tooltips use) carries one
`quotaInfo` per MODEL (`label`, `remainingFraction`, `resetTime`), with the Low/Medium/High
variants of a model identical. The first version of this feature read it, and it was WRONG
for this purpose: each model reported ONE window - weekly for Argon, 5h for the rest - so
Gemini's 5-hour limit was missing (the user pointed it out), and for Argon it disagreed with
the summary in the same minute (0.970 against 0.999 remaining). `RetrieveUserQuotaSummary` was
found by reading the RPC paths out of the `agy` binary (`strings ... | grep Quota`); it is the
breakdown the app shows its own users.

### Into the menu

The host asks **at most once a minute, in the background, single-flight** (`kickGeminiQuota`,
called from `readUsage` and never awaited - the tick must not wait on a network call, however
local), and prints on the tick line:

```
gmq=Gemini_Models|5h:0:297|weekly:0:10077;Claude_and_GPT_models|5h:0:297|weekly:0:10077;Gemini_4_Argon|weekly:3:9954 gmage=16
```

Groups split on `;`, a group's name and windows on `|`, a window on `:` as
`window:usedPct:resetMinutes` (`?` = unknown); spaces in a name become `_` and the separators
are removed from names. `gmage` is the reading's age in seconds. Between reads the reading is AGED to now
(`ageQuota`): every reset counts down, and a window whose reset has passed is dropped - its
percentage describes a window that no longer exists, Codex's `windowExpired` rule. (The first
version printed the reading as fetched, so with the app closed "resets in 30m" said so for six
hours, and a 5h figure outlived its own window.) A reading older than 6 hours is dropped whole.

The menu-bar app (`parseGeminiQuota`, `GeminiGroup`):

- **Bar:** an `AG` column (it was `GM` until 2026-11-11) for the group holding the MOST-USED
  window - the device's rule, see above; it used to be "Gemini Models" by name, which read 0%
  beside a 35% Argon week - never the Claude/GPT one. 5h over weekly like Claude's and Codex's,
  borrowing Claude's `5h`/`7d` row labels when that column is beside it. A group with no 5h window
  (Argon) draws one row rather than a dash in a row it lacks. Both window lengths are named, so
  the ▲ pace mark is real. Behind Settings › Menu Bar › **Antigravity usage** (the stored key is
  still `barShowGemini`, so an existing choice carries over).
- **Dropdown:** an **Antigravity** section: the primary group's rows (unlabelled only when it is
  "Gemini Models"), then the others named - `Gemini`, `Argon`, `C/GPT` (not "Claude", which
  inside this section read as the user's own Claude quota).
- **Tooltip:** `AG (Antigravity) 5h: ...` with the pace sentence; each dropdown row names its
  group and window.

### Trust and failure

- **Read-only**, to **127.0.0.1 only**, with the token the app wrote for local clients in the
  user's own home directory. The token is never logged and never leaves the call's header;
  nothing is sent anywhere else.
- **A reused pid** (the app crashed and an unrelated process now has its pid) would pass the
  liveness check, and the token would go to whatever listens on the old port - on 127.0.0.1
  only, so the exposure is to local processes; accepted, and noted here.
- **Undocumented**: no hub, a dead pid, a refused call, a timeout (3s), or a changed shape all
  resolve to `null`, and the AG column and the Antigravity section are simply not there. A Gemini
  update can change any of this; `host/gemini-quota-check.mjs` pins the parsing and the
  wiring, but only a live read proves the interface is still there.

### Probing it by hand

Without printing the token:

```
python3 - <<'EOF'
import json, glob, os, urllib.request
for f in glob.glob(os.path.expanduser("~/.gemini/*/daemon/hub_*.json")):
    d = json.load(open(f))
    req = urllib.request.Request(
        f"http://127.0.0.1:{d['httpPort']}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        data=json.dumps({"metadata": {"ideName": "antigravity", "extensionName": "antigravity", "locale": "en"}}).encode(),
        headers={"Content-Type": "application/json", "Connect-Protocol-Version": "1", "X-Codeium-Csrf-Token": d["csrfToken"]})
    try: print(f, json.dumps(json.load(urllib.request.urlopen(req, timeout=5)), indent=1)[:2000])
    except Exception as e: print(f, e)
EOF
```

Or through the host's own module: `cd host && node -e 'import("./gemini-quota.mjs").then(async m => console.log(JSON.stringify(await m.readGeminiQuota())))'`.
