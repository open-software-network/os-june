# June Companion

Native SwiftUI application for iPhone and iPad. Generate the Xcode project from
`native-ios/project.yml` with XcodeGen. Start with
the repository [companion architecture](../../docs/companion-architecture.md)
and [local development guide](../../docs/companion-development.md).

Security-sensitive operations remain in Swift and the shared Rust crypto
library. The SwiftUI application model receives typed decrypted DTOs for
presentation, never tokens, private/session keys, APNs tokens, QR secrets, or
raw protocol frames.

June Desktop owns OS Accounts authentication. The companion scans a pairing
code and receives its own revocable device credential only after the signed-in
desktop approves it. No desktop token, mobile OAuth client, or debug bearer
fallback is used.
