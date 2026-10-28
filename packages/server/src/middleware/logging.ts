import pino from 'pino';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const env = process.env.NODE_ENV || 'development';

const REDACTED = '[REDACTED]';

/**
 * Query/param names that carry credentials: Steam `key=`, RetroAchievements
 * `y=`, and anything that looks like a key, token, secret, or password.
 */
const SENSITIVE_PARAM = /^(y|auth|authorization|sig|signature)$|key|token|secret|passw(or)?d|pwd|session|cookie/i;

/** Matches `name=value` pairs inside free text (messages, stacks, raw URLs). */
const SENSITIVE_PAIR_IN_TEXT =
  /([?&;](?:y|auth|authorization|sig|signature|[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|session|cookie)[\w.-]*)=)[^&#\s"'<>]*/gi;

/** Matches `scheme://user:pass@` credentials inside free text. */
const URL_USERINFO_IN_TEXT = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi;

/** Scrub credential-looking query pairs and URL userinfo from arbitrary text. */
export function redactText(text: string): string {
  return text.replace(URL_USERINFO_IN_TEXT, `$1${REDACTED}@`).replace(SENSITIVE_PAIR_IN_TEXT, `$1${REDACTED}`);
}

/**
 * Loggable form of a URL: userinfo (user:pass@) removed and every sensitive
 * query param value replaced with [REDACTED]. `params` mirrors axios'
 * `config.params` so keys passed that way are covered too. Unparseable input
 * falls back to text scrubbing; never throws.
 */
export function redactUrl(rawUrl: unknown, base?: unknown, params?: unknown): string | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return undefined;
  let u: URL;
  try {
    u = typeof base === 'string' && base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return redactText(rawUrl);
  }
  u.username = '';
  u.password = '';
  if (params && typeof params === 'object' && !(params instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (v !== undefined && v !== null) u.searchParams.append(k, String(v));
    }
  } else if (params instanceof URLSearchParams) {
    params.forEach((v, k) => u.searchParams.append(k, v));
  }
  for (const k of [...new Set(u.searchParams.keys())]) {
    if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, REDACTED);
  }
  // URLSearchParams percent-encodes the brackets; keep the marker readable.
  return u.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
}

type SafeErr = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Allow-list error serializer (DUN-009). pino's default `err` serializer
 * copies every enumerable property, which for an AxiosError includes
 * `config.headers['x-api-key']`, `request` (raw headers), and `response`.
 * This emits only: type, name, message, stack, code, errno, syscall, and —
 * for axios errors — method, credential-free url, status, statusText.
 * `cause` / AggregateError `errors` are serialized with the same rules
 * (depth-limited). Non-error values (e.g. a message string) are scrubbed.
 */
