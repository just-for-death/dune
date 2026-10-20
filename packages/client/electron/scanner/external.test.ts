import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getEpicGames,
  getGogGames,
  getUbisoftGames,
  getEaGames,
  getBattleNetGames,
  getXboxGames,
  getMinecraftGames,
} from './external.js';
import { createSaveResolver } from './savePaths.js';

describe('external launcher scanners', () => {
  const tempDirs: string[] = [];
  const envKeys = [
    'EPIC_MANIFEST_ROOTS',
    'GOG_GAMES_ROOTS',
    'UBISOFT_GAMES_ROOTS',
    'EA_GAMES_ROOTS',
    'BATTLENET_GAMES_ROOTS',
    'XBOX_GAMES_ROOTS',
    'MINECRAFT_ROOTS',
  ];

  const realHome = process.env.HOME;

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    // Keep home-relative lookups (e.g. ~/.curseforge) inside a temp dir.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-ext-home-'));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const key of envKeys) delete process.env[key];
    process.env.HOME = realHome;
  });

  it('scans Epic manifests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-epic-'));
    tempDirs.push(root);
    const install = path.join(root, 'install');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(root, 'Game.item'), JSON.stringify({ DisplayName: 'Epic Game', InstallLocation: install }));
    process.env.EPIC_MANIFEST_ROOTS = root;
    const games = getEpicGames();
    expect(games).toHaveLength(1);
    expect(games[0].name).toBe('Epic Game');
    expect(games[0].source).toBe('epic');
    // Install location is not a save path.
    expect(games[0].installPath).toBe(install);
    expect(games[0].linPath).toBe('');
    expect(games[0].winPath).toBe('');
  });

  it('resolves real save paths from the manifest and never uses the install folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-epic-saves-'));
    tempDirs.push(root);
    const install = path.join(root, 'install');
    const saves = path.join(root, 'home', '.local', 'share', 'EpicGame');
    fs.mkdirSync(install, { recursive: true });
    fs.mkdirSync(saves, { recursive: true });
    fs.writeFileSync(path.join(root, 'Game.item'), JSON.stringify({ DisplayName: 'Epic Game', InstallLocation: install }));
    fs.writeFileSync(path.join(root, 'Other.item'), JSON.stringify({ DisplayName: 'No Manifest Entry', InstallLocation: install }));
    const resolver = createSaveResolver(
      { 'Epic Game': { files: { '<home>/.local/share/EpicGame': { tags: ['save'] }, '<base>': { tags: ['save'] } } } },
      { home: path.join(root, 'home'), env: {}, platform: 'linux' },
    );
    const games = getEpicGames([root], resolver);
    const epic = games.find((g) => g.name === 'Epic Game')!;
    expect(epic.linPath).toBe(saves);
    expect(epic.installPath).toBe(install);
    const other = games.find((g) => g.name === 'No Manifest Entry')!;
    expect(other.linPath).toBe('');
    expect(other.installPath).toBe(install);
  });

  it('scans GOG game directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-gog-'));
    tempDirs.push(root);
    const gameDir = path.join(root, 'GOG Game');
    fs.mkdirSync(gameDir);
    fs.writeFileSync(path.join(gameDir, 'goggame-123.info'), '{}');
    process.env.GOG_GAMES_ROOTS = root;
    const games = getGogGames();
    expect(games).toHaveLength(1);
    expect(games[0].name).toBe('GOG Game');
    expect(games[0].source).toBe('gog');
    expect(games[0].installPath).toBe(gameDir);
    expect(games[0].linPath).toBe('');
  });

  it('scans simple launcher directories', () => {
    const makeRoot = (prefix: string) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tempDirs.push(root);
      fs.mkdirSync(path.join(root, 'Game One'));
      return root;
    };

    process.env.UBISOFT_GAMES_ROOTS = makeRoot('dune-ubi-');
    process.env.EA_GAMES_ROOTS = makeRoot('dune-ea-');
    process.env.BATTLENET_GAMES_ROOTS = makeRoot('dune-bn-');
    process.env.XBOX_GAMES_ROOTS = makeRoot('dune-xbox-');

    for (const games of [getUbisoftGames(), getEaGames(), getBattleNetGames(), getXboxGames()]) {
      expect(games).toHaveLength(1);
      expect(games[0].installPath).toMatch(/Game One$/);
      expect(games[0].linPath).toBe('');
      expect(games[0].winPath).toBe('');
    }
  });

  it('scans Minecraft roots and versions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-mc-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'versions', '1.20.4'), { recursive: true });
    process.env.MINECRAFT_ROOTS = root;
    const games = getMinecraftGames();
    expect(games.map((g) => g.name)).toContain('Minecraft');
    expect(games.map((g) => g.name)).toContain('Minecraft 1.20.4');
    expect(games.find((g) => g.name === 'Minecraft')?.installPath).toBe(root);
    expect(games.every((g) => g.linPath === '' && g.winPath === '')).toBe(true);
  });
});
