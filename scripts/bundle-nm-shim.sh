#!/usr/bin/env bash
# macOS beforeBundleCommand (tauri.macos.conf.json): copies the compiled
# june-nm-shim [[bin]] into .tauri-helper/ so the bundle.resources mapping
# ships the real binary instead of the build.rs placeholder, then signs it the
# way the Swift helpers are signed (Developer ID when APPLE_SIGNING_IDENTITY
# is set, ad-hoc otherwise). Runs after cargo build and before bundling, so
# the binary always exists here; failing loudly beats bundling a placeholder.
set -euo pipefail

cd "$(dirname "$0")/.."

profile="release"
if [[ "${TAURI_ENV_DEBUG:-false}" == "true" ]]; then
  profile="debug"
fi

candidates=(
  "src-tauri/target/${TAURI_ENV_TARGET_TRIPLE:-}/$profile/june-nm-shim"
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

mkdir -p .tauri-helper
cp -f "$shim" .tauri-helper/june-nm-shim
chmod +x .tauri-helper/june-nm-shim

identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -n "${identity// /}" ]]; then
  codesign --force --entitlements src-tauri/Entitlements.plist \
    --sign "$identity" --timestamp --options runtime .tauri-helper/june-nm-shim
else
  codesign --force --entitlements src-tauri/Entitlements.plist \
    --sign - .tauri-helper/june-nm-shim
fi

echo "bundled june-nm-shim from $shim"
