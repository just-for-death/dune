import { describe, expect, it } from 'vitest';
import type { DriveSpace } from '@dune/shared';
import { DRIVE_REASON_TEXT, driveReasonText, formatGB, toDriveRows } from './driveSpace';

describe('driveSpace', () => {
  it('maps every reason to a sentence and unknown ones to the generic text', () => {
    for (const [code, text] of Object.entries(DRIVE_REASON_TEXT)) {
      expect(text).not.toContain(code);
      expect(driveReasonText(code)).toBe(text);
    }
    expect(driveReasonText('weird')).toBe(DRIVE_REASON_TEXT.error);
    expect(driveReasonText('__proto__')).toBe(DRIVE_REASON_TEXT.error);
  });

  it('formats sizes', () => {
    expect(formatGB(0)).toBe('0 GB');
    expect(formatGB(NaN)).toBe('0 GB');
    expect(formatGB(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatGB(690 * 1024 ** 3)).toBe('690 GB');
    expect(formatGB(2 * 1024 ** 4)).toBe('2.0 TB');
  });

  it('builds rows for ok and unavailable drives', () => {
    const drives: DriveSpace[] = [
      { paths: ['/home/jane/.steam'], mount: '/', label: 'System', status: 'ok', freeBytes: 25 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
      { paths: ['/mnt/games'], mount: '/mnt/games', status: 'ok', freeBytes: 200, totalBytes: 100 },
      { paths: ['/media/usb/saves'], status: 'unavailable', reason: 'not-found' },
      { paths: ['/a', '/b'], status: 'unavailable', reason: 'permission' },
    ];
    const rows = toDriveRows(drives);
    expect(rows[0]).toMatchObject({ title: 'System', available: true, usedPercent: 75, freeText: '25.0 GB free', totalText: '100 GB total' });
    expect(rows[1]).toMatchObject({ title: '/mnt/games', usedPercent: 0 }); // free clamped to total
    expect(rows[2]).toMatchObject({ title: '/media/usb/saves', available: false, reasonText: DRIVE_REASON_TEXT['not-found'] });
    expect(rows[3].title).toBe('2 folders');
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
  });
});
