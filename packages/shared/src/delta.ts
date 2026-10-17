// Pure delta computation shared by the desktop client (upload/restore
// planning) and unit-tested on the server. No I/O: callers pass plain
// manifests, so the tricky comparison lives in one tested place.

/** Cheap change signal: file size + modification time. */
export interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

/** Relative path -> fingerprint, for one game's save tree. */
export type FileManifest = Record<string, FileFingerprint>;

/** Relative path -> content hash (server-side, robust across machines). */
export type HashManifest = Record<string, string>;

export interface ManifestDelta {
  /** Present now, absent before. */
  added: string[];
  /** Present in both, content changed. */
  changed: string[];
  /** Present in both, content identical. */
  unchanged: string[];
  /** Present before, absent now. */
  deleted: string[];
}

function emptyDelta(): ManifestDelta {
  return { added: [], changed: [], unchanged: [], deleted: [] };
}

/**
 * Diff two size+mtime manifests. Used for upload planning: `previous` is what
 * this client last uploaded, `current` is the local tree right now.
 */
export function diffFingerprints(previous: FileManifest, current: FileManifest): ManifestDelta {
  const delta = emptyDelta();
  for (const path of Object.keys(current)) {
    const prev = previous[path];
    const next = current[path];
    if (!prev) delta.added.push(path);
    else if (prev.size !== next.size || prev.mtimeMs !== next.mtimeMs) delta.changed.push(path);
    else delta.unchanged.push(path);
  }
  for (const path of Object.keys(previous)) {
    if (!(path in current)) delta.deleted.push(path);
  }
  return delta;
}

/**
 * Diff two content-hash manifests. Used for restore planning: `previous` is the
 * server manifest this client last pulled, `current` is the server's manifest
 * now. Hash comparison is correct across machines (unlike mtime).
 */
export function diffHashes(previous: HashManifest, current: HashManifest): ManifestDelta {
  const delta = emptyDelta();
  for (const path of Object.keys(current)) {
    const prev = previous[path];
    const next = current[path];
    if (prev === undefined) delta.added.push(path);
    else if (prev !== next) delta.changed.push(path);
    else delta.unchanged.push(path);
  }
  for (const path of Object.keys(previous)) {
    if (!(path in current)) delta.deleted.push(path);
  }
  return delta;
}

/** Paths that must actually be transferred (new + modified). */
export function changedPaths(delta: ManifestDelta): string[] {
  return [...delta.added, ...delta.changed];
}
