# Spec: Dune Game Hub — Unified Game Library & Launcher

## Objective

Transform Dune from a game-save sync tool into a **unified game hub** (like Playnite/Heroic) that:
- **Discovers** games from Steam, Heroic, Lutris, and manual entries on Linux
- **Launches** games via native executables, Steam protocol, Heroic, Lutris, Wine/Proton
- **Tracks** achievements from Steam, RetroAchievements, GOG (Epic dropped 2026-10-28), and offline / local achievement files
- **Syncs** saves to Dune Server (existing functionality, enhanced)
- **Manages** Wine/Proton prefixes, Heroic/Lutris prefixes
- **Integrates** with Steam (add non-Steam games), Heroic, Lutris
- **Tracks playtime** with detailed analytics (session history, totals, graphs, pie charts)
- **Shows HowLongToBeat** estimates (Main Story, Main+Extra, Completionist) per game
- **Tracks achievements** with visual progress (completed vs remaining, rarity, progress bars, unlock dates)

**Target users**: Linux gamers (Steam Deck, desktop) who use multiple launchers (Steam, Heroic, Lutris) and want a unified, save-syncing, achievement-tracking, playtime-analytics hub.

**Success criteria**:
- [ ] Discovers games from Steam, Heroic, Lutris, manual entries
- [ ] Launches games via appropriate method (native, Steam protocol, Heroic, Lutris, Wine/Proton)
- [ ] Tracks Steam achievements + RetroAchievements + offline / local achievement files (achievement.ini)
- [ ] Syncs saves to Dune Server
- [ ] Manages Wine/Proton prefixes, Heroic/Lutris prefixes
- [ ] Adds non-Steam games to Steam automatically
- [ ] **Shows HLTB estimates (Main, Main+Extra, 100%) per game**
- [ ] **Tracks playtime per game/session with session history**
- [ ] **Shows playtime analytics: total time, per-game breakdown, session graphs, pie charts**
- [ ] **Shows achievement progress: completed vs total, progress bars, rarity, unlock dates**
- [ ] **Shows achievement detail view: unlocked vs locked, rarity, progress bars**
- [ ] Syncs saves to Dune Server
- [ ] Manages Wine/Proton prefixes, Heroic/Lutris prefixes
- [ ] Adds non-Steam games to Steam automatically
- [ ] All existing save-sync functionality preserved

---

## Competitive Feature Absorption (Hydra / Ascendara / Arcane)

Dune should absorb the best ideas from these projects while staying focused on **legitimate library management + save sync + analytics**. Piracy stays out of scope. A content-agnostic download engine (http(s) only, ships with no bundled sources; user-added sources only) is in scope per docs/competitive-design.md (Lead ruling 2026-10-28).

### In scope to absorb

| Source | Feature | Dune adaptation |
|---|---|---|
| Arcane | Save version history + rollback | Immutable per-game save snapshots with restore |
| Arcane | Cross-device conflict resolution | Keep local / remote / both / decide later |
| Arcane | Smart exclusions | Exclude caches, logs, crash dumps, screenshots |
| Arcane | Storage manager | Per-game disk usage, drive free space, last played |
| Arcane | Multi-launcher detection | Epic, GOG, Ubisoft, EA, Battle.net, Xbox, Minecraft |
| Arcane | Collection filters | AND/OR filters by source, sync status, tags |
| Hydra | Classics / emulator library | RetroArch, Dolphin, PCSX2, RPCS3, PPSSPP, DuckStation |
| Hydra | Big Picture mode | Controller-friendly couch UI |
| Hydra | Community themes | CSS-variable theme packs |
| Hydra | Profile/social layer | Optional friends, status, achievement showcase |
| Ascendara | Companion / remote progress | Encrypted remote status and progress view |
| Ascendara | Crash reporter | Opt-in diagnostics and crash reports |
| Ascendara | Achievement watcher | Background process for real-time unlocks |
| Ascendara | Local search index | Fast indexed library search |
| Ascendara | i18n | Multi-language support |
| Ascendara | Tool-install model | Optional helper tools instead of bundled binaries |

### Explicitly out of scope