export function serializeError(err: unknown, depth = 0): unknown {
  if (err === null || err === undefined) return err;
  if (!isRecord(err)) return redactText(String(err));
  const out: SafeErr = {};
  const ctor = (err as { constructor?: { name?: unknown } }).constructor;
  out.type = typeof ctor?.name === 'string' && ctor.name !== 'Object' ? ctor.name : err.name;
  if (typeof err.name === 'string') out.name = err.name;
  if (typeof err.message === 'string') out.message = redactText(err.message);
  if (typeof err.stack === 'string') out.stack = redactText(err.stack);
  for (const k of ['code', 'errno', 'syscall'] as const) {
    const v = err[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = typeof v === 'string' ? redactText(v) : v;
  }
  if (err.isAxiosError === true) {
    const config = isRecord(err.config) ? err.config : {};
    if (typeof config.method === 'string') out.method = config.method.toUpperCase();
    const url = redactUrl(config.url, config.baseURL, config.params);
    if (url) out.url = url;
    const response = isRecord(err.response) ? err.response : undefined;
    if (response) {
      if (typeof response.status === 'number') out.status = response.status;
      if (typeof response.statusText === 'string') out.statusText = redactText(response.statusText);
    } else if (typeof err.status === 'number') {
      out.status = err.status;
    }
  }
  if (depth < 3) {
    if (err.cause !== undefined) out.cause = serializeError(err.cause, depth + 1);
    if (Array.isArray(err.errors)) out.aggregateErrors = err.errors.map((e: unknown) => serializeError(e, depth + 1));
  }
  return out;
}

/**
 * Defense in depth: even if a caller logs a raw config/headers object under
 * some other key, these paths are censored. Paths use pino/fast-redact syntax.
 */
export const REDACT_PATHS: string[] = [
  'err.config',
  'err.request',
  'err.response',
  'error.config',
  'error.request',
  'error.response',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["x-api-key"]',
  '*.headers["set-cookie"]',
  '*.*.headers.authorization',
  '*.*.headers.cookie',
  '*.*.headers["x-api-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'apiKey',
  'api_key',
  'password',
  'token',
  'secret',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.token',
  '*.secret',
  '*.*.apiKey',
  '*.*.password',
  '*.*.token',
  '*.*.secret',
];

export const SANITIZE_LIMITS = { maxDepth: 8, maxArrayItems: 100, maxKeys: 200 } as const;

function isErrorValue(v: unknown): v is Error {
  return v instanceof Error || (isRecord(v) && v.isAxiosError === true);
}

/**
 * Objects whose JSON form pino already produces safely (or that we must not
 * reshape): left as-is, not walked.
 */
function isOpaque(v: object): boolean {
  return (
    v instanceof Date ||
    v instanceof RegExp ||
    v instanceof Map ||
    v instanceof Set ||
    v instanceof URL ||
    v instanceof Promise ||
    ArrayBuffer.isView(v) ||
    v instanceof ArrayBuffer ||
    typeof (v as { toJSON?: unknown }).toJSON === 'function'
  );
}

/**
 * Copy-on-write deep walk (DUN-025). Replaces every Error/AxiosError at any
 * depth (incl. arrays) with serializeError(...), cycles with '[Circular]',
 * and caps depth / array length / key count with markers. Returns the SAME
 * reference when nothing needed changing, so plain objects cost one pass and
 * zero allocations; the caller's object is never mutated. `ancestors` holds
 * only the current path, so shared (non-cyclic) references are not
 * mis-flagged as circular.
 */
export function sanitizeLogValue(value: unknown, depth = 0, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isErrorValue(value)) return serializeError(value);
  if (ancestors.has(value)) return '[Circular]';
  if (isOpaque(value)) return value;
  if (depth >= SANITIZE_LIMITS.maxDepth) return '[MaxDepth]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, SANITIZE_LIMITS.maxArrayItems);
      let copy: unknown[] | undefined;
      for (let i = 0; i < limit; i++) {
        let item: unknown;
        try {
          item = sanitizeLogValue(value[i], depth + 1, ancestors);
        } catch {
          item = '[Unreadable]';
        }
        if (copy) copy.push(item);
        else if (item !== value[i]) {
          copy = value.slice(0, i);
          copy.push(item);
        }
      }
      if (value.length > limit) {
        copy ??= value.slice(0, limit);
        copy.push(`[... ${value.length - limit} more items]`);
      }
      return copy ?? value;
    }

    const src = value as Record<string, unknown>;
    const keys = Object.keys(src);
    const limit = Math.min(keys.length, SANITIZE_LIMITS.maxKeys);
    let copy: Record<string, unknown> | undefined;
    for (let i = 0; i < limit; i++) {
      const k = keys[i];
      let orig: unknown;
      let next: unknown;
      try {
        orig = src[k];
        next = sanitizeLogValue(orig, depth + 1, ancestors);
      } catch {
        // Throwing getter / exotic proxy: never let it break logging.
        next = '[Unreadable]';
        orig = Symbol('unreadable');
      }
      if (copy) copy[k] = next;
      else if (next !== orig) {
        copy = {};
        for (let j = 0; j < i; j++) copy[keys[j]] = src[keys[j]];
        copy[k] = next;
      }
    }
    if (keys.length > limit) {
      if (!copy) {
        copy = {};
        for (let j = 0; j < limit; j++) copy[keys[j]] = src[keys[j]];
      }
      copy['...'] = `[${keys.length - limit} more keys]`;
    }
    return copy ?? value;
  } finally {
    ancestors.delete(value);
  }
}

/** Interpolation-arg stand-in for an Error: same `%s` text, safe `%j`/`%o`. */
function safeErrorArg(err: Error): { toString(): string; toJSON(): unknown } {
  const text = redactText(`${String(err.name ?? 'Error')}: ${String(err.message ?? '')}`);
  const json = serializeError(err);
  return { toString: () => text, toJSON: () => json };
}

function sanitizeInterpolationArg(arg: unknown): unknown {
  if (isErrorValue(arg)) return safeErrorArg(arg);
  return sanitizeLogValue(arg);
}

/**
 * pino `hooks.logMethod` (DUN-025). pino's serializers only see top-level
 * keys, so an Error nested anywhere else (`{ nested: { e } }`,
 * `{ result: [axiosErr] }`) or passed as a `%j`/`%o` interpolation arg was
 * dumped with config/headers/request. This hook sees the raw arguments of
 * every log call (merge object AND interpolation args) and sanitizes them
 * before pino formats anything. Top-level `err`/`error` are left to the
 * serializers (so pino still derives `msg` from `err.message`); a bare
 * Error as first argument is also left to pino (it becomes `{ err }`).
 * Never throws: on any failure it logs a fixed placeholder instead.
 */
