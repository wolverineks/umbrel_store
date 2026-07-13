#!/usr/bin/env bash
# Create a new wolverineks Umbrel app from the maintained template.
#
# Usage:
#   scaffold.sh <slug> <port> "<App Name>" ["<tagline>"] ["<description>"]
#
# Example:
#   scaffold.sh widget 4070 "Widget Board" "Track widget status"
#
set -euo pipefail

SLUG="${1:-}"
PORT="${2:-}"
APP_NAME="${3:-}"
TAGLINE="${4:-A self-hosted Umbrel app}"
DESCRIPTION="${5:-$TAGLINE}"

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
TEMPLATE_DIR="$SKILL_DIR/template"

usage() {
  echo "Usage: scaffold.sh <slug> <port> \"<App Name>\" [\"<tagline>\"] [\"<description>\"]" >&2
  echo "  slug: lowercase-with-hyphens (becomes wolverineks-<slug>)" >&2
  exit 1
}

[[ -n "$SLUG" && -n "$PORT" && -n "$APP_NAME" ]] || usage

if [[ ! "$SLUG" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]] && [[ ! "$SLUG" =~ ^[a-z]$ ]]; then
  echo "Invalid slug: $SLUG (use lowercase letters, digits, hyphens)" >&2
  exit 1
fi

if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Invalid port: $PORT" >&2
  exit 1
fi

APP_ID="wolverineks-${SLUG}"
APP_SLUG="$SLUG"
ENV_PREFIX="$(echo "$SLUG" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
BACKUP_HOST_PATH="/home/umbrel/${SLUG}-backup"
TARGET_DIR="$REPO_ROOT/$APP_ID"

if [[ -e "$TARGET_DIR" ]]; then
  echo "Already exists: $TARGET_DIR" >&2
  exit 1
fi

if grep -R "^port: $PORT$" "$REPO_ROOT"/wolverineks-*/umbrel-app.yml 2>/dev/null | grep -q .; then
  echo "Port $PORT is already used by another app in this repo" >&2
  grep -R "^port: $PORT$" "$REPO_ROOT"/wolverineks-*/umbrel-app.yml 2>/dev/null || true
  exit 1
fi

echo "Scaffolding $APP_ID on port $PORT (env prefix ${ENV_PREFIX}_*)"

cp -R "$TEMPLATE_DIR" "$TARGET_DIR"

substitute_placeholders() {
  local file="$1"
  grep -q '__APP_ID__\|__APP_NAME__\|__APP_TAGLINE__\|__APP_DESCRIPTION__\|__APP_PORT__\|__ENV_PREFIX__\|__APP_SLUG__\|__BACKUP_HOST_PATH__' "$file" 2>/dev/null || return 0
  perl -pi -e '
    s/__APP_ID__/$ENV{APP_ID}/g;
    s/__APP_NAME__/$ENV{APP_NAME}/g;
    s/__APP_TAGLINE__/$ENV{TAGLINE}/g;
    s/__APP_DESCRIPTION__/$ENV{DESCRIPTION}/g;
    s/__APP_PORT__/$ENV{PORT}/g;
    s/__ENV_PREFIX__/$ENV{ENV_PREFIX}/g;
    s/__APP_SLUG__/$ENV{APP_SLUG}/g;
    s/__BACKUP_HOST_PATH__/$ENV{BACKUP_HOST_PATH}/g;
  ' "$file"
}

export APP_ID APP_NAME APP_SLUG TAGLINE DESCRIPTION PORT ENV_PREFIX BACKUP_HOST_PATH
while IFS= read -r -d '' file; do
  substitute_placeholders "$file"
done < <(find "$TARGET_DIR" -type f ! -path '*/node_modules/*' ! -path '*/dist/*' -print0)

echo "Installing dependencies and building..."
(cd "$TARGET_DIR/site" && npm install && npm run build)

cat <<EOF

Created: $TARGET_DIR

Next steps:
  1. Add "$APP_NAME" to README.md apps list
  2. cd $APP_ID/site && npm run dev:local
  3. Open http://localhost:$PORT
  4. Customize site/server.ts and site/store.ts
  5. Commit, push, install from Umbrel Community App Store

Dev data: $TARGET_DIR/site/.local-data/
Prod data: ~/umbrel/app-data/$APP_ID/data/ (after install)
EOF