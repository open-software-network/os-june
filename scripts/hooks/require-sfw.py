#!/usr/bin/env python3
"""PreToolUse hook: route new-package installs through Socket Firewall (sfw).

Blocks Bash commands that pull new package code into the repo (pnpm
add/update/dlx/create or mutable install, cargo add/install/update, and
registry-executing npm commands) unless prefixed with `sfw`, and blocks
non-pnpm JS package managers entirely. Guardrail, not a sandbox: tokenized
per-segment matching covers ordinary CLI option forms, but a determined
command can slip past — the authoritative rule is
spec/package-install-security.md.
"""

import json
import re
import shlex
import sys

PNPM_GUARDED = {"add", "update", "up", "dlx", "create"}
PNPM_INSTALL = {"i", "install"}
PNPM_GLOBAL_VALUE_OPTIONS = {
    "-C",
    "--config-dir",
    "--dir",
    "-F",
    "--filter",
    "--filter-prod",
    "--global-bin-dir",
    "--global-dir",
    "--loglevel",
    "--package-import-method",
    "--reporter",
    "--store-dir",
}
CARGO_GUARDED = {"add", "install", "update"}
CARGO_GLOBAL_VALUE_OPTIONS = {"--color", "--config", "-C"}
COREPACK_GUARDED = {"install", "prepare", "up", "use"}
COREPACK_VALUE_OPTIONS = {"--install-directory"}
NPM_INSTALL_COMMANDS = {"i", "install", "ci", "add"}
NPM_REGISTRY_COMMANDS = {"create", "init", "exec"}
NPM_GLOBAL_VALUE_OPTIONS = {
    "--cache",
    "--location",
    "--loglevel",
    "--prefix",
    "--registry",
    "--userconfig",
    "-w",
    "--workspace",
}
NPM_GLOBAL_FLAGS = {"-g", "--global", "--location=global"}
NPM_INSTALL_VALUE_OPTIONS = NPM_GLOBAL_VALUE_OPTIONS | {"--location"}


def command_tokens(seg):
    try:
        tokens = shlex.split(seg)
    except ValueError:
        return []
    while tokens and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]):
        tokens.pop(0)
    if tokens and tokens[0] == "command":
        tokens.pop(0)
        while tokens and tokens[0].startswith("-"):
            tokens.pop(0)
    if tokens and tokens[0] == "env":
        tokens.pop(0)
        while tokens:
            if tokens[0] in {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}:
                del tokens[:2]
            elif tokens[0].startswith("-") or re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]
            ):
                tokens.pop(0)
            else:
                break
    return tokens


def subcommand(tokens, value_options, allow_toolchain=False):
    index = 1
    if allow_toolchain and index < len(tokens) and tokens[index].startswith("+"):
        index += 1
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            index += 1
            break
        if token in value_options:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        break
    if index >= len(tokens):
        return None, []
    return tokens[index], tokens[index + 1 :]


def frozen_pnpm_restore(args):
    frozen = any(
        token == "--frozen-lockfile" or token == "--frozen-lockfile=true"
        for token in args
    )
    mutable = any(
        token
        in {
            "--fix-lockfile",
            "--frozen-lockfile=false",
            "--lockfile=false",
            "--no-frozen-lockfile",
            "--no-lockfile",
        }
        or token.startswith("--fix-lockfile=")
        or token.startswith("--lockfile=")
        or not token.startswith("-")
        for token in args
    )
    return frozen and not mutable


def npm_install(tokens, command, args):
    if not tokens or tokens[0] != "npm" or command not in NPM_INSTALL_COMMANDS:
        return None
    global_install = any(token in NPM_GLOBAL_FLAGS for token in tokens[1:])
    global_install = global_install or any(
        tokens[index] == "--location" and tokens[index + 1] == "global"
        for index in range(len(tokens) - 1)
    )
    packages = []
    index = 0
    while index < len(args):
        token = args[index]
        if token in NPM_INSTALL_VALUE_OPTIONS:
            index += 2
        elif token.startswith("-"):
            index += 1
        else:
            packages.append(token)
            index += 1
    return global_install, packages


def is_sfw_bootstrap(global_install, packages):
    return global_install and len(packages) == 1 and re.fullmatch(
        r"sfw(?:@[^\s]+)?", packages[0]
    )


def check(command):
    # Backslash-newline continues a command across lines; collapse it so the
    # newline split below cannot break one command into non-matching pieces.
    command = re.sub(r"\\\r?\n\s*", " ", command)
    # Separators and substitution openers ($(, `, <(, >() all start a new
    # segment, so a guarded command nested inside them still hits the
    # anchored patterns below.
    for raw in re.split(r"&&|\|\||;|\||&|[\n\r]+|\$\(|`|[<>]\(", command):
        tokens = command_tokens(raw.strip())
        wrapped = bool(tokens and tokens[0] == "sfw")
        if wrapped:
            tokens = tokens[1:]
        if not tokens:
            continue
        executable = tokens[0]
        guarded = False
        if executable in {"bun", "bunx", "yarn"}:
            return (
                "This repo is pnpm-only (no bun/npm/yarn lockfiles). Use "
                "`sfw pnpm add <pkg>` instead; see spec/package-install-security.md."
            )
        if executable == "corepack":
            command_name, args = subcommand(tokens, COREPACK_VALUE_OPTIONS)
            if command_name in {"pnpm", "npm", "yarn", "bun", "bunx"}:
                tokens = [command_name, *args]
                executable = tokens[0]
            elif command_name in COREPACK_GUARDED:
                guarded = True
        if executable == "pnpm":
            command_name, args = subcommand(tokens, PNPM_GLOBAL_VALUE_OPTIONS)
            guarded = guarded or command_name in PNPM_GUARDED
            guarded = guarded or (
                command_name in PNPM_INSTALL and not frozen_pnpm_restore(args)
            )
            guarded = guarded or (
                command_name == "audit"
                and any(
                    token == "--fix" or token.startswith("--fix=")
                    for token in args
                )
            )
        elif executable == "cargo":
            command_name, args = subcommand(
                tokens, CARGO_GLOBAL_VALUE_OPTIONS, allow_toolchain=True
            )
            guarded = guarded or command_name in CARGO_GUARDED
        elif executable == "npm":
            command_name, args = subcommand(tokens, NPM_GLOBAL_VALUE_OPTIONS)
            guarded = guarded or command_name in NPM_REGISTRY_COMMANDS
        else:
            command_name, args = None, []
            guarded = guarded or executable in {"npx", "pnpx"}
        npm = npm_install(tokens, command_name, args)
        if npm:
            global_install, packages = npm
            if not global_install:
                return (
                    "This repo is pnpm-only (no bun/npm/yarn lockfiles). Use "
                    "`sfw pnpm add <pkg>` instead; see "
                    "spec/package-install-security.md."
                )
            if not wrapped and not is_sfw_bootstrap(global_install, packages):
                return (
                    "Global npm installs must go through Socket Firewall: rerun as "
                    f"`sfw {' '.join(tokens)}`. The one-time `npm i -g sfw` "
                    "bootstrap is the only exception; see "
                    "spec/package-install-security.md."
                )
        if guarded and not wrapped:
            return (
                "New-package installs must go through Socket Firewall: rerun as "
                f"`sfw {' '.join(tokens)}` (one-time setup: `npm i -g sfw`). See "
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
