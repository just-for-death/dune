import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-health-test-'));
process.env.DATA_DIR = TMP;

// Controllable stub so both the healthy and the failing DB branch are
// exercised without touching the real database module (which has import-time
// side effects).
const state = vi.hoisted(() => ({ fail: false }));
vi.mock('../db/index.js', () => ({
  database: {
    getGames: () => {
      if (state.fail) throw new Error('db down');
      return [];
    },
  },
}));

const { checkReadiness } = await import('./health.js');

afterAll(() => {
  delete process.env.DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('checkReadiness', () => {
  it('is ready when the data dir is writable and the DB reads', () => {
    state.fail = false;
    const result = checkReadiness();
    expect(result.ready).toBe(true);
    expect(result.checks.dataDir.ok).toBe(true);
    expect(result.checks.database.ok).toBe(true);
  });

  it('reports not-ready (without throwing) when the DB read fails', () => {
    state.fail = true;
    const result = checkReadiness();
    expect(result.ready).toBe(false);
    expect(result.checks.database.ok).toBe(false);
    expect(result.checks.database.message).toContain('db down');
  });
});
