import Cocoa
import ServiceManagement

/// SMAppService's `status` is a SYNCHRONOUS round trip to the system's background-
/// task daemon. Measured on this Mac with `sample`: ~35ms per refresh, on the MAIN
/// thread, every 3 seconds (the agent's status and the login item's) - and when that
/// daemon is slow, at login or under load, the whole menu freezes with it. So it is
/// read here, off the main thread, every 15s and right after anything this app does
/// to either service; everything on the main thread reads the cached answer. The
/// hooks' state rides along: it reads settings.json and compares two 45KB scripts,
/// which is cheap but is still file I/O the 3s refresh has no reason to repeat.
final class ServiceState {
    static let shared = ServiceState()
    private let queue = DispatchQueue(label: "deckhand.service-state", qos: .utility)
    private let lock = NSLock()
    private var _agent = SMAppService.Status.notRegistered
    private var _login = SMAppService.Status.notRegistered
    private var _hooks = Hooks.State.notInstalled
    private var _codexHooks = false
    private var _agHooks = false

    var agent: SMAppService.Status { lock.withLock { _agent } }
    var login: SMAppService.Status { lock.withLock { _login } }
    var hooks: Hooks.State { lock.withLock { _hooks } }
    var codexHooks: Bool { lock.withLock { _codexHooks } }
    var agHooks: Bool { lock.withLock { _agHooks } }

    /// On the calling thread. Only for launch and the --setup-do / preview modes,
    /// where nothing is drawn yet that a 35ms wait could freeze.
    func refreshNow() {
        let a = isBundled ? hostAgent().status : .notRegistered
        let l = SMAppService.mainApp.status
        let h = Hooks.state()
        let c = Hooks.codexInstalled()
        let g = Hooks.antigravityInstalled()
        lock.withLock { _agent = a; _login = l; _hooks = h; _codexHooks = c; _agHooks = g }
    }

    /// Off the main thread; `then` runs on the main thread afterwards.
    func refresh(then: (() -> Void)? = nil) {
        queue.async {
            self.refreshNow()
            if let then = then { DispatchQueue.main.async(execute: then) }
        }
    }
}
