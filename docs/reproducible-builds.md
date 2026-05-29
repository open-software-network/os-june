# Reproducible builds for `scribe-api`

> **Status:** plan — under review. Phase A not yet implemented.

## Why

When we open-source `os-scribe` we want to make a claim a skeptic can check
without trusting us:

> "The code in this public commit is **exactly** what runs in the TEE."

That requires a **trustless** link from source to the running image. Two trust
models exist:

- **Signed provenance** — trust our CI's signature that "digest X came from
  commit Y." (We dropped this in #44; we don't consume it.)
- **Reproducible builds** — anyone clones the repo at commit Y, rebuilds, gets
  the **same** digest X, and checks it against the TEE attestation. No trust in
  our CI required. **This is the model we want.**

## The chain a verifier walks

**Target (cleanest):** the attested compose pins the image by **content digest**,
so the verifier never trusts the registry:

```
git clone @<commit> ──► deterministic build ──► digest D
                                                  ║ compare
Trust Center attestation ──► attested compose ──► pins @sha256:D ?  ✅
```

**Current reality:** we pin by **tag**, not digest (see the constraint below), so
the chain has one extra hop — resolve the tag in the registry:

```
git clone @<commit> ──► deterministic build ──► digest D
Trust Center attestation ──► attested compose ──► pins :<sha_short>
registry: :<sha_short> ──► resolves to digest D' ;  D == D' ?  ✅
```

A match proves the running enclave is the published code. The tag→digest hop
trusts the registry hasn't re-pushed the tag (sha tags are immutable by
convention; close the gap by also committing the digest to a git release record,
or by reaching the digest-pinned target above). This chain proves the **code
only** — not the upstream model providers (audio still leaves the TEE to
OpenAI/Venice). Keep those claims separate.

## Constraint: dstack can't verify digest refs (we deploy by tag)

> Discovered while fixing the deploy (#46). This reshapes the verification anchor.

dstack's stock GHCR prelaunch verify (`Dstack-TEE/dstack-examples`
`phala-cloud-prelaunch-script/prelaunch.sh`) parses image refs as `repo:tag`:

```sh
repo="${img#ghcr.io/}"; repo="${repo%%:*}"   # cuts at the FIRST ':'
tag="${img##*:}"
curl ".../v2/${repo}/manifests/${tag}"
```

A `repo@sha256:digest` ref breaks this: `%%:*` cuts at the `:` inside `sha256:`,
so `repo` becomes `…/scribe-api@sha256`, the manifest URL 404s, the prelaunch
`exit 1`s, and the CVM never boots. **Any digest-pinned ref fails today; only
tags work** — which is why #46 deploys `:<sha_short>`.

To reclaim digest-in-compose (the cleanest anchor), one of:

- **Custom `pre_launch_script`** that parses `@sha256:` correctly (`phala deploy`
  supports supplying one) — viable only if we own the script rather than Phala
  auto-injecting it. **Investigate who owns it.**
- **Upstream fix** to dstack's prelaunch parsing — report it; use tags meanwhile.

## Scope: only the `runtime` stage matters

The Dockerfile is multi-stage. Only the final `runtime` image is published and
attested, so only inputs that reach it affect the digest:

1. the `scribe` binary (`COPY --from=builder`)
2. the `debian:bookworm-slim` base
3. the CA certificate bundle
4. file metadata (timestamps, ownership) in the layers

`chef` / `planner` / `builder` nondeterminism is irrelevant **except** through
the one binary they produce. So determinism work focuses on those four inputs,
not the whole build.

## Nondeterminism sources and fixes

| Source | Why it drifts | Fix |
|---|---|---|
| `FROM rust:1.95-bookworm` | tag floats across 1.95.x patches → different `rustc` → different codegen | pin `@sha256:<digest>` |
| `FROM debian:bookworm-slim` | tag moves | pin `@sha256:<digest>` |
| `apt-get install ca-certificates` | unpinned version, fetched at build time | `COPY` the cert bundle from the pinned base instead of `apt` (removes the fetch entirely) |
| `cargo build --release` binary | absolute paths in panic strings / debug info; build-id | `RUSTFLAGS=--remap-path-prefix=…`, `[profile.release] strip = true`, committed `Cargo.lock`, pinned toolchain |
| layer file mtimes | build wall-clock time | `SOURCE_DATE_EPOCH=<commit time>` + buildkit `rewrite-timestamp=true` |

## Phase A — make the build deterministic

> **Already done in #44:** `provenance: false` + `sbom: false` (plain image, no
> attestation index). The items below are the remaining build-determinism work.

Concrete changes (all reviewable before any CI run):

### 1. Pin base images by digest — `scribe-api/Dockerfile`

```dockerfile
FROM rust:1.95-bookworm@sha256:<resolve-at-impl> AS chef
...
FROM debian:bookworm-slim@sha256:<resolve-at-impl> AS runtime
```

Digests resolved with `docker buildx imagetools inspect <image:tag>` at
implementation time and committed.

### 2. Deterministic compiler flags — `scribe-api/Dockerfile` (builder stage)

```dockerfile
FROM chef AS builder
ENV CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/app=. --remap-path-prefix=/usr/local/cargo=/cargo"
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --bin scribe
```

### 3. Strip the binary — `scribe-api/Cargo.toml`

```toml
[profile.release]
strip = true        # drop symbol table → deterministic + smaller
```

### 4. Pin the toolchain for non-Docker rebuilds — `scribe-api/rust-toolchain.toml` (new)

```toml
[toolchain]
channel = "1.95.0"   # must match the pinned rust base image's rustc
```

