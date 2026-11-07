/**
 * One download, in its own worker: probe, split into ranges fetched in
 * parallel, write each chunk straight to its place in an OPFS file.
 * Memory stays at one network chunk per connection whatever the file size.
 */

import { isRetryableStatus, parseContentRange, validator } from './http';
import { fromContentDisposition, fromUrl, sanitize } from './naming';
import type { Checkpoint, WorkerCommand, WorkerEvent } from './protocol';
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

class Fail extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The browser's own downloader might succeed (it can send a Referer, …). */
    readonly retryInBrowser = true,
  ) {
    super(message);
  }
}

const CANCELLED = new Fail('cancelled', false, false);
const abort = new AbortController();
let received = 0;
/** The ranges of a segmented download, shown in the popup. */
let current: Segments | null = null;
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
        : { type: 'failed', reason: fail.message, retryInBrowser: fail.retryInBrowser };
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

async function segmented(
  handle: SyncAccessHandle,
  probe: Probe,
  total: number,
  connections: number,
  missing: [number, number][] | null,
): Promise<number> {
  let segs: Segments;
  let n: number;
  if (missing) {
    segs = Segments.resume(missing, connections);
    n = connections;
  } else {
    try {
      handle.truncate(total);
    } catch {
      throw new Fail('spazio su disco insufficiente', false);
    }
    n = total < SEGMENT_THRESHOLD ? 1 : Math.min(connections, Math.floor(total / MIN_SPLIT));
    segs = new Segments(total, n);
  }
  current = segs;
  const { validator } = probe;
  const checkpoint = () => {
    if (validator === null) return; // no safe way to resume
    const missing = segs.missing();
    handle.flush();
    scope.postMessage({ type: 'checkpoint', checkpoint: { total, validator, missing } });
  };
  // Right away too: an older checkpoint must not outlive a fresh start.
  checkpoint();
  const saver = setInterval(checkpoint, CHECKPOINT_MS);
  try {
    // A resumed download may have fewer ranges than connections: the spare
    // ones split the largest, as at the end of any download.
    const firsts = Array.from({ length: n }, (_, i) =>
      i < segs.list.length && !segs.get(i).orphan ? i : segs.nextWork(),
    );
    const workers = firsts.map((first) =>
      connection(handle, segs, probe, first).catch((e) => {
        // One fatal error stops every connection.
        if (!abort.signal.aborted) abort.abort(asFail(e));
        throw e;
      }),
    );
    await Promise.all(workers);
  } finally {
    clearInterval(saver);
    // Paused: record exactly what is on disk, so a resume redoes nothing.
    if (abort.signal.reason === CANCELLED) checkpoint();
  }
  if (!segs.complete()) throw new Fail('download incompleto', false);
  return total;
}

async function connection(handle: SyncAccessHandle, segs: Segments, probe: Probe, first: number | null) {
  let id: number | null = first;
  while (id !== null) {
    if (!(await fetchSegment(handle, segs, probe, id))) return; // retired
    id = segs.nextWork();
  }
}

/** Fetches one segment to its end, retrying. `false` means this connection
 * retired and left the segment to the others. */
async function fetchSegment(
  handle: SyncAccessHandle,
  segs: Segments,
  probe: Probe,
  id: number,
): Promise<boolean> {
  let attempt = 0;
  for (;;) {
    const seg = segs.get(id);
    if (seg.pos >= seg.end) return true;
    const before = seg.pos;
    let fail: Fail | null = null;
    try {
      await fetchRange(handle, segs, probe, id);
    } catch (e) {
      if (abort.signal.aborted) throw abort.signal.reason;
      fail = asFail(e);
    }
    const progressed = seg.pos > before;
    if (progressed) attempt = 0;
    if (!fail) {
      if (progressed) continue;
      // A 206 with an empty body would otherwise loop forever.
      fail = new Fail('connessione bloccata', true);
    }
    if (!fail.retryable || attempt >= MAX_RETRIES) throw fail;
    if (attempt + 1 >= RETIRE_AFTER && segs.retire(id)) return false;
    attempt++;
    await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
  }
}

async function fetchRange(handle: SyncAccessHandle, segs: Segments, probe: Probe, id: number) {
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
    res = await request(probe.url, headers);
  }
  if (res.status !== 206) {
    void res.body?.cancel();
    // 200: If-Range failed, the server is now sending a different file.
    if (res.status === 200) throw new Fail('il file è cambiato sul server durante il download', false);
    throw statusFail(res.status);
  }
  const range = parseContentRange(res.headers.get('content-range'));
  if (range?.first !== seg.pos) {
    void res.body?.cancel();
    throw new Fail('il server ha mandato una parte sbagliata del file', true);
  }
  if (range.total !== null && range.total !== probe.total) {
    void res.body?.cancel();
    throw new Fail('il file è cambiato sul server durante il download', false);
  }
  const encoding = res.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') {
    // Decompressed bytes would not line up with the byte offsets.
    void res.body?.cancel();
    throw new Fail('il server comprime i pezzi del file', false);
  }
  await pump(res, handle, segs, id);
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
        throw new Fail('connessione chiusa prima della fine', true);
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

/** Copies a body into the segment until the body or the segment ends
 * (another connection may have taken over the tail). */
async function pump(res: Response, handle: SyncAccessHandle, segs: Segments, id: number) {
  if (!res.body) return;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), STALL_MS);
      if (done) return;
      const { offset, take } = segs.claim(id, value.byteLength);
      write(handle, value.subarray(0, take), offset);
      received += take;
      if (take < value.byteLength) return;
      await throttle(take);
    }
  } finally {
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
      throw new Fail(`impossibile scrivere su disco (${(e as Error).message})`, false);
    }
    if (n <= 0) throw new Fail('impossibile scrivere su disco', false);
    off += n;
  }
}

function request(url: string, headers: Record<string, string>): Promise<Response> {
  // The browser adds the site's cookies and its own user agent, exactly as
  // for its own downloads; host permissions lift the CORS restrictions.
  return fetch(url, {
    headers,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    signal: abort.signal,
  });
}

/** Checks the browser's storage quota up front, so a large game fails in a
 * second with a clear reason instead of after gigabytes. The browser's own
 * download then still has its chance. */
async function ensureSpace(bytes: number) {
  const { quota, usage = 0 } = await navigator.storage.estimate();
  if (quota !== undefined && quota - usage < bytes) {
    throw new Fail(`spazio su disco insufficiente (servono ${(bytes / 2 ** 30).toFixed(1)} GB)`, false);
  }
}

function statusFail(status: number): Fail {
  return new Fail(`${describeStatus(status)} (${status})`, isRetryableStatus(status));
}

/** What a status means for someone who is not a developer. */
function describeStatus(status: number): string {
  if (status === 401 || status === 403) return 'il sito non accetta download esterni';
  if (status === 404 || status === 410) return 'file non trovato o link scaduto';
  if (status === 429) return 'il sito limita le richieste';
  if (status >= 500) return 'errore del sito';
  return 'risposta inattesa del sito';
}

function asFail(e: unknown): Fail {
  if (e instanceof Fail) return e;
  // fetch rejects with a TypeError on network failures.
  if (e instanceof TypeError) return new Fail('connessione al sito non riuscita', true);
  return new Fail(e instanceof Error ? e.message : String(e), true);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Fail('connessione bloccata', true)), ms);
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
