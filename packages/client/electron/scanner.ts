/**
 * Legacy entry point kept as a thin re-export so there is a single scanner
 * implementation (electron/scanner/*). New code should import from
 * './scanner/index' (registry fullScan) or './scanner/savePaths'.
 */
export { autoDetectGames } from './scanner/steam.js';
export type { DetectedGame } from './scanner/steam.js';
