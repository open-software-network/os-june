---
status: superseded
date: 2026-07-14
superseded_by: 0024
---

# June verifies an attested Open Software API before service-managed inference

## Context

June API is open source and remotely attested, but moving its inference traffic
from a model provider directly to os-api adds another plaintext policy and
routing hop. Open sourcing os-api makes its behavior inspectable, but source
availability alone does not prove which code is running or prevent an ordinary
deployment from receiving provider keys.

## Decision

The production inference chain was proposed as:

```text
June -> attested June API -> attested Open Software API -> private or attested model
```

- os-api runs as a Google Cloud Confidential Space workload on Intel TDX.
- Google Cloud Attestation releases os-api's runtime identity and Secret Manager
  access only to a stable, non-debug workload running an exact approved image
  digest.
- os-api publishes a public nonce-bound Google attestation token.
- June API verifies the proof and exact os-api image digest.
- Production June API refuses to start if the proof is invalid and refreshes
  the proof before service-managed inference.
- June's public `/verify` page shows both deployment policies.

## Consequences

- Digest rotation requires a coordinated two-repository release.
- A mismatch causes downtime for service-managed inference by design.
- Google Cloud Attestation, Intel TDX, both service images, and the selected
  model provider become explicit trust dependencies.

This decision was superseded before production enforcement by ADR-0024. The
cross-product startup proof and exact digest pin were removed.
