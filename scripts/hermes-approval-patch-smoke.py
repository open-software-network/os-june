#!/usr/bin/env python3
"""Exercise June's patched Hermes compatibility contract without provider credentials."""

import argparse
import ast
import copy
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
from typing import Optional


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
    module = load_module(
        "june_patched_hermes_approval", path, defer_annotations=True
    )
    module._get_approval_config = lambda: {"gateway_timeout": 5}
    module._fire_approval_hook = lambda *_args, **_kwargs: None
    return module


def load_module(name: str, path: Path, *, defer_annotations: bool = False):
    if defer_annotations:
        # The bundled runtime is Python 3.11, while stock macOS still exposes
        # Python 3.9. Compile the exact pinned source with deferred annotation
        # evaluation so this compatibility smoke can exercise it on either.
        module = types.ModuleType(name)
        module.__file__ = str(path)
        exec(
            compile(
                "from __future__ import annotations\n"
                + path.read_text(encoding="utf-8"),
                str(path),
                "exec",
            ),
            module.__dict__,
        )
        return module
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load %s from %s" % (name, path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_patch_state_machine(root: Path, upstream_root: Optional[Path] = None) -> None:
    patcher_path = (
        Path(__file__).resolve().parents[1]
        / "src-tauri"
        / "src"
        / "hermes"
        / "apply_june_patches.py"
    )
    patcher = load_module("june_hermes_patch_smoke", patcher_path)

    # When a bundle build retained the just-extracted source, exercise the
    # upstream acceptance branch through the real transformations and then the
    # already-patched acceptance branch. Keeping this optional lets installed
    # runtimes re-run the patched-tree smoke without shipping a second source
    # snapshot.
    if upstream_root is not None:
        with tempfile.TemporaryDirectory(prefix="june-hermes-upstream-smoke-") as temp:
            upstream_copy = Path(temp)
            for relative in (*patcher.PATCHERS, *patcher.POLICY_SHA256):
                source = upstream_root / relative
                destination = upstream_copy / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
            patcher.apply(upstream_copy, False)
            patcher.apply(upstream_copy, True)

    # Exact patched inputs, including the unchanged scheduler/resolver policy
    # files, must pass the same verifier used by bundled and managed installs.
    patcher.apply(root, True)

    # An arbitrary third state must fail closed rather than being accepted by
    # a loose source-snippet check.
    with tempfile.TemporaryDirectory(prefix="june-hermes-patch-smoke-") as temp:
        copy_root = Path(temp)
        for relative in (*patcher.PATCHERS, *patcher.POLICY_SHA256):
            source = root / relative
            destination = copy_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        tampered = copy_root / "tui_gateway" / "server.py"
        tampered.write_text(
            tampered.read_text(encoding="utf-8") + "\n# unexpected drift\n",
            encoding="utf-8",
        )
        try:
            patcher.apply(copy_root, True)
        except RuntimeError:
            pass
        else:
            raise AssertionError("tampered Hermes source passed sealed patch verification")


