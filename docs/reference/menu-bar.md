# The Mac menu-bar app

> Extracted verbatim from CLAUDE.md. **The measurements are the point** - they were
> taken on real hardware at a specific commit, so do not paraphrase or "tidy" them.
> If you change the behaviour, change the number and say what you measured.

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

## Where the code is

`mac-app/Sources/`, compiled as ONE module (`swiftc -O -wmo`) by both `mac-app/build.sh`
and `release/build-release.sh`, which pick up every `*.swift` under it - a new file needs
no build edit. Until 2026-11-11 this was one 6,598-line `DeckhandMenuBar.swift`; the split
moved lines and changed no behaviour, and that was measured rather than assumed:
`--pace-check`, `--pair-check`, `--legibility-check` and `--sound-check` printed
byte-identical output before and after, `--menu-dump` against the live host matched line
for line, and `--bar-preview` / `--icon-preview` wrote byte-identical PNGs. The Sparkle
(`-D SPARKLE`) build compiled from the new layout too.

| folder | what |
|---|---|
| `main.swift` | the ONLY top-level code: the app and its delegate, each `--mode` in the original order, then `app.run()` |
| `App/` | paths and bundle detection, the cached SMAppService state, `AppDelegate` (the menu itself, the watchdog, start/stop) |
| `Status/` | reading the host: heartbeat, tick-line parsing, `HostStatus`, pace arithmetic |
| `Menu/` | the menu-bar item and its quota bar, the dropdown's rows, the ask sound and Mac icons, session targets, the paper boat, `--menu-preview`'s renderer |
| `Pairing/` | wireless pairing: the pure state machine and `PairWindow` |
| `Release/` | the released app only: bundled host, `Hooks` (Claude Code + Antigravity), uninstall |
| `Setup/` | first-run setup: `SetupWindow` renders, `SetupFlow` decides |
| `Settings/` | the Settings window: model, panes, window controller |
| `Modes/` | every command-line mode, one function each (`modePaceCheck()` is `--pace-check`): `CommandModes` (`--host`, `--setup-do`, `--open-session`), `Checks`, `PairCheck`, `Previews` |

**A new `--mode` is a function in `Modes/` AND a call in `main.swift`.** Swift allows
executable top-level statements only in `main.swift`, and the modes run in call order -
the first one whose flag matches either exits or runs the app itself.

**Globals outside `main.swift` initialise lazily** (on first use), where the single file
initialised them in source order. Nothing here depended on the order - every global is a
constant, a path or a font - but a global with a SIDE EFFECT in its initialiser would now
run when first touched, not at launch.

**The menu-bar app must drive launchd, not go around it, and going around it fails
quietly.** `mac-app/DeckhandMenuBar.swift` (since 2026-11-11 split into `mac-app/Sources/`) used to start/stop with `pkill` + `open` and
carried its own watchdog. Once the `KeepAlive` LaunchAgent exists that is actively
wrong: a `pkill` stop is undone within ~1s (measured - pid 48211 came back as 48230),
so **Stop looks broken**; an `open` start launches a host OUTSIDE launchd while launchd
may spawn its own, giving two processes contending for one serial port; and the app's
watchdog becomes a second supervisor racing the first. It now shells out to
`deckhand-service.sh start|stop` when `~/Library/LaunchAgents/com.deckhand.host.plist`
exists, and suppresses its watchdog in that case - launchd restarts a dead host within
a second and survives reboots, which the app cannot. Unsupervised, the old path and the
watchdog both remain, because there is then nothing else doing the job.
**CORRECTED 2026-11-07: "launchd is strictly better" is true of a host that EXITS and false
of one that HANGS.** KeepAlive restarts a process that dies; a frozen one keeps its pid and
launchd is satisfied. Measured on the released app: a host stopped with `SIGSTOP` sat with
a 47s-old heartbeat, the menu said "Stopped", and nothing would ever have brought it back.
The watchdog (`AppDelegate.watchdog`) now runs supervised too, as launchd's missing hang
detector rather than a second supervisor: after 30s without a heartbeat it restarts the
host THROUGH launchd (`launchctl kickstart -k`), never around it, with a 60s cooldown, and
writes a `menu-bar watchdog:` line into `host.log`. The 30s (versus 20s unsupervised) is
so it never races launchd bringing a crashed host back by itself, which measured at
about 1s. Measured after the change: a SIGSTOPped host replaced in **51s** (12s for the
heartbeat to count as stale, the 30s wait, ~6s for `kickstart -k` to clear a stopped
process); a `kill -9` replaced by launchd in **1s**.

**Start, Stop and Restart show what they are doing, then what happened** (2026-11-13, user
report: "when I click restart, or stop, the response is none"). Two causes. "Running" is
the heartbeat's AGE (< 12s), so a stopped host looked alive for up to 12s, and a restarted
one writes the same file as the old one - nothing on screen changed at all. And
`stopHost()` ran `pkill`/`unregister()` on the main thread, freezing the window that should
have answered. Now (`App/HostAction.swift`): a click enters an in-progress state at once -
a spinner and "Stopping Deckhand..." in Settings, Restart/Stop disabled, a disabled
"Stopping Deckhand..." menu item - the work runs off the main thread, and the heartbeat is
polled every 0.5s until the change is REAL: stopped = no live heartbeat, started = a live
one, restarted = a live one from a different **`pid`** (a new heartbeat field). The result
shows for 4s ("Restarted."); no change within 20s says so in orange, for 30s, with the log
as the next step. The poll timer is on the run loop's `.common` modes, because a
`scheduledTimer` does not fire while a menu is open. The host side: on SIGTERM/SIGINT/SIGHUP
it deletes the heartbeat if it is still ITS own (`removeOwnHeartbeat()`), so a stop reads as
stopped at once rather than after 12s; the session hook already treats a missing heartbeat
as "no display", which is now simply true sooner. `--host-action-preview <dir> [--dark]`
renders the real General pane and prints the real menu lines in all six states without
starting or stopping anything - looked at for this change. **Not yet measured on a running
app:** the click-to-"Stopped" time with the heartbeat removal live, and the restart's pid
change, both need a build of this code.

**`SMAppService.status` IS A SYNCHRONOUS XPC CALL AND MUST NOT RUN ON THE MAIN THREAD.**
Measured with `sample` on the released app: ~35ms of every 3s refresh blocked in
`+[SMAppService sendSMDRequest:reply:error:]` (the agent's status and the login item's),
which is a menu frozen for as long as the background-task daemon takes to answer - and at
login or under load that is not 35ms. `ServiceState` now reads both (and the hooks'
state, which is file I/O) on a background queue every 15s and right after anything the
app does to a service; the main thread only reads the cached answer. Re-sampled: zero
`SMAppService` frames on the main thread.

