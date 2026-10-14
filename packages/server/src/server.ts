import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from './middleware/auth.js';
import { helmetConfig, corsConfig, apiRateLimiter, uploadRateLimiter } from './middleware/security.js';
import { dataDir, validateGamePath } from './utils/path.js';
import { handleUploadFile, handleLocalSync } from './services/sync.js';
import { handler as trpcHandler } from './trpc/http.js';
import { logger, requestLogger, type LoggedRequest } from './middleware/logging.js';
import { checkReadiness } from './services/health.js';

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
