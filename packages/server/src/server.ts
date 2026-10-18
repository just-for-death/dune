import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { authMiddleware, optionalAuthMiddleware, requireAdmin, AuthenticatedRequest } from './middleware/auth.js';
import { helmetConfig, corsConfig, apiRateLimiter, uploadRateLimiter } from './middleware/security.js';
import { dataDir, validateGamePath, getGameRoot, listFilesInDir } from './utils/path.js';
import { handleUploadFile, handleLocalSync } from './services/sync.js';
import { manifestForGame, removeGameFile } from './services/manifest.js';
import { handler as trpcHandler } from './trpc/http.js';
import { logger, requestLogger, type LoggedRequest } from './middleware/logging.js';
import { checkReadiness } from './services/health.js';
import { database } from './db/index.js';
import { recordPlaytimeSession, getPlaytimeSummary, getRecentSessions, getTotalPlaytime } from './services/playtime.js';
import { getGameAchievements, getAchievementSummary, getRecentUnlocks } from './services/achievements.js';
import { getHLTBTimes } from './services/hltb.js';
import { analyzeFilesAI, checkModelStatus, fetchModels } from './services/ollama.js';
import { searchArt, autoMatchAll } from './services/steamGridDB.js';

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

app.use(apiRateLimiter);
app.use(optionalAuthMiddleware);

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
}

// tRPC endpoint. Mounted with app.use so Express strips the /trpc prefix
// before the standalone handler resolves the procedure path.
app.use('/trpc', trpcHandler);

