# Implementation plan: Spreadsheets plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Proposed; depends on the artifact broker
- **PRD:** [spreadsheets-prd.md](spreadsheets-prd.md)

## Technical objective

Extend the shared artifact broker with a typed workbook IR and deterministic
CSV/TSV/XLSX adapters. Keep binary generation and validation out of model text,
bound every read/write, never execute active content, and export only through
the June UI.

## Dependencies

- Documents Phase 0 selects the shared artifact worker/broker pattern.
- The package-security spec governs any new Rust crate, Python wheel, binary,
  and build script.
- A formula-engine spike must establish exactly which functions June can
  calculate versus preserve without calculation.

## Phase 0: workbook engine spike

Compare a Rust-native path (for example, a safe XLSX reader plus deterministic
writer) with an isolated pinned worker. Evaluate:

- cell types, shared strings, styles, merges, formulas, cached results, dates,
  errors, names, filters, hidden rows/sheets, charts, and conditional formats;
- formula calculation coverage and compatibility;
- malformed ZIP/XML safety, memory bounds, package size, sandbox behavior,
  licensing, and reproducibility;
- render strategy for table and chart previews.

Exit with a supported feature/function matrix. Unsupported formulas are
preserved and labeled "not recalculated" or rejected for a requested edit; June
never invents a cached value.

## Architecture

```text
Hermes -> june_spreadsheets MCP -> Rust artifact broker -> workbook engine
                                             |-> immutable workbook versions
                                             |-> table/chart previews
                                             `-> validation + calculation report
June UI -> native save dialog -> explicit export copy
```

Workbook IR includes workbook metadata, sheet properties, cells with typed
value/formula/style, ranges, names, merges, filters, panes, conditional rules,
and supported charts. All operations target stable sheet ids and A1 ranges.

## Proposed tools

| Tool | Behavior |
| --- | --- |
| `inspect_workbook` | Sheets, dimensions, names, formulas, links, active-content findings, warnings |
| `read_range` | Bounded typed cells with formula and displayed/cached value |
| `profile_range` | Local summary statistics and type/null/error profile |
| `create_workbook` | New immutable version from structured sheets |
| `revise_workbook` | Typed cell/range/sheet/style operations |
| `calculate_workbook` | Supported-function calculation report |
| `render_workbook` | Bounded table/chart preview artifacts |
| `compare_workbook_versions` | Cell/formula/structure diff |
| `export_workbook` | UI handoff only |

No arbitrary code, SQL, formula language extensions, macros, or raw OOXML.

## Safety and bounds

- Reject macros, OLE, external data connections, DDE, remote images, and unsafe
  relationships. Preserve a clean imported copy only when the support matrix
  permits it.
- Record hidden rows/columns/sheets and comments in inspection; do not silently
  omit them from prompt-injection review.
- Bound compressed/uncompressed bytes, sheets, cells, formulas, styles, images,
  charts, operations, and preview size.
- Large analysis uses local streaming/profile operations and sends only selected
  ranges/statistics to the model.
- CSV/TSV export defaults to safe text: neutralize cells beginning with `=`,
  `+`, `-`, or `@` using the documented target-compatible escape. Raw formula
  export is a separate explicit override with a warning and native confirmation;
  it is never selected implicitly or reused from a prior export.

## Version and export model

Reuse `artifacts/spreadsheets/<id>/` immutable manifests, content hashes,
atomic completion, source refs, previews, and validation. Import never grants a
write path to the original. Tauri owns native export and replace confirmation.

## Delivery slices after Phase 0

1. **Workbook IR + CSV/TSV (1-2 weeks).** Inspect/read/create/revise/export.
2. **XLSX reads (2 weeks).** Types, formulas, styles, structure, safety findings.
3. **XLSX create/revise (2 weeks).** Supported subset and immutable versions.
4. **Calculation + validation (2 weeks).** Function corpus and honest status.
5. **Preview + diff (1 week).** Table/chart artifacts and semantic changes.
6. **Skills + rc (1 week).** Analysis/cleanup templates and dogfood corpus.

## Verification

- Conformance corpus produced by Excel, Google Sheets export, Apple Numbers,
  and LibreOffice; automated CI checks structural/semantic invariants.
- Formula golden corpus for every supported function, types, error propagation,
  date systems, locale-independent storage, and circular references.
- Fuzz/malformed tests for ZIP bombs, XML attacks, shared-string abuse, style
  explosion, broken relationships, and oversized dimensions.
- Injection corpus in cells, formulas, comments, names, hidden content, links,
  metadata, and CSV-leading formula characters.
- Export-boundary tests and reference-editor smoke qualification.
- Memory/time benchmarks at each published workbook limit.

## Rollout

CSV/TSV first, then XLSX rc behind a format flag. Publish the exact workbook and
formula support matrix. Keep format/engine kill switches and content-free size,
latency, validation, and error telemetry. Preserve the source and last valid
version on every failure.
