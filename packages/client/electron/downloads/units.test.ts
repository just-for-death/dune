import { afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeChecksum, verifyChecksum } from './checksum';
import { TypedEmitter } from './emitter';
import { DownloadError } from './errors';
import { SpeedMeter } from './progress';
import { parseDownloadUrl } from './protocol';
import { fileNameFromUrl, numberedName, prepareDestination, resolveWithinBase, sourceSegment } from './safePath';
import { QueueStore } from './store';
import type { DownloadItem, ProtocolHandler } from './types';

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dl-unit-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as DownloadError).code;
  }
  return undefined;
};

describe('safePath', () => {
  it('resolves names and subdirs inside the base dir', () => {
    const base = tmp();
    expect(resolveWithinBase(base, 'game.zip')).toBe(path.join(base, 'game.zip'));
    expect(resolveWithinBase(base, 'b/c.bin', 'a')).toBe(path.join(base, 'a', 'b', 'c.bin'));
  });

  it.each([
    ['../evil.zip', undefined],
    ['a/../../evil.zip', undefined],
    ['..\\evil.zip', undefined],
    ['/etc/passwd', undefined],
    ['C:\\Windows\\x.dll', undefined],
    ['\\\\server\\share\\x', undefined],
    ['ok.zip', '../outside'],
    ['ok.zip', '/abs'],
    ['a:b', undefined],
  ])('rejects traversal: fileName=%s subdir=%s', (fileName, subdir) => {
    expect(codeOf(() => resolveWithinBase(tmp(), fileName, subdir))).toBe('PATH_TRAVERSAL');
  });

  it.each(['', 'a\0b', 'con', 'x.', 'ab:c', 'a|b', './x'])('rejects invalid name %j', (name) => {
    expect(codeOf(() => resolveWithinBase(tmp(), name))).toBe('INVALID_PATH');
  });

  it('rejects a symlinked sub-folder that points outside the base dir', async () => {
    const base = tmp();
    const outside = tmp();
    fs.symlinkSync(outside, path.join(base, 'link'));
    const dest = resolveWithinBase(base, 'x.bin', 'link');
    await expect(prepareDestination(base, dest, `${dest}.part`)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects a symlinked destination or .part file', async () => {
    const base = tmp();
    const dest = resolveWithinBase(base, 'x.bin');
    fs.symlinkSync(path.join(tmp(), 'target'), `${dest}.part`);
    await expect(prepareDestination(base, dest, `${dest}.part`)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
  });

  it('derives a safe file name from the URL', () => {
    expect(fileNameFromUrl(new URL('https://h/files/My%20Game.zip?x=1'))).toBe('My Game.zip');
    expect(fileNameFromUrl(new URL('https://h/a/..%2F..%2Fetc%2Fpasswd'))).toBe('.._.._etc_passwd');
    expect(fileNameFromUrl(new URL('https://h/'))).toBe('download');
    expect(fileNameFromUrl(new URL('https://h/%2E%2E'))).toBe('download');
  });
});

describe('collision names and source ids', () => {
  it('numbers names the way file managers do', () => {
    expect(numberedName('game.zip', 0)).toBe('game.zip');
    expect(numberedName('game.zip', 1)).toBe('game (1).zip');
    expect(numberedName('pack.tar.gz', 2)).toBe('pack (2).tar.gz');
    expect(numberedName('README', 3)).toBe('README (3)');
    expect(numberedName('.bashrc', 1)).toBe('.bashrc (1)');
    const long = numberedName(`${'a'.repeat(251)}.bin`, 12);
    expect(long.length).toBeLessThanOrEqual(255);
    expect(long.endsWith(' (12).bin')).toBe(true);
  });

  it('accepts one safe segment as a source id', () => {
    expect(sourceSegment('my-source')).toBe('my-source');
    expect(() => sourceSegment('a/b')).toThrow(expect.objectContaining({ code: 'INVALID_PATH' }));
    expect(() => sourceSegment('..')).toThrow(expect.objectContaining({ code: 'PATH_TRAVERSAL' }));
    expect(() => sourceSegment('')).toThrow(expect.objectContaining({ code: 'INVALID_PATH' }));
  });
});

describe('protocol allow-list', () => {
  const none = new Map<string, ProtocolHandler>();
  it('accepts http and https', () => {
    expect(parseDownloadUrl('http://127.0.0.1/a', none).handler).toBeUndefined();
    expect(parseDownloadUrl(' HTTPS://example.test/a ', none).url.protocol).toBe('https:');
  });
  it.each(['ftp://h/a', 'file:///etc/passwd', 'magnet:?xt=urn:btih:abc', 'javascript:alert(1)', 'data:text/plain,hi'])('rejects %s', (url) => {
    expect(codeOf(() => parseDownloadUrl(url, none))).toBe('PROTOCOL_NOT_ALLOWED');
  });
  it('rejects junk and credentials', () => {
    expect(codeOf(() => parseDownloadUrl('not a url', none))).toBe('INVALID_URL');
    expect(codeOf(() => parseDownloadUrl(42, none))).toBe('INVALID_URL');
    expect(codeOf(() => parseDownloadUrl('https://u:p@h/a', none))).toBe('URL_CREDENTIALS');
  });
  it('routes a scheme to a registered handler', () => {
    const handler: ProtocolHandler = { id: 'fake', protocols: ['magnet:'], download: async () => undefined };
    expect(parseDownloadUrl('magnet:?xt=1', new Map([['magnet:', handler]])).handler).toBe(handler);
  });
});

describe('checksum', () => {
  it('normalises and validates specs', () => {
    expect(normalizeChecksum({ algorithm: 'SHA256', value: ` ${'A'.repeat(64)} ` })).toEqual({ algorithm: 'sha256', value: 'a'.repeat(64) });
    expect(codeOf(() => normalizeChecksum({ algorithm: 'crc32', value: 'abcd' }))).toBe('INVALID_CHECKSUM');
    expect(codeOf(() => normalizeChecksum({ algorithm: 'md5', value: 'abc' }))).toBe('INVALID_CHECKSUM');
  });
  it.each(['sha256', 'sha1', 'md5'] as const)('verifies %s and reports a mismatch', async (algorithm) => {
    const file = path.join(tmp(), 'f');
    fs.writeFileSync(file, 'hello');
    const good = crypto.createHash(algorithm).update('hello').digest('hex');
    await expect(verifyChecksum(file, { algorithm, value: good })).resolves.toBeUndefined();
    const bad = good.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    await expect(verifyChecksum(file, { algorithm, value: bad })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });
});

describe('SpeedMeter', () => {
  it('computes speed and ETA over the window', () => {
    const m = new SpeedMeter(5000);
    expect(m.speed()).toBe(0);
    expect(m.eta(0, 1000)).toBeNull();
    m.sample(0, 0);
    m.sample(500, 1000);
    expect(m.speed()).toBe(500);
    expect(m.eta(500, 1500)).toBe(2);
    expect(m.eta(500, null)).toBeNull();
    expect(m.eta(1500, 1500)).toBe(0);
  });
});

describe('TypedEmitter', () => {
  it('delivers in order, supports once/off, and isolates throwing listeners', () => {
    class E extends TypedEmitter<{ ping: (n: number) => void }> {
      fire(n: number) { this.emit('ping', n); }
    }
    const e = new E();
    const seen: string[] = [];
    const errSpy = console.error;
    console.error = () => undefined;
    e.on('ping', () => { throw new Error('boom'); });
    const off = e.on('ping', (n) => seen.push(`a${n}`));
    e.once('ping', (n) => seen.push(`once${n}`));
    e.fire(1);
    off();
    e.fire(2);
    console.error = errSpy;
    expect(seen).toEqual(['a1', 'once1']);
  });
});

describe('QueueStore', () => {
  const item = (dir: string, id: string, seq: number): DownloadItem => ({
    id, url: `http://127.0.0.1/${id}`, destPath: path.join(dir, id), partPath: path.join(dir, `${id}.part`), root: dir,
    status: 'queued', seq, bytesDownloaded: 0, totalBytes: null, attempts: 0, createdAt: 'x', updatedAt: 'x',
  });

  it('round-trips, writes atomically and serialises saves in order', async () => {
    const dir = tmp();
    const store = new QueueStore(dir);
    await expect(store.load()).resolves.toEqual({ items: [], dropped: 0 });
    const a = item(dir, 'a', 0);
    const b = item(dir, 'b', 1);
    await Promise.all([store.save([a]), store.save([a, b])]);
    expect((await store.load()).items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(fs.readdirSync(dir)).toEqual(['downloads.json']);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it('moves a corrupt file aside and drops malformed entries', async () => {
    const dir = tmp();
    const store = new QueueStore(dir);
    fs.writeFileSync(store.file, '{not json');
    const res = await store.load();
    expect(res.items).toEqual([]);
    expect(res.corruptBackup && fs.existsSync(res.corruptBackup)).toBe(true);
    fs.writeFileSync(store.file, JSON.stringify({ version: 1, items: [item(dir, 'ok', 0), { id: 'bad' }, { ...item(dir, 'p', 1), partPath: '/elsewhere' }] }));
    const again = await store.load();
    expect(again.items.map((i) => i.id)).toEqual(['ok']);
    expect(again.dropped).toBe(2);
  });
});
