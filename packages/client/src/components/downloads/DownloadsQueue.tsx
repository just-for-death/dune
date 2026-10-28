import { useEffect, useId, useRef, useState, type Ref } from 'react';
import './downloads.css';
import {
  ACTION_LABEL_KEYS,
  announcementText,
  actionsFor,
  errorCodeOf,
  errorMessageKey,
  etaText,
  failedSummaryText,
  isEarlierFolder,
  isRetryPending,
  progressInfo,
  speedText,
  statusText,
  statusTone,
} from './downloadsFormat';
import { canShowInFolder, type DownloadsState } from './downloadsStore';
import { useI18n } from '../../i18n/context';
import type { Translator } from '../../i18n';
import type { DownloadAction, DownloadSnapshot, DownloadsQueueApi } from './types';
import { useDownloads } from './useDownloads';

const TONE_CLASS = {
  done: 'status-complete',
  error: 'downloads-status-error',
  active: 'status-partial',
  idle: 'status-restored',
} as const;

function ProgressBar({ item, t }: { item: DownloadSnapshot; t: Translator }) {
  const { percent, bytesText } = progressInfo(item, t);
  const label = t('downloads.progressLabel', { name: item.name });
  if (percent === null) {
    return (
      <div className="progress-track progress-sm downloads-progress" role="progressbar" aria-label={label} aria-valuetext={bytesText}>
        <div className={`progress-fill downloads-indeterminate${item.status === 'downloading' ? ' is-active' : ''}`} />
      </div>
    );
  }
  return (
    <div
      className="progress-track progress-sm downloads-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={t('downloads.valueText', { percent, bytes: bytesText })}
    >
      <div className={`progress-fill${item.status === 'completed' ? ' progress-done' : ''}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

interface RowProps {
  item: DownloadSnapshot;
  now: number;
  t: Translator;
  busy?: DownloadAction;
  actionError?: string;
  onAction: (id: string, action: DownloadAction) => void;
  baseDir?: string;
  onShowInFolder?: (id: string) => void;
}

function DownloadRow({ item, now, t, busy, actionError, onAction, baseDir, onShowInFolder }: RowProps) {
  const { bytesText } = progressInfo(item, t);
  const speed = speedText(item, t);
  const eta = etaText(item, t);
  const code = item.status === 'failed' || isRetryPending(item, now) ? errorCodeOf(item) : null;
  const host = item.host || t('downloads.unknownHost');
  const errId = `${useId()}-err`;
  const describedBy = actionError ? errId : undefined;
  return (
    <li className="admin-row downloads-row">
      <div className="admin-row-main downloads-row-main">
        <span className="admin-row-value downloads-name" title={item.name}>{item.name}</span>
        <span className="admin-row-meta downloads-meta" title={item.url}>
          {item.source ? t('downloads.meta', { host, source: item.source }) : host}
        </span>
        {item.root && (
          <span className="admin-row-meta downloads-meta" title={item.root}>
            {t('downloads.folder', { root: item.root })}
            {isEarlierFolder(item.root, baseDir) && <span className="badge downloads-folder-badge">{t('downloads.folderEarlier')}</span>}
          </span>
        )}
        <ProgressBar item={item} t={t} />
        <span className="admin-row-meta downloads-figures">
          <span className={`status-pill downloads-status ${TONE_CLASS[statusTone(item.status)]}`}>{statusText(item, now, t)}</span>
          <span>{bytesText}</span>
          {speed && <span>{speed}</span>}
          {eta && <span>{eta}</span>}
        </span>
        {code && <p className="error-text text-sm">{t(errorMessageKey(code))}</p>}
        {actionError && <p id={errId} className="error-text text-sm">{t(errorMessageKey(actionError))}</p>}
      </div>
      <div className="admin-row-actions">
        {actionsFor(item.status).map(action => {
          const keys = ACTION_LABEL_KEYS[action];
          return (
            <button
              key={action}
              type="button"
              className={`btn btn-sm ${action === 'retry' || action === 'resume' ? 'btn-primary' : 'btn-secondary'}`}
              aria-label={t(keys.label, { name: item.name })}
              aria-disabled={busy ? 'true' : undefined}
              aria-describedby={describedBy}
              onClick={() => { if (!busy) onAction(item.id, action); }}
            >
              {t(keys.text)}
            </button>
          );
        })}
        {onShowInFolder && (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            aria-label={t('downloads.showInFolderLabel', { name: item.name })}
            aria-describedby={describedBy}
            onClick={() => onShowInFolder(item.id)}
          >
            {t('downloads.showInFolder')}
          </button>
        )}
      </div>
    </li>
  );
}

export interface DownloadsQueueViewProps {
  state: DownloadsState;
  /** Epoch ms used for "Retrying in…" countdowns. */
  now: number;
  onAction: (id: string, action: DownloadAction) => void;
  onReload: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Current base folder; rows saved elsewhere get an "Earlier download folder" badge. */
  baseDir?: string;
  /** Reveal the item (by id). The button is hidden when omitted. */
  onShowInFolder?: (id: string) => void;
}

/** Presentational queue (no hooks beyond ids) so it renders in static tests. */
export function DownloadsQueueView({ state, now, onAction, onReload, headingRef, baseDir, onShowInFolder }: DownloadsQueueViewProps) {
  const { t, tc } = useI18n();
  const headingId = useId();
  const failed = state.items.filter(i => i.status === 'failed');
  return (
    <section className="card downloads-queue" aria-labelledby={headingId}>
      <h3 id={headingId} className="card-title" ref={headingRef} tabIndex={-1}>{t('downloads.queueTitle')}</h3>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcementText(state.announcement, t)}
      </p>
      {state.phase === 'loading' && state.items.length === 0 && <p className="text-muted">{t('downloads.loading')}</p>}
      {state.phase === 'error' && (
        <div className="inline-error" role="alert">
          <span>{t('downloads.loadFailed')} {t(errorMessageKey(state.loadError))}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onReload}>{t('common.tryAgain')}</button>
        </div>
      )}
      {failed.length > 0 && (
        <div className="inline-error downloads-error-summary">
          <strong>{failedSummaryText(failed.length, tc)}</strong>
          <ul className="downloads-error-list">
            {failed.map(i => (
              <li key={i.id} className="downloads-name" title={i.name}>
                {t('downloads.failedItem', { name: i.name, reason: t(errorMessageKey(errorCodeOf(i))) })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.phase === 'ready' && state.items.length === 0 && <p className="empty-state">{t('downloads.empty')}</p>}
      {state.items.length > 0 && (
        <ul className="admin-list downloads-list" aria-label={t('downloads.listLabel')}>
          {state.items.map(item => (
            <DownloadRow
              key={item.id}
              item={item}
              now={now}
              t={t}
              busy={state.busy[item.id]}
              actionError={state.actionErrors[item.id]}
              onAction={onAction}
              baseDir={baseDir}
              onShowInFolder={onShowInFolder}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One-second clock, running only while some row shows a retry countdown. */
function useRetryClock(state: DownloadsState): number {
  const [now, setNow] = useState(() => Date.now());
  const waiting = state.items.some(i => i.status === 'queued' && typeof i.nextRetryAt === 'number');
  useEffect(() => {
    if (!waiting) return;
    const tick = () => setNow(Date.now());
    const handle = setInterval(tick, 1000);
    const first = setTimeout(tick, 0);
    return () => { clearInterval(handle); clearTimeout(first); };
  }, [waiting]);
  return now;
}

export interface DownloadsQueueProps {
  /** window.electronAPI (or a Pick of it); showDownloadInFolder is used directly when present. */
  api: DownloadsQueueApi;
  /** Current base folder (from DownloadsSettingsPanel's onSettings) for the "Earlier download folder" badge. */
  baseDir?: string;
}

export function DownloadsQueue({ api, baseDir }: DownloadsQueueProps) {
  const { state, act, reload, showInFolder } = useDownloads(api);
  const now = useRetryClock(state);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onAction = (id: string, action: DownloadAction) => {
    void act(id, action).then(ok => {
      // The removed row (and its focused button) is gone; keep focus in the queue.
      if (ok && action === 'remove') headingRef.current?.focus();
    });
  };
  return (
    <DownloadsQueueView
      state={state}
      now={now}
      onAction={onAction}
      onReload={reload}
      headingRef={headingRef}
      baseDir={baseDir}
      onShowInFolder={canShowInFolder(api) ? id => void showInFolder(id) : undefined}
    />
  );
}
