import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  exportSaves: () => ipcRenderer.invoke('sync:export'),
  syncCloud: (credentials: any) => ipcRenderer.invoke('sync:cloud', credentials),
  restoreCloud: (credentials: any) => ipcRenderer.invoke('sync:restore', credentials),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: any) => ipcRenderer.invoke('config:save', config),
  addGame: (game: any) => ipcRenderer.invoke('game:add', game),
  removeGame: (id: number) => ipcRenderer.invoke('game:remove', id),
  autoDetectGames: (customRoots: string[]) => ipcRenderer.invoke('games:autodetect', customRoots),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  testCloud: (credentials: any) => ipcRenderer.invoke('sync:test', credentials),
  fetchArt: (id: number, name: string) => ipcRenderer.invoke('game:fetchArt', id, name),
  setCustomArt: (id: number) => ipcRenderer.invoke('game:setCustomArt', id),
  // Returns a cleanup fn — call it in useEffect return to avoid memory leaks
  onSyncProgress: (cb: (data: { percent: number; message: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { percent: number; message: string }) => cb(data)
    ipcRenderer.on('sync:progress', handler)
    return () => ipcRenderer.removeListener('sync:progress', handler)
  }
})

