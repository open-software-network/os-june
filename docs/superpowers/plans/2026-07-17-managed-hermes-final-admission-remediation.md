# Managed Hermes Final Admission Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fresh managed Unix dashboard installs work through a checksum-pinned isolated Node build while closing the remaining archive, digest, fallback, schema, proxy, and loader-environment trust gaps.

**Architecture:** Rust owns all artifact bytes, validates both archive passes, and runs only absolute verified tools inside private staging. Command prediction is cheap; one shared final-admission helper performs the only steady-state full digest and returns either an authenticated managed resolution, a narrowly admitted GitHub-ineligible fallback, or a fail-closed error.

**Tech Stack:** Rust stable, Tokio, reqwest/rustls, SHA-256, `flate2`, `tar`, serde JSON, Tauri process spawning, Node.js 24.18.0 LTS, npm lockfile v3.

---

## File map

- Modify `src-tauri/src/hermes_bridge.rs`: artifact specifications, immutable archive bytes, dashboard build, asset validation, final admission, fallback interpreter discovery, schema policy, environment scrub, and regressions.
- Modify `docs/superpowers/specs/2026-07-17-managed-hermes-startup-isolation-design.md`: already corrected in the design checkpoint.
- Modify `docs/superpowers/plans/2026-07-17-managed-hermes-startup-isolation.md`: already corrected in the design checkpoint.
- Modify `.superpowers/sdd/capability-isolation-task-4-report.md`: append fourth-review RED/GREEN evidence, checksum sources, supported tuples, and deferred Task 8 live qualification.
- Modify this plan only to check completed steps and record exact RED/GREEN outcomes.

The user requested one separate implementation commit, so the tasks remain
uncommitted until the final verified commit.

### Task 1: Immutable archives, raw paths, and direct HTTP

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs:601-625,7352-7678,13800-14150`

**Interfaces:**

```rust
#[cfg(not(target_os = "windows"))]
#[derive(Clone)]
struct VerifiedArchive {
    bytes: Arc<[u8]>,
}

async fn download_verified_managed_archive(
    url: &str,
    expected_sha256: &str,
    max_bytes: u64,
) -> Result<VerifiedArchive, AppError>;

fn validate_and_extract_managed_tar_gz(
    archive: &VerifiedArchive,
    destination: &Path,
    expected_top_level: &str,
) -> Result<PathBuf, AppError>;
```

- [x] **Step 1: Write archive RED tests**

Add `managed_archive_rejects_raw_ambiguous_paths` cases for
`root/./file`, `root//file`, `root/file/`, and `/root/file`. Add
`managed_archive_extracts_authenticated_bytes_after_path_mutation`, which
constructs verified bytes, replaces the diagnostic pathname before extraction,
and asserts only the original bytes appear. Add a two-pass constraint test that
would fail if extraction accepts a link, duplicate, collision, or expanded-size
violation that validation rejects.

- [x] **Step 2: Run archive RED**

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml managed_archive -- --nocapture
```

Expected: ambiguous raw components normalize successfully today and the
path-backed archive can be replaced between passes.

- [x] **Step 3: Implement immutable bounded bytes**

Accumulate response chunks only while `total <= max_bytes`, compare SHA-256,
then convert the `Vec<u8>` into `Arc<[u8]>`. Build validation and extraction
readers from `Cursor<Arc<[u8]>>`. Both passes must call one entry gate that
checks raw UTF-8 bytes before creating a `PathBuf`:

```rust
fn validated_archive_relative_path(raw: &[u8], expected: &str) -> io::Result<PathBuf> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 archive path"))?;
    if text.contains('\\') {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "ambiguous archive path"));
    }
    let parts: Vec<_> = text.split('/').collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty() || *part == "." || *part == "..") {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "ambiguous archive path"));
    }
    if parts.first().copied() != Some(expected) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected archive top-level directory"));
    }
    Ok(parts.into_iter().collect())
}
```

- [x] **Step 4: Disable ambient proxies behaviorally**

Extract `managed_archive_http_client()` with redirect denial, timeouts, and
`.no_proxy()`. Under the existing environment-test lock, point `HTTP_PROXY` and
`HTTPS_PROXY` at a sentinel listener, request a loopback fixture through the
client, and assert the origin receives the connection while the proxy does
not.

- [x] **Step 5: Run archive GREEN**

Run the Task 1 RED command. Expected: all archive cases pass without reopening
an archive path.

### Task 2: Pinned Node artifact and deterministic dashboard build

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs:39-100,601-625,6310-6360,7760-8130,13800-14500`

