# Local command layer mirroring CI (see .github/workflows/). `make verify`
# runs the same gates as the desktop + june-api workflows, so a green
# `make verify` locally should mean green CI. Use `make dev` to run june-api
# and the desktop app together locally; production builds use `pnpm tauri:build`.
.PHONY: help install \
	dev dev-api \
	check format typecheck test-web \
	tauri-fmt tauri-fmt-check tauri-lint tauri-test \
	june-api-fmt june-api-fmt-check june-api-lint june-api-test \
	fmt fmt-check lint test verify \
	skills-update skills-restore skills-sync

.DEFAULT_GOAL := help

help:  ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Install ---
install:  ## Install frontend deps (Rust builds via cargo)
	pnpm install --frozen-lockfile

# --- Run (local dev) ---
# `pnpm tauri:dev` (via scripts/tauri-before-dev.mjs) already boots june-api on
# :8080 and Vite alongside the native app, and tears them all down on exit. The
# desktop app reads JUNE_API_URL from .env and june-api reads its keys from
# june-api/.env (both auto-load their .env), so this is the whole local stack in
# one command.
dev:  ## Run the desktop app + june-api together (Ctrl-C stops both)
	pnpm tauri:dev

dev-api:  ## Run only june-api locally on :8080 (loads june-api/.env)
	cd june-api && cargo run

# --- Frontend (src/, scripts/) ---
check:  ## Biome check (format + lint, incl. the lucide ban)
	pnpm check

format:  ## Biome format (write) + biome safe fixes
	pnpm check:write

typecheck:  ## tsc --noEmit
	pnpm typecheck

test-web:  ## Vitest
	pnpm test

# --- Tauri shell (src-tauri/) ---
tauri-fmt:  ## rustfmt (write)
	cargo fmt --manifest-path src-tauri/Cargo.toml --all

tauri-fmt-check:  ## rustfmt (check only)
	cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check

tauri-lint:  ## clippy (warnings = errors)
	cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

tauri-test:  ## cargo test
	cargo test --manifest-path src-tauri/Cargo.toml

# --- June API backend (june-api/) ---
june-api-fmt:  ## rustfmt (write)
	cd june-api && cargo fmt --all

june-api-fmt-check:  ## rustfmt (check only)
	cd june-api && cargo fmt --all -- --check

june-api-lint:  ## clippy (warnings = errors)
	cd june-api && cargo clippy --all-targets --all-features --locked -- -D warnings

june-api-test:  ## cargo test
	cd june-api && cargo test --all-targets --all-features --locked

# --- Skills (.agents/skills is the source of truth; .claude/skills are symlinks) ---
skills-update:  ## Update project skills to latest (npx skills)
	npx -y skills update --project --yes

skills-restore:  ## Restore skills from the lockfile (npx skills)
	npx -y skills experimental_install

skills-sync:  ## Re-link skills into .claude/skills (npx skills)
	npx -y skills experimental_sync --yes

# --- Aggregates ---
fmt: format tauri-fmt june-api-fmt  ## Format everything (biome + both cargo fmt)

fmt-check: tauri-fmt-check june-api-fmt-check  ## Check rust formatting (biome format is covered by `check`)

lint: check tauri-lint june-api-lint  ## Lint everything (biome + both clippy)

test: test-web tauri-test june-api-test  ## Run all test suites

verify: check typecheck test-web tauri-fmt-check tauri-lint tauri-test june-api-fmt-check june-api-lint june-api-test  ## Full CI-parity gate
