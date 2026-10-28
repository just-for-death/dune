import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { DiscoveredPrefix, DiscoveredPrefixSource, OpenDiscoveredPrefixResult } from '@dune/shared';

/**
 * Read-only discovery of Wine/Proton prefixes that already exist on disk
 * (replaces the old `listPrefixes()` summary, which had no caller).
 *
 * - wine:   `~/.wine` and `$WINEPREFIX`
 * - proton: `<steam library>/steamapps/compatdata/<appid>/pfx` in every library
 * - heroic: `winePrefix` in Heroic's GamesConfig/*.json and its default settings
 * - lutris: `game: prefix:` in Lutris game .yml files
 *
 * Every result is a real folder that looks like a prefix (drive_c or
 * system.reg), reported once by its realpath. Nothing here writes, moves or
 * deletes; the only action is opening a discovered folder, and that re-runs
 * discovery and only opens a path from the fresh set.
 */
export interface DiscoverDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Steam library folders (each holds `steamapps/`). */
  steamLibraries: () => string[];
}

export function defaultDiscoverDeps(steamLibraries: () => string[]): DiscoverDeps {
  return { home: os.homedir(), env: process.env, steamLibraries };
}

function realDir(p: string): string | null {
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function looksLikePrefix(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'drive_c')) || fs.existsSync(path.join(dir, 'system.reg'));
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function readDirNames(dir: string, filter: (e: fs.Dirent) => boolean): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(filter).map((e) => e.name);
  } catch {
    return [];
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** Lutris game yml: the `prefix:` inside the top-level `game:` block, plus the top-level `name:`. */
export function parseLutrisYml(text: string): { prefix?: string; name?: string } {
  let inGame = false;
  let prefix: string | undefined;
  let name: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      inGame = /^game:\s*$/.test(raw);
      const top = /^name:\s*(.+)$/.exec(raw);
      if (top) name = unquote(top[1]);
      continue;
    }
    const m = inGame ? /^\s+prefix:\s*(.+)$/.exec(raw) : null;
    if (m) prefix = unquote(m[1]);
  }
  return { ...(prefix ? { prefix } : {}), ...(name ? { name } : {}) };
}

function unquote(v: string): string {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\'') && t.endsWith('\'')) ? t.slice(1, -1) : t;
}

export function discoverPrefixes(deps: DiscoverDeps): DiscoveredPrefix[] {
  const out: DiscoveredPrefix[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, source: DiscoveredPrefixSource, label?: string) => {
    if (!raw) return;
    const real = realDir(expandHome(raw, deps.home));
    if (!real || seen.has(real) || !looksLikePrefix(real)) return;
    seen.add(real);
    out.push({ path: real, source, ...(label ? { label } : {}) });
  };

  // Wine
  add(path.join(deps.home, '.wine'), 'wine', 'Default (~/.wine)');
  if (deps.env.WINEPREFIX) add(deps.env.WINEPREFIX, 'wine', 'WINEPREFIX');

  // Steam / Proton
  for (const lib of deps.steamLibraries()) {
    const steamapps = path.join(lib, 'steamapps');
    const compat = path.join(steamapps, 'compatdata');
    for (const appId of readDirNames(compat, (e) => e.isDirectory() && /^\d+$/.test(e.name))) {
      const manifest = readText(path.join(steamapps, `appmanifest_${appId}.acf`));
      const name = manifest ? /"name"\s+"([^"]+)"/.exec(manifest)?.[1] : undefined;
      add(path.join(compat, appId, 'pfx'), 'proton', name ?? `Steam app ${appId}`);
    }
  }

  // Heroic
  for (const cfg of [
    path.join(deps.home, '.config', 'heroic'),
    path.join(deps.home, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic'),
  ]) {
    const gamesConfig = path.join(cfg, 'GamesConfig');
    for (const file of readDirNames(gamesConfig, (e) => e.isFile() && e.name.endsWith('.json'))) {
      const parsed = safeJson(readText(path.join(gamesConfig, file)));
      for (const [appName, value] of Object.entries(parsed ?? {})) {
        const prefix = value && typeof value === 'object' ? (value as Record<string, unknown>).winePrefix : undefined;
        if (typeof prefix === 'string') add(prefix, 'heroic', appName);
      }
    }
    const global = safeJson(readText(path.join(cfg, 'config.json')));
    const defaults = global?.defaultSettings;
    const defPrefix = defaults && typeof defaults === 'object' ? (defaults as Record<string, unknown>).winePrefix : undefined;
    if (typeof defPrefix === 'string') add(defPrefix, 'heroic', 'Heroic default');
  }

  // Lutris
  for (const gamesDir of [
    path.join(deps.home, '.config', 'lutris', 'games'),
    path.join(deps.home, '.local', 'share', 'lutris', 'games'),
  ]) {
    for (const file of readDirNames(gamesDir, (e) => e.isFile() && /\.ya?ml$/.test(e.name))) {
      const text = readText(path.join(gamesDir, file));
      if (!text) continue;
      const { prefix, name } = parseLutrisYml(text);
      add(prefix, 'lutris', name ?? file.replace(/\.ya?ml$/, ''));
    }
  }

  return out;
}

function safeJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Open a discovered prefix folder in the OS file manager. The renderer's
 * path is only used to pick an entry from a fresh discovery; the entry's own
 * path is what gets opened. Anything else is refused.
 */
export async function openDiscoveredPrefix(
  rawPath: unknown,
  deps: { discover: () => DiscoveredPrefix[]; openPath: (p: string) => Promise<string> },
): Promise<OpenDiscoveredPrefixResult> {
  if (typeof rawPath !== 'string' || rawPath === '') return { ok: false, reason: 'not-discovered' };
  const entry = deps.discover().find((p) => p.path === rawPath);
  if (!entry) return { ok: false, reason: 'not-discovered' };
  try {
    const error = await deps.openPath(entry.path);
    return error ? { ok: false, reason: 'open-failed' } : { ok: true };
  } catch {
    return { ok: false, reason: 'open-failed' };
  }
}
