import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DownloadsQueueView } from './DownloadsQueue';
import { DownloadsSettingsView } from './DownloadsSettingsPanel';
import { INITIAL_DOWNLOADS_STATE, type DownloadsState } from './downloadsStore';
import { createPluralTranslator, createTranslator } from '../../i18n';
import { I18nContext } from '../../i18n/context';
import { hasDownloadsApi } from './types';
import { DownloadsView } from './DownloadsView';
import { fakeApi, snap } from './testFixtures';

const noop = () => {};
const view = (patch: Partial<DownloadsState>, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<DownloadsQueueView state={{ ...INITIAL_DOWNLOADS_STATE, phase: 'ready', ...patch }} now={0} onAction={noop} onReload={noop} {...extra} />);

describe('DownloadsQueueView', () => {
  it('shows the empty state and an empty live region', () => {
    const html = view({ items: [] });
    expect(html).toContain('No downloads yet.');
    expect(html).toMatch(/<p role="status" aria-live="polite" aria-atomic="true" class="sr-only"><\/p>/);
  });

  it('renders a determinate progressbar, text status, bytes, speed, ETA and name-labelled actions', () => {
    const html = view({ items: [snap()] });
    expect(html).toMatch(/role="progressbar" aria-label="Progress for game.zip" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"/);
    expect(html).toContain('>Downloading<');
    expect(html).toContain('512 B of 1.0 KB');
    expect(html).toContain('2.0 KB/s');
    expect(html).toContain('Less than a minute left');
    expect(html).toContain('aria-label="Pause game.zip"');
    expect(html).toContain('aria-label="Cancel game.zip"');
    expect(html).not.toContain('Retry game.zip');
    expect(html).toContain('title="game.zip"');
    expect(html).toContain('Folder: /dl/steam');
  });

  it('omits aria-valuenow when the total is unknown', () => {
    const html = view({ items: [snap({ totalBytes: null })] });
    expect(html).toMatch(/role="progressbar" aria-label="Progress for game.zip" aria-valuetext="512 B downloaded"/);
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('downloads-indeterminate is-active');
  });

  it('summarises failures with mapped messages and offers retry/remove', () => {
    const html = view({ items: [snap({ status: 'failed', errorCode: 'IO_ERROR' }), snap({ id: 'b', name: 'b.iso', status: 'failed', errorCode: null })] });
    expect(html).toContain('2 downloads failed');
    expect(html).toContain('game.zip: Couldn’t reach the download folder.');
    expect(html).toContain('b.iso: Something went wrong with this download.');
    expect(html).toContain('aria-label="Retry game.zip"');
    expect(html).toContain('aria-label="Remove b.iso from the list"');
  });

  it('shows the retry countdown, earlier-folder badge and optional show-in-folder action', () => {
    const items = [snap({ status: 'queued', nextRetryAt: 9000, root: '/old/steam' })];
    expect(view({ items })).not.toContain('Show in folder');
    const html = view({ items }, { baseDir: '/dl', onShowInFolder: noop });
    expect(html).toContain('Retrying in 9 s');
    expect(html).toContain('Earlier download folder');
    expect(html).toContain('aria-label="Show game.zip in its folder"');
    // A failed reveal links its row error to the button too.
    expect(view({ items, actionErrors: { a: 'NOT_FOUND' } }, { onShowInFolder: noop }))
      .toMatch(/aria-label="Show game.zip in its folder" aria-describedby="[^"]+-err"/);
  });

  it('shows a load error with a retry button and Spanish text via t', () => {
    const html = renderToStaticMarkup(
      <I18nContext.Provider value={{ locale: 'es', setLocale: noop, t: createTranslator('es'), tc: createPluralTranslator('es') }}>
        <DownloadsQueueView state={{ ...INITIAL_DOWNLOADS_STATE, phase: 'error', loadError: 'IO_ERROR' }} now={0} onAction={noop} onReload={noop} />
      </I18nContext.Provider>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('No se pudo cargar la cola de descargas.');
    expect(html).toContain('>Reintentar<');
  });

  it('marks row buttons aria-disabled while an action is in flight and links the row error', () => {
    const html = view({ items: [snap()], busy: { a: 'pause' }, actionErrors: { a: 'INVALID_STATE' } });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('That action isn’t possible right now.');
    expect(html).toMatch(/aria-describedby="[^"]+-err"/);
  });
});

describe('DownloadsSettingsView', () => {
  const settings = { baseDir: '/dl', concurrency: 2, maxConcurrency: 4, autoResume: false };
  const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(
    <DownloadsSettingsView settings={settings} onChooseBaseDir={noop} onConcurrency={noop} onAutoResume={noop} {...extra} />,
  );

  it('explains that a base-folder change only affects new downloads, next to the field', () => {
    const html = render();
    expect(html).toContain('Changing it only affects new downloads: existing ones keep their folder and progress.');
    expect(html).toMatch(/id="([^"]+)-base-hint"/);
  });

  it('offers concurrency 1..max and an off-by-default autoResume switch', () => {
    const html = render();
    expect((html.match(/<option /g) ?? []).length).toBe(4);
    expect(html).toContain('From 1 to 4.');
    expect(html).toMatch(/type="checkbox" role="switch"/);
    expect(html).not.toMatch(/role="switch"[^>]*checked/);
    expect(html).toContain('Off: unfinished downloads wait until you resume them.');
  });

  it('renders autoResume as an editable switch described by its hint', () => {
    const html = render();
    expect(html).not.toMatch(/role="switch"[^>]*disabled/);
    expect(html).toMatch(/role="switch"[^>]*aria-describedby="[^"]+-auto-hint"/);
    expect(render({ settings: { ...settings, autoResume: true } })).toMatch(/role="switch"[^>]*checked/);
  });

  it('shows the base folder read-only with a Change folder button described by it and the hint', () => {
    const html = render();
    expect(html).toMatch(/role="group" aria-labelledby="([^"]+)-base-label"/);
    expect(html).toContain('>/dl</code>');
    expect(html).toMatch(/<button type="button"[^>]*aria-describedby="([^"]+)-base-label \1-base \1-base-hint"[^>]*>Change folder…<\/button>/);
    expect(render({ saving: true })).toMatch(/aria-disabled="true"[^>]*>Change folder…/);
  });

  it('maps the IPC-level codes to messages', () => {
    expect(render({ errorCode: 'NOT_READY' })).toContain('Downloads aren’t ready yet.');
  });

  it('shows the IO_ERROR guidance when saving the folder fails', () => {
    expect(render({ errorCode: 'IO_ERROR' })).toContain('Check that it exists or reconnect the drive, then retry.');
  });
});

