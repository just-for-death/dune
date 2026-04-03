import axios from 'axios';
import YAML from 'yaml';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app } from 'electron';

const MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';

// Cache the manifest on disk so we don't re-fetch 4MB on every scan.
// TTL: 24 hours. If the cache is fresh, use it; otherwise re-download.
const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

function getManifestCachePath(): string {
  return path.join(app.getPath('userData'), 'ludusavi-manifest.yaml');
}

async function fetchManifest(): Promise<string> {
  const cachePath = getManifestCachePath();

  // Check if the cached file exists and is fresh enough
  if (fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs < MANIFEST_TTL_MS) {
      return fs.readFileSync(cachePath, 'utf-8');
    }
  }

  // Download and cache
  const response = await axios.get(MANIFEST_URL, { timeout: 30000 });
  fs.writeFileSync(cachePath, response.data, 'utf-8');
  return response.data;
}

// Translate ludusavi placeholders to real JS os counterparts
function translatePath(template: string): string {
  let mapped = template;
  const home = os.homedir();

  const replacements: Record<string, string> = {
    '<home>':             home,
    '<userProfile>':      home,
    '<winAppData>':       process.env.APPDATA       || path.join(home, 'AppData', 'Roaming'),
    '<winLocalAppData>':  process.env.LOCALAPPDATA  || path.join(home, 'AppData', 'Local'),
    '<winDocuments>':     path.join(home, 'Documents'),
    '<winPublic>':        process.env.PUBLIC        || 'C:\\Users\\Public',
    '<winProgramFiles>':  process.env.ProgramFiles  || 'C:\\Program Files',
    '<winProgramFilesX86>': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    '<osUserName>':       process.env.USERNAME || process.env.USER || 'User',
    '<steam>':            process.platform === 'win32'
      ? 'C:\\Program Files (x86)\\Steam'
      : path.join(home, '.steam', 'steam'),
  };

  for (const [token, value] of Object.entries(replacements)) {
    mapped = mapped.split(token).join(value);
  }

  return path.normalize(mapped);
}

function translatePathOverride(template: string, root: string): string {
  let mapped = template;
  const replacements: Record<string, string> = {
    '<home>':             root,
    '<winAppData>':       path.join(root, 'AppData', 'Roaming'),
    '<winLocalAppData>':  path.join(root, 'AppData', 'Local'),
    '<winDocuments>':     path.join(root, 'Documents'),
    '<winPublic>':        path.join(root, '..', 'Public'),
    '<winProgramFiles>':  path.join(root, '..', '..', 'Program Files'),
    '<winProgramFilesX86>': path.join(root, '..', '..', 'Program Files (x86)'),
    '<steam>':            path.join(root, '..', '..', 'Program Files (x86)', 'Steam'),
    '<osUserName>':       process.env.USERNAME || process.env.USER || 'User',
  };
  for (const [token, value] of Object.entries(replacements)) {
    mapped = mapped.split(token).join(value);
  }
  return path.normalize(mapped);
}

function expandCustomRoots(customRoots: string[]) {
  const expanded: string[] = [];
  for (const root of customRoots) {
    expanded.push(root);

    // Wine Prefix Container Auto-Detection logic
    if (process.platform !== 'win32') {
      try {
        const items = fs.readdirSync(root, { withFileTypes: true });
        for (const item of items) {
          if (!item.isDirectory()) continue;
          const basePrefix = path.join(root, item.name, 'drive_c', 'users');
          if (fs.existsSync(basePrefix)) {
            for (const un of ['steamuser', 'lutrisuser', process.env.USER || '']) {
              if (!un) continue;
              const userDir = path.join(basePrefix, un);
              if (fs.existsSync(userDir)) expanded.push(userDir);
            }
          }
        }
      } catch { /* skip inaccessible directories */ }
    }
  }
  return expanded;
}

export async function autoDetectGames(customRoots: string[] = []) {
  const discovered: {
    id: number;
    name: string;
    winPath: string;
    linPath: string;
    status: string;
    lastSync: string;
  }[] = [];

  try {
    // Use cached manifest — avoids 4MB download on every scan
    const rawManifest = await fetchManifest();
    const manifest = YAML.parse(rawManifest);

    if (!manifest) return [];

    const activeRoots = expandCustomRoots(customRoots);

    for (const [gameName, gameData] of Object.entries<any>(manifest)) {
      if (!gameData.files) continue;

      let validPath = '';

      for (const template of Object.keys(gameData.files)) {
        const rawTrans = translatePath(template);
        if (fs.existsSync(rawTrans)) {
          validPath = rawTrans;
          break;
        }

        for (const root of activeRoots) {
          const overrideTrans = translatePathOverride(template, root);
          if (fs.existsSync(overrideTrans)) {
            validPath = overrideTrans;
            break;
          }
        }
        if (validPath) break;
      }

      if (validPath) {
        discovered.push({
          id: Date.now() + Math.random(),
          name: gameName,
          winPath: process.platform === 'win32' ? validPath : '',
          linPath: process.platform !== 'win32' ? validPath : '',
          status: 'Pending Upload',
          lastSync: 'Never'
        });
      }
    }

    return discovered;
  } catch (error) {
    console.error('Scanner failed:', error);
    return [];
  }
}
