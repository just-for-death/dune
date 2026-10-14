import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, protocol, safeStorage } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import Store from 'electron-store'
import AdmZip from 'adm-zip'
import axios from 'axios'
import { autoDetectGames } from './scanner'
import { autoUpdater } from 'electron-updater'

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

const store = new Store({
  defaults: {
    games: defaultGames,
    cloud: { url: '' },
    serverApiKey: '',
    serverApiKeyEnc: '',
    settings: {
      runInBackground: false,
      autoSyncEnabled: false,
      autoSyncFreq: 'never',
      steamGridDbKey: '',
      scanRoots: []
    }
  }
})

// Auth header for Dune Server calls. The server requires x-api-key on every
// route except /health; without it the whole client↔server integration 401s.
function serverHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = loadServerKey();
  return key ? { ...extra, 'x-api-key': key } : { ...extra };
}

// Server API key storage. Prefer the OS keychain via Electron safeStorage;
// fall back to plaintext electron-store where encryption is unavailable
// (e.g. Linux without a keyring) — single-user self-hosted threat model.
const LEGACY_KEY = 'serverApiKey';
const ENC_KEY = 'serverApiKeyEnc';

function loadServerKey(): string {
  const enc = store.get(ENC_KEY, '') as string;
  if (enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64')).toString();
    } catch {
      return '';
    }
  }
  // Legacy plaintext (pre-keychain installs): use as-is; next set() migrates.
  return (store.get(LEGACY_KEY, '') as string) || '';
}

function saveServerKey(key: string): void {
  const clean = (key || '').trim();
  if (clean && safeStorage.isEncryptionAvailable()) {
    try {
      store.set(ENC_KEY, safeStorage.encryptString(clean).toString('base64'));
      store.delete(LEGACY_KEY);
      return;
    } catch {
      // Fall through to plaintext.
    }
  } else if (!clean) {
    store.delete(ENC_KEY);
  }
  store.set(LEGACY_KEY, clean);
}

function expandPath(p: string) {
  if (!p) return ''
  if (process.platform === 'win32') {
    return p.replace(/%USERPROFILE%/g, process.env.USERPROFILE || '')
  } else {
    return p.replace(/^~/, process.env.HOME || '')
  }
}

let autoSyncInterval: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let isCloudSyncing = false;

function normalizeUrl(url: string) {
  if (!url) return '';
  let normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = 'http://' + normalized;
  }
  return normalized.replace(/\/+$/, '');
}

