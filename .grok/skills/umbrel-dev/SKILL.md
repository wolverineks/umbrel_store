---
name: umbrel-dev
description: >
  Develop, debug, and ship Umbrel community apps in the wolverineks umbrel_store
  repo. Use when building or iterating on Umbrel apps, scaffolding new apps from
  the maintained template, running local dev servers, debugging on Umbrel via SSH,
  bumping app versions, or when the user mentions umbrel dev workflow, scaffold.sh,
  docker-compose.dev, .local-data, APP_DATA_DIR, umbrel-app.yml, or /umbrel-dev.
---

# Umbrel app development (wolverineks)

Fast loop: **edit locally → `npm run build` → test on localhost → push → update app on Umbrel**.

## Repo layout (every app)

```
wolverineks-<app-id>/
  umbrel-app.yml          # manifest: id, version, port, releaseNotes
  docker-compose.yml      # Umbrel production (app_proxy + server)
  docker-compose.dev.yml  # optional: local dev with bind-mount
  site/                   # app code served as /app in container
    server.ts|js|py
    package.json          # Node apps: build, dev:local, start
    .local-data/          # LOCAL dev data only (gitignored)
  data/                   # placeholder for repo; real data lives on Umbrel
```

Production on device:

```
~/umbrel/app-data/wolverineks-<app-id>/
  site/    # deployed code (read-only mount → /app)
  data/    # persistent state (→ /data in container)
```

## App index

See [references/apps.md](references/apps.md) for ports, data env vars, and dev commands.

## Default workflow

### 1. Start local dev (prefer native over Docker)

```bash
cd wolverineks-<app>/site
npm install
npm run dev:local    # or npm run dev (roomba)
```

Or from app root:

```bash
./.grok/skills/umbrel-dev/scripts/dev.sh <app-folder-name>
```

Open `http://localhost:<port>` (port from `umbrel-app.yml`).

**Data:** dev uses `site/.local-data/`, never Umbrel production data.

### 2. Build before commit / deploy

Node/TypeScript apps compile TS → committed `server.js`:

```bash
cd site && npm run build
```

Verify `server.js` (and sibling `*.js` copies) changed. Umbrel runs `node server.js`, not `tsx`.

### 3. Version bump checklist

Update **all** of these together:

1. `umbrel-app.yml` → `version` + `releaseNotes`
2. `site/package.json` → `version` (if present)
3. Rebuild: `npm run build`

### 4. Deploy to Umbrel

1. Commit and push `umbrel_store` to GitHub.
2. On Umbrel: Community App Store → update app, or reinstall.
3. Umbrel copies `site/` into `~/umbrel/app-data/wolverineks-<id>/site/`.
4. Restart the app from Umbrel UI if it does not pick up changes.

**Do not** commit `site/.local-data/`, `__pycache__`, or `node_modules/`.

### 5. Debug on Umbrel (SSH)

```bash
ssh umbrel@umbrel.local   # or umbrel@<ip>
```

Useful paths:

```bash
APP=wolverineks-nbu-dashboard   # example
ls ~/umbrel/app-data/$APP/data/
ls ~/umbrel/app-data/$APP/site/
docker ps | grep $APP
docker logs <container> --tail 100
```

Slow API on Pi: check reading/file sizes, point counts in responses, and `[nbu] slow` log lines if present.

See [references/production.md](references/production.md) for data files, backups, and clear-data flows.

## Conventions (Node apps)

| Concern | Pattern |
|--------|---------|
| Data root | `process.env.<APP>_DATA_DIR ?? "/data"` |
| Dev flag | `<APP>_DEV=1` → show dev hints in UI |
| Local data | `<APP>_DATA_DIR=./.local-data` in `dev:local` |
| Container port | `PORT=3000` in production; dev uses manifest port |
| app_proxy | `APP_HOST: wolverineks-<id>_server_1`, `APP_PORT: 3000` |
| site mount | `${APP_DATA_DIR}/site:/app:ro` |
| data mount | `${APP_DATA_DIR}/data:/data` |

When adding features that persist state, read surrounding `store.ts` / data modules first. Match existing JSON-file or path patterns unless the user asks for a database.

## New app scaffold

**Use the maintained template** — do not copy hvac/nbu/recipes.

Template lives at `.grok/skills/umbrel-dev/template/`. Details: [references/template.md](references/template.md).

```bash
.grok/skills/umbrel-dev/scripts/scaffold.sh <slug> <port> "<App Name>" ["<tagline>"]
```

Example:

```bash
.grok/skills/umbrel-dev/scripts/scaffold.sh widget 4070 "Widget Board" "Track widget status"
```

Creates `wolverineks-<slug>/` with:

- Dev server (`npm run dev:local`) and Docker dev compose
- App shell: header, collapsible side nav, dark mode, sidebar version
- Setup: extension Production/Development sections, backup/restore, clear data
- `chrome-extension/` with prod/dev profile popup
- Built `server.js`, `store.js`, `backup-restore.js`

After scaffold:

1. Add the app to repo `README.md` apps list.
2. Customize `site/server.ts` and `site/store.ts`.
3. When conventions change for **future** apps, edit `template/` — not old app folders.

To update the template itself from a proven pattern in an existing app, extract the **minimal shared skeleton** into `template/` (docker, store, dev scripts) — never symlink whole apps into the template.

## Performance on Raspberry Pi

Before adding SQLite or heavy infra:

1. Measure: file size, record count, `/api/*` latency, response payload size.
2. Prefer: single-pass filters, fewer points in chart APIs, client event delegation, defer non-critical panels.
3. Consider SQLite only if JSON rewrite or full scans remain slow after code fixes.

## Chrome extensions (companion apps)

If the app has `chrome-extension/`:

- Bump `chrome-extension/manifest.json` version when extension behavior changes. Version appears in the popup (title + footer), Setup page, sidebar (`Extension v…`), and `/api/health`.
- Support prod + dev profiles in extension storage when user tests both Umbrel and localhost.
- Reload unpacked extension after changes.

## Agent rules

- **Run commands yourself** — start dev servers, build, curl APIs, SSH when asked.
- **Never edit production data** on Umbrel unless the user explicitly requests it; prefer local `.local-data` for experiments.
- **Keep changes scoped** to the app folder being worked on.
- **Match existing style** in that app's `server.ts` / UI patterns (e.g. Bryant/Carrier layout in HVAC/NBU).

## Quick commands

```bash
# Kill stuck dev port
lsof -ti:4060 | xargs kill -9 2>/dev/null

# Time an API locally
curl -s -o /dev/null -w "%{time_total}\n" "http://localhost:4060/api/usage?utility=electric&granularity=hour&days=365"

# Count production readings (on Umbrel)
python3 -c "import json; print(len(json.load(open('readings.json'))['readings']))"
# run from ~/umbrel/app-data/wolverineks-nbu-dashboard/data/
```