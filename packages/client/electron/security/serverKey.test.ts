import { describe, it, expect, vi } from 'vitest';
import { ENC_KEY, LEGACY_KEY, createServerKeyVault, type SafeStorageLike } from './serverKey';

function memStore(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: (k: string, d?: unknown) => (k in data ? data[k] : d),
    set: (k: string, v: unknown) => { data[k] = v; },
    delete: (k: string) => { delete data[k]; },
  };
}
// Fake keychain: "encrypts" by reversing; no OS keychain is used.
function fakeSafe(available = true, broken = false): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => {
      if (broken) throw new Error('Error while decrypting the ciphertext');
      return b.toString().replace(/^enc:/, '');
    },
  };
}

describe('server API key vault (DUN-073)', () => {
  it('status is { set } only; the key itself is never part of it', () => {
    const store = memStore();
    const vault = createServerKeyVault({ store, safeStorage: fakeSafe(), warn: vi.fn() });
    expect(vault.status()).toEqual({ set: false });
    vault.save('  dune_secret  ');
    expect(vault.status()).toEqual({ set: true });
    expect(JSON.stringify(vault.status())).not.toContain('dune_secret');
    expect(vault.load()).toBe('dune_secret');
    expect(store.data[ENC_KEY]).toBe(Buffer.from('enc:dune_secret').toString('base64'));
    vault.save('');
    expect(vault.status()).toEqual({ set: false });
    expect(store.data[ENC_KEY]).toBeUndefined();
  });

  it('a key that cannot be decrypted is reported as unreadable and warned once, not silently empty', () => {
    const store = memStore({ [ENC_KEY]: Buffer.from('garbage').toString('base64') });
    const warn = vi.fn();
    const vault = createServerKeyVault({ store, safeStorage: fakeSafe(true, true), warn });
    expect(vault.status()).toEqual({ set: false, unreadable: true });
    expect(vault.load()).toBe('');
    expect(vault.status()).toEqual({ set: false, unreadable: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/could not be decrypted/);
  });

  it('a stored key with the keychain gone is unreadable too', () => {
    const store = memStore({ [ENC_KEY]: 'abc' });
    const warn = vi.fn();
    const vault = createServerKeyVault({ store, safeStorage: fakeSafe(false), warn });
    expect(vault.status()).toEqual({ set: false, unreadable: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('without a keychain the key stays in memory only; nothing plaintext is written', () => {
    const store = memStore();
    const warn = vi.fn();
    const vault = createServerKeyVault({ store, safeStorage: fakeSafe(false), warn });
    vault.save('k1');
    expect(vault.status()).toEqual({ set: true });
    expect(Object.values(store.data).join('')).not.toContain('k1');
    expect(warn).toHaveBeenCalled();
  });

  it('a legacy plaintext key is moved into the keychain and purged', () => {
    const store = memStore({ [LEGACY_KEY]: 'old' });
    const vault = createServerKeyVault({ store, safeStorage: fakeSafe(), warn: vi.fn() });
    expect(vault.status()).toEqual({ set: true });
    expect(store.data[LEGACY_KEY]).toBeUndefined();
    expect(vault.load()).toBe('old');
  });
});
