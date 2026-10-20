import * as nodePath from 'path';

// DUN-065: folders that are never a game's save folder. A save path equal to
// one of these (or to an ancestor of the home folder) would make sync upload,
// restore overwrite, and deletions act on the whole folder.

export interface ProtectedRootContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/** Relative to a user folder (real home or a Wine/Proton `drive_c/users/<u>`), lower case, '/'-joined. */
const USER_RELATIVE = new Set([
  '',
  'documents',
  'my documents',
  'documents/my games',
  'my documents/my games',
  'saved games',
  'appdata',
  'appdata/roaming',
  'appdata/local',
  'appdata/locallow',
  'application data',
  'local settings',
  'local settings/application data',
  'desktop',
  'downloads',
  'pictures',
  'music',
  'videos',
  '.local',
  '.local/share',
  '.config',
  '.cache',
  '.steam',
  '.steam/steam',
  '.var',
  '.var/app',
  'library',
  'library/application support',
  'library/preferences',
  'library/containers',
  'games',
]);

function flavour(platform: NodeJS.Platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function norm(p: string, platform: NodeJS.Platform): string {
  const f = flavour(platform);
  const resolved = f.resolve(p);
  const stripped = resolved.length > f.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  return platform === 'win32' || platform === 'darwin' ? stripped.toLowerCase() : stripped;
}

function relUnder(parent: string, child: string, platform: NodeJS.Platform): string | null {
  const f = flavour(platform);
  const rel = f.relative(parent, child);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + f.sep) || f.isAbsolute(rel)) return null;
  return rel.split(/[\\/]+/).join('/');
}

/**
 * True when `candidate` is a well-known shared folder (home, Documents,
 * AppData, My Games, Saved Games, XDG dirs, a Wine user folder, a drive or
 * filesystem root, or any ancestor of home) and so must never be a save path.
 */
export function isProtectedSaveRoot(candidate: string, ctx: ProtectedRootContext): boolean {
  const { platform } = ctx;
  const f = flavour(platform);
  if (typeof candidate !== 'string' || candidate.trim() === '') return true;
  const c = norm(candidate, platform);
  if (c === norm(f.parse(c).root || f.sep, platform)) return true;

  const home = norm(ctx.home, platform);
  // home and its ancestors (/, /home, C:\Users)
  if (relUnder(c, home, platform) !== null) return true;

  const userRoots = [home];
  // Windows user folders (C:\Users\<u>) and Wine/Proton ones (.../drive_c/users/<u>).
  const segs = c.split(/[\\/]+/);
  const lower = segs.map((s) => s.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    const last = i === lower.length - 1;
    if (lower[i] === 'drive_c' && last) return true;
    const isUsers = lower[i] === 'users' && i > 0 && (lower[i - 1] === 'drive_c' || (platform === 'win32' && i === 1));
    if (!isUsers) continue;
    if (last) return true;
    userRoots.push(segs.slice(0, i + 2).join(f.sep));
  }

  const env = ctx.env;
  const extra = [env.APPDATA, env.LOCALAPPDATA, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.PUBLIC, env.ProgramData, env.ALLUSERSPROFILE, env.USERPROFILE, env.WINDIR]
    .filter((v): v is string => typeof v === 'string' && v !== '');
  for (const e of extra) if (norm(e, platform) === c) return true;

  for (const root of userRoots) {
    const rel = relUnder(root, c, platform);
    if (rel !== null && USER_RELATIVE.has(rel.toLowerCase())) return true;
  }
  return false;
}
