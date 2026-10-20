import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Never touch the real userData dir or the network.
vi.mock('electron', () => ({ app: { getPath: () => path.join(os.tmpdir(), 'dune-savepaths-userdata-unused') } }));
vi.mock('axios', () => ({ default: { get: vi.fn(async () => { throw new Error('network disabled in tests'); }) } }));

import {
  createSaveResolver,
  fetchManifestText,
  findExisting,
  loadManifest,
  parseManifest,
  toSaveFields,
  translatePath,
  translatePathOverride,
  type LudusaviManifest,
} from './savePaths.js';

describe('savePaths', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-savepaths-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const ctx = () => ({ home, env: { USER: 'jane' } as NodeJS.ProcessEnv, platform: 'linux' as const });

  it('translates Ludusavi placeholders against injected roots', () => {
    expect(translatePath('<home>/.local/share/Foo', ctx())).toBe(path.join(home, '.local/share/Foo'));
    expect(translatePath('<xdgConfig>/Foo', ctx())).toBe(path.join(home, '.config/Foo'));
    expect(translatePath('<base>/saves', ctx(), { base: '/games/Foo' })).toBe('/games/Foo/saves');
    // Unresolvable placeholders yield null rather than a bogus path.
    expect(translatePath('<base>/saves', ctx())).toBeNull();
    const user = path.join(home, 'pfx', 'drive_c', 'users', 'steamuser');
    expect(translatePathOverride('<winAppData>/Foo', user, ctx())).toBe(path.join(user, 'AppData/Roaming/Foo'));
  });

  it('expands folder wildcards and keeps a file glob as a filter (DUN-065)', () => {
    const dir = path.join(home, 'saves', '12345');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.sav'), '');
    expect(findExisting(path.join(home, 'saves', '*'))).toBe(dir);
    // Never the bare parent folder: the glob stays as a file filter.
    expect(findExisting(path.join(home, 'saves', '*', '*.sav'))).toBe(path.join(dir, '*.sav'));
    expect(findExisting(path.join(home, 'nope', '*'))).toBe('');
  });

  it('matches by Steam app id first, then by (normalized) name', () => {
    const manifest: LudusaviManifest = {
      'Hollow Knight': { steam: { id: 367520 }, files: { '<home>/.config/unity3d/Team Cherry/Hollow Knight': { tags: ['save'] } } },
      'Celeste™': { files: { '<home>/.local/share/Celeste/Saves': {} } },
    };
    const r = createSaveResolver(manifest, ctx());
    expect(r.findEntry({ name: 'Renamed In Store', steamAppId: '367520' })?.name).toBe('Hollow Knight');
    expect(r.findEntry({ name: 'celeste' })?.name).toBe('Celeste™');
    expect(r.findEntry({ name: 'Unknown' })).toBeNull();
  });

  it('resolves only existing save paths, skips config-only rules and never returns the install folder', () => {
    const install = path.join(home, 'Games', 'Foo');
    fs.mkdirSync(path.join(install, 'saves'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'Foo'), { recursive: true });
    const manifest: LudusaviManifest = {
      Foo: {
        files: {
          '<home>/.config/Foo': { tags: ['config'] },
          '<base>': { tags: ['save'] },
          '<base>/saves': { tags: ['save'] },
        },
      },
      Bar: { files: { '<home>/.local/share/Bar': { tags: ['save'] } } },
    };
    const r = createSaveResolver(manifest, ctx());
    expect(r.resolve({ name: 'Foo', installPath: install })).toBe(path.join(install, 'saves'));
    expect(r.resolve({ name: 'Bar' })).toBe('');
    expect(r.resolveFields({ name: 'Foo', installPath: install })).toEqual({ winPath: '', linPath: path.join(install, 'saves') });
  });

  it('searches Wine/Proton prefixes', () => {
    const prefix = path.join(home, 'prefixes', 'foo');
    const saves = path.join(prefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming', 'Foo');
    fs.mkdirSync(saves, { recursive: true });
    const r = createSaveResolver({ Foo: { files: { '<winAppData>/Foo': {} } } }, ctx());
    expect(r.resolve({ name: 'Foo', winePrefix: prefix })).toBe(saves);
    expect(r.resolve({ name: 'Foo' })).toBe('');
    // customRoots: prefixes under a user scan root are auto-detected
    const r2 = createSaveResolver({ Foo: { files: { '<winAppData>/Foo': {} } } }, { ...ctx(), customRoots: [path.join(home, 'prefixes')] });
    expect(r2.resolve({ name: 'Foo' })).toBe(saves);
    expect(r2.discoverAll()).toEqual([{ name: 'Foo', path: saves }]);
  });

  it('places save paths in the platform field', () => {
    expect(toSaveFields('/x', 'linux')).toEqual({ winPath: '', linPath: '/x' });
    expect(toSaveFields('C:\\x', 'win32')).toEqual({ winPath: 'C:\\x', linPath: '' });
  });

  it('uses a fresh cache, re-downloads a stale one, and returns null when offline', async () => {
    const cachePath = path.join(home, 'cache', 'manifest.yaml');
    const download = vi.fn(async () => 'Foo:\n  files:\n    "<home>/foo": {}\n');
    expect(parseManifest(await fetchManifestText({ cachePath, download }))).toHaveProperty('Foo');
    expect(download).toHaveBeenCalledTimes(1);
    await fetchManifestText({ cachePath, download });
    expect(download).toHaveBeenCalledTimes(1); // served from cache
    await fetchManifestText({ cachePath, download, now: () => Date.now() + 2 * 24 * 3600 * 1000 });
    expect(download).toHaveBeenCalledTimes(2); // stale -> refreshed

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadManifest({ cachePath: path.join(home, 'missing.yaml') })).toBeNull(); // axios mocked to fail
    errSpy.mockRestore();
  });
});

