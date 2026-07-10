#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="$root/.tauri-personas/personas"
cache="$root/.tauri-personas/cache"
native="$root/.tauri-personas/native"
segmentation_archive="$cache/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
segmentation_dir="$cache/sherpa-onnx-pyannote-segmentation-3-0"
embedding_model="$cache/wespeaker_en_voxceleb_resnet34_LM.onnx"

mkdir -p "$cache" "$bundle" "$native"

verify() {
  local expected="$1"
  local path="$2"
  local actual
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  else
    actual="$(sha256sum "$path" | awk '{print $1}')"
  fi
  [ "$actual" = "$expected" ] || {
    echo "Checksum mismatch for $path: expected $expected, got $actual" >&2
    exit 1
  }
}

download() {
  local url="$1"
  local expected="$2"
  local destination="$3"
  if [ ! -f "$destination" ]; then
    curl -L --fail --silent --show-error "$url" -o "$destination.partial"
    mv "$destination.partial" "$destination"
  fi
  verify "$expected" "$destination"
}

download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" \
  "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488" \
  "$segmentation_archive"
if [ ! -f "$segmentation_dir/model.onnx" ]; then
  tar -xjf "$segmentation_archive" -C "$cache"
fi
verify \
  "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079" \
  "$segmentation_dir/model.onnx"

download \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx" \
  "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012" \
  "$embedding_model"

platform="$(uname -s)"
architecture="$(uname -m)"
case "$platform/$architecture" in
  Darwin/*)
    download \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-osx-arm64-static-lib.tar.bz2" \
      "57801db2bbb786a5d343f515a38ff210b401842338bdc804fa075312d1cd2404" \
      "$native/sherpa-onnx-v1.13.4-osx-arm64-static-lib.tar.bz2"
    download \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-osx-x64-static-lib.tar.bz2" \
      "2bda2c10b31a1cfc45d9f9e14bd4983743ec3779d309e42d99a6c8fa1689043f" \
      "$native/sherpa-onnx-v1.13.4-osx-x64-static-lib.tar.bz2"
    ;;
  Linux/aarch64 | Linux/arm64)
    download \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-linux-aarch64-static-lib.tar.bz2" \
      "23b33616787cc949d5b1438e9794550f805e208a014c5c2245483207c58bbc0f" \
      "$native/sherpa-onnx-v1.13.4-linux-aarch64-static-lib.tar.bz2"
    ;;
  Linux/x86_64)
    download \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-linux-x64-static-lib.tar.bz2" \
      "98b0e31996426f6e78244dbce1955548f2c64e8f01c4be75b85af7cdaa2e8d5c" \
      "$native/sherpa-onnx-v1.13.4-linux-x64-static-lib.tar.bz2"
    ;;
  *)
    echo "Unsupported Persona runtime platform: $platform/$architecture" >&2
    exit 1
    ;;
esac

cp "$segmentation_dir/model.onnx" "$bundle/segmentation.onnx"
cp "$embedding_model" "$bundle/embedding.onnx"
cp "$segmentation_dir/LICENSE" "$bundle/LICENSE-segmentation-mit.txt"
cp "$root/src-tauri/resources/personas/THIRD_PARTY_NOTICES.txt" "$bundle/THIRD_PARTY_NOTICES.txt"
rm -f "$bundle/PLACEHOLDER.md"
printf '%s\n' "sherpa-onnx-1.13.4-wespeaker-voxceleb-resnet34-lm" > "$bundle/PIN"

echo "Bundled Persona models in $bundle"
echo "Verified sherpa-onnx native archives in $native"
