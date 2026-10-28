import { ProviderError, fetchTransport, isProviderError, type FetchLike, type HttpTransport } from '@dune/providers';

export type { FetchLike };

/**
 * The local HttpTransport: @dune/providers' fetchTransport over an injected
 * fetch (Electron main: `net.fetch`, tests: a fake). Raw fetch failures are
 * turned into PROVIDER_UNAVAILABLE with a fixed message, so a URL (which may
 * carry a query key) or a socket error never reaches a log or a result.
 */
export function createLocalTransport(fetchImpl: FetchLike): HttpTransport {
  const inner = fetchTransport(fetchImpl);
  return async (req) => {
    try {
      return await inner(req);
    } catch (err) {
      if (isProviderError(err)) throw err;
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'network request failed');
    }
  };
}
