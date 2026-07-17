# Managed Hermes startup isolation design

> **Superseded:** The current design is
> [Managed Hermes final admission remediation](2026-07-17-managed-hermes-final-admission-remediation-design.md).
> This document records the third-review checkpoint only. Its categorical
> link rejection, path-reopened extraction, missing-dashboard-assets, and
> process-map admission statements are historical and must not be used as the
> current implementation contract.

**Date:** 2026-07-17

**Scope:** Third security-review remediation for Task 4 GitHub capability
isolation. The schema-2 integrity design remains in force. Task 5 broker wiring
and Task 6 bearer-token removal remain out of scope.

## Goal

Make the authenticated Python closure the process that actually starts Hermes
and every first-party MCP, isolate all Python startup from ambient import
controls, remove ambient executables from the managed Unix bootstrap, and
restore safe general-runtime fallback without ever exposing GitHub through an
untrusted runtime.

## Proven pinned entrypoint

The pinned v2026.6.19 console script imports and calls
`hermes_cli.main:main`. Its shell preamble uses `exec`, so the Python process is
already the signal-receiving process. On the pinned runtime,
`hermes --version` and `python -m hermes_cli.main --version` produced identical
stdout and both invalid-argument runs produced identical stdout, stderr, and
exit status 2. The module ends in `if __name__ == "__main__": main()`.

June therefore replaces the console-script hop with an authenticated startup
bootstrap:

```text
<authenticated-python> -I -S -B -c <fixed-bootstrap> <Hermes arguments>
```

`-I` implies isolated mode, ignores every `PYTHON*` environment variable,
omits the user site, and removes the working directory from the safe import
path. `-S` delays authenticated site initialization until the fixed bootstrap
has removed the dashboard bearer. The bootstrap calls `site.main()`, restores
the bearer, and executes `hermes_cli.main` with `runpy`. `-B` preserves the
existing no-bytecode-write behavior because `-I` also implies `-E` and would
otherwise ignore `PYTHONDONTWRITEBYTECODE`.

## Invocation model and environment

A `PythonInvocation` value carries one interpreter program and the exact
prefix arguments `-I`, `-S`, `-B`. `HermesCommandResolution` adds the fixed
bootstrap before dashboard or TUI arguments. All 11 rendered first-party MCP
registrations render the same interpreter prefix before one of ten distinct
script paths: context, web, image, video, recorder, GitHub, Gmail, and Calendar
read/action scripts. Earned-autonomy registrations reuse an authenticated
action script.

The process environment removes `PYTHONPATH`, `PYTHONHOME`, `PYTHONUSERBASE`,
`PYTHONSTARTUP`, `PYTHONINSPECT`, `PYTHONWARNINGS`, `PYTHONBREAKPOINT`,
`PYTHONPLATLIBDIR`, `PYTHONEXECUTABLE`, and `__PYVENV_LAUNCHER__` in addition
to the existing Hermes/provider variables. It sets `PYTHONNOUSERSITE=1`,
`PYTHONSAFEPATH=1`, and `PYTHONDONTWRITEBYTECODE=1` as defense in depth for
descendants that do not use June's invocation type. The TUI launcher performs
the same unset/export sequence.

This is required while the old bearer-token MCP path still exists: a poisoned
`sitecustomize.py`, user-site `.pth`, or shadow module must not execute before
the intended MCP script and read inherited capability variables.

## Managed bootstrap trust boundary

Rust, not the shell, downloads both fixed archives: the pinned Hermes source
and the platform-selected uv 0.11.15 artifact. A dedicated reqwest client uses
rustls, no redirects, fixed HTTPS URLs, total/connect timeouts, content-length
checks, and a streaming byte cap. Rust computes SHA-256 and rejects any
mismatch before creating an extraction destination. Archive and integrity
temporaries use mode 0600; private staging/integrity directories use mode 0700
on Unix.

The already-locked `flate2` and `tar` crates become direct dependencies so
extraction is pure Rust and independent of `PATH`. Before extraction, every
tar header is validated:

- exactly one expected top-level directory is allowed;
- absolute paths, `..`, `.`, backslashes, empty components, and non-UTF-8
  names are rejected;
