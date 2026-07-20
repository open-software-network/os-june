#!/usr/bin/env python3
"""MCP server exposing June notes, dictation context, and the June memory store.

The June app writes this script into the managed Hermes home and registers it
as the built-in `june_context` MCP server. Notes and dictation stay read-only;
memory writes go through the June app's loopback provider proxy. The server
intentionally depends only on the Python standard library so it can run inside
the Hermes runtime venv without extra packaging.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-context", "version": "0.3.0"}
MAX_LIMIT = 20
DEFAULT_LIMIT = 8
# Keep in sync with MEMORY_CONTENT_MAX_CHARS in commands.rs — the proxy
# enforces it; this only shapes the advertised tool schema.
MEMORY_CONTENT_MAX_CHARS = 4_000
SNIPPET_CHARS = 900
FULL_TEXT_CHARS = 60_000
SQLITE_BUSY_TIMEOUT_MS = 5_000
REQUEST_TIMEOUT_SECONDS = 30
TOKEN_ENV_VAR = "JUNE_MEMORY_PROXY_TOKEN"
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
    {
        "name": "save_memory",
        "description": (
            "Save a durable fact, preference, or decision in June's memory "
            "store. Pass the project id from the June project context when "
            "the memory belongs to that project; otherwise omit it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "maxLength": MEMORY_CONTENT_MAX_CHARS},
                "project_id": {"type": "string"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "list_memories",
        "description": (
            "Recall durable facts, preferences, and decisions from June's "
            "memory store. Pass the current project id to include that "
            "project's memories; global memories are included by default. "
            "Results are newest-first and paginated; use next_offset to "
            "request another page when has_more is true."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "include_global": {"type": "boolean", "default": True},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIMIT,
                    "default": DEFAULT_LIMIT,
                },
                "offset": {"type": "integer", "minimum": 0, "default": 0},
            },
        },
    },
    {
        "name": "forget_memory",
        "description": (
            "Permanently forget one memory by id. Use this when the user asks "
            "June to forget something previously saved."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 5:
        raise SystemExit(
            "Usage: june_context_mcp.py <notes.sqlite3> <memory-settings.json> "
            "<active-profile> <proxy_base_url>"
        )

    db_path = Path(sys.argv[1]).expanduser()
    settings_path = Path(sys.argv[2]).expanduser()
    active_profile_path = Path(sys.argv[3]).expanduser()
    base_url = sys.argv[4].rstrip("/")
    token = os.environ.get(TOKEN_ENV_VAR, "")
    while True:
        message = read_message()
        if message is None:
            return
        response = handle_message(
            db_path, settings_path, active_profile_path, base_url, token, message
        )
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


def handle_message(
    db_path: Path,
    settings_path: Path,
    active_profile_path: Path,
    base_url: str,
    token: str,
    message: dict[str, Any],
) -> dict[str, Any] | None:
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
        return call_tool(
            db_path,
            settings_path,
            active_profile_path,
            base_url,
            token,
            request_id,
            message.get("params") or {},
        )

    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def call_tool(
    db_path: Path,
    settings_path: Path,
    active_profile_path: Path,
    base_url: str,
    token: str,
    request_id: Any,
    params: dict[str, Any],
) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    profile = active_profile(active_profile_path)
    try:
        if name == "search_meeting_notes":
            result = search_meeting_notes(db_path, profile, arguments)
        elif name == "search_dictation_history":
            result = search_dictation_history(db_path, profile, arguments)
        elif name == "get_meeting_note":
            result = get_meeting_note(db_path, profile, arguments)
        elif name == "save_memory":
            result = proxy_json(base_url, token, "/memory/save", arguments)
        elif name == "list_memories":
            result = list_memories(db_path, settings_path, profile, arguments)
        elif name == "forget_memory":
            result = proxy_json(base_url, token, "/memory/forget", arguments)
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


def active_profile(path: Path) -> str:
    try:
        profile = path.read_text(encoding="utf-8").strip()
    except OSError:
        return "default"
    return profile or "default"


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def search_meeting_notes(
    db_path: Path, profile: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    limit = bounded_limit(arguments.get("limit"))

    if not db_path.exists():
        return {"query": query, "items": [], "message": "June notes database does not exist yet."}

    where = ""
    params: list[Any] = [profile]
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
            WHERE n.profile = ?
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


def get_meeting_note(
    db_path: Path, profile: str, arguments: dict[str, Any]
) -> dict[str, Any]:
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
        WHERE n.id = ? AND n.profile = ?
        LIMIT 1
    """

    turn_rows: list[sqlite3.Row] = []
    with connect_readonly(db_path) as conn:
        row = conn.execute(sql, [note_id, profile]).fetchone()
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


