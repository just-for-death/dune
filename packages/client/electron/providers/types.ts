/**
 * Local (no Dune Server) provider layer for Electron main. Everything here is
 * Node-testable: Electron is imported only by ./electron.ts.
 *
 * Results follow the app's ServerResult contract: `{ ok: true, ...body }` or
 * `{ ok: false, status?, code, message }`. Provider codes (PROVIDER_*) pass
 * through from @dune/providers unchanged; local codes are listed below.
 */
import type { ProviderErrorCode } from '@dune/providers';

export type MaybePromise<T> = T | Promise<T>;

/** Codes produced by this layer (besides the PROVIDER_* codes from @dune/providers). */
export type LocalErrorCode =
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'KEY_UNREADABLE'
  | 'INVALID_KEY'
  | 'INVALID_INPUT'
  | 'UNKNOWN_PROVIDER'
  | 'KEY_STORE_ERROR';

export type LocalFailure = { ok: false; status?: number; code: LocalErrorCode | ProviderErrorCode; message: string };
export type LocalResult<T extends object = object> = ({ ok: true } & T) | LocalFailure;

export function localFailure(code: LocalFailure['code'], message: string, status?: number): LocalFailure {
  return status === undefined ? { ok: false, code, message } : { ok: false, status, code, message };
}

/**
 * The subset of Electron's `safeStorage` this layer uses. Tests pass a fake;
 * ./electron.ts passes the real one.
 */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

/**
 * Local enable flags (Settings.hltbEnabled / artworkEnabled; all default off). Only `true` enables.
 * `updateCheckEnabled` gates AUTOMATIC update checks only (read it with isUpdateCheckEnabled);
 * a manual check always runs.
 */
export interface LocalProviderFlags {
  hltbEnabled?: boolean;
  artworkEnabled?: boolean;
  updateCheckEnabled?: boolean;
}

/** Read on every call, so a toggle in Settings takes effect without rebuilding the layer. */
export type LocalFlagsSource = () => MaybePromise<LocalProviderFlags>;

/** Providers that take a user API key stored locally. */
export const LOCAL_KEY_PROVIDERS = ['steamgriddb'] as const;
export type LocalKeyProvider = (typeof LOCAL_KEY_PROVIDERS)[number];

export function isLocalKeyProvider(v: unknown): v is LocalKeyProvider {
  return typeof v === 'string' && (LOCAL_KEY_PROVIDERS as readonly string[]).includes(v);
}
