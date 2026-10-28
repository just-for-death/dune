import { describe, it, expect, vi } from 'vitest';
import type { UpdateStatus } from '@dune/shared';
import { UPDATE_CHECK_INTERVAL_MS, createUpdateController, type UpdaterLike } from './updater';

// Fake electron-updater; nothing is downloaded or installed.
function fakeUpdater(version = '2.0.0') {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const u = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn((event: string, cb: (...a: unknown[]) => void) => { handlers[event] = cb; return u; }),
    checkForUpdates: vi.fn(async () => ({ updateInfo: { version } })),
    downloadUpdate: vi.fn(async () => ['file']),
    quitAndInstall: vi.fn(),
    handlers,
  };
  return u;
}

function setup(opts: { enabled?: boolean; packaged?: boolean; version?: string } = {}) {
  const updater = fakeUpdater(opts.version);
  let enabled = opts.enabled ?? false;
  const sent: UpdateStatus[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const ctl = createUpdateController({
    updater: updater as unknown as UpdaterLike,
    isPackaged: opts.packaged ?? true,
    enabled: () => enabled,
    currentVersion: '1.0.0',
    send: (s) => sent.push(s),
    log: vi.fn(),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: vi.fn(),
  });
  return { ctl, updater, sent, intervals, setEnabled: (v: boolean) => { enabled = v; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('updates are opt-in and click-only (DUN-028)', () => {
  it('autoDownload and autoInstallOnAppQuit are always off', () => {
    const { updater } = setup({ enabled: true });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('off by default: no check, no timer', async () => {
    const { ctl, updater, intervals } = setup();
    ctl.refresh();
    await flush();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(intervals).toEqual([]);
    expect(ctl.status()).toEqual({ state: 'disabled' });
  });

  it('dev builds never check even when opted in', async () => {
    const { ctl, updater } = setup({ enabled: true, packaged: false });
    ctl.refresh();
    await flush();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('opted in: checks once plus every 24 h, reports, never downloads by itself', async () => {
    const { ctl, updater, intervals, sent } = setup({ enabled: true });
    ctl.refresh();
    ctl.refresh();
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(intervals).toEqual([{ fn: expect.any(Function), ms: UPDATE_CHECK_INTERVAL_MS }]);
    expect(ctl.status()).toEqual({ state: 'available', version: '2.0.0' });
    expect(sent.map((s) => s.state)).toEqual(['checking', 'available']);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('download and install only on explicit calls, in order', async () => {
    const { ctl, updater } = setup({ enabled: true });
    expect(ctl.install()).toEqual({ state: 'idle' });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    ctl.refresh();
    await flush();
    expect(await ctl.download()).toEqual({ state: 'downloaded', version: '2.0.0' });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    ctl.install();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('download is refused when nothing is available or the opt-in was turned off', async () => {
    const { ctl, updater, setEnabled } = setup({ enabled: true, version: '1.0.0' });
    ctl.refresh();
    await flush();
    expect(ctl.status().state).toBe('not-available');
    await ctl.download();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    setEnabled(false);
    ctl.refresh();
    expect(ctl.status()).toEqual({ state: 'disabled' });
  });
});
