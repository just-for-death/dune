import { useEffect, useId, useState } from 'react';
import './downloads.css';
import { clampConcurrency, concurrencyOptions, errorMessageKey } from './downloadsFormat';
import { useI18n } from '../../i18n/context';
import type { DownloadIpcResult, DownloadSettings, DownloadsSettingsApi } from './types';

export interface DownloadsSettingsViewProps {
  settings: DownloadSettings | null;
  /** Opens main's folder dialog (chooseDownloadBaseDir). */
  onChooseBaseDir: () => void;
  onConcurrency: (value: number) => void;
  onAutoResume: (enabled: boolean) => void;
  saving?: boolean;
  /** Error code of the last failed save or load. */
  errorCode?: string | null;
  /** Shown in a polite live region after a successful save. */
  saved?: boolean;
}

/** Presentational panel: base folder (dialog in main), concurrency (1..max) and autoResume (off by default). */
export function DownloadsSettingsView({
  settings, onChooseBaseDir, onConcurrency, onAutoResume,
  saving = false, errorCode = null, saved = false,
}: DownloadsSettingsViewProps) {
  const { t } = useI18n();
  const id = useId();
  const ids = {
    heading: `${id}-h`, baseLabel: `${id}-base-label`, base: `${id}-base`, baseHint: `${id}-base-hint`,
    conc: `${id}-conc`, concHint: `${id}-conc-hint`, auto: `${id}-auto`, autoHint: `${id}-auto-hint`,
  };
  const max = settings ? Math.max(1, settings.maxConcurrency) : 1;
  const autoResume = settings?.autoResume ?? false;
  return (
    <section className="card downloads-settings" aria-labelledby={ids.heading}>
      <h3 id={ids.heading} className="card-title">{t('downloads.settings.title')}</h3>
      {errorCode && <div className="inline-error" role="alert">{t(errorMessageKey(errorCode))}</div>}
      <p role="status" aria-live="polite" className="sr-only">{saved ? t('downloads.settings.saved') : ''}</p>
      {!settings ? (
        <p className="text-muted">{t('downloads.settings.loading')}</p>
      ) : (
        <>
          <div role="group" aria-labelledby={ids.baseLabel} className="downloads-settings-field">
            <span id={ids.baseLabel}>{t('downloads.settings.baseDirLabel')}</span>
            <code id={ids.base} title={settings.baseDir}>{settings.baseDir}</code>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              aria-describedby={`${ids.baseLabel} ${ids.base} ${ids.baseHint}`}
              aria-disabled={saving ? 'true' : undefined}
              onClick={() => { if (!saving) onChooseBaseDir(); }}
            >
              {t('downloads.settings.baseDirChoose')}
            </button>
          </div>
          <p id={ids.baseHint} className="form-hint text-muted text-sm" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
            {t('downloads.settings.baseDirHint')}
          </p>

          <label htmlFor={ids.conc}>{t('downloads.settings.concurrencyLabel')}</label>
          <select
            id={ids.conc}
            value={clampConcurrency(settings.concurrency, max)}
            aria-describedby={ids.concHint}
            aria-busy={saving || undefined}
            onChange={e => { if (!saving) onConcurrency(clampConcurrency(Number(e.target.value), max)); }}
          >
            {concurrencyOptions(max).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <p id={ids.concHint} className="form-hint text-muted text-sm" style={{ marginTop: 4 }}>
            {t('downloads.settings.concurrencyHint', { max })}
          </p>

          <label className="checkbox-label" htmlFor={ids.auto} style={{ marginBottom: 4, flexWrap: 'wrap', minWidth: 0 }}>
            <input
              id={ids.auto}
              type="checkbox"
              role="switch"
              className="checkbox-input"
              checked={autoResume}
              aria-describedby={ids.autoHint}
              aria-busy={saving || undefined}
              onChange={e => { if (!saving) onAutoResume(e.target.checked); }}
            />
            <span style={{ minWidth: 0 }}>{t('downloads.settings.autoResumeLabel')}</span>
          </label>
          <p id={ids.autoHint} className="form-hint text-muted text-sm" style={{ marginTop: 0 }}>
            {t(autoResume ? 'downloads.settings.autoResumeOn' : 'downloads.settings.autoResumeOff')}
          </p>
        </>
      )}
    </section>
  );
}

/** Settings results are flat { ok: true, baseDir, concurrency, maxConcurrency, autoResume }. */
function settingsOf(res: { ok: true } & DownloadSettings): DownloadSettings {
  return { baseDir: res.baseDir, concurrency: res.concurrency, maxConcurrency: res.maxConcurrency, autoResume: res.autoResume === true };
}

export interface DownloadsSettingsPanelProps {
  /** window.electronAPI (or a Pick of it). */
  api: DownloadsSettingsApi;
  /** Lets the queue badge items saved under an earlier base folder. */
  onSettings?: (settings: DownloadSettings) => void;
}

export function DownloadsSettingsPanel({ api, onSettings }: DownloadsSettingsPanelProps) {
  const [settings, setSettings] = useState<DownloadSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    api.getDownloadSettings().then(
      res => {
        if (!live) return;
        if (res.ok) {
          const next = settingsOf(res);
          setSettings(next);
          onSettings?.(next);
        } else setErrorCode(res.code || 'unknown');
      },
      () => { if (live) setErrorCode('unknown'); },
    );
    return () => { live = false; };
  }, [api, onSettings]);

  const save = async (run: () => Promise<DownloadIpcResult<DownloadSettings>>) => {
    if (!settings || saving) return;
    setSaving(true);
    setSaved(false);
    setErrorCode(null);
    let res: DownloadIpcResult<DownloadSettings> | null = null;
    try { res = await run(); } catch { /* rejected IPC call: generic message below */ }
    setSaving(false);
    if (!res?.ok) {
      const code = res?.code || 'unknown';
      // Closing the folder dialog is not an error.
      if (code !== 'CANCELLED') setErrorCode(code);
      return;
    }
    const next = settingsOf(res);
    setSettings(next);
    setSaved(true);
    onSettings?.(next);
  };

  return (
    <DownloadsSettingsView
      settings={settings}
      onChooseBaseDir={() => void save(() => api.chooseDownloadBaseDir())}
      onConcurrency={n => void save(() => api.setDownloadConcurrency(n))}
      onAutoResume={on => void save(() => api.setDownloadAutoResume(on))}
      saving={saving}
      errorCode={errorCode}
      saved={saved}
    />
  );
}
