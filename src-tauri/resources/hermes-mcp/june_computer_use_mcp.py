#!/usr/bin/env python3
"""June-owned Computer use MCP transport.

This process never launches cua-driver. It forwards the pinned Computer use
contract to June's authenticated Rust broker, where grants, app isolation,
sensitive-field policy, approvals, driver lifecycle, and stop/revoke are
enforced before the separately bundled driver can run.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


TOOL_SCHEMA = {
    "name": "computer_use",
    "description": (
        "Operate an allowed macOS app in the background without moving the "
        "user's cursor, taking keyboard focus, or switching Spaces. Capture "
        "first, then prefer numbered elements over coordinates. June asks "
        "the user to approve every action that can change app state."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "capture",
                    "click",
                    "double_click",
                    "right_click",
                    "drag",
                    "scroll",
                    "type",
                    "key",
                    "set_value",
                    "wait",
                    "list_apps",
                    "focus_app",
                ],
            },
            "mode": {"type": "string", "enum": ["som", "vision", "ax"]},
            "app": {"type": "string", "maxLength": 200},
            "window_id": {
                "type": "integer",
                "minimum": 0,
                "description": (
                    "Exact window id returned by list_apps. Use it when an app has "
                    "multiple windows or names overlap."
                ),
            },
            "max_elements": {"type": "integer", "minimum": 1, "maximum": 1000},
            "element": {
                "type": "integer",
                "minimum": 0,
                "maximum": 4294967295,
                "description": (
                    "Numbered element from the latest capture. Required for type, "
                    "set_value, scroll, and an unmodified single key; preferred for clicks."
                ),
            },
            "coordinate": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0, "maximum": 100000},
                "minItems": 2,
                "maxItems": 2,
                "description": "Window-local screenshot coordinate for click actions only.",
            },
            "button": {"type": "string", "enum": ["left", "right"]},
            "modifiers": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["cmd", "shift", "option", "alt", "ctrl", "fn"],
                },
                "maxItems": 5,
            },
            "from_coordinate": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0, "maximum": 100000},
                "minItems": 2,
                "maxItems": 2,
                "description": "Required window-local start coordinate for drag.",
            },
            "to_coordinate": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0, "maximum": 100000},
                "minItems": 2,
                "maxItems": 2,
                "description": "Required window-local end coordinate for drag.",
            },
            "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
            "amount": {"type": "integer", "minimum": 1, "maximum": 50},
            "value": {"type": "string", "maxLength": 10000},
            "text": {"type": "string", "maxLength": 10000},
            "keys": {"type": "string", "maxLength": 64},
            "seconds": {"type": "number", "minimum": 0, "maximum": 30},
            "raise_window": {"type": "boolean"},
            "capture_after": {"type": "boolean"},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def reply(request_id, *, result=None, error=None):
    payload = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def tool_error(message):
    return {
        "content": [{"type": "text", "text": json.dumps({"error": message})}],
        "isError": True,
    }


def call_broker(arguments):
    url = os.environ.get("JUNE_COMPUTER_USE_PROXY_URL", "").strip()
    token = os.environ.get("JUNE_COMPUTER_USE_PROXY_TOKEN", "").strip()
    if not url or not token or token.startswith("${"):
        return tool_error("Computer use is disabled. Enable it in June Plugins and finish setup.")
    body = json.dumps(arguments, separators=(",", ":")).encode("utf-8")
    if len(body) > 64 * 1024:
        return tool_error("Computer use arguments are too large.")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=620) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return tool_error(f"June's Computer use broker rejected the request (HTTP {error.code}).")
    except Exception:
        return tool_error("June's Computer use broker is unavailable. Stop the task and try again.")


def handle(message):
    request_id = message.get("id")
    method = message.get("method")
    if request_id is None:
        return
    if method == "initialize":
        reply(
            request_id,
            result={
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "june_computer_use", "version": "1"},
            },
        )
        return
    if method == "ping":
        reply(request_id, result={})
        return
    if method == "tools/list":
        reply(request_id, result={"tools": [TOOL_SCHEMA]})
        return
    if method == "tools/call":
        params = message.get("params") or {}
        if params.get("name") != "computer_use":
            reply(request_id, result=tool_error("Unknown Computer use tool."))
            return
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            reply(request_id, result=tool_error("Computer use arguments must be an object."))
            return
        reply(request_id, result=call_broker(arguments))
        return
    reply(request_id, error={"code": -32601, "message": "Method not found"})


for line in sys.stdin:
    try:
        message = json.loads(line)
        if isinstance(message, dict):
            handle(message)
    except Exception:
        # Keep the transport alive after malformed input, but never echo the
        # offending line because it may contain text intended for another app.
        continue
