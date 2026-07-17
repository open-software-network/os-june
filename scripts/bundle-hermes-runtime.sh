#!/usr/bin/env bash
# Builds the self-contained Hermes runtime that ships inside the app bundle
# (Resources/native/hermes), so a fresh install needs no multi-minute GitHub
# download on first launch. `hermes_bridge.rs` prefers this bundled runtime
# (`bundled_hermes_command`) and falls back to the on-device managed install
# when it is absent, so dev builds keep working without running this script.
#
# Layout produced under .tauri-hermes/hermes/ (repo root):
#   bin/hermes        architecture-selecting Hermes launcher
#   bin/python3       architecture-selecting Python launcher used by June MCPs
#   python/arm64/     arm64 standalone CPython
#   python/x86_64/    x86_64 standalone CPython
#   site-packages/arm64/ and site-packages/x86_64/
#                     target-selected dependency trees
#   hermes-agent/     shared pinned, patched Hermes source checkout
#
# Design notes, hard-won:
# - The commit/sha256 pins are read from src-tauri/src/hermes_bridge.rs so the
#   bundled runtime and the managed-install fallback can never drift apart.
# - Dependencies install via `uv sync --extra all --locked` — the same
#   hash-verified tier the on-device installer uses (install.sh "python-deps").
# - The launchers run an architecture-specific BASE python, not a venv python:
#   venvs encode absolute build-machine paths (pyvenv.cfg home, bin symlinks,
#   shebangs)
#   and cannot be relocated reliably. A .pth in the base interpreter's
#   site-packages adds the checkout and its architecture's dependency tree via
#   paths RELATIVE to the .pth itself. This also makes bare `sys.executable`
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
audit_script="$root/scripts/audit-hermes-runtime.sh"
bundle_architectures=(arm64 x86_64)

log() { printf '\033[1;34m[bundle-hermes]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bundle-hermes]\033[0m %s\n' "$*" >&2; exit 1; }

ensure_no_symlinks() {
  local leftover_links
  leftover_links="$(find "$out" -type l | head -5)"
  [ -z "$leftover_links" ] || die "bundle still contains symlinks:
$leftover_links"
}

sign_macho_files() {
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    log "signing Mach-O files as: $APPLE_SIGNING_IDENTITY"
    local signed=0 candidate description
    while IFS= read -r -d '' candidate && IFS= read -r description; do
      description="${description#: }"
      case "$description" in
        *Mach-O*)
          codesign --force --timestamp --options runtime \
            --sign "$APPLE_SIGNING_IDENTITY" "$candidate"
          signed=$((signed + 1))
          ;;
      esac
    done < <(find "$out" -type f -exec file -0 -N {} +)
    log "signed $signed Mach-O files"
  else
    log "APPLE_SIGNING_IDENTITY not set; skipping codesign (dev bundle)"
  fi
}

audit_bundle() {
  if [ "${APPLE_SIGNING_IDENTITY:-}" ]; then
    /bin/bash "$audit_script" "$out" --require-signed
  else
    /bin/bash "$audit_script" "$out"
  fi
}

run_for_arch() {
  local arch="$1"
  shift
  case "$arch" in
    arm64|x86_64) ;;
    *) die "unsupported self-test architecture: $arch" ;;
  esac
  if ! /usr/bin/arch "-$arch" /usr/bin/true >/dev/null 2>&1; then
    if [ "$arch" = "x86_64" ] && [ "$(uname -m)" = "arm64" ]; then
      die "x86_64 execution is unavailable. Install Rosetta 2 on the ARM release runner; refusing to publish an Intel runtime that was not executed."
    fi
    die "$arch execution is unavailable on this release runner"
  fi
  /usr/bin/arch "-$arch" "$@"
}

