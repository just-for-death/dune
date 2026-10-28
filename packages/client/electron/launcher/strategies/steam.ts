import type { LaunchStrategy } from './types.js';

/** DUN-061: Steam app ids are numeric; anything else is never opened. */
export const STEAM_APP_ID = /^\d{1,10}$/;

/**
 * DUN-074: Steam games open through the OS URL handler
 * (`shell.openExternal('steam://rungameid/<id>')`), which works on Windows,
 * macOS and Linux; `xdg-open` only existed on Linux.
 */
export const steamStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'steam' || game.sourceId === 'steam' || Boolean(options?.appId || game.steamAppId);
  },
  getCommand(game, options) {
    const appId = options?.appId || game.steamAppId;
    if (!appId || !STEAM_APP_ID.test(appId)) return null;
    return { url: `steam://rungameid/${appId}` };
  },
};
