#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "run" ]]; then
  exec cargo "$@"
fi

shift

cargo_args=()
app_args=()
after_separator=false
expect_target=false
profile="debug"
target_triple=""

for arg in "$@"; do
  if [[ "$after_separator" == true ]]; then
    app_args+=("$arg")
    continue
  fi

  if [[ "$arg" == "--" ]]; then
    after_separator=true
    continue
  fi

  cargo_args+=("$arg")

  if [[ "$expect_target" == true ]]; then
    target_triple="$arg"
    expect_target=false
    continue
  fi

  case "$arg" in
    --release)
      profile="release"
      ;;
    --target)
      expect_target=true
      ;;
    --target=*)
      target_triple="${arg#--target=}"
      ;;
  esac
done

# The Computer use helper is prepared and signed separately before Tauri runs.
# Building only June here prevents Cargo from relinking that helper with the
# app's lower deployment target or a different active Swift toolchain.
cargo build --bin os-june "${cargo_args[@]}"

target_dir="${CARGO_TARGET_DIR:-target}"
if [[ "$target_dir" != /* ]]; then
  target_dir="$(pwd)/$target_dir"
fi

if [[ -n "$target_triple" ]]; then
  bin_dir="$target_dir/$target_triple/$profile"
else
  bin_dir="$target_dir/$profile"
fi

binary="$bin_dir/os-june"
launcher_name="${OS_JUNE_DEV_APP_NAME:-June}"
if [[ -z "$launcher_name" || "$launcher_name" == */* || "$launcher_name" == *:* || "$launcher_name" == *$'\n'* || ${#launcher_name} -gt 80 ]]; then
  echo "Invalid development app name: $launcher_name" >&2
  exit 2
fi
launcher="$bin_dir/$launcher_name"
tmp_launcher="$bin_dir/.June-launcher.tmp"

rm -f "$tmp_launcher"
# Keep the product-named launcher and Cargo's canonical binary on the same
# inode. The Computer use helper verifies this identity before accepting the
# private peer, including issue-suffixed Codex and Claude development names.
ln "$binary" "$tmp_launcher"
chmod +x "$tmp_launcher"
mv -f "$tmp_launcher" "$launcher"

if [[ "${#app_args[@]}" -gt 0 ]]; then
  exec "$launcher" "${app_args[@]}"
else
  exec "$launcher"
fi
