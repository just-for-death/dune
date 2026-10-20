import type { LaunchStrategy } from './types.js';

export const heroicStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'heroic' || Boolean(options?.heroicId);
  },
  getCommand(game, options) {
    const heroicId = options?.heroicId || game.sourceId;
    if (!heroicId || heroicId === 'heroic') return null;
    return { command: 'heroic', args: ['--run', heroicId], env: options?.env, cwd: options?.cwd };
  },
};
