import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';
import { getSteamLibraryGames } from './steam.js';
import { createSaveResolver, loadManifest, toSaveFields } from './savePaths.js';
import type { LoadManifestOptions, LudusaviManifest, SaveResolver } from './savePaths.js';
import { getHeroicGames } from './heroic.js';
import { getLutrisGames } from './lutris.js';
import type { LutrisGame } from './lutris.js';
import { getEpicGames, getGogGames, getUbisoftGames, getEaGames, getBattleNetGames, getXboxGames, getMinecraftGames } from './external.js';
import { getEmulatorGames } from '../emulators/roms.js';
import { dedupeGames } from './dedupe.js';

export interface GameSource {
  id: string;
  name: string;
  type: 'steam' | 'heroic' | 'lutris' | 'manual' | 'epic' | 'gog' | 'ubisoft' | 'ea' | 'battlenet' | 'xbox' | 'minecraft' | 'emulator';
  enabled: boolean;
  lastScan?: string;
  gameCount: number;
}

export interface GameRegistry {
  games: Map<number, Game>;
  sources: Map<string, GameSource>;
  lastFullScan?: string;
}

class GameRegistryImpl implements GameRegistry {
  games = new Map<number, Game>();
  sources = new Map<string, GameSource>();
  lastFullScan?: string;

  registerSource(source: GameSource) {
    this.sources.set(source.id, source);
  }

  unregisterSource(id: string) {
    this.sources.delete(id);
  }

  getSource(id: string): GameSource | undefined {
    return this.sources.get(id);
  }

  getAllSources(): GameSource[] {
    return Array.from(this.sources.values());
  }

  addGame(game: Game): void {
    this.games.set(game.id, game);
  }

  removeGame(id: number): boolean {
    return this.games.delete(id);
  }

  getGame(id: number): Game | undefined {
    return this.games.get(id);
  }

  getAllGames(): Game[] {
    return Array.from(this.games.values());
  }

  getGamesBySource(sourceId: string): Game[] {
    return Array.from(this.games.values()).filter(g => g.sourceId === sourceId);
  }

  setLastScan(time: string): void {
    this.lastFullScan = time;
  }

  clear(): void {
    this.games.clear();
    this.sources.clear();
    this.lastFullScan = undefined;
  }
}

export const gameRegistry = new GameRegistryImpl();

/**
 * Project a Lutris database row onto the shared Game shape. install_path goes
 * to installPath; linPath/winPath are manifest save paths or empty.
 */
export function fromLutris(game: LutrisGame, resolver: SaveResolver | null = null): Game {
  const now = new Date().toISOString();
  const installPath = game.install_path || '';
  const savePath = resolver
    ? resolver.resolve({ name: game.name, installPath: installPath || undefined, winePrefix: game.wine_prefix })
    : '';
  return {
    id: game.id,
    name: game.name,
    ...toSaveFields(savePath, resolver?.platform ?? process.platform),
    installPath,
    lastSync: typeof game.last_played === 'string' ? game.last_played : 'Never',
    status: 'In Sync',
    thumbnail: game.cover_url || '',
    sourceId: 'lutris',
    source: 'lutris',
    lutrisSlug: game.slug,
    winePrefix: game.wine_prefix,
    executable: game.executable,
    createdAt: now,
    updatedAt: now,
  };
}

export interface ScanOptions extends LoadManifestOptions {
  /** Pre-parsed manifest (skips loading). `null` means "no manifest available". */
  manifest?: LudusaviManifest | null;
  /** Pre-built resolver (skips manifest loading entirely). */
  resolver?: SaveResolver | null;
  /** Override Steam install detection (tests). */
  steamPath?: string | null;
  /**
   * Also add every manifest game whose save folder exists on disk (the legacy
   * "autodetect" behaviour). These entries have no source and only fill in
   * save paths for, or sit behind, the launcher-specific entries after dedupe.
   */
  includeManifestSaves?: boolean;
}

/** Games found only through the save manifest (no launcher knows about them). */
function manifestSaveGames(resolver: SaveResolver): Game[] {
  const now = new Date().toISOString();
  return resolver.discoverAll().map(({ name, path: savePath }) => ({
    id: nextId(),
    name,
    ...toSaveFields(savePath, resolver.platform),
    lastSync: 'Never',
    status: 'Pending Upload' as const,
    thumbnail: '',
    createdAt: now,
    updatedAt: now,
  }));
}

