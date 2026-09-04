# Board-1 defects, unverified claims and open items

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](README.md). The rules an agent must not miss stay in
[`../CLAUDE.md`](../CLAUDE.md).

---

#### Pre-existing BOARD-1 defects this port surfaced, and why none is fixed

Re-deriving a layout from first principles turned out to be an **audit of the original**. **Ten real
board-1 defects** fell out (across eleven numbered slots — one report turned out to be false), plus
one board-2-only defect that *was* fixed (the farewell flush, above). None of the ten is fixed here,
for one reason: **every fix would move board 1's binary inside a diff whose entire claim is
byte-identity**, hiding a behaviour change where nobody would look for it. They belong on their own
branch off main.

They are recorded, with arithmetic and a severity order, in
**`docs/board-1-known-defects.md`** — including the one reported defect that turned out **not** to
be real, kept as a correction rather than deleted, because a false defect costs a future maintainer
either the time to disprove it or a no-op "fix" that breaks byte-identity for nothing. The worst live one, for orientation: **the session
detail screen draws two footer strings at the same `MC_DATUM` y**, so the "answer this one on your
Mac" notice is painted out by the history hint — a message about where an action must happen,
silently erased.

#### What is NOT verified on board 2, stated plainly

- **The two-`conn_id` NimBLE demux has never run.** Same reason board 1's Bluedroid demux has never
  run: two host processes on one Mac share a single ACL connection to the peripheral, so proving it
  needs a **second radio**. It is this feature's one untested load-bearing path, on both boards.
- **The `TEXTPROBE` board-1↔board-2 diff has never been run**, because board 1 was physically
  disconnected throughout. The artifact is committed (`text-widths-board2.txt`) and the comparison
  is the one command in `text_probe.h`.
- **Board 1's on-glass touch check after the HAL extraction** was substituted by a binary-level
  comparison rather than a tap: `getTouchPoint`, `readRawTouch`, `fitAffine`, `waitForStableTouch`,
  `loadOrRunCalibration`, `applyScreenRotation` and `drawCrosshair` are instruction-and-operand
  identical, and `runCalibration` is the same size with an identical mnemonic stream. That is strong
  evidence and not a tap.
- **The SETTINGS page's ~140px of trailing air below the DEVICE card** is real and confirmed on the
  glass. It is a layout judgement nobody has made yet, not a bug.

#### Outstanding board-2 items, found by writing this documentation

These are gaps between what board 2 does and what the rules on this page already require, not port
regressions. Recorded here rather than in a scratch file because a known gap nobody wrote down is
indistinguishable from a bug nobody found — and **an entry that has been FIXED is corrected in
place rather than deleted**, because the only thing worse than an unrecorded gap is a list of
"outstanding" items a reader cannot trust to be outstanding.

- **RESOLVED, AND THE ENTRY IS KEPT AS A CORRECTION RATHER THAN DELETED: the two strings that
  promised a touch wake board 2 does not have.** This bullet described `settings.ino`'s POWER OFF
  hint and its confirm dialog as both saying "touch to wake", and said the fix was blocked because
  routing them through `WAKE_HINT` would move board 1's rodata. **Both have been
  `#if BOARD_HAS_TOUCH_SLEEP_WAKE`-conditional since before the settings-redesign branch** — the
  resolution was not `WAKE_HINT` at all but a second `drawConfirm`/`uiHint` call under the same
  flag, which changes board 1's binary by nothing because board 1 compiles the arm it always had.
  The entry stood as "not fixed" long after it was, which is worse than a gap nobody wrote down: a
  reader consults this list to know what still needs doing, and a stale item spends someone's time
  proving it is stale. **The general form is the one this branch's `BOARD_HAS_MIC` paragraph
  already names — a comment is not parsed, so nothing can catch prose that has stopped being true;
  the only defence is reconciling the list whenever the code it describes moves.**
- **THE SAME CLASS, FOUND ON THE THIRD DIALOG AND FIXED HERE.** `CFM_RECAL`'s note read
  `"5 taps; current setup kept if it fails"` on both boards, and on board 2 `runCalibration()` is a
  stub — the touch controller is inside the ST77922 and factory-aligned, `BOARD_TOUCH_NEEDS_CAL` is
  0 — so there is no 5-tap run and no previous mapping to keep: **both halves of the sentence were
  false, in a confirm dialog, whose entire documented job in this repo is stating the consequence.**
  It is now board-conditional the way the POWER OFF note beside it already was, board 1's arm
  character-identical. **The CALIBRATE TOUCH button itself is deliberately still there.** By this
  file's own "never offer a control that cannot work" rule it arguably should not be — that is a
  real open question, listed here rather than settled — but the mock the user approved carries the
  button, so it is their call and not a fix to make in passing.

**TWO SHARED-CODE BUGS WERE FIXED DELIBERATELY, and both are the same lesson in different
clothes.** Board 1's binary moved for each, which is why the byte-identity check is now
`board-baseline.mjs` (see Commands).

- **The history list went BLANK after reading one entry in full**, recovering only if you paged.
  State was destroyed, not a redraw missed, and the recovery is what proves which: the `hist` reply
  handler cleared `histCount`/`histArenaUsed` **before** knowing what kind of reply had arrived. An
  `item:<n>` reply carries a `full` object and **no `items` array at all** (`sendHistoryItem` sends
  exactly `{hist:{id, full}}`), so the page's rows were wiped and the items loop had nothing to
  refill them with. PREV/NEXT re-REQUESTS a page, and that reply does carry items — which is
  precisely why it presented as a repaint bug. The fix is ordering: handle the single-entry reply and
  return before touching any page state. **A parser that mutates shared state before it has
  identified the message is the bug class**, not this one instance.
