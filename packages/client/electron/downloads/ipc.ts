/**
 * IPC wiring for the downloads engine.
 *
 * Everything Electron-specific is injected (folder dialog, shell, the
 * window's webContents, the settings store), so this file has no Electron
 * import and is unit-tested with fakes. main.ts only registers the handlers
 * on ipcMain and passes the real objects in.
 *
 * Renderer input is untrusted: every argument is validated here, requests
 * are rebuilt from whitelisted fields, and the renderer never supplies a
 * path main opens or reveals by itself (the base dir and folder picks go
 * through main's own dialog; showInFolder looks the item up by id). A
 * `destDir` the renderer passes back is re-validated by the engine.
 */
import * as fs from 'fs';
import type {
  DownloadIpcFailure,
  DownloadIpcResult,
  DownloadRequest,
  DownloadSettings,
  DownloadSnapshot,
} from '@dune/shared';
import { toDownloadError } from './errors';
import { DownloadManager, MAX_CONCURRENCY } from './manager';
import { resolveExistingDir } from './safePath';
import type { DownloadManagerOptions } from './manager';

/** invoke() channels, renderer -> main. */
export const DOWNLOAD_CHANNELS = {
  list: 'downloads:list',
  add: 'downloads:add',
  pause: 'downloads:pause',
  resume: 'downloads:resume',
  cancel: 'downloads:cancel',
  retry: 'downloads:retry',
  remove: 'downloads:remove',
  setConcurrency: 'downloads:setConcurrency',
  setAutoResume: 'downloads:setAutoResume',
  getSettings: 'downloads:getSettings',
  chooseBaseDir: 'downloads:chooseBaseDir',
  chooseFolder: 'downloads:chooseFolder',
  showInFolder: 'downloads:showInFolder',
} as const;

/** Push events, main -> renderer. */
export const DOWNLOAD_EVENTS = {
  progress: 'downloads:progress',
  status: 'downloads:status',
  completed: 'downloads:completed',
  failed: 'downloads:failed',
} as const;

export type DownloadManagerLike = Pick<
  DownloadManager,
  'list' | 'get' | 'add' | 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'setConcurrency' | 'setAutoResume' | 'getSettings' | 'setBaseDir' | 'on' | 'close'
>;

export interface FolderDialogOptions {
  title: string;
  defaultPath?: string;
  properties: Array<'openDirectory' | 'createDirectory'>;
}
export type FolderDialog = (options: FolderDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;

export interface ShellLike {
  showItemInFolder(fullPath: string): void;
  /** Resolves to '' on success or an error message (Electron's shell.openPath). */
  openPath(fullPath: string): Promise<string>;
}

export interface WebContentsLike {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

/** What main persists for downloads (its own key in the electron-store). */
export interface DownloadsStoredSettings {
  baseDir?: string;
  concurrency?: number;
  autoResume?: boolean;
}

export interface DownloadsSettingsStore {
  get(): DownloadsStoredSettings;
  set(value: DownloadsStoredSettings): void;
}

export interface DownloadsIpcDeps {
  /** null until the manager has opened (or if it failed to). */
  getManager: () => DownloadManagerLike | null;
  showFolderDialog: FolderDialog;
  shell: ShellLike;
  settings: DownloadsSettingsStore;
}

type Handler = (event: unknown, ...args: unknown[]) => Promise<DownloadIpcResult<object>>;

const MAX_ID = 128;
const MAX_URL = 8192;
const MAX_PATHISH = 4096;
const MAX_META_KEYS = 32;
const MAX_META_STRING = 1024;
const CHECKSUM_ALGORITHMS = ['sha256', 'sha1', 'md5'];

function bad(message: string): DownloadIpcFailure {
  return { ok: false, code: 'INVALID_ARGUMENT', message };
}

class ArgError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function parseId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > MAX_ID || !/^[A-Za-z0-9_-]+$/.test(v)) throw new ArgError('id must be a download id string');
  return v;
}

