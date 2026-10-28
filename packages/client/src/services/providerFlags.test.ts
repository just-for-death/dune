import { describe, expect, it, vi } from 'vitest';
import { fetchProviderFlags, flagSaveErrorKey, flagsFrom, saveProviderFlags } from './providerFlags';
import { en } from '../i18n/en';
import { es } from '../i18n/es';

describe('flagsFrom', () => {
  it('reads the flat ServerResult', () => {
    expect(flagsFrom({ ok: true, hltbEnabled: true, artworkEnabled: false })).toEqual({ hltbEnabled: true, artworkEnabled: false });
  });

  it('rejects failures, missing or non-boolean flags, and junk', () => {
    expect(flagsFrom({ ok: false, code: 'FORBIDDEN', message: 'x', status: 403 })).toBeNull();
    expect(flagsFrom({ ok: true, hltbEnabled: true })).toBeNull();
    expect(flagsFrom({ ok: true, hltbEnabled: 'yes', artworkEnabled: false })).toBeNull();
    expect(flagsFrom(new Error('x'))).toBeNull();
    expect(flagsFrom(null)).toBeNull();
  });
});

describe('fetchProviderFlags', () => {
  it('returns the flags, or null without an API, on failure or on a throw', async () => {
    const ok = { getServerProviderFlags: vi.fn().mockResolvedValue({ ok: true, hltbEnabled: false, artworkEnabled: true }) };
    expect(await fetchProviderFlags(ok)).toEqual({ hltbEnabled: false, artworkEnabled: true });
    expect(ok.getServerProviderFlags).toHaveBeenCalledTimes(1);
    expect(await fetchProviderFlags(undefined)).toBeNull();
    expect(await fetchProviderFlags({ getServerProviderFlags: vi.fn().mockResolvedValue({ ok: false, code: 'NETWORK', message: 'x' }) })).toBeNull();
    expect(await fetchProviderFlags({ getServerProviderFlags: vi.fn().mockRejectedValue(new Error('boom')) })).toBeNull();
  });
});

describe('saveProviderFlags', () => {
  it('sends only the patch and returns the saved flags', async () => {
    const set = vi.fn().mockResolvedValue({ ok: true, hltbEnabled: true, artworkEnabled: false });
    expect(await saveProviderFlags({ setServerProviderFlags: set }, { hltbEnabled: true })).toEqual({ ok: true, flags: { hltbEnabled: true, artworkEnabled: false } });
    expect(set).toHaveBeenCalledWith({ hltbEnabled: true });
  });

  it('passes the failure code through (FORBIDDEN, INVALID_SETTINGS) and maps throws and junk', async () => {
    const fail = (code: string, status?: number) => ({ setServerProviderFlags: vi.fn().mockResolvedValue({ ok: false, code, status, message: 'x' }) });
    expect(await saveProviderFlags(fail('FORBIDDEN', 403), { artworkEnabled: true })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await saveProviderFlags(fail('INVALID_SETTINGS', 400), { artworkEnabled: true })).toEqual({ ok: false, code: 'INVALID_SETTINGS' });
    expect(await saveProviderFlags({ setServerProviderFlags: vi.fn().mockRejectedValue(new Error('x')) }, {})).toEqual({ ok: false, code: 'NETWORK' });
    expect(await saveProviderFlags({ setServerProviderFlags: vi.fn().mockResolvedValue({ ok: true }) }, {})).toEqual({ ok: false, code: 'UNKNOWN' });
    expect(await saveProviderFlags(undefined, {})).toEqual({ ok: false, code: 'NO_SERVER' });
  });
});

describe('flagSaveErrorKey', () => {
  it('says admin only for FORBIDDEN and is generic otherwise, in en and es', () => {
    expect(flagSaveErrorKey('FORBIDDEN')).toBe('privacy.flagSaveAdminOnly');
    for (const code of ['INVALID_SETTINGS', 'NETWORK', 'UNKNOWN', 'PROVIDER_DISABLED']) expect(flagSaveErrorKey(code)).toBe('privacy.flagSaveFailed');
    for (const key of ['privacy.flagSaveAdminOnly', 'privacy.flagSaveFailed'] as const) {
      expect(en[key]).toBeTruthy();
      expect(es[key]).toBeTruthy();
      expect(es[key]).not.toBe(en[key]);
    }
  });
});
