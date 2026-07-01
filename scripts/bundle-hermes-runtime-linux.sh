#!/usr/bin/env bash
# Builds the self-contained Hermes runtime that ships inside the Linux app
# bundle (AppImage and deb, mapped to native/hermes), so a fresh install needs
# no multi-minute GitHub download on first launch. `hermes_bridge.rs` prefers
# this bundled runtime (`bundled_hermes_command`) and falls back to the
# on-device managed install when it is absent, so dev builds keep working
# without running this script.
#
# This is the Linux sibling of scripts/bundle-hermes-runtime.sh (macOS) and
# scripts/bundle-hermes-runtime-windows.ps1 (Windows). It reads the same pins
# from src-tauri/src/hermes_bridge.rs and produces the same output layout under
# .tauri-hermes/hermes/, so tauri.conf.json's resource mapping is unchanged.
#
# Layout produced under .tauri-hermes/hermes/ (repo root):
#   bin/hermes        relocatable launcher (resolves everything relative to
#                     itself, so it survives install-path moves)
#   python/current/   standalone CPython (uv-managed python-build-standalone,
#                     relocatable by design)
#   hermes-agent/     the pinned source checkout + its uv-synced venv
#
# Differences from the macOS script:
# - No code signing. Linux ships no OS code signature on the payload; the
#   Tauri updater key still signs the AppImage updater artifact at build time.
# - Symlink flattening. python-build-standalone on Linux carries more symlinks
#   than on macOS (a lib64 -> lib alias, unversioned libpython*.so dev links,
#   uv venv aliases). Tauri resources cannot contain symlinks, so the known
#   dev-only aliases are dropped and every surviving link is dereferenced into
#   a real copy. The self-test then proves the runtime still works.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_parent="$root/.tauri-hermes"
out="$out_parent/hermes"
bridge_rs="$root/src-tauri/src/hermes_bridge.rs"

# Pinned to match scripts/bundle-hermes-runtime-windows.ps1 so every platform
# resolves deps with the same uv release.
uv_pin="0.11.15"

skip_self_test=0
for arg in "$@"; do
  case "$arg" in
    --skip-self-test) skip_self_test=1 ;;
    *) : ;;
  esac
done

log() { printf '\033[1;34m[bundle-hermes-linux]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bundle-hermes-linux]\033[0m %s\n' "$*" >&2; exit 1; }

ensure_no_symlinks() {
  local leftover_links
  leftover_links="$(find "$out" -type l | head -5)"
  [ -z "$leftover_links" ] || die "bundle still contains symlinks:
$leftover_links"
}

sha256_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

flatten_python_symlinks() {
  # python-build-standalone (Linux) ships a lib64 -> lib alias and unversioned
  # dev symlinks (libpython3.11.so -> libpython3.11.so.1.0). Neither is needed
  # at runtime: the interpreter resolves its stdlib through lib/python3.X and
  # extensions link against the versioned soname (libpython3.X.so.1.0, a real
  # file kept in place). Drop the aliases so they never surface as symlinks.
  local py_root="$out/python/current"
  rm -f "$py_root/lib64" 2>/dev/null || true
  find "$py_root/lib" -maxdepth 1 -type l -name 'libpython*.so' -delete 2>/dev/null || true
  # uv-created venvs mirror the same lib64 -> lib alias.
  rm -f "$out/hermes-agent/venv/lib64" 2>/dev/null || true
}

dereference_remaining_symlinks() {
  # Catch-all: replace every surviving symlink with a dereferenced copy of its
  # target so nothing that was reachable becomes unreachable. Loop because
  # copying a directory target can surface further nested links; readlink -f
  # already collapses link -> link chains.
  local link resolved leftover
  for _ in 1 2 3 4 5 6; do
    leftover="$(find "$out" -type l)"
    [ -n "$leftover" ] || return 0
    while IFS= read -r link; do
      [ -n "$link" ] || continue
      if [ ! -e "$link" ]; then
        rm -f "$link"
        continue
      fi
      resolved="$(readlink -f "$link")"
      rm -rf "$link"
      cp -RL --preserve=mode,timestamps "$resolved" "$link"
    done <<<"$leftover"
  done
}

