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

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const key of envKeys) delete process.env[key];
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

    expect(getUbisoftGames()).toHaveLength(1);
    expect(getEaGames()).toHaveLength(1);
    expect(getBattleNetGames()).toHaveLength(1);
    expect(getXboxGames()).toHaveLength(1);
  });

  it('scans Minecraft roots and versions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-mc-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'versions', '1.20.4'), { recursive: true });
    process.env.MINECRAFT_ROOTS = root;
    const games = getMinecraftGames();
    expect(games.map((g) => g.name)).toContain('Minecraft');
    expect(games.map((g) => g.name)).toContain('Minecraft 1.20.4');
  });
});
