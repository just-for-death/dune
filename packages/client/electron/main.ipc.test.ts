import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// main.ts needs Electron, so this harness loads it with Electron, the store and
// the updater faked, HOME pointed at a temp dir, and captures its IPC handlers.
// Nothing here reads or writes real saves, prefixes, Steam files or app data.
const h = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fsH = require('fs') as typeof import('fs');
  const osH = require('os') as typeof import('os');
  const pathH = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'dune-main-ipc-'));
  const home = pathH.join(root, 'home');
  fsH.mkdirSync(home, { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = pathH.join(home, 'AppData');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: Array<[string, unknown]> = [];
  const dialogs = {
    save: { canceled: false, filePath: '' as string | undefined },
    open: { canceled: false, filePaths: [] as string[] },
  };
  // Local providers (electron/providers): the real ones unless a test sets an override;
  // every overridden call is recorded. fetchArtViaServer calls are recorded too.
  const local = { override: null as Record<string, (...args: unknown[]) => unknown> | null, calls: [] as string[] };
  const serverArtCalls: number[] = [];
  return { root, home, saved, handlers, sent, dialogs, storeData: new Map<string, unknown>(), local, serverArtCalls };
});

/** A do-nothing object that tolerates any property access, call or `new`. */
function inert(): unknown {
  const cache = new Map<PropertyKey, unknown>();
  const target = function () { /* inert */ };
  const proxy: unknown = new Proxy(target, {
    get(_t, key) {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'send') return (channel: string, payload: unknown) => { h.sent.push([channel, payload]); };
      if (!cache.has(key)) cache.set(key, inert());
      return cache.get(key);
    },
    apply: () => proxy,
    construct: () => proxy as object,
  });
  return proxy;
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(h.root, 'electron', name),
    whenReady: () => Promise.resolve(),
    on: () => undefined,
    quit: () => undefined,
    isReady: () => false,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(channel, fn); },
    on: () => undefined,
  },
  dialog: {
    showSaveDialog: async () => h.dialogs.save,
    showOpenDialog: async () => h.dialogs.open,
    showErrorBox: () => undefined,
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  BrowserWindow: inert(),
  Tray: inert(),
  Menu: inert(),
  nativeImage: inert(),
  protocol: inert(),
  session: inert(),
  net: inert(),
  shell: inert(),
}));

vi.mock('electron-store', () => ({
  default: class FakeStore {
    path = path.join(h.root, 'store.json');
    constructor(opts: { defaults?: Record<string, unknown> }) {
      for (const [k, v] of Object.entries(opts?.defaults ?? {})) h.storeData.set(k, structuredClone(v));
    }
    get(key: string, fallback?: unknown) { return h.storeData.has(key) ? h.storeData.get(key) : fallback; }
    set(key: string, value: unknown) { h.storeData.set(key, value); }
    delete(key: string) { h.storeData.delete(key); }
  },
}));

vi.mock('electron-updater', () => ({ autoUpdater: inert() }));
// Startup must not look for Steam or migrate anything.
vi.mock('./scanner/steam', () => ({ getSteamPath: () => null, getInstalledSteamLibraryGames: () => [] }));
vi.mock('./scanner/migrateStore', () => ({ runStoredGamesMigration: async () => ({ status: 'skipped', changed: 0 }) }));

// game:fetchArt's network part is unit-tested in art/fetchArt.test.ts; here it
// only has to hand main's writeFile a target in thumbDir, like the real one.
vi.mock('./art/fetchArt', () => ({
  fetchArtViaServer: async (gameId: number, _name: string, deps: { thumbDir: string; writeFile: (f: string, d: Buffer) => void }) => {
    h.serverArtCalls.push(gameId);
    const target = path.join(deps.thumbDir, `${gameId}.webp`);
    deps.writeFile(target, Buffer.from('fetched-webp'));
    return { ok: true, thumbnail: `local://${target}` };
  },
}));

