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
SERVER_INFO = {"name": "june-context", "version": "0.2.0"}
MAX_LIMIT = 20
DEFAULT_LIMIT = 8
SNIPPET_CHARS = 900
FULL_TEXT_CHARS = 60_000
# Keep this in sync with DICTATION_HISTORY_RETENTION_DAYS in db/repositories.rs.
DICTATION_HISTORY_RETENTION_DAYS = 7

# The app's note editor (NoteEditor.tsx) shows the note body as
# editedContent ?? generatedContent ?? "". Mirror that exactly: edited_content
# wins when it is not NULL, even when it is an empty string; only NULL falls
# back to generated_content.
APP_VISIBLE_NOTE_BODY_SQL = (
    "CASE WHEN n.edited_content IS NOT NULL THEN n.edited_content "
    "ELSE coalesce(n.generated_content, '') END"
)

# Turn text queries share this filter/order. The fragments expect transcript
# rows aliased as `t` and recording sessions aliased as `rs`.
TURN_TEXT_FILTER_SQL = """
              AND t.recording_session_id IS NOT NULL
              AND t.turn_index IS NOT NULL
              AND trim(coalesce(t.text, '')) != ''
"""

TURN_TEXT_ORDER_SQL = """
            ORDER BY COALESCE(rs.started_at, t.created_at) ASC,
                     COALESCE(rs.rowid, 9223372036854775807) ASC,
                     COALESCE(t.turn_index, 999999),
                     COALESCE(t.start_ms, 999999999),
                     t.created_at ASC,
                     t.rowid ASC
"""

# The app's transcript view (transcriptToText in NoteEditor.tsx) shows turn
# rows when any visible turn exists and otherwise falls back to the latest
# whole-file transcript - never a mix. `turns_text` stays unlabeled for search;
# `get_meeting_note` formats labeled turn blocks from a second row query.
TRANSCRIPT_TEXT_SUBQUERIES = f"""
    (
        SELECT group_concat(text, char(10)) FROM (
            SELECT t.text
            FROM transcripts t
            LEFT JOIN recording_sessions rs ON rs.id = t.recording_session_id
            WHERE t.note_id = n.id
{TURN_TEXT_FILTER_SQL}
{TURN_TEXT_ORDER_SQL}
        )
    ) AS turns_text,
    (
        SELECT COUNT(*)
        FROM transcripts t
        WHERE t.note_id = n.id
          AND t.recording_session_id IS NOT NULL
          AND t.turn_index IS NOT NULL
          AND (
                trim(coalesce(t.text, '')) != ''
                OR trim(coalesce(t.last_error, '')) != ''
          )
    ) AS visible_turn_rows,
    (
        SELECT t.text
        FROM transcripts t
        WHERE t.note_id = n.id
        ORDER BY t.created_at DESC
        LIMIT 1
    ) AS latest_text
"""

LABELED_TURN_TEXT_SQL = f"""
    SELECT t.source, t.start_ms, t.end_ms, t.text
    FROM transcripts t
    LEFT JOIN recording_sessions rs ON rs.id = t.recording_session_id
    WHERE t.note_id = ?
{TURN_TEXT_FILTER_SQL}
{TURN_TEXT_ORDER_SQL}
"""


def transcript_text_from_row(row: sqlite3.Row) -> str:
    """The unlabeled transcript used by search.

    It still follows the app's turn-vs-whole-file branch decision so an older
    whole-file transcript cannot resurface behind visible turn rows.
    """
    if row["visible_turn_rows"]:
        return row["turns_text"] or ""
    return row["latest_text"] or ""


def labeled_transcript_from_turn_rows(rows: list[sqlite3.Row]) -> str:
    blocks = []
    for row in rows:
        text = row["text"] or ""
        if not text.strip():
            continue
        label = "System" if row["source"] == "system" else "Microphone"
        turn_time = format_turn_time(row["start_ms"], row["end_ms"])
        meta = f"{label} {turn_time}" if turn_time else label
        blocks.append(f"{meta}\n{text}")
    return "\n\n".join(blocks)


