import Foundation
import AVFoundation
import AppKit
import Carbon
import CoreMedia
import CoreGraphics

struct HelperEvent: Encodable {
    let type: String
    let payload: [String: String]
}

func emit(_ type: String, _ payload: [String: String] = [:]) {
    let event = HelperEvent(type: type, payload: payload)
    guard
        let data = try? JSONEncoder().encode(event),
        let line = String(data: data, encoding: .utf8)
    else {
        return
    }
    print(line)
    fflush(stdout)
}

func emitJSON(_ type: String, _ payload: [String: Any] = [:]) {
    let event: [String: Any] = [
        "type": type,
        "payload": payload,
    ]
    guard
        JSONSerialization.isValidJSONObject(event),
        let data = try? JSONSerialization.data(withJSONObject: event),
        let line = String(data: data, encoding: .utf8)
    else {
        return
    }
    print(line)
    fflush(stdout)
}

func boolStatus(_ value: Bool) -> String {
    value ? "granted" : "missing"
}

func microphoneStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return "granted"
    case .denied:
        return "denied"
    case .restricted:
        return "restricted"
    case .notDetermined:
        return "not_determined"
    @unknown default:
        return "unknown"
    }
}

func permissionPayload() -> [String: String] {
    [
        "microphone": microphoneStatus(),
        "accessibility": boolStatus(AXIsProcessTrusted()),
    ]
}

func helperBundleIdentifier() -> String {
    Bundle.main.bundleIdentifier ?? "unknown"
}

enum RecordingCueSound: String {
    case start = "record-start"
    case stop = "record-end"
}

enum RecordingCuePlayer {
    private static var sounds: [RecordingCueSound: NSSound] = [:]

    static func play(_ cue: RecordingCueSound) {
        let sound = sounds[cue] ?? load(cue)
        guard let sound else {
            return
        }
        sound.stop()
        sound.currentTime = 0
        sound.play()
    }

    private static func load(_ cue: RecordingCueSound) -> NSSound? {
        guard let url = Bundle.main.url(forResource: cue.rawValue, withExtension: "mp3") else {
            return nil
        }
        guard let sound = NSSound(contentsOf: url, byReference: false) else {
            return nil
        }
        sounds[cue] = sound
        return sound
    }
}

func microphoneDevices() -> [[String: String]] {
    audioInputDevices().map { device in
        [
            "id": device.uniqueID,
            "name": device.localizedName,
        ]
    }
}

func audioInputDevices() -> [AVCaptureDevice] {
    let deviceTypes: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) {
        deviceTypes = [.microphone, .external]
    } else {
        deviceTypes = [.builtInMicrophone, .externalUnknown]
    }
    return AVCaptureDevice.DiscoverySession(
        deviceTypes: deviceTypes,
        mediaType: .audio,
        position: .unspecified
    ).devices
}

func microphoneDevice(for id: String?) -> AVCaptureDevice? {
    guard let id, !id.isEmpty else {
        return nil
    }
    return audioInputDevices().first { device in
        device.uniqueID == id
    }
}

func emitMicrophoneDevices(selectedID: String?) {
    emitJSON("microphone_devices", [
        "devices": microphoneDevices(),
        "selectedID": selectedID ?? "",
    ])
}

func runOnMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
        work()
    } else {
        DispatchQueue.main.async(execute: work)
    }
}

struct ShortcutModifiers {
    let command: Bool
    let control: Bool
    let option: Bool
    let shift: Bool
    let function: Bool

    init(
        command: Bool = false,
        control: Bool = false,
        option: Bool = false,
        shift: Bool = false,
        function: Bool = false
    ) {
        self.command = command
        self.control = control
        self.option = option
        self.shift = shift
        self.function = function
    }

    init(payload: [String: Any]) {
        command = payload["command"] as? Bool ?? false
        control = payload["control"] as? Bool ?? false
        option = payload["option"] as? Bool ?? false
        shift = payload["shift"] as? Bool ?? false
        function = payload["function"] as? Bool ?? false
    }

    var hasAny: Bool {
        command || control || option || shift || function
    }

    var isBareFunction: Bool {
        function && !command && !control && !option && !shift
    }

    var payload: [String: Bool] {
        [
            "command": command,
            "control": control,
            "option": option,
            "shift": shift,
            "function": function,
        ]
    }

