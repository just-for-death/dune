/**
 * Saving the Smart exclusions profile (DUN-047). Never rejects: a thrown IPC
 * call and an `{ ok: false }` ServerResult both come back as a failure with
 * plain wording, so the caller can roll the editor back to the saved profile.
 */
import type { BackupProfile, ServerResult } from '@dune/shared';
import { serverFailureMessage } from './serverError';
import { defaultTranslator, type Translator } from '../i18n';

export const PROFILE_SAVE_FAILED = defaultTranslator('saves.profileSaveFailed');
export const PROFILE_SAVED = defaultTranslator('saves.profileSaved');

type SaveReply = ServerResult<{ profile?: BackupProfile; message?: string }>;

export type ProfileSaveOutcome =
  | { ok: true; profile?: BackupProfile; message: string }
  | { ok: false; message: string };

export async function saveBackupProfile(
  save: () => Promise<SaveReply>,
  t: Translator = defaultTranslator,
): Promise<ProfileSaveOutcome> {
  let res: SaveReply;
  try {
    res = await save();
  } catch {
    return { ok: false, message: t('saves.profileSaveFailed') };
  }
  if (!res || typeof res !== 'object' || res.ok !== true) {
    return { ok: false, message: res && typeof res === 'object' && res.ok === false ? serverFailureMessage(res, t) : t('saves.profileSaveFailed') };
  }
  return { ok: true, ...(res.profile ? { profile: res.profile } : {}), message: res.message || t('saves.profileSaved') };
}
