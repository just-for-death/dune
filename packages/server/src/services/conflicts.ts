import * as crypto from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { getSaveVersion } from './saveVersions.js';
import type { ConflictRecord } from '@dune/shared';

function fileSignature(versionId: string): string {
  const detail = getSaveVersion(versionId);
  if (!detail) return '';
  return detail.files
    .map((file) => `${file.path}:${file.hash}:${file.size}`)
    .sort()
    .join('|');
}

export function recordConflict(gameId: number, localVersionId: string, remoteVersionId: string): ConflictRecord {
  const db = getDb();
  const id = crypto.randomUUID();
  const detectedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO conflict_records (id, gameId, localVersionId, remoteVersionId, detectedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, gameId, localVersionId, remoteVersionId, detectedAt);

  return {
    id,
    gameId,
    localVersionId,
    remoteVersionId,
    detectedAt,
  };
}

/** Conflicts for one game, or (no gameId) across games; `ownerId` scopes to that owner's games (DUN-087). */
export function listConflicts(gameId?: number, ownerId?: string): ConflictRecord[] {
  const db = getDb();
  const cols = 'c.id, c.gameId, c.localVersionId, c.remoteVersionId, c.detectedAt, c.resolution, c.resolvedAt';
  const rows = (gameId != null
    ? db.prepare(`SELECT ${cols} FROM conflict_records c WHERE c.gameId = ? ORDER BY c.detectedAt DESC`).all(gameId)
    : ownerId
      ? db.prepare(`SELECT ${cols} FROM conflict_records c JOIN games g ON g.id = c.gameId WHERE g.ownerId = ? ORDER BY c.detectedAt DESC`).all(ownerId)
      : db.prepare(`SELECT ${cols} FROM conflict_records c ORDER BY c.detectedAt DESC`).all()) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    gameId: Number(row.gameId),
    localVersionId: String(row.localVersionId),
    remoteVersionId: String(row.remoteVersionId),
    detectedAt: String(row.detectedAt),
    resolution: row.resolution ? String(row.resolution) as ConflictRecord['resolution'] : undefined,
    resolvedAt: row.resolvedAt ? String(row.resolvedAt) : undefined,
  }));
}

export function resolveConflict(conflictId: string, resolution: NonNullable<ConflictRecord['resolution']>): ConflictRecord | null {
  const db = getDb();
  const resolvedAt = new Date().toISOString();
  db.prepare(`
    UPDATE conflict_records
    SET resolution = ?, resolvedAt = ?
    WHERE id = ?
  `).run(resolution, resolvedAt, conflictId);

  const row = db.prepare(`
    SELECT id, gameId, localVersionId, remoteVersionId, detectedAt, resolution, resolvedAt
    FROM conflict_records
    WHERE id = ?
  `).get(conflictId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return {
    id: String(row.id),
    gameId: Number(row.gameId),
    localVersionId: String(row.localVersionId),
    remoteVersionId: String(row.remoteVersionId),
    detectedAt: String(row.detectedAt),
    resolution: row.resolution ? String(row.resolution) as ConflictRecord['resolution'] : undefined,
    resolvedAt: row.resolvedAt ? String(row.resolvedAt) : undefined,
  };
}

export function hasUnresolvedConflict(gameId: number): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM conflict_records
    WHERE gameId = ? AND resolution IS NULL
  `).get(gameId) as { count: number } | undefined;
  return Number(row?.count ?? 0) > 0;
}

export function detectConflict(gameId: number, localVersionId: string, remoteVersionId: string): ConflictRecord | null {
  if (localVersionId === remoteVersionId) return null;

  const local = getSaveVersion(localVersionId);
  const remote = getSaveVersion(remoteVersionId);
  if (!local || !remote) return null;

  // A direct parent/child relationship is normal sync progression, not a conflict.
  if (local.version.parentVersionId === remoteVersionId || remote.version.parentVersionId === localVersionId) {
    return null;
  }

  // Identical content is not a conflict.
  if (fileSignature(localVersionId) === fileSignature(remoteVersionId)) {
    return null;
  }

  return recordConflict(gameId, localVersionId, remoteVersionId);
}
