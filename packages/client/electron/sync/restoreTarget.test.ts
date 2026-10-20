// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isStrictlyInside, resolveRestoreTarget, type RestoreTargetDeps } from './restoreTarget';
import { writeFileAtomic, writeRestoreFiles } from './restoreWrite';

let tmp: string;
let root: string;
let outside: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dun060-restore-test-'));
  root = path.join(tmp, 'root');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every file (not dir) under `dir`, relative, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

describe('resolveRestoreTarget: lexical rejections (shared validateRelativeSavePath)', () => {
  it.each([
    ['../x', /DOT_SEGMENT/],
    ['a/../../x', /DOT_SEGMENT/],
    ['a/..', /DOT_SEGMENT/],
    ['..\\x', /DOT_SEGMENT/],
    ['a\\..\\..\\x', /DOT_SEGMENT/],
    ['/etc/passwd', /ABSOLUTE/],
    ['C:\\x', /ABSOLUTE/],
    ['C:/x', /ABSOLUTE/],
    ['\\\\srv\\x', /ABSOLUTE/],
    ['//srv/x', /ABSOLUTE/],
    ['C:x', /ABSOLUTE/],
    ['', /EMPTY/],
    ['   ', /EMPTY/],
    ['a\0b', /NUL/],
    ['.', /DOT_SEGMENT/],
    ['./', /DOT_SEGMENT/],
    ['./.', /DOT_SEGMENT/],
    // Stricter than the old DUN-060 rules: inner '.' and empty segments.
    ['./a.sav', /DOT_SEGMENT/],
    ['a/./b.sav', /DOT_SEGMENT/],
    ['a//b.sav', /EMPTY/],
    ['a/', /EMPTY/],
  ])('rejects %j on every platform', (input, reason) => {
    for (const platform of ['linux', 'win32'] as const) {
      const r = platform === 'win32'
        ? resolveRestoreTarget('C:\\saves\\root', input, { platform })
        : resolveRestoreTarget(root, input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    }
  });

  it('rejects non-string paths', () => {
    expect(resolveRestoreTarget(root, 42).ok).toBe(false);
    expect(resolveRestoreTarget(root, undefined).ok).toBe(false);
  });

  it('rejects a relative restore root', () => {
    const r = resolveRestoreTarget('relative/root', 'a.sav');
    expect(r).toEqual({ ok: false, reason: 'restore root is not an absolute path' });
  });

  it.each(['... ', '.. ', 'a/...', 'file.sav:stream', 'CON', 'nul.txt', 'a/LPT1', 'slot.sav.', 'slot ', 'a<b.sav'])(
    'rejects Windows-unsafe name %j on linux and win32 alike',
    (input) => {
      expect(resolveRestoreTarget('C:\\saves\\root', input, { platform: 'win32', lstat: missing }).ok).toBe(false);
      expect(resolveRestoreTarget(root, input).ok).toBe(false);
    },
  );
});

/** Fake lstat: nothing exists. */
const missing: NonNullable<RestoreTargetDeps['lstat']> = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

describe('resolveRestoreTarget: accepted paths', () => {
  it('accepts a valid nested path a/b/c.sav and a write there succeeds', async () => {
    const r = resolveRestoreTarget(root, 'a/b/c.sav');
    expect(r).toEqual({ ok: true, target: path.join(root, 'a', 'b', 'c.sav') });

    const res = await writeRestoreFiles(root, [{ path: 'a/b/c.sav' }], {
      download: async () => Buffer.from('save-data'),
    });
    expect(res.rejected).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'a', 'b', 'c.sav'), 'utf8')).toBe('save-data');
    expect(listFiles(root)).toEqual([path.join('a', 'b', 'c.sav')]);
  });

  it('accepts both separators; ./ and duplicate separators are now rejected', () => {
    expect(resolveRestoreTarget(root, 'a\\b.sav')).toEqual({ ok: true, target: path.join(root, 'a', 'b.sav') });
    expect(resolveRestoreTarget(root, './a//b/./c.sav').ok).toBe(false);
  });

  it('accepts non-Latin-1 names (DARK SOULS™ III, CJK)', () => {
    expect(resolveRestoreTarget(root, 'DARK SOULS™ III/セーブ.dat')).toEqual({ ok: true, target: path.join(root, 'DARK SOULS™ III', 'セーブ.dat') });
  });

  it('accepts names that merely contain dots', () => {
    expect(resolveRestoreTarget(root, '..hidden/x..sav').ok).toBe(true);
  });

  it('accepts when the restore root does not exist yet', () => {
    const r = resolveRestoreTarget(path.join(root, 'not-yet'), 'x/y.sav');
    expect(r).toEqual({ ok: true, target: path.join(root, 'not-yet', 'x', 'y.sav') });
  });

  it('accepts a root that is itself a symlink (e.g. a Proton prefix folder)', () => {
    const real = path.join(tmp, 'real-saves');
    fs.mkdirSync(real);
    const linkRoot = path.join(tmp, 'linked-root');
    fs.symlinkSync(real, linkRoot, 'dir');
    expect(resolveRestoreTarget(linkRoot, 'slot1.sav')).toEqual({ ok: true, target: path.join(linkRoot, 'slot1.sav') });
  });

  it('builds win32 targets and compares case-insensitively', () => {
    const r = resolveRestoreTarget('C:\\Users\\Jane\\Saves', 'Slot/1.sav', { platform: 'win32', lstat: missing });
    expect(r).toEqual({ ok: true, target: 'C:\\Users\\Jane\\Saves\\Slot\\1.sav' });
    expect(isStrictlyInside('C:\\Users\\Jane\\Saves', 'c:\\users\\jane\\saves\\x.sav', 'win32')).toBe(true);
    expect(isStrictlyInside('/Saves', '/saves/x.sav', 'linux')).toBe(false);
  });
});

