/**
 * axios adapter for @dune/providers' HttpTransport. The server keeps axios
 * (route tests stay offline through `vi.mock('axios')`); the transport
 * contract is honoured here: every status is returned, redirects are NOT
 * followed (the providers' guarded client follows them and re-checks the
 * host allow-list), and timeouts / size caps become typed ProviderErrors.
 */
import axios, { type AxiosRequestConfig } from 'axios';
import { ProviderError, type HttpRequest, type HttpResponse, type HttpTransport } from '@dune/providers';

function lowerHeaders(raw: unknown): Record<string, string> {
  const src = raw && typeof (raw as { toJSON?: unknown }).toJSON === 'function'
    ? (raw as { toJSON(): Record<string, unknown> }).toJSON()
    : (raw as Record<string, unknown> | undefined) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && v !== null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

export const axiosTransport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
  const config: AxiosRequestConfig = {
    timeout: req.timeoutMs,
    validateStatus: () => true,
    maxRedirects: 0,
    maxContentLength: req.maxBytes,
    responseType: req.responseType === 'bytes' ? 'arraybuffer' : req.responseType,
    ...(req.headers ? { headers: req.headers } : {}),
  };
  try {
    const res = req.method === 'GET' ? await axios.get(req.url, config) : await axios.post(req.url, req.body, config);
    const data = req.responseType === 'bytes' && res.data instanceof ArrayBuffer ? new Uint8Array(res.data) : res.data;
    return { status: res.status, headers: lowerHeaders(res.headers), data };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') throw new ProviderError('PROVIDER_TIMEOUT', `request timed out after ${req.timeoutMs} ms`);
    if (typeof e?.message === 'string' && e.message.includes('maxContentLength')) throw new ProviderError('PROVIDER_TOO_LARGE', `response exceeds ${req.maxBytes} bytes`);
    throw err;
  }
};
