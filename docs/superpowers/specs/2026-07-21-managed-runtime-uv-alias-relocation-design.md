# Managed runtime uv alias relocation design

## Context

June installs its checksum-verified managed Hermes runtime in a private
temporary sibling directory and renames the completed tree to
`hermes-runtime`. The managed Python installation is created by the pinned
`uv` binary inside that staging tree.

Live worktree QA reproduced a post-install failure after the archive download
and extraction fixes. The runtime installation completed and created the
expected launcher, interpreter, plugin overlay, and metadata, but June did not
write `hermes-runtime-integrity-v1.json`. Starting an agent then surfaced
`No such file or directory (os error 2)`.

The pinned `uv python install` command creates two top-level Python entries:

- the versioned CPython directory that June moves to `python/current`;
- a convenience alias named `cpython-3.11-<platform>` whose absolute target is
  the versioned directory inside the staging path.

Moving the versioned directory immediately breaks that alias. The fail-closed
tree digest correctly tries to resolve every runtime symlink and rejects the
broken alias with OS error 2. The alias is not used by June's launcher or
interpreter closure.

## Decision

The Unix managed-runtime installer will remove only the verified top-level
`uv` CPython alias associated with the selected versioned installation before
moving that installation to `python/current`.

The installer will identify the alias through the controlled, newly created
`runtime_dir/python` directory and validate that it is a symbolic link whose
target is the exact versioned CPython directory selected for the install. It
will fail installation if the expected relationship cannot be established.
It will not remove arbitrary links or weaken the later tree walk.

After removing the redundant alias, June will move the real interpreter
directory, complete the runtime, compute the full base-tree digest, and write
the existing integrity record. Runtime command resolution and GitHub plugin
admission remain unchanged.

## Security boundary

The checksum-verified downloads, validated archive extraction, private staging
directory, pinned lockfile sync, embedded GitHub plugin overlay, critical-path
checks, and complete tree digest remain fail closed.

The fix does not teach the digest to ignore broken or escaping links. Any
unexpected symlink elsewhere in the runtime continues to be authenticated or
rejected under the existing rules. Cleanup is limited to an installer-created
alias inside a fresh staging tree before that tree is admitted.

No provider credential, GitHub token, user content, or application database is
read or changed by the cleanup.

## Alternatives considered

### Rewrite the alias as a relative link

Rejected because June does not use the alias after installation. Preserving it
adds another authenticated link and another relocation invariant without a
runtime benefit.

### Ignore broken links during the tree digest

Rejected because it would weaken the managed-runtime security boundary and
could hide tampering or an incomplete installation.

### Hash before committing the staging directory

Rejected because the absolute alias would still become invalid after the
rename, so the recorded digest would authenticate a tree that does not match
the final runtime state.

## Verification

Test-first coverage will reproduce the installer layout with a real versioned
CPython directory and absolute `uv` alias, then prove that:

1. the verified alias is removed before relocation;
2. the real interpreter directory becomes `python/current`;
3. an unrelated or mismatched link is rejected rather than deleted;
4. the final managed-runtime tree digest succeeds and can produce the existing
   integrity record;
5. the managed runtime, GitHub plugin, Rust formatting, lint, tests, and full
   repository verification gate remain green.

Live worktree QA will restart June with the documented GitHub App public
configuration, start a sandboxed agent session, and confirm that a repository
read no longer surfaces OS error 2.

## Scope

The correction is limited to Unix managed-runtime Python alias cleanup, its
regression coverage, and QA evidence. It adds no dependency, GitHub write
operation, permission, API route, database migration, connector credential,
or frontend behavior.

No ADR is needed because this repairs staging relocation inside the existing
managed-runtime installation boundary. It introduces no new architectural or
wire-contract decision.