- Bundling, recommending or scraping copyrighted game download sources (the engine ships with none).
- Torrent support.
- Cloud-only lock-in.
- Silent overwrite during sync conflicts.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite 8, Electron 44, React 19, Ink 8 (TUI) |
| Backend | Express 5 (REST), Zod 4, Node 22+ |
| Database | SQLite (node:sqlite), existing schema extended |
| Game Detection | Custom scanners for Steam, Heroic, Lutris |
| Achievement Sources | Steam Web API, RetroAchievements API, local .ini parsers, GOG API |
| Playtime Sources | Steam Web API (session history), local session tracking, manual entry |
| HLTB Source | HowLongToBeat scraping (steamcommunity.com or hlbt API) |
| Launch Methods | Steam protocol, Heroic CLI, Lutris CLI, Steam protocol, Wine/Proton, umu-launcher |
| Wine/Proton | umu-launcher, Proton-GE, Wine-GE, Proton-GE via umu |
| Game Metadata | Steam Store API, SteamSpy, IGDB, Giant Bomb (via PlayniteAchievements reference) |
| Build | Vite 8 (Rolldown), TypeScript 6, Zod 4 |
| Testing | Vitest (unit), Playwright (e2e), Vitest coverage 80/80/70/80 |

---

## Commands

```bash
# Development
npm run dev:client      # Vite dev server (port 5173)
npm run dev:server      # tsx watch server (port 3030)
npm run dev             # Both concurrently

# Build
npm run build:shared    # tsc on @dune/shared
npm run build:server    # tsc on @dune/server
npm run build:client    # tsc + vite build on @dune/client
npm run build           # All workspaces

# Testing
npm run test            # Server unit tests (vitest)
npm run test:all        # All workspaces
npm run test:e2e        # Playwright e2e (client)
npm run test:coverage   # Coverage with thresholds

# Lint
npm run lint            # ESLint flat config over server + client

# Database
npm run db:migrate      # Run migrations (dev)
npm run db:seed         # Seed test data

# Docker
npm run docker:build    # Multi-stage build
npm run docker:up       # docker compose up -d
```

---

## Project Structure

```
dune/
├── packages/
│   ├── client/                 # Electron + React app
│   │   ├── src/
│   │   │   ├── components/     # React components
│   │   │   ├── pages/          # Page components (Library, GameDetail, Settings, Achievements, PlaytimeAnalytics, AchievementDetail, HLTBView)
│   │   │   ├── hooks/          # React hooks (useGames, useAchievements, useLaunch, usePlaytime, useHLTB)
│   │   │   ├── services/       # GameScanner, AchievementTracker, Launcher, PrefixManager, HLTBService, PlaytimeAnalytics
│   │   │   ├── store/          # Zustand store (games, achievements, prefixes, playtime, hltb)
│   │   │   ├── hooks/          # Custom hooks
│   │   │   ├── utils/          # Client utilities
│   │   │   ├── App.tsx         # Main app
│   │   │   ├── main.tsx        # Electron entry
│   │   │   ├── preload.ts      # Preload script
│   │   │   └── index.css       # Styles
│   │   ├── e2e/                # Playwright tests
│   │   ├── electron/           # Electron main process
│   │   │   ├── main.ts         # Electron main
│   │   │   ├── preload.ts      # Preload script
│   │   │   ├── scanner/        # GameScanner (Steam, Heroic, Lutris)
│   │   │   ├── launcher/       # GameLauncher (Steam, Heroic, Lutris, Wine)
│   │   │   ├── achievements/   # AchievementTracker (Steam, RetroAchievements, Local)  [SUPERSEDED 2026-10-20 for remote trackers: see Decision note below this tree]
│   │   │   ├── hltb/           # HLTBService (scraping, caching, estimates)
│   │   │   ├── playtime/       # PlaytimeAnalytics (session tracking, graphs, pie charts)
│   │   │   ├── achievements/   # AchievementDetail (per-achievement progress, rarity, unlock dates)
│   │   │   ├── prefix/         # PrefixManager (Wine, Proton, Heroic, Lutris)
│   │   │   └── scanner.ts      # Auto-detection logic
│   │   └── build/              # electron-builder config
│   │
│   ├── server/                 # Express REST server
│   │   ├── src/
│   │   │   ├── routes/         # REST endpoints
│   │   │   ├── services/       # GameService, AchievementService, PrefixService, HLTBService, PlaytimeService, AchievementDetailService
│   │   │   ├── db/             # SQLite schema + migrations
│   │   │   └── server.ts       # Express entry
│   │   └── prisma/             # (if switching to Prisma)
│   │
│   └── shared/                 # @dune/shared
│       ├── types/              # Game, Achievement, Prefix, GameSource, LaunchConfig, PlaytimeSession, PlaytimeSummary, HLTBTimes, AchievementDetail, AchievementRarity
│       ├── schemas/            # Zod schemas
│       └── utils/              # Shared utilities
│
├── tasks/
│   ├── plan.md                 # This plan
│   └── todo.md                 # Task list
│
├── docs/                       # Documentation
├── docker-compose.yml
├── deploy.sh
└── package.json                # Workspace root
```

