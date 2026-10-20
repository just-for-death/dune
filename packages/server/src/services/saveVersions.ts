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
