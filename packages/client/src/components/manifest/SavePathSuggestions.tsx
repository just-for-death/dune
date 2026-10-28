import { useEffect, useReducer, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ManifestSuggestion } from '@dune/shared';
import { useI18n } from '../../i18n/context';
import { defaultTranslator, type Translator } from '../../i18n';
import {
  hasManifestApi,
  isRetryable,
  isSamePath,
  manifestErrorKey,
  runManifestLookup,
  type ManifestApi,
  type ManifestOutcome,
} from './manifestFormat';
import { confirmPending, initialSuggestionsState, suggestionsReducer, type ApplyResult } from './manifestState';

/**
 * Save-path suggestions from the Ludusavi manifest (PCGamingWiki data).
 * Nothing runs on its own: the lookup starts only from the button, and a path
 * is applied only after "Use this path" and then Confirm. Paths render as
 * plain text (React escapes them; never links or HTML), and the wiki page is
 * linked only when it is https://.
 */

const textStyle: CSSProperties = { overflowWrap: 'anywhere', minWidth: 0 };
const pathStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  minWidth: 0,
  maxWidth: '100%',
  margin: '6px 0',
  padding: '6px 8px',
  background: 'var(--bg)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  userSelect: 'text',
};
const listStyle: CSSProperties = { listStyle: 'none', margin: '8px 0', padding: 0, display: 'grid', gap: 8, minWidth: 0 };
const itemStyle: CSSProperties = {
  padding: 10,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-control)',
  background: 'var(--panel-2)',
  minWidth: 0,
};
const badgeRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' };
const confirmStyle: CSSProperties = {
  marginTop: 8,
  padding: 10,
  border: '1px solid var(--sand)',
  borderRadius: 'var(--radius-control)',
  background: 'var(--panel)',
  minWidth: 0,
};
const actionsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 };

export interface SavePathSuggestionsViewProps {
  /** False when the bridge has no getManifestSuggestions (preload not wired): an unavailable note replaces the button. */
  available: boolean;
  loading: boolean;
  outcome: ManifestOutcome | null;
  currentSavePath?: string | null;
  /** Path awaiting confirmation (the inline confirm shows under it). */
  pending: string | null;
  /** Path being applied. */
  applying: string | null;
  applyResult: ApplyResult | null;
  onFind: () => void;
  onRequestApply: (path: string, trigger: HTMLElement | null) => void;
  onCancel: () => void;
  onConfirm: () => void;
  t?: Translator;
  idPrefix?: string;
}

/** Hook-free view (testable by calling it directly); `SavePathSuggestions` owns the state. */
export function SavePathSuggestionsView({
  available, loading, outcome, currentSavePath, pending, applying, applyResult,
  onFind, onRequestApply, onCancel, onConfirm, t = defaultTranslator, idPrefix = 'manifest',
}: SavePathSuggestionsViewProps) {
  const statusId = `${idPrefix}-status`;
  const result = !loading && outcome?.kind === 'result' ? outcome : null;
  const attribution = result?.attribution || t('privacy.manifestAttribution');
  return (
    <section aria-labelledby={`${idPrefix}-title`} style={{ minWidth: 0 }}>
      <h4 id={`${idPrefix}-title`} className="section-subtitle">{t('manifest.title')}</h4>
      <p className="text-muted text-sm" style={textStyle}>{t('manifest.intro')}</p>
      {available ? (
        <>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-disabled={loading || undefined}
            aria-describedby={statusId}
            onClick={() => { if (!loading) onFind(); }}
          >
            {loading ? t('manifest.loading') : t('manifest.findButton')}
          </button>
          <div id={statusId} role="status" aria-live="polite" style={{ marginTop: 8, minWidth: 0 }}>
            {loading && <span className="sr-only">{t('manifest.loading')}</span>}
            {!loading && outcome?.kind === 'error' && <LookupError code={outcome.code} onRetry={onFind} t={t} />}
            {result?.stale && <p className="form-hint text-muted text-sm" style={textStyle}>{t('manifest.stale')}</p>}
            {result && result.suggestions.length === 0 && <p className="text-sm" style={textStyle}>{t('manifest.empty')}</p>}
            {result && applying === null && applyResult && (
              applyResult.kind === 'applied'
                ? <p className="text-sm" style={textStyle}>{t('manifest.applied')}</p>
                : <p className="inline-error" style={textStyle}>{t('manifest.applyError')}</p>
            )}
          </div>
          {result && result.suggestions.length > 0 && (
            <ul aria-label={t('manifest.listLabel')} style={listStyle}>
              {result.suggestions.map((s) => (
                <SuggestionItem
                  key={`${s.kind}:${s.path}`}
                  suggestion={s}
                  isCurrent={isSamePath(s.path, currentSavePath)}
                  pending={pending === s.path}
                  applying={applying}
                  onRequestApply={onRequestApply}
                  onCancel={onCancel}
                  onConfirm={onConfirm}
                  t={t}
                  idPrefix={idPrefix}
                />
              ))}
            </ul>
          )}
          {result && (
            <p className="text-muted text-sm" style={textStyle}>
              {attribution}
              {result.pageUrl && (
                <>
                  {' '}
                  <a href={result.pageUrl} target="_blank" rel="noopener noreferrer">
                    {t('manifest.viewOnWiki')}<span className="sr-only"> {t('manifest.newWindow')}</span>
                  </a>
                </>
              )}
            </p>
          )}
        </>
      ) : (
        <p id={statusId} role="status" className="text-muted text-sm" style={textStyle}>{t('manifest.unavailable')}</p>
      )}
      {(!available || !result) && <p className="text-muted text-sm" style={textStyle}>{attribution}</p>}
    </section>
  );
}

