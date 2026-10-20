/**
 * Saving the Smart exclusions profile (DUN-047). Never rejects: a thrown IPC
 * call and an `{ ok: false }` ServerResult both come back as a failure with
 * plain wording, so the caller can roll the editor back to the saved profile.
 */
import type { BackupProfile, ServerResult } from '@dune/shared';
import { serverFailureMessage } from './serverError';

export const PROFILE_SAVE_FAILED = "Couldn't save the exclusions. Your previous choices are back.";
export const PROFILE_SAVED = 'Backup profile updated';

type SaveReply = ServerResult<{ profile?: BackupProfile; message?: string }>;

export type ProfileSaveOutcome =
  | { ok: true; profile?: BackupProfile; message: string }
  | { ok: false; message: string };

export async function saveBackupProfile(save: () => Promise<SaveReply>): Promise<ProfileSaveOutcome> {
  let res: SaveReply;
  try {
    res = await save();
  } catch {
    return { ok: false, message: PROFILE_SAVE_FAILED };
  }
  if (!res || typeof res !== 'object' || res.ok !== true) {
    return { ok: false, message: res && typeof res === 'object' && res.ok === false ? serverFailureMessage(res) : PROFILE_SAVE_FAILED };
  }
  return { ok: true, ...(res.profile ? { profile: res.profile } : {}), message: res.message || PROFILE_SAVED };
}