def _function(tree: ast.AST, name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError("missing Hermes function: %s" % name)


def _rpc_method(tree: ast.AST, method_name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        for decorator in node.decorator_list:
            if (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Name)
                and decorator.func.id == "method"
                and len(decorator.args) == 1
                and isinstance(decorator.args[0], ast.Constant)
                and decorator.args[0].value == method_name
            ):
                return node
    raise AssertionError("missing Hermes RPC method: %s" % method_name)


def _session_subscript(node: ast.AST, key: str) -> bool:
    return (
        isinstance(node, ast.Subscript)
        and isinstance(node.value, ast.Name)
        and node.value.id == "session"
        and isinstance(node.slice, ast.Constant)
        and node.slice.value == key
    )


def verify_new_session_image_attach_is_immediate(root: Path) -> None:
    tree = ast.parse(
        (root / "tui_gateway" / "server.py").read_text(encoding="utf-8")
    )
    handler = _rpc_method(tree, "image.attach_bytes")
    session_calls = {
        node.func.id
        for node in ast.walk(handler)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        if node.func.id in {"_sess", "_sess_nowait"}
    }
    assert session_calls == {"_sess_nowait"}, (
        "image.attach_bytes must persist to a newly created session without "
        "waiting for Hermes initialization: %s" % sorted(session_calls)
    )

    # Execute the pinned handler and its real byte-decoding/write helpers in
    # isolation. Importing all of server.py would require the complete Hermes
    # runtime even though this smoke also runs with stock host Python.
    helper_names = (
        "_err",
        "_ok",
        "_sess_nowait",
        "_decode_attach_base64",
        "_sniff_image_ext",
        "_queue_attached_image",
    )
    functions = [copy.deepcopy(_function(tree, name)) for name in helper_names]
    reset_function = copy.deepcopy(_function(tree, "_reset_session_agent"))
    executable_handler = copy.deepcopy(handler)
    executable_handler.name = "_image_attach_bytes"
    executable_handler.decorator_list = []
    source = "from __future__ import annotations\n" + "\n\n".join(
        ast.unparse(node) for node in (*functions, reset_function, executable_handler)
    )

    fresh_session = {
        "attached_images": [],
        "history_lock": threading.Lock(),
        "image_counter": 0,
    }
    with tempfile.TemporaryDirectory(prefix="june-image-attach-smoke-") as temp:
        namespace = {
            "Path": Path,
            "datetime": datetime,
            "_ATTACH_BYTES_MAX_BYTES": 25 * 1024 * 1024,
            "_allowed_image_extensions": lambda: frozenset({".png"}),
            "_hermes_home": Path(temp),
            "_image_meta": lambda _path: {},
            "_sessions": {"fresh-session": fresh_session},
        }
        exec(compile(source, str(root / "tui_gateway" / "server.py"), "exec"), namespace)
        response = namespace["_image_attach_bytes"](
            "attach",
            {
                "session_id": "fresh-session",
                "filename": "jun-362-smoke.png",
                "content_base64": (
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0l"
                    "EQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                ),
            },
        )
        assert response.get("result", {}).get("attached") is True, response
        assert response.get("result", {}).get("bytes") == 68, response
        assert len(fresh_session["attached_images"]) == 1, fresh_session
        saved_path = Path(fresh_session["attached_images"][0])
        assert saved_path.is_file(), saved_path
        assert len(saved_path.read_bytes()) == 68, saved_path
        with fresh_session["history_lock"]:
            submitted_images = list(fresh_session["attached_images"])
            fresh_session["attached_images"] = []
        assert submitted_images == [str(saved_path)], submitted_images
        assert fresh_session["attached_images"] == [], fresh_session

        failed_session = {
            "agent_error": "synthetic Hermes initialization failure",
            "attached_images": [],
            "history_lock": threading.Lock(),
            "image_counter": 0,
        }
        namespace["_sessions"]["failed-session"] = failed_session
        failed_response = namespace["_image_attach_bytes"](
            "failed-attach",
            {
                "session_id": "failed-session",
                "filename": "jun-362-smoke.png",
                "content_base64": (
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0l"
                    "EQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                ),
            },
        )
        assert failed_response.get("error", {}).get("code") == 5032, failed_response
        assert failed_session["attached_images"] == [], failed_session

        # Force an attachment to cross the prompt-accept boundary. The prompt holds
        # history_lock while detaching its empty batch; the attachment can append
        # only after release, so it remains queued for the next prompt instead
        # of being erased or misrouted into the accepted one.
        concurrent_session = {
            "attached_images": [],
            "history_lock": threading.Lock(),
            "image_counter": 0,
        }
        namespace["_sessions"]["concurrent-session"] = concurrent_session
        attachment_started = threading.Event()
        attachment_result = {}

        def attach_after_prompt_accepts() -> None:
            attachment_started.set()
            attachment_result["response"] = namespace["_image_attach_bytes"](
                "concurrent-attach",
                {
                    "session_id": "concurrent-session",
                    "filename": "later.png",
                    "content_base64": (
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0l"
                        "EQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                    ),
                },
            )

        with concurrent_session["history_lock"]:
            attachment_worker = threading.Thread(target=attach_after_prompt_accepts)
            attachment_worker.start()
            assert attachment_started.wait(1), "concurrent attachment did not start"
            accepted_batch = list(concurrent_session["attached_images"])
            concurrent_session["attached_images"] = []
        attachment_worker.join(2)
        assert not attachment_worker.is_alive(), "concurrent attachment did not finish"
        assert accepted_batch == [], accepted_batch
        assert attachment_result["response"].get("result", {}).get("attached") is True
        assert len(concurrent_session["attached_images"]) == 1, concurrent_session

        # Reset must own the same lock before agent construction starts. An
        # attachment arriving during a slow rebuild waits, then queues after
        # reset instead of being acknowledged and silently cleared.
        reset_build_started = threading.Event()
        reset_build_release = threading.Event()

        def make_agent_for_reset(*_args, **_kwargs):
            reset_build_started.set()
            assert reset_build_release.wait(2), "reset build was not released"
            return object()

        namespace.update(
            {
                "_make_agent": make_agent_for_reset,
                "_set_session_context": lambda _key: None,
                "_clear_session_context": lambda _tokens: None,
                "_config_model_target": lambda: "synthetic-model",
                "_load_show_reasoning": lambda: False,
                "_load_tool_progress_mode": lambda: "compact",
                "_session_info": lambda _agent, _session: {},
                "_emit": lambda *_args: None,
                "_restart_slash_worker": lambda *_args: None,
            }
        )
        reset_session = {
            "session_key": "reset-session-key",
            "agent": object(),
            "attached_images": ["stale-before-reset.png"],
            "history": ["stale history"],
            "history_lock": threading.Lock(),
            "history_version": 3,
            "image_counter": 1,
            "running": False,
        }
        namespace["_sessions"]["reset-session"] = reset_session
        reset_result = {}
        reset_attachment_result = {}

        def reset_worker() -> None:
            reset_result["info"] = namespace["_reset_session_agent"](
                "reset-session", reset_session
            )

        def attach_during_reset() -> None:
            reset_attachment_result["response"] = namespace["_image_attach_bytes"](
                "attach-during-reset",
                {
                    "session_id": "reset-session",
                    "filename": "after-reset.png",
                    "content_base64": (
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0l"
                        "EQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                    ),
                },
            )

        reset_thread = threading.Thread(target=reset_worker)
        reset_thread.start()
        assert reset_build_started.wait(1), "reset build did not start"
        reset_attachment_worker = threading.Thread(target=attach_during_reset)
        reset_attachment_worker.start()
        reset_attachment_worker.join(0.1)
        assert reset_attachment_worker.is_alive(), (
            "attachment must wait while reset owns history_lock"
        )
        reset_build_release.set()
        reset_thread.join(2)
        reset_attachment_worker.join(2)
        assert not reset_thread.is_alive(), "reset did not finish"
        assert not reset_attachment_worker.is_alive(), "attachment did not finish"
        assert reset_result["info"] == {}
        assert reset_attachment_result["response"].get("result", {}).get("attached") is True
        assert len(reset_session["attached_images"]) == 1, reset_session
        assert "stale-before-reset.png" not in reset_session["attached_images"]

    # Lock the queue ownership boundary across prompt.submit. Acceptance must
    # detach an immutable batch under the same history lock used by queue writes,
    # then hand only that batch to the asynchronous success path. Initialization
    # failure discards the local batch without touching later attachments.
    prompt_submit = _rpc_method(tree, "prompt.submit")
    history_lock_blocks = [
        node
        for node in prompt_submit.body
        if isinstance(node, ast.With)
        and any(
            _session_subscript(item.context_expr, "history_lock")
            for item in node.items
        )
    ]
    assert len(history_lock_blocks) == 1, len(history_lock_blocks)
    prompt_lock = history_lock_blocks[0]
    submitted_batch_assigns = [
        node
        for node in ast.walk(prompt_lock)
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "submitted_images"
            for target in node.targets
        )
    ]
    prompt_queue_clears = [
        node
        for node in ast.walk(prompt_lock)
        if isinstance(node, ast.Assign)
        and isinstance(node.value, ast.List)
        and not node.value.elts
        and any(_session_subscript(target, "attached_images") for target in node.targets)
    ]
    assert len(submitted_batch_assigns) == len(prompt_queue_clears) == 1, (
        len(submitted_batch_assigns),
        len(prompt_queue_clears),
    )
    run_after_ready = next(
        node
        for node in ast.walk(prompt_submit)
        if isinstance(node, ast.FunctionDef) and node.name == "run_after_agent_ready"
    )
    prompt_run_calls = [
        node
        for node in ast.walk(run_after_ready)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_run_prompt_submit"
    ]
    assert len(prompt_run_calls) == 1, len(prompt_run_calls)
    assert len(prompt_run_calls[0].args) == 5, ast.dump(prompt_run_calls[0])
    assert isinstance(prompt_run_calls[0].args[4], ast.Name)
    assert prompt_run_calls[0].args[4].id == "submitted_images"
    failure_queue_mutations = [
        node
        for node in ast.walk(run_after_ready)
        if isinstance(node, (ast.Assign, ast.AugAssign))
        and any(
            _session_subscript(target, "attached_images")
            for target in getattr(node, "targets", [getattr(node, "target", None)])
        )
    ]
    assert failure_queue_mutations == [], (
        "initialization failure must discard only the detached local batch",
        failure_queue_mutations,
    )
    run_prompt_submit = _function(tree, "_run_prompt_submit")
    assert any(argument.arg == "images" for argument in run_prompt_submit.args.args)
    all_prompt_run_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_run_prompt_submit"
    ]
    assert len(all_prompt_run_calls) == 5, len(all_prompt_run_calls)
    assert all(len(node.args) == 5 for node in all_prompt_run_calls)
    explicit_batches = [node.args[4] for node in all_prompt_run_calls]
    assert sum(
        isinstance(batch, ast.Name) and batch.id == "submitted_images"
        for batch in explicit_batches
    ) == 1
    assert sum(
        isinstance(batch, ast.List) and not batch.elts for batch in explicit_batches
    ) == 4
    queue_helper = _function(tree, "_queue_attached_image")
    serialized_appends = [
        node
        for node in ast.walk(queue_helper)
        if isinstance(node, ast.With)
        and any(
            _session_subscript(item.context_expr, "history_lock")
            for item in node.items
        )
        and any(
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr == "append"
            for child in ast.walk(node)
        )
    ]
    assert len(serialized_appends) == 1, len(serialized_appends)
    parents = {
        child: parent
        for parent in ast.walk(tree)
        for child in ast.iter_child_nodes(parent)
    }

    def under_history_lock(node: ast.AST) -> bool:
        while node in parents:
            node = parents[node]
            if isinstance(node, ast.With) and any(
                _session_subscript(item.context_expr, "history_lock")
                for item in node.items
            ):
                return True
        return False

    attached_image_appends = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "append"
        and isinstance(node.func.value, ast.Call)
        and isinstance(node.func.value.func, ast.Attribute)
        and node.func.value.func.attr == "setdefault"
        and any(
            isinstance(argument, ast.Constant) and argument.value == "attached_images"
            for argument in node.func.value.args
        )
    ]
    assert len(attached_image_appends) == 4, len(attached_image_appends)
    assert all(under_history_lock(node) for node in attached_image_appends), (
        "every gateway image queue append must share prompt.submit's history lock",
        [node.lineno for node in attached_image_appends if not under_history_lock(node)],
    )
    queue_state_assignments = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.Assign, ast.AugAssign))
        and any(
            _session_subscript(target, key)
            for target in getattr(node, "targets", [getattr(node, "target", None)])
            for key in ("attached_images", "image_counter")
        )
    ]
    assert queue_state_assignments, "expected gateway image queue state assignments"
    assert all(under_history_lock(node) for node in queue_state_assignments), (
        "every gateway image queue state assignment must share history_lock",
        [node.lineno for node in queue_state_assignments if not under_history_lock(node)],
    )


