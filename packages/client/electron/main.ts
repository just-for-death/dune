import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, protocol, safeStorage, session, net } from 'electron'
import { pathToFileURL } from 'node:url'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import Store from 'electron-store'
import AdmZip from 'adm-zip'
import axios from 'axios'
import { nextId } from '@dune/shared'
import type { FileManifest, HashManifest, Game, Settings, Cloud, BackupProfile } from '@dune/shared'
import { autoDetectGames } from './scanner'
import { getEmulatorGames } from './emulators/roms'
import { launchGame, getLaunchCommand } from './launcher/manager'
import type { LaunchOptions } from './launcher/strategies/types'
import { buildPlaytimeSession, enqueuePlaytimeSession, type PlaytimeSessionPayload } from './playtime/session'
import { getAchievementRoots, scanLocalAchievements } from './achievements/local'
import { listPrefixes, createWinePrefix, deleteWinePrefix, backupWinePrefix } from './prefix/manager'
import { autoUpdater } from 'electron-updater'
import {
  normalizeUrl,
  expandPath,
  asString,
  sanitizeGame,
  sanitizeSettings,
  planUpload,
  commitUploaded,
  filterBackupFiles,
} from './utils'

// Define default games if empty
const defaultGames = [
  {
    id: 1,
    name: 'Cyberpunk 2077',
    winPath: '%USERPROFILE%\\Saved Games\\CD Projekt Red\\Cyberpunk 2077',
    linPath: '~/.steam/steam/steamapps/compatdata/1091500/pfx/drive_c/users/steamuser/Saved Games/CD Projekt Red/Cyberpunk 2077',
    lastSync: 'Never',
    status: 'Pending Upload',
    thumbnail: ''
  }
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const store = new Store({
  defaults: {
    games: defaultGames,
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
      steamGridDbKey: '',
      scanRoots: [] as string[]
    }
  }
})

type LegacyStore = {
  get(key: string, defaultValue?: unknown): unknown;
  delete(key: string): void;
  set(key: string, value: unknown): void;
};
const legacyStore = store as unknown as LegacyStore;

// Auth header for Dune Server calls. The server requires x-api-key on every
// route except /health; without it the whole client↔server integration 401s.
export function serverHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = loadServerKey();
  return key ? { ...extra, 'x-api-key': key } : { ...extra };
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

async function postPlaytimeSession(session: PlaytimeSessionPayload): Promise<{ success: boolean; message?: string }> {
  const cloud = store.get('cloud') as Cloud | undefined;
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' };
  try {
    const cleanUrl = normalizeUrl(cloud.url);
    const res = await axios.post(`${cleanUrl}/api/playtime`, session, {
      headers: serverHeaders({ 'Content-Type': 'application/json' }),
    });
    return res.data;
  } catch (err) {
    return { success: false, message: errorMessage(err) };
  }
}

async function flushPlaytimeQueue(): Promise<void> {
  if (playtimeQueueFlushing) return;
  playtimeQueueFlushing = true;
  try {
    const snapshot = pendingPlaytimeQueue();
    if (snapshot.length === 0) return;
    const sent = new Set<string>();
    for (const session of snapshot) {
      const res = await postPlaytimeSession(session);
      if (res.success) sent.add(playtimeSessionKey(session));
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
  if (!res.success) {
    savePlaytimeQueue(enqueuePlaytimeSession(pendingPlaytimeQueue(), session));
    return;
  }

  void flushPlaytimeQueue();
  mainWindow?.webContents.send('playtime:recorded', {
    game: session.game,
    durationMinutes: session.durationMinutes,
  });
}


// Server API key storage. Enforce OS keychain via Electron safeStorage;
// NEVER persist plaintext API keys to disk. If keychain is unavailable,
// hold key in memory for the active session only with an explicit security warning.
const LEGACY_KEY = 'serverApiKey';
const ENC_KEY = 'serverApiKeyEnc';
let sessionServerKey = '';

export function loadServerKey(): string {
  if (sessionServerKey) return sessionServerKey;
  const enc = store.get(ENC_KEY, '') as string;
  if (enc) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(enc, 'base64')).toString();
      }
    } catch {
      return '';
    }
  }
  // If legacy plaintext key was present in store, migrate if possible and purge from disk
  const legacy = legacyStore.get(LEGACY_KEY, '') as string;
  if (legacy) {
    legacyStore.delete(LEGACY_KEY);
    if (safeStorage.isEncryptionAvailable()) {
      try {
        store.set(ENC_KEY, safeStorage.encryptString(legacy).toString('base64'));
        return legacy;
      } catch {
        return '';
      }
    } else {
      console.warn('[Security] Plaintext legacy API key removed from disk. Keychain unavailable; held in memory for this session only.');
      sessionServerKey = legacy;
      return legacy;
    }
  }
  return '';
}