(The CI/Docker build's exact `rustc` is locked by the base-image digest; this
file makes a *local* `cargo build` outside Docker match.)

### 5. Replace apt certs with a copy — `scribe-api/Dockerfile` (runtime stage)

```dockerfile
FROM debian:bookworm-slim@sha256:<…> AS runtime
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin scribe
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=builder /app/target/release/scribe /usr/local/bin/scribe
COPY config.toml /app/config.toml
USER scribe
EXPOSE 8080
ENV RUST_LOG=scribe=info,scribe_api=info,scribe_services=info,scribe_providers=info,tower_http=info
ENTRYPOINT ["scribe"]
CMD ["serve"]
```

(The `rust` base ships `ca-certificates`, so the bundle is copied from a pinned
stage — no network fetch, no version drift.)

### 6. Reproducible image export — `.github/workflows/build-scribe-api.yml`

`provenance: false`/`sbom: false` already merged (#44). Remaining work: compute
the commit epoch and enable timestamp rewriting. Note we deploy by **tag**
(#46), and the build pushes both `:<sha_short>` and `:staging` — the `outputs:`
form must keep pushing both (`name=img:<sha>,img:staging`):

```yaml
      - name: Compute metadata
        id: meta
        run: |
          echo "sha_short=$(git rev-parse --short=7 HEAD)" >> "$GITHUB_OUTPUT"
          echo "epoch=$(git log -1 --pretty=%ct)"          >> "$GITHUB_OUTPUT"

      - name: Build and push
        id: build
        uses: docker/build-push-action@v6
        env:
          SOURCE_DATE_EPOCH: ${{ steps.meta.outputs.epoch }}
        with:
          context: scribe-api
          file: scribe-api/Dockerfile
          provenance: false
          sbom: false
          outputs: type=image,"name=${{ env.IMAGE }}:${{ steps.meta.outputs.sha_short }},${{ env.IMAGE }}:staging",push=true,rewrite-timestamp=true
          # (both tags via outputs name=…; drop the `tags:`/`push:` keys)
          ...
```

> Note: `rewrite-timestamp=true` requires the `outputs:` exporter form rather
> than `push: true` + `tags:`. Exact translation finalized at implementation.

## Phase B — prove it (iterative, needs real builds)

### `scripts/verify-reproducible.sh` (new)

```
Usage: verify-reproducible.sh <git-ref>
  1. git worktree add /tmp/verify <git-ref>
  2. SOURCE_DATE_EPOCH=$(git -C /tmp/verify log -1 --pretty=%ct) \
       docker buildx build --provenance=false --sbom=false \
       --output type=image,rewrite-timestamp=true,push=false \
       --metadata-file /tmp/meta.json scribe-api
  3. local=$(jq -r '.["containerimage.digest"]' /tmp/meta.json)
  # Because we deploy by tag, the "expected" digest comes from resolving the
  # deployed tag (what the attestation references) — not from the attestation
  # directly. Optionally also assert against a committed release record.
  4. sha=$(git -C /tmp/verify rev-parse --short=7 HEAD)
     expected=$(docker buildx imagetools inspect "ghcr.io/open-software-network/scribe-api:$sha" \
                  --format '{{.Manifest.digest}}')
  5. [ "$local" = "$expected" ] && echo PASS || { echo "FAIL $local != $expected"; exit 1; }
```

### CI guard — double-build job

A workflow job that builds twice and fails if the two digests differ, so a
dependency or Dockerfile change can't silently break reproducibility.

### Iteration

Bit-for-bit reproducibility usually takes 2–3 rounds: build twice, diff with
[`diffoci`](https://github.com/reproducible-containers/diffoci) to find the
remaining nondeterminism, fix, repeat. This needs actual build runs, so Phase B
is iterative — not a one-shot edit.

## Phase C — make the public claim

Only after two independent builds match:

- Update the README / #36 to the strong wording: "Rebuild from this commit and
  check the digest against the Trust Center attestation," with the exact steps.
- Until then, #36 should say "verify the running digest matches our public CI
  build for commit X" (true today) — do **not** ship "rebuild and check" before
  Phase B passes.

## Effort / risk

- **Phase A:** low risk, ~1 PR. Each change is independently sound; worst case a
  base-digest pin needs a bump. Does not by itself guarantee reproducibility.
- **Phase B:** medium, iterative, needs CI cycles to converge.
- **Phase C:** docs only, gated on B.

## Unresolved Questions

- **Attestation anchor — tag or digest?** Today the attested compose pins a
  **tag** (digest refs break dstack's prelaunch, see Constraint). Do we (a) live
  with the tag→digest registry hop, (b) also commit the deployed digest to a git
  release record to anchor it in-repo, or (c) invest in a custom
  `pre_launch_script` to reclaim digest-in-compose (cleanest, trustless)?
- **Who owns the prelaunch script?** Is the GHCR-verify script Phala-injected, or
  a `pre_launch_script` we supply? Determines whether (c) above is even possible.
  Report the digest-parsing bug upstream regardless.
- Pin `ca-certificates` by copying from the base, or commit a vendored bundle in
  the repo (fully self-contained, but we own cert updates)?
- Toolchain: is locking via the base-image digest enough, or do we also want
  `rust-toolchain.toml` enforced in CI (fail if drift)?
- Multi-arch ever needed? Staging/prod are amd64 (Phala TDX); single-arch keeps
  reproducibility simplest. Confirm we never deploy arm64.
- Should the reproducibility CI guard **block** merges, or run advisory until
  Phase B converges?
- `config.toml` is copied into the image — confirm it carries no
  environment-specific or secret values that would change the digest per-deploy.
