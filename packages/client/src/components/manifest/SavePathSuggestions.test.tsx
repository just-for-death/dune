import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavePathSuggestions, SavePathSuggestionsView, type SavePathSuggestionsViewProps } from './SavePathSuggestions';
import { normalizeManifestResult, type ManifestOutcome } from './manifestFormat';
import { I18nProvider } from '../../i18n/I18nProvider';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';

type AnyProps = {
  id?: string; role?: string; onClick?: (e?: unknown) => void; onKeyDown?: (e: unknown) => void; children?: ReactNode;
  disabled?: boolean; 'aria-disabled'?: boolean; 'aria-label'?: string; dangerouslySetInnerHTML?: unknown;
};
/** Expands hook-free function components and collects elements of `tag`. */
function collect(node: ReactNode, tag: string, out: ReactElement<AnyProps>[] = []): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) { node.forEach(n => collect(n, tag, out)); return out; }
  if (!isValidElement<AnyProps>(node)) return out;
  if (typeof node.type === 'function') return collect((node.type as (p: unknown) => ReactNode)(node.props), tag, out);
  if (node.type === tag) out.push(node);
  return collect(node.props.children, tag, out);
}
const text = (node: ReactNode): string => renderToStaticMarkup(<>{node}</>).replace(/<[^>]+>/g, '');

const A = '/home/u/.local/share/Game/save';
const B = 'C:\\Users\\u\\AppData\\Roaming\\Game\\config.ini';
const result = (over: Partial<Extract<ManifestOutcome, { kind: 'result' }>> = {}): ManifestOutcome => ({
  kind: 'result', stale: false, attribution: 'Data from PCGamingWiki (CC BY-NC-SA 3.0)', pageUrl: 'https://www.pcgamingwiki.com/wiki/Game',
  suggestions: [{ path: A, kind: 'save', exists: true }, { path: B, kind: 'config', exists: false }],
  ...over,
});
const base: SavePathSuggestionsViewProps = {
  available: true, loading: false, outcome: null, currentSavePath: null, pending: null, applying: null, applyResult: null,
  onFind: () => {}, onRequestApply: () => {}, onCancel: () => {}, onConfirm: () => {},
};
const render = (over: Partial<SavePathSuggestionsViewProps> = {}) => renderToStaticMarkup(<SavePathSuggestionsView {...base} {...over} />);
const buttons = (over: Partial<SavePathSuggestionsViewProps> = {}) => collect(SavePathSuggestionsView({ ...base, ...over }), 'button');
const byText = (list: ReactElement<AnyProps>[], label: string) => list.filter(b => text(b.props.children) === label);
const STATUS = '<div id="manifest-status" role="status" aria-live="polite"';

