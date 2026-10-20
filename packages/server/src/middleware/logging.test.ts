import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import axios, { AxiosError } from 'axios';
import {
  createLogger,
  requestLogger,
  redactUrl,
  redactText,
  serializeError,
  sanitizeLogValue,
  sanitizeLogArgs,
  SANITIZE_LIMITS,
  type LoggedRequest,
} from './logging.js';

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

// ---------------------------------------------------------------------------
// DUN-009: secrets must never reach log output.
// ---------------------------------------------------------------------------

const sentinel = (label: string) => `${label}-${randomBytes(12).toString('hex')}`;

/** A local port that is guaranteed closed (bind, read the port, close). */
async function refusedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** Real AxiosError from a refused connection, carrying secrets in header, query, and params. */
async function failedAxiosRequest(apiKey: string, queryKey: string, raKey: string): Promise<AxiosError> {
  const port = await refusedPort();
  try {
    await axios.get(`http://127.0.0.1:${port}/api/upload-file?key=${queryKey}&game=Doom`, {
      headers: { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` },
      params: { y: raKey },
      timeout: 5000,
    });
  } catch (err) {
    return err as AxiosError;
  }
  throw new Error('expected the request to a closed port to fail');
}

describe('error serializer + redaction (DUN-009)', () => {
  it('logger.error({ err }) with a real AxiosError never leaks header/query/params secrets', async () => {
    const apiKey = sentinel('hdr');
    const queryKey = sentinel('steam');
    const raKey = sentinel('ra');
    const err = await failedAxiosRequest(apiKey, queryKey, raKey);
    // Precondition: the raw error really does carry the secrets.
    expect(JSON.stringify(err.config)).toContain(apiKey);

    const { lines, stream } = capture();
    const log = createLogger(stream);
    // The exact call shapes used by server.ts, sync.ts, trpc/http.ts, remoteSync.ts.
    log.error({ err }, 'Remote sync error');
    log.error({ reqId: 'r1', err }, 'API internal error');
    log.error({ error: err }, 'tRPC-style key');
    log.error(err, 'error passed directly');
    const out = lines.join('');

    for (const secret of [apiKey, queryKey, raKey]) expect(out).not.toContain(secret);
    expect(lines.length).toBe(4);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      const e = parsed.err ?? parsed.error;
      expect(e.message).toBe(err.message);
      expect(e.code).toBe('ECONNREFUSED');
      expect(e.type).toBe('AxiosError');
      expect(e.method).toBe('GET');
      expect(e.url).toContain('/api/upload-file');
      expect(e.url).toContain('key=[REDACTED]');
      expect(e.url).toContain('y=[REDACTED]');
      expect(e.url).toContain('game=Doom');
      for (const k of ['config', 'request', 'response', 'headers']) expect(e).not.toHaveProperty(k);
    }
  });

  it('keeps response status/statusText for HTTP errors but drops response data/headers/config', () => {
    const secret = sentinel('resp');
    const err = new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', {
      url: `https://peer.example/api?token=${secret}`,
      method: 'post',
      headers: { 'x-api-key': secret },
    } as never, { _header: `x-api-key: ${secret}` }, {
      status: 401,
      statusText: 'Unauthorized',
      data: { echo: secret },
      headers: { 'set-cookie': secret },
      config: { headers: { 'x-api-key': secret } },
    } as never);
    const { lines, stream } = capture();
    createLogger(stream).error({ err }, 'push failed');
    expect(lines.join('')).not.toContain(secret);
    const e = JSON.parse(lines[0]).err;
    expect(e).toMatchObject({ status: 401, statusText: 'Unauthorized', method: 'POST', code: 'ERR_BAD_REQUEST' });
    expect(e.url).toBe('https://peer.example/api?token=[REDACTED]');
  });

  it('a plain Error still logs type, message, stack, and code (and its cause)', () => {
    const { lines, stream } = capture();
    const err = Object.assign(new Error('disk full', { cause: new TypeError('inner') }), { code: 'ENOSPC' });
    createLogger(stream).error({ err }, 'write failed');
    const e = JSON.parse(lines[0]).err;
    expect(e.type).toBe('Error');
    expect(e.message).toBe('disk full');
    expect(e.code).toBe('ENOSPC');
    expect(e.stack).toContain('disk full');
    expect(e.stack).toContain('logging.test.ts');
    expect(e.cause).toMatchObject({ type: 'TypeError', message: 'inner' });
  });

  it('serializes AggregateError members and non-error values safely', () => {
    const secret = sentinel('agg');
    const agg = new AggregateError([new Error(`GET /x?api_key=${secret}`)], 'many');
    const e = serializeError(agg) as { aggregateErrors: Array<{ message: string }> };
    expect(e.aggregateErrors[0].message).toBe('GET /x?api_key=[REDACTED]');
    expect(serializeError(`failed https://u:${secret}@h/x?key=${secret}`)).toBe('failed https://[REDACTED]@h/x?key=[REDACTED]');
    expect(serializeError(undefined)).toBeUndefined();
    expect(serializeError(null)).toBeNull();
  });

  it('redacts nested apiKey/token/password/secret and authorization/x-api-key/cookie headers', () => {
    const s = sentinel('nested');
    const { lines, stream } = capture();
    createLogger(stream).info(
      {
        password: s,
        token: s,
        settings: { apiKey: s, secret: s, name: 'keep-me' },
        opts: { headers: { 'x-api-key': s, authorization: `Bearer ${s}`, cookie: s, accept: 'json' } },
        req: { headers: { authorization: s, 'x-api-key': s } },
        deep: { inner: { token: s, headers: { authorization: s } } },
      },
      'nested',
    );
    const out = lines.join('');
    expect(out).not.toContain(s);
    const parsed = JSON.parse(out);
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.settings.apiKey).toBe('[REDACTED]');
    expect(parsed.settings.name).toBe('keep-me');
    expect(parsed.opts.headers['x-api-key']).toBe('[REDACTED]');
    expect(parsed.opts.headers.authorization).toBe('[REDACTED]');
    expect(parsed.opts.headers.accept).toBe('json');
    expect(parsed.req.headers.authorization).toBe('[REDACTED]');
    expect(parsed.deep.inner.token).toBe('[REDACTED]');
  });

  it('request logs carry no query string or headers', () => {
    const s = sentinel('reqlog');
    const { lines, stream } = capture();
    const req = {
      method: 'GET',
      path: '/api/games',
      url: `/api/games?api_key=${s}`,
      headers: { 'x-api-key': s },
    } as unknown as LoggedRequest;
    const res = fakeRes(200);
    requestLogger(req, res, () => {}, createLogger(stream));
    (res as unknown as EventEmitter).emit('finish');
    expect(lines.join('')).not.toContain(s);
    expect(JSON.parse(lines[0]).path).toBe('/api/games');
  });
});

