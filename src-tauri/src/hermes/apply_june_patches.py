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


PATCH_SET = "june-approval-memory-v2"

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
    "tools/approval.py": "56e88034ebcac8cff8c579c56345e4cb3fe2fe597360687d40b68daefd402e3d",
    "tools/mcp_tool.py": "48a2fddfee5d5a8c33723e27639907e9f2cf062c82e7beeb844f457e6a372cfa",
    "tui_gateway/server.py": "988e462b640f0da4e47b8164b5ca433021ace080fccfe55322b5b284c7c944ac",
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
        '''        enabled_toolsets=_load_enabled_toolsets(),
''',
        '''        enabled_toolsets=_load_enabled_toolsets(),
        disabled_toolsets=agent_cfg.get("disabled_toolsets") or [],
''',
        "server global disabled toolsets",
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
