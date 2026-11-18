import { describe, expect, it } from 'vitest';
import { BEST_MAX_AGE, budgets, CAP_MAX_AGE, freshCaps, hostOf, mergeCap, RAISE_EVERY } from './budget';

describe('budgets', () => {
  it('one download gets what the user allows', () => {
    expect(budgets([{ id: 1, host: 'a' }], 4)).toEqual(new Map([[1, 4]]));
    expect(budgets([{ id: 1, host: 'a' }], 6)).toEqual(new Map([[1, 6]]));
  });

  it('downloads from one host share six connections, never more', () => {
    const b = budgets(
      [
        { id: 1, host: 'a' },
        { id: 2, host: 'a' },
        { id: 3, host: 'a' },
      ],
      6,
    );
    expect([...b.values()].reduce((x, y) => x + y)).toBe(6);
    expect(b).toEqual(
      new Map([
        [1, 2],
        [2, 2],
        [3, 2],
      ]),
    );
  });

  it('the earlier download gets the odd one', () => {
    const b = budgets(
      [
        { id: 7, host: 'a' },
        { id: 3, host: 'a' },
        { id: 9, host: 'a' },
        { id: 5, host: 'a' },
      ],
      6,
    );
    expect(b.get(3)).toBe(2);
    expect(b.get(5)).toBe(2);
    expect(b.get(7)).toBe(1);
    expect(b.get(9)).toBe(1);
  });

  it('different hosts do not share', () => {
    const b = budgets(
      [
        { id: 1, host: 'a' },
        { id: 2, host: 'b' },
      ],
      6,
    );
    expect(b).toEqual(
      new Map([
        [1, 6],
        [2, 6],
      ]),
    );
  });

  it('a host that refused more connections gets fewer', () => {
    const b = budgets([{ id: 1, host: 'a' }], 6, (h) => (h === 'a' ? 2 : undefined));
    expect(b.get(1)).toBe(2);
  });

  it('every download keeps at least one connection', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: i, host: 'a' }));
    expect(Math.min(...budgets(many, 6).values())).toBe(1);
  });
});

describe('host caps', () => {
  it('are forgotten after a week', () => {
    const now = 10 * CAP_MAX_AGE;
    const caps = { old: { connections: 2, at: now - CAP_MAX_AGE - 1 }, recent: { connections: 3, at: now - 1000 } };
    expect(Object.keys(freshCaps(caps, now))).toEqual(['recent']);
  });

  it('the best connection count is kept a month, the tolerated one a week', () => {
    const now = 10 * BEST_MAX_AGE;
    const twoWeeks = now - 2 * CAP_MAX_AGE;
    const caps = { a: { connections: 2, at: twoWeeks, best: 5, speed: 9e6, bestAt: twoWeeks }, b: { best: 4, bestAt: now - BEST_MAX_AGE - 1, at: 0 } };
    expect(freshCaps(caps, now)).toEqual({ a: { at: twoWeeks, best: 5, speed: 9e6, bestAt: twoWeeks } });
  });

  it('a refusal lowers what is tolerated, never raises it', () => {
    let c = mergeCap(undefined, { type: 'capped', connections: 3 }, 1);
    expect(c.connections).toBe(3);
    c = mergeCap(c, { type: 'capped', connections: 5 }, 2);
    expect(c.connections).toBe(3);
  });

  it('a fast download is remembered; one with no refusal at the limit lets it rise', () => {
    const t = RAISE_EVERY;
    let c = mergeCap(undefined, { type: 'capped', connections: 3 }, 1);
    // Too soon after the refusal: no rise yet.
    expect(mergeCap(c, { type: 'tuned', connections: 3, speed: 6e6, most: 3, refused: false }, 2).connections).toBe(3);
    c = mergeCap(c, { type: 'tuned', connections: 3, speed: 6e6, most: 3, refused: false }, 1 + t);
    expect(c).toMatchObject({ connections: 4, best: 3, speed: 6e6, bestAt: 1 + t });
    // Refused again, below the limit, or within the hour: no rise.
    expect(mergeCap(c, { type: 'tuned', connections: 4, speed: 7e6, most: 4, refused: true }, 3 * t).connections).toBe(4);
    expect(mergeCap(c, { type: 'tuned', connections: 2, speed: 7e6, most: 2, refused: false }, 3 * t).connections).toBe(4);
    expect(mergeCap(c, { type: 'tuned', connections: 4, speed: 7e6, most: 4, refused: false }, 1.5 * t).connections).toBe(4);
    // Back at the browser's own limit: nothing left to remember.
    c = mergeCap({ connections: 5, at: 0 }, { type: 'tuned', connections: 5, speed: 1, most: 5, refused: false }, t);
    expect(c.connections).toBeUndefined();
  });

  it('a much slower download does not replace a better record', () => {
    const c = mergeCap(undefined, { type: 'tuned', connections: 6, speed: 10e6, most: 6, refused: false }, 1);
    expect(mergeCap(c, { type: 'tuned', connections: 3, speed: 4e6, most: 3, refused: false }, 2).best).toBe(6);
    expect(mergeCap(c, { type: 'tuned', connections: 5, speed: 9e6, most: 5, refused: false }, 2).best).toBe(5);
    expect(mergeCap(c, { type: 'tuned', connections: 3, speed: 4e6, most: 3, refused: false }, 1 + CAP_MAX_AGE).best).toBe(3);
  });

  it('host includes the port', () => {
    expect(hostOf('http://127.0.0.1:8080/file')).toBe('127.0.0.1:8080');
    expect(hostOf('not a url')).toBe('');
  });
});