run_self_test() {
  [ "$skip_self_test" -eq 1 ] && { log "self-test skipped (--skip-self-test)"; return 0; }
  log "self-test: running the launcher from a relocated copy"
  local selftest_root selftest test_home version_output
  selftest_root="$(mktemp -d)"
  trap 'rm -rf "$selftest_root"' EXIT
  selftest="$selftest_root/re located"
  mkdir -p "$selftest"
  cp -R "$out" "$selftest/hermes"
  test_home="$selftest_root/hermes-home"
  mkdir -p "$test_home"
  version_output="$(HERMES_HOME="$test_home" "$selftest/hermes/bin/hermes" --version)" \
    || die "self-test failed: bundled hermes --version"
  case "$version_output" in
    *"$selftest/hermes/hermes-agent"*) ;;
    *) die "self-test failed: hermes resolved the wrong project root: $version_output" ;;
  esac
  "$selftest/hermes/python/current/bin/python3.11" -c "import hermes_cli.main" \
    || die "self-test failed: bare interpreter cannot import hermes_cli (pth broken)"
  rm -rf "$selftest_root"
  trap - EXIT
}

print_bundle_size() {
  du -sh "$out" | awk '{print "[bundle-hermes-linux] bundle size: " $1}'
}

bundle_is_reusable() {
  [ -f "$out/PIN" ] || return 1
  [ "$(cat "$out/PIN")" = "$commit" ] || return 1
  [ -x "$out/bin/hermes" ] || return 1
  [ -x "$out/python/current/bin/python3.11" ] || return 1
  [ -d "$out/hermes-agent" ] || return 1
  [ -f "$out/hermes-agent/hermes_cli/web_dist/index.html" ] || return 1
}

