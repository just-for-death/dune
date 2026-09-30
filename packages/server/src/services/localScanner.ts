import * as fs from 'fs';
import * as path from 'path';
import { getGameRoot, getFileCategory } from '../utils/path.js';

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
  
  return [...new Set(results)];
}

export interface SyncResult {
  filesSynced: number;
  syncId: string;
}

export function syncLocalFolder(sourcePath: string, gameName: string, savesDir: string, maxVersions = 10): SyncResult {
  const targetDir = path.join(savesDir, gameName);
  const syncId = Date.now().toString();
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
            if (!fs.existsSync(path.dirname(archivePath))) {
              fs.mkdirSync(path.dirname(archivePath), { recursive: true });
            }
            fs.copyFileSync(targetFile, archivePath);
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

  const versionsDir = path.join(targetDir, '.versions');
  if (fs.existsSync(versionsDir)) {
    const versions = fs.readdirSync(versionsDir)
      .filter(v => fs.statSync(path.join(versionsDir, v)).isDirectory())
      .sort((a, b) => parseInt(a) - parseInt(b));

    if (versions.length > maxVersions) {
      const toDelete = versions.slice(0, versions.length - maxVersions);
      toDelete.forEach(v => {
        fs.rmSync(path.join(versionsDir, v), { recursive: true, force: true });
      });
    }
  }

  return { filesSynced, syncId };
}

export function listFilesInDir(dirPath: string): Array<{ path: string; name: string; size: number; modified: string; category: 'Save' | 'Config' | 'Cache' | 'Other' }> {
  const files: Array<{ path: string; name: string; size: number; modified: string; category: 'Save' | 'Config' | 'Cache' | 'Other' }> = [];
  
  const walk = (dir: string, base: string): void => {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === '.versions') continue;
      if (item.isSymbolicLink()) continue;
      
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath, base);
      } else {
        const rel = path.relative(base, fullPath);
        const meta = getFileMetadata(base, rel);
        if (meta) files.push(meta);
      }
    }
  };
  
  walk(dirPath, dirPath);
  return files;
}

function getFileMetadata(root: string, relPath: string): { path: string; name: string; size: number; modified: string; category: 'Save' | 'Config' | 'Cache' | 'Other' } | null {
  try {
    const fullPath = path.join(root, relPath);
    if (!fs.existsSync(fullPath)) return null;
    const stats = fs.statSync(fullPath);
    return {
      path: relPath,
      name: path.basename(relPath),
      size: stats.size,
      modified: stats.mtime.toISOString(),
      category: getFileCategory(relPath)
    };
  } catch {
    return null;
  }
}
