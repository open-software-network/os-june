import AVFoundation
import AppKit
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

extension String: @retroactive Error {}

extension String: @retroactive LocalizedError {
    public var errorDescription: String? { self }
}

extension AudioObjectID {
    static let system = AudioObjectID(kAudioObjectSystemObject)
    static let unknown = kAudioObjectUnknown
    var isValid: Bool { self != .unknown }

    static func readDefaultSystemOutputDevice() throws -> AudioDeviceID {
        try AudioObjectID.system.read(kAudioHardwarePropertyDefaultSystemOutputDevice, defaultValue: AudioDeviceID.unknown)
    }

    static func readAudioDevices() throws -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        var err = AudioObjectGetPropertyDataSize(AudioObjectID.system, &address, 0, nil, &dataSize)
        guard err == noErr else { throw "Error reading audio device list size: \(err)" }
        let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        guard count > 0 else { return [] }
        var devices = Array(repeating: AudioDeviceID.unknown, count: count)
        err = devices.withUnsafeMutableBufferPointer { pointer in
            AudioObjectGetPropertyData(AudioObjectID.system, &address, 0, nil, &dataSize, pointer.baseAddress!)
        }
        guard err == noErr else { throw "Error reading audio device list: \(err)" }
        return devices.filter { $0 != AudioDeviceID.unknown }
    }

    func readDeviceUID() throws -> String {
        try readString(kAudioDevicePropertyDeviceUID)
    }

    func readName() throws -> String {
        try readString(kAudioObjectPropertyName)
    }

    func readAudioTapStreamBasicDescription() throws -> AudioStreamBasicDescription {
        try read(kAudioTapPropertyFormat, defaultValue: AudioStreamBasicDescription())
    }

    func readString(_ selector: AudioObjectPropertySelector) throws -> String {
        try read(AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain), defaultValue: "" as CFString) as String
    }

    func read<T>(_ selector: AudioObjectPropertySelector, defaultValue: T) throws -> T {
        try read(AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain), defaultValue: defaultValue)
    }

    func read<T>(_ address: AudioObjectPropertyAddress, defaultValue: T) throws -> T {
        var address = address
        var dataSize: UInt32 = 0
        var err = AudioObjectGetPropertyDataSize(self, &address, 0, nil, &dataSize)
        guard err == noErr else { throw "Error reading data size for audio property: \(err)" }

        var value = defaultValue
        err = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, pointer)
        }
        guard err == noErr else { throw "Error reading audio property: \(err)" }
        return value
    }
}

final class SystemAudioRecorder {
    private let outputURL: URL?
    private let statusURL: URL?
    private let pidURL: URL?
    private let logURL: URL?
    private let timelineOffset: TimeInterval
    private let pauseLock = NSLock()

    private var processTapID = AudioObjectID.unknown
    private var aggregateDeviceID = AudioObjectID.unknown
    private var deviceProcID: AudioDeviceIOProcID?
    private var audioFile: AVAudioFile?
    private var audioConverter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var inputStreamDescription: AudioStreamBasicDescription?
    private var outputFormat: AVAudioFormat?
    private var didStop = false
    private var isPaused = false
    private var activeStartedAt: Date?
    private var pausedAt: Date?
    private var accumulatedPausedDuration: TimeInterval = 0
    private var outputFramesWritten: AVAudioFramePosition = 0
    private var lastLevelEmit = Date.distantPast
    private var maxLevel: Double = 0

    init(outputURL: URL?, statusURL: URL?, pidURL: URL?, logURL: URL?, timelineOffset: TimeInterval) {
        self.outputURL = outputURL
        self.statusURL = statusURL
        self.pidURL = pidURL
        self.logURL = logURL
        self.timelineOffset = timelineOffset
    }

    func writePid() {
        guard let pidURL else { return }
        try? "\(getpid())".write(to: pidURL, atomically: true, encoding: .utf8)
        log("wrote pid \(getpid()) to \(pidURL.path)")
    }

    func pause() {
        pauseLock.lock()
        if !isPaused {
            pausedAt = Date()
        }
        isPaused = true
        pauseLock.unlock()
        emit(["event": "paused"])
    }

    func resume() {
        pauseLock.lock()
        if let pausedAt {
            accumulatedPausedDuration += Date().timeIntervalSince(pausedAt)
        }
        pausedAt = nil
        isPaused = false
        pauseLock.unlock()
        emit(["event": "resumed"])
    }

