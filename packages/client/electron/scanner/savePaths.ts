/**
 * Ludusavi manifest loading + save-path resolution.
 *
 * Game.winPath / Game.linPath are SAVE paths (what save sync reads). Scanners
 * must fill them from the Ludusavi manifest only, never with install folders.
 * Everything here is injectable (manifest data, home dir, env, extra roots) so
 * it can be tested against temp folders without touching the real home dir or
 * downloading the real manifest.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import YAML from 'yaml';
import { app } from 'electron';
import { isProtectedSaveRoot } from './protectedRoots';

export const MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
/** Cache TTL for the on-disk manifest copy (it is ~4MB). */
export const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface ManifestFileRule {
  tags?: string[];
  when?: Array<{ os?: string; store?: string }>;
}

export interface ManifestEntry {
  files?: Record<string, ManifestFileRule | null | undefined>;
  steam?: { id?: number | string };
  installDir?: Record<string, unknown>;
}

/** Top-level shape of the Ludusavi manifest: game name -> entry. */
export type LudusaviManifest = Record<string, ManifestEntry | null | undefined>;

export interface LoadManifestOptions {
  /** Where to cache the raw YAML. Defaults to `<userData>/ludusavi-manifest.yaml`. */
  cachePath?: string;
  /** Downloader; defaults to axios GET of MANIFEST_URL. */
  download?: () => Promise<string>;
  ttlMs?: number;
  now?: () => number;
}

function defaultCachePath(): string {
  return path.join(app.getPath('userData'), 'ludusavi-manifest.yaml');
}

async function defaultDownload(): Promise<string> {
  const response = await axios.get(MANIFEST_URL, { timeout: 30000, responseType: 'text' });
  return String(response.data);
}

/** Read the cached manifest if fresh, otherwise download and cache it. */
export async function fetchManifestText(options: LoadManifestOptions = {}): Promise<string> {
  const cachePath = options.cachePath ?? defaultCachePath();
  const ttl = options.ttlMs ?? MANIFEST_TTL_MS;
  const now = options.now ?? Date.now;
  if (fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath);
    if (now() - stat.mtimeMs < ttl) return fs.readFileSync(cachePath, 'utf-8');
  }
  const text = await (options.download ?? defaultDownload)();
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, text, 'utf-8');
  } catch (error) {
    console.warn('Could not cache Ludusavi manifest:', error);
  }
  return text;
}

export function parseManifest(raw: string): LudusaviManifest | null {
  const parsed = YAML.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' ? parsed as LudusaviManifest : null;
}

/** Load + parse the manifest. Returns null (never throws) when unavailable. */
export async function loadManifest(options: LoadManifestOptions = {}): Promise<LudusaviManifest | null> {
  try {
    return parseManifest(await fetchManifestText(options));
  } catch (error) {
    console.error('Failed to load Ludusavi manifest:', error);
    return null;
  }
}

export interface PathContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function defaultContext(partial: Partial<PathContext> = {}): PathContext {
  return {
    home: partial.home ?? os.homedir(),
    env: partial.env ?? process.env,
    platform: partial.platform ?? process.platform,
  };
}

/** Per-game placeholder values (from the store/scanner that found the game). */
export interface GameTokens {
  /** `<base>`: install folder of the game. */
  base?: string;
  /** `<root>`: store library root (e.g. a Steam library folder). */
  root?: string;
  /** `<game>`: install dir name inside the root. */
  game?: string;
  /** `<storeGameId>`: e.g. Steam app id. */
  storeGameId?: string;
}

function userName(ctx: PathContext): string {
  return ctx.env.USERNAME || ctx.env.USER || 'User';
}

function applyTokens(template: string, replacements: Record<string, string | undefined>): string | null {
  let mapped = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (!mapped.includes(token)) continue;
    if (value === undefined || value === '') return null; // can't resolve this template here
    mapped = mapped.split(token).join(value);
  }
  return mapped;
}

function gameReplacements(tokens: GameTokens): Record<string, string | undefined> {
  return {
    '<base>': tokens.base,
    '<root>': tokens.root,
    '<game>': tokens.game,
    '<storeGameId>': tokens.storeGameId,
    '<storeUserId>': '*',
  };
}

/** Translate Ludusavi placeholders against the host's real directories. */
export function translatePath(template: string, ctxIn: Partial<PathContext> = {}, tokens: GameTokens = {}): string | null {
  const ctx = defaultContext(ctxIn);
  const home = ctx.home;
  const mapped = applyTokens(template, {
    ...gameReplacements(tokens),
    '<home>': home,
    '<userProfile>': home,
    '<osUserName>': userName(ctx),
    '<xdgData>': ctx.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
    '<xdgConfig>': ctx.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    '<winAppData>': ctx.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    '<winLocalAppData>': ctx.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    '<winLocalAppDataLow>': path.join(home, 'AppData', 'LocalLow'),
    '<winDocuments>': path.join(home, 'Documents'),
    '<winPublic>': ctx.env.PUBLIC || (ctx.platform === 'win32' ? 'C:\\Users\\Public' : undefined),
    '<winProgramData>': ctx.env.ProgramData || (ctx.platform === 'win32' ? 'C:\\ProgramData' : undefined),
    '<winDir>': ctx.platform === 'win32' ? (ctx.env.WINDIR || 'C:\\Windows') : undefined,
    '<steam>': ctx.platform === 'win32' ? 'C:\\Program Files (x86)\\Steam' : path.join(home, '.steam', 'steam'),
  });
  return mapped === null ? null : path.normalize(mapped);
}

