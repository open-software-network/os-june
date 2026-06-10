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

cargo build "${cargo_args[@]}"

target_dir="${CARGO_TARGET_DIR:-target}"
if [[ "$target_dir" != /* ]]; then
  target_dir="$(pwd)/$target_dir"
fi

if [[ -n "$target_triple" ]]; then
  bin_dir="$target_dir/$target_triple/$profile"
else
  bin_dir="$target_dir/$profile"
fi

binary="$bin_dir/os-scribe"
launcher="$bin_dir/June"
tmp_launcher="$bin_dir/.June.tmp"

rm -f "$tmp_launcher"
cp "$binary" "$tmp_launcher"
chmod +x "$tmp_launcher"
mv -f "$tmp_launcher" "$launcher"

if [[ "${#app_args[@]}" -gt 0 ]]; then
  exec "$launcher" "${app_args[@]}"
else
  exec "$launcher"
fi
