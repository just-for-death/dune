import { describe, it, expect } from 'vitest';
import {
  buildPlaytimeSession,
  enqueuePlaytimeSession,
  MAX_PENDING_SESSIONS,
  type PlaytimeSessionPayload,
} from './session.js';

const start = Date.parse('2026-01-01T10:00:00.000Z');

describe('playtime session helpers', () => {
  it('builds a session payload with rounded minutes', () => {
    const session = buildPlaytimeSession('Hades', start, start + 125_000, 'linux');
    expect(session).toEqual({
      game: 'Hades',
      platform: 'linux',
      sessionStart: '2026-01-01T10:00:00.000Z',
      sessionEnd: '2026-01-01T10:02:05.000Z',
      durationMinutes: 2,
      source: 'local',
    });
  });

  it('drops sessions below the server minimum', () => {
    expect(buildPlaytimeSession('Hades', start, start + 29_000)).toBeNull();
  });

  it('rejects invalid game names and timestamps', () => {
    expect(buildPlaytimeSession('', start, start + 120_000)).toBeNull();
    expect(buildPlaytimeSession('Hades', Number.NaN, start + 120_000)).toBeNull();
  });

  it('keeps the offline queue bounded', () => {
    const session: PlaytimeSessionPayload = {
      game: 'Hades',
      platform: 'linux',
      sessionStart: new Date(start).toISOString(),
      sessionEnd: new Date(start + 120_000).toISOString(),
      durationMinutes: 2,
      source: 'local',
    };
    const queue = Array.from({ length: MAX_PENDING_SESSIONS }, () => session);
    const next = enqueuePlaytimeSession(queue, { ...session, game: 'Hades 2' });
    expect(next).toHaveLength(MAX_PENDING_SESSIONS);
    expect(next[next.length - 1].game).toBe('Hades 2');
    expect(next[0]).toBe(queue[1]);
  });
});