run_self_test() {
  log "self-test: running both architectures from a relocated copy"
  local selftest_root selftest
  selftest_root="$(mktemp -d)"
  trap 'rm -rf "$selftest_root"' EXIT
  selftest="$selftest_root/re located"
  mkdir -p "$selftest"
  cp -R "$out" "$selftest/hermes"

  local arch test_home version_output selected_arch
  for arch in "${bundle_architectures[@]}"; do
    test_home="$selftest_root/hermes-home-$arch"
    mkdir -p "$test_home"
    version_output="$(HERMES_HOME="$test_home" run_for_arch "$arch" "$selftest/hermes/bin/hermes" --version)" \
      || die "self-test failed: $arch bundled hermes --version"
    case "$version_output" in
      *"$selftest/hermes/hermes-agent"*) ;;
      *) die "self-test failed: $arch Hermes resolved the wrong project root: $version_output" ;;
    esac

    selected_arch="$(run_for_arch "$arch" "$selftest/hermes/bin/python3" -c 'import platform; print(platform.machine())')" \
      || die "self-test failed: $arch Python launcher did not execute"
    [ "$selected_arch" = "$arch" ] \
      || die "self-test failed: requested $arch but launcher executed $selected_arch"

    run_for_arch "$arch" "$selftest/hermes/bin/python3" -c \
      "import cryptography.hazmat.bindings._rust, hermes_cli.main, httptools, psutil, pydantic_core, uvloop, yaml" \
      || die "self-test failed: $arch patched Hermes or native dependencies cannot import"
    run_for_arch "$arch" "$selftest/hermes/bin/python3" \
      "$root/scripts/hermes-native-import-smoke.py" \
      "$selftest/hermes/site-packages/$arch" \
      || die "self-test failed: $arch native dependency import sweep"
    run_for_arch "$arch" "$selftest/hermes/bin/python3" \
      "$root/scripts/hermes-approval-patch-smoke.py" \
      "$selftest/hermes/hermes-agent" \
      || die "self-test failed: $arch June Hermes compatibility protocol"
    HERMES_PLUGIN_ROOT="$selftest/hermes/hermes-agent/plugins" \
      run_for_arch "$arch" "$selftest/hermes/bin/python3" \
      -c "import os, sys; sys.path.insert(0, os.environ['HERMES_PLUGIN_ROOT']); from cron import jobs; assert '/hermes-agent/cron/jobs.py' in jobs.__file__.replace('\\\\', '/'), jobs.__file__" \
      || die "self-test failed: $arch top-level cron import was shadowed by plugins/cron"
    log "self-test: $arch execution passed"
  done

  /usr/bin/python3 "$root/src-tauri/src/hermes/apply_june_patches.py" \
    "$selftest/hermes/hermes-agent" --verify \
    || die "self-test failed: June Hermes patch checksums do not match"
  rm -rf "$selftest_root"
  trap - EXIT
}

print_bundle_size() {
  du -sh "$out" | awk '{print "[bundle-hermes] bundle size: " $1}'
}

bundle_is_reusable() {
  [ -f "$out/PIN" ] || return 1
  [ "$(cat "$out/PIN")" = "$commit" ] || return 1
  [ -f "$out/PATCHSET" ] || return 1
  [ "$(cat "$out/PATCHSET")" = "$patch_set" ] || return 1
  [ -f "$out/ARCHITECTURES" ] || return 1
  [ "$(tr '\n' ' ' < "$out/ARCHITECTURES" | awk '{$1=$1; print}')" = "arm64 x86_64" ] || return 1
  [ -x "$out/bin/hermes" ] || return 1
  [ -x "$out/bin/python3" ] || return 1
  local arch
  for arch in "${bundle_architectures[@]}"; do
    [ -x "$out/python/$arch/current/bin/python3.11" ] || return 1
    [ -d "$out/site-packages/$arch" ] || return 1
    [ -f "$out/python/$arch/TARGET" ] || return 1
  done
  [ -d "$out/hermes-agent" ] || return 1
  [ -f "$out/hermes-agent/hermes_cli/web_dist/index.html" ] || return 1
}

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
patch_set="$(pin HERMES_RUNTIME_PATCH_SET)"
tarball_sha256="$(pin HERMES_SOURCE_TARBALL_SHA256)"
tarball_url="$(pin HERMES_SOURCE_TARBALL_URL)"
[ -n "$commit" ] || die "could not read HERMES_AGENT_INSTALL_COMMIT from $bridge_rs"
[ -n "$patch_set" ] || die "could not read HERMES_RUNTIME_PATCH_SET from $bridge_rs"
[ -n "$tarball_sha256" ] || die "could not read HERMES_SOURCE_TARBALL_SHA256 from $bridge_rs"
[ -n "$tarball_url" ] || die "could not read HERMES_SOURCE_TARBALL_URL from $bridge_rs"
log "pin: $commit"
log "patch set: $patch_set"

