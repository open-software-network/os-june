import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

struct AccountProfile: Codable, Equatable, Sendable {
  let id: String
  let handle: String
}

struct AccountAuthorization: Sendable {
  let accessToken: String
  let profile: AccountProfile
}

struct AccountTokenPair: Codable, Sendable {
  let accessToken: String
  let refreshToken: String

  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case refreshToken = "refresh_token"
  }
}

private struct StoredAccount: Codable, Sendable {
  let tokens: AccountTokenPair
  let profile: AccountProfile
}

struct AccountEnvelope<Value: Decodable>: Decodable {
  let data: Value?
  let success: Bool
  let errorCode: Int?
  let message: String?

  enum CodingKeys: String, CodingKey {
    case data, success, message
    case errorCode = "error_code"
  }
}

enum AccountAuthenticationError: LocalizedError, Equatable {
  case unavailable
  case invalidCallback
  case stateMismatch
  case rejected(String)
  case cancelled

  var errorDescription: String? {
    switch self {
    case .unavailable:
      "OS Accounts sign-in is not configured for this build."
    case .invalidCallback:
      "OS Accounts returned an invalid sign-in response."
    case .stateMismatch:
      "The sign-in response could not be verified. Please try again."
    case .rejected(let message):
      message
    case .cancelled:
      "Sign-in was cancelled."
    }
  }
}

struct OAuthAuthorizationRequest: Equatable, Sendable {
  let url: URL
  let state: String
  let verifier: String
}

enum AccountOAuth {
  static let scopes = "profile:read"

  static func makeAuthorizationRequest(
    configuration: AppConfiguration,
    randomBytes: (Int) throws -> [UInt8] = secureRandomBytes
  ) throws -> OAuthAuthorizationRequest {
    guard configuration.accountsConfigured,
          let clientID = configuration.accountsClientID
    else {
      throw AccountAuthenticationError.unavailable
    }

    let verifier = Data(try randomBytes(32)).base64URLEncodedString()
    let state = Data(try randomBytes(24)).base64URLEncodedString()
    let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
    var components = URLComponents(
      url: configuration.accountsOrigin.appendingPathComponent("login"),
      resolvingAgainstBaseURL: false
    )
    components?.queryItems = [
      URLQueryItem(name: "client_id", value: clientID),
      URLQueryItem(name: "redirect_uri", value: configuration.accountsRedirectURI.absoluteString),
      URLQueryItem(name: "scope", value: scopes),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "code_challenge", value: challenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
    ]
    guard let url = components?.url else {
      throw AccountAuthenticationError.unavailable
    }
    return OAuthAuthorizationRequest(url: url, state: state, verifier: verifier)
  }

  static func authorizationCode(
    from callback: URL,
    expectedState: String,
    redirectURI: URL
  ) throws -> String {
    guard callback.scheme?.lowercased() == redirectURI.scheme?.lowercased(),
          callback.host?.lowercased() == redirectURI.host?.lowercased(),
          callback.path == redirectURI.path,
          callback.fragment == nil,
          let components = URLComponents(url: callback, resolvingAgainstBaseURL: false)
    else {
      throw AccountAuthenticationError.invalidCallback
    }

    let states = components.queryItems?.filter { $0.name == "state" }.compactMap(\.value) ?? []
    guard states.count == 1, states[0] == expectedState else {
      throw AccountAuthenticationError.stateMismatch
    }
    if let message = components.queryItems?.first(where: { $0.name == "error_description" })?.value,
       !message.isEmpty {
      throw AccountAuthenticationError.rejected(message)
    }
    let codes = components.queryItems?.filter { $0.name == "code" }.compactMap(\.value) ?? []
    guard codes.count == 1, !codes[0].isEmpty else {
      throw AccountAuthenticationError.invalidCallback
    }
    return codes[0]
  }

  private static func secureRandomBytes(count: Int) throws -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: count)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw AccountAuthenticationError.unavailable
    }
    return bytes
  }
}

@MainActor
final class AccountAuthenticationService {
  static let shared = AccountAuthenticationService()

