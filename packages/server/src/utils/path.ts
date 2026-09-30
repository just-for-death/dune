import * as path from 'path';
import * as fs from 'fs';

const SAVES_DIR = path.join(process.cwd(), 'data', 'saves');

export function normalizeUrl(url: string): string {
  if (!url) return '';
  let normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = 'http://' + normalized;
  }
  return normalized.replace(/\/+$/, '');
}

export function getGameRoot(gameName: string): string {
  const safeName = path.basename(gameName).replace(/[<>:"|?*]/g, '_').replace(/\.\./g, '');
  return path.join(SAVES_DIR, safeName);
}

export function validateGamePath(gameName: string, requestedPath: string): string {
  const gameRoot = getGameRoot(gameName);
  const safePath = requestedPath.replace(/^(\.\.(\/|\\|$))+/g, '').replace(/[<>:"|?*]/g, '_');
  const finalPath = path.join(gameRoot, safePath);
  
  const resolvedFinal = path.resolve(finalPath);
  const resolvedRoot = path.resolve(gameRoot);
  
  if (!resolvedFinal.startsWith(resolvedRoot)) {
    throw new Error('Forbidden path: path traversal attempt detected');
  }
  
  return finalPath;
}

export function getFileCategory(relPath: string): 'Save' | 'Config' | 'Cache' | 'Other' {
  const ext = path.extname(relPath).toLowerCase();
  const fileName = path.basename(relPath).toLowerCase();
  const dirName = path.dirname(relPath).toLowerCase();

  if (dirName.includes('cache') || fileName.includes('cache') || ext === '.tmp' || ext === '.log') {
    return 'Cache';
  }
  if (ext === '.ini' || ext === '.cfg' || ext === '.xml' || ext === '.json' || ext === '.yaml' || ext === '.yml') {
    return 'Config';
  }
  if (ext === '.sav' || ext === '.bin' || ext === '.dat' || fileName.includes('save') || fileName.includes('prof')) {
    return 'Save';
  }
  return 'Other';
}

export function getFileMetadata(root: string, relPath: string): { path: string; name: string; size: number; modified: string; category: 'Save' | 'Config' | 'Cache' | 'Other' } | null {
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
