import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashApiKey, looksHashed, matchStoredHash, getServerSecret } from './crypto.js';

const FIXED_SECRET = 'test-secret-0123456789abcdef-test-secret';
// Temp dir from src/test/setup.ts (DUN-005): never unset it, or the
// secret lookups below would fall back to the real data/.api-secret.
const SETUP_DATA_DIR = process.env.DATA_DIR as string;

afterEach(() => {
  delete process.env.API_KEY_SECRET;
  delete process.env.API_KEY_SALT;
  process.env.DATA_DIR = SETUP_DATA_DIR;
});

describe('hashApiKey', () => {
  it('is deterministic for the same key + secret', () => {
    expect(hashApiKey('my-key', FIXED_SECRET)).toBe(hashApiKey('my-key', FIXED_SECRET));
  });

  it('produces 64-char lowercase hex', () => {
    expect(hashApiKey('my-key', FIXED_SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs per secret and per key', () => {
    expect(hashApiKey('a', FIXED_SECRET)).not.toBe(hashApiKey('b', FIXED_SECRET));
    expect(hashApiKey('a', FIXED_SECRET)).not.toBe(hashApiKey('a', 'other-secret-0123456789abcdef-x'));
  });

  it('prefers API_KEY_SECRET env over the persisted secret file', async () => {
    process.env.API_KEY_SECRET = 'env-secret-0123456789abcdef-gh';
    const { getServerSecret } = await import('./crypto.js');
    expect(getServerSecret()).toBe('env-secret-0123456789abcdef-gh');
  });
});

describe('getServerSecret persistence', () => {
  it('generates a 0600 secret file when none is configured, then reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-secret-test-'));
    process.env.DATA_DIR = dir;
    try {
      const first = getServerSecret();
      expect(first).toMatch(/^[0-9a-f]{64}$/);

      const file = path.join(dir, '.api-secret');
      expect(fs.readFileSync(file, 'utf-8').trim()).toBe(first);
      if (process.platform !== 'win32') {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }

      // A second call reads the persisted value back instead of regenerating.
      expect(getServerSecret()).toBe(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to an ephemeral secret when the data dir cannot be created', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-secret-bad-'));
    const blocker = path.join(parent, 'not-a-dir');
    fs.writeFileSync(blocker, 'x'); // a regular file where a directory is expected
    process.env.DATA_DIR = path.join(blocker, 'data');
    try {
      // Must not throw during boot; returns a usable (if ephemeral) secret.
      expect(getServerSecret()).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('looksHashed', () => {
  it('accepts 64-char hex', () => {
    expect(looksHashed('a'.repeat(64))).toBe(true);
    expect(looksHashed(hashApiKey('x', FIXED_SECRET))).toBe(true);
  });

  it('rejects plaintext keys', () => {
    expect(looksHashed('dune-dev-key-12345')).toBe(false);
    expect(looksHashed('')).toBe(false);
    expect(looksHashed('A'.repeat(64))).toBe(false);
  });
});

describe('matchStoredHash', () => {
  const stored = [hashApiKey('good-key', FIXED_SECRET)];

  it('returns the matching stored hash for the correct raw key (hashes with server secret)', () => {
    process.env.API_KEY_SECRET = FIXED_SECRET;
    // stored hashes must have been produced with the same secret
    expect(matchStoredHash('good-key', stored)).toBe(stored[0]);
  });

  it('returns null for wrong, empty, and missing candidates', () => {
    expect(matchStoredHash('bad-key', stored)).toBeNull();
    expect(matchStoredHash('', stored)).toBeNull();
    expect(matchStoredHash(undefined, stored)).toBeNull();
    expect(matchStoredHash(null, stored)).toBeNull();
  });

  it('returns null when no keys are stored', () => {
    expect(matchStoredHash('good-key', [])).toBeNull();
  });
});