describe('resolveRestoreTarget: containment and symlinks', () => {
  it('rejects a sibling directory with a shared prefix (/root vs /root-evil)', () => {
    expect(isStrictlyInside('/root', '/root-evil/x', 'linux')).toBe(false);
    expect(isStrictlyInside('/root', '/root', 'linux')).toBe(false);
    expect(isStrictlyInside('/root', '/root/x', 'linux')).toBe(true);
    expect(isStrictlyInside('C:\\root', 'C:\\ROOT-evil\\x', 'win32')).toBe(false);

    // Real filesystem: a server path cannot reach root-evil.
    const evil = path.join(tmp, 'root-evil');
    fs.mkdirSync(evil);
    expect(resolveRestoreTarget(root, '../root-evil/x').ok).toBe(false);
    // A symlink inside root to the prefix-sharing sibling is also rejected.
    fs.symlinkSync(evil, path.join(root, 'sub'), 'dir');
    expect(resolveRestoreTarget(root, 'sub/x').ok).toBe(false);
  });

  it('rejects a symlink inside the root that points outside, with nothing written outside', async () => {
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    const r = resolveRestoreTarget(root, 'link/evil.sav');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/symlink/);

    const download = vi.fn(async () => Buffer.from('pwned'));
    const res = await writeRestoreFiles(root, [{ path: 'link/evil.sav' }, { path: 'link/deep/evil.sav' }], { download });
    expect(res.written).toEqual([]);
    expect(res.rejected.map((x) => x.path)).toEqual(['link/evil.sav', 'link/deep/evil.sav']);
    expect(download).not.toHaveBeenCalled();
    expect(listFiles(outside)).toEqual([]);
  });

  it('rejects when the target file itself is a symlink', () => {
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    fs.symlinkSync(victim, path.join(root, 'slot.sav'));
    expect(resolveRestoreTarget(root, 'slot.sav').ok).toBe(false);
  });

  it('rejects when an intermediate component is a regular file or the target is a directory', () => {
    fs.writeFileSync(path.join(root, 'file'), 'x');
    fs.mkdirSync(path.join(root, 'dir'));
    expect(resolveRestoreTarget(root, 'file/x.sav').ok).toBe(false);
    expect(resolveRestoreTarget(root, 'dir').ok).toBe(false);
  });

  it('rejects when realpath of the nearest existing ancestor escapes the root (injected deps)', () => {
    // Simulates a junction/bind mount that lstat does not report as a symlink.
    const deps: RestoreTargetDeps = {
      platform: 'linux',
      lstat: (p) => {
        if (p === '/r' || p === '/r/mnt') return { isSymbolicLink: () => false, isDirectory: () => true };
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      realpath: (p) => (p === '/r' ? '/real/r' : p === '/r/mnt' ? '/elsewhere' : p),
    };
    const r = resolveRestoreTarget('/r', 'mnt/x.sav', deps);
    expect(r).toEqual({ ok: false, reason: 'real path of an existing component escapes the restore root' });
    // Same tree, but realpath stays inside: accepted.
    const ok = resolveRestoreTarget('/r', 'mnt/x.sav', { ...deps, realpath: (p) => (p === '/r' ? '/real/r' : '/real/r/mnt') });
    expect(ok).toEqual({ ok: true, target: '/r/mnt/x.sav' });
  });

  it('rejects when lstat fails with something other than ENOENT', () => {
    const r = resolveRestoreTarget('/r', 'x.sav', {
      platform: 'linux',
      lstat: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
      realpath: (p) => p,
    });
    expect(r.ok).toBe(false);
  });
});

