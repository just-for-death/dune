import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SECRET_PATH = path.join(process.cwd(), 'data', '.api-secret');

/**
 * Server secret used to HMAC API keys. Prefers explicit env config,
 * otherwise a persisted random secret (0600) so hashes survive restarts
 * but are never stored alongside the keys in plaintext.
 */
export function getServerSecret(): string {
  const fromEnv = process.env.API_KEY_SECRET || process.env.API_KEY_SALT;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  try {
    if (fs.existsSync(SECRET_PATH)) {
      const saved = fs.readFileSync(SECRET_PATH, 'utf-8').trim();
      if (saved.length >= 32) return saved;
    }
    const dir = path.dirname(SECRET_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const generated = randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_PATH, generated, { mode: 0o600 });
    return generated;
  } catch {
    // Last resort (ephemeral): hashes won't survive restart, fail closed by re-login.
    // Logged by caller; never throws during boot.
    return randomBytes(32).toString('hex');
  }
}

export function hashApiKey(rawKey: string, secret: string = getServerSecret()): string {
  return createHmac('sha256', secret).update(rawKey, 'utf-8').digest('hex');
}

/** Stored values are always 64-char lowercase hex after migration. */
export function looksHashed(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Compare a raw candidate key against stored hashes in constant time. */
export function isValidApiKey(candidate: string | undefined | null, storedHashes: string[]): boolean {
  if (!candidate || storedHashes.length === 0) return false;
  const candidateHash = hashApiKey(candidate);
  return storedHashes.some(h => safeEqualHex(candidateHash, h));
}
