/**
 * DUN-132: HowLongToBeat's search is token-gated and its endpoint moves
 * (/api/search -> /api/find -> /api/search/site ...). We do what the site's
 * own frontend does: read the init + search paths from its bundle.
 */
export interface HltbSearchApi { initPath: string; searchPath: string }

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
  for (const m of html.matchAll(/<script[^>]+src="(\/_next\/static\/chunks\/[A-Za-z0-9_\-./]+\.js)"/g)) add(m[1]!);
  for (const list of html.matchAll(/"otherChunks"\s*:\s*\[([^\]]*)\]/g)) {
    for (const m of list[1]!.matchAll(/"(static\/chunks\/[A-Za-z0-9_\-./]+\.js)"/g)) add(`/_next/${m[1]!}`);
  }
  return out;
}

/** Init + search paths from a bundle chunk, or null when this chunk has no search client. */
export function extractSearchApi(js: string): HltbSearchApi | null {
  const init = INIT_RE.exec(js)?.[1];
  if (!init) return null;
  const sibling = init.replace(/\/init$/, '');
  const quoted = ['"', "'", '`'].some((q) => js.includes(`${q}${sibling}${q}`));
  const searchPath = quoted ? sibling : TOKEN_POST_RE.exec(js)?.[1];
  return searchPath ? { initPath: init, searchPath } : null;
}
