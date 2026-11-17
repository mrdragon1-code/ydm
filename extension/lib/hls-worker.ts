/**
 * One HLS video, in its own worker. Speaks the same protocol as
 * download-worker.ts, so the queue, pause, resume, security checks and
 * saving work unchanged.
 *
 * The playlist's segments are fetched a few at a time and appended in
 * order; checkpoints let a closed browser resume at the next segment, and
 * only for the very same playlist. AES-128 segments are decrypted with
 * WebCrypto. At the end the video becomes one MP4: fMP4 segments already
 * are (their init section comes first), MPEG-TS ones are converted by
 * mux.js, without re-encoding.
 *
 * Protected (DRM) and live streams are refused, never worked around.
 */

// mux.js has no types; only its MP4 transmuxer is used.
// @ts-expect-error untyped package
import muxjs from 'mux.js';
import type { Text } from './i18n';
import { type Key, type Playlist, parsePlaylist, type Segment, sequenceIv } from './media';
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

type Media = Extract<Playlist, { type: 'media' }>;

/** What makes a resume safe: the same segments, in the same format. */
function fingerprint(p: Media): string {
  const s = p.segments;
  return `hls:${p.map ? 'fmp4' : 'ts'}:${s.length}:${s[0]!.url}:${s.at(-1)!.url}`;
}

interface State {
  next: number;
  bytes: number;
  /** Bytes of the fMP4 init section at the start of the file, 0 for TS. */
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

    const { playlist, url } = await mediaPlaylist(cmd.url);
    const name = sanitize(cmd.name || `${fromUrl(url)?.replace(/\.m3u8$/i, '') || 'video'}.mp4`);
    scope.postMessage({ type: 'started', name, total: null, url });
    await originsReady(playlist, url);

    // fMP4 goes straight into the final file; TS into a raw file, converted at the end.
    const fmp4 = !!playlist.map;
    const out = await open(cmd.file);
    const raw = fmp4 ? out : await open(`${cmd.file}.ts`);
    const validator = fingerprint(playlist);
    const count = playlist.segments.length;

    // Resumed only if the checkpoint is for this very playlist and agrees
    // with itself and with what is on disk; otherwise from the start.
    let state: State = { next: 0, bytes: 0, init: 0, sizes: [] };
    const saved = cmd.resume?.validator === validator ? cmd.resume.hls : undefined;
    if (
      saved &&
      saved.next <= count &&
      saved.sizes.length === saved.next &&
      saved.sizes.reduce((n, s) => n + s, 0) + (saved.init ?? 0) === saved.bytes &&
      raw.getSize() >= saved.bytes
    ) {
      state = { next: saved.next, bytes: saved.bytes, init: saved.init ?? 0, sizes: saved.sizes.slice() };
    }
    raw.truncate(state.bytes);
    saveNow = () => {
      raw.flush();
      checkpoint(validator, state);
    };

    if (fmp4 && state.next === 0) {
      const init = await fetchBytes(playlist.map!.url, playlist.map!.range);
      write(raw, init, 0);
      state.bytes = state.init = init.byteLength;
    }

    let converting = false;
    let converted = 0;
    ticker = setInterval(() => {
      if (converting) return scope.postMessage({ type: 'progress', done: converted, total: state.bytes });
      // Total unknown until the end: estimated from the segments so far.
      const total = state.next > 0 ? Math.round(((state.bytes - state.init) / state.next) * count + state.init) : null;
      scope.postMessage({ type: 'progress', done: state.bytes, total: total && Math.max(total, state.bytes) });
    }, PROGRESS_MS);

