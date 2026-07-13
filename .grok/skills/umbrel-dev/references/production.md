# Umbrel production ops

## SSH

```bash
ssh umbrel@umbrel.local
# or: ssh umbrel@<lan-ip>
```

User is `umbrel`. App data is under `~/umbrel/app-data/`.

## Inspect an app

```bash
APP=wolverineks-nbu-dashboard
DATA=~/umbrel/app-data/$APP/data
SITE=~/umbrel/app-data/$APP/site

ls -la $DATA $SITE
docker ps --format '{{.Names}}' | grep $APP
docker logs $(docker ps --format '{{.Names}}' | grep "${APP}_server" | head -1) --tail 50
```

## NBU Utilities — clear usage (keep settings)

From Setup UI (v1.20+): **Clear live records** / **Clear backup folder**.

Manual equivalent:

```bash
cd ~/umbrel/app-data/wolverineks-nbu-dashboard/data
rm -f readings.json imports.json source-errors.json
rm -rf uploads/
# keep settings.json
```

Then restart app in Umbrel UI and resync from extension.

## Update deployed code after git push

Umbrel Community Store pulls from GitHub. After push:

1. Open app in Umbrel → Update (or reinstall).
2. Confirm `site/server.js` timestamp on device matches expectation.
3. Restart if UI unchanged.

## Performance signals (Pi)

- `readings.json` size and entry count
- `/api/usage` response bytes and `points.length`
- Docker logs for slow-request warnings
- Chart range: hourly 30d OK; 365d+ should use daily aggregation (v1.21+)