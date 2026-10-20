import { describe, expect, it } from 'vitest';
import { createSaveQueue } from './saveQueue';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('createSaveQueue', () => {
  it('saves immediately when idle', async () => {
    const saved: number[] = [];
    const q = createSaveQueue<number>({ save: async (v) => { saved.push(v); } });
    q.enqueue(1);
    await q.idle();
    expect(saved).toEqual([1]);
    expect(q.busy).toBe(false);
  });

  it('runs one save at a time and then saves only the latest pending value', async () => {
    const started: number[] = [];
    const gates: ReturnType<typeof deferred>[] = [];
    const q = createSaveQueue<number>({
      save: (v) => { started.push(v); const d = deferred(); gates.push(d); return d.promise; },
    });
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    expect(started).toEqual([1]);
    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 3]);
    gates[1].resolve();
    await q.idle();
    expect(started).toEqual([1, 3]);
  });

  it('reports failures and keeps going with the next value', async () => {
    const errors: number[] = [];
    const saved: number[] = [];
    const q = createSaveQueue<number>({
      save: async (v) => { if (v === 1) throw new Error('boom'); },
      onSaved: (v) => saved.push(v),
      onError: (_e, v) => errors.push(v),
    });
    q.enqueue(1);
    await q.idle();
    q.enqueue(2);
    await q.idle();
    expect(errors).toEqual([1]);
    expect(saved).toEqual([2]);
  });

  it('treats a false result as a failed save', async () => {
    const errors: string[] = [];
    const q = createSaveQueue<string>({ save: async () => false, onError: (_e, v) => errors.push(v) });
    q.enqueue('x');
    await q.idle();
    expect(errors).toEqual(['x']);
  });
});