/** Sources whose games need manifest save-path resolution. */
const MANIFEST_SOURCE_TYPES = new Set<GameSource['type']>([
  'steam', 'heroic', 'lutris', 'epic', 'gog', 'ubisoft', 'ea', 'battlenet', 'xbox', 'minecraft',
]);

async function buildResolver(customRoots: string[], options: ScanOptions): Promise<SaveResolver | null> {
  if (options.resolver !== undefined) return options.resolver;
  const manifest = options.manifest !== undefined ? options.manifest : await loadManifest(options);
  return manifest ? createSaveResolver(manifest, { customRoots }) : null;
}

function scanSourceGames(source: GameSource, resolver: SaveResolver | null, options: ScanOptions): Game[] {
  switch (source.type) {
    case 'steam':
      return getSteamLibraryGames(resolver, options.steamPath !== undefined ? options.steamPath : undefined);
    case 'heroic':
      return getHeroicGames(resolver);
    case 'lutris':
      return getLutrisGames().map(g => fromLutris(g, resolver));
    case 'epic':
      return getEpicGames(undefined, resolver);
    case 'gog':
      return getGogGames(undefined, resolver);
    case 'ubisoft':
      return getUbisoftGames(undefined, resolver);
    case 'ea':
      return getEaGames(undefined, resolver);
    case 'battlenet':
      return getBattleNetGames(undefined, resolver);
    case 'xbox':
      return getXboxGames(undefined, resolver);
    case 'minecraft':
      return getMinecraftGames(undefined, resolver);
    case 'emulator':
      // emulators/roms.ts already sets real save paths.
      return getEmulatorGames().map(g => ({ ...g, sourceId: 'emulator' } as Game));
    case 'manual':
      return Array.from(gameRegistry.games.values()).filter(g => g.sourceId === 'manual');
  }
  return [];
}

// Initialize default sources
function initializeSources() {
  gameRegistry.registerSource({
    id: 'steam',
    name: 'Steam',
    type: 'steam',
    enabled: true,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'heroic',
    name: 'Heroic Games Launcher',
    type: 'heroic',
    enabled: true,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'lutris',
    name: 'Lutris',
    type: 'lutris',
    enabled: false, // disabled by default since not everyone has it
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'epic',
    name: 'Epic Games',
    type: 'manual',
    enabled: false,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'gog',
    name: 'GOG',
    type: 'manual',
    enabled: false,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    type: 'manual',
    enabled: false,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'ea',
    name: 'EA App',
    type: 'manual',
    enabled: false,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'battlenet',
    name: 'Battle.net',
    type: 'manual',
    enabled: false,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'xbox',
    name: 'Xbox',
    type: 'manual',
    enabled: false,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'minecraft',
    name: 'Minecraft',
    type: 'manual',
    enabled: false,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'emulator',
    name: 'Emulators',
    type: 'emulator',
    enabled: false,
    gameCount: 0,
  });
  gameRegistry.registerSource({
    id: 'manual',
    name: 'Manual Entry',
    type: 'manual',
    enabled: true,
    gameCount: 0,
  });
}

initializeSources();

/**
 * Perform a full scan across all enabled sources. The save manifest is loaded
 * at most once per scan and shared by every source.
 */
export async function fullScan(customRoots: string[] = [], options: ScanOptions = {}): Promise<Game[]> {
  const allGames: Game[] = [];
  const sources = gameRegistry.getAllSources().filter(s => s.enabled);
  const needsManifest = Boolean(options.includeManifestSaves) || sources.some(s => MANIFEST_SOURCE_TYPES.has(s.type));
  const resolver = needsManifest ? await buildResolver(customRoots, options) : null;

  for (const source of sources) {
    try {
      const games = scanSourceGames(source, resolver, options);
      source.gameCount = games.length;
      allGames.push(...games);
    } catch (error) {
      console.error(`Failed to scan ${source.name}:`, error);
    }
  }

  if (options.includeManifestSaves && resolver) {
    try {
      allGames.push(...manifestSaveGames(resolver));
    } catch (error) {
      console.error('Failed to scan save manifest:', error);
    }
  }

  const deduped = dedupeGames(allGames);

  // Update registry (sources are kept; only the game list is replaced)
  gameRegistry.games.clear();
  for (const game of deduped) {
    gameRegistry.addGame(game);
  }
  gameRegistry.setLastScan(new Date().toISOString());

  return deduped;
}
