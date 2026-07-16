import Foundation
import AVFoundation
import AppKit
import Carbon
import CoreMedia
import CoreGraphics
import SoundAnalysis

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

func requestMicrophonePermission() {
    AVCaptureDevice.requestAccess(for: .audio) { _ in
        emit("permission_status", permissionPayload())
    }
}

func requestAccessibilityPermission() {
    // Prompting variant of AXIsProcessTrusted(): registers THIS helper in the
    // Accessibility list and surfaces the system "control this computer"
    // dialog. The silent AXIsProcessTrusted() used elsewhere never adds the
    // helper to the list, so a fresh install would otherwise have nothing to
    // toggle — the synthetic Cmd+V paste needs the helper trusted.
    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let options = [promptKey: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    emit("permission_status", permissionPayload())
}

/// Pure decision for the accessibility-trust poller: re-emit only when the
/// trust bit actually flips. `previous` is nil until the first observation
/// (seeded at start without emitting, since the launch-time diagnostics already
/// report the initial state), so the first real change always emits.
func accessibilityTrustChanged(previous: Bool?, current: Bool) -> Bool {
    previous != current
}

/// Surfaces Accessibility-trust changes proactively.
///
/// The paste path already fails loud when trust is missing at paste time, but a
/// user whose grant was revoked mid-session (commonly after an app update
/// changes the helper's signature) would otherwise only discover it by losing a
/// dictation — during dictation they are focused in another app, so nothing
/// re-checks. This polls `AXIsProcessTrusted()` on a low-frequency timer plus on
/// wake and app activation, and re-emits `permission_status` the moment the bit
/// changes so the existing in-app banner appears (or clears) without waiting for
/// a failed paste.
final class AccessibilityTrustMonitor {
    static let shared = AccessibilityTrustMonitor()

    // 30s is well under a human's patience for "why won't paste work" while
    // costing nothing: AXIsProcessTrusted() is a cheap local check and we emit
    // only on change, so a stable grant produces no events.
    private let pollInterval: TimeInterval = 30
    private var lastTrusted: Bool?
    private var timer: DispatchSourceTimer?

    private init() {}

    func start() {
        // Seed without emitting: the launch-time get_permission_status /
        // emitDiagnostics already reported the current state, so a second
        // identical event here would just be noise.
        lastTrusted = AXIsProcessTrusted()

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        timer.schedule(deadline: .now() + pollInterval, repeating: pollInterval)
        timer.setEventHandler { [weak self] in
            self?.poll()
        }
        self.timer = timer
        timer.resume()

        // Wake (timers don't advance during sleep) and system-wide app
        // activation each warrant an immediate re-check so permission changes
        // are not gated on the next timer tick.
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(
            self,
            selector: #selector(handleWorkspaceEvent(_:)),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleWorkspaceEvent(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
    }

    @objc private func handleWorkspaceEvent(_: Notification) {
        poll()
    }

    private func poll() {
        let trusted = AXIsProcessTrusted()
        guard accessibilityTrustChanged(previous: lastTrusted, current: trusted) else {
            return
        }
        lastTrusted = trusted
        emit("permission_status", permissionPayload())
    }
}

func helperBundleIdentifier() -> String {
    Bundle.main.bundleIdentifier ?? "unknown"
}

enum RecordingCueSound: String {
    case start = "record-start"
    case stop = "record-end"
}

private final class RecordingCueCompletion: NSObject, NSSoundDelegate {
    private var completion: (() -> Void)?

    init(completion: @escaping () -> Void) {
        self.completion = completion
    }

    func sound(_ sound: NSSound, didFinishPlaying flag: Bool) {
        finish()
    }

    func finish() {
        let completion = completion
        self.completion = nil
        completion?()
    }

    func cancel() {
        completion = nil
    }
}

enum RecordingCuePlayer {
    private static var sounds: [RecordingCueSound: NSSound] = [:]
    private static var completions: [RecordingCueSound: RecordingCueCompletion] = [:]

    static func play(_ cue: RecordingCueSound) {
        let sound = sounds[cue] ?? load(cue)
        guard let sound else {
            return
        }
        sound.stop()
        sound.currentTime = 0
        sound.play()
    }

    static func play(_ cue: RecordingCueSound, completion: @escaping () -> Void) {
        let sound = sounds[cue] ?? load(cue)
        guard let sound else {
            completion()
            return
        }

        cancel(cue)
        let delegate = RecordingCueCompletion {
            sound.delegate = nil
            completions.removeValue(forKey: cue)
            completion()
        }
        completions[cue] = delegate
        sound.delegate = delegate
        sound.currentTime = 0
        guard sound.play() else {
            delegate.finish()
            return
        }

        // NSSound normally calls its delegate when playback finishes. Keep a
        // bounded fallback so a broken output route cannot wedge dictation in
        // the pending state forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + max(1, sound.duration + 0.5)) {
            guard completions[cue] === delegate else {
                return
            }
            sound.delegate = nil
            sound.stop()
            delegate.finish()
        }
    }

    static func cancel(_ cue: RecordingCueSound) {
        completions.removeValue(forKey: cue)?.cancel()
        guard let sound = sounds[cue] else {
            return
        }
        sound.delegate = nil
        sound.stop()
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

private final class SpeechActivityObserver: NSObject, SNResultsObserving {
    private(set) var speechResultCount = 0
    private(set) var maxSpeechConfidence = 0.0
    private(set) var failed = false

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let classification = result as? SNClassificationResult else {
            return
        }
        guard let speech = classification.classification(forIdentifier: "speech") else {
            return
        }
        speechResultCount += 1
        let confidence = speech.confidence
        maxSpeechConfidence = max(maxSpeechConfidence, confidence)
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        failed = true
    }

    func requestDidComplete(_ request: SNRequest) {}
}

let speechAnalysisWindowDurationSeconds: Double = 0.5

private final class SpeechConfidenceAnalysis {
    private static let timeout: TimeInterval = 5

    private let analyzer: SNAudioFileAnalyzer
    private let observer = SpeechActivityObserver()
    private var completion: ((Double?) -> Void)?

    init(url: URL, completion: @escaping (Double?) -> Void) throws {
        self.completion = completion
        let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        request.windowDuration = CMTime(
            seconds: speechAnalysisWindowDurationSeconds,
            preferredTimescale: 16_000
        )
        request.overlapFactor = 0.5
        analyzer = try SNAudioFileAnalyzer(url: url)
        try analyzer.add(request, withObserver: observer)
    }

    func start() {
        analyzer.analyze { success in
            let confidence = success && !self.observer.failed && self.observer.speechResultCount > 0
                ? self.observer.maxSpeechConfidence
                : nil
            runOnMain {
                self.finish(confidence)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout) {
            self.finish(nil)
        }
    }

    private func finish(_ confidence: Double?) {
        guard let completion else {
            return
        }
        self.completion = nil
        analyzer.cancelAnalysis()
        completion(confidence)
    }
}

func analyzeSpeechConfidence(at url: URL, completion: @escaping (Double?) -> Void) {
    do {
        let analysis = try SpeechConfidenceAnalysis(url: url, completion: completion)
        analysis.start()
    } catch {
        completion(nil)
    }
}

func audioDurationSeconds(at url: URL) -> Double? {
    guard
        let file = try? AVAudioFile(forReading: url),
        file.fileFormat.sampleRate > 0
    else {
        return nil
    }
    return Double(file.length) / file.fileFormat.sampleRate
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

func defaultMicrophoneDevice() -> [String: String]? {
    guard let device = AVCaptureDevice.default(for: .audio) ?? audioInputDevices().first else {
        return nil
    }
    return [
        "id": device.uniqueID,
        "name": device.localizedName,
    ]
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
    var payload: [String: Any] = [
        "devices": microphoneDevices(),
        "selectedID": selectedID ?? "",
    ]
    if let defaultDevice = defaultMicrophoneDevice() {
        payload["defaultDevice"] = defaultDevice
    }
    emitJSON("microphone_devices", payload)
}

func runOnMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
        work()
    } else {
        DispatchQueue.main.async(execute: work)
    }
}

struct ShortcutModifiers: Equatable, Hashable {
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

    var modifierCount: Int {
        [command, control, option, shift, function].filter { $0 }.count
    }

    var isSupportedModifierOnlyShortcut: Bool {
        isBareFunction || modifierCount >= 2
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
    let pressCount: Int

    static let defaultPushToTalk = MonitoredShortcut(
        keyCode: 0x02,
        code: "KeyD",
        label: "Ctrl+Opt+D",
        modifiers: ShortcutModifiers(control: true, option: true),
        pressCount: 1
    )

    init(keyCode: UInt16, code: String, label: String, modifiers: ShortcutModifiers, pressCount: Int = 1) {
        self.keyCode = keyCode
        self.code = code
        self.label = Self.displayLabel(label: label, pressCount: pressCount)
        self.modifiers = modifiers
        self.pressCount = pressCount == 2 ? 2 : 1
    }

    init?(payload: [String: Any]) {
        let code = payload["code"] as? String ?? ""
        let label = payload["label"] as? String ?? ""
        let modifiersPayload = payload["modifiers"] as? [String: Any] ?? [:]
        let rawPressCount = payload["pressCount"] as? Int ?? (payload["pressCount"] as? NSNumber)?.intValue ?? 1
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
        self.pressCount = rawPressCount == 2 ? 2 : 1
        self.label = Self.displayLabel(label: label, pressCount: self.pressCount)
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

    var isModifierOnly: Bool {
        isBareFn || (keyCode == 0 && code.caseInsensitiveCompare("Modifiers") == .orderedSame)
    }

    var payload: [String: Any] {
        [
            "keyCode": Int(keyCode),
            "code": code,
            "label": label,
            "pressCount": pressCount,
            "modifiers": modifiers.payload,
        ]
    }

    private static func displayLabel(label: String, pressCount: Int) -> String {
        guard pressCount == 2 else {
            return label
        }
        let parts = label.split(separator: "+").map(String.init)
        if parts.count.isMultiple(of: 2) && !parts.isEmpty {
            let half = parts.count / 2
            if Array(parts[0..<half]) == Array(parts[half..<parts.count]) {
                return label
            }
        }
        return "\(label)+\(label)"
    }
}

enum ShortcutKind: String {
    case pushToTalk = "push_to_talk"
    case toggle
}

struct ShortcutIdentity: Equatable, Hashable {
    let keyCode: UInt16
    let code: String
    let modifiers: ShortcutModifiers

    init(_ shortcut: MonitoredShortcut) {
        keyCode = shortcut.keyCode
        code = shortcut.code
        modifiers = shortcut.modifiers
    }
}

final class ShortcutKeyMonitor {
    static let shared = ShortcutKeyMonitor()

    private static let holdThreshold: TimeInterval = 0.16
    private static let doublePressWindow: TimeInterval = 0.34

    private var globalMonitor: Any?
    private var carbonHandlerRef: EventHandlerRef?
    /// Registered Carbon hot keys by their EventHotKeyID.id. Carbon's
    /// RegisterEventHotKey delivers pressed/released edges for key chords
    /// with NO permission prompt, unlike keyDown monitors and event taps,
    /// which both summon the Input Monitoring ("keylogger") dialog.
    private var carbonHotKeys: [UInt32: (identity: ShortcutIdentity, ref: EventHotKeyRef)] = [:]
    private var nextCarbonHotKeyId: UInt32 = 1
    private var shortcuts: [ShortcutKind: MonitoredShortcut] = [
        .pushToTalk: .defaultPushToTalk,
        .toggle: MonitoredShortcut(
            keyCode: 0x11,
            code: "KeyT",
            label: "Ctrl+Opt+T",
            modifiers: ShortcutModifiers(control: true, option: true),
            pressCount: 1
        ),
    ]
    private var activeIdentity: ShortcutIdentity?
    private var activePushIdentity: ShortcutIdentity?
    private var pendingPushWork: DispatchWorkItem?
    private var pendingPushIdentity: ShortcutIdentity?
    private var pendingPushShortcut: MonitoredShortcut?
    private var lastTapIdentity: ShortcutIdentity?
    private var lastTapAt: Date?
    /// A modifier-only shortcut whose own key went down while a foreign
    /// modifier was still held (fn pressed before Cmd from a cmd-tab fully
    /// cleared). The press edge couldn't fire then — the flags weren't an
    /// exact match — so it fires the moment the foreign modifiers clear.
    /// Set only on the shortcut's own key-down with extras present, which is
    /// what keeps the cmd-tab phantom dead: there fn's down already matched
    /// (and was consumed) before the interruption, so nothing is pending.
    private var pendingOverlapIdentity: ShortcutIdentity?
    private var isCapturingShortcut = false
    private var capturePressCount = 1
    private var pendingModifierOnlyCapture: DispatchWorkItem?
    private var pendingModifierOnlyModifiers: ShortcutModifiers?

    private init() {}

    func start() {
        guard globalMonitor == nil else {
            return
        }

        startGlobalMonitor()
        installCarbonHotKeyHandler()
        registerCarbonHotKeys()

        if globalMonitor == nil {
            emit("fn_monitor_unavailable", [
                "message": "Could not monitor global shortcut key events.",
            ])
        }
    }

    /// A flagsChanged event names the key that changed (`keyCode`), and the
    /// matching below is gated on it. Matching on the flag bits alone caused
    /// phantom fn edges: releasing Cmd while fn was still held made the flags
    /// read exactly {fn} again, which looked like a fresh fn press — so
    /// cmd-tabbing away from a dictation could re-trigger push-to-talk, and a
    /// quick Cmd press+release while fn was down counted as a double-press
    /// and fired the fn+fn toggle. Arrow/Home/End/PageUp/PageDown events set
    /// the fn bit too, faking the same edges. Only the shortcut's own
    /// modifier keys may create a press; foreign keys can still *end* one
    /// (adding Cmd mid-push releases it), but such an interruption is not a
    /// physical release and must not arm the double-press detector.
    ///
    /// One foreign-key exception, tracked by `pendingOverlapIdentity`: a
    /// press whose own key went down while a foreign modifier was still held
    /// (fn hit right after a cmd-tab, or while Shift from a capital was
    /// settling) never matched exactly, so the foreign key's *release* is the
    /// first moment the chord physically holds — fire it then, or the press
    /// is swallowed for as long as fn stays down.
    fileprivate func handleFlagsChanged(_ current: ShortcutModifiers, changedKeyCode: UInt16) {
        if let identity = activeIdentity, identity.modifiers != current {
            handlePhysicalUp(
                identity: identity,
                isPhysicalRelease: modifierKeyCodes(for: identity.modifiers).contains(changedKeyCode)
            )
        }

        updatePendingOverlap(current, changedKeyCode: changedKeyCode)

        guard let identity = matchingModifierOnlyIdentity(current),
              modifierKeyCodes(for: identity.modifiers).contains(changedKeyCode)
                  || pendingOverlapIdentity == identity
        else {
            return
        }

        pendingOverlapIdentity = nil
        handlePhysicalDown(identity: identity)
    }

    /// Arms the overlap recovery when a modifier-only shortcut's own key goes
    /// down under extra foreign modifiers, and disarms it when that key comes
    /// back up before the chord ever held. Foreign keys never arm it — their
    /// releases only consume it via the match in handleFlagsChanged.
    private func updatePendingOverlap(_ current: ShortcutModifiers, changedKeyCode: UInt16) {
        guard let keyIsDown = modifierBitIsDown(for: changedKeyCode, in: current) else {
            return
        }
        if keyIsDown {
            for shortcut in shortcuts.values where shortcut.isModifierOnly {
                guard modifierKeyCodes(for: shortcut.modifiers).contains(changedKeyCode),
                      shortcut.modifiers != current,
                      modifiersContain(current, shortcut.modifiers)
                else {
                    continue
                }
                pendingOverlapIdentity = ShortcutIdentity(shortcut)
                return
            }
        } else if let pending = pendingOverlapIdentity,
                  modifierKeyCodes(for: pending.modifiers).contains(changedKeyCode),
                  !modifiersContain(current, pending.modifiers) {
            pendingOverlapIdentity = nil
        }
    }

    /// Whether the modifier a flagsChanged keyCode belongs to is set after
    /// the event — i.e. whether that key just went down (or, with paired
    /// left/right keys, its sibling is still holding the bit). Nil for
    /// non-modifier keyCodes.
    private func modifierBitIsDown(for keyCode: UInt16, in current: ShortcutModifiers) -> Bool? {
        switch keyCode {
        case 0x36, 0x37: return current.command
        case 0x38, 0x3C: return current.shift
        case 0x3A, 0x3D: return current.option
        case 0x3B, 0x3E: return current.control
        case 0x3F: return current.function
        default: return nil
        }
    }

    private func modifiersContain(_ current: ShortcutModifiers, _ subset: ShortcutModifiers) -> Bool {
        (!subset.command || current.command)
            && (!subset.control || current.control)
            && (!subset.option || current.option)
            && (!subset.shift || current.shift)
            && (!subset.function || current.function)
    }

    func setShortcut(_ nextShortcut: MonitoredShortcut, kind: ShortcutKind) {
        shortcuts[kind] = nextShortcut
        registerCarbonHotKeys()
        cancelPendingPush()
        activeIdentity = nil
        activePushIdentity = nil
        lastTapIdentity = nil
        lastTapAt = nil
        pendingOverlapIdentity = nil
    }

    func startShortcutCapture(pressCount: Int = 1) {
        isCapturingShortcut = true
        capturePressCount = 1
        cancelPendingPush()
        activeIdentity = nil
        pendingOverlapIdentity = nil
        cancelPendingModifierOnlyCapture()
        // A registered hot key consumes its chord system-wide, so the rebind
        // UI's DOM would never see the user's current shortcut. Suspend them
        // for the duration of the capture.
        unregisterCarbonHotKeys()
        emit("shortcut_capture_started")
    }

    func cancelShortcutCapture() {
        isCapturingShortcut = false
        cancelPendingModifierOnlyCapture()
        registerCarbonHotKeys()
        emit("shortcut_capture_cancelled")
    }

    /// flagsChanged ONLY, deliberately: modifier traffic is visible to a
    /// global monitor under the Accessibility permission June already holds,
    /// while .keyDown/.keyUp in this mask is what made macOS demand Input
    /// Monitoring on first launch. Key chords are watched by Carbon hot keys
    /// instead (registerCarbonHotKeys), which need no permission at all.
    private func startGlobalMonitor() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged], handler: { [weak self] event in
            self?.handle(event: event)
        })
    }

    private func installCarbonHotKeyHandler() {
        guard carbonHandlerRef == nil else {
            return
        }
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let userInfo = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetEventDispatcherTarget(), carbonHotKeyCallback, 2, &specs, userInfo, &carbonHandlerRef)
    }

    private func unregisterCarbonHotKeys() {
        for entry in carbonHotKeys.values {
            UnregisterEventHotKey(entry.ref)
        }
        carbonHotKeys.removeAll()
    }

    private func registerCarbonHotKeys() {
        unregisterCarbonHotKeys()

        for shortcut in shortcuts.values {
            guard !shortcut.isModifierOnly else {
                continue // flagsChanged path handles modifier-only chords.
            }
            guard !shortcut.modifiers.function else {
                // Carbon has no fn modifier bit, and nothing permission-free
                // can watch fn+key chords. Say so instead of silently dying.
                emit("fn_monitor_unavailable", [
                    "message": "The shortcut \(shortcut.label) combines Fn with another key, which is no longer supported. Pick a different shortcut in Settings.",
                ])
                continue
            }
            var carbonModifiers: UInt32 = 0
            if shortcut.modifiers.command { carbonModifiers |= UInt32(cmdKey) }
            if shortcut.modifiers.control { carbonModifiers |= UInt32(controlKey) }
            if shortcut.modifiers.option { carbonModifiers |= UInt32(optionKey) }
            if shortcut.modifiers.shift { carbonModifiers |= UInt32(shiftKey) }

            var ref: EventHotKeyRef?
            let hotKeyId = EventHotKeyID(signature: OSType(0x4A_44_48_4B), id: nextCarbonHotKeyId) // "JDHK"
            let status = RegisterEventHotKey(
                UInt32(shortcut.keyCode),
                carbonModifiers,
                hotKeyId,
                GetEventDispatcherTarget(),
                0,
                &ref
            )
            if status == noErr, let ref {
                carbonHotKeys[nextCarbonHotKeyId] = (ShortcutIdentity(shortcut), ref)
            } else {
                emit("fn_monitor_unavailable", [
                    "message": "Could not register the shortcut \(shortcut.label).",
                ])
            }
            nextCarbonHotKeyId += 1
        }
    }

    fileprivate func handleCarbonHotKey(id: UInt32, pressed: Bool) {
        guard !isCapturingShortcut, let entry = carbonHotKeys[id] else {
            return
        }
        if pressed {
            handlePhysicalDown(identity: entry.identity)
        } else {
            handlePhysicalUp(identity: entry.identity)
        }
    }

    private func handle(event: NSEvent) {
        guard event.type == .flagsChanged else {
            return
        }
        if isCapturingShortcut {
            // Modifier-only chords (fn included) are captured here; key
            // chords are captured by the focused June window's DOM, which
            // sees ordinary keystrokes without any permission.
            handleCapture(modifiers: shortcutModifiers(from: event.modifierFlags))
            return
        }
        handleFlagsChanged(
            shortcutModifiers(from: event.modifierFlags),
            changedKeyCode: UInt16(event.keyCode)
        )
    }

    private func handleCapture(modifiers: ShortcutModifiers) {
        if modifiers.isSupportedModifierOnlyShortcut {
            scheduleModifierOnlyCapture(modifiers: modifiers)
        } else {
            cancelPendingModifierOnlyCapture()
        }
    }

    private func scheduleModifierOnlyCapture(modifiers: ShortcutModifiers) {
        guard pendingModifierOnlyModifiers != modifiers else {
            return
        }
        cancelPendingModifierOnlyCapture()

        let work = DispatchWorkItem { [weak self] in
            guard let self else {
                return
            }
            let code = modifiers.isBareFunction ? "Fn" : "Modifiers"
            let label = modifiers.labelParts.joined(separator: "+")
            self.pendingModifierOnlyModifiers = nil
            self.finishCapture(
                MonitoredShortcut(
                    keyCode: 0,
                    code: code,
                    label: label,
                    modifiers: modifiers,
                    pressCount: self.capturePressCount
                )
            )
        }
        pendingModifierOnlyModifiers = modifiers
        pendingModifierOnlyCapture = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
    }

    private func finishCapture(_ nextShortcut: MonitoredShortcut) {
        guard isCapturingShortcut else {
            return
        }

        isCapturingShortcut = false
        cancelPendingModifierOnlyCapture()
        // Resume the previous hot keys now; set_shortcut re-registers with
        // the new chord once the frontend persists it.
        registerCarbonHotKeys()
        emitJSON("shortcut_captured", [
            "shortcut": nextShortcut.payload,
        ])
    }

    private func cancelPendingModifierOnlyCapture() {
        pendingModifierOnlyCapture?.cancel()
        pendingModifierOnlyCapture = nil
        pendingModifierOnlyModifiers = nil
    }

    private func matchingModifierOnlyIdentity(_ current: ShortcutModifiers) -> ShortcutIdentity? {
        for shortcut in shortcuts.values where shortcut.isModifierOnly {
            guard shortcut.modifiers == current else {
                continue
            }
            return ShortcutIdentity(shortcut)
        }
        return nil
    }

    /// The physical keys that can legitimately produce a press/release edge
    /// for a shortcut's modifier set. flagsChanged events carry the keyCode
    /// of the key that changed; anything outside this set (an arrow key's fn
    /// bit, a Cmd release while fn is held) must not be read as an edge.
    private func modifierKeyCodes(for modifiers: ShortcutModifiers) -> Set<UInt16> {
        var codes: Set<UInt16> = []
        if modifiers.command {
            codes.formUnion([0x36, 0x37]) // right/left Command
        }
        if modifiers.shift {
            codes.formUnion([0x38, 0x3C]) // left/right Shift
        }
        if modifiers.option {
            codes.formUnion([0x3A, 0x3D]) // left/right Option
        }
        if modifiers.control {
            codes.formUnion([0x3B, 0x3E]) // left/right Control
        }
        if modifiers.function {
            codes.insert(0x3F) // fn / Globe
        }
        return codes
    }

    private func shortcuts(matching identity: ShortcutIdentity) -> [(ShortcutKind, MonitoredShortcut)] {
        shortcuts.compactMap { kind, shortcut in
            ShortcutIdentity(shortcut) == identity ? (kind, shortcut) : nil
        }
    }

    private func handlePhysicalDown(identity: ShortcutIdentity) {
        guard activeIdentity != identity else {
            return
        }
        activeIdentity = identity

        let matches = shortcuts(matching: identity)
        if let toggle = matches.first(where: { $0.0 == .toggle && $0.1.pressCount == 2 }) {
            let now = Date()
            if lastTapIdentity == identity,
               let lastTapAt,
               now.timeIntervalSince(lastTapAt) <= Self.doublePressWindow {
                lastTapIdentity = nil
                self.lastTapAt = nil
                cancelPendingPush()
                emitShortcut(.toggle, shortcut: toggle.1, isDown: true)
                return
            }
        }

        if let toggle = matches.first(where: { $0.0 == .toggle && $0.1.pressCount == 1 }) {
            emitShortcut(.toggle, shortcut: toggle.1, isDown: true)
        }

        if let push = matches.first(where: { $0.0 == .pushToTalk && $0.1.pressCount == 1 }) {
            if matches.contains(where: { $0.0 == .toggle }) {
                // A toggle shares this trigger, so a fresh press is ambiguous:
                // a tap is (or arms) the toggle, only a hold is the push. The
                // hold threshold is what tells them apart.
                schedulePushStart(identity: identity, shortcut: push.1)
            } else {
                // Unambiguous push-to-talk (the default config: bare fn with
                // the toggle on a different trigger). The threshold used to
                // tax every dictation with 160ms before the microphone even
                // opened; start on the down edge instead. Grazes are handled
                // on the app side now: it times the press and discards
                // releases shorter than the old threshold, so a brushed key
                // never pastes transcribed noise.
                cancelPendingPush()
                activePushIdentity = identity
                emitShortcut(.pushToTalk, shortcut: push.1, isDown: true)
            }
        }
    }

    /// `isPhysicalRelease` is false when the up is synthesized by a foreign
    /// modifier interrupting the chord (Cmd pressed mid-fn-hold): the press
    /// ends, but it was never released, so it must not count as the first
    /// tap of a double-press.
    private func handlePhysicalUp(identity: ShortcutIdentity, isPhysicalRelease: Bool = true) {
        guard activeIdentity == identity else {
            return
        }
        activeIdentity = nil

        if activePushIdentity == identity, let push = shortcuts(matching: identity).first(where: { $0.0 == .pushToTalk }) {
            activePushIdentity = nil
            emitShortcut(.pushToTalk, shortcut: push.1, isDown: false)
            return
        }

        cancelPendingPush()

        if isPhysicalRelease,
           shortcuts(matching: identity).contains(where: { $0.0 == .toggle && $0.1.pressCount == 2 }) {
            lastTapIdentity = identity
            lastTapAt = Date()
        }
    }

    private func schedulePushStart(identity: ShortcutIdentity, shortcut: MonitoredShortcut) {
        cancelPendingPush()
        pendingPushIdentity = identity
        pendingPushShortcut = shortcut
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  self.activeIdentity == identity,
                  self.pendingPushIdentity == identity,
                  let shortcut = self.pendingPushShortcut
            else {
                return
            }
            self.activePushIdentity = identity
            self.pendingPushIdentity = nil
            self.pendingPushShortcut = nil
            self.emitShortcut(.pushToTalk, shortcut: shortcut, isDown: true)
        }
        pendingPushWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdThreshold, execute: work)
    }

    private func cancelPendingPush() {
        pendingPushWork?.cancel()
        pendingPushWork = nil
        pendingPushIdentity = nil
        pendingPushShortcut = nil
    }

    private func emitShortcut(_ kind: ShortcutKind, shortcut: MonitoredShortcut, isDown: Bool) {
        emit(isDown ? "shortcut_key_down" : "shortcut_key_up", [
            "kind": kind.rawValue,
            "shortcut": shortcut.label,
        ])
    }
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

