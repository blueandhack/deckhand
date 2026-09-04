# Codex support

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## Codex support

Codex threads show up in the same SESSIONS list. Since 0.147.0, Codex CLI ships
a hooks system Deckhand can push through, the same way Claude Code state
*arrives* — a hook invoked on every event. Where that isn't available yet (the
hooks trust prompt hasn't been accepted, or the Codex version predates hooks),
the host falls back to **reading Codex's own files** — the per-thread rollout
JSONL under `~/.codex/sessions/YYYY/MM/DD/`, for the working directory, model,
task start/finish events, and quota.

Two consequences are worth knowing before you rely on it:

- **Codex threads now push their own state, and can be answered from the
  device.** `./install.sh` registers Deckhand's hook with Codex CLI
  (0.147.0+) in `~/.codex/hooks.json` — the same script that serves Claude
  Code, invoked with `--agent=codex` so it knows which tool called it. Once
  registered, start Codex and accept **"Trust all and continue"** on its
  hooks review prompt; hooks do nothing until you do, and editing them
  (including a Deckhand upgrade) asks again. After that, a Codex thread
  waiting on a permission prompt shows NEEDS INPUT exactly like a Claude Code
  session. Ending a thread removes its pushed record at once — but the
  rollout-derived fallback row for that same thread still ages out on its own
  over ~20 minutes, so an ended Codex thread can still linger on screen until
  then.
  The file-reading approach described above **remains as a fallback**, for
  Codex installs where the hooks trust prompt hasn't been accepted yet (or
  Codex versions that predate hooks): it still shows WORKING/READY from the
  rollout files, just without NEEDS INPUT or answering. The host merges a
  pushed and a pulled record for the same thread into one row rather than
  showing it twice.
  One thing about this is still unverified: what happens if a permission
  hook's wait (90s) is somehow exceeded rather than answered in time — whether
  Codex falls through to its own prompt (safe) or treats it as a denial. This
  can't be tested outside Codex's interactive TUI (`codex exec` always
  bypasses permissions), so it hasn't been. In practice the hook exits well
  inside its 100s timeout budget, so this only matters for a pathological
  overrun, not ordinary use.
- **Codex quota is one number**, read from whatever `rate_limits` record was
  seen most recently. There's no endpoint to ask (unlike the Claude side's
  OAuth poller), so if Codex stops running the number stops being updated — the
  device dims it past 15 minutes for the same reason stale Claude quota is
  flagged. A value read from a file that stopped being written is not a live
  reading.

Threads Codex spawns for itself (auto-review, guardian) are skipped: nobody is
waiting on those, and they'd crowd the six-row list.
