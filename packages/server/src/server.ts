import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { authMiddleware, optionalAuthMiddleware, requireAdmin, AuthenticatedRequest } from './middleware/auth.js';
import {
  helmetConfig, corsConfig, apiRateLimiter, uploadRateLimiter, authFailureLimiter, rejectQueryApiKey, trustProxySetting,
} from './middleware/security.js';
import {
  dataDir, getGameRoot, listFilesInDir, validateServerUrl, resolveGameFile, requireGameTitle,
  PathRuleError, ownerSavesRoot, assertStrictlyInside,
} from './utils/path.js';
import { ApiError, isApiError, apiErrorBody, gameNotFound, assertNoLaunchFields } from './utils/apiError.js';
import { validateRelativeSavePath } from '@dune/shared/pathRules';
import type { Game } from './types/index.js';
import { handleUploadFile, handleLocalSync } from './services/sync.js';
import { listSaveVersions, getSaveVersion, getVersionDiff, createVersionFromDirectory, restoreVersion } from './services/saveVersions.js';
import { listConflicts, detectConflict, resolveConflict, hasUnresolvedConflict } from './services/conflicts.js';
import { getBackupProfile, upsertBackupProfile } from './services/backupProfiles.js';
import { DEFAULT_EXCLUDE_GLOBS } from '@dune/shared';
import {
  parseInput, playtimeSessionSchema, playtimeGraphQuery, playtimeExportQuery, playtimeComparisonQuery,
  globListSchema, backupProfileOptionsSchema, analyzeFilesSchema, saveVersionsListQuery, saveVersionCreateBody, restoreVersionBody,
} from './schemas.js';
import { scanStorage, getDriveFreeBytes } from './services/storage.js';
import { manifestForGame, removeGameFile } from './services/manifest.js';
import { logger, requestLogger, type LoggedRequest } from './middleware/logging.js';
import { checkReadiness } from './services/health.js';
import { database, withDbLock } from './db/index.js';

// Runtime Node version gate: node:sqlite requires Node ≥22.
if (process.versions.node) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`Dune server requires Node.js ≥22 (found ${major}).`);
    process.exit(1);
  }
}

import { recordPlaytimeSession, getPlaytimeSummary, getRecentSessions, getTotalPlaytime, getPlaytimeGraphData, getPlaytimeComparison, exportPlaytimeData } from './services/playtime.js';
import { getAchievementSummary, getRecentUnlocks, upsertAchievements } from './services/achievements.js';
import { getAchievementDetails, getAchievementProgress } from './services/achievementDetail.js';
import { getHLTBTimes } from './services/hltb.js';
import { analyzeFilesAI, checkModelStatus, fetchModels, storedOllamaConfig } from './services/ollama.js';
import { searchArt, autoMatchAll } from './services/steamGridDB.js';
import { withSteamGridKey, steamGridKeyStatus, setSteamGridKey, clearSteamGridKey } from './services/providerKeys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// DUN-102: honor X-Forwarded-* only when TRUST_PROXY says so (default off).
app.set('trust proxy', trustProxySetting());
app.use(helmetConfig);
app.use(corsConfig);
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);
// DUN-102: API keys travel in the x-api-key header only.
app.use(rejectQueryApiKey);

// Liveness: always 200, no dependencies, no auth, no rate limit.
// Readiness: verifies this instance can serve traffic (data dir + DB).
// Both registered before the rate limiter so orchestration probes
// can never be 429-rejected under load.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/ready', (_req, res) => {
  const result = checkReadiness();
  res.status(result.ready ? 200 : 503).json(result);
});

// DUN-102: rate limits cover the API only (/api), never the static
// dashboard assets. The general limiter is skipped under Vitest (flaky 429s);
// the auth-failure guard always runs (an IP that keeps presenting bad keys
// is 429 RATE_LIMITED until its window ends).
if (!process.env.VITEST) {
  app.use('/api', apiRateLimiter);
}
app.use('/api', authFailureLimiter.guard);
app.use(optionalAuthMiddleware);

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
}

// Legacy REST endpoints for file operations (streaming)
// Skip upload rate limiting in test environment
const uploadRateLimitMiddleware = process.env.VITEST
  ? (req: express.Request, res: express.Response, next: express.NextFunction) => next()
  : uploadRateLimiter;