describe('SavePathSuggestionsView', () => {
  it('idle: only the Find button, a status region and the attribution', () => {
    const onFind = vi.fn();
    const [btn] = buttons({ onFind });
    expect(btn.props.children).toBe(en['manifest.findButton']);
    expect(btn.props['aria-disabled']).toBeUndefined();
    btn.props.onClick?.();
    expect(onFind).toHaveBeenCalledTimes(1);
    const html = render();
    expect(html).toContain(STATUS);
    expect(html).toContain(en['privacy.manifestAttribution']);
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<a ');
  });

  it('loading: aria-disabled button that says Looking up… and ignores clicks; old result hidden', () => {
    const onFind = vi.fn();
    const [btn] = buttons({ loading: true, onFind, outcome: result() });
    expect(btn.props['aria-disabled']).toBe(true);
    expect(btn.props.children).toBe(en['manifest.loading']);
    btn.props.onClick?.();
    expect(onFind).not.toHaveBeenCalled();
    const html = render({ loading: true, outcome: result() });
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(A);
  });

  it('result: path in a code span, kind and exists/not-found badges with icon + text, attribution and https wiki link', () => {
    const html = render({ outcome: result() });
    expect(html).toContain(`<code style="`);
    expect(html).toContain(`>${A}</code>`);
    expect(html).toContain('>C:\\Users\\u\\AppData\\Roaming\\Game\\config.ini</code>');
    expect(html).toMatch(/overflow-wrap:anywhere/);
    expect(html).toContain(`>${en['manifest.kindSave']}</span>`);
    expect(html).toContain(`>${en['manifest.kindConfig']}</span>`);
    expect(html).toContain(`<span aria-hidden="true" style="color:var(--green)">✓</span> ${en['manifest.exists']}`);
    expect(html).toContain(`<span aria-hidden="true" style="color:var(--red)">✕</span> ${en['manifest.missing']}`);
    expect(html).toContain('Data from PCGamingWiki (CC BY-NC-SA 3.0)');
    expect(html).toContain(`<a href="https://www.pcgamingwiki.com/wiki/Game" target="_blank" rel="noopener noreferrer">${en['manifest.viewOnWiki']}`);
    expect(html).toContain(`aria-label="${en['manifest.listLabel']}"`);
    // Paths are never links.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(buttons({ outcome: result() }).filter(b => b.props['aria-label']?.startsWith(en['manifest.useButton']))).toHaveLength(2);
  });

  it('missing attribution falls back to the standard credit', () => {
    expect(render({ outcome: result({ attribution: '' }) })).toContain(en['privacy.manifestAttribution']);
  });

  it('no link for http, javascript:, data:, relative or null pageUrl replies', () => {
    for (const pageUrl of ['http://www.pcgamingwiki.com/wiki/Game', 'javascript:alert(1)', 'data:text/html,<b>x</b>', '/wiki/Game', 'wiki/Game', '', null]) {
      const outcome = normalizeManifestResult({ ok: true, suggestions: [{ path: A, kind: 'save', exists: true }], attribution: 'Attr', pageUrl });
      const html = render({ outcome });
      expect(html, String(pageUrl)).not.toContain('<a ');
      expect(html, String(pageUrl)).not.toContain(en['manifest.viewOnWiki']);
      expect(html, String(pageUrl)).toContain('Attr');
    }
    expect(render({ outcome: result({ pageUrl: null }) })).not.toContain('<a ');
    expect(render({ outcome: result({ pageUrl: null }) })).not.toContain(en['manifest.viewOnWiki']);
  });

  it('renders a <script> path as text, never as HTML', () => {
    const path = '/home/u/<script>alert(1)</script>/<img src=x onerror=alert(2)>';
    const html = render({ outcome: result({ suggestions: [{ path, kind: 'save', exists: false }] }), pending: path });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const codes = collect(SavePathSuggestionsView({ ...base, outcome: result({ suggestions: [{ path, kind: 'save', exists: false }] }), pending: path }), 'code');
    expect(codes).toHaveLength(2); // list item + confirm step
    for (const c of codes) {
      expect(c.props.children).toBe(path);
      expect(c.props.dangerouslySetInnerHTML).toBeUndefined();
    }
  });

  it('stale shows the may-be-out-of-date note inside the status region', () => {
    const html = render({ outcome: result({ stale: true }) });
    const status = html.slice(html.indexOf(STATUS));
    expect(status).toContain(en['manifest.stale']);
    expect(render({ outcome: result() })).not.toContain(en['manifest.stale']);
  });

  it('empty list shows no suggestions (with attribution), no list', () => {
    const html = render({ outcome: result({ suggestions: [] }) });
    expect(html).toContain(en['manifest.empty']);
    expect(html).not.toContain('<ul');
    expect(html).toContain('Data from PCGamingWiki');
  });

  it('maps each error to its message; only network/unavailable codes offer a retry that re-runs the lookup', () => {
    const cases: [string, string, boolean][] = [
      ['PROVIDER_DISABLED', en['manifest.errorDisabled'], false],
      ['GAME_NOT_FOUND', en['manifest.errorNotFound'], false],
      ['MANIFEST_NOT_FOUND', en['manifest.errorNotFound'], false],
      ['MANIFEST_UNAVAILABLE', en['manifest.errorNetwork'], true],
      ['NETWORK', en['manifest.errorNetwork'], true],
      ['UNREACHABLE', en['manifest.errorNetwork'], true],
      ['PROVIDER_TIMEOUT', en['manifest.errorNetwork'], true],
      ['PROVIDER_UNAVAILABLE', en['manifest.errorNetwork'], true],
      ['INVALID_GAME_ID', en['manifest.errorGeneric'], false],
      ['SOMETHING_ELSE', en['manifest.errorGeneric'], false],
    ];
    for (const [code, message, retry] of cases) {
      const html = render({ outcome: { kind: 'error', code } });
      expect(html.slice(html.indexOf(STATUS)), code).toContain(message);
      const onFind = vi.fn();
      const retries = byText(buttons({ outcome: { kind: 'error', code }, onFind }), en['manifest.retry']);
      expect(retries, code).toHaveLength(retry ? 1 : 0);
      retries[0]?.props.onClick?.();
      expect(onFind, code).toHaveBeenCalledTimes(retry ? 1 : 0);
    }
    expect(en['manifest.errorDisabled']).toMatch(/turned off in Privacy/);
    expect(en['manifest.errorNotFound']).toMatch(/no manifest entry for this game/);
  });

  it('Use this path asks for confirmation (never applies directly) and is disabled for the current path', () => {
    const onRequestApply = vi.fn();
    const onConfirm = vi.fn();
    const list = buttons({ outcome: result(), currentSavePath: `${A}/`, onRequestApply, onConfirm });
    const [useA] = list.filter(b => b.props['aria-label'] === `${en['manifest.useButton']}: ${A}`);
    const [useB] = list.filter(b => b.props['aria-label'] === `${en['manifest.useButton']}: ${B}`);
    expect(useA.props.disabled).toBe(true);
    useA.props.onClick?.({ currentTarget: null });
    expect(onRequestApply).not.toHaveBeenCalled();
    expect(useB.props.disabled).toBe(false);
    useB.props.onClick?.({ currentTarget: null });
    expect(onRequestApply).toHaveBeenCalledWith(B, null);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(render({ outcome: result(), currentSavePath: A })).toContain(en['manifest.current']);
  });

  it('confirm step shows the full path; Cancel and Escape cancel, Confirm confirms', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const props = { outcome: result(), pending: B, onCancel, onConfirm };
    const html = render(props);
    expect(html).toContain('role="group" aria-labelledby="manifest-confirm-title" aria-describedby="manifest-confirm-body"');
    expect(html).toContain(en['manifest.confirmTitle']);
    expect(html).toContain('aria-expanded="true" aria-controls="manifest-confirm"');
    const [cancel] = byText(buttons(props), en['common.cancel']);
    const [confirm] = byText(buttons(props), en['manifest.confirm']);
    cancel.props.onClick?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    const [group] = collect(SavePathSuggestionsView({ ...base, ...props }), 'div').filter(d => d.props.role === 'group');
    const ev = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    group.props.onKeyDown?.(ev);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(ev.preventDefault).toHaveBeenCalled();
    group.props.onKeyDown?.({ key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onCancel).toHaveBeenCalledTimes(2);
    confirm.props.onClick?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(render({ outcome: result() })).not.toContain('role="group"');
  });

  it('applying / applied / failed states', () => {
    const applyingHtml = render({ outcome: result(), applying: B });
    expect(applyingHtml).toContain(en['manifest.applying']);
    const onRequestApply = vi.fn();
    const [useA] = buttons({ outcome: result(), applying: B, onRequestApply }).filter(b => b.props['aria-label']?.endsWith(A));
    expect(useA.props['aria-disabled']).toBe(true);
    useA.props.onClick?.({ currentTarget: null });
    expect(onRequestApply).not.toHaveBeenCalled();
    expect(render({ outcome: result(), applyResult: { kind: 'applied', path: B } })).toContain(en['manifest.applied']);
    expect(render({ outcome: result(), applyResult: { kind: 'failed', path: B } })).toContain(en['manifest.applyError']);
  });

  it('unavailable bridge: a status note instead of the button', () => {
    const html = render({ available: false });
    expect(html).not.toContain('<button');
    expect(html).toContain('role="status"');
    expect(html).toContain(en['manifest.unavailable']);
    expect(html).toContain(en['privacy.manifestAttribution']);
  });
});

