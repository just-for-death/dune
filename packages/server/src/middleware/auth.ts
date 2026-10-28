import { Request, Response, NextFunction } from 'express';
import { database } from '../db/index.js';
import type { User } from '../types/index.js';
import { extractApiKey } from '../utils/authKey.js';
import { authFailureLimiter } from './security.js';

export interface AuthenticatedRequest extends Request {
  apiKey?: string;
  /** The user the presented key belongs to (set once the key validates). */
  user?: User;
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Public endpoints that don't require authentication
  if (req.path === '/health' || req.path === '/icon.png') {
    return next();
  }

  if (req.path.startsWith('/assets/') || req.path === '/' || req.path === '/index.html') {
    return next();
  }

  const apiKey = extractApiKey(req.headers as Record<string, string | string[] | undefined>);

  if (!apiKey) {
    res.status(401).json({ error: 'API key required', code: 'UNAUTHORIZED' });
    return;
  }

  const user = database.resolveUserByKey(apiKey);
  if (!user) {
    res.status(403).json({ error: 'Invalid API key', code: 'INVALID_API_KEY' });
    return;
  }

  req.apiKey = apiKey;
  req.user = user;
  next();
}

/**
 * Resolves the presented key once per request (REST and tRPC). A key that
 * doesn't resolve is recorded as an auth failure for the client IP
 * (DUN-102, authFailureLimiter).
 */
export function optionalAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const apiKey = extractApiKey(req.headers as Record<string, string | string[] | undefined>);

  if (apiKey) {
    const user = database.resolveUserByKey(apiKey);
    if (user) {
      req.apiKey = apiKey;
      req.user = user;
    } else {
      authFailureLimiter.recordFailure(req);
    }
  }
  next();
}

/** Express guard: allow only admins through. Assumes authMiddleware ran first. */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'API key required', code: 'UNAUTHORIZED' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin privileges required', code: 'FORBIDDEN' });
    return;
  }
  next();
}
