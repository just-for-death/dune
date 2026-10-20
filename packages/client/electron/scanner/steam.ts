import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { nextId } from '@dune/shared';

import axios from 'axios';
import YAML from 'yaml';

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

function expandCustomRoots(customRoots: string[]): string[] {
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
      } catch {
        // Skip inaccessible directories
      }
    }
  }
  return expanded;
}

export interface DetectedGame {
  id: number;
  name: string;
  winPath: string;
  linPath: string;
  status: 'Pending Upload' | 'In Sync' | 'Error';
  lastSync: string;
}

/** Top-level shape of the Ludusavi manifest: game name -> entry. */
type LudusaviManifest = Record<string, { files?: Record<string, unknown> } | undefined>;

export async function autoDetectGames(customRoots: string[] = []): Promise<DetectedGame[]> {
  const discovered: DetectedGame[] = [];

  try {
    // Use cached manifest — avoids 4MB download on every scan
    const rawManifest = await fetchManifest();
    const manifest = YAML.parse(rawManifest) as LudusaviManifest | null;

    if (!manifest) return [];

    const activeRoots = expandCustomRoots(customRoots);

    for (const [gameName, gameData] of Object.entries(manifest)) {
      if (!gameData?.files) continue;

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
          id: nextId(),
          name: gameName,
          winPath: process.platform === 'win32' ? validPath : '',
          linPath: process.platform !== 'win32' ? validPath : '',
          status: 'Pending Upload',
          lastSync: 'Never',
        });
      }
    }
  } catch (error) {
    console.error('Scanner failed:', error);
    return [];
  }

  return discovered;
}

export interface SteamLibraryFolder {
  path: string;
  label?: string;
}

export interface SteamLibraryConfig {
  libraryfolders: Record<string, SteamLibraryFolder>;
}

export interface SteamGameInfo {
  appId: string;
  name: string;
  installDir: string;
  sizeOnDisk?: number;
  lastUpdated?: number;
  buildId?: string;
  autoUpdateBehavior?: number;
  allowOtherDownloadsWhileRunning?: boolean;
}

/**
 * Get the Steam installation path based on platform.
 */
