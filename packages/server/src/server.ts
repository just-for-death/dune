import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from './middleware/auth.js';
import { helmetConfig, corsConfig, apiRateLimiter, uploadRateLimiter } from './middleware/security.js';
import { dataDir, validateGamePath, getGameRoot, listFilesInDir } from './utils/path.js';
import { handleUploadFile, handleLocalSync } from './services/sync.js';
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

    // Upfront content-length guard (streaming guard in sync.ts is authoritative)
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    const maxUploadBytes =
      Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '500', 10)) * 1024 * 1024;
    if (contentLength > maxUploadBytes) {
      return res.status(413).json({ success: false, message: 'File exceeds upload size limit' });
    }

    const result = await handleUploadFile(game, filePath, req, syncId);
    if (!result.success && result.status) {
      return res.status(result.status).json(result);
    }
    res.json(result);
  } catch (e) {
    logger.error({ reqId: (req as LoggedRequest).reqId, err: e }, 'API internal error');
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

app.post('/api/local-sync', authMiddleware, async (_req, res) => {
  try {
    const result = await handleLocalSync();
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

    let fullPath: string;
    try {
      fullPath = validateGamePath(game.toString(), filePath.toString());
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid path' });
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found' });

    res.download(fullPath);
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
    let fullPath: string;
    try {
      fullPath = validateGamePath(game.toString(), path.join('.versions', versionId.toString(), filePath.toString()));
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid path' });
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found' });

    res.download(fullPath);
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

app.get('/api/saves', authMiddleware, (_req, res) => {
  try {
    res.json({ success: true, games: database.getGames() });
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

app.get('/api/list-files', authMiddleware, (req, res) => {
  try {
    const { game } = req.query;
    if (!game) return res.status(400).json({ success: false, message: 'Game required' });
    const gameDir = getGameRoot(game.toString());
    if (!fs.existsSync(gameDir)) return res.json({ success: true, files: [] });
    res.json({ success: true, files: listFilesInDir(gameDir) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/playtime', authMiddleware, (req, res) => {
  try {
    const { game, platform, sessionStart, sessionEnd } = req.body ?? {};
    if (!game || !platform || !sessionStart || !sessionEnd) {
      return res.status(400).json({ success: false, message: 'game, platform, sessionStart, sessionEnd required' });
    }
    res.json(recordPlaytimeSession(game, platform, sessionStart, sessionEnd));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime', authMiddleware, (req, res) => {
  try {
    const { game } = req.query;
    res.json({ success: true, summary: getPlaytimeSummary(game?.toString()) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime/recent', authMiddleware, (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit?.toString() || '50', 10) || 50));
    res.json({ success: true, sessions: getRecentSessions(limit) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/playtime/total', authMiddleware, (_req, res) => {
  try {
    res.json({ success: true, totalMinutes: getTotalPlaytime() });
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

app.get('/api/achievements/recent', authMiddleware, (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit?.toString() || '20', 10) || 20));
    res.json({ success: true, unlocks: getRecentUnlocks(limit) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/achievements/:game', authMiddleware, (req, res) => {
  try {
    res.json({ success: true, achievements: getGameAchievements(req.params.game) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/achievements', authMiddleware, (req, res) => {
  try {
    const { game } = req.query;
    res.json({ success: true, summary: getAchievementSummary(game?.toString()) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/hltb/:game', authMiddleware, async (req, res) => {
  try {
    res.json(await getHLTBTimes(req.params.game));
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.post('/api/analyze-files-ai', authMiddleware, async (req, res) => {
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
      const games = database.getGames();
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

app.get('/api/auto-match-all', authMiddleware, async (_req, res) => {
  try {
    const apiKey = database.getSettings().steamGridApiKey;
    if (!apiKey) return res.status(400).json({ success: false, message: 'SteamGridDB API key not configured' });
    const matched = await autoMatchAll(apiKey, database.getGames());
    for (const m of matched) {
      const game = database.getGames().find(g => g.name === m.name);
      if (game && !game.thumbnail) {
        game.thumbnail = m.thumbnail;
        database.upsertGame(game);
      }
    }
    res.json({ success: true, count: matched.length });
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

app.get('/api/local-sources', authMiddleware, (_req, res) => {
  try {
    res.json({ success: true, sources: database.getLocalSources() });
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

app.post('/api/local-sources', authMiddleware, (req, res) => {
  try {
    const { path: sourcePath } = req.body ?? {};
    if (!sourcePath) return res.status(400).json({ success: false, message: 'path required' });
    if (!fs.existsSync(sourcePath)) return res.status(400).json({ success: false, message: 'Path does not exist' });
    res.json({ success: true, source: database.addLocalSource(sourcePath) });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/local-sources/:id', authMiddleware, (req, res) => {
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

app.post('/api/remote-servers', authMiddleware, (req, res) => {
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

app.delete('/api/remote-servers/:id', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    if (!database.removeRemoteServer(id)) return res.status(404).json({ success: false, message: 'Server not found' });
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.get('/api/api-keys', authMiddleware, (_req, res) => {
  try {
    res.json({ success: true, keys: database.getApiKeys().map(() => '****') });
  } catch (e) {
    restError(_req, res, e, 'API internal error');
  }
});

app.post('/api/api-keys', authMiddleware, (req, res) => {
  try {
    const { key, description } = req.body ?? {};
    if (!key) return res.status(400).json({ success: false, message: 'key required' });
    database.addApiKey(key, description);
    res.json({ success: true });
  } catch (e) {
    restError(req, res, e, 'API internal error');
  }
});

app.delete('/api/api-keys/:key', authMiddleware, (req, res) => {
  try {
    if (!database.removeApiKey(req.params.key)) {
      return res.status(404).json({ success: false, message: 'Key not found' });
    }
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

if (fs.existsSync(FRONTEND_DIR)) {
  app.get('*', (_req, res) => {
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
