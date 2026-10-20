import * as fs from 'fs';
import type { LaunchCommand, LaunchStrategy } from './types.js';

export const nativeStrategy: LaunchStrategy = {
  canLaunch(game) {
    return Boolean(game.executable || game.linPath) && game.source !== 'emulator';
  },
  getCommand(game): LaunchCommand | null {
    const executable = game.executable || game.linPath;
    if (!executable) return null;
    try {
      if (!fs.statSync(executable).isFile()) return null;
    } catch {
      return null;
    }
    return { command: executable, args: [], cwd: undefined };
  },
};
