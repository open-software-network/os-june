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


PATCH_SET = "june-approval-memory-v15"

UPSTREAM_SHA256: Dict[str, str] = {
    "agent/agent_init.py": "85b7cb13d6e6306e75d5eec46f193433df680425533b7d35ee99e0f7eab9512a",
    "tools/approval.py": "f35c78aa0b56c82cafe0242bb886c4f9679bf55219776a105131dceba2ce9672",
    "tools/mcp_tool.py": "a7328f3f3762ae43f6a9426646b0c28c17ec8663aa391506f48d628035ad5460",
    "tui_gateway/server.py": "5d00832327e4362ac75032f95003e1fa49aead4756cf7927dcfd66447b205a59",
    "utils.py": "a60c651a682f739c8e7e167de939c5bb060c8c2b049ce28d65f12ff1f649b207",
    "plugins/platforms/telegram/adapter.py": "b4fab048d4986ab49615a1b5abb0dafeade4a25196578bf93cb065b793d67c8b",
}

# Filled after applying the transformations to the exact upstream files. These
# hashes are part of the runtime provenance contract, not best-effort checks.
PATCHED_SHA256: Dict[str, str] = {
    "agent/agent_init.py": "a3f6f64cc7932df2de66c4a93bcaef3cfe1cccd20a927e48e023c2185c8da5a5",
    "tools/approval.py": "c0d941fd952b578739afff0096b8896f4d7f742d66518aefef0a9c9b3b344900",
    "tools/mcp_tool.py": "764758773737bc1c1c46d244857198eea83dfbf52c0a1460ed0bc3418c1ceb7a",
    "tui_gateway/server.py": "6a655b6b8c1c966772d5953cc8e63d9aea35435c4f2a7088acba2d05514481be",
    "utils.py": "0795233ec93398fe0f13e785d8b7c66768f60ee83b29d853c24009e1558e0174",
    "plugins/platforms/telegram/adapter.py": "b4fab048d4986ab49615a1b5abb0dafeade4a25196578bf93cb065b793d67c8b",
}