describe('DownloadsView', () => {
  it('shows the unavailable note without a bridge or without the downloads IPC', () => {
    for (const api of [undefined, {}, { listDownloads: async () => ({ ok: true as const, items: [] }) }]) {
      const html = renderToStaticMarkup(<DownloadsView api={api} />);
      expect(html).toContain('<h2>Downloads</h2>');
      expect(html).toContain('Downloads are only available in the Dune desktop app.');
      expect(html).not.toContain('Download settings');
    }
    expect(hasDownloadsApi(undefined)).toBe(false);
  });

  it('renders settings and queue when the bridge has the downloads IPC', () => {
    const settingsResult = async () => ({ ok: true as const, baseDir: '/dl', concurrency: 2, maxConcurrency: 4, autoResume: false });
    const api = {
      ...fakeApi().api,
      getDownloadSettings: settingsResult, setDownloadConcurrency: settingsResult,
      setDownloadAutoResume: settingsResult, chooseDownloadBaseDir: settingsResult,
    };
    expect(hasDownloadsApi(api)).toBe(true);
    const html = renderToStaticMarkup(<DownloadsView api={api} />);
    expect(html).toContain('Download settings');
    expect(html).toContain('>Queue</h3>');
    expect(html).not.toContain('only available in the Dune desktop app');
  });
});
