import * as fs from 'fs';
import * as path from 'path';
import type { LaunchCommand, LaunchStrategy } from './types.js';

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

    const emulator = game.emulator || DEFAULT_EMULATOR;
    return {
      command: emulator,
      args: [romPath],
      env: options?.env,
      cwd: path.dirname(romPath),
    };
  },
};
