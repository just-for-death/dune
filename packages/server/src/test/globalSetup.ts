/**
 * Vitest globalSetup (runs once per run, in the main process). Leak guard:
 * a test must never write relative to cwd (= packages/server). Snapshot the
 * package's top-level entries before the run and fail the run if any NEW
 * entry appears. Pre-existing entries are reported only, never touched.
 * `coverage/` is the coverage reporter's own output (gitignored), not a test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWED_NEW = new Set(['coverage']);

export function topLevelEntries(root = PACKAGE_ROOT): string[] {
  return fs.readdirSync(root).sort();
}

/** New top-level entries in `after` that weren't in `before` (minus allowed tool output). */
export function newEntries(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((e) => !seen.has(e) && !ALLOWED_NEW.has(e));
}

export default function setup(): () => void {
  const before = topLevelEntries();
  return () => {
    const leaked = newEntries(before, topLevelEntries());
    if (leaked.length > 0) {
      throw new Error(
        `Test run leaked new top-level entries into ${PACKAGE_ROOT}: ${leaked.join(', ')}. ` +
          'Tests must write only under an fs.mkdtempSync(os.tmpdir()) dir.',
      );
    }
  };
}
