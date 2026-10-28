import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Game, ServerResult } from '@dune/shared';
import type { ManifestGame, ManifestMatch, ProviderResult } from '@dune/providers';

// Temp dirs and fakes only: a fake home, install folder and Proton prefix; never real saves or the network.
vi.mock('electron', () => ({ app: { getPath: () => path.join(os.tmpdir(), 'dune-manifest-userdata-unused') } }));

import { buildExpandContext, confinePath, expandManifestFiles, gamePrefix, protonPrefixFor, rootsOf, type ExpandContext } from './expand';
import { createManifestSuggestions, type ManifestSuggestionsDeps } from './suggestions';
import { setGameSavePath } from './savePath';

let tmp: string; let home: string; let lib: string; let install: string; let prefix: string; let outside: string;
const NOW = '2026-10-28T14:30:00.000Z';
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dune-manifest-')));
  home = path.join(tmp, 'home'); lib = path.join(tmp, 'lib'); outside = path.join(tmp, 'outside');
  install = path.join(lib, 'steamapps', 'common', 'Celeste');
  prefix = path.join(lib, 'steamapps', 'compatdata', '504230', 'pfx');
  for (const d of [home, install, outside, path.join(prefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Celeste')]) fs.mkdirSync(d, { recursive: true });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const game = (over: Partial<Game> = {}): Game => ({ id: 7, name: 'Celeste', winPath: '', linPath: '', lastSync: 'Never', status: 'Pending Upload', thumbnail: '', createdAt: NOW, updatedAt: NOW, source: 'steam', steamAppId: '504230', installPath: install, ...over });
const ctxOf = (g: Game = game()): ExpandContext => buildExpandContext(g, { home, userName: 'jane', env: {} });
const files = (f: Record<string, unknown>) => f as NonNullable<ManifestGame['files']>;
const snapshot = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).sort();

describe('expand: placeholders, prefix, confinement', () => {
  it('Proton prefix: derived from the Steam install path; managed prefix and winePrefix win', () => {
    expect(protonPrefixFor(install, '504230')).toBe(prefix);
    expect(protonPrefixFor(install, '0504230')).toBeNull();
    expect(protonPrefixFor(path.join(tmp, 'games', 'Celeste'), '504230')).toBeNull();
    expect(gamePrefix(game({ winePrefix: '/w/pfx' }))).toBe('/w/pfx');
    expect(gamePrefix(game({ managedPrefixId: 'p1' }), () => '/m/pfx')).toBe('/m/pfx');
    expect(gamePrefix(game({ managedPrefixId: 'p1' }), () => null)).toBeNull();
  });

  it('expands native and Proton paths; exists true/false by stat; dedupes; never writes', () => {
    fs.mkdirSync(path.join(home, '.local', 'share', 'Celeste'), { recursive: true });
    const before = snapshot(tmp);
    const out = expandManifestFiles(files({
      '<xdgData>/Celeste': { tags: ['save'], when: [{ os: 'linux' }] },
      '<home>/.config/Celeste': { tags: ['config'] },
      '<winAppData>/Celeste': { tags: ['save'], when: [{ os: 'windows' }] },
      '<winDocuments>/My Games/Celeste': { tags: ['save'] },
      '<base>/Saves': { tags: ['save'] },
      '<home>/.local/share/Celeste': { tags: ['config'] },
    }), ctxOf());
    const steamuser = path.join(prefix, 'drive_c', 'users', 'steamuser');
    const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
    expect([...out].sort(byPath)).toEqual([
      { path: path.join(home, '.local', 'share', 'Celeste'), kind: 'save', exists: true },
      { path: path.join(steamuser, 'AppData', 'Roaming', 'Celeste'), kind: 'save', exists: true },
      { path: path.join(steamuser, 'Documents', 'My Games', 'Celeste'), kind: 'save', exists: false },
      { path: path.join(install, 'Saves'), kind: 'save', exists: false },
      { path: path.join(steamuser, '.config', 'Celeste'), kind: 'config', exists: false },
      { path: path.join(steamuser, '.local', 'share', 'Celeste'), kind: 'config', exists: false },
      { path: path.join(home, '.config', 'Celeste'), kind: 'config', exists: false },
    ].sort(byPath));
    const rank = (x: { exists: boolean; kind: string }) => (x.exists ? 0 : 2) + (x.kind === 'save' ? 0 : 1);
    expect(out.map(rank)).toEqual(out.map(rank).sort((a, b) => a - b));
    expect(snapshot(tmp)).toEqual(before);
  });

  it('rejects .. escapes, symlinks out of the roots, dangling links, unsafe globs and unknown placeholders', () => {
    fs.symlinkSync(outside, path.join(home, 'escape'));
    fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(home, 'dangling'));
    fs.mkdirSync(path.join(home, 'real'));
    fs.symlinkSync(path.join(home, 'real'), path.join(home, 'inner'));
    const out = expandManifestFiles(files({
      '<home>/../outside/x': {}, '<base>/../../../../outside': {}, '<home>/escape/save': {}, '<home>/dangling/save': {},
      '<home>/**/save': {}, '<home>/[ab]/save': {}, '<regHkcu>/x': {}, 'C:/Games/x': {}, '/etc/passwd': {}, '<home>': {},
      '<winAppData>/native-only': { when: [{ os: 'linux' }] }, '<home>/inner/save': {},
    }), ctxOf(game({ steamAppId: null, installPath: undefined })));
    expect(out.map((s) => s.path)).toEqual([path.join(home, 'real', 'save')]);
    const roots = rootsOf({ home });
    expect(confinePath(`${home}/a/../../outside`, roots)).toEqual({ ok: false, reason: 'dot-dot' });
    expect(confinePath(path.join(home, 'escape', 'x'), roots)).toEqual({ ok: false, reason: 'symlink-escape' });
    expect(confinePath(outside, roots)).toEqual({ ok: false, reason: 'outside-roots' });
  });

  it('<storeUserId> globs list only directories inside the roots', () => {
    const userdata = path.join(home, '.local', 'share', 'Steam', 'userdata');
    for (const u of ['111', '222']) fs.mkdirSync(path.join(userdata, u, '504230', 'remote'), { recursive: true });
    fs.mkdirSync(path.join(outside, '333'), { recursive: true });
    fs.symlinkSync(outside, path.join(userdata, 'link'));
    const out = expandManifestFiles(files({ '<home>/.local/share/Steam/userdata/<storeUserId>/<storeGameId>/remote': { tags: ['save'] } }), ctxOf());
    expect(out.map((s) => s.path).sort()).toEqual(['111', '222'].map((u) => path.join(userdata, u, '504230', 'remote')));
  });
});

describe('getManifestSuggestions routing', () => {
  const entry = { title: 'Celeste', files: { '<base>/Saves': { tags: ['save'] } } };
  const match: ManifestMatch = { title: 'Celeste', game: { files: files({ '<home>/.celeste': { tags: ['save'], when: [{ os: 'linux' }] } }) } as ManifestGame, pageUrl: 'https://www.pcgamingwiki.com/wiki/Celeste', attribution: { text: 'Local attribution', url: '', license: '', licenseUrl: '', manifestUrl: '' } };
  type Call = { method: string; path: string };
  function setup(opts: { server?: boolean; enabled?: boolean; responses?: Record<string, ServerResult<Record<string, unknown>>>; local?: ProviderResult<ManifestMatch> } = {}) {
    const calls: Call[] = [];
    const localLookup = vi.fn(async () => opts.local ?? ({ ok: true, value: match } as ProviderResult<ManifestMatch>));
    const findGame = vi.fn(async (id: number) => (id === 7 ? game() : null));
    const deps: ManifestSuggestionsDeps = {
      client: {
        baseUrl: () => (opts.server === false ? null : 'http://dune.test'),
        call: (async (req: Call) => { calls.push({ method: req.method, path: req.path }); return opts.responses?.[req.path] ?? { ok: false, code: 'NETWORK', message: 'down' }; }) as never,
      },
      localEnabled: () => opts.enabled === true,
      localLookup,
      findGame,
      expandContext: (g) => ctxOf(g),
    };
    return { run: createManifestSuggestions(deps), calls, localLookup, findGame };
  }
  const saves = { ok: true, games: [{ id: 41, name: 'celeste' }] } as ServerResult<Record<string, unknown>>;

  it('server ok: maps the game to the server id by name, expands the entry, no local lookup', async () => {
    const s = setup({ enabled: true, responses: { '/api/saves': saves, '/api/manifest/41': { ok: true, entry, pageUrl: 'https://www.pcgamingwiki.com/wiki/Celeste', attribution: { text: 'Server attribution' }, stale: true } } });
    expect(await s.run('7')).toEqual({ ok: true, suggestions: [{ path: path.join(install, 'Saves'), kind: 'save', exists: false }], attribution: 'Server attribution', pageUrl: 'https://www.pcgamingwiki.com/wiki/Celeste', stale: true });
    expect(s.calls.map((c) => c.path)).toEqual(['/api/saves', '/api/manifest/41']);
    expect(s.localLookup).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'PROVIDER_DISABLED'], [401, 'UNAUTHORIZED'], [404, 'MANIFEST_NOT_FOUND'], [503, 'MANIFEST_UNAVAILABLE'],
  ])('server %i %s passes through, never falls back', async (status, code) => {
    const failure = { ok: false, status, code, message: 'server says no' } as const;
    const s = setup({ enabled: true, responses: { '/api/saves': saves, '/api/manifest/41': failure } });
    expect(await s.run('7')).toEqual(failure);
    expect(s.localLookup).not.toHaveBeenCalled();
  });

  it('a game not on the server is a 404 GAME_NOT_FOUND, no fallback; a bad entry or page URL is refused', async () => {
    const s = setup({ enabled: true, responses: { '/api/saves': { ok: true, games: [{ id: 1, name: 'Other' }] } } });
    expect(await s.run('7')).toMatchObject({ ok: false, status: 404, code: 'GAME_NOT_FOUND' });
    const bad = setup({ responses: { '/api/saves': saves, '/api/manifest/41': { ok: true, entry: { files: 'nope' } } } });
    expect(await bad.run('7')).toMatchObject({ ok: false, code: 'MANIFEST_BAD_RESPONSE' });
    const evil = setup({ responses: { '/api/saves': saves, '/api/manifest/41': { ok: true, entry, pageUrl: 'https://evil.example/wiki/x' } } });
    expect(await evil.run('7')).toMatchObject({ ok: true, pageUrl: null });
  });

  it('unreachable server (NETWORK, no status) falls back to local when the local flag is on', async () => {
    const s = setup({ enabled: true });
    expect(await s.run('7')).toMatchObject({ ok: true, attribution: 'Local attribution', suggestions: [{ path: path.join(home, '.celeste'), kind: 'save', exists: false }] });
    expect(s.localLookup).toHaveBeenCalledWith({ title: 'Celeste', steamId: 504230 });
    const mid = setup({ enabled: true, responses: { '/api/saves': saves } });
    expect(await mid.run('7')).toMatchObject({ ok: true, attribution: 'Local attribution' });
    const off = setup({ enabled: false });
    expect(await off.run('7')).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
    expect(off.localLookup).not.toHaveBeenCalled();
  });

  it('no server and the flag off: PROVIDER_DISABLED with no I/O', async () => {
    const s = setup({ server: false, enabled: false });
    expect(await s.run('7')).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
    expect(s.calls).toEqual([]);
    expect(s.findGame).not.toHaveBeenCalled();
    expect(s.localLookup).not.toHaveBeenCalled();
  });

  it('no server, flag on: local result codes; bad and unknown ids', async () => {
    expect(await setup({ server: false, enabled: true, local: { ok: false, code: 'PROVIDER_NOT_FOUND', message: 'x' } as ProviderResult<ManifestMatch> }).run('7')).toMatchObject({ ok: false, code: 'MANIFEST_NOT_FOUND' });
    expect(await setup({ server: false, enabled: true, local: { ok: false, code: 'PROVIDER_TIMEOUT', message: 'x' } as ProviderResult<ManifestMatch> }).run('7')).toMatchObject({ ok: false, code: 'MANIFEST_UNAVAILABLE' });
    expect(await setup({ server: false, enabled: true }).run('07')).toMatchObject({ ok: false, code: 'INVALID_GAME_ID' });
    expect(await setup({ server: false, enabled: true }).run('8')).toMatchObject({ ok: false, code: 'GAME_NOT_FOUND' });
  });
});

