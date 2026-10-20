import { describe, expect, it } from 'vitest';
import { createLatestGate } from './latest';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('createLatestGate', () => {
  it('only the newest ticket is latest', () => {
    const gate = createLatestGate<number>();
    const a = gate.begin(1);
    expect(a.isLatest()).toBe(true);
    const b = gate.begin(2);
    expect(a.isLatest()).toBe(false);
    expect(b.isLatest()).toBe(true);
    expect(b.key).toBe(2);
    expect(gate.currentKey()).toBe(2);
  });

  it('re-selecting the same key still supersedes the older request', () => {
    const gate = createLatestGate<string>();
    const first = gate.begin('A');
    const second = gate.begin('A');
    expect(first.isLatest()).toBe(false);
    expect(second.isLatest()).toBe(true);
  });

  it('invalidate drops every in-flight ticket', () => {
    const gate = createLatestGate<number>();
    const t = gate.begin(1);
    gate.invalidate();
    expect(t.isLatest()).toBe(false);
    expect(gate.currentKey()).toBeUndefined();
  });

  it('a slow reply for A cannot overwrite a fast reply for B', async () => {
    const gate = createLatestGate<string>();
    let shown = '';
    const slowA = deferred<string>();
    const fastB = deferred<string>();
    const load = async (key: string, reply: Promise<string>) => {
      const ticket = gate.begin(key);
      const data = await reply;
      if (ticket.isLatest()) shown = data;
    };
    const pa = load('A', slowA.promise);
    const pb = load('B', fastB.promise);
    fastB.resolve('B data');
    await pb;
    slowA.resolve('A data');
    await pa;
    expect(shown).toBe('B data');
  });
});
