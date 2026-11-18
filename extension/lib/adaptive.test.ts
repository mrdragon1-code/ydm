import { describe, expect, it } from 'vitest';
import { Adaptive, RETRY_MS, START, STEP_MS } from './adaptive';

/** Runs `steps` steps; `speedOf(n)` is the total speed with n connections. */
function simulate(a: Adaptive, steps: number, speedOf: (n: number) => number, now: { t: number }, start = a.initial()) {
  let running = start;
  let bytes = 0;
  for (let i = 0; i < steps; i++) {
    now.t += STEP_MS;
    bytes += (speedOf(running) * STEP_MS) / 1000;
    if (a.tick(running, bytes) === 'add') running++;
  }
  return running;
}

const clock = () => {
  const now = { t: 0 };
  return { now, at: () => now.t };
};

describe('Adaptive', () => {
  it(`starts with ${START} connections, or with what worked on the site before`, () => {
    expect(new Adaptive(6).initial()).toBe(START);
    expect(new Adaptive(1).initial()).toBe(1);
    expect(new Adaptive(6, 6).initial()).toBe(6);
    expect(new Adaptive(3, 6).initial()).toBe(3);
    expect(new Adaptive(6, 0).initial()).toBe(1);
  });

  it('adds connections while each one raises the speed', () => {
    const { now, at } = clock();
    // Server limited per connection: speed grows with every connection.
    expect(simulate(new Adaptive(6, undefined, at), 10, (n) => n * 1e6, now)).toBe(6);
  });

  it('holds once the speed no longer rises', () => {
    const { now, at } = clock();
    // Full at 16 MB/s: the fifth connection buys nothing and stays the last.
    expect(simulate(new Adaptive(8, undefined, at), 8, (n) => Math.min(n * 4e6, 16e6), now)).toBe(5);
  });

  it('tries one more again later, as conditions change during a download', () => {
    const { now, at } = clock();
    const a = new Adaptive(8, undefined, at);
    let line = 16e6;
    let running = a.initial();
    let bytes = 0;
    const step = () => {
      now.t += STEP_MS;
      bytes += Math.min(running * 4e6, line);
      if (a.tick(running, bytes) === 'add') running++;
    };
    for (let i = 0; i < 6; i++) step();
    expect(running).toBe(5);
    // The line frees up (another download ended): after the retry wait the
    // extra connection pays off, and adding goes on.
    line = 100e6;
    for (let i = 0; i < RETRY_MS / STEP_MS + 4; i++) step();
    expect(running).toBeGreaterThan(6);
  });

  it('waits a full step before judging, and never judges while connections warm up', () => {
    const { now, at } = clock();
    const a = new Adaptive(6, undefined, at);
    now.t = STEP_MS / 2;
    expect(a.tick(3, 1e6)).toBe('hold');
    // A connection still waiting for its first byte: no verdict, and its
    // set-up time does not count against it afterwards.
    now.t += STEP_MS * 3;
    expect(a.tick(4, 2e6, 1)).toBe('hold');
    now.t += STEP_MS;
    expect(a.tick(4, 6e6)).toBe('add');
  });

  it('a refusal lowers the ceiling for good', () => {
    const { now, at } = clock();
    const a = new Adaptive(6, undefined, at);
    a.refused(4);
    expect(a.max).toBe(3);
    a.setMax(6);
    expect(a.max).toBe(3);
    // Up to the tolerated count, never past it.
    expect(simulate(a, 10, (n) => n * 1e6, now, 1)).toBe(3);
  });

  it('a higher budget lets it probe again at once', () => {
    const { now, at } = clock();
    const a = new Adaptive(2, undefined, at);
    now.t += STEP_MS;
    expect(a.tick(2, 1e6)).toBe('hold');
    a.setMax(4);
    now.t += STEP_MS;
    expect(a.tick(2, 3e6)).toBe('add');
  });

  it('remembers the fastest step and its connections', () => {
    const { now, at } = clock();
    const a = new Adaptive(8, undefined, at);
    simulate(a, 8, (n) => Math.min(n * 4e6, 16e6), now);
    expect(a.best.connections).toBe(4);
    expect(a.best.speed).toBe(16e6);
  });
});
