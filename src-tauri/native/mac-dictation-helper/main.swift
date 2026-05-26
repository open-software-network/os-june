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

emit("ready")
FocusTargetController.shared.start()
dictation.emitDiagnostics()

Thread.detachNewThread {
    while let line = readLine() {
        handleCommandLine(line)
    }
}

RunLoop.main.run()
