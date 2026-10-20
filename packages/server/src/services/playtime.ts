import * as path from 'path';
import { dataDir } from '../utils/path.js';
import { readJsonFile, writeJsonFileAtomic } from '../db/jsonStore.js';
import { nextId } from '@dune/shared';

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

function dayKey(value: string): string {
  return value.slice(0, 10);
}

function dateOnly(value: string): Date {
  const date = new Date(value);
  if (value.length === 10) date.setHours(0, 0, 0, 0);
  return date;
}

function rangeBounds(range: 'all' | 'year' | 'month' | 'week' | 'custom', customRange: { start: string; end: string } | undefined, sessions: PlaytimeSession[]): { start: Date; end: Date } {
  const now = new Date();
  if (range === 'custom' && customRange) {
    return { start: dateOnly(customRange.start), end: dateOnly(customRange.end) };
  }
  if (range === 'week') {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { start, end: now };
  }
  if (range === 'month') {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { start, end: now };
  }
  if (range === 'year') {
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 1);
    return { start, end: now };
  }
  if (sessions.length === 0) {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { start, end: now };
  }
  const timestamps = sessions.map((session) => new Date(session.sessionStart).getTime());
  return { start: new Date(Math.min(...timestamps)), end: now };
}

function inRange(session: PlaytimeSession, start: Date, end: Date): boolean {
  const value = new Date(session.sessionStart).getTime();
  return value >= start.getTime() && value <= end.getTime();
}

function allDays(start: Date, end: Date): string[] {
  const days: string[] = [];
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);
  while (current.getTime() <= last.getTime()) {
    days.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return days;
}

export function getPlaytimeGraphData(
  range: 'all' | 'year' | 'month' | 'week' | 'custom' = 'all',
  customRange?: { start: string; end: string },
  ownerId?: string,
): { success: boolean; data: import('@dune/shared').PlaytimeGraphData; message?: string } {
  try {
    const sessions = scopeByOwner(readPlaytimeDB(), ownerId);
    const { start, end } = rangeBounds(range, customRange, sessions);
    const ranged = sessions.filter((session) => inRange(session, start, end));

    const dailyMinutes = new Map<string, number>();
    for (const session of ranged) {
      const key = dayKey(session.sessionStart);
      dailyMinutes.set(key, (dailyMinutes.get(key) || 0) + session.durationMinutes);
    }

    const days = allDays(start, end);
    const line: { date: string; minutes: number }[] = [];
    const heatmap: { date: string; minutes: number }[] = [];
    const area: { date: string; cumulativeMinutes: number }[] = [];
    let cumulative = 0;
    for (const day of days) {
      const minutes = dailyMinutes.get(day) || 0;
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
      data: { line, bar, pie, heatmap, area },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, data: { line: [], bar: [], pie: [], heatmap: [], area: [] }, message };
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
  range: 'all' | 'year' | 'month' | 'week' | 'custom' = 'all',
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
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, data: '', message };
  }
}
