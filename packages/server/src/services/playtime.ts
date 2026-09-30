import * as fs from 'fs';
import * as path from 'path';
import { writeDB } from '../db/index.js';

const PLAYTIME_DB = path.join(process.cwd(), 'data', 'playtime.json');

export interface PlaytimeSession {
  id: number;
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
  if (!fs.existsSync(PLAYTIME_DB)) return [];
  try {
    return JSON.parse(fs.readFileSync(PLAYTIME_DB, 'utf-8'));
  } catch {
    return [];
  }
}

function writePlaytimeDB(sessions: PlaytimeSession[]): void {
  const tmpPath = PLAYTIME_DB + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmpPath, PLAYTIME_DB);
}

export function recordPlaytimeSession(
  game: string,
  platform: string,
  sessionStart: string,
  sessionEnd: string
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
      id: Date.now(),
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

export function getPlaytimeSummary(game?: string): PlaytimeSummary[] {
  try {
    const sessions = readPlaytimeDB();
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

export function getRecentSessions(limit = 50): PlaytimeSession[] {
  try {
    const sessions = readPlaytimeDB();
    return sessions
      .sort((a, b) => new Date(b.sessionStart).getTime() - new Date(a.sessionStart).getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function getTotalPlaytime(): number {
  try {
    const sessions = readPlaytimeDB();
    return sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
  } catch {
    return 0;
  }
}
