import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';
import {
  createSaveResolver,
  loadManifest,
  prefixUserDirs,
  toSaveFields,
  type LoadManifestOptions,
  type SaveResolver,
} from './savePaths.js';

export interface DetectedGame {
  id: number;
  name: string;
  winPath: string;
  linPath: string;
  status: 'Pending Upload' | 'In Sync' | 'Error';
  lastSync: string;
}

export interface AutoDetectOptions extends LoadManifestOptions {
  /** Pre-built resolver (skips manifest loading). */
  resolver?: SaveResolver;
}

/**
 * Manifest-driven save discovery: every Ludusavi game whose save path exists
 * on disk. This finds *saves*, not the Steam library (see getSteamLibraryGames).
 */
export async function autoDetectGames(customRoots: string[] = [], options: AutoDetectOptions = {}): Promise<DetectedGame[]> {
  try {
    let resolver = options.resolver;
    if (!resolver) {
      const manifest = await loadManifest(options);
      if (!manifest) return [];
      resolver = createSaveResolver(manifest, { customRoots });
    }
    return resolver.discoverAll().map(({ name, path: savePath }) => ({
      id: nextId(),
      name,
      ...toSaveFields(savePath, resolver.platform),
      status: 'Pending Upload' as const,
      lastSync: 'Never',
    }));
  } catch (error) {
    console.error('Scanner failed:', error);
    return [];
  }
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
    return [{ path: steamPath, label: 'Default' }];
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
    return [{ path: steamPath, label: 'Default' }];
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
  // Real Steam files put the section name and its `{` on separate lines.
  let pendingKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    if (trimmed.endsWith('{')) {
      const inlineKey = trimmed.slice(0, -1).trim().replace(/"/g, '');
      const key = inlineKey || pendingKey || '';
      pendingKey = null;
      const newObj: VdfObject = {};
      currentObj[key] = newObj;
      stack.push(newObj);
      currentObj = newObj;
    } else if (trimmed === '}') {
      pendingKey = null;
      stack.pop();
      currentObj = stack[stack.length - 1] || result;
    } else {
      const match = trimmed.match(/"([^"]+)"\s*"([^"]*)"/);
      if (match) {
        currentObj[match[1]] = match[2].replace(/\\\\/g, '\\');
        pendingKey = null;
      } else {
        const keyOnly = trimmed.match(/^"([^"]+)"$/);
        pendingKey = keyOnly ? keyOnly[1] : null;
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

export interface SteamLibraryGame extends SteamGameInfo {
  /** Library root (folder containing `steamapps`). */
  libraryPath: string;
  /** `<library>/steamapps/common/<installdir>` */
  installPath: string;
}

/** Installed Steam games with the library each one lives in. */
export function getInstalledSteamLibraryGames(steamPath: string): SteamLibraryGame[] {
  const out: SteamLibraryGame[] = [];
  const seen = new Set<string>();
  for (const library of getSteamLibraryFolders(steamPath)) {
    const steamappsPath = path.join(library.path, 'steamapps');
    let files: string[];
    try {
      files = fs.readdirSync(steamappsPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith('appmanifest_') || !file.endsWith('.acf')) continue;
      let info: SteamGameInfo | null;
      try {
        info = parseAppManifest(fs.readFileSync(path.join(steamappsPath, file), 'utf-8'));
      } catch {
        info = null;
      }
      if (!info || seen.has(info.appId)) continue;
      seen.add(info.appId);
      out.push({
        ...info,
        libraryPath: library.path,
        installPath: info.installDir ? path.join(steamappsPath, 'common', info.installDir) : '',
      });
    }
  }
  return out;
}

/** Proton prefix user dirs for an app (`steamapps/compatdata/<id>/pfx/drive_c/users/*`). */
export function getProtonUserDirs(libraryPath: string, appId: string): string[] {
  return prefixUserDirs(path.join(libraryPath, 'steamapps', 'compatdata', appId, 'pfx'));
}

/**
 * The Steam source: installed library games (steamAppId + installPath set),
 * with winPath/linPath resolved from the save manifest or left empty.
 */
export function getSteamLibraryGames(resolver: SaveResolver | null, steamPath: string | null = getSteamPath()): Game[] {
  if (!steamPath) return [];
  const now = new Date().toISOString();
  return getInstalledSteamLibraryGames(steamPath).map((g) => {
    const savePath = resolver
      ? resolver.resolve({
          name: g.name,
          steamAppId: g.appId,
          installPath: g.installPath || undefined,
          extraRoots: getProtonUserDirs(g.libraryPath, g.appId),
          tokens: { root: g.libraryPath, game: g.installDir || undefined, storeGameId: g.appId },
        })
      : '';
    return {
      id: nextId(),
      name: g.name,
      ...toSaveFields(savePath, resolver?.platform ?? process.platform),
      installPath: g.installPath,
      steamAppId: g.appId,
      lastSync: 'Never',
      status: 'Pending Upload' as const,
      thumbnail: '',
      source: 'steam' as const,
      sourceId: 'steam',
      createdAt: now,
      updatedAt: now,
    };
  });
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