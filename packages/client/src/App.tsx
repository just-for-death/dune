import '@fontsource/inter';
import { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue, type CSSProperties } from 'react';
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
  ServerFailure,
  DriveSpace,
} from '@dune/shared';
import { DEFAULT_TRACKERS_ENABLED, nextId, normalizeServerUrl, RARITY_TIERS } from '@dune/shared';
import { Icon } from './Icon';
import { PlaytimeCharts } from './components/PlaytimeCharts';
import { applyTheme, loadThemes, getActiveThemeId, setActiveThemeId } from './theme/manager';
import { availableLocales, DEFAULT_LOCALE, isLocale, LOCALE_NAMES, type MessageKey, type Translator } from './i18n';
import { formatRich, useI18n } from './i18n/context';
import { gameStatusLabel, rarityLabel } from './i18n/labels';
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
import { SAVE_FILE_LIST_REJECTED, saveFileListState, type SaveFileListState } from './services/saveFiles';
import { validateApiKey, validateServerUrl } from './services/settingsValidation';
import { checkGameTitle } from './services/gameTitle';
import { MAX_PREFIX_NAME, prefixFailureMessage, validateNewPrefixName } from './services/prefixes';
import { ConfirmDialog } from './components/settings/ConfirmDialog';
import { WhereItRuns } from './components/settings/WhereItRuns';
import { NoServerNotice } from './components/NoServerNotice';
import { PrivacyToggles } from './components/settings/PrivacyToggles';
import { artworkDisabledMessage, isArtworkDisabled } from './components/settings/privacyToggleHelpers';
import { LaunchSettings } from './components/LaunchSettings';
import { pickFailureMessage } from './services/launchSettings';
import { DriveSpaceList } from './components/saves/DriveSpaceList';
import { toDriveRows } from './services/driveSpace';
import { cloudSyncFailureMessage, serverFailureMessage } from './services/serverError';
import { formatMinutes } from './services/playtimeFormat';
import { formatDate } from './services/format';
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
function launchFailureMessage(t: Translator, name: string, reason: string, detail?: string): string {
  const base = reason === 'not-found'
    ? t('launch.notFound', { name })
    : reason === 'not-launchable'
      ? t('launch.notLaunchable', { name })
      : t('launch.failed', { name });
  return detail?.trim() ? `${base} ${detail.trim()}` : base;
}

const UNKNOWN_RARITY = RARITY_TIERS.find((tier) => tier.tier === 'unknown')!;

/** DUN-007: missing, <= 0 or NaN global rarity is 'unknown', never legendary. */
function rarityTier(rarity: number) {
  if (typeof rarity !== 'number' || !Number.isFinite(rarity) || rarity <= 0) return UNKNOWN_RARITY;
  return RARITY_TIERS.find((tier) => tier.tier !== 'unknown' && rarity >= tier.minPercent && rarity < tier.maxPercent)
    ?? UNKNOWN_RARITY;
}

/** 'unknown' uses the neutral .rarity-unknown style (muted token, AA) instead of its shared color. */
function rarityStyle(tier: { tier: string; color: string }, border = false): CSSProperties | undefined {
  if (tier.tier === 'unknown') return undefined;
  return border ? { color: tier.color, borderColor: tier.color } : { color: tier.color };
}

function isValidUrl(url: string): boolean {
  // The shared main-process rule (@dune/shared normalizeServerUrl):
  // absolute http(s) URL with a host only.
  return normalizeServerUrl(url) !== null;
}

/** Debounce for auto-saved Settings fields (DUN-045). */
const SETTINGS_SAVE_DELAY_MS = 500;

type SettingsField = 'serverUrl' | 'serverKey';

/**
 * The client-only part of Settings the renderer owns. Server-side fields
 * (SteamGridDB key status, Ollama, API keys...) are never read from config:
 * main's sanitizeSettings keeps only these, and the SteamGridDB key is
 * managed through its own write-only IPC (DUN-092).
 */
type ClientSettings = Pick<Settings, 'runInBackground' | 'autoSyncEnabled' | 'autoSyncFreq' | 'scanRoots' | 'trackersEnabled' | 'artworkEnabled'>;

function clientSettingsFrom(source: Partial<ClientSettings>, prev: ClientSettings): ClientSettings {
  return {
    runInBackground: source.runInBackground ?? prev.runInBackground,
    autoSyncEnabled: source.autoSyncEnabled ?? prev.autoSyncEnabled,
    autoSyncFreq: source.autoSyncFreq ?? prev.autoSyncFreq,
    scanRoots: source.scanRoots ?? prev.scanRoots ?? [],
    // DUN-135: opt-in privacy switches (main sanitizes them; off unless literally true).
    trackersEnabled: { ...DEFAULT_TRACKERS_ENABLED, ...prev.trackersEnabled, ...source.trackersEnabled },
    artworkEnabled: source.artworkEnabled ?? prev.artworkEnabled ?? false,
  };
}

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

const DEFAULT_SETTINGS: ClientSettings = {
  runInBackground: false,
  autoSyncEnabled: false,
  autoSyncFreq: 'never',
  scanRoots: [],
  trackersEnabled: { ...DEFAULT_TRACKERS_ENABLED },
  artworkEnabled: false,
};


/** How long a finished sync/restore card stays visible. */
const SYNC_PROGRESS_HIDE_MS = 4000;

const TOAST_DURATION_MS: Record<Toast['type'], number> = { success: 4000, info: 4000, error: 8000 };

/** One toast with its own dismiss timer; the timer pauses on hover/focus. */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
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
      <button type="button" className="toast-close" aria-label={t('toast.dismiss')} onClick={() => onDismiss(toast.id)}>
        <Icon name="cancel" size={14} />
      </button>
    </div>
  );
}