describe('redactUrl / redactText (DUN-009)', () => {
  it('strips userinfo and sensitive params, keeps the rest', () => {
    expect(redactUrl('https://user:pw@peer:3030/a?key=1&apikey=2&API_KEY=3&access_token=4&y=5&z=user&page=2')).toBe(
      'https://peer:3030/a?key=[REDACTED]&apikey=[REDACTED]&API_KEY=[REDACTED]&access_token=[REDACTED]&y=[REDACTED]&z=user&page=2',
    );
    expect(redactUrl('/path?secret=1', 'http://base')).toBe('http://base/path?secret=[REDACTED]');
    expect(redactUrl('http://h/p', undefined, new URLSearchParams({ password: 'x', q: 'ok' }))).toBe(
      'http://h/p?password=[REDACTED]&q=ok',
    );
  });

  it('handles empty, non-string, and unparseable input without throwing', () => {
    expect(redactUrl(undefined)).toBeUndefined();
    expect(redactUrl('')).toBeUndefined();
    expect(redactUrl(42)).toBeUndefined();
    expect(redactUrl('not a url ?token=abc')).toBe('not a url ?token=[REDACTED]');
  });

  it('scrubs credential pairs in free text', () => {
    expect(redactText('GET https://a:b@h/x?steam_key=s&y=r&ok=1')).toBe('GET https://[REDACTED]@h/x?steam_key=[REDACTED]&y=[REDACTED]&ok=1');
    expect(redactText('nothing to see')).toBe('nothing to see');
  });
});

// ---------------------------------------------------------------------------
// DUN-025: errors nested under ANY key / inside arrays / as interpolation
// args must be serialized safely (pino serializers only see top-level keys).
// ---------------------------------------------------------------------------