export function saveServerKey(key: string): void {
  const clean = (key || '').trim();
  if (!clean) {
    sessionServerKey = '';
    store.delete(ENC_KEY);
    legacyStore.delete(LEGACY_KEY);
    return;
  }

  if (safeStorage.isEncryptionAvailable()) {
    try {
      store.set(ENC_KEY, safeStorage.encryptString(clean).toString('base64'));
      legacyStore.delete(LEGACY_KEY);
      sessionServerKey = '';
      return;
    } catch (err) {
      console.error('[Security] Failed to encrypt API key with OS keychain:', err);
    }
  }

  // OS keychain unavailable or encryption failed:
  // Never write plaintext to disk (electron-store). Keep only in memory for this session.
  console.warn('[Security] OS keychain encryption unavailable. Refusing to persist server API key in plaintext to disk. Key held in memory for current session only.');
  sessionServerKey = clean;
  legacyStore.delete(LEGACY_KEY);
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
      autoSyncInterval = setInterval(async () => {
        if (isCloudSyncing) return;
        const creds = store.get('cloud') as Cloud | undefined;
        if (creds?.url) {
          isCloudSyncing = true;
          try {
            await performCloudSync(creds);
          } finally {
            isCloudSyncing = false;
          }
        }
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



export function getSyncState(): SyncState {
  return (store.get('syncState') as SyncState) || {};
}

export function saveGameState(game: string, patch: Partial<GameSyncState>): void {
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

async function deleteRemoteFile(baseUrl: string, gameName: string, relativePath: string): Promise<void> {
  const cleanUrl = normalizeUrl(baseUrl);
  await axios.delete(`${cleanUrl}/api/file`, {
    headers: serverHeaders(),
    params: { game: gameName, path: relativePath },
  });
}

/**
 * Pull a game's server manifest and store it as the restore baseline. Called
 * after a push so a later restore only downloads what actually changed instead
 * of re-fetching everything this client just uploaded.
 */
async function refreshRemoteManifest(baseUrl: string, gameName: string): Promise<void> {
  const cleanUrl = normalizeUrl(baseUrl);
  const res = await axios.get(`${cleanUrl}/api/manifest?game=${encodeURIComponent(gameName)}`, {
    headers: serverHeaders(),
  });
  const files: { path: string; hash: string }[] = res.data.files || [];
  const manifest: HashManifest = {};
  for (const file of files) manifest[file.path] = file.hash;
  saveGameState(gameName, { remote: manifest });
}

async function uploadFile(baseUrl: string, gameName: string, localPath: string, relativePath: string, syncId?: string) {
  const cleanUrl = normalizeUrl(baseUrl);
  const stream = fs.createReadStream(localPath);
  try {
    const res = await axios.post(`${cleanUrl}/api/upload-file`, stream, {
      headers: serverHeaders({
        'x-game': gameName,
        'x-path': relativePath,
        'x-sync-id': syncId || 'default',
        'Content-Type': 'application/octet-stream'
      })
    });
    if (!(res.data && res.data.success)) {
      throw new Error((res.data && res.data.message) || 'Upload rejected by server');
    }
  } finally {
    // A failed POST aborts without draining the stream, which leaks the file
    // descriptor. Always release it.
    stream.destroy();
  }
}

async function performCloudSync(credentials: Cloud) {
  try {
    const games = (store.get('games') || []) as Game[]
    const cleanUrl = normalizeUrl(credentials.url)

    let totalAttempted = 0
    let totalFailed = 0

    for (const game of games) {
      const rawPath = process.platform === 'win32' ? game.winPath : game.linPath
      const expanded = expandPath(rawPath)
      if (expanded && fs.existsSync(expanded)) {
        const filePaths: { local: string, rel: string }[] = [];
        const stats = fs.statSync(expanded);
        if (stats.isDirectory()) {
          const walk = (dir: string, base: string) => {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
              if (item.isSymbolicLink()) continue; // skip symlinks
              const fullPath = path.join(dir, item.name);
              if (item.isDirectory()) {
                walk(fullPath, base);
              } else {
                filePaths.push({ local: fullPath, rel: path.relative(base, fullPath) });
              }
            }
          };
          walk(expanded, expanded);
        } else {
          filePaths.push({ local: expanded, rel: path.basename(expanded) });
        }

        const syncId = Date.now().toString();
        let profileFiles = filePaths;
        try {
          const profileRes = await axios.get(`${cleanUrl}/api/backup-profile?game=${encodeURIComponent(game.name)}`, { headers: serverHeaders() });
          if (profileRes.data?.success && profileRes.data.profile) {
            profileFiles = filterBackupFiles(filePaths.map((file) => ({ ...file, rel: file.rel })), profileRes.data.profile);
          }
        } catch {
          // Fall back to the full file set when the server is unavailable.
        }
        const { plan, localManifest, deleted } = planUpload(game.name, profileFiles, getSyncState);
        let attempted = 0;
        const failedRels: string[] = [];
        for (let i = 0; i < plan.length; i += 5) {
          const chunk = plan.slice(i, i + 5);
          await Promise.all(chunk.map(async (f) => {
            attempted++;
            try {
              await uploadFile(cleanUrl, f.game, f.local, f.rel, syncId);
            } catch (e) {
              failedRels.push(f.rel);
              console.error(`Failed to sync ${f.rel}:`, e);
            }
          }));
        }
        // Mirror local deletions (best-effort; never fatal).
        for (const rel of deleted) {
          try {
            await deleteRemoteFile(cleanUrl, game.name, rel);
          } catch {
            /* keep going */
          }
        }
        commitUploaded(game.name, localManifest, failedRels, saveGameState);
        if (plan.length > 0) {
          try {
            await refreshRemoteManifest(cleanUrl, game.name);
          } catch {
            /* non-fatal: a stale baseline only costs an extra download later */
          }
        }

        if (plan.length > 0 && failedRels.length === 0) {
          try {
            await axios.post(`${cleanUrl}/api/save-versions`, {
              game: game.name,
              deviceId: os.hostname(),
              changeSummary: `Synced ${plan.length} changed file(s)`,
            }, { headers: serverHeaders({ 'Content-Type': 'application/json' }) });
          } catch {
            /* Version creation is non-fatal; sync already succeeded. */
          }
        }

        totalAttempted += attempted
        totalFailed += failedRels.length
        // Never claim "In Sync" for a game whose changed files didn't all land.
        if (failedRels.length === 0 && filePaths.length > 0) {
          game.status = 'In Sync'
          game.lastSync = new Date().toISOString()
        } else if (failedRels.length > 0) {
          game.status = 'Error'
        }
      }
    }

    store.set('games', games)
    if (totalFailed > 0) {
      return { success: false, message: `Background sync completed with ${totalFailed}/${totalAttempted} file(s) failed.` }
    }
    return { success: true, message: 'Background sync complete.' }
  } catch (err) {
    return { success: false, message: 'Background sync failed: ' + (errorMessage(err) || String(err)) }
  }
}

type ProgressFn = (percent: number, message: string) => void

async function performCloudSyncWithProgress(credentials: Cloud, progress: ProgressFn) {
  if (isCloudSyncing) {
    return { success: false, message: 'Sync already in progress.' };
  }
  isCloudSyncing = true;

  try {
    progress(5, 'Connecting to Dune Server...')
    const cleanUrl = normalizeUrl(credentials.url)
    const games = (store.get('games') || []) as Game[]

    const filesToUpload: { game: string, local: string, rel: string }[] = [];

    progress(15, 'Scanning local files...')
    for (const game of games) {
      const rawPath = process.platform === 'win32' ? game.winPath : game.linPath
      const expanded = expandPath(rawPath)
      if (expanded && fs.existsSync(expanded)) {
        const stats = fs.statSync(expanded);
        if (stats.isDirectory()) {
          const findFiles = (dir: string, base: string) => {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
              if (item.isSymbolicLink()) continue;
              const fullPath = path.join(dir, item.name);
              if (item.isDirectory()) {
                findFiles(fullPath, base);
              } else {
                filesToUpload.push({ game: game.name, local: fullPath, rel: path.relative(base, fullPath) });
              }
            }
          };
          findFiles(expanded, expanded);
        } else {
          filesToUpload.push({ game: game.name, local: expanded, rel: path.basename(expanded) });
        }
      }
    }

    if (filesToUpload.length === 0) {
      progress(0, '')
      return { success: false, message: 'No valid saves to sync. Check your game path mappings.' }
    }

    // Group by game and keep only files that changed since the last push.
    const byGame = new Map<string, { local: string; rel: string }[]>();
    for (const f of filesToUpload) {
      const list = byGame.get(f.game) || [];
      list.push({ local: f.local, rel: f.rel });
      byGame.set(f.game, list);
    }

    // Apply per-game backup profiles before planning uploads.
    const profilesByGame = new Map<string, { includeGlobs: string[]; excludeGlobs: string[] }>();
    for (const game of byGame.keys()) {
      try {
        const profileRes = await axios.get(`${cleanUrl}/api/backup-profile?game=${encodeURIComponent(game)}`, { headers: serverHeaders() });
        if (profileRes.data?.success && profileRes.data.profile) {
          profilesByGame.set(game, profileRes.data.profile);
        }
      } catch {
        profilesByGame.set(game, { includeGlobs: ['**/*'], excludeGlobs: [] });
      }
    }
    for (const [game, files] of Array.from(byGame.entries())) {
      const profile = profilesByGame.get(game) || { includeGlobs: ['**/*'], excludeGlobs: [] };
      const filtered = filterBackupFiles(files, profile);
      if (filtered.length === 0) byGame.delete(game);
      else byGame.set(game, filtered);
    }

    const plans = new Map<string, ReturnType<typeof planUpload>>();
    for (const [game, files] of byGame) plans.set(game, planUpload(game, files, getSyncState));

    const toUpload = [...plans.values()].flatMap(p => p.plan);
    const deletions = [...plans.entries()].flatMap(([game, p]) =>
      p.deleted.map(rel => ({ game, rel })),
    );

    const syncId = Date.now().toString();
    const CHUNK_SIZE = 5;
    const failedByGame = new Map<string, string[]>();
    const total = toUpload.length;

    if (total > 0) {
      progress(20, `Uploading ${total} changed file(s)...`);
    }
    for (let i = 0; i < total; i += CHUNK_SIZE) {
      const chunk = toUpload.slice(i, i + CHUNK_SIZE);
      const percent = 20 + Math.round((i / Math.max(1, total)) * 75);
      progress(percent, `Uploading: Batch ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(total / CHUNK_SIZE)}`);

      await Promise.all(chunk.map(async (file) => {
        try {
          await uploadFile(cleanUrl, file.game, file.local, file.rel, syncId);
        } catch (e) {
          failedByGame.set(file.game, [...(failedByGame.get(file.game) || []), file.rel]);
          console.error(`Sync error on ${file.rel}:`, errorMessage(e));
        }
      }));
    }

    // Mirror local deletions (best-effort; never fatal).
    for (const { game, rel } of deletions) {
      try {
        await deleteRemoteFile(cleanUrl, game, rel);
      } catch {
        /* keep going */
      }
    }

    // Persist exactly what landed, per game.
    for (const [game, p] of plans) {
      commitUploaded(game, p.localManifest, failedByGame.get(game) || [], saveGameState);
    }

    // Refresh the server baseline for games we pushed to, so a later restore is
    // a no-op rather than re-downloading files we just uploaded.
    for (const [game, p] of plans) {
      if (p.plan.length === 0) continue;
      try {
        await refreshRemoteManifest(cleanUrl, game);
      } catch {
        /* non-fatal: a stale baseline only costs an extra download later */
      }
    }

    for (const [game, p] of plans) {
      if (p.plan.length === 0 || (failedByGame.get(game) || []).length > 0) continue;
      try {
        await axios.post(`${cleanUrl}/api/save-versions`, {
          game,
          deviceId: os.hostname(),
          changeSummary: `Synced ${p.plan.length} changed file(s)`,
        }, { headers: serverHeaders({ 'Content-Type': 'application/json' }) });
      } catch {
        /* Version creation is non-fatal; sync already succeeded. */
      }
    }

    // Update status: "In Sync" only when every changed file for that game succeeded.
    games.forEach((g: Game) => {
      if (!plans.has(g.name)) return;
      const failed = failedByGame.get(g.name)?.length ?? 0;
      if (failed === 0) {
        g.status = 'In Sync';
        g.lastSync = new Date().toISOString();
      } else {
        g.status = 'Error';
      }
    });

    store.set('games', games)

    const failedTotal = [...failedByGame.values()].reduce((a, b) => a + b.length, 0);
    if (failedTotal > 0) {
      progress(100, `Sync finished with ${failedTotal} failed file(s)`);
      return { success: false, message: `Sync completed with ${failedTotal} of ${total} changed file(s) failed.` };
    }
    progress(100, 'Sync complete! 🎉')
    return {
      success: true,
      message: total === 0 ? 'Already up to date — no changed files.' : `Synced ${total} changed file(s).`,
    }
  } catch (err) {
    progress(0, '')
    return { success: false, message: 'Sync failed: ' + (errorMessage(err) || String(err)) }
  } finally {
    isCloudSyncing = false;
  }
}

async function performCloudRestoreWithProgress(credentials: Cloud, progress: ProgressFn) {
  if (isCloudSyncing) {
    return { success: false, message: 'Sync already in progress.' };
  }
  isCloudSyncing = true;

  try {
    progress(5, 'Connecting to Dune Server...')
    const cleanUrl = normalizeUrl(credentials.url)
    const games = (store.get('games') || []) as Game[]

    let restoredCount = 0;
    const CHUNK_SIZE = 5;

    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      const overallPercent = 10 + Math.round((i / games.length) * 85);
      progress(overallPercent, `Checking server for: ${game.name}`);

      const manifestRes = await axios.get(
        `${cleanUrl}/api/manifest?game=${encodeURIComponent(game.name)}`,
        { headers: serverHeaders() },
      );
      const files: { path: string; size: number; mtimeMs: number; hash: string }[] = manifestRes.data.files || [];

      if (files.length > 0) {
        const rawPath = process.platform === 'win32' ? game.winPath : game.linPath;
        const expanded = expandPath(rawPath);
        if (!expanded) continue;

        // If 'expanded' is a direct file path, 'restoreBase' is its parent; if it
        // is (or will be) a directory, 'restoreBase' is the directory itself.
        const exists = fs.existsSync(expanded);
        const restoreBase = (exists && !fs.statSync(expanded).isDirectory()) || (!exists && path.extname(expanded))
          ? path.dirname(expanded)
          : expanded;

        // Delta: download only files that are missing locally or whose server
        // content changed since this client last pulled the manifest.
        const known = getSyncState()[game.name]?.remote || {};
        const serverHashes: HashManifest = {};
        const toDownload: typeof files = [];
        for (const file of files) {
          serverHashes[file.path] = file.hash;
          const target = path.join(restoreBase, file.path);
          if (!fs.existsSync(target) || known[file.path] !== file.hash) toDownload.push(file);
        }

        progress(overallPercent, `Restoring ${game.name}: ${toDownload.length}/${files.length} file(s)`);

        for (let j = 0; j < toDownload.length; j += CHUNK_SIZE) {
          const chunk = toDownload.slice(j, j + CHUNK_SIZE);
          await Promise.all(chunk.map(async (file) => {
            const relPath = file.path;
            const target = path.join(restoreBase, relPath);
            const targetDir = path.dirname(target);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }

            const response = await axios.get(
              `${cleanUrl}/api/download-file?game=${encodeURIComponent(game.name)}&path=${encodeURIComponent(relPath)}`,
              { responseType: 'arraybuffer', headers: serverHeaders() }
            );
            fs.writeFileSync(target, Buffer.from(response.data));
          }));
        }

        // Record the server state we just reconciled against.
        saveGameState(game.name, { remote: serverHashes });

        game.status = 'In Sync';
        game.lastSync = new Date().toISOString();
        restoredCount++;
      }
    }

    store.set('games', games)
    progress(100, 'Restore complete! 🎉')
    return { success: true, message: `Successfully restored ${restoredCount} game(s)!` }
  } catch (err) {
    progress(0, '')
    return { success: false, message: 'Restore failed: ' + (errorMessage(err) || String(err)) }
  } finally {
    isCloudSyncing = false;
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

// Renderer runs with contextIsolation but must still be treated as
// untrusted input at every IPC boundary: validate shapes, whitelist
// fields, and normalize types before touching the store or fs.
const ART_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

ipcMain.handle('config:load', () => {
  return {
    games: store.get('games'),
    cloud: store.get('cloud'),
    settings: store.get('settings')
  }
})

ipcMain.handle('config:save', (_event, config) => {
  const cfg = (config ?? {}) as Record<string, unknown>;
  if (Array.isArray(cfg.games)) {
    const clean: Game[] = [];
    for (const g of cfg.games) {
      try {
        const raw = (g ?? {}) as Record<string, unknown>;
        const id = Number(raw.id);
        const now = new Date().toISOString();
        clean.push({
          ...sanitizeGame(g),
          id: Number.isFinite(id) ? id : nextId(),
          createdAt: asString(raw.createdAt, 64) || now,
          updatedAt: asString(raw.updatedAt, 64) || now,
        });
      } catch { /* drop malformed entries rather than persisting them */ }
    }
    store.set('games', clean);
  }
  if (cfg.cloud && typeof cfg.cloud === 'object') {
    store.set('cloud', { url: asString((cfg.cloud as Record<string, unknown>).url) });
    void flushPlaytimeQueue();
  }
  if (cfg.settings && typeof cfg.settings === 'object') {
    store.set('settings', sanitizeSettings(cfg.settings, store.get('settings')));
    setupAutoSync();
  }
  return true;
});

ipcMain.handle('game:add', (_event, game) => {
  const games = (store.get('games') || []) as Game[];
  const now = new Date().toISOString();
  games.push({ ...sanitizeGame(game), id: nextId(), createdAt: now, updatedAt: now });
  store.set('games', games);
  return games;
});

ipcMain.handle('game:remove', (_event, id) => {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) throw new Error('Invalid game id');
  let games = (store.get('games') || []) as Game[];
  games = games.filter((g: Game) => g.id !== numericId);
  store.set('games', games);
  return games;
});

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
  const detected = [...(await autoDetectGames(roots)), ...getEmulatorGames()];
  const games = (store.get('games') || []) as Game[];
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

ipcMain.handle('sync:export', async () => {
  if (!mainWindow) return { success: false }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Saves Archive',
    defaultPath: 'gamesaves_backup.zip'
  })
  if (canceled || !filePath) return { success: false }

  try {
    const zip = new AdmZip()
    const games = (store.get('games') || []) as Game[]

    for (const game of games) {
      const rawPath = process.platform === 'win32' ? game.winPath : game.linPath
      const expanded = expandPath(rawPath)
      if (!expanded || !fs.existsSync(expanded)) continue
      const stats = fs.statSync(expanded)
      if (stats.isDirectory()) {
        zip.addLocalFolder(expanded, game.name)
      } else {
        zip.addLocalFile(expanded, game.name)
      }
    }

    zip.writeZip(filePath)
    return { success: true, path: filePath, message: 'Archive successfully created!' }
  } catch (e) {
    console.error(e)
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('sync:cloud', async (_event, credentials) => {
  store.set('cloud', credentials)
  const sender = _event.sender
  const sendProgress = (percent: number, message: string) => {
    if (!sender.isDestroyed()) {
      sender.send('sync:progress', { percent, message })
    }
  }
  return await performCloudSyncWithProgress(credentials, sendProgress)
})

ipcMain.handle('sync:restore', async (_event, credentials) => {
  store.set('cloud', credentials)
  const sender = _event.sender
  const sendProgress = (percent: number, message: string) => {
    if (!sender.isDestroyed()) {
      sender.send('sync:progress', { percent, message })
    }
  }
  return await performCloudRestoreWithProgress(credentials, sendProgress)
})

ipcMain.handle('sync:test', async (_event, credentials) => {
  try {
    const cleanUrl = normalizeUrl(credentials.url)
    const res = await axios.get(`${cleanUrl}/api/saves`, { headers: serverHeaders() });
    if (res.data.success) return { success: true, message: '✅ Connection to Dune Server successful!' }
    else return { success: false, message: '❌ Server reached but returned an error response.' }
  } catch (err) {
    let msg = errorMessage(err) || String(err);
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
    if (code === 'ECONNREFUSED') msg = 'Connection refused. Is the server running?';
    if (code === 'ENOTFOUND')    msg = 'Server address not found. Check your URL.';
    return { success: false, message: '❌ ' + msg }
  }
})

const thumbDir = path.join(app.getPath('userData'), 'thumbnails');

// ── Error log (crash reporting) ────────────────────────────────────────────
// Renderer + main-process failures land here; inspected via "Open Error Log"
// or by opening the file directly. Rotated at ~1 MB to bound disk use.
export function errorLogPath(): string {
  return path.join(app.getPath('userData'), 'dune-errors.log');
}

export function appendErrorLog(source: string, payload: Record<string, unknown>): void {
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

ipcMain.handle('openErrorLog', async () => {
  const { shell } = await import('electron');
  appendErrorLog('app', { message: 'error log opened by user' });
  shell.openPath(errorLogPath());
  return true;
});

// ── Auto-updates (packaged builds only) ────────────────────────────────────
function setupAutoUpdates(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => {
    appendErrorLog('updater', { message: String(e?.message || e) });
  });
  autoUpdater.on('update-downloaded', () => {
    appendErrorLog('updater', { message: 'update downloaded, will install on quit' });
  });
  const check = () => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      appendErrorLog('updater', { message: String(e?.message || e) });
    });
  };
  check();
  setInterval(check, 24 * 60 * 60 * 1000).unref();
}

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
  fs.copyFileSync(filePaths[0], targetPath);

  const games = (store.get('games') || []) as Game[];
  const game = games.find((g: Game) => g.id === numericId);
  if (game) {
    game.thumbnail = `local://${targetPath}`
    store.set('games', games)
  }
  return `local://${targetPath}`
})

