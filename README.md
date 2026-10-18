<p align="center">
  <img src="packages/client/build/icon.png" alt="Dune" width="112" height="112" />
</p>

# Dune 🏜️ — Game Save Sync Ecosystem (Monorepo)

**Dune** is a complete game-save management ecosystem: an Electron desktop client, an Express + tRPC server, and shared TypeScript contracts — all in one monorepo with npm workspaces.

```
dune/
├── packages/
│   ├── client/   # @dune/client — Electron + React + Vite desktop app
│   ├── server/   # @dune/server — Express + tRPC API, Dockerized
│   └── shared/   # @dune/shared — Game, Settings, ElectronAPI, Playtime, Achievements, HLTB types
├── docker-compose.yml   # server stack (Ollama runs on the host by default)
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

# 4. Start production stack (server :3023)
./deploy.sh up
```

- Server API: `http://localhost:3023` · tRPC: `http://localhost:3023/trpc` · Health: `http://localhost:3023/health`
- Client dev: `npm run dev --workspace=@dune/client`
- Server dev: `npm run dev --workspace=@dune/server`

## Packages

| Package | Stack | Purpose |
|---------|-------|---------|
| `@dune/client` | Electron 44, React 18, Vite 5, TS | Desktop app: save mapping (Win/Linux paths), auto-detect via ludusavi manifest + Wine prefixes, cloud sync/restore with progress, Playtime + Achievements + HLTB tabs, SteamGridDB art, toasts, tray/background mode |
| `@dune/server` | Express 4, tRPC 11, Zod, TS strict | Save sync API (streaming upload, versioning, SQLite DB via `node:sqlite`), playtime/achievements/HLTB services, Ollama AI analysis, SteamGridDB proxy, local dual-boot sync, remote replication, API-key auth, rate-limit, helmet, CORS |
| `@dune/shared` | TypeScript only | Single source of truth: `Game`, `Settings`, `ElectronAPI` (full IPC contract), `PlaytimeSession/Summary`, `Achievement/Summary`, `HLTBTimes`, `APIResponse`, `SyncProgress` |

## Features

- **Save sync with versioning** — per-file streaming upload (`x-game`/`x-path`/`x-sync-id` headers), `.versions/{timestamp}/` snapshots, `maxVersions` pruning, `saves.zip` auto-extract
- **tRPC + Zod** — end-to-end type safety; breaking API changes fail at compile time, not runtime
- **Playtime tracking** — `POST /trpc/playtime.record`, summaries, recent sessions, totals
- **Achievements** — per-game lists, summaries, recent unlocks, Sentinel webhook
- **HLTB** — completion times with 7-day file cache + bulk fetch
- **AI file analysis** — Ollama (`phi4-mini` default) classifies Save/Config/Cache/Other
- **Security** — API-key auth, 100 req/15min + 20 uploads/min rate limits, helmet CSP, CORS allowlist, path-traversal guards, atomic writes
- **237 unit tests** — path utils, scanner, playtime, achievements, HLTB, SQLite DB, security, tRPC + REST shims (Vitest, 80% coverage gate)
- **Docker** — multi-stage build (Node 22), non-root user, tini, healthcheck; Ollama is expected on the host (or point `ollamaEndpoint` at any reachable instance)

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
./deploy.sh up      # server stack
./deploy.sh logs    # follow server logs
./deploy.sh down
```

Data persists in `./data` (mounted to `/app/backend/data`). Configure SteamGridDB key + Ollama endpoint in server Settings or via API.

## Migration Notes

This monorepo consolidates the former `dune` (client), `dune-server`, and `dune-shared` repositories. Git history for the client is preserved via `git mv`; server/shared were copied in (their histories remain in the archived repos).
