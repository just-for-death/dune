import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir } from '../utils/path.js';
import { database } from '../db/index.js';

export interface ReadinessCheck {
  ok: boolean;
  message?: string;
}

export interface Readiness {
  ready: boolean;
  checks: Record<string, ReadinessCheck>;
}

/**
 * Readiness probes: can this instance serve traffic right now?
 * Keep checks cheap and dependency-free (no network): writability of
 * the data dir (saves, DB, versions all live here) and DB readability.
 */
export function checkReadiness(): Readiness {
  const checks: Record<string, ReadinessCheck> = {};

  try {
    const dir = dataDir();
    const probe = path.join(dir, `.ready-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ready');
    fs.unlinkSync(probe);
    checks.dataDir = { ok: true };
  } catch (err) {
    checks.dataDir = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const games = database.getGames();
    checks.database = { ok: Array.isArray(games) };
    if (!Array.isArray(games)) checks.database.message = 'games table unreadable';
  } catch (err) {
    checks.database = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const ready = Object.values(checks).every(c => c.ok);
  return { ready, checks };
}
