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


PATCH_SET = "june-approval-memory-v14"

UPSTREAM_SHA256: Dict[str, str] = {
    "agent/agent_init.py": "7e90d8202794bec74c05285018a211e596abdf66b75b662d1b6b1618da2a7f7b",
    "tools/approval.py": "e31abc88357afa28c05f3a4753ea9908b540b0dfef8dab2fa62960ae19a63c85",
    "tools/mcp_tool.py": "3f0aca90d076a1b0aa5daffd7bb39b0d1a4fee83265f855e68d556e5c8a29d01",
    "tui_gateway/server.py": "1743cec5c6684651d2b7cb18b7b73a37ea99538a4f56bcd8476700ce23d4f01a",
    "utils.py": "572b08bcbdf4a37116f49d1fc72d22854897a5fd8968c2d358103a97589c206c",
    "gateway/platforms/telegram.py": "3943dc748827f81bf4e40a2a6711e4dfb6f65304bff552474ffbc23fd91e23a6",
}

# Filled after applying the transformations to the exact upstream files. These
# hashes are part of the runtime provenance contract, not best-effort checks.
PATCHED_SHA256: Dict[str, str] = {
    "agent/agent_init.py": "58e0f7294cea8d778b15827af4e0a1d5c2d9e0a2db27b2a6697f30811053629e",
    "tools/approval.py": "daaac4cbc6adfffd3a8cbd8442d3cc0c26bc499725e395cf837607dbcebc46d8",
    "tools/mcp_tool.py": "48a2fddfee5d5a8c33723e27639907e9f2cf062c82e7beeb844f457e6a372cfa",
    "tui_gateway/server.py": "ee9806275e5b5706cadc58151b894d54351057d57f158d36a94e66080263a742",
    "utils.py": "08a0a0203bdee74eb8bc4f8bc31e97eb7621913deca2d087fb56c722b1304ef5",
    "gateway/platforms/telegram.py": "fd996e2deaebe3ca2856167876f8ff498735744ff7c884eedd85736a7fd2c318",
}

