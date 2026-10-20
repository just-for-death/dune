import { describe, expect, it } from 'vitest';
import { checkServerUrl, normalizeServerUrl } from './serverUrl';

// Table replayed from electron/sync/serverUrl.test.ts so the renderer mirror
// accepts/rejects exactly what the main process does.
describe('normalizeServerUrl (renderer mirror)', () => {
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
    expect(normalizeServerUrl(once)).toBe(once);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['non-string', undefined],
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
    ['query string', 'http://example.com?x=1'],
    ['query after path', 'http://host/?q=1'],
    ['fragment', 'http://example.com/#a'],
    ['cloud metadata host', 'http://169.254.169.254'],
    ['link-local IPv4', 'http://169.254.1.2'],
    ['blocked port', 'http://example.com:22'],
  ])('rejects %s', (_name, input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });
});

describe('checkServerUrl messages', () => {
  it('explains the most common mistakes', () => {
    const msg = (v: string) => { const r = checkServerUrl(v); return r.ok ? '' : r.error; };
    expect(msg('192.168.1.100:3030')).toMatch(/Start the address with http:\/\/ or https:\/\//);
    expect(msg('h')).toMatch(/Start the address with/);
    expect(msg('ftp://x.org')).toMatch(/Only http/);
    expect(msg('http://user:pw@host')).toMatch(/user name or password/);
    expect(msg('http://host/?q=1')).toMatch(/query/);
    expect(msg('http://10.1')).toMatch(/full IP address/);
  });
});
