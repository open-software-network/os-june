import Foundation
import LocalAuthentication
import Security
import UIKit

enum CompanionNativeError: LocalizedError {
  case invalidData(String)
  case unavailable(String)
  case cancelled

  var errorDescription: String? {
    switch self {
    case .invalidData(let message), .unavailable(let message): return message
    case .cancelled: return "The operation was cancelled."
    }
  }
}

final class SecureStore: @unchecked Sendable {
  static let shared = SecureStore()
  private let service = "co.opensoftware.june.companion"

  func save(_ data: Data, account: String, accessible: CFString = kSecAttrAccessibleWhenUnlockedThisDeviceOnly) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let update: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: accessible,
    ]
    let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else {
      throw CompanionNativeError.unavailable("Secure storage is unavailable.")
    }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = accessible
    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
      throw CompanionNativeError.unavailable("Secure storage is unavailable.")
    }
  }

  func read(account: String) throws -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw CompanionNativeError.unavailable("Secure storage is unavailable.")
    }
    return data
  }

  func migrateAccessibility(account: String, to accessible: CFString) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemUpdate(
      query as CFDictionary,
      [kSecAttrAccessible as String: accessible] as CFDictionary
    )
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw CompanionNativeError.unavailable("Secure storage is unavailable.")
    }
  }

  func delete(account: String) {
    SecItemDelete([
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ] as CFDictionary)
  }
}

struct DeviceIdentity: Codable {
  let deviceID: UUID
  let privateKey: [UInt8]
  let publicKey: [UInt8]
}

final class CompanionCryptoSession {
  private var handle: OpaquePointer?

  init(pairingInitiator: Bool, localPrivate: [UInt8], pairingSecret: [UInt8]) throws {
    guard localPrivate.count == 32, pairingSecret.count == 32 else { throw CompanionNativeError.invalidData("The pairing key is invalid.") }
    handle = localPrivate.withUnsafeBytes { local in pairingSecret.withUnsafeBytes { secret in
      june_crypto_pairing_session_new(pairingInitiator, local.bindMemory(to: UInt8.self).baseAddress, secret.bindMemory(to: UInt8.self).baseAddress)
    }}
    if handle == nil { throw CompanionNativeError.unavailable("Secure pairing could not start.") }
  }

  init(linkedInitiator: Bool, localPrivate: [UInt8], remotePublic: [UInt8]) throws {
    guard localPrivate.count == 32, remotePublic.count == 32 else { throw CompanionNativeError.invalidData("The linked device key is invalid.") }
    handle = localPrivate.withUnsafeBytes { local in remotePublic.withUnsafeBytes { remote in
      june_crypto_linked_session_new(linkedInitiator, local.bindMemory(to: UInt8.self).baseAddress, remote.bindMemory(to: UInt8.self).baseAddress)
    }}
    if handle == nil { throw CompanionNativeError.unavailable("A secure session could not start.") }
  }

  deinit { if let handle { june_crypto_session_free(handle) } }
  var isReady: Bool { handle.map(june_crypto_session_is_ready) ?? false }

  func write(_ bytes: [UInt8]) throws -> [UInt8] { try operate(bytes, write: true) }
  func read(_ bytes: [UInt8]) throws -> [UInt8] { try operate(bytes, write: false) }

  func remoteStatic() throws -> [UInt8] {
    guard let handle else { throw CompanionNativeError.unavailable("The secure session is closed.") }
    var output = [UInt8](repeating: 0, count: 32)
    guard june_crypto_session_remote_static(handle, &output) == 0 else {
      throw CompanionNativeError.unavailable("The paired device identity is unavailable.")
    }
    return output
  }

  private func operate(_ input: [UInt8], write: Bool) throws -> [UInt8] {
    guard let handle else { throw CompanionNativeError.unavailable("The secure session is closed.") }
    var output = [UInt8](repeating: 0, count: 65_535)
    var outputLength = 0
    let status = input.withUnsafeBytes { source in
      write
        ? june_crypto_session_write(handle, source.bindMemory(to: UInt8.self).baseAddress, input.count, &output, output.count, &outputLength)
        : june_crypto_session_read(handle, source.bindMemory(to: UInt8.self).baseAddress, input.count, &output, output.count, &outputLength)
    }
    guard status == 0 else {
      throw CompanionNativeError.unavailable(status == 4 ? "The secure session must reconnect." : "Encrypted data could not be verified.")
    }
    return Array(output.prefix(outputLength))
  }
}

@MainActor
protocol DeviceOwnerAuthenticating {
  var canAuthenticate: Bool { get }
  func authenticate(reason: String) async throws -> Bool
}

@MainActor
struct SystemDeviceOwnerAuthenticator: DeviceOwnerAuthenticating {
  private let context = LAContext()

  var canAuthenticate: Bool {
    var error: NSError?
    return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
  }

  func authenticate(reason: String) async throws -> Bool {
    try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
  }
}

@MainActor
final class DeviceIdentityService {
  static let shared = DeviceIdentityService()
  private let account = "device.identity"

  func identity() throws -> DeviceIdentity {
    if let data = try SecureStore.shared.read(account: account),
       let identity = try? JSONDecoder().decode(DeviceIdentity.self, from: data),
       identity.privateKey.count == 32, identity.publicKey.count == 32 {
      try SecureStore.shared.migrateAccessibility(
        account: account,
        to: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      )
      return identity
    }
    var privateKey = [UInt8](repeating: 0, count: 32)
    var publicKey = [UInt8](repeating: 0, count: 32)
    guard june_crypto_generate_identity(&privateKey, &publicKey) == 0 else {
      throw CompanionNativeError.unavailable("A device identity could not be generated.")
    }
    let identity = DeviceIdentity(deviceID: UUID(), privateKey: privateKey, publicKey: publicKey)
    try SecureStore.shared.save(
      JSONEncoder().encode(identity),
      account: account,
      accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    )
    return identity
  }

  func delete() { SecureStore.shared.delete(account: account) }

  func unlock(authenticator: DeviceOwnerAuthenticating = SystemDeviceOwnerAuthenticator()) async throws -> Bool {
    guard authenticator.canAuthenticate else {
      throw CompanionNativeError.unavailable("Set a device passcode to protect June Companion.")
    }
    return try await authenticator.authenticate(reason: "Unlock your June companion")
  }
}
