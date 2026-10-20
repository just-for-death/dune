/** DUN-089 (saves.zip extraction) + DUN-091 (relay uploads never re-push). */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SETUP_DATA_DIR = process.env.DATA_DIR as string;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-archive-test-'));
process.env.API_KEY_SECRET = 'archive-test-secret-0123456789abcdef01';

const trigger = vi.hoisted(() => vi.fn(async (_games: unknown, _ownerId?: string) => undefined));
vi.mock('./remoteSync.js', () => ({ triggerRemoteSync: trigger }));

const { handleUploadFile } = await import('./sync.js');
const { database } = await import('../db/index.js');
const { getGameRoot } = await import('../utils/path.js');
const { closeDbForTests } = await import('../db/sqlite.js');
const TMP = process.env.DATA_DIR as string;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-archive-src-'));
const OWNER = database.createUser(`archive-${Date.now()}`, 'member').id;
const ENV = { ...process.env };

afterAll(() => {
  closeDbForTests();
  process.env.DATA_DIR = SETUP_DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});
beforeEach(async () => {
  await new Promise((r) => setImmediate(r)); // flush pushes scheduled by the previous test
  trigger.mockClear();
  for (const k of ['MAX_ARCHIVE_ENTRIES', 'MAX_ARCHIVE_UNCOMPRESSED_MB', 'MAX_FILES_PER_GAME']) {
    if (ENV[k] === undefined) delete process.env[k]; else process.env[k] = ENV[k];
  }
});

let n = 0;
/** Build a zip from {rel: content | {link: target}} with Info-ZIP (`-y` keeps symlinks as links). */
function makeZip(files: Record<string, string | { link: string }>): Buffer {
  const dir = fs.mkdtempSync(path.join(WORK, 'z-'));
  for (const [rel, v] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (typeof v === 'string') fs.writeFileSync(abs, v); else fs.symlinkSync(v.link, abs);
  }
  const out = path.join(WORK, `a-${++n}.zip`);
  execFileSync('zip', ['-r', '-y', '-q', out, '.'], { cwd: dir });
  return fs.readFileSync(out);
}
const upload = (title: string, rel: string, body: Buffer | string, opts?: { relay?: boolean }) =>
  handleUploadFile(title, rel, Readable.from([Buffer.from(body)]), '1700000000000', OWNER, opts);
const rootOf = (title: string) => getGameRoot(database.ensureGame(OWNER, title).id, OWNER);
const listAll = (dir: string): string[] => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { recursive: true, encoding: 'utf-8' }).sort() : []);

describe('saves.zip extraction (DUN-089)', () => {
  it('extracts a valid archive, snapshots overwritten files, never keeps saves.zip, triggers a push with ownerId', async () => {
    const root = rootOf('Zip OK');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'slot.sav'), 'old');
    const res = await upload('Zip OK', 'saves.zip', makeZip({ 'slot.sav': 'new', 'sub/b.sav': 'b', 'sub/saves.zip': 'plain' }));
    expect(res).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(root, 'slot.sav'), 'utf-8')).toBe('new');
    expect(fs.readFileSync(path.join(root, 'sub/b.sav'), 'utf-8')).toBe('b');
    expect(fs.existsSync(path.join(root, 'saves.zip'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.versions/1700000000000/slot.sav'), 'utf-8')).toBe('old');
    expect(listAll(path.dirname(root)).filter((e) => /\.extract-|\.uploading|\.restoring/.test(e))).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(trigger).toHaveBeenCalledWith([expect.objectContaining({ name: 'Zip OK' })], OWNER);
  });

  it('a nested sub/saves.zip upload is stored as a plain file (only the root name is an archive)', async () => {
    const res = await upload('Zip Nested', 'sub/saves.zip', 'not a zip');
    expect(res.success).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(path.join(rootOf('Zip Nested'), 'sub/saves.zip'), 'utf-8')).toBe('not a zip');
  });

  it.each([
    ['symlink entry', () => makeZip({ 'a.sav': 'x', 'evil': { link: '/etc/passwd' } }), 400, 'ARCHIVE_INVALID'],
    ['corrupt archive', () => Buffer.from('PK\u0003\u0004 garbage, not a zip'), 400, 'ARCHIVE_INVALID'],
    ['.versions entry', () => makeZip({ '.versions/1/a.sav': 'x' }), 400, 'ARCHIVE_INVALID'],
  ])('%s → %i %s, nothing written, no saves.zip left', async (_name, build, status, code) => {
    const title = `Zip Bad ${++n}`;
    const root = rootOf(title);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'keep.sav'), 'keep');
    const res = await upload(title, 'saves.zip', build());
    expect(res.success).toBe(false);
    expect(res.status).toBe(status);
    expect(res.error?.code).toBe(code);
    expect(listAll(root)).toEqual(['keep.sav']);
    expect(listAll(path.dirname(root)).filter((e) => /\.extract-/.test(e))).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('rejects a "../" entry (hand-patched name) with 400 and writes nothing outside', async () => {
    const zip = makeZip({ 'AAxevil.sav': 'x' });
    const patched = Buffer.from(zip.toString('latin1').replaceAll('AAxevil.sav', '../evil.sav'), 'latin1');
    const title = 'Zip Traversal';
    const res = await upload(title, 'saves.zip', patched);
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('ARCHIVE_INVALID');
    expect(fs.existsSync(path.join(path.dirname(rootOf(title)), 'evil.sav'))).toBe(false);
  });

  it('too many entries → 413 ARCHIVE_TOO_LARGE', async () => {
    process.env.MAX_ARCHIVE_ENTRIES = '2';
    const res = await upload('Zip Many', 'saves.zip', makeZip({ 'a.sav': '1', 'b.sav': '2', 'c.sav': '3' }));
    expect(res.status).toBe(413);
    expect(res.error?.code).toBe('ARCHIVE_TOO_LARGE');
    expect(listAll(rootOf('Zip Many'))).toEqual([]);
  });

  it('declared uncompressed size over the cap (zip bomb) → 413', async () => {
    process.env.MAX_ARCHIVE_UNCOMPRESSED_MB = '1';
    const res = await upload('Zip Bomb', 'saves.zip', makeZip({ 'big.sav': '\0'.repeat(2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.error?.code).toBe('ARCHIVE_TOO_LARGE');
    expect(listAll(rootOf('Zip Bomb'))).toEqual([]);
  });

  it('a plain-file overwrite also snapshots the old content', async () => {
    const root = rootOf('Plain Overwrite');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.sav'), 'old');
    expect((await upload('Plain Overwrite', 'a.sav', 'new')).success).toBe(true);
    expect(fs.readFileSync(path.join(root, '.versions/1700000000000/a.sav'), 'utf-8')).toBe('old');
  });
});

describe('relay uploads (DUN-091)', () => {
  it('an upload marked as relay is applied but never re-pushed', async () => {
    const res = await upload('Relay Game', 'saves.zip', makeZip({ 'a.sav': 'x' }), { relay: true });
    expect(res.success).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(trigger).not.toHaveBeenCalled();
  });
});
