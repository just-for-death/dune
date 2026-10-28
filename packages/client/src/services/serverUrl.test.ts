import { describe, expect, it } from 'vitest';
import { checkServerUrl, type ServerUrlErrorCode } from '@dune/shared';
import { createTranslator, defaultTranslator } from '../i18n';
import { en } from '../i18n/en';
import { es } from '../i18n/es';
import { serverUrlMessage, type ServerUrlFailure } from './serverUrl';

// The rules themselves are covered by packages/shared/src/serverUrl.test.ts;
// this file only checks the renderer wording for each shared error code.
const CODES: ServerUrlErrorCode[] = [
  'empty', 'scheme', 'needScheme', 'needHost', 'credentials', 'query',
  'invalid', 'port', 'incompleteHost', 'fullIp', 'blocked', 'portBlocked',
];

const msg = (input: string, t = defaultTranslator) => {
  const r = checkServerUrl(input);
  return r.ok ? '' : serverUrlMessage(t, r);
};

describe('serverUrlMessage', () => {
  it.each(CODES)('has en and es text for %s', code => {
    const key = `serverUrl.${code}` as const;
    expect(en[key]).toBeTruthy();
    expect(es[key]).toBeTruthy();
    const failure: ServerUrlFailure = { ok: false, code, port: '22' };
    for (const t of [createTranslator('en'), createTranslator('es')]) {
      const text = serverUrlMessage(t, failure);
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/[{}]/);
    }
  });

  it('fills {example} and {port}', () => {
    expect(msg('localhost:3030')).toBe(`Start the address with http:// or https:// (${en['serverUrl.example']}).`);
    expect(msg('http://example.com:22')).toBe('Port 22 is not allowed.');
    expect(msg('http://example.com:22', createTranslator('es'))).toBe('El puerto 22 no está permitido.');
  });

  it('explains the most common mistakes', () => {
    expect(msg('192.168.1.100:3030')).toMatch(/Start the address with http:\/\/ or https:\/\//);
    expect(msg('h')).toMatch(/Start the address with/);
    expect(msg('ftp://x.org')).toMatch(/Only http/);
    expect(msg('http://user:pw@host')).toMatch(/user name or password/);
    expect(msg('http://host/?q=1')).toMatch(/query/);
    expect(msg('http://10.1')).toMatch(/full IP address/);
    expect(msg('')).toBe('Enter the server address.');
  });
});
