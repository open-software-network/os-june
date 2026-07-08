# June P3A question catalog

June P3A is opt-in, question-based product telemetry. The app answers only the
questions listed here, with coarse bucket indexes. It never sends prompts,
responses, transcripts, notes, audio, file names, paths, URLs, search queries,
user identifiers, install identifiers, cookies, or free-form strings.

When telemetry is enabled, June uploads anonymous increments for these public
questions as the relevant actions happen. Local counters keep a retry cursor for
failed uploads, but the team reads aggregate cells from OS Accounts.

## Shared report metadata

Every report is one question per request and carries only:

- `schema`: wire schema version
- `question`: one of the ids below
- `bucket`: a small integer bucket index
- `platform`: `macos`, `windows`, or `linux`
- `version_series`: app minor series such as `0.0.x`
- `epoch`: ISO week such as `2026-W28`

## Catalog

| ID | Question | Buckets | Decision it informs |
|---|---|---|---|
| `general.active-days` | Days June was opened this week | 0 / 1 / 2-3 / 4-5 / 6-7 | Engagement baseline for all other ratios |
| `notes.meetings-recorded` | Meeting recording completed | event | Investment in meetings pipeline |
| `notes.audio-source` | Most-used audio source this week | none / mic only / mic + system | System-audio maintenance cost |
| `dictation.sessions` | Dictation session completed | event | Dictation as flagship vs. niche |
| `agent.sessions` | Agent session started | event | Hermes runtime investment |
| `agent.privacy-guard` | Agent privacy guard mode | off / structured | Rampart default-on decision |
| `models.privacy-mode` | Most-selected model privacy mode this week | e2ee / private / anonymous | Model catalog and TEE roadmap |
| `onboarding.completed` | Onboarding completed | completed | Onboarding funnel health |

## Change rules

- New questions require a PRD-linked product decision.
- Buckets must be the coarsest shape that still answers that decision.
- Code and this document must change together. Rust tests enforce catalog
  parity.
- Adding free-form fields or identifiers requires a new PRD.
