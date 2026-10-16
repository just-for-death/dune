import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { validateServerUrl, validateGamePath, normalizeUrl } from './utils/path.js';
import { extractApiKey } from './utils/authKey.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-security-test-'));
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'security-test-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const VALID_KEY = 'test-security-valid-key-12345';
database.addApiKey(VALID_KEY, 'Security test key');

afterAll(() => {
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Security: SSRF Prevention', () => {
  it('rejects cloud metadata IP 169.254.169.254', () => {
    const res = validateServerUrl('http://169.254.169.254/latest/meta-data/');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/cloud metadata/i);
    expect(() => normalizeUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/cloud metadata/i);
  });

  it('rejects Google Cloud metadata endpoint', () => {
    const res = validateServerUrl('http://metadata.google.internal/computeMetadata/v1/');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/cloud metadata/i);
  });

  it('rejects Alibaba Cloud metadata endpoint', () => {
    const res = validateServerUrl('http://100.100.100.200/latest/meta-data/');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/cloud metadata/i);
  });

  it('rejects IPv4 link-local addresses (169.254.0.0/16)', () => {
    const res = validateServerUrl('http://169.254.10.20:8080');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/link-local/i);
  });

  it('rejects IPv6 link-local and unique local addresses', () => {
    const res1 = validateServerUrl('http://[fe80::1]:8080');
    expect(res1.valid).toBe(false);
    expect(res1.error).toMatch(/link-local/i);

    const res2 = validateServerUrl('http://[fd00::1234]:8080');
    expect(res2.valid).toBe(false);
    expect(res2.error).toMatch(/link-local/i);
  });

  it('rejects non-HTTP protocols (e.g. ftp, file, javascript)', () => {
    expect(validateServerUrl('ftp://example.com/test').valid).toBe(false);
    expect(validateServerUrl('file:///etc/passwd').valid).toBe(false);
    expect(validateServerUrl('javascript:alert(1)').valid).toBe(false);
  });

  it('rejects dangerous ports (e.g. SSH 22, SMTP 25, SMB 445)', () => {
    expect(validateServerUrl('http://example.com:22').valid).toBe(false);
    expect(validateServerUrl('http://example.com:25').valid).toBe(false);
    expect(validateServerUrl('http://example.com:445').valid).toBe(false);
  });

  it('accepts safe HTTP and HTTPS URLs', () => {
    const safe1 = validateServerUrl('https://example.com/api');
    expect(safe1.valid).toBe(true);
    expect(safe1.url).toBe('https://example.com/api');

    const safe2 = validateServerUrl('http://127.0.0.1:3000');
    expect(safe2.valid).toBe(true);
    expect(safe2.url).toBe('http://127.0.0.1:3000');
  });
});

describe('Security: Path Traversal Prevention', () => {
  it('rejects directory traversal in validateGamePath', () => {
    expect(() => validateGamePath('TestGame', 'subdir/../../../../etc/passwd')).toThrow(/path traversal/i);
  });

  it('rejects non-numeric versionId in download-version-file', async () => {
    const res = await request(app)
      .get('/api/download-version-file?game=TestGame&versionId=../sneaky&path=save.dat')
      .set('x-api-key', VALID_KEY);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid versionId/i);
  });

  it('rejects path traversal in filePath parameter', async () => {
    const res = await request(app)
      .get('/api/download-file?game=TestGame&path=subdir/../../../../etc/passwd')
      .set('x-api-key', VALID_KEY);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid path/i);
  });
});

describe('Security: Authentication & Key Extraction', () => {
  it('extracts API key from x-api-key header', () => {
    const key = extractApiKey({ 'x-api-key': 'my-secret-key' });
    expect(key).toBe('my-secret-key');
  });

  it('extracts API key from query parameter ?api_key=', () => {
    const key = extractApiKey({}, '/api/saves?api_key=query-key-123');
    expect(key).toBe('query-key-123');
  });

  it('prioritizes x-api-key header over query param', () => {
    const key = extractApiKey({ 'x-api-key': 'header-key' }, '/api/saves?api_key=query-key');
    expect(key).toBe('header-key');
  });

  it('blocks unauthenticated requests to protected endpoints with 401', async () => {
    const res = await request(app).get('/api/saves');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/API key required/i);
  });

  it('blocks requests with invalid API keys with 403', async () => {
    const res = await request(app)
      .get('/api/saves')
      .set('x-api-key', 'invalid-key-999');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Invalid API key/i);
  });

  it('allows access with valid API key in header', async () => {
    const res = await request(app)
      .get('/api/saves')
      .set('x-api-key', VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows access with valid API key in query param', async () => {
    const res = await request(app)
      .get(`/api/saves?api_key=${VALID_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
