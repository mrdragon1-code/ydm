/**
 * One streamed video (HLS or DASH), in its own worker. Speaks the same
 * protocol as download-worker.ts, so the queue, pause, resume, security
 * checks and saving work unchanged.
 *
 * A stream is one or two tracks (video with its audio inside, or video
 * and audio apart), each a list of segments. Segments are fetched a few
 * at a time and appended in order to the track's file; checkpoints let a
 * closed browser resume at the next segment, and only for the very same
 * stream. AES-128 (HLS) is decrypted with WebCrypto.
 *
 * At the end the video becomes one MP4, without re-encoding:
 * - fragmented MP4 tracks already are MP4 (their init section first);
 * - MPEG-TS tracks are converted by mux.js;
 * - two tracks are joined by lib/fmp4.ts, a fragment at a time.
 *
 * Protected (DRM) and live streams are refused, never worked around.
 */

// mux.js has no types; only its MP4 transmuxer is used.
// @ts-expect-error untyped package
import muxjs from 'mux.js';
import { parseMpd } from './dash';
import { encrypted, Fmp4Error, fragments, joinInit, numbered, shifted } from './fmp4';
import type { Text } from './i18n';
import { type Key, type Playlist, parsePlaylist, sequenceIv } from './media';
import { fromUrl, sanitize } from './naming';
import type { WorkerCommand, WorkerEvent } from './protocol';

/** Segments fetched at once: enough to fill a fast line with ~2-6 s pieces. */
const PARALLEL = 4;
const RETRIES = 4;
const PROGRESS_MS = 500;
/** At most this much transfer is redone after the browser is closed. */
const CHECKPOINT_MS = 2000;
/** How long to wait for the Referer rule of the stream's other hosts. */
const ORIGINS_WAIT_MS = 2000;

interface SyncAccessHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(data: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> };
const scope = self as unknown as {
  postMessage(msg: WorkerEvent): void;
  onmessage: ((e: MessageEvent<WorkerCommand>) => void) | null;
};

class Fail extends Error {
  constructor(
    readonly text: Text,
    readonly retryInBrowser = false,
  ) {
    super(text.key);
  }
}
const CANCELLED = new Fail({ key: 'reason.cancelled' });
/** Stops every fetch still running when the download ends, for any reason. */
const STOPPED = new Fail({ key: 'reason.cancelled' });
const abort = new AbortController();
let proceed: (() => void) | null = null;

scope.onmessage = (e) => {
  const cmd = e.data;
  if (cmd.type === 'start') void run(cmd);
  else if (cmd.type === 'cancel') abort.abort(CANCELLED);
  else if (cmd.type === 'proceed') proceed?.();
  // Speed limit and connection budget: not applied to streams yet.
};

// --- what to fetch -------------------------------------------------------------

interface Range {
  offset: number;
  length: number;
}

interface Part {
  url: string;
  range?: Range;
  /** HLS: how the segment is encrypted, and its sequence number for the IV. */
  key?: Key;
  sequence: number;
}

interface TrackPlan {
  /** fMP4: the init section, fetched first; null if the file has its own. */
  init: { url: string; range?: Range } | null;
  parts: Part[];
  format: 'fmp4' | 'ts';
}

interface Plan {
  tracks: TrackPlan[];
  /** The address after redirects, for the name and the checks. */
  url: string;
}

type Media = Extract<Playlist, { type: 'media' }>;

