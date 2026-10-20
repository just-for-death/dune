interface Props {
  /** What needs the server, e.g. "see playtime". */
  what: string;
  onOpenSettings: () => void;
}

/** DUN-041: calm, non-error notice for views that need a Dune server. */
export function NoServerNotice({ what, onOpenSettings }: Props) {
  return (
    <div className="card no-server-card">
      <p className="no-server-text">
        Connect a Dune server to {what}. Everything else keeps working on this PC.
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenSettings}>Set up a server</button>
    </div>
  );
}
