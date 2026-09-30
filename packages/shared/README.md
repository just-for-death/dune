# @dune/shared

**Shared TypeScript types for the Dune ecosystem** — single source of truth for client-server contracts.

## Overview

This package contains all shared TypeScript interfaces used by:
- **dune** (Electron + React client)
- **dune-server** (Express.js backend)

Eliminates type drift and duplication across the monorepo.

## Installation

```bash
# From npm (once published)
npm install @dune/shared

# Or local development
npm install ../dune-shared
```

## Usage

```typescript
import { 
  Game, 
  ElectronAPI, 
  PlaytimeSession, 
  HLTBTimes,
  Achievement,
  Settings 
} from '@dune/shared';

// Client (Electron preload)
contextBridge.exposeInMainWorld('electronAPI', {
  getPlaytimeSummary: (game?: string) => 
    ipcRenderer.invoke('playtime:summary', game),
  // ... fully typed
});

// Server (Express routes)
app.get('/api/playtime', (req, res) => {
  const summary: PlaytimeSummary[] = getPlaytimeSummary();
  res.json({ success: true, summary });
});
```

## Types Included

| Category | Types |
|----------|-------|
| **Core** | `Game`, `GameFile`, `Version`, `FileAnalysis` |
| **Settings** | `Settings`, `LocalSource`, `RemoteServer`, `Cloud` |
| **Playtime** | `PlaytimeSession`, `PlaytimeSummary` |
| **Achievements** | `Achievement`, `AchievementSummary` |
| **HLTB** | `HLTBTimes` |
| **AI** | `FileAnalysis` |
| **IPC Contract** | `ElectronAPI` (complete client↔server API) |
| **Utilities** | `APIResponse`, `SyncProgress`, `HealthStatus`, `UploadHeaders` |

## Development

```bash
# Install deps
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## Publishing

```bash
npm version patch|minor|major
npm publish --access public
```

## License

MIT
