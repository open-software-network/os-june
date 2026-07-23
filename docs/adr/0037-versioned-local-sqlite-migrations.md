# ADR 0037: Version June's local SQLite schema with a release-ordered catalog

Date: 2026-07-23
Status: accepted

## Context

June historically built its local SQLite schema by replaying almost every
migration statement at every process launch. Additive columns were repaired by
individual `PRAGMA table_info` probes, one probe per column. This made launch
cost grow with the entire schema history and kept destructive deduplication
statements on the startup path.

Existing installations have no migration ledger. They may contain the complete
schema produced by the replay runner or an older, contiguous historical schema.
Blindly assigning those databases the latest version could skip a real pending
migration. Replaying from version zero could rerun data-changing statements.

The SQL filenames cannot be used as the version authority. Parallel feature
branches produced two distinct `014_*` files, and several files were renumbered
after their schema changes had already reached main.

## Decision

June owns a `schema_migrations` table with one row per applied version. A
release-ordered catalog in `src-tauri/src/db/migrations.rs` is the authoritative
sequence. Its integer versions are contiguous and append-only; the descriptive
name records intent without treating historical filename prefixes as versions.

On a versioned database, June reads the ledger and returns immediately when it
already matches the catalog. When migrations are pending, June applies every
pending catalog entry and records its row inside one `BEGIN IMMEDIATE`
transaction. A failed statement rolls back both schema changes and version rows.

On the first versioned launch of an unversioned database, June takes one schema
snapshot of tables, indexes, and columns. Each catalog entry declares the schema
landmarks that prove it was applied. June accepts only a contiguous known
prefix, stamps that prefix, then applies later entries in the same transaction.
An empty database has prefix zero and runs the full catalog. A schema with a
gap or no known prefix fails closed instead of guessing or replaying
data-changing migrations.

Transitional additive-column steps inspect each affected table once and add all
missing columns from that snapshot. Those inspections run only while their
owning version is pending.

Existing SQL migration files remain unchanged. Future schema work appends a new
catalog version and, when SQL is used, a new migration file; old entries and
files are not reordered or edited.

## Consequences

- Normal launches perform a small ledger read and execute no historical schema
  statements.
- Fresh installs, upgrades from known historical schemas, and concurrent
  process starts share one runner and one transactional version contract.
- Legacy adoption is safe for the destructive transcript and agent-message
  deduplication migrations because existing indexes prove those versions before
  stamping.
- Schema detection is intentionally strict. An unknown or internally
  inconsistent database requires investigation rather than an automatic guess.
- The catalog's version numbers describe release order, not SQL filename
  prefixes. Reviewers must preserve the catalog as append-only even when an old
  filename appears numerically out of order.

## Rejected alternatives

- **Keep replaying idempotent SQL and optimize only the worst statements.**
  This leaves launch work proportional to total schema history and keeps every
  future migration on the permanent startup path.
- **Stamp every unversioned database as latest.** This is fast but can strand a
  genuinely older installation with missing tables or columns.
- **Start every unversioned database at zero.** This reruns destructive
  deduplication statements and violates the safety requirement for databases
  already built by the replay runner.
- **Adopt filename-driven `sqlx::migrate!` directly.** The historical duplicate
  prefixes and post-release renumbering do not provide a trustworthy linear
  version sequence without rewriting append-only migration history.
