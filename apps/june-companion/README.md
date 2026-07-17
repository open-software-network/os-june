# June Companion

Native SwiftUI application for iPhone and iPad. Generate the Xcode project from
`native-ios/project.yml` with XcodeGen. Start with
the repository [companion architecture](../../docs/companion-architecture.md)
and [local development guide](../../docs/companion-development.md).

Security-sensitive operations remain in Swift and the shared Rust crypto
library. The SwiftUI application model receives typed decrypted DTOs for
presentation, never tokens, private/session keys, APNs tokens, QR secrets, or
raw protocol frames.

June Companion signs in through the OS Accounts hosted login in the system
browser using its own public OAuth client and PKCE. It then scans a pairing
code, generates its own revocable device credential, and can use it only after
a Mac signed in to the same account approves its hash and device identity. The
desktop token is never copied, and no debug bearer fallback is used.
