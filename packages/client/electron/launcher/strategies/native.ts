import * as fs from 'fs';
import type { LaunchCommand, LaunchStrategy } from './types.js';

export const nativeStrategy: LaunchStrategy = {
  canLaunch(game) {
    return Boolean(game.linPath) && (game.source === undefined || game.source === 'manual');
  },
  getCommand(game): LaunchCommand | null {
    if (!game.linPath) return null;
    try {
      if (!fs.statSync(game.linPath).isFile()) return null;
    } catch {
      return null;
    }
    return { command: game.linPath, args: [], cwd: undefined };
  },
};
