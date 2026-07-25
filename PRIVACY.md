# June privacy

June is private by architecture. Recordings, transcripts, notes, and agent
session content stay on-device except when the user asks June to run model
inference through June API.

## Optional usage statistics

June can ask for opt-in anonymous usage statistics during onboarding and in
Settings > General > Privacy. The default is off.

When enabled, June sends anonymous increments for the public questions in
[docs/telemetry-questions.md](docs/telemetry-questions.md). Local counters keep
track of uploads that need to be retried.

June P3A never collects prompts, responses, transcripts, notes, audio, file
names, file paths, URLs, search queries, user ids, emails, OS Accounts ids,
device ids, install ids, cookies, or free-form strings.

Turning the toggle off takes effect immediately and deletes local P3A counters.
