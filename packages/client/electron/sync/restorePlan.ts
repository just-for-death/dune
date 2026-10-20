import * as nodePath from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import type { FileManifest, HashManifest } from '@dune/shared';

// DUN-066: before a restore overwrites anything, decide per file whether the
// local copy is in conflict, and back up every conflicting local file.
//
// A local file is in CONFLICT when it exists, differs from the server copy,
// and differs from the state this client last synced (no fingerprint for it,
// e.g. on a new machine, or a different size/mtime: edited since the last
// push). Those local bytes would otherwise be lost.

export interface ServerFileEntry {
  path: string;
  hash: string;
  size?: number;
  mtimeMs?: number;
}

export interface RestoreFileDecision<F extends ServerFileEntry> {
  file: F;
  target: string;
  /** Local file exists, differs from the server and from the last synced state. */
  conflict: boolean;
}

export interface RestorePlan<F extends ServerFileEntry> {
  /** Files to download and write. */
  download: RestoreFileDecision<F>[];
  /** Subset of `download` whose local copy must be backed up first. */
  conflicts: RestoreFileDecision<F>[];
  /** Local copy already equals the server (same sha256): nothing to write. */
  identical: { file: F; target: string }[];
}

export interface RestorePlanDeps {
  /** null when the file does not exist. */
  stat?: (p: string) => { size: number; mtimeMs: number; isFile(): boolean } | null;
  hashFile?: (p: string) => string;
}

export function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function defaultStat(p: string) {
  try { return fs.lstatSync(p); } catch { return null; }
}

/**
 * `resolved` are server entries whose target already passed
 * resolveRestoreTarget. `uploaded` is the last pushed size+mtime manifest,
 * `knownRemote` the server manifest this client last pulled.
 */
export function planRestore<F extends ServerFileEntry>(
  resolved: readonly { file: F; target: string }[],
  uploaded: FileManifest,
  knownRemote: HashManifest,
  deps: RestorePlanDeps = {},
): RestorePlan<F> {
  const stat = deps.stat ?? defaultStat;
  const hashFile = deps.hashFile ?? sha256File;
  const plan: RestorePlan<F> = { download: [], conflicts: [], identical: [] };
  for (const { file, target } of resolved) {
    const st = stat(target);
    if (!st || !st.isFile()) {
      plan.download.push({ file, target, conflict: false });
      continue;
    }
    // Server copy unchanged since our last pull: local edits are newer and go
    // up with the next sync. Never overwrite them.
    if (knownRemote[file.path] === file.hash) continue;
    if (hashFile(target) === file.hash) {
      plan.identical.push({ file, target });
      continue;
    }
    const last = uploaded[file.path];
    const unchangedSinceSync = !!last && last.size === st.size && last.mtimeMs === Math.round(st.mtimeMs);
    const decision = { file, target, conflict: !unchangedSinceSync };
    plan.download.push(decision);
    if (decision.conflict) plan.conflicts.push(decision);
  }
  return plan;
}

export interface BackupOptions {
  now?: () => Date;
  /** Must never overwrite `dest` (same approach as DUN-001 migrateStore: COPYFILE_EXCL). */
  copyFileExclusive?: (src: string, dest: string) => void;
}

const defaultCopyFileExclusive = (src: string, dest: string) =>
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);

/** `<backupRoot>/game-<id>/<ISO timestamp, filename-safe>` */
export function restoreBackupDir(backupRoot: string, gameId: number, now: Date): string {
  return nodePath.join(backupRoot, `game-${gameId}`, now.toISOString().replace(/:/g, '-'));
}

/**
 * Copy each conflicting local file to the backup folder, keeping its relative
 * path. Exclusive copies only; throws on the first failure so the caller
 * writes nothing for that game (fail closed).
 */
export function backupLocalFiles(
  backupRoot: string,
  gameId: number,
  entries: readonly { file: { path: string }; target: string }[],
  opts: BackupOptions = {},
): string | null {
  if (entries.length === 0) return null;
  const dir = restoreBackupDir(backupRoot, gameId, (opts.now ?? (() => new Date()))());
  const copy = opts.copyFileExclusive ?? defaultCopyFileExclusive;
  for (const { file, target } of entries) {
    // file.path already passed the shared rules (no '..', no absolute).
    const dest = nodePath.join(dir, ...file.path.split('/'));
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    copy(target, dest);
  }
  return dir;
}

/** size+mtime fingerprint for the uploaded-state update after a write. */
export function fingerprintOf(p: string): { size: number; mtimeMs: number } | null {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}
