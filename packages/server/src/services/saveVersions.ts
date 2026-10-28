import * as crypto from 'node:crypto';
import { getDb, inTransaction } from '../db/sqlite.js';
import { logger } from '../middleware/logging.js';
import type { SaveVersion, SaveFileSnapshot } from '@dune/shared';

export interface CreateVersionInput {
  gameId: number;
  ownerId?: string;
  deviceId?: string;
  files: Array<{ path: string; size: number; hash: string; mtime: string }>;
  changeSummary?: string;
  parentVersionId?: string;
}

/**
 * Insert one version row and its file rows in ONE transaction (DUN-098):
 * either the whole record exists or none of it does.
 */
export function createSaveVersion(input: CreateVersionInput, opts: { id?: string; afterInsert?: () => void } = {}): SaveVersion {
  const id = opts.id ?? crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const sizeBytes = input.files.reduce((sum, file) => sum + (file.size || 0), 0);
  const fileCount = input.files.length;

  inTransaction((db) => {
    db.prepare(`
      INSERT INTO save_versions
        (id, gameId, ownerId, deviceId, createdAt, sizeBytes, fileCount, parentVersionId, changeSummary, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')
    `).run(
      id,
      input.gameId,
      input.ownerId ?? null,
      input.deviceId ?? null,
      createdAt,
      sizeBytes,
      fileCount,
      input.parentVersionId ?? null,
      input.changeSummary ?? '',
    );
    const insertSnapshot = db.prepare(`
      INSERT INTO save_file_snapshots (id, versionId, path, size, hash, mtime)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const file of input.files) {
      insertSnapshot.run(crypto.randomUUID(), id, file.path, file.size, file.hash, file.mtime);
    }
    // Runs before COMMIT: if it throws (e.g. the snapshot dir can't be
    // published) the rows are rolled back.
    opts.afterInsert?.();
  });

  logger.info({ gameId: input.gameId, versionId: id, fileCount }, 'Created save version');
  return {
    id,
    gameId: input.gameId,
    ownerId: input.ownerId,
    deviceId: input.deviceId,
    createdAt,
    sizeBytes,
    fileCount,
    parentVersionId: input.parentVersionId,
    changeSummary: input.changeSummary ?? '',
    status: 'complete',
  };
}

export function listSaveVersions(gameId: number, limit = 50): SaveVersion[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, gameId, ownerId, deviceId, createdAt, sizeBytes, fileCount, parentVersionId, changeSummary, status
    FROM save_versions
    WHERE gameId = ?
    ORDER BY createdAt DESC
    LIMIT ?
  `).all(gameId, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    gameId: Number(row.gameId),
    ownerId: row.ownerId ? String(row.ownerId) : undefined,
    deviceId: row.deviceId ? String(row.deviceId) : undefined,
    createdAt: String(row.createdAt),
    sizeBytes: Number(row.sizeBytes),
    fileCount: Number(row.fileCount),
    parentVersionId: row.parentVersionId ? String(row.parentVersionId) : undefined,
    changeSummary: String(row.changeSummary ?? ''),
    status: String(row.status ?? 'complete') as SaveVersion['status'],
  }));
}