# These policy files are not transformed, but their exact bytes are part of
# the patch set's provenance contract. June relies on this pinned scheduler
# layering and final deny subtraction to make agent.disabled_toolsets win over
# every stored per-job allowlist.
POLICY_SHA256: Dict[str, str] = {
    "cron/scheduler.py": "2d82e4958494b52bcae27527e8ad64f0b730d22906e725609fda7725b410abfa",
    "model_tools.py": "d7628473ee72f7ac1395f9f2fe43dc2956523b186545bf6abece1b834ac6892d",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError("%s: expected one match, found %d" % (label, count))
    return source.replace(old, new, 1)


def replace_count(
    source: str, old: str, new: str, expected: int, label: str
) -> str:
    count = source.count(old)
    if count != expected:
        raise RuntimeError(
            "%s: expected %d matches, found %d" % (label, expected, count)
        )
    return source.replace(old, new)


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
        '''    lock = session.setdefault("agent_build_lock", threading.Lock())
    with lock:
        if ready.is_set() or session.get("agent_build_started"):
            return
        session["agent_build_started"] = True
        # An upgrading lazy session is now genuinely mid-construction — restore
        # its "still starting" eviction exemption.
        session.pop("lazy", None)
    key = session["session_key"]

    def _build() -> None:
''',
        '''    lock = session.setdefault("agent_build_lock", threading.Lock())
    # Reset is the only event that invalidates a lazy Hermes build. Capture its
    # epoch while also checking whether reset already installed a replacement.
    with session["history_lock"]:
        if session.get("agent") is not None:
            # A prebuilt session may synthesize readiness, but an in-progress
            # lazy build owns its ready event until slash worker and callback
            # publication finishes. Do not expose its early instance assignment.
            if not session.get("agent_build_started"):
                ready.set()
            return
        build_epoch = int(session.get("reset_generation", 0))
        with lock:
            if ready.is_set() or session.get("agent_build_started"):
                return
            session["agent_build_started"] = True
            # An upgrading lazy session is now genuinely mid-construction — restore
            # its "still starting" eviction exemption.
            session.pop("lazy", None)
    key = session["session_key"]

    def _build() -> None:
''',
        "Hermes build reset epoch capture",
    )
    source = replace_once(
        source,
        '''        if current is None:
            ready.set()
            return

        worker = None
''',
        '''        if current is None:
            ready.set()
            return

        worker = None
        publication_lock = None
        state_lock = None
''',
        "Hermes build publication lock state",
    )
    source = replace_once(
        source,
        '''            finally:
                _clear_session_context(tokens)

            # Session DB row deferred to first run_conversation() call.
            # pending_title applied post-first-message (see cli.exec handler).
            current["agent"] = agent
            # Baseline for the per-turn config sync; the profile home
            # override is still active here.
            current["config_model_seen"] = _config_model_target()
''',
        '''            finally:
                _clear_session_context(tokens)

            # The slow Hermes construction stays outside both locks so image
            # bytes remain attachable immediately. A dedicated publication lock
            # serializes this completion phase with reset without participating
            # in the _sessions_lock -> history_lock teardown order.
            publication_lock = current.setdefault(
                "agent_publication_lock", threading.Lock()
            )
            publication_lock.acquire()
            state_lock = current["history_lock"]
            state_lock.acquire()
            if int(current.get("reset_generation", 0)) != build_epoch:
                state_lock.release()
                state_lock = None
                try:
                    if hasattr(agent, "close"):
                        agent.close()
                except Exception:
                    pass
                return

            # Session DB row deferred to first run_conversation() call.
            # pending_title applied post-first-message (see cli.exec handler).
            current["agent"] = agent
            # Baseline for the per-turn config sync; the profile home
            # override is still active here.
            current["config_model_seen"] = _config_model_target()
            # The remaining setup can acquire _sessions_lock. Release the state
            # lock first so concurrent close/eviction cannot deadlock by holding
            # _sessions_lock while waiting for history_lock. publication_lock
            # continues to fence reset until the worker and callbacks are ready.
            state_lock.release()
            state_lock = None
''',
        "Hermes build reset epoch publication",
    )
    source = replace_once(
        source,
        '''        except Exception as e:
            current["agent_error"] = str(e)
            _emit("error", sid, {"message": f"agent init failed: {e}"})
        finally:
''',
        '''        except Exception as e:
            if state_lock is not None:
                if int(current.get("reset_generation", 0)) == build_epoch:
                    current["agent_error"] = str(e)
                    _emit("error", sid, {"message": f"June initialization failed: {e}"})
            else:
                with current["history_lock"]:
                    if int(current.get("reset_generation", 0)) == build_epoch:
                        current["agent_error"] = str(e)
                        _emit("error", sid, {"message": f"June initialization failed: {e}"})
        finally:
''',
        "Hermes build reset epoch error fence",
    )
    source = replace_once(
        source,
        '''            ready.set()

    threading.Thread(target=_build, daemon=True).start()
''',
        '''            if state_lock is not None:
                state_lock.release()
            if publication_lock is not None:
                publication_lock.release()
            ready.set()

    threading.Thread(target=_build, daemon=True).start()
''',
        "Hermes build publication lock release",
    )
    source = replace_once(
        source,
        '''        identify PNG/JPEG/GIF/WebP/BMP, falling back to ``.png``.
    """
    session, err = _sess(params, rid)
    if err:
        return err
''',
        '''        identify PNG/JPEG/GIF/WebP/BMP, falling back to ``.png``.
    """
    # Persisting attachment bytes only needs the lightweight runtime session
    # created by session.create. Waiting for full Hermes initialization here
    # makes the first image in a new session time out before prompt.submit can
    # start the agent run.
    session, err = _sess_nowait(params, rid)
    if err:
        return err
''',
        "image byte attach without Hermes initialization",
    )
    source = replace_once(
        source,
        '''def _queue_attached_image(session: dict, img_bytes: bytes, ext: str, *, prefix: str) -> Path:
''',
        '''class _ImageAttachInitializationError(RuntimeError):
    """Hermes initialization failed while atomically claiming an image queue."""


def _queue_attached_image(
    session: dict,
    img_bytes: bytes,
    ext: str,
    *,
    prefix: str,
    fail_on_initialization_error: bool = False,
) -> Path:
''',
        "image queue initialization error type",
    )
    source = replace_once(
        source,
        '''        enabled_toolsets=_load_enabled_toolsets(),
''',
        '''        enabled_toolsets=_load_enabled_toolsets(),
        disabled_toolsets=agent_cfg.get("disabled_toolsets") or [],
''',
        "server global disabled toolsets",
    )
    source = replace_once(
        source,
        '''    session["image_counter"] = session.get("image_counter", 0) + 1
    img_dir = _hermes_home / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    img_path = img_dir / f"{prefix}_{ts}_{session['image_counter']}{ext}"
    try:
        img_path.write_bytes(img_bytes)
    except Exception:
        session["image_counter"] = max(0, session["image_counter"] - 1)
        raise
    session.setdefault("attached_images", []).append(str(img_path))
    return img_path
''',
        '''    # Queue writes share the prompt's history lock so prompt.submit can
    # atomically detach exactly the images it owns. An attachment that arrives after
    # that boundary stays queued for the next prompt instead of being lost or
    # consumed by the agent run already starting.
    with session["history_lock"]:
        # The byte-upload path does not wait for full Hermes initialization, but
        # it must join reset's state boundary before trusting agent_error. A
        # successful reset clears a stale error while holding this same lock.
        if fail_on_initialization_error and (
            initialization_error := session.get("agent_error")
        ):
            raise _ImageAttachInitializationError(str(initialization_error))
        session["image_counter"] = session.get("image_counter", 0) + 1
        img_dir = _hermes_home / "images"
        img_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        img_path = img_dir / f"{prefix}_{ts}_{session['image_counter']}{ext}"
        try:
            img_path.write_bytes(img_bytes)
        except Exception:
            session["image_counter"] = max(0, session["image_counter"] - 1)
            raise
        session.setdefault("attached_images", []).append(str(img_path))
        return img_path
''',
        "serialized image queue append",
    )
    source = replace_once(
        source,
        '''    try:
        img_path = _queue_attached_image(session, img_bytes, ext, prefix="upload")
    except Exception as e:
        return _err(rid, 5027, f"write failed: {e}")
''',
        '''    try:
        img_path = _queue_attached_image(
            session,
            img_bytes,
            ext,
            prefix="upload",
            fail_on_initialization_error=True,
        )
    except _ImageAttachInitializationError as e:
        return _err(rid, 5032, str(e))
    except Exception as e:
        return _err(rid, 5027, f"write failed: {e}")
''',
        "image byte queue initialization error",
    )
    source = replace_once(
        source,
        '''    session["image_counter"] = session.get("image_counter", 0) + 1
    img_dir = _hermes_home / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    img_path = (
        img_dir
        / f"clip_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{session['image_counter']}.png"
    )

    # Save-first: mirrors CLI keybinding path; more robust than has_image() precheck
    if not save_clipboard_image(img_path):
        session["image_counter"] = max(0, session["image_counter"] - 1)
        msg = (
            "Clipboard has image but extraction failed"
            if has_clipboard_image()
            else "No image found in clipboard"
        )
        return _ok(rid, {"attached": False, "message": msg})

    session.setdefault("attached_images", []).append(str(img_path))
    return _ok(
        rid,
        {
            "attached": True,
            "path": str(img_path),
            "count": len(session["attached_images"]),
''',
        '''    with session["history_lock"]:
        session["image_counter"] = session.get("image_counter", 0) + 1
        img_dir = _hermes_home / "images"
        img_dir.mkdir(parents=True, exist_ok=True)
        img_path = (
            img_dir
            / f"clip_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{session['image_counter']}.png"
        )

        # Save-first: mirrors CLI keybinding path; more robust than has_image() precheck
        if not save_clipboard_image(img_path):
            session["image_counter"] = max(0, session["image_counter"] - 1)
            msg = (
                "Clipboard has image but extraction failed"
                if has_clipboard_image()
                else "No image found in clipboard"
            )
            return _ok(rid, {"attached": False, "message": msg})

        session.setdefault("attached_images", []).append(str(img_path))
        attached_count = len(session["attached_images"])
    return _ok(
        rid,
        {
            "attached": True,
            "path": str(img_path),
            "count": attached_count,
''',
        "serialized clipboard image append",
    )
    source = replace_once(
        source,
        '''        if image_path.suffix.lower() not in _IMAGE_EXTENSIONS:
            return _err(rid, 4016, f"unsupported image: {image_path.name}")
        session.setdefault("attached_images", []).append(str(image_path))
        return _ok(
            rid,
            {
                "attached": True,
                "path": str(image_path),
                "count": len(session["attached_images"]),
''',
        '''        if image_path.suffix.lower() not in _IMAGE_EXTENSIONS:
            return _err(rid, 4016, f"unsupported image: {image_path.name}")
        with session["history_lock"]:
            session.setdefault("attached_images", []).append(str(image_path))
            attached_count = len(session["attached_images"])
        return _ok(
            rid,
            {
                "attached": True,
                "path": str(image_path),
                "count": attached_count,
''',
        "serialized local image append",
    )
    source = replace_once(
        source,
        '''    images = session.setdefault("attached_images", [])
    before = len(images)
    session["attached_images"] = [path for path in images if path != raw]
    return _ok(
        rid,
        {
            "detached": len(session["attached_images"]) != before,
            "count": len(session["attached_images"]),
        },
    )
''',
        '''    with session["history_lock"]:
        images = session.setdefault("attached_images", [])
        before = len(images)
        session["attached_images"] = [path for path in images if path != raw]
        detached = len(session["attached_images"]) != before
        attached_count = len(session["attached_images"])
    return _ok(
        rid,
        {
            "detached": detached,
            "count": attached_count,
        },
    )
''',
        "serialized image detach",
    )
    source = replace_once(
        source,
        '''        if dropped["is_image"]:
            session.setdefault("attached_images", []).append(str(drop_path))
            text = remainder or f"[User attached image: {drop_path.name}]"
            return _ok(
                rid,
                {
                    "matched": True,
                    "is_image": True,
                    "path": str(drop_path),
                    "count": len(session["attached_images"]),
''',
        '''        if dropped["is_image"]:
            with session["history_lock"]:
                session.setdefault("attached_images", []).append(str(drop_path))
                attached_count = len(session["attached_images"])
            text = remainder or f"[User attached image: {drop_path.name}]"
            return _ok(
                rid,
                {
                    "matched": True,
                    "is_image": True,
                    "path": str(drop_path),
                    "count": attached_count,
''',
        "serialized detected image append",
    )
    source = replace_once(
        source,
        '''        _start_inflight_turn(session, text)

    # Persist the DB row lazily, now that the user has actually sent a message.
''',
        '''        session["prompt_generation"] = int(session.get("prompt_generation", 0)) + 1
        prompt_generation = session["prompt_generation"]
        _start_inflight_turn(session, text)
        # Detach this prompt's immutable image batch at the same boundary that
        # marks the session running. Later attachments remain queued for the next
        # prompt, regardless of whether Hermes initialization succeeds.
        submitted_images = list(session.get("attached_images", []))
        session["attached_images"] = []

    # Persist the DB row lazily, now that the user has actually sent a message.
''',
        "prompt image batch ownership",
    )
    source = replace_once(
        source,
        '''            return
        _run_prompt_submit(rid, sid, session, text)

    threading.Thread(target=run_after_agent_ready, daemon=True).start()
''',
        '''            return
        _run_prompt_submit(
            rid, sid, session, text, submitted_images, prompt_generation
        )

    threading.Thread(target=run_after_agent_ready, daemon=True).start()
''',
        "prompt image batch handoff",
    )
    source = replace_once(
        source,
        '''        if err:
            _emit(
                "error",
                sid,
                {
                    "message": err.get("error", {}).get(
                        "message", "agent initialization failed"
                    )
                },
            )
            with session["history_lock"]:
                session["running"] = False
                _clear_inflight_turn(session)
            return
        _run_prompt_submit(
            rid, sid, session, text, submitted_images, prompt_generation
        )
''',
        '''        if err:
            with session["history_lock"]:
                # A reset or newer accepted prompt owns the session now. A stale
                # initialization callback must not restore pre-reset images or
                # clear the newer prompt's running and inflight state.
                if session.get("prompt_generation") != prompt_generation:
                    return
                # The client already marked this batch attached. Put it back
                # ahead of later attachments so a retry preserves both the UI
                # contract and the original prompt's attachment order.
                session["attached_images"] = list(submitted_images) + list(
                    session.get("attached_images", [])
                )
                session["running"] = False
                _clear_inflight_turn(session)
            _emit(
                "error",
                sid,
                {
                    "message": err.get("error", {}).get(
                        "message", "June initialization failed"
                    )
                },
            )
            return
        _run_prompt_submit(
            rid, sid, session, text, submitted_images, prompt_generation
        )
''',
        "failed prompt image batch restoration",
    )
    source = replace_once(
        source,
        '''def _run_prompt_submit(rid, sid: str, session: dict, text: Any) -> None:
    with session["history_lock"]:
        history = list(session["history"])
        history_version = int(session.get("history_version", 0))
        images = list(session.get("attached_images", []))
        session["attached_images"] = []
        if not isinstance(session.get("inflight_turn"), dict):
            _start_inflight_turn(session, text)
    agent = session["agent"]
''',
        '''def _run_prompt_submit(
    rid, sid: str, session: dict, text: Any, images, prompt_generation
) -> None:
    with session["history_lock"]:
        if (
            prompt_generation is not None
            and session.get("prompt_generation") != prompt_generation
        ):
            return
        history = list(session["history"])
        history_version = int(session.get("history_version", 0))
        images = list(images)
        if not isinstance(session.get("inflight_turn"), dict):
            _start_inflight_turn(session, text)
        agent = session["agent"]
''',
        "prompt image batch consumption",
    )
    source = replace_count(
        source,
        '''            _run_prompt_submit(rid, sid, session, text)
''',
        '''            _run_prompt_submit(rid, sid, session, text, [], None)
''',
        2,
        "notification prompt image isolation",
    )
    source = replace_once(
        source,
        '''                _run_prompt_submit(rid, sid, session, goal_followup)
''',
        '''                _run_prompt_submit(
                    rid, sid, session, goal_followup, [], None
                )
''',
        "goal continuation image isolation",
    )
    source = replace_once(
        source,
        '''                    _run_prompt_submit(rid, sid, session, synth)
''',
        '''                    _run_prompt_submit(rid, sid, session, synth, [], None)
''',
        "completion prompt image isolation",
    )
    source = replace_region(
        source,
        "def _reset_session_agent(sid: str, session: dict) -> dict:\n",
        "\n\ndef _schedule_mcp_late_refresh(sid: str, agent) -> None:\n",
        '''def _reset_session_agent(sid: str, session: dict) -> dict:
    # Serialize reset with lazy-build publication using a lock independent of
    # both session-map and history ownership. This keeps the Hermes instance and
    # slash worker swap atomic without a _sessions_lock/history_lock cycle.
    publication_lock = session.setdefault("agent_publication_lock", threading.Lock())
    with publication_lock:
        # Own the session state before rebuilding Hermes. An attachment that
        # arrives during the rebuild must wait and queue after reset, never receive
        # an acknowledgement and then get erased by reset's queue clear.
        with session["history_lock"]:
            # Invalidate callbacks waiting on an earlier lazy Hermes build before
            # constructing the replacement Hermes instance. They may finish only
            # after this lock is released and must not mutate the reset session.
            previous_prompt_generation = int(session.get("prompt_generation", 0))
            previous_reset_generation = int(session.get("reset_generation", 0))
            session["prompt_generation"] = previous_prompt_generation + 1
            session["reset_generation"] = previous_reset_generation + 1
            tokens = _set_session_context(session["session_key"])
            try:
                new_agent = _make_agent(
                    sid,
                    session["session_key"],
                    session_id=session["session_key"],
                    # Preserve this session's chosen model across /new so a reset
                    # doesn't silently revert to global config (or to a model another
                    # session set). See the cross-session-contamination note in
                    # _apply_model_switch.
                    model_override=session.get("model_override"),
                )
            except Exception:
                # The original lazy build and prompt still own the session when a
                # requested reset cannot construct its replacement Hermes instance.
                session["prompt_generation"] = previous_prompt_generation
                session["reset_generation"] = previous_reset_generation
                raise
            finally:
                _clear_session_context(tokens)
            session["agent"] = new_agent
            # A successful replacement supersedes any failure published by the
            # prior lazy Hermes build. Attachment and readiness checks must observe
            # the recovered session, not reject it with the obsolete error.
            session["agent_error"] = None
            session["config_model_seen"] = _config_model_target()
            session["attached_images"] = []
            session["edit_snapshots"] = {}
            session["image_counter"] = 0
            session["running"] = False
            session["show_reasoning"] = _load_show_reasoning()
            session["tool_progress_mode"] = _load_tool_progress_mode()
            session["tool_started_at"] = {}
            session["history"] = []
            session["history_version"] = int(session.get("history_version", 0)) + 1
            info = _session_info(new_agent, session)
        _emit("session.info", sid, info)
        _restart_slash_worker(sid, session)
        # Reset has fully published its replacement Hermes instance and slash
        # worker. It owns readiness even if an obsolete lazy build is still in
        # slow construction and will only observe reset_generation later.
        if ready := session.get("agent_ready"):
            ready.set()
    return info
''',
        "session reset ownership",
    )
    source = replace_once(
        source,
        '''        "enabled_toolsets": getattr(agent, "enabled_toolsets", None)
        or _load_enabled_toolsets(),
''',
        '''        "enabled_toolsets": getattr(agent, "enabled_toolsets", None)
        or _load_enabled_toolsets(),
        "disabled_toolsets": (cfg.get("agent") or {}).get("disabled_toolsets")
        or getattr(agent, "disabled_toolsets", None)
        or [],
''',
        "server background disabled toolsets",
    )
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
        session["prompt_generation"] = int(session.get("prompt_generation", 0)) + 1
        prompt_generation = session["prompt_generation"]
        _start_inflight_turn(session, text)
        # Detach this prompt's immutable image batch at the same boundary that
        # marks the session running. Later attachments remain queued for the next
        # prompt, regardless of whether Hermes initialization succeeds.
        submitted_images = list(session.get("attached_images", []))
        session["attached_images"] = []
