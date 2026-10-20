import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listWinePrefixes, createWinePrefix, deleteWinePrefix, backupWinePrefix, isWinePrefix } from './wine.js';
import { listProtonVersions } from './proton.js';
import { listHeroicPrefixes } from './heroic.js';
import { listLutrisPrefixes } from './lutris.js';
import { listPrefixes } from './manager.js';

describe('prefix manager', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    delete process.env.WINE_PREFIX_ROOTS;
    delete process.env.PROTON_ROOTS;
    delete process.env.HEROIC_PREFIX_ROOTS;
    delete process.env.LUTRIS_PREFIX_ROOTS;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.WINE_PREFIX_ROOTS;
    delete process.env.PROTON_ROOTS;
    delete process.env.HEROIC_PREFIX_ROOTS;
    delete process.env.LUTRIS_PREFIX_ROOTS;
  });

  it('detects and manages Wine prefixes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-wine-'));
    tempDirs.push(root);
    const prefix = path.join(root, 'prefix');
    fs.mkdirSync(path.join(prefix, 'drive_c'), { recursive: true });
    process.env.WINE_PREFIX_ROOTS = root;
    expect(isWinePrefix(prefix)).toBe(true);
    expect(listWinePrefixes()).toHaveLength(1);

    const created = path.join(root, 'created');
    expect(createWinePrefix(created).success).toBe(true);
    expect(fs.existsSync(path.join(created, 'drive_c'))).toBe(true);
    expect(backupWinePrefix(created).success).toBe(true);
    expect(deleteWinePrefix(created).success).toBe(true);
    expect(fs.existsSync(created)).toBe(false);
  });

  it('lists Proton, Heroic, and Lutris prefixes', () => {
    const protonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-proton-'));
    tempDirs.push(protonRoot);
    const protonDir = path.join(protonRoot, 'Proton 8.0');
    fs.mkdirSync(protonDir);
    fs.writeFileSync(path.join(protonDir, 'proton'), '');
    process.env.PROTON_ROOTS = protonRoot;
    expect(listProtonVersions()).toHaveLength(1);

    const heroicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-heroic-prefix-'));
    tempDirs.push(heroicRoot);
    fs.mkdirSync(path.join(heroicRoot, 'game-prefix'));
    process.env.HEROIC_PREFIX_ROOTS = heroicRoot;
    expect(listHeroicPrefixes()).toHaveLength(1);

    const lutrisRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-lutris-prefix-'));
    tempDirs.push(lutrisRoot);
    fs.mkdirSync(path.join(lutrisRoot, 'game-prefix'));
    process.env.LUTRIS_PREFIX_ROOTS = lutrisRoot;
    expect(listLutrisPrefixes()).toHaveLength(1);

    const summary = listPrefixes();
    expect(summary.proton).toHaveLength(1);
    expect(summary.heroic).toHaveLength(1);
    expect(summary.lutris).toHaveLength(1);
  });
});