work="$out_parent/work"
if bundle_is_reusable; then
  log "using cached Hermes bundle for pin: $commit"
  ensure_no_symlinks
  # Always sign restored binaries with the currently imported Developer ID cert.
  sign_macho_files
  audit_bundle
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
upstream_smoke="$work/hermes-agent-upstream-smoke"
cp -R "$out/hermes-agent" "$upstream_smoke"

# Apply June's sealed compatibility patch to the exact pinned sources. The
# patcher verifies each upstream and post-patch file hash and fails on drift.
/usr/bin/python3 "$root/src-tauri/src/hermes/apply_june_patches.py" "$out/hermes-agent"
/usr/bin/python3 "$root/scripts/hermes-approval-patch-smoke.py" \
  "$out/hermes-agent" --upstream-root "$upstream_smoke"
rm -rf "$upstream_smoke"

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
# npm workspaces (root package.json lists web/, ui-tui/, apps/*) hoist the
# install to the REPO ROOT, so pruning web/node_modules alone leaves a root
# node_modules full of .bin symlinks — which the no-symlinks gate below
# rejects. None of it is needed at runtime: the dashboard serves the
# prebuilt web_dist, and the Node TUI is an interactive-terminal surface
# June never launches.
rm -rf "$out/hermes-agent/node_modules" \
  "$out/hermes-agent/web/node_modules" \
  "$out/hermes-agent/ui-tui/node_modules"
[ -f "$out/hermes-agent/hermes_cli/web_dist/index.html" ] || die "web_dist missing after build"

# ---- two relocatable CPythons + target-selected dependency trees ------------
# Both trees are built on the ARM release runner. The target-qualified Python
# request downloads the matching python-build-standalone interpreter; uv's
# --python-platform plus --only-binary make dependency selection target-aware
# and forbid host-built native sdists. The architecture audit below then proves
# every resulting Mach-O supports the tree it lives in.
install_arch_runtime() {
  local arch="$1"
  local uv_arch target python_root pydir py venv venv_sp site_sp base_sp
  case "$arch" in
    arm64)
      uv_arch=aarch64
      target=aarch64-apple-darwin
      ;;
    x86_64)
      uv_arch=x86_64
      target=x86_64-apple-darwin
      ;;
    *) die "unsupported bundle architecture: $arch" ;;
  esac

  log "installing $arch standalone CPython 3.11"
  python_root="$out/python/$arch"
  mkdir -p "$python_root"
  UV_PYTHON_INSTALL_DIR="$python_root" UV_PYTHON_INSTALL_BIN=0 UV_NO_CONFIG=1 \
    "$uv_cmd" python install "cpython-3.11-macos-${uv_arch}-none" >/dev/null
  pydir="$(find "$python_root" -maxdepth 1 -type d -name 'cpython-3.11*' | head -1)"
  [ -n "$pydir" ] || die "uv did not install the $arch CPython 3.11 runtime"
  mv "$pydir" "$python_root/current"
  py="$python_root/current/bin/python3.11"
  [ -x "$py" ] || die "$arch bundled python missing at $py"

  # Drop uv's version aliases and standalone-distribution convenience links.
  find "$python_root" -maxdepth 1 -type l -delete
  find "$python_root/current/bin" -type l -delete
  rm -rf "$python_root/current/lib/pkgconfig" "$python_root/current/share"

  log "installing $arch Python deps for target $target"
  venv="$work/venv-$arch"
  (
    cd "$out/hermes-agent"
    export UV_PROJECT_ENVIRONMENT="$venv"
    export UV_NO_CONFIG=1
    export UV_PYTHON_INSTALL_DIR="$python_root"
    if ! "$uv_cmd" sync --extra all --locked --no-install-project --no-build \
      --link-mode copy --python-platform "$target" --python "$py" >/dev/null 2>&1; then
      log "$arch lockfile sync unavailable; resolving curated [all] wheels for $target"
      rm -rf "$venv"
      "$uv_cmd" venv "$venv" --python "$py" >/dev/null
      "$uv_cmd" pip install -p "$venv" --python-platform "$target" \
        --only-binary :all: --link-mode copy -e ".[all]" >/dev/null
    fi
  )

  venv_sp="$(find "$venv/lib" -maxdepth 1 -type d -name 'python3.*' | head -1)/site-packages"
  [ -d "$venv_sp" ] || die "$arch venv site-packages missing"
  site_sp="$out/site-packages/$arch"
  mkdir -p "$(dirname "$site_sp")"
  mv "$venv_sp" "$site_sp"
  rm -rf "$venv"

  # Editable hooks encode the build checkout. Hermes source comes from the
  # relative bundle path below, so remove the hooks and their metadata.
  find "$site_sp" -maxdepth 1 \( -name '*editable*' -o -name '_hermes*' \) -exec rm -rf {} +
  base_sp="$(find "$python_root/current/lib" -maxdepth 1 -type d -name 'python3.*' | head -1)/site-packages"
  [ -d "$base_sp" ] || die "$arch base site-packages missing"

  # From python/<arch>/current/lib/python3.x/site-packages back to bundle root.
  cat > "$base_sp/hermes-bundle.pth" <<EOF
