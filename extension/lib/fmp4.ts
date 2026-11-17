/**
 * Joining a video-only and an audio-only fragmented MP4 into one file,
 * without re-encoding: what DASH and HLS with separate audio deliver.
 *
 * - The two init sections become one: the video's movie box with the
 *   audio's track added as track 2 (and its defaults in mvex).
 * - Each fragment (moof + mdat) is copied whole; the audio's track id is
 *   rewritten in place and sequence numbers run on. Sample data offsets
 *   are relative to their own moof (default-base-is-moof), so fragments
 *   can move freely; a stream that uses absolute offsets is refused.
 * - Fragments of the two tracks are interleaved by start time.
 * - styp, sidx and other per-segment boxes are dropped: they index the
 *   source files, not the joined one.
 */

export class Fmp4Error extends Error {}

export interface Box {
  type: string;
  /** Offset of the box's first byte (its size field). */
  start: number;
  /** Offset just past the box. */
  end: number;
  /** Offset of the content, after size, type (and large size). */
  body: number;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

/** The boxes directly inside `[start, end)`. */
export function boxes(b: Uint8Array, start = 0, end = b.length): Box[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  for (let at = start; at + 8 <= end; ) {
    let size = view.getUint32(at);
    let body = at + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      body += 8;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < 8 || at + size > end) throw new Fmp4Error('truncated box');
    out.push({ type: String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!), start: at, end: at + size, body });
    at += size;
  }
  return out;
}

function child(b: Uint8Array, parent: Box, type: string): Box | undefined {
  return boxes(b, parent.body, parent.end).find((x) => x.type === type);
}