    var labelParts: [String] {
        [
            command ? "Cmd" : nil,
            control ? "Ctrl" : nil,
            option ? "Opt" : nil,
            shift ? "Shift" : nil,
            function ? "Fn" : nil,
        ].compactMap { $0 }
    }
}

struct MonitoredShortcut {
    let keyCode: UInt16
    let code: String
    let label: String
    let modifiers: ShortcutModifiers

    static let bareFn = MonitoredShortcut(
        keyCode: 0,
        code: "Fn",
        label: "Fn",
        modifiers: ShortcutModifiers(function: true)
    )

    init(keyCode: UInt16, code: String, label: String, modifiers: ShortcutModifiers) {
        self.keyCode = keyCode
        self.code = code
        self.label = label
        self.modifiers = modifiers
    }

    init?(payload: [String: Any]) {
        let code = payload["code"] as? String ?? ""
        let label = payload["label"] as? String ?? ""
        let modifiersPayload = payload["modifiers"] as? [String: Any] ?? [:]
        let keyCode: UInt16

        if let rawKeyCode = payload["keyCode"] as? UInt16 {
            keyCode = rawKeyCode
        } else if let rawKeyCode = payload["keyCode"] as? Int, rawKeyCode >= 0, rawKeyCode <= Int(UInt16.max) {
            keyCode = UInt16(rawKeyCode)
        } else if let rawKeyCode = payload["keyCode"] as? NSNumber {
            keyCode = rawKeyCode.uint16Value
        } else {
            return nil
        }

        guard !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }

        self.keyCode = keyCode
        self.code = code
        self.label = label
        self.modifiers = ShortcutModifiers(payload: modifiersPayload)
    }

    var isBareFn: Bool {
        code.caseInsensitiveCompare("Fn") == .orderedSame
            && modifiers.function
            && !modifiers.command
            && !modifiers.control
            && !modifiers.option
            && !modifiers.shift
    }

    var payload: [String: Any] {
        [
            "keyCode": Int(keyCode),
            "code": code,
            "label": label,
            "modifiers": modifiers.payload,
        ]
    }
}

final class ShortcutKeyMonitor {
    static let shared = ShortcutKeyMonitor()

    private var globalMonitor: Any?
    private var eventTap: CFMachPort?
    private var eventTapRunLoopSource: CFRunLoopSource?
    private var shortcut = MonitoredShortcut.bareFn
    private var shortcutIsDown = false
    private var isCapturingShortcut = false
    private var pendingBareFnCapture: DispatchWorkItem?

    private init() {}

    func start() {
        guard globalMonitor == nil, eventTap == nil else {
            return
        }

        startGlobalMonitor()
        startEventTap()

        if globalMonitor == nil, eventTap == nil {
            emit("fn_monitor_unavailable", [
                "message": "Could not monitor Fn/Globe key events.",
            ])
        }
    }

    fileprivate func enableEventTap() {
        guard let eventTap else {
            return
        }

        CGEvent.tapEnable(tap: eventTap, enable: true)
    }

    fileprivate func handle(flags: CGEventFlags) {
        if isCapturingShortcut {
            handleCapture(flags: flags)
            return
        }

        if shortcut.isBareFn {
            observe(isDown: flags.contains(.maskSecondaryFn))
            return
        }

        if shortcutIsDown && !modifiersMatch(flags, shortcut.modifiers) {
            observe(isDown: false)
        }
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) {
        if isCapturingShortcut {
            handleCapture(type: type, keyCode: keyCode(from: event), flags: event.flags)
            return
        }

        guard !shortcut.isBareFn else {
            if type == .flagsChanged {
                handle(flags: event.flags)
            }
            return
        }

        switch type {
        case .keyDown:
            guard keyCode(from: event) == shortcut.keyCode,
                  modifiersMatch(event.flags, shortcut.modifiers)
            else {
                return
            }
            observe(isDown: true)
        case .keyUp:
            guard keyCode(from: event) == shortcut.keyCode else {
                return
            }
            observe(isDown: false)
        case .flagsChanged:
            handle(flags: event.flags)
        default:
            break
        }
    }

    func setShortcut(_ nextShortcut: MonitoredShortcut) {
        shortcut = nextShortcut
        shortcutIsDown = false
    }

    func startShortcutCapture() {
        isCapturingShortcut = true
        shortcutIsDown = false
        cancelPendingBareFnCapture()
        emit("shortcut_capture_started")
    }

    func cancelShortcutCapture() {
        isCapturingShortcut = false
        cancelPendingBareFnCapture()
        emit("shortcut_capture_cancelled")
    }

