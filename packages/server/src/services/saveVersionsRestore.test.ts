/** DUN-090: restore keeps an undo point, mirrors deletions, locks, and updates lastSync. */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SETUP_DATA_DIR = process.env.DATA_DIR as string;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-restore-test-'));
process.env.API_KEY_SECRET = 'restore-test-secret-0123456789abcdef0123';

const { database } = await import('../db/index.js');
const { withDbLock } = await import('../db/mutex.js');
const { createVersionFromDirectory, restoreVersion, listSaveVersions } = await import('./saveVersions.js');
const { getGameRoot } = await import('../utils/path.js');
const { closeDbForTests } = await import('../db/sqlite.js');
const TMP = process.env.DATA_DIR as string;
const OWNER = database.createUser(`restore-${Date.now()}`, 'member').id;

afterAll(() => {
  closeDbForTests();
  process.env.DATA_DIR = SETUP_DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
function setup() {
  const game = database.upsertGame({ name: `Restore ${++n}`, status: 'Pending Upload', lastSync: 'Never', ownerId: OWNER });
  const root = getGameRoot(game.id, OWNER);
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
  const has = (rel: string) => fs.existsSync(path.join(root, rel));
  return { game, root, write, read, has };
}

describe('restoreVersion (DUN-090)', () => {
  it('creates a pre-restore version, mirrors deletions of tracked files, keeps untracked files, marks synced', async () => {
    const g = setup();
    g.write('slot1.sav', 'v1-slot1');
    const v1 = createVersionFromDirectory({ gameId: g.game.id, ownerId: OWNER });
    g.write('slot1.sav', 'v2-slot1');
    g.write('slot2.sav', 'v2-slot2');            // created after v1 → must be removed
    g.write('cache/shader.cache', 'cache');      // untracked by the profile → kept

    const res = await restoreVersion(g.game.id, v1.id, OWNER);
    expect(res).toMatchObject({ success: true, restoredFiles: 1, removedFiles: 1 });
    expect(g.read('slot1.sav')).toBe('v1-slot1');
    expect(g.has('slot2.sav')).toBe(false);
    expect(g.read('cache/shader.cache')).toBe('cache');
    expect(fs.readdirSync(g.root).filter((f) => f.endsWith('.restoring'))).toEqual([]);

    // The pre-restore version holds the state that was overwritten: undo works.
    const pre = listSaveVersions(g.game.id).find((v) => v.id === res.preRestoreVersionId)!;
    expect(pre.changeSummary).toContain(v1.id);
    expect(fs.readFileSync(path.join(g.root, '.versions', pre.id, 'slot2.sav'), 'utf-8')).toBe('v2-slot2');
    const undo = await restoreVersion(g.game.id, pre.id, OWNER);
    expect(undo.success).toBe(true);
    expect(g.read('slot1.sav')).toBe('v2-slot1');
    expect(g.read('slot2.sav')).toBe('v2-slot2');

    const after = database.getGames().find((x) => x.id === g.game.id)!;
    expect(after.status).toBe('In Sync');
    expect(after.lastSync).not.toBe('Never');
  });

  it('an incomplete snapshot changes nothing and creates no pre-restore version', async () => {
    const g = setup();
    g.write('a.sav', 'old');
    const v = createVersionFromDirectory({ gameId: g.game.id, ownerId: OWNER });
    fs.rmSync(path.join(g.root, '.versions', v.id, 'a.sav'));
    g.write('a.sav', 'current');
    const before = listSaveVersions(g.game.id).length;
    const res = await restoreVersion(g.game.id, v.id, OWNER);
    expect(res.success).toBe(false);
    expect(res.message).toBe('Version snapshot files not found');
    expect(g.read('a.sav')).toBe('current');
    expect(listSaveVersions(g.game.id).length).toBe(before);
  });

  it('runs under the DB lock (waits for a holder; never interleaves)', async () => {
    const g = setup();
    g.write('a.sav', 'old');
    const v = createVersionFromDirectory({ gameId: g.game.id, ownerId: OWNER });
    g.write('a.sav', 'new');
    const order: string[] = [];
    let release!: () => void;
    const held = withDbLock(() => new Promise<void>((r) => { release = r; order.push('holder'); }));
    await Promise.resolve();
    const p = restoreVersion(g.game.id, v.id, OWNER).then((r) => { order.push('restore'); return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(g.read('a.sav')).toBe('new'); // still blocked
    order.push('release');
    release();
    await held;
    expect((await p).success).toBe(true);
    expect(order).toEqual(['holder', 'release', 'restore']);
    expect(g.read('a.sav')).toBe('old');
  });

  it('rejects malformed ids and versions of another game', async () => {
    const a = setup();
    const b = setup();
    a.write('x.sav', '1');
    const v = createVersionFromDirectory({ gameId: a.game.id, ownerId: OWNER });
    await expect(restoreVersion(a.game.id, '../x', OWNER)).rejects.toMatchObject({ code: 'INVALID_VERSION_ID' });
    expect((await restoreVersion(b.game.id, v.id, OWNER)).message).toBe('Version not found');
  });
});