async function planFor(url: string, kind: 'hls' | 'dash'): Promise<Plan> {
  if (kind === 'dash') {
    const res = await request(url);
    const mpd = parseMpd(await res.text(), res.url || url);
    if (!mpd.ok) {
      const key = { drm: 'protected', live: 'live', webm: 'webm', multiPeriod: 'notSupported', codec: 'notSupported', unreadable: 'notVideo' }[mpd.reason];
      throw new Fail({ key: `reason.${key}` });
    }
    const track = (t: typeof mpd.video): TrackPlan => ({
      init: t.init,
      parts: t.segments.map((p, i) => ({ ...p, sequence: i })),
      format: 'fmp4',
    });
    return { tracks: [track(mpd.video), ...(mpd.audio ? [track(mpd.audio)] : [])], url: res.url || url };
  }
  const first = await playlist(url);
  if (first.playlist.type === 'media') return { tracks: [hlsTrack(first.playlist)], url: first.url };
  const best = first.playlist.variants[0];
  if (!best) throw new Fail({ key: 'reason.notVideo' });
  const video = await playlist(best.url);
  if (video.playlist.type !== 'media') throw new Fail({ key: 'reason.notVideo' });
  const tracks = [hlsTrack(video.playlist)];
  // Audio apart from the video (as on X): fetched as a second track.
  if (best.audio) {
    const audio = await playlist(best.audio);
    if (audio.playlist.type !== 'media') throw new Fail({ key: 'reason.notVideo' });
    tracks.push(hlsTrack(audio.playlist));
  }
  return { tracks, url: video.url };
}

async function playlist(url: string): Promise<{ playlist: Playlist; url: string }> {
  const res = await request(url);
  let p: Playlist;
  try {
    p = parsePlaylist(await res.text(), res.url || url);
  } catch {
    throw new Fail({ key: 'reason.notVideo' });
  }
  if (p.drm) throw new Fail({ key: 'reason.protected' });
  if (p.type === 'media') {
    if (!p.ended) throw new Fail({ key: 'reason.live' });
    if (!p.segments.length) throw new Fail({ key: 'reason.notVideo' });
  }
  return { playlist: p, url: res.url || url };
}

function hlsTrack(p: Media): TrackPlan {
  return {
    init: p.map ?? null,
    parts: p.segments.map((s) => ({ url: s.url, range: s.range, key: s.key, sequence: s.sequence })),
    format: p.map ? 'fmp4' : 'ts',
  };
}

/** What makes a resume safe: the same segments, in the same formats. */
function fingerprint(plan: Plan): string {
  return plan.tracks.map((t) => `${t.format}:${t.parts.length}:${t.parts[0]!.url}:${t.parts.at(-1)!.url}`).join('|');
}

// --- the download ----------------------------------------------------------------

interface TrackState {
  next: number;
  bytes: number;
  /** Bytes of the init section at the start of the file. */
  init: number;
  sizes: number[];
}

