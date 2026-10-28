/**
 * Ludusavi manifest path expansion for getManifestSuggestions / setSavePath (pure Node, no Electron).
 *
 * Manifest paths are DATA with placeholders (`<home>`, `<base>`, `<winAppData>`, ...). They are
 * expanded for native Linux and for the game's Wine/Proton prefix, then kept only when they
 * resolve strictly inside one of the game's roots: the home dir, the game's installPath or its
 * prefix. Rules:
 * - a `..` segment anywhere is rejected (no lexical escapes);
 * - the path must be inside a root lexically AND after realpath (the longest existing ancestor
 *   is realpath'd; a symlink out of the roots, or a dangling symlink, is rejected);
 * - `*` / `?` globs (incl. `<storeUserId>`) are resolved by listing directories that are
 *   themselves inside a root (capped); `**`, `[...]`, `{...}`, backslashes, drive letters and
 *   unknown placeholders are dropped;
 * - `exists` comes from a stat; file contents are never read and nothing is ever written.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Game, ManifestSuggestion } from '@dune/shared';
import type { ManifestGame } from '@dune/providers';
import { normalizeStoreId } from '../scanner/storeIds';

export const MAX_SUGGESTIONS = 100;
/** Matches kept per glob template, and directory entries scanned per glob segment. */
export const MAX_GLOB_MATCHES = 32;
export const MAX_GLOB_DIR_ENTRIES = 2000;
export const MAX_PATH_LENGTH = 4096;

export interface ExpandContext {
  /** Absolute home dir (a root). */
  home: string;
  userName: string;
  xdgDataHome?: string;
  xdgConfigHome?: string;
  /** The game's install folder (a root, and `<base>`). */
  installPath?: string | null;
  /** The game's Wine/Proton prefix (a root). */
  prefix?: string | null;
  steamAppId?: string | null;
  gogId?: string | null;
  /** Game source ('steam', 'gog', ...) for `when.store` constraints and `<storeGameId>`. */
  store?: string;
}

export interface ContextSource {
  home: string;
  userName: string;
  env?: NodeJS.ProcessEnv;
  /** DUN-062: managed prefix id -> path (null when unknown or outside the managed root). */
  resolveManagedPrefix?: (id: string) => string | null;
}

type Rule = NonNullable<ManifestGame['files']>[string];
type Replacements = Record<string, string | undefined>;

const absOrNull = (p: unknown): string | null => (typeof p === 'string' && p !== '' && path.isAbsolute(p) ? path.normalize(p) : null);

/** `<lib>/steamapps/common/<dir>` + a valid Steam app id -> `<lib>/steamapps/compatdata/<id>/pfx`. */
export function protonPrefixFor(installPath: string | null | undefined, steamAppId: string | null | undefined): string | null {
  const install = absOrNull(installPath);
  const id = normalizeStoreId(steamAppId);
  if (!install || !id) return null;
  const common = path.dirname(install);
  const steamapps = path.dirname(common);
  if (path.basename(common) !== 'common' || path.basename(steamapps) !== 'steamapps') return null;
  return path.join(steamapps, 'compatdata', id, 'pfx');
}

/** The game's prefix: managed prefix (DUN-062) first, then winePrefix, then the Proton compatdata prefix. */
export function gamePrefix(game: Pick<Game, 'managedPrefixId' | 'winePrefix' | 'installPath' | 'steamAppId'>, resolveManaged?: (id: string) => string | null): string | null {
  if (game.managedPrefixId) return absOrNull(resolveManaged?.(game.managedPrefixId) ?? null);
  return absOrNull(game.winePrefix) ?? protonPrefixFor(game.installPath, game.steamAppId);
}

export function buildExpandContext(game: Game, src: ContextSource): ExpandContext {
  const env = src.env ?? {};
  return {
    home: src.home,
    userName: src.userName,
    ...(env.XDG_DATA_HOME ? { xdgDataHome: env.XDG_DATA_HOME } : {}),
    ...(env.XDG_CONFIG_HOME ? { xdgConfigHome: env.XDG_CONFIG_HOME } : {}),
    installPath: absOrNull(game.installPath),
    prefix: gamePrefix(game, src.resolveManagedPrefix),
    steamAppId: normalizeStoreId(game.steamAppId),
    gogId: normalizeStoreId(game.gogId),
    ...(game.source ? { store: game.source } : {}),
  };
}

// ── Containment ────────────────────────────────────────────────────────────────

function strictlyInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function insideOrEqual(root: string, p: string): boolean {
  return p === root || strictlyInside(root, p);
}

function realOrNormal(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

export interface Roots { lexical: string[]; real: string[] }

/** The game's roots (home, installPath, prefix), lexical and real. */
export function rootsOf(ctx: Pick<ExpandContext, 'home' | 'installPath' | 'prefix'>): Roots {
  const lexical = [ctx.home, ctx.installPath, ctx.prefix].map(absOrNull).filter((p): p is string => p !== null && p !== path.parse(p).root);
  return { lexical, real: lexical.map(realOrNormal) };
}

function hasDotDot(p: string): boolean {
  return p.split(/[\\/]/).includes('..');
}

/**
 * Realpath of the longest existing ancestor + the missing tail. null for a dangling symlink
 * or an unreadable ancestor (can't prove where it points).
 */
function resolveReal(p: string): string | null {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(cur); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') return null;
    }
    if (st) {
      try { return path.join(fs.realpathSync(cur), ...tail); } catch { return null; }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.join(cur, ...tail);
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

export type ConfineFailure = 'not-absolute' | 'dot-dot' | 'outside-roots' | 'symlink-escape';

/** The path to keep (real where it exists, normalised otherwise) or why it is rejected. */
export function confinePath(candidate: string, roots: Roots, opts: { allowRoot?: boolean } = {}): { ok: true; path: string } | { ok: false; reason: ConfineFailure } {
  if (!path.isAbsolute(candidate)) return { ok: false, reason: 'not-absolute' };
  if (hasDotDot(candidate)) return { ok: false, reason: 'dot-dot' };
  const norm = path.normalize(candidate).replace(/(.)\/+$/, '$1');
  const inside = opts.allowRoot ? insideOrEqual : strictlyInside;
  if (!roots.lexical.some((r) => inside(r, norm)) && !roots.real.some((r) => inside(r, norm))) return { ok: false, reason: 'outside-roots' };
  const real = resolveReal(norm);
  if (real === null || !roots.real.some((r) => inside(r, real))) return { ok: false, reason: 'symlink-escape' };
  return { ok: true, path: real };
}

// ── Placeholders ───────────────────────────────────────────────────────────────

function steamRootOf(install: string): string {
  const common = path.dirname(install);
  const steamapps = path.dirname(common);
  return path.basename(common) === 'common' && path.basename(steamapps) === 'steamapps' ? path.dirname(steamapps) : common;
}

function storeGameId(ctx: ExpandContext): string | undefined {
  const steam = normalizeStoreId(ctx.steamAppId) ?? undefined;
  const gog = normalizeStoreId(ctx.gogId) ?? undefined;
  return ctx.store === 'gog' ? gog ?? steam : steam ?? gog;
}

function gameTokens(ctx: ExpandContext): Replacements {
  const install = absOrNull(ctx.installPath);
  return {
    '<base>': install ?? undefined,
    '<game>': install ? path.basename(install) : undefined,
    '<root>': install ? steamRootOf(install) : undefined,
    '<storeGameId>': storeGameId(ctx),
    '<storeUserId>': '*',
  };
}

function nativeTokens(ctx: ExpandContext): Replacements {
  return {
    ...gameTokens(ctx),
    '<home>': ctx.home,
    '<osUserName>': ctx.userName,
    '<xdgData>': ctx.xdgDataHome || path.join(ctx.home, '.local', 'share'),
    '<xdgConfig>': ctx.xdgConfigHome || path.join(ctx.home, '.config'),
  };
}

/** Wine user dirs that exist in the prefix (`drive_c/users/{steamuser,lutrisuser,<user>}`). */
export function prefixUserDirs(prefix: string, userName: string): string[] {
  const base = path.join(prefix, 'drive_c', 'users');
  const out: string[] = [];
  for (const name of ['steamuser', 'lutrisuser', userName]) {
    const dir = path.join(base, name);
    if (!name || name.includes('/') || out.includes(dir)) continue;
    try { if (fs.statSync(dir).isDirectory()) out.push(dir); } catch { /* absent */ }
  }
  return out;
}

function prefixTokens(ctx: ExpandContext, prefix: string, userDir: string): Replacements {
  const driveC = path.join(prefix, 'drive_c');
  return {
    ...gameTokens(ctx),
    '<home>': userDir,
    '<osUserName>': path.basename(userDir),
    '<winAppData>': path.join(userDir, 'AppData', 'Roaming'),
    '<winLocalAppData>': path.join(userDir, 'AppData', 'Local'),
    '<winLocalAppDataLow>': path.join(userDir, 'AppData', 'LocalLow'),
    '<winDocuments>': path.join(userDir, 'Documents'),
    '<winPublic>': path.join(driveC, 'users', 'Public'),
    '<winProgramData>': path.join(driveC, 'ProgramData'),
    '<winDir>': path.join(driveC, 'windows'),
  };
}

const PLACEHOLDER = /<[A-Za-z]+>/g;
const UNSAFE_GLOB = /\*\*|[[\]{}\\]/;

/** Substitute placeholders; null if one is unknown/unresolvable or the result is not a safe absolute path. */
export function substitute(template: string, tokens: Replacements): string | null {
  let unresolved = false;
  const out = template.replace(PLACEHOLDER, (tok) => {
    const v = Object.prototype.hasOwnProperty.call(tokens, tok) ? tokens[tok] : undefined;
    if (v === undefined || v === '') { unresolved = true; return tok; }
    return v;
  });
  if (unresolved || out.length > MAX_PATH_LENGTH || UNSAFE_GLOB.test(out)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(out) || !out.startsWith('/') || hasDotDot(out)) return null;
  return out;
}

function segmentRegExp(segment: string): RegExp {
  const body = segment.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`);
}

/** Resolve `*` / `?` segments by listing directories inside the roots only. */
export function resolveGlob(p: string, roots: Roots): string[] {
  if (!/[*?]/.test(p)) return [p];
  const parts = p.split('/').filter(Boolean);
  let current = ['/'];
  for (const seg of parts) {
    if (!/[*?]/.test(seg)) { current = current.map((c) => path.join(c, seg)); continue; }
    const re = segmentRegExp(seg);
    const next: string[] = [];
    for (const dir of current) {
      const safe = confinePath(dir, roots, { allowRoot: true });
      if (!safe.ok) continue; // never list a directory outside the roots
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(safe.path, { withFileTypes: true }).slice(0, MAX_GLOB_DIR_ENTRIES); } catch { continue; }
      for (const e of entries) {
        if (re.test(e.name)) next.push(path.join(dir, e.name));
        if (next.length >= MAX_GLOB_MATCHES) break;
      }
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

function ruleApplies(rule: Rule, os: 'linux' | 'windows', store: string | undefined): boolean {
  if (!rule.when || rule.when.length === 0) return true;
  return rule.when.some((w) => (w.os === undefined || w.os === os) && (w.store === undefined || store === undefined || w.store === store));
}

function kindOf(rule: Rule): ManifestSuggestion['kind'] | null {
  const tags = rule.tags ?? [];
  if (tags.length === 0 || tags.includes('save')) return 'save';
  if (tags.includes('config')) return 'config';
  return null;
}

function existsByStat(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

/** Expand a manifest entry's file rules into confined, deduped suggestions (stat only, no writes). */
export function expandManifestFiles(files: ManifestGame['files'], ctx: ExpandContext): ManifestSuggestion[] {
  if (!files) return [];
  const roots = rootsOf(ctx);
  if (roots.lexical.length === 0) return [];
  const prefix = absOrNull(ctx.prefix);
  const tokenSets: { os: 'linux' | 'windows'; tokens: Replacements }[] = [{ os: 'linux', tokens: nativeTokens(ctx) }];
  if (prefix) for (const dir of prefixUserDirs(prefix, ctx.userName)) tokenSets.push({ os: 'windows', tokens: prefixTokens(ctx, prefix, dir) });

  const byPath = new Map<string, ManifestSuggestion>();
  for (const [template, rule] of Object.entries(files)) {
    const kind = kindOf(rule);
    if (!kind) continue;
    for (const { os, tokens } of tokenSets) {
      if (!ruleApplies(rule, os, ctx.store)) continue;
      const expanded = substitute(template, tokens);
      if (!expanded) continue;
      for (const candidate of resolveGlob(expanded, roots)) {
        const c = confinePath(candidate, roots);
        if (!c.ok) continue;
        const prev = byPath.get(c.path);
        if (prev) { if (kind === 'save') prev.kind = 'save'; continue; }
        byPath.set(c.path, { path: c.path, kind, exists: existsByStat(c.path) });
        if (byPath.size >= MAX_SUGGESTIONS * 2) break;
      }
    }
  }
  const rank = (s: ManifestSuggestion) => (s.exists ? 0 : 2) + (s.kind === 'save' ? 0 : 1);
  return [...byPath.values()].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_SUGGESTIONS);
}
