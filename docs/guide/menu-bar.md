# The menu-bar app

> Moved out of README.md to keep it short. Index: [`docs/README.md`](../README.md).

---

## Menu-bar app (optional)

If you'd rather not touch the terminal, `mac-app/` is a tiny native
menu-bar controller (Swift, macOS 13+). Build and launch it:

```
mac-app/build.sh
open mac-app/DeckhandMenuBar.app
```

Two things that look like faults and are not. **It is `LSUIElement`** — menu-bar
only, no dock icon and no window — so "I can't see it" almost always means it is
simply not running; `pgrep -x DeckhandMenuBar` settles that in one command. And it
is **not a login item** until you switch on *Open Deckhand at login* in its Settings
window (General), so it stays gone after a reboot until you do.

**The built `.app` is deliberately not committed**, because `build.sh` bakes this
repo's absolute path into `Info.plist` as `DeckhandHostDir`. **Re-run `build.sh`
after moving the repo**, or it will point at a directory that no longer exists.

It puts an origami paper-boat icon in the menu bar. **The dropdown is for
looking**: where the host stands, what quota is left, who is waiting on you and
the last dictation, then just three things to do — **Start / Stop Deckhand**,
**Pair New Device…** and **Settings…** (⌘,) — and Quit. (The released app adds
**Check for Updates…**.)

**Every preference is in the Settings window**, grouped by the question you arrive
with:

| Pane | What is in it |
|---|---|
| **General** | Is it running (with Restart / Stop and the host log), *Open Deckhand at login*, and what happens when a session needs you: *Answer prompts on the display* and the alert *Sound* |
| **Menu Bar** | A live preview of what sits beside the boat, and switches for Claude usage, Codex usage, session counts, the needs-input count, *Hide usage and session counts while a display is connected*, and *Colourful icon* |
| **Devices** | Every paired display with how it is connected and its battery, *Forget…* per display, *Pair New Device…*, which display Bluetooth follows (shown once you have two), and **this Mac on the display**: its name and its icon |
| **Claude Code** | Whether the hooks are installed, with Install / Repair / Remove in the released app |
| **About** | Version, update settings (released app), the host log, run setup again, uninstall |

Every switch says what it does underneath it, which is the reason this moved out of
the menu: the old *Settings* submenu had grown to eleven rows and five nested
submenus, several of them only understandable from a tooltip. The icon picker shows
the sixteen icons as a grid (the names are listed under *Giving a Mac its own icon*,
in **Security of the remote**); with `DECKHAND_MAC_EMOJI` or `DECKHAND_MAC_TAG` set,
the name and icon are dimmed and the pane says why, since a click could not move
that choice. Controls that act through the host (answering, forgetting, the
Bluetooth choice, the name) dim while it is stopped.

```
●  Syncing with Deckhand-C114
      Over USB and Bluetooth  ·  battery 78%
──────────────────────────────────────────────
Claude
5-hour    16% ▼  █▋░░░│░░░░       resets in 2h 44m
Weekly     2% ▼  ▎░░░░░░│░░░      resets in 6d 21h
Codex
5-hour    13% ▲  █│▎░░░░░░░░      resets in 4h 47m
Weekly    64% ▲  ██│████▍░░░      resets in 5d 19h
──────────────────────────────────────────────
Sessions                    1 needs you  ·  1 working
■  deckhand                              needs you
●  api   Codex                             working
       Read the project
```

Hover over a usage row for the sentence behind it (how much of the window has passed,
whether you are ahead of the clock, and the time it resets).

**Battery** appears under the device name — `78% · ~5h left` — and the hours are
measured, not modelled: the device watches its own voltage fall and says nothing
until that trend clears its ADC noise, roughly 20 minutes after you unplug. While
charging it says `charging`, and a reading older than three minutes is hidden
rather than shown as current. The same figure is on the device at
**SETTINGS › STATUS**, as `42% 3.85V ~5h`.

**Sessions come from the host's own tick line**, so they arrive already
urgency-sorted (needs-input first) and the menu can never disagree with the
device about which session matters most.

**Clicking a row jumps to the app that session lives in.** The hook stamps the
owning app into each session record — it inherits `__CFBundleIdentifier` and
`CLAUDE_CODE_ENTRYPOINT` from the Claude Code process that spawned it, so this
costs two environment reads and no searching. For an editor session it opens that
workspace, which brings the existing window forward; for a terminal or the desktop
app it just activates the app, since no API can focus one terminal tab and opening
the folder would spawn a new window; and when the app is unknown or no longer
running it reveals the folder in Finder, as this menu always did. That last check
matters — without it, clicking a stale row would *launch* an editor for a session
that is not in it any more. The row's tooltip names the model and git branch and
says exactly what the click will do, generated from the same resolver the click
uses so the two cannot disagree.

