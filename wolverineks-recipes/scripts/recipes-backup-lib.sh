#!/usr/bin/env bash
# Shared helpers for Recipes app data export/import scripts.

recipes_resolve_app_data_dir() {
  if [[ -n "${RECIPES_APP_DATA:-}" ]]; then
    printf '%s\n' "$RECIPES_APP_DATA"
    return 0
  fi

  local candidates=(
    "/home/umbrel/umbrel/app-data/wolverineks-recipes/data"
    "$HOME/umbrel/app-data/wolverineks-recipes/data"
    "$HOME/umbrel/app-data/community-app-store/wolverineks-recipes/data"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

recipes_resolve_backup_dir() {
  if [[ -n "${RECIPES_BACKUP_DIR:-}" ]]; then
    printf '%s\n' "$RECIPES_BACKUP_DIR"
    return 0
  fi

  local candidates=(
    "/home/umbrel/recipes-backup"
    "$HOME/recipes-backup"
    "/home/umbrel/umbrel/app-data/wolverineks-recipes/backup"
    "$HOME/umbrel/app-data/wolverineks-recipes/backup"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '%s\n' "/home/umbrel/recipes-backup"
}

recipes_fix_permissions() {
  local target="$1"
  if [[ "$(id -u)" -eq 0 ]] && id -u umbrel &>/dev/null; then
    chown -R umbrel:umbrel "$target"
  fi
}

recipes_count_recipes() {
  local data_dir="$1"
  local index_file="$data_dir/index.json"
  if [[ ! -f "$index_file" ]]; then
    printf '0\n'
    return 0
  fi
  if command -v python3 &>/dev/null; then
    python3 - "$index_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
print(len(data) if isinstance(data, list) else 0)
PY
    return 0
  fi
  grep -c '"id"' "$index_file" 2>/dev/null || printf '0\n'
}

recipes_require_rsync() {
  if ! command -v rsync &>/dev/null; then
    echo "rsync is required but was not found in PATH." >&2
    exit 1
  fi
}