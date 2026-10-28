import type { CSSProperties, ReactNode } from 'react';
import { useI18n } from '../../i18n/context';
import { defaultTranslator, type MessageKey, type Translator } from '../../i18n';
import { TRACKER_IDS, TRACKER_NAMES, nextPrivacySettings, type PrivacySettings, type TrackerId } from './privacyToggleHelpers';

/**
 * DUN-135 privacy switches: one per tracker plus artwork (SteamGridDB),
 * HowLongToBeat and the save-path manifest (PCGamingWiki via Ludusavi).
 * Everything defaults to off, and while a switch is off Dune contacts nothing
 * for it. Artwork, HLTB and the manifest show the copy in effect: the
 * server flag when a server is connected (admins change it, members see it
 * read-only), else the local setting. Helpers are in ./privacyToggleHelpers.ts; text is i18n `privacy.*`.
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
  /** Server-wide HLTB switch; omit it with no server and the switch uses the local settings.hltbEnabled. */
  hltb?: HltbSwitchState;
  /**
   * Server-wide artwork switch. When set (a server is connected) the artwork
   * switch shows and changes the server flag instead of settings.artworkEnabled.
   */
  artwork?: ServerSwitchState;
  /** Server-wide save-path manifest switch; omit it with no server and the switch uses the local settings.manifestEnabled. */
  manifest?: ServerSwitchState;
  /** Load state of the server flags; when `failed`, a note with "Try again" shows above the server switches. */
  serverLoad?: ServerLoadState;
}

/** The server flags read (useProviderFlags): failed, a manual retry in flight, and the retry itself. */
export interface ServerLoadState {
  failed: boolean;
  reloading?: boolean;
  onRetry: () => void;
}

/** Id of the load-failure note, for aria-describedby on the server switches. */
const loadErrorId = (idPrefix = 'privacy') => `${idPrefix}-server-load-error`;
/** The note's id when it is shown (a server switch exists and the load failed), else undefined. */
function loadErrorFor(p: { serverLoad?: ServerLoadState; artwork?: ServerSwitchState; hltb?: HltbSwitchState; manifest?: ServerSwitchState; idPrefix?: string }) {
  return p.serverLoad?.failed && (p.artwork || p.hltb || p.manifest) ? loadErrorId(p.idPrefix) : undefined;
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
  { settings, onChange, t = defaultTranslator, disabled, idPrefix = 'privacy', artwork, serverLoad }: ToggleProps<T>,
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
        describedBy={loadErrorFor({ serverLoad, artwork, idPrefix })}
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
  { id, label, hint, state, t, disabled, describedBy }: {
    id: string; label: string; hint: string; state: ServerSwitchState; t: Translator; disabled?: boolean;
    /** Id of the load-failure note, when shown. */
    describedBy?: string;
  },
) {
  const noteId = `${id}-admin-only`;
  const extra = [state.locked ? noteId : undefined, describedBy].filter(Boolean).join(' ');
  return (
    <PrivacySwitch
      id={id}
      label={label}
      hint={hint}
      checked={state.checked}
      disabled={disabled || state.locked || state.pending}
      describedBy={extra || undefined}
      note={state.locked ? <p id={noteId} className="form-hint text-sm" style={hintStyle}>{t('where.adminOnly')}</p> : null}
      onToggle={enabled => { if (!state.locked && !state.pending) state.onToggle(enabled); }}
    />
  );
}

/** Local HLTB opt-in (Settings.hltbEnabled), read and written through `settings` like local artwork. */
type LocalHltbSettings = PrivacySettings & { hltbEnabled?: boolean };

/**
 * HLTB with no server: the local Settings.hltbEnabled (off unless literally
 * true), saved through onChange like the local artwork switch.
 */
export function LocalHltbToggle<T extends PrivacySettings>(
  { settings, onChange, t = defaultTranslator, disabled, idPrefix = 'privacy' }: ToggleProps<T>,
) {
  const checked = (settings as LocalHltbSettings).hltbEnabled === true;
  return (
    <PrivacySwitch
      id={`${idPrefix}-hltb`}
      label={t('privacy.hltbLabel')}
      hint={t(checked ? 'privacy.hltbLocalOn' : 'privacy.hltbLocalOff')}
      checked={checked}
      disabled={disabled}
      onToggle={hltbEnabled => onChange({ ...settings, hltbEnabled })}
    />
  );
}

