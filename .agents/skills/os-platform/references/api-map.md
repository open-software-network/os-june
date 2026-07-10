# os-platform API Map

Use this map when the command shape is unclear. All routes are prefixed by the configured API base URL. By default, the bundled helper uses `https://app.opensoftware.co/api`; `OS_PLATFORM_API_BASE_URL` and `--base-url` can override it.

## Contract source

The single source of truth for every write method, path, request shape, and enum below is `open-software-network/os-platform/api/openapi.json`. The relevant OpenAPI operations are `create_org_bounty`, `update_bounty`, `set_bounty_status`, `create_bounty_comment`, `upload_file`, and the `pr-links` webhook operations. Live probes are only for current authentication and permission behavior, not for discovering or changing request shapes.

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
| `issues create <org> --title <title> --body <body>` | `POST /v1/orgs/{org}/bounties` with `{"title":"...","body_markdown":"..."}` plus optional `type` and `priority` |
| `issues assign <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}`, then `GET /v1/users/me`; `PATCH /v1/orgs/{org}/bounties/{number}` with `{"assignee_user_id":"usr_xxx"}` only when unassigned or `--force` permits replacement; then a verification GET |
| `issues status <org> <number> <status>` | `GET /v1/orgs/{org}/bounties/{number}`, `GET /v1/users/me`, then guarded `POST /v1/orgs/{org}/bounties/{number}/status` with `{"status":"..."}` |
| `issues attach <org> <number> --file-id <id>` | `GET /v1/orgs/{org}/bounties/{number}`, then `PATCH /v1/orgs/{org}/bounties/{number}` with the complete existing-plus-new `{"file_ids":[...]}` list |
| `issues take <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}`; if unassigned, `GET /v1/users/me` and `PATCH /v1/orgs/{org}/bounties/{number}` with `{"assignee_user_id":"usr_xxx"}`; then `POST /v1/orgs/{org}/bounties/{number}/status` with `{"status":"in_progress"}` |
| `files upload <path>` | Multipart `POST /v1/files` with `file`, `is_public`, and `purpose` fields |
| `submissions list <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/submissions` |
| `activity list <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/activity` |
| `comments list issue <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/comments` |
| `comments add <org> <number> --body <body>` | `POST /v1/orgs/{org}/bounties/{number}/comments` with `{"body_markdown":"..."}` |
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
python3 scripts/os_platform.py issues create open-software --title "Fix wallet sync" --body "Issue details" --type bug --priority urgent
python3 scripts/os_platform.py issues assign open-software 123
python3 scripts/os_platform.py issues status open-software 123 in_review
python3 scripts/os_platform.py issues take open-software 123 --yes
python3 scripts/os_platform.py files upload ./evidence.mp4 --public --purpose attachment
python3 scripts/os_platform.py issues attach open-software 123 --file-id fil_xxx
python3 scripts/os_platform.py comments add open-software 123 --body "Opened PR #456."
python3 scripts/os_platform.py issues list open-software --labels good-first-issue --sort status_grouped
```

## Controlled Issue writes

`issues create <org> --title <title> --body <body>` creates an Org-scoped Issue through:

```text
POST /v1/orgs/{org}/bounties
{"title":"...","body_markdown":"...","type":"bug","priority":"high"}
```

`type` and `priority` are omitted when their flags are not provided. The contract type enum is `feature`, `bug`, `improvement`, `design`, `docs`, `refactor`, `other`; the priority enum is `none`, `low`, `med`, `high`, `urgent`. Create keeps these flags as pass-through values without client-side choices, and the platform validates them.

`issues assign <org> <number>` first reads the Issue through:

```text
GET /v1/orgs/{org}/bounties/{number}
```

It then reads the authenticated API user through:

```text
GET /v1/users/me
```

`IssueDto.assignee_user_id` is the authoritative ownership field. A missing or empty value means unassigned, even when a sparse `assignee` display object is present. If the Issue is already assigned to the current user's `public_id`, the command succeeds without a write. If another assignee owns it, the command refuses and names that assignee unless `--force` was passed. An unassigned Issue, or a deliberate forced replacement, assigns the authenticated user through:

```text
PATCH /v1/orgs/{org}/bounties/{number}
{"assignee_user_id":"usr_xxx"}
```

After the PATCH, the command re-reads the Issue and fails loudly unless `assignee_user_id` is still the current user's id. This detects a read-then-write race between concurrent agents.

`issues status <org> <number> <status>` accepts the contract enum `proposed`, `todo`, `in_progress`, `in_review`, `completed`, or `cancelled`. It first reads the Issue, prints its external id, title, and current status to stderr, and resolves the current user through `GET /v1/users/me`. It refuses a foreign assignee unless `--force` is passed. Terminal transitions to `completed` or `cancelled` require `--yes`; otherwise it prints what would change and exits 1 without the POST. Allowed writes send:

```text
POST /v1/orgs/{org}/bounties/{number}/status
{"status":"in_review"}
```

`comments add <org> <number> --body <body>` sends:

```text
POST /v1/orgs/{org}/bounties/{number}/comments
{"body_markdown":"..."}
```

The contract has no idempotency header or key. The script does not retry writes. Re-running create or comment after an ambiguous failure can create a duplicate, so read before retrying.

`files upload <path> [--public] [--purpose attachment|avatar]` sends multipart form data through:

```text
POST /v1/files
file=@<path>
is_public=false
purpose=attachment
```

`purpose` is the contract enum `attachment` or `avatar` and defaults to `attachment`; uploads are private unless `--public` is passed. The response is a `FileDto`; persist its opaque `id`, not its download URL.

The contract has no attach endpoint. `issues attach <org> <number> --file-id <fil_xxx>` reads the Issue's ordered `files[].id` values, appends the new id, and sends the complete replacement list through:

```text
PATCH /v1/orgs/{org}/bounties/{number}
{"file_ids":["fil_existing","fil_xxx"]}
```

It never replaces existing attachments with a bare one-element list. `--path <path>` runs a private `attachment` upload first and uses the returned id.

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

## Pull request links

There is no submission or PR-link create command in the contract. The Org's GitHub integration receives `POST /v1/webhooks/pr-links/github` and creates links when a PR references the Issue id, for example `JUN-123` or `Closes JUN-123`. Per-Issue PR-link routes are read/delete only. If the integration does not create the link, record the PR URL with `comments add`.

## Language

The API path still says `bounties`, but user-facing answers should say **Issues** unless the user asks about internals. If context is ambiguous, say “Issue/Bounty” once, then continue with “Issue.”
