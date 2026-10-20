import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';

export interface LutrisGame {
  id: number;
  slug: string;
  name: string;
  year?: number;
  developer?: string;
  publisher?: string;
  genre?: string;
  description?: string;
  executable?: string;
  wine_version?: string;
  wine_arch?: string;
  wine_prefix?: string;
  executable_args?: string;
  working_dir?: string;
  env_vars?: Record<string, string>;
  install_path?: string;
  platform?: string;
  system?: string;
  emulator?: string;
  runner?: string;
  version?: string;
  installed: boolean;
  installed_size?: number;
  last_played?: number | string | null;
  playtime?: number;
  cover_url?: string;
  banner_url?: string;
  logo_url?: string;
  icon_url?: string;
  created_at?: number | string | null;
  updated_at?: number | string | null;
}

export interface LutrisConfig {
  games_path?: string;
  wine_path?: string;
  prefixes_path?: string;
}

/**
 * Get Lutris data directory.
 */
export function getLutrisDataDir(): string | null {
  if (process.platform === 'win32') {
    return null; // Lutris doesn't run on Windows
  } else if (process.platform === 'darwin') {
    // macOS - Lutris not typically used on macOS
    return null;
  } else {
    // Linux
    const candidates = [
      path.join(os.homedir(), '.local', 'share', 'lutris'),
      path.join(os.homedir(), '.var', 'app', 'net.lutris.Lutris', 'data', 'lutris'), // Flatpak
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'pga.db'))) return candidate;
    }
  }
  return null;
}

/**
 * Get Lutris database connection.
 */
export function getLutrisDB(): DatabaseSync | null {
  const dataDir = getLutrisDataDir();
  if (!dataDir) return null;
  
  const dbPath = path.join(dataDir, 'pga.db');
  if (!fs.existsSync(dbPath)) return null;
  
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    console.error('Failed to open Lutris database:', e);
    return null;
  }
}

/**
 * Get all installed games from Lutris database.
 */
