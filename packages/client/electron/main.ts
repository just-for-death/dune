import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, protocol, safeStorage, session, net, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import Store from 'electron-store'
import AdmZip from 'adm-zip'
import { nextId, DEFAULT_TRACKERS_ENABLED } from '@dune/shared'
import type { FileManifest, HashManifest, Game, Settings, Cloud, CloudSyncResult, FetchArtResult, ImportLocalAchievementsResult, ProviderKeyStatusResult, RestoreBackupInfo, ScannerSourceToggles, ServerFailure, ServerResult, SyncFailureItem } from '@dune/shared'
import { fullScan, gameRegistry } from './scanner/registry'
import { applyScannerSources, listScannerSources, sanitizeScannerSources, setScannerSource } from './scanner/sourceToggles'
import { createSaveResolver, loadManifest } from './scanner/savePaths'
import { getInstalledSteamLibraryGames, getSteamPath } from './scanner/steam'
import { runStoredGamesMigration } from './scanner/migrateStore'
import { createLaunchIpcHandlers, parseGameId } from './launcher/byId'
import { createGameSettingsIpcHandlers, saveRendererGames, type GameSettingsDeps } from './launcher/gameSettings'
import { buildPlaytimeSession, enqueuePlaytimeSession, MAX_PENDING_SESSIONS, type PlaytimeSessionPayload } from './playtime/session'
import { createPlaytimeFlushGate } from './sync/serverUrl'
import { runAutoSync } from './sync/autoSync'
import { listGameSaveFiles } from './sync/saveFiles'
import { resolveRestoreTarget } from './sync/restoreTarget'
import { writeRestoreFiles, type RestoreRejection } from './sync/restoreWrite'
import { acceptsRelativePath, listSaveFiles, resolveSaveTarget } from './sync/saveTarget'
import { backupLocalFiles, fingerprintOf, planRestore } from './sync/restorePlan'
import { commitGameStatusPatches, type GameStatusPatch } from './sync/gameStatus'
import { uploadFileHeaders, type UploadStoreIds } from './net/uploadHeaders'
import { backfillStoreIds } from './scanner/storeIds'
import { ServerCallError, failureFromResponse, toServerFailure } from './net/serverError'
import { createServerClient, createServerHttp } from './net/serverClient'
import { createServerIpcHandlers } from './net/serverHandlers'
import { createServerKeyVault, type SafeStorageLike } from './security/serverKey'
import { createUpdateController, type UpdaterLike } from './system/updater'
import { fetchArtViaServer } from './art/fetchArt'
import { createElectronLocalProviders } from './providers/electron'
import { createProviderRouting, type HltbIpcResult, type SearchArtIpcResult } from './providers/routing'
import { buildExpandContext } from './manifest/expand'
import { createLocalManifestLookup, type LocalManifestLookup } from './manifest/local'
import { createManifestSuggestions } from './manifest/suggestions'
import { setGameSavePath } from './manifest/savePath'
import type { LocalProviders } from './providers/localProviders'
import { isUpdateCheckEnabled } from './providers/updateFlag'
import { getAchievementRoots, scanLocalAchievements } from './achievements/local'
import { discoverPrefixes, defaultDiscoverDeps, openDiscoveredPrefix } from './prefix/manager'
import { createNavigationGuards } from './security/navigation'
import { importLocalAchievementsFromDisk } from './achievements/import'
import { PrefixRegistry, createPrefixIpcHandlers, defaultPrefixRegistryPaths, isStrictlyInside } from './prefix/registry'
import { getDiskSpace, buildDefaultDiskPaths, detectSteamLibraries } from './system/diskSpace'
import { autoUpdater } from 'electron-updater'
import { createDownloadsIpcHandlers, createDownloadsQuitHandler, forwardDownloadEvents, openDownloads, type DownloadManagerLike, type DownloadsSettingsStore, type DownloadsStoredSettings } from './downloads/ipc'
import {
  expandPath,
  asString,
  sanitizeSettings,
  planUpload,
  commitUploaded,
  backupProfileFilter,
  type BackupProfileGlobs,
} from './utils'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const store = new Store({
  defaults: {
    // DUN-030: a fresh install starts with an empty library.
    games: [] as Game[],
    cloud: { url: '' },
    serverApiKeyEnc: '',
    // Per-game delta state: `uploaded` = fingerprints this client last pushed,
    // `remote` = the server manifest this client last pulled.
    syncState: {},
    pendingPlaytimeSessions: [] as unknown[],
    settings: {
      runInBackground: false,
      autoSyncEnabled: false,
      autoSyncFreq: 'never',
      scanRoots: [] as string[],
      // DUN-028: the automatic update check is opt-in (manual checks always run).
      updateCheckEnabled: false,
      // DUN-077: saved scanner source toggles (main-owned; see scanner/sourceToggles.ts).
      scannerSources: {} as ScannerSourceToggles,
      // Remote trackers and SteamGridDB artwork are opt-in.
      trackersEnabled: { ...DEFAULT_TRACKERS_ENABLED },
      artworkEnabled: false,
      hltbEnabled: false,
      manifestEnabled: false,
    },
    // Downloads: base dir + concurrency, under their own key so config:save's
    // sanitizeSettings never drops them. Written by main only (downloads/ipc.ts).
    downloads: {} as DownloadsStoredSettings,
  }
})

type LegacyStore = {
  get(key: string, defaultValue?: unknown): unknown;
  delete(key: string): void;
  set(key: string, value: unknown): void;
};
const legacyStore = store as unknown as LegacyStore;

// DUN-001: older scanners stored install folders in winPath/linPath (save
// paths). Move them to installPath and re-resolve saves from the manifest,
// once. See scanner/migrateStore.ts for the exact rule. config:load/save await
// this so the renderer never reads (or writes back) a pre-migration list.
// Only the on-disk manifest cache is used here so startup is never blocked on
// a download; without a cache the migration is retried on the next launch.
let gameStoreMigration: Promise<void> = Promise.resolve();
async function migrateLegacyGameStore(): Promise<void> {
  try {
    const settings = store.get('settings') as Settings | undefined;
    const steamPath = getSteamPath();
    const result = await runStoredGamesMigration(legacyStore, {
      getResolver: async () => {
        const manifest = await loadManifest({
          ttlMs: Number.POSITIVE_INFINITY,
          download: async () => { throw new Error('manifest not cached yet'); },
        });
        if (!manifest) {
          void loadManifest(); // warm the cache for the next launch
          return null;
        }
        return createSaveResolver(manifest, { customRoots: settings?.scanRoots || [] });
      },
      steamGames: steamPath ? getInstalledSteamLibraryGames(steamPath) : [],
      storePath: store.path,
    });
    if (result.status === 'migrated' && result.changed > 0) {
      console.log(`Migrated ${result.changed} scanner game(s) to installPath/save paths (backup: ${result.backupPath})`);
    }
  } catch (e) {
    console.error('Game store migration failed:', e);
  }
}

// ── Local playtime tracking ──────────────────────────────────────────────────
const PENDING_PLAYTIME_KEY = 'pendingPlaytimeSessions';
let playtimeQueueFlushing = false;

function pendingPlaytimeQueue(): PlaytimeSessionPayload[] {
  return (store.get(PENDING_PLAYTIME_KEY) || []) as PlaytimeSessionPayload[];
}

function savePlaytimeQueue(queue: PlaytimeSessionPayload[]): void {
  store.set(PENDING_PLAYTIME_KEY, queue);
}

function playtimeSessionKey(session: PlaytimeSessionPayload): string {
  return `${session.game}|${session.sessionStart}|${session.sessionEnd}`;
}

