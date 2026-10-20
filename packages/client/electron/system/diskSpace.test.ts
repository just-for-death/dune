import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DriveSpace, Game } from '@dune/shared';

// diskSpace.ts pulls in the Steam scanner (which imports electron/axios). Stub both;
// these tests never read real Steam or save data.
vi.mock('electron', () => ({ app: { getPath: () => path.join(os.tmpdir(), 'dune-diskspace-test-unused') } }));
vi.mock('axios', () => ({ default: { get: vi.fn(async () => { throw new Error('network disabled in tests'); }) } }));

import {
  defaultDiskSpaceDeps,
  getDiskSpace,
  lookupDiskSpace,
  validateDiskSpaceInput,
  buildDefaultDiskPaths,
  reasonFromError,
  parseMountInfo,
  findMountEntry,
  linuxMajorMinor,
  MAX_DISK_SPACE_PATHS,
  type DiskSpaceDeps,
} from './diskSpace';

const quietDeps = (over: Partial<DiskSpaceDeps> = {}): DiskSpaceDeps => ({ ...defaultDiskSpaceDeps, log: () => {}, ...over });
const errno = (code: string) => Object.assign(new Error(`${code}: raw os message /secret/path`), { code });
const ok = (r: DriveSpace[]) => r.filter((e): e is Extract<DriveSpace, { status: 'ok' }> => e.status === 'ok');

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-diskspace-')); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('lookupDiskSpace (real fs on mkdtemp)', () => {
  it('returns ok for a temp dir with 0 < free <= total', async () => {
    const res = await lookupDiskSpace([tmp], [], quietDeps());
    expect(res).toHaveLength(1);
    const [e] = ok(res);
    expect(e).toBeDefined();
    expect(e.paths).toEqual([tmp]);
    expect(e.totalBytes).toBeGreaterThan(0);
    expect(e.freeBytes).toBeGreaterThan(0);
    expect(e.freeBytes).toBeLessThanOrEqual(e.totalBytes);
    expect(typeof e.mount).toBe('string');
    expect(e.mount.length).toBeGreaterThan(0);
  });

  it('groups two paths on the same device into one entry, keeping requested forms', async () => {
    const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const res = await lookupDiskSpace([a, b, a], [], quietDeps());
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe('ok');
    expect(res[0].paths).toEqual([a, b]);
  });

  it('resolves a nonexistent child to its nearest existing ancestor', async () => {
    const missing = path.join(tmp, 'does', 'not', 'exist');
    const stat = vi.fn(defaultDiskSpaceDeps.stat);
    const statfs = vi.fn(defaultDiskSpaceDeps.statfs!);
    const res = await lookupDiskSpace([missing], [], quietDeps({ stat, statfs }));
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe('ok');
    expect(res[0].paths).toEqual([missing]);
    expect(statfs).toHaveBeenCalledWith(tmp, { bigint: true });
  });

  it.each([
    ['EACCES', 'permission'], ['EPERM', 'permission'],
    ['ENOENT', 'not-found'], ['ENOTDIR', 'not-found'],
    ['ENOSYS', 'unsupported'], ['EIO', 'error'],
  ] as const)('statfs throwing %s -> unavailable %s, no raw message leaked', async (code, reason) => {
    const log = vi.fn();
    const res = await lookupDiskSpace([tmp], [], quietDeps({ statfs: async () => { throw errno(code); }, log }));
    expect(res).toEqual([{ paths: [tmp], status: 'unavailable', reason }]);
    expect(JSON.stringify(res)).not.toContain('raw os message');
    expect(log).toHaveBeenCalledWith(expect.stringContaining(code));
  });

  it('stat EACCES does not walk up; groups unavailable paths by reason', async () => {
    const denied1 = path.join(tmp, 'x'); const denied2 = path.join(tmp, 'y');
    const stat: DiskSpaceDeps['stat'] = async (p) => {
      if (p === denied1 || p === denied2) throw errno('EACCES');
      return defaultDiskSpaceDeps.stat(p);
    };
    const res = await lookupDiskSpace([denied1, tmp, denied2], ['rel/path'], quietDeps({ stat }));
    expect(ok(res)).toHaveLength(1);
    expect(res).toContainEqual({ paths: [denied1, denied2], status: 'unavailable', reason: 'permission' });
    expect(res).toContainEqual({ paths: ['rel/path'], status: 'unavailable', reason: 'error' });
  });

  it('missing statfs or unsupported platform -> unsupported', async () => {
    expect(await lookupDiskSpace([tmp], [], quietDeps({ statfs: undefined })))
      .toEqual([{ paths: [tmp], status: 'unavailable', reason: 'unsupported' }]);
    expect(await lookupDiskSpace([tmp], [], quietDeps({ platform: 'aix' })))
      .toEqual([{ paths: [tmp], status: 'unavailable', reason: 'unsupported' }]);
  });

  it('never reports 0/0 or unsafe numbers as ok', async () => {
    const zero = await lookupDiskSpace([tmp], [], quietDeps({ statfs: async () => ({ bsize: 4096n, blocks: 0n, bavail: 0n }) }));
    expect(zero).toEqual([{ paths: [tmp], status: 'unavailable', reason: 'unsupported' }]);
    const huge = await lookupDiskSpace([tmp], [], quietDeps({ statfs: async () => ({ bsize: 1n << 40n, blocks: 1n << 40n, bavail: 1n }) }));
    expect(huge[0].status).toBe('unavailable');
  });

  it('uses mountinfo mount point and by-label label on linux (injected)', async () => {
    const dev = 0x803n; // 8:3
    const mountinfo = [
      '22 1 8:2 / / rw - ext4 /dev/sda2 rw',
      '40 22 8:3 / /mnt/my\\040games rw - ext4 /dev/sda3 rw',
    ].join('\n');
    const res = await lookupDiskSpace(['/mnt/my games/lib'], [], quietDeps({
      platform: 'linux',
      stat: async (p) => { if (p === '/mnt/my games/lib') return { dev }; throw errno('ENOENT'); },
      statfs: async () => ({ bsize: 4096n, blocks: 1000n, bavail: 250n }),
      realpath: async (p) => (p === '/dev/disk/by-label/Games\\x20SSD' ? '/dev/sda3' : p),
      readFile: async () => mountinfo,
      readdir: async () => ['Games\\x20SSD'],
    }));
    expect(res).toEqual([{ paths: ['/mnt/my games/lib'], mount: '/mnt/my games', label: 'Games SSD', status: 'ok', freeBytes: 250 * 4096, totalBytes: 1000 * 4096 }]);
  });

  it('falls back to nearest existing ancestor when mountinfo is unreadable, no label', async () => {
    const missing = path.join(tmp, 'nope');
    const res = await lookupDiskSpace([missing], [], quietDeps({ platform: 'linux', readFile: async () => { throw errno('EACCES'); } }));
    expect(ok(res)[0].mount).toBe(tmp);
    expect(ok(res)[0].label).toBeUndefined();
  });
});

