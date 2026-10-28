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

  describe('offline queue (DUN-084: coalesce, never drop)', () => {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const mk = (game: string, startMs: number, minutes: number, platform = 'linux'): PlaytimeSessionPayload => ({
      game,
      platform,
      sessionStart: new Date(startMs).toISOString(),
      sessionEnd: new Date(startMs + minutes * 60_000).toISOString(),
      durationMinutes: minutes,
      source: 'local',
    });
    const minutesOf = (q: PlaytimeSessionPayload[], game?: string) =>
      q.filter((s) => !game || s.game === game).reduce((sum, s) => sum + s.durationMinutes, 0);
    const spanMinutes = (q: PlaytimeSessionPayload[], game?: string) =>
      q.filter((s) => !game || s.game === game).reduce((sum, s) => sum + (Date.parse(s.sessionEnd) - Date.parse(s.sessionStart)) / 60_000, 0);

    it('appends below the cap without touching existing entries', () => {
      const queue = [mk('Hades', start, 5)];
      const res = enqueuePlaytimeSession(queue, mk('Celeste', start + HOUR, 7));
      expect(res.queue).toHaveLength(2);
      expect(res.queue[0]).toBe(queue[0]);
      expect(res).toMatchObject({ coalesced: 0, overCap: false });
      expect(queue).toHaveLength(1);
    });

    it('at the cap merges same-game sessions per day and keeps every minute', () => {
      // 200 sessions of Hades over 4 days (50 per day, 10 min each, 12 min apart, same UTC day) + 1 Celeste.
      const queue = Array.from({ length: MAX_PENDING_SESSIONS }, (_, i) =>
        mk('Hades', start + Math.floor(i / 50) * DAY + (i % 50) * 12 * 60_000, 10));
      const res = enqueuePlaytimeSession(queue, mk('Celeste', start + 5 * DAY, 30));
      expect(res.queue.length).toBeLessThanOrEqual(MAX_PENDING_SESSIONS);
      expect(res.queue.filter((s) => s.game === 'Hades')).toHaveLength(4);
      expect(minutesOf(res.queue, 'Hades')).toBe(2000);
      expect(spanMinutes(res.queue, 'Hades')).toBe(2000);
      expect(res.queue.find((s) => s.game === 'Celeste')).toMatchObject({ durationMinutes: 30 });
      expect(res.coalesced).toBe(MAX_PENDING_SESSIONS + 1 - res.queue.length);
      expect(res.overCap).toBe(false);
      const firstDay = res.queue.find((s) => s.game === 'Hades')!;
      expect(firstDay.sessionStart).toBe(new Date(start).toISOString());
      expect(firstDay.sessionEnd).toBe(new Date(start + 500 * 60_000).toISOString());
    });

    it('merges across days into blocks of at most 24 h when per-day merging is not enough', () => {
      // One 10 h session per day for 201 days: per-day merging frees nothing.
      const queue = Array.from({ length: MAX_PENDING_SESSIONS }, (_, i) => mk('Factorio', start + i * DAY, 600));
      const res = enqueuePlaytimeSession(queue, mk('Factorio', start + MAX_PENDING_SESSIONS * DAY, 600));
      expect(res.queue.length).toBeLessThanOrEqual(MAX_PENDING_SESSIONS);
      expect(minutesOf(res.queue)).toBe(201 * 600);
      expect(spanMinutes(res.queue)).toBe(201 * 600);
      for (const s of res.queue) {
        expect(Date.parse(s.sessionEnd) - Date.parse(s.sessionStart)).toBeLessThanOrEqual(DAY);
        expect(Date.parse(s.sessionEnd)).toBeGreaterThan(Date.parse(s.sessionStart));
      }
    });

    it('never merges different games or platforms, and keeps the whole queue when it cannot shrink', () => {
      const queue = Array.from({ length: MAX_PENDING_SESSIONS }, (_, i) => mk(`Game ${i}`, start + i * HOUR, 3));
      const extra = mk('Game 0', start, 4, 'win32');
      const res = enqueuePlaytimeSession(queue, extra);
      expect(res.queue).toHaveLength(MAX_PENDING_SESSIONS + 1);
      expect(res).toMatchObject({ coalesced: 0, overCap: true });
      expect(res.queue).toContain(extra);
      expect(minutesOf(res.queue)).toBe(MAX_PENDING_SESSIONS * 3 + 4);
    });

    it('does not coalesce while a flush is in flight (coalesce: false), but still drops nothing', () => {
      const queue = Array.from({ length: MAX_PENDING_SESSIONS }, (_, i) => mk('Hades', start + i * 20 * 60_000, 10));
      const res = enqueuePlaytimeSession(queue, mk('Hades', start + DAY, 10), { coalesce: false });
      expect(res.queue).toHaveLength(MAX_PENDING_SESSIONS + 1);
      expect(res.queue.slice(0, MAX_PENDING_SESSIONS)).toEqual(queue);
      expect(res).toMatchObject({ coalesced: 0, overCap: true });
    });
  });
});