describe('writeRestoreFiles: end to end with a fake server file list', () => {
  it('writes only safe files and nothing outside the root after a malicious list', async () => {
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    const evil = path.join(tmp, 'root-evil');
    const absTarget = path.join(outside, 'abs.txt');
    const files = [
      { path: 'good/slot1.sav', body: 'one' },
      { path: '../escape.txt', body: 'x' },
      { path: 'a/../../escape2.txt', body: 'x' },
      { path: '..\\escape3.txt', body: 'x' },
      { path: absTarget, body: 'x' },
      { path: '/etc/passwd', body: 'x' },
      { path: 'C:\\x', body: 'x' },
      { path: '\\\\srv\\x', body: 'x' },
      { path: 'C:x', body: 'x' },
      { path: '', body: 'x' },
      { path: 'a\0b', body: 'x' },
      { path: '.', body: 'x' },
      { path: 'link/pwn.txt', body: 'x' },
      { path: '../root-evil/x', body: 'x' },
      { path: 'slot2.sav', body: 'two' },
    ];
    const download = vi.fn(async (f: { body: string }) => Buffer.from(f.body));
    const onReject = vi.fn();
    const res = await writeRestoreFiles(root, files, { download, onReject, chunkSize: 5 });

    expect(res.rejected).toHaveLength(13);
    expect(onReject).toHaveBeenCalledTimes(13);
    expect(download).toHaveBeenCalledTimes(2);
    expect(res.written.sort()).toEqual([path.join(root, 'good', 'slot1.sav'), path.join(root, 'slot2.sav')].sort());

    // Nothing outside the root: the tmp dir holds only root/ and outside/
    // (plus the symlink inside root), outside/ is empty, no root-evil.
    expect(fs.readdirSync(tmp).sort()).toEqual(['outside', 'root']);
    expect(fs.existsSync(evil)).toBe(false);
    expect(listFiles(outside)).toEqual([]);
    expect(fs.existsSync('/etc/passwd') && fs.readFileSync('/etc/passwd', 'utf8') === 'x').toBe(false);
    expect(listFiles(root)).toEqual([path.join('good', 'slot1.sav'), 'link', 'slot2.sav'].sort());
    expect(fs.readFileSync(path.join(root, 'slot2.sav'), 'utf8')).toBe('two');
  });

  it('re-validates after download: a symlink planted during the download is rejected', async () => {
    const res = await writeRestoreFiles(root, [{ path: 'late/x.sav' }], {
      download: async () => {
        fs.symlinkSync(outside, path.join(root, 'late'), 'dir');
        return Buffer.from('x');
      },
    });
    expect(res.written).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(listFiles(outside)).toEqual([]);
  });

  it('propagates download errors (restore still aborts as before)', async () => {
    await expect(writeRestoreFiles(root, [{ path: 'x.sav' }], {
      download: async () => { throw new Error('network down'); },
    })).rejects.toThrow('network down');
    expect(listFiles(root)).toEqual([]);
  });
});

describe('writeFileAtomic', () => {
  it('replaces an existing file and leaves no temp files', () => {
    const target = path.join(root, 'slot.sav');
    fs.writeFileSync(target, 'old');
    writeFileAtomic(target, Buffer.from('new'));
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(root)).toEqual(['slot.sav']);
  });

  it('cleans up the temp file when the rename fails', () => {
    const target = path.join(root, 'dir-target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'x'); // rename onto a non-empty dir fails
    expect(() => writeFileAtomic(target, Buffer.from('new'))).toThrow();
    expect(fs.readdirSync(root)).toEqual(['dir-target']);
  });
});
