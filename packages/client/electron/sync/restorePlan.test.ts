import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { backupLocalFiles, fingerprintOf, planRestore, restoreBackupDir, sha256File } from './restorePlan';
import { writeRestoreFiles } from './restoreWrite';

// DUN-066: conflict check + backup before overwrite. mkdtemp only, fake downloads.
let tmp: string;
let root: string;
let backups: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dd-066-'));
  root = path.join(tmp, 'saves');
  backups = path.join(tmp, 'restore-backups');
  fs.mkdirSync(root);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');
function local(rel: string, body: string) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

describe('planRestore', () => {
  it('new machine (empty baseline): an existing different local file is a conflict', () => {
    const t = local('slot1.sav', 'local progress');
    const plan = planRestore([{ file: { path: 'slot1.sav', hash: hashOf('server') }, target: t }], {}, {});
    expect(plan.conflicts.map((c) => c.file.path)).toEqual(['slot1.sav']);
    expect(plan.download).toHaveLength(1);
  });

  it('local edited since the last push is a conflict; local unchanged since the push is not', () => {
    const edited = local('a.sav', 'edited');
    const clean = local('b.sav', 'pushed');
    const uploaded = { 'a.sav': { size: 1, mtimeMs: 1 }, 'b.sav': fingerprintOf(clean)! };
    const plan = planRestore([
      { file: { path: 'a.sav', hash: hashOf('server-a') }, target: edited },
      { file: { path: 'b.sav', hash: hashOf('server-b') }, target: clean },
    ], uploaded, {});
    expect(plan.conflicts.map((c) => c.file.path)).toEqual(['a.sav']);
    expect(plan.download.map((d) => d.file.path)).toEqual(['a.sav', 'b.sav']);
  });

  it('identical content and unchanged server copies are not downloaded; missing files are, without conflict', () => {
    const same = local('same.sav', 'x');
    const keep = local('keep.sav', 'local newer');
    const plan = planRestore([
      { file: { path: 'same.sav', hash: sha256File(same) }, target: same },
      { file: { path: 'keep.sav', hash: 'h-old' }, target: keep },
      { file: { path: 'new.sav', hash: 'h-new' }, target: path.join(root, 'new.sav') },
    ], {}, { 'keep.sav': 'h-old' });
    expect(plan.identical.map((x) => x.file.path)).toEqual(['same.sav']);
    expect(plan.download).toEqual([{ file: { path: 'new.sav', hash: 'h-new' }, target: path.join(root, 'new.sav'), conflict: false }]);
  });
});

describe('backupLocalFiles + restore write', () => {
  it('backs up conflicting files, then the restore overwrites them', async () => {
    const t = local('dir/slot1.sav', 'my local progress');
    const plan = planRestore([{ file: { path: 'dir/slot1.sav', hash: hashOf('server') }, target: t }], {}, {});
    const now = new Date('2026-10-20T07:50:00.000Z');
    const dir = backupLocalFiles(backups, 7, plan.conflicts, { now: () => now });
    expect(dir).toBe(restoreBackupDir(backups, 7, now));
    expect(fs.readFileSync(path.join(dir!, 'dir', 'slot1.sav'), 'utf8')).toBe('my local progress');
    await writeRestoreFiles(root, plan.download.map((d) => d.file), { download: async () => Buffer.from('server') });
    expect(fs.readFileSync(t, 'utf8')).toBe('server');
  });

  it('never overwrites an existing backup (exclusive copy) and returns null with no conflicts', () => {
    const t = local('a.sav', 'one');
    const now = () => new Date('2026-10-20T07:51:00.000Z');
    const entries = [{ file: { path: 'a.sav' }, target: t }];
    backupLocalFiles(backups, 1, entries, { now });
    fs.writeFileSync(t, 'two');
    expect(() => backupLocalFiles(backups, 1, entries, { now })).toThrow(/EEXIST/);
    expect(fs.readFileSync(path.join(restoreBackupDir(backups, 1, now()), 'a.sav'), 'utf8')).toBe('one');
    expect(backupLocalFiles(backups, 1, [])).toBeNull();
  });

  it('a failing copy throws, so the caller writes nothing (fail closed)', () => {
    const t = local('a.sav', 'one');
    expect(() => backupLocalFiles(backups, 1, [{ file: { path: 'a.sav' }, target: t }], { copyFileExclusive: () => { throw new Error('ENOSPC'); } })).toThrow('ENOSPC');
    expect(fs.readFileSync(t, 'utf8')).toBe('one');
  });
});
