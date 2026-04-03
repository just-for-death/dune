import '@fontsource/inter';
import { useState, useEffect } from 'react';

// ── Typed IPC bridge ─────────────────────────────────────────────────────────
// Must mirror every key exposed in electron/preload.ts contextBridge call.
interface ElectronAPI {
  exportSaves:      () => Promise<{ success: boolean; path?: string; message?: string }>;
  syncCloud:        (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  restoreCloud:     (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  loadConfig:       () => Promise<{ games: Game[]; cloud: Cloud; settings: Settings }>;
  saveConfig:       (config: Partial<{ games: Game[]; cloud: Cloud; settings: Settings }>) => Promise<boolean>;
  addGame:          (game: Omit<Game, 'id'>) => Promise<Game[]>;
  removeGame:       (id: number) => Promise<Game[]>;
  autoDetectGames:  (roots: string[]) => Promise<{ count: number; currentGames: Game[] }>;
  selectDirectory:  () => Promise<{ success: boolean; path?: string }>;
  testCloud:        (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  fetchArt:         (id: number, name: string) => Promise<{ success: boolean; thumbnail?: string; message?: string }>;
  setCustomArt:     (id: number) => Promise<string | false>;
  onSyncProgress:   (cb: (data: { percent: number; message: string }) => void) => () => void;
}

interface Game {
  id: number;
  name: string;
  winPath: string;
  linPath: string;
  lastSync: string;
  status: string;
  thumbnail: string;
}

interface Cloud {
  url: string;
}

interface Settings {
  runInBackground: boolean;
  autoSyncEnabled: boolean;
  autoSyncFreq: string;
  steamGridDbKey: string;
  scanRoots: string[];
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

type Tab = 'dashboard' | 'mapping' | 'sync' | 'settings';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [games, setGames] = useState<Game[]>([]);
  const [cloud, setCloud] = useState<Cloud>({ url: '' });
  const [settings, setSettings] = useState<Settings>({
    runInBackground: false,
    autoSyncEnabled: false,
    autoSyncFreq: 'never',
    steamGridDbKey: '',
    scanRoots: []
  });
  
  const [newGameName, setNewGameName] = useState('');
  const [newGameWin, setNewGameWin] = useState('');
  const [newGameLin, setNewGameLin] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ percent: number; message: string; done: boolean; success: boolean } | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onSyncProgress((data: { percent: number; message: string }) => {
      if (data.percent === 0) return;
      setSyncProgress(prev => ({
        ...(prev ?? { percent: 0, message: '', done: false, success: false }),
        percent: data.percent,
        message: data.message,
        done: false,
        success: false
      }));
      if (data.percent === 100) {
        setSyncProgress({ percent: 100, message: data.message, done: true, success: true });
        setIsSyncing(false);
        setTimeout(() => setSyncProgress(null), 4000);
      }
    });
    return cleanup;
  }, []);

  const loadConfig = async () => {
    const config = await window.electronAPI.loadConfig();
    if (config) {
      if (config.games) setGames(config.games);
      if (config.cloud) setCloud(config.cloud);
      if (config.settings) {
        setSettings(prev => ({
          ...prev,
          ...config.settings,
          scanRoots: config.settings.scanRoots ?? prev.scanRoots ?? []
        }));
      }
    }
  };

  const saveSettings = async (newSettings: any) => {
    const s = { ...settings, ...newSettings };
    setSettings(s);
    await window.electronAPI.saveConfig({ settings: s });
  };

  const saveCloud = async (partialCloud?: any) => {
    const c = partialCloud ? { ...cloud, ...partialCloud } : cloud;
    setCloud(c);
    await window.electronAPI.saveConfig({ cloud: c });
    return c;
  };

  const handleAddRoot = async () => {
    const res = await window.electronAPI.selectDirectory();
    if (res && res.success) {
      const roots = [...settings.scanRoots, res.path];
      saveSettings({ scanRoots: roots });
    }
  };

  const handleRemoveRoot = (r: string) => {
    saveSettings({ scanRoots: settings.scanRoots.filter(x => x !== r) });
  };