/**
 * Translate a template relative to a Windows user dir (e.g. a Wine/Proton
 * prefix's `drive_c/users/<user>`).
 */
export function translatePathOverride(template: string, root: string, ctxIn: Partial<PathContext> = {}, tokens: GameTokens = {}): string | null {
  const ctx = defaultContext(ctxIn);
  const mapped = applyTokens(template, {
    ...gameReplacements(tokens),
    '<home>': root,
    '<userProfile>': root,
    '<osUserName>': path.basename(root) || userName(ctx),
    '<winAppData>': path.join(root, 'AppData', 'Roaming'),
    '<winLocalAppData>': path.join(root, 'AppData', 'Local'),
    '<winLocalAppDataLow>': path.join(root, 'AppData', 'LocalLow'),
    '<winDocuments>': path.join(root, 'Documents'),
    '<winPublic>': path.join(root, '..', 'Public'),
    '<winProgramData>': path.join(root, '..', '..', 'ProgramData'),
    '<winDir>': path.join(root, '..', '..', 'windows'),
    '<steam>': path.join(root, '..', '..', 'Program Files (x86)', 'Steam'),
    '<xdgData>': undefined,
    '<xdgConfig>': undefined,
  });
  return mapped === null ? null : path.normalize(mapped);
}

/** Windows user dirs inside a Wine/Proton prefix (`<prefix>/drive_c/users/<user>`). */
export function prefixUserDirs(prefix: string, ctxIn: Partial<PathContext> = {}): string[] {
  const ctx = defaultContext(ctxIn);
  const base = path.join(prefix, 'drive_c', 'users');
  const out: string[] = [];
  for (const un of ['steamuser', 'lutrisuser', userName(ctx)]) {
    const dir = path.join(base, un);
    if (!out.includes(dir) && fs.existsSync(dir)) out.push(dir);
  }
  return out;
}

/** Expand user-configured scan roots, auto-detecting Wine prefixes beneath them. */
export function expandCustomRoots(customRoots: string[], ctxIn: Partial<PathContext> = {}): string[] {
  const ctx = defaultContext(ctxIn);
  const expanded: string[] = [];
  for (const root of customRoots) {
    expanded.push(root);
    if (ctx.platform === 'win32') continue;
    try {
      for (const item of fs.readdirSync(root, { withFileTypes: true })) {
        if (item.isDirectory()) expanded.push(...prefixUserDirs(path.join(root, item.name), ctx));
      }
    } catch {
      // Skip inaccessible directories
    }
  }
  return expanded;
}

function globToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function realOrNull(p: string): string | null {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function sameOrInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * Return an existing path for a (possibly wildcarded) absolute path, or ''.
 *
 * DUN-065: a wildcard never expands to its parent folder or above. When the
 * last segment is a glob that matches folders, the first matching folder is
 * returned; when it matches only files (`*.sav`), the result keeps the glob
 * as a file filter (`<folder>/*.sav`), never the bare folder. Every match
 * (after realpath) must stay inside the template's fixed prefix (the part
 * before the first wildcard), so a symlink can't lead outside it.
 */
export function findExisting(candidate: string): string {
  if (!/[*?]/.test(candidate)) return fs.existsSync(candidate) ? candidate : '';
  const parsed = path.parse(candidate);
  const segments = candidate.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const firstGlob = segments.findIndex((seg) => /[*?]/.test(seg));
  const fixedBase = path.join(parsed.root || path.sep, ...segments.slice(0, firstGlob));
  const realBase = realOrNull(fixedBase);
  if (!realBase) return '';
  const insideBase = (p: string) => {
    const real = realOrNull(p);
    return real !== null && sameOrInside(realBase, real);
  };
  let current = [parsed.root || path.sep];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const next: string[] = [];
    for (const dir of current) {
      if (!/[*?]/.test(seg)) {
        const p = path.join(dir, seg);
        if (fs.existsSync(p) && (i < firstGlob || insideBase(p))) next.push(p);
        continue;
      }
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      const re = globToRegExp(seg);
      let fileMatch = false;
      for (const name of entries.sort()) {
        if (!re.test(name)) continue;
        const full = path.join(dir, name);
        if (!insideBase(full)) continue;
        let isDir: boolean;
        try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
        if (isLast) {
          if (isDir) return full;
          fileMatch = true;
          continue;
        }
        if (isDir) next.push(full);
      }
      // Only files matched: keep the glob as a file filter inside this folder.
      if (isLast && fileMatch) return path.join(dir, seg);
    }
    if (next.length === 0) return '';
    current = next;
  }
  return current[0] ?? '';
}

export function normalizeGameName(name: string): string {
  return name.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, '');
}

