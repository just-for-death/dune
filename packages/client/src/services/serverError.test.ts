import { describe, expect, it } from 'vitest';
import type { ServerFailure } from '@dune/shared';
import {
  FORBIDDEN_MESSAGE,
  GENERIC_SERVER_MESSAGE,
  NETWORK_MESSAGE,
  NO_SERVER_MESSAGE,
  UNAUTHORIZED_MESSAGE,
  cloudSyncFailureMessage,
  serverFailureMessage,
} from './serverError';

const fail = (f: Omit<ServerFailure, 'ok'>): ServerFailure => ({ ok: false, ...f });

describe('serverFailureMessage', () => {
  it('says the server is unreachable when no response arrived', () => {
    expect(serverFailureMessage(fail({ code: 'NETWORK', message: 'Could not reach the Dune Server: connect ECONNREFUSED 127.0.0.1:3030' })))
      .toBe(NETWORK_MESSAGE);
  });

  it('asks for a server when none is set', () => {
    expect(serverFailureMessage(fail({ code: 'NO_SERVER', message: 'No Dune Server configured' }))).toBe(NO_SERVER_MESSAGE);
  });

  it('maps 401 and 403 to key wording', () => {
    expect(serverFailureMessage(fail({ status: 401, code: 'UNAUTHORIZED', message: 'Missing API key' }))).toBe(UNAUTHORIZED_MESSAGE);
    expect(serverFailureMessage(fail({ status: 403, code: 'FORBIDDEN', message: 'Admin privileges required' }))).toBe(FORBIDDEN_MESSAGE);
  });

  it("uses the server's message otherwise", () => {
    expect(serverFailureMessage(fail({ status: 404, code: 'GAME_NOT_FOUND', message: 'Game not found' }))).toBe('Game not found');
  });

  it('falls back to a generic sentence for an empty message', () => {
    expect(serverFailureMessage(fail({ status: 500, code: 'SERVER_ERROR', message: '' }))).toBe(GENERIC_SERVER_MESSAGE);
    expect(serverFailureMessage(fail({ status: 500, code: 'SERVER_ERROR', message: '   ' }))).toBe(GENERIC_SERVER_MESSAGE);
  });

  it('never shows the raw code', () => {
    const cases: ServerFailure[] = [
      fail({ code: 'NETWORK', message: 'x' }),
      fail({ code: 'NO_SERVER', message: 'x' }),
      fail({ status: 401, code: 'BAD_KEY', message: 'x' }),
      fail({ status: 403, code: 'ADMIN_ONLY', message: 'x' }),
      fail({ status: 500, code: 'SERVER_ERROR', message: '' }),
    ];
    for (const f of cases) expect(serverFailureMessage(f)).not.toContain(f.code);
  });
});

describe('cloudSyncFailureMessage', () => {
  it('summarises per-item failures as a count', () => {
    const item = { game: 'Celeste', code: 'SERVER_ERROR', message: 'disk full' };
    expect(cloudSyncFailureMessage({ ...fail({ status: 500, code: 'SERVER_ERROR', message: 'disk full' }), failures: [item, item] }, 'Sync'))
      .toBe('Sync finished with 2 problems');
    expect(cloudSyncFailureMessage({ ...fail({ status: 500, code: 'SERVER_ERROR', message: 'disk full' }), failures: [item] }, 'Restore'))
      .toBe('Restore finished with 1 problem');
  });

  it('uses the plain failure wording without items', () => {
    expect(cloudSyncFailureMessage(fail({ code: 'NETWORK', message: 'x' }), 'Sync')).toBe(NETWORK_MESSAGE);
    expect(cloudSyncFailureMessage({ ...fail({ code: 'NO_SERVER', message: 'x' }), failures: [] }, 'Restore')).toBe(NO_SERVER_MESSAGE);
  });
});
