# Local command layer mirroring CI (see .github/workflows/). `make verify`
# runs the same gates as the desktop + june-api workflows, so a green
# `make verify` locally should mean green CI. Use `make dev` to run june-api
# and the desktop app together locally; production builds use `pnpm tauri:build`.
.PHONY: help install \
	dev dev-staging dev-api \
	ephemeral-api ephemeral-api-down dev-with-ephemeral-api \
	check format typecheck test-web \
	tauri-fmt tauri-fmt-check tauri-lint tauri-test \
	june-api-fmt june-api-fmt-check june-api-lint june-api-test \
	fmt fmt-check lint test verify \
	local-ci signoff-pr signoff-frontend signoff-rust-macos \
	skills-update skills-restore skills-sync sfw-check

.DEFAULT_GOAL := help

help:  ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Install ---
install:  ## Install frontend deps (Rust builds via cargo)
	pnpm install --frozen-lockfile

# --- Run (local dev) ---
# `pnpm tauri:dev` selects free worktree-local ports, boots june-api and Vite
# alongside the native app, and tears them all down on exit. The
# desktop app reads JUNE_API_URL from .env and june-api reads its keys from
# june-api/.env (both auto-load their .env), so this is the whole local stack in
# one command.
dev:  ## Run the desktop app + june-api together (Ctrl-C stops both)
	pnpm tauri:dev

# Uses real staging OS Accounts login; the local-dev bearer does not work against staging.
dev-staging:  ## Run the desktop app against staging June API (real OS Accounts login)
	JUNE_API_URL=https://june-api-staging.opensoftware.co \
		OS_JUNE_LOCAL_DEV=0 \
		OS_ACCOUNTS_URL=https://os-accounts-portal-staging.up.railway.app \
		OS_ACCOUNTS_API_URL=https://os-accounts-api-staging.up.railway.app \
		JUNE_DEV_SKIP_LOCAL_API=1 \
		pnpm tauri:dev

dev-api:  ## Run only june-api locally on :8080 (loads june-api/.env)
	cd june-api && cargo run

# Ephemeral Phala CVM: the working-tree june-api inside a real TEE, on demand.
# Cost model: tdx.small bills $0.058/hr from creation until you delete it, and
# the ttl.sh image tag expires after 4h (the CVM keeps running, but a restart
# past expiry cannot re-pull the image). `dev-with-ephemeral-api` always deletes
# the CVM on exit; the other two leave it up, so remember `ephemeral-api-down`.
ephemeral-api:  ## Deploy the working-tree june-api to a disposable Phala CVM
	./scripts/ephemeral-june-api.sh up

ephemeral-api-down:  ## Delete the ephemeral CVM
	./scripts/ephemeral-june-api.sh down

dev-with-ephemeral-api:  ## Run the app against a fresh ephemeral CVM; deletes it on exit
	./scripts/ephemeral-june-api.sh dev

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
	cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings

tauri-test:  ## cargo test
	cargo test --manifest-path src-tauri/Cargo.toml --locked

.PHONY: benchmark-note-transcription-latency
benchmark-note-transcription-latency:
	cargo test --manifest-path src-tauri/Cargo.toml --locked --release commands::note_transcription_benchmark::benchmark_post_finalization_note_transcription_latency -- --ignored --exact --nocapture --test-threads=1

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
# The runner executes registry code, so it is version-pinned and wrapped in
# Socket Firewall per spec/package-install-security.md.
SKILLS_CLI := skills@1.5.15

sfw-check:
	@command -v sfw >/dev/null 2>&1 || { echo "Socket Firewall (sfw) is required: npm i -g sfw (see spec/package-install-security.md)" >&2; exit 1; }

skills-update: sfw-check  ## Update project skills to latest (sfw npx skills)
	sfw npx -y $(SKILLS_CLI) update --project --yes

skills-restore: sfw-check  ## Restore skills from the lockfile (sfw npx skills)
	sfw npx -y $(SKILLS_CLI) experimental_install

skills-sync: sfw-check  ## Re-link skills into .claude/skills (sfw npx skills)
	sfw npx -y $(SKILLS_CLI) experimental_sync --yes

# --- Aggregates ---
fmt: format tauri-fmt june-api-fmt  ## Format everything (biome + both cargo fmt)

fmt-check: tauri-fmt-check june-api-fmt-check  ## Check rust formatting (biome format is covered by `check`)

lint: check tauri-lint june-api-lint  ## Lint everything (biome + both clippy)

test: test-web tauri-test june-api-test  ## Run all test suites

verify: check typecheck test-web tauri-fmt-check tauri-lint tauri-test june-api-fmt-check june-api-lint june-api-test  ## Full CI-parity gate

local-ci:  ## Run path-aware local PR checks and post required signoff/* statuses
	./scripts/local-ci.sh

signoff-pr: local-ci

signoff-frontend:  ## Run local frontend typecheck/tests and post signoff/frontend
	./scripts/signoff-frontend.sh

signoff-rust-macos:  ## Run local macOS Tauri Rust checks and post signoff/rust-macos
	./scripts/signoff-rust-macos.sh
