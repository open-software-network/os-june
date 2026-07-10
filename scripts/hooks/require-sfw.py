#!/usr/bin/env python3
"""PreToolUse hook: route new-package installs through Socket Firewall (sfw).

Blocks Bash commands that pull new package code into the repo (pnpm
add/update/dlx, cargo add/install/update) unless prefixed with `sfw`, and
blocks non-pnpm JS package managers entirely. Guardrail, not a sandbox:
anchored per-segment matching keeps false positives low but a determined
command can slip past — the authoritative rule is
spec/package-install-security.md.
"""

import json
import re
import sys

PNPM_GUARDED = re.compile(r"^pnpm\s+(add|update|up|dlx)\b")
# `pnpm install <pkg>` resolves a new package; a bare/flag-only install does not.
PNPM_INSTALL = re.compile(r"^pnpm\s+(i|install)\b(.*)$")
CARGO_GUARDED = re.compile(r"^cargo\s+(add|install|update)\b")
# npx / npm exec download and run registry code that never touches a lockfile.
NPX_GUARDED = re.compile(r"^(npx|npm\s+exec)\b")
WRONG_PM = re.compile(r"^(bun|bunx|yarn)\s+(add|install|remove|update|upgrade|\S+)\b")
# npm project installs would create package-lock.json; global tool installs are fine.
NPM_LOCAL_INSTALL = re.compile(r"^npm\s+(i|install|ci|add)\b(?!.*(\s-g\b|\s--global\b))")


def pnpm_install_with_package(seg):
    m = PNPM_INSTALL.match(seg)
    if not m:
        return False
    # Any non-flag token means a package argument (a flag value like
    # `--filter web` also matches — over-blocking is fine for a guardrail,
    # and the sfw prefix is harmless on a plain restore).
    return any(not tok.startswith("-") for tok in m.group(2).split())


def check(command):
    for raw in re.split(r"&&|\|\||;|\||&|[\n\r]+", command):
        seg = re.sub(r"^(?:\w+=\S*\s+)+", "", raw.strip())
        if seg.startswith("sfw "):
            continue
        if WRONG_PM.match(seg) or NPM_LOCAL_INSTALL.match(seg):
            return (
                "This repo is pnpm-only (no bun/npm/yarn lockfiles). Use "
                "`sfw pnpm add <pkg>` instead; see spec/package-install-security.md."
            )
        if (
            PNPM_GUARDED.match(seg)
            or pnpm_install_with_package(seg)
            or CARGO_GUARDED.match(seg)
            or NPX_GUARDED.match(seg)
        ):
            return (
                "New-package installs must go through Socket Firewall: rerun as "
                f"`sfw {seg}` (one-time setup: `npm i -g sfw`). See "
                "spec/package-install-security.md."
            )
    return None


def main():
    try:
        payload = json.load(sys.stdin)
        command = payload.get("tool_input", {}).get("command", "")
    except Exception:
        return 0
    if not isinstance(command, str) or not command:
        return 0
    message = check(command)
    if message:
        print(message, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
