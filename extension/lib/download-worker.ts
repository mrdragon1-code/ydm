/**
 * One download, in its own worker: probe, split into ranges fetched in
 * parallel, write each chunk straight to its place in an OPFS file.
 * Memory stays at one write buffer per connection whatever the file size.
 */

import { isRetryableStatus, parseContentRange, statusReason, validator } from './http';
import { fromContentDisposition, fromUrl, sanitize } from './naming';
import type { Params, Text } from './i18n';
import type { Checkpoint, WorkerCommand, WorkerEvent } from './protocol';
import { Adaptive } from './adaptive';
import { MIN_SPLIT, Segments } from './segments';

/** A read that delivers nothing for this long counts as a dead connection. */
const STALL_MS = 20_000;
const MAX_RETRIES = 5;
/** Consecutive failures after which a connection hands its range to the
 * others: the server is most likely refusing extra connections. */
const RETIRE_AFTER = 2;
/** Below this size one connection is as fast as several. */
const SEGMENT_THRESHOLD = 4 * MIN_SPLIT;
const PROGRESS_MS = 500;
/** At most this much transfer is redone after the browser is closed. */
const CHECKPOINT_MS = 3000;
/** Network chunks are gathered into writes of this size. */
const WRITE_BUFFER = 1 << 20;

// Worker globals, typed locally: the project compiles against the DOM lib.
interface SyncAccessHandle {
  write(data: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
};
const scope = self as unknown as {
  postMessage(msg: WorkerEvent): void;
  onmessage: ((e: MessageEvent<WorkerCommand>) => void) | null;
};

/** `key` is a `reason.*` message, translated where it is shown. */
class Fail extends Error {
  constructor(
    readonly key: string,
    readonly retryable: boolean,
    /** The browser's own downloader might succeed (it can send a Referer, …). */
    readonly retryInBrowser = true,
    readonly params?: Params,
  ) {
    super(key);
  }

  get text(): Text {
    return this.params ? { key: `reason.${this.key}`, params: this.params } : { key: `reason.${this.key}` };
  }
}

const CANCELLED = new Fail('cancelled', false, false);
const abort = new AbortController();
let received = 0;
/** The ranges of a segmented download, shown in the popup. */
let current: Segments | null = null;
/** How many connections the segmented download uses. */
let adaptive: Adaptive | null = null;
/** A connection budget that arrived before the download began. */
let pendingMax: number | null = null;
/** The first response, kept open: its body is the start of the file. */
let opening: Response | null = null;
/** Speed limit in bytes per second for this download, 0 for none. */
let rate = 0;
let allowance = 0;
let refilled = 0;

scope.onmessage = (e) => {
  const cmd = e.data;
  if (cmd.type === 'start') void run(cmd);
  else if (cmd.type === 'limit') setRate(cmd.bytesPerSecond);
  else if (cmd.type === 'connections') {
    if (adaptive) adaptive.setMax(cmd.max);
    else pendingMax = cmd.max;
  }
  else abort.abort(CANCELLED);
};

interface Probe {
  url: string;
  total: number | null;
  ranges: boolean;
  validator: string | null;
  name: string | null;
}

async function run(cmd: Extract<WorkerCommand, { type: 'start' }>) {
  let result: WorkerEvent;
  let handle: SyncAccessHandle | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('ydm', { create: true });
    const file = (await dir.getFileHandle(cmd.file, { create: true })) as SyncFileHandle;
    handle = await file.createSyncAccessHandle();
    setRate(cmd.limit ?? 0);

    const probe = await openUrl(cmd.url);
    const name = sanitize(cmd.name || probe.name || fromUrl(probe.url) || '');
    scope.postMessage({ type: 'started', name, total: probe.total, url: probe.url });
    const missing = resumable(cmd.resume, probe, handle);
    // Resuming starts elsewhere in the file: the opening stream is not needed.
    if (missing) dropOpening();
    const left = missing ? missing.reduce((n, [from, to]) => n + to - from, 0) : probe.total;
    if (left !== null) await ensureSpace(left);
    received = missing && probe.total !== null ? probe.total - (left ?? 0) : 0;
    ticker = setInterval(
      () => scope.postMessage({ type: 'progress', done: received, total: probe.total, parts: current?.parts() }),
      PROGRESS_MS,
    );

    const size =
      probe.ranges && probe.total !== null
        ? await segmented(handle, probe, probe.total, cmd.connections, missing)
        : await single(handle, probe);
    handle.flush();
    result = { type: 'done', name, size };
  } catch (e) {
    const fail = abort.signal.aborted ? (abort.signal.reason as Fail) : asFail(e);
    result =
      fail === CANCELLED
        ? { type: 'cancelled' }
        : { type: 'failed', reason: fail.text, retryInBrowser: fail.retryInBrowser };
  } finally {
    clearInterval(ticker);
    dropOpening();
    handle?.close();
  }
  // Only now: the engine page reads the file, which needs the handle closed.
  scope.postMessage(result);
}

