import { describe, expect, it } from 'vitest';
import {
  NEEDS_ADMIN,
  NO_SERVER,
  classifyServerError,
  countLabel,
  describeFailure,
  failureInfo,
  formatCreated,
  isServerOk,
  keyStatus,
  validateKeyName,
  validateRemoteServerUrl,
  validateSourcePath,
} from './serverAdmin';

const http = (status: number, code = 'SERVER_ERROR', message = 'Server error') => ({ status, code, message });

describe('classifyServerError', () => {
  it('classifies from the structured status and code', () => {
    expect(classifyServerError(http(403, 'FORBIDDEN', 'Admin privileges required'))).toBe('forbidden');
    expect(classifyServerError(http(401))).toBe('unauthorized');
    expect(classifyServerError(http(400))).toBe('bad-request');
    expect(classifyServerError(http(404))).toBe('not-found');
    expect(classifyServerError({ code: 'NETWORK', message: 'Could not reach the Dune Server: connect ECONNREFUSED' })).toBe('unreachable');
    expect(classifyServerError({ code: 'NO_SERVER', message: 'No Dune Server configured' })).toBe('no-server');
    expect(classifyServerError(http(500))).toBe('other');
    expect(classifyServerError(undefined)).toBe('other');
  });
  it('does not parse status out of message text', () => {
    expect(classifyServerError({ message: 'Request failed with status code 403' })).toBe('other');
    expect(classifyServerError({ code: 'SERVER_ERROR', message: 'Admin privileges required' })).toBe('other');
  });
});

describe('describeFailure', () => {
  it('says "Needs an admin key" for 403 on admin-only actions', () => {
    for (const action of ['add-source', 'remove-source', 'add-server', 'remove-server'] as const) {
      expect(describeFailure(action, http(403))).toBe(NEEDS_ADMIN);
    }
  });
  it('treats 403 on self-service actions as a rejected key', () => {
    expect(describeFailure('issue-key', http(403))).toMatch(/rejected this PC's key/);
    expect(describeFailure('load', http(403))).toMatch(/rejected this PC's key/);
  });
  it('never echoes the raw message or code', () => {
    const secret = { status: 500, code: 'SECRET_CODE', message: 'boom key=abc123' };
    for (const action of ['load', 'add-source', 'issue-key', 'revoke-key'] as const) {
      expect(describeFailure(action, secret)).not.toContain('abc123');
      expect(describeFailure(action, secret)).not.toContain('SECRET_CODE');
    }
  });
  it('explains a bad source path', () => {
    expect(describeFailure('add-source', http(400))).toMatch(/exists on the server/);
  });
  it('explains unreachable and missing servers', () => {
    expect(describeFailure('load', { code: 'NETWORK', message: 'x' })).toBe('Could not reach the Dune server.');
    expect(describeFailure('load', { code: 'NO_SERVER', message: 'x' })).toBe(`${NO_SERVER}.`);
  });
});

describe('isServerOk / failureInfo', () => {
  it('branches on ok', () => {
    expect(isServerOk({ ok: true, sources: [] })).toBe(true);
    expect(isServerOk({ ok: false, code: 'NETWORK', message: 'x' })).toBe(false);
    expect(isServerOk({ success: true })).toBe(false);
    expect(isServerOk(new Error('boom'))).toBe(false);
    expect(isServerOk(null)).toBe(false);
  });
  it('reads errors and failed replies', () => {
    expect(failureInfo(new Error('boom'))).toEqual({ message: 'boom' });
    expect(failureInfo({ ok: false, status: 403, code: 'FORBIDDEN', message: 'x' })).toEqual({ status: 403, code: 'FORBIDDEN', message: 'x' });
    expect(failureInfo({ ok: false, code: 'NETWORK', message: 'x' })).toEqual({ code: 'NETWORK', message: 'x' });
    expect(failureInfo({ ok: true })).toBeUndefined();
    expect(failureInfo(null)).toBeUndefined();
  });
});

describe('validateSourcePath', () => {
  it('needs a full path', () => {
    expect(validateSourcePath('')).toMatchObject({ ok: false });
    expect(validateSourcePath('games/saves')).toMatchObject({ ok: false });
    expect(validateSourcePath('/srv/games/')).toEqual({ ok: true, value: '/srv/games' });
    expect(validateSourcePath('D:\\Games\\Saves')).toEqual({ ok: true, value: 'D:\\Games\\Saves' });
    expect(validateSourcePath('\\\\nas\\saves')).toMatchObject({ ok: true });
    expect(validateSourcePath('/')).toEqual({ ok: true, value: '/' });
  });
  it('allows any characters a folder name can have', () => {
    expect(validateSourcePath('/srv/The Witcher 3: Wild Hunt™')).toMatchObject({ ok: true });
  });
  it('rejects NUL and duplicates', () => {
    expect(validateSourcePath('/srv/a\0b')).toMatchObject({ ok: false });
    expect(validateSourcePath('/srv/games/', ['/srv/games'])).toEqual({ ok: false, error: 'This source is already listed.' });
  });
});

describe('validateRemoteServerUrl', () => {
  it('uses the same rules as the server address', () => {
    expect(validateRemoteServerUrl('')).toMatchObject({ ok: false });
    expect(validateRemoteServerUrl('192.168.1.100:3030')).toMatchObject({ ok: false });
    expect(validateRemoteServerUrl('http://user:pw@host')).toMatchObject({ ok: false });
    expect(validateRemoteServerUrl('http://host/?q=1')).toMatchObject({ ok: false });
    expect(validateRemoteServerUrl('http://192.168.1.20:3030/')).toEqual({ ok: true, value: 'http://192.168.1.20:3030' });
  });
  it('rejects a server that is already listed (after normalising)', () => {
    expect(validateRemoteServerUrl('http://192.168.1.20:3030/', ['http://192.168.1.20:3030'])).toEqual({ ok: false, error: 'This server is already listed.' });
  });
});

describe('validateKeyName', () => {
  it('is optional, trimmed and collapsed', () => {
    expect(validateKeyName('')).toEqual({ ok: true, value: '' });
    expect(validateKeyName('  Steam   Deck ')).toEqual({ ok: true, value: 'Steam Deck' });
    expect(validateKeyName('Deck: "living room"™')).toMatchObject({ ok: true });
  });
  it('rejects control characters and long names', () => {
    expect(validateKeyName('a\u0007b')).toMatchObject({ ok: false });
    expect(validateKeyName('x'.repeat(61))).toMatchObject({ ok: false });
  });
});

describe('keyStatus / formatting', () => {
  it('only reports presence', () => {
    expect(keyStatus('abc')).toBe('Set');
    expect(keyStatus('  ')).toBe('Not set');
    expect(keyStatus(undefined)).toBe('Not set');
  });
  it('formats dates and counts', () => {
    expect(formatCreated('not a date')).toBe('Unknown date');
    expect(formatCreated('2026-01-02T00:00:00.000Z')).toMatch(/2026/);
    expect(countLabel(1, 'key')).toBe('1 key');
    expect(countLabel(3, 'source')).toBe('3 sources');
  });
});
