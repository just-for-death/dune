import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Settings } from '@dune/shared';
import { PrivacyToggles, PrivacyTogglesView } from './PrivacyToggles';
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
    expect(html.match(/role="switch"/g)).toHaveLength(5);
    expect(html).not.toContain('checked=""');
    const list = inputs(PrivacyTogglesView({ settings: {}, onChange: () => {} }));
    expect(list).toHaveLength(5);
    for (const i of list) expect(i.props.checked).toBe(false);
  });

  it('labels each switch and says nothing is contacted while off', () => {
    const html = renderToStaticMarkup(<PrivacyToggles settings={{}} onChange={() => {}} />);
    for (const id of ['steam', 'retroAchievements', 'gog', 'epic']) {
      expect(html).toContain(`for="privacy-tracker-${id}"`);
      expect(html).toContain(`aria-describedby="privacy-tracker-${id}-hint"`);
    }
    expect(html).toContain('for="privacy-artwork"');
    for (const name of ['Steam', 'RetroAchievements', 'GOG', 'Epic Games']) {
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
    const settings: Settings = { runInBackground: true, trackersEnabled: { steam: false, retroAchievements: true, gog: false, epic: false } } as Settings;
    const list = inputs(PrivacyTogglesView({ settings, onChange }));
    byId(list, 'privacy-tracker-steam').props.onChange?.({ target: { checked: true } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      trackersEnabled: { steam: true, retroAchievements: true, gog: false, epic: false },
    });
  });

  it('fills missing trackers with off and toggles artwork', () => {
    const onChange = vi.fn();
    const list = inputs(PrivacyTogglesView<PrivacySettings>({ settings: {}, onChange }));
    byId(list, 'privacy-tracker-epic').props.onChange?.({ target: { checked: true } });
    expect(onChange).toHaveBeenLastCalledWith({ trackersEnabled: { steam: false, retroAchievements: false, gog: false, epic: true } });
    byId(list, 'privacy-artwork').props.onChange?.({ target: { checked: true } });
    expect(onChange).toHaveBeenLastCalledWith({ artworkEnabled: true });
  });

  it('reflects enabled switches as checked with the On hint', () => {
    const html = renderToStaticMarkup(
      <PrivacyToggles settings={{ artworkEnabled: true, trackersEnabled: { steam: true, retroAchievements: false, gog: false, epic: false } }} onChange={() => {}} />,
    );
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain('On: Dune contacts Steam');
    expect(html).toContain('On: Dune contacts SteamGridDB');
  });
});