/** The first request asks for the whole file from byte 0 onwards: its
 * headers tell the size and whether ranges work (a 206 proves it), and its
 * body is kept as the first connection's data. No separate probe, so one
 * request and one round trip less. Unlike HEAD, every server answers GET. */
async function openUrl(url: string): Promise<Probe> {
  const res = await request(url, { Range: 'bytes=0-' });
  const range = parseContentRange(res.headers.get('content-range'));
  let total: number | null;
  let ranges: boolean;
  if (res.status === 206 && range?.total != null && range.first === 0) {
    total = range.total;
    ranges = true;
    opening = res;
  } else if (res.status === 200) {
    // Ranges ignored: this is the whole file, streamed by `single`.
    const length = res.headers.get('content-length');
    total = length === null ? null : Number(length);
    ranges = false;
    opening = res;
  } else {
    void res.body?.cancel();
    if (res.status !== 206) throw statusFail(res.status);
    // A 206 without a usable size: fetch it again as a whole.
    total = null;
    ranges = false;
  }
  return {
    url: res.url || url,
    total,
    ranges,
    validator: validator(res.headers),
    name: fromContentDisposition(res.headers.get('content-disposition')),
  };
}

/** The ranges still to fetch from an earlier run, or `null` to start over:
 * only when the server still has the very same file, and the partial file
 * is still there. */
function resumable(saved: Checkpoint | undefined, probe: Probe, handle: SyncAccessHandle) {
  if (!saved || !probe.ranges || probe.total !== saved.total) return null;
  if (probe.validator === null || probe.validator !== saved.validator) return null;
  if (handle.getSize() !== saved.total) return null;
  return saved.missing;
}

/** What a connection is doing, so the steering timer can stop a straggler. */
interface Conn {
  id: number | null;
  /** Aborts only this connection's current request. */
  stop: AbortController;
  /** Last time this connection was asked to start over. */
  restartedAt: number;
}

/** A connection's request was dropped on purpose (too slow): not a failure. */
const RESTART = new Error('restart');

async function segmented(
  handle: SyncAccessHandle,
  probe: Probe,
  total: number,
  connections: number,
  missing: [number, number][] | null,
): Promise<number> {
  const most = total < SEGMENT_THRESHOLD ? 1 : Math.max(1, Math.min(connections, Math.floor(total / MIN_SPLIT)));
  adaptive = new Adaptive(pendingMax === null ? most : Math.min(most, pendingMax));
  const n = adaptive.initial();
  let segs: Segments;
  if (missing) {
    segs = Segments.resume(missing, n);
  } else {
    try {
      handle.truncate(total);
    } catch {
      throw new Fail('noSpace', false);
    }
    segs = new Segments(total, n);
  }
  current = segs;
  const { validator } = probe;
  const checkpoint = () => {
    if (validator === null) return; // no safe way to resume
    // Buffered bytes are already claimed; put them on disk first.
    flushAll(handle);
    const missing = segs.missing();
    handle.flush();
    scope.postMessage({ type: 'checkpoint', checkpoint: { total, validator, missing } });
  };
  // Right away too: an older checkpoint must not outlive a fresh start.
  checkpoint();
  const saver = setInterval(checkpoint, CHECKPOINT_MS);
  const conns = new Set<Conn>();
  const pool: Promise<void>[] = [];
  const launch = (first: number | null) => {
    if (first === null) return;
    const conn: Conn = { id: first, stop: new AbortController(), restartedAt: 0 };
    conns.add(conn);
    pool.push(
      connection(handle, segs, probe, conn)
        .catch((e) => {
          // One fatal error stops every connection.
          if (!abort.signal.aborted) abort.abort(asFail(e));
          throw e;
        })
        .finally(() => conns.delete(conn)),
    );
  };
  // More connections while they pay off; a straggler starts over.
  const steer = setInterval(() => {
    if (adaptive!.tick(segs.running, received) === 'add') launch(segs.addWork());
    const slow = segs.straggler();
    if (slow === null) return;
    const now = performance.now();
    for (const conn of conns) {
      if (conn.id !== slow || now - conn.restartedAt < 10_000) continue;
      conn.restartedAt = now;
      conn.stop.abort(RESTART);
    }
  }, 250);
  try {
    // A resumed download may have fewer ranges than connections: the spare
    // ones split the largest, as at the end of any download.
    for (let i = 0; i < n; i++) launch(i < segs.list.length && !segs.get(i).orphan ? i : segs.nextWork());
    // Connections launched later join the pool while we wait.
    for (let i = 0; i < pool.length; i++) await pool[i];
  } finally {
    clearInterval(steer);
    clearInterval(saver);
    // Paused: record exactly what is on disk, so a resume redoes nothing.
    if (abort.signal.reason === CANCELLED) checkpoint();
  }
  if (!segs.complete()) throw new Fail('incomplete', false);
  return total;
}

