import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { database, withDbLock } from '../db/index.js';
import { getGameRoot, resolveGameFile, requireGameTitle, PathRuleError, ownerSavesRoot } from '../utils/path.js';
import { ApiError, isApiError } from '../utils/apiError.js';
import { pruneVersions, maxVersionsSetting } from './saveVersions.js';
import { applySavesArchive, archiveLimits } from './archive.js';
import { validateRelativeSavePath } from '@dune/shared/pathRules';
import { syncLocalFolder, findSaveFolders } from './localScanner.js';
import { triggerRemoteSync } from './remoteSync.js';
import { invalidateGame } from './manifest.js';
import { logger } from '../middleware/logging.js';
import type { Game, GameStoreIds } from '../types/index.js';

/** Files in a game root, excluding version history (per-game cap). */
function countGameFiles(root: string): number {
  let count = 0;
  if (!fs.existsSync(root)) return 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === '.versions') continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else count += 1;
    }
  }
  return count;
}

export interface UploadOptions {
  /**
   * DUN-091: true for a server-to-server push (x-dune-relay header). The
   * receiving server stores it but never re-pushes, so peers that list each
   * other can't ping-pong forever.
   */
  relay?: boolean;
  /** FEAT-server-storeIds: validated store ids to store on the game row (absent key = keep). */
  storeIds?: GameStoreIds;
}

/**
 * DUN-097: the sync id names this sync's snapshot dir `.versions/<syncId>`,
 * shared by every file of one client sync session (the client sends one id
 * per session). It becomes a directory name and arrives from the
 * `x-sync-id` header, so only digits (epoch ms) are accepted; anything else
 * is 400 INVALID_SYNC_ID instead of a fresh per-file id that would split one
 * session into many snapshots and let it prune its own backups.
 */
export const SYNC_ID = /^\d{1,20}$/;

export function requireSyncId(syncId: string): string {
  if (!SYNC_ID.test(syncId)) throw new ApiError(400, 'INVALID_SYNC_ID', 'x-sync-id must be a decimal timestamp');
  return syncId;
}

/**
 * Store one uploaded save file for the owner's game `gameName` (a display
 * title, matched case-insensitively). The game row is created first, then
 * the file is written under saves/<ownerId>/<gameId> (DUN-086/087/093).
 */
