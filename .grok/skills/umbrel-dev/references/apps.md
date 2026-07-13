# Wolverineks Umbrel apps

| Folder | ID | Dev port | Data env var | Dev command |
|--------|-----|----------|--------------|-------------|
| wolverineks-hello-world | wolverineks-hello-world | 4000 | (none) | Python — run in `site/` |
| wolverineks-storich | wolverineks-storich | 4010 | — | check `site/package.json` |
| wolverineks-recipes | wolverineks-recipes | 4020 | `RECIPES_DATA_DIR` | `npm run dev:local` |
| wolverineks-brother-printer | wolverineks-brother-printer | 4030 | — | check `site/package.json` |
| wolverineks-hvac | wolverineks-hvac | 4040 | `HVAC_DATA_DIR` | `npm run dev:local` |
| wolverineks-roomba | wolverineks-roomba | 4050 | `ROOMBA_DATA_DIR` | `npm run dev` |
| wolverineks-nbu-dashboard | wolverineks-nbu-dashboard | 4060 | `NBU_DATA_DIR` | `npm run dev:local` |

## Local data paths

All Node apps with `dev:local` use:

```
<app>/site/.local-data/
```

## Docker dev compose

Apps with `docker-compose.dev.yml`: hvac, nbu-dashboard, roomba.

```bash
cd wolverineks-<app>
docker compose -f docker-compose.dev.yml up
```

## Production container

- Internal listen: `PORT=3000` (app_proxy forwards manifest port → 3000)
- Code: read-only `/app` from `~/umbrel/app-data/<id>/site/`
- State: `/data` from `~/umbrel/app-data/<id>/data/`

## NBU dashboard extras

- Backup host path: `~/nbu-backup` (optional volume)
- Chrome extension: `wolverineks-nbu-dashboard/chrome-extension/`
- Extension prod/dev profiles: `chrome.storage.sync` → `profiles.prod` / `profiles.dev`