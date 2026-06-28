#!/usr/bin/env bash
#
# Copy Recipes app data to a directory outside the app.
#
# Usage (on Umbrel over SSH):
#   bash recipes-export.sh
#   RECIPES_BACKUP_DIR=/mnt/storage/recipes-backup bash recipes-export.sh
#
# Default backup folder matches the app UI and docker volume:
#   /home/umbrel/recipes-backup
#   RECIPES_APP_DATA=/path/to/app/data RECIPES_BACKUP_DIR=/path/to/backup bash recipes-export.sh
#
# Copies the full persistent data tree:
#   recipes/, images/, index.json, categories, trash, blocklist, settings
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=recipes-backup-lib.sh
source "$SCRIPT_DIR/recipes-backup-lib.sh"

recipes_require_rsync

APP_DATA="$(recipes_resolve_app_data_dir || true)"
BACKUP_DIR="$(recipes_resolve_backup_dir)"

if [[ -z "$APP_DATA" || ! -d "$APP_DATA" ]]; then
  echo "Could not find Recipes app data directory." >&2
  echo "Set RECIPES_APP_DATA to the app's data folder (the one mounted at /data in the container)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "Exporting Recipes data"
echo "  From: $APP_DATA"
echo "  To:   $BACKUP_DIR"

rsync -a --delete \
  --exclude '.gitkeep' \
  "$APP_DATA/" "$BACKUP_DIR/"

recipes_fix_permissions "$BACKUP_DIR"

COUNT="$(recipes_count_recipes "$BACKUP_DIR")"
echo "Done. Exported library index lists $COUNT recipe(s)."
echo "Backup contents:"
find "$BACKUP_DIR" -maxdepth 2 -mindepth 1 | sort | sed 's/^/  /'