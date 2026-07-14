# Automatic private model rollout

June supports `open-software/auto` while retaining explicit model selection. Auto persists a
Cost-to-quality preference and forwards it through Hermes and note generation.

The rollout remains reversible. Production compose pins
`JUNE__UPSTREAMS__VENICE__BASE_URL` to `https://api.opensoftware.co/v1`; Phala's sealed
`JUNE__UPSTREAMS__VENICE__API_KEY` contains June's dedicated os-api service key.

June API sends `X-Confidential-Compute: preferred` on service-managed text inference. This is an
intentional zero-retention policy, not a TEE guarantee: os-api tries Venice private first and falls
back to a compatible Phala TEE endpoint. It never falls below zero retention. A caller that truly
requires hardware-backed confidential compute must send `required` directly to os-api; June does
not require that stronger contract for its normal text workloads.

The policy is server-side and remains compatible with shipped June builds. Existing clients keep
sending legacy model ids such as `zai-org-glm-5-2`; os-api resolves them to canonical models without
breaking June's existing `/v1` contract. User-supplied Venice keys continue to use Venice's
public API directly and do not receive the os-api routing header.

June API preserves os-api's selected provider, privacy level, and endpoint as additive response
metadata (`upstreamProvider`, `privacyLevel`, and `upstreamEndpoint`, plus `X-OS-*` chat headers).
The existing `provider` field keeps its historical Venice adapter meaning for shipped clients.
Legacy aliases and canonical live-catalog model IDs must both cover the most expensive enabled
private route because settlement is currently keyed by requested model ID.

Build the desktop release with `OS_JUNE_AUTO_MODE_DEFAULT=true`. Existing users retain their saved
model. Roll back by restoring the Venice URL in production compose and removing the build flag.
