#!/usr/bin/env python3
"""Import every native extension in a bundled Hermes dependency tree."""

from __future__ import annotations

import importlib
import re
import sys
from pathlib import Path


def module_name(site_packages: Path, extension: Path) -> str:
    relative = extension.relative_to(site_packages).as_posix()
    without_suffix = re.sub(r"\.(?:cpython-[^.]+|abi3)\.so$", "", relative)
    if without_suffix == relative:
        without_suffix = relative.removesuffix(".so")
    return without_suffix.replace("/", ".")


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <site-packages>", file=sys.stderr)
        return 2

    site_packages = Path(sys.argv[1]).resolve()
    if not site_packages.is_dir():
        print(f"site-packages directory is missing: {site_packages}", file=sys.stderr)
        return 1

    extensions = sorted(site_packages.rglob("*.so"))
    if not extensions:
        print(f"no native extensions found under {site_packages}", file=sys.stderr)
        return 1

    failures: list[str] = []
    for extension in extensions:
        name = module_name(site_packages, extension)
        try:
            importlib.import_module(name)
        except Exception as error:  # noqa: BLE001 - report all failed extensions together
            failures.append(f"{name} ({extension}): {error!r}")

    if failures:
        print("native extension imports failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(f"native extension imports: PASS ({len(extensions)} modules)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
