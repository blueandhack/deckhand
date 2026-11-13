import Cocoa
import ServiceManagement
import SwiftUI

// MARK: - The Settings window
//
// HOW PEOPLE USE THIS, which is what decided its shape. The menu is opened many
// times a day to LOOK (is it syncing, how much quota is left, who is waiting) and
// almost never to CHANGE anything; the settings are changed a handful of times,
// mostly in the first week. So the menu is for looking and the three things
// people actually do from it (start or stop, pair, open Settings), and every
// preference lives here, grouped by the question someone arrives with:
//   General     - is it running, does it start at login, what happens when a
//                 session needs me (answer from the device, the sound)
//   Menu Bar    - what sits beside the boat, with a live preview of it
//   Devices     - which displays this Mac knows, which one Bluetooth follows,
//                 forget one, pair one; and what this Mac is called on them
//   Claude Code - are the hooks in, repair or remove them
//   About       - version, updates, the log, setup again, uninstall
// A window can say what a switch DOES under the switch, which a submenu row
// cannot, and that is most of why this exists: half the old rows needed a tooltip
// to be understood, and tooltips are found by accident.
//
// The window decides nothing and writes nothing itself: every control calls the
// AppDelegate function that does exactly what the old menu item did (same trigger
// file line, same UserDefaults key), and the window re-reads the same heartbeat
// snapshot the menu draws from on every refresh.

enum SettingsPane: Int, CaseIterable {
    case general, menuBar, devices, claude, about
    var title: String {
        switch self {
        case .general: return "General"
        case .menuBar: return "Menu Bar"
        case .devices: return "Devices"
        case .claude: return "Claude Code"
        case .about: return "About"
        }
    }
    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .menuBar: return "menubar.rectangle"
        case .devices: return "rectangle.portrait.on.rectangle.portrait"
        case .claude: return "terminal"
        case .about: return "info.circle"
        }
    }
}

final class SettingsModel: ObservableObject {
    weak var app: AppDelegate?
    @Published var s = HostStatus()
    @Published var agent = SMAppService.Status.notRegistered
    @Published var login = false
    @Published var hooks = Hooks.State.notInstalled
    @Published var codexHooks = false
    @Published var agHooks = false
    @Published var busy = false
    /// A Start/Stop/Restart in flight, and what the last one came to (HostAction.swift).
    @Published var action: HostAction?
    @Published var actionNote: HostActionNote?
    @Published var nameDraft = ""
    /// True while the name field has focus, so the 3s refresh does not overwrite
    /// what someone is typing with the name the host still has.
    var nameEditing = false
    // Mirrors of the Mac-side preferences, re-read on every pull so a change made
    // anywhere (another window, `defaults write`) shows here too.
    @Published var prefs: [BarPref: Bool] = [:]
    @Published var sound = ""
    @Published var colourful = true
    // The bar's size: the choice, what Automatic resolved to, and why.
    @Published var barSize = BarSize.automatic
    @Published var barTier = BarTier.full
    @Published var barFitNote = ""
    @Published var barHidden = false

    func pull(_ s: HostStatus, bar: NSStatusBarButton?) {
        self.s = s
        if !nameEditing { nameDraft = s.macTagSource == "name" ? s.macTag : "" }
        prefs = Dictionary(uniqueKeysWithValues: BarPref.allCases.map { ($0, $0.on) })
        sound = askSoundName
        colourful = colourfulIcon
        barSize = BarSize.current
        if let app = app {
            action = app.hostAction
            actionNote = app.currentHostActionNote
            barTier = app.barTier
            barFitNote = app.barFitNote
            barHidden = app.barHidden
        }
    }

    func pullServices() {
        let st = ServiceState.shared
        agent = st.agent
        login = st.login == .enabled
        hooks = st.hooks
        codexHooks = st.codexHooks
        agHooks = st.agHooks
    }

    /// The transports one device is on right now, in words.
    func linkText(_ device: String) -> String? {
        let kinds = Set(s.links.filter { $0.device == device }.map { $0.link.hasPrefix("usb") ? "USB" : "Bluetooth" })
        if kinds.isEmpty { return nil }
        return kinds.sorted(by: >).joined(separator: " and ")   // "USB and Bluetooth"
    }

    func batteryText(_ device: String) -> String? {
        guard let b = s.batts[device], b.ageSec < 180, b.state != 0 else { return nil }
        switch b.state {
        case 2: return "\(b.pct)%, charging"
        case 3: return "\(b.pct)%, full"
        default: return "\(b.pct)%"
        }
    }
}

/// A Toggle whose label is a title with a sentence under it - what the old menu
/// rows had to put in a tooltip.
struct DescribedToggle: View {
    let title: String
    let detail: String
    let isOn: Binding<Bool>
    var body: some View {
        Toggle(isOn: isOn) {
            Text(title)
            Text(detail)
        }
    }
}
