#!/usr/bin/env python3
"""MCP server exposing June browser use status.

The June app writes this script into the managed Hermes home and registers it as
the built-in `june_browser` MCP server. This slice (JUN-286) exposes a single
read-only `status` tool that calls the June app's local provider proxy (loopback
only). The Rust browser broker answers with the Browser access grant state and
the active session count, or refuses when the grant is off. It performs NO real
browser actions; extension pairing, native messaging, and per-tab control are
JUN-287's.

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
TOKEN_ENV_VAR = "JUNE_BROWSER_PROXY_TOKEN"

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
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_browser_mcp.py <proxy_base_url>")

    base_url = sys.argv[1].rstrip("/")
    token = os.environ.get(TOKEN_ENV_VAR, "")
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
            result = proxy_json(base_url, token, "GET", "/browser/status")
            return tool_text_result(request_id, render_status_result(result))
    except ToolError as exc:
        return tool_text_result(request_id, str(exc), is_error=True)
    except Exception as exc:
        return tool_text_result(
            request_id,
            f"June browser request failed: {exc}",
            is_error=True,
        )

    return error_response(request_id, -32602, f"Unknown tool: {name}")


def proxy_json(
    base_url: str,
    token: str,
    method: str,
    path: str,
) -> dict[str, Any]:
    url = f"{base_url}{path}"
    headers = {"Authorization": f"Bearer {token}"}
    request = urllib.request.Request(url, headers=headers, method=method)
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
    raise ToolError(str(message))


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
