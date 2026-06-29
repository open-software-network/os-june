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
    ]
}

func requestMicrophonePermission() {
    AVCaptureDevice.requestAccess(for: .audio) { _ in
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
    private var maxObservedAudioLevel: Float = 0

    var listening: Bool {
        isListening || isFinalizing
    }

    func emitDiagnostics() {
        emit("dictation_diagnostics", [
            "bundleIdentifier": helperBundleIdentifier(),
            "microphone": microphoneStatus(),
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

    func start() {
        guard !listening else {
            emit("error", ["code": "already_listening", "message": "Dictation is already listening."])
            return
        }

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
                    emit("error", ["code": "microphone_permission_missing", "message": "Microphone permission is required."])
                    emit("permission_status", permissionPayload())
                    return
                }
                self.startRecording(purpose: .dictation, durationSeconds: nil)
            }
        }
    }

    func stop() {
        guard isListening, recordingPurpose == .dictation else {
            emit("error", ["code": "not_listening", "message": "Dictation is not listening."])
            return
        }

        stopActiveRecording()
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

    func discard() {
        // Cancel any start still waiting on the permission prompt — the
        // graze is over, so a later grant must not open the microphone.
        dictationStartGeneration += 1
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

        emit("recording_ready", [
            "path": recordingURL.path,
            "observedAudioLevel": String(format: "%.4f", maxObservedAudioLevel),
        ])
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
        RecordingCuePlayer.play(.start)
        if purpose == .micTest {
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
        isListening = false
        isFinalizing = true
        micTestStopWorkItem?.cancel()
        micTestStopWorkItem = nil
        stopMetering()
        RecordingCuePlayer.play(.stop)
        if purpose == .dictation {
            emit("finalizing_transcript")
        }

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
        isListening = false
        isFinalizing = false
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
// Accessibility-gated work (the global shortcut monitor, synthetic paste, and
// focus tracking) now runs in the main June process so June.app — not this
// helper — is the Accessibility subject. The helper only does audio + the
// microphone permission. The shortcut/paste/AX command handlers below are never
// reached: the main process serves those itself and never forwards them here.
dictation.emitDiagnostics()

Thread.detachNewThread {
    while let line = readLine() {
        handleCommandLine(line)
    }
}

app.run()
