import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { CacheEntry, ProviderCache } from '@dune/providers';
import { isAtomicTempName, writeFileAtomic } from './atomicFile';

/**
 * On-disk cache for provider responses (JSON) and artwork (bytes), under
 * `<userData>/provider-cache/<namespace>/`.
 *
 * - File names are sha256(namespace, key) hex + `.entry`; a caller key never
 *   becomes part of a path (no traversal, no odd characters).
 * - Entry format: `DUNC1\n` + one JSON header line `{ storedAt, kind, contentType? }`
 *   + payload (UTF-8 JSON for `kind: 'json'`, raw bytes for `kind: 'bytes'`).
 * - TTL: entries older than `ttlMs` (by `storedAt`) are dropped on read. For
 *   providers that do their own freshness check and fall back to stale data
 *   (HLTB, updates), pass a retention TTL longer than the provider's TTL.
 * - Size cap: after each write the namespace is trimmed to `maxBytes` by
 *   evicting the least recently used entries (last access = file mtime, bumped
 *   on every hit). An entry larger than the cap is not stored.
 * - Writes are atomic (temp file + rename, mode 0600). Corrupt, truncated or
 *   unreadable entries are deleted and read as a miss; nothing here throws.
 */
export const CACHE_DIR_NAME = 'provider-cache';
const MAGIC = Buffer.from('DUNC1\n');
const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SUFFIX = '.entry';

export interface DiskCacheOptions {
  userDataDir: string;
  namespace: string;
  ttlMs: number;
  maxBytes: number;
  now?: () => number;
}

export interface BytesEntry { bytes: Uint8Array; contentType: string; storedAt: number }

export interface DiskCache {
  readonly dir: string;
  getJson<T>(key: string): Promise<CacheEntry<T> | null>;
  setJson<T>(key: string, value: T): Promise<void>;
  getBytes(key: string): Promise<BytesEntry | null>;
  setBytes(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Total bytes currently on disk for this namespace (tests, diagnostics). */
  size(): Promise<number>;
  /** A ProviderCache<T> view over the JSON entries, for @dune/providers. */
  asProviderCache<T>(): ProviderCache<T>;
}

interface Header { storedAt: number; kind: 'json' | 'bytes'; contentType?: string }

export function cacheFileName(namespace: string, key: string): string {
  return createHash('sha256').update(namespace).update('\0').update(key, 'utf8').digest('hex') + SUFFIX;
}

function encode(header: Header, payload: Uint8Array): Buffer {
  return Buffer.concat([MAGIC, Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), payload]);
}

function decode(buf: Buffer): { header: Header; payload: Buffer } | null {
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const nl = buf.indexOf(0x0a, MAGIC.length);
  if (nl < 0) return null;
  try {
    const h = JSON.parse(buf.subarray(MAGIC.length, nl).toString('utf8')) as Partial<Header>;
    if (!h || typeof h.storedAt !== 'number' || !Number.isFinite(h.storedAt)) return null;
    if (h.kind !== 'json' && h.kind !== 'bytes') return null;
    if (h.kind === 'bytes' && typeof h.contentType !== 'string') return null;
    return { header: h as Header, payload: buf.subarray(nl + 1) };
  } catch {
    return null;
  }
}

export function createDiskCache(opts: DiskCacheOptions): DiskCache {
  if (!NAMESPACE_RE.test(opts.namespace)) throw new TypeError('invalid cache namespace');
  if (!(opts.ttlMs > 0) || !(opts.maxBytes > 0)) throw new TypeError('ttlMs and maxBytes must be positive');
  const dir = path.join(opts.userDataDir, CACHE_DIR_NAME, opts.namespace);
  const now = opts.now ?? Date.now;
  const fileFor = (key: string) => path.join(dir, cacheFileName(opts.namespace, key));
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const remove = (file: string) => fs.promises.rm(file, { force: true }).catch(() => {});

  const read = async (key: string, kind: Header['kind']): Promise<{ header: Header; payload: Buffer } | null> => {
    const file = fileFor(key);
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(file);
    } catch {
      return null;
    }
    const entry = decode(buf);
    if (!entry || entry.header.kind !== kind) { await remove(file); return null; }
    const age = now() - entry.header.storedAt;
    if (age >= opts.ttlMs || entry.header.storedAt > now() + 60_000) { await remove(file); return null; }
    // LRU bookkeeping: last access = mtime.
    const t = new Date(now());
    await fs.promises.utimes(file, t, t).catch(() => {});
    return entry;
  };

  const evict = async (): Promise<void> => {
    let names: string[];
    try { names = await fs.promises.readdir(dir); } catch { return; }
    const files: Array<{ file: string; size: number; used: number }> = [];
    let total = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      if (isAtomicTempName(name)) {
        // A leftover from a crashed write (older than a minute): remove it.
        const st = await fs.promises.stat(file).catch(() => null);
        if (st && now() - st.mtimeMs > 60_000) await remove(file);
        continue;
      }
      if (!name.endsWith(SUFFIX)) continue;
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st || !st.isFile()) continue;
      files.push({ file, size: st.size, used: st.mtimeMs });
      total += st.size;
    }
    if (total <= opts.maxBytes) return;
    files.sort((a, b) => a.used - b.used);
    for (const f of files) {
      if (total <= opts.maxBytes) break;
      await remove(f.file);
      total -= f.size;
    }
  };

  const write = (key: string, header: Header, payload: Uint8Array) => exclusive(async () => {
    const data = encode(header, payload);
    if (data.length > opts.maxBytes) return;
    try {
      await writeFileAtomic(fileFor(key), data, 0o600);
      const t = new Date(now());
      await fs.promises.utimes(fileFor(key), t, t).catch(() => {});
      await evict();
    } catch {
      /* a cache write failure is never fatal */
    }
  });

  const cache: DiskCache = {
    dir,
    async getJson<T>(key: string) {
      const e = await read(key, 'json');
      if (!e) return null;
      try {
        return { value: JSON.parse(e.payload.toString('utf8')) as T, storedAt: e.header.storedAt };
      } catch {
        await remove(fileFor(key));
        return null;
      }
    },
    async setJson<T>(key: string, value: T) {
      let json: string | undefined;
      try { json = JSON.stringify(value); } catch { return; }
      if (json === undefined) return;
      await write(key, { storedAt: now(), kind: 'json' }, Buffer.from(json, 'utf8'));
    },
    async getBytes(key) {
      const e = await read(key, 'bytes');
      return e ? { bytes: new Uint8Array(e.payload), contentType: e.header.contentType as string, storedAt: e.header.storedAt } : null;
    },
    async setBytes(key, bytes, contentType) {
      await write(key, { storedAt: now(), kind: 'bytes', contentType }, bytes);
    },
    delete: (key) => exclusive(() => remove(fileFor(key))),
    clear: () => exclusive(() => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})),
    async size() {
      let names: string[];
      try { names = await fs.promises.readdir(dir); } catch { return 0; }
      let total = 0;
      for (const n of names) {
        if (!n.endsWith(SUFFIX)) continue;
        const st = await fs.promises.stat(path.join(dir, n)).catch(() => null);
        if (st) total += st.size;
      }
      return total;
    },
    asProviderCache<T>(): ProviderCache<T> {
      return { get: (key) => cache.getJson<T>(key), set: (key, value) => cache.setJson<T>(key, value) };
    },
  };
  return cache;
}