function optString(o: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new ArgError(`${key} must be a string of at most ${max} characters`);
  return v;
}

/** Rebuild a DownloadRequest from whitelisted, type-checked fields. */
export function parseDownloadRequest(v: unknown): DownloadRequest {
  if (!isPlainObject(v)) throw new ArgError('request must be an object');
  const url = v.url;
  if (typeof url !== 'string' || !url || url.length > MAX_URL) throw new ArgError(`url must be a non-empty string of at most ${MAX_URL} characters`);
  const req: DownloadRequest = { url };
  for (const key of ['fileName', 'source', 'destDir', 'subdir'] as const) {
    const s = optString(v, key, MAX_PATHISH);
    if (s !== undefined) req[key] = s;
  }
  if (v.checksum !== undefined) {
    const c = v.checksum;
    if (!isPlainObject(c) || typeof c.algorithm !== 'string' || !CHECKSUM_ALGORITHMS.includes(c.algorithm) || typeof c.value !== 'string' || c.value.length > 256) {
      throw new ArgError('checksum must be { algorithm: sha256|sha1|md5, value: hex string }');
    }
    req.checksum = { algorithm: c.algorithm as 'sha256' | 'sha1' | 'md5', value: c.value };
  }
  if (v.expectedSize !== undefined) {
    if (typeof v.expectedSize !== 'number' || !Number.isSafeInteger(v.expectedSize) || v.expectedSize < 0) throw new ArgError('expectedSize must be a non-negative integer');
    req.expectedSize = v.expectedSize;
  }
  if (v.overwrite !== undefined) {
    if (typeof v.overwrite !== 'boolean') throw new ArgError('overwrite must be a boolean');
    req.overwrite = v.overwrite;
  }
  if (v.meta !== undefined) {
    if (!isPlainObject(v.meta)) throw new ArgError('meta must be a plain object');
    const entries = Object.entries(v.meta);
    if (entries.length > MAX_META_KEYS) throw new ArgError(`meta may have at most ${MAX_META_KEYS} keys`);
    const meta: Record<string, string | number | boolean | null> = {};
    for (const [k, val] of entries) {
      const okVal = val === null || typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val)) || (typeof val === 'string' && val.length <= MAX_META_STRING);
      if (k.length > 128 || !okVal) throw new ArgError('meta values must be short strings, finite numbers, booleans or null');
      meta[k] = val as string | number | boolean | null;
    }
    req.meta = meta;
  }
  return req;
}

function parseConcurrency(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_CONCURRENCY) throw new ArgError(`concurrency must be an integer 1-${MAX_CONCURRENCY}`);
  return v;
}

async function isFile(p: string): Promise<boolean> {
  const st = await fs.promises.lstat(p).catch(() => null);
  return !!st?.isFile();
}

async function isDir(p: string): Promise<boolean> {
  const st = await fs.promises.stat(p).catch(() => null);
  return !!st?.isDirectory();
}

