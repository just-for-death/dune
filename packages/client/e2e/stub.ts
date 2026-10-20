import type { Page } from '@playwright/test';
import type {
  BackupPrefixResult,
  BackupProfile,
  CloudSyncResult,
  CreatePrefixResult,
  DeletePrefixResult,
  DriveSpace,
  ElectronAPI,
  Game,
  LaunchFailureReason,
  PlaytimeComparison,
  PlaytimeGraphData,
  ServerFailure,
  Settings,
} from '@dune/shared';

type FailReason<R> = Extract<R, { ok: false }> extends { reason: infer X } ? X : never;

/**
 * Electron IPC bridge stub shared by the a11y and keyboard specs (mirrors the
 * one in smoke.spec.ts). Seed data is passed in so specs can open the Saves
 * conflict modal and Big Picture grid without dev-only demo fixtures, since
 * Playwright serves the production build.
 */
export interface StubGame {
  id: number;
  name: string;
  thumbnail?: string;
  linPath?: string;
  winPath?: string;
  installPath?: string;
  executable?: string;
  /** A Game['source'] value; plain string so spec fixtures need no `as const`. */
  source?: string;
  sourceId?: string;
  tags?: string[];
}

type StubVersion = { id: string; gameId: number; createdAt: string; sizeBytes: number; fileCount: number; changeSummary: string; status: 'complete' };
export type StubPrefix = { id: string; name: string; path: string; createdAt: string; gameId?: string };
type StubConflict = { id: string; gameId: number; localVersionId: string; remoteVersionId: string; detectedAt: string };

export interface StubOptions {
  games?: StubGame[];
  /** Per-game save data (keyed by game name); falls back to versions/conflicts below. */
  perGame?: Record<string, { versions?: StubVersion[]; conflicts?: StubConflict[] }>;
  /** Artificial reply delay in ms for per-game calls (save data, achievement detail), keyed by game name. */
  delayMs?: Record<string, number>;
  /** Game names listed in the achievements summary. */
  achievementGames?: string[];
  /** Make saveConfig fail (reject) for the next N calls. */
  failSaveConfig?: number;
  cloudUrl?: string;
  /** DUN-062 managed prefixes and forced failure codes per operation. */
  prefixes?: StubPrefix[];
  prefixFail?: { create?: FailReason<CreatePrefixResult>; backup?: FailReason<BackupPrefixResult>; delete?: FailReason<DeletePrefixResult> };
  /** Fake Dune server behind the sources/servers/api-keys IPC (only answers when cloudUrl is set). */
  server?: {
    sources?: { id: number; path: string }[];
    servers?: { id: number; url: string }[];
    keys?: { id: string; description: string; createdAt: string; masked: string }[];
    /** false: admin-only calls answer like requireAdmin (403). Default true. */
    admin?: boolean;
    /**
     * Make the list calls fail. A string is the message of a 500 INTERNAL
     * failure; an object sets the ServerFailure status/code/message.
     */
    failLoad?: string | { status?: number; code: string; message: string };
    /** Reply delay in ms for every server call. */
    delayMs?: number;
  };
  /** Make launchGame fail with this reason (and optional detail). */
  launchFail?: { reason: LaunchFailureReason; message?: string };
  /** pickLaunchTarget behaviour after add / "Choose executable…" (default: picks a file). */
  pickLaunch?: 'cancel' | 'invalid';
  emulators?: { id: string; name: string }[];
  /** getDiskSpace() reply (DriveSpace[]); 'throw' rejects. */
  drives?: DriveSpace[] | 'throw';
  /** This PC's stored server key; default 'e2e-key'. */
  serverKey?: string;
  conflicts?: StubConflict[];
  versions?: StubVersion[];
  /** syncCloud / restoreCloud failure (default: NO_SERVER). */
  syncFail?: Extract<CloudSyncResult, { ok: false }>;
  /** Playtime chart data; without it the graph and comparison calls fail (500). */
  playtime?: { graph?: PlaytimeGraphData; comparison?: PlaytimeComparison };
  /** Saved backup profile returned by getBackupProfile (default: none). */
  backupProfile?: BackupProfile;
  /** Make setBackupProfile reject ('reject') or answer with this ServerFailure. */
  backupProfileFail?: 'reject' | ServerFailure;
}

