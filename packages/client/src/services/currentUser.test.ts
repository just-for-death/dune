import { describe, expect, it, vi } from 'vitest';
import { adminStateFrom, fetchAdminState, isLockedForRole } from './currentUser';

describe('adminStateFrom', () => {
  it('reads the role from an ok ServerResult', () => {
    expect(adminStateFrom({ ok: true, id: 'u1', name: 'Admin', role: 'admin' })).toBe('admin');
    expect(adminStateFrom({ ok: true, id: 'u2', name: 'Pat', role: 'member' })).toBe('member');
  });

  it('is unknown for failures, no server, odd shapes and thrown errors', () => {
    expect(adminStateFrom({ ok: false, code: 'NO_SERVER', message: 'x' })).toBe('unknown');
    expect(adminStateFrom({ ok: false, status: 403, code: 'FORBIDDEN', message: 'x' })).toBe('unknown');
    expect(adminStateFrom({ ok: true, role: 'owner' })).toBe('unknown');
    expect(adminStateFrom({ ok: true })).toBe('unknown');
    expect(adminStateFrom({ role: 'admin' })).toBe('unknown');
    expect(adminStateFrom(new Error('boom'))).toBe('unknown');
    expect(adminStateFrom(undefined)).toBe('unknown');
    expect(adminStateFrom(null)).toBe('unknown');
  });
});

describe('fetchAdminState', () => {
  it('calls getCurrentUser once and maps the result', async () => {
    const getCurrentUser = vi.fn().mockResolvedValue({ ok: true, id: 'u2', name: 'Pat', role: 'member' });
    await expect(fetchAdminState({ getCurrentUser })).resolves.toBe('member');
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('never rejects: a rejected IPC call is unknown', async () => {
    const getCurrentUser = vi.fn().mockRejectedValue(new Error('ipc down'));
    await expect(fetchAdminState({ getCurrentUser })).resolves.toBe('unknown');
  });

  it('is unknown when the bridge or method is missing', async () => {
    await expect(fetchAdminState(undefined)).resolves.toBe('unknown');
    await expect(fetchAdminState({} as never)).resolves.toBe('unknown');
  });
});

describe('isLockedForRole', () => {
  it('locks only a known member; unknown falls back to the 403 path', () => {
    expect(isLockedForRole('member')).toBe(true);
    expect(isLockedForRole('admin')).toBe(false);
    expect(isLockedForRole('unknown')).toBe(false);
  });
});
