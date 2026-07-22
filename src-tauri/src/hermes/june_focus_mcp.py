#!/usr/bin/env python3
"""Standard-library MCP server for June Focus local controls."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-focus", "version": "0.1.0"}
TOKEN_ENV_VAR = "JUNE_FOCUS_PROXY_TOKEN"
REQUEST_TIMEOUT_SECONDS = 20

TOOLS: list[dict[str, Any]] = [
    {
        "name": "start_focus",
        "description": (
            "Start a local June Focus session only after the user explicitly asks to begin; "
            "discussing productivity is not permission to start. Use project_id when known. You may "
            "use project_name, but an ambiguous name returns choices and must never "
            "be guessed. A simple session defaults to 25 minutes. For intervals, "
            "provide interval_count, interval_minutes, and optional break_minutes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "intention": {"type": "string", "maxLength": 500},
                "project_id": {"type": "string", "maxLength": 128},
                "project_name": {"type": "string", "maxLength": 200},
                "minutes": {"type": "integer", "minimum": 1, "maximum": 720},
                "interval_count": {"type": "integer", "minimum": 1, "maximum": 12},
                "interval_minutes": {"type": "integer", "minimum": 1, "maximum": 720},
                "break_minutes": {"type": "integer", "minimum": 1, "maximum": 120},
                "long_break_minutes": {"type": "integer", "minimum": 1, "maximum": 120},
                "interval_plan": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 23,
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "enum": ["focus", "break"]},
                            "minutes": {"type": "integer", "minimum": 1, "maximum": 720},
                            "project_id": {"type": "string", "maxLength": 128},
                        },
                        "required": ["kind", "minutes"],
                        "additionalProperties": False,
                    },
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_focus_status",
        "description": "Return the active local Focus session and its exact saved timeline.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "pause_focus",
        "description": "Pause the active Focus session. Paused time is excluded from focused time.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "resume_focus",
        "description": "Resume the active paused session, or skip an active break and begin the next focus interval.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "start_focus_break",
        "description": "Start the break planned after the active focus interval. Does not invent an unplanned break.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "finish_focus",
        "description": "Finish the active Focus session and preserve its timeline in History.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "abandon_focus",
        "description": "Abandon the active Focus session while preserving recorded time in History.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_focus_projects",
        "description": "List local June Projects with stable ids for starting or reassigning Focus time.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        self_test()
        return
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_focus_mcp.py <proxy_base_url>")
    base_url = sys.argv[1].rstrip("/")
    token = os.environ.get(TOKEN_ENV_VAR, "")
    while True:
        message = read_message()
        if message is None:
            return
        result = handle_message(base_url, token, message)
        if result is not None:
            write_message(result)


def read_message() -> dict[str, Any] | None:
    while True:
        line = sys.stdin.buffer.readline()
        if line == b"":
            return None
        if line.strip():
            break
    if not line.lower().startswith(b"content-length:"):
        return json.loads(line.decode("utf-8"))
    length = int(line.decode("ascii").partition(":")[2].strip())
    while sys.stdin.buffer.readline() not in (b"\r\n", b"\n", b""):
        pass
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def write_message(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle_message(base_url: str, token: str, message: dict[str, Any]) -> dict[str, Any] | None:
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
    return None if request_id is None else error_response(request_id, -32601, f"Unknown method: {method}")


def call_tool(
    base_url: str,
    token: str,
    request_id: Any,
    params: dict[str, Any],
) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    routes: dict[str, tuple[str, str]] = {
        "get_focus_status": ("GET", "/focus/status"),
        "pause_focus": ("POST", "/focus/pause"),
        "resume_focus": ("POST", "/focus/resume"),
        "start_focus_break": ("POST", "/focus/break"),
        "finish_focus": ("POST", "/focus/finish"),
        "abandon_focus": ("POST", "/focus/abandon"),
        "list_focus_projects": ("GET", "/focus/projects"),
    }
    try:
        if name == "start_focus":
            if arguments.get("project_id") and arguments.get("project_name"):
                raise ToolError("Use project_id or project_name, not both.")
            payload = start_payload(arguments)
            result = proxy_json(base_url, token, "POST", "/focus/start", payload)
        elif name in routes:
            method, path = routes[name]
            result = proxy_json(base_url, token, method, path, {} if method == "POST" else None)
        else:
            return error_response(request_id, -32602, f"Unknown tool: {name}")
        return tool_result(request_id, result)
    except ToolError as exc:
        return tool_text(request_id, str(exc), True)
    except Exception as exc:
        return tool_text(request_id, f"June Focus request failed: {exc}", True)


def proxy_json(
    base_url: str,
    token: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None,
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{base_url}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response_value:
            return json.loads(response_value.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"message": body or str(exc.reason)}
        message = parsed.get("message") or parsed.get("error", {}).get("message") or str(exc.reason)
        details = parsed.get("details")
        if details:
            message = f"{message} Choices/details: {json.dumps(details, ensure_ascii=False)}"
        raise ToolError(message) from exc


def start_payload(arguments: dict[str, Any]) -> dict[str, Any]:
    interval_plan = arguments.get("interval_plan")
    if interval_plan and any(
        arguments.get(key) is not None
        for key in (
            "minutes",
            "interval_count",
            "interval_minutes",
            "break_minutes",
            "long_break_minutes",
        )
    ):
        raise ToolError("Use interval_plan or compact duration fields, not both.")
    return {
        "intention": arguments.get("intention"),
        "projectId": arguments.get("project_id"),
        "projectName": arguments.get("project_name"),
        "durationMinutes": arguments.get("minutes"),
        "intervalCount": arguments.get("interval_count"),
        "intervalDurationMinutes": arguments.get("interval_minutes"),
        "breakDurationMinutes": arguments.get("break_minutes"),
        "longBreakDurationMinutes": arguments.get("long_break_minutes"),
        "intervalPlan": [
            {
                "kind": item.get("kind"),
                "durationMinutes": item.get("minutes"),
                "projectId": item.get("project_id"),
            }
            for item in interval_plan
        ]
        if interval_plan
        else None,
    }


def tool_result(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    data = result.get("data") if result.get("success") is True else result
    return tool_text(request_id, json.dumps(data, ensure_ascii=False, indent=2), False)


def tool_text(request_id: Any, text: str, is_error: bool) -> dict[str, Any]:
    return response(request_id, {"content": [{"type": "text", "text": text}], "isError": is_error})


def response(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


class ToolError(RuntimeError):
    pass


def self_test() -> None:
    names = [tool["name"] for tool in TOOLS]
    assert len(names) == 8
    assert len(set(names)) == len(names)
    assert "get_focus_status" in names
    assert "list_focus_projects" in names
    start_tool = next(tool for tool in TOOLS if tool["name"] == "start_focus")
    assert "explicitly asks" in start_tool["description"]
    assert start_payload({"minutes": 40, "intention": "Write the release note"})[
        "durationMinutes"
    ] == 40
    assert start_payload(
        {
            "interval_plan": [
                {"kind": "focus", "minutes": 25, "project_id": "project-1"},
                {"kind": "break", "minutes": 5},
                {"kind": "focus", "minutes": 25, "project_id": "project-2"},
            ]
        }
    )["intervalPlan"][2]["projectId"] == "project-2"
    listed = handle_message("http://127.0.0.1:1/v1", "token", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert listed and len(listed["result"]["tools"]) == 8
    print("june_focus_mcp self-test passed")


if __name__ == "__main__":
    main()
