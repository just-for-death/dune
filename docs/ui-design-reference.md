# UI Design Reference — Arcane AppImage

Source analyzed:
- `/home/zoro/Documents/Projects/manga/sunfire/arcane-powered_0.7.1_amd64.AppImage`
- Extracted with `--appimage-extract` to `/home/zoro/Documents/Projects/manga/sunfire/squashfs-root`
- Public product site: `https://www.arcane-powered.com/`

The AppImage is a Tauri desktop application. Its frontend is embedded in the Rust binary, so exact CSS was recovered from the public site and binary strings rather than separate asset files.

## Observed save UX

### Version history
- Timeline ordered by date.
- Each entry shows timestamp, device name, size, file count, and change summary.
- Latest entry is visually marked.
- Restore action is available per version.
- Diff summary shows added/changed/removed files and byte deltas.

### Conflict resolution
- Modal dialog with two side-by-side options:
  - On this machine
  - In the cloud
- Each option shows timestamp, file count, size, and device.
- Actions:
  - Keep this one
  - Keep both
  - Decide later
- Copy that is not kept remains available in history or as a folder next to saves.

### Storage manager
- Drive cards with total/free space and usage bars.
- Nearly-full drive warnings.
- Per-game table:
  - game name
  - source
  - share of disk
  - size
  - last played
  - uninstall action
- Background measurement status.

### Smart exclusions
- Save folder path display.
- Total folder size vs backup size.
- Per-category rows:
  - saves
  - shader cache
  - screenshots
  - crash dumps
  - logs
- Tick/untick behavior.
- Explicit statement that nothing is deleted from the PC.

### Collections
- AND/OR match modes.
- Filters by source and sync status.
- Live match count.

### Emulator support
- Separate emulator sections.
- Save states and battery saves are tracked separately.
- Memory-card management for PS1/PS2.

## Dune adaptation

Dune should adapt these patterns to its existing dark launcher theme:
- Keep the sand accent (`--sand`) instead of Arcane's accent.
- Use Dune panels, cards, and table styles.
- Add a dedicated Saves tab with:
  - version timeline
  - conflict modal
  - storage manager
  - exclusion editor
- Keep all actions explicit and reversible where possible.
- Preserve offline-first and self-hosted behavior.

## Implemented in Dune so far
- `SaveVersionTimeline`
- `ConflictModal`
- `StorageManager`
- `ExclusionEditor`
- Save-related CSS classes in `packages/client/src/index.css`
- A new Saves tab in `packages/client/src/App.tsx`
