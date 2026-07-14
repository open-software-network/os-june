#!/usr/bin/env python3
"""MCP server exposing June's transport-agnostic Browser use contract.

The June app writes this script into the managed Hermes home and registers it as
the built-in `june_browser` MCP server. The Rust broker selects the transport,
owns policy and task-tab isolation, and re-checks the Browser access grant on
every request. The model cannot select a transport.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-browser", "version": "0.1.0"}
REQUEST_TIMEOUT_SECONDS = 30
ROUTINE_TOKEN_ENV_VAR = "JUNE_BROWSER_ROUTINE_PROXY_TOKEN"
ATTENDED_TOKEN_ENV_VAR = "JUNE_BROWSER_ATTENDED_PROXY_TOKEN"
CRON_CONTEXT_ENV_VAR = "JUNE_BROWSER_CRON_SESSION"
GATEWAY_CONTEXT_ENV_VAR = "JUNE_BROWSER_GATEWAY_SESSION"

TOOLS: list[dict[str, Any]] = [
    {
        "name": "status",
        "description": (
            "Report whether June browser use is enabled and how many browser "
            "sessions are active. Returns an error when browser use is not "
            "enabled or the June app is unavailable. Takes no arguments."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "start_session",
        "description": "Start a Browser use session.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    *[
        {
            "name": name,
            "description": description,
            "inputSchema": {
                "type": "object",
                "properties": {"session_id": {"type": "string"}},
                "required": ["session_id"],
            },
        }
        for name, description in [
            ("close_session", "Close a Browser use session and its task tabs."),
            ("list_tabs", "List task tabs owned by a Browser use session."),
            ("open_tab", "Open a new about:blank task tab."),
        ]
    ],
    *[
        {
            "name": name,
            "description": description,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string"},
                    "tab_id": {"type": "integer"},
                },
                "required": ["session_id", "tab_id"],
            },
        }
        for name, description in [
            ("snapshot", "Snapshot the accessibility tree of a task tab."),
            ("screenshot", "Capture the visible viewport of a task tab."),
            ("back", "Navigate a task tab back. Not implemented yet."),
            ("switch_tab", "Make an owned task tab active."),
            ("close_tab", "Close an owned task tab."),
        ]
    ],
    {
        "name": "navigate",
        "description": "Navigate an owned task tab to a URL.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "tab_id": {"type": "integer"},
                "url": {"type": "string"},
            },
            "required": ["session_id", "tab_id", "url"],
        },
    },
    {
        "name": "click",
        "description": "Click a current snapshot reference and return a fresh snapshot.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "tab_id": {"type": "integer"},
                "ref": {"type": "string"},
            },
            "required": ["session_id", "tab_id", "ref"],
        },
    },
    {
        "name": "press",
        "description": "Press a key on a current snapshot reference and return a fresh snapshot.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "tab_id": {"type": "integer"},
                "ref": {"type": "string"},
                "key": {"type": "string"},
            },
            "required": ["session_id", "tab_id", "ref", "key"],
        },
    },
    {
        "name": "fill",
        "description": "Fill a current snapshot reference and return a fresh snapshot.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "tab_id": {"type": "integer"},
                "ref": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["session_id", "tab_id", "ref", "text"],
        },
    },
    {
        "name": "accept_shared_tab",
        "description": "Accept a user-shared tab. Not implemented yet.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "share_id": {"type": "string"},
            },
            "required": ["session_id", "share_id"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_browser_mcp.py <proxy_base_url>")

    base_url = sys.argv[1].rstrip("/")
    token = browser_proxy_token()
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(base_url, token, message)
        if response_message is not None:
            write_message(response_message)


def read_message() -> dict[str, Any] | None:
    while True:
        first = sys.stdin.buffer.readline()
        if first == b"":
            return None
        if first.strip():
            break
    if not first.lower().startswith(b"content-length:"):
        return json.loads(first.strip().decode("utf-8"))

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
        return call_tool(base_url, token, request_id, message.get("params") or {})

    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def call_tool(
    base_url: str,
    token: str,
    request_id: Any,
    params: dict[str, Any],
) -> dict[str, Any]:
    name = params.get("name")
    try:
        if name == "status":
            result = proxy_json(base_url, token, "GET", "/browser/status", None)
            return tool_text_result(request_id, render_status_result(result))
        if any(tool["name"] == name for tool in TOOLS):
            arguments = params.get("arguments") or {}
            result = proxy_json(
                base_url,
                token,
                "POST",
                "/browser/execute",
                {
                    "callContext": browser_call_context(),
                    "tool": name,
                    "arguments": arguments,
                },
            )
            data = require_success(result)
            text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            media = data.get("media")
            if isinstance(media, str) and media.startswith("MEDIA:"):
                text = f"{text}\n{media}"
            return tool_text_result(request_id, text)
    except ToolError as exc:
        return tool_text_result(request_id, str(exc), is_error=True)
    except Exception as exc:
        return tool_text_result(
            request_id,
            f"June browser request failed: {exc}",
            is_error=True,
        )

    return error_response(request_id, -32602, f"Unknown tool: {name}")


def browser_call_context() -> str:
    """Describe the runtime path that owns this MCP subprocess.

    Hermes sets HERMES_CRON_SESSION for scheduled jobs and
    HERMES_GATEWAY_SESSION for interactive gateway sessions. June's rendered
    MCP config passes both values through the runtime's filtered subprocess
    environment. Cron wins if both are present, matching Hermes's own approval
    context precedence; anything else remains unknown so the Rust broker can
    fail closed.
    """
    if os.environ.get(CRON_CONTEXT_ENV_VAR) == "1":
        return "routine"
    if os.environ.get(GATEWAY_CONTEXT_ENV_VAR) == "1":
        return "attended"
    return "unknown"


def browser_proxy_token() -> str:
    """Select only the credential minted for this runtime context."""
    context = browser_call_context()
    if context == "routine":
        return os.environ.get(ROUTINE_TOKEN_ENV_VAR, "")
    if context == "attended":
        return os.environ.get(ATTENDED_TOKEN_ENV_VAR, "")
    return ""


def proxy_json(
    base_url: str,
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None,
) -> dict[str, Any]:
    url = f"{base_url}{path}"
    headers = {"Authorization": f"Bearer {token}"}
    encoded = None
    if body is not None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, headers=headers, data=encoded, method=method)
    try:
        with urllib.request.urlopen(
            request, timeout=REQUEST_TIMEOUT_SECONDS
        ) as response_value:
            return json.loads(response_value.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"success": False, "message": body or exc.reason}
        return parsed
    except urllib.error.URLError as exc:
        raise ToolError(f"June browser proxy is unavailable: {exc}")


def render_status_result(result: dict[str, Any]) -> str:
    data = require_success(result)
    if not data.get("enabled"):
        return "Browser use is not enabled."
    active = data.get("activeSessions") or 0
    return f"Browser use is enabled with {active} active session(s)."


def require_success(result: dict[str, Any]) -> dict[str, Any]:
    if result.get("success") is True:
        data = result.get("data")
        return data if isinstance(data, dict) else {}
    message = result.get("message") or "June browser request failed."
    code = result.get("errorCode") or "browser_request_failed"
    raise ToolError(f"[{code}] {message}")


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def tool_text_result(
    request_id: Any,
    text: str,
    is_error: bool = False,
) -> dict[str, Any]:
    return response(
        request_id,
        {"content": [{"type": "text", "text": text}], "isError": is_error},
    )


class ToolError(Exception):
    pass


if __name__ == "__main__":
    main()
