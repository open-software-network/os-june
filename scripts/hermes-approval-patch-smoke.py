#!/usr/bin/env python3
"""Exercise June's patched Hermes approval protocol without provider credentials."""

import argparse
import hashlib
import importlib.util
from pathlib import Path
import sys
import threading
import time
import types


def load_approval(root: Path):
    hermes_cli = types.ModuleType("hermes_cli")
    config = types.ModuleType("hermes_cli.config")
    config.cfg_get = lambda data, *path, default=None: default
    config.load_config = lambda: {}
    config.save_config = lambda _data: None
    hermes_cli.config = config
    sys.modules["hermes_cli"] = hermes_cli
    sys.modules["hermes_cli.config"] = config

    utils = types.ModuleType("utils")
    utils.env_var_enabled = lambda _name: False
    utils.is_truthy_value = lambda value: str(value).lower() in {"1", "true", "yes"}
    sys.modules["utils"] = utils

    path = root / "tools" / "approval.py"
    if not path.is_file():
        raise RuntimeError("patched Hermes approval module is missing: %s" % path)
    spec = importlib.util.spec_from_file_location("june_patched_hermes_approval", str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load patched Hermes approval module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._get_approval_config = lambda: {"gateway_timeout": 5}
    module._fire_approval_hook = lambda *_args, **_kwargs: None
    return module


def wait_until(predicate, message: str) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(message)


def exercise(approval) -> None:
    session = "synthetic-session"
    notifications = []
    expirations = []
    results = []
    approval.register_gateway_notify(
        session,
        lambda data: notifications.append(data["request_id"]),
        lambda data: expirations.append((data["request_id"], data["reason"])),
    )

    def wait(label: str, request_id: str) -> None:
        result = approval._await_gateway_decision(
            session,
            lambda data: notifications.append(data["request_id"]),
            {"description": "Synthetic MCP approval", "request_id": request_id},
            surface="mcp-elicitation/synthetic",
            request_id=request_id,
        )
        results.append((label, result["choice"], result["resolved"]))

    threads = [
        threading.Thread(target=wait, args=("same-a", "mcp-stable-1")),
        threading.Thread(target=wait, args=("same-b", "mcp-stable-1")),
        threading.Thread(target=wait, args=("distinct", "mcp-stable-2")),
    ]
    for thread in threads:
        thread.start()

    def two_queued() -> bool:
        with approval._lock:
            return len(approval._gateway_queues.get(session, [])) == 2

    wait_until(two_queued, "duplicate requests did not converge to two logical queue entries")
    assert notifications == ["mcp-stable-1", "mcp-stable-2"], notifications
    assert approval.resolve_gateway_approval(
        session, "deny", request_id="mcp-stable-2"
    ) == 1
    assert approval.resolve_gateway_approval(
        session, "once", request_id="mcp-stable-1"
    ) == 1
    for thread in threads:
        thread.join(timeout=2)
        assert not thread.is_alive(), "targeted approval thread did not resolve"
    assert sorted(results) == [
        ("distinct", "deny", True),
        ("same-a", "once", True),
        ("same-b", "once", True),
    ], results

    replayed = approval._await_gateway_decision(
        session,
        lambda data: notifications.append(data["request_id"]),
        {"request_id": "mcp-stable-1"},
        request_id="mcp-stable-1",
    )
    assert replayed == {"resolved": True, "choice": "once", "replayed": True}, replayed
    assert notifications == ["mcp-stable-1", "mcp-stable-2"], notifications

    # Non-MCP command/code approvals do not have an upstream request id. The
    # gateway's existing observability context supplies stable per-tool-call
    # identity so duplicate delivery converges without merging distinct calls.
    command_session = "synthetic-command-session"
    command_notifications = []
    command_results = []
    approval.register_gateway_notify(
        command_session,
        lambda data: command_notifications.append(data["request_id"]),
    )

    def command_approval(label: str, tool_call_id: str) -> None:
        tokens = approval.set_current_observability_context(
            turn_id="synthetic-turn",
            tool_call_id=tool_call_id,
        )
        try:
            result = approval._await_gateway_decision(
                command_session,
                lambda data: command_notifications.append(data["request_id"]),
                {
                    "command": "synthetic-command",
                    "description": "Synthetic command approval",
                    "pattern_key": "synthetic_pattern",
                },
                surface="gateway",
            )
            command_results.append((label, result["choice"], result["resolved"]))
        finally:
            approval.reset_current_observability_context(tokens)

    command_threads = [
        threading.Thread(target=command_approval, args=("same-a", "tool-call-1")),
        threading.Thread(target=command_approval, args=("same-b", "tool-call-1")),
        threading.Thread(target=command_approval, args=("distinct", "tool-call-2")),
    ]
    for thread in command_threads:
        thread.start()

    def two_commands_queued() -> bool:
        with approval._lock:
            return len(approval._gateway_queues.get(command_session, [])) == 2

    wait_until(two_commands_queued, "non-MCP approvals lost stable tool-call identity")
    assert len(command_notifications) == 2, command_notifications
    assert len(set(command_notifications)) == 2, command_notifications

    def command_request_id(tool_call_id: str) -> str:
        identity = "\0".join(
            (
                "gateway",
                command_session,
                "synthetic-turn",
                tool_call_id,
                "synthetic-command",
                "Synthetic command approval",
                "synthetic_pattern",
                "synthetic_pattern",
            )
        )
        return "gateway-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]

    command_same = command_request_id("tool-call-1")
    command_distinct = command_request_id("tool-call-2")
    assert set(command_notifications) == {command_same, command_distinct}, command_notifications
    assert approval.resolve_gateway_approval(
        command_session, "once", request_id=command_same
    ) == 1
    assert approval.resolve_gateway_approval(
        command_session, "deny", request_id=command_distinct
    ) == 1
    for thread in command_threads:
        thread.join(timeout=2)
        assert not thread.is_alive(), "non-MCP approval thread did not resolve"
    assert sorted(choice for _, choice, _ in command_results) == ["deny", "once", "once"], (
        command_results
    )
    assert all(resolved for _, _, resolved in command_results), command_results

    # Exercise the MCP-facing entry point too. Exact duplicate delivery and a
    # reconnect retry converge, while separate requests on one live transport
    # remain independently addressable even when their prompt text matches.
    mcp_session = "synthetic-mcp-session"
    mcp_notifications = []
    mcp_results = []
    approval._is_gateway_approval_context = lambda: True
    approval.register_gateway_notify(
        mcp_session,
        lambda data: mcp_notifications.append(data["request_id"]),
    )

    def consent(label: str, upstream_request_id: int, upstream_transport_id: int) -> None:
        session_token = approval.set_current_session_key(mcp_session)
        tool_token = approval._approval_tool_call_id.set("synthetic-tool-call")
        try:
            result = approval.request_elicitation_consent(
                "Distinct permission" if label == "distinct" else "Synthetic permission",
                "Synthetic MCP approval",
                surface="mcp-elicitation/synthetic",
                upstream_request_id=upstream_request_id,
                upstream_transport_id=upstream_transport_id,
            )
            mcp_results.append((label, result))
        finally:
            approval._approval_tool_call_id.reset(tool_token)
            approval.reset_current_session_key(session_token)

    consent_threads = [
        threading.Thread(target=consent, args=("same-a", 41, 101)),
        threading.Thread(target=consent, args=("same-b", 41, 101)),
        threading.Thread(target=consent, args=("concurrent", 44, 101)),
        threading.Thread(target=consent, args=("distinct", 42, 101)),
    ]
    for thread in consent_threads:
        thread.start()

    def three_mcp_queued() -> bool:
        with approval._lock:
            return len(approval._gateway_queues.get(mcp_session, [])) == 3

    wait_until(three_mcp_queued, "MCP identities did not preserve three logical approvals")
    assert len(mcp_notifications) == 3, mcp_notifications
    assert len(set(mcp_notifications)) == 3, mcp_notifications
    request_41 = "mcp-" + hashlib.sha256(
        "\0".join(("mcp-elicitation/synthetic", "synthetic-tool-call", "41")).encode("utf-8")
    ).hexdigest()[:32]
    request_42 = "mcp-" + hashlib.sha256(
        "\0".join(("mcp-elicitation/synthetic", "synthetic-tool-call", "42")).encode("utf-8")
    ).hexdigest()[:32]
    request_43 = "mcp-" + hashlib.sha256(
        "\0".join(("mcp-elicitation/synthetic", "synthetic-tool-call", "43")).encode("utf-8")
    ).hexdigest()[:32]
    request_44 = "mcp-" + hashlib.sha256(
        "\0".join(("mcp-elicitation/synthetic", "synthetic-tool-call", "44")).encode("utf-8")
    ).hexdigest()[:32]
    assert set(mcp_notifications) == {request_41, request_42, request_44}, mcp_notifications

    retry_thread = threading.Thread(target=consent, args=("retry", 43, 202))
    consent_threads.append(retry_thread)
    retry_thread.start()

    def retry_joined_pending_request() -> bool:
        with approval._lock:
            return any(
                request_43 in entry.request_ids
                for entry in approval._gateway_queues.get(mcp_session, [])
            )

    wait_until(retry_joined_pending_request, "reconnect retry created no pending alias")
    assert three_mcp_queued(), "reconnect retry multiplied the MCP queue"
    assert set(mcp_notifications) == {request_41, request_42, request_44}, mcp_notifications
    approval._MAX_GATEWAY_APPROVAL_ALIASES = 2
    logical_identity = "\0".join(
        (
            "mcp-elicitation/synthetic",
            "synthetic-tool-call",
            "Synthetic permission",
            "Synthetic MCP approval",
        )
    )
    dedup_key = "mcp-logical-" + hashlib.sha256(logical_identity.encode("utf-8")).hexdigest()[:32]
    alias_overflow = approval._await_gateway_decision(
        mcp_session,
        lambda data: mcp_notifications.append(data["request_id"]),
        {"request_id": "mcp-alias-overflow"},
        request_id="mcp-alias-overflow",
        dedup_key=dedup_key,
        upstream_transport_id=303,
    )
    assert alias_overflow == {"resolved": False, "choice": None, "overflow": True}, (
        alias_overflow
    )
    approval._MAX_GATEWAY_APPROVAL_ALIASES = 16
    assert approval.resolve_gateway_approval(
        mcp_session, "once", request_id=request_41
    ) == 1
    assert approval.resolve_gateway_approval(
        mcp_session, "once", request_id=request_42
    ) == 1
    assert approval.resolve_gateway_approval(
        mcp_session, "deny", request_id=request_44
    ) == 1
    for thread in consent_threads:
        thread.join(timeout=2)
        assert not thread.is_alive(), "MCP approval thread did not resolve"
    assert sorted(result for _, result in mcp_results) == [
        "accept",
        "accept",
        "accept",
        "accept",
        "decline",
    ], mcp_results
    with approval._lock:
        assert approval._gateway_completed[mcp_session][request_43] == {"choice": "once"}

    approval._get_approval_config = lambda: {"gateway_timeout": 0}
    timed_out = approval._await_gateway_decision(
        session,
        lambda data: notifications.append(data["request_id"]),
        {"request_id": "mcp-timeout"},
        request_id="mcp-timeout",
    )
    assert timed_out["resolved"] is False, timed_out
    assert expirations == [("mcp-timeout", "timeout")], expirations

    malformed = approval._await_gateway_decision(session, lambda _data: None, {})
    assert malformed["malformed"] is True and malformed["resolved"] is False, malformed

    approval._get_approval_config = lambda: {"gateway_timeout": 5}
    approval._MAX_GATEWAY_APPROVALS_PER_SESSION = 2
    disconnect_results = []

    def wait_for_disconnect(request_id: str) -> None:
        result = approval._await_gateway_decision(
            session,
            lambda data: notifications.append(data["request_id"]),
            {"request_id": request_id},
            request_id=request_id,
        )
        disconnect_results.append(result)

    blocked = [
        threading.Thread(target=wait_for_disconnect, args=("mcp-blocked-1",)),
        threading.Thread(target=wait_for_disconnect, args=("mcp-blocked-2",)),
    ]
    for thread in blocked:
        thread.start()
    wait_until(two_queued, "bounded approval queue did not reach its expected size")
    overflow = approval._await_gateway_decision(
        session,
        lambda data: notifications.append(data["request_id"]),
        {"request_id": "mcp-overflow"},
        request_id="mcp-overflow",
    )
    assert overflow == {"resolved": False, "choice": None, "overflow": True}, overflow
    approval.unregister_gateway_notify(session)
    for thread in blocked:
        thread.join(timeout=2)
        assert not thread.is_alive(), "disconnect did not drain a blocked approval"
    assert all(
        result["resolved"] is False and result["reason"] == "disconnect"
        for result in disconnect_results
    ), disconnect_results
    with approval._lock:
        assert not approval._gateway_queues.get(session), "disconnect left queued approvals"
    replay_notifications = []
    approval.register_gateway_notify(
        session,
        lambda data: replay_notifications.append(data["request_id"]),
    )
    disconnected_replay = approval._await_gateway_decision(
        session,
        lambda data: replay_notifications.append(data["request_id"]),
        {"request_id": "mcp-blocked-1"},
        request_id="mcp-blocked-1",
    )
    assert disconnected_replay == {
        "resolved": False,
        "choice": None,
        "replayed": True,
    }, disconnected_replay
    assert replay_notifications == [], replay_notifications

    # Repeated reconnect/session ids cannot grow tombstone bookkeeping without
    # bound even when each session leaves a completed request behind.
    approval._MAX_COMPLETED_GATEWAY_SESSIONS = 2
    with approval._lock:
        approval._gateway_completed.clear()
        approval._remember_gateway_completion_locked("old-session", "request-1", None)
        approval._remember_gateway_completion_locked("new-session", "request-2", None)
        approval._remember_gateway_completion_locked("newest-session", "request-3", None)
        assert set(approval._gateway_completed) == {"new-session", "newest-session"}, (
            approval._gateway_completed
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="Patched hermes-agent source root")
    args = parser.parse_args()
    try:
        exercise(load_approval(args.root.resolve()))
    except Exception as exc:
        print("patched Hermes approval protocol: FAIL: %s" % exc, file=sys.stderr)
        return 1
    print("patched Hermes approval protocol: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