**Interfaces:**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ManagedNodeArtifact {
    version: &'static str,
    archive_name: &'static str,
    sha256: &'static str,
}

fn managed_node_artifact_for(os: &str, arch: &str, env: &str)
    -> Option<ManagedNodeArtifact>;

fn validate_pinned_web_build_inputs(install_dir: &Path, tuple: &str)
    -> Result<(), AppError>;

fn prepare_managed_dashboard_assets(
    staging: &Path,
    install_dir: &Path,
    node_root: &Path,
) -> Result<(), AppError>;
```

- [x] **Step 1: Write Node tuple and source RED tests**

Assert the four approved Node 24.18.0 names and SHA-256 values exactly, reject
musl/unknown tuples, and assert the release base is the immutable
`https://nodejs.org/download/release/v24.18.0`. Parse pinned manifest fixtures
and reject a missing workspace, changed `web` build script, non-v3 lockfile,
package config capable of overriding registry, and a missing/non-registry or
integrity-free esbuild, Rolldown, Tailwind Oxide, or lightningcss package for
any supported tuple.

- [x] **Step 2: Run Node/source RED**

Run the focused `managed_node` test filter. Expected: selector and build-input
validator do not exist.

- [x] **Step 3: Implement exact artifact selection and input admission**

Add the four design-approved Node tuples. Validate root `package.json`,
`web/package.json`, and `package-lock.json` as serde JSON. Reject project and
workspace `.npmrc` files, package `config` registry/proxy keys, unexpected
lockfile version/workspace, changed build script, and missing native optional
packages. Require every relevant lock entry to have an HTTPS npm registry
`resolved` URL and a nonempty `integrity` value.

- [x] **Step 4: Write command RED fixture**

Create a local tar fixture with a fake regular executable at `bin/node`, npm's
exact `lib/node_modules/npm/bin/npm-cli.js`, and source build inputs. The fake
node records argv/environment and creates the expected installed entrypoints
and Vite output. Seed hostile `PATH`, HOME, npm configs, proxy variables,
`NODE_OPTIONS`, `LD_*`, and `DYLD_*`. Assert:

```text
node npm-cli.js ci --ignore-scripts --no-audit --no-fund
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
```

No hostile value or executable may be observed.

- [x] **Step 5: Implement environment-cleared commands**

Invoke the absolute verified Node program for all three commands. Use
`env_clear`, `PATH=<node-bin>:/usr/bin:/bin`, staging-only `HOME`, cache,
userconfig, and globalconfig, fixed `npm_config_registry=https://registry.npmjs.org/`,
`npm_config_strict_ssl=true`, empty npm proxy controls, and explicit
ignore-scripts/audit/fund/update-notifier/progress/color controls. Pass the
same controls as CLI flags where npm supports them so neither package metadata
nor configuration can override the trust posture. Set each build working
directory to `web`; do not execute a shell, `.bin` shim, npm shebang, or package
script.

- [x] **Step 6: Run Node command GREEN**

Run the focused `managed_node` tests. Expected: tuple, source, argv,
environment, no-ambient-executable, and scripts-disabled cases pass.

### Task 3: Fail-closed web assets and clean-install fixture

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs:7760-8130,13800-14600`

**Interfaces:**

```rust
fn validate_managed_web_dist(web_dist: &Path) -> Result<(), AppError>;
fn remove_managed_build_material(staging: &Path, install_dir: &Path) -> Result<(), AppError>;
```

- [x] **Step 1: Write asset RED tests**

Cover missing/empty/non-UTF-8 index, symlinked tree entries, `../`, `.`, `//`,
backslash and percent-encoded separator references, missing referenced files,
external/protocol-relative references, escaping CSS `url(...)`, and a valid
Vite-style index/CSS/assets tree. Add cleanup-failure injection and assert the
runtime is never sealed or published.

- [x] **Step 2: Run asset RED**