function setupAutoSync() {
  if (autoSyncInterval) clearInterval(autoSyncInterval);
  const settings: any = store.get('settings');
  if (settings?.autoSyncEnabled && settings?.autoSyncFreq && settings.autoSyncFreq !== 'never') {
    let ms = 0;
    if (settings.autoSyncFreq === '1h')  ms = 60 * 60 * 1000;
    if (settings.autoSyncFreq === '6h')  ms = 6 * 60 * 60 * 1000;
    if (settings.autoSyncFreq === '24h') ms = 24 * 60 * 60 * 1000;

    if (ms > 0) {
      autoSyncInterval = setInterval(async () => {
        if (isCloudSyncing) return;
        const creds: any = store.get('cloud');
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

async function uploadFile(baseUrl: string, gameName: string, localPath: string, relativePath: string, syncId?: string) {
  const cleanUrl = normalizeUrl(baseUrl);
  const stream = fs.createReadStream(localPath);
  await axios.post(`${cleanUrl}/api/upload-file`, stream, {
    headers: serverHeaders({
      'x-game': gameName,
      'x-path': relativePath,
      'x-sync-id': syncId || 'default',
      'Content-Type': 'application/octet-stream'
    })
  });
}

async function performCloudSync(credentials: any) {
  try {
    const games: any = store.get('games') || []
    const cleanUrl = normalizeUrl(credentials.url)

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
        for (let i = 0; i < filePaths.length; i += 5) {
          const chunk = filePaths.slice(i, i + 5);
          await Promise.all(chunk.map(async (f) => {
            try {
              await uploadFile(cleanUrl, game.name, f.local, f.rel, syncId);
            } catch (e) {
              console.error(`Failed to sync ${f.rel}:`, e);
            }
          }));
        }
        game.status = 'In Sync'
        game.lastSync = new Date().toISOString()
      }
    }

    store.set('games', games)
    return { success: true, message: 'Background sync complete.' }
  } catch (err: any) {
    return { success: false, message: 'Background sync failed: ' + (err.message || String(err)) }
  }
}

type ProgressFn = (percent: number, message: string) => void

async function performCloudSyncWithProgress(credentials: any, progress: ProgressFn) {
  if (isCloudSyncing) {
    return { success: false, message: 'Sync already in progress.' };
  }
  isCloudSyncing = true;

  try {
    progress(5, 'Connecting to Dune Server...')
    const cleanUrl = normalizeUrl(credentials.url)
    const games: any = store.get('games') || []

    let filesToUpload: { game: string, local: string, rel: string }[] = [];

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

    const syncId = Date.now().toString();
    const CHUNK_SIZE = 5;
    for (let i = 0; i < filesToUpload.length; i += CHUNK_SIZE) {
      const chunk = filesToUpload.slice(i, i + CHUNK_SIZE);
      const percent = 20 + Math.round((i / filesToUpload.length) * 75);
      progress(percent, `Uploading: Batch ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(filesToUpload.length / CHUNK_SIZE)}`);

      await Promise.all(chunk.map(async (file) => {
        try {
          await uploadFile(cleanUrl, file.game, file.local, file.rel, syncId);
        } catch (e: any) {
          console.error(`Sync error on ${file.rel}:`, e.message);
        }
      }));
    }

    // Update status
    games.forEach((g: any) => {
      const rawPath = process.platform === 'win32' ? g.winPath : g.linPath
      const expandedPath = expandPath(rawPath);
      if (expandedPath && fs.existsSync(expandedPath)) {
        g.status = 'In Sync';
        g.lastSync = new Date().toISOString();
      }
    });

    store.set('games', games)
    progress(100, 'Sync complete! 🎉')
    return { success: true, message: 'Saves synced successfully!' }
  } catch (err: any) {
    progress(0, '')
    return { success: false, message: 'Sync failed: ' + (err.message || String(err)) }
  } finally {
    isCloudSyncing = false;
  }
}

async function performCloudRestoreWithProgress(credentials: any, progress: ProgressFn) {
  if (isCloudSyncing) {
    return { success: false, message: 'Sync already in progress.' };
  }
  isCloudSyncing = true;

  try {
    progress(5, 'Connecting to Dune Server...')
    const cleanUrl = normalizeUrl(credentials.url)
    const games: any = store.get('games') || []

    let restoredCount = 0;
    const CHUNK_SIZE = 5;

    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      const overallPercent = 10 + Math.round((i / games.length) * 85);
      progress(overallPercent, `Checking server for: ${game.name}`);

      const listRes = await axios.get(`${cleanUrl}/api/list-files?game=${encodeURIComponent(game.name)}`, { headers: serverHeaders() });
      const files: { path: string; name: string; size: number }[] = listRes.data.files || [];

      if (files.length > 0) {
        const rawPath = process.platform === 'win32' ? game.winPath : game.linPath;
        const expanded = expandPath(rawPath);
        if (!expanded) continue;

        // CRITICAL BUG FIX: If 'expanded' is a direct file path, 'restoreBase' must be the parent directory.
        // If 'expanded' is a directory, 'restoreBase' is the directory itself.
        // If 'expanded' doesn't exist yet, we guess from the extension.
        const exists = fs.existsSync(expanded);
        const restoreBase = (exists && !fs.statSync(expanded).isDirectory()) || (!exists && path.extname(expanded))
          ? path.dirname(expanded)
          : expanded;

        for (let j = 0; j < files.length; j += CHUNK_SIZE) {
          const chunk = files.slice(j, j + CHUNK_SIZE);
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
        game.status = 'In Sync';
        game.lastSync = new Date().toISOString();
        restoredCount++;
      }
    }

    store.set('games', games)
    progress(100, 'Restore complete! 🎉')
    return { success: true, message: `Successfully restored ${restoredCount} game(s)!` }
  } catch (err: any) {
    progress(0, '')
    return { success: false, message: 'Restore failed: ' + (err.message || String(err)) }
  } finally {
    isCloudSyncing = false;
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

// Renderer runs with contextIsolation but must still be treated as
// untrusted input at every IPC boundary: validate shapes, whitelist
// fields, and normalize types before touching the store or fs.
const GAME_STATUSES = ['Pending Upload', 'In Sync', 'Error'];
const AUTO_SYNC_FREQS = ['never', '1h', '6h', '24h'];
const ART_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

function asString(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function sanitizeGame(input: unknown): { name: string; winPath: string; linPath: string; lastSync: string; status: string; thumbnail: string } {
  const g = (input ?? {}) as Record<string, unknown>;
  const name = asString(g.name, 200).trim();
  if (!name) throw new Error('Game title is required');
  const status = asString(g.status, 32);
  return {
    name,
    winPath: asString(g.winPath),
    linPath: asString(g.linPath),
    lastSync: asString(g.lastSync, 64) || 'Never',
    status: GAME_STATUSES.includes(status) ? status : 'Pending Upload',
    thumbnail: asString(g.thumbnail),
  };
}

function sanitizeSettings(input: unknown, fallback: any): any {
  const s = (input ?? {}) as Record<string, unknown>;
  const scanRoots = Array.isArray(s.scanRoots)
    ? s.scanRoots.filter((r): r is string => typeof r === 'string').slice(0, 50).map(r => r.slice(0, 2000))
    : fallback?.scanRoots ?? [];
  const freq = asString(s.autoSyncFreq, 8);
  return {
    runInBackground: s.runInBackground === true,
    autoSyncEnabled: s.autoSyncEnabled === true,
    autoSyncFreq: AUTO_SYNC_FREQS.includes(freq) ? freq : 'never',
    steamGridDbKey: asString(s.steamGridDbKey, 500),
    scanRoots,
  };
}

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
    const clean: any[] = [];
    for (const g of cfg.games) {
      try {
        const raw = (g ?? {}) as Record<string, unknown>;
        const id = Number(raw.id);
        clean.push({
          ...sanitizeGame(g),
          id: Number.isFinite(id) ? id : Date.now() + clean.length,
        });
      } catch { /* drop malformed entries rather than persisting them */ }
    }
    store.set('games', clean);
  }
  if (cfg.cloud && typeof cfg.cloud === 'object') {
    store.set('cloud', { url: asString((cfg.cloud as Record<string, unknown>).url) });
  }
  if (cfg.settings && typeof cfg.settings === 'object') {
    store.set('settings', sanitizeSettings(cfg.settings, store.get('settings')));
    setupAutoSync();
  }
  return true;
});

ipcMain.handle('game:add', (_event, game) => {
  const games: any = store.get('games') || [];
  games.push({ ...sanitizeGame(game), id: Date.now() });
  store.set('games', games);
  return games;
});

ipcMain.handle('game:remove', (_event, id) => {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) throw new Error('Invalid game id');
  let games: any = store.get('games') || [];
  games = games.filter((g: any) => g.id !== numericId);
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
  const detected = await autoDetectGames(customRoots || [])
  const games: any = store.get('games') || []
  for (const d of detected) {
    if (!games.find((g: any) => g.name === d.name)) {
      games.push({ ...d, thumbnail: '' })
    }
  }
  store.set('games', games)
  return { count: detected.length, currentGames: games }
})

ipcMain.handle('sync:export', async () => {
  if (!mainWindow) return { success: false }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Saves Archive',
    defaultPath: 'gamesaves_backup.zip'
  })
  if (canceled || !filePath) return { success: false }

  try {
    const zip = new AdmZip()
    const games: any = store.get('games') || []

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
  } catch (e: any) {
    console.error(e)
    return { success: false, message: e.message }
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
  } catch (err: any) {
    let msg = err.message || String(err);
    if (err.code === 'ECONNREFUSED') msg = 'Connection refused. Is the server running?';
    if (err.code === 'ENOTFOUND')    msg = 'Server address not found. Check your URL.';
    return { success: false, message: '❌ ' + msg }
  }
})

