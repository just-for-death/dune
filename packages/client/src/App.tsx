import '@fontsource/inter';
import { useState, useEffect, useCallback } from 'react';
import type {
  Cloud,
  Toast,
  HLTBTimes,
  PlaytimeSummary,
  PlaytimeGraphData,
  PlaytimeComparison,
  AchievementSummary,
  Achievement,
  AchievementDetail,
  AchievementProgress,
  Game,
  Settings,
  ElectronAPI,
  SaveVersion,
  ConflictRecord,
  StorageEntry,
  BackupProfile,
  PrefixSummary,
} from '@dune/shared';
import { nextId, RARITY_TIERS } from '@dune/shared';
import { Icon } from './Icon';
import { PlaytimeCharts } from './components/PlaytimeCharts';
import { applyTheme, loadThemes, getActiveThemeId, setActiveThemeId } from './theme/manager';
import { t, availableLocales, type Locale } from './i18n';
import { SaveVersionTimeline } from './components/saves/SaveVersionTimeline';
import { ConflictModal } from './components/saves/ConflictModal';
import { StorageManager } from './components/saves/StorageManager';
import { ExclusionEditor } from './components/saves/ExclusionEditor';
import { BigPicture } from './components/BigPicture';
import { HLTBView } from './components/HLTBView';

// ── Typed IPC bridge ─────────────────────────────────────────────────────────
// ElectronAPI, Game, Settings and Achievement are canonical in @dune/shared;
// preload.ts is the runtime truth for the bridge shape.

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

type Tab = 'dashboard' | 'mapping' | 'prefixes' | 'sync' | 'saves' | 'bigpicture' | 'hltb' | 'playtime' | 'achievements' | 'settings';

