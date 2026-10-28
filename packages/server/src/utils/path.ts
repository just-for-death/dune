import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { validateGameTitle, validateRelativeSavePath, type PathRuleCode } from '@dune/shared/pathRules';
import { ApiError } from './apiError.js';

/** Package root (<repo>/packages/server), derived from this module's location (src/utils or dist/utils). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The real, on-disk data folder of this package (holds dune.sqlite, .api-secret, .bootstrap-key). */
export function packageDataDir(): string {
  return path.join(PACKAGE_ROOT, 'data');
}

/**
 * Canonical absolute form of `p` for identity/containment comparison:
 * resolves symlinks on the deepest existing ancestor (the target itself may
 * not exist yet), strips `..`/trailing separators, and case-folds on
 * case-insensitive platforms. Read-only: only realpath lookups, never
 * creates, writes, or opens anything.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  let real = abs;
  for (;;) {
    try {
      real = path.join(fs.realpathSync.native(cur), ...rest.reverse());
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

/**
 * Segment-aware relation of `candidate` to `protectedDir` (both should be
 * canonical). Uses path.relative, so `/a/data2` is NOT inside `/a/data`.
 */
export function pathRelation(candidate: string, protectedDir: string): 'equal' | 'inside' | 'contains' | 'unrelated' {
  const isWithin = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  if (path.relative(protectedDir, candidate) === '') return 'equal';
  if (isWithin(candidate, protectedDir)) return 'inside';
  if (isWithin(protectedDir, candidate)) return 'contains';
  return 'unrelated';
}

/**
 * Test-isolation guard (DUN-005, DUN-022). Under Vitest every test must run
 * against a temp DATA_DIR (provided by src/test/setup.ts). Throws if
 * DATA_DIR is unset, or if — after resolving symlinks on both sides — it is
 * the real <package>/data folder, anywhere inside it (e.g. data/saves), or
 * an ancestor of it (e.g. the package root, packages/, or /). No-op outside
 * Vitest. `realDataDir` is injectable so tests can use a sandboxed fake
 * package; it defaults to the real one. Never writes to the filesystem.
 */
export function assertTestDataDirIsolated(
  configured: string | undefined,
  resolved: string,
  realDataDir: string = packageDataDir(),
): void {
  if (!process.env.VITEST) return;
  if (!configured) {
    throw new Error(
      'DUN-005: DATA_DIR is not set under Vitest; tests must use the temp dir from src/test/setup.ts, never the real data folder',
    );
  }
  const relation = pathRelation(canonicalPath(resolved), canonicalPath(realDataDir));
  if (relation === 'equal') {
    throw new Error(`DUN-005: DATA_DIR resolves to the real data folder (${realDataDir}); tests must never touch it`);
  }
  if (relation === 'inside') {
    throw new Error(`DUN-022: DATA_DIR (${resolved}) is inside the real data folder (${realDataDir}); tests must never touch it`);
  }
  if (relation === 'contains') {
    throw new Error(`DUN-022: DATA_DIR (${resolved}) contains the real data folder (${realDataDir}); tests must never touch it`);
  }
}

/**
 * Base directory for all runtime data. Overridable via DATA_DIR env
 * (tests point it at a temp dir; production uses ./data or the
 * mounted volume). Always call lazily — never cache at module load —
 * so env changes and test isolation work.
 */
