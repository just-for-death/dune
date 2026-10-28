// Request/response validation for the routes hardened in DUN-096/103/104
// (and the shared parse helper). Every schema here depends only on zod, so
// the file can move into @dune/shared verbatim once that package takes a zod
// dependency (DUN-038 proposal); the REST routes in server.ts import from here.
import { z } from 'zod';
import { ApiError } from './utils/apiError.js';

/**
 * Parse `value` with `schema`; on failure throw a 400 ApiError carrying
 * `code` (REST body `{ error, code }`). The message
 * names the first failing field, never echoes the rejected value.
 */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, code: string): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
  throw new ApiError(400, code, `${where}${issue?.message ?? 'Invalid input'}`);
}

// ── Playtime (DUN-096) ──────────────────────────────────────────────────────

export const PLAYTIME_LIMITS = {
  maxGameLength: 200,
  maxPlatformLength: 64,
  /** One session can't be longer than a day. */
  maxSessionMinutes: 24 * 60,
  /** Earliest accepted session start. */
  minTimestamp: Date.UTC(2000, 0, 1),
  /** Clock-skew allowance for session ends in the future. */
  futureSkewMs: 24 * 60 * 60 * 1000,
  /** Widest custom range answered with daily buckets. */
  maxCustomRangeDays: 366,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDateTime = z.iso.datetime({ offset: true });

/** POST /api/playtime. Unknown keys are dropped. */
export const playtimeSessionSchema = z.object({
  game: z.string().trim().min(1).max(PLAYTIME_LIMITS.maxGameLength),
  platform: z.string().trim().min(1).max(PLAYTIME_LIMITS.maxPlatformLength),
  sessionStart: isoDateTime,
  sessionEnd: isoDateTime,
}).superRefine((v, ctx) => {
  const start = Date.parse(v.sessionStart);
  const end = Date.parse(v.sessionEnd);
  if (start < PLAYTIME_LIMITS.minTimestamp) {
    ctx.addIssue({ code: 'custom', path: ['sessionStart'], message: 'Session start is too far in the past' });
  }
  if (end > Date.now() + PLAYTIME_LIMITS.futureSkewMs) {
    ctx.addIssue({ code: 'custom', path: ['sessionEnd'], message: 'Session end is in the future' });
  }
  const minutes = (end - start) / 60000;
  if (!(minutes >= 1)) {
    ctx.addIssue({ code: 'custom', path: ['sessionEnd'], message: 'Session must end at least one minute after it starts' });
  } else if (minutes > PLAYTIME_LIMITS.maxSessionMinutes) {
    ctx.addIssue({ code: 'custom', path: ['sessionEnd'], message: `Session is longer than ${PLAYTIME_LIMITS.maxSessionMinutes} minutes` });
  }
});
export type PlaytimeSessionInput = z.output<typeof playtimeSessionSchema>;

/** YYYY-MM-DD or a full ISO datetime, always a real calendar instant. */
const rangeDate = z.string().max(40).refine(
  (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s) : isoDateTime.safeParse(s).success,
  { message: 'Expected YYYY-MM-DD or an ISO 8601 datetime' },
);

export const GRAPH_RANGES = ['all', 'year', 'month', 'week', 'custom'] as const;
export type GraphRange = typeof GRAPH_RANGES[number];

/** Start of the UTC day for a YYYY-MM-DD or ISO value. */
export function rangeInstant(s: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s);
}

function refineCustomRange(v: { range: GraphRange; start?: string; end?: string }, ctx: z.RefinementCtx): void {
  if ((v.start === undefined) !== (v.end === undefined)) {
    ctx.addIssue({ code: 'custom', path: [v.start === undefined ? 'start' : 'end'], message: 'start and end must be given together' });
    return;
  }
  if (v.range === 'custom' && v.start === undefined) {
    ctx.addIssue({ code: 'custom', path: ['start'], message: 'A custom range needs start and end' });
    return;
  }
  if (v.start === undefined || v.end === undefined) return;
  const start = rangeInstant(v.start);
  const end = rangeInstant(v.end);
  if (end < start) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: 'end must not be before start' });
  } else if ((end - start) / DAY_MS > PLAYTIME_LIMITS.maxCustomRangeDays) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: `Custom range is longer than ${PLAYTIME_LIMITS.maxCustomRangeDays} days` });
  }
}

/** GET /api/playtime/graph query. */
export const playtimeGraphQuery = z.object({
  range: z.enum(GRAPH_RANGES).default('all'),
  start: rangeDate.optional(),
  end: rangeDate.optional(),
}).superRefine(refineCustomRange);

/** GET /api/playtime/export query. */
export const playtimeExportQuery = z.object({
  format: z.enum(['csv', 'json']).default('json'),
  range: z.enum(GRAPH_RANGES).default('all'),
  start: rangeDate.optional(),
  end: rangeDate.optional(),
}).superRefine(refineCustomRange);

/** GET /api/playtime/comparison query. */
export const playtimeComparisonQuery = z.object({
  range: z.enum(['week', 'month', 'year']).default('week'),
});

// ── Backup profiles (DUN-103) ──────────────────────────────────────────────

export const BACKUP_PROFILE_LIMITS = { maxGlobs: 100, maxGlobLength: 256, maxFileSizeMB: 100 * 1024 } as const;

