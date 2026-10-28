/**
 * PROPOSAL ONLY: nothing imports or registers this yet. main.ts, preload.ts
 * and @dune/shared (ElectronAPI) are owned elsewhere; this records the
 * suggested local-mode IPC surface so they can be wired in one pass.
 *
 * Every handler resolves to the app's ServerResult contract
 * `{ ok: true, ...body } | { ok: false, status?, code, message }` and never
 * rejects. Disabled -> `{ ok: false, code: 'PROVIDER_DISABLED' }` (no network).
 * Keys are write-only: the renderer only ever sees `{ set, unreadable? }`.
 * Image bytes never cross IPC: main saves the thumbnail and returns its path.
 *
 * Handler sketch (main.ts):
 *   const local = createElectronLocalProviders(() => {
 *     const s = store.get('settings') as Settings | undefined;
 *     return { hltbEnabled: s?.hltbEnabled, artworkEnabled: s?.artworkEnabled, updateCheckEnabled: isUpdateCheckEnabled(s) };
 *   });
 *   ipcMain.handle(LOCAL_PROVIDER_CHANNELS.setKey, (_e, provider, key) => local.setKey(provider, key));
 *   ipcMain.handle(LOCAL_PROVIDER_CHANNELS.fetchArt, async (_e, gameId) => {
 *     // find game by parseGameId(gameId) -> local.searchArt(game.name) -> local.downloadArt(results[0])
 *     // -> write bytes with the existing thumbnail writer -> { ok: true, thumbnail }
 *   });
 */
import type { UpdateInfo } from '@dune/providers';
import type { LocalKeyProvider, LocalResult } from './types';
import type { LocalHltbTimes } from './localProviders';

export const LOCAL_PROVIDER_CHANNELS = {
  getKeyStatus: 'local-providers:key-status',
  setKey: 'local-providers:set-key',
  clearKey: 'local-providers:clear-key',
  getHltbTimes: 'local-providers:hltb',
  searchArt: 'local-providers:art-search',
  fetchArt: 'local-providers:art-fetch',
  checkForUpdates: 'local-providers:update-check',
  clearCache: 'local-providers:clear-cache',
} as const;

/** Proposed ElectronAPI members (preload -> ipcRenderer.invoke(channel, ...args)). */
export interface LocalProvidersElectronAPI {
  getLocalProviderKeyStatus(provider: LocalKeyProvider): Promise<LocalResult<{ set: boolean; unreadable?: true }>>;
  setLocalProviderKey(provider: LocalKeyProvider, key: string): Promise<LocalResult<{ set: true }>>;
  clearLocalProviderKey(provider: LocalKeyProvider): Promise<LocalResult<{ set: false }>>;
  getLocalHLTBTimes(gameName: string): Promise<LocalResult<{ times: LocalHltbTimes; stale?: true }>>;
  searchLocalArt(query: string): Promise<LocalResult<{ results: string[] }>>;
  /** Same result shape as fetchArt (FetchArtResult): `{ ok: true, thumbnail }`. */
  fetchLocalArt(gameId: number): Promise<LocalResult<{ thumbnail: string }>>;
  /** Manual check (always runs; the click is the opt-in). Notes are plain text (render as text, never HTML). Nothing is downloaded. */
  checkLocalUpdate(opts?: { force?: boolean }): Promise<LocalResult<{ update: UpdateInfo; stale?: true }>>;
  clearLocalProviderCache(): Promise<LocalResult<{ cleared: true }>>;
}
