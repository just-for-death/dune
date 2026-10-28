import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { DownloadManager, type DownloadManagerOptions } from './manager';
import type { DownloadItem, DownloadProgress, ProtocolHandler } from './types';

// ── local fixture server (127.0.0.1 only, no real network) ──────────────────

interface Route {
  body?: Buffer;
  chunk?: number;
  delayMs?: number;
  etag?: string;
  /** Respond with this status for the first `failTimes` requests. */
  failTimes?: number;
  failStatus?: number;
  /** Always respond with this status. */
  status?: number;
  ignoreRange?: boolean;
  redirect?: string;
}

interface SeenRequest { path: string; range?: string; ifRange?: string; authorization?: string }

class Fixture {
  readonly routes = new Map<string, Route>();
  readonly requests: SeenRequest[] = [];
  active = 0;
  maxActive = 0;
  private server!: http.Server;
  base = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  url(p: string): string {
    return `${this.base}${p}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const p = new URL(req.url ?? '/', this.base).pathname;
    this.requests.push({
      path: p,
      range: req.headers.range,
      ifRange: req.headers['if-range'] as string | undefined,
      authorization: req.headers.authorization,
    });
    const route = this.routes.get(p);
    if (!route) return void res.writeHead(404).end();
    if (route.redirect) return void res.writeHead(302, { Location: route.redirect }).end();
    if (route.failTimes && route.failTimes > 0) {
      route.failTimes -= 1;
      return void res.writeHead(route.failStatus ?? 503).end();
    }
    if (route.status) return void res.writeHead(route.status).end();

    const body = route.body ?? Buffer.alloc(0);
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const ifRange = req.headers['if-range'];
    if (m && !route.ignoreRange && (!ifRange || ifRange === route.etag)) {
      start = Number(m[1]);
      if (start >= body.length) {
        return void res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`,
        'Content-Length': body.length - start,
        ...(route.etag ? { ETag: route.etag } : {}),
      });
    } else {
      res.writeHead(200, { 'Content-Length': body.length, ...(route.etag ? { ETag: route.etag } : {}) });
    }

    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    try {
      const chunk = route.chunk ?? body.length;
      for (let off = start; off < body.length && !closed; off += chunk) {
        res.write(body.subarray(off, Math.min(body.length, off + chunk)));
        if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
      }
      if (!closed) res.end();
    } finally {
      this.active -= 1;
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dl-'));
  tmpDirs.push(d);
  return d;
};
const bytes = (n: number, seed = 1) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function waitStatus(mgr: DownloadManager, id: string, status: DownloadItem['status'], timeoutMs = 5000) {
  return waitFor(() => mgr.get(id)?.status === status && mgr.get(id), timeoutMs);
}

let fx: Fixture;
let baseDir: string;
let stateDir: string;
const managers: DownloadManager[] = [];

async function open(extra: Partial<DownloadManagerOptions> = {}): Promise<DownloadManager> {
  const mgr = await DownloadManager.open({
    baseDir,
    stateDir,
    concurrency: 2,
    progressIntervalMs: 0,
    persistDebounceMs: 5,
    retryBaseMs: 20,
    random: () => 1,
    idleTimeoutMs: 2000,
    freeSpace: async () => null,
    ...extra,
  });
  managers.push(mgr);
  return mgr;
}

async function added(mgr: DownloadManager, req: Parameters<DownloadManager['add']>[0]): Promise<DownloadItem> {
  const res = await mgr.add(req);
  if (!res.ok) throw new Error(`add failed: ${res.code} ${res.message}`);
  return res.item;
}

beforeEach(async () => {
  fx = new Fixture();
  await fx.start();
  baseDir = tmp();
  stateDir = tmp();
});

afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  await fx.stop();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ── tests ────────────────────────────────────────────────────────────────

