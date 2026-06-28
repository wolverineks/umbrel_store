#!/usr/bin/env bash
#
# Copy Recipes data from an external backup directory back into the app.
#
# Usage (on Umbrel over SSH):
#   bash recipes-import.sh
#   RECIPES_BACKUP_DIR=/mnt/storage/recipes-backup bash recipes-import.sh
#   RECIPES_CONFIRM=yes bash recipes-import.sh
#
# This replaces the app's data directory with the backup (rsync --delete).
# Stop the Recipes app first if you want a perfectly quiescent restore.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=recipes-backup-lib.sh
source "$SCRIPT_DIR/recipes-backup-lib.sh"

recipes_require_rsync

APP_DATA="$(recipes_resolve_app_data_dir || true)"
BACKUP_DIR="$(recipes_resolve_backup_dir)"

if [[ -z "$APP_DATA" ]]; then
  echo "Could not find Recipes app data directory." >&2
  echo "Set RECIPES_APP_DATA to the app's data folder (the one mounted at /data in the container)." >&2
  exit 1
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "Backup directory does not exist: $BACKUP_DIR" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_DIR/index.json" && ! -d "$BACKUP_DIR/recipes" ]]; then
  echo "Backup directory does not look like a Recipes export: $BACKUP_DIR" >&2
  echo "Expected index.json and/or recipes/." >&2
  exit 1
fi

BACKUP_COUNT="$(recipes_count_recipes "$BACKUP_DIR")"

echo "Importing Recipes data"
echo "  From: $BACKUP_DIR ($BACKUP_COUNT recipe(s) in index)"
echo "  To:   $APP_DATA"
echo
echo "This will overwrite app data files that differ from the backup."

if [[ "${RECIPES_CONFIRM:-}" != "yes" ]]; then
  read -r -p "Continue? [y/N] " reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

mkdir -p "$APP_DATA"

rsync -a --delete \
  --exclude '.gitkeep' \
  "$BACKUP_DIR/" "$APP_DATA/"

recipes_fix_permissions "$APP_DATA"

COUNT="$(recipes_count_recipes "$APP_DATA")"
echo "Done. Restored library index lists $COUNT recipe(s)."
echo "Restart or refresh the Recipes app in Umbrel if it was running during import."