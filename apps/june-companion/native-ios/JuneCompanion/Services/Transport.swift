import AVFoundation
import CryptoKit
import Foundation
import Network
import Security
import UIKit
import VisionKit

struct PairingPayload: Codable {
  let version: UInt16
  let pairingId: UUID
  let pairingSecret: String
  let relayUrl: URL
  let expiresAtMs: UInt64
}

enum PairingProof {
  static func make(secret: Data) -> [UInt8] {
    Array(SHA256.hash(data: secret))
  }
}

struct DeviceCredential {
  let value: String
  let hash: [UInt8]

  static func generate() throws -> DeviceCredential {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw CompanionNativeError.unavailable("A device credential could not be generated.")
    }
    defer { bytes.indices.forEach { bytes[$0] = 0 } }
    let data = Data(bytes)
    let value = data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    return DeviceCredential(value: value, hash: Array(SHA256.hash(data: data)))
  }
}

struct PairingStatusWire: Codable {
  let pairingId: UUID
  let expiresAtMs: UInt64
  let state: String
  let desktopDeviceId: UUID
  let desktopPublicKey: [UInt8]
  let mobileDeviceId: UUID?
  let mobilePublicKey: [UInt8]?
  let mobileDisplayName: String?
}

struct LinkedConfiguration: Codable {
  let relayURL: URL
  let desktopDeviceID: UUID
  let desktopPublicKey: [UInt8]
  let linkedAt: Date
}

private struct RelayEnvelope: Codable {
  let version: UInt16
  let senderDeviceId: UUID
  let recipientDeviceId: UUID
  let messageId: UUID
  let createdAtMs: UInt64
  let ciphertext: Data
}

private struct APIEnvelope<T: Decodable>: Decodable {
  let data: T?
  let success: Bool
  let message: String?
}

struct ValidatedInboundFrame {
  let operationID: UUID
  let sequence: UInt64
  let capability: String
  let bodyType: String
}

private struct InboundFrameHeader: Decodable {
  let version: UInt16
  let operationId: UUID
  let sequence: UInt64
  let issuedAtMs: UInt64
  let expiresAtMs: UInt64
  let capability: String
  let body: InboundBodyHeader
}

private struct InboundBodyHeader: Decodable {
  let type: String
  let data: InboundBodyDataHeader?
}

private struct InboundBodyDataHeader: Decodable {
  let capability: String?
  let type: String?
}

enum CompanionWireValidation {
  static func frame(
    _ data: Data,
    after lastSequence: UInt64,
    now: UInt64 = currentMilliseconds()
  ) throws -> ValidatedInboundFrame {
    let frame = try JSONDecoder().decode(InboundFrameHeader.self, from: data)
    guard frame.version == 1,
          frame.sequence > lastSequence,
          frame.expiresAtMs >= frame.issuedAtMs,
          frame.expiresAtMs - frame.issuedAtMs <= 30_000,
          frame.issuedAtMs <= now + 30_000,
          now <= frame.expiresAtMs else {
      throw CompanionNativeError.invalidData("The encrypted companion frame expired or failed validation.")
    }
    let requiredCapability: String?
    switch frame.body.type {
    case "response":
      requiredCapability = frame.body.data?.capability
    case "event":
      requiredCapability = eventCapability(frame.body.data?.type)
    default:
      requiredCapability = nil
    }
    guard requiredCapability == frame.capability else {
      throw CompanionNativeError.invalidData("The encrypted companion frame used an invalid capability.")
    }
    return ValidatedInboundFrame(
      operationID: frame.operationId,
      sequence: frame.sequence,
      capability: frame.capability,
      bodyType: frame.body.type
    )
  }

  private static func eventCapability(_ type: String?) -> String? {
    switch type {
    case "agentDelta", "agentStatus": "agentRead"
    case "notesChanged": "notesRead"
    case "deviceRevoked", "resyncRequired": "devicesReadSelf"
    default: nil
    }
  }
}

@MainActor
final class PairingAPI {
  func propose(
    payload: PairingPayload,
    identity: DeviceIdentity,
    pairingProof: [UInt8],
    deviceCredentialHash: [UInt8]
  ) async throws -> PairingStatusWire {
    try await request(
      relayURL: payload.relayUrl,
      path: "/v1/companion/pairings/\(payload.pairingId.uuidString)/propose",
      method: "POST",
      deviceCredential: nil,
      body: [
        "mobileDeviceId": identity.deviceID.uuidString,
        "mobilePublicKey": identity.publicKey,
        "displayName": UIDevice.current.name,
        "pairingProof": pairingProof,
        "deviceCredentialHash": deviceCredentialHash,
      ]
    )
  }

