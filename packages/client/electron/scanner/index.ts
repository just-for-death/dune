export { autoDetectGames, getSteamLibraryGames, getInstalledSteamLibraryGames, getSteamPath } from './steam.js';
export { createSaveResolver, loadManifest, parseManifest, translatePath, translatePathOverride, toSaveFields } from './savePaths.js';
export type { LudusaviManifest, SaveResolver, SaveLookup } from './savePaths.js';
export { dedupeGames } from './dedupe.js';
export { migrateStoredGames, runStoredGamesMigration, GAMES_MIGRATION_VERSION } from './migrateStore.js';
export { getHeroicGames, getHeroicExecutable, getHeroicWinePrefix, getHeroicWineVersion, getHeroicGameLaunchCommand, isHeroicAvailable } from './heroic.js';
export { getEpicGames, getGogGames, getUbisoftGames, getEaGames, getBattleNetGames, getXboxGames, getMinecraftGames } from './external.js';
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

export type { GameSource, GameRegistry, ScanOptions } from './registry.js';
export type { SteamGameInfo, SteamLibraryFolder, SteamLibraryConfig } from './steam.js';
export type { HeroicGame, HeroicConfig } from './heroic.js';
export type { LutrisGame, LutrisConfig } from './lutris.js';
export type { Game } from '@dune/shared';