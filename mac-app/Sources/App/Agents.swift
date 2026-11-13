import Foundation

// MARK: - Settings > Agents: which agents Deckhand watches, and where each is shown
//
// Per agent, three switches (asked for 2026-11-13: "whole off, and no display, display
// on menu, display on dropdown"):
//   On               WHOLE off when unchecked. Written to ~/.claude/deckhand-agents.json,
//                    which the HOST reads every tick (host/agents.mjs): it stops polling
//                    that agent's usage, drops what it had cached, and leaves its
//                    sessions out of everything - the menu bar, the menu and the display.
//   Beside the icon  the usage column in the menu bar (the BarPref that already existed).
//   In the menu      the usage rows in the menu that drops down.
// The two display switches leave the agent tracked and on the display; both off is
// "no display" on the Mac.
//
// THE FILE IS THE TRUTH FOR "On", not UserDefaults, because the host has to read it
// whether or not this app is running - and a switch flipped while the host is down
// must still hold when it starts. Absent means all on, as it was before the file.

enum AgentSwitch: String, CaseIterable {
    case claude, codex, antigravity

    var title: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .antigravity: return "Antigravity"
        }
    }

    /// The usage column beside the icon (the switch that was "Claude usage" etc. on the
    /// Menu Bar pane).
    var barPref: BarPref {
        switch self {
        case .claude: return .usage
        case .codex: return .codex
        case .antigravity: return .gemini
        }
    }

    /// The usage rows in the menu. Default ON, like every BarPref.
    var menuKey: String { "menuShow." + rawValue }
    var inMenu: Bool { UserDefaults.standard.object(forKey: menuKey) as? Bool ?? true }

    var on: Bool { AgentSwitch.readFile()[self] ?? true }

    static let filePath = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/deckhand-agents.json")

    /// Every agent's On switch. Missing file, unreadable file, or a key that is not a
    /// boolean: ON - the host's parseAgents() reads it the same way.
    static func readFile() -> [AgentSwitch: Bool] {
        var out: [AgentSwitch: Bool] = [:]
        guard let data = FileManager.default.contents(atPath: filePath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return out }
        for a in allCases { if let b = obj[a.rawValue] as? Bool { out[a] = b } }
        return out
    }

    /// Writes all three, atomically, so the host never reads half a file.
    static func write(_ a: AgentSwitch, on: Bool) {
        var cur = readFile()
        cur[a] = on
        var obj: [String: Bool] = [:]
        for k in allCases { obj[k.rawValue] = cur[k] ?? true }
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        try? FileManager.default.createDirectory(atPath: (filePath as NSString).deletingLastPathComponent,
                                                 withIntermediateDirectories: true)
        do {
            try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
        } catch {
            NSLog("Deckhand: could not write %@: %@", filePath, error.localizedDescription)
        }
    }
}
