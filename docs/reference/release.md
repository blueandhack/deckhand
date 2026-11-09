# The released app (`Deckhand.app`)

Index: [`docs/README.md`](../README.md). The rules an agent must not miss stay in
[`CLAUDE.md`](../../CLAUDE.md).

---

One notarized `Deckhand.app`, distributed from GitHub Releases and kept current by
Sparkle: the menu bar, the host, its own Node, and the hook setup, with no repo,
Homebrew or npm on the user's Mac. The repo workflow (`install.sh`, `mac-app/build.sh`,
`deckhand-service.sh`, `flash.sh`) is unchanged; firmware is still flashed from the repo.

## Cutting a release

```
release/build-release.sh 0.2.0                 # build, sign, notarize, staple, appcast
release/build-release.sh 0.2.0 --no-notarize   # everything but Apple's step (local test)
release/build-release.sh 0.2.0 --working-tree --no-notarize   # uncommitted code, testing only
```

A release is built from `git archive HEAD`, so it is exactly a commit: uncommitted edits
and untracked files cannot leak in. `CFBundleVersion` is `git rev-list --count HEAD`,
which only rises, and is what Sparkle compares. Output: `release/dist/<version>/` with the stapled DMG and `appcast.xml`.

**Channels.** `--channel alpha|beta` makes a PRE-RELEASE: the version stays `x.y.z` (it must
be digits), `DeckhandChannel` in Info.plist makes Settings › About say "0.1.0 alpha", and
`publish.sh` publishes it with GitHub's pre-release badge.

**Publishing** is `release/publish.sh <x.y.z> [--notes file.md]`, a separate, deliberate step.
It refuses an unstapled build, a mismatched appcast, an existing tag, or a main that is not
level with origin; then it creates the GitHub release with the DMG, waits until the DMG
downloads, and only THEN publishes the feed. **The feed is `release/appcast.xml` on main**
(`https://raw.githubusercontent.com/blueandhack/deckhand/main/release/appcast.xml`), committed
by publish.sh. It used to be `releases/latest/download/appcast.xml`, but GitHub's "latest"
skips pre-releases, so a pre-release alpha would have left every installed alpha with no feed.
That address is built into every copy shipped and can never change for them.

**Test-only overrides**, refused without `--working-tree`: `DECKHAND_BUILD_NUMBER` (two
working-tree builds of one commit otherwise share a number and Sparkle sees no update
between them) and `DECKHAND_FEED_URL` (a local feed). The end-to-end Sparkle test used
both: build N and N+1 with a feed on `http://127.0.0.1:8765/`, `generate_appcast
--download-url-prefix http://127.0.0.1:8765/`, backdate `SULastCheckTime`, relaunch, quit.

## One-time setup and KEY CUSTODY

- `xcrun notarytool store-credentials deckhand-notary --team-id GJFJF2K2L3 --apple-id ...`
  (an app-specific password). `DECKHAND_NOTARY_PROFILE` overrides the profile name.
- `release/.cache/sparkle-2.10.1/bin/generate_keys` once. The PRIVATE key lives only in
  the login keychain; `generate_keys -x <file>` exports it for a backup (keep it in a
  password manager, never in the repo) and `-f <file>` imports it on another Mac. **Losing
  it means no installed copy can ever be updated again.** The PUBLIC key goes in
  `release/sparkle-public-key.txt` - the bare 44-character key, not the `<key>/<string>`
  snippet `generate_keys` suggests; the build refuses anything else, and a notarized build
  also refuses a public key that does not match the keychain's private one.

## Layout

```
Deckhand.app/Contents/
  MacOS/Deckhand                          the menu-bar app (io.github.blueandhack.deckhand)
  Helpers/Deckhand Host.app/              io.github.blueandhack.deckhand.host, LSBackgroundOnly
    Contents/MacOS/Deckhand Host          the official nodejs.org Node 26.13.0, renamed
    Contents/MacOS/deckhand-host-launch   release/host-launch.c
  Resources/host/                         index.mjs, runtime modules, production node_modules
  Resources/hooks/                        the two hook scripts, both installers, hook-command.mjs, deckhand-backup.mjs
  Library/LaunchAgents/io.github.blueandhack.deckhand.host.plist
  Frameworks/Sparkle.framework            2.10.1, XPC services removed (the app is not sandboxed)
```

**Why the official Node.** `host/build-app.sh` copies YOUR node, and Homebrew's links ~90
Homebrew libraries by absolute path: one `brew upgrade simdjson` (2026-11-06) left the
repo's `DeckhandBLE.app` unable to launch, and 62 crash reports on the development Mac are
that host failing on `libsimdjson`. The build fails if any Mach-O in the bundle links
outside `/usr/lib`, `/System` or the bundle (`otool -L`).

**Why a launcher.** A launch agent's plist cannot hold an absolute path to an app that
may live anywhere, but `BundleProgram` can be bundle-relative. The launcher resolves its
own path, then `execv`s the Node beside it with `../../../../Resources/host/index.mjs`.

## Signing, and the trap in it