function LookupError({ code, onRetry, t }: { code: string; onRetry: () => void; t: Translator }) {
  return (
    <div className="inline-error" style={textStyle}>
      <span style={textStyle}>{t(manifestErrorKey(code))}</span>
      {isRetryable(code) && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>{t('manifest.retry')}</button>
      )}
    </div>
  );
}

interface SuggestionItemProps {
  suggestion: ManifestSuggestion;
  isCurrent: boolean;
  pending: boolean;
  applying: string | null;
  onRequestApply: (path: string, trigger: HTMLElement | null) => void;
  onCancel: () => void;
  onConfirm: () => void;
  t: Translator;
  idPrefix: string;
}

function SuggestionItem({ suggestion, isCurrent, pending, applying, onRequestApply, onCancel, onConfirm, t, idPrefix }: SuggestionItemProps) {
  const { path, kind, exists } = suggestion;
  const busy = applying !== null;
  const confirmId = `${idPrefix}-confirm`;
  return (
    <li style={itemStyle}>
      <div style={badgeRowStyle}>
        <span className="badge">{kind === 'save' ? t('manifest.kindSave') : t('manifest.kindConfig')}</span>
        {exists ? (
          <span className="badge"><span aria-hidden="true" style={{ color: 'var(--green)' }}>✓</span> {t('manifest.exists')}</span>
        ) : (
          <span className="badge"><span aria-hidden="true" style={{ color: 'var(--red)' }}>✕</span> {t('manifest.missing')}</span>
        )}
        {isCurrent && <span className="badge"><span aria-hidden="true">●</span> {t('manifest.current')}</span>}
      </div>
      {/* Plain text only: React escapes it. */}
      <code style={pathStyle}>{path}</code>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={isCurrent}
        aria-disabled={!isCurrent && busy ? true : undefined}
        aria-label={t('manifest.useButtonLabel', { path })}
        aria-expanded={isCurrent ? undefined : pending}
        aria-controls={pending ? confirmId : undefined}
        onClick={(e) => { if (!isCurrent && !busy) onRequestApply(path, e?.currentTarget ?? null); }}
      >
        {applying === path ? t('manifest.applying') : t('manifest.useButton')}
      </button>
      {pending && <ConfirmInline id={confirmId} path={path} onCancel={onCancel} onConfirm={onConfirm} t={t} />}
    </li>
  );
}

function ConfirmInline({ id, path, onCancel, onConfirm, t }: { id: string; path: string; onCancel: () => void; onConfirm: () => void; t: Translator }) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    <div id={id} role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} style={confirmStyle} onKeyDown={onKeyDown}>
      <p id={`${id}-title`} style={{ ...textStyle, margin: 0 }}><strong>{t('manifest.confirmTitle')}</strong></p>
      <div id={`${id}-body`} style={textStyle}>
        <p className="text-sm" style={{ ...textStyle, margin: '4px 0 0' }}>{t('manifest.confirmBody')}</p>
        <code style={pathStyle}>{path}</code>
      </div>
      <div style={actionsStyle}>
        {/* Focus starts on Cancel, the safe choice. */}
        <button type="button" className="btn btn-secondary btn-sm" autoFocus onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm}>{t('manifest.confirm')}</button>
      </div>
    </div>
  );
}

export interface SavePathSuggestionsProps {
  gameId: string;
  currentSavePath?: string | null;
  /** Called with the exact suggested path, only after the user confirms it. */
  onApply: (path: string) => Promise<void> | void;
  /** Defaults to window.electronAPI; getManifestSuggestions may be missing at runtime (preload not wired yet). */
  api?: Partial<ManifestApi> | null;
  idPrefix?: string;
}

function bridgeFromWindow(): Partial<ManifestApi> | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: Partial<ManifestApi> }).electronAPI;
}

export function SavePathSuggestions({ gameId, currentSavePath, onApply, api, idPrefix }: SavePathSuggestionsProps) {
  const { t } = useI18n();
  const bridge = api === undefined ? bridgeFromWindow() : api;
  const [raw, dispatch] = useReducer(suggestionsReducer, gameId, initialSuggestionsState);
  // A different game shows a fresh, unfetched state (no auto-fetch).
  const state = raw.gameId === gameId ? raw : initialSuggestionsState(gameId);
  const seq = useRef(0);
  const live = useRef(true);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const onFind = async () => {
    if (state.loading || !hasManifestApi(bridge)) return;
    const mine = ++seq.current;
    dispatch({ type: 'start', gameId, seq: mine });
    const outcome = await runManifestLookup(bridge, gameId);
    if (live.current) dispatch({ type: 'done', seq: mine, outcome });
  };

  const refocus = () => {
    const el = trigger.current;
    if (el?.isConnected && !(el as HTMLButtonElement).disabled) el.focus();
  };

  return (
    <SavePathSuggestionsView
      available={hasManifestApi(bridge)}
      loading={state.loading}
      outcome={state.outcome}
      currentSavePath={currentSavePath}
      pending={state.pending}
      applying={state.applying}
      applyResult={state.applyResult}
      onFind={() => { void onFind(); }}
      onRequestApply={(path, el) => { trigger.current = el; dispatch({ type: 'request', path, current: currentSavePath }); }}
      onCancel={() => { dispatch({ type: 'cancel' }); refocus(); }}
      onConfirm={() => { void confirmPending(state, dispatch, onApply, () => live.current).then(refocus); }}
      t={t}
      idPrefix={idPrefix}
    />
  );
}
