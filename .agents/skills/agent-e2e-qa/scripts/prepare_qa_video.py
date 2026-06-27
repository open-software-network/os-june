#!/usr/bin/env python3
"""Compress, upload, and optionally PR-comment a QA walkthrough video."""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import pathlib
import shutil
import subprocess
import sys
from urllib.parse import urlparse

DEFAULT_MAX_BYTES = 300 * 1024 * 1024
DEFAULT_API_BASE_URL = "https://app.opensoftware.co/api"
ENV_KEY_NAMES = ("OS_PLATFORM_API_KEY", "SCRIBE__ISSUE_REPORTS__OS_PLATFORM_API_KEY")


def parse_size(raw: str) -> int:
    text = raw.strip().lower().replace("_", "")
    suffixes = {
        "gib": 1024 * 1024 * 1024,
        "gb": 1000 * 1000 * 1000,
        "mib": 1024 * 1024,
        "mb": 1000 * 1000,
        "kib": 1024,
        "kb": 1000,
    }
    for suffix, multiplier in suffixes.items():
        if text.endswith(suffix):
            return int(float(text[: -len(suffix)]) * multiplier)
    return int(text)


def human_size(num_bytes: int) -> str:
    value = float(num_bytes)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} {unit}"
        value /= 1024
    return f"{num_bytes} B"


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def binary_candidates(name: str) -> list[str]:
    candidates = [
        shutil.which(name),
        f"/opt/homebrew/bin/{name}",
        f"/usr/local/bin/{name}",
    ]
    deduped = []
    for candidate in candidates:
        if candidate and candidate not in deduped:
            deduped.append(candidate)
    return deduped


def find_working_binary(name: str) -> str | None:
    for candidate in binary_candidates(name):
        result = run([candidate, "-version"])
        if result.returncode == 0:
            return candidate
    return None


def ffprobe_duration(path: pathlib.Path) -> float | None:
    ffprobe = find_working_binary("ffprobe")
    if ffprobe is None:
        return None
    result = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    if result.returncode != 0:
        return None
    try:
        duration = float(result.stdout.strip())
    except ValueError:
        return None
    return duration if duration > 0 else None


def choose_bitrate_kbps(
    duration_seconds: float | None,
    max_bytes: int,
    requested: int | None,
    min_bitrate: int,
    max_bitrate: int,
) -> int:
    if requested is not None:
        return requested
    if duration_seconds is None:
        return max_bitrate
    reserved_bits = max_bytes * 8 * 0.85
    target = math.floor(reserved_bits / duration_seconds / 1000)
    return max(min_bitrate, min(max_bitrate, target))


def default_output_path(input_path: pathlib.Path) -> pathlib.Path:
    return input_path.with_name(f"{input_path.stem}.compressed.mp4")


def compress_video(args: argparse.Namespace) -> pathlib.Path:
    ffmpeg = find_working_binary("ffmpeg")
    if ffmpeg is None:
        raise SystemExit("ffmpeg is required to compress QA recordings")

    input_path = args.input.resolve()
    if not input_path.is_file():
        raise SystemExit(f"input video does not exist: {input_path}")

    output_path = (args.output or default_output_path(input_path)).resolve()
    if output_path == input_path:
        raise SystemExit("output path must differ from input path")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    duration = ffprobe_duration(input_path)
    bitrate = choose_bitrate_kbps(
        duration,
        args.max_bytes,
        args.bitrate_kbps,
        args.min_bitrate_kbps,
        args.max_bitrate_kbps,
    )
    maxrate = max(bitrate, math.ceil(bitrate * 1.25))
    bufsize = max(bitrate, bitrate * 2)
    video_filter = f"scale=w='min({args.width},iw)':h=-2,fps={args.fps}"

    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-vf",
        video_filter,
        "-c:v",
        "libx264",
        "-preset",
        args.preset,
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        f"{bitrate}k",
        "-maxrate",
        f"{maxrate}k",
        "-bufsize",
        f"{bufsize}k",
        "-an",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    result = run(command)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "ffmpeg failed")

    size = output_path.stat().st_size
    if size > args.max_bytes:
        raise SystemExit(
            "compressed video is "
            f"{human_size(size)}, over the {human_size(args.max_bytes)} cap. "
            "Use a shorter clip, lower --min-bitrate-kbps, or split the run."
        )

    print(f"compressed_path={output_path}")
    print(f"compressed_size={human_size(size)}")
    print(f"video_bitrate_kbps={bitrate}")
    if duration is not None:
        print(f"duration_seconds={duration:.1f}")
    return output_path


def repo_root() -> pathlib.Path:
    result = run(["git", "rev-parse", "--show-toplevel"])
    if result.returncode == 0:
        return pathlib.Path(result.stdout.strip())
    return pathlib.Path.cwd()


def unquote_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def load_os_platform_key(root: pathlib.Path) -> str | None:
    for name in ENV_KEY_NAMES:
        value = os.environ.get(name)
        if value:
            return value.strip()

    env_file = root / "scribe-api" / ".env"
    if not env_file.exists():
        return None

    for line in env_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() in ENV_KEY_NAMES:
            return unquote_env_value(value)
    return None


