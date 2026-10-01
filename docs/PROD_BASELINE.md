# Production Baseline — 2026-10-01

Recorded before Phase 1 hardening. Re-run after each phase.

## Build
| Package | Command | Result |
|---------|---------|--------|
| @dune/shared | `npm run build --workspace=@dune/shared` | PASS (tsc clean) |
| @dune/server | `npm run build --workspace=@dune/server` | PASS (tsc clean) |
| @dune/client | `npx tsc --noEmit` in packages/client | PASS (exit 0) |
| @dune/client | `vite build` | PASS (last verified 2026-09-30) |

## Tests
| Suite | Result |
|-------|--------|
| `npx vitest run` in packages/server | 5 files, 59/59 passed |
| path.test.ts | 11 passed |
| localScanner.test.ts | 14 passed |
| playtime.test.ts | 13 passed |
| achievements.test.ts | 13 passed |
| hltb.test.ts | 8 passed |
| Client unit/E2E | NONE (gap — Phase 4) |
| tRPC contract tests | NONE (gap — Phase 4) |

## Docker
- `docker compose build`: last verified 2026-09-30 (multi-stage, non-root, healthcheck)
- `docker compose up`: server :3023 + ollama :11434

## Known gaps at baseline
1. tRPC endpoint unauthenticated (only optionalAuthMiddleware) — P0
2. API keys stored plaintext in dune.json — P0
3. `String(e)` 500s leak internals, no request IDs — P0
4. No upload size caps on streaming endpoints — P0
5. No CI workflows — P0
6. pino installed but unused (console.* everywhere) — P1
7. JSON DB read-modify-write, no corruption recovery — P1
8. electron-builder never packaged successfully — P1
9. No integration/E2E tests — P1
10. No .env.example, no backup/restore runbook — P1
