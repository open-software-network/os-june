#!/usr/bin/env python3
"""Apply June's deterministic compatibility patches to the pinned Hermes tree.

The source archive is still verified against the upstream SHA-256 before this
script runs. Each touched file must then match either its exact upstream hash or
its exact patched hash. Any other input fails closed.
"""

import argparse
import hashlib
from pathlib import Path
import sys
from typing import Callable, Dict


PATCH_SET = "june-approval-v3"

UPSTREAM_SHA256: Dict[str, str] = {
    "tools/approval.py": "e31abc88357afa28c05f3a4753ea9908b540b0dfef8dab2fa62960ae19a63c85",
    "tools/mcp_tool.py": "3f0aca90d076a1b0aa5daffd7bb39b0d1a4fee83265f855e68d556e5c8a29d01",
    "tui_gateway/server.py": "1743cec5c6684651d2b7cb18b7b73a37ea99538a4f56bcd8476700ce23d4f01a",
}

# Filled after applying the transformations to the exact upstream files. These
# hashes are part of the runtime provenance contract, not best-effort checks.
PATCHED_SHA256: Dict[str, str] = {
    "tools/approval.py": "daaac4cbc6adfffd3a8cbd8442d3cc0c26bc499725e395cf837607dbcebc46d8",
    "tools/mcp_tool.py": "48a2fddfee5d5a8c33723e27639907e9f2cf062c82e7beeb844f457e6a372cfa",
    "tui_gateway/server.py": "5a44165e85dd0922d2810b54275726763effff9a752d863ad501806c8f6e9575",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError("%s: expected one match, found %d" % (label, count))
    return source.replace(old, new, 1)


def replace_region(source: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = source.find(start)
    if start_index < 0:
        raise RuntimeError("%s: start marker not found" % label)
    end_index = source.find(end, start_index)
    if end_index < 0:
        raise RuntimeError("%s: end marker not found" % label)
    if source.find(start, start_index + 1) >= 0:
        raise RuntimeError("%s: start marker is not unique" % label)
    return source[:start_index] + replacement + source[end_index:]


def patch_approval(source: str) -> str:
    source = replace_once(
        source,
        "import contextvars\nimport fnmatch\n",
        "import contextvars\nimport fnmatch\nimport hashlib\n",
        "approval imports",
    )

    queue_region = r'''class _ApprovalEntry:
    """One pending dangerous-command approval inside a gateway session."""
    __slots__ = (
        "event", "data", "request_id", "request_ids", "dedup_key",
        "upstream_transport_id", "result", "notify_failed", "retired_reason",
    )

    def __init__(
        self,
        data: dict,
        request_id: str,
        dedup_key: Optional[str] = None,
        upstream_transport_id: Optional[str] = None,
    ):
        self.event = threading.Event()
        self.data = data          # command, description, pattern_keys, …
        self.request_id = request_id
        self.request_ids = {request_id}
        self.dedup_key = dedup_key
        self.upstream_transport_id = upstream_transport_id
        self.result: Optional[str] = None  # "once"|"session"|"always"|"deny"
        self.notify_failed = False
        self.retired_reason: Optional[str] = None


class _GatewayNotify:
    """One transport generation of the session approval notifier."""

    __slots__ = ("_active", "_callback", "_condition", "_inflight")

    def __init__(self, callback):
        self._active = True
        self._callback = callback
        self._condition = threading.Condition()
        self._inflight = 0

    def __call__(self, approval_data: dict) -> None:
        with self._condition:
            if not self._active:
                raise RuntimeError("gateway approval notifier generation is retired")
            self._inflight += 1
        try:
            self._callback(approval_data)
        finally:
            with self._condition:
                self._inflight -= 1
                if self._inflight == 0:
                    self._condition.notify_all()

    def deactivate(self) -> None:
        with self._condition:
            self._active = False

    def wait_until_idle(self) -> None:
        with self._condition:
            while self._inflight:
                self._condition.wait()


_MAX_GATEWAY_APPROVALS_PER_SESSION = 32
_MAX_GATEWAY_APPROVAL_ALIASES = 16
_MAX_COMPLETED_GATEWAY_APPROVALS_PER_SESSION = 128
_MAX_COMPLETED_GATEWAY_SESSIONS = 256
_gateway_queues: dict[str, list] = {}        # session_key → [_ApprovalEntry, …]
_gateway_notify_cbs: dict[str, object] = {}  # session_key → callable(approval_data)
_gateway_expire_cbs: dict[str, object] = {}  # session_key → callable(expiration_data)
_gateway_completed: dict[str, dict] = {}     # session_key → request_id → choice|None


def register_gateway_notify(session_key: str, cb, expire_cb=None) -> None:
    """Register callbacks for approval requests and fail-closed retirement."""
    with _lock:
        _gateway_notify_cbs[session_key] = _GatewayNotify(cb)
        if expire_cb is None:
            _gateway_expire_cbs.pop(session_key, None)
        else:
            _gateway_expire_cbs[session_key] = expire_cb


def _emit_gateway_expiration(session_key: str, entry: _ApprovalEntry, reason: str) -> None:
    with _lock:
        expire_cb = _gateway_expire_cbs.get(session_key)
    if expire_cb is None:
        return
    try:
        expire_cb({"request_id": entry.request_id, "reason": reason})
    except Exception as exc:
        logger.warning("Gateway approval expiration notify failed: %s", exc)


def _remember_gateway_completion_locked(
    session_key: str,
    request_id: str,
    choice: Optional[str],
) -> None:
    completed = _gateway_completed.get(session_key)
    if completed is None:
        while len(_gateway_completed) >= _MAX_COMPLETED_GATEWAY_SESSIONS:
            _gateway_completed.pop(next(iter(_gateway_completed)))
        completed = {}
        _gateway_completed[session_key] = completed
    completed[request_id] = {"choice": choice}
    while len(completed) > _MAX_COMPLETED_GATEWAY_APPROVALS_PER_SESSION:
        completed.pop(next(iter(completed)))


def _remember_gateway_entry_completion_locked(
    session_key: str,
    entry: _ApprovalEntry,
    choice: Optional[str],
) -> None:
    for request_id in entry.request_ids:
        _remember_gateway_completion_locked(session_key, request_id, choice)


def unregister_gateway_notify(session_key: str) -> None:
    """Unregister callbacks and fail closed every blocked approval."""
    with _lock:
        notifier = _gateway_notify_cbs.pop(session_key, None)
        if notifier is not None:
            notifier.deactivate()
        expire_cb = _gateway_expire_cbs.pop(session_key, None)
        entries = _gateway_queues.pop(session_key, [])
        for entry in entries:
            entry.retired_reason = "disconnect"
            _remember_gateway_entry_completion_locked(session_key, entry, None)
    if notifier is not None:
        notifier.wait_until_idle()
    for entry in entries:
        entry.event.set()
        if expire_cb is not None:
            try:
                expire_cb({"request_id": entry.request_id, "reason": "disconnect"})
            except Exception as exc:
                logger.warning("Gateway approval expiration notify failed: %s", exc)


def replace_gateway_notify(session_key: str, cb, expire_cb=None) -> list[str]:
    """Install a new transport notifier after retiring the old generation.

    The replacement is visible atomically under the approval lock. Calls that
    already entered the old notifier finish before this function returns;
    captured calls that have not entered fail when they observe deactivation.
    Every queued old-generation approval is tombstoned and signaled fail closed.
    The returned ids let the live handoff caller distinguish retired pre-ACK
    frames from genuinely fresh requests emitted by the replacement generation.
    """
    replacement = _GatewayNotify(cb)
    with _lock:
        notifier = _gateway_notify_cbs.get(session_key)
        if notifier is not None:
            notifier.deactivate()
        _gateway_notify_cbs[session_key] = replacement
        previous_expire_cb = _gateway_expire_cbs.get(session_key)
        if expire_cb is None:
            _gateway_expire_cbs.pop(session_key, None)
        else:
            _gateway_expire_cbs[session_key] = expire_cb
        entries = _gateway_queues.pop(session_key, [])
        retired_request_ids = set()
        for entry in entries:
            entry.retired_reason = "transport_handoff"
            retired_request_ids.update(entry.request_ids)
            _remember_gateway_entry_completion_locked(session_key, entry, None)

    if notifier is not None:
        notifier.wait_until_idle()
    for entry in entries:
        entry.event.set()
        if previous_expire_cb is not None:
            try:
                previous_expire_cb(
                    {"request_id": entry.request_id, "reason": "transport_handoff"}
                )
            except Exception as exc:
                logger.warning("Gateway approval expiration notify failed: %s", exc)
    return sorted(retired_request_ids)


def resolve_gateway_approval(
    session_key: str,
    choice: str,
    resolve_all: bool = False,
    request_id: Optional[str] = None,
) -> int:
    """Resolve a targeted request, retaining FIFO only for legacy callers."""
    with _lock:
        queue = _gateway_queues.get(session_key)
        if not queue:
            return 0
        if request_id:
            target = next((entry for entry in queue if entry.request_id == request_id), None)
            if target is None:
                return 0
            targets = [target]
            queue.remove(target)
        elif resolve_all:
            targets = list(queue)
            queue.clear()
        else:
            targets = [queue.pop(0)]
        if not queue:
            _gateway_queues.pop(session_key, None)
        for entry in targets:
            entry.result = choice
            _remember_gateway_entry_completion_locked(session_key, entry, choice)

    for entry in targets:
        entry.event.set()
    return len(targets)


def has_blocking_approval(session_key: str) -> bool:
    """Check if a session has one or more blocking gateway approvals waiting."""
    with _lock:
        return bool(_gateway_queues.get(session_key))


'''
    source = replace_region(
        source,
        "class _ApprovalEntry:\n",
        "def submit_pending(session_key: str, approval: dict):\n",
        queue_region,
        "approval queue protocol",
    )

    await_region = r'''def _await_gateway_decision(
    session_key: str,
    notify_cb,
    approval_data: dict,
    *,
    surface: str = "gateway",
    request_id: Optional[str] = None,
    dedup_key: Optional[str] = None,
    upstream_transport_id: Optional[str] = None,
) -> dict:
    """Wait for one bounded, identity-addressable gateway approval."""
    command = approval_data.get("command", "")
    description = approval_data.get("description", "")
    primary_key = approval_data.get("pattern_key", "")
    all_keys = approval_data.get("pattern_keys", [primary_key])

    if not isinstance(all_keys, (list, tuple)):
        all_keys = [primary_key]

    request_id = str(request_id or approval_data.get("request_id") or "").strip()
    if not request_id:
        turn_id = str(_approval_turn_id.get() or "").strip()
        tool_call_id = str(_approval_tool_call_id.get() or "").strip()
        if not tool_call_id:
            logger.warning("Gateway approval has no stable request context; failing closed")
            return {"resolved": False, "choice": None, "malformed": True}
        identity = "\0".join(
            (
                surface,
                session_key,
                turn_id,
                tool_call_id,
                str(command),
                str(description),
                str(primary_key),
                "\x1f".join(str(key) for key in all_keys),
            )
        )
        request_id = "gateway-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
    approval_data = dict(approval_data)
    approval_data["request_id"] = request_id
    dedup_key = str(dedup_key or "").strip()
    upstream_transport_id = str(upstream_transport_id or "").strip()

    owner = False
    with _lock:
        completed = _gateway_completed.get(session_key, {}).get(request_id)
        if completed is not None:
            choice = completed.get("choice")
            return {"resolved": choice is not None, "choice": choice, "replayed": True}
        if (
            isinstance(notify_cb, _GatewayNotify)
            and _gateway_notify_cbs.get(session_key) is not notify_cb
        ):
            _remember_gateway_completion_locked(session_key, request_id, None)
            return {
                "resolved": False,
                "choice": None,
                "notify_failed": True,
                "reason": "notifier_replaced",
            }

        queue = _gateway_queues.setdefault(session_key, [])
        entry = next((candidate for candidate in queue if candidate.request_id == request_id), None)
        if entry is None and dedup_key and upstream_transport_id:
            entry = next(
                (
                    candidate
                    for candidate in queue
                    if candidate.dedup_key == dedup_key
                    and candidate.upstream_transport_id
                    and candidate.upstream_transport_id != upstream_transport_id
                ),
                None,
            )
        if entry is not None:
            if (
                request_id not in entry.request_ids
                and len(entry.request_ids) >= _MAX_GATEWAY_APPROVAL_ALIASES
            ):
                logger.warning(
                    "Gateway approval retry aliases full for %s; failing request %s closed",
                    session_key,
                    request_id,
                )
                return {"resolved": False, "choice": None, "overflow": True}
            entry.request_ids.add(request_id)
        if entry is None:
            if len(queue) >= _MAX_GATEWAY_APPROVALS_PER_SESSION:
                logger.warning(
                    "Gateway approval queue full for %s; failing request %s closed",
                    session_key,
                    request_id,
                )
                return {
                    "resolved": False,
                    "choice": None,
                    "overflow": True,
                }
            entry = _ApprovalEntry(
                approval_data,
                request_id,
                dedup_key or None,
                upstream_transport_id or None,
            )
            queue.append(entry)
            owner = True

    if owner:
        _fire_approval_hook(
            "pre_approval_request",
            command=command,
            description=description,
            pattern_key=primary_key,
            pattern_keys=list(all_keys),
            session_key=session_key,
            surface=surface,
        )
        try:
            notify_cb(approval_data)
        except Exception as exc:
            logger.warning("Gateway approval notify failed: %s", exc)
            with _lock:
                queue = _gateway_queues.get(session_key, [])
                if entry in queue:
                    queue.remove(entry)
                if not queue:
                    _gateway_queues.pop(session_key, None)
                entry.notify_failed = True
                entry.retired_reason = "notify_failed"
                _remember_gateway_entry_completion_locked(session_key, entry, None)
            entry.event.set()

    timeout = _get_approval_config().get("gateway_timeout", 300)
    try:
        timeout = int(timeout)
    except (ValueError, TypeError):
        timeout = 300

    try:
        from tools.environments.base import touch_activity_if_due
    except Exception:  # pragma: no cover
        touch_activity_if_due = None

    now = time.monotonic()
    deadline = now + max(timeout, 0)
    activity_state = {"last_touch": now, "start": now}
    while not entry.event.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            retired = False
            with _lock:
                queue = _gateway_queues.get(session_key, [])
                if entry in queue:
                    queue.remove(entry)
                    if not queue:
                        _gateway_queues.pop(session_key, None)
                    entry.retired_reason = "timeout"
                    _remember_gateway_entry_completion_locked(session_key, entry, None)
                    retired = True
            if retired:
                entry.event.set()
                _emit_gateway_expiration(session_key, entry, "timeout")
            break
        entry.event.wait(timeout=min(1.0, remaining))
        if not entry.event.is_set() and touch_activity_if_due is not None:
            touch_activity_if_due(activity_state, "waiting for user approval")

    choice = entry.result
    resolved = choice is not None
    if owner:
        outcome = choice if resolved else (entry.retired_reason or "timeout")
        _fire_approval_hook(
            "post_approval_response",
            command=command,
            description=description,
            pattern_key=primary_key,
            pattern_keys=list(all_keys),
            session_key=session_key,
            surface=surface,
            choice=outcome,
        )
    return {
        "resolved": resolved,
        "choice": choice,
        "notify_failed": entry.notify_failed,
        "reason": entry.retired_reason,
    }


'''
    source = replace_region(
        source,
        "def _await_gateway_decision(session_key: str, notify_cb, approval_data: dict,\n",
        "def check_all_command_guards(command: str, env_type: str,\n",
        await_region,
        "approval wait protocol",
    )

    source = replace_once(
        source,
        '''def request_elicitation_consent(
    message: str,
    description: str,
    *,
    timeout_seconds: int | None = None,
    surface: str = "mcp-elicitation",
) -> str:
''',
        '''def request_elicitation_consent(
    message: str,
    description: str,
    *,
    timeout_seconds: int | None = None,
    surface: str = "mcp-elicitation",
    upstream_request_id=None,
    upstream_transport_id=None,
) -> str:
''',
        "elicitation signature",
    )
    source = replace_once(
        source,
        '''        approval_data = {
            "command": message,
            "description": description,
            "pattern_key": "mcp_elicitation",
            "pattern_keys": ["mcp_elicitation"],
        }
        try:
            decision = _await_gateway_decision(
                session_key, notify_cb, approval_data, surface=surface,
            )
''',
        '''        if isinstance(upstream_request_id, bool) or not isinstance(
            upstream_request_id, (str, int)
        ) or not str(upstream_request_id).strip():
            logger.warning("MCP elicitation has no valid upstream request id; failing closed")
            return "decline"
        if isinstance(upstream_transport_id, bool) or not isinstance(
            upstream_transport_id, (str, int)
        ) or not str(upstream_transport_id).strip():
            logger.warning("MCP elicitation has no valid transport identity; failing closed")
            return "decline"
        identity = "\\0".join(
            (surface, _approval_tool_call_id.get(), str(upstream_request_id))
        )
        request_id = "mcp-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
        logical_identity = "\\0".join(
            (surface, _approval_tool_call_id.get(), message, description)
        )
        dedup_key = "mcp-logical-" + hashlib.sha256(
            logical_identity.encode("utf-8")
        ).hexdigest()[:32]
        approval_data = {
            "command": message,
            "description": description,
            "pattern_key": "mcp_elicitation",
            "pattern_keys": ["mcp_elicitation"],
            "request_id": request_id,
            "allow_permanent": False,
        }
        try:
            decision = _await_gateway_decision(
                session_key,
                notify_cb,
                approval_data,
                surface=surface,
                request_id=request_id,
                dedup_key=dedup_key,
                upstream_transport_id=upstream_transport_id,
            )
''',
        "elicitation stable identity",
    )
    return source


def patch_mcp_tool(source: str) -> str:
    source = replace_once(
        source,
        '''        schema = getattr(params, "requested_schema", {}) or {}
        description = _format_elicitation_schema_summary(schema, self.server_name)

        logger.info(
''',
        '''        schema = getattr(params, "requested_schema", {}) or {}
        description = _format_elicitation_schema_summary(schema, self.server_name)
        upstream_request_id = getattr(context, "request_id", None)
        if isinstance(upstream_request_id, bool) or not isinstance(
            upstream_request_id, (str, int)
        ) or not str(upstream_request_id).strip():
            logger.warning(
                "MCP server '%s' elicitation has no valid request id; declining",
                self.server_name,
            )
            self.metrics["declined"] += 1
            return ElicitResult(action="decline")
        upstream_transport_id = id(getattr(context, "session", context))

        logger.info(
''',
        "MCP context request id",
    )
    source = source.replace(
        '''                    surface=f"mcp-elicitation/{self.server_name}",
                )
''',
        '''                    surface=f"mcp-elicitation/{self.server_name}",
                    upstream_request_id=upstream_request_id,
                    upstream_transport_id=upstream_transport_id,
                )
''',
    )
    source = replace_once(
        source,
        '''                timeout_seconds=int(self.timeout),
                surface=f"mcp-elicitation/{self.server_name}",
            )
''',
        '''                timeout_seconds=int(self.timeout),
                surface=f"mcp-elicitation/{self.server_name}",
                upstream_request_id=upstream_request_id,
                upstream_transport_id=upstream_transport_id,
            )
''',
        "captured MCP request id",
    )
    if source.count("upstream_request_id=upstream_request_id") != 2:
        raise RuntimeError("MCP request id: expected two consent call sites")
    if source.count("upstream_transport_id=upstream_transport_id") != 2:
        raise RuntimeError("MCP transport id: expected two consent call sites")
    return source


def patch_server(source: str) -> str:
    source = replace_once(
        source,
        '''# A handful of handlers block the dispatcher loop in entry.py for seconds
# to minutes (slash.exec, cli.exec, shell.exec, session.resume,
# session.branch, session.compress, skills.manage).  While they're running, inbound RPCs —
# notably approval.respond and session.interrupt — sit unread in the
# stdin pipe.  We route only those slow handlers onto a small thread pool;
# everything else stays on the main thread so ordering stays sane for the
# fast path.  write_json is already _stdout_lock-guarded, so concurrent
# response writes are safe.
''',
        '''# Blocking handlers run on a pool so approval and interrupt RPCs stay
# responsive. session.resume, session.activate, and prompt.submit use a
# dedicated single-worker ownership lane: snapshots and prompt admission retain
# receive order while dispatch owns each response write. Everything else stays
# on the main thread or general pool as before. write_json is
# _stdout_lock-guarded, so concurrent writes are safe.
''',
        "server live snapshot dispatch rationale",
    )
    source = replace_once(
        source,
        '''atexit.register(lambda: _pool.shutdown(wait=False, cancel_futures=True))
''',
        '''atexit.register(lambda: _pool.shutdown(wait=False, cancel_futures=True))

_LIVE_SNAPSHOT_HANDLERS = frozenset({"session.activate", "session.resume"})
_ORDERED_SESSION_OWNERSHIP_HANDLERS = _LIVE_SNAPSHOT_HANDLERS | {"prompt.submit"}
_live_snapshot_pool = concurrent.futures.ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="tui-live-snapshot",
)
atexit.register(
    lambda: _live_snapshot_pool.shutdown(wait=False, cancel_futures=True)
)
''',
        "server ordered live snapshot dispatch lane",
    )
    source = replace_once(
        source,
        '''def _emit(event: str, sid: str, payload: dict | None = None):
    params = {"type": event, "session_id": sid}
    if payload is not None:
        params["payload"] = payload
    write_json({"jsonrpc": "2.0", "method": "event", "params": params})
''',
        '''def _emit(
    event: str,
    sid: str,
    payload: dict | None = None,
    *,
    transport: Transport | None = None,
):
    params = {"type": event, "session_id": sid}
    if payload is not None:
        params["payload"] = payload
    frame = {"jsonrpc": "2.0", "method": "event", "params": params}
    if transport is not None:
        return transport.write(frame)
    return write_json(frame)


_PENDING_MESSAGE_COMPLETE_TEXT = "_june_pending_message_complete_text"
_PENDING_MESSAGE_COMPLETE_PAYLOAD = "_june_pending_message_complete_payload"
_DEFERRED_GOAL_FOLLOWUP = "_june_deferred_goal_followup"
_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER = (
    "_june_agent_run_continuation_snapshot_ack_barrier"
)
_LIVE_SNAPSHOT_ACK_TOKEN_RESULT = "_june_live_snapshot_ack_token"


def _clear_pending_message_complete(session: dict) -> None:
    session.pop(_PENDING_MESSAGE_COMPLETE_TEXT, None)
    session.pop(_PENDING_MESSAGE_COMPLETE_PAYLOAD, None)


def _message_complete_is_pending(session: dict) -> bool:
    return isinstance(session.get(_PENDING_MESSAGE_COMPLETE_PAYLOAD), dict)


def _agent_run_continuation_waits_for_snapshot_ack(session: dict) -> bool:
    return bool(session.get(_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER))


def _defer_goal_followup(session: dict, rid: Any, text: Any) -> None:
    followup = "" if text is None else str(text)
    if followup:
        session[_DEFERRED_GOAL_FOLLOWUP] = {
            "rid": rid,
            "snapshot_ack_delivered": False,
            "text": followup,
        }


def _release_agent_run_continuations_after_snapshot_ack(
    snapshot_result: dict,
    snapshot_ack_transport: Transport,
    snapshot_ack_token: object,
) -> None:
    # Dispatch calls this only after a session.resume or session.activate
    # snapshot is accepted by its transport. Keeping the wake-up behind that
    # write prevents a newly started continuation from racing ahead of the
    # live snapshot.
    result = snapshot_result.get("result") if isinstance(snapshot_result, dict) else None
    sid = str(result.get("session_id") or "") if isinstance(result, dict) else ""
    if not sid:
        return
    with _sessions_lock:
        session = _sessions.get(sid)
    if not isinstance(session, dict):
        return
    with session["history_lock"]:
        if session.get("transport") is not snapshot_ack_transport:
            return
        if session.get(_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER) is not snapshot_ack_token:
            return
        session.pop(_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER, None)
        followup = session.get(_DEFERRED_GOAL_FOLLOWUP)
        if isinstance(followup, dict):
            followup["snapshot_ack_delivered"] = True


def _take_deferred_goal_followup(session: dict) -> dict | None:
    # The notification poller is the durable wake-up path after a live handoff
    # retries the older completion. Claiming under history_lock preserves the
    # existing "user prompt wins" race and prevents two poller iterations from
    # starting the same continuation.
    with session["history_lock"]:
        if (
            session.get("running")
            or _message_complete_is_pending(session)
            or _agent_run_continuation_waits_for_snapshot_ack(session)
        ):
            return None
        followup = session.get(_DEFERRED_GOAL_FOLLOWUP)
        if (
            not isinstance(followup, dict)
            or not followup.get("snapshot_ack_delivered")
            or not str(followup.get("text") or "")
        ):
            return None
        session.pop(_DEFERRED_GOAL_FOLLOWUP, None)
        session["running"] = True
        return {"rid": followup.get("rid"), "text": followup["text"]}


def _content_bearing_assistant_texts(history: list[dict]) -> list[str]:
    return [
        str(message.get("text") or "")
        for message in _history_to_messages(history)
        if message.get("role") == "assistant"
        and str(message.get("text") or "").strip()
    ]


def _pending_message_complete_proof(
    history: list[dict], completed_text: Any
) -> dict | None:
    text = "" if completed_text is None else str(completed_text)
    if not text.strip():
        return None
    assistant_texts = _content_bearing_assistant_texts(history)
    # Exact final-row equality is deliberate. Anything else cannot prove which
    # persisted row an ID-less completion belongs to and must fail closed.
    if not assistant_texts or assistant_texts[-1] != text:
        return None
    return {"assistant_ordinal": len(assistant_texts) - 1}


def _mark_pending_message_complete(
    session: dict,
    previous_history: list[dict],
    history: list[dict],
    completed_text: Any,
) -> None:
    # Caller owns history_lock so committing the row and publishing this marker
    # are one transaction with the live snapshot and transport swap.
    # A later Agent run must never replace proof for an exact completion that no
    # transport has accepted. All later Agent run and continuation entry paths
    # defer while this is true; this guard keeps the invariant fail-closed if a
    # future path misses it.
    if _message_complete_is_pending(session):
        return
    session.pop(_PENDING_MESSAGE_COMPLETE_TEXT, None)
    previous_assistant_texts = _content_bearing_assistant_texts(previous_history)
    assistant_texts = _content_bearing_assistant_texts(history)
    # Text equality alone cannot distinguish a newly committed reply from an
    # unchanged earlier identical row. Require the exact previous assistant
    # sequence to remain a prefix and at least one new content-bearing row.
    if (
        len(assistant_texts) <= len(previous_assistant_texts)
        or assistant_texts[: len(previous_assistant_texts)]
        != previous_assistant_texts
    ):
        return
    if _pending_message_complete_proof(history, completed_text) is not None:
        session[_PENDING_MESSAGE_COMPLETE_TEXT] = str(completed_text)


def _deliver_message_complete(session: dict, sid: str, payload: dict) -> bool:
    # Keep selection, write, and outcome inside the same history-lock boundary
    # as _live_session_payload's transport swap. A failed Transport.write must
    # retain the exact payload and any available proof for a replacement.
    with session["history_lock"]:
        if _message_complete_is_pending(session):
            raise RuntimeError(
                "cannot replace an undelivered message.complete payload"
            )
        _clear_inflight_turn(session)
        session[_PENDING_MESSAGE_COMPLETE_PAYLOAD] = {
            "session_id": sid,
            "payload": payload,
        }
        transport = session.get("transport") or current_transport() or _stdio_transport
        delivered = bool(
            _emit("message.complete", sid, payload, transport=transport)
        )
        if delivered:
            _clear_pending_message_complete(session)
        return delivered


def _retry_pending_message_complete_locked(
    session: dict,
    transport: Transport,
    *,
    snapshot_ack_token: object | None = None,
) -> bool:
    pending = session.get(_PENDING_MESSAGE_COMPLETE_PAYLOAD)
    if not isinstance(pending, dict):
        return False
    delivered = bool(
        _emit(
            "message.complete",
            pending["session_id"],
            pending["payload"],
            transport=transport,
        )
    )
    if delivered:
        _clear_pending_message_complete(session)
        if snapshot_ack_token is not None:
            session[_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER] = snapshot_ack_token
    return delivered


def _retry_pending_message_complete(
    session: dict,
    transport: Transport,
    *,
    snapshot_ack_token: object | None = None,
) -> bool:
    # Original emission and resume retry use the same lock, so only one can
    # observe and successfully clear a retained payload.
    with session["history_lock"]:
        return _retry_pending_message_complete_locked(
            session,
            transport,
            snapshot_ack_token=snapshot_ack_token,
        )


def _bind_prompt_transport_for_submit(
    session: dict, request_transport: Transport | None
) -> bool:
    # Prompt submission never changes transport ownership. A different client
    # must complete session.resume or session.activate first so notifier
    # generation and snapshot authority move together.
    with session["history_lock"]:
        if (
            request_transport is None
            or _transport_is_dead(request_transport)
            or session.get("transport") is not request_transport
        ):
            return False
        if _agent_run_continuation_waits_for_snapshot_ack(session):
            return False
        _retry_pending_message_complete_locked(session, request_transport)
        return True
''',
        "server atomic pending-complete transport proof",
    )
    source = replace_once(
        source,
        '''def _live_session_payload(
    sid: str,
    session: dict,
    *,
    cols: int | None = None,
    touch: bool = False,
    transport: Transport | None = None,
) -> dict:
''',
        '''def _live_session_payload(
    sid: str,
    session: dict,
    *,
    cols: int | None = None,
    touch: bool = False,
    transport: Transport | None = None,
    agent_run_continuation_snapshot_ack_transport: Transport | None = None,
) -> dict:
    snapshot_ack_token = (
        {"transport": agent_run_continuation_snapshot_ack_transport}
        if agent_run_continuation_snapshot_ack_transport is not None
        else None
    )
''',
        "server live-snapshot Agent run continuation acknowledgement argument",
    )
    source = replace_once(
        source,
        '''        if transport is not None:
            session["transport"] = transport
        if touch:
''',
        '''        if (
            agent_run_continuation_snapshot_ack_transport is not None
            and transport is not agent_run_continuation_snapshot_ack_transport
        ):
            raise RuntimeError("live snapshot acknowledgement transport mismatch")
        if transport is not None:
            existing_snapshot_ack_token = session.get(
                _AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER
            )
            existing_snapshot_ack_transport = (
                existing_snapshot_ack_token.get("transport")
                if isinstance(existing_snapshot_ack_token, dict)
                else None
            )
            if (
                existing_snapshot_ack_token is not None
                and existing_snapshot_ack_transport is not transport
                and snapshot_ack_token is None
            ):
                raise RuntimeError(
                    "cannot replace transport while a live snapshot acknowledgement is pending"
                )
            session["transport"] = transport
        if snapshot_ack_token is not None:
            # Arm or retarget in the same history-lock transaction as the
            # transport swap and live snapshot. No Agent run continuation can
            # claim the gap between a completion write and acknowledgement of
            # that snapshot.
            session[_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER] = snapshot_ack_token
        if touch:
''',
        "server live-snapshot Agent run continuation acknowledgement barrier",
    )
    source = replace_once(
        source,
        '''        inflight = _inflight_snapshot(session)
        running = bool(session.get("running"))
    payload = {
        "info": _fallback_session_info(session),
        "message_count": len(history),
        "messages": _history_to_messages(history),
''',
        '''        inflight = _inflight_snapshot(session)
        running = bool(session.get("running"))
        pending_message_complete_text = session.get(_PENDING_MESSAGE_COMPLETE_TEXT)
    messages = _history_to_messages(history)
    payload = {
        "info": _fallback_session_info(session),
        "message_count": len(history),
        "messages": messages,
''',
        "server resume pending-complete snapshot",
    )
    source = replace_once(
        source,
        '''    if inflight:
        payload["inflight"] = inflight
    return payload
''',
        '''    if inflight:
        payload["inflight"] = inflight
    pending_message_complete = _pending_message_complete_proof(
        history, pending_message_complete_text
    )
    if pending_message_complete is not None:
        payload["pending_message_complete"] = pending_message_complete
    if snapshot_ack_token is not None:
        # Dispatch removes this process-local token before serializing the
        # response, then uses its identity to release only this exact snapshot.
        payload[_LIVE_SNAPSHOT_ACK_TOKEN_RESULT] = snapshot_ack_token
    return payload


def _handoff_live_session_transport(
    sid: str,
    session: dict,
    transport: Transport,
    *,
    cols: int | None = None,
) -> dict:
    """Retarget every transport-owned live-session channel under the caller's lock."""
    if _transport_is_dead(transport):
        raise RuntimeError("live session request transport disconnected")
    previous_transport = session.get("transport")
    payload = _live_session_payload(
        sid,
        session,
        cols=cols,
        touch=True,
        transport=transport,
        agent_run_continuation_snapshot_ack_transport=transport,
    )
    snapshot_ack_token = payload.get(_LIVE_SNAPSHOT_ACK_TOKEN_RESULT)
    retired_request_ids = []
    if previous_transport is not transport:
        from tools.approval import replace_gateway_notify

        if key := session.get("session_key"):
            retired_request_ids = replace_gateway_notify(
                key,
                lambda data: _emit("approval.request", sid, data),
                lambda data: _emit("approval.expire", sid, data),
            )
    _retry_pending_message_complete(
        session,
        transport,
        snapshot_ack_token=snapshot_ack_token,
    )
    payload["retired_approval_request_ids"] = retired_request_ids
    return payload
''',
        "server resume pending-complete response",
    )
    activation_handler = '''@method("session.activate")
def _(rid, params: dict) -> dict:
    """Attach the frontend to an already-live TUI session.

    This intentionally does not close the previously focused session; it merely
    returns enough state for Ink to redraw around another live session id.
    """
    sid = str(params.get("session_id") or "")
    activate_transport = current_transport() or _stdio_transport
    with _session_resume_lock:
        # Close and disconnect cleanup use the same ownership lock. Re-read the
        # registry under it so a stale pre-lock dict cannot be reactivated after
        # finalization or removal.
        with _sessions_lock:
            session = _sessions.get(sid)
        if not isinstance(session, dict) or session.get("_finalized"):
            return _err(rid, 4001, "session not found")
        payload = _handoff_live_session_transport(
            sid,
            session,
            activate_transport,
        )
    return _ok(rid, payload)


'''
    source = replace_region(
        source,
        '@method("session.activate")\n',
        '@method("session.delete")\n',
        activation_handler,
        "server activation transport handoff",
    )
    source = replace_once(
        source,
        '''                        if current_version == history_version:
                            session["history"] = result["messages"]
                            session["history_version"] = history_version + 1
''',
        '''                        if current_version == history_version:
                            session["history"] = result["messages"]
                            session["history_version"] = history_version + 1
                            proof_history_prefix = list(
                                session.get("display_history_prefix") or []
                            )
                            _mark_pending_message_complete(
                                session,
                                proof_history_prefix + list(history),
                                proof_history_prefix + list(result["messages"]),
                                result.get("final_response", ""),
                            )
''',
        "server pending-complete history commit",
    )
    source = replace_once(
        source,
        '''            with session["history_lock"]:
                _clear_inflight_turn(session)
            _emit("message.complete", sid, payload)
''',
        '''            _deliver_message_complete(session, sid, payload)
''',
        "server atomic message-complete delivery",
    )
    source = replace_once(
        source,
        '''    if (t := current_transport()) is not None:
        session["transport"] = t
    with session["history_lock"]:
        if session.get("running"):
''',
        '''    request_transport = current_transport()
    if not _bind_prompt_transport_for_submit(session, request_transport):
        return _err(rid, 4009, "session snapshot acknowledgement still settling")
    with session["history_lock"]:
        if _message_complete_is_pending(session):
            return _err(rid, 4009, "previous completion awaiting reconnect")
        if _agent_run_continuation_waits_for_snapshot_ack(session):
            return _err(rid, 4009, "session snapshot acknowledgement still settling")
        if session.get("running"):
''',
        "server prompt retry before next Agent run",
    )
    source = replace_once(
        source,
        '''        session["running"] = True
        session["last_active"] = time.time()
        _start_inflight_turn(session, text)
''',
        '''        # A real user prompt wins over a deferred goal continuation,
        # matching the existing race semantics after the prior completion lands.
        session.pop(_DEFERRED_GOAL_FOLLOWUP, None)
        session["running"] = True
        session["last_active"] = time.time()
        _start_inflight_turn(session, text)
''',
        "server user prompt wins deferred goal",
    )
    prompt_admission = '''    # Prompt transport and Agent run admission form one ownership transaction.
    # A different client must finish a live snapshot handoff first; prompt.submit
    # cannot move only the stream while leaving approval notifier authority behind.
    request_transport = current_transport()
    with _session_resume_lock:
        with _sessions_lock:
            registered_session = _sessions.get(sid)
        if registered_session is not session or session.get("_finalized"):
            return _err(rid, 4001, "session not found")
        if not _bind_prompt_transport_for_submit(session, request_transport):
            return _err(rid, 4009, "session transport handoff required")
        with session["history_lock"]:
            if _message_complete_is_pending(session):
                return _err(rid, 4009, "previous completion awaiting reconnect")
            if _agent_run_continuation_waits_for_snapshot_ack(session):
                return _err(rid, 4009, "session snapshot acknowledgement still settling")
            if session.get("running"):
                return _err(rid, 4009, "session busy")
            # A watch session's run lives in the PARENT turn, so its own running
            # flag is False — without this, typing mid-run builds a second agent
            # racing the in-flight child on the same stored session (interleaved
            # transcript, stale fork). After the run completes, submitting is fine:
            # the upgrade resumes the child's transcript as a normal conversation.
            if session.get("lazy") and _child_run_active(
                str(session.get("session_key") or "")
            ):
                return _err(rid, 4009, "subagent still running — wait for it to finish")
            if truncate_user_ordinal is not None:
                try:
                    ordinal = int(truncate_user_ordinal)
                except (TypeError, ValueError):
                    return _err(
                        rid,
                        4004,
                        "truncate_before_user_ordinal must be an integer",
                    )
                history = session.get("history", [])
                user_indices = [
                    i for i, message in enumerate(history)
                    if message.get("role") == "user"
                ]
                if ordinal >= len(user_indices):
                    return _err(
                        rid,
                        4018,
                        "target user message is no longer in session history",
                    )
                truncated = history[: user_indices[ordinal]]
                session["history"] = truncated
                session["history_version"] = int(
                    session.get("history_version", 0)
                ) + 1
                if (db := _get_db()) is not None:
                    try:
                        db.replace_messages(session["session_key"], truncated)
                    except Exception as exc:
                        print(
                            f"[tui_gateway] prompt.submit: replace_messages failed: {exc}",
                            file=sys.stderr,
                        )
            # A real user prompt wins over a deferred goal continuation,
            # matching the existing race semantics after the prior completion lands.
            session.pop(_DEFERRED_GOAL_FOLLOWUP, None)
            session["running"] = True
            session["last_active"] = time.time()
            _start_inflight_turn(session, text)
'''
    source = replace_region(
        source,
        "    # Re-bind to the current client transport for this request.",
        "\n    # Persist the DB row lazily",
        prompt_admission,
        "server prompt ownership admission",
    )
    source = replace_once(
        source,
        '''    Returns a response dict when handled inline. Returns None when the
    handler was scheduled on the pool; the worker writes its own response
    via the bound transport when done.
''',
        '''    Returns a response dict for ordinary inline handlers. Pool handlers
    return None and write from their worker. Live snapshots and prompt admission
    share a single-worker ownership lane so response order matches request receipt.
''',
        "server activation dispatch contract",
    )
    source = replace_once(
        source,
        '''        _rid, method, _params = normalized
        if method not in _LONG_HANDLERS:
            return handle_request(req)
''',
        '''        _rid, method, _params = normalized

        def write_response(resp: dict) -> None:
            snapshot_ack_token = None
            if method in {"session.activate", "session.resume"}:
                result = resp.get("result") if isinstance(resp, dict) else None
                if isinstance(result, dict):
                    snapshot_ack_token = result.pop(
                        _LIVE_SNAPSHOT_ACK_TOKEN_RESULT, None
                    )
            snapshot_ack_delivered = t.write(resp)
            if snapshot_ack_delivered and snapshot_ack_token is not None:
                _release_agent_run_continuations_after_snapshot_ack(
                    resp, t, snapshot_ack_token
                )

        if (
            method not in _LONG_HANDLERS
            and method not in _ORDERED_SESSION_OWNERSHIP_HANDLERS
        ):
            return handle_request(req)
''',
        "server receive-ordered live snapshot acknowledgement",
    )
    source = replace_once(
        source,
        '''            if resp is not None:
                t.write(resp)
''',
        '''            if resp is not None:
                write_response(resp)
''',
        "server live snapshot acknowledgement ordered before deferred goal",
    )
    source = replace_once(
        source,
        '''        _pool.submit(lambda: ctx.run(run))
''',
        '''        dispatch_pool = (
            _live_snapshot_pool
            if method in _ORDERED_SESSION_OWNERSHIP_HANDLERS
            else _pool
        )
        dispatched = dispatch_pool.submit(lambda: ctx.run(run))
        if method == "prompt.submit":
            # Preserve prompt.submit's synchronous handler lifetime while still
            # admitting it behind earlier snapshots in the ordered lane.
            dispatched.result()
''',
        "server ordered live snapshot pool selection",
    )
    source = replace_once(
        source,
        '''    with _sessions_lock:
        owned = [(sid, s) for sid, s in _sessions.items() if s.get("transport") is transport]
    reaped = 0
    detached = 0
    for sid, session in owned:
        if session.get("close_on_disconnect"):
            _close_session_by_id(sid, end_reason=end_reason)
            reaped += 1
        else:
            # Point detached sessions at the drop sentinel (NOT real stdio) so
            # _ws_session_is_orphaned recognizes them and the grace-reap can
            # actually fire; a standalone `hermes --tui` keeps real _stdio.
            session["transport"] = _detached_ws_transport
            detached += 1
            try:
                _schedule_ws_orphan_reap(sid)
            except Exception:
                pass
''',
        '''    reaped = 0
    detached = 0
    # Snapshot and detach under the same ownership lock used by every resume
    # and activation commit. A request either commits before this snapshot and
    # is cleaned up, or observes the closed transport before it can commit.
    with _session_resume_lock:
        with _sessions_lock:
            owned = [
                (sid, session)
                for sid, session in _sessions.items()
                if session.get("transport") is transport
            ]
        for sid, session in owned:
            with _sessions_lock:
                if _sessions.get(sid) is not session:
                    continue
                if session.get("transport") is not transport:
                    continue
                close_on_disconnect = bool(session.get("close_on_disconnect"))
                if not close_on_disconnect:
                    session["transport"] = _detached_ws_transport
            if close_on_disconnect:
                if _close_session_by_id(sid, end_reason=end_reason):
                    reaped += 1
            else:
                # Point detached sessions at the drop sentinel (NOT real stdio)
                # so the grace reaper recognizes them. Drain approvals while the
                # same resume lock still protects the transport boundary.
                detached += 1
                try:
                    from tools.approval import unregister_gateway_notify

                    if key := session.get("session_key"):
                        unregister_gateway_notify(key)
                except Exception:
                    pass
                try:
                    _schedule_ws_orphan_reap(sid)
                except Exception:
                    pass
''',
        "server disconnect ownership and approval drain",
    )
    source = replace_once(
        source,
        '''def _reap_idle_sessions() -> None:
    now = time.time()
    with _sessions_lock:
        victims = [sid for sid, s in _sessions.items() if _session_is_evictable(sid, s, now)]
    for sid in victims:
        _close_session_by_id(sid, end_reason="idle_timeout")
''',
        '''def _reap_idle_sessions() -> None:
    now = time.time()
    # A stale victim snapshot must not finalize a session that a live snapshot
    # handoff has rebound. Recheck identity and evictability under the same
    # ownership lock used by resume and activation commits.
    with _session_resume_lock:
        with _sessions_lock:
            victims = [
                (sid, session)
                for sid, session in _sessions.items()
                if _session_is_evictable(sid, session, now)
            ]
        for sid, session in victims:
            with _sessions_lock:
                if _sessions.get(sid) is not session:
                    continue
            if not _session_is_evictable(sid, session, now):
                continue
            _close_session_by_id(sid, end_reason="idle_timeout")
''',
        "server idle reap ownership recheck",
    )
    source = replace_once(
        source,
        '''                register_gateway_notify(
                    key, lambda data: _emit("approval.request", sid, data)
                )
''',
        '''                register_gateway_notify(
                    key,
                    lambda data: _emit("approval.request", sid, data),
                    lambda data: _emit("approval.expire", sid, data),
                )
''',
        "server create approval callbacks",
    )
    source = replace_once(
        source,
        '''            register_gateway_notify(
                new_session_id,
                lambda data: _emit("approval.request", sid, data),
            )
''',
        '''            register_gateway_notify(
                new_session_id,
                lambda data: _emit("approval.request", sid, data),
                lambda data: _emit("approval.expire", sid, data),
            )
''',
        "server continuation approval callbacks",
    )
    source = replace_once(
        source,
        '''        register_gateway_notify(key, lambda data: _emit("approval.request", sid, data))
''',
        '''        register_gateway_notify(
            key,
            lambda data: _emit("approval.request", sid, data),
            lambda data: _emit("approval.expire", sid, data),
        )
''',
        "server exec approval callbacks",
    )
    source = replace_once(
        source,
        '''    _emitted = set()  # dedup re-queued events so same completion isn't emitted 50 times while session is busy
    while not stop_event.is_set() and not session.get("_finalized"):
        try:
            evt = process_registry.completion_queue.get(timeout=0.5)
''',
        '''    _emitted = set()  # dedup re-queued events so same completion isn't emitted 50 times while session is busy
    while not stop_event.is_set() and not session.get("_finalized"):
        # Goal continuations blocked by an undelivered message.complete stay on
        # the session until resume retries that exact frame. This existing
        # long-lived poller wakes them without racing the live snapshot acknowledgement.
        deferred_goal = _take_deferred_goal_followup(session)
        if deferred_goal is not None:
            try:
                _emit("message.start", sid)
                _run_prompt_submit(
                    deferred_goal["rid"], sid, session, deferred_goal["text"]
                )
            except Exception as exc:
                print(
                    f"[tui_gateway] deferred goal dispatch failed: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                with session["history_lock"]:
                    session["running"] = False
                    _defer_goal_followup(
                        session, deferred_goal["rid"], deferred_goal["text"]
                    )
                time.sleep(0.1)
            continue
        try:
            evt = process_registry.completion_queue.get(timeout=0.5)
''',
        "server deferred goal poller wake-up",
    )
    source = replace_once(
        source,
        '''        with session["history_lock"]:
            if session.get("running"):
                process_registry.completion_queue.put(evt)
                continue
            session["running"] = True
''',
        '''        defer_notification = False
        with session["history_lock"]:
            if (
                session.get("running")
                or _message_complete_is_pending(session)
                or _agent_run_continuation_waits_for_snapshot_ack(session)
                or _DEFERRED_GOAL_FOLLOWUP in session
            ):
                process_registry.completion_queue.put(evt)
                defer_notification = True
            else:
                session["running"] = True
        if defer_notification:
            # The shared queue can hand this poller the same event immediately.
            # Back off outside history_lock so reconnect and sibling sessions
            # can make progress instead of spinning on a retained completion.
            time.sleep(0.1)
            continue
''',
        "server notification poller pending-complete deferral",
    )
    source = replace_once(
        source,
        '''        with session["history_lock"]:
            if session.get("running"):
                process_registry.completion_queue.put(evt)
                break
            session["running"] = True
''',
        '''        with session["history_lock"]:
            if (
                session.get("running")
                or _message_complete_is_pending(session)
                or _agent_run_continuation_waits_for_snapshot_ack(session)
                or _DEFERRED_GOAL_FOLLOWUP in session
            ):
                process_registry.completion_queue.put(evt)
                break
            session["running"] = True
''',
        "server notification shutdown-drain pending-complete deferral",
    )
    source = replace_once(
        source,
        '''@method("session.resume")
def _(rid, params: dict) -> dict:
    target = params.get("session_id", "")
    if not target:
        return _err(rid, 4006, "session_id required")
''',
        '''@method("session.resume")
def _(rid, params: dict) -> dict:
    target = params.get("session_id", "")
    if not target:
        return _err(rid, 4006, "session_id required")
    resume_transport = current_transport() or _stdio_transport
    if _transport_is_dead(resume_transport):
        return _err(rid, 4009, "request transport disconnected")
''',
        "server resume request transport capture",
    )
    source = replace_once(
        source,
        '''    def _reuse_live_payload(sid: str, session: dict) -> dict:
        payload = _live_session_payload(
            sid,
            session,
            cols=cols,
            touch=True,
            transport=current_transport() or _stdio_transport,
        )
        payload["resumed"] = target
''',
        '''    def _reuse_live_payload(sid: str, session: dict) -> dict:
        payload = _handoff_live_session_transport(
            sid,
            session,
            resume_transport,
            cols=cols,
        )
        payload["resumed"] = target
''',
        "server resume approval handoff",
    )
    source = replace_once(
        source,
        '''        with _session_resume_lock:
            live = _find_live_session_by_key(target)
            if live is not None:
                if lease is not None:
                    lease.release()
                return _ok(rid, _reuse_live_payload(*live))
            with _sessions_lock:
''',
        '''        with _session_resume_lock:
            if _transport_is_dead(resume_transport):
                if lease is not None:
                    lease.release()
                return _err(rid, 4009, "request transport disconnected")
            live = _find_live_session_by_key(target)
            if live is not None:
                if lease is not None:
                    lease.release()
                return _ok(rid, _reuse_live_payload(*live))
            with _sessions_lock:
''',
        "server lazy resume dead transport commit guard",
    )
    source = replace_once(
        source,
        '''                    "tool_progress_mode": _load_tool_progress_mode(),
                    "tool_started_at": {},
                    "transport": current_transport() or _stdio_transport,
''',
        '''                    "tool_progress_mode": _load_tool_progress_mode(),
                    "tool_started_at": {},
                    "transport": resume_transport,
''',
        "server lazy resume captured transport",
    )
    source = replace_once(
        source,
        '''    # Double-checked locking: another concurrent resume may have created the
    # live session while we were building. Re-check under the lock; if it won,
    # discard our just-built agent and reuse theirs (no worker/poller wired yet).
    with _session_resume_lock:
        live = _find_live_session_by_key(target)
''',
        '''    # Double-checked locking: another concurrent resume may have created the
    # live session while we were building. Re-check under the lock; if it won,
    # discard our just-built agent and reuse theirs (no worker/poller wired yet).
    with _session_resume_lock:
        if _transport_is_dead(resume_transport):
            try:
                if hasattr(agent, "close"):
                    agent.close()
            except Exception:
                pass
            if lease is not None:
                lease.release()
            return _err(rid, 4009, "request transport disconnected")
        live = _find_live_session_by_key(target)
''',
        "server rebuilt resume dead transport commit guard",
    )
    source = replace_once(
        source,
        '''            other_sid, other_session = live
            payload = _live_session_payload(
                other_sid,
                other_session,
                cols=cols,
                touch=True,
                transport=current_transport() or _stdio_transport,
            )
            payload["resumed"] = target
            return _ok(rid, payload)
''',
        '''            other_sid, other_session = live
            return _ok(rid, _reuse_live_payload(other_sid, other_session))
''',
        "server concurrent resume approval handoff",
    )
    source = replace_once(
        source,
        '''        if goal_followup:
            with session["history_lock"]:
                if session.get("running"):
                    # User already sent something — their turn wins,
                    # the judge will re-run on the next turn anyway.
                    return
                session["running"] = True
            try:
                _emit("message.start", sid)
                _run_prompt_submit(rid, sid, session, goal_followup)
            except Exception as _cont_exc:
                print(
                    f"[tui_gateway] goal continuation dispatch failed: "
                    f"{type(_cont_exc).__name__}: {_cont_exc}",
                    file=sys.stderr,
                )
                with session["history_lock"]:
                    session["running"] = False
''',
        '''        if goal_followup:
            dispatch_goal_followup = False
            with session["history_lock"]:
                if session.get("running"):
                    # User already sent something — their turn wins,
                    # the judge will re-run on the next turn anyway.
                    return
                if (
                    _message_complete_is_pending(session)
                    or _agent_run_continuation_waits_for_snapshot_ack(session)
                ):
                    _defer_goal_followup(session, rid, goal_followup)
                else:
                    session["running"] = True
                    dispatch_goal_followup = True
            if dispatch_goal_followup:
                try:
                    _emit("message.start", sid)
                    _run_prompt_submit(rid, sid, session, goal_followup)
                except Exception as _cont_exc:
                    print(
                        f"[tui_gateway] goal continuation dispatch failed: "
                        f"{type(_cont_exc).__name__}: {_cont_exc}",
                        file=sys.stderr,
                    )
                    with session["history_lock"]:
                        session["running"] = False
''',
        "server goal continuation pending-complete deferral",
    )
    source = replace_once(
        source,
        '''            for _evt, synth in process_registry.drain_notifications():
                with session["history_lock"]:
                    if session.get("running"):
                        process_registry.completion_queue.put(_evt)
                        break
                    session["running"] = True
''',
        '''            for _evt, synth in process_registry.drain_notifications():
                with session["history_lock"]:
                    if (
                        session.get("running")
                        or _message_complete_is_pending(session)
                        or _agent_run_continuation_waits_for_snapshot_ack(session)
                        or _DEFERRED_GOAL_FOLLOWUP in session
                    ):
                        process_registry.completion_queue.put(_evt)
                        # drain_notifications() already removed the full batch.
                        # Requeue every blocked event instead of dropping the
                        # remainder after the first one.
                        continue
                    session["running"] = True
''',
        "server completion drain pending-complete deferral",
    )

    handler = r'''@method("approval.respond")
def _(rid, params: dict) -> dict:
    session, err = _sess(params, rid)
    if err:
        return err
    request_id = params.get("request_id")
    if request_id is not None and (
        not isinstance(request_id, str) or not request_id.strip()
    ):
        return _err(rid, 4002, "approval.respond request_id must be a non-empty string")
    choice = params.get("choice", "deny")
    if choice not in ("once", "session", "always", "deny"):
        return _err(rid, 4002, "approval.respond choice is invalid")
    try:
        from tools.approval import resolve_gateway_approval

        resolved = resolve_gateway_approval(
            session["session_key"],
            choice,
            resolve_all=params.get("all", False) if request_id is None else False,
            request_id=request_id,
        )
        if resolved == 1 and request_id:
            _emit(
                "approval.response",
                params.get("session_id", ""),
                {"request_id": request_id, "choice": choice},
            )
        return _ok(rid, {"resolved": resolved})
    except Exception as e:
        return _err(rid, 5004, str(e))


'''
    source = replace_region(
        source,
        '@method("approval.respond")\n',
        '@method("config.set")\n',
        handler,
        "targeted approval response",
    )
    return source


PATCHERS: Dict[str, Callable[[str], str]] = {
    "tools/approval.py": patch_approval,
    "tools/mcp_tool.py": patch_mcp_tool,
    "tui_gateway/server.py": patch_server,
}


def apply(root: Path, verify_only: bool) -> Dict[str, str]:
    observed: Dict[str, str] = {}
    for relative, patcher in PATCHERS.items():
        path = root / relative
        if not path.is_file():
            raise RuntimeError("missing pinned Hermes file: %s" % path)
        current = sha256(path)
        patched = PATCHED_SHA256[relative]
        if patched and current == patched:
            observed[relative] = current
            continue
        if current != UPSTREAM_SHA256[relative]:
            raise RuntimeError(
                "%s hash mismatch: expected upstream %s or patched %s, got %s"
                % (relative, UPSTREAM_SHA256[relative], patched or "<unsealed>", current)
            )
        if verify_only:
            raise RuntimeError("%s is still unpatched" % relative)
        transformed = patcher(path.read_text(encoding="utf-8"))
        # Write bytes so Python 3.9 (the macOS system interpreter) works and
        # Windows cannot translate LF into CRLF before the sealed hash check.
        path.write_bytes(transformed.encode("utf-8"))
        observed[relative] = sha256(path)
        if patched and observed[relative] != patched:
            raise RuntimeError(
                "%s patched hash mismatch: expected %s, got %s"
                % (relative, patched, observed[relative])
            )
    return observed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--print-hashes", action="store_true")
    args = parser.parse_args()
    try:
        hashes = apply(args.root.resolve(), args.verify)
    except Exception as exc:
        print("Hermes patch set %s failed: %s" % (PATCH_SET, exc), file=sys.stderr)
        return 1
    if args.print_hashes:
        for relative in sorted(hashes):
            print('%s = "%s"' % (relative, hashes[relative]))
    else:
        print("Hermes patch set %s verified" % PATCH_SET)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
