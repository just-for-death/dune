import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ApiKeyInfo, LocalSource, RemoteServer } from '@dune/shared';
import { createLatestGate } from '../../services/latest';
import { useI18n } from '../../i18n/context';
import type { MessageKey } from '../../i18n';
import {
  NEEDS_ADMIN,
  describeFailure,
  failureInfo,
  formatCreated,
  isServerOk,
  validateKeyName,
  validateRemoteServerUrl,
  validateSourcePath,
  type FailureInfo,
} from '../../services/serverAdmin';
import { ConfirmDialog } from './ConfirmDialog';

export { NEEDS_ADMIN };

interface Props {
  /** Saved Dune server address (never a draft). Empty means no server. */
  serverUrl: string;
  /** Whether this PC has a server key. The key itself is never passed here. */
  serverKeySet: boolean;
  /** Bumped when this PC's key changes so lists reload with the new key. */
  connectionVersion: number;
  /** Element ids of the server address and key fields on this page. */
  serverUrlFieldId: string;
  serverKeyFieldId: string;
}

type ListState<T> =
  | { status: 'idle'; items: T[] }
  | { status: 'loading'; items: T[] }
  | { status: 'ready'; items: T[] }
  | { status: 'error'; items: T[]; error: string };

type Loaded<T> = { ok: true; items: T[] } | { ok: false; failure?: FailureInfo };

function focusById(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.focus();
}

