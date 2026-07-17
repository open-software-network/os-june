import CryptoKit
import Foundation
import UIKit

struct Snapshot: Codable {
  var connection: String
  var message: String?
  var notes: [[String: JSONValue]]
  var agentSessions: [[String: JSONValue]]
  var safeSettings: [String: JSONValue]?
  var device: [String: JSONValue]?
  var activeRecording: [String: JSONValue]?
}

private struct PendingPairingRevocation: Codable {
  let relayURL: URL
  let deviceID: UUID
}

struct PendingMutation: Codable {
  let operationID: UUID
  let createdAt: Date
}

enum MutationOperationIdentity {
  static func digest(capability: String, body: [String: Any]) throws -> String {
    let canonical = try JSONSerialization.data(
      withJSONObject: ["capability": capability, "body": body],
      options: [.sortedKeys]
    )
    return SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined()
  }

  static func operationID(
    for mutationKey: String,
    pending: inout [String: PendingMutation],
    now: Date = Date()
  ) -> UUID {
    if let existing = pending[mutationKey] { return existing.operationID }
    let operationID = UUID()
    pending[mutationKey] = PendingMutation(operationID: operationID, createdAt: now)
    return operationID
  }

  static func shouldResolve(resultType: String?, retryable: Bool) -> Bool {
    resultType != "error" || !retryable
  }
}

enum JSONValue: Codable {
  case string(String), unsignedInteger(UInt64), signedInteger(Int64), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null }
    else if let value = try? container.decode(Bool.self) { self = .bool(value) }
    else if let value = try? container.decode(UInt64.self) { self = .unsignedInteger(value) }
    else if let value = try? container.decode(Int64.self) { self = .signedInteger(value) }
    else if let value = try? container.decode(Double.self) { self = .number(value) }
    else if let value = try? container.decode(String.self) { self = .string(value) }
    else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
    else { self = .array(try container.decode([JSONValue].self)) }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .unsignedInteger(let value): try container.encode(value)
    case .signedInteger(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }
}

@MainActor
final class CompanionService {
  static let shared = CompanionService()
  var eventSink: ((String, String) -> Void)?

  private let transport = CompanionTransport()
  private let pairingAPI = PairingAPI()
  private var snapshot = Snapshot(connection: "unpaired", notes: [], agentSessions: [])
  private var linked: LinkedConfiguration?
  private var unlocked = false
  private var reconnectAttempt = 0
  private var reconnectTask: Task<Void, Never>?
  private let pendingRevocationAccount = "pending.pairing-revocation"
  private let pendingMutationsAccount = "pending.mutations"
  private var pendingMutations: [String: PendingMutation] = [:]

