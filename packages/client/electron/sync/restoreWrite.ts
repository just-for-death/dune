import * as nodePath from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { resolveRestoreTarget, type RestoreTargetDeps } from './restoreTarget';

// DUN-060: the restore write loop, extracted from main.ts so it can be tested
// end to end with a fake server file list. Every server path is validated
// (resolveRestoreTarget) before any download, mkdir or write, and again right
// before the write because the download is async. Writes are atomic: temp
// file in the target directory, then rename.

export interface RestoreRejection {
  path: string;
  reason: string;
}

export interface RestoreWriteOptions<F extends { path: string }> {
  /** Fetch the file's bytes from the server. Errors propagate (abort restore). */
  download: (file: F) => Promise<Uint8Array | ArrayBuffer>;
  /** Called once per rejected path. */
  onReject?: (rejection: RestoreRejection) => void;
  /** Parallel downloads per batch (main.ts used 5). */
  chunkSize?: number;
  deps?: RestoreTargetDeps;
}

export interface RestoreWriteResult {
  written: string[];
  rejected: RestoreRejection[];
}

/**
 * Atomically write `data` to `target`: write + fsync a uniquely named temp
 * file in the same directory (O_EXCL, so it never follows a pre-planted
 * link), then rename over the target. The temp file is removed on failure.
 */
export function writeFileAtomic(target: string, data: Uint8Array): void {
  const dir = nodePath.dirname(target);
  const tmp = nodePath.join(
    dir,
    `.${nodePath.basename(target)}.dune-restore-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o644);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already failing */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Download and write `files` under `restoreRoot`. Rejected paths are skipped
 * (nothing downloaded or written) and returned in `rejected`; download or
 * write errors propagate, as they did before the extraction.
 */
export async function writeRestoreFiles<F extends { path: string }>(
  restoreRoot: string,
  files: readonly F[],
  opts: RestoreWriteOptions<F>,
): Promise<RestoreWriteResult> {
  const chunkSize = Math.max(1, opts.chunkSize ?? 5);
  const written: string[] = [];
  const rejected: RestoreRejection[] = [];
  const rejectFile = (path: string, reason: string) => {
    const r = { path: String(path), reason };
    rejected.push(r);
    opts.onReject?.(r);
  };

  for (let j = 0; j < files.length; j += chunkSize) {
    const chunk = files.slice(j, j + chunkSize);
    await Promise.all(chunk.map(async (file) => {
      const pre = resolveRestoreTarget(restoreRoot, file.path, opts.deps);
      if (!pre.ok) {
        rejectFile(file.path, pre.reason);
        return;
      }
      const data = await opts.download(file);
      // Re-validate after the async download: the tree may have changed.
      const res = resolveRestoreTarget(restoreRoot, file.path, opts.deps);
      if (!res.ok) {
        rejectFile(file.path, res.reason);
        return;
      }
      // mkdir only after validation.
      fs.mkdirSync(nodePath.dirname(res.target), { recursive: true });
      writeFileAtomic(res.target, data instanceof Uint8Array ? data : new Uint8Array(data));
      written.push(res.target);
    }));
  }
  return { written, rejected };
}
