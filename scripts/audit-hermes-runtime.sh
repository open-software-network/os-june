#!/usr/bin/env bash
# Verifies that a macOS Hermes resource bundle contains two complete runtime
# trees and that every native file belongs to, and supports, its tree's CPU.
set -euo pipefail

bundle="${1:-}"
if [ -z "$bundle" ]; then
  echo "usage: $0 <hermes-bundle> [--require-signed]" >&2
  exit 2
fi
shift

require_signed=0
if [ "${1:-}" = "--require-signed" ]; then
  require_signed=1
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "usage: $0 <hermes-bundle> [--require-signed]" >&2
  exit 2
fi

die() {
  printf '[hermes-arch-audit] %s\n' "$*" >&2
  exit 1
}

[ -d "$bundle" ] || die "bundle directory does not exist: $bundle"
[ -x "$bundle/bin/hermes" ] || die "relocatable Hermes launcher is missing"
[ -x "$bundle/bin/python3" ] || die "relocatable Python launcher is missing"
[ -f "$bundle/ARCHITECTURES" ] || die "ARCHITECTURES provenance stamp is missing"

architectures="$(tr '\n' ' ' < "$bundle/ARCHITECTURES" | awk '{$1=$1; print}')"
[ "$architectures" = "arm64 x86_64" ] \
  || die "ARCHITECTURES must be exactly 'arm64 x86_64', got: ${architectures:-<empty>}"

leftover_links="$(find "$bundle" -type l | head -5)"
[ -z "$leftover_links" ] || die "bundle contains symlinks:
$leftover_links"

for arch in arm64 x86_64; do
  case "$arch" in
    arm64) target=aarch64-apple-darwin ;;
    x86_64) target=x86_64-apple-darwin ;;
  esac
  python="$bundle/python/$arch/current/bin/python3.11"
  site_packages="$bundle/site-packages/$arch"
  target_stamp="$bundle/python/$arch/TARGET"
  [ -x "$python" ] || die "$arch interpreter is missing: $python"
  [ -d "$site_packages" ] || die "$arch dependency tree is missing: $site_packages"
  [ -f "$target_stamp" ] || die "$arch target provenance stamp is missing"
  [ "$(cat "$target_stamp")" = "$target" ] \
    || die "$arch target provenance stamp is invalid"
done

arm64_count=0
x86_64_count=0
while IFS= read -r -d '' candidate && IFS= read -r description; do
  description="${description#: }"
  case "$description" in
    *Mach-O*) ;;
    *)
      case "$candidate" in
        *.so|*.dylib) die "native library is not Mach-O: $candidate ($description)" ;;
      esac
      if [ -x "$candidate" ]; then
        case "$description" in
          *ELF*|*PE32*|*MS-DOS*)
            die "executable uses a non-macOS native format: $candidate ($description)"
            ;;
        esac
      fi
      continue
      ;;
  esac

  case "$candidate" in
    "$bundle/python/arm64/"*|"$bundle/site-packages/arm64/"*)
      expected=arm64
      arm64_count=$((arm64_count + 1))
      ;;
    "$bundle/python/x86_64/"*|"$bundle/site-packages/x86_64/"*)
      expected=x86_64
      x86_64_count=$((x86_64_count + 1))
      ;;
    *)
      die "Mach-O file is outside an architecture-owned runtime tree: $candidate"
      ;;
  esac

  supported="$(lipo -archs "$candidate" 2>/dev/null)" \
    || die "could not read Mach-O architectures: $candidate"
  case " $supported " in
    *" $expected "*) ;;
    *) die "$candidate belongs to $expected but supports only: $supported" ;;
  esac

  if [ "$require_signed" -eq 1 ]; then
    codesign --verify --strict "$candidate" >/dev/null 2>&1 \
      || die "Mach-O file is not validly signed: $candidate"
    signature_details="$(codesign -dv --verbose=4 "$candidate" 2>&1)" \
      || die "could not inspect Mach-O signature: $candidate"
    printf '%s\n' "$signature_details" | grep -Eq 'flags=.*runtime' \
      || die "Mach-O file is not signed with the hardened runtime: $candidate"
  fi
done < <(find "$bundle" -type f -exec file -0 -N {} +)

[ "$arm64_count" -gt 0 ] || die "arm64 runtime contains no audited Mach-O files"
[ "$x86_64_count" -gt 0 ] || die "x86_64 runtime contains no audited Mach-O files"

printf '[hermes-arch-audit] arm64 Mach-O files: %s\n' "$arm64_count"
printf '[hermes-arch-audit] x86_64 Mach-O files: %s\n' "$x86_64_count"
if [ "$require_signed" -eq 1 ]; then
  printf '[hermes-arch-audit] every audited Mach-O has a valid hardened-runtime signature\n'
fi
