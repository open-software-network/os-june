#!/usr/bin/env bash
set -euo pipefail

SKILL_NAME="os-platform"
DEFAULT_DEST="${CODEX_HOME:-$HOME/.codex}/skills"
DEFAULT_REPO="open-software-network/skills"
DEFAULT_REF="main"
DEFAULT_PATH="skills/os-platform"

DEST="$DEFAULT_DEST"
SOURCE=""
REPO="$DEFAULT_REPO"
REF="$DEFAULT_REF"
SKILL_PATH="$DEFAULT_PATH"
FORCE=0
DOWNLOAD_TMP=""

cleanup() {
  if [[ -n "$DOWNLOAD_TMP" && -d "$DOWNLOAD_TMP" ]]; then
    rm -rf "$DOWNLOAD_TMP"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Install the os-platform Agent Skill.

Usage:
  install.sh [options]

Options:
  --dest DIR       Destination skills directory. Default: ${CODEX_HOME:-$HOME/.codex}/skills
  --source DIR     Local os-platform skill directory to install from.
  --repo ORG/REPO  GitHub repo for download mode. Default: open-software-network/skills
  --ref REF        Git ref for download mode. Default: main
  --path PATH      Skill path inside repo. Default: skills/os-platform
  --force          Replace an existing destination skill.
  -h, --help       Show this help.

Examples:
  bash scripts/install.sh --source ./skills/os-platform --dest /tmp/skills --force
  curl -fsSL https://raw.githubusercontent.com/open-software-network/skills/main/skills/os-platform/scripts/install.sh | bash
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST="${2:?--dest requires a directory}"
      shift 2
      ;;
    --source)
      SOURCE="${2:?--source requires a directory}"
      shift 2
      ;;
    --repo)
      REPO="${2:?--repo requires ORG/REPO}"
      shift 2
      ;;
    --ref|--version)
      REF="${2:?--ref requires a git ref}"
      shift 2
      ;;
    --path)
      SKILL_PATH="${2:?--path requires a repo-relative path}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "install.sh: required command not found: $1" >&2
    exit 2
  fi
}

script_dir_source() {
  local script_path="${BASH_SOURCE[0]:-}"
  [[ -n "$script_path" && -f "$script_path" ]] || return 1
  local script_dir
  script_dir="$(cd "$(dirname "$script_path")" && pwd)"
  local candidate
  candidate="$(cd "$script_dir/.." && pwd)"
  [[ -f "$candidate/SKILL.md" ]] || return 1
  SOURCE="$candidate"
}

download_source() {
  need_cmd curl
  need_cmd tar

  local repo_name archive_url extract_root
  DOWNLOAD_TMP="$(mktemp -d)"
  repo_name="${REPO#*/}"
  archive_url="https://github.com/${REPO}/archive/${REF}.tar.gz"

  curl -fsSL "$archive_url" | tar -xz -C "$DOWNLOAD_TMP"
  extract_root="$(find "$DOWNLOAD_TMP" -maxdepth 1 -type d -name "${repo_name}-*" | head -n 1)"
  if [[ -z "$extract_root" || ! -d "$extract_root/$SKILL_PATH" ]]; then
    echo "install.sh: could not find $SKILL_PATH in $REPO@$REF" >&2
    exit 1
  fi
  SOURCE="$extract_root/$SKILL_PATH"
}

if [[ -z "$SOURCE" ]]; then
  if script_dir_source; then
    :
  else
    download_source
  fi
fi

if [[ ! -f "$SOURCE/SKILL.md" ]]; then
  echo "install.sh: source is not a skill directory: $SOURCE" >&2
  exit 1
fi

if ! grep -Eq '^name:[[:space:]]*os-platform[[:space:]]*$' "$SOURCE/SKILL.md"; then
  echo "install.sh: source SKILL.md does not declare name: os-platform" >&2
  exit 1
fi

mkdir -p "$DEST"
TARGET="$DEST/$SKILL_NAME"

if [[ -e "$TARGET" && "$FORCE" -ne 1 ]]; then
  echo "install.sh: $TARGET already exists; pass --force to replace it" >&2
  exit 1
fi

if [[ -e "$TARGET" ]]; then
  rm -rf "$TARGET"
fi

mkdir -p "$TARGET"
cp -R "$SOURCE"/. "$TARGET"/

cat <<EOF
Installed $SKILL_NAME skill to:
  $TARGET

This installer does not prompt for or store production credentials.
The default API base URL is https://app.opensoftware.co/api.
Set production access in the agent runtime or shell before using the skill:
  export OS_PLATFORM_API_KEY="..."
Optionally override the API base URL:
  export OS_PLATFORM_API_BASE_URL="https://..."
EOF