private let carbonHotKeyCallback: EventHandlerUPP = { _, eventRef, userInfo in
    guard let eventRef, let userInfo else {
        return OSStatus(eventNotHandledErr)
    }
    var hotKeyId = EventHotKeyID()
    let status = GetEventParameter(
        eventRef,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyId
    )
    guard status == noErr else {
        return status
    }
    let monitor = Unmanaged<ShortcutKeyMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    let pressed = GetEventKind(eventRef) == UInt32(kEventHotKeyPressed)
    // GetEventDispatcherTarget delivers on the main thread already; calling
    // synchronously avoids a run-loop hop during which re-registration
    // (setShortcut) could clear the hot-key table and drop this press.
    monitor.handleCarbonHotKey(id: hotKeyId.id, pressed: pressed)
    return noErr
}

final class FocusTargetController {
    static let shared = FocusTargetController()

    private var lastExternalApp: NSRunningApplication?
    private var pinnedTarget: NSRunningApplication?
    private let ignoredBundleIdentifiers: Set<String> = [
        "co.opensoftware.june.dictation-helper",
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

    func pinCurrentTarget() {
        pinnedTarget = lastExternalApp
    }

    func clearPinnedTarget() {
        pinnedTarget = nil
    }

    func pasteTarget() -> NSRunningApplication? {
        guard let app = pinnedTarget, !app.isTerminated else {
            return nil
        }
        return app
    }

    func targetDescription() -> String {
        guard let app = lastExternalApp, !app.isTerminated else {
            return "unknown"
        }
        return app.localizedName ?? app.bundleIdentifier ?? "\(app.processIdentifier)"
    }

    func pasteTargetDescription() -> String {
        guard let app = pasteTarget() else {
            return "unknown"
        }
        return app.localizedName ?? app.bundleIdentifier ?? "\(app.processIdentifier)"
    }

    /// Rust cleanup needs the same target that paste will use, so a pinned
    /// dictation target must win over later activation drift.
    func targetBundleIdentifier() -> String? {
        if let app = pinnedTarget {
            guard !app.isTerminated else {
                return nil
            }
            return app.bundleIdentifier
        }
        guard let app = lastExternalApp, !app.isTerminated else {
            return nil
        }
        return app.bundleIdentifier
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
        guard !appName.localizedCaseInsensitiveContains("dictation-helper") else {
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
    private let queue = DispatchQueue(label: "co.opensoftware.june.dictation-recorder")
    private let writer: AVAssetWriter
    private let writerInput: AVAssetWriterInput
    private var didStartWriting = false
    private var isStopping = false
    private var finishHandler: ((Error?) -> Void)?
    private let failureHandler: (Error) -> Void
    private let levelHandler: (Float) -> Void
    // Coalesce per-buffer levels to ~25Hz before emitting, matching the
    // AVAudioRecorder metering timer. AVCaptureAudioDataOutput delivers buffers
    // far faster than that (faster still for aggregate "system + mic" devices),
    // so emitting one event per buffer floods the IPC channel — the HUD's event
    // queue grows unbounded over a long recording until the waveform visibly
    // lags and then freezes. Track the max level across skipped buffers so loud
    // transients still register. All accesses happen on `queue` (the capture
    // delegate queue), so no locking is needed.
    private var lastLevelEmit: TimeInterval = 0
    private var pendingLevel: Float = 0
    private let levelEmitInterval: TimeInterval = 0.04

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
            flushPendingLevel()
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
        guard let level = audioLevel(from: sampleBuffer) else {
            return
        }
        pendingLevel = max(pendingLevel, level)
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastLevelEmit >= levelEmitInterval else {
            return
        }
        emitPendingLevel(at: now)
    }

    private func flushPendingLevel() {
        guard pendingLevel > 0 else {
            return
        }
        emitPendingLevel(at: ProcessInfo.processInfo.systemUptime)
    }

    private func emitPendingLevel(at now: TimeInterval) {
        lastLevelEmit = now
        let coalesced = pendingLevel
        pendingLevel = 0
        levelHandler(coalesced)
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

func audioLevel(from sampleBuffer: CMSampleBuffer) -> Float? {
    guard
        let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer)
    else {
        return nil
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
        return nil
    }

    var isFloat = false
    var bitsPerChannel = 16
    if let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee {
        isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        if asbd.mBitsPerChannel > 0 {
            bitsPerChannel = Int(asbd.mBitsPerChannel)
        }
    }

    var sumSquares: Float = 0
    var peak: Float = 0
    var sampleCount = 0
    if isFloat && bitsPerChannel == 32 {
        sampleCount = length / MemoryLayout<Float32>.size
        dataPointer.withMemoryRebound(to: Float32.self, capacity: sampleCount) { pointer in
            for index in 0..<sampleCount {
                let value = pointer[index]
                sumSquares += value * value
                peak = max(peak, abs(value))
            }
        }
    } else if !isFloat && bitsPerChannel == 16 {
        sampleCount = length / MemoryLayout<Int16>.size
        dataPointer.withMemoryRebound(to: Int16.self, capacity: sampleCount) { pointer in
            for index in 0..<sampleCount {
                let value = Float(pointer[index]) / Float(Int16.max)
                sumSquares += value * value
                peak = max(peak, abs(value))
            }
        }
    } else if !isFloat && bitsPerChannel == 32 {
        sampleCount = length / MemoryLayout<Int32>.size
        dataPointer.withMemoryRebound(to: Int32.self, capacity: sampleCount) { pointer in
            for index in 0..<sampleCount {
                let value = Float(pointer[index]) / Float(Int32.max)
                sumSquares += value * value
                peak = max(peak, abs(value))
            }
        }
    } else {
        return nil
    }
    guard sampleCount > 0 else {
        return nil
    }
    let rms = sqrt(sumSquares / Float(sampleCount))
    return min(1, peak * 0.8 + rms * 0.2)
}

enum AutoDetectInputMeterError: LocalizedError {
    case cannotResolveDefaultInput
    case cannotAddInput
    case cannotAddOutput

    var errorDescription: String? {
        switch self {
        case .cannotResolveDefaultInput:
            return "Could not resolve the default microphone for metering."
        case .cannotAddInput:
            return "Could not use the default microphone as a metering input."
        case .cannotAddOutput:
            return "Could not create audio output for default microphone metering."
        }
    }
}

final class AutoDetectInputMeter: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "co.opensoftware.june.dictation-auto-meter")
    private let levelHandler: (Float) -> Void
    private var pendingLevel: Float = 0
    private var lastLevelEmit: TimeInterval = 0
    private var isStopped = true
    private let levelEmitInterval: TimeInterval = 0.02

    init(onLevel: @escaping (Float) -> Void) {
        levelHandler = onLevel
    }

    func start() throws {
        guard let device = AVCaptureDevice.default(for: .audio) ?? audioInputDevices().first else {
            throw AutoDetectInputMeterError.cannotResolveDefaultInput
        }
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw AutoDetectInputMeterError.cannotAddInput
        }
        session.addInput(input)
        guard session.canAddOutput(output) else {
            session.removeInput(input)
            session.commitConfiguration()
            throw AutoDetectInputMeterError.cannotAddOutput
        }
        output.setSampleBufferDelegate(self, queue: queue)
        session.addOutput(output)
        session.commitConfiguration()
        queue.sync {
            pendingLevel = 0
            lastLevelEmit = 0
            isStopped = false
        }
        session.startRunning()
    }

