export { autoDetectGames } from './steam.js';
export { getHeroicGames, getHeroicExecutable, getHeroicWinePrefix, getHeroicWineVersion, getHeroicGameLaunchCommand, isHeroicAvailable } from './heroic.js';
export { getLutrisGames, getLutrisExecutable, getLutrisWinePrefix, getLutrisWineVersion, getLutrisGameLaunchCommand, isLutrisAvailable, getLutrisGameBySlug, getLutrisGameById, isLutrisGameInstalled, getLutrisGamePath, getLutrisGameExecutable, getLutrisPrefixes, getLutrisWineVersions } from './lutris.js';
export { 
  gameRegistry, 
  fullScan, 
  scanSource, 
  addManualGame, 
  removeGame, 
  updateGame, 
  getAllGames, 
  getGameById, 
  getGamesBySource, 
  getSources, 
  setSourceEnabled, 
  getLastFullScan 
} from './registry.js';

export type { GameSource, GameRegistry } from './registry.js';
export type { SteamGameInfo, SteamLibraryFolder, SteamLibraryConfig } from './steam.js';
export type { HeroicGame, HeroicConfig } from './heroic.js';
export type { LutrisGame, LutrisConfig } from './lutris.js';
export type { Game } from '@dune/shared';