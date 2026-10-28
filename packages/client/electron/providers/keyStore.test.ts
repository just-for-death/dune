import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLocalKeyStore, KEY_FILE_NAME } from './keyStore';
import { fakeCrypto, tempDir } from './testHelpers';

const KEY = 'sgdb-SECRET-0123456789abcdef';
let dir: string;
beforeEach(async () => { dir = await tempDir(); });
afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });
const file = () => path.join(dir, KEY_FILE_NAME);

describe('local key store (safeStorage)', () => {
  it('encrypts, stores 0600, and only reports { set }', async () => {
    const ks = createLocalKeyStore({ userDataDir: dir, crypto: fakeCrypto() });
    expect(await ks.setKey('steamgriddb', `  ${KEY}  `)).toEqual({ ok: true, set: true });
    const raw = await fs.promises.readFile(file(), 'utf8');
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw)).toMatchObject({ version: 1, keys: { steamgriddb: expect.any(String) } });
    expect((await fs.promises.stat(file())).mode & 0o777).toBe(0o600);
    expect(await ks.getKeyStatus('steamgriddb')).toEqual({ ok: true, set: true });
    expect(await ks.keySource('steamgriddb')()).toBe(KEY);
    expect((await fs.promises.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to store without secure storage and never falls back to plaintext', async () => {
    const warns: string[] = [];
    for (const crypto of [fakeCrypto({ available: false }), fakeCrypto({ encryptThrows: true })]) {
      const ks = createLocalKeyStore({ userDataDir: dir, crypto, warn: (m) => warns.push(m) });
      const res = await ks.setKey('steamgriddb', KEY);
      expect(res).toMatchObject({ ok: false, code: 'SECURE_STORAGE_UNAVAILABLE' });
      expect(JSON.stringify(res)).not.toContain(KEY);
      expect(fs.existsSync(file())).toBe(false);
      expect(await ks.getKeyStatus('steamgriddb')).toEqual({ ok: true, set: false });
      expect(await ks.keySource('steamgriddb')()).toBeNull();
    }
    expect(warns.join('\n')).not.toContain(KEY);
  });

  it('clears a key', async () => {
    const ks = createLocalKeyStore({ userDataDir: dir, crypto: fakeCrypto() });
    await ks.setKey('steamgriddb', KEY);
    expect(await ks.clearKey('steamgriddb')).toEqual({ ok: true, set: false });
    expect(await ks.getKeyStatus('steamgriddb')).toEqual({ ok: true, set: false });
    expect(await ks.keySource('steamgriddb')()).toBeNull();
    expect(await fs.promises.readFile(file(), 'utf8')).not.toContain('steamgriddb');
  });

  it('rejects bad input without echoing it', async () => {
    const ks = createLocalKeyStore({ userDataDir: dir, crypto: fakeCrypto() });
    for (const bad of ['', '   ', 'has space', 'x'.repeat(513), 'line\nbreak', 42, null]) {
      const r = await ks.setKey('steamgriddb', bad);
      expect(r).toMatchObject({ ok: false, code: 'INVALID_KEY' });
    }
    expect(await ks.setKey('../etc', KEY)).toMatchObject({ ok: false, code: 'UNKNOWN_PROVIDER' });
    expect(await ks.getKeyStatus('__proto__')).toMatchObject({ ok: false, code: 'UNKNOWN_PROVIDER' });
    expect(await ks.clearKey('nope')).toMatchObject({ ok: false, code: 'UNKNOWN_PROVIDER' });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('reports unreadable for an undecryptable key or a corrupt file, and recovers on set', async () => {
    const ks = createLocalKeyStore({ userDataDir: dir, crypto: fakeCrypto() });
    await ks.setKey('steamgriddb', KEY);
    const broken = createLocalKeyStore({ userDataDir: dir, crypto: fakeCrypto({ decryptThrows: true }) });
    expect(await broken.getKeyStatus('steamgriddb')).toEqual({ ok: true, set: false, unreadable: true });
    expect(await broken.keySource('steamgriddb')()).toBeNull();

    await fs.promises.writeFile(file(), '{not json', { mode: 0o644 });
    expect(await ks.getKeyStatus('steamgriddb')).toEqual({ ok: true, set: false, unreadable: true });
    expect(await ks.keySource('steamgriddb')()).toBeNull();
    expect(await ks.setKey('steamgriddb', KEY)).toEqual({ ok: true, set: true });
    expect(await ks.keySource('steamgriddb')()).toBe(KEY);
    expect((await fs.promises.stat(file())).mode & 0o777).toBe(0o600);
  });

  it('serialises concurrent writes (last call wins)', async () => {
    const ks = createLocalKeyStore({ userDataDir: dir, crypto: fakeCrypto() });
    await Promise.all([ks.setKey('steamgriddb', 'a1'), ks.clearKey('steamgriddb'), ks.setKey('steamgriddb', 'b2')]);
    expect(await ks.keySource('steamgriddb')()).toBe('b2');
  });

  it('reports a write failure without key material', async () => {
    await fs.promises.mkdir(file()); // the key file path is a directory -> rename fails
    const ks = createLocalKeyStore({ userDataDir: dir, crypto: fakeCrypto() });
    const r = await ks.setKey('steamgriddb', KEY);
    expect(r).toMatchObject({ ok: false, code: 'KEY_STORE_ERROR' });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
