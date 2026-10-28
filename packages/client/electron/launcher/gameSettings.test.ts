import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import type { Game, ManagedPrefix } from '@dune/shared';
import { createGameSettingsIpcHandlers, type GameSettingsDeps } from './gameSettings.js';
import { launchGameById } from './byId.js';
import type { SpawnFn } from './manager.js';

// DUN-061: dune061-* mkdtemp folders, a fake dialog and a fake spawn only.
let tmp: string;
let games: Game[];
let dialogResult: { canceled: boolean; filePaths: string[] };
let prefixes: ManagedPrefix[];
let ids: number;

function base(overrides: Partial<Game>): Game {
  return {
    id: 1, name: 'G', winPath: '', linPath: '', lastSync: 'Never', status: 'In Sync', thumbnail: '',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

function deps(extra: Partial<GameSettingsDeps> = {}): GameSettingsDeps {
  return {
    getGames: () => games,
    setGames: (next) => { games = next; },
    showOpenDialog: vi.fn(async () => dialogResult),
    listPrefixes: () => prefixes,
    nextId: () => ++ids,
    now: () => '2026-10-20T07:30:00.000Z',
    log: () => {},
    ...extra,
  };
}

function fakeSpawn() {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, env: options.env, cwd: options.cwd });
    const child = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
    child.pid = 2;
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dune061-'));
  ids = 100;
  prefixes = [];
  dialogResult = { canceled: true, filePaths: [] };
  games = [
    base({ id: 1, name: 'Manual', source: 'manual' }),
    base({ id: 2, name: 'ROM', source: 'emulator', romPath: path.join(tmp, 'old.nes') }),
  ];
});
afterEach(() => {
  if (tmp?.startsWith(path.join(os.tmpdir(), 'dune061-'))) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('DUN-061 game:add', () => {
  it('stores metadata only, ignores launch fields and returns the created game', async () => {
    const h = createGameSettingsIpcHandlers(deps());
    const result = await h.add({}, {
      name: 'New Game', linPath: '/saves/new',
      executable: '/bin/evil', emulator: '/bin/evil', romPath: '/etc/passwd', winePrefix: '/tmp/dune061-x',
      protonPath: '/x', steamAppId: '1', source: 'steam', env: { LD_PRELOAD: '/tmp/dune061-evil.so' }, args: ['-c'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.game.id).toBe(101);
    expect(result.game).toEqual({
      id: 101, name: 'New Game', winPath: '', linPath: '/saves/new', thumbnail: '', source: 'manual',
      lastSync: 'Never', status: 'Pending Upload', createdAt: '2026-10-20T07:30:00.000Z', updatedAt: '2026-10-20T07:30:00.000Z',
    });
    expect(result.games).toEqual(games);
    expect(games[games.length - 1]).toEqual(result.game);
  });

  it('rejects a payload without a title', async () => {
    const h = createGameSettingsIpcHandlers(deps());
    expect(await h.add({}, { executable: '/bin/evil' })).toEqual({ ok: false, reason: 'invalid' });
    expect(games).toHaveLength(2);
  });

  it('a just-added game is not launchable until a target is picked; cancel keeps it', async () => {
    const h = createGameSettingsIpcHandlers(deps());
    const added = await h.add({}, { name: 'Later' });
    if (!added.ok) throw new Error('add failed');
    expect(await launchGameById(added.game.id, { getGames: () => games })).toEqual({ ok: false, reason: 'not-launchable' });
    dialogResult = { canceled: true, filePaths: [] };
    expect(await h.pickLaunchTarget({}, added.game.id)).toEqual({ ok: false, reason: 'cancelled' });
    expect(games.find((g) => g.id === added.game.id)).toEqual(added.game);
  });
});

describe('DUN-061 game:pickLaunchTarget', () => {
  it('stores the picked regular file as executable, and launch then uses it', async () => {
    const exe = path.join(tmp, 'game.sh');
    fs.writeFileSync(exe, '#!/bin/sh\n');
    dialogResult = { canceled: false, filePaths: [exe] };
    const d = deps();
    const result = await createGameSettingsIpcHandlers(d).pickLaunchTarget({}, 1);
    expect(result).toMatchObject({ ok: true, game: { id: 1, executable: exe } });
    expect(games[0].executable).toBe(exe);
    expect(d.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openFile'] }));

    const fake = fakeSpawn();
    expect((await launchGameById(1, { getGames: () => games, spawn: fake.spawn })).ok).toBe(true);
    expect(fake.calls[0].command).toBe(exe);
  });

  it('stores the pick as romPath for an emulator game', async () => {
    const rom = path.join(tmp, 'new.nes');
    fs.writeFileSync(rom, 'rom');
    dialogResult = { canceled: false, filePaths: [rom] };
    const result = await createGameSettingsIpcHandlers(deps()).pickLaunchTarget({}, 2);
    expect(result).toMatchObject({ ok: true, game: { romPath: rom } });
    expect(games[1].executable).toBeUndefined();
  });

  it('rejects a directory, a missing file and a relative path', async () => {
    const h = createGameSettingsIpcHandlers(deps());
    for (const filePaths of [[tmp], [path.join(tmp, 'missing.exe')], ['relative/game.sh'], []]) {
      dialogResult = { canceled: false, filePaths };
      const expected = filePaths.length === 0 ? 'cancelled' : 'invalid';
      expect(await h.pickLaunchTarget({}, 1)).toEqual({ ok: false, reason: expected });
    }
    expect(games[0].executable).toBeUndefined();
  });

  it('returns not-found for an unknown id without opening the dialog', async () => {
    const d = deps();
    expect(await createGameSettingsIpcHandlers(d).pickLaunchTarget({}, 999)).toEqual({ ok: false, reason: 'not-found' });
    expect(await createGameSettingsIpcHandlers(d).pickLaunchTarget({}, '1')).toEqual({ ok: false, reason: 'not-found' });
    expect(d.showOpenDialog).not.toHaveBeenCalled();
  });

  it('returns error when the dialog fails', async () => {
    const d = deps({ showOpenDialog: async () => { throw new Error('no window'); } });
    expect(await createGameSettingsIpcHandlers(d).pickLaunchTarget({}, 1)).toEqual({ ok: false, reason: 'error' });
  });
});

describe('DUN-061 game:setPrefix (managed prefix id)', () => {
  it('accepts only a registry id and resolves it to the path at launch', async () => {
    const exe = path.join(tmp, 'Game.exe');
    fs.writeFileSync(exe, '');
    const prefixPath = path.join(tmp, 'prefixes', 'p1');
    prefixes = [{ id: 'p-1', name: 'p1', path: prefixPath, createdAt: '' }];
    games[0] = { ...games[0], executable: exe };
    const h = createGameSettingsIpcHandlers(deps());

    expect(await h.setPrefix({}, 1, '/tmp/dune061-evil-prefix')).toEqual({ ok: false, reason: 'prefix-not-found' });
    expect(await h.setPrefix({}, 1, 42)).toEqual({ ok: false, reason: 'prefix-not-found' });
    expect(await h.setPrefix({}, 999, 'p-1')).toEqual({ ok: false, reason: 'not-found' });
    expect(await h.setPrefix({}, 1, 'p-1')).toMatchObject({ ok: true, game: { managedPrefixId: 'p-1' } });
    expect(games[0]).not.toHaveProperty('winePrefix');

    const fake = fakeSpawn();
    const resolveManagedPrefix = (id: string) => prefixes.find((p) => p.id === id)?.path ?? null;
    expect((await launchGameById(1, { getGames: () => games, spawn: fake.spawn, resolveManagedPrefix })).ok).toBe(true);
    expect(fake.calls[0]).toMatchObject({ command: 'wine', args: [exe] });
    expect(fake.calls[0].env.WINEPREFIX).toBe(prefixPath);

    // Prefix deleted from the registry: not launchable rather than falling back.
    prefixes = [];
    expect(await launchGameById(1, { getGames: () => games, spawn: fake.spawn, resolveManagedPrefix })).toEqual({ ok: false, reason: 'not-launchable' });

    expect(await h.setPrefix({}, 1, null)).toMatchObject({ ok: true });
    expect(games[0]).not.toHaveProperty('managedPrefixId');
  });
});

describe('DUN-061 emulators', () => {
  it('lists known emulators by id and name', () => {
    const list = createGameSettingsIpcHandlers(deps()).listEmulators();
    expect(list).toContainEqual({ id: 'retroarch', name: 'RetroArch' });
    expect(list.every((e) => typeof e.id === 'string' && typeof e.name === 'string')).toBe(true);
  });

  it('setEmulator accepts only a known id, on emulator games only', async () => {
    const h = createGameSettingsIpcHandlers(deps());
    expect(await h.setEmulator({}, 2, '/bin/evil')).toEqual({ ok: false, reason: 'unknown-emulator' });
    expect(await h.setEmulator({}, 2, 'bash')).toEqual({ ok: false, reason: 'unknown-emulator' });
    expect(await h.setEmulator({}, 1, 'retroarch')).toEqual({ ok: false, reason: 'not-emulator' });
    expect(await h.setEmulator({}, 999, 'retroarch')).toEqual({ ok: false, reason: 'not-found' });
    expect(await h.setEmulator({}, 2, 'duckstation')).toMatchObject({ ok: true, game: { emulator: 'duckstation' } });
    expect(await h.setEmulator({}, 2, null)).toMatchObject({ ok: true });
    expect(games[1]).not.toHaveProperty('emulator');
  });

  it('a stored emulator that is not on the list is not-launchable', async () => {
    const rom = path.join(tmp, 'game.nes');
    fs.writeFileSync(rom, 'rom');
    games[1] = { ...games[1], romPath: rom, emulator: '/bin/evil' };
    const fake = fakeSpawn();
    expect(await launchGameById(2, { getGames: () => games, spawn: fake.spawn })).toEqual({ ok: false, reason: 'not-launchable' });
    games[1] = { ...games[1], emulator: 'retroarch' };
    // DUN-075: a fake cores folder with a NES core; RetroArch gets -L <core>.
    const coreLookup = { platform: 'linux' as const, dirs: ['/fake/cores'], isFile: (p: string) => p === '/fake/cores/mesen_libretro.so' };
    expect((await launchGameById(2, { getGames: () => games, spawn: fake.spawn, coreLookup })).ok).toBe(true);
    expect(fake.calls).toEqual([expect.objectContaining({ command: 'retroarch', args: ['-L', '/fake/cores/mesen_libretro.so', rom] })]);
  });
});

describe('game:remove(gameId) (follow-up a)', () => {
  it('removes only that id from the current store list', async () => {
    games = [base({ id: 1, name: 'A' }), base({ id: 2, name: 'B' }), base({ id: 3, name: 'Scanned' })];
    const h = createGameSettingsIpcHandlers(deps());
    const res = await h.remove({}, 2);
    expect(res).toEqual({ ok: true, games: [games[0], games[1]] });
    expect(games.map((g) => g.id)).toEqual([1, 3]);
  });

  it('rejects invalid ids and reports unknown ids without writing', async () => {
    games = [base({ id: 1 })];
    const setGames = vi.fn();
    const h = createGameSettingsIpcHandlers(deps({ setGames }));
    for (const bad of ['1', -1, 1.5, null, { id: 1 }]) expect(await h.remove({}, bad)).toEqual({ ok: false, reason: 'invalid' });
    expect(await h.remove({}, 99)).toEqual({ ok: false, reason: 'not-found' });
    expect(setGames).not.toHaveBeenCalled();
  });

  it('returns error when the store throws', async () => {
    const h = createGameSettingsIpcHandlers(deps({ getGames: () => { throw new Error('disk'); } }));
    expect(await h.remove({}, 1)).toEqual({ ok: false, reason: 'error' });
  });
});
