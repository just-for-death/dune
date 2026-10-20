import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { Game } from '@dune/shared';

// Fakes: no real userData, no network. HOME is redirected to a temp dir below so
// Steam/Heroic/Lutris detection only ever sees fake data.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(os.tmpdir(), `dune-registry-test-${name}-unused`) },
}));
vi.mock('axios', () => ({ default: { get: vi.fn(async () => { throw new Error('network disabled in tests'); }) } }));

import { fullScan, scanSource, setSourceEnabled, getSources } from './registry.js';
import { dedupeGames } from './dedupe.js';
import { autoDetectGames as legacyAutoDetect } from '../scanner.js';
import { createSaveResolver, parseManifest } from './savePaths.js';

const realHome = os.homedir();
const savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, GOG_GAMES_ROOTS: process.env.GOG_GAMES_ROOTS };
let home = '';
let steamRoot = '';
let lib2 = '';
let cacheDir = '';

const mkdir = (...p: string[]) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };

const MANIFEST_YAML = `
Hollow Knight:
  steam:
    id: 367520
  files:
    "<home>/.config/unity3d/Team Cherry/Hollow Knight":
      tags: [save]
Portal 2:
  steam:
    id: 620
  files:
    "<winAppData>/Portal2Saves":
      tags: [save]
Unrelated Game:
  files:
    "<home>/.local/share/Unrelated":
      tags: [save]
Heroic Game:
  files:
    "<base>/Saves":
      tags: [save]
Lutris Game:
  files:
    "<winDocuments>/LutrisGame":
      tags: [save]
GOG Game:
  files:
    "<home>/.local/share/GOGGame":
      tags: [save]
`;

