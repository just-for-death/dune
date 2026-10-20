/**
 * One-time, idempotent migration of the client's local game store (DUN-001).
 *
 * Before this fix, scanners wrote install folders (or, for Lutris, the
 * executable) into Game.winPath / Game.linPath, which save sync reads. Rule:
 *
 *  - Only scanner-sourced games are touched: `source` or `sourceId` is one of
 *    steam, heroic, lutris, epic, gog, ubisoft, ea, battlenet, xbox, minecraft.
 *    Manual entries, emulator entries and source-less entries (legacy
 *    manifest "autodetect" results, which already hold save paths) are left
 *    exactly as they are.
 *  - Every scanner game is re-resolved, whether or not its path "looks" like
 *    an install folder:
 *      1. If `installPath` is empty, the legacy path (this platform's field
 *         first, then the other one) becomes `installPath` - unless it equals
 *         `executable` (Lutris fallback) or it is exactly the save path the
 *         manifest resolves for this game (the old Steam scanner stored real
 *         save paths).
 *      2. Steam games are matched to the installed library (by app id, else
 *         name) to fill a missing `steamAppId` / `installPath`.
 *      3. winPath/linPath are replaced by the manifest save path for this
 *         platform, or emptied when the manifest has no existing save path.
 *  - With no manifest available the migration does nothing and is retried on
 *    the next launch (we never clear a path we could not re-resolve).
 *
 * Re-running is a no-op: step 1 only fires while installPath is empty, and
 * steps 2-3 are deterministic for the same manifest + disk state.
 *
 * Backup: before the migrated games are written, the store file is copied
 * once (exclusive create, never overwritten) to
 * `<store>.pre-migration-v<N>.<ISO timestamp with ':' -> '-'>.json` next to it.
 * No backup is made when nothing changes, when the marker is already set or
 * when a v<N> backup already exists. If the backup fails, nothing is written
 * (marker stays unset) and the migration is retried on the next launch.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Game } from '@dune/shared';
import { normalizeGameName, toSaveFields, type SaveResolver } from './savePaths.js';
import { getProtonUserDirs, type SteamLibraryGame } from './steam.js';

export const GAMES_MIGRATION_VERSION = 1;
export const GAMES_MIGRATION_KEY = 'gamesMigrationVersion';

export const SCANNER_SOURCES = new Set([
  'steam', 'heroic', 'lutris', 'epic', 'gog', 'ubisoft', 'ea', 'battlenet', 'xbox', 'minecraft',
]);

export function isScannerGame(game: Pick<Game, 'source' | 'sourceId'>): boolean {
  return SCANNER_SOURCES.has(game.source ?? '') || SCANNER_SOURCES.has(game.sourceId ?? '');
}

function sourceOf(game: Game): string {
  return SCANNER_SOURCES.has(game.source ?? '') ? game.source as string : (game.sourceId ?? '');
}

export interface MigrationContext {
  /** Installed Steam library games (for app id / install folder / Proton prefix). */
  steamGames?: SteamLibraryGame[];
}

function findSteamGame(game: Game, steamGames: SteamLibraryGame[]): SteamLibraryGame | undefined {
  if (game.steamAppId) {
    const byId = steamGames.find(g => g.appId === game.steamAppId);
    if (byId) return byId;
  }
  const name = normalizeGameName(game.name);
  return steamGames.find(g => normalizeGameName(g.name) === name);
}

export function migrateGame(game: Game, resolver: SaveResolver, ctx: MigrationContext = {}): Game {
  if (!isScannerGame(game)) return game;
  const platform = resolver.platform;
  const source = sourceOf(game);
  const next: Game = { ...game };

  const steam = source === 'steam' ? findSteamGame(game, ctx.steamGames ?? []) : undefined;
  if (steam && !next.steamAppId) next.steamAppId = steam.appId;

  const lookup = () => ({
    name: next.name,
    steamAppId: next.steamAppId,
    installPath: next.installPath || undefined,
    winePrefix: next.winePrefix,
    extraRoots: steam ? getProtonUserDirs(steam.libraryPath, steam.appId) : undefined,
    tokens: steam ? { root: steam.libraryPath, game: steam.installDir || undefined, storeGameId: steam.appId } : undefined,
  });

  if (!next.installPath) {
    const legacy = platform === 'win32'
      ? (game.winPath || game.linPath)
      : (game.linPath || game.winPath);
    if (legacy && legacy !== game.executable && legacy !== resolver.resolve(lookup())) {
      next.installPath = legacy;
    } else if (steam?.installPath) {
      next.installPath = steam.installPath;
    }
  }
  if (!next.installPath && steam?.installPath) next.installPath = steam.installPath;

  Object.assign(next, toSaveFields(resolver.resolve(lookup()), platform));
  return next;
}

