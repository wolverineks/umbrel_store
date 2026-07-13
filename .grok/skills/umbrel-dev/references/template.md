# Maintained app template

Location: `.grok/skills/umbrel-dev/template/`

Update this tree when Umbrel conventions change. New apps come from `scaffold.sh`, not from copying hvac/nbu.

## Included out of the box

### Site (`site/`)
- **Dev server** — `npm run dev:local` (`tsx watch`, `PORT`, `.local-data/`, `.local-backup/`)
- **Production build** — `npm run build` → committed `server.js`, `store.js`, `backup-restore.js`
- **App shell** — sticky header, collapsible side nav (mobile ☰), dark mode toggle, sidebar version
- **Pages** — Overview (placeholder), Setup
- **store.ts** — `settings.json` (note + ingest token), clear live data
- **backup-restore.ts** — export/import/clear backup folder
- **APIs** — health, settings, ingest ping, backup, clear data

### Setup page sections
- **Extension → Production** — Umbrel URL + ingest token copy/rotate
- **Extension → Development** — `http://localhost:<port>` + copy URL/token
- **Extension → Load unpacked** — chrome-extension path
- **App settings** — editable note
- **Backup & restore** — back up / restore / clear live / clear backup

### Chrome extension (`chrome-extension/`)
- **Production / Development tabs** in popup
- **settings.js** — profile storage + migration from legacy single URL
- **background.js** — verify token via `/api/ingest/ping`
- `manifest.json` version (shown in popup title, footer, and dashboard sidebar)
- Bump `chrome-extension/manifest.json` version when extension behavior changes (independent of app `umbrel-app.yml` version)

### Docker
- `docker-compose.yml` — production with `/data` + `/backup` volumes
- `docker-compose.dev.yml` — bind-mount `site/` for local iteration

## Placeholders

| Token | Example |
|-------|---------|
| `__APP_ID__` | `wolverineks-widget` |
| `__APP_SLUG__` | `widget` (theme key, backup folder name) |
| `__APP_NAME__` | `Widget Board` |
| `__APP_PORT__` | `4070` |
| `__ENV_PREFIX__` | `WIDGET` |
| `__BACKUP_HOST_PATH__` | `/home/umbrel/widget-backup` |

## Scaffold

```bash
.grok/skills/umbrel-dev/scripts/scaffold.sh <slug> <port> "<App Name>" ["<tagline>"]
```

## After scaffold

1. Add to `README.md` apps list
2. `cd wolverineks-<slug>/site && npm run dev:local`
3. Load `chrome-extension/` unpacked; set Production + Development in popup
4. Replace Overview content and extend `store.ts` for your feature