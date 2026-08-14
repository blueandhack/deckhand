# Codex answering: restructuring the Codex half from pull to push

**Status:** design, approved for planning · **Date:** 2026-08-13

## Problem

Deckhand's Codex support is PULL: the host walks `~/.codex/sessions/**/rollout-*.jsonl`
and infers state from the file's mtime and its `task_started` / `task_complete` records.
That was the only option when it was written, and it has two consequences the display was
built to avoid:

- **A Codex row can never say NEEDS INPUT.** No approval event appears in a rollout, so a
  Codex thread can only ever be shown as busy or idle. A device whose whole purpose is
  "who is waiting on you" is silent about exactly that, for one of the two tools it shows.
- **An ended Codex thread lingers for 20 minutes.** There is no end signal in the pull
  model, so a finished thread ages out via `SESSION_STALE_MS` instead of disappearing.
  Because it maps to `waiting`, it is visually identical to a session that has finished a
  turn and is ready for you. Observed in practice: four dead `/private/tmp` threads
  outranked live work and filled a six-row list.

Codex CLI **0.147.0** removes the constraint that forced this. It ships a hooks system
that mirrors Claude Code's closely enough that Deckhand's existing hook already works
against it, unmodified.

## Evidence this is possible (all measured on 0.147.0, not inferred)

Registered a capture hook in `~/.codex/hooks.json` and drove real sessions:

1. **The config schema is Claude-style** — keyed by PascalCase event names, each entry
   `{matcher?, hooks:[{type:"command", command}]}`. Accepted and loaded.
2. **Payloads are field-identical to Claude Code's.** A real `PermissionRequest`:
   ```json
   {"hook_event_name":"PermissionRequest","tool_name":"Bash","permission_mode":"default",
    "tool_input":{"command":"curl -sI https://example.com | head -1",
                  "description":"Allow this read-only network request to example.com .."},
    "session_id":"019ffd75-..","turn_id":"..","transcript_path":"..","cwd":"/private/tmp"}
   ```
   Codex additionally supplies a human-readable `description` saying *why* approval is
   needed, which Claude Code does not.
3. **The existing hook handles it unchanged.** Feeding that payload to an unmodified
   `deckhand-session-hook.mjs` (throwaway `$HOME`) produced
   `status:"asking"` with `ask:{kind:"perm", title:"Allow Bash?",
   detail:"curl -sI https://example.com | head -1", options:["Allow","Deny"],
   answerable:true}`, and an empty stdout.
4. **The decision dialect round-trips.** A one-shot hook emitting
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":".."}}}`
   caused Codex to block the command and feed our message back to the model as the tool
   result; it appears verbatim in the rollout as a `custom_tool_call_output`, after which
   the assistant reported it could not run.
5. **Hooks are trust-gated.** Measured A/B: identical runs fired hooks only with
   `--dangerously-bypass-hook-trust`. Interactively, the TUI shows *"Hooks need review /
   Hooks can run outside the sandbox after you trust them"* with **Trust all and
   continue** / Review hooks / Continue without trusting. A hook sits at "New hook —
   review required" until accepted, so installation can never be silent.

## Goals

- A Codex thread can show NEEDS INPUT and be answered from the device.
- An ended Codex thread's *pushed* record is removed at once — but the
  rollout-derived fallback row for that same thread still ages out over
  `SESSION_STALE_MS` (~20 min) on its own, so an ended Codex thread can still
  linger on screen until then. (See Merge rule below: once the pushed record
  is gone there is nothing left to shadow the pull record.)
- No firmware change. The device is already agent-agnostic: it renders whatever `ask` is
  in a session record and signs answers with the pairing key regardless of origin.

## Non-goals

- Changing the answer channel. Nonce, HMAC, per-pair keys and the `ANSWER` line are
  agent-independent and stay exactly as they are.
- Codex questions/elicitations (`elicitation_request`, `request_user_input`). Only
  `PermissionRequest` is in scope; the others are unstudied.
- Voice dictation into a Codex thread.

## Design

### Data flow

