/**
 * Pure utility functions for the Electron main process.
 * These functions have no Electron or filesystem dependencies and can be
 * unit tested in any JavaScript environment.
 */

import { type FileManifest } from '@dune/shared';
import { diffFingerprints, changedPaths } from '@dune/shared';
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

/** Normalize a URL, throwing if invalid. Pure function. */
export function normalizeUrl(url: string): string {
  const check = validateServerUrl(url);
  if (!check.valid) {
    throw new Error(check.error || 'Invalid server URL');
  }
  return check.url;
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

/** Sanitize game input from the renderer. Pure function. */
export function sanitizeGame(input: unknown): {
  name: string;
  winPath: string;
  linPath: string;
  lastSync: string;
  status: 'In Sync' | 'Pending Upload' | 'Error';
  thumbnail: string;
} {
  const g = (input ?? {}) as Record<string, unknown>;
  const name = asString(g.name, 200).trim();
  if (!name) throw new Error('Game title is required');
  const status = asString(g.status, 32);
  return {
    name,
    winPath: asString(g.winPath),
    linPath: asString(g.linPath),
    lastSync: asString(g.lastSync, 64) || 'Never',
    status: ['Pending Upload', 'In Sync', 'Error'].includes(status)
      ? status as 'In Sync' | 'Pending Upload' | 'Error'
      : 'Pending Upload',
    thumbnail: asString(g.thumbnail),
  };
}

/** Sanitize settings input from the renderer. Pure function. */
export function sanitizeSettings(input: unknown, fallback: unknown): {
  runInBackground: boolean;
  autoSyncEnabled: boolean;
  autoSyncFreq: string;
  steamGridDbKey: string;
  scanRoots: string[];
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
    steamGridDbKey: asString(s.steamGridDbKey, 500),
    scanRoots,
  };
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

/** Plan an upload by diffing local files against the last uploaded manifest. */
export function planUpload(
  game: string,
  files: { local: string; rel: string }[],
  getSyncStateFn: () => SyncStateRecord
): UploadPlan {
  const localManifest = buildLocalManifest(files);
  const delta = diffFingerprints(getSyncStateFn()[game]?.uploaded || {}, localManifest);
  const wanted = new Set(changedPaths(delta));
  const plan = files
    .map(f => ({ game, rel: toPosix(f.rel), local: f.local }))
    .filter(f => wanted.has(f.rel));
  const deleted = files.length > 0 ? diffFingerprints(getSyncStateFn()[game]?.uploaded || {}, localManifest).deleted : [];
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
/** Simple glob matcher for backup profile include/exclude rules. */
export function matchesBackupGlob(relPath: string, pattern: string): boolean {
  const normalizedPath = relPath.replace(/\\/g, '/');
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern || normalizedPattern === '*' || normalizedPattern === '**' || normalizedPattern === '**/*') {
    return true;
  }

  const regex = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regex}$`, 'i').test(normalizedPath);
}

export function filterBackupFiles<T extends { rel: string }>(
  files: T[],
  profile: { includeGlobs: string[]; excludeGlobs: string[] },
): T[] {
  return files.filter((file) => {
    const included = profile.includeGlobs.some((pattern) => matchesBackupGlob(file.rel, pattern));
    const excluded = profile.excludeGlobs.some((pattern) => matchesBackupGlob(file.rel, pattern));
    return included && !excluded;
  });
}
