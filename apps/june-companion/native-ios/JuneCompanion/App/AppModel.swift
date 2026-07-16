import Foundation
import SwiftUI

enum ConnectionState: String, Codable, Sendable {
    case signedOut
    case unpaired
    case locked
    case connecting
    case ready
    case offline
    case revoked
    case error

    var title: String {
        switch self {
        case .signedOut: "Not linked"
        case .unpaired: "Not linked"
        case .locked: "Locked"
        case .connecting: "Connecting"
        case .ready: "Mac online"
        case .offline: "Mac offline"
        case .revoked: "Access revoked"
        case .error: "Unavailable"
        }
    }

    var systemImage: String {
        switch self {
        case .ready: "desktopcomputer"
        case .connecting: "arrow.triangle.2.circlepath"
        case .locked: "lock"
        case .offline: "desktopcomputer.trianglebadge.exclamationmark"
        case .revoked: "xmark.shield"
        case .signedOut: "link.badge.plus"
        case .unpaired: "link.badge.plus"
        case .error: "exclamationmark.triangle"
        }
    }
}

struct NoteSummaryModel: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let preview: String
    let revision: UInt64
    let updatedAt: String
}

struct NoteRecordModel: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var title: String
    var editedContent: String
    let revision: UInt64
    let updatedAt: String
}

struct NoteConflictModel: Codable, Equatable, Sendable {
    let expectedRevision: UInt64
    let current: NoteRecordModel
}

enum AgentStatusModel: String, Codable, Sendable {
    case idle
    case running
    case waitingForUser
    case completed
    case failed
    case cancelled
}

struct AgentSessionModel: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    var status: AgentStatusModel
    let updatedAt: String
}

struct AgentMessageModel: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let role: String
    var text: String
    let createdAt: String
    var streaming: Bool
}

struct SafeSettingsModel: Codable, Equatable, Sendable {
    var dictationStyle: String
    var imageSafeMode: Bool
}

struct DeviceModel: Codable, Equatable, Sendable {
    let deviceId: String
    let displayName: String
    let linkedAt: String
    let lastSeenAt: String?
    let revokedAt: String?
}

struct ActiveRecordingModel: Codable, Equatable, Sendable {
    let sessionId: String
    let state: String
}

struct CompanionSnapshotModel: Codable, Equatable, Sendable {
    var connection: ConnectionState
    var message: String?
    var notes: [NoteSummaryModel]
    var agentSessions: [AgentSessionModel]
    var safeSettings: SafeSettingsModel?
    var device: DeviceModel?
    var activeRecording: ActiveRecordingModel?

    static let unpaired = CompanionSnapshotModel(
        connection: .unpaired,
        notes: [],
        agentSessions: []
    )
}

struct PageModel<Item: Codable & Sendable>: Codable, Sendable {
    let items: [Item]
    let nextCursor: String?
}

enum AppSection: String, CaseIterable, Identifiable {
    case agent
    case notes
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .agent: "Agent"
        case .notes: "Notes"
        case .settings: "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .agent: "bubble.left.and.text.bubble.right"
        case .notes: "note.text"
        case .settings: "gearshape"
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var snapshot = CompanionSnapshotModel.unpaired
    @Published var selection: AppSection = .agent
    @Published var selectedNote: NoteRecordModel?
    @Published var noteConflict: NoteConflictModel?
    @Published var selectedSessionID: String?
    @Published private(set) var messages: [AgentMessageModel] = []
    @Published var draft = ""
    @Published private(set) var isWorking = false
    @Published var errorMessage: String?

    private let service: CompanionService
    private let decoder = JSONDecoder()

    init(service: CompanionService = .shared) {
        self.service = service
        service.eventSink = { [weak self] type, payload in
            Task { @MainActor in self?.receive(type: type, payload: payload) }
        }
    }

    func bootstrap() async {
        do {
            snapshot = try decode(CompanionSnapshotModel.self, from: service.snapshotJSON())
            if snapshot.connection == .ready {
                await refresh()
            }
        } catch {
            present(error)
        }
    }

