import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inOrder } from './window';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A fake piece fetch: piece i takes `ms(i)` and is `size` bytes. */
function pieces(ms: (i: number, attempt: number) => number, size = 10) {
  const started: number[] = [];
  const attempts = new Map<number, number>();
  const fetch = (i: number, signal: AbortSignal) => {
    started.push(i);
    const attempt = attempts.get(i) ?? 0;
    attempts.set(i, attempt + 1);
    return new Promise<{ i: number; n: number }>((resolve, reject) => {
      const t = setTimeout(() => resolve({ i, n: size }), ms(i, attempt));
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
    });
  };
  return { started, fetch, attempts };
}

describe('inOrder', () => {
  it('writes every piece once, in order, whatever order they arrive in', async () => {
    const { fetch } = pieces((i) => [50, 10, 30, 5, 20][i]!);
    const written: number[] = [];
    const done = inOrder({ from: 0, to: 5, width: () => 3, fetch, size: (d) => d.n, write: (i) => written.push(i), now: () => Date.now() });
    await vi.runAllTimersAsync();
    await done;
    expect(written).toEqual([0, 1, 2, 3, 4]);
  });

  it('a slow first piece does not stop the others from being fetched', async () => {
    // Piece 0 takes 1 s; the rest 100 ms each.
    const { fetch, started } = pieces((i) => (i === 0 ? 1000 : 100));
    const written: number[] = [];
    const done = inOrder({ from: 0, to: 8, width: () => 3, fetch, size: (d) => d.n, write: (i) => written.push(i), now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(450);
    // With a window that waits for the head this would be pieces 0-2 only.
    expect(started.length).toBeGreaterThanOrEqual(6);
    expect(written).toEqual([]);
    await vi.runAllTimersAsync();
    await done;
    expect(written).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('holds at most the memory limit ahead, except the piece everything waits for', async () => {
    const { fetch, started } = pieces((i) => (i === 0 ? 5000 : 10), 10);
    const done = inOrder({ from: 0, to: 50, width: () => 4, fetch, size: (d) => d.n, write: () => {}, maxAhead: 30, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(200);
    // Past 30 bytes waiting for piece 0, nothing new starts (those already
    // under way may still finish).
    const paused = started.length;
    expect(paused).toBeLessThanOrEqual(1 + 3 + 3);
    await vi.advanceTimersByTimeAsync(600);
    expect(started.length).toBe(paused);
    await vi.runAllTimersAsync();
    await done;
  });

  it('asks again for a piece far slower than usual, and the first answer wins', async () => {
    // Piece 5's first request hangs for a minute; its second takes 100 ms.
    const { fetch, attempts } = pieces((i, attempt) => (i === 5 && attempt === 0 ? 60_000 : 100));
    const written: number[] = [];
    const done = inOrder({ from: 0, to: 8, width: () => 2, fetch, size: (d) => d.n, write: (i) => written.push(i), now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(attempts.get(5)).toBe(2);
    expect(written).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('a failed piece stops everything; resumes from `from`', async () => {
    const fetch = (i: number) => (i === 2 ? Promise.reject(new Error('404')) : Promise.resolve(i));
    const written: number[] = [];
    await expect(inOrder({ from: 0, to: 5, width: () => 1, fetch, size: () => 1, write: (i) => written.push(i) })).rejects.toThrow('404');
    expect(written).toEqual([0, 1]);
    const again: number[] = [];
    await inOrder({ from: 3, to: 5, width: () => 2, fetch, size: () => 1, write: (i) => again.push(i) });
    expect(again).toEqual([3, 4]);
  });

  it('the width can change while it runs', async () => {
    let width = 1;
    const { fetch, started } = pieces(() => 100);
    const done = inOrder({ from: 0, to: 20, width: () => width, fetch, size: (d) => d.n, write: () => {}, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(250);
    const before = started.length;
    width = 6;
    await vi.advanceTimersByTimeAsync(110);
    expect(started.length - before).toBeGreaterThanOrEqual(5);
    await vi.runAllTimersAsync();
    await done;
  });
});
