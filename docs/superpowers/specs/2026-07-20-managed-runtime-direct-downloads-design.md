# Managed runtime direct downloads design

**Date:** 2026-07-20

**Scope:** Repair local and installed managed Hermes bootstrap downloads after
the no-redirect security boundary was introduced. The runtime pin, artifact
checksums, archive validation, installation procedure, and fallback policy do
not change.

## Problem

June's managed-runtime client deliberately disables HTTP redirects, but two of
its pinned artifact URLs are redirectors:

- the Hermes source URL on `github.com` redirects to `codeload.github.com`;
- the uv release URL on `github.com` redirects to Astral's release asset
  storage.

The client currently treats a `3xx` response as eligible for streaming because
`error_for_status` rejects only `4xx` and `5xx`. It therefore hashes the
redirect response body and reports a misleading archive checksum mismatch.
The runtime is not installed, so June cannot start a managed Hermes session.

Live checks confirmed that the stable direct endpoints return `200` without a
redirect and that their bytes match June's existing pinned SHA-256 values:

- `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/2bd1977d8fad185c9b4be47884f7e87f1add0ce3`
  matches `7a9bd367066183898831c2760f269368ab54b458a1d1b51d14ef1f484dd490cc`;
- `https://releases.astral.sh/github/uv/releases/download/0.11.15/uv-aarch64-apple-darwin.tar.gz`
  matches `7e5b336108f8576eda1939920ca0a805b4a9a3c3d3eb2f6140e38b7092fbe4f3`.

## Decision

Keep the accepted fixed-URL, no-redirect trust boundary. Change only the two
redirecting artifact sources:

1. Pin the Hermes source URL directly to the immutable codeload commit URL.
2. Pin the uv release base URL to Astral's official, immutable release mirror.
3. Leave the direct Node.js release URL unchanged.

The downloader must require an explicit successful `2xx` status before reading
the response body. Redirects and every other non-success status fail with a
managed-runtime download error rather than falling through to checksum
validation.

This repair aligns the implementation with the existing managed-runtime
startup isolation design. It does not introduce a new architectural decision,
so it does not require a new ADR.

## Security properties

The repair preserves all existing controls:

- fixed HTTPS artifact URLs;
- ambient proxy bypass;
- redirects disabled;
- connect and total request timeouts;
- declared and streamed size caps;
- SHA-256 verification before extraction;
- pure-Rust archive validation and extraction into a private staging tree;
- fail-closed runtime admission and GitHub capability eligibility.

No general redirect allowlist is added. June does not trust a mutable redirect
destination, URL query token, ambient mirror, or system package-manager binary.

## Error handling

The response status is validated immediately after the request completes and
before content-length or body processing. A `3xx`, `4xx`, or `5xx` response
returns the existing `hermes_runtime_install_failed` error code with a generic
managed-runtime archive request message that includes only the HTTP status.
Response bodies and provider diagnostics are not surfaced.

Checksum mismatch remains reserved for a successful response whose bytes do
not match the pinned digest.

## Test plan

Add focused regressions that:

- assert the Hermes and uv production URLs use their exact direct HTTPS hosts
  and retain the pinned version or commit;
- accept successful `2xx` response statuses;
- reject redirect and other non-success statuses before body verification;
- preserve the existing byte-cap and SHA-256 mismatch tests.

Then run:

- the focused managed archive and managed artifact tests;
- Rust formatting and clippy;
- `make verify`;
- live `pnpm tauri:dev` QA that starts a new session, observes a successful
  managed-runtime install, and confirms the checksum banner is absent.

## Out of scope

- changing the Hermes, uv, or Node versions or checksums;
- allowing arbitrary or allowlisted redirects;
- weakening archive validation or managed-runtime admission;
- changing GitHub connector capabilities;
- adding GitHub write actions.
