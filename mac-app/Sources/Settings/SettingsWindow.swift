import Cocoa
import SwiftUI

/// Clears the first responder on every tab switch. SwiftUI otherwise hands the
/// keyboard to the first text field it finds, so opening Devices put a blinking
/// cursor in the Mac-name field - and a field holding focus is one the 3s refresh
/// stops updating (SettingsModel.nameEditing).
final class SettingsTabs: NSTabViewController {
    override func tabView(_ tabView: NSTabView, didSelect item: NSTabViewItem?) {
        super.tabView(tabView, didSelect: item)
        DispatchQueue.main.async { [weak self] in self?.view.window?.makeFirstResponder(nil) }
    }
}

final class SettingsWindowController: NSObject, NSWindowDelegate {
    let model = SettingsModel()
    let window: NSWindow
    let tabs = SettingsTabs()

    init(app: AppDelegate) {
        model.app = app
        tabs.tabStyle = .toolbar
        for pane in SettingsPane.allCases {
            let root: AnyView
            switch pane {
            case .general: root = AnyView(GeneralPane(m: model))
            case .menuBar: root = AnyView(MenuBarPane(m: model))
            case .agents: root = AnyView(AgentsPane(m: model))
            case .devices: root = AnyView(DevicesPane(m: model))
            case .claude: root = AnyView(ClaudePane(m: model))
            case .about: root = AnyView(AboutPane(m: model))
            }
            // ONE size for every pane, so switching tabs does not make the window
            // jump; a pane taller than this scrolls inside its Form.
            let host = NSHostingController(rootView: root.frame(width: SETTINGS_W, height: SETTINGS_H))
            host.title = pane.title
            let item = NSTabViewItem(viewController: host)
            item.label = pane.title
            item.image = NSImage(systemSymbolName: pane.symbol, accessibilityDescription: pane.title)
            tabs.addTabViewItem(item)
        }
        window = NSWindow(contentViewController: tabs)
        window.styleMask = [.titled, .closable]
        window.toolbarStyle = .preference
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: SETTINGS_W, height: SETTINGS_H))
        super.init()
        window.delegate = self
        model.pullServices()
    }

    /// When the window last stopped being the key window - so opening the status
    /// menu (which takes focus away first) can tell "Settings was in front a moment
    /// ago" from "Settings is open somewhere behind the app you are using".
    var resignedKeyAt = Date.distantPast
    func windowDidResignKey(_ n: Notification) { resignedKeyAt = Date() }

    /// WHILE THE WINDOW IS OPEN, DECKHAND IS A REGULAR APP: a Dock icon, a place in
    /// Cmd-Tab, and its window ordered like any other app's. As an .accessory app the
    /// window was filed BEHIND every other app's the moment it lost focus - which
    /// opening the status menu does - and an accessory app has no Dock icon or
    /// Cmd-Tab entry to get it back by. (User report, 2026-11-08.) Closing the window
    /// returns the app to the menu bar only.
    ///
    /// THE CONTROLLER IS RELEASED ON CLOSE, where it used to be kept so the window
    /// reopened where it was (the pane is now remembered instead). Measured
    /// 2026-11-13 with a harness over this app's own code: the menu bar alone is
    /// 16 MB; opening Settings and visiting its five panes takes it to ~54 MB, and
    /// a closed-but-kept controller holds all of it. Releasing returns ~5 MB - the
    /// window, the five hosting views and their view graphs. The other ~32 MB is
    /// SwiftUI itself, resident for the life of any process that has loaded it, and
    /// no release or malloc_zone_pressure_relief returns it (measured: 0 bytes).
    /// Only a separate Settings process could; see docs/reference/menu-bar.md.
    func windowWillClose(_ n: Notification) {
        let app = model.app
        let pane = tabs.selectedTabViewItemIndex
        DispatchQueue.main.async {
            NSApp.setActivationPolicy(.accessory)
            app?.lastSettingsPane = pane
            app?.settingsWindow = nil
        }
    }

    func show(pane: SettingsPane?) {
        if let p = pane { tabs.selectedTabViewItemIndex = p.rawValue }
        if !window.isVisible { window.center() }
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        // An .accessory app is never frontmost on its own; without this the window
        // opens behind whatever the person was reading.
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { [weak self] in self?.window.makeFirstResponder(nil) }
    }
}

let SETTINGS_W: CGFloat = 540
let SETTINGS_H: CGFloat = 560

extension AppDelegate {
    /// Restart in place. Supervised, through launchd (`kickstart -k`), so there is
    /// still exactly one supervisor; unsupervised, the old force-clear-and-open.
    func restartHost() {
        guard hostAction == nil else { return }
        wantRunning = true
        lastRestart = Date()
        downSince = nil
        let supervised = isSupervised()
        let label = isBundled ? agentLabel : "com.deckhand.host"
        beginHostAction(.restarting) { [weak self] in
            if supervised {
                _ = runCapture("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(label)"])
            } else {
                self?.startHost()
            }
        }
    }

    /// Sparkle's own two switches, exposed rather than mirrored, so the window and
    /// Sparkle's second-launch question can never disagree.
    var updatesAvailable: Bool {
        #if SPARKLE
        return updater != nil
        #else
        return false
        #endif
    }
    var autoCheckUpdates: Bool {
        get {
            #if SPARKLE
            return updater?.updater.automaticallyChecksForUpdates ?? false
            #else
            return false
            #endif
        }
        set {
            #if SPARKLE
            updater?.updater.automaticallyChecksForUpdates = newValue
            #endif
        }
    }
    var autoInstallUpdates: Bool {
        get {
            #if SPARKLE
            return updater?.updater.automaticallyDownloadsUpdates ?? false
            #else
            return false
            #endif
        }
        set {
            #if SPARKLE
            updater?.updater.automaticallyDownloadsUpdates = newValue
            #endif
        }
    }
}
