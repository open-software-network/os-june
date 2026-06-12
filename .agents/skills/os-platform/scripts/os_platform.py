#!/usr/bin/env python3
"""Read-only os-platform production API helper for agents."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import textwrap
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from typing import Any


DEFAULT_TIMEOUT_SECONDS = 30
DEFAULT_LIMIT = 20
DEFAULT_BASE_URL = "https://app.opensoftware.co/api"
CONFIG_FILE_NAME = "os-platform.json"
API_KEY_ENV = "OS_PLATFORM_API_KEY"
BASE_URL_ENV = "OS_PLATFORM_API_BASE_URL"
WORD_RE = re.compile(r"[a-z0-9]+")

COMPACT_KEYS = {
    "id",
    "public_id",
    "external_id",
    "number",
    "number_in_org",
    "number_in_bounty",
    "handle",
    "name",
    "display_name",
    "title",
    "status",
    "type",
    "priority",
    "visibility",
    "health",
    "role",
    "symbol",
    "amount",
    "reward",
    "reward_amount",
    "reward_amount_units",
    "asset_symbol",
    "project",
    "project_id",
    "project_handle",
    "org",
    "org_id",
    "org_handle",
    "assignee",
    "assignee_user",
    "assignee_user_id",
    "created_by",
    "creator",
    "author",
    "author_user",
    "author_user_id",
    "github_repo",
    "github_repo_id",
    "github_issue_number",
    "pr_url",
    "head_sha",
    "conclusion",
    "created_at",
    "updated_at",
    "submitted_at",
    "completed_at",
    "labels",
    "files",
    "submissions",
    "comments",
    "activity",
    "next_cursor",
    "page",
    "per_page",
    "total",
    "items",
    "data",
    "body_markdown",
    "body",
    "content_markdown",
    "message",
}

TEXT_KEYS = {"body_markdown", "body", "content_markdown", "message", "description"}


class OsPlatformError(RuntimeError):
    """User-facing script error."""


def die(message: str, code: int = 2) -> None:
    print(f"os_platform.py: {message}", file=sys.stderr)
    raise SystemExit(code)


def require_api_key(api_key: str | None) -> str:
    value = (api_key or os.environ.get(API_KEY_ENV) or "").strip()
    if not value:
        die(f"{API_KEY_ENV} is not set. Set it first to make os-platform work, or pass --api-key.")
    return value


def normalize_base_url(base_url: str | None) -> str:
    value = (base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL).strip()
    if not value.startswith(("http://", "https://")):
        die("base URL must start with http:// or https://")
    return value.rstrip("/")


def load_project_config(start_dir: pathlib.Path | str | None = None) -> dict[str, Any]:
    path = pathlib.Path(start_dir) if start_dir is not None else pathlib.Path.cwd()
    if path.is_file():
        path = path.parent

    for directory in (path, *path.parents):
        config_path = directory / CONFIG_FILE_NAME
        if not config_path.is_file():
            continue
        try:
            payload = json.loads(config_path.read_text())
        except json.JSONDecodeError as exc:
            die(f"{config_path} contains invalid JSON: {exc.msg}")
        if not isinstance(payload, dict):
            die(f"{config_path} must contain a JSON object")

        config: dict[str, Any] = {}
        org = payload.get("org")
        if isinstance(org, str) and org.strip():
            config["org"] = org.strip()
        limit = payload.get("limit")
        if isinstance(limit, int):
            config["limit"] = limit
        return config

    return {}


def apply_project_config(
    args: argparse.Namespace,
    config: Mapping[str, Any],
) -> None:
    configured_org = config.get("org")
    if isinstance(configured_org, str) and configured_org.strip():
        if not getattr(args, "org", None):
            args.org = configured_org.strip()

    configured_limit = config.get("limit")
    if getattr(args, "limit", None) is None:
        args.limit = configured_limit if isinstance(configured_limit, int) else DEFAULT_LIMIT

    refs = list(getattr(args, "refs", []) or [])
    if refs:
        apply_scoped_refs(
            args,
            refs,
            configured_org if isinstance(configured_org, str) else None,
        )


def apply_scoped_refs(
    args: argparse.Namespace,
    refs: Sequence[str],
    configured_org: str | None,
) -> None:
    if len(refs) > 2:
        die("too many positional values; pass either <org> <value> or configure org and pass <value>")

    if len(refs) == 2:
        args.org = refs[0]
        set_scoped_target(args, refs[1])
        return

    if len(refs) == 1:
        if configured_org:
            args.org = configured_org
            set_scoped_target(args, refs[0])
        else:
            args.org = refs[0]


def set_scoped_target(args: argparse.Namespace, value: str) -> None:
    if args.resource == "project":
        args.project = value
    elif args.resource in {"issues", "submissions", "activity"}:
        args.number = value
    elif args.resource == "comments":
        args.number = value
    elif args.resource == "contributors":
        args.user_handle = value


def require_arg(args: argparse.Namespace, name: str, description: str) -> str:
    value = getattr(args, name, None)
    if value is None or str(value).strip() == "":
        if name == "org":
            die(f"{description} is required; pass it on the command line or set org in {CONFIG_FILE_NAME}")
        die(f"{description} is required")
    return str(value)


def require_text(value: Any, description: str) -> str:
    if value is None or str(value).strip() == "":
        die(f"{description} is required")
    return str(value)


def build_url(base_url: str, path: str, query: Mapping[str, Any] | None = None) -> str:
    if not path.startswith("/"):
        path = "/" + path
    encoded_query: dict[str, str] = {}
    for key, value in (query or {}).items():
        if value is None:
            continue
        if isinstance(value, str) and value == "":
            continue
        encoded_query[key] = str(value)
    suffix = ""
    if encoded_query:
        suffix = "?" + urllib.parse.urlencode(encoded_query)
    return f"{base_url}{path}{suffix}"


def build_json_request(
    method: str,
    url: str,
    api_key: str,
    body: Mapping[str, Any] | None = None,
) -> urllib.request.Request:
    headers = {
        "Accept": "application/json",
        "User-Agent": "os-platform-agent-skill/1.0",
        "Authorization": f"Bearer {api_key}",
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    return urllib.request.Request(url, data=data, method=method.upper(), headers=headers)


def request_json(
    method: str,
    path: str,
    *,
    base_url: str,
    api_key: str,
    query: Mapping[str, Any] | None = None,
    body: Mapping[str, Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> Any:
    url = build_url(base_url, path, query)
    req = build_json_request(method, url, api_key, body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = raw[:800]
        raise OsPlatformError(
            json.dumps(
                {
                    "status": exc.code,
                    "reason": exc.reason,
                    "path": path,
                    "response": payload,
                },
                indent=2,
                sort_keys=True,
            )
        ) from exc
    except urllib.error.URLError as exc:
        raise OsPlatformError(f"request failed for {path}: {exc.reason}") from exc

    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise OsPlatformError(f"non-JSON response from {path}: {raw[:800]}") from exc


def unwrap_envelope(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload
    if {"success", "data"}.issubset(payload.keys()):
        if payload.get("success") is True:
            return payload.get("data")
        raise OsPlatformError(
            json.dumps(
                {
                    "error_code": payload.get("error_code"),
                    "message": payload.get("message"),
                    "data": payload.get("data"),
                },
                indent=2,
                sort_keys=True,
            )
        )
    return payload


def truncate_text(value: str, max_chars: int = 500) -> str:
    value = value.strip()
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 1].rstrip() + "..."


def compact_value(value: Any, *, limit: int, depth: int = 0) -> Any:
    if depth > 4:
        return summarize_leaf(value)
    if isinstance(value, list):
        return [compact_value(item, limit=limit, depth=depth + 1) for item in value[:limit]]
    if isinstance(value, dict):
        return compact_dict(value, limit=limit, depth=depth)
    return summarize_leaf(value)


def summarize_leaf(value: Any) -> Any:
    if isinstance(value, str):
        return truncate_text(value)
    return value


def compact_dict(value: Mapping[str, Any], *, limit: int, depth: int) -> dict[str, Any]:
    result: dict[str, Any] = {}

    for key in sorted(value.keys()):
        if key not in COMPACT_KEYS and key not in TEXT_KEYS:
            continue
        item = value[key]
        if item is None:
            continue
        if key in TEXT_KEYS and isinstance(item, str):
            result[key] = truncate_text(item)
        elif isinstance(item, (dict, list)):
            result[key] = compact_value(item, limit=limit, depth=depth + 1)
        else:
            result[key] = summarize_leaf(item)

    if result:
        return result

    for key in list(value.keys())[:12]:
        item = value[key]
        if isinstance(item, (dict, list)):
            continue
        result[key] = summarize_leaf(item)
    return result


def tokenize_search_text(value: Any) -> list[str]:
    return WORD_RE.findall(str(value).lower())


def issue_search_values(issue: Mapping[str, Any]) -> list[tuple[str, Any]]:
    values: list[tuple[str, Any]] = []
    fields = (
        "external_id",
        "number_in_org",
        "number",
        "title",
        "body_markdown",
        "body",
        "type",
        "priority",
        "status",
    )
    for field in fields:
        if issue.get(field) is not None:
            values.append((field, issue[field]))

    labels = issue.get("labels")
    if isinstance(labels, list):
        for label in labels:
            if isinstance(label, Mapping):
                values.extend(
                    ("label", label[key])
                    for key in ("slug", "name", "title")
                    if label.get(key)
                )
            elif label:
                values.append(("label", label))
    return values


def score_issue_for_query(issue: Mapping[str, Any], query: str) -> int:
    query_text = query.strip().lower()
    query_tokens = set(tokenize_search_text(query_text))
    if not query_tokens:
        return 0

    score = 0
    for field, raw_value in issue_search_values(issue):
        value_text = str(raw_value).lower()
        if field in {"external_id", "number_in_org", "number"}:
            if query_text == value_text.strip():
                score += 160
            continue

        value_tokens = set(tokenize_search_text(value_text))
        matched_tokens = query_tokens & value_tokens
        if not matched_tokens:
            continue
        weight = {
            "external_id": 40,
            "number_in_org": 40,
            "number": 40,
            "title": 12,
            "body_markdown": 5,
            "body": 5,
            "label": 4,
        }.get(field, 2)
        score += len(matched_tokens) * weight
        if query_text == value_text.strip():
            score += weight * 3
        elif query_text in value_text:
            score += weight
    return score


def rank_issue_search_results(issues: Sequence[Any], query: str) -> list[Any]:
    scored: list[tuple[int, int, Any]] = []
    for index, issue in enumerate(issues):
        if not isinstance(issue, Mapping):
            continue
        score = score_issue_for_query(issue, query)
        if score > 0:
            scored.append((score, index, issue))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [issue for _, _, issue in scored]


def output_data_for_args(data: Any, args: argparse.Namespace) -> Any:
    if getattr(args, "resource", None) != "issues" or getattr(args, "action", None) != "search":
        return data

    query = getattr(args, "search_query", "")
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        result = dict(data)
        result["items"] = rank_issue_search_results(data["items"], query)
        return result
    if isinstance(data, list):
        return rank_issue_search_results(data, query)
    return data


def confirm_take_issue(issue: Mapping[str, Any]) -> bool:
    label = issue.get("external_id") or issue.get("number_in_org") or "Issue"
    title = issue.get("title") or ""
    answer = input(f"Move {label} {title!r} from todo to in_progress? [y/N] ")
    return answer.strip().lower() in {"y", "yes"}


def take_issue(
    org: str,
    number: str,
    *,
    base_url: str,
    api_key: str,
    timeout: int,
    assume_yes: bool = False,
    request: Any = request_json,
    confirm: Any = confirm_take_issue,
) -> Any:
    get_method, get_path, get_query = issue_get_request(org, number)
    payload = request(
        get_method,
        get_path,
        base_url=base_url,
        api_key=api_key,
        query=get_query,
        timeout=timeout,
    )
    issue = unwrap_envelope(payload)
    if not isinstance(issue, Mapping):
        raise OsPlatformError("issue response did not contain an object")
    if issue.get("status") != "todo":
        result = dict(issue)
        result["take_result"] = "not_todo"
        return result
    if not assume_yes and not confirm(issue):
        return {
            "take_result": "cancelled",
            "external_id": issue.get("external_id"),
            "status": issue.get("status"),
        }

    if not issue_has_assignee(issue):
        assign_issue_to_current_user(
            org,
            number,
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            request=request,
        )

    post_method, post_path, post_query, body = issue_status_request(org, number, "in_progress")
    updated_payload = request(
        post_method,
        post_path,
        base_url=base_url,
        api_key=api_key,
        query=post_query,
        timeout=timeout,
        body=body,
    )
    return unwrap_envelope(updated_payload)


def print_payload(data: Any, args: argparse.Namespace) -> None:
    data = output_data_for_args(data, args)
    if args.full or args.json:
        output = data
    else:
        output = compact_value(data, limit=args.limit)
    print(json.dumps(output, indent=2, sort_keys=True, ensure_ascii=False))


def add_common_flags(parser: argparse.ArgumentParser, *, suppress_defaults: bool = False) -> None:
    default = argparse.SUPPRESS if suppress_defaults else None
    timeout_default = argparse.SUPPRESS if suppress_defaults else DEFAULT_TIMEOUT_SECONDS
    limit_default = argparse.SUPPRESS if suppress_defaults else None
    bool_default = argparse.SUPPRESS if suppress_defaults else False
    parser.add_argument(
        "--base-url",
        default=default,
        help=f"API base URL. Defaults to ${BASE_URL_ENV} or {DEFAULT_BASE_URL}.",
    )
    parser.add_argument("--api-key", default=default, help=f"API key. Prefer ${API_KEY_ENV}; this flag is not printed.")
    parser.add_argument("--timeout", type=int, default=timeout_default, help="HTTP timeout in seconds.")
    parser.add_argument("--limit", type=int, default=limit_default, help="Maximum list items in compact output.")
    parser.add_argument(
        "--json",
        action="store_true",
        default=bool_default,
        help="Print unwrapped API data without compact summarization.",
    )
    parser.add_argument("--full", action="store_true", default=bool_default, help="Print full unwrapped API data.")


def leaf_parser(subparsers: argparse._SubParsersAction, name: str, **kwargs: Any) -> argparse.ArgumentParser:
    parser = subparsers.add_parser(name, **kwargs)
    add_common_flags(parser, suppress_defaults=True)
    return parser


def add_issue_filters(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--project", help="CSV of project handles/public ids, or none.")
    parser.add_argument("--status", help="CSV statuses: todo,in_progress,in_review,completed,cancelled.")
    parser.add_argument("--type", help="CSV issue types: feature,bug,improvement,design,docs,refactor,other.")
    parser.add_argument("--priority", help="CSV priorities: none,low,med,high,urgent.")
    parser.add_argument("--assignee", help="CSV user refs or none.")
    parser.add_argument("--creator", help="CSV user refs.")
    parser.add_argument("--labels", help="CSV label slugs.")
    parser.add_argument("--q", help="Search issue title or external id.")
    parser.add_argument("--sort", help="created, created_asc, priority, reward, or status_grouped.")
    parser.add_argument("--cursor", help="Opaque pagination cursor.")
    parser.add_argument("--per-page", type=int, dest="per_page", help="Server page size.")


def query_from_args(args: argparse.Namespace, keys: Sequence[str]) -> dict[str, Any]:
    query: dict[str, Any] = {}
    for key in keys:
        value = getattr(args, key, None)
        if value is not None:
            query[key.replace("_", "-") if key == "per_page" else key] = value
    if "per-page" in query:
        query["per_page"] = query.pop("per-page")
    return query


def parse_query_pairs(pairs: Sequence[str]) -> dict[str, str]:
    query: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            die(f"raw query values must be key=value, got {pair!r}")
        key, value = pair.split("=", 1)
        if not key:
            die("raw query key cannot be empty")
        query[key] = value
    return query


def issue_get_request(org: str, number: str) -> tuple[str, str, dict[str, Any]]:
    org_ref = urllib.parse.quote(require_text(org, "org"))
    number_ref = urllib.parse.quote(require_text(number, "issue number"))
    return "GET", f"/v1/orgs/{org_ref}/bounties/{number_ref}", {}


def issue_status_request(org: str, number: str, status: str) -> tuple[str, str, dict[str, Any], dict[str, str]]:
    org_ref = urllib.parse.quote(require_text(org, "org"))
    number_ref = urllib.parse.quote(require_text(number, "issue number"))
    return "POST", f"/v1/orgs/{org_ref}/bounties/{number_ref}/status", {}, {"status": status}


def issue_update_request(
    org: str,
    number: str,
    body: Mapping[str, Any],
) -> tuple[str, str, dict[str, Any], dict[str, Any]]:
    org_ref = urllib.parse.quote(require_text(org, "org"))
    number_ref = urllib.parse.quote(require_text(number, "issue number"))
    return "PATCH", f"/v1/orgs/{org_ref}/bounties/{number_ref}", {}, dict(body)


def current_user_request() -> tuple[str, str, dict[str, Any]]:
    return "GET", "/v1/users/me", {}


def issue_has_assignee(issue: Mapping[str, Any]) -> bool:
    if issue.get("assignee_user_id"):
        return True
    assignee = issue.get("assignee")
    return assignee is not None


def current_user_public_id(
    *,
    base_url: str,
    api_key: str,
    timeout: int,
    request: Any = request_json,
) -> str:
    method, path, query = current_user_request()
    payload = request(
        method,
        path,
        base_url=base_url,
        api_key=api_key,
        query=query,
        timeout=timeout,
    )
    user = unwrap_envelope(payload)
    if not isinstance(user, Mapping):
        raise OsPlatformError("current user response did not contain an object")
    public_id = user.get("public_id")
    if not isinstance(public_id, str) or not public_id.strip():
        raise OsPlatformError("current user response did not contain public_id")
    return public_id


def assign_issue_to_current_user(
    org: str,
    number: str,
    *,
    base_url: str,
    api_key: str,
    timeout: int,
    request: Any = request_json,
) -> Any:
    user_id = current_user_public_id(
        base_url=base_url,
        api_key=api_key,
        timeout=timeout,
        request=request,
    )
    method, path, query, body = issue_update_request(org, number, {"assignee_user_id": user_id})
    payload = request(
        method,
        path,
        base_url=base_url,
        api_key=api_key,
        query=query,
        timeout=timeout,
        body=body,
    )
    return unwrap_envelope(payload)


def command_to_request(args: argparse.Namespace) -> tuple[str, str, dict[str, Any]]:
    if args.resource == "status":
        return "GET", "/v1/_status", {}

    if args.resource == "org":
        org = require_arg(args, "org", "org")
        return "GET", f"/v1/orgs/{urllib.parse.quote(org)}", {}

    if args.resource == "projects":
        org = require_arg(args, "org", "org")
        query = query_from_args(args, ["page", "per_page", "sort", "q"])
        return "GET", f"/v1/orgs/{urllib.parse.quote(org)}/projects", query

    if args.resource == "project":
        org = urllib.parse.quote(require_arg(args, "org", "org"))
        project = urllib.parse.quote(require_arg(args, "project", "project"))
        return "GET", f"/v1/orgs/{org}/projects/{project}", {}

    if args.resource == "issues":
        org = urllib.parse.quote(require_arg(args, "org", "org"))
        if args.action in {"list", "search"}:
            if args.action == "search" and not getattr(args, "search_query", "").strip():
                die("search query is required")
            query = query_from_args(
                args,
                [
                    "cursor",
                    "per_page",
                    "sort",
                    "status",
                    "type",
                    "priority",
                    "assignee",
                    "creator",
                    "project",
                    "labels",
                    "q",
                ],
            )
            return "GET", f"/v1/orgs/{org}/bounties", query
        number = require_arg(args, "number", "issue number")
        return issue_get_request(org, number)

    if args.resource == "submissions":
        org = urllib.parse.quote(require_arg(args, "org", "org"))
        number = urllib.parse.quote(require_arg(args, "number", "issue number"))
        return "GET", f"/v1/orgs/{org}/bounties/{number}/submissions", {}

    if args.resource == "activity":
        org = urllib.parse.quote(require_arg(args, "org", "org"))
        number = urllib.parse.quote(require_arg(args, "number", "issue number"))
        query = query_from_args(args, ["page", "per_page"])
        return "GET", f"/v1/orgs/{org}/bounties/{number}/activity", query

    if args.resource == "comments":
        org = urllib.parse.quote(require_arg(args, "org", "org"))
        number = urllib.parse.quote(require_arg(args, "number", "issue number"))
        query = query_from_args(args, ["page", "per_page"])
        return "GET", f"/v1/orgs/{org}/bounties/{number}/comments", query

    if args.resource == "contributors":
        org = urllib.parse.quote(require_arg(args, "org", "org"))
        if args.action == "list":
            return "GET", f"/v1/orgs/{org}/contributors", {}
        user = urllib.parse.quote(require_arg(args, "user_handle", "user handle"))
        return "GET", f"/v1/orgs/{org}/contributors/{user}", {}

    if args.resource == "raw":
        return args.method, args.path, parse_query_pairs(args.query or [])

    raise OsPlatformError(f"unsupported command: {args.resource}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="os_platform.py",
        description="Read-only helper for querying os-platform production API data.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """\
            Examples:
              python3 scripts/os_platform.py status
              python3 scripts/os_platform.py issues list open-software --q wallet --limit 10
              python3 scripts/os_platform.py issues show open-software 123 --full
              python3 scripts/os_platform.py raw GET /v1/_status
            """
        ),
    )
    add_common_flags(parser)
    subparsers = parser.add_subparsers(dest="resource", required=True)

    leaf_parser(subparsers, "status", help="Fetch GET /v1/_status.")

    org = subparsers.add_parser("org", help="Org reads.")
    org_sub = org.add_subparsers(dest="action", required=True)
    org_get = leaf_parser(org_sub, "get", help="Get an Org by handle or public id.")
    org_get.add_argument("org", nargs="?")

    projects = subparsers.add_parser("projects", help="Project collection reads.")
    projects_sub = projects.add_subparsers(dest="action", required=True)
    projects_list = leaf_parser(projects_sub, "list", help="List Projects for an Org.")
    projects_list.add_argument("org", nargs="?")
    projects_list.add_argument("--page", type=int)
    projects_list.add_argument("--per-page", type=int, dest="per_page")
    projects_list.add_argument("--sort")
    projects_list.add_argument("--q")

    project = subparsers.add_parser("project", help="Project detail reads.")
    project_sub = project.add_subparsers(dest="action", required=True)
    project_get = leaf_parser(project_sub, "get", help="Get one Project.")
    project_get.add_argument("refs", nargs="*", metavar="ref")

    issues = subparsers.add_parser("issues", help="Issue/Bounty reads.")
    issues_sub = issues.add_subparsers(dest="action", required=True)
    issues_list = leaf_parser(issues_sub, "list", help="List Issues for an Org.")
    issues_list.add_argument("org", nargs="?")
    add_issue_filters(issues_list)
    issues_search = leaf_parser(issues_sub, "search", help="Search Issues by local query relevance.")
    issues_search.add_argument("org", nargs="?")
    issues_search.add_argument("search_query")
    add_issue_filters(issues_search)
    issues_take = leaf_parser(issues_sub, "take", help="Move a todo Issue to in_progress after confirmation.")
    issues_take.add_argument("refs", nargs="*", metavar="ref")
    issues_take.add_argument("--yes", action="store_true", help="Skip confirmation prompt.")
    issues_show = leaf_parser(issues_sub, "show", help="Show one Issue by per-Org number.")
    issues_show.add_argument("refs", nargs="*", metavar="ref")

    submissions = subparsers.add_parser("submissions", help="Submission reads.")
    submissions_sub = submissions.add_subparsers(dest="action", required=True)
    submissions_list = leaf_parser(submissions_sub, "list", help="List Submissions for an Issue.")
    submissions_list.add_argument("refs", nargs="*", metavar="ref")

    activity = subparsers.add_parser("activity", help="Issue activity reads.")
    activity_sub = activity.add_subparsers(dest="action", required=True)
    activity_list = leaf_parser(activity_sub, "list", help="List activity for an Issue.")
    activity_list.add_argument("refs", nargs="*", metavar="ref")
    activity_list.add_argument("--page", type=int)
    activity_list.add_argument("--per-page", type=int, dest="per_page")

    comments = subparsers.add_parser("comments", help="Comment reads.")
    comments_sub = comments.add_subparsers(dest="action", required=True)
    comments_list = comments_sub.add_parser("list", help="List comments.")
    comments_list_sub = comments_list.add_subparsers(dest="target", required=True)
    issue_comments = leaf_parser(comments_list_sub, "issue", help="List comments for an Issue.")
    issue_comments.add_argument("refs", nargs="*", metavar="ref")
    issue_comments.add_argument("--page", type=int)
    issue_comments.add_argument("--per-page", type=int, dest="per_page")

    contributors = subparsers.add_parser("contributors", help="Contributor reads.")
    contributors_sub = contributors.add_subparsers(dest="action", required=True)
    contributors_list = leaf_parser(contributors_sub, "list", help="List Org contributors.")
    contributors_list.add_argument("org", nargs="?")
    contributors_show = leaf_parser(contributors_sub, "show", help="Show one Org contributor.")
    contributors_show.add_argument("refs", nargs="*", metavar="ref")

    raw = leaf_parser(subparsers, "raw", help="Raw read-only request escape hatch.")
    raw.add_argument("method", choices=["GET", "get"])
    raw.add_argument("path", help="API path such as /v1/_status.")
    raw.add_argument("--query", action="append", default=[], help="Query pair key=value. Repeatable.")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    apply_project_config(args, load_project_config())
    if args.limit < 1:
        die("--limit must be greater than zero")
    if args.timeout < 1:
        die("--timeout must be greater than zero")

    api_key = require_api_key(getattr(args, "api_key", None))
    base_url = normalize_base_url(args.base_url)
    try:
        if args.resource == "issues" and args.action == "take":
            data = take_issue(
                args.org,
                args.number,
                base_url=base_url,
                api_key=api_key,
                timeout=args.timeout,
                assume_yes=args.yes,
            )
            print_payload(data, args)
            return 0

        method, path, query = command_to_request(args)
        payload = request_json(
            method,
            path,
            base_url=base_url,
            api_key=api_key,
            query=query,
            timeout=args.timeout,
        )
        data = unwrap_envelope(payload)
        print_payload(data, args)
        return 0
    except OsPlatformError as exc:
        print(f"os_platform.py: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
