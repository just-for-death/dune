import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir } from '../utils/path.js';
import { database } from '../db/index.js';
import { logger } from '../middleware/logging.js';

/**
 * DUN-108: /ready is unauthenticated, so a failed check carries only a fixed
 * code, never err.message (paths, SQL text). The raw error goes to the log.
 */
export interface ReadinessCheck {
  ok: boolean;
  code?: 'DATA_DIR_NOT_WRITABLE' | 'DATABASE_UNAVAILABLE';
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
    logger.warn({ err }, 'Readiness: data dir not writable');
    checks.dataDir = { ok: false, code: 'DATA_DIR_NOT_WRITABLE' };
  }

  try {
    const games = database.getGames();
    checks.database = Array.isArray(games) ? { ok: true } : { ok: false, code: 'DATABASE_UNAVAILABLE' };
  } catch (err) {
    logger.warn({ err }, 'Readiness: database unavailable');
    checks.database = { ok: false, code: 'DATABASE_UNAVAILABLE' };
  }

  const ready = Object.values(checks).every(c => c.ok);
  return { ready, checks };
}
