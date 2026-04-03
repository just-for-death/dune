"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("electronAPI", {
  exportSaves: () => electron.ipcRenderer.invoke("sync:export"),
  syncCloud: (credentials) => electron.ipcRenderer.invoke("sync:cloud", credentials),
  restoreCloud: (credentials) => electron.ipcRenderer.invoke("sync:restore", credentials),
  loadConfig: () => electron.ipcRenderer.invoke("config:load"),
  saveConfig: (config) => electron.ipcRenderer.invoke("config:save", config),
  addGame: (game) => electron.ipcRenderer.invoke("game:add", game),
  removeGame: (id) => electron.ipcRenderer.invoke("game:remove", id),
  autoDetectGames: (customRoots) => electron.ipcRenderer.invoke("games:autodetect", customRoots),
  selectDirectory: () => electron.ipcRenderer.invoke("dialog:selectDirectory"),
  testCloud: (credentials) => electron.ipcRenderer.invoke("sync:test", credentials),
  fetchArt: (id, name) => electron.ipcRenderer.invoke("game:fetchArt", id, name),
  setCustomArt: (id) => electron.ipcRenderer.invoke("game:setCustomArt", id),
  // Returns a cleanup fn — call it in useEffect return to avoid memory leaks
  onSyncProgress: (cb) => {
    const handler = (_, data) => cb(data);
    electron.ipcRenderer.on("sync:progress", handler);
    return () => electron.ipcRenderer.removeListener("sync:progress", handler);
  }
});