''',
        '''        # A real user prompt wins over a deferred goal continuation,
        # matching the existing race semantics after the prior completion lands.
        session.pop(_DEFERRED_GOAL_FOLLOWUP, None)
        session["running"] = True
        session["last_active"] = time.time()
        session["prompt_generation"] = int(session.get("prompt_generation", 0)) + 1
        prompt_generation = session["prompt_generation"]
        _start_inflight_turn(session, text)
        # Detach this prompt's immutable image batch at the same boundary that
        # marks the session running. Later attachments remain queued for the next
        # prompt, regardless of whether Hermes initialization succeeds.
        submitted_images = list(session.get("attached_images", []))
        session["attached_images"] = []
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
            session["prompt_generation"] = int(session.get("prompt_generation", 0)) + 1
            prompt_generation = session["prompt_generation"]
            _start_inflight_turn(session, text)
            # Detach this prompt's immutable image batch at the same boundary that
            # marks the session running. Later attachments remain queued for the next
            # prompt, regardless of whether Hermes initialization succeeds.
            submitted_images = list(session.get("attached_images", []))
            session["attached_images"] = []
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
                    deferred_goal["rid"], sid, session, deferred_goal["text"], [], None
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
                _run_prompt_submit(
                    rid, sid, session, goal_followup, [], None
                )
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
                    _run_prompt_submit(
                        rid, sid, session, goal_followup, [], None
                    )
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
    save_config = r'''def _save_cfg(cfg: dict):
    global _cfg_cache, _cfg_mtime, _cfg_path
    import yaml
    from utils import atomic_yaml_write

    path = _hermes_home / "config.yaml"
    # This TUI JSON-RPC writer used to truncate config.yaml directly. Route it
    # through June's shared lock and stale-snapshot Memory reconciliation too.
    atomic_yaml_write(path, cfg, default_flow_style=False, sort_keys=False)
    try:
        with path.open(encoding="utf-8") as saved:
            saved_cfg = yaml.safe_load(saved) or {}
    except Exception:
        saved_cfg = cfg
    with _cfg_lock:
        _cfg_cache = copy.deepcopy(saved_cfg)
        _cfg_path = path
        try:
            _cfg_mtime = path.stat().st_mtime
        except Exception:
            _cfg_mtime = None


'''
    return replace_region(
        source,
        "def _save_cfg(cfg: dict):\n",
        "def _cwd_for_session_key(session_key: str) -> str:\n",
        save_config,
        "TUI config writer lock",
    )