export default function App() {
  const { locale, setLocale, t, tc } = useI18n();
  // Latest translators for long-lived callbacks (save queues, IPC listeners),
  // so switching language does not rebuild them.
  const tRef = useRef({ t, tc });
  useEffect(() => {
    tRef.current = { t, tc };
  }, [t, tc]);
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [games, setGames] = useState<Game[]>([]);
  const [cloud, setCloud] = useState<Cloud>({ url: '' });
  const [settings, setSettings] = useState<ClientSettings>(DEFAULT_SETTINGS);
  // The full Settings object from the last loadConfig, used only as the base
  // that saveConfig's type requires; its server-side fields are never read.
  const storedSettingsRef = useRef<Settings | null>(null);
  // Latest settings incl. not-yet-rendered changes, so two quick changes merge
  // instead of the second overwriting the first (DUN-045).
  const settingsRef = useRef<ClientSettings>(DEFAULT_SETTINGS);
  // Drafts for auto-saved text fields; null = show the saved value.
  const [serverUrlDraft, setServerUrlDraft] = useState<string | null>(null);
  const [serverKeyDraft, setServerKeyDraft] = useState<string | null>(null);
  // DUN-092: SteamGridDB key lives on the Dune server, write-only. Only set / not set is known here.
  const [steamGridKeySet, setSteamGridKeySet] = useState<boolean | null>(null);
  const [steamGridKeyDraft, setSteamGridKeyDraft] = useState('');
  const [steamGridKeyError, setSteamGridKeyError] = useState<string | null>(null);
  const [steamGridKeyBusy, setSteamGridKeyBusy] = useState(false);
  const [confirmClearSteamGridKey, setConfirmClearSteamGridKey] = useState(false);
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
  // DUN-073: a key is stored but can't be decrypted on this PC (e.g. keyring changed).
  const [serverKeyUnreadable, setServerKeyUnreadable] = useState(false);
  const [serverConnectionVersion, setServerConnectionVersion] = useState(0);
  const [confirmClearServerKey, setConfirmClearServerKey] = useState(false);
  // DUN-042: real drive space from main (null = not read yet). Rows are built
  // at render so their wording follows the current language.
  const [drives, setDrives] = useState<DriveSpace[] | null>(null);
  const driveRows = useMemo(() => (drives ? toDriveRows(drives, t) : null), [drives, t]);
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

  // Save version state
  const [saveVersions, setSaveVersions] = useState<SaveVersion[]>([]);
  const [storageEntry, setStorageEntry] = useState<StorageEntry | null>(null);
  const [backupProfile, setBackupProfile] = useState<BackupProfile | null>(null);
  // DUN-131: the selected game's save files (local IPC, no server needed), tagged with the game they belong to.
  const [saveFileList, setSaveFileList] = useState<{ gameId: number; state: SaveFileListState } | null>(null);
  // DUN-047: bumped after a failed save so the editor remounts on the last saved profile.
  const [exclusionRevision, setExclusionRevision] = useState(0);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  // Game the save data above belongs to; anything else is not shown (DUN-046).
  const [savesGameId, setSavesGameId] = useState<number | null>(null);
  // DUN-040: the last Saves load for savesGameId could not reach the server.
  const [savesServerDown, setSavesServerDown] = useState(false);
  // DUN-018: the server answered the versions request with an error (not "unreachable").
  const [savesLoadError, setSavesLoadError] = useState<ServerFailure | null>(null);
  const [savesReloadKey, setSavesReloadKey] = useState(0);
  // DUN-018: restore asks first, then runs one at a time.
  const [restoreTarget, setRestoreTarget] = useState<{ gameId: number; game: string; version: SaveVersion } | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
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
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const config = await window.electronAPI.loadConfig();
      if (config) {
        if (config.games) setGames(config.games);
        if (config.cloud) setCloud(config.cloud);
        if (config.settings) {
          storedSettingsRef.current = config.settings;
          const next = clientSettingsFrom(config.settings, settingsRef.current);
          settingsRef.current = next;
          setSettings(next);
        }
      }
      return config;
    } catch {
      showToast(tRef.current.t('toast.configLoadFailed'), 'error');
      return null;
    }
  }, [showToast]);

  useEffect(() => {
    const initialize = async () => {
      await loadConfig();
      // DUN-073: write-only; only whether a key is stored (and readable) comes back.
      const res = await window.electronAPI.getServerKey();
      setServerKeySet(res?.set === true);
      setServerKeyUnreadable(res?.unreadable === true);
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
      showToast(tRef.current.t('toast.playtimeRecorded', { duration: formatMinutes(data.durationMinutes), game: data.game }), 'success');
    });
    return cleanup;
  }, [showToast]);

  useEffect(() => {
    const cleanup = window.electronAPI.onAchievementsImported((data) => {
      showToast(tRef.current.tc('toast.achievementsImportedFor', data.count, { game: data.game }), 'success');
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
        window.electronAPI.getSaveVersions(gameId),
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
      // DUN-040: no reply at all (or no server) means unreachable, not "no versions".
      const noReply = versionsRes.status === 'rejected'
        || (!versionsRes.value.ok && (versionsRes.value.code === 'NETWORK' || versionsRes.value.code === 'NO_SERVER'));
      setSavesServerDown(noReply);
      setSavesLoadError(!noReply && versionsRes.status === 'fulfilled' && !versionsRes.value.ok ? versionsRes.value : null);
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
  }, [activeTab, selectedSaveGameId, selectedSaveGameName, cloud.url, savesReloadKey]);

  // DUN-131: list the save files sync would see, for the exclusion editor's breakdown.
  // A reply for a game that is no longer selected (or after leaving the tab) is dropped.
  useEffect(() => {
    if (activeTab !== 'saves' || selectedSaveGameId === null) return;
    const gameId = selectedSaveGameId;
    let live = true;
    window.electronAPI.listSaveFiles(gameId).then(
      (res) => { if (live) setSaveFileList({ gameId, state: saveFileListState(res) }); },
      () => { if (live) setSaveFileList({ gameId, state: SAVE_FILE_LIST_REJECTED }); },
    );
    return () => { live = false; };
  }, [activeTab, selectedSaveGameId]);


  useEffect(() => {
    const themes = loadThemes();
    const theme = themes.find((item) => item.id === themeId) ?? themes[0];
    applyTheme(theme);
    setActiveThemeId(theme.id);
  }, [themeId]);

  const setFieldError = useCallback((field: SettingsField, message?: string) => {
    setFieldErrors(prev => (prev[field] === message ? prev : { ...prev, [field]: message }));
  }, []);

  // Reads the current language when the save fails, so the queues below are
  // not rebuilt (and pending saves not dropped) when the language changes.
  const reportSaveError = useCallback((field: SettingsField | null, toastKey: MessageKey) => {
    showToast(t(toastKey), 'error');
    if (field) setFieldError(field, t('settings.notSaved'));
  }, [t, showToast, setFieldError]);

  // One save at a time per target; a newer value queued during a save is
  // written after it (intermediate values are skipped). Never logs values.
  // Main keeps only the client-only fields (sanitizeSettings); the stored
  // object is just the base saveConfig's type asks for, merged in by
  // saveSettings. Before the first load there is nothing to save onto (null),
  // so the save is reported as failed.
  const settingsQueue = useMemo(() => createSaveQueue<Settings | null>({
    save: (value) => (value ? window.electronAPI.saveConfig({ settings: value }) : Promise.resolve(false)),
    onError: () => reportSaveError(null, 'settings.saveFailed'),
  }), [reportSaveError]);

  const cloudQueue = useMemo(() => createSaveQueue<Cloud>({
    save: (value) => window.electronAPI.saveConfig({ cloud: value }),
    onSaved: (value) => {
      setCloud(value);
      setServerUrlDraft(d => (d !== null && d.trim() === value.url ? null : d));
      setFieldError('serverUrl', undefined);
    },
    onError: () => reportSaveError('serverUrl', 'settings.serverUrlSaveFailed'),
  }), [setFieldError, reportSaveError]);

  const serverKeyQueue = useMemo(() => createSaveQueue<string>({
    save: (value) => window.electronAPI.setServerKey(value).then(res => {
      setServerKeySet(res?.set === true);
      setServerKeyUnreadable(res?.unreadable === true);
      return true;
    }),
    onSaved: (value) => {
      setServerConnectionVersion(v => v + 1);
      setServerKeyDraft(d => (d !== null && d.trim() === value ? null : d));
      setFieldError('serverKey', undefined);
    },
    onError: () => reportSaveError('serverKey', 'settings.serverKeySaveFailed'),
  }), [setFieldError, reportSaveError]);

  const saveSettings = (newSettings: Partial<ClientSettings>) => {
    const next = { ...settingsRef.current, ...newSettings };
    settingsRef.current = next;
    setSettings(next);
    const base = storedSettingsRef.current;
    settingsQueue.enqueue(base ? { ...base, ...next } : null);
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
    const result = field === 'serverUrl' ? validateServerUrl(raw, t) : validateApiKey(raw, t);
    if (!result.ok) {
      setFieldError(field, result.error);
      return;
    }
    setFieldError(field, undefined);
    if (field === 'serverUrl') {
      if (result.value !== cloud.url) cloudQueue.enqueue({ ...cloud, url: result.value });
      else setServerUrlDraft(null);
    } else {
      // An empty draft never clears the key; that needs the Clear button.
      if (result.value) serverKeyQueue.enqueue(result.value);
      else setServerKeyDraft(null);
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
        showToast(t('settings.locationExists'), 'info');
        return;
      }
      const roots = [...(settings.scanRoots ?? []), res.path];
      saveSettings({ scanRoots: roots });
      showToast(t('settings.locationAdded'), 'success');
    }
  };

  const handleRemoveRoot = (r: string) => {
    saveSettings({ scanRoots: (settings.scanRoots ?? []).filter(x => x !== r) });
  };

  const handleAddGame = async () => {
    const title = checkGameTitle(newGameName, t);
    if (!title.ok) {
      setNewGameNameError(title.error);
      document.getElementById('new-game-title')?.focus();
      return;
    }
    setNewGameNameError(null);
    if (!newGameWin.trim() && !newGameLin.trim()) {
      showToast(t('mapping.needSavePath'), 'error');
      return;
    }
    if (games.some(g => g.name.toLowerCase() === title.value.toLowerCase())) {
      showToast(t('mapping.alreadyTracked'), 'error');
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
        showToast(res.reason === 'invalid' ? t('mapping.addInvalid') : t('mapping.addFailed'), 'error');
        return;
      }
      setGames(res.games);
      setNewGameName(''); setNewGameWin(''); setNewGameLin('');
      // Main opens its own file dialog; the renderer never sends a path.
      const picked = await window.electronAPI.pickLaunchTarget(res.game.id).catch(() => ({ ok: false as const, reason: 'error' as const }));
      if (picked.ok) {
        updateGame(picked.game);
        showToast(t('mapping.added', { name: res.game.name }), 'success');
      } else {
        const problem = pickFailureMessage(picked.reason, t);
        showToast(problem ? t('mapping.addedWithProblem', { name: res.game.name, problem }) : t('mapping.addedPickLater', { name: res.game.name }), problem ? 'error' : 'info');
      }
    } catch {
      showToast(t('mapping.addFailed'), 'error');
    }
  };

  const handleAutoScan = async () => {
    setIsScanning(true);
    try {
      const res = await window.electronAPI.autoDetectGames(settings.scanRoots ?? []);
      setGames(res.currentGames);
      showToast(t('mapping.scanComplete', { count: res.count }), 'success');
    } catch {
      showToast(t('mapping.scanFailed'), 'error');
    }
    setIsScanning(false);
  };

  const handleExport = async () => {
    try {
      const res = await window.electronAPI.exportSaves();
      if (res.success) showToast(res.message || t('sync.exportComplete'), 'success');
      else if (res.message) showToast(res.message, 'error');
    } catch {
      showToast(t('sync.exportFailed'), 'error');
    }
  };

  const handleCloudSync = async () => {
    if (isSyncing) return;
    if (!isValidUrl(cloud.url)) {
      showToast(t('sync.needUrlSettings'), 'error');
      setActiveTab('settings');
      return;
    }
    setIsSyncing(true);
    syncProgressTimer.current.clear();
    setSyncProgress({ percent: 1, message: t('sync.preparing'), done: false, success: false });
    try {
      const res = await window.electronAPI.syncCloud(cloud);
      if (!res.ok) {
        setSyncProgress({ percent: 0, message: cloudSyncFailureMessage(res, 'sync', t, tc), done: true, success: false });
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
          showToast(t('sync.conflictsNeedReview', { count: unresolved.length }), 'error');
        } else {
          showToast(t('sync.complete'), 'success');
        }
      }
    } catch {
      setSyncProgress({ percent: 0, message: t('sync.failed'), done: true, success: false });
      setIsSyncing(false);
      syncProgressTimer.current.schedule(() => setSyncProgress(null), SYNC_PROGRESS_HIDE_MS);
    }
  };

  // DUN-018: runs only after the confirm dialog; one restore at a time.
  const runVersionRestore = async () => {
    const target = restoreTarget;
    setRestoreTarget(null);
    if (!target || restoringVersionId !== null) return;
    setRestoringVersionId(target.version.id);
    try {
      const res = await window.electronAPI.restoreSaveVersion(target.gameId, target.version.id);
      if (res.ok) showToast(res.message || t('saves.restoreRequested'), 'success');
      else showToast(serverFailureMessage(res, t), 'error');
    } catch {
      showToast(t('restore.failed'), 'error');
    } finally {
      setRestoringVersionId(null);
    }
  };

  const handleRestoreCloud = async () => {
    if (isSyncing) return;
    if (!isValidUrl(cloud.url)) {
      showToast(t('restore.needUrl'), 'error');
      return;
    }
    if (!pendingRestore) {
      setPendingRestore(true);
      return;
    }
    setPendingRestore(false);

    setIsSyncing(true);
    syncProgressTimer.current.clear();
    setSyncProgress({ percent: 1, message: t('restore.preparing'), done: false, success: false });
    try {
      const res = await window.electronAPI.restoreCloud(cloud);
      if (!res.ok) {
        setSyncProgress({ percent: 0, message: cloudSyncFailureMessage(res, 'restore', t, tc), done: true, success: false });
        setIsSyncing(false);
        syncProgressTimer.current.schedule(() => setSyncProgress(null), SYNC_PROGRESS_HIDE_MS);
      } else {
        await loadConfig();
        showToast(t('restore.complete'), 'success');
      }
    } catch {
      setSyncProgress({ percent: 0, message: t('restore.failed'), done: true, success: false });
      setIsSyncing(false);
      syncProgressTimer.current.schedule(() => setSyncProgress(null), SYNC_PROGRESS_HIDE_MS);
    }
  };

  const handleTestCloud = async () => {
    if (!isValidUrl(cloud.url)) {
      showToast(t('settings.needValidUrl'), 'error');
      return;
    }
    try {
      const res = await window.electronAPI.testCloud(cloud);
      if (res.ok) showToast(res.message, 'success');
      else showToast(serverFailureMessage(res, t), 'error');
    } catch {
      showToast(t('settings.testFailed'), 'error');
    }
  };

  const applySteamGridKeyResult = (res: ServerResult<{ set: boolean }>): boolean => {
    if (res.ok) {
      setSteamGridKeySet(res.set);
      setSteamGridKeyError(null);
      return true;
    }
    setSteamGridKeyError(serverFailureMessage(res, t));
    return false;
  };

  const handleSaveSteamGridKey = async () => {
    if (steamGridKeyBusy) return;
    const check = validateApiKey(steamGridKeyDraft, t);
    if (!check.ok) { setSteamGridKeyError(check.error); return; }
    if (!check.value) { setSteamGridKeyError(t('settings.steamGridKeyEmpty')); return; }
    setSteamGridKeyBusy(true);
    try {
      if (applySteamGridKeyResult(await window.electronAPI.setSteamGridKey(check.value))) {
        setSteamGridKeyDraft('');
        showToast(t('settings.steamGridKeySaved'), 'success');
      }
    } catch {
      setSteamGridKeyError(t('settings.steamGridKeySaveFailed'));
    }
    setSteamGridKeyBusy(false);
  };

  const handleClearSteamGridKey = async () => {
    setConfirmClearSteamGridKey(false);
    setSteamGridKeyBusy(true);
    try {
      if (applySteamGridKeyResult(await window.electronAPI.clearSteamGridKey())) showToast(t('settings.steamGridKeyCleared'), 'info');
    } catch {
      setSteamGridKeyError(t('settings.steamGridKeySaveFailed'));
    }
    setSteamGridKeyBusy(false);
  };

  const handleFetchArt = async (game: Game) => {
    try {
      // DUN-092: the server's SteamGridDB provider finds the art; main saves it locally.
      const res = await window.electronAPI.fetchArt(game.id);
      if (res.ok) {
        await loadConfig();
        showToast(t('art.updated'), 'success');
      } else if (isArtworkDisabled(res)) {
        // DUN-135: artwork is opt-in; say where to turn it on, as info rather than an error.
        showToast(artworkDisabledMessage(t), 'info');
      } else {
        showToast(serverFailureMessage(res, t), 'error');
      }
    } catch {
      showToast(t('art.fetchFailed'), 'error');
    }
  };

  const handleSetCustomArt = async (game: Game) => {
    try {
      const res = await window.electronAPI.setCustomArt(game.id);
      if (res) {
        await loadConfig();
        showToast(t('art.updated'), 'success');
      }
    } catch {
      showToast(t('art.setFailed'), 'error');
    }
  };

  const handleRemoveGame = async (game: Game) => {
    try {
      const res = await window.electronAPI.removeGame(game.id);
      if (!res.ok) {
        showToast(t('games.removeFailed'), 'error');
        return;
      }
      setGames(res.games);
      setPendingRemoveId(null);
      showToast(t('games.removed', { name: game.name }), 'info');
    } catch {
      showToast(t('games.removeFailed'), 'error');
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
      showToast(t('playtime.loadFailed'), 'error');
    }
    setIsLoadingPlaytime(false);
  };


  const handleExportPlaytime = async () => {
    try {
      const res = await window.electronAPI.exportPlaytimeData('csv', 'month');
      if (!res.ok) {
        showToast(serverFailureMessage(res, t), 'error');
        return;
      }
      if (!res.data) {
        showToast(res.message || t('playtime.exportFailed'), 'error');
        return;
      }
      const blob = new Blob([res.data], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'dune-playtime.csv';
      link.click();
      URL.revokeObjectURL(url);
      showToast(t('playtime.exported'), 'success');
    } catch {
      showToast(t('playtime.exportFailed'), 'error');
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
      else showToast(serverFailureMessage(summaryRes, t), 'error');
      if (recentRes.ok) setRecentUnlocks(recentRes.unlocks);
    } catch {
      showToast(t('achievements.loadFailed'), 'error');
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
        showToast(res.status === 404 ? t('achievements.noneFound') : serverFailureMessage(res, t), 'info');
      }
    } catch {
      if (ticket.isLatest()) showToast(t('achievements.loadFailed'), 'error');
    } finally {
      if (ticket.isLatest()) setIsLoadingAch(false);
    }
  };

  const handleImportLocalAchievements = async () => {
    const game = games.find(item => item.name === achievementImportGameName);
    if (!game) {
      showToast(t('achievements.needGame'), 'error');
      return;
    }

    setIsLoadingAch(true);
    try {
      const res = await window.electronAPI.importLocalAchievements(game.id);
      if (!res.ok) {
        showToast(serverFailureMessage(res, t), 'error');
      } else if (res.count > 0) {
        showToast(t('achievements.imported', { count: res.count }), 'success');
        await loadAchievements();
        await loadGameAchievements(game.name);
      } else {
        showToast(res.message || t('achievements.noLocal'), 'info');
      }
    } catch {
      showToast(t('achievements.importFailed'), 'error');
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
      setPrefixLoadError(t('prefixes.loadFailed'));
    }
    setIsLoadingPrefixes(false);
  };

  const handleCreatePrefix = async () => {
    if (creatingPrefix) return;
    const check = validateNewPrefixName(newPrefixName, t);
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
        showToast(t('prefixes.created', { name: res.prefix.name }), 'success');
        await loadPrefixes();
      } else {
        setNewPrefixError(prefixFailureMessage('create', res.reason, t));
      }
    } catch {
      setNewPrefixError(prefixFailureMessage('create', 'error', t));
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
        showToast(t('prefixes.trashed', { name: prefix.name }), 'success');
        await loadPrefixes();
        prefixListHeadingRef.current?.focus();
      } else {
        setPrefixRowError({ id: prefix.id, message: prefixFailureMessage('delete', res.reason, t) });
      }
    } catch {
      setPrefixRowError({ id: prefix.id, message: prefixFailureMessage('delete', 'error', t) });
    }
    setPrefixBusyId(null);
  };

  const handleBackupPrefix = async (prefix: ManagedPrefix) => {
    if (prefixBusyId) return;
    setPrefixRowError(null);
    setPrefixBusyId(prefix.id);
    try {
      const res = await window.electronAPI.backupPrefix(prefix.id);
      if (res.ok) showToast(t('prefixes.backedUp', { name: prefix.name, path: res.backupPath }), 'success');
      else setPrefixRowError({ id: prefix.id, message: prefixFailureMessage('backup', res.reason, t) });
    } catch {
      setPrefixRowError({ id: prefix.id, message: prefixFailureMessage('backup', 'error', t) });
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

  useEffect(() => {
    if (activeTab !== 'settings' || !hasServer) return;
    let live = true;
    window.electronAPI.getSteamGridKeyStatus()
      .then(res => {
        if (!live) return;
        if (res.ok) { setSteamGridKeySet(res.set); setSteamGridKeyError(null); }
        else { setSteamGridKeySet(null); setSteamGridKeyError(serverFailureMessage(res, tRef.current.t)); }
      })
      .catch(() => { if (live) setSteamGridKeySet(null); });
    return () => { live = false; };
  }, [activeTab, hasServer, serverConnectionVersion]);
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
    setDrives(null);
    window.electronAPI.getDiskSpace()
      .then(list => setDrives(Array.isArray(list) ? list : []))
      .catch(() => setDriveError(true));
  }, []);

  useEffect(() => {
    if (activeTab !== 'saves') return;
    let live = true;
    window.electronAPI.getDiskSpace()
      .then(list => { if (live) { setDriveError(false); setDrives(Array.isArray(list) ? list : []); } })
      .catch(() => { if (live) setDriveError(true); });
    return () => { live = false; };
  }, [activeTab, games]);

  const handleLaunch = async (game: Game) => {
    if (launchingGameId !== null) return;
    setLaunchingGameId(game.id);
    try {
      // Main resolves how to launch from its own record of the game (by id).
      const res = await window.electronAPI.launchGame(game.id);
      if (res.ok) showToast(t('games.launched', { name: game.name }), 'success');
      else showToast(launchFailureMessage(t, game.name, res.reason, res.message), 'error');
    } catch {
      showToast(t('games.launchFailed', { name: game.name }), 'error');
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
  const storageEntries = visibleStorageEntry ? [visibleStorageEntry] : [];
  const exclusionProfile = visibleBackupProfile;
  // DUN-040: server-backed Saves cards are replaced by a notice, never by sample data.
  const savesServerState: 'none' | 'unreachable' | 'ok' = !hasServer ? 'none' : savesMatch && savesServerDown ? 'unreachable' : 'ok';
  const saveFilesState: SaveFileListState = saveFileList && saveFileList.gameId === selectedSaveGameId ? saveFileList.state : { status: 'loading' };

  const inSyncCount = games.filter(g => g.status === 'In Sync').length;
  // DUN-044: be upfront that other languages still show some English: server
  // and main-process messages are passed through as sent, and catalog gaps
  // fall back to English.
  const localeIncomplete = locale !== DEFAULT_LOCALE;

  // DUN-047: never rejects. On failure the editor goes back to the last saved profile.
  const handleExclusionChange = async (profile: BackupProfile) => {
    if (!selectedSaveGameName || selectedSaveGameId === null) return;
    const gameId = selectedSaveGameId;
    const game = selectedSaveGameName;
    const outcome = await saveBackupProfile(() => window.electronAPI.setBackupProfile({ ...profile, game }), t);
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
      <nav className="sidebar" aria-label={t('nav.label')}>
        <div className="sidebar-title">Dune</div>
        <button className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} aria-current={activeTab === 'dashboard' ? 'page' : undefined} onClick={() => setActiveTab('dashboard')}>
          <Icon name="dashboard" />
          <span>{t('nav.dashboard')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'mapping' ? 'active' : ''}`} aria-current={activeTab === 'mapping' ? 'page' : undefined} onClick={() => setActiveTab('mapping')}>
          <Icon name="paths" />
          <span>{t('nav.mapping')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'prefixes' ? 'active' : ''}`} aria-current={activeTab === 'prefixes' ? 'page' : undefined} onClick={() => { setActiveTab('prefixes'); loadPrefixes(); }}>
          <Icon name="folder" />
          <span>{t('nav.prefixes')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'sync' ? 'active' : ''}`} aria-current={activeTab === 'sync' ? 'page' : undefined} onClick={() => setActiveTab('sync')}>
          <Icon name="sync" />
          <span>{t('nav.sync')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'saves' ? 'active' : ''}`} aria-current={activeTab === 'saves' ? 'page' : undefined} onClick={() => setActiveTab('saves')}>
          <Icon name="files" />
          <span>{t('nav.saves')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'bigpicture' ? 'active' : ''}`} aria-current={activeTab === 'bigpicture' ? 'page' : undefined} onClick={() => setActiveTab('bigpicture')}>
          <Icon name="game" />
          <span>{t('nav.bigpicture')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'hltb' ? 'active' : ''}`} aria-current={activeTab === 'hltb' ? 'page' : undefined} onClick={() => setActiveTab('hltb')}>
          <Icon name="hltb" />
          <span>{t('nav.hltb')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'playtime' ? 'active' : ''}`} aria-current={activeTab === 'playtime' ? 'page' : undefined} onClick={() => { setActiveTab('playtime'); loadPlaytime(); }}>
          <Icon name="playtime" />
          <span>{t('nav.playtime')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'achievements' ? 'active' : ''}`} aria-current={activeTab === 'achievements' ? 'page' : undefined} onClick={() => { setActiveTab('achievements'); loadAchievements(); }}>
          <Icon name="achievements" />
          <span>{t('nav.achievements')}</span>
        </button>
        <button className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} aria-current={activeTab === 'settings' ? 'page' : undefined} onClick={() => setActiveTab('settings')}>
          <Icon name="settings" />
          <span>{t('nav.settings')}</span>
        </button>

        <div className="sidebar-foot">
          <div className="sidebar-stat">
            <Icon name="game" size={14} />
            <span>{tc('sidebar.games', games.length)}</span>
          </div>
          <div className={`sidebar-stat ${inSyncCount === games.length && games.length > 0 ? 'sidebar-stat-ok' : ''}`}>
            <Icon name={games.length > 0 && inSyncCount === games.length ? 'check' : 'warning'} size={14} />
            <span>{games.length === 0 ? t('sidebar.nothingTracked') : t('sidebar.inSync', { synced: inSyncCount, total: games.length })}</span>
          </div>
        </div>
      </nav>

      <main className="main-content">
        {activeTab === 'dashboard' && (
          <div>
            <div className="dashboard-header">
              <div>
                <h2>{t('dashboard.title')}</h2>
                <p className="text-muted">{t('dashboard.subtitle')}</p>
              </div>
              <div className="search-wrapper">
                <label htmlFor="library-search" className="sr-only">{t('dashboard.searchLabel')}</label>
                <Icon name="search" className="search-icon" />
                <input
                  id="library-search"
                  type="text"
                  className="search-input"
                  placeholder={t('dashboard.searchPlaceholder')}
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
                ? tc('dashboard.searchCount', games.length, { matched: filteredGames.length })
                : ''}
            </p>

            <div className="stats-row">
              <div className="card stat-card stat-accent">
                <span className="stat-icon"><Icon name="game" /></span>
                <div>
                  <div className="stat-value">{games.length}</div>
                  <div className="stat-label">{t('dashboard.statTracked')}</div>
                </div>
              </div>
              <div className="card stat-card stat-success">
                <span className="stat-icon"><Icon name="check" /></span>
                <div>
                  <div className="stat-value">{inSyncCount}</div>
                  <div className="stat-label">{t('dashboard.statInSync')}</div>
                </div>
              </div>
              <div className="card stat-card stat-danger">
                <span className="stat-icon"><Icon name="warning" /></span>
                <div>
                  <div className="stat-value">{games.length - inSyncCount}</div>
                  <div className="stat-label">{t('dashboard.statPending')}</div>
                </div>
              </div>
            </div>

            <div className="games-grid">
              {filteredGames.map(game => (
                <div key={game.id} className="game-card">
                  {game.thumbnail ? (
                    <img src={game.thumbnail} className="game-cover" alt="" loading="lazy" />
                  ) : (
                    <div className="game-cover-placeholder">{t('game.noCover')}</div>
                  )}
                  <div className="game-info">
                    <div className="game-title-row">
                      <div className="game-title" title={game.name}>{game.name}</div>
                      <SourceBadge game={game} />
                    </div>
                    <div className={`game-status ${game.status === 'In Sync' ? 'status-synced' : 'status-pending'}`}>
                      <span className={`status-dot ${game.status === 'In Sync' ? 'synced' : 'pending'}`} aria-hidden="true" />
                      {gameStatusLabel(game.status, t)}
                      <span className="sync-time">· {formatDate(game.lastSync, locale, t)}</span>
                    </div>
                    <GamePathInfo game={game} compact />
                    {hltbCache[game.name] && (
                      <div className="hltb-info">
                        {t('dashboard.hltbTimes', {
                          main: formatMinutes(hltbCache[game.name].mainStory),
                          extra: formatMinutes(hltbCache[game.name].mainExtra),
                          complete: formatMinutes(hltbCache[game.name].completionist),
                        })}
                      </div>
                    )}
                    <div className="game-actions">
                      <button className="btn btn-primary" onClick={() => handleLaunch(game)} disabled={launchingGameId !== null}>
                        <Icon name="play" size={14} />
                        {launchingGameId === game.id ? t('game.launching') : t('game.launch')}
                      </button>
                      <button className="btn btn-secondary" onClick={() => handleFetchArt(game)}>{t('game.autoArt')}</button>
                      <button className="btn btn-secondary" onClick={() => handleSetCustomArt(game)}>{t('game.setArt')}</button>
                      <button className="btn btn-secondary" onClick={() => loadHLTB(game.name)} disabled={!hasServer || !!hltbCache[game.name] || !!hltbLoading[game.name]} title={hasServer ? undefined : t('game.hltbNeedsServer')}>
                        {hltbLoading[game.name] ? '...' : hltbCache[game.name] ? t('game.hltbLoaded') : t('game.hltb')}
                      </button>
                      <button className="btn btn-secondary btn-danger-full" onClick={() => pendingRemoveId === game.id ? handleRemoveGame(game) : setPendingRemoveId(game.id)}>
                        {pendingRemoveId === game.id ? t('game.confirmRemove') : t('common.remove')}
                      </button>
                      {pendingRemoveId === game.id && (
                        <button className="btn btn-secondary btn-danger-full" onClick={() => setPendingRemoveId(null)}>{t('common.cancel')}</button>
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
                    <p>{t('dashboard.noMatch', { term: searchTerm })}</p>
                    <p className="text-muted text-sm">{t('dashboard.noMatchHint')}</p>
                    <button className="btn btn-secondary" onClick={() => setSearchTerm('')}>{t('dashboard.clearSearch')}</button>
                  </>
                ) : (
                  <>
                    <Icon name="game" size={32} />
                    <p>{t('dashboard.empty')}</p>
                    <button className="btn btn-primary" onClick={() => setActiveTab('mapping')}><Icon name="add" />{t('dashboard.addGames')}</button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'mapping' && (
          <div>
            <div className="section-header">
              <h2>{t('mapping.title')}</h2>
              <button
                className="btn btn-primary"
                disabled={isScanning}
                onClick={handleAutoScan}
              >
                <Icon name="scan" />
                {isScanning ? t('mapping.scanning') : t('mapping.autoDetect')}
              </button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="add" />{t('mapping.addTitle')}</h3>
              <div className="form-group">
                <label htmlFor="new-game-title">{t('mapping.gameTitle')}</label>
                <input
                  id="new-game-title"
                  type="text"
                  autoComplete="off"
                  className={newGameNameError ? 'input-error' : ''}
                  aria-invalid={newGameNameError ? true : undefined}
                  aria-describedby={newGameNameError ? 'new-game-title-error' : undefined}
                  value={newGameName}
                  onChange={e => { setNewGameName(e.target.value); if (newGameNameError) setNewGameNameError(null); }}
                  placeholder={t('mapping.titlePlaceholder')}
                />
                {newGameNameError && <p id="new-game-title-error" className="error-text" role="alert">{newGameNameError}</p>}
              </div>
              <div className="form-group">
                <label htmlFor="new-game-win">{t('mapping.winFolder')}</label>
                <input id="new-game-win" type="text" aria-describedby="save-folder-hint" value={newGameWin} onChange={e => setNewGameWin(e.target.value)} placeholder="%USERPROFILE%\Documents\Saved Games\Hades" />
              </div>
              <div className="form-group">
                <label htmlFor="new-game-lin">{t('mapping.linFolder')}</label>
                <input id="new-game-lin" type="text" aria-describedby="save-folder-hint" value={newGameLin} onChange={e => setNewGameLin(e.target.value)} placeholder="~/.local/share/Hades/Saves" />
              </div>
              <p id="save-folder-hint" className="text-muted text-sm form-hint">
                {t('mapping.folderHint')}
              </p>
              <button className="btn btn-primary" onClick={handleAddGame}><Icon name="check" />{t('mapping.save')}</button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="game" />{t('mapping.tracked', { count: games.length })}</h3>
              {games.length === 0 ? (
                <p className="text-muted">{t('mapping.none')}</p>
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
                        <Icon name="play" size={14} />{launchingGameId === g.id ? t('game.launching') : t('game.launch')}
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => pendingRemoveId === g.id ? handleRemoveGame(g) : setPendingRemoveId(g.id)}>
                        {pendingRemoveId === g.id ? t('mapping.confirm') : t('common.remove')}
                      </button>
                      {pendingRemoveId === g.id && (
                        <button className="btn btn-secondary btn-sm" onClick={() => setPendingRemoveId(null)}>{t('common.cancel')}</button>
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
                <h2>{t('prefixes.title')}</h2>
                <p className="text-muted">{t('prefixes.subtitle')}</p>
              </div>
              <button className="btn btn-secondary" onClick={loadPrefixes} disabled={isLoadingPrefixes}>
                <Icon name="refresh" />
                {isLoadingPrefixes ? t('common.loading') : t('common.refresh')}
              </button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="add" />{t('prefixes.createTitle')}</h3>
              <form noValidate onSubmit={e => { e.preventDefault(); void handleCreatePrefix(); }}>
                <div className="form-group">
                  <label htmlFor="new-prefix-name">{t('prefixes.name')}</label>
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
                    placeholder={t('prefixes.namePlaceholder')}
                  />
                  <p id="new-prefix-hint" className="form-hint">{t('prefixes.nameHint')}</p>
                  {newPrefixError && <p id="new-prefix-error" className="error-text" role="alert">{newPrefixError}</p>}
                </div>
                <button type="submit" className="btn btn-primary" aria-disabled={creatingPrefix || undefined}>
                  <Icon name="check" />{creatingPrefix ? t('prefixes.creating') : t('prefixes.create')}
                </button>
              </form>
            </div>

            <div className="card">
              <h3 className="card-title" ref={prefixListHeadingRef} tabIndex={-1}><Icon name="folder" />{t('prefixes.listTitle')}</h3>
              {prefixLoadError ? (
                <div className="inline-error" role="alert">
                  <span>{prefixLoadError}</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={loadPrefixes}>{t('common.tryAgain')}</button>
                </div>
              ) : !prefixes ? (
                <div className="empty-state">
                  <Icon name="folder" size={28} />
                  <p>{isLoadingPrefixes ? t('prefixes.loading') : t('prefixes.loadPrompt')}</p>
                  {!isLoadingPrefixes && <button className="btn btn-secondary" onClick={loadPrefixes}>{t('prefixes.load')}</button>}
                </div>
              ) : prefixes.length === 0 ? (
                <p className="text-muted text-sm">{t('prefixes.empty')}</p>
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
                          aria-label={t('prefixes.backupLabel', { name: prefix.name })}
                          aria-disabled={prefixBusyId === prefix.id || undefined}
                          onClick={() => handleBackupPrefix(prefix)}
                        >
                          {t('prefixes.backup')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={t('prefixes.deleteLabel', { name: prefix.name })}
                          aria-disabled={prefixBusyId === prefix.id || undefined}
                          onClick={() => { if (!prefixBusyId) setPrefixToDelete(prefix); }}
                        >
                          {t('prefixes.delete')}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <ConfirmDialog
              open={prefixToDelete !== null}
              title={t('prefixes.deleteTitle')}
              confirmLabel={t('prefixes.moveToTrash')}
              onCancel={() => setPrefixToDelete(null)}
              onConfirm={() => { if (prefixToDelete) void handleDeletePrefix(prefixToDelete); }}
            >
              <p><strong>{prefixToDelete?.name}</strong></p>
              <p className="path-value">{prefixToDelete?.path}</p>
              <p className="muted">{t('prefixes.deleteBody')}</p>
            </ConfirmDialog>
          </div>
        )}

        {activeTab === 'sync' && (
          <div>
            <h2 className="section-title"><Icon name="sync" size={20} />{t('sync.title')}</h2>

            {syncProgress && (
              <div className={`card sync-progress-card ${syncProgress.done ? (syncProgress.success ? 'sync-done' : 'sync-error') : 'sync-active'}`}>
                <div className="sync-progress-header">
                  <div className="sync-progress-title">
                    {syncProgress.done
                      ? (syncProgress.success ? t('sync.doneTitle') : t('sync.failedTitle'))
                      : t('sync.running')}
                  </div>
                  <div className="sync-progress-percent">
                    {syncProgress.percent > 0 ? `${syncProgress.percent}%` : ''}
                  </div>
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label={t('sync.progressLabel')}
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
                  {syncProgress.done && <span className="sr-only">{t('sync.statusPrefix', { status: syncProgress.success ? t('sync.doneTitle') : t('sync.failedTitle') })}</span>}
                  {syncProgress.message}
                </div>
              </div>
            )}

            <div className="card">
              <h3 className="card-title"><Icon name="export" />{t('sync.exportTitle')}</h3>
              <p className="text-muted card-desc">{t('sync.exportDesc')}</p>
              <button className="btn btn-primary" onClick={handleExport}><Icon name="export" />{t('sync.exportButton')}</button>
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="push" />{t('sync.serverTitle')}</h3>
              <p className="text-muted card-desc">{formatRich(t('sync.serverDesc'), { server: <strong>{t('sync.serverName')}</strong> })}</p>

              <div className="sync-btn-row">
                <button
                  className="btn btn-primary btn-flex"
                  onClick={handleCloudSync}
                  disabled={isSyncing}
                >
                  {isSyncing ? <span className="spinner-inline" /> : <Icon name="push" />}
                  {isSyncing ? t('sync.working') : t('sync.push')}
                </button>
                <button
                  className="btn btn-secondary btn-flex btn-outline-accent"
                  onClick={handleRestoreCloud}
                  disabled={isSyncing}
                >
                  <Icon name="restore" />
                  {isSyncing ? t('sync.working') : pendingRestore ? t('restore.confirm') : t('restore.button')}
                </button>
              </div>
              {pendingRestore && !isSyncing && (
                <div className="confirm-bar" role="alert">
                  <span>{t('restore.warning')}</span>
                  <button className="btn btn-secondary btn-sm" onClick={() => setPendingRestore(false)}>{t('common.cancel')}</button>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'saves' && (
          <div className="section-header">
            <div>
              <h2>{t('saves.title')}</h2>
              <p className="text-muted">{t('saves.subtitle')}</p>
            </div>
            {games.length > 0 && (
              <div className="form-group save-game-picker">
                <label htmlFor="save-game-select">{t('saves.game')}</label>
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
            <span className="conflict-banner-text">{t('saves.conflictBanner')}</span>
            <button className="btn btn-primary btn-sm" onClick={() => setConflictDialog(conflictDialogFor(activeConflict, selectedSaveGameName, visibleSaveVersions))}>{t('saves.reviewConflict')}</button>
          </div>
        )}
        {activeTab === 'saves' && savesServerState === 'none' && (
          <NoServerNotice message={t('noServer.saves')} onOpenSettings={openServerSettings} />
        )}
        {activeTab === 'saves' && savesServerState === 'unreachable' && (
          <div className="card no-server-card" role="status">
            <p className="no-server-text">{t('noServer.savesUnreachable')}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={openServerSettings}>{t('noServer.checkSettings')}</button>
          </div>
        )}
        {activeTab === 'saves' && savesServerState === 'ok' && (
          <div className="card">
            <h3 className="card-title">{t('saves.versions')}</h3>
            {selectedSaveGameId !== null && !savesMatch ? (
              <p className="text-muted text-sm" role="status">{t('saves.loading')}</p>
            ) : savesLoadError ? (
              <div className="saves-load-error" role="alert">
                <p className="text-sm">{t('saves.loadFailed', { reason: serverFailureMessage(savesLoadError, t) })}</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSavesReloadKey(k => k + 1)}>{t('common.tryAgain')}</button>
              </div>
            ) : (
              <SaveVersionTimeline
                versions={visibleSaveVersions}
                restoringId={restoringVersionId}
                onRestore={(version) => {
                  if (selectedSaveGameId === null || restoringVersionId !== null) return;
                  setRestoreTarget({ gameId: selectedSaveGameId, game: selectedSaveGameName, version });
                }}
              />
            )}
            <ConfirmDialog
              open={restoreTarget !== null}
              title={t('saves.restoreConfirmTitle', { game: restoreTarget?.game ?? '' })}
              confirmLabel={t('saves.restoreConfirm')}
              onConfirm={runVersionRestore}
              onCancel={() => setRestoreTarget(null)}
            >
              <p>{t('saves.restoreConfirmBody', { date: restoreTarget ? formatDate(restoreTarget.version.createdAt, locale, t) : '' })}</p>
            </ConfirmDialog>
          </div>
        )}
        {activeTab === 'saves' && (
          <div className="card">
            <h3 className="card-title">{t('saves.storage')}</h3>
            <DriveSpaceList rows={driveRows} error={driveError} onRetry={loadDrives} />
            {storageEntries.length > 0 && (
              <StorageManager drives={[]} entries={storageEntries} gameName={(id) => games.find(g => g.id === id)?.name} />
            )}
          </div>
        )}
        {activeTab === 'saves' && savesServerState === 'ok' && (
          <div className="card">
            <h3 className="card-title">{t('saves.exclusions')}</h3>
            {!exclusionProfile ? (
              <p className="text-muted text-sm">{t('saves.noProfile')}</p>
            ) : (
            <>
              {saveFilesState.status === 'loading' && (
                <p className="text-muted text-sm" role="status">{t('exclusions.loadingFiles')}</p>
              )}
              {saveFilesState.status === 'error' && (
                <p className="text-muted text-sm exclusion-files-error" role="status">{t(saveFilesState.messageKey)}</p>
              )}
              {saveFilesState.status === 'ready' && saveFilesState.truncated && (
                <p className="text-muted text-sm exclusion-files-truncated" role="note">{t('exclusions.truncated', { count: saveFilesState.files.length })}</p>
              )}
              {saveFilesState.status === 'ready' && (
                <ExclusionEditor key={`${selectedSaveGameName}:${exclusionProfile.gameId}:${exclusionRevision}`} profile={exclusionProfile} files={saveFilesState.files} onChange={handleExclusionChange} />
              )}
            </>
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
              showToast(resolution === 'later' ? t('saves.conflictLater') : t('saves.conflictResolved'), resolution === 'later' ? 'info' : 'success');
            } else showToast(serverFailureMessage(res, t), 'error');
          } catch {
            showToast(t('saves.resolveFailed'), 'error');
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
                <h2>{t('hltb.title')}</h2>
                <p className="text-muted">{t('hltb.subtitle')}</p>
              </div>
              <NoServerNotice message={t('noServer.hltb')} onOpenSettings={openServerSettings} />
            </div>
          )
        )}
        {activeTab === 'playtime' && (
          <div>
            <div className="section-header">
              <h2>{t('playtime.title')}</h2>
              <button className="btn btn-secondary" onClick={loadPlaytime} disabled={!hasServer || isLoadingPlaytime}>
                <Icon name="refresh" />
                {isLoadingPlaytime ? t('common.loadingDots') : t('common.refresh')}
              </button>
            </div>
            {!hasServer ? (
              <NoServerNotice message={t('noServer.playtime')} onOpenSettings={openServerSettings} />
            ) : (
              <>
            <div className="stats-row">
              <div className="card stat-card stat-accent">
                <div className="stat-value">{formatMinutes(totalPlaytime)}</div>
                <div className="stat-label">{t('playtime.total')}</div>
              </div>
              <div className="card stat-card stat-success">
                <div className="stat-value">{playtimeSummary.length}</div>
                <div className="stat-label">{t('playtime.gamesTracked')}</div>
              </div>
            </div>
            <div className="card">
              <div className="btn-row" style={{ justifyContent: 'flex-end', marginBottom: '12px' }}>
                <button className="btn btn-secondary btn-sm" onClick={handleExportPlaytime}><Icon name="export" />{t('playtime.exportCsv')}</button>
              </div>
              <PlaytimeCharts data={playtimeGraph} comparison={playtimeComparison} />
            </div>
            <div className="card">
              {playtimeSummary.length === 0 ? (
                <div className="empty-state">
                  <Icon name="playtime" size={28} />
                  <p>{t('playtime.empty')}</p>
                  <p className="text-muted text-sm">{t('playtime.emptyHint')}</p>
                </div>
              ) : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr><th>{t('table.game')}</th><th>{t('table.platform')}</th><th>{t('table.total')}</th><th>{t('table.sessions')}</th><th>{t('table.lastPlayed')}</th></tr>
                    </thead>
                    <tbody>
                      {playtimeSummary.map((p) => (
                        <tr key={p.gameId}>
                          <td>{p.game}</td>
                          <td>{p.platform}</td>
                          <td>{formatMinutes(p.totalMinutes)}</td>
                          <td>{p.totalSessions}</td>
                          <td>{formatDate(p.lastPlayed || 'Never', locale, t)}</td>
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
              <h2>{t('achievements.title')}</h2>
              <button className="btn btn-secondary" onClick={loadAchievements} disabled={!hasServer || isLoadingAch}>
                <Icon name="refresh" />
                {isLoadingAch ? t('common.loadingDots') : t('common.refresh')}
              </button>
            </div>
            {!hasServer ? (
              <NoServerNotice message={t('noServer.achievements')} onOpenSettings={openServerSettings} />
            ) : (
              <>
            {games.length > 0 && (
              <div className="card">
                <h3 className="card-title"><Icon name="scan" />{t('achievements.importTitle')}</h3>
                <p className="text-muted text-sm">
                  {t('achievements.importDesc')}
                </p>
                <div className="inline-form">
                  <div className="form-group">
                    <label htmlFor="ach-import-game">{t('saves.game')}</label>
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
                    {isLoadingAch ? t('achievements.importing') : t('achievements.scan')}
                  </button>
                </div>
              </div>
            )}
            <div className="card">
              {achievementSummary.length === 0 ? (
                <div className="empty-state">
                  <Icon name="achievements" size={28} />
                  <p>{t('achievements.empty')}</p>
                  <p className="text-muted text-sm">{t('achievements.emptyHint')}</p>
                </div>
              ) : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr><th>{t('table.game')}</th><th>{t('table.unlocked')}</th><th>{t('table.progress')}</th><th><span className="sr-only">{t('table.actions')}</span></th></tr>
                    </thead>
                    <tbody>
                      {achievementSummary.map((a) => (
                        <tr key={a.game} className={selectedAchGame === a.game ? 'row-active' : ''}>
                          <td>{a.game}</td>
                          <td>{a.unlocked} / {a.total}</td>
                          <td>
                            <div className="progress-track progress-sm">
                              <div className="progress-fill" style={{ width: `${a.percentage}%` }} />
                            </div>
                            <span className="text-muted">{a.percentage}%</span>
                          </td>
                          <td><button className="btn btn-secondary btn-sm" aria-label={t('achievements.viewLabel', { game: a.game })} onClick={() => loadGameAchievements(a.game)}>{t('achievements.view')}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {recentUnlocks.length > 0 && (
              <div className="card">
                <h3 className="card-title"><Icon name="sparkles" />{t('achievements.recent')}</h3>
                <div className="path-list">
                  {recentUnlocks.map(a => {
                    const tier = rarityTier(a.rarity);
                    return (
                      <div className="path-row" key={`${a.game}-${a.id}`}>
                        <div className="path-main">
                          <strong>{a.displayName}</strong>
                          <div className="path-sub">{a.game} · {a.unlockTime ? formatDate(a.unlockTime, locale, t) : t('achievements.unlocked')}</div>
                        </div>
                        <span className={`badge rarity-${tier.tier}`} style={rarityStyle(tier, true)}>{rarityLabel(tier, t)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {achievements.length > 0 && (
              <div className="card">
                <h3 className="card-title">
                  {t('achievements.detailTitle', {
                    game: selectedAchGame,
                    unlocked: achievementProgress?.unlocked ?? achievements.filter(a => a.unlocked).length,
                    total: achievementProgress?.total ?? achievements.length,
                  })}
                </h3>
                {achievementProgress?.rarestUnlocked && (
                  <p className="text-muted text-sm">
                    {formatRich(t('achievements.rarest'), {
                      tier: <strong className={`rarity-${achievementProgress.rarestUnlocked.tier}`} style={rarityStyle(achievementProgress.rarestUnlocked)}>{rarityLabel(achievementProgress.rarestUnlocked, t)}</strong>,
                    })}
                  </p>
                )}
                <div className="ach-grid">
                  {achievements.map(a => {
                    const tier = rarityTier(a.rarity);
                    const secret = a.hidden && !a.unlocked;
                    return (
                      <div key={a.id} className={`ach-card ${a.unlocked ? 'ach-unlocked' : 'ach-locked'}`}>
                        <div className="ach-name">{secret ? t('achievements.hidden') : a.displayName}</div>
                        <div className="ach-desc">{secret ? t('achievements.hiddenDesc') : a.description}</div>
                        {a.unlocked && a.unlockTime && <div className="ach-time">{formatDate(a.unlockTime, locale, t)}</div>}
                        {a.rarity > 0 && (
                          <div className={`ach-rarity rarity-${tier.tier}`} style={rarityStyle(tier)}>
                            {t('achievements.rarity', { tier: rarityLabel(tier, t), percent: a.rarity.toFixed(1) })}
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
            <h2 className="section-title"><Icon name="settings" size={20} />{t('settings.title')}</h2>

            <div className="card">
              <h3 className="card-title"><Icon name="settings" />{t('settings.general')}</h3>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.runInBackground}
                  onChange={e => saveSettings({ runInBackground: e.target.checked })}
                  className="checkbox-input"
                />
                {t('settings.runInBackground')}
              </label>

              <PrivacyToggles
                settings={settings}
                onChange={next => saveSettings({ trackersEnabled: next.trackersEnabled, artworkEnabled: next.artworkEnabled })}
              />

              <h4 className="section-subtitle">{t('settings.steamGridTitle')}</h4>
              <p className="text-muted text-sm">
                {t('settings.steamGridDesc')}
              </p>
              {!hasServer ? (
                <p className="text-muted text-sm">{t('settings.steamGridNeedsServer')}</p>
              ) : (
                <form noValidate onSubmit={e => { e.preventDefault(); void handleSaveSteamGridKey(); }}>
                  <p id="steamgriddb-key-status" className="key-status-line" role="status" aria-live="polite">
                    {formatRich(t('settings.steamGridKeyStatus'), {
                      status: (
                        <span className={steamGridKeySet ? 'key-status key-status-set' : 'key-status'}>
                          {steamGridKeySet === null ? t('settings.steamGridKeyUnknown') : steamGridKeySet ? t('settings.keySet') : t('settings.keyNotSet')}
                        </span>
                      ),
                    })}
                  </p>
                  <label htmlFor="steamgriddb-key">{t('settings.steamGridKey')}</label>
                  <div className="key-input-row">
                    <input
                      id="steamgriddb-key"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="off"
                      data-1p-ignore
                      data-lpignore="true"
                      className={`masked-input${steamGridKeyError ? ' input-error' : ''}`}
                      aria-invalid={steamGridKeyError ? true : undefined}
                      aria-describedby={steamGridKeyError ? 'steamgriddb-key-status steamgriddb-key-error' : 'steamgriddb-key-status steamgriddb-key-hint'}
                      value={steamGridKeyDraft}
                      onChange={e => { setSteamGridKeyDraft(e.target.value); if (steamGridKeyError) setSteamGridKeyError(null); }}
                      placeholder={steamGridKeySet ? t('settings.steamGridReplacePlaceholder') : t('settings.steamGridPlaceholder')}
                    />
                    <button type="submit" className="btn btn-secondary" aria-disabled={steamGridKeyBusy || undefined}>{t('settings.steamGridSave')}</button>
                    {steamGridKeySet && (
                      <button type="button" className="btn btn-secondary" disabled={steamGridKeyBusy} onClick={() => setConfirmClearSteamGridKey(true)}>{t('settings.clearKey')}</button>
                    )}
                  </div>
                  {steamGridKeyError ? (
                    <p id="steamgriddb-key-error" className="error-text" role="alert">{steamGridKeyError}</p>
                  ) : (
                    <p id="steamgriddb-key-hint" className="form-hint">{t('settings.steamGridKeyHint')}</p>
                  )}
                </form>
              )}
              <ConfirmDialog
                open={confirmClearSteamGridKey}
                title={t('settings.steamGridClearTitle')}
                confirmLabel={t('settings.clearKey')}
                onCancel={() => setConfirmClearSteamGridKey(false)}
                onConfirm={() => { void handleClearSteamGridKey(); }}
              >
                <p className="muted">{t('settings.steamGridClearBody')}</p>
              </ConfirmDialog>
            </div>

            <div className="card">
              <h3 className="card-title card-title-row">
                <span className="card-title-label"><Icon name="paths" />{t('settings.scanTitle')}</span>
                <button className="btn btn-secondary btn-sm" onClick={handleAddRoot}><Icon name="add" size={14} />{t('settings.addRoot')}</button>
              </h3>
              {(settings.scanRoots ?? []).length > 0 ? (
                <ul className="scan-list">
                  {(settings.scanRoots ?? []).map((r) => (
                    <li key={r} className="scan-row">{r} <button className="link-btn-danger" aria-label={t('settings.removeRootLabel', { path: r })} onClick={() => handleRemoveRoot(r)}>{t('settings.removeRoot')}</button></li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">{t('settings.noRoots')}</p>
              )}
            </div>

            <div className="card">
              <h3 className="card-title"><Icon name="sync" />{t('settings.serverTitle')}</h3>

              <div className="form-group">
                <label htmlFor="server-url">{t('settings.serverUrl')}</label>
                <input
                  id="server-url"
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className={fieldErrors.serverUrl ? 'input-error' : ''}
                  aria-invalid={fieldErrors.serverUrl ? true : undefined}
                  aria-describedby={fieldErrors.serverUrl ? 'server-url-error' : undefined}
                  placeholder={t('settings.serverUrlPlaceholder')}
                  value={serverUrlDraft ?? cloud.url}
                  onChange={e => { setServerUrlDraft(e.target.value); scheduleCommit('serverUrl', e.target.value); }}
                  onBlur={e => { if (serverUrlDraft !== null) commitField('serverUrl', e.target.value); }}
                />
                {fieldErrors.serverUrl && (
                  <p id="server-url-error" className="error-text" role="alert">{fieldErrors.serverUrl}</p>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="server-api-key">{t('settings.serverKey')}</label>
                <p id="server-api-key-status" className="key-status-line" role="status" aria-live="polite">
                  {formatRich(t('settings.keyStatus'), {
                    status: <span className={serverKeySet ? 'key-status key-status-set' : 'key-status'}>{serverKeyUnreadable ? t('settings.keyUnreadableStatus') : serverKeySet ? t('settings.keySet') : t('settings.keyNotSet')}</span>,
                  })}
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
                    placeholder={serverKeySet ? t('settings.keyReplacePlaceholder') : t('settings.keyPastePlaceholder')}
                    value={serverKeyDraft ?? ''}
                    onChange={e => { setServerKeyDraft(e.target.value); scheduleCommit('serverKey', e.target.value); }}
                    onBlur={e => { if (serverKeyDraft !== null) commitField('serverKey', e.target.value); }}
                  />
                  {serverKeySet && (
                    <button type="button" className="btn btn-secondary" onClick={() => setConfirmClearServerKey(true)}>{t('settings.clearKey')}</button>
                  )}
                </div>
                {fieldErrors.serverKey ? (
                  <p id="server-api-key-error" className="error-text" role="alert">{fieldErrors.serverKey}</p>
                ) : (
                  <p id="server-api-key-hint" className={serverKeySet && !serverKeyUnreadable ? 'form-hint' : 'error-text'}>
                    {serverKeyUnreadable
                      ? t('settings.keyUnreadable')
                      : serverKeySet
                        ? t('settings.keySavedHint')
                        : t('settings.keyMissingHint')}
                  </p>
                )}
              </div>
              <ConfirmDialog
                open={confirmClearServerKey}
                title={t('settings.clearKeyTitle')}
                confirmLabel={t('settings.clearKey')}
                onCancel={() => setConfirmClearServerKey(false)}
                onConfirm={() => {
                  setConfirmClearServerKey(false);
                  setServerKeyDraft(null);
                  serverKeyQueue.enqueue('');
                }}
              >
                <p className="muted">{t('settings.clearKeyBody')}</p>
              </ConfirmDialog>

              <div className="btn-row">
                <button className="btn btn-primary" onClick={handleTestCloud}><Icon name="plug" />{t('settings.testConnection')}</button>
              </div>

              <h4 className="section-subtitle section-divider">{t('settings.autoSyncTitle')}</h4>
              <p className="text-sm text-muted">
                {settings.autoSyncEnabled
                  ? t('settings.autoSyncActive', { freq: settings.autoSyncFreq ?? '' })
                  : t('settings.autoSyncDisabled')}
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.autoSyncEnabled}
                  onChange={e => saveSettings({ autoSyncEnabled: e.target.checked })}
                  className="checkbox-input"
                />
                {t('settings.autoSyncEnable')}
              </label>

              <label htmlFor="auto-sync-freq">{t('settings.syncFreq')}</label>
              <select
                id="auto-sync-freq"
                value={settings.autoSyncFreq}
                onChange={e => saveSettings({ autoSyncFreq: e.target.value })}
                disabled={!settings.autoSyncEnabled}
              >
                <option value="never">{t('settings.freqNever')}</option>
                <option value="1h">{t('settings.freq1h')}</option>
                <option value="6h">{t('settings.freq6h')}</option>
                <option value="24h">{t('settings.freq24h')}</option>
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
              <h3 className="card-title"><Icon name="settings" />{t('settings.appearance')}</h3>
              <label htmlFor="theme-select">{t('settings.theme')}</label>
              <select id="theme-select" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
                {loadThemes().map((theme) => (
                  <option key={theme.id} value={theme.id}>{theme.name}</option>
                ))}
              </select>
              <label htmlFor="locale-select">{t('settings.language')}</label>
              <select
                id="locale-select"
                value={locale}
                aria-describedby={localeIncomplete ? 'locale-partial-note' : undefined}
                onChange={(e) => { if (isLocale(e.target.value)) setLocale(e.target.value); }}
              >
                {availableLocales.map((item) => (
                  <option key={item} value={item} lang={item}>{LOCALE_NAMES[item]}</option>
                ))}
              </select>
              {localeIncomplete && (
                <p id="locale-partial-note" className="form-hint">{t('settings.languagePartial')}</p>
              )}
            </div>

          </div>
        )}
      </main>

      <div className="toast-container">
        {/* Live regions stay mounted so screen readers announce new toasts. */}
        <div className="toast-region" role="status" aria-live="polite">
          {toasts.filter(toast => toast.type !== 'error').map(toast => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
          ))}
        </div>
        <div className="toast-region" role="alert">
          {toasts.filter(toast => toast.type === 'error').map(toast => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
          ))}
        </div>
      </div>
    </div>
  );
}
