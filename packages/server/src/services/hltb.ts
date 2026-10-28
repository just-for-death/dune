import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { dataDir } from '../utils/path.js';
import { logger, redactText } from '../middleware/logging.js';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function cacheDir(): string {
  return path.join(dataDir(), 'hltb-cache');
}

export interface HLTBTimes {
  mainStory: number;
  mainExtra: number;
  completionist: number;
  source?: string;
  fetchedAt?: string;
}

/** Typed failure (DUN-105): no match vs. the service could not be reached/read. */
export type HLTBFailureCode = 'HLTB_NOT_FOUND' | 'HLTB_UNAVAILABLE';

export interface HLTBResponse {
  success: boolean;
  times?: HLTBTimes;
  message?: string;
  stale?: boolean;
  code?: HLTBFailureCode;
}

function ensureCacheDir(): void {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Cache identity of a title: NFKC, trimmed, whitespace collapsed, lower-cased. */
export function normalizeTitle(gameName: string): string {
  return gameName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * DUN-105: sha256 of the normalized title, so every distinct title (including
 * non-ASCII ones like '大神' vs 'ペルソナ5') gets its own cache file.
 */
export function getCachePath(gameName: string): string {
  const key = createHash('sha256').update(normalizeTitle(gameName)).digest('hex');
  return path.join(cacheDir(), `${key}.json`);
}

function logHltbError(op: string, err: unknown): void {
  const e = err as { message?: unknown; code?: unknown; response?: { status?: unknown } };
  logger.warn({
    op,
    message: redactText(typeof e?.message === 'string' ? e.message : String(err)),
    code: typeof e?.code === 'string' ? e.code : undefined,
    status: typeof e?.response?.status === 'number' ? e.response.status : undefined,
  }, 'HowLongToBeat error');
}

/**
 * DUN-043: HowLongToBeat's comp_main / comp_plus / comp_100 are SECONDS
 * (Hollow Knight: comp_main 97100 = 26.97 h, shown as "27 Hours"; see
 * hltb.fixture.json). HLTBTimes is minutes.
 */
export function secondsToMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 60) : 0;
}

export function readCache(gameName: string, allowStale = false): HLTBTimes | null {
  try {
    ensureCacheDir();
    const cachePath = getCachePath(gameName);
    if (!fs.existsSync(cachePath)) return null;

    const stats = fs.statSync(cachePath);
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (Date.now() - stats.mtimeMs > CACHE_TTL_MS && !allowStale) return null;

    return data.times ?? null;
  } catch (err) {
    logHltbError('cache-read', err);
    return null;
  }
}

export function writeCache(gameName: string, times: HLTBTimes): void {
  try {
    ensureCacheDir();
    const cachePath = getCachePath(gameName);
    fs.writeFileSync(cachePath, JSON.stringify({ times, source: 'hltb', fetchedAt: new Date().toISOString(), cachedAt: Date.now() }), 'utf-8');
  } catch (err) {
    // A failed cache write never fails the lookup, but it is not silent.
    logHltbError('cache-write', err);
  }
}

type SearchResult = { ok: true; times: HLTBTimes } | { ok: false; code: HLTBFailureCode };

/**
 * DUN-132: HowLongToBeat's search is token-gated and its endpoint moves
 * (/api/search -> /api/find -> /api/search/site ...). The old fixed
 * POST /api/search now answers 403 IFW-U01. We do what the site's own
 * frontend does: read the init + search paths from its Next.js bundle, GET
 * `<init>?t=<ms>` for a token, then POST the search with `x-auth-token`.
 * Paths and token are cached in memory; a 403/404 refreshes them once.
 * Nothing here runs until a lookup is requested.
 */
export const HLTB_BASE_URL = 'https://howlongtobeat.com';
// The token is bound to the User-Agent that minted it: use one UA throughout.
const HLTB_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 10000;
const API_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_CHUNKS_SCANNED = 25;

export interface HLTBSearchApi { initPath: string; searchPath: string }
interface HLTBSession { token: string; hpKey?: string; hpVal?: string }

let apiCache: { api: HLTBSearchApi; at: number } | null = null;
let sessionCache: { session: HLTBSession; at: number } | null = null;

/** Test hook: forget the discovered endpoint and token. */
export function resetHLTBSession(): void {
  apiCache = null;
  sessionCache = null;
}

