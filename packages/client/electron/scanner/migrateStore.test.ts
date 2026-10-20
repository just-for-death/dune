import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Game } from '@dune/shared';

vi.mock('electron', () => ({ app: { getPath: () => path.join(os.tmpdir(), 'dune-migrate-userdata-unused') } }));
vi.mock('axios', () => ({ default: { get: vi.fn(async () => { throw new Error('network disabled in tests'); }) } }));

import { createSaveResolver, type LudusaviManifest } from './savePaths.js';
import { getInstalledSteamLibraryGames } from './steam.js';
import {
  GAMES_MIGRATION_KEY,
  findPreMigrationBackups,
  ensurePreMigrationBackup,
  jsonFileStore,
  preMigrationBackupPath,
  migrateStoredGames,
  runStoredGamesMigration,
} from './migrateStore.js';
import { sanitizeGame } from '../utils.js';

const FIXTURE = path.join(__dirname, '__fixtures__', 'legacy-store-01dd084.json');

const MANIFEST: LudusaviManifest = {
  'Hollow Knight': { steam: { id: 367520 }, files: { '<home>/.config/unity3d/Team Cherry/Hollow Knight': { tags: ['save'] } } },
  'Portal 2': { steam: { id: 620 }, files: { '<winAppData>/Portal2Saves': { tags: ['save'] } } },
  'Heroic Game': { files: { '<base>/Saves': { tags: ['save'] } } },
  'Lutris Game': { files: { '<winDocuments>/LutrisGame': { tags: ['save'] } } },
  'GOG Game': { files: { '<home>/.local/share/GOGGame': { tags: ['save'] } } },
  // Matching names for manual/emulator entries prove those are never re-resolved.
  'My Manual Game': { files: { '<home>/.local/share/ManualElsewhere': {} } },
  'Super Mario Bros': { files: { '<home>/.local/share/MarioElsewhere': {} } },
};

const mkdir = (...p: string[]) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };

describe('legacy game store migration (DUN-001)', () => {
  let home: string;
  let storePath: string;
  let steamRoot: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-migrate-home-'));
    steamRoot = mkdir(home, '.local', 'share', 'Steam');
    const acf = (id: string, name: string) => `"AppState"\n{\n\t"appid"\t\t"${id}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${name}"\n}\n`;
    mkdir(steamRoot, 'steamapps', 'common', 'Hollow Knight');
    mkdir(steamRoot, 'steamapps', 'common', 'Portal 2');
    fs.writeFileSync(path.join(steamRoot, 'steamapps', 'appmanifest_367520.acf'), acf('367520', 'Hollow Knight'));
    fs.writeFileSync(path.join(steamRoot, 'steamapps', 'appmanifest_620.acf'), acf('620', 'Portal 2'));
    mkdir(home, '.config', 'unity3d', 'Team Cherry', 'Hollow Knight');
    mkdir(steamRoot, 'steamapps', 'compatdata', '620', 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Portal2Saves');
    mkdir(home, 'Games', 'Heroic', 'Heroic Game', 'Saves');
    mkdir(home, 'Games', 'lutris-game', 'prefix', 'drive_c', 'users', 'lutrisuser', 'Documents', 'LutrisGame');
    mkdir(home, 'Games', 'exe-only');
    fs.writeFileSync(path.join(home, 'Games', 'exe-only', 'run.sh'), '');
    mkdir(home, 'GOG Games', 'GOG Game');
    mkdir(home, '.local', 'share', 'GOGGame');
    mkdir(home, '.local', 'share', 'ManualElsewhere');
    mkdir(home, '.local', 'share', 'MarioElsewhere');

    storePath = path.join(home, 'config.json');
    fs.writeFileSync(storePath, fs.readFileSync(FIXTURE, 'utf-8').split('{{HOME}}').join(home));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const resolver = () => createSaveResolver(MANIFEST, { home, env: { USER: 'jane' }, platform: 'linux' });
  const ctx = () => ({ steamGames: getInstalledSteamLibraryGames(steamRoot) });
  const original = (): Game[] => JSON.parse(fs.readFileSync(storePath, 'utf-8')).games as Game[];
  const byName = (games: Game[], name: string) => games.find(g => g.name === name)!;

  it('moves install folders to installPath and re-resolves save paths', () => {
    const before = original();
    const { games, changed } = migrateStoredGames(before, resolver(), ctx());
    expect(changed).toBe(7);

    expect(byName(games, 'Hollow Knight')).toMatchObject({
      installPath: path.join(steamRoot, 'steamapps', 'common', 'Hollow Knight'),
      linPath: path.join(home, '.config', 'unity3d', 'Team Cherry', 'Hollow Knight'),
      winPath: '',
      steamAppId: '367520',
    });
    // Legacy manifest-scanner Steam entry already held a real save path: kept as the
    // save path, library metadata filled in, nothing moved into installPath.
    expect(byName(games, 'Portal 2')).toMatchObject({
      steamAppId: '620',
      installPath: path.join(steamRoot, 'steamapps', 'common', 'Portal 2'),
      linPath: byName(before, 'Portal 2').linPath,
      winPath: '',
    });
    expect(byName(games, 'Heroic Game')).toMatchObject({
      installPath: path.join(home, 'Games', 'Heroic', 'Heroic Game'),
      linPath: path.join(home, 'Games', 'Heroic', 'Heroic Game', 'Saves'),
      winPath: '',
      heroicId: 'heroic-1',
    });
    expect(byName(games, 'Lutris Game')).toMatchObject({
      installPath: path.join(home, 'Games', 'lutris-game'),
      linPath: path.join(home, 'Games', 'lutris-game', 'prefix', 'drive_c', 'users', 'lutrisuser', 'Documents', 'LutrisGame'),
    });
    // Lutris fallback stored the executable; it stays in `executable`, saves emptied.
    expect(byName(games, 'Lutris Exe Only')).toMatchObject({
      executable: path.join(home, 'Games', 'exe-only', 'run.sh'),
      linPath: '',
      winPath: '',
    });
    expect(byName(games, 'Lutris Exe Only').installPath).toBeFalsy();
    expect(byName(games, 'GOG Game')).toMatchObject({
      installPath: path.join(home, 'GOG Games', 'GOG Game'),
      linPath: path.join(home, '.local', 'share', 'GOGGame'),
    });
    // No manifest entry -> save fields emptied, install location preserved.
    expect(byName(games, 'Fortnite')).toMatchObject({
      installPath: 'C:\\Program Files\\Epic Games\\Fortnite',
      linPath: '',
      winPath: '',
    });

    // Manual: exactly what the user typed. Emulator: untouched.
    expect(byName(games, 'My Manual Game')).toEqual(byName(before, 'My Manual Game'));
    expect(byName(games, 'Super Mario Bros')).toEqual(byName(before, 'Super Mario Bros'));

    // Ids, order, and timestamps are preserved.
    expect(games.map(g => g.id)).toEqual(before.map(g => g.id));
    expect(games.map(g => g.updatedAt)).toEqual(before.map(g => g.updatedAt));

    // Install folders never remain in a save field.
    for (const g of games) {
      if (g.installPath) {
        expect(g.linPath).not.toBe(g.installPath);
        expect(g.winPath).not.toBe(g.installPath);
      }
    }
  });

  it('is idempotent', () => {
    const once = migrateStoredGames(original(), resolver(), ctx());
    const twice = migrateStoredGames(once.games, resolver(), ctx());
    expect(twice.changed).toBe(0);
    expect(twice.games).toEqual(once.games);
  });

  it('persists the migrated store once and leaves other keys alone', async () => {
    const store = jsonFileStore(storePath);
    const rawBefore = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    const getResolver = vi.fn(async () => resolver());

    const first = await runStoredGamesMigration(store, { getResolver, ...ctx(), storePath });
    expect(first).toMatchObject({ status: 'migrated', changed: 7 });
    const afterFirst = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(afterFirst);
    expect(parsed[GAMES_MIGRATION_KEY]).toBe(1);
    expect(parsed.settings).toEqual(rawBefore.settings);
    expect(parsed.cloud).toEqual(rawBefore.cloud);
    expect(byName(parsed.games, 'Hollow Knight').installPath).toBe(path.join(steamRoot, 'steamapps', 'common', 'Hollow Knight'));

    const second = await runStoredGamesMigration(store, { getResolver, ...ctx(), storePath });
    expect(second).toEqual({ status: 'skipped', reason: 'already-migrated' });
    expect(getResolver).toHaveBeenCalledTimes(1);

    // Even forced, a second run changes nothing.
    const forced = await runStoredGamesMigration(store, { getResolver, ...ctx(), storePath, force: true });
    expect(forced).toEqual({ status: 'migrated', changed: 0 });
    expect(fs.readFileSync(storePath, 'utf-8')).toBe(afterFirst);
  });

  it('does nothing (and retries later) when no manifest is available', async () => {
    const before = fs.readFileSync(storePath, 'utf-8');
    const store = jsonFileStore(storePath);
    const result = await runStoredGamesMigration(store, { getResolver: async () => null, ...ctx(), storePath });
    expect(result).toEqual({ status: 'skipped', reason: 'no-manifest' });
    expect(fs.readFileSync(storePath, 'utf-8')).toBe(before);
  });

  it('keeps migrated metadata through a renderer config:save (sanitizeGame)', () => {
    const { games } = migrateStoredGames(original(), resolver(), ctx());
    const hk = byName(games, 'Hollow Knight');
    const roundTripped = sanitizeGame(JSON.parse(JSON.stringify(hk)));
    expect(roundTripped).toMatchObject({
      installPath: hk.installPath,
      linPath: hk.linPath,
      steamAppId: '367520',
      sourceId: 'steam',
    });
    const manual = sanitizeGame(byName(games, 'My Manual Game'));
    expect(manual).not.toHaveProperty('installPath');
    expect(manual).not.toHaveProperty('source');
    expect(sanitizeGame({ name: 'x', source: 'not-a-source' })).not.toHaveProperty('source');
  });
  describe('pre-migration backup', () => {
    const FIXED = new Date('2026-10-20T06:44:01.234Z');
    const now = () => FIXED;
    const expectedBackup = () => `${storePath}.pre-migration-v1.2026-10-20T06-44-01.234Z.json`;
    const backups = () => fs.readdirSync(home).filter(f => f.includes('.pre-migration-v'));

    it('creates a byte-identical backup before the first write', async () => {
      const originalBytes = fs.readFileSync(storePath);
      const fileStore = jsonFileStore(storePath);
      const seenAtFirstWrite: { exists: boolean; bytes?: Buffer; storeBytes?: Buffer }[] = [];
      const store = {
        get: fileStore.get,
        set: (key: string, value: unknown) => {
          const b = expectedBackup();
          seenAtFirstWrite.push({
            exists: fs.existsSync(b),
            bytes: fs.existsSync(b) ? fs.readFileSync(b) : undefined,
            storeBytes: fs.readFileSync(storePath),
          });
          fileStore.set(key, value);
        },
      };
      const result = await runStoredGamesMigration(store, { getResolver: async () => resolver(), ...ctx(), storePath, now });
      expect(result).toEqual({ status: 'migrated', changed: 7, backupPath: expectedBackup() });
      expect(path.basename(expectedBackup())).toBe('config.json.pre-migration-v1.2026-10-20T06-44-01.234Z.json');
      expect(preMigrationBackupPath(storePath, FIXED)).toBe(expectedBackup());
      // Backup already existed (with the original bytes) when the store was first written.
      expect(seenAtFirstWrite.length).toBeGreaterThan(0);
      expect(seenAtFirstWrite[0].exists).toBe(true);
      expect(seenAtFirstWrite[0].storeBytes!.equals(originalBytes)).toBe(true);
      expect(seenAtFirstWrite[0].bytes!.equals(originalBytes)).toBe(true);
      // ...and still does afterwards, while the store itself was migrated.
      expect(fs.readFileSync(expectedBackup()).equals(originalBytes)).toBe(true);
      expect(fs.readFileSync(storePath).equals(originalBytes)).toBe(false);
      expect(backups()).toEqual([path.basename(expectedBackup())]);
    });

    it('never overwrites an existing backup, even on a timestamp collision', async () => {
      const sentinel = 'existing backup - do not overwrite';
      fs.writeFileSync(expectedBackup(), sentinel);

      // Exclusive create on the colliding name fails instead of overwriting.
      const copyExcl = (src: string, dest: string) => fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      expect(() => copyExcl(storePath, expectedBackup())).toThrow(/EEXIST/);
      expect(fs.readFileSync(expectedBackup(), 'utf-8')).toBe(sentinel);

      // The helper treats an existing v1 backup as "already backed up" and creates nothing.
      expect(ensurePreMigrationBackup(storePath, now)).toEqual({ path: expectedBackup(), created: false });

      const result = await runStoredGamesMigration(jsonFileStore(storePath), { getResolver: async () => resolver(), ...ctx(), storePath, now });
      expect(result).toEqual({ status: 'migrated', changed: 7, backupPath: expectedBackup() });
      expect(fs.readFileSync(expectedBackup(), 'utf-8')).toBe(sentinel);
      expect(backups()).toEqual([path.basename(expectedBackup())]);
    });

    it('creates no new backup on a second run (marker set, or forced)', async () => {
      const store = jsonFileStore(storePath);
      let t = FIXED.getTime();
      const tick = () => new Date(t += 60_000);
      const first = await runStoredGamesMigration(store, { getResolver: async () => resolver(), ...ctx(), storePath, now: tick });
      expect(first.status).toBe('migrated');
      expect(backups()).toHaveLength(1);
      const backupBytes = fs.readFileSync(findPreMigrationBackups(storePath)[0]);

      const second = await runStoredGamesMigration(store, { getResolver: async () => resolver(), ...ctx(), storePath, now: tick });
      expect(second).toEqual({ status: 'skipped', reason: 'already-migrated' });
      const forced = await runStoredGamesMigration(store, { getResolver: async () => resolver(), ...ctx(), storePath, now: tick, force: true });
      expect(forced).toEqual({ status: 'migrated', changed: 0 });

      // Even if the store needs changes again, the existing v1 backup is reused.
      fs.writeFileSync(storePath, fs.readFileSync(FIXTURE, 'utf-8').split('{{HOME}}').join(home));
      const third = await runStoredGamesMigration(store, { getResolver: async () => resolver(), ...ctx(), storePath, now: tick });
      expect(third).toMatchObject({ status: 'migrated', changed: 7 });
      expect(backups()).toHaveLength(1);
      expect(fs.readFileSync(findPreMigrationBackups(storePath)[0]).equals(backupBytes)).toBe(true);
    });

    it('makes no backup when nothing changes or no manifest is available', async () => {
      const copy = vi.fn((src: string, dest: string) => fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL));

      const noManifest = await runStoredGamesMigration(jsonFileStore(storePath), { getResolver: async () => null, ...ctx(), storePath, now, copyFileExclusive: copy });
      expect(noManifest).toEqual({ status: 'skipped', reason: 'no-manifest' });
      expect(backups()).toEqual([]);

      // Store already in migrated shape (but marker unset): nothing to change -> no backup.
      const { games } = migrateStoredGames(original(), resolver(), ctx());
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      raw.games = games;
      fs.writeFileSync(storePath, JSON.stringify(raw, null, '\t'));
      const unchanged = await runStoredGamesMigration(jsonFileStore(storePath), { getResolver: async () => resolver(), ...ctx(), storePath, now, copyFileExclusive: copy });
      expect(unchanged).toEqual({ status: 'migrated', changed: 0 });
      expect(JSON.parse(fs.readFileSync(storePath, 'utf-8')).games).toEqual(games);
      expect(backups()).toEqual([]);
      expect(copy).not.toHaveBeenCalled();
    });

    it('aborts without writing when the backup fails (marker stays unset)', async () => {
      const before = fs.readFileSync(storePath);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failingCopy = vi.fn(() => { throw new Error('EACCES: simulated backup failure'); });
      const fileStore = jsonFileStore(storePath);
      const set = vi.fn(fileStore.set);
      try {
        const result = await runStoredGamesMigration({ get: fileStore.get, set }, { getResolver: async () => resolver(), ...ctx(), storePath, now, copyFileExclusive: failingCopy });
        expect(result).toEqual({ status: 'failed', reason: 'backup-failed', error: 'EACCES: simulated backup failure' });
        expect(failingCopy).toHaveBeenCalledWith(storePath, expectedBackup());
        expect(set).not.toHaveBeenCalled();
        expect(fs.readFileSync(storePath).equals(before)).toBe(true);
        expect(JSON.parse(before.toString('utf-8'))[GAMES_MIGRATION_KEY]).toBeUndefined();
        expect(errSpy).toHaveBeenCalled();
        expect(backups()).toEqual([]);
      } finally {
        errSpy.mockRestore();
      }

      // Next launch (backup works again) migrates normally.
      const retry = await runStoredGamesMigration(jsonFileStore(storePath), { getResolver: async () => resolver(), ...ctx(), storePath, now });
      expect(retry).toEqual({ status: 'migrated', changed: 7, backupPath: expectedBackup() });
      expect(fs.readFileSync(expectedBackup()).equals(before)).toBe(true);
    });
  });
});