export function getLutrisGames(): LutrisGame[] {
  const db = getLutrisDB();
  if (!db) return [];

  try {
    const rows = db.prepare(`
      SELECT 
        id, slug, name, year, developer, publisher, genre, description,
        executable, wine_version, wine_arch, wine_prefix, executable_args,
        working_dir, env_vars, install_path, platform, system, emulator, runner,
        version, installed, installed_size, last_played, playtime,
        cover_url, banner_url, logo_url, icon_url, created_at, updated_at
      FROM games
      WHERE installed = 1
      ORDER BY name ASC
    `).all() as Array<Record<string, unknown>>;

    const toIso = (value: unknown): string | null =>
      typeof value === 'number' ? new Date(value * 1000).toISOString() : null;

    return rows.map((row) => ({
      ...row,
      env_vars: typeof row.env_vars === 'string'
        ? JSON.parse(row.env_vars) as Record<string, string>
        : {},
      last_played: toIso(row.last_played),
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    } as unknown as LutrisGame));
  } catch (e) {
    console.error('Failed to query Lutris games:', e);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Get Lutris executable path.
 */
export function getLutrisExecutable(): string | null {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return null; // Lutris doesn't run on Windows
  }
  
  // Check Flatpak first
  if (fs.existsSync('/usr/bin/flatpak')) {
    try {
      const result = execFileSync('flatpak', ['run', 'net.lutris.Lutris', '--version'], { encoding: 'utf-8', timeout: 5000 });
      if (result.trim()) return 'flatpak run net.lutris.Lutris';
    } catch { /* ignore */ }
    
    // Native binary
    const candidates = [
      '/usr/bin/lutris',
      '/usr/local/bin/lutris',
      '/usr/games/lutris',
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Get Lutris Wine prefix path for a game.
 */
export function getLutrisWinePrefix(game: Partial<LutrisGame>): string | null {
  if (game.wine_prefix && fs.existsSync(game.wine_prefix)) {
    return game.wine_prefix;
  }
  
  const dataDir = getLutrisDataDir();
  if (!dataDir) return null;
  
  // Check default prefixes directory
  const prefixesPath = path.join(dataDir, 'prefixes');
  if (game.slug && fs.existsSync(path.join(prefixesPath, game.slug))) {
    return path.join(prefixesPath, game.slug);
  }
  
  // Try by game ID
  const byId = path.join(prefixesPath, String(game.id));
  if (fs.existsSync(byId)) return byId;
  
  return null;
}

/**
 * Get Lutris Wine version for a game.
 */
export function getLutrisWineVersion(game: Partial<LutrisGame>): string | null {
  if (game.wine_version) return game.wine_version;
  return null;
}

/**
 * Get Lutris executable path for a game (for launching).
 */
export function getLutrisGameLaunchCommand(game: Partial<LutrisGame>): string[] | null {
  const lutrisExe = getLutrisExecutable();
  if (!lutrisExe) return null;
  
  return [lutrisExe, 'lutris:rungame/' + game.slug];
}

/**
 * Check if Lutris is installed and configured.
 */
export function isLutrisAvailable(): boolean {
  return getLutrisDataDir() !== null && getLutrisExecutable() !== null;
}

/**
 * Get all Lutris Wine prefixes.
 */
export function getLutrisPrefixes(): string[] {
  const dataDir = getLutrisDataDir();
  if (!dataDir) return [];
  
  const prefixesPath = path.join(dataDir, 'prefixes');
  if (!fs.existsSync(prefixesPath)) return [];
  
  try {
    return fs.readdirSync(prefixesPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(prefixesPath, d.name));
  } catch {
    return [];
  }
}

/**
 * Get Lutris Wine versions.
 */
export function getLutrisWineVersions(): string[] {
  const dataDir = getLutrisDataDir();
  if (!dataDir) return [];
  
  const winePath = path.join(dataDir, 'wine');
  if (!fs.existsSync(winePath)) return [];
  
  try {
    return fs.readdirSync(winePath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Get Lutris game by slug.
 */
export function getLutrisGameBySlug(slug: string): LutrisGame | null {
  const db = getLutrisDB();
  if (!db) return null;
  
  try {
    const row = db.prepare(`
      SELECT * FROM games WHERE slug = ?
    `).get(slug);
    return row ? (row as unknown as LutrisGame) : null;
  } catch (e) {
    console.error('Failed to query Lutris game by slug:', e);
    return null;
  } finally {
    db.close();
  }
}

/**
 * Get Lutris game by ID.
 */
export function getLutrisGameById(id: number): LutrisGame | null {
  const db = getLutrisDB();
  if (!db) return null;
  
  try {
    const row = db.prepare(`
      SELECT * FROM games WHERE id = ?
    `).get(id);
    return row ? (row as unknown as LutrisGame) : null;
  } catch (e) {
    console.error('Failed to query Lutris game by ID:', e);
    return null;
  } finally {
    db.close();
  }
}

/**
 * Check if a game is installed in Lutris.
 */
export function isLutrisGameInstalled(slug: string): boolean {
  const game = getLutrisGameBySlug(slug);
  return game?.installed === true;
}

/**
 * Get the install path for a Lutris game.
 */
export function getLutrisGamePath(game: Partial<LutrisGame>): string | null {
  if (game.install_path && fs.existsSync(game.install_path)) {
    return game.install_path;
  }
  
  // Try to construct from wine prefix
  const prefix = getLutrisWinePrefix({ wine_prefix: game.wine_prefix });
  if (prefix) {
    const driveC = path.join(prefix, 'drive_c');
    if (fs.existsSync(driveC)) return driveC;
  }
  
  return null;
}

/**
 * Get Lutris executable for a game (wine command).
 */
export function getLutrisGameExecutable(game: Partial<LutrisGame>): string | null {
  if (game.executable && fs.existsSync(game.executable)) {
    return game.executable;
  }
  
  // Try to construct from wine prefix
  const prefix = getLutrisWinePrefix({ wine_prefix: game.wine_prefix });
  if (prefix && game.executable) {
    const exePath = path.join(prefix, 'drive_c', game.executable.replace(/^\//, ''));
    if (fs.existsSync(exePath)) return exePath;
  }
  return null;
}