  const handleAddGame = async () => {
    if (!newGameName) return;
    const added = await window.electronAPI.addGame({
      name: newGameName,
      winPath: newGameWin,
      linPath: newGameLin,
      lastSync: 'Never',
      status: 'Pending Upload',
      thumbnail: ''
    });
    setGames(added);
    setNewGameName(''); setNewGameWin(''); setNewGameLin('');
  };

  const handleAutoScan = async () => {
    setIsScanning(true);
    try {
      const res = await window.electronAPI.autoDetectGames(settings.scanRoots);
      setGames(res.currentGames);
      alert(`Finished scanning! Found ${res.count} natively matching game(s) residing on your machine!`);
    } catch(e) {
      alert('Scanning crashed internally.');
    }
    setIsScanning(false);
  };

  const handleExport = async () => {
    const res = await window.electronAPI.exportSaves();
    if (res.success) alert(res.message);
    else if (res.message) alert('Error: ' + res.message);
  };

  const handleCloudSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncProgress({ percent: 1, message: 'Preparing sync...', done: false, success: false });
    const res = await window.electronAPI.syncCloud(cloud);
    if (!res.success) {
      setSyncProgress({ percent: 0, message: res.message, done: true, success: false });
      setIsSyncing(false);
      setTimeout(() => setSyncProgress(null), 4000);
    } else {
      loadConfig();
    }
  };

  const handleRestoreCloud = async () => {
    if (isSyncing) return;
    const confirmRestore = confirm("This will OVERWRITE your local saves with the ones from your Dune Server. Are you sure you want to proceed?");
    if (!confirmRestore) return;

    setIsSyncing(true);
    setSyncProgress({ percent: 1, message: 'Preparing to restore...', done: false, success: false });
    const res = await window.electronAPI.restoreCloud(cloud);
    if (!res.success) {
      setSyncProgress({ percent: 0, message: res.message, done: true, success: false });
      setIsSyncing(false);
      setTimeout(() => setSyncProgress(null), 4000);
    } else {
      loadConfig();
    }
  };

  const handleTestCloud = async (overrideCloud?: any) => {
    const creds = overrideCloud || cloud;
    const res = await window.electronAPI.testCloud(creds);
    alert(res.message);
  };

  const handleFetchArt = async (game: any) => {
    const res = await window.electronAPI.fetchArt(game.id, game.name);
    if (res.success) {
      loadConfig();
    } else {
      alert(res.message);
    }
  };

  const handleSetCustomArt = async (game: any) => {
    const res = await window.electronAPI.setCustomArt(game.id);
    if (res) {
      loadConfig();
    }
  };

  return (
    <div className="layout">
      <div className="sidebar">
        <div className="sidebar-title">Dune</div>
        <button className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
          Dashboard
        </button>
        <button className={`nav-item ${activeTab === 'mapping' ? 'active' : ''}`} onClick={() => setActiveTab('mapping')}>
          Game Paths
        </button>
        <button className={`nav-item ${activeTab === 'sync' ? 'active' : ''}`} onClick={() => setActiveTab('sync')}>
          Cloud Sync
        </button>
        <button className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
          Settings
        </button>
      </div>
      
      <div className="main-content">
        {activeTab === 'dashboard' && (
          <div>
            <h2>Dashboard</h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>Overview of your local and synchronized game saves.</p>
            
            <div style={{ display: 'flex', gap: 16, marginBottom: 32 }}>
              <div className="card" style={{ flex: 1, margin: 0, borderTop: '4px solid var(--accent)' }}>
                <div style={{ fontSize: 24, fontWeight: 'bold' }}>{games.length}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 8 }}>Tracked Games</div>
              </div>
              <div className="card" style={{ flex: 1, margin: 0, borderTop: '4px solid var(--success)' }}>
                <div style={{ fontSize: 24, fontWeight: 'bold' }}>{games.filter(g => g.status === 'In Sync').length}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 8 }}>In Sync</div>
              </div>
              <div className="card" style={{ flex: 1, margin: 0, borderTop: '4px solid var(--danger)' }}>
                <div style={{ fontSize: 24, fontWeight: 'bold' }}>{games.filter(g => g.status !== 'In Sync').length}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 8 }}>Pending Sync</div>
              </div>
            </div>

            <div className="games-grid">
              {games.map(game => (
                <div key={game.id} className="game-card">
                  {game.thumbnail ? (
                    <img src={game.thumbnail} className="game-cover" alt={game.name} />
                  ) : (
                    <div className="game-cover-placeholder">No Cover Art</div>
                  )}
                  <div className="game-info">
                    <div className="game-title">{game.name}</div>
                    <div className="game-status" style={{
                      color: game.status === 'In Sync' ? 'var(--success)' : 'var(--danger)'
                    }}>
                      Status: {game.status} <br/>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>Sync: {game.lastSync}</span>
                    </div>
                    <div className="game-actions">
                      <button className="btn btn-secondary" onClick={() => handleFetchArt(game)}>Auto Art</button>
                      <button className="btn btn-secondary" onClick={() => handleSetCustomArt(game)}>Set Art</button>
                      <button className="btn btn-secondary" onClick={async () => {
                        const conf = confirm('Remove ' + game.name + '?')
                        if(conf) setGames(await window.electronAPI.removeGame(game.id))
                      }} style={{ flexBasis: '100%' }}>Remove Game</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {games.length === 0 && <p>No games tracked yet. Add them in Game Paths.</p>}
          </div>
        )}

        {activeTab === 'mapping' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <h2>Game Path Mapping</h2>
                <button 
                  className="btn btn-primary" 
                  disabled={isScanning}
                  onClick={handleAutoScan}
                  style={{ backgroundColor: isScanning ? 'var(--text-muted)' : 'var(--accent)' }}
                >
                  {isScanning ? 'Downloading Manifest & Scanning...' : '✨ Auto-Detect Games'}
                </button>
            </div>
            
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Add New Custom Mapping</h3>
              <div style={{ marginBottom: 16 }}>
                <label>Game Title</label>
                <input type="text" value={newGameName} onChange={e => setNewGameName(e.target.value)} placeholder="e.g. Hades" />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label>Windows Origin Path</label>
                <input type="text" value={newGameWin} onChange={e => setNewGameWin(e.target.value)} placeholder="%USERPROFILE%\\Documents\\Saved Games\\Hades" />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label>Linux Origin Path</label>
                <input type="text" value={newGameLin} onChange={e => setNewGameLin(e.target.value)} placeholder="~/.local/share/Hades/Saves" />
              </div>
              <button className="btn btn-primary" onClick={handleAddGame}>Save Mapping</button>
            </div>
          </div>
        )}

        {activeTab === 'sync' && (
          <div>
            <h2>Cloud Sync &amp; Local Backup</h2>

            {syncProgress && (
              <div className={`card sync-progress-card ${syncProgress.done ? (syncProgress.success ? 'sync-done' : 'sync-error') : 'sync-active'}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>
                    {syncProgress.done
                      ? (syncProgress.success ? '✅ Sync Complete' : '❌ Sync Failed')
                      : '☁️ Synchronizing with Dune Server...'}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>
                    {syncProgress.percent > 0 ? `${syncProgress.percent}%` : ''}
                  </div>
                </div>
                <div className="progress-track">
                  <div
                    className={`progress-fill ${syncProgress.done && syncProgress.success ? 'progress-done' : ''}`}
                    style={{ width: `${syncProgress.percent}%` }}
                  />
                </div>
                <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {!syncProgress.done && <span className="progress-spinner" />}
                  {syncProgress.message}
                </div>
              </div>
            )}

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Manual Local Export</h3>
              <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>Manually export all your mapped game saves into a single .zip file.</p>
              <button className="btn btn-primary" onClick={handleExport}>Compile &amp; Export All Saves (.zip)</button>
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Dune Server Synchronization &amp; Restore</h3>
              <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>Safely backup your games individually to your central <strong>Dune Server</strong>.</p>
              
              <div style={{ display: 'flex', gap: '16px' }}>
                <button
                  className="btn btn-primary"
                  onClick={handleCloudSync}
                  disabled={isSyncing}
                  style={{ opacity: isSyncing ? 0.6 : 1, cursor: isSyncing ? 'not-allowed' : 'pointer', flex: 1 }}
                >
                  {isSyncing ? '⏳ Working...' : '☁️ Push Saves to Server'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={handleRestoreCloud}
                  disabled={isSyncing}
                  style={{ opacity: isSyncing ? 0.6 : 1, cursor: isSyncing ? 'not-allowed' : 'pointer', flex: 1, borderColor: 'var(--accent)', color: 'var(--accent)' }}
                >
                  {isSyncing ? '⏳ Working...' : '⬇️ Restore from Server'}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div>
            <h2>Application Settings</h2>
            
            <div className="card">
              <h3 style={{ marginTop: 0 }}>General Settings</h3>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 16 }}>
                <input 
                  type="checkbox" 
                  checked={settings.runInBackground} 
                  onChange={e => saveSettings({ runInBackground: e.target.checked })}
                  style={{ width: 'auto', marginBottom: 0 }}
                />
                Run in background system tray when window is closed
              </label>

              <h4 style={{ marginTop: 24, marginBottom: 8 }}>SteamGridDB Integration</h4>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
                Provide an API key from SteamGridDB to enable automatic game thumbnail fetching.
              </p>
              <input 
                type="password" 
                value={settings.steamGridDbKey || ''} 
                onChange={e => saveSettings({ steamGridDbKey: e.target.value })} 
                placeholder="Paste API Key here" 
              />
            </div>

            <div className="card" style={{ marginBottom: 24 }}>
                <h3 style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between' }}>
                  Custom Scan Locations
                  <button className="btn btn-secondary" onClick={handleAddRoot} style={{ padding: '4px 8px', fontSize: 12 }}>+ Add Root</button>
                </h3>
                {settings.scanRoots.length > 0 ? (
                  <ul>
                    {settings.scanRoots.map((r, i) => (
                      <li key={i} style={{ padding: '4px 0' }}>📂 {r} <span style={{ color: 'var(--danger)', cursor: 'pointer', marginLeft: 8 }} onClick={() => handleRemoveRoot(r)}>[remove]</span></li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No custom locations added. Auto-detect will use default directories.</p>
                )}
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Dune Server Integration</h3>
              
              <div style={{ marginBottom: 16 }}>
                <label>Dune Server Address (with Port)</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. http://192.168.1.100:3030"
                  value={cloud.url}
                  onChange={e => saveCloud({ url: e.target.value })}
                />
              </div>

              <div style={{ display: 'flex', gap: 12, marginBottom: 24, marginTop: 16 }}>
                <button className="btn btn-primary" onClick={() => handleTestCloud()}>Test Server Connection</button>
              </div>

              <h4 style={{ borderTop: '1px solid var(--border-color)', paddingTop: 16, marginTop: 16 }}>Auto-Sync Status</h4>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                {settings.autoSyncEnabled 
                  ? `✅ Auto-sync is ACTIVE (${settings.autoSyncFreq})` 
                  : '❌ Auto-sync is DISABLED'}
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 16 }}>
                <input 
                  type="checkbox" 
                  checked={settings.autoSyncEnabled} 
                  onChange={e => saveSettings({ autoSyncEnabled: e.target.checked })}
                  style={{ width: 'auto', marginBottom: 0 }}
                />
                Enable automatic background sync
              </label>

              <label>Sync Frequency</label>
              <select 
                value={settings.autoSyncFreq} 
                onChange={e => saveSettings({ autoSyncFreq: e.target.value })}
                disabled={!settings.autoSyncEnabled}
              >
                <option value="never">Never (Manual Only)</option>
                <option value="1h">Every 1 Hour</option>
                <option value="6h">Every 6 Hours</option>
                <option value="24h">Daily</option>
              </select>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
