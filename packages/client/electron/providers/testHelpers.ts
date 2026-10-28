/** Test-only fakes (no network, no OS keychain, temp dirs only). */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FetchLike } from '@dune/providers';
import type { SecretCrypto } from './types';

export async function tempDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'dune-local-providers-'));
}

/** Fake safeStorage: XOR + prefix, so ciphertext never equals the plaintext. */
export function fakeCrypto(opts: { available?: boolean; encryptThrows?: boolean; decryptThrows?: boolean } = {}): SecretCrypto & { decrypts: number } {
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  const c = {
    decrypts: 0,
    isEncryptionAvailable: () => opts.available !== false,
    encryptString: (plain: string) => {
      if (opts.encryptThrows) throw new Error(`boom ${plain}`);
      return Buffer.concat([Buffer.from('ENC:'), xor(Buffer.from(plain, 'utf8'))]);
    },
    decryptString: (enc: Buffer) => {
      c.decrypts++;
      if (opts.decryptThrows || !enc.subarray(0, 4).equals(Buffer.from('ENC:'))) throw new Error('cannot decrypt');
      return xor(enc.subarray(4)).toString('utf8');
    },
  };
  return c;
}

export interface FakeCall { url: string; method: string; headers: Record<string, string> }
export type Route = (url: URL, call: FakeCall) => Response | Promise<Response>;

/** A fetch that never touches the network: routes answer, everything else 599s via throw. */
export function fakeFetch(route: Route): FetchLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const f: FetchLike = async (url, init) => {
    const call: FakeCall = { url, method: init.method, headers: { ...init.headers } };
    calls.push(call);
    return route(new URL(url), call);
  };
  return Object.assign(f, { calls });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
