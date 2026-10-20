import * as fs from 'fs';
import * as path from 'path';
import type { LaunchCommand, LaunchStrategy } from './types.js';
import { isKnownEmulator } from '../emulators.js';

const DEFAULT_EMULATOR = 'retroarch';

export const emulatorStrategy: LaunchStrategy = {
  canLaunch(game) {
    return game.source === 'emulator' && Boolean(game.romPath);
  },
  getCommand(game, options): LaunchCommand | null {
    const romPath = game.romPath;
    if (!romPath) return null;
    try {
      if (!fs.statSync(romPath).isFile()) return null;
    } catch {
      return null;
    }

    // DUN-061: only an emulator from the known list is ever spawned.
    const emulator = game.emulator || DEFAULT_EMULATOR;
    if (!isKnownEmulator(emulator)) return null;
    return {
      command: emulator,
      args: [romPath],
      env: options?.env,
      cwd: path.dirname(romPath),
    };
  },
};