export const sampleGames = [
  { id: 1, name: 'Hades' },
  { id: 2, name: 'Celeste' },
  { id: 3, name: 'Hollow Knight' },
  { id: 4, name: 'Disco Elysium: The Final Cut — A Very Long Title That Must Clamp' },
  { id: 5, name: 'Outer Wilds' },
  { id: 6, name: 'Stardew Valley' },
  { id: 7, name: 'Slay the Spire' },
  { id: 8, name: 'Return of the Obra Dinn' },
];

/** Games for search: accents, tags and sources. */
export const searchGames: StubGame[] = [
  { id: 11, name: 'Hades', source: 'steam', tags: ['roguelike'] },
  { id: 12, name: 'Hades II', source: 'steam', tags: ['roguelike'] },
  { id: 13, name: 'Pokémon Légendes: Arceus', source: 'emulator' },
  { id: 14, name: 'Hollow Knight', source: 'gog', tags: ['metroidvania'] },
  { id: 15, name: 'Celeste', source: 'heroic' },
  { id: 16, name: 'Ōkami HD', source: 'lutris' },
];

const LONG_SEGMENT = 'a-really-long-folder-name-without-any-spaces-that-must-wrap-or-truncate';

/**
 * Path-display seed: a game with both a save and an install folder, one with
 * no save folder, one with no install folder (manual), and very long paths.
 */
export const pathGames: StubGame[] = [
  {
    id: 21,
    name: 'Hades',
    source: 'steam',
    sourceId: 'steam',
    linPath: '/home/jane/.steam/steam/steamapps/compatdata/1145360/pfx/drive_c/users/steamuser/Saved Games/Hades',
    installPath: '/home/jane/.steam/steam/steamapps/common/Hades',
    executable: 'Hades.exe',
  },
  {
    id: 22,
    name: 'Celeste',
    source: 'heroic',
    linPath: '',
    winPath: '',
    installPath: '/home/jane/Games/Heroic/Celeste',
    executable: 'Celeste',
  },
  {
    id: 23,
    name: 'My Homebrew Game',
    source: 'manual',
    linPath: '/home/jane/.local/share/homebrew/saves',
  },
  {
    id: 24,
    name: 'Disco Elysium',
    source: 'gog',
    linPath: '',
    winPath: `C:\\Users\\Jane\\AppData\\LocalLow\\ZAUM Studio\\Disco Elysium\\${LONG_SEGMENT}\\${LONG_SEGMENT}`,
    installPath: `/mnt/games/${LONG_SEGMENT}/${LONG_SEGMENT}/Disco Elysium`,
  },
  {
    id: 25,
    name: 'Stardew Valley',
    source: 'lutris',
    linPath: `/home/jane/.config/StardewValley/Saves/${LONG_SEGMENT}`,
  },
];

export const sampleConflict: StubOptions = {
  cloudUrl: 'http://localhost:3030',
  conflicts: [{ id: 'c1', gameId: 1, localVersionId: 'v1', remoteVersionId: 'v2', detectedAt: '2026-01-01T00:00:00.000Z' }],
  versions: [
    { id: 'v1', gameId: 1, createdAt: '2026-01-02T10:00:00.000Z', sizeBytes: 6.6 * 1024 * 1024, fileCount: 3, changeSummary: '+0 ~3 -0', status: 'complete' },
    { id: 'v2', gameId: 1, createdAt: '2026-01-02T09:00:00.000Z', sizeBytes: 6.1 * 1024 * 1024, fileCount: 3, changeSummary: '+1 ~2 -0', status: 'complete' },
  ],
};

