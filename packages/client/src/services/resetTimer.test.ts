import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResetTimer } from './resetTimer';

describe('createResetTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs the callback once after the delay', () => {
    const timer = createResetTimer();
    const fn = vi.fn();
    timer.schedule(fn, 4000);
    expect(timer.isPending()).toBe(true);
    vi.advanceTimersByTime(3999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(timer.isPending()).toBe(false);
  });

  it('scheduling again replaces the pending callback', () => {
    const timer = createResetTimer();
    const first = vi.fn();
    const second = vi.fn();
    timer.schedule(first, 4000);
    vi.advanceTimersByTime(3000);
    timer.schedule(second, 4000);
    vi.advanceTimersByTime(3000);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('clear cancels the pending callback and is safe to repeat', () => {
    const timer = createResetTimer();
    const fn = vi.fn();
    timer.schedule(fn, 4000);
    timer.clear();
    timer.clear();
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    expect(timer.isPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses injected timers', () => {
    const set = vi.fn(() => 7);
    const clear = vi.fn();
    const timer = createResetTimer({ set, clear });
    timer.schedule(() => {}, 10);
    timer.schedule(() => {}, 10);
    expect(set).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledWith(7);
  });
});
