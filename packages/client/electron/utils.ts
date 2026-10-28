/**
 * Pure utility functions for the Electron main process.
 * These functions have no Electron or filesystem dependencies and can be
 * unit tested in any JavaScript environment.
 */

import { type FileManifest, type ScannerSourceToggles, type TrackersEnabled } from '@dune/shared';
import { sanitizeScannerSources } from './scanner/sourceToggles';
import { diffFingerprints, changedPaths, matchesGlob } from '@dune/shared';
import * as path from 'path';
import * as fs from 'fs';

/** Expand platform-specific path variables (~ on Unix, %USERPROFILE% on Windows). Pure function. */
/**
 * Expand a leading `~` and, on Windows, every `%VAR%` (DUN-078: %APPDATA%,
 * %LOCALAPPDATA%, %PROGRAMDATA%, ...; Windows env names are case-insensitive).
 * A path that still holds an unset variable returns '' so callers skip it
 * instead of resolving a literal `%VAR%` folder.
 */
export function expandPath(
  p: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!p) return '';
  if (platform !== 'win32') return p.replace(/^~(?=$|\/)/, env.HOME || '~');
  const lookup = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));
  let unresolved = false;
  const out = p
    .replace(/^~(?=$|[\\/])/, () => env.USERPROFILE || (unresolved = true, ''))
    .replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (_m, name: string) => {
      const v = lookup.get(name.toUpperCase());
      if (!v) { unresolved = true; return ''; }
      return v;
    });
  return unresolved ? '' : out;
}

/** Convert a platform-specific path to POSIX format. Pure function. */
export function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** Convert any value to a string, truncating to max length. Pure function. */
export function asString(v: unknown, max = 2000): string {
  if (typeof v === 'string') return v.slice(0, max);
  return '';
}

const GAME_SOURCES = ['steam', 'heroic', 'lutris', 'manual', 'epic', 'gog', 'ubisoft', 'ea', 'battlenet', 'xbox', 'minecraft', 'emulator'] as const;
type GameSourceName = typeof GAME_SOURCES[number];

/** Optional scanner/launcher metadata preserved through renderer round-trips. */
const OPTIONAL_GAME_STRINGS = [
  'sourceId', 'steamAppId', 'heroicId', 'lutrisSlug', 'winePrefix', 'protonPath',
  'executable', 'installPath', 'emulator', 'romPath',
] as const;
type OptionalGameString = typeof OPTIONAL_GAME_STRINGS[number];

/**
 * Sanitize game input from the renderer. Pure function.
 *
 * Besides the core fields, the optional launcher metadata (source, installPath,
 * steamAppId, ...) is kept when it is a string, so a config save from the
 * renderer no longer strips what the scanners and the DUN-001 store migration
 * wrote. Unknown/invalid values are dropped, never coerced.
 *
 * DUN-061: NOT for renderer or server input any more. It keeps launch fields,
 * so main no longer calls it from `config:save` / `game:add`; those go
 * through `launcher/launchFields.ts` (metadata only, merged by id).
 */
export function sanitizeGame(input: unknown): {
  name: string;
  winPath: string;
  linPath: string;
  lastSync: string;
  status: 'In Sync' | 'Pending Upload' | 'Error';
  thumbnail: string;
  source?: GameSourceName;
} & Partial<Record<OptionalGameString, string>> {
  const g = (input ?? {}) as Record<string, unknown>;
  const name = asString(g.name, 200).trim();
  if (!name) throw new Error('Game title is required');
  const status = asString(g.status, 32);
  const optional: Partial<Record<OptionalGameString, string>> = {};
  for (const key of OPTIONAL_GAME_STRINGS) {
    const value = asString(g[key]);
    if (value) optional[key] = value;
  }
  const source = asString(g.source, 32);
  return {
    name,
    winPath: asString(g.winPath),
    linPath: asString(g.linPath),
    lastSync: asString(g.lastSync, 64) || 'Never',
    status: ['Pending Upload', 'In Sync', 'Error'].includes(status)
      ? status as 'In Sync' | 'Pending Upload' | 'Error'
      : 'Pending Upload',
    thumbnail: asString(g.thumbnail),
    ...((GAME_SOURCES as readonly string[]).includes(source) ? { source: source as GameSourceName } : {}),
    ...optional,
  };
}

/** Sanitize settings input from the renderer. Pure function. */
export function sanitizeTrackersEnabled(input: unknown): TrackersEnabled {
  const t = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  return {
    steam: t.steam === true,
    retroAchievements: t.retroAchievements === true,
    gog: t.gog === true,
  };
}

