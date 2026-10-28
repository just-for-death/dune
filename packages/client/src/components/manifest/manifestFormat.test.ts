import { describe, expect, it, vi } from 'vitest';
import {
  hasManifestApi,
  isRetryable,
  isSamePath,
  manifestErrorKey,
  manifestErrorKind,
  normalizeManifestResult,
  runManifestLookup,
  safePageUrl,
} from './manifestFormat';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';

const ok = (over: Record<string, unknown> = {}) => ({
  ok: true,
  suggestions: [{ path: '/home/u/.local/share/Game/save', kind: 'save', exists: true }],
  attribution: 'From PCGamingWiki',
  pageUrl: 'https://www.pcgamingwiki.com/wiki/Game',
  ...over,
});

describe('safePageUrl', () => {
  it('keeps https URLs only (normalised)', () => {
    expect(safePageUrl('https://www.pcgamingwiki.com/wiki/Hades')).toBe('https://www.pcgamingwiki.com/wiki/Hades');
    expect(safePageUrl('HTTPS://PCGamingWiki.com/wiki/X')).toBe('https://pcgamingwiki.com/wiki/X');
  });

  it('rejects http, javascript:, data:, file:, relative, junk, null and non-strings', () => {
    for (const bad of ['http://www.pcgamingwiki.com/wiki/X', 'javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>',
      'file:///etc/passwd', '//pcgamingwiki.com/wiki/X', '/wiki/X', 'wiki/X', 'not a url', '', 'https//missing-colon']) {
      expect(safePageUrl(bad), bad).toBeNull();
    }
    expect(safePageUrl(null)).toBeNull();
    expect(safePageUrl(undefined)).toBeNull();
    expect(safePageUrl(42)).toBeNull();
  });
});

describe('normalizeManifestResult', () => {
  it('reads ok and ok+stale; pageUrl is https-checked', () => {
    expect(normalizeManifestResult(ok())).toEqual({
      kind: 'result', stale: false, attribution: 'From PCGamingWiki', pageUrl: 'https://www.pcgamingwiki.com/wiki/Game',
      suggestions: [{ path: '/home/u/.local/share/Game/save', kind: 'save', exists: true }],
    });
    const stale = normalizeManifestResult(ok({ stale: true, pageUrl: 'javascript:alert(1)' }));
    expect(stale).toMatchObject({ kind: 'result', stale: true, pageUrl: null });
    expect(normalizeManifestResult(ok({ pageUrl: null }))).toMatchObject({ pageUrl: null });
  });

  it('keeps an empty list; drops malformed entries and duplicates; exists is true only when literally true', () => {
    expect(normalizeManifestResult(ok({ suggestions: [] }))).toMatchObject({ kind: 'result', suggestions: [] });
    const r = normalizeManifestResult(ok({
      suggestions: [
        { path: 'C:\\Users\\u\\Saved Games\\G', kind: 'config', exists: 'yes' },
        { path: 'C:\\Users\\u\\Saved Games\\G', kind: 'config', exists: false },
        { path: '', kind: 'save', exists: true },
        { path: '/x', kind: 'other', exists: true },
        { path: 42, kind: 'save', exists: true },
        null,
        'junk',
      ],
    }));
    expect(r).toMatchObject({ kind: 'result', suggestions: [{ path: 'C:\\Users\\u\\Saved Games\\G', kind: 'config', exists: false }] });
  });

  it('missing attribution becomes empty (the view falls back to the standard credit)', () => {
    expect(normalizeManifestResult(ok({ attribution: undefined }))).toMatchObject({ attribution: '' });
  });

  it('failures keep the code; malformed replies are UNKNOWN', () => {
    expect(normalizeManifestResult({ ok: false, code: 'PROVIDER_DISABLED', message: 'off', status: 403 })).toEqual({ kind: 'error', code: 'PROVIDER_DISABLED' });
    expect(normalizeManifestResult({ ok: false, message: 'x' })).toEqual({ kind: 'error', code: 'UNKNOWN' });
    expect(normalizeManifestResult({ ok: true })).toEqual({ kind: 'error', code: 'UNKNOWN' });
    expect(normalizeManifestResult(null)).toEqual({ kind: 'error', code: 'UNKNOWN' });
    expect(normalizeManifestResult('x')).toEqual({ kind: 'error', code: 'UNKNOWN' });
    expect(normalizeManifestResult(new Error('boom'))).toEqual({ kind: 'error', code: 'UNKNOWN' });
  });
});

describe('runManifestLookup', () => {
  it('missing bridge is UNAVAILABLE and never throws', async () => {
    expect(hasManifestApi(undefined)).toBe(false);
    expect(hasManifestApi({})).toBe(false);
    expect(await runManifestLookup({}, 'g1')).toEqual({ kind: 'error', code: 'UNAVAILABLE' });
    expect(await runManifestLookup(undefined, 'g1')).toEqual({ kind: 'error', code: 'UNAVAILABLE' });
  });

  it('passes the game id; a throw is NETWORK', async () => {
    const api = { getManifestSuggestions: vi.fn().mockResolvedValue(ok()) };
    expect(hasManifestApi(api)).toBe(true);
    expect(await runManifestLookup(api, 'g1')).toMatchObject({ kind: 'result' });
    expect(api.getManifestSuggestions).toHaveBeenCalledWith('g1');
    const bad = { getManifestSuggestions: vi.fn().mockRejectedValue(new Error('down')) };
    expect(await runManifestLookup(bad, 'g1')).toEqual({ kind: 'error', code: 'NETWORK' });
  });
});

describe('error mapping', () => {
  it('maps every contract code', () => {
    expect(manifestErrorKind('UNAVAILABLE')).toBe('unavailable');
    expect(manifestErrorKind('PROVIDER_DISABLED')).toBe('disabled');
    expect(manifestErrorKind('GAME_NOT_FOUND')).toBe('notFound');
    expect(manifestErrorKind('MANIFEST_NOT_FOUND')).toBe('notFound');
    for (const c of ['MANIFEST_UNAVAILABLE', 'NETWORK', 'UNREACHABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']) {
      expect(manifestErrorKind(c), c).toBe('retry');
      expect(isRetryable(c), c).toBe(true);
    }
    for (const c of ['INVALID_GAME_ID', 'UNKNOWN', 'WHATEVER', '']) {
      expect(manifestErrorKind(c), c).toBe('generic');
      expect(isRetryable(c), c).toBe(false);
    }
    expect(isRetryable('PROVIDER_DISABLED')).toBe(false);
    expect(isRetryable('GAME_NOT_FOUND')).toBe(false);
  });

  it('every key exists in English and Spanish', () => {
    for (const c of ['UNAVAILABLE', 'PROVIDER_DISABLED', 'GAME_NOT_FOUND', 'NETWORK', 'X']) {
      const key = manifestErrorKey(c);
      expect(en[key], key).toBeTruthy();
      expect(es[key], key).toBeTruthy();
    }
  });
});

describe('isSamePath', () => {
  it('matches ignoring trailing separators and spaces; empty current never matches', () => {
    expect(isSamePath('/home/u/save', '/home/u/save/')).toBe(true);
    expect(isSamePath('C:\\Saves\\G\\', 'C:\\Saves\\G')).toBe(true);
    expect(isSamePath('/home/u/save', '/home/u/save2')).toBe(false);
    expect(isSamePath('/', '/')).toBe(true);
    expect(isSamePath('/home/u/save', null)).toBe(false);
    expect(isSamePath('/home/u/save', undefined)).toBe(false);
    expect(isSamePath('/home/u/save', '  ')).toBe(false);
  });
});