    private func startGlobalMonitor() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown, .keyUp], handler: { [weak self] event in
            self?.handle(event: event)
        })
    }

    private func startEventTap() {
        let mask = CGEventMask(
            (1 << CGEventType.flagsChanged.rawValue)
                | (1 << CGEventType.keyDown.rawValue)
                | (1 << CGEventType.keyUp.rawValue)
        )
        let userInfo = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .tailAppendEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: shortcutEventTapCallback,
            userInfo: userInfo
        ) else {
            return
        }

        eventTap = tap
        eventTapRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        if let eventTapRunLoopSource {
            CFRunLoopAddSource(CFRunLoopGetMain(), eventTapRunLoopSource, .commonModes)
        }
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func handle(event: NSEvent) {
        if isCapturingShortcut {
            handleCapture(type: event.type, keyCode: UInt16(event.keyCode), flags: event.modifierFlags)
            return
        }

        if shortcut.isBareFn {
            guard event.type == .flagsChanged else {
                return
            }
            observe(isDown: event.modifierFlags.contains(.function))
            return
        }

        switch event.type {
        case .keyDown:
            guard UInt16(event.keyCode) == shortcut.keyCode,
                  modifiersMatch(event.modifierFlags, shortcut.modifiers)
            else {
                return
            }
            observe(isDown: true)
        case .keyUp:
            guard UInt16(event.keyCode) == shortcut.keyCode else {
                return
            }
            observe(isDown: false)
        case .flagsChanged:
            if shortcutIsDown && !modifiersMatch(event.modifierFlags, shortcut.modifiers) {
                observe(isDown: false)
            }
        default:
            break
        }
    }

    private func handleCapture(type: CGEventType, keyCode: UInt16, flags: CGEventFlags) {
        switch type {
        case .keyDown:
            captureShortcut(keyCode: keyCode, modifiers: shortcutModifiers(from: flags))
        case .flagsChanged:
            handleCapture(flags: flags)
        default:
            break
        }
    }

    private func handleCapture(type: NSEvent.EventType, keyCode: UInt16, flags: NSEvent.ModifierFlags) {
        switch type {
        case .keyDown:
            captureShortcut(keyCode: keyCode, modifiers: shortcutModifiers(from: flags))
        case .flagsChanged:
            handleCapture(flags: flags)
        default:
            break
        }
    }

    private func handleCapture(flags: CGEventFlags) {
        handleCapture(modifiers: shortcutModifiers(from: flags))
    }

    private func handleCapture(flags: NSEvent.ModifierFlags) {
        handleCapture(modifiers: shortcutModifiers(from: flags))
    }

    private func handleCapture(modifiers: ShortcutModifiers) {
        if modifiers.isBareFunction {
            scheduleBareFnCapture()
        } else {
            cancelPendingBareFnCapture()
        }
    }

    private func captureShortcut(keyCode: UInt16, modifiers: ShortcutModifiers) {
        cancelPendingBareFnCapture()
        guard let (code, label) = keyCodeMetadata[keyCode] else {
            emit("shortcut_capture_error", [
                "message": "That key is not supported for global shortcuts.",
            ])
            return
        }
        guard modifiers.hasAny else {
            emit("shortcut_capture_error", [
                "message": "Shortcut must include Cmd, Ctrl, Opt, Shift, or Fn.",
            ])
            return
        }

        finishCapture(
            MonitoredShortcut(
                keyCode: keyCode,
                code: code,
                label: (modifiers.labelParts + [label]).joined(separator: "+"),
                modifiers: modifiers
            )
        )
    }

    private func scheduleBareFnCapture() {
        guard pendingBareFnCapture == nil else {
            return
        }

        let work = DispatchWorkItem { [weak self] in
            self?.finishCapture(.bareFn)
        }
        pendingBareFnCapture = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
    }

    private func finishCapture(_ nextShortcut: MonitoredShortcut) {
        guard isCapturingShortcut else {
            return
        }

        isCapturingShortcut = false
        cancelPendingBareFnCapture()
        emitJSON("shortcut_captured", [
            "shortcut": nextShortcut.payload,
        ])
    }

    private func cancelPendingBareFnCapture() {
        pendingBareFnCapture?.cancel()
        pendingBareFnCapture = nil
    }

    private func observe(isDown nextIsDown: Bool) {
        guard nextIsDown != shortcutIsDown else {
            return
        }

        shortcutIsDown = nextIsDown
        emit(nextIsDown ? "shortcut_key_down" : "shortcut_key_up", [
            "shortcut": shortcut.label,
        ])
    }
}

