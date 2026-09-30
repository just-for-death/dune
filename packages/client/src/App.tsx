import '@fontsource/inter';
import { useState, useEffect, useCallback } from 'react';

// ── Typed IPC bridge ─────────────────────────────────────────────────────────
// Must mirror every key exposed in electron/preload.ts contextBridge call.
interface ElectronAPI {
  exportSaves: () => Promise<{ success: boolean; path?: string; message?: string }>;
  syncCloud: (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  restoreCloud: (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  loadConfig: () => Promise<{ games: Game[]; cloud: Cloud; settings: Settings } | null>;
  saveConfig: (config: Partial<{ games: Game[]; cloud: Cloud; settings: Settings }>) => Promise<boolean>;
  addGame: (game: Omit<Game, 'id'>) => Promise<Game[]>;
  removeGame: (id: number) => Promise<Game[]>;
  autoDetectGames: (roots: string[]) => Promise<{ count: number; currentGames: Game[] }>;
  selectDirectory: () => Promise<{ success: boolean; path?: string }>;
  testCloud: (creds: { url: string }) => Promise<{ success: boolean; message: string }>;
  fetchArt: (id: number, name: string) => Promise<{ success: boolean; thumbnail?: string; message?: string }>;
  setCustomArt: (id: number) => Promise<string | false>;
  onSyncProgress: (cb: (data: { percent: number; message: string }) => void) => () => void;
  // New server integration
  recordPlaytime: (session: { game: string; platform: string; sessionStart: string; sessionEnd: string }) => Promise<{ success: boolean; message?: string }>;
  getPlaytimeSummary: (game?: string) => Promise<{ success: boolean; summary: PlaytimeSummary[]; message?: string }>;
  getRecentSessions: (limit?: number) => Promise<{ success: boolean; sessions: unknown[]; message?: string }>;
  getTotalPlaytime: () => Promise<{ success: boolean; totalMinutes: number; message?: string }>;
  getAchievements: (game: string) => Promise<{ success: boolean; achievements: Achievement[]; message?: string }>;
  getAchievementSummary: (game?: string) => Promise<{ success: boolean; summary: AchievementSummary[]; message?: string }>;
  getRecentUnlocks: (limit?: number) => Promise<{ success: boolean; unlocks: unknown[]; message?: string }>;
  getHLTBTimes: (gameName: string) => Promise<{ success: boolean; times?: HLTBTimes; message?: string }>;
  analyzeFiles: (gameName: string, files: Array<{ path: string; size: number; category: string }>) => Promise<{ success: boolean; analysis?: Record<string, unknown>; message?: string }>;
  searchArt: (query: string) => Promise<{ success: boolean; results?: string[]; message?: string }>;
  autoMatchAll: () => Promise<{ success: boolean; count: number; message?: string }>;
  triggerLocalSync: () => Promise<{ success: boolean; count: number; games: string[]; message?: string }>;
  getLocalSources: () => Promise<{ success: boolean; sources: Array<{ id: number; path: string }>; message?: string }>;
  addLocalSource: (path: string) => Promise<{ success: boolean; source?: unknown; message?: string }>;
  removeLocalSource: (id: number) => Promise<{ success: boolean; message?: string }>;
  getRemoteServers: () => Promise<{ success: boolean; servers: Array<{ id: number; url: string }>; message?: string }>;
  addRemoteServer: (url: string) => Promise<{ success: boolean; server?: unknown; message?: string }>;
  removeRemoteServer: (id: number) => Promise<{ success: boolean; message?: string }>;
  getApiKeys: () => Promise<{ success: boolean; keys: string[]; message?: string }>;
  addApiKey: (key: string, description?: string) => Promise<{ success: boolean; message?: string }>;
  removeApiKey: (key: string) => Promise<{ success: boolean; message?: string }>;
  getOllamaModels: (endpoint: string) => Promise<{ success: boolean; models?: string[]; message?: string }>;
  checkOllamaHealth: () => Promise<{ success: boolean; exists?: boolean; message?: string }>;
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

interface PlaytimeSummary {
  game: string;
  platform: string;
  totalMinutes: number;
  totalSessions: number;
  lastPlayed: string | null;
}

interface Achievement {
  id: number;
  game: string;
  apiName: string;
  displayName: string;
  description: string;
  unlocked: boolean;
  unlockTime: string | null;
  rarity: number;
  hidden: boolean;
}

interface AchievementSummary {
  game: string;
  total: number;
  unlocked: number;
  percentage: number;
}

interface HLTBTimes {
  mainStory: number;
  mainExtra: number;
  completionist: number;
}

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

type Tab = 'dashboard' | 'mapping' | 'sync' | 'playtime' | 'achievements' | 'settings';

function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatDate(iso: string): string {
  if (!iso || iso === 'Never') return 'Never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function isValidUrl(url: string): boolean {
  if (!url.trim()) return false;
  try {
    const normalized = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    const u = new URL(normalized);
    return u.hostname.length > 0;
  } catch {
    return false;
  }
}

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
  const [searchTerm, setSearchTerm] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Playtime state
  const [playtimeSummary, setPlaytimeSummary] = useState<PlaytimeSummary[]>([]);
  const [totalPlaytime, setTotalPlaytime] = useState(0);
  const [isLoadingPlaytime, setIsLoadingPlaytime] = useState(false);

  // Achievements state
  const [achievementSummary, setAchievementSummary] = useState<AchievementSummary[]>([]);
  const [selectedAchGame, setSelectedAchGame] = useState('');
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [isLoadingAch, setIsLoadingAch] = useState(false);

  // HLTB cache
  const [hltbCache, setHltbCache] = useState<Record<string, HLTBTimes>>({});
  const [hltbLoading, setHltbLoading] = useState<Record<string, boolean>>({});

  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

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
    try {
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
    } catch (e) {
      showToast('Failed to load config', 'error');
    }
  };

  const saveSettings = async (newSettings: Partial<Settings>) => {
    const s = { ...settings, ...newSettings };
    setSettings(s);
    await window.electronAPI.saveConfig({ settings: s });
  };

  const saveCloud = async (partialCloud?: Partial<Cloud>) => {
    const c = partialCloud ? { ...cloud, ...partialCloud } : cloud;
    setCloud(c);
    await window.electronAPI.saveConfig({ cloud: c });
    return c;
  };

  const handleAddRoot = async () => {
    const res = await window.electronAPI.selectDirectory();
    if (res && res.success && res.path) {
      if (settings.scanRoots.includes(res.path)) {
        showToast('Location already added', 'info');
        return;
      }
      const roots = [...settings.scanRoots, res.path];
      saveSettings({ scanRoots: roots });
      showToast('Scan location added', 'success');
    }
  };

  const handleRemoveRoot = (r: string) => {
    saveSettings({ scanRoots: settings.scanRoots.filter(x => x !== r) });
  };

  const handleAddGame = async () => {
    if (!newGameName.trim()) {
      showToast('Game title is required', 'error');
      return;
    }
    if (!newGameWin.trim() && !newGameLin.trim()) {
      showToast('At least one save path is required', 'error');
      return;
    }
    if (games.some(g => g.name.toLowerCase() === newGameName.trim().toLowerCase())) {
      showToast('Game already tracked', 'error');
      return;
    }
    try {
      const added = await window.electronAPI.addGame({
        name: newGameName.trim(),
        winPath: newGameWin.trim(),
        linPath: newGameLin.trim(),
        lastSync: 'Never',
        status: 'Pending Upload',
        thumbnail: ''
      });
      setGames(added);
      setNewGameName(''); setNewGameWin(''); setNewGameLin('');
      showToast(`Added ${newGameName.trim()}`, 'success');
    } catch {
      showToast('Failed to add game', 'error');
    }
  };

  const handleAutoScan = async () => {
    setIsScanning(true);
    try {
      const res = await window.electronAPI.autoDetectGames(settings.scanRoots);
      setGames(res.currentGames);
      showToast(`Scan complete! Found ${res.count} game(s)`, 'success');
    } catch {
      showToast('Scanning failed', 'error');
    }
    setIsScanning(false);
  };

  const handleExport = async () => {
    try {
      const res = await window.electronAPI.exportSaves();
      if (res.success) showToast(res.message || 'Export complete', 'success');
      else if (res.message) showToast(res.message, 'error');
    } catch {
      showToast('Export failed', 'error');
    }
  };

  const handleCloudSync = async () => {
    if (isSyncing) return;
    if (!isValidUrl(cloud.url)) {
      showToast('Configure a valid Dune Server URL in Settings first', 'error');
      setActiveTab('settings');
      return;
    }
    setIsSyncing(true);
    setSyncProgress({ percent: 1, message: 'Preparing sync...', done: false, success: false });
    try {
      const res = await window.electronAPI.syncCloud(cloud);
      if (!res.success) {
        setSyncProgress({ percent: 0, message: res.message, done: true, success: false });
        setIsSyncing(false);
        setTimeout(() => setSyncProgress(null), 4000);
      } else {
        await loadConfig();
        showToast('Sync complete', 'success');
      }
    } catch {
      setSyncProgress({ percent: 0, message: 'Sync failed', done: true, success: false });
      setIsSyncing(false);
      setTimeout(() => setSyncProgress(null), 4000);
    }
  };

  const handleRestoreCloud = async () => {
    if (isSyncing) return;
    if (!isValidUrl(cloud.url)) {
      showToast('Configure a valid Dune Server URL first', 'error');
      return;
    }
    const confirmRestore = confirm("This will OVERWRITE your local saves with the ones from your Dune Server. Are you sure?");
    if (!confirmRestore) return;

    setIsSyncing(true);
    setSyncProgress({ percent: 1, message: 'Preparing to restore...', done: false, success: false });
    try {
      const res = await window.electronAPI.restoreCloud(cloud);
      if (!res.success) {
        setSyncProgress({ percent: 0, message: res.message, done: true, success: false });
        setIsSyncing(false);
        setTimeout(() => setSyncProgress(null), 4000);
      } else {
        await loadConfig();
        showToast('Restore complete', 'success');
      }
    } catch {
      setSyncProgress({ percent: 0, message: 'Restore failed', done: true, success: false });
      setIsSyncing(false);
      setTimeout(() => setSyncProgress(null), 4000);
    }
  };

  const handleTestCloud = async () => {
    if (!isValidUrl(cloud.url)) {
      showToast('Enter a valid server URL first', 'error');
      return;
    }
    try {
      const res = await window.electronAPI.testCloud(cloud);
      showToast(res.message, res.success ? 'success' : 'error');
    } catch {
      showToast('Connection test failed', 'error');
    }
  };

  const handleFetchArt = async (game: Game) => {
    try {
      const res = await window.electronAPI.fetchArt(game.id, game.name);
      if (res.success) {
        await loadConfig();
        showToast('Cover art updated', 'success');
      } else {
        showToast(res.message || 'Art fetch failed', 'error');
      }
    } catch {
      showToast('Art fetch failed', 'error');
    }
  };

  const handleSetCustomArt = async (game: Game) => {
    try {
      const res = await window.electronAPI.setCustomArt(game.id);
      if (res) {
        await loadConfig();
        showToast('Cover art updated', 'success');
      }
    } catch {
      showToast('Failed to set art', 'error');
    }
  };

  const handleRemoveGame = async (game: Game) => {
    const conf = confirm(`Remove ${game.name}?`);
    if (!conf) return;
    try {
      setGames(await window.electronAPI.removeGame(game.id));
      showToast(`Removed ${game.name}`, 'info');
    } catch {
      showToast('Failed to remove game', 'error');
    }
  };

  const loadPlaytime = async () => {
    if (!isValidUrl(cloud.url)) {
      showToast('Configure Dune Server URL first', 'error');
      return;
    }
    setIsLoadingPlaytime(true);
    try {
      const [summaryRes, totalRes] = await Promise.all([
        window.electronAPI.getPlaytimeSummary(),
        window.electronAPI.getTotalPlaytime()
      ]);
      if (summaryRes.success) setPlaytimeSummary(summaryRes.summary);
      if (totalRes.success) setTotalPlaytime(totalRes.totalMinutes);
    } catch {
      showToast('Failed to load playtime', 'error');
    }
    setIsLoadingPlaytime(false);
  };

  const loadAchievements = async () => {
    if (!isValidUrl(cloud.url)) {
      showToast('Configure Dune Server URL first', 'error');
      return;
    }
    setIsLoadingAch(true);
    try {
      const res = await window.electronAPI.getAchievementSummary();
      if (res.success) setAchievementSummary(res.summary);
      else showToast(res.message || 'Failed to load achievements', 'error');
    } catch {
      showToast('Failed to load achievements', 'error');
    }
    setIsLoadingAch(false);
  };

  const loadGameAchievements = async (gameName: string) => {
    if (!gameName) return;
    setIsLoadingAch(true);
    try {
      const res = await window.electronAPI.getAchievements(gameName);
      if (res.success) {
        setAchievements(res.achievements);
        setSelectedAchGame(gameName);
      } else {
        showToast(res.message || 'No achievements found', 'info');
      }
    } catch {
      showToast('Failed to load achievements', 'error');
    }
    setIsLoadingAch(false);
  };

  const loadHLTB = async (gameName: string) => {
    if (hltbCache[gameName] || hltbLoading[gameName]) return;
    if (!isValidUrl(cloud.url)) {
      showToast('Configure Dune Server URL first', 'error');
      return;
    }
    setHltbLoading(prev => ({ ...prev, [gameName]: true }));
    try {
      const res = await window.electronAPI.getHLTBTimes(gameName);
      if (res.success && res.times) {
        setHltbCache(prev => ({ ...prev, [gameName]: res.times! }));
      }
    } catch {
      // Silently ignore HLTB failures
    }
    setHltbLoading(prev => ({ ...prev, [gameName]: false }));
  };

  const filteredGames = games.filter(g =>
    g.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const inSyncCount = games.filter(g => g.status === 'In Sync').length;

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
        <button className={`nav-item ${activeTab === 'playtime' ? 'active' : ''}`} onClick={() => { setActiveTab('playtime'); loadPlaytime(); }}>
          Playtime
        </button>
        <button className={`nav-item ${activeTab === 'achievements' ? 'active' : ''}`} onClick={() => { setActiveTab('achievements'); loadAchievements(); }}>
          Achievements
        </button>
        <button className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
          Settings
        </button>
      </div>

      <div className="main-content">
        {activeTab === 'dashboard' && (
          <div>
            <div className="dashboard-header">
              <div>
                <h2>Dashboard</h2>
                <p className="text-muted">Overview of your local and synchronized game saves.</p>
              </div>
              <div className="search-wrapper">
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search games..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="stats-row">
              <div className="card stat-card stat-accent">
                <div className="stat-value">{games.length}</div>
                <div className="stat-label">Tracked Games</div>
              </div>
              <div className="card stat-card stat-success">
                <div className="stat-value">{inSyncCount}</div>
                <div className="stat-label">In Sync</div>
              </div>
              <div className="card stat-card stat-danger">
                <div className="stat-value">{games.length - inSyncCount}</div>
                <div className="stat-label">Pending Sync</div>
              </div>
            </div>

            <div className="games-grid">
              {filteredGames.map(game => (
                <div key={game.id} className="game-card">
                  {game.thumbnail ? (
                    <img src={game.thumbnail} className="game-cover" alt={game.name} loading="lazy" />
                  ) : (
                    <div className="game-cover-placeholder">No Cover Art</div>
                  )}
                  <div className="game-info">
                    <div className="game-title" title={game.name}>{game.name}</div>
                    <div className={`game-status ${game.status === 'In Sync' ? 'status-synced' : 'status-pending'}`}>
                      Status: {game.status} <br />
                      <span className="sync-time">Sync: {formatDate(game.lastSync)}</span>
                    </div>
                    {hltbCache[game.name] && (
                      <div className="hltb-info">
                        Main: {formatMinutes(hltbCache[game.name].mainStory)} |
                        Extra: {formatMinutes(hltbCache[game.name].mainExtra)} |
                        100%: {formatMinutes(hltbCache[game.name].completionist)}
                      </div>
                    )}
                    <div className="game-actions">
                      <button className="btn btn-secondary" onClick={() => handleFetchArt(game)}>Auto Art</button>
                      <button className="btn btn-secondary" onClick={() => handleSetCustomArt(game)}>Set Art</button>
                      <button className="btn btn-secondary" onClick={() => loadHLTB(game.name)} disabled={!!hltbCache[game.name] || !!hltbLoading[game.name]}>
                        {hltbLoading[game.name] ? '...' : hltbCache[game.name] ? 'HLTB ✓' : 'HLTB'}
                      </button>
                      <button className="btn btn-secondary btn-danger-full" onClick={() => handleRemoveGame(game)}>Remove</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {filteredGames.length === 0 && (
              <div className="empty-state">
                {searchTerm ? (
                  <p>No games match &quot;{searchTerm}&quot;. <button className="link-btn" onClick={() => setSearchTerm('')}>Clear search</button></p>
                ) : (
                  <>
                    <p>No games tracked yet.</p>
                    <button className="btn btn-primary" onClick={() => setActiveTab('mapping')}>Add games in Game Paths</button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'mapping' && (
          <div>
            <div className="section-header">
              <h2>Game Path Mapping</h2>
              <button
                className="btn btn-primary"
                disabled={isScanning}
                onClick={handleAutoScan}
              >
                {isScanning ? 'Scanning...' : 'Auto-Detect Games'}
              </button>
            </div>

            <div className="card">
              <h3 className="card-title">Add New Custom Mapping</h3>
              <div className="form-group">
                <label>Game Title *</label>
                <input type="text" value={newGameName} onChange={e => setNewGameName(e.target.value)} placeholder="e.g. Hades" />
              </div>
              <div className="form-group">
                <label>Windows Origin Path</label>
                <input type="text" value={newGameWin} onChange={e => setNewGameWin(e.target.value)} placeholder="%USERPROFILE%\Documents\Saved Games\Hades" />
              </div>
              <div className="form-group">
                <label>Linux Origin Path</label>
                <input type="text" value={newGameLin} onChange={e => setNewGameLin(e.target.value)} placeholder="~/.local/share/Hades/Saves" />
              </div>
              <button className="btn btn-primary" onClick={handleAddGame}>Save Mapping</button>
            </div>

            <div className="card">
              <h3 className="card-title">Tracked Games ({games.length})</h3>
              {games.length === 0 ? (
                <p className="text-muted">No games yet. Add one above or run auto-detect.</p>
              ) : (
                <div className="path-list">
                  {games.map(g => (
                    <div key={g.id} className="path-row">
                      <div className="path-main">
                        <strong>{g.name}</strong>
                        <div className="path-sub">{g.linPath || g.winPath || 'No path set'}</div>
                      </div>
                      <button className="btn btn-secondary btn-sm" onClick={() => handleRemoveGame(g)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'sync' && (
          <div>
            <h2>Cloud Sync &amp; Local Backup</h2>

            {syncProgress && (
              <div className={`card sync-progress-card ${syncProgress.done ? (syncProgress.success ? 'sync-done' : 'sync-error') : 'sync-active'}`}>
                <div className="sync-progress-header">
                  <div className="sync-progress-title">
                    {syncProgress.done
                      ? (syncProgress.success ? 'Sync Complete' : 'Sync Failed')
                      : 'Synchronizing with Dune Server...'}
                  </div>
                  <div className="sync-progress-percent">
                    {syncProgress.percent > 0 ? `${syncProgress.percent}%` : ''}
                  </div>
                </div>
                <div className="progress-track">
                  <div
                    className={`progress-fill ${syncProgress.done && syncProgress.success ? 'progress-done' : ''}`}
                    style={{ width: `${syncProgress.percent}%` }}
                  />
                </div>
                <div className="sync-progress-message">
                  {!syncProgress.done && <span className="progress-spinner" />}
                  {syncProgress.message}
                </div>
              </div>
            )}

            <div className="card">
              <h3 className="card-title">Manual Local Export</h3>
              <p className="text-muted card-desc">Export all mapped saves into a single .zip file.</p>
              <button className="btn btn-primary" onClick={handleExport}>Compile &amp; Export All Saves (.zip)</button>
            </div>

            <div className="card">
              <h3 className="card-title">Dune Server Synchronization &amp; Restore</h3>
              <p className="text-muted card-desc">Backup games individually to your central <strong>Dune Server</strong>.</p>

              <div className="sync-btn-row">
                <button
                  className="btn btn-primary btn-flex"
                  onClick={handleCloudSync}
                  disabled={isSyncing}
                >
                  {isSyncing ? 'Working...' : 'Push Saves to Server'}
                </button>
                <button
                  className="btn btn-secondary btn-flex btn-outline-accent"
                  onClick={handleRestoreCloud}
                  disabled={isSyncing}
                >
                  {isSyncing ? 'Working...' : 'Restore from Server'}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'playtime' && (
          <div>
            <div className="section-header">
              <h2>Playtime Tracking</h2>
              <button className="btn btn-secondary" onClick={loadPlaytime} disabled={isLoadingPlaytime}>
                {isLoadingPlaytime ? 'Loading...' : 'Refresh'}
              </button>
            </div>
            <div className="stats-row">
              <div className="card stat-card stat-accent">
                <div className="stat-value">{formatMinutes(totalPlaytime)}</div>
                <div className="stat-label">Total Playtime</div>
              </div>
              <div className="card stat-card stat-success">
                <div className="stat-value">{playtimeSummary.length}</div>
                <div className="stat-label">Games Tracked</div>
              </div>
            </div>
            <div className="card">
              {playtimeSummary.length === 0 ? (
                <p className="text-muted">No playtime data. Record sessions via the server API or playtime.sh scripts.</p>
              ) : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr><th>Game</th><th>Platform</th><th>Total</th><th>Sessions</th><th>Last Played</th></tr>
                    </thead>
                    <tbody>
                      {playtimeSummary.map((p, i) => (
                        <tr key={i}>
                          <td>{p.game}</td>
                          <td>{p.platform}</td>
                          <td>{formatMinutes(p.totalMinutes)}</td>
                          <td>{p.totalSessions}</td>
                          <td>{formatDate(p.lastPlayed || 'Never')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'achievements' && (
          <div>
            <div className="section-header">
              <h2>Achievements</h2>
              <button className="btn btn-secondary" onClick={loadAchievements} disabled={isLoadingAch}>
                {isLoadingAch ? 'Loading...' : 'Refresh'}
              </button>
            </div>
            <div className="card">
              {achievementSummary.length === 0 ? (
                <p className="text-muted">No achievement data. Connect Sentinel via webhook or import from Steam.</p>
              ) : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr><th>Game</th><th>Unlocked</th><th>Progress</th><th></th></tr>
                    </thead>
                    <tbody>
                      {achievementSummary.map((a, i) => (
                        <tr key={i} className={selectedAchGame === a.game ? 'row-active' : ''}>
                          <td>{a.game}</td>
                          <td>{a.unlocked} / {a.total}</td>
                          <td>
                            <div className="progress-track progress-sm">
                              <div className="progress-fill" style={{ width: `${a.percentage}%` }} />
                            </div>
                            <span className="text-muted">{a.percentage}%</span>
                          </td>
                          <td><button className="btn btn-secondary btn-sm" onClick={() => loadGameAchievements(a.game)}>View</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {achievements.length > 0 && (
              <div className="card">
                <h3 className="card-title">{selectedAchGame} — {achievements.filter(a => a.unlocked).length}/{achievements.length} unlocked</h3>
                <div className="ach-grid">
                  {achievements.map(a => (
                    <div key={a.id} className={`ach-card ${a.unlocked ? 'ach-unlocked' : 'ach-locked'}`}>
                      <div className="ach-name">{a.displayName}</div>
                      <div className="ach-desc">{a.description}</div>
                      {a.unlocked && a.unlockTime && <div className="ach-time">{formatDate(a.unlockTime)}</div>}
                      {a.rarity > 0 && <div className="ach-rarity">{a.rarity.toFixed(1)}% of players</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          <div>
            <h2>Application Settings</h2>

            <div className="card">
              <h3 className="card-title">General Settings</h3>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.runInBackground}
                  onChange={e => saveSettings({ runInBackground: e.target.checked })}
                  className="checkbox-input"
                />
                Run in background system tray when window is closed
              </label>

              <h4 className="section-subtitle">SteamGridDB Integration</h4>
              <p className="text-muted text-sm">
                Provide an API key from SteamGridDB to enable automatic game thumbnail fetching.
              </p>
              <input
                type="password"
                value={settings.steamGridDbKey || ''}
                onChange={e => saveSettings({ steamGridDbKey: e.target.value })}
                placeholder="Paste API Key here"
              />
            </div>

            <div className="card">
              <h3 className="card-title card-title-row">
                Custom Scan Locations
                <button className="btn btn-secondary btn-sm" onClick={handleAddRoot}>+ Add Root</button>
              </h3>
              {settings.scanRoots.length > 0 ? (
                <ul className="scan-list">
                  {settings.scanRoots.map((r, i) => (
                    <li key={i} className="scan-row">{r} <span className="remove-link" onClick={() => handleRemoveRoot(r)}>[remove]</span></li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">No custom locations added. Auto-detect will use default directories.</p>
              )}
            </div>

            <div className="card">
              <h3 className="card-title">Dune Server Integration</h3>

              <div className="form-group">
                <label>Dune Server Address (with Port)</label>
                <input
                  type="text"
                  className={!cloud.url || isValidUrl(cloud.url) ? '' : 'input-error'}
                  placeholder="e.g. http://192.168.1.100:3030"
                  value={cloud.url}
                  onChange={e => saveCloud({ url: e.target.value })}
                />
                {cloud.url && !isValidUrl(cloud.url) && (
                  <p className="error-text">Invalid URL format</p>
                )}
              </div>

              <div className="btn-row">
                <button className="btn btn-primary" onClick={handleTestCloud}>Test Server Connection</button>
              </div>

              <h4 className="section-subtitle section-divider">Auto-Sync Status</h4>
              <p className="text-sm text-muted">
                {settings.autoSyncEnabled
                  ? `Auto-sync is ACTIVE (${settings.autoSyncFreq})`
                  : 'Auto-sync is DISABLED'}
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.autoSyncEnabled}
                  onChange={e => saveSettings({ autoSyncEnabled: e.target.checked })}
                  className="checkbox-input"
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

      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            {t.type === 'success' && '✓ '}
            {t.type === 'error' && '! '}
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
