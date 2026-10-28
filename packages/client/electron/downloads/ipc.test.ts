import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DownloadSettings, DownloadSnapshot } from '@dune/shared';
import { TypedEmitter } from './emitter';
import {
  DOWNLOAD_CHANNELS,
  DOWNLOAD_EVENTS,
  createDownloadsIpcHandlers,
  createDownloadsQuitHandler,
  forwardDownloadEvents,
  openDownloads,
  type DownloadManagerLike,
  type DownloadsStoredSettings,
  type FolderDialogOptions,
  type WebContentsLike,
} from './ipc';
import type { DownloadManagerOptions } from './manager';
import type { DownloadEvents } from './types';

// Fakes only: no Electron, no network, temp folders under os.tmpdir().

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dl-ipc-'));
  tmpDirs.push(d);
  return d;
};

function snap(id: string, over: Partial<DownloadSnapshot> = {}): DownloadSnapshot {
  const root = over.root ?? '/nonexistent-root';
  const destPath = over.destPath ?? path.join(root, `${id}.bin`);
  return {
    id, url: `http://127.0.0.1/${id}`, destPath, partPath: `${destPath}.part`, root, status: 'queued', seq: 0,
    bytesDownloaded: 0, totalBytes: null, attempts: 0, createdAt: 'x', updatedAt: 'x',
    name: path.basename(destPath), host: '127.0.0.1', receivedBytes: 0, speed: 0, eta: null, errorCode: null,
    ...over,
  };
}

class FakeManager extends TypedEmitter<DownloadEvents> {
  items = new Map<string, DownloadSnapshot>();
  settings: DownloadSettings = { baseDir: '/base', concurrency: 2, maxConcurrency: 16, autoResume: false };
  calls: Array<[string, ...unknown[]]> = [];
  failNext: { ok: false; code: string; message: string } | null = null;
  throwNext = false;

  private act<T>(name: string, args: unknown[], ok: () => T) {
    this.calls.push([name, ...args]);
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('boom');
    }
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return f as never;
    }
    return ok();
  }

  fire<K extends keyof DownloadEvents>(event: K, ...args: Parameters<DownloadEvents[K]>) {
    this.emit(event, ...args);
  }

  list = () => [...this.items.values()];
  get = (id: string) => this.items.get(id);
  add = async (req: Parameters<DownloadManagerLike['add']>[0]) => this.act('add', [req], () => {
    const item = snap('new1');
    this.items.set(item.id, item);
    return { ok: true as const, item };
  });
  pause = async (id: string) => this.act('pause', [id], () => {
    this.items.set(id, { ...this.items.get(id)!, status: 'paused' });
    return { ok: true as const };
  });
  resume = async (id: string) => this.act('resume', [id], () => ({ ok: true as const }));
  cancel = async (id: string) => this.act('cancel', [id], () => ({ ok: true as const }));
  retry = async (id: string) => this.act('retry', [id], () => ({ ok: true as const }));
  remove = async (id: string) => this.act('remove', [id], () => {
    this.items.delete(id);
    return { ok: true as const };
  });
  setConcurrency = (n: number) => this.act('setConcurrency', [n], () => {
    this.settings = { ...this.settings, concurrency: n };
    return { ok: true as const };
  });
  setAutoResume = (enabled: boolean) => this.act('setAutoResume', [enabled], () => {
    this.settings = { ...this.settings, autoResume: enabled };
    return { ok: true as const, settings: this.settings };
  });
  getSettings = () => this.settings;
  setBaseDir = async (dir: string) => this.act('setBaseDir', [dir], () => {
    this.settings = { ...this.settings, baseDir: `/real${dir}` };
    return { ok: true as const, settings: this.settings };
  });
  close = vi.fn(async () => undefined);
}

