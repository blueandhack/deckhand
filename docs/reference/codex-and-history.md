# Codex support and the paged history reader

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

- **Codex support is PUSH via hooks, with PULL retained as a fallback.** Claude Code
  state arrives because `deckhand-session-hook.mjs` is *invoked* on every event; Codex
  now gets the identical treatment — `install.sh` registers that same hook with Codex
  CLI (0.147.0+, `--agent=codex`), so a Codex thread pushes its own status and can be
  answered from the device exactly like a Claude Code session. The host also still
  reads Codex's rollout files directly, as a fallback for installs where Codex's hooks
  trust prompt hasn't been accepted yet (or on Codex versions older than 0.147.0) — see
  below for how that pull path works and what it can't do (no NEEDS INPUT, no
  answering, and an ended thread still ages out over ~20 minutes rather than vanishing
  at once).
  Codex had no hooks mechanism at all when this integration was first written; the
  investigation below (all measured on 0.147.0, not inferred) is what established a
  hooks-based push was possible, and it's kept as the record of how that was verified:
  Codex CLI **0.147.0** ships a hooks system that closely mirrors Claude Code's -
  confirmed from the binary's embedded JSON schema and its own validation strings, not
  from docs. Config lives in `~/.codex/hooks.json` (also project-local `.codex/`, plus a
  managed dir), and the events are `pre_tool_use`, **`permission_request`**,
  `post_tool_use`, `pre_compact`, `post_compact`, `session_start`, `session_end`,
  `user_prompt_submit`, `subagent_start`, `subagent_stop`. The decision contract matches
  too (`PermissionRequestDecisionWire`, `PreToolUseHookSpecificOutputWire`, with
  `continue`/`stopReason`/`suppressOutput`/`systemMessage`), and it even reads
  `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` - deliberate compatibility with Claude Code's
  hook ecosystem.
  **VERIFIED by running it, not read off the binary.** A capture hook registered in
  `~/.codex/hooks.json` (Claude-style: keyed by PascalCase event names, `matcher` plus
  `hooks:[{type:"command",command}]`) produced these real payloads:
  ```
  {"session_id":..,"transcript_path":"..rollout-...jsonl","cwd":"/private/tmp",
   "hook_event_name":"SessionStart","model":"gpt-5.6-sol",
   "permission_mode":"bypassPermissions","source":"startup"}
  {"session_id":..,"turn_id":..,"hook_event_name":"PreToolUse","tool_name":"Bash",
   "tool_input":{"command":"echo deckhand-probe"},"tool_use_id":"exec-.."}
  ```
  The field names are **identical to Claude Code's**, down to the tool being called
  `Bash` - `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
  `tool_name`, `tool_input`, plus `turn_id`/`permission_mode`/`tool_use_id`. So
  `deckhand-session-hook.mjs` reads the right fields ALREADY; this is far closer to a
  registration exercise than a port.
  Two things that are not yet settled, and both matter before building:
  - **`PermissionRequest` IS captured, from a real interactive session:**
    ```
    {"hook_event_name":"PermissionRequest","tool_name":"Bash","permission_mode":"default",
     "tool_input":{"command":"curl -sI https://example.com | head -1",
                   "description":"Allow this read-only network request to example.com .."},
     "session_id":..,"turn_id":..,"transcript_path":..,"cwd":"/private/tmp"}
    ```
    `buildAsk()` already reads exactly `tool_name` + `tool_input.command`, so it yields
    "Allow Bash?" with the command as detail **with no changes at all**. Codex also
    supplies a `description` saying WHY approval is needed, which Claude Code does not -
    worth showing. Note the observed order: `PreToolUse` -> `PostToolUse` with an EMPTY
    `tool_response` (the sandboxed attempt failed silently) -> `PreToolUse` again ->
    `PermissionRequest`. Codex tries, gets blocked, then escalates - so a naive reading of
    PostToolUse would record a "completed" tool call that never ran.
    It cannot be captured from `codex exec`, which forces
    `permission_mode: bypassPermissions` regardless of `-c approval_policy`.
    **PROVEN end to end:** feeding that captured payload to the UNMODIFIED
    `deckhand-session-hook.mjs` (throwaway `$HOME`) produced
    `status:"asking"` with `ask:{kind:"perm",title:"Allow Bash?",detail:"curl -sI ...",
    options:["Allow","Deny"],answerable:true}` and an empty stdout.
    **The DECISION dialect is round-tripped too, against a live session.** A one-shot hook
    emitting Claude Code's exact shape -
    `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":..}}}`
    - was honoured: Codex blocked the command and fed our message back to the model as the
    tool result, which appears verbatim in its own rollout as a
    `custom_tool_call_output` ("Deckhand round-trip test: denied by the hook."), after
    which the assistant reported it could not run. So **every** piece of the answering
    path is verified end to end: event, payload, ask construction, and decision.
    **Design snag to solve first:** a Codex hook writing into
    `~/.claude/deckhand-sessions/` would DOUBLE-COUNT, because the host also pulls the
    same thread from its rollout. Either the pull skips hook-covered sessions or the two
    are merged by id.
  - **The TRUST GATE is real, and it is what makes hooks safe.** Measured A/B: two
    identical runs, hooks fired ONLY with `--dangerously-bypass-hook-trust`. An untrusted
    `hooks.json` is inert - which also means a stray one cannot run behind your back, and
    that shipping this needs a real trust step, not the bypass flag. The interactive TUI
    is where that step happens: it shows "Hooks need review / Hooks can run outside the
    sandbox after you trust them" with **Trust all and continue** / Review hooks /
    Continue without trusting, and a hook sits at "New hook - review required" (or
    "Modified since last trusted") until accepted. So installing this cannot be silent -
    the user has to agree once, per change to the hook.
  What that unlocked, and now ships: **Codex prompts can be answered from the device**,
  because the device is already agent-agnostic - it renders whatever `ask` object is in a
  session record and signs answers with the pairing key regardless of which tool asked.
  The implementation is a Codex-flavoured sibling of `deckhand-session-hook.mjs` - the
  *same file*, invoked with **`--agent=codex`**
  (`claude-hooks/install-codex-hooks.mjs` registers that command in `~/.codex/hooks.json`
  for `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop`, and
  `SessionEnd` - deliberately **not** `PreToolUse`, which on Codex fires for every tool
  call with nothing to matcher-filter it against, unlike Claude Code's
  `AskUserQuestion|ExitPlanMode` matcher). `SessionEnd` deletes the *pushed* record at
  once — but `readCodexSessions()` still admits that thread's rollout file for up to
  `SESSION_STALE_MS` (20 min) afterward, and `mergeById()` (`host/sessions-merge.mjs`)
  only lets a hook record SHADOW a pull record while both exist; once the hook record is
  gone there is nothing left to shadow, so the rollout-derived row survives as `waiting`
  until it ages out on its own. So a hook-covered Codex thread's pushed record disappears
  at once, but the thread's row on screen can still linger up to ~20 minutes on the pull
  fallback before it clears — `SessionEnd` narrows the PULL path's ghost-session window,
  it does not eliminate it.
  **The `hooks.json` key for a hook's own timeout is `timeout`, not `timeoutSec` - this
  was established by experiment, not inference, and it is exactly the kind of thing a
  future maintainer "fixes" into broken code.** Codex's `HookMetadata` struct (the
  metadata/API type) lists `timeoutSec`, and it is tempting to assume `hooks.json` takes
  the same field name. It does not: a hook made to sleep 10s under `{"timeout": 3}` was
  **killed** at 7s elapsed, while the identical hook under `{"timeoutSec": 3}` **ran to
  completion** at 14s elapsed - `timeoutSec` in `hooks.json` is silently ignored, so a
  "harmless" rename would quietly remove the 100s ceiling and let a hung hook block the
  triggering tool call indefinitely. `install-codex-hooks.mjs` and
  `codex-hooks.snippet.json` both correctly use `timeout`; keep it that way.
  Hooks are **trust-gated** (`hooks.state`) and do nothing until the user accepts Codex's
  own "Hooks need review" / "Trust all and continue" prompt, so a fresh install or an
  untrusted Codex is not silently broken: the PULL path described below still runs
  unconditionally and covers exactly that gap - an unaccepted trust prompt costs "no NEEDS
  INPUT and a 20-minute-stale end", never invisibility.
  Because push and pull both run, the same thread can arrive from both, and the host
  merges them by id (`host/sessions-merge.mjs`), hook record winning on a collision (it is
  the only one push-fresh and the only one carrying `ask`). **The merge key is truncated
  to 12 characters on both sides before comparing** - `readCodexSessions()` (the PULL
  reader) has always kept only a 12-char id, the same length the device itself keys rows
  on, while a hook record carries Codex's full UUID; comparing the raw strings would never
  match and the merge would silently do nothing, which looks exactly like the bug it
  exists to prevent.
  **The hook-expiry question is UNVERIFIED, not resolved - see Risk 2 in
  `docs/superpowers/specs/2026-08-13-codex-answering-design.md`.** Whether a
  `PermissionRequest` hook that times out falls through to Codex's own approval prompt
  (safe, like Claude Code) or resolves as a denial (unsafe, since an unanswered prompt
  would then default to blocking every command) cannot be tested non-interactively:
  `codex exec` forces `permission_mode: bypassPermissions` regardless of
  `-c approval_policy`, so `PermissionRequest` never fires outside the interactive TUI, and
  there is no scriptable way to drive that TUI through a real approval and a real timeout.
  In ordinary operation the risk is bounded regardless of the answer: the hook self-exits
  at 90s (`REMOTE_WAIT_MS`) comfortably inside the 100s `timeout` the registrar sets, so
  expiry is reachable only through a pathological overrun (a wedged device, a host that
  never comes back), not routine slowness. The spec records the exact manual experiment
  (shorten the timeout, stop the host, drive a real prompt from the interactive TUI, watch
  what happens at expiry) that would close this out; it has not been run.
  The rest of this section describes the PULL path, which now serves as the fallback for
  untrusted installs. Verified against real rollouts on this machine:
  Everything comes from `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`:
  `session_meta` (cwd, `thread_source`), `turn_context` (live cwd, model), `event_msg`
  `task_started`/`task_complete`, and `token_count.rate_limits`.
  Consequences worth knowing before changing any of it:
  - **Freshness is the rollout file's MTIME. `session_index.jsonl` is NOT used, and
    that's the first thing that broke in real use.** That file exists, has one line per
    thread with an `updated_at`, and looks like exactly the right index — but Codex
    appends to a rollout LIVE and only rewrites the index later. Measured while a
    thread was actively in use: index said **26 minutes idle**, the rollout had been
    touched **1 minute** ago. Keying off the index made an open Codex session invisible
    on the device. Walking the tree is cheap (one directory per day, a couple of dozen
    files after months of use) so it runs every tick — and an early version that cached
    id→path lookups *including misses* permanently hid any thread whose rollout didn't
    exist yet at first look.
  - **Rollouts are read HEAD **and** TAIL, never whole.** `session_meta` is the FIRST
    record (cwd, `thread_source`) while status and `rate_limits` are in the LAST ones,
    and a long thread's file runs to megabytes. Two 64KB windows keep it O(1) per
    thread. A window can slice a line in half, so every line is parsed defensively.
  - **The id alone doesn't give the path** — files are named `rollout-<timestamp>-<id>`
    under a date tree, so the host walks the tree once and caches id→path (misses
    cached too, or it re-walks every 5s tick).
  - **`thread_source != "user"` is skipped.** Codex spawns subagent threads for
    auto-review and guardian; they are not something a person is waiting on, and they
    would crowd the 6-row list.
  - **A Codex row can now show `asking` and be answered — that was the whole point of
    building the push path above.** The PULL reader described in this bullet still can
    only ever produce `working` or `waiting` on its own: no approval event appears in any
    rollout on this machine, so there is nothing here to map to `asking`. What changed is
    that this is no longer the only source - the hook-pushed record supplies `asking` and
    wins the merge whenever Codex's hooks are trusted, so a live thread with a pending
    approval shows NEEDS INPUT and can be answered from the device exactly like a Claude
    Code session. An install where the trust prompt hasn't been accepted yet falls back to
    this PULL path alone, degrading to the old working/waiting-only behaviour rather than
    losing the thread entirely.
  - **Usage comes from `token_count.rate_limits`, and it is ONE number.** `primary` is
    the only populated window (`window_minutes: 10080` = 7 days on a Plus plan);
    `secondary` is null but is passed through if a plan ever fills it. There is no
    endpoint to ask — unlike the Claude side's OAuth poller — so the newest
    `rate_limits` ever seen is retained across ticks and published with `cxAgeSec`, and
    the device dims it past 15 minutes for exactly the reason `quotaAgeSec` exists: a
    value read from a file that stopped being written is not a live reading.
  - Payload keys are short (`cxPct`/`cxResetMin`/`cxWin`/`cxAgeSec`, `agent:"cc"|"cx"`)
    because they ride in **every** tick and the device's line buffer is sized for asks
    carrying 1400-char details.
