#!/usr/bin/env python3
"""Append agent diagnosis notes to an Open Software Issue/Bounty description.

This is the one mutation the read-only `os-platform` skill does not provide:
a `PATCH /v1/orgs/{org}/bounties/{number}` that edits `body_markdown`.

Design choices (learned the hard way):
- Sets `User-Agent: os-platform-agent-skill/1.0` + `Accept: application/json`.
  The default urllib UA is blocked by Cloudflare (HTTP 403, "error code: 1010").
- Idempotent: appends under a marker line and skips if the marker is already
  present (use --replace to regenerate that section).
- Append-only: never overwrites the reporter's original text. The notes are
  added below a `---` rule so the original report stays intact and attributed.

Usage:
  enrich_issue.py --org june --number 113 --notes-file notes.md
  echo "## ..." | enrich_issue.py --org june --number 113 --notes-file -
  enrich_issue.py --org june --number 113 --notes-file notes.md --replace
  enrich_issue.py --org june --number 113 --notes-file notes.md --dry-run

Auth: OS_PLATFORM_API_KEY env var (preferred) or --api-key. Never echo the key.
Base URL: OS_PLATFORM_API_BASE_URL env var, --base-url, or the default below.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://app.opensoftware.co/api"
DEFAULT_MARKER = "## Implementation notes (investigated by agent"
USER_AGENT = "os-platform-agent-skill/1.0"


def request(method: str, base_url: str, path: str, key: str, payload=None):
    url = f"{base_url}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USER_AGENT)  # Cloudflare blocks the default UA
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def unwrap(body):
    return body.get("data", body) if isinstance(body, dict) else body


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True)
    parser.add_argument("--number", required=True, type=int)
    parser.add_argument(
        "--notes-file",
        required=True,
        help="Path to a markdown file with the diagnosis notes, or '-' for stdin.",
    )
    parser.add_argument("--marker", default=DEFAULT_MARKER)
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--api-key", default=None)
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace an existing marker section instead of skipping.",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    key = args.api_key or os.environ.get("OS_PLATFORM_API_KEY")
    if not key:
        print("OS_PLATFORM_API_KEY not set (or pass --api-key)", file=sys.stderr)
        return 2
    base_url = (
        args.base_url or os.environ.get("OS_PLATFORM_API_BASE_URL") or DEFAULT_BASE_URL
    ).rstrip("/")

    notes = sys.stdin.read() if args.notes_file == "-" else open(args.notes_file).read()
    notes = notes.strip()
    if not notes:
        print("notes are empty", file=sys.stderr)
        return 2

    path = f"/v1/orgs/{args.org}/bounties/{args.number}"
    status, body = request("GET", base_url, path, key)
    if status != 200:
        print(f"JUN-{args.number}: GET failed {status}: {str(body)[:300]}")
        return 1
    current = unwrap(body).get("body_markdown") or ""

    if args.marker in current:
        if not args.replace:
            print(f"JUN-{args.number}: marker present, skip (use --replace to update)")
            return 0
        # Drop everything from the marker's containing block onward, then re-append.
        head = current.split(args.marker)[0].rstrip()
        # also strip a trailing '---' rule that preceded the old section
        if head.endswith("---"):
            head = head[: -3].rstrip()
        current = head

    new_body = current.rstrip() + "\n\n" + notes

    if args.dry_run:
        print(f"JUN-{args.number}: dry-run; body {len(current)} -> {len(new_body)} chars")
        return 0

    pstatus, presp = request(
        "PATCH", base_url, path, key, {"body_markdown": new_body}
    )
    if pstatus not in (200, 201, 204):
        print(f"JUN-{args.number}: PATCH failed {pstatus}: {str(presp)[:300]}")
        return 1

    vstatus, vbody = request("GET", base_url, path, key)
    verified = vstatus == 200 and args.marker in (unwrap(vbody).get("body_markdown") or "")
    print(
        f"JUN-{args.number}: PATCH {pstatus}; "
        f"marker={'OK' if verified else 'MISSING'}; "
        f"body -> {len(new_body)} chars"
    )
    return 0 if verified else 1


if __name__ == "__main__":
    raise SystemExit(main())
