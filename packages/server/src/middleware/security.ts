import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';

// Rate limiter: 100 requests per 15 minutes per IP
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiter for upload endpoints: 20 requests per minute
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: 'Upload rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

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
    
    const allowedOrigins = [
      'http://localhost:3023',
      'http://localhost:5173',
      'http://127.0.0.1:3023',
      'http://127.0.0.1:5173',
    ];
    
    // In production, add your domain
    if (process.env.ALLOWED_ORIGINS) {
      allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(','));
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-game', 'x-path', 'x-sync-id'],
});