    func stop() {
        queue.sync {
            pendingLevel = 0
            lastLevelEmit = 0
            isStopped = true
        }
        session.stopRunning()
        output.setSampleBufferDelegate(nil, queue: nil)
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard !isStopped else {
            return
        }
        guard let level = audioLevel(from: sampleBuffer) else {
            return
        }
        pendingLevel = max(pendingLevel, level)
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastLevelEmit >= levelEmitInterval else {
            return
        }
        lastLevelEmit = now
        let coalesced = pendingLevel
        pendingLevel = 0
        levelHandler(coalesced)
    }
}

func autoDetectRawMeteringEnabled() -> Bool {
    guard let rawValue = ProcessInfo.processInfo.environment["OS_JUNE_DICTATION_RAW_METER"] else {
        return true
    }
    switch rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "0", "false", "no", "off", "disabled":
        return false
    default:
        return true
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

enum RecordingPurpose {
    case dictation
    case micTest
}

let micTestCapturePaddingSeconds: Double = 0.35
// Keep in sync with DICTATION_AUDIO_ACTIVITY_THRESHOLD in dictation.rs. The
// trained classifier only affects captures below this independent meter gate,
// so louder dictation should not pay for file analysis during finalization.
let dictationAudioActivityThreshold: Float = 0.04

final class DictationController {
    private var audioRecorder: AVAudioRecorder?
    private var selectedDeviceRecorder: SelectedDeviceRecorder?
    private var autoDetectInputMeter: AutoDetectInputMeter?
    private var recordingURL: URL?
    private var micTestSampleURL: URL?
    private var micTestStopWorkItem: DispatchWorkItem?
    private var recordingPurpose: RecordingPurpose = .dictation
    private var recordingStartedAt: TimeInterval = 0
    private var meteringTimer: DispatchSourceTimer?
    private var preferredMicrophoneID: String?
    private var preferredMicrophoneName: String?
    private var isListening = false
    private var isFinalizing = false
    private var startPending = false
    private var maxObservedAudioLevel: Float = 0

    var listening: Bool {
        isListening || isFinalizing || startPending
    }

    func emitDiagnostics() {
        emit("dictation_diagnostics", [
            "bundleIdentifier": helperBundleIdentifier(),
            "microphone": microphoneStatus(),
            "accessibility": boolStatus(AXIsProcessTrusted()),
            "autoDetectRawMeter": autoDetectRawMeteringEnabled() ? "enabled" : "disabled",
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

    /// Invalidates pending dictation starts. `AVCaptureDevice.requestAccess`
    /// can fire its callback long after the request — the user reading the
    /// macOS permission prompt — and a graze's discard arrives in between:
    /// without this, accepting the prompt later would open the microphone
    /// with no key held. discard() bumps the generation; a stale callback
    /// sees the mismatch and does nothing.
    private var dictationStartGeneration = 0

    func start(playCue: Bool) {
        if startPending {
            return
        }
        guard !listening else {
            emit("error", ["code": "already_listening", "message": "Dictation is already listening."])
            return
        }

        startPending = true
        dictationStartGeneration += 1
        let generation = dictationStartGeneration
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] microphoneAllowed in
            // Hop to main: commands (including the discard that may have
            // cancelled this start) are handled there, so the generation
            // comparison is ordered against them.
            DispatchQueue.main.async {
                guard let self, self.dictationStartGeneration == generation else {
                    return
                }
                guard microphoneAllowed else {
                    self.startPending = false
                    emit("error", ["code": "microphone_permission_missing", "message": "Microphone permission is required."])
                    emit("permission_status", permissionPayload())
                    return
                }
                let beginRecording = { [weak self] in
                    guard
                        let self,
                        self.startPending,
                        self.dictationStartGeneration == generation
                    else {
                        return
                    }
                    self.startPending = false
                    self.startRecording(purpose: .dictation, durationSeconds: nil)
                }
                if playCue {
                    // Toggle dictation has no key-up timing contract, so its
                    // cue can finish before capture starts without entering
                    // the recording. Push-to-talk skips this cue and calls
                    // beginRecording immediately so the down edge remains
                    // the start of capture.
                    RecordingCuePlayer.play(.start, completion: beginRecording)
                } else {
                    beginRecording()
                }
            }
        }
    }

    func stop() {
        // A stop that lands while a start is still waiting on the permission
        // prompt cancels that start (a grazed push-to-talk key, or the prompt
        // never calling back); erroring not_listening here would wedge the
        // pending flag until a helper restart.
        if startPending && !isListening {
            dictationStartGeneration += 1
            RecordingCuePlayer.cancel(.start)
            resetRecordingState()
            emit("recording_discarded", ["reason": "start_cancelled"])
            return
        }
        guard isListening, recordingPurpose == .dictation else {
            emit("error", ["code": "not_listening", "message": "Dictation is not listening."])
            return
        }

        stopActiveRecording()
    }

    func toggle(shortcut: String) {
        if isListening || startPending {
            emit("hotkey_trigger", ["action": "stop", "shortcut": shortcut])
            stop()
        } else if !isFinalizing {
            emit("hotkey_trigger", ["action": "start", "shortcut": shortcut])
            start(playCue: true)
        }
    }

    func startMicTest(durationSeconds: Double) {
        guard !listening else {
            emit("mic_test_error", ["code": "already_listening", "message": "Audio capture is already running."])
            return
        }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] microphoneAllowed in
            guard microphoneAllowed else {
                emit("mic_test_error", ["code": "microphone_permission_missing", "message": "Microphone permission is required."])
                emit("permission_status", permissionPayload())
                return
            }
            self?.startRecording(
                purpose: .micTest,
                durationSeconds: max(1, min(15, durationSeconds))
            )
        }
    }

    func discardMicTest() {
        if isListening, recordingPurpose == .micTest {
            resetRecordingState()
        }
        cleanupMicTestSample()
    }

    func paste(text: String) {
        let text = dictationPasteText(text)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            fail(DictationError.missingTranscript)
            return
        }

        emit("final_transcript", ["text": text])
        PasteboardInserter.paste(text)
        resetRecordingState()
    }

    func copyForReview(text: String, keepRecordingFile: Bool, historySaved: Bool) {
        let text = dictationPasteText(text)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            fail(DictationError.missingTranscript)
            return
        }

        PasteboardInserter.copyForReview(text, historySaved: historySaved)
        resetRecordingState(keepRecordingFile: keepRecordingFile)
    }

    func discard() {
        // Cancel any start still waiting on the permission prompt — the
        // graze is over, so a later grant must not open the microphone.
        dictationStartGeneration += 1
        startPending = false
        // The HUD shows on listening_started, so a discard that interrupts a
        // live recording (a grazed push-to-talk key, a signed-out session)
        // must announce itself or the HUD stays stuck on "Listening".
        let wasListening = isListening
        resetRecordingState()
        if wasListening {
            emit("recording_discarded")
        }
    }

    func shutdown() {
        resetRecordingState()
        emit("shutdown_ack")
        exit(0)
    }

    private func startRecording(purpose: RecordingPurpose, durationSeconds: Double?) {
        resetRecordingState()
        cleanupMicTestSample()
        recordingPurpose = purpose
        recordingStartedAt = ProcessInfo.processInfo.systemUptime

        let nextRecordingURL = temporaryRecordingURL()
        // Preserve the legacy Auto-detect behavior: AVAudioRecorder delegates
        // default-input selection and audio processing to macOS. The custom
        // capture path is still used when the user explicitly pins a microphone.
        // (Routing Auto-detect through the capture path was reverted in #86 — it
        // caused low recorded levels / no_speech for some default-mic users.)
        if let selectedDevice = microphoneDevice(for: preferredMicrophoneID) {
            startSelectedDeviceRecording(
                device: selectedDevice,
                url: nextRecordingURL,
                purpose: purpose,
                durationSeconds: durationSeconds
            )
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
            startAutoDetectMetering()
            markRecordingStarted(
                microphone: preferredMicrophoneName ?? "Auto-detect",
                purpose: purpose,
                durationSeconds: durationSeconds
            )
        } catch {
            resetRecordingState()
            emitRecordingError(
                purpose: purpose,
                code: "audio_start_failed",
                message: error.localizedDescription
            )
        }
    }

    private func startSelectedDeviceRecording(
        device: AVCaptureDevice,
        url: URL,
        purpose: RecordingPurpose,
        durationSeconds: Double?
    ) {
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
            recorder.start()
            markRecordingStarted(
                microphone: device.localizedName,
                purpose: purpose,
                durationSeconds: durationSeconds
            )
        } catch {
            resetRecordingState()
            emitRecordingError(
                purpose: purpose,
                code: "audio_start_failed",
                message: error.localizedDescription
            )
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

        if recordingPurpose == .micTest {
            emitMicTestReady(url: recordingURL)
            return
        }

        let observedAudioLevel = maxObservedAudioLevel
        let targetBundleIdentifier = FocusTargetController.shared.targetBundleIdentifier() ?? ""
        let basePayload = [
            "path": recordingURL.path,
            "observedAudioLevel": String(format: "%.4f", observedAudioLevel),
            "targetBundleIdentifier": targetBundleIdentifier,
        ]
        guard observedAudioLevel < dictationAudioActivityThreshold else {
            emit("recording_ready", basePayload)
            return
        }
        if let duration = audioDurationSeconds(at: recordingURL),
           duration < speechAnalysisWindowDurationSeconds {
            var payload = basePayload
            payload["speechAnalysisStatus"] = "no_complete_window"
            emit("recording_ready", payload)
            return
        }
        analyzeSpeechConfidence(at: recordingURL) { [weak self] speechConfidence in
            guard let self, self.isFinalizing, self.recordingURL == recordingURL else {
                return
            }
            var payload = basePayload
            if let speechConfidence {
                payload["speechConfidence"] = String(format: "%.4f", speechConfidence)
                payload["speechAnalysisStatus"] = "ok"
            } else {
                payload["speechAnalysisStatus"] = "unavailable"
            }
            emit("recording_ready", payload)
        }
    }

    private func emitMicTestReady(url: URL) {
        let observedAudioLevel = maxObservedAudioLevel
        let durationMs = Int(max(0, ProcessInfo.processInfo.systemUptime - recordingStartedAt) * 1000)
        micTestSampleURL = url
        resetRecordingState(keepRecordingFile: true)
        emitJSON("mic_test_ready", [
            "path": url.path,
            "durationMs": durationMs,
            "observedAudioLevel": String(format: "%.4f", observedAudioLevel),
        ])
    }

    private func markRecordingStarted(
        microphone: String,
        purpose: RecordingPurpose,
        durationSeconds: Double?
    ) {
        isListening = true
        if purpose == .micTest {
            RecordingCuePlayer.play(.start)
            scheduleMicTestStop(after: durationSeconds ?? 5)
            emitJSON("mic_test_started", [
                "durationMs": Int((durationSeconds ?? 5) * 1000),
                "microphone": microphone,
            ])
        } else {
            emit("listening_started", [
                "recognitionMode": "venice_recording",
                "microphone": microphone,
            ])
        }
    }

    private func stopActiveRecording() {
        let purpose = recordingPurpose
        if purpose == .dictation {
            // Selected-device recorder teardown is asynchronous, so the paste
            // target must be pinned before focus can drift during finalization.
            FocusTargetController.shared.pinCurrentTarget()
        }
        isListening = false
        isFinalizing = true
        micTestStopWorkItem?.cancel()
        micTestStopWorkItem = nil
        stopMetering()
        if purpose == .dictation {
            emit("finalizing_transcript")
        }

        if let selectedDeviceRecorder {
            selectedDeviceRecorder.stop { [weak self] error in
                runOnMain {
                    self?.selectedDeviceRecorder = nil
                    RecordingCuePlayer.play(.stop)
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
        RecordingCuePlayer.play(.stop)
        emitRecordingReady()
    }

    private func scheduleMicTestStop(after seconds: Double) {
        micTestStopWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.isListening, self.recordingPurpose == .micTest else {
                return
            }
            self.stopActiveRecording()
        }
        micTestStopWorkItem = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + seconds + micTestCapturePaddingSeconds,
            execute: workItem
        )
    }

    private func temporaryRecordingURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("os-june-dictation-\(UUID().uuidString)")
            .appendingPathExtension("m4a")
    }

    private func startMetering() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        // 50Hz (20ms) emit rate: a fresh level roughly every rAF frame so the
        // bars track speech without the steppiness of the old 40ms cadence.
        // Tiny JSON lines, so the IPC channel handles it comfortably.
        timer.schedule(deadline: .now(), repeating: .milliseconds(20))
        timer.setEventHandler { [weak self] in
            self?.emitAudioRecorderLevel()
        }
        meteringTimer = timer
        timer.resume()
    }

    private func startAutoDetectMetering() {
        startMetering()
        guard autoDetectRawMeteringEnabled() else {
            return
        }

        do {
            let inputMeter = AutoDetectInputMeter { [weak self] level in
                runOnMain {
                    self?.observeAudioLevel(level)
                }
            }
            try inputMeter.start()
            autoDetectInputMeter = inputMeter
            stopAudioRecorderMetering()
            emit("metering_source", ["source": "default_capture"])
        } catch {
            autoDetectInputMeter = nil
            emit("metering_source", [
                "source": "av_audio_recorder",
                "rawInputMeter": "failed",
            ])
        }
    }

    private func emitAudioRecorderLevel() {
        guard let audioRecorder, audioRecorder.isRecording else {
            return
        }

        audioRecorder.updateMeters()
        // averagePower is heavily time-smoothed — it reads dead under speech and
        // is why production never shimmered like the playground. peakPower tracks
        // per-syllable dynamics; bias hard toward it and keep a little average so
        // the floor between syllables doesn't flicker.
        let peakDb = max(audioRecorder.peakPower(forChannel: 0), -80)
        let averageDb = max(audioRecorder.averagePower(forChannel: 0), -80)
        let peak = Float(pow(10.0, Double(peakDb) / 20.0))
        let average = Float(pow(10.0, Double(averageDb) / 20.0))
        let level = peak * 0.8 + average * 0.2
        observeAudioLevel(min(1, level))
    }

    private func observeAudioLevel(_ level: Float) {
        maxObservedAudioLevel = max(maxObservedAudioLevel, level)
        if recordingPurpose == .micTest {
            emit("mic_test_level", ["level": String(format: "%.4f", level)])
        } else {
            emit("audio_level", ["level": String(format: "%.4f", level)])
        }
    }

    private func stopMetering() {
        autoDetectInputMeter?.stop()
        autoDetectInputMeter = nil
        stopAudioRecorderMetering()
    }

    private func stopAudioRecorderMetering() {
        meteringTimer?.cancel()
        meteringTimer = nil
    }

    private func fail(_ error: Error) {
        let code = (error as? DictationError)?.code ?? "dictation_failed"
        emitRecordingError(
            purpose: recordingPurpose,
            code: code,
            message: error.localizedDescription
        )
        resetRecordingState()
    }

    private func emitRecordingError(purpose: RecordingPurpose, code: String, message: String) {
        if purpose == .micTest {
            emit("mic_test_error", ["code": code, "message": message])
        } else {
            emit("error", ["code": code, "message": message])
        }
    }

    private func cleanupRecordingFile() {
        guard let recordingURL else {
            return
        }
        try? FileManager.default.removeItem(at: recordingURL)
    }

    private func cleanupMicTestSample() {
        guard let micTestSampleURL else {
            return
        }
        try? FileManager.default.removeItem(at: micTestSampleURL)
        self.micTestSampleURL = nil
    }

    private func resetRecordingState(keepRecordingFile: Bool = false) {
        RecordingCuePlayer.cancel(.start)
        FocusTargetController.shared.clearPinnedTarget()
        isListening = false
        isFinalizing = false
        startPending = false
        maxObservedAudioLevel = 0
        recordingStartedAt = 0
        micTestStopWorkItem?.cancel()
        micTestStopWorkItem = nil
        stopMetering()
        audioRecorder?.stop()
        audioRecorder = nil
        selectedDeviceRecorder?.cancel()
        selectedDeviceRecorder = nil
        if !keepRecordingFile {
            cleanupRecordingFile()
        }
        recordingURL = nil
        recordingPurpose = .dictation
    }
}

