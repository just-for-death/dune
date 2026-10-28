import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateCheck, UpdateCheckView, type UpdateCheckViewProps } from './UpdateCheck';
import type { UpdateOutcome } from './updateFormat';
import { I18nProvider } from '../../i18n/I18nProvider';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';

type AnyProps = { id?: string; onClick?: () => void; onChange?: (e: unknown) => void; children?: ReactNode; 'aria-disabled'?: boolean };
/** Expands hook-free function components and collects elements of `tag`. */
function collect(node: ReactNode, tag: string, out: ReactElement<AnyProps>[] = []): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) { node.forEach(n => collect(n, tag, out)); return out; }
  if (!isValidElement<AnyProps>(node)) return out;
  if (typeof node.type === 'function') return collect((node.type as (p: unknown) => ReactNode)(node.props), tag, out);
  if (node.type === tag) out.push(node);
  return collect(node.props.children, tag, out);
}

const base: UpdateCheckViewProps = { available: true, autoEnabled: false, onToggle: () => {}, checking: false, outcome: null, onCheck: () => {}, timeZone: 'UTC' };
const render = (over: Partial<UpdateCheckViewProps> = {}) => renderToStaticMarkup(<UpdateCheckView {...base} {...over} />);
const newer = (over: Record<string, unknown> = {}, stale = false): UpdateOutcome => ({
  kind: 'result', stale,
  update: { version: '1.2.0', current: '1.1.0', releaseUrl: 'https://github.com/dune/dune/releases/tag/v1.2.0', notes: 'Line one\nLine two', isNewer: true, publishedAt: '2026-10-01T12:00:00Z', ...over },
});

