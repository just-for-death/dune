// DUN-063: the renderer holds window.electronAPI, so no other page may ever
// load in an app window. Navigation is allowed only to the app itself (the
// Vite dev server origin, or the packaged index.html file); window.open and
// <webview> are always denied. Only http(s) links leave the app, through the
// OS browser (shell.openExternal), after URL parsing.

export interface AppLocation {
  /** VITE_DEV_SERVER_URL in development. */
  devServerUrl?: string;
  /** file:// URL of the packaged index.html. */
  indexFileUrl?: string;
}

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

/** True only for the app's own origin (dev) or its own index.html file (packaged). */
export function isAppUrl(url: string, app: AppLocation): boolean {
  const u = parse(url);
  if (!u) return false;
  if (app.devServerUrl) {
    const dev = parse(app.devServerUrl);
    if (dev && (dev.protocol === 'http:' || dev.protocol === 'https:') && u.origin === dev.origin) return true;
  }
  if (app.indexFileUrl) {
    const index = parse(app.indexFileUrl);
    if (index && index.protocol === 'file:' && u.protocol === 'file:' && u.host === index.host && u.pathname === index.pathname) return true;
  }
  return false;
}

/** The normalized URL if it is a plain http(s) link without credentials, else null. */
export function externalHttpUrl(url: string): string | null {
  const u = parse(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.href;
}

export interface GuardOptions {
  app: AppLocation;
  openExternal: (url: string) => Promise<void> | void;
  log?: (message: string) => void;
}

export interface NavigationGuards {
  /** For 'will-navigate' and 'will-redirect'. */
  willNavigate: (event: { preventDefault(): void }, url: string) => void;
  /** For 'will-attach-webview': always denied. */
  willAttachWebview: (event: { preventDefault(): void }) => void;
  /** For setWindowOpenHandler: always deny; http(s) links go to the OS browser. */
  windowOpen: (details: { url: string }) => { action: 'deny' };
}

/** Wire with `app.on('web-contents-created', ...)` so every webContents gets them. */
export function createNavigationGuards(opts: GuardOptions): NavigationGuards {
  const log = opts.log ?? ((m: string) => console.warn(m));
  return {
    willNavigate: (event, url) => {
      if (isAppUrl(url, opts.app)) return;
      event.preventDefault();
      log(`[security] blocked navigation to ${String(url).slice(0, 200)}`);
    },
    willAttachWebview: (event) => {
      event.preventDefault();
      log('[security] blocked <webview>');
    },
    windowOpen: ({ url }) => {
      const external = externalHttpUrl(url);
      if (external) {
        Promise.resolve()
          .then(() => opts.openExternal(external))
          .catch((e: unknown) => log(`[security] openExternal failed: ${String(e)}`));
      } else {
        log(`[security] denied window.open for ${String(url).slice(0, 200)}`);
      }
      return { action: 'deny' };
    },
  };
}
