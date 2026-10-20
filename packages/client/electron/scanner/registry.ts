import { nextId } from '@dune/shared';
import type { Game } from '@dune/shared';
import { autoDetectGames as steamAutoDetect } from './steam.js';
import { getHeroicGames } from './heroic.js';
import { getLutrisGames } from './lutris.js';

export interface GameSource {
  id: string;
  name: string;
  type: 'steam' | 'heroic' | 'lutris' | 'manual';
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
    return Array.from(this.games.values()).filter(g => (g as any).sourceId === sourceId);
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
    id: 'manual',
    name: 'Manual Entry',
    type: 'manual',
    enabled: true,
    gameCount: 0,
  });
}

initializeSources();

/**
 * Perform a full scan across all enabled sources.
 */
export async function fullScan(_customRoots: string[] = []): Promise<Game[]> {
  const allGames: Game[] = [];
  const sources = gameRegistry.getAllSources();

  for (const source of sources) {
    if (!source.enabled) continue;

    let games: Game[] = [];
    try {
      switch (source.type) {
        case 'steam':
          games = await steamAutoDetect([]);
          break;
        case 'heroic':
          games = getHeroicGames().map(g => ({ ...g, sourceId: 'heroic' } as Game));
          break;
        case 'lutris':
          games = getLutrisGames().map(g => ({ ...g, sourceId: 'lutris' } as Game));
          break;
        case 'manual':
          // Manual games are already in registry
          games = Array.from(gameRegistry.games.values()).filter(g => (g as any).sourceId === 'manual');
          break;
      }

      // Update source game count
      const src = gameRegistry.getSource(source.id);
      if (src) {
        src.gameCount = games.length;
      }

      allGames.push(...games);
    } catch (error) {
      console.error(`Failed to scan ${source.name}:`, error);
    }
  }

  // Update registry
  gameRegistry.clear();
  for (const game of allGames) {
    gameRegistry.addGame(game);
  }
  gameRegistry.setLastScan(new Date().toISOString());

  return allGames;
}

/**
 * Scan a specific source only.
 */
export async function scanSource(sourceId: string): Promise<Game[]> {
  const source = gameRegistry.getSource(sourceId);
  if (!source || !source.enabled) return [];

  try {
    switch (source.type) {
      case 'steam':
        return steamAutoDetect([]);
      case 'heroic':
        return getHeroicGames().map(g => ({ ...g, sourceId: 'heroic' } as Game));
      case 'lutris':
        return getLutrisGames().map(g => ({ ...g, sourceId: 'lutris' } as Game));
      case 'manual':
        return Array.from(gameRegistry.games.values()).filter(g => (g as any).sourceId === 'manual');
    }
  } catch (error) {
    console.error(`Failed to scan ${source.name}:`, error);
  }
  return [];
}

/**
 * Add a manually entered game.
 */
export function addManualGame(game: Omit<Game, 'id' | 'sourceId'>): Game {
  const gameWithId: Game = {
    ...game,
    id: nextId(),
    sourceId: 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  gameRegistry.addGame(gameWithId);
  return gameWithId;
}

/**
 * Remove a game from registry.
 */
export function removeGame(id: number): boolean {
  return gameRegistry.removeGame(id);
}

/**
 * Update a game in registry.
 */
export function updateGame(id: number, updates: Partial<Game>): Game | null {
  const game = gameRegistry.getGame(id);
  if (!game) return null;
  
  const updated = { ...game, ...updates, updatedAt: new Date().toISOString() };
  gameRegistry.addGame(updated);
  return updated;
}

/**
 * Get all registered games.
 */
export function getAllGames(): Game[] {
  return gameRegistry.getAllGames();
}

/**
 * Get a specific game by ID.
 */
export function getGameById(id: number): Game | undefined {
  return gameRegistry.getGame(id);
}

/**
 * Get games by source.
 */
export function getGamesBySource(sourceId: string): Game[] {
  return gameRegistry.getGamesBySource(sourceId);
}

/**
 * Get all sources.
 */
export function getSources(): GameSource[] {
  return gameRegistry.getAllSources();
}

/**
 * Enable/disable a source.
 */
export function setSourceEnabled(sourceId: string, enabled: boolean): boolean {
  const source = gameRegistry.getSource(sourceId);
  if (!source) return false;
  source.enabled = enabled;
  return true;
}

/**
 * Get last full scan timestamp.
 */
export function getLastFullScan(): string | undefined {
  return gameRegistry.lastFullScan;
}

export { nextId } from '@dune/shared';
export type { Game } from '@dune/shared';