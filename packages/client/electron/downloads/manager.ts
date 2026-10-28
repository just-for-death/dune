/**
 * DownloadManager: a persistent, content-agnostic download queue.
 *
 * - FIFO by enqueue order (`seq`), at most `concurrency` active at once
 *   (changeable at runtime; lowering it lets running items finish).
 * - pause (keeps `.part`), resume (HTTP Range from the `.part` size), cancel
 *   (deletes `.part`), retry (failed/cancelled -> queued, fresh retry budget).
 * - Automatic retries with exponential backoff for transient errors (network,
 *   timeouts, 5xx/408/429, truncated bodies). The slot is released while an
 *   item waits, so other items keep downloading.
 * - Optional checksum (sha256/sha1/md5); a mismatch deletes the `.part` and fails.
 * - Files land in `<baseDir>/<source>/<file>` (or a validated per-download
 *   `destDir` override) via `<dest>.part` -> rename. A taken name is
 *   auto-renamed `name (1).ext` unless `overwrite` is set.
 * - `progress` is throttled per item (default 250 ms, i.e. <= 4/s), with a
 *   final progress event before every status change out of a transfer.
 * - Queue state is saved to `<stateDir>/downloads.json` atomically and
 *   restored by `DownloadManager.open()`; in-flight items come back paused
 *   (or queued with `autoResume`).
 * - No sources, no URLs, no Electron: main wires it to IPC later.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeChecksum, verifyChecksum } from './checksum';
import { TypedEmitter } from './emitter';
import { DownloadError, fail, toDownloadError } from './errors';
import { downloadHttp } from './httpDownloader';
import { SpeedMeter } from './progress';
import { parseDownloadUrl } from './protocol';
import { fileNameFromUrl, numberedName, prepareDestination, relativeSegments, resolveExistingDir, resolveWithinBase, sourceSegment } from './safePath';
import { QueueStore } from './store';
import type {
  DownloadEvents,
  DownloadFailure,
  DownloadItem,
  DownloadRequest,
  DownloadResult,
  DownloadSettings,
  DownloadSnapshot,
  DownloadStatus,
  ProtocolHandler,
} from './types';

export const MAX_CONCURRENCY = 16;

export interface DownloadManagerOptions {
  /**
   * Folder new downloads go to (user-chosen). Must already exist when a
   * download is added; the engine never creates it.
   */
  baseDir: string;
  /** Folder for the queue state file (e.g. userData). */
  stateDir: string;
  stateFileName?: string;
  concurrency?: number;
  /** Automatic retries per attempt for transient errors (default 3). */
  maxRetries?: number;
  /** First backoff delay; doubles each retry up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** 0..1 random jitter source (default Math.random); delay is scaled by 0.5 + 0.5 * random(). */
  random?: () => number;
  /** Min ms between progress events per item (default 250, i.e. at most 4/s). */
  progressIntervalMs?: number;
  /** Debounce for progress-only saves (status changes save at once). */
  persistDebounceMs?: number;
  idleTimeoutMs?: number;
  maxRedirects?: number;
  /** Free bytes at a folder, or null if unknown. Default: fs.statfs. */
  freeSpace?: (dir: string) => Promise<number | null>;
  /** Request headers for an item (e.g. source auth). Never persisted. */
  getHeaders?: (item: Readonly<DownloadItem>) => Record<string, string> | undefined;
  /** Restore in-flight items as queued (true) or paused (false, default). */
  autoResume?: boolean;
  /** Start the queue right after open() (default true). */
  autoStart?: boolean;
  now?: () => number;
}

interface ActiveTask {
  controller: AbortController;
  done: Promise<void>;
}

type StopReason = 'pause' | 'cancel' | 'shutdown';

const TERMINAL: readonly DownloadStatus[] = ['completed', 'cancelled'];
const MAX_RENAME = 9999;

