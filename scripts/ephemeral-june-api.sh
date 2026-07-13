#!/usr/bin/env bash
# Deploy the working-tree june-api to a disposable Phala CVM, use it, delete it.
#
#   up    build+push the image to ttl.sh, deploy a CVM, health-check it
#   down  delete the CVM recorded in the state file
#   dev   up, run `pnpm tauri:dev` against it, always down on exit
#
# The CVM bills at $0.058/hr (tdx.small) until deleted. Deps: bash, git, docker,
# phala, jq, curl, openssl, perl, uuidgen.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

COMPOSE_FILE="june-api/deploy/docker-compose.ephemeral.yml"
API_ENV_FILE="june-api/.env"
STATE_FILE=".ephemeral-june-api.json"
LOCAL_DEV_USER_ID="usr_local_dev"

TMP_FILES=()
DEV_MODE=0
TEARDOWN_CVM=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local f
  for f in "${TMP_FILES[@]:-}"; do
    if [[ -n "$f" ]]; then rm -f "$f"; fi
  done
  # `dev` only: no ephemeral CVM outlives the dev session, whether it ended by
  # a clean quit, Ctrl-C, or a failure after the CVM came up.
  if [[ "$TEARDOWN_CVM" == "1" ]]; then
    cmd_down || echo "Teardown failed. Delete it by hand: phala cvms delete <name> --force" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  echo "$*" >&2
  exit 1
}

# The state file is the only record of the CVM name and its bearer token.
write_state() {
  local name="$1" url="$2" token="$3" image="$4" git_sha="$5" created="$6"
  : >"$STATE_FILE"
  chmod 600 "$STATE_FILE"
  jq -n \
    --arg name "$name" \
    --arg url "$url" \
    --arg token "$token" \
    --arg image "$image" \
    --arg git_sha "$git_sha" \
    --arg created "$created" \
    '{name: $name, url: $url, token: $token, image: $image, git_sha: $git_sha, created: $created}' \
    >"$STATE_FILE"
}

read_state() {
  jq -r --arg key "$1" '.[$key] // empty' "$STATE_FILE"
}

# Copy a key from june-api/.env verbatim. A missing or empty key is copied as
# absent: june-api must see it as unset, never as a value we invented.
copy_env_line() {
  local key="$1" line
  line="$(grep -E "^${key}=." "$API_ENV_FILE" | tail -n 1 || true)"
  if [[ -n "$line" ]]; then printf '%s\n' "$line"; fi
}

