#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SIGNING_ENV_FILE="${SIGNING_ENV_FILE:-$ROOT_DIR/.env.signing}"
TEMP_DIR=""
CERTIFICATE_FILE=""

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

ensure_temp_dir() {
  if [[ -z "$TEMP_DIR" ]]; then
    TEMP_DIR="$(mktemp -d)"
  fi
}

import_signing_certificate() {
  ensure_temp_dir
  local keychain="$TEMP_DIR/os-june-signing.keychain-db"
  local keychain_password="os-june-$RANDOM-$$"

  security create-keychain -p "$keychain_password" "$keychain" >/dev/null
  security set-keychain-settings -lut 21600 "$keychain" >/dev/null
  security unlock-keychain -p "$keychain_password" "$keychain" >/dev/null
  security import "$CERTIFICATE_FILE" \
    -k "$keychain" \
    -P "$APPLE_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign \
    -T /usr/bin/security \
    >/dev/null
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -s \
    -k "$keychain_password" \
    "$keychain" \
    >/dev/null
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"') >/dev/null
}

if [[ -f "$SIGNING_ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      echo "Invalid signing env line in $SIGNING_ENV_FILE: $line" >&2
      exit 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "Invalid signing env key in $SIGNING_ENV_FILE: $key" >&2
      exit 1
    fi
    if [[ ${#value} -ge 2 ]]; then
      first="${value:0:1}"
      last="${value: -1}"
      if [[ ("$first" == "\"" && "$last" == "\"") || ("$first" == "'" && "$last" == "'") ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    export "$key=$value"
  done < "$SIGNING_ENV_FILE"
fi

missing=0
for name in \
  APPLE_CERTIFICATE_PASSWORD \
  APPLE_SIGNING_IDENTITY \
  APPLE_API_ISSUER \
  APPLE_API_KEY
do
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required to build a distributable signed and notarized DMG." >&2
    missing=1
  fi
done

if [[ -z "${APPLE_CERTIFICATE:-}" && -z "${APPLE_CERTIFICATE_PATH:-}" ]]; then
  echo "APPLE_CERTIFICATE or APPLE_CERTIFICATE_PATH is required to build a distributable signed and notarized DMG." >&2
  missing=1
fi

if [[ -z "${APPLE_API_KEY_PATH:-}" && -z "${APPLE_API_KEY_P8:-}" && -z "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
  echo "One of APPLE_API_KEY_PATH, APPLE_API_KEY_P8, or APPLE_API_KEY_P8_BASE64 is required." >&2
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

if [[ -n "${APPLE_CERTIFICATE_PATH:-}" ]]; then
  if [[ "$APPLE_CERTIFICATE_PATH" != /* ]]; then
    APPLE_CERTIFICATE_PATH="$ROOT_DIR/$APPLE_CERTIFICATE_PATH"
  fi
  if [[ ! -f "$APPLE_CERTIFICATE_PATH" ]]; then
    echo "APPLE_CERTIFICATE_PATH does not point to a readable file: $APPLE_CERTIFICATE_PATH" >&2
    exit 1
  fi
  CERTIFICATE_FILE="$APPLE_CERTIFICATE_PATH"
  export APPLE_CERTIFICATE="$(base64 -i "$APPLE_CERTIFICATE_PATH" | tr -d '\n')"
else
  if ! printf '%s' "$APPLE_CERTIFICATE" | base64 --decode >/dev/null 2>&1; then
    echo "APPLE_CERTIFICATE is not valid one-line base64. Regenerate it with: base64 -i /path/to/certificate.p12 | tr -d '\\n'" >&2
    exit 1
  fi
  ensure_temp_dir
  CERTIFICATE_FILE="$TEMP_DIR/apple-certificate.p12"
  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$CERTIFICATE_FILE"
fi

import_signing_certificate

if [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
  if [[ "$APPLE_API_KEY_PATH" != /* ]]; then
    export APPLE_API_KEY_PATH="$ROOT_DIR/$APPLE_API_KEY_PATH"
  fi
  if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
    echo "APPLE_API_KEY_PATH does not point to a readable file: $APPLE_API_KEY_PATH" >&2
    exit 1
  fi
elif [[ -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
  ensure_temp_dir
  export APPLE_API_KEY_PATH="$TEMP_DIR/AuthKey_${APPLE_API_KEY}.p8"
  printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$APPLE_API_KEY_PATH"
elif [[ -n "${APPLE_API_KEY_P8:-}" ]]; then
  ensure_temp_dir
  export APPLE_API_KEY_PATH="$TEMP_DIR/AuthKey_${APPLE_API_KEY}.p8"
  printf '%s' "$APPLE_API_KEY_P8" | perl -pe 's/\\n/\n/g' > "$APPLE_API_KEY_PATH"
fi

cd "$ROOT_DIR"
# Build a universal Node 24 SEA after the Developer ID certificate is imported.
# The official architecture-specific Node executables are checksummed before
# injection; the resulting universal runtime is signed before Tauri signs the
# outer application bundle.
node_version="$(node -p 'process.versions.node')"
if [[ "$node_version" != 24.* ]]; then
  echo "Node 24 is required to build the agent runtime, got $node_version." >&2
  exit 1
fi
ensure_temp_dir
node_download_dir="$TEMP_DIR/node-24-sea"
mkdir -p "$node_download_dir"
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" \
  --output "$node_download_dir/SHASUMS256.txt"
for architecture in arm64 x64; do
  archive="node-v${node_version}-darwin-${architecture}.tar.gz"
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/v${node_version}/${archive}" \
    --output "$node_download_dir/$archive"
  (
    cd "$node_download_dir"
    grep "  ${archive}$" SHASUMS256.txt | shasum -a 256 -c -
    tar -xzf "$archive"
  )
done
export JUNE_AGENT_RUNTIME_TARGET="universal-apple-darwin"
export JUNE_AGENT_RUNTIME_NODE_ARM64="$node_download_dir/node-v${node_version}-darwin-arm64/bin/node"
export JUNE_AGENT_RUNTIME_NODE_X64="$node_download_dir/node-v${node_version}-darwin-x64/bin/node"
pnpm agent-runtime:build
node scripts/build-agent-runtime.mjs
runtime_smoke_dir="$TEMP_DIR/June agent runtime smoke"
mkdir -p "$runtime_smoke_dir"
cp .tauri-agent-runtime/june-agent-runtime "$runtime_smoke_dir/june-agent-runtime"
node scripts/build-agent-runtime.mjs --smoke "$runtime_smoke_dir/june-agent-runtime" --smoke-arch arm64
node scripts/build-agent-runtime.mjs --smoke "$runtime_smoke_dir/june-agent-runtime" --smoke-arch x86_64
export JUNE_AGENT_RUNTIME_PREBUILT=1
# Build the nested helper for the same universal target as the Tauri app before
# the generic before-build hook runs. The preparation stamp lets that hook reuse
# the universal release helper instead of replacing it with the runner's slice.
computer_use_target="universal-apple-darwin"
computer_use_prepare_args=(--release --target "$computer_use_target")
tauri_build_args=()
build_args=("$@")
for ((index = 0; index < ${#build_args[@]}; index += 1)); do
  argument="${build_args[$index]}"
  if [[ "$argument" == "--target" ]]; then
    if ((index + 1 >= ${#build_args[@]})); then
      echo "--target requires a value" >&2
      exit 2
    fi
    requested_target="${build_args[$((index + 1))]}"
    if [[ "$requested_target" != "$computer_use_target" ]]; then
      echo "Signed macOS releases require --target $computer_use_target, got $requested_target." >&2
      exit 2
    fi
    ((index += 1))
    continue
  fi
  if [[ "$argument" == --target=* ]]; then
    requested_target="${argument#--target=}"
    if [[ "$requested_target" != "$computer_use_target" ]]; then
      echo "Signed macOS releases require --target $computer_use_target, got $requested_target." >&2
      exit 2
    fi
    continue
  fi
  tauri_build_args+=("$argument")
done
pnpm computer-use:prepare -- "${computer_use_prepare_args[@]}"
# Trailing args after `--` reach the cargo runner; --locked keeps the
# signed build from re-resolving past Cargo.lock (spec/package-install-security.md).
pnpm tauri build --bundles app,dmg --target "$computer_use_target" "${tauri_build_args[@]}" -- --locked

# Validate the copy inside the signed app, not the pre-bundle staging resource.
# Hosted staging runners run the deterministic contract gate; a pre-granted
# desktop release runner can opt into the live TCC/capture/background-action
# fixture with JUNE_COMPUTER_USE_LIVE_SELF_TEST=1.
computer_use_self_test_args=()
if [[ -n "$computer_use_target" ]]; then
  computer_use_self_test_args+=(--target "$computer_use_target")
fi
if [[ "${JUNE_COMPUTER_USE_LIVE_SELF_TEST:-0}" == "1" ]]; then
  computer_use_self_test_args+=(--live)
fi
./scripts/computer-use-release-self-test.sh "${computer_use_self_test_args[@]}"

shopt -s nullglob
apps=(
  "$ROOT_DIR"/src-tauri/target/universal-apple-darwin/release/bundle/macos/*.app
  "$ROOT_DIR"/src-tauri/target/release/bundle/macos/*.app
)
if [[ "${#apps[@]}" -ne 1 ]]; then
  echo "Expected exactly one universal app bundle after build, found ${#apps[@]}." >&2
  exit 1
fi
app="${apps[0]}"
runtime="$app/Contents/Resources/native/bin/june-agent-runtime"
runtime_checksum="$runtime.sha256"
[[ -x "$runtime" ]]
[[ -s "$runtime_checksum" ]]
[[ "$(shasum -a 256 "$runtime" | awk '{print $1}')" == "$(tr -d '[:space:]' < "$runtime_checksum")" ]]
[[ "$(lipo -archs "$runtime" | tr ' ' '\n' | sort | tr '\n' ' ')" == "arm64 x86_64 " ]]
codesign --verify --strict --verbose=2 "$runtime"
if find "$app/Contents/Resources" \( -iname '*hermes*' -o -iname 'python.exe' -o -iname 'python3' \) -print -quit | grep -q .; then
  echo "The signed app still contains a Hermes or Python payload." >&2
  exit 1
fi
packaged_runtime_smoke_dir="$TEMP_DIR/June packaged runtime smoke"
mkdir -p "$packaged_runtime_smoke_dir"
cp "$runtime" "$packaged_runtime_smoke_dir/june-agent-runtime"
node scripts/build-agent-runtime.mjs --smoke "$packaged_runtime_smoke_dir/june-agent-runtime" --smoke-arch arm64
node scripts/build-agent-runtime.mjs --smoke "$packaged_runtime_smoke_dir/june-agent-runtime" --smoke-arch x86_64
codesign --verify --deep --strict --verbose=2 "$app"

dmgs=(
  "$ROOT_DIR"/src-tauri/target/*-apple-darwin/release/bundle/dmg/*.dmg
  "$ROOT_DIR"/src-tauri/target/release/bundle/dmg/*.dmg
)
if [[ "${#dmgs[@]}" -eq 0 ]]; then
  echo "No DMG artifacts found after build." >&2
  exit 1
fi

for dmg in "${dmgs[@]}"; do
  xcrun notarytool submit "$dmg" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type install --verbose "$dmg"
done
