import * as fs from 'fs';
import * as path from 'path';
import type { Game } from '@dune/shared';

/**
 * Local achievement import for Goldberg/CODEX-style installs.
 *
 * Emulators and cracked/offline builds often leave achievement state on disk
 * instead of exposing an API. This module reads only known achievement file
 * names, bounds directory walking, and merges duplicate entries by API name.
 */

export interface LocalAchievement {
  apiName: string;
  displayName: string;
  description?: string;
  unlocked: boolean;
  unlockTime: string | null;
}

const ACHIEVEMENT_FILES = new Set(['achievements.ini', 'achievements.json', 'user_stats.json']);
const SKIP_DIRS = new Set(['windows', 'winsxs', 'system32', 'syswow64', 'microsoft.net', 'node_modules', '.git']);
const MAX_DEPTH = 5;
const MAX_DIRECTORIES = 3000;

export function findAchievementFiles(roots: string[]): string[] {
  const found = new Set<string>();
  const visited = new Set<string>();
  const queue = roots
    .filter(Boolean)
    .map(root => ({ dir: root, depth: 0 }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { dir, depth } = next;
    if (visited.has(dir) || visited.size >= MAX_DIRECTORIES) continue;
    visited.add(dir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && ACHIEVEMENT_FILES.has(entry.name.toLowerCase())) {
        found.add(fullPath);
      } else if (entry.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name.toLowerCase())) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }

  return Array.from(found).sort();
}

/** Normalize common Unix-second, JS-millisecond, and ISO timestamp formats. */
export function normalizeUnlockTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{10}$/.test(trimmed)) return normalizeUnlockTime(Number(trimmed));
  if (/^\d{13}$/.test(trimmed)) return normalizeUnlockTime(Number(trimmed));

  const parsed = Date.parse(trimmed.replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function parseState(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'unlocked', 'earned', 'achieved'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'locked', 'not earned', 'not unlocked'].includes(normalized)) return false;
  }
  return null;
}

function addAchievement(
  target: Map<string, LocalAchievement>,
  entry: LocalAchievement,
): void {
  const existing = target.get(entry.apiName);
  if (!existing) {
    target.set(entry.apiName, entry);
    return;
  }

  existing.unlocked = existing.unlocked || entry.unlocked;
  existing.displayName = existing.displayName === existing.apiName && entry.displayName
    ? entry.displayName
    : existing.displayName;
  existing.description = existing.description || entry.description;
  if (!existing.unlockTime && entry.unlockTime) existing.unlockTime = entry.unlockTime;
}

export function parseAchievementIni(content: string): LocalAchievement[] {
  const achievements = new Map<string, LocalAchievement>();
  let section = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }

    if (section && !section.includes('achiev')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || ['count', 'version', 'total'].includes(key.toLowerCase())) continue;

    const state = parseState(value.split(/[,|;]/, 1)[0]);
    if (state === null) continue;

    const unlocks = value.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
    const epoch = value.match(/\b(?:1\d{9}|1\d{12})\b/);
    const unlockTime = normalizeUnlockTime(unlocks?.[0] ?? epoch?.[0]);

    addAchievement(achievements, {
      apiName: key,
      displayName: key,
      unlocked: state,
      unlockTime,
    });
  }

  return Array.from(achievements.values());
}

function collectFromJson(
  value: unknown,
  fallbackName: string,
  target: Map<string, LocalAchievement>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFromJson(item, '', target);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  const stateKeys = ['achieved', 'unlocked', 'earned', 'isUnlocked'];
  const timeKeys = ['unlockTime', 'unlocktime', 'earned_time', 'earnedTime', 'unlock_time'];
  const hasState = stateKeys.some(key => key in record);
  const hasTime = timeKeys.some(key => key in record);

  if (hasState || hasTime) {
    const apiName = [record.apiName, record.api_name, record.id, fallbackName, record.name]
      .find(candidate => typeof candidate === 'string' && candidate.trim()) as string | undefined;
    if (apiName) {
      const rawState = stateKeys
        .map(key => record[key])
        .find(candidate => candidate !== undefined);
      const unlockTime = normalizeUnlockTime(
        timeKeys.map(key => record[key]).find(candidate => candidate !== undefined),
      );
      const state = parseState(rawState) ?? Boolean(unlockTime);
      const displayName = [record.displayName, record.display_name, record.name]
        .find(candidate => typeof candidate === 'string' && candidate.trim()) as string | undefined;

      addAchievement(target, {
        apiName: apiName.trim(),
        displayName: displayName?.trim() || apiName.trim(),
        description: typeof record.description === 'string' ? record.description : undefined,
        unlocked: state,
        unlockTime,
      });
    }
    return;
  }

  for (const [key, child] of Object.entries(record)) {
    collectFromJson(child, key, target);
  }
}

export function parseAchievementJson(content: string): LocalAchievement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  const achievements = new Map<string, LocalAchievement>();
  collectFromJson(parsed, '', achievements);
  return Array.from(achievements.values());
}

export function scanLocalAchievements(roots: string[]): LocalAchievement[] {
  const achievements = new Map<string, LocalAchievement>();

  for (const file of findAchievementFiles(roots)) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const parsed = file.toLowerCase().endsWith('.ini')
      ? parseAchievementIni(content)
      : parseAchievementJson(content);
    for (const entry of parsed) addAchievement(achievements, entry);
  }

  return Array.from(achievements.values())
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Game install, executable, and Wine prefix roots worth scanning. */
export function getAchievementRoots(
  game: Pick<Game, 'linPath' | 'winPath' | 'executable' | 'winePrefix'>,
): string[] {
  const roots = new Set<string>();

  for (const candidate of [game.executable, game.linPath, game.winPath]) {
    if (!candidate) continue;
    try {
      const stat = fs.statSync(candidate);
      roots.add(stat.isDirectory() ? candidate : path.dirname(candidate));
    } catch {
      const parent = path.dirname(candidate);
      if (parent && parent !== '.') roots.add(parent);
    }
  }

  if (game.winePrefix) {
    roots.add(path.join(game.winePrefix, 'drive_c'));
  }

  return Array.from(roots).filter(root => root && root !== path.parse(root).root);
}
