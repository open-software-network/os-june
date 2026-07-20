#!/usr/bin/env python3
"""MCP server exposing June's Notion hosted MCP connector.

This is a thin stdio MCP shim. It never receives a Notion OAuth token. Tool
inventory and read-only tool calls go through June's loopback connector proxy,
which resolves Notion credentials from the OS keychain and talks to Notion's
hosted MCP service from Rust.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-notion", "version": "0.1.0"}
REQUEST_TIMEOUT_SECONDS = 60
TOKEN_ENV_VAR = "JUNE_CONNECTOR_PROXY_TOKEN"


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_notion_mcp.py <proxy_base_url>")

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
        try:
            inventory = call_proxy(base_url, token, "/notion/tools", {})
            return response(request_id, {"tools": inventory.get("tools", [])})
        except Exception as exc:
            return error_response(request_id, -32000, str(exc))
    if method == "tools/call":
        return call_tool(base_url, token, request_id, message.get("params") or {})

    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def call_tool(base_url: str, token: str, request_id: Any, params: dict[str, Any]) -> dict[str, Any]:
    name = str(params.get("name") or "").strip()
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        arguments = {}
    if not name:
        return error_response(request_id, -32602, "Tool name is required")
    try:
        result = call_proxy(
            base_url,
            token,
            "/notion/call",
            {"toolName": name, "arguments": arguments},
        )
    except ValueError as exc:
        return error_response(request_id, -32602, str(exc))
    except Exception as exc:
        return response(
            request_id,
            {
                "isError": True,
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2),
                    }
                ],
            },
        )

    hosted_result = result.get("result")
    if not isinstance(hosted_result, dict):
        return response(
            request_id,
            {
                "isError": True,
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {"error": "The June connector proxy returned a malformed Notion result."},
                            ensure_ascii=False,
                            indent=2,
                        ),
                    }
                ],
            },
        )
    return response(request_id, hosted_result)


def call_proxy(base_url: str, token: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(f"{base_url}{path}", data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach the June connector proxy: {exc.reason}")

    try:
        envelope = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise RuntimeError("The June connector proxy returned an unreadable response.")

    if envelope.get("success"):
        data_value = envelope.get("data")
        return data_value if isinstance(data_value, dict) else {"result": data_value}
    raise RuntimeError(str(envelope.get("message") or "Notion request failed."))


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()