describe('input validation (getDiskSpace never throws)', () => {
  const defaults = vi.fn(() => [tmp]);
  it('rejects non-arrays and oversize arrays with []', async () => {
    for (const bad of [null, 'str', 42, { 0: tmp }]) expect(await getDiskSpace(bad, defaults, quietDeps())).toEqual([]);
    const tooMany = Array.from({ length: MAX_DISK_SPACE_PATHS + 1 }, (_, i) => path.join(tmp, String(i)));
    expect(await getDiskSpace(tooMany, defaults, quietDeps())).toEqual([]);
    expect(defaults).not.toHaveBeenCalled();
  });

  it('marks relative/empty paths unavailable and drops non-strings', async () => {
    const res = await getDiskSpace(['relative/dir', '', 7, tmp], defaults, quietDeps());
    expect(ok(res)[0].paths).toEqual([tmp]);
    expect(res).toContainEqual({ paths: ['relative/dir', ''], status: 'unavailable', reason: 'error' });
  });

  it('uses defaults when omitted and survives a throwing defaults builder', async () => {
    expect(ok(await getDiskSpace(undefined, defaults, quietDeps()))[0].paths).toEqual([tmp]);
    expect(await getDiskSpace(undefined, () => { throw new Error('boom'); }, quietDeps())).toEqual([]);
  });

  it('validateDiskSpaceInput accepts exactly the max', () => {
    const max = Array.from({ length: MAX_DISK_SPACE_PATHS }, (_, i) => `/p/${i}`);
    expect(validateDiskSpaceInput(max, 'linux')).toMatchObject({ kind: 'paths', invalid: [] });
    expect(validateDiskSpaceInput(['C:\\Games'], 'win32')).toMatchObject({ kind: 'paths', valid: ['C:\\Games'] });
  });
});

