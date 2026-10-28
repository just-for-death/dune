import { describe, expect, it } from 'vitest';
import { createPluralTranslator, createTranslator } from '../../i18n';
import { en } from '../../i18n/en';
import { es as esCatalog } from '../../i18n/es';
import {
  actionsFor, announcementText, clampConcurrency, concurrencyOptions, DOWNLOAD_ERROR_KEYS, errorMessageKey, etaText,
  failedSummaryText, isEarlierFolder, progressInfo, speedText, statusText,
} from './downloadsFormat';
import { snap } from './testFixtures';

const t = createTranslator('en');
const es = createTranslator('es');
const tcEn = createPluralTranslator('en');
const tcEs = createPluralTranslator('es');

describe('status helpers', () => {
  it('maps actions per status', () => {
    expect(actionsFor('downloading')).toEqual(['pause', 'cancel']);
    expect(actionsFor('queued')).toEqual(['pause', 'cancel']);
    expect(actionsFor('verifying')).toEqual(['cancel']);
    expect(actionsFor('paused')).toEqual(['resume', 'cancel']);
    expect(actionsFor('failed')).toEqual(['retry', 'remove']);
    expect(actionsFor('cancelled')).toEqual(['retry', 'remove']);
    expect(actionsFor('completed')).toEqual(['remove']);
  });

  it('labels status in text, including a retry countdown from nextRetryAt', () => {
    const now = 1_000_000;
    expect(statusText(snap({ status: 'paused' }), now, t)).toBe('Paused');
    expect(statusText(snap({ status: 'queued', nextRetryAt: now + 4200 }), now, t)).toBe('Retrying in 5 s');
    expect(statusText(snap({ status: 'queued', nextRetryAt: now + 125_000 }), now, t)).toBe('Retrying in 3 min');
    expect(statusText(snap({ status: 'queued', nextRetryAt: now - 1 }), now, t)).toBe('Queued');
    expect(statusText(snap({ status: 'queued', nextRetryAt: now + 4200 }), now, es)).toBe('Reintento en 5 s');
  });

  it('maps error codes to messages, unknown codes to the generic one', () => {
    expect(errorMessageKey('IO_ERROR')).toBe('downloads.error.IO_ERROR');
    expect(errorMessageKey('SOMETHING_NEW')).toBe('downloads.error.unknown');
    expect(errorMessageKey(null)).toBe('downloads.error.unknown');
    expect(t('downloads.error.IO_ERROR')).toMatch(/reconnect the drive, then retry/);
    expect(es('downloads.error.IO_ERROR')).toMatch(/vuelve a conectar la unidad y reintenta/);
  });

  it('has en and es text for every downloads key and error code', () => {
    const keysOf = (c: object) => Object.keys(c).filter(k => k.startsWith('downloads.') || k === 'nav.downloads').sort();
    expect(keysOf(esCatalog)).toEqual(keysOf(en));
    expect(keysOf(en)).toHaveLength(82);
    expect(en).not.toHaveProperty(['downloads.tryAgain']);
    for (const k of DOWNLOAD_ERROR_KEYS) {
      expect(en[k]).toBeTruthy();
      expect(esCatalog[k]).toBeTruthy();
    }
    // 18 engine codes + INVALID_ARGUMENT, CANCELLED, NOT_READY (shared DownloadIpcErrorCode).
    expect(DOWNLOAD_ERROR_KEYS).toHaveLength(21);
    expect(errorMessageKey('NOT_READY')).toBe('downloads.error.NOT_READY');
  });
});

describe('formatting helpers', () => {
  it('reports determinate and indeterminate progress', () => {
    expect(progressInfo(snap(), t)).toEqual({ percent: 50, bytesText: '512 B of 1.0 KB' });
    expect(progressInfo(snap({ totalBytes: null, receivedBytes: 2048 }), t)).toEqual({ percent: null, bytesText: '2.0 KB downloaded' });
    expect(progressInfo(snap({ status: 'completed', receivedBytes: 1024 }), t).percent).toBe(100);
    expect(progressInfo(snap({ receivedBytes: 5000 }), t).percent).toBe(100);
  });

  it('formats speed and ETA only while downloading', () => {
    expect(speedText(snap(), t)).toBe('2.0 KB/s');
    expect(speedText(snap({ status: 'paused' }), t)).toBeNull();
    expect(etaText(snap({ eta: 30 }), t)).toBe('Less than a minute left');
    expect(etaText(snap({ eta: 125 }), t)).toBe('About 3 min left');
    expect(etaText(snap({ eta: 3 * 3600 + 600 }), t)).toBe('About 3 h 10 min left');
    expect(etaText(snap({ eta: null }), t)).toBe('Time left unknown');
    expect(etaText(snap({ status: 'completed', eta: 0 }), t)).toBeNull();
  });

  it('pluralises the failure summary and builds announcements', () => {
    expect(failedSummaryText(1, tcEn)).toBe('1 download failed');
    expect(failedSummaryText(1, tcEs)).toBe('Falló 1 descarga');
    expect(failedSummaryText(3, tcEs)).toBe('Fallaron 3 descargas');
    expect(announcementText({ seq: 1, kind: 'completed', id: 'a', name: 'x.zip', code: null }, t)).toBe('x.zip finished downloading.');
    expect(announcementText({ seq: 2, kind: 'failed', id: 'a', name: 'x.zip', code: 'NETWORK_ERROR' }, t))
      .toBe('x.zip failed. Network problem. Check your connection, then retry.');
  });

  it('flags folders outside the current base folder and clamps concurrency', () => {
    expect(isEarlierFolder('/dl/steam', '/dl')).toBe(false);
    expect(isEarlierFolder('/dl', '/dl/')).toBe(false);
    expect(isEarlierFolder('/old/steam', '/dl')).toBe(true);
    expect(isEarlierFolder('/dl2/steam', '/dl')).toBe(true);
    expect(isEarlierFolder('D:\\Games\\steam', 'D:\\Games')).toBe(false);
    expect(isEarlierFolder('/x', undefined)).toBe(false);
    expect(clampConcurrency(0, 4)).toBe(1);
    expect(clampConcurrency(9, 4)).toBe(4);
    expect(concurrencyOptions(3)).toEqual([1, 2, 3]);
  });
});
