import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  PrefixRegistry,
  createPrefixIpcHandlers,
  defaultPrefixRegistryPaths,
  isStrictlyInside,
  isValidPrefixName,
  MAX_PREFIX_NAME_LENGTH,
  type PrefixRegistryPaths,
} from './registry.js';

// Every test works inside its own mkdtemp folder (removed in afterEach) with a
// fake trashItem. Nothing here touches real prefixes, ~/.wine, Steam or saves:
// tampered entries that point at home or / are refused before any fs call.

const TAMPER_ID = '00000000-0000-4000-8000-000000000001';

describe('PrefixRegistry (DUN-062)', () => {
  const tempDirs: string[] = [];
  let base: string;
  let paths: PrefixRegistryPaths;
  let trashItem: ReturnType<typeof vi.fn<(p: string) => Promise<void>>>;
  let logs: string[];
  let registry: PrefixRegistry;

  const mkTemp = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  const writeRegistry = (entries: unknown[]) => {
    fs.writeFileSync(paths.registryFile, JSON.stringify({ version: 1, prefixes: entries }));
  };

  const tamper = (entryPath: string, name = 'tampered') => {
    writeRegistry([{ id: TAMPER_ID, name, path: entryPath, createdAt: new Date(0).toISOString() }]);
  };

  beforeEach(() => {
    base = mkTemp('dune-prefix-registry-');
    const userData = path.join(base, 'userData');
    fs.mkdirSync(userData);
    paths = defaultPrefixRegistryPaths(userData, os.homedir());
    trashItem = vi.fn<(p: string) => Promise<void>>(async () => {});
    logs = [];
    registry = new PrefixRegistry(paths, { trashItem, log: (m) => logs.push(m) });
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses <userData>/prefixes and <userData>/prefix-backups', () => {
    expect(paths.managedRoot).toBe(path.join(base, 'userData', 'prefixes'));
    expect(paths.backupsRoot).toBe(path.join(base, 'userData', 'prefix-backups'));
    expect(paths.registryFile).toBe(path.join(base, 'userData', 'prefix-registry.json'));
  });

  it('creates a prefix under the managed root and lists only registry entries', () => {
    fs.mkdirSync(paths.managedRoot, { recursive: true });
    fs.mkdirSync(path.join(paths.managedRoot, 'unregistered'));
    const res = registry.create('my-game_1.0');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prefix.path).toBe(path.join(fs.realpathSync(paths.managedRoot), 'my-game_1.0'));
    expect(res.prefix.name).toBe('my-game_1.0');
    expect(res.prefix.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(res.prefix.createdAt))).toBe(false);
    expect(fs.existsSync(path.join(res.prefix.path, 'drive_c'))).toBe(true);
    expect(registry.list()).toEqual([res.prefix]);
  });

  it('refuses createPrefix names with ../, /, empty and other unsafe forms', () => {
    const bad: unknown[] = [
      '', '../', '../evil', '..', '.', '/', '/etc', 'a/b', 'a\\b', '..\\x', 'a..b', '.hidden', 'trail.',
      ' space', 'tab\t', 'nul', 'CON.txt', 'x'.repeat(MAX_PREFIX_NAME_LENGTH + 1), 42, null, undefined, { name: 'x' },
    ];
    for (const name of bad) {
      expect(isValidPrefixName(name)).toBe(false);
      expect(registry.create(name)).toEqual({ ok: false, reason: 'invalid-name' });
    }
    expect(registry.list()).toEqual([]);
    expect(fs.existsSync(path.join(base, 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(paths.managedRoot, '..', 'evil'))).toBe(false);
    expect(isValidPrefixName('x'.repeat(MAX_PREFIX_NAME_LENGTH))).toBe(true);
  });

  it('refuses to create over an existing folder or a duplicate name', () => {
    fs.mkdirSync(path.join(paths.managedRoot, 'taken'), { recursive: true });
    expect(registry.create('taken')).toEqual({ ok: false, reason: 'exists' });
    expect(registry.create('fresh').ok).toBe(true);
    expect(registry.create('FRESH')).toEqual({ ok: false, reason: 'exists' });
    expect(registry.list()).toHaveLength(1);
  });

  it('refuses to create over a dangling symlink in the managed root', () => {
    fs.mkdirSync(paths.managedRoot, { recursive: true });
    fs.symlinkSync(path.join(base, 'nowhere'), path.join(paths.managedRoot, 'link'));
    expect(registry.create('link')).toEqual({ ok: false, reason: 'exists' });
    expect(fs.existsSync(path.join(base, 'nowhere'))).toBe(false);
  });

  it('deletes a registered prefix by trashing exactly that path, then drops the entry', async () => {
    const created = registry.create('doomed');
    const keep = registry.create('keeper');
    if (!created.ok || !keep.ok) throw new Error('setup failed');
    const res = await registry.delete(created.prefix.id);
    expect(res).toEqual({ ok: true, trashedPath: created.prefix.path });
    expect(trashItem).toHaveBeenCalledTimes(1);
    expect(trashItem).toHaveBeenCalledWith(created.prefix.path);
    expect(registry.list().map((e) => e.id)).toEqual([keep.prefix.id]);
    // The fake trash moved nothing; Dune itself never removed the folder.
    expect(fs.existsSync(created.prefix.path)).toBe(true);
  });

  it('returns not-found for unknown or malformed ids', async () => {
    registry.create('present');
    for (const id of ['11111111-1111-4111-8111-111111111111', 'nope', '', '/', os.homedir(), 7, null, undefined]) {
      expect(await registry.delete(id)).toEqual({ ok: false, reason: 'not-found' });
      expect(registry.backup(id)).toEqual({ ok: false, reason: 'not-found' });
    }
    expect(trashItem).not.toHaveBeenCalled();
  });

  it('refuses tampered entries pointing at home, /, the root, outside it, or a symlink to outside', async () => {
    fs.mkdirSync(paths.managedRoot, { recursive: true });
    const realRoot = fs.realpathSync(paths.managedRoot);
    const outside = mkTemp('dune-prefix-outside-');
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
    fs.symlinkSync(outside, path.join(realRoot, 'escape'));
    const sibling = `${realRoot}-evil`;
    fs.mkdirSync(sibling); // inside this test's mkdtemp base, removed with it

    const cases: { entryPath: string; name?: string; reason: string }[] = [
      { entryPath: os.homedir(), reason: 'outside-root' },
      { entryPath: '/', reason: 'outside-root' },
      { entryPath: realRoot, reason: 'outside-root' },
      { entryPath: paths.managedRoot, reason: 'outside-root' },
      { entryPath: path.join(realRoot, '..'), reason: 'outside-root' },
      { entryPath: path.join(realRoot, '..', 'prefix-registry.json'), reason: 'outside-root' },
      { entryPath: outside, reason: 'outside-root' },
      { entryPath: sibling, reason: 'outside-root' },
      { entryPath: 'relative/path', reason: 'outside-root' },
      { entryPath: path.join(realRoot, 'escape'), name: 'escape', reason: 'symlink' },
      { entryPath: path.join(realRoot, 'escape', 'precious.txt'), name: 'precious.txt', reason: 'not-managed' },
    ];
    for (const c of cases) {
      tamper(c.entryPath, c.name);
      expect(await registry.delete(TAMPER_ID), c.entryPath).toEqual({ ok: false, reason: c.reason });
      expect(registry.backup(TAMPER_ID), c.entryPath).toEqual({ ok: false, reason: c.reason });
      expect(registry.list()).toHaveLength(1);
    }
    expect(trashItem).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(paths.backupsRoot) ? fs.readdirSync(paths.backupsRoot) : []).toEqual([]);
  });

  it('refuses an entry whose own path is a symlink, even to a folder inside the root', async () => {
    const target = registry.create('real');
    if (!target.ok) throw new Error('setup failed');
    const linkPath = path.join(fs.realpathSync(paths.managedRoot), 'alias');
    fs.symlinkSync(target.prefix.path, linkPath);
    writeRegistry([{ id: TAMPER_ID, name: 'alias', path: linkPath, createdAt: new Date(0).toISOString() }]);
    expect(await registry.delete(TAMPER_ID)).toEqual({ ok: false, reason: 'symlink' });
    expect(registry.backup(TAMPER_ID)).toEqual({ ok: false, reason: 'symlink' });
    expect(trashItem).not.toHaveBeenCalled();
  });

  it('refuses an entry whose path belongs to a different name', async () => {
    const a = registry.create('alpha');
    if (!a.ok) throw new Error('setup failed');
    writeRegistry([a.prefix, { id: TAMPER_ID, name: 'beta', path: a.prefix.path, createdAt: a.prefix.createdAt }]);
    expect(await registry.delete(TAMPER_ID)).toEqual({ ok: false, reason: 'not-managed' });
    expect(trashItem).not.toHaveBeenCalled();
  });

  it('reports not-found when a registered folder is gone, and not-managed for a file', async () => {
    fs.mkdirSync(paths.managedRoot, { recursive: true });
    const realRoot = fs.realpathSync(paths.managedRoot);
    tamper(path.join(realRoot, 'gone'), 'gone');
    expect(await registry.delete(TAMPER_ID)).toEqual({ ok: false, reason: 'not-found' });
    fs.writeFileSync(path.join(realRoot, 'file'), '');
    tamper(path.join(realRoot, 'file'), 'file');
    expect(await registry.delete(TAMPER_ID)).toEqual({ ok: false, reason: 'not-managed' });
    expect(trashItem).not.toHaveBeenCalled();
  });

  it('keeps the entry and returns trash-failed when trashItem rejects', async () => {
    const created = registry.create('stuck');
    if (!created.ok) throw new Error('setup failed');
    trashItem.mockRejectedValueOnce(new Error('EACCES: secret /raw/os/path'));
    const res = await registry.delete(created.prefix.id);
    expect(res).toEqual({ ok: false, reason: 'trash-failed' });
    expect(JSON.stringify(res)).not.toContain('EACCES');
    expect(logs.some((m) => m.includes('EACCES'))).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('backs up into the backups folder without following symlinks inside the prefix', () => {
    const created = registry.create('saved');
    if (!created.ok) throw new Error('setup failed');
    const outside = mkTemp('dune-prefix-outside-');
    fs.writeFileSync(path.join(outside, 'big.bin'), 'outside');
    fs.writeFileSync(path.join(created.prefix.path, 'drive_c', 'game.cfg'), 'cfg');
    fs.mkdirSync(path.join(created.prefix.path, 'dosdevices'));
    fs.symlinkSync(outside, path.join(created.prefix.path, 'dosdevices', 'z:'));

    const res = registry.backup(created.prefix.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isStrictlyInside(res.backupPath, fs.realpathSync(paths.backupsRoot))).toBe(true);
    expect(path.dirname(res.backupPath)).toBe(fs.realpathSync(paths.backupsRoot));
    expect(path.basename(res.backupPath).startsWith('saved-')).toBe(true);
    expect(fs.readFileSync(path.join(res.backupPath, 'drive_c', 'game.cfg'), 'utf8')).toBe('cfg');
    const link = path.join(res.backupPath, 'dosdevices', 'z:');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(outside);
    // The backup is not registered as a prefix.
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects overlapping or protected roots at construction', () => {
    const u = path.join(base, 'u');
    expect(() => new PrefixRegistry({ ...paths, backupsRoot: path.join(paths.managedRoot, 'b') }, { trashItem })).toThrow();
    expect(() => new PrefixRegistry({ ...paths, backupsRoot: paths.managedRoot }, { trashItem })).toThrow();
    expect(() => new PrefixRegistry({ ...paths, managedRoot: os.homedir() }, { trashItem })).toThrow();
    expect(() => new PrefixRegistry({ ...paths, managedRoot: '/' }, { trashItem })).toThrow();
    expect(() => new PrefixRegistry({ ...paths, managedRoot: 'rel' }, { trashItem })).toThrow();
    expect(() => new PrefixRegistry(defaultPrefixRegistryPaths(u), { trashItem })).not.toThrow();
  });

  it('ignores a corrupt registry file', () => {
    fs.writeFileSync(paths.registryFile, '{not json');
    expect(registry.list()).toEqual([]);
    writeRegistry([{ id: 'x', name: '../bad', path: '/', createdAt: 'now' }, null, 3]);
    expect(registry.list()).toEqual([]);
  });

  describe('IPC handlers', () => {
    it('ignore extra renderer args, so a path can never be passed', async () => {
      const handlers = createPrefixIpcHandlers(() => registry, (m) => logs.push(m));
      const event = {};
      const elsewhere = mkTemp('dune-prefix-elsewhere-');

      const created = await (handlers.create as (...args: unknown[]) => ReturnType<typeof handlers.create>)(event, 'ipc-made', elsewhere);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(path.dirname(created.prefix.path)).toBe(fs.realpathSync(paths.managedRoot));
      expect(fs.readdirSync(elsewhere)).toEqual([]);

      expect(await handlers.create(event, elsewhere)).toEqual({ ok: false, reason: 'invalid-name' });
      expect(await handlers.create(event, '../../escape')).toEqual({ ok: false, reason: 'invalid-name' });
      expect(await handlers.delete(event, elsewhere)).toEqual({ ok: false, reason: 'not-found' });
      expect(await handlers.delete(event, os.homedir())).toEqual({ ok: false, reason: 'not-found' });
      expect(await handlers.backup(event, elsewhere)).toEqual({ ok: false, reason: 'not-found' });

      const backupFn = handlers.backup as (...args: unknown[]) => ReturnType<typeof handlers.backup>;
      const backup = await backupFn(event, created.prefix.id, elsewhere);
      expect(backup.ok).toBe(true);
      if (backup.ok) expect(path.dirname(backup.backupPath)).toBe(fs.realpathSync(paths.backupsRoot));
      expect(fs.readdirSync(elsewhere)).toEqual([]);

      const deleteFn = handlers.delete as (...args: unknown[]) => ReturnType<typeof handlers.delete>;
      expect(await deleteFn(event, created.prefix.id, '/', os.homedir())).toEqual({ ok: true, trashedPath: created.prefix.path });
      expect(trashItem).toHaveBeenCalledTimes(1);
      expect(trashItem).toHaveBeenCalledWith(created.prefix.path);
      expect(await handlers.list()).toEqual([]);
    });

    it('map unexpected throws to a fixed error code', async () => {
      const handlers = createPrefixIpcHandlers(() => { throw new Error('boom /raw'); }, (m) => logs.push(m));
      expect(await handlers.list()).toEqual([]);
      expect(await handlers.create({}, 'x')).toEqual({ ok: false, reason: 'error' });
      expect(await handlers.delete({}, TAMPER_ID)).toEqual({ ok: false, reason: 'error' });
      expect(await handlers.backup({}, TAMPER_ID)).toEqual({ ok: false, reason: 'error' });
      expect(logs.every((m) => m.includes('boom'))).toBe(true);
    });
  });
});