describe('UpdateCheckView', () => {
  it('automatic switch is off by default, labelled, with the hint; toggling calls onToggle (the save)', () => {
    const html = render();
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).not.toContain('checked=""');
    expect(html).toContain(en['updates.autoLabel']);
    expect(html).toContain(en['updates.autoHint']);
    expect(html).toContain('aria-describedby="updates-auto-hint"');
    const onToggle = vi.fn();
    const [sw] = collect(UpdateCheckView({ ...base, onToggle }), 'input');
    sw.props.onChange?.({ target: { checked: true } });
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(render({ autoEnabled: true })).toContain('checked=""');
  });

  it('the manual button works with automatic checks off, and shows Checking… with aria-disabled while running', () => {
    const onCheck = vi.fn();
    const [btn] = collect(UpdateCheckView({ ...base, autoEnabled: false, onCheck }), 'button');
    expect(btn.props['aria-disabled']).toBeUndefined();
    expect(btn.props.children).toBe(en['updates.checkButton']);
    btn.props.onClick?.();
    expect(onCheck).toHaveBeenCalledTimes(1);
    const [busy] = collect(UpdateCheckView({ ...base, checking: true, onCheck }), 'button');
    expect(busy.props['aria-disabled']).toBe(true);
    expect(busy.props.children).toBe(en['updates.checking']);
    busy.props.onClick?.();
    expect(onCheck).toHaveBeenCalledTimes(1);
    const html = render({ checking: true });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('<div id="updates-status" role="status" aria-live="polite"');
  });

  it('latest version', () => {
    const html = render({ outcome: { kind: 'result', stale: false, update: { version: '1.1.0', current: '1.1.0', releaseUrl: 'https://x.test/r', notes: 'n', isNewer: false } } });
    expect(html).toContain('You’re on the latest version (1.1.0).');
    expect(html).not.toContain(en['updates.viewRelease']);
    expect(html).not.toContain(en['updates.stale']);
  });

  it('newer version: version text, published date, notes and an https View release link', () => {
    const html = render({ outcome: newer() });
    expect(html).toContain('Version 1.2.0 is available (you have 1.1.0).');
    expect(html).toContain('Published Oct 1, 2026');
    expect(html).toContain('<a href="https://github.com/dune/dune/releases/tag/v1.2.0" target="_blank" rel="noopener noreferrer">View release</a>');
    expect(html).toMatch(/white-space:pre-wrap[^"]*max-height:200px[^"]*overflow-y:auto/);
    expect(html).toContain('>Line one\nLine two</div>');
  });

  it('renders notes as plain text, never as HTML', () => {
    const notes = '<img src=x onerror="alert(1)"> **bold** <script>alert(2)</script> [x](javascript:alert(3))';
    const html = render({ outcome: newer({ notes }) });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<strong>bold');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; **bold** &lt;script&gt;alert(2)&lt;/script&gt;');
    const [region] = collect(UpdateCheckView({ ...base, outcome: newer({ notes }) }), 'div').filter(d => (d.props as { role?: string }).role === 'region');
    expect(region.props.children).toBe(notes);
    expect((region.props as { dangerouslySetInnerHTML?: unknown }).dangerouslySetInnerHTML).toBeUndefined();
  });

  it('links the release only when it is https', () => {
    for (const releaseUrl of ['http://example.com/r', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/rel', 'junk', '']) {
      const html = render({ outcome: newer({ releaseUrl }) });
      expect(html).not.toContain('<a ');
      expect(html).not.toContain(en['updates.viewRelease']);
      expect(html).toContain('Version 1.2.0 is available');
    }
  });

  it('stale shows the cached result plus the note; no date or notes when absent', () => {
    const html = render({ outcome: newer({ publishedAt: undefined, notes: '  ' }, true) });
    expect(html).toContain(en['updates.stale']);
    expect(html).toContain('showing cached result');
    expect(html).not.toContain('Published');
    expect(html).not.toContain('role="region"');
    const latest = render({ outcome: { kind: 'result', stale: true, update: { version: '1', current: '1', releaseUrl: '', notes: '', isNewer: false } } });
    expect(latest).toContain(en['updates.stale']);
  });

  it('maps errors to messages', () => {
    expect(render({ outcome: { kind: 'error', code: 'PROVIDER_DISABLED' } })).toContain(en['updates.errorDisabled']);
    expect(render({ outcome: { kind: 'error', code: 'NETWORK' } })).toContain(en['updates.errorNetwork']);
    expect(render({ outcome: { kind: 'error', code: 'PROVIDER_UNAVAILABLE' } })).toContain(en['updates.errorNetwork']);
    expect(render({ outcome: { kind: 'error', code: 'WHATEVER' } })).toContain(en['updates.errorGeneric']);
  });

  it('hides the previous result while a new check runs', () => {
    expect(render({ checking: true, outcome: newer() })).not.toContain('Version 1.2.0');
  });

  it('unavailable bridge: a status note instead of the button; the switch still saves', () => {
    const html = render({ available: false });
    expect(html).not.toContain('<button');
    expect(html).toContain(`role="status"`);
    expect(html).toContain(en['updates.unavailable']);
    expect(html.match(/role="switch"/g)).toHaveLength(1);
  });

  it('has Spanish strings', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="es"><UpdateCheck api={{}} settings={{}} onToggle={() => {}} /></I18nProvider>,
    );
    expect(html).toContain(es['updates.autoLabel'] as string);
    expect(html).toContain(es['updates.unavailable'] as string);
  });
});

describe('UpdateCheck', () => {
  it('shows the button when the bridge has checkForUpdates, and reads updateCheckEnabled (off unless true)', () => {
    const api = { checkForUpdates: vi.fn() };
    const off = renderToStaticMarkup(<UpdateCheck api={api} settings={{}} onToggle={() => {}} />);
    expect(off).toContain(en['updates.checkButton']);
    expect(off).not.toContain('checked=""');
    expect(renderToStaticMarkup(<UpdateCheck api={api} settings={{ updateCheckEnabled: true }} onToggle={() => {}} />)).toContain('checked=""');
    expect(api.checkForUpdates).not.toHaveBeenCalled(); // no automatic check from the renderer
  });

  it('missing bridge: unavailable note', () => {
    expect(renderToStaticMarkup(<UpdateCheck api={undefined} settings={{}} onToggle={() => {}} />)).toContain(en['updates.unavailable']);
  });
});
