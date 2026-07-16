import AVFoundation
import CryptoKit
import Foundation
import Network
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

struct PairingStatusWire: Codable {
  let pairingId: UUID
  let expiresAtMs: UInt64
  let state: String
  let desktopDeviceId: UUID
  let desktopPublicKey: [UInt8]
  let mobileDeviceId: UUID?
  let mobilePublicKey: [UInt8]?
  let mobileDisplayName: String?
  let deviceCredential: String?
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

@MainActor
final class PairingAPI {
  func propose(
    payload: PairingPayload,
    identity: DeviceIdentity,
    pairingProof: [UInt8]
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
  private var crypto: CompanionCryptoSession?
  private var ownDeviceID: UUID?
  private var desktopDeviceID: UUID?
  private var sequence: UInt64 = 0
  private var pending: [UUID: CheckedContinuation<Data, Error>] = [:]
  private var eventHandler: EventHandler?

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
    task = socket
    self.crypto = crypto
    ownDeviceID = identity.deviceID
    self.desktopDeviceID = desktopDeviceID
    self.eventHandler = eventHandler
    socket.resume()

    let first = try crypto.write([])
    try await sendEnvelope(first)
    let second = try await receiveEnvelope()
    _ = try crypto.read([UInt8](second.ciphertext))
    if pairing {
      try await sendEnvelope(try crypto.write([]))
    }
    guard crypto.isReady, try crypto.remoteStatic() == expectedDesktopPublicKey else {
      disconnect()
      throw CompanionNativeError.unavailable("The Mac did not prove the identity shown during pairing.")
    }
    Task { await self.receiveLoop() }
  }

  func request(capability: String, body: [String: Any]) async throws -> Data {
    guard let crypto, crypto.isReady else {
      throw CompanionNativeError.unavailable("Your Mac is offline.")
    }
    sequence &+= 1
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
    return try await withCheckedThrowingContinuation { continuation in
      pending[operationID] = continuation
      Task {
        do { try await self.sendEnvelope(encrypted) }
        catch { self.failPending(operationID, error: error) }
      }
      Task {
        try? await Task.sleep(for: .seconds(30))
        self.failPending(operationID, error: CompanionNativeError.unavailable("Your Mac did not respond in time."))
      }
    }
  }

  func disconnect() {
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    crypto = nil
    for continuation in pending.values {
      continuation.resume(throwing: CompanionNativeError.unavailable("Your Mac disconnected."))
    }
    pending.removeAll()
  }

  private func sendEnvelope(_ ciphertext: [UInt8]) async throws {
    guard let task, let sender = ownDeviceID, let recipient = desktopDeviceID else {
      throw CompanionNativeError.unavailable("The companion relay is disconnected.")
    }
    let envelope = RelayEnvelope(
      version: 1,
      senderDeviceId: sender,
      recipientDeviceId: recipient,
      messageId: UUID(),
      createdAtMs: currentMilliseconds(),
      ciphertext: Data(ciphertext)
    )
    try await task.send(.data(JSONEncoder().encode(envelope)))
  }

  private func receiveEnvelope() async throws -> RelayEnvelope {
    guard let task else { throw CompanionNativeError.unavailable("The companion relay is disconnected.") }
    let message = try await task.receive()
    let data: Data
    switch message {
    case .data(let value): data = value
    case .string(let value): data = Data(value.utf8)
    @unknown default: throw CompanionNativeError.invalidData("The relay frame is invalid.")
    }
    let envelope = try JSONDecoder().decode(RelayEnvelope.self, from: data)
    guard envelope.version == 1,
          envelope.senderDeviceId == desktopDeviceID,
          envelope.recipientDeviceId == ownDeviceID,
          !envelope.ciphertext.isEmpty,
          envelope.ciphertext.count <= 45 * 1024 else {
      throw CompanionNativeError.invalidData("The relay frame failed validation.")
    }
    return envelope
  }

  private func receiveLoop() async {
    do {
      while task != nil {
        let envelope = try await receiveEnvelope()
        guard let crypto else { break }
        let plaintext = try crypto.read([UInt8](envelope.ciphertext))
        let data = Data(plaintext)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
          throw CompanionNativeError.invalidData("The encrypted companion frame is invalid.")
        }
        if let operation = (object["operationId"] as? String).flatMap(UUID.init(uuidString:)),
           let continuation = pending.removeValue(forKey: operation) {
          continuation.resume(returning: data)
        } else {
          eventHandler?(object)
        }
      }
    } catch {
      disconnect()
      eventHandler?(["type": "transportError", "message": "Your Mac disconnected."])
    }
  }

  private func failPending(_ operationID: UUID, error: Error) {
    pending.removeValue(forKey: operationID)?.resume(throwing: error)
  }
}

@available(iOS 16.0, *)
@MainActor
final class QRCodeScanner: NSObject, DataScannerViewControllerDelegate {
  static let shared = QRCodeScanner()
  private var continuation: CheckedContinuation<String, Error>?
  private var scanner: DataScannerViewController?

  func scan() async throws -> String {
    guard DataScannerViewController.isSupported, DataScannerViewController.isAvailable else {
      throw CompanionNativeError.unavailable("QR scanning is unavailable on this device.")
    }
    let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
    scanner.delegate = self
    self.scanner = scanner
    guard let presenter = UIApplication.shared.connectedScenes.compactMap({$0 as? UIWindowScene}).flatMap(\.windows).first(where: {$0.isKeyWindow})?.rootViewController else {
      throw CompanionNativeError.unavailable("The QR scanner could not open.")
    }
    presenter.present(scanner, animated: true)
    try scanner.startScanning()
    return try await withCheckedThrowingContinuation { continuation = $0 }
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    guard case .barcode(let barcode) = addedItems.first, let payload = barcode.payloadStringValue else { return }
    scanner?.stopScanning()
    scanner?.dismiss(animated: true)
    scanner = nil
    continuation?.resume(returning: payload)
    continuation = nil
  }
}

func currentMilliseconds() -> UInt64 {
  UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
}
