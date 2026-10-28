import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import type { Game } from '@dune/shared';
import { LAUNCH_FIELDS, createGameFromMetadata, mergeRendererGames, mergeServerGames, pickGameMetadata } from './launchFields.js';
import { launchGameById } from './byId.js';
import type { SpawnFn } from './manager.js';

// DUN-061: dune061-* mkdtemp folder + fake spawn only.
let tmp: string;
let exe: string;
const NOW = '2026-10-20T07:30:00.000Z';

function fakeSpawn() {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
    child.pid = 1;
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

function stored(): Game[] {
  return [
    {
      id: 11, name: 'Celeste', winPath: '', linPath: '/saves/celeste', lastSync: 'Never', status: 'In Sync', thumbnail: '',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      source: 'manual', executable: exe, tags: ['indie'],
    },
    {
      id: 12, name: 'Hollow Knight', winPath: '', linPath: '/saves/hk', lastSync: 'Never', status: 'Pending Upload', thumbnail: '',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      source: 'steam', sourceId: 'steam', steamAppId: '367520', installPath: '/games/hk',
    },
  ];
}

const forged = {
  executable: '/bin/evil',
  installPath: '/bin',
  emulator: '/bin/evil',
  romPath: '/etc/passwd',
  winePrefix: '/tmp/dune061-evil-prefix',
  managedPrefixId: 'evil',
  protonPath: '/tmp/dune061-evil-proton',
  steamAppId: '1; rm -rf ~',
  heroicId: '--evil',
  lutrisSlug: '../evil',
  source: 'emulator',
  sourceId: 'lutris',
  args: ['-c', 'touch /tmp/dune061-pwned'],
  env: { LD_PRELOAD: '/tmp/dune061-evil.so' },
  cwd: '/',
  status: 'In Sync',
  createdAt: '1999-01-01',
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dune061-'));
  exe = path.join(tmp, 'celeste.sh');
  fs.writeFileSync(exe, '#!/bin/sh\n');
});
afterAll(() => {
  if (tmp?.startsWith(path.join(os.tmpdir(), 'dune061-'))) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('DUN-061 launch fields are main-only', () => {
  it('a forged renderer save cannot change launch fields; launch uses the stored executable', async () => {
    const before = stored();
    const incoming = before.map((g) => ({ ...g, ...forged, name: `${g.name} (renamed)`, tags: ['edited'] }));
    const merged = mergeRendererGames(before, incoming, NOW);
    for (const [i, game] of merged.entries()) {
      for (const field of LAUNCH_FIELDS) expect(game[field]).toEqual(before[i][field]);
      expect(game).not.toHaveProperty('env');
      expect(game).not.toHaveProperty('args');
      expect(game).not.toHaveProperty('cwd');
      expect(game.status).toBe(before[i].status);
      expect(game.createdAt).toBe(before[i].createdAt);
      expect(game.name).toBe(`${before[i].name} (renamed)`);
      expect(game.tags).toEqual(['edited']);
      expect(game.updatedAt).toBe(NOW);
    }

    const fake = fakeSpawn();
    const result = await launchGameById(11, { getGames: () => merged, spawn: fake.spawn });
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe(exe);
    expect(fake.calls[0].args).toEqual([]);
    expect(fake.calls[0].env.LD_PRELOAD).not.toBe('/tmp/dune061-evil.so');
  });

  it('a server record with an injected executable / LD_PRELOAD changes nothing and launches nothing new', async () => {
    const before = stored();
    const serverList = [
      { id: 12, name: 'Hollow Knight', ...forged },
      // A server-only game (unknown id) can never be added this way.
      { id: 999, name: 'Evil', executable: '/bin/evil', env: { LD_PRELOAD: '/tmp/dune061-evil.so' } },
    ];
    const merged = mergeServerGames(before, serverList, NOW);
    expect(merged).toHaveLength(2);
    expect(merged.find((g) => g.id === 999)).toBeUndefined();
    const hk = merged.find((g) => g.id === 12)!;
    for (const field of LAUNCH_FIELDS) expect(hk[field]).toEqual(before[1][field]);
    expect(hk).not.toHaveProperty('env');
    // Server lists never remove local games.
    expect(merged.find((g) => g.id === 11)).toEqual(before[0]);

    const fake = fakeSpawn();
    const opened: string[] = [];
    const openExternal = async (url: string) => { opened.push(url); };
    expect(await launchGameById(999, { getGames: () => merged, spawn: fake.spawn, openExternal })).toEqual({ ok: false, reason: 'not-found' });
    expect(await launchGameById(12, { getGames: () => merged, spawn: fake.spawn, openExternal })).toEqual({ ok: true });
    expect(opened).toEqual(['steam://rungameid/367520']);
    expect(fake.calls).toEqual([]);
  });

  it('drops unknown ids from a renderer save and never removes stored games', () => {
    const before = stored();
    const merged = mergeRendererGames(before, [{ ...before[1] }, { id: 404, name: 'New', executable: '/bin/evil' }, { name: 'No id' }], NOW);
    expect(merged.map((g) => g.id)).toEqual([11, 12]);
    expect(merged[0]).toEqual(before[0]);
    // Even an empty list removes nothing.
    expect(mergeRendererGames(before, [], NOW)).toEqual(before);
  });

  it('a stale renderer save cannot drop a game the scanner added meanwhile', () => {
    const before = stored();
    const scannerAdded = { ...before[0], id: 13, name: 'Scanned', steamAppId: '570' };
    const merged = mergeRendererGames([...before, scannerAdded], before.map((g) => ({ ...g, name: g.name + ' (edited)' })), NOW);
    expect(merged.map((g) => g.id)).toEqual([11, 12, 13]);
    expect(merged[2]).toEqual(scannerAdded);
    expect(merged[0].name).toBe(before[0].name + ' (edited)');
  });

  it('keeps the stored game when an incoming record is malformed, and ignores duplicate ids', () => {
    const before = stored();
    const merged = mergeRendererGames(before, [{ id: 11, name: '' }, { id: 12, name: 'HK' }, { id: 12, name: 'Second' }], NOW);
    expect(merged[0]).toEqual(before[0]);
    expect(merged[1].name).toBe('HK');
    expect(mergeRendererGames(before, 'nope', NOW)).toEqual(before);
  });

  it('keeps scanner-written fields (scanner update, then a stale renderer save)', () => {
    const before = stored();
    // Scanner (main) updates the install path and Proton runtime.
    const scanned = before.map((g) => (g.id === 12 ? { ...g, installPath: '/games/hk-v2', protonPath: '/proton/9' } : g));
    // Renderer still holds the pre-scan copy.
    const merged = mergeRendererGames(scanned, before, NOW);
    expect(merged[1].installPath).toBe('/games/hk-v2');
    expect(merged[1].protonPath).toBe('/proton/9');
    // Unchanged metadata does not bump updatedAt.
    expect(merged[1].updatedAt).toBe(before[1].updatedAt);
  });

  it('pickGameMetadata / createGameFromMetadata read metadata only', () => {
    expect(pickGameMetadata({ name: '  X  ', ...forged, tags: ['a', 3, ''] })).toEqual({
      name: 'X', winPath: '', linPath: '', thumbnail: '', tags: ['a'],
    });
    expect(pickGameMetadata(null)).toBeNull();
    const game = createGameFromMetadata({ name: 'New', linPath: '/saves/new', ...forged }, 5, NOW)!;
    for (const field of LAUNCH_FIELDS) if (field !== 'source') expect(game[field]).toBeUndefined();
    expect(game).toMatchObject({ id: 5, name: 'New', linPath: '/saves/new', source: 'manual', status: 'Pending Upload', createdAt: NOW });
    expect(game).not.toHaveProperty('env');
  });
});
