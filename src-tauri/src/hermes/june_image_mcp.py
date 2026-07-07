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
as the second argument) under proxy-selected storage filenames. The Rust
loopback proxy mints opaque edit-safe source references and validates them
before reading source bytes for edits; plain filenames of images already in
the images directory (user attachments) are also accepted. This MCP only
forwards those references back to the proxy.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import base64
import email.utils
import io
import json
import os
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-image", "version": "0.1.0"}
REQUEST_TIMEOUT_SECONDS = 660
REQUEST_MAX_ATTEMPTS = 3
REQUEST_RETRY_DELAY_SECONDS = 0.25
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
                "may_be_explicit": {
                    "type": "boolean",
                    "description": (
                        "True when the requested image could contain adult, sexual, or "
                        "otherwise explicit content; false for clearly benign requests. "
                        "Judge the request itself, not just its wording."
                    ),
                },
            },
            "required": ["prompt", "may_be_explicit"],
        },
    },
    {
        "name": "edit_image",
        "description": (
            "Edit an existing image (image-to-image) and show the result in the "
            "conversation. Use this whenever the user asks to change, modify, "
            "adjust, refine, or reframe an image you generated, edited, or "
            "received from this tool earlier, or an image the user attached or "
            "pasted into the conversation, including reframing like wider, "
            "zoom out, bigger perspective, or closer, plus recoloring, "
            "restyling, and adding or removing elements. This transforms the "
            "image file directly: you do NOT need to see, analyze, or describe "
            "the image to edit it. "
            "`source_filename` MUST be one of two values: a filename from a "
            "previous image tool result, or the plain filename of an image the "
            "user attached to the conversation exactly as shown in its context "
            "(for example upload_20260707_113453_1.png). Full paths and "
            "invented names are rejected. Returns the edited image inline plus "
            "a new edit-safe `filename` you can edit again."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_filename": {
                    "type": "string",
                    "description": (
                        "The edit-safe filename returned by a prior June image "
                        "tool call, or the plain filename of an image the user "
                        "attached to the conversation. Never a full path."
                    ),
                },
                "instruction": {
                    "type": "string",
                    "description": "What to change about the image.",
                },
                "may_be_explicit": {
                    "type": "boolean",
                    "description": (
                        "True when the requested image could contain adult, sexual, or "
                        "otherwise explicit content; false for clearly benign requests. "
                        "Judge the request itself, not just its wording."
                    ),
                },
            },
            "required": ["source_filename", "instruction", "may_be_explicit"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(
            "Usage: june_image_mcp.py <proxy_base_url> <images_dir>"
        )

    base_url = sys.argv[1].rstrip("/")
    images_dir = sys.argv[2]
    # The proxy token is passed via the environment rather than argv so it does
    # not show up in process listings.
    token = os.environ.get(TOKEN_ENV_VAR, "")
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(
            base_url, images_dir, token, message
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
    base_url: str,
    images_dir: str,
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
        {
            "prompt": prompt,
            "requestId": request_id,
            "may_be_explicit": arguments.get("may_be_explicit", False),
        },
    )
    image_base64 = str(envelope.get("imageBase64") or "")
    mime_type = str(envelope.get("mimeType") or "image/png")
    if not image_base64:
        raise RuntimeError("June returned an empty image.")
    storage_filename = proxy_storage_filename(envelope)
    source_filename = proxy_source_filename(envelope)
    write_image(images_dir, storage_filename, image_base64, mime_type)
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
    token: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    source_filename = str(arguments.get("source_filename") or "").strip()
    instruction = str(arguments.get("instruction") or "").strip()
    if not source_filename:
        raise ValueError("source_filename is required")
    if not instruction:
        raise ValueError("instruction is required")
    request_id = new_request_id()
    envelope = call_proxy(
        base_url,
        token,
        "/image/edit",
        {
            "sourceFilename": source_filename,
            "prompt": instruction,
            "requestId": request_id,
            "may_be_explicit": arguments.get("may_be_explicit", False),
        },
    )
    image_base64 = str(envelope.get("imageBase64") or "")
    mime_type = str(envelope.get("mimeType") or "image/png")
    if not image_base64:
        raise RuntimeError("June returned an empty edited image.")
    storage_filename = proxy_storage_filename(envelope)
    next_source_filename = proxy_source_filename(envelope)
    write_image(images_dir, storage_filename, image_base64, mime_type)
    return {
        "image_base64": image_base64,
        "mime_type": mime_type,
        "model": envelope.get("model"),
        "filename": next_source_filename,
        "label": instruction,
    }


def proxy_storage_filename(envelope: dict[str, Any]) -> str:
    filename = str(envelope.get("storageFilename") or "").strip()
    if not filename:
        raise RuntimeError("June returned an image without a storage filename.")
    return filename


def proxy_source_filename(envelope: dict[str, Any]) -> str:
    filename = str(envelope.get("sourceFilename") or "").strip()
    if not filename:
        raise RuntimeError("June returned an image without an edit-safe filename.")
    return filename


def write_image(
    images_dir: str, filename: str, image_base64: str, mime_type: str
) -> str:
    os.makedirs(images_dir, exist_ok=True)
    safe_name = storage_safe_filename(filename, mime_type)
    try:
        data = base64.b64decode(image_base64)
    except Exception:
        raise RuntimeError("June returned an image it could not decode.")
    with open(os.path.join(images_dir, safe_name), "wb") as handle:
        handle.write(data)
    return safe_name


def storage_safe_filename(filename: str, mime_type: str) -> str:
    safe_name = os.path.basename(filename.strip())
    if not safe_name or safe_name != filename.strip() or os.path.isabs(filename):
        raise RuntimeError("June returned an unsafe storage filename.")
    extension = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else ""
    expected_extension = EXTENSION_BY_MIME.get(mime_type.strip().lower(), "png")
    if extension != expected_extension:
        raise RuntimeError("June returned a storage filename that does not match the image type.")
    return safe_name


def new_request_id() -> str:
    return uuid.uuid4().hex


def call_proxy(
    base_url: str,
    token: str,
    path: str,
    payload: dict[str, Any],
    timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
    max_attempts: int = REQUEST_MAX_ATTEMPTS,
    retry_delay_seconds: float = REQUEST_RETRY_DELAY_SECONDS,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    attempts = max(1, max_attempts)
    status: int | None = None
    for attempt in range(attempts):
        request = urllib.request.Request(f"{base_url}{path}", data=data, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as resp:
                status = resp.status
                body = resp.read().decode("utf-8")
            break
        except urllib.error.HTTPError as exc:
            # The envelope still carries {success, message} on application
            # errors (e.g. 402 out of credits, 422 model_not_priced), so read it
            # for a usable terminal error. Only retry statuses whose replay can
            # complete safely with the same requestId.
            status = exc.code
            body = exc.read().decode("utf-8", "replace")
            if retryable_http_status(exc.code) and attempt + 1 < attempts:
                time.sleep(retry_after_seconds(exc.headers) or retry_delay_seconds)
                continue
            break
        except (TimeoutError, ConnectionError, socket.timeout, urllib.error.URLError) as exc:
            if attempt + 1 < attempts:
                time.sleep(retry_delay_seconds)
                continue
            raise RuntimeError(
                f"Could not reach the June image proxy: {transport_error_reason(exc)}"
            )

    try:
        envelope = json.loads(body) if body else {}
    except json.JSONDecodeError:
        # A body that is not JSON never came from June's envelope; it is an
        # intermediary artifact (e.g. an ingress error page), so the status is
        # the only clue worth surfacing.
        raise RuntimeError(
            f"The June image proxy returned an unreadable response (HTTP {status})."
        )

    if envelope.get("success"):
        data_value = envelope.get("data")
        return data_value if isinstance(data_value, dict) else {}
    raise RuntimeError(str(envelope.get("message") or "Image request failed."))


def retryable_http_status(status: int) -> bool:
    return status in {429, 503, 504}


def retry_after_seconds(headers: Any) -> float | None:
    if headers is None:
        return None
    value = headers.get("Retry-After") if hasattr(headers, "get") else None
    if not value:
        return None
    value = str(value).strip()
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        retry_at = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, retry_at.timestamp() - time.time())


def transport_error_reason(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.URLError):
        return str(exc.reason)
    return str(exc)


def run_smoke_tests() -> None:
    smoke_test_proxy_retry_reuses_request_id()
    smoke_test_proxy_retryable_http_reuses_request_id()
    smoke_test_proxy_unreadable_response_reports_status()
    smoke_test_generate_writes_proxy_issued_storage_filename()
    smoke_test_edit_forwards_opaque_source_ref_without_reading_source()
    smoke_test_no_legacy_edit_secret_under_hermes_home()


def test_png_base64(label: bytes = b"test-png") -> str:
    return base64.b64encode(b"\x89PNG\r\n\x1a\n" + label).decode("ascii")


def assert_no_legacy_secret(root: str) -> None:
    for directory, _, filenames in os.walk(root):
        for filename in filenames:
            if filename.endswith(".june-image-source-secret"):
                raise AssertionError(
                    f"legacy edit-source secret exists under Hermes home: {os.path.join(directory, filename)}"
                )


def smoke_test_generate_writes_proxy_issued_storage_filename() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        images_dir = os.path.join(temp_dir, "images")
        original_call_proxy = globals()["call_proxy"]
        source_ref = "generated-image-ok.june-source-" + ("a" * 64) + ".png"
        storage_filename = "generated-image-ok.png"

        def fake_call_proxy(
            base_url: str,
            token: str,
            path: str,
            payload: dict[str, Any],
            timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
            max_attempts: int = REQUEST_MAX_ATTEMPTS,
            retry_delay_seconds: float = REQUEST_RETRY_DELAY_SECONDS,
        ) -> dict[str, Any]:
            if path != "/image/generate":
                raise AssertionError(f"wrong path: {path}")
            if payload.get("prompt") != "a cat":
                raise AssertionError("generate did not send the prompt")
            if payload.get("may_be_explicit") is not True:
                raise AssertionError("generate did not forward may_be_explicit")
            if "image" in payload or "sourceFilename" in payload:
                raise AssertionError("generate sent source data")
            return {
                "imageBase64": test_png_base64(),
                "mimeType": "image/png",
                "model": "fake-generate",
                "sourceFilename": source_ref,
                "storageFilename": storage_filename,
            }

        try:
            globals()["call_proxy"] = fake_call_proxy
            result = generate_image(
                "http://127.0.0.1",
                images_dir,
                "token",
                {"prompt": "a cat", "may_be_explicit": True},
            )
        finally:
            globals()["call_proxy"] = original_call_proxy

        if result.get("filename") != source_ref:
            raise AssertionError("generate did not return the proxy-issued edit reference")
        if result.get("model") != "fake-generate":
            raise AssertionError("generate did not return the fake model")
        written_path = os.path.join(images_dir, storage_filename)
        if not os.path.exists(written_path):
            raise AssertionError("generate did not write the proxy-issued storage filename")
        assert_no_legacy_secret(temp_dir)


def smoke_test_edit_forwards_opaque_source_ref_without_reading_source() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        images_dir = os.path.join(temp_dir, "images")
        original_call_proxy = globals()["call_proxy"]
        source_ref = "generated-image-ok.june-source-" + ("b" * 64) + ".png"
        next_source_ref = "generated-image-edit.june-source-" + ("c" * 64) + ".png"
        next_storage_filename = "generated-image-edit.png"

        def fake_call_proxy(
            base_url: str,
            token: str,
            path: str,
            payload: dict[str, Any],
            timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
            max_attempts: int = REQUEST_MAX_ATTEMPTS,
            retry_delay_seconds: float = REQUEST_RETRY_DELAY_SECONDS,
        ) -> dict[str, Any]:
            if path != "/image/edit":
                raise AssertionError(f"wrong path: {path}")
            if payload.get("sourceFilename") != source_ref:
                raise AssertionError("edit did not forward the source reference")
            if payload.get("may_be_explicit") is not False:
                raise AssertionError("edit did not forward may_be_explicit")
            if "image" in payload or "mimeType" in payload:
                raise AssertionError("edit sent source bytes instead of an opaque ref")
            return {
                "imageBase64": test_png_base64(b"edited"),
                "mimeType": "image/png",
                "model": "fake-edit",
                "sourceFilename": next_source_ref,
                "storageFilename": next_storage_filename,
            }

        try:
            globals()["call_proxy"] = fake_call_proxy
            result = edit_image(
                "http://127.0.0.1",
                images_dir,
                "token",
                {
                    "source_filename": source_ref,
                    "instruction": "make it warmer",
                    "may_be_explicit": False,
                },
            )
        finally:
            globals()["call_proxy"] = original_call_proxy

        if result.get("filename") != next_source_ref:
            raise AssertionError("edit did not return the proxy-issued next edit reference")
        if not os.path.exists(os.path.join(images_dir, next_storage_filename)):
            raise AssertionError("edit did not write the proxy-issued storage filename")


def smoke_test_no_legacy_edit_secret_under_hermes_home() -> None:
    with tempfile.TemporaryDirectory() as hermes_home:
        images_dir = os.path.join(hermes_home, "images")
        original_call_proxy = globals()["call_proxy"]

        def fake_call_proxy(
            base_url: str,
            token: str,
            path: str,
            payload: dict[str, Any],
            timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
            max_attempts: int = REQUEST_MAX_ATTEMPTS,
            retry_delay_seconds: float = REQUEST_RETRY_DELAY_SECONDS,
        ) -> dict[str, Any]:
            return {
                "imageBase64": test_png_base64(),
                "mimeType": "image/png",
                "model": "fake-generate",
                "sourceFilename": "generated-image-ok.june-source-" + ("d" * 64) + ".png",
                "storageFilename": "generated-image-ok.png",
            }

        try:
            globals()["call_proxy"] = fake_call_proxy
            generate_image("http://127.0.0.1", images_dir, "token", {"prompt": "a cat"})
        finally:
            globals()["call_proxy"] = original_call_proxy

        assert_no_legacy_secret(hermes_home)


def smoke_test_proxy_retry_reuses_request_id() -> None:
    state: dict[str, Any] = {
        "requests": [],
        "side_effects": 0,
    }

    class FakeResponse:
        status = 200

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
            retry_delay_seconds=0,
        )
    finally:
        urllib.request.urlopen = original_urlopen

    if envelope.get("mimeType") != "image/png":
        raise AssertionError("retry smoke test returned the wrong envelope")
    if state["requests"] != [request_id, request_id]:
        raise AssertionError("retry smoke test did not reuse one requestId")
    if state["side_effects"] != 1:
        raise AssertionError("retry smoke test produced more than one side effect")


def smoke_test_proxy_retryable_http_reuses_request_id() -> None:
    state: dict[str, Any] = {
        "requests": [],
        "side_effects": 0,
        "seen_request_ids": set(),
    }

    class FakeResponse:
        status = 200

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
        request_id = payload.get("requestId")
        state["requests"].append(request_id)
        if request_id not in state["seen_request_ids"]:
            state["seen_request_ids"].add(request_id)
            state["side_effects"] += 1
        if len(state["requests"]) == 1:
            raise urllib.error.HTTPError(
                request.full_url,
                503,
                "service unavailable",
                {"Retry-After": "0"},
                io.BytesIO(
                    json.dumps(
                        {"success": False, "message": "metering_provider_failed"}
                    ).encode("utf-8")
                ),
            )
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
            retry_delay_seconds=0,
        )
    finally:
        urllib.request.urlopen = original_urlopen

    if envelope.get("mimeType") != "image/png":
        raise AssertionError("http retry smoke test returned the wrong envelope")
    if state["requests"] != [request_id, request_id]:
        raise AssertionError("http retry smoke test did not reuse one requestId")
    if state["side_effects"] != 1:
        raise AssertionError("http retry smoke test produced more than one side effect")


