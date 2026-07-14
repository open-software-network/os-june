# Implementation plan: Canva plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; credential and API review gates
- **PRD:** [canva-prd.md](canva-prd.md)

## Technical objective

Expose selected Canva designs through metadata reads and approval-gated export
jobs. Add template autofill only when generally available, publicly reviewable,
and bounded by an explicit field schema.

## Phase 0: credential and capability matrix

1. Test Connect API authorization, refresh, revoke, integration review, team
   selection, redirect constraints, and client-secret requirements.
2. Reject embedding the client secret. Evaluate a minimal TEE code exchange
   that returns tokens to Keychain and does not proxy Canva content.
3. Test design/folder scope availability, export formats by design type,
   asynchronous job expiry, download URL lifetime, and rate limits.
4. Mark every preview endpoint as unavailable to public v1, including preview
   webhooks that cannot pass review.
5. Test brand-template/autofill availability and schema constraints separately
   from export.

Exit with an ADR-approved credential exchange or deferral, plus a
generally-available endpoint/scope matrix.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_canva` | `list_designs`, `get_design`, `list_folders`, `get_export_formats`, `get_export_status` |
| `june_canva_actions` | `create_export`, `create_from_brand_template` (gated) |

No tool exposes arbitrary element editing. Preview-only tools are omitted from
the runtime schema, not merely hidden in UI.

## Boundary and state

- Keychain token if Phase 0 approves device custody after exchange.
- Canva user/team, selected design/folder ids, capability/version matrix,
  export jobs, rate-limit state, and health in SQLite.
- No design body, asset corpus, or completed export retained by default.
- Rust verifies selected design/folder identity on every call and validates
  download hosts from provider responses.

## Action and artifact model

- Export approval shows design, format/options, page selection, destination,
  estimated disclosure, and local save behavior.
- Poll async jobs with bounded backoff and terminal-state handling.
- Download to a task-scoped temporary file, inspect type/size, then use native
  save approval. Delete temporary data after completion/cancel.
- Template autofill validates exact provider field keys and type/length bounds;
  approval shows every June-originated value sent.
- Job creation is not blindly retried after timeout. Reconcile against recent
  jobs or require confirmation.

## Events

Public v1 has no Canva webhook dependency. Current webhook support is preview
and public integrations using it cannot pass review. Collaboration triggers
remain future away-mode work after general availability and threat review.

## Delivery slices after Phase 0

1. Auth exchange, team/design selection, revoke, and health.
2. Metadata reads and export-format discovery.
3. Approved export job, polling, download, and native save.
4. Optional brand-template spike and gated autofill action.
5. Creative-quality fixtures, pilot, metrics, and kill switch.

## Verification

- Auth, refresh, revoke, team removal, design access removal, scope denial,
  review-mode restrictions, and disconnect.
- Forged ids/hosts, moved designs, unsupported format, multi-page limits,
  expired downloads, failed/cancelled jobs, and rate limits.
- Duplicate export, timeout, polling interruption, malicious MIME/name, and
  restart tests.
- Injection corpus in design metadata, comments, template fields, and links.
- Live walkthrough across Docs, Presentation, and one unsupported format.

## Architecture decision gate

A TEE credential exchange meets the repo's ADR threshold because it introduces
a backend secret and changes privacy copy even if provider content stays direct
to Canva. No implementation begins before that decision is accepted.
