import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('axios');
import axios from 'axios';

// Isolate side effects BEFORE importing app modules (static imports hoist).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-remote-test-'));
process.env.API_KEY_SECRET = 'remote-test-secret-0123456789abcdef';

const postMock = vi.mocked(axios.post);
const { triggerRemoteSync } = await import('./remoteSync.js');
const { database } = await import('../db/index.js');
const { getGameRoot } = await import('../utils/path.js');

const TMP = process.env.DATA_DIR as string;

beforeEach(() => {
  postMock.mockReset();
  // Drain the uploaded stream like the real axios would: the mock rejects
  // immediately, and an unconsumed fs.ReadStream would later error when
  // the tmp dir is cleaned up (unhandled rejection noise).
  postMock.mockImplementation(async (_url: string, data?: unknown) => {
    const stream = data as { resume?: () => void; on?: (ev: string, cb: () => void) => void } | undefined;
    await new Promise<void>(resolve => {
      if (!stream || typeof stream.resume !== 'function') return resolve();
      stream.on?.('end', resolve);
      stream.on?.('error', resolve);
      stream.on?.('close', resolve);
      stream.resume();
    });
    throw new Error('offline');
  });
});

afterEach(() => {
  for (const srv of database.getRemoteServers()) database.removeRemoteServer(srv.id);
  const dir = getGameRoot('Remote Game');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('triggerRemoteSync', () => {
  it('does nothing when no remote servers are configured', async () => {
    await expect(triggerRemoteSync(['Nope'])).resolves.toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('zips the game and posts to each server, tolerating failures', async () => {
    const root = getGameRoot('Remote Game');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'slot1.sav'), 'data');
    database.addRemoteServer('http://backup-a:3030');
    database.addRemoteServer('http://backup-b:3030');
    // Note: the beforeEach mock drains each stream then rejects 'offline'.

    await triggerRemoteSync(['Remote Game']);

    expect(postMock).toHaveBeenCalledTimes(2);
    const urls = postMock.mock.calls.map(c => c[0]);
    expect(urls).toEqual(['http://backup-a:3030/api/upload-file', 'http://backup-b:3030/api/upload-file']);
    // Temp sync zip cleaned up
    expect(fs.existsSync(path.join(root, '..', 'Remote Game_sync.zip'))).toBe(false);
  });

  it('skips games with no local directory', async () => {
    database.addRemoteServer('http://backup-a:3030');
    await triggerRemoteSync(['Missing Game']);
    expect(postMock).not.toHaveBeenCalled();
  });
});