async function call<R>(fn: () => Promise<R>): Promise<R | Error> {
  try {
    return await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Loads a server-backed list; only the newest request may write state.
 * Sections are remounted when the connection changes, so state starts fresh.
 */
function useServerList<T>(enabled: boolean, load: () => Promise<Loaded<T>>) {
  const { t } = useI18n();
  const [state, setState] = useState<ListState<T>>(() => ({ status: enabled ? 'loading' : 'idle', items: [] }));
  const gate = useMemo(() => createLatestGate<number>(), []);

  const run = useCallback(() => {
    const ticket = gate.begin(0);
    return load().then(result => {
      if (!ticket.isLatest()) return;
      setState(result.ok
        ? { status: 'ready', items: result.items }
        : { status: 'error', items: [], error: describeFailure('load', result.failure, t) });
    });
  }, [gate, load, t]);

  useEffect(() => {
    if (enabled) void run();
    return () => gate.invalidate();
  }, [enabled, run, gate]);

  const reload = useCallback(() => {
    setState(prev => ({ status: 'loading', items: prev.items }));
    void run();
  }, [run]);

  const setItems = useCallback((update: (items: T[]) => T[]) => {
    setState(prev => ({ status: 'ready', items: update(prev.items) }));
  }, []);

  return { state, reload, setItems };
}

const loadSources = async (): Promise<Loaded<LocalSource>> => {
  const res = await call(() => window.electronAPI.getLocalSources());
  return isServerOk(res) ? { ok: true, items: (res as { sources?: LocalSource[] }).sources ?? [] } : { ok: false, failure: failureInfo(res) };
};
const loadServers = async (): Promise<Loaded<RemoteServer>> => {
  const res = await call(() => window.electronAPI.getRemoteServers());
  return isServerOk(res) ? { ok: true, items: (res as { servers?: RemoteServer[] }).servers ?? [] } : { ok: false, failure: failureInfo(res) };
};
const loadKeys = async (): Promise<Loaded<ApiKeyInfo>> => {
  const res = await call(() => window.electronAPI.getApiKeys());
  return isServerOk(res) ? { ok: true, items: (res as { keys?: ApiKeyInfo[] }).keys ?? [] } : { ok: false, failure: failureInfo(res) };
};

function NoServer({ fieldId }: { fieldId: string }) {
  const { t } = useI18n();
  return (
    <p className="no-server">
      {t('where.noServerSentence')}{' '}
      <a href={`#${fieldId}`} className="text-link" onClick={e => { e.preventDefault(); focusById(fieldId); }}>
        {t('where.setAddress')}
      </a>
    </p>
  );
}

function ListStatus<T>({ state, loading, onRetry, empty }: { state: ListState<T>; loading: string; onRetry: () => void; empty: ReactNode }) {
  const { t } = useI18n();
  if (state.status === 'loading' && state.items.length === 0) return <p className="text-muted text-sm">{loading}</p>;
  if (state.status === 'error') {
    return (
      <div className="inline-error" role="alert">
        <span>{state.error}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>{t('common.tryAgain')}</button>
      </div>
    );
  }
  if (state.status === 'ready' && state.items.length === 0) return <p className="text-muted text-sm">{empty}</p>;
  return null;
}

/** Visible, polite status line for a section (never contains keys). */
function SectionStatus({ message }: { message: string }) {
  return <p className="section-status" role="status" aria-live="polite">{message}</p>;
}

interface RowError { id: string | number; message: string }

/* ── Sources ─────────────────────────────────────────────────────────────── */

function SourcesSection({ enabled, serverUrlFieldId }: { enabled: boolean; serverUrlFieldId: string }) {
  const { t, tc } = useI18n();
  const { state, reload, setItems } = useServerList(enabled, loadSources);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<LocalSource | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [announce, setAnnounce] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = { heading: useId(), input: useId(), hint: useId(), error: useId() };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (adding) return;
    const check = validateSourcePath(draft, state.items.map(s => s.path), t);
    if (!check.ok) { setFieldError(check.error); return; }
    setFieldError(null);
    setAdding(true);
    const res = await call(() => window.electronAPI.addLocalSource(check.value));
    setAdding(false);
    if (!isServerOk(res)) { setFieldError(describeFailure('add-source', failureInfo(res), t)); return; }
    const source = (res as { source?: LocalSource }).source;
    if (source) setItems(items => [...items, source]);
    else void reload();
    setDraft('');
    setAnnounce(t('where.sources.added'));
  };

  const remove = async (source: LocalSource) => {
    setConfirm(null);
    setRowError(null);
    setRemoving(source.id);
    const res = await call(() => window.electronAPI.removeLocalSource(source.id));
    setRemoving(null);
    if (!isServerOk(res)) {
      setRowError({ id: source.id, message: describeFailure('remove-source', failureInfo(res), t) });
      return;
    }
    setItems(items => items.filter(s => s.id !== source.id));
    setAnnounce(t('where.sources.removed'));
    headingRef.current?.focus();
  };

  const describedBy = [ids.hint, fieldError ? ids.error : null].filter(Boolean).join(' ');

  return (
    <section className="card admin-card" aria-labelledby={ids.heading}>
      <h4 id={ids.heading} ref={headingRef} tabIndex={-1} className="card-title">{t('where.sources.title')}</h4>
      <p className="card-desc">{t('where.sources.desc')}</p>
      {!enabled ? <NoServer fieldId={serverUrlFieldId} /> : (
        <>
          <ListStatus state={state} loading={t('where.sources.loading')} onRetry={reload} empty={t('where.sources.empty')} />
          {state.items.length > 0 && (
            <ul className="admin-list" aria-label={t('where.sources.title')}>
              {state.items.map(source => (
                <li key={source.id} className="admin-row">
                  <div className="admin-row-main">
                    <span className="admin-row-value path-value" title={source.path}>{source.path}</span>
                    {rowError?.id === source.id && <p className="error-text" role="alert">{rowError.message}</p>}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    aria-label={t('where.sources.removeLabel', { path: source.path })}
                    aria-disabled={removing === source.id || undefined}
                    aria-busy={removing === source.id || undefined}
                    onClick={() => { if (removing !== source.id) setConfirm(source); }}
                  >
                    {t('common.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.status !== 'error' && (
            <form className="admin-form" onSubmit={submit} noValidate>
              <div className="form-group">
                <label htmlFor={ids.input}>{t('where.sources.pathLabel')}</label>
                <input
                  id={ids.input}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className={fieldError ? 'input-error' : ''}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={describedBy}
                  placeholder="/srv/games/saves"
                  value={draft}
                  onChange={e => { setDraft(e.target.value); if (fieldError) setFieldError(null); }}
                />
                <p id={ids.hint} className="form-hint">{t('where.sources.hint')}</p>
                {fieldError && <p id={ids.error} className="error-text" role="alert">{fieldError}</p>}
              </div>
              <button type="submit" className="btn btn-primary" aria-disabled={adding || undefined}>
                {adding ? t('where.adding') : t('where.sources.add')}
              </button>
            </form>
          )}
          <SectionStatus message={announce || (state.status === 'ready' ? tc('where.sources.count', state.items.length) : '')} />
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={t('where.sources.confirmTitle')}
        confirmLabel={t('where.sources.confirmLabel')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void remove(confirm); }}
      >
        <p className="path-value">{confirm?.path}</p>
        <p className="muted">{t('where.sources.confirmBody')}</p>
      </ConfirmDialog>
    </section>
  );
}

/* ── Servers ─────────────────────────────────────────────────────────────── */

function ServersSection({ enabled, serverUrlFieldId }: { enabled: boolean; serverUrlFieldId: string }) {
  const { t, tc } = useI18n();
  const { state, reload, setItems } = useServerList(enabled, loadServers);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<RemoteServer | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [announce, setAnnounce] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = { heading: useId(), input: useId(), hint: useId(), error: useId(), testReason: useId() };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (adding) return;
    const check = validateRemoteServerUrl(draft, state.items.map(s => s.url), t);
    if (!check.ok) { setFieldError(check.error); return; }
    setFieldError(null);
    setAdding(true);
    const res = await call(() => window.electronAPI.addRemoteServer(check.value));
    setAdding(false);
    if (!isServerOk(res)) { setFieldError(describeFailure('add-server', failureInfo(res), t)); return; }
    const server = (res as { server?: RemoteServer }).server;
    if (server) setItems(items => [...items, server]);
    else void reload();
    setDraft('');
    setAnnounce(t('where.servers.added'));
  };

  const remove = async (server: RemoteServer) => {
    setConfirm(null);
    setRowError(null);
    setRemoving(server.id);
    const res = await call(() => window.electronAPI.removeRemoteServer(server.id));
    setRemoving(null);
    if (!isServerOk(res)) {
      setRowError({ id: server.id, message: describeFailure('remove-server', failureInfo(res), t) });
      return;
    }
    setItems(items => items.filter(s => s.id !== server.id));
    setAnnounce(t('where.servers.removed'));
    headingRef.current?.focus();
  };

  const describedBy = [ids.hint, fieldError ? ids.error : null].filter(Boolean).join(' ');

  return (
    <section className="card admin-card" aria-labelledby={ids.heading}>
      <h4 id={ids.heading} ref={headingRef} tabIndex={-1} className="card-title">{t('where.servers.title')}</h4>
      <p className="card-desc">{t('where.servers.desc')}</p>
      {!enabled ? <NoServer fieldId={serverUrlFieldId} /> : (
        <>
          <ListStatus state={state} loading={t('where.servers.loading')} onRetry={reload} empty={t('where.servers.empty')} />
          {state.items.length > 0 && (
            <ul className="admin-list" aria-label={t('where.servers.title')}>
              {state.items.map(server => (
                <li key={server.id} className="admin-row">
                  <div className="admin-row-main">
                    <span className="admin-row-value path-value" title={server.url}>{server.url}</span>
                    <span className="admin-row-meta">{t('where.servers.status', { status: t('where.notTested') })}</span>
                    {rowError?.id === server.id && <p className="error-text" role="alert">{rowError.message}</p>}
                  </div>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled
                      aria-label={t('where.servers.testLabel', { url: server.url })}
                      aria-describedby={ids.testReason}
                    >
                      {t('where.servers.test')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      aria-label={t('where.servers.removeLabel', { url: server.url })}
                      aria-disabled={removing === server.id || undefined}
                      aria-busy={removing === server.id || undefined}
                      onClick={() => { if (removing !== server.id) setConfirm(server); }}
                    >
                      {t('common.remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {state.items.length > 0 && <p id={ids.testReason} className="form-hint">{t('where.servers.testReason', { reason: t('where.notAvailableYet') })}</p>}
          {state.status !== 'error' && (
            <form className="admin-form" onSubmit={submit} noValidate>
              <div className="form-group">
                <label htmlFor={ids.input}>{t('where.servers.addressLabel')}</label>
                <input
                  id={ids.input}
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className={fieldError ? 'input-error' : ''}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={describedBy}
                  placeholder="http://192.168.1.20:3030"
                  value={draft}
                  onChange={e => { setDraft(e.target.value); if (fieldError) setFieldError(null); }}
                />
                <p id={ids.hint} className="form-hint">{t('where.servers.hint')}</p>
                {fieldError && <p id={ids.error} className="error-text" role="alert">{fieldError}</p>}
              </div>
              <button type="submit" className="btn btn-primary" aria-disabled={adding || undefined}>
                {adding ? t('where.adding') : t('where.servers.add')}
              </button>
            </form>
          )}
          <SectionStatus message={announce || (state.status === 'ready' ? tc('where.servers.count', state.items.length) : '')} />
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={t('where.servers.confirmTitle')}
        confirmLabel={t('where.servers.confirmLabel')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void remove(confirm); }}
      >
        <p className="path-value">{confirm?.url}</p>
        <p className="muted">{t('where.servers.confirmBody')}</p>
      </ConfirmDialog>
    </section>
  );
}

/* ── API keys ────────────────────────────────────────────────────────────── */

// Provider names stay as shown in English (product names; e2e matches them).
const PROVIDERS: { id: string; name: string; purpose: MessageKey }[] = [
  { id: 'steamgriddb', name: 'SteamGridDB', purpose: 'where.keys.provider.steamgriddb' },
  { id: 'tracker', name: 'Achievement tracker', purpose: 'where.keys.provider.tracker' },
];

function ApiKeysSection({ enabled, serverKeySet, serverUrlFieldId, serverKeyFieldId }: {
  enabled: boolean; serverKeySet: boolean; serverUrlFieldId: string; serverKeyFieldId: string;
}) {
  const { t, tc, locale } = useI18n();
  const { state, reload, setItems } = useServerList(enabled, loadKeys);
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  // Plaintext of a just-issued key. Shown once, kept only in this state, never logged or toasted.
  const [issued, setIssued] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ApiKeyInfo | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [announce, setAnnounce] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const issuedRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const ids = {
    heading: useId(), pcHeading: useId(), serverHeading: useId(), providersHeading: useId(),
    input: useId(), hint: useId(), error: useId(), issued: useId(), issuedHint: useId(),
  };

  useEffect(() => {
    if (issued) {
      issuedRef.current?.focus();
      issuedRef.current?.select();
    }
  }, [issued]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (issuing) return;
    const check = validateKeyName(name, t);
    if (!check.ok) { setFieldError(check.error); return; }
    setFieldError(null);
    setIssuing(true);
    const res = await call(() => window.electronAPI.addApiKey(check.value || undefined));
    setIssuing(false);
    const key = !(res instanceof Error) && isServerOk(res) ? (res as { key?: string }).key : undefined;
    if (!key) { setFieldError(describeFailure('issue-key', failureInfo(res), t)); return; }
    setName('');
    setIssued(key);
    setAnnounce(t('where.keys.issued'));
    void reload();
  };

  const copyIssued = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setAnnounce(t('where.keys.copied'));
    } catch {
      issuedRef.current?.select();
      setAnnounce(t('where.keys.copyFailed'));
    }
  };

  const dismissIssued = () => {
    setIssued(null);
    setAnnounce('');
    nameRef.current?.focus();
  };

  const revoke = async (key: ApiKeyInfo) => {
    setConfirm(null);
    setRowError(null);
    setRevoking(key.id);
    const res = await call(() => window.electronAPI.removeApiKey(key.id));
    setRevoking(null);
    if (!isServerOk(res)) {
      setRowError({ id: key.id, message: describeFailure('revoke-key', failureInfo(res), t) });
      return;
    }
    setItems(items => items.filter(k => k.id !== key.id));
    setAnnounce(t('where.keys.revoked'));
    headingRef.current?.focus();
  };

  const keyLabel = (key: ApiKeyInfo) => key.description.trim() || t('where.keys.unnamed');
  const describedBy = [ids.hint, fieldError ? ids.error : null].filter(Boolean).join(' ');

  return (
    <section className="card admin-card" aria-labelledby={ids.heading}>
      <h4 id={ids.heading} ref={headingRef} tabIndex={-1} className="card-title">{t('where.keys.title')}</h4>

      <h5 id={ids.pcHeading} className="admin-subtitle">{t('where.keys.onPc')}</h5>
      <ul className="admin-list" aria-labelledby={ids.pcHeading}>
        <li className="admin-row">
          <div className="admin-row-main">
            <span className="admin-row-value">{t('where.keys.serverKey')}</span>
            <span className="admin-row-meta">
              <span className={serverKeySet ? 'key-status key-status-set' : 'key-status'}>{serverKeySet ? t('where.keys.set') : t('where.keys.notSet')}</span>
              {' '}{t('where.keys.serverKeyUse')}
            </span>
          </div>
          <a href={`#${serverKeyFieldId}`} className="btn btn-secondary btn-sm" onClick={e => { e.preventDefault(); focusById(serverKeyFieldId); }}>
            {serverKeySet ? t('where.keys.change') : t('where.keys.setKey')}
          </a>
        </li>
      </ul>

      <h5 id={ids.providersHeading} className="admin-subtitle">{t('where.keys.providers')}</h5>
      <ul className="admin-list" aria-labelledby={ids.providersHeading}>
        {PROVIDERS.map(provider => (
          <li key={provider.id} className="admin-row admin-row-disabled">
            <div className="admin-row-main">
              <span className="admin-row-value">{provider.name}</span>
              <span className="admin-row-meta" id={`provider-${provider.id}-reason`}>{t('where.keys.providerReason', { purpose: t(provider.purpose), pending: t('where.providerPending') })}</span>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled aria-label={t('where.keys.providerSetLabel', { name: provider.name })} aria-describedby={`provider-${provider.id}-reason`}>
              {t('where.keys.setKey')}
            </button>
          </li>
        ))}
      </ul>

      <h5 id={ids.serverHeading} className="admin-subtitle">{t('where.keys.onServer')}</h5>
      {!enabled ? <NoServer fieldId={serverUrlFieldId} /> : (
        <>
          <p className="card-desc">{t('where.keys.serverDesc')}</p>
          <ListStatus state={state} loading={t('where.keys.loading')} onRetry={reload} empty={t('where.keys.empty')} />
          {state.items.length > 0 && (
            <ul className="admin-list" aria-labelledby={ids.serverHeading}>
              {state.items.map(key => (
                <li key={key.id} className="admin-row">
                  <div className="admin-row-main">
                    <span className="admin-row-value" title={keyLabel(key)}>{keyLabel(key)}</span>
                    <span className="admin-row-meta">{t('where.keys.created', { date: formatCreated(key.createdAt, t, locale), masked: key.masked })}</span>
                    {rowError?.id === key.id && <p className="error-text" role="alert">{rowError.message}</p>}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    aria-label={t('where.keys.revokeLabel', { name: keyLabel(key) })}
                    aria-disabled={revoking === key.id || undefined}
                    aria-busy={revoking === key.id || undefined}
                    onClick={() => { if (revoking !== key.id) setConfirm(key); }}
                  >
                    {t('where.keys.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {issued && (
            <div className="issued-key">
              <label id={ids.issued} htmlFor={`${ids.issued}-value`}>{t('where.keys.newKey')}</label>
              <p id={ids.issuedHint} className="form-hint">{t('where.keys.copyNow')}</p>
              <div className="issued-key-row">
                <input
                  ref={issuedRef}
                  id={`${ids.issued}-value`}
                  type="text"
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  className="mono issued-key-value"
                  aria-describedby={ids.issuedHint}
                  value={issued}
                />
                <button type="button" className="btn btn-primary btn-sm" onClick={copyIssued}>{t('where.keys.copy')}</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={dismissIssued}>{t('where.keys.done')}</button>
              </div>
            </div>
          )}

          {state.status !== 'error' && (
            <form className="admin-form" onSubmit={submit} noValidate>
              <div className="form-group">
                <label htmlFor={ids.input}>{t('where.keys.nameLabel')}</label>
                <input
                  ref={nameRef}
                  id={ids.input}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className={fieldError ? 'input-error' : ''}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={describedBy}
                  placeholder={t('where.keys.namePlaceholder')}
                  value={name}
                  onChange={e => { setName(e.target.value); if (fieldError) setFieldError(null); }}
                />
                <p id={ids.hint} className="form-hint">{t('where.keys.nameHint')}</p>
                {fieldError && <p id={ids.error} className="error-text" role="alert">{fieldError}</p>}
              </div>
              <button type="submit" className="btn btn-primary" aria-disabled={issuing || undefined}>
                {issuing ? t('where.keys.issuing') : t('where.keys.issue')}
              </button>
            </form>
          )}
          <SectionStatus message={announce || (state.status === 'ready' ? tc('where.keys.count', state.items.length) : '')} />
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={t('where.keys.confirmTitle')}
        confirmLabel={t('where.keys.confirmLabel')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void revoke(confirm); }}
      >
        <p>{confirm ? keyLabel(confirm) : ''}</p>
        <p className="muted">{t('where.keys.confirmBody')}</p>
      </ConfirmDialog>
    </section>
  );
}

/** DUN-032: settings for what the Dune server scans, copies to, and which keys it accepts. */
export function WhereItRuns({ serverUrl, serverKeySet, connectionVersion, serverUrlFieldId, serverKeyFieldId }: Props) {
  const { t } = useI18n();
  const enabled = serverUrl.trim() !== '';
  // Remount on connection change: lists reload and drafts/one-time keys are dropped.
  const key = enabled ? `${serverUrl}#${connectionVersion}` : 'no-server';
  return (
    <section className="where-it-runs" aria-labelledby="where-it-runs-heading">
      <h3 id="where-it-runs-heading" className="section-subtitle where-heading">{t('where.heading')}</h3>
      <SourcesSection key={`sources-${key}`} enabled={enabled} serverUrlFieldId={serverUrlFieldId} />
      <ServersSection key={`servers-${key}`} enabled={enabled} serverUrlFieldId={serverUrlFieldId} />
      <ApiKeysSection key={`keys-${key}`} enabled={enabled} serverKeySet={serverKeySet} serverUrlFieldId={serverUrlFieldId} serverKeyFieldId={serverKeyFieldId} />
    </section>
  );
}