def patch_agent_init(source: str) -> str:
    # Deliberately keep load_config inside the helper and uncached. Constructor
    # arguments can be stale or absent on future Hermes paths, and a long-lived
    # gateway must observe June's latest direct config mutation after a Memory
    # toggle. One synchronous local read per agent construction is the accepted
    # cost of making config.yaml authoritative at this privacy boundary.
    source = replace_once(
        source,
        "\ndef init_agent(\n",
        "\ndef _june_resolve_memory_policy(disabled_toolsets):\n"
        "    \"\"\"Merge June's global Memory deny into one agent lifecycle.\"\"\"\n"
        "    try:\n"
        "        from hermes_cli.config import load_config as _load_june_policy_config\n"
        "        _june_agent_config = (_load_june_policy_config().get(\"agent\") or {})\n"
        "        _june_global_disabled = _june_agent_config.get(\"disabled_toolsets\") or []\n"
        "    except Exception:\n"
        "        _june_global_disabled = []\n"
        "    memory_denied = any(\n"
        "        item == \"memory\" for item in (disabled_toolsets or [])\n"
        "    ) or (\n"
        "        isinstance(_june_global_disabled, (list, tuple, set))\n"
        "        and any(item == \"memory\" for item in _june_global_disabled)\n"
        "    )\n"
        "    merged = list(disabled_toolsets or [])\n"
        "    if memory_denied and \"memory\" not in merged:\n"
        "        merged.append(\"memory\")\n"
        "    return (merged if merged else disabled_toolsets), memory_denied\n"
        "\n"
        "\n"
        "def init_agent(\n",
        "agent init memory policy helper",
    )
    source = replace_once(
        source,
        "    # Store toolset filtering options\n"
        "    agent.enabled_toolsets = enabled_toolsets\n"
        "    agent.disabled_toolsets = disabled_toolsets\n",
        "    # June's global Memory deny is a runtime-wide privacy boundary, not\n"
        "    # only a tool-definition filter. Resolve it from config inside the\n"
        "    # central constructor so every CLI, TUI, gateway, cron, background,\n"
        "    # preview, messaging, and future AIAgent path inherits the policy.\n"
        "    disabled_toolsets, _june_memory_denied = _june_resolve_memory_policy(\n"
        "        disabled_toolsets\n"
        "    )\n"
        "\n"
        "    # Store toolset filtering options\n"
        "    agent.enabled_toolsets = enabled_toolsets\n"
        "    agent.disabled_toolsets = disabled_toolsets\n",
        "agent init global memory deny",
    )
    return replace_once(
        source,
        "    agent._memory_nudge_interval = 10\n"
        "    agent._turns_since_memory = 0\n"
        "    agent._iters_since_skill = 0\n"
        "    if not skip_memory:\n",
        "    agent._memory_nudge_interval = 10\n"
        "    agent._turns_since_memory = 0\n"
        "    agent._iters_since_skill = 0\n"
        "    # The same global deny also suppresses MEMORY.md / USER.md prompt\n"
        "    # injection and external provider prefetch/sync. Tool subtraction\n"
        "    # alone cannot provide the privacy semantics of June's Memory switch.\n"
        "    skip_memory = skip_memory or _june_memory_denied\n"
        "    if not skip_memory:\n",
        "agent init memory lifecycle deny",
    )


