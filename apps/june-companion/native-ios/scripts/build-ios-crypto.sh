#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
CRATE="$ROOT/crates/june-companion-crypto/Cargo.toml"
OUT="$ROOT/apps/june-companion/native-ios/CompanionCrypto"

mkdir -p "$OUT/include"
cp "$ROOT/crates/june-companion-crypto/include/june_companion_crypto.h" "$OUT/include/"

case "${PLATFORM_NAME:-}" in
  iphoneos) TARGET="aarch64-apple-ios" ;;
  iphonesimulator)
    if [ "${CURRENT_ARCH:-arm64}" = "x86_64" ]; then TARGET="x86_64-apple-ios"; else TARGET="aarch64-apple-ios-sim"; fi
    ;;
  *) TARGET="aarch64-apple-ios" ;;
esac

LIB_DIR="$OUT/lib/${PLATFORM_NAME:-iphoneos}"
mkdir -p "$LIB_DIR"
rustup target add "$TARGET"
cargo build --release --manifest-path "$CRATE" --target "$TARGET"
cp "$ROOT/crates/june-companion-crypto/target/$TARGET/release/libjune_companion_crypto.a" "$LIB_DIR/libjune_companion_crypto.a"
