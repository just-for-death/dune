/**
 * Serializes async read-modify-write sections within this process.
 * Sync fs calls are already atomic, but any `await` between a read and
 * its write opens a lost-update window (e.g. two concurrent uploads
 * updating game status). Wrap such sections in withDbLock.
 *
 * NOTE: single-instance only. Two server processes sharing one DATA_DIR
 * still need external coordination — see docs/DEPLOYMENT.md.
 */
let tail: Promise<void> = Promise.resolve();

export function withDbLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
