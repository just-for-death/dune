import { describe, it, expect } from 'vitest';
import { ServerCallError, callServer, failureFromResponse, noServerFailure, toServerFailure } from './serverError';

// Fakes shaped like axios errors; no network.
function axiosError(status: number | undefined, data: unknown, message = `Request failed with status code ${status}`) {
  return Object.assign(new Error(message), {
    isAxiosError: true,
    request: {},
    ...(status !== undefined ? { response: { status, data } } : {}),
  });
}

describe('toServerFailure (Dune UI contract)', () => {
  it('403 with a body: status, code and error pass through unchanged', () => {
    const f = toServerFailure(axiosError(403, { error: 'Not allowed for this game', code: 'FORBIDDEN' }));
    expect(f).toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Not allowed for this game' });
    expect(f.message).not.toMatch(/Request failed/);
  });

  it('400 malformed header encoding (DUN-064 server half)', () => {
    const f = toServerFailure(axiosError(400, { error: 'Malformed percent-encoding in x-game header', code: 'INVALID_HEADER_ENCODING' }));
    expect(f).toEqual({ ok: false, status: 400, code: 'INVALID_HEADER_ENCODING', message: 'Malformed percent-encoding in x-game header' });
  });

  it('decodes an arraybuffer error body (downloads)', () => {
    const body = new TextEncoder().encode(JSON.stringify({ error: 'File not found', code: 'FILE_NOT_FOUND' }));
    expect(toServerFailure(axiosError(404, body.buffer))).toEqual({ ok: false, status: 404, code: 'FILE_NOT_FOUND', message: 'File not found' });
  });

  it('network failure: no status, code NETWORK', () => {
    const f = toServerFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { isAxiosError: true, code: 'ECONNREFUSED', request: {} }));
    expect(f.ok).toBe(false);
    expect(f.status).toBeUndefined();
    expect(f.code).toBe('NETWORK');
    expect(f.message).toMatch(/ECONNREFUSED/);
  });

  it('an error response without a code body gets SERVER_ERROR and keeps the status', () => {
    expect(toServerFailure(axiosError(502, '<html>bad gateway</html>'))).toEqual({ ok: false, status: 502, code: 'SERVER_ERROR', message: 'Server error (HTTP 502)' });
  });

  it('a local (non-HTTP) error is LOCAL_ERROR, never NETWORK', () => {
    expect(toServerFailure(new Error('EACCES: permission denied'))).toEqual({ ok: false, code: 'LOCAL_ERROR', message: 'EACCES: permission denied' });
  });

  it('ServerCallError keeps its failure; helpers', async () => {
    const failure = failureFromResponse(409, { error: 'Conflict', code: 'VERSION_CONFLICT' });
    expect(toServerFailure(new ServerCallError(failure))).toBe(failure);
    expect(noServerFailure()).toEqual({ ok: false, code: 'NO_SERVER', message: 'No Dune Server configured' });
    expect(await callServer(async () => ({ data: { success: true, versions: [1] } }))).toEqual({ ok: true, success: true, versions: [1] });
    expect(await callServer(async () => { throw axiosError(403, { error: 'nope', code: 'FORBIDDEN' }); })).toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'nope' });
  });

  it('another user\'s title: 404 GAME_NOT_FOUND passes through unchanged', () => {
    expect(toServerFailure(axiosError(404, { error: 'Game not found', code: 'GAME_NOT_FOUND' }))).toEqual({ ok: false, status: 404, code: 'GAME_NOT_FOUND', message: 'Game not found' });
  });

  it('only the REST { error, code } shape is parsed; anything else is UNKNOWN with the HTTP status (DUN-038)', () => {
    const f = toServerFailure(axiosError(400, { error: { message: 'x', data: { code: 'UNKNOWN_KEYS' } } }));
    expect(f.status).toBe(400);
    expect(f.code).not.toBe('UNKNOWN_KEYS');
    expect(f.message).toBe('Server error (HTTP 400)');
  });
});
