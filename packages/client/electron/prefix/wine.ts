import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BackupPrefixResult, CreatePrefixResult, DeletePrefixResult } from '@dune/shared';
import type { PrefixRegistry } from './registry.js';

export interface WinePrefix {
  name: string;
  path: string;
  valid: boolean;
  sizeBytes: number;
}

export function getWinePrefixRoots(): string[] {
  const value = process.env.WINE_PREFIX_ROOTS;
  if (value) return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const home = os.homedir();
  return [
    path.join(home, '.wine'),
    path.join(home, '.local', 'share', 'wineprefixes'),
    path.join(home, '.var', 'app', 'com.heroicgameslauncher.hgl', 'data', 'wine', 'prefixes'),
  ];
}

export function isWinePrefix(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'drive_c')) || fs.existsSync(path.join(dir, 'system.reg'));
}

export function scanPrefixSize(dir: string): number {
  let bytes = 0;
  if (!fs.existsSync(dir)) return bytes;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // Ignore unreadable files.
        }
      }
    }
  }
  return bytes;
}

export function listWinePrefixes(roots: string[] = getWinePrefixRoots()): WinePrefix[] {
  const prefixes: WinePrefix[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (isWinePrefix(root)) {
      prefixes.push({ name: path.basename(root), path: root, valid: true, sizeBytes: scanPrefixSize(root) });
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const prefixPath = path.join(root, entry.name);
      if (isWinePrefix(prefixPath)) {
        prefixes.push({ name: entry.name, path: prefixPath, valid: true, sizeBytes: scanPrefixSize(prefixPath) });
      }
    }
  }
  return prefixes;
}

// DUN-062: the old path-taking create/delete/backup (a forced recursive rmSync
// on whatever path the renderer sent) are gone. Writes and deletes only go
// through the prefix registry, which takes a validated name or a registry id
// and builds/checks every path under the managed root itself. These wrappers
// keep the names manager.ts re-exports; none of them accepts a path.

/** Create a Dune-managed prefix named `name` under the registry's managed root. */
export function createWinePrefix(registry: PrefixRegistry, name: string): CreatePrefixResult {
  return registry.create(name);
}

/** Move the Dune-managed prefix `id` to the OS trash. */
export function deleteWinePrefix(registry: PrefixRegistry, id: string): Promise<DeletePrefixResult> {
  return registry.delete(id);
}

/** Back up the Dune-managed prefix `id` into the registry's backups folder. */
export function backupWinePrefix(registry: PrefixRegistry, id: string): BackupPrefixResult {
  return registry.backup(id);
}