def absolute_download_url(base_url: str, download_url: str) -> str:
    parsed_download = urlparse(download_url)
    if parsed_download.scheme and parsed_download.netloc:
        return download_url

    base = base_url.rstrip("/")
    parsed_base = urlparse(base)
    origin = f"{parsed_base.scheme}://{parsed_base.netloc}"

    if download_url.startswith("/v1/"):
        return f"{base}{download_url}"
    if download_url.startswith("/api/"):
        return f"{origin}{download_url}"
    if download_url.startswith("/"):
        return f"{origin}{download_url}"
    return f"{base}/{download_url}"


def upload_video(path: pathlib.Path, args: argparse.Namespace, root: pathlib.Path) -> str:
    if args.visibility == "public" and not args.confirm_public:
        raise SystemExit(
            "public os-platform uploads are downloadable by anyone with the URL. "
            "Pass --confirm-public only after the QA charter allows PR sharing."
        )

    api_key = load_os_platform_key(root)
    if not api_key:
        names = " or ".join(ENV_KEY_NAMES)
        raise SystemExit(f"set {names} before uploading QA video artifacts")

    base_url = args.api_base_url.rstrip("/")
    endpoint = f"{base_url}/v1/files"
    content_type = mimetypes.guess_type(path.name)[0] or "video/mp4"
    is_public = "true" if args.visibility == "public" else "false"
    result = run(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            endpoint,
            "-H",
            f"Authorization: Bearer {api_key}",
            "-F",
            f"file=@{path};type={content_type};filename={path.name}",
            "-F",
            f"is_public={is_public}",
            "-F",
            "purpose=attachment",
        ]
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "curl upload failed")

    try:
        envelope = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"os-platform returned non-JSON response: {exc}") from exc

    if not envelope.get("success"):
        message = envelope.get("message") or "upload failed"
        raise SystemExit(f"os-platform upload failed: {message}")

    data = envelope.get("data") or {}
    download_url = data.get("download_url")
    if not isinstance(download_url, str) or not download_url:
        raise SystemExit("os-platform upload response did not include download_url")

    url = absolute_download_url(base_url, download_url)
    print(f"upload_url={url}")
    return url


def comment_on_pr(url: str, path: pathlib.Path, args: argparse.Namespace) -> None:
    if not args.comment_pr:
        return
    if shutil.which("gh") is None:
        raise SystemExit("gh is required to comment on the PR")

    body = (
        "QA video artifact\n\n"
        f"- Video: {url}\n"
        f"- Local compressed file: `{path}` ({human_size(path.stat().st_size)})"
    )
    command = ["gh", "pr", "comment", str(args.comment_pr), "--body", body]
    if args.github_repo:
        command.extend(["--repo", args.github_repo])
    result = run(command)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "gh pr comment failed")
    print(f"pr_comment=posted:{args.comment_pr}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=pathlib.Path, help="Raw .mov or other QA recording")
    parser.add_argument("--output", type=pathlib.Path, help="Compressed MP4 output path")
    parser.add_argument(
        "--max-bytes",
        type=parse_size,
        default=parse_size(os.environ.get("QA_VIDEO_MAX_BYTES", str(DEFAULT_MAX_BYTES))),
        help="Maximum compressed artifact size, default 300 MiB",
    )
    parser.add_argument("--fps", type=int, default=10, help="Output frame rate")
    parser.add_argument("--width", type=int, default=1280, help="Maximum output width")
    parser.add_argument("--preset", default="veryfast", help="ffmpeg x264 preset")
    parser.add_argument("--bitrate-kbps", type=int, help="Fixed target video bitrate")
    parser.add_argument("--min-bitrate-kbps", type=int, default=250)
    parser.add_argument("--max-bitrate-kbps", type=int, default=1200)
    parser.add_argument("--upload", action="store_true", help="Upload compressed file to os-platform")
    parser.add_argument(
        "--api-base-url",
        default=os.environ.get("OS_PLATFORM_API_BASE_URL", DEFAULT_API_BASE_URL),
    )
    parser.add_argument("--visibility", choices=("public", "private"), default="public")
    parser.add_argument(
        "--confirm-public",
        action="store_true",
        help="Acknowledge public URL sharing when --upload uses public visibility",
    )
    parser.add_argument("--comment-pr", type=int, help="Comment the upload URL on this PR number")
    parser.add_argument("--github-repo", help="GitHub owner/repo for PR comments")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.min_bitrate_kbps > args.max_bitrate_kbps:
        raise SystemExit("--min-bitrate-kbps must be <= --max-bitrate-kbps")
    if args.comment_pr and not args.upload:
        raise SystemExit("--comment-pr requires --upload")
    if args.upload and args.visibility == "public" and not args.confirm_public:
        raise SystemExit(
            "public os-platform uploads are downloadable by anyone with the URL. "
            "Pass --confirm-public only after the QA charter allows PR sharing."
        )

    root = repo_root()
    compressed = compress_video(args)
    if args.upload:
        url = upload_video(compressed, args, root)
        comment_on_pr(url, compressed, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
