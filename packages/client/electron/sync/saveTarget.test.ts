import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acceptsRelativePath, listSaveFiles, resolveSaveTarget } from './saveTarget';

// DUN-065: runtime guard for stored save paths. Home is a mkdtemp folder.
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dd-065st-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
const deps = () => ({ ctx: { home, env: {} as NodeJS.ProcessEnv, platform: 'linux' as const } });

describe('resolveSaveTarget / listSaveFiles', () => {
  it('a file filter lists only matching files directly in its folder', () => {
    const d = path.join(home, '.local', 'share', 'Foo');
    fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
    for (const f of ['a.sav', 'b.SAV', 'notes.txt', 'sub/c.sav']) fs.writeFileSync(path.join(d, f), f);
    const r = resolveSaveTarget(path.join(d, '*.sav'), deps());
    expect(r).toEqual({ ok: true, target: { kind: 'glob', dir: d, pattern: '*.sav' } });
    if (!r.ok) return;
    expect(listSaveFiles(r.target).map((f) => f.rel).sort()).toEqual(['a.sav', 'b.SAV']);
    expect(acceptsRelativePath(r.target, 'a.sav')).toBe(true);
    expect(acceptsRelativePath(r.target, 'notes.txt')).toBe(false);
    expect(acceptsRelativePath(r.target, 'sub/c.sav')).toBe(false);
  });

  it('refuses home, Documents and My Games (stored before the fix) and file filters in them', () => {
    const docs = path.join(home, 'Documents', 'My Games');
    fs.mkdirSync(docs, { recursive: true });
    for (const p of [home, path.join(home, 'Documents'), docs, path.join(docs, '*.sav'), path.join(home, '*.cfg')]) {
      expect(resolveSaveTarget(p, deps())).toEqual({ ok: false, reason: 'protected' });
    }
    fs.writeFileSync(path.join(home, 'game.cfg'), 'x');
    expect(resolveSaveTarget(path.join(home, 'game.cfg'), deps())).toEqual({ ok: false, reason: 'protected' });
  });

  it('a dedicated folder is recursive and skips symlinks; a single file takes only its name', () => {
    const d = path.join(home, 'Saves', 'Foo');
    fs.mkdirSync(path.join(d, 'slot'), { recursive: true });
    fs.writeFileSync(path.join(d, 'slot', '1.sav'), '1');
    fs.symlinkSync(home, path.join(d, 'link'));
    const r = resolveSaveTarget(d, deps());
    expect(r.ok && listSaveFiles(r.target).map((f) => f.rel)).toEqual([path.join('slot', '1.sav')]);
    const file = resolveSaveTarget(path.join(d, 'slot', '1.sav'), deps());
    expect(file.ok && file.target).toEqual({ kind: 'file', dir: path.join(d, 'slot'), file: '1.sav' });
    if (file.ok) expect(acceptsRelativePath(file.target, 'other.sav')).toBe(false);
  });

  it('missing paths: sync skips them, restore (allowMissing) accepts; globs in folders are unsupported', () => {
    const d = path.join(home, 'Saves', 'New');
    expect(resolveSaveTarget(d, deps())).toEqual({ ok: false, reason: 'missing' });
    expect(resolveSaveTarget(d, deps(), true)).toEqual({ ok: true, target: { kind: 'dir', dir: d } });
    expect(resolveSaveTarget(path.join(home, '*', 'x.sav'), deps())).toEqual({ ok: false, reason: 'unsupported-glob' });
  });
});
