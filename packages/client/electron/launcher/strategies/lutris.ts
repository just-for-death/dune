import type { LaunchStrategy } from './types.js';

export const lutrisStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'lutris' || game.sourceId === 'lutris' || Boolean(options?.lutrisSlug || game.lutrisSlug);
  },
  getCommand(game, options) {
    const slug = options?.lutrisSlug || game.lutrisSlug;
    if (!slug) return null;
    return { command: 'lutris', args: [`lutris:rungame/${slug}`], env: options?.env, cwd: options?.cwd };
  },
};