app.post('/api/upload-file', authMiddleware, uploadRateLimitMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    // DUN-064/127: x-game / x-path arrive encodeURIComponent'd; decoded once here.
    const game = decodeHeader(req, 'x-game');
    const filePath = decodeHeader(req, 'x-path');
    // DUN-097: one id per client sync session (digits; else 400
    // INVALID_SYNC_ID in handleUploadFile). Absent = this upload is its own session.
    const rawSyncId = req.headers['x-sync-id'];
    const syncId = (Array.isArray(rawSyncId) ? rawSyncId[0] : rawSyncId) || Date.now().toString();

    if (!game || !filePath) {
      return sendError(res, 400, 'BAD_REQUEST', 'Game and path headers required');
    }
    // DUN-086/093: validated title; the row (owner, title NOCASE) is found or
    // created and its id names the folder. DUN-087: always the caller's (or
    // an admin's explicit `owner`) namespace, never inferred from the title.
    const title = gameParam(game);
    const ownerId = targetOwnerId(req);

    // Upfront content-length guard (streaming guard in sync.ts is authoritative)
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    const maxUploadBytes =
      Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '500', 10)) * 1024 * 1024;
    if (contentLength > maxUploadBytes) {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'File exceeds upload size limit');
    }

    // DUN-091: peers mark their pushes; a relayed upload is never re-pushed.
    const relay = req.headers['x-dune-relay'] === '1';
    const result = await handleUploadFile(title, filePath, req, syncId, ownerId, { relay });
    if (!result.success && result.error) throw result.error;
    if (!result.success) {
      return sendError(res, result.status ?? 500, result.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'UPLOAD_FAILED', result.message);
    }
    res.json(result);
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/local-sync', authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const result = await handleLocalSync((_req as AuthenticatedRequest).user?.id);
    res.json(result);
  } catch (e) {
    logger.error({ reqId: (_req as LoggedRequest).reqId, err: e }, 'API internal error');
    sendError(res, 500, 'INTERNAL', 'Internal error');
  }
});

app.get('/api/download-file', authMiddleware, (req, res) => {
  try {
    const { game, path: filePath } = req.query;
    if (!game || !filePath) return sendError(res, 400, 'BAD_REQUEST', 'Game and path required');

    // DUN-111: path rules first, so a bad path is 400 even for an unknown game.
    const rel = validateRelativeSavePath(filePath.toString());
    if (!rel.ok) throw new PathRuleError(rel.code, rel.message);
    const row = requireGame(req as AuthenticatedRequest, game.toString());
    // Validated, symlink-free, strictly inside saves/<owner>/<gameId> (DUN-086).
    const fullPath = resolveGameFile(row.id, filePath.toString(), row.ownerId).abs;
    if (!fs.statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
      return sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
    }

    // Serve dotfiles too: the manifest/list endpoints include them, and express
    // 5's `send` would otherwise 404 a listed save (path is traversal-checked).
    res.download(fullPath, path.basename(fullPath), { dotfiles: 'allow' });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// ── REST API ─────────────────────────────────────────────────────────────────
// All routes below require x-api-key via authMiddleware, like the file routes above.

/**
 * DUN-064/127: the ONE place a game/path header is decoded. Clients send
 * encodeURIComponent(value) so non-ASCII titles ('DARK SOULS™ III', '大神')
 * survive HTTP headers. Decoded exactly once: '..%252F' becomes the literal
 * '..%2F', never '../'. Malformed escapes -> 400 INVALID_HEADER_ENCODING.
 * The result still goes through validateGameTitle / validateRelativeSavePath.
 */
function decodeHeader(req: express.Request, name: 'x-game' | 'x-path'): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'INVALID_HEADER_ENCODING', `Malformed percent-encoding in ${name} header`);
  }
}

/** Every REST error body is exactly `{ error, code }`. */
function sendError(res: express.Response, status: number, code: string, error: string) {
  res.status(status).json({ error, code });
}

function restError(req: express.Request, res: express.Response, e: unknown, label: string) {
  // DUN-086/093/111: a rejected title, path, id or launch field is the
  // client's fault: its status + { error, code }, never a 500.
  if (isApiError(e)) {
    res.status(e.status).json(apiErrorBody(e));
    return;
  }
  logger.error({ reqId: (req as LoggedRequest).reqId, err: e }, label);
  sendError(res, 500, 'INTERNAL', 'Internal error');
}

/** Game-title intake (DUN-086/093): shared validateGameTitle -> 400 on reject. */
function gameParam(raw: unknown): string {
  return requireGameTitle(raw);
}

