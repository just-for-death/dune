/**
 * One HTTP(S) download attempt into a `.part` file, resuming with Range.
 *
 * - Resumes from the `.part` file's on-disk size with `Range: bytes=N-`, and
 *   `If-Range` (strong ETag, else Last-Modified) so a changed remote file
 *   restarts from 0 instead of splicing two versions together.
 * - 206 appends; 200 (range ignored / validator changed) truncates and starts
 *   over; 416 with a matching total means the part is already complete.
 * - Redirects: http/https only, at most `maxRedirects`; auth/cookie headers
 *   are dropped when the redirect leaves the original origin.
 * - `Accept-Encoding: identity` so bytes on disk equal Content-Length.
 * - Idle timeout: no socket activity for `idleTimeoutMs` -> TIMEOUT.
 * Node built-ins only; no Electron.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { DownloadError, toDownloadError } from './errors';
import { isRedirectAllowed } from './protocol';

export interface HttpResponseInfo {
  /** Full size of the remote file, or null when the server doesn't say. */
  totalBytes: number | null;
  /** Byte offset this response starts at (0 unless resumed). */
  startByte: number;
  resumed: boolean;
  etag?: string;
  lastModified?: string;
}

export interface HttpDownloadOptions {
  url: string;
  partPath: string;
  signal: AbortSignal;
  etag?: string;
  lastModified?: string;
  expectedSize?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
  idleTimeoutMs?: number;
  /** Called after headers, before any body byte is written; throw to abort (e.g. disk space). */
  onResponse?: (info: HttpResponseInfo) => void | Promise<void>;
  /** Running total of bytes in the part file. */
  onData?: (bytesDownloaded: number, totalBytes: number | null) => void;
}

export interface HttpDownloadResult {
  bytesDownloaded: number;
  totalBytes: number | null;
  etag?: string;
  lastModified?: string;
}

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function header(res: http.IncomingMessage, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function parseContentRange(value: string | undefined): { start: number | null; total: number | null } | null {
  if (!value) return null;
  const m = /^bytes\s+(?:(\d+)-\d+|\*)\/(\d+|\*)$/i.exec(value.trim());
  if (!m) return null;
  return { start: m[1] !== undefined ? Number(m[1]) : null, total: m[2] === '*' ? null : Number(m[2]) };
}

async function partSize(partPath: string): Promise<number> {
  try {
    return (await fs.promises.stat(partPath)).size;
  } catch {
    return 0;
  }
}

function request(url: URL, headers: Record<string, string>, signal: AbortSignal, idleTimeoutMs: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = url.protocol === 'https:'
      ? https.get(url, { headers, signal }, resolve)
      : http.get(url, { headers, signal }, resolve);
    req.setTimeout(idleTimeoutMs, () => {
      req.destroy(new DownloadError('TIMEOUT', `No data for ${idleTimeoutMs} ms`, { retryable: true }));
    });
    req.on('error', reject);
  });
}

function strongEtag(etag: string | undefined): string | undefined {
  return etag && !etag.startsWith('W/') ? etag : undefined;
}

