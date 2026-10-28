import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FileManifest } from '@dune/shared';
import { backupProfileFilter, buildLocalManifest, planUpload } from '../utils';

// DUN-067: an exclude rule only stops future syncing; it never deletes.
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dd-067-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function files(...rels: string[]) {
  return rels.map((rel) => {
    const local = path.join(dir, rel);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    if (!fs.existsSync(local)) fs.writeFileSync(local, rel);
    return { local, rel };
  });
}

describe('planUpload with a backup profile', () => {
  it('adding an exclude rule plans no server deletion for the excluded files', () => {
    const disk = files('slot1.sav', 'cache/shader.bin', 'logs/run.log');
    const uploaded: FileManifest = buildLocalManifest(disk); // everything was pushed before
    const state = () => ({ G: { uploaded } });
    const isIncluded = backupProfileFilter({ includeGlobs: ['**/*'], excludeGlobs: ['cache/**', '*.log', 'logs/**'] });
    const r = planUpload('G', disk, state, isIncluded);
    expect(r.deleted).toEqual([]);
    expect(r.plan).toEqual([]);
    expect(Object.keys(r.localManifest)).toEqual(['slot1.sav']);
  });

  it('an include list that matches nothing deletes nothing', () => {
    const disk = files('a.sav', 'b.sav');
    const r = planUpload('G', disk, () => ({ G: { uploaded: buildLocalManifest(disk) } }), backupProfileFilter({ includeGlobs: [], excludeGlobs: [] }));
    expect(r.deleted).toEqual([]);
  });

  it('a file that really vanished from disk (and is still included) is deleted', () => {
    const disk = files('a.sav', 'b.sav', 'c.log');
    const uploaded = buildLocalManifest(disk);
    fs.rmSync(disk[1].local);
    fs.rmSync(disk[2].local);
    const isIncluded = backupProfileFilter({ includeGlobs: ['**/*'], excludeGlobs: ['*.log'] });
    const r = planUpload('G', [disk[0]], () => ({ G: { uploaded } }), isIncluded);
    expect(r.deleted).toEqual(['b.sav']); // c.log vanished too but is excluded: kept on the server
  });

  it('an empty disk list never plans deletions; changed included files upload', () => {
    const disk = files('a.sav');
    expect(planUpload('G', [], () => ({ G: { uploaded: { 'a.sav': { size: 1, mtimeMs: 1 } } } })).deleted).toEqual([]);
    const r = planUpload('G', disk, () => ({ G: { uploaded: { 'a.sav': { size: 999, mtimeMs: 1 } } } }));
    expect(r.plan.map((p) => p.rel)).toEqual(['a.sav']);
  });

  it('backupProfileFilter: no profile includes everything', () => {
    expect(backupProfileFilter(null)('x/y')).toBe(true);
  });

  it('backupProfileFilter: autoExcludeCache adds the server cacheExcludeGlobs (DUN-103)', () => {
    const cache = ['cache/**', '*.log'];
    const on = backupProfileFilter({ includeGlobs: ['**/*'], excludeGlobs: ['tmp/**'], autoExcludeCache: true }, cache);
    expect(on('slot1.sav')).toBe(true);
    expect(on('cache/shader.bin')).toBe(false);
    expect(on('run.log')).toBe(false);
    expect(on('tmp/x')).toBe(false);
    const off = backupProfileFilter({ includeGlobs: ['**/*'], excludeGlobs: ['tmp/**'], autoExcludeCache: false }, cache);
    expect(off('cache/shader.bin')).toBe(true);
    expect(off('run.log')).toBe(true);
    expect(off('tmp/x')).toBe(false);
    expect(backupProfileFilter({ includeGlobs: ['**/*'], excludeGlobs: [], autoExcludeCache: true })('run.log')).toBe(true);
  });
});

describe('backupProfileFilter uses the shared matcher (DUN-136)', () => {
  it('**/ globs match nested paths and autoExcludeCache applies DEFAULT_EXCLUDE_GLOBS', async () => {
    const { DEFAULT_EXCLUDE_GLOBS } = await import('@dune/shared');
    const f = backupProfileFilter({ includeGlobs: ['**/*.sav'], excludeGlobs: [], autoExcludeCache: true }, DEFAULT_EXCLUDE_GLOBS);
    expect(f('a/b/slot1.sav')).toBe(true);
    expect(f('slot1.sav')).toBe(true);
    expect(f('a/cache/slot1.sav')).toBe(false);
    expect(f('a/b/run.log')).toBe(false);
    expect(f('a/b/notes.txt')).toBe(false);
  });
});