// DUN-045: playtime only ever goes to the saved, validated server URL. The
// renderer persists cloud.url on every keystroke, so the gate waits for the
// URL to settle and exposes null while it is being edited or is invalid.
// Queued sessions are never touched here; they stay queued until a flush to
// a valid URL succeeds. See sync/serverUrl.ts.
const playtimeFlushGate = createPlaytimeFlushGate({
  initialUrl: (store.get('cloud') as Cloud | undefined)?.url,
  flush: () => { void flushPlaytimeQueue(); },
});

// Server API key (x-api-key): OS keychain only, write-only toward the renderer (DUN-073).
const serverKeyVault = createServerKeyVault({
  store: legacyStore,
  safeStorage: safeStorage as unknown as SafeStorageLike,
  warn: (message) => {
    console.warn(message)
    appendErrorLog('security', { message })
  },
})

// DUN-121/068: every Dune Server call goes through this client: the saved,
// gated URL only (playtimeFlushGate.savedUrl(); NO_SERVER otherwise), one
// axios instance with timeouts, x-api-key from the vault.
const serverHttp = createServerHttp()
const serverClient = createServerClient({
  http: serverHttp,
  baseUrl: () => playtimeFlushGate.savedUrl(),
  apiKey: () => serverKeyVault.load(),
})

async function postPlaytimeSession(session: PlaytimeSessionPayload): Promise<ServerResult<{ success?: boolean; message?: string }>> {
  return serverClient.call({ method: 'POST', path: '/api/playtime', body: session })
}

async function flushPlaytimeQueue(): Promise<void> {
  if (playtimeQueueFlushing) return;
  playtimeQueueFlushing = true;
  try {
    // No saved, validated URL (empty, invalid or still being typed): leave
    // the queue untouched; a later trigger flushes it.
    if (!playtimeFlushGate.savedUrl()) return;
    const snapshot = pendingPlaytimeQueue();
    if (snapshot.length === 0) return;
    const sent = new Set<string>();
    for (const session of snapshot) {
      const res = await postPlaytimeSession(session);
      if (res.ok) sent.add(playtimeSessionKey(session));
    }
    if (sent.size > 0) {
      savePlaytimeQueue(pendingPlaytimeQueue().filter((session) => !sent.has(playtimeSessionKey(session))));
    }
  } finally {
    playtimeQueueFlushing = false;
  }
}

async function recordLaunchPlaytime(game: string, startedAt: number, endedAt: number): Promise<void> {
  const session = buildPlaytimeSession(game, startedAt, endedAt);
  if (!session) return;

  const res = await postPlaytimeSession(session);
  if (!res.ok) {
    // DUN-084: never drop queued play time; at the cap entries are coalesced
    // (see playtime/session.ts), and that or an over-cap queue is logged.
    const queued = enqueuePlaytimeSession(pendingPlaytimeQueue(), session, { coalesce: !playtimeQueueFlushing });
    savePlaytimeQueue(queued.queue);
    if (queued.coalesced > 0 || queued.overCap) {
      const message = queued.overCap
        ? `Offline playtime queue holds ${queued.queue.length} entries (over ${MAX_PENDING_SESSIONS}); nothing was dropped.`
        : `Offline playtime queue reached ${MAX_PENDING_SESSIONS} entries; merged ${queued.coalesced} entries per game, no play time lost.`;
      console.warn(message);
      appendErrorLog('playtime', { message, queued: queued.queue.length, coalesced: queued.coalesced });
    }
    return;
  }

  void flushPlaytimeQueue();
  mainWindow?.webContents.send('playtime:recorded', {
    game: session.game,
    durationMinutes: session.durationMinutes,
  });
}


let autoSyncInterval: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let isCloudSyncing = false;

function setupAutoSync() {
  if (autoSyncInterval) clearInterval(autoSyncInterval);
  const settings = store.get('settings') as Settings | undefined;
  if (settings?.autoSyncEnabled && settings?.autoSyncFreq && settings.autoSyncFreq !== 'never') {
    let ms = 0;
    if (settings.autoSyncFreq === '1h')  ms = 60 * 60 * 1000;
    if (settings.autoSyncFreq === '6h')  ms = 6 * 60 * 60 * 1000;
    if (settings.autoSyncFreq === '24h') ms = 24 * 60 * 60 * 1000;

    if (ms > 0) {
      // DUN-070: the result is logged and sent to the renderer (sync:auto);
      // performCloudSync holds the sync lock itself (returns SYNC_IN_PROGRESS).
      autoSyncInterval = setInterval(() => {
        void runAutoSync({
          sync: () => performCloudSync(),
          hasServer: () => serverClient.baseUrl() !== null,
          appendErrorLog,
          send: (event) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sync:auto', event);
          },
        });
      }, ms);
    }
  }
}

// ── Delta sync ───────────────────────────────────────────────────────────────
// Only changed files are transferred. Manifests are keyed by POSIX relative
// paths so upload/restore diffs are correct across operating systems.
interface GameSyncState {
  uploaded?: FileManifest;
  remote?: HashManifest;
}
type SyncState = Record<string, GameSyncState>;



function getSyncState(): SyncState {
  return (store.get('syncState') as SyncState) || {};
}

function saveGameState(game: string, patch: Partial<GameSyncState>): void {
  const state = getSyncState();
  state[game] = { ...(state[game] || {}), ...patch };
  store.set('syncState', state);
}

/** size+mtime fingerprint for every readable local file, keyed by POSIX rel. */


/**
 * `deleted` names files that were pushed before but are gone now; it stays
 * empty when the local tree is empty, so an unmounted/empty save dir can never
 * wipe the server copy.
 */

/** Persist what actually landed: unchanged + succeeded, minus failures. */

async function deleteRemoteFile(gameName: string, relativePath: string): Promise<void> {
  await serverClient.raw({ method: 'DELETE', path: '/api/file', query: { game: gameName, path: relativePath } });
}

/**
 * Pull a game's server manifest and store it as the restore baseline. Called
 * after a push so a later restore only downloads what actually changed instead
 * of re-fetching everything this client just uploaded.
 */
async function refreshRemoteManifest(gameName: string): Promise<void> {
  const res = await serverClient.raw<{ files?: { path: string; hash: string }[] }>({ method: 'GET', path: '/api/manifest', query: { game: gameName } });
  const files = res.data.files || [];
  const manifest: HashManifest = {};
  for (const file of files) manifest[file.path] = file.hash;
  saveGameState(gameName, { remote: manifest });
}

async function uploadFile(gameName: string, localPath: string, relativePath: string, syncId: string, ids: UploadStoreIds = {}) {
  const stream = fs.createReadStream(localPath);
  try {
    // DUN-064/127: x-game / x-path are encodeURIComponent'd (net/uploadHeaders.ts).
    // Store ids go as x-steam-app-id / x-gog-id only when valid (else omitted: the server keeps its value).
    const res = await serverClient.raw<{ success?: boolean }>({
      method: 'POST',
      path: '/api/upload-file',
      body: stream,
      headers: uploadFileHeaders(gameName, relativePath, syncId, ids),
      transfer: true,
    });
    if (!(res.data && res.data.success)) {
      throw new ServerCallError(failureFromResponse(res.status, res.data));
    }
  } finally {
    // A failed POST aborts without draining the stream, which leaks the file
    // descriptor. Always release it.
    stream.destroy();
  }
}

type ProgressFn = (percent: number, message: string) => void

function savePathOf(game: Game): string {
  return expandPath(process.platform === 'win32' ? game.winPath : game.linPath);
}

function failureItem(game: string, failure: ServerFailure, filePath?: string): SyncFailureItem {
  return {
    game,
    ...(filePath !== undefined ? { path: filePath } : {}),
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    code: failure.code,
    message: failure.message,
  };
}

/** The first failure's status/code/message (server values unchanged) plus the full list. */
function syncFailureResult(failures: SyncFailureItem[], backups?: RestoreBackupInfo[]): CloudSyncResult {
  const first = failures[0];
  return {
    ok: false,
    ...(first.status !== undefined ? { status: first.status } : {}),
    code: first.code,
    message: first.message,
    failures,
    ...(backups && backups.length > 0 ? { backups } : {}),
  };
}