```
Codex ── ~/.codex/hooks.json ──> deckhand-session-hook.mjs --agent=codex
                                        │ writes
                                        v
                        ~/.claude/deckhand-sessions/<session_id>.json
                                        │
host readSessions() ────────────────────┴── merge by id ──> urgency sort, cap 6, ask forwarding
        └── readCodexSessions()  (rollout pull, unchanged) ─┘
```

One sessions directory, one record format. The record carries its own `agent` field;
`readSessions()` stops hard-coding `agent:"claude"` for that directory and honours it.

### Merge rule (Approach A)

Build a `Map` keyed by session id: pull records inserted first, hook records overwrite.
The hook record always wins, because it is push-fresh and carries the `ask`.

This is safe because the two sources agree on the key: the hook's `session_id`
(`019ffd75-9626-7a50-b707-4535327815e9`) is byte-identical to the id embedded in the
rollout filename (`rollout-2026-08-13T16-29-29-019ffd75-....jsonl`). Verified against
captured data. The device only ever sees the first 12 characters, and both sources
produce the same id, so a thread cannot appear twice.

The pull is retained deliberately: until the user accepts Codex's trust prompt, hooks do
not run, and without the fallback a Codex thread would be invisible rather than merely
less detailed.

### Event mapping

| Codex event | Status | Notes |
|---|---|---|
| `SessionStart` | `waiting` | |
| `UserPromptSubmit` | `working` | |
| `PermissionRequest` | `asking` | publishes the `ask`; the only event that waits |
| `PostToolUse` | `working` | clears `asking` after a decision |
| `Stop` | `waiting` | "right before Codex ends its turn" |
| `SessionEnd` | *delete the record* | deletes the *pushed* record only — the pull-side row for the same thread still ages out over `SESSION_STALE_MS` (~20 min) independently, since the merge only lets a hook record shadow a pull record while both exist |

`PreToolUse` is deliberately **not** registered for Codex. On the Claude side it is
matched only to `AskUserQuestion|ExitPlanMode`; Codex has no equivalent, and there it
fires for every tool call — a node process per call for no added information.

### Telling the tools apart

The Codex payload has no agent field and `hook_event_name` is identical, so the
registration passes the tool explicitly: `node deckhand-session-hook.mjs --agent=codex`.
It defaults to `claude`, leaving the existing Claude Code registration byte-identical and
un-migrated. Sniffing the transcript path was rejected: it couples the hook to a directory
layout neither tool guarantees.

**Vocabulary, because the codebase already has two and mixing them is an easy bug.**
Session *records* say `claude` / `codex`; the device *payload* says `cc` / `cx` (short,
because it rides in every tick). The flag uses the RECORD vocabulary. Concretely:

- the hook now writes `agent: "claude" | "codex"` into the record (today it writes no
  agent field at all — the host adds one on read, which is what this replaces);
- `readSessions()` honours the record's `agent` instead of hard-coding `"claude"` for
  everything in that directory;
- the existing `record.agent === "codex" ? "cx" : "cc"` mapping into the payload is
  unchanged.

### Install / uninstall / backup

- `install.sh`: when `~/.codex` exists, write/merge `~/.codex/hooks.json` (back up first,
  preserve any hooks already there, dedupe by command string — the same discipline
  `install-hooks.mjs` already applies to `settings.json`). Print the trust instruction,
  because the hook does nothing until accepted.
- `uninstall.sh`: remove our entries from `hooks.json` surgically, leaving others intact.
- `deckhand-backup.mjs`: add `~/.codex/hooks.json` to `FILES`.

## Risks and open questions

1. **The hook `timeout` must exceed the remote wait.** `settings.json` uses `timeout: 100`
   against Claude Code's 90s wait; `hooks.json` also uses `timeout: 100`, now against a
   15s Codex wait (the two are no longer the same number — see Risk 3 below for why the
   Codex side shipped shorter). Getting either wrong kills the hook mid-wait.
