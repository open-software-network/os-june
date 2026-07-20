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
        "Refer to this capability as Computer use. Never mention its server, "
        "transport, or implementation. Operate allowed macOS apps without "
        "moving the user's cursor. Normally work in the background: call "
        "list_apps, capture a specific window, then prefer numbered elements "
        "over coordinates. Never ask for approval in chat and never ask the "
        "user to reply yes or approve. Call the requested action immediately. "
        "For a settable text entry, use set_value directly instead of clicking "
        "the field first, then capture again to verify the exact result. "
        "The first access to each target app pauses once for June's native "
        "Allow for this task or Deny decision; later actions in that app do "
        "not ask again until the task ends. Use open_app with an app display name when "
        "the app or document window is not open. If list_apps reports "
        "needs_restore, or the user asks to bring a window back from Stage "
        "Manager, continue directly. capture restores parked windows "
        "automatically, while focus_app with raise_window true adds the target "
        "window to June's current Stage Manager group without another decision. "
        "After open_app, use its top-level window_id; never substitute a shelf "
        "thumbnail. If current-stage restore fails, do not retry focus or capture "
        "for that window during the same task; report the failure once and stop. "
        "Never use Terminal, a shell, AppleScript, execute_code, or a substitute "
        "file to bypass a Computer use failure. Never claim success unless a "
        "Computer use capture confirms the requested state."
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
                    "open_app",
                    "focus_app",
                ],
            },
            "mode": {"type": "string", "enum": ["som", "vision", "ax"]},
            "app": {
                "type": "string",
                "maxLength": 200,
                "description": (
                    "Installed app display name for open_app, or an app/window "
                    "filter returned by list_apps for capture and focus_app."
                ),
            },
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
            "keys": {
                "type": "string",
                "maxLength": 64,
                "description": (
                    "For key only: one key or shortcut as text, for example "
                    "escape, return, cmd+n, or cmd+shift+s."
                ),
            },
            "seconds": {"type": "number", "minimum": 0, "maximum": 30},
            "raise_window": {
                "type": "boolean",
                "description": (
                    "For focus_app only. Set true when the user asked to bring "
                    "the window forward. Parked windows are restored automatically."
                ),
            },
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