ipcMain.handle('game:fetchArt', async (_event, id, name) => {
  const settings = store.get('settings') as Settings | undefined
  const apiKey = settings?.steamGridDbKey
  if (!apiKey) return { success: false, message: 'No SteamGridDB API Key found in settings.' }

  try {
    const searchRes = await axios.get(
      `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    )
    if (!searchRes.data.data || searchRes.data.data.length === 0)
      return { success: false, message: 'Game not found on SteamGridDB.' }

    const gameId = searchRes.data.data[0].id
    const gridRes = await axios.get(
      `https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=600x900,460x215,920x430`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    )
    if (!gridRes.data.data || gridRes.data.data.length === 0)
      return { success: false, message: 'No grid images found.' }

    const imgUrl = gridRes.data.data[0].url
    const response = await axios.get(imgUrl, { responseType: 'arraybuffer' })
    const numericId = Number(id)
    if (!Number.isFinite(numericId)) return { success: false, message: 'Invalid game id' }
    // Same allowlist as setCustomArt: the remote URL must not dictate the
    // extension written into thumbDir.
    const rawExt = path.extname(new URL(imgUrl).pathname).toLowerCase()
    const ext = ART_EXTS.includes(rawExt) ? rawExt : '.jpg'
    const targetPath = path.join(thumbDir, `${numericId}${ext}`)
    fs.writeFileSync(targetPath, Buffer.from(response.data))

    const games = (store.get('games') || []) as Game[]
    const game = games.find((g: Game) => g.id === numericId)
    if (game) {
      game.thumbnail = `local://${targetPath}`
      store.set('games', games)
    }
    return { success: true, thumbnail: `local://${targetPath}` }
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// ── NEW IPC Handlers for Server Integration ─────────────────────────────────────

// Playtime
ipcMain.handle('playtime:record', async (_event, session: PlaytimeSessionPayload) => {
  try {
    const res = await postPlaytimeSession(session);
    if (res.success) {
      void flushPlaytimeQueue();
      mainWindow?.webContents.send('playtime:recorded', {
        game: session.game,
        durationMinutes: session.durationMinutes,
      });
    }
    return res;
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
})

ipcMain.handle('playtime:summary', async (_event, game) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, summary: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const url = game ? `${cleanUrl}/api/playtime?game=${encodeURIComponent(game)}` : `${cleanUrl}/api/playtime`
    const res = await axios.get(url, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), summary: [] }
  }
})

ipcMain.handle('playtime:recent', async (_event, limit) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, sessions: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const url = `${cleanUrl}/api/playtime/recent${limit ? `?limit=${limit}` : ''}`
    const res = await axios.get(url, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), sessions: [] }
  }
})