def patch_utils(source: str) -> str:
    source = replace_once(
        source,
        "import errno\nimport json\n",
        "from contextlib import contextmanager\nimport copy\nimport errno\nimport json\nimport sys\n",
        "utils config writer lock imports",
    )
    replacement = r'''@contextmanager
def _june_config_writer_lock(path: Path):
    """Coordinate config.yaml replacement with the June desktop host."""
    if path.name != "config.yaml":
        yield
        return

    lock_path = path.parent / ".june-config.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as lock_file:
        if os.name == "nt":
            import msvcrt

            # Byte-range locks may extend beyond EOF. Do not initialize a byte
            # before locking because two first-time writers could race there.
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            return

        import fcntl

        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _june_sync_memory_deny(path: Path, data: Any) -> Any:
    """Make the current on-disk Memory deny win over stale config writers."""
    if not isinstance(data, dict):
        return data
    try:
        existing = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        existing = {}
    existing_agent = existing.get("agent") if isinstance(existing, dict) else None
    existing_disabled = (
        existing_agent.get("disabled_toolsets")
        if isinstance(existing_agent, dict)
        else None
    )
    memory_denied = isinstance(existing_disabled, list) and any(
        item == "memory" for item in existing_disabled
    )

    updated = copy.deepcopy(data)
    agent = updated.get("agent")
    if not isinstance(agent, dict):
        if not memory_denied:
            return updated
        agent = {}
        updated["agent"] = agent
    disabled = agent.get("disabled_toolsets")
    retained = (
        [item for item in disabled if item != "memory"]
        if isinstance(disabled, list)
        else []
    )
    if memory_denied:
        retained.append("memory")
    if retained:
        agent["disabled_toolsets"] = retained
    else:
        agent.pop("disabled_toolsets", None)
    return updated


def _june_config_replacement_target(path: Path) -> Path:
    """Resolve an existing config symlink before creating its temp peer."""
    return path.resolve(strict=True) if path.is_symlink() else path


def _june_copy_config_security(source: Path, temporary: Path) -> None:
    """Copy destination security metadata onto a same-volume temp file."""
    if not source.exists() or sys.platform != "darwin":
        return

    import ctypes

    copyfile = ctypes.CDLL(
        "/usr/lib/libSystem.B.dylib", use_errno=True
    ).fcopyfile
    copyfile.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    copyfile.restype = ctypes.c_int
    copyfile_security = (1 << 0) | (1 << 1)  # COPYFILE_ACL | COPYFILE_STAT
    with source.open("rb") as existing, temporary.open("r+b") as replacement:
        if copyfile(
            existing.fileno(),
            replacement.fileno(),
            None,
            copyfile_security,
        ) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(source))


def _june_replace_config(temporary: Path, target: Path) -> None:
    """Atomically replace config while retaining platform security metadata."""
    if os.name != "nt" or not target.exists():
        os.replace(temporary, target)
        return

    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    replace_file = kernel32.ReplaceFileW
    replace_file.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_wchar_p,
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    replace_file.restype = ctypes.c_int
    if not replace_file(str(target), str(temporary), None, 0, None, None):
        raise ctypes.WinError(ctypes.get_last_error())


def atomic_yaml_write(
    path: Union[str, Path],
    data: Any,
    *,
    default_flow_style: bool = False,
    sort_keys: bool = False,
    extra_content: str | None = None,
) -> None:
    """Write YAML data atomically under June's shared config writer lock."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with _june_config_writer_lock(path):
        data = _june_sync_memory_deny(path, data)
        target = _june_config_replacement_target(path)
        original_mode = _preserve_file_mode(target)

        fd, tmp_path = tempfile.mkstemp(
            dir=str(target.parent),
            prefix=f".{path.stem}_",
            suffix=".tmp",
        )
        tmp_path = Path(tmp_path)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                yaml.dump(
                    data,
                    f,
                    default_flow_style=default_flow_style,
                    sort_keys=sort_keys,
                )
                if extra_content:
                    f.write(extra_content)
                f.flush()
                os.fsync(f.fileno())
            _june_copy_config_security(target, tmp_path)
            _june_replace_config(tmp_path, target)
            _restore_file_mode(target, original_mode)
        except BaseException:
            # Match atomic_json_write: cleanup must also happen for process-level
            # interruptions before we re-raise them.
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise


'''
    source = replace_region(
        source,
        "def atomic_yaml_write(\n",
        "def atomic_roundtrip_yaml_update(\n",
        replacement,
        "utils cross-process config writer lock",
    )
    roundtrip = r'''def atomic_roundtrip_yaml_update(
    path: Union[str, Path],
    key_path: str,
    value: Any,
) -> None:
    """Update one dotted YAML key atomically under June's writer lock."""
    from ruamel.yaml import YAML
    from ruamel.yaml.comments import CommentedMap

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with _june_config_writer_lock(path):
        yaml_rt = YAML(typ="rt")
        yaml_rt.preserve_quotes = True
        yaml_rt.allow_unicode = True
        yaml_rt.default_flow_style = False
        yaml_rt.indent(mapping=2, sequence=4, offset=2)

        if path.exists():
            with path.open("r", encoding="utf-8") as f:
                config = yaml_rt.load(f) or CommentedMap()
        else:
            config = CommentedMap()

        if not isinstance(config, CommentedMap):
            config = CommentedMap(config)

        current = config
        keys = key_path.split(".")
        for key in keys[:-1]:
            next_value = current.get(key)
            if not isinstance(next_value, CommentedMap):
                next_value = CommentedMap()
                current[key] = next_value
            current = next_value
        current[keys[-1]] = value
        config = _june_sync_memory_deny(path, config)

        target = _june_config_replacement_target(path)
        original_mode = _preserve_file_mode(target)
        fd, tmp_path = tempfile.mkstemp(
            dir=str(target.parent),
            prefix=f".{path.stem}_",
            suffix=".tmp",
        )
        tmp_path = Path(tmp_path)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                yaml_rt.dump(config, f)
                f.flush()
                os.fsync(f.fileno())
            _june_copy_config_security(target, tmp_path)
            _june_replace_config(tmp_path, target)
            _restore_file_mode(target, original_mode)
        except BaseException:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise


'''
    return replace_region(
        source,
        "def atomic_roundtrip_yaml_update(\n",
        "# ─── JSON Helpers",
        roundtrip,
        "utils roundtrip config writer lock",
    )


