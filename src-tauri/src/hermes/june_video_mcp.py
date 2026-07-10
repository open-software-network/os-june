#!/usr/bin/env python3
"""MCP server exposing June video generation tools.

The June app writes this script into the managed Hermes home and registers it as
the built-in `june_video` MCP server. Its tools call the June app's local
provider proxy (loopback only), which adds the user's access token and forwards
to June API's async `/v1/video/*` endpoints. The MCP queues a job, polls status
until the proxy reports a persisted video filename, then returns a `MEDIA:` path
for the app to render. Video bytes are never returned inline.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import email.utils
import io
import json
import os
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-video", "version": "0.1.0"}
REQUEST_TIMEOUT_SECONDS = 120
REQUEST_MAX_ATTEMPTS = 3
REQUEST_RETRY_DELAY_SECONDS = 0.25
POLL_INTERVAL_SECONDS = 4
# Mirror the backend video job budget (`DEFAULT_VIDEO_JOB_MAX_SECS` = 750 in
# june-api config) plus a small margin, so a supported clip that runs to the
# full job budget is not abandoned here before it can finish. Kept under the
# 900s `june_video` MCP tool timeout (with headroom for a final in-flight
# request at REQUEST_TIMEOUT_SECONDS) so this returns a real result before
# Hermes cancels the call. Keep in lockstep with the Rust job budget.
POLL_MAX_SECONDS = 770
TOKEN_ENV_VAR = "JUNE_VIDEO_PROXY_TOKEN"
VIDEO_EXTENSIONS = {"mp4", "webm", "mov"}


class RetryablePollError(RuntimeError):
    pass


TOOLS: list[dict[str, Any]] = [
    {
        "name": "generate_video",
        "description": (
            "Use when the user asks to make, create, or generate a video, "
            "clip, or animation from a text description; the result is shown "
            "to the user; generation takes ~1-3 minutes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "A detailed description of the video to generate.",
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "animate_image",
        "description": (
            "Animate an existing image into a short video (image-to-video); "
            "pass the exact edit-safe filename from a prior "
            "generate_image/edit_image result; do NOT pass a bare disk path."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_filename": {
                    "type": "string",
                    "description": (
                        "The prior tool-issued image filename from a June image "
                        "tool result."
                    ),
                },
                "instruction": {
                    "type": "string",
                    "description": "How to animate the source image.",
                },
            },
            "required": ["source_filename", "instruction"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(
            "Usage: june_video_mcp.py <proxy_base_url> <videos_dir>"
        )

    base_url = sys.argv[1].rstrip("/")
    videos_dir = sys.argv[2]
    token = os.environ.get(TOKEN_ENV_VAR, "")
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(
            base_url, videos_dir, token, message
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
    videos_dir: str,
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
            videos_dir,
            token,
            request_id,
            message.get("params") or {},
        )

    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


def call_tool(
    base_url: str,
    videos_dir: str,
    token: str,
    request_id: Any,
    params: dict[str, Any],
) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    try:
        if name == "generate_video":
            result = generate_video(base_url, videos_dir, token, arguments)
        elif name == "animate_image":
            result = animate_image(base_url, videos_dir, token, arguments)
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

    media_path = f"MEDIA:{videos_dir}/{result['filename']}"
    structured = {
        "filename": result["filename"],
        "mimeType": result["mime_type"],
        "jobId": result["job_id"],
    }
    return response(
        request_id,
        {
            "content": [
                {
                    "type": "text",
                    "text": f"Video is ready: {media_path}",
                },
                {
                    "type": "text",
                    "text": json.dumps(structured, ensure_ascii=False, indent=2),
                },
            ],
            "structuredContent": structured,
        },
    )


def generate_video(
    base_url: str,
    videos_dir: str,
    token: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    prompt = str(arguments.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    request_id = new_request_id()
    queued = call_proxy(
        base_url,
        token,
        "POST",
        "/video/generate",
        {"prompt": prompt, "requestId": request_id},
    )
    job_id = proxy_job_id(queued)
    return poll_video_job(base_url, videos_dir, token, job_id)


def animate_image(
    base_url: str,
    videos_dir: str,
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
    queued = call_proxy(
        base_url,
        token,
        "POST",
        "/video/animate",
        {
            "sourceFilename": source_filename,
            "prompt": instruction,
            "requestId": request_id,
        },
    )
    job_id = proxy_job_id(queued)
    return poll_video_job(base_url, videos_dir, token, job_id)


def poll_video_job(
    base_url: str,
    videos_dir: str,
    token: str,
    job_id: str,
) -> dict[str, Any]:
    deadline = time.monotonic() + POLL_MAX_SECONDS
    path = "/video/status/" + urllib.parse.quote(job_id, safe="")
    while True:
        try:
            status = call_proxy(base_url, token, "GET", path, None)
        except RetryablePollError:
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Video job {job_id} did not finish within {POLL_MAX_SECONDS} seconds."
                )
            time.sleep(min(POLL_INTERVAL_SECONDS, max(0.0, deadline - time.monotonic())))
            continue
        name = str(status.get("status") or "").strip().lower()
        if name == "processing":
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Video job {job_id} did not finish within {POLL_MAX_SECONDS} seconds."
                )
            time.sleep(min(POLL_INTERVAL_SECONDS, max(0.0, deadline - time.monotonic())))
            continue
        if name == "completed":
            filename = video_safe_filename(str(status.get("filename") or ""))
            mime_type = str(status.get("mimeType") or "video/mp4").strip() or "video/mp4"
            return {
                "filename": filename,
                "mime_type": mime_type,
                "job_id": job_id,
            }
        if name == "failed":
            raise RuntimeError(str(status.get("reason") or "Video generation failed."))
        if status.get("success") is False:
            raise RuntimeError(str(status.get("message") or "Video request failed."))
        raise RuntimeError("June returned an unknown video status.")


def proxy_job_id(envelope: dict[str, Any]) -> str:
    job_id = str(envelope.get("jobId") or "").strip()
    if not job_id:
        raise RuntimeError("June returned a video job without a jobId.")
    return job_id


def video_safe_filename(filename: str) -> str:
    safe_name = os.path.basename(filename.strip())
    if not safe_name or safe_name != filename.strip() or os.path.isabs(filename):
        raise RuntimeError("June returned an unsafe video filename.")
    extension = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else ""
    if extension not in VIDEO_EXTENSIONS:
        raise RuntimeError("June returned a video filename with an unsupported extension.")
    return safe_name


def new_request_id() -> str:
    return uuid.uuid4().hex


def call_proxy(
    base_url: str,
    token: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None,
    timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
    max_attempts: int = REQUEST_MAX_ATTEMPTS,
    retry_delay_seconds: float = REQUEST_RETRY_DELAY_SECONDS,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    attempts = max(1, max_attempts)
    status: int | None = None
    body = ""
    for attempt in range(attempts):
        request = urllib.request.Request(f"{base_url}{path}", data=data, method=method)
        if payload is not None:
            request.add_header("Content-Type", "application/json")
        request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as resp:
                status = resp.status
                body = resp.read().decode("utf-8")
            break
        except urllib.error.HTTPError as exc:
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
            if method == "GET":
                raise RetryablePollError(transport_error_reason(exc))
            raise RuntimeError(
                f"Could not reach the June video proxy: {transport_error_reason(exc)}"
            )

    try:
        envelope = json.loads(body) if body else {}
    except json.JSONDecodeError:
        if method == "GET" and status is not None and retryable_http_status(status):
            raise RetryablePollError(f"HTTP {status}")
        raise RuntimeError(
            f"The June video proxy returned an unreadable response (HTTP {status})."
        )

    if method == "GET" and status is not None and retryable_http_status(status):
        raise RetryablePollError(str(envelope.get("message") or f"HTTP {status}"))
    if envelope.get("success") is False:
        raise RuntimeError(str(envelope.get("message") or "Video request failed."))
    data_value = envelope.get("data")
    if envelope.get("success") is True and isinstance(data_value, dict):
        return data_value
    if 200 <= int(status or 0) < 300:
        return envelope if isinstance(envelope, dict) else {}
    raise RuntimeError(str(envelope.get("message") or "Video request failed."))


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
    smoke_test_generate_polls_to_completed_media_path()
    smoke_test_animate_forwards_source_ref_without_bytes()
    smoke_test_proxy_retry_reuses_request_id()
    smoke_test_poll_retryable_http_then_succeeds()
    smoke_test_poll_retry_exhaustion_keeps_polling()
    smoke_test_proxy_unreadable_response_reports_status()
    smoke_test_poll_timeout_returns_error()
    print("june_video_mcp self-test passed (7 tests)")


def smoke_test_generate_polls_to_completed_media_path() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        original_call_proxy = globals()["call_proxy"]
        state: dict[str, Any] = {"polls": 0}

        def fake_call_proxy(
            base_url: str,
            token: str,
            method: str,
            path: str,
            payload: dict[str, Any] | None,
            timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
            max_attempts: int = REQUEST_MAX_ATTEMPTS,
            retry_delay_seconds: float = REQUEST_RETRY_DELAY_SECONDS,
        ) -> dict[str, Any]:
            if method == "POST":
                if path != "/video/generate":
                    raise AssertionError(f"wrong path: {path}")
                if payload is None or payload.get("prompt") != "a cat walking":
                    raise AssertionError("generate did not send the prompt")
                return {"jobId": "job-1"}
            if path != "/video/status/job-1":
                raise AssertionError(f"wrong poll path: {path}")
            state["polls"] += 1
            if state["polls"] == 1:
                return {"status": "processing", "averageExecutionMs": 120000}
            return {
                "status": "completed",
                "filename": "video-ok.mp4",
                "mimeType": "video/mp4",
                "sizeBytes": 10,
            }

        original_interval = globals()["POLL_INTERVAL_SECONDS"]
        try:
            globals()["call_proxy"] = fake_call_proxy
            globals()["POLL_INTERVAL_SECONDS"] = 0
            reply = call_tool(
                "http://127.0.0.1",
                temp_dir,
                "token",
                1,
                {"name": "generate_video", "arguments": {"prompt": "a cat walking"}},
            )
        finally:
            globals()["call_proxy"] = original_call_proxy
            globals()["POLL_INTERVAL_SECONDS"] = original_interval

        content = reply["result"]["content"]
        media_blocks = [
            block for block in content
            if block.get("type") == "text" and "MEDIA:" in block.get("text", "")
        ]
        if len(media_blocks) != 1:
            raise AssertionError("generate did not return exactly one MEDIA path")
        if f"MEDIA:{temp_dir}/video-ok.mp4" not in media_blocks[0]["text"]:
            raise AssertionError("generate returned the wrong MEDIA path")
        if reply["result"]["structuredContent"]["jobId"] != "job-1":
            raise AssertionError("generate did not return the job id")


def smoke_test_animate_forwards_source_ref_without_bytes() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        original_call_proxy = globals()["call_proxy"]
        source_ref = "generated-image-ok.june-source-" + ("b" * 64) + ".png"

        def fake_call_proxy(
            base_url: str,
            token: str,
            method: str,
            path: str,
            payload: dict[str, Any] | None,
            timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
            max_attempts: int = REQUEST_MAX_ATTEMPTS,
            retry_delay_seconds: float = REQUEST_RETRY_DELAY_SECONDS,
        ) -> dict[str, Any]:
            if method == "POST":
                if path != "/video/animate":
                    raise AssertionError(f"wrong path: {path}")
                if payload is None or payload.get("sourceFilename") != source_ref:
                    raise AssertionError("animate did not forward sourceFilename")
                serialized = json.dumps(payload)
                if "base64" in serialized.lower() or "imageBase64" in payload:
                    raise AssertionError("animate sent source bytes")
                return {"jobId": "job-animate"}
            return {
                "status": "completed",
                "filename": "animated.webm",
                "mimeType": "video/webm",
            }

        try:
            globals()["call_proxy"] = fake_call_proxy
            result = animate_image(
                "http://127.0.0.1",
                temp_dir,
                "token",
                {
                    "source_filename": source_ref,
                    "instruction": "make it move",
                },
            )
        finally:
            globals()["call_proxy"] = original_call_proxy

        if result.get("filename") != "animated.webm":
            raise AssertionError("animate returned the wrong filename")


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
            return json.dumps({"jobId": "job-retry"}).encode("utf-8")

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
            "POST",
            "/video/generate",
            {"prompt": "a cat", "requestId": request_id},
            timeout_seconds=0.05,
            max_attempts=2,
            retry_delay_seconds=0,
        )
    finally:
        urllib.request.urlopen = original_urlopen

    if envelope.get("jobId") != "job-retry":
        raise AssertionError("retry smoke test returned the wrong envelope")
    if state["requests"] != [request_id, request_id]:
        raise AssertionError("retry smoke test did not reuse one requestId")
    if state["side_effects"] != 1:
        raise AssertionError("retry smoke test produced more than one side effect")


def smoke_test_poll_retryable_http_then_succeeds() -> None:
    state: dict[str, Any] = {"polls": 0}

    class FakeResponse:
        status = 200

        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(
                {
                    "status": "completed",
                    "filename": "retry-ok.mov",
                    "mimeType": "video/quicktime",
                }
            ).encode("utf-8")

    original_urlopen = urllib.request.urlopen

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        if request.get_method() != "GET":
            raise AssertionError("poll retry test should only issue GET")
        state["polls"] += 1
        if state["polls"] == 1:
            raise urllib.error.HTTPError(
                request.full_url,
                429,
                "too many requests",
                {"Retry-After": "0"},
                io.BytesIO(json.dumps({"success": False, "message": "rate"}).encode("utf-8")),
            )
        return FakeResponse()

    try:
        urllib.request.urlopen = fake_urlopen
        result = poll_video_job("http://127.0.0.1", "/tmp/videos", "token", "job-429")
    finally:
        urllib.request.urlopen = original_urlopen

    if state["polls"] != 2:
        raise AssertionError("poll retry test did not retry exactly once")
    if result.get("filename") != "retry-ok.mov":
        raise AssertionError("poll retry test returned the wrong filename")


def smoke_test_poll_retry_exhaustion_keeps_polling() -> None:
    state: dict[str, Any] = {"calls": 0}

    class FakeResponse:
        status = 200

        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(
                {
                    "status": "completed",
                    "filename": "after-retry-exhaustion.mp4",
                    "mimeType": "video/mp4",
                }
            ).encode("utf-8")

    original_urlopen = urllib.request.urlopen
    original_attempts = globals()["REQUEST_MAX_ATTEMPTS"]
    original_interval = globals()["POLL_INTERVAL_SECONDS"]

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        state["calls"] += 1
        if state["calls"] <= 2:
            raise urllib.error.HTTPError(
                request.full_url,
                503,
                "service unavailable",
                {"Retry-After": "0"},
                io.BytesIO(
                    json.dumps(
                        {"success": False, "message": "temporary capacity"}
                    ).encode("utf-8")
                ),
            )
        return FakeResponse()

    try:
        urllib.request.urlopen = fake_urlopen
        globals()["REQUEST_MAX_ATTEMPTS"] = 2
        globals()["POLL_INTERVAL_SECONDS"] = 0
        result = poll_video_job("http://127.0.0.1", "/tmp/videos", "token", "job-503")
    finally:
        urllib.request.urlopen = original_urlopen
        globals()["REQUEST_MAX_ATTEMPTS"] = original_attempts
        globals()["POLL_INTERVAL_SECONDS"] = original_interval

    if state["calls"] != 3:
        raise AssertionError("poll retry exhaustion did not keep polling")
    if result.get("filename") != "after-retry-exhaustion.mp4":
        raise AssertionError("poll retry exhaustion returned the wrong filename")


def smoke_test_proxy_unreadable_response_reports_status() -> None:
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
            "POST",
            "/video/animate",
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


def smoke_test_poll_timeout_returns_error() -> None:
    original_call_proxy = globals()["call_proxy"]
    original_interval = globals()["POLL_INTERVAL_SECONDS"]
    original_max = globals()["POLL_MAX_SECONDS"]

    def fake_call_proxy(
        base_url: str,
        token: str,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
        max_attempts: int = REQUEST_MAX_ATTEMPTS,
        retry_delay_seconds: float = REQUEST_RETRY_DELAY_SECONDS,
    ) -> dict[str, Any]:
        if method == "POST":
            return {"jobId": "job-timeout"}
        return {"status": "processing", "averageExecutionMs": 120000}

    try:
        globals()["call_proxy"] = fake_call_proxy
        globals()["POLL_INTERVAL_SECONDS"] = 0
        globals()["POLL_MAX_SECONDS"] = 0
        response_message = call_tool(
            "http://127.0.0.1",
            "/tmp/videos",
            "token",
            42,
            {"name": "generate_video", "arguments": {"prompt": "never finishes"}},
        )
    finally:
        globals()["call_proxy"] = original_call_proxy
        globals()["POLL_INTERVAL_SECONDS"] = original_interval
        globals()["POLL_MAX_SECONDS"] = original_max

    result = response_message["result"]
    if not result.get("isError"):
        raise AssertionError("timeout did not return a tool error")
    if "did not finish" not in result["content"][0]["text"]:
        raise AssertionError("timeout error did not explain the timeout")


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        run_smoke_tests()
    else:
        main()
