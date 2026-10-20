import type { LaunchStrategy } from './types.js';

/** DUN-061: Heroic app names are plain tokens; a leading `-` could be read as a CLI flag. */
export const HEROIC_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const heroicStrategy: LaunchStrategy = {
  canLaunch(game, options) {
    return game.source === 'heroic' || game.sourceId === 'heroic' || Boolean(options?.heroicId || game.heroicId);
  },
  getCommand(game, options) {
    const heroicId = options?.heroicId || game.heroicId;
    if (!heroicId || !HEROIC_ID.test(heroicId)) return null;
    return { command: 'heroic', args: ['--run', heroicId], env: options?.env, cwd: options?.cwd };
  },
};