export function createDownloadsIpcHandlers(deps: DownloadsIpcDeps): Record<string, Handler> {
  /** Run `fn` with the manager; argument errors become INVALID_ARGUMENT, anything unexpected IO_ERROR. */
  const withManager = <A extends unknown[]>(fn: (m: DownloadManagerLike, ...args: A) => Promise<DownloadIpcResult<object>>): Handler =>
    async (_event, ...args) => {
      const m = deps.getManager();
      if (!m) return { ok: false, code: 'NOT_READY', message: 'Downloads are not ready yet' };
      try {
        return await fn(m, ...(args as A));
      } catch (err) {
        if (err instanceof ArgError) return bad(err.message);
        return toDownloadError(err, 'IO_ERROR').toFailure();
      }
    };

  const persist = (patch: DownloadsStoredSettings) => deps.settings.set({ ...deps.settings.get(), ...patch });

  const flat = (settings: DownloadSettings): DownloadIpcResult<DownloadSettings> => ({ ok: true, ...settings });

  const itemAction = (action: 'pause' | 'resume' | 'cancel' | 'retry') =>
    withManager(async (m, rawId: unknown): Promise<DownloadIpcResult<{ item: DownloadSnapshot }>> => {
      const id = parseId(rawId);
      const res = await m[action](id);
      if (!res.ok) return res;
      const item = m.get(id);
      return item ? { ok: true, item } : { ok: false, code: 'NOT_FOUND', message: 'No such download' };
    });

  const pickFolder = async (title: string, defaultPath?: string): Promise<string | null> => {
    const { canceled, filePaths } = await deps.showFolderDialog({ title, ...(defaultPath ? { defaultPath } : {}), properties: ['openDirectory', 'createDirectory'] });
    return canceled || !filePaths?.length ? null : filePaths[0];
  };

  const cancelled: DownloadIpcFailure = { ok: false, code: 'CANCELLED', message: 'No folder was chosen' };

  return {
    [DOWNLOAD_CHANNELS.list]: withManager(async (m) => ({ ok: true, items: m.list() })),

    [DOWNLOAD_CHANNELS.add]: withManager(async (m, raw: unknown) => m.add(parseDownloadRequest(raw))),

    [DOWNLOAD_CHANNELS.pause]: itemAction('pause'),
    [DOWNLOAD_CHANNELS.resume]: itemAction('resume'),
    [DOWNLOAD_CHANNELS.cancel]: itemAction('cancel'),
    [DOWNLOAD_CHANNELS.retry]: itemAction('retry'),

    [DOWNLOAD_CHANNELS.remove]: withManager(async (m, rawId: unknown): Promise<DownloadIpcResult<{ item: DownloadSnapshot }>> => {
      const id = parseId(rawId);
      const item = m.get(id);
      const res = await m.remove(id);
      if (!res.ok) return res;
      return item ? { ok: true, item } : { ok: false, code: 'NOT_FOUND', message: 'No such download' };
    }),

    [DOWNLOAD_CHANNELS.setConcurrency]: withManager(async (m, raw: unknown) => {
      const n = parseConcurrency(raw);
      const res = m.setConcurrency(n);
      if (!res.ok) return res;
      persist({ concurrency: n });
      return flat(m.getSettings());
    }),

    [DOWNLOAD_CHANNELS.setAutoResume]: withManager(async (m, raw: unknown) => {
      if (typeof raw !== 'boolean') throw new ArgError('enabled must be true or false');
      const res = m.setAutoResume(raw);
      if (!res.ok) return res;
      persist({ autoResume: raw });
      return flat(res.settings);
    }),

    [DOWNLOAD_CHANNELS.getSettings]: withManager(async (m) => flat(m.getSettings())),

    [DOWNLOAD_CHANNELS.chooseBaseDir]: withManager(async (m) => {
      const picked = await pickFolder('Choose the download folder', m.getSettings().baseDir);
      if (!picked) return cancelled;
      const res = await m.setBaseDir(picked);
      if (!res.ok) return res;
      persist({ baseDir: res.settings.baseDir });
      return flat(res.settings);
    }),

    [DOWNLOAD_CHANNELS.chooseFolder]: withManager(async (m): Promise<DownloadIpcResult<{ path: string }>> => {
      const picked = await pickFolder('Choose a folder for this download', m.getSettings().baseDir);
      if (!picked) return cancelled;
      return { ok: true, path: await resolveExistingDir(picked, 'destDir') };
    }),

    [DOWNLOAD_CHANNELS.showInFolder]: withManager(async (m, rawId: unknown): Promise<DownloadIpcResult> => {
      const item = m.get(parseId(rawId));
      if (!item) return { ok: false, code: 'NOT_FOUND', message: 'No such download' };
      if (item.status === 'completed' && (await isFile(item.destPath))) {
        deps.shell.showItemInFolder(item.destPath);
        return { ok: true };
      }
      if (!(await isDir(item.root))) return { ok: false, code: 'IO_ERROR', message: `Download folder not found: ${item.root}` };
      const error = await deps.shell.openPath(item.root);
      return error ? { ok: false, code: 'IO_ERROR', message: error } : { ok: true };
    }),
  };
}

