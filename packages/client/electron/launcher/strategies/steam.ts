import type { LaunchStrategy } from './types.js';

export const steamStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'steam' || game.sourceId === 'steam' || Boolean(options?.appId || game.steamAppId);
  },
  getCommand(game, options) {
    const appId = options?.appId || game.steamAppId;
    if (!appId) return null;
    return { command: 'xdg-open', args: [`steam://run/${appId}`], env: options?.env, cwd: options?.cwd };
  },
};