describe('setSavePath', () => {
  function setup(platform: NodeJS.Platform = 'linux') {
    let games = [game(), game({ id: 8, name: 'Other', linPath: '/keep' })];
    const setGames = vi.fn((g: Game[]) => { games = g; });
    const run = (id: unknown, p: unknown) => setGameSavePath({ getGames: () => games, setGames, expandContext: (g) => ctxOf(g), platform, now: () => NOW }, id, p);
    return { run, setGames, get games() { return games; } };
  }

  it('sets only linPath for a path inside home, installPath or the prefix (resolved), without touching disk', async () => {
    const s = setup();
    const before = snapshot(tmp);
    const inPrefix = path.join(prefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Celeste');
    for (const p of [path.join(home, '.local', 'share', 'Celeste'), path.join(install, 'Saves'), inPrefix]) {
      expect(await s.run(7, p)).toMatchObject({ ok: true, game: { id: 7, linPath: p, winPath: '', updatedAt: NOW } });
    }
    expect(s.games[1].linPath).toBe('/keep');
    expect(snapshot(tmp)).toEqual(before);
    expect(await setup('win32').run(7, path.join(home, 'S'))).toMatchObject({ ok: true, game: { winPath: path.join(home, 'S'), linPath: '' } });
  });

  it('rejects bad input with an error code and stores nothing', async () => {
    fs.symlinkSync(outside, path.join(home, 'escape'));
    const s = setup();
    const cases: [unknown, unknown, string][] = [
      ['7', path.join(home, 'x'), 'INVALID_GAME_ID'], [0, path.join(home, 'x'), 'INVALID_GAME_ID'], [99, path.join(home, 'x'), 'GAME_NOT_FOUND'],
      [7, '', 'INVALID_SAVE_PATH'], [7, 42, 'INVALID_SAVE_PATH'], [7, 'relative/x', 'INVALID_SAVE_PATH'], [7, '~/x', 'INVALID_SAVE_PATH'],
      [7, '<home>/x', 'INVALID_SAVE_PATH'], [7, path.join(home, '*'), 'INVALID_SAVE_PATH'], [7, `${home}/a\u0000b`, 'INVALID_SAVE_PATH'],
      [7, `${home}/../outside`, 'SAVE_PATH_ESCAPE'], [7, path.join(home, 'escape', 'save'), 'SAVE_PATH_ESCAPE'],
      [7, outside, 'SAVE_PATH_OUTSIDE_ROOTS'], [7, home, 'SAVE_PATH_OUTSIDE_ROOTS'], [7, '/etc', 'SAVE_PATH_OUTSIDE_ROOTS'],
    ];
    for (const [id, p, code] of cases) expect(await s.run(id, p), String(p)).toMatchObject({ ok: false, code });
    expect(s.setGames).not.toHaveBeenCalled();
  });
});
