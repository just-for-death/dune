/** Pure display helpers for the downloads queue (kept out of the .tsx for react-refresh). */
import { formatBytes } from '../../services/format';
import { DOWNLOAD_IPC_ERROR_CODES } from '@dune/shared';
import type { MessageKey, PluralTranslator, Translator } from '../../i18n';
import type { DownloadAction, DownloadIpcErrorCode, DownloadSnapshot, DownloadStatus } from './types';
import type { DownloadsAnnouncement } from './downloadsStore';

/** Row actions per status, in display order. */
const ACTIONS: Record<DownloadStatus, readonly DownloadAction[]> = {
  queued: ['pause', 'cancel'],
  downloading: ['pause', 'cancel'],
  verifying: ['cancel'],
  paused: ['resume', 'cancel'],
  failed: ['retry', 'remove'],
  cancelled: ['retry', 'remove'],
  completed: ['remove'],
};

export function actionsFor(status: DownloadStatus): readonly DownloadAction[] {
  return ACTIONS[status] ?? [];
}

export const ACTION_LABEL_KEYS: Record<DownloadAction, { text: MessageKey; label: MessageKey }> = {
  pause: { text: 'downloads.pause', label: 'downloads.pauseLabel' },
  resume: { text: 'downloads.resume', label: 'downloads.resumeLabel' },
  cancel: { text: 'downloads.cancel', label: 'downloads.cancelLabel' },
  retry: { text: 'downloads.retry', label: 'downloads.retryLabel' },
  remove: { text: 'downloads.remove', label: 'downloads.removeLabel' },
};

type ErrorKey = `downloads.error.${DownloadIpcErrorCode}`;
/** Compile-time check: en.ts has a message for every shared DownloadIpcErrorCode (fails to build otherwise). */
const everyErrorCodeHasText: [Exclude<ErrorKey, MessageKey>] extends [never] ? true : Exclude<ErrorKey, MessageKey> = true;
void everyErrorCodeHasText;

/** Message key for every shared DownloadIpcErrorCode (DOWNLOAD_IPC_ERROR_CODES from @dune/shared). */
export const DOWNLOAD_ERROR_KEYS: readonly ErrorKey[] = DOWNLOAD_IPC_ERROR_CODES.map(
  (code): ErrorKey => `downloads.error.${code}`,
);

/** True for any shared DownloadIpcErrorCode (engine codes plus INVALID_ARGUMENT/CANCELLED/NOT_READY). */
export function isKnownErrorCode(code: unknown): code is DownloadIpcErrorCode {
  return typeof code === 'string' && (DOWNLOAD_IPC_ERROR_CODES as readonly string[]).includes(code);
}

/** Code → message key; unknown codes get the generic message (raw server text is never shown). */
export function errorMessageKey(code: string | null | undefined): MessageKey {
  return isKnownErrorCode(code) ? `downloads.error.${code}` : 'downloads.error.unknown';
}

export function errorCodeOf(item: DownloadSnapshot): string | null {
  return item.errorCode ?? item.error?.code ?? null;
}

/** True while a queued item is waiting for its automatic retry. */
export function isRetryPending(item: DownloadSnapshot, now: number): boolean {
  return item.status === 'queued' && typeof item.nextRetryAt === 'number' && item.nextRetryAt > now;
}

export function formatCountdown(ms: number, t: Translator): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return t('downloads.time.seconds', { seconds });
  return t('downloads.time.minutes', { minutes: Math.ceil(seconds / 60) });
}

/** Visible status text — the status is never conveyed by colour alone. */
export function statusText(item: DownloadSnapshot, now: number, t: Translator): string {
  if (isRetryPending(item, now)) {
    return t('downloads.status.retrying', { time: formatCountdown((item.nextRetryAt as number) - now, t) });
  }
  return t(`downloads.status.${item.status}`);
}

/** Tone used only for extra styling on top of the text label. */
export function statusTone(status: DownloadStatus): 'done' | 'error' | 'active' | 'idle' {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'error';
  if (status === 'downloading' || status === 'verifying') return 'active';
  return 'idle';
}

export interface ProgressInfo {
  /** 0–100, or null when the total is unknown (indeterminate). */
  percent: number | null;
  /** "1.5 MB of 3.0 MB" or "1.5 MB downloaded". */
  bytesText: string;
}

export function progressInfo(item: DownloadSnapshot, t: Translator): ProgressInfo {
  const received = Math.max(0, item.receivedBytes ?? item.bytesDownloaded ?? 0);
  const total = item.totalBytes;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    const raw = item.status === 'completed' ? 100 : Math.floor((received / total) * 100);
    return {
      percent: Math.min(100, Math.max(0, raw)),
      bytesText: t('downloads.bytesOf', { received: formatBytes(received), total: formatBytes(total) }),
    };
  }
  if (item.status === 'completed') {
    return { percent: 100, bytesText: formatBytes(received) };
  }
  return { percent: null, bytesText: t('downloads.bytesSoFar', { received: formatBytes(received) }) };
}

/** "2.0 MB/s" while transferring, otherwise null (nothing shown). */
export function speedText(item: DownloadSnapshot, t: Translator): string | null {
  if (item.status !== 'downloading' || !(item.speed > 0) || !Number.isFinite(item.speed)) return null;
  return t('downloads.speed', { size: formatBytes(item.speed) });
}

/** Human ETA while downloading; null for other states. */
export function etaText(item: DownloadSnapshot, t: Translator): string | null {
  if (item.status !== 'downloading') return null;
  const eta = item.eta;
  if (eta == null || !Number.isFinite(eta) || eta < 0) return t('downloads.eta.unknown');
  if (eta < 60) return t('downloads.eta.underMinute');
  const totalMinutes = Math.ceil(eta / 60);
  if (totalMinutes < 60) return t('downloads.eta.minutes', { minutes: totalMinutes });
  return t('downloads.eta.hours', { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 });
}

export function failedSummaryText(count: number, tc: PluralTranslator): string {
  return tc('downloads.failedSummary', count);
}

/** Live-region text: completions and failures only. */
export function announcementText(a: DownloadsAnnouncement | null, t: Translator): string {
  if (!a) return '';
  return a.kind === 'completed'
    ? t('downloads.announceCompleted', { name: a.name })
    : t('downloads.announceFailed', { name: a.name, reason: t(errorMessageKey(a.code)) });
}

function trimSep(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

/** True when the item's folder is outside the current base folder (saved before a change). */
export function isEarlierFolder(root: string | undefined, baseDir: string | undefined): boolean {
  if (!root || !baseDir) return false;
  const r = trimSep(root);
  const b = trimSep(baseDir);
  if (r === b) return false;
  return !(r.startsWith(`${b}/`) || r.startsWith(`${b}\\`));
}

/** Concurrency clamped to 1..max (integers). */
export function clampConcurrency(value: number, max: number): number {
  const top = Math.max(1, Math.floor(Number.isFinite(max) ? max : 1));
  if (!Number.isFinite(value)) return 1;
  return Math.min(top, Math.max(1, Math.round(value)));
}

export function concurrencyOptions(max: number): number[] {
  const top = clampConcurrency(max, max);
  return Array.from({ length: top }, (_, i) => i + 1);
}
