#!/usr/bin/env python3
"""MCP server for discovering the current June-selected Obsidian vault.

The script is intentionally a thin stdlib-only adapter. It never reads
obsidian.json or validates vault paths; the June Rust process owns state,
validation, and privacy-sensitive path disclosure.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-obsidian", "version": "0.1.0"}
REQUEST_TIMEOUT_SECONDS = 15
TOKEN_ENV_VAR = "JUNE_OBSIDIAN_PROXY_TOKEN"

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_obsidian_vault",
        "description": (
            "Discover the current Obsidian vault selected in June before doing "
            "Obsidian work. This is current discovery, not authorization. If "
            "connected and available, remain within the returned vault path. "
            "Re-query for each distinct task because the selection can change. "
            "If disconnected or unavailable, explain that and do not guess a path."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    }
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_obsidian_mcp.py <proxy_base_url>")
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
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def write_message(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def handle_message(base_url: str, token: str, message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        return response(request_id, {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO})
    if method == "notifications/initialized":
        return None
    if method == "ping":
        return response(request_id, {})
    if method == "tools/list":
        return response(request_id, {"tools": TOOLS})
    if method == "tools/call":
        if (message.get("params") or {}).get("name") != "get_obsidian_vault":
            return error_response(request_id, -32602, "Unknown tool")
        try:
            result = proxy_json(base_url, token)
        except Exception as exc:
            return response(request_id, {"isError": True, "content": [{"type": "text", "text": json.dumps({"error": str(exc)})}]})
        return response(request_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}], "structuredContent": result})
    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def proxy_json(base_url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{base_url}/obsidian/vault",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as value:
            return json.loads(value.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(body or str(exc.reason))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach the June Obsidian proxy: {exc.reason}")


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()
