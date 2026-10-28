/**
 * Queue persistence: one JSON file in a given dir, written atomically
 * (temp file + fsync + rename) and serialised so a later snapshot never loses
 * to an earlier one. A corrupt file is moved aside (`.corrupt-<ts>`) and the
 * queue starts empty instead of crashing startup.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DownloadItem, DownloadStatus } from './types';

export const QUEUE_FILE_VERSION = 1;
const STATUSES: readonly DownloadStatus[] = ['queued', 'downloading', 'verifying', 'paused', 'completed', 'failed', 'cancelled'];

interface QueueFile {
  version: number;
  items: DownloadItem[];
}

export interface LoadResult {
  items: DownloadItem[];
  /** Set when the file existed but was unreadable and was moved aside. */
  corruptBackup?: string;
  /** Entries dropped because they were malformed. */
  dropped: number;
}

function isItem(v: unknown): v is DownloadItem {
  const o = v as Partial<DownloadItem> | null;
  return !!o
    && typeof o.id === 'string' && !!o.id
    && typeof o.url === 'string'
    && typeof o.destPath === 'string' && path.isAbsolute(o.destPath)
    && typeof o.partPath === 'string' && o.partPath === `${o.destPath}.part`
    && typeof o.status === 'string' && STATUSES.includes(o.status)
    && typeof o.seq === 'number' && Number.isFinite(o.seq)
    && typeof o.bytesDownloaded === 'number'
    && (o.totalBytes === null || typeof o.totalBytes === 'number')
    && typeof o.attempts === 'number'
    && (o.source === undefined || typeof o.source === 'string')
    && (o.destDir === undefined || (typeof o.destDir === 'string' && path.isAbsolute(o.destDir)))
    && (o.root === undefined || (typeof o.root === 'string' && path.isAbsolute(o.root)));
}

export class QueueStore {
  readonly file: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(dir: string, fileName = 'downloads.json') {
    this.file = path.join(path.resolve(dir), fileName);
  }

  async load(): Promise<LoadResult> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return { items: [], dropped: 0 };
      throw err;
    }
    let parsed: QueueFile | null = null;
    try {
      const v = JSON.parse(raw) as QueueFile;
      if (v && v.version === QUEUE_FILE_VERSION && Array.isArray(v.items)) parsed = v;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      await fs.promises.rename(this.file, backup).catch(() => undefined);
      return { items: [], corruptBackup: backup, dropped: 0 };
    }
    const items = parsed.items.filter(isItem);
    return { items, dropped: parsed.items.length - items.length };
  }

  /** Atomically replace the file with `items`. Saves run one at a time, in call order. */
  save(items: readonly DownloadItem[]): Promise<void> {
    const body = JSON.stringify({ version: QUEUE_FILE_VERSION, items: [...items] } satisfies QueueFile, null, 2);
    const run = this.chain.then(() => this.write(body));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async write(body: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const fh = await fs.promises.open(tmp, 'w', 0o600);
      try {
        await fh.writeFile(body, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}
