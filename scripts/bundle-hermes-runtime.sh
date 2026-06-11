#!/usr/bin/env bash
# Builds the self-contained Hermes runtime that ships inside the app bundle
# (Resources/native/hermes), so a fresh install needs no multi-minute GitHub
# download on first launch. `hermes_bridge.rs` prefers this bundled runtime
# (`bundled_hermes_command`) and falls back to the on-device managed install
# when it is absent, so dev builds keep working without running this script.
#
# Layout produced under .tauri-hermes/hermes/ (repo root):
#   bin/hermes        relocatable launcher (resolves everything relative to
#                     itself, so it survives /Applications, renames, and
#                     Gatekeeper app translocation)
#   python/current/   standalone CPython (uv-managed python-build-standalone,
#                     relocatable by design)
#   hermes-agent/     the pinned source checkout + its uv-synced venv
#
# Design notes, hard-won:
# - The commit/sha256 pins are read from src-tauri/src/hermes_bridge.rs so the
#   bundled runtime and the managed-install fallback can never drift apart.
# - Dependencies install via `uv sync --extra all --locked` — the same
#   hash-verified tier the on-device installer uses (install.sh "python-deps").
# - The launcher runs the BASE python, not the venv python: venvs encode
#   absolute build-machine paths (pyvenv.cfg home, bin symlinks, shebangs)
#   and cannot be relocated reliably. A .pth in the base interpreter's
#   site-packages adds the checkout and the venv's site-packages via paths
#   RELATIVE to the .pth itself. This also makes bare `sys.executable`
#   invocations work (the gateway's launchd job re-execs the interpreter
#   directly, bypassing our launcher).
# - sitecustomize.py pins sys.dont_write_bytecode and compileall uses
#   checked-hash invalidation: Python must never write .pyc files into the
#   bundle after signing, or it would break the app's code signature seal.
# - Every Mach-O (python binary, dylibs, extension .so's) is signed with the
#   Developer ID + hardened runtime when APPLE_SIGNING_IDENTITY is set;
#   notarization rejects unsigned executables anywhere in the app.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_parent="$root/.tauri-hermes"
out="$out_parent/hermes"
bridge_rs="$root/src-tauri/src/hermes_bridge.rs"

log() { printf '\033[1;34m[bundle-hermes]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bundle-hermes]\033[0m %s\n' "$*" >&2; exit 1; }

# Builds that skip this script still compile: build.rs creates a placeholder
# at the resources mapping (`ensure_bundled_hermes_dir`), and the app falls
# back to the managed on-device install when no launcher is present.

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

# ---- uv ----------------------------------------------------------------------
work="$out_parent/work"
rm -rf "$out" "$work"
mkdir -p "$work"
# No curl-pipe-sh here, deliberately: this script runs in release CI after the
# Developer ID certificate is imported, so fetching an unpinned remote
# installer would hand keychain-adjacent execution to whoever controls (or
# intercepts) that URL. Homebrew installs are checksum-verified by the
# formula, and GitHub's macOS runners ship brew.
uv_cmd="$(command -v uv || true)"
if [ -z "$uv_cmd" ] && command -v brew >/dev/null; then
  log "uv not found; installing via Homebrew (checksummed)"
  brew install --quiet uv >/dev/null
  uv_cmd="$(command -v uv || true)"
fi
[ -n "$uv_cmd" ] || die "uv is required: install it via 'brew install uv' or https://docs.astral.sh/uv/"
log "uv: $($uv_cmd --version)"

# ---- source checkout, integrity-pinned ---------------------------------------
log "downloading hermes-agent@$commit"
curl -LsSf "$tarball_url" -o "$work/hermes-agent.tar.gz"
actual_sha256="$(shasum -a 256 "$work/hermes-agent.tar.gz" | awk '{print $1}')"
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

# The tarball has no prebuilt dashboard assets — on-device installs build them
# in the "node-deps" stage. Build them here instead (vite outputs to
# hermes_cli/web_dist per web/vite.config.ts) and drop node_modules afterwards.
# The build also stamps the staleness sentinel (.vite/manifest.json) with a
# fresh mtime, so _web_ui_build_needed() stays false at runtime — without it
# the dashboard would try to npm-install and rebuild INSIDE the signed app
# bundle on first launch (breaking the signature, and clean Macs have no node).
command -v npm >/dev/null || die "npm is required to prebuild the dashboard web UI"
log "prebuilding dashboard web UI"
web_log="$work/web-build.log"
if ! (cd "$out/hermes-agent/web" && npm ci --no-audit --no-fund && npm run build) >"$web_log" 2>&1; then
  tail -40 "$web_log" >&2
  die "web UI build failed (full log: $web_log)"
