import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Settings } from '@dune/shared';
import { HltbToggle, PrivacyToggles, PrivacyTogglesView, type ServerSwitchState } from './PrivacyToggles';
import type { PrivacySettings } from './privacyToggleHelpers';
import { I18nProvider } from '../../i18n/I18nProvider';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';

type Props = { id?: string; type?: string; checked?: boolean; onChange?: (e: unknown) => void; children?: ReactNode };

/** Expands hook-free function components and collects every <input>. */
function inputs(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) { node.forEach(n => inputs(n, out)); return out; }
  if (!isValidElement<Props>(node)) return out;
  if (typeof node.type === 'function') return inputs((node.type as (p: unknown) => ReactNode)(node.props), out);
  if (node.type === 'input') out.push(node);
  return inputs(node.props.children, out);
}

const byId = (list: ReactElement<Props>[], id: string) => {
  const el = list.find(i => i.props.id === id);
  if (!el) throw new Error(`no input #${id}`);
  return el;
};

describe('PrivacyToggles', () => {
  it('renders every switch off by default', () => {
    const html = renderToStaticMarkup(<PrivacyToggles settings={{}} onChange={() => {}} />);
    expect(html.match(/role="switch"/g)).toHaveLength(4);
    expect(html).not.toContain('checked=""');
    const list = inputs(PrivacyTogglesView({ settings: {}, onChange: () => {} }));
    expect(list).toHaveLength(4);
    for (const i of list) expect(i.props.checked).toBe(false);
  });

  it('labels each switch and says nothing is contacted while off', () => {
    const html = renderToStaticMarkup(<PrivacyToggles settings={{}} onChange={() => {}} />);
    for (const id of ['steam', 'retroAchievements', 'gog']) {
      expect(html).toContain(`for="privacy-tracker-${id}"`);
      expect(html).toContain(`aria-describedby="privacy-tracker-${id}-hint"`);
    }
    expect(html).toContain('for="privacy-artwork"');
    for (const name of ['Steam', 'RetroAchievements', 'GOG']) {
      expect(html).toContain(`Use ${name} achievements`);
      expect(html).toContain(`Off: Dune never contacts ${name}.`);
    }
    expect(html).toContain(en['privacy.artworkLabel']);
    expect(html).toContain('Off: Dune never contacts SteamGridDB');
    expect(html).toContain('<legend');
  });

  it('shows Spanish strings for the es locale', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="es"><PrivacyToggles settings={{}} onChange={() => {}} /></I18nProvider>,
    );
    expect(html).toContain('Usar logros de Steam');
    expect(html).toContain(es['privacy.artworkLabel'] as string);
  });

  it('toggling a tracker calls onChange with the next settings', () => {
    const onChange = vi.fn();
    const settings: Settings = { runInBackground: true, trackersEnabled: { steam: false, retroAchievements: true, gog: false } } as Settings;
    const list = inputs(PrivacyTogglesView({ settings, onChange }));
    byId(list, 'privacy-tracker-steam').props.onChange?.({ target: { checked: true } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      trackersEnabled: { steam: true, retroAchievements: true, gog: false },
    });
  });

  it('fills missing trackers with off and toggles artwork', () => {
    const onChange = vi.fn();
    const list = inputs(PrivacyTogglesView<PrivacySettings>({ settings: {}, onChange }));
    byId(list, 'privacy-tracker-gog').props.onChange?.({ target: { checked: true } });
    expect(onChange).toHaveBeenLastCalledWith({ trackersEnabled: { steam: false, retroAchievements: false, gog: true } });
    byId(list, 'privacy-artwork').props.onChange?.({ target: { checked: true } });
    expect(onChange).toHaveBeenLastCalledWith({ artworkEnabled: true });
  });

  it('reflects enabled switches as checked with the On hint', () => {
    const html = renderToStaticMarkup(
      <PrivacyToggles settings={{ artworkEnabled: true, trackersEnabled: { steam: true, retroAchievements: false, gog: false } }} onChange={() => {}} />,
    );
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain('On: Dune contacts Steam');
    expect(html).toContain('On: Dune contacts SteamGridDB');
  });

  describe('HowLongToBeat (server-wide, admin-gated)', () => {
    const hltb = (over: Partial<ServerSwitchState> = {}) =>
      ({ checked: false, locked: false, onToggle: vi.fn(), ...over });

    it('is hidden with no server (no local copy)', () => {
      const html = renderToStaticMarkup(<PrivacyToggles settings={{}} onChange={() => {}} />);
      expect(html).not.toContain('privacy-hltb');
    });

    it('is off by default with a labelled switch and the Off hint', () => {
      const html = renderToStaticMarkup(<PrivacyToggles settings={{}} onChange={() => {}} hltb={hltb()} />);
      expect(html.match(/role="switch"/g)).toHaveLength(5);
      expect(html).toContain('for="privacy-hltb"');
      expect(html).toContain(en['privacy.hltbLabel']);
      expect(html).toContain(en['privacy.hltbOff']);
      expect(html).toContain('aria-describedby="privacy-hltb-hint"');
      expect(html).not.toContain('checked=""');
      expect(html).not.toContain(en['where.adminOnly']);
    });

    it('calls onToggle for an admin and shows the On hint when checked', () => {
      const state = hltb();
      const list = inputs(HltbToggle({ hltb: state }));
      expect(list[0].props.id).toBe('privacy-hltb');
      list[0].props.onChange?.({ target: { checked: true } });
      expect(state.onToggle).toHaveBeenCalledWith(true);
      const on = renderToStaticMarkup(<HltbToggle hltb={hltb({ checked: true })} />);
      expect(on).toContain('checked=""');
      expect(on).toContain(en['privacy.hltbOn']);
    });

    it('is disabled for a member, described by the visible where.adminOnly note, and never toggles', () => {
      const state = hltb({ locked: true });
      const html = renderToStaticMarkup(<HltbToggle hltb={state} />);
      expect(html).toMatch(/id="privacy-hltb"[^>]*disabled=""|disabled=""[^>]*id="privacy-hltb"/);
      expect(html).toContain('aria-describedby="privacy-hltb-hint privacy-hltb-admin-only"');
      expect(html).toContain(`<p id="privacy-hltb-admin-only" class="form-hint text-sm" style="margin-top:0;overflow-wrap:anywhere">${en['where.adminOnly']}</p>`);
      inputs(HltbToggle({ hltb: state }))[0].props.onChange?.({ target: { checked: true } });
      expect(state.onToggle).not.toHaveBeenCalled();
    });

    it('is disabled with no note while the flags load or a save is in flight', () => {
      const state = hltb({ pending: true, checked: true });
      const html = renderToStaticMarkup(<HltbToggle hltb={state} />);
      expect(html).toMatch(/id="privacy-hltb"[^>]*disabled=""|disabled=""[^>]*id="privacy-hltb"/);
      expect(html).not.toContain(en['where.adminOnly']);
      expect(html).toContain('aria-describedby="privacy-hltb-hint"');
      inputs(HltbToggle({ hltb: state }))[0].props.onChange?.({ target: { checked: false } });
      expect(state.onToggle).not.toHaveBeenCalled();
    });

    it('has Spanish label, hint and note', () => {
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale="es"><PrivacyToggles settings={{}} onChange={() => {}} hltb={hltb({ locked: true })} /></I18nProvider>,
      );
      expect(html).toContain(es['privacy.hltbLabel'] as string);
      expect(html).toContain(es['privacy.hltbOff'] as string);
      expect(html).toContain(es['where.adminOnly'] as string);
    });
  });
  describe('artwork with a server connected (server flag, admin-gated)', () => {
    const server = (over: Partial<ServerSwitchState> = {}): ServerSwitchState =>
      ({ checked: false, locked: false, onToggle: vi.fn(), ...over });

    it('admin: shows the server flag (not the local setting) and toggles it via onToggle only', () => {
      const onChange = vi.fn();
      const artwork = server({ checked: true });
      const html = renderToStaticMarkup(<PrivacyToggles settings={{ artworkEnabled: false }} onChange={onChange} artwork={artwork} hltb={server()} />);
      expect(html.match(/role="switch"/g)).toHaveLength(5);
      expect(html.match(/checked=""/g)).toHaveLength(1);
      expect(html).toContain(en['privacy.artworkServerOn']);
      expect(html).toContain('aria-describedby="privacy-artwork-hint"');
      expect(html).not.toContain(en['where.adminOnly']);
      const list = inputs(PrivacyTogglesView({ settings: { artworkEnabled: false }, onChange, artwork, hltb: server() }));
      expect(byId(list, 'privacy-artwork').props.checked).toBe(true);
      byId(list, 'privacy-artwork').props.onChange?.({ target: { checked: false } });
      expect(artwork.onToggle).toHaveBeenCalledWith(false);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('admin: the Off hint says it applies to everyone on the server', () => {
      const html = renderToStaticMarkup(<PrivacyToggles settings={{ artworkEnabled: true }} onChange={() => {}} artwork={server()} />);
      expect(html).toContain(en['privacy.artworkServerOff']);
      expect(html).not.toContain('checked=""');
    });

    it('member: artwork and HLTB are disabled, each described by its visible admin-only note, and never toggle', () => {
      const artwork = server({ locked: true, checked: true });
      const h = server({ locked: true });
      const html = renderToStaticMarkup(<PrivacyToggles settings={{}} onChange={() => {}} artwork={artwork} hltb={h} />);
      expect(html).toMatch(/id="privacy-artwork"[^>]*disabled=""|disabled=""[^>]*id="privacy-artwork"/);
      expect(html).toContain('aria-describedby="privacy-artwork-hint privacy-artwork-admin-only"');
      expect(html).toContain(`<p id="privacy-artwork-admin-only" class="form-hint text-sm" style="margin-top:0;overflow-wrap:anywhere">${en['where.adminOnly']}</p>`);
      expect(html).toContain('aria-describedby="privacy-hltb-hint privacy-hltb-admin-only"');
      const list = inputs(PrivacyTogglesView({ settings: {}, onChange: () => {}, artwork, hltb: h }));
      byId(list, 'privacy-artwork').props.onChange?.({ target: { checked: false } });
      byId(list, 'privacy-hltb').props.onChange?.({ target: { checked: true } });
      expect(artwork.onToggle).not.toHaveBeenCalled();
      expect(h.onToggle).not.toHaveBeenCalled();
      // Trackers stay local and editable for members.
      expect(html).not.toMatch(/id="privacy-tracker-steam"[^>]*disabled=""/);
    });

    it('no server: artwork uses the local setting, HLTB is hidden, no admin note', () => {
      const onChange = vi.fn();
      const html = renderToStaticMarkup(<PrivacyToggles settings={{ artworkEnabled: true }} onChange={onChange} />);
      expect(html.match(/role="switch"/g)).toHaveLength(4);
      expect(html).not.toContain('privacy-hltb');
      expect(html).toContain(en['privacy.artworkOn']);
      expect(html).not.toContain(en['where.adminOnly']);
      const list = inputs(PrivacyTogglesView<PrivacySettings>({ settings: { artworkEnabled: true }, onChange }));
      byId(list, 'privacy-artwork').props.onChange?.({ target: { checked: false } });
      expect(onChange).toHaveBeenCalledWith({ artworkEnabled: false });
    });

    it('has Spanish server hints and note', () => {
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale="es"><PrivacyToggles settings={{}} onChange={() => {}} artwork={server({ locked: true })} /></I18nProvider>,
      );
      expect(html).toContain(es['privacy.artworkServerOff'] as string);
      expect(html).toContain(es['where.adminOnly'] as string);
    });
  });
});