const PROTECTED_SAVE_PATH: ServerFailure = {
  ok: false,
  code: 'PROTECTED_SAVE_PATH',
  message: 'The save path is a shared folder (home, Documents, AppData, ...); pick the game\'s own save folder.',
};

/** Backup-profile filter for a game; include-all when the server has none or is unreachable. */
async function fetchBackupProfileFilter(gameName: string): Promise<(rel: string) => boolean> {
  try {
    const res = await serverClient.raw<{ profile?: BackupProfileGlobs | null; cacheExcludeGlobs?: string[] }>({ method: 'GET', path: '/api/backup-profile', query: { game: gameName } });
    if (res.data?.profile) {
      const cacheGlobs = Array.isArray(res.data.cacheExcludeGlobs) ? res.data.cacheExcludeGlobs : [];
      return backupProfileFilter(res.data.profile, cacheGlobs);
    }
  } catch {
    // Fall back to the full file set.
  }
  return () => true;
}

/**
 * Push changed local saves. Shared by the manual sync (with progress) and the
 * background auto-sync. DUN-067: deletions are planned from the unfiltered
 * disk list, so an exclude rule never deletes anything on the server.
 * Follow-up (c): status is committed by id on a fresh store read.
 */
async function performCloudSync(progress: ProgressFn = () => {}): Promise<CloudSyncResult> {
  if (isCloudSyncing) {
    return { ok: false, code: 'SYNC_IN_PROGRESS', message: 'Sync already in progress.' };
  }
  if (!serverClient.baseUrl()) return { ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' };
  isCloudSyncing = true;

  try {
    progress(5, 'Connecting to Dune Server...')
    await gameStoreMigration
    const games = (store.get('games') || []) as Game[]
    const failures: SyncFailureItem[] = [];
    const patches = new Map<number, GameStatusPatch>();

    progress(15, 'Scanning local files...')
    const found: { game: Game; files: { local: string; rel: string }[]; partial: boolean }[] = [];
    for (const game of games) {
      // DUN-070: one unreadable game (EACCES, ...) never aborts the others.
      try {
        const expanded = savePathOf(game);
        if (!expanded) continue;
        const target = resolveSaveTarget(expanded);
        if (!target.ok) {
          if (target.reason === 'protected') {
            failures.push(failureItem(game.name, PROTECTED_SAVE_PATH));
            patches.set(game.id, { status: 'Error' });
          }
          continue;
        }
        const unreadable: string[] = [];
        const files = listSaveFiles(target.target, { unreadable });
        if (unreadable.length > 0) {
          failures.push({ game: game.name, code: 'LOCAL_READ_FAILED', message: `Could not read ${unreadable.length} folder(s) in the save path: ${unreadable.slice(0, 3).map((r) => r || '.').join(', ')}` });
          patches.set(game.id, { status: 'Error' });
        }
        found.push({ game, files, partial: unreadable.length > 0 });
      } catch (e) {
        failures.push({ game: game.name, code: 'LOCAL_READ_FAILED', message: errorMessage(e) });
        patches.set(game.id, { status: 'Error' });
      }
    }

    if (found.every((f) => f.files.length === 0) && failures.length === 0) {
      progress(0, '')
      return { ok: false, code: 'NO_SAVES', message: 'No valid saves to sync. Check your game path mappings.' }
    }

    const plans: { game: Game; p: ReturnType<typeof planUpload>; fileCount: number; partial: boolean }[] = [];
    for (const { game, files, partial } of found) {
      const isIncluded = await fetchBackupProfileFilter(game.name);
      plans.push({ game, p: planUpload(game.name, files, getSyncState, isIncluded), fileCount: files.length, partial });
    }

    const toUpload = plans.flatMap(({ game, p }) => p.plan.map((f) => ({ ...f, gameId: game.id, ids: { steamAppId: game.steamAppId, gogId: game.gogId } })));
    const syncId = Date.now().toString();
    const CHUNK_SIZE = 5;
    const failedByGame = new Map<number, string[]>();
    const total = toUpload.length;

    if (total > 0) progress(20, `Uploading ${total} changed file(s)...`);
    for (let i = 0; i < total; i += CHUNK_SIZE) {
      const chunk = toUpload.slice(i, i + CHUNK_SIZE);
      const percent = 20 + Math.round((i / Math.max(1, total)) * 75);
      progress(percent, `Uploading: Batch ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(total / CHUNK_SIZE)}`);
      await Promise.all(chunk.map(async (file) => {
        try {
          await uploadFile(file.game, file.local, file.rel, syncId, file.ids);
        } catch (e) {
          const failure = toServerFailure(e);
          failedByGame.set(file.gameId, [...(failedByGame.get(file.gameId) || []), file.rel]);
          failures.push(failureItem(file.game, failure, file.rel));
          console.error(`Sync error on ${file.rel}: ${failure.code} ${failure.message}`);
        }
      }));
    }

    for (const { game, p, fileCount, partial } of plans) {
      // Mirror files that really vanished from disk (best-effort; never fatal).
      // DUN-070: never when part of the save folder couldn't be read.
      for (const rel of partial ? [] : p.deleted) {
        try {
          await deleteRemoteFile(game.name, rel);
        } catch (e) {
          const failure = toServerFailure(e);
          if (failure.code !== 'FILE_NOT_FOUND') console.error(`Remote delete of ${rel} failed: ${failure.code} ${failure.message}`);
        }
      }
      const failed = failedByGame.get(game.id) || [];
      commitUploaded(game.name, p.localManifest, failed, saveGameState);
      if (p.plan.length > 0) {
        try {
          await refreshRemoteManifest(game.name);
        } catch {
          /* non-fatal: a stale baseline only costs an extra download later */
        }
        if (failed.length === 0) {
          try {
            await serverClient.raw({
              method: 'POST',
              path: '/api/save-versions',
              body: { gameId: game.id, deviceId: os.hostname(), changeSummary: `Synced ${p.plan.length} changed file(s)` },
            });
          } catch {
            /* Version creation is non-fatal; sync already succeeded. */
          }
        }
      }
      // Never claim "In Sync" for a game whose changed files didn't all land.
      if (failed.length > 0 || partial) patches.set(game.id, { status: 'Error' });
      else if (fileCount > 0) patches.set(game.id, { status: 'In Sync', lastSync: new Date().toISOString() });
    }

    commitGameStatusPatches(store, patches);

    if (failures.length > 0) {
      progress(100, `Sync finished with ${failures.length} problem(s)`);
      return syncFailureResult(failures);
    }
    progress(100, 'Sync complete! 🎉')
    return {
      ok: true,
      uploaded: total,
      message: total === 0 ? 'Already up to date — no changed files.' : `Synced ${total} changed file(s).`,
    }
  } catch (err) {
    progress(0, '')
    return toServerFailure(err)
  } finally {
    isCloudSyncing = false;
  }
}

function restoreBackupRoot(): string {
  return path.join(app.getPath('userData'), 'restore-backups');
}

/**
 * Restore every game from the server. Per game (DUN-066): validate each
 * server path (DUN-060), find local files in conflict (newer or different
 * from the last synced state), back them up to <userData>/restore-backups
 * (exclusive copies; a failed backup writes nothing for that game), then
 * write atomically and record the new synced state. One game's failure does
 * not stop the others.
 */
async function performCloudRestore(progress: ProgressFn = () => {}): Promise<CloudSyncResult> {
  if (isCloudSyncing) {
    return { ok: false, code: 'SYNC_IN_PROGRESS', message: 'Sync already in progress.' };
  }
  if (!serverClient.baseUrl()) return { ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' };
  isCloudSyncing = true;

  try {
    progress(5, 'Connecting to Dune Server...')
    await gameStoreMigration
    const games = (store.get('games') || []) as Game[]

    let restoredCount = 0;
    const CHUNK_SIZE = 5;
    const failures: SyncFailureItem[] = [];
    const backups: RestoreBackupInfo[] = [];
    const patches = new Map<number, GameStatusPatch>();

    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      const overallPercent = 10 + Math.round((i / Math.max(1, games.length)) * 85);
      progress(overallPercent, `Checking server for: ${game.name}`);
      try {
        let files: { path: string; size: number; mtimeMs: number; hash: string }[];
        try {
          const manifestRes = await serverClient.raw<{ files?: typeof files }>({ method: 'GET', path: '/api/manifest', query: { game: game.name } });
          files = manifestRes.data.files || [];
        } catch (e) {
          const failure = toServerFailure(e);
          if (failure.code === 'GAME_NOT_FOUND') continue; // nothing on the server for this game
          throw new ServerCallError(failure);
        }
        if (files.length === 0) continue;

        const expanded = savePathOf(game);
        if (!expanded) continue;
        const saveTarget = resolveSaveTarget(expanded, {}, true);
        if (!saveTarget.ok) {
          if (saveTarget.reason === 'protected') {
            failures.push(failureItem(game.name, PROTECTED_SAVE_PATH));
            patches.set(game.id, { status: 'Error' });
          }
          continue;
        }
        const restoreBase = saveTarget.target.dir;

        const state = getSyncState()[game.name] || {};
        const serverHashes: HashManifest = {};
        const resolved: { file: (typeof files)[number]; target: string }[] = [];
        let gameRejected = 0;
        const skipFile = (r: RestoreRejection) => {
          gameRejected++;
          delete serverHashes[r.path];
          failures.push({ game: game.name, path: r.path, code: 'RESTORE_PATH_REJECTED', message: r.reason });
          console.error(`Restore: skipped unsafe server path for "${game.name}": ${JSON.stringify(r.path)} (${r.reason})`);
        };
        for (const file of files) {
          // DUN-065: a file / file-filter save path takes only its own files.
          if (!acceptsRelativePath(saveTarget.target, String(file.path))) {
            skipFile({ path: String(file.path), reason: 'not part of this game\'s save path' });
            continue;
          }
          // DUN-060: never touch the disk for a path that fails validation.
          const r = resolveRestoreTarget(restoreBase, file.path);
          if (!r.ok) {
            skipFile({ path: String(file.path), reason: r.reason });
            continue;
          }
          serverHashes[file.path] = file.hash;
          resolved.push({ file, target: r.target });
        }

        const plan = planRestore(resolved, state.uploaded || {}, state.remote || {});
        progress(overallPercent, `Restoring ${game.name}: ${plan.download.length}/${files.length} file(s)`);

        // DUN-066: back up conflicting local files first; on failure write nothing.
        let backupDir: string | null;
        try {
          backupDir = backupLocalFiles(restoreBackupRoot(), game.id, plan.conflicts);
        } catch (e) {
          failures.push({ game: game.name, code: 'RESTORE_BACKUP_FAILED', message: `Could not back up local saves; nothing was restored for this game: ${errorMessage(e)}` });
          patches.set(game.id, { status: 'Error' });
          continue;
        }
        if (backupDir) backups.push({ game: game.name, dir: backupDir, files: plan.conflicts.map((c) => c.file.path) });

        const relByTarget = new Map(plan.download.map((d) => [d.target, d.file.path]));
        // Validates each path again, mkdirs only after validation and writes
        // atomically (temp file + rename). See sync/restoreWrite.ts.
        const written = await writeRestoreFiles(restoreBase, plan.download.map((d) => d.file), {
          chunkSize: CHUNK_SIZE,
          onReject: skipFile,
          download: async (file) => {
            const response = await serverClient.raw<ArrayBuffer>({
              method: 'GET',
              path: '/api/download-file',
              query: { game: game.name, path: file.path },
              responseType: 'arraybuffer',
              transfer: true,
            });
            return Buffer.from(response.data);
          },
        });

        // Record the server state we reconciled against, and mark written /
        // identical files as synced so the next sync neither re-uploads them
        // nor flags them as conflicts.
        saveGameState(game.name, { remote: serverHashes });
        const uploaded = { ...(state.uploaded || {}) };
        const synced = [
          ...written.written.map((t) => ({ target: t, rel: relByTarget.get(t) })),
          ...plan.identical.map((x) => ({ target: x.target, rel: x.file.path })),
        ];
        for (const { target, rel } of synced) {
          const fp = rel ? fingerprintOf(target) : null;
          if (rel && fp) uploaded[rel] = fp;
        }
        saveGameState(game.name, { uploaded });

        patches.set(game.id, { status: gameRejected > 0 ? 'Error' : 'In Sync', lastSync: new Date().toISOString() });
        restoredCount++;
      } catch (e) {
        failures.push(failureItem(game.name, toServerFailure(e)));
        patches.set(game.id, { status: 'Error' });
      }
    }

    commitGameStatusPatches(store, patches);
    if (failures.length > 0) {
      progress(100, `Restore finished with ${failures.length} problem(s)`);
      return syncFailureResult(failures, backups);
    }
    progress(100, 'Restore complete! 🎉')
    const backedUp = backups.reduce((n, b) => n + b.files.length, 0);
    return {
      ok: true,
      restored: restoredCount,
      message: `Successfully restored ${restoredCount} game(s)!`
        + (backedUp > 0 ? ` ${backedUp} changed local file(s) were backed up first.` : ''),
      ...(backups.length > 0 ? { backups } : {}),
    }
  } catch (err) {
    progress(0, '')
    return toServerFailure(err)
  } finally {
    isCloudSyncing = false;
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

// Renderer runs with contextIsolation but must still be treated as
// untrusted input at every IPC boundary: validate shapes, whitelist
// fields, and normalize types before touching the store or fs.
const ART_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

ipcMain.handle('config:load', async () => {
  await gameStoreMigration;
  return {
    games: store.get('games'),
    cloud: store.get('cloud'),
    settings: store.get('settings')
  }
})

ipcMain.handle('config:save', async (_event, config) => {
  await gameStoreMigration;
  const cfg = (config ?? {}) as Record<string, unknown>;
  if (Array.isArray(cfg.games)) {
    // DUN-061: merge by id. Only metadata comes from the renderer; launch
    // fields stay as stored; unknown ids are dropped; nothing is removed
    // (removal is game:remove only).
    await saveRendererGames(gameSettingsDeps, cfg.games);
  }
  if (cfg.cloud && typeof cfg.cloud === 'object') {
    const url = asString((cfg.cloud as Record<string, unknown>).url);
    store.set('cloud', { url });
    // DUN-045: never flush to a draft. The gate flushes once the saved URL
    // has settled, is valid and differs from the previous saved URL.
    playtimeFlushGate.onUrlSaved(url);
  }
  if (cfg.settings && typeof cfg.settings === 'object') {
    // scannerSources is main-owned (scanner:setSource); sanitizeSettings keeps the stored value.
    store.set('settings', sanitizeSettings(cfg.settings, store.get('settings')));
    setupAutoSync();
    getUpdateController().refresh();
  }
  return true;
});

// DUN-061: launch fields are main-only. game:add takes metadata only; the
// launch target, managed prefix and emulator are set by id through main's
// own dialog / registries below.
const gameSettingsDeps: GameSettingsDeps = {
  getGames: async () => {
    await gameStoreMigration;
    return (store.get('games') || []) as Game[];
  },
  setGames: (games) => store.set('games', games),
  showOpenDialog: async (options) => {
    if (!mainWindow) throw new Error('No window for the file dialog');
    return dialog.showOpenDialog(mainWindow, options);
  },
  listPrefixes: () => getPrefixRegistry().list(),
  nextId,
};
const gameSettingsHandlers = createGameSettingsIpcHandlers(gameSettingsDeps);
ipcMain.handle('game:add', gameSettingsHandlers.add);
ipcMain.handle('game:pickLaunchTarget', gameSettingsHandlers.pickLaunchTarget);
ipcMain.handle('game:setPrefix', gameSettingsHandlers.setPrefix);
ipcMain.handle('emulators:list', gameSettingsHandlers.listEmulators);
ipcMain.handle('game:setEmulator', gameSettingsHandlers.setEmulator);

// Follow-up (a): the only way a game leaves the store; config:save never removes.
ipcMain.handle('game:remove', gameSettingsHandlers.remove);

ipcMain.handle('dialog:selectDirectory', async () => {
  if (!mainWindow) return { success: false }
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Custom Scan Directory',
    properties: ['openDirectory']
  })
  if (!canceled && filePaths.length > 0) {
    return { success: true, path: filePaths[0] }
  }
  return { success: false }
})

ipcMain.handle('games:autodetect', async (_event, customRoots) => {
  const storedRoots = (store.get('settings') as Settings | undefined)?.scanRoots || [];
  const roots = Array.isArray(customRoots) && customRoots.length > 0 ? customRoots : storedRoots;
  // Single scanner path: registry fullScan (launcher libraries with manifest
  // save paths, plus manifest-only save matches), deduped across sources.
  // DUN-077: ROMs come only from the 'emulator' source, when it is switched on.
  const scanned = await fullScan(roots, { includeManifestSaves: true });
  const detected = scanned.filter((g) => g.sourceId !== 'manual');
  await gameStoreMigration;
  // Already-stored games get missing Steam/GOG ids from the scan (never overwriting a valid one).
  const games = backfillStoreIds((store.get('games') || []) as Game[], detected).games;
  let added = 0;
  for (const d of detected) {
    if (!games.find((g: Game) => g.name === d.name)) {
      const now = new Date().toISOString();
      games.push({ ...d, thumbnail: '', createdAt: now, updatedAt: now });
      added++;
    }
  }
  store.set('games', games);
  return { count: added, currentGames: games };
});

/**
 * DUN-080: build the saves archive without blocking the main process (async
 * reads, async deflate, async write) and refuse to produce an empty one. The
 * archive goes to a sibling temp file and is renamed into place only once it
 * is complete, so a failed or empty export never leaves a file behind.
 */
async function exportSavesArchive(games: Game[], filePath: string): Promise<{ added: number; skipped: string[] }> {
  const zip = new AdmZip()
  const fileEntries = () => zip.getEntries().filter((entry) => !entry.isDirectory).length
  let added = 0
  const skipped: string[] = []

  for (const game of games) {
    const rawPath = process.platform === 'win32' ? game.winPath : game.linPath
    const expanded = expandPath(rawPath)
    let stats: fs.Stats
    try {
      if (!expanded) throw new Error('no save path')
      stats = await fs.promises.stat(expanded)
    } catch {
      skipped.push(game.name)
      continue
    }
    const before = fileEntries()
    if (stats.isDirectory()) {
      await zip.addLocalFolderPromise(expanded, { zipPath: game.name })
    } else if (stats.isFile()) {
      await new Promise<void>((resolve, reject) => {
        zip.addLocalFileAsync({ localPath: expanded, zipPath: game.name }, (err) => (err ? reject(err) : resolve()))
      })
    }
    if (fileEntries() > before) added++
    else skipped.push(game.name)
  }

  if (added === 0) return { added, skipped }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await zip.writeZipPromise(tmpPath, { overwrite: true })
    await fs.promises.rename(tmpPath, filePath)
  } catch (e) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined)
    throw e instanceof Error ? e : new Error(String(e))
  }
  return { added, skipped }
}

