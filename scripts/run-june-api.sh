#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
API_DIR="$ROOT_DIR/june-api"
PORT="${JUNE_API_PORT:-8080}"

if [[ ! -f "$API_DIR/Cargo.toml" ]]; then
  echo "Could not find june-api/Cargo.toml under $ROOT_DIR" >&2
  exit 1
fi

existing_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$existing_pids" ]]; then
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"

    if [[ "$cwd" == "$API_DIR" ]]; then
      echo "june-api is already running from this workspace on port $PORT (pid $pid)." >&2
      exit 0
    fi

    if [[ "$command" == *"target/debug/june"* && "$cwd" == */conductor/workspaces/os-june/*/june-api ]]; then
      echo "Stopping june-api from another workspace: $cwd (pid $pid)" >&2
      kill "$pid" 2>/dev/null || true
      continue
    fi

    echo "Port $PORT is already in use by pid $pid: $command" >&2
    [[ -n "$cwd" ]] && echo "cwd: $cwd" >&2
    echo "Stop that process or set JUNE_API_PORT to a different port." >&2
    exit 1
  done <<<"$existing_pids"

  for _ in 1 2 3 4 5; do
    if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      sleep 0.2
    else
      break
    fi
  done
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is still in use after stopping the previous workspace API." >&2
  exit 1
fi

cd "$API_DIR"
exec cargo run -p june -- serve
