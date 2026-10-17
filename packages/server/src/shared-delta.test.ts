import { describe, it, expect } from 'vitest';
import { diffFingerprints, diffHashes, changedPaths, type FileManifest, type HashManifest } from '@dune/shared';

describe('diffFingerprints (upload planning)', () => {
  const fp = (size: number, mtimeMs: number) => ({ size, mtimeMs });

  it('classifies added / changed / unchanged / deleted', () => {
    const previous: FileManifest = {
      'keep.sav': fp(10, 1000),
      'edit.sav': fp(10, 1000),
      'gone.sav': fp(5, 500),
    };
    const current: FileManifest = {
      'keep.sav': fp(10, 1000), // identical
      'edit.sav': fp(11, 1000), // size changed
      'new.sav': fp(3, 300), // added
    };

    const delta = diffFingerprints(previous, current);
    expect(delta.unchanged).toEqual(['keep.sav']);
    expect(delta.changed).toEqual(['edit.sav']);
    expect(delta.added).toEqual(['new.sav']);
    expect(delta.deleted).toEqual(['gone.sav']);
    expect(changedPaths(delta).sort()).toEqual(['edit.sav', 'new.sav']);
  });

  it('treats an mtime-only change as changed', () => {
    const delta = diffFingerprints({ 'a.sav': fp(1, 1) }, { 'a.sav': fp(1, 2) });
    expect(delta.changed).toEqual(['a.sav']);
  });

  it('everything added on a first sync (empty previous)', () => {
    const delta = diffFingerprints({}, { 'a': fp(1, 1), 'b': fp(2, 2) });
    expect(delta.added.length).toBe(2);
    expect(delta.deleted).toEqual([]);
  });
});

describe('diffHashes (restore planning)', () => {
  it('compares content hashes, not timestamps', () => {
    const previous: HashManifest = { 'a.sav': 'aaa', 'b.sav': 'bbb' };
    const current: HashManifest = { 'a.sav': 'aaa', 'b.sav': 'ccc', 'c.sav': 'ddd' };

    const delta = diffHashes(previous, current);
    expect(delta.unchanged).toEqual(['a.sav']);
    expect(delta.changed).toEqual(['b.sav']);
    expect(delta.added).toEqual(['c.sav']);
    expect(delta.deleted).toEqual([]);
    expect(changedPaths(delta).sort()).toEqual(['b.sav', 'c.sav']);
  });

  it('reports server-side deletions', () => {
    const delta = diffHashes({ 'gone': 'x' }, {});
    expect(delta.deleted).toEqual(['gone']);
  });
});