async function run(cmd: Extract<WorkerCommand, { type: 'start' }>) {
  let result: WorkerEvent;
  const handles: SyncAccessHandle[] = [];
  let ticker: ReturnType<typeof setInterval> | undefined;
  /** Saves what is on disk now: on a pause, nothing fetched is lost. */
  let saveNow: (() => void) | null = null;
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ydm', { create: true });
    const open = async (name: string) => {
      const h = await ((await dir.getFileHandle(name, { create: true })) as SyncFileHandle).createSyncAccessHandle();
      handles.push(h);
      return h;
    };

    const plan = await planFor(cmd.url, cmd.kind === 'dash' ? 'dash' : 'hls');
    const name = sanitize(cmd.name || `${fromUrl(plan.url)?.replace(/\.(m3u8|mpd)$/i, '') || 'video'}.mp4`);
    scope.postMessage({ type: 'started', name, total: null, url: plan.url });
    await originsReady(plan);

    const out = await open(cmd.file);
    // One fMP4 track is written straight into the final file.
    const direct = plan.tracks.length === 1 && plan.tracks[0]!.format === 'fmp4';
    const raws = direct ? [out] : await Promise.all(plan.tracks.map((_, i) => open(`${cmd.file}.t${i}`)));
    const validator = fingerprint(plan);

    // Resumed only if the checkpoint is for this very stream and agrees
    // with itself and with what is on disk; otherwise from the start.
    const saved = cmd.resume?.validator === validator ? cmd.resume.stream?.tracks : undefined;
    const states: TrackState[] = plan.tracks.map((t, i) => {
      const s = saved?.[i];
      const ok =
        s &&
        s.next <= t.parts.length &&
        s.sizes.length === s.next &&
        s.sizes.reduce((n, x) => n + x, 0) + s.init === s.bytes &&
        raws[i]!.getSize() >= s.bytes;
      return ok ? { next: s.next, bytes: s.bytes, init: s.init, sizes: s.sizes.slice() } : { next: 0, bytes: 0, init: 0, sizes: [] };
    });
    states.forEach((s, i) => raws[i]!.truncate(s.bytes));
    saveNow = () => {
      for (const r of raws) r.flush();
      checkpoint(validator, states);
    };

    const totalParts = plan.tracks.reduce((n, t) => n + t.parts.length, 0);
    let finishing = false;
    let finished = 0;
    let finishTotal = 0;
    ticker = setInterval(() => {
      if (finishing) return scope.postMessage({ type: 'progress', done: finished, total: finishTotal });
      const done = states.reduce((n, s) => n + s.bytes, 0);
      const parts = states.reduce((n, s) => n + s.next, 0);
      // Total unknown until the end: estimated from the segments so far.
      const total = parts > 0 ? Math.round((done / parts) * totalParts) : null;
      scope.postMessage({ type: 'progress', done, total: total && Math.max(total, done) });
    }, PROGRESS_MS);

    for (let i = 0; i < plan.tracks.length; i++) {
      await download(plan.tracks[i]!, states[i]!, raws[i]!, () => checkpoint(validator, states));
    }
    saveNow();

    finishing = true;
    let size: number;
    if (direct) {
      // A file with its own init section, checked only now.
      if (encrypted(read(out, 0, initEnd(out)))) throw new Fail({ key: 'reason.protected' });
      size = states[0]!.bytes;
    } else if (plan.tracks.length === 1) {
      finishTotal = states[0]!.bytes;
      size = await convert(raws[0]!, out, states[0]!.sizes, (n) => (finished = n));
    } else {
      // Each track as fMP4, then the two joined.
      const mp4s: SyncAccessHandle[] = [];
      finishTotal = states.reduce((n, s) => n + s.bytes, 0) * 2;
      for (let i = 0; i < 2; i++) {
        if (plan.tracks[i]!.format === 'fmp4') {
          mp4s.push(raws[i]!);
        } else {
          const mp4 = await open(`${cmd.file}.f${i}`);
          const base = finished;
          // Original timestamps: the gap between video and audio is kept,
          // and both are moved to start at 0 when joined.
          await convert(raws[i]!, mp4, states[i]!.sizes, (n) => (finished = base + n), true);
          mp4s.push(mp4);
        }
      }
      finished = finishTotal / 2;
      size = await join(mp4s[0]!, mp4s[1]!, out, (n) => (finished = finishTotal / 2 + n));
      for (const h of [...raws, ...mp4s]) if (h !== out) h.truncate(0);
    }
    out.flush();
    result = { type: 'done', name, size };
  } catch (e) {
    const fail =
      abort.signal.aborted ? (abort.signal.reason as Fail)
      : e instanceof Fail ? e
      : e instanceof Fmp4Error ? new Fail({ key: e.message === 'encrypted' ? 'reason.protected' : 'reason.notSupported' })
      : new Fail({ key: 'reason.network' }, true);
    if (fail === CANCELLED) saveNow?.();
    result = fail === CANCELLED ? { type: 'cancelled' } : { type: 'failed', reason: fail.text, retryInBrowser: fail.retryInBrowser };
  } finally {
    clearInterval(ticker);
    // Segments still being fetched after a failure stop now.
    if (!abort.signal.aborted) abort.abort(STOPPED);
    for (const h of handles) h.close();
  }
  scope.postMessage(result);
}