ipcMain.handle('playtime:total', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, totalMinutes: 0 }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/playtime/total`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), totalMinutes: 0 }
  }
})
ipcMain.handle('playtime:graph', async (_event, range, customRange) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured', data: { line: [], bar: [], pie: [], heatmap: [], area: [] } }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const params = new URLSearchParams({ range: range || 'all' })
    if (customRange?.start) params.set('start', customRange.start)
    if (customRange?.end) params.set('end', customRange.end)
    const res = await axios.get(`${cleanUrl}/api/playtime/graph?${params.toString()}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), data: { line: [], bar: [], pie: [], heatmap: [], area: [] } }
  }
})

ipcMain.handle('playtime:comparison', async (_event, range) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/playtime/comparison?range=${encodeURIComponent(range || 'week')}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('playtime:export', async (_event, format, range, customRange) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured', data: '' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const params = new URLSearchParams({ format: format || 'json', range: range || 'all' })
    if (customRange?.start) params.set('start', customRange.start)
    if (customRange?.end) params.set('end', customRange.end)
    const res = await axios.get(`${cleanUrl}/api/playtime/export?${params.toString()}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), data: '' }
  }
})


// Achievements
ipcMain.handle('achievements:get', async (_event, game) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, achievements: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/achievements/${encodeURIComponent(game)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), achievements: [] }
  }
})
ipcMain.handle('achievements:detail', async (_event, game: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured', achievements: [], progress: null }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/achievements/detail/${encodeURIComponent(game)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), achievements: [], progress: null }
  }
})


ipcMain.handle('achievements:summary', async (_event, game) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, summary: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const url = game ? `${cleanUrl}/api/achievements?game=${encodeURIComponent(game)}` : `${cleanUrl}/api/achievements`
    const res = await axios.get(url, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), summary: [] }
  }
})

ipcMain.handle('achievements:importLocal', async (_event, game: Game) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, count: 0, message: 'No Dune Server configured' }

  try {
    const achievements = scanLocalAchievements(getAchievementRoots(game))
    if (achievements.length === 0) {
      return { success: true, count: 0, message: 'No local achievement files found' }
    }

    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/achievements/import`, {
      game: game.name,
      achievements,
    }, { headers: serverHeaders({ 'Content-Type': 'application/json' }) })
    return res.data
  } catch (e) {
    return { success: false, count: 0, message: errorMessage(e) }
  }
})