Run the focused `managed_web_dist` tests. Expected: validation and cleanup
helpers do not exist.

- [x] **Step 3: Implement lexical asset graph validation**

Walk with `symlink_metadata`; permit only directories and regular files. Parse
quoted `src`/`href` values in index and `url(...)` values in referenced CSS.
Strip one leading `/` only after rejecting `//`; reject URL schemes, query or
fragment ambiguity, percent-encoded separators/dots, backslashes, and every
empty/`.`/`..` component. Join only admitted components beneath `web_dist` and
require a plain regular file.

- [x] **Step 4: Integrate dashboard preparation and cleanup before seal**

Download/extract the selected Node archive after Hermes source admission, run
build-input validation and the direct commands, validate `web_dist`, then
remove Node, `node_modules`, npm state, and build temporaries. Every failure
returns before old-runtime retirement and before integrity sealing.

- [x] **Step 5: Exercise the clean-install path locally**

Use local fixtures for the production archive policies and the dashboard
preparation helpers. Assert Node's exact official launcher symlinks are ignored
but never extracted, dashboard assets are prepared, schema 2 seals, all build
material is absent, the managed Python launcher resolves, and a second
preparation completes without installer or asset-builder invocation. Packaged
dashboard launch from official downloads remains Task 8.

- [x] **Step 6: Run asset/integration GREEN**

Run `managed_web_dist` and `managed_clean_install` filters. Expected: all cases
pass and cleanup failure is fail closed.

### Task 4: One full digest on actual dashboard and TUI starts

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs:1205-1420,5926-6005,6149-6488,7198-7218,13800-14800`

**Interfaces:**

```rust
enum ManagedRecordAdmission {
    Missing,
    LegacySchema1,
    CurrentSchema2(ManagedHermesIntegrityRecord),
    Rejected,
}

async fn admit_resolution_immediately_before_launch<D, I>(
    predicted: HermesCommandResolution,
    digest: D,
    installer: I,
) -> Result<HermesCommandResolution, AppError>;
```

- [x] **Step 1: Write production-path digest RED tests**

Drive the shared final-admission function used by
`start_hermes_bridge_inner` and `open_hermes_tui_debug` with a counting seam.
Seed a current schema-2 runtime in the resolver regression and assert one
digest, while cheap availability calls it zero times. Add production-source
order assertions that both real paths finalize after preparation and before
spawn/launch, and that plugin verification performs no second managed
preparation.

- [x] **Step 2: Run digest RED**

Run `managed_actual_start_digest_budget`. Expected: dashboard and TUI each call
managed preparation twice.

- [x] **Step 3: Separate prediction from final admission**

Make early prediction metadata-only. Move managed repair/install/digest into
one shared final helper under `start_lock`; return the final resolution. If an
admitted legacy/missing runtime falls back, rerender all 11 registrations and
remove GitHub before launch. Remove the later managed preparation call from
`verify_runtime_immediately_before_spawn`; plugin byte checks consume the
already-admitted resolution only.

- [x] **Step 4: Run digest GREEN**

Run the Task 4 RED filter and earlier digest/locking tests. Expected: one/one/zero
budgets and serialization all pass.

### Task 5: Actual fallback interpreter and schema fail-close

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs:6149-6260,6500-6540,13800-15000`

- [x] **Step 1: Write fallback/shebang RED fixtures**

Create executable direct scripts, a pipx-style Hermes symlink chain, an
interpreter symlink, and `/usr/bin/env python3` with controlled PATH. Assert the
stored program is the canonical absolute interpreter. Reject loops, missing
execute bits, relative/malformed/shell/multi-command/non-Python shebangs and
assert no result equals `python3`.

- [x] **Step 2: Write schema RED matrix**

Assert fallback is permitted only for a missing record and explicit schema 1,
before any managed process admission. Assert malformed JSON, missing/string
schema, 0, 2 integrity failure, 3, and `u32::MAX` fail closed.

- [x] **Step 3: Run fallback/schema RED**

Run `fallback_interpreter` and `managed_schema_admission`. Expected: fallback
still fabricates ambient `python3`, and unknown schemas can be treated like an
unavailable legacy record.

- [x] **Step 4: Implement bounded executable/shebang resolution**

