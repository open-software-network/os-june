---
status: accepted
date: 2026-07-17
---

# Bundle separate Hermes runtimes for both macOS architectures

## Context

June's macOS app is universal, but the embedded Hermes bundle previously held
one uv-managed CPython interpreter and one dependency tree built for the ARM64
release runner. The universal June executable could start on Intel while its
Hermes launcher could not. Making only the interpreter universal would still
leave native Python extensions such as pydantic-core, cryptography, psutil,
httptools, uvloop, and PyYAML tied to the build host.

The practical alternatives were a fully universal2 Python environment or two
architecture-owned environments. A universal2 environment would require
merging and proving every transitive Mach-O from third-party wheels, including
packages that do not publish universal2 wheels.

## Decision

The macOS resource bundle contains one shared pinned and patched Hermes source
tree plus two complete runtime variants:

```text
native/hermes/
  bin/hermes
  bin/python3
  hermes-agent/
  python/arm64/current/
  python/x86_64/current/
  site-packages/arm64/
  site-packages/x86_64/
```

The relocatable launchers select a tree from the current process architecture
and fail on any unsupported value. uv receives an explicit target-qualified
CPython request and `--python-platform` for each dependency tree. Native
dependencies must come from binary wheels; source-built native artifacts are
not accepted. A post-build audit walks every executable, `.so`, and `.dylib`,
rejects Mach-O files outside an architecture-owned tree, and requires every
Mach-O to support its tree's architecture.

The ARM64 release runners execute the relocated arm64 launcher natively and the
x86_64 launcher through Rosetta. Missing Rosetta is a release blocker, not a
reason to infer Intel support from file metadata. RC and stable publication
also audit the Hermes tree copied into the final signed `.app`. The execution
gate imports every native extension in each target dependency tree, not only a
representative package subset.

The source pin, archive checksum, June PATCHSET, patched-source verification,
no-symlink rule, checked-hash bytecode, managed-install fallback, and nested
hardened-runtime signing remain unchanged. Windows keeps its existing bundle.
Both macOS updater platform keys continue to reference one universal archive.

## Consequences

- The app bundle is larger because CPython and native dependencies are stored
  twice.
- Release runners must be ARM64 Macs with Rosetta available so both execution
  paths are exercised before publication.
- Cache reuse now depends on an exact `arm64 x86_64` architecture stamp and a
  versioned universal cache key. A legacy host-only cache cannot be published.
- A new native dependency without wheels for either target blocks the release
  until the dependency or packaging strategy changes.
