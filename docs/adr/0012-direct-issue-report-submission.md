# ADR 0012: Direct issue-report submission with server-side diagnosis

Date: 2026-07-06
Status: accepted

## Context

Issue reports (bug, feedback, feature) were composer messages tagged with a
category chip. Submitting one wrapped the user's text in an investigation
prompt and ran it as a normal agent turn before the report was delivered to
`/v1/issue-reports` with the resulting `agentDiagnosis`. Three code comments
described a server-side "no-charge waiver" keyed off the report category, but
no waiver was ever implemented in June API or OS Accounts: the investigation
turn was metered and charged like any agent chat, at whatever generation model
the user had selected (JUN-213). Users were paying to file issue reports, and
the price scaled with their model choice.

Making the intended waiver real was designed first and rejected. The waiver
signal has to originate in the client (only the composer knows a turn is a
report), and the turn's model calls flow through the embedded Hermes runtime,
whose `prompt.submit` contract carries no metadata — the flag would have to
ride a synthetic model id or per-session state in the shell's loopback
provider endpoint (the Bridge), then be honored by June API only under a
server-enforced model pin so a spoofed flag could not mint free tokens on an
expensive model. That is three layers of new contract (frontend, the shell's
loopback endpoint, June API) to keep an investigation turn nobody sees,
and it strands every already-shipped app version, which sends no flag and
would keep charging users.

## Decision

Reports no longer run a client-side model turn at all.

- The client submits reports directly: a popover (reachable from the composer
  "+" menu, the sidebar, and settings) collects category, description, and
  file attachments, and calls `submit_issue_report` -> `/v1/issue-reports`.
  No Hermes session is involved, so there is nothing to authorize or charge.
  The category chip machinery stays wired for drafts that still carry chips,
  but no entry point inserts new chips.
- The team-facing diagnosis moves into June API. When a report arrives without
  an `agentDiagnosis` (new clients) and `issue_reports.diagnosis_model` is
  configured, June API runs one non-streaming completion on that model at
  June's own upstream expense — never metered, never charged, invisible to the
  user — under a hard timeout, and feeds the text through the existing
  diagnosis splitter. Any diagnosis failure delivers the report undiagnosed;
  diagnosis can delay a submission by at most the configured timeout and can
  never drop one. Old clients that still send a client-side diagnosis pass
  through unchanged.

## Consequences

- JUN-213 is fixed by construction for updated clients: no model call exists
  on the report path, so no waiver, model pin, or anti-spoofing logic is
  needed. Not-yet-updated clients keep today's charged behavior until they
  update; June API cannot waive their turns because they send no signal.
- June eats one cheap, server-pinned completion per report instead of users
  paying for one user-priced turn per report. Cost is bounded by config
  (`diagnosis_model`, `diagnosis_timeout_secs`); unsetting the model turns
  diagnosis off entirely.
- The server-side diagnosis sees only the report fields (category,
  description, platform, app version, attachment names), not the user's
  session context or attachment bytes, so it is shallower than the old
  client-side investigation. Richer inputs (attachment text, screenshots)
  are a deliberate follow-up.
- The report UX is fire-and-forget (JUN-197 direction): no visible agent
  conversation, no user-facing diagnosis. If a report-followup conversation
  is wanted later, it needs a new design.
