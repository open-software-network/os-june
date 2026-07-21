#!/usr/bin/env python3
"""MCP signal server for Home-to-focused-session task handoffs.

The server is intentionally stdlib-only and state-free. June's Home client
observes a successful tool call, creates the focused Hermes session, and starts
its first agent run. This process only validates and normalizes the request.
"""

from __future__ import annotations

import json
import sys
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-home", "version": "0.1.0"}
TOOLS: list[dict[str, Any]] = [
    {
        "name": "start_task",
        "description": (
            "Ask June Home to create and start one focused agent session for a "
            "concrete task that benefits from independent or background work. "
            "Call this only when the current prompt includes [June home context]."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["title", "prompt"],
            "properties": {
                "title": {
                    "type": "string",
                    "minLength": 1,
                    "description": "A concise, user-visible task title.",
                },
                "prompt": {
                    "type": "string",
                    "minLength": 1,
                    "description": "The complete prompt for the focused task.",
                },
                "summary": {
                    "type": "string",
                    "description": "Optional short Home handoff summary.",
                },
            },
            "additionalProperties": False,
        },
    }
]


def main() -> None:
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(message)
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
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def write_message(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def handle_message(message: dict[str, Any]) -> dict[str, Any] | None:
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
        params = message.get("params") or {}
        if params.get("name") != "start_task":
            return error_response(request_id, -32602, "Unknown tool")
        try:
            task = normalize_task(params.get("arguments"))
        except ValueError as exc:
            error = {"error": str(exc)}
            return response(
                request_id,
                {
                    "isError": True,
                    "content": [{"type": "text", "text": json.dumps(error)}],
                    "structuredContent": error,
                },
            )
        return response(
            request_id,
            {
                "content": [
                    {"type": "text", "text": json.dumps(task, ensure_ascii=False)}
                ],
                "structuredContent": task,
            },
        )
    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def normalize_task(arguments: Any) -> dict[str, str | None]:
    if not isinstance(arguments, dict):
        raise ValueError("start_task requires an arguments object")
    if set(arguments) - {"title", "prompt", "summary"}:
        raise ValueError("start_task accepts only title, prompt, and summary")

    normalized: dict[str, str | None] = {}
    for field in ("title", "prompt"):
        value = arguments.get(field)
        if not isinstance(value, str) or not (value := value.strip()):
            raise ValueError(f"start_task requires a non-empty {field}")
        normalized[field] = value

    summary = arguments.get("summary")
    if summary is not None and not isinstance(summary, str):
        raise ValueError("start_task summary must be a string")
    normalized["summary"] = summary.strip() if isinstance(summary, str) and summary.strip() else None
    return normalized


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()
