import type { LaunchStrategy } from './types.js';

/** DUN-061: Lutris slugs are plain tokens (no `/`, spaces or leading `-`). */
export const LUTRIS_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const lutrisStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'lutris' || game.sourceId === 'lutris' || Boolean(options?.lutrisSlug || game.lutrisSlug);
  },
  getCommand(game, options) {
    const slug = options?.lutrisSlug || game.lutrisSlug;
    if (!slug || !LUTRIS_SLUG.test(slug)) return null;
    return { command: 'lutris', args: [`lutris:rungame/${slug}`], env: options?.env, cwd: options?.cwd };
  },
};
