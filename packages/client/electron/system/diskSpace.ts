/**
 * Disk-space lookup for the `system:diskSpace` IPC.
 *
 * Result shape (see `DriveSpace` in @dune/shared):
 * - One entry per distinct device (`fs.stat().dev`). `paths` lists every requested
 *   folder that sits on that device, in the original requested form, deduped and in
 *   request order. That is the `path` we report: the caller's own strings, so the UI
 *   can match them back without re-normalising.
 * - `mount` is the mount point from /proc/self/mountinfo on Linux; elsewhere (or when
 *   mountinfo is unreadable) it is the nearest existing ancestor of the group's first path.
 * - `label` is only set when /dev/disk/by-label (Linux) names the mount's source device.
 * - Paths that fail are grouped by reason into `unavailable` entries. Raw OS messages
 *   go to the injected logger, never into the result. Nothing here throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DriveSpace, DriveSpaceUnavailableReason, Game } from '@dune/shared';
import { getSteamLibraryFolders, getSteamPath } from '../scanner/steam';

/** Max entries accepted from the renderer. */
export const MAX_DISK_SPACE_PATHS = 256;
/** Max length of one requested path (longer is rejected as invalid input). */
const MAX_PATH_LENGTH = 4096;
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'darwin', 'win32', 'freebsd', 'openbsd'];

type BigStatFs = { bsize: bigint; blocks: bigint; bavail: bigint };

export interface DiskSpaceDeps {
  statfs?: (p: string, opts: { bigint: true }) => Promise<BigStatFs>;
  stat: (p: string) => Promise<{ dev: bigint }>;
  realpath: (p: string) => Promise<string>;
  readFile: (p: string) => Promise<string>;
  readdir: (p: string) => Promise<string[]>;
  platform: NodeJS.Platform;
  log: (message: string) => void;
}

export const defaultDiskSpaceDeps: DiskSpaceDeps = {
  statfs: typeof fs.promises.statfs === 'function'
    ? (p, opts) => fs.promises.statfs(p, opts)
    : undefined,
  stat: async (p) => ({ dev: (await fs.promises.stat(p, { bigint: true })).dev }),
  realpath: (p) => fs.promises.realpath(p),
  readFile: (p) => fs.promises.readFile(p, 'utf8'),
  readdir: (p) => fs.promises.readdir(p),
  platform: process.platform,
  log: (message) => console.warn(`[diskSpace] ${message}`),
};

/** Map an fs error to the shared reason enum. */
export function reasonFromError(err: unknown): DriveSpaceUnavailableReason {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not-found';
    case 'EACCES':
    case 'EPERM':
      return 'permission';
    case 'ENOSYS':
    case 'ENOTSUP':
    case 'EOPNOTSUPP':
      return 'unsupported';
    default:
      return 'error';
  }
}

function describe(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return typeof code === 'string' ? `${code}: ${msg}` : msg;
}

/** BigInt -> number only when exact; otherwise null (never fabricate). */
function toSafeNumber(v: bigint): number | null {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(v);
}

export type ValidatedInput =
  | { kind: 'defaults' }
  | { kind: 'rejected' }
  | { kind: 'paths'; valid: string[]; invalid: string[] };

/**
 * Validate renderer input. `undefined` means "use defaults". A non-array or an array
 * over MAX_DISK_SPACE_PATHS is rejected (empty result). Non-string items are dropped;
 * empty, relative, NUL-containing or over-long strings are returned as `invalid`.
 */
export function validateDiskSpaceInput(input: unknown, platform: NodeJS.Platform = process.platform): ValidatedInput {
  if (input === undefined) return { kind: 'defaults' };
  if (!Array.isArray(input) || input.length > MAX_DISK_SPACE_PATHS) return { kind: 'rejected' };
  const p = platform === 'win32' ? path.win32 : path.posix;
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    const ok = item.length > 0 && item.length <= MAX_PATH_LENGTH && !item.includes('\0') && p.isAbsolute(item);
    (ok ? valid : invalid).push(item);
  }
  return { kind: 'paths', valid, invalid };
}

/**
 * Walk up from `p` to the nearest existing ancestor. Only ENOENT/ENOTDIR keep walking;
 * any other stat error (e.g. EACCES) is returned as-is.
 */
export async function resolveExistingAncestor(
  p: string,
  deps: Pick<DiskSpaceDeps, 'stat'>,
): Promise<{ existing: string; dev: bigint } | { error: unknown }> {
  let current = path.resolve(p);
  for (;;) {
    try {
      const st = await deps.stat(current);
      return { existing: current, dev: st.dev };
    } catch (err) {
      const reason = reasonFromError(err);
      const parent = path.dirname(current);
      if (reason !== 'not-found' || parent === current) return { error: err };
      current = parent;
    }
  }
}

