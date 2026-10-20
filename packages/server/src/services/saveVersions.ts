import * as crypto from 'node:crypto';
import { getDb } from '../db/sqlite.js';
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

export function createSaveVersion(input: CreateVersionInput): SaveVersion {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const sizeBytes = input.files.reduce((sum, file) => sum + (file.size || 0), 0);
  const fileCount = input.files.length;

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
import { getGameRoot, resolveGameSubdir, assertStrictlyInside, PathRuleError } from '../utils/path.js';
import { getBackupProfile, filterBackupFiles } from './backupProfiles.js';

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function walkFiles(root: string): Array<{ path: string; size: number; hash: string; mtime: string }> {
  const files: Array<{ path: string; size: number; hash: string; mtime: string }> = [];
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
      } else {
        try {
          const stat = fs.statSync(full);
          files.push({
            path: rel.replace(/\\/g, '/'),
            size: stat.size,
            hash: hashFile(full),
            mtime: stat.mtime.toISOString(),
          });
        } catch {
          // Ignore unreadable files.
        }
      }
    }
  }
  return files;
}

export function createVersionFromDirectory(input: {
  gameId: number;
  ownerId: string;
  deviceId?: string;
  changeSummary?: string;
  parentVersionId?: string;
  profileGameId?: number;
}): SaveVersion {
  const gameRoot = getGameRoot(input.gameId, input.ownerId);
  const profile = getBackupProfile(input.profileGameId ?? input.gameId);
  const allFiles = walkFiles(gameRoot);
  const { included } = filterBackupFiles(allFiles.map((file) => ({ path: file.path, size: file.size })), profile);
  const includedSet = new Set(included.map((file) => file.path));
  const files = allFiles.filter((file) => includedSet.has(file.path));

  const latest = listSaveVersions(input.gameId, 1)[0];
  const parentVersionId = input.parentVersionId ?? latest?.id;

  // Store a restorable snapshot directory, matching the DB version id.
  const version = createSaveVersion({
    gameId: input.gameId,
    ownerId: input.ownerId,
    deviceId: input.deviceId,
    files,
    changeSummary: input.changeSummary ?? 'directory snapshot',
    parentVersionId,
  });

  const snapshotDir = path.join(gameRoot, '.versions', version.id);
  fs.mkdirSync(snapshotDir, { recursive: true });
  for (const file of files) {
    const src = path.join(gameRoot, file.path);
    const dest = path.join(snapshotDir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  return version;
}

/** Save-version ids are minted by createSaveVersion with crypto.randomUUID(). */
export const SAVE_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Any folder name allowed under `.versions/`: upload snapshots use the
 * digits-only sync id (sync.ts safeVersionId), directory snapshots use the
 * UUID version id. Used for reads (download-version-file, files.versions.files).
 */
export const VERSION_DIR_ID = /^(?:\d{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function restoreVersion(gameId: number, versionId: string, ownerId: string): { success: boolean; message: string; restoredFiles: number } {
  // DUN-125: versionId becomes a directory name; accept only the stored id
  // format (crypto.randomUUID), then resolve it with the same containment
  // rules as file paths. Malformed ids are a 400 (INVALID_VERSION_ID).
  if (!SAVE_VERSION_ID.test(versionId)) {
    throw new PathRuleError('INVALID_VERSION_ID', 'Invalid version id');
  }
  const detail = getSaveVersion(versionId);
  // DUN-087: a version of another game (or another user's game) is "not found".
  if (!detail || detail.version.gameId !== gameId) {
    return { success: false, message: 'Version not found', restoredFiles: 0 };
  }

  const gameRoot = getGameRoot(gameId, ownerId);
  const snapshotDir = resolveGameSubdir(gameId, `.versions/${versionId}`, ownerId);
  if (!fs.existsSync(snapshotDir)) {
    return { success: false, message: 'Version snapshot files not found', restoredFiles: 0 };
  }

  let restoredFiles = 0;
  const stack: string[] = [snapshotDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // DUN-128: never follow a symlink inside a snapshot (it could point
      // anywhere); only real files and directories are restored.
      if (entry.isSymbolicLink()) {
        logger.warn({ gameId, versionId, entry: entry.name }, 'Skipped symlink in version snapshot');
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const rel = path.relative(snapshotDir, full);
        const dest = path.join(gameRoot, rel);
        assertStrictlyInside(dest, gameRoot, 'Restore target');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        restoredFiles += 1;
      }
    }
  }

  return { success: true, message: 'Version restored', restoredFiles };
}
