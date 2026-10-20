import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { FileFingerprint } from '@dune/shared';
import { getGameRoot, resolveGameFile } from '../utils/path.js';
import { logger } from '../middleware/logging.js';

export interface ManifestEntry extends FileFingerprint {
  path: string;
  hash: string;
}

// Content hashing is the expensive part of a manifest, so cache it keyed by
// (size, mtime): a file only re-hashes when it actually changed. Writes through
// the API invalidate by game, so an in-place overwrite with identical
// size+mtime can never serve a stale hash.
const hashCache = new Map<string, FileFingerprint & { hash: string }>();

function fingerprint(absPath: string): (FileFingerprint & { hash: string }) | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    const size = stat.size;
    const mtimeMs = Math.round(stat.mtimeMs);
    const cached = hashCache.get(absPath);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    const entry = { size, mtimeMs, hash };
    hashCache.set(absPath, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Walk a game's save tree (anything under `saves/<ownerId>/<gameId>`, excluding the
 * `.versions` history and symlinks) and fingerprint every file. Paths are
 * relative to the game root and use the platform separator, matching the
 * `x-path` values the client uploads with.
 */
export function manifestForGame(gameId: number, ownerId: string): ManifestEntry[] {
  const root = getGameRoot(gameId, ownerId);
  if (!fs.existsSync(root)) return [];

  const entries: ManifestEntry[] = [];
  const walk = (dir: string, rel: string): void => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name === '.versions') continue;
      if (item.isSymbolicLink()) continue;
      const abs = path.join(dir, item.name);
      const relPath = rel ? path.join(rel, item.name) : item.name;
      if (item.isDirectory()) {
        walk(abs, relPath);
      } else {
        const fp = fingerprint(abs);
        if (fp) entries.push({ path: relPath, ...fp });
      }
    }
  };
  walk(root, '');
  return entries;
}

/**
 * Drop cached hashes for a game after its files are written/removed. Clears the
 * whole subtree so zip extraction (which can restore original mtimes) can't
 * leave a stale entry behind.
 */
export function invalidateGame(gameId: number, ownerId: string): void {
  let prefix: string;
  try {
    prefix = getGameRoot(gameId, ownerId) + path.sep;
  } catch {
    return; // invalid id/owner: no folder, so nothing can be cached for it
  }
  for (const key of hashCache.keys()) {
    if (key.startsWith(prefix)) hashCache.delete(key);
  }
}

/** Test hook: forget all cached hashes. */
export function clearManifestCache(): void {
  hashCache.clear();
}

/**
 * Delete a single file inside a game's save tree (DUN-086). `relPath` is the
 * raw client value: it is validated here (shared lexical rules, no symlinks,
 * strictly inside the game root) and only the validated absolute path is
 * used. Throws PathRuleError for a rejected path (callers answer 400);
 * returns false when the file does not exist or is not a regular file.
 */
export function removeGameFile(gameId: number, relPath: string, ownerId: string): boolean {
  const { abs, rel } = resolveGameFile(gameId, relPath, ownerId);
  try {
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return false;
    fs.rmSync(abs);
    hashCache.delete(abs);
    logger.info({ gameId, path: rel }, 'Removed save file');
    return true;
  } catch (err) {
    logger.warn({ err, gameId, path: rel }, 'Failed to remove save file');
    return false;
  }
}
