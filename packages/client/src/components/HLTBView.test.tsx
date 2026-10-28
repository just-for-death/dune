import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Game } from '@dune/shared';
import { HLTBView } from './HLTBView';
import { I18nProvider } from '../i18n/I18nProvider';
import { en } from '../i18n/en';
import { es } from '../i18n/es';

const games = [{ id: 1, name: 'Hollow Knight' }] as Game[];
const view = (providerDisabled?: boolean) =>
  renderToStaticMarkup(<HLTBView games={games} cache={{}} loading={{}} onLoad={() => {}} providerDisabled={providerDisabled} />);

describe('HLTBView provider-disabled state', () => {
  it('shows nothing extra while HLTB is available', () => {
    const html = view();
    expect(html).not.toContain(en['hltb.disabled']);
    expect(html).toContain('role="status"');
  });

  it('shows a calm status (not an alert) and keeps Load usable', () => {
    const html = view(true);
    expect(html).toContain(`${en['hltb.disabled']} ${en['hltb.disabledHint']}`);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('error-text');
    expect(html).toMatch(/<div role="status" aria-live="polite"><div class="card no-server-card">/);
    const load = html.match(/<button[^>]*aria-label="Load times for Hollow Knight"[^>]*>/)?.[0];
    expect(load).toBeTruthy();
    expect(load).not.toContain('disabled=""');
  });

  it('is translated', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="es"><HLTBView games={games} cache={{}} loading={{}} onLoad={() => {}} providerDisabled /></I18nProvider>,
    );
    expect(html).toContain(es['hltb.disabled'] as string);
    expect(html).toContain(es['hltb.disabledHint'] as string);
  });
});
