#!/usr/bin/env python3
"""Exercise June's patched Hermes approval protocol without provider credentials."""

import argparse
import ast
import concurrent.futures
import contextvars
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import threading
import time
import types


def load_server_handoff_helpers(root: Path):
    """Load only the patched server's pure handoff helpers, without starting Hermes."""
    path = root / "tui_gateway" / "server.py"
    if not path.is_file():
        raise RuntimeError("patched Hermes gateway server is missing: %s" % path)
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    wanted = {
        "_agent_run_continuation_waits_for_snapshot_ack",
        "_bind_prompt_transport_for_submit",
        "_clear_pending_message_complete",
        "_close_sessions_for_transport",
        "_clear_inflight_turn",
        "_coerce_message_text",
        "_content_bearing_assistant_texts",
        "_defer_goal_followup",
        "_deliver_message_complete",
        "dispatch",
        "_emit",
        "_history_to_messages",
        "_handoff_live_session_transport",
        "_inflight_snapshot",
        "_live_session_payload",
        "_mark_pending_message_complete",
        "_message_complete_is_pending",
        "_pending_message_complete_proof",
        "_release_agent_run_continuations_after_snapshot_ack",
        "_reap_idle_sessions",
        "_retry_pending_message_complete",
        "_retry_pending_message_complete_locked",
        "_start_inflight_turn",
        "_take_deferred_goal_followup",
        "_transport_is_dead",
    }
    selected = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted
    ]
    observed = {node.name for node in selected}
    if observed != wanted:
        raise RuntimeError(
            "patched Hermes gateway helpers missing: %s" % sorted(wanted - observed)
        )
    namespace = {
        "Any": object,
        "Transport": object,
        "_LONG_HANDLERS": frozenset({"session.resume"}),
        "_LIVE_SNAPSHOT_HANDLERS": frozenset(
            {"session.activate", "session.resume"}
        ),
        "_ORDERED_SESSION_OWNERSHIP_HANDLERS": frozenset(
            {"prompt.submit", "session.activate", "session.resume"}
        ),
        "_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER": (
            "_june_agent_run_continuation_snapshot_ack_barrier"
        ),
        "_DEFERRED_GOAL_FOLLOWUP": "_june_deferred_goal_followup",
        "_LIVE_SNAPSHOT_ACK_TOKEN_RESULT": "_june_live_snapshot_ack_token",
        "_PENDING_MESSAGE_COMPLETE_PAYLOAD": "_june_pending_message_complete_payload",
        "_PENDING_MESSAGE_COMPLETE_TEXT": "_june_pending_message_complete_text",
        "_fallback_session_info": lambda _session: {},
        "_inflight_text": lambda value: str(value).strip(),
        "_session_live_status": lambda _sid, session: (
            "working" if session.get("running") else "idle"
        ),
        "_sessions": {},
        "_sessions_lock": threading.RLock(),
        "_session_resume_lock": threading.Lock(),
        "_stdio_transport": None,
        "_detached_ws_transport": object(),
        "_live_snapshot_pool": None,
        "_pool": None,
        "_tool_ctx": lambda _name, _args: {},
        "_close_session_by_id": lambda _sid, **_kwargs: False,
        "_normalize_request": lambda req: (
            req.get("id"),
            req.get("method"),
            req.get("params") or {},
        ),
        "bind_transport": lambda transport: transport,
        "handle_request": lambda _req: None,
        "reset_transport": lambda _token: None,
        "current_transport": lambda: None,
        "contextvars": contextvars,
        "json": json,
        "_schedule_ws_orphan_reap": lambda _sid: None,
        "_session_is_evictable": lambda _sid, _session, _now: False,
        "time": time,
        "write_json": lambda _frame: None,
    }
    module = ast.Module(
        body=[
            ast.ImportFrom(
                module="__future__",
                names=[ast.alias(name="annotations", asname=None)],
                level=0,
            ),
            *selected,
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    exec(compile(module, str(path), "exec"), namespace)
    return namespace


def assert_server_handoff_source(root: Path) -> None:
    """Keep retained completion retry and Agent run continuation ordering sealed."""
    source = (root / "tui_gateway" / "server.py").read_text(encoding="utf-8")
    long_handlers_start = source.index("_LONG_HANDLERS = frozenset(")
    long_handlers_end = source.index("\n\ntry:", long_handlers_start)
    long_handlers = source[long_handlers_start:long_handlers_end]
    assert '"session.activate"' not in long_handlers, long_handlers
    ordered_handlers_start = source.index("_LIVE_SNAPSHOT_HANDLERS = frozenset(")
    ordered_handlers_end = source.index("\n\n# Reserve real stdout", ordered_handlers_start)
    ordered_handlers = source[ordered_handlers_start:ordered_handlers_end]
    assert '"session.activate"' in ordered_handlers, ordered_handlers
    assert '"session.resume"' in ordered_handlers, ordered_handlers
    assert '"prompt.submit"' in ordered_handlers, ordered_handlers
    assert "_live_snapshot_pool = concurrent.futures.ThreadPoolExecutor(" in ordered_handlers
    assert "max_workers=1" in ordered_handlers, ordered_handlers

    shared_start = source.index("def _handoff_live_session_transport(")
    shared_end = source.index('\n@method("session.active_list")', shared_start)
    shared_handoff = source[shared_start:shared_end]
    dead_guard = shared_handoff.find("if _transport_is_dead(transport):")
    snapshot = shared_handoff.find("payload = _live_session_payload(")
    barrier_arm = shared_handoff.find(
        "agent_run_continuation_snapshot_ack_transport=transport"
    )
    token_capture = shared_handoff.find("snapshot_ack_token = payload.get(")
    notifier = shared_handoff.find("replace_gateway_notify(")
    retry = shared_handoff.find("_retry_pending_message_complete(")
    ordered_retry = shared_handoff.find("snapshot_ack_token=snapshot_ack_token")
    response = shared_handoff.find('payload["retired_approval_request_ids"]')
    assert retry >= 0, "live handoff does not retry a retained message.complete"
    assert (
        dead_guard
        < snapshot
        < barrier_arm
        < token_capture
        < notifier
        < retry
        < ordered_retry
        < response
    ), shared_handoff

    start = source.index("    def _reuse_live_payload(sid: str, session: dict) -> dict:")
    end = source.index("\n    # Fast path: if the session is already live", start)
    handoff = source[start:end]
    shared_call = handoff.find("payload = _handoff_live_session_transport(")
    captured_transport = handoff.find("resume_transport", shared_call)
    response = handoff.find('payload["resumed"] = target')
    assert 0 <= shared_call < captured_transport < response, handoff

    live_start = source.index("def _live_session_payload(")
    live_end = source.index("\ndef _handoff_live_session_transport(", live_start)
    live_payload = source[live_start:live_end]
    live_lock = live_payload.find('with session["history_lock"]:')
    guarded_swap = live_payload.find(
        "cannot replace transport while a live snapshot acknowledgement is pending"
    )
    transport_swap = live_payload.find('session["transport"] = transport')
    atomic_arm = live_payload.find(
        "session[_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER] = snapshot_ack_token"
    )
    history_snapshot = live_payload.find("history = list(")
    assert live_lock < guarded_swap < transport_swap < atomic_arm < history_snapshot, live_payload

    activate_start = source.index('@method("session.activate")')
    activate_end = source.index('\n@method("session.delete")', activate_start)
    activate = source[activate_start:activate_end]
    assert "activate_transport = current_transport() or _stdio_transport" in activate, activate
    activate_lock = activate.find("with _session_resume_lock:")
    registry_read = activate.find("session = _sessions.get(sid)")
    finalized_guard = activate.find('session.get("_finalized")')
    activate_handoff = activate.find("payload = _handoff_live_session_transport(")
    assert 0 <= activate_lock < registry_read < finalized_guard < activate_handoff, activate

    dispatch_start = source.index("def dispatch(")
    dispatch_end = source.index("\ndef _wait_agent", dispatch_start)
    dispatch = source[dispatch_start:dispatch_end]
    ordered_branch = dispatch.find("method not in _ORDERED_SESSION_OWNERSHIP_HANDLERS")
    pool_select = dispatch.find("if method in _ORDERED_SESSION_OWNERSHIP_HANDLERS")
    prompt_wait = dispatch.find('if method == "prompt.submit":')
    future_wait = dispatch.find("dispatched.result()")
    token_pop = dispatch.find("_LIVE_SNAPSHOT_ACK_TOKEN_RESULT, None")
    ack_write = dispatch.find("snapshot_ack_delivered = t.write(resp)")
    goal_release = dispatch.find("_release_agent_run_continuations_after_snapshot_ack(")
    assert ack_write >= 0, "live session snapshot acknowledgement is not observed"
    assert '"session.activate"' in dispatch and '"session.resume"' in dispatch, dispatch
    assert 0 <= ordered_branch < pool_select < prompt_wait < future_wait, dispatch
    assert token_pop < ack_write < goal_release, dispatch

    close_start = source.index("def _close_sessions_for_transport(")
    close_end = source.index("\ndef _shutdown_sessions", close_start)
    close_handoff = source[close_start:close_end]
    close_lock = close_handoff.find("with _session_resume_lock:")
    owned_snapshot = close_handoff.find("for sid, session in _sessions.items()")
    detach = close_handoff.find('session["transport"] = _detached_ws_transport')
    assert 0 <= close_lock < owned_snapshot < detach, close_handoff

    idle_start = source.index("def _reap_idle_sessions()")
    idle_end = source.index("\ndef _start_idle_reaper", idle_start)
    idle_reaper = source[idle_start:idle_end]
    idle_lock = idle_reaper.find("with _session_resume_lock:")
    identity_recheck = idle_reaper.find("if _sessions.get(sid) is not session:")
    evictable_recheck = idle_reaper.rfind("_session_is_evictable(sid, session, now)")
    idle_close = idle_reaper.find("_close_session_by_id(")
    assert 0 <= idle_lock < identity_recheck < evictable_recheck < idle_close, idle_reaper

    prompt_start = source.index('@method("prompt.submit")')
    prompt_end = source.index("\ndef _notification_event_belongs_elsewhere", prompt_start)
    prompt_submit = source[prompt_start:prompt_end]
    prompt_bind = prompt_submit.find(
        "_bind_prompt_transport_for_submit(session, request_transport)"
    )
    prompt_lock = prompt_submit.find("with _session_resume_lock:")
    prompt_registry = prompt_submit.find("registered_session = _sessions.get(sid)")
    prompt_guard = prompt_submit.find("_message_complete_is_pending(session)")
    prompt_inflight = prompt_submit.find("_start_inflight_turn(session, text)")
    assert prompt_bind >= 0, "prompt.submit does not bind through the snapshot barrier"
    assert (
        0 <= prompt_lock < prompt_registry < prompt_bind < prompt_guard < prompt_inflight
    ), prompt_submit

    poller_start = source.index("def _notification_poller_loop(")
    poller_end = source.index("\ndef _start_notification_poller", poller_start)
    poller = source[poller_start:poller_end]
    assert "_take_deferred_goal_followup(session)" in poller, poller
    assert (
        poller.count("_agent_run_continuation_waits_for_snapshot_ack(session)") >= 2
    ), poller
    assert poller.count("_message_complete_is_pending(session)") >= 2, poller
    assert poller.count("process_registry.completion_queue.put(evt)") >= 3, poller
    deferral = poller.find("defer_notification = False")
    requeue = poller.find("process_registry.completion_queue.put(evt)", deferral)
    backoff = poller.find("time.sleep(0.1)", requeue)
    retry = poller.find("continue", backoff)
    assert deferral >= 0, "pending process notification has no deferred state"
    assert deferral < requeue < backoff < retry, poller[deferral:retry]

    run_start = source.index("def _run_prompt_submit(")
    run_end = source.index('\n@method("clipboard.paste")', run_start)
    run_prompt = source[run_start:run_end]
    goal = run_prompt.index("if goal_followup:")
    defer = run_prompt.index("_defer_goal_followup(", goal)
    goal_barrier = run_prompt.index(
        "_agent_run_continuation_waits_for_snapshot_ack(session)", goal
    )
    nested_run = run_prompt.index("_run_prompt_submit(rid, sid, session, goal_followup)", goal)
    assert goal < goal_barrier < defer < nested_run, run_prompt[goal:nested_run]
    drain = run_prompt.index("for _evt, synth in process_registry.drain_notifications():")
    assert run_prompt.index("_message_complete_is_pending(session)", drain) > drain
    drain_dispatch = run_prompt.index('_emit("message.start", sid)', drain)
    drain_guard = run_prompt[drain:drain_dispatch]
    assert "process_registry.completion_queue.put(_evt)" in drain_guard, drain_guard
    assert "continue" in drain_guard and "break" not in drain_guard, drain_guard


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

    # A live session.resume replaces the transport-owned notifier as a
    # generation barrier. Any callback already in flight must finish before
    # the barrier returns, every old request fails closed, and genuinely new
    # requests remain independently actionable through the replacement.
    handoff_session = "synthetic-handoff-session"
    old_notifications = []
    old_expirations = []
    old_callback_entered = threading.Event()
    release_old_callback = threading.Event()

    def blocking_old_notify(data: dict) -> None:
        old_notifications.append(data["request_id"])
        old_callback_entered.set()
        assert release_old_callback.wait(timeout=2), "old notifier was never released"

    approval.register_gateway_notify(
        handoff_session,
        blocking_old_notify,
        lambda data: old_expirations.append((data["request_id"], data["reason"])),
    )
    with approval._lock:
        old_notifier = approval._gateway_notify_cbs[handoff_session]

    handoff_results = []

    def wait_for_handoff() -> None:
        handoff_results.append(
            approval._await_gateway_decision(
                handoff_session,
                old_notifier,
                {"request_id": "handoff-old"},
                request_id="handoff-old",
                dedup_key="handoff-logical-request",
                upstream_transport_id="old-transport",
            )
        )

    blocked_handoff = threading.Thread(target=wait_for_handoff)
    blocked_handoff.start()
    assert old_callback_entered.wait(timeout=2), "old notifier never entered"

    def wait_for_handoff_alias() -> None:
        handoff_results.append(
            approval._await_gateway_decision(
                handoff_session,
                old_notifier,
                {"request_id": "handoff-alias"},
                request_id="handoff-alias",
                dedup_key="handoff-logical-request",
                upstream_transport_id="retry-transport",
            )
        )

    blocked_alias = threading.Thread(target=wait_for_handoff_alias)
    blocked_alias.start()

    def handoff_alias_joined() -> bool:
        with approval._lock:
            return any(
                "handoff-alias" in entry.request_ids
                for entry in approval._gateway_queues.get(handoff_session, [])
            )

    wait_until(handoff_alias_joined, "handoff retry alias did not join the old request")

    fresh_notifications = []
    retired_request_ids = []

    def replace_for_handoff() -> None:
        retired_request_ids.extend(
            approval.replace_gateway_notify(
                handoff_session,
                lambda data: fresh_notifications.append(data["request_id"]),
                lambda _data: None,
            )
        )

    replacement = threading.Thread(target=replace_for_handoff)
    replacement.start()

    def replacement_installed() -> bool:
        with approval._lock:
            return approval._gateway_notify_cbs.get(handoff_session) is not old_notifier

    wait_until(replacement_installed, "replacement notifier was not installed atomically")
    assert replacement.is_alive(), "handoff returned before an old callback left flight"
    try:
        old_notifier({"request_id": "late-old"})
    except RuntimeError:
        pass
    else:
        raise AssertionError("a captured old notifier remained callable after replacement")

    release_old_callback.set()
    replacement.join(timeout=2)
    blocked_handoff.join(timeout=2)
    blocked_alias.join(timeout=2)
    assert not replacement.is_alive(), "handoff barrier did not return"
    assert not blocked_handoff.is_alive(), "retired approval did not fail closed"
    assert not blocked_alias.is_alive(), "retired approval alias did not fail closed"
    assert retired_request_ids == ["handoff-alias", "handoff-old"], retired_request_ids
    assert old_expirations == [("handoff-old", "transport_handoff")], old_expirations
    assert len(handoff_results) == 2, handoff_results
    assert all(
        result
        == {
            "resolved": False,
            "choice": None,
            "notify_failed": False,
            "reason": "transport_handoff",
        }
        for result in handoff_results
    ), handoff_results

    with approval._lock:
        fresh_notifier = approval._gateway_notify_cbs[handoff_session]
    fresh_results = []

    def wait_for_fresh() -> None:
        fresh_results.append(
            approval._await_gateway_decision(
                handoff_session,
                fresh_notifier,
                {"request_id": "handoff-fresh"},
                request_id="handoff-fresh",
                dedup_key="handoff-next-logical-request",
                upstream_transport_id="replacement-transport",
            )
        )

    fresh_thread = threading.Thread(target=wait_for_fresh)
    fresh_thread.start()
    wait_until(
        lambda: fresh_notifications == ["handoff-fresh"],
        "replacement notifier did not deliver a fresh approval",
    )

    # A thread that captured the retired notifier before replacement must not
    # join a fresh new-generation entry merely because its logical dedup key
    # matches. The generation check and queue arbitration share one lock.
    stale_generation_results = []

    def wait_with_stale_generation() -> None:
        stale_generation_results.append(
            approval._await_gateway_decision(
                handoff_session,
                old_notifier,
                {"request_id": "handoff-stale-alias"},
                request_id="handoff-stale-alias",
                dedup_key="handoff-next-logical-request",
                upstream_transport_id="late-old-transport",
            )
        )

    stale_generation_thread = threading.Thread(target=wait_with_stale_generation)
    stale_generation_thread.start()

    def stale_generation_settled_or_joined() -> bool:
        with approval._lock:
            joined = any(
                "handoff-stale-alias" in entry.request_ids
                for entry in approval._gateway_queues.get(handoff_session, [])
            )
        return bool(stale_generation_results) or joined

    wait_until(
        stale_generation_settled_or_joined,
        "captured stale notifier neither failed closed nor joined the fresh entry",
    )
    with approval._lock:
        stale_joined_fresh = any(
            "handoff-stale-alias" in entry.request_ids
            for entry in approval._gateway_queues.get(handoff_session, [])
        )
    if stale_joined_fresh:
        approval.resolve_gateway_approval(
            handoff_session, "once", request_id="handoff-fresh"
        )
        stale_generation_thread.join(timeout=2)
        fresh_thread.join(timeout=2)
        raise AssertionError("a stale notifier generation joined a fresh approval")
    stale_generation_thread.join(timeout=2)
    assert not stale_generation_thread.is_alive(), "stale notifier did not fail closed"
    assert stale_generation_results == [
        {
            "resolved": False,
            "choice": None,
            "notify_failed": True,
            "reason": "notifier_replaced",
        }
    ], stale_generation_results
    assert approval.resolve_gateway_approval(
        handoff_session, "once", request_id="handoff-fresh"
    ) == 1
    fresh_thread.join(timeout=2)
    assert not fresh_thread.is_alive(), "fresh approval did not resolve"
    assert fresh_results[0]["resolved"] is True
    assert fresh_results[0]["choice"] == "once"

    # A completed exact request keeps its sticky decision across notifier
    # replacement. Generation validation gates new queue arbitration, not the
    # bounded replay table that already proves this identity was resolved.
    approved_handoff_session = "synthetic-approved-handoff-session"
    approved_notifications = []
    approval.register_gateway_notify(
        approved_handoff_session,
        lambda data: approved_notifications.append(data["request_id"]),
    )
    with approval._lock:
        approved_old_notifier = approval._gateway_notify_cbs[approved_handoff_session]
    approved_results = []

    def wait_for_approved_handoff() -> None:
        approved_results.append(
            approval._await_gateway_decision(
                approved_handoff_session,
                approved_old_notifier,
                {"request_id": "handoff-already-approved"},
                request_id="handoff-already-approved",
            )
        )

    approved_thread = threading.Thread(target=wait_for_approved_handoff)
    approved_thread.start()
    wait_until(
        lambda: approved_notifications == ["handoff-already-approved"],
        "pre-handoff approval was not delivered",
    )
    assert approval.resolve_gateway_approval(
        approved_handoff_session,
        "once",
        request_id="handoff-already-approved",
    ) == 1
    approved_thread.join(timeout=2)
    assert not approved_thread.is_alive(), "pre-handoff approval did not resolve"
    assert approved_results[0]["choice"] == "once"
    assert approval.replace_gateway_notify(
        approved_handoff_session,
        lambda _data: None,
    ) == []
    approved_replay = approval._await_gateway_decision(
        approved_handoff_session,
        approved_old_notifier,
        {"request_id": "handoff-already-approved"},
        request_id="handoff-already-approved",
    )
    assert approved_replay == {
        "resolved": True,
        "choice": "once",
        "replayed": True,
    }, approved_replay

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


def exercise_server_handoff(server) -> None:
    class RecordingTransport:
        def __init__(self, name: str, outcomes=None):
            self.name = name
            self.frames = []
            self.outcomes = list(outcomes or [True])

        def write(self, frame: dict) -> bool:
            self.frames.append(frame)
            return self.outcomes.pop(0) if self.outcomes else True

    old_transport = RecordingTransport("old")
    replacement_transport = RecordingTransport("replacement")
    fallback_transport = RecordingTransport("fallback")
    server["_stdio_transport"] = fallback_transport

    # Resume and activation share one ordered lane. A slow resume cannot be
    # overtaken by rapid A -> B activation selections, and dispatch releases
    # each snapshot token only after its exact response write succeeds.
    activation_transport = RecordingTransport("activation")
    activation_timeline = []
    activation_tokens = {
        "runtime-resume": {"transport": activation_transport},
        "runtime-a": {"transport": activation_transport},
        "runtime-b": {"transport": activation_transport},
    }
    real_release = server["_release_agent_run_continuations_after_snapshot_ack"]
    first_snapshot_started = threading.Event()
    release_first_snapshot = threading.Event()

    def activation_handler(req: dict):
        sid = req["params"]["session_id"]
        if sid == "runtime-resume":
            first_snapshot_started.set()
            assert release_first_snapshot.wait(timeout=2)
        result = {"session_id": sid}
        if req["method"] in {"session.activate", "session.resume"}:
            result["_june_live_snapshot_ack_token"] = activation_tokens[sid]
        return {
            "id": req["id"],
            "jsonrpc": "2.0",
            "result": result,
        }

    def record_activation_release(resp: dict, transport, token) -> None:
        activation_timeline.append(
            ("release", resp["result"]["session_id"], transport, token)
        )

    original_write = activation_transport.write

    def record_activation_write(frame: dict) -> bool:
        activation_timeline.append(("write", frame["result"]["session_id"]))
        return original_write(frame)

    activation_transport.write = record_activation_write
    server["handle_request"] = activation_handler
    server["_release_agent_run_continuations_after_snapshot_ack"] = (
        record_activation_release
    )
    snapshot_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    server["_live_snapshot_pool"] = snapshot_pool

    class RejectingPool:
        def submit(self, _work):
            raise AssertionError("live snapshot escaped to the unordered pool")

    server["_pool"] = RejectingPool()
    try:
        snapshot_requests = (
            ("resume", "session.resume", "runtime-resume"),
            ("activate-a", "session.activate", "runtime-a"),
            ("activate-b", "session.activate", "runtime-b"),
        )
        for request_id, method, sid in snapshot_requests:
            response = server["dispatch"](
                {
                    "id": request_id,
                    "jsonrpc": "2.0",
                    "method": method,
                    "params": {"session_id": sid},
                },
                activation_transport,
            )
            assert response is None, response
            if sid == "runtime-resume":
                assert first_snapshot_started.wait(timeout=2)

        prompt_result = []

        def dispatch_prompt() -> None:
            prompt_result.append(
                server["dispatch"](
                    {
                        "id": "prompt-after-activation",
                        "jsonrpc": "2.0",
                        "method": "prompt.submit",
                        "params": {"session_id": "runtime-a"},
                    },
                    activation_transport,
                )
            )

        prompt_thread = threading.Thread(target=dispatch_prompt)
        prompt_thread.start()
        time.sleep(0.02)
        assert prompt_thread.is_alive(), "prompt did not wait behind queued snapshots"
        assert activation_transport.frames == [], activation_transport.frames
        release_first_snapshot.set()
        wait_until(
            lambda: len(activation_transport.frames) == 4,
            "ordered ownership responses did not drain",
        )
        prompt_thread.join(timeout=2)
        assert not prompt_thread.is_alive(), "ordered prompt dispatch did not finish"
        assert prompt_result == [None], prompt_result
    finally:
        release_first_snapshot.set()
        snapshot_pool.shutdown(wait=True, cancel_futures=True)
        server["_release_agent_run_continuations_after_snapshot_ack"] = real_release

    assert [entry[:2] for entry in activation_timeline] == [
        ("write", "runtime-resume"),
        ("release", "runtime-resume"),
        ("write", "runtime-a"),
        ("release", "runtime-a"),
        ("write", "runtime-b"),
        ("release", "runtime-b"),
        ("write", "runtime-a"),
    ], activation_timeline
    assert all(
        "_june_live_snapshot_ack_token" not in frame["result"]
        for frame in activation_transport.frames
    ), activation_transport.frames
    assert activation_timeline[1][2:] == (
        activation_transport,
        activation_tokens["runtime-resume"],
    ), activation_timeline
    assert activation_timeline[3][2:] == (
        activation_transport,
        activation_tokens["runtime-a"],
    ), activation_timeline
    assert activation_timeline[5][2:] == (
        activation_transport,
        activation_tokens["runtime-b"],
    ), activation_timeline

    # Disconnect cleanup takes the ownership lock before its session snapshot.
    # If a resume commit wins that lock first, cleanup must see and remove the
    # newly bound session instead of missing it with an earlier stale snapshot.
    cleanup_transport = RecordingTransport("cleanup")
    cleanup_transport._closed = True
    cleanup_closed = []
    cleanup_result = []
    real_close_session = server["_close_session_by_id"]

    def close_for_cleanup(sid: str, **_kwargs) -> bool:
        with server["_sessions_lock"]:
            removed = server["_sessions"].pop(sid, None)
        if removed is not None:
            cleanup_closed.append(sid)
            return True
        return False

    server["_close_session_by_id"] = close_for_cleanup
    ownership_lock = server["_session_resume_lock"]
    ownership_lock.acquire()
    try:
        cleanup_thread = threading.Thread(
            target=lambda: cleanup_result.append(
                server["_close_sessions_for_transport"](cleanup_transport)
            )
        )
        cleanup_thread.start()
        time.sleep(0.02)
        server["_sessions"]["committed-before-cleanup"] = {
            "close_on_disconnect": True,
            "transport": cleanup_transport,
        }
    finally:
        ownership_lock.release()
    cleanup_thread.join(timeout=2)
    server["_close_session_by_id"] = real_close_session
    assert not cleanup_thread.is_alive(), "disconnect cleanup did not finish"
    assert cleanup_result == [(1, 0)], cleanup_result
    assert cleanup_closed == ["committed-before-cleanup"], cleanup_closed

    # Idle reap rechecks the exact dict and current evictability while holding
    # the same ownership lock. A victim that became live after the first check
    # must not be finalized from stale evidence.
    idle_session = {"transport": old_transport}
    server["_sessions"]["idle-race"] = idle_session
    evictability_checks = []
    idle_closed = []

    def changing_evictability(sid: str, session: dict, _now: float) -> bool:
        evictability_checks.append((sid, session))
        return len(evictability_checks) == 1

    def close_for_idle(sid: str, **_kwargs) -> bool:
        idle_closed.append(sid)
        return True

    real_evictable = server["_session_is_evictable"]
    server["_session_is_evictable"] = changing_evictability
    server["_close_session_by_id"] = close_for_idle
    try:
        server["_reap_idle_sessions"]()
    finally:
        server["_session_is_evictable"] = real_evictable
        server["_close_session_by_id"] = real_close_session
    assert len(evictability_checks) == 2, evictability_checks
    assert idle_closed == [], idle_closed
    server["_sessions"].pop("idle-race", None)

    def take_snapshot_ack_token(payload: dict):
        token = payload.pop("_june_live_snapshot_ack_token", None)
        assert isinstance(token, dict), payload
        return token

    history_prefix = [{"role": "assistant", "content": "Ancestor reply."}]
    run_history = [
        {"role": "user", "content": "Finish across reconnect."},
        {"role": "assistant", "content": "Earlier reply."},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "tool-call-only",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
        {"role": "assistant", "content": "Final reply."},
    ]
    previous_run_history = run_history[:-1]
    complete_payload = {
        "reasoning": "Final reasoning.",
        "status": "complete",
        "text": "Final reply.",
        "usage": {"completion_tokens": 7, "prompt_tokens": 11},
    }
    expected_frame = {
        "jsonrpc": "2.0",
        "method": "event",
        "params": {
            "payload": complete_payload,
            "session_id": "runtime-session",
            "type": "message.complete",
        },
    }

    def session_for(transport):
        return {
            "created_at": time.time(),
            "display_history_prefix": history_prefix,
            "history": list(run_history),
            "history_lock": threading.Lock(),
            "inflight_turn": {
                "assistant": "Final reply.",
                "streaming": True,
                "user": "Finish across reconnect.",
            },
            "running": True,
            "session_key": "stored-session",
            "transport": transport,
        }

    # Activation and live resume use the same complete handoff: atomically arm
    # the snapshot token, replace approval notifier generation, retry the exact
    # retained completion first, and expose retired approval ids. A dead queued
    # request must fail before changing any of those owners.
    handoff_session = session_for(old_transport)
    handoff_transport = RecordingTransport("activation-handoff")
    handoff_session["_june_pending_message_complete_payload"] = {
        "session_id": "runtime-session",
        "payload": complete_payload,
    }
    handoff_session["_june_pending_message_complete_text"] = "Final reply."
    replacement_calls = []
    replacement_callbacks = {}
    fake_tools = types.ModuleType("tools")
    fake_tools.__path__ = []
    fake_approval = types.ModuleType("tools.approval")

    def replace_gateway_notify(key, notify, expire):
        replacement_calls.append(key)
        replacement_callbacks.update(notify=notify, expire=expire)
        return ["retired-before-activation"]

    fake_approval.replace_gateway_notify = replace_gateway_notify
    previous_tools = sys.modules.get("tools")
    previous_tools_approval = sys.modules.get("tools.approval")
    sys.modules["tools"] = fake_tools
    sys.modules["tools.approval"] = fake_approval
    try:
        handoff_payload = server["_handoff_live_session_transport"](
            "runtime-session",
            handoff_session,
            handoff_transport,
        )
    finally:
        if previous_tools is None:
            sys.modules.pop("tools", None)
        else:
            sys.modules["tools"] = previous_tools
        if previous_tools_approval is None:
            sys.modules.pop("tools.approval", None)
        else:
            sys.modules["tools.approval"] = previous_tools_approval
    assert replacement_calls == ["stored-session"], replacement_calls
    assert handoff_payload["retired_approval_request_ids"] == [
        "retired-before-activation"
    ], handoff_payload
    assert handoff_transport.frames == [expected_frame], handoff_transport.frames
    assert handoff_session["transport"] is handoff_transport
    handoff_token = handoff_payload.get("_june_live_snapshot_ack_token")
    assert handoff_session["_june_agent_run_continuation_snapshot_ack_barrier"] is handoff_token

    dynamic_prompt_transport = RecordingTransport("dynamic-prompt")
    real_write_json = server["write_json"]
    server["write_json"] = dynamic_prompt_transport.write
    try:
        replacement_callbacks["notify"]({"request_id": "approval-after-handoff"})
    finally:
        server["write_json"] = real_write_json
    assert dynamic_prompt_transport.frames[-1]["params"]["type"] == "approval.request"

    dead_transport = RecordingTransport("dead")
    dead_transport._closed = True
    dead_session = session_for(old_transport)
    try:
        server["_handoff_live_session_transport"](
            "runtime-dead",
            dead_session,
            dead_transport,
        )
    except RuntimeError as exc:
        assert "transport disconnected" in str(exc), exc
    else:
        raise AssertionError("dead live snapshot transport was accepted")
    assert dead_session["transport"] is old_transport
    assert "_june_agent_run_continuation_snapshot_ack_barrier" not in dead_session

    # Once the atomic snapshot has changed transport ownership, a later
    # notifier failure must remain fail closed: prompt submission stays behind
    # the unacknowledged barrier, and the next handoff can retarget that token
    # and retry the retained completion. Rolling back here would be unsafe if
    # notifier replacement had already retired its old generation.
    partial_failure_session = session_for(old_transport)
    partial_failure_session["_june_pending_message_complete_payload"] = {
        "session_id": "runtime-partial",
        "payload": complete_payload,
    }
    partial_failure_session["_june_pending_message_complete_text"] = "Final reply."
    failed_handoff_transport = RecordingTransport("failed-handoff")
    failing_approval = types.ModuleType("tools.approval")

    def fail_replace_gateway_notify(_key, _notify, _expire):
        raise RuntimeError("injected notifier replacement failure")

    failing_approval.replace_gateway_notify = fail_replace_gateway_notify
    sys.modules["tools"] = fake_tools
    sys.modules["tools.approval"] = failing_approval
    try:
        try:
            server["_handoff_live_session_transport"](
                "runtime-partial",
                partial_failure_session,
                failed_handoff_transport,
            )
        except RuntimeError as exc:
            assert "injected notifier replacement failure" in str(exc), exc
        else:
            raise AssertionError("injected notifier replacement failure was ignored")
    finally:
        if previous_tools is None:
            sys.modules.pop("tools", None)
        else:
            sys.modules["tools"] = previous_tools
        if previous_tools_approval is None:
            sys.modules.pop("tools.approval", None)
        else:
            sys.modules["tools.approval"] = previous_tools_approval
    failed_token = partial_failure_session[
        "_june_agent_run_continuation_snapshot_ack_barrier"
    ]
    assert partial_failure_session["transport"] is failed_handoff_transport
    assert partial_failure_session["_june_pending_message_complete_payload"]
    assert not server["_bind_prompt_transport_for_submit"](
        partial_failure_session, failed_handoff_transport
    )

    recovery_transport = RecordingTransport("recovery-handoff")
    recovery_approval = types.ModuleType("tools.approval")
    recovery_approval.replace_gateway_notify = lambda *_args: []
    sys.modules["tools"] = fake_tools
    sys.modules["tools.approval"] = recovery_approval
    try:
        recovery_payload = server["_handoff_live_session_transport"](
            "runtime-partial",
            partial_failure_session,
            recovery_transport,
        )
    finally:
        if previous_tools is None:
            sys.modules.pop("tools", None)
        else:
            sys.modules["tools"] = previous_tools
        if previous_tools_approval is None:
            sys.modules.pop("tools.approval", None)
        else:
            sys.modules["tools.approval"] = previous_tools_approval
    recovery_token = take_snapshot_ack_token(recovery_payload)
    assert recovery_token is not failed_token
    assert partial_failure_session[
        "_june_agent_run_continuation_snapshot_ack_barrier"
    ] is recovery_token
    expected_partial_frame = {
        "jsonrpc": "2.0",
        "method": "event",
        "params": {
            "payload": complete_payload,
            "session_id": "runtime-partial",
            "type": "message.complete",
        },
    }
    assert recovery_transport.frames == [expected_partial_frame]
    assert failed_handoff_transport.frames == []
    assert "_june_pending_message_complete_payload" not in partial_failure_session
    server["_sessions"]["runtime-partial"] = partial_failure_session
    try:
        server["_release_agent_run_continuations_after_snapshot_ack"](
            {"result": recovery_payload}, recovery_transport, recovery_token
        )
    finally:
        server["_sessions"].pop("runtime-partial", None)
    assert "_june_agent_run_continuation_snapshot_ack_barrier" not in partial_failure_session

    # Resume wins: its atomic history snapshot observes the marker and swaps
    # transport first. Completion must then write on the replacement transport;
    # the proof ordinal includes the ancestor but excludes tool-call-only rows.
    resume_first = session_for(old_transport)
    with resume_first["history_lock"]:
        server["_mark_pending_message_complete"](
            resume_first,
            history_prefix + previous_run_history,
            history_prefix + run_history,
            "Final reply.",
        )
    resumed = server["_live_session_payload"](
        "runtime-session",
        resume_first,
        transport=replacement_transport,
    )
    assert resumed["pending_message_complete"] == {"assistant_ordinal": 2}, resumed
    assert server["_retry_pending_message_complete"](
        resume_first, replacement_transport
    ) is False
    assert server["_deliver_message_complete"](
        resume_first,
        "runtime-session",
        complete_payload,
    )
    assert replacement_transport.frames == [expected_frame]
    assert old_transport.frames == []
    after_delivery = server["_live_session_payload"](
        "runtime-session",
        resume_first,
        transport=replacement_transport,
    )
    assert "pending_message_complete" not in after_delivery, after_delivery

    # Emitter wins: the old transport accepts the frame and the emitter clears
    # retained delivery state while still holding the history lock. A later
    # resume cannot duplicate it or advertise overlap authority to the client.
    emit_first_old = RecordingTransport("emit-first-old")
    emit_first_new = RecordingTransport("emit-first-new")
    emit_first = session_for(emit_first_old)
    with emit_first["history_lock"]:
        server["_mark_pending_message_complete"](
            emit_first,
            history_prefix + previous_run_history,
            history_prefix + run_history,
            "Final reply.",
        )
    assert server["_deliver_message_complete"](
        emit_first,
        "runtime-session",
        complete_payload,
    )
    resumed = server["_live_session_payload"](
        "runtime-session",
        emit_first,
        transport=emit_first_new,
    )
    assert "pending_message_complete" not in resumed, resumed
    assert server["_retry_pending_message_complete"](
        emit_first, emit_first_new
    ) is False
    assert emit_first_old.frames == [expected_frame]
    assert emit_first_new.frames == []

    # The transport write outcome itself is inside the history-lock boundary.
    # A resume that starts while a successful emitter is in flight cannot
    # snapshot the marker or retry the frame before that emitter clears it.
    write_entered = threading.Event()
    release_write = threading.Event()

    class BlockingTransport(RecordingTransport):
        def write(self, frame: dict) -> bool:
            self.frames.append(frame)
            write_entered.set()
            assert release_write.wait(timeout=2), "message.complete write was never released"
            return True

    serialized_old = BlockingTransport("serialized-old")
    serialized_new = RecordingTransport("serialized-new")
    serialized = session_for(serialized_old)
    with serialized["history_lock"]:
        server["_mark_pending_message_complete"](
            serialized,
            history_prefix + previous_run_history,
            history_prefix + run_history,
            "Final reply.",
        )
    delivered = []
    resumed_payloads = []

    def deliver_while_resuming() -> None:
        delivered.append(
            server["_deliver_message_complete"](
                serialized,
                "runtime-session",
                complete_payload,
            )
        )

    def resume_while_delivering() -> None:
        resumed_payloads.append(
            server["_live_session_payload"](
                "runtime-session",
                serialized,
                transport=serialized_new,
            )
        )
        server["_retry_pending_message_complete"](serialized, serialized_new)

    emitter_thread = threading.Thread(target=deliver_while_resuming)
    emitter_thread.start()
    assert write_entered.wait(timeout=2), "message.complete emitter did not enter write"
    resume_thread = threading.Thread(target=resume_while_delivering)
    resume_thread.start()
    time.sleep(0.02)
    assert resume_thread.is_alive(), "resume crossed an undecided message.complete write"
    release_write.set()
    emitter_thread.join(timeout=2)
    resume_thread.join(timeout=2)
    assert not emitter_thread.is_alive(), "message.complete emitter did not finish"
    assert not resume_thread.is_alive(), "resume did not finish after emission"
    assert delivered == [True]
    assert "pending_message_complete" not in resumed_payloads[0], resumed_payloads
    assert serialized_old.frames == [expected_frame]
    assert serialized_new.frames == []

    # A closed transport reports False after observing the exact frame. The
    # marker and payload must survive that failed attempt so session.resume can
    # prove the persisted overlap, swap transports, and retry the same frame on
    # the replacement before its response is returned.
    closed_old = RecordingTransport("closed-old", outcomes=[False])
    retry_new = RecordingTransport("retry-new")
    retry_after_close = session_for(closed_old)
    with retry_after_close["history_lock"]:
        server["_mark_pending_message_complete"](
            retry_after_close,
            history_prefix + previous_run_history,
            history_prefix + run_history,
            "Final reply.",
        )
    assert server["_deliver_message_complete"](
        retry_after_close,
        "runtime-session",
        complete_payload,
    ) is False
    assert closed_old.frames == [expected_frame]
    assert retry_after_close["_june_pending_message_complete_payload"] == {
        "payload": complete_payload,
        "session_id": "runtime-session",
    }
    resumed = server["_live_session_payload"](
        "runtime-session",
        retry_after_close,
        transport=retry_new,
    )
    assert resumed["pending_message_complete"] == {"assistant_ordinal": 2}, resumed
    assert server["_retry_pending_message_complete"](
        retry_after_close, retry_new
    ) is True
    assert retry_new.frames == [expected_frame]
    assert "_june_pending_message_complete_text" not in retry_after_close
    assert "_june_pending_message_complete_payload" not in retry_after_close

    # A replacement can itself disappear before the retry. Every False result
    # keeps the exact payload for a later resume; only the first successful
    # replacement clears it. Each transport sees at most one attempt.
    false_old = RecordingTransport("false-old", outcomes=[False])
    false_new_one = RecordingTransport("false-new-one", outcomes=[False])
    false_new_two = RecordingTransport("false-new-two", outcomes=[False])
    eventual_new = RecordingTransport("eventual-new")
    repeated_failure = session_for(false_old)
    with repeated_failure["history_lock"]:
        server["_mark_pending_message_complete"](
            repeated_failure,
            history_prefix + previous_run_history,
            history_prefix + run_history,
            "Final reply.",
        )
    assert server["_deliver_message_complete"](
        repeated_failure,
        "runtime-session",
        complete_payload,
    ) is False
    for replacement in (false_new_one, false_new_two):
        resumed = server["_live_session_payload"](
            "runtime-session",
            repeated_failure,
            transport=replacement,
        )
        assert resumed["pending_message_complete"] == {
            "assistant_ordinal": 2
        }, resumed
        assert server["_retry_pending_message_complete"](
            repeated_failure, replacement
        ) is False
        assert replacement.frames == [expected_frame]
        assert "_june_pending_message_complete_payload" in repeated_failure
    resumed = server["_live_session_payload"](
        "runtime-session",
        repeated_failure,
        transport=eventual_new,
    )
    assert resumed["pending_message_complete"] == {"assistant_ordinal": 2}, resumed
    assert server["_retry_pending_message_complete"](
        repeated_failure, eventual_new
    ) is True
    assert false_old.frames == [expected_frame]
    assert eventual_new.frames == [expected_frame]
    assert server["_retry_pending_message_complete"](
        repeated_failure, eventual_new
    ) is False
    assert eventual_new.frames == [expected_frame]
    assert "_june_pending_message_complete_text" not in repeated_failure
    assert "_june_pending_message_complete_payload" not in repeated_failure

    # Delivery retry is independent of ordinal authority. A history-version
    # mismatch or ambiguous final row has no persistence proof to advertise,
    # but a failed transport must not discard the only visible completion.
    unproven_old = RecordingTransport("unproven-old", outcomes=[False])
    unproven_new = RecordingTransport("unproven-new")
    unproven = session_for(unproven_old)
    assert "_june_pending_message_complete_text" not in unproven
    assert server["_deliver_message_complete"](
        unproven,
        "runtime-session",
        complete_payload,
    ) is False
    assert unproven["_june_pending_message_complete_payload"] == {
        "payload": complete_payload,
        "session_id": "runtime-session",
    }
    resumed = server["_live_session_payload"](
        "runtime-session",
        unproven,
        transport=unproven_new,
    )
    assert "pending_message_complete" not in resumed, resumed
    assert server["_retry_pending_message_complete"](
        unproven, unproven_new
    ) is True
    assert unproven_old.frames == [expected_frame]
    assert unproven_new.frames == [expected_frame]
    assert "_june_pending_message_complete_payload" not in unproven

    # Snapshot/emitter race: resume observes the committed-row proof and swaps
    # transport before the original emitter stores its payload. The emitter can
    # then succeed on the replacement and clear the proof, but the atomically
    # armed acknowledgement barrier must still defer goal chaining until that
    # exact live snapshot acknowledgement is accepted.
    snapshot_race_old = RecordingTransport("snapshot-race-old")
    snapshot_race_new = RecordingTransport("snapshot-race-new")
    snapshot_race = session_for(snapshot_race_old)
    with snapshot_race["history_lock"]:
        server["_mark_pending_message_complete"](
            snapshot_race,
            history_prefix + previous_run_history,
            history_prefix + run_history,
            "Final reply.",
        )
    race_payload = server["_live_session_payload"](
        "snapshot-race-session",
        snapshot_race,
        transport=snapshot_race_new,
        agent_run_continuation_snapshot_ack_transport=snapshot_race_new,
    )
    race_snapshot_ack_token = take_snapshot_ack_token(race_payload)
    assert race_payload["pending_message_complete"] == {"assistant_ordinal": 2}
    assert server["_deliver_message_complete"](
        snapshot_race,
        "runtime-session",
        complete_payload,
    ) is True
    assert snapshot_race_new.frames == [expected_frame]
    assert "_june_pending_message_complete_payload" not in snapshot_race
    assert (
        snapshot_race["_june_agent_run_continuation_snapshot_ack_barrier"]
        is race_snapshot_ack_token
    )
    with snapshot_race["history_lock"]:
        snapshot_race["running"] = False
        server["_defer_goal_followup"](
            snapshot_race, "snapshot-race-rid", "Continue after acknowledgement."
        )
    assert server["_take_deferred_goal_followup"](snapshot_race) is None
    server["_sessions"]["snapshot-race-session"] = snapshot_race
    server["_release_agent_run_continuations_after_snapshot_ack"](
        {"result": {"session_id": "snapshot-race-session"}},
        snapshot_race_new,
        race_snapshot_ack_token,
    )
    assert server["_take_deferred_goal_followup"](snapshot_race) == {
        "rid": "snapshot-race-rid",
        "text": "Continue after acknowledgement.",
    }

    # A prompt cannot steal transport ownership. During the snapshot barrier it
    # fails closed, and after acknowledgement a different client must still use
    # session.resume or session.activate so notifier and stream ownership move
    # together.
    resume_ack_transport = RecordingTransport("resume-ack")
    prompt_contender_transport = RecordingTransport("prompt-contender")
    prompt_during_resume = session_for(old_transport)
    prompt_resume_payload = server["_live_session_payload"](
        "prompt-during-resume-session",
        prompt_during_resume,
        transport=resume_ack_transport,
        agent_run_continuation_snapshot_ack_transport=resume_ack_transport,
    )
    prompt_resume_ack_token = take_snapshot_ack_token(prompt_resume_payload)
    server["_sessions"]["prompt-during-resume-session"] = prompt_during_resume
    assert server["_bind_prompt_transport_for_submit"](
        prompt_during_resume, prompt_contender_transport
    ) is False
    assert prompt_during_resume["transport"] is resume_ack_transport
    server["_release_agent_run_continuations_after_snapshot_ack"](
        {"result": {"session_id": "prompt-during-resume-session"}},
        resume_ack_transport,
        prompt_resume_ack_token,
    )
    assert (
        "_june_agent_run_continuation_snapshot_ack_barrier"
        not in prompt_during_resume
    )
    assert server["_bind_prompt_transport_for_submit"](
        prompt_during_resume, prompt_contender_transport
    ) is False
    assert prompt_during_resume["transport"] is resume_ack_transport
    assert server["_bind_prompt_transport_for_submit"](
        prompt_during_resume, resume_ack_transport
    ) is True

    # session.activate returns the same kind of live snapshot and may race a
    # session.resume acknowledgement. It must atomically retarget ownership to
    # its own transport, and only that newer snapshot acknowledgement may
    # release Agent run continuations.
    activation_transport = RecordingTransport("activation")
    activation_during_resume = session_for(old_transport)
    resume_payload = server["_live_session_payload"](
        "activation-during-resume-session",
        activation_during_resume,
        transport=resume_ack_transport,
        agent_run_continuation_snapshot_ack_transport=resume_ack_transport,
    )
    resume_snapshot_ack_token = take_snapshot_ack_token(resume_payload)
    activation_payload = server["_live_session_payload"](
        "activation-during-resume-session",
        activation_during_resume,
        transport=activation_transport,
        agent_run_continuation_snapshot_ack_transport=activation_transport,
    )
    activation_snapshot_ack_token = take_snapshot_ack_token(activation_payload)
    server["_sessions"]["activation-during-resume-session"] = activation_during_resume
    server["_release_agent_run_continuations_after_snapshot_ack"](
        {"result": {"session_id": "activation-during-resume-session"}},
        resume_ack_transport,
        resume_snapshot_ack_token,
    )
    assert (
        activation_during_resume["_june_agent_run_continuation_snapshot_ack_barrier"]
        is activation_snapshot_ack_token
    )
    assert server["_bind_prompt_transport_for_submit"](
        activation_during_resume, prompt_contender_transport
    ) is False
    server["_release_agent_run_continuations_after_snapshot_ack"](
        {"result": {"session_id": "activation-during-resume-session"}},
        activation_transport,
        activation_snapshot_ack_token,
    )
    assert server["_bind_prompt_transport_for_submit"](
        activation_during_resume, activation_transport
    ) is True

    # Transport identity cannot distinguish two queued snapshots on the same
    # socket. Each response carries its own process-local token, so the older
    # response cannot release a newer snapshot before that response is written.
    same_transport_snapshots = session_for(activation_transport)
    first_same_transport_payload = server["_live_session_payload"](
        "same-transport-snapshot-session",
        same_transport_snapshots,
        transport=activation_transport,
        agent_run_continuation_snapshot_ack_transport=activation_transport,
    )
    first_same_transport_token = take_snapshot_ack_token(first_same_transport_payload)
    second_same_transport_payload = server["_live_session_payload"](
        "same-transport-snapshot-session",
        same_transport_snapshots,
        transport=activation_transport,
        agent_run_continuation_snapshot_ack_transport=activation_transport,
    )
    second_same_transport_token = take_snapshot_ack_token(second_same_transport_payload)
    assert first_same_transport_token is not second_same_transport_token
    server["_sessions"]["same-transport-snapshot-session"] = same_transport_snapshots
    server["_release_agent_run_continuations_after_snapshot_ack"](
        {"result": {"session_id": "same-transport-snapshot-session"}},
        activation_transport,
        first_same_transport_token,
    )
    assert (
        same_transport_snapshots["_june_agent_run_continuation_snapshot_ack_barrier"]
        is second_same_transport_token
    )
    assert server["_bind_prompt_transport_for_submit"](
        same_transport_snapshots, prompt_contender_transport
    ) is False
    server["_release_agent_run_continuations_after_snapshot_ack"](
        {"result": {"session_id": "same-transport-snapshot-session"}},
        activation_transport,
        second_same_transport_token,
    )
    assert server["_bind_prompt_transport_for_submit"](
        same_transport_snapshots, activation_transport
    ) is True

    # Any future live-payload caller that tries to swap transport without
    # participating in the acknowledgement protocol fails closed.
    guarded_live_payload = session_for(old_transport)
    server["_live_session_payload"](
        "guarded-live-payload-session",
        guarded_live_payload,
        transport=resume_ack_transport,
        agent_run_continuation_snapshot_ack_transport=resume_ack_transport,
    )
    try:
        server["_live_session_payload"](
            "guarded-live-payload-session",
            guarded_live_payload,
            transport=activation_transport,
        )
    except RuntimeError as exc:
        assert "live snapshot acknowledgement is pending" in str(exc)
    else:
        raise AssertionError("unguarded live snapshot transport swap succeeded")
    assert guarded_live_payload["transport"] is resume_ack_transport

    # Starting another in-flight row cannot abandon or replace a completion the
    # previous transport rejected. Agent run continuation work must wait for
    # that exact frame to reach a replacement transport first.
    retained_old = RecordingTransport("retained-old", outcomes=[False])
    retained_on_next_run = session_for(retained_old)
    with retained_on_next_run["history_lock"]:
        server["_mark_pending_message_complete"](
            retained_on_next_run,
            history_prefix + previous_run_history,
            history_prefix + run_history,
            "Final reply.",
        )
    assert server["_deliver_message_complete"](
        retained_on_next_run,
        "runtime-session",
        complete_payload,
    ) is False
    retained_state = {
        "payload": retained_on_next_run["_june_pending_message_complete_payload"],
        "text": retained_on_next_run["_june_pending_message_complete_text"],
    }
    server["_start_inflight_turn"](retained_on_next_run, "Start the next run.")
    assert retained_on_next_run["_june_pending_message_complete_text"] == retained_state["text"]
    assert (
        retained_on_next_run["_june_pending_message_complete_payload"]
        == retained_state["payload"]
    )

    # Even a defensive second history-commit attempt cannot overwrite the
    # older proof while its exact completion payload is still pending.
    later_history = history_prefix + run_history + [
        {"role": "user", "content": "Agent run continuation."},
        {"role": "assistant", "content": "Later reply."},
    ]
    with retained_on_next_run["history_lock"]:
        server["_mark_pending_message_complete"](
            retained_on_next_run,
            history_prefix + run_history,
            later_history,
            "Later reply.",
        )
    assert retained_on_next_run["_june_pending_message_complete_text"] == retained_state["text"]
    assert (
        retained_on_next_run["_june_pending_message_complete_payload"]
        == retained_state["payload"]
    )

    # A goal continuation is retained while the old completion is blocked. A
    # successful resume retry emits the old exact frame first, after which the
    # deferred prompt becomes claimable exactly once and marks the session busy.
    with retained_on_next_run["history_lock"]:
        retained_on_next_run["running"] = False
        server["_defer_goal_followup"](
            retained_on_next_run,
            "goal-rid",
            "Continue the active goal.",
        )
    assert server["_message_complete_is_pending"](retained_on_next_run)
    assert server["_take_deferred_goal_followup"](retained_on_next_run) is None
    assert retained_on_next_run["_june_deferred_goal_followup"] == {
        "rid": "goal-rid",
        "snapshot_ack_delivered": False,
        "text": "Continue the active goal.",
    }
    retained_new = RecordingTransport("retained-new")
    retained_resume_payload = server["_live_session_payload"](
        "runtime-session",
        retained_on_next_run,
        transport=retained_new,
        agent_run_continuation_snapshot_ack_transport=retained_new,
    )
    retained_snapshot_ack_token = take_snapshot_ack_token(retained_resume_payload)
    assert retained_resume_payload["pending_message_complete"] == {"assistant_ordinal": 2}
    assert server["_retry_pending_message_complete"](
        retained_on_next_run,
        retained_new,
        snapshot_ack_token=retained_snapshot_ack_token,
    ) is True
    assert retained_new.frames == [expected_frame]
    assert (
        retained_on_next_run["_june_agent_run_continuation_snapshot_ack_barrier"]
        is retained_snapshot_ack_token
    )
    assert server["_agent_run_continuation_waits_for_snapshot_ack"](
        retained_on_next_run
    )
    assert server["_take_deferred_goal_followup"](retained_on_next_run) is None
    server["_sessions"]["runtime-session"] = retained_on_next_run
    newest_resume = RecordingTransport("newest-resume")
    newest_resume_payload = server["_live_session_payload"](
        "runtime-session",
        retained_on_next_run,
        transport=newest_resume,
        agent_run_continuation_snapshot_ack_transport=newest_resume,
    )
    newest_snapshot_ack_token = take_snapshot_ack_token(newest_resume_payload)
    server["_release_agent_run_continuations_after_snapshot_ack"](
        {"result": {"session_id": "runtime-session"}},
        retained_new,
        retained_snapshot_ack_token,
    )
    assert (
        retained_on_next_run["_june_agent_run_continuation_snapshot_ack_barrier"]
        is newest_snapshot_ack_token
    )
    assert server["_take_deferred_goal_followup"](retained_on_next_run) is None
    server["_release_agent_run_continuations_after_snapshot_ack"](
        {"result": {"session_id": "runtime-session"}},
        newest_resume,
        newest_snapshot_ack_token,
    )
    assert (
        "_june_agent_run_continuation_snapshot_ack_barrier"
        not in retained_on_next_run
    )
    deferred = server["_take_deferred_goal_followup"](retained_on_next_run)
    assert deferred == {
        "rid": "goal-rid",
        "text": "Continue the active goal.",
    }, deferred
    assert retained_on_next_run["running"] is True
    assert server["_take_deferred_goal_followup"](retained_on_next_run) is None
    assert "_june_deferred_goal_followup" not in retained_on_next_run

    # An unchanged history with an identical final-response string cannot
    # prove a newly committed row, and a mismatched final row likewise never
    # creates authority. Both remain fail-closed.
    unchanged = session_for(old_transport)
    with unchanged["history_lock"]:
        server["_mark_pending_message_complete"](
            unchanged,
            history_prefix + run_history,
            history_prefix + run_history,
            "Final reply.",
        )
    assert "_june_pending_message_complete_text" not in unchanged

    mismatched = session_for(old_transport)
    with mismatched["history_lock"]:
        server["_mark_pending_message_complete"](
            mismatched,
            history_prefix + previous_run_history,
            history_prefix + run_history,
            "Earlier reply.",
        )
    assert "_june_pending_message_complete_text" not in mismatched


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="Patched hermes-agent source root")
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        exercise(load_approval(root))
        assert_server_handoff_source(root)
        exercise_server_handoff(load_server_handoff_helpers(root))
    except Exception as exc:
        print("patched Hermes approval protocol: FAIL: %s" % exc, file=sys.stderr)
        return 1
    print("patched Hermes approval protocol: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
