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
as the second argument) so the model can reference a prior image by an edit-safe
source reference when it wants to edit it. Source images are resolved from a
stateless HMAC-signed reference over the canonical image filename, keyed by a
secret persisted beside the images directory. Bare filenames and paths inside
those global roots are not accepted as edit sources.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import base64
import builtins
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import socket
import stat
import sys
import tempfile
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
EDIT_SOURCE_MARKER = ".june-source-"
EDIT_SOURCE_SIGNATURE_HEX_LEN = 64
EDIT_SOURCE_SECRET_BYTES = 32
EDIT_SOURCE_HMAC_PAYLOAD_PREFIX = b"june-image-source-v1\0"
EDIT_SOURCE_SECRET_SUFFIX = ".june-image-source-secret"

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
            "or similar. Returns the image inline plus an edit-safe `filename`; "
            "pass that exact filename to `edit_image` if the user then asks to "
            "change it."
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
            "received from this tool earlier, including reframing like wider, "
            "zoom out, bigger perspective, or closer, plus recoloring, "
            "restyling, and adding or removing elements. This transforms the "
            "image file directly: you do NOT need to see, analyze, or describe "
            "the image to edit it. "
            "`source_filename` MUST be a filename from a previous image tool "
            "result from this June image workspace. Bare file names and paths "
            "copied from disk are rejected. Returns the edited image inline plus "
            "a new edit-safe `filename` you can edit again."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_filename": {
                    "type": "string",
                    "description": (
                        "The edit-safe filename of the image to edit, exactly "
                        "as returned by a prior June image tool call."
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
    source_registry = EditSourceRegistry(images_dir)
    # The proxy token is passed via the environment rather than argv so it does
    # not show up in process listings.
    token = os.environ.get(TOKEN_ENV_VAR, "")
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(
            base_url, images_dir, source_dirs, source_registry, token, message
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
    source_registry: "EditSourceRegistry",
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
            source_registry,
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
    source_registry: "EditSourceRegistry",
    token: str,
    request_id: Any,
    params: dict[str, Any],
) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    try:
        if name == "generate_image":
            result = generate_image(base_url, images_dir, source_registry, token, arguments)
        elif name == "edit_image":
            result = edit_image(
                base_url, images_dir, source_dirs, source_registry, token, arguments
            )
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
    base_url: str,
    images_dir: str,
    source_registry: "EditSourceRegistry",
    token: str,
    arguments: dict[str, Any],
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
    source_filename = source_registry.register(os.path.join(images_dir, filename))
    return {
        "image_base64": image_base64,
        "mime_type": mime_type,
        "model": envelope.get("model"),
        "filename": source_filename,
        "label": prompt,
    }


def edit_image(
    base_url: str,
    images_dir: str,
    source_dirs: list[str],
    source_registry: "EditSourceRegistry",
    token: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    source_filename = str(arguments.get("source_filename") or "").strip()
    instruction = str(arguments.get("instruction") or "").strip()
    if not source_filename:
        raise ValueError("source_filename is required")
    if not instruction:
        raise ValueError("instruction is required")
    source_base64, source_mime = read_image(source_dirs, source_filename, source_registry)
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
    next_source_filename = source_registry.register(os.path.join(images_dir, filename))
    return {
        "image_base64": image_base64,
        "mime_type": mime_type,
        "model": envelope.get("model"),
        "filename": next_source_filename,
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


def read_image(
    source_dirs: list[str], filename: str, source_registry: "EditSourceRegistry"
) -> tuple[str, str]:
    path = resolve_source_image_path(source_dirs, filename, source_registry)
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


class EditSourceRegistry:
    def __init__(self, images_dir: str) -> None:
        self._images_dir = canonical_path(images_dir)
        self._secret = load_or_create_edit_source_secret(self._images_dir)

    def register(self, path: str) -> str:
        canonical = canonical_path(path)
        safe_name = os.path.basename(canonical)
        if not safe_name:
            raise ValueError("source_filename is required")
        signature = edit_source_signature(self._secret, safe_name)
        return edit_source_reference(safe_name, signature)

    def path_for(self, safe_name: str, signature: str) -> str | None:
        expected_signature = edit_source_signature(self._secret, safe_name)
        if not hmac.compare_digest(signature, expected_signature):
            return None
        path = canonical_path(os.path.join(self._images_dir, safe_name))
        if path_is_within(path, self._images_dir):
            return path
        return None


def edit_source_reference(safe_name: str, signature: str) -> str:
    stem, extension = os.path.splitext(safe_name)
    if not stem:
        stem = "image"
    return f"{stem}{EDIT_SOURCE_MARKER}{signature}{extension}"


def parse_edit_source_reference(reference: str) -> tuple[str, str] | None:
    stripped = reference.strip()
    safe_name = os.path.basename(stripped)
    if not safe_name or safe_name != stripped:
        return None
    stem_with_signature, extension = os.path.splitext(safe_name)
    stem, marker, signature = stem_with_signature.rpartition(EDIT_SOURCE_MARKER)
    if not marker or not stem or len(signature) != EDIT_SOURCE_SIGNATURE_HEX_LEN:
        return None
    if any(char not in "0123456789abcdef" for char in signature):
        return None
    return signature, f"{stem}{extension}"


def edit_source_signature(secret: bytes, safe_name: str) -> str:
    payload = EDIT_SOURCE_HMAC_PAYLOAD_PREFIX + safe_name.encode("utf-8")
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def edit_source_secret_path(images_dir: str) -> str:
    canonical_images_dir = canonical_path(images_dir)
    parent = os.path.dirname(canonical_images_dir)
    images_name = os.path.basename(canonical_images_dir) or "images"
    return os.path.join(parent, f".{images_name}{EDIT_SOURCE_SECRET_SUFFIX}")


def load_or_create_edit_source_secret(images_dir: str) -> bytes:
    path = edit_source_secret_path(images_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fd = None
    if fd is not None:
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            handle.write(secrets.token_hex(EDIT_SOURCE_SECRET_BYTES))
    os.chmod(path, 0o600)
    with open(path, "r", encoding="ascii") as handle:
        secret_hex = handle.read().strip()
    if (
        len(secret_hex) != EDIT_SOURCE_SECRET_BYTES * 2
        or any(char not in "0123456789abcdef" for char in secret_hex)
    ):
        raise ValueError("June image edit-source secret is invalid.")
    return bytes.fromhex(secret_hex)


def resolve_source_image_path(
    source_dirs: list[str], filename: str, source_registry: EditSourceRegistry
) -> str:
    reference = filename.strip()
    parsed = parse_edit_source_reference(reference)
    if parsed is None:
        safe_name = os.path.basename(reference)
        if not safe_name:
            raise ValueError("source_filename is required")
        if os.path.isabs(reference) or safe_name != reference:
            raise ValueError("source_filename must be an edit-safe filename from this tool.")
        raise ValueError(
            f"No editable image named {safe_name}. Use the edit-safe filename returned by June's image tool."
        )

    signature, expected_name = parsed
    path = source_registry.path_for(expected_name, signature)
    if path is None:
        raise ValueError("source_filename must be an edit-safe filename from this tool.")

    safe_name = os.path.basename(path)
    if safe_name != expected_name:
        raise ValueError("source_filename must match the image it was issued for.")

    roots = [canonical_path(source_dir) for source_dir in source_dirs if source_dir]
    if any(path_is_within(path, root) for root in roots) and os.path.isfile(path):
        return path

    raise ValueError("source_filename must refer to an available June image source.")


def canonical_path(path: str) -> str:
    return os.path.realpath(os.path.abspath(path))


def path_is_within(candidate: str, root: str) -> bool:
    try:
        return os.path.commonpath([candidate, root]) == root
    except ValueError:
        return False


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
    smoke_test_registered_edit_source_resolves_and_reads()
    smoke_test_edit_source_survives_registry_restart()
    smoke_test_tampered_edit_source_is_rejected_before_read()
    smoke_test_unregistered_upload_source_is_rejected_before_read()
    smoke_test_registered_source_outside_roots_is_rejected()


def write_test_png(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n" + b"test-png")


def assert_raises_value_error(expected: str, action: Any) -> None:
    try:
        action()
    except ValueError as exc:
        if expected not in str(exc):
            raise AssertionError(f"wrong error: {exc}") from exc
        return
    raise AssertionError("expected ValueError")


def smoke_test_registered_edit_source_resolves_and_reads() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        images_dir = os.path.join(temp_dir, "images")
        image_path = os.path.join(images_dir, "generated-image-ok.png")
        write_test_png(image_path)
        registry = EditSourceRegistry(images_dir)
        source_ref = registry.register(image_path)

        resolved = resolve_source_image_path([images_dir], source_ref, registry)
        if resolved != canonical_path(image_path):
            raise AssertionError("registered source resolved to the wrong path")

        source_base64, source_mime = read_image([images_dir], source_ref, registry)
        if source_mime != "image/png":
            raise AssertionError("registered source returned the wrong mime type")
        if not base64.b64decode(source_base64).startswith(b"\x89PNG\r\n\x1a\n"):
            raise AssertionError("registered source returned the wrong bytes")


def smoke_test_edit_source_survives_registry_restart() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        images_dir = os.path.join(temp_dir, "images")
        image_path = os.path.join(images_dir, "generated-image-ok.png")
        write_test_png(image_path)
        source_ref = EditSourceRegistry(images_dir).register(image_path)
        secret_mode = stat.S_IMODE(os.stat(edit_source_secret_path(images_dir)).st_mode)
        if secret_mode != 0o600:
            raise AssertionError("edit-source secret was not created with 0600 permissions")

        restarted_registry = EditSourceRegistry(images_dir)
        original_call_proxy = globals()["call_proxy"]

        def fake_call_proxy(
            base_url: str,
            token: str,
            path: str,
            payload: dict[str, Any],
            timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
            max_attempts: int = REQUEST_MAX_ATTEMPTS,
        ) -> dict[str, Any]:
            if path != "/image/edit":
                raise AssertionError(f"wrong path: {path}")
            if not base64.b64decode(str(payload.get("image") or "")).startswith(
                b"\x89PNG\r\n\x1a\n"
            ):
                raise AssertionError("restart edit did not send the source image bytes")
            return {
                "imageBase64": base64.b64encode(b"\x89PNG\r\n\x1a\nedited").decode(
                    "ascii"
                ),
                "mimeType": "image/png",
                "model": "fake-edit",
            }

        try:
            globals()["call_proxy"] = fake_call_proxy
            result = edit_image(
                "http://127.0.0.1",
                images_dir,
                [images_dir],
                restarted_registry,
                "token",
                {
                    "source_filename": source_ref,
                    "instruction": "make it warmer",
                },
            )
        finally:
            globals()["call_proxy"] = original_call_proxy

        if result.get("model") != "fake-edit":
            raise AssertionError("restart edit did not return the fake edit result")
        read_image([images_dir], str(result.get("filename") or ""), EditSourceRegistry(images_dir))


def smoke_test_tampered_edit_source_is_rejected_before_read() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        images_dir = os.path.join(temp_dir, "images")
        image_path = os.path.join(images_dir, "generated-image-ok.png")
        write_test_png(image_path)
        registry = EditSourceRegistry(images_dir)
        source_ref = registry.register(image_path)
        signature_start = source_ref.rfind(EDIT_SOURCE_MARKER) + len(EDIT_SOURCE_MARKER)
        replacement = "1" if source_ref[signature_start] == "0" else "0"
        tampered = (
            source_ref[:signature_start]
            + replacement
            + source_ref[signature_start + 1 :]
        )
        restarted_registry = EditSourceRegistry(images_dir)
        original_open = builtins.open

        def fail_on_read(*args: Any, **kwargs: Any) -> Any:
            raise AssertionError("tampered source was opened")

        try:
            builtins.open = fail_on_read
            assert_raises_value_error(
                "edit-safe filename",
                lambda: read_image([images_dir], tampered, restarted_registry),
            )
        finally:
            builtins.open = original_open


def smoke_test_unregistered_upload_source_is_rejected_before_read() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        images_dir = os.path.join(temp_dir, "images")
        uploads_dir = os.path.join(temp_dir, "uploads")
        image_path = os.path.join(uploads_dir, "other-session.png")
        write_test_png(image_path)
        registry = EditSourceRegistry(images_dir)
        source_ref = edit_source_reference(
            "other-session.png", "0" * EDIT_SOURCE_SIGNATURE_HEX_LEN
        )
        original_open = builtins.open

        def fail_on_read(*args: Any, **kwargs: Any) -> Any:
            raise AssertionError("unregistered source was opened")

        try:
            builtins.open = fail_on_read
            assert_raises_value_error(
                "edit-safe filename",
                lambda: read_image([uploads_dir], source_ref, registry),
            )
        finally:
            builtins.open = original_open


def smoke_test_registered_source_outside_roots_is_rejected() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        images_dir = os.path.join(temp_dir, "images")
        uploads_dir = os.path.join(temp_dir, "uploads")
        other_session_uploads = os.path.join(temp_dir, "other-session-uploads")
        image_path = os.path.join(other_session_uploads, "attached.png")
        write_test_png(image_path)
        registry = EditSourceRegistry(images_dir)
        source_ref = registry.register(image_path)

        assert_raises_value_error(
            "available June image source",
            lambda: read_image([images_dir, uploads_dir], source_ref, registry),
        )


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