ipcMain.handle('sync:export', async () => {
  if (!mainWindow) return { success: false }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Saves Archive',
    defaultPath: 'gamesaves_backup.zip'
  })
  if (canceled || !filePath) return { success: false }

  try {
    const games = (store.get('games') || []) as Game[]
    const { added, skipped } = await exportSavesArchive(games, filePath)
    if (added === 0) {
      return {
        success: false,
        code: 'NOTHING_TO_EXPORT',
        message: games.length === 0
          ? 'Nothing to export: your library has no games.'
          : 'Nothing to export: none of your games has save files on this computer yet.',
      }
    }
    const note = skipped.length > 0 ? ` (${skipped.length} game(s) had no save files and were skipped)` : ''
    return { success: true, path: filePath, count: added, message: `Archive created with ${added} game(s)${note}.` }
  } catch (e) {
    console.error(e)
    return { success: false, message: errorMessage(e) }
  }
})

// DUN-071/121: Sync / Restore / Test carry the URL the user is looking at.
// It is validated first (complete http(s) URL, sync/serverUrl.ts); only a
// valid URL is saved, as { url } only, and becomes the gated URL at once.
function commitCredentials(credentials: unknown): ServerFailure | null {
  const raw = credentials && typeof credentials === 'object' ? (credentials as Record<string, unknown>).url : undefined;
  const url = playtimeFlushGate.commit(raw);
  if (!url) return { ok: false, code: 'INVALID_SERVER_URL', message: 'Enter the full server address, e.g. http://192.168.1.10:3030' };
  store.set('cloud', { url } satisfies Cloud);
  return null;
}