export async function defaultFreeSpace(dir: string): Promise<number | null> {
  if (typeof fs.promises.statfs !== 'function') return null;
  try {
    const s = await fs.promises.statfs(dir, { bigint: true });
    const free = s.bavail * s.bsize;
    return free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free);
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function isTransferring(status: DownloadStatus): boolean {
  return status === 'downloading' || status === 'verifying';
}

export class DownloadManager extends TypedEmitter<DownloadEvents> {
  private readonly items = new Map<string, DownloadItem>();
  private readonly active = new Map<string, ActiveTask>();
  private readonly handlers = new Map<string, ProtocolHandler>();
  private readonly meters = new Map<string, SpeedMeter>();
  private readonly lastProgressAt = new Map<string, number>();
  /** Destinations being claimed by an in-flight add()/retry()/rename. */
  private readonly pendingDests = new Set<string>();
  private readonly store: QueueStore;
  private baseDir: string;
  private concurrency: number;
  private autoResume: boolean;
  private seq = 0;
  private closed = false;
  private started = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSave: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  private constructor(private readonly opts: DownloadManagerOptions) {
    super();
    this.baseDir = path.resolve(opts.baseDir);
    this.store = new QueueStore(opts.stateDir, opts.stateFileName);
    this.concurrency = DownloadManager.checkConcurrency(opts.concurrency ?? 2);
    this.autoResume = opts.autoResume === true;
    this.now = opts.now ?? Date.now;
  }

  private static checkConcurrency(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
      throw new DownloadError('INVALID_STATE', `Concurrency must be an integer 1-${MAX_CONCURRENCY}`);
    }
    return n;
  }

  /** Create a manager and restore its persisted queue. */
  static async open(opts: DownloadManagerOptions): Promise<DownloadManager> {
    const mgr = new DownloadManager(opts);
    await mgr.restore();
    if (opts.autoStart ?? true) mgr.start();
    return mgr;
  }

  private async restore(): Promise<void> {
    const { items, corruptBackup } = await this.store.load();
    if (corruptBackup) this.emit('persistError', fail('IO_ERROR', `Queue file was unreadable; moved to ${corruptBackup}`));
    for (const item of items) {
      // Each item is trusted only inside the root recorded for it at add()
      // (which may differ from the current base dir). Inconsistent entries are dropped.
      const root = (item as Partial<DownloadItem>).root ?? item.destDir ?? this.baseDir;
      if (item.destDir !== undefined && item.destDir !== root) continue;
      if (!isInside(root, item.destPath) || !isInside(root, item.partPath)) continue;
      item.root = root;
      if (item.status === 'downloading' || item.status === 'verifying') {
        item.status = this.autoResume ? 'queued' : 'paused';
      }
      delete item.nextRetryAt;
      if (item.status !== 'completed') item.bytesDownloaded = partSizeSync(item.partPath);
      this.items.set(item.id, item);
      this.seq = Math.max(this.seq, item.seq + 1);
    }
    if (items.length) this.persistNow();
  }

  /** Begin running queued items (open() does this unless autoStart is false). */
  start(): void {
    if (this.closed) return;
    this.started = true;
    this.schedule();
  }

  registerHandler(handler: ProtocolHandler): void {
    for (const p of handler.protocols) {
      const key = p.toLowerCase();
      if (key === 'http:' || key === 'https:') throw new DownloadError('INVALID_STATE', 'http(s) is built in and cannot be replaced');
      this.handlers.set(key, handler);
    }
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  setConcurrency(n: number): DownloadResult {
    try {
      this.concurrency = DownloadManager.checkConcurrency(n);
    } catch (err) {
      return toDownloadError(err).toFailure();
    }
    this.schedule();
    return { ok: true };
  }

  getSettings(): DownloadSettings {
    return { baseDir: this.baseDir, concurrency: this.concurrency, maxConcurrency: MAX_CONCURRENCY, autoResume: this.autoResume };
  }

  /**
   * Change where NEW downloads go. Existing items keep their own recorded
   * root. The folder must exist (it is not created). Not persisted here:
   * the caller saves it in its settings and passes it to open().
   */
  async setBaseDir(dir: string): Promise<DownloadResult<{ settings: DownloadSettings }>> {
    try {
      this.baseDir = await resolveExistingDir(dir, 'baseDir');
    } catch (err) {
      return toDownloadError(err, 'INVALID_PATH').toFailure();
    }
    return { ok: true, settings: this.getSettings() };
  }

  /**
   * Whether in-flight items come back queued (true) or paused (false) after a
   * restart. Takes effect at the next close()/open().
   */
  setAutoResume(enabled: boolean): DownloadResult<{ settings: DownloadSettings }> {
    if (typeof enabled !== 'boolean') return fail('INVALID_STATE', 'autoResume must be true or false');
    this.autoResume = enabled;
    return { ok: true, settings: this.getSettings() };
  }

  list(): DownloadSnapshot[] {
    return [...this.items.values()].sort((a, b) => a.seq - b.seq).map((i) => this.snapshot(i));
  }

  get(id: string): DownloadSnapshot | undefined {
    const item = this.items.get(id);
    return item ? this.snapshot(item) : undefined;
  }

  async add(req: DownloadRequest): Promise<DownloadResult<{ item: DownloadSnapshot }>> {
    if (this.closed) return fail('INVALID_STATE', 'Download manager is closed');
    try {
      const { url, handler } = parseDownloadUrl(req?.url, this.handlers);
      const checksum = req.checksum !== undefined ? normalizeChecksum(req.checksum) : undefined;
      if (req.expectedSize !== undefined && (!Number.isSafeInteger(req.expectedSize) || req.expectedSize < 0)) {
        throw new DownloadError('INVALID_STATE', 'expectedSize must be a non-negative integer');
      }
      if (handler && !req.fileName) throw new DownloadError('INVALID_PATH', `fileName is required for ${url.protocol} downloads`);
      const source = req.source !== undefined ? sourceSegment(req.source) : undefined;
      const destDir = req.destDir !== undefined ? await resolveExistingDir(req.destDir, 'destDir') : undefined;
      const root = destDir ?? (await this.currentBaseRoot());
      // The override replaces <baseDir>/<source>; subdir and fileName still apply under it.
      const sub = [...(source && !destDir ? [source] : []), ...(req.subdir ? relativeSegments(req.subdir, 'subdir') : [])].join('/');
      const wanted = resolveWithinBase(root, req.fileName ?? fileNameFromUrl(url), sub || undefined);
      let destPath: string;
      if (req.overwrite) {
        destPath = wanted;
        await this.claimForOverwrite(destPath);
      } else {
        destPath = await this.claimFreeDest(wanted);
      }
      const partPath = `${destPath}.part`;

      const ts = new Date(this.now()).toISOString();
      const item: DownloadItem = {
        id: crypto.randomUUID(),
        url: url.href,
        destPath,
        partPath,
        ...(source ? { source } : {}),
        ...(destDir ? { destDir } : {}),
        root,
        ...(handler ? { handler: handler.id } : {}),
        status: 'queued',
        seq: this.seq++,
        bytesDownloaded: 0,
        totalBytes: req.expectedSize ?? null,
        ...(checksum ? { checksum } : {}),
        ...(req.expectedSize !== undefined ? { expectedSize: req.expectedSize } : {}),
        ...(req.overwrite ? { overwrite: true } : {}),
        ...(req.meta ? { meta: { ...req.meta } } : {}),
        attempts: 0,
        createdAt: ts,
        updatedAt: ts,
      };
      this.items.set(item.id, item);
      this.pendingDests.delete(destPath);
      this.emit('added', this.snapshot(item));
      this.persistNow();
      this.schedule();
      return { ok: true, item: this.snapshot(item) };
    } catch (err) {
      return toDownloadError(err, 'INVALID_STATE').toFailure();
    }
  }

  async pause(id: string): Promise<DownloadResult> {
    const item = this.items.get(id);
    if (!item) return fail('NOT_FOUND', 'No such download');
    if (item.status === 'paused') return { ok: true };
    if (item.status !== 'queued' && item.status !== 'downloading' && item.status !== 'verifying') {
      return fail('INVALID_STATE', `Cannot pause a ${item.status} download`);
    }
    await this.stop(item, 'pause');
    // It may have finished while we were stopping it.
    const settled = statusOf(item);
    if (settled === 'completed' || settled === 'failed') return fail('INVALID_STATE', `Download already ${settled}`);
    delete item.nextRetryAt;
    this.setStatus(item, 'paused');
    this.schedule();
    return { ok: true };
  }

  async resume(id: string): Promise<DownloadResult> {
    const item = this.items.get(id);
    if (!item) return fail('NOT_FOUND', 'No such download');
    if (item.status === 'queued' || item.status === 'downloading' || item.status === 'verifying') return { ok: true };
    if (item.status !== 'paused') return fail('INVALID_STATE', `Cannot resume a ${item.status} download`);
    this.setStatus(item, 'queued');
    this.schedule();
    return { ok: true };
  }

  async cancel(id: string): Promise<DownloadResult> {
    const item = this.items.get(id);
    if (!item) return fail('NOT_FOUND', 'No such download');
    if (item.status === 'completed') return fail('INVALID_STATE', 'Download already completed');
    if (item.status === 'cancelled') return { ok: true };
    await this.stop(item, 'cancel');
    if (statusOf(item) === 'completed') return fail('INVALID_STATE', 'Download already completed');
    await fs.promises.rm(item.partPath, { force: true }).catch(() => undefined);
    item.bytesDownloaded = 0;
    delete item.nextRetryAt;
    this.setStatus(item, 'cancelled');
    this.schedule();
    return { ok: true };
  }

  /** Re-queue a failed or cancelled download with a fresh retry budget. */
  async retry(id: string): Promise<DownloadResult> {
    const item = this.items.get(id);
    if (!item) return fail('NOT_FOUND', 'No such download');
    if (item.status !== 'failed' && item.status !== 'cancelled') return fail('INVALID_STATE', `Cannot retry a ${item.status} download`);
    if (!item.overwrite && (await exists(item.destPath))) {
      // Something took the name meanwhile: move to the next free one, keeping the .part.
      try {
        const next = await this.claimFreeDest(item.destPath, item.id);
        try {
          if (await exists(item.partPath)) await fs.promises.rename(item.partPath, `${next}.part`);
          item.destPath = next;
          item.partPath = `${next}.part`;
        } finally {
          this.pendingDests.delete(next);
        }
      } catch (err) {
        return toDownloadError(err, 'IO_ERROR').toFailure();
      }
    }
    item.attempts = 0;
    delete item.error;
    delete item.nextRetryAt;
    this.setStatus(item, 'queued');
    this.schedule();
    return { ok: true };
  }

  /** Forget a finished/failed/cancelled/paused item. Never deletes the downloaded file. */
  async remove(id: string): Promise<DownloadResult> {
    const item = this.items.get(id);
    if (!item) return fail('NOT_FOUND', 'No such download');
    if (this.active.has(id) || item.status === 'downloading' || item.status === 'verifying') {
      return fail('INVALID_STATE', 'Pause or cancel the download first');
    }
    if (item.status !== 'completed') await fs.promises.rm(item.partPath, { force: true }).catch(() => undefined);
    this.items.delete(id);
    this.meters.delete(id);
    this.lastProgressAt.delete(id);
    this.emit('removed', id);
    this.persistNow();
    return { ok: true };
  }

  /**
   * Pick the first free `name (n).ext` for `wanted`, considering files on disk,
   * their `.part`s and every other queue item's destination. The result is
   * reserved in `pendingDests`; the caller must release it.
   */
  private async claimFreeDest(wanted: string, selfId?: string): Promise<string> {
    const dir = path.dirname(wanted);
    const name = path.basename(wanted);
    for (let n = 0; n <= MAX_RENAME; n++) {
      const candidate = path.join(dir, numberedName(name, n));
      // In-memory check and reservation are synchronous, so concurrent adds can't pick the same name.
      if (this.pendingDests.has(candidate)) continue;
      if ([...this.items.values()].some((o) => o.id !== selfId && (o.destPath === candidate || o.partPath === candidate))) continue;
      this.pendingDests.add(candidate);
      const own = selfId !== undefined && this.items.get(selfId)?.destPath === candidate;
      // Our own .part may sit next to our own name; anyone else's .part makes the name taken.
      if ((await exists(candidate)) || (!own && (await exists(`${candidate}.part`)))) {
        this.pendingDests.delete(candidate);
        continue;
      }
      return candidate;
    }
    throw new DownloadError('IO_ERROR', 'No free file name for this download');
  }

  /** Realpath of the current base dir; it must exist (never created). */
  private async currentBaseRoot(): Promise<string> {
    const real = await fs.promises.realpath(this.baseDir).catch(() => null);
    if (real === null) throw new DownloadError('IO_ERROR', `Download folder not found: ${this.baseDir}`);
    return real;
  }

  /** `overwrite: true`: the exact path, but never a symlink, never one another active item is writing. */
  private async claimForOverwrite(destPath: string): Promise<void> {
    const partPath = `${destPath}.part`;
    if (this.pendingDests.has(destPath)) throw new DownloadError('DUPLICATE_DEST', 'Another download already targets this file');
    let owner: DownloadItem | undefined;
    for (const other of this.items.values()) {
      if (other.destPath !== destPath) continue;
      if (!TERMINAL.includes(other.status)) throw new DownloadError('DUPLICATE_DEST', 'Another download already targets this file');
      owner = other;
    }
    for (const p of [destPath, partPath]) {
      const st = await fs.promises.lstat(p).catch(() => null);
      if (st?.isSymbolicLink()) throw new DownloadError('PATH_TRAVERSAL', 'Destination is a symbolic link');
    }
    this.pendingDests.add(destPath);
    // A stray .part with no validators would be resumed blindly; start clean.
    if (!owner) await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
  }

  /** Wait for pending queue writes. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistNow();
    }
    await this.lastSave;
  }

  /** Stop all work (in-flight items are saved paused, or queued with autoResume) and flush. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    await Promise.all([...this.active.keys()].map((id) => {
      const item = this.items.get(id)!;
      return this.stop(item, 'shutdown').then(() => {
        if (item.status === 'downloading' || item.status === 'verifying') this.setStatus(item, this.autoResume ? 'queued' : 'paused');
      });
    }));
    await this.flush();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async stop(item: DownloadItem, reason: StopReason): Promise<void> {
    const task = this.active.get(item.id);
    if (!task) return;
    task.controller.abort(reason);
    await task.done;
  }

  private setStatus(item: DownloadItem, status: DownloadStatus): void {
    const previous = item.status;
    if (previous === status) return;
    // Final, unthrottled progress for the transfer that is ending.
    if (isTransferring(previous)) this.emitProgress(item);
    item.status = status;
    item.updatedAt = new Date(this.now()).toISOString();
    this.emit('status', this.snapshot(item), previous);
    this.persistNow();
  }

  private schedule(): void {
    if (!this.started || this.closed) return;
    const now = this.now();
    let nextWake = Infinity;
    const queued = [...this.items.values()].filter((i) => i.status === 'queued' && !this.active.has(i.id)).sort((a, b) => a.seq - b.seq);
    for (const item of queued) {
      if (this.active.size >= this.concurrency) break;
      if (item.nextRetryAt !== undefined && item.nextRetryAt > now) {
        nextWake = Math.min(nextWake, item.nextRetryAt);
        continue;
      }
      delete item.nextRetryAt;
      this.run(item);
    }
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (nextWake !== Infinity) {
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.schedule();
      }, Math.max(0, nextWake - now));
      this.wakeTimer.unref?.();
    }
  }

  private run(item: DownloadItem): void {
    const controller = new AbortController();
    const task: ActiveTask = { controller, done: Promise.resolve() };
    this.active.set(item.id, task);
    const meter = new SpeedMeter();
    this.meters.set(item.id, meter);
    this.lastProgressAt.delete(item.id);
    this.setStatus(item, 'downloading');
    task.done = this.attempt(item, controller.signal, meter)
      .catch((err) => this.onAttemptError(item, controller.signal, err))
      .finally(() => {
        this.active.delete(item.id);
        this.schedule();
      });
  }

  private async attempt(item: DownloadItem, signal: AbortSignal, meter: SpeedMeter): Promise<void> {
    // The item's root must still be the very folder recorded at add() (no
    // swapped-in symlink). It is never created: it may be an unmounted drive,
    // and retry() works once it is back. Only folders below it are created.
    const real = await fs.promises.realpath(item.root).catch(() => null);
    if (real === null) throw new DownloadError('IO_ERROR', `Download folder not found: ${item.root}`);
    if (real !== item.root) throw new DownloadError('PATH_TRAVERSAL', 'Download folder now resolves elsewhere');
    await prepareDestination(item.root, item.destPath, item.partPath);
    const onData = (bytes: number, total: number | null) => this.onProgress(item, meter, bytes, total);

    if (item.handler) {
      const handler = [...this.handlers.values()].find((h) => h.id === item.handler);
      if (!handler) throw new DownloadError('PROTOCOL_NOT_ALLOWED', `No handler "${item.handler}" is registered`);
      try {
        await handler.download({ item: this.snapshot(item), partPath: item.partPath, signal, onProgress: onData });
      } catch (err) {
        if (signal.aborted) throw err;
        throw err instanceof DownloadError ? err : new DownloadError('HANDLER_ERROR', err instanceof Error ? err.message : String(err), { cause: err });
      }
      if (!(await exists(item.partPath))) throw new DownloadError('HANDLER_ERROR', 'Handler finished without writing the file');
    } else {
      const res = await downloadHttp({
        url: item.url,
        partPath: item.partPath,
        signal,
        etag: item.etag,
        lastModified: item.lastModified,
        expectedSize: item.expectedSize,
        headers: this.opts.getHeaders?.(this.snapshot(item)),
        maxRedirects: this.opts.maxRedirects,
        idleTimeoutMs: this.opts.idleTimeoutMs,
        onResponse: async (info) => {
          if (info.etag) item.etag = info.etag;
          if (info.lastModified) item.lastModified = info.lastModified;
          item.totalBytes = info.totalBytes;
          if (info.totalBytes !== null) await this.checkSpace(item, info.totalBytes - info.startByte);
        },
        onData,
      });
      item.totalBytes = res.totalBytes;
    }
    // Throttled update; the status change below emits the final progress.
    this.onProgress(item, meter, (await fs.promises.stat(item.partPath)).size, item.totalBytes);

    if (item.checksum) {
      this.setStatus(item, 'verifying');
      await verifyChecksum(item.partPath, item.checksum, signal);
    }
    if (signal.aborted) throw signal.reason;
    if (!item.overwrite && (await exists(item.destPath))) {
      // A file appeared at the name meanwhile: finish under the next free name.
      const next = await this.claimFreeDest(item.destPath, item.id);
      try {
        await fs.promises.rename(item.partPath, next);
        item.destPath = next;
        item.partPath = `${next}.part`;
      } finally {
        this.pendingDests.delete(next);
      }
    } else {
      await fs.promises.rename(item.partPath, item.destPath);
    }

    item.attempts = 0;
    delete item.error;
    item.completedAt = new Date(this.now()).toISOString();
    this.setStatus(item, 'completed');
    this.emit('completed', this.snapshot(item));
  }

  private async onAttemptError(item: DownloadItem, signal: AbortSignal, err: unknown): Promise<void> {
    if (signal.aborted) {
      // pause/cancel/close set the status themselves; just record the bytes kept.
      item.bytesDownloaded = partSizeSync(item.partPath);
      return;
    }
    const e = toDownloadError(err);
    item.bytesDownloaded = partSizeSync(item.partPath);
    if (e.code === 'CHECKSUM_MISMATCH' || e.code === 'SIZE_MISMATCH') {
      // The bytes are wrong; resuming from them would never succeed.
      await fs.promises.rm(item.partPath, { force: true }).catch(() => undefined);
      item.bytesDownloaded = 0;
      delete item.etag;
      delete item.lastModified;
    }
    const failure = e.toFailure();
    const maxRetries = this.opts.maxRetries ?? 3;
    if (e.retryable && item.attempts < maxRetries && !this.closed) {
      item.attempts += 1;
      const base = this.opts.retryBaseMs ?? 1000;
      const cap = this.opts.retryMaxMs ?? 60_000;
      const jitter = 0.5 + 0.5 * (this.opts.random ?? Math.random)();
      const delayMs = Math.round(Math.min(cap, base * 2 ** (item.attempts - 1)) * jitter);
      item.nextRetryAt = this.now() + delayMs;
      item.error = failure;
      this.emit('retrying', this.snapshot(item), item.attempts, delayMs, failure);
      this.setStatus(item, 'queued');
      return;
    }
    item.error = failure;
    this.setStatus(item, 'failed');
    this.emit('failed', this.snapshot(item), failure);
  }

  private async checkSpace(item: DownloadItem, needed: number): Promise<void> {
    if (needed <= 0) return;
    const freeSpace = this.opts.freeSpace ?? defaultFreeSpace;
    const free = await freeSpace(path.dirname(item.destPath));
    if (free !== null && free < needed) {
      throw new DownloadError('INSUFFICIENT_SPACE', `Need ${needed} bytes, only ${free} free`);
    }
  }

  private onProgress(item: DownloadItem, meter: SpeedMeter, bytes: number, total: number | null): void {
    item.bytesDownloaded = bytes;
    if (total !== null) item.totalBytes = total;
    const now = this.now();
    meter.sample(bytes, now);
    const interval = this.opts.progressIntervalMs ?? 250;
    const last = this.lastProgressAt.get(item.id);
    if (last !== undefined && now - last < interval) return;
    this.emitProgress(item);
  }

  private emitProgress(item: DownloadItem): void {
    const meter = this.meters.get(item.id);
    this.lastProgressAt.set(item.id, this.now());
    this.emit('progress', {
      id: item.id,
      bytesDownloaded: item.bytesDownloaded,
      totalBytes: item.totalBytes,
      speed: meter?.speed() ?? 0,
      etaSeconds: meter ? meter.eta(item.bytesDownloaded, item.totalBytes) : null,
    });
    this.persistSoon();
  }

  /** Persisted fields plus UI-derived ones (name, host, receivedBytes, live speed/eta, errorCode). */
  private snapshot(item: DownloadItem): DownloadSnapshot {
    const copy = structuredClone(item);
    const meter = this.active.has(item.id) && isTransferring(item.status) ? this.meters.get(item.id) : undefined;
    // A fresh sample lets the speed decay while a transfer stalls.
    meter?.sample(item.bytesDownloaded, this.now());
    return {
      ...copy,
      name: path.basename(item.destPath),
      host: hostOf(item.url),
      receivedBytes: item.bytesDownloaded,
      speed: meter ? meter.speed() : 0,
      eta: item.status === 'completed' ? 0 : meter ? meter.eta(item.bytesDownloaded, item.totalBytes) : null,
      errorCode: item.error?.code ?? null,
    };
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, this.opts.persistDebounceMs ?? 500);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    const items = [...this.items.values()].sort((a, b) => a.seq - b.seq).map((i) => {
      const copy = structuredClone(i);
      delete copy.nextRetryAt;
      return copy;
    });
    this.lastSave = this.store.save(items).catch((err) => {
      this.emit('persistError', toDownloadError(err).toFailure() as DownloadFailure);
    });
  }
}

/** Current status, read fresh (it changes across awaits, which TS narrowing can't see). */
function statusOf(item: DownloadItem): DownloadStatus {
  return item.status;
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function partSizeSync(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.promises.lstat(p).then(() => true, () => false);
}