func dictationPasteText(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
        return ""
    }
    return "\(trimmed) "
}

struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]
}

enum PasteboardInserter {
    /// The activation observer is cheap, and 20 ms keeps long dictation paste
    /// handoff responsive without blocking the main run loop.
    private static let activationPollInterval: TimeInterval = 0.02
    /// Activation is asynchronous. If the pinned app has not come forward
    /// within a second, abandon the automatic paste rather than post Cmd+V into
    /// whichever app is frontmost instead.
    private static let activationTimeout: TimeInterval = 1.0
    /// Frontmost app activation and key-window focus do not land at the same
    /// instant, so a short settle delay protects the synthetic Cmd+V target.
    private static let activationSettleDelay: TimeInterval = 0.18
    /// Restore is measured from the keystroke so the target gets a full window
    /// to read the transcript from the pasteboard.
    private static let pasteboardRestoreDelay: TimeInterval = 0.7

    private static func emitPasteTargetUnavailable() {
        emit("error", [
            "code": "paste_target_unavailable",
            "message": "June couldn't paste automatically. Your transcript is on the clipboard, so you can paste it with Cmd+V.",
        ])
    }

    static func paste(_ text: String) {
        let pasteboard = NSPasteboard.general
        let snapshot = capture(pasteboard)

        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            emit("error", ["code": "pasteboard_write_failed", "message": "Could not write transcript to the clipboard."])
            restore(snapshot, to: pasteboard)
            return
        }