export interface SaveLookup {
  name: string;
  steamAppId?: string;
  /** Install folder; feeds `<base>`. Never returned as a save path. */
  installPath?: string;
  /** Wine/Proton prefix whose user dirs should be searched. */
  winePrefix?: string;
  /** Extra Windows-user-style roots to search (e.g. Proton `steamuser`). */
  extraRoots?: string[];
  tokens?: GameTokens;
}

export interface SaveResolverOptions extends Partial<PathContext> {
  /** User-configured scan roots (Wine prefix containers etc.). */
  customRoots?: string[];
}

export interface SaveResolver {
  /** Manifest entry for a game, matched by Steam app id first, then by name. */
  findEntry(game: Pick<SaveLookup, 'name' | 'steamAppId'>): { name: string; entry: ManifestEntry } | null;
  /** First existing save path for a game, or '' when none can be resolved. */
  resolve(game: SaveLookup): string;
  /** Resolve and place into the current platform's field. */
  resolveFields(game: SaveLookup): { winPath: string; linPath: string };
  /** Every manifest game with an existing save path (the "autodetect" scan). */
  discoverAll(): Array<{ name: string; path: string }>;
  readonly platform: NodeJS.Platform;
}

function isSaveRule(rule: ManifestFileRule | null | undefined): boolean {
  const tags = rule?.tags;
  return !Array.isArray(tags) || tags.length === 0 || tags.includes('save');
}

function isFileSafe(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function createSaveResolver(manifest: LudusaviManifest, options: SaveResolverOptions = {}): SaveResolver {
  const ctx = defaultContext(options);
  const activeRoots = expandCustomRoots(options.customRoots ?? [], ctx);
  const bySteamId = new Map<string, string>();
  const byName = new Map<string, string>();
  const byNormalizedName = new Map<string, string>();

  for (const [name, entry] of Object.entries(manifest)) {
    if (!entry) continue;
    const steamId = entry.steam?.id;
    if (steamId !== undefined && steamId !== null && !bySteamId.has(String(steamId))) {
      bySteamId.set(String(steamId), name);
    }
    byName.set(name, name);
    const norm = normalizeGameName(name);
    if (norm && !byNormalizedName.has(norm)) byNormalizedName.set(norm, name);
  }

  function findEntry(game: Pick<SaveLookup, 'name' | 'steamAppId'>) {
    const key = (game.steamAppId && bySteamId.get(String(game.steamAppId)))
      || byName.get(game.name)
      || byNormalizedName.get(normalizeGameName(game.name));
    const entry = key ? manifest[key] : undefined;
    return key && entry ? { name: key, entry } : null;
  }

  function resolveEntry(entry: ManifestEntry, lookup: Partial<SaveLookup>): string {
    if (!entry.files) return '';
    const tokens: GameTokens = {
      base: lookup.installPath,
      storeGameId: lookup.steamAppId,
      ...(lookup.installPath ? { game: path.basename(lookup.installPath) } : {}),
      ...lookup.tokens,
    };
    const roots = [
      ...(lookup.extraRoots ?? []),
      ...(lookup.winePrefix ? prefixUserDirs(lookup.winePrefix, ctx) : []),
      ...activeRoots,
    ];
    for (const [template, rule] of Object.entries(entry.files)) {
      if (!isSaveRule(rule)) continue;
      const candidates: string[] = [];
      const direct = translatePath(template, ctx, tokens);
      if (direct) candidates.push(direct);
      for (const root of roots) {
        const override = translatePathOverride(template, root, ctx, tokens);
        if (override) candidates.push(override);
      }
      for (const candidate of candidates) {
        const found = findExisting(candidate);
        if (!found) continue;
        // DUN-065: never a well-known shared folder (home, Documents, AppData,
        // My Games, ...), nor a file filter / file directly inside one.
        const holder = /[*?]/.test(path.basename(found)) || isFileSafe(found) ? path.dirname(found) : found;
        if (isProtectedSaveRoot(holder, ctx)) continue;
        // Never hand back the install folder itself (or an ancestor of it) as a save path.
        if (lookup.installPath && isUnder(lookup.installPath, found)) continue;
        return found;
      }
    }
    return '';
  }

  const resolve = (game: SaveLookup): string => {
    const match = findEntry(game);
    return match ? resolveEntry(match.entry, game) : '';
  };

  return {
    platform: ctx.platform,
    findEntry,
    resolve,
    resolveFields(game) {
      const found = resolve(game);
      return toSaveFields(found, ctx.platform);
    },
    discoverAll() {
      const out: Array<{ name: string; path: string }> = [];
      for (const [name, entry] of Object.entries(manifest)) {
        if (!entry?.files) continue;
        const found = resolveEntry(entry, {});
        if (found) out.push({ name, path: found });
      }
      return out;
    },
  };
}

/** Put a resolved save path into the field save sync reads on this platform. */
export function toSaveFields(savePath: string, platform: NodeJS.Platform = process.platform): { winPath: string; linPath: string } {
  return {
    winPath: platform === 'win32' ? savePath : '',
    linPath: platform !== 'win32' ? savePath : '',
  };
}