**What the menu-bar ITEM shows: shape is the link, badges are the device's job when
the device is absent, and colour carries nothing at all.** The boat is `.solid` when a
device is actually connected and `.outline` when it is not (`barBoatStyle`) - it stands
for the LINK, not the process, which is why it no longer keys off `running`. Beside it,
left to right: quota `5h·7d`, then the live sessions BY STATUS in the host's own urgency
order - `■1` needing input, `○1` waiting on you, `●1` working. Those three PARTITION the
list the way the menu's rows do, one glyph per session, so `■1 ○1 ●1` is three sessions
and reads as three; `●` briefly meant "every live session" and was split when waiting
arrived, because a total that already contains the badge beside it invites adding them
up. The usage and session badges are the device's USAGE and SESSIONS
tabs standing in for a screen that isn't there, so by default they appear only while no
device is connected and go quiet when one is back; the needs-input badge is not gated
that way, because a prompt blocking your work is worth saying either way. Absent is
always the resting state - no badge at zero, and none at all from a stale host, since
`readStatus` only reads the log while the heartbeat is fresh.
Four things are load-bearing:
- **`contentTintColor` is `nil`, deliberately, and grey/orange tints were REMOVED
  rather than fixed.** They never reached the screen: with the host running and no
  device the bar drew a BLACK boat, not an orange one, because macOS renders a status
  item's template image in its own menu-bar colour - which over a light-ish wallpaper is
  black even in Dark Mode - and that overrode the tint. A colour that is silently
  ignored is worse than no colour. Cost, accepted: stopped and device-offline both draw
  the hollow boat, and only the menu's status line ("Stopped" vs "Running · device
  offline") tells them apart.
- **Numbers next to each other need SHAPE to separate them**, which is why the
  needs-input count gained a `■` when the session counts arrived - the same three glyphs
  the menu's rows and the device already use, now meaning exactly what they mean there.
  Each badge is omitted at zero, independently, so an absent `○` says "none waiting"
  rather than "not shown" - which only holds because the whole label is empty at rest.
- **Monospaced DIGITS (`F_BAR`), not cosmetic.** These percentages are rewritten every
  few seconds and a proportional font shifts the item's width on every digit change,
  nudging every other menu-bar icon sideways on a timer.
- **CODEX'S QUOTA IS IN THE BAR TOO, tagged `CX`, behind its own toggle (`Codex usage`,
  `barShowCodex`).** Added 2026-11-07. It sits after Claude's two figures:
  `54%▲ · 72%▲  CX 20%`. The tag is the device's own `CX`, in secondary colour, and it
  replaces the `·`. A third bare percentage would be ambiguous whenever one of the other two
  was missing, and Codex is a different agent's quota rather than a third window of the same
  one. Its staleness and window are its OWN (`cxAgeSec`, `cxWinMin`), so a stale Claude reading
  does not cost Codex its pace and the reverse. `--pace-check` asserts both directions by name,
  and both fail when the code is reverted to Claude's age (verified by mutation). The toggle has
  its own switch, not a share of `Quota usage`, because a user who wants one figure should not
  have to accept the other. Like the other mirror badges it obeys `Only while no device is
  connected`, since the device's USAGE tab draws a Codex card too. Defaults ON. That costs a
  Mac that never runs Codex nothing, because no reading means no `CX` at all. The tooltip gets
  a `CX (Codex):` line that names the reason when there is no pace: the reading is stale, or
  Codex published no window length. `paceWords` would otherwise blame a missing reset time for
  both. Checked on a `--menu-preview` render in light and dark against the live host.
- **The five toggles under `Menu bar shows` read `object(forKey:) as? Bool ?? true`, not
  `bool(forKey:)`.** `UserDefaults.bool(forKey:)` returns FALSE for a key nobody has
  written, so reading it directly would ship an app whose bar is blank until three things
  are switched on by hand. `--menu-dump` prints the composed label and the submenu's
  checkmarks, which is the only way to verify any of this without eyes on the bar -
  `screencapture` needs a TCC grant the host process doesn't have.
- **Clicking a session row JUMPS TO THE APP that owns it, and which app that is comes out
  of the ENVIRONMENT rather than any search.** The hook is a child of the `claude` process,
  so it inherits `__CFBundleIdentifier` (the bundle that launched Claude Code - VS Code,
  a terminal, the desktop app; the actionable half, since NSWorkspace resolves it) and
  `CLAUDE_CODE_ENTRYPOINT` (Claude Code's own name for the surface, e.g. `claude-vscode`).
  `owningApp()` reads exactly those two, so identifying the app costs two env lookups and
  NO child processes on a file that runs for every tool call in every session on the
  machine. Verified by running the same read from a child of a live session.
  Two other routes were tried and rejected: `lsof` on the transcript finds nothing, because
  Claude Code appends and closes rather than holding an fd, so there is no pid-to-session
  mapping there; and walking the parent chain with `ps` does work (every live `claude`
  traces to its host app) but costs several spawns per lookup for an answer the environment
  already has.
  The click resolves in three tiers (`sessionTarget`), because "jump to the app" means
  different things per surface: an EDITOR session opens its workspace folder with that app,
  which brings the existing window forward; a terminal or the desktop app is merely
  ACTIVATED, since there is no way to focus one terminal tab and opening the folder would
  spawn a new window; and an unknown or not-running app REVEALS the folder in Finder as
  this menu always did. The not-running check is load-bearing - without it, clicking a
  stale row would LAUNCH an editor for a session that no longer exists in it.
  **The folder to open is the LOCK FILE's workspace, never the session's own path.** A
  session's `path` is its live cwd and is routinely a subdirectory (this repo reports
  `.../deckhand/host`), and opening that in VS Code spawns a NEW window on the subfolder
  instead of focusing the one already open. `~/.claude/ide/<port>.lock` is written per
  WORKSPACE - two windows on different folders give two locks sharing one pid - and carries
  `ideName`/`workspaceFolders`, so it is both the window picker and the source of the full
  path. That last part matters because the host's `truncatePath` prefixes `...` past 64
  characters, and **a plain suffix test does not recover those** - measured, on a crafted
  case that failed: truncation can begin INSIDE the workspace folder, so neither string
  contains the other and the match has to look for a suffix of the folder that is a prefix
  of the kept tail (with a 6-character floor, since a 2-character overlap matches almost
  anything and picking the wrong window is worse than falling back).
  Only surfaces MEASURED to be editors get the workspace treatment; `claude-vscode` is the
  one observed on this machine, JetBrains is included on the same naming pattern and is
  UNVERIFIED, and the values a terminal or the desktop app report are still unknown - no
  such session was running when this was built, and guessing them would be inventing
  behaviour. Anything unrecognised falls through to activate-only, which is safe.
  `--open-session [<id-prefix>] [go]` prints what a click would do for every session,
  resolved by the same function the click calls, and only acts when given `go` - a menu
  cannot be clicked from a script or screenshotted, so the whole path is otherwise
  unverifiable by hand. The row TOOLTIP is generated from that same resolver, so it can
  never promise Finder and then open an editor.