async function connection(handle: SyncAccessHandle, segs: Segments, probe: Probe, conn: Conn) {
  while (conn.id !== null) {
    if (!(await fetchSegment(handle, segs, probe, conn))) return; // retired
    // Over the budget (another download from this host started): leave.
    if (segs.running > adaptive!.max && segs.leave()) return;
    conn.id = segs.nextWork();
  }
}

/** Fetches one segment to its end, retrying. `false` means this connection
 * retired and left the segment to the others. */
async function fetchSegment(handle: SyncAccessHandle, segs: Segments, probe: Probe, conn: Conn): Promise<boolean> {
  const id = conn.id!;
  let attempt = 0;
  for (;;) {
    const seg = segs.get(id);
    if (seg.pos >= seg.end) return true;
    const before = seg.pos;
    let fail: Fail | null = null;
    try {
      await fetchRange(handle, segs, probe, id, conn.stop.signal);
    } catch (e) {
      if (abort.signal.aborted) throw abort.signal.reason;
      if (conn.stop.signal.aborted) {
        // Dropped for being slow: a fresh request, often on a better path.
        conn.stop = new AbortController();
        continue;
      }
      fail = asFail(e);
    }
    const progressed = seg.pos > before;
    if (progressed) attempt = 0;
    if (!fail) {
      if (progressed) continue;
      // A 206 with an empty body would otherwise loop forever.
      fail = new Fail('stalled', true);
    }
    if (!fail.retryable || attempt >= MAX_RETRIES) throw fail;
    if (attempt + 1 >= RETIRE_AFTER) {
      const running = segs.running;
      if (segs.retire(id)) {
        // The server is refusing extra connections: never go above this.
        adaptive!.refused(running);
        scope.postMessage({ type: 'capped', connections: adaptive!.max });
        return false;
      }
    }
    attempt++;
    await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
  }
}

async function fetchRange(handle: SyncAccessHandle, segs: Segments, probe: Probe, id: number, stop: AbortSignal) {
  const seg = segs.get(id);
  let res: Response;
  if (opening && seg.pos === 0) {
    // The opening response already streams from byte 0; `pump` stops it
    // where this segment ends.
    res = opening;
    opening = null;
  } else {
    const headers: Record<string, string> = { Range: `bytes=${seg.pos}-${seg.end - 1}` };
    if (probe.validator) headers['If-Range'] = probe.validator;
    res = await request(probe.url, headers, stop);
  }
  if (res.status !== 206) {
    void res.body?.cancel();
    // 200: If-Range failed, the server is now sending a different file.
    if (res.status === 200) throw new Fail('changed', false);
    throw statusFail(res.status);
  }
  const range = parseContentRange(res.headers.get('content-range'));
  if (range?.first !== seg.pos) {
    void res.body?.cancel();
    throw new Fail('wrongPart', true);
  }
  if (range.total !== null && range.total !== probe.total) {
    void res.body?.cancel();
    throw new Fail('changed', false);
  }
  const encoding = res.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') {
    // Decompressed bytes would not line up with the byte offsets.
    void res.body?.cancel();
    throw new Fail('compressed', false);
  }
  await pump(res, handle, segs, id, stop);
}

/** For servers without ranges: one stream, restarted on failure. */
async function single(handle: SyncAccessHandle, probe: Probe): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    handle.truncate(0);
    received = 0;
    const segs = new Segments(probe.total ?? Number.MAX_SAFE_INTEGER, 1);
    try {
      const res = opening ?? (await request(probe.url, {}));
      opening = null;
      if (!res.ok) {
        void res.body?.cancel();
        throw statusFail(res.status);
      }
      await pump(res, handle, segs, 0);
      const written = segs.written();
      const decoded = (res.headers.get('content-encoding') ?? 'identity') !== 'identity';
      if (probe.total !== null && written !== probe.total && !decoded) {
        throw new Fail('closedEarly', true);
      }
      handle.truncate(written);
      return written;
    } catch (e) {
      if (abort.signal.aborted) throw abort.signal.reason;
      const fail = asFail(e);
      if (!fail.retryable || attempt >= MAX_RETRIES) throw fail;
      await sleep(Math.min(500 * 2 ** attempt, 8000));
    }
  }
}

