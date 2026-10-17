# Upgrading

## Version policy
- Tags: `vX.Y.Z` stable, `vX.Y.Z-beta.N` pre-release. Beta tags move the GHCR `:latest` tag (personal-project simplification — pin `:vX.Y.Z` in production if you want immutability).
- Client and server version together (monorepo, single version in all three `package.json`s + lockfile).

## Standard upgrade (compose)
```bash
cd /path/to/dune
./deploy.sh backup                      # safety snapshot first
docker compose pull                     # or: docker compose build (local)
docker compose up -d
curl localhost:3023/ready               # expect {"ready":true,...}
docker compose logs --tail=20 dune-server
```

## Rollback
```bash
docker compose stop dune-server
./deploy.sh restore ./backups/pre-restore-<ts>.tar.gz
```
`restore` snapshots current data first, so a bad rollback is itself undoable (check `./backups`).

## Breaking-change notes by version
- **Multi-user (unreleased, on `main`)**: auth is now per-user. On first boot the server creates a default `admin` user and adopts every existing hashed key (`settings.apiKeys`) as an admin key, so existing clients keep working unchanged; ownerless games are assigned to that admin. New users are created via `users.create` or the dashboard Users panel — each key is shown **once**. Games, playtime and achievements are scoped per user (admins see all); server-global settings, local sources and remote servers are admin-write-only. Game names remain globally unique because saves live at `data/saves/<name>` and are not namespaced per user. Migration is automatic and idempotent on boot.
- **v0.1.0-beta.1** (first tagged release): tRPC requires API keys; keys stored hashed — pre-hardening plaintext keys auto-migrate on first boot of the new image. `API_KEY_SECRET` unset → random persisted secret; set it explicitly before first production boot or all keys invalidate on secret rotation.
- Schema: `dune.json` merges unknown fields tolerantly on read. Downgrading across versions is untested — restore from backup instead of downgrading in place.

## Client upgrades
- Linux: download the new `.AppImage`/`.deb` from the GitHub Release, replace, relaunch. No auto-update in v1 (manual policy — see README/plan Phase 6).
- Downgrade: reinstall the older artifact; local `electron-store` config is forward-tolerant (unknown keys ignored).
