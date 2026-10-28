import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listWinePrefixes, createWinePrefix, deleteWinePrefix, backupWinePrefix, isWinePrefix } from './wine.js';
import { listProtonVersions } from './proton.js';
import { listHeroicPrefixes } from './heroic.js';
import { listLutrisPrefixes } from './lutris.js';
import { PrefixRegistry, defaultPrefixRegistryPaths } from './registry.js';

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

  it('detects Wine prefixes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-wine-'));
    tempDirs.push(root);
    const prefix = path.join(root, 'prefix');
    fs.mkdirSync(path.join(prefix, 'drive_c'), { recursive: true });
    process.env.WINE_PREFIX_ROOTS = root;
    expect(isWinePrefix(prefix)).toBe(true);
    expect(listWinePrefixes()).toHaveLength(1);
  });

  it('manages Wine prefixes only through the registry (DUN-062)', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-wine-managed-'));
    tempDirs.push(userData);
    const trashItem = vi.fn(async (_p: string) => {});
    const registry = new PrefixRegistry(defaultPrefixRegistryPaths(userData, os.homedir()), { trashItem, log: () => {} });

    const created = createWinePrefix(registry, 'created');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.prefix.path).toBe(path.join(fs.realpathSync(userData), 'prefixes', 'created'));
    expect(isWinePrefix(created.prefix.path)).toBe(true);

    const backup = backupWinePrefix(registry, created.prefix.id);
    expect(backup.ok).toBe(true);
    if (backup.ok) expect(path.dirname(backup.backupPath)).toBe(path.join(fs.realpathSync(userData), 'prefix-backups'));

    expect(await deleteWinePrefix(registry, created.prefix.id)).toEqual({ ok: true, trashedPath: created.prefix.path });
    expect(trashItem).toHaveBeenCalledExactlyOnceWith(created.prefix.path);
    expect(registry.list()).toEqual([]);

    // The old path-taking calls are gone: a path is not a valid name or id.
    expect(createWinePrefix(registry, path.join(userData, 'elsewhere'))).toEqual({ ok: false, reason: 'invalid-name' });
    expect(await deleteWinePrefix(registry, created.prefix.path)).toEqual({ ok: false, reason: 'not-found' });
    expect(backupWinePrefix(registry, created.prefix.path)).toEqual({ ok: false, reason: 'not-found' });
    expect(trashItem).toHaveBeenCalledTimes(1);
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
  });
});