export function sanitizeSettings(input: unknown, fallback: unknown): {
  runInBackground: boolean;
  autoSyncEnabled: boolean;
  autoSyncFreq: string;
  scanRoots: string[];
  updateChecks: boolean;
  scannerSources: ScannerSourceToggles;
  trackersEnabled: TrackersEnabled;
  artworkEnabled: boolean;
} {
  const s = (input ?? {}) as Record<string, unknown>;
  const f = (fallback ?? {}) as Record<string, unknown>;
  const cleanRoots = (roots: unknown): string[] =>
    Array.isArray(roots)
      ? roots.filter((r): r is string => typeof r === 'string').slice(0, 50).map(r => r.slice(0, 2000))
      : [];
  const scanRoots = Array.isArray(s.scanRoots)
    ? cleanRoots(s.scanRoots)
    : cleanRoots(f.scanRoots);
  const freq = asString(s.autoSyncFreq, 8);
  return {
    runInBackground: s.runInBackground === true,
    autoSyncEnabled: s.autoSyncEnabled === true,
    autoSyncFreq: ['never', '1h', '6h', '24h'].includes(freq) ? freq : 'never',
    scanRoots,
    // DUN-028: opt-in only.
    updateChecks: s.updateChecks === true,
    // DUN-077: main-owned (scanner:setSource); the renderer can't change it here.
    scannerSources: sanitizeScannerSources(f.scannerSources),
    // Trackers and artwork are opt-in: only a literal true turns one on.
    trackersEnabled: sanitizeTrackersEnabled(s.trackersEnabled),
    artworkEnabled: s.artworkEnabled === true,
  };
  // DUN-092 / DUN-036: no SteamGridDB key is kept here; it lives only on the
  // Dune Server (write-only provider key).
}

/** Build a size+mtime fingerprint manifest for a list of files. */
export function buildLocalManifest(
  files: { local: string; rel: string }[])
: FileManifest {
  
  const manifest: FileManifest = {};
  for (const f of files) {
    try {
      const stat = fs.statSync(f.local);
      manifest[toPosix(f.rel)] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
    } catch {
      /* unreadable: treat as absent */
    }
  }
  return manifest;
}

type SyncStateRecord = Record<string, { uploaded?: FileManifest }>;
type UploadPlan = { plan: { game: string; rel: string; local: string }[]; localManifest: FileManifest; deleted: string[] };

/**
 * Plan an upload by diffing local files against the last uploaded manifest.
 *
 * DUN-067: `diskFiles` is the UNFILTERED list of what is on disk; `isIncluded`
 * is the backup-profile filter. Uploads cover only included files that
 * changed. A deletion is planned only for a file that was uploaded before, is
 * really gone from disk, and is still included: adding an exclude rule only
 * stops future syncing and never deletes anything on the server. `deleted`
 * stays empty when the disk list is empty (an unmounted folder never wipes
 * the server copy).
 */
export function planUpload(
  game: string,
  diskFiles: { local: string; rel: string }[],
  getSyncStateFn: () => SyncStateRecord,
  isIncluded: (rel: string) => boolean = () => true,
): UploadPlan {
  const included = diskFiles.filter(f => isIncluded(toPosix(f.rel)));
  const localManifest = buildLocalManifest(included);
  const previous = getSyncStateFn()[game]?.uploaded || {};
  const wanted = new Set(changedPaths(diffFingerprints(previous, localManifest)));
  const plan = included
    .map(f => ({ game, rel: toPosix(f.rel), local: f.local }))
    .filter(f => wanted.has(f.rel));
  const onDisk = new Set(diskFiles.map(f => toPosix(f.rel)));
  const deleted = diskFiles.length > 0
    ? Object.keys(previous).filter(rel => !onDisk.has(rel) && isIncluded(rel))
    : [];
  return { plan, localManifest, deleted };
}

type SaveGameStatePatch = { uploaded: FileManifest };

/** Persist what actually landed: unchanged + succeeded, minus failures. */
export function commitUploaded(
  game: string,
  localManifest: FileManifest,
  failedRels: string[],
  saveGameStateFn: (game: string, patch: SaveGameStatePatch) => void
): void {
  const uploaded = { ...localManifest };
  for (const rel of failedRels) delete uploaded[rel];
  saveGameStateFn(game, { uploaded });
}
/** The backup-profile fields Desktop applies (shared BackupProfile). */
export type BackupProfileGlobs = { includeGlobs: string[]; excludeGlobs: string[]; autoExcludeCache?: boolean };

/**
 * The backup-profile filter as a predicate on a POSIX relative path.
 * When `autoExcludeCache` is on, the server's built-in cache/log/screenshot
 * globs (GET /api/backup-profile -> cacheExcludeGlobs, DUN-103) are excluded
 * on top of the user's own excludeGlobs.
 */
export function backupProfileFilter(
  profile: BackupProfileGlobs | null | undefined,
  cacheExcludeGlobs: readonly string[] = [],
): (rel: string) => boolean {
  if (!profile) return () => true;
  const include = Array.isArray(profile.includeGlobs) ? profile.includeGlobs : [];
  const exclude = [
    ...(Array.isArray(profile.excludeGlobs) ? profile.excludeGlobs : []),
    ...(profile.autoExcludeCache === true ? cacheExcludeGlobs.filter((g) => typeof g === 'string') : []),
  ];
  return (rel) => include.some((g) => matchesGlob(rel, g)) && !exclude.some((g) => matchesGlob(rel, g));
}
