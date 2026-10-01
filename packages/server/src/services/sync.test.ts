import { describe, it, expect, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleUploadFile } from './sync.js';
import { getGameRoot } from '../utils/path.js';

const GAME_A = 'UploadLimitSizeGame';
const GAME_B = 'UploadLimitCountGame';

const OLD_MAX_MB = process.env.MAX_UPLOAD_MB;
const OLD_MAX_FILES = process.env.MAX_FILES_PER_GAME;

afterEach(() => {
  if (OLD_MAX_MB === undefined) delete process.env.MAX_UPLOAD_MB;
  else process.env.MAX_UPLOAD_MB = OLD_MAX_MB;
  if (OLD_MAX_FILES === undefined) delete process.env.MAX_FILES_PER_GAME;
  else process.env.MAX_FILES_PER_GAME = OLD_MAX_FILES;
  for (const g of [GAME_A, GAME_B]) {
    const dir = getGameRoot(g);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function streamOf(bytes: number): Readable {
  return Readable.from([Buffer.alloc(bytes, 'x')]);
}

describe('handleUploadFile limits', () => {
  it('rejects files exceeding MAX_UPLOAD_MB with 413 and no partial file', async () => {
    process.env.MAX_UPLOAD_MB = '1'; // 1 MB cap
    const res = await handleUploadFile(GAME_A, 'big.sav', streamOf(2 * 1024 * 1024), 'test-sync');
    expect(res.success).toBe(false);
    expect(res.status).toBe(413);
    expect(res.message).toMatch(/exceeds/i);
    expect(fs.existsSync(path.join(getGameRoot(GAME_A), 'big.sav'))).toBe(false);
  });

  it('accepts files under the cap', async () => {
    process.env.MAX_UPLOAD_MB = '1';
    const res = await handleUploadFile(GAME_A, 'small.sav', streamOf(1024), 'test-sync');
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(getGameRoot(GAME_A), 'small.sav'))).toBe(true);
  });

  it('rejects new files when the game hits MAX_FILES_PER_GAME', async () => {
    process.env.MAX_FILES_PER_GAME = '2';
    const root = getGameRoot(GAME_B);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.sav'), 'a');
    fs.writeFileSync(path.join(root, 'b.sav'), 'b');

    const res = await handleUploadFile(GAME_B, 'c.sav', streamOf(10), 'test-sync');
    expect(res.success).toBe(false);
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(root, 'c.sav'))).toBe(false);
  });
});
