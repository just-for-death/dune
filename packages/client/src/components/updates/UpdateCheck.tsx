import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n/context';
import { defaultTranslator, type Translator } from '../../i18n';
import { PrivacySwitch } from '../settings/PrivacyToggles';
import {
  formatPublished,
  hasUpdateApi,
  runUpdateCheck,
  safeReleaseUrl,
  updateErrorKey,
  type UpdateCheckApi,
  type UpdateOutcome,
} from './updateFormat';

/**
 * Update check (Settings). Settings.updateCheckEnabled gates only the
 * AUTOMATIC check done by main; the "Check for updates" button always works,
 * because the click is the opt-in. Nothing is downloaded or installed here.
 * Release notes render as plain text (React escapes them; no HTML/Markdown),
 * and the release page is linked only when it is https://.
 */

const notesStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  maxHeight: 200,
  overflowY: 'auto',
  margin: '4px 0',
  padding: 8,
  border: '1px solid var(--border-color, rgba(127,127,127,0.4))',
  borderRadius: 4,
};
const textStyle: CSSProperties = { overflowWrap: 'anywhere', minWidth: 0 };

export interface UpdateCheckViewProps {
  /** False when the bridge has no checkForUpdates (preload not wired): an unavailable note replaces the button. */
  available: boolean;
  /** Settings.updateCheckEnabled (automatic checks); off unless literally true. */
  autoEnabled: boolean;
  onToggle: (enabled: boolean) => void;
  checking: boolean;
  outcome: UpdateOutcome | null;
  onCheck: () => void;
  t?: Translator;
  locale?: string;
  /** Tests pin the zone for the published date; the app uses the user's zone. */
  timeZone?: string;
  disabled?: boolean;
  idPrefix?: string;
}

/** Hook-free view (testable by calling it directly); `UpdateCheck` owns the state. */
export function UpdateCheckView({
  available, autoEnabled, onToggle, checking, outcome, onCheck, t = defaultTranslator, locale = 'en', timeZone, disabled, idPrefix = 'updates',
}: UpdateCheckViewProps) {
  const statusId = `${idPrefix}-status`;
  return (
    <section aria-labelledby={`${idPrefix}-title`}>
      <h4 id={`${idPrefix}-title`} className="section-subtitle">{t('updates.title')}</h4>
      <PrivacySwitch
        id={`${idPrefix}-auto`}
        label={t('updates.autoLabel')}
        hint={t('updates.autoHint')}
        checked={autoEnabled}
        disabled={disabled}
        onToggle={onToggle}
      />
      {available ? (
        <>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-disabled={checking || undefined}
            aria-describedby={statusId}
            onClick={() => { if (!checking) onCheck(); }}
          >
            {checking ? t('updates.checking') : t('updates.checkButton')}
          </button>
          <div id={statusId} role="status" aria-live="polite" style={{ marginTop: 8, minWidth: 0 }}>
            {!checking && outcome && <UpdateResult outcome={outcome} t={t} locale={locale} timeZone={timeZone} idPrefix={idPrefix} />}
          </div>
        </>
      ) : (
        <p id={statusId} role="status" className="text-muted text-sm" style={textStyle}>{t('updates.unavailable')}</p>
      )}
    </section>
  );
}

function UpdateResult({ outcome, t, locale, timeZone, idPrefix }: { outcome: UpdateOutcome; t: Translator; locale: string; timeZone?: string; idPrefix: string }) {
  if (outcome.kind === 'error') {
    return <p className="inline-error" style={textStyle}>{t(updateErrorKey(outcome.code))}</p>;
  }
  const { update, stale } = outcome;
  const staleNote = stale ? <p className="form-hint text-muted text-sm" style={textStyle}>{t('updates.stale')}</p> : null;
  if (!update.isNewer) {
    return (
      <>
        <p style={textStyle}>{t('updates.latest', { current: update.current })}</p>
        {staleNote}
      </>
    );
  }
  const published = formatPublished(update.publishedAt, locale, timeZone);
  const href = safeReleaseUrl(update.releaseUrl);
  const notesId = `${idPrefix}-notes`;
  return (
    <>
      <p style={textStyle}><strong>{t('updates.available', { version: update.version, current: update.current })}</strong></p>
      {published && <p className="text-muted text-sm" style={textStyle}>{t('updates.published', { date: published })}</p>}
      {staleNote}
      {update.notes.trim() !== '' && (
        <>
          <p id={notesId} className="text-sm" style={{ ...textStyle, marginBottom: 0 }}>{t('updates.notesLabel')}</p>
          {/* Plain text only: React escapes it; pre-wrap keeps the line breaks. Focusable so the scroll area works by keyboard. */}
          <div className="text-sm" role="region" aria-labelledby={notesId} tabIndex={0} style={notesStyle}>{update.notes}</div>
        </>
      )}
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer">{t('updates.viewRelease')}</a>
      )}
    </>
  );
}

export interface UpdateCheckProps {
  /** window.electronAPI; checkForUpdates may be missing at runtime (preload not wired yet). */
  api: Partial<UpdateCheckApi> | undefined;
  settings: { updateCheckEnabled?: boolean };
  /** Saves Settings.updateCheckEnabled. */
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

export function UpdateCheck({ api, settings, onToggle, disabled }: UpdateCheckProps) {
  const { t, locale } = useI18n();
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null);
  const busy = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const onCheck = async () => {
    if (busy.current || !hasUpdateApi(api)) return;
    busy.current = true;
    setChecking(true);
    const next = await runUpdateCheck(api);
    busy.current = false;
    if (!live.current) return;
    setOutcome(next);
    setChecking(false);
  };

  return (
    <UpdateCheckView
      available={hasUpdateApi(api)}
      autoEnabled={settings.updateCheckEnabled === true}
      onToggle={onToggle}
      checking={checking}
      outcome={outcome}
      onCheck={() => { void onCheck(); }}
      t={t}
      locale={locale}
      disabled={disabled}
    />
  );
}