const thumbDir = path.join(app.getPath('userData'), 'thumbnails');

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

  const games: any = store.get('games') || [];
  const game = games.find((g: any) => g.id === numericId);
  if (game) {
    game.thumbnail = `local://${targetPath}`
    store.set('games', games)
  }
  return `local://${targetPath}`
})

ipcMain.handle('game:fetchArt', async (_event, id, name) => {
  const settings: any = store.get('settings')
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
    const ext = path.extname(new URL(imgUrl).pathname) || '.jpg'
    const targetPath = path.join(thumbDir, `${id}${ext}`)
    fs.writeFileSync(targetPath, Buffer.from(response.data))

    const games: any = store.get('games') || []
    const game = games.find((g: any) => g.id === id)
    if (game) {
      game.thumbnail = `local://${targetPath}`
      store.set('games', games)
    }
    return { success: true, thumbnail: `local://${targetPath}` }
  } catch (e: any) {
    return { success: false, message: e.message }
  }
})

// ── NEW IPC Handlers for Server Integration ─────────────────────────────────────

// Playtime
ipcMain.handle('playtime:record', async (_event, session) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/playtime`, session, {
      headers: serverHeaders({ 'Content-Type': 'application/json' })
    })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message }
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
  } catch (e: any) {
    return { success: false, message: e.message, summary: [] }
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
  } catch (e: any) {
    return { success: false, message: e.message, sessions: [] }
  }
})

ipcMain.handle('playtime:total', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, totalMinutes: 0 }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/playtime/total`, { headers: serverHeaders() })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message, totalMinutes: 0 }
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
  } catch (e: any) {
    return { success: false, message: e.message, achievements: [] }
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
  } catch (e: any) {
    return { success: false, message: e.message, summary: [] }
  }
})

