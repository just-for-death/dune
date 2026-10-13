# Changelog

All notable changes, newest first. Format: Keep a Changelog (Added/Fixed/Changed).

## [Unreleased]

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
