import Cocoa

/// START, STOP AND RESTART SAY WHAT THEY ARE DOING, AND THEN WHAT HAPPENED.
///
/// Before this, a click on any of the three changed nothing visible: "running" is
/// read from the heartbeat's age (< 12s), so a stopped host looked alive for up to
/// 12s, and a restarted one writes the same heartbeat as the old one - nothing on
/// screen moved at all. (User report, 2026-11-13: "the response is none".)
///
/// Now a click enters an in-progress state at once (a spinner and "Stopping..." in
/// Settings, a disabled "Stopping Deckhand..." in the menu), the heartbeat is polled
/// every half second until the change is REAL - stopped: no live heartbeat; started:
/// a live one; restarted: a live one from a different `pid` - and the result is
/// stated for a few seconds. A change that has not happened after `timeout` is
/// reported as such, with the log as the next step, rather than left to look like
/// success.
enum HostActionKind {
    case starting, stopping, restarting

    var progressTitle: String {
        switch self {
        case .starting: return "Starting Deckhand\u{2026}"
        case .stopping: return "Stopping Deckhand\u{2026}"
        case .restarting: return "Restarting Deckhand\u{2026}"
        }
    }
    var progressDetail: String {
        switch self {
        case .starting: return "Waiting for the background host to report in."
        case .stopping: return "Waiting for the background host to exit."
        case .restarting: return "Waiting for a fresh background host to report in."
        }
    }
    var doneText: String {
        switch self {
        case .starting: return "Started."
        case .stopping: return "Stopped."
        case .restarting: return "Restarted."
        }
    }
    var failedText: String {
        switch self {
        case .starting: return "Deckhand did not start within 20 seconds. Open the host log to see why."
        case .stopping: return "Deckhand did not stop within 20 seconds. Open the host log to see why."
        case .restarting: return "Deckhand did not come back within 20 seconds. Open the host log to see why."
        }
    }
}

struct HostAction {
    let kind: HostActionKind
    let since: Date
    /// The pid the heartbeat carried when Restart was clicked.
    let fromPid: Int?
}

/// What the last action came to, shown for a few seconds after it ends.
struct HostActionNote {
    let text: String
    let failed: Bool
    let until: Date
}

let HOST_ACTION_TIMEOUT: TimeInterval = 20
let HOST_ACTION_POLL: TimeInterval = 0.5

extension AppDelegate {
    /// Enter the in-progress state, then run `work` OFF the main thread: launchctl,
    /// pkill and SMAppService are calls into other processes, and running them on
    /// the main thread froze the very window that was meant to answer the click.
    func beginHostAction(_ kind: HostActionKind, _ work: @escaping () -> Void) {
        hostActionNote = nil
        hostAction = HostAction(kind: kind, since: Date(), fromPid: readStatus().pid)
        refresh()
        hostActionTimer?.invalidate()
        // .common, not the default mode: an open menu runs the loop in its tracking
        // mode, where a scheduledTimer does not fire - and the menu is exactly where
        // someone who just clicked Stop is looking.
        let t = Timer(timeInterval: HOST_ACTION_POLL, repeats: true) { [weak self] _ in self?.pollHostAction() }
        RunLoop.main.add(t, forMode: .common)
        hostActionTimer = t
        DispatchQueue.global(qos: .userInitiated).async(execute: work)
    }

    /// Whether the change the click asked for has actually happened.
    func hostActionDone(_ a: HostAction, _ s: HostStatus) -> Bool {
        switch a.kind {
        case .stopping: return !s.running
        case .starting: return s.running
        case .restarting:
            guard s.running else { return false }
            // A host from before the heartbeat carried a pid cannot show the change;
            // after 3s of it running again, that is the best evidence there is.
            if let from = a.fromPid, let now = s.pid { return now != from }
            return Date().timeIntervalSince(a.since) > 3
        }
    }

    func pollHostAction() {
        guard let a = hostAction else { hostActionTimer?.invalidate(); hostActionTimer = nil; return }
        let s = readStatus()
        let done = hostActionDone(a, s)
        guard done || Date().timeIntervalSince(a.since) > HOST_ACTION_TIMEOUT else { return }
        hostAction = nil
        hostActionTimer?.invalidate()
        hostActionTimer = nil
        hostActionNote = done
            ? HostActionNote(text: a.kind.doneText, failed: false, until: Date().addingTimeInterval(4))
            : HostActionNote(text: a.kind.failedText, failed: true, until: Date().addingTimeInterval(30))
        refresh()
        // Clear the note when it expires, rather than waiting for the next 3s tick.
        let until = hostActionNote!.until
        DispatchQueue.main.asyncAfter(deadline: .now() + until.timeIntervalSinceNow + 0.05) { [weak self] in
            guard let self = self, let n = self.hostActionNote, n.until <= Date() else { return }
            self.hostActionNote = nil
            self.refresh()
        }
    }

    /// The note, while it is still current.
    var currentHostActionNote: HostActionNote? {
        guard let n = hostActionNote, n.until > Date() else { return nil }
        return n
    }
}
