# tRPC API Snapshot — v1 (2026-10-01), auth enforced 2026-10-01

Source: `packages/server/src/trpc/router.ts` (`appRouter`).
Rule: any procedure add/rename/remove/signature change MUST update this file in the same PR.

## Auth (since 2026-10-01 hardening)
- ALL procedures require a valid API key (`x-api-key` header or `?api_key=`), EXCEPT `health`.
- Missing key → `UNAUTHORIZED`; wrong key → `UNAUTHORIZED`.
- Keys are stored as HMAC-SHA256 hashes (see `API_KEY_SECRET` / `data/.api-secret`); plaintext keys auto-migrated on boot.
- Legacy REST file routes enforce the same key via `authMiddleware`.

## games
- `games.list` — query, no input → `{success, games}`
- `games.get` — query `{id:number}` → `{success, game}` / NOT_FOUND
- `games.add` — mutation `gameInput` → `{success, games}`
- `games.remove` — mutation `{id:number}` → `{success}` / NOT_FOUND

## sync
- `sync.export` — mutation → stub message (use REST for download)
- `sync.push` — mutation `{url}` → stub (use REST streaming upload)
- `sync.restore` — mutation `{url}` → stub (use REST)
- `sync.test` — mutation `{url}` → `{success, message}`
- `sync.local` — mutation → `{success, count, games}`

## files
- `files.list` — query `{game}` → `{success, files}`
- `files.download` — query `{game, path}` → stub (use REST)
- `files.versions.list` — query `{game}` → `{success, versions}`
- `files.versions.files` — query `{game, versionId}` → `{success, files}`
- `files.versions.download` — query `{game, versionId, path}` → stub (use REST)

## art
- `art.search` — query `{query}` → SteamGridDB results / UNAUTHORIZED if no key
- `art.autoMatch` — mutation → `{success, count}` / UNAUTHORIZED
- `art.set` — mutation `{gameName, url}` → `{success}` / NOT_FOUND
- `art.upload` — mutation `{gameName, file}` → stub (use REST)

## ai
- `ai.analyze` — mutation `{gameName, files[]}` → Ollama classification, persists to game
- `ai.health` — query → model status
- `ai.models` — query `{endpoint}` → model list

## hltb
- `hltb.get` — query `{gameName}` → `{success, times?}` (7-day cache)
- `hltb.bulk` — query `{gameNames[]}` → `{success, times}`

## playtime
- `playtime.record` — mutation `{game, platform, sessionStart, sessionEnd}` (ISO datetimes)
- `playtime.summary` — query `{game?}` → summaries
- `playtime.recent` — query `{limit 1..100 default 50}` → sessions
- `playtime.total` — query → `{success, totalMinutes}`

## achievements
- `achievements.get` — query `{game}` → achievements
- `achievements.summary` — query `{game?}` → per-game totals + percentage
- `achievements.recent` — query `{limit 1..100 default 20}` → unlocks
- `achievements.sentinelWebhook` — mutation `{game, achievements[]}` → `{success, count}`

## localSources
- `localSources.list` / `.add {path}` / `.remove {id}`

## remoteServers
- `remoteServers.list` / `.add {url}` / `.remove {id}`

## apiKeys
- `apiKeys.list` (masked) / `.add {key, description?}` / `.remove {key}`

## settings
- `settings.get` (apiKeys masked) / `.update` (partial: maxVersions, steamGridApiKey, ollamaEndpoint, ollamaModel, autoSyncEnabled, autoSyncFreq)

## health
- `health` — query → `{status:'ok', timestamp}` (NO AUTH — public)

## Legacy REST (streaming file ops, authMiddleware enforced)
- `POST /api/upload-file` (headers x-game/x-path/x-sync-id)
- `POST /api/local-sync`
- `GET /api/download-file?game&path`
- `GET /api/download-version-file?game&versionId&path`
- `GET /health`
