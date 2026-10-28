import { CORE_SCHEMA, load } from 'js-yaml';
import { ProviderError } from '../core/errors.js';
import { ManifestGameSchema, type ManifestGame } from './schema.js';

export const MAX_GAME_NAME_CHARS = 512;
export const DEFAULT_MAX_GAMES = 200_000;
/** Real manifest depth is about 7 (game > files > path > when > [i] > os). */
const MAX_DEPTH = 16;
const MAX_NODES = 20_000_000;

export interface ParseLimits {
  /** UTF-8 byte cap on the YAML text; larger input fails with PROVIDER_TOO_LARGE before parsing. */
  maxBytes: number;
  maxGames?: number;
}

export interface ParsedManifest {
  games: Record<string, ManifestGame>;
  /** Entries dropped because they failed validation (the rest of the manifest is still used). */
  skipped: number;
}

const bad = (message: string) => new ProviderError('PROVIDER_BAD_RESPONSE', message);

/**
 * Reject anything a YAML document can use to blow up after parsing: shared
 * nodes (anchors/aliases, which would make validation walk the same subtree
 * over and over: "billion laughs"), `__proto__` keys, and excessive depth.
 * Iterative so a hostile document cannot overflow the stack.
 */
function assertPlainTree(root: unknown): void {
  const seen = new WeakSet<object>();
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (++nodes > MAX_NODES) throw bad('manifest has too many nodes');
    if (node === null || typeof node !== 'object') continue;
    if (depth > MAX_DEPTH) throw bad('manifest is nested too deeply');
    if (seen.has(node)) throw bad('YAML anchors/aliases are not allowed in the manifest');
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(node)) {
      if (key === '__proto__') throw bad('manifest contains a __proto__ key');
      stack.push({ node: (node as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
}

/**
 * YAML text -> validated games. js-yaml `load` with CORE_SCHEMA only: no
 * custom or `!!js/*` types, no timestamps/binary/merge keys, duplicate keys
 * are an error. Nothing in the document is ever evaluated or executed.
 * Throws ProviderError (PROVIDER_TOO_LARGE / PROVIDER_BAD_RESPONSE).
 */
export function parseManifestYaml(text: string, limits: ParseLimits): ParsedManifest {
  const maxGames = limits.maxGames ?? DEFAULT_MAX_GAMES;
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) throw new ProviderError('PROVIDER_TOO_LARGE', `manifest exceeds ${limits.maxBytes} bytes`);
  let doc: unknown;
  try {
    doc = load(text, { schema: CORE_SCHEMA, json: false });
  } catch {
    throw bad('manifest is not valid YAML');
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw bad('manifest must be a mapping of game titles');
  assertPlainTree(doc);
  const entries = Object.entries(doc as Record<string, unknown>);
  if (entries.length > maxGames) throw bad(`manifest has more than ${maxGames} games`);
  const games: Record<string, ManifestGame> = {};
  let skipped = 0;
  for (const [name, raw] of entries) {
    const parsed = name.length > 0 && name.length <= MAX_GAME_NAME_CHARS ? ManifestGameSchema.safeParse(raw ?? {}) : null;
    if (parsed?.success) games[name] = parsed.data;
    else skipped++;
  }
  if (Object.keys(games).length === 0) throw bad('manifest has no valid games');
  return { games, skipped };
}