describe('SavePathSuggestions', () => {
  it('does not fetch on render; shows the Find button when the bridge has getManifestSuggestions', () => {
    const api = { getManifestSuggestions: vi.fn() };
    const html = renderToStaticMarkup(<SavePathSuggestions gameId="g1" api={api} onApply={() => {}} />);
    expect(html).toContain(en['manifest.findButton']);
    expect(api.getManifestSuggestions).not.toHaveBeenCalled();
  });

  it('missing API (bridge without the method, or no window bridge) shows the unavailable note', () => {
    expect(renderToStaticMarkup(<SavePathSuggestions gameId="g1" api={{}} onApply={() => {}} />)).toContain(en['manifest.unavailable']);
    expect(renderToStaticMarkup(<SavePathSuggestions gameId="g1" api={null} onApply={() => {}} />)).toContain(en['manifest.unavailable']);
    // Node test env: no window, so the default bridge is missing too.
    expect(renderToStaticMarkup(<SavePathSuggestions gameId="g1" onApply={() => {}} />)).toContain(en['manifest.unavailable']);
  });

  it('renders in Spanish', () => {
    const withApi = renderToStaticMarkup(
      <I18nProvider initialLocale="es"><SavePathSuggestions gameId="g1" api={{ getManifestSuggestions: vi.fn() }} onApply={() => {}} /></I18nProvider>,
    );
    expect(withApi).toContain(es['manifest.title'] as string);
    expect(withApi).toContain(es['manifest.findButton'] as string);
    expect(withApi).toContain(es['privacy.manifestAttribution'] as string);
    const missing = renderToStaticMarkup(
      <I18nProvider initialLocale="es"><SavePathSuggestions gameId="g1" api={{}} onApply={() => {}} /></I18nProvider>,
    );
    expect(missing).toContain(es['manifest.unavailable'] as string);
  });

  it('every manifest.* key has Spanish text', () => {
    const keys = Object.keys(en).filter(k => k.startsWith('manifest.'));
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(es[k as keyof typeof es], k).toBeTruthy();
  });
});