export async function handleUploadFile(
  gameName: string,
  filePath: string,
  fileStream: NodeJS.ReadableStream,
  syncId: string,
  ownerId: string,
  opts: UploadOptions = {},
): Promise<{ success: boolean; message: string; status?: number; error?: ApiError; gameId?: number }> {
  // DUN-111: validation runs inside the try so a rejected name/path is a 400
  // (PathRuleError), not an unhandled throw that the route turns into a 500.
  let stagingDir = '';

  const maxUploadBytes =
    Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '500', 10)) * 1024 * 1024;
  const maxFilesPerGame =
    Math.max(1, parseInt(process.env.MAX_FILES_PER_GAME || '5000', 10));

  try {
    // DUN-086/093: shared lexical rules + symlink-safe strict containment.
    // Only the validated pieces are used below, never the raw filePath.
    const title = requireGameTitle(gameName);
    const versionId = requireSyncId(syncId);
    // Lexical path check before any DB write, so a rejected path never
    // creates a phantom game row.
    const lexical = validateRelativeSavePath(filePath);
    if (!lexical.ok) throw new PathRuleError(lexical.code, lexical.message);
    const game = await withDbLock(() => database.ensureGame(ownerId, title, opts.storeIds));
    const target = resolveGameFile(game.id, filePath, ownerId);
    const finalPath = target.abs;
    const finalDir = path.dirname(finalPath);

    // DUN-089: saves.zip (only at the game root) is an archive to apply,
    // never a file to keep. Anything else is a plain save file.
    const isArchive = target.rel === 'saves.zip';
    const existingFiles = countGameFiles(target.root);
    if (!isArchive && !fs.existsSync(finalPath) && existingFiles >= maxFilesPerGame) {
      return { success: false, message: `Game already has ${maxFilesPerGame} files`, status: 413 };
    }
    const maxVersions = maxVersionsSetting();

    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }

    if (!isArchive && fs.existsSync(finalPath)) {
      // Snapshot the file about to be overwritten (validated path). The
      // first copy within one sync session wins: it is the pre-sync state.
      const archivePath = resolveGameFile(game.id, `.versions/${versionId}/${target.rel}`, ownerId).abs;
      if (!fs.existsSync(archivePath)) {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.copyFileSync(finalPath, archivePath);
      }
    }

    // Stream to a temp file first, then atomically rename onto the target.
    // Writing directly to `finalPath` (truncating) would destroy a previously
    // valid save if the upload fails partway through. DUN-101: the temp file
    // is private to this upload (random name in its own mkdtemp dir on the
    // same filesystem), so concurrent uploads of one path never share it;
    // the dir is always removed in `finally`.
    stagingDir = fs.mkdtempSync(path.join(ownerSavesRoot(ownerId), '.upload-'));
    const tmpPath = path.join(stagingDir, `${randomUUID()}.part`);

    await new Promise<void>((resolve, reject) => {
      const destroyStream = (s: unknown) => {
        const d = (s as { destroy?: () => void }).destroy;
        if (typeof d === 'function') d.call(s);
      };
      const fd = fs.openSync(tmpPath, 'w');
      const writer = fs.createWriteStream(tmpPath, { fd, autoClose: true });
      let bytes = 0;
      let rejected = false;
      fileStream.on('data', (chunk: Buffer) => {
        if (rejected) return;
        bytes += chunk.length;
        if (bytes > maxUploadBytes) {
          rejected = true;
          fileStream.unpipe(writer);
          destroyStream(fileStream);
          writer.destroy();
          reject(new Error(`File exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB limit`));
        }
      });
      fileStream.pipe(writer);
      fileStream.on('error', reject);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    if (isArchive) {
      // DUN-089: inspect, extract privately, snapshot overwrites, apply.
      // Failures throw ArchiveError (400/413); the archive is never kept.
      await applySavesArchive({
        archive: tmpPath,
        gameId: game.id,
        ownerId,
        versionId,
        limits: archiveLimits(maxFilesPerGame),
        existingFileCount: existingFiles,
        maxFilesPerGame,
      });
    } else {
      // Atomic publish: only replace the live file once the full upload succeeded.
      fs.renameSync(tmpPath, finalPath);
    }
    // DUN-097: one history per game (rows + snapshot dirs), never this sync's.
    pruneVersions(game.id, ownerId, maxVersions, [versionId]);

    // Fingerprints for this game are now stale (new/overwritten files).
    invalidateGame(game.id, ownerId);

    // Status update runs inside the lock: awaits above (streaming upload,
    // unzip) yield, so serialize with concurrent uploads. DUN-085: touch only
    // this game's row by key; never rewrite the games table (a bulk delete
    // cascades into every user's versions/conflicts/backup profiles).
    await withDbLock(() => {
      database.markGameSynced(game.id);
    });

    // DUN-091: re-push only uploads that came from a client, never a relay.
    if (!opts.relay) {
      setImmediate(() => {
        triggerRemoteSync([{ id: game.id, name: game.name }], ownerId).catch(err => logger.error({ err }, 'Remote sync error'));
      });
    }

    return { success: true, message: `Uploaded ${game.name} saves`, gameId: game.id };
  } catch (error: unknown) {
    if (isApiError(error)) {
      return { success: false, message: error.message, status: error.status, error };
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('exceeds') || message.includes('already has') ? 413 : undefined;
    return status ? { success: false, message, status } : { success: false, message };
  } finally {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Stable identity of a local-sync folder (DUN-100): its full normalized path. */
export function localSourceKey(gamePath: string): string {
  const resolved = path.resolve(gamePath);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
}

/**
 * DUN-100: the owner's game for one local-sync folder, keyed by the folder's
 * full normalized path (never its basename, so two `.../Saves` folders stay
 * two games). First sight of a folder binds it: to the owner's game with the
 * folder's name if no other folder is bound to that game, else to a new game
 * whose title is disambiguated with the parent folder name (then a counter).
 */
function gameForLocalFolder(ownerId: string, gamePath: string): { game: Game; created: boolean } {
  const key = localSourceKey(gamePath);
  const bound = database.getLocalSyncGame(ownerId, key);
  if (bound) return { game: bound, created: false };

  const base = requireGameTitle(path.basename(key));
  const parent = path.basename(path.dirname(key));
  const candidates = [base];
  if (parent) candidates.push(`${base} (${parent})`);
  for (let n = 2; n <= 100; n += 1) candidates.push(`${base} (${parent ? `${parent} ` : ''}${n})`);

  for (const candidate of candidates) {
    const title = requireGameTitle(candidate.slice(0, 200));
    const existing = database.findGame(ownerId, title);
    if (existing && database.isGameBoundToOtherFolder(ownerId, existing.id, key)) continue;
    const game = existing ?? database.ensureGame(ownerId, title);
    database.bindLocalSyncGame(ownerId, key, game.id);
    return { game, created: !existing };
  }
  throw new ApiError(409, 'GAME_TITLE_CONFLICT', `No free title for local folder ${base}`);
}

export async function handleLocalSync(ownerId?: string): Promise<{ success: boolean; count: number; games: string[]; errors: string[] }> {
  const settings = database.getSettings();
  const sources = settings.localSources || [];
  const maxVersions = maxVersionsSetting();
  const ownerIdResolved = ownerId ?? database.listUsers().find(u => u.role === 'admin')?.id;
  if (!ownerIdResolved) return { success: false, count: 0, games: [], errors: ['No owner for local sync'] };
  let totalFilesSynced = 0;
  const syncedGames: Array<{ id: number; name: string }> = [];
  const errors: string[] = [];

  // Use a single lock for the entire local sync operation to prevent
  // race conditions between concurrent syncs (from auto-sync + manual trigger)
  return withDbLock(async () => {
    // DUN-097: one sync id for the whole local-sync session.
    const syncId = Date.now().toString();
    for (const source of sources) {
      if (!fs.existsSync(source.path)) continue;

      let gamesInSource: string[];
      try {
        gamesInSource = findSaveFolders(source.path, 3);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, source: source.path }, 'Local sync scan failed');
        errors.push(`${source.path}: ${message}`);
        continue;
      }
      for (const gamePath of gamesInSource) {
        const folderName = path.basename(gamePath);
        let result;
        let game: Game | undefined;
        let created = false;
        try {
          // The row (and so the id folder) exists before any file is copied (DUN-086/093).
          ({ game, created } = gameForLocalFolder(ownerIdResolved, gamePath));
          result = syncLocalFolder(gamePath, getGameRoot(game.id, ownerIdResolved), syncId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, game: folderName }, 'Local sync folder failed');
          errors.push(`${folderName}: ${message}`);
          if (game && created) {
            database.deleteGame(game.id, ownerIdResolved);
            try { fs.rmSync(getGameRoot(game.id, ownerIdResolved), { recursive: true, force: true }); } catch { /* none */ }
          }
          continue;
        }

        if (result.filesSynced > 0) {
          totalFilesSynced += result.filesSynced;
          syncedGames.push({ id: game.id, name: game.name });
          pruneVersions(game.id, ownerIdResolved, maxVersions, [syncId]);
          invalidateGame(game.id, ownerIdResolved);
          // Status only: thumbnail/analysis are preserved.
          database.markGameSynced(game.id);
        } else if (created) {
          // Nothing to sync for a brand-new game: don't leave an empty row/folder.
          database.deleteGame(game.id, ownerIdResolved);
          fs.rmSync(getGameRoot(game.id, ownerIdResolved), { recursive: true, force: true });
        }
      }
    }

    if (syncedGames.length > 0) {
      const uniqueGames = [...new Map(syncedGames.map((g) => [g.id, g])).values()];
      setImmediate(() => {
        triggerRemoteSync(uniqueGames, ownerIdResolved).catch(err => logger.error({ err }, 'Remote sync error'));
      });
    }

    if (totalFilesSynced === 0 && errors.length > 0) {
      return { success: false, count: 0, games: syncedGames.map((g) => g.name), errors };
    }
    return { success: true, count: totalFilesSynced, games: syncedGames.map((g) => g.name), errors };
  });
}