> **Decision 2026-10-20 (monitor) — supersedes the `electron/achievements/` remote-tracker entry above:** remote achievement trackers (Steam, RetroAchievements, GOG, Epic) run on the server, not Electron, so API keys stay off clients. Per-user credentials go in a server-side `user_tracker_credentials` table; keys encrypted at rest with the server secret, write-only, masked in all responses. Local .ini import stays in Electron and feeds the server merge. Sync on play-session end and manual Sync now; optional background poll off by default, min interval 6h.

## Decisions 2026-10-28 (Lead): providers, manifest, updates, downloads
- One switch per provider (HLTB, artwork, manifest). With a server connected the server flag decides (admin-only to change, read-only for members); with no server the local `Settings.*Enabled` flag decides (all default false). A disabled provider makes no network call and answers 403 `{error, code:'PROVIDER_DISABLED'}`.
- Clients fall back to local providers only when no server is configured or it is unreachable (network error or timeout), never on 401, 403 or `PROVIDER_DISABLED`.
- Remote Epic achievements are dropped; GOG stays (opt-in OAuth). The Epic library scanner and the rarity tier are unaffected.
- Save-path manifest: the Ludusavi manifest (PCGamingWiki data, CC BY-NC-SA 3.0, noted in THIRD_PARTY_NOTICES.md; the code licence is unchanged). With a server, `GET /api/manifest/:gameId` serves the parsed entries; with no server, Desktop fetches it. Path expansion stays in Electron main and only suggests paths, never applying one without the user confirming. Games get nullable `steamAppId`/`gogId`, and lookups try ids before the title.
- Update checks: `Settings.updateCheckEnabled` (default false, replaces `updateChecks`, no alias) gates only the automatic check; a manual click always runs one check. Metadata only from api.github.com; notes are plain text; release links open only if https.
- Remote trackers (Steam, RetroAchievements) live in `@dune/providers`; the server keeps per-user encrypted `user_tracker_credentials` (write-only, `{set}` only), an admin `Settings.trackersEnabled` (default off, 403 `PROVIDER_DISABLED`) and member-scoped sync routes; `PROVIDER_PRIVATE_PROFILE` stays a separate code so the UI can tell the user to make the profile public. Desktop adds a local fallback (safeStorage keys) with the same routing rule.
- Downloads: `setBaseDir` affects only new downloads (existing items keep their folder and state); a missing base or override folder fails with `IO_ERROR` and is never recreated.

---

## Code Style

**TypeScript**: Strict mode, explicit types, no `any` (use `unknown`), functional style preferred.

```typescript
// Good: Explicit types, functional, pure where possible
export function buildLocalManifest(
  files: { local: string; rel: string }[]
): FileManifest {
  const fs = require('fs');
  const manifest: FileManifest = {};
  for (const f of files) {
    try {
      const stat = fs.statSync(f.local);
      manifest[toPosix(f.rel)] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
    } catch { /* unreadable: treat as absent */ }
  }
  return manifest;
}

// Bad: implicit any, side effects, mutation
function scan(dir) { ... }
```

**React**: Functional components, hooks, Zustand for state, React Query for server state.

```tsx
// Good: Typed hooks, explicit return
export function useGames() {
  const { data, isLoading } = useQuery({ queryKey: ['games'], queryFn: fetchGames });
  return { games: data ?? [], isLoading };
}
```

**CSS**: CSS custom properties, no frameworks, responsive breakpoints at 900px/680px.

---

## Testing Strategy

| Level | Tool | Scope |
|-------|------|-------|
| Unit | Vitest | Pure functions (scanners, parsers, utils) |
| Integration | Vitest | Services, REST routes, DB |
| e2e | Playwright | Electron app flows (launch, scan, sync) |
| Coverage | Vitest | 80% statements, 80% branches, 70% functions, 80% lines |

---

## Boundaries

| Always Do | Ask First | Never Do |
|-----------|-----------|----------|
| Run `npm run lint` before commit | Schema changes (DB, REST API, shared contracts) | Commit secrets |
| Write tests for new pure functions | Add new dependencies | Edit vendor dirs |
| Update `CHANGELOG.md` per change | Change CI config | Remove failing tests |
| Keep `CHANGELOG.md` current | Modify DB schema | Hardcode paths |
| Run `npm run test` before push | Add new external API | Hardcode API keys |

---

## Success Criteria

- [ ] All existing save-sync tests pass (278/278)
- [ ] New game hub tests pass (scanner, launcher, achievements, HLTB, playtime analytics, achievement detail)
- [ ] e2e tests pass (5/5 existing + new hub flows)
- [ ] Lint clean (0 errors)
- [ ] Build passes (all workspaces)
- [ ] Coverage thresholds met
- [ ] Manual verification: Steam/Heroic/Lutris detection, launch, achievements, HLTB, playtime graphs, achievement detail views

