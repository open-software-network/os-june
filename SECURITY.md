# Security policy

## Supported versions

Security fixes target `main` and the latest shipped June desktop and June API
release. Older releases may receive fixes when the impact warrants it.

## Reporting a vulnerability

Please do not file public issues for suspected vulnerabilities.

Use GitHub private vulnerability reporting when it is enabled for this
repository. If it is not available, email `security@opensoftware.co` or contact
a repository maintainer privately.

Include the affected component, reproduction steps, impact, and any relevant
logs or proof of concept. We will acknowledge the report, keep the discussion
private while we investigate, and coordinate disclosure timing with you.

## Scope

In scope:

- June desktop app authentication, local storage, updater, permissions, and
  signed release flow.
- June API authentication, model proxying, billing authorization, request
  validation, logging, and deployment configuration.
- GitHub Actions, release automation, container publishing, and signing
  material handling.

Out of scope:

- Social engineering.
- Denial of service without a clear security impact.
- Issues that require physical access to an already compromised device.