**The bar carries what the device would have shown, when the device is absent.**
Beside the boat, left to right: quota `5h·7d`, then the live sessions by status —
`■` needs input, `○` waiting on you, `●` working, one glyph per session, so the
three partition the list rather than overlapping. Each badge disappears at zero,
so an empty label is a quiet Mac and an absent `○` means "none waiting" rather
than "not shown". The two device-mirroring badges go quiet once a device is
connected — that is what *Hide usage and session counts while a display is connected*
(Settings › Menu Bar) governs, and every part of it can be switched off there. The needs-input count is
not gated that way, because a prompt blocking your work is worth saying whether or
not the device is also saying it.

**A sound fires when a session starts needing input** — Submarine by default,
changeable (or silenceable) under Settings › General › *Sound*, where picking one plays it.
It sounds on the *edge* into needing input, keyed by session id, and the first
refresh after launch only primes: whatever was already waiting when the app
started is not news.

Quota rows say **when they are stale**, because the transport being fresh says
nothing about the numbers: the OAuth poller backs off 15 minutes on a rate limit
and can sit there for hours while every tick still arrives on time. Past 15
minutes — the same threshold the device dims its own big number at — the row dims
and appends `· stale 3h`, and the `high` / `critical` note is suppressed, since
97% from an hour ago is not a crisis to shout about but a number we cannot vouch
for. Each row carries the age of its own source, so a stale Codex reading cannot
drag the Claude rows down with it.

Quota says **"% used"** with the reset time in hours and days, and the bar plus
the words `high` / `critical` carry the same thing the orange and red do:
informational menu rows are disabled rows, which macOS may composite at reduced
alpha, so colour is never the only cue here — the same rule the device UI
follows.

Two flags let you inspect the menu without opening it by hand, which is
otherwise impossible to check:

```
DeckhandMenuBar --menu-dump                 # the real menu as text, incl. hidden/disabled state, tooltips
DeckhandMenuBar --menu-preview /tmp/m.png   # its actual styling, light and dark side by side
DeckhandMenuBar --open-session [id] [go]    # what clicking each session row would do; `go` does it
DeckhandMenuBar --sound-check [play]        # resolves every needs-input sound, and proves the edge logic
```

`--open-session` and `--sound-check` exist for the same reason as the two above: a
menu cannot be clicked from a script and a sound cannot be seen, so both paths are
otherwise only checkable by hand. Each prints by default and acts only when asked.

The icon is deliberately *not* the project's ship's wheel. The wheel is the
mark — it is on the device's waiting screen, in the hero image and in the app
bundle — and a mark carries identity, where a menu-bar glyph has to survive at
16px in one flat colour beside two dozen others. It is drawn from geometry
rather than shipped as a bitmap, so it stays crisp at any bar height on any
display.

It carries state as a **shape**: a solid boat when a device is connected, an
outlined one when none is. The icon stands for the *link*, not the process —
whether the host is running is said in words on the first row, where it cannot be
mistaken for anything else. It is drawn in the logo's mid-blue, which was chosen
by measurement rather than taste: it is the only colour from the mark that clears
the 3:1 contrast threshold against **both** a dark and a light menu bar (3.01 and
4.37), where the deep blue fails on dark, the light blue fails on light, and the
cream scores 1.00 — invisible — which is what ruled out a two-tone boat. Turning
*Colourful icon* off returns the monochrome template version, the only one that
follows light and dark bars by itself; a coloured icon also does not invert to
white while the menu is open, the way every other coloured menu-bar icon behaves.
To see it at every size without hunting for it in your menu bar:

```
mac-app/DeckhandMenuBar.app/Contents/MacOS/DeckhandMenuBar --icon-preview /tmp/icons.png
```

**If the LaunchAgent is installed, the app drives it** (`launchctl bootout` /
`bootstrap`) rather than killing the process — that is the only way Stop can mean
stopped, because `KeepAlive` undoes a plain kill within about a second. It also
skips its own watchdog in that case, since launchd already restarts a dead host and
survives reboots, and two supervisors that cannot see each other will fight over one
serial port. Without the agent it falls back to the old behaviour and keeps its
watchdog. The tooltip on Start/Stop says which mode you are in.
It doesn't touch Bluetooth itself — it just runs and watches the same
`DeckhandBLE.app` host — so the proven transport path is unchanged. The
built app embeds this machine's repo path, so re-run `build.sh` if you move
the repo. Ad-hoc signed; `SMAppService` may need the app in `/Applications`
to self-register as a login item.