  func waitForApproval(
    payload: PairingPayload,
    pairingProof: [UInt8]
  ) async throws -> PairingStatusWire {
    while currentMilliseconds() < payload.expiresAtMs {
      let status: PairingStatusWire = try await request(
        relayURL: payload.relayUrl,
        path: "/v1/companion/pairings/\(payload.pairingId.uuidString)/mobile-status",
        method: "POST",
        deviceCredential: nil,
        body: ["pairingProof": pairingProof]
      )
      if status.state == "approved" { return status }
      if status.state == "expired" { break }
      try await Task.sleep(for: .seconds(1))
    }
    throw CompanionNativeError.unavailable("The pairing code expired. Show a new code on your Mac.")
  }

  func revoke(relayURL: URL, deviceID: UUID, deviceCredential: String) async throws {
    let _: [String: Bool] = try await request(
      relayURL: relayURL,
      path: "/v1/companion/devices/\(deviceID.uuidString)/revoke",
      method: "POST",
      deviceCredential: deviceCredential,
      body: [:]
    )
  }

  func registerPush(
    relayURL: URL,
    deviceID: UUID,
    deviceToken: Data,
    deviceCredential: String
  ) async throws {
    let _: [String: Bool] = try await request(
      relayURL: relayURL,
      path: "/v1/companion/devices/\(deviceID.uuidString)/push",
      method: "POST",
      deviceCredential: deviceCredential,
      body: ["token": Array(deviceToken)]
    )
  }

  private func request<T: Decodable>(
    relayURL: URL,
    path: String,
    method: String,
    deviceCredential: String?,
    body: [String: Any]?
  ) async throws -> T {
    let base = try apiBase(relayURL)
    guard let url = URL(string: path, relativeTo: base)?.absoluteURL else {
      throw CompanionNativeError.invalidData("The companion relay URL is invalid.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    if let deviceCredential {
      request.setValue("Device \(deviceCredential)", forHTTPHeaderField: "Authorization")
    }
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw CompanionNativeError.unavailable("The companion relay is unavailable.")
    }
    let envelope = try JSONDecoder().decode(APIEnvelope<T>.self, from: data)
    guard (200..<300).contains(http.statusCode), envelope.success, let result = envelope.data else {
      throw CompanionNativeError.unavailable(envelope.message ?? "The companion relay rejected the request.")
    }
    return result
  }

  private func apiBase(_ relayURL: URL) throws -> URL {
    var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)
    components?.scheme = relayURL.scheme == "wss" ? "https" : "http"
    components?.path = ""
    components?.query = nil
    guard let url = components?.url,
          url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")) else {
      throw CompanionNativeError.invalidData("Pairing requires a secure relay URL.")
    }
    return url
  }
}

@MainActor
final class CompanionTransport {
  typealias EventHandler = ([String: Any]) -> Void

  private var task: URLSessionWebSocketTask?
  private var connectionID: UUID?
  private var crypto: CompanionCryptoSession?
  private var ownDeviceID: UUID?
  private var desktopDeviceID: UUID?
  private var sequence: UInt64 = 0
  private var inboundSequence: UInt64 = 0
  private var pending: [UUID: PendingRequest] = [:]
  private var eventHandler: EventHandler?

  private struct PendingRequest {
    let capability: String
    let continuation: CheckedContinuation<Data, Error>
  }