ipcMain.handle('achievements:recent', async (_event, limit) => {  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, unlocks: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const url = `${cleanUrl}/api/achievements/recent${limit ? `?limit=${limit}` : ''}`
    const res = await axios.get(url, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), unlocks: [] }
  }
})

// HLTB
ipcMain.handle('hltb:get', async (_event, gameName) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/hltb/${encodeURIComponent(gameName)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// Save versions
ipcMain.handle('saves:listVersions', async (_event, game: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured', versions: [] }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/save-versions?game=${encodeURIComponent(game)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), versions: [] }
  }
})

ipcMain.handle('saves:createVersion', async (_event, game: string, deviceId?: string, changeSummary?: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/save-versions`, { game, deviceId, changeSummary }, { headers: serverHeaders({ 'Content-Type': 'application/json' }) })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('saves:getVersion', async (_event, id: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/save-versions/${encodeURIComponent(id)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('saves:diff', async (_event, from: string, to: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/save-versions/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('saves:restore', async (_event, game: string, versionId: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/restore-version`, { game, versionId }, { headers: serverHeaders({ 'Content-Type': 'application/json' }) })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// Conflicts
ipcMain.handle('conflicts:list', async (_event, game?: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured', conflicts: [] }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const url = game ? `${cleanUrl}/api/conflicts?game=${encodeURIComponent(game)}` : `${cleanUrl}/api/conflicts`
    const res = await axios.get(url, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), conflicts: [] }
  }
})

