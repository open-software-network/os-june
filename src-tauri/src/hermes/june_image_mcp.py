#!/usr/bin/env python3
"""MCP server exposing June image generation (and editing) tools.

The June app writes this script into the managed Hermes home and registers it as
the built-in `june_image` MCP server. Its tools call the June app's local
provider proxy (loopback only), which adds the user's access token and forwards
to the June API's `/v1/image/generate` and `/v1/image/edit` endpoints. Those run
on Venice through June API's metered image service, so the agent never talks to a
third party directly, the access token never leaves the Rust process, and every
generation/edit is billed to the signed-in user automatically.

Generated and edited images are written to a dedicated images directory (passed
as the second argument) so the model can reference a prior image by a stable
filename when it wants to edit it — the model cannot pass image bytes as a tool
argument, only name a file this server produced.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-image", "version": "0.1.0"}
REQUEST_TIMEOUT_SECONDS = 120
TOKEN_ENV_VAR = "JUNE_IMAGE_PROXY_TOKEN"

# Venice always returns png for generation; edits echo the requested output
# format. Map the response mime to a file extension for the on-disk name.
EXTENSION_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}


TOOLS: list[dict[str, Any]] = [
    {
        "name": "generate_image",
        "description": (
            "Generate an image from a text description and show it to the user "
            "in the conversation. Use this when the user asks you to draw, "
            "create, make, or generate an image, picture, illustration, logo, "
            "or similar. Returns the image inline plus a `filename`; pass that "
            "same filename to `edit_image` if the user then asks to change it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "A detailed description of the image to generate.",
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "edit_image",
        "description": (
            "Edit an existing image (image-to-image) and show the result in the "
            "conversation. Use this whenever the user asks to change, modify, "
            "adjust, refine, or reframe an image you generated or edited "
            "earlier — including reframing like wider, zoom out, bigger "
            "perspective, or closer, plus recoloring, restyling, and adding or "
            "removing elements. This transforms the image file directly: you do "
            "NOT need to see, analyze, or describe the image to edit it. "
            "`source_filename` MUST be a filename a previous generate_image or "
            "edit_image call returned. Returns the edited image inline plus a "
            "new `filename` you can edit again."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_filename": {
                    "type": "string",
                    "description": (
                        "The filename of the image to edit, exactly as returned "
                        "by a prior generate_image or edit_image call."
                    ),
                },
                "instruction": {
                    "type": "string",
                    "description": "What to change about the image.",
                },
            },
            "required": ["source_filename", "instruction"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("Usage: june_image_mcp.py <proxy_base_url> <images_dir>")

    base_url = sys.argv[1].rstrip("/")
    images_dir = sys.argv[2]
    # The proxy token is passed via the environment rather than argv so it does
    # not show up in process listings.
    token = os.environ.get(TOKEN_ENV_VAR, "")
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(base_url, images_dir, token, message)
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
        stripped = first.strip()
        return json.loads(stripped.decode("utf-8"))

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
    base_url: str, images_dir: str, token: str, message: dict[str, Any]
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
        return call_tool(
            base_url, images_dir, token, request_id, message.get("params") or {}
        )

    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def call_tool(
    base_url: str,
    images_dir: str,
    token: str,
    request_id: Any,
    params: dict[str, Any],
) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    try:
        if name == "generate_image":
            result = generate_image(base_url, images_dir, token, arguments)
        elif name == "edit_image":
            result = edit_image(base_url, images_dir, token, arguments)
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

    # The model needs to SEE the image (vision) and know its stable filename to
    # edit it later, so return both an image content block and a text block
    # carrying the filename; structuredContent mirrors the metadata. `label` is
    # the human description the app shows as the image's caption/alt text.
    structured = {
        "filename": result["filename"],
        "model": result.get("model"),
        "mimeType": result["mime_type"],
        "label": result.get("label", ""),
    }
    return response(
        request_id,
        {
            "content": [
                {
                    "type": "image",
                    "data": result["image_base64"],
                    "mimeType": result["mime_type"],
                },
                {
                    "type": "text",
                    "text": json.dumps(structured, ensure_ascii=False, indent=2),
                },
            ],
            "structuredContent": structured,
        },
    )


def generate_image(
    base_url: str, images_dir: str, token: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    prompt = str(arguments.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    # No model is sent: the loopback proxy injects the user's selected image
    # generation model so the tool honors their setting.
    envelope = call_proxy(base_url, token, "/image/generate", {"prompt": prompt})
    image_base64 = str(envelope.get("imageBase64") or "")
    mime_type = str(envelope.get("mimeType") or "image/png")
    if not image_base64:
        raise RuntimeError("June returned an empty image.")
    filename = write_image(images_dir, image_base64, mime_type)
    return {
        "image_base64": image_base64,
        "mime_type": mime_type,
        "model": envelope.get("model"),
        "filename": filename,
        "label": prompt,
    }


def edit_image(
    base_url: str, images_dir: str, token: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    source_filename = str(arguments.get("source_filename") or "").strip()
    instruction = str(arguments.get("instruction") or "").strip()
    if not source_filename:
        raise ValueError("source_filename is required")
    if not instruction:
        raise ValueError("instruction is required")
    source_base64, source_mime = read_image(images_dir, source_filename)
    envelope = call_proxy(
        base_url,
        token,
        "/image/edit",
        {
            "image": source_base64,
            "prompt": instruction,
            "mimeType": source_mime,
        },
    )
    image_base64 = str(envelope.get("imageBase64") or "")
    mime_type = str(envelope.get("mimeType") or source_mime or "image/png")
    if not image_base64:
        raise RuntimeError("June returned an empty edited image.")
    filename = write_image(images_dir, image_base64, mime_type)
    return {
        "image_base64": image_base64,
        "mime_type": mime_type,
        "model": envelope.get("model"),
        "filename": filename,
        "label": instruction,
    }


def write_image(images_dir: str, image_base64: str, mime_type: str) -> str:
    os.makedirs(images_dir, exist_ok=True)
    extension = EXTENSION_BY_MIME.get(mime_type.strip().lower(), "png")
    # A uuid keeps two images in one session from colliding; the model threads
    # this exact name back into edit_image.
    filename = f"generated-image-{uuid.uuid4().hex}.{extension}"
    try:
        data = base64.b64decode(image_base64)
    except Exception:
        raise RuntimeError("June returned an image it could not decode.")
    with open(os.path.join(images_dir, filename), "wb") as handle:
        handle.write(data)
    return filename


def read_image(images_dir: str, filename: str) -> tuple[str, str]:
    # Guard against path traversal: only a bare filename inside images_dir is
    # allowed, never a path that escapes it.
    safe_name = os.path.basename(filename)
    if not safe_name or safe_name != filename:
        raise ValueError("source_filename must be a plain image filename.")
    path = os.path.join(images_dir, safe_name)
    if not os.path.isfile(path):
        raise ValueError(
            f"No image named {safe_name}. Use a filename a prior image tool returned."
        )
    with open(path, "rb") as handle:
        data = handle.read()
    extension = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else "png"
    mime_type = next(
        (mime for mime, ext in EXTENSION_BY_MIME.items() if ext == extension),
        "image/png",
    )
    return base64.b64encode(data).decode("ascii"), mime_type


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
        # The envelope still carries {success, message} on 4xx/5xx (e.g. 402 out
        # of credits, 422 model_not_priced), so read it for a usable error.
        body = exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach the June image proxy: {exc.reason}")

    try:
        envelope = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise RuntimeError("The June image proxy returned an unreadable response.")

    if envelope.get("success"):
        data_value = envelope.get("data")
        return data_value if isinstance(data_value, dict) else {}
    raise RuntimeError(str(envelope.get("message") or "Image request failed."))


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()