describe('isStrictlyInside', () => {
  it('is separator-aware and excludes the root itself', () => {
    expect(isStrictlyInside('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(isStrictlyInside('/a/b', '/a/b', 'linux')).toBe(false);
    expect(isStrictlyInside('/a/b/', '/a/b', 'linux')).toBe(false);
    expect(isStrictlyInside('/a/bc', '/a/b', 'linux')).toBe(false);
    expect(isStrictlyInside('/a/b/../c', '/a/b', 'linux')).toBe(false);
    expect(isStrictlyInside('/a/b/..c', '/a/b', 'linux')).toBe(true);
    expect(isStrictlyInside('/', '/a', 'linux')).toBe(false);
    expect(isStrictlyInside('/A/B/c', '/a/b', 'linux')).toBe(false);
  });

  it('is case-insensitive on win32', () => {
    expect(isStrictlyInside('C:\\Users\\Me\\AppData\\Dune\\Prefixes\\x', 'c:\\users\\me\\appdata\\dune\\prefixes', 'win32')).toBe(true);
    expect(isStrictlyInside('C:\\DUNE\\PREFIXES', 'c:\\dune\\prefixes', 'win32')).toBe(false);
    expect(isStrictlyInside('c:\\dune\\prefixes-evil\\x', 'C:\\Dune\\Prefixes', 'win32')).toBe(false);
    expect(isStrictlyInside('D:\\dune\\prefixes\\x', 'C:\\dune\\prefixes', 'win32')).toBe(false);
  });
});
