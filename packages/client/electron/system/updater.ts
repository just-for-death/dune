import type { UpdateStatus } from '@dune/shared';

/**
 * DUN-028: app updates are opt-in and never install without a click.
 *
 * - Nothing is checked automatically until the user turns on
 *   `settings.updateCheckEnabled` (default off). Then it checks at startup and
 *   every 24 h. (The manual release check, updates:checkRelease, always runs.)
 * - A check only reports; autoDownload and autoInstallOnAppQuit are always off.
 * - Download happens only on `download()` (a click) after a check found an
 *   update, install only on `install()` (a click) after the download finished.
 * Unpackaged (dev) builds never check.
 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'update-downloaded', cb: () => void): unknown;
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateControllerDeps {
  updater: UpdaterLike;
  isPackaged: boolean;
  /** The saved automatic-check opt-in (isUpdateCheckEnabled(settings): updateCheckEnabled === true). */
  enabled: () => boolean;
  /** The running app version. */
  currentVersion: string;
  send: (status: UpdateStatus) => void;
  log: (message: string) => void;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearInterval?: (handle: unknown) => void;
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateController {
  /** Apply the current opt-in (call at startup and after settings change). */
  refresh(): void;
  status(): UpdateStatus;
  download(): Promise<UpdateStatus>;
  install(): UpdateStatus;
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const { updater } = deps;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  const setI = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));

  let current: UpdateStatus = { state: deps.isPackaged && deps.enabled() ? 'idle' : 'disabled' };
  let timer: unknown = null;
  const set = (next: UpdateStatus) => {
    current = next;
    deps.send(next);
    return next;
  };
  const active = () => deps.isPackaged && deps.enabled();

  updater.on('error', (err) => {
    deps.log(`updater: ${err?.message || err}`);
    set({ state: 'error', message: String(err?.message || err) });
  });
  updater.on('update-downloaded', () => {
    set({ ...current, state: 'downloaded' });
  });

  const check = async () => {
    if (!active()) return;
    set({ state: 'checking' });
    try {
      const res = await updater.checkForUpdates();
      const version = res?.updateInfo?.version;
      if (version && version !== deps.currentVersion) set({ state: 'available', version });
      else set({ state: 'not-available' });
    } catch (err) {
      deps.log(`updater check: ${err instanceof Error ? err.message : String(err)}`);
      set({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    refresh() {
      if (!active()) {
        if (timer !== null) clearI(timer);
        timer = null;
        if (current.state !== 'downloading' && current.state !== 'downloaded') set({ state: 'disabled' });
        return;
      }
      if (timer !== null) return;
      void check();
      timer = setI(() => { void check(); }, UPDATE_CHECK_INTERVAL_MS);
      (timer as { unref?: () => void })?.unref?.();
    },
    status: () => current,
    async download() {
      if (!active() || current.state !== 'available') return current;
      const version = current.version;
      set({ state: 'downloading', version });
      try {
        await updater.downloadUpdate();
        return set({ state: 'downloaded', version });
      } catch (err) {
        deps.log(`updater download: ${err instanceof Error ? err.message : String(err)}`);
        return set({ state: 'error', version, message: err instanceof Error ? err.message : String(err) });
      }
    },
    install() {
      if (current.state !== 'downloaded') return current;
      updater.quitAndInstall();
      return current;
    },
  };
}