def verify_tui_memory_deny_propagation(root: Path) -> None:
    tree = ast.parse(
        (root / "tui_gateway" / "server.py").read_text(encoding="utf-8")
    )
    make_agent = _function(tree, "_make_agent")
    agent_calls = [
        node
        for node in ast.walk(make_agent)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "AIAgent"
    ]
    assert len(agent_calls) == 1, "main TUI agent construction changed"
    assert any(
        keyword.arg == "disabled_toolsets" for keyword in agent_calls[0].keywords
    ), "main TUI agent omits disabled_toolsets"

    background = _function(tree, "_background_agent_kwargs")
    background_keys = {
        key.value
        for node in ast.walk(background)
        if isinstance(node, ast.Dict)
        for key in node.keys
        if isinstance(key, ast.Constant) and isinstance(key.value, str)
    }
    assert "disabled_toolsets" in background_keys, (
        "background TUI agent omits disabled_toolsets"
    )

    preview = _function(tree, "_ephemeral_preview_agent_kwargs")
    assert any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_background_agent_kwargs"
        for node in ast.walk(preview)
    ), "preview agent no longer inherits the background deny policy"


def verify_memory_lifecycle_deny(root: Path) -> None:
    """Execute the pinned constructor's policy helper and seal both gates."""
    tree = ast.parse(
        (root / "agent" / "agent_init.py").read_text(encoding="utf-8")
    )
    helper = _function(tree, "_june_resolve_memory_policy")
    namespace = {}
    exec(
        compile(
            "from __future__ import annotations\n" + ast.unparse(helper),
            str(root / "agent" / "agent_init.py"),
            "exec",
        ),
        namespace,
    )
    resolve = namespace["_june_resolve_memory_policy"]

    previous_hermes_cli = sys.modules.get("hermes_cli")
    previous_config = sys.modules.get("hermes_cli.config")
    hermes_cli_module = previous_hermes_cli or types.ModuleType("hermes_cli")
    config_module = previous_config or types.ModuleType("hermes_cli.config")
    original_load_config = getattr(config_module, "load_config", None)
    sys.modules["hermes_cli"] = hermes_cli_module
    sys.modules["hermes_cli.config"] = config_module
    try:
        config_module.load_config = lambda: {
            "agent": {"disabled_toolsets": ["browser", "memory"]}
        }
        disabled, lifecycle_denied = resolve(["web"])
        assert disabled == ["web", "memory"], disabled
        assert lifecycle_denied is True

        config_module.load_config = lambda: {"agent": {"disabled_toolsets": []}}
        disabled, lifecycle_denied = resolve(["memory", "web"])
        assert disabled == ["memory", "web"], disabled
        assert lifecycle_denied is True

        disabled, lifecycle_denied = resolve(["web"])
        assert disabled == ["web"], disabled
        assert lifecycle_denied is False
    finally:
        if original_load_config is not None:
            config_module.load_config = original_load_config
        if previous_config is None:
            sys.modules.pop("hermes_cli.config", None)
        if previous_hermes_cli is None:
            sys.modules.pop("hermes_cli", None)

    init_agent = _function(tree, "init_agent")
    init_source = ast.unparse(init_agent)
    assert "_june_resolve_memory_policy(disabled_toolsets)" in init_source
    assert "skip_memory = skip_memory or _june_memory_denied" in init_source
    assert init_source.count("if not skip_memory:") >= 2, (
        "native and external memory initialization are no longer lifecycle-gated"
    )


