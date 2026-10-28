import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import type { Request, Response, NextFunction } from 'express';
import { hasQueryApiKey } from '../utils/authKey.js';

/** DUN-102: every limiter answers 429 with the standard `{ error, code }` body. */
const RATE_LIMITED = { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' } as const;

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * General limiter, mounted on `/api` and `/trpc` only (static dashboard
 * assets, /health and /ready are never counted). Default 100 per 15 min per
 * client IP; RATE_LIMIT_API_MAX / RATE_LIMIT_API_WINDOW_MS override.
 */
export const apiRateLimiter = rateLimit({
  windowMs: envInt('RATE_LIMIT_API_WINDOW_MS', 15 * 60 * 1000),
  limit: envInt('RATE_LIMIT_API_MAX', 100),
  message: RATE_LIMITED,
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiter for upload endpoints: 20 requests per minute
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  message: { error: 'Upload rate limit exceeded', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * DUN-102: `trust proxy` from TRUST_PROXY (default off, so X-Forwarded-For
 * is ignored and req.ip is the socket peer). 'true' trusts every hop, a
 * number trusts that many hops, anything else is passed through as Express'
 * address/subnet list (e.g. 'loopback' or '10.0.0.0/8').
 */
export function trustProxySetting(raw: string | undefined = process.env.TRUST_PROXY): boolean | number | string {
  const v = (raw ?? '').trim();
  if (v === '' || v.toLowerCase() === 'false' || v === '0') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export interface AuthFailureLimiterOptions {
  /** Failed key presentations allowed per IP per window. */
  max: number;
  windowMs: number;
  /** Cap on tracked IPs (oldest windows evicted first). */
  maxTrackedIps?: number;
}

/**
 * DUN-102: brute-force guard for API keys (the dashboard "login" is a key
 * check). Each request that presents a key which doesn't resolve counts as a
 * failure for its IP; once an IP reaches `max` failures inside `windowMs`,
 * every /api and /trpc request from it is 429 RATE_LIMITED until the window
 * ends. Valid requests never count.
 */
export function createAuthFailureLimiter(opts: AuthFailureLimiterOptions) {
  const failures = new Map<string, { count: number; resetAt: number }>();
  const cap = opts.maxTrackedIps ?? 10000;

  const entry = (ip: string, now: number) => {
    const e = failures.get(ip);
    if (e && e.resetAt > now) return e;
    if (e) failures.delete(ip);
    return undefined;
  };

  return {
    /** Middleware: refuse IPs that are over the failure budget. */
    guard(req: Request, res: Response, next: NextFunction): void {
      const e = entry(req.ip ?? 'unknown', Date.now());
      if (e && e.count >= opts.max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((e.resetAt - Date.now()) / 1000))));
        res.status(429).json(RATE_LIMITED);
        return;
      }
      next();
    },
    /** Record one failed key presentation for this request's IP. */
    recordFailure(req: Request): void {
      const now = Date.now();
      const ip = req.ip ?? 'unknown';
      const e = entry(ip, now);
      if (e) {
        e.count += 1;
        return;
      }
      if (failures.size >= cap) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      failures.set(ip, { count: 1, resetAt: now + opts.windowMs });
    },
    reset(): void {
      failures.clear();
    },
  };
}

/** The process-wide auth-failure limiter (AUTH_FAIL_MAX / AUTH_FAIL_WINDOW_MS). */
export const authFailureLimiter = createAuthFailureLimiter({
  // Under Vitest the default is loose so suites that probe bad keys don't
  // trip it; the limiter itself is tested with explicit options/env.
  max: envInt('AUTH_FAIL_MAX', process.env.VITEST ? 1000 : 10),
  windowMs: envInt('AUTH_FAIL_WINDOW_MS', 15 * 60 * 1000),
});

/** DUN-102: a key in the query string is refused (header only), before any logging of it matters. */
export function rejectQueryApiKey(req: Request, res: Response, next: NextFunction): void {
  if (hasQueryApiKey(req.originalUrl ?? req.url)) {
    res.status(400).json({ error: 'Send the API key in the x-api-key header, never in the URL', code: 'API_KEY_IN_QUERY' });
    return;
  }
  next();
}

// Helmet configuration
export const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// CORS configuration
export const corsConfig = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    // Allow Electron packaged app (file:// protocol) and local dev
    if (origin === 'null' || origin.startsWith('file://')) {
      return callback(null, true);
    }

    const allowedOrigins = [
      'http://localhost:3023',
      'http://localhost:5173',
      'http://127.0.0.1:3023',
      'http://127.0.0.1:5173',
    ];

    // In production, add your domain
    if (process.env.ALLOWED_ORIGINS) {
      allowedOrigins.push(
        ...process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean),
      );
    }

    // Deny by omitting the CORS headers (the browser then blocks the
    // response). Throwing here would surface as an opaque 500 from the
    // default Express error handler instead of a clean denial.
    callback(null, allowedOrigins.includes(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-game', 'x-path', 'x-sync-id', 'x-dune-relay'],
});
