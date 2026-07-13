# PRD: Spreadsheets plugin

- **Mode:** CEO
- **Rank:** 10 of 10
- **Score:** 64/100
- **Date:** 2026-07-13
- **Status:** Proposed

## Thesis

Spreadsheets gives June a local, inspectable way to turn meeting data and files
into structured analysis. It should analyze an imported workbook, explain its
logic, build or revise a safe copy, verify formulas and shape, and export an
editable XLSX or CSV without relying on a cloud spreadsheet service.

It ranks tenth because it is valuable and already appears in June's product
story, but high-quality spreadsheet work needs deterministic calculation,
formula safety, and visual verification. The shared artifact broker should land
with Documents first.

## Customer and problem

Operators receive spreadsheets before and after meetings, but understanding
them is slow and error-prone. Chat can explain pasted cells, yet cannot reliably
preserve workbook structure, formulas, types, sheets, and charts. Cloud upload
is often unacceptable for financial, client, or personnel data.

## Product promise

Work from a local copy, see what June changed, validate the workbook, and export
only the version you approve. No macro execution and no silent overwrite.

## V1 experience

- Import CSV, TSV, or XLSX into the June workspace.
- Ask questions about sheets, ranges, formulas, anomalies, and summaries.
- See a compact table preview and cited cell/range references.
- Ask June to clean data, add a derived column, create a summary sheet, or build
  a new workbook from meeting data.
- Review a typed change summary, recalculation status, warnings, and preview.
- Export a validated XLSX/CSV through the native save dialog.

## Scope

### V1

- Read/write CSV, TSV, and non-macro XLSX.
- Values, types, formulas in a supported subset, styles, merged cells, frozen
  panes, filters, basic conditional formatting, and basic charts if the chosen
  engine can verify them.
- Typed range operations, immutable versions, semantic diff, validation, and
  preview.
- Analysis, cleanup, forecast-input, action tracker, and status-report skills.

### Later

- XLSM/macros, external data connections, pivot tables, Power Query, full chart
  parity, live collaboration, Google Sheets/Excel publication, and large-data
  engines.

## Non-goals

- Executing macros or external links.
- Claiming formula parity with Excel for unsupported functions.
- Overwriting the imported workbook.
- Acting as an accounting system or making financial decisions for the user.
- Full BI/dashboard replacement.

## Packaging

- No connector is required.
- App-owned toolset: inspect, read ranges, create, revise, calculate/validate,
  render, compare, export.
- Skills: data cleanup, meeting action tracker, budget variance, pipeline review,
  experiment analysis.
- Optional Google/Microsoft capabilities can publish an approved exported copy.

## Privacy and trust

Parsing, transformation, storage, and preview stay on-device. Selected workbook
content used for reasoning follows the selected inference path. Formula text,
sheet names, comments, hidden cells, links, and metadata are untrusted input.
Macros and external connections are disabled.

## Business model

Core analysis and export are Hobby. Larger workbook limits, repeated monitoring,
and cross-plugin reporting routines are Pro. Local compute does not add a new
credit action; model usage remains metered normally.

## Success measures

| Metric | Target |
| --- | ---: |
| Imported workbooks reaching a useful answer or export | 60% |
| Exported workbooks opening without repair | 99% |
| Supported formulas changing result unexpectedly | 0 in conformance corpus |
| Exports needing structural repair | under 3% |
| Original workbook overwritten without explicit confirmation | 0 |

## Risks and gates

- Formula engines differ, and writing cached results without real recalculation
  can mislead users.
- Hidden sheets/cells and external links can conceal instructions or data.
- Large workbooks can exhaust memory and model context.
- Spreadsheet outputs can influence consequential financial or operational
  decisions; validation and uncertainty must be visible.

## Decision requested

Approve CSV/TSV/XLSX with a supported formula subset, immutable versions, and
no macro execution. Build after the shared artifact broker and publish a strict
format/function support matrix.