function acf(appId: string, name: string, installdir: string) {
  return `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${installdir}"\n}\n`;
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-registry-home-'));
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  expect(os.homedir()).toBe(home);
  expect(os.homedir()).not.toBe(realHome);

  // Steam: two libraries, one game each.
  steamRoot = mkdir(home, '.local', 'share', 'Steam');
  lib2 = mkdir(home, 'SteamLib2');
  mkdir(steamRoot, 'steamapps', 'common', 'Hollow Knight');
  mkdir(lib2, 'steamapps', 'common', 'Portal 2');
  fs.writeFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steamRoot}"\n\t\t"apps"\n\t\t{\n\t\t\t"367520"\t\t"1"\n\t\t}\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib2}"\n\t}\n}\n`);
  fs.writeFileSync(path.join(steamRoot, 'steamapps', 'appmanifest_367520.acf'), acf('367520', 'Hollow Knight', 'Hollow Knight'));
  fs.writeFileSync(path.join(lib2, 'steamapps', 'appmanifest_620.acf'), acf('620', 'Portal 2', 'Portal 2'));
  mkdir(home, '.config', 'unity3d', 'Team Cherry', 'Hollow Knight');
  mkdir(lib2, 'steamapps', 'compatdata', '620', 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Portal2Saves');
  // A manifest game with saves on disk that is NOT in the Steam library.
  mkdir(home, '.local', 'share', 'Unrelated');

  // Heroic
  const heroicInstall = mkdir(home, 'Games', 'Heroic', 'Heroic Game');
  mkdir(heroicInstall, 'Saves');
  const heroicGogInstall = mkdir(home, 'Games', 'Heroic', 'GOG Game');
  mkdir(home, '.local', 'share', 'GOGGame');
  mkdir(home, '.config', 'heroic');
  fs.writeFileSync(path.join(home, '.config', 'heroic', 'config.json'), JSON.stringify({
    games: [
      { id: 'heroic-1', title: 'Heroic Game', appName: 'heroic-1', platform: 'epic', installPath: heroicInstall, installPathLinux: heroicInstall, installPathWindows: 'C:\\Games\\Heroic Game', isInstalled: true, executable: 'game.exe' },
      { id: 'heroic-gog', title: 'GOG Game', appName: 'heroic-gog', platform: 'gog', installPath: heroicGogInstall, isInstalled: true },
      { id: 'heroic-2', title: 'Not Installed', appName: 'x', platform: 'epic', installPath: '/nope', isInstalled: false },
    ],
  }));

  // Lutris
  const lutrisDir = mkdir(home, '.local', 'share', 'lutris');
  const lutrisInstall = mkdir(home, 'Games', 'lutris-game');
  const lutrisPrefix = mkdir(home, 'Games', 'lutris-game', 'prefix');
  mkdir(lutrisPrefix, 'drive_c', 'users', 'lutrisuser', 'Documents', 'LutrisGame');
  const db = new DatabaseSync(path.join(lutrisDir, 'pga.db'));
  db.exec(`CREATE TABLE games (id INTEGER, slug TEXT, name TEXT, year INTEGER, developer TEXT, publisher TEXT, genre TEXT, description TEXT,
    executable TEXT, wine_version TEXT, wine_arch TEXT, wine_prefix TEXT, executable_args TEXT, working_dir TEXT, env_vars TEXT,
    install_path TEXT, platform TEXT, system TEXT, emulator TEXT, runner TEXT, version TEXT, installed INTEGER, installed_size INTEGER,
    last_played INTEGER, playtime REAL, cover_url TEXT, banner_url TEXT, logo_url TEXT, icon_url TEXT, created_at INTEGER, updated_at INTEGER)`);
  db.prepare('INSERT INTO games (id, slug, name, executable, wine_prefix, install_path, installed) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(4242, 'lutris-game', 'Lutris Game', path.join(lutrisInstall, 'game.exe'), lutrisPrefix, lutrisInstall);
  db.prepare('INSERT INTO games (id, slug, name, executable, install_path, installed) VALUES (?, ?, ?, ?, ?, 1)')
    .run(4243, 'no-saves', 'No Saves Known', path.join(lutrisInstall, 'other.sh'), path.join(home, 'Games', 'no-saves'));
  db.close();

  // External GOG folder scanner, same game as Heroic's GOG entry.
  const gogRoot = mkdir(home, 'GOG Games');
  const gogGame = mkdir(gogRoot, 'GOG Game');
  fs.writeFileSync(path.join(gogGame, 'goggame-1.info'), '{}');
  process.env.GOG_GAMES_ROOTS = gogRoot;

  cacheDir = mkdir(home, 'cache');
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function manifestOptions() {
  const download = vi.fn(async () => MANIFEST_YAML);
  return { download, cachePath: path.join(cacheDir, `manifest-${Math.random()}.yaml`) };
}

function assertNoInstallPathsInSaveFields(games: Game[]) {
  for (const g of games) {
    if (!g.installPath) continue;
    for (const p of [g.linPath, g.winPath]) {
      if (!p) continue;
      // A save path is never the install folder itself or one of its ancestors.
      const rel = path.relative(p, g.installPath);
      const installIsInsideSave = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      expect(installIsInsideSave, `${g.name}: ${p} vs ${g.installPath}`).toBe(false);
    }
  }
}

describe('registry fullScan', () => {
  it('builds the Steam source from the installed library, with manifest save paths', async () => {
    const opts = manifestOptions();
    const games = await scanSource('steam', { ...opts, steamPath: steamRoot });
    expect(opts.download).toHaveBeenCalledTimes(1);
    expect(games.map(g => g.name).sort()).toEqual(['Hollow Knight', 'Portal 2']);
    const hk = games.find(g => g.name === 'Hollow Knight')!;
    expect(hk).toMatchObject({
      source: 'steam',
      sourceId: 'steam',
      steamAppId: '367520',
      installPath: path.join(steamRoot, 'steamapps', 'common', 'Hollow Knight'),
      linPath: path.join(home, '.config', 'unity3d', 'Team Cherry', 'Hollow Knight'),
      winPath: '',
    });
    const portal = games.find(g => g.name === 'Portal 2')!;
    expect(portal.steamAppId).toBe('620');
    expect(portal.installPath).toBe(path.join(lib2, 'steamapps', 'common', 'Portal 2'));
    // Resolved inside the game's Proton prefix.
    expect(portal.linPath).toBe(path.join(lib2, 'steamapps', 'compatdata', '620', 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Portal2Saves'));
    // Manifest-only games are not part of the Steam library.
    expect(games.find(g => g.name === 'Unrelated Game')).toBeUndefined();
    assertNoInstallPathsInSaveFields(games);
  });

  it('scans every source with one manifest load, no install paths in save fields, and dedupes', async () => {
    setSourceEnabled('lutris', true);
    setSourceEnabled('gog', true);
    try {
      const opts = manifestOptions();
      const games = await fullScan([], { ...opts, steamPath: steamRoot });
      expect(opts.download).toHaveBeenCalledTimes(1);
      assertNoInstallPathsInSaveFields(games);

      const heroic = games.find(g => g.name === 'Heroic Game')!;
      expect(heroic.installPath).toBe(path.join(home, 'Games', 'Heroic', 'Heroic Game'));
      expect(heroic.linPath).toBe(path.join(heroic.installPath!, 'Saves'));
      expect(heroic.winPath).toBe('');
      expect(heroic.heroicId).toBe('heroic-1');
      expect(games.find(g => g.name === 'Not Installed')).toBeUndefined();

      const lutris = games.find(g => g.name === 'Lutris Game')!;
      expect(lutris).toMatchObject({
        source: 'lutris',
        lutrisSlug: 'lutris-game',
        installPath: path.join(home, 'Games', 'lutris-game'),
        executable: path.join(home, 'Games', 'lutris-game', 'game.exe'),
        linPath: path.join(home, 'Games', 'lutris-game', 'prefix', 'drive_c', 'users', 'lutrisuser', 'Documents', 'LutrisGame'),
      });
      // No manifest match -> save fields stay empty (no guessing from install/executable).
      const noSaves = games.find(g => g.name === 'No Saves Known')!;
      expect(noSaves.linPath).toBe('');
      expect(noSaves.winPath).toBe('');
      expect(noSaves.installPath).toBe(path.join(home, 'Games', 'no-saves'));

      // Heroic's GOG entry and the GOG folder scanner are the same game: one entry,
      // Heroic wins, the GOG save path is kept.
      const gog = games.filter(g => g.name === 'GOG Game');
      expect(gog).toHaveLength(1);
      expect(gog[0]).toMatchObject({ source: 'heroic', heroicId: 'heroic-gog', linPath: path.join(home, '.local', 'share', 'GOGGame') });

      // Sources survive a full scan (previously registry.clear() dropped them).
      expect(getSources().length).toBeGreaterThan(0);
      expect(getSources().find(s => s.id === 'steam')?.gameCount).toBe(2);
    } finally {
      setSourceEnabled('lutris', false);
      setSourceEnabled('gog', false);
    }
  });

  it('includeManifestSaves adds manifest-only games and folds duplicates into launcher entries', async () => {
    const games = await fullScan([], { ...manifestOptions(), steamPath: steamRoot, includeManifestSaves: true });
    const unrelated = games.find(g => g.name === 'Unrelated Game')!;
    expect(unrelated.source).toBeUndefined();
    expect(unrelated.linPath).toBe(path.join(home, '.local', 'share', 'Unrelated'));
    expect(games.filter(g => g.name === 'Hollow Knight')).toHaveLength(1);
    expect(games.find(g => g.name === 'Hollow Knight')?.steamAppId).toBe('367520');
  });

  it('leaves save paths empty when the manifest is unavailable', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const games = await fullScan([], { manifest: null, steamPath: steamRoot });
    errSpy.mockRestore();
    const steam = games.filter(g => g.source === 'steam');
    expect(steam).toHaveLength(2);
    for (const g of games) {
      expect(g.linPath).toBe('');
      expect(g.winPath).toBe('');
    }
  });
});

describe('legacy electron/scanner.ts entry point', () => {
  it('is a thin re-export of the shared manifest scanner', async () => {
    const resolver = createSaveResolver(parseManifest(MANIFEST_YAML)!, { home, env: {}, platform: 'linux' });
    const found = await legacyAutoDetect([], { resolver });
    expect(found.map(g => g.name)).toContain('Unrelated Game');
    expect(found.find(g => g.name === 'Unrelated Game')?.linPath).toBe(path.join(home, '.local', 'share', 'Unrelated'));
  });
});

describe('dedupeGames', () => {
  const base = (over: Partial<Game>): Game => ({
    id: Math.floor(Math.random() * 1e9), name: 'X', winPath: '', linPath: '', lastSync: 'Never',
    status: 'Pending Upload', thumbnail: '', createdAt: '', updatedAt: '', ...over,
  });

  it('merges by steamAppId, then install path, then name within a source family', () => {
    const steam = base({ name: 'Game A', source: 'steam', sourceId: 'steam', steamAppId: '1', installPath: '/lib/A' });
    const lutrisSameApp = base({ name: 'Game A (Lutris)', source: 'lutris', sourceId: 'lutris', steamAppId: '1', lutrisSlug: 'a', winePrefix: '/pfx/a' });
    const epic = base({ name: 'Game B', source: 'epic', sourceId: 'epic', installPath: '/games/B/', linPath: '/saves/B' });
    const heroic = base({ name: 'Game B Heroic', source: 'heroic', sourceId: 'heroic', heroicId: 'hb', installPath: '/games/B' });
    const gogFolder = base({ name: 'Game C', source: 'gog', sourceId: 'gog', installPath: '/gog/C' });
    const heroicGog = { ...base({ name: 'game c', source: 'heroic', sourceId: 'heroic', heroicId: 'hc', installPath: '/heroic/C' }), platform: 'gog' } as Game;
    const epicSameName = base({ name: 'Game C', source: 'epic', sourceId: 'epic', installPath: '/epic/C' });
    const manual = base({ name: 'Game A', source: 'manual', sourceId: 'manual', linPath: '/my/saves' });

    const input = [epic, lutrisSameApp, gogFolder, manual, steam, heroic, heroicGog, epicSameName];
    const out = dedupeGames(input);
    expect(dedupeGames(input)).toEqual(out); // deterministic

    const a = out.find(g => g.steamAppId === '1')!;
    expect(a).toMatchObject({ source: 'steam', name: 'Game A', lutrisSlug: 'a', winePrefix: '/pfx/a', installPath: '/lib/A' });

    const b = out.find(g => g.heroicId === 'hb')!;
    expect(b).toMatchObject({ source: 'heroic', linPath: '/saves/B', installPath: '/games/B' });
    expect(out.filter(g => g.source === 'epic' && g.name === 'Game B')).toHaveLength(0);

    const c = out.filter(g => normalize(g.name) === 'gamec');
    // Heroic GOG + GOG folder merge (same family); the Epic entry is a different store.
    expect(c.map(g => g.source).sort()).toEqual(['epic', 'heroic']);

    expect(out).toContain(manual); // manual entries untouched
    expect(out).toHaveLength(5);
  });
});

function normalize(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
