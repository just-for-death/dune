import { isFresh } from '../core/cache.js';
import { codeForStatus, failure, success, type ProviderResult } from '../core/errors.js';
import { gated } from '../core/gating.js';
import { createGuardedClient } from '../core/guard.js';
import { noopLogger, type EnabledSource, type HttpTransport, type ProviderCache, type ProviderLogger } from '../core/types.js';
import { compareSemver, parseSemver, type SemVer } from './semver.js';

export const GITHUB_API_BASE = 'https://api.github.com';
/** Only the GitHub REST API is reachable; release assets are never fetched. */
export const UPDATE_HOSTS = ['api.github.com'] as const;
/** Jane's Dune repo, from the root package.json `repository` field (and the origin remote). */
export const DUNE_GITHUB_REPO: GitHubRepo = { owner: 'just-for-death', repo: 'dune' };
export const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASES_PER_PAGE = 30;
const MAX_NOTES_CHARS = 20_000;
const API_MAX_BYTES = 2 * 1024 * 1024;

export interface GitHubRepo { owner: string; repo: string }

/** What the caller shows. `notes` is plain text (Markdown source): render it as text, never as HTML. */
export interface UpdateInfo {
  /** Normalised version of the newest release (no leading "v"). */
  latest: string;
  /** https://github.com/<owner>/<repo>/releases/... page for the user to open; nothing is downloaded. */
  url: string;
  notes: string;
  isNewer: boolean;
  publishedAt?: string;
}

/** Cached form: independent of the running version, so an app update never reads a stale `isNewer`. */
export interface CachedRelease { latest: string; url: string; notes: string; publishedAt?: string }

export interface UpdateCheckProviderOptions {
  transport: HttpTransport;
  enabled: EnabledSource;
  /** The running app version (SemVer, e.g. app.getVersion()). */
  currentVersion: string;
  repo?: GitHubRepo;
  /** Consider prereleases. Default: only when the running version is itself a prerelease. */
  includePrereleases?: boolean;
  cache?: ProviderCache<CachedRelease>;
  ttlMs?: number;
  now?: () => number;
  logger?: ProviderLogger;
  timeoutMs?: number;
}

export interface UpdateCheckProvider {
  /** Newest release vs the running version. Never downloads or runs anything. */
  check(opts?: { force?: boolean }): Promise<ProviderResult<UpdateInfo>>;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

interface RawRelease { tag_name?: unknown; html_url?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown }

function releasePageUrl(repo: GitHubRepo, raw: unknown, tag: string): string {
  const prefix = `https://github.com/${repo.owner}/${repo.repo}/releases/`;
  if (typeof raw === 'string') {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && u.port === '' && u.href.startsWith(prefix)) return u.href;
    } catch {
      /* fall through */
    }
  }
  return `${prefix}tag/${encodeURIComponent(tag)}`;
}

function plainNotes(body: unknown): string {
  if (typeof body !== 'string') return '';
  // Strip control characters except tab/newline; cap the size.
  // eslint-disable-next-line no-control-regex
  const clean = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return clean.length > MAX_NOTES_CHARS ? `${clean.slice(0, MAX_NOTES_CHARS)}…` : clean;
}

/**
 * App update check against GitHub releases (Desktop wires it in Electron
 * main with `fetchTransport(net.fetch)` and its own opt-in flag). Reads the
 * public releases list (no token), picks the highest SemVer tag (drafts
 * skipped; prereleases per `includePrereleases`), and compares it with the
 * running version. Result is cached for `ttlMs` (default 6 h); on failure a
 * cached value is returned with `stale: true`.
 */
export function createUpdateCheckProvider(opts: UpdateCheckProviderOptions): UpdateCheckProvider {
  const repo = opts.repo ?? DUNE_GITHUB_REPO;
  if (!OWNER_RE.test(repo.owner) || !REPO_RE.test(repo.repo) || repo.repo === '.' || repo.repo === '..') throw new TypeError('invalid GitHub owner/repo');
  const current = parseSemver(opts.currentVersion);
  if (!current) throw new TypeError('currentVersion must be a SemVer string');
  const includePre = opts.includePrereleases ?? current.prerelease.length > 0;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? UPDATE_CACHE_TTL_MS;
  const logger = opts.logger ?? noopLogger;
  const cacheKey = `${repo.owner}/${repo.repo}#${includePre ? 'pre' : 'stable'}`;
  const client = createGuardedClient({ provider: 'appUpdate', hosts: UPDATE_HOSTS, transport: opts.transport, logger, maxBytes: API_MAX_BYTES, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });

  const toInfo = (c: CachedRelease): UpdateInfo => {
    const latest = parseSemver(c.latest);
    return { ...c, isNewer: latest !== null && compareSemver(latest, current) > 0 };
  };

  async function readCache(): Promise<{ value: CachedRelease; storedAt: number } | null> {
    try {
      return (await opts.cache?.get(cacheKey)) ?? null;
    } catch {
      return null;
    }
  }

  async function fetchLatest(): Promise<ProviderResult<CachedRelease>> {
    const res = await client.request(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/releases?per_page=${RELEASES_PER_PAGE}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Dune-Update-Check' },
      responseType: 'json',
    });
    if (res.status !== 200) {
      const limited = res.status === 429 || (res.status === 403 && res.headers['x-ratelimit-remaining'] === '0');
      return failure(limited ? 'PROVIDER_RATE_LIMITED' : res.status === 403 ? 'PROVIDER_UNAVAILABLE' : codeForStatus(res.status), `GitHub releases request failed (status ${res.status})`);
    }
    if (!Array.isArray(res.data)) return failure('PROVIDER_BAD_RESPONSE', 'GitHub releases: unexpected response');
    let best: { v: SemVer; r: RawRelease; tag: string } | null = null;
    for (const item of res.data as unknown[]) {
      const r = (item && typeof item === 'object' ? item : {}) as RawRelease;
      if (r.draft === true || (r.prerelease === true && !includePre) || typeof r.tag_name !== 'string') continue;
      const v = parseSemver(r.tag_name);
      if (!v || (v.prerelease.length > 0 && !includePre)) continue;
      if (!best || compareSemver(v, best.v) > 0) best = { v, r, tag: r.tag_name };
    }
    if (!best) return failure('PROVIDER_NOT_FOUND', 'No published release found');
    const latest = `${best.v.major}.${best.v.minor}.${best.v.patch}${best.v.prerelease.length ? `-${best.v.prerelease.join('.')}` : ''}`;
    return success({
      latest,
      url: releasePageUrl(repo, best.r.html_url, best.tag),
      notes: plainNotes(best.r.body),
      ...(typeof best.r.published_at === 'string' ? { publishedAt: best.r.published_at } : {}),
    });
  }

  return {
    check: (o = {}) => gated('appUpdate', opts.enabled, async () => {
      const cached = await readCache();
      if (cached && !o.force && isFresh(cached, ttlMs, now())) return success(toInfo(cached.value));
      let r: ProviderResult<CachedRelease>;
      try {
        r = await fetchLatest();
      } catch (err) {
        if (!cached) throw err;
        r = failure('PROVIDER_UNAVAILABLE', 'GitHub releases request failed');
      }
      if (r.ok) {
        try {
          await opts.cache?.set(cacheKey, r.value);
        } catch {
          logger.warn({ provider: 'appUpdate', op: 'cache-write' }, 'Update check cache write failed');
        }
        return success(toInfo(r.value));
      }
      if (cached) return success(toInfo(cached.value), true);
      return r;
    }),
  };
}
