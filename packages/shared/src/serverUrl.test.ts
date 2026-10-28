import { describe, expect, it } from 'vitest';
import { checkServerUrl, normalizeServerUrl, type ServerUrlErrorCode } from './serverUrl.js';

// Union of the tables in client src/services/serverUrl.test.ts and
// electron/sync/serverUrl.test.ts (DUN-045), which both copies passed.
describe('normalizeServerUrl', () => {
  it.each([
    ['http://192.168.1.100:3030', 'http://192.168.1.100:3030'],
    ['http://192.168.1.10:3030', 'http://192.168.1.10:3030'],
    ['https://dune.example.com', 'https://dune.example.com'],
    ['HTTPS://Dune.Example.COM:8443', 'https://dune.example.com:8443'],
    ['http://localhost:3030/', 'http://localhost:3030'],
    ['http://localhost:3030///', 'http://localhost:3030'],
    ['https://example.com/dune/', 'https://example.com/dune'],
    ['  http://nas.lan:3030 \n', 'http://nas.lan:3030'],
    ['http://[::1]:3030/', 'http://[::1]:3030'],
    ['https://example.com:443', 'https://example.com'],
    ['http://loc', 'http://loc'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = normalizeServerUrl(' https://example.com/dune/ ');
    expect(once).toBe('https://example.com/dune');
    expect(normalizeServerUrl(once)).toBe(once);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['non-string', undefined],
    ['object', { url: 'x' }],
    ['partial scheme h', 'h'],
    ['partial scheme http', 'http'],
    ['partial scheme http:', 'http:'],
    ['partial scheme http:/', 'http:/'],
    ['scheme only http://', 'http://'],
    ['scheme only https://', 'https://'],
    ['scheme-less host:port', 'localhost:3030'],
    ['scheme-less IP', '192.168.1.100:3030'],
    ['ftp scheme', 'ftp://example.com'],
    ['ftp: opaque', 'ftp:'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['file scheme', 'file:///etc/passwd'],
    ['credentials user:pass', 'http://user:pass@example.com'],
    ['credentials user:pw@host', 'http://user:pw@host'],
    ['credentials user only', 'https://user@example.com'],
    ['empty credentials', 'http://@example.com'],
    ['empty port while typing', 'http://localhost:'],
    ['non-numeric port', 'http://localhost:30a'],
    ['IPv4 shorthand mid-typing', 'http://192.168.'],
    ['IPv4 shorthand', 'http://10.1'],
    ['single number host', 'http://1'],
    ['trailing dot', 'http://example.'],
    ['double dot', 'http://example..com'],
    ['query string', 'http://example.com?x=1'],
    ['query after path', 'http://host/?q=1'],
    ['fragment', 'http://example.com/#a'],
    ['cloud metadata host', 'http://169.254.169.254'],
    ['GCE metadata subdomain', 'http://x.metadata.google.internal'],
    ['link-local IPv4', 'http://169.254.1.2'],
    ['link-local IPv6', 'http://[fe80::1]:3030'],
    ['blocked port', 'http://example.com:22'],
  ])('rejects %s', (_name, input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });
});

describe('checkServerUrl codes', () => {
  const code = (v: unknown): ServerUrlErrorCode | 'ok' => {
    const r = checkServerUrl(v);
    return r.ok ? 'ok' : r.code;
  };

  it.each<[unknown, ServerUrlErrorCode]>([
    ['', 'empty'],
    [null, 'empty'],
    ['192.168.1.100:3030', 'needScheme'],
    ['h', 'needScheme'],
    ['http:/', 'needScheme'],
    ['ftp://x.org', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['http://', 'needHost'],
    ['http://user:pw@host', 'credentials'],
    ['http://host/?q=1', 'query'],
    ['http://localhost:', 'port'],
    ['http://example.', 'incompleteHost'],
    ['http://10.1', 'fullIp'],
    ['http://169.254.169.254', 'blocked'],
    ['http://[fd00::1]', 'blocked'],
  ])('%j -> %s', (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it('reports the blocked port', () => {
    expect(checkServerUrl('http://example.com:22')).toEqual({ ok: false, code: 'portBlocked', port: '22' });
  });

  it('returns the normalised url on success', () => {
    expect(checkServerUrl(' http://NAS:3030/ ')).toEqual({ ok: true, url: 'http://nas:3030' });
  });
});
