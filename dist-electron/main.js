"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const Store = require("electron-store");
const AdmZip = require("adm-zip");
const axios = require("axios");
const YAML = require("yaml");
const os = require("os");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const os__namespace = /* @__PURE__ */ _interopNamespaceDefault(os);
const MANIFEST_URL = "https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml";
function translatePath(template) {
  let mapped = template;
  const home = os__namespace.homedir();
  const replacements = {
    "<home>": home,
    "<userProfile>": home,
    "<winAppData>": process.env.APPDATA || path__namespace.join(home, "AppData", "Roaming"),
    "<winLocalAppData>": process.env.LOCALAPPDATA || path__namespace.join(home, "AppData", "Local"),
    "<winDocuments>": path__namespace.join(home, "Documents"),
    "<winPublic>": process.env.PUBLIC || "C:\\Users\\Public",
    "<winProgramFiles>": process.env.ProgramFiles || "C:\\Program Files",
    "<winProgramFilesX86>": process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "<osUserName>": process.env.USERNAME || process.env.USER || "User",
    "<steam>": process.platform === "win32" ? "C:\\Program Files (x86)\\Steam" : path__namespace.join(home, ".steam", "steam")
  };
  for (const [token, value] of Object.entries(replacements)) {
    mapped = mapped.split(token).join(value);
  }
  return path__namespace.normalize(mapped);
}
function translatePathOverride(template, root) {
  let mapped = template;
  const replacements = {
    "<home>": root,
    "<winAppData>": path__namespace.join(root, "AppData", "Roaming"),
    "<winLocalAppData>": path__namespace.join(root, "AppData", "Local"),
    "<winDocuments>": path__namespace.join(root, "Documents"),
    "<winPublic>": path__namespace.join(root, "..", "Public"),
    "<winProgramFiles>": path__namespace.join(root, "..", "..", "Program Files"),
    "<winProgramFilesX86>": path__namespace.join(root, "..", "..", "Program Files (x86)"),
    "<steam>": path__namespace.join(root, "..", "..", "Program Files (x86)", "Steam"),
    // Also substitute username so paths like <osUserName>/Saved Games resolve correctly
    "<osUserName>": process.env.USERNAME || process.env.USER || "User"
  };
  for (const [token, value] of Object.entries(replacements)) {
    mapped = mapped.split(token).join(value);
  }
  return path__namespace.normalize(mapped);
}
function expandCustomRoots(customRoots) {
  const expanded = [];
  for (const root of customRoots) {
    expanded.push(root);
    if (process.platform !== "win32") {
      try {
        const items = fs__namespace.readdirSync(root, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            const basePrefix = path__namespace.join(root, item.name, "drive_c", "users");
            if (fs__namespace.existsSync(basePrefix)) {
              for (const un of ["steamuser", "lutrisuser", process.env.USER || ""]) {
                if (!un)
                  continue;
                const userDir = path__namespace.join(basePrefix, un);
                if (fs__namespace.existsSync(userDir))
                  expanded.push(userDir);
              }
            }
          }
        }
      } catch (e) {
      }
    }
  }
  return expanded;
}
async function autoDetectGames(customRoots = []) {
  const discovered = [];
  try {
    const response = await axios.get(MANIFEST_URL);
    const manifest = YAML.parse(response.data);
    if (!manifest)
      return [];
    const activeRoots = expandCustomRoots(customRoots);
    for (const [gameName, gameData] of Object.entries(manifest)) {
      if (!gameData.files)
        continue;
      let validPath = "";
      for (const template of Object.keys(gameData.files)) {
        const rawTrans = translatePath(template);
        if (fs__namespace.existsSync(rawTrans)) {
          validPath = rawTrans;
          break;
        }
        for (const root of activeRoots) {
          const overrideTrans = translatePathOverride(template, root);
          if (fs__namespace.existsSync(overrideTrans)) {
            validPath = overrideTrans;
            break;
          }
        }
        if (validPath)
          break;
      }
      if (validPath) {
        discovered.push({
          id: Date.now() + Math.random(),
          name: gameName,
          winPath: process.platform === "win32" ? validPath : "",
          linPath: process.platform !== "win32" ? validPath : "",
          status: "Pending Upload",
          lastSync: "Never"
        });
      }
    }
    return discovered;
  } catch (error) {
    console.error("Scanner failed:", error);
    return [];
  }
}
const defaultGames = [
  {
    id: 1,
    name: "Cyberpunk 2077",
    winPath: "%USERPROFILE%\\Saved Games\\CD Projekt Red\\Cyberpunk 2077",
    linPath: "~/.steam/steam/steamapps/compatdata/1091500/pfx/drive_c/users/steamuser/Saved Games/CD Projekt Red/Cyberpunk 2077",
    lastSync: "Never",
    status: "Pending Upload",
    thumbnail: ""
  }
];
const store = new Store({
  defaults: {
    games: defaultGames,
    cloud: { url: "" },
    // Simplified: only needs URL for Dune Server
    settings: {
      runInBackground: false,
      autoSyncEnabled: false,
      autoSyncFreq: "never",
      steamGridDbKey: "",
      scanRoots: []
    }
  }
});
function expandPath(p) {
  if (!p)
    return "";
  if (process.platform === "win32") {
    return p.replace(/%USERPROFILE%/g, process.env.USERPROFILE || "");
  } else {
    return p.replace(/^~/, process.env.HOME || "");
  }
}
let autoSyncInterval = null;
let tray = null;
let isQuitting = false;
let mainWindow = null;
let isAutoSyncing = false;
function normalizeUrl(url) {
  if (!url)
    return "";
  let normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = "http://" + normalized;
  }
  return normalized.replace(/\/+$/, "");
}
function setupAutoSync() {
  if (autoSyncInterval)
    clearInterval(autoSyncInterval);
  const settings = store.get("settings");
  if ((settings == null ? void 0 : settings.autoSyncEnabled) && (settings == null ? void 0 : settings.autoSyncFreq) && settings.autoSyncFreq !== "never") {
    let ms = 0;
    if (settings.autoSyncFreq === "1h")
      ms = 60 * 60 * 1e3;
    if (settings.autoSyncFreq === "6h")
      ms = 6 * 60 * 60 * 1e3;
    if (settings.autoSyncFreq === "24h")
      ms = 24 * 60 * 60 * 1e3;
    if (ms > 0) {
      autoSyncInterval = setInterval(async () => {
        if (isAutoSyncing)
          return;
        const creds = store.get("cloud");
        if (creds == null ? void 0 : creds.url) {
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
async function uploadFile(baseUrl, gameName, localPath, relativePath, syncId) {
  const cleanUrl = normalizeUrl(baseUrl);
  const stream = fs__namespace.createReadStream(localPath);
  await axios.post(`${cleanUrl}/api/upload-file`, stream, {
    headers: {
      "x-game": gameName,
      "x-path": relativePath,
      "x-sync-id": syncId || "default",
      "Content-Type": "application/octet-stream"
    }
  });
}
async function performCloudSync(credentials) {
  try {
    const games = store.get("games") || [];
    const cleanUrl = normalizeUrl(credentials.url);
    for (const game of games) {
      const rawPath = process.platform === "win32" ? game.winPath : game.linPath;
      const expanded = expandPath(rawPath);
      if (expanded && fs__namespace.existsSync(expanded)) {
        const filePaths = [];
        const stats = fs__namespace.statSync(expanded);
        if (stats.isDirectory()) {
          const walk = (dir, base) => {
            const items = fs__namespace.readdirSync(dir);
            for (const item of items) {
              const fullPath = path__namespace.join(dir, item);
              if (fs__namespace.statSync(fullPath).isDirectory()) {
                walk(fullPath, base);
              } else {
                filePaths.push({ local: fullPath, rel: path__namespace.relative(base, fullPath) });
              }
            }
          };
          walk(expanded, expanded);
        } else {
          filePaths.push({ local: expanded, rel: path__namespace.basename(expanded) });
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
        game.status = "In Sync";
        game.lastSync = (/* @__PURE__ */ new Date()).toLocaleString();
      }
    }
    store.set("games", games);
    return { success: true, message: "Background sync complete." };
  } catch (err) {
    return { success: false, message: "Background sync failed: " + (err.message || String(err)) };
  }
}
async function performCloudSyncWithProgress(credentials, progress) {
  try {
    progress(5, "Connecting to Dune Server...");
    const cleanUrl = normalizeUrl(credentials.url);
    const games = store.get("games") || [];
    let filesToUpload = [];
    progress(15, "Scanning local files...");
    for (const game of games) {
      const rawPath = process.platform === "win32" ? game.winPath : game.linPath;
      const expanded = expandPath(rawPath);
      if (expanded && fs__namespace.existsSync(expanded)) {
        const stats = fs__namespace.statSync(expanded);
        if (stats.isDirectory()) {
          const findFiles = (dir, base) => {
            const items = fs__namespace.readdirSync(dir);
            for (const item of items) {
              const fullPath = path__namespace.join(dir, item);
              if (fs__namespace.statSync(fullPath).isDirectory()) {
                findFiles(fullPath, base);
              } else {
                filesToUpload.push({ game: game.name, local: fullPath, rel: path__namespace.relative(base, fullPath) });
              }
            }
          };
          findFiles(expanded, expanded);
        } else {
          filesToUpload.push({ game: game.name, local: expanded, rel: path__namespace.basename(expanded) });
        }
      }
    }
    if (filesToUpload.length === 0) {
      progress(0, "");
      return { success: false, message: "No valid saves to sync." };
    }
    const syncId = Date.now().toString();
    const CHUNK_SIZE = 5;
    for (let i = 0; i < filesToUpload.length; i += CHUNK_SIZE) {
      const chunk = filesToUpload.slice(i, i + CHUNK_SIZE);
      const percent = 20 + Math.round(i / filesToUpload.length * 75);
      progress(percent, `Uploading: Batch ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(filesToUpload.length / CHUNK_SIZE)}`);
      await Promise.all(chunk.map(async (file) => {
        try {
          await uploadFile(cleanUrl, file.game, file.local, file.rel, syncId);
        } catch (e) {
          console.error(`Sync error on ${file.rel}:`, e);
        }
      }));
    }
    games.forEach((g) => {
      const rawPath = process.platform === "win32" ? g.winPath : g.linPath;
      if (expandPath(rawPath) && fs__namespace.existsSync(expandPath(rawPath))) {
        g.status = "In Sync";
        g.lastSync = (/* @__PURE__ */ new Date()).toLocaleString();
      }
    });
    store.set("games", games);
    progress(100, "Sync complete! 🎉");
    return { success: true, message: "Saves synced successfully!" };
  } catch (err) {
    progress(0, "");
    return { success: false, message: "Sync failed: " + (err.message || String(err)) };
  }
}
async function performCloudRestoreWithProgress(credentials, progress) {
  try {
    progress(5, "Connecting to Dune Server...");
    const cleanUrl = normalizeUrl(credentials.url);
    const games = store.get("games") || [];
    let restoredCount = 0;
    const CHUNK_SIZE = 5;
    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      const overallPercent = 10 + Math.round(i / games.length * 85);
      progress(overallPercent, `Checking server for: ${game.name}`);
      const listRes = await axios.get(`${cleanUrl}/api/list-files?game=${encodeURIComponent(game.name)}`);
      const files = listRes.data.files || [];
      if (files.length > 0) {
        const rawPath = process.platform === "win32" ? game.winPath : game.linPath;
        const expanded = expandPath(rawPath);
        if (!expanded)
          continue;
        const restoreBase = fs__namespace.existsSync(expanded) && !fs__namespace.statSync(expanded).isDirectory() ? path__namespace.dirname(expanded) : expanded;
        for (let j = 0; j < files.length; j += CHUNK_SIZE) {
          const chunk = files.slice(j, j + CHUNK_SIZE);
          await Promise.all(chunk.map(async (relPath) => {
            const target = path__namespace.join(restoreBase, relPath);
            fs__namespace.mkdirSync(path__namespace.dirname(target), { recursive: true });
            const response = await axios.get(`${cleanUrl}/api/download-file?game=${encodeURIComponent(game.name)}&path=${encodeURIComponent(relPath)}`, { responseType: "arraybuffer" });
            fs__namespace.writeFileSync(target, Buffer.from(response.data));
          }));
        }
        game.status = "In Sync";
        game.lastSync = (/* @__PURE__ */ new Date()).toLocaleString();
        restoredCount++;
      }
    }
    store.set("games", games);
    progress(100, "Restore complete! 🎉");
    return { success: true, message: `Successfully restored ${restoredCount} games!` };
  } catch (err) {
    progress(0, "");
    return { success: false, message: "Restore failed: " + (err.message || String(err)) };
  }
}
electron.ipcMain.handle("config:load", () => {
  return {
    games: store.get("games"),
    cloud: store.get("cloud"),
    settings: store.get("settings")
  };
});
electron.ipcMain.handle("config:save", (_event, config) => {
  if (config.games)
    store.set("games", config.games);
  if (config.cloud)
    store.set("cloud", config.cloud);
  if (config.settings) {
    store.set("settings", config.settings);
    setupAutoSync();
  }
  return true;
});
electron.ipcMain.handle("game:add", (_event, game) => {
  const games = store.get("games") || [];
  game.id = Date.now();
  games.push(game);
  store.set("games", games);
  return games;
});
electron.ipcMain.handle("game:remove", (_event, id) => {
  let games = store.get("games") || [];
  games = games.filter((g) => g.id !== id);
  store.set("games", games);
  return games;
});
electron.ipcMain.handle("dialog:selectDirectory", async () => {
  if (!mainWindow)
    return { success: false };
  const { canceled, filePaths } = await electron.dialog.showOpenDialog(mainWindow, {
    title: "Select Custom Scan Directory",
    properties: ["openDirectory"]
  });
  if (!canceled && filePaths.length > 0) {
    return { success: true, path: filePaths[0] };
  }
  return { success: false };
});
electron.ipcMain.handle("games:autodetect", async (_event, customRoots) => {
  const detected = await autoDetectGames(customRoots || []);
  const games = store.get("games") || [];
  for (const d of detected) {
    if (!games.find((g) => g.name === d.name)) {
      games.push({ ...d, thumbnail: "" });
    }
  }
  store.set("games", games);
  return { count: detected.length, currentGames: games };
});
electron.ipcMain.handle("sync:export", async () => {
  if (!mainWindow)
    return { success: false };
  const { canceled, filePath } = await electron.dialog.showSaveDialog(mainWindow, {
    title: "Export Saves Archive",
    defaultPath: "gamesaves_backup.zip"
  });
  if (canceled || !filePath)
    return { success: false };
  try {
    const zip = new AdmZip();
    const games = store.get("games") || [];
    for (const game of games) {
      const rawPath = process.platform === "win32" ? game.winPath : game.linPath;
      const expanded = expandPath(rawPath);
      if (!expanded || !fs__namespace.existsSync(expanded))
        continue;
      const stats = fs__namespace.statSync(expanded);
      if (stats.isDirectory()) {
        zip.addLocalFolder(expanded, game.name);
      } else {
        zip.addLocalFile(expanded, game.name);
      }
    }
    zip.writeZip(filePath);
    return { success: true, path: filePath, message: "Archive successfully created!" };
  } catch (e) {
    console.error(e);
    return { success: false, message: e.message };
  }
});
electron.ipcMain.handle("sync:cloud", async (_event, credentials) => {
  store.set("cloud", credentials);
  const sender = _event.sender;
  const sendProgress = (percent, message) => {
    if (!sender.isDestroyed()) {
      sender.send("sync:progress", { percent, message });
    }
  };
  return await performCloudSyncWithProgress(credentials, sendProgress);
});
electron.ipcMain.handle("sync:restore", async (_event, credentials) => {
  store.set("cloud", credentials);
  const sender = _event.sender;
  const sendProgress = (percent, message) => {
    if (!sender.isDestroyed()) {
      sender.send("sync:progress", { percent, message });
    }
  };
  return await performCloudRestoreWithProgress(credentials, sendProgress);
});
electron.ipcMain.handle("sync:test", async (_event, credentials) => {
  try {
    const cleanUrl = normalizeUrl(credentials.url);
    const res = await axios.get(`${cleanUrl}/api/saves`);
    if (res.data.success)
      return { success: true, message: "✅ Connection to Dune Server successful!" };
    else
      return { success: false, message: "❌ Server reached but returned an error response." };
  } catch (err) {
    let msg = err.message || String(err);
    if (err.code === "ECONNREFUSED")
      msg = "Connection refused. Is the server running?";
    if (err.code === "ENOTFOUND")
      msg = "Server address not found. Check your URL.";
    return { success: false, message: "❌ " + msg };
  }
});
const thumbDir = path__namespace.join(electron.app.getPath("userData"), "thumbnails");
electron.ipcMain.handle("game:setCustomArt", async (_event, id) => {
  if (!mainWindow)
    return false;
  const { canceled, filePaths } = await electron.dialog.showOpenDialog(mainWindow, {
    title: "Select Custom Art",
    filters: [{ name: "Images", extensions: ["jpg", "png", "jpeg", "webp"] }],
    properties: ["openFile"]
  });
  if (canceled || filePaths.length === 0)
    return false;
  const ext = path__namespace.extname(filePaths[0]);
  const targetPath = path__namespace.join(thumbDir, `${id}${ext}`);
  fs__namespace.copyFileSync(filePaths[0], targetPath);
  const games = store.get("games") || [];
  const game = games.find((g) => g.id === id);
  if (game) {
    game.thumbnail = `local://${targetPath}`;
    store.set("games", games);
  }
  return `local://${targetPath}`;
});
electron.ipcMain.handle("game:fetchArt", async (_event, id, name) => {
  const settings = store.get("settings");
  const apiKey = settings == null ? void 0 : settings.steamGridDbKey;
  if (!apiKey)
    return { success: false, message: "No SteamGridDB API Key found in settings." };
  try {
    const searchRes = await axios.get(`https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (searchRes.data.data.length === 0)
      return { success: false, message: "Game not found on SteamGridDB." };
    const gameId = searchRes.data.data[0].id;
    const gridRes = await axios.get(`https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=600x900,460x215,920x430`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (gridRes.data.data.length === 0)
      return { success: false, message: "No grid images found." };
    const imgUrl = gridRes.data.data[0].url;
    const response = await axios.get(imgUrl, { responseType: "arraybuffer" });
    const ext = path__namespace.extname(new URL(imgUrl).pathname) || ".jpg";
    const targetPath = path__namespace.join(thumbDir, `${id}${ext}`);
    fs__namespace.writeFileSync(targetPath, Buffer.from(response.data));
    const games = store.get("games") || [];
    const game = games.find((g) => g.id === id);
    if (game) {
      game.thumbnail = `local://${targetPath}`;
      store.set("games", games);
    }
    return { success: true, thumbnail: `local://${targetPath}` };
  } catch (e) {
    return { success: false, message: e.message };
  }
});
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path__namespace.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  const win = mainWindow;
  const iconCandidates = [
    path__namespace.join(__dirname, "../public/tray-icon.ico"),
    path__namespace.join(__dirname, "../public/tray-icon.png"),
    path__namespace.join(process.resourcesPath || "", "tray-icon.ico"),
    path__namespace.join(process.resourcesPath || "", "tray-icon.png")
  ];
  let iconPath = "";
  for (const c of iconCandidates) {
    if (fs__namespace.existsSync(c)) {
      iconPath = c;
      break;
    }
  }
  const icon = iconPath ? electron.nativeImage.createFromPath(iconPath) : electron.nativeImage.createEmpty();
  tray = new electron.Tray(icon);
  tray.setToolTip("Dune");
  tray.setContextMenu(electron.Menu.buildFromTemplate([
    { label: "Show App", click: () => win.show() },
    { label: "Quit", click: () => {
      isQuitting = true;
      electron.app.quit();
    } }
  ]));
  tray.on("click", () => {
    win.show();
  });
  win.on("close", (event) => {
    const settings = store.get("settings");
    if (!isQuitting && (settings == null ? void 0 : settings.runInBackground)) {
      event.preventDefault();
      win.hide();
    } else {
      mainWindow = null;
    }
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path__namespace.join(__dirname, "../dist/index.html"));
  }
}
electron.app.on("before-quit", () => {
  isQuitting = true;
});
electron.app.whenReady().then(() => {
  if (!fs__namespace.existsSync(thumbDir))
    fs__namespace.mkdirSync(thumbDir, { recursive: true });
  electron.protocol.registerFileProtocol("local", (request, callback) => {
    const url = request.url.replace("local://", "");
    try {
      return callback({ path: decodeURIComponent(url) });
    } catch (e) {
      console.error(e);
      return callback({ path: url });
    }
  });
  createWindow();
  setupAutoSync();
});