---

## Open Questions

### Core Architecture
1. **Achievement sources priority**: Steam Web API vs local .ini — which takes precedence?
2. **Prefix management scope**: Full Wine/Proton management or just detection?
3. **Heroic/Lutris integration depth**: Read-only detection vs full management (install/uninstall)?
4. **Steam integration**: Auto-add non-Steam games to Steam (like Heroic)?
5. **Flatpak/Steam Deck specifics**: Special handling for Flatpak Steam, Steam Deck Game Mode?
6. **Achievement sync frequency**: Real-time polling vs manual refresh vs scheduled?
7. **Database migration**: Prisma vs raw SQLite migrations?
8. **Heroic/Lutris data access**: Read-only JSON/DB parsing vs CLI calls?

### HLTB Integration
9. **HLTB source**: SteamCommunity.com scraping vs HLTB API (if available) vs community API?
10. **HLTB caching**: Local cache TTL (7 days? 30 days?) and invalidation strategy?
11. **HLTB fallback**: What if HLTB is unavailable — show nothing, cached data, or "Unknown"?

### Playtime Analytics
9. **Playtime granularity**: Per-session tracking with start/end timestamps, or just per-game totals?
10. **Session detection**: Auto-detect game launch/exit via process monitoring vs manual start/stop?
10. **Offline playtime**: Local-only tracking when server unavailable, sync on reconnect?
11. **Graph types**: Line (time), bar (per-game), pie (distribution), heatmap (calendar)?

### Achievement Detail
11. **Achievement Priority**: ✅ **Local .ini wins (offline / local achievement files)** — Local files win when present; Steam API for games without them
12. **Rarity Calculation**: ✅ **Steam global %** — Use Steam's global unlock percentage (standard)
12. **Unlock Notifications**: ✅ **Toast + desktop + screenshot** — Full celebration: toast, notification, auto-screenshot
13. **Rarity Tiers**: ✅ **Steam-standard (10/20/50/80/95/99%)** — Based on Steam's achievement rarity bands

### Playtime Analytics
14. **Graph Types**: ✅ **All 5 types** — Line, Bar, Pie, Heatmap, Area (cumulative)
14. **Time Ranges**: ⏳ *Pending* — All time, year, month, week, custom range?
15. **Export**: ✅ **Yes, CSV + JSON** — Both formats for data portability
14. **Comparison**: ✅ **Yes, period-over-period** — Compare current period vs previous period

### Database & Sync
15. **Database migration**: Prisma vs raw SQLite migrations?
16. **Sync conflict resolution**: Server wins, client wins, merge strategy?
16. **Offline-first**: Local-first with eventual sync vs server-authoritative?

### Heroic/Lutris Integration
17. **Heroic/Lutris data access**: Read-only JSON/DB parsing vs CLI subprocess calls?
18. **Prefix management scope**: Full Wine/Proton management or just detection?
18. **Heroic/Lutris integration depth**: Read-only detection vs full management?
19. **Steam integration**: Auto-add non-Steam games to Steam (like Heroic)?
19. **Flatpak/Steam Deck**: Special handling for Flatpak Steam, Steam Deck Game Mode?
20. **Achievement sync strategy**: Real-time polling vs manual refresh vs scheduled cron?

## Decisions Made

### Core Architecture
1. **Achievement Priority**: ✅ **Local .ini wins (offline / local achievement files)** — Local files win when present; Steam API for games without them
2. **Prefix Management**: ✅ **Full lifecycle management** — Create/delete/backup/repair/version-switch Wine/Proton prefixes
3. **Heroic/Lutris Depth**: ✅ **Read-only detection** — Only read game lists from Heroic/Lutris configs/DBs
4. **Steam Integration**: ✅ **Yes, auto-add to Steam** — Create Steam shortcuts automatically for Heroic/Lutris/manual games
5. **Flatpak/Steam Deck**: ✅ **Full support** — Detect Flatpak Steam paths, Steam Deck Game Mode, enable controller UI
6. **Achievement Sync**: ✅ **Real-time polling** — Poll Steam/RetroAchievements every N minutes; push to server
7. **Database Migration**: ✅ **Migrate to Prisma** — Switch to Prisma ORM for type-safe DB access and migrations
8. **Heroic/Lutris Data Access**: ✅ **Hybrid** — Parse JSON/DB primarily, CLI fallback for edge cases

