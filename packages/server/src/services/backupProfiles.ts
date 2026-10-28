import { getDb } from '../db/sqlite.js';
import { DEFAULT_EXCLUDE_GLOBS, matchesGlob, type BackupProfile } from '@dune/shared';

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

export function getBackupProfile(gameId: number): BackupProfile {
  const db = getDb();
  const row = db.prepare(`
    SELECT gameId, includeGlobs, excludeGlobs, autoExcludeCache, maxFileSizeMB, updatedAt
    FROM backup_profiles
    WHERE gameId = ?
  `).get(gameId) as Record<string, unknown> | undefined;

  if (!row) {
    return {
      gameId,
      includeGlobs: ['**/*'],
      excludeGlobs: [],
      autoExcludeCache: true,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    gameId: Number(row.gameId),
    includeGlobs: JSON.parse(String(row.includeGlobs || '["**/*"]')) as string[],
    excludeGlobs: JSON.parse(String(row.excludeGlobs || '[]')) as string[],
    autoExcludeCache: Boolean(row.autoExcludeCache),
    maxFileSizeMB: row.maxFileSizeMB == null ? undefined : Number(row.maxFileSizeMB),
    updatedAt: String(row.updatedAt),
  };
}

export function upsertBackupProfile(profile: BackupProfile): BackupProfile {
  const db = getDb();
  const normalized: BackupProfile = {
    ...profile,
    includeGlobs: profile.includeGlobs.length ? profile.includeGlobs : ['**/*'],
    excludeGlobs: profile.excludeGlobs,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO backup_profiles (gameId, includeGlobs, excludeGlobs, autoExcludeCache, maxFileSizeMB, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(gameId) DO UPDATE SET
      includeGlobs = excluded.includeGlobs,
      excludeGlobs = excluded.excludeGlobs,
      autoExcludeCache = excluded.autoExcludeCache,
      maxFileSizeMB = excluded.maxFileSizeMB,
      updatedAt = excluded.updatedAt
  `).run(
    normalized.gameId,
    JSON.stringify(normalized.includeGlobs),
    JSON.stringify(normalized.excludeGlobs),
    normalized.autoExcludeCache ? 1 : 0,
    normalized.maxFileSizeMB ?? null,
    normalized.updatedAt,
  );

  return normalized;
}

export interface BackupCandidate {
  path: string;
  size: number;
}

export function filterBackupFiles(files: BackupCandidate[], profile: BackupProfile): {
  included: BackupCandidate[];
  excluded: BackupCandidate[];
} {
  const included: BackupCandidate[] = [];
  const excluded: BackupCandidate[] = [];

  // DUN-103: autoExcludeCache adds the built-in cache rules.
  const excludes = profile.autoExcludeCache ? [...DEFAULT_EXCLUDE_GLOBS, ...profile.excludeGlobs] : profile.excludeGlobs;
  for (const file of files) {
    const rel = toPosix(file.path);
    const includedByInclude = profile.includeGlobs.some((pattern) => matchesGlob(rel, pattern));
    const excludedByExclude = excludes.some((pattern) => matchesGlob(rel, pattern));
    const tooLarge = profile.maxFileSizeMB != null && file.size > profile.maxFileSizeMB * 1024 * 1024;

    if (includedByInclude && !excludedByExclude && !tooLarge) {
      included.push(file);
    } else {
      excluded.push(file);
    }
  }

  return { included, excluded };
}