  func connect(
    relayURL: URL,
    deviceCredential: String,
    identity: DeviceIdentity,
    desktopDeviceID: UUID,
    crypto: CompanionCryptoSession,
    pairing: Bool,
    expectedDesktopPublicKey: [UInt8],
    eventHandler: @escaping EventHandler
  ) async throws {
    disconnect()
    var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)
    guard components?.scheme == "wss" || (
      components?.scheme == "ws" && ["localhost", "127.0.0.1"].contains(components?.host ?? "")
    ) else { throw CompanionNativeError.invalidData("The relay must use secure WebSockets.") }
    components?.queryItems = [URLQueryItem(name: "deviceId", value: identity.deviceID.uuidString)]
    guard let url = components?.url else { throw CompanionNativeError.invalidData("The relay URL is invalid.") }
    var request = URLRequest(url: url)
    request.setValue("Device \(deviceCredential)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 30
    let socket = URLSession(configuration: .ephemeral).webSocketTask(with: request)
    let connectionID = UUID()
    task = socket
    self.connectionID = connectionID
    self.crypto = crypto
    ownDeviceID = identity.deviceID
    self.desktopDeviceID = desktopDeviceID
    self.eventHandler = eventHandler
    sequence = 0
    inboundSequence = 0
    socket.resume()

    let first = try crypto.write([])
    try await sendEnvelope(
      first,
      through: socket,
      sender: identity.deviceID,
      recipient: desktopDeviceID
    )
    let second = try await receiveEnvelope(
      from: socket,
      sender: desktopDeviceID,
      recipient: identity.deviceID
    )
    guard self.connectionID == connectionID else { throw CompanionNativeError.cancelled }
    _ = try crypto.read([UInt8](second.ciphertext))
    if pairing {
      try await sendEnvelope(
        try crypto.write([]),
        through: socket,
        sender: identity.deviceID,
        recipient: desktopDeviceID
      )
    }
    guard self.connectionID == connectionID,
          crypto.isReady,
          try crypto.remoteStatic() == expectedDesktopPublicKey else {
      disconnect()
      throw CompanionNativeError.unavailable("The Mac did not prove the identity shown during pairing.")
    }
    Task {
      await self.receiveLoop(
        socket: socket,
        connectionID: connectionID,
        sender: desktopDeviceID,
        recipient: identity.deviceID
      )
    }
  }

  func request(capability: String, body: [String: Any]) async throws -> Data {
    guard let crypto, crypto.isReady else {
      throw CompanionNativeError.unavailable("Your Mac is offline.")
    }
    guard sequence < UInt64.max else {
      disconnect()
      throw CompanionNativeError.unavailable("Reconnect to establish a fresh secure session.")
    }
    sequence += 1
    let operationID = UUID()
    let now = currentMilliseconds()
    let object: [String: Any] = [
      "version": 1,
      "operationId": operationID.uuidString,
      "sequence": sequence,
      "issuedAtMs": now,
      "expiresAtMs": now + 30_000,
      "capability": capability,
      "body": body,
    ]
    let plaintext = try JSONSerialization.data(withJSONObject: object)
    let encrypted = try crypto.write([UInt8](plaintext))
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        pending[operationID] = PendingRequest(
          capability: capability,
          continuation: continuation
        )
        Task {
          do { try await self.sendEnvelope(encrypted) }
          catch { self.failPending(operationID, error: error) }
        }
        Task {
          try? await Task.sleep(for: .seconds(30))
          self.failPending(operationID, error: CompanionNativeError.unavailable("Your Mac did not respond in time."))
        }
      }
    } onCancel: {
      Task { @MainActor in self.failPending(operationID, error: CancellationError()) }
    }
  }

  func disconnect() {
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    connectionID = nil
    crypto = nil
    for request in pending.values {
      request.continuation.resume(throwing: CompanionNativeError.unavailable("Your Mac disconnected."))
    }
    pending.removeAll()
  }

  private func sendEnvelope(_ ciphertext: [UInt8]) async throws {
    guard let task, let sender = ownDeviceID, let recipient = desktopDeviceID else {
      throw CompanionNativeError.unavailable("The companion relay is disconnected.")
    }
    try await sendEnvelope(ciphertext, through: task, sender: sender, recipient: recipient)
  }

  private func sendEnvelope(
    _ ciphertext: [UInt8],
    through socket: URLSessionWebSocketTask,
    sender: UUID,
    recipient: UUID
  ) async throws {
    let envelope = RelayEnvelope(
      version: 1,
      senderDeviceId: sender,
      recipientDeviceId: recipient,
      messageId: UUID(),
      createdAtMs: currentMilliseconds(),
      ciphertext: Data(ciphertext)
    )
    try await socket.send(.data(JSONEncoder().encode(envelope)))
  }

  private func receiveEnvelope(
    from socket: URLSessionWebSocketTask,
    sender: UUID,
    recipient: UUID
  ) async throws -> RelayEnvelope {
    let message = try await socket.receive()
    let data: Data
    switch message {
    case .data(let value): data = value
    case .string(let value): data = Data(value.utf8)
    @unknown default: throw CompanionNativeError.invalidData("The relay frame is invalid.")
    }
    let envelope = try JSONDecoder().decode(RelayEnvelope.self, from: data)
    let now = currentMilliseconds()
    guard envelope.version == 1,
          envelope.senderDeviceId == sender,
          envelope.recipientDeviceId == recipient,
          envelope.createdAtMs <= now + 30_000,
          now <= envelope.createdAtMs + 30_000,
          !envelope.ciphertext.isEmpty,
          envelope.ciphertext.count <= 45 * 1024 else {
      throw CompanionNativeError.invalidData("The relay frame failed validation.")
    }
    return envelope
  }

  private func receiveLoop(
    socket: URLSessionWebSocketTask,
    connectionID: UUID,
    sender: UUID,
    recipient: UUID
  ) async {
    do {
      while self.connectionID == connectionID {
        let envelope = try await receiveEnvelope(
          from: socket,
          sender: sender,
          recipient: recipient
        )
        guard let crypto else { break }
        let plaintext = try crypto.read([UInt8](envelope.ciphertext))
        let data = Data(plaintext)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
          throw CompanionNativeError.invalidData("The encrypted companion frame is invalid.")
        }
        let validated = try CompanionWireValidation.frame(data, after: inboundSequence)
        inboundSequence = validated.sequence
        if validated.bodyType == "response" {
          guard let request = pending[validated.operationID] else { continue }
          guard request.capability == validated.capability else {
            throw CompanionNativeError.invalidData("The Mac response did not match the request capability.")
          }
          pending.removeValue(forKey: validated.operationID)
          request.continuation.resume(returning: data)
        } else if validated.bodyType == "event" {
          eventHandler?(object)
        }
      }
    } catch {
      if self.connectionID == connectionID {
        let revoked = socket.closeCode == .policyViolation
          && socket.closeReason.flatMap { String(data: $0, encoding: .utf8) } == "revoked"
        disconnect()
        eventHandler?([
          "type": revoked ? "deviceRevoked" : "transportError",
          "message": revoked ? "This device was revoked." : "Your Mac disconnected.",
        ])
      }
    }
  }

  private func failPending(_ operationID: UUID, error: Error) {
    pending.removeValue(forKey: operationID)?.continuation.resume(throwing: error)
  }
}

