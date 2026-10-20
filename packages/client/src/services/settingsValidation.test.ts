import { describe, expect, it } from 'vitest';
import { validateApiKey, validateServerUrl } from './settingsValidation';

describe('validateServerUrl', () => {
  it('accepts absolute http(s) URLs and returns the normalised value', () => {
    expect(validateServerUrl('http://192.168.1.10:3030')).toEqual({ ok: true, value: 'http://192.168.1.10:3030' });
    expect(validateServerUrl('  https://Dune.Example.org/ ')).toEqual({ ok: true, value: 'https://dune.example.org' });
  });

  it('treats empty as "no server"', () => {
    expect(validateServerUrl('   ')).toEqual({ ok: true, value: '' });
  });

  it('rejects scheme-less, partial, credential and query URLs', () => {
    for (const bad of ['192.168.1.100:3030', 'h', 'http://user:pw@host', 'http://host/?q=1', 'ftp://host', 'http://my host']) {
      expect(validateServerUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe('validateApiKey', () => {
  it('trims and allows clearing', () => {
    expect(validateApiKey('  abc123 ')).toEqual({ ok: true, value: 'abc123' });
    expect(validateApiKey('')).toEqual({ ok: true, value: '' });
  });

  it('rejects inner whitespace', () => {
    expect(validateApiKey('abc 123').ok).toBe(false);
  });
});
