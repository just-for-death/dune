# Changelog

All notable changes, newest first. Format: Keep a Changelog (Added/Fixed/Changed).

## [Unreleased]
### Added
- Server dashboard rebuild: tab rail (Overview/Games/Users/API keys/Settings) with hash routing, Lucide-derived inline icon sprite, status tiles with semantic tones, empty states with next-step hints, toasts for every action, formatted timestamps, and parallelised per-game fetches (was serial N+1).
- Desktop app icon set (Lucide-derived inline SVG) across the sidebar, stat cards, section headers, buttons, toasts and empty states; filled in the previously unstyled sync-progress and stat-card classes.
- `.gitignore` entries for installed agent skill directories (`.agents/`, `skills-lock.json`).

### Changed
- Server dashboard destructive row actions are now quiet (muted → red on hover) and no longer dominate the tables.
- Server dashboard connection card no longer duplicates the topbar Refresh / Run-local-sync buttons.

### Fixed
- Horizontal page scroll on narrow viewports caused by `white-space: nowrap` table cells leaking past the scroller (`contain: paint` on `.table-wrap`).

## [0.2.0-beta.2] — 2026-10-18
### Added
- Desktop app icon (`packages/client/build/icon.png`) wired into electron-builder.
- REST contract tests for `/api/settings`, `DELETE /api/saves`, and admin user-key management, plus persisted-secret and CORS-allowlist unit tests.
### Changed
- Toolchain: Vite 7→8 (Rolldown) + `@vitejs/plugin-react` 6; vitest 3→5; ESLint 8→10 (flat config); TypeScript 5.9→6.0.3. `vite.config.ts` → `vite.config.mts`.
- Server runtime: Express 4→5, helmet 7→8, express-rate-limit 7→8, pino 9→10 (+ pino-pretty 13), zod 3→4.
- UI: React 18→19 (client + server TUI) and ink 4→8; `@types/node` 20/22→26; electron 44.8.0→44.9.0.
- GHCR `:latest` now tracks stable releases only; prerelease tags (e.g. `v0.2.0-beta.1`) push only their version tag.
### Fixed
- `/api/settings` (GET/POST) and `DELETE /api/saves` were registered *after* the `/api` 404 catch-all, so Express shadowed them and the dashboard's Settings save and delete-by-id always returned 404.
- Express 5's `res.download` defaults to `dotfiles: 'ignore'`, which 404'd version snapshots under `.versions/` (and any listed dotfile save); both download endpoints now pass `dotfiles: 'allow'` after the traversal check.
- Record ids are now collision-free. `Date.now() + Math.random()` held only ~4096 distinct values per millisecond (a double's ULP at ~1.79e12 is 2.4e-4), so ids minted in the same tick collided — e.g. `UNIQUE constraint failed: games.id` when two saves were claimed at once, which was the source of the ~5–10% failure rate in the `db.test.ts` 50-parallel-writes test. A monotonic `nextId()` in `@dune/shared` now backs every id site.

### Known issues
- `sprintf-js` ≤1.1.3 (moderate, **dev-only**) is still reported by `npm audit` via `electron-builder` → `app-builder-lib` → `@electron/get@3` → `global-agent@3` → `roarr`. It never ships in the app (`npm audit --omit=dev` is clean) and is only reached by `roarr`'s internal log formatting, never an attacker-controlled format string. The CVE behind it, CVE-2026-97058, was **rejected/withdrawn by its CNA (VulnCheck) on 2026-10-12** and NVD lists it as Rejected, but GitHub's advisory (GHSA-hp3w-g68c-fv3c) stays published, so `npm audit` keeps flagging it; the upstream package is unmaintained and has no patched release.
- We verified a mitigation but deliberately did **not** land it: a root `"overrides": { "global-agent": "^4.1.3" }` takes `npm audit` to 0 (`global-agent@4` drops `roarr`/`sprintf-js`; only `bootstrap()` is used and it is `try`/`catch`-guarded). npm refuses to apply a newly-added override while `package-lock.json` is complete — honouring it needs a full re-resolution (`rm -rf node_modules package-lock.json && npm install`), which also floats ~29 unrelated transitive deps (acorn, ajv, mime-types, which, keyv, playwright, …). Not worth it for a rejected, dev-only advisory.
- The finding disappears upstream once `electron-builder` 27 is stable: `app-builder-lib@27.0.0-alpha.10` already depends on `@electron/get@^5`, which dropped `global-agent` entirely.

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
