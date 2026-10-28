import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { Game } from '@dune/shared';

// Temp dirs and fakes only: never the real userData, Steam, Heroic or Lutris data, never the network.
vi.mock('electron', () => ({ app: { getPath: () => path.join(os.tmpdir(), 'dune-storeids-userdata-unused') } }));
vi.mock('axios', () => ({ default: { get: vi.fn(async () => { throw new Error('network disabled in tests'); }) } }));

import { backfillStoreIds, normalizeGameStoreIds, normalizeStoreId, STORE_ID_PATTERN, validStoreIds } from './storeIds.js';
import { createSaveResolver, type LudusaviManifest } from './savePaths.js';
import { dedupeGames } from './dedupe.js';
import { migrateGame, migrateStoredGames } from './migrateStore.js';
import { getHeroicGames, type HeroicConfig } from './heroic.js';
import { getLutrisGames } from './lutris.js';
import { fromLutris, lutrisStoreIds } from './registry.js';
import { getGogGames } from './external.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-storeids-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const ctx = () => ({ home, env: { USER: 'jane' } as NodeJS.ProcessEnv, platform: 'linux' as const });
const NOW = '2026-10-28T14:00:00.000Z';
function game(over: Partial<Game>): Game {
  return { id: 1, name: 'G', winPath: '', linPath: '', lastSync: 'Never', status: 'Pending Upload', thumbnail: '', createdAt: NOW, updatedAt: NOW, ...over };
}

describe('normalizeStoreId (server STORE_ID_PATTERN /^[1-9][0-9]{0,11}$/)', () => {
  it('keeps positive digit strings of 1-12 digits', () => {
    for (const ok of ['1', '620', '367520', '1308320804', '999999999999']) expect(normalizeStoreId(ok)).toBe(ok);
    expect(STORE_ID_PATTERN.source).toBe('^[1-9][0-9]{0,11}$');
  });

  it('anything else becomes null', () => {
    for (const bad of ['', '0', '0620', '1234567890123', ' 620', '620 ', 'abc', '-1', '1.5', '1e3', null, undefined, {}, [], true, NaN, -1, 0, 1.5, 2 ** 60]) {
      expect(normalizeStoreId(bad)).toBeNull();
    }
  });

  it('converts a safe positive integer (e.g. from a launcher DB) to its digit string', () => {
    expect(normalizeStoreId(1207658924)).toBe('1207658924');
  });

  it('validStoreIds / normalizeGameStoreIds', () => {
    expect(validStoreIds({ steamAppId: '620', gogId: 'x' })).toEqual({ steamAppId: '620' });
    expect(normalizeGameStoreIds(game({ steamAppId: '0620', gogId: '1' }))).toMatchObject({ steamAppId: null, gogId: '1' });
    const untouched = game({});
    expect(normalizeGameStoreIds(untouched)).toBe(untouched);
    expect(normalizeGameStoreIds(untouched)).not.toHaveProperty('steamAppId');
  });
});