def verify_cross_process_config_writer(root: Path) -> None:
    try:
        __import__("yaml")
    except ImportError:
        # The bundle's Python has PyYAML. Keep this source-tree smoke runnable
        # with a bare host Python too by using JSON, which is a YAML subset.
        yaml_stub = types.ModuleType("yaml")
        yaml_stub.YAMLError = ValueError
        yaml_stub.safe_load = lambda source: json.loads(
            source.read() if hasattr(source, "read") else source
        )
        yaml_stub.dump = lambda data, stream, **_kwargs: json.dump(data, stream)
        sys.modules["yaml"] = yaml_stub
    patched_utils = load_module(
        "june_pinned_utils", root / "utils.py", defer_annotations=True
    )
    with tempfile.TemporaryDirectory(prefix="june-hermes-config-smoke-") as temp:
        config_path = Path(temp) / "config.yaml"
        config_path.write_text(
            json.dumps(
                {
                    "agent": {"disabled_toolsets": ["browser", "memory"]},
                    "user_value": "old",
                }
            ),
            encoding="utf-8",
        )
        patched_utils.atomic_yaml_write(
            config_path,
            {
                "agent": {"disabled_toolsets": ["browser"]},
                "user_value": "new",
            },
        )
        disabled = patched_utils.yaml.safe_load(config_path.read_text(encoding="utf-8"))
        assert disabled["agent"]["disabled_toolsets"] == ["browser", "memory"]
        assert disabled["user_value"] == "new"

        # Simulate June enabling Memory while a Hermes writer still holds an
        # older in-memory snapshot containing the deny. The current file wins.
        config_path.write_text(
            json.dumps(
                {
                    "agent": {"disabled_toolsets": ["browser"]},
                    "user_value": "latest",
                }
            ),
            encoding="utf-8",
        )
        patched_utils.atomic_yaml_write(
            config_path,
            {
                "agent": {"disabled_toolsets": ["browser", "memory"]},
                "user_value": "writer-update",
            },
        )
        enabled = patched_utils.yaml.safe_load(config_path.read_text(encoding="utf-8"))
        assert enabled["agent"]["disabled_toolsets"] == ["browser"]
        assert enabled["user_value"] == "writer-update"
        assert (config_path.parent / ".june-config.lock").is_file()

        # The writer must update a symlink's canonical target without replacing
        # the link, and must keep secret-bearing config owner-only.
        target_path = Path(temp) / "managed-config.yaml"
        target_path.write_text(
            json.dumps({"agent": {"disabled_toolsets": ["memory"]}}),
            encoding="utf-8",
        )
        os.chmod(target_path, 0o600)
        link_path = Path(temp) / "linked" / "config.yaml"
        link_path.parent.mkdir()
        link_path.symlink_to(target_path)
        patched_utils.atomic_yaml_write(
            link_path,
            {"agent": {"disabled_toolsets": ["memory"]}, "linked": True},
        )
        assert link_path.is_symlink(), "Hermes writer replaced config symlink"
        assert patched_utils.yaml.safe_load(
            target_path.read_text(encoding="utf-8")
        )["linked"] is True
        if os.name != "nt":
            assert target_path.stat().st_mode & 0o777 == 0o600

        if sys.platform == "darwin":
            subprocess.run(
                ["/bin/chmod", "+a", "everyone allow read", str(target_path)],
                check=True,
            )
            patched_utils.atomic_yaml_write(
                link_path,
                {"agent": {"disabled_toolsets": ["memory"]}, "acl": True},
            )
            listing = subprocess.run(
                ["/bin/ls", "-le", str(target_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            assert "allow read" in listing.stdout, (
                "Hermes writer discarded config ACL"
            )

        replace_source = ast.unparse(
            _function(
                ast.parse((root / "utils.py").read_text(encoding="utf-8")),
                "_june_replace_config",
            )
        )
        assert "ReplaceFileW" in replace_source, (
            "Windows config replacement no longer preserves destination security"
        )

        # Execute the TUI JSON-RPC config writer with a stale snapshot. It must
        # funnel through the same central writer and refresh its cache from the
        # reconciled bytes rather than caching the stale request body.
        config_path.write_text(
            json.dumps(
                {
                    "agent": {"disabled_toolsets": ["browser", "memory"]},
                    "user_value": "latest",
                }
            ),
            encoding="utf-8",
        )
        tui_tree = ast.parse(
            (root / "tui_gateway" / "server.py").read_text(encoding="utf-8")
        )
        save_config = _function(tui_tree, "_save_cfg")
        tui_namespace = {
            "Path": Path,
            "copy": __import__("copy"),
            "_hermes_home": config_path.parent,
            "_cfg_lock": threading.Lock(),
            "_cfg_cache": None,
            "_cfg_mtime": None,
            "_cfg_path": None,
        }
        previous_utils = sys.modules.get("utils")
        sys.modules["utils"] = patched_utils
        try:
            exec(
                compile(
                    "from __future__ import annotations\n" + ast.unparse(save_config),
                    str(root / "tui_gateway" / "server.py"),
                    "exec",
                ),
                tui_namespace,
            )
            tui_namespace["_save_cfg"](
                {
                    "agent": {"disabled_toolsets": ["browser"]},
                    "user_value": "TUI update",
                }
            )
        finally:
            if previous_utils is None:
                sys.modules.pop("utils", None)
            else:
                sys.modules["utils"] = previous_utils
        tui_saved = patched_utils.yaml.safe_load(
            config_path.read_text(encoding="utf-8")
        )
        assert tui_saved["agent"]["disabled_toolsets"] == ["browser", "memory"]
        assert tui_saved["user_value"] == "TUI update"
        assert tui_namespace["_cfg_cache"] == tui_saved

        # Execute the pinned Telegram gateway's real persistence method. It
        # takes a config snapshot before calling the central writer, so inject a
        # June disable between those steps and prove the late policy survives
        # while Telegram's unrelated thread id is still saved.
        config_path.write_text(
            json.dumps(
                {
                    "agent": {"disabled_toolsets": ["browser"]},
                    "platforms": {
                        "telegram": {
                            "extra": {
                                "dm_topics": [
                                    {
                                        "chat_id": 42,
                                        "topics": [{"name": "June"}],
                                    }
                                ]
                            }
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        telegram_tree = ast.parse(
            (root / "gateway" / "platforms" / "telegram.py").read_text(
                encoding="utf-8"
            )
        )
        persist_method = _function(telegram_tree, "_persist_dm_topic_thread_id")
        writer_class = ast.ClassDef(
            name="TelegramWriter",
            bases=[],
            keywords=[],
            body=[persist_method],
            decorator_list=[],
        )
        module = ast.Module(body=[writer_class], type_ignores=[])
        ast.fix_missing_locations(module)
        warnings = []
        namespace = {
            "logger": types.SimpleNamespace(
                info=lambda *_args, **_kwargs: None,
                warning=lambda *args, **kwargs: warnings.append((args, kwargs)),
            )
        }
        exec(
            compile(module, str(root / "gateway" / "platforms" / "telegram.py"), "exec"),
            namespace,
        )

        original_atomic_yaml_write = patched_utils.atomic_yaml_write
        interleaved = False

        def atomic_after_june_disable(path, data, **kwargs):
            nonlocal interleaved
            if not interleaved:
                latest = patched_utils.yaml.safe_load(path.read_text(encoding="utf-8"))
                latest["agent"]["disabled_toolsets"].append("memory")
                path.write_text(json.dumps(latest), encoding="utf-8")
                interleaved = True
            return original_atomic_yaml_write(path, data, **kwargs)

        patched_utils.atomic_yaml_write = atomic_after_june_disable
        hermes_constants = types.ModuleType("hermes_constants")
        hermes_constants.get_hermes_home = lambda: config_path.parent
        previous_utils = sys.modules.get("utils")
        previous_constants = sys.modules.get("hermes_constants")
        sys.modules["utils"] = patched_utils
        sys.modules["hermes_constants"] = hermes_constants
        try:
            writer = namespace["TelegramWriter"]()
            writer.name = "telegram"
            writer._persist_dm_topic_thread_id(42, "June", 777)
        finally:
            patched_utils.atomic_yaml_write = original_atomic_yaml_write
            if previous_utils is None:
                sys.modules.pop("utils", None)
            else:
                sys.modules["utils"] = previous_utils
            if previous_constants is None:
                sys.modules.pop("hermes_constants", None)
            else:
                sys.modules["hermes_constants"] = previous_constants

        telegram_saved = patched_utils.yaml.safe_load(
            config_path.read_text(encoding="utf-8")
        )
        assert not warnings, warnings
        assert interleaved, "Telegram writer did not reach the shared atomic writer"
        assert telegram_saved["agent"]["disabled_toolsets"] == ["browser", "memory"], (
            telegram_saved["agent"]["disabled_toolsets"]
        )
        assert (
            telegram_saved["platforms"]["telegram"]["extra"]["dm_topics"][0][
                "topics"
            ][0]["thread_id"]
            == 777
        )


def verify_model_deny_wins(root: Path) -> None:
    class Registry:
        @staticmethod
        def get_definitions(names, quiet=False):
            del quiet
            return [
                {"type": "function", "function": {"name": name}}
                for name in sorted(names)
            ]

    mapping = {
        "memory": {"memory_read", "memory_write"},
        "web": {"web_search"},
    }

    # Execute the pinned resolver body in isolation. Importing all of
    # model_tools would discover real tools and plugins, making this smoke
    # environment-dependent; extracting the actual function keeps the
    # precedence logic real while its registry inputs stay deterministic.
    model_tree = ast.parse((root / "model_tools.py").read_text(encoding="utf-8"))
    compute = _function(model_tree, "_compute_tool_definitions")
    namespace = {
        "os": __import__("os"),
        "resolve_toolset": lambda name: set(mapping.get(name, set())),
        "validate_toolset": lambda name: name in mapping,
        "_LEGACY_TOOLSET_MAP": {},
        "registry": Registry(),
        "logger": types.SimpleNamespace(
            warning=lambda *_args, **_kwargs: None,
            debug=lambda *_args, **_kwargs: None,
        ),
    }
    exec(
        compile(
            "from __future__ import annotations\n" + ast.unparse(compute),
            str(root / "model_tools.py"),
            "exec",
        ),
        namespace,
    )
    definitions = namespace["_compute_tool_definitions"](
        enabled_toolsets=["memory", "web"],
        disabled_toolsets=["memory"],
        quiet_mode=True,
        skip_tool_search_assembly=True,
    )
    names = {definition["function"]["name"] for definition in definitions}
    assert names == {"web_search"}, (
        "disabled memory toolset did not win over the enabled allowlist: %s" % names
    )


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
    parser.add_argument(
        "--upstream-root",
        type=Path,
        help="Optional exact upstream source snapshot to patch and re-verify",
    )
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        upstream_root = args.upstream_root.resolve() if args.upstream_root else None
        verify_patch_state_machine(root, upstream_root)
        verify_new_session_image_attach_is_immediate(root)
        verify_tui_memory_deny_propagation(root)
        verify_memory_lifecycle_deny(root)
        verify_cross_process_config_writer(root)
        verify_model_deny_wins(root)
        exercise(load_approval(root))
    except Exception as exc:
        print("patched Hermes compatibility protocol: FAIL: %s" % exc, file=sys.stderr)
        return 1
    print("patched Hermes compatibility protocol: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
