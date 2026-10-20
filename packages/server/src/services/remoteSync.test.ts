import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('axios');
import axios from 'axios';

// DUN-009: route the shared app logger to an in-memory sink, built with the
// real createLogger (same serializers + redaction as production).
const captured = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../middleware/logging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/logging.js')>();
  const { Writable } = await import('node:stream');
  const sink = new Writable({
    write(chunk, _enc, cb) {
      captured.lines.push(chunk.toString());
      cb();
    },
  });
  return { ...actual, logger: actual.createLogger(sink) };
});

// Isolate side effects BEFORE importing app modules (static imports hoist).
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-remote-test-'));
process.env.API_KEY_SECRET = 'remote-test-secret-0123456789abcdef';

const postMock = vi.mocked(axios.post);
const { triggerRemoteSync } = await import('./remoteSync.js');
const { database } = await import('../db/index.js');
const { getGameRoot } = await import('../utils/path.js');

const TMP = process.env.DATA_DIR as string;
const OWNER = database.createUser(`remote-test-${Date.now()}`, 'member').id;
const GAME = database.ensureGame(OWNER, 'Remote Game');
const REF = { id: GAME.id, name: GAME.name };

// Drain the uploaded stream like the real axios would: the mock rejects
// immediately, and an unconsumed fs.ReadStream would later error when
// the tmp dir is cleaned up (unhandled rejection noise).
async function drain(data?: unknown): Promise<void> {
  const stream = data as { resume?: () => void; on?: (ev: string, cb: () => void) => void } | undefined;
  await new Promise<void>(resolve => {
    if (!stream || typeof stream.resume !== 'function') return resolve();
    stream.on?.('end', resolve);
    stream.on?.('error', resolve);
    stream.on?.('close', resolve);
    stream.resume();
  });
}

beforeEach(() => {
  captured.lines.length = 0;
  postMock.mockReset();
  postMock.mockImplementation(async (_url: string, data?: unknown) => {
    await drain(data);
    throw new Error('offline');
  });
});

afterEach(() => {
  for (const srv of database.getRemoteServers()) database.removeRemoteServer(srv.id);
  const dir = getGameRoot(GAME.id, OWNER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('triggerRemoteSync', () => {
  it('does nothing when no remote servers are configured', async () => {
    await expect(triggerRemoteSync([{ id: 999, name: 'Nope' }], OWNER)).resolves.toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('zips the game and posts to each server, tolerating failures', async () => {
    const root = getGameRoot(GAME.id, OWNER);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'slot1.sav'), 'data');
    database.addRemoteServer('http://backup-a:3030');
    database.addRemoteServer('http://backup-b:3030');
    // Note: the beforeEach mock drains each stream then rejects 'offline'.

    await triggerRemoteSync([REF], OWNER);

    expect(postMock).toHaveBeenCalledTimes(2);
    const urls = postMock.mock.calls.map(c => c[0]);
    expect(urls).toEqual(['http://backup-a:3030/api/upload-file', 'http://backup-b:3030/api/upload-file']);
    // Temp sync zip cleaned up
    expect(fs.existsSync(path.join(root, '..', `${GAME.id}_sync.zip`))).toBe(false);
  });

  it('skips games with no local directory', async () => {
    database.addRemoteServer('http://backup-a:3030');
    await triggerRemoteSync([{ id: 998, name: 'Missing Game' }], OWNER);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('sends the shared sync key and sync id headers', async () => {
    process.env.REMOTE_SYNC_API_KEY = 'peer-shared-key';
    try {
      const root = getGameRoot(GAME.id, OWNER);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'slot1.sav'), 'data');
      database.addRemoteServer('http://backup-a:3030');

      await triggerRemoteSync([REF], OWNER);

      expect(postMock).toHaveBeenCalledTimes(1);
      const headers = postMock.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('peer-shared-key');
      // DUN-064/127: percent-encoded; the receiving server decodes once.
      expect(headers['x-game']).toBe('Remote%20Game');
      expect(decodeURIComponent(headers['x-game'])).toBe('Remote Game');
      expect(headers['x-path']).toBe('saves.zip');
      expect(headers['x-sync-id']).toMatch(/^\d+$/);
    } finally {
      delete process.env.REMOTE_SYNC_API_KEY;
    }
  });

  it('a failed push never logs REMOTE_SYNC_API_KEY (DUN-009)', async () => {
    const { randomBytes } = await import('node:crypto');
    const { AxiosError } = await vi.importActual<typeof import('axios')>('axios');
    const syncKey = `sync-key-${randomBytes(12).toString('hex')}`;
    process.env.REMOTE_SYNC_API_KEY = syncKey;
    // Reject the way real axios does: an AxiosError whose config and request
    // carry the x-api-key header (what used to be dumped into the log line).
    postMock.mockImplementation(async (url, data, config) => {
      await drain(data);
      throw new AxiosError(
        'connect ECONNREFUSED 10.0.0.9:3030',
        'ECONNREFUSED',
        { url, method: 'post', headers: { ...(config?.headers as Record<string, string>) } } as never,
        { _header: `POST /api/upload-file HTTP/1.1\r\nx-api-key: ${syncKey}\r\n` },
      );
    });
    try {
      const root = getGameRoot(GAME.id, OWNER);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'slot1.sav'), 'data');
      database.addRemoteServer('http://sync:peer-password@backup-a:3030');

      await triggerRemoteSync([REF], OWNER);

      expect(postMock).toHaveBeenCalledTimes(1);
      expect((postMock.mock.calls[0][2]?.headers as Record<string, string>)['x-api-key']).toBe(syncKey);
      const out = captured.lines.join('');
      expect(out).not.toContain(syncKey);
      expect(out).not.toContain('peer-password');
      const failure = captured.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'Remote sync push failed');
      expect(failure).toMatchObject({
        game: 'Remote Game',
        server: 'http://backup-a:3030/',
        message: 'connect ECONNREFUSED 10.0.0.9:3030',
        code: 'ECONNREFUSED',
      });
      expect(failure).not.toHaveProperty('err');
    } finally {
      delete process.env.REMOTE_SYNC_API_KEY;
    }
  });

  it('logs the HTTP status of a rejected push without the raw error', async () => {
    const { AxiosError } = await vi.importActual<typeof import('axios')>('axios');
    postMock.mockImplementation(async (_url: string, data?: unknown) => {
      await drain(data);
      throw new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 401,
      } as never);
    });
    const root = getGameRoot(GAME.id, OWNER);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'slot1.sav'), 'data');
    database.addRemoteServer('http://backup-a:3030');

    await triggerRemoteSync([REF], OWNER);

    const failure = captured.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'Remote sync push failed');
    expect(failure).toMatchObject({ status: 401, code: 'ERR_BAD_REQUEST' });
  });
});