cmd_up() {
  command -v docker >/dev/null 2>&1 || die "docker is required. Install Docker Desktop."
  docker info >/dev/null 2>&1 || die "The Docker daemon is unreachable. Start Docker Desktop and retry."
  command -v phala >/dev/null 2>&1 || die "The phala CLI is required. Install it with: npm install -g phala"
  phala status >/dev/null 2>&1 || die "The phala CLI is not authenticated. Run: phala auth login"
  [[ -f "$API_ENV_FILE" ]] || die "$API_ENV_FILE is missing. Copy june-api/.env.example and fill in the upstream keys."
  # Atomic reservation (noclobber): two concurrent `up`s must not both pass a
  # plain -f guard during the long image build and then overwrite each other's
  # only CVM record. Whoever creates the file owns the run.
  if ! (set -C; : >"$STATE_FILE") 2>/dev/null; then
    die "An ephemeral CVM is already recorded in $STATE_FILE. Run \`make ephemeral-api-down\` first."
  fi
  chmod 600 "$STATE_FILE"

  local git_sha image name token created
  git_sha="$(git rev-parse HEAD)"
  image="ttl.sh/june-api-eph-$(uuidgen | perl -ne 'print lc'):4h"
  name="june-api-eph-$(whoami | perl -pe 'chomp; $_ = lc; s/[^a-z0-9]+/-/g')-$(openssl rand -hex 2)"
  token="$(openssl rand -hex 32)"
  created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  echo "Building june-api for linux/amd64 and pushing to $image ..."
  # --provenance/--sbom off: attestations turn the pushed artifact into an OCI
  # index, and dstack's prelaunch puller is only proven against plain
  # single-arch manifests. Same rationale as .github/workflows/build-june-api.yml.
  docker buildx build \
    --platform linux/amd64 \
    --build-arg "GIT_SHA=${git_sha}" \
    --provenance=false \
    --sbom=false \
    -t "$image" \
    --push \
    june-api

  local rendered env_file
  rendered="$(mktemp)"
  env_file="$(mktemp)"
  TMP_FILES+=("$rendered" "$env_file")
  chmod 600 "$env_file"

  IMAGE_REF="$image" perl -0pe 's/\$\{JUNE_IMAGE\}/$ENV{IMAGE_REF}/g' "$COMPOSE_FILE" >"$rendered"

  {
    printf 'JUNE__LOCAL_DEV__ENABLED=true\n'
    printf 'JUNE__LOCAL_DEV__BEARER_TOKEN=%s\n' "$token"
    printf 'JUNE__LOCAL_DEV__USER_ID=%s\n' "$LOCAL_DEV_USER_ID"
    copy_env_line JUNE__UPSTREAMS__VENICE__API_KEY
    copy_env_line JUNE__UPSTREAMS__OPENAI__API_KEY
  } >"$env_file"

  # Record the CVM before the deploy, not after: the state file is what makes
  # `down` able to delete it, and a deploy that dies halfway can still have left
  # a billing CVM behind. Arm the `dev` teardown on the same line of reasoning,
  # and only here, so an early guard failure never deletes a pre-existing CVM.
  write_state "$name" "" "$token" "$image" "$git_sha" "$created"
  if [[ "$DEV_MODE" == "1" ]]; then
    TEARDOWN_CVM=1
  fi

  echo "Deploying CVM $name ..."
  # Dev VM: logs and sysinfo stay private, unlike the production defaults.
  phala deploy \
    -c "$rendered" \
    -n "$name" \
    -t tdx.small \
    --disk-size 20G \
    --no-public-logs \
    --no-public-sysinfo \
    -e "$env_file" \
    --wait

  # `phala cvms get --json` spreads its detail fields to the top level, but the
  # public-endpoint field is API-version dependent: `public_urls` (v2025-10-28)
  # or `endpoints` (default), both arrays of {app, instance}. Walk every nested
  # object and take the first .app URL so either shape works.
  local url
  url="$(phala cvms get "$name" --json \
    | jq -r 'first((.. | objects | .app? | select(type == "string" and startswith("http")))) // empty')" || url=""
  [[ -n "$url" ]] || die "Could not resolve a public URL for $name. Inspect it with: phala cvms get $name"
  write_state "$name" "$url" "$token" "$image" "$git_sha" "$created"

  echo "Waiting for $url/healthz ..."
  local code=""
  for _ in $(seq 1 60); do
    # `|| true`, not `|| echo`: curl prints its own %{http_code} (000) on
    # transport failure, so a fallback echo would corrupt the value.
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/healthz" || true)"
    [[ "$code" == "200" ]] && break
    sleep 10
  done
  if [[ "$code" != "200" ]]; then
    echo "$url/healthz did not return 200 within 10 minutes (last: $code)." >&2
    echo "The CVM $name is still up and still billing. Inspect it with:" >&2
    echo "  phala cvms get $name" >&2
    echo "Delete it with: make ephemeral-api-down" >&2
    exit 1
  fi

  cat <<EOF

Ephemeral June API is up.
  CVM:   $name
  URL:   $url
  Image: $image (ttl.sh tag expires in 4h; a restart after that cannot re-pull)

It bills at \$0.058/hr (tdx.small) until deleted.

Run the app against a FRESH ephemeral CVM (its own flow, this one is not reused):
  make dev-with-ephemeral-api

Or use this one from a manual session (token is in $STATE_FILE, mode 600):
  export JUNE_API_URL=$url
  export OS_JUNE_LOCAL_DEV=1
  export OS_JUNE_LOCAL_DEV_BEARER_TOKEN="\$(jq -r .token $STATE_FILE)"

Tear it down with:
  make ephemeral-api-down
EOF
}

cmd_down() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No $STATE_FILE; nothing to tear down."
    return 0
  fi

  local name
  name="$(read_state name)"
  if [[ -z "$name" ]]; then
    # A reservation that never reached the deploy: nothing exists to delete.
    rm -f "$STATE_FILE"
    echo "Dropped an empty reservation; no CVM was created."
    return 0
  fi

  echo "Deleting CVM $name ..."
  if ! phala cvms delete "$name" --force; then
    # A failed delete may mean already-gone OR a transient auth/network/API
    # failure. The state file is the only record of a billing CVM's name, so
    # drop it only once the CVM is confirmed absent.
    if phala cvms get "$name" --json 2>/dev/null \
      | jq -e --arg n "$name" '.name == $n' >/dev/null 2>&1; then
      echo "Could not delete $name and it still exists; keeping $STATE_FILE." >&2
      echo "Retry with: make ephemeral-api-down" >&2
      return 1
    fi
    echo "Delete reported failure but $name is no longer listed; dropping the state file." >&2
  fi
  rm -f "$STATE_FILE"
  echo "Ephemeral June API torn down."
}

cmd_dev() {
  # cmd_up arms the teardown once it is about to create the CVM, so every exit
  # path from there on (clean quit, Ctrl-C, failure) deletes it, while its
  # already-up guard still aborts without touching the recorded CVM.
  DEV_MODE=1
  cmd_up

  local url token
  url="$(read_state url)"
  token="$(read_state token)"

  echo "Starting the desktop app against $url ..."
  JUNE_API_URL="$url" \
    OS_JUNE_LOCAL_DEV=1 \
    OS_JUNE_LOCAL_DEV_BEARER_TOKEN="$token" \
    OS_JUNE_LOCAL_DEV_USER_ID="$LOCAL_DEV_USER_ID" \
    JUNE_DEV_SKIP_LOCAL_API=1 \
    pnpm tauri:dev
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  dev) cmd_dev ;;
  *) die "Usage: $0 {up|down|dev}" ;;
esac