const API_PATH = String.raw`\/api\/[A-Za-z0-9_\-\/]+`;
const INIT_RE = new RegExp(String.raw`["'\x60](${API_PATH}\/init)(?:\?|["'\x60])`);
const TOKEN_POST_RE = new RegExp(String.raw`fetch\(\s*["'\x60](${API_PATH})["'\x60]\s*,\s*\{[^}]*?method\s*:\s*["']POST["'][^}]*?x-auth-token`);

/**
 * Same-origin JS chunks the homepage boots, in load order. The live site is a
 * Turbopack build: the search client (and its /init + search paths) ships in
 * an eagerly loaded chunk, named both by a <script src> tag and by the inline
 * `TURBOPACK.push({"otherChunks":["static/chunks/…"]})` bootstrap. Both lists
 * are read so a chunk listed only in the runtime chunk map is still scanned.
 */
export function extractChunkPaths(html: string): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (!out.includes(p)) out.push(p); };
  for (const m of html.matchAll(/<script[^>]+src="(\/_next\/static\/chunks\/[A-Za-z0-9_\-./]+\.js)"/g)) add(m[1]);
  for (const list of html.matchAll(/"otherChunks"\s*:\s*\[([^\]]*)\]/g)) {
    for (const m of list[1].matchAll(/"(static\/chunks\/[A-Za-z0-9_\-./]+\.js)"/g)) add(`/_next/${m[1]}`);
  }
  return out;
}

/** Init + search paths from a bundle chunk, or null when this chunk has no search client. */
export function extractSearchApi(js: string): HLTBSearchApi | null {
  const init = INIT_RE.exec(js)?.[1];
  if (!init) return null;
  const sibling = init.replace(/\/init$/, '');
  const quoted = ['"', "'", '`'].some((q) => js.includes(`${q}${sibling}${q}`));
  const searchPath = quoted ? sibling : TOKEN_POST_RE.exec(js)?.[1];
  return searchPath ? { initPath: init, searchPath } : null;
}

/** HTTP that never throws: status + body, or null when the request itself failed. */
async function http(method: 'get' | 'post', urlPath: string, op: string, opts: { body?: unknown; headers?: Record<string, string>; text?: boolean } = {}): Promise<{ status: number; data: unknown } | null> {
  try {
    const config = {
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
      ...(opts.text ? { responseType: 'text' as const } : {}),
      headers: { 'User-Agent': HLTB_USER_AGENT, Referer: `${HLTB_BASE_URL}/`, ...opts.headers },
    };
    const url = new URL(urlPath, HLTB_BASE_URL).toString();
    const res = method === 'get' ? await axios.get(url, config) : await axios.post(url, opts.body, config);
    return { status: res.status, data: res.data };
  } catch (err) {
    logHltbError(op, err);
    return null;
  }
}

async function discoverSearchApi(): Promise<HLTBSearchApi | null> {
  const home = await http('get', '/', 'discover-home', { text: true });
  if (!home || home.status !== 200 || typeof home.data !== 'string') {
    logHltbError('discover-home', new Error(`HowLongToBeat homepage unavailable (status ${home?.status ?? 'none'})`));
    return null;
  }
  for (const chunk of extractChunkPaths(home.data).slice(0, MAX_CHUNKS_SCANNED)) {
    const res = await http('get', chunk, 'discover-chunk', { text: true });
    if (!res || res.status !== 200 || typeof res.data !== 'string') continue;
    const api = extractSearchApi(res.data);
    if (api) {
      logger.info({ op: 'discover', initPath: api.initPath, searchPath: api.searchPath }, 'HowLongToBeat search endpoint discovered');
      return api;
    }
  }
  logHltbError('discover', new Error('HowLongToBeat search endpoint not found in site bundle'));
  return null;
}

type Step<T> = { ok: true; value: T } | { ok: false; retry: 'token' | 'api' | null };

async function getApi(): Promise<Step<HLTBSearchApi>> {
  if (apiCache && Date.now() - apiCache.at < API_TTL_MS) return { ok: true, value: apiCache.api };
  const api = await discoverSearchApi();
  if (!api) return { ok: false, retry: null };
  apiCache = { api, at: Date.now() };
  return { ok: true, value: api };
}

function retryFor(status: number): 'token' | 'api' | null {
  return status === 403 ? 'token' : status === 404 ? 'api' : null;
}

