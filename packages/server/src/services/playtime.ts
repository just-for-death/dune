import * as path from 'path';
import { dataDir } from '../utils/path.js';
import { readJsonFile, writeJsonFileAtomic } from '../db/jsonStore.js';
import { nextId } from '@dune/shared';
import { ApiError, isApiError } from '../utils/apiError.js';
import { PLAYTIME_LIMITS, rangeInstant, type GraphRange } from '../schemas.js';

function playtimeDbPath(): string {
  return path.join(dataDir(), 'playtime.json');
}

export interface PlaytimeSession {
  id: number;
  /** Owning user id; '' = legacy/unowned (visible only to admins). */
  ownerId: string;
  game: string;
  platform: string;
  sessionStart: string;
  sessionEnd: string;
  durationMinutes: number;
  createdAt: string;
}

export interface PlaytimeSummary {
  game: string;
  platform: string;
  totalMinutes: number;
  totalSessions: number;
  lastPlayed: string | null;
}

function readPlaytimeDB(): PlaytimeSession[] {
  return readJsonFile<PlaytimeSession[]>(playtimeDbPath(), [], 'playtime.json');
}

function writePlaytimeDB(sessions: PlaytimeSession[]): void {
  writeJsonFileAtomic(playtimeDbPath(), sessions);
}

/** `ownerId` undefined = all (admin view); otherwise that owner's rows only. */
function scopeByOwner(sessions: PlaytimeSession[], ownerId?: string): PlaytimeSession[] {
  if (ownerId === undefined) return sessions;
  return sessions.filter(s => (s.ownerId || '') === ownerId);
}

export function recordPlaytimeSession(
  game: string,
  platform: string,
  sessionStart: string,
  sessionEnd: string,
  ownerId = ''
): { success: boolean; message?: string } {
  try {
    const start = new Date(sessionStart);
    const end = new Date(sessionEnd);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { success: false, message: 'Invalid date format' };
    }
    
    if (end <= start) {
      return { success: false, message: 'Session end must be after start' };
    }
    
    const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (durationMinutes < 1) {
      return { success: false, message: 'Session too short' };
    }
    if (durationMinutes > PLAYTIME_LIMITS.maxSessionMinutes) {
      return { success: false, message: 'Session too long' };
    }

    const sessions = readPlaytimeDB();
    sessions.push({
      id: nextId(),
      ownerId,
      game,
      platform,
      sessionStart,
      sessionEnd,
      durationMinutes,
      createdAt: new Date().toISOString()
    });
    writePlaytimeDB(sessions);
    
    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message };
  }
}

