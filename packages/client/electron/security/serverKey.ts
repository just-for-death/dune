import type { ServerKeyStatus } from '@dune/shared';

/**
 * The Dune Server API key (x-api-key), kept in the OS keychain via Electron
 * safeStorage. Plaintext is never written to disk; without a keychain it is
 * held in memory for this session only.
 *
 * DUN-073: the plaintext key never goes back to the renderer. `status()`
 * returns `{ set }` (keys are write-only), plus `unreadable: true` when a
 * stored key exists but can't be decrypted (keychain changed or locked); that
 * case is logged once instead of silently acting as "no key".
 */
export interface KeyStore {
  get(key: string, defaultValue?: unknown): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

export interface ServerKeyDeps {
  store: KeyStore;
  safeStorage: SafeStorageLike;
  warn: (message: string) => void;
}

export const LEGACY_KEY = 'serverApiKey';
export const ENC_KEY = 'serverApiKeyEnc';

export interface ServerKeyVault {
  /** The key for x-api-key ('' when none or unreadable). Main only. */
  load(): string;
  save(key: string): void;
  status(): ServerKeyStatus;
}

export function createServerKeyVault(deps: ServerKeyDeps): ServerKeyVault {
  let sessionKey = '';
  let warnedUnreadable = false;

  const read = (): { key: string; unreadable: boolean } => {
    if (sessionKey) return { key: sessionKey, unreadable: false };
    const enc = deps.store.get(ENC_KEY, '');
    if (typeof enc === 'string' && enc) {
      try {
        if (!deps.safeStorage.isEncryptionAvailable()) throw new Error('OS keychain unavailable');
        const key = deps.safeStorage.decryptString(Buffer.from(enc, 'base64')).toString();
        return { key, unreadable: false };
      } catch (err) {
        if (!warnedUnreadable) {
          warnedUnreadable = true;
          deps.warn(`[Security] The stored Dune Server API key could not be decrypted (${err instanceof Error ? err.message : String(err)}). Enter the key again.`);
        }
        return { key: '', unreadable: true };
      }
    }
    // A legacy plaintext key: move it into the keychain (or memory) and purge it from disk.
    const legacy = deps.store.get(LEGACY_KEY, '');
    if (typeof legacy === 'string' && legacy) {
      deps.store.delete(LEGACY_KEY);
      save(legacy);
      return read();
    }
    return { key: '', unreadable: false };
  };

  const save = (key: string): void => {
    const clean = (typeof key === 'string' ? key : '').trim();
    deps.store.delete(LEGACY_KEY);
    warnedUnreadable = false;
    if (!clean) {
      sessionKey = '';
      deps.store.delete(ENC_KEY);
      return;
    }
    if (deps.safeStorage.isEncryptionAvailable()) {
      try {
        deps.store.set(ENC_KEY, deps.safeStorage.encryptString(clean).toString('base64'));
        sessionKey = '';
        return;
      } catch (err) {
        deps.warn(`[Security] Failed to encrypt the API key with the OS keychain: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    deps.warn('[Security] OS keychain unavailable. The server API key is held in memory for this session only, never written to disk.');
    deps.store.delete(ENC_KEY);
    sessionKey = clean;
  };

  return {
    load: () => read().key,
    save,
    status: () => {
      const r = read();
      return r.unreadable ? { set: false, unreadable: true } : { set: r.key !== '' };
    },
  };
}