ipcMain.handle('achievements:recent', async (_event, limit) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, unlocks: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const url = `${cleanUrl}/api/achievements/recent${limit ? `?limit=${limit}` : ''}`
    const res = await axios.get(url, { headers: serverHeaders() })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message, unlocks: [] }
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
  } catch (e: any) {
    return { success: false, message: e.message }
  }
})

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
  } catch (e: any) {
    return { success: false, message: e.message }
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
  } catch (e: any) {
    return { success: false, message: e.message }
  }
})

ipcMain.handle('art:auto-match', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/auto-match-all`, { headers: serverHeaders() })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message }
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
  } catch (e: any) {
    return { success: false, message: e.message }
  }
})

ipcMain.handle('local-sources:get', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, sources: [] }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/local-sources`, { headers: serverHeaders() })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message, sources: [] }
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
  } catch (e: any) {
    return { success: false, message: e.message }
  }
})

ipcMain.handle('local-sources:remove', async (_event, id) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.delete(`${cleanUrl}/api/local-sources/${id}`, { headers: serverHeaders() })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message }
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
  } catch (e: any) {
    return { success: false, message: e.message, servers: [] }
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
  } catch (e: any) {
    return { success: false, message: e.message }
  }
})

ipcMain.handle('remote-servers:remove', async (_event, id) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.delete(`${cleanUrl}/api/remote-servers/${id}`, { headers: serverHeaders() })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message }
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
  } catch (e: any) {
    return { success: false, message: e.message, keys: [] }
  }
})

ipcMain.handle('api-keys:add', async (_event, { key, description }) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.post(`${cleanUrl}/api/api-keys`, { key, description }, {
      headers: serverHeaders({ 'Content-Type': 'application/json' })
    })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message }
  }
})

ipcMain.handle('api-keys:remove', async (_event, key) => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false }
  
  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.delete(`${cleanUrl}/api/api-keys/${encodeURIComponent(key)}`, { headers: serverHeaders() })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message }
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
  } catch (e: any) {
    return { success: false, message: e.message, models: [] }
  }
})

ipcMain.handle('ollama:health', async () => {
  const cloud = store.get('cloud')
  if (!cloud?.url) return { success: false, message: 'No Dune Server configured' }

  try {
    const cleanUrl = normalizeUrl(cloud.url)
    const res = await axios.get(`${cleanUrl}/api/ollama-health`, { headers: serverHeaders() })
    return res.data
  } catch (e: any) {
    return { success: false, message: e.message }
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
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  const win = mainWindow

  const iconCandidates = [
    path.join(__dirname, '../public/tray-icon.ico'),
    path.join(__dirname, '../public/tray-icon.png'),
    path.join(process.resourcesPath || '', 'tray-icon.ico'),
    path.join(process.resourcesPath || '', 'tray-icon.png'),
  ]
  let iconPath = ''
  for (const c of iconCandidates) {
    if (fs.existsSync(c)) { iconPath = c; break }
  }
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()

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
    const settings: any = store.get('settings')
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
  const settings: any = store.get('settings')
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

app.whenReady().then(() => {
  if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })

  protocol.registerFileProtocol('local', (request, callback) => {
    // Sandbox: only thumbnails written by this app are servable. Anything
    // else (including traversal attempts) is rejected.
    try {
      const resolved = path.resolve(decodeURIComponent(request.url.replace('local://', '')))
      const root = path.resolve(thumbDir) + path.sep
      if (!resolved.startsWith(root)) {
        return callback({ error: -6 })
      }
      return callback({ path: resolved })
    } catch (e) {
      console.error(e)
      return callback({ error: -6 })
    }
  })

  createWindow()
  setupAutoSync()
  setupAutoUpdates()
})