/** One track's segments, in order, after its init section. */
async function download(track: TrackPlan, state: TrackState, raw: SyncAccessHandle, save: () => void) {
  if (track.init && state.next === 0 && state.bytes === 0) {
    const init = await fetchBytes(track.init.url, track.init.range);
    // Encrypted (DRM) tracks are refused before anything else is fetched.
    if (track.format === 'fmp4' && encrypted(init)) throw new Fail({ key: 'reason.protected' });
    write(raw, init, 0);
    state.bytes = state.init = init.byteLength;
  }
  const count = track.parts.length;
  // One file for the whole track (DASH with one file per track): it may be
  // gigabytes, so it is written as it arrives, not held in memory. Resumed
  // from its start if interrupted.
  if (count === 1 && state.next === 0 && track.parts[0]!.key?.method !== 'AES-128') {
    const part = track.parts[0]!;
    const res = await request(part.url, part.range);
    if (!res.body) throw new Fail({ key: 'reason.notVideo' });
    const reader = res.body.getReader();
    const start = state.bytes;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      write(raw, value, state.bytes);
      state.bytes += value.byteLength;
    }
    state.sizes.push(state.bytes - start);
    state.next = 1;
    raw.flush();
    save();
    return;
  }
  const keys = new Map<string, Promise<CryptoKey>>();
  const pending = new Map<number, Promise<Uint8Array>>();
  const fetchPart = (i: number) => {
    const part = track.parts[i]!;
    const p = fetchBytes(part.url, part.range).then((data) => decrypt(data, part, keys));
    // A failure is handled when its turn comes; until then it must not
    // count as unhandled.
    p.catch(() => {});
    pending.set(i, p);
  };
  for (let i = state.next; i < Math.min(count, state.next + PARALLEL); i++) fetchPart(i);
  let saved = Date.now();
  while (state.next < count) {
    const data = await pending.get(state.next)!;
    pending.delete(state.next);
    if (state.next + PARALLEL < count) fetchPart(state.next + PARALLEL);
    write(raw, data, state.bytes);
    state.bytes += data.byteLength;
    state.sizes.push(data.byteLength);
    state.next++;
    if (Date.now() - saved >= CHECKPOINT_MS) {
      raw.flush();
      save();
      saved = Date.now();
    }
  }
}

function checkpoint(validator: string, states: TrackState[]) {
  // `missing` belongs to ranged files; a stream resumes by segment.
  const tracks = states.map((s) => ({ next: s.next, bytes: s.bytes, init: s.init, sizes: s.sizes.slice() }));
  scope.postMessage({ type: 'checkpoint', checkpoint: { total: 0, validator, missing: [], stream: { tracks } } });
}

/** The hosts the stream's pieces come from get the page's Referer, as the
 * page's player sends it: the background adds them, then says go. */
function originsReady(plan: Plan): Promise<void> {
  const byHost = new Map<string, string>();
  const urls = [plan.url, ...plan.tracks.flatMap((t) => [t.init?.url, ...t.parts.map((p) => p.url), ...t.parts.map((p) => p.key?.uri)])];
  for (const u of urls) {
    if (!u) continue;
    try {
      const host = new URL(u).hostname;
      if (!byHost.has(host)) byHost.set(host, u);
    } catch {
      // Not a URL: its fetch fails later with a clear reason.
    }
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ORIGINS_WAIT_MS);
    proceed = () => {
      clearTimeout(timer);
      proceed = null;
      resolve();
    };
    scope.postMessage({ type: 'origins', urls: [...byHost.values()] });
  });
}

// --- network -----------------------------------------------------------------------

