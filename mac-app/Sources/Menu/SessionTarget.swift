import Cocoa

/// One editor window, from `~/.claude/ide/<port>.lock` - Claude Code's own record
/// of an IDE it is attached to, written per WORKSPACE (two VS Code windows on
/// different folders produce two locks sharing one pid).
struct IdeWindow { var ideName = "", folder = ""; var pid = 0 }

/// Every editor window Claude Code currently knows about. Pure file reads, no
/// spawns, so this can run on a click without a budget worry.
func ideWindows() -> [IdeWindow] {
    let dir = NSHomeDirectory() + "/.claude/ide"
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
    var out: [IdeWindow] = []
    for n in names where n.hasSuffix(".lock") {
        guard let d = FileManager.default.contents(atPath: dir + "/" + n),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
        let folders = (o["workspaceFolders"] as? [String]) ?? []
        for f in folders {
            out.append(IdeWindow(ideName: o["ideName"] as? String ?? "",
                                 folder: f, pid: o["pid"] as? Int ?? 0))
        }
    }
    return out
}

/// Where a click on a session row goes. Three tiers, because "jump to the app"
/// means genuinely different things per surface.
enum SessionTarget {
    /// An editor window: open its WORKSPACE FOLDER with that app, which brings
    /// the existing window forward.
    case workspace(app: URL, folder: String, ide: String)
    /// A terminal or the desktop app: bring the app forward and nothing more.
    case activate(NSRunningApplication)
    /// Unknown app, or the app is not running: what this menu has always done.
    case reveal(String)
    case nothing
}

/// The FOLDER matters more than it looks. A session's `path` is its live cwd, so
/// it is routinely a SUBDIRECTORY of the workspace (this repo reports
/// ".../deckhand/host"), and opening that in VS Code spawns a NEW window on the
/// subfolder instead of focusing the one already open. So the lock file's own
/// workspaceFolder is the thing to open.
///
/// It also copes with the host's `truncatePath`, which prefixes "..." past 64
/// characters. A plain suffix test does NOT recover those - measured on a crafted
/// case and it failed: the truncation can begin INSIDE the workspace folder
/// ("...ers/yujia/projects/deckhand/mac-app"), so neither string contains the
/// other. What always holds is that the kept tail starts somewhere within the
/// full cwd, and the folder is a prefix of that cwd - so some SUFFIX of the folder
/// is a PREFIX of the tail. That is what `overlaps` looks for, and only for a
/// path that really was truncated, since on a whole path it would invite false
/// matches.
func matchingIdeWindow(_ r: SessionRow) -> IdeWindow? {
    let truncated = r.path.hasPrefix("...")
    let p = truncated ? String(r.path.dropFirst(3)) : r.path
    guard !p.isEmpty else { return nil }

    func overlaps(_ folder: String) -> Bool {
        if p.hasPrefix(folder) { return true }
        guard truncated else { return false }
        // Require a decent run of shared text - a 2-character tail would match
        // almost anything, and picking the wrong window is worse than falling
        // back to activating the app.
        var tail = Substring(folder)
        while tail.count >= 6 {
            if p.hasPrefix(tail) { return true }
            tail = tail.dropFirst()
        }
        return false
    }
    // Longest folder first, so a nested workspace wins over its parent.
    for w in ideWindows().sorted(by: { $0.folder.count > $1.folder.count })
    where overlaps(w.folder) { return w }
    return nil
}

/// Only surfaces MEASURED to be editors get the workspace treatment. The value
/// observed on this machine is "claude-vscode"; JetBrains is included on the same
/// naming pattern but is UNVERIFIED, and anything else - a terminal, the desktop
/// app - falls through to activate-only deliberately. There is no way to focus a
/// particular terminal tab, and opening the folder there would spawn a new window,
/// which is worse than doing the unsurprising thing.
func isEditorEntry(_ entry: String) -> Bool {
    entry.contains("vscode") || entry.contains("jetbrains")
}

func sessionTarget(_ r: SessionRow) -> SessionTarget {
    guard !r.app.isEmpty else { return r.path.isEmpty ? .nothing : .reveal(r.path) }
    // NOT RUNNING means fall back rather than LAUNCH. Clicking a stale row should
    // never boot an editor for a session that no longer exists in it.
    guard let running = NSRunningApplication
        .runningApplications(withBundleIdentifier: r.app).first else {
        return r.path.isEmpty ? .nothing : .reveal(r.path)
    }
    if isEditorEntry(r.appEntry), let w = matchingIdeWindow(r),
       let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: r.app) {
        return .workspace(app: url, folder: w.folder, ide: w.ideName)
    }
    return .activate(running)
}

/// One line saying what a click will do, for `--open-session` and the row tooltip.
/// Shared so the diagnostic cannot describe one thing while the click does another.
func describeTarget(_ t: SessionTarget) -> String {
    switch t {
    case .workspace(_, let folder, let ide): return "open \(folder) in \(ide.isEmpty ? "the editor" : ide)"
    case .activate(let app): return "activate \(app.localizedName ?? app.bundleIdentifier ?? "the app")"
    case .reveal(let path): return "reveal \(path) in Finder"
    case .nothing: return "nothing (no app and no path)"
    }
}

func performTarget(_ t: SessionTarget) {
    switch t {
    case .workspace(let app, let folder, _):
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        NSWorkspace.shared.open([URL(fileURLWithPath: folder)],
                                withApplicationAt: app, configuration: cfg)
    case .activate(let app):
        app.activate(options: [.activateAllWindows])
    case .reveal(let path):
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    case .nothing:
        break
    }
}
