import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import type { Game } from '@dune/shared';
import { createLaunchIpcHandlers, getLaunchCommandById, launchGameById, parseGameId, type LaunchByIdDeps } from './byId.js';
import type { SpawnFn } from './manager.js';

// DUN-061: every test uses a dune061-* mkdtemp folder and a fake spawn. No
// real game, prefix or Steam file is touched and nothing is executed.
let tmp: string;
let nativeExe: string;
let wineExe: string;
let prefix: string;

type SpawnCall = { command: string; args: readonly string[]; options: Parameters<SpawnFn>[2] };

function fakeSpawn(mode: 'spawn' | 'enoent' | 'exit' = 'spawn') {
  const calls: SpawnCall[] = [];
  const fn = vi.fn<SpawnFn>((command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
    child.pid = 4242;
    child.unref = () => {};
    setImmediate(() => {
      if (mode === 'enoent') {
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        return;
      }
      child.emit('spawn');
      if (mode === 'exit') setImmediate(() => child.emit('exit', 0));
    });
    return child as unknown as ChildProcess;
  });
  return { fn, calls };
}

function game(overrides: Partial<Game>): Game {
  return {
    id: 1,
    name: 'Game',
    winPath: '',
    linPath: '',
    lastSync: 'Never',
    status: 'In Sync',
    thumbnail: '',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

let registry: Game[];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dune061-'));
  nativeExe = path.join(tmp, 'native', 'game.sh');
  wineExe = path.join(tmp, 'wine', 'Game.exe');
  prefix = path.join(tmp, 'prefix');
  fs.mkdirSync(path.dirname(nativeExe), { recursive: true });
  fs.mkdirSync(path.dirname(wineExe), { recursive: true });
  fs.mkdirSync(prefix);
  fs.writeFileSync(nativeExe, '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(wineExe, '');
  registry = [
    game({ id: 101, name: 'Native', source: 'manual', executable: nativeExe }),
    game({ id: 102, name: 'Wine', source: 'manual', executable: wineExe, winePrefix: prefix }),
    game({ id: 103, name: 'Steam', source: 'steam', steamAppId: '620' }),
    game({ id: 104, name: 'No target', source: 'manual' }),
    game({ id: 105, name: 'Bad Steam id', source: 'steam', steamAppId: '620; touch /tmp/dune061-pwned' }),
    game({ id: 106, name: 'Bad Heroic id', source: 'heroic', heroicId: '--no-sandbox' }),
    game({ id: 107, name: 'Bad Lutris slug', source: 'lutris', lutrisSlug: '../../evil' }),
  ];
});

afterAll(() => {
  if (tmp?.startsWith(path.join(os.tmpdir(), 'dune061-'))) fs.rmSync(tmp, { recursive: true, force: true });
});

function deps(extra: Partial<LaunchByIdDeps> = {}): LaunchByIdDeps {
  return { getGames: () => registry, ...extra };
}

describe('DUN-061 launch by game id', () => {
  it('launches a known id with the registry executable', async () => {
    const spawn = fakeSpawn();
    const result = await launchGameById(101, deps({ spawn: spawn.fn }));
    expect(result).toEqual({ ok: true, pid: 4242 });
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].command).toBe(nativeExe);
    expect(spawn.calls[0].args).toEqual([]);
  });

  it('returns not-found for an unknown id and never spawns', async () => {
    const spawn = fakeSpawn();
    expect(await launchGameById(999, deps({ spawn: spawn.fn }))).toEqual({ ok: false, reason: 'not-found' });
    expect(spawn.fn).not.toHaveBeenCalled();
  });

  it('accepts only a game id: Game objects, strings and other values are not-found', async () => {
    const spawn = fakeSpawn();
    const handlers = createLaunchIpcHandlers(deps({ spawn: spawn.fn }));
    const forged = { ...registry[0], executable: '/bin/sh', env: { LD_PRELOAD: '/tmp/dune061-evil.so' } };
    for (const bad of [forged, '101', 101.5, -101, 0, NaN, null, undefined, [101], { id: 101 }]) {
      expect(await handlers.launch({}, bad)).toEqual({ ok: false, reason: 'not-found' });
    }
    expect(spawn.fn).not.toHaveBeenCalled();
    expect(parseGameId(101)).toBe(101);
  });

  it('drops renderer-supplied path, args, cwd, env and prefix (extra IPC args)', async () => {
    const spawn = fakeSpawn();
    const handlers = createLaunchIpcHandlers(deps({ spawn: spawn.fn }));
    const evil = {
      executable: '/bin/sh',
      command: '/bin/sh',
      args: ['-c', 'touch /tmp/dune061-pwned'],
      cwd: '/',
      env: { LD_PRELOAD: '/tmp/dune061-evil.so', PATH: '/tmp/dune061-evil' },
      winePrefix: '/tmp/dune061-evil-prefix',
      protonPath: '/tmp/dune061-evil-proton',
      useUmu: true,
      appId: '1',
    };
    const launch = handlers.launch as unknown as (...a: unknown[]) => ReturnType<typeof handlers.launch>;
    const result = await launch({}, 102, evil, { LD_PRELOAD: '/tmp/dune061-evil.so' });
    expect(result.ok).toBe(true);
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    expect(call.command).toBe('wine');
    expect(call.args).toEqual([wineExe]);
    expect(call.options.cwd).toBe(path.dirname(wineExe));
    expect(call.options.env.WINEPREFIX).toBe(prefix);
    expect(call.options.env.PROTONPATH).toBe(process.env.PROTONPATH);
    expect(call.options.env.LD_PRELOAD).toBe(process.env.LD_PRELOAD);
    expect(call.options.env.LD_PRELOAD).not.toBe('/tmp/dune061-evil.so');
    expect(call.options.env.PATH).toBe(process.env.PATH);
  });

  it('filters stored per-game env through the allow-list', async () => {
    const spawn = fakeSpawn();
    const getGameEnv = () => ({
      WINEDEBUG: '-all',
      DXVK_HUD: 'fps',
      LD_PRELOAD: '/tmp/dune061-evil.so',
      NODE_OPTIONS: '--require /tmp/dune061-evil.js',
      PATH: '/tmp/dune061-evil',
      WINEPREFIX: '/tmp/dune061-evil-prefix',
    });
    const result = await launchGameById(102, deps({ spawn: spawn.fn, getGameEnv }));
    expect(result.ok).toBe(true);
    const env = spawn.calls[0].options.env;
    expect(env.WINEDEBUG).toBe('-all');
    expect(env.DXVK_HUD).toBe('fps');
    expect(env.WINEPREFIX).toBe(prefix);
    expect(env.LD_PRELOAD).not.toBe('/tmp/dune061-evil.so');
    expect(env.NODE_OPTIONS).toBe(process.env.NODE_OPTIONS);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('opens Steam only with a numeric app id, via openExternal (DUN-074)', async () => {
    const spawn = fakeSpawn();
    const opened: string[] = [];
    expect(await launchGameById(103, deps({ spawn: spawn.fn, openExternal: async (url) => { opened.push(url); } }))).toEqual({ ok: true });
    expect(opened).toEqual(['steam://rungameid/620']);
    expect(spawn.fn).not.toHaveBeenCalled();
    expect(await getLaunchCommandById(103, deps())).toEqual({ ok: true, command: { url: 'steam://rungameid/620' } });
  });

  it('returns not-launchable for stored games without a valid target', async () => {
    const spawn = fakeSpawn();
    for (const id of [104, 105, 106, 107]) {
      expect(await launchGameById(id, deps({ spawn: spawn.fn }))).toEqual({ ok: false, reason: 'not-launchable' });
    }
    expect(spawn.fn).not.toHaveBeenCalled();
  });

  it('returns a typed error when spawn fails or the store throws', async () => {
    const spawn = fakeSpawn('enoent');
    const result = await launchGameById(101, deps({ spawn: spawn.fn }));
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    const broken = await launchGameById(101, { getGames: () => { throw new Error('store unavailable'); } });
    expect(broken).toEqual({ ok: false, reason: 'error', message: 'store unavailable' });
  });

  it('reports exit with the stored game for playtime tracking', async () => {
    const spawn = fakeSpawn('exit');
    const exited = new Promise<Game>((resolve) => {
      void launchGameById(101, deps({ spawn: spawn.fn, onExit: (g) => resolve(g) }));
    });
    expect((await exited).name).toBe('Native');
  });

  it('never uses a shell: argv array and shell:false on every spawn', async () => {
    const spawn = fakeSpawn();
    // 103 (Steam) opens a URL via openExternal (DUN-074) and spawns nothing.
    for (const id of [101, 102, 103]) await launchGameById(id, deps({ spawn: spawn.fn, openExternal: async () => {} }));
    expect(spawn.calls).toHaveLength(2);
    for (const call of spawn.calls) {
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.options.shell).toBe(false);
    }
  });

  it('has no exec / shell:true in the launch path source', () => {
    const files = [
      'byId.ts', 'manager.ts',
      ...fs.readdirSync(path.join(__dirname, 'strategies')).filter((f) => f.endsWith('.ts')).map((f) => path.join('strategies', f)),
    ];
    for (const file of files) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(src, file).not.toMatch(/\bexec(File)?(Sync)?\s*\(|shell:\s*true|execSync|spawnSync/);
    }
  });

  it('previews the registry command by id and ignores extra args', async () => {
    const handlers = createLaunchIpcHandlers(deps());
    const preview = handlers.launchCommand as unknown as (...a: unknown[]) => ReturnType<typeof handlers.launchCommand>;
    expect(await preview({}, 101, { executable: '/bin/sh' })).toEqual({
      ok: true,
      command: { command: nativeExe, args: [], cwd: undefined },
    });
    expect(await preview({}, 999)).toEqual({ ok: false, reason: 'not-found' });
  });
});
