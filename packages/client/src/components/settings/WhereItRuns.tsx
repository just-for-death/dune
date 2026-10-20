import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ApiKeyInfo, LocalSource, RemoteServer } from '@dune/shared';
import { createLatestGate } from '../../services/latest';
import {
  NEEDS_ADMIN,
  NO_SERVER,
  NOT_AVAILABLE_YET,
  NOT_TESTED,
  PROVIDER_PENDING,
  countLabel,
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
  const [state, setState] = useState<ListState<T>>(() => ({ status: enabled ? 'loading' : 'idle', items: [] }));
  const gate = useMemo(() => createLatestGate<number>(), []);

  const run = useCallback(() => {
    const ticket = gate.begin(0);
    return load().then(result => {
      if (!ticket.isLatest()) return;
      setState(result.ok
        ? { status: 'ready', items: result.items }
        : { status: 'error', items: [], error: describeFailure('load', result.failure) });
    });
  }, [gate, load]);

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
  return (
    <p className="no-server">
      {NO_SERVER}.{' '}
      <a href={`#${fieldId}`} className="text-link" onClick={e => { e.preventDefault(); focusById(fieldId); }}>
        Set the server address
      </a>
    </p>
  );
}

function ListStatus<T>({ state, noun, onRetry, empty }: { state: ListState<T>; noun: string; onRetry: () => void; empty: ReactNode }) {
  if (state.status === 'loading' && state.items.length === 0) return <p className="text-muted text-sm">Loading {noun}…</p>;
  if (state.status === 'error') {
    return (
      <div className="inline-error" role="alert">
        <span>{state.error}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
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
    const check = validateSourcePath(draft, state.items.map(s => s.path));
    if (!check.ok) { setFieldError(check.error); return; }
    setFieldError(null);
    setAdding(true);
    const res = await call(() => window.electronAPI.addLocalSource(check.value));
    setAdding(false);
    if (!isServerOk(res)) { setFieldError(describeFailure('add-source', failureInfo(res))); return; }
    const source = (res as { source?: LocalSource }).source;
    if (source) setItems(items => [...items, source]);
    else void reload();
    setDraft('');
    setAnnounce('Source added.');
  };

  const remove = async (source: LocalSource) => {
    setConfirm(null);
    setRowError(null);
    setRemoving(source.id);
    const res = await call(() => window.electronAPI.removeLocalSource(source.id));
    setRemoving(null);
    if (!isServerOk(res)) {
      setRowError({ id: source.id, message: describeFailure('remove-source', failureInfo(res)) });
      return;
    }
    setItems(items => items.filter(s => s.id !== source.id));
    setAnnounce('Source removed.');
    headingRef.current?.focus();
  };

  const describedBy = [ids.hint, fieldError ? ids.error : null].filter(Boolean).join(' ');

  return (
    <section className="card admin-card" aria-labelledby={ids.heading}>
      <h4 id={ids.heading} ref={headingRef} tabIndex={-1} className="card-title">Sources</h4>
      <p className="card-desc">Folders on your Dune server that it scans for game saves.</p>
      {!enabled ? <NoServer fieldId={serverUrlFieldId} /> : (
        <>
          <ListStatus state={state} noun="sources" onRetry={reload} empty="No sources yet. Add a folder below." />
          {state.items.length > 0 && (
            <ul className="admin-list" aria-label="Sources">
              {state.items.map(source => (
                <li key={source.id} className="admin-row">
                  <div className="admin-row-main">
                    <span className="admin-row-value path-value" title={source.path}>{source.path}</span>
                    {rowError?.id === source.id && <p className="error-text" role="alert">{rowError.message}</p>}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    aria-label={`Remove source ${source.path}`}
                    aria-disabled={removing === source.id || undefined}
                    aria-busy={removing === source.id || undefined}
                    onClick={() => { if (removing !== source.id) setConfirm(source); }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.status !== 'error' && (
            <form className="admin-form" onSubmit={submit} noValidate>
              <div className="form-group">
                <label htmlFor={ids.input}>Folder path on the server</label>
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
                <p id={ids.hint} className="form-hint">The path as the server sees it, not a folder on this PC.</p>
                {fieldError && <p id={ids.error} className="error-text" role="alert">{fieldError}</p>}
              </div>
              <button type="submit" className="btn btn-primary" aria-disabled={adding || undefined}>
                {adding ? 'Adding…' : 'Add source'}
              </button>
            </form>
          )}
          <SectionStatus message={announce || (state.status === 'ready' ? countLabel(state.items.length, 'source') : '')} />
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title="Remove this source?"
        confirmLabel="Remove source"
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void remove(confirm); }}
      >
        <p className="path-value">{confirm?.path}</p>
        <p className="muted">The server stops scanning this folder. Files in it are not deleted.</p>
      </ConfirmDialog>
    </section>
  );
}

/* ── Servers ─────────────────────────────────────────────────────────────── */

function ServersSection({ enabled, serverUrlFieldId }: { enabled: boolean; serverUrlFieldId: string }) {
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
    const check = validateRemoteServerUrl(draft, state.items.map(s => s.url));
    if (!check.ok) { setFieldError(check.error); return; }
    setFieldError(null);
    setAdding(true);
    const res = await call(() => window.electronAPI.addRemoteServer(check.value));
    setAdding(false);
    if (!isServerOk(res)) { setFieldError(describeFailure('add-server', failureInfo(res))); return; }
    const server = (res as { server?: RemoteServer }).server;
    if (server) setItems(items => [...items, server]);
    else void reload();
    setDraft('');
    setAnnounce('Server added.');
  };

  const remove = async (server: RemoteServer) => {
    setConfirm(null);
    setRowError(null);
    setRemoving(server.id);
    const res = await call(() => window.electronAPI.removeRemoteServer(server.id));
    setRemoving(null);
    if (!isServerOk(res)) {
      setRowError({ id: server.id, message: describeFailure('remove-server', failureInfo(res)) });
      return;
    }
    setItems(items => items.filter(s => s.id !== server.id));
    setAnnounce('Server removed.');
    headingRef.current?.focus();
  };

  const describedBy = [ids.hint, fieldError ? ids.error : null].filter(Boolean).join(' ');

  return (
    <section className="card admin-card" aria-labelledby={ids.heading}>
      <h4 id={ids.heading} ref={headingRef} tabIndex={-1} className="card-title">Servers</h4>
      <p className="card-desc">Other Dune servers your server copies saves to.</p>
      {!enabled ? <NoServer fieldId={serverUrlFieldId} /> : (
        <>
          <ListStatus state={state} noun="servers" onRetry={reload} empty="No other servers yet. Add one below." />
          {state.items.length > 0 && (
            <ul className="admin-list" aria-label="Servers">
              {state.items.map(server => (
                <li key={server.id} className="admin-row">
                  <div className="admin-row-main">
                    <span className="admin-row-value path-value" title={server.url}>{server.url}</span>
                    <span className="admin-row-meta">Status: {NOT_TESTED}</span>
                    {rowError?.id === server.id && <p className="error-text" role="alert">{rowError.message}</p>}
                  </div>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled
                      aria-label={`Test ${server.url}`}
                      aria-describedby={ids.testReason}
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      aria-label={`Remove server ${server.url}`}
                      aria-disabled={removing === server.id || undefined}
                      aria-busy={removing === server.id || undefined}
                      onClick={() => { if (removing !== server.id) setConfirm(server); }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {state.items.length > 0 && <p id={ids.testReason} className="form-hint">Test: {NOT_AVAILABLE_YET}</p>}
          {state.status !== 'error' && (
            <form className="admin-form" onSubmit={submit} noValidate>
              <div className="form-group">
                <label htmlFor={ids.input}>Server address</label>
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
                <p id={ids.hint} className="form-hint">Full address with http:// or https:// and the port.</p>
                {fieldError && <p id={ids.error} className="error-text" role="alert">{fieldError}</p>}
              </div>
              <button type="submit" className="btn btn-primary" aria-disabled={adding || undefined}>
                {adding ? 'Adding…' : 'Add server'}
              </button>
            </form>
          )}
          <SectionStatus message={announce || (state.status === 'ready' ? countLabel(state.items.length, 'server') : '')} />
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title="Remove this server?"
        confirmLabel="Remove server"
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void remove(confirm); }}
      >
        <p className="path-value">{confirm?.url}</p>
        <p className="muted">Your Dune server stops copying saves to it. Nothing on that server is deleted.</p>
      </ConfirmDialog>
    </section>
  );
}

/* ── API keys ────────────────────────────────────────────────────────────── */

const PROVIDERS = [
  { id: 'steamgriddb', name: 'SteamGridDB', purpose: 'Game artwork' },
  { id: 'tracker', name: 'Achievement tracker', purpose: 'Achievements from tracker sites' },
];

function ApiKeysSection({ enabled, serverKeySet, serverUrlFieldId, serverKeyFieldId }: {
  enabled: boolean; serverKeySet: boolean; serverUrlFieldId: string; serverKeyFieldId: string;
}) {
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
    const check = validateKeyName(name);
    if (!check.ok) { setFieldError(check.error); return; }
    setFieldError(null);
    setIssuing(true);
    const res = await call(() => window.electronAPI.addApiKey(check.value || undefined));
    setIssuing(false);
    const key = !(res instanceof Error) && isServerOk(res) ? (res as { key?: string }).key : undefined;
    if (!key) { setFieldError(describeFailure('issue-key', failureInfo(res))); return; }
    setName('');
    setIssued(key);
    setAnnounce('Key issued. Copy it now; it will not be shown again.');
    void reload();
  };

  const copyIssued = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setAnnounce('Key copied.');
    } catch {
      issuedRef.current?.select();
      setAnnounce('Could not copy. The key is selected; press Ctrl+C.');
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
      setRowError({ id: key.id, message: describeFailure('revoke-key', failureInfo(res)) });
      return;
    }
    setItems(items => items.filter(k => k.id !== key.id));
    setAnnounce('Key revoked.');
    headingRef.current?.focus();
  };

  const keyLabel = (key: ApiKeyInfo) => key.description.trim() || 'Unnamed key';
  const describedBy = [ids.hint, fieldError ? ids.error : null].filter(Boolean).join(' ');

  return (
    <section className="card admin-card" aria-labelledby={ids.heading}>
      <h4 id={ids.heading} ref={headingRef} tabIndex={-1} className="card-title">API keys</h4>

      <h5 id={ids.pcHeading} className="admin-subtitle">On this PC</h5>
      <ul className="admin-list" aria-labelledby={ids.pcHeading}>
        <li className="admin-row">
          <div className="admin-row-main">
            <span className="admin-row-value">Dune server key</span>
            <span className="admin-row-meta">
              <span className={serverKeySet ? 'key-status key-status-set' : 'key-status'}>{serverKeySet ? 'Set' : 'Not set'}</span>
              {' '}· used by this PC to talk to your Dune server
            </span>
          </div>
          <a href={`#${serverKeyFieldId}`} className="btn btn-secondary btn-sm" onClick={e => { e.preventDefault(); focusById(serverKeyFieldId); }}>
            {serverKeySet ? 'Change' : 'Set key'}
          </a>
        </li>
      </ul>

      <h5 id={ids.providersHeading} className="admin-subtitle">Game data providers</h5>
      <ul className="admin-list" aria-labelledby={ids.providersHeading}>
        {PROVIDERS.map(provider => (
          <li key={provider.id} className="admin-row admin-row-disabled">
            <div className="admin-row-main">
              <span className="admin-row-value">{provider.name}</span>
              <span className="admin-row-meta" id={`provider-${provider.id}-reason`}>{provider.purpose} · {PROVIDER_PENDING}</span>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled aria-label={`Set key for ${provider.name}`} aria-describedby={`provider-${provider.id}-reason`}>
              Set key
            </button>
          </li>
        ))}
      </ul>

      <h5 id={ids.serverHeading} className="admin-subtitle">On your Dune server</h5>
      {!enabled ? <NoServer fieldId={serverUrlFieldId} /> : (
        <>
          <p className="card-desc">Keys your Dune server accepts for your account. Give each device its own key.</p>
          <ListStatus state={state} noun="keys" onRetry={reload} empty="No keys listed yet." />
          {state.items.length > 0 && (
            <ul className="admin-list" aria-labelledby={ids.serverHeading}>
              {state.items.map(key => (
                <li key={key.id} className="admin-row">
                  <div className="admin-row-main">
                    <span className="admin-row-value" title={keyLabel(key)}>{keyLabel(key)}</span>
                    <span className="admin-row-meta">Created {formatCreated(key.createdAt)} · {key.masked}</span>
                    {rowError?.id === key.id && <p className="error-text" role="alert">{rowError.message}</p>}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    aria-label={`Revoke key ${keyLabel(key)}`}
                    aria-disabled={revoking === key.id || undefined}
                    aria-busy={revoking === key.id || undefined}
                    onClick={() => { if (revoking !== key.id) setConfirm(key); }}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}

          {issued && (
            <div className="issued-key">
              <label id={ids.issued} htmlFor={`${ids.issued}-value`}>New key</label>
              <p id={ids.issuedHint} className="form-hint">Copy this key now. It will not be shown again.</p>
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
                <button type="button" className="btn btn-primary btn-sm" onClick={copyIssued}>Copy</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={dismissIssued}>Done</button>
              </div>
            </div>
          )}

          {state.status !== 'error' && (
            <form className="admin-form" onSubmit={submit} noValidate>
              <div className="form-group">
                <label htmlFor={ids.input}>Name for a new key (optional)</label>
                <input
                  ref={nameRef}
                  id={ids.input}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className={fieldError ? 'input-error' : ''}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={describedBy}
                  placeholder="e.g. Steam Deck"
                  value={name}
                  onChange={e => { setName(e.target.value); if (fieldError) setFieldError(null); }}
                />
                <p id={ids.hint} className="form-hint">The server creates the key and shows it once.</p>
                {fieldError && <p id={ids.error} className="error-text" role="alert">{fieldError}</p>}
              </div>
              <button type="submit" className="btn btn-primary" aria-disabled={issuing || undefined}>
                {issuing ? 'Issuing…' : 'Issue key'}
              </button>
            </form>
          )}
          <SectionStatus message={announce || (state.status === 'ready' ? countLabel(state.items.length, 'key') : '')} />
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title="Revoke this key?"
        confirmLabel="Revoke key"
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void revoke(confirm); }}
      >
        <p>{confirm ? keyLabel(confirm) : ''}</p>
        <p className="muted">Any device using this key loses access to your Dune server, including this PC if it uses it.</p>
      </ConfirmDialog>
    </section>
  );
}

/** DUN-032: settings for what the Dune server scans, copies to, and which keys it accepts. */
export function WhereItRuns({ serverUrl, serverKeySet, connectionVersion, serverUrlFieldId, serverKeyFieldId }: Props) {
  const enabled = serverUrl.trim() !== '';
  // Remount on connection change: lists reload and drafts/one-time keys are dropped.
  const key = enabled ? `${serverUrl}#${connectionVersion}` : 'no-server';
  return (
    <section className="where-it-runs" aria-labelledby="where-it-runs-heading">
      <h3 id="where-it-runs-heading" className="section-subtitle where-heading">Where it runs</h3>
      <SourcesSection key={`sources-${key}`} enabled={enabled} serverUrlFieldId={serverUrlFieldId} />
      <ServersSection key={`servers-${key}`} enabled={enabled} serverUrlFieldId={serverUrlFieldId} />
      <ApiKeysSection key={`keys-${key}`} enabled={enabled} serverKeySet={serverKeySet} serverUrlFieldId={serverUrlFieldId} serverKeyFieldId={serverKeyFieldId} />
    </section>
  );
}