describe('scanners fill steamAppId / gogId', () => {
  it('Heroic GOG entries get gogId from appName; Epic entries get none', () => {
    const config: HeroicConfig = {
      games: [
        { id: '1207658924', appName: '1207658924', title: 'GOG Game', platform: 'gog', installPath: path.join(home, 'g'), isInstalled: true },
        { id: 'gog-bad', appName: 'not-a-number', title: 'GOG Bad', platform: 'gog', installPath: path.join(home, 'b'), isInstalled: true },
        { id: 'Fortnite', appName: 'Fortnite', title: 'Epic Game', platform: 'epic', installPath: path.join(home, 'e'), isInstalled: true },
      ],
    };
    const [gog, bad, epic] = getHeroicGames(null, config);
    expect(gog.gogId).toBe('1207658924');
    expect(bad).not.toHaveProperty('gogId');
    expect(epic).not.toHaveProperty('gogId');
    expect(epic).not.toHaveProperty('steamAppId');
  });

  it('Lutris: service steam/gog ids from pga.db (temp, in-memory); older DBs without service columns still work', () => {
    const schema = (extra: string) => `CREATE TABLE games (id INTEGER, slug TEXT, name TEXT, year INTEGER, developer TEXT, publisher TEXT, genre TEXT, description TEXT,
      executable TEXT, wine_version TEXT, wine_arch TEXT, wine_prefix TEXT, executable_args TEXT, working_dir TEXT, env_vars TEXT,
      install_path TEXT, platform TEXT, system TEXT, emulator TEXT, runner TEXT, version TEXT, installed INTEGER, installed_size INTEGER,
      last_played INTEGER, playtime REAL, cover_url TEXT, banner_url TEXT, logo_url TEXT, icon_url TEXT, created_at INTEGER, updated_at INTEGER${extra})`;
    const db = new DatabaseSync(':memory:');
    db.exec(schema(', service TEXT, service_id TEXT'));
    const ins = db.prepare('INSERT INTO games (id, slug, name, runner, installed, service, service_id) VALUES (?, ?, ?, ?, 1, ?, ?)');
    ins.run(1, 'portal', 'Portal', 'steam', 'steam', '400');
    ins.run(2, 'witcher', 'The Witcher', 'wine', 'gog', '1207658924');
    ins.run(3, 'zero', 'Zero', 'wine', 'gog', '0123');
    ins.run(4, 'humble', 'Humble', 'wine', 'humblebundle', '555');
    const games = getLutrisGames(db).map((g) => fromLutris(g, null));
    expect(games.map((g) => [g.name, g.steamAppId, g.gogId]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ['Humble', undefined, undefined], ['Portal', '400', undefined], ['The Witcher', undefined, '1207658924'], ['Zero', undefined, undefined],
    ]);

    const old = new DatabaseSync(':memory:');
    old.exec(schema(''));
    old.prepare('INSERT INTO games (id, slug, name, runner, installed) VALUES (1, ?, ?, ?, 1)').run('portal', 'Portal', 'steam');
    const [g] = getLutrisGames(old).map((r) => fromLutris(r, null));
    expect(g.name).toBe('Portal');
    expect(g).not.toHaveProperty('steamAppId');
  });

  it('lutrisStoreIds: a Steam-runner game with no service still maps its id; numbers become digit strings', () => {
    expect(lutrisStoreIds({ runner: 'steam', service: null, service_id: 620 })).toEqual({ steamAppId: '620' });
    expect(lutrisStoreIds({ runner: 'wine', service: 'GOG', service_id: '1' })).toEqual({ gogId: '1' });
    expect(lutrisStoreIds({ runner: 'wine', service: 'steam', service_id: '' })).toEqual({});
  });

  it('GOG folder scanner reads the product id from goggame-<id>.info (temp folders)', () => {
    const root = path.join(home, 'GOG Games');
    for (const [dir, marker] of [['Celeste', 'goggame-1955430409.info'], ['Old', 'gog_game.info'], ['Bad', 'goggame-0.info']] as const) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, marker), '{}');
    }
    const byName = Object.fromEntries(getGogGames([root], null).map((g) => [g.name, g]));
    expect(byName.Celeste.gogId).toBe('1955430409');
    expect(byName.Old).not.toHaveProperty('gogId');
    expect(byName.Bad).not.toHaveProperty('gogId');
  });

  it('the save manifest is matched by Steam id, then GOG id, then name', () => {
    const save = path.join(home, '.local', 'share', 'celeste');
    fs.mkdirSync(save, { recursive: true });
    const manifest: LudusaviManifest = {
      'Celeste': { gog: { id: 1955430409 }, files: { '<home>/.local/share/celeste': { tags: ['save'], when: [{ os: 'linux' }] } } },
    };
    const r = createSaveResolver(manifest, ctx());
    expect(r.findEntry({ name: 'Renamed Locally', gogId: '1955430409' })?.name).toBe('Celeste');
    expect(r.findEntry({ name: 'Renamed Locally', gogId: '0' })).toBeNull();
    expect(r.findEntry({ name: 'Renamed Locally', steamAppId: null, gogId: null })).toBeNull();
    expect(r.resolve({ name: 'Renamed Locally', gogId: '1955430409' })).toBe(save);
  });
});