function progressSender(sender: Electron.WebContents): ProgressFn {
  return (percent, message) => {
    if (!sender.isDestroyed()) sender.send('sync:progress', { percent, message })
  }
}

ipcMain.handle('sync:cloud', async (event, credentials) => {
  const invalid = commitCredentials(credentials)
  if (invalid) return invalid
  return performCloudSync(progressSender(event.sender))
})

ipcMain.handle('sync:restore', async (event, credentials) => {
  const invalid = commitCredentials(credentials)
  if (invalid) return invalid
  return performCloudRestore(progressSender(event.sender))
})

ipcMain.handle('sync:test', async (_event, credentials) => {
  const invalid = commitCredentials(credentials)
  if (invalid) return invalid
  try {
    const res = await serverClient.raw<{ success?: boolean }>({ method: 'GET', path: '/api/saves' });
    if (res.data?.success === false) return failureFromResponse(res.status, res.data)
    return { ok: true as const, message: 'Connection to Dune Server successful!' }
  } catch (err) {
    const failure = toServerFailure(err);
    if (failure.code !== 'NETWORK') return failure;
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
    if (code === 'ECONNREFUSED') return { ...failure, message: 'Connection refused. Is the server running?' };
    if (code === 'ENOTFOUND') return { ...failure, message: 'Server address not found. Check your URL.' };
    return failure;
  }
})

// Read-only list of a game's save files as sync sees them before excludes
// (DUN-047 enabler: the exclusion editor). Never writes anything.
ipcMain.handle('saves:listFiles', async (_event, gameId: unknown) => {
  const id = parseGameId(gameId)
  if (id === null) return { ok: false, code: 'GAME_NOT_FOUND', message: 'Invalid game id' }
  await gameStoreMigration
  const game = ((store.get('games') || []) as Game[]).find((g) => g.id === id)
  return listGameSaveFiles(game, { savePathOf })
})

const thumbDir = path.join(app.getPath('userData'), 'thumbnails');

/**
 * DUN-081: a game has one art slot in thumbDir, `<id>.<image ext>`. Write the
 * new file first (a failed write keeps the old art), then remove every other
 * file in that slot, so switching format (.png -> .jpg, ...) never leaves the
 * old file behind. Used by both custom art and fetched art.
 */
function writeGameArt(gameId: number, targetPath: string, write: (file: string) => void): void {
  write(targetPath)
  removeOtherGameArt(gameId, targetPath)
}

