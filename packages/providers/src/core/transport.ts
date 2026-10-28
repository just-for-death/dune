import { ProviderError } from './errors.js';
import type { HttpRequest, HttpResponse, HttpTransport } from './types.js';

/** The subset of fetch the transport needs (Node's global fetch, Electron's net.fetch). */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: 'manual';
  signal: AbortSignal;
}) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  body: ReadableStream<Uint8Array> | null;
}>;

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProviderError('PROVIDER_TOO_LARGE', `response exceeds ${maxBytes} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return out;
}

/** fetch-based HttpTransport: no redirects followed, timeout covers headers + body, body capped. */
export function fetchTransport(fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): HttpTransport {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, req.timeoutMs);
    try {
      const headers = { ...req.headers };
      let body: string | undefined;
      if (req.body !== undefined) {
        body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        if (typeof req.body !== 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      }
      const res = await fetchImpl(req.url, { method: req.method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: controller.signal });
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => { outHeaders[key.toLowerCase()] = value; });
      const declared = Number(outHeaders['content-length']);
      if (Number.isFinite(declared) && declared > req.maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new ProviderError('PROVIDER_TOO_LARGE', `response exceeds ${req.maxBytes} bytes`);
      }
      const bytes = await readCapped(res.body, req.maxBytes);
      let data: unknown = bytes;
      if (req.responseType !== 'bytes') {
        const text = new TextDecoder().decode(bytes);
        data = text;
        if (req.responseType === 'json') {
          try { data = JSON.parse(text); } catch { data = text; }
        }
      }
      return { status: res.status, headers: outHeaders, data };
    } catch (err) {
      if (timedOut) throw new ProviderError('PROVIDER_TIMEOUT', `request timed out after ${req.timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
