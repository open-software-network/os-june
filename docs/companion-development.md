# June Companion local development

## Prerequisites

Use Rust with `aarch64-apple-ios-sim`, Xcode 26, and XcodeGen 2.45.4 or newer.
The native app has no Node, Metro, React Native, or CocoaPods dependency.
Local June API permits the in-memory relay; restart loses links.

June Companion does not need an OS Accounts OAuth registration. Pairing is
created by a signed-in June Desktop and authorizes the phone with a revocable
device credential after explicit Desktop approval. The Desktop token is never
copied.

## Run

```sh
cd apps/june-companion/native-ios
xcodegen generate
open JuneCompanion.xcodeproj
```

Run June API and a signed-in June Desktop with the relay URL. Open Desktop
Settings > Linked devices and show a pairing code. Scan it from the companion,
or expand Enter a code instead on Desktop and choose Enter pairing code on the
phone. Review the device name and capabilities on Desktop, then approve.

The manual code is a URL-safe encoding of the exact short-lived QR bootstrap
payload. It contains the same pairing secret, expires after five minutes, and
still requires explicit Desktop approval. Treat it like the QR: do not log it,
store it, or include it in screenshots. Copying is explicit; Desktop clears the
clipboard on expiry, cancellation, approval, or leaving the settings surface
when the clipboard still contains that code. Clipboard cleanup is best-effort,
so the five-minute expiry remains the security backstop.

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
