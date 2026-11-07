import { describe, expect, it } from 'vitest';
import { Adaptive, START, STEP_MS } from './adaptive';

/** Runs `steps` steps; `speedOf(n)` is the total speed with n connections. */
function simulate(a: Adaptive, steps: number, speedOf: (n: number) => number, now: { t: number }) {
  let running = a.initial();
  let bytes = 0;
  for (let i = 0; i < steps; i++) {
    now.t += STEP_MS;
    bytes += (speedOf(running) * STEP_MS) / 1000;
    if (a.tick(running, bytes) === 'add') running++;
  }
  return running;
}

describe('Adaptive', () => {
  it(`starts with ${START} connections, fewer if the ceiling is lower`, () => {
    expect(new Adaptive(6).initial()).toBe(START);
    expect(new Adaptive(1).initial()).toBe(1);
  });

  it('adds connections while each one raises the speed', () => {
    const now = { t: 0 };
    const a = new Adaptive(6, () => now.t);
    // Server limited per connection: speed grows with every connection.
    expect(simulate(a, 10, (n) => n * 1e6, now)).toBe(6);
  });

  it('stops adding once the speed no longer rises', () => {
    const now = { t: 0 };
    const a = new Adaptive(6, () => now.t);
    // The line is full at 20 MB/s, reached with five connections.
    expect(simulate(a, 10, (n) => Math.min(n * 4e6, 20e6), now)).toBe(6);
    const b = new Adaptive(8, () => now.t);
    // Full at 16 MB/s: the fifth connection buys nothing and stays the last.
    expect(simulate(b, 10, (n) => Math.min(n * 4e6, 16e6), now)).toBe(5);
  });

  it('waits a full step before judging', () => {
    const now = { t: 0 };
    const a = new Adaptive(6, () => now.t);
    now.t = STEP_MS / 2;
    expect(a.tick(3, 1e6)).toBe('hold');
  });

  it('a refusal lowers the ceiling for good', () => {
    const now = { t: 0 };
    const a = new Adaptive(6, () => now.t);
    a.refused(4);
    expect(a.max).toBe(3);
    a.setMax(6);
    expect(a.max).toBe(3);
    now.t += STEP_MS;
    expect(a.tick(2, 1e6)).toBe('hold');
  });

  it('a higher budget lets it probe again', () => {
    const now = { t: 0 };
    const a = new Adaptive(2, () => now.t);
    now.t += STEP_MS;
    expect(a.tick(2, 1e6)).toBe('hold');
    a.setMax(4);
    now.t += STEP_MS;
    expect(a.tick(2, 3e6)).toBe('add');
  });
});
