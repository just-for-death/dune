import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverPrefixes, openDiscoveredPrefix, parseLutrisYml, type DiscoverDeps } from './manager';

// A fake home in a mkdtemp folder; no real ~/.wine, Steam, Heroic or Lutris data is read.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dune-discover-'))); dirs.push(d); return d; }
function prefix(dir: string): string { fs.mkdirSync(path.join(dir, 'drive_c'), { recursive: true }); return dir; }
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); out.push(f); if (e.isDirectory() && !e.isSymbolicLink()) walk(f); } };
  walk(root);
  return out.sort();
}

function fixture() {
  const home = tmp();
  const lib = tmp();
  const wine = prefix(path.join(home, '.wine'));
  const envPrefix = prefix(path.join(home, 'prefixes', 'env'));
  const steamPfx = prefix(path.join(lib, 'steamapps', 'compatdata', '620', 'pfx'));
  fs.mkdirSync(path.join(lib, 'steamapps', 'compatdata', '999', 'pfx'), { recursive: true }); // not a prefix (no drive_c)
  fs.writeFileSync(path.join(lib, 'steamapps', 'appmanifest_620.acf'), '"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n}\n');
  const heroicPfx = prefix(path.join(home, 'Games', 'Heroic', 'Prefixes', 'hades'));
  fs.mkdirSync(path.join(home, '.config', 'heroic', 'GamesConfig'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'heroic', 'GamesConfig', 'Min.json'), JSON.stringify({ Min: { winePrefix: '~/Games/Heroic/Prefixes/hades', wineVersion: {} } }));
  const lutrisPfx = prefix(path.join(home, 'Games', 'witcher'));
  fs.mkdirSync(path.join(home, '.config', 'lutris', 'games'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'lutris', 'games', 'the-witcher-1234.yml'), `game:\n  exe: /x/witcher.exe\n  prefix: ${lutrisPfx}\nname: The Witcher\nwine:\n  version: lutris-7\n`);
  const deps: DiscoverDeps = { home, env: { WINEPREFIX: envPrefix }, steamLibraries: () => [lib] };
  return { home, lib, deps, wine, envPrefix, steamPfx, heroicPfx, lutrisPfx };
}

describe('discoverPrefixes (read-only)', () => {
  it('finds Wine, WINEPREFIX, Proton compatdata, Heroic and Lutris prefixes with labels', () => {
    const f = fixture();
    expect(discoverPrefixes(f.deps)).toEqual([
      { path: f.wine, source: 'wine', label: 'Default (~/.wine)' },
      { path: f.envPrefix, source: 'wine', label: 'WINEPREFIX' },
      { path: f.steamPfx, source: 'proton', label: 'Portal 2' },
      { path: f.heroicPfx, source: 'heroic', label: 'Min' },
      { path: f.lutrisPfx, source: 'lutris', label: 'The Witcher' },
    ]);
  });

  it('dedupes by realpath and skips folders that are not prefixes or do not exist', () => {
    const f = fixture();
    const deps = { ...f.deps, env: { WINEPREFIX: path.join(f.home, '.wine', '.') } };
    const found = discoverPrefixes(deps);
    expect(found.filter((p) => p.path === f.wine)).toHaveLength(1);
    expect(found.some((p) => p.path.includes('999'))).toBe(false);
    expect(discoverPrefixes({ home: path.join(f.home, 'nope'), env: {}, steamLibraries: () => [] })).toEqual([]);
  });

  it('never writes anything', () => {
    const f = fixture();
    const before = [...snapshot(f.home), ...snapshot(f.lib)];
    discoverPrefixes(f.deps);
    expect([...snapshot(f.home), ...snapshot(f.lib)]).toEqual(before);
  });

  it('parses the Lutris game prefix only from the game: block', () => {
    expect(parseLutrisYml('game:\n  prefix: "/a b"\nname: X\nsystem:\n  prefix: /nope\n')).toEqual({ prefix: '/a b', name: 'X' });
    expect(parseLutrisYml('system:\n  prefix: /nope\n')).toEqual({});
  });
});

describe('openDiscoveredPrefix', () => {
  it('opens only a path from a fresh discovery, using the discovered path', async () => {
    const f = fixture();
    const openPath = vi.fn(async () => '');
    const discover = () => discoverPrefixes(f.deps);
    expect(await openDiscoveredPrefix(f.steamPfx, { discover, openPath })).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(f.steamPfx);
    for (const bad of [f.home, '/', path.join(f.steamPfx, '..'), `${f.steamPfx}/`, path.join(f.steamPfx, 'drive_c'), '', 42, null]) {
      expect(await openDiscoveredPrefix(bad, { discover, openPath })).toEqual({ ok: false, reason: 'not-discovered' });
    }
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it('a prefix that disappeared since the list was shown is refused', async () => {
    const f = fixture();
    const openPath = vi.fn(async () => '');
    fs.rmSync(path.join(f.lutrisPfx, 'drive_c'), { recursive: true });
    expect(await openDiscoveredPrefix(f.lutrisPfx, { discover: () => discoverPrefixes(f.deps), openPath })).toEqual({ ok: false, reason: 'not-discovered' });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('reports open-failed when the OS cannot open it', async () => {
    const f = fixture();
    const res = await openDiscoveredPrefix(f.wine, { discover: () => discoverPrefixes(f.deps), openPath: async () => 'No application' });
    expect(res).toEqual({ ok: false, reason: 'open-failed' });
  });
});
