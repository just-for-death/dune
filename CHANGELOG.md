# Changelog

All notable changes, newest first. Format: Keep a Changelog (Added/Fixed/Changed).

## [Unreleased]
### Added
- Desktop app icon (`packages/client/build/icon.png`) wired into electron-builder.
- REST contract tests for `/api/settings`, `DELETE /api/saves`, and admin user-key management, plus persisted-secret and CORS-allowlist unit tests.
### Changed
- Toolchain: Vite 7→8 (Rolldown) + `@vitejs/plugin-react` 6; vitest 3→5; ESLint 8→10 (flat config). `vite.config.ts` → `vite.config.mts`.
- Server runtime: Express 4→5, helmet 7→8, express-rate-limit 7→8, pino 9→10 (+ pino-pretty 13), zod 3→4.
- UI: React 18→19 (client + server TUI) and ink 4→8; `@types/node` 20/22→26; electron 44.8.0→44.9.0.
- GHCR `:latest` now tracks stable releases only; prerelease tags (e.g. `v0.2.0-beta.1`) push only their version tag.
### Fixed
- `/api/settings` (GET/POST) and `DELETE /api/saves` were registered *after* the `/api` 404 catch-all, so Express shadowed them and the dashboard's Settings save and delete-by-id always returned 404.
- Express 5's `res.download` defaults to `dotfiles: 'ignore'`, which 404'd version snapshots under `.versions/` (and any listed dotfile save); both download endpoints now pass `dotfiles: 'allow'` after the traversal check.
- Stayed on TypeScript 5: TS 7 (native port) is not yet supported by `@typescript-eslint` v8.

### Known issues
- `sprintf-js` (moderate, **dev-only**) remains via `electron-builder` → `app-builder-lib` → `@electron/get` → `global-agent` → `roarr`. The package is unmaintained and no patched release exists; it is a build-time dependency and never ships in the app. `npm audit --omit=dev` is clean.

## [0.2.0-beta.1] — 2026-10-18
### Added
- Multi-user support: `users` + per-user API keys with `admin`/`member` roles. Games, playtime, achievements and saves are owner-scoped (`data/saves/<ownerId>/<game>`); admins see everything. Boot migration creates a default admin and adopts legacy `apiKeys`.
- Per-user API key management (`GET/POST/DELETE /api/api-keys`, `users.*`): issue a key (plaintext shown once), list masked keys, revoke by id; `users.me` for self-service.
- Delta sync: server SHA-256 manifest at `GET /api/manifest`; the client diffs fingerprints and uploads/restores only changed files, persisting per-game `syncState`. Pure diff helpers live in `@dune/shared`.
- Dashboard: login/key gate with auto-login, Users/Settings/Keys cards, per-game delete, and an Owner column so admins can tell users' games apart.
- `GET/POST /api/settings` and `DELETE /api/saves` (by id).
### Changed
- Saves are namespaced per owner; legacy flat `data/saves/<game>` dirs are migrated on boot. Game names are unique per owner.
- Settings, local sources, remote servers and `sync.local` writes are admin-only; members receive masked `steamGridApiKey`/`apiKeys`. The SteamGridDB key is never returned to members.
- Electron `protocol.handle` replaces the deprecated `registerFileProtocol`; electron-builder 24→26 (electron pinned 44.8.0); Vite 5→7 via `vite-plugin-electron` 1.x.
- Unified bridge/types: `ElectronAPI`, `Game`, `Settings`, `Achievement` now live in `@dune/shared`.
- Removed 6 dead tRPC stubs (`sync.export/push/restore`, `files.download`, `versions.download`, `art.upload`).
### Fixed
- Boot migration no longer creates `idx_games_owner` before `games.ownerId` exists (previously quarantined DBs on upgrade).
- `adm-zip` 0.5.18 → 0.6.1 (8 advisories incl. symlink overwrite and decompression-bomb bypass); `npm audit --omit=dev` is now clean.
- Manifest hash cache invalidation now passes the owner id for locally-synced games.
- Dashboard deletes games by id so same-titled games from different owners don't collide.

## [0.1.0-beta.1] — 2026-10-13 (first tagged beta)
### Added
- Monorepo (`packages/client`, `packages/server`, `packages/shared`, npm workspaces)
- Express + tRPC API: saves sync with versioning, playtime, achievements (+Sentinel webhook), HowLongToBeat, Ollama AI analysis, SteamGridDB art, local dual-boot sync, remote replication
- API-key auth on all endpoints (tRPC + REST), hashed key storage with plaintext auto-migration
- Upload caps (413s), rate limiting, helmet/CSP, CORS allowlist, path-traversal guards
- Liveness (`/health`) + readiness (`/ready`) probes; Docker healthchecks target `/ready`
- `deploy.sh` backup/restore with pre-restore snapshots + runbook
- CI (build/test/lint/docker) + required status checks; release workflow (GHCR + AppImage/deb)
- Electron client: dashboard, path mapping, sync UI, playtime/achievements tabs, HLTB lookup, toasts
### Fixed
- tRPC mount prefix (all tRPC-over-HTTP 404d), partial-upload leftover race, `dist/index.html` dropped by builder v1 (white-screen), IPv4 preview bind for e2e
