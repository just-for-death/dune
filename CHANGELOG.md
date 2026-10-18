# Changelog

All notable changes, newest first. Format: Keep a Changelog (Added/Fixed/Changed).

## [Unreleased]

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
