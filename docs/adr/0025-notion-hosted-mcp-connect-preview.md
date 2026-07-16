---
status: accepted
date: 2026-07-16
---

# Notion hosted MCP connector preview

## Context

June's Notion plugin PRD originally promised that June would use only pages the
user selected. A prior handoff reported that Notion's hosted MCP OAuth and tool
inventory work, but the source and complete redacted evidence are unavailable in
this checkout. More importantly, selected-resource scoping has not been proven
for hosted search, fetch, and data-source tools.

The user needs to inspect the real Notion connection lifecycle and make the
connected hosted MCP server available to June. Enabling broad hosted tools before
the scoping boundary is proven could expose broader Notion workspace content to
the agent and would contradict the bounded-page product promise, so the preview
must remain explicit about its unverified access boundary.

## Decision

June may ship a clearly labelled **Notion hosted MCP connector preview** that
connects and disconnects an account and registers a read-only `june_notion` MCP
toolset with Hermes. Clicking **Connect** opens Notion's hosted MCP OAuth flow
directly in the default browser. This implementation does not test or enforce
selected-resource scoping and does not enable Notion write/action tools.

The preview uses the hosted MCP server at `https://mcp.notion.com/mcp` with the
OAuth standards for a native public client:

- RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata,
  RFC 8707 resource indicators, RFC 7591 dynamic client registration when the
  server advertises it, RFC 8252 loopback redirects, and PKCE S256.
- June pins the protected resource to the HTTPS `mcp.notion.com` origin and
  validates discovered metadata, issuer, endpoint hosts, redirect policy,
  resource identity, and S256 support before opening the browser.
- OAuth opens the default browser and receives the response at an ephemeral,
  exact loopback callback path. State, authorization-server identity, and PKCE
  verifier are bound to one serialized connect attempt.
- Tokens and sensitive dynamic-registration material live only in a dedicated
  Notion Keychain service. SQLite stores no Notion credential, registration
  material, page title, workspace identifier, or content. Debug builds do not
  get a plaintext fallback for this preview.
- Disconnect deletes local token and registration custody together. It is local
  removal unless a separately supported provider revocation or registration
  deletion path is explicitly offered and completed.

Before and after authorization, June's settings copy must stay honest: selected
Notion page/resource scoping is not verified in this pass; the credential
remains on the device; and the exposed `june_notion` toolset is a preview over
Notion hosted MCP read tools, not a selected-page privacy guarantee. The Connect
action itself opens Notion's MCP auth flow without a separate June
resource-picker or scoping probe.

## Consequences

- Users can inspect real Notion authorization, local credential lifecycle, and
  hosted MCP tool discovery through a June-owned `june_notion` toolset.
- The implementation intentionally ignores selected-resource scoping for this
  pass, so UI and docs must not claim page-bounded access.
- "Connected" means OAuth material is locally stored for Notion's hosted MCP
  service and June can register the `june_notion` bridge. It does not prove
  selected-resource scoping.
- The Notion plugin remains unsuitable for content workflows until read-only
  probes establish a provider-enforced selected-resource boundary or June adds a
  Rust-enforced authorized-root graph that filters every response before Hermes
  sees it.
- The preview creates dynamic registrations over time. June reuses valid stored
  registration metadata for the registered redirect URI where possible, creates
  a fresh registration when the ephemeral callback URI requires it, and treats
  provider-side cleanup as best-effort until the provider documents deletion.
- This ADR supersedes the Notion deferral in ADR-0016 only for the hosted MCP
  connector preview. The Google local-mode architecture and all of its action
  trust decisions remain unchanged.

## Exit criteria

Promote, replace, or remove the preview only after all of the following are
satisfied:

1. Recover or reproduce complete redacted transport/tool evidence.
2. Run and retain the selected-resource scoping matrix, including pagination and
   metadata/snippet leak checks.
3. Publish a Notion-specific connector threat model and privacy copy backed by
   the observed boundary.
4. Replace preview read tools with a bounded production read path only after the
   boundary is provider-enforced or Rust-enforced before Hermes receives any
   provider result.
5. Add writes only with an explicit approval surface and preflight model.

## Addendum: approved create-page action in the preview

Notion's hosted MCP documentation describes the hosted MCP server as read/write,
and direct MCP clients such as Pi can expose page-creation tools when connected
to the same Notion hosted MCP endpoint. June should not present the Notion
connector as permanently read-only when the provider-supported MCP capability is
available.

This addendum narrows and supersedes the original decision's blanket
"does not enable Notion write/action tools" statement for one action: June may
add a Notion page-creation capability to the hosted MCP preview. The existing
`june_notion` bridge remains the read-tool surface. Page creation must be
exposed through a separate action path, preferably `june_notion_actions`, so the
trust meaning of `june_notion` does not change.

The preview may initially allow only the provider's page-create hosted MCP tool.
Other write or action tools remain disabled unless a later ADR or addendum
approves them. In particular, update, delete, move, duplicate, comment, and
attachment tools remain out of scope for this addendum.

Every page-create call must be gated by June before it reaches Notion:

- Hermes and React never receive raw Notion tokens or dynamic-registration
  secrets.
- Rust continues to resolve Notion credentials from Keychain and proxy the
  hosted MCP call.
- The requested hosted MCP tool must match an explicit Notion action allowlist.
- The user must approve the write before June calls Notion. The approval should
  show the operation, destination or parent when available, title, and a content
  preview.
- Rust should preflight the request before commit: verify Notion is connected,
  validate the required arguments, and reject malformed or ambiguous writes.
- Logs must not include tokens, dynamic client material, raw private page
  bodies, or full hosted MCP payloads.

Settings copy must also change when this capability ships. It must no longer say
"read-only preview" as the complete connector state. It should remain honest
that selected-resource scoping is not verified and that Notion may allow access
beyond selected pages, while making clear that page creation requires explicit
approval.
