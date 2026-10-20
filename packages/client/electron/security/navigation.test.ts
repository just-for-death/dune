import { describe, it, expect, vi } from 'vitest';
import { createNavigationGuards, externalHttpUrl, isAppUrl } from './navigation';

const packaged = { indexFileUrl: 'file:///opt/Dune/resources/app/dist/index.html' };
const dev = { devServerUrl: 'http://localhost:5173/' };

function ev() {
  return { preventDefault: vi.fn() };
}

describe('DUN-063 isAppUrl', () => {
  it('accepts only the app origin (dev) or its own index file (packaged)', () => {
    expect(isAppUrl('http://localhost:5173/#/settings', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('http://localhost.evil.com:5173/', dev)).toBe(false);
    expect(isAppUrl('file:///opt/Dune/resources/app/dist/index.html#/games', packaged)).toBe(true);
    expect(isAppUrl('file:///etc/passwd', packaged)).toBe(false);
    expect(isAppUrl('file:///opt/Dune/resources/app/dist/other.html', packaged)).toBe(false);
    expect(isAppUrl('https://evil.example/', packaged)).toBe(false);
    expect(isAppUrl('not a url', { ...dev, ...packaged })).toBe(false);
  });
});

describe('DUN-063 externalHttpUrl', () => {
  it.each([
    ['https://store.steampowered.com/app/374320', 'https://store.steampowered.com/app/374320'],
    ['http://example.com', 'http://example.com/'],
  ])('allows %s', (input, out) => expect(externalHttpUrl(input)).toBe(out));
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'steam://rungameid/1', 'smb://host/share', 'https://user:pw@example.com/', 'nonsense', ''])(
    'refuses %s', (input) => expect(externalHttpUrl(input)).toBeNull(),
  );
});

describe('DUN-063 guards', () => {
  it('blocks off-app navigation, never blocks the app itself', () => {
    const g = createNavigationGuards({ app: packaged, openExternal: vi.fn(), log: () => {} });
    const bad = ev();
    g.willNavigate(bad, 'https://evil.example/phish');
    expect(bad.preventDefault).toHaveBeenCalled();
    const good = ev();
    g.willNavigate(good, 'file:///opt/Dune/resources/app/dist/index.html');
    expect(good.preventDefault).not.toHaveBeenCalled();
  });

  it('denies every window.open; only http(s) goes to openExternal', async () => {
    const openExternal = vi.fn();
    const g = createNavigationGuards({ app: dev, openExternal, log: () => {} });
    expect(g.windowOpen({ url: 'https://howlongtobeat.com/game/1' })).toEqual({ action: 'deny' });
    expect(g.windowOpen({ url: 'file:///home/jane/.ssh/id_rsa' })).toEqual({ action: 'deny' });
    expect(g.windowOpen({ url: 'http://localhost:5173/' })).toEqual({ action: 'deny' });
    await new Promise((r) => setTimeout(r, 0));
    expect(openExternal.mock.calls).toEqual([['https://howlongtobeat.com/game/1'], ['http://localhost:5173/']]);
  });

  it('always blocks <webview>; an openExternal failure is logged, not thrown', async () => {
    const log = vi.fn();
    const g = createNavigationGuards({ app: dev, openExternal: () => Promise.reject(new Error('no browser')), log });
    const e = ev();
    g.willAttachWebview(e);
    expect(e.preventDefault).toHaveBeenCalled();
    g.windowOpen({ url: 'https://example.com/' });
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/openExternal failed/));
  });
});
