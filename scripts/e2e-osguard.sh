#!/usr/bin/env bash
# End-to-end check of the scribe-api <-> OS-Guard integration.
#
# Starts scribe-api in local-dev mode pointed at a running OS-Guard gateway and
# runs the exhaustive HTTP matrix in scripts/e2e_osguard_matrix.py over every
# agent-facing path: chat (note generation, dictation cleanup, agent chat —
# streaming and non-streaming), tool-guard call/result analysis, prompt
# injection, and auth/validation error paths. Assertions are provider-agnostic,
# so the same run works whether the gateway uses provider=mock or provider=venice.
#
# Requires a reachable OS-Guard gateway. The chat checks need the gateway backed
# by a provider that returns token usage (mock now does; venice does). Example
# local gateway:
#   OSG_WORKER_BACKEND=mock OSG_PROVIDER=venice OSG_VENICE_API_KEY=... \
#   OSG_GATEWAY_AUTH_TOKEN=tok OSG_BIND_ADDR=127.0.0.1:8088 os-guard-gateway
#
# Usage:
#   OSGUARD_BASE_URL=http://127.0.0.1:8088/v1 OSGUARD_TOKEN=tok scripts/e2e-osguard.sh
set -uo pipefail

OSGUARD_BASE_URL="${OSGUARD_BASE_URL:?set OSGUARD_BASE_URL (e.g. http://127.0.0.1:8088/v1)}"
OSGUARD_TOKEN="${OSGUARD_TOKEN:?set OSGUARD_TOKEN (the gateway bearer token)}"
SCRIBE_PORT="${SCRIBE_PORT:-8099}"
CHAT_MODEL="${CHAT_MODEL:-zai-org-glm-5}"
PROVIDER="${PROVIDER:-?}"
TOKEN="local-dev-token"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
API_DIR="$ROOT_DIR/scribe-api"
BASE="http://127.0.0.1:${SCRIBE_PORT}"

echo "Building scribe-api..."
(cd "$API_DIR" && cargo build -p scribe --quiet) || { echo "build failed"; exit 1; }

echo "Starting scribe-api on :${SCRIBE_PORT} (local-dev) -> OS-Guard ${OSGUARD_BASE_URL}"
SCRIBE__SERVER__HOST=127.0.0.1 SCRIBE__SERVER__PORT="$SCRIBE_PORT" \
SCRIBE__LOCAL_DEV__ENABLED=true SCRIBE__LOCAL_DEV__BEARER_TOKEN="$TOKEN" SCRIBE__LOCAL_DEV__USER_ID=usr_local_dev \
SCRIBE__UPSTREAMS__OSGUARD__BASE_URL="$OSGUARD_BASE_URL" SCRIBE__UPSTREAMS__OSGUARD__API_KEY="$OSGUARD_TOKEN" \
SCRIBE__UPSTREAMS__VENICE__API_KEY="${SCRIBE_VENICE_API_KEY:-local-e2e-unused}" \
SCRIBE__UPSTREAMS__VENICE__BASE_URL="${SCRIBE_VENICE_BASE_URL:-http://127.0.0.1:9/v1}" \
  "$API_DIR/target/debug/scribe" serve >/tmp/scribe-e2e-osguard.log 2>&1 &
scribe_pid=$!
trap 'kill "$scribe_pid" 2>/dev/null' EXIT

for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1 || { echo "scribe did not become healthy"; tail -20 /tmp/scribe-e2e-osguard.log; exit 1; }

SCRIBE_URL="$BASE" SCRIBE_TOKEN="$TOKEN" CHAT_MODEL="$CHAT_MODEL" PROVIDER="$PROVIDER" \
  python3 "$ROOT_DIR/scripts/e2e_osguard_matrix.py"
