import { describe, expect, it } from 'vitest';
import { MIN_SPLIT, Segments } from './segments';

const MB = MIN_SPLIT;

function assertContiguous(segs: Segments, total: number) {
  const s = [...segs.list].sort((a, b) => a.start - b.start);
  expect(s[0]!.start).toBe(0);
  expect(s.at(-1)!.end).toBe(total);
  for (let i = 1; i < s.length; i++) expect(s[i]!.start).toBe(s[i - 1]!.end);
}

describe('Segments', () => {
  it('splits evenly and covers everything', () => {
    const segs = new Segments(10 * MB + 7, 3);
    expect(segs.list).toHaveLength(3);
    assertContiguous(segs, 10 * MB + 7);
  });

  it('never makes more segments than bytes', () => {
    expect(new Segments(2, 8).list).toHaveLength(2);
    expect(new Segments(0, 8).list).toHaveLength(1);
  });

  it('claims stop at the segment end', () => {
    const segs = new Segments(10, 1);
    expect(segs.claim(0, 6)).toEqual({ offset: 0, take: 6 });
    expect(segs.claim(0, 6)).toEqual({ offset: 6, take: 4 });
    expect(segs.claim(0, 6).take).toBe(0);
    expect(segs.complete()).toBe(true);
    expect(segs.written()).toBe(10);
  });

  it('an idle connection takes the back half of the largest range', () => {
    const segs = new Segments(16 * MB, 2);
    segs.claim(0, 8 * MB);
    segs.claim(1, 2 * MB);
    const tail = segs.nextWork()!;
    expect(segs.list[tail]).toMatchObject({ start: 13 * MB, end: 16 * MB });
    expect(segs.list[1]).toMatchObject({ pos: 10 * MB, end: 13 * MB });
    assertContiguous(segs, 16 * MB);
  });

  it('does not split small ranges', () => {
    const segs = new Segments(3 * MB, 1);
    segs.claim(0, 2 * MB);
    expect(segs.nextWork()).toBeNull();
  });

  it('orphans are adopted whole', () => {
    const segs = new Segments(4 * MB, 4);
    expect(segs.retire(2)).toBe(true);
    segs.claim(0, MB);
    expect(segs.nextWork()).toBe(2);
  });

  it('the last connection cannot retire', () => {
    const segs = new Segments(2 * MB, 2);
    expect(segs.retire(0)).toBe(true);
    expect(segs.retire(1)).toBe(false);
  });

  it('resumes only the missing ranges, and the checkpoint matches', () => {
    const segs = new Segments(16 * MB, 2);
    segs.claim(0, 3 * MB);
    segs.claim(1, 5 * MB);
    const missing = segs.missing();
    expect(missing).toEqual([
      [3 * MB, 8 * MB],
      [13 * MB, 16 * MB],
    ]);
    const again = Segments.resume(missing, 4);
    expect(again.missing()).toEqual(missing);
    expect(again.written()).toBe(0);
    // Two ranges, four connections: the spare ones split the largest.
    expect(again.nextWork()).not.toBeNull();
    expect(again.missing().reduce((n, [a, b]) => n + b - a, 0)).toBe(8 * MB);
  });

  it('resumed ranges beyond the connections wait as orphans', () => {
    const again = Segments.resume(
      [
        [0, MB],
        [2 * MB, 3 * MB],
        [4 * MB, 5 * MB],
      ],
      2,
    );
    expect(again.list.map((s) => s.orphan)).toEqual([false, false, true]);
    again.claim(0, MB);
    expect(again.nextWork()).toBe(2);
  });

  it('a finished resume is complete', () => {
    expect(Segments.resume([], 4).complete()).toBe(true);
  });

  /** Segments on a fake clock: `run(id, bytesPerSecond, ms)` fetches. */
  function timed(total: number, connections: number) {
    let t = 0;
    const segs = new Segments(total, connections, () => t);
    const run = (speeds: number[], ms: number) => {
      for (let step = 0; step < ms; step += 250) {
        t += 250;
        speeds.forEach((bps, id) => segs.claim(id, Math.floor(bps / 4)));
      }
    };
    return { segs, run };
  }

  it('an idle connection helps the range that will finish last, not the largest', () => {
    const { segs, run } = timed(64 * MB, 3);
    // 0 has just finished. 1 is fast with the most left; 2 crawls with less
    // left, but will finish last.
    const jump = (id: number, pos: number) => Object.assign(segs.get(id), { pos, sampledPos: pos });
    jump(0, segs.get(0).end - 1);
    jump(2, segs.get(2).end - 8 * MB);
    run([4, 8 * MB, MB], 1000);
    expect(segs.remaining(1)).toBeGreaterThan(segs.remaining(2));
    segs.get(0).pos = segs.get(0).end;
    const helper = segs.nextWork()!;
    expect(segs.get(helper).end).toBe(64 * MB);
    // The helper starts at about the others' speed, so it takes most of the slow tail.
    expect(segs.remaining(helper)).toBeGreaterThan(segs.remaining(2));
    assertContiguous(segs, 64 * MB);
  });

  it('spots a connection far slower than the others', () => {
    const { segs, run } = timed(64 * MB, 3);
    run([4 * MB, 4 * MB, MB / 2], 2000);
    expect(segs.straggler()).toBe(2);
  });

  it('no straggler when all are alike', () => {
    const { segs, run } = timed(64 * MB, 3);
    run([4 * MB, 3 * MB, 4 * MB], 2000);
    expect(segs.straggler()).toBeNull();
  });

  it('a connection added mid-download is counted in', () => {
    const segs = new Segments(16 * MB, 2);
    expect(segs.running).toBe(2);
    expect(segs.addWork()).not.toBeNull();
    expect(segs.running).toBe(3);
    assertContiguous(segs, 16 * MB);
  });

  it('a leaving connection and a retiring one never strand a segment', () => {
    const segs = new Segments(2 * MB, 2);
    segs.claim(0, MB);
    expect(segs.nextWork()).toBeNull();
    expect(segs.retire(1)).toBe(false);
  });
});