/** `undefined` = all owners (admin view); otherwise scope to the caller. */
function ownerScope(req: AuthenticatedRequest): string | undefined {
  return req.user?.role === 'admin' ? undefined : req.user?.id;
}

/**
 * DUN-087/088: whose games this request addresses. Members: always their
 * own. Admins: their own unless `owner` (query or body) names another user.
 * Never inferred from a game name, so a title can't reach another user's data.
 */
function targetOwnerId(req: AuthenticatedRequest): string {
  if (!req.user) throw new ApiError(401, 'UNAUTHORIZED', 'API key required');
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const raw = req.query.owner ?? body.owner;
  if (raw === undefined || raw === '' || raw === req.user.id) return req.user.id;
  if (req.user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only admins may target another owner');
  const user = typeof raw === 'string' ? database.getUserById(raw) : undefined;
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
  return user.id;
}

/**
 * DUN-087: by-id routes (version detail/diff, conflict resolve) reach a game
 * through a child row. Members see only their own games; anything else is
 * reported exactly like a missing row.
 */
function canSeeGame(req: AuthenticatedRequest, gameId: number): boolean {
  const g = database.getGameById(gameId);
  return Boolean(g && req.user && (req.user.role === 'admin' || g.ownerId === req.user.id));
}

/** The target owner's game with this title (case-insensitive), else 404. */
function requireGame(req: AuthenticatedRequest, rawTitle: unknown): Game {
  const game = database.findGame(targetOwnerId(req), gameParam(rawTitle));
  if (!game) throw gameNotFound();
  return game;
}

/**
 * DUN-038: the target owner's game with this id (same owner logic as
 * requireGame). Missing or another owner's game -> 404 GAME_NOT_FOUND.
 */
function requireGameById(req: AuthenticatedRequest, gameId: number): Game {
  const ownerId = targetOwnerId(req);
  const game = database.getGameById(gameId);
  if (!game || game.ownerId !== ownerId) throw gameNotFound();
  return game;
}

app.get('/api/saves', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    res.json({ success: true, games: req.user ? database.getGamesForUser(req.user) : [] });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/list-files', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game } = req.query;
    if (!game) return sendError(res, 400, 'BAD_REQUEST', 'Game required');
    // Unknown in the caller's namespace -> [] (says nothing about other users).
    const row = database.findGame(targetOwnerId(req), gameParam(game.toString()));
    if (!row) return res.json({ success: true, files: [] });
    const gameDir = getGameRoot(row.id, row.ownerId); // strictly inside saves/<owner>
    if (!fs.existsSync(gameDir)) return res.json({ success: true, files: [] });
    res.json({ success: true, files: listFilesInDir(gameDir) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Delta sync: content-hash manifest for a game. Clients diff this against the
// manifest they last pulled to transfer only changed files.
app.get('/api/manifest', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game } = req.query;
    if (!game) return sendError(res, 400, 'BAD_REQUEST', 'Game required');
    const row = database.findGame(targetOwnerId(req), gameParam(game.toString()));
    res.json({ success: true, files: row ? manifestForGame(row.id, row.ownerId) : [] });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Delta sync: remove a single file (client mirrors a local deletion).
app.delete('/api/file', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game, path: filePath } = req.query;
    if (!game || !filePath) return sendError(res, 400, 'BAD_REQUEST', 'Game and path required');
    // DUN-087: only the caller's own game (or an admin's explicit `owner`);
    // another user's title is simply "not found" here.
    const rel = validateRelativeSavePath(filePath.toString());
    if (!rel.ok) throw new PathRuleError(rel.code, rel.message);
    const row = requireGame(req, game.toString());
    // DUN-086: removeGameFile validates (shared rules + no symlinks + strict
    // containment) and deletes only the validated path; a reject throws
    // PathRuleError, which restError answers with 400 { error, code }.
    const removed = removeGameFile(row.id, filePath.toString(), row.ownerId);
    if (!removed) return sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/playtime', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    // DUN-096: typed, bounded session (lengths, ISO instants, 1 min..24 h).
    const s = parseInput(playtimeSessionSchema, req.body ?? {}, 'INVALID_PLAYTIME');
    const result = recordPlaytimeSession(s.game, s.platform, s.sessionStart, s.sessionEnd, req.user?.id ?? '');
    if (!result.success) return sendError(res, 400, 'INVALID_PLAYTIME', result.message ?? 'Invalid playtime session');
    res.json(result);
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game } = req.query;
    res.json({ success: true, summary: getPlaytimeSummary(game?.toString(), ownerScope(req)) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime/recent', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit?.toString() || '50', 10) || 50));
    res.json({ success: true, sessions: getRecentSessions(limit, ownerScope(req)) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime/total', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    res.json({ success: true, totalMinutes: getTotalPlaytime(ownerScope(req)) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/achievements/import', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game, achievements } = req.body ?? {};
    if (typeof game !== 'string' || !game.trim() || !Array.isArray(achievements)) {
      return sendError(res, 400, 'BAD_REQUEST', 'game and achievements[] required');
    }

    const cleaned = achievements
      .filter((a: unknown): a is Record<string, unknown> => (
        typeof a === 'object' && a !== null && typeof (a as Record<string, unknown>).apiName === 'string'
      ))
      .slice(0, 5000)
      .map((a) => ({
        apiName: String(a.apiName).slice(0, 200),
        displayName: typeof a.displayName === 'string' && a.displayName.trim()
          ? a.displayName.slice(0, 200)
          : String(a.apiName).slice(0, 200),
        description: typeof a.description === 'string' ? a.description.slice(0, 2000) : '',
        unlocked: Boolean(a.unlocked),
        unlockTime: typeof a.unlockTime === 'string' ? a.unlockTime : null,
        rarity: typeof a.rarity === 'number' ? a.rarity : 0,
        hidden: Boolean(a.hidden),
      }));

    res.json(upsertAchievements(game.trim(), cleaned, req.user?.id ?? ''));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/achievements/recent', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit?.toString() || '20', 10) || 20));
    res.json({ success: true, unlocks: getRecentUnlocks(limit, ownerScope(req)) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/achievements/detail/:game', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const game = req.params.game.toString();
    res.json({ success: true, achievements: getAchievementDetails(game, ownerScope(req)), progress: getAchievementProgress(game, ownerScope(req)) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/achievements', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game } = req.query;
    res.json({ success: true, summary: getAchievementSummary(game?.toString(), ownerScope(req)) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/hltb/:game', authMiddleware, async (req, res) => {
  try {
    res.json(await getHLTBTimes(gameParam(req.params.game.toString())));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/analyze-files-ai', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    assertNoLaunchFields(req.body);
    // DUN-104: typed input (400 INVALID_AI_INPUT), stored endpoint only
    // (DUN-095), and only validated/clamped model output is ever stored.
    const input = parseInput(analyzeFilesSchema, req.body ?? {}, 'INVALID_AI_INPUT');
    const title = gameParam(input.gameName);
    const ownerId = targetOwnerId(req);
    const { endpoint, model } = storedOllamaConfig();
    const result = await analyzeFilesAI(endpoint, model, { ...input, gameName: title });
    if (result.success && result.analysis) {
      const row = database.findGame(ownerId, title);
      if (row) database.upsertGame({ ...row, analysis: result.analysis });
    }
    res.json(result);
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/search-art', authMiddleware, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return sendError(res, 400, 'BAD_REQUEST', 'query required');
    res.json(await withSteamGridKey((apiKey) => searchArt(apiKey, query.toString())));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// DUN-113: writes thumbnails, so POST only. Same auth as before: any user, own games only.
app.post('/api/auto-match-all', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const games = req.user ? database.getGamesForUser(req.user) : [];
    const matched = await withSteamGridKey((apiKey) => autoMatchAll(apiKey, games));
    for (const m of matched) {
      const game = games.find(g => g.name === m.name);
      if (game && !game.thumbnail) {
        game.thumbnail = m.thumbnail;
        database.upsertGame(game);
      }
    }
    res.json({ success: true, count: matched.length });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/local-sources', authMiddleware, (_req, res) => {
  try {
    res.json({ success: true, sources: database.getLocalSources() });
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

app.post('/api/local-sources', authMiddleware, requireAdmin, (req, res) => {
  try {
    const { path: sourcePath } = req.body ?? {};
    if (!sourcePath) return sendError(res, 400, 'BAD_REQUEST', 'path required');
    if (!fs.existsSync(sourcePath)) return sendError(res, 400, 'BAD_REQUEST', 'Path does not exist');
    res.json({ success: true, source: database.addLocalSource(sourcePath) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/local-sources/:id', authMiddleware, requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return sendError(res, 400, 'INVALID_ID', 'Invalid id');
    if (!database.removeLocalSource(id)) return sendError(res, 404, 'NOT_FOUND', 'Source not found');
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/remote-servers', authMiddleware, (_req, res) => {
  try {
    res.json({ success: true, servers: database.getRemoteServers() });
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

app.post('/api/remote-servers', authMiddleware, requireAdmin, (req, res) => {
  try {
    const { url } = req.body ?? {};
    if (!url) return sendError(res, 400, 'BAD_REQUEST', 'url required');
    const check = validateServerUrl(url);
    if (!check.valid) return sendError(res, 400, 'INVALID_URL', check.error ?? 'Invalid URL');
    res.json({ success: true, server: database.addRemoteServer(check.url) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/remote-servers/:id', authMiddleware, requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return sendError(res, 400, 'INVALID_ID', 'Invalid id');
    if (!database.removeRemoteServer(id)) return sendError(res, 404, 'NOT_FOUND', 'Server not found');
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Self-service key management: a user sees/rotates only their own keys.
app.get('/api/api-keys', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return sendError(res, 401, 'UNAUTHORIZED', 'API key required');
    const keys = database.listUserKeys(req.user.id).map(k => ({
      id: k.hash.slice(0, 12),
      description: k.description,
      createdAt: k.createdAt,
      masked: '****',
    }));
    res.json({ success: true, keys });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/api-keys', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return sendError(res, 401, 'UNAUTHORIZED', 'API key required');
    const { description } = req.body ?? {};
    const key = database.issueUserKey(req.user.id, typeof description === 'string' ? description : '');
    // Returned once; never retrievable again.
    res.status(201).json({ success: true, key });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/api-keys/:id', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return sendError(res, 401, 'UNAUTHORIZED', 'API key required');
    const match = database.listUserKeys(req.user.id).find(k => k.hash.slice(0, 12) === req.params.id);
    if (!match || !database.removeUserKeyByHash(match.hash)) {
      return sendError(res, 404, 'KEY_NOT_FOUND', 'Key not found');
    }
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// ── User administration (admin-only, except /api/users/me) ───────────────────
app.get('/api/users/me', authMiddleware, (req: AuthenticatedRequest, res) => {
  if (!req.user) return sendError(res, 401, 'UNAUTHORIZED', 'API key required');
  res.json({ success: true, user: { id: req.user.id, name: req.user.name, role: req.user.role } });
});

app.get('/api/users', authMiddleware, requireAdmin, (_req, res) => {
  try {
    res.json({
      success: true,
      users: database.listUsers().map(u => ({
        id: u.id,
        name: u.name,
        role: u.role,
        createdAt: u.createdAt,
        keyCount: database.countUserKeys(u.id),
      })),
    });
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

app.post('/api/users', authMiddleware, requireAdmin, (req, res) => {
  try {
    const { name, role } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'name required');
    }
    if (database.getUserByName(name)) {
      return sendError(res, 409, 'USER_EXISTS', 'User name already exists');
    }
    const user = database.createUser(name, role === 'admin' ? 'admin' : 'member');
    const apiKey = database.issueUserKey(user.id, 'Initial key');
    res.status(201).json({ success: true, user, apiKey });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/users/:id/keys', authMiddleware, requireAdmin, (req, res) => {
  try {
    if (!database.getUserById(req.params.id.toString())) {
      return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }
    const { description } = req.body ?? {};
    const apiKey = database.issueUserKey(req.params.id.toString(), typeof description === 'string' ? description : '');
    res.status(201).json({ success: true, apiKey });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/users/:id/keys/:keyId', authMiddleware, requireAdmin, (req, res) => {
  try {
    const match = database.listUserKeys(req.params.id.toString()).find(k => k.hash.slice(0, 12) === req.params.keyId.toString());
    if (!match || !database.removeUserKeyByHash(match.hash)) {
      return sendError(res, 404, 'KEY_NOT_FOUND', 'Key not found');
    }
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/users/:id', authMiddleware, requireAdmin, (req, res) => {
  try {
    const target = database.getUserById(req.params.id.toString());
    if (!target) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');
    if (target.role === 'admin' && database.countAdmins() <= 1) {
      return sendError(res, 400, 'LAST_ADMIN', 'Cannot remove the last admin');
    }
    database.deleteUser(req.params.id.toString());
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// DUN-095: admin-only and bound to the STORED endpoint; a caller-supplied
// URL is refused (no SSRF), upstream errors are never echoed.
app.get('/api/ollama-models', authMiddleware, requireAdmin, async (req, res) => {
  try {
    if (req.query.endpoint !== undefined) {
      return sendError(res, 400, 'ENDPOINT_NOT_ALLOWED', 'The Ollama endpoint comes from settings only');
    }
    const { endpoint } = storedOllamaConfig();
    res.json(await fetchModels(endpoint));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/ollama-health', authMiddleware, async (_req, res) => {
  try {
    const { endpoint, model } = storedOllamaConfig();
    res.json(await checkModelStatus(endpoint, model));
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

// ── Settings (REST shim) ─────────────────────────────────────────────────────
// The Electron client and the dashboard both depend on these, so they are
// registered with the other /api shims (above the /api 404 catch-all) and are
// available whether or not a frontend bundle is present.
app.get('/api/settings', authMiddleware, (req, res) => {
  try {
    const s = database.getSettings();
    res.json({
      success: true,
      settings: {
        maxVersions: s.maxVersions,
        ollamaEndpoint: s.ollamaEndpoint,
        ollamaModel: s.ollamaModel,
        steamGridApiKeySet: steamGridKeyStatus().set, // DUN-092: status only, never the key
        apiKeys: s.apiKeys.map(() => '****'),
        localSources: s.localSources,
        remoteServers: s.remoteServers,
      },
    });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/settings', authMiddleware, requireAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const current = database.getSettings();
    const input = req.body ?? {};
    const merged = { ...current };
    if ('maxVersions' in input) {
      if (!Number.isInteger(input.maxVersions) || input.maxVersions < 1 || input.maxVersions > 100) {
        return sendError(res, 400, 'INVALID_SETTINGS', 'maxVersions must be an integer from 1 to 100');
      }
      merged.maxVersions = input.maxVersions;
    }
    if ('steamGridApiKey' in input) {
      // DUN-092: write-only secret with its own routes; never stored in settings.
      return sendError(res, 400, 'WRITE_ONLY_FIELD', 'steamGridApiKey is set via PUT /api/provider-keys/steamgriddb');
    }
    if (typeof input.ollamaEndpoint === 'string') {
      // DUN-057: '' turns Ollama off; anything else must be a valid URL.
      if (input.ollamaEndpoint.trim() === '') {
        merged.ollamaEndpoint = '';
      } else {
        const check = validateServerUrl(input.ollamaEndpoint);
        if (!check.valid) return sendError(res, 400, 'INVALID_URL', check.error ?? 'Invalid URL');
        merged.ollamaEndpoint = check.url;
      }
    }
    if (typeof input.ollamaModel === 'string') merged.ollamaModel = input.ollamaModel;
    database.saveSettings(merged);
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// DUN-092: SteamGridDB key is write-only. Status for any user; set/clear for admins.
// Responses are exactly `{ set }`; the key is never returned or logged.
app.get('/api/provider-keys/steamgriddb', authMiddleware, (req, res) => {
  try {
    res.json(steamGridKeyStatus());
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.put('/api/provider-keys/steamgriddb', authMiddleware, requireAdmin, (req, res) => {
  try {
    res.json(setSteamGridKey(req.body?.key));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/provider-keys/steamgriddb', authMiddleware, requireAdmin, (req, res) => {
  try {
    res.json(clearSteamGridKey());
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Delete a game (admin-only). Removes the row and its save tree.
app.delete('/api/saves', authMiddleware, requireAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const idParam = (req.query.id as string | undefined)?.toString();
    const game = (req.query.game as string | undefined)?.toString();
    let row: Game | undefined;
    if (idParam) {
      const id = Number(idParam);
      if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, 400, 'INVALID_GAME_ID', 'Invalid id');
      // Admin by id: explicit target, any owner.
      row = database.getGameById(id);
    } else if (game) {
      // By title: scoped to the admin's own games unless `owner` is given.
      row = database.findGame(targetOwnerId(req), gameParam(game));
    } else {
      return sendError(res, 400, 'BAD_REQUEST', 'id or game required');
    }
    if (!row) throw gameNotFound();
    // DUN-093: the folder is saves/<owner>/<gameId>, checked strictly inside
    // saves/<owner> (never the owner root itself or anything outside it).
    const root = getGameRoot(row.id, row.ownerId);
    assertStrictlyInside(root, ownerSavesRoot(row.ownerId), 'Game folder');
    database.deleteGame(row.id, row.ownerId);
    const st = fs.lstatSync(root, { throwIfNoEntry: false });
    if (st?.isDirectory()) fs.rmSync(root, { recursive: true, force: true });
    else if (st?.isSymbolicLink()) fs.unlinkSync(root); // remove the link, never its target
    res.json({ success: true, filesRemoved: Boolean(st) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// ── Save versioning REST shims ─────────────────────────────────────────────
app.get('/api/save-versions', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    // DUN-038: by game id only (400 INVALID_GAME_ID, 404 GAME_NOT_FOUND).
    const { gameId } = parseInput(saveVersionsListQuery, req.query, 'INVALID_GAME_ID');
    const row = requireGameById(req, gameId);
    res.json({ success: true, versions: listSaveVersions(row.id) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Registered before /:id so 'diff' is not captured as a version id.
app.get('/api/save-versions/diff', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const from = req.query.from?.toString();
    const to = req.query.to?.toString();
    if (!from || !to) return sendError(res, 400, 'BAD_REQUEST', 'from and to required');
    for (const id of [from, to]) {
      const v = getSaveVersion(id);
      if (!v || !canSeeGame(req, v.version.gameId)) return sendError(res, 404, 'VERSION_NOT_FOUND', 'Version not found');
    }
    res.json({ success: true, diff: getVersionDiff(from, to) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/save-versions/:id', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const detail = getSaveVersion(req.params.id.toString());
    if (!detail || !canSeeGame(req, detail.version.gameId)) return sendError(res, 404, 'VERSION_NOT_FOUND', 'Version not found');
    res.json({ success: true, ...detail });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/save-versions', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    assertNoLaunchFields(req.body); // DUN-061
    // DUN-038: by game id only (400 INVALID_GAME_ID, 404 GAME_NOT_FOUND).
    const { gameId, deviceId, changeSummary } = parseInput(saveVersionCreateBody, req.body ?? {}, 'INVALID_GAME_ID');
    const row = requireGameById(req, gameId);
    const resolvedDeviceId = typeof deviceId === 'string' ? deviceId : req.user?.id;
    // Serialized with uploads/restores (DUN-090).
    const version = await withDbLock(() => createVersionFromDirectory({
      gameId: row.id,
      ownerId: row.ownerId,
      deviceId: resolvedDeviceId,
      changeSummary: typeof changeSummary === 'string' ? changeSummary : 'manual snapshot',
    }));
    const previous = listSaveVersions(row.id, 2)[1];
    const conflict = previous && previous.deviceId && previous.deviceId !== resolvedDeviceId
      ? detectConflict(row.id, previous.id, version.id)
      : null;
    res.status(201).json({ success: true, version, conflict, hasUnresolved: hasUnresolvedConflict(row.id) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/restore-version', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    assertNoLaunchFields(req.body); // DUN-061
    // DUN-137: by game id only (400 INVALID_GAME_ID, 404 GAME_NOT_FOUND).
    const { gameId, versionId } = parseInput(restoreVersionBody, req.body ?? {}, 'INVALID_GAME_ID');
    const row = requireGameById(req, gameId);
    // DUN-125: restoreVersion validates versionId format (400
    // INVALID_VERSION_ID) + containment; a version of another game is 404.
    const result = await restoreVersion(row.id, typeof versionId === 'string' ? versionId : '', row.ownerId);
    if (!result.success) return sendError(res, 404, 'VERSION_NOT_FOUND', result.message);
    res.json(result);
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// ── Save conflict REST shims ─────────────────────────────────────────────────
app.get('/api/conflicts', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const game = req.query.game?.toString();
    if (game) {
      const row = requireGame(req, game);
      res.json({ success: true, conflicts: listConflicts(row.id), hasUnresolved: hasUnresolvedConflict(row.id) });
    } else {
      res.json({ success: true, conflicts: listConflicts(undefined, ownerScope(req)), hasUnresolved: false });
    }
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/conflicts/:id/resolve', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { resolution } = req.body ?? {};
    if (!['local', 'remote', 'both', 'later'].includes(resolution)) {
      return sendError(res, 400, 'BAD_REQUEST', 'invalid resolution');
    }
    const existing = listConflicts().find(c => c.id === req.params.id.toString());
    if (!existing || !canSeeGame(req, existing.gameId)) return sendError(res, 404, 'CONFLICT_NOT_FOUND', 'Conflict not found');
    const conflict = resolveConflict(req.params.id.toString(), resolution);
    if (!conflict) return sendError(res, 404, 'CONFLICT_NOT_FOUND', 'Conflict not found');
    res.json({ success: true, conflict });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// ── Backup profile and storage REST shims ───────────────────────────────────
app.get('/api/backup-profile', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const game = req.query.game?.toString();
    if (!game) return sendError(res, 400, 'BAD_REQUEST', 'game required');
    const row = requireGame(req, game);
    // cacheExcludeGlobs: what autoExcludeCache adds on top of excludeGlobs (DUN-103).
    res.json({ success: true, profile: getBackupProfile(row.id), cacheExcludeGlobs: DEFAULT_EXCLUDE_GLOBS });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/backup-profile', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    assertNoLaunchFields(req.body); // DUN-061
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.game) return sendError(res, 400, 'BAD_REQUEST', 'game required');
    // DUN-103: typed, bounded globs; absent fields keep the stored value.
    // Rules affect future snapshots/uploads only; stored versions are never
    // hidden, trashed or deleted because of an exclude rule (DUN-067).
    const excludeGlobs = body.excludeGlobs === undefined ? undefined : parseInput(globListSchema, body.excludeGlobs, 'INVALID_EXCLUDE_GLOBS');
    const includeGlobs = body.includeGlobs === undefined ? undefined : parseInput(globListSchema, body.includeGlobs, 'INVALID_INCLUDE_GLOBS');
    const options = parseInput(backupProfileOptionsSchema, body, 'INVALID_BACKUP_PROFILE');
    const row = requireGame(req, String(body.game));
    const current = getBackupProfile(row.id);
    const profile = upsertBackupProfile({
      gameId: row.id,
      includeGlobs: includeGlobs ?? current.includeGlobs,
      excludeGlobs: excludeGlobs ?? current.excludeGlobs,
      autoExcludeCache: options.autoExcludeCache ?? current.autoExcludeCache,
      maxFileSizeMB: options.maxFileSizeMB === null ? undefined : options.maxFileSizeMB ?? current.maxFileSizeMB,
      updatedAt: new Date().toISOString(),
    });
    res.json({ success: true, profile });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/storage', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const game = req.query.game?.toString();
    if (!game) return sendError(res, 400, 'BAD_REQUEST', 'game required');
    const row = requireGame(req, game);
    const root = getGameRoot(row.id, row.ownerId);
    const entry = {
      gameId: row.id,
      ...scanStorage(root, row.lastSync === 'Never' ? null : row.lastSync),
    };
    res.json({ success: true, entry, freeBytes: getDriveFreeBytes(root) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});


app.get('/api/playtime/graph', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    // DUN-096: validated range; custom spans capped (400 INVALID_RANGE).
    const q = parseInput(playtimeGraphQuery, req.query, 'INVALID_RANGE');
    const customRange = q.start !== undefined && q.end !== undefined ? { start: q.start, end: q.end } : undefined;
    res.json(getPlaytimeGraphData(q.range, customRange, ownerScope(req)));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime/comparison', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const q = parseInput(playtimeComparisonQuery, req.query, 'INVALID_RANGE');
    res.json(getPlaytimeComparison(q.range, ownerScope(req)));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime/export', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const q = parseInput(playtimeExportQuery, req.query, 'INVALID_RANGE');
    const customRange = q.start !== undefined && q.end !== undefined ? { start: q.start, end: q.end } : undefined;
    const result = exportPlaytimeData(q.format, q.range, customRange, ownerScope(req));
    if (!result.success) return sendError(res, 400, 'BAD_REQUEST', result.message ?? 'Export failed');
    res.json(result);
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Unmatched /api/* requests are API errors, not frontend routes — answer with
// JSON 404 instead of letting the SPA catch-all serve index.html with a 200.
// Registered *after* every /api route so it can never shadow a real handler.
app.use('/api', (_req, res) => {
  sendError(res, 404, 'NOT_FOUND', 'Not found');
});

if (fs.existsSync(FRONTEND_DIR)) {
  // Express 5 / path-to-regexp 8: a bare '*' is invalid. `/{*splat}` is the
  // optional named wildcard that still matches "/" and every client route.
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
}

export { app };

const PORT = parseInt(process.env.PORT || '3030', 10);
// Vitest imports this module for HTTP-level tests — never bind a port there.
if (!process.env.VITEST) {
app.listen(PORT, '0.0.0.0', () => {
  logger.info(
    { port: PORT, frontend: fs.existsSync(FRONTEND_DIR), dataDir: dataDir() },
    'Dune Server listening',
  );
});
}
