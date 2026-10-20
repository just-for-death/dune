import { describe, it, expect, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate config + DB side effects BEFORE importing app modules.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-tracker-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'tracker-test-secret-0123456789abcdef';
process.env.DUNE_CONFIG_DIR = path.join(TMP, 'config');

const { FolderTracker } = await import('./folderTracker.js');

const trackers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (trackers.length > 0) trackers.pop()?.stop();
  for (const entry of fs.readdirSync(TMP)) {
    if (entry === 'config') continue;
    fs.rmSync(path.join(TMP, entry), { recursive: true, force: true });
  }
});

// DUN-022: this file used to leak its temp dir (one /tmp/dune-tracker-test-* per run).
afterAll(() => {
  while (trackers.length > 0) trackers.pop()?.stop();
  process.env.DATA_DIR = SETUP_DATA_DIR;
  delete process.env.API_KEY_SECRET;
  delete process.env.DUNE_CONFIG_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeGameDir(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'saves', 'slot1.sav'), 'data');
  return dir;
}

describe('FolderTracker', () => {
  it('scans a root and finds a game by markers', async () => {
    const root = path.join(TMP, 'steamapps', 'common');
    fs.mkdirSync(root, { recursive: true });
    makeGameDir(root, 'FakeQuest');
    fs.mkdirSync(path.join(root, 'EmptyDir'), { recursive: true });

    const tracker = new FolderTracker({ watchDirs: [root] });
    trackers.push(tracker);
    const folder = await tracker.scanDirectory(root);
    expect(folder).not.toBeNull();
    expect(folder?.platform).toBe('steam');
    expect(folder?.gameFolders.map((g) => g.name)).toContain('FakeQuest');
    expect(folder?.gameFolders.map((g) => g.name)).not.toContain('EmptyDir');
    expect(folder?.totalSize).toBeGreaterThan(0);
  });

  it('returns null for missing directories', async () => {
    const tracker = new FolderTracker({ watchDirs: [] });
    trackers.push(tracker);
    await expect(tracker.scanDirectory(path.join(TMP, 'nope'))).resolves.toBeNull();
  });

  it('generates stable, distinct ids per path', async () => {
    const root = path.join(TMP, 'lib');
    fs.mkdirSync(root, { recursive: true });
    const tracker = new FolderTracker({ watchDirs: [] });
    trackers.push(tracker);
    const a = await tracker.scanDirectory(root);
    const b = await tracker.scanDirectory(root);
    expect(a?.id).toBe(b?.id);
    const other = path.join(TMP, 'other');
    fs.mkdirSync(other, { recursive: true });
    const c = await tracker.scanDirectory(other);
    expect(c?.id).not.toBe(a?.id);
  });

  it('scanAll aggregates every watched dir', async () => {
    const r1 = path.join(TMP, 'lib1');
    const r2 = path.join(TMP, 'lib2');
    fs.mkdirSync(r1, { recursive: true });
    fs.mkdirSync(r2, { recursive: true });
    makeGameDir(r1, 'QuestOne');
    const tracker = new FolderTracker({ watchDirs: [r1, r2] });
    trackers.push(tracker);
    const all = await tracker.scanAll();
    // NOTE: getWatchDirs() also merges existing default game dirs
    // (e.g. ~/Games), so assert containment, not exact count.
    const paths = all.map((f) => f.path);
    expect(paths).toContain(r1);
    expect(paths).toContain(r2);
    const one = all.find((f) => f.path === r1);
    expect(one?.gameFolders.map((g) => g.name)).toContain('QuestOne');
  });

  it('removeFolder drops state and closes the watcher', async () => {
    const root = path.join(TMP, 'watched');
    fs.mkdirSync(root, { recursive: true });
    const tracker = new FolderTracker({ watchDirs: [root] });
    trackers.push(tracker);
    await tracker.scanDirectory(root);
    expect(tracker.getFolder(root)).toBeDefined();
    expect(tracker.removeFolder(root)).toBe(true);
    expect(tracker.getFolder(root)).toBeUndefined();
  });

  it('refreshWatchers drops dirs that no longer exist', async () => {
    const r1 = path.join(TMP, 'w1');
    const r2 = path.join(TMP, 'w2');
    fs.mkdirSync(r1, { recursive: true });
    fs.mkdirSync(r2, { recursive: true });
    const tracker = new FolderTracker({ watchDirs: [r1, r2] });
    trackers.push(tracker);
    await tracker.scanAll();
    expect(tracker.getFolders().map((f) => f.path)).toContain(r2);
    fs.rmSync(r2, { recursive: true, force: true });
    const all = await tracker.refreshWatchers();
    expect(all.map((f) => f.path)).toContain(r1);
    expect(all.map((f) => f.path)).not.toContain(r2);
  });

  it('stop() clears timers and watchers without throwing', async () => {
    const root = path.join(TMP, 'stopme');
    fs.mkdirSync(root, { recursive: true });
    const tracker = new FolderTracker({ watchDirs: [root] });
    tracker.startAutoScan();
    tracker.stop();
    expect(() => tracker.stop()).not.toThrow();
    expect(tracker.getFolders().length).toBe(0);
  });

  it('emits folderScanned and tolerates non-directory paths', async () => {
    const tracker = new FolderTracker({ watchDirs: [] });
    trackers.push(tracker);
    let seen: string | null = null;
    tracker.on('folderScanned', (folder: { path: string }) => {
      seen = folder.path;
    });
    // A file path has no game children but still scans without throwing,
    // even with no 'error' listener attached (emit guard).
    const file = path.join(TMP, 'afile.txt');
    fs.writeFileSync(file, 'x');
    const result = await tracker.scanDirectory(file);
    expect(result).not.toBeNull();
    expect(result?.gameFolders).toEqual([]);
    expect(seen).toBe(file);
  });

  it('refreshFolder rescans a single dir', async () => {
    const root = path.join(TMP, 'refresh-me');
    fs.mkdirSync(root, { recursive: true });
    makeGameDir(root, 'RefreshQuest');
    const tracker = new FolderTracker({ watchDirs: [] });
    trackers.push(tracker);
    const folder = await tracker.refreshFolder(root);
    expect(folder?.gameFolders.map((g) => g.name)).toContain('RefreshQuest');
  });

  it('singletons share one instance', async () => {
    const mod = await import('./folderTracker.js');
    const a = mod.initFolderTracker({ watchDirs: [] });
    const b = mod.initFolderTracker({ watchDirs: [] });
    expect(b).toBe(a);
    expect(mod.getFolderTracker()).toBe(a);
    expect(Array.isArray(mod.getTrackedFolders())).toBe(true);
    a.stop();
  });

  it('subscribeToConfigChanges is a safe no-op when stopped fast', async () => {
    const tracker = new FolderTracker({ watchDirs: [] });
    trackers.push(tracker);
    tracker.subscribeToConfigChanges();
    tracker.subscribeToConfigChanges();
    tracker.stop();
    // Let the pending dynamic import resolve after stop (must not throw).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { initConfig } = await import('../utils/config.js');
    initConfig().stop();
  });

  it('picks up new watchDirs after a config hot-reload', async () => {
    const { initConfig } = await import('../utils/config.js');
    const mgr = initConfig();
    try {
      const extra = path.join(TMP, 'hot-added');
      fs.mkdirSync(extra, { recursive: true });
      const tracker = new FolderTracker({ watchDirs: [] });
      trackers.push(tracker);
      tracker.subscribeToConfigChanges();
      // Wait for the async subscription to attach.
      await new Promise((resolve) => setTimeout(resolve, 300));
      mgr.updateConfig({ data: { watchDirs: [extra] } } as Partial<import('../utils/config.js').DuneConfig> );
      // updateConfig emits synchronously, but the tracker debounces 500ms.
      await new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (tracker.getFolders().some((f) => f.path === extra)) return resolve(undefined);
          if (Date.now() - start > 8000) return reject(new Error('tracker did not pick up hot-added dir'));
          setTimeout(tick, 100);
        };
        tick();
      });
      expect(tracker.getFolders().map((f) => f.path)).toContain(extra);
    } finally {
      mgr.stop();
    }
  });
});