describe('buildDefaultDiskPaths', () => {
  const game = (over: Partial<Game>): Game => ({
    id: 1, name: 'g', winPath: '', linPath: '', lastSync: 'Never', status: 'In Sync', thumbnail: '', createdAt: '', updatedAt: '', ...over,
  });
  const expand = (p: string) => p.replace(/^~/, '/home/test').replace(/%USERPROFILE%/g, 'C:\\Users\\test');

  it('collects library, save and install paths without duplicates (linux)', () => {
    const out = buildDefaultDiskPaths({
      platform: 'linux', expand,
      steamLibraries: ['/home/test/.local/share/Steam', '/mnt/games/SteamLibrary'],
      scanRoots: ['/mnt/games/SteamLibrary/', '~/Games', 'relative'],
      games: [
        game({ linPath: '~/.config/g1', winPath: '%USERPROFILE%\\g1', installPath: '/mnt/games/SteamLibrary/steamapps/common/G1' }),
        game({ id: 2, linPath: '/home/test/.config/g1', installPath: '/home/test/Games' }),
        game({ id: 3, linPath: '' }),
      ],
    });
    expect(out).toEqual([
      '/home/test/.local/share/Steam',
      '/mnt/games/SteamLibrary',
      '/home/test/Games',
      '/home/test/.config/g1',
      '/mnt/games/SteamLibrary/steamapps/common/G1',
    ]);
  });

  it('uses winPath on Windows and dedupes case-insensitively', () => {
    const out = buildDefaultDiskPaths({
      platform: 'win32', expand, steamLibraries: ['C:\\Program Files (x86)\\Steam'], scanRoots: ['c:\\program files (x86)\\steam'],
      games: [game({ linPath: '~/x', winPath: '%USERPROFILE%\\Saved Games\\G', installPath: 'D:\\Games\\G' })],
    });
    expect(out).toEqual(['C:\\Program Files (x86)\\Steam', 'C:\\Users\\test\\Saved Games\\G', 'D:\\Games\\G']);
  });
});

describe('helpers', () => {
  it('reasonFromError maps codes', () => {
    expect(reasonFromError(errno('ENOTDIR'))).toBe('not-found');
    expect(reasonFromError(new Error('x'))).toBe('error');
    expect(reasonFromError(null)).toBe('error');
  });
  it('parses mountinfo and prefers the device-matching longest mount', () => {
    const entries = parseMountInfo('1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 0:50 / /home rw - btrfs /dev/sdb1 rw\ngarbage');
    expect(entries).toHaveLength(2);
    expect(linuxMajorMinor(0x801n)).toBe('8:1');
    expect(findMountEntry(entries, '/home/u', 0x801n)?.mountPoint).toBe('/');
    expect(findMountEntry(entries, '/home/u', 50n)?.mountPoint).toBe('/home');
  });
});
