import * as nodePath from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { isProtectedSaveRoot, type ProtectedRootContext } from '../scanner/protectedRoots';

// DUN-065: a stored save path is one of
//   - a folder (synced recursively),
//   - a single file, or
//   - `<folder>/<glob>` where only the last segment has wildcards: a file
//     filter. Only files directly in <folder> that match the glob are synced
//     or restored; the folder itself is never "the save".
// A folder, or the folder holding a file / file filter, that is a well-known
// shared root (home, Documents, AppData, ...) is refused outright.

export type SaveTarget =
  | { kind: 'dir'; dir: string }
  | { kind: 'file'; dir: string; file: string }
  | { kind: 'glob'; dir: string; pattern: string };

export type SaveTargetResult = { ok: true; target: SaveTarget } | { ok: false; reason: 'missing' | 'protected' | 'unsupported-glob' };

export interface SaveTargetDeps {
  ctx?: ProtectedRootContext;
  stat?: (p: string) => { isDirectory(): boolean } | null;
}

const GLOB = /[*?]/;

export function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]');
  return new RegExp(`^${escaped}$`, 'i');
}

function defaultCtx(): ProtectedRootContext {
  return { home: os.homedir(), env: process.env, platform: process.platform };
}

function defaultStat(p: string) {
  try { return fs.statSync(p); } catch { return null; }
}

/**
 * Classify an expanded save path. `allowMissing` (restore) accepts a folder
 * or file filter whose folder does not exist yet.
 */
export function resolveSaveTarget(expanded: string, deps: SaveTargetDeps = {}, allowMissing = false): SaveTargetResult {
  const ctx = deps.ctx ?? defaultCtx();
  const stat = deps.stat ?? defaultStat;
  if (!expanded) return { ok: false, reason: 'missing' };
  const p = ctx.platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const dirName = p.dirname(expanded);
  const base = p.basename(expanded);
  if (GLOB.test(dirName)) return { ok: false, reason: 'unsupported-glob' };
  if (GLOB.test(base)) {
    if (isProtectedSaveRoot(dirName, ctx)) return { ok: false, reason: 'protected' };
    const st = stat(dirName);
    if (!st?.isDirectory() && !allowMissing) return { ok: false, reason: 'missing' };
    return { ok: true, target: { kind: 'glob', dir: dirName, pattern: base } };
  }
  const st = stat(expanded);
  if (st && !st.isDirectory()) {
    if (isProtectedSaveRoot(dirName, ctx)) return { ok: false, reason: 'protected' };
    return { ok: true, target: { kind: 'file', dir: dirName, file: base } };
  }
  if (!st && !allowMissing) return { ok: false, reason: 'missing' };
  // A missing path with an extension restores as a single file (old behaviour).
  if (!st && p.extname(expanded)) {
    if (isProtectedSaveRoot(dirName, ctx)) return { ok: false, reason: 'protected' };
    return { ok: true, target: { kind: 'file', dir: dirName, file: base } };
  }
  if (isProtectedSaveRoot(expanded, ctx)) return { ok: false, reason: 'protected' };
  return { ok: true, target: { kind: 'dir', dir: expanded } };
}

export interface ListSaveFilesOptions {
  /**
   * DUN-070: folders (relative to the target, '' = the root) that could not
   * be read are pushed here. A caller must not treat files under them as
   * deleted (sync skips remote deletes for that game and reports it).
   */
  unreadable?: string[];
  /** Stop after this many files (saves:listFiles cap). */
  max?: number;
}

/**
 * Every regular file of the target as {local, rel}. Symlinks (files and
 * folders) are skipped, so the walk never leaves the target folder.
 */
export function listSaveFiles(target: SaveTarget, opts: ListSaveFilesOptions = {}): { local: string; rel: string }[] {
  const out: { local: string; rel: string }[] = [];
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const unreadable = (rel: string, error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    opts.unreadable?.push(rel);
  };
  if (target.kind === 'file') {
    const local = nodePath.join(target.dir, target.file);
    try {
      if (fs.lstatSync(local).isFile()) out.push({ local, rel: target.file });
    } catch (e) { unreadable(target.file, e); }
    return out;
  }
  if (target.kind === 'glob') {
    const re = globSegmentToRegExp(target.pattern);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(target.dir, { withFileTypes: true }); } catch (e) { unreadable('', e); return out; }
    for (const e of entries) {
      if (out.length >= max) break;
      if (e.isFile() && re.test(e.name)) out.push({ local: nodePath.join(target.dir, e.name), rel: e.name });
    }
    return out;
  }
  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { unreadable(nodePath.relative(target.dir, dir), e); return; }
    for (const item of items) {
      if (out.length >= max) return;
      if (item.isSymbolicLink()) continue;
      const full = nodePath.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile()) out.push({ local: full, rel: nodePath.relative(target.dir, full) });
    }
  };
  walk(target.dir);
  return out;
}

/**
 * Whether a server-relative path belongs to this target. A file target takes
 * only its own name; a file filter only single-segment names matching the
 * glob; a folder anything (resolveRestoreTarget does the containment check).
 */
export function acceptsRelativePath(target: SaveTarget, rel: string): boolean {
  if (target.kind === 'dir') return true;
  if (/[\\/]/.test(rel)) return false;
  if (target.kind === 'file') return rel === target.file;
  return globSegmentToRegExp(target.pattern).test(rel);
}

/** Restore root: the folder for a dir target, the containing folder otherwise. */
export function restoreRootOf(target: SaveTarget): string {
  return target.dir;
}
