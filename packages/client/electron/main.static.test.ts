import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// main.ts needs a running Electron, so these check its source for the wiring
// the batch relies on (the logic itself is unit-tested in its own modules).
const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');

describe('main.ts wiring', () => {
  it('DUN-030: no placeholder seed game; a fresh store has an empty library', () => {
    expect(main).not.toMatch(/Cyberpunk/);
    expect(main).toMatch(/games: \[\] as Game\[\]/);
  });

  it('DUN-121/068: no raw axios calls or draft-URL normalising; everything goes through serverClient', () => {
    expect(main).not.toMatch(/import axios|axios\.(get|post|put|delete|request)/);
    expect(main).not.toMatch(/normalizeUrl/);
    expect(main).not.toMatch(/store\.get\('cloud'\)\)?\.url|cloud\?\.url/);
    expect(main).toMatch(/baseUrl: \(\) => playtimeFlushGate\.savedUrl\(\)/);
  });

  it('DUN-071: sync/restore/test save only a validated { url }', () => {
    expect(main).not.toMatch(/store\.set\('cloud', credentials\)/);
    expect(main).toMatch(/store\.set\('cloud', \{ url \} satisfies Cloud\)/);
  });

  it('DUN-028: the updater never downloads or installs by itself', () => {
    expect(main).not.toMatch(/autoDownload\s*=\s*true/);
    expect(main).not.toMatch(/checkForUpdatesAndNotify/);
  });

  it('DUN-073: server-key:get never returns the key', () => {
    expect(main).toMatch(/ipcMain\.handle\('server-key:get', \(\) => serverKeyVault\.status\(\)\)/);
    expect(main).not.toMatch(/key: loadServerKey\(\)/);
  });

  it('DUN-077: ROMs are not scanned outside the emulator source', () => {
    expect(main).not.toMatch(/getEmulatorGames/);
  });

  it('DUN-084: the offline playtime queue is coalesced (not trimmed), never during a flush, and logged', () => {
    expect(main).toMatch(/enqueuePlaytimeSession\(pendingPlaytimeQueue\(\), session, \{ coalesce: !playtimeQueueFlushing \}\)/);
    expect(main).toMatch(/appendErrorLog\('playtime'/);
    expect(main).not.toMatch(/\.slice\(-MAX_PENDING_SESSIONS\)/);
  });

  it('every new IPC channel is both handled in main and exposed in preload', () => {
    for (const channel of ['saves:listFiles', 'prefix:discover', 'prefix:openDiscovered', 'scanner:getSources', 'scanner:setSource',
      'updates:status', 'updates:download', 'updates:install', 'steamGridKey:status', 'steamGridKey:set', 'steamGridKey:clear']) {
      expect(preload).toContain(`'${channel}'`);
    }
    for (const event of ['sync:auto', 'updates:status']) {
      expect(main).toContain(`'${event}'`);
      expect(preload).toContain(`'${event}'`);
    }
  });
});
