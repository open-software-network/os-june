# June Companion local development

## Prerequisites

Use Rust with `aarch64-apple-ios-sim`, Xcode 26, and XcodeGen 2.45.4 or newer.
The native app has no Node, Metro, React Native, or CocoaPods dependency.
Local June API permits the in-memory relay; restart loses links.

Register a separate public OS Accounts OAuth client for June Companion with the
exact callback `junecompanion://auth/callback`. Set
`JUNE_COMPANION_ACCOUNTS_CLIENT_ID` as an Xcode build setting or in a local
uncommitted xcconfig. Do not reuse the June Desktop client registration.
The committed build setting is intentionally blank.

Mobile login proves account identity. Pairing separately authorizes the phone
with a revocable device credential and explicit approval from a June Desktop
signed in to the same account. The desktop token is never copied.

## Run

```sh
cd apps/june-companion/native-ios
xcodegen generate
open JuneCompanion.xcodeproj
```

Run June API and a signed-in June Desktop with the relay URL. Sign in from the
companion; the hosted OS Accounts login opens in the system browser. Then open
Desktop Settings > Linked devices, scan the native QR, review the device name
and capabilities, and approve.

## Verify

```sh
cd apps/june-companion/native-ios
xcodegen generate
xcodebuild -project JuneCompanion.xcodeproj -scheme JuneCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' test
xcodebuild -project JuneCompanion.xcodeproj -scheme JuneCompanion \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5),OS=26.5' build
cargo test --manifest-path crates/june-companion-protocol/Cargo.toml
cargo test --manifest-path crates/june-companion-crypto/Cargo.toml
pnpm typecheck
pnpm test:rust
pnpm test:june-api
```

Build both an iPhone and iPad simulator destination with `xcodebuild` and take
screenshots. Simulator cannot prove Face ID/passcode policy, camera scanning,
APNs delivery, or distribution signing. Test those on a signed physical device.