    func scanAndPair() {
        perform {
            guard #available(iOS 16.0, *) else {
                throw CompanionNativeError.unavailable("QR scanning requires iOS 16 or later.")
            }
            let payload = try await QRCodeScanner.shared.scan()
            self.snapshot = try self.decode(
                CompanionSnapshotModel.self,
                from: try await self.service.pair(payloadJSON: payload)
            )
            await PushAuthorization.requestIfNeeded()
        }
    }

    func pair(pastedPayload: String) {
        perform {
            self.snapshot = try self.decode(
                CompanionSnapshotModel.self,
                from: try await self.service.pair(payloadJSON: pastedPayload)
            )
            await PushAuthorization.requestIfNeeded()
        }
    }

    func unlock() {
        perform {
            guard try await self.service.unlock() else { return }
            self.snapshot = try self.decode(
                CompanionSnapshotModel.self,
                from: try await self.service.refresh()
            )
        }
    }

    func refresh() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            snapshot = try decode(CompanionSnapshotModel.self, from: try await service.refresh())
        } catch {
            present(error)
        }
    }

    func openNote(_ summary: NoteSummaryModel) {
        perform {
            self.selectedNote = try self.decode(
                NoteRecordModel.self,
                from: try await self.service.getNote(id: summary.id)
            )
            self.noteConflict = nil
        }
    }

    func saveNote(title: String, content: String) {
        guard let note = selectedNote else { return }
        perform {
            let json = try await self.service.saveNote(
                id: note.id,
                revision: Double(note.revision),
                title: title,
                content: content
            )
            if let conflict = try? self.decode(ConflictEnvelope.self, from: json).conflict {
                self.noteConflict = conflict
            } else {
                self.selectedNote = try self.decode(NoteRecordModel.self, from: json)
                self.noteConflict = nil
                try await self.refreshSnapshot()
            }
        }
    }

    func useLatestConflict() {
        selectedNote = noteConflict?.current
        noteConflict = nil
    }

    func openAgentSession(_ session: AgentSessionModel) {
        perform {
            let page = try self.decode(
                PageModel<AgentMessageModel>.self,
                from: try await self.service.listAgentMessages(sessionID: session.id, cursor: nil)
            )
            self.selectedSessionID = session.id
            self.messages = page.items
            self.selection = .agent
        }
    }

    func startNewChat() {
        selectedSessionID = nil
        messages = []
        draft = ""
    }

    func sendMessage() {
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        draft = ""
        let optimistic = AgentMessageModel(
            id: UUID().uuidString,
            role: "user",
            text: message,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            streaming: false
        )
        messages.append(optimistic)
        perform {
            let result = try self.decode(
                AgentAccepted.self,
                from: try await self.service.sendAgentMessage(
                    sessionID: self.selectedSessionID,
                    message: message
                )
            )
            self.selectedSessionID = result.sessionId
        }
    }

    func cancelAgent() {
        guard let selectedSessionID else { return }
        perform { try await self.service.cancelAgent(sessionID: selectedSessionID) }
    }

    func updateSafeSettings(style: String, imageSafeMode: Bool) {
        perform {
            let settings = try self.decode(
                SafeSettingsModel.self,
                from: try await self.service.setSafeSettings(style: style, imageSafeMode: imageSafeMode)
            )
            self.snapshot.safeSettings = settings
        }
    }

    func controlRecording(_ action: String) {
        guard let sessionID = snapshot.activeRecording?.sessionId else { return }
        perform {
            try await self.service.controlRecording(sessionID: sessionID, action: action)
            try await self.refreshSnapshot()
        }
    }

    func focusMac() {
        let target: [String: Any]
        if let note = selectedNote {
            target = ["type": "note", "data": ["noteId": note.id]]
        } else if let selectedSessionID {
            target = ["type": "agent", "data": ["sessionId": selectedSessionID]]
        } else {
            target = ["type": "agent", "data": ["sessionId": NSNull()]]
        }
        perform {
            let data = try JSONSerialization.data(withJSONObject: target)
            guard let json = String(data: data, encoding: .utf8) else {
                throw CompanionNativeError.invalidData("The Mac target could not be encoded.")
            }
            try await self.service.focusDesktop(targetJSON: json)
        }
    }

    func revokeThisDevice() {
        perform {
            try await self.service.revokeThisDevice()
            self.snapshot = CompanionSnapshotModel(
                connection: .revoked,
                notes: [],
                agentSessions: []
            )
        }
    }

    func clearError() {
        errorMessage = nil
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        Task { @MainActor in
            defer { isWorking = false }
            do { try await operation() }
            catch { present(error) }
        }
    }

    private func refreshSnapshot() async throws {
        snapshot = try decode(
            CompanionSnapshotModel.self,
            from: try await service.refresh()
        )
    }

    private func present(_ error: Error) {
        errorMessage = error.localizedDescription.isEmpty
            ? "Something went wrong. Try again."
            : error.localizedDescription
    }

    private func receive(type: String, payload: String) {
        switch type {
        case "snapshot":
            if let value = try? decode(CompanionSnapshotModel.self, from: payload) {
                snapshot = value
            }
        case "protocolEvent":
            guard let frame = try? decode(EventFrame.self, from: payload),
                  frame.body.type == "event"
            else { return }
            apply(frame.body.data)
        default:
            break
        }
    }

    private func apply(_ event: CompanionEvent) {
        switch event.type {
        case "agentDelta":
            guard selectedSessionID == event.data?.sessionId,
                  let sessionID = event.data?.sessionId,
                  let text = event.data?.text
            else { return }
            let streamID = "stream:\(sessionID)"
            if let index = messages.firstIndex(where: { $0.id == streamID }) {
                messages[index].text += text
            } else {
                messages.append(AgentMessageModel(
                    id: streamID,
                    role: "assistant",
                    text: text,
                    createdAt: ISO8601DateFormatter().string(from: Date()),
                    streaming: true
                ))
            }
        case "agentStatus":
            guard let sessionID = event.data?.sessionId,
                  let rawStatus = event.data?.status,
                  let status = AgentStatusModel(rawValue: rawStatus)
            else { return }
            if let index = snapshot.agentSessions.firstIndex(where: { $0.id == sessionID }) {
                snapshot.agentSessions[index].status = status
            }
            if [.completed, .failed, .cancelled].contains(status),
               let index = messages.firstIndex(where: { $0.id == "stream:\(sessionID)" }) {
                messages[index].streaming = false
            }
        case "notesChanged", "resyncRequired":
            Task { await refresh() }
        case "deviceRevoked":
            snapshot = CompanionSnapshotModel(connection: .revoked, notes: [], agentSessions: [])
        default:
            break
        }
    }

    private func decode<Value: Decodable>(_ type: Value.Type, from json: String) throws -> Value {
        guard let data = json.data(using: .utf8) else {
            throw CompanionNativeError.invalidData("June returned an invalid response.")
        }
        return try decoder.decode(type, from: data)
    }
}

private struct ConflictEnvelope: Codable {
    let conflict: NoteConflictModel
}

private struct AgentAccepted: Codable {
    let sessionId: String
}

private struct EventFrame: Codable {
    let body: EventBody
}

private struct EventBody: Codable {
    let type: String
    let data: CompanionEvent
}

private struct CompanionEvent: Codable {
    let type: String
    let data: CompanionEventData?
}

private struct CompanionEventData: Codable {
    let sessionId: String?
    let text: String?
    let status: String?
}