- duplicate or case-colliding normalized paths are rejected;
- a regular-file ancestor cannot also contain children;
- only regular files and directories are accepted;
- symlinks and hardlinks are rejected categorically, so no link target can
  escape;
- block/character devices, FIFO entries, and unknown/sparse entry types are
  rejected.

Extraction reopens the verified archive, writes only into a new private
directory, and then walks the result without following links. The expected
Hermes root, `uv` executable, locked dependency files, interpreter, launcher,
stdlib/site-packages, and plugin-loader critical paths are revalidated before
sealing.

The privileged shell receives only verified absolute source and uv paths. It
runs through absolute `/bin/bash` with `env_clear`, a minimal
`PATH=/usr/bin:/bin`, explicit variables, and no inherited Python or package
manager controls. It contains no curl, checksum program, tar, or npm call. It
continues to use only `uv sync --extra all --locked`; if the pinned source does
not contain usable dashboard assets, installation fails closed rather than
running ambient npm.

`ManagedUvArtifact` is selected by the exact `(target_os, target_arch,
target_env)` tuple. Linux supports only explicit GNU tuples; musl and unknown
libc environments fail closed. macOS uses its explicit empty target-env tuple.

## Pre-launch fallback and downgrade resistance

Bundled and explicit environment overrides resolve directly. When no bundled
runtime exists, June predicts managed so it can render the normal configuration
before the final one-digest admission point. Final admission returns a complete
resolution rather than a boolean:

- current/repaired managed runtime: return the authenticated isolated
  invocation and retain GitHub eligibility;
- fresh install or schema migration unavailable: choose user-local Hermes when
  present, otherwise the PATH fallback, both categorically GitHub-ineligible;
- existing schema-2 integrity violation, path escape, or critical-path
  violation: fail closed, never downgrade;
- any managed preparation failure while a managed process is already admitted:
  fail closed, never downgrade.

The bridge records each spawned process's command source. Fallback is only a
pre-launch selection for a process slot with no admitted managed process.

If final selection changes from managed to fallback, June regenerates every
first-party MCP configuration with the fallback isolated interpreter, removes
the GitHub server/toolset, and regenerates `SOUL.md` before spawning. No stale
managed interpreter path or GitHub capability survives the rewrite. The TUI
uses the same admission and downgrade rules under the shared preparation lock.

## Tests

Strict RED/GREEN tests cover:

- exact `-I -S -B` ordering for Hermes and every first-party MCP renderer,
  plus the fixed bearer-hiding bootstrap for Hermes;
- a real disposable venv with poisoned `PYTHONPATH` `sitecustomize`, shadow
  modules, user-site `.pth`, invalid `PYTHONHOME`, attacker `PYTHONUSERBASE`,
  and bearer-token sentinels; Hermes and all ten MCP modules must import their
  required standard-library dependencies without executing poison;
- Rust download caps/checksums and archive rejection for absolute/traversal,
  link, collision, device/FIFO, and top-level-layout attacks;
- poisoned `PATH` executables named curl, tar, shasum, sha256sum, and npm never
  execute during the local bootstrap fixture and cannot change sealed bytes;
- locked-only shell source and an all-local clean schema-2 fixture that starts
  through the isolated module entrypoint, imports all first-party MCPs, and
  prepares again without installer invocation;
- managed-install failure selecting user-local then PATH fallback, rerendering
  isolated interpreter paths, and omitting GitHub;
- integrity violation and already-admitted managed process failures never
  selecting fallback;
- Linux GNU selection and musl/unknown target-env rejection;
- integrity file mode 0600 and private parent/staging mode 0700.

All prior schema-2, sandbox kernel, plugin, manifest, pinned smoke, check,
clippy, formatting, and shell gates remain required. If disk or network blocks
a live official-archive install, the local checked fixture qualifies the code
path and the report assigns live artifact qualification to Task 8.

## Residual

The existing same-user verify-to-exec race remains: userspace cannot bind a
file digest to `exec`. The macOS sandbox prevents the ordinary agent from
writing or hard-linking the protected runtime and seal. Windows stays
compile-time GitHub-disabled and is not broadened by this remediation.
