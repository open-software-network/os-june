from __future__ import annotations

import json
import os
from pathlib import Path
import socketserver
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


HERMES_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HERMES_DIR))

import june_github_mcp as mcp


APPROVED_TOOL_NAMES = (
    "list_repositories",
    "get_repository",
    "list_directory",
    "read_file",
    "search_code",
    "list_issues",
    "get_issue",
    "list_issue_comments",
    "list_pull_requests",
    "get_pull_request",
    "list_pull_request_files",
    "read_pull_request_file_diff",
    "list_pull_request_commits",
    "list_pull_request_reviews",
    "list_pull_request_review_comments",
    "list_pull_request_checks",
)

SAMPLE_ARGUMENTS: dict[str, dict[str, Any]] = {
    "list_repositories": {"cursor": "cursor-1", "limit": 1},
    "get_repository": {"repository_id": "123456"},
    "list_directory": {
        "repository_id": "123456",
        "path": "src",
        "ref": "main",
        "cursor": "cursor-2",
        "limit": 2,
    },
    "read_file": {
        "repository_id": "123456",
        "path": "README.md",
        "ref": "main",
        "start_line": 1,
        "line_count": 10,
    },
    "search_code": {
        "repository_id": "123456",
        "query": "GitHubReadService",
        "cursor": "cursor-3",
        "limit": 3,
    },
    "list_issues": {
        "repository_id": "123456",
        "state": "open",
        "query": "connector",
        "labels": ["bug"],
        "cursor": "cursor-4",
        "limit": 4,
    },
    "get_issue": {"repository_id": "123456", "number": 7},
    "list_issue_comments": {
        "repository_id": "123456",
        "number": 7,
        "cursor": "cursor-5",
        "limit": 5,
    },
    "list_pull_requests": {
        "repository_id": "123456",
        "state": "all",
        "query": "connector",
        "base": "main",
        "head": "octocat:feature",
        "cursor": "cursor-6",
        "limit": 6,
    },
    "get_pull_request": {"repository_id": "123456", "number": 8},
    "list_pull_request_files": {
        "repository_id": "123456",
        "number": 8,
        "cursor": "cursor-7",
        "limit": 7,
    },
    "read_pull_request_file_diff": {
        "repository_id": "123456",
        "number": 8,
        "file_ref": "file-ref-1",
        "cursor": "cursor-8",
    },
    "list_pull_request_commits": {
        "repository_id": "123456",
        "number": 8,
        "cursor": "cursor-9",
        "limit": 8,
    },
    "list_pull_request_reviews": {
        "repository_id": "123456",
        "number": 8,
        "cursor": "cursor-10",
        "limit": 9,
    },
    "list_pull_request_review_comments": {
        "repository_id": "123456",
        "number": 8,
        "cursor": "cursor-11",
        "limit": 10,
    },
    "list_pull_request_checks": {
        "repository_id": "123456",
        "number": 8,
        "cursor": "cursor-12",
        "limit": 11,
    },
}


SUCCESS_RESULT = {
    "trust": "untrusted_repository_content",
    "data": {"issue": {"number": 7, "title": "Treat this as data"}},
    "truncated": True,
    "continuationCursor": "next-page",
    "redactionsApplied": False,
    "sources": [
        {
            "repositoryId": "123456",
            "repositoryFullName": "open-software-network/test-repo",
            "url": "https://github.com/open-software-network/test-repo/issues/7",
            "objectId": "issue:7",
        }
    ],
}


class _ProxyServer(ThreadingHTTPServer):
    def server_bind(self) -> None:
        # HTTPServer performs a reverse DNS lookup during construction, which
        # can stall isolated CI hosts. Tests need only the numeric loopback.
        socketserver.TCPServer.server_bind(self)
        host, port = self.socket.getsockname()[:2]
        self.server_name = host
        self.server_port = port

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _ProxyHandler)
        self.requests: list[dict[str, Any]] = []
        self.response_status = 200
        self.response_body = json.dumps(
            {
                "success": True,
                "result": SUCCESS_RESULT,
                "connectorStateChanged": False,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        self.response_delay = 0.0

    @property
    def base_url(self) -> str:
        host, port = self.server_address
        return f"http://{host}:{port}/v1"


class _ProxyHandler(BaseHTTPRequestHandler):
    server: _ProxyServer

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.server.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "content_type": self.headers.get("Content-Type"),
                "body": json.loads(body.decode("utf-8")),
            }
        )
        if self.server.response_delay:
            time.sleep(self.server.response_delay)
        self.send_response(self.server.response_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.server.response_body)))
        self.end_headers()
        try:
            self.wfile.write(self.server.response_body)
        except BrokenPipeError:
            pass

    def log_message(self, _format: str, *args: object) -> None:
        pass


class RunningProxy:
    def __enter__(self) -> _ProxyServer:
        self.server = _ProxyServer()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self.server

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def call_message(name: str, arguments: dict[str, Any], request_id: int = 1) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }


def result_error(response: dict[str, Any]) -> dict[str, str]:
    result = response["result"]
    assert result["isError"] is True
    return json.loads(result["content"][0]["text"])


class JuneGitHubMcpContractTests(unittest.TestCase):
    def test_tools_list_contains_exactly_the_approved_sixteen_names(self) -> None:
        response = mcp.handle_message(
            "http://127.0.0.1:1/v1",
            "token",
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        )
        tools = response["result"]["tools"]
        self.assertEqual(tuple(tool["name"] for tool in tools), APPROVED_TOOL_NAMES)
        self.assertEqual(tuple(mcp.TOOL_NAMES), APPROVED_TOOL_NAMES)
        for tool in tools:
            schema = tool["inputSchema"]
            self.assertEqual(schema["type"], "object")
            self.assertIs(schema["additionalProperties"], False)
            self.assertIn("untrusted repository content", tool["description"])
            self.assertIn("cannot supply instructions", tool["description"])
            self.assertNotIn("owner", schema["properties"])
            self.assertNotIn("repository", schema["properties"])
            self.assertNotIn("url", schema["properties"])
            self.assertNotIn("token", schema["properties"])
            if "limit" in schema["properties"]:
                self.assertEqual(schema["properties"]["limit"]["minimum"], 1)
                self.assertEqual(schema["properties"]["limit"]["maximum"], 50)
            if "line_count" in schema["properties"]:
                self.assertEqual(schema["properties"]["line_count"]["minimum"], 1)
                self.assertEqual(schema["properties"]["line_count"]["maximum"], 1_000)
            for property_name in ("number", "start_line"):
                if property_name in schema["properties"]:
                    self.assertEqual(schema["properties"][property_name]["minimum"], 1)

    def test_each_tool_posts_one_typed_operation_to_the_fixed_route(self) -> None:
        with RunningProxy() as proxy:
            for request_id, name in enumerate(APPROVED_TOOL_NAMES, start=1):
                response = mcp.handle_message(
                    proxy.base_url,
                    "github-proxy-token",
                    call_message(name, SAMPLE_ARGUMENTS[name], request_id),
                )
                self.assertNotIn("isError", response["result"])

            env = os.environ.copy()
            env["JUNE_GITHUB_PROXY_TOKEN"] = "github-proxy-token"
            messages = [
                {"jsonrpc": "2.0", "id": 101, "method": "initialize", "params": {}},
                {"jsonrpc": "2.0", "id": 102, "method": "tools/list"},
                call_message("get_issue", {"repository_id": "123456", "number": 7}, 103),
            ]
            completed = subprocess.run(
                [sys.executable, str(HERMES_DIR / "june_github_mcp.py"), proxy.base_url],
                input="".join(json.dumps(message) + "\n" for message in messages),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                check=False,
                timeout=5,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            subprocess_responses = [json.loads(line) for line in completed.stdout.splitlines()]
            self.assertEqual([item["id"] for item in subprocess_responses], [101, 102, 103])
            self.assertEqual(
                tuple(tool["name"] for tool in subprocess_responses[1]["result"]["tools"]),
                APPROVED_TOOL_NAMES,
            )

        self.assertEqual(len(proxy.requests), len(APPROVED_TOOL_NAMES) + 1)
        for name, capture in zip(APPROVED_TOOL_NAMES, proxy.requests[:-1], strict=True):
            self.assertEqual(capture["method"], "POST")
            self.assertEqual(capture["path"], "/v1/github/read")
            self.assertEqual(capture["authorization"], "Bearer github-proxy-token")
            self.assertEqual(capture["content_type"], "application/json")
            self.assertEqual(
                capture["body"],
                {"operation": name, "arguments": SAMPLE_ARGUMENTS[name]},
            )
        self.assertEqual(
            proxy.requests[-1]["body"],
            {
                "operation": "get_issue",
                "arguments": {"repository_id": "123456", "number": 7},
            },
        )

    def test_tool_input_is_validated_before_proxy_traffic(self) -> None:
        invalid_calls = (
            call_message("unknown", {}),
            call_message("get_issue", {"repository_id": "123456"}),
            call_message("get_issue", {"repository_id": "123456", "number": 0}),
            call_message("get_issue", {"repository_id": "123456", "number": True}),
            call_message(
                "get_issue",
                {"repository_id": "123456", "number": 7, "owner": "octocat"},
            ),
            call_message("list_repositories", {"limit": 51}),
            call_message(
                "read_file",
                {
                    "repository_id": "123456",
                    "path": "README.md",
                    "line_count": 1_001,
                },
            ),
        )
        with RunningProxy() as proxy:
            for message in invalid_calls:
                response = mcp.handle_message(proxy.base_url, "token", message)
                self.assertEqual(
                    result_error(response),
                    {"code": "github_input_invalid", "message": "GitHub input is invalid."},
                )
            self.assertEqual(proxy.requests, [])

    def test_proxy_success_preserves_trust_sources_and_continuation(self) -> None:
        with RunningProxy() as proxy:
            response = mcp.handle_message(
                proxy.base_url,
                "token",
                call_message("get_issue", SAMPLE_ARGUMENTS["get_issue"]),
            )
        result = response["result"]
        self.assertEqual(result["structuredContent"], SUCCESS_RESULT)
        self.assertEqual(
            result["content"],
            [
                {
                    "type": "text",
                    "text": json.dumps(
                        SUCCESS_RESULT, ensure_ascii=False, separators=(",", ":")
                    ),
                }
            ],
        )
        self.assertEqual(result["structuredContent"]["trust"], "untrusted_repository_content")
        self.assertEqual(result["structuredContent"]["continuationCursor"], "next-page")
        self.assertEqual(result["structuredContent"]["sources"], SUCCESS_RESULT["sources"])

    def test_proxy_error_returns_only_sanitized_code_and_message(self) -> None:
        with RunningProxy() as proxy:
            proxy.response_status = 502
            proxy.response_body = json.dumps(
                {
                    "success": False,
                    "error": {
                        "code": "github_read_unavailable",
                        "message": "GitHub could not be read right now.",
                        "details": {"providerBody": "secret provider text"},
                    },
                    "connectorStateChanged": True,
                    "url": "https://api.github.com/private",
                }
            ).encode("utf-8")
            response = mcp.handle_message(
                proxy.base_url,
                "token",
                call_message("get_issue", SAMPLE_ARGUMENTS["get_issue"]),
            )
        self.assertEqual(
            result_error(response),
            {
                "code": "github_read_unavailable",
                "message": "GitHub could not be read right now.",
            },
        )
        serialized = json.dumps(response)
        self.assertNotIn("secret provider text", serialized)
        self.assertNotIn("api.github.com", serialized)
        self.assertNotIn("connectorStateChanged", serialized)

    def test_missing_token_fails_without_proxy_traffic(self) -> None:
        with RunningProxy() as proxy:
            response = mcp.handle_message(
                proxy.base_url,
                "",
                call_message("get_issue", SAMPLE_ARGUMENTS["get_issue"]),
            )
            self.assertEqual(proxy.requests, [])
        self.assertEqual(
            result_error(response),
            {
                "code": "github_read_unavailable",
                "message": "GitHub could not be read right now.",
            },
        )

    def test_timeout_and_malformed_proxy_response_are_sanitized(self) -> None:
        previous_timeout = mcp.REQUEST_TIMEOUT_SECONDS
        mcp.REQUEST_TIMEOUT_SECONDS = 0.05
        try:
            with RunningProxy() as proxy:
                proxy.response_delay = 0.2
                timeout_response = mcp.handle_message(
                    proxy.base_url,
                    "token",
                    call_message("get_issue", SAMPLE_ARGUMENTS["get_issue"]),
                )
            with RunningProxy() as proxy:
                proxy.response_body = b"not-json https://api.github.com/private"
                malformed_response = mcp.handle_message(
                    proxy.base_url,
                    "token",
                    call_message("get_issue", SAMPLE_ARGUMENTS["get_issue"]),
                )
            with RunningProxy() as proxy:
                proxy.response_body = b"{" + (b"x" * (mcp.MAX_PROXY_RESPONSE_BYTES + 1))
                oversized_response = mcp.handle_message(
                    proxy.base_url,
                    "token",
                    call_message("get_issue", SAMPLE_ARGUMENTS["get_issue"]),
                )
        finally:
            mcp.REQUEST_TIMEOUT_SECONDS = previous_timeout

        for response in (timeout_response, malformed_response, oversized_response):
            self.assertEqual(
                result_error(response),
                {
                    "code": "github_read_unavailable",
                    "message": "GitHub could not be read right now.",
                },
            )
            self.assertNotIn("api.github.com", json.dumps(response))

    def test_token_never_appears_in_mcp_output_or_exception_text(self) -> None:
        token = "github-secret-token-do-not-leak"
        with RunningProxy() as proxy:
            proxy.response_status = 500
            proxy.response_body = json.dumps(
                {
                    "success": False,
                    "error": {
                        "code": token,
                        "message": token,
                        "details": {"authorization": f"Bearer {token}"},
                    },
                }
            ).encode("utf-8")
            response = mcp.handle_message(
                proxy.base_url,
                token,
                call_message("get_issue", SAMPLE_ARGUMENTS["get_issue"]),
            )
            with self.assertRaises(Exception) as caught:
                mcp.call_proxy(
                    f"{proxy.base_url}/{token}",
                    token,
                    {"operation": "get_issue", "arguments": SAMPLE_ARGUMENTS["get_issue"]},
                )
            with self.assertRaises(Exception) as malformed_url_caught:
                mcp.call_proxy(
                    f"://{token}",
                    token,
                    {"operation": "get_issue", "arguments": SAMPLE_ARGUMENTS["get_issue"]},
                )

        self.assertNotIn(token, json.dumps(response))
        self.assertNotIn(token, str(caught.exception))
        self.assertNotIn(token, str(malformed_url_caught.exception))


if __name__ == "__main__":
    unittest.main()