function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function rarityTier(rarity: number) {
  return RARITY_TIERS.find((tier) => rarity >= tier.minPercent && rarity < tier.maxPercent)
    ?? RARITY_TIERS[RARITY_TIERS.length - 1];
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


const DEMO_SAVE_VERSIONS = import.meta.env.DEV
  ? [
      {
        id: '1',
        gameId: 1,
        createdAt: new Date().toISOString(),
        sizeBytes: 88 * 1024 * 1024,
        fileCount: 3,
        changeSummary: '+0 ~3 -0',
        status: 'complete' as const,
      },
      {
        id: '2',
        gameId: 1,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        sizeBytes: 87 * 1024 * 1024,
        fileCount: 3,
        changeSummary: '+1 ~2 -0',
        status: 'complete' as const,
      },
    ]
  : [];

const DEMO_STORAGE_ENTRIES = import.meta.env.DEV
  ? [{ gameId: 1, installBytes: 0, saveBytes: 47 * 1024 * 1024, cacheBytes: 412 * 1024 * 1024, lastPlayed: new Date().toISOString(), drive: 'D:\\' }]
  : [];

const DEMO_BACKUP_PROFILE = {
  gameId: 1,
  includeGlobs: ['**/*'],
  excludeGlobs: ['**/cache/**', '**/*.log'],
  autoExcludeCache: true,
  updatedAt: new Date().toISOString(),
};


export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [games, setGames] = useState<Game[]>([]);
  const [cloud, setCloud] = useState<Cloud>({ url: '' });
  const [settings, setSettings] = useState<Settings>({
    runInBackground: false,
    autoSyncEnabled: false,
    autoSyncFreq: 'never',
    steamGridDbKey: '',
    scanRoots: [],
    // Server-side settings from shared
    maxVersions: 10,
    steamGridApiKey: '',
    ollamaEndpoint: 'http://localhost:11434',
    ollamaModel: 'phi4-mini:latest',
    apiKeys: [],
    localSources: [],
    remoteServers: [],
  });

  const [newGameName, setNewGameName] = useState('');
  const [newGameWin, setNewGameWin] = useState('');
  const [newGameLin, setNewGameLin] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ percent: number; message: string; done: boolean; success: boolean } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingRestore, setPendingRestore] = useState(false);
  const [pendingRemoveId, setPendingRemoveId] = useState<number | null>(null);
  const [serverApiKey, setServerApiKey] = useState('');

  // Playtime state
  const [playtimeSummary, setPlaytimeSummary] = useState<PlaytimeSummary[]>([]);
  const [totalPlaytime, setTotalPlaytime] = useState(0);
  const [playtimeGraph, setPlaytimeGraph] = useState<PlaytimeGraphData | null>(null);
  const [playtimeComparison, setPlaytimeComparison] = useState<PlaytimeComparison | null>(null);
  const [isLoadingPlaytime, setIsLoadingPlaytime] = useState(false);

  // Achievements state
  const [achievementSummary, setAchievementSummary] = useState<AchievementSummary[]>([]);
  const [selectedAchGame, setSelectedAchGame] = useState('');
  const [achievements, setAchievements] = useState<AchievementDetail[]>([]);
  const [achievementProgress, setAchievementProgress] = useState<AchievementProgress | null>(null);
  const [recentUnlocks, setRecentUnlocks] = useState<Achievement[]>([]);
  const [isLoadingAch, setIsLoadingAch] = useState(false);

  // HLTB cache
  const [hltbCache, setHltbCache] = useState<Record<string, HLTBTimes>>({});
  const [hltbLoading, setHltbLoading] = useState<Record<string, boolean>>({});
  const [themeId, setThemeId] = useState(getActiveThemeId());
  const [locale, setLocale] = useState<Locale>((localStorage.getItem('dune:locale') as Locale) || 'en');

  // Save version state
  const [saveVersions, setSaveVersions] = useState<SaveVersion[]>([]);
  const [storageEntry, setStorageEntry] = useState<StorageEntry | null>(null);
  const [backupProfile, setBackupProfile] = useState<BackupProfile | null>(null);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [selectedSaveGame, setSelectedSaveGame] = useState('');

  // Launcher and prefix state
  const [launchingGameId, setLaunchingGameId] = useState<number | null>(null);
  const [prefixSummary, setPrefixSummary] = useState<PrefixSummary | null>(null);
  const [isLoadingPrefixes, setIsLoadingPrefixes] = useState(false);
  const [newPrefixPath, setNewPrefixPath] = useState('');
  const [pendingPrefixDelete, setPendingPrefixDelete] = useState<string | null>(null);

  // Keep the save screen pinned to a game that still exists without an effect
  // that would synchronously set state on every library change.
  const selectedSaveGameName = games.some(game => game.name === selectedSaveGame)
    ? selectedSaveGame
    : (games[0]?.name ?? '');

  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = nextId();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const loadConfig = useCallback(async () => {
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
      return config;
    } catch {
      showToast('Failed to load config', 'error');
      return null;
    }
  }, [showToast]);

  useEffect(() => {
    const initialize = async () => {
      await loadConfig();
      const res = await window.electronAPI.getServerKey();
      if (res?.success && res.key) setServerApiKey(res.key);
    };
    initialize().catch(() => { /* key stays empty — server calls will 401 with a clear error */ });
  }, [loadConfig]);

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

  useEffect(() => {
    const cleanup = window.electronAPI.onPlaytimeRecorded((data) => {
      showToast(`Recorded ${formatMinutes(data.durationMinutes)} for ${data.game}`, 'success');
    });
    return cleanup;
  }, [showToast]);


  useEffect(() => {
    if (activeTab !== 'saves' || !selectedSaveGameName || !cloud.url) return;
    const game = selectedSaveGameName;
    const loadSaves = async () => {
      try {
        const versions = await window.electronAPI.getSaveVersions(game);
        if (versions?.success) setSaveVersions(versions.versions ?? []);
        const storage = await window.electronAPI.getStorage(game);
        if (storage?.success) setStorageEntry(storage.entry ?? null);
        const profile = await window.electronAPI.getBackupProfile(game);
        if (profile?.success) setBackupProfile(profile.profile ?? null);
        const conflictList = await window.electronAPI.getConflicts(game);
        if (conflictList?.success) {
          setConflicts(conflictList.conflicts ?? []);
          setShowConflictModal((conflictList.conflicts ?? []).some((c: ConflictRecord) => !c.resolution));
        }
      } catch {
        // Keep the last known UI state when the server is unavailable.
      }
    };
    loadSaves();
  }, [activeTab, selectedSaveGameName, cloud.url]);


  useEffect(() => {
    const themes = loadThemes();
    const theme = themes.find((item) => item.id === themeId) ?? themes[0];
    applyTheme(theme);
    setActiveThemeId(theme.id);
  }, [themeId]);

  useEffect(() => {
    localStorage.setItem('dune:locale', locale);
  }, [locale]);

  const saveSettings = async (newSettings: Partial<Settings>) => {
    const s = { ...settings, ...newSettings };
    setSettings(s);
    await window.electronAPI.saveConfig({ settings: s });
  };

  const handleServerKeyChange = async (key: string) => {
    setServerApiKey(key);
    try {
      await window.electronAPI.setServerKey(key);
    } catch {
      showToast('Failed to save server key', 'error');
    }
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
      if ((settings.scanRoots ?? []).includes(res.path)) {
        showToast('Location already added', 'info');
        return;
      }
      const roots = [...(settings.scanRoots ?? []), res.path];
      saveSettings({ scanRoots: roots });
      showToast('Scan location added', 'success');
    }
  };

  const handleRemoveRoot = (r: string) => {
    saveSettings({ scanRoots: (settings.scanRoots ?? []).filter(x => x !== r) });
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
      const now = new Date().toISOString();
      const added = await window.electronAPI.addGame({
        name: newGameName.trim(),
        winPath: newGameWin.trim(),
        linPath: newGameLin.trim(),
        lastSync: 'Never',
        status: 'Pending Upload',
        thumbnail: '',
        createdAt: now,
        updatedAt: now
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
      const res = await window.electronAPI.autoDetectGames(settings.scanRoots ?? []);
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
        const config = await loadConfig();
        const conflictRes = await window.electronAPI.getConflicts();
        const unresolved = (conflictRes.conflicts ?? []).filter(c => !c.resolution);
        if (conflictRes.success && unresolved.length > 0) {
          setConflicts(conflictRes.conflicts ?? []);
          const conflictGame = (config?.games ?? games).find(g => g.id === unresolved[0].gameId);
          if (conflictGame) setSelectedSaveGame(conflictGame.name);
          setActiveTab('saves');
          setShowConflictModal(true);
          showToast(`Sync complete — ${unresolved.length} save conflict(s) need review`, 'error');
        } else {
          showToast('Sync complete', 'success');
        }
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
    if (!pendingRestore) {
      setPendingRestore(true);
      return;
    }
    setPendingRestore(false);

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
    try {
      setGames(await window.electronAPI.removeGame(game.id));
      setPendingRemoveId(null);
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
      const [summaryRes, totalRes, graphRes, comparisonRes] = await Promise.all([
        window.electronAPI.getPlaytimeSummary(),
        window.electronAPI.getTotalPlaytime(),
        window.electronAPI.getPlaytimeGraphData('month'),
        window.electronAPI.getPlaytimeComparison('month')
      ]);
      if (summaryRes.success) setPlaytimeSummary(summaryRes.summary);
      if (totalRes.success) setTotalPlaytime(totalRes.totalMinutes);
      if (graphRes.success) setPlaytimeGraph(graphRes.data);
      if (comparisonRes.success) setPlaytimeComparison(comparisonRes.comparison);
    } catch {
      showToast('Failed to load playtime', 'error');
    }
    setIsLoadingPlaytime(false);
  };


  const handleExportPlaytime = async () => {
    try {
      const res = await window.electronAPI.exportPlaytimeData('csv', 'month');
      if (!res.success || !res.data) {
        showToast(res.message || 'Playtime export failed', 'error');
        return;
      }
      const blob = new Blob([res.data], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'dune-playtime.csv';
      link.click();
      URL.revokeObjectURL(url);
      showToast('Playtime exported', 'success');
    } catch {
      showToast('Playtime export failed', 'error');
    }
  };

  const loadAchievements = async () => {
    if (!isValidUrl(cloud.url)) {
      showToast('Configure Dune Server URL first', 'error');
      return;
    }
    setIsLoadingAch(true);
    try {
      const [summaryRes, recentRes] = await Promise.all([
        window.electronAPI.getAchievementSummary(),
        window.electronAPI.getRecentUnlocks(5),
      ]);
      if (summaryRes.success) setAchievementSummary(summaryRes.summary);
      else showToast(summaryRes.message || 'Failed to load achievements', 'error');
      if (recentRes.success) setRecentUnlocks(recentRes.unlocks);
    } catch {
      showToast('Failed to load achievements', 'error');
    }
    setIsLoadingAch(false);
  };

  const loadGameAchievements = async (gameName: string) => {
    if (!gameName) return;
    setIsLoadingAch(true);
    try {
      const res = await window.electronAPI.getAchievementDetail(gameName);
      if (res.success) {
        setAchievements(res.achievements);
        setAchievementProgress(res.progress ?? null);
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


  const loadPrefixes = async () => {
    setIsLoadingPrefixes(true);
    try {
      const res = await window.electronAPI.listPrefixes();
      if (res.success && res.prefixes) {
        setPrefixSummary(res.prefixes);
      } else {
        showToast(res.message || 'Failed to load prefixes', 'error');
      }
    } catch {
      showToast('Failed to load prefixes', 'error');
    }
    setIsLoadingPrefixes(false);
  };

  const handleCreatePrefix = async () => {
    const prefixPath = newPrefixPath.trim();
    if (!prefixPath) {
      showToast('Prefix path is required', 'error');
      return;
    }
    try {
      const res = await window.electronAPI.createPrefix(prefixPath);
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) {
        setNewPrefixPath('');
        await loadPrefixes();
      }
    } catch {
      showToast('Failed to create prefix', 'error');
    }
  };

  const handleDeletePrefix = async (prefixPath: string) => {
    if (pendingPrefixDelete !== prefixPath) {
      setPendingPrefixDelete(prefixPath);
      return;
    }
    setPendingPrefixDelete(null);
    try {
      const res = await window.electronAPI.deletePrefix(prefixPath);
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) await loadPrefixes();
    } catch {
      showToast('Failed to delete prefix', 'error');
    }
  };

  const handleBackupPrefix = async (prefixPath: string) => {
    try {
      const res = await window.electronAPI.backupPrefix(prefixPath);
      showToast(res.backupPath ? `${res.message}: ${res.backupPath}` : res.message, res.success ? 'success' : 'error');
    } catch {
      showToast('Failed to back up prefix', 'error');
    }
  };

  const handleLaunch = async (game: Game) => {
    if (launchingGameId !== null) return;
    setLaunchingGameId(game.id);
    try {
      const options: Record<string, unknown> = {};
      if (game.steamAppId) options.appId = game.steamAppId;
      if (game.heroicId) options.heroicId = game.heroicId;
      if (game.lutrisSlug) options.lutrisSlug = game.lutrisSlug;
      if (game.winePrefix) options.winePrefix = game.winePrefix;
      if (game.protonPath) options.protonPath = game.protonPath;
      const res = await window.electronAPI.launchGame(game, options);
      showToast(res.success ? `Launched ${game.name}` : res.message, res.success ? 'success' : 'error');
    } catch {
      showToast(`Failed to launch ${game.name}`, 'error');
    }
    setLaunchingGameId(null);
  };

  const filteredGames = games.filter(g =>
    g.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const prefixGroups: { label: string; entries: PrefixSummary['wine']; canManage: boolean }[] = prefixSummary
    ? [
        { label: 'Wine', entries: prefixSummary.wine, canManage: true },
        { label: 'Proton', entries: prefixSummary.proton, canManage: false },
        { label: 'Heroic', entries: prefixSummary.heroic, canManage: false },
        { label: 'Lutris', entries: prefixSummary.lutris, canManage: false },
      ]
    : [];

  const activeConflict = conflicts.find(c => !c.resolution) ?? null;

  const inSyncCount = games.filter(g => g.status === 'In Sync').length;

  return (
    <div className="layout">
      <div className="sidebar">
        <div className="sidebar-title">Dune</div>
        <button className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
          <Icon name="dashboard" />
          <span>Dashboard</span>
        </button>
        <button className={`nav-item ${activeTab === 'mapping' ? 'active' : ''}`} onClick={() => setActiveTab('mapping')}>
          <Icon name="paths" />
          <span>Game Paths</span>
        </button>
        <button className={`nav-item ${activeTab === 'prefixes' ? 'active' : ''}`} onClick={() => { setActiveTab('prefixes'); loadPrefixes(); }}>
          <Icon name="folder" />
          <span>Prefixes</span>
        </button>
        <button className={`nav-item ${activeTab === 'sync' ? 'active' : ''}`} onClick={() => setActiveTab('sync')}>
          <Icon name="sync" />
          <span>Cloud Sync</span>
        </button>
        <button className={`nav-item ${activeTab === 'saves' ? 'active' : ''}`} onClick={() => setActiveTab('saves')}>
          <Icon name="sync" />
          <span>Saves</span>
        </button>
        <button className={`nav-item ${activeTab === 'bigpicture' ? 'active' : ''}`} onClick={() => setActiveTab('bigpicture')}>
          <Icon name="game" />
          <span>Big Picture</span>
        </button>
        <button className={`nav-item ${activeTab === 'hltb' ? 'active' : ''}`} onClick={() => setActiveTab('hltb')}>
          <Icon name="playtime" />
          <span>HLTB</span>
        </button>
        <button className={`nav-item ${activeTab === 'playtime' ? 'active' : ''}`} onClick={() => { setActiveTab('playtime'); loadPlaytime(); }}>
          <Icon name="playtime" />
          <span>Playtime</span>
        </button>
        <button className={`nav-item ${activeTab === 'achievements' ? 'active' : ''}`} onClick={() => { setActiveTab('achievements'); loadAchievements(); }}>
          <Icon name="achievements" />
          <span>Achievements</span>
        </button>
        <button className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
          <Icon name="settings" />
          <span>Settings</span>
        </button>

        <div className="sidebar-foot">
          <div className="sidebar-stat">
            <Icon name="game" size={14} />
            <span>{games.length} game{games.length === 1 ? '' : 's'}</span>
          </div>
          <div className={`sidebar-stat ${inSyncCount === games.length && games.length > 0 ? 'sidebar-stat-ok' : ''}`}>
            <Icon name={games.length > 0 && inSyncCount === games.length ? 'check' : 'warning'} size={14} />
            <span>{games.length === 0 ? 'Nothing tracked' : `${inSyncCount}/${games.length} in sync`}</span>
          </div>
        </div>
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
                <Icon name="search" className="search-icon" />
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search games..."
                  aria-label="Search games"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="stats-row">
              <div className="card stat-card stat-accent">
                <span className="stat-icon"><Icon name="game" /></span>
                <div>
                  <div className="stat-value">{games.length}</div>
                  <div className="stat-label">Tracked Games</div>
                </div>
              </div>
              <div className="card stat-card stat-success">
                <span className="stat-icon"><Icon name="check" /></span>
                <div>
                  <div className="stat-value">{inSyncCount}</div>
                  <div className="stat-label">In Sync</div>
                </div>
              </div>
              <div className="card stat-card stat-danger">
                <span className="stat-icon"><Icon name="warning" /></span>
                <div>
                  <div className="stat-value">{games.length - inSyncCount}</div>
                  <div className="stat-label">Pending Sync</div>
                </div>
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
                      <span className={`status-dot ${game.status === 'In Sync' ? 'synced' : 'pending'}`} aria-hidden="true" />
                      {game.status}
                      <span className="sync-time">· {formatDate(game.lastSync)}</span>
                    </div>
                    {hltbCache[game.name] && (
                      <div className="hltb-info">
                        Main: {formatMinutes(hltbCache[game.name].mainStory)} |
                        Extra: {formatMinutes(hltbCache[game.name].mainExtra)} |
                        100%: {formatMinutes(hltbCache[game.name].completionist)}
                      </div>
                    )}
                    <div className="game-actions">
                      <button className="btn btn-primary" onClick={() => handleLaunch(game)} disabled={launchingGameId !== null}>
                        <Icon name="play" size={14} />
                        {launchingGameId === game.id ? 'Launching...' : 'Launch'}
                      </button>
                      <button className="btn btn-secondary" onClick={() => handleFetchArt(game)}>Auto Art</button>
                      <button className="btn btn-secondary" onClick={() => handleSetCustomArt(game)}>Set Art</button>
                      <button className="btn btn-secondary" onClick={() => loadHLTB(game.name)} disabled={!!hltbCache[game.name] || !!hltbLoading[game.name]}>
                        {hltbLoading[game.name] ? '...' : hltbCache[game.name] ? 'HLTB ✓' : 'HLTB'}
                      </button>
                      <button className="btn btn-secondary btn-danger-full" onClick={() => pendingRemoveId === game.id ? handleRemoveGame(game) : setPendingRemoveId(game.id)}>
                        {pendingRemoveId === game.id ? 'Click again to confirm removal' : 'Remove'}
                      </button>
                      {pendingRemoveId === game.id && (
                        <button className="btn btn-secondary btn-danger-full" onClick={() => setPendingRemoveId(null)}>Cancel</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {filteredGames.length === 0 && (
              <div className="empty-state">
                {searchTerm ? (
                  <>
                    <Icon name="search" size={28} />
                    <p>No games match &quot;{searchTerm}&quot;.</p>
                    <button className="btn btn-secondary" onClick={() => setSearchTerm('')}>Clear search</button>
                  </>
                ) : (
                  <>
                    <Icon name="game" size={32} />
                    <p>No games tracked yet.</p>
                    <button className="btn btn-primary" onClick={() => setActiveTab('mapping')}><Icon name="add" />Add games in Game Paths</button>
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
                <Icon name="scan" />
                {isScanning ? 'Scanning...' : 'Auto-Detect Games'}
              </button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="add" />Add New Custom Mapping</h3>
              <div className="form-group">
                <label htmlFor="new-game-title">Game title</label>
                <input id="new-game-title" type="text" value={newGameName} onChange={e => setNewGameName(e.target.value)} placeholder="e.g. Hades" />
              </div>
              <div className="form-group">
                <label htmlFor="new-game-win">Windows origin path</label>
                <input id="new-game-win" type="text" value={newGameWin} onChange={e => setNewGameWin(e.target.value)} placeholder="%USERPROFILE%\Documents\Saved Games\Hades" />
              </div>
              <div className="form-group">
                <label htmlFor="new-game-lin">Linux origin path</label>
                <input id="new-game-lin" type="text" value={newGameLin} onChange={e => setNewGameLin(e.target.value)} placeholder="~/.local/share/Hades/Saves" />
              </div>
              <button className="btn btn-primary" onClick={handleAddGame}><Icon name="check" />Save Mapping</button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="game" />Tracked Games ({games.length})</h3>
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
                      <button className="btn btn-secondary btn-sm" onClick={() => handleLaunch(g)} disabled={launchingGameId !== null}>
                        <Icon name="play" size={14} />{launchingGameId === g.id ? 'Launching...' : 'Launch'}
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => pendingRemoveId === g.id ? handleRemoveGame(g) : setPendingRemoveId(g.id)}>
                        {pendingRemoveId === g.id ? 'Confirm?' : 'Remove'}
                      </button>
                      {pendingRemoveId === g.id && (
                        <button className="btn btn-secondary btn-sm" onClick={() => setPendingRemoveId(null)}>Cancel</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'prefixes' && (
          <div>
            <div className="section-header">
              <div>
                <h2>Prefix &amp; Runtime Manager</h2>
                <p className="text-muted">Wine, Proton, Heroic, and Lutris runtimes detected on this device.</p>
              </div>
              <button className="btn btn-secondary" onClick={loadPrefixes} disabled={isLoadingPrefixes}>
                <Icon name="refresh" />
                {isLoadingPrefixes ? 'Scanning...' : 'Rescan'}
              </button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="add" />Create Wine Prefix</h3>
              <div className="form-group">
                <label htmlFor="new-prefix-path">Prefix path</label>
                <input
                  id="new-prefix-path"
                  type="text"
                  value={newPrefixPath}
                  onChange={e => setNewPrefixPath(e.target.value)}
                  placeholder="~/.local/share/wineprefixes/MyGame"
                />
              </div>
              <button className="btn btn-primary" onClick={handleCreatePrefix} disabled={!newPrefixPath.trim()}>
                <Icon name="check" />Create Prefix
              </button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="folder" />Detected Runtimes</h3>
              {!prefixSummary ? (
                <div className="empty-state">
                  <Icon name="folder" size={28} />
                  <p>{isLoadingPrefixes ? 'Scanning runtimes...' : 'Run a scan to discover installed runtimes.'}</p>
                  {!isLoadingPrefixes && <button className="btn btn-secondary" onClick={loadPrefixes}>Scan now</button>}
                </div>
              ) : (
                prefixGroups.map(group => (
                  <div className="prefix-group" key={group.label}>
                    <h4 className="section-subtitle">
                      {group.label} <span className="badge">{group.entries.length}</span>
                    </h4>
                    {group.entries.length === 0 ? (
                      <p className="text-muted text-sm">No {group.label} runtimes found.</p>
                    ) : (
                      <div className="path-list">
                        {group.entries.map(entry => (
                          <div className="path-row" key={entry.path}>
                            <div className="path-main">
                              <strong>{entry.name}</strong>
                              <div className="path-sub">
                                {entry.path}
                                {entry.version ? ` · ${entry.version}` : ''}
                                {typeof entry.sizeBytes === 'number' ? ` · ${formatBytes(entry.sizeBytes)}` : ''}
                              </div>
                            </div>
                            {group.canManage && (
                              <div className="prefix-actions">
                                <button className="btn btn-secondary btn-sm" onClick={() => handleBackupPrefix(entry.path)}>Backup</button>
                                <button className="btn btn-secondary btn-sm btn-danger-full" onClick={() => handleDeletePrefix(entry.path)}>
                                  {pendingPrefixDelete === entry.path ? 'Confirm delete' : 'Delete'}
                                </button>
                                {pendingPrefixDelete === entry.path && (
                                  <button className="btn btn-secondary btn-sm" onClick={() => setPendingPrefixDelete(null)}>Cancel</button>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'sync' && (
          <div>
            <h2 className="section-title"><Icon name="sync" size={20} />Cloud Sync &amp; Local Backup</h2>

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
              <h3 className="card-title"><Icon name="export" />Manual Local Export</h3>
              <p className="text-muted card-desc">Export all mapped saves into a single .zip file.</p>
              <button className="btn btn-primary" onClick={handleExport}><Icon name="export" />Compile &amp; Export All Saves (.zip)</button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="push" />Dune Server Synchronization &amp; Restore</h3>
              <p className="text-muted card-desc">Backup games individually to your central <strong>Dune Server</strong>.</p>

              <div className="sync-btn-row">
                <button
                  className="btn btn-primary btn-flex"
                  onClick={handleCloudSync}
                  disabled={isSyncing}
                >
                  {isSyncing ? <span className="spinner-inline" /> : <Icon name="push" />}
                  {isSyncing ? 'Working...' : 'Push Saves to Server'}
                </button>
                <button
                  className="btn btn-secondary btn-flex btn-outline-accent"
                  onClick={handleRestoreCloud}
                  disabled={isSyncing}
                >
                  <Icon name="restore" />
                  {isSyncing ? 'Working...' : pendingRestore ? 'Click again to overwrite local saves' : 'Restore from Server'}
                </button>
              </div>
              {pendingRestore && !isSyncing && (
                <div className="confirm-bar" role="alert">
                  <span>Restoring overwrites local saves with the server copy.</span>
                  <button className="btn btn-secondary btn-sm" onClick={() => setPendingRestore(false)}>Cancel</button>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'saves' && (
          <div className="section-header">
            <div>
              <h2>Save Management</h2>
              <p className="text-muted">Versions, conflicts, storage, and exclusions for each tracked game.</p>
            </div>
            {games.length > 0 && (
              <div className="form-group save-game-picker">
                <label htmlFor="save-game-select">Game</label>
                <select
                  id="save-game-select"
                  value={selectedSaveGameName}
                  onChange={e => setSelectedSaveGame(e.target.value)}
                >
                  {games.map(game => (
                    <option key={game.id} value={game.name}>{game.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
        {activeTab === 'saves' && (
          <div className="card">
            <h3 className="card-title">Save versions</h3>
            <SaveVersionTimeline versions={saveVersions.length ? saveVersions : DEMO_SAVE_VERSIONS} onRestore={async (id) => { const res = await window.electronAPI.restoreSaveVersion(selectedSaveGameName, id); showToast(res?.message || 'Restore requested', res?.success ? 'success' : 'error'); }} />
          </div>
        )}
        {activeTab === 'saves' && (
          <div className="card">
            <h3 className="card-title">Storage manager</h3>
            <StorageManager drives={[{ name: storageEntry?.drive ?? 'D:\\', totalBytes: 2 * 1024 * 1024 * 1024 * 1024, freeBytes: 690 * 1024 * 1024 * 1024 }]} entries={storageEntry ? [storageEntry] : DEMO_STORAGE_ENTRIES} />
          </div>
        )}
        {activeTab === 'saves' && (
          <div className="card">
            <h3 className="card-title">Smart exclusions</h3>
            <ExclusionEditor profile={backupProfile ?? DEMO_BACKUP_PROFILE} files={[{ path: 'saves/slot1.sav', size: 6.6 * 1024 * 1024, category: 'Save' }, { path: 'ShaderCache/file.bin', size: 412 * 1024 * 1024, category: 'Cache' }]} onChange={async (profile) => { if (selectedSaveGameName) { const res = await window.electronAPI.setBackupProfile({ ...profile, game: selectedSaveGameName }); if (res?.success && res.profile) setBackupProfile(res.profile); showToast(res?.message || 'Backup profile updated', res?.success ? 'success' : 'error'); } }} />
          </div>
        )}
        <ConflictModal conflict={activeConflict} localVersion={saveVersions.find(v => v.id === activeConflict?.localVersionId)} remoteVersion={saveVersions.find(v => v.id === activeConflict?.remoteVersionId)} open={showConflictModal} onClose={() => setShowConflictModal(false)} onResolve={async (resolution) => { if (activeConflict) { const res = await window.electronAPI.resolveConflict(activeConflict.id, resolution); if (res?.success) { setConflicts((prev) => prev.map((c) => c.id === activeConflict.id ? { ...c, resolution, resolvedAt: new Date().toISOString() } : c)); setShowConflictModal(false); showToast('Conflict resolved', 'success'); } else showToast(res?.message || 'Failed to resolve conflict', 'error'); } }} />
        {activeTab === 'bigpicture' && (
          <BigPicture games={games} onLaunch={handleLaunch} />
        )}
        {activeTab === 'hltb' && (
          <HLTBView games={games} cache={hltbCache} loading={hltbLoading} onLoad={loadHLTB} />
        )}
        {activeTab === 'playtime' && (
          <div>
            <div className="section-header">
              <h2>Playtime Tracking</h2>
              <button className="btn btn-secondary" onClick={loadPlaytime} disabled={isLoadingPlaytime}>
                <Icon name="refresh" />
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
              <div className="btn-row" style={{ justifyContent: 'flex-end', marginBottom: '12px' }}>
                <button className="btn btn-secondary btn-sm" onClick={handleExportPlaytime}><Icon name="export" />Export CSV</button>
              </div>
              <PlaytimeCharts data={playtimeGraph} comparison={playtimeComparison} />
            </div>
            <div className="card">
              {playtimeSummary.length === 0 ? (
                <div className="empty-state">
                  <Icon name="playtime" size={28} />
                  <p>No playtime data yet.</p>
                  <p className="text-muted text-sm">Record sessions via the server API or playtime.sh scripts.</p>
                </div>
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
                <Icon name="refresh" />
                {isLoadingAch ? 'Loading...' : 'Refresh'}
              </button>
            </div>
            <div className="card">
              {achievementSummary.length === 0 ? (
                <div className="empty-state">
                  <Icon name="achievements" size={28} />
                  <p>No achievement data yet.</p>
                  <p className="text-muted text-sm">Connect Sentinel via webhook or import from Steam.</p>
                </div>
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
            {recentUnlocks.length > 0 && (
              <div className="card">
                <h3 className="card-title"><Icon name="sparkles" />Recent Unlocks</h3>
                <div className="path-list">
                  {recentUnlocks.map(a => {
                    const tier = rarityTier(a.rarity);
                    return (
                      <div className="path-row" key={`${a.game}-${a.id}`}>
                        <div className="path-main">
                          <strong>{a.displayName}</strong>
                          <div className="path-sub">{a.game} · {a.unlockTime ? formatDate(a.unlockTime) : 'Unlocked'}</div>
                        </div>
                        <span className="badge" style={{ color: tier.color, borderColor: tier.color }}>{tier.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {achievements.length > 0 && (
              <div className="card">
                <h3 className="card-title">
                  {selectedAchGame} — {achievementProgress?.unlocked ?? achievements.filter(a => a.unlocked).length}/{achievementProgress?.total ?? achievements.length} unlocked
                </h3>
                {achievementProgress?.rarestUnlocked && (
                  <p className="text-muted text-sm">
                    Rarest unlocked: <strong style={{ color: achievementProgress.rarestUnlocked.color }}>{achievementProgress.rarestUnlocked.label}</strong>
                  </p>
                )}
                <div className="ach-grid">
                  {achievements.map(a => {
                    const tier = rarityTier(a.rarity);
                    const secret = a.hidden && !a.unlocked;
                    return (
                      <div key={a.id} className={`ach-card ${a.unlocked ? 'ach-unlocked' : 'ach-locked'}`}>
                        <div className="ach-name">{secret ? 'Hidden achievement' : a.displayName}</div>
                        <div className="ach-desc">{secret ? 'Unlock to reveal this achievement.' : a.description}</div>
                        {a.unlocked && a.unlockTime && <div className="ach-time">{formatDate(a.unlockTime)}</div>}
                        {a.rarity > 0 && (
                          <div className="ach-rarity" style={{ color: tier.color }}>
                            {tier.label} · {a.rarity.toFixed(1)}% of players
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          <div>
            <h2 className="section-title"><Icon name="settings" size={20} />Application Settings</h2>

            <div className="card">
              <h3 className="card-title"><Icon name="settings" />General Settings</h3>
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
                <span className="card-title-label"><Icon name="paths" />Custom Scan Locations</span>
                <button className="btn btn-secondary btn-sm" onClick={handleAddRoot}><Icon name="add" size={14} />Add Root</button>
              </h3>
              {(settings.scanRoots ?? []).length > 0 ? (
                <ul className="scan-list">
                  {(settings.scanRoots ?? []).map((r, i) => (
                    <li key={i} className="scan-row">{r} <button className="link-btn-danger" onClick={() => handleRemoveRoot(r)}>remove</button></li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">No custom locations added. Auto-detect will use default directories.</p>
              )}
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="sync" />Dune Server Integration</h3>

              <div className="form-group">
                <label htmlFor="server-url">Dune server address (with port)</label>
                <input
                  id="server-url"
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

              <div className="form-group">
                <label htmlFor="server-api-key">Server API key</label>
                <input
                  id="server-api-key"
                  type="password"
                  placeholder="Paste a key from the server (required for sync)"
                  value={serverApiKey}
                  onChange={e => handleServerKeyChange(e.target.value)}
                />
                {!serverApiKey && (
                  <p className="error-text">No key set — server features will be rejected (401).</p>
                )}
              </div>

              <div className="btn-row">
                <button className="btn btn-primary" onClick={handleTestCloud}><Icon name="plug" />Test Server Connection</button>
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

            <div className="card">
              <h3 className="card-title"><Icon name="settings" />Appearance and Language</h3>
              <label>Theme</label>
              <select value={themeId} onChange={(e) => setThemeId(e.target.value)}>
                {loadThemes().map((theme) => (
                  <option key={theme.id} value={theme.id}>{theme.name}</option>
                ))}
              </select>
              <label>{t(locale, 'settings.language')}</label>
              <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                {availableLocales.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </div>

          </div>
        )}
      </div>

      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            {t.type === 'success' && <Icon name="check" size={16} />}
            {t.type === 'error' && <Icon name="alert" size={16} />}
            {t.type === 'info' && <Icon name="info" size={16} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
