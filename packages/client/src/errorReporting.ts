// Renderer-side crash reporting. Forwards window errors to the main
// process error log (see electron/main.ts) and keeps a console trace.
// Imported once from main.tsx — never blocks rendering.

interface RendererBridge {
  reportRendererError?: (report: { message: string; stack?: string; url?: string }) => Promise<unknown>;
}

function bridge(): RendererBridge | null {
  try {
    const api = (window as unknown as { electronAPI?: RendererBridge }).electronAPI;
    return api ?? null;
  } catch {
    return null;
  }
}

function report(kind: string, message: string, stack?: string): void {
  try {
    console.error(`[dune:${kind}]`, message);
  } catch { /* console must never throw */ }
  try {
    void bridge()?.reportRendererError?.({ message, stack, url: window.location.href });
  } catch { /* reporting must never throw */ }
}

export function initErrorReporting(): void {
  window.addEventListener('error', (event) => {
    report('window-error', event.message || 'unknown window error', event.error?.stack);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as Error | undefined;
    report('unhandled-rejection', reason?.message || String(event.reason), reason?.stack);
  });
}