function removeOtherGameArt(gameId: number, keepPath: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(thumbDir)
  } catch {
    return
  }
  let kept: fs.Stats | null = null
  try { kept = fs.statSync(keepPath) } catch { /* nothing to compare against */ }
  for (const name of names) {
    const ext = path.extname(name)
    if (path.basename(name, ext) !== String(gameId) || !ART_EXTS.includes(ext.toLowerCase())) continue
    const file = path.join(thumbDir, name)
    try {
      const st = fs.statSync(file)
      // Same file under another spelling (case-insensitive file systems).
      if (!st.isFile() || (kept && st.dev === kept.dev && st.ino === kept.ino)) continue
      fs.rmSync(file, { force: true })
    } catch (e) {
      appendErrorLog('art', { message: `Could not remove old art ${name}: ${errorMessage(e)}` })
    }
  }
}

// ── Error log (crash reporting) ────────────────────────────────────────────
// Renderer + main-process failures land here; inspected via "Open Error Log"
// or by opening the file directly. Rotated at ~1 MB to bound disk use.
function errorLogPath(): string {
  return path.join(app.getPath('userData'), 'dune-errors.log');
}

function appendErrorLog(source: string, payload: Record<string, unknown>): void {
  try {
    const file = errorLogPath();
    const line = JSON.stringify({ ts: new Date().toISOString(), source, ...payload }) + '\n';
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
        fs.renameSync(file, file + '.old');
      }
    } catch { /* rotation is best-effort */ }
    fs.appendFileSync(file, line);
  } catch (e) {
    console.error('Failed to write error log:', e);
  }
}

process.on('uncaughtException', (err) => {
  appendErrorLog('main-uncaught', { message: String(err?.message || err), stack: String(err?.stack || '') });
  try {
    if (app.isReady()) {
      dialog.showErrorBox('Dune encountered an error', 'Details were written to dune-errors.log in the app data folder.');
    }
  } catch { /* dialog must never throw */ }
});

process.on('unhandledRejection', (reason) => {
  appendErrorLog('main-unhandled-rejection', { message: String((reason as Error)?.message || reason) });
});

ipcMain.handle('reportRendererError', (_event, report) => {
  const r = (report ?? {}) as Record<string, unknown>;
  appendErrorLog('renderer', {
    message: typeof r.message === 'string' ? r.message.slice(0, 2000) : 'unknown',
    stack: typeof r.stack === 'string' ? r.stack.slice(0, 10000) : '',
    url: typeof r.url === 'string' ? r.url.slice(0, 500) : '',
  });
  return true;
});

// ── App updates (DUN-028): opt-in checks, download/install only on a click ──
let updateController: ReturnType<typeof createUpdateController> | null = null;
function getUpdateController() {
  updateController ??= createUpdateController({
    updater: autoUpdater as unknown as UpdaterLike,
    isPackaged: app.isPackaged,
    // Automatic checks only: Settings.updateCheckEnabled, read through the one helper.
    enabled: () => isUpdateCheckEnabled(store.get('settings')),
    currentVersion: app.getVersion(),
    send: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:status', status);
    },
    log: (message) => appendErrorLog('updater', { message }),
  });
  return updateController;
}
ipcMain.handle('updates:status', () => getUpdateController().status());
ipcMain.handle('updates:download', () => getUpdateController().download());
ipcMain.handle('updates:install', () => getUpdateController().install());
// Manual release check via @dune/providers (api.github.com, cached), beside electron-updater.
// PL ruling: the click is the opt-in, so this always runs; only automatic checks use the flag. Check only.
ipcMain.handle('updates:checkRelease', (_event, opts: unknown) => providerRouting.checkForUpdates(opts));

