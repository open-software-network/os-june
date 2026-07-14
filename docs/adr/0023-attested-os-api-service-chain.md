---
status: accepted
date: 2026-07-14
---

# June verifies an attested Open Software API before service-managed inference

## Context

June API is open source and remotely attested, but moving its inference traffic
from a model provider directly to os-api adds another plaintext policy and
routing hop. Open sourcing os-api makes its behavior inspectable, but source
availability alone does not prove which code is running or prevent an ordinary
deployment from receiving provider keys.

## Decision

The production inference chain is:

```text
June -> attested June API -> attested Open Software API -> private or attested model
```

- os-api runs as a Google Cloud Confidential Space workload on Intel TDX.
- Google Cloud Attestation releases os-api's runtime identity and Secret Manager
  access only to a stable, non-debug workload running an exact approved image
  digest.
- os-api publishes a public nonce-bound Google attestation token at
  `POST /v1/gateway/attestation` and fails closed outside Confidential Space.
- June API verifies Google's signature, issuer, audience, expiration, caller
  nonce, software identity, debug state, hardware model, stable support status,
  and exact os-api image digest.
- Production June API refuses to start if the proof is invalid. Service-managed
  text inference refreshes the proof on a bounded cache and fails closed when
  it cannot be refreshed. User-provided Venice keys continue to route directly
  to Venice and do not depend on os-api.
- June's public `/verify` page shows both deployment policies and includes a
  browser-side fresh proof verifier.

## Consequences

- A source commit or container tag is insufficient for promotion. The immutable
  os-api digest must be stamped into both Google workload identity policy and
  June configuration.
- Digest rotation is a coordinated two-repository release. A mismatch causes
  downtime for service-managed inference by design.
- Google Cloud Attestation, Intel TDX, the June image, the os-api image, and the
  selected model provider remain explicit trust dependencies.
- This proves the model routing service workload identity and makes secret release
  enforceable. It does not by itself prove every upstream model's implementation;
  os-api inference receipts remain the source for model privacy and attestation
  evidence.
