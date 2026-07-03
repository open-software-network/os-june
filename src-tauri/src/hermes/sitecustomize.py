# Installed into June-managed and bundled Hermes Python runtimes.
import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def _pin_hermes_core_cron_package():
    """Keep top-level `cron` imports pointed at Hermes core code."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidates = []
        if (parent / "pyproject.toml").is_file() and (parent / "hermes_cli").is_dir():
            candidates.append(parent / "cron" / "__init__.py")
        hermes_root = parent / "hermes-agent"
        if (hermes_root / "pyproject.toml").is_file() and (hermes_root / "hermes_cli").is_dir():
            candidates.append(hermes_root / "cron" / "__init__.py")
        for init_file in candidates:
            if init_file.is_file():
                _load_cron_from(init_file)
                return


def _load_cron_from(init_file):
    existing = sys.modules.get("cron")
    existing_file = getattr(existing, "__file__", None) if existing is not None else None
    if existing_file:
        try:
            if Path(existing_file).resolve() == init_file:
                return
        except OSError:
            pass

    spec = importlib.util.spec_from_file_location(
        "cron",
        init_file,
        submodule_search_locations=[str(init_file.parent)],
    )
    if spec is None or spec.loader is None:
        return

    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get("cron")
    sys.modules["cron"] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        if previous is None:
            sys.modules.pop("cron", None)
        else:
            sys.modules["cron"] = previous


_pin_hermes_core_cron_package()
