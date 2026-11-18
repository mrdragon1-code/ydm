/**
 * Fetching a list of pieces a few at a time and writing them in order.
 *
 * A piece is started as soon as any other finishes, not only when the
 * first in line does: one slow piece no longer stalls the rest. Pieces that
 * finish early wait in memory for their turn, up to a limit; past it, only
 * the piece everything waits for is started. When that piece takes far
 * longer than the others did, a second request for it is sent and the first
 * answer wins (a fresh request often takes a better path).
 *
 * Pure scheduling: fetching and writing are passed in, so it is tested
 * with fake ones.
 */

/** Pieces finished early are held up to this many bytes. */
export const MAX_AHEAD = 32 * 1024 * 1024;
/** A piece counts as late after this many times the usual piece time… */
const LATE_FACTOR = 2;
/** …and never before this long. */
const LATE_MIN_MS = 1000;
/** Piece times needed before anything counts as late. */
const LATE_SAMPLES = 3;
const CHECK_MS = 250;

export interface InOrder<T> {
  /** First and one past the last piece to fetch. */
  from: number;
  to: number;
  /** Requests at once; asked again each time, so it can change. */
  width: () => number;
  fetch: (index: number, signal: AbortSignal) => Promise<T>;
  size: (data: T) => number;
  /** Called once per piece, in order. May throw to stop everything. */
  write: (index: number, data: T) => void;
  /** Stops everything with its reason. */
  signal?: AbortSignal;
  /** Whether a late piece may be asked for again (not while a speed
   * limit is what makes pieces slow). */
  hedge?: () => boolean;
  maxAhead?: number;
  now?: () => number;
}

interface Flight {
  startedAt: number;
  requests: AbortController[];
  hedged: boolean;
}

export function inOrder<T>(o: InOrder<T>): Promise<void> {
  const now = o.now ?? (() => performance.now());
  const maxAhead = o.maxAhead ?? MAX_AHEAD;
  let head = o.from;
  let next = o.from;
  let ahead = 0;
  const ready = new Map<number, T>();
  const flying = new Map<number, Flight>();
  const times: number[] = [];

  return new Promise<void>((resolve, reject) => {
    let over = false;
    const finish = (error?: unknown) => {
      if (over) return;
      over = true;
      clearInterval(timer);
      o.signal?.removeEventListener('abort', onAbort);
      for (const f of flying.values()) for (const r of f.requests) r.abort();
      flying.clear();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(o.signal!.reason);

    const launch = (i: number) => {
      const request = new AbortController();
      let flight = flying.get(i);
      if (!flight) {
        flight = { startedAt: now(), requests: [], hedged: false };
        flying.set(i, flight);
      }
      flight.requests.push(request);
      const sent = now();
      o.fetch(i, request.signal).then(
        (data) => {
          const f = flying.get(i);
          if (over || !f) return; // another request for it won
          flying.delete(i);
          for (const r of f.requests) if (r !== request) r.abort();
          times.push(now() - sent);
          if (times.length > 20) times.shift();
          ready.set(i, data);
          ahead += o.size(data);
          pump();
        },
        (error: unknown) => {
          const f = flying.get(i);
          if (over || !f) return;
          f.requests = f.requests.filter((r) => r !== request);
          // The other request for this piece may still answer.
          if (f.requests.length === 0) finish(error);
        },
      );
    };

    const pump = () => {
      if (over) return;
      while (ready.has(head)) {
        const data = ready.get(head)!;
        ready.delete(head);
        ahead -= o.size(data);
        try {
          o.write(head, data);
        } catch (e) {
          return finish(e);
        }
        head++;
      }
      if (head >= o.to) return finish();
      // Past the memory limit only the piece everything waits for starts.
      while (next < o.to && flying.size < Math.max(1, o.width()) && (ahead < maxAhead || next === head)) {
        launch(next++);
      }
    };

    const timer = setInterval(() => {
      const f = flying.get(head);
      if (!f || f.hedged || times.length < LATE_SAMPLES || o.hedge?.() === false) return;
      const usual = median(times);
      if (now() - f.startedAt < Math.max(LATE_MIN_MS, usual * LATE_FACTOR)) return;
      f.hedged = true;
      launch(head);
    }, CHECK_MS);

    if (o.signal?.aborted) return finish(o.signal.reason);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    pump();
  });
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