- **The boat is drawn in the logo's mid-blue and is therefore NOT a template, and the
  colour was measured, not chosen.** `isTemplate` is what strips colour - as a template
  macOS renders the shape in its own menu-bar colour and discards ours, which is why
  `contentTintColor` did nothing - so a colourful icon is exactly an icon that gives up
  following the system. That means it must stand on its own against BOTH bars.
  `DECK_BLUE` (#2F76B8, the midpoint of the tile gradient in `docs/logo.svg`) scores
  **3.01** against a dark bar and **4.37** against a light one, clearing Apple's 3:1
  non-text threshold on each. Every other logo colour fails one side: #1B5FA6 drops to
  2.21 on dark, #4C9BE0 to 2.72 on light, and the cream #FBF4E9 to **1.00** - invisible -
  which is what killed the obvious "cream sails, blue hull" two-tone, since half the boat
  would vanish depending on the wallpaper. Re-measure before changing it.
  `Colourful icon` (Settings › Menu Bar since 2026-11-07; default on) returns the monochrome template, which is not a
  lesser fallback: it is the only version that follows light and dark bars, and which one a
  wallpaper favours cannot be decided from the code. Two consequences worth knowing: a
  coloured image does NOT invert to white while the menu is open and the item is
  highlighted (it sits on the highlight tint, like every other coloured menu-bar icon),
  and `--icon-preview` now renders colour rows AS-IS while still faking the system tint for
  the template rows - painting our own tint over a coloured icon would show a colour the
  bar never renders.
- **The Mac's name (Settings › Devices › *Name* since 2026-11-07; it was `Settings > Mac
  name...`, an alert with a text field) names this Mac on the device** - the text tag beside its sessions
  and projects once a second Mac connects - because the automatic tag (the hostname's last word)
  collides between two Macs of one model. It writes `MACTAG <name>` to the trigger file, like the
  icon picker's `EMOJI`; the row's title carries the current name and where it came from. See
  [`pairing-and-multi-mac.md`](pairing-and-multi-mac.md), "PROJECTS WITH TWO MACS".
- **SUPERSEDED 2026-11-07 by the Settings window (below); kept because the reasoning about
  enablement still applies to what is left in the menu.** **The menu is grouped by KIND: the
  top level is actions, `Settings ▸` holds every preference.** Answer-prompts, Menu bar shows, Needs-input sound and Launch at login used
  to sit in the top-level row, which had grown to three consecutive submenus and pushed
  Quit down the menu with nothing saying which items merely change a setting and which
  one stops the host. The moved items need `target = self` and explicit `isEnabled` set by
  hand - `buildMenu`'s loop only walks the top-level `items` array, and the submenu
  PARENTS have a nil action, which that loop's "an item with an action is a control" rule
  would read as informational and dim. `Settings` stays enabled with the host DOWN (a
  preferences door that only opens while a background process is alive is its own bug),
  while `Device` and `Answer prompts on device` dim with it, since neither can do anything
  without the host.
- **GEMINI USAGE (2026-11-08), read from the Gemini app's own local server.** The interface itself - the descriptor,
  the call, the answer's shape, and how to probe it - is in [`gemini.md`](gemini.md). Gemini keeps no
  usage figure on disk (its logs record `doRefreshQuota` but never the numbers). The Gemini app
  runs an `agy --hub` that writes `~/.gemini/<store>/daemon/hub_<port>.json` (`pid`, `httpPort`,
  `csrfToken`, `lsVersion`), and that server answers `RetrieveUserQuotaSummary` - the
  breakdown the app shows its own users - with quota GROUPS of up to two windows: "Gemini
  Models" (Flash, Pro) 5h + weekly, "Claude and GPT models" 5h + weekly, and "Gemini 4 Argon"
  weekly only (separate on the Pro plan). Measured against lsVersion 2.28.2. **Corrected the
  same day:** the first version read `GetUserStatus`'s one `quotaInfo` per MODEL, which carried
  a single window each (weekly for Argon, 5h for the rest) - so the 5-hour Gemini limit was
  missing, as the user pointed out - and which even disagreed with the summary for Argon
  (0.970 against 0.999 remaining in the same minute). The host (`host/gemini-quota.mjs`) asks
  at most once a minute, in the background, and puts `gmq=Group|5h:used:reset|weekly:...;...`
  and `gmage=` on the tick line. The bar's `GM` column is the general Gemini group, 5h over
  weekly like Claude and Codex, with a real pace mark (both window lengths are named), behind
  its own **Gemini usage** switch; the dropdown's **Gemini** section shows that group as
  5-hour/Weekly, then Argon, then the Claude/GPT group once used. UNDOCUMENTED API: any failure
  - app closed, dead pid, refused call, changed shape - is "no reading", and the column simply
  is not there; a reading 6h old is dropped. Read-only, 127.0.0.1 only, with the token the app
  wrote for local clients. Menu bar only - the device's firmware would label it wrong.
- **THE DROPDOWN IS THREE SECTIONS OF ONE-LINE ROWS (2026-11-07).** It is read to answer, in
  order: is it working, how much quota is left and when it comes back, who is waiting on me.
  So: the connection in two lines (`Syncing with Deckhand-C114`, then `Over USB and Bluetooth ·
  battery 11%, charging` - it was three rows and printed the raw link id `usb:Deckhand-C114`,
  because `viaLabel` predated per-board link names); then a **Claude** and a **Codex** section,
  one line per window named in words (`5-hour`, `Weekly`), number first, bar after, and the
  reset in a right-aligned column set by a real tab stop (`menuColumns`, `MENU_RIGHT_TAB`);
  then **Sessions**, whose header counts by state (`1 needs you · 2 waiting · 1 working`) and
  whose rows put the state and how long on the right (`waiting · 6m`, from the tick's
  `actSec`), with `N more` when the host has more than the six rows. The second line every
  quota row used to carry (`9% elapsed, behind pace`) moved to the row's TOOLTIP with the
  clock time it resets at: it teaches once, and on every row it was half the menu's height.
  A stale section says so once in its header (`updated 35m ago`) instead of on each row.
  Headers are real `NSMenuItem.sectionHeader` items (VoiceOver announces them); they draw dim
  because that is the platform's header style - one built from the system call measured the
  same. Tried and dropped: SF Symbol icons on the actions - this macOS draws no item images in
  a menu (a bare test menu showed none), though it adds its own gear to "Settings...". Read off
  `--menu-shot` captures of the real menu, which is the only instrument that sees it.
- **THE BAR ITEM IS TWO ROWS AND COMES IN FOUR SIZES (2026-11-07), because a wide one gets
  HIDDEN.** It was one line of text, `19%▼ · 41%▼   CX 100% · 62%▲ ■2 ○2 ●1`, MEASURED at
  **275pt** with its own font. On a MacBook Pro every status item must fit between the notch
  and the right edge (~650pt on a 14"), and macOS silently hides whatever overflows; on this
  Mac the items to Deckhand's right already took ~1,220pt. Now each service is a column with
  its 5-hour figure on top and its 7-day below, tiny `5h`/`7d` labels, Codex tagged `CX`
  (it borrows Claude's labels only when its windows are also 5h/7d AND the Claude column is
  shown); session counts stack `○` over `●`; needs-input is a red pill with a count. One
  `NSImage` drawn by a handler (`barImage`), so every colour is semantic and resolves against
  the bar's own appearance. Only ▲ (ahead of pace) is drawn - ▼ and ≈ are reassurance and
  live in the rows and tooltip. Sizes (`BarTier`), same busy content: **Full 156pt, Compact
  133, Minimal 104, Icon only 18** (`--bar-preview <png>` draws all four, light and dark).
  **Automatic** (`BarSize`, the default) starts at Compact on a notched screen and Full
  elsewhere, and steps DOWN when macOS hides the item. The signal was measured, not
  assumed: an item with no room keeps its window but it is parked off-screen (`y = -30`)
  with `window.screen == nil`, while `occlusionState` still reports it VISIBLE - so occlusion
  cannot be used. Other apps' items cannot be measured at all on this macOS (the whole bar
  is one `MenuBarAgent` window), so "am I hidden" is the only answerable question. It tries
  larger again only when the displays change or the Mac wakes; a timer would make the item
  flicker out and back. Settings › Menu Bar shows every size as a live preview (ignoring
  "hide while a display is connected", or every preview was the same bare boat).
  `--menu-dump` prints each size's width and content. Two things found only by looking: the
  Minimal column had no row labels (it relied on a Claude column Minimal had dropped), and
  the dash was invisible on a real dark bar until it went from tertiary to secondary. And
  one by reading the live tooltip: after the 5h reset the host prints `codex=?`, and the
  window parser searched on into `codex2=62%/7d`, labelling the expired window "7d" - every
  tick field is now parsed within its own token.
- **EVERY PREFERENCE IS IN THE SETTINGS WINDOW (2026-11-07), and the menu is for looking.**
  The `Settings ▸` submenu had grown to eleven rows and five nested submenus (a sixteen-row
  icon picker, a device picker, a sound list, five bar toggles, the hooks), with half the
  rows only understandable from a tooltip and the Mac's name edited in an alert. The menu
  is now status, quota, sessions, then **Start/Stop, Pair New Device…, Settings… (⌘,)**,
  Check for Updates… (released app only) and Quit; `Device ▸` and `Open host log` moved
  into the window too. The window (`SettingsWindowController`, SwiftUI panes inside an
  `NSTabViewController` with toolbar tabs) is General / Menu Bar / Devices / Claude Code /
  About, grouped by the question someone arrives with rather than by setting type, and
  every switch carries the sentence its tooltip used to. **It decides and writes nothing
  itself**: each control calls the AppDelegate function that does exactly what the menu
  item did (`setBarPref`, `setAskSound`, `setRemoteAnswer`, `selectDevice`, `setIcon`,
  `setMacName`, `forgetDevice`, ...), the same trigger-file line and the same UserDefaults
  key, and the model re-reads the menu's own heartbeat snapshot on each refresh - only
  while the window is visible. Three things it needed that were found by LOOKING at it,
  not by compiling: an accessory app has no main menu, so without one (`buildMainMenu`,
  never shown) Cmd-V does nothing in the name field and Cmd-W does not close the window;
  SwiftUI hands focus to the first text field, which put a cursor in the name on opening
  Devices and stopped the refresh updating it (`SettingsTabs` clears it on every tab
  switch); and a dev build reported the released app's working hooks as "Need repair",
  because it compared them against a bundled Node it does not have. `--settings-show
  <general|menubar|devices|claude|about> [--light|--dark]` opens the real window on a pane
  against the live host, dry-run, for a capture.
- **The quota rows say when they are STALE, and the age comes from the host rather than
  being re-derived.** `quotaAgeSec`/`cxAgeSec` are computed by the host (it owns the
  oauth-vs-cache choice) and now ride the tick LOG line as `qage=`/`cxage=`, because that
  line is the Mac's only view of the numbers - the menu could otherwise show a percentage
  frozen by a long OAuth back-off as though it were live. Past `QUOTA_STALE_SEC` (900, the
  same threshold the firmware dims its hero number at) the row dims and appends
  `· stale 3h`, and the usage note is SUPPRESSED: "97% used" from an hour ago is not a
  crisis to colour red, it is a number we cannot vouch for. Each row carries the age of
  ITS OWN source - hanging the Codex row off the Claude quota's age was a real device-side
  bug and is not repeated here. Deriving the age Mac-side from a file mtime was rejected:
  it would put the "which reading is authoritative" decision in two places.
- **THE PACE TICK CROSSED TO THE MAC, on both surfaces, because a percentage alone cannot say
  whether you are burning it faster than the clock.** That is the whole reason the device draws
  `drawPaceBar`, and it was just as true of a menu showing the same number. `pacePct` is the
  device's own arithmetic (`100 - resetInMin * 100 / windowMin`, integer division and all, so the
  two surfaces cannot round differently), and it is ONE function feeding three renderings — the
  bar label's glyph, the menu row's tick, and the tooltip's sentence — because a pace that
  disagreed with itself between two rows of one menu would be worse than no pace.
  The windows: 5h = 300 and 7d = 10080 are fixed by the plan and hardcoded, since the tick line
  publishes only how much is LEFT; **Codex's is parsed off the line** (`codex=44%/7d`, which the
  host already prints), and when it is absent that row draws its fill with **no tick** rather than
  assuming seven days — a mark at a position nothing measured is the one thing this must not do.
  - **THE CODEX ROW HAD NO TICK ON A MAC WHERE THE WINDOW WAS KNOWN, until 2026-11-07.** The host
    printed the window in whole days only (`Math.round(cxWin / 1440)`), and this account's Codex
    reports a 300-minute primary window. So the live line read `codex=17%/0d`, which
    `codexWindowMin` correctly refused as "no window". The host now prints hours below a day
    (`/5h`), following the device's own CODEX header in `usage.ino`, and the parser reads either
    unit. An old host's `/0d` still parses as no window rather than as zero. Both forms are
    asserted in `--pace-check`. **Not yet seen live:** the fix reaches the menu only once the
    host restarts.
  - **A STALE reading keeps its digits and loses its pace, on both surfaces.** The comparison is
    against a clock that has kept running while the percentage has not, so the tick and the glyph
    are suppressed rather than corrected. The reading's own age is otherwise NOT subtracted from
    `reset`, and the bound is what makes that a decision: the OAuth poller runs every 5 minutes, so
    the error is at most 1.7 points on the 5h window and 0.05 on the 7d — both inside the deadband,
    i.e. too small to change anything drawn.
  - **`PACE_DEADBAND_PCT` (5) is not a fudge factor.** With an exact comparison, a percentage
    sitting perfectly still (nobody working) still gets overtaken by the clock, so the glyph would
    flip from ▲ to ▼ on a timer with nothing happening — in a menu bar, refreshed every 5s. 5
    points is 15 minutes of the 5h window.
  - **THE TICK IS INSERTED BETWEEN CELLS, NEVER WRITTEN OVER ONE, and the live host caught the
    first version inside a minute.** At 1% used the fill is a single cell and the pace was 3%, so
    the mark landed on cell 0 and replaced the only ink in the bar — `▕░░░░░░░░░`, which reads as
    *nothing used*, exactly the claim the "1% must always show a cell" rule exists to prevent. The
    arithmetic was right and only the LOOK was wrong, which is why it would have survived review.
    Inserting costs one character of width and loses no fill at any percentage; a bar with a pace
    is 11 cells and one without is 10, deliberately, because padding the pace-less case with a
    blank would put a blank exactly where a 0% tick goes.
  - **THE "1% MUST ALWAYS SHOW A CELL" RULE OVERSTATED LIGHT USAGE BY UP TO TEN TIMES, and a
    person reported it on 2026-10-20 ("at 1% the bar shows over 1%").** With whole cells, 1% and
    4% both rounded up to one full block, which is exactly what 10% draws. The rule's intent (any
    usage shows ink) was right, but its unit was too coarse. The fill is now counted in EIGHTHS of a cell
    (`BAR_EIGHTHS`, U+258F..U+2589, the full block's own family), so the final partial cell is a
    left eighth-block: 1% is a one-eighth hairline `▏`, 4% is `▍`, 5% is `▌`, and the resolution is
    1.25%. The bar stays 10 cells wide. The cost, accepted after a `--menu-preview` render: the
    unused part of the partial cell is blank rather than `░`, so a small gap sits between the fill
    and the track. It reads as the fill's edge rather than as a break. `--pace-check` asserts each
    of those glyphs by name, and that 1% and 10% no longer draw the same bar.
  - **A DISABLED MENU ROW IS DRAWN AT ~31% OF FULL STRENGTH, WHICH MADE EVERY READING GREY — AND
    BOTH INSTRUMENTS SAID IT WAS FINE.** This is the most important entry on this page about the
    menu, because the defect was reported by a person looking at the glass after two instruments
    had passed it.
    - **The mechanism.** `buildMenu`'s rule is `it.isEnabled = it.action != nil` — an item with no
      action is information — so the quota rows were disabled. AppKit composites a disabled item's
      **attributed** title at reduced opacity, so `.labelColor` (α 0.847) lands at **0.27**, which
      *is* `.tertiaryLabelColor`. Grey. **No colour can fix it while the row is disabled**, because
      `.labelColor` is already the strongest text colour macOS has — the ceiling is grey by
      arithmetic.
    - **MEASURED TWO WAYS THAT AGREE, rather than inferred.** A throwaway probe popped a real menu
      holding two **byte-identical** attributed titles differing only in `isEnabled`; captured, the
      peak-ink ratio over the menu backdrop was **0.317**. Independently,
      `disabledControlTextColor.alpha / labelColor.alpha` = 0.247/0.847 = **0.292**. The captured
      figure is the one used, being the behaviour rather than a proxy for it.
    - **What it did to colours chosen against the preview:** the percentage 0.847 → 0.27, the `5h`
      label 0.498 → 0.145, and **the bar track 0.259 → 0.076 — fainter than the
      `.quaternaryLabelColor` (0.098) that had just been rejected for being too faint.** Every
      value in the block was crushed by 3.2x.
    - **THE ROOT CAUSE WAS THE INSTRUMENT, not the colours.** `--menu-preview` drew every row at
      full strength regardless of `isEnabled`, and `--menu-dump` prints `.string` and drops colour
      entirely — so a track was tuned on a render that could not show the thing being tuned. The
      preview now applies `DISABLED_INK_RATIO` to each run's alpha. **An instrument that flatters
      is worse than none**, and this is the second time that exact sentence has been earned here.
    - **The fix is to ENABLE the rows that carry a reading** (`q5`, `q7`, `cxLine`, `battLine`,
      `statusLine`, `deviceLine`), which is a deliberate exception to the action-implies-control
      rule. **Cost, accepted:** those rows now highlight under the cursor — **measured, not assumed**
      (a probe popped a menu of enabled nil-action rows, warped the cursor onto one and captured it
      highlighted blue; note a `CGWarpMouseCursorPosition` alone is NOT enough, since menu tracking
      updates its highlight from mouse-moved EVENTS, so one has to be posted). A click dismissing
      the menu and arrow-key navigation stopping on these rows follow from their being enabled and
      are **expected rather than measured**. That is exactly the "silently dead item" the rule
      guarded against; an unreadable reading is the worse failure. The `SESSIONS` header is
      deliberately NOT in that list: it carries no reading, and dim is what says so.
    - **`--legibility-check` names the invariant** and identifies the rows **by reference, not by
      matching their text**: a row's job is a property of what the code put in it, not of whether a
      percent sign survived into the string. Reverting the fix fails it by name, three rows at once.
    - **`--menu-shot` captures BY WINDOW ID, never by screen region**, and that is not a
      refinement. The first version guessed coordinates; the menu failed to appear once and it
      cheerfully wrote a PNG of the editor behind it — the same class of lie as the flattering
      preview. It now finds the window this process owns and **fails loudly rather than writing a
      file** if there isn't one. It also means only the menu is in the image, which matters because
      this runs on someone's desktop. Two ordering facts are load-bearing: `popUp` must be called
      from `applicationDidFinishLaunching` (called inline before `run()` the menu silently never
      appears), and the capture must be dispatched BEFORE it, because `popUp` is modal and blocks
      the main thread for exactly as long as the window exists. An 8s timer is the backstop, since
      the failure without it is a menu left open on someone's screen forever.
  - **Stale readings are `.secondaryLabelColor`, not `.tertiaryLabelColor`.** Dimmer than a live
    reading is the point (0.498 against 0.847), but tertiary's 0.259 made the figure itself hard to
    read, and "we cannot vouch for this number" is not the same claim as "you may not read this
    number". The word `stale` beside it carries the meaning; the dimming only supports it.
  - **The sub-line's pace clause is `.secondary` too.** It is the only place the ▲/▼/≈ vocabulary
    is ever spelled out — the bar label has room for the glyph and nothing else — so it is the
    row's teaching text, and at tertiary it was the faintest thing on a row it exists to explain.
  - **THE BAR IS SPLIT INTO COLOURED RUNS — `quotaBarRuns` returns `[(String, BarRole)]` — because
    FILL, TRACK AND TICK ARE THREE ROLES, AND EACH NEEDING ITS OWN COLOUR WAS LEARNED TWICE.**
    An attributed run is one colour by definition, so a run that spans two roles makes colouring
    them apart impossible; splitting is the whole mechanism.
    - **The TICK, first.** Inheriting the fill's colour made it a red line among red blocks,
      findable only as the notch its own cell's background happened to make. It means "now", which
      is not a status, so it takes a neutral secondary grey against a fill that may be red or
      orange.
    - **The TRACK, second, and this one SHIPPED for months.** The function split at the tick
      ALONE and returned `(pre, tick, post)`, each of which could carry both `█` and `░` — so
      `quotaTitle` drew every cell in the usage colour, putting the empty track in that colour at
      25% coverage immediately beside the fill at 100%. Same hue, adjacent, no boundary: the bar
      read as **one grey smear whose end could not be located**, and the tick added for the bullet
      above was invisible inside it. Fill and track differ in INK, not in shape (which is why
      `▰`/`▱` were rejected), and **ink alone is not separation when both are the same colour** —
      that is the transferable half.
    - **Three roles, three VALUES, and the ordering is load-bearing:** fill at full strength, tick
      a step down (`.secondaryLabelColor`), track a step below that (`.tertiaryLabelColor`). The
      tick must OUTRANK the track it sits in; at the track's own value it goes straight back to
      being findable only as a notch, i.e. the first bullet's defect returning through the fix for
      the second. Tried at `.secondaryLabelColor` and rejected on the render for exactly that.
    - **`.quaternaryLabelColor` was the first attempt at the track and is TOO FAINT**, because it
      compounds: a 25%-ink glyph in a ~25%-alpha colour is ~6% effective, and the bar became a
      block floating in blank space — boundary crisp, SCALE gone, and the Codex row at 0% simply
      empty. Menu rows are also disabled, which AppKit may dim further.
    - **THE TRACK STEPS DOWN WITH THE FILL RATHER THAN BEING A FIXED COLOUR**, and this one was
      caught by fault injection before it shipped: a stale reading dims its fill to
      `.tertiaryLabelColor`, so a track fixed there matches it EXACTLY and reproduces the smear on
      precisely the rows whose numbers are least trustworthy. Stale rows take a quaternary track.
  - **THE NUMBER LEADS AND THE BAR FOLLOWS IT.** The row read label → bar → number, so the one
    figure being reported sat downstream of eleven characters of texture, and the pace glyph — a
    statement ABOUT that figure — ended up detached at the right margin with the bar between them.
    It is now label → bold percentage → glyph → bar. `F_MONO_BOLD` is SF Mono semibold at
    `F_MONO`'s size; SF Mono holds one advance across weights, so the `%3d` column padding still
    aligns, and `--pace-check` MEASURES that rather than trusting it.
  - **The pace glyph is NEUTRAL on the menu row, not the usage colour**, for the same reason the
    tick is: it reports a COMPARISON, not a level. In the usage colour a red `▼` sat beside a red
    96% and read as part of the alarm, when `▼` is the *reassuring* half of the pair — the
    percentage is climbing slower than the clock. A colour that inverts the meaning of the glyph it
    paints is worse than no colour on it. The BAR LABEL still fuses glyph to figure in one colour,
    deliberately: it has no room for the words that carry the meaning here.
  - **Staleness is `.secondaryLabelColor`, NOT `.systemOrange`.** Orange is also the 80%-high
    colour, so a stale row was both the loudest ink in the block and wearing the warning colour —
    it looked like an alarm about usage on the one row whose numbers we explicitly cannot vouch
    for. Staleness is an absence of information; it is already said in words and by the dimmed
    figure beside it.
  - **The reset stays on the SUB-LINE, and that is measured rather than preferred.** With the
    number leading, the main row ends around 232px of a 316px lane, so promoting `resets in` up to
    it looks free — but the widest real case, `  resets in 5d 8h`, is 17 monospaced cells ≈ 112px
    against 84px spare. It would wrap, and a wrapped row note gets no indent, which is a defect
    this menu has already been through once.
  - **`--pace-check` asserts the colouring TWICE, because "can be coloured apart" and "IS coloured
    apart" are different claims and only the second is what you see:** that no run carries both
    inks (structural), and that the two inks came out different colours (visual). It runs over
    fresh/high/critical/stale rows, plus an exhaustive sweep of all 101x101 (pct, pace) pairs
    asserting every run is one kind of ink. Both regressions were fault-injected and each fails by
    name — a fixed-tertiary track fails on `stale`, a usage-coloured track fails on four rows.
    **The ORDER and the WEIGHT are asserted separately, and that gap was found by fault injection
    rather than by reading:** reverting the bold face and reverting the number back to sitting after
    the bar BOTH passed all the colour assertions, i.e. the two changes at the heart of the layout
    were uncovered. There are now named claims for each ("the percentage comes BEFORE the bar, not
    downstream of it"; "the percentage is drawn in the bold face", plus a second one checking the
    face is genuinely bold rather than just differently named), and each fails by name when
    reverted.
    It **prints how many assertions it ran** (53 today) rather than having the figure transcribed
    here, for the same reason the geometry checkers parse the constants they certify: a hand-copied
    total drifts the moment anyone adds a case. The sweep counts as ONE assertion — 10,201 passing
    calls would drown the figure, and the claim really is singular — but it names the first
    offending pair, because "somewhere in 10,201" is not a bug report.
- **THE BAR LABEL IS NOW COLOURED, and that does NOT contradict the "no tint, ever" rule above
  it.** The rule is about the TEMPLATE IMAGE, whose colour macOS overrides with the menu bar's own
  — which is why the boat gave up on colour. An attributed string's `foregroundColor` is honoured,
  so each usage figure takes the same threshold `quotaColour` the menu rows use (factored out of
  `quotaTitle`, because two copies of a threshold is how a menu ends up calling 95% critical while
  the bar an inch above it looks fine). They are SEMANTIC colours, so they follow a light bar and a
  dark one. **The two session counts stay monochrome on purpose**: ■ ○ ● are already separated by
  shape, and hue on top of that is decoration — where a percentage has no shape to spare, so
  colour there is an accent on a figure that already states the fact in digits.
- **Two of the three defects in that work were caught by LOOKING, not by reading**, which is why
  `--menu-preview` now renders the bar label as its own band above the menu: `--menu-dump` prints
  `.string` and drops every colour. (`screencapture` was believed unavailable to this process for
  a long time and is NOT — see `--menu-shot` above; the render still earns its place, because it
  shows both appearances side by side where a capture shows only the one the Mac is set to.) What the render caught: the overwritten cell above; the row note WRAPPING onto a third
  line with no indent (the indent is a literal `\n      `, and a soft wrap gets none), which is why
  the verdict reads `ahead of pace` and not `ahead of the clock` — 53 characters wrapped, 41 fits;
  and an unspaced separator sitting hard against the glyph before it (`96%▲·50%`), which reads as
  one number that has come apart rather than two figures.
  `--pace-check` is the repeatable half — a glance is not — and it **names the regressions rather
  than merely covering them**: reverting the tick to overwrite a cell fails three assertions
  including "1% used keeps a filled cell even with the tick on top of it". It also caught a wrong
  expectation of mine (176m of 300 is 42% elapsed, not 41 — the division truncates), which is the
  cheapest possible place to find out that the Mac and the device round differently.
- **Session titles are clipped at 39, ONE LESS than the host's own 40-character slice, and
  that off-by-one is the point.** A title arriving at exactly 40 cannot be told apart from
  one cut there, so clipping at 40 saw no overflow and left a hard mid-word cut on screen
  ("...recommendations API wor"); one character shorter sends every at-the-cap title
  through `clip`'s word-boundary path so it ends in an ellipsis that says "there is more".
  The row's tooltip carries MODEL and BRANCH - the two facts the row cannot fit and
  nothing else on the Mac shows - and deliberately not the title, which would only repeat
  the same clipped string. `--menu-dump` prints tooltips, since a menu that cannot be
  screenshotted leaves hovering by hand as the only other check.
- **GEMINI SESSIONS ARE MENU-ONLY, and that is a decision about the FIRMWARE, not the menu.**
  "Gemini" on this Mac is Google Antigravity (`agy` and the Antigravity app), so the host reads
  each store's `~/.gemini/<store>/conversation_summaries.db` - Antigravity's own one-row-per-
  conversation index - with `node:sqlite`, read-only, every tick (`host/gemini-sessions.mjs`).
  The rows reach the menu through the tick line's `sessions(N)=` list and are tagged
  `· Gemini`; they are **kept off the device's payload**, because the firmware draws every
  agent that is not `cx` as CLAUDE (`sessions.ino`'s `"CX" : "CC"` and `"CODEX" : "CLAUDE"`),
  so a Gemini row on the wire would be a mislabelled row on the glass. Teaching the firmware a
  third tag is what lifts that. **Measured** (one `agy -p` turn sampled every 300ms, agy
  1.4.8): the index updates LIVE - `RUNNING` + `not_fully_idle=1` during the turn, `IDLE` ~3s
  later - so unlike Codex's `session_index.jsonl` it does not lag; a new row's first sample has
  the zero time `0001-01-01`, which is skipped rather than read as ancient; and one store can
  hold a COPY of another's conversation, which `app_data_dir` (the owner) dedupes. Working is
  `RUNNING`/`BUSY`/`CANCELING` or `not_fully_idle`; everything else is waiting. **NOT
  measured:** there is no `asking` - `CASCADE_RUN_STATUS` has no pending-approval state, so a
  conversation sitting on a permission prompt most likely reads as working. Only the app's own
  store names an app (`com.google.antigravity`), so a click activates Antigravity; a CLI row
  reveals its folder, since nothing records which terminal `agy` ran in. No Gemini QUOTA row
  yet: Antigravity caches no quota on disk, and reading it live means an undocumented Google
  endpoint and its stored OAuth token. `node host/gemini-sessions-check.mjs [--selftest]`
  binds the device/menu split to `readSessions()`'s own body.
- **The Mac plays a sound on the EDGE into `asking`, and `AskWatcher` is keyed by session
  ID for the reason the device's beep budget already documents**: two sessions on one
  project share a name, and name-matching made an asking session look newly-asking on
  every poll - here that would be a noise every 3s. Ids that stop asking are forgotten, so
  an answered session that asks again is announced again, and **the first refresh only
  PRIMES**: whatever is already asking when the app launches is not news, and without that
  every relaunch (the login item after a reboot included) would sound off about a backlog.
  One sound per refresh no matter how many arrive at once - two identical alerts a
  millisecond apart is just noise. The `Needs-input sound` submenu (Settings › General ›
  *Sound* since 2026-11-07) offers Off plus four
  system sounds, defaulting to **Submarine** (theme aside, Basso and Sosumi read as
  ERRORS, and a prompt is not an error); picking one plays it, because a name tells you
  nothing about a sound. `--sound-check [play]` verifies all of it with no prompt and no
  hardware: it resolves every candidate name (a sound dropped by a future macOS must fail
  there, not silently at 3am) and drives the watcher through launch-with-one-asking, the
  same one sitting there, a second arriving, all clear, the first asking AGAIN, and two at
  once.

**All host runtime state lives in ONE PER-USER directory, `/tmp/deckhand-<uid>/`
(`RUNTIME_DIR`), and the per-user part is load-bearing on a shared Mac.** It used to sit
at fixed `/tmp/deckhand-*` paths, which collide two ways. The second user's host cannot
write files the first user created (they land mode 644, owned by whoever got there
first) - and far worse, the second user's session HOOK read the FIRST user's heartbeat,
concluded a display was connected, and blocked up to 90s on every permission prompt
waiting for a device belonging to someone else. The directory is mode 0700, so another
account cannot even read it. Contents: `host.log` (+`.1`), `host-alive`,
`oauth-usage.json`, `oauth-backoff.json`, `oauth-attempt.json`, `mic.wav`.
**`host/index.mjs` and `claude-hooks/deckhand-session-hook.mjs` derive this path
independently and the two MUST stay identical** - they cannot import from each other,
since the hook is copied into `~/.claude`. Get it wrong and remote answering stops with
no error at all: the hook reads a heartbeat nobody writes, decides no display is
present, and simply never offers the buttons. `DECKHAND_TMP` overrides the whole
directory (used verbatim) and remains the test seam. launchd's own stdout/stderr
deliberately go to `~/Library/Logs/` instead, because launchd opens those at SPAWN time
and a missing directory would stop the job starting rather than merely lose its log.

**`host/index.mjs`** polls every `POLL_INTERVAL_MS` (5000ms) for: the token counts (`ccusage
blocks --active` and `ccusage weekly` until 2026-11-13; now `host/claude-tokens.mjs`, see
host-runtime.md "Memory"), the rate-limit cache file, and the sessions directory
(pruning any session file older than `SESSION_STALE_MS`, since a closed terminal may never
fire `SessionEnd`). It assembles one JSON object and writes it to USB (if `usbPort` is set) and
BLE (if `bleCharacteristic` is set) independently every tick, and refreshes the
`/tmp/deckhand-<uid>/host-alive` heartbeat (`connected` + `remoteAnswer`) that gates whether the hook
waits for a remote answer at all. The **device→host
lane** exists too: USB serial RX plus a subscription to the BLE TX characteristic's
notifications, both funneled through `handleDeviceLine()` — `ANSWER` lines become answer files
for the hook (deduped, since the device transmits on both transports simultaneously); anything
else is just logged. Session list is capped at 6, **urgency-sorted (asking > waiting >
working, then recency)** so a needs-input session can't be pushed off-screen, with
`sessionsTotal`/`hiddenAsking` telling the device what was cut. Per-session `model` comes from
tailing the session transcript (last 64KB), because most hook events — and desktop-app events
in particular — don't carry a model field. It also writes all `console.log` output directly to
`/tmp/deckhand-<uid>/host.log` via its own file stream (not just relying on stdout), because
`open`-launched apps don't inherit the launching shell's stdout redirection.

**The firmware is SEVERAL `.ino` files in one sketch folder, not one file.** The Arduino build
concatenates every `.ino` in the folder into a single translation unit - the one matching the
folder name FIRST, then the rest alphabetically - so they still share every global and there are
no `extern`s and no build-config changes. (The headers that DO exist - the board headers and the
board-2 panel driver - are a separate thing: they are `#include`d, not concatenated, and the panel
driver's `.cpp` files are deliberately outside this translation unit so a guard can keep board 1
from linking them. See the second table below.) `deckhand_display.ino` keeps the includes,
constants, type definitions, globals, `setup()`/`loop()`, the shared components and the touch
dispatch; the rest is grouped by what it draws:

| file | what |
|---|---|
| `deckhand_display.ino` | types, globals, components, tab bar, setup/loop, protocol |
| `usage.ino` | USAGE tab, Codex row, footer |
| `sessions.ino` | session rows, detail screen, ask/answer |
| `reader.ino` | history browser and full-screen reader (board 1); board-2 arms delegate to `scrollback.ino` |
| `scrollback.ino` | BOARD 2 ONLY, one `#if` block: the PSRAM transcript store, the wrap, the line index, the renderer and the drag loop |
| `settings.ino` | settings: board 1's four pager pages, board 2's HOME + five groups, steppers, confirm dialog |
| `audio.ino` | mic test, MICREC, streaming capture, voice card |
| `power.ino` | backlight, battery, beeper, volume, sleep |
| `keyboard.ino` | the full-screen QWERTY, typed answers and typed messages |
| `touch_cal.ino` | raw touch, board 1's 5-point affine calibration, orientation |
| `touch_hal.ino` | the ONE touch entry point both boards go through |
| `pairing.ino` | per-Mac NVS key slots and the answer HMAC |

**Not every firmware file is a `.ino`, and the exceptions are deliberate.** The board-2 panel
driver is real C++ in `.cpp`/`.h` files precisely so it does NOT join the concatenated translation
unit — a translation-unit guard is what keeps board 1 from linking it at all, and that guard is
load-bearing (see the legacy-I2C trap under Two boards):

