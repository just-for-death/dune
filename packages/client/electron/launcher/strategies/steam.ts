import type { LaunchStrategy } from './types.js';

/** DUN-061: Steam app ids are numeric; anything else never reaches `xdg-open`. */
export const STEAM_APP_ID = /^\d{1,10}$/;

export const steamStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'steam' || game.sourceId === 'steam' || Boolean(options?.appId || game.steamAppId);
  },
  getCommand(game, options) {
    const appId = options?.appId || game.steamAppId;
    if (!appId || !STEAM_APP_ID.test(appId)) return null;
    return { command: 'xdg-open', args: [`steam://run/${appId}`], env: options?.env, cwd: options?.cwd };
  },
};