private func keyCode(from event: CGEvent) -> UInt16 {
    UInt16(event.getIntegerValueField(.keyboardEventKeycode))
}

private func modifiersMatch(_ flags: CGEventFlags, _ modifiers: ShortcutModifiers) -> Bool {
    flags.contains(.maskCommand) == modifiers.command
        && flags.contains(.maskControl) == modifiers.control
        && flags.contains(.maskAlternate) == modifiers.option
        && flags.contains(.maskShift) == modifiers.shift
        && flags.contains(.maskSecondaryFn) == modifiers.function
}

private func modifiersMatch(_ flags: NSEvent.ModifierFlags, _ modifiers: ShortcutModifiers) -> Bool {
    flags.contains(.command) == modifiers.command
        && flags.contains(.control) == modifiers.control
        && flags.contains(.option) == modifiers.option
        && flags.contains(.shift) == modifiers.shift
        && flags.contains(.function) == modifiers.function
}

private func shortcutModifiers(from flags: CGEventFlags) -> ShortcutModifiers {
    ShortcutModifiers(
        command: flags.contains(.maskCommand),
        control: flags.contains(.maskControl),
        option: flags.contains(.maskAlternate),
        shift: flags.contains(.maskShift),
        function: flags.contains(.maskSecondaryFn)
    )
}

private func shortcutModifiers(from flags: NSEvent.ModifierFlags) -> ShortcutModifiers {
    ShortcutModifiers(
        command: flags.contains(.command),
        control: flags.contains(.control),
        option: flags.contains(.option),
        shift: flags.contains(.shift),
        function: flags.contains(.function)
    )
}

private let keyCodeMetadata: [UInt16: (code: String, label: String)] = [
    0x00: ("KeyA", "A"),
    0x01: ("KeyS", "S"),
    0x02: ("KeyD", "D"),
    0x03: ("KeyF", "F"),
    0x04: ("KeyH", "H"),
    0x05: ("KeyG", "G"),
    0x06: ("KeyZ", "Z"),
    0x07: ("KeyX", "X"),
    0x08: ("KeyC", "C"),
    0x09: ("KeyV", "V"),
    0x0b: ("KeyB", "B"),
    0x0c: ("KeyQ", "Q"),
    0x0d: ("KeyW", "W"),
    0x0e: ("KeyE", "E"),
    0x0f: ("KeyR", "R"),
    0x10: ("KeyY", "Y"),
    0x11: ("KeyT", "T"),
    0x12: ("Digit1", "1"),
    0x13: ("Digit2", "2"),
    0x14: ("Digit3", "3"),
    0x15: ("Digit4", "4"),
    0x16: ("Digit6", "6"),
    0x17: ("Digit5", "5"),
    0x18: ("Equal", "="),
    0x19: ("Digit9", "9"),
    0x1a: ("Digit7", "7"),
    0x1b: ("Minus", "-"),
    0x1c: ("Digit8", "8"),
    0x1d: ("Digit0", "0"),
    0x1e: ("BracketRight", "]"),
    0x1f: ("KeyO", "O"),
    0x20: ("KeyU", "U"),
    0x21: ("BracketLeft", "["),
    0x22: ("KeyI", "I"),
    0x23: ("KeyP", "P"),
    0x24: ("Enter", "Return"),
    0x25: ("KeyL", "L"),
    0x26: ("KeyJ", "J"),
    0x27: ("Quote", "'"),
    0x28: ("KeyK", "K"),
    0x29: ("Semicolon", ";"),
    0x2a: ("Backslash", "\\"),
    0x2b: ("Comma", ","),
    0x2c: ("Slash", "/"),
    0x2d: ("KeyN", "N"),
    0x2e: ("KeyM", "M"),
    0x2f: ("Period", "."),
    0x30: ("Tab", "Tab"),
    0x31: ("Space", "Space"),
    0x32: ("Backquote", "`"),
    0x33: ("Backspace", "Delete"),
    0x35: ("Escape", "Esc"),
    0x7a: ("F1", "F1"),
    0x7b: ("ArrowLeft", "Left"),
    0x7c: ("ArrowRight", "Right"),
    0x7d: ("ArrowDown", "Down"),
    0x7e: ("ArrowUp", "Up"),
]