| file | what |
|---|---|
| `board.h` | three lines: picks the board header from `CONFIG_IDF_TARGET_ESP32S3` |
| `board_e32r28t.h` | board 1: pins, capability flags, **every layout constant** |
| `board_es3c35p.h` | board 2: the same, derived natively for 320x480 |
| `panel_shim.h` / `.cpp` | the TFT_eSPI-compatible class: framebuffer, dirty rect, `flush()`, AA primitives |
| `panel_text.cpp` | the shim's text path — `textWidth`, datums, `drawString` |
| `panel_sprite.h` | `PanelSprite`, the `TFT_eSprite` stand-in the crab needs |
| `text_probe.h` | the `TEXTPROBE` string table, and the exact diff procedure for the gate |
| `text-widths-board2.txt` | board 2's half of that gate, committed so the diff is one command |
| `st77922_touch.h` / `.cpp` | board 2's capacitive controller, verbatim from the demo + a TU guard |
| `st77922_init_cmds.h`, `esp_panel_board_custom_conf.h` | the recovered panel init sequence — artefacts, not code to tidy |
| `*-geom-check.mjs`, `geom-common.mjs` | the three LAYOUT checkers (usage/sessions/settings geometry) and their shared header parser |
| `sessions-rank-check.mjs` | checks the asking tie-break (longest-waiting-first); a JS mirror of the sort plus structural assertions on the real source — not a layout checker, so it is not one of the three above |

