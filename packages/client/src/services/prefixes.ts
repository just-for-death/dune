/**
 * Renderer helpers for the DUN-062 prefix IPC contract (names/ids only; main
 * builds and checks every path). Failure codes are mapped to plain sentences
 * so no raw code is ever shown.
 */
import type { PrefixOpFailureReason } from '@dune/shared';

import { defaultTranslator, type MessageKey, type Translator } from '../i18n';

export type PrefixOp = 'create' | 'backup' | 'delete';

/** Main's limit (electron/prefix/registry.ts MAX_PREFIX_NAME_LENGTH). */
export const MAX_PREFIX_NAME = 64;

export type NameCheck = { ok: true; value: string } | { ok: false; error: string };

/** Only empty / too long is caught here; main decides what else is allowed and answers 'invalid-name'. */
export function validateNewPrefixName(input: string, t: Translator = defaultTranslator): NameCheck {
  const value = input.trim();
  if (!value) return { ok: false, error: t('prefixes.nameRequired') };
  if ([...value].length > MAX_PREFIX_NAME) return { ok: false, error: t('prefixes.nameTooLong', { max: MAX_PREFIX_NAME }) };
  return { ok: true, value };
}

const REASONS: Record<PrefixOpFailureReason, MessageKey> = {
  'not-found': 'prefixes.reason.notFound',
  'not-managed': 'prefixes.reason.notManaged',
  symlink: 'prefixes.reason.symlink',
  'outside-root': 'prefixes.reason.outsideRoot',
  'invalid-name': 'prefixes.reason.invalidName',
  exists: 'prefixes.reason.exists',
  'in-use': 'prefixes.reason.inUse',
  'trash-failed': 'prefixes.reason.trashFailed',
  error: 'prefixes.reason.error',
};

const OP_EXISTS: Record<PrefixOp, MessageKey> = {
  create: REASONS.exists,
  backup: 'prefixes.reason.backupExists',
  delete: REASONS.exists,
};

export function prefixFailureMessage(op: PrefixOp, reason: string | undefined, t: Translator = defaultTranslator): string {
  if (reason === 'exists') return t(OP_EXISTS[op]);
  if (reason && Object.prototype.hasOwnProperty.call(REASONS, reason)) return t(REASONS[reason as PrefixOpFailureReason]);
  return t(REASONS.error);
}