def smoke_test_proxy_unreadable_response_reports_status() -> None:
    # The exact production failure: an ingress in front of June API rejects the
    # request before it reaches June (e.g. 413 for an oversized edit body) and
    # answers with an HTML error page instead of a June JSON envelope.
    nginx_413_page = (
        b"<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n"
        b"<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n"
        b"<hr><center>nginx/1.27.4</center>\r\n</body>\r\n</html>\r\n"
    )

    original_urlopen = urllib.request.urlopen

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> Any:
        raise urllib.error.HTTPError(
            request.full_url,
            413,
            "request entity too large",
            {},
            io.BytesIO(nginx_413_page),
        )

    try:
        urllib.request.urlopen = fake_urlopen
        call_proxy(
            "http://127.0.0.1",
            "token",
            "/image/edit",
            {"sourceFilename": "x", "prompt": "y", "requestId": new_request_id()},
            timeout_seconds=0.05,
            max_attempts=2,
            retry_delay_seconds=0,
        )
    except RuntimeError as exc:
        if "HTTP 413" not in str(exc):
            raise AssertionError(
                f"unreadable-response error does not name the status: {exc}"
            )
    else:
        raise AssertionError("unreadable response did not raise")
    finally:
        urllib.request.urlopen = original_urlopen


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        run_smoke_tests()
    else:
        main()