**The one rule that governs what may move:** Arduino inserts its auto-generated prototypes ABOVE
the first function definition, so a moved function whose SIGNATURE names a type declared after
that point would not compile. `HostPairing`, `Theme`, `Usage`, `SessionInfo` and `ConfirmAction`
are all declared after it. This was checked before splitting and **no function in the sketch names
one of those in its signature**, which is why the split was possible at all - but a future function
that takes, say, a `SessionInfo&` must either stay in the main file or have its type hoisted above
line ~150 first. The split changed the binary by 8 bytes and no behaviour.

**`firmware/deckhand_display/deckhand_display.ino`** parses each JSON line and renders three tabs
(USAGE, SESSIONS, SETTINGS) plus a persistent footer (clock | battery pill | "Xs ago" freshness,
three fixed-width zones that cannot grow into each other). The one rule that
matters everywhere in this file: **every field is redrawn only when its value changes**, using
fixed-width padded strings compared against a per-field cache, never a
clear-then-redraw of a large area. This exists because the very first version redrew the
entire screen every second and visibly flickered — the discipline was added specifically to
fix that, and any new UI element needs to follow the same pattern (see `drawIfChanged`,
`drawBar`, `drawCardBorder` for the established helpers) or it will reintroduce flicker.

The **SETTINGS** tab shows Bluetooth/USB connection status from the device's own perspective
(`bleConnected`, set via `BLEServerCallbacks`; USB inferred from recent RX activity since a
CH340 UART has no real "connected" signal) — this is deliberately more trustworthy than macOS's
Bluetooth settings panel, which showed "not connected" for a link that was actually live during
development. It does **not** show a "which transport is active" indicator anymore — an earlier
version did, but since both transports are normally connected at once, that line just flip-flopped
between "via USB" / "via Bluetooth" every tick and was more confusing than informative.

