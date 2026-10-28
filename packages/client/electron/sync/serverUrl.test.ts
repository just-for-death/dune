import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeServerUrl } from '@dune/shared';
import {
  SERVER_URL_SETTLE_MS,
  createPlaytimeFlushGate,
  shouldFlushPlaytime,
} from './serverUrl';

// DUN-124: main uses the shared rules; these cases pin the behaviour main
// relied on before the switch (unchanged).
describe('normalizeServerUrl (@dune/shared, as used by main)', () => {
  it.each([
    ['http://192.168.1.100:3030', 'http://192.168.1.100:3030'],
    ['https://dune.example.com', 'https://dune.example.com'],
    ['HTTPS://Dune.Example.COM:8443', 'https://dune.example.com:8443'],
    ['http://localhost:3030/', 'http://localhost:3030'],
    ['http://localhost:3030///', 'http://localhost:3030'],
    ['https://example.com/dune/', 'https://example.com/dune'],
    ['  http://nas.lan:3030 \n', 'http://nas.lan:3030'],
    ['http://[::1]:3030/', 'http://[::1]:3030'],
    ['https://example.com:443', 'https://example.com'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = normalizeServerUrl(' https://example.com/dune/ ');
    expect(normalizeServerUrl(once)).toBe(once);
  });

  it('accepts a single-label host like http://loc (valid hostname, e.g. intranet names)', () => {
    // Syntactically complete; the settle gate, not the validator, keeps
    // keystroke drafts like this from being flushed to.
    expect(normalizeServerUrl('http://loc')).toBe('http://loc');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['non-string', undefined],
    ['partial scheme h', 'h'],
    ['partial scheme http', 'http'],
    ['partial scheme http:', 'http:'],
    ['partial scheme http:/', 'http:/'],
    ['scheme only http://', 'http://'],
    ['scheme only https://', 'https://'],
    ['scheme-less host:port', 'localhost:3030'],
    ['scheme-less IP', '192.168.1.100:3030'],
    ['ftp scheme', 'ftp://example.com'],
    ['ftp: opaque', 'ftp:'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['file scheme', 'file:///etc/passwd'],
    ['credentials user:pass', 'http://user:pass@example.com'],
    ['credentials user only', 'https://user@example.com'],
    ['empty credentials', 'http://@example.com'],
    ['empty port while typing', 'http://localhost:'],
    ['non-numeric port', 'http://localhost:30a'],
    ['IPv4 shorthand mid-typing', 'http://192.168.'],
    ['IPv4 shorthand', 'http://10.1'],
    ['single number host', 'http://1'],
    ['trailing dot', 'http://example.'],
    ['query string', 'http://example.com?x=1'],
    ['fragment', 'http://example.com/#a'],
    ['cloud metadata host', 'http://169.254.169.254'],
    ['blocked port', 'http://example.com:22'],
  ])('rejects %s', (_name, input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });
});

describe('shouldFlushPlaytime', () => {
  it('does not flush when the URL is unchanged (including equivalent spellings)', () => {
    expect(shouldFlushPlaytime('http://nas:3030', 'http://nas:3030')).toBe(false);
    expect(shouldFlushPlaytime('http://nas:3030', ' http://NAS:3030/ ')).toBe(false);
  });

  it('never flushes to an invalid URL', () => {
    expect(shouldFlushPlaytime('http://nas:3030', 'http://')).toBe(false);
    expect(shouldFlushPlaytime('', 'ht')).toBe(false);
    expect(shouldFlushPlaytime(null, 'ftp://nas')).toBe(false);
    expect(shouldFlushPlaytime('http://nas:3030', '')).toBe(false);
  });

  it('flushes when the URL changes to a different valid URL', () => {
    expect(shouldFlushPlaytime('http://nas:3030', 'http://nas:3031')).toBe(true);
    expect(shouldFlushPlaytime('', 'http://nas:3030')).toBe(true);
    expect(shouldFlushPlaytime('garbage', 'https://dune.example.com')).toBe(true);
  });
});

// Fake persisted queue in a temp dir: stands in for electron-store so the
// test can assert nothing is ever dropped by a save. Never touches real config.
type Session = { id: number };
function fakeQueueStore(dir: string) {
  const file = path.join(dir, 'pending.json');
  return {
    read: (): Session[] => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []),
    write: (q: Session[]) => fs.writeFileSync(file, JSON.stringify(q)),
  };
}

describe('createPlaytimeFlushGate', () => {
  let tmp: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-dun045-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keystroke saves h, ht, ... flush exactly once, to the final valid URL', () => {
    const target = 'http://192.168.1.10:3030';
    const queue = fakeQueueStore(tmp);
    queue.write([{ id: 1 }, { id: 2 }]);
    const flushed: string[] = [];
    // Fake flush that fails (server unreachable): items must stay queued.
    const gate = createPlaytimeFlushGate({ initialUrl: '', flush: (url) => { flushed.push(url); } });

    for (let i = 1; i <= target.length; i++) {
      gate.onUrlSaved(target.slice(0, i));
      expect(gate.savedUrl()).toBeNull(); // drafts are never usable
      vi.advanceTimersByTime(100); // typing faster than the settle window
    }
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(SERVER_URL_SETTLE_MS);

    expect(flushed).toEqual([target]);
    expect(gate.savedUrl()).toBe(target);
    expect(queue.read()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('re-saving the same URL does not re-flush', () => {
    const flush = vi.fn();
    const gate = createPlaytimeFlushGate({ initialUrl: 'http://nas:3030', flush });
    gate.onUrlSaved('http://nas:3030');
    gate.onUrlSaved('http://nas:3030/');
    vi.advanceTimersByTime(SERVER_URL_SETTLE_MS * 2);
    expect(flush).not.toHaveBeenCalled();
    expect(gate.savedUrl()).toBe('http://nas:3030');
  });

  it('editing away and back to the saved URL does not flush', () => {
    const flush = vi.fn();
    const gate = createPlaytimeFlushGate({ initialUrl: 'http://nas:3030', flush });
    gate.onUrlSaved('http://nas:303');
    gate.onUrlSaved('http://nas:3030');
    expect(gate.savedUrl()).toBe('http://nas:3030');
    vi.advanceTimersByTime(SERVER_URL_SETTLE_MS * 2);
    expect(flush).not.toHaveBeenCalled();
  });

  it('saving an invalid URL never flushes and leaves the queue intact', () => {
    const queue = fakeQueueStore(tmp);
    queue.write([{ id: 7 }]);
    const flush = vi.fn();
    const gate = createPlaytimeFlushGate({ initialUrl: 'http://nas:3030', flush });
    for (const bad of ['http://', 'ftp://nas', 'javascript:alert(1)', 'http://u:p@nas', '']) {
      gate.onUrlSaved(bad);
      vi.advanceTimersByTime(SERVER_URL_SETTLE_MS);
      expect(gate.savedUrl()).toBeNull();
    }
    expect(flush).not.toHaveBeenCalled();
    expect(queue.read()).toEqual([{ id: 7 }]);
  });

  it('flushes once when a settled valid URL changes, and exposes it as the saved URL', () => {
    const flush = vi.fn();
    const gate = createPlaytimeFlushGate({ initialUrl: 'http://old:3030', flush });
    expect(gate.savedUrl()).toBe('http://old:3030');
    gate.onUrlSaved(' https://new.example.com/ ');
    expect(gate.savedUrl()).toBeNull();
    vi.advanceTimersByTime(SERVER_URL_SETTLE_MS);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('https://new.example.com');
    expect(gate.savedUrl()).toBe('https://new.example.com');
  });

  it('treats an invalid initial URL as no saved URL', () => {
    const gate = createPlaytimeFlushGate({ initialUrl: 'localhost', flush: vi.fn() });
    expect(gate.savedUrl()).toBeNull();
  });

  it('dispose cancels a pending flush', () => {
    const flush = vi.fn();
    const gate = createPlaytimeFlushGate({ initialUrl: '', flush });
    gate.onUrlSaved('http://nas:3030');
    gate.dispose();
    vi.advanceTimersByTime(SERVER_URL_SETTLE_MS * 2);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('createPlaytimeFlushGate.commit (DUN-071/121)', () => {
  it('a valid URL is saved at once (no settle wait) and flushes when it changed', () => {
    const flush = vi.fn();
    const gate = createPlaytimeFlushGate({ initialUrl: 'http://old:3030', flush, settleMs: 10_000 });
    expect(gate.commit(' http://nas:3030/ ')).toBe('http://nas:3030');
    expect(gate.savedUrl()).toBe('http://nas:3030');
    expect(flush).toHaveBeenCalledWith('http://nas:3030');
    expect(gate.commit('http://nas:3030')).toBe('http://nas:3030');
    expect(flush).toHaveBeenCalledTimes(1);
    gate.dispose();
  });

  it('a half-typed or scheme-less URL changes nothing', () => {
    const flush = vi.fn();
    const gate = createPlaytimeFlushGate({ initialUrl: 'http://nas:3030', flush });
    for (const bad of ['localhost:3030', 'h', 'http://192.168.', '', undefined, { url: 'x' }]) expect(gate.commit(bad)).toBeNull();
    expect(gate.savedUrl()).toBe('http://nas:3030');
    expect(flush).not.toHaveBeenCalled();
    gate.dispose();
  });

  it('cancels a pending draft settle', () => {
    vi.useFakeTimers();
    try {
      const flush = vi.fn();
      const gate = createPlaytimeFlushGate({ initialUrl: '', flush, settleMs: 100 });
      gate.onUrlSaved('http://draft:1');
      expect(gate.commit('http://real:3030')).toBe('http://real:3030');
      vi.advanceTimersByTime(500);
      expect(gate.savedUrl()).toBe('http://real:3030');
      expect(flush.mock.calls).toEqual([['http://real:3030']]);
    } finally {
      vi.useRealTimers();
    }
  });
});