  private init() {
    // Pre-release builds briefly stored a mobile OS Accounts grant. Pairing is
    // now the phone's authorization, so remove any legacy token on upgrade.
    SecureStore.shared.delete(account: "os-accounts.tokens")
    pendingMutations = (try? SecureStore.shared.read(account: pendingMutationsAccount))
      .flatMap { try? JSONDecoder().decode([String: PendingMutation].self, from: $0) }
      ?? [:]
    prunePendingMutations()
    linked = try? SecureStore.shared.read(account: "linked.configuration")
      .flatMap {try? JSONDecoder().decode(LinkedConfiguration.self, from: $0)}
    if linked != nil {
      try? SecureStore.shared.migrateAccessibility(
        account: "linked.configuration",
        to: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      )
    }
    try? SecureStore.shared.migrateAccessibility(
      account: "device.credential",
      to: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    )
    snapshot = restoredSnapshot()
    NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
      Task { @MainActor in self.lock() }
    }
    NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
      Task { @MainActor in
        do { _ = try await self.reconcilePendingRevocation() }
        catch { self.presentPendingRevocationError() }
        await self.reconnectIfPossible()
      }
    }
    Task { @MainActor in
      do { _ = try await self.reconcilePendingRevocation() }
      catch { self.presentPendingRevocationError() }
    }
  }

  func snapshotJSON() throws -> String { try jsonString(snapshot) }

  func pair(payloadJSON: String) async throws -> String {
    _ = try await reconcilePendingRevocation()
    let validated = try PairingPayloadValidation.decode(payloadJSON)
    let payload = validated.payload
    let secretData = validated.secret
    var secret = [UInt8](secretData)
    defer { secret.indices.forEach {secret[$0] = 0} }
    let pairingProof = PairingProof.make(secret: secretData)
    snapshot.connection = "connecting"
    emitSnapshot()
    let identity = try DeviceIdentityService.shared.identity()
    let deviceCredential = try pairingCredential()
    var cleanupRecorded = false
    do {
      // Persist the cleanup route before the relay can activate this credential,
      // so every ambiguous network outcome remains recoverable after relaunch.
      try recordPendingRevocation(
        relayURL: payload.relayUrl,
        deviceID: identity.deviceID
      )
      cleanupRecorded = true
      _ = try await pairingAPI.propose(
        payload: payload,
        identity: identity,
        pairingProof: pairingProof,
        deviceCredentialHash: deviceCredential.hash
      )
      let approved = try await pairingAPI.waitForApproval(
        payload: payload,
        pairingProof: pairingProof
      )
      guard approved.desktopPublicKey.count == 32 else {
        throw CompanionNativeError.invalidData("The Mac identity is invalid.")
      }
      let crypto = try CompanionCryptoSession(pairingInitiator: true, localPrivate: identity.privateKey, pairingSecret: secret)
      try await transport.connect(
        relayURL: payload.relayUrl,
        deviceCredential: deviceCredential.value,
        identity: identity,
        desktopDeviceID: approved.desktopDeviceId,
        crypto: crypto,
        pairing: true,
        expectedDesktopPublicKey: approved.desktopPublicKey,
        eventHandler: handleTransportEvent
      )
      let configuration = LinkedConfiguration(
        relayURL: payload.relayUrl,
        desktopDeviceID: approved.desktopDeviceId,
        desktopPublicKey: approved.desktopPublicKey,
        linkedAt: Date()
      )
      try SecureStore.shared.save(
        JSONEncoder().encode(configuration),
        account: "linked.configuration",
        accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      )
      SecureStore.shared.delete(account: pendingRevocationAccount)
      linked = configuration
      unlocked = true
      snapshot.connection = "ready"
      cancelReconnect()
      await registerStoredPushToken()
    } catch {
      transport.disconnect()
      if cleanupRecorded {
        do {
          try await pairingAPI.revoke(
            relayURL: payload.relayUrl,
            deviceID: identity.deviceID,
            deviceCredential: deviceCredential.value
          )
          clearLocalAuthorization(connection: "unpaired")
        } catch {
          presentPendingRevocationError()
        }
      } else {
        snapshot = Snapshot(connection: "unpaired", notes: [], agentSessions: [])
        emitSnapshot()
      }
      throw error
    }
    return try await refresh()
  }

  func unlock() async throws -> Bool {
    let result = try await DeviceIdentityService.shared.unlock()
    unlocked = result
    if result { await reconnectIfPossible() }
    return result
  }

  func refresh() async throws -> String {
    if try await reconcilePendingRevocation() {
      return try snapshotJSON()
    }
    try await refreshSnapshot(allowLocked: false, connection: "ready")
    return try snapshotJSON()
  }

  private func refreshSnapshot(allowLocked: Bool, connection: String) async throws {
    try await ensureConnected(allowLocked: allowLocked)
    let notes = try await collectPages(capability: "notesRead", type: "notesList")
    let sessions = try await collectPages(capability: "agentRead", type: "agentSessionsList")
    let settings = try await request(capability: "settingsRead", body: ["type": "settingsGet"])
    let recording = try await request(capability: "recordingControlExisting", body: ["type": "recordingGetActive"])
    let device = try await request(capability: "devicesReadSelf", body: ["type": "deviceGetSelf"])
    snapshot.notes = notes
    snapshot.agentSessions = sessions
    snapshot.safeSettings = objectResult(settings)
    snapshot.activeRecording = activeRecordingResult(recording)
    snapshot.device = objectResult(device)
    snapshot.connection = connection
    try persistSnapshot()
    emitSnapshot()
  }

  func listNotes(cursor: String?) async throws -> String {
    let response = try await request(capability: "notesRead", body: ["type": "notesList", "data": ["cursor": optionalJSON(cursor), "limit": 50]])
    return try jsonString(resultData(response) ?? [:])
  }

  func getNote(id: String) async throws -> String {
    let response = try await request(capability: "notesRead", body: ["type": "noteGet", "data": ["noteId": id]])
    return try jsonString(resultData(response) ?? [:])
  }

  func saveNote(id: String, revision: UInt64, title: String, content: String) async throws -> String {
    let response = try await request(capability: "notesEdit", body: [
      "type": "noteEdit",
      "data": ["noteId": id, "expectedRevision": revision, "title": title, "editedContent": content],
    ], mutation: true)
    if resultType(response) == "conflict", let conflict = resultData(response) {
      return try jsonString(["conflict": conflict])
    }
    return try jsonString(resultData(response) ?? [:])
  }

  func listAgentSessions(cursor: String?) async throws -> String {
    let response = try await request(capability: "agentRead", body: ["type": "agentSessionsList", "data": ["cursor": optionalJSON(cursor), "limit": 50]])
    return try jsonString(resultData(response) ?? [:])
  }

  func listAgentMessages(sessionID: String, cursor: String?) async throws -> String {
    let response = try await request(capability: "agentRead", body: ["type": "agentMessagesList", "data": ["storedSessionId": sessionID, "page": ["cursor": optionalJSON(cursor), "limit": 100]]])
    return try jsonString(resultData(response) ?? [:])
  }

  func sendAgentMessage(sessionID: String?, message: String) async throws -> String {
    guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw CompanionNativeError.invalidData("Enter a message first.")
    }
    let response = try await request(capability: "agentChat", body: ["type": "agentSend", "data": ["storedSessionId": optionalJSON(sessionID), "message": message]], mutation: true)
    return try jsonString(resultData(response) ?? ["storedSessionId": sessionID ?? ""])
  }

  func cancelAgent(sessionID: String) async throws {
    _ = try await request(capability: "agentCancel", body: ["type": "agentCancel", "data": ["storedSessionId": sessionID]], mutation: true)
  }

  func setSafeSettings(style: String, imageSafeMode: Bool) async throws -> String {
    let response = try await request(capability: "settingsEditSafe", body: ["type": "settingsEditSafe", "data": ["dictationStyle": style, "imageSafeMode": imageSafeMode]], mutation: true)
    return try jsonString(resultData(response) ?? [:])
  }

  func controlRecording(sessionID: String, action: String) async throws {
    let type: String
    switch action {
    case "pause": type = "recordingPause"
    case "resume": type = "recordingResume"
    case "stop": type = "recordingStop"
    default: throw CompanionNativeError.invalidData("That recording control is not allowed.")
    }
    _ = try await request(capability: "recordingControlExisting", body: ["type": type, "data": ["sessionId": sessionID]], mutation: true)
  }

  func focusDesktop(targetJSON: String) async throws {
    guard let data = targetJSON.data(using: .utf8), let target = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw CompanionNativeError.invalidData("The focus target is invalid.")
    }
    _ = try await request(capability: "appFocus", body: ["type": "appFocus", "data": ["target": target]], mutation: true)
  }

  func revokeThisDevice() async throws {
    guard let linked else { return }
    let identity = try DeviceIdentityService.shared.identity()
    let credential = try deviceCredential()
    try recordPendingRevocation(
      relayURL: linked.relayURL,
      deviceID: identity.deviceID
    )
    // Mirror revocation in Desktop's local list, then require the
    // authoritative relay revocation to succeed before deleting local keys.
    _ = try? await request(capability: "devicesRevokeSelf", body: ["type": "deviceRevokeSelf"], mutation: true)
    try await pairingAPI.revoke(
      relayURL: linked.relayURL,
      deviceID: identity.deviceID,
      deviceCredential: credential
    )
    clearLocalAuthorization(connection: "revoked")
  }

  func registerPushToken(_ token: Data) {
    // APNs is a generic wake hint only. The token never crosses JavaScript and
    // the relay receives no note, chat, operation, or notification-body data.
    try? SecureStore.shared.save(token, account: "apns.token", accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    Task { await registerStoredPushToken() }
  }

  func handleRemoteNotification() async -> Bool {
    guard linked != nil, (try? deviceCredential()) != nil else { return false }
    let refreshTask = Task { try await refreshForRemoteNotification() }
    let timeoutTask = Task {
      do { try await Task.sleep(for: .seconds(20)) }
      catch { return }
      refreshTask.cancel()
    }
    return await withTaskCancellationHandler {
      defer {
        timeoutTask.cancel()
        refreshTask.cancel()
      }
      do {
        try await refreshTask.value
        return true
      } catch {
        if !unlocked {
          transport.disconnect()
          snapshot.connection = "locked"
          emitSnapshot()
        }
        return false
      }
    } onCancel: {
      refreshTask.cancel()
      timeoutTask.cancel()
    }
  }

  private func refreshForRemoteNotification() async throws {
    if unlocked {
      _ = try await refresh()
    } else {
      try await refreshSnapshot(allowLocked: true, connection: "locked")
      transport.disconnect()
    }
  }

  private func ensureConnected(allowLocked: Bool = false) async throws {
    guard unlocked || allowLocked else { snapshot.connection = linked == nil ? "unpaired" : "locked"; throw CompanionNativeError.unavailable("Unlock June Companion first.") }
    guard let linked else { snapshot.connection = "unpaired"; throw CompanionNativeError.unavailable("Link this device from June on your Mac.") }
    if transport.isConnected(to: linked.desktopDeviceID) { return }
    let credential = try deviceCredential()
    let identity = try DeviceIdentityService.shared.identity()
    let crypto = try CompanionCryptoSession(linkedInitiator: true, localPrivate: identity.privateKey, remotePublic: linked.desktopPublicKey)
    try await transport.connect(relayURL: linked.relayURL, deviceCredential: credential, identity: identity, desktopDeviceID: linked.desktopDeviceID, crypto: crypto, pairing: false, expectedDesktopPublicKey: linked.desktopPublicKey, eventHandler: handleTransportEvent)
  }

  private func registerStoredPushToken() async {
    guard let linked,
          let deviceToken = try? SecureStore.shared.read(account: "apns.token"),
          !deviceToken.isEmpty,
          let identity = try? DeviceIdentityService.shared.identity(),
          let credential = try? deviceCredential() else { return }
    try? await pairingAPI.registerPush(
      relayURL: linked.relayURL,
      deviceID: identity.deviceID,
      deviceToken: deviceToken,
      deviceCredential: credential
    )
  }

  private func request(
    capability: String,
    body: [String: Any],
    mutation: Bool = false
  ) async throws -> [String: Any] {
    let mutationKey = mutation
      ? try MutationOperationIdentity.digest(capability: capability, body: body)
      : nil
    let operationID: UUID
    if let mutationKey {
      operationID = self.operationID(for: mutationKey)
    } else {
      operationID = UUID()
    }
    for attempt in 0..<2 {
      let data: Data
      do {
        data = try await transport.request(
          operationID: operationID,
          capability: capability,
          body: body
        )
      } catch {
        if attempt == 0, !(error is CancellationError) {
          transport.disconnect()
          do {
            try await ensureConnected()
            continue
          } catch {
            // Report the reconnect failure below while retaining the mutation
            // operation id for a later user or lifecycle retry.
          }
        }
        snapshot.connection = "offline"
        emitSnapshot()
        throw error
      }
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw CompanionNativeError.invalidData("The Mac response was invalid.")
      }
      if resultType(object) == "error" {
        let failure = resultData(object)
        let retryable = failure?["retryable"] as? Bool == true
        if MutationOperationIdentity.shouldResolve(
          resultType: "error",
          retryable: retryable
        ), let mutationKey {
          resolveMutation(mutationKey)
        }
        let message = failure?["message"] as? String
          ?? "The Mac rejected the companion request."
        throw CompanionNativeError.unavailable(message)
      }
      if let mutationKey { resolveMutation(mutationKey) }
      return object
    }
    throw CompanionNativeError.unavailable("Your Mac is offline.")
  }

  private func operationID(for mutationKey: String) -> UUID {
    prunePendingMutations()
    let operationID = MutationOperationIdentity.operationID(
      for: mutationKey,
      pending: &pendingMutations
    )
    persistPendingMutations()
    return operationID
  }

  private func resolveMutation(_ mutationKey: String) {
    pendingMutations.removeValue(forKey: mutationKey)
    persistPendingMutations()
  }

  private func prunePendingMutations() {
    let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
    pendingMutations = pendingMutations.filter { $0.value.createdAt >= cutoff }
    persistPendingMutations()
  }

  private func persistPendingMutations() {
    guard !pendingMutations.isEmpty else {
      SecureStore.shared.delete(account: pendingMutationsAccount)
      return
    }
    if let encoded = try? JSONEncoder().encode(pendingMutations) {
      try? SecureStore.shared.save(
        encoded,
        account: pendingMutationsAccount,
        accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      )
    }
  }

  private func handleTransportEvent(_ event: [String: Any]) {
    if event["type"] as? String == "deviceRevoked" {
      clearLocalAuthorization(connection: "revoked")
    } else if event["type"] as? String == "transportError" {
      snapshot.connection = "offline"
      emitSnapshot()
      scheduleReconnect()
    } else if let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) {
      if companionEventType(event) == "deviceRevoked" {
        clearLocalAuthorization(connection: "revoked")
      }
      eventSink?("protocolEvent", json)
    }
  }

  private func companionEventType(_ event: [String: Any]) -> String? {
    (((event["body"] as? [String: Any])?["data"] as? [String: Any])?["type"] as? String)
  }

  private func clearLocalAuthorization(connection: String) {
    cancelReconnect()
    transport.disconnect()
    SecureStore.shared.delete(account: "linked.configuration")
    SecureStore.shared.delete(account: "device.credential")
    SecureStore.shared.delete(account: "cache.key")
    SecureStore.shared.delete(account: pendingRevocationAccount)
    SecureStore.shared.delete(account: pendingMutationsAccount)
    pendingMutations.removeAll()
    DeviceIdentityService.shared.delete()
    if let url = try? cacheURL() {
      try? FileManager.default.removeItem(at: url)
    }
    linked = nil
    unlocked = false
    snapshot = Snapshot(connection: connection, notes: [], agentSessions: [])
    emitSnapshot()
  }

  private func reconcilePendingRevocation() async throws -> Bool {
    guard let data = try SecureStore.shared.read(account: pendingRevocationAccount) else {
      return false
    }
    guard let pending = try? JSONDecoder().decode(PendingPairingRevocation.self, from: data) else {
      throw CompanionNativeError.invalidData("Pending pairing cleanup could not be restored.")
    }
    try await pairingAPI.revoke(
      relayURL: pending.relayURL,
      deviceID: pending.deviceID,
      deviceCredential: try deviceCredential()
    )
    clearLocalAuthorization(connection: "unpaired")
    return true
  }

  private func recordPendingRevocation(relayURL: URL, deviceID: UUID) throws {
    try SecureStore.shared.save(
      JSONEncoder().encode(
        PendingPairingRevocation(relayURL: relayURL, deviceID: deviceID)
      ),
      account: pendingRevocationAccount,
      accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    )
  }

  private func presentPendingRevocationError() {
    snapshot.connection = "error"
    snapshot.message = "Pairing cleanup could not be confirmed. Keep June Companion installed and try again when online."
    emitSnapshot()
  }

  private func reconnectIfPossible() async {
    guard linked != nil, (try? deviceCredential()) != nil, unlocked else { return }
    do { _ = try await refresh(); cancelReconnect() }
    catch { scheduleReconnect() }
  }

  private func scheduleReconnect() {
    reconnectTask?.cancel()
    reconnectAttempt = min(reconnectAttempt + 1, 8)
    let cap = min(pow(2, Double(reconnectAttempt)), 60)
    let delay = Double.random(in: 0...cap)
    reconnectTask = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(delay)) }
      catch { return }
      guard !Task.isCancelled, let self else { return }
      self.reconnectTask = nil
      await self.reconnectIfPossible()
    }
  }

  private func cancelReconnect() {
    reconnectTask?.cancel()
    reconnectTask = nil
    reconnectAttempt = 0
  }

  private func lock() {
    cancelReconnect()
    unlocked = false
    if linked != nil { snapshot.connection = "locked" }
    transport.disconnect()
    emitSnapshot()
  }

  private func emitSnapshot() {
    if let value = try? snapshotJSON() { eventSink?("snapshot", value) }
  }

  private func pageItems(_ response: [String: Any]) -> [[String: JSONValue]] {
    guard let data = resultData(response), let items = data["items"] as? [[String: Any]] else { return [] }
    return items.compactMap { try? JSONDecoder().decode([String: JSONValue].self, from: JSONSerialization.data(withJSONObject: $0)) }
  }

  /// Refreshes enough bounded pages for useful offline browsing and local
  /// search without allowing a corrupt or cyclic cursor to loop forever.
  private func collectPages(
    capability: String,
    type: String,
    pageLimit: Int = 50,
    maximumPages: Int = 20
  ) async throws -> [[String: JSONValue]] {
    var items: [[String: JSONValue]] = []
    var cursor: String?
    var seenCursors = Set<String>()

    for _ in 0..<maximumPages {
      let response = try await request(
        capability: capability,
        body: ["type": type, "data": ["cursor": optionalJSON(cursor), "limit": pageLimit]]
      )
      items.append(contentsOf: pageItems(response))
      guard let nextCursor = resultData(response)?["nextCursor"] as? String,
            !nextCursor.isEmpty,
            seenCursors.insert(nextCursor).inserted else {
        break
      }
      cursor = nextCursor
    }
    return items
  }

  private func objectResult(_ response: [String: Any]) -> [String: JSONValue]? {
    guard let data = resultData(response) else { return nil }
    return try? JSONDecoder().decode([String: JSONValue].self, from: JSONSerialization.data(withJSONObject: data))
  }

  private func activeRecordingResult(_ response: [String: Any]) -> [String: JSONValue]? {
    guard let active = resultData(response)?["active"] as? [String: Any] else { return nil }
    return try? JSONDecoder().decode(
      [String: JSONValue].self,
      from: JSONSerialization.data(withJSONObject: active)
    )
  }

  private func resultType(_ response: [String: Any]) -> String? {
    (((response["body"] as? [String: Any])?["data"] as? [String: Any])?["result"] as? [String: Any])?["type"] as? String
  }

  private func resultData(_ response: [String: Any]) -> [String: Any]? {
    (((response["body"] as? [String: Any])?["data"] as? [String: Any])?["result"] as? [String: Any])?["data"] as? [String: Any]
  }

  private func persistSnapshot() throws {
    let plaintext = try JSONEncoder().encode(snapshot)
    let key: SymmetricKey
    if let stored = try SecureStore.shared.read(account: "cache.key") {
      try SecureStore.shared.migrateAccessibility(
        account: "cache.key",
        to: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      )
      key = SymmetricKey(data: stored)
    }
    else {
      let data = Data((0..<32).map {_ in UInt8.random(in: .min ... .max)})
      try SecureStore.shared.save(
        data,
        account: "cache.key",
        accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      )
      key = SymmetricKey(data: data)
    }
    let sealed = try AES.GCM.seal(plaintext, using: key).combined!
    let url = try cacheURL()
    try sealed.write(
      to: url,
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    )
  }

  private func restoredSnapshot() -> Snapshot {
    guard linked != nil, (try? deviceCredential()) != nil else {
      return Snapshot(connection: "unpaired", notes: [], agentSessions: [])
    }
    guard let data = try? Data(contentsOf: cacheURL()),
          let keyData = try? SecureStore.shared.read(account: "cache.key"),
          let box = try? AES.GCM.SealedBox(combined: data),
          let plaintext = try? AES.GCM.open(box, using: SymmetricKey(data: keyData)),
          var cached = try? JSONDecoder().decode(Snapshot.self, from: plaintext) else {
      return Snapshot(connection: "locked", notes: [], agentSessions: [])
    }
    cached.connection = "locked"
    return cached
  }

  private func cacheURL() throws -> URL {
    let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return directory.appendingPathComponent("companion-cache.bin", isDirectory: false)
  }

  private func deviceCredential() throws -> String {
    guard let data = try SecureStore.shared.read(account: "device.credential"),
          let credential = String(data: data, encoding: .utf8),
          !credential.isEmpty else {
      throw CompanionNativeError.unavailable("Link this device from June on your Mac.")
    }
    try SecureStore.shared.migrateAccessibility(
      account: "device.credential",
      to: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    )
    return credential
  }

  private func pairingCredential() throws -> DeviceCredential {
    if let stored = try SecureStore.shared.read(account: "device.credential"),
       let value = String(data: stored, encoding: .utf8),
       let bytes = Data(base64URL: value),
       bytes.count == 32 {
      try SecureStore.shared.migrateAccessibility(
        account: "device.credential",
        to: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      )
      return DeviceCredential(
        value: value,
        hash: DeviceCredential.hash(value: value)
      )
    }
    let credential = try DeviceCredential.generate()
    try SecureStore.shared.save(
      Data(credential.value.utf8),
      account: "device.credential",
      accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    )
    return credential
  }

  private func optionalJSON(_ value: String?) -> Any {
    guard let value else { return NSNull() }
    return value
  }

  private func jsonString(_ value: Any) throws -> String {
    let data: Data
    if JSONSerialization.isValidJSONObject(value) { data = try JSONSerialization.data(withJSONObject: value) }
    else { data = try JSONEncoder().encode(value as! Snapshot) }
    guard let string = String(data: data, encoding: .utf8) else { throw CompanionNativeError.invalidData("Native data could not be encoded.") }
    return string
  }

  private func jsonString<T: Encodable>(_ value: T) throws -> String {
    let data = try JSONEncoder().encode(value)
    guard let string = String(data: data, encoding: .utf8) else { throw CompanionNativeError.invalidData("Native data could not be encoded.") }
    return string
  }
}

extension Data {
  init?(base64URL value: String) {
    var value = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    value += String(repeating: "=", count: (4 - value.count % 4) % 4)
    self.init(base64Encoded: value)
  }
}
