/**
 * The ONLY file in electron/providers that imports Electron. Everything else
 * is plain Node and unit-tested with fakes; this just binds the real
 * net.fetch, safeStorage and userData path.
 */
import { app, net, safeStorage } from 'electron';
import type { ProviderLogger } from '@dune/providers';
import { createLocalProviders, type LocalProviders } from './localProviders';
import type { LocalFlagsSource } from './types';

export function createElectronLocalProviders(flags: LocalFlagsSource, opts: { logger?: ProviderLogger; warn?: (message: string) => void } = {}): LocalProviders {
  return createLocalProviders({
    userDataDir: app.getPath('userData'),
    fetch: net.fetch,
    crypto: safeStorage,
    flags,
    appVersion: app.getVersion(),
    ...opts,
  });
}
