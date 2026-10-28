import type { CSSProperties } from 'react';
import { useI18n } from '../../i18n/context';
import { defaultTranslator, type Translator } from '../../i18n';
import { TRACKER_IDS, TRACKER_NAMES, nextPrivacySettings, type PrivacySettings, type TrackerId } from './privacyToggleHelpers';

/**
 * DUN-135 privacy switches: one per tracker plus artwork (SteamGridDB).
 * Everything defaults to off, and while a switch is off Dune contacts nothing
 * for it. Helpers are in ./privacyToggleHelpers.ts; text is i18n `privacy.*`.
 */

interface SwitchProps {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
}

const switchRowStyle: CSSProperties = { marginBottom: 4, flexWrap: 'wrap', minWidth: 0, overflowWrap: 'anywhere' };
const hintStyle: CSSProperties = { marginTop: 0, overflowWrap: 'anywhere' };

/** A native checkbox exposed as a switch: Space toggles it and it keeps the global focus ring. */
export function PrivacySwitch({ id, label, hint, checked, disabled, onToggle }: SwitchProps) {
  const hintId = `${id}-hint`;
  return (
    <div>
      <label className="checkbox-label" htmlFor={id} style={switchRowStyle}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="checkbox-input"
          checked={checked}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={e => onToggle(e.target.checked)}
        />
        <span style={{ minWidth: 0 }}>{label}</span>
      </label>
      <p id={hintId} className="form-hint text-muted text-sm" style={hintStyle}>{hint}</p>
    </div>
  );
}

interface ToggleProps<T extends PrivacySettings> {
  settings: T;
  onChange: (next: T) => void;
  /** Translator; English when omitted (tests). */
  t?: Translator;
  disabled?: boolean;
  /** Prefix for element ids; change it if a switch is rendered twice on one page. */
  idPrefix?: string;
}

export function TrackerToggle<T extends PrivacySettings>(
  { tracker, settings, onChange, t = defaultTranslator, disabled, idPrefix = 'privacy' }: ToggleProps<T> & { tracker: TrackerId },
) {
  const name = TRACKER_NAMES[tracker];
  const checked = settings.trackersEnabled?.[tracker] === true;
  return (
    <PrivacySwitch
      id={`${idPrefix}-tracker-${tracker}`}
      label={t('privacy.trackerLabel', { name })}
      hint={t(checked ? 'privacy.trackerOn' : 'privacy.trackerOff', { name })}
      checked={checked}
      disabled={disabled}
      onToggle={enabled => onChange(nextPrivacySettings(settings, { tracker, enabled }))}
    />
  );
}

export function ArtworkToggle<T extends PrivacySettings>(
  { settings, onChange, t = defaultTranslator, disabled, idPrefix = 'privacy' }: ToggleProps<T>,
) {
  const checked = settings.artworkEnabled === true;
  return (
    <PrivacySwitch
      id={`${idPrefix}-artwork`}
      label={t('privacy.artworkLabel')}
      hint={t(checked ? 'privacy.artworkOn' : 'privacy.artworkOff')}
      checked={checked}
      disabled={disabled}
      onToggle={artwork => onChange(nextPrivacySettings(settings, { artwork }))}
    />
  );
}

const fieldsetStyle: CSSProperties = { border: 0, padding: 0, margin: 0, minWidth: 0 };

/** Hook-free view (testable by calling it directly); `PrivacyToggles` supplies the translator. */
export function PrivacyTogglesView<T extends PrivacySettings>(props: ToggleProps<T>) {
  const t = props.t ?? defaultTranslator;
  const introId = `${props.idPrefix ?? 'privacy'}-intro`;
  return (
    <fieldset style={fieldsetStyle} aria-describedby={introId}>
      <legend className="section-subtitle" style={{ padding: 0 }}>{t('privacy.title')}</legend>
      <p id={introId} className="text-muted text-sm" style={{ overflowWrap: 'anywhere' }}>{t('privacy.intro')}</p>
      {TRACKER_IDS.map(tracker => <TrackerToggle key={tracker} tracker={tracker} {...props} />)}
      <ArtworkToggle {...props} />
    </fieldset>
  );
}

export function PrivacyToggles<T extends PrivacySettings>(
  props: { settings: T; onChange: (next: T) => void; disabled?: boolean; idPrefix?: string },
) {
  const { t } = useI18n();
  return <PrivacyTogglesView {...props} t={t} />;
}
