import { describe, expect, it } from 'vitest';
import type { BackupProfile } from '@dune/shared';
import { PROFILE_SAVED, PROFILE_SAVE_FAILED, saveBackupProfile } from './backupProfileSave';
import { FORBIDDEN_MESSAGE, NETWORK_MESSAGE } from './serverError';

const profile: BackupProfile = { gameId: 1, includeGlobs: ['**/*'], excludeGlobs: [], autoExcludeCache: true, updatedAt: '2026-10-20T00:00:00.000Z' };

describe('saveBackupProfile', () => {
  it('returns the saved profile and message', async () => {
    await expect(saveBackupProfile(async () => ({ ok: true, profile, message: 'Saved' }))).resolves.toEqual({ ok: true, profile, message: 'Saved' });
    await expect(saveBackupProfile(async () => ({ ok: true }))).resolves.toEqual({ ok: true, message: PROFILE_SAVED });
  });

  it('turns a ServerFailure into plain wording', async () => {
    await expect(saveBackupProfile(async () => ({ ok: false, code: 'NETWORK', message: 'connect ECONNREFUSED' })))
      .resolves.toEqual({ ok: false, message: NETWORK_MESSAGE });
    await expect(saveBackupProfile(async () => ({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Admin privileges required' })))
      .resolves.toEqual({ ok: false, message: FORBIDDEN_MESSAGE });
    await expect(saveBackupProfile(async () => ({ ok: false, status: 500, code: 'INTERNAL', message: 'Disk full' })))
      .resolves.toEqual({ ok: false, message: 'Disk full' });
  });

  it('never rejects when the IPC call throws', async () => {
    await expect(saveBackupProfile(async () => { throw new Error('ipc gone'); })).resolves.toEqual({ ok: false, message: PROFILE_SAVE_FAILED });
    await expect(saveBackupProfile(() => { throw new Error('sync throw'); })).resolves.toEqual({ ok: false, message: PROFILE_SAVE_FAILED });
  });
});
