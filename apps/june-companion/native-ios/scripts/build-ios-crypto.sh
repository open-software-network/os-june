#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
CRATE="$ROOT/crates/june-companion-crypto/Cargo.toml"
OUT="$ROOT/apps/june-companion/native-ios/CompanionCrypto"

mkdir -p "$OUT/include"
cp "$ROOT/crates/june-companion-crypto/include/june_companion_crypto.h" "$OUT/include/"

case "${PLATFORM_NAME:-}" in
  iphoneos) TARGETS="aarch64-apple-ios" ;;
  iphonesimulator) TARGETS="aarch64-apple-ios-sim x86_64-apple-ios" ;;
  *) TARGETS="aarch64-apple-ios" ;;
esac

LIB_DIR="$OUT/lib/${PLATFORM_NAME:-iphoneos}"
mkdir -p "$LIB_DIR"

for TARGET in $TARGETS; do
  rustup target add "$TARGET"
  cargo build --release --manifest-path "$CRATE" --target "$TARGET"
done

set -- $TARGETS
if [ "$#" -eq 1 ]; then
  cp "$ROOT/crates/june-companion-crypto/target/$1/release/libjune_companion_crypto.a" "$LIB_DIR/libjune_companion_crypto.a"
else
  xcrun lipo -create \
    "$ROOT/crates/june-companion-crypto/target/aarch64-apple-ios-sim/release/libjune_companion_crypto.a" \
    "$ROOT/crates/june-companion-crypto/target/x86_64-apple-ios/release/libjune_companion_crypto.a" \
    -output "$LIB_DIR/libjune_companion_crypto.a"
fi