async function request(url: string, range?: Range): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (abort.signal.aborted) throw abort.signal.reason;
    try {
      const res = await fetch(url, {
        credentials: 'include',
        signal: abort.signal,
        headers: range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined,
      });
      if (res.ok) return res;
      if (res.status === 401 || res.status === 403) throw new Fail({ key: 'reason.forbidden', params: { status: res.status } });
      if (res.status === 404 || res.status === 410) throw new Fail({ key: 'reason.notFound', params: { status: res.status } });
      last = new Fail({ key: res.status >= 500 ? 'reason.serverError' : 'reason.unexpected', params: { status: res.status } }, true);
    } catch (e) {
      if (abort.signal.aborted) throw abort.signal.reason;
      if (e instanceof Fail) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw last instanceof Fail ? last : new Fail({ key: 'reason.network' }, true);
}

async function fetchBytes(url: string, range?: Range): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await (await request(url, range)).arrayBuffer());
}

async function decrypt(data: Uint8Array<ArrayBuffer>, part: Part, keys: Map<string, Promise<CryptoKey>>): Promise<Uint8Array> {
  if (part.key?.method !== 'AES-128') return data;
  if (!part.key.uri) throw new Fail({ key: 'reason.protected' });
  const key = keyFor(part.key, keys);
  const iv = part.key.iv ?? sequenceIv(part.sequence);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await key, data));
  } catch {
    throw new Fail({ key: 'reason.decrypt' });
  }
}

function keyFor(key: Key, keys: Map<string, Promise<CryptoKey>>): Promise<CryptoKey> {
  let found = keys.get(key.uri!);
  if (!found) {
    found = fetchBytes(key.uri!).then((raw) => {
      if (raw.byteLength !== 16) throw new Fail({ key: 'reason.decrypt' });
      return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    });
    keys.set(key.uri!, found);
  }
  return found;
}

// --- files ---------------------------------------------------------------------------

function write(h: SyncAccessHandle, data: Uint8Array, at: number) {
  for (let off = 0; off < data.byteLength; ) {
    let n: number;
    try {
      n = h.write(data.subarray(off), { at: at + off });
    } catch (e) {
      throw new Fail({ key: 'reason.diskWrite', params: { detail: (e as Error).message } });
    }
    if (n <= 0) throw new Fail({ key: 'reason.diskWrite', params: { detail: 'write returned 0' } });
    off += n;
  }
}

function read(h: SyncAccessHandle, at: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (length && h.read(out, { at }) !== length) throw new Fmp4Error('short read');
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** MPEG-TS → MP4 without re-encoding, a segment at a time, yielding between
 * segments so that pause and progress still work; the TS is then deleted.
 * Returns the MP4's size. */
async function convert(
  raw: SyncAccessHandle,
  out: SyncAccessHandle,
  sizes: number[],
  progress: (bytes: number) => void,
  keepOriginalTimestamps = false,
): Promise<number> {
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps });
  let at = 0;
  let wroteInit = false;
  let produced = 0;
  transmuxer.on('data', (segment: { initSegment: Uint8Array; data: Uint8Array }) => {
    if (!wroteInit) {
      write(out, segment.initSegment, at);
      at += segment.initSegment.byteLength;
      wroteInit = true;
    }
    write(out, segment.data, at);
    at += segment.data.byteLength;
    produced++;
  });
  try {
    out.truncate(0);
    let offset = 0;
    for (const size of sizes) {
      if (abort.signal.aborted) throw abort.signal.reason;
      const chunk = read(raw, offset, size);
      offset += size;
      transmuxer.push(chunk);
      transmuxer.flush();
      progress(offset);
      await tick();
    }
  } finally {
    transmuxer.dispose?.();
  }
  // Nearly every segment must give video: otherwise the stream is not one
  // mux.js can convert (an unknown codec), and the file would be useless.
  if (!wroteInit || produced < Math.ceil(sizes.length / 2)) throw new Fail({ key: 'reason.notVideo' });
  out.flush();
  raw.truncate(0);
  return at;
}