ipcMain.handle('game:setCustomArt', async (_event, id) => {
  if (!mainWindow) return false
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Custom Art',
    filters: [{ name: 'Images', extensions: ['jpg', 'png', 'jpeg', 'webp'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return false

  // Dialog filters are advisory only — enforce the allowlist so a crafted
  // path (or case-variant extension) can't plant executables in thumbDir.
  const rawExt = path.extname(filePaths[0]).toLowerCase();
  const ext = ART_EXTS.includes(rawExt) ? rawExt : '.png';
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) throw new Error('Invalid game id');
  const targetPath = path.join(thumbDir, `${numericId}${ext}`);
  writeGameArt(numericId, targetPath, (file) => fs.copyFileSync(filePaths[0], file));

  const games = (store.get('games') || []) as Game[];
  const game = games.find((g: Game) => g.id === numericId);
  if (game) {
    game.thumbnail = `local://${targetPath}`
    store.set('games', games)
  }
  return `local://${targetPath}`
})

/**
 * Local artwork opt-in (settings.artworkEnabled). Only used when no Dune Server
 * is configured: with a server, the server's own artwork flag decides and its
 * 403 PROVIDER_DISABLED passes through unchanged.
 */
function artworkEnabled(): boolean {
  return (store.get('settings') as Settings | undefined)?.artworkEnabled === true
}

// Provider routing (server vs local; electron/providers/routing.ts). No server:
// local @dune/providers behind the local flags. Server: the server decides; only
// an unreachable server (NETWORK, no status) falls back to local, still gated.
const serverIpcHandlers = createServerIpcHandlers(serverClient, { artworkEnabled })
let localProviders: LocalProviders | null = null
function getLocalProviders(): LocalProviders {
  localProviders ??= createElectronLocalProviders(localProviderFlags, { warn: (message) => appendErrorLog('providers', { message }) })
  return localProviders
}
function localProviderFlags() {
  const s = store.get('settings') as Settings | undefined
  return { hltbEnabled: s?.hltbEnabled === true, artworkEnabled: s?.artworkEnabled === true, updateCheckEnabled: isUpdateCheckEnabled(s) }
}
const providerRouting = createProviderRouting({
  get local() { return getLocalProviders() },
  getServerUrl: () => serverClient.baseUrl(),
  getLocalSettings: localProviderFlags,
  server: {
    getHltbTimes: (name) => serverIpcHandlers['hltb:get'](null, name) as Promise<HltbIpcResult>,
    searchArt: (query) => serverIpcHandlers['art:search'](null, query) as Promise<SearchArtIpcResult>,
    getSteamGridKeyStatus: () => serverIpcHandlers['steamGridKey:status'](null) as Promise<ProviderKeyStatusResult>,
    setSteamGridKey: (key) => serverIpcHandlers['steamGridKey:set'](null, key) as Promise<ProviderKeyStatusResult>,
    clearSteamGridKey: () => serverIpcHandlers['steamGridKey:clear'](null) as Promise<ProviderKeyStatusResult>,
    // SteamGridDB art through the Dune Server (its write-only provider key; DUN-092).
    fetchArt: (game) => fetchArtViaServer(game.id, game.name, {
      client: serverClient,
      http: serverHttp,
      thumbDir,
      writeFile: (file, data) => writeGameArt(game.id, file, (target) => fs.writeFileSync(target, data)),
    }),
  },
  resolveGame: async (id) => {
    const gameId = parseGameId(id)
    if (gameId === null) return { ok: false, code: 'INVALID_GAME_ID', message: 'Invalid game id' }
    await gameStoreMigration
    const game = ((store.get('games') || []) as Game[]).find((g) => g.id === gameId)
    if (!game) return { ok: false, code: 'GAME_NOT_FOUND', message: 'Game not found' }
    return { ok: true, id: gameId, name: game.name }
  },
  appVersion: app.getVersion(),
  saveArt: (gameId, ext, bytes) => {
    const target = path.join(thumbDir, `${gameId}${ext}`)
    writeGameArt(gameId, target, (file) => fs.writeFileSync(file, bytes))
    return `local://${target}`
  },
})
const ROUTED_CHANNELS = new Set(['hltb:get', 'art:search', 'steamGridKey:status', 'steamGridKey:set', 'steamGridKey:clear'])
ipcMain.handle('hltb:get', (_event, name: unknown) => providerRouting.getHltbTimes(name))
ipcMain.handle('art:search', (_event, query: unknown) => providerRouting.searchArt(query))
ipcMain.handle('steamGridKey:status', () => providerRouting.getSteamGridKeyStatus())
ipcMain.handle('steamGridKey:set', (_event, key: unknown) => providerRouting.setSteamGridKey(key))
ipcMain.handle('steamGridKey:clear', () => providerRouting.clearSteamGridKey())

ipcMain.handle('game:fetchArt', async (_event, id: unknown): Promise<FetchArtResult> => {
  const res = await providerRouting.fetchArt(id)
  if (res.ok) {
    // Fresh read: patch only this game's thumbnail.
    const games = (store.get('games') || []) as Game[]
    const gameId = parseGameId(id)
    store.set('games', games.map((g) => (g.id === gameId ? { ...g, thumbnail: res.thumbnail } : g)))
  }
  return res
})

// Save-path suggestions (Ludusavi manifest; electron/manifest/**). Server first (its flag decides,
// answers pass through); only an unreachable server falls back to the local provider, which runs
// only when the local Settings.manifestEnabled is on. Paths are expanded and confined here; nothing
// is applied until the user confirms one through game:setSavePath (which re-checks it).
function manifestEnabledLocally(): boolean {
  return (store.get('settings') as Settings | undefined)?.manifestEnabled === true
}
function manifestUserName(): string {
  try { return os.userInfo().username } catch { return process.env.USER || 'user' }
}
function manifestContext(game: Game) {
  return buildExpandContext(game, { home: app.getPath('home'), userName: manifestUserName(), env: process.env, resolveManagedPrefix: resolveManagedPrefixPath })
}
let localManifestLookup: LocalManifestLookup | null = null
const getManifestSuggestions = createManifestSuggestions({
  client: serverClient,
  localEnabled: manifestEnabledLocally,
  localLookup: (query) => {
    localManifestLookup ??= createLocalManifestLookup({ userDataDir: app.getPath('userData'), fetch: net.fetch, enabled: manifestEnabledLocally })
    return localManifestLookup(query)
  },
  findGame: async (id) => {
    await gameStoreMigration
    return ((store.get('games') || []) as Game[]).find((g) => g.id === id) ?? null
  },
  expandContext: manifestContext,
})
ipcMain.handle('manifest:suggestions', (_event, gameId: unknown) => getManifestSuggestions(gameId))
ipcMain.handle('game:setSavePath', (_event, gameId: unknown, savePath: unknown) => setGameSavePath({
  getGames: async () => {
    await gameStoreMigration
    return (store.get('games') || []) as Game[]
  },
  setGames: (games) => store.set('games', games),
  expandContext: manifestContext,
}, gameId, savePath))

// ── NEW IPC Handlers for Server Integration ─────────────────────────────────────

// Server-only calls (playtime, achievements, saves, conflicts, art, sources,
// keys, Ollama): validated arguments, gated URL, ServerResult (net/serverHandlers.ts).
for (const [channel, handler] of Object.entries(serverIpcHandlers)) {
  if (!ROUTED_CHANNELS.has(channel)) ipcMain.handle(channel, handler)
}

// Achievements
async function importLocalAchievementsForGame(game: Game): Promise<ImportLocalAchievementsResult> {
  if (!serverClient.baseUrl()) return { ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' }

  // The disk scan catches errors as plain messages; keep the server's
  // failure (status/code/error) here so it reaches the renderer unchanged.
  let serverFailure: ServerFailure | null = null
  try {
    const result = await importLocalAchievementsFromDisk(game, async (name, achievements) => {
      try {
        const res = await serverClient.raw<{ success?: boolean; count?: number; message?: string }>({
          method: 'POST',
          path: '/api/achievements/import',
          body: { game: name, achievements },
        })
        return res.data
      } catch (e) {
        serverFailure = toServerFailure(e)
        throw e
      }
    }, async (g) => {
      // DUN-076: async reads; a prefix only via its per-appId folders.
      const prefix = g.managedPrefixId ? resolveManagedPrefixPath(g.managedPrefixId) ?? undefined : g.winePrefix
      return scanLocalAchievements(await getAchievementRoots(g, prefix))
    })
    if (serverFailure) return serverFailure
    if (!result.success) return { ok: false, code: 'IMPORT_FAILED', message: result.message || 'Import failed' }
    if (result.count > 0) {
      mainWindow?.webContents.send('achievements:imported', { game: game.name, count: result.count })
    }
    return { ...result, ok: true }
  } catch (e) {
    return serverFailure ?? toServerFailure(e)
  }
}

// Follow-up (b): the renderer sends a game id; main reads the game from its store.
ipcMain.handle('achievements:importLocal', async (_event, gameId: unknown): Promise<ImportLocalAchievementsResult> => {
  const id = parseGameId(gameId)
  if (id === null) return { ok: false, code: 'INVALID_GAME_ID', message: 'Invalid game id' }
  await gameStoreMigration
  const game = ((store.get('games') || []) as Game[]).find((g) => g.id === id)
  if (!game) return { ok: false, code: 'GAME_NOT_FOUND', message: 'Game not found' }
  return importLocalAchievementsForGame(game)
})

// Disk space: one DriveSpace per device. Defaults = Steam libraries, scan roots,
// and each stored game's save + install folder. Never rejects (see system/diskSpace.ts).
ipcMain.handle('system:diskSpace', (_event, paths?: unknown) =>
  getDiskSpace(paths, () => buildDefaultDiskPaths({
    games: (store.get('games') || []) as Game[],
    scanRoots: (store.get('settings') as Settings | undefined)?.scanRoots || [],
    steamLibraries: detectSteamLibraries(),
    platform: process.platform,
    expand: expandPath,
  }))
)

// Game launcher (DUN-061): the renderer sends a game id only. Main reads the
// executable, args, cwd, launcher and Wine/Proton prefix from its own store;
// any other IPC argument (paths, args, env such as LD_PRELOAD) is dropped.
const launchHandlers = createLaunchIpcHandlers({
  getGames: async () => {
    await gameStoreMigration;
    return (store.get('games') || []) as Game[];
  },
  onExit: (game, { startedAt, endedAt }) => {
    void recordLaunchPlaytime(game.name, startedAt, endedAt);
    // Give the game a moment to flush achievement files, then import
    // whatever it left on disk. Import failures stay silent until the
    // user opens the achievements view.
    const timer = setTimeout(() => {
      void importLocalAchievementsForGame(game);
    }, 1500);
    timer.unref?.();
  },
  // A managed prefix is resolved at launch; one that is gone or outside the
  // managed root makes the game not launchable.
  resolveManagedPrefix: (prefixId) => resolveManagedPrefixPath(prefixId),
  // DUN-074: steam://rungameid/<id> through the OS URL handler.
  openExternal: (url) => shell.openExternal(url),
});
function resolveManagedPrefixPath(prefixId: string): string | null {
  const registry = getPrefixRegistry();
  const entry = registry.list().find((p) => p.id === prefixId);
  return entry && isStrictlyInside(entry.path, registry.managedRoot) ? entry.path : null;
}
ipcMain.handle('game:launch', launchHandlers.launch);
ipcMain.handle('game:launchCommand', launchHandlers.launchCommand);

// Prefix manager (DUN-062): only prefixes Dune created, under <userData>/prefixes.
// The renderer sends a name (create) or a registry id (backup/delete), never a path.
// Delete goes to the OS trash; nothing here rm's a folder.
let prefixRegistry: PrefixRegistry | null = null;
function getPrefixRegistry(): PrefixRegistry {
  prefixRegistry ??= new PrefixRegistry(defaultPrefixRegistryPaths(app.getPath('userData'), os.homedir()), {
    trashItem: (fullPath) => shell.trashItem(fullPath),
  });
  return prefixRegistry;
}
const prefixHandlers = createPrefixIpcHandlers(getPrefixRegistry);
ipcMain.handle('prefix:list', prefixHandlers.list);
ipcMain.handle('prefix:create', prefixHandlers.create);
ipcMain.handle('prefix:backup', prefixHandlers.backup);
ipcMain.handle('prefix:delete', prefixHandlers.delete);

// Prefixes found on disk (Wine, Proton, Heroic, Lutris): read-only; the only
// action is opening a folder that is in a fresh discovery result.
const discoverDeps = defaultDiscoverDeps(detectSteamLibraries);
ipcMain.handle('prefix:discover', () => discoverPrefixes(discoverDeps));
ipcMain.handle('prefix:openDiscovered', (_event, prefixPath: unknown) =>
  openDiscoveredPrefix(prefixPath, { discover: () => discoverPrefixes(discoverDeps), openPath: (p) => shell.openPath(p) }));

// Scanner sources (DUN-077): saved in settings.scannerSources, applied to the registry.
applyScannerSources(gameRegistry, sanitizeScannerSources((store.get('settings') as Settings | undefined)?.scannerSources));
ipcMain.handle('scanner:getSources', () => listScannerSources(gameRegistry));
ipcMain.handle('scanner:setSource', (_event, id: unknown, enabled: unknown) => {
  const settings = store.get('settings');
  const { result, toggles } = setScannerSource(gameRegistry, sanitizeScannerSources(settings.scannerSources), id, enabled);
  if (toggles) store.set('settings', { ...settings, scannerSources: toggles });
  return result;
});

// Server API key (stored locally, sent as x-api-key on every server call)
// DUN-073: write-only. The renderer only ever learns { set, unreadable? }.
ipcMain.handle('server-key:get', () => serverKeyVault.status());

ipcMain.handle('server-key:set', (_event, key: unknown) => {
  serverKeyVault.save(typeof key === 'string' ? key : '');
  return serverKeyVault.status();
});

// ── Downloads (content-agnostic engine; handlers in downloads/ipc.ts) ────────
// The renderer never hands main a path to open: folders come from main's own
// dialog, showInFolder looks items up by id, and a destDir is re-validated.
let downloadManager: DownloadManagerLike | null = null
const downloadSettings: DownloadsSettingsStore = {
  get: () => {
    const v = store.get('downloads') as unknown
    return v && typeof v === 'object' ? (v as DownloadsStoredSettings) : {}
  },
  set: (value) => store.set('downloads', value),
}
const downloadsHandlers = createDownloadsIpcHandlers({
  getManager: () => downloadManager,
  showFolderDialog: async (options) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { canceled: true, filePaths: [] }
    return dialog.showOpenDialog(mainWindow, options)
  },
  shell,
  settings: downloadSettings,
})
for (const [channel, handler] of Object.entries(downloadsHandlers)) ipcMain.handle(channel, handler)
// Hold the first quit until in-flight downloads are saved as paused.
app.on('before-quit', createDownloadsQuitHandler(() => downloadManager, () => app.quit()))

// DUN-063: every webContents (the main window and anything it could spawn)
// may only show the app itself. Off-origin navigation and redirects are
// blocked, <webview> is refused, window.open always denied; http(s) links
// open in the OS browser after URL parsing (security/navigation.ts).
const navigationGuards = createNavigationGuards({
  app: {
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    indexFileUrl: pathToFileURL(path.join(__dirname, '../dist/index.html')).toString(),
  },
  openExternal: (url) => shell.openExternal(url),
})
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', navigationGuards.willNavigate)
  contents.on('will-redirect', navigationGuards.willNavigate)
  contents.on('will-attach-webview', navigationGuards.willAttachWebview)
  contents.setWindowOpenHandler(navigationGuards.windowOpen)
})

