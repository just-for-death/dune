import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { validateServerUrl, resolveGameFile, normalizeUrl } from './utils/path.js';
import { extractApiKey } from './utils/authKey.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-security-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = TMP;
process.env.API_KEY_SECRET = 'security-test-secret-0123456789abcdef';

const { app } = await import('./server.js');
const { database } = await import('./db/index.js');

const VALID_KEY = 'test-security-valid-key-12345';
database.addApiKey(VALID_KEY, 'Security test key');

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
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
  it('rejects directory traversal in resolveGameFile', () => {
    expect(() => resolveGameFile(1, 'subdir/../../../../etc/passwd', 'usr_sec')).toThrow(expect.objectContaining({ code: 'DOT_SEGMENT' }));
  });

  it('rejects non-numeric versionId in download-version-file', async () => {
    const res = await request(app)
      .get('/api/download-version-file?game=TestGame&versionId=../sneaky&path=save.dat')
      .set('x-api-key', VALID_KEY);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid version id', code: 'INVALID_VERSION_ID' });
  });

  it('rejects path traversal in filePath parameter', async () => {
    const res = await request(app)
      .get('/api/download-file?game=TestGame&path=subdir/../../../../etc/passwd')
      .set('x-api-key', VALID_KEY);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'DOT_SEGMENT' });
    expect(Object.keys(res.body).sort()).toEqual(['code', 'error']);
  });
});

describe('Security: version-id (x-sync-id) path traversal', () => {
  const game = 'SyncIdGame';

  const upload = (syncId: string, body: string) =>
    request(app)
      .post('/api/upload-file')
      .set('Content-Type', 'application/octet-stream')
      .set('x-api-key', VALID_KEY)
      .set('x-game', game)
      .set('x-path', 'slot1.sav')
      .set('x-sync-id', syncId)
      .send(Buffer.from(body));

  it('a non-numeric x-sync-id can never write outside the saves dir', async () => {
    await upload('1', 'v1'); // create the base file so the overwrite path runs
    const res = await upload('../../../pwned', 'v2');
    expect(res.status).toBe(200);

    // versionDir = <saves>/<game>/.versions/../../../pwned  →  <DATA_DIR>/pwned
    expect(fs.existsSync(path.join(TMP, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(TMP), 'pwned'))).toBe(false);
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
    expect(res.body).toEqual({ error: 'API key required', code: 'UNAUTHORIZED' });
  });

  it('blocks requests with invalid API keys with 403', async () => {
    const res = await request(app)
      .get('/api/saves')
      .set('x-api-key', 'invalid-key-999');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Invalid API key', code: 'INVALID_API_KEY' });
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

describe('Security: CORS origin allow-list', () => {
  it('allows a known origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('denies an unknown origin without erroring or echoing it back', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://evil.example');
    // Denial is expressed by the absence of the ACAO header (not a 500).
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('honors the ALLOWED_ORIGINS env allow-list (whitespace-trimmed)', async () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com, https://ops.example.com';
    try {
      const res = await request(app).get('/health').set('Origin', 'https://ops.example.com');
      expect(res.headers['access-control-allow-origin']).toBe('https://ops.example.com');

      const denied = await request(app).get('/health').set('Origin', 'https://nope.example.com');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });
});