  private let configuration: AppConfiguration
  private let secureStore: SecureStore
  private let urlSession: URLSession
  private let storageAccount = "os-accounts.tokens"
  private var browserSession: ASWebAuthenticationSession?
  private var presentationContext: AccountAuthenticationPresentationContext?

  init(
    configuration: AppConfiguration = AppConfiguration(),
    secureStore: SecureStore = .shared,
    urlSession: URLSession = .shared
  ) {
    self.configuration = configuration
    self.secureStore = secureStore
    self.urlSession = urlSession
  }

  var isConfigured: Bool { configuration.accountsConfigured }

  func restoredProfile() -> AccountProfile? {
    loadStoredAccount()?.profile
  }

  func signIn() async throws -> AccountProfile {
    let request = try AccountOAuth.makeAuthorizationRequest(configuration: configuration)
    let callback = try await openBrowser(for: request.url)
    let code = try AccountOAuth.authorizationCode(
      from: callback,
      expectedState: request.state,
      redirectURI: configuration.accountsRedirectURI
    )
    let tokens = try await exchangeCode(code, verifier: request.verifier)
    do {
      let authorization = try await resolveAuthorization(tokens: tokens)
      try save(StoredAccount(tokens: authorization.tokens, profile: authorization.profile))
      return authorization.profile
    } catch {
      await invalidate(refreshToken: tokens.refreshToken)
      throw error
    }
  }

  func authorization() async throws -> AccountAuthorization {
    guard let stored = loadStoredAccount() else {
      throw AccountAuthenticationError.rejected("Sign in with OS Accounts first.")
    }
    let authorization = try await resolveAuthorization(
      tokens: stored.tokens,
      onRefresh: { [secureStore] tokens in
        try secureStore.save(
          JSONEncoder().encode(StoredAccount(tokens: tokens, profile: stored.profile)),
          account: "os-accounts.tokens",
          accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        )
      }
    )
    if authorization.profile != stored.profile
      || authorization.tokens.accessToken != stored.tokens.accessToken
      || authorization.tokens.refreshToken != stored.tokens.refreshToken
    {
      try save(StoredAccount(tokens: authorization.tokens, profile: authorization.profile))
    }
    return AccountAuthorization(
      accessToken: authorization.tokens.accessToken,
      profile: authorization.profile
    )
  }

  func signOut() async {
    if let stored = loadStoredAccount() {
      await invalidate(refreshToken: stored.tokens.refreshToken)
    }
    secureStore.delete(account: storageAccount)
  }

  private func openBrowser(for url: URL) async throws -> URL {
    guard let callbackScheme = configuration.accountsRedirectURI.scheme else {
      throw AccountAuthenticationError.unavailable
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let context = AccountAuthenticationPresentationContext()
        let session = ASWebAuthenticationSession(
          url: url,
          callbackURLScheme: callbackScheme
        ) { [weak self] callback, error in
          Task { @MainActor in
            self?.browserSession = nil
            self?.presentationContext = nil
            if let authenticationError = error as? ASWebAuthenticationSessionError,
               authenticationError.code == .canceledLogin {
              continuation.resume(throwing: AccountAuthenticationError.cancelled)
            } else if let error {
              continuation.resume(throwing: AccountAuthenticationError.rejected(error.localizedDescription))
            } else if let callback {
              continuation.resume(returning: callback)
            } else {
              continuation.resume(throwing: AccountAuthenticationError.invalidCallback)
            }
          }
        }
        session.presentationContextProvider = context
        session.prefersEphemeralWebBrowserSession = false
        browserSession = session
        presentationContext = context
        guard session.start() else {
          browserSession = nil
          presentationContext = nil
          continuation.resume(throwing: AccountAuthenticationError.unavailable)
          return
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.browserSession?.cancel()
        self?.browserSession = nil
        self?.presentationContext = nil
      }
    }
  }