function createWindow() {
  // Resolve the app/tray icon once. In dev it lives in `public/`; Vite copies
  // `public/` into `dist/`, which is what electron-builder ships, so a packaged
  // app must look under `dist/` (the old `public/`-only candidates missed there).
  const iconCandidates = [
    path.join(__dirname, '../public/tray-icon.ico'),
    path.join(__dirname, '../public/tray-icon.png'),
    path.join(__dirname, '../dist/tray-icon.ico'),
    path.join(__dirname, '../dist/tray-icon.png'),
    path.join(process.resourcesPath || '', 'tray-icon.ico'),
    path.join(process.resourcesPath || '', 'tray-icon.png'),
  ]
  let iconPath = ''
  for (const c of iconCandidates) {
    if (fs.existsSync(c)) { iconPath = c; break }
  }
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()

  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // DUN-063: explicit, not left to defaults.
      sandbox: true,
      webviewTag: false,
    },
  })

  const win = mainWindow

  // Only create tray once (guard against re-entrancy on macOS activate)
  if (!tray) {
    tray = new Tray(icon)
    tray.setToolTip('Dune')
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'Show App', click: () => {
          // If the window was closed (destroyed), recreate it
          if (!mainWindow || mainWindow.isDestroyed()) {
            createWindow()
          } else {
            mainWindow.show()
          }
        }
      },
      { label: 'Quit', click: () => { isQuitting = true; app.quit() } }
    ]))
    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow()
      } else {
        mainWindow.show()
      }
    })
  }

  win.on('close', (event) => {
    const settings = store.get('settings') as Settings | undefined
    if (!isQuitting && settings?.runInBackground) {
      // Hide instead of closing when "run in background" is enabled
      event.preventDefault()
      win.hide()
    } else {
      // Let the window close normally. mainWindow will be nulled after destroy.
      mainWindow = null
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.on('before-quit', () => {
  isQuitting = true
})

// Standard cross-platform quit-on-last-window-close
app.on('window-all-closed', () => {
  const settings = store.get('settings') as Settings | undefined
  // On macOS, keep the process alive in tray (always). On others, quit unless background mode.
  if (process.platform !== 'darwin' && !settings?.runInBackground) {
    // Give the tray a moment to register, then quit cleanly
    isQuitting = true
    app.quit()
  }
})

// macOS: re-open window when dock icon is clicked and no windows are open
app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  } else {
    mainWindow.show()
  }
})

// Single instance lock: prevent multiple client instances from corrupting store data
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Content-Security-Policy: restrict origins, disallow untrusted execution
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self' 'unsafe-inline' local: data:; connect-src 'self' http: https:; img-src 'self' local: data: https: http:; font-src 'self' data: https:;"
          ]
        }
      });
    });

    gameStoreMigration = migrateLegacyGameStore();

    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

    // protocol.handle replaces the deprecated registerFileProtocol. Serving via
    // net.fetch keeps streaming + Range support and avoids blocking the main
    // process on large files.
    protocol.handle('local', (request) => {
      // Sandbox: only thumbnails written by this app are servable. Anything
      // else (including traversal attempts) is rejected.
      try {
        const resolved = path.resolve(decodeURIComponent(request.url.replace('local://', '')));
        const root = path.resolve(thumbDir) + path.sep;
        if (!resolved.startsWith(root)) {
          return new Response('Forbidden', { status: 403 });
        }
        return net.fetch(pathToFileURL(resolved).toString());
      } catch (e) {
        console.error(e);
        return new Response('Not found', { status: 404 });
      }
    });

    createWindow();
    void openDownloads({
      settings: downloadSettings,
      defaultBaseDir: path.join(app.getPath('downloads'), 'Dune'),
      stateDir: app.getPath('userData'),
    }).then((manager) => {
      downloadManager = manager
      forwardDownloadEvents(manager, () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null))
    }).catch((err) => appendErrorLog('downloads', { message: `Could not open the download queue: ${errorMessage(err)}` }));
    setupAutoSync();
    getUpdateController().refresh();
    void flushPlaytimeQueue();
  });
}
