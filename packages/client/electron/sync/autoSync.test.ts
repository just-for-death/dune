import { describe, it, expect, vi } from 'vitest';
import type { CloudSyncResult } from '@dune/shared';
import { runAutoSync } from './autoSync';

const now = () => new Date('2026-10-20T08:00:00.000Z');

describe('runAutoSync (DUN-070)', () => {
  it('logs every failure item and sends the result to the renderer', async () => {
    const result: CloudSyncResult = {
      ok: false, code: 'LOCAL_READ_FAILED', message: 'EACCES',
      failures: [
        { game: 'A', code: 'LOCAL_READ_FAILED', message: 'EACCES' },
        { game: 'B', path: 'x.sav', status: 500, code: 'SERVER_ERROR', message: 'boom' },
      ],
    };
    const log = vi.fn();
    const send = vi.fn();
    expect(await runAutoSync({ sync: async () => result, hasServer: () => true, appendErrorLog: log, send, now })).toBe(result);
    expect(log.mock.calls).toEqual([
      ['auto-sync', { game: 'A', code: 'LOCAL_READ_FAILED', message: 'EACCES' }],
      ['auto-sync', { game: 'B', path: 'x.sav', status: 500, code: 'SERVER_ERROR', message: 'boom' }],
    ]);
    expect(send).toHaveBeenCalledWith({ at: '2026-10-20T08:00:00.000Z', result });
  });

  it('a success is sent but not logged; a thrown sync becomes a failure', async () => {
    const log = vi.fn();
    const send = vi.fn();
    await runAutoSync({ sync: async () => ({ ok: true, message: 'ok', uploaded: 1 }), hasServer: () => true, appendErrorLog: log, send, now });
    expect(log).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].result).toEqual({ ok: true, message: 'ok', uploaded: 1 });
    const res = await runAutoSync({ sync: async () => { throw new Error('EACCES: permission denied'); }, hasServer: () => true, appendErrorLog: log, send, now });
    expect(res).toEqual({ ok: false, code: 'LOCAL_ERROR', message: 'EACCES: permission denied' });
    expect(log).toHaveBeenCalledWith('auto-sync', { game: '', code: 'LOCAL_ERROR', message: 'EACCES: permission denied' });
  });

  it('skips with no server, and stays quiet when a sync is already running', async () => {
    const sync = vi.fn(async (): Promise<CloudSyncResult> => ({ ok: false, code: 'SYNC_IN_PROGRESS', message: 'busy' }));
    const log = vi.fn();
    const send = vi.fn();
    expect(await runAutoSync({ sync, hasServer: () => false, appendErrorLog: log, send })).toBeNull();
    expect(sync).not.toHaveBeenCalled();
    await runAutoSync({ sync, hasServer: () => true, appendErrorLog: log, send });
    expect(log).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('a closed window or a broken log never throws', async () => {
    const res = await runAutoSync({
      sync: async () => ({ ok: false, code: 'X', message: 'y' }),
      hasServer: () => true,
      appendErrorLog: () => { throw new Error('disk full'); },
      send: () => { throw new Error('destroyed'); },
    });
    expect(res).toMatchObject({ ok: false, code: 'X' });
  });
});
