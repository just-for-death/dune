import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, protocol } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import Store from 'electron-store'
import AdmZip from 'adm-zip'
import axios from 'axios'
import { autoDetectGames } from './scanner'

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
    cloud: { url: '' }, // Simplified: only needs URL for Dune Server
    settings: {
      runInBackground: false,
      autoSyncEnabled: false,
      autoSyncFreq: 'never',
      steamGridDbKey: '',
      scanRoots: []
    }
  }
})

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

let isAutoSyncing = false;

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
    if (settings.autoSyncFreq === '1h') ms = 60 * 60 * 1000;
    if (settings.autoSyncFreq === '6h') ms = 6 * 60 * 60 * 1000;
    if (settings.autoSyncFreq === '24h') ms = 24 * 60 * 60 * 1000;
    
    if (ms > 0) {
      autoSyncInterval = setInterval(async () => {
        if (isAutoSyncing) return;
        const creds: any = store.get('cloud');
        if (creds?.url) {
          isAutoSyncing = true;
          try {
            await performCloudSync(creds);
          } finally {
            isAutoSyncing = false;
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
        headers: {
            'x-game': gameName,
            'x-path': relativePath,
            'x-sync-id': syncId || 'default',
            'Content-Type': 'application/octet-stream'
        }
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
        // Collect all file paths first
        const filePaths: { local: string, rel: string }[] = [];
        const stats = fs.statSync(expanded);
        if (stats.isDirectory()) {
            const walk = (dir: string, base: string) => {
                const items = fs.readdirSync(dir);
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    if (fs.statSync(fullPath).isDirectory()) {
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
        // Process in controlled chunks of 5
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
        game.lastSync = new Date().toLocaleString()
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
                const items = fs.readdirSync(dir);
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    if (fs.statSync(fullPath).isDirectory()) {
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
      return { success: false, message: 'No valid saves to sync.' }
    }

    const syncId = Date.now().toString();
    const CHUNK_SIZE = 5;
    for (let i = 0; i < filesToUpload.length; i += CHUNK_SIZE) {
        const chunk = filesToUpload.slice(i, i + CHUNK_SIZE);
        const percent = 20 + Math.round((i / filesToUpload.length) * 75);
        progress(percent, `Uploading: Batch ${Math.floor(i/CHUNK_SIZE) + 1} / ${Math.ceil(filesToUpload.length/CHUNK_SIZE)}`);
        
        await Promise.all(chunk.map(async (file) => {
            try {
                await uploadFile(cleanUrl, file.game, file.local, file.rel, syncId);
            } catch (e) {
                console.error(`Sync error on ${file.rel}:`, e);
            }
        }));
    }

    // Update status
    games.forEach((g: any) => {
        const rawPath = process.platform === 'win32' ? g.winPath : g.linPath
        if (expandPath(rawPath) && fs.existsSync(expandPath(rawPath))) {
            g.status = 'In Sync';
            g.lastSync = new Date().toLocaleString();
        }
    });

    store.set('games', games)
    progress(100, 'Sync complete! 🎉')
    return { success: true, message: 'Saves synced successfully!' }
  } catch (err: any) {
    progress(0, '')
    return { success: false, message: 'Sync failed: ' + (err.message || String(err)) }
  }
}

async function performCloudRestoreWithProgress(credentials: any, progress: ProgressFn) {
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

        const listRes = await axios.get(`${cleanUrl}/api/list-files?game=${encodeURIComponent(game.name)}`);
        const files = listRes.data.files || [];

        if (files.length > 0) {
            const rawPath = process.platform === 'win32' ? game.winPath : game.linPath;
            const expanded = expandPath(rawPath);
            if (!expanded) continue;

            const restoreBase = (fs.existsSync(expanded) && !fs.statSync(expanded).isDirectory()) 
                ? path.dirname(expanded) 
                : expanded;

            for (let j = 0; j < files.length; j += CHUNK_SIZE) {
                const chunk = files.slice(j, j + CHUNK_SIZE);
                await Promise.all(chunk.map(async (relPath: string) => {
                    const target = path.join(restoreBase, relPath);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    
                    const response = await axios.get(`${cleanUrl}/api/download-file?game=${encodeURIComponent(game.name)}&path=${encodeURIComponent(relPath)}`, { responseType: 'arraybuffer' });
                    fs.writeFileSync(target, Buffer.from(response.data));
                }));
            }
            game.status = 'In Sync';
            game.lastSync = new Date().toLocaleString();
            restoredCount++;
        }
    }

    store.set('games', games)
    progress(100, 'Restore complete! 🎉')
    return { success: true, message: `Successfully restored ${restoredCount} games!` }
  } catch (err: any) {
    progress(0, '')
    return { success: false, message: 'Restore failed: ' + (err.message || String(err)) }
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('config:load', () => {
  return {
    games: store.get('games'),
    cloud: store.get('cloud'),
    settings: store.get('settings')
  }
})

ipcMain.handle('config:save', (_event, config) => {
  if (config.games) store.set('games', config.games)
  if (config.cloud) store.set('cloud', config.cloud)
  if (config.settings) {
    store.set('settings', config.settings)
    setupAutoSync()
  }
  return true
})

ipcMain.handle('game:add', (_event, game) => {
  const games: any = store.get('games') || []
  game.id = Date.now()
  games.push(game)
  store.set('games', games)
  return games
})

ipcMain.handle('game:remove', (_event, id) => {
  let games: any = store.get('games') || []
  games = games.filter((g: any) => g.id !== id)
  store.set('games', games)
  return games
})

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
    const res = await axios.get(`${cleanUrl}/api/saves`);
    if (res.data.success) return { success: true, message: '✅ Connection to Dune Server successful!' }
    else return { success: false, message: '❌ Server reached but returned an error response.' }
  } catch (err: any) {
    let msg = err.message || String(err);
    if (err.code === 'ECONNREFUSED') msg = 'Connection refused. Is the server running?';
    if (err.code === 'ENOTFOUND') msg = 'Server address not found. Check your URL.';
    return { success: false, message: '❌ ' + msg }
  }
})

const thumbDir = path.join(app.getPath('userData'), 'thumbnails');

ipcMain.handle('game:setCustomArt', async (_event, id) => {
  if (!mainWindow) return false
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Custom Art',
    filters: [{ name: 'Images', extensions: ['jpg', 'png', 'jpeg', 'webp'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return false

  const ext = path.extname(filePaths[0])
  const targetPath = path.join(thumbDir, `${id}${ext}`)
  fs.copyFileSync(filePaths[0], targetPath)

  const games: any = store.get('games') || []
  const game = games.find((g: any) => g.id === id)
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
    const searchRes = await axios.get(`https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (searchRes.data.data.length === 0) return { success: false, message: 'Game not found on SteamGridDB.' }
    const gameId = searchRes.data.data[0].id

    const gridRes = await axios.get(`https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=600x900,460x215,920x430`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (gridRes.data.data.length === 0) return { success: false, message: 'No grid images found.' }

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
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
  tray = new Tray(icon)
  tray.setToolTip('Dune')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show App', click: () => win.show() },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } }
  ]))
  tray.on('click', () => { win.show() })

  win.on('close', (event) => {
    const settings: any = store.get('settings')
    if (!isQuitting && settings?.runInBackground) {
      event.preventDefault()
      win.hide()
    } else {
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

app.whenReady().then(() => {
  if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true })

  protocol.registerFileProtocol('local', (request, callback) => {
    const url = request.url.replace('local://', '')
    try {
      return callback({ path: decodeURIComponent(url) })
    } catch (e) {
      console.error(e)
      return callback({ path: url })
    }
  })

  createWindow()
  setupAutoSync()
})