describe('DUN-065: wildcards never resolve to a parent or shared root', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dd-065-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const ctx = () => ({ home, env: { USER: 'jane' } as NodeJS.ProcessEnv, platform: 'linux' as const });

  it('My Games/*.sav does not make Documents/My Games the save path', () => {
    const myGames = path.join(home, 'Documents', 'My Games');
    fs.mkdirSync(myGames, { recursive: true });
    fs.writeFileSync(path.join(myGames, 'slot.sav'), 'x');
    const r = createSaveResolver({ Foo: { files: { '<winDocuments>/My Games/*.sav': {} } } }, ctx());
    expect(r.resolve({ name: 'Foo' })).toBe('');
    expect(r.discoverAll()).toEqual([]);
  });

  it('<home>/*.cfg is refused, but a dedicated folder file filter is kept', () => {
    fs.writeFileSync(path.join(home, 'game.cfg'), 'x');
    const own = path.join(home, '.local', 'share', 'Foo');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'slot1.sav'), 'x');
    const r = createSaveResolver({
      Bad: { files: { '<home>/*.cfg': {} } },
      Good: { files: { '<xdgData>/Foo/*.sav': {} } },
    }, ctx());
    expect(r.resolve({ name: 'Bad' })).toBe('');
    expect(r.resolve({ name: 'Good' })).toBe(path.join(own, '*.sav'));
  });

  it('refuses a folder wildcard that lands on a shared root (Documents/*)', () => {
    fs.mkdirSync(path.join(home, 'Documents', 'My Games'), { recursive: true });
    const r = createSaveResolver({ Foo: { files: { '<home>/*': {} } } }, ctx());
    expect(r.resolve({ name: 'Foo' })).toBe('');
  });

  it('a wildcard match that is a symlink out of the fixed prefix is skipped', () => {
    const outside = path.join(home, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.sav'), 'x');
    const saves = path.join(home, 'Saves');
    fs.mkdirSync(saves);
    fs.symlinkSync(outside, path.join(saves, 'evil'), 'dir');
    expect(findExisting(path.join(saves, '*', '*.sav'))).toBe('');
    fs.mkdirSync(path.join(saves, 'real'));
    fs.writeFileSync(path.join(saves, 'real', 'y.sav'), 'y');
    expect(findExisting(path.join(saves, '*', '*.sav'))).toBe(path.join(saves, 'real', '*.sav'));
  });
});
