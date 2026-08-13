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
- An ended Codex thread disappears at once.
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
| `SessionEnd` | *delete the record* | this is what kills the 20-minute ghosts |

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

1. **The hook `timeout` must exceed the 90s remote wait.** `settings.json` uses
   `timeout: 100` for exactly this reason; `hooks.json` has its own `timeout` field and
   needs the same. Getting it wrong kills the hook mid-wait.
2. **UNKNOWN, and it must be tested before shipping: what does Codex do with a
   `PermissionRequest` hook that times out?** Claude Code falls through to its own dialog.
   If Codex instead treats expiry as a denial, then every prompt nobody answers on the
   device would be denied — a correctness problem, and it would force the wait to be much
   shorter or removed for Codex.
3. **Editing `hooks.json` re-triggers the trust prompt** ("Modified since last trusted"),
   so every upgrade needs re-accepting. The installer must say so.
4. **A node process per tool call**, now for both tools. Same cost the Claude side already
   pays, but it doubles on a machine running both.
5. **Codex retries before escalating.** Observed order: `PreToolUse` → `PostToolUse` with
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