// Scoped: delegates to the real local providers unless a test sets h.local.override.
vi.mock('./providers/electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/electron')>();
  return {
    createElectronLocalProviders: (...args: Parameters<typeof actual.createElectronLocalProviders>) => {
      const real = actual.createElectronLocalProviders(...args);
      return new Proxy(real, {
        get(target, key, receiver) {
          const fake = typeof key === 'string' ? h.local.override?.[key] : undefined;
          if (!fake) return Reflect.get(target, key, receiver);
          return (...a: unknown[]) => { h.local.calls.push(String(key)); return fake(...a); };
        },
      });
    },
  };
});

const thumbDir = () => path.join(h.root, 'electron', 'userData', 'thumbnails');
async function invoke(channel: string, ...args: unknown[]) {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({ sender: {} }, ...args);
}

beforeAll(async () => {
  await import('./main');
  // whenReady().then(...) runs createWindow and creates thumbDir.
  for (let i = 0; i < 20 && !fs.existsSync(thumbDir()); i++) await new Promise((r) => setTimeout(r, 5));
});

afterAll(() => {
  for (const [k, v] of Object.entries(h.saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(h.root, { recursive: true, force: true });
});

beforeEach(() => { h.sent.length = 0; });

function game(id: number, name: string, linPath: string) {
  return { id, name, winPath: linPath, linPath, lastSync: 'Never', status: 'Pending Upload', thumbnail: '' };
}

describe('sync:export (DUN-080)', () => {
  let work: string;
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(h.root, 'export-'));
    h.dialogs.save = { canceled: false, filePath: path.join(work, 'backup.zip') };
  });

  it('fails with a clear error and writes nothing when the library is empty', async () => {
    h.storeData.set('games', []);
    const res = await invoke('sync:export') as { success: boolean; code?: string; message?: string };
    expect(res.success).toBe(false);
    expect(res.code).toBe('NOTHING_TO_EXPORT');
    expect(res.message).toMatch(/no games/);
    expect(fs.readdirSync(work)).toEqual([]);
  });

  it('fails when no game has save files (missing path, empty folder, blank path) and keeps an existing file untouched', async () => {
    fs.mkdirSync(path.join(work, 'empty-saves'));
    fs.writeFileSync(path.join(work, 'backup.zip'), 'previous archive');
    h.storeData.set('games', [
      game(1, 'Missing', path.join(work, 'does-not-exist')),
      game(2, 'Empty', path.join(work, 'empty-saves')),
      game(3, 'Blank', ''),
    ]);
    const res = await invoke('sync:export') as { success: boolean; code?: string; message?: string };
    expect(res.success).toBe(false);
    expect(res.code).toBe('NOTHING_TO_EXPORT');
    expect(res.message).toMatch(/none of your games has save files/);
    expect(fs.readFileSync(path.join(work, 'backup.zip'), 'utf8')).toBe('previous archive');
    expect(fs.readdirSync(work).sort()).toEqual(['backup.zip', 'empty-saves']);
  });

  it('archives folder and single-file saves, counts only games that were added, and leaves no temp file', async () => {
    const folder = path.join(work, 'hades');
    fs.mkdirSync(path.join(folder, 'slot1'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'slot1', 'Profile1.sav'), 'hades-save');
    const single = path.join(work, 'celeste.sav');
    fs.writeFileSync(single, 'celeste-save');
    h.storeData.set('games', [
      game(1, 'Hades', folder),
      game(2, 'Celeste', single),
      game(3, 'Missing', path.join(work, 'nope')),
    ]);
    const res = await invoke('sync:export') as { success: boolean; count?: number; path?: string; message?: string };
    expect(res).toMatchObject({ success: true, count: 2, path: path.join(work, 'backup.zip') });
    expect(res.message).toMatch(/2 game\(s\).*1 game\(s\) had no save files/);
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(path.join(work, 'backup.zip'));
    const files = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName).sort();
    expect(files).toEqual(['Celeste/celeste.sav', 'Hades/slot1/Profile1.sav']);
    expect(zip.readAsText('Hades/slot1/Profile1.sav')).toBe('hades-save');
    expect(fs.readdirSync(work).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('returns quietly when the save dialog is cancelled', async () => {
    h.dialogs.save = { canceled: true, filePath: undefined };
    expect(await invoke('sync:export')).toEqual({ success: false });
  });

  it('uses only the async adm-zip APIs (no synchronous zip work on the main thread)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    expect(src).not.toMatch(/\.writeZip\(|\.addLocalFolder\(|\.addLocalFile\(|\.toBuffer\(/);
    expect(src).toMatch(/writeZipPromise\(/);
    expect(src).toMatch(/addLocalFolderPromise\(/);
  });
});

describe('art slot (DUN-081)', () => {
  afterEach(() => {
    h.local.override = null;
    h.storeData.set('settings', { ...(h.storeData.get('settings') as object), artworkEnabled: false });
  });
  const slot = (id: number) => fs.readdirSync(thumbDir()).filter((f) => path.parse(f).name === String(id)).sort();
  let src: string;
  beforeEach(() => {
    for (const f of fs.readdirSync(thumbDir())) fs.rmSync(path.join(thumbDir(), f), { force: true });
    src = fs.mkdtempSync(path.join(h.root, 'art-src-'));
    h.storeData.set('games', [game(7, 'Hades', ''), game(17, 'Other', ''), game(70, 'Third', '')]);
  });

  it('custom art with a new extension replaces the old file for that game only', async () => {
    fs.writeFileSync(path.join(thumbDir(), '7.png'), 'old-png');
    fs.writeFileSync(path.join(thumbDir(), '7.GIF'), 'old-gif');
    fs.writeFileSync(path.join(thumbDir(), '17.png'), 'other-game');
    fs.writeFileSync(path.join(thumbDir(), '70.jpg'), 'third-game');
    fs.writeFileSync(path.join(thumbDir(), '7.txt'), 'not art');
    const pick = path.join(src, 'cover.JPG');
    fs.writeFileSync(pick, 'new-jpg');
    h.dialogs.open = { canceled: false, filePaths: [pick] };

    const res = await invoke('game:setCustomArt', 7);
    const target = path.join(thumbDir(), '7.jpg');
    expect(res).toBe(`local://${target}`);
    expect(slot(7)).toEqual(['7.jpg', '7.txt']);
    expect(fs.readFileSync(target, 'utf8')).toBe('new-jpg');
    expect(slot(17)).toEqual(['17.png']);
    expect(slot(70)).toEqual(['70.jpg']);
    expect((h.storeData.get('games') as Array<{ id: number; thumbnail: string }>).find((g) => g.id === 7)?.thumbnail).toBe(`local://${target}`);
    expect(fs.readFileSync(pick, 'utf8')).toBe('new-jpg');
  });

  it('re-saving with the same extension keeps exactly one file', async () => {
    fs.writeFileSync(path.join(thumbDir(), '7.png'), 'old');
    const pick = path.join(src, 'again.png');
    fs.writeFileSync(pick, 'new');
    h.dialogs.open = { canceled: false, filePaths: [pick] };
    await invoke('game:setCustomArt', 7);
    expect(slot(7)).toEqual(['7.png']);
    expect(fs.readFileSync(path.join(thumbDir(), '7.png'), 'utf8')).toBe('new');
  });

  it('keeps the old art when writing the new file fails', async () => {
    fs.writeFileSync(path.join(thumbDir(), '7.png'), 'old');
    h.dialogs.open = { canceled: false, filePaths: [path.join(src, 'missing.jpg')] };
    await expect(invoke('game:setCustomArt', 7)).rejects.toThrow();
    expect(slot(7)).toEqual(['7.png']);
  });

  it('fetched art with a different extension removes the old custom art', async () => {
    h.storeData.set('settings', { ...(h.storeData.get('settings') as object), artworkEnabled: true });
    h.local.override = localArtFake();
    fs.writeFileSync(path.join(thumbDir(), '7.png'), 'old-png');
    fs.writeFileSync(path.join(thumbDir(), '7.jpeg'), 'old-jpeg');
    const res = await invoke('game:fetchArt', 7) as { ok: boolean; thumbnail?: string };
    expect(res.ok).toBe(true);
    expect(slot(7)).toEqual(['7.webp']);
    expect(fs.readFileSync(path.join(thumbDir(), '7.webp'), 'utf8')).toBe('fetched-webp');
  });
});

/** Fake local SteamGridDB: one CDN result, a webp image. No network. */
function localArtFake(): Record<string, (...args: unknown[]) => unknown> {
  return {
    searchArt: async () => ({ ok: true, results: ['https://cdn2.steamgriddb.com/grid/x.webp'] }),
    downloadArt: async () => ({ ok: true, bytes: new TextEncoder().encode('fetched-webp'), contentType: 'image/webp', cached: false }),
  };
}

describe('game:fetchArt routing (server vs local)', () => {
  const thumbOf = (id: number) => (h.storeData.get('games') as Array<{ id: number; thumbnail: string }>).find((g) => g.id === id)?.thumbnail;
  const setArt = (on: boolean) => h.storeData.set('settings', { ...(h.storeData.get('settings') as object), artworkEnabled: on });
  /** Save a server URL through config:save and let the gate settle (fake timers; no request is made). */
  async function setServerUrl(url: string) {
    vi.useFakeTimers();
    try {
      await invoke('config:save', { cloud: { url } });
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
  }

  beforeEach(() => {
    for (const f of fs.readdirSync(thumbDir())) fs.rmSync(path.join(thumbDir(), f), { force: true });
    h.storeData.set('games', [game(7, 'Hades', '')]);
    h.local.calls.length = 0;
    h.serverArtCalls.length = 0;
  });
  afterEach(() => { h.local.override = null; setArt(false); });

  it('no server: uses the local providers and saves the art in the game slot', async () => {
    setArt(true);
    h.local.override = localArtFake();
    const res = await invoke('game:fetchArt', 7) as { ok: boolean; thumbnail?: string };
    const target = path.join(thumbDir(), '7.webp');
    expect(res).toEqual({ ok: true, thumbnail: `local://${target}` });
    expect(h.local.calls).toEqual(['searchArt', 'downloadArt']);
    expect(h.serverArtCalls).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('fetched-webp');
    expect(thumbOf(7)).toBe(`local://${target}`);
  });

  it('no server and artwork off: PROVIDER_DISABLED, no local or server call, nothing written', async () => {
    setArt(false);
    h.local.override = localArtFake();
    expect(await invoke('game:fetchArt', 7)).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
    expect(h.local.calls).toEqual([]);
    expect(h.serverArtCalls).toEqual([]);
    expect(fs.readdirSync(thumbDir())).toEqual([]);
  });

  it('server configured: uses fetchArtViaServer, not local, and ignores the local flag', async () => {
    setArt(false);
    h.local.override = localArtFake();
    await setServerUrl('http://127.0.0.1:9');
    try {
      const res = await invoke('game:fetchArt', 7) as { ok: boolean; thumbnail?: string };
      expect(res).toEqual({ ok: true, thumbnail: `local://${path.join(thumbDir(), '7.webp')}` });
      expect(h.serverArtCalls).toEqual([7]);
      expect(h.local.calls).toEqual([]);
    } finally {
      await setServerUrl('');
    }
    // Back to local mode for the rest of the file.
    expect(await invoke('game:fetchArt', 7)).toMatchObject({ ok: false, code: 'PROVIDER_DISABLED' });
  });
});

describe('test harness', () => {
  it('runs main against a temp HOME and temp userData only', () => {
    expect(os.homedir()).toBe(h.home);
    expect(thumbDir().startsWith(h.root)).toBe(true);
  });
});
