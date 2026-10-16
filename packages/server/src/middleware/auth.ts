import { Request, Response, NextFunction } from 'express';
import { database } from '../db/index.js';
import { extractApiKey } from '../utils/authKey.js';

export interface AuthenticatedRequest extends Request {
  apiKey?: string;
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.path === '/health' || req.path === '/api/health') {
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

  if (!database.isValidApiKey(apiKey)) {
    res.status(403).json({ success: false, message: 'Invalid API key' });
    return;
  }

  req.apiKey = apiKey;
  next();
}

export function optionalAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const apiKey = extractApiKey(req.headers as Record<string, string | string[] | undefined>, req.url);

  if (apiKey) {
    if (database.isValidApiKey(apiKey)) {
      req.apiKey = apiKey;
    }
  }
  next();
}
