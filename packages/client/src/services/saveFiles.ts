import type { SaveFileEntry, SaveFileListResult } from '@dune/shared';
import type { MessageKey } from '../i18n';

/** DUN-131: a save file as the exclusion editor shows it. */
export type SaveFileCategory = 'Save' | 'Config' | 'Cache' | 'Other';
export interface CategorizedSaveFile {
  path: string;
  size: number;
  category: SaveFileCategory;
}
export type SaveFileListFailureCode = Extract<SaveFileListResult, { ok: false }>['code'];

/**
 * Globs written to profile.excludeGlobs when a category is excluded. "Other"
 * is the catch-all bucket and has no pattern that would not overlap the other
 * categories, so it is shown but cannot be toggled. Files are categorized by
 * these same globs, so excluding a category skips exactly the files listed in it.
 */
export const CATEGORY_GLOBS: Record<SaveFileCategory, string[]> = {
  Save: ['**/*.sav', '**/*.save', '**/*.sl2', '**/saves/**', '**/Saves/**', '**/SaveGames/**'],
  Config: ['**/*.ini', '**/*.cfg', '**/*.conf', '**/config/**', '**/Config/**'],
  Cache: ['**/cache/**', '**/Cache/**', '**/*.log', '**/*.tmp', '**/*.cache', '**/logs/**'],
  Other: [],
};

/** Most specific first: a log inside saves/ is cache, a .sav inside config/ is a save. */
const CATEGORY_ORDER: SaveFileCategory[] = ['Cache', 'Save', 'Config'];

/**
 * Matches the two glob shapes used in CATEGORY_GLOBS: `**\/*.ext` (file name
 * ends with .ext) and `**\/dir/**` (some folder segment is exactly dir).
 * Case-sensitive, like the sync engine's globs.
 */
export function matchesCategoryGlob(path: string, glob: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const ext = /^\*\*\/\*(\.[^/*]+)$/.exec(glob);
  if (ext) return segments[segments.length - 1].endsWith(ext[1]);
  const dir = /^\*\*\/([^/*]+)\/\*\*$/.exec(glob);
  if (dir) return segments.slice(0, -1).includes(dir[1]);
  return false;
}

export function categorizeSaveFile(path: string): SaveFileCategory {
  for (const category of CATEGORY_ORDER) {
    if (CATEGORY_GLOBS[category].some(glob => matchesCategoryGlob(path, glob))) return category;
  }
  return 'Other';
}

export function categorizeSaveFiles(files: SaveFileEntry[]): CategorizedSaveFile[] {
  return files.map(file => ({ path: file.path, size: file.size, category: categorizeSaveFile(file.path) }));
}

const FAILURE_KEYS: Record<SaveFileListFailureCode, MessageKey> = {
  GAME_NOT_FOUND: 'exclusions.error.gameNotFound',
  NO_SAVE_PATH: 'exclusions.error.noSavePath',
  PROTECTED_SAVE_PATH: 'exclusions.error.protectedSavePath',
  LOCAL_ERROR: 'exclusions.error.local',
};

function isFailureCode(code: string): code is SaveFileListFailureCode {
  return Object.prototype.hasOwnProperty.call(FAILURE_KEYS, code);
}

/** Message for a failed listSaveFiles; unknown codes (newer main) read as a local error. */
export function saveFileListFailureKey(code: string): MessageKey {
  return isFailureCode(code) ? FAILURE_KEYS[code] : FAILURE_KEYS.LOCAL_ERROR;
}

export type SaveFileListState =
  | { status: 'loading' }
  | { status: 'ready'; files: CategorizedSaveFile[]; truncated: boolean }
  | { status: 'error'; messageKey: MessageKey };

export function saveFileListState(res: SaveFileListResult): SaveFileListState {
  if (res.ok) return { status: 'ready', files: categorizeSaveFiles(res.files), truncated: res.truncated };
  return { status: 'error', messageKey: saveFileListFailureKey(res.code) };
}

/** A rejected IPC call (main gone, handler missing) reads as a local error. */
export const SAVE_FILE_LIST_REJECTED: SaveFileListState = { status: 'error', messageKey: FAILURE_KEYS.LOCAL_ERROR };
