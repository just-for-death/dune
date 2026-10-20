import type { LaunchCommand, LaunchStrategy } from './types.js';
import { resolveLaunchTarget } from './target.js';

export const nativeStrategy: LaunchStrategy = {
  canLaunch(game) {
    return Boolean(game.executable || game.installPath) && game.source !== 'emulator';
  },
  getCommand(game): LaunchCommand | null {
    const executable = resolveLaunchTarget(game);
    if (!executable) return null;
    return { command: executable, args: [], cwd: undefined };
  },
};