- **Session history is PULL, on demand, and PAGED FROM THE MAC.** Opening a session's
  detail screen and tapping the card opens a HISTORY reader. The device sends
  `HISTORY <id12> <chat|all> <page|last|item:N> [<cols>x<lines>]` and the host replies with ONE JSON line
  whose only key is `hist`, so it can never be confused with a tick payload (the device
  bails out of the parser before any usage field is touched).
  **The `<cols>x<lines>` token is the DEVICE stating its own budget, and it is optional so an
  un-upgraded device keeps working.** Absent (or out of range) the host falls back to
  `HIST_LINE_CHARS = 36` / `HIST_PAGE_LINES = 16`, which *is* board 1's existing behaviour — so no
  protocol version bump was needed, the same backward-compatibility shape as the trailing
  `to=<hostId>` address. It exists because those two constants were hardcoded to board 1's 216px
  column, and a board with an 18-line/37-column reader could therefore never fill a page while
  nothing on either side reported an error.
  **The device stores only the screen it is showing.** Measured on a real transcript: 2515
  entries / 584KB, of which the conversation alone is 122KB, against ~70KB of free heap
  after the BLE stack — no device-side buffer can ever hold a session's history, so a
  bigger buffer is never the answer. The Mac keeps all of it and serves one screen at a
  time, which makes history length unbounded: that same session pages to **399 screens of
  chat, 1853 of everything**, and the biggest page is **774 bytes**.
  Everything comes from Claude Code's own transcript JSONL, whose path the hook records
  per session — `user`→`you`, `assistant [text]`→`claude`, `[tool_use]`→`ran` (tool name
  plus the one interesting field, not a JSON dump), `[tool_result]`→`out` or `no` when
  `is_error`. `[thinking]` and the meta types are dropped. **A denied permission and a
  chosen option both arrive as tool_results**, which is how "what I chose" shows up
  without a separate channel.
  - **TWO LEVELS, because one length can't serve both.** The list shows 300-char previews
    so a screen holds several rows; **tapping a row fetches that entry WHOLE** (4000-char
    cap, matching the device's buffer) into its own pager. With a single cap this failed
    both ways: at 600 chars the list was sparse AND long messages were still cut — and
    worse, an entry taller than one screen was silently CLIPPED by the device with no way
    to reach the rest. That is what "I can't see the full message" was.
  - **Body tap opens the row under the finger; paging is the buttons and the scrubber.**
    Spending the body tap on "next page" was the wrong trade, because reading a whole
    message was the thing the list could not do at all.
  - **The jump bar is a proportional SCRUBBER, not one segment per page.** At 399 pages a
    segment each would be a pixel wide. Tap anywhere along the track to jump to that
    fraction; the header shows position in the whole history (`412/628`), not a page number.
  - **CHAT is the default filter.** Tool calls outnumber conversation about 2:1, so an
    unfiltered view is mostly commands. The chip toggles to ALL.
  - **The reply goes over USB when USB is up, and BLE only as a fallback — never both.**
    BLE writes go out in 20-byte chunks (`BLE_CHUNK_SIZE`), so at the 30ms connection
    interval macOS negotiates the theoretical ceiling is ~666 B/s and a few KB is seconds
    **on the air**. That RATE is the reason USB wins. This note used to say each chunk
    awaited a response, and that is simply false: `sendOverBle` passes noble's
    `withoutResponse` flag (`writeAsync(chunk, true)`), so the host is **not** blocked
    behind the radio — and for the same reason over-the-air completion is not observable
    through that binding at all (see the two-Mac airtime note). Do not restore the
    blocking claim; the conclusion never needed it. Both transports reach the same device.
  - The parsed transcript is cached per session (paging 399 screens must not re-read a
    megabyte each time) but the cache is **bounded to the 2 most recently used** — a parsed
    transcript is ~600KB of strings and this process runs for days, so an unbounded cache
    grew by another transcript for every session ever opened.
  - The device's page arena is sized to what ONE SCREEN can hold (2.4KB), not to 24
    worst-case entries (15KB) — that difference comes straight out of the heap the audio
    path needs. If the host's wrap estimate lets a page arrive slightly oversized, the
    device drops the tail rather than overrunning the arena.
  - Paginated **by entry, not by line** — splitting an entry across a page makes it
    unreadable — and it opens on the NEWEST page.
  - The reader owns the whole screen, so it has to absorb the 5s tick the same way the
    settings confirm dialog does; without that the periodic repaint paints the detail
    screen straight over it.
