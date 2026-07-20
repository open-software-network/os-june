# june.link isolated rollout

`june.link` must never be added to the `os-june-api-production` ingress. The
short-link origin runs on `os-june-link-production`, with a separate
dstack-ingress, certificate volume, and viewer-only June API process.

## Safety invariants

- The primary production compose owns only `june-api.opensoftware.co`.
- The isolated compose owns only `june.link`.
- `JUNE__SHARE__VIEWER_ONLY=true` removes share mutation, inference, upload,
  and reporting routes from the short-link process.
- The June API image is smoke-tested in viewer-only mode before deployment.
- The deployment is update-only: automation refuses to create or select the
  primary CVM.
- The primary API must return 200 immediately before and after an isolated
  deployment.

## Prerequisites (no traffic cutover)

1. Merge and promote the server change while the primary compose is still
   single-domain. Confirm `https://june-api.opensoftware.co/healthz` is 200.
2. Wait for the Cloudflare `june.link` zone to report **Active**. Confirm its
   authoritative nameservers are `amos.ns.cloudflare.com` and
   `gigi.ns.cloudflare.com`, and leave Cloudflare managed CAA disabled so the
   dstack ingress can publish its attested Let's Encrypt CAA policy.
3. In Phala, provision a distinct CVM named exactly
   `os-june-link-production`. Do not clone or update
   `os-june-api-production`.
4. Seal the following complete environment on the new CVM. `phala envs update`
   is full replacement, so every update must include every value:

   - `DSTACK_DOCKER_REGISTRY=ghcr.io`
   - `DSTACK_DOCKER_USERNAME`
   - `DSTACK_DOCKER_PASSWORD`
   - `CLOUDFLARE_API_TOKEN` scoped only to the `june.link` zone
   - `CERTBOT_EMAIL`
   - `JUNE__SHARE__DATABASE_URL`
   - `JUNE__SHARE__VIEWER_CLIENT_ID`

5. Confirm DNS has no registrar parking A record. The isolated ingress will
   publish and the workflow will verify its dstack-managed
   `_dstack-app-address.june.link` TXT binding. Keep the Cloudflare record
   DNS-only; dstack-ingress terminates TLS.
6. Do not ship a desktop build that emits `june.link` until the activation and
   functional checks below pass.

## Activation

Run the manual `deploy-june-link` workflow with:

- `image-tag`: `production` (or an explicitly approved immutable source tag)
- `confirmation`: `deploy-june.link`

The workflow refuses to continue when the separate CVM is absent, DNS is not
delegated or registrar parking remains, the candidate image does not enforce
viewer-only routing, or the primary API is unhealthy. It deploys only
`june-api/deploy/docker-compose.june-link.yml`; it does not retag the production
image and does not change the primary CVM.

## Functional gate before client cutover

1. `https://june.link/healthz` returns 200.
2. `https://june.link/v1/models` returns 404 (viewer-only boundary).
3. Create a disposable link share through the desktop against the primary API.
4. Open it in a signed-out browser and confirm exact decryption without a
   passcode.
5. Repeat with a passcode and a wrong-passcode attempt.
6. Stop the disposable share and confirm the same link returns the generic
   not-found state.
7. Reconfirm `https://june-api.opensoftware.co/healthz` is 200, then allow the
   desktop/RC cutover.

## Rollback

Roll back or stop only `os-june-link-production`. Never edit the primary
compose as part of a june.link rollback. Existing June API traffic remains on
`june-api.opensoftware.co`; pause client promotion until the isolated viewer is
healthy again.
