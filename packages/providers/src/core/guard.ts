import { ProviderError, isProviderError } from './errors.js';
import { redactUrl, safeErrorMessage } from './redact.js';
import { noopLogger, type HttpMethod, type HttpResponse, type HttpTransport, type ProviderId, type ProviderLogger, type ResponseType } from './types.js';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

/** Exact host, or `*.example.com` for any subdomain (not the apex). */
export function isHostAllowed(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return hosts.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e;
  });
}

/** Parse and check a URL: https only, default port, host on the allow-list. Throws PROVIDER_HOST_BLOCKED. */
export function assertAllowedUrl(raw: string, hosts: readonly string[]): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderError('PROVIDER_HOST_BLOCKED', 'invalid URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port !== '' && u.port !== '443') || !isHostAllowed(u.hostname, hosts)) {
    throw new ProviderError('PROVIDER_HOST_BLOCKED', `host not allowed: ${u.protocol}//${u.hostname}`);
  }
  return u;
}

export interface GuardedRequest {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  responseType?: ResponseType;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface GuardedClientOptions {
  provider: ProviderId;
  hosts: readonly string[];
  transport: HttpTransport;
  logger?: ProviderLogger;
  /** Live secrets (keys, tokens) to scrub from anything logged. */
  secrets?: () => readonly (string | null | undefined)[];
  timeoutMs?: number;
  maxBytes?: number;
}

export interface GuardedClient {
  request(url: string, init?: GuardedRequest): Promise<HttpResponse>;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * The only way a provider reaches the network. Every hop (including each
 * redirect) is checked against the allow-list BEFORE the transport is called.
 * Transport failures are rethrown as ProviderError with a redacted message.
 */
export function createGuardedClient(opts: GuardedClientOptions): GuardedClient {
  const logger = opts.logger ?? noopLogger;
  const secrets = () => opts.secrets?.() ?? [];
  return {
    async request(url, init = {}) {
      let method: HttpMethod = init.method ?? 'GET';
      let body = init.body;
      let current = assertAllowedUrl(url, opts.hosts);
      for (let hop = 0; ; hop++) {
        let res: HttpResponse;
        try {
          res = await opts.transport({
            method,
            url: current.toString(),
            ...(init.headers ? { headers: init.headers } : {}),
            ...(body !== undefined ? { body } : {}),
            responseType: init.responseType ?? 'json',
            timeoutMs: init.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBytes: init.maxBytes ?? opts.maxBytes ?? DEFAULT_MAX_BYTES,
          });
        } catch (err) {
          const code = isProviderError(err) ? err.code : 'PROVIDER_UNAVAILABLE';
          const message = safeErrorMessage(err, secrets());
          logger.warn({ provider: opts.provider, url: redactUrl(current.toString(), secrets()), code, message }, 'Provider request failed');
          throw new ProviderError(code, message);
        }
        const location = res.headers['location'];
        if (!REDIRECT.has(res.status) || !location) return res;
        if (hop >= MAX_REDIRECTS) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'too many redirects');
        let next: URL;
        try {
          next = assertAllowedUrl(new URL(location, current).toString(), opts.hosts);
        } catch (err) {
          logger.warn({ provider: opts.provider, url: redactUrl(current.toString(), secrets()), code: 'PROVIDER_HOST_BLOCKED' }, 'Provider redirect blocked');
          throw err;
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        current = next;
      }
    },
  };
}
