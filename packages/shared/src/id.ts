/**
 * Collision-free numeric id for domain records (games, local sources, remote
 * servers, achievements, playtime sessions).
 *
 * `Date.now() + Math.random()` looks unique but is not: at the ~1.79e12
 * magnitude of a millisecond timestamp a double only holds ~4096 distinct
 * fractions (ULP ≈ 2.4e-4), so ids minted inside the same millisecond
 * repeatedly collided. In practice that surfaced as
 * `UNIQUE constraint failed: games.id` when several saves were claimed in one
 * tick, and as a `game:remove`/`removeLocalSource` silently deleting two
 * entries at once. A monotonic counter over the clock is exact (< 2^53) and
 * strictly increasing, so even a burst inside a single millisecond yields
 * distinct ids.
 *
 * Ids are unique per process; callers that generate ids in more than one
 * process (e.g. the Electron main and renderer realms) must not assume global
 * uniqueness across them.
 */
let lastId = 0;

export function nextId(): number {
  lastId = Math.max(Date.now(), lastId + 1);
  return lastId;
}
