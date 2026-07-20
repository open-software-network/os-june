import AppKit
import CoreGraphics
import Darwin
import Foundation

private func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name),
          CommandLine.arguments.indices.contains(index + 1) else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

if CommandLine.arguments.contains("--probe") {
    let point = CGEvent(source: nil)?.location ?? .zero
    let frontmost = NSWorkspace.shared.frontmostApplication
    let payload: [String: Any] = [
        "frontmostPid": frontmost?.processIdentifier ?? 0,
        "frontmostName": frontmost?.localizedName ?? "",
        "frontmostBundleIdentifier": frontmost?.bundleIdentifier ?? "",
        "cursorX": point.x,
        "cursorY": point.y,
        "spaceKeyDown": CGEventSource.keyState(.combinedSessionState, key: 49),
        "modifierFlags": CGEventSource.flagsState(.combinedSessionState).rawValue,
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
    exit(0)
}

if let rawPid = argument("--activate-pid"),
   let pid = Int32(rawPid),
   let application = NSRunningApplication(processIdentifier: pid) {
    let activated = application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    exit(activated ? 0 : 1)
}

final class FixtureDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private let role = argument("--role") ?? "target"
    private let statePath = argument("--state")
    private let pidPath = argument("--pid-file")
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let pidPath {
            try? String(getpid()).write(toFile: pidPath, atomically: true, encoding: .utf8)
        }

        let frame = role == "observer"
            ? NSRect(x: 180, y: 180, width: 420, height: 220)
            : NSRect(x: 660, y: 240, width: 420, height: 220)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = role == "observer"
            ? "June Computer Use Observer"
            : "June Computer Use Target"
        window.setAccessibilityIdentifier(role == "observer"
            ? "june-cu-observer-window"
            : "june-cu-target-window")

        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        let heading = NSTextField(labelWithString: role == "observer"
            ? "Keep this window in front"
            : "Background action fixture")
        heading.frame = NSRect(x: 28, y: 148, width: 360, height: 28)
        heading.font = .systemFont(ofSize: 18, weight: .medium)
        content.addSubview(heading)

        let status = NSTextField(labelWithString: role == "observer"
            ? "The target must not take focus."
            : "Waiting for the approved action.")
        status.frame = NSRect(x: 28, y: 106, width: 360, height: 24)
        status.identifier = NSUserInterfaceItemIdentifier("fixture-status")
        content.addSubview(status)

        if role == "target" {
            let button = NSButton(title: "Apply fixture action", target: self, action: #selector(applyAction))
            button.frame = NSRect(x: 28, y: 62, width: 190, height: 36)
            button.setAccessibilityLabel("Apply fixture action")
            button.setAccessibilityIdentifier("fixture-action")
            content.addSubview(button)

            let input = NSTextField(frame: NSRect(x: 230, y: 64, width: 160, height: 30))
            input.placeholderString = "Type here"
            input.setAccessibilityLabel("Fixture text input")
            input.setAccessibilityIdentifier("fixture-input")
            input.identifier = NSUserInterfaceItemIdentifier("fixture-input")
            input.delegate = self
            content.addSubview(input)
        }

        window.contentView = content
        window.isReleasedWhenClosed = false
        self.window = window
        window.makeKeyAndOrderFront(nil)
        if role == "observer" {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc private func applyAction() {
        if let statePath {
            try? "clicked\n".write(toFile: statePath, atomically: true, encoding: .utf8)
        }
        if let status = window?.contentView?.subviews.first(where: {
            $0.identifier?.rawValue == "fixture-status"
        }) as? NSTextField {
            status.stringValue = "Action completed."
        }
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField,
              field.identifier?.rawValue == "fixture-input",
              let statePath else {
            return
        }
        try? "typed:\(field.stringValue)\n".write(
            toFile: statePath,
            atomically: true,
            encoding: .utf8
        )
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let app = NSApplication.shared
let delegate = FixtureDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
