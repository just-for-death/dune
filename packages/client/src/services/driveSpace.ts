/**
 * DUN-042: view model for getDiskSpace() (DriveSpace union). Reason codes are
 * turned into plain sentences; raw codes are never shown.
 */
import type { DriveSpace, DriveSpaceUnavailableReason } from '@dune/shared';

export const DRIVE_REASON_TEXT: Record<DriveSpaceUnavailableReason, string> = {
  'not-found': 'Folder not found. It may be on a drive that is not connected.',
  permission: 'Dune is not allowed to read this drive.',
  unsupported: 'Free space can’t be read on this kind of drive.',
  error: 'Free space could not be read.',
};

export function driveReasonText(reason: string): string {
  return Object.prototype.hasOwnProperty.call(DRIVE_REASON_TEXT, reason)
    ? DRIVE_REASON_TEXT[reason as DriveSpaceUnavailableReason]
    : DRIVE_REASON_TEXT.error;
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

export function toDriveRows(drives: readonly DriveSpace[]): DriveRow[] {
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
        freeText: `${formatGB(free)} free`,
        totalText: `${formatGB(total)} total`,
        reasonText: '',
      };
    }
    return {
      key: `na:${drive.reason}:${index}`,
      title: drive.paths.length === 1 ? drive.paths[0] : `${drive.paths.length} folders`,
      paths: drive.paths,
      available: false,
      usedPercent: 0,
      freeText: '',
      totalText: '',
      reasonText: driveReasonText(drive.reason),
    };
  });
}