        // The synthetic Cmd+V below is a CGEvent keystroke, which macOS
        // silently drops unless this helper holds Accessibility trust. That
        // trust is commonly invalidated when an app update changes the
        // helper's signature. Without this gate we'd post the keystroke into
        // the void, emit paste_completed anyway, then restore the clipboard —
        // so the transcript would vanish and the paste would look successful
        // while nothing landed. When untrusted, leave the transcript on the
        // clipboard for a manual paste, tell the user, and refresh the
        // permission state so the in-app Accessibility banner appears.
        guard AXIsProcessTrusted() else {
            emit("permission_status", permissionPayload())
            emit("error", [
                "code": "accessibility_permission_missing",
                "message": "June couldn't paste automatically. Your transcript is on the clipboard, so you can paste it with Cmd+V.",
            ])
            return
        }

        guard let target = FocusTargetController.shared.pasteTarget() else {
            emitPasteTargetUnavailable()
            return
        }

        let targetActivated = target.isActive ? true : target.activate(options: [])
        emit("paste_target", [
            "app": FocusTargetController.shared.pasteTargetDescription(),
            "activated": boolStatus(targetActivated),
        ])

        waitForActivation(
            of: target,
            deadline: DispatchTime.now() + activationTimeout
        ) { targetIsFrontmost in
            // Cmd+V goes wherever the window server thinks focus is, so posting
            // it while the pinned app is not frontmost types the transcript
            // into somebody else's window. If the activation never landed,
            // abandon the paste rather than guess: the transcript is already on
            // the clipboard, and a manual Cmd+V beats text in the wrong app.
            guard targetIsFrontmost else {
                emitPasteTargetUnavailable()
                return
            }

            postPasteShortcut()
            emit("paste_completed")

            DispatchQueue.global().asyncAfter(deadline: .now() + pasteboardRestoreDelay) {
                if pasteboard.string(forType: .string) == text {
                    restore(snapshot, to: pasteboard)
                }
            }
        }
    }

    /// Keeps an uncertain transcript recoverable without typing it into the
    /// user's active app. Unlike a normal paste, the clipboard is deliberately
    /// not restored after a successful write.
    static func copyForReview(_ text: String, historySaved: Bool) {
        let pasteboard = NSPasteboard.general
        let snapshot = capture(pasteboard)

        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            restore(snapshot, to: pasteboard)
            let message = historySaved
                ? "Could not write transcript to the clipboard. Find it in Dictation history."
                : "Could not save or copy this dictation. The recording was kept for recovery."
            emit("error", ["code": "pasteboard_write_failed", "message": message])
            return
        }

        let message = historySaved
            ? "Speech was unclear. Use Cmd+V to paste the transcript."
            : "Could not save this dictation. Use Cmd+V to keep the transcript."
        emit("error", [
            "code": "dictation_low_speech_evidence",
            "message": message,
        ])
    }

    /// Calls `completion(true)` only when `target` is alive and frontmost at
    /// that moment. `NSRunningApplication.isActive` means "currently
    /// frontmost", so a read taken right before the keystroke is the strongest
    /// guarantee available: it shrinks the gap between deciding and typing to
    /// the time it takes to post the event, rather than closing it outright.
    private static func waitForActivation(
        of target: NSRunningApplication,
        deadline: DispatchTime,
        completion: @escaping (_ targetIsFrontmost: Bool) -> Void
    ) {
        guard !target.isTerminated else {
            completion(false)
            return
        }

        if target.isActive {
            DispatchQueue.main.asyncAfter(deadline: .now() + activationSettleDelay) {
                completion(!target.isTerminated && target.isActive)
            }
            return
        }

        // The app never came forward. Activation is a request, not a command:
        // a modal, a full-screen space, or a refused cooperative activation can
        // all outlast the deadline.
        guard DispatchTime.now().uptimeNanoseconds < deadline.uptimeNanoseconds else {
            completion(false)
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + activationPollInterval) {
            waitForActivation(of: target, deadline: deadline, completion: completion)
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
    case "request_microphone_permission":
        requestMicrophonePermission()
    case "request_accessibility_permission":
        runOnMain {
            requestAccessibilityPermission()
        }
    case "list_microphones":
        runOnMain {
            dictation.emitMicrophones()
        }
    case "start_listening":
        runOnMain {
            dictation.start(playCue: false)
        }
    case "stop_and_paste":
        runOnMain {
            dictation.stop()
        }
    case "start_mic_test":
        let durationSeconds = command?["durationSeconds"] as? Double
            ?? (command?["durationSeconds"] as? Int).map(Double.init)
            ?? 5
        runOnMain {
            dictation.startMicTest(durationSeconds: durationSeconds)
        }
    case "discard_mic_test":
        runOnMain {
            dictation.discardMicTest()
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
            let shortcut = MonitoredShortcut(payload: payload),
            let rawKind = payload["kind"] as? String,
            let kind = ShortcutKind(rawValue: rawKind)
        else {
            emit("error", ["code": "invalid_shortcut", "message": "Shortcut configuration was invalid."])
            return
        }
        runOnMain {
            ShortcutKeyMonitor.shared.setShortcut(shortcut, kind: kind)
        }
    case "start_shortcut_capture":
        let pressCount = command?["pressCount"] as? Int ?? (command?["pressCount"] as? NSNumber)?.intValue ?? 1
        runOnMain {
            ShortcutKeyMonitor.shared.startShortcutCapture(pressCount: pressCount)
        }
    case "cancel_shortcut_capture":
        runOnMain {
            ShortcutKeyMonitor.shared.cancelShortcutCapture()
        }
    case "toggle_listening":
        let shortcut = command?["shortcut"] as? String ?? "hotkey"
        runOnMain {
            dictation.toggle(shortcut: shortcut)
        }
    case "paste_text":
        let text = command?["text"] as? String ?? ""
        runOnMain {
            dictation.paste(text: text)
        }
    case "copy_text_for_review":
        let text = command?["text"] as? String ?? ""
        let keepRecordingFile = command?["keepRecordingFile"] as? Bool ?? false
        let historySaved = command?["historySaved"] as? Bool ?? true
        runOnMain {
            dictation.copyForReview(
                text: text,
                keepRecordingFile: keepRecordingFile,
                historySaved: historySaved
            )
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
AccessibilityTrustMonitor.shared.start()
dictation.emitDiagnostics()

Thread.detachNewThread {
    while let line = readLine() {
        handleCommandLine(line)
    }
}

app.run()
