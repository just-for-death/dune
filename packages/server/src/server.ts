import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { database } from './db/index.js';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from './middleware/auth.js';
import { helmetConfig, corsConfig, apiRateLimiter, uploadRateLimiter } from './middleware/security.js';
import { normalizeUrl, getGameRoot, validateGamePath, listFilesInDir } from './utils/path.js';
import { handleUploadFile, handleLocalSync } from './services/sync.js';
import { analyzeFilesAI, checkModelStatus, fetchModels } from './services/ollama.js';
import { getHLTBTimes, bulkFetchHLTB } from './services/hltb.js';
import { searchArt, autoMatchAll } from './services/steamGridDB.js';
import { recordPlaytimeSession, getPlaytimeSummary, getRecentSessions, getTotalPlaytime } from './services/playtime.js';
import { upsertAchievements, getGameAchievements, getAchievementSummary, getRecentUnlocks, handleSentinelWebhook } from './services/achievements.js';
import { triggerRemoteSync } from './services/remoteSync.js';
import { handler as trpcHandler } from './trpc/http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmetConfig);
app.use(corsConfig);
app.use(express.json({ limit: '10mb' }));
app.use(apiRateLimiter);
app.use(optionalAuthMiddleware);

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
}

// tRPC endpoint
app.all('/trpc/*', trpcHandler);

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
    console.error('[API] Internal error:', e instanceof Error ? e.message : String(e));
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

app.post('/api/local-sync', authMiddleware, async (_req, res) => {
  try {
    const result = await handleLocalSync();
    res.json(result);
  } catch (e) {
    console.error('[API] Internal error:', e instanceof Error ? e.message : String(e));
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

app.get('/api/download-file', authMiddleware, (req, res) => {
  try {
    const { game, path: filePath } = req.query;
    if (!game || !filePath) return res.status(400).json({ success: false, message: 'Game and path required' });

    const gameName = path.basename(game.toString());
    const safePath = filePath.toString().replace(/\.\.[\\/]/g, '');
    const fullPath = path.join(getGameRoot(gameName), safePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found' });

    res.download(fullPath);
  } catch (e) {
    console.error('[API] Internal error:', e instanceof Error ? e.message : String(e));
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

app.get('/api/download-version-file', authMiddleware, (req, res) => {
  try {
    const { game, versionId, path: filePath } = req.query;
    if (!game || !versionId || !filePath) return res.status(400).json({ success: false, message: 'Missing params' });

    const gameName = path.basename(game.toString());
    const safePath = filePath.toString().replace(/\.\.[\\/]/g, '');
    const fullPath = path.join(getGameRoot(gameName), '.versions', versionId.toString(), safePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found' });

    res.download(fullPath);
  } catch (e) {
    console.error('[API] Internal error:', e instanceof Error ? e.message : String(e));
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

if (fs.existsSync(FRONTEND_DIR)) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
}

const PORT = parseInt(process.env.PORT || '3030', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dune Server] Listening on port ${PORT}`);
  console.log(`[Dune Server] Frontend: ${fs.existsSync(FRONTEND_DIR) ? 'served' : 'not built'}`);
  console.log(`[Dune Server] Data dir: ${path.join(process.cwd(), 'data')}`);
  console.log(`[Dune Server] tRPC endpoint: http://0.0.0.0:${PORT}/trpc`);
});