export function migrateStoredGames(games: Game[], resolver: SaveResolver, ctx: MigrationContext = {}): { games: Game[]; changed: number } {
  let changed = 0;
  const out = games.map((game) => {
    const migrated = migrateGame(game, resolver, ctx);
    if (JSON.stringify(migrated) !== JSON.stringify(game)) changed++;
    return migrated;
  });
  return { games: out, changed };
}

export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface RunMigrationOptions extends MigrationContext {
  /** Lazily build the resolver (loads the manifest); return null when unavailable. */
  getResolver: () => Promise<SaveResolver | null>;
  /** Re-run even if the version marker says it already ran. */
  force?: boolean;
  /** Path of the on-disk store file (electron-store: `store.path`); backed up before writing. */
  storePath: string;
  /** Clock for the backup timestamp (injectable for tests). */
  now?: () => Date;
  /** Exclusive copy used for the backup (injectable for tests); must never overwrite `dest`. */
  copyFileExclusive?: (src: string, dest: string) => void;
}

export type MigrationResult =
  | { status: 'migrated'; changed: number; backupPath?: string }
  | { status: 'skipped'; reason: 'already-migrated' | 'no-scanner-games' | 'no-manifest' }
  | { status: 'failed'; reason: 'backup-failed'; error: string };

const BACKUP_TAG = `pre-migration-v${GAMES_MIGRATION_VERSION}`;

/** `<store>.pre-migration-v1.<ISO timestamp, filename-safe>.json` */
export function preMigrationBackupPath(storePath: string, now: Date): string {
  const stamp = now.toISOString().replace(/:/g, '-');
  return `${storePath}.${BACKUP_TAG}.${stamp}.json`;
}

/** Existing backups for this migration version next to the store file. */
export function findPreMigrationBackups(storePath: string): string[] {
  const dir = path.dirname(storePath);
  const prefix = `${path.basename(storePath)}.${BACKUP_TAG}.`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter(f => f.startsWith(prefix) && f.endsWith('.json')).map(f => path.join(dir, f));
}

const defaultCopyFileExclusive = (src: string, dest: string) =>
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);

/**
 * Create the one-time pre-migration backup unless one already exists.
 * Returns the backup path (new or existing). Throws if the copy fails; the
 * exclusive copy never overwrites an existing file (EEXIST instead).
 */
export function ensurePreMigrationBackup(
  storePath: string,
  now: () => Date = () => new Date(),
  copyFileExclusive: (src: string, dest: string) => void = defaultCopyFileExclusive,
): { path: string; created: boolean } {
  const existing = findPreMigrationBackups(storePath);
  if (existing.length > 0) return { path: existing.sort()[0], created: false };
  const dest = preMigrationBackupPath(storePath, now());
  copyFileExclusive(storePath, dest);
  return { path: dest, created: true };
}

/** Run the store migration once and persist the result (plus a version marker). */
export async function runStoredGamesMigration(store: KeyValueStore, options: RunMigrationOptions): Promise<MigrationResult> {
  const version = Number(store.get(GAMES_MIGRATION_KEY) ?? 0);
  if (!options.force && version >= GAMES_MIGRATION_VERSION) return { status: 'skipped', reason: 'already-migrated' };

  const initial = (store.get('games') ?? []) as Game[];
  if (!Array.isArray(initial) || !initial.some(isScannerGame)) {
    store.set(GAMES_MIGRATION_KEY, GAMES_MIGRATION_VERSION);
    return { status: 'skipped', reason: 'no-scanner-games' };
  }

  const resolver = await options.getResolver();
  if (!resolver) return { status: 'skipped', reason: 'no-manifest' };

  // Re-read after the async manifest load so we don't clobber concurrent edits.
  const games = (store.get('games') ?? []) as Game[];
  const { games: migrated, changed } = migrateStoredGames(games, resolver, options);
  if (changed === 0) {
    store.set(GAMES_MIGRATION_KEY, GAMES_MIGRATION_VERSION);
    return { status: 'migrated', changed };
  }

  // Never migrate without a backup: copy the untouched store file first.
  let backupPath: string;
  try {
    backupPath = ensurePreMigrationBackup(options.storePath, options.now, options.copyFileExclusive).path;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`Game store migration aborted: pre-migration backup of ${options.storePath} failed (will retry next launch):`, error);
    return { status: 'failed', reason: 'backup-failed', error };
  }

  store.set('games', migrated);
  store.set(GAMES_MIGRATION_KEY, GAMES_MIGRATION_VERSION);
  return { status: 'migrated', changed, backupPath };
}

/** Tiny JSON-file store (same on-disk shape as electron-store) used by tests and tooling. */
export function jsonFileStore(filePath: string): KeyValueStore {
  const read = (): Record<string, unknown> =>
    fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown> : {};
  return {
    get: (key) => read()[key],
    set: (key, value) => {
      const data = read();
      data[key] = value;
      fs.writeFileSync(filePath, JSON.stringify(data, null, '\t'));
    },
  };
}
