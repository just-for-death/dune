import { Request, Response, NextFunction } from 'express';
import { database } from '../db/index.js';
import type { User } from '../types/index.js';
import { extractApiKey } from '../utils/authKey.js';

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

  const apiKey = extractApiKey(req.headers as Record<string, string | string[] | undefined>, req.url);
  
  if (!apiKey) {
    res.status(401).json({ success: false, message: 'API key required' });
    return;
  }

  const user = database.resolveUserByKey(apiKey);
  if (!user) {
    res.status(403).json({ success: false, message: 'Invalid API key' });
    return;
  }

  req.apiKey = apiKey;
  req.user = user;
  next();
}

export function optionalAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const apiKey = extractApiKey(req.headers as Record<string, string | string[] | undefined>, req.url);

  if (apiKey) {
    const user = database.resolveUserByKey(apiKey);
    if (user) {
      req.apiKey = apiKey;
      req.user = user;
    }
  }
  next();
}

/** Express guard: allow only admins through. Assumes authMiddleware ran first. */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'API key required' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Admin privileges required' });
    return;
  }
  next();
}
