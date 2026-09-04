# Claude Code hooks, asks and remote answering

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](README.md). The rules an agent must not miss stay in
[`../CLAUDE.md`](../CLAUDE.md).

---

- **Remote answering — WHICH EVENT WE BLOCK ON IS THE WHOLE TRICK, and it was measured, not
  reasoned.** For answerable prompts the hook publishes an `ask` object (pid, single-line-flattened
  ≤34-char title, ≤1400-char detail, ≤4 option labels of ≤32 chars, and — only when something is
  actually described — a parallel `optDescs` array capped at 96 BYTES each) in the session file so
  the device can display it. **Every one of those text fields is ASCII by the time it is written**;
  the caps were characters against a byte guard until that was reconciled, which is the byte-budget
  note under the device line buffers. Whether it then **waits** depends entirely on the event:
  - **`PermissionRequest` → WAIT.** Claude Code shows its dialog *while this hook runs*, so waiting
    costs the Mac nothing: the Mac dialog and the device's buttons are both live and the first
    answer wins. The hook blocks up to 90s (settings.json hook `timeout` is 100s to match) polling
    `~/.claude/deckhand-answers/<session_id>.json`.
  - **`PreToolUse` (`AskUserQuestion`/`ExitPlanMode`) → NEVER WAIT.** The *tool* draws that dialog
    and it doesn't run until the hook exits, so nothing is on screen while you wait. Publish the
    ask for display only, then exit (~30ms).

  Evidence, from 3066 real events in `~/.claude/deckhand-session-hook-debug.log` (re-derive it there
  before changing this): 310 `PermissionRequest` prompts resolved on a smooth 2–60s human-response
  curve with **no spike at the 90s timeout** — impossible unless the dialog was on screen the whole
  time. Meanwhile three `AskUserQuestion` `PreToolUse` events sat at **exactly 90.1s**, the full
  timeout, answerable nowhere but the device. That second case shipped once as the unconditional
  behavior and read as a bug ("when Claude Code asks questions, the options only show on the
  device") — the fix was to move the wait to the right event, **not** to stop waiting.

  **A question fires BOTH events**, `PreToolUse` first then `PermissionRequest` ~0ms later, and the
  `PermissionRequest` payload carries the full `questions[0]` with its real option labels (verified
  against a captured payload). So questions are answerable from the device via their
  `PermissionRequest`, with the Mac's dialog visible throughout — nothing is given up. This is why
  `buildAsk()` checks `tool_name` **before** `hook_event_name`: get that order backwards and a 4-way
  question renders as a generic "Allow AskUserQuestion?" with Allow/Deny.
  `emitDecision()` therefore switches on the **event** for the dialect and on `ask.kind` for the
  meaning: allow/deny for a `perm` or `plan`, and for a `question` a **deny whose message carries
  the chosen option** (there's no native channel for handing Claude a selected answer).
  Because the Mac usually wins the race, `waitForRemoteAnswer()` also watches the session record and
  **bails the moment its `ask` disappears** (the next event rewrote it) — 1.8s measured instead of
  holding a node process for the full 90s on every prompt.
  `remoteAnswer` (in `~/.claude/deckhand-secret`, surfaced in the heartbeat and every payload,
  toggled by the menu bar's **Answer prompts on device** → `REMOTE on|off`) is **on by default** and
  is just an off switch: off means never wait, i.e. a read-only mirror. Absent/unset reads as on.
  The device keys off the **per-prompt** `ask.answerable` stamped by the hook, *not* the live global
  flag — that's what makes flipping the toggle mid-prompt safe, and it's what marks a `PreToolUse`
  ask read-only while its `PermissionRequest` twin is answerable. For a read-only ask the device
  draws the options as a flat list under "ANSWER ON YOUR MAC" and swallows taps, so it never offers
  a control that can't work (and `visLines` reserves that caption's row, or a full-length detail
  runs into it). The host also drops `ANSWER` lines while answering is off.
  **AN ANSWER USED TO WITHDRAW THE BUTTONS AND LEAVE THE ROW SAYING NEEDS INPUT, for up to
  minutes.** When the wait returns, the hook re-reads the record and deletes the `ask` — but it
  never touched `status`, so the record went out as `status:"asking"` with nothing left to answer.
  **Nothing else recomputes it:** a device answer resolves a question as a DENY, and a denied
  `AskUserQuestion` fires **neither `PostToolUse` nor `PostToolUseFailure`** — measured, 623 of the
  latter in a 3.8MB log and not one of them for `AskUserQuestion` — so status only corrected when
  some unrelated later event happened to rewrite the record: **75s** on one real answer and
  **2m41s** on another. The device half was already right (`handleAskTouch` records `answeredPid`
  and repaints on the tap), so what lagged was purely the status.
  **The fix is CONDITIONAL on an answer having actually arrived, and that is the whole subtlety.**
  The wait has two null exits: if the Mac answered, our ask no longer matches and the guard skips
  it, but a genuine TIMEOUT leaves the Mac's dialog still on screen, so the session really is still
  asking and forcing `working` there would be a lie in the one direction the user cannot detect.
  `claude-hooks/answer-status-check.mjs` drives the REAL hook as a child against a throwaway `$HOME`,
  learns the random `pid` from the published record and then answers it — 11 assertions, and
  `--selftest` catches BOTH the original bug and **the plausible wrong fix** of setting status
  unconditionally, which is why the answered and timed-out cases are asserted as a pair.
  **Its first assertion is a vacuity guard** (an ask really was published), because with a stale
  heartbeat the hook publishes nothing at all and "never created" is indistinguishable from
  "stripped" — the same false negative that cost real time on the `Notification` bug.
  **Found en route: the INSTALLED hook was stale relative to the repo**, carrying an older revision
  of that cap's comment. Comments only, verified by stripping them and diffing, so no behaviour had
  drifted — but `install.sh` copies these files and nothing warns when the live copy falls behind.

  Nothing strips a display-only `ask` — the next event for that session
  (`PostToolUse`/`PostToolUseFailure` → `working`) rebuilds the record without it.
  **The wait is now effectively UNLIMITED for Claude Code, and configurable.**
  `~/.claude/deckhand-remote-wait` holds seconds, or `forever`/`0`/absent for the
  default; a malformed value also reads as the default, deliberately, because
  falling back to a 0ms wait would silently disable remote answering and present as
  the feature being broken rather than misconfigured. Waiting indefinitely is safe
  here for the same measured reason the 90s cap was: Claude Code's dialog is on
  screen throughout, so the wait ends the moment EITHER side answers - a device
  answer returns it, the Mac answering strips the ask and returns null, SessionEnd
  removes the file. A long wait only extends the case where nobody has answered yet.
  **"Forever" is 86340s (23h59m), NOT Infinity, and that is not hedging.** Claude
  Code kills a hook that outlives its settings.json `timeout`, and a *killed*
  `PermissionRequest` hook is an untested state - the 310-sample evidence only ever
  covers a hook that exits on its own, because the old 90s wait always finished
  inside the old 100s timeout. Infinity would guarantee hitting that untested path
  on every unanswered prompt, so the invariant is kept instead: **the hook always
  self-exits before it can be killed.** `HOOK_TIMEOUT_S` (86400) in the hook and the
  `timeout` written by `install-hooks.mjs` are a PAIR - raise the wait without
  raising the timeout and the kill comes back silently.
  **Codex stays at 15s regardless of the config, on purpose.** That measurement is
  Claude-Code-only, and Codex's spec records two unverified risks: whether an expired
  `PermissionRequest` hook falls through or resolves as a DENIAL, and whether its
  approval UI is concurrent or serialised. If serialised, an unlimited wait deadlocks
  the prompt into being answerable nowhere. The failure modes are not symmetric.
  The host mirrors the same config file for the device's countdown (`ask.sec`) and
  **omits the field entirely when the wait is unlimited**, so the device draws no
  countdown rather than a 24-hour one; reading the same file is what stops the two
  drifting when one is edited.
  Two hard rules: the hook waits **only** when `/tmp/deckhand-<uid>/host-alive` (host heartbeat, written
  every tick) is fresh, says `connected`, **and** doesn't say `remoteAnswer:false` — otherwise every
  prompt would stall 90s for nothing — and it must never write anything to stdout **except** a
  genuine `emitDecision()`, because any stray JSON on a `PermissionRequest` hook's stdout can
  auto-allow/deny the dialog.
