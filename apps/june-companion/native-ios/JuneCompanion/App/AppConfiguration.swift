import Foundation

struct AppConfiguration: Equatable, Sendable {
  let accountsOrigin: URL
  let accountsAPIOrigin: URL
  let accountsClientID: String?
  let accountsRedirectURI: URL

  init(bundle: Bundle = .main) {
    accountsOrigin = bundle.configuredURL(for: "JUNE_COMPANION_ACCOUNTS_ORIGIN")
      ?? URL(string: "https://accounts.opensoftware.co")!
    accountsAPIOrigin = bundle.configuredURL(for: "JUNE_COMPANION_ACCOUNTS_API_ORIGIN")
      ?? URL(string: "https://accounts-api.opensoftware.co")!
    accountsClientID = bundle.configuredString(for: "JUNE_COMPANION_ACCOUNTS_CLIENT_ID")
    accountsRedirectURI = bundle.configuredURL(for: "JUNE_COMPANION_ACCOUNTS_REDIRECT_URI")
      ?? URL(string: "junecompanion://auth/callback")!
  }

  init(
    accountsOrigin: URL,
    accountsAPIOrigin: URL,
    accountsClientID: String?,
    accountsRedirectURI: URL
  ) {
    self.accountsOrigin = accountsOrigin
    self.accountsAPIOrigin = accountsAPIOrigin
    self.accountsClientID = accountsClientID
    self.accountsRedirectURI = accountsRedirectURI
  }

  var accountsConfigured: Bool {
    guard let accountsClientID else { return false }
    return accountsClientID.hasPrefix("ocl_")
      && accountsRedirectURI.scheme?.lowercased() == "junecompanion"
      && accountsRedirectURI.host?.lowercased() == "auth"
      && accountsRedirectURI.path == "/callback"
  }
}

private extension Bundle {
  func configuredString(for key: String) -> String? {
    guard let raw = object(forInfoDictionaryKey: key) as? String else { return nil }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !value.contains("$(") else { return nil }
    return value
  }

  func configuredURL(for key: String) -> URL? {
    configuredString(for: key).flatMap(URL.init(string:))
  }
}
