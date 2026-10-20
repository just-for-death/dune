// Shared name/path rules (DUN-086, DUN-093). Pure TypeScript with no Node or
// DOM imports, so the server, Desktop's restore code and the renderer UI can
// all use exactly the same checks.
//
// These are *lexical* checks only. They reject (never strip or rewrite) any
// input that is unsafe or that a filesystem would silently change. The server
// still runs its canonical, symlink-aware containment check afterwards.
//
// The rejection set mirrors packages/client/electron/sync/restoreTarget.ts
// (DUN-060), applied on every platform: a Linux server stores files that a
// Windows client later restores, and vice versa.

export type PathRuleCode =
  | 'EMPTY'
  | 'NUL'
  | 'DOT_SEGMENT'
  | 'ABSOLUTE'
  | 'SEPARATOR'
  | 'CONTROL'
  | 'RESERVED'
  | 'CHANGED_BY_SANITIZE'
  | 'TOO_LONG';

export type PathRuleResult =
  | { ok: true; value: string }
  | { ok: false; code: PathRuleCode; message: string };

/** Max UTF-8 bytes for one path segment (common fs limit). */
export const MAX_SEGMENT_BYTES = 255;
/** Max characters (code points) for a trimmed game title. */
export const MAX_GAME_TITLE_LENGTH = 200;
/** Max characters for a whole relative save path. */
export const MAX_RELATIVE_PATH_LENGTH = 1024;

/** Win32 device names, also with an extension (`con.txt`) or superscript digits. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Characters Windows forbids in names (':' is handled separately as RESERVED). */
// eslint-disable-next-line no-control-regex
const SANITIZED_CHARS = /[<>"|?*\x01-\x1f\x7f]/;

function fail(code: PathRuleCode, message: string): PathRuleResult {
  return { ok: false, code, message };
}

/**
 * UTF-8 byte length, counted by hand on purpose: no Buffer (Node-only) and no
 * TextEncoder (not in the ES2022 lib), so this module runs unchanged in the
 * server, Electron main and the renderer.
 */
function utf8Length(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Checks applied to every segment of a relative save path. */
function checkSegment(seg: string, label: string): PathRuleResult | null {
  if (seg === '') return fail('EMPTY', `${label} contains an empty segment`);
  // '.', '..' and dot-only segments ('...', '.. '): Windows trims trailing
  // dots/spaces, so these can act as '..'.
  if (/^[. ]+$/.test(seg) && seg.includes('.')) {
    return fail('DOT_SEGMENT', `${label} contains a '.' or '..' segment`);
  }
  if (seg.includes(':')) return fail('RESERVED', `${label} contains a colon (drive or alternate data stream)`);
  if (WIN_RESERVED.test(seg.replace(/[. ]+$/, ''))) {
    return fail('RESERVED', `${label} uses a reserved device name ('${seg}')`);
  }
  if (SANITIZED_CHARS.test(seg)) {
    return fail('CHANGED_BY_SANITIZE', `${label} contains a character not allowed in file names (< > " | ? * or control)`);
  }
  if (seg.trim() !== seg || /[. ]$/.test(seg)) {
    return fail('CHANGED_BY_SANITIZE', `${label} has leading/trailing spaces or a trailing dot`);
  }
  if (utf8Length(seg) > MAX_SEGMENT_BYTES) {
    return fail('TOO_LONG', `${label} has a segment longer than ${MAX_SEGMENT_BYTES} bytes`);
  }
  return null;
}

function checkCommon(input: unknown, label: string): PathRuleResult | string {
  if (typeof input !== 'string' || input.trim() === '') return fail('EMPTY', `${label} is empty`);
  if (input.includes('\0')) return fail('NUL', `${label} contains a NUL character`);
  // POSIX root, UNC (\\server\share), leading backslash, and every drive
  // form: C:\x, C:/x and drive-relative C:x.
  if (/^[\\/]/.test(input) || /^[a-zA-Z]:/.test(input)) {
    return fail('ABSOLUTE', `${label} must be relative, not absolute`);
  }
  return input;
}

/**
 * A save path must be relative to the game root with no '.'/'..' segments.
 * Both '/' and '\' count as separators. The returned `value` is the
 * canonical form: segments joined with '/'.
 */
export function validateRelativeSavePath(p: unknown): PathRuleResult {
  const common = checkCommon(p, 'Path');
  if (typeof common !== 'string') return common;
  if (common.length > MAX_RELATIVE_PATH_LENGTH) {
    return fail('TOO_LONG', `Path is longer than ${MAX_RELATIVE_PATH_LENGTH} characters`);
  }
  const segments = common.split(/[\\/]/);
  for (const seg of segments) {
    const bad = checkSegment(seg, 'Path');
    if (bad) return bad;
  }
  return { ok: true, value: segments.join('/') };
}

/**
 * Validate a display title for a game ("The Witcher 3: Wild Hunt",
 * "DARK SOULS™ III"). Titles are stored and shown exactly as written, so
 * only clearly invalid input is rejected: empty after trimming, NUL or other
 * control characters (0x00-0x1F, 0x7F), or more than 200 characters.
 * The returned `value` is the trimmed title. Titles are never used as folder
 * names (the server stores saves under the game's id).
 */
export function validateGameTitle(title: unknown): PathRuleResult {
  if (typeof title !== 'string') return fail('EMPTY', 'Game title is empty');
  const value = title.trim();
  if (value === '') return fail('EMPTY', 'Game title is empty');
  if (value.includes('\0')) return fail('NUL', 'Game title contains a NUL character');
  // eslint-disable-next-line no-control-regex
  if (/[\x01-\x1f\x7f]/.test(value)) {
    return fail('CONTROL', 'Game title contains control characters');
  }
  if ([...value].length > MAX_GAME_TITLE_LENGTH) {
    return fail('TOO_LONG', `Game title is longer than ${MAX_GAME_TITLE_LENGTH} characters`);
  }
  return { ok: true, value };
}
