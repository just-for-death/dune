import * as nodePath from 'path';
import * as fs from 'fs';
import { validateRelativeSavePath } from '@dune/shared/pathRules';

// DUN-060: the restore handler writes files whose relative paths come from
// the Dune Server. The server (often plain http on the LAN) is untrusted for
// this purpose, so every path is validated here before any mkdir or write.
// This module is pure apart from the injected lstat/realpath calls, so it can
// be unit-tested against a temp dir or fake fs.

/** Minimal fs surface used for the symlink / realpath checks. */
export interface RestoreTargetDeps {
  /** Defaults to process.platform. Controls path flavour and case folding. */
  platform?: NodeJS.Platform;
  /** fs.lstatSync-compatible: throws an error with code 'ENOENT' when missing. */
  lstat?: (p: string) => { isSymbolicLink(): boolean; isDirectory(): boolean };
  /** fs.realpathSync-compatible. */
  realpath?: (p: string) => string;
}

export type RestoreTargetResult =
  | { ok: true; target: string }
  | { ok: false; reason: string };

function reject(reason: string): RestoreTargetResult {
  return { ok: false, reason };
}

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * True when `child` is strictly inside `parent` (never equal). Both must be
 * absolute and already normalized for `p`. Case-insensitive on win32.
 */
export function isStrictlyInside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const parentN = fold(p.resolve(parent));
  const childN = fold(p.resolve(child));
  if (childN === parentN) return false;
  // Compare with a trailing separator so '/root' never matches '/root-evil'.
  const prefix = parentN.endsWith(p.sep) ? parentN : parentN + p.sep;
  if (!childN.startsWith(prefix)) return false;
  const rel = p.relative(parentN, childN);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel);
}

function isSameOrInside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  return fold(p.resolve(parent)) === fold(p.resolve(child)) || isStrictlyInside(parent, child, platform);
}

/**
 * Resolve a server-supplied relative save path against the local restore
 * root. Returns the absolute target only if it is provably inside the root;
 * otherwise a rejection with a human-readable reason.
 */
export function resolveRestoreTarget(
  restoreRoot: string,
  serverPath: unknown,
  deps: RestoreTargetDeps = {},
): RestoreTargetResult {
  const platform = deps.platform ?? process.platform;
  const p = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const lstat = deps.lstat ?? ((x: string) => fs.lstatSync(x));
  const realpath = deps.realpath ?? ((x: string) => fs.realpathSync.native(x));

  // ── Lexical checks: the shared rules (DUN-086), same as the server ─────
  // validateRelativeSavePath rejects absolute/UNC/drive paths, NUL, empty,
  // '.' and '..' segments (inner ones too) and, on every platform, the
  // Windows rules (colons, device names, trailing dots/spaces). A Linux
  // server may hold files a Windows client restores, and vice versa.
  if (typeof serverPath !== 'string') return reject('path is not a string');
  const lexical = validateRelativeSavePath(serverPath);
  if (!lexical.ok) return reject(`${lexical.message} (${lexical.code})`);
  const segments = lexical.value.split('/');

  // ── Canonicalize and require strict containment ────────────────────────
  if (typeof restoreRoot !== 'string' || restoreRoot === '' || !p.isAbsolute(restoreRoot)) {
    return reject('restore root is not an absolute path');
  }
  const root = p.resolve(restoreRoot);
  const target = p.resolve(root, ...segments);
  if (!isStrictlyInside(root, target, platform)) return reject('path escapes the restore root');

  // ── Filesystem checks: no symlinks between root and target ────────────
  // The root itself (and its ancestors) may legitimately be symlinks, e.g.
  // Proton prefixes; only components below the root are checked, and the
  // realpath comparison below uses the root's own realpath.
  let rootExists: boolean;
  try {
    lstat(root);
    rootExists = true;
  } catch (err) {
    if (!isNotFound(err)) return reject(`cannot inspect restore root: ${(err as Error).message}`);
    rootExists = false;
  }
  if (!rootExists) {
    // Nothing below a missing root can exist, so there is no link to follow;
    // mkdir will create real directories.
    return { ok: true, target };
  }

  let nearestExisting = root;
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = p.join(current, segments[i]);
    let st: { isSymbolicLink(): boolean; isDirectory(): boolean };
    try {
      st = lstat(current);
    } catch (err) {
      if (isNotFound(err)) break;
      return reject(`cannot inspect '${current}': ${(err as Error).message}`);
    }
    if (st.isSymbolicLink()) return reject(`'${p.relative(root, current)}' is a symlink`);
    const isLast = i === segments.length - 1;
    if (!isLast && !st.isDirectory()) return reject(`'${p.relative(root, current)}' is not a directory`);
    if (isLast && st.isDirectory()) return reject('target is an existing directory');
    nearestExisting = current;
  }

  let realRoot: string;
  let realNearest: string;
  try {
    realRoot = realpath(root);
    realNearest = realpath(nearestExisting);
  } catch (err) {
    return reject(`cannot resolve real path: ${(err as Error).message}`);
  }
  if (!isSameOrInside(realRoot, realNearest, platform)) {
    return reject('real path of an existing component escapes the restore root');
  }
  return { ok: true, target };
}