    func start(checkOnly: Bool = false) throws {
        log("starting; output=\(outputURL?.path ?? "check") status=\(statusURL?.path ?? "none")")
        try ensureSystemAudioPermission(logURL: logURL)
        if let outputURL {
            try? FileManager.default.removeItem(at: outputURL)
            try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        }
        cleanupStaleAggregateDevices(named: "OS Notetaker System Audio")

        let systemOutputID = try AudioObjectID.readDefaultSystemOutputDevice()
        let outputUID = try systemOutputID.readDeviceUID()
        log("default output device id=\(systemOutputID) uid=\(outputUID)")

        let tapDescription = CATapDescription(excludingProcesses: [], deviceUID: outputUID, stream: 0)
        tapDescription.uuid = UUID()
        tapDescription.muteBehavior = .unmuted
        tapDescription.name = "OS Notetaker System Audio"

        var tapID = AudioObjectID.unknown
        var err = AudioHardwareCreateProcessTap(tapDescription, &tapID)
        guard err == noErr else {
            log("AudioHardwareCreateProcessTap failed err=\(err)")
            throw "System audio permission or tap creation failed with error \(err)"
        }
        log("created process tap id=\(tapID)")
        processTapID = tapID

        var streamDescription = try tapID.readAudioTapStreamBasicDescription()
        log("tap format sampleRate=\(streamDescription.mSampleRate) formatID=\(streamDescription.mFormatID) flags=\(streamDescription.mFormatFlags) bytesPerPacket=\(streamDescription.mBytesPerPacket) framesPerPacket=\(streamDescription.mFramesPerPacket) bytesPerFrame=\(streamDescription.mBytesPerFrame) channelsPerFrame=\(streamDescription.mChannelsPerFrame) bitsPerChannel=\(streamDescription.mBitsPerChannel)")
        let inputFormat = AVAudioFormat(streamDescription: &streamDescription)
        guard inputFormat != nil || canManuallyDownmix(streamDescription) else {
            throw "Failed to create audio format for system tap."
        }
        let outputChannelCount = min(max(streamDescription.mChannelsPerFrame, 1), 2)
        guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: streamDescription.mSampleRate, channels: outputChannelCount, interleaved: true) else {
            throw "Failed to create output audio format."
        }
        let converter: AVAudioConverter?
        if let inputFormat {
            guard let formatConverter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
                throw "Failed to create audio converter."
            }
            converter = formatConverter
        } else {
            log("using manual system tap downmix for \(streamDescription.mChannelsPerFrame)-channel input")
            converter = nil
        }

        let aggregateUID = UUID().uuidString
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OS Notetaker System Audio",
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [
                [kAudioSubDeviceUIDKey: outputUID]
            ],
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: tapDescription.uuid.uuidString
                ]
            ]
        ]

        err = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateDeviceID)
        guard err == noErr else {
            log("AudioHardwareCreateAggregateDevice failed err=\(err)")
            throw "Failed to create aggregate audio device: \(err)"
        }
        log("created aggregate device id=\(aggregateDeviceID)")
        try waitForAggregateDeviceReady(aggregateDeviceID)

        if checkOnly {
            emit(["event": "ready", "message": "System audio capture is authorized."])
            return
        }

        self.inputFormat = inputFormat
        inputStreamDescription = streamDescription
        self.outputFormat = outputFormat
        audioConverter = converter
        activeStartedAt = Date().addingTimeInterval(-timelineOffset)
        accumulatedPausedDuration = 0
        pausedAt = nil
        outputFramesWritten = 0
        if let outputURL {
            audioFile = try AVAudioFile(forWriting: outputURL, settings: outputFormat.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        }

        log("creating IO callback")
        err = AudioDeviceCreateIOProcID(
            aggregateDeviceID,
            systemAudioIOProc,
            Unmanaged.passUnretained(self).toOpaque(),
            &deviceProcID
        )
        guard err == noErr else {
            log("AudioDeviceCreateIOProcID failed err=\(err)")
            throw "Failed to create audio IO callback: \(err)"
        }
        log("created IO callback")

        err = AudioDeviceStart(aggregateDeviceID, deviceProcID)
        guard err == noErr else {
            log("AudioDeviceStart failed err=\(err)")
            throw "Failed to start system audio capture: \(err)"
        }
        log("audio device started")

        emit(["event": "ready", "output": outputURL?.path ?? "check"])
    }

    func stop(emitStopped: Bool = true) {
        guard !didStop else { return }
        didStop = true
        if aggregateDeviceID.isValid {
            AudioDeviceStop(aggregateDeviceID, deviceProcID)
            if let deviceProcID {
                AudioDeviceDestroyIOProcID(aggregateDeviceID, deviceProcID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
        }
        if processTapID.isValid {
            AudioHardwareDestroyProcessTap(processTapID)
        }
        audioFile = nil
        audioConverter = nil
        inputFormat = nil
        inputStreamDescription = nil
        outputFormat = nil
        log("stopped maxLevel=\(maxLevel)")
        if emitStopped {
            emit(["event": "stopped", "output": outputURL?.path ?? "check", "maxLevel": String(maxLevel)])
        }
    }

    private func emitLevel(from buffer: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelEmit) >= 0.08 else { return }
        lastLevelEmit = now
        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameLength > 0, channelCount > 0, let channels = buffer.floatChannelData else {
            emit(["event": "level", "level": "0"])
            return
        }
        var sum: Float = 0
        var count = 0
        for channelIndex in 0..<channelCount {
            let channel = channels[channelIndex]
            for frameIndex in 0..<frameLength {
                let sample = channel[frameIndex]
                sum += sample * sample
                count += 1
            }
        }
        let rms = count > 0 ? sqrt(sum / Float(count)) : 0
        let level = min(1, Double(rms) * 4)
        maxLevel = max(maxLevel, level)
        emit(["event": "level", "level": String(level), "maxLevel": String(maxLevel)])
    }

    private func emitLevel(fromInt16Buffer buffer: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelEmit) >= 0.08 else { return }
        lastLevelEmit = now
        let audioBuffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard let firstBuffer = audioBuffers.first,
              let data = firstBuffer.mData,
              firstBuffer.mDataByteSize > 0
        else {
            emit(["event": "level", "level": "0"])
            return
        }
        let sampleCount = Int(firstBuffer.mDataByteSize) / MemoryLayout<Int16>.size
        let samples = data.bindMemory(to: Int16.self, capacity: sampleCount)
        var sum: Double = 0
        for index in 0..<sampleCount {
            let sample = Double(samples[index]) / Double(Int16.max)
            sum += sample * sample
        }
        let rms = sampleCount > 0 ? sqrt(sum / Double(sampleCount)) : 0
        let level = min(1, rms * 4)
        maxLevel = max(maxLevel, level)
        emit(["event": "level", "level": String(level), "maxLevel": String(maxLevel)])
    }

    private func emit(_ object: [String: String]) {
        let data = try! JSONSerialization.data(withJSONObject: object)
        print(String(data: data, encoding: .utf8)!)
        fflush(stdout)
        guard let statusURL else { return }
        try? data.write(to: statusURL)
    }

    private func log(_ message: String) {
        writeLog(message, logURL: logURL)
    }

    fileprivate func handleInputData(_ inputData: UnsafePointer<AudioBufferList>) {
        pauseLock.lock()
        let paused = isPaused
        pauseLock.unlock()
        guard !paused else { return }
        do {
            let convertedBuffer: AVAudioPCMBuffer?
            if let inputFormat, let outputFormat, let converter = audioConverter {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, bufferListNoCopy: inputData, deallocator: nil) else { return }
                emitLevel(from: buffer)
                let frameCapacity = max(1, AVAudioFrameCount(Double(buffer.frameLength) * outputFormat.sampleRate / inputFormat.sampleRate))
                guard let bufferForOutput = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCapacity) else { return }
                var didProvideInput = false
                var conversionError: NSError?
                let status = converter.convert(to: bufferForOutput, error: &conversionError) { _, inputStatus in
                    if didProvideInput {
                        inputStatus.pointee = .noDataNow
                        return nil
                    }
                    didProvideInput = true
                    inputStatus.pointee = .haveData
                    return buffer
                }
                if let conversionError { throw conversionError }
                convertedBuffer = status == .haveData || status == .inputRanDry ? bufferForOutput : nil
            } else {
                guard let outputFormat, let inputStreamDescription else { return }
                convertedBuffer = try manuallyDownmix(inputData, inputDescription: inputStreamDescription, outputFormat: outputFormat)
            }
            if let convertedBuffer, convertedBuffer.frameLength > 0, let audioFile, let outputFormat {
                emitLevel(fromInt16Buffer: convertedBuffer)
                try writeTimelineSilenceIfNeeded(beforeWriting: convertedBuffer.frameLength, to: audioFile, format: outputFormat)
                try audioFile.write(from: convertedBuffer)
                outputFramesWritten += AVAudioFramePosition(convertedBuffer.frameLength)
            }
        } catch {
            emit(["event": "error", "message": describeError(error)])
        }
    }

    private func manuallyDownmix(
        _ inputData: UnsafePointer<AudioBufferList>,
        inputDescription: AudioStreamBasicDescription,
        outputFormat: AVAudioFormat
    ) throws -> AVAudioPCMBuffer? {
        guard canManuallyDownmix(inputDescription) else { return nil }
        let inputChannels = Int(inputDescription.mChannelsPerFrame)
        let bytesPerSample = Int(inputDescription.mBitsPerChannel / 8)
        guard inputChannels > 0, bytesPerSample > 0 else { return nil }
        let inputBuffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        guard let firstInputBuffer = inputBuffers.first,
              let inputPointer = firstInputBuffer.mData
        else {
            return nil
        }

        let interleaved = inputDescription.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
        let frameCount: Int
        if interleaved {
            guard inputDescription.mBytesPerFrame > 0 else { return nil }
            frameCount = Int(firstInputBuffer.mDataByteSize) / Int(inputDescription.mBytesPerFrame)
        } else {
            frameCount = Int(firstInputBuffer.mDataByteSize) / bytesPerSample
        }
        guard frameCount > 0 else { return nil }

        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(frameCount)) else {
            return nil
        }
        outputBuffer.frameLength = AVAudioFrameCount(frameCount)
        let outputBuffers = UnsafeMutableAudioBufferListPointer(outputBuffer.mutableAudioBufferList)
        guard let firstOutputBuffer = outputBuffers.first,
              let outputPointer = firstOutputBuffer.mData
        else {
            return nil
        }

        let inputSamples = inputPointer.bindMemory(to: Float.self, capacity: frameCount * inputChannels)
        let outputChannels = Int(outputFormat.channelCount)
        let outputSamples = outputPointer.bindMemory(to: Int16.self, capacity: frameCount * outputChannels)

        for frameIndex in 0..<frameCount {
            let left = interleaved ? inputSamples[frameIndex * inputChannels] : inputSamples[frameIndex]
            let right: Float
            if inputChannels > 1 {
                if interleaved {
                    right = inputSamples[frameIndex * inputChannels + 1]
                } else if inputBuffers.count > 1, let rightPointer = inputBuffers[1].mData {
                    right = rightPointer.bindMemory(to: Float.self, capacity: frameCount)[frameIndex]
                } else {
                    right = left
                }
            } else {
                right = left
            }
            outputSamples[frameIndex * outputChannels] = int16Sample(left)
            if outputChannels > 1 {
                outputSamples[frameIndex * outputChannels + 1] = int16Sample(right)
            }
        }

        return outputBuffer
    }

    private func writeTimelineSilenceIfNeeded(beforeWriting incomingFrames: AVAudioFrameCount, to audioFile: AVAudioFile, format: AVAudioFormat) throws {
        guard let activeStartedAt else { return }
        pauseLock.lock()
        let activePauseDuration = isPaused ? pausedAt.map { Date().timeIntervalSince($0) } ?? 0 : 0
        let pausedOffset = accumulatedPausedDuration + activePauseDuration
        pauseLock.unlock()
        let activeElapsed = max(0, Date().timeIntervalSince(activeStartedAt) - pausedOffset)
        let expectedFrames = AVAudioFramePosition(activeElapsed * format.sampleRate)
        var missingFrames = expectedFrames - outputFramesWritten - AVAudioFramePosition(incomingFrames)
        let toleranceFrames = AVAudioFramePosition(format.sampleRate * 0.08)
        guard missingFrames > toleranceFrames else { return }
        while missingFrames > 0 {
            let chunkFrames = AVAudioFrameCount(min(missingFrames, AVAudioFramePosition(format.sampleRate / 2)))
            guard let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { return }
            silence.frameLength = chunkFrames
            zeroAudioBuffer(silence)
            try audioFile.write(from: silence)
            outputFramesWritten += AVAudioFramePosition(chunkFrames)
            missingFrames -= AVAudioFramePosition(chunkFrames)
        }
    }

    private func zeroAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        let audioBuffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        for audioBuffer in audioBuffers {
            guard let data = audioBuffer.mData else { continue }
            memset(data, 0, Int(audioBuffer.mDataByteSize))
        }
    }

    private func cleanupStaleAggregateDevices(named targetName: String) {
        do {
            for device in try AudioObjectID.readAudioDevices() {
                guard (try? AudioObjectID(device).readName()) == targetName else { continue }
                let err = AudioHardwareDestroyAggregateDevice(device)
                log("destroy stale aggregate device id=\(device) err=\(err)")
            }
        } catch {
            log("stale aggregate cleanup failed: \(describeError(error))")
        }
    }

    private func waitForAggregateDeviceReady(_ deviceID: AudioObjectID) throws {
        let deadline = Date().addingTimeInterval(3)
        var lastError: Error?
        while Date() < deadline {
            do {
                _ = try deviceID.readName()
                log("aggregate device is readable")
                return
            } catch {
                lastError = error
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        throw "Aggregate audio device was not readable after creation: \(lastError.map(describeError) ?? "unknown error")"
    }
}

private func canManuallyDownmix(_ description: AudioStreamBasicDescription) -> Bool {
    description.mFormatID == kAudioFormatLinearPCM &&
        description.mSampleRate > 0 &&
        description.mChannelsPerFrame > 0 &&
        description.mBitsPerChannel == 32 &&
        description.mFormatFlags & kAudioFormatFlagIsFloat != 0
}

private func int16Sample(_ sample: Float) -> Int16 {
    let clamped = max(-1, min(1, sample))
    if clamped >= 0 {
        return Int16(clamped * Float(Int16.max))
    }
    return Int16(clamped * 32768)
}

private let systemAudioIOProc: AudioDeviceIOProc = { _, _, inputData, _, _, _, clientData in
    guard let clientData else { return noErr }
    let recorder = Unmanaged<SystemAudioRecorder>.fromOpaque(clientData).takeUnretainedValue()
    recorder.handleInputData(inputData)
    return noErr
}

private enum SystemAudioPermissionStatus {
    case authorized
    case denied
    case unknown
}

private typealias TCCPreflightFunction = @convention(c) (CFString, CFDictionary?) -> Int32
private typealias TCCRequestFunction = @convention(c) (CFString, CFDictionary?, @escaping (Bool) -> Void) -> Void

private func ensureSystemAudioPermission(logURL: URL?) throws {
    guard let preflight = loadTCCFunction("TCCAccessPreflight", as: TCCPreflightFunction.self, logURL: logURL) else {
        writeLog("TCC preflight SPI is unavailable; continuing with CoreAudio permission behavior", logURL: logURL)
        return
    }

    let status = systemAudioPermissionStatus(preflight("kTCCServiceAudioCapture" as CFString, nil))
    writeLog("system audio permission preflight status=\(status)", logURL: logURL)
    switch status {
    case .authorized:
        return
    case .denied:
        throw "System Audio Recording permission is denied. Enable OS Notetaker Audio Capture in System Settings > Privacy & Security > Screen & System Audio Recording."
    case .unknown:
        break
    }

    guard let request = loadTCCFunction("TCCAccessRequest", as: TCCRequestFunction.self, logURL: logURL) else {
        throw "System Audio Recording permission has not been granted, and macOS did not expose a permission request API."
    }

    writeLog("requesting system audio permission", logURL: logURL)
    NSApplication.shared.setActivationPolicy(.accessory)
    NSApplication.shared.finishLaunching()
    NSApplication.shared.activate(ignoringOtherApps: true)
    var granted = false
    var completed = false
    request("kTCCServiceAudioCapture" as CFString, nil) { allowed in
        granted = allowed
        completed = true
    }

    let deadline = Date().addingTimeInterval(60)
    while !completed && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }

    if !completed {
        throw "Timed out waiting for System Audio Recording permission. Check the macOS permission prompt and try again."
    }
    writeLog("system audio permission request granted=\(granted)", logURL: logURL)
    guard granted else {
        throw "System Audio Recording permission was not granted. Enable OS Notetaker Audio Capture in System Settings > Privacy & Security > Screen & System Audio Recording."
    }
}

