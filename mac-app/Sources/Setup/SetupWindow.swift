import Cocoa

let SETUP_W: CGFloat = 470
let SETUP_PAD: CGFloat = 22

/// What the setup window shows. Built by SetupFlow.model(), rendered by SetupWindow,
/// which decides nothing - the PairWindow discipline.
struct SetupModel {
    var title = ""
    var detail = ""
    var steps: [(String, Int)] = []   // 0 to do, 1 now, 2 done, 3 skipped
    var primary = ""                  // "" hides the button
    var secondary = ""
    var busy = false
}

final class SetupWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let titleField = NSTextField(labelWithString: "")
    let stepsField = NSTextField(labelWithString: "")
    let detailField = NSTextField(wrappingLabelWithString: "")
    let spinner = NSProgressIndicator()
    let primaryButton: NSButton
    let secondaryButton: NSButton
    var onClose: (() -> Void)?

    init(target: AnyObject, primary: Selector, secondary: Selector) {
        primaryButton = NSButton(title: "", target: target, action: primary)
        secondaryButton = NSButton(title: "", target: target, action: secondary)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: SETUP_W, height: 300),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Set up Deckhand"
        window.isReleasedWhenClosed = false
        window.delegate = self

        titleField.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        stepsField.font = F_SMALL
        stepsField.textColor = .secondaryLabelColor
        detailField.font = F_BODY
        detailField.textColor = .labelColor
        detailField.preferredMaxLayoutWidth = SETUP_W - 2 * SETUP_PAD
        detailField.isSelectable = true
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        primaryButton.bezelStyle = .rounded
        primaryButton.keyEquivalent = "\r"
        secondaryButton.bezelStyle = .rounded

        let buttons = NSStackView(views: [spinner, NSView(), secondaryButton, primaryButton])
        buttons.orientation = .horizontal
        buttons.spacing = 10
        let stack = NSStackView(views: [titleField, stepsField, detailField, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: SETUP_PAD, left: SETUP_PAD, bottom: SETUP_PAD, right: SETUP_PAD)
        stack.setCustomSpacing(8, after: titleField)
        stack.translatesAutoresizingMaskIntoConstraints = false
        buttons.translatesAutoresizingMaskIntoConstraints = false
        buttons.widthAnchor.constraint(equalToConstant: SETUP_W - 2 * SETUP_PAD).isActive = true
        window.contentView = stack
        stack.widthAnchor.constraint(equalToConstant: SETUP_W).isActive = true
    }

    func render(_ m: SetupModel) {
        titleField.stringValue = m.title
        let marks = ["\u{25CB}", "\u{25B8}", "\u{2713}", "\u{2013}"]
        stepsField.stringValue = m.steps.map { "\(marks[$0.1]) \($0.0)" }.joined(separator: "     ")
        detailField.stringValue = m.detail
        primaryButton.title = m.primary
        primaryButton.isHidden = m.primary.isEmpty
        primaryButton.isEnabled = !m.busy
        secondaryButton.title = m.secondary
        secondaryButton.isHidden = m.secondary.isEmpty
        secondaryButton.isEnabled = !m.busy
        if m.busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        window.layoutIfNeeded()
        if let v = window.contentView { window.setContentSize(v.fittingSize) }
    }

    func show() {
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ n: Notification) { onClose?() }
}