def patch_telegram(source: str) -> str:
    replacement = r'''            if changed:
                # Funnel this live gateway writer through the same locked,
                # Memory-policy-reconciling path as every other config save.
                from utils import atomic_yaml_write

                atomic_yaml_write(
                    config_path,
                    config,
                    default_flow_style=False,
                    sort_keys=False,
                )
'''
    return replace_region(
        source,
        "            if changed:\n                fd, tmp_path = tempfile.mkstemp(\n",
        "                logger.info(\n",
        replacement,
        "telegram DM topic config writer",
    )


PATCHERS: Dict[str, Callable[[str], str]] = {
    "agent/agent_init.py": patch_agent_init,
    "tools/approval.py": patch_approval,
    "tools/mcp_tool.py": patch_mcp_tool,
    "tui_gateway/server.py": patch_server,
    "utils.py": patch_utils,
    "gateway/platforms/telegram.py": patch_telegram,
}


def verify_memory_deny_contract(root: Path) -> None:
    """Pin the upstream precedence that makes June's global deny authoritative."""
    required = {
        "cron/scheduler.py": (
            'user_disabled = agent_cfg.get("disabled_toolsets") or []',
            "disabled_toolsets=_resolve_cron_disabled_toolsets(_cfg),",
        ),
        "model_tools.py": (
            "# Always apply disabled toolsets as a subtraction step at the end.",
            "tools_to_include.difference_update(resolved)",
        ),
    }
    for relative, snippets in required.items():
        path = root / relative
        if not path.is_file():
            raise RuntimeError("missing pinned Hermes policy file: %s" % path)
        observed = sha256(path)
        if observed != POLICY_SHA256[relative]:
            raise RuntimeError(
                "%s hash mismatch: expected pinned policy %s, got %s"
                % (relative, POLICY_SHA256[relative], observed)
            )
        source = path.read_text(encoding="utf-8")
        for snippet in snippets:
            if snippet not in source:
                raise RuntimeError(
                    "%s no longer satisfies the pinned memory deny contract: %s"
                    % (relative, snippet)
                )


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
    verify_memory_deny_contract(root)
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
