/**
 * Pure helpers for turning a launched process lifetime into a playtime session.
 * Keeping the clock and rounding rules here makes them unit-testable without
 * spawning real games.
 */

export interface PlaytimeSessionPayload {
  game: string;
  platform: string;
  sessionStart: string;
  sessionEnd: string;
  durationMinutes: number;
  source: 'local';
}

export const MIN_SESSION_MINUTES = 1;
export const MAX_PENDING_SESSIONS = 200;

/**
 * Build a playtime payload for a process that ran from `startedAt` to
 * `endedAt`. Returns null for sessions shorter than the server's one-minute
 * minimum so we never queue rows the server will reject.
 */
export function buildPlaytimeSession(
  game: string,
  startedAt: number,
  endedAt: number,
  platform: string = process.platform,
): PlaytimeSessionPayload | null {
  if (!game || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  const durationMinutes = Math.round((endedAt - startedAt) / 60000);
  if (durationMinutes < MIN_SESSION_MINUTES) return null;

  return {
    game,
    platform,
    sessionStart: new Date(startedAt).toISOString(),
    sessionEnd: new Date(endedAt).toISOString(),
    durationMinutes,
    source: 'local',
  };
}

/** The server rejects a session longer than a day (server PLAYTIME_LIMITS). */
export const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

export interface EnqueueResult {
  queue: PlaytimeSessionPayload[];
  /** How many queued entries were merged away (their minutes are kept). */
  coalesced: number;
  /** True when the queue is still above MAX_PENDING_SESSIONS after coalescing. */
  overCap: boolean;
}

function spanMs(session: PlaytimeSessionPayload): number {
  const ms = Date.parse(session.sessionEnd) - Date.parse(session.sessionStart);
  return Number.isFinite(ms) && ms > 0 ? ms : session.durationMinutes * 60000;
}

/**
 * Merge entries that share a key into back-to-back blocks of at most a day.
 * The server derives minutes from sessionEnd - sessionStart, so a merged entry
 * starts at its earliest session and lasts exactly the summed play time;
 * nothing is rounded away and no merged entry is too long for the server.
 * An entry that is not merged with anything is returned unchanged.
 */
function coalesceBy(
  queue: PlaytimeSessionPayload[],
  keyOf: (session: PlaytimeSessionPayload) => string,
): PlaytimeSessionPayload[] {
  const groups = new Map<string, PlaytimeSessionPayload[]>();
  for (const session of queue) {
    const key = keyOf(session);
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
  }

  const out: PlaytimeSessionPayload[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => Date.parse(a.sessionStart) - Date.parse(b.sessionStart));
    let block: PlaytimeSessionPayload[] = [];
    let blockMs = 0;
    const flush = () => {
      if (block.length === 1) {
        out.push(block[0]);
      } else if (block.length > 1) {
        const start = Date.parse(block[0].sessionStart);
        out.push({
          game: block[0].game,
          platform: block[0].platform,
          sessionStart: new Date(start).toISOString(),
          sessionEnd: new Date(start + blockMs).toISOString(),
          durationMinutes: block.reduce((sum, s) => sum + s.durationMinutes, 0),
          source: 'local',
        });
      }
      block = [];
      blockMs = 0;
    };
    for (const session of sorted) {
      const ms = spanMs(session);
      if (block.length > 0 && blockMs + ms > MAX_SESSION_MS) flush();
      block.push(session);
      blockMs += ms;
    }
    flush();
  }
  return out.sort((a, b) => Date.parse(a.sessionStart) - Date.parse(b.sessionStart));
}

/**
 * DUN-084: append a session to the offline queue without ever dropping play
 * time. Below MAX_PENDING_SESSIONS this is a plain append. Above it, sessions
 * of the same game and platform are coalesced, first per UTC day (keeps the
 * daily charts right), then across days if that is still not enough. If the
 * queue is still over the cap (more distinct games than slots) it is kept
 * whole and `overCap` is set so the caller can log it.
 *
 * Pass `coalesce: false` while a flush is in flight: the flush removes the
 * entries it sent by key, so merging them meanwhile would send minutes twice.
 */
export function enqueuePlaytimeSession(
  queue: PlaytimeSessionPayload[],
  session: PlaytimeSessionPayload,
  options: { coalesce?: boolean } = {},
): EnqueueResult {
  const next = [...queue, session];
  if (next.length <= MAX_PENDING_SESSIONS || options.coalesce === false) {
    return { queue: next, coalesced: 0, overCap: next.length > MAX_PENDING_SESSIONS };
  }
  const gameKey = (s: PlaytimeSessionPayload) => `${s.game}\u0000${s.platform}`;
  let merged = coalesceBy(next, (s) => `${gameKey(s)}\u0000${s.sessionStart.slice(0, 10)}`);
  if (merged.length > MAX_PENDING_SESSIONS) merged = coalesceBy(merged, gameKey);
  return {
    queue: merged,
    coalesced: next.length - merged.length,
    overCap: merged.length > MAX_PENDING_SESSIONS,
  };
}
