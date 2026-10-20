# Competitive Design Analysis — Hydra, Ascendara, Arcane

Research clones used for this analysis:

- Hydra: `/tmp/opencode/research/hydra` (`hydralauncher/hydra`, shallow clone)
- Ascendara: `/tmp/opencode/research/ascendara` (`Ascendara/ascendara`, shallow clone)
- Arcane: public product site only (`https://www.arcane-powered.com/`)

## 1. Hydra architecture

### High-level shape
- Electron app with three main surfaces:
  - `src/main` — Electron main process, services, IPC/event handlers
  - `src/renderer` — React UI
  - `src/big-picture` — separate couch/controller UI
- Uses `classic-level` (LevelDB) as its local database:
  - `src/main/level/level.ts` creates `ClassicLevel`
  - `src/main/level/sublevels/*.ts` defines typed sublevels for games, downloads, themes, emulators, cloud-save anchors, memory cards, etc.
- Feature modules are organized as:
  - `src/main/services/*`
  - `src/main/events/*`
  - `src/main/level/sublevels/*`
- Renderer pages live under `src/renderer/src/pages/*`.

### Notable design patterns
- **Sublevel-per-domain storage**: each feature gets its own typed LevelDB sublevel.
- **Event-driven IPC**: main exposes feature namespaces under `src/main/events/*`.
- **Separate Big Picture app**: controller UI is not just a mode; it has its own Vite entry.
- **Emulator support is deep**, not cosmetic:
  - emulator detection
  - ROM folder scanning
  - save states and battery saves
  - PS1/PS2 memory cards
  - RetroArch bindings
- **Theme system** is first-class:
  - custom themes
  - theme editor
  - import/delete modal flows
- **Cloud save** is version/anchor oriented:
  - sync anchors
  - prefix generations
  - pending deletions
  - emulator destinations

### What Dune should borrow
- Sublevel/domain-storage idea, adapted to Dune's SQLite tables.
- Deep emulator support with memory-card handling.
- Separate Big Picture entry point.
- Theme packs with editor/import/delete flows.

## 2. Ascendara architecture

### High-level shape
- Electron app with:
  - `electron/` main process and modular IPC handlers
  - `src/` React UI
  - `binaries/` Python helper tools
- UI uses Radix/shadcn-style components.
- Modules are split by concern under `electron/modules/*`:
  - games, downloads, settings, themes, retro, proton, wine, hltb, discord-rpc, etc.

### Notable design patterns
- **Modular Electron IPC**: one module per concern.
- **Optional helper tools**: achievement watcher, crash reporter, downloader, game handler, notifications.
- **Retro support** is isolated under `electron/modules/retro`.
- **Theme and i18n** are first-class.
- **Remote/companion features** are part of the product surface.

### What Dune should borrow
- Modular IPC handler organization.
- Optional helper-tool installation model.
- Retro module isolation.
- Theme/i18n as core product features.

## 3. Arcane architecture (observed from product UX)

Arcane is closed-source, but its public UX reveals a strong save-sync architecture:

- **Version history**: every save is versioned and restorable.
- **File-level diffs**: shows added/changed/removed files and byte deltas.
- **Conflict handling**: keep local, keep remote, keep both, decide later.
- **Smart exclusions**: caches, logs, crash dumps, screenshots are excluded by default.
- **Storage manager**: per-game and per-drive usage, last played, cleanup.
- **Multi-launcher + emulator** support.
- **Collections** with AND/OR filters.
- **Freemium storage tiers** by retention and capacity.

### What Dune should borrow
- Immutable save versions.
- Explicit conflict records.
- Backup profiles with exclusions.
- Storage scanner and cleanup.
- Collections and indexed search.

## 4. Mapping to Dune

Dune already uses:
- Electron + React + TypeScript
- Express/tRPC server
- SQLite

Therefore, the best adaptation is:

| Competitor concept | Dune adaptation |
|---|---|
| Hydra LevelDB sublevels | SQLite tables per domain |
| Hydra Big Picture entry | Separate Vite/Electron entry or route |
| Hydra theme packs | CSS-variable theme packs + import/export |
| Ascendara modular IPC | `electron/modules` or feature folders |
| Ascendara optional tools | Optional helper installation |
| Arcane versions | `save_versions` + `save_file_snapshots` |
| Arcane conflicts | `conflict_records` |
| Arcane exclusions | `backup_profiles` |
| Arcane storage | `storage_entries` + scanner |

## 5. Recommended implementation order

1. Save versioning and restore
2. Conflict detection and resolution
3. Smart exclusions and backup profiles
4. Storage manager
5. Broad launcher detection
6. Emulator/classics support
7. Collections and indexed search
8. Big Picture mode
9. Theme packs and i18n
10. Companion, diagnostics, optional cloud

## 6. Design rules for Dune

- Keep Dune offline-first and self-hostable.
- Never silently overwrite during sync conflicts.
- Make destructive actions explicit and reversible where possible.
- Keep optional heavy tools out of the base install.
- Prefer public metadata APIs; do not scrape pirated game sources.
- Preserve all existing save-sync behavior and tests.
