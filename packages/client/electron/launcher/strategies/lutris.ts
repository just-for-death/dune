import type { LaunchCommand, LaunchStrategy } from './types.js';

export const lutrisStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'lutris' || Boolean(options?.lutrisSlug);
  },
  getCommand(game, options) {
    const slug = options?.lutrisSlug;
    if (!slug) return null;
    return { command: 'lutris', args: [`lutris:rungame/${slug}`], env: options?.env, cwd: options?.cwd };
  },
};
