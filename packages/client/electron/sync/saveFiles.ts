import * as fs from 'fs';
import type { Game, SaveFileListResult } from '@dune/shared';
import { listSaveFiles, resolveSaveTarget, type SaveTargetDeps } from './saveTarget';

/** saves:listFiles cap (DUN-047 enabler). */
export const MAX_LISTED_SAVE_FILES = 5000;

export interface ListGameSaveFilesDeps extends SaveTargetDeps {
  /** The game's expanded save path for this OS (main's savePathOf). */
  savePathOf: (game: Game) => string;
  max?: number;
}

/**
 * Read-only list of a game's save files, exactly as sync sees them before
 * exclude rules: the same resolveSaveTarget (protected roots, file filters)
 * and listSaveFiles walk (symlinks skipped). Never writes anything.
 */
export function listGameSaveFiles(game: Game | undefined, deps: ListGameSaveFilesDeps): SaveFileListResult {
  if (!game) return { ok: false, code: 'GAME_NOT_FOUND', message: 'Game not found' };
  try {
    const expanded = deps.savePathOf(game);
    if (!expanded) return { ok: false, code: 'NO_SAVE_PATH', message: 'This game has no save path on this device.' };
    const target = resolveSaveTarget(expanded, deps);
    if (!target.ok) {
      if (target.reason === 'protected') {
        return { ok: false, code: 'PROTECTED_SAVE_PATH', message: 'The save path is a shared folder; pick the game\'s own save folder.' };
      }
      return { ok: false, code: 'NO_SAVE_PATH', message: target.reason === 'missing' ? 'The save path does not exist.' : 'Only the last part of a save path may contain wildcards.' };
    }
    const max = deps.max ?? MAX_LISTED_SAVE_FILES;
    const listed = listSaveFiles(target.target, { max: max + 1 });
    const truncated = listed.length > max;
    const files: { path: string; size: number; mtimeMs: number }[] = [];
    for (const f of listed.slice(0, max)) {
      try {
        const st = fs.lstatSync(f.local);
        if (!st.isFile()) continue;
        files.push({ path: f.rel.split(/[\\/]/).join('/'), size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      } catch { /* vanished while listing */ }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { ok: true, files, truncated };
  } catch (error) {
    return { ok: false, code: 'LOCAL_ERROR', message: error instanceof Error ? error.message : String(error) };
  }
}
