import { describe, it, expect, afterEach } from 'vitest';
import { hashApiKey, looksHashed, isValidApiKey } from './crypto.js';

const FIXED_SECRET = 'test-secret-0123456789abcdef-test-secret';

afterEach(() => {
  delete process.env.API_KEY_SECRET;
  delete process.env.API_KEY_SALT;
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

describe('isValidApiKey', () => {
  const stored = [hashApiKey('good-key', FIXED_SECRET)];

  it('accepts the correct raw key (hashes internally with server secret)', () => {
    process.env.API_KEY_SECRET = FIXED_SECRET;
    // stored hashes must have been produced with the same secret
    expect(isValidApiKey('good-key', stored)).toBe(true);
  });

  it('rejects wrong, empty, and missing candidates', () => {
    expect(isValidApiKey('bad-key', stored)).toBe(false);
    expect(isValidApiKey('', stored)).toBe(false);
    expect(isValidApiKey(undefined, stored)).toBe(false);
    expect(isValidApiKey(null, stored)).toBe(false);
  });

  it('rejects when no keys are stored', () => {
    expect(isValidApiKey('good-key', [])).toBe(false);
  });
});