/**
 * Forward manager events to the renderer, each carrying a full
 * DownloadSnapshot. `getWebContents` is read on every event, so a re-created
 * window gets them and a destroyed one is skipped. Returns an unsubscribe.
 */
export function forwardDownloadEvents(manager: DownloadManagerLike, getWebContents: () => WebContentsLike | null | undefined): () => void {
  const send = (channel: string, payload: unknown) => {
    const wc = getWebContents();
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(channel, payload);
    } catch {
      // The window went away between the check and the send.
    }
  };
  const offs = [
    manager.on('progress', (progress) => {
      const item = manager.get(progress.id);
      if (item) send(DOWNLOAD_EVENTS.progress, { item });
    }),
    manager.on('status', (item, previous) => send(DOWNLOAD_EVENTS.status, { item, previous })),
    manager.on('completed', (item) => send(DOWNLOAD_EVENTS.completed, { item })),
    manager.on('failed', (item, error) => send(DOWNLOAD_EVENTS.failed, { item, error })),
  ];
  return () => offs.forEach((off) => off());
}

export interface OpenDownloadsOptions {
  settings: DownloadsSettingsStore;
  /** e.g. `<app downloads>/Dune`; created once, at first setup only. */
  defaultBaseDir: string;
  stateDir: string;
  /** Injected for tests. */
  open?: (opts: DownloadManagerOptions) => Promise<DownloadManagerLike>;
}

/**
 * Open the manager with the saved base dir and concurrency. Only when no base
 * dir was ever saved is the default folder created (its parent must exist)
 * and remembered; a saved base dir that has gone missing is never recreated,
 * so adds fail with "Download folder not found" until it is back or another
 * folder is chosen.
 */
export async function openDownloads(o: OpenDownloadsOptions): Promise<DownloadManagerLike> {
  const saved = o.settings.get();
  let baseDir = typeof saved.baseDir === 'string' && saved.baseDir ? saved.baseDir : undefined;
  if (!baseDir) {
    baseDir = o.defaultBaseDir;
    const created = await fs.promises.mkdir(o.defaultBaseDir).then(
      () => true,
      (err: NodeJS.ErrnoException) => err.code === 'EEXIST',
    );
    if (created && (await isDir(o.defaultBaseDir))) {
      baseDir = await fs.promises.realpath(o.defaultBaseDir);
      o.settings.set({ ...saved, baseDir });
    }
  }
  const concurrency = typeof saved.concurrency === 'number' && Number.isInteger(saved.concurrency) && saved.concurrency >= 1 && saved.concurrency <= MAX_CONCURRENCY
    ? saved.concurrency
    : undefined;
  const open = o.open ?? ((opts: DownloadManagerOptions) => DownloadManager.open(opts));
  return open({ baseDir, stateDir: o.stateDir, ...(concurrency ? { concurrency } : {}), autoResume: saved.autoResume === true });
}

/**
 * `before-quit` listener: the first quit is held (preventDefault) until the
 * manager has closed (in-flight items saved as paused), then `quit()` is
 * called again and goes through. A close that hangs is cut off after
 * `timeoutMs` so quitting never gets stuck.
 */
export function createDownloadsQuitHandler(getManager: () => DownloadManagerLike | null, quit: () => void, timeoutMs = 5000): (event: { preventDefault(): void }) => void {
  let state: 'idle' | 'closing' | 'done' = 'idle';
  return (event) => {
    if (state === 'done') return;
    const m = getManager();
    if (!m) return;
    event.preventDefault();
    if (state === 'closing') return;
    state = 'closing';
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
    });
    void Promise.race([m.close().catch(() => undefined), timeout]).then(() => {
      state = 'done';
      quit();
    });
  };
}
