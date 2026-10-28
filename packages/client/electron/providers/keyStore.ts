import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KeySource } from '@dune/providers';
import { writeFileAtomic } from './atomicFile';
import { isLocalKeyProvider, localFailure, type LocalKeyProvider, type LocalResult, type SecretCrypto } from './types';

/**
 * Provider API keys for local mode (e.g. the SteamGridDB key), encrypted with
 * Electron safeStorage and kept in `<userData>/provider-keys.json` (mode 0600,
 * atomic writes). File shape: `{ version: 1, keys: { [provider]: base64 } }`.
 *
 * - Plaintext is never written: without safeStorage encryption `setKey`
 *   refuses with SECURE_STORAGE_UNAVAILABLE (no plaintext or memory fallback).
 * - Keys are write-only: status calls answer `{ set }` (+ `unreadable` when a
 *   stored key can't be decrypted). Only `keySource()` (main process, passed
 *   straight to @dune/providers) ever sees the plaintext.
 * - No message, log or error from here contains a key or ciphertext.
 */
export const KEY_FILE_NAME = 'provider-keys.json';
export const MAX_KEY_LENGTH = 512;

export interface LocalKeyStoreOptions {
  userDataDir: string;
  crypto: SecretCrypto;
  /** Optional, message-only warnings (never given key material). */
  warn?: (message: string) => void;
}

export type KeyStatus = { set: boolean; unreadable?: true };

export interface LocalKeyStore {
  setKey(provider: unknown, key: unknown): Promise<LocalResult<{ set: true }>>;
  clearKey(provider: unknown): Promise<LocalResult<{ set: false }>>;
  getKeyStatus(provider: unknown): Promise<LocalResult<KeyStatus>>;
  /** Main-only KeySource for @dune/providers: the plaintext key or null. */
  keySource(provider: LocalKeyProvider): KeySource;
}

interface KeyFile { version: 1; keys: Partial<Record<LocalKeyProvider, string>> }

type Loaded = { file: KeyFile; corrupt: boolean };

const KEY_RE = /^[\x21-\x7e]+$/;

export function createLocalKeyStore(opts: LocalKeyStoreOptions): LocalKeyStore {
  const file = path.join(opts.userDataDir, KEY_FILE_NAME);
  const warn = opts.warn ?? (() => {});
  let chain: Promise<unknown> = Promise.resolve();

  /** Serialise read-modify-write so concurrent set/clear calls can't lose an update. */
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const load = async (): Promise<Loaded> => {
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { file: { version: 1, keys: {} }, corrupt: false };
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && (parsed as KeyFile).version === 1) {
        const keys = (parsed as KeyFile).keys;
        if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
          const clean: KeyFile['keys'] = {};
          for (const [k, v] of Object.entries(keys)) if (isLocalKeyProvider(k) && typeof v === 'string' && v) clean[k] = v;
          return { file: { version: 1, keys: clean }, corrupt: false };
        }
      }
    } catch { /* fall through */ }
    return { file: { version: 1, keys: {} }, corrupt: true };
  };

  const save = (data: KeyFile): Promise<void> => writeFileAtomic(file, `${JSON.stringify(data)}\n`, 0o600);

  const decrypt = (enc: string): string | null => {
    try {
      if (!opts.crypto.isEncryptionAvailable()) return null;
      const plain = opts.crypto.decryptString(Buffer.from(enc, 'base64'));
      return typeof plain === 'string' && plain.length > 0 ? plain : null;
    } catch {
      return null;
    }
  };

  const storeError = (what: string) => localFailure('KEY_STORE_ERROR', `Could not ${what} the provider key file`);

  return {
    setKey: (provider, key) => exclusive(async () => {
      if (!isLocalKeyProvider(provider)) return localFailure('UNKNOWN_PROVIDER', 'Unknown provider');
      const clean = typeof key === 'string' ? key.trim() : '';
      if (!clean || clean.length > MAX_KEY_LENGTH || !KEY_RE.test(clean)) return localFailure('INVALID_KEY', 'The API key is empty or malformed');
      let enc: Buffer;
      try {
        if (!opts.crypto.isEncryptionAvailable()) throw new Error('unavailable');
        enc = opts.crypto.encryptString(clean);
        if (!Buffer.isBuffer(enc) || enc.length === 0) throw new Error('empty');
      } catch {
        warn(`[Providers] OS secure storage is unavailable; the ${provider} key was not saved.`);
        return localFailure('SECURE_STORAGE_UNAVAILABLE', 'Secure storage (OS keychain) is unavailable, so the key was not saved');
      }
      try {
        const { file: data } = await load().catch(() => ({ file: { version: 1, keys: {} } as KeyFile }));
        data.keys[provider] = enc.toString('base64');
        await save(data);
      } catch {
        return storeError('write');
      }
      return { ok: true, set: true };
    }),

    clearKey: (provider) => exclusive(async () => {
      if (!isLocalKeyProvider(provider)) return localFailure('UNKNOWN_PROVIDER', 'Unknown provider');
      try {
        const { file: data, corrupt } = await load();
        if (!(provider in data.keys) && !corrupt) return { ok: true, set: false };
        delete data.keys[provider];
        await save(data);
      } catch {
        return storeError('update');
      }
      return { ok: true, set: false };
    }),

    getKeyStatus: async (provider) => {
      if (!isLocalKeyProvider(provider)) return localFailure('UNKNOWN_PROVIDER', 'Unknown provider');
      let loaded: Loaded;
      try {
        loaded = await load();
      } catch {
        return storeError('read');
      }
      const enc = loaded.file.keys[provider];
      if (!enc) return loaded.corrupt ? { ok: true, set: false, unreadable: true } : { ok: true, set: false };
      return decrypt(enc) === null ? { ok: true, set: false, unreadable: true } : { ok: true, set: true };
    },

    keySource: (provider) => async () => {
      try {
        const enc = (await load()).file.keys[provider];
        return enc ? decrypt(enc) : null;
      } catch {
        return null;
      }
    },
  };
}