describe('DownloadManager queue', () => {
  it('runs FIFO with at most `concurrency` downloads at once', async () => {
    for (let i = 0; i < 5; i++) fx.routes.set(`/f${i}`, { body: bytes(4000, i), chunk: 1000, delayMs: 15 });
    const mgr = await open({ concurrency: 2 });
    const started: string[] = [];
    let running = 0;
    let maxRunning = 0;
    mgr.on('status', (item, previous) => {
      if (item.status === 'downloading') {
        started.push(path.basename(item.destPath));
        running += 1;
        maxRunning = Math.max(maxRunning, running);
      } else if (previous === 'downloading') {
        running -= 1;
      }
    });
    const items = [];
    for (let i = 0; i < 5; i++) items.push(await added(mgr, { url: fx.url(`/f${i}`) }));
    for (const it of items) await waitStatus(mgr, it.id, 'completed');
    expect(started).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(maxRunning).toBe(2);
    for (let i = 0; i < 5; i++) expect(fs.readFileSync(path.join(baseDir, `f${i}`)).equals(bytes(4000, i))).toBe(true);
    expect(mgr.list().map((i) => path.basename(i.destPath))).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
  });

  it('honours a runtime concurrency change and rejects bad values', async () => {
    for (let i = 0; i < 3; i++) fx.routes.set(`/c${i}`, { body: bytes(3000, i), chunk: 500, delayMs: 15 });
    const mgr = await open({ concurrency: 1 });
    expect(mgr.setConcurrency(0)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(mgr.setConcurrency(1.5)).toMatchObject({ ok: false });
    const items = [];
    for (let i = 0; i < 3; i++) items.push(await added(mgr, { url: fx.url(`/c${i}`) }));
    await waitStatus(mgr, items[0].id, 'downloading');
    expect(mgr.setConcurrency(3)).toEqual({ ok: true });
    await waitFor(() => fx.maxActive === 3);
    for (const it of items) await waitStatus(mgr, it.id, 'completed');
  });

  it('emits progress with bytes, speed and ETA, ending at the total', async () => {
    fx.routes.set('/p', { body: bytes(8000), chunk: 1000, delayMs: 10 });
    const mgr = await open();
    const events: DownloadProgress[] = [];
    mgr.on('progress', (p) => events.push(p));
    const item = await added(mgr, { url: fx.url('/p') });
    await waitStatus(mgr, item.id, 'completed');
    expect(events.length).toBeGreaterThan(2);
    const seq = events.map((e) => e.bytesDownloaded);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    expect(events[events.length - 1]).toMatchObject({ id: item.id, bytesDownloaded: 8000, totalBytes: 8000, etaSeconds: 0 });
    expect(events.some((e) => e.speed > 0)).toBe(true);
    expect(events.every((e) => e.etaSeconds === null || e.etaSeconds >= 0)).toBe(true);
  });
});

describe('pause / resume / cancel', () => {
  it('pauses keeping the .part, then resumes with Range + If-Range', async () => {
    const body = bytes(20_000);
    fx.routes.set('/big', { body, chunk: 1000, delayMs: 10, etag: '"v1"' });
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/big'), checksum: { algorithm: 'sha256', value: sha256(body) } });
    await waitFor(() => (mgr.get(item.id)?.bytesDownloaded ?? 0) >= 3000);
    expect(await mgr.pause(item.id)).toEqual({ ok: true });
    const paused = mgr.get(item.id)!;
    expect(paused.status).toBe('paused');
    const partSize = fs.statSync(item.partPath).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(body.length);
    expect(paused.bytesDownloaded).toBe(partSize);
    expect(fs.existsSync(item.destPath)).toBe(false);

    expect(await mgr.resume(item.id)).toEqual({ ok: true });
    await waitStatus(mgr, item.id, 'completed');
    const resumeReq = fx.requests.filter((r) => r.path === '/big')[1];
    expect(resumeReq).toMatchObject({ range: `bytes=${partSize}-`, ifRange: '"v1"' });
    expect(fs.readFileSync(item.destPath).equals(body)).toBe(true);
    expect(fs.existsSync(item.partPath)).toBe(false);
  });

  it('restarts from zero when the remote file changed (If-Range mismatch -> 200)', async () => {
    const v1 = bytes(10_000, 1);
    fx.routes.set('/chg', { body: v1, chunk: 1000, delayMs: 10, etag: '"v1"' });
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/chg') });
    await waitFor(() => (mgr.get(item.id)?.bytesDownloaded ?? 0) >= 2000);
    await mgr.pause(item.id);
    const v2 = bytes(6000, 9);
    fx.routes.set('/chg', { body: v2, etag: '"v2"' });
    await mgr.resume(item.id);
    await waitStatus(mgr, item.id, 'completed');
    expect(fs.readFileSync(item.destPath).equals(v2)).toBe(true);
  });

  it('treats 416 with a matching total as already complete', async () => {
    const body = bytes(5000);
    fx.routes.set('/done', { body });
    const mgr = await open({ autoStart: false });
    const item = await added(mgr, { url: fx.url('/done') });
    // The item's own .part already holds every byte (e.g. it was killed before the rename).
    fs.writeFileSync(item.partPath, body);
    mgr.start();
    await waitStatus(mgr, item.id, 'completed');
    expect(fx.requests[0].range).toBe('bytes=5000-');
    expect(fs.readFileSync(item.destPath).equals(body)).toBe(true);
  });

  it('cancel stops the transfer and deletes the .part', async () => {
    fx.routes.set('/slow', { body: bytes(50_000), chunk: 1000, delayMs: 10 });
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/slow') });
    await waitFor(() => fs.existsSync(item.partPath) && fs.statSync(item.partPath).size > 0);
    expect(await mgr.cancel(item.id)).toEqual({ ok: true });
    expect(mgr.get(item.id)).toMatchObject({ status: 'cancelled', bytesDownloaded: 0 });
    expect(fs.existsSync(item.partPath)).toBe(false);
    expect(fs.existsSync(item.destPath)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(item.partPath)).toBe(false);
    // A queued (never started) item cancels too, and a cancelled one can be retried.
    expect(await mgr.retry(item.id)).toEqual({ ok: true });
    await waitStatus(mgr, item.id, 'completed', 8000);
  });

  it('rejects invalid transitions and unknown ids', async () => {
    fx.routes.set('/x', { body: bytes(10) });
    const mgr = await open();
    expect(await mgr.pause('nope')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const item = await added(mgr, { url: fx.url('/x') });
    await waitStatus(mgr, item.id, 'completed');
    expect(await mgr.pause(item.id)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(await mgr.cancel(item.id)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(await mgr.retry(item.id)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(await mgr.remove(item.id)).toEqual({ ok: true });
    expect(fs.existsSync(item.destPath)).toBe(true); // remove never deletes the user's file
    expect(mgr.list()).toEqual([]);
  });
});

describe('retries', () => {
  it('retries transient errors with exponential backoff, resuming the .part', async () => {
    fx.routes.set('/flaky', { body: bytes(3000), failTimes: 2, failStatus: 503 });
    const mgr = await open({ maxRetries: 3, retryBaseMs: 30 });
    const retries: Array<{ attempt: number; delay: number; code: string }> = [];
    mgr.on('retrying', (_i, attempt, delay, err) => retries.push({ attempt, delay, code: err.code }));
    const t0 = Date.now();
    const item = await added(mgr, { url: fx.url('/flaky') });
    await waitStatus(mgr, item.id, 'completed');
    expect(retries).toEqual([
      { attempt: 1, delay: 30, code: 'HTTP_ERROR' },
      { attempt: 2, delay: 60, code: 'HTTP_ERROR' },
    ]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(85);
    expect(fx.requests.filter((r) => r.path === '/flaky')).toHaveLength(3);
    expect(mgr.get(item.id)).toMatchObject({ attempts: 0 });
  });

  it('caps the backoff and applies jitter', async () => {
    fx.routes.set('/cap', { body: bytes(10), failTimes: 3, failStatus: 500 });
    const mgr = await open({ maxRetries: 3, retryBaseMs: 20, retryMaxMs: 30, random: () => 0 });
    const delays: number[] = [];
    mgr.on('retrying', (_i, _a, d) => delays.push(d));
    const item = await added(mgr, { url: fx.url('/cap') });
    await waitStatus(mgr, item.id, 'completed');
    expect(delays).toEqual([10, 15, 15]);
  });

  it('fails after the retry budget, and a manual retry starts a fresh budget', async () => {
    fx.routes.set('/down', { status: 502 });
    const mgr = await open({ maxRetries: 2, retryBaseMs: 5 });
    const failed: string[] = [];
    mgr.on('failed', (_i, e) => failed.push(`${e.code}:${e.status}`));
    const item = await added(mgr, { url: fx.url('/down') });
    await waitStatus(mgr, item.id, 'failed');
    expect(failed).toEqual(['HTTP_ERROR:502']);
    expect(fx.requests).toHaveLength(3);
    fx.routes.set('/down', { body: bytes(100) });
    expect(await mgr.retry(item.id)).toEqual({ ok: true });
    await waitStatus(mgr, item.id, 'completed');
    expect(mgr.get(item.id)?.error).toBeUndefined();
  });

  it('does not retry permanent errors (404)', async () => {
    const mgr = await open({ maxRetries: 3 });
    const item = await added(mgr, { url: fx.url('/missing') });
    const done = await waitStatus(mgr, item.id, 'failed');
    expect(done.error).toMatchObject({ ok: false, code: 'HTTP_ERROR', status: 404 });
    expect(fx.requests).toHaveLength(1);
  });

  it('a slot waiting for a retry does not block other downloads', async () => {
    fx.routes.set('/wait', { body: bytes(10), failTimes: 1 });
    fx.routes.set('/next', { body: bytes(10) });
    const mgr = await open({ concurrency: 1, retryBaseMs: 300 });
    const a = await added(mgr, { url: fx.url('/wait') });
    const b = await added(mgr, { url: fx.url('/next') });
    await waitStatus(mgr, b.id, 'completed');
    expect(mgr.get(a.id)?.status).toBe('queued');
    await waitStatus(mgr, a.id, 'completed');
  });
});

describe('verification and safety', () => {
  it('fails on checksum mismatch, deletes the .part and never writes the file', async () => {
    fx.routes.set('/sum', { body: bytes(2000) });
    const mgr = await open({ maxRetries: 3 });
    const statuses: string[] = [];
    mgr.on('status', (i) => statuses.push(i.status));
    const item = await added(mgr, { url: fx.url('/sum'), checksum: { algorithm: 'md5', value: '0'.repeat(32) } });
    const done = await waitStatus(mgr, item.id, 'failed');
    expect(done.error?.code).toBe('CHECKSUM_MISMATCH');
    expect(statuses).toEqual(['downloading', 'verifying', 'failed']);
    expect(fs.existsSync(item.partPath)).toBe(false);
    expect(fs.existsSync(item.destPath)).toBe(false);
    expect(fx.requests).toHaveLength(1);
  });

  it('accepts a matching sha1', async () => {
    const body = bytes(1234);
    fx.routes.set('/sha1', { body });
    const mgr = await open();
    const value = crypto.createHash('sha1').update(body).digest('hex').toUpperCase();
    const item = await added(mgr, { url: fx.url('/sha1'), checksum: { algorithm: 'sha1', value } });
    await waitStatus(mgr, item.id, 'completed');
  });

  it('rejects path traversal and bad requests at add()', async () => {
    const mgr = await open();
    const url = fx.url('/x');
    for (const req of [
      { url, fileName: '../escape.bin' },
      { url, fileName: '/tmp/abs.bin' },
      { url, fileName: 'ok.bin', subdir: '../../up' },
      { url, fileName: 'a/../../b.bin' },
    ]) {
      expect(await mgr.add(req)).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    }
    expect(await mgr.add({ url, checksum: { algorithm: 'sha256', value: 'zz' } })).toMatchObject({ ok: false, code: 'INVALID_CHECKSUM' });
    expect(mgr.list()).toHaveLength(0);
  });

  it('overwrite replaces an existing file only when asked', async () => {
    fx.routes.set('/ow', { body: Buffer.from('new') });
    fs.writeFileSync(path.join(baseDir, 'ow'), 'old');
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/ow'), overwrite: true });
    await waitStatus(mgr, item.id, 'completed');
    expect(fs.readFileSync(item.destPath, 'utf8')).toBe('new');
  });

  it('fails when the disk-space precheck says there is not enough room', async () => {
    fx.routes.set('/huge', { body: bytes(5000) });
    const asked: string[] = [];
    const mgr = await open({ freeSpace: async (dir) => { asked.push(dir); return 100; } });
    const item = await added(mgr, { url: fx.url('/huge'), subdir: 'games' });
    const done = await waitStatus(mgr, item.id, 'failed');
    expect(done.error?.code).toBe('INSUFFICIENT_SPACE');
    expect(asked).toEqual([path.join(baseDir, 'games')]);
    expect(fx.requests).toHaveLength(1);
  });

  it('fails on a size mismatch with expectedSize', async () => {
    fx.routes.set('/sz', { body: bytes(10) });
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/sz'), expectedSize: 11 });
    expect((await waitStatus(mgr, item.id, 'failed')).error?.code).toBe('SIZE_MISMATCH');
  });
});

describe('protocols', () => {
  it('rejects non-http(s) protocols without a handler', async () => {
    const mgr = await open();
    for (const url of ['ftp://127.0.0.1/a', 'file:///etc/passwd', 'magnet:?xt=urn:btih:abc', 'javascript:alert(1)']) {
      expect(await mgr.add({ url, fileName: 'x' })).toMatchObject({ ok: false, code: 'PROTOCOL_NOT_ALLOWED' });
    }
    expect(await mgr.add({ url: 'http://user:pw@127.0.0.1/a' })).toMatchObject({ ok: false, code: 'URL_CREDENTIALS' });
    expect(mgr.list()).toEqual([]);
  });

  it('refuses redirects to non-http(s) schemes and follows http ones', async () => {
    fx.routes.set('/to-file', { redirect: 'file:///etc/passwd' });
    fx.routes.set('/real', { body: bytes(50) });
    fx.routes.set('/hop', { redirect: '/real' });
    const mgr = await open();
    const bad = await added(mgr, { url: fx.url('/to-file') });
    expect((await waitStatus(mgr, bad.id, 'failed')).error?.code).toBe('PROTOCOL_NOT_ALLOWED');
    const ok = await added(mgr, { url: fx.url('/hop'), fileName: 'real.bin' });
    await waitStatus(mgr, ok.id, 'completed');
    expect(fs.readFileSync(ok.destPath).equals(bytes(50))).toBe(true);
  });

  it('runs a registered handler for its scheme (pluggable, none built in)', async () => {
    const handler: ProtocolHandler = {
      id: 'fake-magnet',
      protocols: ['magnet:'],
      async download({ partPath, onProgress }) {
        fs.writeFileSync(partPath, 'payload');
        onProgress(7, 7);
      },
    };
    const mgr = await open();
    expect(() => mgr.registerHandler({ ...handler, protocols: ['https:'] })).toThrow();
    mgr.registerHandler(handler);
    expect(await mgr.add({ url: 'magnet:?xt=urn:btih:abc' })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    const item = await added(mgr, { url: 'magnet:?xt=urn:btih:abc', fileName: 'm.bin' });
    expect(item.handler).toBe('fake-magnet');
    await waitStatus(mgr, item.id, 'completed');
    expect(fs.readFileSync(item.destPath, 'utf8')).toBe('payload');
  });

  it('sends injected headers but drops auth on a cross-origin redirect', async () => {
    const other = new Fixture();
    await other.start();
    try {
      other.routes.set('/o', { body: bytes(5) });
      fx.routes.set('/same', { body: bytes(5) });
      fx.routes.set('/cross', { redirect: other.url('/o') });
      const mgr = await open({ getHeaders: () => ({ Authorization: 'Bearer t' }) });
      const a = await added(mgr, { url: fx.url('/same') });
      const b = await added(mgr, { url: fx.url('/cross'), fileName: 'o.bin' });
      await waitStatus(mgr, a.id, 'completed');
      await waitStatus(mgr, b.id, 'completed');
      expect(fx.requests.find((r) => r.path === '/same')?.authorization).toBe('Bearer t');
      expect(other.requests[0].authorization).toBeUndefined();
      // Headers are never persisted.
      await mgr.flush();
      expect(fs.readFileSync(path.join(stateDir, 'downloads.json'), 'utf8')).not.toContain('Bearer');
    } finally {
      await other.stop();
    }
  });
});

describe('destinations', () => {
  it('puts a source in its own sub-folder of the base dir', async () => {
    fx.routes.set('/pkg.zip', { body: bytes(100) });
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/pkg.zip'), source: 'my-source' });
    expect(item).toMatchObject({ source: 'my-source', destPath: path.join(baseDir, 'my-source', 'pkg.zip') });
    expect(item.destDir).toBeUndefined();
    await waitStatus(mgr, item.id, 'completed');
    expect(fs.readFileSync(path.join(baseDir, 'my-source', 'pkg.zip'))).toEqual(bytes(100));
    const sub = await added(mgr, { url: fx.url('/pkg.zip'), source: 'my-source', subdir: 'extras', fileName: 'p.zip' });
    expect(sub.destPath).toBe(path.join(baseDir, 'my-source', 'extras', 'p.zip'));
  });

  it('rejects unsafe source ids', async () => {
    const mgr = await open({ autoStart: false });
    const url = fx.url('/x');
    expect(await mgr.add({ url, source: '../up' })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(await mgr.add({ url, source: '/abs' })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(await mgr.add({ url, source: 'a/b' })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(await mgr.add({ url, source: 'con' })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(await mgr.add({ url, source: 'x?y' })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(mgr.list()).toHaveLength(0);
  });

  it('honours a per-download destDir override (realpath recorded, source not appended)', async () => {
    fx.routes.set('/o.bin', { body: bytes(50) });
    const other = tmp();
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/o.bin'), source: 's1', destDir: other, subdir: 'sub' });
    const real = fs.realpathSync(other);
    expect(item).toMatchObject({ source: 's1', destDir: real, destPath: path.join(real, 'sub', 'o.bin') });
    await waitStatus(mgr, item.id, 'completed');
    expect(fs.readFileSync(path.join(real, 'sub', 'o.bin'))).toEqual(bytes(50));
    expect(fs.existsSync(path.join(baseDir, 's1'))).toBe(false);
  });

  it('records the realpath when destDir is reached through a symlink', async () => {
    const target = tmp();
    const link = path.join(tmp(), 'link');
    fs.symlinkSync(target, link, 'dir');
    const mgr = await open({ autoStart: false });
    const item = await added(mgr, { url: fx.url('/f.bin'), destDir: link });
    expect(item.destDir).toBe(fs.realpathSync(target));
    expect(item.destPath).toBe(path.join(fs.realpathSync(target), 'f.bin'));
  });

  it('rejects relative, traversing, missing or non-directory overrides', async () => {
    const other = tmp();
    const file = path.join(other, 'plain.txt');
    fs.writeFileSync(file, 'x');
    const mgr = await open({ autoStart: false });
    const url = fx.url('/x');
    expect(await mgr.add({ url, destDir: 'relative/dir' })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(await mgr.add({ url, destDir: './here' })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(await mgr.add({ url, destDir: '../up' })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(await mgr.add({ url, destDir: `${other}/../${path.basename(other)}` })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(await mgr.add({ url, destDir: path.join(other, 'missing') })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(await mgr.add({ url, destDir: file })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(await mgr.add({ url, destDir: '' })).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    // Traversal protections still apply inside the override.
    expect(await mgr.add({ url, destDir: other, fileName: '../escape.bin' })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(await mgr.add({ url, destDir: other, subdir: '../../up' })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(mgr.list()).toHaveLength(0);
  });

  it('never writes through a symlinked dest or .part in the override', async () => {
    const other = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'victim'), 'keep');
    fs.symlinkSync(path.join(outside, 'victim'), path.join(other, 'link.bin'));
    fs.symlinkSync(path.join(outside, 'victim'), path.join(other, 'p.bin.part'));
    const mgr = await open({ autoStart: false });
    const url = fx.url('/x');
    expect(await mgr.add({ url, destDir: other, fileName: 'link.bin', overwrite: true })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(await mgr.add({ url, destDir: other, fileName: 'p.bin', overwrite: true })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    // Without overwrite a symlink just makes the name taken.
    const renamed = await added(mgr, { url, destDir: other, fileName: 'link.bin' });
    expect(path.basename(renamed.destPath)).toBe('link (1).bin');
    expect(fs.readFileSync(path.join(outside, 'victim'), 'utf8')).toBe('keep');
  });

  it('refuses to add when the base dir is missing, and never creates it', async () => {
    const missing = path.join(tmp(), 'external-drive');
    const mgr = await open({ baseDir: missing });
    expect(await mgr.add({ url: fx.url('/x.bin'), source: 's' })).toEqual({ ok: false, code: 'IO_ERROR', message: `Download folder not found: ${missing}` });
    expect(fs.existsSync(missing)).toBe(false);
    expect(mgr.list()).toHaveLength(0);
  });

  it('fails when the base root vanishes, creates only the source sub-folder, and retry() works once it is back', async () => {
    fx.routes.set('/gone.bin', { body: bytes(80) });
    const root = path.join(tmp(), 'downloads');
    fs.mkdirSync(root);
    const real = fs.realpathSync(root);
    const mgr = await open({ baseDir: root, autoStart: false });
    const item = await added(mgr, { url: fx.url('/gone.bin'), source: 'src' });
    expect(item.root).toBe(real);
    fs.rmdirSync(root);
    mgr.start();
    const failed = await waitStatus(mgr, item.id, 'failed');
    expect(failed.error).toEqual({ ok: false, code: 'IO_ERROR', message: `Download folder not found: ${real}` });
    expect(fx.requests).toHaveLength(0);
    expect(fs.existsSync(root)).toBe(false);

    fs.mkdirSync(root);
    expect(await mgr.retry(item.id)).toEqual({ ok: true });
    const done = await waitStatus(mgr, item.id, 'completed');
    expect(done.destPath).toBe(path.join(real, 'src', 'gone.bin'));
    expect(fs.readFileSync(done.destPath)).toEqual(bytes(80));
  });

  it('names a missing override folder in the error, and retry() works once it is back', async () => {
    fx.routes.set('/back.bin', { body: bytes(64) });
    const dir = path.join(tmp(), 'usb-drive');
    fs.mkdirSync(dir);
    const real = fs.realpathSync(dir);
    const mgr = await open({ autoStart: false });
    const item = await added(mgr, { url: fx.url('/back.bin'), destDir: dir });
    fs.rmdirSync(dir);
    mgr.start();
    const failed = await waitStatus(mgr, item.id, 'failed');
    expect(failed.error).toEqual({ ok: false, code: 'IO_ERROR', message: `Download folder not found: ${real}` });
    expect(failed.errorCode).toBe('IO_ERROR');
    expect(fx.requests).toHaveLength(0);
    // Not silently recreated.
    expect(fs.existsSync(dir)).toBe(false);

    fs.mkdirSync(dir);
    expect(await mgr.retry(item.id)).toEqual({ ok: true });
    const done = await waitStatus(mgr, item.id, 'completed');
    expect(done).toMatchObject({ errorCode: null, destPath: path.join(real, 'back.bin') });
    expect(fs.readFileSync(path.join(real, 'back.bin'))).toEqual(bytes(64));
  });

  it('fails if the override folder is swapped for a symlink after add()', async () => {
    fx.routes.set('/sw', { body: bytes(10) });
    const dir = path.join(tmp(), 'dl');
    fs.mkdirSync(dir);
    const outside = tmp();
    const mgr = await open({ autoStart: false });
    const item = await added(mgr, { url: fx.url('/sw'), destDir: dir });
    fs.rmdirSync(dir);
    fs.symlinkSync(outside, dir, 'dir');
    mgr.start();
    const done = await waitStatus(mgr, item.id, 'failed');
    expect(done.error?.code).toBe('PATH_TRAVERSAL');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('name collisions', () => {
  it('auto-renames past files on disk, stray .part files and queued items', async () => {
    fs.writeFileSync(path.join(baseDir, 'game.zip'), 'mine');
    fs.writeFileSync(path.join(baseDir, 'game (1).zip.part'), 'stray');
    const mgr = await open({ autoStart: false });
    const queued = await added(mgr, { url: fx.url('/q'), fileName: 'game (2).zip' });
    expect(path.basename(queued.destPath)).toBe('game (2).zip');
    const item = await added(mgr, { url: fx.url('/g'), fileName: 'game.zip' });
    expect(path.basename(item.destPath)).toBe('game (3).zip');
    expect(item.partPath).toBe(`${item.destPath}.part`);
    expect(fs.readFileSync(path.join(baseDir, 'game.zip'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(baseDir, 'game (1).zip.part'), 'utf8')).toBe('stray');
  });

  it('gives concurrent adds distinct names and keeps compound extensions', async () => {
    const mgr = await open({ autoStart: false });
    const res = await Promise.all([0, 1, 2].map(() => mgr.add({ url: fx.url('/t'), fileName: 'pack.tar.gz', source: 'src' })));
    const names = res.map((r) => (r.ok ? path.basename(r.item.destPath) : r.code));
    expect(names).toEqual(['pack.tar.gz', 'pack (1).tar.gz', 'pack (2).tar.gz']);
  });

  it('renames per folder: the same name in another source is free', async () => {
    const mgr = await open({ autoStart: false });
    const a = await added(mgr, { url: fx.url('/same.bin'), source: 'a' });
    const b = await added(mgr, { url: fx.url('/same.bin'), source: 'b' });
    expect([path.basename(a.destPath), path.basename(b.destPath)]).toEqual(['same.bin', 'same.bin']);
  });

  it('finishes under the next free name if a file appears while downloading', async () => {
    fx.routes.set('/late.bin', { body: bytes(20_000), chunk: 1000, delayMs: 10 });
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/late.bin') });
    await waitFor(() => (mgr.get(item.id)?.bytesDownloaded ?? 0) > 0);
    fs.writeFileSync(item.destPath, 'user file');
    const done = await waitStatus(mgr, item.id, 'completed');
    expect(path.basename(done.destPath)).toBe('late (1).bin');
    expect(fs.readFileSync(done.destPath)).toEqual(bytes(20_000));
    expect(fs.readFileSync(item.destPath, 'utf8')).toBe('user file');
  });

  it('moves a failed item to a free name on retry', async () => {
    fx.routes.set('/rf.bin', { body: bytes(10), status: 404 });
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/rf.bin') });
    await waitStatus(mgr, item.id, 'failed');
    fs.writeFileSync(item.destPath, 'user file');
    fx.routes.set('/rf.bin', { body: bytes(10) });
    expect(await mgr.retry(item.id)).toEqual({ ok: true });
    const done = await waitStatus(mgr, item.id, 'completed');
    expect(path.basename(done.destPath)).toBe('rf (1).bin');
    expect(fs.readFileSync(item.destPath, 'utf8')).toBe('user file');
  });

  it('overwrite stays an explicit opt-in and refuses a second active writer', async () => {
    fx.routes.set('/slowow', { body: bytes(20_000), chunk: 1000, delayMs: 20 });
    const mgr = await open();
    const first = await added(mgr, { url: fx.url('/slowow'), fileName: 'w.bin', overwrite: true });
    expect(first.destPath).toBe(path.join(baseDir, 'w.bin'));
    expect(await mgr.add({ url: fx.url('/slowow'), fileName: 'w.bin', overwrite: true })).toMatchObject({ ok: false, code: 'DUPLICATE_DEST' });
    // Without overwrite the same name is simply renamed.
    const second = await added(mgr, { url: fx.url('/slowow'), fileName: 'w.bin' });
    expect(path.basename(second.destPath)).toBe('w (1).bin');
  });
});

describe('UI snapshot fields and progress throttling', () => {
  it('list() carries name, host, receivedBytes, live speed/eta, status, errorCode and destPath', async () => {
    fx.routes.set('/ui/file.iso', { body: bytes(60_000), chunk: 1000, delayMs: 10 });
    fx.routes.set('/ui/missing', { body: bytes(1), status: 404 });
    const mgr = await open({ concurrency: 2 });
    const live = await added(mgr, { url: fx.url('/ui/file.iso') });
    const bad = await added(mgr, { url: fx.url('/ui/missing'), fileName: 'm.bin' });
    const host = new URL(fx.url('/')).host;
    await waitStatus(mgr, bad.id, 'failed');
    const snap = await waitFor(() => {
      const s = mgr.list().find((i) => i.id === live.id);
      return s && s.status === 'downloading' && s.receivedBytes > 5000 && s.speed > 0 && s.eta !== null && s;
    });
    expect(snap).toMatchObject({ name: 'file.iso', host, totalBytes: 60_000, errorCode: null, destPath: path.join(baseDir, 'file.iso') });
    expect(snap.receivedBytes).toBe(snap.bytesDownloaded);
    expect(snap.eta).toBeGreaterThan(0);
    expect(mgr.get(bad.id)).toMatchObject({ name: 'm.bin', host, status: 'failed', errorCode: 'HTTP_ERROR', speed: 0, eta: null });
    const done = await waitStatus(mgr, live.id, 'completed');
    expect(done).toMatchObject({ receivedBytes: 60_000, speed: 0, eta: 0, errorCode: null });
    // Derived fields are never persisted.
    await mgr.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'downloads.json'), 'utf8')).items[0];
    for (const k of ['name', 'host', 'receivedBytes', 'speed', 'eta', 'errorCode']) expect(saved).not.toHaveProperty(k);
  });

  it('throttles progress to ~4/s per item and always ends with a final progress before completion', async () => {
    const body = bytes(80_000);
    fx.routes.set('/thr', { body, chunk: 500, delayMs: 8 });
    const mgr = await open({ progressIntervalMs: 250 });
    const log: Array<{ kind: string; t: number; bytes?: number; status?: string }> = [];
    mgr.on('progress', (p) => log.push({ kind: 'progress', t: Date.now(), bytes: p.bytesDownloaded }));
    mgr.on('status', (i) => log.push({ kind: 'status', t: Date.now(), status: i.status }));
    const started = Date.now();
    const item = await added(mgr, { url: fx.url('/thr') });
    await waitStatus(mgr, item.id, 'completed', 10_000);
    const elapsed = Date.now() - started;
    const progress = log.filter((e) => e.kind === 'progress');
    // Throttled ones are >= 250 ms apart; only the final one may come sooner.
    for (let i = 1; i < progress.length - 1; i++) expect(progress[i].t - progress[i - 1].t).toBeGreaterThanOrEqual(240);
    expect(progress.length).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 2);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    const completedAt = log.findIndex((e) => e.status === 'completed');
    expect(log[completedAt - 1]).toMatchObject({ kind: 'progress', bytes: body.length });
  });

  it('emits a final progress (with the kept bytes) right before a pause', async () => {
    fx.routes.set('/thp', { body: bytes(200_000), chunk: 1000, delayMs: 5 });
    const mgr = await open({ progressIntervalMs: 250 });
    const log: Array<{ kind: string; bytes?: number; status?: string }> = [];
    mgr.on('progress', (p) => log.push({ kind: 'progress', bytes: p.bytesDownloaded }));
    mgr.on('status', (i) => log.push({ kind: 'status', status: i.status }));
    const item = await added(mgr, { url: fx.url('/thp') });
    await waitFor(() => (mgr.get(item.id)?.bytesDownloaded ?? 0) > 20_000);
    await mgr.pause(item.id);
    const pausedAt = log.findIndex((e) => e.status === 'paused');
    const kept = fs.statSync(item.partPath).size;
    expect(kept).toBeGreaterThan(0);
    expect(log[pausedAt - 1]).toEqual({ kind: 'progress', bytes: kept });
    expect(mgr.get(item.id)).toMatchObject({ status: 'paused', receivedBytes: kept, speed: 0, eta: null });
  });
});

describe('persistence', () => {
  it('round-trips an item with a source and a destDir override', async () => {
    const other = tmp();
    const real = fs.realpathSync(other);
    const mgr = await open({ autoStart: false });
    const item = await added(mgr, { url: fx.url('/ov.bin'), source: 'src-1', destDir: other, subdir: 'x' });
    await mgr.close();

    const again = await open({ autoStart: false });
    expect(again.get(item.id)).toMatchObject({ source: 'src-1', destDir: real, destPath: path.join(real, 'x', 'ov.bin'), partPath: path.join(real, 'x', 'ov.bin.part'), status: 'queued' });
    fx.routes.set('/ov.bin', { body: bytes(42) });
    again.start();
    await waitStatus(again, item.id, 'completed');
    expect(fs.readFileSync(path.join(real, 'x', 'ov.bin'))).toEqual(bytes(42));
  });

  it('setBaseDir only changes where new downloads go; items keep their own root across a restart', async () => {
    fx.routes.set('/one.bin', { body: bytes(11) });
    fx.routes.set('/two.bin', { body: bytes(22) });
    fx.routes.set('/three.bin', { body: bytes(33) });
    const a = fs.realpathSync(baseDir);
    const b = fs.realpathSync(tmp());
    const c = fs.realpathSync(tmp());
    const mgr = await open({ autoStart: false });
    const one = await added(mgr, { url: fx.url('/one.bin'), source: 's' });
    const set = await mgr.setBaseDir(b);
    expect(set).toEqual({ ok: true, settings: expect.objectContaining({ baseDir: b }) });
    expect(mgr.getSettings().baseDir).toBe(b);
    expect(mgr.get(one.id)).toMatchObject({ root: a, destPath: path.join(a, 's', 'one.bin') });
    const two = await added(mgr, { url: fx.url('/two.bin'), source: 's' });
    expect(two).toMatchObject({ root: b, destPath: path.join(b, 's', 'two.bin') });
    // Bad new base dirs are refused and change nothing.
    expect(await mgr.setBaseDir(path.join(c, 'missing'))).toEqual({ ok: false, code: 'INVALID_PATH', message: `Download folder not found: ${path.join(c, 'missing')}` });
    expect(await mgr.setBaseDir('relative/dir')).toMatchObject({ ok: false, code: 'INVALID_PATH' });
    expect(await mgr.setBaseDir(`${c}/../x`)).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(fs.existsSync(path.join(c, 'missing'))).toBe(false);
    expect(mgr.getSettings().baseDir).toBe(b);
    await mgr.close();

    // Restart with yet another base dir: both items survive in their own roots.
    const again = await open({ baseDir: c, autoStart: false });
    expect(again.list().map((i) => [i.id, i.root])).toEqual([[one.id, a], [two.id, b]]);
    const three = await added(again, { url: fx.url('/three.bin'), source: 's' });
    expect(three.root).toBe(c);
    again.start();
    for (const it of [one, two, three]) await waitStatus(again, it.id, 'completed');
    expect(fs.readFileSync(path.join(a, 's', 'one.bin'))).toEqual(bytes(11));
    expect(fs.readFileSync(path.join(b, 's', 'two.bin'))).toEqual(bytes(22));
    expect(fs.readFileSync(path.join(c, 's', 'three.bin'))).toEqual(bytes(33));
  });

  it('restores only items inside the base dir or their own recorded override', async () => {
    const recorded = tmp();
    const elsewhere = fs.realpathSync(tmp());
    const mgr = await open({ autoStart: false });
    const ok = await added(mgr, { url: fx.url('/ok.bin'), destDir: recorded });
    const inBase = await added(mgr, { url: fx.url('/b.bin') });
    const moved = await added(mgr, { url: fx.url('/m.bin'), destDir: recorded });
    const noOverride = await added(mgr, { url: fx.url('/n.bin') });
    const rerooted = await added(mgr, { url: fx.url('/r.bin'), destDir: recorded });
    const relRoot = await added(mgr, { url: fx.url('/rr.bin') });
    const legacy = await added(mgr, { url: fx.url('/l.bin') });
    await mgr.close();
    const file = path.join(stateDir, 'downloads.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const it of state.items) {
      // Tamper: point items at a folder that was never recorded for them.
      if (it.id === moved.id || it.id === noOverride.id) {
        it.destPath = path.join(elsewhere, 'evil.bin');
        it.partPath = `${it.destPath}.part`;
      }
      // Root (and paths) moved consistently, but no longer the recorded override.
      if (it.id === rerooted.id) {
        it.root = elsewhere;
        it.destPath = path.join(elsewhere, 'r.bin');
        it.partPath = `${it.destPath}.part`;
      }
      // A relative root.
      if (it.id === relRoot.id) it.root = 'relative';
      // Entries written before `root` existed fall back to destDir / the base dir.
      if (it.id === legacy.id) delete it.root;
    }
    fs.writeFileSync(file, JSON.stringify(state));
    const again = await open({ autoStart: false });
    expect(again.list().map((i) => i.id).sort()).toEqual([ok.id, inBase.id, legacy.id].sort());
    expect(again.get(legacy.id)?.root).toBe(path.resolve(baseDir));
  });

  it('round-trips the queue through the state file', async () => {
    const mgr = await open({ autoStart: false });
    const a = await added(mgr, { url: fx.url('/a'), subdir: 'g', checksum: { algorithm: 'sha256', value: 'a'.repeat(64) }, meta: { source: 'user-1' } });
    const b = await added(mgr, { url: fx.url('/b'), expectedSize: 10 });
    await mgr.pause(b.id);
    await mgr.close();
    const file = path.join(stateDir, 'downloads.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
    expect(fs.readdirSync(stateDir)).toEqual(['downloads.json']);

    const again = await open({ autoStart: false });
    const list = again.list();
    expect(list.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(list[0]).toMatchObject({ status: 'queued', destPath: path.join(baseDir, 'g', 'a'), checksum: a.checksum, meta: { source: 'user-1' } });
    expect(list[1]).toMatchObject({ status: 'paused', expectedSize: 10 });
    // New items continue the order.
    const c = await added(again, { url: fx.url('/c') });
    expect(c.seq).toBeGreaterThan(list[1].seq);
  });

  it('restores an interrupted download as paused and resumes it with Range', async () => {
    const body = bytes(30_000);
    fx.routes.set('/int', { body, chunk: 1000, delayMs: 10, etag: '"e"' });
    const mgr = await open();
    const item = await added(mgr, { url: fx.url('/int') });
    await waitFor(() => (mgr.get(item.id)?.bytesDownloaded ?? 0) >= 4000);
    await mgr.close();
    const kept = fs.statSync(item.partPath).size;

    const again = await open();
    expect(again.get(item.id)).toMatchObject({ status: 'paused', bytesDownloaded: kept, etag: '"e"' });
    await again.resume(item.id);
    await waitStatus(again, item.id, 'completed');
    expect(fx.requests[fx.requests.length - 1]).toMatchObject({ range: `bytes=${kept}-`, ifRange: '"e"' });
    expect(fs.readFileSync(item.destPath).equals(body)).toBe(true);
  });

  it('autoResume restores interrupted downloads as queued and restarts them', async () => {
    fx.routes.set('/ar', { body: bytes(20_000), chunk: 1000, delayMs: 10 });
    const mgr = await open({ autoResume: true });
    const item = await added(mgr, { url: fx.url('/ar') });
    await waitFor(() => (mgr.get(item.id)?.bytesDownloaded ?? 0) >= 2000);
    await mgr.close();
    const again = await open({ autoResume: true });
    await waitStatus(again, item.id, 'completed');
  });

  it('setAutoResume switches restore behaviour at runtime and shows in settings', async () => {
    fx.routes.set('/ar2', { body: bytes(20_000), chunk: 1000, delayMs: 10 });
    const mgr = await open();
    expect(mgr.getSettings().autoResume).toBe(false);
    expect(mgr.setAutoResume(true)).toEqual({ ok: true, settings: expect.objectContaining({ autoResume: true }) });
    const item = await added(mgr, { url: fx.url('/ar2') });
    await waitFor(() => (mgr.get(item.id)?.bytesDownloaded ?? 0) >= 2000);
    await mgr.close();
    const again = await open();
    expect(['queued', 'downloading', 'completed']).toContain(again.get(item.id)?.status);
    await waitStatus(again, item.id, 'completed');
    expect(again.setAutoResume('yes' as unknown as boolean)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(again.getSettings().autoResume).toBe(false);
  });

  it('starts empty when the state file is corrupt, keeping a backup', async () => {
    fs.writeFileSync(path.join(stateDir, 'downloads.json'), '{"version":1,"items":[');
    const mgr = await DownloadManager.open({ baseDir, stateDir, freeSpace: async () => null });
    managers.push(mgr);
    expect(mgr.list()).toEqual([]);
    expect(fs.readdirSync(stateDir).some((f) => f.startsWith('downloads.json.corrupt-'))).toBe(true);
  });
});
