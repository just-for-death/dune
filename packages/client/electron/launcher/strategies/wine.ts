import * as path from 'path';
import type { LaunchStrategy } from './types.js';
import { resolveLaunchTarget } from './target.js';

export const wineStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return Boolean((game.executable || game.installPath) && (options?.winePrefix || game.winePrefix || game.source === 'manual'));
  },
  getCommand(game, options) {
    const opts = options ?? {};
    const executable = resolveLaunchTarget(game);
    const prefix = opts.winePrefix || game.winePrefix;
    if (!executable || !prefix) return null;
    const env = {
      ...opts.env,
      WINEPREFIX: prefix,
      ...(opts.protonPath || game.protonPath ? { PROTONPATH: opts.protonPath || game.protonPath } : {}),
    };
    const command = opts.useUmu ? 'umu-run' : 'wine';
    return { command, args: [executable], env, cwd: opts.cwd || path.dirname(executable) };
  },
};

