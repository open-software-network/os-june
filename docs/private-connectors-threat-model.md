# Private connectors: local mode threat model

**Status:** source of truth for connector privacy copy. Every user-facing
privacy claim about connectors must be traceable to a line on this page; if a
claim is not supported here, the claim is wrong, not the page. Scope is **local
mode** (the only connector mode that ships in Phases 1-2). Away mode (the
Phase 3 TEE relay) will publish its own, larger threat model when it ships.

## What local mode is

You authorize Google on your Mac. The refresh token Google mints is stored in
your Mac's Keychain. Every Gmail and Calendar API call June makes originates
from your device, using that token, and goes straight to Google. June's
backend (June API) is not involved in connector calls.

## What OpenSoftware can and cannot see

**Cannot see, by architecture:**

- Your Google refresh or access tokens. They are in your Keychain, sealed to
  June's code-signing identity, and never transmitted to OpenSoftware. We hold
  no credential that can read your mail, so there is nothing to hand over under
  a subpoena and nothing to steal in a breach of our servers.
- The content of your mail or calendar as it flows through a connector call.
  Connector requests go device -> Google, not through June API.

**Can see, and you should know it:**

- **Model inference is a separate path.** When a routine runs, its prompt (which
  can include mail or calendar content the routine chose to read) goes to
  whichever model provider you selected. By default that is June API, which runs
  in a TEE (Phala) so its own operators cannot read prompt data, but it is still
  a network call off your device. If you select a local model, inference stays
  on-device too. The "OpenSoftware is not in the connector data path" claim
  covers token custody and provider API calls. It does not cover inference, and
  the copy never implies it does.
- **Billing metadata.** Metered model calls settle against OS Accounts, so the
  usual coarse billing records exist (that a metered call happened, its action
  slug, credits charged). No mail content is in them. June's only product
  telemetry remains opt-in, coarse-bucketed P3A aggregates; connectors add no
  per-user app telemetry.

## Trust surface for local mode

Local mode adds exactly these things to what you already trust by running June:

1. **Google.** You are granting June's OAuth client access to the scopes you
   approve. Google sees the same API calls any mail client would.
2. **Your device's Keychain and June's code signature.** Token secrecy rests on
   macOS Keychain access control and June being correctly signed. A local
   attacker with your unlocked machine and your login keychain can reach the
   tokens, the same as for any app's Keychain items.
3. **The embedded agent.** June's agent can call the connector tools you enable.
   The protections below bound what it can do without you.

## Agent-facing protections

- The agent cannot read the token store. The Keychain is denied to the agent by
  the sandbox profile; the tokens live in Rust, and the MCP tool servers hold
  only a scoped loopback token, never a Google token.
- Connector tool descriptions mark email and calendar content as untrusted
  input, because a hostile email can carry instructions (prompt injection).
- Mutating actions (send, draft, label changes, event changes, invite
  responses) are gated by **trust mode**. The default is approval: the action
  parks in June's own approval surface and waits for you. Read-only routines
  cannot call mutating tools at all. Autonomous execution must be earned (three
  correct approval-mode runs) and is granted per tool.

## Known limitation (stated plainly)

The pinned agent runtime grants every enabled connector tool to interactive
chat sessions by default. So a tool you granted a routine for autonomous use is
also callable, without the approval prompt, if you ask June to do it in a normal
chat for the same account. This is bounded to tools you explicitly granted and
to the account you connected. Routines still enforce trust modes as described.
The fix (per-session tool selection, or excluding the action servers from the
interactive toolset) depends on a runtime capability not present in the current
pin and is tracked as a followup; away mode's threat model will restate this if
it is still open then. See
[ADR-0016](adr/0016-private-connectors-local-mode.md).

## Revocation

Disconnecting an account deletes its tokens from the Keychain immediately.
"Also revoke June's access with Google" additionally calls Google's revoke
endpoint so the grant is dead server-side. Both paths are in Settings ->
Connectors.
