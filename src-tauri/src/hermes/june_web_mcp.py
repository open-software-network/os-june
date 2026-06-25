#!/usr/bin/env python3
"""MCP server exposing June web search and fetch tools.

The June app writes this script into the managed Hermes home and registers it
as the built-in `june_web` MCP server. The tools call the June app's local
provider proxy (loopback only), which adds the user's access token and forwards
to the Scribe API's `/v1/web/search` and `/v1/web/fetch` endpoints. Those run on
Venice's privacy-preserving augment endpoints, so the agent never talks to a
third party directly and the access token never leaves the Rust process.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-web", "version": "0.1.0"}
MAX_LIMIT = 20
DEFAULT_LIMIT = 8
REQUEST_TIMEOUT_SECONDS = 25
TOKEN_ENV_VAR = "JUNE_WEB_PROXY_TOKEN"


TOOLS: list[dict[str, Any]] = [
    {
        "name": "web_search",
        "description": (
            "Search the web for current information. Use this when the user "
            "asks about recent events, facts you are unsure of, or anything "
            "that may have changed since your training. Returns titles, URLs, "
            "and snippets; follow up with web_fetch to read a result in full."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIMIT,
                    "default": DEFAULT_LIMIT,
                    "description": "How many results to return.",
                },
                "provider": {
                    "type": "string",
                    "enum": ["brave", "google"],
                    "description": "Search engine to use. Defaults to brave.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "web_fetch",
        "description": (
            "Fetch a single web page and return its content as markdown. Use "
            "this to read a specific URL, including ones surfaced by web_search. "
            "Some sites that block automated access cannot be fetched."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The http(s) URL to read.",
                },
            },
            "required": ["url"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_web_mcp.py <proxy_base_url>")

    base_url = sys.argv[1].rstrip("/")
    # The proxy token is passed via the environment rather than argv so it does
    # not show up in process listings.
    import os

    token = os.environ.get(TOKEN_ENV_VAR, "")
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(base_url, token, message)
        if response_message is not None:
            write_message(response_message)


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


def handle_message(
    base_url: str, token: str, message: dict[str, Any]
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
    base_url: str, token: str, request_id: Any, params: dict[str, Any]
) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    try:
        if name == "web_search":
            result = web_search(base_url, token, arguments)
        elif name == "web_fetch":
            result = web_fetch(base_url, token, arguments)
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


def web_search(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    payload: dict[str, Any] = {"query": query, "requestId": new_request_id()}
    limit = arguments.get("limit")
    if isinstance(limit, int):
        payload["limit"] = max(1, min(MAX_LIMIT, limit))
    provider = arguments.get("provider")
    if provider in ("brave", "google"):
        payload["provider"] = provider
    return call_proxy(base_url, token, "/web/search", payload)


def web_fetch(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    url = str(arguments.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")
    payload = {"url": url, "requestId": new_request_id()}
    return call_proxy(base_url, token, "/web/fetch", payload)


def call_proxy(
    base_url: str, token: str, path: str, payload: dict[str, Any]
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(f"{base_url}{path}", data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # The envelope still carries {success, message} on 4xx/5xx, so read it
        # for a usable error rather than a bare status code.
        body = exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach the June web proxy: {exc.reason}")

    try:
        envelope = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise RuntimeError("The June web proxy returned an unreadable response.")

    if envelope.get("success"):
        data_value = envelope.get("data")
        return data_value if isinstance(data_value, dict) else {}
    raise RuntimeError(str(envelope.get("message") or "Web request failed."))


def new_request_id() -> str:
    return uuid.uuid4().hex


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()