/** A top-level box header read from a file: type, start, size. */
function header(h: SyncAccessHandle, at: number, end: number): { type: string; size: number } | null {
  if (at + 8 > end) return null;
  const head = read(h, at, Math.min(16, end - at));
  const v = new DataView(head.buffer);
  let size = v.getUint32(0);
  if (size === 1) {
    // A 64-bit size follows the type: it needs the full 16 bytes.
    if (head.byteLength < 16) throw new Fmp4Error('truncated box');
    size = Number(v.getBigUint64(8));
    if (size < 16) throw new Fmp4Error('truncated box');
  } else if (size === 0) {
    size = end - at;
  }
  if (size < 8 || at + size > end) throw new Fmp4Error('truncated box');
  return { type: String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!), size };
}

/** A fragmented MP4 file read one fragment (moof + mdat) at a time. */
function* fragmentsOf(h: SyncAccessHandle, from: number): Generator<Uint8Array> {
  const end = h.getSize();
  for (let at = from; ; ) {
    const box = header(h, at, end);
    if (!box) return;
    if (box.type === 'moof') {
      // Up to its mdat; boxes in between (emsg, prft, free) come along, as
      // sample offsets count from the moof.
      let length = box.size;
      for (;;) {
        const nextBox = header(h, at + length, end);
        if (!nextBox || nextBox.type === 'moof') throw new Fmp4Error('moof without its mdat');
        length += nextBox.size;
        if (nextBox.type === 'mdat') break;
      }
      yield read(h, at, length);
      at += length;
    } else {
      // styp, sidx, emsg, free: about the source file, not needed.
      at += box.size;
    }
  }
}

/** Where the first fragment starts: everything before is the init section. */
function initEnd(h: SyncAccessHandle): number {
  const end = h.getSize();
  for (let at = 0; ; ) {
    const box = header(h, at, end);
    if (!box) throw new Fmp4Error('no fragments');
    if (box.type === 'moof') return at;
    at += box.size;
  }
}

/** The video and audio files joined into `out`, fragments interleaved by
 * time; memory holds one fragment per track. Returns the size. */
async function join(video: SyncAccessHandle, audio: SyncAccessHandle, out: SyncAccessHandle, progress: (bytes: number) => void): Promise<number> {
  const vStart = initEnd(video);
  const aStart = initEnd(audio);
  const { init, timescales } = joinInit(read(video, 0, vStart), read(audio, 0, aStart));
  out.truncate(0);
  write(out, init, 0);
  let at = init.byteLength;
  const next = (it: Generator<Uint8Array>, track: 1 | 2) => {
    const r = it.next();
    return r.done ? null : fragments(r.value, track, timescales[track - 1]!);
  };
  const vIt = fragmentsOf(video, vStart);
  const aIt = fragmentsOf(audio, aStart);
  let vQueue = next(vIt, 1) ?? [];
  let aQueue = next(aIt, 2) ?? [];
  // Both tracks moved to start at 0 together: the earlier one at 0, the
  // other keeping its distance from it.
  const offset = Math.min(vQueue[0]?.time ?? 0, aQueue[0]?.time ?? 0);
  let sequence = 1;
  let written = 0;
  while (vQueue.length || aQueue.length) {
    if (abort.signal.aborted) throw abort.signal.reason;
    const takeVideo = !aQueue.length || (vQueue.length > 0 && vQueue[0]!.time <= aQueue[0]!.time);
    const queue = takeVideo ? vQueue : aQueue;
    const f = shifted(queue.shift()!, offset, timescales[takeVideo ? 0 : 1]!);
    write(out, numbered(f.bytes, sequence++), at);
    at += f.bytes.byteLength;
    written += f.bytes.byteLength;
    if (!vQueue.length) vQueue = next(vIt, 1) ?? [];
    if (!aQueue.length) aQueue = next(aIt, 2) ?? [];
    progress(written);
    if (sequence % 50 === 0) await tick();
  }
  return at;
}
