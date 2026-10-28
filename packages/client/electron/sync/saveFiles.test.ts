import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Game } from '@dune/shared';
import { listGameSaveFiles } from './saveFiles';
import { listSaveFiles } from './saveTarget';

// Everything lives in mkdtemp folders; nothing real is touched.
const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-savefiles-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.chmodSync(d, 0o700); } catch { /* ignore */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function game(savePath: string, id = 1): Game {
  return { id, name: 'G', winPath: savePath, linPath: savePath, lastSync: 'Never', status: 'In Sync', thumbnail: '' } as Game;
}
// A home that is NOT an ancestor of the temp tree, so protected-root checks behave as for a real game folder.
const ctx = (home: string) => ({ home, env: {}, platform: process.platform });
const deps = (home = '/nonexistent-home') => ({ savePathOf: (g: Game) => g.linPath, ctx: ctx(home) });

describe('saves:listFiles (DUN-047 enabler)', () => {
  it('lists a folder recursively with forward-slash paths, size and mtime', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'slot', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.sav'), 'abc');
    fs.writeFileSync(path.join(root, 'slot', 'deep', 'b.sav'), 'hello');
    const res = listGameSaveFiles(game(root), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(false);
    expect(res.files.map((f) => [f.path, f.size])).toEqual([['a.sav', 3], ['slot/deep/b.sav', 5]]);
    expect(typeof res.files[0].mtimeMs).toBe('number');
  });

  it('a file-filter path lists only matching files directly in the folder', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'one.sav'), '1');
    fs.writeFileSync(path.join(root, 'two.SAV'), '2');
    fs.writeFileSync(path.join(root, 'config.ini'), 'x');
    fs.writeFileSync(path.join(root, 'sub', 'three.sav'), '3');
    const res = listGameSaveFiles(game(path.join(root, '*.sav')), deps());
    expect(res).toMatchObject({ ok: true, truncated: false });
    if (res.ok) expect(res.files.map((f) => f.path)).toEqual(['one.sav', 'two.SAV']);
  });

  it('never follows a symlink out of the save folder', () => {
    const root = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.mkdirSync(path.join(outside, 'dir'));
    fs.writeFileSync(path.join(outside, 'dir', 'x.sav'), 'x');
    fs.writeFileSync(path.join(root, 'real.sav'), 'r');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.sav'));
    fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'linkdir'));
    const res = listGameSaveFiles(game(root), deps());
    expect(res.ok && res.files.map((f) => f.path)).toEqual(['real.sav']);
    const filtered = listGameSaveFiles(game(path.join(root, '*.sav')), deps());
    expect(filtered.ok && filtered.files.map((f) => f.path)).toEqual(['real.sav']);
  });

  it('caps the list and sets truncated', () => {
    const root = tmp();
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, `f${String(i).padStart(2, '0')}.sav`), '');
    const res = listGameSaveFiles(game(root), { ...deps(), max: 10 });
    expect(res).toMatchObject({ ok: true, truncated: true });
    if (res.ok) expect(res.files).toHaveLength(10);
    const exact = listGameSaveFiles(game(root), { ...deps(), max: 12 });
    expect(exact).toMatchObject({ ok: true, truncated: false });
  });

  it('unknown id, no save path, a missing folder and a protected root fail with fixed codes', () => {
    expect(listGameSaveFiles(undefined, deps())).toMatchObject({ ok: false, code: 'GAME_NOT_FOUND' });
    expect(listGameSaveFiles(game(''), deps())).toMatchObject({ ok: false, code: 'NO_SAVE_PATH' });
    expect(listGameSaveFiles(game(path.join(tmp(), 'missing')), deps())).toMatchObject({ ok: false, code: 'NO_SAVE_PATH' });
    const home = tmp();
    expect(listGameSaveFiles(game(home), deps(home))).toMatchObject({ ok: false, code: 'PROTECTED_SAVE_PATH' });
  });

  it('never writes: the tree is byte-for-byte unchanged afterwards', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.sav'), 'abc');
    const before = fs.readdirSync(root);
    const st = fs.statSync(path.join(root, 'a.sav'));
    listGameSaveFiles(game(root), deps());
    expect(fs.readdirSync(root)).toEqual(before);
    expect(fs.statSync(path.join(root, 'a.sav')).mtimeMs).toBe(st.mtimeMs);
  });
});

describe('listSaveFiles unreadable folders (DUN-070)', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an unreadable sub-folder instead of silently dropping it', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'locked'));
    fs.writeFileSync(path.join(root, 'locked', 'x.sav'), 'x');
    fs.writeFileSync(path.join(root, 'ok.sav'), 'o');
    fs.chmodSync(path.join(root, 'locked'), 0o000);
    try {
      const unreadable: string[] = [];
      const files = listSaveFiles({ kind: 'dir', dir: root }, { unreadable });
      expect(files.map((f) => f.rel)).toEqual(['ok.sav']);
      expect(unreadable).toEqual(['locked']);
    } finally {
      fs.chmodSync(path.join(root, 'locked'), 0o700);
    }
  });

  it('a vanished folder is not "unreadable"', () => {
    const unreadable: string[] = [];
    expect(listSaveFiles({ kind: 'dir', dir: path.join(tmp(), 'gone') }, { unreadable })).toEqual([]);
    expect(unreadable).toEqual([]);
  });
});
