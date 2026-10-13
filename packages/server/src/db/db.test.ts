import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate ALL filesystem side effects (DB, secret) to a temp dir.
// Must precede the dynamic import below (static imports hoist).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-db-test-'));
process.env.API_KEY_SECRET = 'db-test-secret-0123456789abcdef';

const { database, writeDB, withDbLock } = await import('../db/index.js');

const TMP = process.env.DATA_DIR as string;

function mkGame(name: string) {
  const ts = new Date().toISOString();
  return {
    id: Date.now() + Math.random(),
    name,
    winPath: '',
    linPath: '',
    lastSync: ts,
    status: 'In Sync' as const,
    thumbnail: '',
    createdAt: ts,
    updatedAt: ts,
  };
}

afterAll(() => {
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('concurrent writes', () => {
  it('50 parallel locked read-modify-writes lose nothing', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withDbLock(() => {
          const games = database.getGames();
          games.push(mkGame(`LockGame ${i}`));
          writeDB({ games, settings: database.getSettings() });
        }),
      ),
    );

    const games = database.getGames();
    expect(games.filter(g => g.name.startsWith('LockGame '))).toHaveLength(50);

    // File on disk is valid JSON with all entries
    const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'dune.json'), 'utf-8'));
    expect(raw.games.filter((g: { name: string }) => g.name.startsWith('LockGame '))).toHaveLength(50);
  });

  it('withDbLock propagates errors but keeps the lock usable', async () => {
    await expect(withDbLock(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const v = await withDbLock(() => 42);
    expect(v).toBe(42);
  });
});

describe('corrupt database recovery', () => {
  it('preserves the corrupt file and boots with defaults', () => {
    const dbPath = path.join(TMP, 'dune.json');
    fs.writeFileSync(dbPath, '{not valid json{{{');

    const games = database.getGames();
    expect(games).toEqual([]);

    const entries = fs.readdirSync(TMP);
    const backups = entries.filter(e => /^dune\.json\.corrupt-\d+$/.test(e));
    expect(backups).toHaveLength(1);
    // Original garbage untouched for forensics
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('{not valid json{{{');
    // Backup holds the same garbage
    expect(fs.readFileSync(path.join(TMP, backups[0]), 'utf-8')).toBe('{not valid json{{{');
  });
});