private let shortcutEventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }

    let monitor = Unmanaged<ShortcutKeyMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        monitor.enableEventTap()
        return Unmanaged.passUnretained(event)
    }

    monitor.handle(type: type, event: event)

    return Unmanaged.passUnretained(event)
}

final class FocusTargetController {
    static let shared = FocusTargetController()

    private var lastExternalApp: NSRunningApplication?
    private let ignoredBundleIdentifiers: Set<String> = [
        "network.opensoftware.os-notetaker",
        "network.opensoftware.os-notetaker.dictation-helper",
    ]

    private init() {}

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(applicationDidActivate(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )

        if let frontmostApplication = NSWorkspace.shared.frontmostApplication {
            rememberIfExternal(frontmostApplication)
        }
    }

    func activateLastExternalApp() -> Bool {
        guard let app = lastExternalApp, !app.isTerminated else {
            return false
        }
        return app.activate(options: [])
    }

    func targetDescription() -> String {
        guard let app = lastExternalApp, !app.isTerminated else {
            return "unknown"
        }
        return app.localizedName ?? app.bundleIdentifier ?? "\(app.processIdentifier)"
    }

    @objc private func applicationDidActivate(_ notification: Notification) {
        guard
            let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        else {
            return
        }
        rememberIfExternal(app)
    }

    private func rememberIfExternal(_ app: NSRunningApplication) {
        let bundleIdentifier = app.bundleIdentifier ?? ""
        let appName = app.localizedName ?? ""
        guard !ignoredBundleIdentifiers.contains(bundleIdentifier) else {
            return
        }
        guard !appName.localizedCaseInsensitiveContains("OS Scribe") else {
            return
        }
        lastExternalApp = app
        emit("focus_target", ["app": targetDescription()])
    }
}

enum SelectedDeviceRecorderError: LocalizedError {
    case cannotAddInput
    case cannotAddOutput
    case cannotCreateAudioInput
    case cannotStartWriter
    case cannotAppendAudio

    var errorDescription: String? {
        switch self {
        case .cannotAddInput:
            return "Could not use the selected microphone as a recording input."
        case .cannotAddOutput:
            return "Could not create audio output for the selected microphone."
        case .cannotCreateAudioInput:
            return "Could not create an audio track for the selected microphone."
        case .cannotStartWriter:
            return "Could not start writing audio from the selected microphone."
        case .cannotAppendAudio:
            return "Could not write audio from the selected microphone."
        }
    }
}

final class SelectedDeviceRecorder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "network.opensoftware.os-notetaker.dictation-recorder")
    private let writer: AVAssetWriter
    private let writerInput: AVAssetWriterInput
    private var didStartWriting = false
    private var isStopping = false
    private var finishHandler: ((Error?) -> Void)?
    private let failureHandler: (Error) -> Void
    private let levelHandler: (Float) -> Void

    init(
        device: AVCaptureDevice,
        outputURL: URL,
        onLevel: @escaping (Float) -> Void,
        onFailure: @escaping (Error) -> Void
    ) throws {
        writer = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
        writerInput = AVAssetWriterInput(
            mediaType: .audio,
            outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 128_000,
            ]
        )
        writerInput.expectsMediaDataInRealTime = true
        failureHandler = onFailure
        levelHandler = onLevel

        super.init()

        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw SelectedDeviceRecorderError.cannotAddInput
        }
        session.addInput(input)

        guard session.canAddOutput(output) else {
            throw SelectedDeviceRecorderError.cannotAddOutput
        }
        output.setSampleBufferDelegate(self, queue: queue)
        session.addOutput(output)

        guard writer.canAdd(writerInput) else {
            throw SelectedDeviceRecorderError.cannotCreateAudioInput
        }
        writer.add(writerInput)
    }

    func start() {
        session.startRunning()
    }

    func stop(_ completion: @escaping (Error?) -> Void) {
        queue.async { [weak self] in
            guard let self else {
                completion(nil)
                return
            }
            guard !isStopping else {
                completion(nil)
                return
            }
            isStopping = true
            finishHandler = completion
            session.stopRunning()
            output.setSampleBufferDelegate(nil, queue: nil)

            guard didStartWriting else {
                writer.cancelWriting()
                completion(DictationError.missingRecording)
                return
            }

            writerInput.markAsFinished()
            writer.finishWriting { [weak self] in
                guard let self else {
                    completion(nil)
                    return
                }
                let error = writer.status == .failed ? writer.error : nil
                finishHandler = nil
                completion(error)
            }
        }
    }

    func cancel() {
        queue.sync {
            isStopping = true
            session.stopRunning()
            output.setSampleBufferDelegate(nil, queue: nil)
            writer.cancelWriting()
        }
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard !isStopping else {
            return
        }
        if !didStartWriting {
            guard writer.startWriting() else {
                fail(writer.error ?? SelectedDeviceRecorderError.cannotStartWriter)
                return
            }
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
            didStartWriting = true
        }

        emitLevel(from: sampleBuffer)
        guard writerInput.isReadyForMoreMediaData, writerInput.append(sampleBuffer) else {
            fail(writer.error ?? SelectedDeviceRecorderError.cannotAppendAudio)
            return
        }
    }

    private func emitLevel(from sampleBuffer: CMSampleBuffer) {
        guard
            let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer)
        else {
            return
        }
        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &length,
            dataPointerOut: &dataPointer
        ) == noErr, let dataPointer, length > 1 else {
            return
        }
        let sampleCount = length / MemoryLayout<Int16>.size
        guard sampleCount > 0 else {
            return
        }
        let samples = dataPointer.withMemoryRebound(to: Int16.self, capacity: sampleCount) { pointer in
            UnsafeBufferPointer(start: pointer, count: sampleCount)
        }
        var peak: Float = 0
        for sample in samples {
            peak = max(peak, abs(Float(sample) / Float(Int16.max)))
        }
        levelHandler(peak)
    }

    private func fail(_ error: Error) {
        guard !isStopping else {
            return
        }
        isStopping = true
        session.stopRunning()
        output.setSampleBufferDelegate(nil, queue: nil)
        writer.cancelWriting()
        finishHandler = nil
        failureHandler(error)
    }
}

