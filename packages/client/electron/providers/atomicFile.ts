import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write `data` to `file` atomically: a sibling temp file (created exclusively
 * with `mode`), fsync, rename over the target, then chmod the target so a
 * pre-existing file with looser permissions is tightened too. On failure the
 * temp file is removed and the target is left untouched.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(tmp, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(tmp, file);
    await fs.promises.chmod(file, mode).catch(() => {});
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** True for the temp files writeFileAtomic leaves behind if the process dies mid-write. */
export function isAtomicTempName(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.tmp');
}