private func systemAudioPermissionStatus(_ rawStatus: Int32) -> SystemAudioPermissionStatus {
    if rawStatus == 0 { return .authorized }
    if rawStatus == 1 { return .denied }
    return .unknown
}

private func describeError(_ error: Error) -> String {
    if let message = error as? String {
        return message
    }
    return error.localizedDescription
}

private func loadTCCFunction<T>(_ name: String, as type: T.Type, logURL: URL?) -> T? {
    let tccPath = "/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC"
    guard let handle = dlopen(tccPath, RTLD_NOW) else {
        writeLog("dlopen TCC failed for \(name)", logURL: logURL)
        return nil
    }
    guard let symbol = dlsym(handle, name) else {
        writeLog("dlsym TCC failed for \(name)", logURL: logURL)
        return nil
    }
    return unsafeBitCast(symbol, to: type)
}

func argumentValue(_ name: String, from arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

func emitProcessStatus(_ object: [String: String], statusPath: String?) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
    guard let statusPath else { return }
    try? data.write(to: URL(fileURLWithPath: statusPath))
}

let statusPath = argumentValue("--status", from: CommandLine.arguments)
let logPath = argumentValue("--log", from: CommandLine.arguments)

func writeLog(_ message: String, logURL: URL?) {
    guard let logURL else { return }
    let line = "\(Date()) pid=\(getpid()) \(message)\n"
    if FileManager.default.fileExists(atPath: logURL.path), let handle = try? FileHandle(forWritingTo: logURL) {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(line.utf8))
    } else {
        try? line.write(to: logURL, atomically: true, encoding: .utf8)
    }
}

