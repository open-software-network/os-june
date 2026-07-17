# June Companion

Native SwiftUI application for iPhone and iPad. Generate the Xcode project from
`native-ios/project.yml` with XcodeGen. Start with
the repository [companion architecture](../../docs/companion-architecture.md)
and [local development guide](../../docs/companion-development.md).

Security-sensitive operations remain in Swift and the shared Rust crypto
library. The SwiftUI application model receives typed decrypted DTOs for
presentation, never tokens, private/session keys, APNs tokens, QR secrets, or
raw protocol frames.

June Companion starts by scanning a five-minute pairing code created by a
signed-in June Desktop. It generates its own revocable device credential and
can use it only after that Mac approves the credential hash and device
identity. The companion has no account login or bearer token, the Desktop token
is never copied, and no debug bearer fallback is used.