interface MountInfoEntry { majorMinor: string; mountPoint: string; source: string }

/** Decode the octal escapes (\040 etc.) used in /proc/self/mountinfo. */
function unescapeMountField(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Parse /proc/self/mountinfo text. Malformed lines are skipped. */
export function parseMountInfo(text: string): MountInfoEntry[] {
  const out: MountInfoEntry[] = [];
  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(' ');
    const right = line.slice(sep + 3).split(' ');
    if (left.length < 5 || right.length < 2) continue;
    out.push({ majorMinor: left[2], mountPoint: unescapeMountField(left[4]), source: unescapeMountField(right[1]) });
  }
  return out;
}

/** Linux dev_t -> "major:minor" (glibc encoding, matches mountinfo field 3). */
export function linuxMajorMinor(dev: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}

function isUnder(child: string, parent: string): boolean {
  if (parent === '/') return child.startsWith('/');
  return child === parent || child.startsWith(parent + '/');
}

/**
 * Pick the mountinfo entry for a real path: the longest mount point containing it,
 * preferring entries whose major:minor equals the path's device.
 */
export function findMountEntry(entries: MountInfoEntry[], realPath: string, dev: bigint): MountInfoEntry | null {
  const mm = linuxMajorMinor(dev);
  const containing = entries.filter((e) => isUnder(realPath, e.mountPoint));
  const byLength = (a: MountInfoEntry, b: MountInfoEntry) => b.mountPoint.length - a.mountPoint.length;
  const exact = containing.filter((e) => e.majorMinor === mm).sort(byLength);
  if (exact.length > 0) return exact[0];
  return containing.sort(byLength)[0] ?? null;
}

