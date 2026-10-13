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
- **v0.1.0-beta.1** (first tagged release): tRPC requires API keys; keys stored hashed — pre-hardening plaintext keys auto-migrate on first boot of the new image. `API_KEY_SECRET` unset → random persisted secret; set it explicitly before first production boot or all keys invalidate on secret rotation.
- Schema: `dune.json` merges unknown fields tolerantly on read. Downgrading across versions is untested — restore from backup instead of downgrading in place.

## Client upgrades
- Linux: download the new `.AppImage`/`.deb` from the GitHub Release, replace, relaunch. No auto-update in v1 (manual policy — see README/plan Phase 6).
- Downgrade: reinstall the older artifact; local `electron-store` config is forward-tolerant (unknown keys ignored).
