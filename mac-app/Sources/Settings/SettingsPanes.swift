import Cocoa
import SwiftUI

struct GeneralPane: View {
    @ObservedObject var m: SettingsModel

    var statusColor: Color {
        !m.s.running ? .secondary : (m.s.deviceConnected ? .green : .orange)
    }
    var statusTitle: String {
        if !m.s.running { return "Stopped" }
        if m.s.deviceConnected, let d = m.s.device { return "Syncing with \(d)" }
        return "Running, no display connected"
    }
    var statusDetail: String {
        if !m.s.running { return "The display is not being updated." }
        if m.s.deviceConnected, let d = m.s.device {
            return m.linkText(d).map { "Connected over \($0)." } ?? "Connected."
        }
        return "Plug a Deckhand in over USB, or turn one on that is paired over Bluetooth."
    }

    var body: some View {
        Form {
            Section {
                HStack(alignment: .center, spacing: 12) {
                    Circle().fill(statusColor).frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(statusTitle).font(.headline)
                        Text(statusDetail).font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if m.s.running { Button("Restart") { m.app?.restartHost() } }
                    Button(m.s.running ? "Stop" : "Start") { m.app?.toggleHost() }
                }
                .padding(.vertical, 2)
            } header: {
                Text("Deckhand")
            } footer: {
                HStack {
                    Text(m.app?.hostSupervisionText() ?? "")
                    Spacer()
                    Button("Open Host Log") { m.app?.openLog() }.buttonStyle(.link)
                }
                .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                DescribedToggle(
                    title: "Open Deckhand at login",
                    detail: isBundled
                        ? "Keeps this menu-bar icon after a restart. The background host starts at login either way."
                        : "Keeps this menu-bar icon after a restart.",
                    isOn: Binding(get: { m.login }, set: { m.app?.setLaunchAtLogin($0) }))
            }

            Section("When a session needs you") {
                DescribedToggle(
                    title: "Answer prompts on the display",
                    detail: m.s.running
                        ? "Approve or deny from the device. Claude Code's own dialog stays open, and whichever answers first wins."
                        : "Available while Deckhand is running.",
                    isOn: Binding(get: { m.s.remoteAnswer }, set: { m.app?.setRemoteAnswer($0) }))
                    .disabled(!m.s.running)
                Picker("Sound", selection: Binding(get: { m.sound }, set: { m.app?.setAskSound($0) })) {
                    Text("None").tag("")
                    Divider()
                    ForEach(ASK_SOUNDS, id: \.self) { Text($0).tag($0) }
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct MenuBarPane: View {
    @ObservedObject var m: SettingsModel

    func toggle(_ p: BarPref) -> Binding<Bool> {
        Binding(get: { m.prefs[p] ?? p.on }, set: { m.app?.setBarPref(p, $0) })
    }
    var mirrorsOn: Bool { (m.prefs[.usage] ?? true) || (m.prefs[.codex] ?? true) || (m.prefs[.gemini] ?? true) || (m.prefs[.sessions] ?? true) }
    func preview(_ tier: BarTier) -> NSImage {
        barImage(barModel(m.s, tier: tier, previewing: true), boat: barBoatStyle(m.s), colourful: m.colourful, height: NSStatusBar.system.thickness)
    }
    var hiddenNote: String? {
        if (m.prefs[.onlyOffline] ?? true) && m.s.deviceConnected && mirrorsOn {
            return "Usage and session counts are hidden right now because \(m.s.device ?? "a display") is connected and shows them."
        }
        return nil
    }
    var sizeFooter: String {
        if m.barHidden {
            return "macOS has no room for Deckhand's icon at this size. Choose a smaller one, or hold \u{2318} and drag Deckhand's icon further right in the menu bar."
        }
        if let note = hiddenNote { return note + " The previews show them anyway." }
        if m.barSize == .automatic {
            return m.barFitNote.isEmpty
                ? "Automatic is showing \(m.barTier.title). It steps down if macOS runs out of room in the menu bar, and tries again when your displays change."
                : m.barFitNote
        }
        return hiddenNote ?? "Hover over the icon in the menu bar for every figure spelled out."
    }

    /// One size: a radio mark, what it keeps, and what it looks like right now.
    func sizeRow(_ size: BarSize) -> some View {
        let selected = m.barSize == size
        let tier = size.tier ?? m.barTier
        return Button { m.app?.setBarSize(size) } label: {
            HStack(spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(size == .automatic ? "Automatic" : tier.title)
                    Text(size == .automatic ? "Fits itself to the space in the menu bar." : tier.detail)
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Image(nsImage: preview(tier))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color(nsColor: .windowBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color(nsColor: .separatorColor)))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    var body: some View {
        Form {
            Section {
                ForEach(BarSize.allCases, id: \.self) { sizeRow($0) }
            } header: {
                Text("Size")
            } footer: {
                Text(sizeFooter).font(.caption).foregroundStyle(m.barHidden ? Color.orange : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section("Beside the icon") {
                DescribedToggle(title: "Claude usage", detail: "5-hour figure on top, 7-day below. \u{25B2} means you are using it faster than the clock.", isOn: toggle(.usage))
                DescribedToggle(title: "Codex usage", detail: "Only on a Mac where Codex reports a quota.", isOn: toggle(.codex))
                DescribedToggle(title: "Antigravity usage", detail: "AG: Antigravity's most-used Gemini limit, from the Antigravity app while it runs, otherwise from the agy CLI.", isOn: toggle(.gemini))
                DescribedToggle(title: "Session counts", detail: "\u{25CB} waiting on you, \u{25CF} working.", isOn: toggle(.sessions))
                DescribedToggle(title: "Needs-input count", detail: "\u{25A0} and how many sessions are waiting for your answer.", isOn: toggle(.asking))
            }

            Section {
                DescribedToggle(title: "Hide usage and session counts while a display is connected",
                                detail: "The display already shows them. The needs-input count stays.", isOn: toggle(.onlyOffline))
                    .disabled(!mirrorsOn)
                DescribedToggle(title: "Colourful icon", detail: "Off follows the menu bar's own colour, light or dark.",
                                isOn: Binding(get: { m.colourful }, set: { m.app?.setColourfulIcon($0) }))
            }
        }
        .formStyle(.grouped)
    }
}

struct DevicesPane: View {
    @ObservedObject var m: SettingsModel
    @FocusState private var nameFocused: Bool

    var nameLocked: Bool { m.s.macTagSource == "env" }

    var body: some View {
        Form {
            Section {
                if m.s.devices.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("No displays yet")
                        Text("Connect a Deckhand over USB and it pairs by itself. To add one over Bluetooth only, use Pair New Device.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
                ForEach(m.s.devices, id: \.self) { name in
                    let link = m.linkText(name)
                    HStack(spacing: 10) {
                        Image(systemName: link != nil ? "rectangle.portrait.fill" : "rectangle.portrait")
                            .foregroundStyle(link != nil ? Color.accentColor : Color.secondary)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(name)
                            Text([link.map { "Connected over \($0)" } ?? "Not connected", m.batteryText(name)]
                                    .compactMap { $0 }.joined(separator: "  \u{00B7}  "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Forget\u{2026}") { m.app?.forgetDevice(name) }
                            .disabled(!m.s.running)
                    }
                }
            } header: {
                Text("Paired displays")
            } footer: {
                HStack {
                    Spacer()
                    Button("Pair New Device\u{2026}") { m.app?.openPairWindow() }
                }
            }

            if m.s.devices.count > 1 {
                Section {
                    Picker("Bluetooth connects to", selection: Binding(get: { m.s.selected ?? "" }, set: { m.app?.selectDevice($0) })) {
                        Text("Any paired display").tag("")
                        Divider()
                        ForEach(m.s.devices, id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(!m.s.running)
                } footer: {
                    Text("USB always connects whichever display is plugged in.").font(.caption).foregroundStyle(.secondary)
                }
            }

            Section {
                LabeledContent("Name") {
                    HStack {
                        TextField("", text: $m.nameDraft, prompt: Text(m.s.macTagAuto.isEmpty ? "automatic" : m.s.macTagAuto))
                            .frame(width: 110)
                            .multilineTextAlignment(.trailing)
                            .focused($nameFocused)
                            .onSubmit { m.app?.setMacName(m.nameDraft); nameFocused = false }
                        Button("Save") { m.app?.setMacName(m.nameDraft); nameFocused = false }
                            .disabled(m.nameDraft == (m.s.macTagSource == "name" ? m.s.macTag : ""))
                    }
                }
                .disabled(nameLocked || !m.s.running)
                .onChange(of: nameFocused) { _, f in m.nameEditing = f }

                LabeledContent("Icon") {
                    let current = m.app?.currentIcon(m.s) ?? ""
                    LazyVGrid(columns: Array(repeating: GridItem(.fixed(30), spacing: 4), count: 8), spacing: 4) {
                        ForEach(MAC_ICON_NAMES, id: \.self) { name in
                            Button { m.app?.setIcon(name) } label: {
                                Text(MAC_ICON_GLYPHS[name] ?? "?").font(.system(size: 17))
                                    .frame(width: 30, height: 28)
                                    .background(RoundedRectangle(cornerRadius: 6)
                                        .fill(name == current ? Color.accentColor.opacity(0.25) : Color.clear))
                                    .overlay(RoundedRectangle(cornerRadius: 6)
                                        .stroke(name == current ? Color.accentColor : Color.clear, lineWidth: 1.5))
                            }
                            .buttonStyle(.plain)
                            .help(name)
                        }
                    }
                }
                .disabled(m.s.iconFromEnv)
            } header: {
                Text("This Mac on the display")
            } footer: {
                Text(nameLocked || m.s.iconFromEnv
                     ? "Set by DECKHAND_MAC_TAG / DECKHAND_MAC_EMOJI in the host's environment, so it cannot be changed here."
                     : "Shown beside this Mac's sessions when more than one Mac uses the same display. Up to 6 letters or digits; leave it empty for the automatic name.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct ClaudePane: View {
    @ObservedObject var m: SettingsModel

    var state: (symbol: String, color: Color, title: String, detail: String) {
        switch m.hooks {
        case .installed:
            return ("checkmark.circle.fill", .green, "Installed",
                    isBundled ? "Claude Code reports every session to Deckhand, running on Deckhand's own Node."
                              : "Claude Code reports every session to Deckhand, through the released app's Node.")
        case .notInstalled:
            return ("exclamationmark.circle.fill", .orange, "Not installed",
                    "Sessions will not appear on the display or in the menu until the hooks are installed.")
        case .fromSource:
            return ("info.circle.fill", .blue, "Installed by install.sh",
                    isBundled ? "They run on the node on your PATH. Switching moves them to Deckhand's own Node, which keeps working through Homebrew upgrades."
                              : "They run on the node on your PATH, as install.sh set them up.")
        case .needsRepair:
            return ("exclamationmark.triangle.fill", .orange, "Need repair",
                    "The scripts in ~/.claude or the link to Deckhand's Node do not match this copy of Deckhand.")
        }
    }
    var installTitle: String {
        switch m.hooks {
        case .installed: return "Reinstall"
        case .notInstalled: return "Install\u{2026}"
        case .fromSource: return "Switch to Deckhand's Node\u{2026}"
        case .needsRepair: return "Repair"
        }
    }

    var body: some View {
        Form {
            Section {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: state.symbol).foregroundStyle(state.color).font(.title2)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(state.title).font(.headline)
                        Text(state.detail).font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                }
                .padding(.vertical, 2)
                if isBundled {
                    HStack {
                        if m.busy { ProgressView().controlSize(.small) }
                        Spacer()
                        Button("Remove\u{2026}") { m.app?.removeHooks() }
                            .disabled(m.busy || m.hooks == .notInstalled)
                        Button(installTitle) { m.app?.installHooks() }
                            .disabled(m.busy)
                    }
                }
                if isBundled && Hooks.codexPresent && m.hooks != .notInstalled {
                    DescribedToggle(
                        title: "Codex hooks",
                        detail: "Shows when a Codex session is waiting for your approval, and lets the display answer it. Without them Codex sessions still appear, as working or waiting.",
                        isOn: Binding(get: { m.codexHooks }, set: { m.app?.setCodexHooks($0) }))
                        .disabled(m.busy)
                } else {
                    LabeledContent("Codex", value: m.codexHooks ? "Hooks installed" : (Hooks.codexPresent ? "No hooks" : "Not on this Mac"))
                }
                if isBundled && Hooks.antigravityPresent && m.hooks != .notInstalled {
                    DescribedToggle(
                        title: "Antigravity hook",
                        detail: "Adds the model and the latest prompt to Antigravity sessions. It never answers or holds up a tool call: Antigravity has no hook while its approval prompt is up, so those prompts are answered in Antigravity. Without it, sessions still appear, as working or waiting.",
                        isOn: Binding(get: { m.agHooks }, set: { m.app?.setAntigravityHooks($0) }))
                        .disabled(m.busy)
                } else {
                    LabeledContent("Antigravity", value: m.agHooks ? "Hook installed" : (Hooks.antigravityPresent ? "No hook" : "Not on this Mac"))
                }
            } header: {
                Text("Hooks")
            } footer: {
                Text(isBundled
                     ? "Deckhand learns what each session is doing (working, waiting, asking for permission) from hooks in ~/.claude/settings.json. Your own hooks and status line are never changed, and a backup goes to ~/Deckhand-backups before every change."
                     : "This build drives the host in your checkout, where install.sh manages the hooks.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct AboutPane: View {
    @ObservedObject var m: SettingsModel
    var version: String {
        let i = Bundle.main.infoDictionary ?? [:]
        let v = (i["CFBundleShortVersionString"] as? String) ?? "?"
        let b = (i["CFBundleVersion"] as? String) ?? "?"
        let c = (i["DeckhandCommit"] as? String).map { ", \($0)" } ?? ""
        // A pre-release says so beside its version (build-release.sh --channel).
        let ch = (i["DeckhandChannel"] as? String).flatMap { $0.isEmpty ? nil : " \($0)" } ?? ""
        return "Version \(v)\(ch) (\(b)\(c))"
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Deckhand").font(.title2.weight(.semibold))
                        Text(version).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Spacer()
                }
                .padding(.vertical, 4)
            }

            if let app = m.app, app.updatesAvailable {
                Section("Updates") {
                    Toggle("Check for updates automatically", isOn: Binding(
                        get: { app.autoCheckUpdates }, set: { app.autoCheckUpdates = $0; m.objectWillChange.send() }))
                    Toggle("Download and install updates automatically", isOn: Binding(
                        get: { app.autoInstallUpdates }, set: { app.autoInstallUpdates = $0; m.objectWillChange.send() }))
                        .disabled(!app.autoCheckUpdates)
                    HStack {
                        Spacer()
                        Button("Check Now") { app.checkForUpdates() }
                    }
                }
            }

            Section("Troubleshooting") {
                LabeledContent("Host log") { Button("Open") { m.app?.openLog() } }
                if isBundled {
                    LabeledContent("First-run setup") { Button("Run Again\u{2026}") { m.app?.openSetup() } }
                    LabeledContent("Remove Deckhand from this Mac") {
                        Button("Uninstall\u{2026}", role: .destructive) { m.app?.uninstallDeckhand() }
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}
