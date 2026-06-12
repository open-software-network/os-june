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
| `issues show <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}` |
| `submissions list <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/submissions` |
| `activity list <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/activity` |
| `comments list issue <org> <number>` | `GET /v1/orgs/{org}/bounties/{number}/comments` |
| `contributors list <org>` | `GET /v1/orgs/{org}/contributors` |
| `contributors show <org> <user>` | `GET /v1/orgs/{org}/contributors/{user}` |
| `raw GET /v1/...` | Any read-only GET path |

## Issue list filters

`issues list <org>` supports these query filters:

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
python3 scripts/os_platform.py issues list open-software --labels good-first-issue --sort status_grouped
```

## Language

The API path still says `bounties`, but user-facing answers should say **Issues** unless the user asks about internals. If context is ambiguous, say “Issue/Bounty” once, then continue with “Issue.”