async function getSession(api: HLTBSearchApi): Promise<Step<HLTBSession>> {
  if (sessionCache && Date.now() - sessionCache.at < TOKEN_TTL_MS) return { ok: true, value: sessionCache.session };
  const res = await http('get', `${api.initPath}?t=${Date.now()}`, 'token');
  if (!res) return { ok: false, retry: null };
  const body = res.data as { token?: unknown; hpKey?: unknown; hpVal?: unknown } | null;
  if (res.status !== 200 || typeof body?.token !== 'string' || body.token.length === 0) {
    logHltbError('token', new Error(`HowLongToBeat token init failed (status ${res.status})`));
    // A 404 here means the init path itself rotated.
    return { ok: false, retry: retryFor(res.status) };
  }
  // Older builds also issued a honeypot pair; echo it only when issued.
  const session: HLTBSession = typeof body.hpKey === 'string' && typeof body.hpVal === 'string'
    ? { token: body.token, hpKey: body.hpKey, hpVal: body.hpVal }
    : { token: body.token };
  sessionCache = { session, at: Date.now() };
  return { ok: true, value: session };
}

function searchBody(gameName: string, session: HLTBSession): Record<string, unknown> {
  const body: Record<string, unknown> = {
    searchType: 'games',
    searchTerms: gameName.trim().split(/\s+/),
    searchPage: 1,
    size: 5,
    searchOptions: {
      games: { userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main', rangeTime: { min: null, max: null }, gameplay: { perspective: '', flow: '', genre: '' }, year: '', modifier: '' },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '',
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
  };
  if (session.hpKey && session.hpVal) body[session.hpKey] = session.hpVal;
  return body;
}

async function searchOnce(gameName: string): Promise<Step<unknown>> {
  const api = await getApi();
  if (!api.ok) return api;
  const session = await getSession(api.value);
  if (!session.ok) return session;
  const s = session.value;
  const res = await http('post', api.value.searchPath, 'search', {
    body: searchBody(gameName, s),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: HLTB_BASE_URL,
      'x-auth-token': s.token,
      ...(s.hpKey && s.hpVal ? { 'x-hp-key': s.hpKey, 'x-hp-val': s.hpVal } : {}),
    },
  });
  if (!res) return { ok: false, retry: null };
  if (res.status !== 200) {
    logHltbError('search', new Error(`HowLongToBeat search failed (status ${res.status})`));
    return { ok: false, retry: retryFor(res.status) };
  }
  return { ok: true, value: res.data };
}

async function searchHLTB(gameName: string): Promise<SearchResult> {
  let step = await searchOnce(gameName);
  if (!step.ok && step.retry) {
    // Refresh once: a 403 means the token expired, a 404 that the endpoint moved.
    sessionCache = null;
    if (step.retry === 'api') apiCache = null;
    step = await searchOnce(gameName);
  }
  if (!step.ok) return { ok: false, code: 'HLTB_UNAVAILABLE' };

  const list = (step.value as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(list)) {
    logHltbError('search', new Error('Unexpected HowLongToBeat response shape'));
    return { ok: false, code: 'HLTB_UNAVAILABLE' };
  }
  if (list.length === 0) return { ok: false, code: 'HLTB_NOT_FOUND' };

  const game = list[0] as Record<string, unknown>;
  return {
    ok: true,
    times: {
      mainStory: secondsToMinutes(game.comp_main),
      mainExtra: secondsToMinutes(game.comp_plus),
      completionist: secondsToMinutes(game.comp_100),
    },
  };
}

export async function getHLTBTimes(gameName: string): Promise<HLTBResponse> {
  const cached = readCache(gameName);
  if (cached) {
    return { success: true, times: cached };
  }

  const result = await searchHLTB(gameName);
  if (result.ok) {
    const stamped = { ...result.times, source: 'hltb', fetchedAt: new Date().toISOString() };
    writeCache(gameName, stamped);
    return { success: true, times: stamped };
  }

  const stale = readCache(gameName, true);
  if (stale) {
    return { success: true, times: stale, stale: true, message: 'Using cached HowLongToBeat data' };
  }

  return result.code === 'HLTB_NOT_FOUND'
    ? { success: false, code: result.code, message: 'Game not found on HowLongToBeat' }
    : { success: false, code: result.code, message: 'HowLongToBeat is unavailable' };
}

