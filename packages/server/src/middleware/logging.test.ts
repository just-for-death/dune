import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { createLogger, requestLogger, type LoggedRequest } from './logging.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

function fakeRes(statusCode: number): Response {
  const emitter = new EventEmitter() as unknown as Response;
  (emitter as unknown as { statusCode: number }).statusCode = statusCode;
  return emitter;
}

describe('createLogger', () => {
  it('emits JSON lines with service, level, and message', () => {
    const { lines, stream } = capture();
    const log = createLogger(stream);
    log.info({ reqId: 'abc' }, 'hello');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.service).toBe('dune-server');
    expect(parsed.level).toBe(30);
    expect(parsed.msg).toBe('hello');
    expect(parsed.reqId).toBe('abc');
  });
});

describe('requestLogger', () => {
  it('attaches a unique reqId and calls next', () => {
    const { stream } = capture();
    const req = { method: 'GET', path: '/x' } as LoggedRequest;
    let nexted = false;
    requestLogger(req, fakeRes(200), () => {
      nexted = true;
    }, createLogger(stream));
    expect(nexted).toBe(true);
    expect(typeof req.reqId).toBe('string');
    expect(req.reqId!.length).toBeGreaterThan(0);
  });

  it('logs method/path/status/latency with the reqId on finish', () => {
    const { lines, stream } = capture();
    const log = createLogger(stream);
    const req = { method: 'POST', path: '/trpc/games.list' } as LoggedRequest;
    const res = fakeRes(200);
    requestLogger(req, res, () => {}, log);
    (res as unknown as EventEmitter).emit('finish');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msg).toBe('request');
    expect(parsed.method).toBe('POST');
    expect(parsed.path).toBe('/trpc/games.list');
    expect(parsed.status).toBe(200);
    expect(parsed.reqId).toBe(req.reqId);
    expect(typeof parsed.latencyMs).toBe('number');
  });

  it('generates distinct IDs per request', () => {
    const { stream } = capture();
    const log = createLogger(stream);
    const a = { method: 'GET', path: '/a' } as LoggedRequest;
    const b = { method: 'GET', path: '/b' } as LoggedRequest;
    requestLogger(a, fakeRes(200), () => {}, log);
    requestLogger(b, fakeRes(200), () => {}, log);
    expect(a.reqId).not.toBe(b.reqId);
  });
});