  private func exchangeCode(_ code: String, verifier: String) async throws -> AccountTokenPair {
    try await postTokens(path: "/auth/token", body: [
      "grant_type": "authorization_code",
      "code": code,
      "code_verifier": verifier,
      "redirect_uri": configuration.accountsRedirectURI.absoluteString,
    ])
  }

  private func refresh(_ refreshToken: String) async throws -> AccountTokenPair {
    try await postTokens(path: "/auth/refresh", body: ["refresh_token": refreshToken])
  }

  private func invalidate(refreshToken: String) async {
    var request = URLRequest(url: apiURL(path: "/auth/logout"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: [
      "refresh_token": refreshToken
    ])
    _ = try? await urlSession.data(for: request)
  }

  private func postTokens(path: String, body: [String: String]) async throws -> AccountTokenPair {
    var request = URLRequest(url: apiURL(path: path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response: response, data: data)
    let envelope: AccountEnvelope<AccountTokenPair> = try decodeEnvelope(data, response: response)
    guard envelope.success, let tokens = envelope.data,
          !tokens.accessToken.isEmpty, !tokens.refreshToken.isEmpty else {
      throw AccountAuthenticationError.rejected(
        envelope.message ?? "OS Accounts could not complete sign-in."
      )
    }
    return tokens
  }

  private func resolveAuthorization(
    tokens initialTokens: AccountTokenPair,
    onRefresh: ((AccountTokenPair) throws -> Void)? = nil
  ) async throws -> (tokens: AccountTokenPair, profile: AccountProfile) {
    var tokens = initialTokens
    for attempt in 0..<2 {
      var request = URLRequest(url: apiURL(path: "/me"))
      request.setValue("Bearer \(tokens.accessToken)", forHTTPHeaderField: "Authorization")
      let (data, response) = try await urlSession.data(for: request)
      let envelope: AccountEnvelope<AccountProfile> = try decodeEnvelope(data, response: response)
      if envelope.success, let profile = envelope.data {
        return (tokens, profile)
      }
      if envelope.errorCode == 3001, attempt == 0 {
        tokens = try await refresh(tokens.refreshToken)
        try onRefresh?(tokens)
        continue
      }
      throw AccountAuthenticationError.rejected(
        envelope.message ?? "OS Accounts could not load your profile."
      )
    }
    throw AccountAuthenticationError.rejected("OS Accounts could not load your profile.")
  }

  private func apiURL(path: String) -> URL {
    configuration.accountsAPIOrigin.appendingPathComponent(
      path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    )
  }

  private func decodeEnvelope<Value: Decodable>(
    _ data: Data,
    response: URLResponse
  ) throws -> AccountEnvelope<Value> {
    guard response is HTTPURLResponse else {
      throw AccountAuthenticationError.rejected("OS Accounts is unavailable.")
    }
    do {
      return try JSONDecoder().decode(AccountEnvelope<Value>.self, from: data)
    } catch {
      throw AccountAuthenticationError.rejected("OS Accounts returned an invalid response.")
    }
  }

  private func validate(response: URLResponse, data: Data) throws {
    guard let response = response as? HTTPURLResponse else {
      throw AccountAuthenticationError.rejected("OS Accounts is unavailable.")
    }
    guard (200..<300).contains(response.statusCode) else {
      let message = (try? JSONDecoder().decode(AccountEnvelope<EmptyAccountData>.self, from: data))?
        .message
      throw AccountAuthenticationError.rejected(
        message ?? "OS Accounts could not complete sign-in."
      )
    }
  }

  private func save(_ stored: StoredAccount) throws {
    try secureStore.save(
      JSONEncoder().encode(stored),
      account: storageAccount,
      accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    )
  }

  private func loadStoredAccount() -> StoredAccount? {
    guard let data = try? secureStore.read(account: storageAccount) else { return nil }
    return try? JSONDecoder().decode(StoredAccount.self, from: data)
  }
}

private struct EmptyAccountData: Decodable {}

@MainActor
private final class AccountAuthenticationPresentationContext: NSObject,
  ASWebAuthenticationPresentationContextProviding
{
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)
      ?? ASPresentationAnchor()
  }
}

private extension Data {
  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
