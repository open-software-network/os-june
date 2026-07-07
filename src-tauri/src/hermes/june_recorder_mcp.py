#!/usr/bin/env python3
"""MCP server exposing June local recording controls.

The June app writes this script into the managed Hermes home and registers it as
the built-in `june_recorder` MCP server. Its tools call the June app's local
provider proxy (loopback only), which emits a frontend event and waits for the
main June window to run the same visible recording flows the UI uses.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-recorder", "version": "0.1.0"}
REQUEST_TIMEOUT_SECONDS = 20
REQUEST_MAX_ATTEMPTS = 2
REQUEST_RETRY_DELAY_SECONDS = 0.25
TOKEN_ENV_VAR = "JUNE_RECORDER_PROXY_TOKEN"

TOOLS: list[dict[str, Any]] = [
    {
        "name": "start_recording",
        "description": (
            "Start a visible June recording only when the user explicitly asks "
            "you to start recording, record a meeting, or begin capture now. "
            "Never call this proactively. Use source_mode meeting for meeting "
            "mode with microphone and system audio, or microphone for "
            "microphone-only recording. Returns the new note id and title."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_mode": {
                    "type": "string",
                    "enum": ["microphone", "meeting"],
                    "description": "The recording source mode to start.",
                },
            },
            "required": ["source_mode"],
        },
    },
    {
        "name": "stop_recording",
        "description": (
            "Stop the active June recording when the user asks you to stop it. "
            "This starts note processing. Returns an error when no recording "
            "is running."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "recording_status",
        "description": (
            "Check whether June is currently recording. Returns none, or the "
            "active note id, elapsed milliseconds, and source mode."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_recorder_mcp.py <proxy_base_url>")

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
    arguments = params.get("arguments") or {}
    try:
        if name == "start_recording":
            source_mode = arguments.get("source_mode")
            if source_mode not in ("microphone", "meeting"):
                raise ToolError("source_mode must be microphone or meeting.")
            result = proxy_json(
                base_url,
                token,
                "POST",
                "/recorder/start",
                {"sourceMode": source_mode},
            )
            return tool_text_result(request_id, render_start_result(result))
        if name == "stop_recording":
            result = proxy_json(base_url, token, "POST", "/recorder/stop", {})
            return tool_text_result(request_id, render_stop_result(result))
        if name == "recording_status":
            result = proxy_json(base_url, token, "GET", "/recorder/status", None)
            return tool_text_result(request_id, render_status_result(result))
    except ToolError as exc:
        return tool_text_result(request_id, str(exc), is_error=True)
    except Exception as exc:
        return tool_text_result(
            request_id,
            f"June recorder request failed: {exc}",
            is_error=True,
        )

    return error_response(request_id, -32602, f"Unknown tool: {name}")


def proxy_json(
    base_url: str,
    token: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None,
) -> dict[str, Any]:
    url = f"{base_url}{path}"
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    last_error: Exception | None = None
    for attempt in range(REQUEST_MAX_ATTEMPTS):
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
            if exc.code < 500 or attempt == REQUEST_MAX_ATTEMPTS - 1:
                return parsed
            last_error = exc
        except urllib.error.URLError as exc:
            last_error = exc
        if attempt < REQUEST_MAX_ATTEMPTS - 1:
            time.sleep(REQUEST_RETRY_DELAY_SECONDS)
    raise ToolError(f"June recorder proxy is unavailable: {last_error}")


def render_start_result(result: dict[str, Any]) -> str:
    data = require_success(result)
    note_id = data.get("noteId") or "unknown"
    title = data.get("noteTitle") or "Untitled"
    return (
        f"Started recording: {title} ({note_id}). "
        "The recording is now visible in the recorder bar."
    )


def render_stop_result(result: dict[str, Any]) -> str:
    data = require_success(result)
    note_id = data.get("noteId") or "unknown"
    title = data.get("noteTitle") or "Untitled"
    return f"Stopped recording: {title} ({note_id}). Note processing has started."


def render_status_result(result: dict[str, Any]) -> str:
    data = require_success(result)
    if data.get("state") == "none":
        return "No recording is currently running."
    note_id = data.get("noteId") or "unknown"
    elapsed = data.get("elapsed") or 0
    source_mode = data.get("sourceMode") or "microphoneOnly"
    return (
        "Recording is running: "
        f"note {note_id}, elapsed {elapsed} ms, source mode {source_mode}."
    )


def require_success(result: dict[str, Any]) -> dict[str, Any]:
    if result.get("success") is True:
        data = result.get("data")
        return data if isinstance(data, dict) else {}
    message = result.get("message") or "June recorder request failed."
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
