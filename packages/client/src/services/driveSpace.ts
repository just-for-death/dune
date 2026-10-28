/**
 * DUN-042: view model for getDiskSpace() (DriveSpace union). Reason codes are
 * turned into plain sentences; raw codes are never shown.
 */
import type { DriveSpace, DriveSpaceUnavailableReason } from '@dune/shared';
import { defaultTranslator, type MessageKey, type Translator } from '../i18n';

/** DUN-044: catalog keys for each reason, so the sentence follows the UI language. */
const DRIVE_REASON_KEYS: Record<DriveSpaceUnavailableReason, MessageKey> = {
  'not-found': 'drives.reason.notFound',
  permission: 'drives.reason.permission',
  unsupported: 'drives.reason.unsupported',
  error: 'drives.reason.error',
};

/** English wording per reason (reference for tests and logs). */
export const DRIVE_REASON_TEXT: Record<DriveSpaceUnavailableReason, string> = {
  'not-found': defaultTranslator(DRIVE_REASON_KEYS['not-found']),
  permission: defaultTranslator(DRIVE_REASON_KEYS.permission),
  unsupported: defaultTranslator(DRIVE_REASON_KEYS.unsupported),
  error: defaultTranslator(DRIVE_REASON_KEYS.error),
};

export function driveReasonText(reason: string, t: Translator = defaultTranslator): string {
  return t(Object.prototype.hasOwnProperty.call(DRIVE_REASON_KEYS, reason)
    ? DRIVE_REASON_KEYS[reason as DriveSpaceUnavailableReason]
    : DRIVE_REASON_KEYS.error);
}

export function formatGB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

export interface DriveRow {
  key: string;
  title: string;
  paths: string[];
  available: boolean;
  /** 0-100, only when available. */
  usedPercent: number;
  freeText: string;
  totalText: string;
  /** Plain sentence when unavailable. */
  reasonText: string;
}

export function toDriveRows(drives: readonly DriveSpace[], t: Translator = defaultTranslator): DriveRow[] {
  return drives.map((drive, index) => {
    if (drive.status === 'ok') {
      const total = Math.max(0, drive.totalBytes);
      const free = Math.min(Math.max(0, drive.freeBytes), total);
      const usedPercent = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
      return {
        key: `ok:${drive.mount}`,
        title: drive.label?.trim() || drive.mount,
        paths: drive.paths,
        available: true,
        usedPercent,
        freeText: t('drives.free', { size: formatGB(free) }),
        totalText: t('drives.total', { size: formatGB(total) }),
        reasonText: '',
      };
    }
    return {
      key: `na:${drive.reason}:${index}`,
      title: drive.paths.length === 1 ? drive.paths[0] : t('drives.folders', { count: drive.paths.length }),
      paths: drive.paths,
      available: false,
      usedPercent: 0,
      freeText: '',
      totalText: '',
      reasonText: driveReasonText(drive.reason, t),
    };
  });
}