2. **STILL UNVERIFIED: what does Codex do with a `PermissionRequest` hook that times
   out?** Claude Code falls through to its own dialog when its hook expires. Whether
   Codex does the same, or instead treats expiry as a denial, is not known.
   It cannot be tested non-interactively: `codex exec` forces
   `permission_mode: bypassPermissions` regardless of `-c approval_policy`, so
   `PermissionRequest` never fires outside the interactive TUI, and there is no way to
   script "start Codex, trigger a real approval, let the hook time out" without a human
   at the keyboard accepting the trust prompt and issuing the command.
   The risk is bounded in normal operation, not open-ended: the hook self-exits at 15s
   (Codex's `REMOTE_WAIT_MS`) under a 100s `timeout` (see Risk 1), so expiry is reachable
   only through a pathological overrun — a wedged device, a host that never comes back, or
   a hook process that hangs past its own wait. It is not something a slow-but-working
   device triggers in ordinary use.
   The exact experiment a human can run to close this, when someone is available to sit
   with the TUI:
   1. Set the `PermissionRequest` timeout to `5` in `~/.codex/hooks.json` (temporarily —
      restore the real value afterwards).
   2. Stop the Deckhand host, so nothing answers and the hook waits its full duration.
   3. Start `codex` interactively and accept the "Trust all and continue" hooks prompt.
   4. Ask it to run `curl -sI https://example.com | head -1`.
   5. Observe what happens once the hook is killed at 5s:
      - **Codex shows its own approval prompt** — expiry falls through, exactly like
        Claude Code. Safe; the 15s Codex wait could then be raised back toward parity
        with Claude Code's 90s if that were ever wanted.
      - **Codex denies the command** — expiry is a denial. The wait would need to be
        shortened further (or dropped) for Codex specifically, since an unanswered
        prompt should never resolve to "denied" as its default.
   This has not been run. Nothing in this document should be read as claiming a result
   either way.
3. **STILL UNVERIFIED: is Codex's own approval UI concurrent with the hook, or serialised
   behind it?** CLAUDE.md justifies the 90s remote wait with a real measurement — 310
   `PermissionRequest` samples with no spike at the timeout, proving Claude Code's dialog
   is on screen the whole time the hook runs, so waiting there costs nothing extra. That
   measurement is Claude-Code-only. Nothing establishes whether Codex's approval prompt
   is drawn while its hook is still running (same as Claude Code, so waiting is free) or
   only after the hook exits (so waiting would just add up to 90s of dead time to *every*
   Codex permission prompt). Until this is measured, the implementation caps the Codex
   wait at 15s instead of reusing the 90s figure — a conservative, unmeasured default
   traded deliberately against the alternative: a needlessly short window is a smaller
   harm (the device answers a little less often than it might) than every Codex prompt
   hanging for up to 90s would be if the concurrency assumption turned out to be wrong.
   The same manual experiment written up in Risk 2 above answers both open questions in
   one run: watching whether Codex's own approval prompt appears on screen immediately
   (while the hook is still running) or only after the hook is killed tells you both
   whether expiry falls through safely *and* whether the wait can safely be lengthened.
   This has not been run either.
4. **Editing `hooks.json` re-triggers the trust prompt** ("Modified since last trusted"),
   so every upgrade needs re-accepting. The installer must say so.
5. **A node process per tool call**, now for both tools. Same cost the Claude side already
   pays, but it doubles on a machine running both.
6. **Codex retries before escalating.** Observed order: `PreToolUse` → `PostToolUse` with
   an EMPTY `tool_response` (the sandboxed attempt failed silently) → `PreToolUse` →
   `PermissionRequest`. A naive reading of `PostToolUse` records a completed tool call
   that never ran. We only use it to set `working`, so this is currently harmless — but it
   invalidates any future attempt to derive results from `PostToolUse`.

## Testing

Real captured payloads become repo fixtures, so the tests exercise what Codex actually
sends rather than a reconstruction:

- Codex `PermissionRequest` → record with `status:"asking"`, `agent:"codex"`, correct
  title/detail/options, and **empty stdout**.
- `SessionEnd` → record deleted.
- Merge: a hook record and a pull record for the same id produce exactly one row, hook
  data winning.
- `install.sh` / `uninstall.sh` round-trip on `hooks.json`, including preserving a
  pre-existing unrelated hook — run against a throwaway `$HOME` in
  `claude-hooks/test-install-cycle.sh`, which already has the harness for this.
- The timeout question in Risk 2 needs a live interactive session, not a fixture.
