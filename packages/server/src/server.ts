import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { authMiddleware, optionalAuthMiddleware, requireAdmin, AuthenticatedRequest } from './middleware/auth.js';
import { helmetConfig, corsConfig, apiRateLimiter, uploadRateLimiter } from './middleware/security.js';
import {
  dataDir, getGameRoot, listFilesInDir, validateServerUrl, resolveGameFile, requireGameTitle,
  PathRuleError, ownerSavesRoot, assertStrictlyInside,
} from './utils/path.js';
import { ApiError, isApiError, apiErrorBody, gameNotFound, assertNoLaunchFields } from './utils/apiError.js';
import { validateRelativeSavePath } from '@dune/shared/pathRules';
import type { Game } from './types/index.js';
import { handleUploadFile, handleLocalSync } from './services/sync.js';
import { listSaveVersions, getSaveVersion, getVersionDiff, createVersionFromDirectory, restoreVersion, VERSION_DIR_ID } from './services/saveVersions.js';
import { listConflicts, detectConflict, resolveConflict, hasUnresolvedConflict } from './services/conflicts.js';
import { getBackupProfile, upsertBackupProfile } from './services/backupProfiles.js';
import { scanStorage, getDriveFreeBytes } from './services/storage.js';
import { manifestForGame, removeGameFile } from './services/manifest.js';
import { handler as trpcHandler } from './trpc/http.js';
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
import { getGameAchievements, getAchievementSummary, getRecentUnlocks, upsertAchievements } from './services/achievements.js';
import { getAchievementDetails, getAchievementProgress } from './services/achievementDetail.js';
import { getHLTBTimes } from './services/hltb.js';
import { analyzeFilesAI, checkModelStatus, fetchModels } from './services/ollama.js';
import { searchArt, autoMatchAll } from './services/steamGridDB.js';
import { withSteamGridKey, steamGridKeyStatus, setSteamGridKey, clearSteamGridKey } from './services/providerKeys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmetConfig);
app.use(corsConfig);
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);

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

// Skip rate limiting in test environment to avoid flaky 429s
if (!process.env.VITEST) {
  app.use(apiRateLimiter);
}
app.use(optionalAuthMiddleware);

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
}

// tRPC endpoint. Mounted with app.use so Express strips the /trpc prefix
// before the standalone handler resolves the procedure path.
app.use('/trpc', trpcHandler);

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
    const syncId = (req.headers['x-sync-id'] as string) || Date.now().toString();

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