def search_dictation_history(
    db_path: Path, profile: str, arguments: dict[str, Any]
) -> dict[str, Any]:
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
    clauses = ["profile = ?", "created_at >= ?"]
    params: list[Any] = [profile, dictation_history_cutoff_timestamp()]
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


def list_memories(
    db_path: Path,
    settings_path: Path,
    profile: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    disabled = memory_disabled_result(settings_path)
    if disabled:
        return disabled

    project_id, project_error = memory_project_id(arguments)
    if project_error:
        return project_error
    include_global = arguments.get("include_global", True)
    if not isinstance(include_global, bool):
        return memory_error(
            "memory_include_global_invalid", "include_global must be a boolean."
        )
    limit = bounded_limit(arguments.get("limit"))
    offset = nonnegative_offset(arguments.get("offset"))
    if not db_path.exists():
        return memory_page([], limit, offset)

    with connect_readonly(db_path) as conn:
        conn.execute("BEGIN")
        if project_id is not None:
            scope_error = memory_scope_error(conn, profile, project_id)
            if scope_error:
                conn.rollback()
                return scope_error
        if project_id is None:
            rows = conn.execute(
                """SELECT id, folder_id, content, created_at
                   FROM memories
                   WHERE profile = ? AND folder_id IS NULL
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT ? OFFSET ?""",
                [profile, limit + 1, offset],
            ).fetchall()
        elif include_global:
            rows = conn.execute(
                """SELECT id, folder_id, content, created_at
                   FROM memories
                   WHERE profile = ? AND (folder_id = ? OR folder_id IS NULL)
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT ? OFFSET ?""",
                [profile, project_id, limit + 1, offset],
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, folder_id, content, created_at
                   FROM memories
                   WHERE profile = ? AND folder_id = ?
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT ? OFFSET ?""",
                [profile, project_id, limit + 1, offset],
            ).fetchall()
        conn.commit()

    return memory_page(rows, limit, offset)

def memory_page(
    rows: list[sqlite3.Row], limit: int, offset: int
) -> dict[str, Any]:
    page_rows = rows[:limit]
    items = [
        memory_item(row["id"], row["folder_id"], row["content"], row["created_at"])
        for row in page_rows
    ]
    has_more = len(rows) > limit
    return {
        "count": len(items),
        "items": items,
        "offset": offset,
        "has_more": has_more,
        "next_offset": offset + len(items) if has_more else None,
    }


def memory_project_id(
    arguments: dict[str, Any],
) -> tuple[str | None, dict[str, Any] | None]:
    project_id = arguments.get("project_id")
    if project_id is None:
        return None, None
    if not isinstance(project_id, str) or not project_id.strip():
        return None, memory_error(
            "folder_not_found", "Project was not found or has already been deleted."
        )
    return project_id.strip(), None


def memory_scope_error(
    conn: sqlite3.Connection, profile: str, project_id: str | None
) -> dict[str, Any] | None:
    if project_id is None:
        return None
    row = conn.execute(
        """SELECT memory_disabled FROM folders
           WHERE id = ? AND profile = ? AND deleted_at IS NULL""",
        [project_id, profile],
    ).fetchone()
    if row is None:
        return memory_error(
            "folder_not_found", "Project was not found or has already been deleted."
        )
    if row["memory_disabled"]:
        return memory_error("memory_disabled", "Memory is disabled for this scope.")
    return None


def memory_disabled_result(settings_path: Path) -> dict[str, Any] | None:
    if memory_enabled(settings_path):
        return None
    return memory_error("memory_disabled", "Memory is disabled for this scope.")


def memory_enabled(settings_path: Path) -> bool:
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return True
    except (OSError, ValueError):
        return False
    if not isinstance(settings, dict):
        return False
    enabled = settings.get("enabled", True)
    return enabled if isinstance(enabled, bool) else False


def memory_error(code: str, message: str) -> dict[str, Any]:
    return {"error": code, "message": message}


def memory_item(
    memory_id: str, project_id: str | None, content: str, created_at: str
) -> dict[str, Any]:
    return {
        "id": memory_id,
        "content": content,
        "created_at": created_at,
        "scope": "project" if project_id is not None else "global",
    }


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
    conn = sqlite3.connect(uri, uri=True, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
    return conn


def proxy_json(
    base_url: str,
    token: str,
    path: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=REQUEST_TIMEOUT_SECONDS
        ) as response_value:
            return json.loads(response_value.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {
                "ok": False,
                "error_code": "memory_proxy_failed",
                "message": body or str(exc.reason),
            }


def bounded_limit(value: Any) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, limit))


def nonnegative_offset(value: Any) -> int:
    try:
        offset = int(value)
    except (TypeError, ValueError):
        offset = 0
    return max(0, offset)


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
