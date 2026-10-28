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

/** Validate and normalize a server URL. Pure function with no side effects. */
export function validateServerUrl(rawUrl: string): { valid: boolean; url: string; error?: string } {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, url: '', error: 'Server URL is required' };
  }
  let normalized = rawUrl.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(normalized)) {
    if (!/^https?:\/\//i.test(normalized)) {
      return { valid: false, url: '', error: 'Only HTTP and HTTPS protocols are allowed' };
    }
  } else {
    normalized = 'http://' + normalized;
  }
  normalized = normalized.replace(/\/+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { valid: false, url: '', error: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, url: '', error: 'Only HTTP and HTTPS protocols are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // SSRF Protection: Block cloud metadata endpoints & link-local addresses
  const blockedHostnames = [
    '169.254.169.254',
    'metadata.google.internal',
    '100.100.100.200',
    '169.254.169.253',
    'instance-data',
  ];
  if (blockedHostnames.includes(hostname) || hostname.endsWith('.metadata.google.internal')) {
    return { valid: false, url: '', error: 'Access to cloud metadata endpoints is prohibited' };
  }

  // Block IPv4 link-local (169.254.0.0/16)
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return { valid: false, url: '', error: 'Access to link-local IPv4 addresses is prohibited' };
  }

  // Block IPv6 link-local and unique local
  if (
    hostname.startsWith('fe80:') ||
    hostname.startsWith('fd00:') ||
    hostname.startsWith('[fe80:') ||
    hostname.startsWith('[fd00:')
  ) {
    return { valid: false, url: '', error: 'Access to link-local/unique-local IPv6 addresses is prohibited' };
  }

  // Dangerous non-HTTP ports
  if (parsed.port) {
    const port = parseInt(parsed.port, 10);
    const blockedPorts = [21, 22, 23, 25, 53, 69, 110, 119, 123, 143, 161, 194, 445];
    if (blockedPorts.includes(port)) {
      return { valid: false, url: '', error: `Port ${port} is not allowed` };
    }
  }

  return { valid: true, url: normalized };
}

/** Expand platform-specific path variables (~ on Unix, %USERPROFILE% on Windows). Pure function. */
export function expandPath(p: string): string {
  if (!p) return '';
  if (process.platform === 'win32') {
    return p.replace(/%USERPROFILE%/g, process.env.USERPROFILE || '');
  } else {
    return p.replace(/^~/, process.env.HOME || '');
  }
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
    epic: t.epic === true,
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
