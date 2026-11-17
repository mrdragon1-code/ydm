import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { boxes, encrypted, Fmp4Error, fragments, joinInit, numbered, shifted } from './fmp4';

const DASH = path.resolve(import.meta.dirname, '../e2e/fixtures/dash');
const read = (f: string) => new Uint8Array(readFileSync(path.join(DASH, f)));
const SEGMENTS = 8;

/** The whole joined file, as YDM writes it: init, then fragments by time. */
function join(): Uint8Array {
  const { init, timescales } = joinInit(read('init-0.m4s'), read('init-1.m4s'));
  const all = [];
  for (let i = 1; i <= SEGMENTS; i++) {
    all.push(...fragments(read(`chunk-0-${i}.m4s`), 1, timescales[0]));
    all.push(...fragments(read(`chunk-1-${i}.m4s`), 2, timescales[1]));
  }
  all.sort((a, b) => a.time - b.time);
  const parts = [init, ...all.map((f, i) => numbered(f.bytes, i + 1))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function u32(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint32(at);
}

describe('joining separate video and audio into one MP4', () => {
  it('one movie box with both tracks, numbered 1 and 2', () => {
    const file = join();
    const top = boxes(file);
    expect(top[0]!.type).toBe('ftyp');
    expect(top[1]!.type).toBe('moov');
    const moov = top[1]!;
    const inside = boxes(file, moov.body, moov.end);
    expect(inside.map((b) => b.type)).toEqual(['mvhd', 'trak', 'trak', 'mvex']);
    const ids = inside
      .filter((b) => b.type === 'trak')
      .map((trak) => {
        const tkhd = boxes(file, trak.body, trak.end).find((b) => b.type === 'tkhd')!;
        return u32(file, tkhd.body + (file[tkhd.body] === 1 ? 20 : 12));
      });
    expect(ids).toEqual([1, 2]);
    const mvex = inside.find((b) => b.type === 'mvex')!;
    expect(boxes(file, mvex.body, mvex.end).map((t) => u32(file, t.body + 4))).toEqual([1, 2]);
    // Next free track id, in the last field of mvhd.
    const mvhd = inside[0]!;
    expect(u32(file, mvhd.end - 4)).toBe(3);
  });

  it('every fragment kept, in time order, numbered 1, 2, 3, …; source indexes dropped', () => {
    const file = join();
    const top = boxes(file).slice(2);
    expect(new Set(top.map((b) => b.type))).toEqual(new Set(['moof', 'mdat']));
    const moofs = top.filter((b) => b.type === 'moof');
    expect(moofs).toHaveLength(SEGMENTS * 2);
    const tracks = moofs.map((moof) => {
      const traf = boxes(file, moof.body, moof.end).find((b) => b.type === 'traf')!;
      const tfhd = boxes(file, traf.body, traf.end).find((b) => b.type === 'tfhd')!;
      return u32(file, tfhd.body + 4);
    });
    expect(tracks.filter((t) => t === 1)).toHaveLength(SEGMENTS);
    expect(tracks.filter((t) => t === 2)).toHaveLength(SEGMENTS);
    const sequences = moofs.map((moof) => {
      const mfhd = boxes(file, moof.body, moof.end).find((b) => b.type === 'mfhd')!;
      return u32(file, mfhd.body + 4);
    });
    expect(sequences).toEqual(Array.from({ length: SEGMENTS * 2 }, (_, i) => i + 1));
  });

  it('a fragment pointing at absolute file offsets is refused, not misplaced', () => {
    const segment = read('chunk-0-1.m4s');
    const moof = boxes(segment).find((b) => b.type === 'moof')!;
    const traf = boxes(segment, moof.body, moof.end).find((b) => b.type === 'traf')!;
    const tfhd = boxes(segment, traf.body, traf.end).find((b) => b.type === 'tfhd')!;
    // Turn on base-data-offset-present.
    segment[tfhd.body + 3] = segment[tfhd.body + 3]! | 0x01;
    expect(() => fragments(segment, 1, 15360)).toThrow(Fmp4Error);
  });

  it('broken input is an error, not a crash', () => {
    expect(() => joinInit(new Uint8Array(10), read('init-1.m4s'))).toThrow(Fmp4Error);
    expect(() => boxes(new Uint8Array([0, 0, 0, 99, 0x6d, 0x6f, 0x6f, 0x76]))).toThrow(Fmp4Error);
  });
});

describe('real-world fragments', () => {
  const fragment = () => {
    const segment = read('chunk-1-2.m4s');
    const top = boxes(segment);
    const moof = top.find((b) => b.type === 'moof')!;
    const mdat = top.find((b) => b.type === 'mdat')!;
    return { segment, moof, mdat };
  };

  it('boxes between moof and mdat stay, so sample offsets still point right', () => {
    const { segment, moof, mdat } = fragment();
    const free = new Uint8Array([0, 0, 0, 12, 0x66, 0x72, 0x65, 0x65, 1, 2, 3, 4]);
    const withFree = new Uint8Array([...segment.subarray(moof.start, moof.end), ...free, ...segment.subarray(mdat.start, mdat.end)]);
    const [f] = fragments(withFree, 2, 44100);
    expect(f!.bytes.byteLength).toBe(withFree.byteLength);
    expect(boxes(f!.bytes).map((b) => b.type)).toEqual(['moof', 'free', 'mdat']);
  });

  it('without a tfdt, time runs on from the sample durations', () => {
    const { segment, moof, mdat } = fragment();
    const bytes = segment.slice(moof.start, mdat.end);
    // Rename tfdt to "skip": as if the fragment had none.
    const at = Buffer.from(bytes).indexOf('tfdt', 0, 'latin1');
    bytes.set([0x73, 0x6b, 0x69, 0x70], at);
    const clock = { next: 5 };
    const [first] = fragments(bytes, 2, 44100, clock);
    expect(first!.time).toBe(5);
    expect(clock.next).toBeGreaterThan(5.9);
    expect(clock.next).toBeLessThan(6.1);
  });

  it('encrypted (DRM) init sections are recognized', () => {
    const plain = read('init-0.m4s');
    expect(encrypted(plain)).toBe(false);
    const drm = plain.slice();
    const at = Buffer.from(drm).indexOf('avc1', 0, 'latin1');
    drm.set([0x65, 0x6e, 0x63, 0x76], at); // avc1 → encv
    expect(encrypted(drm)).toBe(true);
    expect(() => joinInit(drm, read('init-1.m4s'))).toThrow(Fmp4Error);
  });

  it('both tracks moved to start at 0, keeping the gap between them', () => {
    const { segment } = fragment();
    const [f] = fragments(segment, 2, 44100);
    const before = f!.time;
    const moved = shifted(f!, 0.5, 44100);
    expect(moved.time).toBeCloseTo(before - 0.5, 3);
    const [again] = fragments(moved.bytes, 2, 44100);
    expect(again!.time).toBeCloseTo(before - 0.5, 3);
  });
});
