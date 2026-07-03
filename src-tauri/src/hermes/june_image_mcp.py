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
filename when it wants to edit it. Source images are resolved from that directory
and any extra read directories passed after it, such as Hermes's workspace
uploads for `/image` fast-path and user-attached images. The model may pass a
bare filename or a path, but paths must canonicalize inside those configured
source directories.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import socket
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-image", "version": "0.1.0"}
REQUEST_TIMEOUT_SECONDS = 600
REQUEST_MAX_ATTEMPTS = 2
TOKEN_ENV_VAR = "JUNE_IMAGE_PROXY_TOKEN"
MAX_EDIT_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024
IMAGE_SIGNATURE_READ_BYTES = 32

# Venice always returns png for generation; edits echo the requested output
# format. Map the response mime to a file extension for the on-disk name.
EXTENSION_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}
MIME_BY_EXTENSION = {
    **{extension: mime_type for mime_type, extension in EXTENSION_BY_MIME.items()},
    "jpeg": "image/jpeg",
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
            "adjust, refine, or reframe an image you generated, edited, or "
            "received as an attachment earlier, including reframing like wider, "
            "zoom out, bigger perspective, or closer, plus recoloring, "
            "restyling, and adding or removing elements. This transforms the "
            "image file directly: you do "
            "NOT need to see, analyze, or describe the image to edit it. "
            "`source_filename` MUST be a filename from a previous image tool "
            "result or an attached image in this conversation. Returns the "
            "edited image inline plus a new `filename` you can edit again."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_filename": {
                    "type": "string",
                    "description": (
                        "The filename or safe June image path of the image to "
                        "edit, exactly as returned by a prior image tool call "
                        "or attached in this conversation."
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
        raise SystemExit(
            "Usage: june_image_mcp.py <proxy_base_url> <images_dir> [source_dir ...]"
        )

    base_url = sys.argv[1].rstrip("/")
    images_dir = sys.argv[2]
    source_dirs = [images_dir, *sys.argv[3:]]
    # The proxy token is passed via the environment rather than argv so it does
    # not show up in process listings.
    token = os.environ.get(TOKEN_ENV_VAR, "")
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(
            base_url, images_dir, source_dirs, token, message
        )
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
    base_url: str,
    images_dir: str,
    source_dirs: list[str],
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
        return call_tool(
            base_url,
            images_dir,
            source_dirs,
            token,
            request_id,
            message.get("params") or {},
        )

    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def call_tool(
    base_url: str,
    images_dir: str,
    source_dirs: list[str],
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
            result = edit_image(base_url, images_dir, source_dirs, token, arguments)
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
    request_id = new_request_id()
    envelope = call_proxy(
        base_url,
        token,
        "/image/generate",
        {"prompt": prompt, "requestId": request_id},
    )
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
    base_url: str,
    images_dir: str,
    source_dirs: list[str],
    token: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    source_filename = str(arguments.get("source_filename") or "").strip()
    instruction = str(arguments.get("instruction") or "").strip()
    if not source_filename:
        raise ValueError("source_filename is required")
    if not instruction:
        raise ValueError("instruction is required")
    source_base64, source_mime = read_image(source_dirs, source_filename)
    request_id = new_request_id()
    envelope = call_proxy(
        base_url,
        token,
        "/image/edit",
        {
            "image": source_base64,
            "prompt": instruction,
            "mimeType": source_mime,
            "requestId": request_id,
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


def read_image(source_dirs: list[str], filename: str) -> tuple[str, str]:
    path = resolve_source_image_path(source_dirs, filename)
    safe_name = os.path.basename(path)
    mime_type = source_image_mime_type(path, safe_name)
    size = os.path.getsize(path)
    if size > MAX_EDIT_SOURCE_IMAGE_BYTES:
        raise ValueError("source_filename must be 50 MB or smaller.")
    with open(path, "rb") as handle:
        signature = handle.read(IMAGE_SIGNATURE_READ_BYTES)
        sniffed_mime = sniff_image_mime_type(signature)
        if sniffed_mime is None or sniffed_mime != mime_type:
            raise ValueError("source_filename must refer to a real PNG, JPEG, WebP, or GIF image.")
        handle.seek(0)
        data = handle.read()
    return base64.b64encode(data).decode("ascii"), mime_type


def sniff_image_mime_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "image/gif"
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def source_image_mime_type(path: str, safe_name: str) -> str:
    extension = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else ""
    mime_type = MIME_BY_EXTENSION.get(extension)
    if mime_type is None:
        raise ValueError("source_filename must refer to a PNG, JPEG, WebP, or GIF image.")

    guessed_mime = (mimetypes.guess_type(path)[0] or "").strip().lower()
    if guessed_mime and guessed_mime != mime_type:
        raise ValueError("source_filename must refer to a PNG, JPEG, WebP, or GIF image.")
    return mime_type


def resolve_source_image_path(source_dirs: list[str], filename: str) -> str:
    reference = filename.strip()
    safe_name = os.path.basename(reference)
    if not safe_name:
        raise ValueError("source_filename is required")

    roots = [canonical_path(source_dir) for source_dir in source_dirs if source_dir]
    candidates: list[str] = []
    if os.path.isabs(reference):
        candidates.append(canonical_path(reference))
    else:
        candidates.extend(canonical_path(os.path.join(root, reference)) for root in roots)

    for candidate in unique_strings(candidates):
        if any(path_is_within(candidate, root) for root in roots) and os.path.isfile(candidate):
            return candidate

    if os.path.isabs(reference) or safe_name != reference:
        raise ValueError("source_filename must refer to an image from this conversation.")
    raise ValueError(
        f"No image named {safe_name}. Use an image filename from this conversation."
    )


def canonical_path(path: str) -> str:
    return os.path.realpath(os.path.abspath(path))


def path_is_within(candidate: str, root: str) -> bool:
    try:
        return os.path.commonpath([candidate, root]) == root
    except ValueError:
        return False


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def new_request_id() -> str:
    return uuid.uuid4().hex


def call_proxy(
    base_url: str,
    token: str,
    path: str,
    payload: dict[str, Any],
    timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
    max_attempts: int = REQUEST_MAX_ATTEMPTS,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    attempts = max(1, max_attempts)
    for attempt in range(attempts):
        request = urllib.request.Request(f"{base_url}{path}", data=data, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as resp:
                body = resp.read().decode("utf-8")
            break
        except urllib.error.HTTPError as exc:
            # The envelope still carries {success, message} on 4xx/5xx (e.g. 402 out
            # of credits, 422 model_not_priced), so read it for a usable error.
            body = exc.read().decode("utf-8", "replace")
            break
        except (TimeoutError, ConnectionError, socket.timeout, urllib.error.URLError) as exc:
            if attempt + 1 < attempts:
                continue
            raise RuntimeError(
                f"Could not reach the June image proxy: {transport_error_reason(exc)}"
            )

    try:
        envelope = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise RuntimeError("The June image proxy returned an unreadable response.")

    if envelope.get("success"):
        data_value = envelope.get("data")
        return data_value if isinstance(data_value, dict) else {}
    raise RuntimeError(str(envelope.get("message") or "Image request failed."))


def transport_error_reason(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.URLError):
        return str(exc.reason)
    return str(exc)


def run_smoke_tests() -> None:
    smoke_test_proxy_retry_reuses_request_id()


def smoke_test_proxy_retry_reuses_request_id() -> None:
    state: dict[str, Any] = {
        "requests": [],
        "side_effects": 0,
    }

    class FakeResponse:
        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(
                {
                    "success": True,
                    "data": {
                        "imageBase64": base64.b64encode(b"ok").decode("ascii"),
                        "mimeType": "image/png",
                    },
                }
            ).encode("utf-8")

    original_urlopen = urllib.request.urlopen

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        payload = json.loads((request.data or b"{}").decode("utf-8"))
        state["requests"].append(payload.get("requestId"))
        if len(state["requests"]) == 1:
            raise TimeoutError("timed out")
        state["side_effects"] += 1
        return FakeResponse()

    try:
        urllib.request.urlopen = fake_urlopen
        request_id = new_request_id()
        envelope = call_proxy(
            "http://127.0.0.1",
            "token",
            "/image/generate",
            {"prompt": "a cat", "requestId": request_id},
            timeout_seconds=0.05,
            max_attempts=2,
        )
    finally:
        urllib.request.urlopen = original_urlopen

    if envelope.get("mimeType") != "image/png":
        raise AssertionError("retry smoke test returned the wrong envelope")
    if state["requests"] != [request_id, request_id]:
        raise AssertionError("retry smoke test did not reuse one requestId")
    if state["side_effects"] != 1:
        raise AssertionError("retry smoke test produced more than one side effect")


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        run_smoke_tests()
    else:
        main()
