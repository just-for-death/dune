import type { CSSProperties, ReactNode } from 'react';
import { useI18n } from '../../i18n/context';
import { defaultTranslator, type Translator } from '../../i18n';
import { TRACKER_IDS, TRACKER_NAMES, nextPrivacySettings, type PrivacySettings, type TrackerId } from './privacyToggleHelpers';

/**
 * DUN-135 privacy switches: one per tracker plus artwork (SteamGridDB) and,
 * with a server, HowLongToBeat. Everything defaults to off, and while a switch
 * is off Dune contacts nothing for it. Artwork and HLTB show the copy in
 * effect: the server flag when a server is connected (admins change it,
 * members see it read-only), else artwork's local setting. Helpers are in ./privacyToggleHelpers.ts; text is i18n `privacy.*`.
 */

interface SwitchProps {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
  /** Extra ids for aria-describedby (e.g. an admin-only note in `note`). */
  describedBy?: string;
  /** Visible text under the hint (e.g. why the switch is disabled). */
  note?: ReactNode;
}

const switchRowStyle: CSSProperties = { marginBottom: 4, flexWrap: 'wrap', minWidth: 0, overflowWrap: 'anywhere' };
const hintStyle: CSSProperties = { marginTop: 0, overflowWrap: 'anywhere' };

/** A native checkbox exposed as a switch: Space toggles it and it keeps the global focus ring. */
export function PrivacySwitch({ id, label, hint, checked, disabled, onToggle, describedBy, note }: SwitchProps) {
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
          aria-describedby={describedBy ? `${hintId} ${describedBy}` : hintId}
          onChange={e => onToggle(e.target.checked)}
        />
        <span style={{ minWidth: 0 }}>{label}</span>
      </label>
      <p id={hintId} className="form-hint text-muted text-sm" style={hintStyle}>{hint}</p>
      {note}
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
  /** Server-wide HLTB switch; omit it with no server (HLTB has no local copy) and it is hidden. */
  hltb?: HltbSwitchState;
  /**
   * Server-wide artwork switch. When set (a server is connected) the artwork
   * switch shows and changes the server flag instead of settings.artworkEnabled.
   */
  artwork?: ServerSwitchState;
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
  { settings, onChange, t = defaultTranslator, disabled, idPrefix = 'privacy', artwork }: ToggleProps<T>,
) {
  if (artwork) {
    return (
      <ServerSwitch
        id={`${idPrefix}-artwork`}
        label={t('privacy.artworkLabel')}
        hint={t(artwork.checked ? 'privacy.artworkServerOn' : 'privacy.artworkServerOff')}
        state={artwork}
        t={t}
        disabled={disabled}
      />
    );
  }
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

/** A provider flag stored on the Dune server (Settings.hltbEnabled / artworkEnabled): one copy for everyone. */
export interface ServerSwitchState {
  checked: boolean;
  /** True only for a known member (isLockedForRole); unknown stays enabled and the server's 403 explains. */
  locked: boolean;
  /** Flags still loading or a save in flight: disabled, no note. */
  pending?: boolean;
  onToggle: (enabled: boolean) => void;
}
/** Server-wide HowLongToBeat opt-in (Settings.hltbEnabled on the Dune server). */
export type HltbSwitchState = ServerSwitchState;

/**
 * DUN-115: a server-wide switch. Members see it disabled with the visible
 * where.adminOnly note (text, not colour) linked by aria-describedby.
 */
function ServerSwitch(
  { id, label, hint, state, t, disabled }: { id: string; label: string; hint: string; state: ServerSwitchState; t: Translator; disabled?: boolean },
) {
  const noteId = `${id}-admin-only`;
  return (
    <PrivacySwitch
      id={id}
      label={label}
      hint={hint}
      checked={state.checked}
      disabled={disabled || state.locked || state.pending}
      describedBy={state.locked ? noteId : undefined}
      note={state.locked ? <p id={noteId} className="form-hint text-sm" style={hintStyle}>{t('where.adminOnly')}</p> : null}
      onToggle={enabled => { if (!state.locked && !state.pending) state.onToggle(enabled); }}
    />
  );
}

/** DUN-115/HLTB: server-wide only (no local copy), so it is shown only with a server. */
export function HltbToggle(
  { hltb, t = defaultTranslator, disabled, idPrefix = 'privacy' }: { hltb: HltbSwitchState; t?: Translator; disabled?: boolean; idPrefix?: string },
) {
  return (
    <ServerSwitch
      id={`${idPrefix}-hltb`}
      label={t('privacy.hltbLabel')}
      hint={t(hltb.checked ? 'privacy.hltbOn' : 'privacy.hltbOff')}
      state={hltb}
      t={t}
      disabled={disabled}
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
      {props.hltb && <HltbToggle hltb={props.hltb} t={t} disabled={props.disabled} idPrefix={props.idPrefix} />}
    </fieldset>
  );
}

export function PrivacyToggles<T extends PrivacySettings>(
  props: { settings: T; onChange: (next: T) => void; disabled?: boolean; idPrefix?: string; hltb?: HltbSwitchState; artwork?: ServerSwitchState },
) {
  const { t } = useI18n();
  return <PrivacyTogglesView {...props} t={t} />;
}