/**
 * Bytes a connection has received but not yet written. Network chunks are
 * small (16–64 KB); gathering them into one write per megabyte makes far
 * fewer calls into the file system at high speeds. Memory stays bounded:
 * one buffer per connection.
 */
class WriteBuffer {
  private readonly data = new Uint8Array(WRITE_BUFFER);
  private fill = 0;
  /** File offset of `data[0]`. */
  private at = 0;

  add(handle: SyncAccessHandle, chunk: Uint8Array, offset: number) {
    if (this.fill && offset !== this.at + this.fill) this.flush(handle);
    if (this.fill + chunk.byteLength > WRITE_BUFFER) this.flush(handle);
    if (chunk.byteLength >= WRITE_BUFFER) return write(handle, chunk, offset);
    if (!this.fill) this.at = offset;
    this.data.set(chunk, this.fill);
    this.fill += chunk.byteLength;
    if (this.fill === WRITE_BUFFER) this.flush(handle);
  }

  flush(handle: SyncAccessHandle) {
    if (!this.fill) return;
    write(handle, this.data.subarray(0, this.fill), this.at);
    this.fill = 0;
  }
}

const buffers = new Set<WriteBuffer>();

function flushAll(handle: SyncAccessHandle) {
  for (const b of buffers) b.flush(handle);
}

/** Copies a body into the segment until the body or the segment ends
 * (another connection may have taken over the tail). */
async function pump(res: Response, handle: SyncAccessHandle, segs: Segments, id: number, stop?: AbortSignal) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const buffer = new WriteBuffer();
  buffers.add(buffer);
  // The opening response was not fetched with this connection's signal.
  const onStop = () => void reader.cancel().catch(() => {});
  stop?.addEventListener('abort', onStop, { once: true });
  try {
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), STALL_MS);
      if (stop?.aborted) throw stop.reason;
      if (done) return;
      const { offset, take } = segs.claim(id, value.byteLength);
      buffer.add(handle, take < value.byteLength ? value.subarray(0, take) : value, offset);
      received += take;
      if (take < value.byteLength) return;
      await throttle(take);
    }
  } finally {
    stop?.removeEventListener('abort', onStop);
    buffers.delete(buffer);
    buffer.flush(handle);
    reader.cancel().catch(() => {});
  }
}

function write(handle: SyncAccessHandle, data: Uint8Array, at: number) {
  let off = 0;
  while (off < data.byteLength) {
    let n: number;
    try {
      n = handle.write(data.subarray(off), { at: at + off });
    } catch (e) {
      throw new Fail('diskWrite', false, true, { detail: (e as Error).message });
    }
    if (n <= 0) throw new Fail('diskWrite', false, true, { detail: 'write returned 0' });
    off += n;
  }
}

function request(url: string, headers: Record<string, string>, stop?: AbortSignal): Promise<Response> {
  // The browser adds the site's cookies and its own user agent, exactly as
  // for its own downloads; host permissions lift the CORS restrictions.
  return fetch(url, {
    headers,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    signal: stop ? AbortSignal.any([abort.signal, stop]) : abort.signal,
  });
}

/** Checks the browser's storage quota up front, so a large game fails in a
 * second with a clear reason instead of after gigabytes. The browser's own
 * download then still has its chance. */
async function ensureSpace(bytes: number) {
  const { quota, usage = 0 } = await navigator.storage.estimate();
  if (quota !== undefined && quota - usage < bytes) {
    throw new Fail('noSpaceNeed', false, true, { gb: (bytes / 2 ** 30).toFixed(1) });
  }
}

function statusFail(status: number): Fail {
  return new Fail(statusReason(status), isRetryableStatus(status), true, { status });
}

function asFail(e: unknown): Fail {
  if (e instanceof Fail) return e;
  // fetch rejects with a TypeError on network failures.
  if (e instanceof TypeError) return new Fail('network', true);
  return new Fail('engine', true, true, { detail: e instanceof Error ? e.message : String(e) });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Fail('stalled', true)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function dropOpening() {
  opening?.body?.cancel().catch(() => {});
  opening = null;
}

function setRate(bytesPerSecond: number) {
  rate = Math.max(0, bytesPerSecond);
  allowance = 0;
  refilled = performance.now();
}

/** With a speed limit, waits after each chunk until it fits the budget.
 * Shared by this download's connections; while they wait they do not
 * read, and TCP slows the server down. */
async function throttle(bytes: number) {
  if (!rate) return;
  const now = performance.now();
  allowance = Math.min(rate / 4, allowance + ((now - refilled) * rate) / 1000);
  refilled = now;
  allowance -= bytes;
  if (allowance < 0) await sleep((-allowance / rate) * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abort.signal.reason);
    };
    const timer = setTimeout(() => {
      abort.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abort.signal.addEventListener('abort', onAbort, { once: true });
  });
}