export async function downloadHttp(opts: HttpDownloadOptions): Promise<HttpDownloadResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  const origin = new URL(opts.url).origin;
  let url = new URL(opts.url);
  let startByte = await partSize(opts.partPath);
  let etag = opts.etag;
  let lastModified = opts.lastModified;
  let redirects = 0;
  let restarts = 0;

  const restartFromZero = async () => {
    if (++restarts > 2) throw new DownloadError('HTTP_ERROR', 'Server keeps rejecting the resume range', { retryable: true });
    await fs.promises.truncate(opts.partPath, 0).catch(() => undefined);
    startByte = 0;
    etag = undefined;
    lastModified = undefined;
  };

  for (;;) {
    const headers: Record<string, string> = { 'User-Agent': 'Dune-Downloader', 'Accept-Encoding': 'identity', ...opts.headers };
    if (url.origin !== origin) {
      for (const key of Object.keys(headers)) if (SENSITIVE_HEADERS.includes(key.toLowerCase())) delete headers[key];
    }
    if (startByte > 0) {
      headers.Range = `bytes=${startByte}-`;
      const validator = strongEtag(etag) ?? lastModified;
      if (validator) headers['If-Range'] = validator;
    }

    let res: http.IncomingMessage;
    try {
      res = await request(url, headers, opts.signal, idleTimeoutMs);
    } catch (err) {
      if (opts.signal.aborted) throw err;
      throw toDownloadError(err, 'NETWORK_ERROR');
    }
    const status = res.statusCode ?? 0;

    if (status >= 300 && status < 400 && header(res, 'location')) {
      res.resume();
      if (++redirects > maxRedirects) throw new DownloadError('TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects`);
      const next = new URL(header(res, 'location')!, url);
      if (!isRedirectAllowed(next.protocol)) {
        throw new DownloadError('PROTOCOL_NOT_ALLOWED', `Redirect to "${next.protocol}" is not allowed`);
      }
      if (next.username || next.password) throw new DownloadError('URL_CREDENTIALS', 'Redirect URL has embedded credentials');
      url = next;
      continue;
    }

    if (status === 416 && startByte > 0) {
      res.resume();
      const range = parseContentRange(header(res, 'content-range'));
      if (range?.total !== null && range?.total === startByte) {
        return { bytesDownloaded: startByte, totalBytes: startByte, etag, lastModified };
      }
      await restartFromZero();
      continue;
    }

    let totalBytes: number | null;
    let resumed = false;
    if (status === 206) {
      const range = parseContentRange(header(res, 'content-range'));
      if (!range || range.start !== startByte) {
        res.resume();
        await restartFromZero();
        continue;
      }
      totalBytes = range.total;
      resumed = startByte > 0;
    } else if (status >= 200 && status < 300) {
      if (startByte > 0) {
        // Range ignored or If-Range said the file changed: start over.
        await fs.promises.truncate(opts.partPath, 0).catch(() => undefined);
        startByte = 0;
      }
      const len = header(res, 'content-length');
      totalBytes = len !== undefined && /^\d+$/.test(len) ? Number(len) : null;
    } else {
      res.resume();
      throw new DownloadError('HTTP_ERROR', `Server responded ${status}`, { status, retryable: isRetryableStatus(status) });
    }

    etag = header(res, 'etag') ?? etag;
    lastModified = header(res, 'last-modified') ?? lastModified;

    if (totalBytes !== null && opts.expectedSize !== undefined && totalBytes !== opts.expectedSize) {
      res.resume();
      throw new DownloadError('SIZE_MISMATCH', `Server reports ${totalBytes} bytes, expected ${opts.expectedSize}`);
    }

    try {
      await opts.onResponse?.({ totalBytes, startByte, resumed, etag, lastModified });
    } catch (err) {
      res.destroy();
      throw err;
    }

    let bytes = startByte;
    opts.onData?.(bytes, totalBytes);
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        opts.onData?.(bytes, totalBytes);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(res, counter, fs.createWriteStream(opts.partPath, { flags: startByte > 0 ? 'a' : 'w' }), { signal: opts.signal });
    } catch (err) {
      if (opts.signal.aborted) throw err;
      throw toDownloadError(err, 'NETWORK_ERROR');
    }
    if (!res.complete) {
      throw new DownloadError('NETWORK_ERROR', 'Connection closed before the response finished', { retryable: true });
    }
    if (totalBytes !== null && bytes !== totalBytes) {
      throw new DownloadError('NETWORK_ERROR', `Received ${bytes} of ${totalBytes} bytes`, { retryable: true });
    }
    return { bytesDownloaded: bytes, totalBytes: totalBytes ?? bytes, etag, lastModified };
  }
}
