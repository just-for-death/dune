import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import appSource from '../App.tsx?raw';
import { I18nProvider } from './I18nProvider';
import { formatRich, useI18n } from './context';
import { NoServerNotice } from '../components/NoServerNotice';
import { DriveSpaceList } from '../components/saves/DriveSpaceList';
import { toDriveRows } from '../services/driveSpace';
import { createTranslator } from './index';

function Probe() {
  const { locale, t, tc } = useI18n();
  return <p data-locale={locale}>{t('settings.language')} · {tc('sidebar.games', 2)}</p>;
}

describe('I18nProvider', () => {
  it('defaults to English outside a provider', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<p data-locale="en">Language · 2 games</p>');
  });

  it('renders children in the chosen locale', () => {
    expect(renderToStaticMarkup(<I18nProvider initialLocale="es"><Probe /></I18nProvider>))
      .toBe('<p data-locale="es">Idioma · 2 juegos</p>');
  });

  it('switches component text, including the button label', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="es"><NoServerNotice message="x" onOpenSettings={() => {}} /></I18nProvider>,
    );
    expect(html).toContain('Configurar un servidor');
  });

  it('translates drive reasons and aria labels', () => {
    const rows = toDriveRows([
      { status: 'ok', mount: '/', label: 'System', paths: ['/home'], totalBytes: 100 * 1024 ** 3, freeBytes: 25 * 1024 ** 3 },
      { status: 'unavailable', reason: 'permission', paths: ['/mnt/x'] },
    ], createTranslator('es'));
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="es"><DriveSpaceList rows={rows} error={false} onRetry={() => {}} /></I18nProvider>,
    );
    expect(html).toContain('aria-label="Unidades"');
    expect(html).toContain('aria-label="Espacio usado de System"');
    expect(html).toContain('75% usado, 25.0 GB libres');
    expect(html).toContain('Dune no tiene permiso para leer esta unidad.');
  });

  it('formatRich keeps a whole sentence translatable around an element', () => {
    expect(renderToStaticMarkup(<p>{formatRich('Key: {status}.', { status: <b>Set</b> })}</p>)).toBe('<p>Key: <b>Set</b>.</p>');
    expect(renderToStaticMarkup(<p>{formatRich('{missing} ok', {})}</p>)).toBe('<p>{missing} ok</p>');
  });
});

describe('App.tsx has no hard-coded UI text', () => {
  it('JSX text nodes come from the catalog', () => {
    const source: string = appSource;
    // Literal text between tags, e.g. <span>Dashboard</span>; the brand name is allowed.
    const literals = [...source.matchAll(/(?<![=-])>\s*([A-Za-z][^<>{}()=]*?)\s*</g)]
      .map((m) => m[1].trim())
      .filter((text) => text && text !== 'Dune');
    expect(literals).toEqual([]);
  });
});