- **PAIRED MACS: the live-Mac marker was INVISIBLE and two same-named Macs were indistinguishable.**
  The marker was a middle dot and both faces declare `0x20..0x7E`, so it drew as nothing on both
  boards — the third instance of the trap already documented for the `CLAUDE/air` tag separator and
  `fitText`'s three ASCII dots. And two MacBook Pros both report `...-MacBook-Pro`, the same
  collision that makes `macTag()` emit `pro` twice, which matters far more here than on a session row
  because **this page's controls are destructive and per-row**: which `x` forgets which Mac was a
  guess. A shared label now appends the first 4 hex of `hostId` — unique by construction, nothing new
  on the wire — and the **label** is what gets trimmed, never the suffix, measured with `fitText`
  because `uiListRow` draws with no width bound and `drawString` paints an opaque box that would rub
  out the card border.

**Identity is `hostId`, and it is NOT derived from a MAC address** — `crypto.randomBytes(4)`,
persisted. Two Macs with identical hostnames have different hostIds, so pairing, key selection and
answer addressing were never ambiguous; only the *display* collided. A MAC address would be strictly
worse: CoreBluetooth never exposes the local BT address and BLE uses rotating private addresses (the
same opacity that leaves `BLE_CHUNK_SIZE` hard-coded at 20 because noble reports no MTU), macOS uses
private per-network Wi-Fi addresses, six bytes of hex cannot be read in a 6-character tag lane, and
it is needless PII on the wire.

**USB and BLE are independent, not fallback-of-each-other.** Both are always enabled on the
device simultaneously, and `host/index.mjs` sends the same computed payload to whichever are
currently connected each tick — it's normal for both to be live at once (`via=usb,ble` in the
log). This is a deliberate change from an earlier classic-Bluetooth-SPP design: SPP let the host
just open a different serial port path with almost no code change, but turned out to be
unreliable on this Mac (macOS's classic-BT stack would silently accept writes into a connection
with no real over-the-air session — confirmed via a heartbeat that never arrived — and that
failure recurred even after a full unpair/restart/re-pair). BLE (a custom GATT service using the
Nordic UART Service UUIDs) replaced it because BLE is far more actively maintained on macOS,
since it's what nearly all modern accessories use.

On the firmware side, USB is a polled `Stream` (`pumpStream()` in `loop()`). BLE data arrives
via the RX characteristic's `onWrite()` callback, which runs on the Bluetooth stack's own task
(`BTC_TASK`), **not** loopTask — so `onWrite()` does exactly one thing: copy the bytes into a
FreeRTOS stream buffer (`bleRxStream`) that `loop()` drains. Both paths then funnel into the
same `feedChar()` / `processCompletedLine()` logic on loopTask. **Never render, beep, or touch
any driver (TFT/LEDC/ADC) from a BLE callback**: an earlier version processed lines inline in
`onWrite()` and crash-looped with `assert failed: xTaskPriorityDisinherit` (a driver mutex
locked on loopTask, released from BTC_TASK) plus `task_wdt` IDLE0 timeouts. It survived months
only because the BLE copy of each line usually found every draw-cache already updated by the
USB copy; per-second UI fields and the beeper's LEDC calls made real cross-task work common
and it finally tripped. On the host side, BLE scans by **advertised name** ("Deckhand"),
not by service UUID — the 128-bit custom UUID usually doesn't fit in the 31-byte primary BLE
advertisement alongside anything else, so a UUID-filtered scan can miss the device entirely.

**The two files under `~/.claude/` are not part of this repo but are load-bearing.** They're
registered in `~/.claude/settings.json` (`statusLine` + `hooks`) and are the *only* source for
two things `host/index.mjs` cannot get any other way:

- FALLBACK "% of plan quota used" (`deckhand-statusline.mjs`, via `rate_limits.five_hour` /
  `.seven_day` in the statusLine JSON). The statusLine only runs in *terminal* sessions (the
  desktop app and VS Code extension never invoke it), so this cache can go hours-stale. The
  PRIMARY quota source is now in `host/index.mjs` itself: it polls Anthropic's OAuth usage
  endpoint (`api.anthropic.com/api/oauth/usage`, the same data Claude Code's `/usage` screen
  shows) every 5 minutes, authenticating with the OAuth token read from the macOS Keychain
  ("Claude Code-credentials"), falling back to the statusLine cache on any failure (it
  rate-limits bursts with HTTP 429; back off, don't hammer). The host **does refresh** that
  token when it's expired/near-expiry (see the token-refresh note below) — the always-on host
  can't rely on a Claude Code surface being open to renew it.
- Per-project session status (`deckhand-session-hook.mjs`, via `SessionStart`, `UserPromptSubmit`,
  `PreToolUse` matched to `AskUserQuestion|ExitPlanMode`, `PermissionRequest`, `PostToolUse`,
  `PostToolUseFailure`, `Notification`, `Stop`, `SessionEnd`). Status is one of `working` /
  `asking` / `waiting`, keyed by `session_id`, one JSON file per session, deleted on
  `SessionEnd`. **`PermissionRequest` is the only permission-prompt signal that fires in every
  surface** — the desktop app never fires the `Notification` hook at all (verified: a desktop
  session with 650+ logged tool events and many allow/deny dialogs produced zero Notification
  events), so before `PermissionRequest` was registered, desktop permission prompts showed as
  `working` instead of `asking`. `Notification` stays registered for terminal sessions: it maps
  to `asking` only when `notification_type` is `"permission_prompt"` (confirmed via a captured
  real payload); any other Notification (idle nudges) maps to `waiting`, which can't incorrectly
  override an already-correct `waiting` status the way blindly mapping to `asking` once did.
  `PostToolUseFailure` maps to `working` so a *denied* permission clears `asking`.