const glob = z.string().trim().min(1).max(BACKUP_PROFILE_LIMITS.maxGlobLength);
export const globListSchema = z.array(glob).max(BACKUP_PROFILE_LIMITS.maxGlobs);

/**
 * POST /api/backup-profile fields other than the globs (those are parsed on
 * their own so each gets its own error code). Absent = keep the stored value.
 * `gameId`/`updatedAt` sent back by the client are ignored (server-owned).
 */
export const backupProfileOptionsSchema = z.object({
  autoExcludeCache: z.boolean().optional(),
  maxFileSizeMB: z.number().positive().max(BACKUP_PROFILE_LIMITS.maxFileSizeMB).nullable().optional(),
});

// ── Save versions (DUN-038) ─────────────────────────────────────────────────

/**
 * games.id is a REAL column: any finite positive number. Query strings are
 * coerced; zod 4 numbers already reject NaN and ±Infinity.
 */
const gameIdQuery = z.coerce.number().positive();

/** GET /api/save-versions?gameId=<number>. */
export const saveVersionsListQuery = z.object({ gameId: gameIdQuery });

/** GET /api/manifest/:gameId (FEAT-server-manifest). */
export const manifestGameParams = z.object({ gameId: gameIdQuery });

/**
 * POST /api/save-versions body: `{ gameId: number, deviceId?, changeSummary? }`.
 * deviceId / changeSummary keep their lenient handling (non-strings fall back).
 */
export const saveVersionCreateBody = z.object({
  gameId: z.number().positive(),
  deviceId: z.unknown().optional(),
  changeSummary: z.unknown().optional(),
});

/**
 * DUN-137: POST /api/restore-version body `{ gameId: number, versionId }`.
 * Only gameId is checked here (400 INVALID_GAME_ID); restoreVersion owns the
 * versionId format check (400 INVALID_VERSION_ID).
 */
export const restoreVersionBody = z.object({
  gameId: z.number().positive(),
  versionId: z.unknown().optional(),
});

// ── Store ids (FEAT-server-storeIds) ────────────────────────────────────────

/** Steam app id / GOG product id: a positive integer as a digit string, 1-12 digits, no leading zero. */
export const STORE_ID_PATTERN = /^[1-9][0-9]{0,11}$/;

const storeId = z.string().regex(STORE_ID_PATTERN, 'Expected a positive integer as a digit string (1-12 digits, no leading zero)');

/**
 * POST /api/upload-file optional headers `x-steam-app-id` / `x-gog-id`
 * (400 INVALID_STORE_ID). Absent = keep the stored value. Other headers are
 * ignored here. A repeated header arrives comma-joined and is rejected.
 */
export const storeIdHeaders = z.object({
  'x-steam-app-id': storeId.optional(),
  'x-gog-id': storeId.optional(),
}).transform((h) => ({
  ...(h['x-steam-app-id'] !== undefined ? { steamAppId: h['x-steam-app-id'] } : {}),
  ...(h['x-gog-id'] !== undefined ? { gogId: h['x-gog-id'] } : {}),
}));

/**
 * PATCH /api/games/:id body shape (FEAT-server-gamePatch): a strict object
 * with only `steamAppId` / `gogId`, at least one present. Unknown keys, `{}`
 * or a non-object -> 400 INVALID_GAME_UPDATE. Values are checked separately
 * by gamePatchIds so a bad id is 400 INVALID_STORE_ID.
 */
export const gamePatchBody = z.strictObject({
  steamAppId: z.unknown().optional(),
  gogId: z.unknown().optional(),
}).refine((b) => b.steamAppId !== undefined || b.gogId !== undefined, { message: 'Send steamAppId and/or gogId' });

/** PATCH /api/games/:id values: a STORE_ID_PATTERN digit string, or null to clear; absent = keep. */
export const gamePatchIds = z.object({
  steamAppId: storeId.nullable().optional(),
  gogId: storeId.nullable().optional(),
});
export type GamePatchIds = z.output<typeof gamePatchIds>;

/** PATCH /api/games/:id path param (same rule as other game ids). */
export const gameIdParams = z.object({ id: gameIdQuery });

// ── AI analysis (DUN-104) ───────────────────────────────────────────────────

export const AI_LIMITS = { maxFiles: 500, maxPathLength: 1024, maxDescription: 500 } as const;

export const FILE_CATEGORIES = ['Save', 'Config', 'Cache', 'Other'] as const;

/** POST /api/analyze-files-ai input. */
export const analyzeFilesSchema = z.object({
  gameName: z.string().trim().min(1).max(PLAYTIME_LIMITS.maxGameLength),
  files: z.array(z.object({
    path: z.string().min(1).max(AI_LIMITS.maxPathLength),
    size: z.number().int().nonnegative(),
    category: z.string().max(32),
  })).min(1).max(AI_LIMITS.maxFiles),
});
export type AnalyzeFilesInput = z.output<typeof analyzeFilesSchema>;

/** One entry of the model's answer; category is normalized, description clamped. */
export const aiFileAnalysisSchema = z.object({
  category: z.string().transform((c) => FILE_CATEGORIES.find((k) => k.toLowerCase() === c.trim().toLowerCase()) ?? 'Other'),
  description: z.string().transform((d) => d.trim().slice(0, AI_LIMITS.maxDescription)).default(''),
});
