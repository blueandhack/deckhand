// Deckhand menu-bar controller: the entry point.
//
// A tiny LSUIElement (menu-bar-only) app that runs and monitors the Node host
// via the existing DeckhandBLE.app wrapper - it does NOT touch Bluetooth
// itself, so the host keeps its own proven CoreBluetooth/TCC path. Status is
// read from the host's heartbeat file and log; no IPC needed.
//
// Paths to the host come from the DeckhandHostDir Info.plist key, injected by
// build.sh at build time (App/Paths.swift); the released app carries its host
// inside itself instead (Release/).
//
// WHERE THINGS ARE (mac-app/Sources/):
//   App/       paths, the cached SMAppService state, AppDelegate (the menu itself)
//   Status/    reading the host: the heartbeat, the tick line, pace arithmetic
//   Menu/      the menu-bar item, the dropdown's rows, session targets, the boat
//   Pairing/   wireless pairing: the pure state machine and its window
//   Release/   the released app's own host, hooks and uninstall
//   Setup/     first-run setup
//   Settings/  the Settings window
//   Modes/     the command-line modes: --host, the checks, the previews
//
// THIS IS THE ONLY FILE WITH TOP-LEVEL CODE, and the order below is the order the
// single-file app ran it in: the application and its delegate exist first, then
// each command-line mode gets its turn (one that matches exits or runs the app
// itself), and only then does the menu-bar app start.

import Cocoa

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)

// Command-line modes (Modes/). The inspection modes build the REAL menu and
// refresh it against the live host, so what they show is what the bar would
// show - but dryRun keeps refresh from touching the watchdog, because a
// diagnostic must never start or stop anything.
modeSettingsShow()
modeDmgBackground()
modeBarPreview()
modeHost()
modeSetupDo()
modeSetupPreview()
modeMenuShot()
modeLegibilityCheck()
modeMenuDump()
modeOpenSession()
modeSoundCheck()
modePaceCheck()
modePairCheck()
modePairShot()
modeIconPreview()

app.run()
