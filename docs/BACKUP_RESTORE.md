# Backup & Restore Runbook

Operational runbook for Dune server data. Last restore-tested: **2026-10-13** (round-trip byte-identical, see record below).

## What is backed up
- `./data` (repo root in production compose setup): `dune.json` (games/settings/API-key hashes), `playtime.json`, `achievements.json`, `.api-secret`, `saves/` (game files + `.versions/` snapshots), `hltb-cache/` (re-fetchable).
- NOT included: `ollama-data` volume (models re-pull via `ollama pull <model>`), logs, `node_modules`, build output.

## RPO / RTO
- **RPO:** time since last backup (schedule with cron; JSON stores write atomically via tmp+rename, and `*.tmp.*` files are excluded, so a live backup is crash-consistent — stop the server first for guaranteed consistency).
- **RTO:** minutes (extract + start + `/ready` check, automated by `restore`).

## Commands
```bash
./deploy.sh backup [dest-dir]              # default dest ./backups
DATA_DIR=/path/to/data ./deploy.sh backup # back up a different data dir

./deploy.sh restore <archive.tar.gz> [dest-data-dir]   # default dest ./data (or $DATA_DIR)
```

Backup writes `dune-data-<ts>.tar.gz` + `.sha256` sidecar and self-verifies readability. Restore:
1. Validates the archive (readable tar; warns if sha256 sidecar mismatches).
2. Stops `dune-server` if the compose stack is running.
3. Snapshots current data to `pre-restore-<ts>.tar.gz` (never restores destructively).
4. Extracts, restarts the server if it was running, waits up to 30s for `/ready`.

## Restore test record
- **2026-10-13:** fixture (dune.json + saves + secret) → backup (4.0K, 6 entries, <1s) → wipe → restore → `diff -r` **identical**. Error paths verified: missing archive (exit 1), corrupt archive (exit 1). Pre-restore snapshot verified (modified data snapshotted, then restored identical).

## Disaster checklist
1. `ls ./backups` — pick newest `dune-data-*.tar.gz` (or `pre-restore-*` to undo a bad restore).
2. `./deploy.sh restore ./backups/<file>` — watch for "server reports ready".
3. Verify: open dashboard, spot-check a game's file list; `GET /ready` → `{"ready":true}`.
4. If `/ready` stays 503: check data dir ownership (`dune` user in container), disk space, and logs (`./deploy.sh logs`).
5. Corrupt `dune.json`? The server preserves it as `dune.json.corrupt-<ts>` and boots empty — restore the file from backup or inspect the preserved copy first.
6. Rotated/lost `API_KEY_SECRET`? All stored key hashes invalidate — re-add keys via `apiKeys.add` (or fresh `dune-dev-key` flow) and update clients.
