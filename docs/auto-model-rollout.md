# Automatic private model rollout

Clovy supports `open-software/auto` while retaining explicit model selection. Auto persists a
cost-to-quality preference and forwards it through the Clovy-owned agent runtime and note
generation.

The rollout remains reversible. Production compose pins
`CLOVY__UPSTREAMS__VENICE__BASE_URL` to `https://api.opensoftware.co/v1`; Phala's sealed
`CLOVY__UPSTREAMS__VENICE__API_KEY` contains Clovy's dedicated os-api service key.

Clovy API sends `X-Confidential-Compute: preferred` on service-managed text inference. This is an
intentional zero-retention policy, not a TEE guarantee: os-api tries Venice private first and falls
back to a compatible Phala TEE endpoint. It never falls below zero retention. A caller that truly
requires hardware-backed confidential compute must send `required` directly to os-api; Clovy does
not require that stronger contract for its normal text workloads.

The policy is server-side and remains compatible with shipped desktop builds. Existing clients keep
sending legacy model ids such as `zai-org-glm-5-2`; os-api resolves them to canonical models without
breaking Clovy's existing `/v1` contract. User-supplied Venice keys continue to use Venice's
public API directly and do not receive the os-api routing header.

Clovy API preserves os-api's selected provider, privacy level, and endpoint as additive response
metadata (`upstreamProvider`, `privacyLevel`, and `upstreamEndpoint`, plus `X-OS-*` chat headers).
The existing `provider` field keeps its historical Venice adapter meaning for shipped clients.
Legacy aliases and canonical live-catalog model IDs must both cover the most expensive enabled
private route because settlement is currently keyed by requested model ID.

For an agent run, Auto selects a canonical model on the first inference. Tool continuations and
approval resumes pin that selected model for the remainder of the agent run so provider-native
reasoning history remains compatible. Clovy also preserves the reasoning field observed on that
response when replaying assistant history, rather than deriving the provider wire format from a
model ID. A later user-initiated agent run evaluates Auto again. Provider, privacy, and endpoint
metadata remain observational and are not continuation tokens.

Build the desktop release with `OS_CLOVY_AUTO_MODE_DEFAULT=true`. Existing users retain their saved
model. Roll back by restoring the Venice URL in production compose and removing the build flag.
