/**
 * Vitest setupFiles entry (DUN-005): runs in every worker before each test
 * file. Guarantees each test file has a private temp DATA_DIR so nothing can
 * fall back to the real <package>/data folder (dune.sqlite, .api-secret,
 * .bootstrap-key). utils/path.ts additionally throws under Vitest if
 * DATA_DIR is unset or resolves to the real folder.
 */
import { afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const created = process.env.DATA_DIR ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'dune-test-'));
if (created) process.env.DATA_DIR = created;

afterAll(() => {
  if (!created) return;
  fs.rmSync(created, { recursive: true, force: true });
  // Leave nothing pointing at the removed dir; a stray late call then hits
  // the path.ts guard (throws) instead of silently using ./data.
  if (process.env.DATA_DIR === created) delete process.env.DATA_DIR;
});