export function sanitizeLogArgs(args: unknown[]): unknown[] {
  if (args.length === 0) return args;
  const first = args[0];
  let out: unknown[] | undefined;
  // Index of the first interpolation arg: after the template string.
  let interpFrom = 1;
  if (first !== null && typeof first === 'object' && !isErrorValue(first)) {
    interpFrom = 2;
    const obj = first as Record<string, unknown>;
    let merged: Record<string, unknown> | undefined;
    const keys = Object.keys(obj);
    const limit = Math.min(keys.length, SANITIZE_LIMITS.maxKeys);
    const ancestors = new WeakSet<object>([obj]);
    for (let i = 0; i < limit; i++) {
      const k = keys[i];
      let orig: unknown;
      let next: unknown;
      try {
        orig = obj[k];
        next = k === 'err' || k === 'error' ? orig : sanitizeLogValue(orig, 1, ancestors);
      } catch {
        next = '[Unreadable]';
        orig = Symbol('unreadable');
      }
      if (merged) merged[k] = next;
      else if (next !== orig) {
        merged = {};
        for (let j = 0; j < i; j++) merged[keys[j]] = obj[keys[j]];
        merged[k] = next;
      }
    }
    if (keys.length > limit) {
      if (!merged) {
        merged = {};
        for (let j = 0; j < limit; j++) merged[keys[j]] = obj[keys[j]];
      }
      merged['...'] = `[${keys.length - limit} more keys]`;
    }
    if (merged) {
      out = args.slice();
      out[0] = merged;
    }
  } else if (first !== null && typeof first === 'object') {
    // Bare Error first: pino turns it into { err } -> serializers.err. The
    // next arg is then the template.
    interpFrom = 2;
  }
  for (let i = interpFrom; i < args.length; i++) {
    const a = args[i];
    if (a === null || typeof a !== 'object') continue;
    const next = sanitizeInterpolationArg(a);
    if (next !== a) {
      out ??= args.slice();
      out[i] = next;
    }
  }
  return out ?? args;
}

const SANITIZE_FAILED_MSG = 'log arguments could not be sanitized';

/** Overridable sink for tests via createLogger(stream). */
export function createLogger(destination?: NodeJS.WritableStream) {
  const pretty =
    env !== 'production' && !process.env.VITEST
      ? pino.transport({
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        })
      : undefined;
  const log = pino(
    {
      level: process.env.LOG_LEVEL || 'info',
      base: { service: 'dune-server' },
      // DUN-009: never let pino's default err serializer dump axios config/headers.
      serializers: { err: serializeError, error: serializeError },
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      // DUN-025: serializers only cover top-level keys; walk everything else.
      hooks: {
        logMethod(inputArgs, method) {
          let args: unknown[];
          try {
            args = sanitizeLogArgs(inputArgs);
          } catch {
            const msg = typeof inputArgs[0] === 'string' ? inputArgs[0] : typeof inputArgs[1] === 'string' ? inputArgs[1] : undefined;
            args = [{ logSanitizeFailed: true }, msg ?? SANITIZE_FAILED_MSG];
          }
          return method.apply(this, args as Parameters<typeof method>);
        },
      },
    },
    destination ?? pretty,
  );
  // DUN-059 (was DUN-040): pino writes child bindings once at child() time and
  // never passes them through hooks.logMethod (and resets formatters.bindings
  // for children), so a key or axios error bound on a child was logged raw on
  // every line. Sanitize the bindings at child() itself. pino children are
  // Object.create(parent), so this own property is inherited by every child
  // and grandchild.
  const pinoChild = log.child;
  log.child = function sanitizedChild(this: typeof log, bindings, options) {
    let safe: typeof bindings;
    try {
      safe = sanitizeLogArgs([bindings])[0] as typeof bindings;
    } catch {
      safe = { logSanitizeFailed: true };
    }
    return pinoChild.call(this, safe, options);
  } as typeof log.child;
  return log;
}

export const logger = createLogger();

export interface LoggedRequest extends Request {
  reqId?: string;
}

/**
 * Assigns a request ID and logs method/path/status/latency when the
 * response finishes. Register before all routes (incl. rate limiter)
 * so rejected requests are logged too. The `log` parameter exists for
 * tests; production callers omit it.
 */
export function requestLogger(
  req: LoggedRequest,
  res: Response,
  next: NextFunction,
  log: ReturnType<typeof createLogger> = logger,
): void {
  const reqId = randomUUID();
  req.reqId = reqId;
  const start = Date.now();
  res.on('finish', () => {
    log.info(
      { reqId, method: req.method, path: req.path, status: res.statusCode, latencyMs: Date.now() - start },
      'request',
    );
  });
  next();
}
