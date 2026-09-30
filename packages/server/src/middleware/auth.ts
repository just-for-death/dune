import { Request, Response, NextFunction } from 'express';
import { database } from '../db/index.js';

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

  const apiKey = req.headers['x-api-key'] as string || req.query.api_key as string;
  
  if (!apiKey) {
    res.status(401).json({ success: false, message: 'API key required' });
    return;
  }

  const validKeys = database.getApiKeys();
  if (!validKeys.includes(apiKey)) {
    res.status(403).json({ success: false, message: 'Invalid API key' });
    return;
  }

  req.apiKey = apiKey;
  next();
}

export function optionalAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string || req.query.api_key as string;
  
  if (apiKey) {
    const validKeys = database.getApiKeys();
    if (validKeys.includes(apiKey)) {
      req.apiKey = apiKey;
    }
  }
  next();
}