enum DictationError: LocalizedError {
    case missingRecording
    case missingTranscript

    var errorDescription: String? {
        switch self {
        case .missingRecording:
            return "No recorded audio was available to transcribe."
        case .missingTranscript:
            return "No transcript text was available to paste."
        }
    }

    var code: String {
        switch self {
        case .missingRecording:
            return "missing_recording"
        case .missingTranscript:
            return "empty_transcript"
        }
    }
}

final class DictationController {
    private var audioRecorder: AVAudioRecorder?
    private var selectedDeviceRecorder: SelectedDeviceRecorder?
    private var recordingURL: URL?
    private var meteringTimer: DispatchSourceTimer?
    private var preferredMicrophoneID: String?
    private var preferredMicrophoneName: String?
    private var isListening = false
    private var isFinalizing = false
    private var maxObservedAudioLevel: Float = 0

    var listening: Bool {
        isListening || isFinalizing
    }

    func emitDiagnostics() {
        emit("dictation_diagnostics", [
            "bundleIdentifier": helperBundleIdentifier(),
            "microphone": microphoneStatus(),
            "accessibility": boolStatus(AXIsProcessTrusted()),
        ])
    }

    func emitMicrophones() {
        emitMicrophoneDevices(selectedID: preferredMicrophoneID)
    }

    func setMicrophone(id: String?, name: String?) {
        preferredMicrophoneID = id?.isEmpty == true ? nil : id
        preferredMicrophoneName = name?.isEmpty == true ? nil : name
        emit("microphone_selected", [
            "id": preferredMicrophoneID ?? "",
            "name": preferredMicrophoneName ?? "Auto-detect",
        ])
        emitMicrophones()
    }

