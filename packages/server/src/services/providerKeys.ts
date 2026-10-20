/**
 * DUN-092: third-party provider keys (SteamGridDB) are write-only secrets.
 *
 * - Encrypted at rest: AES-256-GCM, key = HKDF-SHA256(server secret), AAD
 *   binds the ciphertext to its kv slot. Stored as kv `provider:<name>`.
 * - Never returned by any API (not even to admins) and never logged: callers
 *   outside this module only ever see `{ set: boolean }`. The plaintext is
 *   handed to the server-side provider client (`withSteamGridKey`) and nowhere else.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { getServerSecret } from '../utils/crypto.js';
import { ApiError } from '../utils/apiError.js';
import { logger } from '../middleware/logging.js';

const SLOT = 'provider:steamgriddb';
const AAD = Buffer.from('dune:provider:steamgriddb:v1');
/** SteamGridDB keys are 32 hex chars; accept any plausible token, never echo it. */
const KEY_FORMAT = /^[A-Za-z0-9._~+/=-]{16,256}$/;

interface Sealed { v: 1; iv: string; tag: string; ct: string }

function dataKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', getServerSecret(), 'dune-provider-keys', 'steamgriddb:v1', 32));
}

function seal(plain: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey(), iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plain, 'utf-8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function open(s: Sealed): string {
  const d = createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(s.iv, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf-8');
}

function readSlot(): string | undefined {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(SLOT) as { value: string } | undefined;
  return row?.value;
}

export interface ProviderKeyStatus { set: boolean }

export function steamGridKeyStatus(): ProviderKeyStatus {
  return { set: readSlot() !== undefined };
}

/** Store (replace) the key. Throws 400 INVALID_PROVIDER_KEY without echoing input. */
export function setSteamGridKey(key: unknown): ProviderKeyStatus {
  if (typeof key !== 'string' || !KEY_FORMAT.test(key.trim())) {
    throw new ApiError(400, 'INVALID_PROVIDER_KEY', 'key must be a 16-256 character API token');
  }
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SLOT, JSON.stringify(seal(key.trim())));
  logger.info({ provider: 'steamgriddb' }, 'Provider key set');
  return { set: true };
}

export function clearSteamGridKey(): ProviderKeyStatus {
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(SLOT);
  logger.info({ provider: 'steamgriddb' }, 'Provider key cleared');
  return { set: false };
}

/** Internal only: the decrypted key, or null if unset/undecryptable (secret rotated). */
function getSteamGridKey(): string | null {
  const raw = readSlot();
  if (raw === undefined) return null;
  try {
    return open(JSON.parse(raw) as Sealed);
  } catch {
    logger.warn({ provider: 'steamgriddb' }, 'Provider key could not be decrypted (server secret changed?); set it again');
    return null;
  }
}

/** Run `fn` with the key; throws 400 PROVIDER_KEY_NOT_SET when absent. */
export async function withSteamGridKey<T>(fn: (key: string) => Promise<T>): Promise<T> {
  const key = getSteamGridKey();
  if (!key) throw new ApiError(400, 'PROVIDER_KEY_NOT_SET', 'SteamGridDB API key not configured');
  return fn(key);
}
