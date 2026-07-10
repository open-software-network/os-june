#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.persona-spike"
MODELS="$CACHE/models"
NATIVE="$CACHE/native"
FIXTURES="$CACHE/fixtures"
OUTPUT="$CACHE/output"
CRATE="$ROOT/src-tauri/spikes/persona-recognition/Cargo.toml"
SEGMENTATION_ARCHIVE="$MODELS/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
SEGMENTATION_MODEL="$MODELS/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
EMBEDDING_MODEL="$MODELS/wespeaker_en_voxceleb_resnet34_LM.onnx"

mkdir -p "$MODELS" "$NATIVE" "$FIXTURES" "$OUTPUT"

verify_checksum() {
  local expected="$1"
  local path="$2"
  local actual
  actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch for $path" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi
}

download() {
  local url="$1"
  local expected="$2"
  local destination="$3"
  if [[ ! -f "$destination" ]]; then
    echo "Downloading $(basename "$destination")"
    curl -L --fail --silent --show-error "$url" -o "$destination.partial"
    mv "$destination.partial" "$destination"
  fi
  verify_checksum "$expected" "$destination"
}

platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/arm64)
    native_archive="sherpa-onnx-v1.13.4-osx-arm64-static-lib.tar.bz2"
    native_checksum="57801db2bbb786a5d343f515a38ff210b401842338bdc804fa075312d1cd2404"
    ;;
  Darwin/x86_64)
    native_archive="sherpa-onnx-v1.13.4-osx-x64-static-lib.tar.bz2"
    native_checksum="2bda2c10b31a1cfc45d9f9e14bd4983743ec3779d309e42d99a6c8fa1689043f"
    ;;
  Linux/aarch64 | Linux/arm64)
    native_archive="sherpa-onnx-v1.13.4-linux-aarch64-static-lib.tar.bz2"
    native_checksum="23b33616787cc949d5b1438e9794550f805e208a014c5c2245483207c58bbc0f"
    ;;
  Linux/x86_64)
    native_archive="sherpa-onnx-v1.13.4-linux-x64-static-lib.tar.bz2"
    native_checksum="98b0e31996426f6e78244dbce1955548f2c64e8f01c4be75b85af7cdaa2e8d5c"
    ;;
  MINGW*/x86_64 | MSYS*/x86_64)
    native_archive="sherpa-onnx-v1.13.4-win-x64-static-MT-Release-lib.tar.bz2"
    native_checksum="d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c"
    ;;
  *)
    echo "Unsupported spike platform: $platform/$architecture" >&2
    exit 1
    ;;
esac
download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/$native_archive" \
  "$native_checksum" \
  "$NATIVE/$native_archive"

download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" \
  "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488" \
  "$SEGMENTATION_ARCHIVE"
if [[ ! -f "$SEGMENTATION_MODEL" ]]; then
  tar -xjf "$SEGMENTATION_ARCHIVE" -C "$MODELS"
fi
verify_checksum \
  "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079" \
  "$SEGMENTATION_MODEL"
download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx" \
  "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012" \
  "$EMBEDDING_MODEL"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "${1:-}" == "--smoke" ]]; then
  shift
  download "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/fangjun-sr-1.wav" "33c24061180224d2350143ee19e3af031446995c676bd25996325d34bb20a4d5" "$FIXTURES/fangjun-sr-1.wav"
  download "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/fangjun-test-sr-1.wav" "9175e523081bf6a630ce72a55b05f92148eaafaf58cbbbe743686cd81c50848e" "$FIXTURES/fangjun-test-sr-1.wav"
  download "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/leijun-sr-1.wav" "160a3d9bf5dd5038da8191b4430e1f3f751461613ae9489401b6b35a61b488ad" "$FIXTURES/leijun-sr-1.wav"
  download "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/leijun-test-sr-1.wav" "36cda04ee4d10e38095de73b77c99e8e7c54347232967a9cde4cf54f7d496bab" "$FIXTURES/leijun-test-sr-1.wav"
  download "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/liudehua-sr-1.wav" "f39ebb7357d537009a9b7e59a6c9c0199f2204fcffb3c2d9d829a6961813eca1" "$FIXTURES/liudehua-sr-1.wav"
  download "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/liudehua-test-sr-1.wav" "a855706ad8e8253e341e3f65892c66d7dfb4bdc83675bcf38b863f2f8d167553" "$FIXTURES/liudehua-test-sr-1.wav"
  set -- \
    --labels "$ROOT/src-tauri/spikes/persona-recognition/smoke-labels.json" \
    --non-interactive \
    --resampler-smoke \
    "$FIXTURES/fangjun-sr-1.wav" \
    "$FIXTURES/fangjun-test-sr-1.wav" \
    "$FIXTURES/leijun-sr-1.wav" \
    "$FIXTURES/leijun-test-sr-1.wav" \
    "$FIXTURES/liudehua-sr-1.wav" \
    "$FIXTURES/liudehua-test-sr-1.wav" \
    "$@"
fi

if [[ "$#" -lt 2 ]]; then
  echo "Usage: pnpm persona:spike -- --smoke" >&2
  echo "   or: pnpm persona:spike -- first/system.wav second/system.wav [...]" >&2
  exit 2
fi

unset SHERPA_ONNX_LIB_DIR
SHERPA_ONNX_ARCHIVE_DIR="$NATIVE" \
SHERPA_ONNX_ARCHIVE_NAME="$native_archive" \
SHERPA_ONNX_ARCHIVE_SHA256="$native_checksum" \
CARGO_TARGET_DIR="$CACHE/target/$native_checksum" \
cargo run --locked --release --manifest-path "$CRATE" -- \
  "$@" \
  --segmentation-model "$SEGMENTATION_MODEL" \
  --embedding-model "$EMBEDDING_MODEL" \
  --output "$OUTPUT"
