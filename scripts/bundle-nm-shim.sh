#!/usr/bin/env bash
# macOS beforeBundleCommand (tauri.macos.conf.json): copies the compiled
# june-nm-shim [[bin]] into .tauri-helper/ so the bundle.resources mapping
# ships the real binary instead of the build.rs placeholder, then signs it the
# way the Swift helpers are signed (Developer ID when APPLE_SIGNING_IDENTITY
# is set, ad-hoc otherwise). Runs after cargo build and before bundling.
#
# Target resolution mirrors scripts/prepare-cua-driver.mjs: the release
# pipeline builds --target universal-apple-darwin, a pseudo-triple cargo
# never populates with [[bin]] outputs - tauri lipo's only the main binary
# into it. The shim must therefore be lipo'd here from the two real-triple
# builds; falling through to a bare target/release binary on a universal
# build would silently bundle a stale single-arch shim from an unrelated
# local build.
set -euo pipefail

cd "$(dirname "$0")/.."

profile="release"
if [[ "${TAURI_ENV_DEBUG:-false}" == "true" ]]; then
  profile="debug"
fi

triple="${TAURI_ENV_TARGET_TRIPLE:-}"
mkdir -p .tauri-helper
out=".tauri-helper/june-nm-shim"

if [[ "$triple" == "universal-apple-darwin" ]]; then
  arm="src-tauri/target/aarch64-apple-darwin/$profile/june-nm-shim"
  x86="src-tauri/target/x86_64-apple-darwin/$profile/june-nm-shim"
  for bin in "$arm" "$x86"; do
    if [[ ! -f "$bin" ]]; then
      echo "june-nm-shim missing for universal bundle: $bin" >&2
      exit 1
    fi
  done
  lipo -create "$arm" "$x86" -output "$out"
  archs="$(lipo -archs "$out")"
  if [[ "$archs" != *arm64* || "$archs" != *x86_64* ]]; then
    echo "universal june-nm-shim has wrong architectures: $archs" >&2
    exit 1
  fi
  src="lipo($arm, $x86)"
else
  # Single real triple (or none, e.g. `tauri dev`, whose cargo build writes
  # to the bare target dir even though the env names the host triple).
  candidates=(
    "src-tauri/target/${triple}/$profile/june-nm-shim"
    "src-tauri/target/$profile/june-nm-shim"
  )

  shim=""
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      shim="$candidate"
      break
    fi
  done

  if [[ -z "$shim" ]]; then
    echo "june-nm-shim binary not found (looked in: ${candidates[*]})" >&2
    exit 1
  fi
  cp -f "$shim" "$out"
  src="$shim"
fi

chmod +x "$out"

identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -n "${identity// /}" ]]; then
  codesign --force --entitlements src-tauri/Entitlements.plist \
    --sign "$identity" --timestamp --options runtime "$out"
else
  codesign --force --entitlements src-tauri/Entitlements.plist \
    --sign - "$out"
fi

echo "bundled june-nm-shim from $src"
