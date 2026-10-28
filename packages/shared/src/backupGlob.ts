/**
 * The one backup-profile glob matcher, used by both the server
 * (services/backupProfiles.ts) and Desktop (electron/utils.ts) so a file is
 * included or excluded the same way on both sides (DUN-136).
 */

/**
 * Cache/log/screenshot rules applied whenever a profile has
 * `autoExcludeCache: true` (DUN-103), on top of the profile's own
 * `excludeGlobs` (which hold only the user's extra rules).
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
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

/** `**\/` = zero or more directories, `**` = anything, `*` = within one segment, `?` = one char. Case-insensitive. */
export function globToRegExp(pattern: string): RegExp {
  const withPlaceholders = toPosix(pattern).trim()
    .replace(/\*\*\//g, '@@GSS@@')
    .replace(/\*\*/g, '@@GS@@')
    .replace(/\*/g, '@@STAR@@')
    .replace(/\?/g, '@@QMARK@@');
  const regex = escapeRegExp(withPlaceholders)
    .replace(/@@GSS@@/g, '(?:.*/)?')
    .replace(/@@GS@@/g, '.*')
    .replace(/@@STAR@@/g, '[^/]*')
    .replace(/@@QMARK@@/g, '[^/]');
  return new RegExp(`^${regex}$`, 'i');
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  const p = toPosix(pattern ?? '').trim();
  if (!p || p === '*' || p === '**' || p === '**/*') return true;
  return globToRegExp(p).test(toPosix(relPath));
}
