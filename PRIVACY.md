# June privacy

June is private by architecture. Recordings, transcripts, notes, and agent
session content stay on-device except when the user asks June to run model
inference through June API.

## Optional usage statistics

June can ask for opt-in anonymous usage statistics during onboarding and in
Settings > Privacy. The default is off.

When enabled in this release, June stores the choice and local counters on the
device. It does not send telemetry reports yet. Future reporting is limited to
the public question catalog in [docs/telemetry-questions.md](docs/telemetry-questions.md).

June P3A never collects prompts, responses, transcripts, notes, audio, file
names, file paths, URLs, search queries, user ids, emails, OS Accounts ids,
device ids, install ids, cookies, or free-form strings.

Turning the toggle off takes effect immediately and deletes local P3A counters.
