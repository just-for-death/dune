import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-health-test-'));
const SETUP_DATA_DIR = process.env.DATA_DIR as string; // temp dir from src/test/setup.ts (DUN-005)
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
  process.env.DATA_DIR = SETUP_DATA_DIR; // restore the temp dir, never unset (DUN-005)
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
    // DUN-108: fixed code only; the raw error text never reaches the body.
    expect(result.checks.database).toEqual({ ok: false, code: 'DATABASE_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('db down');
  });
});
