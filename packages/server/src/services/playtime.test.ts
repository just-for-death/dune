import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { recordPlaytimeSession, getPlaytimeSummary, getRecentSessions, getTotalPlaytime } from './playtime.js';

const PLAYTIME_DB = path.join(process.cwd(), 'data', 'playtime.json');

beforeEach(() => {
  if (fs.existsSync(PLAYTIME_DB)) fs.rmSync(PLAYTIME_DB);
});

afterEach(() => {
  if (fs.existsSync(PLAYTIME_DB)) fs.rmSync(PLAYTIME_DB);
});

describe('recordPlaytimeSession', () => {
  it('should record a valid session', () => {
    const result = recordPlaytimeSession('Test Game', 'Steam', '2024-01-01T10:00:00.000Z', '2024-01-01T12:00:00.000Z');
    expect(result.success).toBe(true);
  });

  it('should reject invalid date format', () => {
    const result = recordPlaytimeSession('Test Game', 'Steam', 'invalid', '2024-01-01T12:00:00.000Z');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid date');
  });

  it('should reject end before start', () => {
    const result = recordPlaytimeSession('Test Game', 'Steam', '2024-01-01T12:00:00.000Z', '2024-01-01T10:00:00.000Z');
    expect(result.success).toBe(false);
    expect(result.message).toContain('end must be after start');
  });

  it('should reject session too short (< 1 minute after rounding)', () => {
    // 30 seconds rounds to 0 minutes with Math.round, but the check is < 1
    // Actually Math.round(30000/60000) = Math.round(0.5) = 1
    // So we need < 30 seconds to round to 0
    const result = recordPlaytimeSession('Test Game', 'Steam', '2024-01-01T10:00:00.000Z', '2024-01-01T10:00:20.000Z');
    expect(result.success).toBe(false);
    expect(result.message).toContain('too short');
  });

  it('should record multiple sessions for same game', () => {
    recordPlaytimeSession('Test Game', 'Steam', '2024-01-01T10:00:00.000Z', '2024-01-01T11:00:00.000Z');
    recordPlaytimeSession('Test Game', 'Steam', '2024-01-02T10:00:00.000Z', '2024-01-02T11:30:00.000Z');
    
    const summary = getPlaytimeSummary('Test Game');
    expect(summary.length).toBe(1);
    expect(summary[0].totalMinutes).toBe(150); // 60 + 90
    expect(summary[0].totalSessions).toBe(2);
  });

  it('should track different platforms separately', () => {
    recordPlaytimeSession('Test Game', 'Steam', '2024-01-01T10:00:00.000Z', '2024-01-01T11:00:00.000Z');
    recordPlaytimeSession('Test Game', 'Epic', '2024-01-01T12:00:00.000Z', '2024-01-01T13:00:00.000Z');
    
    const summary = getPlaytimeSummary('Test Game');
    expect(summary.length).toBe(2);
    const steam = summary.find(s => s.platform === 'Steam');
    const epic = summary.find(s => s.platform === 'Epic');
    expect(steam?.totalMinutes).toBe(60);
    expect(epic?.totalMinutes).toBe(60);
  });
});

describe('getPlaytimeSummary', () => {
  it('should return empty array for unknown game', () => {
    const summary = getPlaytimeSummary('Unknown Game');
    expect(summary).toEqual([]);
  });

  it('should return all games when no filter', () => {
    recordPlaytimeSession('Game A', 'Steam', '2024-01-01T10:00:00.000Z', '2024-01-01T11:00:00.000Z');
    recordPlaytimeSession('Game B', 'Steam', '2024-01-01T12:00:00.000Z', '2024-01-01T13:00:00.000Z');
    
    const summary = getPlaytimeSummary();
    expect(summary.length).toBe(2);
  });

  it('should sort by total minutes descending', () => {
    recordPlaytimeSession('Short Game', 'Steam', '2024-01-01T10:00:00.000Z', '2024-01-01T10:30:00.000Z');
    recordPlaytimeSession('Long Game', 'Steam', '2024-01-01T12:00:00.000Z', '2024-01-01T14:00:00.000Z');
    
    const summary = getPlaytimeSummary();
    expect(summary[0].game).toBe('Long Game');
    expect(summary[1].game).toBe('Short Game');
  });
});

describe('getRecentSessions', () => {
  it('should return recent sessions sorted by start time descending', () => {
    recordPlaytimeSession('Game A', 'Steam', '2024-01-01T10:00:00.000Z', '2024-01-01T11:00:00.000Z');
    recordPlaytimeSession('Game B', 'Steam', '2024-01-02T10:00:00.000Z', '2024-01-02T11:00:00.000Z');
    recordPlaytimeSession('Game C', 'Steam', '2024-01-03T10:00:00.000Z', '2024-01-03T11:00:00.000Z');
    
    const sessions = getRecentSessions(2);
    expect(sessions.length).toBe(2);
    expect(sessions[0].game).toBe('Game C');
    expect(sessions[1].game).toBe('Game B');
  });

  it('should respect limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      recordPlaytimeSession(`Game ${i}`, 'Steam', `2024-01-${String(i+1).padStart(2,'0')}T10:00:00.000Z`, `2024-01-${String(i+1).padStart(2,'0')}T11:00:00.000Z`);
    }
    
    const sessions = getRecentSessions(3);
    expect(sessions.length).toBe(3);
  });
});

describe('getTotalPlaytime', () => {
  it('should return 0 for empty database', () => {
    expect(getTotalPlaytime()).toBe(0);
  });

  it('should sum all session minutes', () => {
    recordPlaytimeSession('Game A', 'Steam', '2024-01-01T10:00:00.000Z', '2024-01-01T11:00:00.000Z'); // 60
    recordPlaytimeSession('Game B', 'Steam', '2024-01-01T12:00:00.000Z', '2024-01-01T13:30:00.000Z'); // 90
    expect(getTotalPlaytime()).toBe(150);
  });
});