export async function installElectronStub(page: Page, options: StubOptions = {}): Promise<void> {
  await page.addInitScript((opts: StubOptions) => {
    const now = '2026-01-01T00:00:00.000Z';
    const store = {
      games: (opts.games ?? []).map(({ source, ...g }): Game => ({
        winPath: '',
        linPath: `/tmp/${g.id}.sh`,
        lastSync: 'Never',
        status: 'Pending Upload',
        thumbnail: '',
        createdAt: now,
        updatedAt: now,
        ...g,
        ...(source !== undefined ? { source: source as Game['source'] } : {}),
      })),
      cloud: { url: opts.cloudUrl ?? '' },
      // Same values as App's DEFAULT_SETTINGS, so the merged settings are unchanged.
      settings: {
        runInBackground: false,
        autoSyncEnabled: false,
        autoSyncFreq: 'never',
        steamGridDbKey: '',
        scanRoots: [],
        maxVersions: 10,
        steamGridApiKey: '',
        ollamaEndpoint: 'http://localhost:11434',
        ollamaModel: 'phi4-mini:latest',
        apiKeys: [],
        localSources: [],
        remoteServers: [],
      } satisfies Settings,
    };
    const calls: { method: string; args: unknown[] }[] = [];
    (window as unknown as { __stubCalls: typeof calls }).__stubCalls = calls;
    // Server-calling IPC answers like main with no HTTP response; fetchArt keeps its own { success } contract.
    const network = async () => ({ ok: false as const, code: 'NETWORK', message: 'offline (e2e stub)' });
    const offline = async () => ({ success: false, message: 'offline (e2e stub)' });
    let saveConfigFailures = opts.failSaveConfig ?? 0;
    const prefixes = structuredClone(opts.prefixes ?? []);
    const srv = {
      sources: structuredClone(opts.server?.sources ?? []),
      servers: structuredClone(opts.server?.servers ?? []),
      keys: structuredClone(opts.server?.keys ?? []),
      admin: opts.server?.admin ?? true,
      nextId: 100,
      issued: 0,
    };
    let serverKey = opts.serverKey ?? 'e2e-key';
    const serverWait = () => new Promise((r) => setTimeout(r, opts.server?.delayMs ?? 0));
    // Shapes and codes as main / the server emit them (net/serverError.ts, middleware/auth.ts, server.ts).
    const noServer = { ok: false as const, code: 'NO_SERVER', message: 'No Dune Server configured' };
    const forbidden = { ok: false as const, status: 403, code: 'FORBIDDEN', message: 'Admin privileges required' };
    const failLoad = () => {
      const f = opts.server?.failLoad;
      if (f === undefined) return null;
      return typeof f === 'string'
        ? { ok: false as const, status: 500, code: 'INTERNAL', message: f }
        : { ok: false as const, ...f };
    };
    const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
    const wait = (game: string) => new Promise((r) => setTimeout(r, opts.delayMs?.[game] ?? 0));
    const versionsFor = (game: string) => structuredClone(opts.perGame?.[game]?.versions ?? opts.versions ?? []);
    const conflictsFor = (game?: string) =>
      structuredClone(game !== undefined && opts.perGame?.[game]?.conflicts ? opts.perGame[game].conflicts! : opts.conflicts ?? []);
    const api: Partial<ElectronAPI> = {
      loadConfig: async () => structuredClone(store),
      saveConfig: async (partial: Record<string, unknown>) => {
        calls.push({ method: 'saveConfig', args: [structuredClone(partial)] });
        if (saveConfigFailures > 0) {
          saveConfigFailures -= 1;
          throw new Error('disk full (e2e stub)');
        }
        Object.assign(store, structuredClone(partial));
        return true;
      },
      addGame: async (input) => {
        const game: Game = { winPath: '', linPath: '', lastSync: 'Never', status: 'Pending Upload', thumbnail: '', createdAt: now, updatedAt: now, ...input, id: Date.now() };
        store.games.push(game);
        return { ok: true, game, games: store.games };
      },
      removeGame: async (id: number) => {
        store.games = store.games.filter((g) => g.id !== id);
        return { ok: true, games: store.games };
      },
      autoDetectGames: async () => ({ count: 0, currentGames: store.games }),
      selectDirectory: async () => ({ success: false }),
      testCloud: network,
      syncCloud: async () => {
        record('syncCloud');
        return opts.syncFail ?? { ok: false, code: 'NO_SERVER', message: 'No server configured' };
      },
      restoreCloud: async () => {
        record('restoreCloud');
        return opts.syncFail ?? { ok: false, code: 'NO_SERVER', message: 'No server configured' };
      },
      fetchArt: offline,
      setCustomArt: async () => false,
      onSyncProgress: () => () => {},
      recordPlaytime: async () => ({ ok: true, success: true }),
      onPlaytimeRecorded: () => () => {},
      getPlaytimeSummary: async () => ({ ok: true, success: true, summary: [] }),
      getRecentSessions: async () => ({ ok: true, success: true, sessions: [] }),
      getTotalPlaytime: async () => ({ ok: true, success: true, totalMinutes: 0 }),
      getPlaytimeGraphData: async () => (opts.playtime?.graph
        ? { ok: true, success: true, data: structuredClone(opts.playtime.graph) }
        : { ok: false, status: 500, code: 'INTERNAL', message: 'Internal error' }),
      getPlaytimeComparison: async () => (opts.playtime?.comparison
        ? { ok: true, success: true, comparison: structuredClone(opts.playtime.comparison) }
        : { ok: false, status: 500, code: 'INTERNAL', message: 'Internal error' }),
      getAchievements: async () => ({ ok: true, success: true, achievements: [] }),
      getAchievementSummary: async () => ({
        ok: true,
        success: true,
        summary: (opts.achievementGames ?? []).map((game) => ({ game, unlocked: 1, total: 2, percentage: 50 })),
      }),
      getRecentUnlocks: async () => ({ ok: true, success: true, unlocks: [] }),
      importLocalAchievements: async () => ({ ok: true, success: true, count: 0, message: 'No local achievement files found' }),
      onAchievementsImported: () => () => {},
      getAchievementDetail: async (game: string) => {
        await wait(game);
        return {
          ok: true,
          success: true,
          achievements: [{
            id: 1, game, apiName: 'ACH', displayName: `${game} first steps`, description: `Unlocked in ${game}`,
            unlocked: true, unlockTime: '2026-01-01T00:00:00.000Z', rarity: 50, localRarity: 0, hidden: false,
            iconUrl: '', iconGrayUrl: '', isSecret: false, steamApiName: 'ACH', createdAt: '', updatedAt: '',
          }],
          progress: { total: 1, unlocked: 1, percentage: 100, rarestUnlocked: null },
        };
      },
      getHLTBTimes: network,
      analyzeFiles: network,
      searchArt: async () => ({ ok: true, success: true, results: [] }),
      autoMatchAll: async () => ({ ok: true, success: true, count: 0 }),
      getServerKey: async () => ({ success: true, key: serverKey }),
      setServerKey: async (key: string) => {
        // The key value itself is never recorded, only whether it was cleared.
        calls.push({ method: 'setServerKey', args: key ? [] : ['<cleared>'] });
        serverKey = key;
        return { success: true };
      },
      getLocalSources: async () => {
        await serverWait();
        if (!store.cloud.url) return noServer;
        const loadFailure = failLoad();
        if (loadFailure) return loadFailure;
        return { ok: true, success: true, sources: structuredClone(srv.sources) };
      },
      addLocalSource: async (path: string) => {
        record('addLocalSource', path);
        await serverWait();
        if (!store.cloud.url) return noServer;
        if (!srv.admin) return forbidden;
        if (path.includes('missing')) return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'Path does not exist' };
        const source = { id: srv.nextId++, path };
        srv.sources.push(source);
        return { ok: true, success: true, source };
      },
      removeLocalSource: async (id: number) => {
        record('removeLocalSource', id);
        await serverWait();
        if (!store.cloud.url) return noServer;
        if (!srv.admin) return forbidden;
        srv.sources = srv.sources.filter((s) => s.id !== id);
        return { ok: true, success: true };
      },
      getRemoteServers: async () => {
        await serverWait();
        if (!store.cloud.url) return noServer;
        const loadFailure = failLoad();
        if (loadFailure) return loadFailure;
        return { ok: true, success: true, servers: structuredClone(srv.servers) };
      },
      addRemoteServer: async (url: string) => {
        record('addRemoteServer', url);
        await serverWait();
        if (!store.cloud.url) return noServer;
        if (!srv.admin) return forbidden;
        const server = { id: srv.nextId++, url };
        srv.servers.push(server);
        return { ok: true, success: true, server };
      },
      removeRemoteServer: async (id: number) => {
        record('removeRemoteServer', id);
        await serverWait();
        if (!store.cloud.url) return noServer;
        if (!srv.admin) return forbidden;
        srv.servers = srv.servers.filter((s) => s.id !== id);
        return { ok: true, success: true };
      },
      getApiKeys: async () => {
        await serverWait();
        if (!store.cloud.url) return noServer;
        const loadFailure = failLoad();
        if (loadFailure) return loadFailure;
        return { ok: true, success: true, keys: structuredClone(srv.keys) };
      },
      addApiKey: async (description?: string) => {
        record('addApiKey', description ?? '');
        await serverWait();
        if (!store.cloud.url) return noServer;
        srv.issued += 1;
        const id = `k${srv.issued}`.padEnd(12, '0');
        srv.keys.push({ id, description: description ?? '', createdAt: '2026-10-20T07:00:00.000Z', masked: '****' });
        return { ok: true, success: true, key: `dune_e2e_issued_${srv.issued}_6f1d2c` };
      },
      removeApiKey: async (id: string) => {
        record('removeApiKey', id);
        await serverWait();
        if (!store.cloud.url) return noServer;
        srv.keys = srv.keys.filter((k) => k.id !== id);
        return { ok: true, success: true };
      },
      launchGame: async (gameId: number) => {
        const game = store.games.find((g) => g.id === gameId);
        calls.push({ method: 'launchGame', args: [gameId] });
        if (opts.launchFail) return { ok: false, ...opts.launchFail };
        return game ? { ok: true, pid: 1234 } : { ok: false, reason: 'not-found' };
      },
      getLaunchCommand: async () => ({ ok: false, reason: 'not-launchable' }),
      pickLaunchTarget: async (gameId: number) => {
        calls.push({ method: 'pickLaunchTarget', args: [gameId] });
        const game = store.games.find((g) => g.id === gameId);
        if (!game) return { ok: false, reason: 'not-found' };
        if (opts.pickLaunch === 'cancel') return { ok: false, reason: 'cancelled' };
        if (opts.pickLaunch === 'invalid') return { ok: false, reason: 'invalid' };
        game.executable = `/home/jane/Games/${game.name}/start.sh`;
        return { ok: true, game: structuredClone(game) };
      },
      setGamePrefix: async (gameId: number, prefixId: string | null) => {
        calls.push({ method: 'setGamePrefix', args: [gameId, prefixId] });
        const game = store.games.find((g) => g.id === gameId);
        if (!game) return { ok: false, reason: 'not-found' };
        if (prefixId && !prefixes.some((p) => p.id === prefixId)) return { ok: false, reason: 'prefix-not-found' };
        if (prefixId) game.managedPrefixId = prefixId;
        else delete game.managedPrefixId;
        return { ok: true, game: structuredClone(game) };
      },
      listEmulators: async () => structuredClone(opts.emulators ?? []),
      setGameEmulator: async (gameId: number, emulatorId: string | null) => {
        calls.push({ method: 'setGameEmulator', args: [gameId, emulatorId] });
        const game = store.games.find((g) => g.id === gameId);
        if (!game) return { ok: false, reason: 'not-found' };
        if (game.source !== 'emulator') return { ok: false, reason: 'not-emulator' };
        if (emulatorId && !(opts.emulators ?? []).some((e) => e.id === emulatorId)) return { ok: false, reason: 'unknown-emulator' };
        if (emulatorId) game.emulator = emulatorId;
        else delete game.emulator;
        return { ok: true, game: structuredClone(game) };
      },
      getDiskSpace: async () => {
        if (opts.drives === 'throw') throw new Error('disk (e2e stub)');
        return structuredClone(opts.drives ?? []);
      },
      listPrefixes: async () => structuredClone(prefixes),
      createPrefix: async (name: string) => {
        calls.push({ method: 'createPrefix', args: [name] });
        if (opts.prefixFail?.create) return { ok: false, reason: opts.prefixFail.create };
        const prefix = { id: `p-${prefixes.length + 1}`, name, path: `/home/jane/.local/share/dune/prefixes/${name}`, createdAt: now };
        prefixes.push(prefix);
        return { ok: true, prefix };
      },
      backupPrefix: async (id: string) => {
        calls.push({ method: 'backupPrefix', args: [id] });
        if (opts.prefixFail?.backup) return { ok: false, reason: opts.prefixFail.backup };
        return { ok: true, backupPath: `/home/jane/.local/share/dune/prefix-backups/${id}.tar` };
      },
      deletePrefix: async (id: string) => {
        calls.push({ method: 'deletePrefix', args: [id] });
        if (opts.prefixFail?.delete) return { ok: false, reason: opts.prefixFail.delete };
        const index = prefixes.findIndex((p) => p.id === id);
        if (index < 0) return { ok: false, reason: 'not-found' };
        const [gone] = prefixes.splice(index, 1);
        return { ok: true, trashedPath: `/home/jane/.local/share/Trash/files/${gone.name}` };
      },
      getSaveVersions: async (game: string) => {
        await wait(game);
        return { ok: true, success: true, versions: versionsFor(game) };
      },
      getStorage: async (game: string) => {
        await wait(game);
        return { ok: true, success: true };
      },
      getBackupProfile: async (game: string) => {
        await wait(game);
        return opts.backupProfile ? { ok: true, success: true, profile: structuredClone(opts.backupProfile) } : { ok: true, success: true };
      },
      setBackupProfile: async (profile) => {
        record('setBackupProfile', structuredClone(profile));
        if (opts.backupProfileFail === 'reject') throw new Error('ipc gone (e2e stub)');
        if (opts.backupProfileFail) return opts.backupProfileFail;
        return { ok: true, success: true, profile };
      },
      getConflicts: async (game?: string) => {
        if (game !== undefined) await wait(game);
        return { ok: true, success: true, conflicts: conflictsFor(game) };
      },
      resolveConflict: async (id: string, resolution: string) => {
        calls.push({ method: 'resolveConflict', args: [id, resolution] });
        return { ok: true, success: true };
      },
      restoreSaveVersion: async () => ({ ok: true, success: true, message: 'Restored' }),
    };
    (window as unknown as { electronAPI: Partial<ElectronAPI> }).electronAPI = api;
  }, options);
}

/** Calls recorded by the stub (launchGame, resolveConflict). */
export async function stubCalls(page: Page): Promise<{ method: string; args: unknown[] }[]> {
  return page.evaluate(() => (window as unknown as { __stubCalls: { method: string; args: unknown[] }[] }).__stubCalls);
}
