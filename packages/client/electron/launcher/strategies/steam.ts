import type { LaunchCommand, LaunchStrategy } from './types.js';

export const steamStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'steam' || Boolean(options?.appId);
  },
  getCommand(game, options) {
    const appId = options?.appId;
    if (!appId) return null;
    return { command: 'xdg-open', args: [`steam://run/${appId}`], env: options?.env, cwd: options?.cwd };
  },
};
