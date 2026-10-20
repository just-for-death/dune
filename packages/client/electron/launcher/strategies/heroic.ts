import type { LaunchStrategy } from './types.js';

export const heroicStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'heroic' || game.sourceId === 'heroic' || Boolean(options?.heroicId || game.heroicId);
  },
  getCommand(game, options) {
    const heroicId = options?.heroicId || game.heroicId;
    if (!heroicId) return null;
    return { command: 'heroic', args: ['--run', heroicId], env: options?.env, cwd: options?.cwd };
  },
};