export function dataDir(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  assertTestDataDirIsolated(process.env.DATA_DIR, dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function savesDir(): string {
  return path.join(dataDir(), 'saves');
}

export function validateServerUrl(rawUrl: string): { valid: boolean; url: string; error?: string } {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, url: '', error: 'Server URL is required' };
  }
  let normalized = rawUrl.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(normalized)) {
    if (!/^https?:\/\//i.test(normalized)) {
      return { valid: false, url: '', error: 'Only HTTP and HTTPS protocols are allowed' };
    }
  } else {
    normalized = 'http://' + normalized;
  }
  normalized = normalized.replace(/\/+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { valid: false, url: '', error: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, url: '', error: 'Only HTTP and HTTPS protocols are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // SSRF Protection: Block cloud metadata endpoints & link-local addresses
  const blockedHostnames = [
    '169.254.169.254',
    'metadata.google.internal',
    '100.100.100.200',
    '169.254.169.253',
    'instance-data',
  ];
  if (blockedHostnames.includes(hostname) || hostname.endsWith('.metadata.google.internal')) {
    return { valid: false, url: '', error: 'Access to cloud metadata endpoints is prohibited' };
  }

  // Block IPv4 link-local (169.254.0.0/16)
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return { valid: false, url: '', error: 'Access to link-local IPv4 addresses is prohibited' };
  }

  // Block IPv6 link-local and unique local
  if (
    hostname.startsWith('fe80:') ||
    hostname.startsWith('fd00:') ||
    hostname.startsWith('[fe80:') ||
    hostname.startsWith('[fd00:')
  ) {
    return { valid: false, url: '', error: 'Access to link-local/unique-local IPv6 addresses is prohibited' };
  }

  // Dangerous non-HTTP ports
  if (parsed.port) {
    const port = parseInt(parsed.port, 10);
    const blockedPorts = [21, 22, 23, 25, 53, 69, 110, 119, 123, 143, 161, 194, 445];
    if (blockedPorts.includes(port)) {
      return { valid: false, url: '', error: `Port ${port} is not allowed` };
    }
  }

  return { valid: true, url: normalized };
}

export function normalizeUrl(url: string): string {
  if (!url) return '';
  const check = validateServerUrl(url);
  if (!check.valid) {
    throw new Error(check.error || 'Invalid server URL');
  }
  return check.url;
}

// ── Game folders and save paths (DUN-086/087/088/093/111/125) ─────────────
//
// Saves live at saves/<ownerId>/<gameId>. The folder is never derived from
// the game title: titles are display names (validateGameTitle) and are only
// used to look a game up in the DB by (owner, name). Client-supplied relative
// paths go through the shared lexical rules (validateRelativeSavePath) and
// then a canonical, symlink-safe containment check. Inputs are rejected,
// never stripped or rewritten.

/** Lexical rule codes from @dune/shared plus server-side containment codes. */
export type PathErrorCode = PathRuleCode | 'OUTSIDE_ROOT' | 'INVALID_VERSION_ID' | 'INVALID_GAME_ID' | 'INVALID_OWNER';

/** A rejected game title / path / id. REST: 400 `{ error, code }`. */
export class PathRuleError extends ApiError {
  declare readonly code: PathErrorCode;
  constructor(code: PathErrorCode, message: string) {
    super(400, code, message);
    this.name = 'PathRuleError';
  }
}

export function isPathRuleError(err: unknown): err is PathRuleError {
  return err instanceof PathRuleError;
}

/** Game-title intake (upload, games.add, rename, lookups): trimmed title or PathRuleError. */
export function requireGameTitle(raw: unknown): string {
  const r = validateGameTitle(raw);
  if (!r.ok) throw new PathRuleError(r.code, r.message);
  return r.value;
}

/** Owner ids are server-minted (`usr_<hex>`); anything else is refused. */
const OWNER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The on-disk folder segment for a game: its numeric id. The ONE place that
 * maps a game to a folder; titles never reach the filesystem.
 */
export function gameFolderName(gameId: number): string {
  if (!Number.isSafeInteger(gameId) || gameId <= 0) {
    throw new PathRuleError('INVALID_GAME_ID', 'Invalid game id');
  }
  return String(gameId);
}

/** saves/<ownerId>. Every game has an owner. */
export function ownerSavesRoot(ownerId: string): string {
  if (typeof ownerId !== 'string' || !OWNER_ID.test(ownerId)) {
    throw new PathRuleError('INVALID_OWNER', 'Invalid owner id');
  }
  return path.join(savesDir(), ownerId);
}

/**
 * Throw unless `target` is strictly inside `base` (never equal), comparing
 * canonical, symlink-resolved paths segment by segment.
 */
export function assertStrictlyInside(target: string, base: string, what = 'Path'): void {
  if (pathRelation(canonicalPath(target), canonicalPath(base)) !== 'inside') {
    throw new PathRuleError('OUTSIDE_ROOT', `${what} resolves outside the allowed save folder`);
  }
}

/**
 * Throw if any existing component from `root` down to `target` (inclusive)
 * is a symlink. Missing components are fine: they will be created as real
 * directories/files.
 */
