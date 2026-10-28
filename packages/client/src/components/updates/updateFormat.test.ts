import { describe, expect, it, vi } from 'vitest';
import { formatPublished, hasUpdateApi, outcomeFrom, runUpdateCheck, safeReleaseUrl, updateErrorKey } from './updateFormat';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';

const info = { version: '1.2.0', current: '1.1.0', releaseUrl: 'https://github.com/dune/dune/releases/tag/v1.2.0', notes: 'Fixes', isNewer: true };

describe('safeReleaseUrl', () => {
  it('keeps https URLs only', () => {
    expect(safeReleaseUrl('https://github.com/dune/dune/releases/tag/v1.2.0')).toBe('https://github.com/dune/dune/releases/tag/v1.2.0');
    expect(safeReleaseUrl('HTTPS://Example.com/r')).toBe('https://example.com/r');
  });

  it('rejects http, javascript:, data:, file:, relative, junk and non-strings', () => {
    for (const bad of ['http://example.com/r', 'javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd',
      '//example.com/r', '/releases/1', 'not a url', '', 'https//missing-colon']) {
      expect(safeReleaseUrl(bad)).toBeNull();
    }
    expect(safeReleaseUrl(undefined)).toBeNull();
    expect(safeReleaseUrl(42)).toBeNull();
  });
});

describe('outcomeFrom', () => {
  it('reads ok, ok+stale, and keeps optional publishedAt', () => {
    expect(outcomeFrom({ ok: true, update: info })).toEqual({ kind: 'result', update: info, stale: false });
    expect(outcomeFrom({ ok: true, update: { ...info, publishedAt: '2026-10-01T00:00:00Z' }, stale: true }))
      .toEqual({ kind: 'result', update: { ...info, publishedAt: '2026-10-01T00:00:00Z' }, stale: true });
  });

  it('passes the failure code and treats malformed replies or throws as UNKNOWN', () => {
    expect(outcomeFrom({ ok: false, code: 'PROVIDER_DISABLED', message: 'x' })).toEqual({ kind: 'error', code: 'PROVIDER_DISABLED' });
    expect(outcomeFrom({ ok: false })).toEqual({ kind: 'error', code: 'UNKNOWN' });
    expect(outcomeFrom({ ok: true })).toEqual({ kind: 'error', code: 'UNKNOWN' });
    expect(outcomeFrom({ ok: true, update: { ...info, isNewer: 'yes' } })).toEqual({ kind: 'error', code: 'UNKNOWN' });
    expect(outcomeFrom(new Error('x'))).toEqual({ kind: 'error', code: 'UNKNOWN' });
    expect(outcomeFrom(null)).toEqual({ kind: 'error', code: 'UNKNOWN' });
  });

  it('defaults missing notes/releaseUrl to empty strings', () => {
    const r = outcomeFrom({ ok: true, update: { version: '1', current: '1', isNewer: false } });
    expect(r).toEqual({ kind: 'result', stale: false, update: { version: '1', current: '1', isNewer: false, notes: '', releaseUrl: '' } });
  });
});

describe('runUpdateCheck', () => {
  it('asks for a fresh check and maps the reply', async () => {
    const checkForUpdates = vi.fn().mockResolvedValue({ ok: true, update: info });
    expect(await runUpdateCheck({ checkForUpdates })).toEqual({ kind: 'result', update: info, stale: false });
    expect(checkForUpdates).toHaveBeenCalledWith({ force: true });
  });

  it('never rejects: missing bridge is UNAVAILABLE, a throw is NETWORK', async () => {
    expect(await runUpdateCheck(undefined)).toEqual({ kind: 'error', code: 'UNAVAILABLE' });
    expect(await runUpdateCheck({})).toEqual({ kind: 'error', code: 'UNAVAILABLE' });
    expect(await runUpdateCheck({ checkForUpdates: vi.fn().mockRejectedValue(new Error('ipc')) })).toEqual({ kind: 'error', code: 'NETWORK' });
    expect(hasUpdateApi({ checkForUpdates: vi.fn() })).toBe(true);
  });
});

describe('updateErrorKey', () => {
  it('maps disabled, network/unreachable, unavailable and everything else', () => {
    expect(updateErrorKey('PROVIDER_DISABLED')).toBe('updates.errorDisabled');
    for (const c of ['NETWORK', 'UNREACHABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']) expect(updateErrorKey(c)).toBe('updates.errorNetwork');
    expect(updateErrorKey('UNAVAILABLE')).toBe('updates.unavailable');
    for (const c of ['UNKNOWN', 'PROVIDER_BAD_RESPONSE', 'SERVER_ERROR', 'PROVIDER_RATE_LIMITED']) expect(updateErrorKey(c)).toBe('updates.errorGeneric');
    for (const k of ['updates.errorDisabled', 'updates.errorNetwork', 'updates.errorGeneric', 'updates.unavailable'] as const) {
      expect(en[k]).toBeTruthy();
      expect(es[k]).toBeTruthy();
    }
  });
});

describe('formatPublished', () => {
  it('formats a valid date and returns null for missing or invalid ones', () => {
    expect(formatPublished('2026-10-01T12:00:00Z', 'en', 'UTC')).toBe('Oct 1, 2026');
    expect(formatPublished(undefined, 'en')).toBeNull();
    expect(formatPublished('soon', 'en')).toBeNull();
  });
});