app.get('/api/download-version-file', authMiddleware, (req, res) => {
  try {
    const { game, versionId, path: filePath } = req.query;
    if (!game || !versionId || !filePath) return sendError(res, 400, 'BAD_REQUEST', 'Missing params');

    // DUN-125: only the stored snapshot id formats (digits / UUID).
    if (!VERSION_DIR_ID.test(versionId.toString())) {
      throw new PathRuleError('INVALID_VERSION_ID', 'Invalid version id');
    }
    // Check the client path on its own first, then resolve the joined path
    // (lexical rules + no symlinks + strict containment).
    const rel = validateRelativeSavePath(filePath.toString());
    if (!rel.ok) throw new PathRuleError(rel.code, rel.message);
    const row = requireGame(req as AuthenticatedRequest, game.toString());
    const fullPath = resolveGameFile(row.id, `.versions/${versionId.toString()}/${rel.value}`, row.ownerId).abs;
    if (!fs.statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
      return sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
    }

    // Version snapshots live under a dot-directory (`.versions`); express 5's
    // `send` defaults to `dotfiles: 'ignore'` and would 404 them.
    res.download(fullPath, path.basename(fullPath), { dotfiles: 'allow' });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// ── REST shims for the Electron client ───────────────────────────────────────
// The desktop client speaks REST (not tRPC). Every route below mirrors an
// existing tRPC procedure / service so the app works against a real server.
// All require x-api-key via authMiddleware, like the file routes above.

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
    const { game, platform, sessionStart, sessionEnd } = req.body ?? {};
    if (!game || !platform || !sessionStart || !sessionEnd) {
      return sendError(res, 400, 'BAD_REQUEST', 'game, platform, sessionStart, sessionEnd required');
    }
    res.json(recordPlaytimeSession(game, platform, sessionStart, sessionEnd, req.user?.id ?? ''));
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

app.get('/api/achievements/:game', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    res.json({ success: true, achievements: getGameAchievements(req.params.game.toString(), ownerScope(req)) });
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
    res.json(await getHLTBTimes(req.params.game.toString()));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/analyze-files-ai', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const { gameName, files } = req.body ?? {};
    assertNoLaunchFields(req.body);
    if (!gameName || !Array.isArray(files)) {
      return sendError(res, 400, 'BAD_REQUEST', 'gameName and files array required');
    }
    const settings = database.getSettings();
    const endpoint = settings.ollamaEndpoint || 'http://ollama:11434';
    const model = settings.ollamaModel || 'phi4-mini:latest';
    const check = validateServerUrl(endpoint);
    if (!check.valid) return sendError(res, 400, 'INVALID_URL', check.error ?? 'Invalid URL');
    const result = await analyzeFilesAI(check.url, model, gameName, files);
    if (result.success && result.analysis) {
      const row = database.findGame(targetOwnerId(req), gameParam(gameName));
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

app.get('/api/auto-match-all', authMiddleware, async (req: AuthenticatedRequest, res) => {
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

app.get('/api/ollama-models', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.query;
    if (!endpoint) return sendError(res, 400, 'BAD_REQUEST', 'endpoint required');
    const check = validateServerUrl(endpoint.toString());
    if (!check.valid) return sendError(res, 400, 'INVALID_URL', check.error ?? 'Invalid URL');
    try {
      new URL(check.url);
    } catch {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid endpoint');
    }
    res.json(await fetchModels(check.url));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/ollama-health', authMiddleware, async (_req, res) => {
  try {
    const settings = database.getSettings();
    const endpoint = settings.ollamaEndpoint || 'http://ollama:11434';
    const check = validateServerUrl(endpoint);
    if (!check.valid) return sendError(res, 400, 'INVALID_URL', check.error ?? 'Invalid URL');
    res.json(await checkModelStatus(
      check.url,
      settings.ollamaModel || 'phi4-mini:latest',
    ));
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
    if (typeof input.maxVersions === 'number' && input.maxVersions > 0) merged.maxVersions = input.maxVersions;
    if ('steamGridApiKey' in input) {
      // DUN-092: write-only secret with its own routes; never stored in settings.
      return sendError(res, 400, 'WRITE_ONLY_FIELD', 'steamGridApiKey is set via PUT /api/provider-keys/steamgriddb');
    }
    if (typeof input.ollamaEndpoint === 'string') {
      const check = validateServerUrl(input.ollamaEndpoint);
      if (!check.valid) return sendError(res, 400, 'INVALID_URL', check.error ?? 'Invalid URL');
      merged.ollamaEndpoint = check.url;
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
    const game = req.query.game?.toString();
    if (!game) return sendError(res, 400, 'BAD_REQUEST', 'game required');
    const row = requireGame(req, game);
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
    const { game, deviceId, changeSummary } = req.body ?? {};
    if (!game) return sendError(res, 400, 'BAD_REQUEST', 'game required');
    const row = requireGame(req, game.toString());
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
    const { game, versionId } = req.body ?? {};
    if (!game || !versionId) return sendError(res, 400, 'BAD_REQUEST', 'game and versionId required');
    const row = requireGame(req, game.toString());
    // DUN-125: restoreVersion validates versionId format (400
    // INVALID_VERSION_ID) + containment; a version of another game is 404.
    const result = await restoreVersion(row.id, versionId.toString(), row.ownerId);
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

app.post('/api/conflicts/detect', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game, localVersionId, remoteVersionId } = req.body ?? {};
    if (!game || !localVersionId || !remoteVersionId) {
      return sendError(res, 400, 'BAD_REQUEST', 'game, localVersionId and remoteVersionId required');
    }
    const row = requireGame(req, game.toString());
    const conflict = detectConflict(row.id, localVersionId.toString(), remoteVersionId.toString());
    res.json({ success: true, conflict, hasUnresolved: hasUnresolvedConflict(row.id) });
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
    res.json({ success: true, profile: getBackupProfile(row.id) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/backup-profile', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    assertNoLaunchFields(req.body); // DUN-061
    const { game, includeGlobs, excludeGlobs, autoExcludeCache, maxFileSizeMB } = req.body ?? {};
    if (!game) return sendError(res, 400, 'BAD_REQUEST', 'game required');
    const row = requireGame(req, game.toString());
    const profile = upsertBackupProfile({
      gameId: row.id,
      includeGlobs: Array.isArray(includeGlobs) ? includeGlobs : ['**/*'],
      excludeGlobs: Array.isArray(excludeGlobs) ? excludeGlobs : [],
      autoExcludeCache: autoExcludeCache !== false,
      maxFileSizeMB: typeof maxFileSizeMB === 'number' ? maxFileSizeMB : undefined,
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
    const range = (req.query.range?.toString() || 'all') as 'all' | 'year' | 'month' | 'week' | 'custom';
    const customRange = req.query.start && req.query.end ? { start: req.query.start.toString(), end: req.query.end.toString() } : undefined;
    res.json(getPlaytimeGraphData(range, customRange, ownerScope(req)));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime/comparison', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const range = (req.query.range?.toString() || 'week') as 'week' | 'month' | 'year';
    res.json(getPlaytimeComparison(range, ownerScope(req)));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime/export', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const format = (req.query.format?.toString() || 'json') as 'csv' | 'json';
    const range = (req.query.range?.toString() || 'all') as 'all' | 'year' | 'month' | 'week' | 'custom';
    const customRange = req.query.start && req.query.end ? { start: req.query.start.toString(), end: req.query.end.toString() } : undefined;
    const result = exportPlaytimeData(format, range, customRange, ownerScope(req));
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
