// DUN-089: saves.zip intake. The archive is inspected BEFORE extraction
// (entry types, names, count, declared size), extracted into a private temp
// dir outside the game root, re-verified on disk, then applied file by file
// through the same path rules as single uploads. Every file it overwrites is
// snapshotted first. Any failure throws an ApiError (-> 400/413) and leaves
// the game root exactly as it was; the archive itself is never kept.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateRelativeSavePath } from '@dune/shared/pathRules';
import { ApiError } from '../utils/apiError.js';
import { ownerSavesRoot, resolveGameFile } from '../utils/path.js';

const execFileAsync = promisify(execFile);

export class ArchiveError extends ApiError {
  constructor(status: 400 | 413, code: 'ARCHIVE_INVALID' | 'ARCHIVE_TOO_LARGE', message: string) {
    super(status, code, message);
    this.name = 'ArchiveError';
  }
}
const invalid = (msg: string) => new ArchiveError(400, 'ARCHIVE_INVALID', msg);
const tooLarge = (msg: string) => new ArchiveError(413, 'ARCHIVE_TOO_LARGE', msg);

export interface ZipEntry {
  name: string;
  size: number;
  type: 'file' | 'dir' | 'symlink' | 'other';
}

export interface ArchiveLimits {
  /** Max file entries in one archive. */
  maxEntries: number;
  /** Max total uncompressed bytes (declared and actual). */
  maxBytes: number;
}

export function archiveLimits(maxFilesPerGame: number): ArchiveLimits {
  const mb = Math.max(1, parseInt(process.env.MAX_ARCHIVE_UNCOMPRESSED_MB || '1024', 10) || 1024);
  const entries = Math.max(1, parseInt(process.env.MAX_ARCHIVE_ENTRIES || String(maxFilesPerGame), 10) || maxFilesPerGame);
  return { maxEntries: Math.min(entries, maxFilesPerGame), maxBytes: mb * 1024 * 1024 };
}

// zipinfo short format: mode ver os size flags method date time name
const LINE = /^([-dlbcps?][-rwxsStTlL]{9})\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+ (.*)$/;
const HEADER = /number of entries: (\d+)\s*$/m;

/** List entries from the central directory (`unzip -Z`). Throws ArchiveError if unreadable. */
export async function listZip(archive: string): Promise<ZipEntry[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('unzip', ['-Z', archive], { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }));
  } catch {
    throw invalid('saves.zip is not a readable zip archive');
  }
  const declared = HEADER.exec(stdout);
  const entries: ZipEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const mode = m[1];
    const type = mode.startsWith('l') ? 'symlink' : mode.startsWith('d') ? 'dir' : mode.startsWith('-') ? 'file' : 'other';
    entries.push({ name: m[3], size: Number(m[2]), type });
  }
  // Names with newlines or an unparsable listing would desync the count.
  if (!declared || Number(declared[1]) !== entries.length) throw invalid(`saves.zip listing could not be verified (declared ${declared?.[1] ?? '?'}, parsed ${entries.length})`);
  return entries;
}

/** Validate the listing; returns the canonical relative paths of file entries. */
export function checkEntries(entries: ZipEntry[], limits: ArchiveLimits): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const e of entries) {
    if (e.type === 'symlink') throw invalid(`saves.zip contains a symbolic link: ${e.name}`);
    if (e.type === 'other') throw invalid(`saves.zip contains a special file: ${e.name}`);
    const raw = e.type === 'dir' ? e.name.replace(/\/+$/, '') : e.name;
    const r = validateRelativeSavePath(raw);
    if (!r.ok) throw invalid(`saves.zip entry rejected (${r.code}): ${r.message}`);
    const top = r.value.split('/')[0];
    if (top === '.versions') throw invalid('saves.zip may not write version history (.versions/)');
    if (e.type === 'dir') continue;
    if (r.value === 'saves.zip') throw invalid('saves.zip may not contain saves.zip');
    const key = r.value.toLowerCase();
    if (seen.has(key)) throw invalid(`saves.zip has a duplicate entry: ${r.value}`);
    seen.add(key);
    total += e.size;
    files.push(r.value);
  }
  if (files.length > limits.maxEntries) throw tooLarge(`saves.zip has ${files.length} files (limit ${limits.maxEntries})`);
  if (total > limits.maxBytes) throw tooLarge(`saves.zip expands to ${total} bytes (limit ${limits.maxBytes})`);
  return files;
}

/** Real files under `dir` (relative, '/'-separated); throws on symlinks/specials. */
function extractedFiles(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) throw invalid('saves.zip produced a symbolic link');
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.set(path.relative(dir, full).split(path.sep).join('/'), fs.statSync(full).size);
      else throw invalid('saves.zip produced a special file');
    }
  }
  return out;
}

export interface ApplyArchiveInput {
  archive: string;
  gameId: number;
  ownerId: string;
  /** `.versions/<versionId>` receives pre-overwrite copies. */
  versionId: string;
  limits: ArchiveLimits;
  /** Files already in the game (excluding .versions) for the per-game cap. */
  existingFileCount: number;
  maxFilesPerGame: number;
}

export interface ApplyArchiveResult {
  written: number;
  snapshotted: number;
}

export async function applySavesArchive(input: ApplyArchiveInput): Promise<ApplyArchiveResult> {
  const files = checkEntries(await listZip(input.archive), input.limits);
  const tmp = fs.mkdtempSync(path.join(ownerSavesRoot(input.ownerId), '.extract-'));
  try {
    try {
      // No -: so unzip itself also refuses ../ and absolute names.
      await execFileAsync('unzip', ['-qq', '-o', input.archive, '-d', tmp], { maxBuffer: 1024 * 1024 });
    } catch {
      throw invalid('saves.zip could not be extracted');
    }
    // Defense in depth: what landed must be exactly what was listed and
    // within the byte limit (central-directory sizes can lie).
    const onDisk = extractedFiles(tmp);
    let actual = 0;
    for (const size of onDisk.values()) actual += size;
    if (actual > input.limits.maxBytes) throw tooLarge('saves.zip expanded beyond the size limit');
    if (onDisk.size !== files.length || files.some((f) => !onDisk.has(f))) {
      throw invalid('saves.zip contents do not match its listing');
    }

    // Resolve every target first (symlink-safe, strictly inside the game root)
    // so a bad target aborts before anything is written.
    const targets = files.map((rel) => resolveGameFile(input.gameId, rel, input.ownerId));
    const newFiles = targets.filter((t) => !fs.existsSync(t.abs)).length;
    if (input.existingFileCount + newFiles > input.maxFilesPerGame) {
      throw tooLarge(`Game would exceed ${input.maxFilesPerGame} files`);
    }

    let snapshotted = 0;
    for (const t of targets) {
      if (fs.existsSync(t.abs)) {
        // First copy within one sync session wins (the pre-sync state).
        const snap = resolveGameFile(input.gameId, `.versions/${input.versionId}/${t.rel}`, input.ownerId).abs;
        if (!fs.existsSync(snap)) {
          fs.mkdirSync(path.dirname(snap), { recursive: true });
          fs.copyFileSync(t.abs, snap);
        }
        snapshotted += 1;
      }
    }
    // DUN-101: publish straight from this upload's private extraction dir
    // (same filesystem: saves/<owner>/.extract-*), so no shared temp name.
    for (const t of targets) {
      fs.mkdirSync(path.dirname(t.abs), { recursive: true });
      fs.renameSync(path.join(tmp, ...t.rel.split('/')), t.abs);
    }
    return { written: targets.length, snapshotted };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