fi
rm -rf "$out/hermes-agent/web/node_modules"
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

# The Tauri bundler fails (opaquely: "failed to build app") on symlinked
# resources, so the bundle must contain none. Drop uv's version-alias link,
# the bin convenience links (the launcher execs python3.11 directly and
# hermes re-execs sys.executable), and dev-only pkgconfig/man trees whose
# files are links too.
find "$out/python" -maxdepth 1 -type l -delete
find "$out/python/current/bin" -type l -delete
rm -rf "$out/python/current/lib/pkgconfig" "$out/python/current/share"

log "installing python deps (uv sync --extra all --locked)"
# Same tiers as install.sh "python-deps": the hash-verified lockfile sync
# first; when the shipped lockfile is out of sync with pyproject (it is at
# the current pin — install.sh hits the identical fallback on-device), fall
# back to resolving the curated [all] extra from PyPI.
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
# replace them). Removing venv/bin also keeps bundled_hermes_command off the
# venv-script candidate and on the relocatable launcher.
find "$venv_sp" -maxdepth 1 \( -name '*editable*' -o -name '_hermes*' \) -exec rm -rf {} +
rm -rf "$out/hermes-agent/venv/bin"

# Make the bare base interpreter resolve hermes + deps via relative paths.
rel_root="../../../../.."
cat > "$base_sp/hermes-bundle.pth" <<EOF
$rel_root/hermes-agent
$rel_root/hermes-agent/venv/lib/$pyver_dir/site-packages
EOF

# Never write .pyc into the signed bundle (it would break the signature seal).
cat > "$base_sp/sitecustomize.py" <<'EOF'
# Generated by scripts/bundle-hermes-runtime.sh. The bundle is code-signed;
# writing bytecode caches into it would invalidate the app's signature.
import sys

sys.dont_write_bytecode = True
EOF

log "precompiling bytecode (checked-hash)"
# Some shipped templates/vendored files don't compile; that only costs them
# the precompile (sitecustomize stops runtime writes), so don't fail the build.
"$py" -m compileall -q --invalidation-mode checked-hash "$out/hermes-agent" "$base_sp" >/dev/null 2>&1 || true

# No symlinks may survive anywhere in the bundle (Tauri bundler limitation,
# see above) — fail loudly here instead of opaquely at app-bundling time.
leftover_links="$(find "$out" -type l | head -5)"
[ -z "$leftover_links" ] || die "bundle still contains symlinks:\n$leftover_links"

# ---- launcher -----------------------------------------------------------------
mkdir -p "$out/bin"
cat > "$out/bin/hermes" <<'EOF'
#!/bin/sh
# Relocatable launcher for the bundled Hermes runtime. Everything resolves
# relative to this file, so the bundle works from /Applications, a renamed
# app, or a Gatekeeper-translocated path. Module resolution comes from
# hermes-bundle.pth inside the bundled interpreter, so re-execs of bare
# sys.executable (the gateway's launchd job) resolve identically.
here="$(cd "$(dirname "$0")/.." && pwd)"
exec "$here/python/current/bin/python3.11" -m hermes_cli.main "$@"
EOF
chmod +x "$out/bin/hermes"

# ---- signing ------------------------------------------------------------------
# Notarization rejects any unsigned Mach-O inside the app. Sign every binary
# (interpreter, dylibs, extension modules) with the hardened runtime; the
# outer app signature then seals the rest of the tree as resources.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  log "signing Mach-O files as: $APPLE_SIGNING_IDENTITY"
  signed=0
  while IFS= read -r -d '' candidate; do
    if file -b "$candidate" | grep -q 'Mach-O'; then
      codesign --force --timestamp --options runtime \
        --sign "$APPLE_SIGNING_IDENTITY" "$candidate"
      signed=$((signed + 1))
    fi
  done < <(find "$out" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
  log "signed $signed Mach-O files"
else
  log "APPLE_SIGNING_IDENTITY not set; skipping codesign (dev bundle)"
fi

# Stamp the bundle with its source pin. build.rs compares this against the
# pins in hermes_bridge.rs and evicts a stale bundle (built before a pin
# bump) instead of letting it ship silently from a developer machine.
printf '%s\n' "$commit" > "$out/PIN"

# ---- self-test: prove relocatability from a moved path with a space -----------
log "self-test: running the launcher from a relocated copy"
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

rm -rf "$work"
du -sh "$out" | awk '{print "[bundle-hermes] bundle size: " $1}'
log "done: $out"
