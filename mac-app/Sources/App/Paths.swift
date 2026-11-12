import Cocoa
import ServiceManagement

// PER-USER runtime dir, and this MUST match RUNTIME_DIR in host/index.mjs and the same
// derivation in claude-hooks/deckhand-session-hook.mjs. Three places now derive it
// independently and cannot import from one another; when this one was missed the app
// read a heartbeat nobody writes and reported the host as down while it was running
// perfectly, with "Open host log" opening nothing. The failure is silent in exactly the
// way the host/hook pair is: no error, just a wrong answer.
let runtimeDir = ProcessInfo.processInfo.environment["DECKHAND_TMP"]
    ?? "/tmp/deckhand-\(getuid())"
let heartbeatPath = runtimeDir + "/host-alive"
let logPath = runtimeDir + "/host.log"
// Drop a "FORGET" line here and the host clears its BLE pin (re-pairs to the
// next device connected over USB). Same trigger file the host watches for
// device commands like RECAL.
let commandTriggerPath = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/deckhand-device-command")

func hostDir() -> String {
    (Bundle.main.object(forInfoDictionaryKey: "DeckhandHostDir") as? String) ?? ""
}

// THE RELEASED APP (release/build-release.sh) carries its host INSIDE itself: its own
// Node as a helper app, index.mjs and node_modules in Resources, and a launch agent
// it registers with SMAppService. Its Info.plist has no DeckhandHostDir, and that
// absence plus the helper actually being there is what selects this mode - a dev build
// (mac-app/build.sh) always has the key, so it can never take this path by accident.
// Resolved through symlinks because the host's argv carries the launcher's realpath()
// (release/host-launch.c), and the pkill patterns in AppDelegate.swift must match it exactly.
let bundlePath = URL(fileURLWithPath: Bundle.main.bundlePath).resolvingSymlinksInPath().path
let helperApp = bundlePath + "/Contents/Helpers/Deckhand Host.app"
let helperNode = helperApp + "/Contents/MacOS/Deckhand Host"
let bundledHostScript = bundlePath + "/Contents/Resources/host/index.mjs"
let bundledHooksDir = bundlePath + "/Contents/Resources/hooks"
let agentLabel = "io.github.blueandhack.deckhand.host"
let isBundled = Bundle.main.object(forInfoDictionaryKey: "DeckhandHostDir") == nil
    && FileManager.default.isExecutableFile(atPath: helperNode)
let claudeDir = (NSHomeDirectory() as NSString).appendingPathComponent(".claude")
// What the hooks run (claude-hooks/hook-command.mjs): a link to the bundled Node,
// re-pointed on every launch, so moving the app never strands a hook.
let runnerLink = claudeDir + "/deckhand-node"
func hostAgent() -> SMAppService { SMAppService.agent(plistName: agentLabel + ".plist") }
var appBuild: String { (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "" }

func hostApp() -> String { isBundled ? helperApp : hostDir() + "/DeckhandBLE.app" }
func hostScript() -> String { isBundled ? bundledHostScript : hostDir() + "/index.mjs" }
func serviceScript() -> String { hostDir() + "/deckhand-service.sh" }

// Is the host supervised by launchd? If the LaunchAgent is installed, IT owns the
// process and this app must go through it rather than around it.
//
// Going around it does not work, and the failure is confusing rather than loud: the
// agent sets KeepAlive, so a `pkill` stop is undone within about a second - the Stop
// item looks broken - and an `open` start launches a second host OUTSIDE launchd while
// launchd may spawn its own, leaving two processes contending for one serial port. The
// app's own watchdog is redundant then too, and two supervisors that cannot see each
// other will fight.
func launchdPlist() -> String {
    (NSHomeDirectory() as NSString)
        .appendingPathComponent("Library/LaunchAgents/com.deckhand.host.plist")
}
func isSupervised() -> Bool {
    // The released app's supervisor is its own agent. launchdPlist() is then the
    // REPO's agent - a second host, which setup offers to stop (legacyHostPresent).
    isBundled ? ServiceState.shared.agent == .enabled : FileManager.default.fileExists(atPath: launchdPlist())
}