@available(iOS 16.0, *)
@MainActor
final class QRCodeScanner: NSObject, DataScannerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  static let shared = QRCodeScanner()
  private var continuation: CheckedContinuation<String, Error>?
  private var scanner: DataScannerViewController?

  func scan() async throws -> String {
    guard continuation == nil else {
      throw CompanionNativeError.unavailable("The QR scanner is already open.")
    }
    guard DataScannerViewController.isSupported, DataScannerViewController.isAvailable else {
      throw CompanionNativeError.unavailable("QR scanning is unavailable on this device.")
    }
    let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
    scanner.delegate = self
    self.scanner = scanner
    guard let presenter = UIApplication.shared.connectedScenes.compactMap({$0 as? UIWindowScene}).flatMap(\.windows).first(where: {$0.isKeyWindow})?.rootViewController else {
      throw CompanionNativeError.unavailable("The QR scanner could not open.")
    }
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        self.continuation = continuation
        presenter.present(scanner, animated: true) {
          scanner.presentationController?.delegate = self
          do { try scanner.startScanning() }
          catch { self.finish(.failure(error)) }
        }
      }
    } onCancel: {
      Task { @MainActor in self.finish(.failure(CompanionNativeError.cancelled)) }
    }
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    guard case .barcode(let barcode) = addedItems.first, let payload = barcode.payloadStringValue else { return }
    finish(.success(payload))
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(.failure(CompanionNativeError.cancelled), dismiss: false)
  }

  private func finish(_ result: Result<String, Error>, dismiss: Bool = true) {
    guard let continuation else { return }
    self.continuation = nil
    scanner?.stopScanning()
    if dismiss { scanner?.dismiss(animated: true) }
    scanner = nil
    continuation.resume(with: result)
  }
}

func currentMilliseconds() -> UInt64 {
  UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
}