    const keys = new Map<string, Promise<CryptoKey>>();
    const pending = new Map<number, Promise<Uint8Array>>();
    const fetchSegment = (i: number) => {
      const s = playlist.segments[i]!;
      const p = fetchBytes(s.url, s.range).then((data) => decrypt(data, s, keys));
      // A failure is handled when its turn comes; until then it must not
      // count as unhandled.
      p.catch(() => {});
      pending.set(i, p);
    };
    for (let i = state.next; i < Math.min(count, state.next + PARALLEL); i++) fetchSegment(i);
    let checkpointed = Date.now();
    while (state.next < count) {
      const data = await pending.get(state.next)!;
      pending.delete(state.next);
      if (state.next + PARALLEL < count) fetchSegment(state.next + PARALLEL);
      write(raw, data, state.bytes);
      state.bytes += data.byteLength;
      state.sizes.push(data.byteLength);
      state.next++;
      if (Date.now() - checkpointed >= CHECKPOINT_MS) {
        raw.flush();
        checkpoint(validator, state);
        checkpointed = Date.now();
      }
    }
    raw.flush();
    checkpoint(validator, state);

    converting = true;
    const size = fmp4 ? state.bytes : await convert(raw, out, state.sizes, (n) => (converted = n));
    out.flush();
    result = { type: 'done', name, size };
  } catch (e) {
    const fail = abort.signal.aborted ? (abort.signal.reason as Fail) : e instanceof Fail ? e : new Fail({ key: 'reason.network' }, true);
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

function checkpoint(validator: string, s: State) {
  // `missing` belongs to ranged files; a stream resumes by segment.
  const hls = { next: s.next, bytes: s.bytes, init: s.init, sizes: s.sizes.slice() };
  scope.postMessage({ type: 'checkpoint', checkpoint: { total: 0, validator, missing: [], hls } });
}

/** The hosts the stream's pieces come from get the page's Referer, as the
 * page's player sends it: the background adds them, then says go. */
function originsReady(p: Media, url: string): Promise<void> {
  const byHost = new Map<string, string>();
  for (const u of [url, p.map?.url, ...p.segments.map((s) => s.url), ...p.segments.map((s) => s.key.uri)]) {
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

/** The playlist with the segments: for a master playlist, its best quality. */
async function mediaPlaylist(url: string): Promise<{ playlist: Media; url: string }> {
  for (let depth = 0; depth < 2; depth++) {
    const res = await request(url);
    const text = await res.text();
    let p: Playlist;
    try {
      p = parsePlaylist(text, res.url || url);
    } catch {
      throw new Fail({ key: 'reason.notVideo' });
    }
    if (p.drm) throw new Fail({ key: 'reason.protected' });
    if (p.type === 'media') {
      if (!p.ended) throw new Fail({ key: 'reason.live' });
      if (!p.segments.length) throw new Fail({ key: 'reason.notVideo' });
      return { playlist: p, url: res.url || url };
    }
    const best = p.variants[0];
    if (!best) throw new Fail({ key: 'reason.notVideo' });
    url = best.url;
  }
  throw new Fail({ key: 'reason.notVideo' });
}

async function request(url: string, range?: { offset: number; length: number }): Promise<Response> {
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

async function fetchBytes(url: string, range?: { offset: number; length: number }): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await (await request(url, range)).arrayBuffer());
}

async function decrypt(data: Uint8Array<ArrayBuffer>, s: Segment, keys: Map<string, Promise<CryptoKey>>): Promise<Uint8Array> {
  if (s.key.method !== 'AES-128') return data;
  if (!s.key.uri) throw new Fail({ key: 'reason.protected' });
  const key = keyFor(s.key, keys);
  const iv = s.key.iv ?? sequenceIv(s.sequence);
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

/** MPEG-TS → MP4 without re-encoding, a segment at a time, yielding between
 * segments so that pause and progress still work; the TS is then deleted.
 * Returns the MP4's size. */
async function convert(raw: SyncAccessHandle, out: SyncAccessHandle, sizes: number[], progress: (bytes: number) => void): Promise<number> {
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
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
      const chunk = new Uint8Array(size);
      raw.read(chunk, { at: offset });
      offset += size;
      transmuxer.push(chunk);
      transmuxer.flush();
      progress(offset);
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    transmuxer.dispose?.();
  }
  // Nearly every segment must give video: otherwise the stream is not one
  // mux.js can convert (an unknown codec), and the file would be useless.
  if (!wroteInit || produced < Math.ceil(sizes.length / 2)) throw new Fail({ key: 'reason.notVideo' });
  raw.truncate(0);
  return at;
}