describe('ids survive the cross-source dedupe', () => {
  it('merges Steam + Heroic GOG + GOG folder entries and keeps both ids', () => {
    const steam = game({ id: 1, name: 'Celeste', source: 'steam', sourceId: 'steam', steamAppId: '504230', installPath: '/games/steam/Celeste' });
    const heroic = { ...game({ id: 2, name: 'Celeste', source: 'heroic', sourceId: 'heroic', gogId: '1955430409', installPath: '/games/heroic/Celeste' }), platform: 'gog' } as Game;
    const folder = game({ id: 3, name: 'Celeste', source: 'gog', sourceId: 'gog', gogId: '1955430409', installPath: '/games/gog/Celeste' });
    // The Steam entry has no shared key with the GOG ones except via a later one that carries both ids.
    const lutris = game({ id: 4, name: 'Celeste (Lutris)', source: 'lutris', sourceId: 'lutris', steamAppId: '504230', gogId: '1955430409' });
    const out = dedupeGames([folder, heroic, lutris, steam]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: 'steam', steamAppId: '504230', gogId: '1955430409' });
  });

  it('GOG id alone is a dedupe key; an invalid id never merges and never survives as a string', () => {
    const a = game({ id: 1, name: 'A', source: 'heroic', sourceId: 'heroic', gogId: '7' });
    const b = game({ id: 2, name: 'B', source: 'gog', sourceId: 'gog', gogId: '7' });
    expect(dedupeGames([a, b])).toHaveLength(1);
    const x = game({ id: 3, name: 'X', source: 'steam', sourceId: 'steam', steamAppId: '0' });
    const y = game({ id: 4, name: 'Y', source: 'lutris', sourceId: 'lutris', steamAppId: '0' });
    expect(dedupeGames([x, y])).toHaveLength(2);
    // A valid id from the other entry replaces an invalid one on the winner.
    const winner = game({ id: 5, name: 'Z', source: 'steam', sourceId: 'steam', steamAppId: 'abc', installPath: '/z' });
    const filler = game({ id: 6, name: 'Z2', source: 'lutris', sourceId: 'lutris', steamAppId: '620', installPath: '/z' });
    expect(dedupeGames([winner, filler])[0].steamAppId).toBe('620');
    const lone = game({ id: 7, name: 'L', source: 'steam', sourceId: 'steam', steamAppId: 'abc', installPath: '/l' });
    const other = game({ id: 8, name: 'L2', source: 'gog', sourceId: 'gog', installPath: '/l' });
    expect(dedupeGames([lone, other])[0].steamAppId).toBeNull();
  });
});

describe('ids survive the store migration', () => {
  const resolver = () => createSaveResolver({}, ctx());

  it('keeps valid steamAppId / gogId, nulls invalid ones, and fills a Steam id from the library', () => {
    const games = [
      game({ id: 1, name: 'Celeste', source: 'gog', sourceId: 'gog', gogId: '1955430409', steamAppId: null, installPath: '/g' }),
      game({ id: 2, name: 'Bad', source: 'heroic', sourceId: 'heroic', gogId: '0123', installPath: '/b' }),
      game({ id: 3, name: 'Portal', source: 'steam', sourceId: 'steam', installPath: '/p' }),
      game({ id: 4, name: 'Manual', source: 'manual', gogId: 'kept-as-is' }),
    ];
    const steamGames = [{ appId: '400', name: 'Portal', installDir: 'Portal', libraryPath: path.join(home, 'lib'), installPath: '/p' }];
    const { games: out } = migrateStoredGames(games, resolver(), { steamGames } as never);
    expect(out[0]).toMatchObject({ gogId: '1955430409', steamAppId: null });
    expect(out[1].gogId).toBeNull();
    expect(out[2].steamAppId).toBe('400');
    expect(out[3]).toBe(games[3]);
  });

  it('is idempotent with ids', () => {
    const g = game({ id: 1, name: 'Celeste', source: 'gog', sourceId: 'gog', gogId: '1955430409', installPath: '/g' });
    const once = migrateGame(g, resolver());
    expect(migrateGame(once, resolver())).toEqual(once);
  });
});

describe('backfillStoreIds (games:autodetect on already-stored games)', () => {
  it('fills missing or invalid ids by exact name, never overwrites a valid one', () => {
    const stored = [
      game({ id: 1, name: 'Celeste' }),
      game({ id: 2, name: 'Portal', steamAppId: '400' }),
      game({ id: 3, name: 'Hades', steamAppId: '0' }),
      game({ id: 4, name: 'Other' }),
    ];
    const scanned = [
      game({ id: 9, name: 'Celeste', gogId: '1955430409', steamAppId: '504230' }),
      game({ id: 10, name: 'Portal', steamAppId: '401', gogId: 'x' }),
      game({ id: 11, name: 'Hades', steamAppId: '1145360' }),
    ];
    const { games, changed } = backfillStoreIds(stored, scanned);
    expect(changed).toBe(2);
    expect(games[0]).toMatchObject({ id: 1, gogId: '1955430409', steamAppId: '504230' });
    expect(games[1]).toBe(stored[1]);
    expect(games[2]).toMatchObject({ id: 3, steamAppId: '1145360' });
    expect(games[3]).toBe(stored[3]);
  });
});
