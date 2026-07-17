# Managed Hermes trust remediation design

**Date:** 2026-07-17

**Scope:** Security remediation for Task 4 of GitHub agent-read capability
isolation. Task 5 broker wiring remains out of scope.

## Goal

Preserve GitHub tool eligibility only when the complete executable and Python
dependency closure is authenticated, make the managed overlay update path
atomic and network-free, close the macOS hard-link write-jail bypass, and keep
steady-state startup to one full managed-runtime verification immediately
before execution.

## Integrity record v2

The external managed-runtime integrity record moves to schema 2. It records the
pinned Hermes source archive identity, a base-tree SHA-256 digest, and the exact
SHA-256 identities of app-owned overlay files.

The base-tree digest excludes only these exact canonical files:

- `hermes-agent/plugins/june_github/plugin.yaml`
- `hermes-agent/plugins/june_github/__init__.py`
- the discovered in-tree Python `sitecustomize.py`

No directory, glob, prefix, or pattern is excluded. Each excluded file must be
a plain regular file with the exact bytes embedded in June. The GitHub plugin
directory must contain exactly the two canonical entries. Every other runtime,
interpreter, standard-library, package, launcher, and dependency byte remains
in the base-tree digest.

Preparation runs under one shared lock. It reads cheap record metadata, applies
the canonical app-owned overlay, updates overlay identities atomically when the
base identity is current, and performs one full normalized tree verification
immediately before execution. A base-tree mismatch triggers a clean,
checksum-pinned reinstall and one post-install verification. Schema 1 cannot be
migrated in place because it authenticated only symlink text for an interpreter
outside the tree; it therefore requires a clean reinstall.

## Executable and dependency closure

Command resolution carries two explicit executable paths: the Hermes launcher
and the Python interpreter used by every June MCP subprocess. Bundled builds
use the standalone interpreter inside the signed app resource tree. Managed
Unix installs use a checksum-pinned uv 0.11.15 release archive, install CPython
3.11 directly under `hermes-runtime/python/current`, and run only
`uv sync --extra all --locked` against the checksum-pinned Hermes source's
`uv.lock`. The managed launcher and June MCPs use that in-tree interpreter.

The integrity verifier rejects any symlink or reparse target that resolves
outside the managed runtime, including interpreter and standard-library paths.
It requires the launcher, Python executable, Python home, `pyvenv.cfg` where
present, and discovered site-packages components to be plain or in-tree as
specified. Unsupported OS/architecture pairs fail closed instead of using an
unverified uv artifact.

The official uv 0.11.15 `sha256.sum` release asset is the checksum source. This
change supports only platform tuples whose artifact SHA-256 is copied from that
manifest and tested. Windows managed installation remains ineligible for the
GitHub toolset until it has an equivalent locked bootstrap and authenticated
closure. GitHub registration is compile-time fail-closed on Windows.

All ordinary dependency-resolution fallbacks are removed from the Unix and
Windows bundlers. The legacy Windows managed script may continue to support the
general runtime, but it can never make GitHub eligible.

## macOS sandbox hard-link boundary

The Seatbelt profile adds a global `(deny file-link)` after `(allow default)`
and never re-grants it. The protected-path set includes the managed runtime,
the external integrity record, and signed app resources. This prevents a jailed
agent from hard-linking protected bytes into writable `HERMES_HOME` and
modifying the original through the alias.

Kernel tests execute the generated profile with `/usr/bin/sandbox-exec`, try to
hard-link both a managed loader and the external integrity record into the
writable Hermes home, then attempt overwrite. Both operations must be denied
and both protected source files must retain their original bytes. Existing
runtime reads, imports, configuration writes, and workspace writes remain
allowed.

## Startup cost and locking

Auto-start availability reads only cheap path and integrity-record metadata. It
does not compute a tree digest synchronously. Explicit dashboard start and the
developer TUI both acquire the same `HermesBridge.start_lock` across command
resolution, overlay synchronization, install/repair, integrity verification,
and spawn or launcher creation. Concurrent dashboard/TUI and TUI/TUI attempts
therefore cannot interleave preparation.

Instrumentation tests assert zero full digests for cheap auto-start
availability, one digest for a current steady-state explicit preparation, and
at most two for a repair path. A deterministic concurrency test blocks one
preparation and proves the second cannot enter until the first releases the
shared lock.

## Windows atomic replacement

`ReplaceFileW` uses zero flags because `REPLACEFILE_WRITE_THROUGH` is explicitly
unsupported. It supplies a unique same-directory backup path. On success, the
backup is removed. On documented failure states:

- 1175 and 1176 preserve the original names and all recovery artifacts.
- 1177 may move the original destination to the backup. June restores the
  backup to the missing destination before returning failure.
- any ambiguous or failed recovery returns an error while preserving the
  backup. Cleanup never deletes the only known-good copy.

Unit seams model each documented partial state. Native Windows integration is
not claimed on a macOS host; the report records that limitation and the
fail-closed recovery behavior.

## Verification

Strict RED/GREEN tests cover hard-link kernel denial, old-seal/new-overlay
first-resolution success without reinstall, escaping interpreter rejection,
external-closure tamper rejection, absent unlocked commands, hash-call budgets,
cheap auto-start, Windows platform ineligibility, Windows replacement recovery,
and shared-lock serialization. All earlier Task 4 regressions and project gates
remain required.
