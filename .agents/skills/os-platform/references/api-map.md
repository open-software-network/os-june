# os-platform API Map

Use this map when the command shape is unclear. All routes are prefixed by the configured API base URL. By default, the bundled helper uses `https://app.opensoftware.co/api`; `OS_PLATFORM_API_BASE_URL` and `--base-url` can override it.

## Authentication

- All skill API calls require `OS_PLATFORM_API_KEY`, sent as `Authorization: Bearer ...`.
- Requests use `os-platform-cli/2.0 (+https://opensoftware.co)` as the default User-Agent. `OS_PLATFORM_USER_AGENT` overrides it.
- A missing or malformed API key can produce `401`.
- A `404` can mean missing, private, or inaccessible.

## Real vs fixture data

Check runtime status first when accuracy matters:

```bash
python3 scripts/os_platform.py status
```

This calls:

```text
GET /v1/_status
```

Use `real_paths` and `fixture_paths` from that response to decide whether a result is production-backed or fixture-backed.

## Commands and endpoints

| Command | Endpoint |
| --- | --- |
| `status` | `GET /v1/_status` |
| `org get <org>` | `GET /v1/orgs/{org}` |
| `projects list <org>` | `GET /v1/orgs/{org}/projects` |
| `project get <org> <project>` | `GET /v1/orgs/{org}/projects/{project}` |
| `issues list <org>` | `GET /v1/orgs/{org}/bounties` |
| `issues search <org> "<query>"` | `GET /v1/orgs/{org}/bounties`, then local relevance ranking |
| `issues show <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}` |
| `issues create <org> --title <title> --body <body>` | `POST /v1/orgs/{org}/bounties` with `{"title":"...","body_markdown":"..."}` plus optional `type` and `priority`; optional `--idempotency-key` sends `Idempotency-Key` |
| `issues assign <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}`, then `GET /v1/users/me`; `PATCH /v1/orgs/{org}/bounties/{number}` with `{"assignee_user_id":"usr_xxx"}` only when unassigned or `--force` permits replacement |
| `issues status <org> <number> <status>` | `POST /v1/orgs/{org}/bounties/{number}/status` with `{"status":"..."}` |
| `issues take <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}`; if unassigned, `GET /v1/users/me` and `PATCH /v1/orgs/{org}/bounties/{number}` with `{"assignee_user_id":"usr_xxx"}`; then `POST /v1/orgs/{org}/bounties/{number}/status` with `{"status":"in_progress"}` |
| `submissions list <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/submissions` |
| `activity list <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/activity` |
| `comments list issue <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/comments` |
| `comments add <org> <number> --body <body>` | `POST /v1/orgs/{org}/bounties/{number}/comments` with `{"body_markdown":"..."}`; optional `--idempotency-key` sends `Idempotency-Key` |
| `contributors list <org>` | `GET /v1/orgs/{org}/contributors` |
| `contributors show <org> <user>` | `GET /v1/orgs/{org}/contributors/{user}` |
| `raw GET /v1/...` | Any read-only GET path |

## Issue list and search filters

`issues list <org>` and `issues search <org> "<query>"` support these query filters:

- `--cursor`
- `--per-page`
- `--sort`
- `--status`
- `--type`
- `--priority`
- `--assignee` (accepts `me`/`@me`, resolved to the authenticated user's public id via `GET /v1/users/me`; `none` means unassigned)
- `--creator` (also accepts `me`/`@me`)
- `--project`
- `--labels`
- `--q`

The `me`/`@me` sentinel is resolved locally before the request: the script calls `GET /v1/users/me` once when the token is present and substitutes the returned `public_id`. Any token in a CSV is resolved (e.g. `--assignee alice,me`).

Examples:

```bash
python3 scripts/os_platform.py issues list open-software --status todo,in_progress --priority high,urgent
python3 scripts/os_platform.py issues list open-software --assignee me --status todo,in_progress
python3 scripts/os_platform.py issues list open-software --project os-forge --q "wallet"
python3 scripts/os_platform.py issues search open-software "wallet bug" --status todo --assignee none
python3 scripts/os_platform.py issues create open-software --title "Fix wallet sync" --body "Issue details" --type bug --priority urgent --idempotency-key issue-wallet-sync
python3 scripts/os_platform.py issues assign open-software 123
python3 scripts/os_platform.py issues status open-software 123 in_review
python3 scripts/os_platform.py issues take open-software 123 --yes
python3 scripts/os_platform.py comments add open-software 123 --body "Opened PR #456." --idempotency-key issue-123-pr-comment
python3 scripts/os_platform.py issues list open-software --labels good-first-issue --sort status_grouped
```

## Controlled Issue writes

`issues create <org> --title <title> --body <body>` creates an Org-scoped Issue through:

```text
POST /v1/orgs/{org}/bounties
{"title":"...","body_markdown":"...","type":"bug","priority":"high"}
```

`type` and `priority` are omitted when their flags are not provided. Known type examples include `feature`, `bug`, `improvement`, `design`, `docs`, `refactor`, and `other`; known priority examples include `low`, `med`, `high`, and `urgent`. These are examples, not exhaustive enums: create passes the values through and the platform is the validation source of truth.

`issues assign <org> <number>` first reads the Issue through:

```text
GET /v1/orgs/{org}/bounties/{number}
```

It then reads the authenticated API user through:

```text
GET /v1/users/me
```

If the Issue is already assigned to that user, the command succeeds without a write. If another assignee owns it, the command refuses and names that assignee unless `--force` was passed. An unassigned Issue, or a deliberate forced replacement, assigns the authenticated user through:

```text
PATCH /v1/orgs/{org}/bounties/{number}
{"assignee_user_id":"usr_xxx"}
```

`issues status <org> <number> <status>` accepts `todo`, `in_progress`, `in_review`, `completed`, or `cancelled` and sends:

```text
POST /v1/orgs/{org}/bounties/{number}/status
{"status":"in_review"}
```

`comments add <org> <number> --body <body>` sends:

```text
POST /v1/orgs/{org}/bounties/{number}/comments
{"body_markdown":"..."}
```

`issues create` and `comments add` accept an optional `--idempotency-key <key>` and send it as an `Idempotency-Key` header. The script does not retry or generate keys. Re-running either command after an ambiguous failure can create a duplicate. Platform support for this header is unverified, so the key prevents duplication only if the platform honors it; read before retrying.

`issues take <org> <number>` remains the confirmed shortcut for starting todo work. It fetches the Issue first and refuses non-`todo` Issues. When the Issue has no assignee, it reads the authenticated API user through:

```text
GET /v1/users/me
```

Then it assigns the Issue to that user through:

```text
PATCH /v1/orgs/{org}/bounties/{number}
{"assignee_user_id":"usr_xxx"}
```

Finally, it moves the Issue to `in_progress` through:

```text
POST /v1/orgs/{org}/bounties/{number}/status
{"status":"in_progress"}
```

## Language

The API path still says `bounties`, but user-facing answers should say **Issues** unless the user asks about internals. If context is ambiguous, say “Issue/Bounty” once, then continue with “Issue.”