    func start() {
        guard !listening else {
            emit("error", ["code": "already_listening", "message": "Dictation is already listening."])
            return
        }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] microphoneAllowed in
            guard microphoneAllowed else {
                emit("error", ["code": "microphone_permission_missing", "message": "Microphone permission is required."])
                emit("permission_status", permissionPayload())
                return
            }
            self?.startRecording()
        }
    }

    func stop() {
        guard isListening else {
            emit("error", ["code": "not_listening", "message": "Dictation is not listening."])
            return
        }

        isListening = false
        isFinalizing = true
        stopMetering()
        RecordingCuePlayer.play(.stop)
        emit("finalizing_transcript")

        if let selectedDeviceRecorder {
            selectedDeviceRecorder.stop { [weak self] error in
                runOnMain {
                    self?.selectedDeviceRecorder = nil
                    if let error {
                        self?.fail(error)
                        return
                    }
                    self?.emitRecordingReady()
                }
            }
            return
        }

        audioRecorder?.stop()
        emitRecordingReady()
    }

    func paste(text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            fail(DictationError.missingTranscript)
            return
        }

        emit("final_transcript", ["text": text])
        PasteboardInserter.paste(text)
        resetRecordingState()
    }

    func discard() {
        resetRecordingState()
    }

    func shutdown() {
        resetRecordingState()
        emit("shutdown_ack")
        exit(0)
    }

    private func startRecording() {
        resetRecordingState()

        let nextRecordingURL = temporaryRecordingURL()
        if let selectedDevice = microphoneDevice(for: preferredMicrophoneID) {
            startSelectedDeviceRecording(device: selectedDevice, url: nextRecordingURL)
            return
        }

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]

        do {
            let recorder = try AVAudioRecorder(url: nextRecordingURL, settings: settings)
            recorder.isMeteringEnabled = true
            recorder.prepareToRecord()

            guard recorder.record() else {
                emit("error", ["code": "audio_start_failed", "message": "Could not start microphone recording."])
                resetRecordingState()
                return
            }

            audioRecorder = recorder
            recordingURL = nextRecordingURL
            isListening = true
            startMetering()
            RecordingCuePlayer.play(.start)
            emit("listening_started", [
                "recognitionMode": "venice_recording",
                "microphone": preferredMicrophoneName ?? "Auto-detect",
            ])
        } catch {
            resetRecordingState()
            emit("error", ["code": "audio_start_failed", "message": error.localizedDescription])
        }
    }

    private func startSelectedDeviceRecording(device: AVCaptureDevice, url: URL) {
        do {
            let recorder = try SelectedDeviceRecorder(
                device: device,
                outputURL: url,
                onLevel: { [weak self] level in
                    runOnMain {
                        self?.observeAudioLevel(level)
                    }
                },
                onFailure: { [weak self] error in
                    runOnMain {
                        self?.failSelectedDeviceRecording(error)
                    }
                }
            )
            selectedDeviceRecorder = recorder
            recordingURL = url
            isListening = true
            recorder.start()
            RecordingCuePlayer.play(.start)
            emit("listening_started", [
                "recognitionMode": "venice_recording",
                "microphone": device.localizedName,
            ])
        } catch {
            resetRecordingState()
            emit("error", ["code": "audio_start_failed", "message": error.localizedDescription])
        }
    }

    private func failSelectedDeviceRecording(_ error: Error) {
        guard selectedDeviceRecorder != nil else {
            return
        }
        selectedDeviceRecorder = nil
        fail(error)
    }

    private func emitRecordingReady() {
        guard let recordingURL else {
            fail(DictationError.missingRecording)
            return
        }

        let fileSize = (try? FileManager.default.attributesOfItem(atPath: recordingURL.path)[.size] as? Int64) ?? 0
        guard fileSize > 0 else {
            fail(DictationError.missingRecording)
            return
        }

        emit("recording_ready", [
            "path": recordingURL.path,
            "observedAudioLevel": String(format: "%.4f", maxObservedAudioLevel),
        ])
    }

    private func temporaryRecordingURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("os-scribe-dictation-\(UUID().uuidString)")
            .appendingPathExtension("m4a")
    }

    private func startMetering() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            self?.emitAudioRecorderLevel()
        }
        meteringTimer = timer
        timer.resume()
    }

    private func emitAudioRecorderLevel() {
        guard let audioRecorder, audioRecorder.isRecording else {
            return
        }

        audioRecorder.updateMeters()
        let averagePower = max(audioRecorder.averagePower(forChannel: 0), -80)
        let level = Float(pow(10.0, Double(averagePower) / 20.0))
        observeAudioLevel(level)
    }

    private func observeAudioLevel(_ level: Float) {
        maxObservedAudioLevel = max(maxObservedAudioLevel, level)
        emit("audio_level", ["level": String(format: "%.4f", level)])
    }

    private func stopMetering() {
        meteringTimer?.cancel()
        meteringTimer = nil
    }

    private func fail(_ error: Error) {
        let code = (error as? DictationError)?.code ?? "dictation_failed"
        emit("error", [
            "code": code,
            "message": error.localizedDescription,
        ])
        resetRecordingState()
    }

    private func cleanupRecordingFile() {
        guard let recordingURL else {
            return
        }
        try? FileManager.default.removeItem(at: recordingURL)
    }

    private func resetRecordingState() {
        isListening = false
        isFinalizing = false
        maxObservedAudioLevel = 0
        stopMetering()
        audioRecorder?.stop()
        audioRecorder = nil
        selectedDeviceRecorder?.cancel()
        selectedDeviceRecorder = nil
        cleanupRecordingFile()
        recordingURL = nil
    }
}

struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]
}

enum PasteboardInserter {
    static func paste(_ text: String) {
        let pasteboard = NSPasteboard.general
        let snapshot = capture(pasteboard)

        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            emit("error", ["code": "pasteboard_write_failed", "message": "Could not write transcript to the clipboard."])
            restore(snapshot, to: pasteboard)
            return
        }

        let targetActivated = FocusTargetController.shared.activateLastExternalApp()
        emit("paste_target", [
            "app": FocusTargetController.shared.targetDescription(),
            "activated": boolStatus(targetActivated),
        ])

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            postPasteShortcut()
            emit("paste_completed")
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + 0.7) {
            if pasteboard.string(forType: .string) == text {
                restore(snapshot, to: pasteboard)
            }
        }
    }

    private static func capture(_ pasteboard: NSPasteboard) -> PasteboardSnapshot {
        let items = pasteboard.pasteboardItems?.map { item in
            item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { result, type in
                result[type] = item.data(forType: type)
            }
        } ?? []
        return PasteboardSnapshot(items: items)
    }

    private static func restore(_ snapshot: PasteboardSnapshot, to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        guard !snapshot.items.isEmpty else {
            return
        }
        let restoredItems = snapshot.items.map { storedItem in
            let item = NSPasteboardItem()
            for (type, data) in storedItem {
                item.setData(data, forType: type)
            }
            return item
        }
        pasteboard.writeObjects(restoredItems)
    }

    private static func postPasteShortcut() {
        let source = CGEventSource(stateID: .hidSystemState)
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)

        keyDown?.flags = .maskCommand
        keyUp?.flags = .maskCommand
        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
    }
}

let dictation = DictationController()

func handleCommandLine(_ line: String) {
    guard let data = line.data(using: .utf8) else {
        emit("error", ["code": "invalid_input", "message": "Command was not valid UTF-8."])
        return
    }

    let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let type = command?["type"] as? String

    switch type {
    case "ping":
        emit("pong")
        runOnMain {
            dictation.emitDiagnostics()
        }
    case "get_permission_status":
        emit("permission_status", permissionPayload())
    case "list_microphones":
        runOnMain {
            dictation.emitMicrophones()
        }
    case "start_listening":
        runOnMain {
            dictation.start()
        }
    case "stop_and_paste":
        runOnMain {
            dictation.stop()
        }
    case "set_microphone":
        let id = command?["id"] as? String
        let name = command?["name"] as? String
        runOnMain {
            dictation.setMicrophone(id: id, name: name)
        }
    case "set_shortcut":
        guard
            let payload = command?["shortcut"] as? [String: Any],
            let shortcut = MonitoredShortcut(payload: payload)
        else {
            emit("error", ["code": "invalid_shortcut", "message": "Shortcut configuration was invalid."])
            return
        }
        runOnMain {
            ShortcutKeyMonitor.shared.setShortcut(shortcut)
        }
    case "start_shortcut_capture":
        runOnMain {
            ShortcutKeyMonitor.shared.startShortcutCapture()
        }
    case "cancel_shortcut_capture":
        runOnMain {
            ShortcutKeyMonitor.shared.cancelShortcutCapture()
        }
    case "toggle_listening":
        let shortcut = command?["shortcut"] as? String ?? "hotkey"
        runOnMain {
            if dictation.listening {
                emit("hotkey_trigger", ["action": "stop", "shortcut": shortcut])
                dictation.stop()
            } else {
                emit("hotkey_trigger", ["action": "start", "shortcut": shortcut])
                dictation.start()
            }
        }
    case "paste_text":
        let text = command?["text"] as? String ?? ""
        runOnMain {
            dictation.paste(text: text)
        }
    case "discard_recording":
        runOnMain {
            dictation.discard()
        }
    case "shutdown":
        runOnMain {
            dictation.shutdown()
        }
    default:
        emit("error", ["code": "unknown_command", "message": "Unknown helper command."])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

emit("ready")
ShortcutKeyMonitor.shared.start()
FocusTargetController.shared.start()
dictation.emitDiagnostics()

Thread.detachNewThread {
    while let line = readLine() {
        handleCommandLine(line)
    }
}

app.run()
