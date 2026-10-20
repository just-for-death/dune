/**
 * DUN-062: registry of the Wine prefixes Dune itself created.
 *
 * The renderer never hands main a filesystem path for a write or delete. It
 * names a new prefix (a validated slug) or refers to an existing one by its
 * registry id; main builds or looks up the path, and every path is checked to
 * sit strictly inside the managed root (realpath'd, separator-aware,
 * case-insensitive on win32) before anything touches the disk.
 *
 * - Managed prefixes live in `<userData>/prefixes/<name>`.
 * - Backups go to `<userData>/prefix-backups/<name>-<timestamp>-<rand>`.
 * - The registry is a JSON file, `<userData>/prefix-registry.json`, written
 *   atomically (temp file + rename).
 * - Delete moves the folder to the OS trash (`shell.trashItem`). It never
 *   rm's anything, and the registry entry is removed only after the trash
 *   call succeeds.
 *
 * Failures are fixed reason codes (`PrefixOpFailureReason`); raw OS messages
 * go to the injected logger only. fs, paths, trashItem, uuid and clock are
 * injectable so tests run against mkdtemp folders with a fake trash.
 */
import * as fs from 'fs';
import * as nodePath from 'path';
import * as os from 'os';
import { randomBytes, randomUUID } from 'crypto';
import type {
  BackupPrefixResult,
  CreatePrefixResult,
  DeletePrefixResult,
  ManagedPrefix,
  PrefixOpFailureReason,
} from '@dune/shared';

/** Longest accepted prefix name. */
export const MAX_PREFIX_NAME_LENGTH = 64;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Names Windows refuses as file names regardless of extension.
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export type PrefixRegistryFs = Pick<
  typeof fs,
  'lstatSync' | 'realpathSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync' | 'cpSync'
>;

export interface PrefixRegistryPaths {
  /** Folder that holds every Dune-managed prefix. */
  managedRoot: string;
  /** Folder that receives prefix backups. Must not overlap the managed root. */
  backupsRoot: string;
  /** JSON file holding the registry entries. */
  registryFile: string;
  /** The user's home folder; never a valid target. */
  homeDir: string;
}

export interface PrefixRegistryDeps {
  fs: PrefixRegistryFs;
  /** Move a path to the OS trash (Electron's `shell.trashItem`). */
  trashItem: (fullPath: string) => Promise<void>;
  randomUUID: () => string;
  now: () => Date;
  platform: NodeJS.Platform;
  log: (message: string) => void;
}

/** Default paths under Electron's userData folder. */
export function defaultPrefixRegistryPaths(userDataDir: string, homeDir: string = os.homedir()): PrefixRegistryPaths {
  return {
    managedRoot: nodePath.join(userDataDir, 'prefixes'),
    backupsRoot: nodePath.join(userDataDir, 'prefix-backups'),
    registryFile: nodePath.join(userDataDir, 'prefix-registry.json'),
    homeDir,
  };
}

/** A safe prefix folder name: one path segment, no separators, no `..`, capped length. */
export function isValidPrefixName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_PREFIX_NAME_LENGTH) return false;
  if (!NAME_RE.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.endsWith('.')) return false;
  if (WIN_RESERVED_RE.test(name)) return false;
  return true;
}

