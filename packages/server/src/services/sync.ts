import * as fs from 'fs';
import * as path from 'path';
import { database, withDbLock } from '../db/index.js';
import { getGameRoot, resolveGameFile, requireGameTitle, PathRuleError } from '../utils/path.js';
import { isApiError, type ApiError } from '../utils/apiError.js';
import { applySavesArchive, archiveLimits } from './archive.js';
import { validateRelativeSavePath } from '@dune/shared/pathRules';
import { syncLocalFolder, findSaveFolders } from './localScanner.js';
import { triggerRemoteSync } from './remoteSync.js';
import { invalidateGame } from './manifest.js';
import { logger } from '../middleware/logging.js';

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

/** Keep the newest `maxVersions` numeric upload snapshots. */
function pruneUploadVersions(root: string, maxVersions: number): void {
  const versionsRoot = path.join(root, '.versions');
  if (!fs.existsSync(versionsRoot)) return;
  const versions = fs.readdirSync(versionsRoot)
    .filter(v => /^\d+$/.test(v))
    .sort((a, b) => Number(b) - Number(a));
  for (const v of versions.slice(maxVersions)) {
    fs.rmSync(path.join(versionsRoot, v), { recursive: true, force: true });
  }
}

export interface UploadOptions {
  /**
   * DUN-091: true for a server-to-server push (x-dune-relay header). The
   * receiving server stores it but never re-pushes, so peers that list each
   * other can't ping-pong forever.
   */
  relay?: boolean;
}

/**
 * Version snapshots live at `.versions/<versionId>`, so the id becomes a
 * directory name. It arrives from the `x-sync-id` header (attacker-controlled),
 * so accept digits only: anything else would let `../../x` escape the game
 * root via path.join normalization. Non-numeric ids fall back to "now".
 */
function safeVersionId(syncId: string): string {
  return /^\d{1,20}$/.test(syncId) ? syncId : Date.now().toString();
}

export interface SyncProgress {
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: SyncProgress) => void;

// NOTE: Server-side sync/restore are not implemented; the client implements
// its own push/restore logic via REST. These are kept for tRPC completeness
// and throw if accidentally invoked.

export async function performCloudSyncWithProgress(
  _credentials: { url: string },
  _progress: ProgressCallback
): Promise<{ success: boolean; message: string }> {
  throw new Error('Server-side sync not implemented — client pushes to server');
}

export async function performCloudRestoreWithProgress(
  _credentials: { url: string },
  _progress: ProgressCallback
): Promise<{ success: boolean; message: string }> {
  throw new Error('Server-side restore not implemented — client pulls from server');
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
  let finalPath = '';

  const maxUploadBytes =
    Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '500', 10)) * 1024 * 1024;
  const maxFilesPerGame =
    Math.max(1, parseInt(process.env.MAX_FILES_PER_GAME || '5000', 10));

  try {
    // DUN-086/093: shared lexical rules + symlink-safe strict containment.
    // Only the validated pieces are used below, never the raw filePath.
    const title = requireGameTitle(gameName);
    // Lexical path check before any DB write, so a rejected path never
    // creates a phantom game row.
    const lexical = validateRelativeSavePath(filePath);
    if (!lexical.ok) throw new PathRuleError(lexical.code, lexical.message);
    const game = await withDbLock(() => database.ensureGame(ownerId, title));
    const target = resolveGameFile(game.id, filePath, ownerId);
    finalPath = target.abs;
    const finalDir = path.dirname(finalPath);

    // DUN-089: saves.zip (only at the game root) is an archive to apply,
    // never a file to keep. Anything else is a plain save file.
    const isArchive = target.rel === 'saves.zip';
    const existingFiles = countGameFiles(target.root);
    if (!isArchive && !fs.existsSync(finalPath) && existingFiles >= maxFilesPerGame) {
      return { success: false, message: `Game already has ${maxFilesPerGame} files`, status: 413 };
    }
    const maxVersions = database.getSettings().maxVersions || 10;

    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }

    if (!isArchive && fs.existsSync(finalPath)) {
      // Snapshot the file about to be overwritten (validated path).
      const archivePath = resolveGameFile(game.id, `.versions/${safeVersionId(syncId)}/${target.rel}`, ownerId).abs;
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.copyFileSync(finalPath, archivePath);
    }

    // Stream to a temp file first, then atomically rename onto the target.
    // Writing directly to `finalPath` (truncating) would destroy a previously
    // valid save if the upload fails partway through.
    const tmpPath = finalPath + '.uploading';
    try { fs.unlinkSync(tmpPath); } catch { /* no prior temp */ }

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
          try { fs.unlinkSync(tmpPath); } catch { /* partial temp cleanup */ }
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
      try {
        await applySavesArchive({
          archive: tmpPath,
          gameId: game.id,
          ownerId,
          versionId: safeVersionId(syncId),
          limits: archiveLimits(maxFilesPerGame),
          existingFileCount: existingFiles,
          maxFilesPerGame,
        });
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
      }
    } else {
      // Atomic publish: only replace the live file once the full upload succeeded.
      fs.renameSync(tmpPath, finalPath);
    }
    pruneUploadVersions(target.root, maxVersions);

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
    if (finalPath) {
      try { fs.unlinkSync(finalPath + '.uploading'); } catch { /* no temp */ }
    }
    if (isApiError(error)) {
      return { success: false, message: error.message, status: error.status, error };
    }
    if (finalPath) {
      try { fs.unlinkSync(finalPath + '.uploading'); } catch { /* no temp */ }
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('exceeds') || message.includes('already has') ? 413 : undefined;
    return status ? { success: false, message, status } : { success: false, message };
  }
}

export async function handleLocalSync(ownerId?: string): Promise<{ success: boolean; count: number; games: string[]; errors: string[] }> {
  const settings = database.getSettings();
  const sources = settings.localSources || [];
  const maxVersions = settings.maxVersions || 10;
  const ownerIdResolved = ownerId ?? database.listUsers().find(u => u.role === 'admin')?.id;
  if (!ownerIdResolved) return { success: false, count: 0, games: [], errors: ['No owner for local sync'] };
  let totalFilesSynced = 0;
  const syncedGames: Array<{ id: number; name: string }> = [];
  const errors: string[] = [];

  // Use a single lock for the entire local sync operation to prevent
  // race conditions between concurrent syncs (from auto-sync + manual trigger)
  return withDbLock(async () => {
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
        const gameName = path.basename(gamePath);
        let result;
        let game;
        let created = false;
        try {
          // Folder basename is the title; the row (and so the id folder)
          // exists before any file is copied (DUN-086/093).
          const title = requireGameTitle(gameName);
          const existing = database.findGame(ownerIdResolved, title);
          game = existing ?? database.ensureGame(ownerIdResolved, title);
          created = !existing;
          result = syncLocalFolder(gamePath, getGameRoot(game.id, ownerIdResolved), maxVersions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, game: gameName }, 'Local sync folder failed');
          errors.push(`${gameName}: ${message}`);
          if (game && created) {
            database.deleteGame(game.id, ownerIdResolved);
            try { fs.rmSync(getGameRoot(game.id, ownerIdResolved), { recursive: true, force: true }); } catch { /* none */ }
          }
          continue;
        }

        if (result.filesSynced > 0) {
          totalFilesSynced += result.filesSynced;
          syncedGames.push({ id: game.id, name: game.name });
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