// Legacy REST endpoints for file operations (streaming)
app.post('/api/upload-file', authMiddleware, uploadRateLimiter, async (req: AuthenticatedRequest, res) => {
  try {
    const game = req.headers['x-game'] as string;
    const filePath = req.headers['x-path'] as string;
    const syncId = (req.headers['x-sync-id'] as string) || Date.now().toString();

    if (!game || !filePath) {
      return res.status(400).json({ success: false, message: 'Game and path headers required' });
    }

    // Ownership gate: rejects writes to another user's game (unknown games are
    // claimable and get assigned to the uploader once the upload succeeds).
    if (!ensureGameWrite(req, res, path.basename(game))) return;

    // Upfront content-length guard (streaming guard in sync.ts is authoritative)
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    const maxUploadBytes =
      Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '500', 10)) * 1024 * 1024;
    if (contentLength > maxUploadBytes) {
      return res.status(413).json({ success: false, message: 'File exceeds upload size limit' });
    }

    const result = await handleUploadFile(game, filePath, req, syncId, (req as AuthenticatedRequest).user?.id);
    if (!result.success && result.status) {
      return res.status(result.status).json(result);
    }
    if (result.success && req.user) {
      // Assign a new/unowned game to the uploader only after a good write.
      database.claimGame(path.basename(game), req.user.id);
    }
    res.json(result);
  } catch (e) {
    logger.error({ reqId: (req as LoggedRequest).reqId, err: e }, 'API internal error');
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

app.post('/api/local-sync', authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const result = await handleLocalSync((_req as AuthenticatedRequest).user?.id);
    res.json(result);
  } catch (e) {
    logger.error({ reqId: (_req as LoggedRequest).reqId, err: e }, 'API internal error');
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

app.get('/api/download-file', authMiddleware, (req, res) => {
  try {
    const { game, path: filePath } = req.query;
    if (!game || !filePath) return res.status(400).json({ success: false, message: 'Game and path required' });

    if (!ensureGameRead(req as AuthenticatedRequest, res, path.basename(game.toString()))) return;

    let fullPath: string;
    try {
      fullPath = validateGamePath(game.toString(), filePath.toString(), (req as AuthenticatedRequest).user?.id);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid path' });
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found' });

    // Serve dotfiles too: the manifest/list endpoints include them, and express
    // 5's `send` would otherwise 404 a listed save (path is traversal-checked).
    res.download(fullPath, path.basename(fullPath), { dotfiles: 'allow' });
  } catch (e) {
    logger.error({ reqId: (req as LoggedRequest).reqId, err: e }, 'API internal error');
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

app.get('/api/download-version-file', authMiddleware, (req, res) => {
  try {
    const { game, versionId, path: filePath } = req.query;
    if (!game || !versionId || !filePath) return res.status(400).json({ success: false, message: 'Missing params' });

    if (!/^\d+$/.test(versionId.toString())) {
      return res.status(400).json({ success: false, message: 'Invalid versionId' });
    }
    if (!ensureGameRead(req as AuthenticatedRequest, res, path.basename(game.toString()))) return;
    let fullPath: string;
    try {
      fullPath = validateGamePath(game.toString(), path.join('.versions', versionId.toString(), filePath.toString()), (req as AuthenticatedRequest).user?.id);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid path' });
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found' });

    // Version snapshots live under a dot-directory (`.versions`); express 5's
    // `send` defaults to `dotfiles: 'ignore'` and would 404 them.
    res.download(fullPath, path.basename(fullPath), { dotfiles: 'allow' });
  } catch (e) {
    logger.error({ reqId: (req as LoggedRequest).reqId, err: e }, 'API internal error');
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ── REST shims for the Electron client ───────────────────────────────────────
// The desktop client speaks REST (not tRPC). Every route below mirrors an
// existing tRPC procedure / service so the app works against a real server.
// All require x-api-key via authMiddleware, like the file routes above.

function restError(req: express.Request, res: express.Response, e: unknown, label: string) {
  logger.error({ reqId: (req as LoggedRequest).reqId, err: e }, label);
  res.status(500).json({ success: false, message: 'Internal error' });
}

/** `undefined` = all owners (admin view); otherwise scope to the caller. */
function ownerScope(req: AuthenticatedRequest): string | undefined {
  return req.user?.role === 'admin' ? undefined : req.user?.id;
}

/** Respond 403 and return false when the caller may not read `game`. */
function ensureGameRead(req: AuthenticatedRequest, res: express.Response, game: string): boolean {
  if (!req.user || !database.canAccessGame(req.user, game)) {
    res.status(403).json({ success: false, message: 'No access to this game' });
    return false;
  }
  return true;
}

/** Respond 403 and return false when the caller may not write `game`. */
function ensureGameWrite(req: AuthenticatedRequest, res: express.Response, game: string): boolean {
  if (!req.user || !database.canWriteGame(req.user, game)) {
    res.status(403).json({ success: false, message: 'No access to this game' });
    return false;
  }
  return true;
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
    if (!game) return res.status(400).json({ success: false, message: 'Game required' });
    if (!ensureGameRead(req, res, path.basename(game.toString()))) return;
    const gameDir = getGameRoot(game.toString(), (req as AuthenticatedRequest).user?.id);
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
    if (!game) return res.status(400).json({ success: false, message: 'Game required' });
    if (!ensureGameRead(req, res, path.basename(game.toString()))) return;
    res.json({ success: true, files: manifestForGame(game.toString(), (req as AuthenticatedRequest).user?.id) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Delta sync: remove a single file (client mirrors a local deletion).
app.delete('/api/file', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game, path: filePath } = req.query;
    if (!game || !filePath) return res.status(400).json({ success: false, message: 'Game and path required' });
    if (!ensureGameWrite(req, res, path.basename(game.toString()))) return;
    try {
      validateGamePath(game.toString(), filePath.toString(), (req as AuthenticatedRequest).user?.id);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid path' });
    }
    const removed = removeGameFile(game.toString(), filePath.toString(), (req as AuthenticatedRequest).user?.id);
    if (!removed) return res.status(404).json({ success: false, message: 'File not found' });
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/playtime', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { game, platform, sessionStart, sessionEnd } = req.body ?? {};
    if (!game || !platform || !sessionStart || !sessionEnd) {
      return res.status(400).json({ success: false, message: 'game, platform, sessionStart, sessionEnd required' });
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
    if (!gameName || !Array.isArray(files)) {
      return res.status(400).json({ success: false, message: 'gameName and files array required' });
    }
    const settings = database.getSettings();
    const endpoint = settings.ollamaEndpoint || 'http://ollama:11434';
    const model = settings.ollamaModel || 'phi4-mini:latest';
    const result = await analyzeFilesAI(endpoint, model, gameName, files);
    if (result.success && result.analysis) {
      const games = req.user ? database.getGamesForUser(req.user) : [];
      const idx = games.findIndex(g => g.name.toLowerCase() === gameName.toLowerCase());
      if (idx !== -1) {
        games[idx].analysis = result.analysis;
        database.upsertGame(games[idx]);
      }
    }
    res.json(result);
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/search-art', authMiddleware, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.status(400).json({ success: false, message: 'query required' });
    const apiKey = database.getSettings().steamGridApiKey;
    if (!apiKey) return res.status(400).json({ success: false, message: 'SteamGridDB API key not configured' });
    res.json(await searchArt(apiKey, query.toString()));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/auto-match-all', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const apiKey = database.getSettings().steamGridApiKey;
    if (!apiKey) return res.status(400).json({ success: false, message: 'SteamGridDB API key not configured' });
    const games = req.user ? database.getGamesForUser(req.user) : [];
    const matched = await autoMatchAll(apiKey, games);
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
    if (!sourcePath) return res.status(400).json({ success: false, message: 'path required' });
    if (!fs.existsSync(sourcePath)) return res.status(400).json({ success: false, message: 'Path does not exist' });
    res.json({ success: true, source: database.addLocalSource(sourcePath) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/local-sources/:id', authMiddleware, requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    if (!database.removeLocalSource(id)) return res.status(404).json({ success: false, message: 'Source not found' });
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
    if (!url) return res.status(400).json({ success: false, message: 'url required' });
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid url' });
    }
    res.json({ success: true, server: database.addRemoteServer(url) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/remote-servers/:id', authMiddleware, requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    if (!database.removeRemoteServer(id)) return res.status(404).json({ success: false, message: 'Server not found' });
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Self-service key management: a user sees/rotates only their own keys.
app.get('/api/api-keys', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'API key required' });
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
    if (!req.user) return res.status(401).json({ success: false, message: 'API key required' });
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
    if (!req.user) return res.status(401).json({ success: false, message: 'API key required' });
    const match = database.listUserKeys(req.user.id).find(k => k.hash.slice(0, 12) === req.params.id);
    if (!match || !database.removeUserKeyByHash(match.hash)) {
      return res.status(404).json({ success: false, message: 'Key not found' });
    }
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// ── User administration (admin-only, except /api/users/me) ───────────────────
app.get('/api/users/me', authMiddleware, (req: AuthenticatedRequest, res) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'API key required' });
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
      return res.status(400).json({ success: false, message: 'name required' });
    }
    if (database.getUserByName(name)) {
      return res.status(409).json({ success: false, message: 'User name already exists' });
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
      return res.status(404).json({ success: false, message: 'User not found' });
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
      return res.status(404).json({ success: false, message: 'Key not found' });
    }
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/users/:id', authMiddleware, requireAdmin, (req, res) => {
  try {
    const target = database.getUserById(req.params.id.toString());
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target.role === 'admin' && database.countAdmins() <= 1) {
      return res.status(400).json({ success: false, message: 'Cannot remove the last admin' });
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
    if (!endpoint) return res.status(400).json({ success: false, message: 'endpoint required' });
    try {
      new URL(endpoint.toString());
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid endpoint' });
    }
    res.json(await fetchModels(endpoint.toString()));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/ollama-health', authMiddleware, async (_req, res) => {
  try {
    const settings = database.getSettings();
    res.json(await checkModelStatus(
      settings.ollamaEndpoint || 'http://ollama:11434',
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
app.get('/api/settings', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const s = database.getSettings();
    const isAdmin = req.user?.role === 'admin';
    res.json({
      success: true,
      settings: {
        maxVersions: s.maxVersions,
        ollamaEndpoint: s.ollamaEndpoint,
        ollamaModel: s.ollamaModel,
        steamGridApiKey: isAdmin ? s.steamGridApiKey : s.steamGridApiKey ? '****' : '',
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
    if (typeof input.steamGridApiKey === 'string') merged.steamGridApiKey = input.steamGridApiKey;
    if (typeof input.ollamaEndpoint === 'string') merged.ollamaEndpoint = input.ollamaEndpoint;
    if (typeof input.ollamaModel === 'string') merged.ollamaModel = input.ollamaModel;
    database.saveSettings(merged);
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Delete a game (admin-only). Removes the row and its save tree.
app.delete('/api/saves', authMiddleware, requireAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const idParam = (req.query.id as string | undefined)?.toString();
    const game = (req.query.game as string | undefined)?.toString();
    let row;
    if (idParam) {
      const id = Number(idParam);
      if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
      row = database.getGames().find(g => g.id === id);
    } else if (game) {
      row = database.getGames().find(g => g.name === game);
    } else {
      return res.status(400).json({ success: false, message: 'id or game required' });
    }
    if (!row) return res.status(404).json({ success: false, message: 'Game not found' });
    database.deleteGame(row.id);
    const root = getGameRoot(row.name, row.ownerId);
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

// Unmatched /api/* requests are API errors, not frontend routes — answer with
// JSON 404 instead of letting the SPA catch-all serve index.html with a 200.
// Registered *after* every /api route so it can never shadow a real handler.
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
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
