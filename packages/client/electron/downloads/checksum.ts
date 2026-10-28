import * as crypto from 'crypto';
import * as fs from 'fs';
import { DownloadError } from './errors';
import type { ChecksumAlgorithm, ChecksumSpec } from './types';

const HEX_LENGTH: Record<ChecksumAlgorithm, number> = { sha256: 64, sha1: 40, md5: 32 };

/** Validate and normalise (lowercase, trimmed) a caller-supplied checksum. */
export function normalizeChecksum(spec: unknown): ChecksumSpec {
  const s = spec as Partial<ChecksumSpec> | null;
  const algorithm = typeof s?.algorithm === 'string' ? (s.algorithm.toLowerCase() as ChecksumAlgorithm) : undefined;
  if (!algorithm || !(algorithm in HEX_LENGTH)) {
    throw new DownloadError('INVALID_CHECKSUM', 'Checksum algorithm must be sha256, sha1 or md5');
  }
  const value = typeof s?.value === 'string' ? s.value.trim().toLowerCase() : '';
  if (!new RegExp(`^[0-9a-f]{${HEX_LENGTH[algorithm]}}$`).test(value)) {
    throw new DownloadError('INVALID_CHECKSUM', `Checksum must be ${HEX_LENGTH[algorithm]} hex characters for ${algorithm}`);
  }
  return { algorithm, value };
}

/** Stream a file through the hash; honours `signal`. */
export function hashFile(file: string, algorithm: ChecksumAlgorithm, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file, signal ? { signal } : undefined);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function verifyChecksum(file: string, spec: ChecksumSpec, signal?: AbortSignal): Promise<void> {
  const actual = await hashFile(file, spec.algorithm, signal);
  if (actual !== spec.value) {
    throw new DownloadError('CHECKSUM_MISMATCH', `${spec.algorithm} mismatch: expected ${spec.value}, got ${actual}`);
  }
}