/** Decode the \xHH escapes udev uses in /dev/disk/by-label names. */
function unescapeUdevLabel(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Volume label for a /dev/... source via /dev/disk/by-label, or undefined. Never guesses. */
async function linuxLabelFor(source: string, deps: DiskSpaceDeps, cache: Map<string, string> | null): Promise<string | undefined> {
  if (!source.startsWith('/dev/') || !cache) return undefined;
  let device: string;
  try { device = await deps.realpath(source); } catch { return undefined; }
  return cache.get(device);
}

async function loadLabels(deps: DiskSpaceDeps): Promise<Map<string, string> | null> {
  const dir = '/dev/disk/by-label';
  try {
    const names = await deps.readdir(dir);
    const map = new Map<string, string>();
    for (const name of names) {
      try {
        const target = await deps.realpath(path.join(dir, name));
        if (!map.has(target)) map.set(target, unescapeUdevLabel(name));
      } catch { /* dangling link: skip */ }
    }
    return map;
  } catch {
    return null;
  }
}

interface Group { dev: bigint; existing: string; paths: string[] }

/** Core lookup over already-validated absolute paths. Never throws. */
export async function lookupDiskSpace(
  validPaths: string[],
  invalidPaths: string[] = [],
  deps: DiskSpaceDeps = defaultDiskSpaceDeps,
): Promise<DriveSpace[]> {
  const unavailable = new Map<DriveSpaceUnavailableReason, string[]>();
  const fail = (reason: DriveSpaceUnavailableReason, p: string[]) => {
    const list = unavailable.get(reason) ?? [];
    for (const x of p) if (!list.includes(x)) list.push(x);
    unavailable.set(reason, list);
  };
  if (invalidPaths.length > 0) fail('error', invalidPaths);

  const finish = (ok: DriveSpace[]): DriveSpace[] => [
    ...ok,
    ...[...unavailable].map(([reason, paths]): DriveSpace => ({ paths, status: 'unavailable', reason })),
  ];

  if (validPaths.length === 0) return finish([]);
  if (!deps.statfs || !SUPPORTED_PLATFORMS.includes(deps.platform)) {
    deps.log(`statfs unsupported (platform=${deps.platform}, statfs=${typeof deps.statfs})`);
    fail('unsupported', validPaths);
    return finish([]);
  }

  // 1. Resolve each path to its nearest existing ancestor and group by device.
  const groups = new Map<string, Group>();
  for (const requested of validPaths) {
    const res = await resolveExistingAncestor(requested, deps);
    if ('error' in res) {
      deps.log(`stat ${requested}: ${describe(res.error)}`);
      fail(reasonFromError(res.error), [requested]);
      continue;
    }
    const key = res.dev.toString();
    const g = groups.get(key);
    if (g) { if (!g.paths.includes(requested)) g.paths.push(requested); }
    else groups.set(key, { dev: res.dev, existing: res.existing, paths: [requested] });
  }

  // 2. Linux mount table + labels, read at most once per call.
  let mountEntries: MountInfoEntry[] | null = null;
  let labels: Map<string, string> | null = null;
  if (deps.platform === 'linux' && groups.size > 0) {
    try { mountEntries = parseMountInfo(await deps.readFile('/proc/self/mountinfo')); }
    catch (err) { deps.log(`mountinfo unreadable: ${describe(err)}`); }
    if (mountEntries) labels = await loadLabels(deps);
  }

  // 3. statfs once per device.
  const ok: DriveSpace[] = [];
  for (const g of groups.values()) {
    let stats: BigStatFs;
    try {
      stats = await deps.statfs(g.existing, { bigint: true });
    } catch (err) {
      deps.log(`statfs ${g.existing}: ${describe(err)}`);
      fail(reasonFromError(err), g.paths);
      continue;
    }
    const free = toSafeNumber(stats.bavail * stats.bsize);
    const total = toSafeNumber(stats.blocks * stats.bsize);
    if (free === null || total === null || total <= 0 || free > total) {
      deps.log(`statfs ${g.existing}: unusable numbers bavail=${stats.bavail} blocks=${stats.blocks} bsize=${stats.bsize}`);
      fail(total === 0 ? 'unsupported' : 'error', g.paths);
      continue;
    }

    let mount = g.existing;
    let label: string | undefined;
    if (mountEntries) {
      let real = g.existing;
      try { real = await deps.realpath(g.existing); } catch { /* keep resolved path */ }
      const entry = findMountEntry(mountEntries, real, g.dev);
      if (entry) {
        mount = entry.mountPoint;
        label = await linuxLabelFor(entry.source, deps, labels);
      }
    }
    const result: DriveSpace = { paths: g.paths, mount, status: 'ok', freeBytes: free, totalBytes: total };
    if (label) result.label = label;
    ok.push(result);
  }
  return finish(ok);
}

export interface DefaultPathSources {
  games: Game[];
  /** Configured library roots (`settings.scanRoots`). */
  scanRoots: string[];
  /** Steam library folders (libraryfolders.vdf). */
  steamLibraries: string[];
  platform: NodeJS.Platform;
  expand: (p: string) => string;
}

/**
 * Default paths: library folders (Steam libraries + configured scan roots), then each
 * stored game's save folder (winPath on Windows, linPath elsewhere) and installPath.
 * Expanded, absolute only, deduped by normalised form (first spelling wins).
 */
export function buildDefaultDiskPaths(src: DefaultPathSources): string[] {
  const p = src.platform === 'win32' ? path.win32 : path.posix;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || raw.trim() === '') return;
    const expanded = src.expand(raw.trim());
    if (!expanded || !p.isAbsolute(expanded)) return;
    let key = p.normalize(expanded).replace(/[\\/]+$/, '') || p.sep;
    if (src.platform === 'win32' || src.platform === 'darwin') key = key.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(expanded);
  };
  src.steamLibraries.forEach(add);
  src.scanRoots.forEach(add);
  for (const g of src.games) {
    if (!g || typeof g !== 'object') continue;
    add(src.platform === 'win32' ? g.winPath : g.linPath);
    add(g.installPath);
  }
  return out.slice(0, MAX_DISK_SPACE_PATHS);
}

/** Real Steam library folders on this machine; [] if Steam isn't found. */
export function detectSteamLibraries(): string[] {
  try {
    const steamPath = getSteamPath();
    return steamPath ? getSteamLibraryFolders(steamPath).map((f) => f.path) : [];
  } catch {
    return [];
  }
}

/**
 * IPC entry point. `input` is untrusted renderer data. Resolves defaults lazily.
 * Always resolves; never rejects.
 */
export async function getDiskSpace(
  input: unknown,
  getDefaults: () => string[] | Promise<string[]>,
  deps: DiskSpaceDeps = defaultDiskSpaceDeps,
): Promise<DriveSpace[]> {
  try {
    const v = validateDiskSpaceInput(input, deps.platform);
    if (v.kind === 'rejected') return [];
    if (v.kind === 'defaults') return await lookupDiskSpace(await getDefaults(), [], deps);
    return await lookupDiskSpace(v.valid, v.invalid, deps);
  } catch (err) {
    try { deps.log(`unexpected: ${describe(err)}`); } catch { /* ignore */ }
    return [];
  }
}
