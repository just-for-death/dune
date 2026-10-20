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

/** Append a session while keeping the offline queue bounded. */
export function enqueuePlaytimeSession(
  queue: PlaytimeSessionPayload[],
  session: PlaytimeSessionPayload,
): PlaytimeSessionPayload[] {
  return [...queue, session].slice(-MAX_PENDING_SESSIONS);
}