writeLog("launched args=\(CommandLine.arguments.joined(separator: " "))", logURL: logPath.map { URL(fileURLWithPath: $0) })

guard #available(macOS 14.2, *) else {
    writeLog("unsupported macOS version", logURL: logPath.map { URL(fileURLWithPath: $0) })
    emitProcessStatus(["event": "error", "message": "System audio recording requires macOS 14.2 or later."], statusPath: statusPath)
    exit(2)
}

let checkOnly = CommandLine.arguments.contains("--check")
let outputPath = argumentValue("--output", from: CommandLine.arguments)
let pidPath = argumentValue("--pid", from: CommandLine.arguments)
let timelineOffsetMs = argumentValue("--timeline-offset-ms", from: CommandLine.arguments).flatMap(Double.init) ?? 0
if !checkOnly && outputPath == nil {
    writeLog("missing output argument", logURL: logPath.map { URL(fileURLWithPath: $0) })
    emitProcessStatus(["event": "error", "message": "Usage: os-notetaker-system-audio-recorder --output /path/to/recording.wav"], statusPath: statusPath)
    exit(2)
}

let helperLogURL = logPath.map { URL(fileURLWithPath: $0) }
let recorder = SystemAudioRecorder(
    outputURL: outputPath.map { URL(fileURLWithPath: $0) },
    statusURL: statusPath.map { URL(fileURLWithPath: $0) },
    pidURL: pidPath.map { URL(fileURLWithPath: $0) },
    logURL: helperLogURL,
    timelineOffset: max(0, timelineOffsetMs) / 1000
)
recorder.writePid()

let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let pauseSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
let resumeSource = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
signal(SIGUSR1, SIG_IGN)
signal(SIGUSR2, SIG_IGN)

terminateSource.setEventHandler {
    recorder.stop()
    exit(0)
}
interruptSource.setEventHandler {
    recorder.stop()
    exit(0)
}
pauseSource.setEventHandler {
    recorder.pause()
}
resumeSource.setEventHandler {
    recorder.resume()
}
terminateSource.resume()
interruptSource.resume()
pauseSource.resume()
resumeSource.resume()

do {
    try recorder.start(checkOnly: checkOnly)
    if checkOnly {
        recorder.stop(emitStopped: false)
        exit(0)
    }
} catch {
    let message = describeError(error)
    writeLog("start failed: \(message)", logURL: helperLogURL)
    emitProcessStatus(["event": "error", "message": message], statusPath: statusPath)
    exit(1)
}

dispatchMain()
