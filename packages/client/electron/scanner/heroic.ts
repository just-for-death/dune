import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';

export interface HeroicGame {
  id: string;
  title: string;
  appName: string;
  platform: 'gog' | 'epic' | 'amazon';
  installPath: string;
  installPathWindows?: string;
  installPathLinux?: string;
  isInstalled: boolean;
  version?: string;
  executable?: string;
  installPathOverride?: string;
  prefixPath?: string;
  wineVersion?: string;
  useSystemWine?: boolean;
  envVars?: Record<string, string>;
  launchOptions?: string;
  lastPlayed?: string;
  playtime?: number;
  artwork?: {
    cover?: string;
    background?: string;
    logo?: string;
    icon?: string;
  };
}

export type HeroicGameLike = Pick<HeroicGame, 'id' | 'title'> &
  Partial<Pick<HeroicGame, 'prefixPath' | 'wineVersion'>>;

export interface HeroicConfig {
  games: HeroicGame[];
  settings?: {
    downloadPath?: string;
    winePrefixesPath?: string;
    wineVersionsPath?: string;
    gogUsername?: string;
    epicUsername?: string;
    amazonUsername?: string;
  };
}

/**
 * Get Heroic configuration directory based on platform and installation type.
 */
export function getHeroicConfigDir(): string | null {
  if (process.platform === 'win32') {
    // Windows - check AppData
    const candidates = [
      path.join(process.env.APPDATA || '', 'Heroic'),
      path.join(process.env.LOCALAPPDATA || '', 'Heroic'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'config.json'))) return candidate;
    }
  } else if (process.platform === 'darwin') {
    // macOS
    const candidates = [
      path.join(os.homedir(), 'Library', 'Application Support', 'Heroic'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'config.json'))) return candidate;
    }
  } else {
    // Linux - check native, Flatpak, AppImage
    const candidates = [
      path.join(os.homedir(), '.config', 'heroic'),
      path.join(os.homedir(), '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic'), // Flatpak
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'config.json'))) return candidate;
    }
    
    // Check AppImage portable config (next to AppImage)
    try {
      const appImageDir = path.dirname(app.getPath('exe'));
      const portableConfig = path.join(appImageDir, 'heroic-config');
      if (fs.existsSync(path.join(portableConfig, 'config.json'))) return portableConfig;
    } catch { /* ignore */ }
  }
  
  return null;
}

/**
 * Read Heroic configuration file.
 */
export function getHeroicConfig(): HeroicConfig | null {
  const configDir = getHeroicConfigDir();
  if (!configDir) return null;

  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as HeroicConfig;
  } catch (e) {
    console.error('Failed to parse Heroic config:', e);
    return null;
  }
}

/**
 * Get all games from Heroic configuration.
 */
export function getHeroicGames(): Game[] {
  const config = getHeroicConfig();
  if (!config || !config.games) return [];

  return config.games
    .filter(g => g.isInstalled)
    .map(game => ({
      id: nextId(),
      name: game.title,
      winPath: game.installPathWindows || '',
      linPath: game.installPathLinux || game.installPath || '',
      lastSync: game.lastPlayed || 'Never',
      status: 'In Sync' as const,
      thumbnail: game.artwork?.cover || '',
      platform: game.platform,
      source: 'heroic',
      heroicId: game.id,
      executable: game.executable,
      installPathOverride: game.installPathOverride,
      prefixPath: game.prefixPath,
      winePrefix: game.prefixPath,
      wineVersion: game.wineVersion,
      useSystemWine: game.useSystemWine,
      envVars: game.envVars,
      launchOptions: game.launchOptions,
      lastPlayed: game.lastPlayed,
      playtime: game.playtime,
      artwork: game.artwork,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
}

/**
 * Get Heroic executable path.
 */
export function getHeroicExecutable(): string | null {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Heroic', 'Heroic.exe'),
      path.join(process.env.APPDATA || '', 'Heroic', 'Heroic.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Heroic Games Launcher', 'Heroic.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Heroic Games Launcher', 'Heroic.exe'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } else if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Heroic.app/Contents/MacOS/Heroic',
      path.join(os.homedir(), 'Applications', 'Heroic.app', 'Contents', 'MacOS', 'Heroic'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } else {
    // Linux - check Flatpak, AppImage, native
    const flatpak = 'flatpak run com.heroicgameslauncher.hgl';
    if (fs.existsSync('/usr/bin/flatpak')) return flatpak;
    
    // Check AppImage
    const appImagePaths = [
      '/opt/Heroic.AppImage',
      path.join(os.homedir(), 'Applications', 'Heroic.AppImage'),
      path.join(os.homedir(), '.local', 'bin', 'Heroic.AppImage'),
    ];
    for (const c of appImagePaths) if (fs.existsSync(c)) return c;
    
    // Native binary
    if (fs.existsSync('/usr/bin/heroic')) return 'heroic';
    if (fs.existsSync('/usr/local/bin/heroic')) return 'heroic';
  }
  return null;
}

/**
 * Get Heroic Wine prefix path for a game.
 */
export function getHeroicWinePrefix(game: HeroicGameLike): string | null {
  if (game.prefixPath && fs.existsSync(game.prefixPath)) {
    return game.prefixPath;
  }
  
  const configDir = getHeroicConfigDir();
  if (!configDir) return null;
  
  const settings = getHeroicConfig()?.settings;
  const prefixesPath = settings?.winePrefixesPath || path.join(os.homedir(), '.config', 'heroic', 'prefixes');
  
  // Heroic uses game ID for prefix folder
  if (fs.existsSync(path.join(prefixesPath, game.id))) {
    return path.join(prefixesPath, game.id);
  }
  
  // Try by game title
  const sanitized = game.title.replace(/[^a-zA-Z0-9]/g, '_');
  const byTitle = path.join(prefixesPath, sanitized);
  if (fs.existsSync(byTitle)) return byTitle;
  
  return null;
}

/**
 * Get Heroic Wine version for a game.
 */
export function getHeroicWineVersion(game: HeroicGameLike): string | null {
  if (game.wineVersion) return game.wineVersion;
  
  // Check Heroic's wine versions directory
  const configDir = getHeroicConfigDir();
  if (!configDir) return null;
  
  const settings = getHeroicConfig()?.settings;
  const winePath = settings?.wineVersionsPath || path.join(os.homedir(), '.config', 'heroic', 'wine');
  
  // Check for specific version
  if (fs.existsSync(path.join(winePath, 'versions', game.wineVersion || ''))) {
    return game.wineVersion || null;
  }
  
  return null;
}

/**
 * Get Heroic executable path for a game (for launching).
 */
export function getHeroicGameLaunchCommand(game: HeroicGameLike): string[] | null {
  const heroicExe = getHeroicExecutable();
  if (!heroicExe) return null;
  
  return [heroicExe, '--run', game.id];
}

/**
 * Check if Heroic is installed and configured.
 */
export function isHeroicAvailable(): boolean {
  return getHeroicConfigDir() !== null && getHeroicExecutable() !== null;
}