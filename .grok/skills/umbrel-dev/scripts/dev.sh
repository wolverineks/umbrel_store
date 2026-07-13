#!/usr/bin/env bash
# Start local dev server for a wolverineks Umbrel app.
# Usage: dev.sh wolverineks-nbu-dashboard
set -euo pipefail

APP="${1:-}"
REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"

if [[ -z "$APP" ]]; then
  echo "Usage: dev.sh <app-folder>" >&2
  echo "Example: dev.sh wolverineks-nbu-dashboard" >&2
  exit 1
fi

APP_DIR="$REPO_ROOT/$APP"
SITE_DIR="$APP_DIR/site"

if [[ ! -d "$SITE_DIR" ]]; then
  echo "No site/ in $APP_DIR" >&2
  exit 1
fi

if [[ -f "$APP_DIR/docker-compose.dev.yml" ]] && [[ "${USE_DOCKER_DEV:-}" == "1" ]]; then
  echo "Starting Docker dev for $APP..."
  exec docker compose -f "$APP_DIR/docker-compose.dev.yml" up
fi

if [[ ! -f "$SITE_DIR/package.json" ]]; then
  echo "No package.json in $SITE_DIR — start manually (e.g. python server.py)" >&2
  exit 1
fi

cd "$SITE_DIR"
npm install

if npm run | grep -q 'dev:local'; then
  echo "Starting npm run dev:local in $SITE_DIR"
  exec npm run dev:local
fi

if npm run | grep -q ' dev$'; then
  echo "Starting npm run dev in $SITE_DIR"
  exec npm run dev
fi

echo "No dev:local or dev script in package.json" >&2
exit 1