Other things that aren't obvious from a single file:

- The touch controller (XPT2046) is wired to a **separate SPI bus** from the TFT (see the pin
  table comment at the top of the `.ino`), so it can't use TFT_eSPI's built-in touch support —
  it needs its own `SPIClass` instance and the standalone `XPT2046_Touchscreen` library.
- Touch calibration is a **5-point least-squares AFFINE fit** (four corners + centre):
  `sx = A*rx + B*ry + C`, `sy = D*rx + E*ry + F`, solved in `fitAffine()` — both axes share one
  3x3 normal-equation matrix, so it inverts once. The old 2-point fit derived `sx` from `rx`
  alone, so it could correct scale and offset but **not skew/rotation between the panel and the
  glass**, and it had no redundancy (one sloppy tap went straight into the mapping, and it always
  reported a perfect fit because it passes through both points by construction). Verified against
  synthetic panels: a 3-degree skew leaves a 0.03px residual under the affine fit versus **16.6px**
  under the old separable one. `runCalibration()` reports the **worst residual** at the targets and
  flags a loose run, and `fitAffine` returns false on a singular (collinear/nonsense) set so a
  broken mapping is never installed — it keeps the previous one instead. Coefficients are stored
  as a real array, not separate globals: separate globals aren't guaranteed contiguous, which
  previously corrupted this data when saved as a raw byte blob via Preferences. The Preferences
  keys are **versioned** (`cal5`/`calValid5`): v1 was corrupted, v2 used the wrong axis mapping,
  and v3's 2-point bytes mean nothing to the affine model, so bumping the key forces one fresh run
  rather than silently misreading old data as coefficients.
