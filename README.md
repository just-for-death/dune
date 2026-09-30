# Dune 🏜️ — Game Save Sync Ecosystem (Monorepo)

**Dune** is a complete game-save management ecosystem: an Electron desktop client, an Express + tRPC server, and shared TypeScript contracts — all in one monorepo with npm workspaces.

```
dune/
├── packages/
│   ├── client/   # @dune/client — Electron + React + Vite desktop app
│   ├── server/   # @dune/server — Express + tRPC API, Dockerized
│   └── shared/   # @dune/shared — Game, Settings, ElectronAPI, Playtime, Achievements, HLTB types
├── docker-compose.yml   # server + ollama stack
├── deploy.sh            # install / build / test / up / logs
└── package.json         # workspaces root
```

## Quick Start

```bash
# 1. Install all workspaces
./deploy.sh install
# or: npm install

# 2. Build shared → server → client
./deploy.sh build

# 3. Run tests
./deploy.sh test

# 4. Start production stack (server :3023 + ollama :11434)
./deploy.sh up
```

- Server API: `http://localhost:3023` · tRPC: `http://localhost:3023/trpc` · Health: `http://localhost:3023/health`
- Client dev: `npm run dev --workspace=@dune/client`
- Server dev: `npm run dev --workspace=@dune/server`

## Packages

| Package | Stack | Purpose |
|---------|-------|---------|
| `@dune/client` | Electron 25, React 18, Vite 4, TS | Desktop app: save mapping (Win/Linux paths), auto-detect via ludusavi manifest + Wine prefixes, cloud sync/restore with progress, Playtime + Achievements + HLTB tabs, SteamGridDB art, toasts, tray/background mode |
| `@dune/server` | Express 4, tRPC 11, Zod, TS strict | Save sync API (streaming upload, versioning, atomic JSON DB), playtime/achievements/HLTB services, Ollama AI analysis, SteamGridDB proxy, local dual-boot sync, remote replication, API-key auth, rate-limit, helmet, CORS |
| `@dune/shared` | TypeScript only | Single source of truth: `Game`, `Settings`, `ElectronAPI` (full IPC contract), `PlaytimeSession/Summary`, `Achievement/Summary`, `HLTBTimes`, `APIResponse`, `SyncProgress` |

## Features

- **Save sync with versioning** — per-file streaming upload (`x-game`/`x-path`/`x-sync-id` headers), `.versions/{timestamp}/` snapshots, `maxVersions` pruning, `saves.zip` auto-extract
- **tRPC + Zod** — end-to-end type safety; breaking API changes fail at compile time, not runtime
- **Playtime tracking** — `POST /trpc/playtime.record`, summaries, recent sessions, totals
- **Achievements** — per-game lists, summaries, recent unlocks, Sentinel webhook
- **HLTB** — completion times with 7-day file cache + bulk fetch
- **AI file analysis** — Ollama (`phi4-mini` default) classifies Save/Config/Cache/Other
- **Security** — API-key auth, 100 req/15min + 20 uploads/min rate limits, helmet CSP, CORS allowlist, path-traversal guards, atomic writes
- **59 unit tests** — path utils, scanner, playtime, achievements, HLTB (Vitest)
- **Docker** — multi-stage build, non-root user, tini, healthcheck; compose includes Ollama

## Development

```bash
npm install                  # all workspaces
npm run build --workspaces   # shared → server → client
npm run test --workspace=@dune/server
npm run dev --workspace=@dune/server   # :3030
npm run dev --workspace=@dune/client   # vite dev
```

## Deployment

```bash
./deploy.sh docker:build
./deploy.sh up      # server + ollama
./deploy.sh logs    # follow server logs
./deploy.sh down
```

Data persists in `./data` (mounted to `/app/backend/data`). Configure SteamGridDB key + Ollama endpoint in server Settings or via API.

## Migration Notes

This monorepo consolidates the former `dune` (client), `dune-server`, and `dune-shared` repositories. Git history for the client is preserved via `git mv`; server/shared were copied in (their histories remain in the archived repos).