../../../../../../hermes-agent
../../../../../../site-packages/$arch
EOF
  cp "$root/src-tauri/src/hermes/sitecustomize.py" "$base_sp/sitecustomize.py"

  # No relocatable path file may retain the build machine's absolute checkout.
  while IFS= read -r pth; do
    if /usr/bin/grep -Fq "$root" "$pth"; then
      die "$arch dependency metadata contains an absolute bundle path: $pth"
    fi
  done < <(find "$python_root/current" "$site_sp" -type f -name '*.pth')

  log "precompiling $arch bytecode (checked-hash)"
  # Some shipped templates do not compile; sitecustomize still prevents all
  # runtime writes into the signed bundle.
  run_for_arch "$arch" "$py" -m compileall -q --invalidation-mode checked-hash \
    "$out/hermes-agent" "$base_sp" "$site_sp" >/dev/null 2>&1 || true
  printf '%s\n' "$target" > "$python_root/TARGET"
}

for arch in "${bundle_architectures[@]}"; do
  install_arch_runtime "$arch"
done

# No symlinks may survive anywhere in the bundle (Tauri bundler limitation,
# see above) — fail loudly here instead of opaquely at app-bundling time.
ensure_no_symlinks

# ---- architecture-selecting launchers -----------------------------------------
mkdir -p "$out/bin"
cat > "$out/bin/python3" <<'EOF'
#!/bin/sh
# Relocatable selector for the bundled Python runtime. uname reports x86_64
# inside Rosetta, so this also proves the Intel path during release self-tests.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
machine="$(/usr/bin/uname -m)"
case "$machine" in
  arm64|x86_64) ;;
  *)
    printf 'June bundled Hermes does not support architecture: %s\n' "$machine" >&2
    exit 1
    ;;
esac
python="$here/python/$machine/current/bin/python3.11"
if [ ! -x "$python" ]; then
  printf 'June bundled Hermes is missing its %s Python runtime.\n' "$machine" >&2
  exit 1
fi
exec "$python" "$@"
EOF

cat > "$out/bin/hermes" <<'EOF'
#!/bin/sh
# Relocatable, architecture-selecting launcher for the bundled Hermes runtime.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
machine="$(/usr/bin/uname -m)"
case "$machine" in
  arm64|x86_64) ;;
  *)
    printf 'June bundled Hermes does not support architecture: %s\n' "$machine" >&2
    exit 1
    ;;
esac
python="$here/python/$machine/current/bin/python3.11"
if [ ! -x "$python" ]; then
  printf 'June bundled Hermes is missing its %s Python runtime.\n' "$machine" >&2
  exit 1
fi
exec "$python" -m hermes_cli.main "$@"
EOF
chmod +x "$out/bin/hermes" "$out/bin/python3"

# Provenance stamps are part of cache reuse and build.rs eviction. The exact
# ARCHITECTURES contents make a legacy host-only bundle ineligible even when
# its source PIN and PATCHSET still match.
printf '%s\n' "$commit" > "$out/PIN"
printf '%s\n' "$patch_set" > "$out/PATCHSET"
printf 'arm64\nx86_64\n' > "$out/ARCHITECTURES"
ensure_no_symlinks

# ---- signing ------------------------------------------------------------------
# Notarization rejects any unsigned Mach-O inside the app. Sign every binary
# (interpreter, dylibs, extension modules) with the hardened runtime; the
# outer app signature then seals the rest of the tree as resources.
sign_macho_files
audit_bundle

# ---- self-test: prove relocatability from a moved path with a space -----------
run_self_test

rm -rf "$work"
print_bundle_size
log "done: $out"
