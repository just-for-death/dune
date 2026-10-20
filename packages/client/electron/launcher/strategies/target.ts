import * as fs from 'fs';
import * as path from 'path';
import type { LaunchableGame } from './types.js';

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The file to execute for a game: `executable` (absolute, or relative to
 * `installPath`), else `installPath` only when
 * it points at a file. A directory install path is never spawned. winPath /
 * linPath are SAVE paths and are never used here.
 */
export function resolveLaunchTarget(game: Pick<LaunchableGame, 'executable' | 'installPath'>): string | null {
  const candidates = [game.executable, game.installPath];
  // Launchers such as Heroic may store the executable relative to the install folder.
  if (game.executable && game.installPath && !path.isAbsolute(game.executable)) {
    candidates.unshift(path.join(game.installPath, game.executable));
  }
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) return candidate;
  }
  return null;
}
