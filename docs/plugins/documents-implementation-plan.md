# Implementation plan: Documents plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Proposed; artifact-engine spike required
- **PRD:** [documents-prd.md](documents-prd.md)

## Technical objective

Create a brokered, versioned document pipeline inside the agent workspace. The
model supplies structured intent; deterministic code creates, inspects, renders,
validates, and exports artifacts. The model never constructs opaque binary data
or chooses an arbitrary filesystem destination.

## Phase 0: artifact-engine spike

Timebox two weeks to compare:

1. A Rust-native OOXML subset using ZIP/XML libraries and a June-owned document
   intermediate representation.
2. A pinned app-owned worker using audited document libraries, isolated from
   Hermes and packaged with reproducible wheels/binaries.
3. macOS Quick Look or another supported rendering path for visual preview,
   including behavior in a signed sandboxed build.

Measure fidelity, package size, cold start, supported structures, licensing,
sandbox behavior, malformed-input safety, and reproducibility. The exit artifact
is an accepted engine choice, support matrix, and threat model. Adding a large
runtime or privileged helper meets the ADR threshold.

## Architecture

```text
Hermes -> june_documents MCP -> Rust artifact broker -> document engine
                                          |-> versioned workspace artifacts
                                          |-> preview images/HTML
                                          `-> validation report
June UI -> native save dialog -> explicit export copy
```

Use one June-owned intermediate representation (IR) for the supported subset:
document metadata, sections, block nodes, inline runs, styles, tables, images,
links, headers/footers, and source references. MCP inputs and outputs use this
IR; the engine owns OOXML.

## Proposed tools

| Tool | Behavior |
| --- | --- |
| `inspect_document` | Parse supported structure, metadata, warnings, and active-content findings |
| `create_document` | Create a new version from structured blocks and template id |
| `revise_document` | Apply typed operations to a prior version |
| `render_document` | Produce bounded preview artifacts |
| `validate_document` | Re-open output and check structural/semantic invariants |
| `compare_document_versions` | Return semantic changes and preview refs |
| `export_document` | Request a June UI export handoff, never an arbitrary path |

`revise_document` accepts typed operations such as replace block, insert after,
delete block, set style, and update table cell. It does not accept raw XML.

## Files and versions

- Import through `import_hermes_bridge_file`; treat the imported copy as source.
- Store artifacts under a per-session workspace `artifacts/documents/<id>/` with
  immutable versions, manifest, source refs, preview refs, and validation.
- Use content hashes and atomic rename for completed versions.
- Enforce file count, uncompressed ZIP size, XML depth, image bytes, page/block
  count, and total operation bounds.
- Strip or reject macros, OLE objects, external templates, remote images, and
  unsafe relationships.

## Rendering and validation

Validation has three levels:

1. Container: safe ZIP, required parts, relationship targets, content types.
2. Semantic: all IR nodes round-trip, links/images resolve locally, headings and
   tables match requested content, no unexpected active content.
3. Visual: render supported pages, check non-empty bounds and obvious clipping,
   and show the actual preview to the user.

The UI labels unsupported or approximate layout. It never claims pixel parity.

## Export boundary

The broker emits an export-ready artifact id. Tauri opens the native save dialog
and copies the validated version. The agent cannot supply a path outside its
workspace. Existing destination replacement requires native confirmation.

## Delivery slices after Phase 0

1. **Artifact broker + IR (2 weeks).** Version store, bounds, MCP skeleton.
2. **Markdown/text (1 week).** Create/read/revise/export and baseline UI.
3. **DOCX create (2 weeks).** Supported structures, templates, validation.
4. **DOCX inspect/revise (2 weeks).** Copy-on-edit and unsupported warnings.
5. **Preview/compare (1-2 weeks).** Visual artifacts and semantic diff.
6. **Skills + rc (1 week).** Templates, dogfood corpus, runbook.

## Verification

- Golden files opened in at least Microsoft Word, Apple Pages, and LibreOffice
  during release qualification; automated structural validation remains the CI
  gate.
- Fuzz/malformed corpus for ZIP bombs, XML entity expansion, relationship path
  traversal, corrupt images, macros, OLE, and external references.
- Round-trip property tests for every IR node and style.
- Snapshot previews across supported fonts/page sizes.
- Export tests proving the agent cannot choose or overwrite arbitrary paths.
- Prompt-injection corpus in document text, metadata, links, comments, alt text,
  and hidden/unsupported structures.

## Rollout

Developer templates, internal docs, rc opt-in, stable. Keep a format/engine kill
switch and content-free operation telemetry. Publish the support matrix in the
plugin detail and preserve artifacts when rendering fails so users can recover.
