import { getDb } from '../db/sqlite.js';
import type { BackupProfile } from '@dune/shared';

/**
 * Cache/log/screenshot rules applied whenever a profile has
 * `autoExcludeCache: true` (DUN-103), on top of the profile's own
 * `excludeGlobs` (which hold only the user's extra rules).
 */
export const DEFAULT_EXCLUDE_GLOBS = [
  '**/*.log',
  '**/*.tmp',
  '**/*.cache',
  '**/cache/**',
  '**/Cache/**',
  '**/ShaderCache/**',
  '**/crashdumps/**',
  '**/CrashDumps/**',
  '**/screenshots/**',
  '**/Screenshots/**',
  '**/logs/**',
  '**/Logs/**',
];

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern).trim();
  const withPlaceholders = normalized
    .replace(/\*\*\//g, '@@GSS@@')
    .replace(/\*\*/g, '@@GS@@')
    .replace(/\*/g, '@@STAR@@')
    .replace(/\?/g, '@@QMARK@@');
  let regex = escapeRegExp(withPlaceholders);
  regex = regex.replace(/@@GSS@@/g, '(?:.*/)?');
  regex = regex.replace(/@@GS@@/g, '.*');
  regex = regex.replace(/@@STAR@@/g, '[^/]*');
  regex = regex.replace(/@@QMARK@@/g, '[^/]');
  return new RegExp(`^${regex}$`, 'i');
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  if (!pattern || pattern === '*' || pattern === '**' || pattern === '**/*') return true;
  return globToRegExp(pattern).test(toPosix(relPath));
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

export function calculateBackupSizes(files: BackupCandidate[], profile: BackupProfile): {
  backupBytes: number;
  excludedBytes: number;
  backupFiles: number;
  excludedFiles: number;
} {
  const { included, excluded } = filterBackupFiles(files, profile);
  return {
    backupBytes: included.reduce((sum, file) => sum + file.size, 0),
    excludedBytes: excluded.reduce((sum, file) => sum + file.size, 0),
    backupFiles: included.length,
    excludedFiles: excluded.length,
  };
}