### HLTB Integration
9. **HLTB Source**: ✅ **Multiple with fallback** — Try Steam first, then HLTB site, then community API
10. **HLTB Caching**: ✅ **30 days (recommended)** — Balanced TTL; HLTB data rarely changes
11. **HLTB Fallback**: ✅ **Show cached (stale)** — Show cached data with 'stale' indicator

### Playtime Analytics
9. **Playtime Granularity**: ✅ **Per-session tracking** with start/end timestamps
10. **Session Detection**: ✅ **Process monitoring (auto)** — Monitor running processes; detect launch/exit via process list polling
11. **Offline Playtime**: ✅ **Local-first + sync** — Track locally always; sync to server when online
11. **Graph Types**: ✅ **All 5 types** — Line, Bar, Pie, Heatmap, Area (cumulative)

### Achievement Detail
11. **Achievement Priority**: ✅ **Local .ini wins (offline / local achievement files)** — Local files win when present; Steam API for games without them
12. **Rarity Calculation**: ✅ **Local user %** — Rarity relative to this user's library
12. **Unlock Notifications**: ✅ **Toast + desktop + screenshot** — Full celebration: toast, notification, auto-screenshot
13. **Rarity Tiers**: ✅ **Steam-standard (10/20/50/80/95/99%)** — Based on Steam's achievement rarity bands

### Playtime Analytics
14. **Graph Types**: ✅ **All 5 types** — Line, Bar, Pie, Heatmap, Area (cumulative)
14. **Time Ranges**: ✅ **All + Week/Month/Year + Custom** — Standard intervals + custom range
15. **Export**: ✅ **Yes, CSV + JSON** — Both formats for data portability
14. **Comparison**: ✅ **Yes, period-over-period** — Compare current period vs previous period

### Database & Sync
15. **Database Migration**: ✅ **Migrate to Prisma** — Switch to Prisma ORM for type-safe DB access and migrations (big-bang migration)
16. **Sync Conflict Resolution**: ✅ **Merge with timestamps** — Compare timestamps per field; newer wins; conflicts flagged for manual review
16. **Offline-First**: ✅ **Local-first + sync** — Track locally always; sync to server when online

### Heroic/Lutris Integration
17. **Heroic/Lutris Data Access**: ✅ **Hybrid** — Parse JSON/DB primarily, CLI fallback for edge cases
18. **Prefix Management Scope**: ✅ **Full lifecycle management** — Create/delete/backup/repair/version-switch Wine/Proton prefixes
18. **Heroic/Lutris Integration Depth**: ✅ **Read-only detection** — Only read game lists from Heroic/Lutris configs/DBs
19. **Steam Integration**: ✅ **Yes, auto-add to Steam** — Create Steam shortcuts automatically
19. **Flatpak/Steam Deck**: ✅ **Full support** — Detect Flatpak Steam paths, Steam Deck Game Mode, enable controller UI
20. **Achievement Sync Strategy**: ✅ **Real-time polling** — Poll Steam/RetroAchievements every N minutes; push to server

---

## Remaining Open Questions (5 pending)

*Decisions above marked with ✅ are finalized. Remaining questions need your input before Phase 2 (Plan).*

### Achievement Detail
12. **Unlock Notifications**: Toast, sound, desktop notification, screenshot capture?
13. **Rarity Tiers**: Common/Uncommon/Rare/Ultra Rare/Epic/Legendary thresholds?

### Playtime Analytics
14. **Time Ranges**: All time, year, month, week, custom range?
15. **Export**: CSV/JSON export of playtime data?
14. **Comparison**: Compare playtime across periods (this week vs last week)?---

## Remaining Open Questions (0 pending)

*All decisions finalized. Ready for Phase 2 (Plan).*

---

## Spec Approved ✅

All 20 decisions finalized. Ready to proceed to Phase 2 (Plan) implementation.
## Remaining Open Questions (10 pending)

*Decisions above marked with ✅ are finalized. Remaining questions need your input before Phase 2 (Plan).*

---

## Competitive Feature Success Criteria

- [ ] Save versions can be listed and restored per game
- [ ] Sync conflicts are surfaced with keep-local / keep-remote / keep-both / decide-later options
- [ ] Smart exclusions reduce backup size and are user-editable
- [ ] Storage manager shows per-game and per-drive usage
- [ ] Epic, GOG, Ubisoft, EA, Battle.net, Xbox, and Minecraft games can be detected
- [ ] Emulator/classics libraries can be detected and launched
- [ ] Collections support AND/OR filters
- [ ] Big Picture mode is usable with a controller
- [ ] Theme packs can be installed and applied
- [ ] Library search is indexed and fast
- [ ] Companion progress view works remotely
