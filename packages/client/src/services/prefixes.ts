/**
 * Renderer helpers for the DUN-062 prefix IPC contract (names/ids only; main
 * builds and checks every path). Failure codes are mapped to plain sentences
 * so no raw code is ever shown.
 */
import type { PrefixOpFailureReason } from '@dune/shared';

export type PrefixOp = 'create' | 'backup' | 'delete';

/** Main's limit (electron/prefix/registry.ts MAX_PREFIX_NAME_LENGTH). */
export const MAX_PREFIX_NAME = 64;

export type NameCheck = { ok: true; value: string } | { ok: false; error: string };

/** Only empty / too long is caught here; main decides what else is allowed and answers 'invalid-name'. */
export function validateNewPrefixName(input: string): NameCheck {
  const value = input.trim();
  if (!value) return { ok: false, error: 'Enter a name for the prefix.' };
  if ([...value].length > MAX_PREFIX_NAME) return { ok: false, error: `Use at most ${MAX_PREFIX_NAME} characters.` };
  return { ok: true, value };
}

const REASONS: Record<PrefixOpFailureReason, string> = {
  'not-found': 'This prefix no longer exists. Rescan to refresh the list.',
  'not-managed': 'Dune did not create this prefix, so it cannot change it.',
  symlink: 'This prefix folder is a link to somewhere else, so Dune will not touch it.',
  'outside-root': "This prefix is outside Dune's prefix folder, so Dune will not touch it.",
  'invalid-name': 'Use letters, numbers, dots, dashes or underscores, starting with a letter or number.',
  exists: 'A prefix with this name already exists.',
  'in-use': 'This prefix is in use. Close the game and try again.',
  'trash-failed': 'Could not move the folder to the Trash. Nothing was deleted.',
  error: 'Something went wrong. Try again.',
};

const OP_EXISTS: Record<PrefixOp, string> = {
  create: REASONS.exists,
  backup: 'A backup with this name already exists. Try again in a moment.',
  delete: REASONS.exists,
};

export function prefixFailureMessage(op: PrefixOp, reason: string | undefined): string {
  if (reason === 'exists') return OP_EXISTS[op];
  if (reason && Object.prototype.hasOwnProperty.call(REASONS, reason)) return REASONS[reason as PrefixOpFailureReason];
  return REASONS.error;
}
