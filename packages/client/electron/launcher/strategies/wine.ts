import * as path from 'path';
import type { LaunchStrategy } from './types.js';

export const wineStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return Boolean(game.linPath && (options?.winePrefix || game.source === 'manual'));
  },
  getCommand(game, options) {
    if (!game.linPath || !options?.winePrefix) return null;
    const env = {
      ...options.env,
      WINEPREFIX: options.winePrefix,
      ...(options.protonPath ? { PROTONPATH: options.protonPath } : {}),
    };
    const command = options.useUmu ? 'umu-run' : 'wine';
    return { command, args: [game.linPath], env, cwd: options.cwd || path.dirname(game.linPath) };
  },
};

