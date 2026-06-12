# os-platform API Map

Use this map when the command shape is unclear. All routes are prefixed by the configured API base URL. By default, the bundled helper uses `https://app.opensoftware.co/api`; `OS_PLATFORM_API_BASE_URL` and `--base-url` can override it.

## Authentication

- All skill API calls require `OS_PLATFORM_API_KEY`, sent as `Authorization: Bearer ...`.
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
| `issues take <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}`; if unassigned, `GET /v1/users/me` and `PATCH /v1/orgs/{org}/bounties/{number}` with `{"assignee_user_id":"usr_xxx"}`; then `POST /v1/orgs/{org}/bounties/{number}/status` with `{"status":"in_progress"}` |
| `submissions list <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/submissions` |
| `activity list <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/activity` |
| `comments list issue <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/comments` |
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
- `--assignee`
- `--creator`
- `--project`
- `--labels`
- `--q`

Examples:

```bash
python3 scripts/os_platform.py issues list open-software --status todo,in_progress --priority high,urgent
python3 scripts/os_platform.py issues list open-software --project os-forge --q "wallet"
python3 scripts/os_platform.py issues search open-software "wallet bug" --status todo --assignee none
python3 scripts/os_platform.py issues take open-software 123 --yes
python3 scripts/os_platform.py issues list open-software --labels good-first-issue --sort status_grouped
```

## Controlled Issue write

`issues take <org> <number>` is the only write command. It fetches the Issue first and refuses non-`todo` Issues. When the Issue has no assignee, it reads the authenticated API user through:

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