describe('deep log sanitization hook (DUN-025)', () => {
  const secrets = () => ({ apiKey: sentinel('hdr'), queryKey: sentinel('steam'), raKey: sentinel('ra') });

  it('a real AxiosError nested anywhere never leaks its secrets', async () => {
    const { apiKey, queryKey, raKey } = secrets();
    const err = await failedAxiosRequest(apiKey, queryKey, raKey);
    expect(JSON.stringify(err.config)).toContain(apiKey); // precondition: the raw error carries them

    const { lines, stream } = capture();
    const log = createLogger(stream);
    log.error({ nested: { e: err } }, 'nested key');
    log.error({ result: err }, 'non-err top-level key');
    log.error({ arr: [err, 'x'] }, 'array');
    log.error({ a: { b: { c: { e: err } } } }, '3-deep');
    log.error({ ctx: { attempts: [{ when: 1, failure: err }] }, plain: { ok: true } }, 'mixed');
    log.error('interpolated %s / %j / %o', err, err, err);
    log.error({ k: 1 }, 'interpolated after object %j', { inner: err });
    const out = lines.join('');

    expect(lines.length).toBe(7);
    for (const s of [apiKey, queryKey, raKey]) expect(out).not.toContain(s);
    const parsed = lines.map((l) => JSON.parse(l));
    for (const e of [
      parsed[0].nested.e,
      parsed[1].result,
      parsed[2].arr[0],
      parsed[3].a.b.c.e,
      parsed[4].ctx.attempts[0].failure,
    ]) {
      expect(e).toMatchObject({ type: 'AxiosError', code: 'ECONNREFUSED', message: err.message, method: 'GET' });
      expect(e.url).toContain('key=[REDACTED]');
      for (const k of ['config', 'request', 'response', 'headers']) expect(e).not.toHaveProperty(k);
    }
    expect(parsed[2].arr[1]).toBe('x');
    expect(parsed[4].plain).toEqual({ ok: true });
    expect(parsed[5].msg).toContain(`interpolated ${String(err)} / {`); // same %s text as before
    expect(parsed[5].msg).toContain('"code":"ECONNREFUSED"');
  });

  it('logs a circular object containing an error without throwing', () => {
    const s = sentinel('circ');
    const e = Object.assign(new Error('boom'), { config: { headers: { 'x-api-key': s } } });
    const a: Record<string, unknown> = { name: 'a', e };
    a.self = a;
    const list: unknown[] = [a];
    list.push(list);
    a.list = list;
    const { lines, stream } = capture();
    expect(() => createLogger(stream).error({ a }, 'circular')).not.toThrow();
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain(s);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.a.self).toBe('[Circular]');
    expect(parsed.a.e).toMatchObject({ type: 'Error', message: 'boom' });
    expect(parsed.a.list[1]).toBe('[Circular]');
  });

  it('does not flag shared (non-circular) references as circular', () => {
    const shared = { v: 1 };
    const { lines, stream } = capture();
    createLogger(stream).info({ x: shared, y: shared, z: [shared, shared] }, 'shared');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.y).toEqual({ v: 1 });
    expect(parsed.z).toEqual([{ v: 1 }, { v: 1 }]);
  });

  it('caps 50-deep nesting with a marker (and still sanitizes errors above the cap)', () => {
    const s = sentinel('deep');
    let deep: Record<string, unknown> = { leak: Object.assign(new Error('bottom'), { secret: s }) };
    for (let i = 0; i < 50; i++) deep = { child: deep };
    const { lines, stream } = capture();
    createLogger(stream).warn({ deep }, 'deep');
    expect(lines[0]).not.toContain(s);
    let node = JSON.parse(lines[0]).deep;
    let levels = 0;
    while (node && typeof node === 'object') {
      node = node.child;
      levels++;
    }
    expect(node).toBe('[MaxDepth]');
    expect(levels).toBeLessThanOrEqual(SANITIZE_LIMITS.maxDepth);
  });

  it('caps huge arrays and objects with many keys', () => {
    const huge = Array.from({ length: 100_000 }, (_, i) => i);
    const wide: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i;
    const { lines, stream } = capture();
    createLogger(stream).info({ huge, wide }, 'big');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.huge.length).toBe(SANITIZE_LIMITS.maxArrayItems + 1);
    expect(parsed.huge.at(-1)).toBe(`[... ${100_000 - SANITIZE_LIMITS.maxArrayItems} more items]`);
    expect(Object.keys(parsed.wide).length).toBe(SANITIZE_LIMITS.maxKeys + 1);
    expect(parsed.wide['...']).toBe(`[${5000 - SANITIZE_LIMITS.maxKeys} more keys]`);
    expect(lines[0].length).toBeLessThan(20_000);
  });

  it("never mutates the caller's object", async () => {
    const err = await failedAxiosRequest(sentinel('m1'), sentinel('m2'), sentinel('m3'));
    const arr = [err, { inner: err }];
    const nested = { e: err, arr, n: 1 };
    const payload = { nested, list: arr, keep: 'yes' };
    const { stream } = capture();
    createLogger(stream).error(payload, 'no mutation');
    expect(payload.nested).toBe(nested);
    expect(payload.list).toBe(arr);
    expect(nested.e).toBe(err);
    expect(arr[0]).toBe(err);
    expect((arr[1] as { inner: unknown }).inner).toBe(err);
    expect(Object.keys(payload)).toEqual(['nested', 'list', 'keep']);
    expect(err.config).toBeDefined(); // the error itself is untouched
  });

  it('keeps message templates and interpolation working', () => {
    const { lines, stream } = capture();
    const log = createLogger(stream);
    log.info('msg %s', 'x');
    log.info('n=%d s=%s j=%j o=%o pct=%%', 42, 'str', { a: 1 }, [1, 2]);
    log.info({ reqId: 'r9' }, 'with obj %s and %d', 'y', 7);
    log.info('no args');
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs[0].msg).toBe('msg x');
    expect(msgs[1].msg).toBe('n=42 s=str j={"a":1} o=[1,2] pct=%');
    expect(msgs[2]).toMatchObject({ reqId: 'r9', msg: 'with obj y and 7' });
    expect(msgs[3].msg).toBe('no args');
  });

  it('still lets top-level err drive msg and the err serializer', () => {
    const { lines, stream } = capture();
    const log = createLogger(stream);
    log.error({ err: new Error('top-level') });
    log.error(new Error('bare first arg'), 'bare %s', 'ok');
    const [a, b] = lines.map((l) => JSON.parse(l));
    expect(a.msg).toBe('top-level');
    expect(a.err).toMatchObject({ type: 'Error', message: 'top-level' });
    expect(b.msg).toBe('bare ok');
    expect(b.err.message).toBe('bare first arg');
  });

  it('never throws: a hostile object logs a placeholder (top-level) or [Unreadable] (nested)', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap');
        },
      },
    );
    const getterBomb = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        throw new Error('getter trap');
      },
    });
    const { lines, stream } = capture();
    const log = createLogger(stream);
    expect(() => log.error(hostile, 'hostile top')).not.toThrow();
    expect(() => log.error({ h: hostile, g: getterBomb, ok: 1 }, 'hostile nested')).not.toThrow();
    const [a, b] = lines.map((l) => JSON.parse(l));
    expect(a).toMatchObject({ logSanitizeFailed: true, msg: 'hostile top' });
    expect(b).toMatchObject({ h: '[Unreadable]', g: { x: '[Unreadable]' }, ok: 1, msg: 'hostile nested' });
  });

  it('returns the same references when nothing needs changing (fast path)', () => {
    const plain = { a: 1, b: { c: [1, 2, { d: 'x' }] }, when: new Date(0) };
    expect(sanitizeLogValue(plain)).toBe(plain);
    const args = [plain, 'msg %s', 'x'];
    expect(sanitizeLogArgs(args)).toBe(args);
    expect(sanitizeLogArgs([])).toEqual([]);
  });

  it('leaves opaque values (Date, Map, Buffer, toJSON objects) as-is', () => {
    const d = new Date(0);
    const m = new Map([['k', 'v']]);
    const b = Buffer.from('hi');
    const j = { toJSON: () => 'custom' };
    const out = sanitizeLogValue({ d, m, b, j }) as Record<string, unknown>;
    expect(out.d).toBe(d);
    expect(out.m).toBe(m);
    expect(out.b).toBe(b);
    expect(out.j).toBe(j);
  });
});