def format_turn_time(start_ms: Any, end_ms: Any) -> str | None:
    if start_ms is None or end_ms is None or end_ms <= start_ms:
        return None

    def format_ms(value: Any) -> str:
        seconds = int(max(0, value) / 1000 + 0.5)
        return f"{seconds // 60}:{seconds % 60:02d}"

    return f"{format_ms(start_ms)}-{format_ms(end_ms)}"


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
    {
        "name": "get_meeting_note",
        "description": (
            "Fetch one June meeting note in full by its id. Use this when a "
            "message references a specific note (for example an `@note:<id>` "
            "reference) or when a search result's snippet is not enough. Set "
            "include_transcript only when the note content alone cannot answer."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "note_id": {
                    "type": "string",
                    "description": (
                        "The note id, e.g. from an @note:<id> reference or a "
                        "search_meeting_notes result."
                    ),
                },
                "include_transcript": {
                    "type": "boolean",
                    "default": False,
                },
            },
            "required": ["note_id"],
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
    while True:
        first = sys.stdin.buffer.readline()
        if first == b"":
            return None
        if first.strip():
            break
    if not first.lower().startswith(b"content-length:"):
        stripped = first.strip()
        return json.loads(stripped.decode("utf-8"))

    headers: dict[str, str] = {}
    name, _, value = first.decode("ascii", "replace").partition(":")
    headers[name.lower()] = value.strip()
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
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


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
        elif name == "get_meeting_note":
            result = get_meeting_note(db_path, arguments)
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
        WHERE lower(coalesce(title, '')) LIKE ?
           OR lower(coalesce(note_body, '')) LIKE ?
           OR lower(coalesce(
                CASE WHEN visible_turn_rows > 0 THEN turns_text ELSE latest_text END,
                ''
           )) LIKE ?
        """
        params.extend([needle, needle, needle])

    sql = f"""
        SELECT
            id,
            title,
            note_body,
            processing_status,
            created_at,
            updated_at,
            turns_text,
            visible_turn_rows,
            latest_text
        FROM (
            SELECT
                n.rowid AS note_rowid,
                n.id,
                n.title,
                {APP_VISIBLE_NOTE_BODY_SQL} AS note_body,
                n.processing_status,
                n.created_at,
                n.updated_at,
                {TRANSCRIPT_TEXT_SUBQUERIES}
            FROM notes n
        )
        {where}
        ORDER BY updated_at DESC, created_at DESC, note_rowid DESC
        LIMIT ?
    """
    params.append(limit)

    with connect_readonly(db_path) as conn:
        rows = conn.execute(sql, params).fetchall()

    items = []
    for row in rows:
        note_text = row["note_body"] or ""
        # Search intentionally keeps turn transcripts unlabeled: labels would
        # make queries like "system" match every dual-source note and spend
        # snippet budget on metadata instead of user text.
        transcript_text = transcript_text_from_row(row)
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


def get_meeting_note(db_path: Path, arguments: dict[str, Any]) -> dict[str, Any]:
    note_id = str(arguments.get("note_id") or "").strip()
    if not note_id:
        return {"noteId": note_id, "found": False, "message": "note_id is required."}

    if not db_path.exists():
        return {
            "noteId": note_id,
            "found": False,
            "message": "June notes database does not exist yet.",
        }

    sql = f"""
        SELECT
            n.id,
            n.title,
            {APP_VISIBLE_NOTE_BODY_SQL} AS note_body,
            n.processing_status,
            n.created_at,
            n.updated_at,
            {TRANSCRIPT_TEXT_SUBQUERIES}
        FROM notes n
        WHERE n.id = ?
        LIMIT 1
    """

    turn_rows: list[sqlite3.Row] = []
    with connect_readonly(db_path) as conn:
        row = conn.execute(sql, [note_id]).fetchone()
        if row is not None and row["visible_turn_rows"]:
            turn_rows = conn.execute(LABELED_TURN_TEXT_SQL, [note_id]).fetchall()

    if row is None:
        return {
            "noteId": note_id,
            "found": False,
            "message": "No note with this id.",
        }

    note_text = row["note_body"] or ""
    note_content, note_content_truncated = capped_text(note_text)
    if row["visible_turn_rows"]:
        transcript_text = labeled_transcript_from_turn_rows(turn_rows)
    else:
        transcript_text = row["latest_text"] or ""
    transcript, transcript_truncated = capped_text(transcript_text)

    result = {
        "noteId": row["id"],
        "found": True,
        "title": row["title"] or "Untitled note",
        "processingStatus": row["processing_status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "noteContent": note_content,
        "noteContentTruncated": note_content_truncated,
        "transcriptChars": len(transcript_text),
    }
    if arguments.get("include_transcript"):
        result["transcript"] = transcript
        result["transcriptTruncated"] = transcript_truncated
    return result


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


def capped_text(text: str) -> tuple[str, bool]:
    if len(text) <= FULL_TEXT_CHARS:
        return text, False
    return text[:FULL_TEXT_CHARS], True


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