# These policy files are not transformed, but their exact bytes are part of
# the patch set's provenance contract. June relies on this pinned scheduler
# layering and final deny subtraction to make agent.disabled_toolsets win over
# every stored per-job allowlist.
POLICY_SHA256: Dict[str, str] = {
    "cron/scheduler.py": "ea54407dddebec57a184f1dbdf1076f8abe94f132da1e619c476cbf1266ed239",
    "model_tools.py": "30a2dcb33685783935f66abef6839d06736c90196a89dd034c91c4e6eb65c2db",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


UPSTREAMED_IN_019 = {
    "prompt image batch ownership",
    "prompt image batch handoff",
    "failed prompt image batch restoration",
    "prompt image batch consumption",
    "notification prompt image isolation",
    "goal continuation image isolation",
    "completion prompt image isolation",
    "telegram DM topic config writer",
}


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if label in UPSTREAMED_IN_019:
        return source
    count = source.count(old)
    if count != 1:
        raise RuntimeError("%s: expected one match, found %d" % (label, count))
    return source.replace(old, new, 1)


def replace_count(
    source: str, old: str, new: str, expected: int, label: str
) -> str:
    if label in UPSTREAMED_IN_019:
        return source
    count = source.count(old)
    if count != expected:
        raise RuntimeError(
            "%s: expected %d matches, found %d" % (label, expected, count)
        )
    return source.replace(old, new)


def replace_region(source: str, start: str, end: str, replacement: str, label: str) -> str:
    if label in UPSTREAMED_IN_019:
        return source
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
        _gateway_notify_cbs[session_key] = cb
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
        _gateway_notify_cbs.pop(session_key, None)
        expire_cb = _gateway_expire_cbs.pop(session_key, None)
        entries = _gateway_queues.pop(session_key, [])
        for entry in entries:
            entry.retired_reason = "disconnect"
            _remember_gateway_entry_completion_locked(session_key, entry, None)
    for entry in entries:
        entry.event.set()
        if expire_cb is not None:
            try:
                expire_cb({"request_id": entry.request_id, "reason": "disconnect"})
            except Exception as exc:
                logger.warning("Gateway approval expiration notify failed: %s", exc)


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
        '''def _session_uses_compute_host(session: dict, cfg: dict | None = None) -> bool:
    if not _turn_isolation_enabled(cfg):
        return False
''',
        '''def _session_uses_compute_host(session: dict, cfg: dict | None = None) -> bool:
    if not _turn_isolation_enabled(cfg):
        return False
    # The current compute-host frame cannot carry a per-agent-run tool scope.
    # Once a session needs one, keep that session on the inline executor so
    # history and controls always target the same live agent.
    if session.get("_june_inline_executor"):
        return False
''',
        "scoped sessions stay on one executor",
    )
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
            # /new starts fresh history but June keeps the session's explicit
            # model, reasoning, and service-tier selections. Only a one-turn
            # override expires at this boundary.
            session.pop("one_turn_model_restore", None)
            session["prompt_generation"] = previous_prompt_generation + 1
            session["reset_generation"] = previous_reset_generation + 1
            tokens = _set_session_context(session["session_key"])
            try:
                new_agent = _make_agent(
                    sid,
                    session["session_key"],
                    session_id=session["session_key"],
                    platform_override=_session_source(session),
                    model_override=session.get("model_override"),
                    reasoning_config_override=session.get("create_reasoning_override"),
                    service_tier_override=session.get("create_service_tier_override"),
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
        '''            session["transport"] = _detached_ws_transport
            detached += 1
            try:
                _schedule_ws_orphan_reap(sid)
''',
        '''            session["transport"] = _detached_ws_transport
            detached += 1
            # A parked session can be resumed, but an approval tied to the
            # disconnected client cannot. Drain it immediately fail closed;
            # session.resume registers a fresh callback for future requests.
            try:
                from tools.approval import unregister_gateway_notify

                if key := session.get("session_key"):
                    unregister_gateway_notify(key)
            except Exception:
                pass
            try:
                _schedule_ws_orphan_reap(sid)
''',
        "server disconnect approval drain",
    )
    source = replace_once(
        source,
        '''                register_gateway_notify(
                    key, lambda data: _emit_approval_request(sid, data)
                )
''',
        '''                register_gateway_notify(
                    key,
                    lambda data: _emit_approval_request(sid, data),
                    lambda data: _emit("approval.expire", sid, data),
                )
''',
        "server create approval callbacks",
    )
    source = replace_once(
        source,
        '''            register_gateway_notify(
                new_session_id,
                lambda data: _emit_approval_request(sid, data),
            )
''',
        '''            register_gateway_notify(
                new_session_id,
                lambda data: _emit_approval_request(sid, data),
                lambda data: _emit("approval.expire", sid, data),
            )
''',
        "server continuation approval callbacks",
    )
    source = replace_once(
        source,
        '''        register_gateway_notify(key, lambda data: _emit_approval_request(sid, data))
''',
        '''        register_gateway_notify(
            key,
            lambda data: _emit_approval_request(sid, data),
            lambda data: _emit("approval.expire", sid, data),
        )
''',
        "server exec approval callbacks",
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
    source = replace_once(
        source,
        '''        return None


def _session_tool_progress_mode(sid: str) -> str:
''',
        '''        return None


_AGENT_RUN_TOOLSETS_UNSET = object()


def _normalize_agent_run_enabled_toolsets(raw):
    """Validate that a client can narrow, never widen, June's tool surface."""
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ValueError("enabled_toolsets must be an array or null")
    if len(raw) > 32:
        raise ValueError("enabled_toolsets has too many entries")

    normalized = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise ValueError("enabled_toolsets entries must be non-empty strings")
        name = item.strip()
        if name not in normalized:
            normalized.append(name)

    allowed = _load_enabled_toolsets()
    if allowed is None:
        raise ValueError("agent-run-scoped toolsets require a configured gateway allowlist")
    allowed_names = set(allowed)
    if any(name not in allowed_names for name in normalized):
        raise ValueError("enabled_toolsets may only narrow the gateway allowlist")
    return normalized


def _wait_for_session_toolsets(enabled_toolsets_override) -> None:
    """Wait only for requested MCP servers; unrelated discovery stays async."""
    started_at = time.monotonic()
    if enabled_toolsets_override is None:
        try:
            from hermes_cli.mcp_startup import wait_for_mcp_discovery

            wait_for_mcp_discovery()
        except Exception:
            pass
        try:
            from tui_gateway.entry import wait_for_mcp_discovery

            wait_for_mcp_discovery()
        except Exception:
            pass
        logger.info(
            "June tool stage: scoped=false toolsets=default registry_wait_ms=%d",
            round((time.monotonic() - started_at) * 1000),
        )
        return

    cfg = _load_cfg()
    mcp_servers = cfg.get("mcp_servers")
    configured = set(mcp_servers) if isinstance(mcp_servers, dict) else set()
    requested_servers = []
    for toolset in enabled_toolsets_override:
        server_name = toolset[4:] if toolset.startswith("mcp-") else toolset
        if server_name in configured:
            requested_servers.append(server_name)
    if requested_servers:
        from tools.registry import registry

        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            missing = [
                name
                for name in requested_servers
                if not registry.get_tool_names_for_toolset(f"mcp-{name}")
            ]
            if not missing:
                break
            time.sleep(0.01)
        else:
            raise RuntimeError("A requested June tool server did not become ready")
    logger.info(
        "June tool stage: scoped=true toolsets=%d registry_wait_ms=%d",
        len(enabled_toolsets_override),
        round((time.monotonic() - started_at) * 1000),
    )


def _apply_agent_run_enabled_toolsets(session: dict, requested) -> None:
    """Retune one live agent snapshot without rebuilding the agent or clients."""
    if requested is _AGENT_RUN_TOOLSETS_UNSET:
        return
    normalized = _normalize_agent_run_enabled_toolsets(requested)
    effective = normalized if normalized is not None else _load_enabled_toolsets()
    _wait_for_session_toolsets(normalized)
    agent = session.get("agent")
    if agent is None:
        session["enabled_toolsets_override"] = normalized
        return
    current = getattr(agent, "enabled_toolsets", None)
    if current != effective:
        from tools.mcp_tool import refresh_agent_mcp_tools

        refresh_agent_mcp_tools(
            agent,
            enabled_override=effective,
            disabled_override=getattr(agent, "disabled_toolsets", None),
        )
    session["enabled_toolsets_override"] = normalized
    logger.info(
        "June tool stage: scoped=%s toolsets=%d schema_ready=true",
        normalized is not None,
        len(effective or []),
    )


def _session_tool_progress_mode(sid: str) -> str:
''',
        "agent-run-scoped toolset helpers",
    )
    source = replace_once(
        source,
        '''def _restart_slash_worker(sid: str, session: dict):
    worker = session.get("slash_worker")
    if worker:
''',
        '''def _restart_slash_worker(sid: str, session: dict):
    worker = session.get("slash_worker")
    if worker is None:
        return
    if worker:
''',
        "slash worker restarts only after explicit lazy start",
    )
    source = replace_once(
        source,
        '''def _make_agent(
    sid: str,
    key: str,
    session_id: str | None = None,
    session_db=None,
    model_override: dict | str | None = None,
    provider_override: str | None = None,
    reasoning_config_override: dict | None = None,
    service_tier_override: str | None = None,
    platform_override: str | None = None,
):
''',
        '''def _make_agent(
    sid: str,
    key: str,
    session_id: str | None = None,
    session_db=None,
    model_override: dict | str | None = None,
    provider_override: str | None = None,
    reasoning_config_override: dict | None = None,
    service_tier_override: str | None = None,
    platform_override: str | None = None,
    enabled_toolsets_override: list[str] | None = None,
):
''',
        "session-scoped agent toolsets argument",
    )
    source = replace_once(
        source,
        '''    # MCP tool discovery runs in a background daemon thread at startup so a
    # dead server can't freeze the shell.  The agent snapshots its tool list
    # once here and never re-reads it, so briefly wait for in-flight discovery
    # to land before building — bounded, so a slow/dead server still can't
    # block. Dashboard /api/ws uses hermes_cli.mcp_startup; TUI stdio keeps
    # its existing tui_gateway.entry-owned thread.
    try:
        from hermes_cli.mcp_startup import wait_for_mcp_discovery

        wait_for_mcp_discovery()
    except Exception:
        pass
    try:
        from tui_gateway.entry import wait_for_mcp_discovery

        wait_for_mcp_discovery()
    except Exception:
        pass
''',
        '''    # A narrowed desktop-control agent run waits only for its one local MCP
    # server. Other MCP clients keep connecting in the process-wide background
    # and cannot delay this agent's immutable first tool snapshot.
    _wait_for_session_toolsets(enabled_toolsets_override)
''',
        "targeted MCP discovery wait",
    )
    source = replace_once(
        source,
        '''        enabled_toolsets=_load_enabled_toolsets(),
        disabled_toolsets=agent_cfg.get("disabled_toolsets") or [],
''',
        '''        enabled_toolsets=(
            enabled_toolsets_override
            if enabled_toolsets_override is not None
            else _load_enabled_toolsets()
        ),
        disabled_toolsets=agent_cfg.get("disabled_toolsets") or [],
''',
        "session-scoped agent toolsets selection",
    )
    source = replace_once(
        source,
        '''                    if (tier := current.get("create_service_tier_override")) is not None:
                        kw["service_tier_override"] = tier
                agent = _make_agent(sid, key, **kw)
''',
        '''                    if (tier := current.get("create_service_tier_override")) is not None:
                        kw["service_tier_override"] = tier
                if (toolsets := current.get("enabled_toolsets_override")) is not None:
                    kw["enabled_toolsets_override"] = toolsets
                agent = _make_agent(sid, key, **kw)
''',
        "session toolsets forwarded to lazy build",
    )
    source = replace_once(
        source,
        '''                    service_tier_override=session.get("create_service_tier_override"),
                )
''',
        '''                    service_tier_override=session.get("create_service_tier_override"),
                    enabled_toolsets_override=session.get("enabled_toolsets_override"),
                )
''',
        "session toolsets preserved across reset",
    )
    source = replace_once(
        source,
        '''    profile = (params.get("profile") or "").strip() or None
    profile_home = _profile_home(profile)

    # The desktop composer owns its model/effort/fast as plain UI state and ships
''',
        '''    profile = (params.get("profile") or "").strip() or None
    profile_home = _profile_home(profile)
    if profile is not None and params.get("enabled_toolsets") is not None:
        return _err(
            rid,
            4003,
            "agent-run-scoped toolsets are unavailable under a named profile",
        )
    try:
        enabled_toolsets_override = _normalize_agent_run_enabled_toolsets(
            params.get("enabled_toolsets")
        )
    except ValueError as exc:
        return _err(rid, 4003, str(exc))
    logger.info(
        "June tool stage: session_create scoped=%s toolsets=%d",
        enabled_toolsets_override is not None,
        len(enabled_toolsets_override or []),
    )

    # The desktop composer owns its model/effort/fast as plain UI state and ships
''',
        "profile-aware session create toolset validation",
    )
    source = replace_once(
        source,
        '''            "model_override": session_model_override,
            "create_reasoning_override": create_reasoning_override,
''',
        '''            "model_override": session_model_override,
            "enabled_toolsets_override": enabled_toolsets_override,
            "create_reasoning_override": create_reasoning_override,
''',
        "session toolset storage",
    )
    source = replace_once(
        source,
        '''def _enqueue_prompt(session: dict, text: Any, transport: Any) -> None:
''',
        '''def _enqueue_prompt(
    session: dict,
    text: Any,
    transport: Any,
    enabled_toolsets=_AGENT_RUN_TOOLSETS_UNSET,
) -> bool:
''',
        "queued prompt toolset argument",
    )
    source = replace_once(
        source,
        '''    session["queued_prompt"] = {"text": text, "transport": transport}
''',
        '''    queued_toolsets = enabled_toolsets
    if (
        isinstance(existing, dict)
        and existing.get("enabled_toolsets", _AGENT_RUN_TOOLSETS_UNSET)
        != queued_toolsets
    ):
        return False
    if queued_toolsets is _AGENT_RUN_TOOLSETS_UNSET and isinstance(existing, dict):
        queued_toolsets = existing.get("enabled_toolsets", _AGENT_RUN_TOOLSETS_UNSET)
    queued_prompt = {"text": text, "transport": transport}
    if queued_toolsets is not _AGENT_RUN_TOOLSETS_UNSET:
        queued_prompt["enabled_toolsets"] = queued_toolsets
    session["queued_prompt"] = queued_prompt
    return True
''',
        "queued prompt toolset storage",
    )
    source = replace_once(
        source,
        '''def _handle_busy_submit(
    rid, sid: str, session: dict, text: Any, transport: Any
) -> dict | None:
''',
        '''def _handle_busy_submit(
    rid,
    sid: str,
    session: dict,
    text: Any,
    transport: Any,
    enabled_toolsets=_AGENT_RUN_TOOLSETS_UNSET,
) -> dict | None:
''',
        "busy prompt toolset argument",
    )
    source = replace_once(
        source,
        '''    if mode == "steer" and agent is not None and hasattr(agent, "steer"):
''',
        '''    if (
        mode == "steer"
        and enabled_toolsets in (_AGENT_RUN_TOOLSETS_UNSET, None)
        and agent is not None
        and hasattr(agent, "steer")
    ):
''',
        "scoped busy prompt avoids unsafe steer",
    )
    source = replace_once(
        source,
        '''        _enqueue_prompt(session, text, transport)
''',
        '''        if not _enqueue_prompt(session, text, transport, enabled_toolsets):
            return _err(
                rid,
                4009,
                "queued prompt tool scope changed; retry after the current agent run",
            )
''',
        "busy prompt queues toolsets",
    )
    source = replace_once(
        source,
        '''        session["queued_prompt"] = None
        session["running"] = True
''',
        '''        session["queued_prompt"] = None
        if queued.get(
            "enabled_toolsets", _AGENT_RUN_TOOLSETS_UNSET
        ) not in (_AGENT_RUN_TOOLSETS_UNSET, None):
            session["_june_inline_executor"] = True
        session["running"] = True
''',
        "queued scoped prompt pins executor before claim",
    )
    source = replace_once(
        source,
        '''        if _session_uses_compute_host(session):
            resp = _submit_prompt_to_compute_host(rid, sid, session, queued["text"])
''',
        '''        queued_agent_run_toolsets = queued.get(
            "enabled_toolsets", _AGENT_RUN_TOOLSETS_UNSET
        )
        if (
            _session_uses_compute_host(session)
            and queued_agent_run_toolsets in (_AGENT_RUN_TOOLSETS_UNSET, None)
        ):
            resp = _submit_prompt_to_compute_host(rid, sid, session, queued["text"])
''',
        "scoped queued prompt bypasses unscoped compute-host frame",
    )
    source = replace_once(
        source,
        '''        else:
            _run_prompt_submit(rid, sid, session, queued["text"])
''',
        '''        else:
            _dispatch_inline_prompt(
                rid,
                sid,
                session,
                queued["text"],
                queued_agent_run_toolsets,
            )
''',
        "queued prompt uses the readiness-gated inline dispatcher",
    )
    source = replace_once(
        source,
        '''# ── Methods: prompt ──────────────────────────────────────────────────


@method("prompt.submit")
''',
        '''# ── Methods: prompt ──────────────────────────────────────────────────


def _dispatch_inline_prompt(
    rid,
    sid: str,
    session: dict,
    text: Any,
    agent_run_toolsets=_AGENT_RUN_TOOLSETS_UNSET,
) -> None:
    """Run an acknowledged inline prompt only after its agent is ready."""
    _ensure_session_db_row(session)
    _persist_branch_seed(session)
    _start_agent_build(sid, session)

    def run_after_agent_ready() -> None:
        err = _wait_agent(session, rid)
        if err:
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
        with session["history_lock"]:
            if session.get("_turn_cancel_requested") or not session.get("running"):
                session["running"] = False
                _clear_inflight_turn(session)
                return
        try:
            _apply_agent_run_enabled_toolsets(session, agent_run_toolsets)
        except Exception as exc:
            _emit("error", sid, {"message": f"June tool setup failed: {exc}"})
            with session["history_lock"]:
                session["running"] = False
                _clear_inflight_turn(session)
            return
        _run_prompt_submit(rid, sid, session, text)

    run_thread = threading.Thread(target=run_after_agent_ready, daemon=True)
    session["_run_thread"] = run_thread
    run_thread.start()


@method("prompt.submit")
''',
        "shared readiness-gated inline prompt dispatcher",
    )
    source = replace_once(
        source,
        '''    truncate_user_ordinal = params.get("truncate_before_user_ordinal")
    session, err = _sess_nowait(params, rid)
    if err:
        return err
''',
        '''    truncate_user_ordinal = params.get("truncate_before_user_ordinal")
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    agent_run_toolsets = (
        _AGENT_RUN_TOOLSETS_UNSET
        if session.get("profile_home") is not None
        else None
    )
    if "enabled_toolsets" in params:
        if session.get("profile_home") is not None:
            if params.get("enabled_toolsets") is not None:
                return _err(
                    rid,
                    4003,
                    "agent-run-scoped toolsets are unavailable under a named profile",
                )
        else:
            try:
                agent_run_toolsets = _normalize_agent_run_enabled_toolsets(
                    params.get("enabled_toolsets")
                )
            except ValueError as exc:
                return _err(rid, 4003, str(exc))
''',
        "profile-aware prompt toolset validation preserves omitted scope",
    )
    source = replace_once(
        source,
        '''        busy_response = _handle_busy_submit(rid, sid, session, text, busy_transport)
''',
        '''        busy_response = _handle_busy_submit(
            rid, sid, session, text, busy_transport, agent_run_toolsets
        )
''',
        "busy prompt toolset forwarding",
    )
    source = replace_once(
        source,
        '''        session["running"] = True
        session["_turn_cancel_requested"] = False
        session["last_active"] = time.time()
        _start_inflight_turn(session, text)
''',
        '''        if agent_run_toolsets not in (_AGENT_RUN_TOOLSETS_UNSET, None):
            session["_june_inline_executor"] = True
        session["running"] = True
        session["_turn_cancel_requested"] = False
        session["last_active"] = time.time()
        _start_inflight_turn(session, text)
''',
        "scoped prompt pins executor before claim",
    )
    source = replace_once(
        source,
        '''    if turn_isolation:
        isolated_response = _submit_prompt_to_compute_host(rid, sid, session, text)
''',
        '''    # The compute-host frame has no agent-run tool scope field. Keep
    # explicitly scoped requests inline, and pin that session to the inline
    # executor so later history/control operations cannot target a stale host.
    if agent_run_toolsets not in (_AGENT_RUN_TOOLSETS_UNSET, None):
        turn_isolation = False
    if turn_isolation:
        isolated_response = _submit_prompt_to_compute_host(rid, sid, session, text)
''',
        "scoped prompt pins one executor",
    )
    source = replace_once(
        source,
        '''        with session["history_lock"]:
            if session.get("_turn_cancel_requested") or not session.get("running"):
                session["running"] = False
                _clear_inflight_turn(session)
                return
        _run_prompt_submit(rid, sid, session, text)
''',
        '''        with session["history_lock"]:
            if session.get("_turn_cancel_requested") or not session.get("running"):
                session["running"] = False
                _clear_inflight_turn(session)
                return
        try:
            _apply_agent_run_enabled_toolsets(session, agent_run_toolsets)
        except Exception as exc:
            _emit("error", sid, {"message": f"June tool setup failed: {exc}"})
            with session["history_lock"]:
                session["running"] = False
                _clear_inflight_turn(session)
            return
        _run_prompt_submit(rid, sid, session, text)
''',
        "prompt applies agent-run-scoped toolsets",
    )
    source = replace_region(
        source,
        "    # Persist the DB row lazily, now that the user has actually sent a message.\n",
        '    return _ok(rid, {"status": "streaming"})\n',
        '''    _dispatch_inline_prompt(
        rid,
        sid,
        session,
        text,
        agent_run_toolsets,
    )
''',
        "direct prompt uses shared readiness-gated inline dispatcher",
    )
    source = replace_once(
        source,
        '''            try:
                worker = _SlashWorker(
                    key,
                    getattr(agent, "model", _resolve_model()),
                    profile_home=current.get("profile_home"),
                )
                _attach_worker(sid, current, worker)
            except Exception:
                pass

            try:
                from tools.approval import (
''',
        '''            # A scoped Computer use agent run has no slash command to run.
            # Starting its broad HermesCLI child here would reconnect every MCP
            # server and probe optional dependencies while the first model call
            # is in flight. command.dispatch already creates this worker lazily,
            # so leave it absent until a later slash command actually needs it.
            if current.get("enabled_toolsets_override") is None:
                try:
                    worker = _SlashWorker(
                        key,
                        getattr(agent, "model", _resolve_model()),
                        profile_home=current.get("profile_home"),
                    )
                    _attach_worker(sid, current, worker)
                except Exception:
                    pass

            try:
                from tools.approval import (
''',
        "scoped session defers broad slash worker",
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
    "plugins/platforms/telegram/adapter.py": patch_telegram,
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