function assertNoSymlinks(root: string, target: string): void {
  const rel = path.relative(root, target);
  let current = root;
  const parts = rel === '' ? [] : rel.split(path.sep);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      return; // first missing component: nothing below it exists
    }
    if (st.isSymbolicLink()) {
      throw new PathRuleError('OUTSIDE_ROOT', 'Path goes through a symbolic link');
    }
  }
}

/** The game's save root: saves/<ownerId>/<gameId>, strictly inside saves/<ownerId>. */
export function getGameRoot(gameId: number, ownerId: string): string {
  const base = ownerSavesRoot(ownerId);
  const root = path.join(base, gameFolderName(gameId));
  assertStrictlyInside(root, base, 'Game folder');
  return root;
}

export interface ResolvedGameFile {
  /** Game save root (saves/<ownerId>/<gameId>). */
  root: string;
  /** Canonical relative path, '/'-separated (from validateRelativeSavePath). */
  rel: string;
  /** Absolute path built only from the validated pieces. */
  abs: string;
}

/**
 * Validate a client-supplied relative save path for a game and return the
 * pieces every consumer must use instead of the raw input. Throws
 * PathRuleError (-> 400) for any lexical violation, a symlink anywhere from
 * the game root down, or a target that is not strictly inside the game root.
 */
export function resolveGameFile(gameId: number, requestedPath: unknown, ownerId: string): ResolvedGameFile {
  const checked = validateRelativeSavePath(requestedPath);
  if (!checked.ok) throw new PathRuleError(checked.code, checked.message);
  const root = getGameRoot(gameId, ownerId);
  const abs = path.join(root, ...checked.value.split('/'));
  assertNoSymlinks(root, abs);
  assertStrictlyInside(abs, root);
  return { root, rel: checked.value, abs };
}

/** Validated directory inside a game root (e.g. `.versions/<id>`); same rules as files. */
export function resolveGameSubdir(gameId: number, relDir: string, ownerId: string): string {
  return resolveGameFile(gameId, relDir, ownerId).abs;
}

export function getFileCategory(relPath: string): 'Save' | 'Config' | 'Cache' | 'Other' {
  const ext = path.extname(relPath).toLowerCase();
  const fileName = path.basename(relPath).toLowerCase();
  const dirName = path.dirname(relPath).toLowerCase();

  if (dirName.includes('cache') || fileName.includes('cache') || ext === '.tmp' || ext === '.log') {
    return 'Cache';
  }
  if (ext === '.ini' || ext === '.cfg' || ext === '.xml' || ext === '.json' || ext === '.yaml' || ext === '.yml') {
    return 'Config';
  }
  if (ext === '.sav' || ext === '.bin' || ext === '.dat' || fileName.includes('save') || fileName.includes('prof')) {
    return 'Save';
  }
  return 'Other';
}

export function getFileMetadata(root: string, relPath: string): { path: string; name: string; size: number; modified: string; category: 'Save' | 'Config' | 'Cache' | 'Other' } | null {
  try {
    const fullPath = path.join(root, relPath);
    if (!fs.existsSync(fullPath)) return null;
    const stats = fs.statSync(fullPath);
    return {
      path: relPath,
      name: path.basename(relPath),
      size: stats.size,
      modified: stats.mtime.toISOString(),
      category: getFileCategory(relPath)
    };
  } catch {
    return null;
  }
}

export function listFilesInDir(dirPath: string): Array<{ path: string; name: string; size: number; modified: string; category: 'Save' | 'Config' | 'Cache' | 'Other' }> {
  const files: Array<{ path: string; name: string; size: number; modified: string; category: 'Save' | 'Config' | 'Cache' | 'Other' }> = [];
  
  const walk = (dir: string, base: string): void => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Skip inaccessible directories
      return;
    }
    for (const item of items) {
      if (item.name === '.versions') continue;
      if (item.isSymbolicLink()) continue;
      
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath, base);
      } else {
        const rel = path.relative(base, fullPath);
        const meta = getFileMetadata(base, rel);
        if (meta) files.push(meta);
      }
    }
  };
  
  walk(dirPath, dirPath);
  return files;
}
