#!/usr/bin/env python3
"""Read-only MCP server exposing June notes and dictation context.

The June app writes this script into the managed Hermes home and registers it
as the built-in `june_context` MCP server. It intentionally depends only on the
Python standard library so it can run inside the Hermes runtime venv without
extra packaging.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-context", "version": "0.1.0"}
MAX_LIMIT = 20
DEFAULT_LIMIT = 8
SNIPPET_CHARS = 900
# Keep this in sync with DICTATION_HISTORY_RETENTION_DAYS in db/repositories.rs.
DICTATION_HISTORY_RETENTION_DAYS = 7


TOOLS: list[dict[str, Any]] = [
    {
        "name": "search_meeting_notes",
        "description": (
            "Search June meeting notes and saved note transcripts. Use this "
            "when the user asks about prior meetings, calls, recordings, notes, "
            "or decisions captured by June."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search text. Leave empty to list recent notes.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIMIT,
                    "default": DEFAULT_LIMIT,
                },
            },
        },
    },
    {
        "name": "search_dictation_history",
        "description": (
            "Search June dictation history. Use this when the user asks about "
            "recent dictated text, pasted dictation, or hands-free writing."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search text. Leave empty to list recent dictations.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIMIT,
                    "default": DEFAULT_LIMIT,
                },
            },
        },
    },
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_context_mcp.py <notes.sqlite3>")

    db_path = Path(sys.argv[1]).expanduser()
    while True:
        message = read_message()
        if message is None:
            return
        response = handle_message(db_path, message)
        if response is not None:
            write_message(response)


def read_message() -> dict[str, Any] | None:
    headers: dict[str, str] = {}
    while True:
        line = sys.stdin.buffer.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii", "replace").partition(":")
        headers[name.lower()] = value.strip()

    length = int(headers.get("content-length", "0"))
    if length <= 0:
        return None
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def write_message(payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def handle_message(db_path: Path, message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        return response(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        )
    if method == "notifications/initialized":
        return None
    if method == "ping":
        return response(request_id, {})
    if method == "tools/list":
        return response(request_id, {"tools": TOOLS})
    if method == "tools/call":
        return call_tool(db_path, request_id, message.get("params") or {})

    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def call_tool(db_path: Path, request_id: Any, params: dict[str, Any]) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    try:
        if name == "search_meeting_notes":
            result = search_meeting_notes(db_path, arguments)
        elif name == "search_dictation_history":
            result = search_dictation_history(db_path, arguments)
        else:
            return error_response(request_id, -32602, f"Unknown tool: {name}")
    except Exception as exc:
        return response(
            request_id,
            {
                "isError": True,
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {"error": str(exc)}, ensure_ascii=False, indent=2
                        ),
                    }
                ],
            },
        )

    return response(
        request_id,
        {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(result, ensure_ascii=False, indent=2),
                }
            ],
            "structuredContent": result,
        },
    )


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def search_meeting_notes(db_path: Path, arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    limit = bounded_limit(arguments.get("limit"))

    if not db_path.exists():
        return {"query": query, "items": [], "message": "June notes database does not exist yet."}

    where = ""
    params: list[Any] = []
    if query:
        needle = f"%{query.lower()}%"
        where = """
        WHERE lower(coalesce(n.title, '')) LIKE ?
           OR lower(coalesce(n.generated_content, '')) LIKE ?
           OR lower(coalesce(n.edited_content, '')) LIKE ?
           OR EXISTS (
                SELECT 1
                FROM transcripts tx
                WHERE tx.note_id = n.id
                  AND lower(coalesce(tx.text, '')) LIKE ?
           )
        """
        params.extend([needle, needle, needle, needle])

    sql = f"""
        SELECT
            n.id,
            n.title,
            n.generated_content,
            n.edited_content,
            n.processing_status,
            n.created_at,
            n.updated_at,
            (
                SELECT group_concat(t.text, char(10))
                FROM transcripts t
                WHERE t.note_id = n.id
                  AND trim(coalesce(t.text, '')) != ''
            ) AS transcript_text
        FROM notes n
        {where}
        ORDER BY n.updated_at DESC, n.created_at DESC, n.rowid DESC
        LIMIT ?
    """
    params.append(limit)

    with connect_readonly(db_path) as conn:
        rows = conn.execute(sql, params).fetchall()

    items = []
    for row in rows:
        note_text = first_text(row["edited_content"], row["generated_content"])
        transcript_text = row["transcript_text"] or ""
        items.append(
            {
                "id": row["id"],
                "title": row["title"] or "Untitled note",
                "processingStatus": row["processing_status"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
                "noteSnippet": snippet(note_text, query),
                "transcriptSnippet": snippet(transcript_text, query),
            }
        )
    return {"query": query, "count": len(items), "items": items}


def search_dictation_history(db_path: Path, arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    limit = bounded_limit(arguments.get("limit"))

    if not db_path.exists():
        return {
            "query": query,
            "items": [],
            "message": "June notes database does not exist yet.",
        }

    # Honor the same 7-day retention window the app enforces when listing
    # dictation history (db/repositories.rs:list_dictation_history), so stale
    # rows that have not been pruned yet are never surfaced back to the agent.
    clauses = ["created_at >= ?"]
    params: list[Any] = [dictation_history_cutoff_timestamp()]
    if query:
        clauses.append("lower(coalesce(text, '')) LIKE ?")
        params.append(f"%{query.lower()}%")
    where = "WHERE " + " AND ".join(clauses)

    sql = f"""
        SELECT id, text, language, provider, created_at
        FROM dictation_history
        {where}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
    """
    params.append(limit)

    with connect_readonly(db_path) as conn:
        rows = conn.execute(sql, params).fetchall()

    items = [
        {
            "id": row["id"],
            "textSnippet": snippet(row["text"] or "", query),
            "language": row["language"],
            "provider": row["provider"],
            "createdAt": row["created_at"],
        }
        for row in rows
    ]
    return {"query": query, "count": len(items), "items": items}


def dictation_history_cutoff_timestamp() -> str:
    """Return the retention cutoff as an RFC3339 string.

    Mirrors ``dictation_history_cutoff_timestamp`` in db/repositories.rs:
    UTC, millisecond precision, ``Z`` suffix. Stored ``created_at`` values use
    the identical format, so a lexicographic ``created_at >= cutoff`` compare is
    correct.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=DICTATION_HISTORY_RETENTION_DAYS)
    return f"{cutoff.strftime('%Y-%m-%dT%H:%M:%S')}.{cutoff.microsecond // 1000:03d}Z"


def connect_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def bounded_limit(value: Any) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, limit))


def first_text(*values: str | None) -> str:
    for value in values:
        if value and value.strip():
            return value
    return ""


def snippet(text: str, query: str) -> str:
    normalized = " ".join(text.split())
    if not normalized:
        return ""
    start = 0
    if query:
        index = normalized.lower().find(query.lower())
        if index >= 0:
            start = max(0, index - 160)
    excerpt = normalized[start : start + SNIPPET_CHARS]
    if start > 0:
        excerpt = "..." + excerpt
    if start + SNIPPET_CHARS < len(normalized):
        excerpt += "..."
    return excerpt


if __name__ == "__main__":
    main()