export function getSaveVersion(versionId: string): { version: SaveVersion; files: SaveFileSnapshot[] } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, gameId, ownerId, deviceId, createdAt, sizeBytes, fileCount, parentVersionId, changeSummary, status
    FROM save_versions
    WHERE id = ?
  `).get(versionId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const fileRows = db.prepare(`
    SELECT id, versionId, path, size, hash, mtime
    FROM save_file_snapshots
    WHERE versionId = ?
    ORDER BY path ASC
  `).all(versionId) as Array<Record<string, unknown>>;

  return {
    version: {
      id: String(row.id),
      gameId: Number(row.gameId),
      ownerId: row.ownerId ? String(row.ownerId) : undefined,
      deviceId: row.deviceId ? String(row.deviceId) : undefined,
      createdAt: String(row.createdAt),
      sizeBytes: Number(row.sizeBytes),
      fileCount: Number(row.fileCount),
      parentVersionId: row.parentVersionId ? String(row.parentVersionId) : undefined,
      changeSummary: String(row.changeSummary ?? ''),
      status: String(row.status ?? 'complete') as SaveVersion['status'],
    },
    files: fileRows.map((file) => ({
      versionId: String(file.versionId),
      path: String(file.path),
      size: Number(file.size),
      hash: String(file.hash),
      mtime: String(file.mtime),
    })),
  };
}

export function getVersionDiff(fromVersionId: string, toVersionId: string): {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
} {
  const from = getSaveVersion(fromVersionId);
  const to = getSaveVersion(toVersionId);
  if (!from || !to) {
    return { added: [], removed: [], changed: [], unchanged: 0 };
  }

  const fromMap = new Map(from.files.map((file) => [file.path, file.hash]));
  const toMap = new Map(to.files.map((file) => [file.path, file.hash]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  for (const [path, hash] of toMap) {
    const previousHash = fromMap.get(path);
    if (previousHash === undefined) added.push(path);
    else if (previousHash !== hash) changed.push(path);
    else unchanged += 1;
  }

  for (const path of fromMap.keys()) {
    if (!toMap.has(path)) removed.push(path);
  }

  return { added, removed, changed, unchanged };
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGameRoot, resolveGameSubdir, resolveGameFile, PathRuleError } from '../utils/path.js';
import { withDbLock } from '../db/mutex.js';
import { database } from '../db/index.js';
import { invalidateGame } from './manifest.js';
import { getBackupProfile, filterBackupFiles } from './backupProfiles.js';

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

interface WalkedFile { path: string; size: number; mtime: string }

/** Real files under `root` (relative, '/'-separated), skipping `.versions/` and symlinks. */
function listTreeFiles(root: string): WalkedFile[] {
  const files: WalkedFile[] = [];
  if (!fs.existsSync(root)) return files;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (rel === '.versions' || rel.startsWith(`.versions${path.sep}`)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          files.push({ path: rel.replace(/\\/g, '/'), size: stat.size, mtime: stat.mtime.toISOString() });
        } catch {
          // Ignore unreadable files.
        }
      }
    }
  }
  return files;
}

/** Leftover staging dirs older than this are crash debris (DUN-098). */
const STALE_STAGING_MS = 60 * 60 * 1000;
const STAGING_PREFIX = '.staging-';

/**
 * DUN-098: snapshot the game tree as one atomic version.
 * (1) copy the tracked files into a private staging dir under `.versions/`,
 * hashing the copies (the record describes exactly the stored bytes);
 * (2) in ONE transaction insert the version + file rows and rename the
 * staging dir to `.versions/<id>`. Any failure removes the staging dir and
 * leaves no row; a version row is never visible before its files are.
 * (3) prune the game's history to `maxVersions`, never the new version (DUN-097).
 */
export function createVersionFromDirectory(input: {
  gameId: number;
  ownerId: string;
  deviceId?: string;
  changeSummary?: string;
  parentVersionId?: string;
  profileGameId?: number;
  /** Extra versions the post-create prune must keep (e.g. the one being restored). */
  keepVersionIds?: string[];
}): SaveVersion {
  const gameRoot = getGameRoot(input.gameId, input.ownerId);
  const profile = getBackupProfile(input.profileGameId ?? input.gameId);
  const allFiles = listTreeFiles(gameRoot);
  const { included } = filterBackupFiles(allFiles.map((file) => ({ path: file.path, size: file.size })), profile);
  const includedSet = new Set(included.map((file) => file.path));
  const tracked = allFiles.filter((file) => includedSet.has(file.path));

  const latest = listSaveVersions(input.gameId, 1)[0];
  const parentVersionId = input.parentVersionId ?? latest?.id;

  const versionsRoot = path.join(gameRoot, '.versions');
  fs.mkdirSync(versionsRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(versionsRoot, STAGING_PREFIX));
  const id = crypto.randomUUID();
  const finalDir = path.join(versionsRoot, id);
  let version: SaveVersion;
  try {
    const files = tracked.map((file) => {
      const dest = path.join(staging, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(gameRoot, ...file.path.split('/')), dest);
      return { path: file.path, size: fs.statSync(dest).size, hash: hashFile(dest), mtime: file.mtime };
    });
    version = createSaveVersion({
      gameId: input.gameId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      files,
      changeSummary: input.changeSummary ?? 'directory snapshot',
      parentVersionId,
    }, { id, afterInsert: () => fs.renameSync(staging, finalDir) });
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    // The rename may have happened before a failed COMMIT: no row -> no dir.
    if (!getSaveVersion(id)) fs.rmSync(finalDir, { recursive: true, force: true });
    throw err;
  }

  pruneVersions(input.gameId, input.ownerId, maxVersionsSetting(), [version.id, ...(input.keepVersionIds ?? [])]);
  return version;
}

/** settings.maxVersions as a sane integer (1..1000), default 10. */
export function maxVersionsSetting(): number {
  const n = Number(database.getSettings().maxVersions);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 1000) : 10;
}

export interface VersionRecord {
  id: string;
  /** Epoch ms used for ordering. */
  time: number;
  kind: 'row' | 'upload' | 'orphan';
}

/**
 * Every stored version of a game (DUN-097): DB rows (directory snapshots,
 * `.versions/<uuid>`), upload/local-sync snapshot dirs (`.versions/<digits>`,
 * the digits are the sync id = epoch ms), and UUID dirs left without a row.
 */
export function listVersionRecords(gameId: number, ownerId: string): VersionRecord[] {
  const records = new Map<string, VersionRecord>();
  const rows = getDb().prepare('SELECT id, createdAt FROM save_versions WHERE gameId = ?').all(gameId) as Array<{ id: string; createdAt: string }>;
  for (const r of rows) records.set(r.id, { id: String(r.id), time: Date.parse(String(r.createdAt)) || 0, kind: 'row' });

  const versionsRoot = path.join(getGameRoot(gameId, ownerId), '.versions');
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(versionsRoot, { withFileTypes: true });
  } catch {
    names = [];
  }
  for (const d of names) {
    if (!d.isDirectory() || records.has(d.name)) continue;
    if (/^\d{1,20}$/.test(d.name)) {
      records.set(d.name, { id: d.name, time: Number(d.name), kind: 'upload' });
    } else if (SAVE_VERSION_ID.test(d.name)) {
      const st = fs.statSync(path.join(versionsRoot, d.name), { throwIfNoEntry: false });
      records.set(d.name, { id: d.name, time: st ? st.mtimeMs : 0, kind: 'orphan' });
    } else if (d.name.startsWith(STAGING_PREFIX)) {
      const st = fs.statSync(path.join(versionsRoot, d.name), { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > STALE_STAGING_MS) {
        fs.rmSync(path.join(versionsRoot, d.name), { recursive: true, force: true });
      }
    }
  }
  return [...records.values()].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
}

/**
 * DUN-097: keep the newest `maxVersions` versions of a game, counting DB
 * rows and snapshot dirs together. Never removed: ids in `keep` (the version
 * just created / this sync's snapshot) and versions an unresolved conflict
 * points at. Rows are deleted in one transaction first, then their dirs.
 * Exclude rules play no part here (DUN-067): pruning is by count only.
 */
export function pruneVersions(gameId: number, ownerId: string, maxVersions: number, keep: string[] = []): string[] {
  const records = listVersionRecords(gameId, ownerId);
  const protectedIds = new Set(keep);
  const open = getDb().prepare(
    "SELECT localVersionId, remoteVersionId FROM conflict_records WHERE gameId = ? AND (resolution IS NULL OR resolution = 'later')",
  ).all(gameId) as Array<{ localVersionId: string; remoteVersionId: string }>;
  for (const c of open) {
    protectedIds.add(String(c.localVersionId));
    protectedIds.add(String(c.remoteVersionId));
  }

  const limit = Math.max(1, Math.floor(maxVersions));
  const doomed = records.slice(limit).filter((r) => !protectedIds.has(r.id));
  if (doomed.length === 0) return [];

  const rowIds = doomed.filter((r) => r.kind === 'row').map((r) => r.id);
  if (rowIds.length > 0) {
    inTransaction((db) => {
      const del = db.prepare('DELETE FROM save_versions WHERE id = ? AND gameId = ?');
      for (const id of rowIds) del.run(id, gameId);
    });
  }
  for (const r of doomed) {
    // Validated, strictly inside saves/<owner>/<gameId>/.versions.
    const dir = resolveGameSubdir(gameId, `.versions/${r.id}`, ownerId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  logger.info({ gameId, pruned: doomed.length, maxVersions: limit }, 'Pruned save versions');
  return doomed.map((r) => r.id);
}

/** Save-version ids are minted by createSaveVersion with crypto.randomUUID(). */
export const SAVE_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Any folder name allowed under `.versions/`: upload snapshots use the
 * digits-only sync id (sync.ts safeVersionId), directory snapshots use the
 * UUID version id. Used for reads (download-version-file, files.versions.files).
 */
export const VERSION_DIR_ID = /^(?:\d{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface RestoreResult {
  success: boolean;
  message: string;
  restoredFiles: number;
  /** Tracked files that existed now but not in the version (mirrored away). */
  removedFiles: number;
  /** Snapshot of the state just before the restore (undo point). */
  preRestoreVersionId?: string;
}

/**
 * DUN-090: restore = exact mirror of a stored version, never destructive.
 * Under the DB lock: (1) verify the snapshot is complete and symlink-free,
 * (2) take a pre-restore version of the current state, (3) write every
 * versioned file (staged + rename), (4) delete tracked files that the version
 * doesn't have, (5) bump lastSync and invalidate the manifest. Files the
 * backup profile excludes (e.g. caches) and `.versions/` are never touched.
 */
export async function restoreVersion(gameId: number, versionId: string, ownerId: string): Promise<RestoreResult> {
  // DUN-125: versionId becomes a directory name; accept only the stored id
  // format (crypto.randomUUID). Malformed ids are a 400 (INVALID_VERSION_ID).
  if (!SAVE_VERSION_ID.test(versionId)) {
    throw new PathRuleError('INVALID_VERSION_ID', 'Invalid version id');
  }
  return withDbLock(() => {
    const detail = getSaveVersion(versionId);
    // DUN-087: a version of another game (or another user's game) is "not found".
    if (!detail || detail.version.gameId !== gameId) {
      return { success: false, message: 'Version not found', restoredFiles: 0, removedFiles: 0 };
    }
    const gameRoot = getGameRoot(gameId, ownerId);
    const snapshotDir = resolveGameSubdir(gameId, `.versions/${versionId}`, ownerId);

    // (1) Every recorded file must be a real file in the snapshot; nothing
    // else is ever copied (a symlink planted in a snapshot is ignored, DUN-128).
    const wanted = detail.files.map((f) => f.path);
    for (const rel of wanted) {
      const src = resolveGameFile(gameId, `.versions/${versionId}/${rel}`, ownerId).abs;
      if (!fs.lstatSync(src, { throwIfNoEntry: false })?.isFile()) {
        return { success: false, message: 'Version snapshot files not found', restoredFiles: 0, removedFiles: 0 };
      }
    }
    if (!fs.existsSync(snapshotDir)) {
      return { success: false, message: 'Version snapshot files not found', restoredFiles: 0, removedFiles: 0 };
    }

    // (2) Undo point.
    const pre = createVersionFromDirectory({
      gameId, ownerId, changeSummary: `pre-restore (before restoring ${versionId})`,
      keepVersionIds: [versionId],
    });

    // (3) Write the version's files.
    for (const rel of wanted) {
      const src = path.join(snapshotDir, ...rel.split('/'));
      const dest = resolveGameFile(gameId, rel, ownerId).abs;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const staged = `${dest}.restoring`;
      fs.copyFileSync(src, staged);
      fs.renameSync(staged, dest);
    }

    // (4) Mirror deletions within the tracked set only.
    const keep = new Set(wanted);
    const profile = getBackupProfile(gameId);
    const current = listTreeFiles(gameRoot).map((f) => ({ path: f.path, size: f.size }));
    const { included } = filterBackupFiles(current, profile);
    let removedFiles = 0;
    for (const f of included) {
      if (keep.has(f.path)) continue;
      fs.rmSync(resolveGameFile(gameId, f.path, ownerId).abs, { force: true });
      removedFiles += 1;
    }

    // (5) Status + manifest.
    database.markGameSynced(gameId);
    invalidateGame(gameId, ownerId);
    logger.info({ gameId, versionId, preRestoreVersionId: pre.id, restoredFiles: wanted.length, removedFiles }, 'Restored save version');
    return {
      success: true, message: 'Version restored', restoredFiles: wanted.length, removedFiles, preRestoreVersionId: pre.id,
    };
  });
}
