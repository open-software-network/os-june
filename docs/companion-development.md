# June Companion local development

## Prerequisites

Use Rust with `aarch64-apple-ios-sim`, Xcode 26, and XcodeGen 2.45.4 or newer.
The native app has no Node, Metro, React Native, or CocoaPods dependency.
Local June API permits the in-memory relay; restart loses links.

The companion has no account login or OAuth configuration. Sign in to OS
Accounts in June Desktop. Pairing authorizes the phone with a separate,
revocable device credential and never copies the desktop token.

## Run

```sh
cd apps/june-companion/native-ios
xcodegen generate
open JuneCompanion.xcodeproj
```

Run June API and a signed-in June Desktop with the relay URL.
Open Desktop Settings > Linked devices, scan the native QR, review the device
name/capabilities, and approve.

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