let mgr: FakeManager;
let stored: DownloadsStoredSettings;
let dialogAnswer: { canceled: boolean; filePaths: string[] };
let dialogCalls: FolderDialogOptions[];
let shell: { showItemInFolder: Mock<(fullPath: string) => void>; openPath: Mock<(fullPath: string) => Promise<string>> };
let ready: boolean;
let handlers: ReturnType<typeof createDownloadsIpcHandlers>;

const call = (channel: string, ...args: unknown[]) => handlers[channel]({ sender: {} }, ...args);

beforeEach(() => {
  mgr = new FakeManager();
  mgr.items.set('a1', snap('a1', { status: 'downloading' }));
  stored = { baseDir: '/base' };
  dialogAnswer = { canceled: true, filePaths: [] };
  dialogCalls = [];
  shell = { showItemInFolder: vi.fn<(fullPath: string) => void>(), openPath: vi.fn<(fullPath: string) => Promise<string>>(async () => '') };
  ready = true;
  handlers = createDownloadsIpcHandlers({
    getManager: () => (ready ? (mgr as unknown as DownloadManagerLike) : null),
    showFolderDialog: async (o) => {
      dialogCalls.push(o);
      return dialogAnswer;
    },
    shell,
    settings: { get: () => stored, set: (v) => { stored = v; } },
  });
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('downloads IPC: channels and readiness', () => {
  it('registers exactly the documented channels', () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.values(DOWNLOAD_CHANNELS).sort());
    expect(Object.values(DOWNLOAD_CHANNELS).every((c) => c.startsWith('downloads:'))).toBe(true);
  });

  it('answers NOT_READY for every channel until the manager is open', async () => {
    ready = false;
    for (const channel of Object.values(DOWNLOAD_CHANNELS)) {
      expect(await call(channel, 'a1')).toMatchObject({ ok: false, code: 'NOT_READY' });
    }
    expect(mgr.calls).toEqual([]);
  });
});