function need(box: Box | undefined, what: string): Box {
  if (!box) throw new Fmp4Error(`missing ${what}`);
  return box;
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** A box with new content: header rebuilt for the new size. */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  view(out).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** tkhd's track id: after version/flags, times (32 or 64 bit). */
function setTkhdTrack(b: Uint8Array, tkhd: Box, id: number) {
  const v = b[tkhd.body]!;
  view(b).setUint32(tkhd.body + (v === 1 ? 20 : 12), id);
}

/** A track's timescale, from its media header. */
function timescaleOf(b: Uint8Array, trak: Box): number {
  const mdhd = need(child(b, need(child(b, trak, 'mdia'), 'mdia'), 'mdhd'), 'mdhd');
  const v = b[mdhd.body]!;
  return view(b).getUint32(mdhd.body + (v === 1 ? 20 : 12));
}

/** Sample entries and boxes of encrypted (DRM) tracks: such a file
 * cannot be played without a licence, so it is refused, never saved. */
const ENCRYPTED = ['encv', 'enca', 'sinf', 'pssh'];

export function encrypted(init: Uint8Array): boolean {
  // The names are looked for anywhere in the init section: they only ever
  // appear there as box types.
  const text = new TextDecoder('latin1').decode(init.subarray(0, Math.min(init.length, 1 << 20)));
  return ENCRYPTED.some((name) => text.includes(name));
}

/** A movie header's timescale. */
function movieTimescale(b: Uint8Array, mvhd: Box): number {
  const v = b[mvhd.body]!;
  return view(b).getUint32(mvhd.body + (v === 1 ? 20 : 12));
}

/** An edit list's durations are in the movie's timescale: moved to the
 * joined movie's, so the audio's start offset (encoder delay) is kept. */
function rescaleEdits(trak: Uint8Array, from: number, to: number) {
  if (from === to || !from) return;
  const top = boxes(trak)[0]!;
  const edts = child(trak, top, 'edts');
  const elst = edts && child(trak, edts, 'elst');
  if (!elst) return;
  const v = trak[elst.body]!;
  const count = view(trak).getUint32(elst.body + 4);
  const entry = v === 1 ? 20 : 12;
  for (let i = 0; i < count; i++) {
    const at = elst.body + 8 + i * entry;
    if (v === 1) {
      const d = Number(view(trak).getBigUint64(at));
      view(trak).setBigUint64(at, BigInt(Math.round((d * to) / from)));
    } else {
      const d = view(trak).getUint32(at);
      view(trak).setUint32(at, Math.round((d * to) / from));
    }
  }
}

export interface Joined {
  /** ftyp + the combined moov: the start of the output file. */
  init: Uint8Array;
  /** Timescales of track 1 (video) and track 2 (audio). */
  timescales: [number, number];
}

/** The init section of the joined file, from the two inputs' init sections. */
export function joinInit(video: Uint8Array, audio: Uint8Array): Joined {
  if (encrypted(video) || encrypted(audio)) throw new Fmp4Error('encrypted');
  const vTop = boxes(video);
  const aTop = boxes(audio);
  const ftyp = need(vTop.find((x) => x.type === 'ftyp'), 'ftyp');
  const vMoov = need(vTop.find((x) => x.type === 'moov'), 'video moov');
  const aMoov = need(aTop.find((x) => x.type === 'moov'), 'audio moov');
  const vTraks = boxes(video, vMoov.body, vMoov.end).filter((x) => x.type === 'trak');
  const aTraks = boxes(audio, aMoov.body, aMoov.end).filter((x) => x.type === 'trak');
  if (vTraks.length !== 1 || aTraks.length !== 1) throw new Fmp4Error('expected one track in each input');
  const vMvex = need(child(video, vMoov, 'mvex'), 'video mvex');
  const aMvex = need(child(audio, aMoov, 'mvex'), 'audio mvex');
  const vTrex = need(child(video, vMvex, 'trex'), 'video trex');
  const aTrex = need(child(audio, aMvex, 'trex'), 'audio trex');

  // Copies, renumbered: video is track 1, audio track 2.
  const vTrak = video.slice(vTraks[0]!.start, vTraks[0]!.end);
  setTkhdTrack(vTrak, need(child(vTrak, boxes(vTrak)[0]!, 'tkhd'), 'tkhd'), 1);
  const aTrak = audio.slice(aTraks[0]!.start, aTraks[0]!.end);
  setTkhdTrack(aTrak, need(child(aTrak, boxes(aTrak)[0]!, 'tkhd'), 'tkhd'), 2);
  rescaleEdits(
    aTrak,
    movieTimescale(audio, need(child(audio, aMoov, 'mvhd'), 'audio mvhd')),
    movieTimescale(video, need(child(video, vMoov, 'mvhd'), 'mvhd')),
  );
  const vTrexCopy = video.slice(vTrex.start, vTrex.end);
  view(vTrexCopy).setUint32(12, 1);
  const aTrexCopy = audio.slice(aTrex.start, aTrex.end);
  view(aTrexCopy).setUint32(12, 2);

  // The video's movie header, now announcing three as the next track id.
  const mvhdBox = need(child(video, vMoov, 'mvhd'), 'mvhd');
  const mvhd = video.slice(mvhdBox.start, mvhdBox.end);
  view(mvhd).setUint32(mvhd.byteLength - 4, 3);

  const init = new Uint8Array([
    ...video.slice(ftyp.start, ftyp.end),
    ...box('moov', mvhd, vTrak, aTrak, box('mvex', vTrexCopy, aTrexCopy)),
  ]);
  return {
    init,
    timescales: [timescaleOf(video, vTraks[0]!), timescaleOf(audio, aTraks[0]!)],
  };
}

/** One moof + mdat pair, ready to be written. */
export interface Fragment {
  bytes: Uint8Array;
  /** Start time in seconds, for interleaving the two tracks. */
  time: number;
}

/** Where a track's next fragment starts, for fragments without a tfdt. */
export interface Clock {
  next: number;
}

/** Total duration of a fragment's samples, in the track's timescale; null
 * if the durations are only in the init section's defaults. */
function duration(b: Uint8Array, traf: Box, tfhd: Box): number | null {
  const v = view(b);
  const tfFlags = v.getUint32(tfhd.body) & 0xffffff;
  // tfhd: version/flags, track id, then the optional fields in order.
  let at = tfhd.body + 8;
  if (tfFlags & 0x01) at += 8;
  if (tfFlags & 0x02) at += 4;
  const fallback = tfFlags & 0x08 ? v.getUint32(at) : null;
  let total = 0;
  for (const trun of boxes(b, traf.body, traf.end).filter((x) => x.type === 'trun')) {
    const flags = v.getUint32(trun.body) & 0xffffff;
    const count = v.getUint32(trun.body + 4);
    let p = trun.body + 8;
    if (flags & 0x001) p += 4;
    if (flags & 0x004) p += 4;
    if (!(flags & 0x100)) {
      if (fallback === null) return null;
      total += fallback * count;
      continue;
    }
    const step = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4;
    for (let i = 0; i < count; i++) total += v.getUint32(p + i * step);
  }
  return total;
}

/**
 * The fragments of one input segment (it may hold several), with `track`
 * as their track id. Their sequence numbers are set when written, by
 * {@link numbered}. `clock` carries the time on for fragments without a
 * tfdt.
 */
export function fragments(segment: Uint8Array, track: 1 | 2, timescale: number, clock: Clock = { next: 0 }): Fragment[] {
  const top = boxes(segment);
  const out: Fragment[] = [];
  for (let i = 0; i < top.length; i++) {
    const moof = top[i]!;
    if (moof.type !== 'moof') continue;
    // Boxes between moof and mdat (emsg, prft, free) are kept: sample
    // offsets count from the moof, so the bytes between must stay.
    let j = i + 1;
    while (top[j] && top[j]!.type !== 'mdat' && top[j]!.type !== 'moof') j++;
    const mdat = top[j];
    if (mdat?.type !== 'mdat') throw new Fmp4Error('moof without its mdat');
    const bytes = segment.slice(moof.start, mdat.end);
    const copy = boxes(bytes)[0]!;
    const traf = boxes(bytes, copy.body, copy.end).filter((x) => x.type === 'traf');
    if (traf.length !== 1) throw new Fmp4Error('expected one track per fragment');
    const tfhd = need(child(bytes, traf[0]!, 'tfhd'), 'tfhd');
    const flags = view(bytes).getUint32(tfhd.body) & 0xffffff;
    // Absolute data offsets would point into the source file.
    if (flags & 0x000001) throw new Fmp4Error('absolute base data offset');
    view(bytes).setUint32(tfhd.body + 4, track);
    const tfdt = child(bytes, traf[0]!, 'tfdt');
    const length = duration(bytes, traf[0]!, tfhd);
    let time = clock.next;
    if (tfdt) {
      const v = bytes[tfdt.body]!;
      time = (v === 1 ? Number(view(bytes).getBigUint64(tfdt.body + 4)) : view(bytes).getUint32(tfdt.body + 4)) / timescale;
    }
    clock.next = time + (length ?? 0) / timescale;
    out.push({ bytes, time });
    i = j;
  }
  return out;
}

/** Moves a fragment's start time earlier by `seconds` (in place): both
 * tracks then begin at 0, keeping the gap between them. */
export function shifted(fragment: Fragment, seconds: number, timescale: number): Fragment {
  if (!seconds) return fragment;
  const b = fragment.bytes;
  const moof = boxes(b)[0]!;
  const traf = boxes(b, moof.body, moof.end).find((x) => x.type === 'traf');
  const tfdt = traf && child(b, traf, 'tfdt');
  if (tfdt) {
    const ticks = Math.round(seconds * timescale);
    const v = b[tfdt.body]!;
    if (v === 1) {
      const t = view(b).getBigUint64(tfdt.body + 4) - BigInt(ticks);
      view(b).setBigUint64(tfdt.body + 4, t < 0n ? 0n : t);
    } else {
      view(b).setUint32(tfdt.body + 4, Math.max(0, view(b).getUint32(tfdt.body + 4) - ticks));
    }
  }
  return { bytes: b, time: fragment.time - seconds };
}

/** Sets a fragment's sequence number (mfhd), in place. */
export function numbered(fragment: Uint8Array, sequence: number): Uint8Array {
  const moof = boxes(fragment)[0]!;
  const mfhd = need(child(fragment, moof, 'mfhd'), 'mfhd');
  view(fragment).setUint32(mfhd.body + 4, sequence);
  return fragment;
}