function pathApiFor(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function comparable(p: string, platform: NodeJS.Platform): string {
  const resolved = pathApiFor(platform).resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Same path after resolving (case-insensitive on win32). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

/**
 * True when `child` is strictly below `root` (never equal to it). Uses
 * path.relative, so `/a/bc` is not inside `/a/b`. Case-insensitive on win32.
 */
export function isStrictlyInside(child: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = pathApiFor(platform);
  const rel = api.relative(comparable(root, platform), comparable(child, platform));
  if (rel === '' || api.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${api.sep}`);
}

/** Filesystem roots, the home folder and any ancestor of home are never valid targets. */
function isProtectedPath(p: string, homeDir: string, platform: NodeJS.Platform): boolean {
  const api = pathApiFor(platform);
  const resolved = api.resolve(p);
  if (api.parse(resolved).root === resolved) return true;
  if (samePath(resolved, homeDir, platform)) return true;
  return isStrictlyInside(homeDir, resolved, platform);
}

function errCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEntry(value: unknown): value is ManagedPrefix {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    UUID_RE.test(v.id) &&
    isValidPrefixName(v.name) &&
    typeof v.path === 'string' &&
    typeof v.createdAt === 'string' &&
    (v.gameId === undefined || typeof v.gameId === 'string')
  );
}

type Verified = { ok: true; entry: ManagedPrefix; realPath: string };
type Failure<R extends PrefixOpFailureReason> = { ok: false; reason: R };

function fail<R extends PrefixOpFailureReason>(reason: R): Failure<R> {
  return { ok: false, reason };
}

export class PrefixRegistry {
  private readonly paths: PrefixRegistryPaths;
  private readonly deps: PrefixRegistryDeps;

  constructor(paths: PrefixRegistryPaths, deps: Partial<PrefixRegistryDeps> & Pick<PrefixRegistryDeps, 'trashItem'>) {
    this.deps = {
      fs,
      randomUUID,
      now: () => new Date(),
      platform: process.platform,
      log: (message) => console.error(message),
      ...deps,
    };
    const { platform } = this.deps;
    const api = pathApiFor(platform);
    for (const key of ['managedRoot', 'backupsRoot', 'registryFile', 'homeDir'] as const) {
      if (!api.isAbsolute(paths[key])) throw new Error(`PrefixRegistry: ${key} must be absolute`);
    }
    const { managedRoot, backupsRoot } = paths;
    if (
      samePath(managedRoot, backupsRoot, platform) ||
      isStrictlyInside(managedRoot, backupsRoot, platform) ||
      isStrictlyInside(backupsRoot, managedRoot, platform)
    ) {
      throw new Error('PrefixRegistry: managedRoot and backupsRoot must not overlap');
    }
    if (isProtectedPath(managedRoot, paths.homeDir, platform) || isProtectedPath(backupsRoot, paths.homeDir, platform)) {
      throw new Error('PrefixRegistry: managedRoot/backupsRoot must not be a filesystem root, home, or an ancestor of home');
    }
    this.paths = { ...paths };
  }

  get managedRoot(): string {
    return this.paths.managedRoot;
  }

  get backupsRoot(): string {
    return this.paths.backupsRoot;
  }

  /** Registry entries only (copies). Unreadable or malformed data yields []. */
  list(): ManagedPrefix[] {
    return this.load().map((entry) => ({ ...entry }));
  }

  /** Create `<managedRoot>/<name>` with a `drive_c` skeleton and register it. */
  create(
    name: unknown,
    options: { gameId?: string } = {},
  ): CreatePrefixResult {
    if (!isValidPrefixName(name)) return fail('invalid-name');
    const { fs: f, platform } = this.deps;
    const api = pathApiFor(platform);
    const entries = this.load();
    if (entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) return fail('exists');

    let realRoot: string;
    try {
      f.mkdirSync(this.paths.managedRoot, { recursive: true });
      realRoot = this.realRootOf(this.paths.managedRoot);
    } catch (error) {
      this.deps.log(`[prefix] create: managed root unavailable: ${describe(error)}`);
      return fail('error');
    }

    const target = api.join(realRoot, name);
    if (!isStrictlyInside(target, realRoot, platform) || !samePath(api.dirname(target), realRoot, platform)) {
      return fail('outside-root');
    }
    try {
      f.lstatSync(target);
      return fail('exists');
    } catch (error) {
      if (errCode(error) !== 'ENOENT') {
        this.deps.log(`[prefix] create: lstat failed: ${describe(error)}`);
        return fail('error');
      }
    }
    try {
      // Non-recursive: fails with EEXIST if something appeared meanwhile.
      f.mkdirSync(target);
    } catch (error) {
      if (errCode(error) === 'EEXIST') return fail('exists');
      this.deps.log(`[prefix] create: mkdir failed: ${describe(error)}`);
      return fail('error');
    }
    try {
      const realTarget = f.realpathSync(target);
      if (!samePath(realTarget, target, platform)) return fail('outside-root');
      f.mkdirSync(api.join(realTarget, 'drive_c'));
    } catch (error) {
      this.deps.log(`[prefix] create: init failed for ${target}: ${describe(error)}`);
      return fail('error');
    }

    const entry: ManagedPrefix = {
      id: this.deps.randomUUID(),
      name,
      path: target,
      createdAt: this.deps.now().toISOString(),
      ...(typeof options.gameId === 'string' ? { gameId: options.gameId } : {}),
    };
    try {
      this.save([...entries, entry]);
    } catch (error) {
      this.deps.log(`[prefix] create: registry write failed (folder left at ${target}): ${describe(error)}`);
      return fail('error');
    }
    return { ok: true, prefix: { ...entry } };
  }

  /** Copy a managed prefix into the backups folder (main picks the destination). */
  backup(id: unknown): BackupPrefixResult {
    const verified = this.verify(id);
    if (!verified.ok) return verified;
    const { fs: f, platform } = this.deps;
    const api = pathApiFor(platform);

    let realBackups: string;
    try {
      f.mkdirSync(this.paths.backupsRoot, { recursive: true });
      realBackups = this.realRootOf(this.paths.backupsRoot);
    } catch (error) {
      this.deps.log(`[prefix] backup: backups root unavailable: ${describe(error)}`);
      return fail('error');
    }
    const stamp = this.deps.now().toISOString().replace(/[:.]/g, '-');
    const dest = api.join(realBackups, `${verified.entry.name}-${stamp}-${randomBytes(3).toString('hex')}`);
    if (
      !isStrictlyInside(dest, realBackups, platform) ||
      !samePath(api.dirname(dest), realBackups, platform) ||
      samePath(dest, verified.realPath, platform) ||
      isStrictlyInside(dest, verified.realPath, platform)
    ) {
      return fail('outside-root');
    }
    try {
      f.lstatSync(dest);
      return fail('exists');
    } catch (error) {
      if (errCode(error) !== 'ENOENT') {
        this.deps.log(`[prefix] backup: lstat failed: ${describe(error)}`);
        return fail('error');
      }
    }
    try {
      // Symlinks inside a prefix (dosdevices/z: -> /) are copied as links, never followed.
      f.cpSync(verified.realPath, dest, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
    } catch (error) {
      this.deps.log(`[prefix] backup: copy ${verified.realPath} -> ${dest} failed: ${describe(error)}`);
      return fail('error');
    }
    return { ok: true, backupPath: dest };
  }

  /** Move a managed prefix to the OS trash, then drop its registry entry. */
  async delete(id: unknown): Promise<DeletePrefixResult> {
    const verified = this.verify(id);
    if (!verified.ok) return verified;
    try {
      await this.deps.trashItem(verified.realPath);
    } catch (error) {
      this.deps.log(`[prefix] delete: trashItem(${verified.realPath}) failed: ${describe(error)}`);
      return fail('trash-failed');
    }
    try {
      this.save(this.load().filter((entry) => entry.id !== verified.entry.id));
    } catch (error) {
      // The folder is already in the trash; the stale entry will report not-found next time.
      this.deps.log(`[prefix] delete: registry write failed after trashing ${verified.realPath}: ${describe(error)}`);
    }
    return { ok: true, trashedPath: verified.realPath };
  }

  /**
   * Resolve a registry id to a real, existing, non-symlink directory that is
   * exactly `<realpath(managedRoot)>/<entry.name>`.
   */
  private verify(id: unknown): Verified | Failure<'not-found' | 'not-managed' | 'symlink' | 'outside-root' | 'error'> {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return fail('not-found');
    const entry = this.load().find((candidate) => candidate.id === id);
    if (!entry) return fail('not-found');
    const { fs: f, platform } = this.deps;
    const api = pathApiFor(platform);
    const { homeDir } = this.paths;

    if (!api.isAbsolute(entry.path) || isProtectedPath(entry.path, homeDir, platform)) return fail('outside-root');

    let realRoot: string;
    try {
      realRoot = this.realRootOf(this.paths.managedRoot);
    } catch (error) {
      if (errCode(error) === 'ENOENT') return fail('not-found');
      this.deps.log(`[prefix] managed root unavailable: ${describe(error)}`);
      return fail('error');
    }
    if (!isStrictlyInside(entry.path, realRoot, platform)) return fail('outside-root');
    if (!samePath(entry.path, api.join(realRoot, entry.name), platform)) return fail('not-managed');

    let stat: fs.Stats;
    try {
      stat = f.lstatSync(entry.path);
    } catch (error) {
      if (errCode(error) === 'ENOENT') return fail('not-found');
      this.deps.log(`[prefix] lstat ${entry.path} failed: ${describe(error)}`);
      return fail('error');
    }
    if (stat.isSymbolicLink()) return fail('symlink');
    if (!stat.isDirectory()) return fail('not-managed');

    let realPath: string;
    try {
      realPath = f.realpathSync(entry.path);
    } catch (error) {
      this.deps.log(`[prefix] realpath ${entry.path} failed: ${describe(error)}`);
      return fail('error');
    }
    if (
      !isStrictlyInside(realPath, realRoot, platform) ||
      !samePath(api.dirname(realPath), realRoot, platform) ||
      isProtectedPath(realPath, homeDir, platform)
    ) {
      return fail('outside-root');
    }
    return { ok: true, entry, realPath };
  }

  /** realpath of a root folder, which itself must be a directory and not a protected path. */
  private realRootOf(root: string): string {
    const real = this.deps.fs.realpathSync(root);
    if (isProtectedPath(real, this.paths.homeDir, this.deps.platform)) {
      throw new Error(`refusing protected root ${real}`);
    }
    if (!this.deps.fs.lstatSync(real).isDirectory()) throw new Error(`${real} is not a directory`);
    return real;
  }

  private load(): ManagedPrefix[] {
    let raw: string;
    try {
      raw = this.deps.fs.readFileSync(this.paths.registryFile, 'utf8');
    } catch (error) {
      if (errCode(error) !== 'ENOENT') this.deps.log(`[prefix] registry read failed: ${describe(error)}`);
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const list = typeof parsed === 'object' && parsed !== null ? (parsed as { prefixes?: unknown }).prefixes : undefined;
      if (!Array.isArray(list)) return [];
      return list.filter(isEntry).map((entry) => ({
        id: entry.id,
        name: entry.name,
        path: entry.path,
        createdAt: entry.createdAt,
        ...(entry.gameId !== undefined ? { gameId: entry.gameId } : {}),
      }));
    } catch (error) {
      this.deps.log(`[prefix] registry parse failed: ${describe(error)}`);
      return [];
    }
  }

  private save(entries: ManagedPrefix[]): void {
    const { fs: f } = this.deps;
    const file = this.paths.registryFile;
    f.mkdirSync(nodePath.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
    try {
      f.writeFileSync(tmp, `${JSON.stringify({ version: 1, prefixes: entries }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      f.renameSync(tmp, file);
    } catch (error) {
      try { f.unlinkSync(tmp); } catch { /* temp file never written */ }
      throw error;
    }
  }
}

/**
 * IPC handlers for `prefix:*`. Each takes exactly one renderer argument (a
 * name or an id); any extra arguments, such as a smuggled path, are ignored.
 */
export function createPrefixIpcHandlers(getRegistry: () => PrefixRegistry, log: (message: string) => void = (m) => console.error(m)) {
  return {
    list: async (): Promise<ManagedPrefix[]> => {
      try {
        return getRegistry().list();
      } catch (error) {
        log(`[prefix] list failed: ${describe(error)}`);
        return [];
      }
    },
    create: async (_event: unknown, name: unknown): Promise<CreatePrefixResult> => {
      try {
        return getRegistry().create(name);
      } catch (error) {
        log(`[prefix] create failed: ${describe(error)}`);
        return fail('error');
      }
    },
    backup: async (_event: unknown, id: unknown): Promise<BackupPrefixResult> => {
      try {
        return getRegistry().backup(id);
      } catch (error) {
        log(`[prefix] backup failed: ${describe(error)}`);
        return fail('error');
      }
    },
    delete: async (_event: unknown, id: unknown): Promise<DeletePrefixResult> => {
      try {
        return await getRegistry().delete(id);
      } catch (error) {
        log(`[prefix] delete failed: ${describe(error)}`);
        return fail('error');
      }
    },
  };
}