ipcMain.handle('conflicts:detect', async (_event, game: string, localVersionId: string, remoteVersionId: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/conflicts/detect`, { game, localVersionId, remoteVersionId }, { headers: serverHeaders({ 'Content-Type': 'application/json' }) })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('conflicts:resolve', async (_event, id: string, resolution: 'local' | 'remote' | 'both' | 'later') => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/conflicts/${encodeURIComponent(id)}/resolve`, { resolution }, { headers: serverHeaders({ 'Content-Type': 'application/json' }) })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// Backup profiles
ipcMain.handle('backupProfile:get', async (_event, game: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/backup-profile?game=${encodeURIComponent(game)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('backupProfile:set', async (_event, profile: BackupProfile & { game?: string }) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/backup-profile`, profile, { headers: serverHeaders({ 'Content-Type': 'application/json' }) })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// Storage
ipcMain.handle('storage:get', async (_event, game: string) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured', entry: null }
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/storage?game=${encodeURIComponent(game)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), entry: null }
  }
})

// Game launcher
ipcMain.handle('game:launch', async (_event, game: Game, options?: Record<string, unknown>) => {
  try {
    const tracking = {
      onExit: ({ startedAt, endedAt }: { startedAt: number; endedAt: number }) => {
        void recordLaunchPlaytime(game.name, startedAt, endedAt);
      },
    };
    const result = await launchGame(game, (options || {}) as LaunchOptions, tracking);
    return result;
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
});

ipcMain.handle('game:launchCommand', async (_event, game, options) => {
  try {
    return { success: true, command: getLaunchCommand(game, options || {}) };
  } catch (e) {
    return { success: false, message: errorMessage(e), command: null };
  }
});

// Prefix manager
ipcMain.handle('prefix:list', async () => {
  try {
    return { success: true, prefixes: listPrefixes() };
  } catch (e) {
    return { success: false, message: errorMessage(e), prefixes: null };
  }
});

ipcMain.handle('prefix:create', async (_event, prefixPath: string) => {
  try {
    return createWinePrefix(expandPath(prefixPath));
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
});

ipcMain.handle('prefix:delete', async (_event, prefixPath: string) => {
  try {
    return deleteWinePrefix(prefixPath);
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
});

ipcMain.handle('prefix:backup', async (_event, prefixPath: string) => {
  try {
    return backupWinePrefix(prefixPath);
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
});

// AI Analysis
ipcMain.handle('ai:analyze', async (_event, { gameName, files }) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/analyze-files-ai`, { gameName, files }, {
      headers: serverHeaders({ 'Content-Type': 'application/json' })
    })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// SteamGridDB Art
ipcMain.handle('art:search', async (_event, query) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/search-art?query=${encodeURIComponent(query)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('art:auto-match', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/auto-match-all`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// Local Sync
ipcMain.handle('local-sync:trigger', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/local-sync`, {}, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('local-sources:get', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, sources: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/local-sources`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), sources: [] }
  }
})

ipcMain.handle('local-sources:add', async (_event, sourcePath) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/local-sources`, { path: sourcePath }, {
      headers: serverHeaders({ 'Content-Type': 'application/json' })
    })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('local-sources:remove', async (_event, id) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.delete(`${cleanUrl}/api/local-sources/${id}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// Remote Servers
ipcMain.handle('remote-servers:get', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, servers: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/remote-servers`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), servers: [] }
  }
})

ipcMain.handle('remote-servers:add', async (_event, url) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/remote-servers`, { url }, {
      headers: serverHeaders({ 'Content-Type': 'application/json' })
    })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('remote-servers:remove', async (_event, id) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.delete(`${cleanUrl}/api/remote-servers/${id}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// API Keys
ipcMain.handle('api-keys:get', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, keys: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/api-keys`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), keys: [] }
  }
})

ipcMain.handle('api-keys:add', async (_event, { description }) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    // Server issues a fresh high-entropy key; the plaintext is returned once.
    const res = await axios.post(`${cleanUrl}/api/api-keys`, { description }, {
      headers: serverHeaders({ 'Content-Type': 'application/json' })
    })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

ipcMain.handle('api-keys:remove', async (_event, id) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.delete(`${cleanUrl}/api/api-keys/${encodeURIComponent(id)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// Ollama
ipcMain.handle('ollama:models', async (_event, endpoint) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured', models: [] }

  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/ollama-models?endpoint=${encodeURIComponent(endpoint)}`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e), models: [] }
  }
})

ipcMain.handle('ollama:health', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }

  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/ollama-health`, { headers: serverHeaders() })
    return res.data
  } catch (e) {
    return { success: false, message: errorMessage(e) }
  }
})

// Server API key (stored locally, sent as x-api-key on every server call)
ipcMain.handle('server-key:get', () => {
  return { success: true, key: loadServerKey() };
});

ipcMain.handle('server-key:set', (_event, key: string) => {
  saveServerKey(key);
  return { success: true };
});

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
    setupAutoSync();
    setupAutoUpdates();
    void flushPlaytimeQueue();
  });
}