export function getPlaytimeSummary(game?: string, ownerId?: string): PlaytimeSummary[] {
  try {
    const sessions = scopeByOwner(readPlaytimeDB(), ownerId);
    const filtered = game ? sessions.filter(s => s.game === game) : sessions;
    
    const grouped = new Map<string, { game: string; platform: string; minutes: number; count: number; lastPlayed: string | null }>();
    
    for (const s of filtered) {
      const key = `${s.game}|${s.platform}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.minutes += s.durationMinutes;
        existing.count += 1;
        if (!existing.lastPlayed || s.sessionEnd > existing.lastPlayed) {
          existing.lastPlayed = s.sessionEnd;
        }
      } else {
        grouped.set(key, {
          game: s.game,
          platform: s.platform,
          minutes: s.durationMinutes,
          count: 1,
          lastPlayed: s.sessionEnd
        });
      }
    }
    
    return Array.from(grouped.values())
      .map(v => ({
        game: v.game,
        platform: v.platform,
        totalMinutes: v.minutes,
        totalSessions: v.count,
        lastPlayed: v.lastPlayed
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes);
  } catch {
    return [];
  }
}

export function getRecentSessions(limit = 50, ownerId?: string): PlaytimeSession[] {
  try {
    const sessions = scopeByOwner(readPlaytimeDB(), ownerId);
    return sessions
      .sort((a, b) => new Date(b.sessionStart).getTime() - new Date(a.sessionStart).getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function getTotalPlaytime(ownerId?: string): number {
  try {
    const sessions = scopeByOwner(readPlaytimeDB(), ownerId);
    return sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
  } catch {
    return 0;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

type Range = GraphRange;

/** UTC midnight of the instant. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function invalidRange(message: string): ApiError {
  return new ApiError(400, 'INVALID_RANGE', message);
}

/**
 * DUN-096: the window a graph/export covers. A custom range must be a real
 * start <= end no wider than PLAYTIME_LIMITS.maxCustomRangeDays (400
 * INVALID_RANGE otherwise; the route validates first with the same rule).
 */
function rangeBounds(range: Range, customRange: { start: string; end: string } | undefined, sessions: PlaytimeSession[]): { start: number; end: number } {
  const now = Date.now();
  if (range === 'custom') {
    if (!customRange) throw invalidRange('A custom range needs start and end');
    const start = rangeInstant(customRange.start);
    const end = rangeInstant(customRange.end);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw invalidRange('Invalid custom range');
    if ((end - start) / DAY_MS > PLAYTIME_LIMITS.maxCustomRangeDays) {
      throw invalidRange(`Custom range is longer than ${PLAYTIME_LIMITS.maxCustomRangeDays} days`);
    }
    // A date-only end covers that whole day.
    return { start, end: /^\d{4}-\d{2}-\d{2}$/.test(customRange.end) ? end + DAY_MS - 1 : end };
  }
  if (range === 'week') return { start: now - 7 * DAY_MS, end: now };
  if (range === 'month') return { start: now - 30 * DAY_MS, end: now };
  if (range === 'year') {
    const start = new Date(now);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    return { start: start.getTime(), end: now };
  }
  const timestamps = sessions.map((session) => Date.parse(session.sessionStart)).filter((t) => !Number.isNaN(t));
  if (timestamps.length === 0) return { start: now - 30 * DAY_MS, end: now };
  return { start: Math.min(...timestamps), end: now };
}

function inRange(session: PlaytimeSession, start: number, end: number): boolean {
  const value = Date.parse(session.sessionStart);
  return value >= start && value <= end;
}

/**
 * Bucket keys from start to end: one per UTC day while the span fits the
 * daily cap, else one per UTC month ('YYYY-MM-01'), so the series stays
 * bounded (<= 366 daily points; a few hundred monthly ones) whatever the data.
 */
function buckets(start: number, end: number): { bucket: 'day' | 'month'; keys: string[]; keyOf: (iso: string) => string } {
  const first = utcDay(start);
  const last = utcDay(end);
  if ((last - first) / DAY_MS < PLAYTIME_LIMITS.maxCustomRangeDays + 1) {
    const keys: string[] = [];
    for (let t = first; t <= last; t += DAY_MS) keys.push(new Date(t).toISOString().slice(0, 10));
    return { bucket: 'day', keys, keyOf: (iso) => new Date(Date.parse(iso)).toISOString().slice(0, 10) };
  }
  const keys: string[] = [];
  const cur = new Date(first);
  cur.setUTCDate(1);
  while (cur.getTime() <= last) {
    keys.push(cur.toISOString().slice(0, 10));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return { bucket: 'month', keys, keyOf: (iso) => `${new Date(Date.parse(iso)).toISOString().slice(0, 7)}-01` };
}

export function getPlaytimeGraphData(
  range: Range = 'all',
  customRange?: { start: string; end: string },
  ownerId?: string,
): { success: boolean; data: import('@dune/shared').PlaytimeGraphData; message?: string } {
  try {
    const sessions = scopeByOwner(readPlaytimeDB(), ownerId);
    const { start, end } = rangeBounds(range, customRange, sessions);
    const ranged = sessions.filter((session) => inRange(session, start, end));

    const { bucket, keys, keyOf } = buckets(start, end);
    const perBucket = new Map<string, number>();
    for (const session of ranged) {
      const key = keyOf(session.sessionStart);
      perBucket.set(key, (perBucket.get(key) || 0) + session.durationMinutes);
    }

    const line: { date: string; minutes: number }[] = [];
    const heatmap: { date: string; minutes: number }[] = [];
    const area: { date: string; cumulativeMinutes: number }[] = [];
    let cumulative = 0;
    for (const day of keys) {
      const minutes = perBucket.get(day) || 0;
      cumulative += minutes;
      line.push({ date: day, minutes: cumulative });
      heatmap.push({ date: day, minutes });
      area.push({ date: day, cumulativeMinutes: cumulative });
    }

    const byGame = new Map<string, number>();
    for (const session of ranged) {
      byGame.set(session.game, (byGame.get(session.game) || 0) + session.durationMinutes);
    }
    const bar = Array.from(byGame.entries())
      .map(([game, minutes]) => ({ game, minutes }))
      .sort((a, b) => b.minutes - a.minutes);
    const total = bar.reduce((sum, item) => sum + item.minutes, 0);
    const pie = bar.map((item) => ({
      game: item.game,
      minutes: item.minutes,
      percentage: total > 0 ? Math.round((item.minutes / total) * 1000) / 10 : 0,
    }));

    return {
      success: true,
      data: { line, bar, pie, heatmap, area, bucket },
    };
  } catch (error: unknown) {
    if (isApiError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, data: { line: [], bar: [], pie: [], heatmap: [], area: [], bucket: 'day' }, message };
  }
}

export function getPlaytimeComparison(
  range: 'week' | 'month' | 'year',
  ownerId?: string,
): { success: boolean; comparison: import('@dune/shared').PlaytimeComparison; message?: string } {
  const emptyComparison: import('@dune/shared').PlaytimeComparison = {
    current: { period: range, totalMinutes: 0, sessions: 0 },
    previous: { period: `previous ${range}`, totalMinutes: 0, sessions: 0 },
    difference: { minutes: 0, percentage: 0, sessions: 0 },
  };
  try {
    const sessions = scopeByOwner(readPlaytimeDB(), ownerId);
    const now = new Date();
    const periodDays = range === 'week' ? 7 : range === 'month' ? 30 : 365;
    const currentStart = new Date(now);
    currentStart.setDate(currentStart.getDate() - periodDays);
    const previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - periodDays);

    const currentSessions = sessions.filter((session) => {
      const value = new Date(session.sessionStart).getTime();
      return value >= currentStart.getTime() && value <= now.getTime();
    });
    const previousSessions = sessions.filter((session) => {
      const value = new Date(session.sessionStart).getTime();
      return value >= previousStart.getTime() && value < currentStart.getTime();
    });

    const currentMinutes = currentSessions.reduce((sum, session) => sum + session.durationMinutes, 0);
    const previousMinutes = previousSessions.reduce((sum, session) => sum + session.durationMinutes, 0);
    const percentage = previousMinutes > 0
      ? Math.round(((currentMinutes - previousMinutes) / previousMinutes) * 1000) / 10
      : currentMinutes > 0 ? 100 : 0;

    return {
      success: true,
      comparison: {
        current: { period: `last ${range}`, totalMinutes: currentMinutes, sessions: currentSessions.length },
        previous: { period: `previous ${range}`, totalMinutes: previousMinutes, sessions: previousSessions.length },
        difference: { minutes: currentMinutes - previousMinutes, percentage, sessions: currentSessions.length - previousSessions.length },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, comparison: emptyComparison, message };
  }
}

export function exportPlaytimeData(
  format: 'csv' | 'json',
  range: Range = 'all',
  customRange?: { start: string; end: string },
  ownerId?: string,
): { success: boolean; data: string; message?: string } {
  try {
    const sessions = scopeByOwner(readPlaytimeDB(), ownerId);
    const { start, end } = rangeBounds(range, customRange, sessions);
    const ranged = sessions.filter((session) => inRange(session, start, end));
    if (format === 'json') {
      return { success: true, data: JSON.stringify(ranged, null, 2) };
    }

    const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const lines = ['game,platform,sessionStart,sessionEnd,durationMinutes'];
    for (const session of ranged) {
      lines.push([session.game, session.platform, session.sessionStart, session.sessionEnd, session.durationMinutes].map(escape).join(','));
    }
    return { success: true, data: lines.join('\n') };
  } catch (error: unknown) {
    if (isApiError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, data: '', message };
  }
}
