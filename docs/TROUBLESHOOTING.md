# Troubleshooting

Each entry: symptom → how to confirm → fix. Start with `./deploy.sh logs` (or `docker compose logs dune-server`) in every case.

## Server won't start / exits immediately
- Confirm: `docker compose ps`, then `docker compose logs dune-server | tail -30`.
- `EADDRINUSE 0.0.0.0:3030` (bare-metal runs): another instance holds the port. `ss -ltnp | grep 3030`, stop the other instance or set `PORT=` in `.env`.
- `data/` owned by root (volume created by an old rootful run): `sudo chown -R 1000:1000 ./data` (image runs as non-root `dune`).

## `/ready` returns 503
- Confirm which check failed: `curl localhost:3023/ready` → `{"ready":false,"checks":{...}}`.
- `dataDir: {ok:false}`: volume not mounted or read-only, or disk full (`df -h`). Fix mount/permissions/space, restart.
- `database: {ok:false}`: `dune.json` unreadable for a non-corruption reason (permissions). If instead the log says "corrupt DB preserved", see below — the server is up but empty by design.

## "Corrupt DB preserved, booting with defaults" in logs
- The server moved the broken file to `dune.json.corrupt-<ts>` and started empty. Your data is NOT deleted.
- Recover: `./deploy.sh restore ./backups/<latest-good>` (see `BACKUP_RESTORE.md`), or inspect the preserved file first.

## 401 on every API/tRPC call
- Confirm: `curl -H 'x-api-key: KEY' localhost:3023/api/settings` → 401 means bad key, not missing key (missing key is also 401 with "API key required").
- Cause 1: rotated/lost `API_KEY_SECRET` — all stored hashes invalidated. Fix: set the original secret back, or re-register keys.
- Cause 2: key was deleted. Fix: add a new one (needs one working key or direct DB edit while stopped).

## 413 on upload
- File exceeds `MAX_UPLOAD_MB` (default 500) or game hit `MAX_FILES_PER_GAME` (default 5000). Raise in `.env` and restart, or split the save set.

## 429 Too Many Requests
- Rate limits: 100 req/15min globally, 20 uploads/min. Legit bulk syncs (initial import) can trip it — wait it out or restart (counters are in-memory).

## CORS errors in browser dashboard
- Symptom: dashboard loads but API calls fail with CORS in devtools console.
- Confirm: origin (e.g. `http://192.168.1.50:3023`) missing from `ALLOWED_ORIGINS` in `.env`. Add, restart.

## Sync completes but files missing
- Check game path mapping (Win vs Linux path), then server `data/saves/<Game>/`. Check `maxVersions` pruning didn't surprise you (default keeps 10 snapshots under `.versions/`).
- Look for `Remote sync error` / `Failed to extract saves.zip` in logs.

## Ollama features failing (AI analysis, model list)
- Confirm: `curl localhost:11434/api/tags`. If refused, the ollama container is down: `docker compose up -d ollama`, then `docker exec dune-ollama ollama pull phi4-mini`.
- Wrong endpoint: server default is `http://ollama:11434` (compose network). Bare-metal runs need `OLLAMA_URL=http://localhost:11434` equivalent setting.

## Electron client shows blank window
- Fixed in v0.1.0-beta.1 (was: `vite-plugin-electron@1.x` dropped `dist/index.html`). If you see it on newer builds, check `packages/client/dist/index.html` exists after `npm run build:client`.
- On Wayland: launch with `ELECTRON_OZONE_PLATFORM_HINT=auto`.
