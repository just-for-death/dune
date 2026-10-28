import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheFileName, createDiskCache, CACHE_DIR_NAME } from './diskCache';
import { tempDir, PNG } from './testHelpers';

let dir: string;
let t: number;
const now = () => t;
beforeEach(async () => { dir = await tempDir(); t = 1_800_000_000_000; });
afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });
const mk = (over: Partial<Parameters<typeof createDiskCache>[0]> = {}) =>
  createDiskCache({ userDataDir: dir, namespace: 'test', ttlMs: 1000, maxBytes: 10_000, now, ...over });

describe('disk cache', () => {
  it('round-trips JSON with storedAt and writes 0600 files under userData/provider-cache/<ns>', async () => {
    const c = mk();
    await c.setJson('Elden Ring', { a: 1 });
    expect(await c.getJson('Elden Ring')).toEqual({ value: { a: 1 }, storedAt: t });
    expect(c.dir).toBe(path.join(dir, CACHE_DIR_NAME, 'test'));
    const names = await fs.promises.readdir(c.dir);
    expect(names).toEqual([cacheFileName('test', 'Elden Ring')]);
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.entry$/);
    expect((await fs.promises.stat(path.join(c.dir, names[0]))).mode & 0o777).toBe(0o600);
  });

  it('hashes keys so traversal-looking keys stay inside the cache dir', async () => {
    const c = mk();
    for (const k of ['../../etc/passwd', '/abs/path', 'a\0b', 'C:\\x', '']) await c.setJson(k, k);
    const names = await fs.promises.readdir(c.dir);
    expect(names).toHaveLength(5);
    expect(names.every((n) => /^[0-9a-f]{64}\.entry$/.test(n))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'etc'))).toBe(false);
    expect((await c.getJson('../../etc/passwd'))?.value).toBe('../../etc/passwd');
    expect(cacheFileName('a', 'k')).not.toBe(cacheFileName('b', 'k'));
  });

  it('expires entries after the TTL and deletes them', async () => {
    const c = mk();
    await c.setJson('k', 1);
    t += 999;
    expect(await c.getJson('k')).not.toBeNull();
    t += 1;
    expect(await c.getJson('k')).toBeNull();
    expect(await c.size()).toBe(0);
  });

  it('treats corrupt, truncated, wrong-kind and future-dated entries as misses and removes them', async () => {
    const c = mk();
    await c.setJson('k', { ok: 1 });
    const f = path.join(c.dir, cacheFileName('test', 'k'));
    for (const junk of ['garbage', 'DUNC1\n{"storedAt":1', 'DUNC1\n{"storedAt":"x","kind":"json"}\n1', `DUNC1\n{"storedAt":${t},"kind":"json"}\n{bad`]) {
      await fs.promises.writeFile(f, junk);
      expect(await c.getJson('k')).toBeNull();
      expect(fs.existsSync(f)).toBe(false);
    }
    await c.setBytes('k', PNG, 'image/png');
    expect(await c.getJson('k')).toBeNull();
    await fs.promises.writeFile(f, `DUNC1\n{"storedAt":${t + 3_600_000},"kind":"json"}\n1`);
    expect(await c.getJson('k')).toBeNull();
  });

  it('round-trips bytes with a content type', async () => {
    const c = mk();
    await c.setBytes('https://cdn2.steamgriddb.com/grid/a.png', PNG, 'image/png');
    const e = await c.getBytes('https://cdn2.steamgriddb.com/grid/a.png');
    expect(e?.contentType).toBe('image/png');
    expect(Array.from(e!.bytes)).toEqual(Array.from(PNG));
  });

  it('evicts least recently used entries to stay under the size cap', async () => {
    const c = mk({ maxBytes: 2_500, ttlMs: 1e9 });
    const blob = new Uint8Array(1000);
    await c.setBytes('a', blob, 'x'); t += 1000;
    await c.setBytes('b', blob, 'x'); t += 1000;
    expect(await c.getBytes('a')).not.toBeNull(); // a is now more recent than b
    t += 1000;
    await c.setBytes('c', blob, 'x');
    expect(await c.getBytes('b')).toBeNull();
    expect(await c.getBytes('a')).not.toBeNull();
    expect(await c.getBytes('c')).not.toBeNull();
    expect(await c.size()).toBeLessThanOrEqual(2_500);
  });

  it('does not store an entry larger than the cap', async () => {
    const c = mk({ maxBytes: 100 });
    await c.setBytes('big', new Uint8Array(200), 'x');
    expect(await c.getBytes('big')).toBeNull();
    expect(await c.size()).toBe(0);
  });

  it('cleans up stale temp files, deletes and clears', async () => {
    const c = mk();
    await c.setJson('k', 1);
    const tmp = path.join(c.dir, '.leftover.123.abc.tmp');
    await fs.promises.writeFile(tmp, 'x');
    const old = new Date(t - 120_000);
    await fs.promises.utimes(tmp, old, old);
    await c.setJson('k2', 2);
    expect(fs.existsSync(tmp)).toBe(false);
    await c.delete('k');
    expect(await c.getJson('k')).toBeNull();
    await c.clear();
    expect(fs.existsSync(c.dir)).toBe(false);
    expect(await c.getJson('k2')).toBeNull();
  });

  it('exposes a ProviderCache view and rejects bad namespaces/limits', async () => {
    const pc = mk().asProviderCache<{ n: number }>();
    await pc.set('x', { n: 1 });
    expect(await pc.get('x')).toEqual({ value: { n: 1 }, storedAt: t });
    expect(() => mk({ namespace: '../up' })).toThrow();
    expect(() => mk({ namespace: 'A' })).toThrow();
    expect(() => mk({ maxBytes: 0 })).toThrow();
  });

  it('never throws when the cache dir is unusable', async () => {
    await fs.promises.mkdir(path.join(dir, CACHE_DIR_NAME), { recursive: true });
    await fs.promises.writeFile(path.join(dir, CACHE_DIR_NAME, 'test'), 'a file, not a dir');
    const c = mk();
    await expect(c.setJson('k', 1)).resolves.toBeUndefined();
    await expect(c.getJson('k')).resolves.toBeNull();
  });
});