- `TOUCH_SWAP_XY` exists because this board's touch controller axes are swapped relative to
  the display; it's already set correctly for this exact board.
- The backlight is LEDC PWM on IO21 for the brightness setting, and `ledcAttach(TFT_BL_PIN,...)`
  must run **after** `tft.init()` — TFT_eSPI's init does a plain `pinMode`/`digitalWrite(HIGH)`
  on that pin (`TFT_BL` in its `User_Setup.h`), which silently strips an earlier LEDC
  attachment; that exact bug shipped once as "brightness buttons do nothing".
- **Time remaining on battery is MEASURED, and the noise floor is the whole design problem.**
  There is no coulomb counter here, so runtime left can only come from watching the voltage
  fall - and the sleep report already records what extrapolating a small delta produces: a
  7mV drift over 3 minutes became "-133.7 mV/h", a flat cell in four hours, from noise
  multiplied by 20. So `battMinutesLeft()` (power.ino) reports **-1 until it has earned a
  number**: a 30-slot ring of one-minute samples, and nothing stated until the window spans
  **20 minutes** AND the fall exceeds **25mV**. Three things about it are load-bearing:
  - **`pctFromMv(mv)` was split out of `batteryPct()` so a STORED sample maps through the same
    curve.** The non-linearity lives in that table, so a slope taken in millivolts is not a
    slope in charge - the least-squares fit runs on percentages, not volts.
  - **A NON-NEGATIVE SLOPE MEANS UNKNOWN, NOT "BATTERY FOREVER".** When the backlight blanks
    after 30s idle the load drops and the cell voltage REBOUNDS, so a rising reading is the
    normal consequence of the screen going off. For the same reason the window deliberately
    does **not** reset when the backlight changes: spanning both blanked and lit periods is
    what makes the average reflect how the device is actually used. The ring resets only when
    the state leaves DISCHARGING or the charge rises by >40mV (a data-less wall charger reads
    as DISCHARGING - there is no VBUS-sense pin).
  - **Least squares over the whole window, not endpoint-to-endpoint.** One sample taken while
    the backlight was on sits several mV below its neighbours - more movement than the trend
    itself makes in 20 minutes.
  Shown on **SETTINGS › STATUS** as `42% 3.85V ~5h` (`~95m` under two hours), and nowhere while
  charging or unmeasured - no placeholder, because a number derived from noise is worse than
  none. The padded string is 15 chars ("100% 4.20V ~99h") = 90px in Cozette 6x13, right-aligned
  to x=214 against a "Battery" label ending at 88; `battRowTextCache` went 16 -> 20 because 15
  chars plus NUL fitted the old size EXACTLY, and a cache shorter than its string silently stops
  noticing changes.
- **The `BATT` line goes through `sendLineToHost`, NOT `Serial.printf`, and that is what makes
  the Mac able to show any of this.** Serial reaches the host only over USB, so a battery
  reading could otherwise arrive **only while charging** - exactly when time-remaining is
  meaningless. It now rides BLE too (verified: the first new-format line arrived as
  `[device/ble]`). The line carries `left=` (MINUTES, -1 = not measurable yet), plus `pcth=`
  and `span=` purely as provenance in the host log: `left=-1 span=6` is "still measuring",
  while `left=-1 span=25` says the trend was too flat or rising to state. The host turns -1
  into an **absent** `leftMin`, never 0 - "not measured" and "no time left" are different
  claims - and publishes `batt:{pct,mv,state,leftMin,ageSec}` in the heartbeat, with `ageSec`
  computed on the way out so a stale reading cannot look fresh just because the heartbeat is.
  The menu bar hides the row past 180s of age, since BATT arrives only once a minute and the
  last one starts aging the instant the link drops.
- Battery: charging (TP4054, ~290mA) and USB/battery power-path switching (Q3 P-FET) are pure
  hardware — firmware only *reads* the level, via the board's 100K/100K divider from BAT+ to
  IO34 (`analogReadMilliVolts * 2`, EMA-smoothed, table-mapped to %). There is **no VBUS-sense
  pin**, so "charging vs on battery" is inferred from recent USB serial RX; a data-less wall
  charger reads as "on battery" even though the hardware is charging. IO34 is ADC1 —
  deliberately, since ADC2 is unusable while WiFi/BT is active.
- Speaker: onboard FM8002E amp, input on IO26 (LEDC square wave), shutdown on IO4 (10K pulled
  high = muted; drive LOW only while a beep plays, else the speaker hisses). Beep volume is the
  `BEEP_DUTY` constant (duty out of 255), not the amp gain. The device double-beeps when any
  session *transitions into* `asking` (detected in `handleLine` by diffing against the previous
  poll's list); test it without real prompts by dropping a fake session file:
  `echo '{"session_id":"t","cwd":"/tmp/x","status":"asking","updated_at":'$(date +%s)'000}' >
  ~/.claude/deckhand-sessions/t.json` (delete it afterwards).