describe('downloads IPC: argument validation', () => {
  it('ids must be plain id strings; nothing else reaches the manager', async () => {
    const badIds = [undefined, null, 7, {}, [], '', '../a1', 'a/b', 'a\\b', '/tmp/x', 'x'.repeat(129), 'a1 ', 'a.b'];
    for (const ch of [DOWNLOAD_CHANNELS.pause, DOWNLOAD_CHANNELS.resume, DOWNLOAD_CHANNELS.cancel, DOWNLOAD_CHANNELS.retry, DOWNLOAD_CHANNELS.remove, DOWNLOAD_CHANNELS.showInFolder]) {
      for (const bad of badIds) expect(await call(ch, bad)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    expect(mgr.calls).toEqual([]);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('add requests are shape-checked', async () => {
    const bad: unknown[] = [
      undefined, null, 'http://x', [], new Date(),
      {}, { url: '' }, { url: 7 }, { url: 'h'.repeat(8193) },
      { url: 'http://x', fileName: 3 }, { url: 'http://x', source: {} }, { url: 'http://x', destDir: ['a'] }, { url: 'http://x', subdir: 'x'.repeat(4097) },
      { url: 'http://x', checksum: 'abc' }, { url: 'http://x', checksum: { algorithm: 'crc32', value: 'ab' } }, { url: 'http://x', checksum: { algorithm: 'sha1', value: 5 } },
      { url: 'http://x', expectedSize: -1 }, { url: 'http://x', expectedSize: 1.5 }, { url: 'http://x', expectedSize: '10' },
      { url: 'http://x', overwrite: 'yes' },
      { url: 'http://x', meta: [] }, { url: 'http://x', meta: { a: { nested: true } } }, { url: 'http://x', meta: { a: NaN } },
      { url: 'http://x', meta: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])) },
    ];
    for (const req of bad) expect(await call(DOWNLOAD_CHANNELS.add, req)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(mgr.calls).toEqual([]);
  });

  it('add passes only whitelisted fields to the engine', async () => {
    const req = JSON.parse(JSON.stringify({
      url: 'https://example.invalid/f.zip', fileName: 'f.zip', source: 'src', subdir: 'sub', destDir: '/picked',
      checksum: { algorithm: 'sha256', value: 'ab', extra: 1 }, expectedSize: 10, overwrite: false, meta: { k: 'v', n: 1, b: true, z: null },
      root: '/evil', destPath: '/evil/x', status: 'completed', __proto__: { polluted: true },
    }));
    const res = await call(DOWNLOAD_CHANNELS.add, req);
    expect(res).toMatchObject({ ok: true, item: { id: 'new1' } });
    expect(mgr.calls).toEqual([['add', {
      url: 'https://example.invalid/f.zip', fileName: 'f.zip', source: 'src', subdir: 'sub', destDir: '/picked',
      checksum: { algorithm: 'sha256', value: 'ab' }, expectedSize: 10, overwrite: false, meta: { k: 'v', n: 1, b: true, z: null },
    }]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('concurrency must be an integer 1-16 and autoResume a boolean', async () => {
    for (const bad of [0, 17, 1.5, -1, '2', null, undefined, NaN]) {
      expect(await call(DOWNLOAD_CHANNELS.setConcurrency, bad)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    for (const bad of ['true', 1, null, undefined, {}]) {
      expect(await call(DOWNLOAD_CHANNELS.setAutoResume, bad)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    expect(mgr.calls).toEqual([]);
    expect(stored).toEqual({ baseDir: '/base' });
  });
});

describe('downloads IPC: result shapes and error passthrough', () => {
  it('list -> { ok, items }; per-item actions -> { ok, item }', async () => {
    expect(await call(DOWNLOAD_CHANNELS.list)).toEqual({ ok: true, items: [mgr.items.get('a1')] });
    expect(await call(DOWNLOAD_CHANNELS.pause, 'a1')).toEqual({ ok: true, item: expect.objectContaining({ id: 'a1', status: 'paused' }) });
    for (const ch of [DOWNLOAD_CHANNELS.resume, DOWNLOAD_CHANNELS.cancel, DOWNLOAD_CHANNELS.retry]) {
      expect(await call(ch, 'a1')).toEqual({ ok: true, item: expect.objectContaining({ id: 'a1' }) });
    }
    const removed = await call(DOWNLOAD_CHANNELS.remove, 'a1');
    expect(removed).toEqual({ ok: true, item: expect.objectContaining({ id: 'a1' }) });
    expect(mgr.items.has('a1')).toBe(false);
  });

  it('settings results are flat and persisted', async () => {
    expect(await call(DOWNLOAD_CHANNELS.getSettings)).toEqual({ ok: true, baseDir: '/base', concurrency: 2, maxConcurrency: 16, autoResume: false });
    expect(await call(DOWNLOAD_CHANNELS.setConcurrency, 4)).toEqual({ ok: true, baseDir: '/base', concurrency: 4, maxConcurrency: 16, autoResume: false });
    expect(await call(DOWNLOAD_CHANNELS.setAutoResume, true)).toEqual({ ok: true, baseDir: '/base', concurrency: 4, maxConcurrency: 16, autoResume: true });
    expect(mgr.calls).toEqual([['setConcurrency', 4], ['setAutoResume', true]]);
    expect(stored).toEqual({ baseDir: '/base', concurrency: 4, autoResume: true });
  });

  it('engine failures pass through unchanged; a throw becomes IO_ERROR', async () => {
    const engineFail = { ok: false as const, code: 'PATH_TRAVERSAL', message: 'Destination escapes the download folder' };
    mgr.failNext = engineFail;
    expect(await call(DOWNLOAD_CHANNELS.add, { url: 'http://x', fileName: '../x' })).toEqual(engineFail);
    const stateFail = { ok: false as const, code: 'INVALID_STATE', message: 'Cannot pause a completed download' };
    mgr.failNext = stateFail;
    expect(await call(DOWNLOAD_CHANNELS.pause, 'a1')).toEqual(stateFail);
    const notFound = { ok: false as const, code: 'NOT_FOUND', message: 'No such download' };
    mgr.failNext = notFound;
    expect(await call(DOWNLOAD_CHANNELS.remove, 'zz')).toEqual(notFound);
    mgr.throwNext = true;
    expect(await call(DOWNLOAD_CHANNELS.retry, 'a1')).toMatchObject({ ok: false, code: 'IO_ERROR', message: 'boom' });
    mgr.failNext = { ok: false, code: 'INVALID_STATE', message: 'nope' };
    expect(await call(DOWNLOAD_CHANNELS.setConcurrency, 3)).toEqual({ ok: false, code: 'INVALID_STATE', message: 'nope' });
    expect(stored).toEqual({ baseDir: '/base' });
  });
});

describe('downloads IPC: folders come from main\'s dialog only', () => {
  it('chooseBaseDir: cancel -> CANCELLED; a pick goes through the engine and is persisted', async () => {
    expect(await call(DOWNLOAD_CHANNELS.chooseBaseDir, '/renderer/path/ignored')).toEqual({ ok: false, code: 'CANCELLED', message: 'No folder was chosen' });
    expect(mgr.calls).toEqual([]);
    dialogAnswer = { canceled: false, filePaths: ['/picked'] };
    expect(await call(DOWNLOAD_CHANNELS.chooseBaseDir, '/renderer/path/ignored')).toEqual({ ok: true, baseDir: '/real/picked', concurrency: 2, maxConcurrency: 16, autoResume: false });
    expect(mgr.calls).toEqual([['setBaseDir', '/picked']]);
    expect(stored.baseDir).toBe('/real/picked');
    expect(dialogCalls[1]).toMatchObject({ defaultPath: '/base', properties: ['openDirectory', 'createDirectory'] });
  });

  it('chooseBaseDir: an engine refusal passes through and nothing is persisted', async () => {
    dialogAnswer = { canceled: false, filePaths: ['/gone'] };
    mgr.failNext = { ok: false, code: 'INVALID_PATH', message: 'Download folder not found: /gone' };
    expect(await call(DOWNLOAD_CHANNELS.chooseBaseDir)).toEqual({ ok: false, code: 'INVALID_PATH', message: 'Download folder not found: /gone' });
    expect(stored).toEqual({ baseDir: '/base' });
  });

  it('chooseFolder returns the validated realpath of the pick', async () => {
    const real = fs.realpathSync(tmp());
    const link = path.join(tmp(), 'link');
    fs.symlinkSync(real, link, 'dir');
    dialogAnswer = { canceled: false, filePaths: [link] };
    expect(await call(DOWNLOAD_CHANNELS.chooseFolder)).toEqual({ ok: true, path: real });
    dialogAnswer = { canceled: false, filePaths: [path.join(real, 'missing')] };
    expect(await call(DOWNLOAD_CHANNELS.chooseFolder)).toEqual({ ok: false, code: 'INVALID_PATH', message: `Download folder not found: ${path.join(real, 'missing')}` });
    dialogAnswer = { canceled: true, filePaths: [] };
    expect(await call(DOWNLOAD_CHANNELS.chooseFolder)).toMatchObject({ ok: false, code: 'CANCELLED' });
  });
});

describe('downloads IPC: showInFolder (by id only)', () => {
  it('reveals a completed file that exists', async () => {
    const root = fs.realpathSync(tmp());
    const file = path.join(root, 'done.bin');
    fs.writeFileSync(file, 'x');
    mgr.items.set('d1', snap('d1', { status: 'completed', root, destPath: file }));
    expect(await call(DOWNLOAD_CHANNELS.showInFolder, 'd1')).toEqual({ ok: true });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(file);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('opens the root when the file is not there (or not completed)', async () => {
    const root = fs.realpathSync(tmp());
    mgr.items.set('d2', snap('d2', { status: 'completed', root, destPath: path.join(root, 'moved-away.bin') }));
    mgr.items.set('d3', snap('d3', { status: 'downloading', root }));
    fs.writeFileSync(path.join(root, 'd3.bin'), 'partial-looking');
    expect(await call(DOWNLOAD_CHANNELS.showInFolder, 'd2')).toEqual({ ok: true });
    expect(await call(DOWNLOAD_CHANNELS.showInFolder, 'd3')).toEqual({ ok: true });
    expect(shell.openPath.mock.calls).toEqual([[root], [root]]);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('IO_ERROR naming a missing root; openPath errors and unknown ids are reported', async () => {
    const root = path.join(tmp(), 'unplugged');
    mgr.items.set('d4', snap('d4', { status: 'completed', root }));
    expect(await call(DOWNLOAD_CHANNELS.showInFolder, 'd4')).toEqual({ ok: false, code: 'IO_ERROR', message: `Download folder not found: ${root}` });
    expect(shell.openPath).not.toHaveBeenCalled();
    const there = fs.realpathSync(tmp());
    mgr.items.set('d5', snap('d5', { status: 'failed', root: there }));
    shell.openPath.mockResolvedValueOnce('Failed to open path');
    expect(await call(DOWNLOAD_CHANNELS.showInFolder, 'd5')).toEqual({ ok: false, code: 'IO_ERROR', message: 'Failed to open path' });
    expect(await call(DOWNLOAD_CHANNELS.showInFolder, 'nope')).toEqual({ ok: false, code: 'NOT_FOUND', message: 'No such download' });
  });
});

describe('downloads IPC: event forwarding', () => {
  function fakeWc() {
    const sent: Array<[string, unknown]> = [];
    const wc: WebContentsLike & { destroyed: boolean } = {
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      send: (channel: string, payload: unknown) => { sent.push([channel, payload]); },
    };
    return { wc, sent };
  }

  it('forwards progress, status, completed and failed with full snapshots', () => {
    const { wc, sent } = fakeWc();
    forwardDownloadEvents(mgr as unknown as DownloadManagerLike, () => wc);
    const item = mgr.items.get('a1')!;
    const error = { ok: false as const, code: 'HTTP_ERROR' as const, message: 'HTTP 404', status: 404 };
    mgr.fire('progress', { id: 'a1', bytesDownloaded: 5, totalBytes: 10, speed: 1, etaSeconds: 5 });
    mgr.fire('progress', { id: 'unknown', bytesDownloaded: 5, totalBytes: 10, speed: 1, etaSeconds: 5 });
    mgr.fire('status', item, 'queued');
    mgr.fire('completed', item);
    mgr.fire('failed', item, error);
    mgr.fire('added', item);
    mgr.fire('removed', 'a1');
    expect(sent).toEqual([
      [DOWNLOAD_EVENTS.progress, { item }],
      [DOWNLOAD_EVENTS.status, { item, previous: 'queued' }],
      [DOWNLOAD_EVENTS.completed, { item }],
      [DOWNLOAD_EVENTS.failed, { item, error }],
    ]);
  });

  it('skips a destroyed or missing window, survives a failing send, and unsubscribes', () => {
    const { wc, sent } = fakeWc();
    let current: WebContentsLike | null = wc;
    const off = forwardDownloadEvents(mgr as unknown as DownloadManagerLike, () => current);
    const item = mgr.items.get('a1')!;
    wc.destroyed = true;
    mgr.fire('completed', item);
    current = null;
    mgr.fire('completed', item);
    current = { isDestroyed: () => false, send: () => { throw new Error('Object has been destroyed'); } };
    expect(() => mgr.fire('completed', item)).not.toThrow();
    wc.destroyed = false;
    current = wc;
    off();
    mgr.fire('completed', item);
    expect(sent).toEqual([]);
  });
});

describe('downloads IPC: quit', () => {
  it('holds the first quit until close() finishes, then quits once', async () => {
    let release!: () => void;
    mgr.close.mockImplementation(() => new Promise<undefined>((r) => { release = () => r(undefined); }));
    const quit = vi.fn();
    const onBeforeQuit = createDownloadsQuitHandler(() => mgr as unknown as DownloadManagerLike, quit);
    const ev1 = { preventDefault: vi.fn() };
    onBeforeQuit(ev1);
    expect(ev1.preventDefault).toHaveBeenCalledTimes(1);
    expect(mgr.close).toHaveBeenCalledTimes(1);
    // A second quit while closing is held too, without a second close.
    const ev2 = { preventDefault: vi.fn() };
    onBeforeQuit(ev2);
    expect(ev2.preventDefault).toHaveBeenCalledTimes(1);
    expect(mgr.close).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    // The re-issued quit goes through.
    const ev3 = { preventDefault: vi.fn() };
    onBeforeQuit(ev3);
    expect(ev3.preventDefault).not.toHaveBeenCalled();
    expect(mgr.close).toHaveBeenCalledTimes(1);
  });

  it('quits after a timeout if close() hangs or fails, and does nothing without a manager', async () => {
    mgr.close.mockImplementation(() => new Promise<undefined>(() => undefined));
    const quit = vi.fn();
    createDownloadsQuitHandler(() => mgr as unknown as DownloadManagerLike, quit, 20)({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));

    const failing = new FakeManager();
    failing.close.mockRejectedValue(new Error('disk full'));
    const quit2 = vi.fn();
    createDownloadsQuitHandler(() => failing as unknown as DownloadManagerLike, quit2)({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit2).toHaveBeenCalledTimes(1));

    const ev = { preventDefault: vi.fn() };
    const quit3 = vi.fn();
    createDownloadsQuitHandler(() => null, quit3)(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(quit3).not.toHaveBeenCalled();
  });
});

describe('openDownloads (startup)', () => {
  function capture() {
    const opened: DownloadManagerOptions[] = [];
    const open = async (o: DownloadManagerOptions) => {
      opened.push(o);
      return mgr as unknown as DownloadManagerLike;
    };
    return { opened, open };
  }

  it('first setup creates the default folder once and remembers its realpath', async () => {
    const parent = fs.realpathSync(tmp());
    const def = path.join(parent, 'Dune');
    let saved: DownloadsStoredSettings = {};
    const { opened, open } = capture();
    await openDownloads({ settings: { get: () => saved, set: (v) => { saved = v; } }, defaultBaseDir: def, stateDir: '/state', open });
    expect(fs.statSync(def).isDirectory()).toBe(true);
    expect(saved).toEqual({ baseDir: def });
    expect(opened).toEqual([{ baseDir: def, stateDir: '/state', autoResume: false }]);
  });

  it('a saved base dir that is missing is never recreated; saved concurrency/autoResume are applied', async () => {
    const gone = path.join(tmp(), 'external', 'Dune');
    const def = path.join(tmp(), 'Dune');
    let saved: DownloadsStoredSettings = { baseDir: gone, concurrency: 4, autoResume: true };
    const { opened, open } = capture();
    await openDownloads({ settings: { get: () => saved, set: (v) => { saved = v; } }, defaultBaseDir: def, stateDir: '/state', open });
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(def)).toBe(false);
    expect(opened).toEqual([{ baseDir: gone, stateDir: '/state', concurrency: 4, autoResume: true }]);
    expect(saved).toEqual({ baseDir: gone, concurrency: 4, autoResume: true });
  });

  it('ignores bad saved values and never creates a missing parent of the default', async () => {
    const def = path.join(tmp(), 'no-downloads-dir', 'Dune');
    let saved: DownloadsStoredSettings = { concurrency: 99, autoResume: 'yes' as unknown as boolean };
    const { opened, open } = capture();
    await openDownloads({ settings: { get: () => saved, set: (v) => { saved = v; } }, defaultBaseDir: def, stateDir: '/state', open });
    expect(fs.existsSync(path.dirname(def))).toBe(false);
    expect(opened).toEqual([{ baseDir: def, stateDir: '/state', autoResume: false }]);
    expect(saved.baseDir).toBeUndefined();
  });
});
