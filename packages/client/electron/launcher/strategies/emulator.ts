import * as fs from 'fs';
import * as path from 'path';
import type { LaunchCommand, LaunchStrategy, LaunchableGame } from './types.js';
import { isKnownEmulator } from '../emulators.js';
import { findRetroArchCore, type CoreLookupDeps } from '../retroarchCores.js';

const DEFAULT_EMULATOR = 'retroarch';

function isRomFile(romPath: string): boolean {
  try {
    return fs.statSync(romPath).isFile();
  } catch {
    return false;
  }
}

function retroArchRefusal(game: LaunchableGame, coreDeps?: CoreLookupDeps): string | null {
  if (!game.romPath) return null;
  const emulator = game.emulator || DEFAULT_EMULATOR;
  if (emulator !== 'retroarch') return null;
  const core = findRetroArchCore(game.romPath, coreDeps);
  return core.ok ? null : core.message;
}

export const emulatorStrategy: LaunchStrategy = {
  canLaunch(game) {
    return game.source === 'emulator' && Boolean(game.romPath);
  },
  getCommand(game, options): LaunchCommand | null {
    const romPath = game.romPath;
    if (!romPath || !isRomFile(romPath)) return null;

    // DUN-061: only an emulator from the known list is ever spawned.
    const emulator = game.emulator || DEFAULT_EMULATOR;
    if (!isKnownEmulator(emulator)) return null;
    let args = [romPath];
    if (emulator === 'retroarch') {
      // DUN-075: always start the game with a core, never the menu.
      const core = findRetroArchCore(romPath, options?.coreLookup);
      if (!core.ok) return null;
      args = ['-L', core.core, romPath];
    }
    return {
      command: emulator,
      args,
      env: options?.env,
      cwd: path.dirname(romPath),
    };
  },
  refusal(game, options) {
    if (!game.romPath || !isRomFile(game.romPath)) return null;
    return retroArchRefusal(game, options?.coreLookup);
  },
};
