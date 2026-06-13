#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONDUCTOR_REPO_WORKSPACES_DIR=""
if [[ "$ROOT_DIR" == */conductor/workspaces/*/* ]]; then
  CONDUCTOR_REPO_WORKSPACES_DIR="$(dirname "$ROOT_DIR")"
fi
FRONTEND_PORT="${VITE_PORT:-1421}"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR"

./scripts/run-scribe-api.sh &
API_PID="$!"

existing_frontend_pids="$(lsof -tiTCP:"$FRONTEND_PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$existing_frontend_pids" ]]; then
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"

    if [[ "$cwd" == "$ROOT_DIR" && "$command" == *"vite"* ]]; then
      echo "Vite is already running from this workspace on port $FRONTEND_PORT (pid $pid)." >&2
      if wait "$API_PID" 2>/dev/null; then
        while true; do
          sleep 3600
        done
      fi
      exit $?
    fi

    if [[ -n "$CONDUCTOR_REPO_WORKSPACES_DIR" && "$command" == *"vite"* && "$cwd" == "$CONDUCTOR_REPO_WORKSPACES_DIR"/* ]]; then
      echo "Stopping Vite from another workspace: $cwd (pid $pid)" >&2
      kill "$pid" 2>/dev/null || true
      continue
    fi

    echo "Port $FRONTEND_PORT is already in use by pid $pid: $command" >&2
    [[ -n "$cwd" ]] && echo "cwd: $cwd" >&2
    exit 1
  done <<<"$existing_frontend_pids"

  for _ in 1 2 3 4 5; do
    if lsof -tiTCP:"$FRONTEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      sleep 0.2
    else
      break
    fi
  done
fi

if lsof -tiTCP:"$FRONTEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $FRONTEND_PORT is still in use after stopping the previous workspace Vite server." >&2
  exit 1
fi

pnpm run dev
