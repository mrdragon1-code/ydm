import { describe, expect, it } from 'vitest';
import { budgets, CAP_MAX_AGE, freshCaps, hostOf } from './budget';

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

  it('host includes the port', () => {
    expect(hostOf('http://127.0.0.1:8080/file')).toBe('127.0.0.1:8080');
    expect(hostOf('not a url')).toBe('');
  });
});
