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
  local keychain="$TEMP_DIR/os-scribe-signing.keychain-db"
  local keychain_password="os-scribe-$RANDOM-$$"

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
# Build the bundled Hermes runtime before the app so first launch needs no
# network install. Runs after the keychain import above so its Mach-O files
# (python, extension .so) get the Developer ID + hardened runtime signature
# notarization requires.
./scripts/bundle-hermes-runtime.sh
pnpm tauri build --bundles dmg "$@"

shopt -s nullglob
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
done