Inside out, `--options runtime --timestamp`, never `--deep`: every Mach-O in
`node_modules` (not only `*.node` - ccusage ships a native executable, and the first
notarization was REJECTED for leaving it unsigned; npm also stages it 0644, so it is made
executable before signing), Sparkle's `Autoupdate`, `Updater.app` and framework, the
launcher, the helper bundle, the app. Node needs `allow-jit` and
`allow-unsigned-executable-memory` (`release/host.entitlements`) and they must be on the
**helper bundle's** signature: signing a bundle re-signs its main executable, so
entitlements put on the binary first were silently dropped and Node died at start with
"Failed to reserve virtual memory for CodeRange". The build asserts the helper kept
`allow-jit`. Library validation stays ON (every addon is signed by the same team).

## The DMG window

Not a bare folder: the app and an Applications link sit on a background with an arrow
between them, "Drag Deckhand into Applications", and a picture of the menu bar Deckhand will
live in, with the version and channel in a corner; the mounted volume carries the app's icon.
The background is drawn by the app being shipped (`Deckhand --dmg-background <prefix>
"<label>"`, at 1x and 2x, joined into one Retina TIFF), so its menu-bar picture is the real
boat and the real two-row bar. Finder alone can write a window's layout (it lives in the
image's `.DS_Store`), so the image is built writable, Finder is scripted to lay it out, and
only then is it compressed. Three things were found by LOOKING at the mounted result:

- **Finder deletes a `.VolumeIcon.icns`** already on the volume during its layout pass, and
  clears the custom-icon flag; `hdiutil create -srcfolder` drops one from the source folder
  too. So the icon is copied in and flagged LAST, after Finder (`GetFileInfo` must show `C`).
- **The person's own Finder chrome still shows**: a tab bar cannot be turned off per window,
  and the path bar needed its own `pathbar visible` (toolbar and status bar are not enough).
  Finder also made the window wider than asked (660 requested, 681 shown), so the background
  is drawn on an 800x560 canvas with the layout in its top-left 660x420 - extra area is more
  gradient, never a white strip - and the layout fits in ~370pt of height.
- **Labels stay readable in dark mode**: Finder draws icon labels dark over a light
  background picture (seen with this Mac in dark mode).

Positions are shared between the two scripts by hand: app at (170,150), Applications at
(490,150), 112pt icons, window bounds 660 x 440. Built here needs Finder Automation permission
for the shell running the build; without it the build stops and says so.

## First run, and migrating from the repo setup

The setup window (`SetupFlow`) shows the next step, derived from the machine every second:

1. **Move to Applications** - opened from the DMG or translocated by Gatekeeper (measured:
   opening from the DMG lands in `/AppTranslocation/`, not `/Volumes/`), it says so and quits.
2. **A host from the repo** - `com.deckhand.host`'s plist, a running `DeckhandBLE.app`, or the
   repo-built menu app (`com.deckhand.menubar`). "Stop It" unloads the agent, MOVES the plist
   to `~/Deckhand-backups`, clears the old app's `wantRunning`, quits it, and opens Login
   Items when the old app was running, because one app cannot remove another's login item
   and it otherwise came back at login as a second boat.
3. **Hooks, with consent** - lists every change first. Backs up, copies the scripts, links
   `~/.claude/deckhand-node` to the bundled Node, runs the installers with `--node`.
   Ownership is by script name (`hook-command.mjs`), so install.sh's `node ...` entries are
   REWRITTEN in place, never duplicated; their stale `timeout: 100` (from before the hook
   could wait 24h) is corrected on the way.
4. **Start** - opens the helper once so macOS can ask for Bluetooth (the way install.sh
   always has), waits for the heartbeat's `ble` field, then registers the agent. A refusal
   continues USB-only. The spike also showed a launchd-started host reaching `poweredOn`,
   but only with the permission already granted, so the `open` step is kept.

Also migrated at first launch: the old menu app's preferences (`importLegacyPrefs`: the
bar switches, the icon colour, the sound, the Mac icon), which live under a different
bundle id - found when the released app came up with a colourful icon on a Mac whose old
app had chosen monochrome. Shared by both and needing nothing: `~/.claude/deckhand-secret`
(pairing keys), the Mac name and icon files, the per-user runtime directory.

After a Sparkle update (the build number changed): the hook scripts are re-copied if the
person consented once, and the host is restarted with `launchctl kickstart -k` so it runs
the new code instead of the process left over from the replaced bundle.

## Verified, and not

Measured end to end on the development Mac (2026-11-07): Gatekeeper accepts the stapled DMG
and app; first run from the DMG, then from /Applications; the repo host stopped; hooks
migrated on the real `~/.claude` with only Deckhand's entries changed; the agent running
the bundled Node; the device on USB and Bluetooth; a new Claude session written by the
hooks with no `node` on PATH; ccusage working; Sparkle 0.1.0 -> 0.1.1 downloaded, verified,
installed on quit, host restarted, hooks refreshed. Not verified: a Mac with no Node or
Homebrew at all (the `otool` gate stands in for it), a first-time Bluetooth prompt raised
by launchd, Uninstall, and a notched screen's bar fitting.