/** DUN-115/HLTB: the server-wide switch, used when a server is connected (else LocalHltbToggle). */
export function HltbToggle(
  { hltb, t = defaultTranslator, disabled, idPrefix = 'privacy', serverLoad }: {
    hltb: HltbSwitchState; t?: Translator; disabled?: boolean; idPrefix?: string; serverLoad?: ServerLoadState;
  },
) {
  return (
    <ServerSwitch
      id={`${idPrefix}-hltb`}
      label={t('privacy.hltbLabel')}
      hint={t(hltb.checked ? 'privacy.hltbOn' : 'privacy.hltbOff')}
      state={hltb}
      t={t}
      disabled={disabled}
      describedBy={loadErrorFor({ serverLoad, hltb, idPrefix })}
    />
  );
}

/** Local save-path manifest opt-in (Settings.manifestEnabled), read and written through `settings`. */
type LocalManifestSettings = PrivacySettings & { manifestEnabled?: boolean };

/** Hint for the manifest switch: the on/off text plus the data attribution (always shown). */
const manifestHint = (t: Translator, key: MessageKey) => `${t(key)} ${t('privacy.manifestAttribution')}`;

/**
 * Save-path manifest (PCGamingWiki data via the Ludusavi manifest). With a
 * server connected (`manifest` set) it is the server flag (admins change it,
 * members see it read-only); with no server it is the local
 * Settings.manifestEnabled (off unless literally true), saved through onChange.
 */
export function ManifestToggle<T extends PrivacySettings>(
  { settings, onChange, t = defaultTranslator, disabled, idPrefix = 'privacy', manifest, serverLoad }: ToggleProps<T>,
) {
  const id = `${idPrefix}-manifest`;
  if (manifest) {
    return (
      <ServerSwitch
        id={id}
        label={t('privacy.manifestLabel')}
        hint={manifestHint(t, manifest.checked ? 'privacy.manifestOn' : 'privacy.manifestOff')}
        state={manifest}
        t={t}
        disabled={disabled}
        describedBy={loadErrorFor({ serverLoad, manifest, idPrefix })}
      />
    );
  }
  const checked = (settings as LocalManifestSettings).manifestEnabled === true;
  return (
    <PrivacySwitch
      id={id}
      label={t('privacy.manifestLabel')}
      hint={manifestHint(t, checked ? 'privacy.manifestLocalOn' : 'privacy.manifestLocalOff')}
      checked={checked}
      disabled={disabled}
      onToggle={manifestEnabled => onChange({ ...settings, manifestEnabled })}
    />
  );
}

/**
 * Server flags failed to load: a visible text note (not colour only) with a
 * keyboard-reachable "Try again". While retrying the button keeps focus and
 * says so with aria-disabled; the server switches stay disabled (pending).
 */
export function ServerLoadNote({ id, state, t }: { id: string; state: ServerLoadState; t: Translator }) {
  return (
    <div id={id} className="inline-error" role="status">
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t('privacy.flagLoadFailed')}</span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-disabled={state.reloading || undefined}
        onClick={() => { if (!state.reloading) state.onRetry(); }}
      >
        {t('common.tryAgain')}
      </button>
    </div>
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
      {loadErrorFor(props) && props.serverLoad && <ServerLoadNote id={loadErrorId(props.idPrefix)} state={props.serverLoad} t={t} />}
      <ArtworkToggle {...props} />
      {props.hltb
        ? <HltbToggle hltb={props.hltb} t={t} disabled={props.disabled} idPrefix={props.idPrefix} serverLoad={props.serverLoad} />
        : <LocalHltbToggle {...props} />}
      <ManifestToggle {...props} />
    </fieldset>
  );
}

export function PrivacyToggles<T extends PrivacySettings>(
  props: { settings: T; onChange: (next: T) => void; disabled?: boolean; idPrefix?: string; hltb?: HltbSwitchState; artwork?: ServerSwitchState;
    manifest?: ServerSwitchState; serverLoad?: ServerLoadState },
) {
  const { t } = useI18n();
  return <PrivacyTogglesView {...props} t={t} />;
}
