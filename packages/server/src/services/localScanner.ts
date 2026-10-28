import * as fs from 'fs';
import * as path from 'path';

const SAVE_EXTS = ['.sav', '.bin', '.dat', '.json', '.xml', '.cfg', '.ini', '.txt', '.sl2', '.prof', '.sqlite', '.db', '.rpgsave'];

export function isSaveCandidate(dirPath: string): boolean {
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    
    const hasSaveDir = files.some(f => f.isDirectory() && (f.name.toLowerCase().includes('save') || f.name.toLowerCase() === 'profiles'));
    if (hasSaveDir) return true;

    const hasSaveFile = files.some(f => {
      if (f.isDirectory()) return false;
      const ext = path.extname(f.name).toLowerCase();
      return SAVE_EXTS.includes(ext) || f.name.toLowerCase().includes('save') || f.name.toLowerCase().includes('prof');
    });
    
    if (files.length > 300) return false;
    
    return hasSaveFile;
  } catch {
    return false;
  }
}

export function findSaveFolders(rootPath: string, depth = 3): string[] {
  if (depth < 0) return [];
  
  const normalizedRoot = path.normalize(rootPath);
  const results: string[] = [];
  
  try {
    if (!fs.existsSync(normalizedRoot)) return [];
    const items = fs.readdirSync(normalizedRoot, { withFileTypes: true });
    
    if (isSaveCandidate(normalizedRoot)) {
      results.push(normalizedRoot);
    }

    for (const item of items) {
      if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
        const childPath = path.join(normalizedRoot, item.name);
        results.push(...findSaveFolders(childPath, depth - 1));
      }
    }
  } catch {
    // Skip inaccessible folders
  }
  
  // Drop any candidate that is an ancestor of another candidate: syncing both
  // would duplicate work and churn versions.
  const deduped = results.filter(r => !results.some(other => other !== r && other.startsWith(r + path.sep)));
  return [...new Set(deduped)];
}

export interface SyncResult {
  filesSynced: number;
  syncId: string;
}

/**
 * Mirror `sourcePath` into `targetDir`, the game's validated save root
 * (saves/<ownerId>/<gameId> from getGameRoot). The caller owns the mapping
 * from game to folder; nothing here derives a path from a title. Overwritten
 * files are copied to `.versions/<syncId>` first (one id per sync session,
 * DUN-097); pruning is the caller's job (saveVersions.pruneVersions).
 */
export function syncLocalFolder(sourcePath: string, targetDir: string, syncId: string = Date.now().toString()): SyncResult {
  // A relative target would resolve against cwd (e.g. packages/server).
  if (!path.isAbsolute(targetDir)) throw new Error(`syncLocalFolder: targetDir must be absolute, got ${targetDir}`);
  if (!/^\d{1,20}$/.test(syncId)) throw new Error('syncLocalFolder: syncId must be digits');
  const normalizedSource = path.normalize(sourcePath);
  let filesSynced = 0;

  const walk = (dir: string, rel = ''): void => {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isSymbolicLink()) continue;

      const sourceFile = path.join(dir, item.name);
      const relativePath = path.join(rel, item.name);
      const targetFile = path.join(targetDir, relativePath);

      if (item.isDirectory()) {
        walk(sourceFile, relativePath);
      } else {
        let shouldSync = true;
        if (fs.existsSync(targetFile)) {
          const sStats = fs.statSync(sourceFile);
          const tStats = fs.statSync(targetFile);
          if (sStats.mtimeMs <= tStats.mtimeMs && sStats.size === tStats.size) {
            shouldSync = false;
          }
        }

        if (shouldSync) {
          if (fs.existsSync(targetFile)) {
            const versionDir = path.join(targetDir, '.versions', syncId);
            const archivePath = path.join(versionDir, relativePath);
            if (!fs.existsSync(archivePath)) {
              fs.mkdirSync(path.dirname(archivePath), { recursive: true });
              fs.copyFileSync(targetFile, archivePath);
            }
          }

          if (!fs.existsSync(path.dirname(targetFile))) {
            fs.mkdirSync(path.dirname(targetFile), { recursive: true });
          }
          fs.copyFileSync(sourceFile, targetFile);
          filesSynced++;
        }
      }
    }
  };

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  walk(normalizedSource);

  return { filesSynced, syncId };
}

