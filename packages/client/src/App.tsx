import '@fontsource/inter';
import { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';
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
  ManagedPrefix,
  EmulatorInfo,
  ServerResult,
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
import { GamePathInfo, SourceBadge } from './components/GamePathInfo';
import { buildSearchIndex, searchIndex } from './services/search';
import { createLatestGate } from './services/latest';
import { createSaveQueue } from './services/saveQueue';
import { validateApiKey, validateServerUrl } from './services/settingsValidation';
import { normalizeServerUrl } from './services/serverUrl';
import { checkGameTitle } from './services/gameTitle';
import { MAX_PREFIX_NAME, prefixFailureMessage, validateNewPrefixName } from './services/prefixes';
import { ConfirmDialog } from './components/settings/ConfirmDialog';
import { WhereItRuns } from './components/settings/WhereItRuns';
import { NoServerNotice } from './components/NoServerNotice';
import { LaunchSettings } from './components/LaunchSettings';
import { pickFailureMessage } from './services/launchSettings';
import { DriveSpaceList } from './components/saves/DriveSpaceList';
import { toDriveRows, type DriveRow } from './services/driveSpace';
import { cloudSyncFailureMessage, serverFailureMessage } from './services/serverError';
import { formatMinutes } from './services/playtimeFormat';
import { createResetTimer } from './services/resetTimer';
import { saveBackupProfile } from './services/backupProfileSave';

// ── Typed IPC bridge ─────────────────────────────────────────────────────────
// ElectronAPI, Game, Settings and Achievement are canonical in @dune/shared;
// preload.ts is the runtime truth for the bridge shape.

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

type Tab = 'dashboard' | 'mapping' | 'prefixes' | 'sync' | 'saves' | 'bigpicture' | 'hltb' | 'playtime' | 'achievements' | 'settings';

/** Plain wording for DUN-061 launch failures; the optional detail from main is appended, the code never is. */
function launchFailureMessage(name: string, reason: string, detail?: string): string {
  const base = reason === 'not-found'
    ? `${name} is no longer in your library. Refresh and try again.`
    : reason === 'not-launchable'
      ? `Dune doesn't know how to start ${name} yet. Set how it launches first.`
      : `Could not launch ${name}.`;
  return detail?.trim() ? `${base} ${detail.trim()}` : base;
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
  // Exactly the main-process rule (electron/sync/serverUrl.ts normalizeServerUrl),
  // mirrored in services/serverUrl.ts: absolute http(s) URL with a host only.
  return normalizeServerUrl(url) !== null;
}

/** Debounce for auto-saved Settings fields (DUN-045). */
const SETTINGS_SAVE_DELAY_MS = 500;

type SettingsField = 'serverUrl' | 'serverKey' | 'steamGridDbKey';

/** Snapshot of what the conflict dialog shows; resolve acts on exactly this. */
interface ConflictDialogState {
  conflict: ConflictRecord;
  gameName: string;
  local?: SaveVersion;
  remote?: SaveVersion;
}

function conflictDialogFor(conflict: ConflictRecord, gameName: string, versions: SaveVersion[]): ConflictDialogState {
  return {
    conflict,
    gameName,
    local: versions.find(v => v.id === conflict.localVersionId),
    remote: versions.find(v => v.id === conflict.remoteVersionId),
  };
}

const DEFAULT_SETTINGS: Settings = {
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
};


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

// Demo-only fixtures: never shipped to production builds. Real drive and
// file-breakdown data will come from an IPC source; until then prod shows an
// explicit "unavailable" state instead of invented numbers.
const DEMO_BACKUP_PROFILE: BackupProfile | null = import.meta.env.DEV
  ? {
      gameId: 1,
      includeGlobs: ['**/*'],
      excludeGlobs: ['**/cache/**', '**/*.log'],
      autoExcludeCache: true,
      updatedAt: new Date().toISOString(),
    }
  : null;

const DEMO_EXCLUSION_FILES = import.meta.env.DEV
  ? [
      { path: 'saves/slot1.sav', size: 6.6 * 1024 * 1024, category: 'Save' as const },
      { path: 'ShaderCache/file.bin', size: 412 * 1024 * 1024, category: 'Cache' as const },
    ]
  : [];

/** How long a finished sync/restore card stays visible. */
const SYNC_PROGRESS_HIDE_MS = 4000;

const TOAST_DURATION_MS: Record<Toast['type'], number> = { success: 4000, info: 4000, error: 8000 };

/** One toast with its own dismiss timer; the timer pauses on hover/focus. */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remainingRef = useRef(TOAST_DURATION_MS[toast.type]);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(1000, remainingRef.current - (Date.now() - startedAt));
    };
  }, [paused, toast.id, onDismiss]);

  return (
    <div
      className={`toast toast-${toast.type}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {toast.type === 'success' && <Icon name="check" size={16} />}
      {toast.type === 'error' && <Icon name="alert" size={16} />}
      {toast.type === 'info' && <Icon name="info" size={16} />}
      <span className="toast-message">{toast.message}</span>
      <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <Icon name="cancel" size={14} />
      </button>
    </div>
  );
}


export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [games, setGames] = useState<Game[]>([]);
  const [cloud, setCloud] = useState<Cloud>({ url: '' });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // Latest settings incl. not-yet-rendered changes, so two quick changes merge
  // instead of the second overwriting the first (DUN-045).
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  // Drafts for auto-saved text fields; null = show the saved value.
  const [serverUrlDraft, setServerUrlDraft] = useState<string | null>(null);
  const [serverKeyDraft, setServerKeyDraft] = useState<string | null>(null);
  const [steamGridDbKeyDraft, setSteamGridDbKeyDraft] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SettingsField, string>>>({});
  const commitTimers = useRef<Partial<Record<SettingsField, number>>>({});

  const [newGameName, setNewGameName] = useState('');
  const [newGameWin, setNewGameWin] = useState('');
  const [newGameLin, setNewGameLin] = useState('');
  const [newGameNameError, setNewGameNameError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ percent: number; message: string; done: boolean; success: boolean } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingRestore, setPendingRestore] = useState(false);
  const [pendingRemoveId, setPendingRemoveId] = useState<number | null>(null);
  // Only whether this PC has a key; the key value is never kept in renderer state.
  const [serverKeySet, setServerKeySet] = useState(false);
  const [serverConnectionVersion, setServerConnectionVersion] = useState(0);
  const [confirmClearServerKey, setConfirmClearServerKey] = useState(false);
  // DUN-042: real drive space from main (null = not read yet).
  const [driveRows, setDriveRows] = useState<DriveRow[] | null>(null);
  const [driveError, setDriveError] = useState(false);
  // DUN-061 part 2: choices for the per-game launch selectors (null = loading).
  const [launchPrefixes, setLaunchPrefixes] = useState<ManagedPrefix[] | null>(null);
  const [emulators, setEmulators] = useState<EmulatorInfo[] | null>(null);

  // Playtime state
  const [playtimeSummary, setPlaytimeSummary] = useState<PlaytimeSummary[]>([]);
  const [totalPlaytime, setTotalPlaytime] = useState(0);
  const [playtimeGraph, setPlaytimeGraph] = useState<PlaytimeGraphData | null>(null);
  const [playtimeComparison, setPlaytimeComparison] = useState<PlaytimeComparison | null>(null);
  const [isLoadingPlaytime, setIsLoadingPlaytime] = useState(false);

  // Achievements state
  const [achievementSummary, setAchievementSummary] = useState<AchievementSummary[]>([]);
  const [selectedAchGame, setSelectedAchGame] = useState('');
  const [achievementImportGame, setAchievementImportGame] = useState('');
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
  // DUN-047: bumped after a failed save so the editor remounts on the last saved profile.
  const [exclusionRevision, setExclusionRevision] = useState(0);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  // Game the save data above belongs to; anything else is not shown (DUN-046).
  const [savesGameId, setSavesGameId] = useState<number | null>(null);
  const [conflictDialog, setConflictDialog] = useState<ConflictDialogState | null>(null);
  const savesGate = useRef(createLatestGate<number>());
  // DUN-050: the one timer that hides the finished sync/restore card.
  const syncProgressTimer = useRef(createResetTimer());
  const achievementsGate = useRef(createLatestGate<string>());
  // Conflict ids already auto-opened this session; later visits show a
  // "Review conflict" banner instead of re-opening the modal.
  const autoOpenedConflictIds = useRef<Set<string>>(new Set());
  const [selectedSaveGame, setSelectedSaveGame] = useState('');

  // Launcher and prefix state
  const [launchingGameId, setLaunchingGameId] = useState<number | null>(null);
  // DUN-062: only prefixes Dune created (registry), addressed by id.
  const [prefixes, setPrefixes] = useState<ManagedPrefix[] | null>(null);
  const [prefixLoadError, setPrefixLoadError] = useState<string | null>(null);
  const [isLoadingPrefixes, setIsLoadingPrefixes] = useState(false);
  const [newPrefixName, setNewPrefixName] = useState('');
  const [newPrefixError, setNewPrefixError] = useState<string | null>(null);
  const [creatingPrefix, setCreatingPrefix] = useState(false);
  const [prefixBusyId, setPrefixBusyId] = useState<string | null>(null);
  const [prefixRowError, setPrefixRowError] = useState<{ id: string; message: string } | null>(null);
  const [prefixToDelete, setPrefixToDelete] = useState<ManagedPrefix | null>(null);
  const prefixListHeadingRef = useRef<HTMLHeadingElement>(null);

  // Keep the save screen pinned to a game that still exists without an effect
  // that would synchronously set state on every library change.
  const selectedSaveGameName = games.some(game => game.name === selectedSaveGame)
    ? selectedSaveGame
    : (games[0]?.name ?? '');
  const selectedSaveGameId = games.find(game => game.name === selectedSaveGameName)?.id ?? null;

  const achievementImportGameName = games.some(game => game.name === achievementImportGame)
    ? achievementImportGame
    : (games[0]?.name ?? '');

  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = nextId();
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const config = await window.electronAPI.loadConfig();
      if (config) {
        if (config.games) setGames(config.games);
        if (config.cloud) setCloud(config.cloud);
        if (config.settings) {
          const prev = settingsRef.current;
          const next = {
            ...prev,
            ...config.settings,
            scanRoots: config.settings.scanRoots ?? prev.scanRoots ?? []
          };
          settingsRef.current = next;
          setSettings(next);
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
      // DUN-073 will replace getServerKey with a has-key check; until then only presence is read.
      setServerKeySet(Boolean(res?.success && res.key));
    };
    initialize().catch(() => { /* key stays empty — server calls will 401 with a clear error */ });
  }, [loadConfig]);

  useEffect(() => {
    const timer = syncProgressTimer.current;
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
        timer.schedule(() => setSyncProgress(null), SYNC_PROGRESS_HIDE_MS);
      }
    });
    return () => {
      cleanup();
      timer.clear();
    };
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.onPlaytimeRecorded((data) => {
      showToast(`Recorded ${formatMinutes(data.durationMinutes)} for ${data.game}`, 'success');
    });
    return cleanup;
  }, [showToast]);

  useEffect(() => {
    const cleanup = window.electronAPI.onAchievementsImported((data) => {
      const noun = data.count === 1 ? 'achievement' : 'achievements';
      showToast(`Imported ${data.count} local ${noun} for ${data.game}`, 'success');
    });
    return cleanup;
  }, [showToast]);


  useEffect(() => {
    if (activeTab !== 'saves' || selectedSaveGameId === null || !selectedSaveGameName || !cloud.url) return;
    const gameId = selectedSaveGameId;
    const game = selectedSaveGameName;
    const gate = savesGate.current;
    // Latest wins: a slower reply for a previously selected game is dropped.
    const ticket = gate.begin(gameId);
    const loadSaves = async () => {
      const [versionsRes, storageRes, profileRes, conflictsRes] = await Promise.allSettled([
        window.electronAPI.getSaveVersions(game),
        window.electronAPI.getStorage(game),
        window.electronAPI.getBackupProfile(game),
        window.electronAPI.getConflicts(game),
      ]);
      if (!ticket.isLatest()) return;
      const ok = <T extends object>(r: PromiseSettledResult<ServerResult<T>>): ({ ok: true } & T) | null =>
        r.status === 'fulfilled' && r.value.ok ? r.value : null;
      const versions = ok(versionsRes)?.versions ?? [];
      const list = ok(conflictsRes)?.conflicts ?? [];
      setSaveVersions(versions);
      setStorageEntry(ok(storageRes)?.entry ?? null);
      setBackupProfile(ok(profileRes)?.profile ?? null);
      setConflicts(list);
      setSavesGameId(gameId);

      const unseen = list.filter((c: ConflictRecord) => !c.resolution && !autoOpenedConflictIds.current.has(c.id));
      for (const c of unseen) autoOpenedConflictIds.current.add(c.id);
      setConflictDialog(prev => {
        // A dialog opened by the sync flow for this game gets its version details.
        if (prev) {
          return prev.gameName === game && !prev.local && !prev.remote
            ? conflictDialogFor(prev.conflict, game, versions)
            : prev;
        }
        return unseen.length > 0 ? conflictDialogFor(unseen[0], game, versions) : null;
      });
    };
    loadSaves();
    return () => gate.invalidate();
  }, [activeTab, selectedSaveGameId, selectedSaveGameName, cloud.url]);


  useEffect(() => {
    const themes = loadThemes();
    const theme = themes.find((item) => item.id === themeId) ?? themes[0];
    applyTheme(theme);
    setActiveThemeId(theme.id);
  }, [themeId]);

  useEffect(() => {
    localStorage.setItem('dune:locale', locale);
  }, [locale]);

  const setFieldError = useCallback((field: SettingsField, message?: string) => {
    setFieldErrors(prev => (prev[field] === message ? prev : { ...prev, [field]: message }));
  }, []);

  // One save at a time per target; a newer value queued during a save is
  // written after it (intermediate values are skipped). Never logs values.
  const settingsQueue = useMemo(() => createSaveQueue<Settings>({
    save: (value) => window.electronAPI.saveConfig({ settings: value }),
    onSaved: () => setFieldError('steamGridDbKey', undefined),
    onError: () => {
      showToast('Failed to save settings', 'error');
      setFieldError('steamGridDbKey', 'Not saved. Check the connection and try again.');
    },
  }), [showToast, setFieldError]);

  const cloudQueue = useMemo(() => createSaveQueue<Cloud>({
    save: (value) => window.electronAPI.saveConfig({ cloud: value }),
    onSaved: (value) => {
      setCloud(value);
      setServerUrlDraft(d => (d !== null && d.trim() === value.url ? null : d));
      setFieldError('serverUrl', undefined);
    },
    onError: () => {
      showToast('Failed to save the server address', 'error');
      setFieldError('serverUrl', 'Not saved. Check the connection and try again.');
    },
  }), [showToast, setFieldError]);

  const serverKeyQueue = useMemo(() => createSaveQueue<string>({
    save: (value) => window.electronAPI.setServerKey(value).then(res => res?.success !== false),
    onSaved: (value) => {
      setServerKeySet(value !== '');
      setServerConnectionVersion(v => v + 1);
      setServerKeyDraft(d => (d !== null && d.trim() === value ? null : d));
      setFieldError('serverKey', undefined);
    },
    onError: () => {
      showToast('Failed to save server key', 'error');
      setFieldError('serverKey', 'Not saved. Check the connection and try again.');
    },
  }), [showToast, setFieldError]);

  const saveSettings = (newSettings: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...newSettings };
    settingsRef.current = next;
    setSettings(next);
    settingsQueue.enqueue(next);
  };

  useEffect(() => {
    const timers = commitTimers.current;
    return () => {
      for (const id of Object.values(timers)) window.clearTimeout(id);
    };
  }, []);

  /** Validate a draft and queue the save; invalid drafts are never written. */
  const commitField = (field: SettingsField, raw: string) => {
    window.clearTimeout(commitTimers.current[field]);
    delete commitTimers.current[field];
    const result = field === 'serverUrl' ? validateServerUrl(raw) : validateApiKey(raw);
    if (!result.ok) {
      setFieldError(field, result.error);
      return;
    }
    setFieldError(field, undefined);
    if (field === 'serverUrl') {
      if (result.value !== cloud.url) cloudQueue.enqueue({ ...cloud, url: result.value });
      else setServerUrlDraft(null);
    } else if (field === 'serverKey') {
      // An empty draft never clears the key; that needs the Clear button.
      if (result.value) serverKeyQueue.enqueue(result.value);
      else setServerKeyDraft(null);
    } else {
      setSteamGridDbKeyDraft(null);
      if (result.value !== (settingsRef.current.steamGridDbKey ?? '')) saveSettings({ steamGridDbKey: result.value });
    }
  };

  const scheduleCommit = (field: SettingsField, raw: string) => {
    window.clearTimeout(commitTimers.current[field]);
    commitTimers.current[field] = window.setTimeout(() => commitField(field, raw), SETTINGS_SAVE_DELAY_MS);
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
    const title = checkGameTitle(newGameName);
    if (!title.ok) {
      setNewGameNameError(title.error);
      document.getElementById('new-game-title')?.focus();
      return;
    }
    setNewGameNameError(null);
    if (!newGameWin.trim() && !newGameLin.trim()) {
      showToast('At least one save path is required', 'error');
      return;
    }
    if (games.some(g => g.name.toLowerCase() === title.value.toLowerCase())) {
      showToast('Game already tracked', 'error');
      return;
    }
    try {
      // Main fills in id, status and timestamps (NewGameInput).
      const res = await window.electronAPI.addGame({
        name: title.value,
        winPath: newGameWin.trim(),
        linPath: newGameLin.trim(),
      });
      if (!res.ok) {
        showToast(res.reason === 'invalid' ? 'Check the title and save folders, then try again.' : 'Failed to add game', 'error');
        return;
      }
      setGames(res.games);
      setNewGameName(''); setNewGameWin(''); setNewGameLin('');
      // Main opens its own file dialog; the renderer never sends a path.
      const picked = await window.electronAPI.pickLaunchTarget(res.game.id).catch(() => ({ ok: false as const, reason: 'error' as const }));
      if (picked.ok) {
        updateGame(picked.game);
        showToast(`Added ${res.game.name}`, 'success');
      } else {
        const problem = pickFailureMessage(picked.reason);
        showToast(problem ? `Added ${res.game.name}. ${problem}` : `Added ${res.game.name}. Choose its executable later.`, problem ? 'error' : 'info');
      }
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
    syncProgressTimer.current.clear();
    setSyncProgress({ percent: 1, message: 'Preparing sync...', done: false, success: false });
    try {
      const res = await window.electronAPI.syncCloud(cloud);
      if (!res.ok) {
        setSyncProgress({ percent: 0, message: cloudSyncFailureMessage(res, 'Sync'), done: true, success: false });
        setIsSyncing(false);
        syncProgressTimer.current.schedule(() => setSyncProgress(null), SYNC_PROGRESS_HIDE_MS);
      } else {
        const config = await loadConfig();
        const conflictRes = await window.electronAPI.getConflicts();
        const unresolved = conflictRes.ok ? (conflictRes.conflicts ?? []).filter(c => !c.resolution) : [];
        if (unresolved.length > 0) {
          const conflictGame = (config?.games ?? games).find(g => g.id === unresolved[0].gameId);
          if (conflictGame) setSelectedSaveGame(conflictGame.name);
          setActiveTab('saves');
          for (const c of unresolved) autoOpenedConflictIds.current.add(c.id);
          // Bound to the conflict's own game; versions are filled in when that
          // game's save data arrives.
          setConflictDialog(conflictDialogFor(unresolved[0], conflictGame?.name ?? '', []));
          showToast(`Sync complete — ${unresolved.length} save conflict(s) need review`, 'error');
        } else {
          showToast('Sync complete', 'success');
        }
      }
    } catch {
      setSyncProgress({ percent: 0, message: 'Sync failed', done: true, success: false });
      setIsSyncing(false);
      syncProgressTimer.current.schedule(() => setSyncProgress(null), SYNC_PROGRESS_HIDE_MS);
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
    syncProgressTimer.current.clear();
    setSyncProgress({ percent: 1, message: 'Preparing to restore...', done: false, success: false });
    try {
      const res = await window.electronAPI.restoreCloud(cloud);
      if (!res.ok) {
        setSyncProgress({ percent: 0, message: cloudSyncFailureMessage(res, 'Restore'), done: true, success: false });
        setIsSyncing(false);
        syncProgressTimer.current.schedule(() => setSyncProgress(null), SYNC_PROGRESS_HIDE_MS);
      } else {
        await loadConfig();
        showToast('Restore complete', 'success');
      }
    } catch {
      setSyncProgress({ percent: 0, message: 'Restore failed', done: true, success: false });
      setIsSyncing(false);
      syncProgressTimer.current.schedule(() => setSyncProgress(null), SYNC_PROGRESS_HIDE_MS);
    }
  };

  const handleTestCloud = async () => {
    if (!isValidUrl(cloud.url)) {
      showToast('Enter a valid server URL first', 'error');
      return;
    }
    try {
      const res = await window.electronAPI.testCloud(cloud);
      if (res.ok) showToast(res.message, 'success');
      else showToast(serverFailureMessage(res), 'error');
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
      const res = await window.electronAPI.removeGame(game.id);
      if (!res.ok) {
        showToast('Failed to remove game', 'error');
        return;
      }
      setGames(res.games);
      setPendingRemoveId(null);
      showToast(`Removed ${game.name}`, 'info');
    } catch {
      showToast('Failed to remove game', 'error');
    }
  };

  // DUN-041: without a server these views show a calm notice instead of error toasts.
  const loadPlaytime = async () => {
    if (!isValidUrl(cloud.url)) return;
    setIsLoadingPlaytime(true);
    try {
      const [summaryRes, totalRes, graphRes, comparisonRes] = await Promise.all([
        window.electronAPI.getPlaytimeSummary(),
        window.electronAPI.getTotalPlaytime(),
        window.electronAPI.getPlaytimeGraphData('month'),
        window.electronAPI.getPlaytimeComparison('month')
      ]);
      if (summaryRes.ok) setPlaytimeSummary(summaryRes.summary);
      if (totalRes.ok) setTotalPlaytime(totalRes.totalMinutes);
      if (graphRes.ok) setPlaytimeGraph(graphRes.data);
      if (comparisonRes.ok) setPlaytimeComparison(comparisonRes.comparison);
    } catch {
      showToast('Failed to load playtime', 'error');
    }
    setIsLoadingPlaytime(false);
  };


  const handleExportPlaytime = async () => {
    try {
      const res = await window.electronAPI.exportPlaytimeData('csv', 'month');
      if (!res.ok) {
        showToast(serverFailureMessage(res), 'error');
        return;
      }
      if (!res.data) {
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
    if (!isValidUrl(cloud.url)) return;
    setIsLoadingAch(true);
    try {
      const [summaryRes, recentRes] = await Promise.all([
        window.electronAPI.getAchievementSummary(),
        window.electronAPI.getRecentUnlocks(5),
      ]);
      if (summaryRes.ok) setAchievementSummary(summaryRes.summary);
      else showToast(serverFailureMessage(summaryRes), 'error');
      if (recentRes.ok) setRecentUnlocks(recentRes.unlocks);
    } catch {
      showToast('Failed to load achievements', 'error');
    }
    setIsLoadingAch(false);
  };

  const loadGameAchievements = async (gameName: string) => {
    if (!gameName) return;
    // Latest wins: rapid "View" clicks only show the last game's details.
    const ticket = achievementsGate.current.begin(gameName);
    setIsLoadingAch(true);
    try {
      const res = await window.electronAPI.getAchievementDetail(gameName);
      if (!ticket.isLatest()) return;
      if (res.ok) {
        setAchievements(res.achievements);
        setAchievementProgress(res.progress ?? null);
        setSelectedAchGame(gameName);
      } else {
        showToast(res.status === 404 ? 'No achievements found' : serverFailureMessage(res), 'info');
      }
    } catch {
      if (ticket.isLatest()) showToast('Failed to load achievements', 'error');
    } finally {
      if (ticket.isLatest()) setIsLoadingAch(false);
    }
  };

  const handleImportLocalAchievements = async () => {
    const game = games.find(item => item.name === achievementImportGameName);
    if (!game) {
      showToast('Add a game before importing achievements', 'error');
      return;
    }

    setIsLoadingAch(true);
    try {
      const res = await window.electronAPI.importLocalAchievements(game.id);
      if (!res.ok) {
        showToast(serverFailureMessage(res), 'error');
      } else if (res.count > 0) {
        showToast(`Imported ${res.count} local achievement(s)`, 'success');
        await loadAchievements();
        await loadGameAchievements(game.name);
      } else {
        showToast(res.message || 'No local achievements found', 'info');
      }
    } catch {
      showToast('Failed to import local achievements', 'error');
    }
    setIsLoadingAch(false);
  };

  const loadHLTB = async (gameName: string) => {
    if (hltbCache[gameName] || hltbLoading[gameName]) return;
    if (!isValidUrl(cloud.url)) return;
    setHltbLoading(prev => ({ ...prev, [gameName]: true }));
    try {
      const res = await window.electronAPI.getHLTBTimes(gameName);
      if (res.ok && res.times) {
        const times = res.times;
        setHltbCache(prev => ({ ...prev, [gameName]: times }));
      }
    } catch {
      // Silently ignore HLTB failures
    }
    setHltbLoading(prev => ({ ...prev, [gameName]: false }));
  };


  const loadPrefixes = async () => {
    setIsLoadingPrefixes(true);
    try {
      const list = await window.electronAPI.listPrefixes();
      setPrefixes(Array.isArray(list) ? list : []);
      setPrefixLoadError(null);
    } catch {
      setPrefixLoadError('Could not load prefixes. Try again.');
    }
    setIsLoadingPrefixes(false);
  };

  const handleCreatePrefix = async () => {
    if (creatingPrefix) return;
    const check = validateNewPrefixName(newPrefixName);
    if (!check.ok) {
      setNewPrefixError(check.error);
      return;
    }
    setNewPrefixError(null);
    setCreatingPrefix(true);
    try {
      const res = await window.electronAPI.createPrefix(check.value);
      if (res.ok) {
        setNewPrefixName('');
        showToast(`Created prefix ${res.prefix.name}`, 'success');
        await loadPrefixes();
      } else {
        setNewPrefixError(prefixFailureMessage('create', res.reason));
      }
    } catch {
      setNewPrefixError(prefixFailureMessage('create', 'error'));
    }
    setCreatingPrefix(false);
  };

  const handleDeletePrefix = async (prefix: ManagedPrefix) => {
    setPrefixToDelete(null);
    setPrefixRowError(null);
    setPrefixBusyId(prefix.id);
    try {
      const res = await window.electronAPI.deletePrefix(prefix.id);
      if (res.ok) {
        showToast(`Moved ${prefix.name} to the Trash`, 'success');
        await loadPrefixes();
        prefixListHeadingRef.current?.focus();
      } else {
        setPrefixRowError({ id: prefix.id, message: prefixFailureMessage('delete', res.reason) });
      }
    } catch {
      setPrefixRowError({ id: prefix.id, message: prefixFailureMessage('delete', 'error') });
    }
    setPrefixBusyId(null);
  };

  const handleBackupPrefix = async (prefix: ManagedPrefix) => {
    if (prefixBusyId) return;
    setPrefixRowError(null);
    setPrefixBusyId(prefix.id);
    try {
      const res = await window.electronAPI.backupPrefix(prefix.id);
      if (res.ok) showToast(`Backed up ${prefix.name} to ${res.backupPath}`, 'success');
      else setPrefixRowError({ id: prefix.id, message: prefixFailureMessage('backup', res.reason) });
    } catch {
      setPrefixRowError({ id: prefix.id, message: prefixFailureMessage('backup', 'error') });
    }
    setPrefixBusyId(null);
  };

  const updateGame = (game: Game) => setGames(prev => prev.map(g => (g.id === game.id ? game : g)));

  useEffect(() => {
    if (activeTab !== 'mapping') return;
    let live = true;
    window.electronAPI.listPrefixes()
      .then(list => { if (live) setLaunchPrefixes(Array.isArray(list) ? list : []); })
      .catch(() => { if (live) setLaunchPrefixes([]); });
    window.electronAPI.listEmulators()
      .then(list => { if (live) setEmulators(Array.isArray(list) ? list : []); })
      .catch(() => { if (live) setEmulators([]); });
    return () => { live = false; };
  }, [activeTab]);

  const hasServer = isValidUrl(cloud.url);
  const openServerSettings = () => {
    setActiveTab('settings');
    window.setTimeout(() => {
      const field = document.getElementById('server-url');
      field?.scrollIntoView({ block: 'center' });
      field?.focus();
    }, 0);
  };

  const loadDrives = useCallback(() => {
    setDriveError(false);
    setDriveRows(null);
    window.electronAPI.getDiskSpace()
      .then(drives => setDriveRows(toDriveRows(Array.isArray(drives) ? drives : [])))
      .catch(() => setDriveError(true));
  }, []);

  useEffect(() => {
    if (activeTab !== 'saves') return;
    let live = true;
    window.electronAPI.getDiskSpace()
      .then(drives => { if (live) { setDriveError(false); setDriveRows(toDriveRows(Array.isArray(drives) ? drives : [])); } })
      .catch(() => { if (live) setDriveError(true); });
    return () => { live = false; };
  }, [activeTab, games]);

  const handleLaunch = async (game: Game) => {
    if (launchingGameId !== null) return;
    setLaunchingGameId(game.id);
    try {
      // Main resolves how to launch from its own record of the game (by id).
      const res = await window.electronAPI.launchGame(game.id);
      if (res.ok) showToast(`Launched ${game.name}`, 'success');
      else showToast(launchFailureMessage(game.name, res.reason, res.message), 'error');
    } catch {
      showToast(`Failed to launch ${game.name}`, 'error');
    }
    setLaunchingGameId(null);
  };

  // Index is rebuilt only when the games list changes; queries run against the
  // deferred term so typing stays responsive on large libraries.
  const librarySearchIndex = useMemo(() => buildSearchIndex(games), [games]);
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const filteredGames = useMemo(
    () => searchIndex(librarySearchIndex, deferredSearchTerm).map(result => result.game),
    [librarySearchIndex, deferredSearchTerm],
  );
  const searchActive = deferredSearchTerm.trim().length > 0;

  // Save data is only shown for the game it was loaded for (DUN-046).
  const savesMatch = savesGameId !== null && savesGameId === selectedSaveGameId;
  const visibleSaveVersions = savesMatch ? saveVersions : [];
  const visibleStorageEntry = savesMatch ? storageEntry : null;
  const visibleBackupProfile = savesMatch ? backupProfile : null;
  // 'later' is a deferral, not a decision: keep it reviewable via the banner.
  const activeConflict = savesMatch ? (conflicts.find(c => !c.resolution || c.resolution === 'later') ?? null) : null;
  const storageEntries = visibleStorageEntry ? [visibleStorageEntry] : DEMO_STORAGE_ENTRIES;
  const exclusionProfile = visibleBackupProfile ?? DEMO_BACKUP_PROFILE;

  const inSyncCount = games.filter(g => g.status === 'In Sync').length;

  // DUN-047: never rejects. On failure the editor goes back to the last saved profile.
  const handleExclusionChange = async (profile: BackupProfile) => {
    if (!selectedSaveGameName || selectedSaveGameId === null) return;
    const gameId = selectedSaveGameId;
    const game = selectedSaveGameName;
    const outcome = await saveBackupProfile(() => window.electronAPI.setBackupProfile({ ...profile, game }));
    if (!outcome.ok) {
      if (savesGate.current.currentKey() === gameId) setExclusionRevision(r => r + 1);
      showToast(outcome.message, 'error');
      return;
    }
    if (outcome.profile && savesGate.current.currentKey() === gameId) setBackupProfile(outcome.profile);
    showToast(outcome.message, 'success');
  };

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar-title">Dune</div>
        <button className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} aria-current={activeTab === 'dashboard' ? 'page' : undefined} onClick={() => setActiveTab('dashboard')}>
          <Icon name="dashboard" />
          <span>Dashboard</span>
        </button>
        <button className={`nav-item ${activeTab === 'mapping' ? 'active' : ''}`} aria-current={activeTab === 'mapping' ? 'page' : undefined} onClick={() => setActiveTab('mapping')}>
          <Icon name="paths" />
          <span>Game Paths</span>
        </button>
        <button className={`nav-item ${activeTab === 'prefixes' ? 'active' : ''}`} aria-current={activeTab === 'prefixes' ? 'page' : undefined} onClick={() => { setActiveTab('prefixes'); loadPrefixes(); }}>
          <Icon name="folder" />
          <span>Prefixes</span>
        </button>
        <button className={`nav-item ${activeTab === 'sync' ? 'active' : ''}`} aria-current={activeTab === 'sync' ? 'page' : undefined} onClick={() => setActiveTab('sync')}>
          <Icon name="sync" />
          <span>Server Sync</span>
        </button>
        <button className={`nav-item ${activeTab === 'saves' ? 'active' : ''}`} aria-current={activeTab === 'saves' ? 'page' : undefined} onClick={() => setActiveTab('saves')}>
          <Icon name="files" />
          <span>Saves</span>
        </button>
        <button className={`nav-item ${activeTab === 'bigpicture' ? 'active' : ''}`} aria-current={activeTab === 'bigpicture' ? 'page' : undefined} onClick={() => setActiveTab('bigpicture')}>
          <Icon name="game" />
          <span>Big Picture</span>
        </button>
        <button className={`nav-item ${activeTab === 'hltb' ? 'active' : ''}`} aria-current={activeTab === 'hltb' ? 'page' : undefined} onClick={() => setActiveTab('hltb')}>
          <Icon name="hltb" />
          <span>HLTB</span>
        </button>
        <button className={`nav-item ${activeTab === 'playtime' ? 'active' : ''}`} aria-current={activeTab === 'playtime' ? 'page' : undefined} onClick={() => { setActiveTab('playtime'); loadPlaytime(); }}>
          <Icon name="playtime" />
          <span>Playtime</span>
        </button>
        <button className={`nav-item ${activeTab === 'achievements' ? 'active' : ''}`} aria-current={activeTab === 'achievements' ? 'page' : undefined} onClick={() => { setActiveTab('achievements'); loadAchievements(); }}>
          <Icon name="achievements" />
          <span>Achievements</span>
        </button>
        <button className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} aria-current={activeTab === 'settings' ? 'page' : undefined} onClick={() => setActiveTab('settings')}>
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
      </nav>

      <main className="main-content">
        {activeTab === 'dashboard' && (
          <div>
            <div className="dashboard-header">
              <div>
                <h2>Dashboard</h2>
                <p className="text-muted">Overview of your local and synchronized game saves.</p>
              </div>
              <div className="search-wrapper">
                <label htmlFor="library-search" className="sr-only">Search games</label>
                <Icon name="search" className="search-icon" />
                <input
                  id="library-search"
                  type="text"
                  className="search-input"
                  placeholder="Search games..."
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="library-search-count"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape' && searchTerm) {
                      e.preventDefault();
                      setSearchTerm('');
                    }
                  }}
                />
              </div>
            </div>
            {/* Always mounted so the polite live region announces count changes. */}
            <p id="library-search-count" className="search-count" role="status" aria-live="polite">
              {searchActive
                ? `${filteredGames.length} of ${games.length} game${games.length === 1 ? '' : 's'} match`
                : ''}
            </p>

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
                    <div className="game-title-row">
                      <div className="game-title" title={game.name}>{game.name}</div>
                      <SourceBadge game={game} />
                    </div>
                    <div className={`game-status ${game.status === 'In Sync' ? 'status-synced' : 'status-pending'}`}>
                      <span className={`status-dot ${game.status === 'In Sync' ? 'synced' : 'pending'}`} aria-hidden="true" />
                      {game.status}
                      <span className="sync-time">· {formatDate(game.lastSync)}</span>
                    </div>
                    <GamePathInfo game={game} compact />
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
                      <button className="btn btn-secondary" onClick={() => loadHLTB(game.name)} disabled={!hasServer || !!hltbCache[game.name] || !!hltbLoading[game.name]} title={hasServer ? undefined : 'Connect a Dune server to load HowLongToBeat times'}>
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
                    <p className="text-muted text-sm">Try a shorter name, a tag, or a source like &quot;steam&quot;. Press Escape to clear.</p>
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
                <input
                  id="new-game-title"
                  type="text"
                  autoComplete="off"
                  className={newGameNameError ? 'input-error' : ''}
                  aria-invalid={newGameNameError ? true : undefined}
                  aria-describedby={newGameNameError ? 'new-game-title-error' : undefined}
                  value={newGameName}
                  onChange={e => { setNewGameName(e.target.value); if (newGameNameError) setNewGameNameError(null); }}
                  placeholder="e.g. The Witcher 3: Wild Hunt"
                />
                {newGameNameError && <p id="new-game-title-error" className="error-text" role="alert">{newGameNameError}</p>}
              </div>
              <div className="form-group">
                <label htmlFor="new-game-win">Windows save folder</label>
                <input id="new-game-win" type="text" aria-describedby="save-folder-hint" value={newGameWin} onChange={e => setNewGameWin(e.target.value)} placeholder="%USERPROFILE%\Documents\Saved Games\Hades" />
              </div>
              <div className="form-group">
                <label htmlFor="new-game-lin">Linux save folder</label>
                <input id="new-game-lin" type="text" aria-describedby="save-folder-hint" value={newGameLin} onChange={e => setNewGameLin(e.target.value)} placeholder="~/.local/share/Hades/Saves" />
              </div>
              <p id="save-folder-hint" className="text-muted text-sm form-hint">
                The folder where the game writes its save files, not where it is installed. Fill in at least one.
              </p>
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
                        <div className="path-name-row">
                          <strong>{g.name}</strong>
                          <SourceBadge game={g} />
                        </div>
                        <GamePathInfo game={g} />
                        <LaunchSettings game={g} prefixes={launchPrefixes} emulators={emulators} onUpdated={updateGame} />
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
                <p className="text-muted">Wine prefixes Dune created on this device.</p>
              </div>
              <button className="btn btn-secondary" onClick={loadPrefixes} disabled={isLoadingPrefixes}>
                <Icon name="refresh" />
                {isLoadingPrefixes ? 'Loading…' : 'Refresh'}
              </button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="add" />Create Wine Prefix</h3>
              <form noValidate onSubmit={e => { e.preventDefault(); void handleCreatePrefix(); }}>
                <div className="form-group">
                  <label htmlFor="new-prefix-name">Prefix name</label>
                  <input
                    id="new-prefix-name"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={MAX_PREFIX_NAME * 2}
                    className={newPrefixError ? 'input-error' : ''}
                    aria-invalid={newPrefixError ? true : undefined}
                    aria-describedby={newPrefixError ? 'new-prefix-hint new-prefix-error' : 'new-prefix-hint'}
                    value={newPrefixName}
                    onChange={e => { setNewPrefixName(e.target.value); if (newPrefixError) setNewPrefixError(null); }}
                    placeholder="e.g. Hades"
                  />
                  <p id="new-prefix-hint" className="form-hint">Dune creates the folder in its own prefix location.</p>
                  {newPrefixError && <p id="new-prefix-error" className="error-text" role="alert">{newPrefixError}</p>}
                </div>
                <button type="submit" className="btn btn-primary" aria-disabled={creatingPrefix || undefined}>
                  <Icon name="check" />{creatingPrefix ? 'Creating…' : 'Create Prefix'}
                </button>
              </form>
            </div>

            <div className="card">
              <h3 className="card-title" ref={prefixListHeadingRef} tabIndex={-1}><Icon name="folder" />Dune prefixes</h3>
              {prefixLoadError ? (
                <div className="inline-error" role="alert">
                  <span>{prefixLoadError}</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={loadPrefixes}>Try again</button>
                </div>
              ) : !prefixes ? (
                <div className="empty-state">
                  <Icon name="folder" size={28} />
                  <p>{isLoadingPrefixes ? 'Loading prefixes…' : 'Load the prefixes Dune manages on this device.'}</p>
                  {!isLoadingPrefixes && <button className="btn btn-secondary" onClick={loadPrefixes}>Load prefixes</button>}
                </div>
              ) : prefixes.length === 0 ? (
                <p className="text-muted text-sm">No prefixes yet. Create one above.</p>
              ) : (
                <ul className="path-list prefix-list">
                  {prefixes.map(prefix => (
                    <li className="path-row" key={prefix.id}>
                      <div className="path-main">
                        <strong>{prefix.name}</strong>
                        <div className="path-sub" title={prefix.path}>{prefix.path}</div>
                        {prefixRowError?.id === prefix.id && <p className="error-text" role="alert">{prefixRowError.message}</p>}
                      </div>
                      <div className="prefix-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={`Backup ${prefix.name}`}
                          aria-disabled={prefixBusyId === prefix.id || undefined}
                          onClick={() => handleBackupPrefix(prefix)}
                        >
                          Backup
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={`Delete ${prefix.name}`}
                          aria-disabled={prefixBusyId === prefix.id || undefined}
                          onClick={() => { if (!prefixBusyId) setPrefixToDelete(prefix); }}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <ConfirmDialog
              open={prefixToDelete !== null}
              title="Delete this prefix?"
              confirmLabel="Move to Trash"
              onCancel={() => setPrefixToDelete(null)}
              onConfirm={() => { if (prefixToDelete) void handleDeletePrefix(prefixToDelete); }}
            >
              <p><strong>{prefixToDelete?.name}</strong></p>
              <p className="path-value">{prefixToDelete?.path}</p>
              <p className="muted">Moves the folder to the Trash.</p>
            </ConfirmDialog>
          </div>
        )}

        {activeTab === 'sync' && (
          <div>
            <h2 className="section-title"><Icon name="sync" size={20} />Server Sync &amp; Local Backup</h2>

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
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label="Sync progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={syncProgress.percent}
                >
                  <div
                    className={`progress-fill ${syncProgress.done && syncProgress.success ? 'progress-done' : ''}`}
                    style={{ width: `${syncProgress.percent}%` }}
                  />
                </div>
                <div className="sync-progress-message" role="status" aria-live="polite">
                  {!syncProgress.done && <span className="progress-spinner" aria-hidden="true" />}
                  {syncProgress.done && <span className="sr-only">{syncProgress.success ? 'Sync Complete' : 'Sync Failed'}: </span>}
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
        {/* Stays mounted while the modal is open so focus can return to it. */}
        {activeTab === 'saves' && activeConflict && (
          <div className="conflict-banner" role="status">
            <Icon name="warning" size={16} />
            <span className="conflict-banner-text">A save conflict for this game is waiting for your decision.</span>
            <button className="btn btn-primary btn-sm" onClick={() => setConflictDialog(conflictDialogFor(activeConflict, selectedSaveGameName, visibleSaveVersions))}>Review conflict</button>
          </div>
        )}
        {activeTab === 'saves' && (
          <div className="card">
            <h3 className="card-title">Save versions</h3>
            <SaveVersionTimeline versions={visibleSaveVersions.length ? visibleSaveVersions : DEMO_SAVE_VERSIONS} onRestore={async (id) => { const res = await window.electronAPI.restoreSaveVersion(selectedSaveGameName, id); if (res.ok) showToast(res.message || 'Restore requested', 'success'); else showToast(serverFailureMessage(res), 'error'); }} />
          </div>
        )}
        {activeTab === 'saves' && (
          <div className="card">
            <h3 className="card-title">Storage manager</h3>
            <DriveSpaceList rows={driveRows} error={driveError} onRetry={loadDrives} />
            {storageEntries.length > 0 && (
              <StorageManager drives={[]} entries={storageEntries} />
            )}
          </div>
        )}
        {activeTab === 'saves' && (
          <div className="card">
            <h3 className="card-title">Smart exclusions</h3>
            {!exclusionProfile ? (
              <p className="text-muted text-sm">No backup profile for this game yet. Exclusions appear after the first backup.</p>
            ) : (
            <ExclusionEditor key={`${selectedSaveGameName}:${exclusionProfile.gameId}:${exclusionRevision}`} profile={exclusionProfile} files={DEMO_EXCLUSION_FILES} onChange={handleExclusionChange} />
            )}
          </div>
        )}
        <ConflictModal conflict={conflictDialog?.conflict ?? null} localVersion={conflictDialog?.local} remoteVersion={conflictDialog?.remote} open={conflictDialog !== null} onClose={() => setConflictDialog(null)} onResolve={async (resolution) => {
          // Always acts on the conflict the dialog is showing, whatever game is selected now.
          const target = conflictDialog?.conflict;
          if (!target) return;
          // "Decide later" (also Escape) always dismisses; the banner keeps it reachable.
          if (resolution === 'later') setConflictDialog(null);
          try {
            const res = await window.electronAPI.resolveConflict(target.id, resolution);
            if (res.ok) {
              setConflicts((prev) => prev.map((c) => c.id === target.id ? { ...c, resolution, resolvedAt: new Date().toISOString() } : c));
              setConflictDialog(prev => (prev?.conflict.id === target.id ? null : prev));
              showToast(resolution === 'later' ? 'Conflict saved for later' : 'Conflict resolved', resolution === 'later' ? 'info' : 'success');
            } else showToast(serverFailureMessage(res), 'error');
          } catch {
            showToast('Failed to resolve conflict', 'error');
          }
        }} />
        {activeTab === 'bigpicture' && (
          <BigPicture games={games} onLaunch={handleLaunch} />
        )}
        {activeTab === 'hltb' && (
          hasServer ? (
            <HLTBView games={games} cache={hltbCache} loading={hltbLoading} onLoad={loadHLTB} />
          ) : (
            <div>
              <div className="section-header">
                <h2>HowLongToBeat</h2>
                <p className="text-muted">Estimated completion times for tracked games.</p>
              </div>
              <NoServerNotice what="load HowLongToBeat times" onOpenSettings={openServerSettings} />
            </div>
          )
        )}
        {activeTab === 'playtime' && (
          <div>
            <div className="section-header">
              <h2>Playtime Tracking</h2>
              <button className="btn btn-secondary" onClick={loadPlaytime} disabled={!hasServer || isLoadingPlaytime}>
                <Icon name="refresh" />
                {isLoadingPlaytime ? 'Loading...' : 'Refresh'}
              </button>
            </div>
            {!hasServer ? (
              <NoServerNotice what="see playtime across your devices" onOpenSettings={openServerSettings} />
            ) : (
              <>
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
              </>
            )}
          </div>
        )}

        {activeTab === 'achievements' && (
          <div>
            <div className="section-header">
              <h2>Achievements</h2>
              <button className="btn btn-secondary" onClick={loadAchievements} disabled={!hasServer || isLoadingAch}>
                <Icon name="refresh" />
                {isLoadingAch ? 'Loading...' : 'Refresh'}
              </button>
            </div>
            {!hasServer ? (
              <NoServerNotice what="see and import achievements" onOpenSettings={openServerSettings} />
            ) : (
              <>
            {games.length > 0 && (
              <div className="card">
                <h3 className="card-title"><Icon name="scan" />Local Achievement Import</h3>
                <p className="text-muted text-sm">
                  Reads achievements.ini, achievements.json, or user_stats.json from the selected game install or Wine prefix.
                </p>
                <div className="inline-form">
                  <div className="form-group">
                    <label htmlFor="ach-import-game">Game</label>
                    <select
                      id="ach-import-game"
                      value={achievementImportGameName}
                      onChange={e => setAchievementImportGame(e.target.value)}
                    >
                      {games.map(game => (
                        <option key={game.id} value={game.name}>{game.name}</option>
                      ))}
                    </select>
                  </div>
                  <button className="btn btn-primary" onClick={handleImportLocalAchievements} disabled={isLoadingAch}>
                    <Icon name="scan" />
                    {isLoadingAch ? 'Importing...' : 'Scan local files'}
                  </button>
                </div>
              </div>
            )}
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
              </>
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
              <label htmlFor="steamgriddb-key">SteamGridDB API key</label>
              <input
                id="steamgriddb-key"
                type="text"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                className="masked-input"
                aria-invalid={fieldErrors.steamGridDbKey ? true : undefined}
                aria-describedby={fieldErrors.steamGridDbKey ? 'steamgriddb-key-error' : undefined}
                value={steamGridDbKeyDraft ?? settings.steamGridDbKey ?? ''}
                onChange={e => { setSteamGridDbKeyDraft(e.target.value); scheduleCommit('steamGridDbKey', e.target.value); }}
                onBlur={e => { if (steamGridDbKeyDraft !== null) commitField('steamGridDbKey', e.target.value); }}
                placeholder="Paste API Key here"
              />
              {fieldErrors.steamGridDbKey && (
                <p id="steamgriddb-key-error" className="error-text" role="alert">{fieldErrors.steamGridDbKey}</p>
              )}
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
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className={fieldErrors.serverUrl ? 'input-error' : ''}
                  aria-invalid={fieldErrors.serverUrl ? true : undefined}
                  aria-describedby={fieldErrors.serverUrl ? 'server-url-error' : undefined}
                  placeholder="e.g. http://192.168.1.100:3030"
                  value={serverUrlDraft ?? cloud.url}
                  onChange={e => { setServerUrlDraft(e.target.value); scheduleCommit('serverUrl', e.target.value); }}
                  onBlur={e => { if (serverUrlDraft !== null) commitField('serverUrl', e.target.value); }}
                />
                {fieldErrors.serverUrl && (
                  <p id="server-url-error" className="error-text" role="alert">{fieldErrors.serverUrl}</p>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="server-api-key">Server API key on this PC</label>
                <p id="server-api-key-status" className="key-status-line" role="status" aria-live="polite">
                  Key on this PC: <span className={serverKeySet ? 'key-status key-status-set' : 'key-status'}>{serverKeySet ? 'Set' : 'Not set'}</span>
                </p>
                <div className="key-input-row">
                  <input
                    id="server-api-key"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    data-1p-ignore
                    data-lpignore="true"
                    className={`masked-input${fieldErrors.serverKey ? ' input-error' : ''}`}
                    aria-invalid={fieldErrors.serverKey ? true : undefined}
                    aria-describedby={fieldErrors.serverKey ? 'server-api-key-status server-api-key-error' : 'server-api-key-status server-api-key-hint'}
                    placeholder={serverKeySet ? 'Paste a new key to replace it' : 'Paste a key from the server (required for sync)'}
                    value={serverKeyDraft ?? ''}
                    onChange={e => { setServerKeyDraft(e.target.value); scheduleCommit('serverKey', e.target.value); }}
                    onBlur={e => { if (serverKeyDraft !== null) commitField('serverKey', e.target.value); }}
                  />
                  {serverKeySet && (
                    <button type="button" className="btn btn-secondary" onClick={() => setConfirmClearServerKey(true)}>Clear key</button>
                  )}
                </div>
                {fieldErrors.serverKey ? (
                  <p id="server-api-key-error" className="error-text" role="alert">{fieldErrors.serverKey}</p>
                ) : (
                  <p id="server-api-key-hint" className={serverKeySet ? 'form-hint' : 'error-text'}>
                    {serverKeySet
                      ? 'The saved key is never shown. Saves automatically when you stop typing.'
                      : 'No key set. The server will reject sync and settings requests.'}
                  </p>
                )}
              </div>
              <ConfirmDialog
                open={confirmClearServerKey}
                title="Clear this PC's server key?"
                confirmLabel="Clear key"
                onCancel={() => setConfirmClearServerKey(false)}
                onConfirm={() => {
                  setConfirmClearServerKey(false);
                  setServerKeyDraft(null);
                  serverKeyQueue.enqueue('');
                }}
              >
                <p className="muted">This PC stops sending a key, so the Dune server rejects its requests until you paste a new one.</p>
              </ConfirmDialog>

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

              <label htmlFor="auto-sync-freq">Sync Frequency</label>
              <select
                id="auto-sync-freq"
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

            <WhereItRuns
              serverUrl={cloud.url}
              serverKeySet={serverKeySet}
              connectionVersion={serverConnectionVersion}
              serverUrlFieldId="server-url"
              serverKeyFieldId="server-api-key"
            />

            <div className="card">
              <h3 className="card-title"><Icon name="settings" />Appearance and Language</h3>
              <label htmlFor="theme-select">Theme</label>
              <select id="theme-select" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
                {loadThemes().map((theme) => (
                  <option key={theme.id} value={theme.id}>{theme.name}</option>
                ))}
              </select>
              <label htmlFor="locale-select">{t(locale, 'settings.language')}</label>
              <select id="locale-select" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                {availableLocales.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </div>

          </div>
        )}
      </main>

      <div className="toast-container">
        {/* Live regions stay mounted so screen readers announce new toasts. */}
        <div className="toast-region" role="status" aria-live="polite">
          {toasts.filter(t => t.type !== 'error').map(t => (
            <ToastItem key={t.id} toast={t} onDismiss={dismissToast} />
          ))}
        </div>
        <div className="toast-region" role="alert">
          {toasts.filter(t => t.type === 'error').map(t => (
            <ToastItem key={t.id} toast={t} onDismiss={dismissToast} />
          ))}
        </div>
      </div>
    </div>
  );
}
