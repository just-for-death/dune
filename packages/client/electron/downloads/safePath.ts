/**
 * Destination handling: every download lands inside the manager's base dir
 * (`<baseDir>/<source>/...`) or inside a validated per-download override dir.
 *
 * Callers pass relative names only. We reject absolute paths (POSIX and
 * Windows forms), `..` segments, NUL/control characters and characters that
 * are invalid on Windows, then resolve against the base dir and check that the
 * result (and, on disk, the real path of its parent) is still inside it, so a
 * symlinked sub-folder can't redirect a write elsewhere.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DownloadError } from './errors';

const MAX_SEGMENT = 255;
// Control chars plus the characters Windows forbids in file names.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Split a caller-supplied relative path into validated segments. */
export function relativeSegments(input: string, what = 'path'): string[] {
  if (typeof input !== 'string' || !input.trim()) throw new DownloadError('INVALID_PATH', `Empty ${what}`);
  if (input.includes('\0')) throw new DownloadError('INVALID_PATH', `${what} contains a NUL byte`);
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input) || /^[a-z]:/i.test(input)) {
    throw new DownloadError('PATH_TRAVERSAL', `${what} must be relative to the download folder`);
  }
  const segments = input.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) throw new DownloadError('INVALID_PATH', `Empty ${what}`);
  for (const seg of segments) {
    if (seg === '..') throw new DownloadError('PATH_TRAVERSAL', `${what} may not contain ".."`);
    if (seg === '.') throw new DownloadError('INVALID_PATH', `${what} may not contain "."`);
    if (seg.length > MAX_SEGMENT) throw new DownloadError('INVALID_PATH', `${what} segment is too long`);
    if (BAD_CHARS.test(seg)) throw new DownloadError('INVALID_PATH', `${what} contains an invalid character`);
    if (/[. ]$/.test(seg) || WINDOWS_RESERVED.test(seg)) throw new DownloadError('INVALID_PATH', `${what} has an invalid name "${seg}"`);
  }
  return segments;
}

/** Resolve `subdir/fileName` inside `baseDir` (lexically) or throw PATH_TRAVERSAL. */
export function resolveWithinBase(baseDir: string, fileName: string, subdir?: string): string {
  const base = path.resolve(baseDir);
  const segments = [...(subdir ? relativeSegments(subdir, 'subdir') : []), ...relativeSegments(fileName, 'fileName')];
  const target = path.resolve(base, ...segments);
  if (!isWithin(base, target)) throw new DownloadError('PATH_TRAVERSAL', 'Destination escapes the download folder');
  return target;
}

/**
 * Create the destination's parent folder (only below `root`; the root itself
 * must already exist and is never created) and check, on disk, that it really
 * sits inside the root (no symlink escape) and that neither the final file
 * nor its `.part` is a symlink.
 */
export async function prepareDestination(root: string, destPath: string, partPath: string): Promise<void> {
  const realBase = await fs.promises.realpath(path.resolve(root)).catch(() => null);
  if (realBase === null) throw new DownloadError('IO_ERROR', `Download folder not found: ${root}`);
  const parent = path.dirname(destPath);
  // Before creating anything, the deepest existing ancestor must already be inside the root.
  let probe = parent;
  while (!(await fs.promises.lstat(probe).then(() => true, () => false))) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const realProbe = await fs.promises.realpath(probe);
  if (realProbe !== realBase && !isWithin(realBase, realProbe)) {
    throw new DownloadError('PATH_TRAVERSAL', 'Destination folder resolves outside the download folder');
  }
  await fs.promises.mkdir(parent, { recursive: true });
  const realParent = await fs.promises.realpath(parent);
  if (realParent !== realBase && !isWithin(realBase, realParent)) {
    throw new DownloadError('PATH_TRAVERSAL', 'Destination folder resolves outside the download folder');
  }
  for (const p of [destPath, partPath]) {
    const st = await fs.promises.lstat(p).catch(() => null);
    if (st?.isSymbolicLink()) throw new DownloadError('PATH_TRAVERSAL', 'Destination is a symbolic link');
  }
}

/** Validate a source id: exactly one safe path segment. */
export function sourceSegment(source: string): string {
  const segs = relativeSegments(source, 'source');
  if (segs.length !== 1) throw new DownloadError('INVALID_PATH', 'source must be a single folder name');
  return segs[0];
}

/**
 * Validate a caller-chosen download folder (a per-download `destDir`
 * override, or a new base dir) and return its realpath. It must be an
 * absolute path to an existing directory, written without `..` segments.
 */
export async function resolveExistingDir(input: string, what = 'destDir'): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) throw new DownloadError('INVALID_PATH', `Empty ${what}`);
  if (input.includes('\0')) throw new DownloadError('INVALID_PATH', `${what} contains a NUL byte`);
  if (input.split(/[\\/]+/).includes('..')) throw new DownloadError('PATH_TRAVERSAL', `${what} may not contain ".."`);
  if (!path.isAbsolute(input)) throw new DownloadError('INVALID_PATH', `${what} must be an absolute path`);
  let real: string;
  try {
    real = await fs.promises.realpath(input);
  } catch {
    throw new DownloadError('INVALID_PATH', `Download folder not found: ${input}`);
  }
  const st = await fs.promises.stat(real);
  if (!st.isDirectory()) throw new DownloadError('INVALID_PATH', `${what} is not a directory`);
  return real;
}

const COMPOUND_EXT = /(\.tar\.(gz|bz2|xz|zst|lz|lzma|z))$/i;

/** `name (n).ext`, the way desktop file managers rename duplicates. */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name;
  const compound = COMPOUND_EXT.exec(name);
  const dot = name.lastIndexOf('.');
  const ext = compound ? compound[1] : dot > 0 ? name.slice(dot) : '';
  const suffix = ` (${n})`;
  const stem = name.slice(0, name.length - ext.length).slice(0, MAX_SEGMENT - suffix.length - ext.length);
  return `${stem}${suffix}${ext}`;
}

/** A safe default file name from the URL's last path segment. */
export function fileNameFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let name: string;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  name = name.replace(/[\\/]/g, '_').replace(BAD_CHARS, '_').replace(/[. ]+$/, '').slice(0, MAX_SEGMENT);
  if (!name || name === '.' || name === '..' || WINDOWS_RESERVED.test(name)) return 'download';
  return name;
}
