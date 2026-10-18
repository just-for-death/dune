import * as path from 'path';
import * as fs from 'fs';

/**
 * Base directory for all runtime data. Overridable via DATA_DIR env
 * (tests point it at a temp dir; production uses ./data or the
 * mounted volume). Always call lazily — never cache at module load —
 * so env changes and test isolation work.
 */
export function dataDir(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function savesDir(): string {
  return path.join(dataDir(), 'saves');
}

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

export function normalizeUrl(url: string): string {
  if (!url) return '';
  const check = validateServerUrl(url);
  if (!check.valid) {
    throw new Error(check.error || 'Invalid server URL');
  }
  return check.url;
}

export function getGameRoot(gameName: string, ownerId?: string): string {
  const safeName = path.basename(gameName).replace(/[<>:"|?*]/g, '_').replace(/\.\./g, '');
  if (ownerId) {
    const safeOwner = path.basename(ownerId).replace(/[<>:"|?*]/g, '_').replace(/\.\./g, '');
    return path.join(savesDir(), safeOwner, safeName);
  }
  return path.join(savesDir(), safeName);
}

export function validateGamePath(gameName: string, requestedPath: string, ownerId?: string): string {
  const gameRoot = getGameRoot(gameName, ownerId);
  const safePath = requestedPath.replace(/^(\.\.(\/|\\|$))+/g, '').replace(/[<>:"|?*]/g, '_');
  const finalPath = path.join(gameRoot, safePath);
  
  const resolvedFinal = path.resolve(finalPath);
  const resolvedRoot = path.resolve(gameRoot);

  // Compare against the root *plus* a separator: a bare startsWith would also
  // accept a sibling whose name shares the prefix (e.g. /saves/Game vs
  // /saves/Game-evil).
  if (resolvedFinal !== resolvedRoot && !resolvedFinal.startsWith(resolvedRoot + path.sep)) {
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
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Skip inaccessible directories
      return;
    }
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