# ---- pins, read from the Rust source of truth -------------------------------
# Values may sit on the declaration line or (rustfmt) on the next line.
pin() {
  local name="$1"
  awk -v decl="const ${name}: &str =" '
    found && match($0, /"[^"]+"/) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
    index($0, decl) {
      if (match($0, /"[^"]+"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
      found = 1
    }
  ' "$bridge_rs"
}
commit="$(pin HERMES_AGENT_INSTALL_COMMIT)"
tarball_sha256="$(pin HERMES_SOURCE_TARBALL_SHA256)"
tarball_url="$(pin HERMES_SOURCE_TARBALL_URL)"
[ -n "$commit" ] || die "could not read HERMES_AGENT_INSTALL_COMMIT from $bridge_rs"
[ -n "$tarball_sha256" ] || die "could not read HERMES_SOURCE_TARBALL_SHA256 from $bridge_rs"
[ -n "$tarball_url" ] || die "could not read HERMES_SOURCE_TARBALL_URL from $bridge_rs"
log "pin: $commit"

work="$out_parent/work-linux"
if bundle_is_reusable; then
  log "using cached Hermes bundle for pin: $commit"
  ensure_no_symlinks
  run_self_test
  print_bundle_size
  log "done: $out"
  exit 0
elif [ -e "$out" ]; then
  log "cached Hermes bundle is missing required files or has a stale pin; rebuilding"
fi

# ---- uv ----------------------------------------------------------------------
rm -rf "$out" "$work"
mkdir -p "$work"
# No curl-pipe-sh here, deliberately: fetching an unpinned remote installer
# would hand execution to whoever controls (or intercepts) that URL. Prefer a
# uv already on PATH; otherwise install the pinned release from PyPI (whose
# wheels are hash-verified) via pipx or pip.
uv_cmd="$(command -v uv || true)"
if [ -z "$uv_cmd" ] && command -v pipx >/dev/null; then
  log "uv not found; installing uv $uv_pin via pipx"
  pipx install "uv==$uv_pin" >/dev/null
  uv_cmd="$(command -v uv || true)"
fi
if [ -z "$uv_cmd" ] && command -v python3 >/dev/null; then
  log "uv not found; installing uv $uv_pin via pip --user"
  python3 -m pip install --user "uv==$uv_pin" >/dev/null 2>&1 \
    || python3 -m pip install --user --break-system-packages "uv==$uv_pin" >/dev/null 2>&1 \
    || true
  uv_cmd="$(command -v uv || true)"
  if [ -z "$uv_cmd" ]; then
    user_base="$(python3 -m site --user-base 2>/dev/null || true)"
    [ -n "$user_base" ] && [ -x "$user_base/bin/uv" ] && uv_cmd="$user_base/bin/uv"
  fi
fi
[ -n "$uv_cmd" ] || die "uv is required: install it via 'pipx install uv' or https://docs.astral.sh/uv/"
log "uv: $("$uv_cmd" --version)"

# ---- source checkout, integrity-pinned ---------------------------------------
log "downloading hermes-agent@$commit"
curl -LsSf "$tarball_url" -o "$work/hermes-agent.tar.gz"
actual_sha256="$(sha256_of "$work/hermes-agent.tar.gz")"
[ "$actual_sha256" = "$tarball_sha256" ] || die "tarball sha256 mismatch: expected $tarball_sha256, got $actual_sha256"
tar -xzf "$work/hermes-agent.tar.gz" -C "$work"
unpacked="$(find "$work" -maxdepth 1 -type d -name 'hermes-agent-*' | head -1)"
[ -n "$unpacked" ] || die "tarball did not contain a hermes-agent directory"
mkdir -p "$out"
mv "$unpacked" "$out/hermes-agent"

# Dev-only weight the runtime never imports. Conservative on purpose: web/ and
# ui-tui/ stay (hermes resolves them relative to its project root), and they
# are small without node_modules, which we never ship.
for prune in tests website apps .github; do
  rm -rf "$out/hermes-agent/$prune"
done

hermes_license_files="$(find "$out/hermes-agent" -type f \( \
  -name 'LICENSE' -o -name 'LICENSE.*' -o \
  -name 'NOTICE' -o -name 'NOTICE.*' -o \
  -name 'COPYING' -o -name 'COPYING.*' \
\) | sort)"
[ -f "$out/hermes-agent/LICENSE" ] || die "hermes-agent LICENSE missing from pinned tarball"
[ -n "$hermes_license_files" ] || die "no Hermes license or notice files found"
mkdir -p "$out/third_party_notices"
{
  printf 'Third-party notices for bundled Hermes runtime\n\n'
  printf 'Hermes Agent source: %s\n' "$tarball_url"
  printf 'Hermes Agent commit: %s\n\n' "$commit"
  printf 'Preserved upstream license and notice files:\n'
  while IFS= read -r license_file; do
    printf -- '- hermes-agent/%s\n' "${license_file#"$out"/hermes-agent/}"
  done <<<"$hermes_license_files"
} > "$out/third_party_notices/THIRD_PARTY_NOTICES.txt"

# The tarball has no prebuilt dashboard assets — on-device installs build them
# in the "node-deps" stage. Build them here instead (vite outputs to
# hermes_cli/web_dist per web/vite.config.ts) and drop node_modules afterwards.
command -v npm >/dev/null || die "npm is required to prebuild the dashboard web UI"
log "prebuilding dashboard web UI"
web_log="$work/web-build.log"
if ! (cd "$out/hermes-agent/web" && npm ci --no-audit --no-fund && npm run build) >"$web_log" 2>&1; then
  tail -40 "$web_log" >&2
  die "web UI build failed (full log: $web_log)"
fi
# npm workspaces hoist installs to the repo root; prune every node_modules the
# build produced so none of its .bin symlinks reach the no-symlinks gate. The
# dashboard serves the prebuilt web_dist and June never launches the Node TUI.
rm -rf "$out/hermes-agent/node_modules" \
  "$out/hermes-agent/web/node_modules" \
  "$out/hermes-agent/ui-tui/node_modules"
[ -f "$out/hermes-agent/hermes_cli/web_dist/index.html" ] || die "web_dist missing after build"

# ---- relocatable CPython + hash-verified deps --------------------------------
log "installing standalone CPython 3.11"
UV_PYTHON_INSTALL_DIR="$out/python" UV_PYTHON_INSTALL_BIN=0 UV_NO_CONFIG=1 \
  "$uv_cmd" python install 3.11 >/dev/null
pydir="$(find "$out/python" -maxdepth 1 -type d -name 'cpython-3.11*' | head -1)"
[ -n "$pydir" ] || die "uv did not install a cpython-3.11 runtime"
# Fixed name so the launcher needs no globbing (paths with spaces stay safe).
mv "$pydir" "$out/python/current"
py="$out/python/current/bin/python3.11"
[ -x "$py" ] || die "bundled python missing at $py"

# Drop uv's version-alias link, the bin convenience links (the launcher execs
# python3.11 directly and hermes re-execs sys.executable), and dev-only
# pkgconfig/man trees whose files are links too.
find "$out/python" -maxdepth 1 -type l -delete
find "$out/python/current/bin" -type l -delete
rm -rf "$out/python/current/lib/pkgconfig" "$out/python/current/share"

# Drop the tcl/tk GUI tier. The agent runtime is headless and never imports
# tkinter, and linuxdeploy dependency-walks every ELF in the AppDir but does
# not search the bundle's own lib/ for _tkinter's libtcl, so shipping it
# breaks AppImage packaging (and costs ~20 MB).
find "$out/python/current/lib" -maxdepth 1 \( \
  -name 'libtcl*' -o -name 'libtk*' -o \
  -name 'tcl[0-9]*' -o -name 'tk[0-9]*' -o \
  -name 'itcl*' -o -name 'thread[0-9]*' \
\) -exec rm -rf {} +
stdlib_dir="$out/python/current/lib/python3.11"
rm -rf "$stdlib_dir/tkinter" "$stdlib_dir/idlelib" "$stdlib_dir/turtledemo" \
  "$stdlib_dir/turtle.py"
find "$stdlib_dir/lib-dynload" -name '_tkinter*' -delete

log "installing python deps (uv sync --extra all --locked)"
# Same tiers as install.sh "python-deps": the hash-verified lockfile sync
# first; when the shipped lockfile is out of sync with pyproject (it is at the
# current pin), fall back to resolving the curated [all] extra from PyPI.
(
  cd "$out/hermes-agent"
  export UV_PROJECT_ENVIRONMENT="$out/hermes-agent/venv"
  export UV_NO_CONFIG=1
  export UV_PYTHON_INSTALL_DIR="$out/python"
  if ! "$uv_cmd" sync --extra all --locked --python "$py" >/dev/null 2>&1; then
    log "lockfile sync unavailable; falling back to: uv pip install -e .[all]"
    "$uv_cmd" pip install -p "$out/hermes-agent/venv" -e ".[all]" >/dev/null
  fi
)

venv_sp="$(find "$out/hermes-agent/venv/lib" -maxdepth 1 -type d -name 'python3.*' | head -1)/site-packages"
[ -d "$venv_sp" ] || die "venv site-packages missing"
base_sp="$(find "$out/python/current/lib" -maxdepth 1 -type d -name 'python3.*' | head -1)/site-packages"
[ -d "$base_sp" ] || die "base site-packages missing"
pyver_dir="$(basename "$(dirname "$venv_sp")")"

# The venv's editable hooks and bin/ scripts encode absolute build-machine
# paths and are never executed at runtime (the launcher and the .pth below
# replace them).
find "$venv_sp" -maxdepth 1 \( -name '*editable*' -o -name '_hermes*' \) -exec rm -rf {} +
rm -rf "$out/hermes-agent/venv/bin"

# Make the bare base interpreter resolve hermes + deps via relative paths.
rel_root="../../../../.."
cat > "$base_sp/hermes-bundle.pth" <<EOF
$rel_root/hermes-agent
$rel_root/hermes-agent/venv/lib/$pyver_dir/site-packages
EOF

# Never write .pyc into the bundle after packaging.
cat > "$base_sp/sitecustomize.py" <<'EOF'
# Generated by scripts/bundle-hermes-runtime-linux.sh.
import sys

sys.dont_write_bytecode = True
EOF

log "precompiling bytecode (checked-hash)"
# Some shipped templates/vendored files don't compile; that only costs them the
# precompile (sitecustomize stops runtime writes), so don't fail the build.
"$py" -m compileall -q --invalidation-mode checked-hash "$out/hermes-agent" "$base_sp" >/dev/null 2>&1 || true

# No symlinks may survive anywhere in the bundle (Tauri resource limitation).
# Drop the known Linux dev-only aliases, then dereference anything left, and
# fail loudly here instead of opaquely at app-bundling time.
flatten_python_symlinks
dereference_remaining_symlinks
ensure_no_symlinks

# ---- launcher -----------------------------------------------------------------
mkdir -p "$out/bin"
cat > "$out/bin/hermes" <<'EOF'
#!/bin/sh
# Relocatable launcher for the bundled Hermes runtime. Everything resolves
# relative to this file, so the bundle works from any install path. Module
# resolution comes from hermes-bundle.pth inside the bundled interpreter, so
# re-execs of bare sys.executable resolve identically.
here="$(cd "$(dirname "$0")/.." && pwd)"
exec "$here/python/current/bin/python3.11" -m hermes_cli.main "$@"
EOF
chmod +x "$out/bin/hermes"

# Stamp the bundle with its source pin. build.rs compares this against the pins
# in hermes_bridge.rs and evicts a stale bundle instead of shipping it.
printf '%s\n' "$commit" > "$out/PIN"

# ---- self-test: prove relocatability from a moved path with a space -----------
run_self_test

rm -rf "$work"
print_bundle_size
log "done: $out"