export function getSteamPath(): string | null {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Steam') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Steam') : null,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'steam.exe'))) {
        return candidate;
      }
    }
  } else if (process.platform === 'darwin') {
    const candidates = [
      path.join(os.homedir(), 'Library', 'Application Support', 'Steam'),
      '/Applications/Steam.app/Contents/MacOS',
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } else {
    const candidates = [
      path.join(os.homedir(), '.local', 'share', 'Steam'),
      path.join(os.homedir(), '.steam', 'steam'),
      path.join(os.homedir(), '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
      '/usr/lib/steam',
      '/opt/steam',
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Parse libraryfolders.vdf to get all Steam library folders.
 */
export function getSteamLibraryFolders(steamPath: string): SteamLibraryFolder[] {
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (!fs.existsSync(vdfPath)) {
    return [{ path: path.join(steamPath, 'steamapps'), label: 'Default' }];
  }

  try {
    const content = fs.readFileSync(vdfPath, 'utf-8');
    const parsed = parseVDF(content);

    if (!parsed.libraryfolders) return [];

    const folders: SteamLibraryFolder[] = [];
    for (const [key, folder] of Object.entries(parsed.libraryfolders)) {
      if (typeof folder !== 'object' || folder === null) continue;
      const folderPath = folder.path;
      if (typeof folderPath === 'string') {
        const label = typeof folder.label === 'string' ? folder.label : `Library ${key}`;
        folders.push({
          path: folderPath,
          label,
        });
      }
    }
    return folders;
  } catch (error) {
    console.error('Failed to parse libraryfolders.vdf:', error);
    return [{ path: path.join(steamPath, 'steamapps'), label: 'Default' }];
  }
}

type VdfObject = { [key: string]: string | VdfObject };

/**
 * Parse VDF (Valve Data Format) text into a JavaScript object.
 * Simplified parser for libraryfolders.vdf format.
 */
function parseVDF(content: string): VdfObject {
  const result: VdfObject = {};
  const lines = content.split('\n');
  let currentObj: VdfObject = result;
  const stack: VdfObject[] = [result];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.endsWith('{')) {
      const key = trimmed.slice(0, -1).trim().replace(/"/g, '');
      const newObj: VdfObject = {};
      currentObj[key] = newObj;
      stack.push(newObj);
      currentObj = newObj;
    } else if (trimmed === '}') {
      stack.pop();
      currentObj = stack[stack.length - 1] || result;
    } else {
      const match = trimmed.match(/"([^"]+)"\s*"([^"]*)"/);
      if (match) {
        currentObj[match[1]] = match[2];
      }
    }
  }
  return result;
}

/**
 * Parse appmanifest.acf file to extract game info.
 */
export function parseAppManifest(content: string): SteamGameInfo | null {
  try {
    const lines = content.split('\n');
    const data: {
      appId?: string;
      name?: string;
      installDir?: string;
      sizeOnDisk?: number;
      lastUpdated?: number;
      buildId?: string;
      autoUpdateBehavior?: number;
      allowOtherDownloadsWhileRunning?: boolean;
    } = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.endsWith('{')) {
        // Skip nested objects for now
      } else if (trimmed === '}') {
        // End of object
      } else {
        const match = trimmed.match(/"([^"]+)"\s*"([^"]*)"/);
        if (match) {
          const [, keyName, value] = match;
          const key = keyName.toLowerCase();
          if (key === 'appid') data.appId = value;
          else if (key === 'name') data.name = value;
          else if (key === 'installdir') data.installDir = value;
          else if (key === 'sizeondisk') data.sizeOnDisk = parseInt(value, 10);
          else if (key === 'lastupdated') data.lastUpdated = parseInt(value, 10);
          else if (key === 'buildid') data.buildId = value;
          else if (key === 'autoupdatebehavior') data.autoUpdateBehavior = parseInt(value, 10);
          else if (key === 'allowotherdownloadswhilerunning') data.allowOtherDownloadsWhileRunning = value === '1';
        }
      }
    }

    if (data.appId && data.name) {
      return {
        appId: data.appId,
        name: data.name,
        installDir: data.installDir || '',
        sizeOnDisk: data.sizeOnDisk,
        lastUpdated: data.lastUpdated,
        buildId: data.buildId,
        autoUpdateBehavior: data.autoUpdateBehavior,
        allowOtherDownloadsWhileRunning: data.allowOtherDownloadsWhileRunning,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get all installed Steam games by scanning all library folders.
 */
export function getInstalledSteamGames(steamPath: string): SteamGameInfo[] {
  try {
    const libraries = getSteamLibraryFolders(steamPath);
    const games: SteamGameInfo[] = [];

    for (const library of libraries) {
      const steamappsPath = path.join(library.path, 'steamapps');
      if (!fs.existsSync(steamappsPath)) continue;

      try {
        const files = fs.readdirSync(steamappsPath);
        for (const file of files) {
          if (file.startsWith('appmanifest_') && file.endsWith('.acf')) {
            const filePath = path.join(steamappsPath, file);
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              const game = parseAppManifest(content);
              if (game) {
                games.push(game);
              }
            } catch {
              // Best-effort guard only; never block uploads on counting errors
            }
          }
        }
      } catch {
        // Best-effort guard only; never block uploads on counting errors
      }
    }

    return games;
  } catch (error) {
    console.error('Failed to get installed Steam games:', error);
    return [];
  }
}

/**
 * Get the installation path for a specific Steam game.
 */
export function getSteamGamePath(steamPath: string, appId: string): string | null {
  try {
    const libraries = getSteamLibraryFolders(steamPath);

    for (const library of libraries) {
      const manifestPath = path.join(library.path, 'steamapps', `appmanifest_${appId}.acf`);
      if (fs.existsSync(manifestPath)) {
        try {
          const content = fs.readFileSync(manifestPath, 'utf-8');
          const game = parseAppManifest(content);
          if (game && game.installDir) {
            // Find which library folder contains this game
            for (const lib of libraries) {
              const gamePath = path.join(lib.path, 'steamapps', 'common', game.installDir);
              if (fs.existsSync(gamePath)) {
                return gamePath;
              }
            }
            // Fallback: check default steamapps/common
            const fallbackPath = path.join(steamPath, 'steamapps', 'common', game.installDir);
            if (fs.existsSync(fallbackPath)) return fallbackPath;
          }
        } catch (error) {
          console.warn(`Failed to parse manifest for ${appId}:`, error);
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Failed to get Steam game path:', error);
    return null;
  }
}

/**
 * Get all Steam library folder paths (for scanning).
 */
export function getSteamLibraryPaths(steamPath: string): string[] {
  const libraries = getSteamLibraryFolders(steamPath);
  return libraries.map(lib => path.join(lib.path, 'steamapps', 'common'));
}

/**
 * Check if a path is a valid Steam installation.
 */
export function isValidSteamPath(steamPath: string): boolean {
  return fs.existsSync(steamPath) && fs.existsSync(path.join(steamPath, 'steam.exe'));
}