Follow at most 16 symlinks with loop detection. Require a regular executable
endpoint, read at most 4096 bytes for the first line, and support only an
absolute Python interpreter or narrowly tokenized `/usr/bin/env [python-name]`.
Resolve env names through the selected explicit PATH and canonicalize the
interpreter after checking regular/executable metadata.

- [x] **Step 5: Implement explicit record admission**

Parse `schema` before typed deserialization. Return only Missing, admitted
LegacySchema1, valid CurrentSchema2, or Rejected. Feed that enum into fallback
policy; never infer legacy from a deserialization error.

- [x] **Step 6: Run fallback/schema GREEN**

Run both RED filters plus earlier fallback/config tests. Expected: the complete
matrix passes and GitHub remains absent for fallback.

### Task 6: Loader environment scrub

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs:420-460,1340-1410,5840-5925,8240-8290,14200-15100`

- [x] **Step 1: Write loader-environment RED tests**

Seed `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`,
`DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, and an unknown `DYLD_TEST_POISON`.
Inspect the real dashboard command environment and execute the generated TUI
launcher fixture; no seeded key may reach the bearer-bearing child. Preserve
required HERMES/HOME/PATH/TMPDIR values.

- [x] **Step 2: Run loader RED**

Run `loader_environment_isolation`. Expected: dashboard inheritance and TUI
Terminal environment expose at least one sentinel.

- [x] **Step 3: Implement scrub**

For direct commands, remove fixed `LD_*` keys and every inherited key beginning
`DYLD_`. Generate the TUI invocation through absolute `/usr/bin/env -i` and
add back only fixed quoted values. Keep installer and Node commands on
`env_clear` with the same minimal allowlist.

- [x] **Step 4: Run loader GREEN**

Run the RED filter plus Python-isolation and launcher-script tests. Expected:
all poison keys are absent and required values remain.

### Task 7: Report, full verification, and separate implementation commit

**Files:**
- Modify: `.superpowers/sdd/capability-isolation-task-4-report.md`
- Modify: `docs/superpowers/plans/2026-07-17-managed-hermes-final-admission-remediation.md`

- [x] **Step 1: Append exact evidence**

Record every RED failure and GREEN count, official Hermes/PyPI/Node evidence,
the four Node checksums and tuple policy, npm command/environment controls,
archive byte ownership, asset matrix, actual one-digest budgets, fallback and
schema matrices, loader/proxy tests, clean fixture result, and Task 8 live
qualification deferral.

- [x] **Step 2: Run focused security gates**

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml managed_archive -- --nocapture
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml python_isolation -- --nocapture
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml fallback -- --nocapture
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml sandbox_ -- --nocapture
rustc --edition=2021 --test src-tauri/hermes_manifest.rs -o /tmp/june-hermes-manifest-tests
/tmp/june-hermes-manifest-tests --nocapture
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
```

Expected: all functional tests pass; only the documented Keychain probe stays
ignored.

- [x] **Step 3: Run compile, lint, format, and smoke gates**

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo check --manifest-path src-tauri/Cargo.toml
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests --no-deps -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
python3 scripts/check-cargo-release-age.py
pnpm exec biome check scripts/hermes-smoke.ts
pnpm test:hermes-smoke
git diff --check
```

Expected: all available gates pass. If the pinned smoke completes functional
phases then hits the documented `ENOTEMPTY` cleanup race, record it precisely
without claiming a clean process exit.

- [x] **Step 4: Review against the approved design**

Re-read every design section and confirm: no ambient Node/npm/PATH, exact
source/lock inputs, immutable archives, repeated extraction constraints, raw
path rejection, one actual-start digest, actual fallback interpreter, explicit
schema admission, no proxy, loader scrub, asset validation, cleanup before
seal, and Task 5 still untouched.

- [x] **Step 5: Create the one implementation commit**

```bash
git add src-tauri/src/hermes_bridge.rs .superpowers/sdd/capability-isolation-task-4-report.md docs/superpowers/plans/2026-07-17-managed-hermes-final-admission-remediation.md
git commit -m "fix: complete managed Hermes admission isolation"
```

Expected: the commit is separate from design commit `7fb411a6` and is not
pushed.
