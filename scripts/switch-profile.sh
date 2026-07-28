#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES_DIR="$ROOT_DIR/profiles"
BASE_FILE="$ROOT_DIR/.env.production.base"
TARGET_FILE="$ROOT_DIR/.env"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/switch-profile.sh --list
  ./scripts/switch-profile.sh <profile-name>

Examples:
  ./scripts/switch-profile.sh aggressive-lite-v2-inventory-aware
  ./scripts/switch-profile.sh safe-idle

Notes:
- Keep your real keys/secrets in .env.production.base
- Profile files live in profiles/<name>.env and contain only overrides
- This script creates a timestamped backup of .env before replacing it
EOF
}

list_profiles() {
  if compgen -G "$PROFILES_DIR/*.env" > /dev/null; then
    echo "Available profiles:"
    for f in "$PROFILES_DIR"/*.env; do
      basename "$f" .env
    done
  else
    echo "No profiles found in $PROFILES_DIR"
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--list" ]]; then
  list_profiles
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

PROFILE_NAME="$1"
PROFILE_FILE="$PROFILES_DIR/$PROFILE_NAME.env"

if [[ ! -f "$BASE_FILE" ]]; then
  echo "Missing $BASE_FILE"
  echo "Create it once from your current production env:"
  echo "  cp .env .env.production.base"
  exit 1
fi

if [[ ! -f "$PROFILE_FILE" ]]; then
  echo "Profile not found: $PROFILE_FILE"
  echo
  list_profiles
  exit 1
fi

if [[ -f "$TARGET_FILE" ]]; then
  BACKUP_FILE="$ROOT_DIR/.env.backup.$(date +%F-%H%M%S)"
  cp "$TARGET_FILE" "$BACKUP_FILE"
  echo "Backed up current .env to: $(basename "$BACKUP_FILE")"
fi

TMP_FILE="$(mktemp)"

# Merge strategy:
# 1) Start from .env.production.base (with real secrets)
# 2) Override keys present in profile file
# 3) Append new override keys not present in base
awk -F= '
  NR==FNR {
    if ($0 ~ /^[[:space:]]*#/ || $0 ~ /^[[:space:]]*$/) next
    key=$1
    sub(/^[^=]*=/, "", $0)
    val=$0
    overrides[key]=val
    order[++count]=key
    next
  }
  {
    if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
      key=$1
      if (key in overrides) {
        print key "=" overrides[key]
        used[key]=1
        next
      }
    }
    print $0
  }
  END {
    for (i=1; i<=count; i++) {
      key=order[i]
      if (!(key in used)) {
        print key "=" overrides[key]
      }
    }
  }
' "$PROFILE_FILE" "$BASE_FILE" > "$TMP_FILE"

mv "$TMP_FILE" "$TARGET_FILE"

echo "Applied profile: $PROFILE_NAME"
echo "Updated .env from .env.production.base + profiles/$PROFILE_NAME.env"
echo "Restart command: pm2 restart epwx-bot --update-env"
